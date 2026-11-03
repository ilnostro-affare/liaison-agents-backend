/**
 * Publishing an owner's rows into the cross-tenant pool (extracted from
 * backend/workers/meta.js).
 *
 * The server is the gatekeeper. Whatever rows a caller hands in, the owner's
 * AUTHORITATIVE consent decides what is stored (never the caller's claim):
 *
 *   tier 0  not participating: the owner's snapshot is deleted and they are de-listed
 *   tier 1  anonymous geo dot only (coordinates coarsened to ~1.1 km unless the owner
 *           chose "exact"; delivery status kept for the Live / Inactive filter)
 *   tier 2  + creative preview and format, as opaque tokens (tok / vtok)
 *   tier 3  + ratio metrics only: CPL, CTR, CPM. Never spend, never lead counts,
 *           never names or contacts.
 *
 * The raw ad_id is used server-side only, to mint the token and to key R2; it is
 * kept on the stored row as `_aid` for cross-owner de-duplication and is never
 * copied into what viewers receive (see serve.js).
 *
 * Storage: R2 `members/{m}.json` per owner (one block per ad account) and one
 * aggregate `agg/pins.json` that the read path serves in a single GET. Both are
 * merged with R2's etag conditional put (optimistic compare-and-set), because
 * per-account builds run in parallel queue consumers and would otherwise overwrite
 * each other.
 */
import { globalCoarsen, globalTokCompute, globalTokWrite } from "./tokens.js";
import { globalPersistPreview } from "./media.js";

// Concurrency-safe read-modify-write of a JSON object in R2 via etag optimistic
// locking. mutate(cur) MUST be a pure setter — idempotent across retries (assign,
// do not push) — and returns the next object, or null to delete the key. On a
// precondition conflict (a concurrent writer committed first) we re-read and
// retry; after maxAttempts we fall back to an unconditional write so a hot key
// still makes progress instead of spinning. Returns true on success.
// This makes the global-pool writes safe once per-account builds run in parallel
// (queue consumers), where the same members/{m}.json and the shared agg/pins.json
// would otherwise be clobbered by last-write-wins.
export async function r2MergeJSON(bucket, key, mutate, tag, maxAttempts = 6) {
  const EPOCH = new Date("2000-01-01T00:00:00Z");
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let cur = null, etag = null, exists = false;
    try {
      const o = await bucket.get(key);
      if (o) { exists = true; etag = o.etag; try { cur = JSON.parse(await o.text()); } catch (_) { cur = null; } }
    } catch (_) {}
    const next = await mutate(cur);
    if (next === null || next === undefined) { try { await bucket.delete(key); } catch (_) {} return true; }
    const opts = { httpMetadata: { contentType: "application/json" }, onlyIf: exists ? { etagMatches: etag } : { uploadedBefore: EPOCH } };
    let res = null;
    try { res = await bucket.put(key, JSON.stringify(next), opts); } catch (_) { res = null; }
    if (res) return true;
    try { console.log("R2CAS conflict", JSON.stringify({ key, tag: tag || null, attempt })); } catch (_) {}
    await new Promise(r => setTimeout(r, 40 + Math.floor(Math.random() * 90)));
  }
  // Fallback: unconditional last-write-wins so we never spin forever on a hot key.
  try {
    const o = await bucket.get(key);
    let cur = null; if (o) { try { cur = JSON.parse(await o.text()); } catch (_) {} }
    const next = await mutate(cur);
    if (next === null || next === undefined) { try { await bucket.delete(key); } catch (_) {} return true; }
    await bucket.put(key, JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
    try { console.log("R2CAS fallback", JSON.stringify({ key, tag: tag || null })); } catch (_) {}
    return true;
  } catch (_) { return false; }
}

// Read-modify-write the consolidated pool aggregate so reads stay O(1) regardless
// of how many members participate. payload=null de-lists the member (consent→0).
// Low write-rate (write-through on a member's own activity); last-write-wins is
// acceptable here. At higher scale this merge moves to a queue/cron.
export async function globalPoolAggMerge(env, memberId, payload) {
  if (!env.GLOBAL_POOL_R2) return;
  // CAS merge: agg/pins.json is the single shared hot key touched by every
  // member's write, so etag-locking prevents lost updates when many per-account
  // consumers commit concurrently. payload=null de-lists the member.
  await r2MergeJSON(env.GLOBAL_POOL_R2, "agg/pins.json", (cur) => {
    const agg = (cur && cur.members) ? cur : { updated_at: null, members: {} };
    if (payload) agg.members[memberId] = payload;
    else delete agg.members[memberId];
    agg.updated_at = new Date().toISOString();
    return agg;
  }, `agg:${memberId}`);
}

