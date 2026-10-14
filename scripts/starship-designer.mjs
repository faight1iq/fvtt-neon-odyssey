// Neon Odyssey starship designer (v2). Components are items on the vehicle actor carrying
// flags["fvtt-neon-odyssey"].component (v: 2), imported from the Neon Odyssey Starship Design
// Studio sheet. This file turns them into ship stats (see starship-calc.mjs, the sheet's
// Design Analysis tab) and writes the results into dnd5e's vehicle fields and the flags the
// bridge HUD reads.
//
// Older ships built from the v1 components (the "Paradox 5E Starships" sheet, now in the
// compendium's Legacy folder) are left alone until they are rebuilt with v2 parts.

import { SLOT_DEFS, FACINGS, GUNNER_FACINGS, LOCATIONS, LOCATION_KEYS, SYSTEM_ROLE, systemRole, DEFAULT_LOCATION, needsStation, needsSeat, stationLocation, locationLabel, computeShip, tonsForDimensions, classForTons } from "./starship-calc.mjs";
import "./crew-stations.mjs";
import "./ship-hud.mjs";
import "./sector-map.mjs";

export const MODULE_ID = "fvtt-neon-odyssey";
export { SLOT_DEFS, FACINGS, GUNNER_FACINGS, LOCATIONS, needsStation, needsSeat, locationLabel };
/** Button and list labels for facings ("bridge" reads as Command & Control). */
export const facingLabel = f => f === "bridge" ? "Command & Control" : (f ? f[0].toUpperCase() + f.slice(1) : "");

/** v2 component flag of an item, or null. */
export function componentOf(item) {
  const c = item?.flags?.[MODULE_ID]?.component;
  return c?.v === 2 ? c : null;
}

/** v2 component items on an actor, with flag data, quantity and facing. */
export function getParts(actor) {
  return actor.items.filter(i => componentOf(i)).map(i => ({
    item: i, id: i.id, name: i.name, c: componentOf(i),
    qty: Math.max(1, Number(i.system.quantity) || 1),
    facing: i.flags[MODULE_ID]?.facing ?? null,
    // Systems: where their station is ("none" = needs no crew). Stations: where they sit.
    station: i.flags[MODULE_ID]?.station?.location ?? null,
    location: i.flags[MODULE_ID]?.location ?? null,
    auto: !!i.flags[MODULE_ID]?.autoStation
  }));
}

/* -------------------------------------------- */
/*  Live component data                         */
/* -------------------------------------------- */

const PACK_ID = `${MODULE_ID}.starship-components`;
let library = null;

/**
 * The compendium's v2 components by sheet id, plus the Ship Classes. Installed items take their
 * stats from here, so a re-import (sheet changes) reaches ships already built.
 */
export async function componentLibrary() {
  if ( library ) return library;
  const pack = game.packs.get(PACK_ID);
  const byId = new Map(), classes = [];
  if ( pack ) {
    const index = await pack.getIndex({ fields: [`flags.${MODULE_ID}.component`] });
    for ( const e of index ) {
      const c = e.flags?.[MODULE_ID]?.component;
      if ( c?.v !== 2 ) continue;
      byId.set(`${c.slot}|${c.id}`, c);
      if ( c.slot === "shipClass" ) classes.push({ c, name: e.name, uuid: e.uuid });
    }
  }
  return (library = { byId, classes });
}
Hooks.on("updateCompendium", pack => { if ( pack.collection === PACK_ID ) library = null; });
for ( const h of ["createItem", "updateItem", "deleteItem"] ) Hooks.on(h, doc => { if ( doc.pack === PACK_ID ) library = null; });

/** The ship's keel, beam and draft (feet) and tonnage. */
export function dimensions(actor) {
  const keel = Number(actor.system.traits?.keel?.value) || 0;
  const beam = Number(actor.system.traits?.beam?.value) || 0;
  const draft = Number(actor.flags[MODULE_ID]?.draft) || 0;
  return { keel, beam, draft, tons: tonsForDimensions(keel, beam, draft) };
}

/**
 * Parts for the calculator: installed components with the compendium's current stats, and the
 * Ship Class chosen by tonnage when keel, beam and draft are set (an installed Ship Class is
 * then ignored).
 */
