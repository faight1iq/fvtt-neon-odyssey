// Ship weapons fired from the HUD (John, 2026-10-25).
//
// The Gunner's Fire, Aimed Shot and Empowered Shot spend their Tempo as before (usage card), then open a
// weapon picker: every weapon whose facing has an enemy ship in its arc and range on this sector map.
// Picking one rolls the attack (Aimed / Empowered: advantage) with the gunner's bonus (the user's character,
// else the ship's crew Gunner bonus), compares it with the target's AC, rolls damage on a hit (a natural 20
// doubles the dice; Empowered adds one more die), and the GM applies the hit as Strain and Mishaps (rule 16,
// ship-state.mjs applyHit). Return fire is the target's Gunner using Fire as its Reaction: the same flow.
//
// Geometry: bow and aft arcs are 120°, port and starboard 60°; a hex on a boundary line is in both; one hex
// is one range band (1 PB, 2 Short, 3 Medium, 4 Long, 5 Extreme).

import { MODULE_ID, systemOfItem, systemOffline, request, baseActor, isSectorScene,
  activeMishaps, removeMishap, crewBonus, shipProf, bridgeScene, shieldsUp, SHIELD_AC, crewOf, getState,
  stationCheck, crewQualitySet, usesOwnStats, fireContext, crewKey, heldDie, dieForPB, commandDice, roleAvailable, disruptionAC, untilActive, disabledReason } from "./ship-state.mjs";
import { actionShip } from "./crew-stations.mjs";
import { launchOptions } from "./torpedoes.mjs";

const FIRE_ACTIONS = { "Fire": "normal", "Aimed Shot": "advantage", "Empowered Shot": "advantage", "Let 'em Have It!": "normal" };
// Let 'em Have It! (John, 2026-10-25): the Gunner's Bonus Action fires a weapon slaved to the station that
// hasn't fired this round. Weapons fired are recorded on the ship until the start of its next turn.
const UNFIRED_ONLY = new Set(["Let 'em Have It!"]);
export const firedThisRound = ship => new Set(ship?.getFlag(MODULE_ID, "fired") ?? []);
async function markFired(ship, item) {
  if ( !ship?.isOwner ) return;
  const fired = firedThisRound(ship);
  if ( fired.has(item.id) ) return;
  fired.add(item.id);
  await ship.setFlag(MODULE_ID, "fired", [...fired]);
}
export const BANDS = ["Point Blank", "Short", "Medium", "Long", "Extreme"];
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

/** Range bands a weapon reaches, as hex distances: "Short–Long" → [2, 4]. */
export function weaponHexes(item) {
  const rb = item?.flags?.[MODULE_ID]?.rangeBand ?? item?.flags?.[MODULE_ID]?.component?.info?.Range ?? "";
  const parts = String(rb).split(/[–-]/).map(s => s.trim()).filter(Boolean)
    .map(s => /^pb$/i.test(s) ? 1 : BANDS.findIndex(b => b.toLowerCase() === s.toLowerCase()) + 1).filter(n => n > 0);
  if ( !parts.length ) return null;
  return [Math.min(...parts), Math.max(...parts)];
}

/**
 * Arcs (John, 2026-10-25): bow and aft are 120° (60° either side of the nose / tail), port and starboard 60°.
 * The boundaries run along the hex rows out of the ship's hex, so a hex that a boundary line passes through
 * counts in both arcs. Returns the arcs the target's hex is in, the one holding its centre first.
 */
const ARC_EDGES = { bow: [-60, 60], starboard: [60, 120], aft: [120, 240], port: [-120, -60] };
const norm = r => ((r % 360) + 540) % 360 - 180;
function relOf(fromDoc, point) {
  const c = fromDoc.object?.center ?? centerOf(fromDoc);
  const brg = Math.toDegrees(Math.atan2(point.x - c.x, -(point.y - c.y)));
  return { rel: norm(brg - (fromDoc.rotation ?? 0)), dist: Math.hypot(point.x - c.x, point.y - c.y) };
}
const mainArc = r => { const a = Math.abs(r); return a <= 60 ? "bow" : a >= 120 ? "aft" : r > 0 ? "starboard" : "port"; };
function arcsOf(fromDoc, toDoc) {
  const { rel, dist } = relOf(fromDoc, centerOf(toDoc));
  const inner = Math.min(toDoc.parent.grid.sizeX, toDoc.parent.grid.sizeY) / 2;   // a hex's inner radius
  const out = [mainArc(rel)];
  for ( const [name, edges] of Object.entries(ARC_EDGES) ) {
    if ( out.includes(name) ) continue;
    // A boundary ray passing within a hex's inner radius of the target's centre (on the near side).
    const onLine = edges.some(e => {
      const d = Math.toRadians(norm(rel - e));
      return (Math.abs(d) < Math.PI / 2) && (Math.abs(dist * Math.sin(d)) <= inner + 0.5);
    });
    if ( onLine ) out.push(name);
  }
  return out;
}
function centerOf(doc) {
  const g = doc.parent.grid, s = doc._source;
  return { x: s.x + (s.width * g.sizeX) / 2, y: s.y + (s.height * g.sizeY) / 2 };
}
const hexes = (a, b) => a.parent.grid.measurePath([centerOf(a), centerOf(b)]).spaces;
const defeated = doc => !!disabledReason(doc.actor) || ((game.combats.find(c => c.started && (c.scene?.id === doc.parent?.id)) ?? game.combat)?.combatants.some(c => c.tokenId === doc.id && c.defeated) ?? false);

