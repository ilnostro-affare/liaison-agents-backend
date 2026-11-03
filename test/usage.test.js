// The usage meter: pure windows, and the Durable Object as the single writer
// (adapted from the production suite; agents and plans generalised).
import { usageApply, usageRoll, usageCheck, usageReserve, usageRelease, usageOnce, usageWeekStart, USAGE_H } from "../src/usage/usage-windows.js";
import { UsageMeter, usageBookCall } from "../src/usage/usage-meter.js";

const H = { hours: 5, weekMs: 7 * 86400e3, weekStart: (t0) => t0 - 1000 };
const T0 = Date.UTC(2026, 9, 16, 10, 0, 0);

export default async function ({ t, eq, group }) {
  await group("the windows", async () => {
    let s = usageApply(null, { cost: 0.3, tin: 10, tout: 5, tools: 1, agent: "assistant" }, T0, H);
    s = usageApply(s, { cost: 0.5, tin: 100, tout: 50, tools: 3, agent: "builder" }, T0 + 60e3, H);
    t("a charge lands in the session, the week and the month", s.sess.cost_usd === 0.8 && s.week.cost_usd === 0.8 && s.month.cost_usd === 0.8 && s.month.key === "2026-10");
    t("the agents' shares", s.ags.agents.assistant === 0.3 && s.ags.agents.builder === 0.5 && s.agw.agents.builder === 0.5);
    const a = usageApply(s, { kind: "agent", agent: "other", cost: 0.1 }, T0 + 2 * 60e3, H);
    t("a share alone adds no money to the windows", a.sess.cost_usd === 0.8 && a.ags.agents.other === 0.1);
    const later = usageRoll(s, T0 + 6 * 3600e3, H);
    t("a session past its hours starts again; the week and month go on", later.sess === null && later.ags === null && later.week.cost_usd === 0.8 && later.month.cost_usd === 0.8);
    t("a new month starts again", usageRoll(s, Date.UTC(2026, 10, 1, 0, 1), H).month === null);
    const wk = usageRoll({ week: { start: T0, cost_usd: 3 } }, T0 + 15 * 86400e3, H);
    t("a week rolls forward in whole cycles from its anchor", wk.week.start === T0 + 14 * 86400e3 && wk.week.cost_usd === 0);
    eq("the week anchors to the last 05:00 UTC", new Date(usageWeekStart(Date.UTC(2026, 9, 16, 3, 0))).toISOString(), "2026-10-15T05:00:00.000Z");
  });

  await group("the cap check", async () => {
    const tot = { session: 1.6, weekly: 4, monthly: 16 };
    const st = (c, m) => ({ sess: { start: T0, cost_usd: c }, week: { start: T0 - 1000, cost_usd: c }, month: { key: "2026-10", cost_usd: m == null ? c : m } });
    const ok = usageCheck(st(0.9), T0, H, tot);
    t("what is left, the tightest window", ok.ok && Math.round(ok.left_usd * 100) === 70);
    eq("the session stops it", usageCheck(st(1.7), T0, H, tot).error, "limit_session");
    eq("the month too", usageCheck(st(0.1, 16.5), T0, H, tot).error, "limit_monthly");
    t("no cap is no cap", usageCheck(st(100), T0, H, {}).ok);
  });

  await group("reservations and idempotent bookings", async () => {
    const tot = { session: 1, weekly: 10, monthly: 10 };
    const r = usageReserve({ sess: { start: T0, cost_usd: 0.2 }, week: { start: T0 - 1, cost_usd: 0.2 }, month: { key: "2026-10", cost_usd: 0.2 } }, T0, H, { id: "b1", tot, est: 0.3, want: 5 });
    eq("only what fits is held", [r.res.ok, r.res.fit, r.res.held], [true, 2, 0.6]);
    eq("and the hold counts as spent", usageCheck(r.st, T0, H, tot).left_usd.toFixed(2), "0.20");
    const r2 = usageReserve(r.st, T0, H, { id: "b2", tot, est: 0.3, want: 5 });
    eq("a second batch sees only what is left (one item may overrun, as a single call can)", r2.res.fit, 1);
    const r3 = usageReserve(r2.st, T0, H, { id: "b3", tot, est: 0.3, want: 5 });
    eq("and once the holds use it all, a third gets nothing", [r3.res.ok, r3.res.error], [false, "limit_session"]);
    t("released, the money is back", usageCheck(usageRelease(r.st, T0, "b1"), T0, H, tot).left_usd > 0.7);
    t("a hold expires on its own", usageCheck(r.st, T0 + 11 * 60e3, H, tot).left_usd > 0.7);
    const o1 = usageOnce({}, T0, "call-1"), o2 = usageOnce(o1.st, T0 + 1, "call-1");
    t("one provider call id books once", o1.dup === false && o2.dup === true);
  });

  // The object, with a storage and a KV, its calls queued the way a Durable Object runs them.
  const kv = new Map();
  const KV = { get: async (k, ty) => { await null; return kv.has(k) ? (ty === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null; }, put: async (k, v) => { await null; kv.set(k, v); } };
  const objects = new Map();
  const USAGE = { idFromName: (n) => n, get: (id) => {
    if (!objects.has(id)) {
      const store = new Map();
      const o = new UsageMeter({ storage: { get: async (k) => { await null; return store.get(k); }, put: async (k, v) => { await null; store.set(k, JSON.parse(JSON.stringify(v))); } } }, { USAGE_KV: KV });
      let q = Promise.resolve();   // input gate: one call at a time per object
      objects.set(id, new Proxy(o, { get: (tg, prop) => (typeof tg[prop] === "function" ? (...a) => (q = q.then(() => tg[prop](...a))) : tg[prop]) }));
    }
    return objects.get(id);
  } };

  await group("the object: no charge is lost, the KV mirror follows", async () => {
    kv.set("usage_sess:m1", JSON.stringify({ start: Date.now() - 60e3, cost_usd: 0.25, requests: 3 }));
    const stub = USAGE.get("m1");
    await Promise.all(Array.from({ length: 40 }, (_, i) => stub.add("m1", { cost: 0.01, agent: i % 2 ? "builder" : "assistant" })));
    const st = await stub.read("m1");
    eq("40 concurrent charges, all counted, on top of what KV had before", Math.round(st.sess.cost_usd * 100), 65);
    eq("the mirror says the same", Math.round(JSON.parse(kv.get("usage_sess:m1")).cost_usd * 100), 65);
    eq("a booking retried with the same id lands once", [(await usageBookCall({ USAGE }, "m1", { usd: 0.5, id: "gen-1" })).dup, (await usageBookCall({ USAGE }, "m1", { usd: 0.5, id: "gen-1" })).dup], [false, true]);
    eq("so the total moved by 0.50, not 1.00", Math.round((await stub.read("m1")).sess.cost_usd * 100), 115);
    t("one member's object never sees another's", (await USAGE.get("m2").read("m2")).sess === null);
  });

  await group("the naive KV way loses writes (why the object exists)", async () => {
    const k = new Map([["c", "0"]]);
    const slowKV = { get: async (key) => { await new Promise((r) => setTimeout(r, 1)); return k.get(key); }, put: async (key, v) => { await new Promise((r) => setTimeout(r, 1)); k.set(key, v); } };
    await Promise.all(Array.from({ length: 20 }, async () => { const v = Number(await slowKV.get("c")); await slowKV.put("c", String(v + 1)); }));
    t("20 read-modify-write increments do not add up to 20", Number(k.get("c")) < 20, k.get("c"));
  });
  void USAGE_H;
}
