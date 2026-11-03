/**
 * The write layer's router (the shape of handleBuildWrite in backend/workers/meta.js).
 *
 * `member_id` arrives on the URL here only because the Graph worker's auth gate in
 * front of this (not included) has already replaced it with the tenant resolved
 * from a verified session token or the internal service token; a client-supplied
 * member id never reaches this function.
 */
import { bwJson } from "./common.js";
import { BW_PLAN_KEEP } from "./stale.js";
import { handlePlan } from "./plan.js";
import { handleApply, handlePlanState } from "./apply.js";
import { handleUndo, bwUndoToken } from "./undo.js";
import { journalRead, bwUndoState } from "./journal.js";

export async function handleBuildWrite(request, env, url, path) {
  const memberId = url.searchParams.get("member_id");
  if (!memberId) return bwJson({ ok: false, error: "Missing member_id" }, 400);
  const planTtl = BW_PLAN_KEEP;   // storage only: a plan has no timer

  // ── GET /meta/journal - the member's own write log, each row with its undo state ──
  // (The original also merges Meta's own activity log for the account, filtered to
  //  accounts this member's token lists, and checks live state for "Now <status>".)
  if (path.endsWith("/meta/journal") && request.method === "GET") {
    const rows = await journalRead(env, memberId);
    return bwJson({ ok: true, journal: rows.map((r, i) => ({ ...r, ...bwUndoState(rows, i, {}, null) })) });
  }

  let body = {};
  if (request.method === "POST") { try { body = await request.json(); } catch (_) {} }
  // undo_of unlocks a plain ACTIVE (the undo of our own pause). Only /meta/write/undo
  // may set it, so it is honoured only with this isolate's own token, which that route
  // adds to the request it builds and nobody else can know.
  if (body && body.undo_of && request.headers.get("x-bw-undo") !== bwUndoToken()) delete body.undo_of;

  if (path.endsWith("/meta/write/plan")) return handlePlan(env, memberId, body, planTtl);
  if (path.endsWith("/meta/write/plan-state")) return handlePlanState(request, env, url, memberId, body);
  if (path.endsWith("/meta/write/apply")) return handleApply(env, memberId, body);
  if (path.endsWith("/meta/write/undo")) {
    return handleUndo(env, memberId, body, (planReq) => handleBuildWrite(planReq, env, new URL(planReq.url), "/meta/write/plan"));
  }
  return bwJson({ ok: false, error: "Unknown write route" }, 404);
}
