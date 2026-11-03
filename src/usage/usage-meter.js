/**
 * UsageMeter - one Durable Object per member that is the ONLY writer of that
 * member's spend (extracted from backend/workers/lia-usage.js, class LiaUsage).
 *
 * Why a Durable Object: before it, several workers each read the member's spend
 * windows from KV, added their charge and wrote them back. KV serves values up to a
 * minute stale and has no compare-and-set, so concurrent writers erased each
 * other's increments and spend was under-counted past every cap. A Durable Object
 * processes one call at a time for a given id, so each add is a single
 * read-apply-write with no lost update, and a limit check that also reserves
 * (`reserve`) cannot be raced by a second job.
 *
 *   addressing   env.USAGE.idFromName(memberId) - the worker derives the name from
 *                the authenticated member only, so one member never reaches another's
 *                object
 *   storage      one value ("s") in the object's transactional storage
 *   seeding      on first use the object imports the old KV keys, so nothing counted
 *                before the migration is lost
 *   mirror       after each write the windows are copied back to the same KV keys, so
 *                every existing reader (dashboards, older code) keeps working; KV is
 *                now a read cache, the object is the record
 *   expiry       no alarm is needed: windows roll lazily on every call and holds carry
 *                their own expiry timestamp
 *
 * RPC: callers use the stub directly - `await env.USAGE.get(id).add(member, rec)`.
 */
import { DurableObject } from "cloudflare:workers";
import { USAGE_H, usageMonth, usageRoll, usageApply, usageOnce, usageReserve, usageRelease, usageCheck } from "./usage-windows.js";

export class UsageMeter extends DurableObject {
  H() { return USAGE_H; }
  async state(m) {
    let st = await this.ctx.storage.get("s");
    if (!st) {   // first sight: what KV had (the writers before the object)
      const KV = this.env.USAGE_KV, now = Date.now();
      const g = (k) => KV.get(k, "json").catch(() => null);
      const [sess, week, month, ags, agw] = await Promise.all([g(`usage_sess:${m}`), g(`usage_week:${m}`), g(`usage_month:${m}:${usageMonth(now)}`), g(`usage_ags:${m}`), g(`usage_agw:${m}`)]);
      st = { sess, week, month: month ? Object.assign({}, month, { key: usageMonth(now) }) : null, ags, agw, seeded: now };
      await this.ctx.storage.put("s", st);
    }
    return st;
  }
  /* the charge, applied at once; then the KV mirror (one writer, so nothing is lost there either) */
  async add(m, rec) {
    const H = this.H(), now = Date.now();
    let st0 = await this.state(m);
    if (rec && rec.id) {   // a booking with the provider call's id lands once
      const o = usageOnce(st0, now, rec.id);
      if (o.dup) return Object.assign(usageRoll(st0, now, H), { dup: true });
      st0 = o.st;
    }
    let st = usageApply(st0, rec || {}, now, H);
    if (rec && rec.hold) st = usageRelease(st, now, String(rec.hold), rec.hold_usd);   // the item's estimate given back
    await this.ctx.storage.put("s", st);
    await this.mirror(m, st, H);
    return usageRoll(st, now, H);
  }
  async mirror(m, st, H) {
    const KV = this.env.USAGE_KV, puts = [];
    const put = (k, v, ttl) => puts.push(KV.put(k, JSON.stringify(v), { expirationTtl: ttl }).catch((e) => console.log("USAGE_MIRROR_FAIL", String(e && e.message || e).slice(0, 120))));
    if (st.sess) put(`usage_sess:${m}`, st.sess, 60 * 60 * (H.hours + 1));
    if (st.week) put(`usage_week:${m}`, st.week, 60 * 60 * 24 * 21);
    if (st.month) { const { key, ...mo } = st.month; put(`usage_month:${m}:${key}`, mo, 60 * 60 * 24 * 400); }
    if (st.ags) put(`usage_ags:${m}`, st.ags, 60 * 60 * (H.hours + 1));
    if (st.agw) put(`usage_agw:${m}`, st.agw, 60 * 60 * 24 * 21);
    await Promise.all(puts);
  }
  /* a batch's reservation - check and hold in one call (the object runs one call at a time) */
  async reserve(m, o) {
    const H = this.H(), now = Date.now();
    const { st, res } = usageReserve(usageRoll(await this.state(m), now, H), now, H, o || {});
    await this.ctx.storage.put("s", st);
    return res;
  }
  /* give back part of a hold (usd) or all of it (usd omitted) */
  async release(m, id, usd) {
    const now = Date.now();
    await this.ctx.storage.put("s", usageRelease(await this.state(m), now, String(id || ""), usd));
    return { ok: true };
  }
  /* the cap check against the live windows */
  async check(m, tot) { return usageCheck(await this.state(m), Date.now(), this.H(), tot); }
  /* the live windows (rolled to now) */
  async read(m) { return usageRoll(await this.state(m), Date.now(), this.H()); }
}

/* the worker's side: book one model call to the member; never throws. With a call id
   the booking is retried once (safe: the object dedupes by id). */
export async function usageBookCall(env, m, o, deps) {
  const usd = +(Number(o && o.usd) || 0).toFixed(6);
  if (!m || !(usd > 0)) return { ok: false, error: "nothing" };
  const stub = deps && deps.stub ? deps.stub : (env && env.USAGE ? env.USAGE.get(env.USAGE.idFromName(String(m))) : null);
  if (!stub) return { ok: false, error: "unbound" };
  const agent = o.agent && /^[a-z0-9_-]{1,24}$/.test(String(o.agent)) ? String(o.agent) : "assistant";
  const rec = { cost: usd, tin: Number(o.tin) || 0, tout: Number(o.tout) || 0, tools: 0, agent, ...(o.id ? { id: String(o.id).slice(0, 128) } : {}) };
  let err = null;
  for (let i = 0; i < (rec.id ? 2 : 1); i++) {
    try { const r = await stub.add(m, rec); return { ok: true, dup: !!(r && r.dup) }; } catch (e) { err = String(e && e.message || e).slice(0, 120); }
  }
  console.log("USAGE_BOOK_FAIL", JSON.stringify({ member: m, what: o.what || null, usd, error: err }));
  return { ok: false, error: err };
}
