// Paradox 5E starship designer: the "Ship Designer" tab of the Paradox 5E Starships
// spreadsheet, ported formula-for-formula. Components are items on the vehicle actor
// carrying flags["fvtt-neon-odyssey"].component; this file turns them into ship stats.

import { SIZES } from "./starship-data.mjs";

export const MODULE_ID = "fvtt-neon-odyssey";

/** Slot rules, matching the spreadsheet rows. */
export const SLOTS = {
  shipType:   { label: "Ship Type",    max: 1, stack: false },
  material:   { label: "Material",     max: 1, stack: false },
  propulsion: { label: "Propulsion",   max: 1, stack: true },
  power:      { label: "Power Source", max: 1, stack: true },
  armor:      { label: "Armor",        max: 1, stack: false, hint: "Cladding" },
  shield:     { label: "Shield",       max: 1, stack: false, hint: "Arcane or Projector" },
  special:    { label: "Special",      max: 3, stack: false },
  weapon:     { label: "Weapons",      max: 11, stack: true }
};

/**
 * Which slot a component fills. The spreadsheet's Defense table holds both armor and shields:
 * IDs below 20 (Cladding) are armor; 20 and up (Arcane, Projector) are shields.
 */
export function slotOf(c) {
  if ( c.category !== "defense" ) return c.category;
  if ( c.slot ) return c.slot;
  return parseInt(c.key, 10) < 20 ? "armor" : "shield";
}

/** dnd5e sizes for the nine Paradox sizes (dnd5e has six). */
const DND_SIZE = {
  Fine: "tiny", Diminutive: "tiny", Tiny: "tiny", Small: "sm", Medium: "med",
  Large: "lg", Huge: "huge", Gargantuan: "grg", Colossal: "grg"
};

/** Google Sheets ROUND: half away from zero. */
const round = (x, d = 0) => { const f = 10 ** d; return Math.sign(x) * Math.round(Math.abs(x) * f) / f; };
/** Google Sheets MROUND. */
const mround = (x, m) => round(x / m) * m;
/** Google Sheets PROPER: capitalize the first letter after any non-letter. */
const proper = s => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, a, b) => a + b.toUpperCase());

/**
 * Compute ship stats.
 * @param {object} input
 * @param {number} input.keel, input.beam, input.draft   Dimensions in feet
 * @param {string} input.builtBy
 * @param {number} input.cargo       Cargo in 5-ft squares
 * @param {Array<{c: object, qty: number}>} input.parts   Component flag data + quantity
 */
