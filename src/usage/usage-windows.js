/**
 * Usage metering: the money windows, as pure functions
 * (extracted from backend/workers/lia-usage.js; trimmed to the generic parts).
 *
 * A member's spend is tracked in three windows at once: a rolling SESSION (a few
 * hours from its first charge), a WEEK (7-day cycle anchored to a fixed UTC hour),
 * and the calendar MONTH (UTC). Windows roll lazily: nothing runs on a timer, every
 * read rolls the state to "now" first.
 *
 * Kept from the original: the windows, per-agent shares, idempotent bookings
 * (a retried booking with the same provider call id lands once), batch
 * reservations (check-and-hold in one step, with a TTL), and the cap check.
 * Removed: per-product cost categories, provider-specific reconciliation and price
 * tables, per-agent and per-plan caps.
 */
const ZERO = () => ({ requests: 0, tokens_in: 0, tokens_out: 0, tools: 0, cost_usd: 0 });
const r6 = (x) => +(Number(x) || 0).toFixed(6);
export const usageMonth = (now) => new Date(now).toISOString().slice(0, 7);

/* The week starts at the most recent 05:00 UTC at or before the first charge, so a
   personal 7-day cycle resets at the same time of day every week. */
export const USAGE_WEEK_ANCHOR_HOUR = 5;
export function usageWeekStart(firstTs) {
  const d = new Date(firstTs);
  const anchor = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), USAGE_WEEK_ANCHOR_HOUR, 0, 0));
  if (anchor.getTime() > firstTs) anchor.setUTCDate(anchor.getUTCDate() - 1);
  return anchor.getTime();
}
export const USAGE_H = { hours: 5, weekMs: 7 * 86400e3, weekStart: usageWeekStart };

/* the windows rolled to now: a session older than its hours, a week fully elapsed, another month start again */
export function usageRoll(st, now, H) {
  const s = Object.assign({ sess: null, week: null, month: null, ags: null, agw: null }, st || {});
  if (!s.sess || !s.sess.start || now - s.sess.start > H.hours * 3600e3) s.sess = null;
  if (s.week && s.week.start) { while (now - s.week.start >= H.weekMs) s.week = Object.assign(ZERO(), { start: s.week.start + H.weekMs }); }
  else s.week = null;
  if (!s.month || s.month.key !== usageMonth(now)) s.month = null;
  if (s.ags && (!s.sess || s.ags.start !== s.sess.start)) s.ags = null;
  if (s.agw && (!s.week || s.agw.start !== s.week.start)) s.agw = null;
  return s;
}
/* one charge into one window. rec.kind "agent" is a share only: the money is already in the windows */
export function usageBump(o, rec, now) {
  if (rec.kind === "agent") return o;
  o.requests = (o.requests || 0) + 1;
  o.tokens_in = (o.tokens_in || 0) + (Number(rec.tin) || 0);
  o.tokens_out = (o.tokens_out || 0) + (Number(rec.tout) || 0);
  o.tools = (o.tools || 0) + (Number(rec.tools) || 0);
  o.cost_usd = r6((o.cost_usd || 0) + (Number(rec.cost) || 0));
  o.updated = now;
  return o;
}
/* a charge into every window (and the agent's share) -> the new state */
export function usageApply(st, rec, now, H) {
  const s = usageRoll(st, now, H);
  if (rec.kind !== "agent") {
    if (!s.sess) s.sess = Object.assign(ZERO(), { start: now });
    if (!s.week) s.week = Object.assign(ZERO(), { start: H.weekStart(now) });
    if (!s.month) s.month = Object.assign(ZERO(), { key: usageMonth(now) });
    usageBump(s.sess, rec, now); usageBump(s.week, rec, now); usageBump(s.month, rec, now);
  }
  const agent = rec.agent && /^[a-z0-9_-]{1,24}$/.test(String(rec.agent)) ? String(rec.agent) : null;
  const c = Number(rec.cost) || 0;
  if (agent && c > 0) {
    if (s.sess) { if (!s.ags) s.ags = { start: s.sess.start, agents: {} }; s.ags.agents[agent] = r6((s.ags.agents[agent] || 0) + c); }
    if (s.week) { if (!s.agw) s.agw = { start: s.week.start, agents: {} }; s.agw.agents[agent] = r6((s.agw.agents[agent] || 0) + c); }
  }
  return s;
}

/* Reservations. A batch job reserves n x estimate inside the object before it
   starts (check and hold in ONE call, so two batches cannot both see the whole
   balance); each item books its real cost and gives back its estimate; the batch
   releases what is left at its end. A hold counts as spent in every window until it
   is released or its TTL passes - a job that died holds nothing for longer than that.
   st.holds = { id: { usd, exp } } */
