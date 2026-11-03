/**
 * Per-tool-call logs of the agent runner (extracted from backend/workers/proaimain.js).
 *
 * ONE `LIA_CALL` line per tool call, whatever path the call took, so a turn can be
 * read call by call and a set of test dialogues can be scored (right tool,
 * failures, time). No arguments and no person data: the tool, the outcome, the
 * time, the error's first 200 characters.
 *
 *   kind   ran                 executed (with caller: direct | program, door, gate)
 *          not_run             held: a change (or a question) waits for the person
 *          not_offered         the model called a tool this turn did not offer
 *          refused_guard       a runner guard refused the arguments
 *          refused_duplicate   the id's NAME matches several objects in this chat
 *          refused_unknown_id  the id never appeared in a tool result of this chat
 *          refused_program     a script/program guard refused it
 *
 * `LIA_CHAT_DONE` is one line per turn: model, effort, latency split, tokens
 * (in / out / reasoning / cached / cache-write), tool and write counts, hops and the
 * reason the turn stopped (`gate:<tool>`, `ask:<field>`, `plan:<n>`).
 *
 * In the original both are closures inside the runner; here they are factories so
 * they can be unit-tested. The field names and order are the production ones.
 * Read back with tools/calls.sh (Workers Observability API -> tools/calls.py).
 */
export const CALL_KINDS = ["ran", "not_run", "not_offered", "refused_guard", "refused_duplicate", "refused_unknown_id", "refused_program"];

/** ctx: { reqId, chatId, memberId, mode, rmode, model, log? } -> { start(actId), log(actId, tool, err, kind, extra), toolMs() } */
export function makeCallLogger(ctx) {
  const out = ctx.log || ((line) => console.log(line));
  const callT = {};
  let toolMs = 0;
  return {
    start(actId) { callT[actId] = Date.now(); },   // timed from act_start
    log(actId, tool, err, kind, extra) {
      try { if (actId && callT[actId]) toolMs += Date.now() - callT[actId]; } catch (_) {}
      try {
        out("LIA_CALL " + JSON.stringify(Object.assign({ reqId: ctx.reqId, chat: ctx.chatId, member: ctx.memberId, mode: ctx.mode, rmode: ctx.rmode || null, model: ctx.model, tool, kind, ok: !err,
          ms: actId && callT[actId] ? Date.now() - callT[actId] : 0, error: err ? String(err).slice(0, 200) : null }, extra || {})));
      } catch (_) {}
    },
    toolMs() { return toolMs; }
  };
}

/** The end-of-turn line. t: the runner's counters for the turn. */
export function chatDoneLine(t) {
  return "LIA_CHAT_DONE " + JSON.stringify({ reqId: t.reqId, member: t.memberId, chat: t.chatId, model: t.model, effort: t.effort, effort_applied: t.effortApplied,
    ms: t.ms, tokens_in: t.tokensIn, tokens_out: t.tokensOut, reasoning: t.reasoning, cache_write: t.cacheWrite, cached: t.cached, tools: t.tools,
    first_text_ms: t.firstTextMs || null, first_act_ms: t.firstActMs || null, tool_ms: t.toolMs, hops: t.hops, writes: t.writes,
    rmode: t.rmode || null, stop: t.ask ? "ask:" + t.ask.field : t.gate ? "gate:" + (t.gate.tool || "") : t.planN ? "plan:" + t.planN : null });
}
