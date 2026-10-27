// Torpedoes on the sector map (John, 2026-10-26; rules 21–24, 31, 32 in starship-designer-v2-rule-changes).
//
// Launch: the Gunner's Fire (1 Tempo) can launch a tube's torpedo at an enemy ship in the tube's facing. Each
//   tube launches once a round while torpedoes of its size remain (loaded + magazine reloads; reloading is
//   automatic). The torpedo appears beside the launcher and moves at once.
// Movement: homing, with the same turning and forward costs as ships (John, 2026-10-26), from its Speed; it stops
//   at Point Blank (1 hex) from its target. It moves again each round right after its launcher (its own turn).
// Attack: at Point Blank the target makes a DEX save, DC 15 / 14 / 13 (Small / Medium / Large). Fail: the warhead
//   hits (its dice + the launcher's PB, Mishap Minor / Standard / Major) and the torpedo is gone; Roll with the
//   Punch can halve it. Success: it misses and keeps chasing. Point Defense facing the torpedo gives Advantage,
//   and a successful save then destroys it. Spent after 3 misses or 3 of its turns.
// Shoot it Down: when an enemy torpedo comes within Short range (2 hexes) of a ship, inside the facing of a gun
//   crewed at a station (not missiles, racks or tubes), that gunner may attack it as a Reaction, no Tempo: AC
//   16, a hit for 5 or more destroys it. The target ship reacts first, then other ships hostile to the torpedo.

import { MODULE_ID, nextForwardCost, nextFacingCost, getState, applyHit, rollWithThePunch, askReaction, markSlot, canUse, crewKey, crewOf,
  baseActor, shipProf, shipSpeed, systemOfItem, systemOffline, stationCheck, usesOwnStats, isTorpedo, impairedReason, d20, countermeasures, disabledReason } from "./ship-state.mjs";

const TORPEDO_ACTOR = { Small: "M-00 Small Torpedo", Medium: "M-03 Medium Torpedo", Large: "M-07 Large Torpedo" };
const SAVE_DC = { Small: 15, Medium: 14, Large: 13 };
const MAX_TURNS = 3, MAX_MISSES = 3, SHORT = 2;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = (html, alias = "Torpedo") => ChatMessage.implementation.create({ speaker: { alias },
  content: `<div class="no-crew-card"><p>${html}</p></div>`, flags: { [MODULE_ID]: { crewResult: true } } });

/* ---------- geometry ---------- */
const centerOf = doc => { const g = doc.parent.grid, s = doc._source; return { x: s.x + (s.width * g.sizeX) / 2, y: s.y + (s.height * g.sizeY) / 2 }; };
const hexd = (scene, a, b) => scene.grid.measurePath([a, b]).spaces;
const norm = r => ((r % 360) + 540) % 360 - 180;
const bearing = (a, b) => Math.toDegrees(Math.atan2(b.x - a.x, -(b.y - a.y)));
function neighbors(scene, pt) {
  const out = [];
  for ( let r = 0; r < 360; r += 60 ) {
    const g = scene.grid, rad = Math.toRadians(r);
    out.push({ pt: g.getCenterPoint(g.getOffset({ x: pt.x + Math.sin(rad) * g.sizeY, y: pt.y - Math.cos(rad) * g.sizeY })), rot: r });
  }
  return out;
}
const ARC_EDGES = { bow: [-60, 60], starboard: [60, 120], aft: [120, 240], port: [-120, -60] };
function arcsAt(scene, c, rot, p) {
  const rel = norm(bearing(c, p) - rot), dist = Math.hypot(p.x - c.x, p.y - c.y), inner = scene.grid.sizeY / 2, a = Math.abs(rel);
  const out = new Set([a <= 60 ? "bow" : a >= 120 ? "aft" : rel > 0 ? "starboard" : "port"]);
  for ( const [n, e] of Object.entries(ARC_EDGES) ) for ( const b of e ) {
    const d = Math.toRadians(norm(rel - b));
    if ( (Math.abs(d) < Math.PI / 2) && (Math.abs(dist * Math.sin(d)) <= inner + 0.5) ) out.add(n);
  }
  return out;
}

/* ---------- stock ---------- */
export const tubeSize = item => item?.flags?.[MODULE_ID]?.component?.launcher?.class ?? null;
export function torpedoStock(ship, size) {
  const t = ship.flags?.[MODULE_ID]?.analysis?.ammo?.torpedoes?.[size];
  const total = t ? (Number(t.loaded) || 0) + (Number(t.reloads) || 0) : 0;
  const used = Number(ship.flags?.[MODULE_ID]?.torpedoesUsed?.[size]) || 0;
  return Math.max(0, total - used);
}

