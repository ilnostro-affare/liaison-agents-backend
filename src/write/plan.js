/**
 * POST /meta/write/plan - build a diff, mutate nothing
 * (extracted from handleBuildWrite in backend/workers/meta.js).
 *
 * A plan is the whole change, prepared: the current values read from Meta, the
 * fields to send, the undo record (what each field held), and the diff the person
 * reads before answering. It is stored as `lia:plan:{uuid}` and nothing reaches
 * Meta until apply consumes it after an explicit Yes.
 *
 * Three of the production planners are kept here, trimmed to their core:
 *   update_entity    pause / rename / daily budget (the original also carries
 *                    lifetime budgets, dates, bid strategy, special ad categories,
 *                    the whole audience and placements)
 *   activate_entity  turning something ON always gets its own plan and its own
 *                    confirm, with the paused parent chain and the money it wakes
 *   copy_entity      native /copies; every copy is born PAUSED
 * Removed: creation planners (campaign / ad set / ad / rules / A/B tests), the
 * account-billing gate, destination copies, budget-mode switches. Those all end in
 * the same `lia:plan:` record and the same apply.
 */
import { BW_GRAPH, BW_FIELDS, bwJson, bwToken, bwReadEntity, bwIsDead, BW_DEAD_ERR, bwCurrency, bwMoney, bwBudgetHost, bwPath } from "./common.js";
import { bwExpiry, bwPlanIndexPut } from "./stale.js";

const bwDate = () => { const d = new Date(); const p2 = (n) => String(n).padStart(2, "0"); return p2(d.getDate()) + "." + p2(d.getMonth() + 1) + "." + d.getFullYear(); };

