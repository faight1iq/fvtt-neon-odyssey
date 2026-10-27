// Ship state (John, 2026-10-25): Tempo, Strain and Speed are attributes of the vehicle actor, so the
// bridge HUD and the sector map show the same numbers. The bridge drawings only display them.
//
//   flags["fvtt-neon-odyssey"].state = { tempo, strain, speed, bands, facings }
//     speed   = Speed left this round (the maximum is the ship's designed Speed, see shipSpeed)
//     bands   = hexes moved forward this round, facings = facing changes this round
//   flags["fvtt-neon-odyssey"].activeMishaps = [{ id, system, uuid, name, img, tier }]
//     One Mishap on a system Impairs it; its size in Mishaps (Tiny 1 … Gargantuan 6) puts it Offline.
//   flags["fvtt-neon-odyssey"].crew = { <character actor id>: [role keys] }   (saved from the bridge)
//   flags["fvtt-neon-odyssey"].crewBonus = { quality, commander, helmsman, navigator, engineer, gunner }
//   flags["fvtt-neon-odyssey"].bridgeSceneId   (set when the ship is put on a bridge display)
//
// Enemy ships are unlinked tokens: all of this lives on the token's own copy of the actor.
// Every change is made by the active GM. Other clients ask through a Foundry v13 query.

import { mishapAlert, MISHAP_TIERS } from "./mishap-links.mjs";
import { FACINGS, LOCATION_KEYS, stationLocation, MISHAP_ALIASES } from "./starship-calc.mjs";

export const MODULE_ID = "fvtt-neon-odyssey";
const QUERY = `${MODULE_ID}.ship`;

/* -------------------------------------------- */
/*  Movement costs (John, 2026-10-25)           */
/* -------------------------------------------- */

/** Facing changes in one round, in either direction: 1, 3, 6, 12, 24 (running 1, 4, 10, 22, 46). */
const FACING_COSTS = [1, 3, 6, 12, 24];
export const nextFacingCost = n => n < FACING_COSTS.length ? FACING_COSTS[n] : FACING_COSTS.at(-1) * 2 ** (n - FACING_COSTS.length + 1);
/** Hexes forward in one round: 1, 2, 3, 4 ... (running 1, 3, 6, 10, 15, 21, 28, 36). One hex = one range band. */
export const nextForwardCost = n => n + 1;
/** Six facings on a flat-topped hex grid. */
export const FACING_DEGREES = 60;

/* -------------------------------------------- */
/*  State                                       */
/* -------------------------------------------- */

/** A ship's Speed per round: its designed Speed (or its movement value), minimum 1. */
export function shipSpeed(actor) {
  const f = actor?.flags?.[MODULE_ID] ?? {};
  const key = f.movementKey ?? "fly";
  const raw = Number.isFinite(Number(f.speed)) ? Number(f.speed) : Number(actor?.system?.attributes?.movement?.[key]);
  return Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 1);
}

/** The ship's state, with defaults (full Speed, nothing spent). */
export function getState(actor) {
  const s = actor?.flags?.[MODULE_ID]?.state ?? {};
  const int = (v, d) => Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d;
  return {
    tempo: Math.max(0, int(s.tempo, 0)),
    strain: Math.max(0, int(s.strain, 0)),
    speed: Math.max(0, int(s.speed, shipSpeed(actor))),
    bands: Math.max(0, int(s.bands, 0)),
    facings: Math.max(0, int(s.facings, 0)),
    // 1 once the Helmsman has used Maneuver this turn (John, 2026-10-25): in combat the move buttons
    // need it, and the Speed left at the end of the ship's turn goes back to Tempo (half, rounded up).
    helm: Math.min(1, Math.max(0, int(s.helm, 0)))
  };
}

/** Whether the ship is a combatant in a started encounter (the Maneuver rule applies only then). */
export function inCombat(actor) {
  if ( !actor ) return false;
  const base = baseActor(actor) ?? actor;
  return game.combats.some(c => c.started && c.combatants.some(cb => {
    const a = cb.token?.actor ?? cb.actor;
    if ( !a ) return false;
    return (a.uuid === actor.uuid) || (cb.token?.actorLink && (cb.actorId === base.id));
  }));
}

/** In combat, the move buttons work only after Maneuver this turn. */
export const mustManeuver = actor => inCombat(actor) && !getState(actor).helm;

/** Whether a ship has ever had its state written (old ships keep using the bridge drawings until then). */
export const hasState = actor => !!actor?.flags?.[MODULE_ID]?.state;

/** Write part of the state (GM). */
export async function setState(actor, patch, options = {}) {
  if ( !actor ) return;
  const next = { ...getState(actor), ...patch };
  for ( const k of Object.keys(next) ) next[k] = Math.max(0, Math.trunc(Number(next[k]) || 0));
  await actor.update({ [`flags.${MODULE_ID}.state`]: next }, options);
}

/** A new round of maneuvering (Maneuver, or the GM's refill): Speed back to full, no hexes or facings spent. */
export function refillSpeed(actor) {
  return setState(actor, { speed: shipSpeed(actor), bands: 0, facings: 0, helm: 1 });
}

/**
 * End of the ship's turn (John, 2026-10-25): half the Speed left over, rounded up, goes back to Tempo,
 * and Speed drops to 0 until the next Maneuver. Returns a chat line, or null when nothing changed.
 */
export async function endHelmTurn(actor, name = actor?.name) {
  if ( !actor ) return null;
  const st = getState(actor);
  if ( !st.helm && !st.speed ) return null;
  const back = Math.ceil(st.speed / 2);
  await setState(actor, { tempo: st.tempo + back, speed: 0, bands: 0, facings: 0, helm: 0 });
  if ( !back ) return null;
  const esc = foundry.utils.escapeHTML;
  return `<strong>${esc(name)}</strong>: ${st.speed} Speed unused → +${back} Tempo (${st.tempo} → ${st.tempo + back}).`;
}

/* -------------------------------------------- */
/*  Systems                                     */
/* -------------------------------------------- */

export const WEAPON_SYSTEMS = FACINGS;   // bow, port, starboard, aft
export const SYSTEM_LABELS = {
  shields: "Shields", armor: "Armor", hull: "Hull", bow: "Bow Weapons", command: "Command & Control",
  navigation: "Navigation", port: "Port Weapons", habitat: "Habitat", starboard: "Starboard Weapons",
  power: "Power", propulsion: "Propulsion", aft: "Aft Weapons"
};

/** The system an installed component belongs to (the same blocks as the bridge Component Area). */
export function systemOfItem(item) {
  const c = item?.flags?.[MODULE_ID]?.component;
  if ( !c ) return null;
  const facing = item.flags[MODULE_ID]?.facing;
  switch ( c.slot ) {
    case "weapon": return FACINGS.includes(facing) ? facing : "bow";
    case "habitat": {
      const roles = c.stationRoles;
      if ( !roles?.length ) return "habitat";
      const loc = stationLocation(item.flags[MODULE_ID]?.location, facing, roles[0]);
      return LOCATION_KEYS.includes(loc) ? loc : (["command", "navigation", "power"].includes(c.hudSystem) ? c.hudSystem : "command");
    }
    case "nexus": return "command";
    case "comms": case "sensory": return "navigation";
    case "power": return "power";
    case "propulsion": return "propulsion";
    case "armor": return "armor";
    case "deflector": case "ablative": return "shields";
    case "material": case "shipClass": return "hull";
    default: return null;
  }
}

/** The systems a ship has. Hull always. */
export function shipSystems(actor) {
  const out = new Set(["hull"]);
  for ( const item of actor?.items ?? [] ) {
    const s = systemOfItem(item);
    if ( s ) out.add(s);
  }
  return out;
}

/** Systems each station role depends on. Any Station depends on none. */
export const ROLE_SYSTEMS = {
  commander: ["command"], helmsman: ["propulsion"], navigator: ["navigation"],
  engineer: ["power"], gunner: WEAPON_SYSTEMS,
  // Medic and Cook work from the Habitat (Medical Bay, Galley) (John, 2026-10-26).
  medic: ["habitat"], cook: ["habitat"]
};

/** Active Mishaps on a ship. */
export const activeMishaps = actor => actor?.flags?.[MODULE_ID]?.activeMishaps ?? [];

/**
 * Mishaps that take a system Offline (John, 2026-10-26): the ship's size, Tiny 1, Small 2, Medium 3, Large 4,
 * Huge 5, Gargantuan 6. Fewer than that (but at least one) Impair it.
 */
const SIZE_OFFLINE = { tiny: 1, sm: 2, small: 2, med: 3, medium: 3, lg: 4, large: 4, huge: 5, grg: 6, gargantuan: 6 };
export function offlineAt(actor) {
  const size = String(actor?.flags?.[MODULE_ID]?.sizeName ?? actor?.system?.traits?.size ?? "").toLowerCase();
  return SIZE_OFFLINE[size] ?? 2;
}
/**
 * Mishaps that never count toward taking a system Offline there (John, 2026-10-25): an injured crew is
 * not a broken Habitat. Matched by the Mishap's name.
 */
export const NO_OFFLINE = { habitat: [/crew[\s-]*injury/i] };
export const countsTowardOffline = m => !(NO_OFFLINE[m.system] ?? []).some(rx => rx.test(m.name ?? ""));
// A Mishap's System Failure adds a second Mishap token to its system until it is Corrected (extra: 1).
export const mishapsOn = (actor, system) => activeMishaps(actor).filter(m => (m.system === system) && countsTowardOffline(m))
  .reduce((n, m) => n + 1 + (Number(m.extra) || 0), 0);
/** A timed Mishap effect ({ combatId, round }) still running: until the start of that round. */
export const untilActive = u => { const c = u && game.combats.get(u.combatId); return !!c && (c.round < u.round); };
/** System Lockout: a Mishap locks its system until the start of the next round. */
export const systemLocked = (actor, system) => activeMishaps(actor).some(m => (m.system === system) && untilActive(m.lockUntil));
export const systemOffline = (actor, system) => (mishapsOn(actor, system) >= offlineAt(actor)) || systemLocked(actor, system);
/** Ship Disruption: AC down 1 per running effect, until the start of the next round. */
export const disruptionAC = actor => activeMishaps(actor).filter(m => untilActive(m.acDownUntil)).length;
export const systemImpaired = (actor, system) => { const n = mishapsOn(actor, system); return (n >= 1) && (n < offlineAt(actor)); };