/**
 * Every firing solution a ship token has on this scene: [{ item, activity, target, hexes, arc }].
 * @param {TokenDocument} shooter
 */
export function firingSolutions(shooter) {
  const ship = shooter?.actor;
  if ( !ship ) return [];
  const out = [];
  const weapons = ship.items.filter(i => i.type === "weapon" && i.system.activities?.some(a => a.type === "attack"));
  for ( const target of shooter.parent.tokens ) {
    if ( (target.id === shooter.id) || (target.actor?.type !== "vehicle") || (target.disposition === shooter.disposition) ) continue;
    if ( target.hidden || defeated(target) || target.getFlag(MODULE_ID, "radarMirror") || target.getFlag(MODULE_ID, "torpedo") ) continue;
    const d = hexes(shooter, target);
    const arcs = arcsOf(shooter, target);
    // Clock bearing off the shooter's nose (12 = dead ahead, 3 = starboard), to the half hour.
    const { rel } = relOf(shooter, centerOf(target));
    const clock = (() => { const h = Math.round((((rel / 30) + 12) % 12) * 2) / 2; const hh = Math.floor(h) || 12; return `${hh}:${(h % 1) ? "30" : "00"}`; })();
    const arc = arcs[0];
    for ( const item of weapons ) {
      const sys = systemOfItem(item);
      if ( !arcs.includes(sys) || systemOffline(ship, sys) ) continue;
      const r = weaponHexes(item);
      if ( !r || (d < r[0]) || (d > r[1]) ) continue;
      out.push({ item, activity: item.system.activities.find(a => a.type === "attack"), target, hexes: d, arc: sys, clock });
    }
  }
  return out;
}

/** The token that stands for this ship on the current scene. */
function shipToken(ship) {
  if ( !ship ) return null;
  if ( ship.isToken ) return ship.token;
  const base = baseActor(ship) ?? ship;
  const tokens = canvas.scene?.tokens.filter(t => (t.actor === ship) || (t.actorLink && t.actorId === base.id)) ?? [];
  return tokens.find(t => t.object?.controlled) ?? tokens[0] ?? null;
}

/** The weapon picker. Resolves { solution, mode } or null. */
async function pickShot(solutions, mode, action, ship = null, die = null) {
  const targeted = new Set([...game.user.targets].map(t => t.id));
  const pre = Math.max(0, solutions.findIndex(s => targeted.has(s.target.id)));
  const ap = attackArc(ship);
  if ( ap && (solutions[pre]?.arc === ap) && (mode === "normal") ) mode = "advantage";
  const rows = solutions.map((s, i) => `<label class="nsf-row"><input type="radio" name="shot" value="${i}" ${i === pre ? "checked" : ""}>
    <img src="${esc(s.item.img)}" width="28" height="28"> <span><strong>${s.launch ? `Launch ${esc(s.size)} Torpedo (${esc(s.item.name)})` : esc(s.item.name)}</strong> → ${esc(s.target.name)} (${esc(s.target.id.slice(0, 2))}) at ${s.clock}
    <em>${s.hexes} hex${s.hexes === 1 ? "" : "es"} (${BANDS[s.hexes - 1] ?? "beyond Extreme"}), ${s.arc}, ${s.launch ? `DEX save DC ${({ Small: 15, Medium: 14, Large: 13 })[s.size]}` : `AC ${s.target.actor?.system.attributes?.ac?.value ?? "?"}`}${s.fired ? ", already fired this round" : ""}</em></span></label>`).join("");
  const modes = ["normal", "advantage", "disadvantage"].map(m => `<option value="${m}" ${m === mode ? "selected" : ""}>${m[0].toUpperCase() + m.slice(1)}</option>`).join("");
  return foundry.applications.api.DialogV2.prompt({
    window: { title: `${action}: choose a weapon and target` },
    content: `<div class="nsf-list">${rows}</div>
      <div class="form-group"><label>Roll</label><select name="mode">${modes}</select></div>
      ${die ? `<div class="form-group"><label>Add Command die (${die})</label><input type="checkbox" name="die"></div>` : ""}
      <p class="hint">Advantage: Aimed Shot, Empowered Shot, the Navigator's Target Lock on this arc, or the Helmsman's Attack Position on this facing${ap ? ` (now: ${ARCS[ap]})` : ""}.</p>`,
    ok: { label: "Fire", callback: (event, button) => ({ index: Number(button.form.elements.shot.value), mode: button.form.elements.mode.value,
      die: !!button.form.elements.die?.checked }) },
    rejectClose: false
  }).then(r => r ? { solution: solutions[r.index], mode: r.mode, useDie: r.die } : null);
}

