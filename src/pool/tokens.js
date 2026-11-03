/**
 * Opaque pool tokens and anonymous owner labels (extracted from backend/workers/meta.js).
 *
 * Viewers of the cross-tenant pool receive only `tok` (a creative's preview) or
 * `vtok` (its video) - an opaque, daily-rotating handle:
 *
 *     tok = base64url( HMAC-SHA256(secret, owner|item|kind|epochDay) )[0..24)
 *
 * unguessable (server secret), irreversible (no ad_id / video_id / member_id can be
 * derived from it), stable within a UTC day (so CDN- and browser-cacheable), and
 * rotating every day. A reverse map `gtok:{tok} -> {o, i, k}` in KV (TTL 2 days, so
 * yesterday's tokens still resolve across the day boundary) is the only way back,
 * and it lives server-side. The secret bootstraps itself in KV on first use, so
 * there is no out-of-band secret to manage.
 */

export function globalCoarsen(n) { return Math.round(Number(n) * 100) / 100; }

let _gTokSecret = null;
export async function globalTokenSecret(env) {
  if (_gTokSecret) return _gTokSecret;
  try { const raw = await env.META_KV.get("global:token_secret"); if (raw) { _gTokSecret = raw; return raw; } } catch (_) {}
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  const secret = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try { await env.META_KV.put("global:token_secret", secret); } catch (_) {}
  _gTokSecret = secret;
  return secret;
}
export function globalEpochDay() { return Math.floor(Date.now() / 864e5); }
export function _bytesB64url(u8) {
  let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
let _gTokKey = null;
export async function globalTokenKey(env) {
  if (_gTokKey) return _gTokKey;
  const secret = await globalTokenSecret(env);
  _gTokKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return _gTokKey;
}
// Compute the opaque token WITHOUT touching KV (cheap, sync-path friendly).
export async function globalTokCompute(env, owner, item, kind) {
  const key = await globalTokenKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${owner}|${item}|${kind}|${globalEpochDay()}`));
  return _bytesB64url(new Uint8Array(sig)).slice(0, 24);
}
// Write the reverse map gtok:{tok} -> {o,i,k} (deferred to waitUntil).
export async function globalTokWrite(env, tok, owner, item, kind) {
  try { await env.META_KV.put(`gtok:${tok}`, JSON.stringify({ o: owner, i: item, k: kind }), { expirationTtl: 172800 }); } catch (_) {}
}
// Compute + write in one shot (one-off callers).
export async function globalMintToken(env, owner, item, kind) {
  const tok = await globalTokCompute(env, owner, item, kind);
  await globalTokWrite(env, tok, owner, item, kind);
  return tok;
}
// Durable preview persist: fetch the (server-fetchable) FB preview, transcode to
// WebP via the Images binding, store under {member}/creatives/{adId}. Head-guarded
// so re-publishes are cheap. Returns true only if it actually fetched+stored.
export async function globalResolveToken(env, tok) {
  if (!tok || typeof tok !== "string" || tok.length > 64) return null;
  try { const raw = await env.META_KV.get(`gtok:${tok}`); if (raw) return JSON.parse(raw); } catch (_) {}
  return null;
}

// A stable, opaque grouping label for an advertiser (shown from tier 2). One-way;
// grouping only, not a security boundary - the raw member id never leaves the server.
export function globalOwnerToken(memberId) {
  // Deterministic, opaque, anonymous codename in the spirit of the global map.
  // Two independent hashes pick an adjective + a cartographic/celestial noun, so
  // the same advertiser always reads the same (e.g. "Cobalt Petrel") while the
  // raw member id is never reversible from it. ~48×48 ≈ 2.3k combinations.
  const ADJ = [
    "Cobalt","Indigo","Azure","Cerulean","Sapphire","Slate","Onyx","Obsidian",
    "Amber","Crimson","Scarlet","Verdant","Emerald","Ivory","Cinnabar","Sable",
    "Marine","Violet","Copper","Jade","Pearl","Ashen","Ember","Frost",
    "Dusk","Auric","Russet","Teal","Umber","Saffron","Garnet","Glacial",
    "Tidal","Solar","Lunar","Polar","Coral","Iron","Velvet","Mistral",
    "Argent","Storm","Gilded","Opaline","Twilight","Vesper","Hazel","Sterling"
  ];
  const NOUN = [
    "Petrel","Heron","Falcon","Kestrel","Orion","Vega","Atlas","Meridian",
    "Compass","Lyra","Drake","Corsair","Nomad","Beacon","Harbor","Summit",
    "Delta","Cygnus","Phoenix","Mariner","Sirius","Pioneer","Sextant","Horizon",
    "Zephyr","Comet","Estuary","Strait","Fathom","Voyager","Aurora","Polaris",
    "Antares","Lumen","Lantern","Quasar","Nova","Albatross","Tundra","Cirrus",
    "Reef","Monsoon","Equinox","Cove","Caravan","Lagoon","Pelican","Schooner"
  ];
  const s = "lia-pool|" + String(memberId);
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = ((h1 * 33) ^ c) >>> 0;
    h2 = ((h2 * 33) ^ (c ^ 0x5a)) >>> 0;
  }
  return ADJ[h1 % ADJ.length] + " " + NOUN[h2 % NOUN.length];
}