/*
 * Impaired (John, 2026-10-26): rolls made with an Impaired system have Disadvantage. While a critical system
 * (Power, Propulsion, Command) is Impaired the whole ship is Impaired: every ship system roll has Disadvantage.
 * Ship system rolls are station checks and weapon attacks, not Correct, Triage, Fire Team or Gain Tempo.
 * Stim Shot: one crew member ignores this for 1 minute (flags.stim = { actorId: world time it ends }).
 */
export const shipImpaired = actor => ["power", "propulsion", "command"].some(s => systemImpaired(actor, s));
export const stimmed = (ship, crewActor) => !!crewActor
  && ((Number((baseActor(ship) ?? ship)?.flags?.[MODULE_ID]?.stim?.[crewActor.id]) || 0) > game.time.worldTime);
/** Why a roll with these systems has Disadvantage ("" if it doesn't). */
export function impairedReason(ship, systems = [], crewActor = null) {
  if ( !ship || stimmed(ship, crewActor) ) return "";
  const crit = ["power", "propulsion", "command"].filter(s => systemImpaired(ship, s));
  if ( crit.length ) return `ship Impaired (${crit.map(s => SYSTEM_LABELS[s] ?? s).join(", ")})`;
  const own = (systems ?? []).filter(s => s && systemImpaired(ship, s));
  return own.length ? `${own.map(s => SYSTEM_LABELS[s] ?? s).join(", ")} Impaired` : "";
}
/** The d20 for a check: Advantage and Disadvantage cancel. */
export const d20 = (adv, dis) => (adv && !dis) ? "2d20kh" : (dis && !adv) ? "2d20kl" : "1d20";

/**
 * Whether a role's actions are unusable (red X): every system it depends on that the ship has is
 * Offline. A role whose systems the ship doesn't have at all is never crossed out.
 */
export function roleOffline(actor, role) {
  const systems = ROLE_SYSTEMS[role];
  if ( !systems ) return false;
  const have = shipSystems(actor);
  const present = systems.filter(s => have.has(s));
  return present.length > 0 && present.every(s => systemOffline(actor, s));
}

/** Enemy ships: a role is offered when the ship has a system it depends on (Any Station always). */
export function roleAvailable(actor, role) {
  if ( role === "any" ) return true;
  const systems = ROLE_SYSTEMS[role];
  if ( !systems ) return false;
  const have = shipSystems(actor);
  return systems.some(s => have.has(s));
}

/** Systems whose components list a mishap key (a rolled Mishap lands on one of them). */
export function systemsForMishapKey(actor, key) {
  const out = [];
  for ( const item of actor?.items ?? [] ) {
    const c = item.flags?.[MODULE_ID]?.component;
    const keys = (c?.mishaps ?? []).map(m => MISHAP_ALIASES[m] ?? m);
    if ( keys.includes(key) ) {
      const s = systemOfItem(item);
      if ( s ) out.push(s);
    }
  }
  return [...new Set(out)];
}

/** Add an active Mishap to a system (GM). */
export async function addMishap(actor, { uuid, name, img, tier, system, key }) {
  if ( !actor ) return null;
  if ( !system ) {
    const options = key ? systemsForMishapKey(actor, key) : [];
    system = options.length ? options[Math.floor(Math.random() * options.length)] : "hull";
  }
  if ( !img && uuid ) img = (await fromUuid(uuid))?.img ?? null;
  const entry = { id: foundry.utils.randomID(), system, uuid: uuid ?? null, name: name ?? "Mishap",
    img: img ?? "icons/svg/hazard.svg", tier: tier ?? null };
  await actor.update({ [`flags.${MODULE_ID}.activeMishaps`]: [...activeMishaps(actor), entry] });
  return entry;
}

/* -------------------------------------------- */
/*  Damage, Strain and Mishaps (rule 16)        */
/* -------------------------------------------- */
// Rule 16 (John, 2026-10-12) with John's rulings of 2026-10-25:
//  - Damage goes to Strain. Once Strain is over the Mishap Threshold, every hit causes a Mishap, including
//    the hit that crosses it. A natural 20 always causes a Mishap (and doubles the damage dice).
//  - The Mishap's tier follows the weapon's size: Tiny/Small Minor, Medium Standard, Large Major,
//    Huge Critical, Gargantuan Catastrophic.
//  - With Armor, the first 2 Mishaps go to the Armor; after that each goes to a random system the ship has.
//  - Strain over HP, or Offline (size in Mishaps) on Power, Propulsion or Command & Control, disables the ship.
//  - Clearing a Mishap removes Strain by its tier: Minor 2, Standard 5, Major 10, Critical 15, Catastrophic 25.

const SIZE_TIER = { tiny: 0, small: 0, medium: 1, large: 2, huge: 3, gargantuan: 4 };
export const CLEAR_STRAIN = [2, 5, 10, 15, 25];
const HIT_SYSTEMS = ["bow", "command", "navigation", "port", "starboard", "aft", "power", "propulsion", "habitat"];
const CRITICAL_SYSTEMS = ["power", "propulsion", "command"];
const tierIndex = t => typeof t === "number" ? t : Math.max(0, MISHAP_TIERS.indexOf(t));

/** Why the ship is disabled ("" if it isn't). */
export function disabledReason(actor) {
  const hp = Number(actor?.system?.attributes?.hp?.max) || 0;
  const strain = getState(actor).strain;
  if ( hp && (strain > hp) ) return `Strain ${strain} is over its ${hp} HP`;
  const n = offlineAt(actor), crit = CRITICAL_SYSTEMS.filter(s => mishapsOn(actor, s) >= n);
  if ( crit.length ) return `${crit.map(s => SYSTEM_LABELS[s]).join(", ")} has ${n} Mishap${n === 1 ? "" : "s"}`;
  return "";
}

/**
 * A disabled ship keeps its turns (John, 2026-10-26): its crew can't move it, fire or jam, but can still act,
 * Correct its Mishaps and bring it back online. So it is no longer marked defeated; the red X shows it. A
 * defeated mark this code set before is cleared once the ship is back. (GM)
 */
export async function syncDisabled(actor, tokenDoc = null) {
  const off = false;
  for ( const combat of game.combats ) {
    if ( !combat.started ) continue;
    for ( const c of combat.combatants ) {
      const a = c.token?.actor ?? c.actor;
      const same = tokenDoc ? (c.tokenId === tokenDoc.id) : (a?.uuid === actor.uuid);
      if ( same && (c.defeated !== off) ) await c.update({ defeated: off });
    }
  }
}

/**
 * A weapon hit lands on a ship (GM). Returns the chat lines.
 * @param {Actor} actor            The target ship (a token's own actor for unlinked ships).
 * @param {object} hit             { damage, size, crit, weapon, attacker, tokenDoc }
 */
/**
 * Give a ship one Mishap of this tier (0 Minor … 4 Catastrophic): Armor takes the first 2, then a random
 * system the ship has; the Mishap is rolled from its Possible Mishaps that fit that system. Returns a chat line.
 */
export async function rollMishapOnto(actor, tier = 0, { armor = true } = {}) {
  const systems = shipSystems(actor);
  let system, how;
  const onArmor = activeMishaps(actor).filter(m => m.system === "armor").length;
  if ( armor && systems.has("armor") && (onArmor < 2) ) { system = "armor"; how = "the Armor takes it"; }
  else {
    const pool = HIT_SYSTEMS.filter(s => systems.has(s));
    const roll = await new Roll(`1d${pool.length || 1}`).evaluate();
    system = pool[roll.total - 1] ?? "hull";
    how = `system d${pool.length}: ${roll.total}`;
  }
  const { possibleMishaps } = await import("./mishap-links.mjs");
  // Standard Mishaps carry no tier word in their names ("Fire", not "Standard Fire").
  const tierOfName = n => { const w = String(n ?? "").split(" ")[0]; const i = MISHAP_TIERS.indexOf(w); return (i >= 0 && w !== "Standard") ? i : 1; };
  const all = (await possibleMishaps(actor, tier)).filter(p => !p.missing && (tierOfName(p.name) === tier));
  const fits = system === "armor" ? all : all.filter(p => systemsForMishapKey(actor, p.key).includes(system));
  const pool = fits.length ? fits : all;
  let picked = null;
  if ( pool.length ) {
    const r = await new Roll(`1d${pool.length}`).evaluate();
    picked = pool[r.total - 1];
  }
  await addMishap(actor, { uuid: picked?.uuid ?? null, name: picked?.name ?? `${MISHAP_TIERS[tier]} Mishap`, tier: MISHAP_TIERS[tier], system });
  return `<strong>${picked ? `@UUID[${picked.uuid}]{${picked.name}}` : `${MISHAP_TIERS[tier]} Mishap`}</strong> on ${SYSTEM_LABELS[system] ?? system} (${how}).`;
}

/**
 * Strain from anything other than a weapon hit (John, 2026-10-25): failed rolls, action costs, Electronic
 * Warfare… The first time Strain goes over the Mishap Threshold, and every later time Strain is added while
 * it is over, the ship gets a Minor Mishap. Returns chat HTML ("" if none). (GM)
 */
export async function strainMishap(actor, before, after) {
  const mt = Number(actor?.system?.attributes?.hp?.mt) || 0;
  if ( !actor || !mt || (after <= before) || (after <= mt) ) return "";
  // Not from a hit, so it lands on a random internal system, never the Armor (John, 2026-10-25).
  const line = await rollMishapOnto(actor, 0, { armor: false });
  await syncDisabled(actor);
  const why = disabledReason(actor);
  return `<p class="no-crew-alert"><strong>MISHAP!</strong> Strain ${before} → ${after}, over the Mishap Threshold (${mt}): ${line}${why ? `<br><strong>Disabled:</strong> ${why}.` : ""}</p>`;
}

export async function applyHit(actor, { damage = 0, size = "Tiny", crit = false, weapon = "Weapon", attacker = "", tokenDoc = null } = {}) {
  const st = getState(actor);
  const hp = actor.system.attributes?.hp ?? {};
  const mt = Number(hp.mt) || 0;
  const after = st.strain + Math.max(0, damage);
  await setState(actor, { strain: after });
  const name = tokenDoc?.name ?? actor.name;
  const lines = [`<strong>${foundry.utils.escapeHTML(weapon)}</strong>${attacker ? ` from ${foundry.utils.escapeHTML(attacker)}` : ""}: ${damage} damage${crit ? " (critical)" : ""} → Strain ${st.strain} → ${after}.`];

  if ( (mt && (after > mt)) || crit ) {
    const tier = SIZE_TIER[String(size).toLowerCase()] ?? 0;
    const m = await rollMishapOnto(actor, tier);
    lines.push(`${crit ? "Natural 20" : `Over its Mishap Threshold (${mt})`}: ${m}`);
  } else if ( mt ) lines.push(`Mishap Threshold ${mt} not passed: no Mishap.`);

  const why = disabledReason(actor);
  if ( why ) lines.push(`<strong>${foundry.utils.escapeHTML(name)} is disabled:</strong> ${why}.`);
  await syncDisabled(actor, tokenDoc);
  await ChatMessage.implementation.create({
    content: `<div class="no-crew-card"><h3>Hit on ${foundry.utils.escapeHTML(name)}</h3><p>${lines.join("<br>")}</p></div>`,
    speaker: { alias: "Damage" }, flags: { [MODULE_ID]: { crewResult: true } }
  });
  return lines;
}