export async function designParts(actor) {
  const lib = await componentLibrary();
  let parts = getParts(actor).map(p => ({ ...p, c: lib.byId.get(`${p.c.slot}|${p.c.id}`) ?? p.c }));
  const dims = dimensions(actor);
  const cls = classForTons(dims.tons, lib.classes);
  if ( cls ) parts = parts.filter(p => p.c.slot !== "shipClass").concat({ c: cls.c, qty: 1, name: cls.name, id: null, auto: true });
  return { parts, dims, shipClass: cls };
}

/** v1 components still on the actor (from the Legacy folder). */
export function legacyParts(actor) {
  return actor.items.filter(i => i.flags[MODULE_ID]?.component && !componentOf(i));
}

export function isDesigned(actor) {
  return actor?.type === "vehicle" && actor.items.some(i => componentOf(i));
}

/** Ship Level (John, 2026-10-13): set per ship, default 1 (Second Resource Rush). */
export function shipLevel(actor) {
  return Math.max(1, Math.floor(Number(actor?.flags?.[MODULE_ID]?.level) || 1));
}

/** Ship Proficiency Bonus: the 5e table (+2 at 1–4 … +6 at 17–20), continued past 20 (+7 at 21–24). */
export function shipProf(actor) {
  return Math.ceil(shipLevel(actor) / 4) + 1;
}

/** Recalculate a designed vehicle and write the results into dnd5e's fields. */
export async function recalculate(actor) {
  if ( !isDesigned(actor) || !actor.isOwner ) return null;
  const { parts, dims } = await designParts(actor);
  const s = computeShip(parts, { tons: dims.tons, troops: Number(actor.flags[MODULE_ID]?.troops) || 0,
    dims: { ...dims, sifLayers: Number(actor.flags[MODULE_ID]?.sifLayers) || 1 } });
  const hp = actor.system.attributes.hp;
  const wasFull = hp.value == null || hp.value >= (hp.max ?? 0);
  const movement = { walk: 0, burrow: 0, climb: 0, fly: 0, swim: 0 };
  // dnd5e movement can't be negative; the signed value lives in flags.speed.
  movement[s.movementKey] = Math.max(0, s.speed);

  const F = `flags.${MODULE_ID}`;
  const update = {
    "system.traits.size": s.dndSize,
    "system.attributes.price.value": s.cost,
    "system.attributes.price.denomination": "gp",
    "system.crew.max": s.crew,
    "system.passengers.max": s.passengers,
    "system.attributes.ac.calc": "flat",
    "system.attributes.ac.flat": s.ac,
    "system.attributes.hp.max": s.hp,
    "system.attributes.hp.value": wasFull ? s.hp : Math.min(hp.value, s.hp),
    "system.attributes.hp.mt": s.mt,
    "system.details.type": s.detailsType,
    ...(dims.tons ? { "system.traits.weight.value": dims.tons, "system.traits.weight.units": "tn" } : {}),
    [`${F}.sizeName`]: s.sizeName,
    [`${F}.description`]: s.description,
    [`${F}.mishapNames`]: s.mishapNames,
    [`${F}.powerSurplus`]: s.power.net,
    [`${F}.speed`]: s.speed,
    [`${F}.movementKey`]: s.movementKey,
    [`${F}.cargo`]: s.cargo,
    [`${F}.shield`]: { ac: s.acDeflector - s.ac, acRaised: s.acDeflector, charges: s.shieldCharges,
      ablativeHp: s.ablativeHp, ablativeRegen: s.ablativeRegen },
    [`${F}.stations`]: s.stations,
    [`${F}.analysis`]: { v: 2, hitDie: s.hitDie, hitDice: s.hitDice, berths: s.berths, acrobatics: s.acrobatics,
      compartments: s.compartments, power: s.power, combat: s.combat, checks: s.checks,
      tons: dims.tons, prisoners: s.prisoners, brigCrew: s.brigCrew, ammo: s.ammo }
  };
  // Ship Level: the ship's Proficiency Bonus is added to every saving throw.
  const pb = shipProf(actor);
  update[`${F}.prof`] = pb;
  for ( const k of ["str", "dex", "con", "int", "wis", "cha"] ) {
    update[`system.abilities.${k}.value`] = s.abilities[k];
    update[`system.abilities.${k}.bonuses.save`] = String(pb);
  }
  for ( const [k, v] of Object.entries(movement) ) update[`system.attributes.movement.${k}`] = v;

  // Only write what changed. Send the token size with a size change, so dnd5e doesn't resize
  // the prototype token (it skips resizing when these are present).
  const changed = Object.fromEntries(Object.entries(update).filter(([k, v]) =>
    JSON.stringify(foundry.utils.getProperty(actor._source, k)) !== JSON.stringify(v)));
  if ( Object.keys(changed).length ) {
    changed["prototypeToken.width"] = actor.prototypeToken.width;
    changed["prototypeToken.height"] = actor.prototypeToken.height;
    await actor.update(changed, { [`${MODULE_ID}.recalc`]: true });
  }
  return s;
}

