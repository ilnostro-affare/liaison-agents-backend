/**
 * POST /meta/write/apply and GET|POST /meta/write/plan-state
 * (extracted from handleBuildWrite in backend/workers/meta.js).
 *
 * Apply is reachable only through the product UI's front-end channel, after the
 * person pressed Yes; the MCP JSON-RPC surface does not have it and the model never
 * sees it. Order of operations, each step a guarantee:
 *
 *   1. load the plan; another member's plan is refused (403)
 *   2. staleness: re-read the fields the plan touches; if Meta moved, cancel the
 *      plan, keep a record of why, refuse with 409 - BEFORE anything is consumed
 *   3. consume the plan (delete the key) BEFORE the Graph call, so a double click
 *      finds no plan (KV is eventually consistent: this narrows the race, it does
 *      not eliminate it)
 *   4. write to Meta; anything created is created PAUSED
 *   5. on refusal: put the ORIGINAL plan back (the bytes that were read, not what
 *      apply made of them) so the card stays usable, log Meta's own words
 *   6. on success: one journal row (diff + undo), one `lia:planapplied:{plan}` key,
 *      a short-lived freshness overlay, and a LIA_WRITE_OK log line
 *
 * Trimmed: the creation branches (campaign / ad set / ad / rules / uploads), the
 * card overrides beyond the name, the account-billing diagnosis of refusals, and
 * the tree write-through. They follow the same consume -> write -> journal shape.
 */
import { BW_GRAPH, bwJson, bwToken } from "./common.js";
import { BW_PLAN_KEEP, BW_TTL, bwPlanIsEdit, bwPlanStaleCheck, bwPlanCancelStale, bwStaleReply } from "./stale.js";
import { journalAppend } from "./journal.js";

// ── GET|POST /meta/write/plan-state - is a waiting plan still good? ──
// A plan has no timer, so a card asks this instead of counting down: "open",
// "stale" (cancelled, with the fields) or "gone" (applied, past the storage keep,
// or not yours). A suspect mark left by the activity feed or a webhook is verified
// against the live object here, so the answer is never a guess.
export async function handlePlanState(request, env, url, memberId, body) {
  let ids = request.method === "GET"
    ? String(url.searchParams.get("plan_ids") || url.searchParams.get("plan_id") || "").split(",")
    : (Array.isArray(body && body.plan_ids) ? body.plan_ids : [body && body.plan_id]);
  ids = ids.map((x) => String(x || "").replace(/[^a-zA-Z0-9-]/g, "")).filter(Boolean).slice(0, 20);
  if (!ids.length) return bwJson({ ok: false, error: "plan_id required" }, 400);
  const verifyAll = url.searchParams.get("verify") === "1" || !!(body && body.verify);
  let tok = null;
  const plans = [];
  for (const pid of ids) {
    let plan = null, rec = null;
    try { plan = await env.META_KV.get(`lia:plan:${pid}`, "json"); } catch (_) {}
    try { rec = await env.META_KV.get(`lia:planstale:${pid}`, "json"); } catch (_) {}
    if (!plan || plan.member !== memberId) {
      if (!plan && rec && rec.verified && rec.member === memberId) {
        const r = bwStaleReply(rec.plan || {}, pid, rec.changed, rec.t);
        plans.push({ plan_id: pid, state: "stale", stale: true, reason: rec.reason || null, changed_fields: r.changed_fields,
          stale_at: r.stale_at, user_message: r.user_message, entity_id: r.entity_id, entity_type: r.entity_type, entity_name: r.entity_name, account: r.account });
      } else plans.push({ plan_id: pid, state: "gone", stale: false });
      continue;
    }
    const row = { plan_id: pid, state: "open", stale: false, entity_id: plan.entity_id || null, entity_type: plan.entity_type || null,
      entity_name: plan.entity_name || null, account: plan.account || null, created: plan.created || null, suspect: !!rec, checked: false };
    if (bwPlanIsEdit(plan) && (rec || verifyAll)) {
      if (!tok) { const t0 = await bwToken(env, memberId); tok = t0.error ? "" : t0.token; }
      if (tok) {
        const st = await bwPlanStaleCheck(tok, plan);
        row.checked = !!st.checked;
        if (st.stale) {
          const at = Date.now();
          await bwPlanCancelStale(env, memberId, pid, plan, st.changed, at, "plan_state");
          const r = bwStaleReply(plan, pid, st.changed, at);
          Object.assign(row, { state: "stale", stale: true, suspect: false, reason: "Cancelled: Meta changed since this plan was made",
            changed_fields: r.changed_fields, stale_at: at, user_message: r.user_message });
        } else if (st.checked && rec) {
          try { await env.META_KV.delete(`lia:planstale:${pid}`); } catch (_) {}
          row.suspect = false;
        }
      }
    }
    if (row.suspect && rec) row.suspect_reason = { at: rec.at || null, src: rec.src || null, what: rec.what || null };
    plans.push(row);
  }
  const one = ids.length === 1 ? plans[0] : null;
  return bwJson({ ok: true, plans, ...(one ? { plan: one } : {}), checked_at: Date.now() });
}

