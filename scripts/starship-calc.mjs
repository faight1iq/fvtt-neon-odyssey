// Neon Odyssey starship calculator (v2): the "Design Analysis" tab of the
// Neon Odyssey Starship Design Studio sheet, formula for formula.
//
// Pure functions only (no Foundry calls), so the math can be tested outside Foundry.
// A part is { c: flags["fvtt-neon-odyssey"].component (v: 2), qty, name, facing }.
// Component stats come from each tab's stat block (columns T:AV; Ship Classes L:AH;
// Materials K:AG; Descriptors D/E/F/G/I) and are summed like row 40 (TOTALS).
//
// Rule changes after the sheet (John, 2026-10-12):
//  - The ship class comes from keel x beam x draft (see classForDimensions), not a part.
//  - Extra Propulsion or Power Source units add redundancy only: +2 MT per extra unit;
//    Speed, DEX/STR, power, crew, cost and compartments count once.
//  - Power scales with size: Power Source output, Propulsion draw, and weapon and shield draw all
//    follow the part's compartments (see partPower).
//  - Compartments are whole numbers: a fraction is a share of the class budget, rounded up.
//  - Brigs and Detention Blocks need 0.5 crew per block in total, rounded down.
//  - Stations carry no crew (their systems do). The first station of each role is free; extra
//    stations of a role take their compartments and cost. A crewed system set to station
//    "None" needs no crew.

/** Design slots, in the Design Analysis row order. max = rows on the sheet. */
export const SLOT_DEFS = {
  shipClass:  { label: "Ship Class",      max: 1,  qty: false, folder: "Ship Classes" },
  material:   { label: "Material",        max: 1,  qty: false, folder: "Materials" },
  // No limit on descriptors (John, 2026-10-12); the Design Analysis tab just has two rows for them.
  descriptor: { label: "Descriptors",     max: Infinity, qty: false, folder: "Descriptors" },
  shipType:   { label: "Ship Type",       max: 1,  qty: false, folder: "Ship Types" },
  propulsion: { label: "Propulsion",      max: 1,  qty: true,  folder: "Propulsion" },
  power:      { label: "Power Source",    max: 1,  qty: true,  folder: "Power Sources" },
  armor:      { label: "Armor",           max: 1,  qty: false, folder: "Armor" },
  deflector:  { label: "Deflector",       max: 1,  qty: false, folder: "Shields" },
  ablative:   { label: "Ablative Field",  max: 1,  qty: false, folder: "Shields" },
  sensory:    { label: "Sensory Gear",    max: 1,  qty: false, folder: "Sensory Gear" },
  nexus:      { label: "Nexus Core",      max: 1,  qty: false, folder: "Nexus Cores" },
  comms:      { label: "Communications",  max: 1,  qty: false, folder: "Communications" },
  habitat:    { label: "Habitats & Stations", max: Infinity, qty: true, folder: "Habitats" },
  weapon:     { label: "Weapons",         max: Infinity, qty: true,  folder: "Weapons" }
};

/** Ammo: units an Ammunition Magazine holds, and units per shot (John, 2026-10-12). */
export const MAGAZINE_UNITS = 12;
export const AMMO_COST = { missile: 6, round: 1 };

/** Rows whose stats are not multiplied by quantity (rows 5-9 on the sheet). */
const NO_QTY = new Set(["shipClass", "material", "descriptor", "shipType"]);
/** Rows where extra units are redundancy: stats once, +REDUNDANT_MT MT per extra unit. */
const REDUNDANT = new Set(["propulsion", "power"]);
export const REDUNDANT_MT = 2;

export const FACINGS = ["bow", "port", "starboard", "aft"];
/** Gunnery Stations can also sit on the bridge (Command & Control): one fire control for the ship. */
export const GUNNER_FACINGS = ["bridge", ...FACINGS];

/**
 * Where a station sits: the HUD system block it is shown in (John, 2026-10-12).
 * "none" is for a crewed system: it then needs no crew and has no station.
 */