/** Ask which facing a weapon is mounted on. Resolves to a facing or null (cancelled). */
export async function askFacing(name, current = null, choices = FACINGS) {
  const { DialogV2 } = foundry.applications.api;
  return DialogV2.wait({
    window: { title: `Mount ${name}` },
    content: `<p>Where is <strong>${name}</strong>?</p>`,
    buttons: choices.map(f => ({ action: f, label: facingLabel(f), default: f === (current ?? choices[0]) })),
    rejectClose: false
  }).then(r => choices.includes(r) ? r : null);
}

/* -------------------------------------------- */
/*  Stations                                    */
/* -------------------------------------------- */

/** The Standard station added for each role when a system needs one. */
const STATION_NAME = { helmsman: "Helm Station (Standard)", engineer: "Engineering Station (Standard)",
  navigator: "Sensors Station (Standard)", commander: "Command & Control (Standard)", gunner: "Gunnery Station (Standard)" };

/** Ask where a station is. Resolves to a location key, "none" (when allowed) or null (cancelled). */
export async function askLocation(title, text, current, { allowNone = false, choices = null } = {}) {
  const { DialogV2 } = foundry.applications.api;
  choices ??= [...LOCATION_KEYS, ...(allowNone ? ["none"] : [])];
  return DialogV2.wait({
    window: { title },
    content: `<p>${text}</p>`,
    buttons: choices.map(k => ({ action: k, label: locationLabel(k), default: k === current })),
    rejectClose: false
  }).then(r => choices.includes(r) ? r : null);
}

/** The station items on a ship for a role, with their locations. */
function stationsFor(actor, role) {
  return actor.items.filter(i => componentOf(i)?.stationRoles?.includes(role)).map(i => ({
    item: i, location: stationLocation(i.flags[MODULE_ID]?.location, i.flags[MODULE_ID]?.facing, role)
  }));
}

/** Delete auto-added stations no system uses any more. */
async function pruneStations(actor) {
  const used = new Set(actor.items.map(i => i.flags[MODULE_ID]?.station?.itemId).filter(Boolean));
  const stale = actor.items.filter(i => i.flags[MODULE_ID]?.autoStation && !used.has(i.id)).map(i => i.id);
  if ( stale.length ) await actor.deleteEmbeddedDocuments("Item", stale);
}

/**
 * Put a crewed system's station at a location: use the ship's station of that role there, or add
 * a Standard one. "none" = the system needs no crew and has no station.
 */
export async function setStation(actor, system, location) {
  const c = componentOf(system);
  const role = systemRole(c);
  if ( !role ) return;
  if ( location === "none" ) {
    await system.update({ [`flags.${MODULE_ID}.station`]: { location: "none", itemId: null } });
    return pruneStations(actor);
  }
  let station = stationsFor(actor, role).find(s => s.location === location)?.item;
  if ( !station ) {
    const pack = game.packs.get(PACK_ID);
    const entry = pack?.index.find(e => e.name === STATION_NAME[role]) ?? (await pack?.getIndex())?.find(e => e.name === STATION_NAME[role]);
    const src = entry ? await pack.getDocument(entry._id) : null;
    if ( !src ) { ui.notifications.warn(`No ${STATION_NAME[role]} in the Starship Components compendium.`); return; }
    const data = src.toObject();
    delete data._id;
    data.system.quantity = 1;
    foundry.utils.mergeObject(data, { flags: { [MODULE_ID]: { sourceId: src.uuid, location, autoStation: true } } });
    [station] = await actor.createEmbeddedDocuments("Item", [data], { [`${MODULE_ID}.recalc`]: true });
  }
  await system.update({ [`flags.${MODULE_ID}.station`]: { location, itemId: station.id } });
  return pruneStations(actor);
}

