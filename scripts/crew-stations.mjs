// Crew Stations: bridge-scene automation for Paradox 5E starship combat.
//
//  * Regions on a bridge scene flagged  flags["fvtt-neon-odyssey"].station = "<role>"
//    grant that role's Crew Role feature (plus "Any Station") to any character whose
//    token stands in them, and remove it again when the token leaves.
//  * Using a Crew Role action spends Tempo (or 2 Strain per Tempo when out) from the
//    Tagger-tagged "Tempo" / "Strain" drawings on the scene, and announces Mishaps.
//
// All document changes are made by the active GM's client only. Players never need
// permission on the drawings: their usage/roll chat cards are the request, and the GM
// client reacts to them in createChatMessage.

import { mishapAlert } from "./mishap-links.mjs";
const MODULE_ID = "fvtt-neon-odyssey";

/** Gain Tempo: DC = current Tempo, but never below this. */
const GAIN_TEMPO_MIN_DC = 8;
/** Gain Tempo: a success adds the skill's proficiency, but never less than this. */
const GAIN_TEMPO_MIN_GAIN = 1;
const PACK_ID = `${MODULE_ID}.class-features`;
const FEATURE_TYPE = "crewRole";

/** Station key -> compendium item id of its Crew Role feature. */
export const ROLE_ITEMS = {
  any:       "NOcrewRoleAny000",
  commander: "NOcrewRoleCmd000",
  navigator: "NOcrewRoleNav000",
  helmsman:  "NOcrewRoleHelm00",
  gunner:    "NOcrewRoleGun000",
  engineer:  "NOcrewRoleEng000"
};

/**
 * Combined stations (John, 2026-10-11): one station that carries two roles. The crew member
 * standing there gets both roles' Crew Role features (plus Any Station).
 *   Pilot   = Helmsman + Gunner
 *   Copilot = Helmsman + Navigator
 */
export const COMBINED_STATIONS = {
  pilot:   ["helmsman", "gunner"],
  copilot: ["helmsman", "navigator"]
};

/** Role keys a station flag grants: itself, or the roles of a combined station. */
const rolesForStation = key => COMBINED_STATIONS[key] ?? (ROLE_ITEMS[key] ? [key] : []);

const isActiveGM = () => game.users.activeGM?.isSelf ?? false;

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

Hooks.once("init", () => {
  CONFIG.DND5E.featureTypes[FEATURE_TYPE] = { label: "Crew Role" };
  game.modules.get(MODULE_ID).crew = { reconcileScene, reconcileActor, readStat, applyCost, adjustStat, resetStats, crewOnStations, syncSpeed, radarCenterShip, shipSpeed, adjustSpeed, steerForward, steerTurn, ROLE_ITEMS, COMBINED_STATIONS };
});

/* -------------------------------------------- */
/*  Scene helpers                               */
/* -------------------------------------------- */

/**
 * A document's Tagger tags, lower-cased. Tagger stores a list, but documents whose tag box was
 * cleared can hold an empty or comma-separated string instead.
 */
export function tagsOf(doc) {
  const t = doc?.flags?.tagger?.tags;
  if ( Array.isArray(t) ) return t.map(x => String(x).trim().toLowerCase());
  if ( typeof t === "string" ) return t.split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  return [];
}

/** The drawing on a scene tagged with the given Tagger tag (case-insensitive). */
function statDrawing(scene, tag) {
  tag = tag.toLowerCase();
  return scene?.drawings.find(d => tagsOf(d).includes(tag));
}

