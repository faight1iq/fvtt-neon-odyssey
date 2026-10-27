// Sector maps (John, 2026-10-12): a tile flagged as a sector map forces ship (vehicle) tokens on
// it to fit inside one hex (0.5 light seconds). The token's own size is remembered and restored
// if it is moved off the tile.
//
// Mark a tile:   tile.setFlag("fvtt-neon-odyssey", "sectorMap", true)
// (The old sectorScale tile flag is no longer used: the scale follows the ship's size.)

import { sectorTokenSize } from "./ship-state.mjs";

const MODULE_ID = "fvtt-neon-odyssey";
// The art scale inside the hex follows the ship's size (John, 2026-10-26): Gargantuan 1.0 … Tiny 0.25.

/** Sector-map tiles on a scene whose rectangle contains the point. */
function sectorTileAt(scene, point) {
  for ( const tile of scene?.tiles ?? [] ) {
    if ( !tile.getFlag(MODULE_ID, "sectorMap") ) continue;
    const s = tile._source;
    if ( (point.x >= s.x) && (point.x <= s.x + s.width) && (point.y >= s.y) && (point.y <= s.y + s.height) ) return tile;
  }
  return null;
}

/** A token's center from stored values (optionally overridden by pending changes). */
function centerOf(scene, src, changes = {}) {
  const size = scene.grid.size;
  const x = changes.x ?? src.x, y = changes.y ?? src.y;
  const w = changes.width ?? src.width, h = changes.height ?? src.height;
  return { x: x + (w * size) / 2, y: y + (h * size) / 2 };
}

/** Top-left of the 1x1 token in the grid cell under a point. */
function cellTopLeft(scene, point) {
  try {
    const grid = scene.grid;
    return grid.getTopLeftPoint(grid.getOffset(point));
  } catch(err) {
    const size = scene.grid.size;
    return { x: point.x - size / 2, y: point.y - size / 2 };
  }
}

/** Changes that shrink a token into one hex, remembering its size. */
function fitChanges(scene, src, tile, point, actor) {
  const scale = sectorTokenSize(actor);
  const tl = cellTopLeft(scene, point);
  const prior = src.flags?.[MODULE_ID]?.sectorFit;
  return {
    x: tl.x, y: tl.y, width: 1, height: 1,
    "texture.scaleX": scale, "texture.scaleY": scale,
    [`flags.${MODULE_ID}.sectorFit`]: prior ?? { width: src.width, height: src.height,
      scaleX: src.texture?.scaleX ?? 1, scaleY: src.texture?.scaleY ?? 1 }
  };
}

const isShip = doc => doc.actor?.type === "vehicle";

Hooks.on("preCreateToken", (doc, data, options, userId) => {
  if ( userId !== game.user.id ) return;
  const scene = doc.parent;
  if ( !scene || !isShip(doc) ) return;
  const src = doc._source;
  const point = centerOf(scene, src);
  const tile = sectorTileAt(scene, point);
  if ( !tile ) return;
  doc.updateSource(foundry.utils.expandObject(fitChanges(scene, src, tile, point, doc.actor)));
});

Hooks.on("preUpdateToken", (doc, changes, options, userId) => {
  if ( userId !== game.user.id ) return;
  if ( options[`${MODULE_ID}.sectorFit`] ) return;
  const scene = doc.parent;
  if ( !scene || !isShip(doc) ) return;
  const moved = ("x" in changes) || ("y" in changes);
  const resized = ("width" in changes) || ("height" in changes);
  if ( !moved && !resized ) return;
  const src = doc._source;
  const fitted = src.flags?.[MODULE_ID]?.sectorFit;
  const point = centerOf(scene, src, moved ? { x: changes.x, y: changes.y } : {});
  const tile = sectorTileAt(scene, point);
  if ( tile ) {
    // On the sector map: always one hex.
    // Size only: in v13 a move's x/y belong to the movement API, so they are left alone here.
    const fit = fitChanges(scene, src, tile, point, doc.actor);
    delete fit.x; delete fit.y;
    if ( src.width === 1 && src.height === 1 && !resized ) return;
    foundry.utils.mergeObject(changes, foundry.utils.expandObject(fit));
  } else if ( fitted ) {
    // Moved off the sector map: give the token its own size back.
    foundry.utils.mergeObject(changes, {
      width: fitted.width, height: fitted.height,
      texture: { scaleX: fitted.scaleX, scaleY: fitted.scaleY },
      flags: { [MODULE_ID]: { "-=sectorFit": null } }
    });
  }
});

/** Fit every ship token already on a scene's sector-map tiles (GM). */
export async function fitSceneShips(scene = canvas.scene) {
  if ( !game.user.isGM || !scene ) return 0;
  const updates = [];
  for ( const t of scene.tokens ) {
    if ( !isShip(t) ) continue;
    const src = t._source;
    const point = centerOf(scene, src);
    const tile = sectorTileAt(scene, point);
    if ( !tile ) continue;
    updates.push({ _id: t.id, ...fitChanges(scene, src, tile, point, t.actor) });
  }
  if ( updates.length ) await scene.updateEmbeddedDocuments("Token", updates, { [`${MODULE_ID}.sectorFit`]: true });
  return updates.length;
}

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if ( mod ) mod.sectorMap = { fitSceneShips };
});
