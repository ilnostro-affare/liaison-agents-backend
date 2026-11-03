/**
 * The runner's guards on each tool call the model makes
 * (extracted from the tool loop in backend/workers/proaimain.js).
 *
 * In production these are inline in one loop over the model's calls; here each is
 * a function and `checkCall` runs them in the production order. Every refusal is a
 * tool RESULT the model reads (so it can correct itself in the same turn) and one
 * LIA_CALL line with its kind. A refused call is un-registered from the repeat
 * counters: it was refused, not executed, so the model may retry it once fixed.
 *
 * The rule behind all of them: the prompt asks nicely, the runner enforces. Each
 * guard exists because a model did the thing in a real conversation - called a
 * tool the turn had not offered because an earlier turn used it, typed an id from
 * memory, picked one of several same-named ad sets, re-ran the same read in a loop.
 */
export const LIA_TOOL_TURN_CAP = 8;

/** One change per step: while a change waits for the person's Yes / No, every other
 *  call of the step is answered "not run YET" (and the model is told it is available
 *  after the answer - a model told "not run" otherwise reads it as "unavailable"). */
export function heldByGate(state) {
  if (state.ask) return { kind: "not_run", error: "not run: a question waits for the person's answer",
    result: { ok: false, not_run: true, available: true, note: "Not run YET: your question waits for the person's answer. After it, call this again - it is available." } };
  if (state.gate) return { kind: "not_run", error: "not run: a change waits for the person's answer",
    result: { ok: false, not_run: true, available: true, note: "Not run YET - nothing is wrong with this tool. One change per step: the change prepared above waits for the person's answer. After the answer, call this again (with the id the answer gives) - it is available." } };
  return null;
}

/** The exact same tool+arguments again in one turn, or one tool past the cap. */
export function repeatBlock(state, name, rawArgs) {
  const exactKey = name + "|" + (rawArgs || "");
  if (state.seenExact[exactKey]) {
    return { result: { ok: false, stop: true, note: "You already called " + name + " this turn with these exact arguments. Its result is already above in this conversation. Do NOT call it again - use the result you already have and ANSWER the user now. If the result was ambiguous, ASK the user instead of re-querying." } };
  }
  if ((state.seenTools[name] || 0) >= LIA_TOOL_TURN_CAP) {
    let a0 = {}; try { a0 = JSON.parse(rawArgs || "{}"); } catch (_) {}
    const what = ["account", "from", "to", "campaign", "ad_set_id", "ad_id"].filter((k) => a0[k]).map((k) => k + " " + a0[k]).join(", ");
    return { result: { ok: false, stop: true, not_run: true,
      note: "NOT RUN: " + name + " was already called " + LIA_TOOL_TURN_CAP + " times this turn, which is the limit" + (what ? ". This call (" + what + ") was not executed and returned no data" : "") + ". Do NOT present this as a loading failure or as zero. Answer from the results you have, and say plainly which part you did not read this turn." } };
  }
  return null;
}

/** The tool the model CALLED has to be a tool this turn OFFERED. The menu and the
 *  kitchen were separate: the schemas decided what was advertised and nothing decided
 *  what was executed. The refusal names the mode rather than "unknown tool": a model
 *  told "unknown" retries a guessed spelling, a model told "read-only" stops. */
export function notOfferedBlock(offered, name, mode) {
  if (offered.has(name)) return null;
  return "Refused: `" + name + "` was not offered in this turn."
    + (mode === "home"
      ? " This turn is READ-ONLY: no tool that changes anything is available. Do not try another spelling and do not promise the change - tell the person the change has to be started from the build surface."
      : " Use one of the tools in this turn's list; never call a tool because an earlier turn used it.");
}

/** ids a write call names. */
export function writeIds(args) {
  return [args && args.entity_id, args && args.ad_set_id, args && args.creative_id, args && args.template_ad_set_id, args && args.campaign_id, args && args.scope_id]
    .filter(v => v != null && v !== "").map(String);
}