/** Current numeric value of the "Tempo" or "Strain" drawing, or null if there isn't one. */
export function readStat(scene, tag) {
  const d = statDrawing(scene, tag);
  if ( !d ) return null;
  const n = parseInt(String(d.text ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The crew's ship on this bridge scene: the vehicle token standing on the Viewscreen region.
 * Its max HP sets the Strain gauge, its Mishap Threshold the Mishap alerts, its max HP the
 * Disabled alert. Ships on the radar never count. With no ship on the viewscreen there is no
 * ship (the gauge stays as it is and no Mishap/Disabled alerts are posted).
 */
export function shipActor(scene) {
  if ( !scene ) return null;
  const vehicles = scene.tokens.filter(t => t.actor?.type === "vehicle");
  const onView = vehicles.filter(t => inFlaggedRegion(t, "viewscreen"));
  // Prefer a ship the module placed on the viewscreen, then any other ship standing on it.
  const token = onView.find(t => t.getFlag(MODULE_ID, "viewSize")) ?? onView[0];
  return token?.actor ?? null;
}

/** Whether a point lies inside a tile's (possibly rotated) rectangle. */
function pointInTile(tile, { x, y }) {
  const w = Math.abs(tile.width), h = Math.abs(tile.height);
  const cx = tile.x + w / 2, cy = tile.y + h / 2;
  const a = -Math.toRadians(tile.rotation ?? 0);
  const dx = x - cx, dy = y - cy;
  const rx = dx * Math.cos(a) - dy * Math.sin(a);
  const ry = dx * Math.sin(a) + dy * Math.cos(a);
  return (Math.abs(rx) <= w / 2) && (Math.abs(ry) <= h / 2);
}

/** Role keys granted by every station (region or tile) that contains this token's center.
 *  A combined station (Pilot, Copilot) contributes both of its roles. */
function stationsForToken(tokenDoc, pos = {}) {
  const scene = tokenDoc.parent;
  const out = new Set();
  if ( !scene ) return out;
  const size = scene.grid.size;
  // During updateToken in v13 the document can still report its pre-move position,
  // so callers pass the new coordinates from the change data.
  // Stored values, not the getters: while a token animates (or forever, in a hidden browser tab,
  // where animation is paused) the getters report the in-between position and size.
  const src = tokenDoc._source;
  const x = pos.x ?? src.x;
  const y = pos.y ?? src.y;
  const point = {
    x: x + (src.width * size) / 2,
    y: y + (src.height * size) / 2,
    elevation: pos.elevation ?? src.elevation ?? 0
  };
  for ( const region of scene.regions ) {
    const roles = rolesForStation(region.getFlag(MODULE_ID, "station"));
    if ( !roles.length ) continue;
    let inside = false;
    try { inside = region.testPoint(point); }
    catch(err) { inside = region.testPoint({ x: point.x, y: point.y }, point.elevation); }
    if ( inside ) for ( const r of roles ) out.add(r);
  }
  // Tiles flagged as stations count the same as regions (Token Attacher can carry tiles, not
  // regions). The tile's rectangle, rotated with the tile, is the station area.
  for ( const tile of scene.tiles ) {
    const roles = rolesForStation(tile.getFlag(MODULE_ID, "station"));
    if ( !roles.length ) continue;
    if ( pointInTile(tile, point) ) for ( const r of roles ) out.add(r);
  }
  return out;
}

/* -------------------------------------------- */
/*  Granting and removing Crew Role features    */
/* -------------------------------------------- */

// GM-side work is serialized so overlapping moves can't create duplicates.
let queue = Promise.resolve();
const enqueue = fn => (queue = queue.then(fn).catch(err => console.error(`${MODULE_ID} | crew stations`, err)));

/** Size of a token while it stands on a station, in grid squares. */
const STATION_SIZE = 2;

/** Resolve once a token has finished moving (document movement and on-screen animation). */
async function waitForMovement(tokenDoc) {
  for ( let i = 0; i < 100; i++ ) {
    const state = tokenDoc.movement?.state;
    if ( !state || (state === "completed") || (state === "stopped") ) break;
    await new Promise(r => setTimeout(r, 100));
  }
  // The on-screen animation never finishes while this browser tab is hidden (the browser pauses
  // animation), so don't wait for it then, and never wait more than 2 seconds for it.
  if ( document.visibilityState === "hidden" ) return;
  const animation = tokenDoc.object?.movementAnimationPromise;
  if ( !animation ) return;
  try {
    await Promise.race([animation, new Promise(r => setTimeout(r, 2000))]);
  } catch(err) { /* animation was cancelled */ }
}

/**
 * Grow a token to 2x2 when it steps onto a station and put it back when it leaves.
 * The original size is kept on the token so it can be restored exactly.
 */
async function syncTokenSize(tokenDoc, onStation) {
  const saved = tokenDoc.getFlag(MODULE_ID, "stationSize");
  if ( onStation === !!saved ) return;
  // In v13, updating a token while its move is still in progress stops the move partway.
  await waitForMovement(tokenDoc);
  if ( onStation && !saved ) {
    await tokenDoc.update({
      width: STATION_SIZE, height: STATION_SIZE,
      [`flags.${MODULE_ID}.stationSize`]: { width: tokenDoc._source.width, height: tokenDoc._source.height }
    });
  } else if ( !onStation && saved ) {
    await tokenDoc.update({
      width: saved.width ?? 1, height: saved.height ?? 1,
      [`flags.${MODULE_ID}.-=stationSize`]: null
    });
  }
}

/** Make one actor's Crew Role items match the stations its tokens stand on in this scene. */
export async function reconcileActor(actor, scene, moved = null) {
  if ( !actor || !scene || !["character", "npc"].includes(actor.type) ) return;
  const tokens = actor.isToken ? [actor.token] : scene.tokens.filter(t => t.actorId === actor.id && t.actorLink);
  const wanted = new Set();
  for ( const t of tokens ) {
    const pos = (moved && moved.id === t.id) ? moved : {};
    const here = stationsForToken(t, pos);
    for ( const k of here ) wanted.add(k);
    await syncTokenSize(t, here.size > 0);
  }
  if ( wanted.size ) wanted.add("any");

  const owned = actor.items.filter(i => i.getFlag(MODULE_ID, "crewRole"));
  const toDelete = owned.filter(i => !wanted.has(i.getFlag(MODULE_ID, "crewRole"))).map(i => i.id);
  const have = new Set(owned.map(i => i.getFlag(MODULE_ID, "crewRole")));
  const missing = [...wanted].filter(k => !have.has(k));

  if ( toDelete.length ) await actor.deleteEmbeddedDocuments("Item", toDelete);
  if ( missing.length ) {
    const pack = game.packs.get(PACK_ID);
    const docs = await Promise.all(missing.map(k => pack?.getDocument(ROLE_ITEMS[k])));
    const data = docs.filter(Boolean).map(d => {
      const obj = game.items.fromCompendium(d, { keepId: false });
      foundry.utils.setProperty(obj, "flags.core.sourceId", d.uuid);
      foundry.utils.setProperty(obj, `flags.${MODULE_ID}.crewRole`, d.getFlag(MODULE_ID, "crewRole"));
      return obj;
    });
    if ( data.length ) await actor.createEmbeddedDocuments("Item", data);
  }
}

/** Reconcile every character and NPC token on a scene. */
export async function reconcileScene(scene = canvas.scene) {
  if ( !scene ) return;
  const seen = new Set();
  for ( const t of scene.tokens ) {
    const actor = t.actor;
    if ( !actor || seen.has(actor.uuid) ) continue;
    seen.add(actor.uuid);
    await reconcileActor(actor, scene);
  }
}

const sceneHasStations = scene => !!scene && (scene.regions.some(r => r.getFlag(MODULE_ID, "station"))
  || scene.tiles.some(t => t.getFlag(MODULE_ID, "station")));
const sceneHasFlag = (scene, flag) => !!scene && (scene.regions.some(r => r.getFlag(MODULE_ID, flag))
  || scene.tiles.some(t => t.getFlag(MODULE_ID, flag)));
const sceneHasRadar = scene => sceneHasFlag(scene, "radar");
const sceneHasViewscreen = scene => sceneHasFlag(scene, "viewscreen");

/* -------------------------------------------- */
/*  Radar                                       */
/* -------------------------------------------- */

/** Size of a ship token on the radar, in grid squares. */
const RADAR_SIZE = 0.5;

/** Radar glow colors by token disposition: [base color, oscillation color]. */
const RADAR_COLORS = {
  hostile:  [0xDD3333, 0xFF9090],
  neutral:  [0xC8C8C8, 0xFFFFFF],
  friendly: [0x5099DD, 0x90EEFF]
};

/**
 * Token Magic glow for a ship on the radar (John's filter settings), colored by disposition:
 * hostile red, neutral white, friendly blue. Secret tokens glow white so they don't give themselves away.
 */
function radarGlow(tokenDoc) {
  const D = CONST.TOKEN_DISPOSITIONS;
  const key = tokenDoc.disposition === D.HOSTILE ? "hostile"
    : tokenDoc.disposition === D.FRIENDLY ? "friendly" : "neutral";
  const [c1, c2] = RADAR_COLORS[key];
  return [{
    filterType: "glow",
    filterId: "superSpookyGlow",
    outerStrength: 4,
    innerStrength: 0,
    color: c1,
    quality: 0.5,
    padding: 10,
    animated: {
      color: { active: true, loopDuration: 3000, animType: "colorOscillation", val1: c1, val2: c2 }
    }
  }];
}

/** Whether a token's center is inside any region carrying the given module flag. */
function inFlaggedRegion(tokenDoc, flag) {
  const scene = tokenDoc.parent;
  if ( !scene ) return false;
  const size = scene.grid.size;
  // _source holds the stored values; during an animation the document reports in-between ones.
  const src = tokenDoc._source;
  const point = {
    x: src.x + (src.width * size) / 2,
    y: src.y + (src.height * size) / 2,
    elevation: src.elevation ?? 0
  };
  const inRegion = scene.regions.some(region => {
    if ( !region.getFlag(MODULE_ID, flag) ) return false;
    try { return region.testPoint(point); }
    catch(err) { return region.testPoint({ x: point.x, y: point.y }, point.elevation); }
  });
  if ( inRegion ) return true;
  // Tiles carrying the flag (Token Attacher HUD widgets) count too. The radar's area is the circle
  // (ellipse) inside the tile, scaled by the tile's optional areaScale flag; others are rectangles.
  return scene.tiles.some(tile => tile.getFlag(MODULE_ID, flag)
    && ((flag === "radar") ? pointInTileEllipse(tile, point) : pointInTile(tile, point)));
}

/** Whether a point lies inside the ellipse inscribed in a tile, scaled by flags.areaScale. */
function pointInTileEllipse(tile, { x, y }) {
  const scale = Number(tile.getFlag(MODULE_ID, "areaScale")) || 1;
  const rx = (Math.abs(tile.width) / 2) * scale, ry = (Math.abs(tile.height) / 2) * scale;
  if ( !rx || !ry ) return false;
  const cx = tile.x + Math.abs(tile.width) / 2, cy = tile.y + Math.abs(tile.height) / 2;
  const a = -Math.toRadians(tile.rotation ?? 0);
  const dx = x - cx, dy = y - cy;
  const px = dx * Math.cos(a) - dy * Math.sin(a), py = dx * Math.sin(a) + dy * Math.cos(a);
  return ((px * px) / (rx * rx)) + ((py * py) / (ry * ry)) <= 1;
}

/** Center of the first region carrying the given module flag (from its first shape). */
function flaggedRegionCenter(scene, flag) {
  const tile = scene?.tiles.find(t => t.getFlag(MODULE_ID, flag));
  if ( tile && !scene.regions.some(r => r.getFlag(MODULE_ID, flag)) ) {
    return { x: tile.x + Math.abs(tile.width) / 2, y: tile.y + Math.abs(tile.height) / 2 };
  }
  const region = scene?.regions.find(r => r.getFlag(MODULE_ID, flag));
  const sh = region?.shapes[0];
  if ( !sh ) return null;
  if ( sh.type === "ellipse" ) return { x: sh.x, y: sh.y };
  if ( sh.type === "rectangle" ) return { x: sh.x + sh.width / 2, y: sh.y + sh.height / 2 };
  const b = region.object?.bounds;
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
}

async function enterRadar(tokenDoc) {
  const grid = tokenDoc.parent.grid.size;
  const src = tokenDoc._source;
  await tokenDoc.update({
    x: src.x + ((src.width - RADAR_SIZE) * grid) / 2,
    y: src.y + ((src.height - RADAR_SIZE) * grid) / 2,
    width: RADAR_SIZE, height: RADAR_SIZE,
    [`flags.${MODULE_ID}.radarSize`]: { width: src.width, height: src.height }
  }, { animate: false, neonOdysseyResize: true });
  if ( globalThis.TokenMagic ) await TokenMagic.addUpdateFilters(tokenDoc, radarGlow(tokenDoc));
}

async function leaveRadar(tokenDoc) {
  const saved = tokenDoc.getFlag(MODULE_ID, "radarSize") ?? {};
  const grid = tokenDoc.parent.grid.size;
  const src = tokenDoc._source;
  const w = saved.width ?? 1;
  const h = saved.height ?? 1;
  await tokenDoc.update({
    x: src.x + ((src.width - w) * grid) / 2,
    y: src.y + ((src.height - h) * grid) / 2,
    width: w, height: h,
    [`flags.${MODULE_ID}.-=radarSize`]: null
  }, { animate: false, neonOdysseyResize: true });
  if ( globalThis.TokenMagic ) await TokenMagic.deleteFilters(tokenDoc);
}

/* -------------------------------------------- */
/*  Viewscreen                                  */
/* -------------------------------------------- */

/** Size of a ship token on the viewscreen, in grid squares. */
const VIEW_SIZE = 10;

async function enterViewscreen(tokenDoc) {
  const grid = tokenDoc.parent.grid.size;
  const src = tokenDoc._source;
  const c = flaggedRegionCenter(tokenDoc.parent, "viewscreen");
  await tokenDoc.update({
    x: c.x - (VIEW_SIZE * grid) / 2,
    y: c.y - (VIEW_SIZE * grid) / 2,
    width: VIEW_SIZE, height: VIEW_SIZE,
    displayName: CONST.TOKEN_DISPLAY_MODES.ALWAYS,
    [`flags.${MODULE_ID}.viewSize`]: { width: src.width, height: src.height, displayName: src.displayName,
      ownershipDefault: await shareShip(tokenDoc.actor) }
  }, { animate: false, neonOdysseyResize: true });
}

/**
 * The ship on the viewscreen is the crew's to look at: every player gets at least Observer on it,
 * so they can open its sheet. Returns the previous default ownership (to restore later), or null
 * if nothing was changed.
 */
async function shareShip(actor) {
  const base = actor?.isToken ? game.actors.get(actor.token?.actorId) : actor;
  if ( !base ) return null;
  const OBSERVER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
  const before = base.ownership?.default ?? CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
  if ( before >= OBSERVER ) return null;
  await base.update({ "ownership.default": OBSERVER });
  return before;
}

/** Put a ship's default ownership back the way it was before it went on the viewscreen. */
async function unshareShip(tokenDoc, saved) {
  if ( !Number.isInteger(saved?.ownershipDefault) ) return;
  const base = game.actors.get(tokenDoc.actorId);
  if ( !base ) return;
  // Another token of the same ship still on a viewscreen keeps it shared.
  const stillShown = game.scenes.some(sc => sc.tokens.some(t => (t.id !== tokenDoc.id)
    && (t.actorId === base.id) && t.getFlag(MODULE_ID, "viewSize")));
  if ( !stillShown ) await base.update({ "ownership.default": saved.ownershipDefault });
}

async function leaveViewscreen(tokenDoc) {
  const saved = tokenDoc.getFlag(MODULE_ID, "viewSize") ?? {};
  const grid = tokenDoc.parent.grid.size;
  const src = tokenDoc._source;
  const w = saved.width ?? 1;
  const h = saved.height ?? 1;
  await tokenDoc.update({
    x: src.x + ((src.width - w) * grid) / 2,
    y: src.y + ((src.height - h) * grid) / 2,
    width: w, height: h,
    displayName: saved.displayName ?? CONST.TOKEN_DISPLAY_MODES.OWNER_HOVER,
    [`flags.${MODULE_ID}.-=viewSize`]: null
  }, { animate: false, neonOdysseyResize: true });
  await unshareShip(tokenDoc, saved);
}

/**
 * Ship display on the bridge scene, run after every ship move:
 *  - Radar: the ship shrinks to a 0.5x0.5 blip around its center and glows by disposition.
 *  - Viewscreen: the ship is centered on the screen at 10x10 with its name always shown.
 *  - Leaving either restores the saved size (around the current center), the name setting,
 *    and (radar) clears Token Magic filters.
 * All "leave" steps run before any "enter" step, so a ship moved straight from one area to
 * the other is back to its real size before the new area saves it.
 */
async function syncShipDisplay(tokenDoc) {
  if ( tokenDoc.actor?.type !== "vehicle" ) return;
  // Once the move has finished, the document holds the final position and size.
  await waitForMovement(tokenDoc);
  const scene = tokenDoc.parent;
  const inRadar = sceneHasRadar(scene) && inFlaggedRegion(tokenDoc, "radar");
  const inView = sceneHasViewscreen(scene) && inFlaggedRegion(tokenDoc, "viewscreen");
  const onRadar = !!tokenDoc.getFlag(MODULE_ID, "radarSize");
  const onView = !!tokenDoc.getFlag(MODULE_ID, "viewSize");
  // If the ship is moved again before we finish, drop this pass: the newer move's hook
  // queues its own pass, and resizing now would snap the ship back to the old spot.
  let moveId = tokenDoc.movement?.id;
  const superseded = () => {
    const m = tokenDoc.movement;
    return !!m && ((m.id !== moveId) || !["completed", "stopped"].includes(m.state));
  };
  // Our own resize updates count as moves too, so re-read the id after each one.
  if ( onRadar && !inRadar ) { if ( superseded() ) return; await leaveRadar(tokenDoc); moveId = tokenDoc.movement?.id; }
  if ( onView && !inView ) { if ( superseded() ) return; await leaveViewscreen(tokenDoc); moveId = tokenDoc.movement?.id; }
  if ( superseded() ) return;
  if ( inView && !onView ) await enterViewscreen(tokenDoc);
  else if ( inRadar && !onRadar ) await enterRadar(tokenDoc);
  // A ship arriving on or leaving the viewscreen changes whose max HP the Strain gauge uses.
  if ( (inView !== onView) ) await syncGauges(scene);
  // A friendly ship arriving at (or leaving) the radar's center sets the Speed display.
  await syncSpeed(scene);
}

/* -------------------------------------------- */
/*  Speed display (radar)                       */
/* -------------------------------------------- */

/** A ship counts as "at the center" when its center is within this fraction of the radar radius
 *  (one range band of five). */
const RADAR_CENTER_FRACTION = 0.2;

/** Center and radius of the scene's radar (a flagged tile, or a flagged ellipse region). */
function radarArea(scene) {
  const tile = scene?.tiles.find(t => t.getFlag(MODULE_ID, "radar"));
  if ( tile ) {
    const scale = Number(tile.getFlag(MODULE_ID, "areaScale")) || 1;
    const w = Math.abs(tile._source.width), h = Math.abs(tile._source.height);
    return { x: tile._source.x + w / 2, y: tile._source.y + h / 2, r: (Math.min(w, h) / 2) * scale };
  }
  const region = scene?.regions.find(r => r.getFlag(MODULE_ID, "radar"));
  const sh = region?.shapes[0];
  if ( sh?.type === "ellipse" ) return { x: sh.x, y: sh.y, r: Math.min(sh.radiusX, sh.radiusY) };
  if ( sh?.type === "circle" ) return { x: sh.x, y: sh.y, r: sh.radius };
  return null;
}

/** The friendly ship at the center of the radar: the friendly vehicle token nearest the center,
 *  within one range band of it. */
export function radarCenterShip(scene) {
  const area = radarArea(scene);
  if ( !area ) return null;
  const grid = scene.grid.size;
  let best = null, bestD = area.r * RADAR_CENTER_FRACTION;
  for ( const t of scene.tokens ) {
    if ( (t.actor?.type !== "vehicle") || (t.disposition !== CONST.TOKEN_DISPOSITIONS.FRIENDLY) ) continue;
    const src = t._source;
    const d = Math.hypot(src.x + (src.width * grid) / 2 - area.x, src.y + (src.height * grid) / 2 - area.y);
    if ( d <= bestD ) { best = t; bestD = d; }
  }
  return best;
}

/** A ship's Speed per round: its designed Speed (or its movement value), minimum 1. */
export function shipSpeed(actor) {
  const f = actor?.flags?.[MODULE_ID] ?? {};
  const key = f.movementKey ?? "fly";
  const raw = Number.isFinite(Number(f.speed)) ? Number(f.speed) : Number(actor?.system?.attributes?.movement?.[key]);
  return Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 1);
}

/**
 * Set the scene's "Speed" drawing to the center ship's Speed. Without `force` it only does so when
 * the center ship has changed (so Speed already spent this round is kept). With no ship at the
 * center the display shows a dash.
 */
export async function syncSpeed(scene = canvas.scene, { force = false } = {}) {
  const drawing = statDrawing(scene, "speed");
  if ( !drawing ) return;
  const ship = radarCenterShip(scene);
  const key = ship?.actor?.uuid ?? null;
  const stored = drawing.getFlag(MODULE_ID, "speedShip") ?? null;
  if ( !force && (key === stored) ) return;
  const text = ship ? String(shipSpeed(ship.actor)) : "\u2014";
  // Setting Speed starts a new pilot turn: the bands moved and facings turned go back to 0.
  await drawing.update({ text, [`flags.${MODULE_ID}.speedShip`]: key,
    [`flags.${MODULE_ID}.steerBands`]: 0, [`flags.${MODULE_ID}.steerFacings`]: 0 });
}

/* -------------------------------------------- */
/*  Steering (radar)                            */
/* -------------------------------------------- */

/** Range bands on the radar, from the center to the rim. */
const RADAR_BANDS = 5;
/** Degrees in one clock facing. */
const FACING_DEGREES = 30;

/**
 * Speed cost of the next step this pilot turn. Range bands double: 1, 2, 4, 8, 16.
 * Clock facings rise by 1: 1, 2, 3, 4, 5, 6.
 */
const nextBandCost = bandsSoFar => 2 ** bandsSoFar;
const nextFacingCost = facingsSoFar => facingsSoFar + 1;

/** GM check plus the scene's Speed drawing; warns and returns null if either is missing. */
function steeringDrawing(scene) {
  if ( !game.user.isGM ) {
    ui.notifications.warn("Steering runs on a GM client.");
    return null;
  }
  const d = statDrawing(scene, "speed");
  if ( !d ) ui.notifications.warn(`No drawing tagged "Speed" on ${scene?.name}.`);
  return d ?? null;
}

/** Raise or lower the Speed display by hand (the radar's Speed buttons). Never below 0. */
export async function adjustSpeed(delta, scene = canvas.scene) {
  const d = steeringDrawing(scene);
  if ( !d ) return;
  return enqueue(async () => {
    const now = readStat(scene, "speed") ?? 0;
    await d.update({ text: String(Math.max(0, now + delta)) });
  });
}

/** Ships shown on the radar, other than the center ship. */
function radarShips(scene, center) {
  return scene.tokens.filter(t => (t.actor?.type === "vehicle") && (t.id !== center?.id)
    && (t.getFlag(MODULE_ID, "radarSize") || inFlaggedRegion(t, "radar")));
}

/** Move a radar ship so its center lands on (x, y), kept inside the radar rim. */
function placeOnRadar(tokenDoc, x, y, area, extra = {}) {
  const grid = tokenDoc.parent.grid.size;
  const src = tokenDoc._source;
  const half = (src.width * grid) / 2;
  // Keep the whole blip inside the rim; ships pushed past it stop at the edge (out of range).
  const maxR = Math.max(0, area.r - half - 2);
  const dx = x - area.x, dy = y - area.y, dist = Math.hypot(dx, dy);
  if ( dist > maxR ) { x = area.x + (dx / dist) * maxR; y = area.y + (dy / dist) * maxR; }
  return { _id: tokenDoc.id, x: Math.round(x - half), y: Math.round(y - (src.height * grid) / 2), ...extra };
}

/** Spend Speed for one step, or warn and return false if there isn't enough. */
async function spendSpeed(d, scene, cost, what) {
  const speed = readStat(scene, "speed") ?? 0;
  if ( speed < cost ) {
    ui.notifications.warn(`${what} costs ${cost} Speed; only ${speed} left.`);
    return false;
  }
  await d.update({ text: String(speed - cost) });
  return true;
}

/**
 * The pilot moves the ship forward one range band. The center ship stays put (it faces the top
 * of the radar), so every other ship on the radar moves one band toward the bottom.
 */
export async function steerForward(scene = canvas.scene) {
  const d = steeringDrawing(scene);
  const area = radarArea(scene);
  if ( !d || !area ) return;
  return enqueue(async () => {
    const bands = Number(d.getFlag(MODULE_ID, "steerBands")) || 0;
    const cost = nextBandCost(bands);
    if ( !(await spendSpeed(d, scene, cost, `Band ${bands + 1} this turn`)) ) return;
    await d.setFlag(MODULE_ID, "steerBands", bands + 1);
    const step = area.r / RADAR_BANDS;
    const grid = scene.grid.size;
    const updates = radarShips(scene, radarCenterShip(scene)).map(t => {
      const src = t._source;
      return placeOnRadar(t, src.x + (src.width * grid) / 2, src.y + (src.height * grid) / 2 + step, area);
    });
    if ( updates.length ) await scene.updateEmbeddedDocuments("Token", updates, { neonOdysseyResize: true });
  });
}

/**
 * The pilot turns the ship one clock facing. "ccw" (counterclockwise) swings every other ship on
 * the radar 30° clockwise around the center, and turns each of them 30° clockwise too; "cw" is the
 * mirror image.
 */
export async function steerTurn(direction, scene = canvas.scene) {
  const d = steeringDrawing(scene);
  const area = radarArea(scene);
  if ( !d || !area ) return;
  return enqueue(async () => {
    const facings = Number(d.getFlag(MODULE_ID, "steerFacings")) || 0;
    const cost = nextFacingCost(facings);
    if ( !(await spendSpeed(d, scene, cost, `Facing ${facings + 1} this turn`)) ) return;
    await d.setFlag(MODULE_ID, "steerFacings", facings + 1);
    const deg = (direction === "cw") ? -FACING_DEGREES : FACING_DEGREES;
    const a = Math.toRadians(deg), cos = Math.cos(a), sin = Math.sin(a);
    const grid = scene.grid.size;
    const updates = radarShips(scene, radarCenterShip(scene)).map(t => {
      const src = t._source;
      const dx = src.x + (src.width * grid) / 2 - area.x, dy = src.y + (src.height * grid) / 2 - area.y;
      return placeOnRadar(t, area.x + dx * cos - dy * sin, area.y + dx * sin + dy * cos, area,
        { rotation: (((src.rotation ?? 0) + deg) % 360 + 360) % 360 });
    });
    if ( updates.length ) await scene.updateEmbeddedDocuments("Token", updates, { neonOdysseyResize: true });
  });
}

/* -------------------------------------------- */
/*  Token hooks                                 */
/* -------------------------------------------- */

function onTokenChange(tokenDoc, changes = {}) {
  if ( !isActiveGM() ) return;
  const scene = tokenDoc.parent;
  const moved = { id: tokenDoc.id, x: changes.x, y: changes.y, elevation: changes.elevation };
  if ( (tokenDoc.actor?.type === "vehicle") && (sceneHasRadar(scene) || sceneHasViewscreen(scene)) ) {
    enqueue(() => syncShipDisplay(tokenDoc));
  }
  if ( !sceneHasStations(scene) ) return;
  const actor = tokenDoc.actor;
  if ( actor ) enqueue(() => reconcileActor(actor, scene, moved));
}

Hooks.on("createToken", tokenDoc => onTokenChange(tokenDoc));
Hooks.on("updateToken", (tokenDoc, changes, options) => {
  if ( options?.neonOdysseyResize ) return;   // our own re-centering after a resize
  // Disposition changed while on the radar: recolor the glow.
  if ( ("disposition" in changes) && isActiveGM() && tokenDoc.getFlag(MODULE_ID, "radarSize") ) {
    const tmfx = globalThis.TokenMagic;
    if ( tmfx ) enqueue(() => tmfx.addUpdateFilters(tokenDoc, radarGlow(tokenDoc)));
  }
  if ( ("x" in changes) || ("y" in changes) || ("elevation" in changes) ) onTokenChange(tokenDoc, changes);
  // A ship at the radar center turning friendly (or not) changes whose Speed is shown.
  if ( ("disposition" in changes) && isActiveGM() && (tokenDoc.actor?.type === "vehicle") ) {
    enqueue(() => syncSpeed(tokenDoc.parent));
  }
});
Hooks.on("deleteToken", tokenDoc => {
  if ( isActiveGM() && (tokenDoc.actor?.type === "vehicle") ) {
    enqueue(() => syncGauges(tokenDoc.parent));
    enqueue(() => syncSpeed(tokenDoc.parent));
    // A ship deleted while on the viewscreen gives back the permission the viewscreen lent.
    const saved = tokenDoc.getFlag(MODULE_ID, "viewSize");
    if ( saved ) enqueue(() => unshareShip(tokenDoc, saved));
  }
  if ( !isActiveGM() || !sceneHasStations(tokenDoc.parent) ) return;
  // A deleted unlinked token takes its synthetic actor with it; only linked actors need cleanup.
  const actor = tokenDoc.actorLink ? game.actors.get(tokenDoc.actorId) : null;
  if ( actor ) enqueue(() => reconcileActor(actor, tokenDoc.parent));
});
Hooks.on("updateRegion", region => {
  if ( isActiveGM() && sceneHasStations(region.parent) ) enqueue(() => reconcileScene(region.parent));
});
// Station tiles: moving, resizing, adding or removing one re-checks every crew member on the scene.
for ( const hook of ["createTile", "updateTile", "deleteTile"] ) {
  Hooks.on(hook, (tile, changes) => {
    if ( !isActiveGM() ) return;
    if ( hook === "updateTile" && !["x", "y", "width", "height", "rotation", "flags"].some(k => k in (changes ?? {})) ) return;
    const flagged = tile.getFlag(MODULE_ID, "station") || foundry.utils.hasProperty(changes ?? {}, `flags.${MODULE_ID}.station`);
    if ( flagged ) enqueue(() => reconcileScene(tile.parent));
  });
}
Hooks.on("canvasReady", () => {
  if ( isActiveGM() && sceneHasStations(canvas.scene) ) enqueue(() => reconcileScene(canvas.scene));
});

/* -------------------------------------------- */
/*  Spending Tempo                              */
/* -------------------------------------------- */

/** Tempo/Strain cost of a Crew Role activity, from the item's flags. */
function costOf(activity) {
  const item = activity?.item;
  if ( !item?.getFlag(MODULE_ID, "crewRole") ) return null;
  return item.getFlag(MODULE_ID, `costs.${activity.id}`) ?? null;
}

// Stamp the cost onto the usage card, so the GM client only needs the message.
Hooks.on("dnd5e.preCreateUsageMessage", (activity, messageConfig) => {
  const cost = costOf(activity);
  if ( !cost ) return;
  // Keep the chat card short: the header names the action and shows its cost and effect
  // (the activity's chat flavor), and the feature's whole table of actions is left out.
  const content = messageConfig.data?.content;
  if ( content ) {
    const div = document.createElement("div");
    div.innerHTML = content;
    const title = div.querySelector(".card-header .name-stacked .title");
    if ( title ) title.textContent = `${activity.name} (${activity.item.name.replace(/^Crew Role:\s*/, "")})`;
    div.querySelector(".card-header .card-content")?.remove();
    div.querySelector(".card-header")?.classList.remove("collapsible");
    div.querySelector(".card-header .fa-chevron-down")?.remove();
    messageConfig.data.content = div.innerHTML;
  }
  foundry.utils.setProperty(messageConfig, `data.flags.${MODULE_ID}.crew`, {
    ...cost,
    action: activity.name,
    role: activity.item.getFlag(MODULE_ID, "crewRole")
  });
});

// Gain Tempo: pick a skill, roll it against DC = current Tempo.
Hooks.on("dnd5e.postUseActivity", async activity => {
  const cost = costOf(activity);
  if ( !cost?.gainTempo ) return;
  const actor = activity.item.actor;
  const scene = canvas.scene;
  const dc = Math.max(GAIN_TEMPO_MIN_DC, readStat(scene, "Tempo") ?? 0);
  const skills = Object.entries(CONFIG.DND5E.skills)
    .map(([k, s]) => `<option value="${k}">${s.label}</option>`).join("");
  const skill = await foundry.applications.api.DialogV2.prompt({
    window: { title: `Gain Tempo (DC ${dc})` },
    content: `<p>Choose a skill and describe how it readies the ship.</p>
      <div class="form-group"><label>Skill</label><select name="skill">${skills}</select></div>`,
    ok: { label: "Roll", callback: (event, button) => button.form.elements.skill.value },
    rejectClose: false
  });
  if ( !skill ) return;
  const prof = Math.max(GAIN_TEMPO_MIN_GAIN, actor.system.skills?.[skill]?.prof?.flat ?? 0);
  await actor.rollSkill({ skill, target: dc }, {}, {
    data: { flags: { [MODULE_ID]: { gainTempo: { dc, prof, sceneId: scene?.id } } } }
  });
});

/**
 * Apply a Tempo/Strain change to the scene's drawings and report it in chat.
 * @param {Scene} scene
 * @param {object} cost      { tempo, strain, strainDelta, tempoGain }
 * @param {object} context   { actor, label }
 */
export async function applyCost(scene, cost, { actor, label } = {}) {
  const tempoD = statDrawing(scene, "Tempo");
  const strainD = statDrawing(scene, "Strain");
  if ( !tempoD || !strainD ) {
    ui.notifications.warn(`${label}: this scene has no drawings tagged "Tempo" and "Strain".`);
    return;
  }
  const tempo0 = readStat(scene, "Tempo");
  const strain0 = readStat(scene, "Strain");
  let tempo = tempo0;
  let strain = strain0;
  const notes = [];

  const need = cost.tempo ?? 0;
  if ( need > 0 ) {
    if ( tempo >= need ) tempo -= need;
    else {
      strain += 2 * need;
      notes.push(`Out of Tempo: paid <strong>${2 * need} Strain</strong> instead of ${need} Tempo.`);
    }
  }
  tempo += cost.tempoGain ?? 0;
  strain += (cost.strain ?? 0) + (cost.strainDelta ?? 0);
  strain = Math.max(0, strain);
  tempo = Math.max(0, tempo);

  if ( tempo !== tempo0 ) await tempoD.update({ text: String(tempo) });
  if ( strain !== strain0 ) await strainD.update({ text: String(strain) });

  // Mishaps: one for every multiple of the Mishap Threshold that Strain passed on the way up.
  const ship = shipActor(scene);
  const hp = ship?.system.attributes?.hp;
  const mt = Number(hp?.mt) || 0;
  let alert = "";
  if ( mt > 0 && strain > strain0 ) alert += await mishapAlert(ship, strain0, strain);
  if ( hp?.max && strain >= hp.max && strain0 < hp.max ) {
    alert += `<p class="no-crew-alert"><strong>SHIP DISABLED.</strong> Strain has reached the ship's maximum Hit Points (${hp.max}).
      No station can act until Mishaps are Corrected.</p>`;
  }

  const fmt = (a, b) => (a === b ? `${b}` : `${a} → <strong>${b}</strong>`);
  const content = `<div class="no-crew-card">
    <h3>${label ?? "Crew Action"}</h3>
    <p>Tempo ${fmt(tempo0, tempo)} &nbsp;·&nbsp; Strain ${fmt(strain0, strain)}</p>
    ${notes.map(n => `<p>${n}</p>`).join("")}${alert}</div>`;
  await ChatMessage.implementation.create({
    content,
    speaker: actor ? ChatMessage.implementation.getSpeaker({ actor }) : { alias: ship?.name ?? "Bridge" },
    flags: { [MODULE_ID]: { crewResult: true } }
  });
}

/**
 * Player characters standing on a station on this scene: character actors with a player owner
 * whose token center is inside a station region or station tile. Each actor counts once.
 * @returns {Actor[]}
 */
export function crewOnStations(scene) {
  const out = new Map();
  for ( const t of scene?.tokens ?? [] ) {
    const actor = t.actor;
    if ( !actor || (actor.type !== "character") || !actor.hasPlayerOwner ) continue;
    if ( stationsForToken(t).size ) out.set(actor.uuid, actor);
  }
  return [...out.values()];
}

/**
 * The bridge's Reset button (GM only). Rules: starting Tempo equals the number of players, or 0
 * if the ship is surprised. Players are counted as player characters standing on this scene's
 * stations. Strain carries over unless the GM ticks "Also clear Strain".
 * @param {Scene} scene   The scene the Reset button is on.
 */
export async function resetStats(scene = canvas.scene) {
  if ( !game.user.isGM ) {
    ui.notifications.warn("Only a GM can reset Tempo.");
    return;
  }
  const tempoD = statDrawing(scene, "tempo");
  if ( !tempoD ) return ui.notifications.warn(`No drawing tagged "Tempo" on ${scene?.name}.`);
  const crew = crewOnStations(scene);
  const names = crew.map(a => a.name).join(", ") || "none";
  const strainNow = readStat(scene, "strain");
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: "Reset Tempo" },
    content: `<p>Players on stations: <strong>${crew.length}</strong> (${names}).</p>
      <p>Starting Tempo is ${crew.length}, or 0 if the ship is surprised.</p>
      ${strainNow === null ? "" : `<label><input type="checkbox" name="clearStrain"> Also clear Strain (now ${strainNow})</label>`}`,
    buttons: [
      { action: "normal", label: `Normal (Tempo ${crew.length})`, default: true,
        callback: (event, button) => ({ surprised: false, clearStrain: !!button.form.elements.clearStrain?.checked }) },
      { action: "surprised", label: "Surprised (Tempo 0)",
        callback: (event, button) => ({ surprised: true, clearStrain: !!button.form.elements.clearStrain?.checked }) },
      { action: "cancel", label: "Cancel" }
    ],
    rejectClose: false
  });
  if ( !result || (typeof result !== "object") ) return;
  const tempo = result.surprised ? 0 : crew.length;
  return enqueue(async () => {
    await tempoD.update({ text: String(tempo) });
    const strainD = statDrawing(scene, "strain");
    if ( result.clearStrain && strainD ) await strainD.update({ text: "0" });
    await ChatMessage.implementation.create({
      content: `<div class="no-crew-card"><h3>Tempo reset</h3>
        <p>Tempo <strong>${tempo}</strong> (${result.surprised ? "surprised" : `${crew.length} on stations`})${
          result.clearStrain && strainD ? " &nbsp;·&nbsp; Strain <strong>0</strong>" : ""}</p></div>`,
      speaker: { alias: shipActor(scene)?.name ?? "Bridge" },
      flags: { [MODULE_ID]: { crewResult: true } }
    });
  });
}