export async function removeMishap(actor, id) {
  const entry = activeMishaps(actor).find(m => m.id === id);
  await actor.update({ [`flags.${MODULE_ID}.activeMishaps`]: activeMishaps(actor).filter(m => m.id !== id) });
  // Clearing a Mishap removes Strain by its tier (John, 2026-10-25).
  if ( entry ) {
    const less = CLEAR_STRAIN[tierIndex(entry.tier)] ?? 2;
    const st = getState(actor);
    await setState(actor, { strain: Math.max(0, st.strain - less) });
    await card(actor, `<p>${foundry.utils.escapeHTML(entry.name)} cleared from ${SYSTEM_LABELS[entry.system] ?? entry.system}: Strain ${st.strain} → ${Math.max(0, st.strain - less)}.</p>`);
    await syncDisabled(actor);
  }
  // A Mishap placed as a token on the bridge's Component Area: remove its token too.
  if ( entry?.fromToken ) {
    for ( const scene of game.scenes ) {
      const t = scene.tokens.get(entry.fromToken);
      if ( t ) { await t.delete(); break; }
    }
  }
}


/*
 * Fire Suppression (Deck crew, Action, 2 Tempo; John, 2026-10-26): from the station, knock one Fire on the ship
 * down a level (Catastrophic → Critical → Major → Fire → Minor → out). A Fire the crew member has targeted, else
 * the worst one. Fire spreads, so it gets dealt with first. (GM) Returns { ok, line }.
 */
export const isFire = m => /(^|\s)Fire$/i.test(String(m?.name ?? ""));
export async function suppressFire(ship, { id = null, by = "Deck crew" } = {}) {
  const fires = activeMishaps(ship).filter(isFire);
  if ( !fires.length ) return { ok: false, error: "No Fire to suppress." };
  const entry = fires.find(m => m.id === id) ?? [...fires].sort((a, b) => tierIndex(b.tier) - tierIndex(a.tier))[0];
  const t = tierIndex(entry.tier);
  let line;
  if ( t <= 0 ) {
    await removeMishap(ship, entry.id);
    line = `${foundry.utils.escapeHTML(by)} puts out the ${foundry.utils.escapeHTML(entry.name)} on ${SYSTEM_LABELS[entry.system] ?? entry.system}.`;
  } else {
    const tier = MISHAP_TIERS[t - 1];
    const name = tier === "Standard" ? "Fire" : `${tier} Fire`;
    const e = game.packs.get(`${MODULE_ID}.actors`)?.index.find(x => x.name === name);
    const uuid = e ? (e.uuid ?? `Compendium.${MODULE_ID}.actors.Actor.${e._id}`) : entry.uuid;
    const img = e ? ((await fromUuid(uuid))?.img ?? entry.img) : entry.img;
    await ship.update({ [`flags.${MODULE_ID}.activeMishaps`]: activeMishaps(ship).map(m => m.id === entry.id
      ? { ...m, name, tier, uuid, img, hp: null, counters: null, lastActions: [] } : m) });
    line = `${foundry.utils.escapeHTML(by)} knocks the ${foundry.utils.escapeHTML(entry.name)} on ${SYSTEM_LABELS[entry.system] ?? entry.system} down to <strong>${name}</strong>.`;
  }
  await card(ship, `<p><strong>Fire Suppression:</strong> ${line}</p>`);
  await syncDisabled(ship);
  return { ok: true, line };
}

/* -------------------------------------------- */
/*  Crew                                        */
/* -------------------------------------------- */

/** The ship an action is being used for, set by the local HUD around activity.use(). */
export const shipContext = { uuid: null };

/** Use a Crew Role activity for a ship: the usage card is tagged with the ship. */
export async function useForShip(ship, activity) {
  shipContext.uuid = ship?.uuid ?? null;
  try { return await activity.use(); }
  finally { shipContext.uuid = null; }
}

/* -------------------------------------------- */
/*  Crew record                                 */
/* -------------------------------------------- */

/** The crew record saved from the bridge: { actorId: [roles] }. */
export const crewOf = actor => actor?.flags?.[MODULE_ID]?.crew ?? {};

/** The ship a character crews (from the crew records), preferring one on the given scene. */
export function shipForCrew(character) {
  if ( !character ) return null;
  return game.actors.find(a => a.type === "vehicle" && crewOf(a)[character.id]?.length) ?? null;
}

/** This user's characters on a ship's crew, with their roles. */
export function userCrew(ship, user = game.user) {
  const rec = crewOf(ship);
  const out = [];
  for ( const [id, roles] of Object.entries(rec) ) {
    const a = game.actors.get(id);
    if ( !a || !roles?.length ) continue;
    if ( user.isGM ? false : !a.testUserPermission(user, "OWNER") ) continue;
    out.push({ actor: a, roles });
  }
  return out;
}

/** Crew bonus for a role on an enemy ship: its own value, else the crew quality, else the ship's PB. */
/* Crew quality (John, 2026-10-25): a "Crew" item on the ship (Crew: Green +2, Regular +4, Veteran +6, Elite +8)
 * stands in for a crew member's ability modifier + PB on station checks. Precedence: a per-station override in
 * the ship's crewBonus flag, then the Crew item, then the older crewBonus.quality flag, then Green (+2). */
export const CREW_DEFAULT = 2;
export function crewItemQuality(ship) {
  const it = (ship?.items ?? []).find(i => (i.flags?.[MODULE_ID]?.crewQuality ?? null) !== null);
  return it ? Number(it.flags[MODULE_ID].crewQuality) : null;
}
const blank = v => (v === null) || (v === undefined) || (v === "");
/** True when the ship's crew quality replaces its characters' own stats (a Crew item or the quality flag). */
export function crewQualitySet(ship) {
  return (crewItemQuality(ship) !== null) || !blank(ship?.flags?.[MODULE_ID]?.crewBonus?.quality);
}
export function crewBonus(actor, role) {
  const b = actor?.flags?.[MODULE_ID]?.crewBonus ?? {};
  const item = crewItemQuality(actor);
  const quality = (item !== null) ? item : (!blank(b.quality) ? Number(b.quality) : CREW_DEFAULT);
  const roleKey = role === "pilot" || role === "copilot" ? "helmsman" : role;
  return blank(b[roleKey]) ? quality : Number(b[roleKey]);
}

/* Stations are tools (John, 2026-10-25): at a station you are proficient with it. Station check = d20 + the
 * station's ability + your PB + the station bonus (the ship's PB). A paired skill you are also proficient in
 * gives Advantage (2024 rule). A ship's own crew (no characters, or a Crew item set) uses crew quality in place
 * of ability + PB. */
export const STATION_ABILITY = { commander: "cha", helmsman: "dex", pilot: "dex", copilot: "dex", navigator: "wis",
  engineer: "int", gunner: "dex", deck: "con", medic: "wis", cook: "con" };
export const STATION_SKILLS = { commander: ["per", "itm", "ins"], helmsman: ["slt", "acr"], pilot: ["slt", "acr"],
  copilot: ["slt", "acr"], navigator: ["ste", "dec"], engineer: ["ins", "inv"], gunner: ["prc", "sur"],
  medic: ["med", "ins"], cook: ["sur", "per"] };
/** A character rolls with their own stats when a player owns them, or when the ship has no crew quality set. */
export const usesOwnStats = (actor, ship) => !!actor && (actor.type !== "vehicle") && (actor.hasPlayerOwner || !crewQualitySet(ship));
// The systems a station check uses (a gunner's weapon arc is added by the attack itself).
const CHECK_SYSTEMS = { commander: ["command"], helmsman: ["propulsion"], pilot: ["propulsion"], copilot: ["propulsion"],
  navigator: ["navigation"], engineer: ["power"], medic: ["habitat"], cook: ["habitat"], gunner: [] };
export function stationCheck(ship, crewActor, role) {
  const out = stationCheckBase(ship, crewActor, role);
  const why = CHECK_SYSTEMS[role] ? impairedReason(ship, CHECK_SYSTEMS[role], crewActor) : "";
  out.disadvantage = !!why;
  out.impaired = why;
  if ( why ) out.label += `; Disadvantage (${why})`;
  out.dice = d20(out.advantage, out.disadvantage);
  return out;
}
function stationCheckBase(ship, crewActor, role) {
  const spb = shipProf(ship);
  if ( usesOwnStats(crewActor, ship) ) {
    const ab = STATION_ABILITY[role] ?? "dex";
    const mod = Number(crewActor.system?.abilities?.[ab]?.mod) || 0;
    const prof = Number(crewActor.system?.attributes?.prof) || 0;
    const skills = (STATION_SKILLS[role] ?? []).filter(k => (Number(crewActor.system?.skills?.[k]?.value) || 0) >= 1);
    const advantage = skills.length > 0;
    const names = skills.map(k => CONFIG.DND5E.skills[k]?.label ?? k);
    return { bonus: mod + prof + spb, advantage,
      label: `${ab.toUpperCase()} ${mod >= 0 ? "+" : ""}${mod}, PB +${prof}, ship +${spb}${advantage ? `; Advantage (${names.join(", ")})` : ""}` };
  }
  const q = crewBonus(ship, role);
  return { bonus: q + spb, advantage: false, label: `crew +${q}, ship +${spb}` };
}

/** Set by ship-fire while it rolls a ship weapon: the character firing (null = the ship's own crew). */
export const fireContext = { gunner: undefined };

/* -------------------------------------------- */
/*  Scenes                                      */
/* -------------------------------------------- */

/** The world actor behind a (possibly synthetic) actor. */
export const baseActor = actor => actor?.isToken ? game.actors.get(actor.token?.actorId) : actor;

