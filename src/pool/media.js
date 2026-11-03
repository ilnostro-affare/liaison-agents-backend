/**
 * Pool media: eager WebP previews, lazy videos (extracted from backend/workers/meta.js).
 *
 * Previews are EAGER: when an owner's rows are published, each creative's preview is
 * fetched server-side, transcoded to WebP through the Cloudflare Images binding (kept
 * only when smaller), and stored in R2 under `{owner}/creatives/{adId}`. Head-guarded,
 * so a re-publish never re-downloads.
 *
 * Videos are LAZY: Meta's video `source` is not fetchable ahead of time under a user
 * token for non-public videos, so the first viewer's request resolves it with the
 * OWNER's page token (server-side), streams it, and persists it to R2; every later
 * viewer is served from R2. Simultaneous requests for one video collapse into one
 * fetch (in-flight dedup), and a per-owner cap (VID_OWNER_CAP) shields the owner's
 * token from bursts - over the cap the viewer gets a placeholder, not a queue.
 */
export const GRAPH = "https://graph.facebook.com/v26.0";

// Durable preview persist: fetch the (server-fetchable) FB preview, transcode to
// WebP via the Images binding, store under {member}/creatives/{adId}. Head-guarded
// so re-publishes are cheap. Returns true only if it actually fetched+stored.

export async function globalPersistPreview(env, memberId, adId, previewUrl) {
  if (!env.META_LEADS_R2 || !memberId || !adId || !previewUrl) return false;
  const key = `${memberId}/creatives/${adId}`;
  try { if (await env.META_LEADS_R2.head(key)) return false; } catch (_) {}
  try {
    const res = await fetch(previewUrl);
    if (!res.ok) return false;
    const bytes = await res.arrayBuffer();
    const srcType = res.headers.get("content-type") || "image/jpeg";
    let putBytes = bytes, putType = srcType;
    try {
      if (env.IMAGES && /^image\//i.test(srcType) && srcType !== "image/webp") {
        const out = await env.IMAGES.input(bytes).output({ format: "image/webp", quality: 80 });
        const webpBuf = await out.response().arrayBuffer();
        if (webpBuf && webpBuf.byteLength > 0 && webpBuf.byteLength < bytes.byteLength) { putBytes = webpBuf; putType = "image/webp"; }
      }
    } catch (_) {}
    await env.META_LEADS_R2.put(key, putBytes, { httpMetadata: { contentType: putType }, customMetadata: { enc: "webp80" } });
    return true;
  } catch (_) { return false; }
}
// Resolve a playable mp4 source URL for a member's video, mirroring /meta/video:
// the `source` field is null under a user token for non-public videos, so probe
// for the owning page (from.id), pull that page's token from /me/accounts, then
// re-query source with the page token. Returns the FB CDN source URL or null.
export async function resolveVideoSourceUrl(env, memberId, videoId) {
  try {
    const fbUserId = await env.META_KV.get(`member:${memberId}:fb`);
    if (!fbUserId) return null;
    const rawToken = await env.META_KV.get(`fbtoken:${fbUserId}`);
    if (!rawToken) return null;
    const access_token = JSON.parse(rawToken).access_token;
    if (!access_token) return null;
    let sourceUrl = null, owningPageId = null;
    try {
      const probe = await (await fetch(`${GRAPH}/${encodeURIComponent(videoId)}?fields=source,from&access_token=${access_token}`)).json();
      sourceUrl = probe?.source || null;
      owningPageId = probe?.from?.id || null;
    } catch (_) {}
    if (!sourceUrl && owningPageId) {
      try {
        const pages = await (await fetch(`${GRAPH}/me/accounts?fields=id,access_token&limit=200&access_token=${access_token}`)).json();
        const page = (pages?.data || []).find(p => p.id === owningPageId);
        if (page?.access_token) {
          const pt = await (await fetch(`${GRAPH}/${encodeURIComponent(videoId)}?fields=source&access_token=${page.access_token}`)).json();
          sourceUrl = pt?.source || null;
        }
      } catch (_) {}
    }
    return sourceUrl;
  } catch (_) { return null; }
}
// Lazy video ingest for the global pool. On an R2 miss the first viewer's request
// resolves the owner's source (page-token dance, server-side), persists it to R2,
// and returns the bytes; every later viewer is served from R2. In-flight dedup
// collapses simultaneous clicks on the same video into ONE fetch; a per-owner cap
// shields the owner's token from bursts (over the cap -> null -> placeholder).
export const _vidInflight = new Map();    // vkey -> Promise<{bytes,type}|null>
export const _vidOwnerActive = new Map(); // ownerMember -> active fetches
export const VID_OWNER_CAP = 6;
export async function globalLazyFetchVideo(env, ctx, ownerMember, videoId) {
  const vkey = `${ownerMember}/videos/${videoId}.mp4`;
  if (_vidInflight.has(vkey)) return _vidInflight.get(vkey);
  if ((_vidOwnerActive.get(ownerMember) || 0) >= VID_OWNER_CAP) return null;
  const p = (async () => {
    _vidOwnerActive.set(ownerMember, (_vidOwnerActive.get(ownerMember) || 0) + 1);
    try {
      const sourceUrl = await resolveVideoSourceUrl(env, ownerMember, videoId);
      if (!sourceUrl) return null;
      const vidRes = await fetch(sourceUrl);
      if (!vidRes.ok) return null;
      const bytes = await vidRes.arrayBuffer();
      if (!bytes || bytes.byteLength === 0) return null;
      const type = vidRes.headers.get("content-type") || "video/mp4";
      const put = env.META_LEADS_R2.put(vkey, bytes, { httpMetadata: { contentType: type } }).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
      return { bytes, type };
    } catch (_) { return null; }
    finally { _vidOwnerActive.set(ownerMember, Math.max(0, (_vidOwnerActive.get(ownerMember) || 1) - 1)); }
  })();
  _vidInflight.set(vkey, p);
  try { return await p; } finally { _vidInflight.delete(vkey); }
}

export function parseByteRange(h) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || "").trim());
  if (!m) return null;
  const startStr = m[1], endStr = m[2];
  if (startStr === "" && endStr === "") return null;
  if (startStr === "") return { suffix: parseInt(endStr, 10) };        // last N bytes
  const offset = parseInt(startStr, 10);
  if (endStr === "") return { offset };                                // open-ended
  return { offset, length: (parseInt(endStr, 10) - offset + 1) };
}
