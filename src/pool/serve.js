/**
 * The pool's HTTP surface (extracted from the route handlers in backend/workers/meta.js;
 * inline `if (isPath(...))` blocks turned into functions, bodies unchanged except
 * where noted).
 *
 *   GET  /meta/global/consent   the member's consent {tier, geo, exclusions}
 *   POST /meta/global/consent   set it; re-aggregates now and kicks a server build
 *   POST /meta/global/refresh   "rebuild me if stale" (debounced, 12 min)
 *   GET  /meta/global/pool      the pool, cut reciprocally for the requester
 *   GET  /meta/global/asset     ?tok=  preview WebP from R2           (auth-exempt)
 *   GET  /meta/global/video     ?tok=  video from R2, lazy-filled     (auth-exempt)
 *
 * asset and video are <img>/<video> sources, so they are not behind the session
 * auth gate: they are gated by the opaque token, the owner's CURRENT consent tier,
 * and nothing else. `memberId` in the other handlers is the tenant the auth gate
 * resolved from a verified session token (a URL member_id is never trusted).
 */
import { globalOwnerToken, globalResolveToken } from "./tokens.js";
import { globalLazyFetchVideo, parseByteRange } from "./media.js";
import { coreSnapshot, globalAggregateMember } from "./snapshot.js";
import { globalBuildMember } from "./build.js";

const LIA_API = "https://api.liaisone.com";
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });

// Tiers (reciprocal - you see of others only what you publish of yourself):
//   0 = not participating | 1 = anonymous geo dots | 2 = +creatives/format
//   3 = +CPL/CTR/CPM (ratios only - never raw spend, never lead counts, never PII)
export async function getConsent(env, memberId) {
  let state = { tier: 0, geo: "coarse", exclusions: [], updated_at: null };
  try {
    const raw = await env.META_KV.get(`global:consent:${memberId}`);
    if (raw) state = { ...state, ...JSON.parse(raw) };
  } catch (_) {}
  return json({ ok: true, consent: state });
}

export async function postConsent(env, ctx, memberId, body) {
  const tier = Math.max(0, Math.min(3, parseInt(body.tier, 10) || 0));
  const geo = body.geo === "exact" ? "exact" : "coarse";
  // Exclusions = ad accounts the member opts OUT of sharing. Default empty = share every account.
  const exclusions = Array.isArray(body.exclusions)
    ? [...new Set(body.exclusions.map(x => String(x)).filter(Boolean))].slice(0, 200)
    : [];
  const state = { tier, geo, exclusions, updated_at: new Date().toISOString() };
  try {
    await env.META_KV.put(`global:consent:${memberId}`, JSON.stringify(state));
  } catch (e) {
    return json({ ok: false, error: "Failed to save consent" }, 500);
  }
  // Re-aggregate immediately so a tier/exclusion change is reflected without waiting
  // for a republish; then a full server-side build in the background.
  await globalAggregateMember(env, memberId);
  if (tier > 0 && ctx && ctx.waitUntil) ctx.waitUntil(globalBuildMember(env, memberId).catch(() => {}));
  return json({ ok: true, consent: state });
}

// The server is the SOLE writer: the map only nudges a rebuild, debounced in KV so
// repeated map-opens do not storm the build.
export async function postRefresh(env, ctx, memberId) {
  const STALE_MS = 12 * 60 * 1000;
  const rkey = `global:refresh:${memberId}`;
  let last = 0;
  try { const v = await env.META_KV.get(rkey); if (v) last = Number(v) || 0; } catch (_) {}
  const now = Date.now();
  const fresh = last && (now - last < STALE_MS);
  if (!fresh) {
    try { await env.META_KV.put(rkey, String(now), { expirationTtl: 86400 }); } catch (_) {}
    if (ctx && ctx.waitUntil) ctx.waitUntil(globalBuildMember(env, memberId).catch(() => {}));
  }
  return json({ ok: true, triggered: !fresh, age_ms: last ? (now - last) : null, stale_ms: STALE_MS });
}

// (POST /meta/global/snapshot - a client publish - is coreSnapshot behind the same gate.)
export async function postSnapshot(env, ctx, memberId, body) {
  const res = await coreSnapshot(env, memberId, body, ctx);
  if (!res.ok) { const st = res.status || 500; delete res.status; return json(res, st); }
  return json(res);
}