/** campaign_id must BE a campaign. The chat's entity map knows every id's kind. */
export function campaignKindBlock(entMap, name, args) {
  if (name !== "plan_create_ad_set" || !args || !args.campaign_id) return null;
  const ck = entMap[String(args.campaign_id)];
  if (ck && ck.k && ck.k !== "campaign") {
    return `Refused: campaign_id ${args.campaign_id} is a ${ck.k} named «${ck.n}», not a campaign. Omit campaign_id to use the template's own campaign, or resolve the real campaign with find_entity.`;
  }
  return null;
}

/** Namesake gate: the id is known, but is its NAME unique in this chat? A plan may
 *  only proceed when the pick is not a coin flip: the user typed the id, named the
 *  parent, or find_entity resolved it in THIS turn. */
export function namesakeBlock(entMap, ids, userText, turnResolved) {
  const uTxt = String(userText || "").toLowerCase();
  for (const v of ids) {
    const me = entMap[v]; if (!me || !me.n) continue;
    const twins = Object.entries(entMap).filter(([id2, e2]) => id2 !== v && e2 && String(e2.n || "").toLowerCase() === String(me.n).toLowerCase());
    if (!twins.length) continue;                       // unique name: nothing to guard
    if (turnResolved[v]) continue;                     // find_entity resolved it this turn
    if (uTxt.includes(String(v))) continue;            // the user typed the id
    const par = me.p ? String(me.p).toLowerCase() : "";
    if (par && uTxt.includes(par)) continue;           // the user named its campaign
    const list = [[v, me]].concat(twins)
      .map(([id2, e2]) => `${id2}${e2.p ? ` in «${e2.p}»` : " (campaign unknown)"}`).join("; ");
    return `Refused: «${me.n}» matches ${twins.length + 1} different entities in this chat (${list}) and their wording alone does not pin one. Call find_entity for that name NOW (add kind/status filters that mirror the user's words). If the user's latest message already picks one, RETRY the plan in THIS turn with the id find_entity confirms; do not ask again. Only if it is still genuinely ambiguous, show every match and ask.`;
  }
  return null;
}

/** A write id must have appeared in a tool result of THIS chat (the entity map, fed
 *  live during the loop). Otherwise the model typed it from memory. */
export function unknownIdBlock(entMap, ids) {
  const unknown = ids.filter(v => !entMap[v]);
  if (!unknown.length) return null;
  return "Refused: id " + unknown.join(", ") + " was not returned by any tool in this chat. NEVER type an id from memory. Call find_entity (or list_creatives for a creative) NOW, copy the exact id from its response, and only then plan. If several entities share the user's wording, list them and ask.";
}

/**
 * All guards in the production order for one call c = { name, args (raw JSON string) }.
 * state: { ask, gate, seenExact, seenTools, offered:Set, mode, entMap, userText, turnResolved }
 * -> null (run it) | { kind, error?, result }   (kind undefined = answered without a LIA_CALL "refused" kind)
 */
export function checkCall(state, c) {
  const held = heldByGate(state);
  if (held) return held;
  const rep = repeatBlock(state, c.name, c.args);
  if (rep) return rep;
  state.seenExact[c.name + "|" + (c.args || "")] = true;
  state.seenTools[c.name] = (state.seenTools[c.name] || 0) + 1;
  const unregister = () => {
    delete state.seenExact[c.name + "|" + (c.args || "")];   // refused, not executed
    state.seenTools[c.name] = Math.max(0, (state.seenTools[c.name] || 1) - 1);
  };
  const off = notOfferedBlock(state.offered, c.name, state.mode);
  if (off) { unregister(); return { kind: "not_offered", error: off, result: { error: off } }; }
  let args = {}; try { args = JSON.parse(c.args || "{}"); } catch (_) {}
  if (c.name.startsWith("plan_")) {
    const kindMsg = campaignKindBlock(state.entMap, c.name, args);
    if (kindMsg) { unregister(); return { kind: "refused_guard", error: kindMsg, result: { error: kindMsg } }; }
    const ids = writeIds(args);
    const dup = namesakeBlock(state.entMap, ids, state.userText, state.turnResolved || {});
    if (dup) { unregister(); return { kind: "refused_duplicate", error: dup, result: { error: dup } }; }
    const unk = unknownIdBlock(state.entMap, ids);
    if (unk) { unregister(); return { kind: "refused_unknown_id", error: unk, result: { error: unk } }; }
  }
  return null;
}
