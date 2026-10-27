// Radar linked to the sector map (John, 2026-10-25).
//
// A bridge whose display ship has a sector map (picked with the bridge's gear, or found automatically)
// shows that map's other ships on its radar, placed relative to the crew's ship: the crew's ship sits at the
// center facing the 12. Band 1-4 = 1-4 hexes away; band 5 = beyond 4 hexes, within sensor range
// (flags.sensorRange, hexes; unset = no limit). Each blip sits mid-band at the ship's bearing.
// The contacts follow every move, turn, arrival and departure on the sector map.
// Double-clicking the radar opens the sector map.
//
// The contacts are tokens on the bridge, flagged radarMirror = <source token uuid>, sized and glowing like
// any radar blip. They are the GM's: players see them, and they are rebuilt from the sector map, so they
// are never moved by hand.

import { MODULE_ID, sectorScene, sectorToken, baseActor, isSectorScene, viewScene } from "./ship-state.mjs";
import { shipActor, radarArea, radarGlow } from "./crew-stations.mjs";

const RINGS = 5;
const BLIP = 0.5;
const BAND_INNER = 0.086;
const BAND_OUTER = 0.797;
const isActiveGM = () => game.users.activeGM?.isSelf ?? false;

/** Bridges whose display ship flies on this sector scene. */
function bridgesFor(scene) {
  const out = [];
  for ( const bridge of game.scenes ) {
    if ( !radarArea(bridge) ) continue;
    const ship = shipActor(bridge);
    if ( ship && (sectorScene(ship)?.id === scene.id) ) out.push(bridge);
  }
  return out;
}

/** Center of a token from its stored values. */
function centerOf(t) {
  const g = t.parent.grid, s = t._source;
  return { x: s.x + (s.width * g.sizeX) / 2, y: s.y + (s.height * g.sizeY) / 2 };
}

/** Hexes between two tokens on a hex map (grid steps between their centers). */
function hexDistance(scene, a, b) {
  try {
    const m = scene.grid.measurePath([centerOf(a), centerOf(b)]);
    if ( Number.isFinite(m?.spaces) ) return m.spaces;
  } catch(err) { /* fall back below */ }
  const ca = centerOf(a), cb = centerOf(b);
  return Math.round(Math.hypot(cb.x - ca.x, cb.y - ca.y) / Math.min(scene.grid.sizeX, scene.grid.sizeY));
}

/**
 * The ship's sensor range in hexes: flags["fvtt-neon-odyssey"].sensorRange. Unset means no limit
 * (everything beyond 4 hexes shows in band 5).
 */