export async function handlePlan(env, memberId, body, planTtl) {
  let { tool, entity_id, entity_type, changes } = body || {};   // entity_type is corrected in place when the model guesses the wrong shape

  // ── activate_entity: "start spending" always earns its OWN plan, never a field on
  //    update. The plan reads the PARENT chain so the card can say "the campaign is
  //    paused too - this ad will not deliver yet", and what else would start spending.
  if (tool === "activate_entity") {
    if (!entity_id || !BW_FIELDS[entity_type]) return bwJson({ ok: false, error: "entity_id + entity_type required" }, 400);
    const t = await bwToken(env, memberId); if (t.error) return bwJson({ ok: false, error: t.error, error_class: "meta_not_connected" }, 403);
    const rd = await bwReadEntity(t.token, entity_id, entity_type);
    if (rd.err) return bwJson({ ok: false, ...rd.err }, rd.status);
    const cur = rd.obj; entity_type = rd.type;
    if (bwIsDead(cur)) return bwJson({ ok: false, ...BW_DEAD_ERR, entity_name: cur.name || entity_id }, 410);
    // "Already ACTIVE" is only true if it is ACTIVE *and delivering*. An ACTIVE ad set
    // under a PAUSED campaign is not running from the person's point of view.
    const effActive = cur.effective_status === "ACTIVE";
    const selfActive = cur.status === "ACTIVE";
    if (selfActive && effActive) return bwJson({ ok: false, error: "Already ACTIVE and delivering", error_class: "no_change" }, 400);
    const selfAlreadyOn = selfActive && !effActive;
    const warnings = [];
    const blocked_by = [];
    try {
      const chain = [];
      const BUDGET_F = "name,status,daily_budget,lifetime_budget";
      if (entity_type === "ad" && cur.adset_id) {
        const as = await (await fetch(`${BW_GRAPH}/${cur.adset_id}?fields=${BUDGET_F},campaign_id&access_token=${t.token}`)).json();
        if (!as.error) {
          chain.push({ type: "ad_set", id: cur.adset_id, name: as.name, status: as.status, daily_budget: as.daily_budget || null, lifetime_budget: as.lifetime_budget || null });
          if (as.campaign_id) {
            const cp = await (await fetch(`${BW_GRAPH}/${as.campaign_id}?fields=${BUDGET_F}&access_token=${t.token}`)).json();
            if (!cp.error) chain.push({ type: "campaign", id: as.campaign_id, name: cp.name, status: cp.status, daily_budget: cp.daily_budget || null, lifetime_budget: cp.lifetime_budget || null });
          }
        }
      } else if (entity_type === "ad_set" && cur.campaign_id) {
        const cp = await (await fetch(`${BW_GRAPH}/${cur.campaign_id}?fields=${BUDGET_F}&access_token=${t.token}`)).json();
        if (!cp.error) chain.push({ type: "campaign", id: cur.campaign_id, name: cp.name, status: cp.status, daily_budget: cp.daily_budget || null, lifetime_budget: cp.lifetime_budget || null });
      }
      chain.filter(x => x.status && x.status !== "ACTIVE").forEach(x => blocked_by.push(x));
      if (blocked_by.length) {
        // "Do you also want to wake the campaign" is a money question, so show the money.
        const ccy = cur.account_id ? await bwCurrency(t.token, cur.account_id) : { code: "EUR", offset: 100 };
        blocked_by.forEach(x => {
          const minor = x.daily_budget || x.lifetime_budget || null;
          if (minor) x.budget = bwMoney(minor, ccy) + (x.daily_budget ? " a day" : " lifetime");
        });
        const names = blocked_by.map(x => (x.type === "campaign" ? "campaign" : "ad set") + " «" + (x.name || x.id) + "»").join(" and the ");
        warnings.push("This will not deliver on its own. The " + names + " is PAUSED, so the ad stays dark until that is switched on too.");
        blocked_by.filter(x => x.budget).forEach(x => {
          warnings.push("That " + (x.type === "campaign" ? "campaign" : "ad set") + " runs on " + x.budget + ".");
        });
        // what else wakes up with the outermost blocker
        const top = blocked_by[blocked_by.length - 1];
        if (top.type === "campaign") {
          const [adsRes, setsRes] = await Promise.all([
            (await fetch(`${BW_GRAPH}/${top.id}/ads?fields=name,status,adset_id&limit=200&access_token=${t.token}`)).json(),
            (await fetch(`${BW_GRAPH}/${top.id}/adsets?fields=status,daily_budget,lifetime_budget&limit=200&access_token=${t.token}`)).json()
          ]);
          if (!adsRes.error && !setsRes.error) {
            const sets = setsRes.data || [];
            const liveSets = new Set(sets.filter(x => x.status === "ACTIVE").map(x => x.id));
            const wake = (adsRes.data || []).filter(a => a.id !== entity_id && a.status === "ACTIVE" && liveSets.has(a.adset_id));
            if (wake.length) {
              const many = wake.length > 1;
              warnings.push("Switching that campaign on would also start " + wake.length + (many ? " ads that are" : " ad that is") +
                " already ACTIVE inside it: " + wake.slice(0, 5).map(a => "«" + a.name + "»").join(", ") +
                (wake.length > 5 ? " and " + (wake.length - 5) + " more" : "") + (many ? ". They all begin spending immediately." : ". It begins spending immediately."));
            }
          }
        }
      }
    } catch (_) {}
    const plan_id = crypto.randomUUID();
    // Already ON but held down by a paused parent: activating IT is a no-op, so the
    // plan is retargeted to the outermost paused parent and says so.
    const outerBlocker = blocked_by.length ? blocked_by[blocked_by.length - 1] : null;
    let planTarget = { id: entity_id, type: entity_type, name: cur.name || entity_id, from: cur.status };
    if (selfAlreadyOn && outerBlocker) {
      planTarget = { id: outerBlocker.id, type: outerBlocker.type, name: outerBlocker.name || outerBlocker.id, from: outerBlocker.status };
      for (let i = warnings.length - 1; i >= 0; i--) {
        if (/will not deliver on its own|stays dark|is PAUSED, so/.test(warnings[i])) warnings.splice(i, 1);
      }
    }
    const diff = selfAlreadyOn && outerBlocker
      ? [{ kind: "activated", label: "Status", old: outerBlocker.status, new: "ACTIVE", note: "«" + (cur.name || entity_id) + "» is already on; this wakes its paused " + outerBlocker.type }]
      : [{ kind: "activated", label: "Status", old: cur.status, new: "ACTIVE" }];
    await env.META_KV.put(`lia:plan:${plan_id}`, JSON.stringify({
      member: memberId, tool, entity_id: planTarget.id, entity_type: planTarget.type, entity_name: planTarget.name,
      account: cur.account_id ? String(cur.account_id).replace(/^act_/, "") : null,
      fields: { status: "ACTIVE" }, undo: { status: planTarget.from }, diff, created: Date.now()
    }), { expirationTtl: planTtl });
    await bwPlanIndexPut(env, cur.account_id, planTarget.id, plan_id);   // Meta's feed can mark it stale
    return bwJson({ ok: true, plan_id, ...bwExpiry(planTtl), entity_name: planTarget.name, entity_type: planTarget.type,
      path: await bwPath(t.token, cur, entity_type), diff, warnings, blocked_by,
      retargeted_to_parent: selfAlreadyOn && outerBlocker ? planTarget : undefined,
      note: "Nothing sent to Meta. Activation starts spending. It always gets its own confirm." });
  }

  // ── copy_entity: native /copies. Deep for ad sets and campaigns (the subtree comes
  //    along), plain for ads. Every copy is born PAUSED (status_option at apply).
  if (tool === "copy_entity") {
    if (!entity_id || !["ad_set", "ad", "campaign"].includes(entity_type)) return bwJson({ ok: false, error: "entity_id + entity_type (campaign|ad_set|ad) required" }, 400);
    const t = await bwToken(env, memberId); if (t.error) return bwJson({ ok: false, error: t.error }, 403);
    const cf = entity_type === "ad" ? "name,status,account_id,adset_id,creative{id}"
      : entity_type === "ad_set" ? "name,status,account_id,campaign_id,dsa_payor,dsa_beneficiary"
      : "name,status,account_id";
    const cur = await (await fetch(`${BW_GRAPH}/${entity_id}?fields=${cf}&access_token=${t.token}`)).json();
    if (cur.error) return bwJson({ ok: false, error: "Graph read failed", detail: cur.error.message || "" }, 502);
    // The name is not the model's call: Liaison writes a dated default and the person
    // edits it on the card (apply accepts overrides.name).
    const newName = (cur.name || "Copy") + " copy " + bwDate();
    const deep = entity_type !== "ad";
    const suffix = (changes && changes.rename_suffix) || null;   // renames the WHOLE subtree
    const plan_id = crypto.randomUUID();
    const diff = [{ kind: "created", label: "Copy of", old: cur.name || entity_id, new: newName, note: deep ? "the whole subtree, PAUSED" : "PAUSED" }];
    await env.META_KV.put(`lia:plan:${plan_id}`, JSON.stringify({
      member: memberId, tool, entity_id, entity_type, entity_name: cur.name || entity_id,
      account: cur.account_id ? String(cur.account_id).replace(/^act_/, "") : null,
      copy: { deep, rename: newName, suffix, account_id: cur.account_id || null, copies: 1,
        adset_id: cur.adset_id || null, creative_id: (cur.creative && cur.creative.id) || null,
        dsa_payor: cur.dsa_payor || null, dsa_beneficiary: cur.dsa_beneficiary || null }, undo: {}, diff, created: Date.now()
    }), { expirationTtl: planTtl });
    return bwJson({ ok: true, plan_id, ...bwExpiry(planTtl), entity_name: cur.name || entity_id, entity_type, entity_id,
      path: await bwPath(t.token, cur, entity_type),
      proposed_name: newName, name_editable: true, deep, suffix_editable: deep, proposed_suffix: suffix,
      diff, warnings: deep ? ["Everything inside is copied too. Children keep their own names unless you give a suffix."] : [],
      note: "Nothing sent to Meta. The copy will be created PAUSED." });
  }

  if (tool !== "update_entity") return bwJson({ ok: false, error: "Unknown tool" }, 400);
  if (!entity_id || !BW_FIELDS[entity_type]) return bwJson({ ok: false, error: "entity_id + entity_type (campaign|ad_set|ad) required" }, 400);
  if (!changes || typeof changes !== "object") return bwJson({ ok: false, error: "changes required" }, 400);

  const t = await bwToken(env, memberId);
  if (t.error) return bwJson({ ok: false, error: t.error, error_class: "meta_not_connected" }, 403);

  // Meta ids are ~15-18 digits. A truncated or invented id gets a clear,
  // self-correcting message instead of Meta's opaque "does not exist".
  if (!/^\d{9,}$/.test(String(entity_id))) {
    return bwJson({ ok: false, error_class: "bad_id",
      error: "That id (" + entity_id + ") is not a valid Meta id. Use find_entity to get the exact id and copy it verbatim.",
      hint: "Ad/ad-set/campaign ids are 15-18 digits. Do not shorten or invent them." }, 400);
  }
  // Read CURRENT values - the diff and the undo both come from here.
  const rd2 = await bwReadEntity(t.token, entity_id, entity_type);
  if (rd2.err) return bwJson({ ok: false, ...rd2.err }, rd2.status);
  let cur = rd2.obj; entity_type = rd2.type;
  // a deleted object accepts a rename and nothing else
  if (bwIsDead(cur) && !(changes && changes.name && Object.keys(changes).length === 1)) {
    return bwJson({ ok: false, ...BW_DEAD_ERR, entity_name: cur.name || entity_id }, 410);
  }

  const diff = []; const fields = {}; const undo = {}; const warnings = [];
  if (changes.status && ["PAUSED", "ACTIVE"].includes(changes.status) && changes.status !== cur.status) {
    // Two doors to the same room, one with no ceremony behind it: ACTIVE through a
    // plain update is allowed ONLY as the undo of our own pause. `undo_of` is set by
    // /meta/write/undo and by nothing else (router.js strips it from any other caller).
    if (changes.status === "ACTIVE" && !(body && body.undo_of)) {
      return bwJson({ ok: false,
        error: "Activation has its own plan",
        error_class: "use_activate",
        hint: "plan_update_entity may only PAUSE. To turn something on, call plan_activate_entity: it reads the parent chain, warns when the thing cannot deliver, prices what would start spending, and earns its own confirm.",
        entity_id, entity_type }, 400);
    }
    fields.status = changes.status; undo.status = cur.status;
    diff.push({ kind: changes.status === "PAUSED" ? "paused" : "resumed", label: "Status", old: cur.status, new: changes.status });
  }

  // Undo re-enters here with exact minor units (no currency re-conversion).
  if (changes.daily_budget_minor != null) {
    const minor = Math.round(Number(changes.daily_budget_minor));
    const oldMinor = Number(cur.daily_budget || 0);
    if (isFinite(minor) && minor > 0 && minor !== oldMinor) {
      const ccy = await bwCurrency(t.token, cur.account_id);
      fields.daily_budget = minor; undo.daily_budget = oldMinor;
      diff.push({ kind: "budget", label: "Daily budget", old: oldMinor ? bwMoney(oldMinor, ccy) : "not set", new: bwMoney(minor, ccy), currency: ccy.code });
    }
  }
  if (changes.daily_budget != null && changes.daily_budget_minor == null) {
    const amt = Number(changes.daily_budget);
    if (!isFinite(amt) || amt <= 0) return bwJson({ ok: false, error: "daily_budget must be a positive number (in the account's currency)" }, 400);
    // Find where the budget really lives before touching anything.
    const host = await bwBudgetHost(t.token, cur, entity_type);
    if (host && host.abo) {
      const accy = await bwCurrency(t.token, cur.account_id);
      return bwJson({ ok: false, error_class: "budget_is_per_adset",
        error: "This campaign spreads its budget across its ad sets (ABO), so there is no single campaign budget to change. Pick an ad set.",
        campaign: host.campaign, ad_sets: host.sets.map(x => ({ id: x.id, name: x.name, status: x.status,
          budget: bwMoney(Number(x.daily_budget || x.lifetime_budget), accy) + (x.daily_budget ? " a day" : " lifetime") })),
        hint: "Ask the user WHICH ad set to change, then call plan_update_entity on that ad_set id." }, 409);
    }
    if (!host) {
      return bwJson({ ok: false, error_class: "no_budget_anywhere",
        error: "There is no budget to change here. This campaign has no campaign-level budget and its ad sets have none either, so there is nothing to update." }, 409);
    }
    if (host.moved) { entity_id = host.id; entity_type = host.type; cur = host.obj; }   // retarget onto the real budget host
    const isLifetime = !(Number(cur.daily_budget) > 0) && Number(cur.lifetime_budget) > 0;
    if (isLifetime) {
      // a daily amount on a total budget is a different number, not the same one in another field
      return bwJson({ ok: false, error: "budget_type_mismatch", budget_type: "lifetime", owner: "liaison",
        hint: "This ad set runs on a TOTAL (lifetime) budget; a daily amount is not the same number. Ask the person for the total." }, 409);
    }
    const ccy = await bwCurrency(t.token, cur.account_id);
    const minor = Math.round(amt * ccy.offset);   // THE one conversion point - account currency, correct offset
    const oldMinor = Number(cur.daily_budget || 0);
    if (minor !== oldMinor) {
      if (oldMinor && Math.abs(minor - oldMinor) / oldMinor > 0.5) warnings.push("Budget change exceeds 50 percent. Double check the number.");
      fields.daily_budget = minor; undo.daily_budget = oldMinor;
      diff.push({ kind: "budget", label: "Daily budget", old: oldMinor ? bwMoney(oldMinor, ccy) : "not set", new: bwMoney(minor, ccy),
        currency: ccy.code, pct: oldMinor ? Math.round((minor - oldMinor) / oldMinor * 100) : null,
        budget_on: host.moved ? entity_type : null, budget_on_name: host.moved ? (cur.name || null) : null });
    }
  }
  if (changes.name && String(changes.name) !== cur.name) {
    fields.name = String(changes.name).slice(0, 200); undo.name = cur.name;
    diff.push({ kind: "renamed", label: "Name", old: cur.name, new: fields.name });
  }

  // An empty diff has two causes and they get two answers: a field this planner
  // does not carry is named as OURS ("Liaison does not send X"), never blamed on Meta.
  if (!diff.length) {
    const carried = ["name", "status", "daily_budget", "daily_budget_minor"];
    const unknown = Object.keys(changes || {}).filter((k) => carried.indexOf(k) === -1);
    if (unknown.length) {
      return bwJson({ ok: false, error: "Liaison does not send " + unknown.join(", ") + " yet, so nothing was requested from Meta.",
        error_class: "not_supported_here", unsupported: unknown }, 400);
    }
    return bwJson({ ok: false, error: "Nothing to change — every requested value already matches the account.", error_class: "no_diff" }, 400);
  }

  const plan_id = crypto.randomUUID();
  await env.META_KV.put(`lia:plan:${plan_id}`, JSON.stringify({
    member: memberId, tool, entity_id, entity_type, entity_name: cur.name || entity_id,
    account: cur.account_id ? String(cur.account_id).replace(/^act_/, "") : null,
    fields, undo, diff, created: Date.now(),
    // provenance for the apply step: the undo path re-enters from the journal screen
    // (no chat, no account picker), so the reversing row would otherwise lose both
    session: (body && body.session) || null,
    account_name: (body && body.account_name) || null,
    undo_of: (body && body.undo_of) || null
  }), { expirationTtl: planTtl });
  await bwPlanIndexPut(env, cur.account_id, entity_id, plan_id);   // Meta's feed can mark it stale
  const budgetMoved = diff.find(x => x.kind === "budget" && x.budget_on);
  return bwJson({ ok: true, plan_id, ...bwExpiry(planTtl), entity_name: cur.name || entity_id, entity_type,
    path: await bwPath(t.token, cur, entity_type), diff, warnings,
    budget_retargeted: budgetMoved ? { to: budgetMoved.budget_on, name: budgetMoved.budget_on_name } : null,
    note: "Nothing sent to Meta. Apply requires user confirmation." });
}
