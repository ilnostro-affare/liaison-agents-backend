/**
 * Building owners' pool contributions on the server (extracted from
 * backend/workers/meta.js).
 *
 * globalBuildMember is a PRODUCER: it does the cheap part (consent, token, the list
 * of ad accounts) and fans out one queue message per ad account, so each account is
 * built in its own consumer invocation with its own time and subrequest budget - a
 * heavy account cannot starve the others. Without the queue binding it falls back
 * to an inline sequential build.
 *
 * Triggers: consent Apply (waitUntil), a debounced "refresh" from the map, and the
 * hourly cron, which runs the full refresh only at 03:00 UTC, bounded to CAP=200
 * members per run.
 *
 * Persistence rules: consent off -> de-list; Meta unreachable (no token / no
 * accounts / errors) -> KEEP the existing snapshot if there is one (the owner stays
 * on the map), else de-list.
 *
 * coreTree / coreTargeting / coreCreatives / coreAccounts are the Graph read layer
 * of the original worker and are not part of this extract (see meta-reads.js).
 */
import { coreTree, coreTargeting, coreCreatives, coreAccounts } from "./meta-reads.js";
import { coreSnapshot, globalPoolAggMerge, globalAggregateMember } from "./snapshot.js";

// Assemble shareable rows from the ads tree + targeting geo — server-side mirror
// of the client's buildAccountRows(). Only adsets with a real custom_location
// pin produce rows (others have nowhere to plot). Full tier-3 ratio metrics are
// computed here; the snapshot endpoint cuts them to the member's consent tier.
export function globalAssembleRows(tree, tg) {
  const geoByAdset = {};
  ((tg && tg.adsets) || []).forEach(a => {
    const t = a.targeting || {};
    const pin = ((t.geo && t.geo.custom_locations) || []).find(l => l.latitude != null && l.longitude != null);
    if (!pin) return;
    geoByAdset[a.adset_id] = { lat: +pin.latitude, lng: +pin.longitude, radius: pin.radius };
  });
  const out = [];
  // GPOOL-DIAG: counters so globalBuildMember can log WHY an account yields
  // rows or not (the #1 silent drop is adsets that target by city/region name
  // instead of a custom_locations lat/lng pin → no geo → every ad skipped).
  let adsetsTotal = 0, adsetsWithGeo = 0, adsSkippedNoGeo = 0;
  const tr = (tree && tree.tree) || {};
  Object.values(tr).forEach(c => Object.values(c.adsets || {}).forEach(as => {
    adsetsTotal++;
    const geo = geoByAdset[as.id];
    if (!geo) { adsSkippedNoGeo += ((as.ads || []).length); return; }
    adsetsWithGeo++;
    (as.ads || []).forEach(a => {
      const spend = Number(a.spend || 0), leads = Number(a.leads || 0), impr = Number(a.impressions || 0);
      out.push({
        ad_id: a.ad_id,
        status: a.effective_status || a.status || null,
        lat: geo.lat, lng: geo.lng, radius: geo.radius,
        cpl: a.cpl != null ? Number(a.cpl) : (leads ? spend / leads : null),
        ctr: a.ctr != null ? Number(a.ctr) : null,
        cpm: impr ? (spend / impr * 1000) : null
      });
    });
  }));
  out.diag = { adsetsTotal, adsetsWithGeo, adsSkippedNoGeo, geoPinsInTargeting: Object.keys(geoByAdset).length, adsIncluded: out.length };
  return out;
}