/** Fire one weapon at one target and send the hit to the GM. */
export async function fireShot({ solution, mode, empowered = false, shooter }) {
  const { item, activity, target } = solution;
  // Target the ship so the dnd5e cards show it.
  target.object?.setTarget(true, { releaseOthers: true, groupSelection: false });
  // A missile gives the target's Navigator a Countermeasures reaction: Disadvantage on this attack.
  let counterDis = false;
  if ( item.flags?.[MODULE_ID]?.component?.info?.Delivery === "Missile" ) {
    const cm = await request({ action: "countermeasures", uuid: target.uuid, attackerUuid: shooter.uuid, weapon: item.name, attacker: shooter.name }, { timeout: 200000 });
    counterDis = !!cm?.use;
  }
  const rolls = await activity.rollAttack({ advantage: mode === "advantage", disadvantage: (mode === "disadvantage") || counterDis },
    { configure: false }, {});
  const roll = Array.isArray(rolls) ? rolls[0] : rolls;
  if ( !roll ) return null;   // e.g. out of ammo
  let ac = (Number(target.actor?.system.attributes?.ac?.value) || 10) + (shieldsUp(target.actor) ? SHIELD_AC : 0) - disruptionAC(target.actor);
  const nat = roll.dice?.[0]?.total;
  const crit = roll.isCritical ?? (nat === 20);
  let hit = crit || (!(roll.isFumble ?? (nat === 1)) && (roll.total >= ac));
  // The target may Divert Power to Shields before damage is rolled (+5 AC, including against this attack).
  if ( hit && !crit ) {
    const pre = await request({ action: "preDamage", uuid: target.uuid, attackerUuid: shooter.uuid, total: roll.total, ac,
      weapon: item.name, attacker: shooter.name }, { timeout: 200000 });
    if ( pre?.acBonus ) { ac += pre.acBonus; hit = roll.total >= ac; }
  }
  let damage = 0;
  if ( hit ) {
    const dmg = await activity.rollDamage({ isCritical: crit }, { configure: false }, {});
    damage = (Array.isArray(dmg) ? dmg : [dmg]).reduce((n, r) => n + (r?.total ?? 0), 0);
    if ( empowered ) {
      const die = String(item.system.damage?.base?.denomination ? `1d${item.system.damage.base.denomination}` : "1d4");
      const extra = await new Roll(die).evaluate();
      await extra.toMessage({ flavor: `${item.name}: Empowered Shot extra die`, speaker: ChatMessage.implementation.getSpeaker({ actor: shooter.actor }) });
      damage += extra.total;
    }
  }
  if ( game.combats.some(c => c.started && (c.scene?.id === shooter.parent?.id)) ) await markFired(shooter.actor, item);
  await ChatMessage.implementation.create({
    content: `<div class="no-crew-card"><p><strong>${esc(shooter.name)}</strong> fires <strong>${esc(item.name)}</strong> at <strong>${esc(target.name)}</strong>:
      ${roll.total} vs AC ${ac}, <strong>${crit ? "critical hit" : hit ? "hit" : "miss"}</strong>${hit ? `, ${damage} damage` : ""}.</p></div>`,
    speaker: ChatMessage.implementation.getSpeaker({ actor: shooter.actor }), flags: { [MODULE_ID]: { crewResult: true } }
  });
  if ( hit ) {
    await request({ action: "hit", uuid: target.uuid, attackerUuid: shooter.uuid, damage, crit,
      size: item.flags?.[MODULE_ID]?.component?.size ?? item.flags?.[MODULE_ID]?.component?.info?.Size ?? "Tiny",
      weapon: item.name, attacker: shooter.name }, { timeout: 200000 });
  }
  return { hit, crit, damage, total: roll.total, ac };
}

// Attack Position (John, 2026-10-25): the Helmsman picks one of the ship's facings; gunners firing weapons on
// that facing have advantage until the beginning of the pilot's next turn (cleared with the ship's econ).
const ARCS = { bow: "Bow", port: "Port", starboard: "Starboard", aft: "Aft" };
export const attackArc = ship => ship?.getFlag(MODULE_ID, "attackPosition")?.arc ?? null;
Hooks.on("dnd5e.postUseActivity", activity => {
  if ( activity?.name !== "Attack Position" ) return;
  const ship = actionShip(activity.item.actor);
  if ( !ship ) return;
  setTimeout(async () => {
    const opts = Object.entries(ARCS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
    const arc = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Attack Position: which facing?" },
      content: `<div class="form-group"><label>Facing</label><select name="arc">${opts}</select></div>
        <p class="hint">Gunners firing weapons on this facing have advantage until the beginning of your next turn.</p>`,
      ok: { label: "Set", callback: (event, button) => button.form.elements.arc.value },
      rejectClose: false
    });
    if ( !arc ) return;
    await ship.setFlag(MODULE_ID, "attackPosition", { arc, by: game.user.id });
    await ChatMessage.implementation.create({
      content: `<div class="no-crew-card"><p><strong>Attack Position:</strong> ${esc(ship.name)}'s ${ARCS[arc]} gunners have advantage until the beginning of the pilot's next turn.</p></div>`,
      speaker: ChatMessage.implementation.getSpeaker({ actor: ship })
    });
  }, 0);
});

