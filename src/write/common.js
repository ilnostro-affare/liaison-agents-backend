/**
 * Shared helpers of the write layer (extracted from backend/workers/meta.js).
 * Graph access, the member's token, entity reads, money formatting.
 */
export const GRAPH_V_WRITE = "v26.0";
export const BW_GRAPH = `https://graph.facebook.com/${GRAPH_V_WRITE}`;

// The fields read for each entity type: the diff's "from" side and the undo record
// both come from this one read.
export const BW_FIELDS = {
  campaign: "name,status,effective_status,daily_budget,lifetime_budget,account_id,objective,spend_cap,bid_strategy",
  ad_set: "name,status,effective_status,daily_budget,lifetime_budget,campaign_id,account_id,adset_schedule,pacing_type,start_time,end_time,bid_strategy,bid_amount",
  ad: "name,status,effective_status,adset_id,campaign_id,account_id,creative{id}"
};

export const BW_ZERO_DEC = new Set(["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"]);

// API answers must never be cached at the edge: they are about state.
export function bwJson(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
}

// The member's Meta token: member -> facebook user -> long-lived token, all in KV.
export async function bwToken(env, memberId) {
  const fbUserId = await env.META_KV.get(`member:${memberId}:fb`);
  if (!fbUserId) return { error: "Meta not connected" };
  const raw = await env.META_KV.get(`fbtoken:${fbUserId}`);
  if (!raw) return { error: "Token not found" };
  try { return { token: JSON.parse(raw).access_token }; } catch { return { error: "Token unreadable" }; }
}

/* Graph's batch endpoint: one POST carrying up to fifty GETs. Returns {id: obj};
   a per-id error arrives as {error} under its id. If the batch itself fails it falls
   back to one GET per id, and says so in the log - a silent fallback is a bill
   nobody reads. */
const BW_BATCH_MAX = 50;
export async function bwBatchGet(base, token, ids, fields, params) {
  const out = {};
  const seen = new Set();
  const list = [];
  (ids || []).forEach(x => { const id = String(x == null ? "" : x); if (id && !seen.has(id)) { seen.add(id); list.push(id); } });
  if (!list.length) return out;
  const qs = [fields ? `fields=${encodeURIComponent(fields)}` : "", params || ""].filter(Boolean).join("&");
  const rel = (id) => qs ? `${id}?${qs}` : String(id);
  for (let i = 0; i < list.length; i += BW_BATCH_MAX) {
    const chunk = list.slice(i, i + BW_BATCH_MAX);
    let rows = null;
    try {
      const form = new URLSearchParams();
      form.set("access_token", token);
      form.set("include_headers", "false");
      form.set("batch", JSON.stringify(chunk.map(id => ({ method: "GET", relative_url: rel(id) }))));
      const r = await (await fetch(`${base}/`, { method: "POST", body: form })).json();
      if (Array.isArray(r)) rows = r;
      else console.log("LIA_BATCH_ERR", JSON.stringify({ n: chunk.length, fields: fields || null, error: (r && r.error && r.error.message) || "batch did not answer with an array" }));
    } catch (e) {
      console.log("LIA_BATCH_ERR", JSON.stringify({ n: chunk.length, fields: fields || null, error: String(e) }));
    }
    if (rows) {
      chunk.forEach((id, k) => {
        const row = rows[k];
        if (!row) return;
        let body = null;
        try { body = JSON.parse(row.body); } catch (_) { body = null; }
        if (body) out[id] = body;
        else console.log("LIA_BATCH_ERR", JSON.stringify({ id, code: row.code || null, error: "body was not JSON" }));
      });
      continue;
    }
    for (const id of chunk) {
      try {
        const one = await (await fetch(`${base}/${rel(id)}${qs ? "&" : "?"}access_token=${token}`)).json();
        if (one) out[id] = one;
      } catch (e) {
        console.log("LIA_BATCH_ERR", JSON.stringify({ id, error: String(e), stage: "per-id fallback" }));
      }
    }
  }
  return out;
}

/* Read an entity, tolerating a wrong entity_type: Meta ids are opaque and the model
   guesses. Returns { obj, type } or { err } with a CLASS, never raw Meta prose. */