/**
 * Nudge the scene's "Tempo" or "Strain" drawing up or down (used by the +/- tiles on the bridge
 * through Monk's Active Tiles). No chat card for the change itself; Strain still announces a
 * Mishap when it passes a multiple of the Mishap Threshold, and Disabled at max HP.
 * @param {"Tempo"|"Strain"} tag
 * @param {number} delta
 * @param {Scene} [scene]
 */
export async function adjustStat(tag, delta, scene = canvas.scene) {
  if ( !game.user.isGM ) {
    ui.notifications.warn("Only a GM client can change Tempo and Strain.");
    return;
  }
  return enqueue(async () => {
    const d = statDrawing(scene, tag);
    if ( !d ) return ui.notifications.warn(`No drawing tagged "${tag}" on ${scene?.name}.`);
    const before = readStat(scene, tag);
    const after = Math.max(0, before + delta);
    if ( after === before ) return;
    await d.update({ text: String(after) });
    if ( tag.toLowerCase() !== "strain" || after <= before ) return;
    const hp = shipActor(scene)?.system.attributes?.hp;
    const mt = Number(hp?.mt) || 0;
    let alert = "";
    if ( mt > 0 ) alert += await mishapAlert(shipActor(scene), before, after);
    if ( hp?.max && after >= hp.max && before < hp.max ) {
      alert += `<p class="no-crew-alert"><strong>SHIP DISABLED.</strong> Strain has reached the ship's maximum Hit Points (${hp.max}).</p>`;
    }
    if ( alert ) await ChatMessage.implementation.create({
      content: `<div class="no-crew-card"><h3>Strain ${before} → ${after}</h3>${alert}</div>`,
      speaker: { alias: shipActor(scene)?.name ?? "Bridge" },
      flags: { [MODULE_ID]: { crewResult: true } }
    });
  });
}