// The Gunner's firing actions open the weapon picker once their Tempo is paid.
Hooks.on("dnd5e.postUseActivity", activity => {
  const role = activity?.item?.getFlag(MODULE_ID, "crewRole");
  if ( role !== "gunner" || !(activity.name in FIRE_ACTIONS) ) return;
  const ship = actionShip(activity.item.actor);   // before any await: the HUD's ship context is cleared after use()
  if ( !ship || !isSectorScene(canvas.scene) ) return;
  const shooter = shipToken(ship);
  if ( !shooter ) return;
  const action = activity.name;
  setTimeout(async () => {
    let sols = firingSolutions(shooter);
    // Torpedo tubes launch with a plain Fire (John, 2026-10-26).
    if ( action === "Fire" ) for ( const l of launchOptions(shooter) ) {
      const { rel } = relOf(shooter, centerOf(l.target));
      const h = Math.round((((rel / 30) + 12) % 12) * 2) / 2;
      sols.push({ ...l, clock: `${Math.floor(h) || 12}:${(h % 1) ? "30" : "00"}` });
    }
    if ( UNFIRED_ONLY.has(action) ) {
      const fired = firedThisRound(ship);
      sols = sols.filter(s => !fired.has(s.item.id));
      if ( !sols.length ) return ui.notifications.warn(`${shooter.name}: no unfired weapon has an enemy ship in its arc and range.`);
    }
    if ( !sols.length ) return ui.notifications.warn(`${shooter.name}: no weapon has an enemy ship in its arc and range.`);
    const firedSet = firedThisRound(ship);
    for ( const s of sols ) s.fired = firedSet.has(s.item.id);
    // The character at the Gunnery Station (null = the ship's own crew); a paired skill gives Advantage.
    const crewActor = activity.item.actor;
    const gunner = usesOwnStats(crewActor, ship) ? crewActor : null;
    const chk = stationCheck(ship, gunner, "gunner");
    let mode = FIRE_ACTIONS[action];
    if ( chk.advantage && (mode === "normal") ) mode = "advantage";
    const dieKey = crewKey(ship, gunner, "gunner");
    const pick = await pickShot(sols, mode, action, ship, heldDie(ship, dieKey));
    if ( !pick ) return;
    if ( pick.solution.launch ) {
      await markFired(ship, pick.solution.item);
      await request({ action: "launchTorpedo", uuid: shooter.uuid, itemId: pick.solution.item.id, targetUuid: pick.solution.target.uuid }, { timeout: 300000 });
      return;
    }
    fireContext.gunner = gunner;
    fireContext.commandDie = pick.useDie ? await spendDie(ship, dieKey) : null;
    try { await fireShot({ solution: pick.solution, mode: pick.mode, empowered: action === "Empowered Shot", shooter }); }
    finally { fireContext.gunner = undefined; fireContext.commandDie = null; }
  }, 0);
});


/* -------------------------------------------- */
/*  Correct on ships without a bridge scene      */
/* -------------------------------------------- */
// (John, 2026-10-25) An enemy ship has no bridge scene to fight a Mishap on. Its Correct is a contest: the
// crew's check (d20 + its Any Station crew bonus) against the Mishap's Athletics. If the crew wins, the Mishap
// takes d8 + the ship's PB; at 0 HP it is removed (and Strain drops by its tier, removeMishap). Ties go to the
// Mishap. The GM picks the Mishap when there are several.
const SYS_LABEL = { bow: "Bow", port: "Port", starboard: "Starboard", aft: "Aft", command: "Command & Control",
  navigation: "Navigation", habitat: "Habitat", power: "Power", propulsion: "Propulsion", armor: "Armor", hull: "Hull" };
async function mishapMaxHp(entry) {
  const a = entry?.uuid ? await fromUuid(entry.uuid) : null;
  return { max: Number(a?.system?.attributes?.hp?.max) || 20, ath: Number(a?.system?.skills?.ath?.total ?? a?.system?.skills?.ath?.mod) || 0 };
}
// Medic's Triage and Cook's Fire Team (John, 2026-10-26) are Corrects without leaving the station, with
// Advantage, limited to Crew Injury (Triage) or Fire / Explosion / Habitat Mishaps (Fire Team).
const CORRECTS = {
  "Correct": { advantage: false, filter: () => true },
  "Triage": { advantage: true, filter: m => /crew[\s-]*injur/i.test(m.name ?? ""), none: "no Crew Injury Mishaps" },
  "Fire Team": { advantage: true, filter: m => /(^|\s)(Fire|Explosion)$/i.test(m.name ?? "") || (m.system === "habitat"), none: "no Fire, Explosion or Habitat Mishaps" }
};
// At the table, on a ship with a bridge (John, 2026-10-26): Correct, Triage and Fire Team work on the Mishap token the
// crew member has targeted (else the worst one they may work on). Correct walks them there; the contest (crew
// check against the Mishap's Athletics, d8 + ship PB repair) is rolled by the GM.
const CORRECT_ROLE = { "Correct": "any", "Triage": "medic", "Fire Team": "cook" };
Hooks.on("dnd5e.postUseActivity", activity => {
  const name = activity?.name;
  if ( !CORRECT_ROLE[name] ) return;
  const crew = activity.item?.actor;
  const ship = crew && (crew.type !== "vehicle") ? actionShip(crew) : null;
  if ( !ship || !bridgeScene(ship) || ship.getFlag(MODULE_ID, "autoRun") ) return;
  const target = [...game.user.targets].find(t => t.document.getFlag(MODULE_ID, "mishapEntry"));
  setTimeout(async () => {
    const res = await request({ action: "correctMishap", uuid: ship.uuid, name, crewId: crew.id, id: target?.document.getFlag(MODULE_ID, "mishapEntry") ?? null });
    if ( res && !res.ok ) ui.notifications.warn(res.error ?? `${name} failed.`);
  }, 0);
});