/** Launch options for a ship token: [{ item, size, target, hexes, arc, launch: true }]. */
export function launchOptions(shooter) {
  const ship = shooter.actor, scene = shooter.parent, out = [];
  const fired = new Set(ship.getFlag(MODULE_ID, "fired") ?? []);
  for ( const item of ship.items ) {
    const size = tubeSize(item);
    if ( !size || fired.has(item.id) || !torpedoStock(ship, size) ) continue;
    const sys = systemOfItem(item);
    if ( systemOffline(ship, sys) ) continue;
    for ( const target of scene.tokens ) {
      if ( (target.actor?.type !== "vehicle") || (target.disposition === shooter.disposition) || target.hidden || isTorpedo(target)
        || target.getFlag(MODULE_ID, "radarMirror") ) continue;
      if ( disabledReason(target.actor) || cmbt(scene)?.combatants.some(c => (c.tokenId === target.id) && c.defeated) ) continue;
      if ( !arcsAt(scene, centerOf(shooter), shooter.rotation ?? 0, centerOf(target)).has(sys) ) continue;
      out.push({ item, size, target, hexes: hexd(scene, centerOf(shooter), centerOf(target)), arc: sys, launch: true });
    }
  }
  return out;
}

/* ---------- GM: launch ---------- */
export async function launchGM(shooterTok, data) {
  const scene = shooterTok.parent, ship = shooterTok.actor;
  const item = ship.items.get(data.itemId), target = await fromUuid(data.targetUuid);
  const size = tubeSize(item);
  if ( !item || !size || !target ) return { ok: false, error: "No such tube or target." };
  if ( !torpedoStock(ship, size) ) return { ok: false, error: `${ship.name} has no ${size} torpedoes left.` };
  const proto = game.actors.getName(TORPEDO_ACTOR[size]);
  if ( !proto ) return { ok: false, error: `No "${TORPEDO_ACTOR[size]}" actor in the world.` };
  // Spend the torpedo.
  const used = { ...(ship.flags?.[MODULE_ID]?.torpedoesUsed ?? {}) };
  used[size] = (Number(used[size]) || 0) + 1;
  await ship.update({ [`flags.${MODULE_ID}.torpedoesUsed`]: used });
  // Place it beside the launcher, on the side toward the target.
  const tc = centerOf(target);
  const spot = neighbors(scene, centerOf(shooterTok)).sort((a, b) => hexd(scene, a.pt, tc) - hexd(scene, b.pt, tc))[0];
  const g = scene.grid;
  const warhead = proto.items.find(i => i.type === "weapon");
  const b = warhead?.system.damage?.base;
  const td = (await proto.getTokenDocument({
    x: spot.pt.x - (proto.prototypeToken.width * g.sizeX) / 2, y: spot.pt.y - (proto.prototypeToken.height * g.sizeY) / 2, rotation: Math.round(bearing(spot.pt, tc) / 60) * 60 % 360,
    actorLink: false, disposition: shooterTok.disposition, name: `${size} Torpedo`
  })).toObject();
  foundry.utils.setProperty(td, `flags.${MODULE_ID}.torpedo`, {
    size, targetUuid: target.uuid, launcherUuid: shooterTok.uuid, launcherName: shooterTok.name,
    damage: `${Number(b?.number) || 2}d${Number(b?.denomination) || 6} + ${shipProf(ship)}`, dc: SAVE_DC[size],
    misses: 0, turns: 0, launchRound: cmbt(scene)?.round ?? 0
  });
  const [tok] = await scene.createEmbeddedDocuments("Token", [td]);
  await say(`<strong>${esc(shooterTok.name)}</strong> launches a <strong>${size} Torpedo</strong> from its ${esc(item.name)} at <strong>${esc(target.name)}</strong> (${hexd(scene, centerOf(tok), tc)} hexes). ${torpedoStock(ship, size)} ${size} left.`, shooterTok.name);
  // It joins the encounter right after its launcher.
  const combat = cmbt(scene);
  const lc = combat?.combatants.find(c => c.tokenId === shooterTok.id);
  if ( combat && lc ) await combat.createEmbeddedDocuments("Combatant", [{ tokenId: tok.id, sceneId: scene.id, initiative: (lc.initiative ?? 0) - 0.01 }]);
  // And moves at once.
  await moveAndStrike(tok);
  return { ok: true, tokenUuid: tok.uuid };
}