/** Default location for a system's station: weapons sit with their facing (bow on the bridge). */
function defaultLocation(role, facing) {
  if ( role === "gunner" ) return FACINGS.includes(facing) && facing !== "bow" ? facing : "command";
  return DEFAULT_LOCATION[role] ?? "command";
}

/**
 * Add a dropped component to a ship.
 * - Single-row slots (Ship Class, Material, Armor, ...) replace what is there.
 * - Quantity slots add 1 to the same component (weapons: same component and facing).
 * - Going past the sheet's row count is allowed; the checks panel warns about it.
 */
export async function addComponent(actor, source) {
  const c = componentOf(source);
  if ( !c ) {
    if ( source.flags?.[MODULE_ID]?.component ) ui.notifications.warn(`${source.name} is a Legacy (v1) component. Use the Design Studio components instead.`);
    return false;
  }
  const def = SLOT_DEFS[c.slot];
  if ( !def ) return false;
  const inSlot = getParts(actor).filter(p => p.c.slot === c.slot);

  // Weapons are mounted on a facing; stations sit in a location (a HUD system block).
  const faced = c.slot === "weapon";
  let facing = null, location = null;
  if ( faced ) {
    facing = await askFacing(source.name, null, FACINGS);
    if ( !facing ) return false;
  }
  if ( c.stationRoles?.length ) {
    location = await askLocation(`Place ${source.name}`, `Where is <strong>${source.name}</strong>?`,
      defaultLocation(c.stationRoles[0], null));
    if ( !location ) return false;
  }
  // A crewed system asks where its station is (or None: it then needs no crew).
  const role = needsStation(c) ? systemRole(c) : null;
  let stationAt = null;
  if ( role ) {
    stationAt = await askLocation(`Station for ${source.name}`,
      `Where is the <strong>${role[0].toUpperCase() + role.slice(1)}</strong> station for <strong>${source.name}</strong>? Choose Automated if it needs no crew.`,
      defaultLocation(role, facing), { allowNone: true });
    if ( !stationAt ) return false;
  }
  // Galley, Medical Bay: Crewed (a Cook or Medic card) or Automated (no crew).
  let seat = null;
  if ( needsSeat(c) ) {
    const who = c.seatRole === "cook" ? "Cook" : "Medic";
    seat = await askLocation(`Crew for ${source.name}`, `Is <strong>${source.name}</strong> run by a ${who}, or automated?`,
      "habitat", { choices: ["habitat", "none"] });
    if ( !seat ) return false;
  }
  const same = inSlot.find(p => p.c.id === c.id && (!faced || p.facing === facing) && (!seat || (p.station ?? "habitat") === seat)
    && (!location || stationLocation(p.location, p.facing, c.stationRoles?.[0]) === location));
  if ( same ) {
    if ( !def.qty ) { ui.notifications.info(`${source.name} is already installed.`); return false; }
    await same.item.update({ "system.quantity": same.qty + 1 });
    if ( role ) await setStation(actor, same.item, stationAt);
    return true;
  }
  if ( def.max === 1 && inSlot.length ) {
    await actor.deleteEmbeddedDocuments("Item", inSlot.map(p => p.id), { [`${MODULE_ID}.recalc`]: true });
  }
  const data = source.toObject();
  delete data._id;
  data.system.quantity = 1;
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.sourceId`, source.uuid);
  if ( facing ) foundry.utils.setProperty(data, `flags.${MODULE_ID}.facing`, facing);
  if ( location ) foundry.utils.setProperty(data, `flags.${MODULE_ID}.location`, location);
  if ( seat ) foundry.utils.setProperty(data, `flags.${MODULE_ID}.station`, { location: seat, itemId: null });
  const [made] = await actor.createEmbeddedDocuments("Item", [data]);
  if ( role && made ) await setStation(actor, made, stationAt);
  return true;
}

/* -------------------------------------------- */
/*  Hooks: recalculate whenever components change                                 */
/* -------------------------------------------- */

function onItemChange(item, options, userId) {
  if ( userId !== game.user.id ) return;
  const actor = item.parent;
  if ( actor?.type !== "vehicle" || !componentOf(item) ) return;
  recalculate(actor);
}
Hooks.on("createItem", onItemChange);
// updateItem passes (item, changes, options, userId); create/delete pass (item, options, userId).
Hooks.on("updateItem", (item, changes, options, userId) => onItemChange(item, options, userId));
Hooks.on("deleteItem", (item, options, userId) => {
  if ( options?.[`${MODULE_ID}.recalc`] ) return;   // slot replacement; the new component triggers the recalc
  if ( (userId === game.user.id) && item.parent?.type === "vehicle" && componentOf(item) ) {
    // A removed system takes its auto-added station with it (if nothing else uses it).
    const actor = item.parent;
    // A station deleted by hand: the systems that used it need a station again.
    const users = actor.items.filter(i => i.flags[MODULE_ID]?.station?.itemId === item.id);
    const unlink = users.length ? actor.updateEmbeddedDocuments("Item",
      users.map(i => ({ _id: i.id, [`flags.${MODULE_ID}.-=station`]: null }))) : Promise.resolve();
    unlink.then(() => pruneStations(actor)).then(() => { if ( isDesigned(actor) ) recalculate(actor); });
  }
});

// Keel, beam and draft set the size.
const DESIGN_INPUTS = ["system.traits.keel", "system.traits.beam", `flags.${MODULE_ID}.draft`, `flags.${MODULE_ID}.troops`,
  `flags.${MODULE_ID}.level`];
Hooks.on("updateActor", (actor, changes, options, userId) => {
  if ( userId !== game.user.id || options?.[`${MODULE_ID}.recalc`] || actor.type !== "vehicle" ) return;
  if ( DESIGN_INPUTS.some(k => foundry.utils.hasProperty(changes, k)) ) recalculate(actor);
});

/* -------------------------------------------- */
/*  Gunners: ship weapon attacks use the attacking player's character             */
/* -------------------------------------------- */

/** The character firing: the user's assigned character, else a controlled character token (for the GM). */
function getGunner() {
  if ( game.user.character ) return game.user.character;
  return canvas?.tokens?.controlled.find(t => t.actor?.type === "character")?.actor ?? null;
}

/** Ship weapons this applies to: weapons on a vehicle using the Paradox sheet or carrying Paradox flags. */
function isShipWeapon(activity) {
  const actor = activity?.actor, item = activity?.item;
  if ( actor?.type !== "vehicle" || item?.type !== "weapon" ) return false;
  return actor.getFlag("core", "sheetClass") === `${MODULE_ID}.StarshipSheet` || !!item.flags[MODULE_ID];
}

// Attack roll: add the gunner's DEX (STR for melee) modifier and proficiency bonus.
Hooks.on("dnd5e.postBuildAttackRollConfig", (process, config) => {
  const activity = process.subject;
  if ( !isShipWeapon(activity) ) return;
  if ( config.parts?.includes("@gunner.mod") ) return;
  const gunner = getGunner();
  if ( !gunner ) return;
  const ability = activity.attack?.type?.value === "melee" ? "str" : "dex";
  config.parts = [...(config.parts ?? []), "@gunner.mod", "@gunner.prof"];
  config.data = {
    ...(config.data ?? {}),
    gunner: { mod: gunner.system.abilities[ability]?.mod ?? 0, prof: gunner.system.attributes.prof ?? 0 }
  };
});

// Damage: add the ship's Proficiency Bonus once per hit (attacks) or per volley (racks, saves).
Hooks.on("dnd5e.preRollDamageV2", (config) => {
  const activity = config.subject;
  if ( !isShipWeapon(activity) ) return;
  const roll = config.rolls?.[0];
  if ( !roll || roll.parts?.includes("@shipProf") ) return;
  roll.parts = [...(roll.parts ?? []), "@shipProf"];
  roll.data = { ...(roll.data ?? {}), shipProf: shipProf(activity.actor) };
});

// Name the gunner in the chat card, or warn when no character is available.
Hooks.on("dnd5e.preRollAttackV2", (config, dialog, message) => {
  const activity = config.subject;
  if ( !isShipWeapon(activity) ) return;
  const gunner = getGunner();
  if ( !gunner ) {
    ui.notifications.warn("No character assigned to your account: this attack uses no gunner bonus.");
    return;
  }
  if ( message?.data ) message.data.flavor = `${message.data.flavor ?? activity.item.name} (Gunner: ${gunner.name})`;
});

/* -------------------------------------------- */
/*  Ammo (John, 2026-10-12)                     */
/* -------------------------------------------- */
// Ammunition Magazines hold 12 units of their own size (a missile uses 6, a ballistic round 1).
// Missiles and Ballistic weapons fire straight from the magazines of their size; MLA isn't tracked.
// Spent units per size live in flags.fvtt-neon-odyssey.ammoUsed; Rearm clears them.

/** Magazine pools by size: { Small: { capacity, used, left } }. */
export function ammoPools(actor) {
  const cap = actor?.flags?.[MODULE_ID]?.analysis?.ammo?.capacity ?? {};
  const used = actor?.flags?.[MODULE_ID]?.ammoUsed ?? {};
  const out = {};
  for ( const size of new Set([...Object.keys(cap), ...Object.keys(used)]) ) {
    const c = Number(cap[size]) || 0, u = Math.min(c, Number(used[size]) || 0);
    out[size] = { capacity: c, used: u, left: c - u };
  }
  return out;
}

/** A weapon's ammo use and what is left for it, or null if it uses none. */
export function weaponAmmo(actor, itemId) {
  const w = actor?.flags?.[MODULE_ID]?.analysis?.ammo?.weapons?.[itemId];
  if ( !w ) return null;
  const pool = ammoPools(actor)[w.size] ?? { capacity: 0, used: 0, left: 0 };
  return { ...w, ...pool, shots: Math.floor(pool.left / w.cost) };
}

/** Spend one shot's ammo. Returns false (and warns) if there isn't enough. */
export async function spendAmmo(actor, itemId) {
  const a = weaponAmmo(actor, itemId);
  if ( !a ) return true;
  if ( a.left < a.cost ) {
    ui.notifications.warn(`${actor.name}: no ${a.size} ammo left for ${a.name}${a.capacity ? "" : " (no " + a.size + " Ammunition Magazine)"}.`);
    return false;
  }
  if ( actor.isOwner ) await actor.update({ [`flags.${MODULE_ID}.ammoUsed.${a.size}`]: a.used + a.cost });
  return true;
}

/** Refill every magazine. */
export async function rearm(actor) {
  if ( actor?.isOwner ) await actor.update({ [`flags.${MODULE_ID}.-=ammoUsed`]: null });
}

// Ship weapon attacks spend ammo before rolling; out of ammo cancels the attack.
Hooks.on("dnd5e.preRollAttackV2", (config, dialog, message) => {
  const activity = config.subject;
  if ( !isShipWeapon(activity) ) return;
  const a = weaponAmmo(activity.actor, activity.item.id);
  if ( !a ) return;
  if ( a.left < a.cost ) {
    ui.notifications.warn(`${activity.actor.name}: no ${a.size} ammo left for ${a.name}${a.capacity ? "" : " (no " + a.size + " Ammunition Magazine)"}.`);
    return false;
  }
  spendAmmo(activity.actor, activity.item.id);
});

/* -------------------------------------------- */
/*  No token ring on starships                  */
/* -------------------------------------------- */

// Ship tokens use their own art (read on the radar), so the dynamic token ring is always off
// for vehicles: on new vehicle actors' prototype tokens and on every vehicle token placed.
Hooks.on("preCreateActor", (actor, data) => {
  if ( actor.type !== "vehicle" ) return;
  actor.updateSource({ "prototypeToken.ring.enabled": false });
});
Hooks.on("preCreateToken", (token, data) => {
  if ( token.actor?.type !== "vehicle" ) return;
  token.updateSource({ "ring.enabled": false });
});