// Build (or refresh) one member's snapshot from Meta and publish it. Returns a
// status object. Persistence rules:
//   • consent OFF                       → de-list (drop snapshot + agg).
//   • consent ON + Meta works           → rebuild from API, publish.
//   • consent ON + Meta error/unlinked  → KEEP whatever is already in R2 (the
//     member stays on the map for fill, even with no app visit / no Meta link).
//   • consent ON + Meta error + R2 empty→ de-list (nothing to show, not linked).
// Build ONE ad account into the member's global pool: tree + targeting -> rows
// -> creatives -> coreSnapshot (CAS-safe per-account merge). Used by the queue
// consumer (one account per invocation, full 15-min budget) and as the inline
// fallback when the queue binding is absent. Pure w.r.t. the pool: on an empty
// account it returns without touching the member's other accounts.
export async function buildOneAccountIntoPool(env, job) {
  const memberId = job && job.memberId;
  const accountId = job && job.accountId;
  const accountName = (job && job.accountName) || null;
  if (!memberId || !accountId) return { ok: false, error: "bad job" };
  const to = job.to || new Date().toISOString().slice(0, 10);
  const from = job.from || new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);

  const [tree, tg] = await Promise.all([
    coreTree(env, memberId, accountId, from, to),
    coreTargeting(env, memberId, accountId, { skipGeocode: true })
  ]);
  const rows = globalAssembleRows(tree, tg);
  const _d = rows.diag || {};
  try { console.log("GPOOL acct", JSON.stringify({ member: memberId, acct: accountId, name: accountName, campaigns: Object.keys((tree && tree.tree) || {}).length, adsetsTotal: _d.adsetsTotal, adsetsWithGeo: _d.adsetsWithGeo, geoPins: _d.geoPinsInTargeting, adsSkippedNoGeo: _d.adsSkippedNoGeo, rows: rows.length })); } catch (_) {}
  if (!rows.length) {
    try { console.log("GPOOL acct SKIP", JSON.stringify({ member: memberId, acct: accountId, reason: _d.adsetsWithGeo ? "no_ads_in_geo_adsets" : (_d.geoPinsInTargeting ? "geo_adsets_not_in_tree" : "no_custom_location_pins") })); } catch (_) {}
    // A successful build with 0 rows must still OVERWRITE the account block:
    // otherwise rows from an older build (older schema, e.g. no status field)
    // survive forever and the frontend filters them out as never-active.
    await coreSnapshot(env, memberId, { account: accountId, account_name: accountName, rows: [] }, null);
    return { ok: true, account: accountId, rows: 0, skipped: true };
  }
  const ids = [...new Set(rows.map(r => r.ad_id))].slice(0, 90);
  if (ids.length) {
    try {
      const cr = await coreCreatives(env, memberId, ids);
      const mm = (cr && cr.creatives) || {};
      rows.forEach(r => { const c = mm[r.ad_id]; if (c) { r.preview = c.preview_hi || c.preview || null; r.video_id = c.video_id || null; r.is_video = !!c.video_id; } });
    } catch (_) {}
  }
  try { console.log("GPOOL acct creatives", JSON.stringify({ member: memberId, acct: accountId, rows: rows.length, withPreview: rows.filter(r => r.preview).length, withVideo: rows.filter(r => r.video_id).length, noAsset: rows.filter(r => !r.preview && !r.video_id).length })); } catch (_) {}
  await coreSnapshot(env, memberId, { account: accountId, account_name: accountName, rows }, null);
  try { console.log("GPOOL acct published", JSON.stringify({ member: memberId, acct: accountId, rows: rows.length })); } catch (_) {}
  return { ok: true, account: accountId, rows: rows.length };
}