/* ---------- GM: movement and strike ---------- */
// The encounter on this scene, even when the GM is viewing another scene.
const cmbt = scene => game.combats.find(c => c.started && (c.scene?.id === scene?.id)) ?? game.combat;
async function remove(tok, why) {
  if ( why ) await say(why);
  const c = cmbt(tok.parent)?.combatants.find(x => x.tokenId === tok.id);
  if ( c ) await c.delete();
  if ( tok.parent.tokens.get(tok.id) ) await tok.delete();
}

/** Speed costs as the ship rules: the n-th hex forward costs n. Turning is free for a homing torpedo. */
export async function moveAndStrike(tok) {
  const scene = tok.parent, data = tok.getFlag(MODULE_ID, "torpedo");
  const target = await fromUuid(data.targetUuid);
  if ( !target || target.parent !== scene || disabledReason(target.actor) || cmbt(scene)?.combatants.some(c => (c.tokenId === target.id) && c.defeated) ) {
    return remove(tok, `The ${data.size} Torpedo loses its target and self-destructs.`);
  }
  const speed = Math.max(1, Number(shipSpeed(tok.actor)) || 1);
  // Same turning and forward costs as ships (John, 2026-10-26): the n-th hex forward costs n, facing changes
  // cost 1, 3, 6, 12… in the round. Plan the cheapest sequence that ends nearest the target (Point Blank stops it).
  const tc0 = centerOf(target), g = scene.grid;
  let best = null;
  const seen = new Set();
  const plan = (pt, rot, f, t, spent, seq) => {
    const key = `${pt.x},${pt.y},${rot},${f},${t}`;
    if ( seen.has(key) ) return; seen.add(key);
    const d = hexd(scene, pt, tc0);
    const score = d * 100 + spent;
    if ( !best || score < best.score ) best = { score, seq: [...seq] };
    if ( d <= 1 ) return;   // Point Blank: it strikes
    if ( spent + nextForwardCost(f) <= speed ) {
      const rad = Math.toRadians(rot);
      const nx = g.getCenterPoint(g.getOffset({ x: pt.x + Math.sin(rad) * g.sizeY, y: pt.y - Math.cos(rad) * g.sizeY }));
      plan(nx, rot, f + 1, t, spent + nextForwardCost(f), [...seq, { move: "forward", pt: nx, rot }]);
    }
    if ( spent + nextFacingCost(t) <= speed ) {
      for ( const r of [(rot + 60) % 360, (rot + 300) % 360] ) plan(pt, r, f, t + 1, spent + nextFacingCost(t), [...seq, { move: "turn", pt, rot: r }]);
    }
  };
  plan(centerOf(tok), ((Math.round((tok.rotation ?? 0) / 60) * 60) % 360 + 360) % 360, 0, 0, 0, []);
  const reacted = new Set();
  for ( const stepTo of best?.seq ?? [] ) {
    await tok.update({ x: stepTo.pt.x - (tok.width * g.sizeX) / 2, y: stepTo.pt.y - (tok.height * g.sizeY) / 2, rotation: stepTo.rot });
    await sleep(stepTo.move === "forward" ? 250 : 120);
    if ( (stepTo.move === "forward") && await shootItDown(tok, target, reacted) ) return;
  }
  if ( hexd(scene, centerOf(tok), centerOf(target)) <= 1 ) {
    if ( await shootItDown(tok, target, reacted) ) return;
    await strike(tok, target);
  } else await say(`The ${data.size} Torpedo closes to ${hexd(scene, centerOf(tok), centerOf(target))} hexes of ${esc(target.name)}.`);
}

/** Point Defense on the target facing the torpedo. */
function pointDefense(target, tok) {
  const scene = target.parent;
  const arcs = arcsAt(scene, centerOf(target), target.rotation ?? 0, centerOf(tok));
  return target.actor.items.find(i => i.flags?.[MODULE_ID]?.component?.pointDefense && arcs.has(systemOfItem(i))
    && !systemOffline(target.actor, systemOfItem(i))) ?? null;
}