export const LOCATIONS = [
  { key: "bow", label: "Bow Weapons" }, { key: "command", label: "Command & Control" },
  { key: "navigation", label: "Navigation" }, { key: "port", label: "Port Weapons" },
  { key: "starboard", label: "Starboard Weapons" }, { key: "aft", label: "Aft Weapons" },
  { key: "power", label: "Power Systems" }, { key: "propulsion", label: "Propulsion" }
];
export const LOCATION_KEYS = LOCATIONS.map(l => l.key);
export const locationLabel = k => k === "none" ? "Automated" : (k === "habitat" ? "Crewed" : (LOCATIONS.find(l => l.key === k)?.label ?? ""));

/** Systems that run from a station, and the station role they need. */
export const SYSTEM_ROLE = { propulsion: "helmsman", power: "engineer", sensory: "navigator",
  comms: "navigator", nexus: "commander", weapon: "gunner" };
/** A system needs a station (or "Automated") when it has crew. */
export const needsStation = c => !!systemRole(c) && num(c?.stats?.crew) > 0;
/** The station role a system needs (a part can override its slot's role: Helms are the pilot's). */
export const systemRole = c => c?.systemRole ?? SYSTEM_ROLE[c?.slot] ?? null;
/** Habitats worked in place by a crew role (Galley: Cook, Medical Bay: Medic), Crewed or Automated. */
export const needsSeat = c => !!c?.seatRole && num(c?.stats?.crew) > 0;

/** Where a role's station goes when nobody chose (gunners: with their weapons' facing). */
export const DEFAULT_LOCATION = { commander: "command", pilot: "command", copilot: "command", helmsman: "command",
  engineer: "power", navigator: "navigation", gunner: "command" };

/**
 * A station item's location. Older items kept a gunner "facing" (bridge and bow = Command &
 * Control); stations placed before locations existed use their role's default.
 */
export function stationLocation(location, facing, role = null) {
  if ( LOCATION_KEYS.includes(location) ) return location;
  if ( facing === "bridge" || facing === "bow" ) return "command";
  if ( FACINGS.includes(facing) ) return facing;
  return role === "gunner" ? null : (DEFAULT_LOCATION[role] ?? null);
}
export const SIZE_ORDER = ["Tiny", "Small", "Medium", "Large", "Huge", "Gargantuan"];
const DND_SIZE = { Tiny: "tiny", Small: "sm", Medium: "med", Large: "lg", Huge: "huge", Gargantuan: "grg" };

/** Sheet mishap names that differ from the Actors compendium keys. */
export const MISHAP_ALIASES = { "Listing": "List", "Wind Shear": "Wind-Sheer" };

const SUM_KEYS = ["ac", "mt", "speed", "str", "dex", "con", "int", "wis", "cha", "cargo", "crew",
  "passengers", "berths", "power", "compartments", "cost", "shieldAc", "shieldCharges",
  "ablativeHp", "ablativeRegen", "hpBonus", "hpPct", "prisoners"];

/** Volume / 35 cu ft per ton, for a hull of elliptical cross-section (as the Ship Classes averages). */
export function tonsForDimensions(keel, beam, draft) {
  const [L, B, D] = [keel, beam, draft].map(Number);
  if ( !(L > 0 && B > 0 && D > 0) ) return 0;
  return Math.round(Math.PI / 4 * L * B * D / 35);
}

/**
 * The ship class whose average tonnage is nearest on a log scale (boundaries at the geometric
 * midpoints between class averages).
 * @param {number} tons
 * @param {Array<{c: object}>} classes  Ship Class components (info.Tonns = class average)
 */
export function classForTons(tons, classes) {
  if ( !(tons > 0) || !classes?.length ) return null;
  let best = null, bestD = Infinity;
  for ( const k of classes ) {
    const avg = num(k.c.info?.Tonns);
    if ( !(avg > 0) ) continue;
    const d = Math.abs(Math.log(tons) - Math.log(avg));
    if ( d < bestD ) { bestD = d; best = k; }
  }
  return best;
}

