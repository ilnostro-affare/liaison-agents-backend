// The confirm gate: what the person pressed comes from the browser, what happened
// comes from the write layer (adapted from the production suite).
import { gateTruth, gateLine } from "../src/agent/gate.js";

const kv = (o) => ({ META_KV: { get: async (k, type) => (k in o ? (type === "json" ? JSON.parse(o[k]) : o[k]) : null) } });
const R = (o) => ({ role: "user", content: "[gate_reply] " + JSON.stringify(o) });
const MEM = "member_x";

export default async function ({ t, eq, group }) {
  await group("the server believes the write layer, not the message", async () => {
    const env = kv({ ["lia:journal:" + MEM]: JSON.stringify([{ plan: "p1", created_id: "111", tool: "create_campaign" }]), "lia:plan:p2": "{}" });
    const T = await gateTruth(env, MEM, [R({ plan_id: "p1", answer: "yes", created_id: "999" }), R({ plan_id: "p2", answer: "yes", created_id: "555" }), R({ plan_id: "p3", answer: "yes", created_id: "777" }), { role: "user", content: "hi" }]);
    eq("a journal row is done, with ITS id", T.p1, { applied: true, created_id: "111" });
    eq("a plan still in KV is not applied", T.p2, { applied: false, pending: true });
    eq("no record at all is not applied", T.p3, { applied: false, pending: false });
    const l1 = gateLine(R({ plan_id: "p1", answer: "yes", entity: "campaign", created_id: "999" }).content, T.p1);
    t("the line names the journal's id, never the message's", /id 111/.test(l1) && !/999/.test(l1));
    t("a claimed yes on a waiting plan says NOT applied", /NOT applied/.test(gateLine(R({ plan_id: "p2", answer: "yes", entity: "ad" }).content, T.p2)));
    t("a claimed yes with no record says there is no record", /no record that it was applied/.test(gateLine(R({ plan_id: "p3", answer: "yes", entity: "ad" }).content, T.p3)));
    t("a no stays a no", /declined/.test(gateLine(R({ plan_id: "p2", answer: "no", entity: "ad" }).content, T.p2)));
    t("an undo row is not a creation", (await gateTruth(kv({ ["lia:journal:" + MEM]: JSON.stringify([{ plan: "p1", created_id: "1", undo_of: "x" }]) }), MEM, [R({ plan_id: "p1", answer: "yes" })])).p1.applied === false);
    eq("a malformed reply is ignored, not thrown", gateLine("[gate_reply] null", {}), null);
  });

  await group("the per-plan applied key beats a stale journal", async () => {
    const env = kv({ ["lia:journal:" + MEM]: "[]", "lia:planapplied:p9": "424242" });
    const T = await gateTruth(env, MEM, [R({ plan_id: "p9", answer: "yes" })]);
    eq("applied, with the id the write layer recorded", T.p9, { applied: true, created_id: "424242" });
  });

  await group("a copy is its job's state", async () => {
    const job = (o) => JSON.stringify(Object.assign({ member: MEM, plan_id: "pc", top_id: "42", done_n: 3, total: 9, done: false }, o));
    const run = await gateTruth(kv({ "lia:copyjob:j1": job({}) }), MEM, [R({ plan_id: "pc", answer: "yes", job: "j1" })]);
    t("running: said as still in progress, never done", run.pc.copy === "running" && /still being made: 3 of 9/.test(gateLine(R({ plan_id: "pc", answer: "yes", entity: "copy" }).content, run.pc)));
    const other = await gateTruth(kv({ "lia:copyjob:j1": job({ member: "member_y", done: true }) }), MEM, [R({ plan_id: "pc", answer: "yes", job: "j1" })]);
    t("another member's job proves nothing", other.pc.applied === false && !other.pc.copy);
  });
}