// ── POST /meta/write/apply - consumes the plan ──
export async function handleApply(env, memberId, body) {
  const { plan_id, mode, overrides } = body || {};
  if (!plan_id) return bwJson({ ok: false, error: "plan_id required" }, 400);
  const raw = await env.META_KV.get(`lia:plan:${plan_id}`);
  if (!raw) {
    // a plan cancelled because Meta moved under it says so, every time it is pressed
    let gone = null;
    try { gone = await env.META_KV.get(`lia:planstale:${String(plan_id).replace(/[^a-zA-Z0-9-]/g, "")}`, "json"); } catch (_) {}
    if (gone && gone.verified && gone.member === memberId) return bwJson(bwStaleReply(gone.plan || {}, plan_id, gone.changed, gone.t), 409);
    return bwJson({ ok: false, error: "Plan expired or already applied" }, 410);
  }
  const plan = JSON.parse(raw);
  let _lastForm = null;   // the form of the last write, printed only when Meta refuses
  if (plan.member !== memberId) return bwJson({ ok: false, error: "Plan belongs to another member" }, 403);

  const t = await bwToken(env, memberId);
  if (t.error) return bwJson({ ok: false, error: t.error }, 403);

  // No timer: the plan is cancelled only when the object it changes no longer holds
  // what the plan was made against. Read BEFORE the consume, so a cancelled plan is
  // never half-applied, and a read failure leaves apply as it was.
  if (bwPlanIsEdit(plan)) {
    const _st = await bwPlanStaleCheck(t.token, plan);
    if (_st.stale) {
      const at = Date.now();
      await bwPlanCancelStale(env, memberId, plan_id, plan, _st.changed, at, "apply");
      return bwJson(bwStaleReply(plan, plan_id, _st.changed, at), 409);
    }
    if (_st.checked) { try { await env.META_KV.delete(`lia:planstale:${plan_id}`); } catch (_) {} }   // a suspect mark proved unfounded
    else console.log("LIA_PLAN_STALE_SKIP", JSON.stringify({ member: memberId, plan: plan_id, entity: plan.entity_id, reason: _st.reason, detail: _st.detail || null }));
  }

  // The card's editable name - the person's final word before Yes. Written back into
  // the plan object, so every later reader (form, journal, diff) sees one value.
  if (overrides && typeof overrides.name === "string" && overrides.name.trim()) {
    const nm = overrides.name.trim().slice(0, 200);
    if (plan.copy) { plan.copy.rename = nm; plan.entity_name = nm; }
    plan.diff = plan.diff.map(d => d.kind === "created" ? { ...d, new: nm } : d);
  }

  // Consume BEFORE the Graph call: a double click finds no plan. (KV is eventually
  // consistent, so this narrows the race, it does not eliminate it.)
  await env.META_KV.delete(`lia:plan:${plan_id}`);

  let res; let createdId = null;
  if (plan.copy && plan.entity_type === "ad" && plan.copy.account_id) {
    // An ad copy goes through the plain create edge with source_ad_id: status is a
    // first-class parameter there, so the copy is created PAUSED.
    const form = new URLSearchParams();
    form.set("name", plan.copy.rename);
    form.set("adset_id", plan.copy.adset_id || "");
    form.set("source_ad_id", plan.entity_id);
    if (plan.copy.creative_id) form.set("creative", JSON.stringify({ creative_id: plan.copy.creative_id }));
    form.set("status", "PAUSED");
    form.set("access_token", t.token);
    _lastForm = form;
    res = await (await fetch(`${BW_GRAPH}/act_${String(plan.copy.account_id).replace(/^act_/, "")}/ads`, { method: "POST", body: form })).json();
    if (!res.error) createdId = res.id || null;
  } else if (plan.copy) {
    // Deep copy of an ad set / campaign: Meta's own deep /copies re-creates every
    // creative and chokes on data Meta itself wrote, so the container is copied
    // shallow (PAUSED) and its children are filled in by a job the card polls
    // (`lia:copyjob:{job}`, filler omitted from this extract).
    const shallow = new URLSearchParams();
    shallow.set("deep_copy", "false");
    shallow.set("status_option", "PAUSED");
    if (plan.copy.dsa_payor) shallow.set("dsa_payor", plan.copy.dsa_payor);
    if (plan.copy.dsa_beneficiary) shallow.set("dsa_beneficiary", plan.copy.dsa_beneficiary);
    shallow.set("access_token", t.token);
    const top = await (await fetch(`${BW_GRAPH}/${plan.entity_id}/copies`, { method: "POST", body: shallow })).json();
    if (top.error) {
      console.log("LIA_WRITE_ERR", JSON.stringify({ member: memberId, plan: plan_id, stage: "shallow_top",
        code: top.error.code, subcode: top.error.error_subcode, message: top.error.message, user_msg: top.error.error_user_msg }));
      const left0 = Math.max(30, BW_TTL - Math.round((Date.now() - (plan.created || Date.now())) / 1000));
      try { await env.META_KV.put(`lia:plan:${plan_id}`, raw, { expirationTtl: left0 }); } catch (_) {}
      return bwJson({ ok: false, error: top.error.error_user_msg || top.error.message || "Meta refused the copy",
        error_class: "graph_write_failed", retryable: true, expires_at: null }, 502);
    }
    const topId = top.copied_campaign_id || top.copied_adset_id || top.id || null;
    const jid = crypto.randomUUID();
    await env.META_KV.put(`lia:copyjob:${jid}`, JSON.stringify({
      member: memberId, plan_id, plan, mode: mode === "once" ? "confirm once" : "double confirm",
      session: (body && body.session_id) || plan.session || null, top_id: topId, suffix: plan.copy.suffix || null,
      queue: [], total: 0, done_n: 0, done: false, started: Date.now()
    }), { expirationTtl: 86400 });
    return bwJson({ ok: true, pending: true, job: jid, entity_name: plan.copy.rename, created_id: topId,
      note: "The container is created. Liaison is filling it in." });
  } else {
    // An edit: the plan's fields onto the existing object. Anything that is not a
    // scalar crosses this boundary as JSON or not at all ("[object Object]" otherwise).
    const form = new URLSearchParams();
    Object.entries(plan.fields).forEach(([k, v]) => form.set(k, (v !== null && typeof v === "object") ? JSON.stringify(v) : String(v)));
    form.set("access_token", t.token);
    _lastForm = form;
    res = await (await fetch(`${BW_GRAPH}/${plan.entity_id}`, { method: "POST", body: form })).json();
  }

  if (res.error) {
    // Log Meta's own words AND the form it saw (never the token).
    console.log("LIA_WRITE_ERR", JSON.stringify({
      member: memberId, plan: plan_id, tool: plan.tool, entity: plan.entity_id, entity_type: plan.entity_type,
      code: res.error.code, subcode: res.error.error_subcode || null,
      message: res.error.message || "", user_msg: res.error.error_user_msg || null,
      form: (() => { try { const o = {}; for (const [k, v] of (_lastForm || [])) o[k] = String(v).slice(0, 160); delete o.access_token; return o; } catch (_) { return null; } })()
    }));
    // A refused write changed nothing in Meta, so the plan goes back as it was READ
    // (`raw`), never as apply has since mutated it - otherwise the rejected values
    // would be baked into the plan and the next attempt could not undo them.
    const left = Math.max(30, BW_TTL - Math.round((Date.now() - (plan.created || Date.now())) / 1000));
    try { await env.META_KV.put(`lia:plan:${plan_id}`, raw, { expirationTtl: left }); } catch (_) {}
    return bwJson({ ok: false,
      error: res.error.error_user_msg || res.error.message || "Meta refused the change",
      error_class: "graph_write_failed",
      detail: res.error.message || "", code: res.error.code, subcode: res.error.error_subcode || null,
      retryable: true, expires_at: null }, 502);
  }

  const entry = {
    id: crypto.randomUUID(), ts: Date.now(), source: "lia",
    tool: plan.tool, entity_id: plan.entity_id, entity_type: plan.entity_type, entity_name: plan.entity_name,
    created_id: createdId,
    diff: plan.diff, undo: plan.undo, mode: mode === "once" ? "confirm once" : "double confirm",
    plan: plan_id,                                   // restored cards resolve their state from the journal
    undo_of: plan.undo_of || null,
    session: (body && body.session_id) || plan.session || null,
    account_name: (body && body.account_name) || plan.account_name || null,
    account_id: (plan && plan.account) || (body && body.account) || null   // names are renamed; the id is the key
  };
  if (createdId) { try { await env.META_KV.put(`lia:planresult:${plan_id}`, String(createdId), { expirationTtl: BW_PLAN_KEEP }); } catch (_) {} }
  /* One key per applied plan. The journal is one hot key every reader caches for up
     to a minute, so a plan applied seconds after the agent read the journal would read
     as "not confirmed"; a key nobody has read before is never stale. */
  try { await env.META_KV.put(`lia:planapplied:${plan_id}`, String(createdId || "applied"), { expirationTtl: 7 * 86400 }); } catch (_) {}
  await journalAppend(env, memberId, entry);
  // Our own write makes the 60 s live cache stale (and Meta lags on effective_status),
  // so a short-lived overlay states what was applied until Meta catches up.
  try {
    const fresh = {};
    const nf = plan.fields || {};
    if (nf.status) fresh.status = nf.status;
    if (nf.daily_budget != null) fresh.daily_budget = String(nf.daily_budget);
    if (nf.name) fresh.name = nf.name;
    if (Object.keys(fresh).length) await env.META_KV.put(`lia:fresh:${memberId}:${plan.entity_id}`, JSON.stringify(fresh), { expirationTtl: 120 });
    if (createdId) await env.META_KV.put(`lia:fresh:${memberId}:${createdId}`, JSON.stringify({ status: "PAUSED", name: plan.entity_name }), { expirationTtl: 120 });
  } catch (_) {}
  // Say that it worked, in the same place that says it did not.
  try {
    console.log("LIA_WRITE_OK", JSON.stringify({ member: memberId, plan: plan_id, tool: plan.tool,
      entity_type: plan.entity_type, entity: plan.entity_id || null, created_id: createdId || null }));
  } catch (_) {}
  return bwJson({ ok: true, journal_id: entry.id, applied: plan.diff, created_id: createdId || null });
}