// Rebuild a member's contribution to the shared aggregate from their per-account
// snapshot, honoring tier + exclusions. Called after any snapshot or consent
// change so the pool always reflects the current opt-in state. A member shares
// every ad account they have EXCEPT the ones they explicitly excluded; a member
// that ends up sharing nothing (tier 0, or all accounts excluded) is de-listed.
export async function globalAggregateMember(env, memberId) {
  if (!env.GLOBAL_POOL_R2) return;
  let tier = 0, exclusions = [];
  try {
    const raw = await env.META_KV.get(`global:consent:${memberId}`);
    if (raw) { const c = JSON.parse(raw); tier = Math.max(0, Math.min(3, c.tier | 0)); exclusions = Array.isArray(c.exclusions) ? c.exclusions.map(String) : []; }
  } catch (_) {}
  if (tier <= 0) { await globalPoolAggMerge(env, memberId, null); return; }
  let snap = null;
  try { const o = await env.GLOBAL_POOL_R2.get(`members/${memberId}.json`); if (o) snap = JSON.parse(await o.text()); } catch (_) {}
  const accounts = (snap && snap.accounts) || {};
  const exSet = new Set(exclusions);
  const rows = [];
  for (const acct of Object.keys(accounts)) {
    if (exSet.has(String(acct))) continue;
    for (const r of (accounts[acct].rows || [])) rows.push(r);
  }
  if (!rows.length) { await globalPoolAggMerge(env, memberId, null); return; }
  await globalPoolAggMerge(env, memberId, { tier, rows });
}

