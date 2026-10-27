// Mishaps act like monsters (John, 2026-10-26).
//
// Each Mishap on a ship takes its turn at the END of that ship's turn, after the crew. Its stat block ("Mishap
// Nature") sets what it does:
//  - Actions: PB − 1 different actions from its options (at least 1), never one it took on its previous turn.
//  - Work radius: on a bridge, creatures whose token stands on the Mishap's system card. Ships without a
//    bridge have no one in it.
//  - Choice (autopilot): attack a creature in the radius whenever it can (save actions: damage first, then
//    conditions); otherwise an action that hurts the ship; otherwise heal when hurt (Worsen); Hamper Correction last.
//  - Countdown: PB + 1 counters to start; at the end of each of its turns, if it still has HP, it loses one.
//    At 0 it completes: it is removed (no Strain back) and the ship gains, at random, either its next-worse
//    version or its escalation Mishap, on the same system (both named in its description).
//  - Conditions it applies last until the end of the target's next turn: they are lifted when that Mishap acts
//    again (the end of the ship's next turn).
//  - Backfire (reaction): when a Correct against it fails, it uses Resist Correction on the one who tried.
// Ship effects: Hamper Correction (Disadvantage on Correct until the next round), System Lockout (the system
// can't be used until the next round), System Failure (a second Mishap token on the system until Corrected),
// Ship Disruption (the ship's AC −1 until the next round), Hull Stress (PB d8 damage to the ship), Trigger
// Instability (its escalation Mishap, one tier lower, Minor for Minor and Standard), Spread (a Minor version of
// itself; Standard for CR 15+).

import { MODULE_ID, activeMishaps, addMishap, applyHit, syncDisabled, untilActive } from "./ship-state.mjs";
import { MISHAP_TIERS } from "./mishap-links.mjs";
import { bridgeOf, blockAt, mishapWorldActor } from "./ship-hud.mjs";

const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const say = (html, alias) => ChatMessage.implementation.create({ speaker: { alias: alias ?? "Mishap" }, content: `<div class="no-crew-card">${html}</div>` });
const STATUS = { prone: "prone", restrained: "restrained", poisoned: "poisoned", charmed: "charmed", frightened: "frightened",
  blinded: "blinded", deafened: "deafened", stunned: "stunned", incapacitated: "incapacitated", grappled: "grappled", paralyzed: "paralyzed" };

