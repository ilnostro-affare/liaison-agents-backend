// The runner's guards and the LIA_CALL line.
import { checkCall, LIA_TOOL_TURN_CAP } from "../src/agent/guards.js";
import { makeCallLogger, chatDoneLine, CALL_KINDS } from "../src/agent/call-log.js";

const ents = {
  "120000000000000201": { n: "Retargeting", k: "ad_set", p: "Spring sale" },
  "120000000000000202": { n: "Retargeting", k: "ad_set", p: "Autumn sale" },
  "120000000000000203": { n: "Lookalike", k: "ad_set", p: "Spring sale" },
  "120000000000000200": { n: "Spring sale", k: "campaign" }
};
const fresh = (o = {}) => Object.assign({ ask: null, gate: null, seenExact: {}, seenTools: {}, offered: new Set(["find_entity", "plan_update_entity", "plan_create_ad_set"]),
  mode: "build", entMap: ents, userText: "pause the ad set", turnResolved: {} }, o);
const C = (name, args) => ({ name, args: JSON.stringify(args) });

export default async function ({ t, eq, group }) {
  await group("one change per step", async () => {
    const r = checkCall(fresh({ gate: { tool: "plan_update_entity" } }), C("find_entity", { query: "x" }));
    eq("held behind an open Yes/No", [r.kind, r.result.not_run, r.result.available], ["not_run", true, true]);
  });
  await group("the menu is the kitchen", async () => {
    const r = checkCall(fresh({ mode: "home" }), C("plan_copy_entity", {}));
    t("a tool the turn did not offer is refused by name, read-only said", r.kind === "not_offered" && /READ-ONLY/.test(r.error));
  });
  await group("ids", async () => {
    eq("an id no tool returned is refused", checkCall(fresh(), C("plan_update_entity", { entity_id: "120000000000000999", entity_type: "ad_set" })).kind, "refused_unknown_id");
    const d = checkCall(fresh(), C("plan_update_entity", { entity_id: "120000000000000201", entity_type: "ad_set" }));
    t("a name shared by two ad sets is refused, every match listed", d.kind === "refused_duplicate" && /120000000000000202 in .Autumn sale./.test(d.error));
    t("unless the person named the parent", checkCall(fresh({ userText: "pause retargeting in spring sale" }), C("plan_update_entity", { entity_id: "120000000000000201" })) === null);
    t("or find_entity resolved it this turn", checkCall(fresh({ turnResolved: { "120000000000000201": true } }), C("plan_update_entity", { entity_id: "120000000000000201" })) === null);
    t("a unique name passes", checkCall(fresh(), C("plan_update_entity", { entity_id: "120000000000000203" })) === null);
    eq("campaign_id must be a campaign", checkCall(fresh(), C("plan_create_ad_set", { campaign_id: "120000000000000203" })).kind, "refused_guard");
  });
  await group("repeats", async () => {
    const s = fresh();
    t("first call runs", checkCall(s, C("find_entity", { query: "a" })) === null);
    t("the exact same call is answered from above, not run", /already called find_entity this turn with these exact arguments/.test(checkCall(s, C("find_entity", { query: "a" })).result.note));
    const s2 = fresh();
    for (let i = 0; i < LIA_TOOL_TURN_CAP; i++) checkCall(s2, C("find_entity", { query: "q" + i }));
    t("past the cap a new call is NOT RUN and says so", /^NOT RUN: find_entity was already called 8 times/.test(checkCall(s2, C("find_entity", { query: "z", account: "1" })).result.note));
    const s3 = fresh();
    checkCall(s3, C("plan_update_entity", { entity_id: "120000000000000999" }));
    t("a refused call is un-registered, so it can be retried once fixed", !s3.seenExact['plan_update_entity|{"entity_id":"120000000000000999"}'] && !s3.seenTools.plan_update_entity);
  });
  await group("LIA_CALL", async () => {
    const lines = [];
    const L = makeCallLogger({ reqId: "r1", chatId: "c1", memberId: "m1", mode: "build", rmode: "auto", model: "model-x", log: (l) => lines.push(l) });
    L.start("a1"); L.log("a1", "get_campaigns", null, "ran", { caller: "direct", door: false, gate: false });
    L.log(null, "plan_update_entity", "Refused: id 1 was not returned".padEnd(400, "."), "refused_unknown_id");
    const a = JSON.parse(lines[0].slice(lines[0].indexOf("{"))), b = JSON.parse(lines[1].slice(lines[1].indexOf("{")));
    eq("the fields of a run call", Object.keys(a), ["reqId", "chat", "member", "mode", "rmode", "model", "tool", "kind", "ok", "ms", "error", "caller", "door", "gate"]);
    t("ok and kind", a.ok === true && a.kind === "ran" && b.ok === false && b.kind === "refused_unknown_id");
    eq("the error is cut to 200 characters", b.error.length, 200);
    t("no arguments in the line", !/entity_id|args/.test(lines.join("\n")));
    eq("seven kinds", CALL_KINDS.length, 7);
    const done = JSON.parse(chatDoneLine({ reqId: "r1", gate: { tool: "plan_update_entity" }, tools: 3, writes: 1, hops: 2 }).slice(14));
    eq("LIA_CHAT_DONE says why the turn stopped", done.stop, "gate:plan_update_entity");
  });
}