/** Whether a scene is a bridge (it has a ship display or a radar). */
export function isBridgeScene(scene) {
  if ( !scene ) return false;
  const flagged = f => scene.tiles.some(t => t.getFlag(MODULE_ID, f)) || scene.regions.some(r => r.getFlag(MODULE_ID, f));
  return flagged("viewscreen") || flagged("radar") || flagged("station");
}

/**
 * Whether a scene is tagged as a sector map (John, 2026-10-25): the "Sector Map" box in the scene's
 * configuration (flags["fvtt-neon-odyssey"].sectorMap). The ship HUD works only on these scenes.
 */
export const isTorpedo = doc => !!doc?.getFlag?.(MODULE_ID, "torpedo");
export const isSectorScene = scene => !!scene?.getFlag?.(MODULE_ID, "sectorMap");

/*
 * Ship token sizes on sector maps (John, 2026-10-26): Gargantuan 1.0, each size smaller 0.15 less (Huge 0.85,
 * Large 0.70, Medium 0.55, Small 0.40, Tiny 0.25). Foundry's hex grid can't measure moves for tokens smaller than
 * one hex, so the token keeps its 1×1 footprint and its art is scaled (texture scale). Applied to vehicle tokens
 * placed on a sector map and, by the GM when the world loads, to the ones already there.
 */
const SECTOR_SIZES = { tiny: 0.25, sm: 0.4, small: 0.4, med: 0.55, medium: 0.55, lg: 0.7, large: 0.7, huge: 0.85, grg: 1, gargantuan: 1 };
export function sectorTokenSize(actor) {
  const size = String(actor?.flags?.[MODULE_ID]?.sizeName ?? actor?.system?.traits?.size ?? "").toLowerCase();
  return SECTOR_SIZES[size] ?? 0.55;
}
const scaled = (doc, k) => ({ "texture.scaleX": Math.sign(doc.texture?.scaleX || 1) * k, "texture.scaleY": Math.sign(doc.texture?.scaleY || 1) * k });
Hooks.on("preCreateToken", doc => {
  if ( (doc.actor?.type !== "vehicle") || !isSectorScene(doc.parent) ) return;
  doc.updateSource({ width: 1, height: 1, ...scaled(doc, sectorTokenSize(doc.actor)) });
});
export async function resizeSectorTokens() {
  for ( const scene of game.scenes.filter(isSectorScene) ) {
    const upd = [];
    for ( const t of scene.tokens ) {
      if ( t.actor?.type !== "vehicle" ) continue;
      const k = sectorTokenSize(t.actor);
      if ( (Math.abs(t.texture.scaleX) === k) && (Math.abs(t.texture.scaleY) === k) ) continue;
      upd.push({ _id: t.id, ...scaled(t, k) });
    }
    if ( upd.length ) await scene.updateEmbeddedDocuments("Token", upd, { animate: false });
  }
}
Hooks.once("ready", () => { if ( game.users.activeGM?.isSelf ) resizeSectorTokens().catch(err => console.error(`${MODULE_ID} | resize tokens`, err)); });

/**
 * The ship's sector map (John, 2026-10-25): the scene the GM picked with the bridge's scene picker
 * (flags.sectorSceneId), else the first Sector Map scene holding a linked token of the ship
 * (the active scene first).
 */
export function sectorScene(actor) {
  const base = baseActor(actor);
  const picked = game.scenes.get(base?.getFlag(MODULE_ID, "sectorSceneId"));
  if ( picked ) return picked;
  return sectorToken(actor)?.parent ?? null;
}

/** The ship's token on its sector map: on the picked scene if there is one, else the first linked one found. */
export function sectorToken(actor) {
  const base = baseActor(actor);
  if ( actor?.isToken && isSectorScene(actor.token.parent) ) return actor.token;
  if ( !base ) return null;
  const picked = game.scenes.get(base.getFlag(MODULE_ID, "sectorSceneId"));
  if ( picked ) return picked.tokens.find(t => t.actorLink && t.actorId === base.id) ?? null;
  // The active scene first, then the rest.
  const scenes = [...game.scenes].filter(isSectorScene).sort((a, b) => (b.active - a.active));
  for ( const scene of scenes ) {
    const t = scene.tokens.find(t => t.actorLink && t.actorId === base.id);
    if ( t ) return t;
  }
  return null;
}

/** GM: choose the ship's sector map from the scenes tagged Sector Map. */
export async function pickSectorScene(actor) {
  const base = baseActor(actor);
  if ( !game.user.isGM || !base ) return null;
  const current = base.getFlag(MODULE_ID, "sectorSceneId") ?? "";
  const scenes = [...game.scenes].filter(isSectorScene).sort((a, b) => a.name.localeCompare(b.name));
  if ( !scenes.length ) {
    ui.notifications.warn("No scene is tagged Sector Map. Tick \"Sector Map\" in a scene's configuration (Basics tab) first.");
    return null;
  }
  const opts = scenes.map(s => {
    const has = s.tokens.some(t => t.actorLink && t.actorId === base.id);
    return `<option value="${s.id}" ${s.id === current ? "selected" : ""}>${foundry.utils.escapeHTML(s.name)}${has ? "" : " (ship not placed)"}</option>`;
  }).join("");
  const choice = await foundry.applications.api.DialogV2.prompt({
    window: { title: `Sector Map: ${base.name}` },
    content: `<p>The scene this ship flies on. The bridge's radar buttons, Go to Sector Map and the HUD use it.</p>
      <div class="form-group"><label>Sector Map</label><select name="scene">
        <option value="" ${current ? "" : "selected"}>Automatic (first scene with the ship on it)</option>${opts}</select></div>`,
    ok: { label: "Save", callback: (event, button) => button.form.elements.scene.value },
    rejectClose: false
  });
  if ( choice === null || choice === undefined ) return null;
  if ( choice ) await base.setFlag(MODULE_ID, "sectorSceneId", choice);
  else await base.unsetFlag(MODULE_ID, "sectorSceneId");
  const scene = game.scenes.get(choice);
  if ( scene && !scene.tokens.some(t => t.actorLink && t.actorId === base.id) ) {
    ui.notifications.warn(`${base.name} has no linked token on ${scene.name} yet. Place it there with Link Actor Data on.`);
  }
  return choice;
}

/** The ship's bridge scene: where it was put on a display. */
export function bridgeScene(actor) {
  const base = baseActor(actor);
  const id = base?.getFlag(MODULE_ID, "bridgeSceneId");
  const scene = id ? game.scenes.get(id) : null;
  if ( scene ) return scene;
  return game.scenes.find(s => s.tokens.some(t => t.actorId === base?.id && t.getFlag(MODULE_ID, "viewSize"))) ?? null;
}

/** Show a scene to this user only. */
export async function viewScene(scene) {
  if ( !scene ) return ui.notifications.warn("No scene found for this ship.");
  try { return await scene.view(); }
  catch(err) { ui.notifications.warn(`You can't open ${scene.name}: ${err.message}`); }
}

/* -------------------------------------------- */
/*  Changes (GM)                                */
/* -------------------------------------------- */

let queue = Promise.resolve();
const enqueue = fn => (queue = queue.then(fn).catch(err => {
  console.error(`${MODULE_ID} | ship state`, err);
  return { ok: false, error: err.message };
}));

const isActiveGM = () => game.users.activeGM?.isSelf ?? false;

/** Post a short result card. */
async function card(actor, html, whisperGM = false) {
  return ChatMessage.implementation.create({
    content: `<div class="no-crew-card">${html}</div>`,
    speaker: { alias: actor?.name ?? "Ship" },
    flags: { [MODULE_ID]: { crewResult: true } },
    ...(whisperGM ? { whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id) } : {})
  });
}

/**
 * Strain rose from `before` to `after`: roll and record a Mishap for each Mishap Threshold passed,
 * and announce Disabled at max HP. Returns the HTML for the chat card ("" if nothing happened).
 */
export async function strainAlerts(ship, before, after) {
  if ( !ship || after <= before ) return "";
  const hp = ship.system.attributes?.hp;
  let alert = "";
  // Strain over the Mishap Threshold gives a Minor Mishap, whatever added it (John, 2026-10-25).
  // (Hits roll their own Mishap in applyHit, at the weapon's tier.)
  alert += await strainMishap(ship, before, after);
  if ( hp?.max && after > hp.max && before <= hp.max ) {
    alert += `<p class="no-crew-alert"><strong>SHIP DISABLED.</strong> Strain is over the ship's maximum Hit Points (${hp.max}).
      No station can act until Mishaps are Corrected.</p>`;
  }
  return alert;
}

/** Raise or lower Tempo, Strain or Speed by hand (the HUD arrows). */
async function adjust(actor, stat, delta) {
  const st = getState(actor);
  const before = st[stat];
  const after = Math.max(0, before + delta);
  if ( after === before ) return { ok: true };
  await setState(actor, { [stat]: after });
  if ( stat === "strain" && after > before ) {
    const alert = await strainAlerts(actor, before, after);
    if ( alert ) await card(actor, `<h3>Strain ${before} → ${after}</h3>${alert}`);
  }
  return { ok: true };
}

/** Center of a token from its stored values. */
function centerOf(tokenDoc) {
  const s = tokenDoc._source, g = tokenDoc.parent.grid;
  return { x: s.x + (s.width * g.sizeX) / 2, y: s.y + (s.height * g.sizeY) / 2 };
}

/**
 * Move a ship: forward one hex along its facing, or turn one facing (60°), spending its Speed.
 * Refused when Propulsion is Offline or the Speed isn't there. With no sector-map token (a ship only
 * on a bridge) the Speed is still spent and the bridge radar follows (see crew-stations.mjs).
 */