const textOf = item => String(item.system?.description?.value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const bioOf = actor => String(actor.system?.details?.biography?.value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const tierOf = name => MISHAP_TIERS.find(t => t !== "Standard" && name.startsWith(`${t} `)) ?? "Standard";
const baseName = name => name.replace(/^(Minor|Major|Critical|Catastrophic)\s+/, "");
const withTier = (tier, base) => tier === "Standard" ? base : `${tier} ${base}`;

/** The combat this ship is in (any scene), for "until the next round". */
function combatOf(ship) {
  return game.combats.find(c => c.started && c.combatants.some(x => {
    const a = x.token?.actor ?? x.actor;
    return (a === ship) || (a?.uuid === ship.uuid) || (x.token?.actorLink && (x.actorId === (ship.isToken ? ship.token?.actorId : ship.id)));
  })) ?? null;
}
const nextRound = ship => { const c = combatOf(ship); return c ? { combatId: c.id, round: c.round + 1 } : null; };

/** Creatures in a Mishap's work radius: on the bridge, tokens standing on its system card. */
function inRadius(ship, entry) {
  const scene = bridgeOf(ship);
  if ( !scene ) return [];
  const g = scene.grid.size;
  return scene.tokens.filter(t => t.actor && !["vehicle"].includes(t.actor.type) && !t.getFlag(MODULE_ID, "mishapEntry")
    && !t.getFlag(MODULE_ID, "hudBuilt") && !t.hidden && (Number(t.actor.system?.attributes?.hp?.value) > 0)
    && (blockAt(scene, { x: t.x + (t.width * g) / 2, y: t.y + (t.height * g) / 2 }) === entry.system));
}

/** A Mishap's action options: { item, activity, kind } (kind: attack | heal | ship). */
function optionsOf(actor) {
  const out = [];
  for ( const item of actor.items ) {
    const act = item.system.activities?.find(a => a.activation?.type === "action");
    if ( !act ) continue;
    const kind = (act.type === "save") ? "attack" : (act.type === "heal") ? "heal" : "ship";
    out.push({ item, activity: act, kind, name: item.name.replace(/\s*\(.*\)\s*$/, "").trim() });
  }
  return out;
}

const formulaOf = (part, actor) => {
  const f = part?.custom?.enabled ? part.custom.formula : (part?.number && part?.denomination ? `${part.number}d${part.denomination}${part.bonus ? ` + ${part.bonus}` : ""}` : null);
  return f ? Roll.replaceFormulaData(f, actor.getRollData()) : null;
};

/* ---------- creature actions ---------- */

async function saveAction(ship, entry, mishap, opt, targets) {
  const act = opt.activity, dc = Number(mishap.system.attributes?.spell?.dc) || 12;
  const ability = [...(act.save?.ability ?? [])][0] ?? "con";
  const part = act.damage?.parts?.[0];
  const formula = formulaOf(part, mishap);
  const type = [...(part?.types ?? [])][0] ?? "bludgeoning";
  const cond = (textOf(opt.item).match(/Reference\[(\w+)/) ?? [])[1]?.toLowerCase();
  const status = STATUS[cond] ?? null;
  const each = /each creature/i.test(textOf(opt.item));
  const victims = each ? targets : [targets[Math.floor(Math.random() * targets.length)]];
  const lines = [], applied = [...(entry.applied ?? [])];
  for ( const t of victims ) {
    const a = t.actor;
    const rolls = await a.rollSavingThrow({ ability, target: dc }, { configure: false }, { data: { flavor: `${opt.name}: ${CONFIG.DND5E.abilities[ability]?.label ?? ability} save vs DC ${dc} (${entry.name})` } });
    const saved = (rolls?.[0]?.total ?? 0) >= dc;
    let bit = `${esc(t.name)} ${saved ? "saves" : "fails"} (${rolls?.[0]?.total ?? "?"} vs DC ${dc})`;
    if ( formula ) {
      const r = await new Roll(formula).evaluate();
      const amt = saved ? ((act.damage?.onSave === "half") ? Math.floor(r.total / 2) : 0) : r.total;
      await r.toMessage({ speaker: { alias: entry.name }, flavor: `${opt.name}: ${type} damage to ${t.name}${saved ? " (saved)" : ""}` });
      if ( amt > 0 ) await a.applyDamage([{ value: amt, type }]);
      bit += `, takes ${amt} ${type} damage`;
    }
    if ( status && !saved ) {
      await a.toggleStatusEffect(status, { active: true });
      applied.push({ uuid: a.uuid, status });
      bit += `, ${status}`;
    }
    lines.push(bit);
  }
  await entryUpdate(ship, entry.id, { applied });
  return `${opt.name}: ${lines.join("; ")}.`;
}

/** Backfire: a failed Correct draws Resist Correction onto the one who tried. */
export async function backfire(ship, entry, crewActor) {
  const mishap = await mishapWorldActor(entry);
  if ( !mishap || !crewActor ) return;
  const item = mishap.items.find(i => i.name.startsWith("Resist Correction") && i.system.activities?.some(a => a.activation?.type === "reaction"));
  if ( !item ) return;
  const act = item.system.activities.find(a => a.activation?.type === "reaction");
  const scene = bridgeOf(ship);
  const tok = scene?.tokens.find(t => t.actorId === crewActor.id) ?? { actor: crewActor, name: crewActor.name };
  const line = await saveAction(ship, entry, mishap, { item, activity: act, name: "Backfire" }, [tok]);
  await say(`<p><strong>${esc(entry.name)}</strong> backfires: ${esc(line)}</p>`, entry.name);
}

/* ---------- ship actions ---------- */

async function escalationName(mishap, entry, kind) {
  const bio = bioOf(mishap);
  if ( kind === "completion" ) {
    const m = bio.match(/Completion:\s*([^.]+?)\./);
    const picks = (m?.[1] ?? "").split(/\s+or\s+/).map(s => s.replace(/\(CR[^)]*\)/, "").trim()).filter(Boolean);
    return picks.length ? picks[Math.floor(Math.random() * picks.length)] : null;
  }
  const m = bio.match(/Escalation mishap[^:]*:\s*([^.(]+)/);
  return m ? m[1].trim() : null;
}

async function gainMishap(ship, name, system) {
  const pack = game.packs.get(`${MODULE_ID}.actors`);
  const e = pack?.index.find(x => x.name === name);
  if ( !e ) return `(no Mishap named ${esc(name)})`;
  await addMishap(ship, { uuid: e.uuid ?? `Compendium.${pack.collection}.Actor.${e._id}`, name, tier: tierOf(name), system });
  return `<strong>${esc(name)}</strong>`;
}

async function shipAction(ship, entry, mishap, opt) {
  const n = opt.name, until = nextRound(ship), prof = Number(mishap.system.attributes?.prof) || 2;
  switch ( n ) {
    case "Hamper Correction":
      await entryUpdate(ship, entry.id, { hamperUntil: until });
      return "Hamper Correction: Correct against it has Disadvantage until the next round.";
    case "System Lockout":
      await entryUpdate(ship, entry.id, { lockUntil: until });
      return "System Lockout: the system can't be used until the next round.";
    case "System Failure":
      await entryUpdate(ship, entry.id, { extra: 1 });
      await syncDisabled(ship);
      return "System Failure: the system gains a second Mishap token until this Mishap is Corrected.";
    case "Ship Disruption":
      await entryUpdate(ship, entry.id, { acDownUntil: until });
      return "Ship Disruption: the ship's AC drops by 1 until the next round.";
    case "Hull Stress": {
      const r = await new Roll(`${prof}d8`).evaluate();
      await r.toMessage({ speaker: { alias: entry.name }, flavor: "Hull Stress: bludgeoning damage to the ship" });
      await applyHit(ship, { damage: r.total, weapon: `${entry.name} (Hull Stress)` });
      return `Hull Stress: the ship takes ${r.total} damage.`;
    }
    case "Trigger Instability": {
      const esc0 = await escalationName(mishap, entry, "escalation");
      if ( !esc0 ) return "Trigger Instability: no escalation Mishap listed.";
      const t = MISHAP_TIERS.indexOf(tierOf(entry.name));
      const tier = t <= 1 ? "Minor" : MISHAP_TIERS[t - 1];
      return `Trigger Instability: the ship gains ${await gainMishap(ship, withTier(tier, baseName(esc0)), entry.system)}.`;
    }
    case "Spread": {
      const cr = Number(mishap.system.details?.cr) || 1;
      return `Spread: the ship gains ${await gainMishap(ship, withTier(cr >= 15 ? "Standard" : "Minor", baseName(entry.name)), entry.system)}.`;
    }
    default:
      return `${n}: ${textOf(opt.item).slice(0, 200)}`;
  }
}

/* ---------- the turn ---------- */

async function entryUpdate(ship, id, patch) {
  await ship.update({ [`flags.${MODULE_ID}.activeMishaps`]: activeMishaps(ship).map(m => m.id === id ? { ...m, ...patch } : m) });
}

async function liftConditions(ship, entry) {
  for ( const a of entry.applied ?? [] ) {
    const actor = await fromUuid(a.uuid);
    if ( actor?.statuses?.has(a.status) ) await actor.toggleStatusEffect(a.status, { active: false });
  }
  if ( entry.applied?.length ) await entryUpdate(ship, entry.id, { applied: [] });
}

async function mishapTurn(ship, entry0) {
  let entry = activeMishaps(ship).find(m => m.id === entry0.id);
  if ( !entry ) return;
  const mishap = await mishapWorldActor(entry);
  if ( !mishap ) return;
  await liftConditions(ship, entry);
  const prof = Number(mishap.system.attributes?.prof) || 2;
  const max = Number(mishap.system.attributes?.hp?.max) || 20;
  const hp = entry.hp ?? max;
  const n = Math.max(1, prof - 1);
  const last = new Set(entry.lastActions ?? []);
  const targets = inRadius(ship, entry);
  const opts = optionsOf(mishap).filter(o => !last.has(o.name));
  const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
  // Attack a creature when it can (damage first), then heal when hurt, then a ship effect.
  const attacks = targets.length ? shuffle(opts.filter(o => o.kind === "attack"))
    .sort((a, b) => (!!b.activity.damage?.parts?.length) - (!!a.activity.damage?.parts?.length)) : [];
  const heals = (hp < max) ? opts.filter(o => o.kind === "heal") : [];
  // Priority (John, 2026-10-26): a creature in reach first; else hurt the ship; else heal; Hamper last.
  const ships = shuffle(opts.filter(o => (o.kind === "ship") && (o.name !== "Hamper Correction") && !((o.name === "System Failure") && entry.extra)));
  const last2 = opts.filter(o => o.name === "Hamper Correction");
  const chosen = [...attacks, ...ships, ...heals, ...last2].slice(0, n);
  const lines = [];
  for ( const o of chosen ) {
    if ( o.kind === "attack" ) lines.push(await saveAction(ship, entry, mishap, o, inRadius(ship, entry)));
    else if ( o.kind === "heal" ) {
      const f = o.activity.healing?.custom?.enabled ? o.activity.healing.custom.formula : "5";
      const r = await new Roll(Roll.replaceFormulaData(f, mishap.getRollData())).evaluate();
      const cur = activeMishaps(ship).find(m => m.id === entry.id)?.hp ?? max;
      const to = Math.min(max, cur + r.total);
      await entryUpdate(ship, entry.id, { hp: to });
      lines.push(`${o.name}: regains ${to - cur} HP (${to}/${max}).`);
      // Volatile Pressure: healing makes it vent at a creature in reach.
      const rc = optionsOf(mishap).find(x => x.name === "Resist Correction");
      if ( (to > cur) && mishap.items.some(i => i.name.startsWith("Volatile Pressure")) && rc && inRadius(ship, entry).length ) {
        lines.push(`Volatile Pressure vents: ${await saveAction(ship, entry, mishap, rc, inRadius(ship, entry))}`);
      }
    }
    else lines.push(await shipAction(ship, entry, mishap, o));
  }
  if ( !chosen.length ) lines.push("nothing it can do this turn.");
  // Countdown: a Mishap still standing loses a counter; at 0 it completes and worsens.
  entry = activeMishaps(ship).find(m => m.id === entry.id);
  if ( !entry ) return say(`<p><strong>${esc(entry0.name)}</strong> (${esc(entry0.system)}): ${lines.map(esc).join(" ")}</p>`, entry0.name);
  const counters = (entry.counters ?? (prof + 1)) - 1;
  let tail = ` Countdown ${counters}.`;
  if ( (counters <= 0) && mishap.items.some(i => i.name.startsWith("Detonation")) ) {
    tail = ` <strong>Detonates!</strong> ${await detonate(ship, entry, mishap)}`;
  } else if ( counters <= 0 ) {
    const next = await escalationName(mishap, entry, "completion");
    await ship.update({ [`flags.${MODULE_ID}.activeMishaps`]: activeMishaps(ship).filter(m => m.id !== entry.id) });
    tail = ` <strong>Completes</strong> and worsens: ${next ? await gainMishap(ship, next, entry.system) : "(no next Mishap listed)"}.`;
    await syncDisabled(ship);
  } else await entryUpdate(ship, entry.id, { counters, lastActions: chosen.map(o => o.name) });
  await say(`<p><strong>${esc(entry.name)}</strong> on ${esc(entry.system)} acts: ${lines.join(" ")}${tail}</p>`, entry.name);
}

/**
 * Detonation (Explosion Mishaps): instead of Completing, each creature in reach makes a DEX save against
 * (2·PB − 2)d6 fire + (2·PB − 2)d6 thunder (half on a success); the Explosion ends and the ship gains a Fire and one
 * random Mishap, each one severity lower (Minor for Minor and Standard), on the same system.
 */
async function detonate(ship, entry, mishap) {
  const prof = Number(mishap.system.attributes?.prof) || 2, dc = Number(mishap.system.attributes?.spell?.dc) || 12;
  const n = Math.max(1, 2 * prof - 2), bits = [];
  for ( const t of inRadius(ship, entry) ) {
    const rolls = await t.actor.rollSavingThrow({ ability: "dex", target: dc }, { configure: false }, { data: { flavor: `Detonation: DEX save vs DC ${dc} (${entry.name})` } });
    const saved = (rolls?.[0]?.total ?? 0) >= dc;
    const f = await new Roll(`${n}d6`).evaluate(), th = await new Roll(`${n}d6`).evaluate();
    const ff = saved ? Math.floor(f.total / 2) : f.total, tt = saved ? Math.floor(th.total / 2) : th.total;
    await t.actor.applyDamage([{ value: ff, type: "fire" }, { value: tt, type: "thunder" }]);
    bits.push(`${esc(t.name)} ${saved ? "saves" : "fails"}, ${ff} fire + ${tt} thunder`);
  }
  await ship.update({ [`flags.${MODULE_ID}.activeMishaps`]: activeMishaps(ship).filter(m => m.id !== entry.id) });
  const t = MISHAP_TIERS.indexOf(tierOf(entry.name));
  const lower = t <= 1 ? "Minor" : MISHAP_TIERS[t - 1];
  const fire = await gainMishap(ship, withTier(lower, "Fire"), entry.system);
  const { possibleMishaps } = await import("./mishap-links.mjs");
  const ti = MISHAP_TIERS.indexOf(lower);
  const pool = (await possibleMishaps(ship, ti)).filter(p => !p.missing && (tierOf(p.name) === lower) && !/(^|\s)(Fire|Explosion)$/.test(p.name));
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const other = pick ? await gainMishap(ship, pick.name, entry.system) : "(no other Mishap fits)";
  await syncDisabled(ship);
  return `${bits.length ? bits.join("; ") + ". " : ""}The ship gains ${fire} and ${other}.`;
}

/** Every Mishap on the ship takes its turn (GM; end of the ship's turn). */
export async function mishapTurns(ship) {
  for ( const entry of [...activeMishaps(ship)] ) {
    try { await mishapTurn(ship, entry); }
    catch(err) { console.error(`${MODULE_ID} | Mishap turn ${entry.name}`, err); }
  }
}