export const USAGE_HOLD_TTL_MS = 10 * 60 * 1000;
export function usageHolds(st, now) {
  const out = {};
  for (const [id, h] of Object.entries((st && st.holds) || {})) if (h && h.exp > now && h.usd > 0) out[id] = h;
  return out;
}
export const usageHeld = (st, now) => Object.values(usageHolds(st, now)).reduce((n, h) => n + h.usd, 0);
/* how many of a batch fit in what is left (all when they fit; else as many as the
   estimate allows, at least one while anything is left) */
export function usageFit(left, est, want) {
  const n = Math.max(0, Math.floor(Number(want) || 0));
  if (!(Number(left) > 0)) return 0;
  if (!Number.isFinite(Number(left)) || !(Number(est) > 0)) return n;
  return Math.min(n, Math.max(1, Math.floor(Number(left) / Number(est) + 1e-9)));
}
/* check and hold in one step. o: { id, tot, est, want, ttl } -> { st, res } */
export function usageReserve(st0, now, H, o) {
  const st = Object.assign({}, st0 || {}, { holds: usageHolds(st0, now) });
  const c = usageCheck(st, now, H, o.tot);
  if (!c.ok) return { st, res: c };
  const fit = usageFit(c.left_usd, o.est, o.want);
  if (fit < 1) return { st, res: { ok: false, error: "limit_reserve", fit: 0, left_usd: c.left_usd } };
  const usd = r6(fit * (Number(o.est) || 0));
  const id = String(o.id || "h" + now.toString(36));
  if (usd > 0) st.holds[id] = { usd, exp: now + (Number(o.ttl) > 0 ? Number(o.ttl) : USAGE_HOLD_TTL_MS) };
  return { st, res: { ok: true, id, fit, held: usd, left_usd: c.left_usd } };
}
/* a hold made smaller (an item booked: its estimate given back) or released (usd omitted: all of it) */
export function usageRelease(st0, now, id, usd) {
  const st = Object.assign({}, st0 || {}, { holds: usageHolds(st0, now) });
  const h = st.holds[id];
  if (!h) return st;
  const left = usd == null ? 0 : r6(h.usd - (Number(usd) || 0));
  if (left > 0) st.holds[id] = { usd: left, exp: h.exp }; else delete st.holds[id];
  return st;
}

/* Idempotent booking: a charge carrying the provider's own id of the model call lands
   once, so the one retry after a thrown RPC is safe. Ids are kept 3 days, at most
   2000 (oldest dropped first). -> { st, dup } */
export const USAGE_RECON_TTL_MS = 3 * 86400e3, USAGE_RECON_MAX = 2000;
export function usageOnce(st0, now, id) {
  const s = Object.assign({}, st0 || {});
  const k = "b:" + String(id || "").slice(0, 128);
  const recon = {};
  for (const [x, exp] of Object.entries(s.recon || {})) if (exp > now) recon[x] = exp;
  s.recon = recon;
  if (recon[k]) return { st: s, dup: true };
  recon[k] = now + USAGE_RECON_TTL_MS;
  const ids = Object.keys(recon);
  if (ids.length > USAGE_RECON_MAX) ids.sort((a, b) => recon[a] - recon[b]).slice(0, ids.length - USAGE_RECON_MAX).forEach((x) => delete recon[x]);
  return { st: s, dup: false };
}

/* The caps against the live windows. tot: {session, weekly, monthly}; a missing or
   non-finite cap is no cap. Holds count as spent.
   -> { ok: true, left_usd } | { ok: false, error, window, resets } */
export function usageCheck(st, now, H, tot) {
  const s = usageRoll(st, now, H);
  const W = [["session", s.sess, s.sess ? s.sess.start + H.hours * 3600e3 : null], ["weekly", s.week, s.week ? s.week.start + H.weekMs : null],
    ["monthly", s.month, Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1)]];
  const cap = (o, k) => (o && Number.isFinite(Number(o[k])) && Number(o[k]) > 0 ? Number(o[k]) : Infinity);
  let left = Infinity;
  const held = usageHeld(st, now);
  for (const [k, w, resets] of W) {
    const whole = cap(tot, k) - (((w && w.cost_usd) || 0) + held);
    if (whole <= 0) return { ok: false, error: "limit_" + k, window: k, resets };
    left = Math.min(left, whole);
  }
  return { ok: true, left_usd: left };
}
/* "Resets in 3h" / "4d" */
export function usageResetText(resets, now) {
  if (!resets) return "";
  const mins = Math.max(Math.ceil((resets - now) / 60e3), 1);
  return mins >= 60 * 24 ? Math.ceil(mins / 60 / 24) + "d" : mins >= 60 ? Math.ceil(mins / 60) + "h" : mins + "m";
}