/* -------------------------------------------- */
/*  Gauges                                      */
/* -------------------------------------------- */

/**
 * Gauge color for a stat value.
 *  Tempo:  0-10 red, 11-20 yellow, 21+ green.
 *  Strain: percent of the ship's max HP, rounded down: 0-33 green, 34-66 yellow, 67+ red.
 * @returns {"green"|"yellow"|"red"|null}  null when it can't be worked out (no ship / no max HP).
 */
function gaugeColor(tag, value, scene) {
  if ( tag === "tempo" ) return value <= 10 ? "red" : value <= 20 ? "yellow" : "green";
  const max = Number(shipActor(scene)?.system.attributes?.hp?.max) || 0;
  if ( max <= 0 ) return null;
  const pct = Math.floor((value / max) * 100);
  return pct <= 33 ? "green" : pct <= 66 ? "yellow" : "red";
}

/** Swap the tempo_gauge / strain_gauge tiles' images to match the current Tempo and Strain. */
async function syncGauges(scene = canvas.scene) {
  if ( !scene ) return;
  const hasTag = (doc, tag) => tagsOf(doc).includes(tag);
  const updates = [];
  for ( const tag of ["tempo", "strain"] ) {
    const value = readStat(scene, tag);
    if ( value === null ) continue;
    const color = gaugeColor(tag, value, scene);
    if ( !color ) continue;
    for ( const tile of scene.tiles.filter(t => hasTag(t, `${tag}_gauge`)) ) {
      const src = tile.texture.src ?? "";
      // Only images following the no-ship-guage-<color>.webp naming are swapped.
      if ( !/(green|yellow|red)(\.[a-z0-9]+)$/i.test(src) ) continue;
      const next = src.replace(/(green|yellow|red)(\.[a-z0-9]+)$/i, `${color}$2`);
      if ( next !== src ) updates.push({ _id: tile.id, "texture.src": next });
    }
  }
  if ( updates.length ) await scene.updateEmbeddedDocuments("Tile", updates);
}