/** Power Source output on a ship of this size rank: +10% per size above Small, rounded up to 5. */
export function scaledPower(v, share) {
  if ( !(v > 0) ) return v;
  return Math.ceil(Math.max(v * share / 5, v / 2) / 5) * 5;
}

/** A part's compartments for one unit (a fraction is a share of the class budget, rounded up). */
function unitCompartments(c, budget) {
  const v = num(c.stats?.compartments);
  if ( (v < 0) && (v > -1) ) return Math.max(1, Math.ceil(-v * budget));
  return Math.abs(Math.round(v));
}

/**
 * Power for one unit of a part, scaled with its size (John, 2026-10-12):
 *  - Power Source output = listed x its compartments / 5, at least half the listed value,
 *    rounded up to the nearest 5 (the listed value is the Medium-ish rating).
 *  - Propulsion draw = listed x its compartments / 9 (listed = the Medium draw), rounded up.
 *  - Weapons and shields draw their technology's rate (powerRate) per compartment, rounded up.
 *  - Everything else as listed.
 */
export function partPower(c, budget) {
  const v = num(c.stats?.power);
  const size = unitCompartments(c, budget);
  if ( c.slot === "power" ) return scaledPower(v, size);
  if ( (c.slot === "propulsion") && (v < 0) ) return -Math.ceil(-v * size / 9);
  if ( ["weapon", "deflector", "ablative"].includes(c.slot) && (c.powerRate != null) ) return -Math.ceil(num(c.powerRate) * size);
  return v;
}

/** Google Sheets ROUND: half away from zero. */
const round = x => Math.sign(x) * Math.round(Math.abs(x));
const mod = score => Math.floor((score - 10) / 2);
const num = v => { const n = Number(String(v ?? "").replace(/[,+]/g, "")); return Number.isFinite(n) ? n : 0; };

/** "1-Tiny" -> 1 */
export function sizeRank(id) { return parseInt(String(id ?? ""), 10) || 0; }

/** Average damage of an "NdM" string (column AA), else 0 ("As spell"). */
export function avgDamage(dmg) {
  const m = /^(\d*)d(\d+)$/.exec(String(dmg ?? "").trim());
  return m ? (Number(m[1] || 1) * (Number(m[2]) + 1)) / 2 : 0;
}

/**
 * Compute a ship from its parts.
 * @param {Array<{c: object, qty?: number, name?: string, facing?: string}>} parts
 * @param {{hitChance?: number}} [opts]
 */