// GET /meta/global/pool - effective tier per owner = min(owner.tier, requester.tier).
// The raw member_id NEVER leaves the server; an opaque owner label is exposed from T2.
export async function getPool(env, memberId) {
  let tReq = 0;
  try {
    const raw = await env.META_KV.get(`global:consent:${memberId}`);
    if (raw) tReq = Math.max(0, Math.min(3, (JSON.parse(raw).tier) | 0));
  } catch (_) {}
  // Reciprocity: tier 0 publishes nothing -> sees nothing.
  if (tReq <= 0) return json({ ok: true, tier: 0, count: 0, pool: [], note: "Opt in to the global map to view other advertisers." });

  let agg = null;
  try {
    const obj = await env.GLOBAL_POOL_R2.get("agg/pins.json");
    if (obj) agg = JSON.parse(await obj.text());
  } catch (_) {}
  const members = (agg && agg.members) || {};

  // Reciprocity floor: you must be sharing at least one ad account to view. A tier
  // with everything excluded contributes nothing, so it sees nothing.
  const mine = members[memberId];
  if (!mine || !((mine.rows || []).length)) {
    return json({ ok: true, tier: tReq, count: 0, pool: [], note: "Share at least one ad account to view the global map." });
  }

  const pool = [];
  // Self-exclusion + global dedup. When another member shares one of the requester's
  // ad accounts, they republish the SAME ads; those must never appear to the
  // requester as "another advertiser". Matched on raw Meta ids kept server-side only.
  const mineVid = new Set(), mineAid = new Set();
  for (const r of (mine.rows || [])) { if (r.video_id) mineVid.add(r.video_id); if (r._aid) mineAid.add(r._aid); }
  const poolSeen = new Set(); // one pin per creative across all advertisers
  // How many advertisers run each creative (counts only, server-side ids).
  const dkOwners = {};
  for (const oid of Object.keys(members)) {
    for (const r of ((members[oid] || {}).rows || [])) {
      const dk = r._aid ? ("a:" + r._aid) : (r.video_id ? ("v:" + r.video_id) : null);
      if (!dk) continue;
      (dkOwners[dk] || (dkOwners[dk] = new Set())).add(oid);
    }
  }
  // The requester's own creatives that OTHER advertisers also run - keyed by the
  // requester's own ids (which they already know), values are counts only.
  const mine_dups = {};
  for (const r of (mine.rows || [])) {
    const dk = r._aid ? ("a:" + r._aid) : (r.video_id ? ("v:" + r.video_id) : null);
    if (!dk || !dkOwners[dk]) continue;
    const others = dkOwners[dk].size - (dkOwners[dk].has(memberId) ? 1 : 0);
    if (others > 0) { if (r._aid) mine_dups["a:" + r._aid] = others; if (r.video_id) mine_dups["v:" + r.video_id] = others; }
  }
  for (const ownerId of Object.keys(members)) {
    if (ownerId === memberId) continue;
    const m = members[ownerId] || {};
    const eff = Math.min(m.tier | 0, tReq);
    if (eff < 1) continue;
    const ownerTok = eff >= 2 ? globalOwnerToken(ownerId) : null; // anonymous below T2
    for (const r of (m.rows || [])) {
      if ((r._aid && mineAid.has(r._aid)) || (r.video_id && mineVid.has(r.video_id))) continue;
      const _dk = r._aid ? ("a:" + r._aid) : (r.video_id ? ("v:" + r.video_id) : null);
      if (_dk) { if (poolSeen.has(_dk)) continue; poolSeen.add(_dk); }
      // An allow-list, field by field: nothing reaches the viewer that is not named here.
      const out = { lat: r.lat, lng: r.lng };
      if (r.radius != null) out.radius = r.radius;
      if (r.status) out.status = r.status;
      if (eff >= 2) {
        out.owner = ownerTok;
        out.advertisers = (_dk && dkOwners[_dk]) ? dkOwners[_dk].size : 1;
        // ONLY token proxy URLs. No Meta CDN URL, no raw ad_id / video_id. A creative
        // pin needs a persisted preview (a token); without one it degrades to a dot.
        if (r.tok) out.preview = `${LIA_API}/meta/global/asset?tok=${encodeURIComponent(r.tok)}`;
        if (r.vtok) out.video = `${LIA_API}/meta/global/video?tok=${encodeURIComponent(r.vtok)}`;
        if (r.format) out.format = r.format;
      }
      if (eff >= 3) {
        if (r.cpl != null) out.cpl = r.cpl;
        if (r.ctr != null) out.ctr = r.ctr;
        if (r.cpm != null) out.cpm = r.cpm;
      }
      pool.push(out);
    }
  }
  return json({ ok: true, tier: tReq, count: pool.length, pool, mine_dups });
}

