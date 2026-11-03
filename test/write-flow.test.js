// The write path end to end against an in-memory KV and a simulated Graph API:
// plan -> (explicit Yes) apply -> journal -> undo, staleness, born-PAUSED copies.
import { handleBuildWrite } from "../src/write/router.js";
import { kvMock, captureLogs } from "./support/mocks.js";

const MEMBER = "member_test_1";
const ADSET = "120000000000000101";
const CAMP = "120000000000000100";
const AD = "120000000000000102";
const ACCT = "1000000001";

// A tiny Graph: objects by id, reads by ?fields=, writes by POST form, /copies, batch.
function graphSim() {
  const objs = {
    [CAMP]: { id: CAMP, name: "Campaign A", status: "ACTIVE", effective_status: "ACTIVE", account_id: ACCT, daily_budget: "0" },
    [ADSET]: { id: ADSET, name: "Set A", status: "ACTIVE", effective_status: "ACTIVE", campaign_id: CAMP, account_id: ACCT, daily_budget: "5000" },
    [AD]: { id: AD, name: "Ad A", status: "ACTIVE", effective_status: "ACTIVE", adset_id: ADSET, campaign_id: CAMP, account_id: ACCT, creative: { id: "900" } }
  };
  const posts = [];
  let nextId = 130000000000000000;
  const pick = (o, fields) => { const out = { id: o.id }; String(fields || "").split(",").forEach((f) => { const k = f.replace(/\{.*$/, ""); if (k in o) out[k] = o[k]; }); return out; };
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const parts = u.pathname.split("/").filter(Boolean);   // [v26.0, id, edge?]
    const reply = (x) => ({ ok: true, status: 200, headers: new Headers(), json: async () => x, text: async () => JSON.stringify(x) });
    if ((init.method || "GET") === "POST") {
      const form = Object.fromEntries(init.body);
      posts.push({ path: u.pathname, form });
      if (parts.length === 1) {   // batch
        const batch = JSON.parse(form.batch);
        return reply(batch.map((b) => { const [id, q] = b.relative_url.split("?"); const o = objs[id]; const f = new URLSearchParams(q || "").get("fields");
          return o ? { code: 200, body: JSON.stringify(pick(o, f)) } : { code: 404, body: JSON.stringify({ error: { message: "does not exist" } }) }; }));
      }
      const id = parts[1], edge = parts[2];
      if (edge === "copies" || edge === "ads") {
        const nid = String(++nextId);
        objs[nid] = { id: nid, name: form.name || "copy", status: form.status || form.status_option, account_id: ACCT };
        return reply(edge === "copies" ? { copied_adset_id: nid } : { id: nid });
      }
      if (!objs[id]) return reply({ error: { message: "does not exist", code: 100 } });
      if (form.daily_budget === "1") return reply({ error: { message: "Budget too low", code: 100, error_user_msg: "Your budget is too low." } });
      Object.keys(form).forEach((k) => { if (k !== "access_token") objs[id][k] = form[k]; });
      if (form.status) objs[id].effective_status = form.status;
      return reply({ success: true });
    }
    if (parts[1] && parts[1].startsWith("act_")) return reply({ currency: "EUR", timezone_name: "Europe/Rome" });
    const o = objs[parts[1]];
    if (!o) return reply({ error: { message: "Unsupported get request" } });
    return reply(pick(o, u.searchParams.get("fields")));
  };
  return { objs, posts, fetch };
}