async function steer(actor, tokenDoc, move) {
  if ( !actor ) return { ok: false, error: "No ship." };
  const name = tokenDoc?.name ?? actor.name;
  if ( roleOffline(actor, "helmsman") ) return { ok: false, error: `${name}: Propulsion is Offline.` };
  if ( mustManeuver(actor) ) return { ok: false, error: `${name}: the Helmsman must use Maneuver before the ship can move this turn.` };
  const st = getState(actor);
  const forward = move === "forward";
  const cost = forward ? nextForwardCost(st.bands) : nextFacingCost(st.facings);
  if ( st.speed < cost ) {
    return { ok: false, error: `${name}: ${forward ? `hex ${st.bands + 1}` : `facing change ${st.facings + 1}`} this round costs ${cost} Speed; ${st.speed} left.` };
  }
  if ( tokenDoc ) {
    const scene = tokenDoc.parent;
    const rot = tokenDoc._source.rotation ?? 0;
    if ( forward ) {
      const grid = scene.grid;
      const c = centerOf(tokenDoc);
      const step = Math.min(grid.sizeX, grid.sizeY);
      const a = Math.toRadians(rot);
      const target = { x: c.x + Math.sin(a) * step, y: c.y - Math.cos(a) * step };
      const center = grid.getCenterPoint(grid.getOffset(target));
      const s = tokenDoc._source;
      const x = Math.round(center.x - (s.width * grid.sizeX) / 2);
      const y = Math.round(center.y - (s.height * grid.sizeY) / 2);
      if ( (x === s.x) && (y === s.y) ) return { ok: false, error: "Couldn't find the next hex." };
      const d = scene.dimensions;
      if ( (center.x < d.sceneX) || (center.y < d.sceneY) || (center.x > d.sceneX + d.sceneWidth) || (center.y > d.sceneY + d.sceneHeight) ) {
        return { ok: false, error: `${name} is at the edge of the map.` };
      }
      await tokenDoc.update({ x, y }, { neonOdysseyHelm: true });
    } else {
      const deg = move === "left" ? -FACING_DEGREES : FACING_DEGREES;
      const snapped = Math.round(rot / FACING_DEGREES) * FACING_DEGREES;
      await tokenDoc.update({ rotation: ((snapped + deg) % 360 + 360) % 360 }, { neonOdysseyHelm: true });
    }
  }
  await setState(actor, { speed: st.speed - cost, bands: st.bands + (forward ? 1 : 0), facings: st.facings + (forward ? 0 : 1) });
  Hooks.callAll(`${MODULE_ID}.shipSteered`, actor, move);
  return { ok: true, cost };
}

/** Can this user change this ship? Its owners, the GM, and its crew. */
function mayControl(actor, user) {
  if ( user.isGM ) return true;
  const base = baseActor(actor);
  if ( actor?.testUserPermission(user, "OWNER") || base?.testUserPermission(user, "OWNER") ) return true;
  return userCrew(base ?? actor, user).length > 0;
}

/** Run one request on the active GM. */

/* -------------------------------------------- */
/*  Damage reactions (John, 2026-10-25)          */
/* -------------------------------------------- */
// When a ship is hit, the GM asks whoever runs it (an active player who owns it, else the GM) whether to
// use a damage Reaction, if its crew still has the Reaction and the ship has the Tempo:
// - Divert Power to Shields (Engineer, 2 Tempo + 2 Strain): asked after the attack hits, before damage is
//   rolled. +5 AC until the start of the ship's next turn, including against that attack. Needs Shields that
//   aren't Offline.
// - Roll with the Punch (Helmsman, 2 Tempo): asked after damage is rolled. Piloting check (Sleight of Hand;
//   enemy ships use their Helmsman crew bonus) against DC 8 + the damage; on a success the ship takes half
//   the damage, rounded up.
const REACT_QUERY = `${MODULE_ID}.damageReaction`;
export const DAMAGE_REACTIONS = {
  shields: { role: "engineer", name: "Divert Power to Shields", tempo: 2, strain: 2 },
  punch: { role: "helmsman", name: "Roll with the Punch", tempo: 2, strain: 0 },
  // Countermeasures (John, 2026-10-26): when a missile or torpedo targets the ship.
  counter: { role: "navigator", name: "Countermeasures", tempo: 1, strain: 0 }
};
export const SHIELD_AC = 5;
export const shieldsUp = ship => !!ship?.getFlag(MODULE_ID, "shieldsUp");

/** The crew holding a role: characters assigned to it, else the ship's own crew if it has that station. */
function crewForRole(ship, role) {
  const base = baseActor(ship) ?? ship;
  const chars = Object.entries(crewOf(base)).filter(([, r]) => r?.includes(role)).map(([id]) => game.actors.get(id)).filter(Boolean);
  if ( chars.length ) return chars;
  return roleAvailable(ship, role) ? [null] : [];
}

/** { actor, key } of a crew member who can take this damage Reaction now, else null. */
function reactionReady(ship, kind) {
  const r = DAMAGE_REACTIONS[kind];
  if ( !r || !inCombat(ship) ) return null;
  if ( kind === "shields" ) {
    if ( !shipSystems(ship).has("shields") || systemOffline(ship, "shields") || shieldsUp(ship) ) return null;
  }
  if ( getState(ship).tempo < r.tempo ) return null;
  for ( const actor of crewForRole(ship, r.role) ) {
    const gate = canUse(ship, actor, r.role, { name: r.name, activation: { type: "reaction" } });
    if ( gate.ok ) return { actor, key: crewKey(ship, actor, r.role) };
  }
  return null;
}

/** Who answers for a ship: an active player who owns it, else the active GM. */
export function responderFor(ship) {
  const base = baseActor(ship) ?? ship;
  return game.users.find(u => u.active && !u.isGM && base.testUserPermission(u, "OWNER")) ?? game.users.activeGM;
}

/** Runs on the responder's client: ask, and for Roll with the Punch roll the check there. */
async function reactionPrompt(p) {
  const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
  if ( p.kind === "shoot" ) {
    const use = await foundry.applications.api.DialogV2.confirm({
      window: { title: `Shoot it Down? (${esc(p.crewName)})` },
      content: `<p>An enemy <strong>${esc(p.torpedo)}</strong> is ${p.hexes} hex${p.hexes === 1 ? "" : "es"} from <strong>${esc(p.ship)}</strong>, heading for ${esc(p.targetName)}.</p>
        <p>Shoot it Down with ${esc(p.weapon)} (Reaction, no Tempo): +${p.bonus} vs AC 16; a hit for 5 or more destroys it.</p>`,
      yes: { label: "Shoot it Down" }, no: { label: "Hold" }, rejectClose: false
    });
    return { use: !!use };
  }
  if ( p.kind === "counter" ) {
    const use = await foundry.applications.api.DialogV2.confirm({
      window: { title: `Countermeasures? (${esc(p.crewName)})` },
      content: `<p><strong>${esc(p.attacker)}</strong> ${p.torpedo ? "has a torpedo closing on" : `fires ${esc(p.weapon)} at`} <strong>${esc(p.ship)}</strong>.</p>
        <p>Countermeasures (Reaction, 1 Tempo): ${p.torpedo ? "Advantage on the ship's DEX save against the torpedo." : "the missile attack has Disadvantage."}</p>`,
      yes: { label: "Countermeasures" }, no: { label: "Hold" }, rejectClose: false
    });
    return { use: !!use };
  }
  const r = DAMAGE_REACTIONS[p.kind];
  const body = p.kind === "shields"
    ? `<p><strong>${esc(p.attacker)}</strong> hits <strong>${esc(p.ship)}</strong> with ${esc(p.weapon)} (${p.total} vs AC ${p.ac}).</p>
       <p>Divert Power to Shields? ${r.tempo} Tempo + ${r.strain} Strain: +${SHIELD_AC} AC until the start of your next turn, including against this attack (AC ${p.ac + SHIELD_AC}).</p>`
    : `<p><strong>${esc(p.attacker)}</strong>'s ${esc(p.weapon)} hits <strong>${esc(p.ship)}</strong> for <strong>${p.damage}</strong> damage.</p>
       <p>Roll with the Punch? ${r.tempo} Tempo: Piloting check (${esc(p.skillLabel)}) vs DC ${p.dc}; on a success the ship takes ${Math.ceil(p.damage / 2)} instead.</p>
       ${p.die ? `<div class="form-group"><label>Add Command die (${p.die})</label><input type="checkbox" name="die"></div>` : ""}`;
  let usedDie = false;
  const use = await foundry.applications.api.DialogV2.confirm({
    window: { title: `${r.name}? (${esc(p.crewName)})` }, content: body,
    yes: { label: r.name, callback: (event, button) => { usedDie = !!button.form?.elements?.die?.checked; return true; } },
    no: { label: "Take the hit" }, rejectClose: false
  });
  if ( !use ) return { use: false };
  if ( p.kind !== "punch" ) return { use: true };
  const roll = await new Roll(`${p.formula}${usedDie && p.die ? ` + 1${p.die}` : ""}`).evaluate();
  await roll.toMessage({ flavor: `Roll with the Punch: Piloting check (${p.skillLabel}) vs DC ${p.dc}`,
    speaker: p.actorId ? ChatMessage.implementation.getSpeaker({ actor: game.actors.get(p.actorId) }) : { alias: `${p.ship} (Helm)` } });
  return { use: true, total: roll.total, usedDie };
}

/** Autopilot (hands-free test runs): a ship flagged autoRun decides its damage reactions itself. */
async function autoReaction(ship, p) {
  const st = getState(ship);
  if ( p.kind === "shoot" ) return { use: true };
  if ( p.kind === "shields" ) return { use: st.tempo >= 4 };
  if ( p.kind === "counter" ) return { use: st.tempo >= 3 };   // keep 2 for Roll with the Punch
  // Roll with the Punch when the hit is worth halving and the ship can pay for it (2 Tempo).
  if ( (p.damage < 4) || (st.tempo < 2) ) return { use: false };
  const roll = await new Roll(p.formula).evaluate();
  await roll.toMessage({ flavor: `Roll with the Punch (autopilot): Piloting check (${p.skillLabel}) vs DC ${p.dc}`,
    speaker: p.actorId ? ChatMessage.implementation.getSpeaker({ actor: game.actors.get(p.actorId) }) : { alias: `${p.ship} (Helm)` } });
  return { use: true, total: roll.total, usedDie: false };
}

export async function askReaction(ship, payload) {
  if ( ship.getFlag?.(MODULE_ID, "autoRun") ) return autoReaction(ship, payload);
  const user = responderFor(ship);
  if ( !user ) return { use: false };
  try {
    return user.isSelf ? await reactionPrompt(payload) : await user.query(REACT_QUERY, payload, { timeout: 180000 });
  } catch(err) {
    console.warn(`${MODULE_ID} | damage reaction`, err);
    return { use: false };
  }
}

/** Spend the Reaction: Tempo, Strain (a Mishap if over the threshold), and the crew member's Reaction. */
async function payReaction(ship, kind, ready) {
  const r = DAMAGE_REACTIONS[kind];
  const st = getState(ship);
  const after = st.strain + r.strain;
  await setState(ship, { tempo: st.tempo - r.tempo, strain: after });
  await markSlot(ship, ready.key, "reaction", true, r.name);
  const mish = r.strain ? await strainMishap(ship, st.strain, after) : "";
  return `${r.name} (${r.tempo} Tempo${r.strain ? ` + ${r.strain} Strain` : ""}): Tempo ${st.tempo} → ${st.tempo - r.tempo}${r.strain ? `, Strain ${st.strain} → ${after}` : ""}.${mish}`;
}

