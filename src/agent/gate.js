/**
 * The confirm gate, as the agent runner sees it (extracted from
 * backend/workers/proaimain.js; originally lia14GateTruth / lia14GateLine).
 *
 * In Auto mode a write tool ("door") returns a prepared plan plus a `_gate`: the
 * runner stops the turn on it, shows Yes / No above the input with the diff rows,
 * and runs nothing else in that step (every other call of the step is answered
 * "not run yet", see guards.js). The person's answer comes back on the next turn as
 * a `[gate_reply] {...}` message from the browser.
 *
 * What the person PRESSED comes from the browser; what HAPPENED comes from the write
 * layer. Apply consumes `lia:plan:{id}` and writes a journal row carrying `plan`; a
 * copy is a job (`lia:copyjob:{job}`). So: a journal row = done (with ITS created_id,
 * not the message's); a plan still in KV = NOT applied, whatever the message says.
 * Typed or pasted text cannot make the agent believe in an object that does not
 * exist, and the model is never the one that applies.
 *
 * In the web UI, Enter never answers a question that writes to Meta (a habitual
 * Enter must not spend money); Yes is a click or a deliberate key. A stricter rule -
 * a typed digit never applies a write - lives in a native client, not in this repo.
 */
export async function liaJournalRead(env, memberId) {
  if (!memberId) return [];
  try {
    const raw = await env.META_KV.get(`lia:journal:${memberId}`);
    const j = raw ? JSON.parse(raw) : [];
    return Array.isArray(j) ? j : [];
  } catch (_) { return []; }
}

export async function gateTruth(env, memberId, history) {
  const out = {};
  const replies = [];
  (history || []).forEach((m) => { if (m && m.role === "user" && typeof m.content === "string" && m.content.indexOf("[gate_reply]") === 0) {
    try { const g = JSON.parse(m.content.replace(/^\[gate_reply\]\s*/, "")); if (g && g.plan_id) replies.push(g); } catch (_) {} } });
  if (!replies.length || !env || !env.META_KV) return out;
  const journal = await liaJournalRead(env, memberId);
  for (const g of replies.slice(-12)) {
    const pid = String(g.plan_id); const t = { applied: false };
    if (/^undo:/.test(pid)) { const u = journal.find((e) => e && String(e.undo_of || "") === pid.slice(5)); out[pid] = u ? { applied: true, created_id: null } : { applied: false, pending: false }; continue; }
    const row = journal.find((e) => e && String(e.plan || "") === pid && !e.undo_of);
    if (row) { t.applied = true; t.created_id = row.created_id ? String(row.created_id) : null; out[pid] = t; continue; }
    if (g.job) {
      try { const job = await env.META_KV.get(`lia:copyjob:${String(g.job).replace(/[^a-zA-Z0-9-]/g, "")}`, "json");
        if (job && job.member === memberId && String(job.plan_id) === pid) {
          t.copy = job.done ? "done" : job.error ? "failed" : "running"; t.created_id = job.top_id ? String(job.top_id) : null;
          t.done_n = job.done_n || 0; t.total = job.total || 0; t.error = job.error || null; t.applied = !!job.done; out[pid] = t; continue; }
      } catch (_) {}
    }
    /* The journal is read
       through a cache of up to a minute; the per-plan key written at apply is never stale */
    try { const k = await env.META_KV.get(`lia:planapplied:${pid.replace(/[^a-zA-Z0-9-]/g, "")}`); if (k) { t.applied = true; t.created_id = /^\d+$/.test(k) ? k : (g.created_id ? String(g.created_id) : null); out[pid] = t; continue; } } catch (_) {}
    let pending = null; try { pending = await env.META_KV.get(`lia:plan:${pid}`); } catch (_) {}
    t.pending = !!pending; out[pid] = t;
  }
  return out;
}

export function gateLine(raw, t, what0) {
  let g = {}; try { g = JSON.parse(String(raw).replace(/^\[gate_reply\]\s*/, "")); } catch (_) { return null; }
  if (!g || typeof g !== "object" || Array.isArray(g)) return null;
  const what = (g.entity || "change") + (g.title ? " \u00ab" + g.title + "\u00bb" : "");
  t = t || {};
  if (g.answer === "no") return "(The person declined the " + what + " and will edit it themselves. Do not prepare it again; ask what to do next only if the task is unclear.)";
  if (t.copy === "running") return "(The person confirmed the " + what + ". The copy is still being made" + (t.total ? ": " + t.done_n + " of " + t.total + " parts so far" : "") + (t.created_id ? ", its top object is " + t.created_id : "") + ". Say it is still in progress; do not call it done and do not prepare it again.)";
  if (t.copy === "failed") return "(The person confirmed the " + what + " but the copy stopped partway: " + String(t.error || "").slice(0, 300) + ". " + (t.created_id ? "Its top object " + t.created_id + " exists with " + t.done_n + " of " + t.total + " parts. " : "") + "Explain it in one or two sentences and propose the fix.)";
  if (t.applied) return "(The person confirmed the " + what + ". It is done" + (t.created_id ? ": id " + t.created_id : "") + (what0 ? " - " + what0 + " (this is what changed: say it like that, never that nothing was needed)" : "") + ", paused unless it was a turn-on. This change is finished: say so in one sentence. A read now shows the new state - that is this change, not a sign it failed. Go on only with what else the person asked; never prepare this change again.)";
  if (g.answer === "error") return "(The person confirmed the " + what + " but it was refused: " + String(g.error || "").slice(0, 300) + ". Explain it in one or two sentences and propose the fix.)";
  if (t.pending) return "(The person was asked about the " + what + " but it was NOT applied: the plan is still waiting. Do not say it exists. Ask whether to apply it.)";
  return "(The person answered about the " + what + ", but Liaison has no record that it was applied. Do not say it exists; check with the read tools before going on.)";
}