export async function bwReadEntity(token, entityId, entityType) {
  const order = [entityType, ...["ad", "ad_set", "campaign"].filter(t => t !== entityType)];
  let last = null;
  for (const t of order) {
    if (!BW_FIELDS[t]) continue;
    const r = await (await fetch(`${BW_GRAPH}/${entityId}?fields=${BW_FIELDS[t]}&access_token=${token}`)).json();
    if (!r.error) return { obj: r, type: t, retyped: t !== entityType };
    last = r.error;
    // "nonexisting field" == right object, wrong shape -> keep trying shapes.
    if (!/nonexisting field/i.test(String(r.error.message || ""))) break;
  }
  const msg = String(last && last.message || "");
  if (/does not exist|cannot be loaded|Unsupported get request/i.test(msg)) {
    return { err: {
      error: "Entity " + entityId + " is not one of your ads, ad sets or campaigns",
      error_class: "not_found",
      hint: "This is NOT a permissions problem. The id is wrong or stale. Call get_ads_tree, take the exact id from it, and try again. Never reuse an id from an earlier message and never tell the user they have an access problem.",
      graph_code: (last && last.code) || null
    }, status: 404 };
  }
  return { err: {
    error: "Meta rejected the read",
    error_class: "graph_error",
    detail: msg,
    hint: "Report exactly what Meta said. Do not call it an access problem unless Meta names permissions AND the entity id came from get_ads_tree.",
    graph_code: (last && last.code) || null
  }, status: 502 };
}

const BW_DEAD = new Set(["DELETED", "ARCHIVED"]);
export const bwIsDead = (o) => BW_DEAD.has(String(o && o.status || "")) || BW_DEAD.has(String(o && o.effective_status || ""));
export const BW_DEAD_ERR = {
  error: "This object was deleted in Ads Manager, so nothing can be changed on it",
  error_class: "entity_gone",
  hint: "Do not try again on this id. Tell the user it is gone, and offer to duplicate the original instead."
};

export async function bwCurrency(token, accountId) {
  try {
    const a = await (await fetch(`${BW_GRAPH}/act_${String(accountId).replace(/^act_/, "")}?fields=currency,timezone_name&access_token=${token}`)).json();
    const code = (a && a.currency) || "EUR";
    return { code, offset: BW_ZERO_DEC.has(code) ? 1 : 100, tz: (a && a.timezone_name) || null };
  } catch (_) { return { code: "EUR", offset: 100, tz: null }; }
}
export const bwMoney = (minor, cur) => (cur.code === "EUR" ? "€" : cur.code === "USD" ? "$" : cur.code + " ") + (minor / cur.offset);

/* Budgets live on the campaign (CBO) OR on each ad set (ABO), never on an ad. Asked
   to change a budget where there is none, find where it lives instead of bouncing
   with a Meta error. */
export async function bwBudgetHost(token, obj, type) {
  const hasB = (o) => o && (Number(o.daily_budget) > 0 || Number(o.lifetime_budget) > 0);
  if (hasB(obj)) return { id: obj.id, type, obj, moved: false };
  const chain = [];
  if (type === "ad" && obj.adset_id) chain.push({ id: obj.adset_id, type: "ad_set" });
  if (obj.campaign_id) chain.push({ id: obj.campaign_id, type: "campaign" });
  for (const node of chain) {
    const r = await (await fetch(`${BW_GRAPH}/${node.id}?fields=${BW_FIELDS[node.type]}&access_token=${token}`)).json();
    if (!r.error && hasB(r)) return { id: node.id, type: node.type, obj: r, moved: true, from: { type } };
  }
  // An ABO campaign: the budget lives DOWNWARD, on its ad sets. Do not pick one -
  // surface them, so the person is asked which.
  if (type === "campaign") {
    const r = await (await fetch(`${BW_GRAPH}/${obj.id}/adsets?fields=name,status,daily_budget,lifetime_budget&limit=200&access_token=${token}`)).json();
    if (!r.error && (r.data || []).some(hasB)) {
      const sets = (r.data || []).filter(hasB).map(a => ({ id: a.id, name: a.name, status: a.status, daily_budget: a.daily_budget || null, lifetime_budget: a.lifetime_budget || null }));
      return { abo: true, campaign: { id: obj.id, name: obj.name }, sets };
    }
  }
  return null;
}

export async function bwPath(token, obj, type) {
  const ids = [];
  if (type === "ad") { if (obj.campaign_id) ids.push(obj.campaign_id); if (obj.adset_id) ids.push(obj.adset_id); }
  else if (type === "ad_set") { if (obj.campaign_id) ids.push(obj.campaign_id); }
  if (!ids.length) return null;
  try {
    const r = await bwBatchGet(BW_GRAPH, token, ids, "name");
    const got = (id) => (r[id] && !r[id].error) ? r[id] : null;
    const out = {};
    if (obj.campaign_id && got(obj.campaign_id)) out.campaign = { id: obj.campaign_id, name: r[obj.campaign_id].name };
    if (obj.adset_id && got(obj.adset_id)) out.ad_set = { id: obj.adset_id, name: r[obj.adset_id].name };
    return Object.keys(out).length ? out : null;
  } catch (_) { return null; }
}