export function computeShip(parts, { hitChance = 0.6, tons = 0, troops = 0, dims = null } = {}) {
  parts = parts.filter(p => p?.c?.v === 2);
  const of = slot => parts.filter(p => p.c.slot === slot);
  const one = slot => of(slot)[0] ?? null;
  const shipClass = one("shipClass"), material = one("material"), shipType = one("shipType");
  const armor = one("armor"), power = one("power"), prop = one("propulsion");
  // Compartment budget (John, 2026-10-13): 3 x cube root of the ship's tonnage, rounded. Without
  // tonnage, the size class's budget.
  const budget = tons > 0 ? Math.round(3 * Math.cbrt(tons)) : num(shipClass?.c.stats?.compartments);
  const rank = sizeRank(shipClass?.c.id);

  // Row 40 totals.
  const t = Object.fromEntries(SUM_KEYS.map(k => [k, 0]));
  let produced = 0, needed = 0, used = 0, brigBlocks = 0, bonusComp = 0;
  const freeStations = {};
  // Automated descriptor (John, 2026-10-12): the hull maintains itself, so there is no deck crew.
  const automated = hasDescriptor(parts, "Automated");
  for ( const p of parts ) {
    const n = Math.max(1, num(p.qty) || 1);
    const q = (NO_QTY.has(p.c.slot) || REDUNDANT.has(p.c.slot)) ? 1 : n;
    if ( p.c.brig ) brigBlocks += n;
    // Stations: no crew; the first of each role is free, extra ones pay space and cost.
    const role = p.c.stationRoles?.[0];
    let paid = q;
    if ( role ) {
      const free = (freeStations[role] ??= 1);
      paid = Math.max(0, q - free);
      freeStations[role] = Math.max(0, free - q);
    }
    for ( const k of SUM_KEYS ) {
      let v = (k === "power") ? partPower(p.c, budget) : num(p.c.stats?.[k]);
      if ( (k === "crew") && (role || (p.station === "none")) ) continue;
      if ( (k === "crew") && automated && (p.c.slot === "shipClass") ) continue;
      if ( (k === "mt") && REDUNDANT.has(p.c.slot) ) v += REDUNDANT_MT * (n - 1);
      if ( !v ) continue;
      if ( k === "compartments" ) {
        // A fraction is a share of the class budget (-0.125 = 12.5%), rounded up, at least 1.
        if ( (v < 0) && (v > -1) ) v = -Math.max(1, Math.ceil(-v * budget));
        else v = Math.round(v) * (role ? paid : q);
      } else v *= ((k === "cost") && role) ? paid : q;
      t[k] += v;
      if ( k === "power" ) { if ( v > 0 ) produced += v; else needed -= v; }
      // Cramped (John, 2026-10-12): a positive non-class value adds to the budget instead.
      if ( (k === "compartments") && (p.c.slot !== "shipClass") ) { if ( v > 0 ) bonusComp += v; else used -= v; }
    }
  }
  // Brig blocks are run by 0.5 crew each, rounded down (one block needs no extra crew).
  const brigCrew = Math.floor(brigBlocks * 0.5);
  t.crew += brigCrew;

  // Abilities (rows 45-50).
  const abilities = { str: t.str, dex: t.dex, con: t.con, int: t.int, wis: t.wis, cha: t.cha };
  // Armor DEX cap (row 51): the armor's Max DEX score, 99 without armor.
  const maxDex = armor ? (num(armor.c.info?.["Max DEX"]) || 99) : 99;
  const ac = t.ac + Math.min(mod(t.dex), mod(maxDex));                      // row 52
  const hitDie = num(shipClass?.c.stats?.hitDie), hitDice = num(shipClass?.c.stats?.hitDice);
  // Descriptor HP is a percentage of the hull's HP (John, 2026-10-12): Light -10%, Beefy +20%, ...
  // At least 1 HP per Hit Die.
  const baseHp = t.hpBonus + hitDie + (hitDice - 1) * (hitDie / 2 + 0.5) + hitDice * mod(t.con);
  const hp = Math.max(Math.max(1, hitDice), round(baseHp * (1 + t.hpPct)));  // row 57

  // Possible Mishaps: the ship type's list plus every installed component's list.
  const mishapNames = [...new Set(parts.flatMap(p => p.c.mishaps ?? []).map(m => MISHAP_ALIASES[m] ?? m))]
    .sort((a, b) => a.localeCompare(b));

  // Stations (crew cards): one per installed station, per quantity, with where it sits.
  const stations = [];
  // Deck crew (the hull's own crew: maintenance, damage control, watches): one card for all of them.
  const deck = automated ? 0 : num(shipClass?.c.stats?.crew);
  if ( deck > 0 ) stations.push({ roles: ["deck"], name: "Deck Crew", itemId: null, location: null, facing: null, count: deck });
  // Cook, Medic: crewed Galleys and Medical Bays.
  for ( const p of of("habitat") ) {
    if ( !needsSeat(p.c) || p.station === "none" ) continue;
    for ( let i = 0; i < Math.max(1, num(p.qty) || 1); i++ ) {
      stations.push({ roles: [p.c.seatRole], name: p.name, itemId: p.id ?? null, location: "habitat", facing: null });
    }
  }
  for ( const p of of("habitat") ) {
    const roles = p.c.stationRoles;
    if ( !roles?.length ) continue;
    const location = stationLocation(p.location, p.facing, roles[0]);
    for ( let i = 0; i < Math.max(1, num(p.qty) || 1); i++ ) {
      stations.push({ roles: [...roles], name: p.name, itemId: p.id ?? null, location,
        facing: roles.includes("gunner") && FACINGS.includes(location) ? location : null });
    }
  }

  // Combat check (rows 75-82), single shots only.
  const dmgPerRound = of("weapon").reduce((s, p) => s + Math.max(1, num(p.qty) || 1) * avgDamage(p.c.info?.Damage), 0);
  const expected = dmgPerRound * hitChance;
  const baselineHp = num(shipClass?.c.info?.["Average HP"]);
  const deflectorHit = Math.max(0.05, hitChance - 0.25);
  const combat = {
    hitChance, dmgPerRound, expected, baselineHp,
    roundsBaseline: expected > 0 ? Math.ceil(baselineHp / expected) : null,
    roundsCopy: expected - t.ablativeRegen > 0 ? Math.ceil((hp + t.ablativeHp) / (expected - t.ablativeRegen)) : null,
    roundsCopyDeflector: t.shieldAc && (dmgPerRound * deflectorHit - t.ablativeRegen > 0)
      ? Math.ceil((hp + t.ablativeHp) / (dmgPerRound * deflectorHit - t.ablativeRegen)) : null
  };

  // Ammo (John, 2026-10-12): an Ammunition Magazine of a size holds 12 units of that size; a missile
  // uses 6, a ballistic round 1. Ammo weapons fire straight from the magazines of their own size.
  const ammo = { capacity: {}, weapons: {} };
  for ( const p of parts ) {
    if ( p.c.magazine?.size ) ammo.capacity[p.c.magazine.size] = (ammo.capacity[p.c.magazine.size] ?? 0)
      + MAGAZINE_UNITS * Math.max(1, num(p.qty) || 1);
    if ( p.c.ammo?.size && p.id ) ammo.weapons[p.id] = { size: p.c.ammo.size, cost: p.c.ammo.cost, name: p.name };
  }
  // Missile Racks (John, 2026-10-12): a rack holds its loaded volleys (Tiny 3, others 2); a Missile
  // Rack Magazine of the same size holds that many more.
  ammo.racks = {};
  for ( const p of parts ) {
    const n = Math.max(1, num(p.qty) || 1);
    const size = p.c.rack?.size ?? p.c.rackMagazine?.size;
    if ( !size ) continue;
    const t = (ammo.racks[size] ??= { racks: 0, loaded: 0, reloads: 0 });
    if ( p.c.rack ) { t.racks += n; t.loaded += n * num(p.c.rack.volleys); }
    else t.reloads += n * num(p.c.rackMagazine.volleys);
  }
  // Torpedoes (John, 2026-10-12): a launcher holds its loaded torpedoes; a Torpedo Magazine of the same
  // size holds 1 reload (a tube plus one magazine = 2 shots).
  ammo.torpedoes = {};
  for ( const p of parts ) {
    const n = Math.max(1, num(p.qty) || 1);
    const size = p.c.launcher?.class ?? p.c.torpedoMagazine?.size;
    if ( !size ) continue;
    const t = (ammo.torpedoes[size] ??= { launchers: 0, loaded: 0, reloads: 0 });
    if ( p.c.launcher ) { t.launchers += n; t.loaded += n * num(p.c.launcher.tubes); }
    else t.reloads += n;
  }

  // Speed (John, 2026-10-13): the geometric mean of the hull's Ship Speed and the propulsion's speed,
  // then materials and descriptors. Ship Speed = 22 - DR/2 (at least 1), DR = round(log1.3 tons),
  // which replaces the size class's speed. Without tonnage the old sum is kept.
  let speed = t.speed, speedParts = null;
  if ( tons > 0 && prop ) {
    const dr = Math.round(Math.log(tons) / Math.log(1.3));
    const shipSpeed = Math.max(1, 22 - dr / 2);
    const propSpeed = num(prop.c.stats?.speed);
    // Descriptors (John, 2026-10-13) can add at most half the ship's DEX modifier (rounded down, at
    // least 1); penalties aren't capped. Materials and other parts add as listed.
    const descSpeed = of("descriptor").reduce((a, p) => a + num(p.c.stats?.speed), 0);
    const cap = Math.max(1, Math.floor(mod(t.dex) / 2));
    const desc = Math.min(descSpeed, cap);
    const other = t.speed - num(shipClass?.c.stats?.speed) - propSpeed - descSpeed;
    const base = Math.round(Math.sqrt(shipSpeed * Math.max(0, propSpeed)));
    speed = base + other + desc;
    speedParts = { dr, shipSpeed, propSpeed, base, other, descriptors: descSpeed, cap, applied: desc };
  }

  const sizeName = String(shipClass?.c.id ?? "").replace(/^\d+-/, "");
  const typeName = shipType?.name ?? "";
  const movementKey = /^Ship$/i.test(typeName) ? "swim" : "fly";

  const s = {
    sizeRank: rank, sizeName, dndSize: DND_SIZE[sizeName] ?? "med", tons,
    abilities, ac, acDeflector: ac + t.shieldAc, shieldCharges: t.shieldCharges,
    hitDie, hitDice, hp, ablativeHp: t.ablativeHp, ablativeRegen: t.ablativeRegen,
    mt: t.mt, speed, speedParts, cost: t.cost,
    dims, crew: t.crew, troops: Math.max(0, Number(troops) || 0), passengers: t.passengers, berths: t.berths, cargo: t.cargo, prisoners: t.prisoners, brigCrew,
    compartments: { budget: budget + bonusComp, used, left: budget + bonusComp - used },
    power: { produced, needed, net: t.power },
    acrobatics: armor ? String(armor.c.info?.Acrobatics ?? "") : "",
    mishapNames, stations, combat, movementKey, ammo,
    detailsType: movementKey === "swim" ? "water" : (/air|dirig/i.test(typeName) ? "air" : "space"),
    description: describeShip({ shipClass, material, descriptors: of("descriptor"), power, prop, shipType })
  };
  s.checks = checkShip(s, parts, { armor, maxDex });
  return s;
}