async function strike(tok, target) {
  const data = foundry.utils.deepClone(tok.getFlag(MODULE_ID, "torpedo"));
  const pd = pointDefense(target, tok);
  const bonus = Number(target.actor.system.abilities?.dex?.save?.value ?? target.actor.system.abilities?.dex?.save) || 0;
  // Dodging is a Propulsion roll: Impaired gives Disadvantage (John, 2026-10-26).
  const imp = impairedReason(target.actor, ["propulsion"]);
  // Countermeasures (the target's Navigator, Reaction): Advantage on the dodge.
  const cm = await countermeasures(target.actor, { targetName: target.name, attacker: data.launcherName, weapon: `${data.size} Torpedo`, torpedo: true });
  const roll = await new Roll(`${d20(!!pd || !!cm?.use, !!imp)} + ${bonus}`).evaluate();
  await roll.toMessage({ speaker: { alias: target.name }, flavor: `${target.name} dodges a ${data.size} Torpedo: DEX save vs DC ${data.dc}${pd ? ` (Advantage: ${pd.name})` : ""}${cm?.use ? " (Advantage: Countermeasures)" : ""}${imp ? ` (Disadvantage: ${imp})` : ""}` });
  if ( roll.total >= data.dc ) {
    if ( pd ) return remove(tok, `<strong>${esc(target.name)}</strong> dodges, and its ${esc(pd.name)} destroys the ${data.size} Torpedo.`);
    data.misses += 1;
    await tok.setFlag(MODULE_ID, "torpedo", data);
    if ( data.misses >= MAX_MISSES ) return remove(tok, `<strong>${esc(target.name)}</strong> dodges again; the ${data.size} Torpedo is spent.`);
    return say(`<strong>${esc(target.name)}</strong> dodges the ${data.size} Torpedo (${roll.total} vs DC ${data.dc}). It keeps chasing (${data.misses} of ${MAX_MISSES} misses).`);
  }
  const dmg = await new Roll(data.damage).evaluate();
  await dmg.toMessage({ speaker: { alias: `${data.size} Torpedo` }, flavor: `${data.size} Torpedo warhead hits ${target.name}` });
  const actor = target.actor;
  const taken = await rollWithThePunch(actor, { damage: dmg.total, weapon: `${data.size} Torpedo`, attacker: data.launcherName, targetName: target.name });
  await applyHit(actor, { damage: taken, size: data.size, crit: false, weapon: `${data.size} Torpedo`, attacker: data.launcherName, tokenDoc: target });
  await remove(tok);
}

/** Shoot it Down reactions around the torpedo: the target ship first, then the others hostile to it. */
async function shootItDown(tok, target, reacted) {
  const scene = tok.parent, data = tok.getFlag(MODULE_ID, "torpedo");
  const ships = scene.tokens.filter(t => (t.actor?.type === "vehicle") && !isTorpedo(t) && !t.getFlag(MODULE_ID, "radarMirror")
    && !t.hidden && (t.disposition !== tok.disposition) && !reacted.has(t.id)
    && !disabledReason(t.actor) && !cmbt(scene)?.combatants.some(c => (c.tokenId === t.id) && c.defeated)
    && (hexd(scene, centerOf(t), centerOf(tok)) <= SHORT))
    .sort((a, b) => (b.id === target.id) - (a.id === target.id));
  for ( const ship of ships ) {
    const shot = gunFor(ship, tok);
    if ( !shot ) continue;
    reacted.add(ship.id);
    const ans = await askReaction(ship.actor, { kind: "shoot", ship: ship.name, torpedo: `${data.size} Torpedo`, targetName: target.name,
      hexes: hexd(scene, centerOf(ship), centerOf(tok)), weapon: shot.item.name, bonus: shot.bonus, crewName: shot.crew?.name ?? "Gunner" });
    if ( !ans?.use ) continue;
    await markSlot(ship.actor, shot.key, "reaction", true, "Shoot it Down");
    const imp = impairedReason(ship.actor, [systemOfItem(shot.item)], shot.crew);
    const atk = await new Roll(`${d20(shot.advantage, !!imp)} + ${shot.bonus}`).evaluate();
    await atk.toMessage({ speaker: { alias: ship.name }, flavor: `Shoot it Down: ${shot.item.name} at the ${data.size} Torpedo (AC 16)${imp ? ` (Disadvantage: ${imp})` : ""}` });
    if ( atk.total < 16 && atk.dice[0]?.total !== 20 ) { await say(`<strong>${esc(ship.name)}</strong> fires at the ${data.size} Torpedo and misses.`); continue; }
    const dmg = await new Roll(shot.damage).evaluate();
    await dmg.toMessage({ speaker: { alias: ship.name }, flavor: `Shoot it Down: damage to the ${data.size} Torpedo` });
    if ( dmg.total >= 5 ) { await remove(tok, `<strong>${esc(ship.name)}</strong> shoots down the ${data.size} Torpedo.`); return true; }
    await say(`<strong>${esc(ship.name)}</strong> clips the ${data.size} Torpedo (${dmg.total}), not enough to stop it.`);
  }
  return false;
}

