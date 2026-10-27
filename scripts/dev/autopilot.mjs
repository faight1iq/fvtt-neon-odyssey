// Autopilot for hands-free ship battles (John, 2026-10-26). Not loaded by the module: the GM imports it
// from the console:  const AP = await import("/modules/fvtt-neon-odyssey/scripts/dev/autopilot.mjs");
//
// It plays every ship through the same rule engine the HUD uses: costs go through crew usage messages (the
// GM's applyCost), action slots through useSlot, fire through fireShot (attack, Divert/Roll with the Punch
// reactions decided by the autoRun flag, hit, Mishaps), EW through ewEffect, Rally through grantDie.
//
// Player-style doctrine for the big ship ("use every crew member, spend Tempo, kill the weakest first"):
//   repairs (Triage / Fire Team) → Gain Tempo from spare hands → Helm: Maneuver to bring the most guns onto the
//   weakest targets, Attack Position on the busiest arc → Engineer Reroute Power + Navigator EW on the weakest
//   target in range → Commander Rally (die to a gunner) or Orders (an extra shot) → every gunner fires at the
//   weakest target its weapon can reach → Let 'em Have It! with unfired weapons. Keeps a Tempo reserve for
//   reactions (return fire, Roll with the Punch).
// Fighters: Maneuver to a firing spot outside the big ship's weapon envelope, fire their best weapon, Gain
// Tempo when they can't shoot; Roll with the Punch and return fire as reactions.

import { MODULE_ID, getState, request, canUse, crewKey, crewOf, baseActor, stationCheck, usesOwnStats,
  crewBonus, shipProf, nextFacingCost, nextForwardCost, activeMishaps, disabledReason, heldDie, dieForPB,
  commandDice, fireContext, systemOfItem, systemOffline, econOf, shipSpeed, countsTowardOffline, shipImpaired, isFire, crewDown } from "../ship-state.mjs";
import { firingSolutions, fireShot, weaponHexes, ewTargets, spendDie, runCorrect, firedThisRound,
  EW_AMOUNT, REROUTE_BONUS } from "../ship-fire.mjs";
import { launchOptions } from "../torpedoes.mjs";
import { weaponAmmo } from "../starship-designer.mjs";
// Firing solutions with ammo left for the weapon (out of ammo can't fire).
const armed = tok => firingSolutions(tok).filter(s => { const a = weaponAmmo(s.item.actor, s.item.id); return !a || a.left >= a.cost; });
const isTorp = t => !!t?.getFlag?.(MODULE_ID, "torpedo");