/** GM: a Correct-type action on a bridge ship, against a chosen Mishap (or the worst one it may work on). */
export async function correctMishapGM(ship, { name, crewId, id }) {
  const kind = CORRECTS[name];
  const crew = game.actors.get(crewId);
  if ( !kind || !crew ) return { ok: false, error: "No such action or crew member." };
  const TIER = ["Minor", "Standard", "Major", "Critical", "Catastrophic"];
  const list = activeMishaps(ship).filter(kind.filter);
  if ( !list.length ) return { ok: false, error: `${ship.name}: ${kind.none ?? "no Mishaps to Correct"}.` };
  const fire = m => /(^|\s)Fire$/i.test(m.name ?? "");
  const pick = list.find(m => m.id === id)
    ?? [...list].sort((a, b) => (fire(b) - fire(a)) || (TIER.indexOf(b.tier) - TIER.indexOf(a.tier)))[0];
  const line = await runCorrect(ship, name, { pickId: pick.id, bonus: stationCheck(ship, crew, CORRECT_ROLE[name]).bonus, crew: name === "Correct" ? crew : null });
  return { ok: true, line };
}
Hooks.on("dnd5e.postUseActivity", activity => {
  const kind = CORRECTS[activity?.name];
  if ( !kind || !game.user.isGM ) return;
  const ship = actionShip(activity.item.actor);
  if ( !ship ) return;
  if ( bridgeScene(ship) && !ship.getFlag(MODULE_ID, "autoRun") ) return;   // ships with a bridge work Mishaps there
  setTimeout(() => runCorrect(ship, activity.name), 0);
});

/** The Correct contest on a ship (no bridge, or autopilot). Picks the worst eligible Mishap when not asked. */
export async function runCorrect(ship, name = "Correct", { pickId = null, bonus: bonusOverride = null, crew: walker = null } = {}) {
  const kind = CORRECTS[name];
  if ( !kind ) return null;
  {
    const list = activeMishaps(ship).filter(kind.filter);
    if ( !list.length ) { ui.notifications.info(`${ship.name}: ${kind.none ?? "no Mishaps to Correct"}.`); return null; }
    const TIER = ["Minor", "Standard", "Major", "Critical", "Catastrophic"];
    let id = pickId ?? (ship.getFlag(MODULE_ID, "autoRun") ? [...list].sort((x, y) => TIER.indexOf(y.tier) - TIER.indexOf(x.tier))[0].id : list[0].id);
    if ( (list.length > 1) && !pickId && !ship.getFlag(MODULE_ID, "autoRun") ) {
      const opts = list.map(m => `<option value="${m.id}">${esc(m.name)} (${esc(m.tier)}) on ${esc(SYS_LABEL[m.system] ?? m.system)}${m.hp != null ? `, ${m.hp} HP left` : ""}</option>`).join("");
      id = await foundry.applications.api.DialogV2.prompt({
        window: { title: "Correct: which Mishap?" },
        content: `<div class="form-group"><label>Mishap</label><select name="m">${opts}</select></div>`,
        ok: { label: "Correct", callback: (event, button) => button.form.elements.m.value },
        rejectClose: false
      });
      if ( !id ) return null;
    }
    const entry = list.find(m => m.id === id);
    // A character who leaves their station walks to the Mishap on the bridge (not for Triage or Fire Team).
    if ( walker && (name === "Correct") && (walker.type !== "vehicle") ) {
      try { await (await import("./ship-hud.mjs")).crewToMishap(ship, walker, entry); } catch(err) { console.warn(`${MODULE_ID} | crew to Mishap`, err); }
    }
    const { max, ath } = await mishapMaxHp(entry);
    const hp = entry.hp ?? max;
    const bonus = bonusOverride ?? crewBonus(ship, "any");
    // Hamper Correction (until the next round) or a crew member Charmed by a Mishap: Disadvantage.
    const hampered = untilActive(entry.hamperUntil) || !!walker?.statuses?.has?.("charmed");
    const dice = (kind.advantage && !hampered) ? "2d20kh" : (hampered && !kind.advantage) ? "2d20kl" : "1d20";
    const crew = await new Roll(`${dice} + ${bonus}`).evaluate();
    const res = await new Roll(`1d20 + ${ath}`).evaluate();
    const speaker = ChatMessage.implementation.getSpeaker({ actor: ship });
    await crew.toMessage({ speaker, flavor: `${name} on ${entry.name}: crew check (crew +${bonus}${kind.advantage ? ", Advantage" : ""}${hampered ? ", Disadvantage (hampered)" : ""})` });
    await res.toMessage({ speaker: { alias: entry.name }, flavor: `${entry.name} resists repair (Athletics ${ath >= 0 ? "+" : ""}${ath})` });
    let line;
    if ( crew.total > res.total ) {
      const pb = shipProf(ship);
      const dmg = await new Roll(`1d8 + ${pb}`).evaluate();
      await dmg.toMessage({ speaker, flavor: `Correct: repair damage to ${entry.name} (d8 + ship PB ${pb})` });
      const left = Math.max(0, hp - dmg.total);
      if ( left <= 0 ) {
        await removeMishap(ship, entry.id);
        line = `Crew wins (${crew.total} vs ${res.total}): ${dmg.total} repair, ${entry.name} is at 0 HP and is removed.`;
      } else {
        await ship.update({ [`flags.${MODULE_ID}.activeMishaps`]: activeMishaps(ship).map(m => m.id === entry.id ? { ...m, hp: left } : m) });
        line = `Crew wins (${crew.total} vs ${res.total}): ${dmg.total} repair, ${entry.name} has ${left} of ${max} HP left.`;
      }
    } else {
      line = `${entry.name} holds (${res.total} vs ${crew.total}): no repair.`;
      // Backfire: the Mishap answers a failed Correct against the one who tried (its reaction).
      if ( walker ) { try { await (await import("./mishap-turns.mjs")).backfire(ship, entry, walker); } catch(err) { console.warn(`${MODULE_ID} | backfire`, err); } }
    }
    await ChatMessage.implementation.create({ content: `<div class="no-crew-card"><p><strong>Correct:</strong> ${line}</p></div>`, speaker });
    return line;
  }
}