/** GM: before damage is rolled. Returns { acBonus }. */
async function preDamage(ship, data) {
  const ready = reactionReady(ship, "shields");
  if ( !ready ) return { ok: true, acBonus: 0 };
  const ans = await askReaction(ship, { kind: "shields", ship: data.targetName ?? ship.name, attacker: data.attacker, weapon: data.weapon,
    total: data.total, ac: data.ac, crewName: ready.actor?.name ?? "Engineer" });
  if ( !ans?.use ) return { ok: true, acBonus: 0 };
  const line = await payReaction(ship, "shields", ready);
  await ship.setFlag(MODULE_ID, "shieldsUp", true);
  await card(ship, `<p><strong>${foundry.utils.escapeHTML(data.targetName ?? ship.name)}:</strong> ${line} AC +${SHIELD_AC} until the start of its next turn.</p>`);
  return { ok: true, acBonus: SHIELD_AC };
}

/**
 * Countermeasures (Navigator, Reaction, 1 Tempo; John, 2026-10-26): when a missile attack or a torpedo targets
 * the ship, the missile attack has Disadvantage, or the ship has Advantage on its save against the torpedo.
 * GM. Returns { ok, use }.
 */
export async function countermeasures(ship, data) {
  const ready = reactionReady(ship, "counter");
  if ( !ready ) return { ok: true, use: false };
  const name = data.targetName ?? ship.name;
  const ans = await askReaction(ship, { kind: "counter", ship: name, attacker: data.attacker, weapon: data.weapon,
    torpedo: !!data.torpedo, crewName: ready.actor?.name ?? "Navigator" });
  if ( !ans?.use ) return { ok: true, use: false };
  const line = await payReaction(ship, "counter", ready);
  await card(ship, `<p><strong>${foundry.utils.escapeHTML(name)}:</strong> ${line} ${data.torpedo ? "Advantage on the dodge." : "The missile attack has Disadvantage."}</p>`);
  return { ok: true, use: true };
}

/** GM: after damage is rolled. Returns the damage to apply. */
export async function rollWithThePunch(ship, data) {
  const damage = Number(data.damage) || 0;
  const ready = damage > 0 ? reactionReady(ship, "punch") : null;
  if ( !ready ) return damage;
  const dc = 8 + damage;
  const chk = stationCheck(ship, ready.actor, "helmsman");
  const formula = `${chk.dice} + ${chk.bonus}`;
  const die = heldDie(ship, ready.key);
  const ans = await askReaction(ship, { kind: "punch", ship: data.targetName ?? ship.name, attacker: data.attacker, weapon: data.weapon,
    damage, dc, formula, die, skillLabel: `Helm station: ${chk.label}`, actorId: ready.actor?.id ?? null,
    crewName: ready.actor?.name ?? "Helm" });
  if ( !ans?.use ) return damage;
  const line = await payReaction(ship, "punch", ready);
  if ( ans.usedDie ) await spendDieLocal(ship, ready.key);
  const ok = Number(ans.total) >= dc;
  const taken = ok ? Math.ceil(damage / 2) : damage;
  await card(ship, `<p><strong>${foundry.utils.escapeHTML(data.targetName ?? ship.name)}:</strong> ${line} Piloting ${ans.total} vs DC ${dc}: ${ok ? `success, takes ${taken} of ${damage} damage` : "failure, takes the full damage"}.</p>`);
  return taken;
}

Hooks.once("init", () => { CONFIG.queries[REACT_QUERY] = data => reactionPrompt(data); });


/* -------------------------------------------- */
/*  Crew effects and Electronic Warfare          */
/* -------------------------------------------- */
/** GM: apply a successful Electronic Warfare to its target. */
async function ewEffect(target, data) {
  const name = foundry.utils.escapeHTML(data.targetName ?? target.name);
  const amount = Math.max(0, Number(data.amount) || 0);
  const st = getState(target);
  let line;
  if ( data.effect === "strain" ) {
    const after = st.strain + amount;
    await setState(target, { strain: after });
    const mish = await strainMishap(target, st.strain, after);
    await syncDisabled(target);
    line = `${name} gains ${amount} Strain: ${st.strain} → ${after}.${mish}`;
  } else if ( data.effect === "tempo" ) {
    const after = Math.max(0, st.tempo - amount);
    await setState(target, { tempo: after });
    line = `${name} loses ${st.tempo - after} Tempo: ${st.tempo} → ${after}.`;
  } else {
    line = `${name}'s ${foundry.utils.escapeHTML(data.station || "chosen")} station has disadvantage until the end of its next turn.`;
  }
  await card(target, `<p><strong>Electronic Warfare</strong> from ${foundry.utils.escapeHTML(data.attacker ?? "")}: ${line}</p>`);
  return { ok: true, line };
}


/* -------------------------------------------- */
/*  Rally: Command dice (John, 2026-10-25)       */
/* -------------------------------------------- */
// Rally gives one crew member a Command die, sized by the Commander's PB (1 d2, 2 d4, 3 d6, 4 d8, 5 d10,
// 6 d12). It is banked until used, a crew member can hold only one, and it is added to any roll Bardic
// Inspiration could be (attack rolls, ability checks, saving throws), declared before the result is known.
// Stored on the ship: flags.fvtt-neon-odyssey.commandDice = { <crew key>: { die, name, from } }.
export const commandDice = ship => ship?.getFlag?.(MODULE_ID, "commandDice") ?? {};
export const dieForPB = pb => `d${Math.min(12, Math.max(2, 2 * Math.round(Number(pb) || 2)))}`;
export const heldDie = (ship, key) => commandDice(ship)[key]?.die ?? null;
/** GM: remove a banked die and return it ("d4"), or null. */
export async function spendDieLocal(ship, key) {
  const d = commandDice(ship)[key];
  if ( !d ) return null;
  await ship.update({ [`flags.${MODULE_ID}.commandDice.-=${key}`]: null });
  return d.die;
}

async function handle(data, user) {
  const doc = data.uuid ? await fromUuid(data.uuid) : null;
  const actor = doc?.documentName === "Token" ? doc.actor : doc;
  if ( !actor ) return { ok: false, error: "That ship no longer exists." };
  // A hit lands on someone else's ship: the requester must crew the ship that fired.
  const ctl = ["hit", "preDamage", "ewEffect", "countermeasures"].includes(data.action) ? (data.attackerUuid ? await fromUuid(data.attackerUuid) : null) : actor;
  const ctlActor = ctl?.documentName === "Token" ? ctl.actor : ctl;
  if ( !ctlActor || !mayControl(ctlActor, user) ) return { ok: false, error: "You don't crew that ship." };
  return enqueue(async () => {
    switch ( data.action ) {
      case "adjust": return adjust(actor, data.stat, Number(data.delta) || 0);
      case "refill": await refillSpeed(actor); return { ok: true };
      case "steer": return steer(actor, doc.documentName === "Token" ? doc : sectorToken(actor), data.move);
      case "hit": {
        // A weapon hit on this ship (rule 16). doc is the target token (unlinked ships keep state on it).
        const tokenDoc = doc.documentName === "Token" ? doc : null;
        const damage = await rollWithThePunch(actor, { ...data, targetName: tokenDoc?.name });
        const lines = await applyHit(actor, { damage, size: data.size, crit: !!data.crit,
          weapon: data.weapon, attacker: data.attacker, tokenDoc });
        return { ok: true, lines };
      }
      case "grantDie": {
        const key = String(data.key);
        const have = commandDice(actor)[key];
        if ( have ) return { ok: false, error: `${data.name ?? "That crew member"} already holds a Command die (${have.die}).` };
        await actor.update({ [`flags.${MODULE_ID}.commandDice.${key}`]: { die: data.die, name: data.name ?? "", from: data.from ?? "" } });
        await card(actor, `<p><strong>Rally:</strong> ${foundry.utils.escapeHTML(data.from ?? "The Commander")} gives ${foundry.utils.escapeHTML(data.name ?? "a crew member")} a <strong>Command die (${data.die})</strong>.</p>`);
        return { ok: true };
      }
      case "spendDie": {
        const die = await spendDieLocal(actor, String(data.key));
        return die ? { ok: true, die } : { ok: false, error: "No Command die to use." };
      }
      case "stim": {
        // Stim Shot (John, 2026-10-26): the crew member ignores Impaired Disadvantage for 1 minute.
        const base = baseActor(actor) ?? actor, who = game.actors.get(String(data.actorId));
        if ( !who ) return { ok: false, error: "No such crew member." };
        await base.update({ [`flags.${MODULE_ID}.stim.${who.id}`]: game.time.worldTime + 60 });
        await card(actor, `<p><strong>Stim Shot:</strong> ${foundry.utils.escapeHTML(data.from ?? "The Medic")} gives ${foundry.utils.escapeHTML(who.name)} a Stim Shot: no Impaired Disadvantage for 1 minute (10 rounds).</p>`);
        return { ok: true };
      }
      case "launchTorpedo": return (await import("./torpedoes.mjs")).launchGM(doc, data);
      case "correctMishap": return (await import("./ship-fire.mjs")).correctMishapGM(actor, data);
      case "suppressFire": return suppressFire(actor, { id: data.id ?? null, by: data.by ?? "Deck crew" });
      case "ewEffect": return ewEffect(actor, { ...data, targetName: doc.documentName === "Token" ? doc.name : actor.name });
      case "preDamage": return preDamage(actor, { ...data, targetName: doc.documentName === "Token" ? doc.name : actor.name });
      case "countermeasures": return countermeasures(actor, { ...data, targetName: doc.documentName === "Token" ? doc.name : actor.name });
      case "crewCheck": {
        // The crew's Crew Role items went missing (e.g. a character was rebuilt): re-check the bridge stations.
        const bridge = bridgeScene(actor);
        const crew = game.modules.get(MODULE_ID).crew;
        if ( bridge && crew?.reconcileScene ) await crew.reconcileScene(bridge);
        return { ok: true };
      }
      case "useSlot": await markSlot(actor, String(data.key), data.slot, true, data.name ? String(data.name) : null); return { ok: true };
      case "freeAction": await markSlot(actor, String(data.key), "action", false); return { ok: true };
      case "mishapRemove":
        if ( !user.isGM ) return { ok: false, error: "Only the GM removes Mishaps." };
        await removeMishap(actor, data.id); return { ok: true };
      default: return { ok: false, error: `Unknown request ${data.action}` };
    }
  });
}