/** "Medium speedy steel fusion-powered ion drive starship" in Title Case. */
function describeShip({ shipClass, material, descriptors, power, prop, shipType }) {
  const words = [];
  if ( shipClass ) words.push(String(shipClass.c.id).replace(/^\d+-/, "") + ",");
  for ( const d of descriptors ) words.push(`${d.name},`);
  if ( material ) words.push((material.c.info?.["Ship Adjective"] || material.name) + ",");
  if ( power ) words.push(`${power.c.info?.["Descriptive Name"] || power.name}-powered,`);
  if ( prop ) words.push(prop.c.info?.["Desc Name"] || prop.name);
  words.push(shipType?.name ?? "vessel");
  return words.join(" ").replace(/,(\s*)$/, "$1").toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, a, b) => a + b.toUpperCase());
}

/**
 * Draft checks (rows 67-72 plus the Component Categories tab). Warnings only: nothing is blocked.
 * @returns {Array<{key: string, ok: boolean, label: string, detail: string}>}
 */
/** Does the design carry this descriptor (by name)? */
export function hasDescriptor(parts, name) {
  const want = String(name).toLowerCase();
  return parts.some(p => (p.c.slot === "descriptor") && (String(p.c.info?.Descriptor ?? p.name ?? "").toLowerCase() === want));
}