/* -------------------------------------------- */
/*  Electronic Warfare: pick a target            */
/* -------------------------------------------- */
// (John, 2026-10-25) The Navigator picks an enemy ship within Extreme range (5 hexes or closer; beyond that
// it is half a light-second away, too far for meaningful EW), in any arc. Computers check against DC 10 + the
// target's Tempo (a Navigation station check). On a success: the target gains 3 Strain, or loses 3 Tempo (+2 if
// Reroute Power is on Navigation), or one of its stations has
// disadvantage until the end of its next turn.
export const EW_MAX_HEXES = 5;
const STATIONS = ["Commander", "Helmsman", "Navigator", "Engineer", "Gunner"];
export function ewTargets(shooter) {
  const out = [];
  for ( const target of shooter.parent.tokens ) {
    if ( (target.id === shooter.id) || (target.actor?.type !== "vehicle") || (target.disposition === shooter.disposition) ) continue;
    if ( target.hidden || defeated(target) || target.getFlag(MODULE_ID, "radarMirror") || target.getFlag(MODULE_ID, "torpedo") ) continue;
    const d = hexes(shooter, target);
    if ( d > EW_MAX_HEXES ) continue;
    const { rel } = relOf(shooter, centerOf(target));
    const h = Math.round((((rel / 30) + 12) % 12) * 2) / 2;
    out.push({ target, hexes: d, clock: `${Math.floor(h) || 12}:${(h % 1) ? "30" : "00"}`, tempo: getState(target.actor).tempo });
  }
  return out.sort((a, b) => a.hexes - b.hexes);
}
// Effects use fixed numbers (John, 2026-10-25): 3, and Reroute Power on Navigation adds 2.
export const EW_AMOUNT = 3, REROUTE_BONUS = 2;
Hooks.on("dnd5e.postUseActivity", activity => {
  if ( activity?.name !== "Electronic Warfare" || activity.item?.getFlag(MODULE_ID, "crewRole") !== "navigator" ) return;
  const navigator = activity.item.actor;
  const ship = actionShip(navigator);
  if ( !ship || !isSectorScene(canvas.scene) ) return;
  const shooter = shipToken(ship);
  if ( !shooter ) return;
  setTimeout(async () => {
    const list = ewTargets(shooter);
    if ( !list.length ) return ui.notifications.warn(`${shooter.name}: no enemy ship within Extreme range (${EW_MAX_HEXES} hexes).`);
    const targeted = new Set([...game.user.targets].map(t => t.id));
    const pre = Math.max(0, list.findIndex(e => targeted.has(e.target.id)));
    const navChar = (navigator?.type !== "vehicle") ? navigator : null;
    const chk = stationCheck(ship, navChar, "navigator");
    const dieKey = crewKey(ship, navChar, "navigator"), die = heldDie(ship, dieKey);
    const bonus = chk.bonus, label = `Navigation station: ${chk.label}`;
    const base = EW_AMOUNT, eng = REROUTE_BONUS;
    const rows = list.map((e, i) => `<label class="nsf-row"><input type="radio" name="t" value="${i}" ${i === pre ? "checked" : ""}>
      <span><strong>${esc(e.target.name)} (${esc(e.target.id.slice(0, 2))})</strong> at ${e.clock}
      <em>${e.hexes} hex${e.hexes === 1 ? "" : "es"} (${BANDS[e.hexes - 1] ?? "Extreme"}), Tempo ${e.tempo}: DC ${10 + e.tempo}</em></span></label>`).join("");
    const pick = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Electronic Warfare: choose a target" },
      content: `<div class="nsf-list">${rows}</div>
        <div class="form-group"><label>Roll</label><select name="mode"><option value="normal">Normal</option><option value="advantage" ${chk.dice === "2d20kh" ? "selected" : ""}>Advantage</option><option value="disadvantage" ${chk.dice === "2d20kl" ? "selected" : ""}>Disadvantage</option></select></div>
        <div class="form-group"><label>On a success</label><select name="effect">
          <option value="strain">Target gains Strain</option><option value="tempo">Target loses Tempo</option><option value="disadv">One of its stations has disadvantage</option></select></div>
        <div class="form-group"><label>Station (disadvantage)</label><select name="station">${STATIONS.map(s => `<option>${s}</option>`).join("")}</select></div>
        <div class="form-group"><label>Reroute Power on Navigation</label><input type="checkbox" name="reroute"></div>
        ${die ? `<div class="form-group"><label>Add Command die (${die})</label><input type="checkbox" name="die"></div>` : ""}
        <p class="hint">Check: d20 + ${bonus} (${esc(label)}). Effect: ${base}, +${eng} with Reroute Power on Navigation.</p>`,
      ok: { label: "Jam", callback: (event, button) => { const f = button.form.elements; return { i: Number(f.t.value), mode: f.mode.value,
        effect: f.effect.value, station: f.station.value, reroute: f.reroute.checked, die: !!f.die?.checked }; } },
      rejectClose: false
    });
    if ( !pick ) return;
    const e = list[pick.i];
    const dc = 10 + e.tempo;
    const dice = pick.mode === "advantage" ? "2d20kh" : pick.mode === "disadvantage" ? "2d20kl" : "1d20";
    const extra = pick.die ? await spendDie(ship, dieKey) : null;
    const roll = await new Roll(`${dice} + ${bonus}${extra ? ` + ${extra}` : ""}`).evaluate();
    await roll.toMessage({ speaker: ChatMessage.implementation.getSpeaker({ actor: navigator }),
      flavor: `Electronic Warfare on ${e.target.name} (${e.target.id.slice(0, 2)}), ${e.hexes} hexes: ${label} check${pick.mode !== "normal" ? ` with ${pick.mode}` : ""} vs DC ${dc} (10 + its Tempo)` });
    if ( roll.total < dc ) {
      return ChatMessage.implementation.create({ content: `<div class="no-crew-card"><p><strong>Electronic Warfare fails</strong> (${roll.total} vs DC ${dc}).</p></div>`,
        speaker: ChatMessage.implementation.getSpeaker({ actor: navigator }) });
    }
    const amount = base + (pick.reroute ? eng : 0);
    await request({ action: "ewEffect", uuid: e.target.uuid, attackerUuid: shooter.uuid, effect: pick.effect, amount,
      station: pick.station, attacker: `${shooter.name} (${roll.total} vs DC ${dc})` });
  }, 0);
});