/**
 * Ask the active GM to make a change. On the active GM's own client it runs directly.
 * @param {object} data   { action, uuid, ... }
 */
export async function request(data, { timeout = 15000 } = {}) {
  const gm = game.users.activeGM;
  if ( !gm ) { ui.notifications.warn("A GM must be logged in to run the ship."); return { ok: false }; }
  let result;
  try {
    result = gm.isSelf ? await handle(data, game.user) : await gm.query(QUERY, { ...data, userId: game.user.id }, { timeout });
  } catch(err) {
    console.error(`${MODULE_ID} | ship request`, err);
    result = { ok: false, error: err.message };
  }
  if ( result && !result.ok && result.error ) ui.notifications.warn(result.error);
  return result ?? { ok: false };
}

Hooks.once("init", () => {
  // v13 hands the handler only the query data, so the requesting user's id travels in it.
  CONFIG.queries[QUERY] = async data => {
    const requester = game.users.get(data?.userId);
    if ( !requester ) return { ok: false, error: "Unknown user." };
    if ( !isActiveGM() ) return { ok: false, error: "Not the active GM." };
    return handle(data, requester);
  };
});

// The "Sector Map" box on the scene configuration's Basics tab.
Hooks.on("renderSceneConfig", (app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const scene = app.document;
  if ( !root || !scene || root.querySelector(`[name="flags.${MODULE_ID}.sectorMap"]`) ) return;
  const tab = root.querySelector('.tab[data-tab="basics"]') ?? root.querySelector("form");
  if ( !tab ) return;
  const group = document.createElement("div");
  group.className = "form-group";
  group.innerHTML = `<label>Sector Map</label>
    <div class="form-fields"><input type="checkbox" name="flags.${MODULE_ID}.sectorMap" ${isSectorScene(scene) ? "checked" : ""}></div>
    <p class="hint">Starship scene: selecting a ship here opens its ship HUD (Neon Odyssey).</p>`;
  tab.append(group);
  app.setPosition?.({ height: "auto" });
});

Hooks.once("ready", () => {
  // Scenes that already had a sector-map tile are tagged as sector maps.
  if ( game.users.activeGM?.isSelf ) {
    for ( const scene of game.scenes ) {
      if ( !scene.flags?.[MODULE_ID]?.hasOwnProperty?.("sectorMap") && scene.tiles.some(t => t.getFlag(MODULE_ID, "sectorMap")) ) {
        scene.setFlag(MODULE_ID, "sectorMap", true);
      }
    }
  }
  const mod = game.modules.get(MODULE_ID);
  mod.ship = { isSectorScene, sectorScene, pickSectorScene, baseTempo, getState, setState, refillSpeed, endHelmTurn, inCombat, mustManeuver, applyHit, strainMishap, rollMishapOnto, disabledReason, canUse, slotOf, crewKey, isShipsTurn, econOf, shipSpeed, shipSystems, systemOfItem, activeMishaps, addMishap,
    removeMishap, systemOffline, roleOffline, roleAvailable, crewOf, userCrew, crewBonus, sectorToken,
    bridgeScene, request, nextFacingCost, nextForwardCost, MISHAP_TIERS };
});

/* -------------------------------------------- */
/*  Encounter start: base Tempo                 */
/* -------------------------------------------- */
// John, 2026-10-25: when the GM starts an encounter (Foundry's Begin Combat), every ship in it resets to
// its base Tempo, and its Speed and this round's moves reset too. Strain carries over.
//   Base Tempo = crew on stations + the ship's Proficiency Bonus (the bridge Reset rule).
//   - A crewed ship counts the characters in its crew record (who stands on its bridge stations).
//   - A ship nobody crews (enemies, NPC ships) counts its crewed stations: every station role on its
//     design except Deck Crew, Cook and Medic.

const NOT_STATIONS = new Set(["deck", "cook", "medic"]);

/** The ship's Proficiency Bonus (from its Level). */
export const shipProf = actor => Number(actor?.flags?.[MODULE_ID]?.prof) || (Math.ceil(Math.max(1, Number(actor?.flags?.[MODULE_ID]?.level) || 1) / 4) + 1);

/** Base Tempo and how it was worked out: { tempo, crew, pb, from }. */
export function baseTempo(actor) {
  const base = baseActor(actor) ?? actor;
  const crewIds = Object.entries(crewOf(base)).filter(([, roles]) => roles?.length).map(([id]) => id);
  let crew = crewIds.filter(id => game.actors.get(id)?.type === "character").length;
  let from = "crew on stations";
  if ( !crewIds.length ) {
    const stations = actor?.flags?.[MODULE_ID]?.stations ?? base?.flags?.[MODULE_ID]?.stations ?? [];
    crew = stations.reduce((n, s) => n + (s.roles ?? []).filter(r => !NOT_STATIONS.has(r)).length, 0);
    from = "stations";
  }
  const pb = shipProf(base);
  return { tempo: crew + pb, crew, pb, from };
}

Hooks.on("combatStart", async combat => {
  if ( !game.user.isGM ) return;
  const seen = new Set();
  const lines = [];
  for ( const c of combat.combatants ) {
    const actor = c.token?.actor ?? c.actor;
    if ( actor?.type !== "vehicle" ) continue;
    const key = c.token?.actorLink ? baseActor(actor)?.uuid : actor.uuid;
    if ( seen.has(key) ) continue;
    seen.add(key);
    const b = baseTempo(actor);
    // The Cook's Hot Meal before the encounter (John, 2026-10-26): +2 Tempo, +4 on a 20+.
    const meal = Number(actor.getFlag(MODULE_ID, "hotMeal")) || 0;
    if ( meal ) { b.tempo += meal; await actor.unsetFlag(MODULE_ID, "hotMeal"); }
    // Speed is 0 until the Helmsman's Maneuver (John, 2026-10-25).
    await setState(actor, { tempo: b.tempo, speed: 0, bands: 0, facings: 0, helm: 0 });
    lines.push(`<p><strong>${foundry.utils.escapeHTML(c.token?.name ?? actor.name)}</strong>: Tempo <strong>${b.tempo}</strong> (${b.crew} ${b.from} + ${b.pb} ship${meal ? ` + ${meal} Hot Meal` : ""}).</p>`);
  }
  if ( lines.length ) {
    await ChatMessage.implementation.create({
      content: `<div class="no-crew-card"><h3>Encounter start: base Tempo</h3>${lines.join("")}<p><em>Strain carries over. A surprised ship can be set to Tempo 0 with its HUD arrows or the bridge Reset. Ships move only after the Helmsman's Maneuver; half the Speed left at the end of a ship's turn (rounded up) goes back to Tempo.</em></p></div>`,
      speaker: { alias: "Encounter" }, flags: { [MODULE_ID]: { crewResult: true } }
    });
  }
});

/* -------------------------------------------- */
/*  End of a ship's turn: unused Speed → Tempo  */
/* -------------------------------------------- */
// John, 2026-10-25: the Helmsman must use Maneuver for Speed to reset and the move buttons to work. If Speed
// is left over at the end of the ship's turn, half of it (rounded up) goes back to Tempo. Speed then drops
// to 0 until the next Maneuver. Runs on the active GM when the encounter moves forward to the next turn.

Hooks.on("updateCombat", (combat, changes, options) => {
  if ( !isActiveGM() || !combat.started ) return;
  if ( !("turn" in changes) && !("round" in changes) ) return;
  if ( options?.direction === -1 ) return;          // stepping back through the tracker
  const prev = combat.previous;
  if ( !prev?.combatantId || !(prev.round >= 1) ) return;
  const c = combat.combatants.get(prev.combatantId);
  const actor = c?.token?.actor ?? c?.actor;
  if ( (actor?.type !== "vehicle") || isTorpedo(c.token) ) return;   // torpedoes bank no Tempo
  enqueue(async () => {
    const line = await endHelmTurn(actor, c.token?.name ?? actor.name);
    if ( line ) await ChatMessage.implementation.create({
      content: `<div class="no-crew-card"><p>${line}</p></div>`,
      speaker: { alias: "Helm" }, flags: { [MODULE_ID]: { crewResult: true } }
    });
  });
  // Its Mishaps act at the end of the ship's turn, after the crew (John, 2026-10-26). Outside the serial
  // queue: they deal damage and add Mishaps through the same functions the queue runs.
  if ( activeMishaps(actor).length ) {
    import("./mishap-turns.mjs").then(m => m.mishapTurns(actor)).catch(err => console.error(`${MODULE_ID} | Mishap turns`, err));
  }
});

/* -------------------------------------------- */
/*  Action economy (John, 2026-10-25)           */
/* -------------------------------------------- */
// Each station (crew member) gets an Action, a Bonus Action and a Reaction each round, as in D&D. Once one
// has used its Action, its other Actions are greyed out on the HUD; its Bonus Action and Reaction stay open.
// All three come back at the start of the ship's own turn. Outside its turn a ship can only react: its
// reactions, and Fire as return fire (the Gunner's Reaction). Maneuver is the Helmsman's Bonus Action.
// Orders (Commander) gives a station that has acted one more Action. Only tracked during an encounter.
// Correct (John, 2026-10-25): the crew member leaves the station and doesn't act there that turn. So Correct
// can't be used after any other action this turn, and once used, that crew member's other actions (Maneuver,
// reactions, everything) are blocked until the ship's next turn.
// Stored on the ship: flags.fvtt-neon-odyssey.econ = { <crew key>: { action, bonus, reaction, acted, left } }.

/** Which slot an activity uses: "action", "bonus" or "reaction" (special counts as an Action). */
export function slotOf(activity) {
  const t = activity?.activation?.type;
  return t === "bonus" ? "bonus" : t === "reaction" ? "reaction" : "action";
}

/** Who acts: a crew character's id, or for a ship crewed by its own NPC crew, its station. */
export function crewKey(ship, actor, role) {
  if ( actor && (actor.type !== "vehicle") ) return actor.id;
  const stations = ship?.flags?.[MODULE_ID]?.stations ?? [];
  if ( stations.length <= 1 ) return "crew";
  const expand = r => (r === "pilot") ? ["pilot", "helmsman", "gunner"] : (r === "copilot") ? ["copilot", "helmsman", "navigator"] : [r];
  const i = stations.findIndex(s => (s.roles ?? []).some(r => expand(r).includes(role)));
  return i >= 0 ? `station${i}` : (role ?? "crew");
}

