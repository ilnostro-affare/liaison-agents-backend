/**
 * Plan staleness (extracted from backend/workers/meta.js).
 *
 * A write plan has NO timer. It waits for the person's answer for as long as it is
 * stored, and it is cancelled for one reason only: the object it changes moved in
 * Meta since the plan was made (someone edited it in Ads Manager, another tool,
 * another plan). Two halves:
 *
 *   reactive   - apply (and the plan-state route) re-reads exactly the fields the
 *                plan touches and compares them with the "before" values the plan
 *                recorded (`plan.undo`). Different -> the plan is cancelled, with
 *                the fields named, and nothing is sent to Meta.
 *   proactive  - Meta's activity feed and ad-account webhooks mark open plans on a
 *                changed object as SUSPECTS (`lia:planstale:{plan}`, verified:false);
 *                the next read verifies them against the live object.
 *
 * BW_PLAN_KEEP is storage hygiene only - a KV key must expire some day - and is
 * never shown to anyone as a countdown.
 */
import { BW_GRAPH } from "./common.js";

export const BW_PLAN_KEEP = 30 * 86400;
export const BW_TTL = BW_PLAN_KEEP;   // the refusal paths of apply put a plan back with what is left of it
// Both fields stay in the reply shape (clients read null as "no countdown").
export const bwExpiry = () => ({ ttl: null, expires_at: null });


/* A plan is STALE when the fields it changes no longer hold the values it
   was made against. `plan.undo` is exactly that record - the planner fills it
   from the same read it builds the diff's "from" side from - so the check at
   apply reads those fields again and compares. Only fields whose shape is known
   on both sides are compared; anything else is left to Meta, as before. */
export const BW_STALE_LABEL = { name: "Name", status: "Status", daily_budget: "Daily budget", lifetime_budget: "Lifetime budget",
  bid_amount: "Bid amount", bid_strategy: "Bid strategy", spend_cap: "Campaign spending limit", start_time: "Start date",
  end_time: "End date", pacing_type: "Delivery type", adset_schedule: "Schedule", targeting: "Audience and placements",
  placement_soft_opt_out: "Limited spending on excluded placements", special_ad_categories: "Special ad category",
  special_ad_category_country: "Countries" };
export const BW_STALE_FIELDS = Object.keys(BW_STALE_LABEL);
export const BW_STALE_SCALAR = ["name", "status", "daily_budget", "lifetime_budget", "bid_amount", "bid_strategy", "spend_cap", "start_time", "end_time"];
/* Objects compared without key order, nulls or empties: a read and a later read
   of the same unchanged object must come out equal, or a person is refused for
   nothing - which is worse than the timer this replaces. */
