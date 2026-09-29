// Paradox 5E: link a ship's Possible Mishaps to the mishap actors in the Actors compendium.
//
// Components list mishap keys ("Crew-Injury", "List", "Wind-Sheer", ...). Each compendium mishap
// actor lists the keys it answers to in flags["fvtt-neon-odyssey"].mishap.types, and its tier in
// .tier (Minor, Standard, Major, Critical, Catastrophic).
//
// Severity follows Strain: the number of times Strain has passed the ship's Mishap Threshold.
//   1 pass = Minor, 2 = Standard, 3 = Major, 4 = Critical, 5 or more = Catastrophic.
// Strain is the bridge's "Strain" drawing when the ship is on the current scene's viewscreen,
// otherwise the ship's lost hit points (max HP minus current HP).

import { readStat, shipActor } from "./crew-stations.mjs";

const MODULE_ID = "fvtt-neon-odyssey";
const PACK_ID = `${MODULE_ID}.actors`;
export const MISHAP_TIERS = ["Minor", "Standard", "Major", "Critical", "Catastrophic"];

let cache = null;

/**
 * Map of mishap key -> { name, tiers: [uuid x5] } built from the Actors compendium index.
 * @returns {Promise<Map<string, {name: string, tiers: string[]}>>}
 */
export async function mishapIndex() {
  if ( cache ) return cache;
  const pack = game.packs.get(PACK_ID);
  const map = new Map();
  if ( !pack ) return (cache = map);
  const index = await pack.getIndex({ fields: [`flags.${MODULE_ID}.mishap`] });
  for ( const e of index ) {
    const m = e.flags?.[MODULE_ID]?.mishap;
    const t = MISHAP_TIERS.indexOf(m?.tier);
    if ( !m || t < 0 ) continue;
    for ( const key of m.types ?? [] ) {
      const entry = map.get(key) ?? { name: m.base ?? key, tiers: [] };
      entry.tiers[t] = e.uuid ?? `Compendium.${PACK_ID}.Actor.${e._id}`;
      map.set(key, entry);
    }
  }
  return (cache = map);
}

/** Tier index (0-4) for the number of times Strain has passed the Mishap Threshold. */
export function tierForPasses(passes) {
  return Math.min(4, Math.max(0, (Number(passes) || 0) - 1));
}

/** The ship's current Strain (see header), or null when it can't be determined. */
export function shipStrain(actor) {
  const scene = canvas?.scene;
  if ( scene && shipActor(scene)?.id === actor.id ) {
    const s = readStat(scene, "strain");
    if ( s !== null ) return s;
  }
  const hp = actor.system.attributes?.hp;
  if ( !hp?.max ) return null;
  return Math.max(0, hp.max - (Number(hp.value) || 0));
}

/** Passes of the Mishap Threshold at the ship's current Strain (0 if no threshold). */
export function shipPasses(actor, strain = shipStrain(actor)) {
  const mt = Number(actor.system.attributes?.hp?.mt) || 0;
  return mt > 0 && strain !== null ? Math.floor(strain / mt) : 0;
}

/**
 * The ship's Possible Mishaps at a tier: component keys resolved to compendium actors,
 * plus mishap actors dropped onto the sheet by hand (kept exactly as dropped).
 * @returns {Promise<Array<{uuid: string, name: string, manual: boolean, missing: boolean}>>}
 */
export async function possibleMishaps(actor, tier) {
  const flags = actor.flags[MODULE_ID] ?? {};
  const index = await mishapIndex();
  const out = [];
  for ( const key of flags.mishapNames ?? [] ) {
    const entry = index.get(key);
    const uuid = entry?.tiers[tier] ?? "";
    const doc = uuid ? fromUuidSync(uuid) : null;
    out.push({ uuid, name: doc?.name ?? key, manual: false, missing: !uuid });
  }
  const seen = new Set(out.map(m => m.uuid).filter(Boolean));
  for ( const uuid of flags.mishaps ?? [] ) {
    if ( seen.has(uuid) ) continue;
    const doc = fromUuidSync(uuid);
    out.push({ uuid, name: doc?.name ?? "(missing)", manual: true, missing: !doc });
  }
  return out;
}

/**
 * Roll one of the ship's Possible Mishaps at the tier for `passes`.
 * @returns {Promise<{uuid: string, name: string}|null>}
 */
export async function rollMishap(actor, passes) {
  const list = (await possibleMishaps(actor, tierForPasses(passes))).filter(m => m.uuid && !m.missing);
  if ( !list.length ) return null;
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Chat HTML for the Mishaps gained as Strain rose from `before` to `after`: one rolled mishap
 * per threshold passed, each at the tier for that pass, as a link you can drag onto the canvas.
 */
export async function mishapAlert(actor, before, after) {
  const mt = Number(actor?.system.attributes?.hp?.mt) || 0;
  if ( !actor || mt <= 0 || after <= before ) return "";
  const from = Math.floor(before / mt), to = Math.floor(after / mt);
  if ( to <= from ) return "";
  const lines = [];
  for ( let p = from + 1; p <= to; p++ ) {
    const m = await rollMishap(actor, p);
    const what = m ? `@UUID[${m.uuid}]{${m.name}}` : "no Possible Mishaps on this ship; roll one yourself";
    lines.push(`Strain passed ${p * mt}: ${what}`);
  }
  return `<p class="no-crew-alert"><strong>MISHAP${lines.length > 1 ? ` ×${lines.length}` : ""}!</strong>
    (Mishap Threshold ${mt})<br>${lines.join("<br>")}</p>`;
}

// Keep the index current and re-render open ship sheets when Strain changes.
Hooks.on("updateCompendium", pack => { if ( pack.collection === PACK_ID ) cache = null; });
for ( const h of ["createActor", "updateActor", "deleteActor"] ) {
  Hooks.on(h, doc => { if ( doc.pack === PACK_ID ) cache = null; });
}
Hooks.on("updateDrawing", (drawing, changes) => {
  if ( !("text" in changes) ) return;
  if ( !(drawing.flags?.tagger?.tags ?? []).some(t => String(t).toLowerCase() === "strain") ) return;
  const ship = shipActor(drawing.parent);
  if ( ship?.sheet?.rendered ) ship.sheet.render();
});