/* -------------------------------------------- */
/*  Rally: Command dice                          */
/* -------------------------------------------- */
/** Use a banked Command die: returns its roll term ("1d4"), or null. */
export async function spendDie(ship, key) {
  const res = await request({ action: "spendDie", uuid: ship.uuid, key });
  return res?.ok ? `1${res.die}` : null;
}
/** The crew a Commander can Rally: characters on the ship's stations, else the ship's own stations. */
function rallyTargets(ship, commander) {
  const base = baseActor(ship) ?? ship;
  const chars = Object.entries(crewOf(base)).filter(([, r]) => r?.length).map(([id, r]) => ({ actor: game.actors.get(id), roles: r }))
    .filter(c => c.actor && (c.actor !== commander));
  if ( chars.length ) return chars.map(c => ({ key: c.actor.id, name: `${c.actor.name} (${c.roles.filter(x => x !== "any").join(", ") || "Deck"})` }));
  const roles = ["helmsman", "navigator", "engineer", "gunner"].filter(r => roleAvailable(ship, r));
  const keys = new Map();
  for ( const r of roles ) { const k = crewKey(ship, null, r); if ( !keys.has(k) ) keys.set(k, k === "crew" ? "Crew" : r[0].toUpperCase() + r.slice(1)); }
  return [...keys].map(([key, name]) => ({ key, name }));
}
Hooks.on("dnd5e.postUseActivity", activity => {
  if ( activity?.name !== "Rally" || activity.item?.getFlag(MODULE_ID, "crewRole") !== "commander" ) return;
  const commander = activity.item.actor;
  const ship = actionShip(commander);
  if ( !ship ) return;
  setTimeout(async () => {
    const pb = (commander?.type !== "vehicle") ? (Number(commander.system?.attributes?.prof) || 2) : shipProf(ship);
    const die = dieForPB(pb);
    const held = commandDice(ship);
    const list = rallyTargets(ship, commander);
    if ( !list.length ) return ui.notifications.warn("Rally: no crew to Rally.");
    const opts = list.map(c => `<option value="${c.key}" ${held[c.key] ? "disabled" : ""}>${esc(c.name)}${held[c.key] ? ` (holds ${held[c.key].die})` : ""}</option>`).join("");
    const key = await foundry.applications.api.DialogV2.prompt({
      window: { title: `Rally: give a Command die (${die})` },
      content: `<div class="form-group"><label>Crew member</label><select name="k">${opts}</select></div>
        <p class="hint">Banked until used; one per crew member. Add it to an attack roll, ability check or saving throw before the result is known.</p>`,
      ok: { label: "Rally", callback: (event, button) => button.form.elements.k.value },
      rejectClose: false
    });
    if ( !key ) return;
    const c = list.find(x => x.key === key);
    await request({ action: "grantDie", uuid: ship.uuid, key, die, name: c?.name?.replace(/ \(.*$/, "") ?? key,
      from: (commander?.type !== "vehicle") ? commander.name : `${ship.name}'s Commander` });
  }, 0);
});

// A die armed from the HUD goes on this client's next attack roll, ability check or saving throw.
export const armedDie = { ship: null, key: null, die: null };
export function armDie(ship, key, die) {
  if ( armedDie.key === key && armedDie.ship === ship ) { armedDie.ship = armedDie.key = armedDie.die = null; return false; }
  Object.assign(armedDie, { ship, key, die });
  ui.notifications.info(`Command die (${die}) armed: it goes on your next attack roll, ability check or saving throw.`);
  return true;
}
const useArmed = (config) => {
  if ( !armedDie.die || fireContext.commandDie ) return;
  const { ship, key, die } = armedDie;
  armedDie.ship = armedDie.key = armedDie.die = null;
  config.parts = [...(config.parts ?? []), `1${die}`];
  request({ action: "spendDie", uuid: ship.uuid, key });
};
Hooks.on("dnd5e.postBuildD20TestRollConfig", (process, config) => useArmed(config));
Hooks.on("dnd5e.postBuildAttackRollConfig", (process, config) => {
  if ( fireContext.commandDie ) {
    if ( !config.parts?.includes(fireContext.commandDie) ) config.parts = [...(config.parts ?? []), fireContext.commandDie];
    return;
  }
  useArmed(config);
});


/* -------------------------------------------- */
/*  Cook: Hot Meal (John, 2026-10-26)            */
/* -------------------------------------------- */
// Before an encounter: a Galley station check, DC 12. Success: the ship starts its next encounter with +2
// Tempo (+4 on a 20 or more). Applied and cleared when the encounter starts (ship-state combatStart).
Hooks.on("dnd5e.postUseActivity", activity => {
  if ( activity?.name !== "Hot Meal" || activity.item?.getFlag(MODULE_ID, "crewRole") !== "cook" ) return;
  const cook = activity.item.actor;
  const ship = actionShip(cook);
  if ( !ship ) return;
  setTimeout(async () => {
    if ( game.combat?.started && game.combat.combatants.some(c => (c.token?.actor ?? c.actor)?.uuid === ship.uuid
      || (c.token?.actorLink && c.actorId === (baseActor(ship) ?? ship).id)) ) {
      return ui.notifications.warn("Hot Meal is served before an encounter, not during one.");
    }
    const who = usesOwnStats(cook, ship) ? cook : null;
    const chk = stationCheck(ship, who, "cook");
    const key = crewKey(ship, who, "cook"), die = heldDie(ship, key);
    let extra = null;
    if ( die && await foundry.applications.api.DialogV2.confirm({ window: { title: "Hot Meal" }, content: `<p>Add your Command die (${die})?</p>`, rejectClose: false }) ) extra = await spendDie(ship, key);
    const roll = await new Roll(`${chk.dice} + ${chk.bonus}${extra ? ` + ${extra}` : ""}`).evaluate();
    await roll.toMessage({ speaker: ChatMessage.implementation.getSpeaker({ actor: cook }), flavor: `Hot Meal: Galley station check (${chk.label}) vs DC 12` });
    const bonus = roll.total >= 20 ? 4 : roll.total >= 12 ? 2 : 0;
    if ( bonus ) await ship.setFlag(MODULE_ID, "hotMeal", bonus);
    await ChatMessage.implementation.create({ speaker: ChatMessage.implementation.getSpeaker({ actor: cook }),
      content: `<div class="no-crew-card"><p><strong>Hot Meal:</strong> ${bonus ? `${esc(ship.name)} starts its next encounter with <strong>+${bonus} Tempo</strong>.` : "the crew picks at it; no bonus."}</p></div>` });
  }, 0);
});

/* -------------------------------------------- */
/*  Deck crew: Fire Suppression (John, 2026-10-26) */
/* -------------------------------------------- */
// From the station: a targeted Fire (Mishap token) or the worst Fire on the ship drops a level.
Hooks.on("dnd5e.postUseActivity", activity => {
  if ( activity?.name !== "Fire Suppression" ) return;
  const crew = activity.item?.actor;
  const ship = crew ? actionShip(crew) : null;
  if ( !ship ) return;
  const target = [...game.user.targets].find(t => t.document.getFlag(MODULE_ID, "mishapEntry"));
  setTimeout(async () => {
    const res = await request({ action: "suppressFire", uuid: ship.uuid, id: target?.document.getFlag(MODULE_ID, "mishapEntry") ?? null, by: crew.name });
    if ( res && !res.ok ) ui.notifications.warn(res.error ?? "Fire Suppression failed.");
  }, 0);
});

/* -------------------------------------------- */
/*  Medic: Stim Shot (John, 2026-10-26)          */
/* -------------------------------------------- */
// One crew member ignores Impaired Disadvantage for 1 minute (10 rounds).
Hooks.on("dnd5e.postUseActivity", activity => {
  if ( activity?.name !== "Stim Shot" || activity.item?.getFlag(MODULE_ID, "crewRole") !== "medic" ) return;
  const medic = activity.item.actor;
  const ship = actionShip(medic);
  if ( !ship ) return;
  setTimeout(async () => {
    const crew = Object.keys(crewOf(baseActor(ship) ?? ship)).map(id => game.actors.get(id)).filter(Boolean);
    if ( !crew.length ) return ui.notifications.warn(`${ship.name} has no crew characters to treat.`);
    const opts = crew.map(c => `<option value="${c.id}" ${c.id === medic.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    const id = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Stim Shot" },
      content: `<div class="form-group"><label>Crew member</label><select name="c">${opts}</select></div><p class="hint">Ignores Impaired Disadvantage for 1 minute.</p>`,
      ok: { label: "Inject", callback: (event, button) => button.form.elements.c.value },
      rejectClose: false
    });
    if ( !id ) return;
    const res = await request({ action: "stim", uuid: ship.uuid, actorId: id, from: medic.name });
    if ( res && !res.ok ) ui.notifications.warn(res.error ?? "Stim Shot failed.");
  }, 0);
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).fire = { firingSolutions, fireShot, weaponHexes, pickShot, attackArc, arcsOf, ewTargets, spendDie, armDie, armedDie, runCorrect, firedThisRound, launchOptions };
});
