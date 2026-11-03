/**
 * POST /meta/write/undo - mint the REVERSE plan from a journal row
 * (extracted from handleBuildWrite in backend/workers/meta.js).
 *
 * Undo is not a rollback (Meta has none): it is a second write. So it is built as
 * one - a new update_entity plan carrying the row's recorded "before" values, which
 * the person confirms like any other change, which is staleness-checked, journalled
 * and marked `undo_of` the row it reverses.
 *
 * `undo_of` unlocks things a normal plan may not do (an ACTIVE through a plain
 * update, when the undone change was a pause). Only this route may set it: the
 * re-entry carries a per-isolate secret header (`x-bw-undo`) that router.js checks,
 * and strips `undo_of` from any request without it.
 *
 * Trimmed: the direct (no-confirm) undo of created automated rules and of ad-text
 * replacements.
 */
import { bwJson, bwToken } from "./common.js";
import { journalRead, bwUndoState, bwLiveState } from "./journal.js";

let BW_UNDO_TOKEN = null;   // per isolate, never leaves it (made on first use: no random values in global scope)
export const bwUndoToken = () => BW_UNDO_TOKEN || (BW_UNDO_TOKEN = crypto.randomUUID());

export async function handleUndo(env, memberId, body, reenterPlan) {
  const { journal_id } = body || {};
  const journal = await journalRead(env, memberId);
  const idx = journal.findIndex(r => r.id === journal_id);
  const row = idx > -1 ? journal[idx] : null;
  if (!row) return bwJson({ ok: false, error: "Journal entry not found" }, 404);
  if (!row.undo || !Object.keys(row.undo).length) return bwJson({ ok: false, error: "This action has no undo" }, 400);
  // Never revert to a snapshot the world has moved past - and the world includes Ads
  // Manager, so the check reads Meta, not just our log.
  const tk = await bwToken(env, memberId);
  const live = tk.token ? await bwLiveState(env, tk.token, [{ id: String(row.entity_id), type: row.entity_type }], memberId) : {};
  const st = bwUndoState(journal, idx, live, null);
  if (!st.undo_ok) {
    const why = st.undo_block === "undone" ? "Already undone"
      : st.undo_block === "is_undo" ? "This row is itself an undo. Ask for the change again instead."
      : st.undo_block === "entity_gone" ? "This object no longer exists in Meta"
      : st.undo_block === "changed_outside" ? "Changed outside Liaison since, most likely in Ads Manager. Undo would revert a state that no longer exists."
      : "Changed again after this. Undo would revert a state that no longer exists.";
    return bwJson({ ok: false, error: why, error_class: st.undo_block, now_value: st.now_value || null }, 409);
  }
  const changes = {};
  if (row.undo.status) changes.status = row.undo.status;
  if (row.undo.daily_budget != null) changes.daily_budget_minor = row.undo.daily_budget;   // exact minor units, no re-conversion
  if (row.undo.name) changes.name = row.undo.name;
  // Re-enter through plan so the person confirms the undo like any change.
  const planReq = new Request(`https://internal/meta/write/plan?member_id=${encodeURIComponent(memberId)}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-bw-undo": bwUndoToken() },
    body: JSON.stringify({ tool: "update_entity", entity_id: row.entity_id, entity_type: row.entity_type, changes,
      session: row.session || null, account_name: row.account_name || null, undo_of: row.id })
  });
  return await reenterPlan(planReq);
}
