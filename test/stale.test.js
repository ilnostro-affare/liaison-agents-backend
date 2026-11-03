// Plan staleness: adapted from the production suite for the no-timer plans.
import { readFileSync } from "node:fs";
import { BW_PLAN_KEEP, BW_TTL, bwExpiry, bwPlanStaleFields, bwPlanIsEdit, bwPlanStaleCheck, bwStaleReply, bwPlanIndexPut, bwPlanSuspect, bwPlanCancelStale } from "../src/write/stale.js";
import { kvMock, captureLogs } from "./support/mocks.js";

export default async function ({ t, eq, group }) {
  await group("no timer: the reply shape keeps its fields, null", async () => {
    eq("bwExpiry answers ttl and expires_at, both null", bwExpiry(900), { ttl: null, expires_at: null });
    eq("plans are kept 30 days, for storage only", BW_PLAN_KEEP, 30 * 86400);
    eq("a refused write puts its plan back for what is left of those", BW_TTL, BW_PLAN_KEEP);
  });

  await group("the comparison: unchanged reads compare equal", async () => {
    const undo = {
      name: "Set A", status: "PAUSED", daily_budget: 5000, bid_strategy: undefined, spend_cap: 922337203685478,
      end_time: "2026-12-10T10:00:00+0100", pacing_type: ["standard"], adset_schedule: [],
      targeting: { geo_locations: { countries: ["IT"] }, age_min: 18, age_max: 65, flexible_spec: [{ interests: [{ id: "1", name: "x" }] }] },
      placement_soft_opt_out: { facebook_positions: [], instagram_positions: [] },
      special_ad_categories: [], bid_amount: null
    };
    const live = {
      id: "120000000000000001", name: "Set A", status: "PAUSED", daily_budget: "5000", spend_cap: "0",
      end_time: "2026-12-10T09:00:00+0000",                     // the same instant, another offset
      targeting: { age_max: 65, age_min: 18, flexible_spec: [{ interests: [{ name: "x", id: "1" }] }], geo_locations: { countries: ["IT"] } },
      special_ad_categories: ["NONE"]
    };
    eq("nothing changed -> nothing named", bwPlanStaleFields(undo, live), []);
  });

  await group("the comparison: each changed field is named", async () => {
    const undo = { daily_budget: 5000, status: "PAUSED", name: "A", targeting: { age_min: 18 }, end_time: null, pacing_type: ["standard"] };
    const ch = (live) => bwPlanStaleFields(undo, Object.assign({ daily_budget: "5000", status: "PAUSED", name: "A", targeting: { age_min: 18 } }, live)).map((c) => c.field);
    eq("a budget edited in Ads Manager", ch({ daily_budget: "6000" }), ["daily_budget"]);
    eq("a pause from elsewhere", ch({ status: "ACTIVE" }), ["status"]);
    eq("a rename", ch({ name: "B" }), ["name"]);
    eq("an audience edit", ch({ targeting: { age_min: 25 } }), ["targeting"]);
    eq("an end date set meanwhile", ch({ end_time: "2026-12-01T00:00:00+0000" }), ["end_time"]);
    eq("accelerated delivery switched on", ch({ pacing_type: ["no_pacing"] }), ["pacing_type"]);
    const row = bwPlanStaleFields(undo, { daily_budget: "6000", status: "PAUSED", name: "A", targeting: { age_min: 18 } })[0];
    eq("a scalar row carries both values and a label", [row.label, row.planned_from, row.now], ["Daily budget", "5000", "6000"]);
    const tg = bwPlanStaleFields(undo, { daily_budget: "5000", status: "PAUSED", name: "A", targeting: { age_min: 30 } })[0];
    t("an object row carries no values (no audience dumped into a refusal)", tg && !("now" in tg) && !("planned_from" in tg));
    eq("a field the plan never touched is never compared", bwPlanStaleFields({ name: "A" }, { name: "A", daily_budget: "1" }), []);
  });

  await group("which plans are checked", async () => {
    t("an edit", bwPlanIsEdit({ fields: { daily_budget: 1 }, undo: { daily_budget: 2 } }));
    t("an activation", bwPlanIsEdit({ fields: { status: "ACTIVE" }, undo: { status: "PAUSED" } }));
    t("not a copy", !bwPlanIsEdit({ fields: {}, undo: {}, copy: { deep: true } }));
    t("not a creation", !bwPlanIsEdit({ undo: {}, create_campaign: {} }) && !bwPlanIsEdit({ fields: {}, undo: {}, create_adset: {} }));
  });

  await group("the live read (Graph stubbed)", async () => {
    const orig = globalThis.fetch;
    try {
      const plan = { entity_id: "120000000000000001", undo: { daily_budget: 5000, name: "A", status: "PAUSED" } };
      const urls = [];
      globalThis.fetch = async (u) => { urls.push(String(u)); return { json: async () => ({ daily_budget: "7000", name: "A", status: "PAUSED" }) }; };
      const st = await bwPlanStaleCheck("tok", plan);
      eq("stale, with the field", [st.checked, st.stale, st.changed.map((c) => c.field)], [true, true, ["daily_budget"]]);
      t("one read, of exactly the plan's fields", urls.length === 1 && /\?fields=daily_budget,name,status&/.test(urls[0]), urls.join(" "));

      globalThis.fetch = async () => ({ json: async () => ({ daily_budget: "5000", name: "A", status: "PAUSED" }) });
      const ok = await bwPlanStaleCheck("tok", plan);
      eq("unchanged: checked, not stale", [ok.checked, ok.stale], [true, false]);

      let n = 0;
      globalThis.fetch = async (u) => { n++; return { json: async () => (/bid_amount/.test(String(u))
        ? { error: { message: "(#100) Tried accessing nonexisting field (bid_amount) on node type (Campaign)" } }
        : { daily_budget: "5000" }) }; };
      const rt = await bwPlanStaleCheck("tok", { entity_id: "120000000000000002", undo: { daily_budget: 5000, bid_amount: 10 } });
      eq("a field the node lacks is dropped and the read retried", [n, rt.checked, rt.stale], [2, true, false]);

      globalThis.fetch = async () => ({ json: async () => ({ error: { message: "Unsupported get request" } }) });
      const bad = await bwPlanStaleCheck("tok", plan);
      eq("a read that fails is not a refusal", [bad.checked, bad.stale, bad.reason], [false, false, "read_failed"]);
      globalThis.fetch = async () => { throw new Error("net"); };
      eq("nor is a network error", (await bwPlanStaleCheck("tok", plan)).stale, false);
      eq("a plan with nothing comparable reads nothing", (await bwPlanStaleCheck("tok", { entity_id: "120000000000000001", undo: { adset_budgets: [] } })).reason, "nothing_to_compare");
    } finally { globalThis.fetch = orig; }
  });

  await group("the refusal", async () => {
    const r = bwStaleReply({ entity_id: "1", entity_type: "ad_set", entity_name: "Set A", account: "9" }, "p1", [{ field: "daily_budget", label: "Daily budget" }], 5);
    eq("machine-readable", [r.ok, r.error, r.error_class, r.stale, r.cancelled, r.retryable], [false, "plan_stale", "plan_stale", true, true, false]);
    t("the person reads why", /^Cancelled: Meta changed since this plan was made\. Daily budget was changed on .Set A./.test(r.user_message) && r.user_msg === r.user_message);
    eq("stamped with the plan and the object", [r.plan_id, r.entity_id, r.entity_type, r.account], ["p1", "1", "ad_set", "9"]);
    eq("and no deadline", r.expires_at, null);
  });

  await group("cancel: the plan goes, its record stays", async () => {
    const kv = kvMock(); const env = { META_KV: kv };
    await kv.put("lia:plan:p1", "{}"); await kv.put("lia:planobj:9:1:p1", "1");
    await captureLogs(() => bwPlanCancelStale(env, "m1", "p1", { entity_id: "1", account: "9", entity_name: "A", diff: [] }, [{ field: "name" }], 7, "apply"));
    t("the plan key is deleted, so nothing can apply it", !kv.m.has("lia:plan:p1"));
    const rec = JSON.parse(kv.m.get("lia:planstale:p1").v);
    eq("its record names the member, the fields and that it is verified", [rec.member, rec.verified, rec.changed[0].field], ["m1", true, "name"]);
    eq("kept as long as a plan", kv.m.get("lia:planstale:p1").o.expirationTtl, 30 * 86400);
    t("and the object index forgets it", !kv.m.has("lia:planobj:9:1:p1"));
  });

  await group("proactive: Meta's feed marks suspects, never cancels", async () => {
    const kv = kvMock(); const env = { META_KV: kv };
    await kv.put("lia:plan:old", "{}"); await kv.put("lia:plan:new", "{}"); await kv.put("lia:plan:other", "{}");
    kv.m.set("lia:planobj:9:111:old", { v: "1", o: { metadata: { c: 1000 } } });
    kv.m.set("lia:planobj:9:111:new", { v: "1", o: { metadata: { c: 5000 } } });
    kv.m.set("lia:planobj:9:111:applied", { v: "1", o: { metadata: { c: 1000 } } });   // its lia:plan is gone
    kv.m.set("lia:planobj:9:222:other", { v: "1", o: { metadata: { c: 1000 } } });
    let n;
    await captureLogs(async () => { n = await bwPlanSuspect(env, "act_9", [{ id: "111", at: 3000, what: "update_ad_set_budget", src: "activity" }]); });
    eq("one plan marked", n, 1);
    const rec = kv.m.has("lia:planstale:old") ? JSON.parse(kv.m.get("lia:planstale:old").v) : null;
    eq("the plan made BEFORE the change, as an unverified suspect", rec && [rec.verified, rec.src, rec.at], [false, "activity", 3000]);
    t("a plan made after the change is left alone", !kv.m.has("lia:planstale:new"));
    t("a plan on another object is left alone", !kv.m.has("lia:planstale:other"));
    t("the plan itself is never deleted by a mark", kv.m.has("lia:plan:old"));
    t("an index key whose plan is gone is cleaned up", !kv.m.has("lia:planobj:9:111:applied"));
    await bwPlanIndexPut(env, "act_9", "333", "p9");
    const ix = kv.m.get("lia:planobj:9:333:p9");
    t("the index is one key per plan, under its account, birth in the metadata", ix && ix.o.metadata && ix.o.metadata.c > 0 && ix.o.expirationTtl === 30 * 86400);
  });

  await group("the wiring in apply.js (by position)", async () => {
    const src = readFileSync(new URL("../src/write/apply.js", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const a = code.indexOf("export async function handleApply");
    const check = code.indexOf("const _st = await bwPlanStaleCheck(t.token, plan);", a);
    const consume = code.indexOf("await env.META_KV.delete(`lia:plan:${plan_id}`);", a);
    const graph = code.indexOf('form.set("access_token", t.token);', a);
    t("all landmarks found", a > -1 && check > -1 && consume > -1 && graph > -1);
    t("the check runs before the plan is consumed", check < consume);
    t("and so before anything is sent to Meta", check < graph && consume < graph);
  });
}