/** True while this ship is the encounter's current combatant. */
export function isShipsTurn(ship) {
  // Any started encounter (the GM may be viewing another scene).
  return game.combats.some(combat => {
    const c = combat.started ? combat.combatant : null;
    const a = c?.token?.actor ?? c?.actor;
    if ( !a ) return false;
    return (a.uuid === ship.uuid) || (c.token?.actorLink && (c.actorId === (baseActor(ship) ?? ship).id));
  });
}

export const econOf = ship => ship?.flags?.[MODULE_ID]?.econ ?? {};

/**
 * Can this activity be used now? { ok, why }. Always ok outside an encounter.
 */
/** A crew character at 0 HP is down: no actions until healed (John, 2026-10-26). */
export const crewDown = actor => !!actor && (actor.type !== "vehicle") && (Number(actor.system?.attributes?.hp?.max) > 0)
  && (Number(actor.system?.attributes?.hp?.value) <= 0);
const DISABLED_BLOCKED = new Set(["Maneuver", "Fire", "Aimed Shot", "Empowered Shot", "Let 'em Have It!", "Attack Position",
  "Electronic Warfare", "Roll with the Punch", "Shoot it Down"]);
export function canUse(ship, actor, role, activity) {
  if ( crewDown(actor) ) return { ok: false, why: `${actor.name} is down (0 HP)` };
  // Shore Up is deck crew work (John, 2026-10-26): a character whose only post is Any Station, or a ship's
  // own crew at a Deck Crew station.
  if ( (activity?.name === "Shore Up") || (activity?.name === "Fire Suppression") ) {
    const roles = actor && (actor.type !== "vehicle") ? (crewOf(baseActor(ship) ?? ship)[actor.id] ?? []) : null;
    const deck = roles ? roles.every(r => r === "any") : (ship.flags?.[MODULE_ID]?.stations ?? []).some(st => (st.roles ?? []).includes("deck"));
    if ( !deck ) return { ok: false, why: `${activity.name} is for deck crew` };
  }
  // A disabled ship can't move, fire or jam; the rest of its crew's work goes on.
  if ( disabledReason(ship) && (["helmsman", "gunner", "pilot", "copilot"].includes(role) || DISABLED_BLOCKED.has(activity?.name)) ) {
    return { ok: false, why: `${ship.name} is disabled (${disabledReason(ship)})` };
  }
  if ( !inCombat(ship) ) return { ok: true };
  const used = econOf(ship)[crewKey(ship, actor, role)] ?? {};
  const slot = slotOf(activity);
  if ( used.left ) return { ok: false, why: "Left the station to Correct this turn" };
  if ( (activity?.name === "Correct") && used.acted ) return { ok: false, why: "Already acted at the station this turn (Correct means leaving it)" };
  if ( !isShipsTurn(ship) ) {
    // Off-turn: reactions only, and Fire as return fire.
    const asReaction = (slot === "reaction") || (activity?.name === "Fire");
    if ( !asReaction ) return { ok: false, why: "Not this ship's turn (reactions only)" };
    return used.reaction ? { ok: false, why: "Reaction used" } : { ok: true, slot: "reaction" };
  }
  if ( used[slot] ) return { ok: false, why: `${slot === "bonus" ? "Bonus Action" : slot === "reaction" ? "Reaction" : "Action"} used` };
  return { ok: true, slot };
}

export async function markSlot(ship, key, slot, value = true, name = null) {
  const econ = foundry.utils.deepClone(econOf(ship));
  econ[key] = { ...(econ[key] ?? {}), [slot]: value };
  if ( value && name ) econ[key][name === "Correct" ? "left" : "acted"] = true;
  await ship.update({ [`flags.${MODULE_ID}.econ`]: econ });
}

async function clearEcon(ship) {
  // Crew who left their station to Correct go back to it (John, 2026-10-26).
  try { await (await import("./ship-hud.mjs")).crewHome(ship); } catch(err) { console.warn(`${MODULE_ID} | crew home`, err); }
  const upd = {};
  if ( Object.keys(econOf(ship)).length ) upd[`flags.${MODULE_ID}.-=econ`] = null;
  // Attack Position lasts until the beginning of the pilot's next turn (John, 2026-10-25).
  if ( ship.getFlag(MODULE_ID, "attackPosition") ) upd[`flags.${MODULE_ID}.-=attackPosition`] = null;
  // Divert Power to Shields lasts until the start of the ship's next turn.
  if ( ship.getFlag(MODULE_ID, "shieldsUp") ) upd[`flags.${MODULE_ID}.-=shieldsUp`] = null;
  // Weapons fired this round (Let 'em Have It! fires only an unfired one).
  if ( ship.getFlag(MODULE_ID, "fired") ) upd[`flags.${MODULE_ID}.-=fired`] = null;
  if ( Object.keys(upd).length ) await ship.update(upd);
}

// A ship's turn starts: its stations get their Action, Bonus Action and Reaction back.
Hooks.on("updateCombat", (combat, changes) => {
  if ( !isActiveGM() || !combat.started ) return;
  if ( !("turn" in changes) && !("round" in changes) ) return;
  const c = combat.combatant;
  const actor = c?.token?.actor ?? c?.actor;
  if ( actor?.type === "vehicle" ) enqueue(() => clearEcon(actor));
});
Hooks.on("combatStart", combat => {
  if ( !isActiveGM() ) return;
  for ( const c of combat.combatants ) {
    const actor = c.token?.actor ?? c.actor;
    if ( actor?.type === "vehicle" ) enqueue(() => clearEcon(actor));
  }
});

/* -------------------------------------------- */
/*  No sharing a hex (John, 2026-10-25)         */
/* -------------------------------------------- */
// A ship may pass through another ship's hex, but can't end its turn there. Moving on to the next turn
// is refused while the current ship shares its hex with another ship on the same scene.

/** Other ship tokens on this token's hex (radar copies and hidden tokens don't count). */
export function sharingHex(tokenDoc) {
  const scene = tokenDoc?.parent;
  if ( !scene || !isSectorScene(scene) ) return [];
  const center = d => { const g = scene.grid, s = d._source; return { x: s.x + (s.width * g.sizeX) / 2, y: s.y + (s.height * g.sizeY) / 2 }; };
  const here = scene.grid.getOffset(center(tokenDoc));
  if ( tokenDoc.getFlag(MODULE_ID, "torpedo") ) return [];   // torpedoes slip past ships
  return scene.tokens.filter(t => (t.id !== tokenDoc.id) && (t.actor?.type === "vehicle") && !t.hidden
    && !t.getFlag(MODULE_ID, "radarMirror") && !t.getFlag(MODULE_ID, "torpedo")
    && (() => { const o = scene.grid.getOffset(center(t)); return (o.i === here.i) && (o.j === here.j); })());
}

Hooks.on("preUpdateCombat", (combat, changes, options) => {
  if ( !combat.started || (!("turn" in changes) && !("round" in changes)) ) return;
  if ( options?.direction === -1 ) return;
  const tokenDoc = combat.combatant?.token;
  if ( !tokenDoc || (tokenDoc.actor?.type !== "vehicle") || combat.combatant.defeated || disabledReason(tokenDoc.actor) ) return;
  const others = sharingHex(tokenDoc);
  if ( !others.length ) return;
  ui.notifications.warn(`${tokenDoc.name} can't end its turn on the same hex as ${others.map(t => t.name).join(", ")}. Move it first.`);
  return false;
});

/* -------------------------------------------- */
/*  Disabled ships get a red X (John, 2026-10-25) */
/* -------------------------------------------- */
// A ship that is disabled (rule 16: Strain over HP, or Offline power, propulsion or command) or marked
// defeated in the encounter shows a large red X over its token, for everyone.

function shipIsOut(tokenDoc) {
  // A bridge radar copy shows the state of the sector-map ship it mirrors, not its own stale copy.
  const src = tokenDoc?.getFlag?.(MODULE_ID, "radarMirror");
  if ( src ) { const real = fromUuidSync(src); return real && (real !== tokenDoc) ? shipIsOut(real) : false; }
  const actor = tokenDoc?.actor;
  if ( actor?.type !== "vehicle" ) return false;
  if ( disabledReason(actor) ) return true;
  return (game.combats.find(c => c.started && (c.scene?.id === tokenDoc.parent?.id)) ?? game.combat)?.combatants.some(c => (c.tokenId === tokenDoc.id) && c.defeated) ?? false;
}

function drawDisabledX(token) {
  let g = token.children.find(c => c.name === "noDisabledX");
  const show = shipIsOut(token.document);
  if ( !show ) { if ( g ) g.visible = false; return; }
  if ( !g ) { g = token.addChild(new PIXI.Graphics()); g.name = "noDisabledX"; g.eventMode = "none"; }
  const { width: w, height: h } = token.document.getSize?.() ?? { width: token.w, height: token.h };
  const pad = Math.min(w, h) * 0.1, lw = Math.max(4, Math.min(w, h) * 0.08);
  g.clear();
  g.lineStyle(lw + 4, 0x000000, 0.6).moveTo(pad, pad).lineTo(w - pad, h - pad).moveTo(w - pad, pad).lineTo(pad, h - pad);
  g.lineStyle(lw, 0xdd1111, 0.95).moveTo(pad, pad).lineTo(w - pad, h - pad).moveTo(w - pad, pad).lineTo(pad, h - pad);
  g.visible = true;
  g.zIndex = 1000;
}

const redrawX = tokenDocs => {
  for ( const d of tokenDocs ) if ( d?.object ) drawDisabledX(d.object);
  // Radar copies of these ships on the scene being viewed.
  const uuids = new Set(tokenDocs.filter(Boolean).map(d => d.uuid));
  for ( const t of canvas.scene?.tokens ?? [] ) {
    const src = t.getFlag(MODULE_ID, "radarMirror");
    if ( src && uuids.has(src) && t.object ) drawDisabledX(t.object);
  }
};
Hooks.on("refreshToken", token => drawDisabledX(token));
Hooks.on("updateActor", actor => {
  if ( actor.type !== "vehicle" ) return;
  redrawX(actor.isToken ? [actor.token] : canvas.scene?.tokens.filter(t => t.actorLink && (t.actorId === actor.id)) ?? []);
});
Hooks.on("updateCombatant", c => redrawX([c.token]));
Hooks.on("deleteCombat", () => redrawX(canvas.scene?.tokens ?? []));
Hooks.on("canvasReady", () => redrawX(canvas.scene?.tokens ?? []));