export const log = [];
const say = s => { log.push(s); console.log(`AP | ${s}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RESERVE = 4;          // Tempo kept for reactions
const ROLE_ITEM = { any: "NOcrewRoleAny000", commander: "NOcrewRoleCmd000", navigator: "NOcrewRoleNav000",
  helmsman: "NOcrewRoleHelm00", gunner: "NOcrewRoleGun000", engineer: "NOcrewRoleEng000", medic: "NOcrewRoleMed000",
  cook: "NOcrewRoleCook00" };
const roleDocs = {};
async function roleDoc(role) {
  if ( !roleDocs[role] ) roleDocs[role] = await game.packs.get(`${MODULE_ID}.class-features`).getDocument(ROLE_ITEM[role]);
  return roleDocs[role];
}
async function costFor(role, name) {
  const doc = await roleDoc(role);
  const act = doc?.system.activities.find(a => a.name === name);
  return { cost: (act && doc.flags[MODULE_ID]?.costs?.[act.id]) ?? { tempo: 0 }, act };
}

/* ---------- geometry ---------- */
// The scene the battle runs on, pinned by reset()/setup() so a view change mid-run doesn't move it.
let SCENE = null;
const scn = () => SCENE ?? canvas.scene;
const cbt = () => game.combats.find(c => c.scene?.id === scn()?.id) ?? null;
const grid = () => scn().grid;
const center = doc => doc.object?.center ?? { x: doc._source.x + (doc._source.width * grid().sizeX) / 2, y: doc._source.y + (doc._source.height * grid().sizeY) / 2 };
const hexd = (a, b) => grid().measurePath([a, b]).spaces;
const norm = r => ((r % 360) + 540) % 360 - 180;
const relAt = (c, rot, p) => norm(Math.toDegrees(Math.atan2(p.x - c.x, -(p.y - c.y))) - rot);
function step(pt, rot) {
  const r = Math.toRadians(rot), g = grid();
  return g.getCenterPoint(g.getOffset({ x: pt.x + Math.sin(r) * g.sizeY, y: pt.y - Math.cos(r) * g.sizeY }));
}
const ARC_EDGES = { bow: [-60, 60], starboard: [60, 120], aft: [120, 240], port: [-120, -60] };
function arcsAt(c, rot, p) {
  const rel = relAt(c, rot, p), dist = Math.hypot(p.x - c.x, p.y - c.y), inner = grid().sizeY / 2, a = Math.abs(rel);
  const out = new Set([a <= 60 ? "bow" : a >= 120 ? "aft" : rel > 0 ? "starboard" : "port"]);
  for ( const [n, e] of Object.entries(ARC_EDGES) ) for ( const b of e ) {
    const d = Math.toRadians(norm(rel - b));
    if ( (Math.abs(d) < Math.PI / 2) && (Math.abs(dist * Math.sin(d)) <= inner + 0.5) ) out.add(n);
  }
  return out;
}
function avgDamage(item, ship) {
  const b = item.system.damage?.base;
  const n = Number(b?.number) || 1, d = Number(b?.denomination) || 4;
  return n * (d + 1) / 2 + shipProf(ship);
}
/** Weapons of `ship` placed at (c, rot) that reach point p: [{ item, avg }]. */
function weaponsReaching(ship, c, rot, p) {
  const d = hexd(c, p), arcs = arcsAt(c, rot, p), out = [];
  for ( const item of ship.items ) {
    if ( item.type !== "weapon" || !item.system.activities?.some(a => a.type === "attack") ) continue;
    const sys = systemOfItem(item), r = weaponHexes(item);
    if ( !r || !arcs.has(sys) || systemOffline(ship, sys) || (d < r[0]) || (d > r[1]) ) continue;
    out.push({ item, avg: avgDamage(item, ship) });
  }
  return out;
}

/* ---------- state ---------- */
const isOut = tok => !!disabledReason(tok.actor) || cbt()?.combatants.some(c => (c.tokenId === tok.id) && c.defeated);
const enemiesOf = tok => scn().tokens.filter(t => (t.actor?.type === "vehicle") && (t.disposition !== tok.disposition)
  && !t.getFlag(MODULE_ID, "radarMirror") && !t.hidden && !isTorp(t) && !isOut(t));
/** Lower = weaker: Strain room left before Disabled. */
const remaining = tok => (Number(tok.actor.system.attributes.hp.max) || 0) - getState(tok.actor).strain;
const weakestFirst = toks => [...toks].sort((a, b) => remaining(a) - remaining(b));
const tempo = ship => getState(ship).tempo;

async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while ( Date.now() - t0 < ms ) { if ( pred() ) return true; await sleep(100); }
  return false;
}
/** Pay an action's cost through a crew usage message (the GM's applyCost), and take its slot. */
async function act(ship, crew, role, name, { slot = null } = {}) {
  const { cost, act: a } = await costFor(role, name);
  const s = slot ?? ((a?.activation?.type === "bonus") ? "bonus" : (a?.activation?.type === "reaction") ? "reaction" : "action");
  const gate = canUse(ship, crew, role, { name, activation: { type: s } });
  if ( !gate.ok ) return false;
  const before = JSON.stringify(getState(ship));
  if ( cost.tempo || cost.strain || cost.strainDelta ) {
    await ChatMessage.implementation.create({
      speaker: crew ? ChatMessage.implementation.getSpeaker({ actor: crew }) : ChatMessage.implementation.getSpeaker({ actor: ship }),
      content: `<div class="no-crew-card"><p><strong>${name}</strong>${crew ? ` (${foundry.utils.escapeHTML(crew.name)})` : ""}</p></div>`,
      flags: { [MODULE_ID]: { crew: { ...cost, action: name, role, shipUuid: ship.uuid } } }
    });
    await waitFor(() => JSON.stringify(getState(ship)) !== before);
  }
  await request({ action: "useSlot", uuid: ship.uuid, key: crewKey(ship, crew, role), slot: gate.slot ?? s, name });
  return true;
}

/** Gain Tempo through the GM's Gain Tempo handler. */
async function gainTempo(ship, crew) {
  const gate = canUse(ship, crew, "any", { name: "Gain Tempo", activation: { type: "action" } });
  if ( !gate.ok ) return;
  const dc = Math.max(8, tempo(ship));
  let bonus;
  if ( crew && usesOwnStats(crew, ship) ) bonus = Math.max(...Object.values(crew.system.skills).map(s => Number(s.total) || 0));
  else bonus = crewBonus(ship, "any");
  // A player doesn't roll a coin-flip-or-worse for Tempo: needs at least an even chance.
  if ( bonus + 11 < dc ) { say(`${ship.name}${crew ? ` / ${crew.name}` : ""}: skips Gain Tempo (+${bonus} vs DC ${dc})`); return; }
  const before = tempo(ship), sb = getState(ship).strain;
  const roll = await new Roll(`1d20 + ${bonus}`).evaluate();
  await roll.toMessage({ speaker: crew ? ChatMessage.implementation.getSpeaker({ actor: crew }) : ChatMessage.implementation.getSpeaker({ actor: ship }),
    flavor: `Gain Tempo (+${bonus}) vs DC ${dc}`,
    flags: { [MODULE_ID]: { gainTempo: { dc, prof: 2, sceneId: scn().id, shipUuid: ship.uuid } } } });
  await waitFor(() => (tempo(ship) !== before) || (getState(ship).strain !== sb));
  await request({ action: "useSlot", uuid: ship.uuid, key: crewKey(ship, crew, "any"), slot: "action", name: "Gain Tempo" });
  say(`${ship.name}${crew ? ` / ${crew.name}` : ""}: Gain Tempo ${roll.total} vs ${dc} → Tempo ${tempo(ship)}`);
}

/* ---------- firing ---------- */
async function shoot(shooterTok, solution, { gunner = null, mode = "normal", useDieKey = null, reaction = false } = {}) {
  const ship = shooterTok.actor;
  if ( isOut(solution.target) ) return null;
  fireContext.gunner = gunner;
  fireContext.commandDie = useDieKey ? await spendDie(ship, useDieKey) : null;
  let res = null;
  try { res = await fireShot({ solution, mode, shooter: shooterTok }); }
  finally { fireContext.gunner = undefined; fireContext.commandDie = null; }
  say(`${shooterTok.name} ${reaction ? "returns fire" : "fires"} ${solution.item.name} at ${solution.target.name} (${solution.target.id.slice(0, 2)}) ${solution.hexes} hexes: ${res ? `${res.total} vs AC ${res.ac}, ${res.hit ? `HIT ${res.damage}` : "miss"}` : "no roll"}`);
  await sleep(400);
  return res;
}

/** The target shoots back with a crew member's Reaction, if it can. */
async function returnFire(targetTok, attackerTok) {
  if ( isOut(targetTok) || isOut(attackerTok) ) return;
  const ship = targetTok.actor;
  // Return fire only with Tempo to spare after a Roll with the Punch (2).
  if ( tempo(ship) < 3 ) return;
  const sols = armed(targetTok).filter(s => s.target.id === attackerTok.id).sort((a, b) => avgDamage(b.item, ship) - avgDamage(a.item, ship));
  if ( !sols.length ) return;
  const gunners = crewWith(ship, "gunner");
  for ( const g of gunners ) {
    const gate = canUse(ship, g, "gunner", { name: "Fire", activation: { type: "action" } });
    if ( !gate.ok ) continue;
    if ( !(await act(ship, g, "gunner", "Fire", { slot: gate.slot })) ) continue;
    await shoot(targetTok, sols[0], { gunner: usesOwnStats(g, ship) ? g : null, reaction: true });
    return;
  }
}

/** Crew characters holding a role, or [null] for a ship's own crew with that station. */
function crewWith(ship, role) {
  const base = baseActor(ship) ?? ship;
  const chars = Object.entries(crewOf(base)).filter(([, r]) => r?.includes(role)).map(([id]) => game.actors.get(id)).filter(Boolean);
  if ( chars.length ) return chars;
  const stations = ship.flags?.[MODULE_ID]?.stations ?? [];
  const has = stations.some(s => (s.roles ?? []).some(r => r === role || (r === "pilot" && ["helmsman", "gunner"].includes(role))));
  return has || role === "any" ? [null] : [];
}

/* ---------- movement ---------- */
/** Every reachable (position, facing) with its move list, from the ship's current state. */
function reachable(tok) {
  const st = getState(tok.actor), out = [], seen = new Set();
  const rec = (pt, rot, bands, facings, spent, seq) => {
    const key = `${pt.x},${pt.y},${rot},${bands},${facings}`;
    if ( seen.has(key) ) return; seen.add(key);
    out.push({ pt, rot, seq: [...seq], spent });
    const fc = nextForwardCost(bands);
    if ( spent + fc <= st.speed ) rec(step(pt, rot), rot, bands + 1, facings, spent + fc, [...seq, "forward"]);
    const tc = nextFacingCost(facings);
    if ( spent + tc <= st.speed ) {
      rec(pt, (rot + 60) % 360, bands, facings + 1, spent + tc, [...seq, "right"]);
      rec(pt, (rot + 300) % 360, bands, facings + 1, spent + tc, [...seq, "left"]);
    }
  };
  rec(center(tok), tok.rotation ?? 0, st.bands, st.facings, 0, []);
  return out;
}
const occupied = (tok, pt) => {
  const o = grid().getOffset(pt);
  return scn().tokens.some(t => (t.id !== tok.id) && (t.actor?.type === "vehicle") && !t.getFlag(MODULE_ID, "radarMirror") && !isTorp(t)
    && (() => { const q = grid().getOffset(center(t)); return q.i === o.i && q.j === o.j; })());
};
async function moveAlong(tok, seq) {
  for ( const m of seq ) {
    const res = await request({ action: "steer", uuid: tok.uuid, move: m });
    if ( !res?.ok ) { say(`${tok.name}: move ${m} refused (${res?.error ?? "?"})`); break; }
    await sleep(350);
  }
}

/* ---------- the big ship's turn ---------- */
async function bigShipTurn(tok) {
  const ship = tok.actor;
  say(`— ${tok.name} (Tempo ${tempo(ship)}, Strain ${getState(ship).strain}${shipImpaired(ship) ? ", SHIP IMPAIRED" : ""}, Mishaps ${activeMishaps(ship).map(m => m.system).join("/") || "none"})`);
  const roles = r => crewWith(ship, r);
  const firstFree = (role, name, type = "action") => roles(role).find(c => canUse(ship, c, role, { name, activation: { type } }).ok);

  // Repairs first, by the hands that can do them without leaving a station.
  const mishaps = activeMishaps(ship);
  const medic = firstFree("medic", "Triage"), cook = firstFree("cook", "Fire Team");
  if ( medic && mishaps.some(m => /crew[\s-]*injur/i.test(m.name)) && tempo(ship) >= 1 && await act(ship, medic, "medic", "Triage") ) {
    say(`Triage: ${await runCorrect(ship, "Triage", { bonus: stationCheck(ship, medic, "medic").bonus })}`);
  }
  if ( cook && mishaps.some(m => /(^|\s)(Fire|Explosion)$/i.test(m.name) || m.system === "habitat") && tempo(ship) >= 1 && await act(ship, cook, "cook", "Fire Team") ) {
    say(`Fire Team: ${await runCorrect(ship, "Fire Team", { bonus: stationCheck(ship, cook, "cook").bonus })}`);
  }
  // The Medic keeps the crew standing: Healing Word (Bonus Action, 1st-level slot), else a Healing Stim, on the
  // most hurt crew member who is down or under half HP. From the station: no walk.
  await medicTurn(ship);
  // Fire spreads: deck crew use Fire Suppression (2 Tempo) from their stations while the ship has a Fire.
  for ( const c of crewWith(ship, "any").filter(c => c && (crewOf(baseActor(ship) ?? ship)[c.id] ?? []).length === 1) ) {
    if ( !activeMishaps(ship).some(isFire) || (tempo(ship) < 2) ) break;
    if ( await act(ship, c, "any", "Fire Suppression") ) {
      const r = await request({ action: "suppressFire", uuid: ship.uuid, by: c.name });
      say(`${c.name}: Fire Suppression → ${r?.line?.replace(/<[^>]+>/g, "") ?? r?.error}`);
    }
  }
  // A Mishap on Power, Propulsion or Command Impairs the whole ship (Disadvantage on every ship system roll):
  // spare hands leave their stations to Correct it first (deckhands, then the medic and cook).
  const CRIT = ["power", "propulsion", "command"], TIER = ["Minor", "Standard", "Major", "Critical", "Catastrophic"];
  const spare = [...crewWith(ship, "any").filter(c => c && (crewOf(baseActor(ship) ?? ship)[c.id] ?? []).length === 1), ...roles("medic"), ...roles("cook")].filter(Boolean);
  // At most two crew go to any one Mishap in a turn: more just stand in its reach.
  const walkers = {};
  const open = m => (walkers[m.id] ?? 0) < 2;
  for ( const c of spare ) {
    // Fires first (they spread), then critical systems, then a Mishap about to complete and worsen (countdown 1).
    const m = activeMishaps(ship).filter(m => isFire(m) && open(m)).sort((a, b) => TIER.indexOf(b.tier) - TIER.indexOf(a.tier))[0]
      ?? activeMishaps(ship).filter(m => CRIT.includes(m.system) && countsTowardOffline(m) && open(m))
      .sort((a, b) => TIER.indexOf(b.tier) - TIER.indexOf(a.tier))[0]
      ?? activeMishaps(ship).filter(m => ((m.counters ?? 9) <= 1) && open(m)).sort((a, b) => (a.hp ?? 99) - (b.hp ?? 99))[0];
    if ( !m ) break;
    walkers[m.id] = (walkers[m.id] ?? 0) + 1;
    if ( !await act(ship, c, "any", "Correct") ) continue;
    say(`${c.name} leaves station to Correct ${m.name} (${m.system}): ${await runCorrect(ship, "Correct", { pickId: m.id, bonus: stationCheck(ship, c, "any").bonus, crew: c })}`);
  }
  // Deck crew Shore Up (1 Tempo: 1 Strain) when the ship is within 10 Strain of its HP and Tempo is above the reserve.
  const hpMax = Number(ship.system.attributes.hp.max) || 0;
  for ( const c of crewWith(ship, "any").filter(c => c && (crewOf(baseActor(ship) ?? ship)[c.id] ?? []).length === 1) ) {
    if ( (getState(ship).strain >= hpMax - 10) && (tempo(ship) > RESERVE) && await act(ship, c, "any", "Shore Up") ) say(`${c.name}: Shore Up → Strain ${getState(ship).strain}`);
  }
  // Spare hands build Tempo.
  for ( const c of [...roles("medic"), ...roles("cook"), ...crewWith(ship, "any").filter(c => c && (crewOf(baseActor(ship) ?? ship)[c.id] ?? []).length === 1)] ) {
    if ( c ) await gainTempo(ship, c);
  }

  // Helm: Maneuver, then the spot that brings the most damage onto the weakest targets.
  const helm = roles("helmsman")[0];
  if ( await act(ship, helm, "helmsman", "Maneuver") ) {
    await waitFor(() => getState(ship).helm === 1 && getState(ship).speed > 0);
    const foes = weakestFirst(enemiesOf(tok));
    let best = null;
    for ( const opt of reachable(tok) ) {
      if ( opt.seq.length && occupied(tok, opt.pt) ) continue;
      let score = 0; const arcLoad = {};
      for ( const f of foes ) {
        const val = 1 + 20 / Math.max(1, remaining(f));
        for ( const w of weaponsReaching(ship, opt.pt, opt.rot, center(f)) ) {
          score += w.avg * val; const a = systemOfItem(w.item); arcLoad[a] = (arcLoad[a] ?? 0) + w.avg * val;
        }
      }
      score -= opt.spent * 0.05;
      if ( !best || score > best.score ) best = { ...opt, score, arcLoad };
    }
    if ( best?.seq.length ) { say(`Helm moves: ${best.seq.join(", ")}`); await moveAlong(tok, best.seq); }
    // Attack Position on the busiest arc.
    const arc = Object.entries(best?.arcLoad ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
    if ( arc && tempo(ship) >= RESERVE + 2 && await act(ship, helm, "helmsman", "Attack Position") ) {
      await ship.setFlag(MODULE_ID, "attackPosition", { arc, by: "autopilot" });
      say(`Attack Position: ${arc}`);
    }
  }

  // Engineer + Navigator: Electronic Warfare on the weakest target in range.
  const nav = firstFree("navigator", "Electronic Warfare"), eng = firstFree("engineer", "Reroute Power");
  const ew = ewTargets(tok).filter(e => !isOut(e.target)).sort((a, b) => remaining(a.target) - remaining(b.target))[0];
  if ( nav && ew && tempo(ship) >= RESERVE + 3 ) {
    let reroute = false;
    if ( eng && tempo(ship) >= RESERVE + 5 && await act(ship, eng, "engineer", "Reroute Power") ) { reroute = true; say("Engineer: Reroute Power → Navigation"); }
    if ( await act(ship, nav, "navigator", "Electronic Warfare") ) {
      const chk = stationCheck(ship, nav, "navigator"), dc = 10 + getState(ew.target.actor).tempo;
      const roll = await new Roll(`${chk.dice} + ${chk.bonus}`).evaluate();
      await roll.toMessage({ speaker: ChatMessage.implementation.getSpeaker({ actor: nav }), flavor: `Electronic Warfare on ${ew.target.name} (${ew.target.id.slice(0, 2)}): vs DC ${dc}` });
      if ( roll.total >= dc ) {
        await request({ action: "ewEffect", uuid: ew.target.uuid, attackerUuid: tok.uuid, effect: "strain", amount: EW_AMOUNT + (reroute ? REROUTE_BONUS : 0), attacker: tok.name });
        say(`EW on ${ew.target.id.slice(0, 2)}: ${roll.total} vs ${dc}, +${EW_AMOUNT + (reroute ? REROUTE_BONUS : 0)} Strain`);
      } else say(`EW on ${ew.target.id.slice(0, 2)}: ${roll.total} vs ${dc}, miss`);
    }
  }
  for ( const c of [nav, eng] ) if ( c && canUse(ship, c, "any", { name: "Gain Tempo", activation: { type: "action" } }).ok ) await gainTempo(ship, c);

  // Commander: Orders when there are more guns than gunners, else Rally a gunner.
  const gunners = roles("gunner");
  const cmd = roles("commander")[0];
  const shotCount = new Set(armed(tok).map(s => s.item.id)).size;
  let ordersPlanned = cmd && shotCount > gunners.length && tempo(ship) >= RESERVE + 3;
  if ( cmd && !ordersPlanned && shotCount && tempo(ship) >= RESERVE + 1 ) {
    const g = gunners.find(x => x && !heldDie(ship, x.id));
    if ( g && await act(ship, cmd, "commander", "Rally") ) {
      const die = dieForPB(Number(cmd.system.attributes.prof) || 2);
      await request({ action: "grantDie", uuid: ship.uuid, key: g.id, die, name: g.name, from: cmd.name });
      say(`Rally: ${g.name} gets a ${die}`);
    }
  }

  // Gunners: every gunner fires at the weakest target its best weapon can reach.
  // Each weapon fires once a round; only the Commander's Orders can fire one again.
  const fireOne = async (g, { unfired = true, actName = "Fire" } = {}) => {
    const fired = firedThisRound(ship);
    const sols = armed(tok).filter(s => !isOut(s.target) && (!unfired || !fired.has(s.item.id)))
      .sort((a, b) => (remaining(a.target) - remaining(b.target)) || (avgDamage(b.item, ship) - avgDamage(a.item, ship))
        || (fired.has(a.item.id) - fired.has(b.item.id)));
    const s = unfired ? sols[0] : (sols.find(x => !fired.has(x.item.id)) ?? sols[0]);
    if ( !s ) {
      // No gun can reach: launch a torpedo at the weakest target a tube faces.
      const l = launchOptions(tok).filter(x => !isOut(x.target)).sort((a, b) => remaining(a.target) - remaining(b.target))[0];
      if ( !l || tempo(ship) < 1 ) return false;
      if ( !(await act(ship, g, "gunner", actName)) ) return false;
      await ship.setFlag(MODULE_ID, "fired", [...firedThisRound(ship), l.item.id]);
      say(`${g?.name ?? "Gunner"} launches a ${l.size} Torpedo from ${l.item.name} at ${l.target.name} (${l.target.id.slice(0, 2)}), ${l.hexes} hexes`);
      await request({ action: "launchTorpedo", uuid: tok.uuid, itemId: l.item.id, targetUuid: l.target.uuid }, { timeout: 300000 });
      return true;
    }
    if ( tempo(ship) < 1 ) return false;
    if ( !(await act(ship, g, "gunner", actName)) ) return false;
    const ap = ship.getFlag(MODULE_ID, "attackPosition")?.arc;
    const own = usesOwnStats(g, ship) ? g : null;
    const chk = stationCheck(ship, own, "gunner");
    const mode = (chk.advantage || ap === s.arc || actName === "Aimed Shot") ? "advantage" : "normal";
    const dieKey = g && heldDie(ship, g.id) ? g.id : null;
    await shoot(tok, s, { gunner: own, mode, useDieKey: dieKey });
    await returnFire(s.target, tok);
    return true;
  };
  // The first gunner always fires; the rest only while the ship keeps its reaction reserve (John, 2026-10-26:
  // spending down to 0 Tempo left nothing for Roll with the Punch).
  for ( const [i, g] of gunners.entries() ) if ( tempo(ship) >= (i === 0 ? 1 : RESERVE + 1) ) await fireOne(g);
  if ( cmd && ordersPlanned && armed(tok).length && await act(ship, cmd, "commander", "Orders") ) {
    const g = gunners[0];
    await request({ action: "freeAction", uuid: ship.uuid, key: crewKey(ship, g, "gunner") });
    say(`Orders: ${g?.name ?? "gunner"} fires again`);
    await fireOne(g, { unfired: false });
  }
  for ( const g of gunners ) if ( tempo(ship) >= RESERVE + 2 ) await fireOne(g, { unfired: true, actName: "Let 'em Have It!" });
  say(`${tok.name} ends: Tempo ${tempo(ship)}, Strain ${getState(ship).strain}`);
}

/* ---------- the Medic ---------- */
async function medicTurn(ship) {
  const base = baseActor(ship) ?? ship;
  const roster = crewOf(base);
  const doc = Object.keys(roster).map(id => game.actors.get(id)).find(a => a && (roster[a.id] ?? []).includes("medic"));
  if ( !doc || crewDown(doc) ) return;
  const hurt = Object.keys(roster).map(id => game.actors.get(id)).filter(a => a?.type === "character")
    .map(a => ({ a, hp: a.system.attributes.hp.value, max: a.system.attributes.hp.max }))
    .filter(x => (x.hp <= 0) || (x.hp < x.max / 2)).sort((x, y) => (x.hp / x.max) - (y.hp / y.max))[0];
  if ( !hurt ) return;
  const key = crewKey(ship, doc, "medic");
  if ( !canUse(ship, doc, "medic", { name: "Healing Word", activation: { type: "bonus" } }).ok ) return;
  const slot = doc.system.spells?.spell1;
  const wis = Number(doc.system.abilities.wis.mod) || 0;
  let what, formula;
  if ( doc.items.some(i => i.name === "Healing Word") && (slot?.value > 0) ) {
    await doc.update({ "system.spells.spell1.value": slot.value - 1 });
    what = "Healing Word"; formula = `2d4 + ${wis}`;
  } else {
    const stim = doc.items.find(i => i.name === "Healing Stim" && (i.system.quantity > 0));
    if ( !stim ) return;
    await stim.update({ "system.quantity": stim.system.quantity - 1 });
    what = "Healing Stim"; formula = "2d4 + 2";
  }
  const r = await new Roll(formula).evaluate();
  await r.toMessage({ speaker: ChatMessage.implementation.getSpeaker({ actor: doc }), flavor: `${what} on ${hurt.a.name}` });
  const to = Math.min(hurt.max, Math.max(0, hurt.hp) + r.total);
  await hurt.a.update({ "system.attributes.hp.value": to });
  await request({ action: "useSlot", uuid: ship.uuid, key, slot: "bonus", name: what });
  say(`${doc.name}: ${what} on ${hurt.a.name} → ${to}/${hurt.max} HP`);
}

/* ---------- disabled crewed ship ---------- */
async function repairTurn(tok) {
  const ship = tok.actor;
  say(`— ${tok.name} DISABLED (${disabledReason(ship)}; Tempo ${tempo(ship)}, Strain ${getState(ship).strain}, Mishaps ${activeMishaps(ship).length})`);
  const TIER = ["Minor", "Standard", "Major", "Critical", "Catastrophic"], CRIT = ["power", "propulsion", "command"];
  const crew = Object.keys(crewOf(baseActor(ship) ?? ship)).map(id => game.actors.get(id)).filter(a => a?.type === "character");
  const eng = crew.find(c => (crewOf(baseActor(ship) ?? ship)[c.id] ?? []).includes("engineer"));
  if ( eng && (getState(ship).strain > (Number(ship.system.attributes.hp.max) || 0)) && tempo(ship) >= 1 && await act(ship, eng, "engineer", "Vent") ) say(`${eng.name}: Vent`);
  for ( const c of crew.filter(c => (crewOf(baseActor(ship) ?? ship)[c.id] ?? []).every(r => r === "any")) ) {
    if ( activeMishaps(ship).some(isFire) && (tempo(ship) >= 2) && await act(ship, c, "any", "Fire Suppression") ) {
      const r = await request({ action: "suppressFire", uuid: ship.uuid, by: c.name });
      say(`${c.name}: Fire Suppression → ${r?.line?.replace(/<[^>]+>/g, "") ?? r?.error}`);
      continue;
    }
    if ( (getState(ship).strain > (Number(ship.system.attributes.hp.max) || 0)) && tempo(ship) >= 1 && await act(ship, c, "any", "Shore Up") ) say(`${c.name}: Shore Up → Strain ${getState(ship).strain}`);
  }
  await medicTurn(ship);
  const walkers = {};
  for ( const c of crew ) {
    const m = [...activeMishaps(ship)].filter(m => (walkers[m.id] ?? 0) < 2)
      .sort((a, b) => (isFire(b) - isFire(a)) || (CRIT.includes(b.system) - CRIT.includes(a.system)) || (TIER.indexOf(b.tier) - TIER.indexOf(a.tier)))[0];
    if ( !m ) break;
    walkers[m.id] = (walkers[m.id] ?? 0) + 1;
    if ( !await act(ship, c, "any", "Correct") ) continue;
    say(`${c.name} leaves station to Correct ${m.name} (${m.system}): ${await runCorrect(ship, "Correct", { pickId: m.id, bonus: stationCheck(ship, c, "any").bonus, crew: c })}`);
  }
  say(`${tok.name} ends: ${disabledReason(ship) || "back online"}`);
}

/* ---------- fighter turn ---------- */
async function fighterTurn(tok) {
  const ship = tok.actor;
  const big = weakestFirst(enemiesOf(tok))[0];
  say(`— ${tok.name} ${tok.id.slice(0, 2)} (Tempo ${tempo(ship)}, Strain ${getState(ship).strain}${shipImpaired(ship) ? ", SHIP IMPAIRED" : ""})`);
  if ( !big ) return;
  const mt = Number(ship.system.attributes.hp.mt) || 0;
  const canPay = n => (tempo(ship) >= n) || (getState(ship).strain + 2 * (n - tempo(ship)) <= mt);
  let fired = false;
  if ( canPay(1) && await act(ship, null, "helmsman", "Maneuver") ) {
    await waitFor(() => getState(ship).helm === 1 && getState(ship).speed > 0);
    const bc = center(big), brot = big.rotation ?? 0;
    let best = null;
    for ( const opt of reachable(tok) ) {
      if ( opt.seq.length && occupied(tok, opt.pt) ) continue;
      const mine = weaponsReaching(ship, opt.pt, opt.rot, bc).sort((a, b) => b.avg - a.avg)[0];
      const threat = weaponsReaching(big.actor, bc, brot, opt.pt).reduce((n, w) => n + w.avg, 0);
      const d = hexd(opt.pt, bc);
      const score = (mine ? mine.avg * 3 : 0) - threat * 1.5 - Math.max(0, d - 4) * 0.5 - opt.spent * 0.05;
      if ( !best || score > best.score ) best = { ...opt, score };
    }
    if ( best?.seq.length ) {
      await moveAlong(tok, best.seq);
      const o = grid().getOffset(center(tok));
      say(`${tok.id.slice(0, 2)} moves ${best.seq.join(", ")} → r${o.i}c${o.j}, ${hexd(center(tok), bc)} hexes from ${big.name}`);
    }
  }
  const sols = armed(tok).filter(s => s.target.id === big.id).sort((a, b) => avgDamage(b.item, ship) - avgDamage(a.item, ship));
  if ( sols.length && canPay(1) && await act(ship, null, "gunner", "Fire") ) {
    await shoot(tok, sols[0], { gunner: null });
    await returnFire(big, tok);
    fired = true;
  }
  if ( !fired ) await gainTempo(ship, null);
}

/* ---------- setup and loop ---------- */
/** Put the scene back to the starting positions with full ammo, torpedoes and clean state. */
export const START = {
  // John's starting positions (2026-10-26): the fighters come in from long range.
  "M-34 Assault Destroyer": [{ i: 16, j: 23, rot: 0 }],
  "S.S. Swiffer": [{ i: 16, j: 24, rot: 0 }],
  "M-18 Fighter": [{ i: 11, j: 42 }, { i: 10, j: 43 }, { i: 9, j: 44 }, { i: 11, j: 44 }, { i: 11, j: 45 }].map(p => ({ ...p, rot: 240 }))
};
export async function reset({ keepPositions = false } = {}) {
  const sc = SCENE = canvas.scene, g = sc.grid;
  if ( !sc?.getFlag(MODULE_ID, "sectorMap") ) throw new Error(`Autopilot: ${sc?.name} is not a sector map; view Sector 001 first.`);
  for ( const c of game.combats.filter(c => c.scene?.id === sc.id) ) await c.delete();
  await sleep(1500);   // let end-of-turn work queued by the last turn finish before clearing state
  const torps = sc.tokens.filter(t => isTorp(t)).map(t => t.id);
  if ( torps.length ) await sc.deleteEmbeddedDocuments("Token", torps);
  const used = {};
  for ( const t of sc.tokens.filter(t => t.actor?.type === "vehicle" && !t.getFlag(MODULE_ID, "radarMirror")) ) {
    const upd = {};
    // State is set to a clean slate, not removed: a bridge reads a ship with no state back from its drawings.
    upd[`flags.${MODULE_ID}.state`] = { tempo: 0, strain: 0, speed: shipSpeed(t.actor), bands: 0, facings: 0, helm: 0 };
    for ( const k of ["econ", "activeMishaps", "ammoUsed", "torpedoesUsed", "hotMeal", "commandDice", "fired", "attackPosition", "shieldsUp", "stim"] ) {
      if ( t.actor.flags?.[MODULE_ID]?.[k] !== undefined ) upd[`flags.${MODULE_ID}.-=${k}`] = null;
    }
    if ( Object.keys(upd).length ) await t.actor.update(upd);
    const n = used[t.name] = (used[t.name] ?? -1) + 1, p = keepPositions ? null : START[t.name]?.[n];
    if ( p ) {
      const c = g.getCenterPoint({ i: p.i, j: p.j });
      await t.update({ x: c.x - (t.width * g.sizeX) / 2, y: c.y - (t.height * g.sizeY) / 2, rotation: p.rot }, { animate: false });
    }
  }
  // Crew back at their stations, at full HP, with no conditions a Mishap left on them.
  const H = await import("../ship-hud.mjs");
  for ( const t of sc.tokens.filter(t => t.actor?.type === "vehicle" && !t.getFlag(MODULE_ID, "radarMirror")) ) {
    await H.crewHome(t.actor);
    const bridge = H.bridgeOf(t.actor);
    const ids = new Set([...Object.keys(crewOf(baseActor(t.actor) ?? t.actor)),
      ...(bridge?.tokens.filter(x => x.actor?.type === "character").map(x => x.actorId) ?? [])]);
    for ( const id of ids ) {
      const a = game.actors.get(id);
      if ( !a ) continue;
      const hp = a.system.attributes?.hp;
      if ( hp && (hp.value !== hp.max) ) await a.update({ "system.attributes.hp.value": hp.max });
      for ( const st of ["prone", "restrained", "poisoned", "charmed", "frightened", "unconscious"] ) if ( a.statuses?.has(st) ) await a.toggleStatusEffect(st, { active: false });
    }
  }
  say("Scene reset: starting positions, full ammo and torpedoes, clean state, crew at stations and full HP");
}

export async function setup({ bigName = "M-34 Assault Destroyer", hotMeal = true } = {}) {
  const sc = SCENE = canvas.scene;
  if ( !sc?.getFlag(MODULE_ID, "sectorMap") ) throw new Error(`Autopilot: ${sc?.name} is not a sector map; view Sector 001 first.`);
  const big = sc.tokens.find(t => t.name === bigName);
  if ( big && (!big.actorLink || big.disposition !== CONST.TOKEN_DISPOSITIONS.FRIENDLY) ) {
    await big.update({ actorLink: true, disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY });
    say(`${bigName}: linked to its actor and set Friendly`);
  }
  for ( const t of sc.tokens.filter(t => t.actor?.type === "vehicle" && !t.getFlag(MODULE_ID, "radarMirror")) ) await t.actor.setFlag(MODULE_ID, "autoRun", true);
  const ship = sc.tokens.find(t => t.name === bigName)?.actor;
  if ( hotMeal && ship ) {
    const cook = crewWith(ship, "cook")[0];
    if ( cook ) {
      const chk = stationCheck(ship, cook, "cook");
      const roll = await new Roll(`${chk.dice} + ${chk.bonus}`).evaluate();
      await roll.toMessage({ speaker: ChatMessage.implementation.getSpeaker({ actor: cook }), flavor: "Hot Meal: Galley station check vs DC 12" });
      const bonus = roll.total >= 20 ? 4 : roll.total >= 12 ? 2 : 0;
      if ( bonus ) await ship.setFlag(MODULE_ID, "hotMeal", bonus);
      say(`Hot Meal: ${roll.total} → +${bonus} Tempo`);
    }
  }
  let combat = game.combats.find(c => c.scene?.id === sc.id);
  if ( !combat ) combat = await Combat.implementation.create({ scene: sc.id, active: true });
  const ids = sc.tokens.filter(t => t.actor?.type === "vehicle" && !t.getFlag(MODULE_ID, "radarMirror")).map(t => t.id);
  const have = new Set(combat.combatants.map(c => c.tokenId));
  await combat.createEmbeddedDocuments("Combatant", ids.filter(id => !have.has(id)).map(tokenId => ({ tokenId, sceneId: sc.id })));
  await combat.rollAll();
  if ( !combat.started ) await combat.startCombat();
  await sleep(1500);
  say(`Encounter started: ${combat.turns.map(c => `${c.name} ${c.tokenId.slice(0, 2)} (${c.initiative})`).join(", ")}`);
  return combat;
}

export function over(bigName = "M-34 Assault Destroyer") {
  const big = scn().tokens.find(t => t.name === bigName);
  if ( !big ) return "big ship missing";
  // The big ship's side (allies included) loses when every ship on it is disabled.
  const side = scn().tokens.filter(t => (t.actor?.type === "vehicle") && (t.disposition === big.disposition)
    && !t.getFlag(MODULE_ID, "radarMirror") && !isTorp(t));
  if ( side.every(t => isOut(t)) ) return side.length > 1 ? "all allied ships disabled" : "big ship disabled";
  if ( !enemiesOf(big).length ) return "all fighters disabled";
  return null;
}

/** Play the current combatant's turn and move to the next. */
export async function turn(bigName = "M-34 Assault Destroyer") {
  const c = cbt()?.combatant;
  if ( !c ) return;
  const tok = c.token;
  if ( isTorp(tok) ) {
    // The GM client's torpedo hook moves it and advances the encounter.
    const id = c.id, round = cbt().round, t0 = Date.now();
    while ( (cbt()?.combatant?.id === id) && (cbt().round === round) && (Date.now() - t0 < 30000) ) await sleep(250);
    return;
  }
  // Crew who walked to a Mishap last turn go back to their stations at the start of this one, and get their
  // station roles back when they arrive: wait for that before the crew act.
  {
    const H = await import("../ship-hud.mjs");
    const bridge = H.bridgeOf(tok.actor);
    if ( bridge?.tokens.some(t => t.getFlag(MODULE_ID, "crewHome")) ) {
      await waitFor(() => !bridge.tokens.some(t => t.getFlag(MODULE_ID, "crewHome")), 4000);
      await sleep(1500);
    }
  }
  // Crewed ships on the big ship's side (allies) play the crew doctrine; the rest fly as fighters.
  const big = scn().tokens.find(t => t.name === bigName);
  const crewed = Object.keys(crewOf(baseActor(tok.actor) ?? tok.actor)).some(id => game.actors.get(id)?.type === "character");
  const ours = (tok.name === bigName) || (big && (tok.disposition === big.disposition) && crewed);
  if ( !c.defeated && !isOut(tok) ) {
    if ( ours ) await bigShipTurn(tok);
    else await fighterTurn(tok);
  }
  // A disabled crewed ship keeps its turn (John, 2026-10-26): everyone who can works the Mishaps.
  else if ( !c.defeated && ours ) await repairTurn(tok);
  await cbt().nextTurn();
  await sleep(800);
}

export async function run({ maxRounds = 10, bigName = "M-34 Assault Destroyer" } = {}) {
  while ( cbt() && cbt().round <= maxRounds ) {
    const why = over(bigName);
    if ( why ) { say(`Battle over: ${why} (round ${cbt().round})`); return why; }
    await turn(bigName);
  }
  say(`Stopped after round ${maxRounds}`);
  return "round limit";
}