export function computeShip({ keel, beam, draft, builtBy = "", cargo = 0, parts = [] }) {
  const by = cat => parts.filter(p => p.c.category === cat);
  const one = cat => by(cat)[0] ?? null;
  const shipType = one("shipType"), material = one("material"), prop = one("propulsion");
  const power = one("power");
  const defenses = ["armor", "shield"].map(k => parts.find(p => slotOf(p.c) === k)).filter(Boolean);
  const specials = by("special").slice(0, 3), weapons = by("weapon").slice(0, 11);

  // Dimensions -> tonnage (C7); the sheet falls back to 5x5x10 when dimensions are missing.
  let [L, B, D] = [keel, beam, draft].map(Number);
  if ( !(L > 0 && B > 0 && D > 0) ) [L, B, D] = [5, 5, 10];
  const v = (L * B * D * 0.5) / 2700;
  const tons = v >= 5 ? mround(v, 5) : mround(v, 1);

  // Size (B8): largest size whose tonnage <= ship tonnage.
  let size = SIZES[0];
  for ( const s of SIZES ) if ( s.tons <= tons ) size = s;
  const ratio = tons / size.tons;

  // Column sums, row by row as in the sheet (D speed, E AC, F HP, G DT, H mishap, I power, J crew, K cost).
  const col = { D: 0, E: 0, F: 0, G: 0, H: 0, I: 0, J: 0, K: 0 };
  const addRow = r => { for ( const k in r ) col[k] += Number(r[k]) || 0; };

  addRow({ D: tons >= 1 ? -round(Math.log2(tons)) : 0 });                          // row 7: -ROUND(LOG(tons, 2)); 0 under 1 ton
  addRow({ D: size.speed, G: size.dt + ratio, I: -size.power });                      // row 8
  if ( material ) addRow({ D: material.c.speed, E: material.c.ac, G: material.c.dt, K: ratio * material.c.cost });
  if ( prop ) {
    const q = prop.qty;
    addRow({ D: prop.c.speed + (q - 1), H: prop.c.mishap, I: -prop.c.power * q, J: prop.c.crew * q, K: prop.c.cost * q });
  }
  if ( power ) {
    const q = power.qty;
    addRow({ H: power.c.mishap, I: power.c.power * q, J: power.c.crew * q, K: power.c.cost * q });
  }
  for ( const d of defenses ) addRow({ D: d.c.speed, E: d.c.ac, H: d.c.mishap, I: -d.c.power, K: d.c.cost * ratio });
  for ( const s of specials ) addRow({ D: s.c.speed, E: s.c.ac, F: s.c.hp, G: s.c.dt, H: s.c.mishap, I: s.c.power });
  for ( const w of weapons ) addRow({ H: w.c.mishap, I: -w.c.power * w.qty, J: w.c.crew * w.qty, K: w.c.cost });

  const dt = col.G;
  const mishapNames = [...new Set([shipType, prop, power, ...weapons]
    .filter(Boolean).flatMap(p => p.c.mishaps ?? []))].sort((a, b) => a.localeCompare(b));

  // Description (B40), then PROPER() as on the Stat Block tab.
  let desc = `${size.name}, `;
  for ( const s of specials ) desc += `${s.c.desc}, `;
  if ( material ) desc += `${material.c.desc}, `;
  if ( power ) desc += `${power.c.desc}-powered, `;
  desc += `${prop?.c.desc ?? ""} ${shipType?.c.desc ?? ""} of ${builtBy} design`;

  return {
    tons, size: size.name, dndSize: DND_SIZE[size.name] ?? "med",
    cost: mround(col.K, 5000),
    crew: col.J,
    hp: round(ratio * size.hp + col.F * ratio),
    speed: Math.max(1, round(col.D)),                                              // B46: MAX(1, ROUND(SUM(D)))
    ac: col.E,
    dt: round(dt),
    mt: round(dt * 1.5) + col.H,
    powerSurplus: col.I,
    str: power ? power.c.str : 3,
    dex: prop ? prop.c.dex : 10,
    con: size.con,
    cargoSqft: (Number(cargo) || 0) * 25,
    description: proper(desc.replace(/\s+/g, " ").trim()),
    mishapNames,
    movementKey: shipType?.c.key?.endsWith(" Ship") ? "swim" : "fly"
  };
}

/* -------------------------------------------- */
/*  Foundry glue                                */
/* -------------------------------------------- */

/** Component items on an actor, with their flag data and quantity. */
export function getParts(actor) {
  return actor.items
    .filter(i => i.flags[MODULE_ID]?.component)
    .map(i => ({ item: i, c: i.flags[MODULE_ID].component, qty: Math.max(1, Number(i.system.quantity) || 1) }));
}

export function isDesigned(actor) {
  return actor?.type === "vehicle" && actor.items.some(i => i.flags[MODULE_ID]?.component);
}