// Build (or refresh) a member's global snapshot. Now a PRODUCER: it does the
// fast/cheap part (consent + token + account list) and fans out one queue
// message per account so each account builds in its OWN consumer invocation
// with a full 15-min budget. A single heavy account can no longer exhaust the
// per-invocation subrequest/time budget and starve the rest (which truncated
// the old in-process build inside the post-response waitUntil window).
// Persistence rules unchanged: consent OFF -> de-list; no token / no accounts ->
// keep an existing snapshot for fill, else de-list. If the queue binding is
// absent it falls back to an inline sequential build.
export async function globalBuildMember(env, memberId) {
  if (!env.GLOBAL_POOL_R2 || !env.META_KV || !memberId) return { ok: false, error: "unavailable" };

  let consent = null;
  try { const raw = await env.META_KV.get(`global:consent:${memberId}`); if (raw) consent = JSON.parse(raw); } catch (_) {}
  const tier = consent ? Math.max(0, Math.min(3, consent.tier | 0)) : 0;

  let hadSnapshot = false;
  try { hadSnapshot = !!(await env.GLOBAL_POOL_R2.get(`members/${memberId}.json`)); } catch (_) {}

  if (tier <= 0) {
    try { await env.GLOBAL_POOL_R2.delete(`members/${memberId}.json`); } catch (_) {}
    await globalPoolAggMerge(env, memberId, null);
    return { ok: true, delisted: true, reason: "consent_off" };
  }

  // Meta linked? (token present)
  let token = null;
  try {
    const fb = await env.META_KV.get(`member:${memberId}:fb`);
    if (fb) { const raw = await env.META_KV.get(`fbtoken:${fb}`); if (raw) token = JSON.parse(raw).access_token; }
  } catch (_) {}

  if (!token) {
    try { console.log("GPOOL build done", JSON.stringify({ member: memberId, built: false, hasToken: false, hadSnapshot })); } catch (_) {}
    if (hadSnapshot) { await globalAggregateMember(env, memberId); return { ok: true, kept: true, reason: "no_token" }; }
    await globalPoolAggMerge(env, memberId, null);
    return { ok: true, delisted: true, reason: "no_token_empty" };
  }

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);

  let accounts = [];
  // The BM-grouped list (member:{m}:businesses, persisted by /meta/sync/accounts)
  // is the SAME set the frontend account switcher shows — including agency/client
  // accounts a marketer only reaches through a Business Manager. /me/adaccounts
  // silently omits those (measured: half the accounts on one member), so it is only a fallback.
  try {
    const bizRaw = await env.META_KV.get(`member:${memberId}:businesses`);
    if (bizRaw) {
      const biz = JSON.parse(bizRaw);
      const seenA = new Set();
      for (const b of (biz.businesses || [])) {
        for (const a of (b.ad_accounts || [])) {
          if (!a || !a.id || seenA.has(a.id)) continue;
          seenA.add(a.id);
          accounts.push({ id: a.id, indicator: a.indicator || `act_${a.id}`, name: a.name || null });
        }
      }
    }
  } catch (_) {}
  if (!accounts.length) {
    try { const a = await coreAccounts(env, memberId); accounts = (a && a.accounts) || []; } catch (e) { try { console.log("GPOOL accounts ERR", JSON.stringify({ member: memberId, err: String((e && e.message) || e).slice(0, 120) })); } catch (_) {} }
  }

  // Normalise to the bare numeric id (same key the pool stores under).
  const jobs = [];
  for (const acct of accounts) {
    const acctId = acct.id || String(acct.indicator || "").replace(/^act_/, "");
    if (!acctId) continue;
    jobs.push({ memberId, accountId: acctId, accountName: acct.name || null, from, to });
  }

  if (!jobs.length) {
    try { console.log("GPOOL build done", JSON.stringify({ member: memberId, built: false, hasToken: true, accountsN: 0, hadSnapshot })); } catch (_) {}
    if (hadSnapshot) { await globalAggregateMember(env, memberId); return { ok: true, kept: true, reason: "no_accounts" }; }
    await globalPoolAggMerge(env, memberId, null);
    return { ok: true, delisted: true, reason: "no_accounts_empty" };
  }

  // Fan out via the queue when bound.
  if (env.MAPS_QUEUE && typeof env.MAPS_QUEUE.send === "function") {
    try { console.log("GPOOL enqueue", JSON.stringify({ member: memberId, tier, accountsN: jobs.length, accounts: jobs.map(j => j.accountId) })); } catch (_) {}
    let enq = 0;
    for (const job of jobs) {
      // Light idempotency: collapse rapid re-enqueues of the same account within
      // a short window so repeated map-opens / triggers do not pile dup messages.
      try {
        const dk = `enq:${memberId}:${job.accountId}`;
        if (await env.META_KV.get(dk)) continue;
        await env.META_KV.put(dk, "1", { expirationTtl: 300 });
      } catch (_) {}
      try { await env.MAPS_QUEUE.send(job); enq++; }
      catch (e) { try { console.log("GPOOL enqueue ERR", JSON.stringify({ member: memberId, acct: job.accountId, err: String((e && e.message) || e).slice(0, 120) })); } catch (_) {} }
    }
    return { ok: true, enqueued: enq, accounts: jobs.length };
  }

  // Fallback: no queue binding -> inline sequential build (legacy path, subject
  // to the caller's time budget).
  try { console.log("GPOOL build start", JSON.stringify({ member: memberId, tier, hasToken: true, accountsN: jobs.length, inline: true })); } catch (_) {}
  let builtAny = false, accountsTried = 0;
  for (const job of jobs) {
    accountsTried++;
    try { const r = await buildOneAccountIntoPool(env, job); if (r && r.ok && !r.skipped) builtAny = true; } catch (_) {}
  }
  if (builtAny) { try { console.log("GPOOL build done", JSON.stringify({ member: memberId, built: true, accountsTried, inline: true })); } catch (_) {} return { ok: true, built: true, accounts: accountsTried }; }
  try { console.log("GPOOL build done", JSON.stringify({ member: memberId, built: false, accountsTried, inline: true, hadSnapshot })); } catch (_) {}
  if (hadSnapshot) { await globalAggregateMember(env, memberId); return { ok: true, kept: true, reason: "meta_error" }; }
  await globalPoolAggMerge(env, memberId, null);
  return { ok: true, delisted: true, reason: "meta_error_empty" };
}

// Daily backfill/refresh of every consented member. Until Meta webhooks are
// approved this is how new ads / new members reach the pool. Bounded per run.
export async function globalRefreshAll(env) {
  if (!env.GLOBAL_POOL_R2 || !env.META_KV) return 0;
  const PREFIX = "global:consent:";
  let cursor, processed = 0; const CAP = 200;
  while (true) {
    const list = await env.META_KV.list({ prefix: PREFIX, cursor });
    for (const k of list.keys) {
      const memberId = k.name.slice(PREFIX.length);
      if (memberId) { try { await globalBuildMember(env, memberId); } catch (_) {} processed++; }
      if (processed >= CAP) return processed;
    }
    if (list.list_complete) break;
    cursor = list.cursor;
  }
  return processed;
}

// The Worker's scheduled + queue handlers, as wired in the original (other cron jobs omitted).
export const poolHandlers = {
  async scheduled(event, env, ctx) {
    // once a day (the cron fires hourly) rebuild every consented member from Meta
    const hour = new Date(event.scheduledTime || Date.now()).getUTCHours();
    if (hour === 3) ctx.waitUntil(globalRefreshAll(env));
  },
  // Queue consumer: ONE ad account per invocation (max_batch_size = 1); failures
  // retry (max_retries) and then land in the dead-letter queue.
  async queue(batch, env, ctx) {
    for (const msg of batch.messages) {
      const body = (msg && msg.body) || {};
      try { await buildOneAccountIntoPool(env, body); msg.ack(); }
      catch (e) {
        try { console.log("QCONSUMER err", JSON.stringify({ acct: body.accountId || null, attempt: msg.attempts, err: String((e && e.message) || e).slice(0, 160) })); } catch (_) {}
        msg.retry();
      }
    }
  }
};