export function sensorRange(actor) {
  const n = Number(baseActor(actor)?.flags?.[MODULE_ID]?.sensorRange ?? actor?.flags?.[MODULE_ID]?.sensorRange);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

/**
 * Where each sector ship goes on this bridge's radar: [{ source, x, y, rotation, band }].
 * Bands (John, 2026-10-25): band 1 = the ship 1 hex away, 2 = 2 hexes, 3 = 3 hexes, 4 = 4 hexes,
 * band 5 = beyond 4 hexes but within sensor range. Ships outside sensor range aren't shown. Each blip sits
 * in the middle of its band, at the bearing of that ship from the crew's ship (the crew's ship faces the 12).
 */
function contacts(bridge) {
  const ship = shipActor(bridge);
  const own = ship ? sectorToken(ship) : null;
  const area = radarArea(bridge);
  if ( !own || !area ) return [];
  const sector = own.parent;
  const range = sensorRange(ship);
  const o = centerOf(own);
  const heading = own._source.rotation ?? 0;
  const a = Math.toRadians(-heading), cos = Math.cos(a), sin = Math.sin(a);
  // The bands follow the rings drawn on the radar art (measured 2026-10-25): the innermost circle (the
  // crew's ship) is 8.6% of the radar radius and the outermost ring 79.7%, with 5 equal bands between.
  // A radar tile can override them with flags bandInner / bandOuter (fractions of the radius).
  const tile = bridge.tiles.find(tl => tl.getFlag(MODULE_ID, "radar"));
  const inner = Number(tile?.getFlag(MODULE_ID, "bandInner")) || BAND_INNER;
  const outer = Number(tile?.getFlag(MODULE_ID, "bandOuter")) || BAND_OUTER;
  const bandPx = (area.r * (outer - inner)) / RINGS;
  const out = [];
  for ( const t of sector.tokens ) {
    if ( (t.id === own.id) || (t.actor?.type !== "vehicle") ) continue;
    if ( t.actorLink && baseActor(ship) && (t.actorId === baseActor(ship).id) ) continue;
    const hexes = hexDistance(sector, own, t);
    if ( hexes > range ) continue;
    const band = Math.min(RINGS, Math.max(1, hexes));
    // Bearing from the crew's ship, turned so its nose points at the 12.
    const c = centerOf(t);
    const dx = c.x - o.x, dy = c.y - o.y;
    const rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
    const ang = (rx || ry) ? Math.atan2(ry, rx) : -Math.PI / 2;
    const r = area.r * inner + (band - 0.5) * bandPx;
    out.push({ source: t, x: area.x + Math.cos(ang) * r, y: area.y + Math.sin(ang) * r, band,
      rotation: (((t._source.rotation ?? 0) - heading) % 360 + 360) % 360 });
  }
  return out;
}

/** Rebuild one bridge's sector contacts (GM). */
async function syncBridge(bridge) {
  if ( !isActiveGM() || !bridge ) return;
  const want = contacts(bridge);
  const have = bridge.tokens.filter(t => t.getFlag(MODULE_ID, "radarMirror"));
  const bySource = new Map(have.map(t => [t.getFlag(MODULE_ID, "radarMirror"), t]));
  const half = (BLIP * bridge.grid.size) / 2;
  const updates = [], creates = [], keep = new Set();
  for ( const w of want ) {
    const uuid = w.source.uuid;
    const x = Math.round(w.x - half), y = Math.round(w.y - half);
    const mirror = bySource.get(uuid);
    const look = { rotation: w.rotation, disposition: w.source.disposition, hidden: w.source.hidden, alpha: 1 };
    if ( mirror ) {
      keep.add(mirror.id);
      const s = mirror._source;
      if ( (s.x !== x) || (s.y !== y) || (s.rotation !== look.rotation) || (s.disposition !== look.disposition)
        || (s.hidden !== look.hidden) || (s.alpha !== look.alpha) ) updates.push({ _id: mirror.id, x, y, ...look });
      continue;
    }
    const base = game.actors.get(w.source.actorId);
    if ( !base ) continue;
    const td = (await base.getTokenDocument({ x, y, width: BLIP, height: BLIP, name: w.source.name, ...look })).toObject();
    td.actorLink = false;
    if ( !w.source.actorLink ) td.delta = foundry.utils.deepClone(w.source._source.delta ?? {});
    td.texture = foundry.utils.deepClone(w.source._source.texture);
    td.sight = { enabled: false };
    delete td.flags?.["token-attacher"];
    foundry.utils.setProperty(td, `flags.${MODULE_ID}.radarMirror`, uuid);
    foundry.utils.setProperty(td, `flags.${MODULE_ID}.radarSize`, { width: w.source._source.width, height: w.source._source.height });
    foundry.utils.setProperty(td, `flags.${MODULE_ID}.hudBuilt`, true);
    creates.push(td);
  }
  const gone = have.filter(t => !keep.has(t.id)).map(t => t.id);
  if ( gone.length ) await bridge.deleteEmbeddedDocuments("Token", gone);
  if ( updates.length ) await bridge.updateEmbeddedDocuments("Token", updates, { neonOdysseyResize: true, animate: false });
  if ( creates.length ) {
    const made = await bridge.createEmbeddedDocuments("Token", creates, { neonOdysseyResize: true });
    if ( globalThis.TokenMagic ) for ( const m of made ) await TokenMagic.addUpdateFilters(m, radarGlow(m));
  }
  // A changed disposition recolors the glow.
  if ( globalThis.TokenMagic ) {
    for ( const u of updates.filter(u => "disposition" in u) ) {
      const m = bridge.tokens.get(u._id);
      if ( m ) await TokenMagic.addUpdateFilters(m, radarGlow(m));
    }
  }
}

/* -------------------------------------------- */
/*  Keeping it current                          */
/* -------------------------------------------- */

let queue = Promise.resolve();
const timers = new Map();
/** Rebuild a bridge's contacts soon (changes arrive in bursts while a token moves). */
function schedule(bridge) {
  if ( !isActiveGM() || !bridge ) return;
  clearTimeout(timers.get(bridge.id));
  timers.set(bridge.id, setTimeout(() => {
    queue = queue.then(() => syncBridge(bridge)).catch(err => console.error(`${MODULE_ID} | radar link`, err));
  }, 250));
}
const scheduleFor = scene => { if ( scene && isSectorScene(scene) ) for ( const b of bridgesFor(scene) ) schedule(b); };
const scheduleAll = () => { for ( const b of game.scenes ) if ( radarArea(b) && shipActor(b) ) schedule(b); };

const SHIP_KEYS = ["x", "y", "rotation", "disposition", "hidden", "texture", "name", "width", "height"];
Hooks.on("createToken", doc => { if ( doc.actor?.type === "vehicle" ) { scheduleFor(doc.parent); if ( radarArea(doc.parent) ) schedule(doc.parent); } });
Hooks.on("deleteToken", doc => { if ( doc.actor?.type === "vehicle" ) { scheduleFor(doc.parent); if ( radarArea(doc.parent) && !doc.getFlag(MODULE_ID, "radarMirror") ) schedule(doc.parent); } });
Hooks.on("updateToken", (doc, changes) => {
  if ( (doc.actor?.type !== "vehicle") || !SHIP_KEYS.some(k => k in changes) ) return;
  scheduleFor(doc.parent);
});
// The picked sector map changed, or a ship arrived on / left a display.
Hooks.on("updateActor", (actor, changes) => {
  if ( (actor.type === "vehicle") && foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)
    && ["sectorSceneId", "-=sectorSceneId", "sensorRange", "-=sensorRange"].some(k => k in changes.flags[MODULE_ID]) ) scheduleAll();
});
Hooks.on(`${MODULE_ID}.viewscreenEnter`, doc => schedule(doc.parent));
Hooks.on(`${MODULE_ID}.viewscreenLeave`, doc => schedule(doc.parent));
Hooks.on("updateScene", (scene, changes) => { if ( foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.sectorMap`) ) scheduleAll(); });
Hooks.once("ready", () => setTimeout(scheduleAll, 2000));

/* -------------------------------------------- */
/*  Double-click the radar: open the sector map */
/* -------------------------------------------- */

Hooks.on("canvasReady", () => {
  const view = canvas.app?.view;
  if ( !view || view._noRadarDbl ) return;
  view._noRadarDbl = true;
  view.addEventListener("dblclick", ev => {
    const scene = canvas.scene;
    const area = radarArea(scene);
    if ( !area ) return;
    const p = canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY });
    if ( Math.hypot(p.x - area.x, p.y - area.y) > area.r ) return;
    const ship = shipActor(scene);
    const target = ship ? sectorScene(ship) : null;
    if ( target ) viewScene(target);
  });
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).radarLink = { syncBridge, contacts, scheduleAll, sensorRange };
});