export function checkShip(s, parts, { armor, maxDex } = {}) {
  const has = slot => parts.some(p => p.c.slot === slot);
  const habitats = parts.filter(p => p.c.slot === "habitat");
  const c = [];
  const add = (key, ok, label, detail = "") => c.push({ key, ok: !!ok, label, detail });

  add("shipClass", has("shipClass"), "Size", has("shipClass") ? `${s.sizeName}${s.tons ? ` (${s.tons.toLocaleString()} tons)` : ""}` : "Enter keel, beam and draft: size, Hit Dice and compartments come from them");
  add("compartments", s.compartments.left >= 0, "Compartments",
    `${s.compartments.left >= 0 ? `${s.compartments.left} left` : `OVER by ${-s.compartments.left}`} (budget ${s.compartments.budget}, used ${s.compartments.used})`);
  add("power", s.power.net >= 0, "Power",
    `${s.power.net >= 0 ? `${s.power.net} spare` : `OVER by ${-s.power.net}`} (produced ${s.power.produced}, needed ${s.power.needed})`);
  // Short Range (John, 2026-10-12): the crew doesn't live aboard, so no berths or habitat are needed.
  const shortRange = hasDescriptor(parts, "Short Range");
  // Embarked troops (John, 2026-10-13) need berths too: crew + troops.
  const aboard = s.crew + (s.troops ?? 0), who = s.troops ? `crew ${s.crew} + troops ${s.troops}` : `crew ${s.crew}`;
  add("berths", shortRange || (s.berths - aboard >= 0), "Berths", shortRange ? "Not needed (Short Range)" :
    `${s.berths - aboard >= 0 ? "OK" : `SHORT by ${aboard - s.berths}`} (berths ${s.berths}, ${who})`);
  const strReq = armor ? num(armor.c.info?.["STR Req"]) : 0;
  add("armorStr", !strReq || s.abilities.str >= strReq, "Armor STR",
    strReq ? `needs STR ${strReq}, ship STR ${s.abilities.str}${s.abilities.str >= strReq ? "" : " (UNDER: Speed penalty)"}` : "no requirement");
  // Warheads (John, 2026-10-12) are sized by torpedo class, not hull: all three fit a Tiny torpedo.
  const tooBig = parts.filter(p => ["weapon", "deflector", "ablative"].includes(p.c.slot) && !["Warhead", "Launcher"].includes(p.c.info?.Delivery))
    .filter(p => { const i = SIZE_ORDER.indexOf(p.c.size ?? p.c.info?.Size); return (i < 0 ? 99 : i + 1) > s.sizeRank + 1; });
  add("tooBig", !tooBig.length, "Part sizes",
    tooBig.length ? `TOO BIG for a ${s.sizeName || "ship"}: ${tooBig.map(p => p.name).join(", ")} (weapons and shields: up to one size above the ship)` : "OK");

  // Component Categories tab (draft): required systems.
  const isStation = p => p.c.stationRoles !== undefined;
  const required = [
    ["Habitat", habitats.some(p => !isStation(p)), "crew quarters, life support or passenger space"],
    ["Command & Control", has("nexus") || has("comms") || habitats.some(p => p.c.hudSystem === "command"), "a bridge station, Nexus Core or Communications"],
    ["Navigation", has("sensory") || habitats.some(p => p.c.hudSystem === "navigation"), "Sensory Gear or a sensors station"],
    ["Power Systems", has("power"), "a Power Source"],
    ["Propulsion", has("propulsion"), "a Propulsion system"]
  ];
  if ( shortRange ) required[0][1] = "short";
  for ( const [label, ok, what] of required ) add(`req-${label}`, ok, label, ok === "short" ? "Not needed (Short Range)"
    : ok ? "OK" : `Missing: needs ${what} (Component Categories, draft)`);

  // Line limits and weapon facings.
  for ( const [slot, def] of Object.entries(SLOT_DEFS) ) {
    // Stations don't use Habitat lines (they come with the systems).
    const n = parts.filter(p => p.c.slot === slot && !p.c.stationRoles?.length).length;
    if ( n > def.max ) add(`max-${slot}`, false, def.label, `${n} lines; the Design Studio has room for ${def.max}`);
  }
  // Torpedo launchers have a smallest ship they can be mounted on (John, 2026-10-12).
  const launchers = parts.filter(p => p.c.launcher);
  if ( launchers.length ) {
    const small = launchers.filter(p => s.sizeRank < SIZE_ORDER.indexOf(p.c.launcher.minShip) + 1);
    add("launchers", !small.length, "Torpedo launchers", small.length
      ? `Too big for a ${s.sizeName || "ship"}: ${small.map(p => `${p.name} (needs ${p.c.launcher.minShip} or larger)`).join(", ")}`
      : launchers.map(p => `${p.name}: ${p.c.launcher.tubes} torpedo${p.c.launcher.tubes > 1 ? "es" : ""} loaded`).join(", "));
  }
  // SIF Container Bays (John, 2026-10-13): containers lie across the hull, side by side down the keel.
  const sifN = parts.filter(p => p.c.sif).reduce((a, p) => a + Math.max(1, num(p.qty) || 1), 0);
  if ( sifN ) {
    // Layers (John, 2026-10-13): containers can be stacked above and below the spine.
    const d = s.dims ?? {}, layers = Math.max(1, num(d.sifLayers) || 1), perRow = Math.ceil(sifN / layers);
    const need = { beam: 30, draft: 10 * layers, keel: 10 * perRow };
    const short = d.keel ? Object.entries(need).filter(([k, v]) => num(d[k]) < v).map(([k, v]) => `${k} ${d[k]} ft < ${v} ft`) : [];
    add("sif", !short.length, "SIF containers", short.length ? `${sifN} container${sifN > 1 ? "s" : ""} don't fit: ${short.join(", ")}`
      : `${sifN} container${sifN > 1 ? "s" : ""} (${3 * sifN} blocks)${layers > 1 ? `, ${layers} layers of ${perRow}` : ""}${d.keel ? `, ${need.keel} ft of keel` : ""}`);
  }
  // Missile Rack Magazines need a rack of their size.
  const racks = Object.entries(s.ammo?.racks ?? {});
  if ( racks.length ) {
    const orphan = racks.filter(([, t]) => t.reloads && !t.racks).map(([z]) => z);
    add("racks", !orphan.length, "Missile racks", orphan.length
      ? `No ${orphan.join("/")} Missile Rack for the ${orphan.join("/")} Missile Rack Magazine${orphan.length > 1 ? "s" : ""}`
      : racks.map(([z, t]) => `${z}: ${t.loaded} volley${t.loaded === 1 ? "" : "s"} loaded + ${t.reloads} in magazines`).join(", "));
  }
  // Torpedo Magazines need a launcher of their size.
  const torps = Object.entries(s.ammo?.torpedoes ?? {});
  if ( torps.some(([, t]) => t.reloads) ) {
    const orphan = torps.filter(([, t]) => t.reloads && !t.launchers).map(([z]) => z);
    add("torpedoes", !orphan.length, "Torpedoes", orphan.length
      ? `No ${orphan.join("/")} launcher for the ${orphan.join("/")} Torpedo Magazine${orphan.length > 1 ? "s" : ""}`
      : torps.map(([z, t]) => `${z}: ${t.loaded} loaded + ${t.reloads} reload${t.reloads === 1 ? "" : "s"}`).join(", "));
  }
  // Ammo weapons need a magazine of their own size.
  const ammoParts = parts.filter(p => p.c.ammo?.size);
  if ( ammoParts.length ) {
    const cap = s.ammo?.capacity ?? {};
    const missing = ammoParts.filter(p => !cap[p.c.ammo.size]);
    add("ammo", !missing.length, "Ammo", missing.length
      ? `No ${[...new Set(missing.map(p => p.c.ammo.size))].join("/")} Ammunition Magazine for: ${missing.map(p => p.name).join(", ")}`
      : Object.entries(cap).map(([z, u]) => `${z} ${u} units (${Math.floor(u / AMMO_COST.missile)} missiles or ${u} rounds)`).join(", "));
  }
  const noFacing = parts.filter(p => p.c.slot === "weapon" && !FACINGS.includes(p.facing));
  if ( noFacing.length ) add("facing", false, "Facing", `No facing: ${noFacing.map(p => p.name).join(", ")}`);
  const noLoc = parts.filter(p => p.c.stationRoles?.length && !stationLocation(p.location, p.facing, p.c.stationRoles[0]));
  if ( noLoc.length ) add("location", false, "Station location", `Not placed: ${noLoc.map(p => p.name).join(", ")}`);
  const noStation = parts.filter(p => needsStation(p.c) && !p.station);
  if ( noStation.length ) add("stations", false, "Stations", `No station chosen: ${noStation.map(p => p.name).join(", ")} (pick one on the part, or None)`);
  return c;
}