// Core of POST /meta/global/snapshot — publishes ONE account's shareable rows for a
// member into the global pool (R2 per-member store + aggregate), applying server-side
// consent tier/geo, minting opaque tokens, persisting durable previews. Extracted for
// in-process build publishing (no self-HTTP loopback). body = { account, account_name,
// rows }. ctx may be null (build): then the preview-fill runs inline, not via waitUntil.
export async function coreSnapshot(env, memberId, body, ctx) {
      // Authoritative tier + geo from server-side consent (client cannot raise it).
      let tier = 0, geo = "coarse";
      try {
        const raw = await env.META_KV.get(`global:consent:${memberId}`);
        if (raw) { const c = JSON.parse(raw); tier = Math.max(0, Math.min(3, c.tier|0)); geo = c.geo === "exact" ? "exact" : "coarse"; }
      } catch (_) {}

      // tier 0 = not participating → drop any existing snapshot + de-list from agg.
      if (tier <= 0) {
        try { await env.GLOBAL_POOL_R2.delete(`members/${memberId}.json`); } catch (_) {}
        await globalPoolAggMerge(env, memberId, null);
        return { ok:true, published: 0, tier: 0 };
      }

      const account = String(body.account || "default").slice(0, 80);
      const accountName = body.account_name ? String(body.account_name).slice(0, 120) : null;
      const inRows = Array.isArray(body.rows) ? body.rows.slice(0, 500) : [];
      try { console.log("GPOOL snapshot recv", JSON.stringify({ member: memberId, account, tier, geo, rows_in: inRows.length, withPreviewIn: inRows.filter(r => r && r.preview).length, withVideoIdIn: inRows.filter(r => r && r.video_id).length, withAdIdIn: inRows.filter(r => r && r.ad_id).length })); } catch (_) {}
      const rows = [];
      const persistTasks = [];  // [adId, previewUrl] — durable WebP fill
      const tokWrites = [];      // [tok, owner, item, kind] — opaque token reverse maps
      for (const r of inRows) {
        const lat = Number(r.lat), lng = Number(r.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const row = {
          // T1 — anonymous geo only (radius kept only when geo=exact)
          lat: geo === "exact" ? lat : globalCoarsen(lat),
          lng: geo === "exact" ? lng : globalCoarsen(lng),
          radius: geo === "exact" && Number.isFinite(Number(r.radius)) ? Number(r.radius) : null
        };
        // T1 — delivery status (effective_status); public, not PII. Drives the Live/Inactive filter.
        if (r.status) row.status = String(r.status).slice(0, 32).toUpperCase();
        if (tier >= 2) {
          // T2 — creative preview + format. NO ad_name (could leak campaign naming).
          if (r.preview) row.preview = String(r.preview).slice(0, 1000);
          row.format = r.is_video ? "video" : (r.format === "video" ? "video" : "image");
          // playable creative media so viewers can watch the actual reel in the
          // popup (the ad creative is public anyway — not PII). Poster = preview.
          // Store the video_id only; the pool builds an anonymized proxy URL so
          // the owner's member_id is never embedded in what viewers receive.
          if (r.video_id) row.video_id = String(r.video_id).slice(0, 80);
          // Opaque, daily-rotating tokens + durable preview persist. The stored row
          // (server-side R2 only) still holds the Meta preview URL and video_id as
          // the source for the fill; serve.js emits neither - viewers get token
          // proxy URLs only. ad_id mints the token and keys R2.
          const adId = r.ad_id ? String(r.ad_id).slice(0, 80) : null;
          if (adId) row._aid = adId; // server-side ONLY (cross-member dedup) — never copied into the served payload
          if (adId && row.preview) {
            row.tok = await globalTokCompute(env, memberId, adId, "img");
            tokWrites.push([row.tok, memberId, adId, "img"]);
            persistTasks.push([adId, row.preview]);
          }
          if (row.video_id) {
            row.vtok = await globalTokCompute(env, memberId, row.video_id, "vid");
            tokWrites.push([row.vtok, memberId, row.video_id, "vid"]);
          }
        }
        if (tier >= 3) {
          // T3 — ratio metrics ONLY. spend / leads / phones NEVER stored.
          if (Number.isFinite(Number(r.cpl))) row.cpl = +(+r.cpl).toFixed(2);
          if (Number.isFinite(Number(r.ctr))) row.ctr = +(+r.ctr).toFixed(2);
          if (Number.isFinite(Number(r.cpm))) row.cpm = +(+r.cpm).toFixed(2);
        }
        rows.push(row);
      }
      try { console.log("GPOOL snapshot store", JSON.stringify({ member: memberId, account, rows_out: rows.length, withTok: rows.filter(r => r.tok).length, withVtok: rows.filter(r => r.vtok).length, noAsset: rows.filter(r => !r.tok && !r.vtok).length })); } catch (_) {}

      // Per-account storage: update only THIS account and preserve the member's
      // other accounts, so switching the map view ACCUMULATES into the pool
      // instead of replacing it. The aggregate is rebuilt from all non-excluded
      // accounts afterwards.
      // CAS merge: only THIS account's entry is updated; concurrent per-account
      // queue consumers for the same member no longer clobber each other.
      const stored = await r2MergeJSON(env.GLOBAL_POOL_R2, `members/${memberId}.json`, (cur) => {
        const store = (cur && cur.accounts) ? cur : { member: memberId, accounts: {} };
        if (!store.accounts) store.accounts = {};
        store.member = memberId;
        store.tier = tier; store.geo = geo;
        store.accounts[account] = { name: accountName, rows, updated_at: new Date().toISOString() };
        store.updated_at = new Date().toISOString();
        return store;
      }, `snap:${account}`);
      if (!stored) return { ok:false, error:"Failed to store snapshot", status:500 };
      await globalAggregateMember(env, memberId);
      // Background fill: write token reverse-maps, then durably persist
      // previews to R2 (head-guarded, capped, lightly concurrent). Deferred so the
      // publish response is not blocked. Across re-publishes the head-guard skips
      // done previews, so the fill progresses without re-fetching.
      if (tokWrites.length || persistTasks.length) {
        const runFill = async () => {
          for (const w of tokWrites) { await globalTokWrite(env, w[0], w[1], w[2], w[3]); }
          let next = 0, fetched = 0;
          const CAP = 50; // max NEW preview fetches per publish (bounds the fill)
          const worker = async () => {
            while (next < persistTasks.length && fetched < CAP) {
              const [adId, url] = persistTasks[next++];
              if (await globalPersistPreview(env, memberId, adId, url)) fetched++;
            }
          };
          await Promise.all([worker(), worker(), worker()]);
        };
        // HTTP path: defer via waitUntil. In-process build (ctx=null): run inline —
        // the build already runs in a background context, so awaiting is fine.
        if (ctx && ctx.waitUntil) ctx.waitUntil(runFill().catch(() => {}));
        else await runFill().catch(() => {});
      }
      return { ok:true, published: rows.length, account, tier };
}

