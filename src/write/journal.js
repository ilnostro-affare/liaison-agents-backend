/**
 * The write journal (extracted from backend/workers/meta.js).
 *
 * Every write that reached Meta becomes one row, newest first, in
 * `lia:journal:{member}` (capped at 500): what changed (`diff`, the same rows the
 * person confirmed), what it replaced (`undo`), which plan it came from, which chat
 * and which ad account. A plan that never went out is NOT a journal row.
 *
 * Undo is offered per row only while it is still true: bwUndoState refuses when the
 * row was already undone, is itself an undo, was superseded by a later write of
 * ours on the same field, or - read live from Meta - when the object was changed
 * outside Liaison or no longer exists.
 *
 * Known limitation, kept on purpose in this extract: the journal is ONE KV key per
 * member, appended read-modify-write. KV is eventually consistent and has no
 * compare-and-set, so two applies within the same moment can lose a row. The
 * production code mitigates the reader side with one extra key per applied plan
 * (`lia:planapplied:{plan}`, see apply.js), which a fresh reader never sees stale.
 */
import { BW_GRAPH, bwBatchGet, bwMoney } from "./common.js";

export const JOURNAL_MAX = 500;

export async function journalRead(env, memberId) {
  try {
    const raw = await env.META_KV.get(`lia:journal:${memberId}`);
    const j = raw ? JSON.parse(raw) : [];
    return Array.isArray(j) ? j : [];
  } catch (_) { return []; }
}
export async function journalAppend(env, memberId, entry) {
  const journal = await journalRead(env, memberId);
  journal.unshift(entry);
  await env.META_KV.put(`lia:journal:${memberId}`, JSON.stringify(journal.slice(0, JOURNAL_MAX)));
  return journal;
}

// Which fields a journal row actually moved (Graph field names, so "status" and
// "daily_budget" collide correctly across tools).
export function bwFields(row) {
  const f = new Set();
  (row.diff || []).forEach(d => {
    if (d.kind === "paused" || d.kind === "resumed" || d.kind === "activated") f.add("status");
    else if (d.kind === "budget") f.add("daily_budget");
    else if (d.kind === "renamed") f.add("name");
    else f.add(d.kind || "other");
  });
  return f;
}
// rows are newest-first; index i's "later" rows are those BEFORE it.
export function bwNewValue(row, fields) {
  const d = (row.diff || []).find(x => fields.has(x.kind === "budget" ? "daily_budget" : (x.kind === "renamed" ? "name" : "status")));
  return d ? String(d.new) : null;
}
export function bwPrimary(row) {
  const f = bwFields(row);
  return f.has("status") ? "status" : f.has("daily_budget") ? "daily_budget" : f.has("name") ? "name" : null;
}
function bwLiveValue(live, row, ccy) {
  const l = live && live[String(row.entity_id)];
  if (!l) return null;
  const p = bwPrimary(row);
  if (p === "status") return l.status || null;
  if (p === "name") return l.name || null;
  if (p === "daily_budget") return (l.daily_budget != null && ccy) ? bwMoney(Number(l.daily_budget), ccy) : null;
  return null;                                          // no field, no claim
}
/* Is this row still undoable? Never revert to a snapshot the world has moved past -
   and the world includes Ads Manager, so the check reads Meta, not just our log. */
export function bwUndoState(rows, i, live, ccy) {
  const row = rows[i];
  const hasUndo = !!(row.undo && Object.keys(row.undo).length);
  const now_value = bwLiveValue(live, row, ccy);
  const base = now_value ? { now_value } : {};
  if (!hasUndo) return { undo_ok: false, undo_block: "no_undo", ...base };
  if (row.undo_of) return { undo_ok: false, undo_block: "is_undo", ...base };
  const mine = bwFields(row);
  for (let k = i - 1; k >= 0; k--) {
    const later = rows[k];
    if (later.undo_of === row.id) return { undo_ok: false, undo_block: "undone", undone_at: later.ts, ...base };
    if (later.entity_id !== row.entity_id) continue;
    const theirs = bwFields(later);
    for (const f of mine) if (theirs.has(f)) return { undo_ok: false, undo_block: "superseded", changed_at: later.ts, ...base };
  }
  // Nothing in OUR log supersedes it - but the entity must still look the way this
  // row left it, or the undo is a lie.
  if (live && Object.keys(live).length) {
    if (!live[String(row.entity_id)]) return { undo_ok: false, undo_block: "entity_gone" };
    const put = bwNewValue(row, mine);
    const p = bwPrimary(row);
    if (p === "status" && put && now_value && String(put) !== String(now_value)) {
      return { undo_ok: false, undo_block: "changed_outside", ...base };   // Ads Manager, most likely
    }
  }
  return { undo_ok: true, undo_block: null, ...base };
}

/* What the entities look like RIGHT NOW. name+status in one batch (every node type
   answers to them), budgets in their own pass (asking an Ad for daily_budget fails the
   whole call). 60 s cache; an empty result is never cached. Our own writes of the last
   two minutes are overlaid (`lia:fresh:`), because Meta lags a few seconds on status
   and the journal must not show a pre-undo state. */
export async function bwLiveState(env, token, entities, memberKey) {
  const out = {};
  const uniq = [], seen = new Set();
  (entities || []).forEach(e => { const id = String(e && e.id || ""); if (id && !seen.has(id)) { seen.add(id); uniq.push(e); } });
  if (!uniq.length) return out;
  const ids = uniq.map(e => String(e.id)).slice(0, 100);
  const ck = "lia:live:" + memberKey + ":" + (await bwHash(ids.join(",")));
  try { const c = await env.META_KV.get(ck); if (c) return JSON.parse(c); } catch (_) {}
  try {
    const r = await bwBatchGet(BW_GRAPH, token, ids, "name,status,account_id");
    Object.keys(r).forEach(k => { if (r[k] && !r[k].error) out[k] = { name: r[k].name, status: r[k].status, account_id: r[k].account_id }; });
  } catch (_) {}
  const budgetIds = uniq.filter(e => e.type === "ad_set" || e.type === "campaign").map(e => String(e.id)).slice(0, 50);
  if (budgetIds.length) {
    try {
      const r = await bwBatchGet(BW_GRAPH, token, budgetIds, "daily_budget");
      Object.keys(r).forEach(k => { if (out[k] && r[k] && !r[k].error) out[k].daily_budget = r[k].daily_budget; });
    } catch (_) {}
  }
  if (Object.keys(out).length) { try { await env.META_KV.put(ck, JSON.stringify(out), { expirationTtl: 60 }); } catch (_) {} }
  try {
    for (const id of ids) {
      const f = await env.META_KV.get(`lia:fresh:${memberKey}:${id}`);
      if (f) { const fo = JSON.parse(f); out[id] = { ...(out[id] || {}), ...fo }; }
    }
  } catch (_) {}
  return out;
}
async function bwHash(str) {
  const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(b)).slice(0, 8).map(x => x.toString(16).padStart(2, "0")).join("");
}