/** Recalculate a designed vehicle and write the results into dnd5e's fields. */
export async function recalculate(actor) {
  if ( !isDesigned(actor) || !actor.isOwner ) return null;
  const f = actor.flags[MODULE_ID] ?? {};
  const design = f.design ?? {};
  const s = computeShip({
    keel: actor.system.traits.keel?.value, beam: actor.system.traits.beam?.value, draft: f.draft,
    builtBy: design.builtBy ?? "", cargo: design.cargo ?? 0, parts: getParts(actor)
  });

  const hp = actor.system.attributes.hp;
  const wasFull = hp.value == null || hp.value >= (hp.max ?? 0);
  const movement = { walk: 0, burrow: 0, climb: 0, fly: 0, swim: 0 };
  // dnd5e movement can't be negative; the signed value lives in flags.speed.
  // Negative speed N means the ship gets one move every |N| turns.
  movement[s.movementKey] = Math.max(0, s.speed);

  const update = {
    "system.traits.size": s.dndSize,
    // Keep the token size as-is; dnd5e resizes the prototype token when size changes.
    "prototypeToken.width": actor.prototypeToken.width,
    "prototypeToken.height": actor.prototypeToken.height,
    "system.traits.weight.value": s.tons,
    "system.traits.weight.units": "tn",
    "system.attributes.price.value": s.cost,
    "system.attributes.price.denomination": "gp",
    "system.crew.max": s.crew,
    "system.attributes.ac.calc": "flat",
    "system.attributes.ac.flat": s.ac,
    "system.attributes.hp.max": s.hp,
    "system.attributes.hp.value": wasFull ? s.hp : Math.min(hp.value, s.hp),
    "system.attributes.hp.dt": s.dt,
    "system.attributes.hp.mt": s.mt,
    "system.abilities.str.value": s.str,
    "system.abilities.dex.value": s.dex,
    "system.abilities.con.value": s.con,
    "system.abilities.int.value": 0,
    "system.abilities.wis.value": 0,
    "system.abilities.cha.value": 0,
    "system.details.type": s.movementKey === "swim" ? "water" : "space",
    [`flags.${MODULE_ID}.cargoSqft`]: s.cargoSqft,
    [`flags.${MODULE_ID}.sizeName`]: s.size,
    [`flags.${MODULE_ID}.description`]: s.description,
    [`flags.${MODULE_ID}.mishapNames`]: s.mishapNames,
    [`flags.${MODULE_ID}.powerSurplus`]: s.powerSurplus,
    [`flags.${MODULE_ID}.speed`]: s.speed,
    [`flags.${MODULE_ID}.movementKey`]: s.movementKey
  };
  for ( const [k, v] of Object.entries(movement) ) update[`system.attributes.movement.${k}`] = v;

  // Only write what changed. Always send the token size with a size change, so dnd5e
  // doesn't resize the prototype token (it skips resizing when these are present).
  const changed = Object.fromEntries(Object.entries(update).filter(([k, v]) =>
    !k.startsWith("prototypeToken") && JSON.stringify(foundry.utils.getProperty(actor._source, k)) !== JSON.stringify(v)));
  if ( Object.keys(changed).length ) {
    changed["prototypeToken.width"] = update["prototypeToken.width"];
    changed["prototypeToken.height"] = update["prototypeToken.height"];
    await actor.update(changed, { [`${MODULE_ID}.recalc`]: true });
  }
  return s;
}

/**
 * Add a dropped component to a ship, following the slot rules:
 * single slots replace, stacking slots add quantity for the same component.
 */
export async function addComponent(actor, source) {
  const c = source.flags?.[MODULE_ID]?.component;
  if ( !c ) return false;
  const slotKey = slotOf(c);
  const slot = SLOTS[slotKey];
  const parts = getParts(actor).filter(p => slotOf(p.c) === slotKey);
  const same = parts.find(p => p.c.key === c.key);

  if ( slot.stack && same ) {
    await same.item.update({ "system.quantity": same.qty + 1 });
    return true;
  }
  if ( slot.max === 1 && parts.length ) {
    await actor.deleteEmbeddedDocuments("Item", parts.map(p => p.item.id), { [`${MODULE_ID}.recalc`]: true });
  } else if ( parts.length >= slot.max ) {
    ui.notifications.warn(`This ship already has ${slot.max} ${slot.label} components.`);
    return false;
  }
  if ( same && !slot.stack ) {
    ui.notifications.warn(`${source.name} is already installed.`);
    return false;
  }
  const data = source.toObject();
  delete data._id;
  data.system.quantity = 1;
  await actor.createEmbeddedDocuments("Item", [data]);
  return true;
}

/* -------------------------------------------- */
/*  Hooks: recalculate whenever components or design inputs change                */
/* -------------------------------------------- */

const DESIGN_INPUTS = [
  "system.traits.keel", "system.traits.beam",
  `flags.${MODULE_ID}.draft`, `flags.${MODULE_ID}.design`
];

function onItemChange(item, options, userId) {
  if ( userId !== game.user.id ) return;
  const actor = item.parent;
  if ( actor?.type !== "vehicle" || !item.flags[MODULE_ID]?.component ) return;
  recalculate(actor);
}
Hooks.on("createItem", onItemChange);
// updateItem passes (item, changes, options, userId); create/delete pass (item, options, userId).
Hooks.on("updateItem", (item, changes, options, userId) => onItemChange(item, options, userId));
Hooks.on("deleteItem", (item, options, userId) => {
  if ( options?.[`${MODULE_ID}.recalc`] ) return;   // slot replacement; the new component triggers the recalc
  onItemChange(item, options, userId);
});

Hooks.on("updateActor", (actor, changes, options, userId) => {
  if ( userId !== game.user.id || options?.[`${MODULE_ID}.recalc`] ) return;
  if ( actor.type !== "vehicle" ) return;
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