const call = async (env, path, body, headers = {}) => {
  const req = new Request(`https://api.example.com${path}?member_id=${MEMBER}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  let res; await captureLogs(async () => { res = await handleBuildWrite(req, env, new URL(req.url), path); });
  return { status: res.status, body: await res.json() };
};
const journalOf = async (env) => JSON.parse((await env.META_KV.get(`lia:journal:${MEMBER}`)) || "[]");

export default async function ({ t, eq, group }) {
  const orig = globalThis.fetch;
  const fresh = () => {
    const g = graphSim(); globalThis.fetch = g.fetch;
    const kv = kvMock({ [`member:${MEMBER}:fb`]: "fb1", "fbtoken:fb1": JSON.stringify({ access_token: "TEST_TOKEN" }) });
    return { g, env: { META_KV: kv } };
  };
  try {
    await group("plan mutates nothing", async () => {
      const { g, env } = fresh();
      const p = await call(env, "/meta/write/plan", { tool: "update_entity", entity_id: ADSET, entity_type: "ad_set", changes: { status: "PAUSED" } });
      t("a plan is returned", p.body.ok && !!p.body.plan_id);
      eq("its diff", p.body.diff.map((d) => [d.kind, d.old, d.new]), [["paused", "ACTIVE", "PAUSED"]]);
      eq("no countdown", [p.body.ttl, p.body.expires_at], [null, null]);
      eq("nothing was written to Meta (only the batch read for the path)", g.posts.filter((x) => x.path !== "/v26.0/").length, 0);
      const stored = JSON.parse(await env.META_KV.get(`lia:plan:${p.body.plan_id}`));
      eq("the plan records the undo", stored.undo, { status: "ACTIVE" });
      t("and is indexed under its account for the staleness feed", [...env.META_KV.m.keys()].some((k) => k === `lia:planobj:${ACCT}:${ADSET}:${p.body.plan_id}`));
    });

    await group("apply: consume, write, journal", async () => {
      const { g, env } = fresh();
      const p = await call(env, "/meta/write/plan", { tool: "update_entity", entity_id: ADSET, entity_type: "ad_set", changes: { status: "PAUSED", daily_budget: 70 } });
      const a = await call(env, "/meta/write/apply", { plan_id: p.body.plan_id, session_id: "chat1" });
      t("applied", a.status === 200 && a.body.ok, JSON.stringify(a.body));
      const w = g.posts.find((x) => x.path === `/v26.0/${ADSET}`);
      eq("Meta got exactly the plan's fields, budget in minor units", w && [w.form.status, w.form.daily_budget], ["PAUSED", "7000"]);
      t("the plan key is gone", !(await env.META_KV.get(`lia:plan:${p.body.plan_id}`)));
      const j = await journalOf(env);
      eq("one journal row with the diff and the undo", [j.length, j[0].plan, j[0].undo], [1, p.body.plan_id, { status: "ACTIVE", daily_budget: 5000 }]);
      t("the per-plan applied key exists", (await env.META_KV.get(`lia:planapplied:${p.body.plan_id}`)) === "applied");
      const again = await call(env, "/meta/write/apply", { plan_id: p.body.plan_id });
      eq("a second press cannot apply twice", [again.status, again.body.ok], [410, false]);
    });

    await group("another member's plan is refused", async () => {
      const { env } = fresh();
      const p = await call(env, "/meta/write/plan", { tool: "update_entity", entity_id: ADSET, entity_type: "ad_set", changes: { name: "Renamed" } });
      const plan = JSON.parse(await env.META_KV.get(`lia:plan:${p.body.plan_id}`)); plan.member = "someone_else";
      await env.META_KV.put(`lia:plan:${p.body.plan_id}`, JSON.stringify(plan));
      const a = await call(env, "/meta/write/apply", { plan_id: p.body.plan_id });
      eq("403", a.status, 403);
    });

    await group("staleness: Meta moved, the plan is cancelled, nothing is sent", async () => {
      const { g, env } = fresh();
      const p = await call(env, "/meta/write/plan", { tool: "update_entity", entity_id: ADSET, entity_type: "ad_set", changes: { daily_budget: 80 } });
      g.objs[ADSET].daily_budget = "6500";   // edited in Ads Manager meanwhile
      const a = await call(env, "/meta/write/apply", { plan_id: p.body.plan_id });
      eq("409 plan_stale naming the field", [a.status, a.body.error, a.body.changed_fields.map((c) => c.field)], [409, "plan_stale", ["daily_budget"]]);
      eq("no write reached Meta", g.posts.filter((x) => x.path === `/v26.0/${ADSET}`).length, 0);
      const st = await call(env, "/meta/write/plan-state", { plan_id: p.body.plan_id });
      eq("plan-state says stale", st.body.plan.state, "stale");
      const again = await call(env, "/meta/write/apply", { plan_id: p.body.plan_id });
      eq("pressed again, it still says why (not 'expired')", [again.status, again.body.error], [409, "plan_stale"]);
    });

    await group("a refused write puts the plan back", async () => {
      const { env } = fresh();
      const p = await call(env, "/meta/write/plan", { tool: "update_entity", entity_id: ADSET, entity_type: "ad_set", changes: { daily_budget: 0.01 } });
      const a = await call(env, "/meta/write/apply", { plan_id: p.body.plan_id });
      eq("Meta's own words come back", [a.status, a.body.error], [502, "Your budget is too low."]);
      t("the plan is usable again", !!(await env.META_KV.get(`lia:plan:${p.body.plan_id}`)));
      eq("and nothing was journalled", (await journalOf(env)).length, 0);
    });

    await group("turning on is its own plan", async () => {
      const { env } = fresh();
      const p = await call(env, "/meta/write/plan", { tool: "update_entity", entity_id: ADSET, entity_type: "ad_set", changes: { status: "PAUSED" } });
      await call(env, "/meta/write/apply", { plan_id: p.body.plan_id });
      const on = await call(env, "/meta/write/plan", { tool: "update_entity", entity_id: ADSET, entity_type: "ad_set", changes: { status: "ACTIVE" } });
      eq("ACTIVE through a plain update is refused", [on.status, on.body.error_class], [400, "use_activate"]);
      const forged = await call(env, "/meta/write/plan", { tool: "update_entity", entity_id: ADSET, entity_type: "ad_set", changes: { status: "ACTIVE" }, undo_of: "x" });
      eq("a forged undo_of without the isolate's header is stripped", forged.body.error_class, "use_activate");
      const act = await call(env, "/meta/write/plan", { tool: "activate_entity", entity_id: ADSET, entity_type: "ad_set" });
      t("activate_entity prepares it, with its own note", act.body.ok && /own confirm/.test(act.body.note));
    });

    await group("undo is a second write, confirmed like any other", async () => {
      const { g, env } = fresh();
      const p = await call(env, "/meta/write/plan", { tool: "update_entity", entity_id: ADSET, entity_type: "ad_set", changes: { status: "PAUSED" } });
      await call(env, "/meta/write/apply", { plan_id: p.body.plan_id });
      const row = (await journalOf(env))[0];
      const u = await call(env, "/meta/write/undo", { journal_id: row.id });
      t("undo mints a reverse PLAN (not a direct write)", u.body.ok && !!u.body.plan_id && g.objs[ADSET].status === "PAUSED");
      eq("the reverse diff", u.body.diff.map((d) => [d.old, d.new]), [["PAUSED", "ACTIVE"]]);
      await call(env, "/meta/write/apply", { plan_id: u.body.plan_id });
      eq("after its Yes, Meta has it back", g.objs[ADSET].status, "ACTIVE");
      const j = await journalOf(env);
      eq("the undo row points at the row it reverses", j[0].undo_of, row.id);
      const u2 = await call(env, "/meta/write/undo", { journal_id: row.id });
      eq("a row cannot be undone twice", [u2.status, u2.body.error_class], [409, "undone"]);
    });

    await group("undo refuses when the world moved", async () => {
      const { g, env } = fresh();
      const p = await call(env, "/meta/write/plan", { tool: "update_entity", entity_id: ADSET, entity_type: "ad_set", changes: { status: "PAUSED" } });
      await call(env, "/meta/write/apply", { plan_id: p.body.plan_id });
      const row = (await journalOf(env))[0];
      await env.META_KV.delete(`lia:fresh:${MEMBER}:${ADSET}`);   // our own overlay expired
      g.objs[ADSET].status = "ARCHIVED";                          // someone changed it in Ads Manager
      const u = await call(env, "/meta/write/undo", { journal_id: row.id });
      eq("changed outside Liaison", [u.status, u.body.error_class], [409, "changed_outside"]);
    });

    await group("copies are born PAUSED", async () => {
      const { g, env } = fresh();
      const p = await call(env, "/meta/write/plan", { tool: "copy_entity", entity_id: AD, entity_type: "ad" });
      t("the card says it", /PAUSED/.test(p.body.note));
      await call(env, "/meta/write/apply", { plan_id: p.body.plan_id, overrides: { name: "Ad A v2" } });
      const w = g.posts.find((x) => x.path === `/v26.0/act_${ACCT}/ads`);
      eq("the create call carries status PAUSED and the person's name", w && [w.form.status, w.form.name, w.form.source_ad_id], ["PAUSED", "Ad A v2", AD]);
      const p2 = await call(env, "/meta/write/plan", { tool: "copy_entity", entity_id: ADSET, entity_type: "ad_set" });
      const a2 = await call(env, "/meta/write/apply", { plan_id: p2.body.plan_id });
      const w2 = g.posts.find((x) => x.path === `/v26.0/${ADSET}/copies`);
      eq("an ad set copy uses status_option PAUSED", w2 && w2.form.status_option, "PAUSED");
      t("and becomes a polled job", a2.body.pending === true && !!a2.body.job);
    });
  } finally { globalThis.fetch = orig; }
}