export function bwStaleCanon(v) {
  if (v === undefined || v === null || v === "") return null;
  if (Array.isArray(v)) { const a = v.map(bwStaleCanon).filter((x) => x !== null); return a.length ? a : null; }
  if (typeof v === "object") {
    const o = {};
    Object.keys(v).sort().forEach((k) => { const c = bwStaleCanon(v[k]); if (c !== null) o[k] = c; });
    return Object.keys(o).length ? o : null;
  }
  return String(v);   // Meta answers numbers as strings on some fields and not on others
}
export function bwStaleNorm(field, v) {
  if (v === undefined) v = null;
  switch (field) {
    case "name": case "status": return v == null ? "" : String(v);
    case "bid_strategy": return v == null || v === "" ? "LOWEST_COST_WITHOUT_CAP" : String(v);   // the planner's own default (spend cap branch)
    case "daily_budget": case "lifetime_budget": case "bid_amount": { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; }
    case "spend_cap": { const n = Number(v); return isFinite(n) && n > 0 && n < 922337203685478 ? n : 0; }   // BWNOCAP = no limit
    case "start_time": case "end_time": {
      if (v == null || v === "" || v === 0 || v === "0") return null;
      const ms = Date.parse(String(v));
      return isFinite(ms) && ms > 0 ? ms : String(v);
    }
    case "pacing_type": { const a = (Array.isArray(v) ? v : []).map(String).filter(Boolean).sort(); return (a.length ? a : ["standard"]).join(","); }
    case "special_ad_categories": case "special_ad_category_country": {
      const a = (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x || "").trim().toUpperCase()).filter((x) => x && x !== "NONE").sort();
      return a.join(",");
    }
    default: return JSON.stringify(bwStaleCanon(v));   // adset_schedule, targeting, placement_soft_opt_out
  }
}
/** The fields of `undo` whose live value differs, each named for a person. */
export function bwPlanStaleFields(undo, live, keys) {
  const out = [];
  const u = undo || {};
  (keys || Object.keys(u)).forEach((k) => {
    if (BW_STALE_FIELDS.indexOf(k) < 0 || !Object.prototype.hasOwnProperty.call(u, k)) return;
    const was = bwStaleNorm(k, u[k]), now = bwStaleNorm(k, live ? live[k] : null);
    if (was === now) return;
    const row = { field: k, label: BW_STALE_LABEL[k] };
    if (BW_STALE_SCALAR.indexOf(k) > -1) { row.planned_from = u[k] == null ? null : String(u[k]); row.now = live && live[k] != null ? String(live[k]) : null; }
    out.push(row);
  });
  return out;
}
/** An EDIT plan: fields written onto one existing object, with what they held. */
export function bwPlanIsEdit(plan) {
  return !!(plan && plan.fields && plan.undo && typeof plan.undo === "object" && !plan.copy && !plan.create_upload
    && !plan.update_texts && !plan.create_rule && !plan.create_ab_test && !plan.create_campaign && !plan.create_adset && !plan.create);
}
/* One read of the fields the plan touches. A field the node does not have is
   dropped and the read tried again (Graph names it); any other failure answers
   checked:false and apply goes on without the check - a check that cannot
   run must not become a refusal of its own. */
export async function bwPlanStaleCheck(token, plan) {
  const undo = (plan && plan.undo) || {};
  let keys = Object.keys(undo).filter((k) => BW_STALE_FIELDS.indexOf(k) > -1);
  if (!keys.length || !/^\d{6,}$/.test(String((plan && plan.entity_id) || ""))) return { checked: false, stale: false, changed: [], reason: "nothing_to_compare" };
  for (let i = 0; i < 3 && keys.length; i++) {
    let live = null;
    try { live = await (await fetch(`${BW_GRAPH}/${plan.entity_id}?fields=${keys.join(",")}&access_token=${token}`)).json(); }
    catch (_) { return { checked: false, stale: false, changed: [], reason: "read_failed" }; }
    if (live && !live.error) {
      const changed = bwPlanStaleFields(undo, live, keys);
      return { checked: true, stale: changed.length > 0, changed, fields: keys };
    }
    const msg = String((live && live.error && live.error.message) || "");
    const m = /nonexisting field \(([a-z_]+)\)/i.exec(msg);
    if (!m || keys.indexOf(m[1]) < 0) return { checked: false, stale: false, changed: [], reason: "read_failed", detail: msg.slice(0, 200) };
    keys = keys.filter((k) => k !== m[1]);
  }
  return { checked: false, stale: false, changed: [], reason: "nothing_to_compare" };
}
/** The refusal, stamped with the plan and the object it was for (rule 11). */
export function bwStaleReply(plan, planId, changed, at) {
  const labels = (changed || []).map((c) => c.label || c.field);
  const what = labels.length ? labels.join(", ") + (labels.length === 1 ? " was" : " were") + " changed" : "It was changed";
  const msg = "Cancelled: Meta changed since this plan was made. " + what + " on \u00ab" + ((plan && plan.entity_name) || (plan && plan.entity_id) || "this object")
    + "\u00bb outside this plan, so it no longer describes the account. Nothing was sent. Ask Lia to prepare it again from the current values.";
  return { ok: false, error: "plan_stale", error_class: "plan_stale", stale: true, cancelled: true, retryable: false,
    plan_id: planId, entity_id: (plan && plan.entity_id) || null, entity_type: (plan && plan.entity_type) || null,
    entity_name: (plan && plan.entity_name) || null, account: (plan && plan.account) || null,
    changed_fields: changed || [], stale_at: at || Date.now(),
    user_message: msg, user_msg: msg, hint: msg, expires_at: null };
}
/* Cancel a stale plan: the plan key goes (nothing can apply it), its own record
   stays (one key per plan, rule 10) so apply, plan-state and the cards can say
   why for as long as the plan would have been kept. Not a journal row: the
   journal holds writes that reached Meta, each one undoable, and a plan that
   never went out is neither. */