/** A gun on `ship` whose facing and range reach the torpedo, with a gunner whose Reaction is free. */
function gunFor(ship, tok) {
  const scene = tok.parent, actor = ship.actor;
  const d = hexd(scene, centerOf(ship), centerOf(tok));
  const arcs = arcsAt(scene, centerOf(ship), ship.rotation ?? 0, centerOf(tok));
  const base = baseActor(actor) ?? actor;
  const gunners = Object.entries(crewOf(base)).filter(([, r]) => r?.some(x => ["gunner", "pilot"].includes(x))).map(([id]) => game.actors.get(id)).filter(Boolean);
  const crews = gunners.length ? gunners : [null];
  for ( const item of actor.items ) {
    if ( item.type !== "weapon" || !item.system.activities?.some(a => a.type === "attack") ) continue;
    if ( /missile|rack|torpedo/i.test(item.name) || item.flags?.[MODULE_ID]?.component?.launcher ) continue;
    const sys = systemOfItem(item);
    if ( !arcs.has(sys) || systemOffline(actor, sys) ) continue;
    const rb = String(item.flags?.[MODULE_ID]?.rangeBand ?? item.flags?.[MODULE_ID]?.component?.info?.Range ?? "");
    const bands = ["point blank", "short", "medium", "long", "extreme"];
    const parts = rb.split(/[–-]/).map(x => x.trim().toLowerCase()).map(x => x === "pb" ? 1 : bands.indexOf(x) + 1).filter(n => n > 0);
    if ( !parts.length || d < Math.min(...parts) || d > Math.max(...parts) ) continue;
    for ( const crew of crews ) {
      if ( !canUse(actor, crew, "gunner", { name: "Shoot it Down", activation: { type: "reaction" } }).ok ) continue;
      const own = usesOwnStats(crew, actor) ? crew : null;
      const chk = stationCheck(actor, own, "gunner");
      const bd = item.system.damage?.base;
      return { item, crew, key: crewKey(actor, crew, "gunner"), bonus: chk.bonus, advantage: chk.advantage,
        damage: `${Number(bd?.number) || 1}d${Number(bd?.denomination) || 4} + ${shipProf(actor)}` };
    }
  }
  return null;
}

/* ---------- GM: the torpedo's own turn ---------- */
let busy = false;
Hooks.on("updateCombat", (combat, changes) => {
  if ( !game.users.activeGM?.isSelf || !combat.started ) return;
  if ( !("turn" in changes) && !("round" in changes) ) return;
  torpedoTurns(combat);
});
// A torpedo removed on its turn moves the encounter on without a turn change reaching this client while the
// last one is still busy, so after each torpedo turn check the current combatant again.
async function torpedoTurns(combat) {
  if ( busy ) return;
  busy = true;
  try {
    for ( let guard = 0; guard < 20; guard++ ) {
      if ( !game.combats.has(combat.id) || !combat.started ) break;
      const tok = combat.combatant?.token;
      if ( !tok || !isTorpedo(tok) ) break;
      const cid = combat.combatant.id, round = combat.round;
      try {
        const data = foundry.utils.deepClone(tok.getFlag(MODULE_ID, "torpedo"));
        if ( data.launchRound !== combat.round ) {
          data.turns += 1;
          await tok.setFlag(MODULE_ID, "torpedo", data);
          await moveAndStrike(tok);
          const still = tok.parent.tokens.get(tok.id);
          if ( still && (tok.getFlag(MODULE_ID, "torpedo")?.turns ?? 0) >= MAX_TURNS ) await remove(tok, `The ${data.size} Torpedo runs out of fuel.`);
        }
      } catch(err) { console.error(`${MODULE_ID} | torpedo turn`, err); }
      await sleep(300);
      // A torpedo removed on its own turn already moved the encounter on (its combatant was deleted).
      if ( game.combats.has(combat.id) && tok.parent.tokens.get(tok.id) && (combat.combatant?.id === cid) && (combat.round === round) ) await combat.nextTurn();
      await sleep(200);
    }
  } finally { busy = false; }
}