Hooks.on("updateDrawing", (drawing, changes) => {
  if ( !isActiveGM() || !("text" in changes) ) return;
  const tags = tagsOf(drawing);
  if ( tags.includes("tempo") || tags.includes("strain") ) enqueue(() => syncGauges(drawing.parent));
});
Hooks.on("updateActor", (actor, changes) => {
  if ( !isActiveGM() || (actor.type !== "vehicle") ) return;
  if ( foundry.utils.hasProperty(changes, "system.attributes.hp") ) enqueue(() => syncGauges(canvas.scene));
  // The center ship's Speed changed (redesign or edit): show the new Speed.
  const speedChanged = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.speed`)
    || foundry.utils.hasProperty(changes, "system.attributes.movement");
  if ( speedChanged && (radarCenterShip(canvas.scene)?.actor?.id === actor.id) ) {
    enqueue(() => syncSpeed(canvas.scene, { force: true }));
  }
});
// A Speed display dropped onto a scene (for example with the Radar widget) fills in at once.
Hooks.on("createDrawing", drawing => {
  if ( isActiveGM() && tagsOf(drawing).includes("speed") ) enqueue(() => syncSpeed(drawing.parent, { force: true }));
});
Hooks.on("canvasReady", () => {
  if ( !isActiveGM() ) return;
  enqueue(() => syncGauges(canvas.scene));
  enqueue(() => syncSpeed(canvas.scene));
});
// On the first load the active GM isn't settled yet when canvasReady fires, so sync again at ready.
Hooks.once("ready", () => {
  if ( !isActiveGM() || !canvas.scene ) return;
  enqueue(() => syncGauges(canvas.scene));
  enqueue(() => syncSpeed(canvas.scene));
  if ( sceneHasStations(canvas.scene) ) enqueue(() => reconcileScene(canvas.scene));
});

// The active GM turns usage cards and Gain Tempo rolls into Tempo/Strain changes.
Hooks.on("createChatMessage", message => {
  if ( !isActiveGM() ) return;
  const flags = message.flags?.[MODULE_ID];
  if ( !flags ) return;

  const c0 = flags.crew;
  if ( c0 && !c0.gainTempo && (c0.tempo || c0.strain || c0.strainDelta) ) {
    const scene = game.scenes.get(message.speaker?.scene) ?? canvas.scene;
    const actor = message.getAssociatedActor?.();
    const c = flags.crew;
    const bits = [c.tempo ? `${c.tempo} Tempo` : null, c.strain ? `+${c.strain} Strain` : null].filter(Boolean);
    enqueue(() => applyCost(scene, c, { actor, label: `${c.action}${bits.length ? ` (${bits.join(", ")})` : ""}` }));
    // The Helmsman's Maneuver starts the pilot's turn: Speed refills to the ship's Speed.
    if ( c.action === "Maneuver" ) enqueue(() => syncSpeed(scene, { force: true }));
  }

  if ( flags.gainTempo ) {
    const roll = message.rolls?.[0];
    if ( !roll ) return;
    const { sceneId } = flags.gainTempo;
    // Enforce the minimums here too, in case the roll came from a client on older code.
    const dc = Math.max(GAIN_TEMPO_MIN_DC, Number(flags.gainTempo.dc) || 0);
    const prof = Math.max(GAIN_TEMPO_MIN_GAIN, Number(flags.gainTempo.prof) || 0);
    const scene = game.scenes.get(sceneId) ?? canvas.scene;
    const actor = message.getAssociatedActor?.();
    const success = roll.total >= dc;
    const cost = { tempoGain: 0, strainDelta: 0 };
    const parts = [];
    if ( success ) { cost.tempoGain += prof; parts.push(`success, +${prof} Tempo`); }
    else { cost.strainDelta += 1; parts.push("failure, +1 Strain"); }
    if ( roll.isCritical ) { cost.tempoGain += 1; parts.push("critical, +1 Tempo"); }
    if ( roll.isFumble ) { cost.strainDelta += 1; parts.push("fumble, +1 Strain"); }
    enqueue(() => applyCost(scene, cost, { actor, label: `Gain Tempo: ${roll.total} vs DC ${dc} (${parts.join("; ")})` }));
  }
});