export async function bwPlanCancelStale(env, memberId, planId, plan, changed, at, src) {
  try { await env.META_KV.delete(`lia:plan:${planId}`); } catch (_) {}
  try {
    await env.META_KV.put(`lia:planstale:${planId}`, JSON.stringify({ t: at, src, verified: true, member: memberId, changed: changed || [],
      reason: "Cancelled: Meta changed since this plan was made",
      plan: { entity_id: plan.entity_id || null, entity_type: plan.entity_type || null, entity_name: plan.entity_name || null,
        account: plan.account || null, tool: plan.tool || null, diff: Array.isArray(plan.diff) ? plan.diff.slice(0, 20) : [],
        session: plan.session || null, created: plan.created || null } }), { expirationTtl: BW_PLAN_KEEP });
  } catch (_) {}
  if (plan.account && plan.entity_id) { try { await env.META_KV.delete(`lia:planobj:${plan.account}:${plan.entity_id}:${planId}`); } catch (_) {} }
  console.log("LIA_PLAN_STALE", JSON.stringify({ member: memberId, plan: planId, src, tool: plan.tool || null, entity: plan.entity_id || null,
    entity_type: plan.entity_type || null, account: plan.account || null, fields: (changed || []).map((c) => c.field), age_s: plan.created ? Math.round((at - plan.created) / 1000) : null }));
}
/* The proactive half. One key per open edit plan (rule 10), under its ACCOUNT so
   a feed or a webhook asks with one list: lia:planobj:{acct}:{entity}:{plan},
   the plan's birth in the metadata. */
export async function bwPlanIndexPut(env, account, entityId, planId) {
  try {
    const a = String(account || "").replace(/^act_/, "");
    if (!/^\d+$/.test(a) || !/^\d+$/.test(String(entityId || "")) || !planId) return;
    await env.META_KV.put(`lia:planobj:${a}:${entityId}:${planId}`, "1", { expirationTtl: BW_PLAN_KEEP, metadata: { c: Date.now() } });
  } catch (_) {}
}
/* Meta says an object changed (an activity row, a webhook). Every open plan on it
   made BEFORE the change is marked as a SUSPECT - not cancelled: the feed does
   not say which field, and our own apply of a sibling plan shows up here too.
   /meta/write/plan-state and apply verify against the live object and either
   cancel the plan or clear the mark. events: [{ id, at, what, src }]. */
export async function bwPlanSuspect(env, acct, events) {
  const a = String(acct || "").replace(/^act_/, "");
  const ev = (events || []).filter((e) => e && e.id && Number(e.at) > 0);
  if (!a || !ev.length) return 0;
  let keys = [];
  try { keys = ((await env.META_KV.list({ prefix: `lia:planobj:${a}:`, limit: 1000 })) || {}).keys || []; } catch (_) { return 0; }
  let n = 0;
  for (const k of keys) {
    const parts = String(k.name).split(":");
    const ent = parts[3], pid = parts[4];
    const made = Number(k.metadata && k.metadata.c) || 0;
    const hit = ev.filter((e) => String(e.id) === ent && Number(e.at) > made);
    if (!hit.length || !pid) continue;
    let alive = null;
    try { alive = await env.META_KV.get(`lia:plan:${pid}`); } catch (_) { continue; }
    if (!alive) { try { await env.META_KV.delete(k.name); } catch (_) {} continue; }   // applied or gone: the index follows
    const last = hit.reduce((x, y) => (Number(y.at) > Number(x.at) ? y : x));
    try {
      await env.META_KV.put(`lia:planstale:${pid}`, JSON.stringify({ t: Date.now(), at: Number(last.at), src: last.src || null,
        what: last.what ? String(last.what).slice(0, 120) : null, entity_id: ent, verified: false }), { expirationTtl: BW_PLAN_KEEP });
      n++;
      console.log("LIA_PLAN_SUSPECT", JSON.stringify({ plan: pid, entity: ent, acct: a, src: last.src || null, what: last.what || null }));
    } catch (_) {}
  }
  return n;
}