// GET /meta/global/asset?tok= - opaque token -> WebP preview from R2.
export async function getAsset(env, url) {
  const cors = { "Access-Control-Allow-Origin": "*" };
  const tok = url.searchParams.get("tok");
  const rec = await globalResolveToken(env, tok);
  if (!rec || rec.k !== "img" || !rec.o || !rec.i) return new Response("Not found", { status: 404, headers: cors });
  // Current-consent gate: the owner must STILL share at tier >= 2. A token minted
  // earlier stops resolving as soon as the owner opts down or out.
  let ok = false;
  try {
    const obj = await env.GLOBAL_POOL_R2.get("agg/pins.json");
    if (obj) {
      const agg = JSON.parse(await obj.text());
      const m = ((agg && agg.members) || {})[rec.o];
      if (m && (m.tier | 0) >= 2) ok = true;
    }
  } catch (_) {}
  if (!ok) return new Response("Forbidden", { status: 403, headers: cors });
  let r2obj = null;
  try { r2obj = await env.META_LEADS_R2.get(`${rec.o}/creatives/${rec.i}`); } catch (_) {}
  if (!r2obj) return new Response("Not ingested", { status: 404, headers: cors });
  const ct = (r2obj.httpMetadata && r2obj.httpMetadata.contentType) || "image/webp";
  return new Response(r2obj.body, {
    headers: {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin"
    }
  });
}

// GET /meta/global/video?tok= - opaque token -> video, Range-aware.
// (The original also accepts a legacy ?o=&v= form kept during the rollout; and,
//  unlike the asset proxy, it does not re-check the owner's current tier on the
//  token path - the token's TTL bounds it. Both kept as in production.)
export async function getVideo(env, ctx, request, url) {
  const corsHdr = { "Access-Control-Allow-Origin": "*" };
  const res = await globalResolveToken(env, url.searchParams.get("tok"));
  const ownerMember = res && res.k === "vid" && res.o && res.i ? res.o : null;
  const v = ownerMember ? res.i : null;
  if (!ownerMember || !v) return new Response("Not found", { status: 404, headers: corsHdr });

  // Serve the durable R2 copy inline; member_id stays server-side.
  const vkey = `${ownerMember}/videos/${v}.mp4`;
  const rangeHeader = request.headers.get("Range");
  try {
    const rng = rangeHeader ? parseByteRange(rangeHeader) : null;
    const r2v = await env.META_LEADS_R2.get(vkey, rng ? { range: rng } : undefined);
    if (r2v) {
      const size = r2v.size;
      const vh = new Headers();
      vh.set("Content-Type", r2v.httpMetadata?.contentType || "video/mp4");
      vh.set("Accept-Ranges", "bytes");
      vh.set("Cache-Control", "public, max-age=31536000, immutable");
      vh.set("Access-Control-Allow-Origin", "*");
      vh.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
      if (rng && r2v.range) {
        const start = r2v.range.offset || 0;
        const len = (r2v.range.length != null) ? r2v.range.length : (size - start);
        vh.set("Content-Range", `bytes ${start}-${start + len - 1}/${size}`);
        vh.set("Content-Length", String(len));
        return new Response(r2v.body, { status: 206, headers: vh });
      }
      vh.set("Content-Length", String(size));
      return new Response(r2v.body, { status: 200, headers: vh });
    }
  } catch (_) {}
  // R2 miss -> LAZY fetch with the owner's token (server-side), persist, serve.
  const lazy = await globalLazyFetchVideo(env, ctx, ownerMember, v);
  if (!lazy || !lazy.bytes) return new Response("Unavailable", { status: 404, headers: corsHdr });
  const total = lazy.bytes.byteLength;
  const lh = new Headers();
  lh.set("Content-Type", lazy.type || "video/mp4");
  lh.set("Accept-Ranges", "bytes");
  lh.set("Cache-Control", "public, max-age=31536000, immutable");
  lh.set("Access-Control-Allow-Origin", "*");
  lh.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  const rng2 = rangeHeader ? parseByteRange(rangeHeader) : null;
  if (rng2) {
    const start = rng2.offset || 0;
    const len = (rng2.length != null) ? rng2.length : (total - start);
    const slice = lazy.bytes.slice(start, start + len);
    lh.set("Content-Range", `bytes ${start}-${start + len - 1}/${total}`);
    lh.set("Content-Length", String(len));
    return new Response(slice, { status: 206, headers: lh });
  }
  lh.set("Content-Length", String(total));
  return new Response(lazy.bytes, { status: 200, headers: lh });
}
