// Neon Odyssey: self-building bridge HUD.
//
// Put a ship on a HUD-Ship-Display (the "viewscreen" tile) and the rest of the bridge HUD is
// built around the display, laid out like the scene "S.S. Trial and Error":
//   - Radar and Tempo/Strain, stamped from the HUD-Radar and HUD-Tempo-Strain actors;
//   - one crew card per role of each installed station (flags.stations, from the designer),
//     stamped from the Station-* actors; cards shrink when they don't fit the crew area;
//   - the Component Area: the display art at the right edge, with one block (the HUD-Component
//     template) per system the ship has, titled with the system and listing what is in it.
//     The blocks are a readout for the players; clicking them does nothing.
// Taking the ship off the display (moving it off or deleting it) tears the built HUD down.
//
// Everything is placed relative to the display tile and scaled with it (the template's display is
// 1300 x 1150). If the layout would run off the scene, the display and its ship are moved first so
// the whole HUD fits.

import { FACINGS, GUNNER_FACINGS, LOCATION_KEYS, stationLocation } from "./starship-calc.mjs";

/** "Port Gunner", "Bridge Gunner" (Command & Control) or plain "Gunner", from where the station sits. */
const gunnerTitle = loc => FACINGS.includes(loc) ? `${loc[0].toUpperCase()}${loc.slice(1)} Gunner` : (loc === "command" ? "Bridge Gunner" : "Gunner");

const MODULE_ID = "fvtt-neon-odyssey";

/** The S.S. Trial and Error layout, relative to the display tile's top-left corner. */
const BASE = { w: 1300, h: 1150 };
const LAYOUT = {
  radarToken: { x: 2600, y: 0 },      // one square lower than S.S. Trial and Error (John, 2026-10-12)
  tempoToken: { x: 2600, y: 1300 },
  area: { x: 2800, y: -100, w: 2100, h: 2500 },
  crewBands: [{ x: -50, y: 1300, w: 1500, h: 500 }, { x: -50, y: 1900, w: 2800, h: 500 }],
  bbox: { x0: -50, y0: -100, x1: 4900, y1: 2400 }
};
/** Crew card (Station-* template): 450 x 500 with its 100 x 100 token at the top-right. */
const CREW = { w: 450, h: 500, gapX: 50, gapY: 100 };
/** Component card (HUD-Component template): 300 x 300. */
const CARD = { w: 300, h: 300 };

/**
 * System blocks in the Component Area (area pixels, 2100 x 2500), after John's layout drawing
 * (2026-10-12): Shields, Armor and Hull small in the top-left corner; the center column holds
 * Bow Weapons, Command & Control + Navigation, Port / Habitat / Starboard, Power Systems,
 * Propulsion. With Aft Weapons, Propulsion and Aft Weapons share the bottom row, centered as a
 * pair like Command & Control and Navigation. A system the ship doesn't have gets no block.
 */
const BLOCKS = {
  shields:    { label: "Shields",           x: 91,   y: 116,  w: 262 },
  armor:      { label: "Armor",             x: 91,   y: 400,  w: 262 },
  hull:       { label: "Hull",              x: 91,   y: 684,  w: 262 },
  bow:        { label: "Bow Weapons",       x: 982,  y: 107,  w: 398 },
  command:    { label: "Command & Control", x: 759,  y: 549,  w: 398 },
  navigation: { label: "Navigation",        x: 1200, y: 549,  w: 398 },
  port:       { label: "Port Weapons",      x: 545,  y: 1000, w: 398 },
  habitat:    { label: "Habitat",           x: 982,  y: 1000, w: 398 },
  starboard:  { label: "Starboard Weapons", x: 1420, y: 1000, w: 398 },
  power:      { label: "Power Systems",     x: 982,  y: 1422, w: 398 },
  propulsion: { label: "Propulsion",        x: 982,  y: 1856, w: 398 },
  aft:        { label: "Aft Weapons",       x: 1200, y: 1856, w: 398 }
};
const TEXT_FONT = "Signika";

const ROLE_ORDER = ["commander", "pilot", "copilot", "helmsman", "navigator", "engineer", "gunner", "medic", "cook", "deck"];
const ROLE_ACTOR = r => r === "deck" ? "Station-Deck-Crew" : `Station-${r[0].toUpperCase()}${r.slice(1)}`;
const cap = w => w ? w[0].toUpperCase() + w.slice(1) : w;

const isGM = () => game.users.activeGM?.isSelf;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * The one GM client that builds a bridge's HUD: building needs the scene on that client's canvas.
 * The active GM if it is viewing the scene, otherwise the first other GM viewing it (by id), or null.
 * Every client works this out the same way, so two GMs never build at once.
 */
function hudBuilder(scene) {
  if ( !scene ) return null;
  const viewing = game.users.filter(u => u.active && u.isGM && (u.viewedScene === scene.id));
  if ( !viewing.length ) return null;
  const active = game.users.activeGM;
  if ( active && viewing.includes(active) ) return active;
  return viewing.sort((a, b) => a.id.localeCompare(b.id))[0];
}

/* -------------------------------------------- */
/*  Finding things                              */
/* -------------------------------------------- */

function displayTile(scene) {
  return scene?.tiles.find(t => t.getFlag(MODULE_ID, "viewscreen")) ?? null;
}

/** The token a tile is attached to with Token Attacher (the HUD-Ship-Display token), if any. */
function baseTokenOf(scene, tile) {
  return scene.tokens.find(t => (t.flags["token-attacher"]?.attached?.Tile ?? []).includes(tile.id)) ?? null;
}

function shipOnDisplay(scene) {
  return scene.tokens.find(t => t.actor?.type === "vehicle" && t.getFlag(MODULE_ID, "viewSize")) ?? null;
}

/* -------------------------------------------- */
/*  Stamping templates                          */
/* -------------------------------------------- */

/** Wait until the canvas has drawn these documents. */
async function placeables(docs) {
  for ( let i = 0; i < 40; i++ ) {
    if ( docs.every(d => d.object) ) break;
    await sleep(50);
  }
  return docs.map(d => d.object).filter(Boolean);
}

/**
 * Copy a Token Attacher template actor onto a scene at (x, y), scaled by k: the base token plus
 * every attached tile and drawing, attached to that token again so the group moves together.
 * @param {(type: string, data: object) => void} [edit]  Change an element's data before it is created.
 * @returns {Promise<{token: TokenDocument|null, tiles: string[], drawings: string[]}>}
 */
async function stamp(scene, actor, x, y, k, { token = true, edit } = {}) {
  const ta = actor?.prototypeToken.flags["token-attacher"];
  if ( !ta?.prototypeAttached || !ta.pos?.xy ) throw new Error(`${actor?.name ?? "Template"} has no Token Attacher prototype`);
  const P = ta.pos.xy;
  const out = { token: null, tiles: [], drawings: [] };
  const created = [];
  for ( const [type, list] of Object.entries(ta.prototypeAttached) ) {
    if ( !["Tile", "Drawing"].includes(type) || !list?.length ) continue;
    const docs = list.map(e => {
      const d = foundry.utils.deepClone(e);
      delete d._id;
      delete d.flags?.["token-attacher"];
      d.x = x + (e.x - P.x) * k;
      d.y = y + (e.y - P.y) * k;
      if ( type === "Tile" ) { d.width = e.width * k; d.height = e.height * k; }
      else {
        d.shape.width = e.shape.width * k; d.shape.height = e.shape.height * k;
        d.fontSize = Math.max(8, Math.round((e.fontSize ?? 24) * k));
      }
      foundry.utils.setProperty(d, `flags.${MODULE_ID}.hudBuilt`, true);
      edit?.(type, d, e);
      return d;
    });
    const made = await scene.createEmbeddedDocuments(type, docs);
    created.push(...made);
    (type === "Tile" ? out.tiles : out.drawings).push(...made.map(m => m.id));
  }
  if ( token ) {
    const pt = actor.prototypeToken;
    const td = (await actor.getTokenDocument({ x, y, width: pt.width * k, height: pt.height * k })).toObject();
    delete td.flags["token-attacher"];
    foundry.utils.setProperty(td, `flags.${MODULE_ID}.hudBuilt`, true);
    [out.token] = await scene.createEmbeddedDocuments("Token", [td]);
    const ta2 = globalThis.tokenAttacher;
    if ( ta2 && (canvas.scene?.id === scene.id) ) {
      const parts = await placeables(created);
      const base = (await placeables([out.token]))[0];
      if ( base && parts.length ) await ta2.attachElementsToToken(parts, base, true);
    }
  }
  return out;
}

/* -------------------------------------------- */
/*  Layout                                      */
/* -------------------------------------------- */

/** Largest scale (<= max) at which n cards of size w x h (plus gaps) fit the bands. */
function fitScale(n, bands, w, h, gx, gy, max = 1) {
  if ( !n ) return max;
  for ( let k = max; k > 0.1; k -= 0.025 ) {
    const cap = bands.reduce((s, b) => s + Math.floor((b.w + gx * k) / ((w + gx) * k)) * Math.floor((b.h + gy * k) / ((h + gy) * k)), 0);
    if ( cap >= n ) return k;
  }
  return 0.1;
}

/** Positions for n cards filling the bands left to right, top to bottom. */
function slots(n, bands, w, h, gx, gy, k) {
  const out = [];
  for ( const b of bands ) {
    const cols = Math.floor((b.w + gx * k) / ((w + gx) * k));
    const rows = Math.floor((b.h + gy * k) / ((h + gy) * k));
    for ( let r = 0; r < rows; r++ ) for ( let c = 0; c < cols; c++ ) {
      if ( out.length < n ) out.push({ x: b.x + c * (w + gx) * k, y: b.y + r * (h + gy) * k });
    }
  }
  return out;
}

/** Plain-language component names: "Blaster Spear (Medium)" -> "Medium Blaster Spear". */
const NAME_ALIASES = { "Galley / Mess Hall": "Galley / Mess", "Life Support Plant": "Life Support", "Deflector Generator": "Deflector" };
export function shortName(name) {
  let n = String(name ?? "").trim();
  if ( NAME_ALIASES[n] ) return NAME_ALIASES[n];
  let size = "";
  const m = /^(.*) \(([^()]+)\)$/.exec(n);
  if ( m ) { n = m[1]; size = m[2]; }
  n = NAME_ALIASES[n] ?? n;
  const c = /^([^,]+), (.+?)( \+\d+)?$/.exec(n);
  if ( c ) n = `${c[2]} ${c[1]}${c[3] ?? ""}`;
  return size ? `${size} ${n}` : n;
}

const SLOT_ORDER = ["shipClass", "material", "armor", "deflector", "ablative", "nexus", "comms", "sensory", "power", "propulsion", "weapon", "habitat"];

/**
 * The readout lines for every system block: { block: [{ text, order }] }.
 * Stations come first in their block, then parts in slot order.
 */
function blockLines(actor, lib = null) {
  const out = {};
  const add = (block, text, order) => (out[block] ??= []).push({ text, order });
  for ( const item of actor.items ) {
    // The compendium's current data (the item may carry an older copy).
    const own = item.flags[MODULE_ID]?.component;
    const c = (own && lib?.byId.get(`${own.slot}|${own.id}`)) ?? own;
    if ( c?.v !== 2 ) continue;
    const qty = Math.max(1, Number(item.system.quantity) || 1);
    const facing = item.flags[MODULE_ID]?.facing;
    const order = 100 + SLOT_ORDER.indexOf(c.slot);
    const n = shortName(item.name);
    const times = qty > 1 ? `${qty}, ` : "";
    switch ( c.slot ) {
      case "weapon":
        add(FACINGS.includes(facing) ? facing : "bow", `${times}${n}${FACINGS.includes(facing) ? "" : " (no facing)"}`, order);
        break;
      case "habitat": {
        const roles = c.stationRoles;
        if ( roles?.length ) {
          // The station sits where it was placed (older ships: by hudSystem / gunner facing).
          const loc = stationLocation(item.flags[MODULE_ID]?.location, facing, roles[0]);
          const block = LOCATION_KEYS.includes(loc) ? loc
            : (["command", "navigation", "power"].includes(c.hudSystem) ? c.hudSystem : "command");
          const label = roles.includes("gunner") ? gunnerTitle(loc) : roles.map(cap).join(" + ");
          const ro = Math.min(...roles.map(r => ROLE_ORDER.indexOf(r)));
          for ( let i = 0; i < qty; i++ ) add(block, `Station: ${label}`, ro);
          break;
        }
        const s = c.stats ?? {};
        const num = (s.berths || s.cargo || s.prisoners || s.passengers || 0) * qty;
        // Galley, Medical Bay: who runs it.
        const who = c.seatRole ? (item.flags[MODULE_ID]?.station?.location === "none" ? " (automated)"
          : ` (${c.seatRole === "cook" ? "Cook" : "Medic"})`) : "";
        add(roles ? (c.hudSystem === "command" ? "command" : "habitat") : "habitat", `${times}${n}${num ? ` (${num})` : ""}${who}`, order);
        break;
      }
      case "nexus": add("command", `Nexus Core: ${n}`, order); break;
      case "comms": add("navigation", `Comms: ${n}`, order); break;
      case "sensory": add("navigation", `Sensors: ${n}`, order); break;
      case "power": add("power", `${times}${/power|reactor|generator|engine/i.test(n) ? n : `${n} Power`}`, order); break;
      case "propulsion": add("propulsion", `${times}${n}`, order); break;
      case "armor": add("armor", n, order); break;
      case "deflector": case "ablative": add("shields", n, order); break;
      case "material": add("hull", n, order); break;
    }
  }
  // Hull: the size the designer chose (from keel, beam and draft), then the material.
  const size = actor.getFlag(MODULE_ID, "sizeName");
  if ( size ) add("hull", size, 0);
  for ( const list of Object.values(out) ) list.sort((a, b) => a.order - b.order);
  return out;
}

/** Width of a line of text in pixels, as the canvas will draw it. */
function textWidth(text, fontFamily, fontSize) {
  try { return PIXI.TextMetrics.measureText(String(text), new PIXI.TextStyle({ fontFamily, fontSize })).width; }
  catch { return 0.55 * fontSize * String(text).length; }
}

/** Largest font size (<= base) at which every line fits the width. */
function fitWidth(lines, fontFamily, base, width) {
  let fs = base;
  for ( const t of lines ) {
    const w = textWidth(t, fontFamily, base);
    if ( w > width ) fs = Math.min(fs, Math.floor(base * width / w));
  }
  return Math.max(8, fs);
}

/* -------------------------------------------- */
/*  Build and tear down                         */
/* -------------------------------------------- */

let chain = Promise.resolve();
const serial = fn => (chain = chain.then(fn).catch(err => {
  console.error(`${MODULE_ID} | ship HUD`, err);
  ui.notifications.error(`Ship HUD: ${err.message}`);
}));

/** Build the whole HUD around the scene's display for the ship on it. */
export function buildHud(scene = canvas.scene) { return serial(() => _build(scene, { full: true })); }
/** Rebuild only the crew cards and component cards (after the ship's design changed). */
export function refreshHud(scene = canvas.scene) { return serial(() => _build(scene, { full: false })); }
/** Remove everything the builder placed. */
export function teardownHud(scene = canvas.scene) { return serial(() => _teardown(scene, { full: true })); }

async function _build(scene, { full }) {
  if ( !game.user.isGM || !scene ) return;
  const tile = displayTile(scene);
  const ship = shipOnDisplay(scene);
  if ( !tile || !ship?.actor ) return;
  if ( canvas.scene?.id !== scene.id ) {
    // Building needs the bridge on this client's canvas. Mark it pending: a GM viewing the bridge builds
    // it now (updateTile hook below), or the first GM to open the bridge does (canvasReady).
    if ( full || tile.getFlag(MODULE_ID, "hud") ) {
      if ( !tile.getFlag(MODULE_ID, "hudPending") ) await tile.setFlag(MODULE_ID, "hudPending", full ? "full" : "parts");
      if ( !hudBuilder(scene) ) ui.notifications.info(`Ship HUD for ${scene.name} will be rebuilt when a GM opens that scene.`);
    }
    return;
  }
  const record = tile.getFlag(MODULE_ID, "hud");
  if ( !full && !record ) return;
  await _teardown(scene, { full });

  // Scale with the display, and keep the whole layout on the scene.
  const k = tile.width / BASE.w;
  let ox = tile.x, oy = tile.y;
  if ( full ) {
    const d = scene.dimensions;
    const minX = d.sceneX - LAYOUT.bbox.x0 * k, maxX = d.sceneX + d.sceneWidth - LAYOUT.bbox.x1 * k;
    const minY = d.sceneY - LAYOUT.bbox.y0 * k, maxY = d.sceneY + d.sceneHeight - LAYOUT.bbox.y1 * k;
    const nx = Math.round(Math.min(Math.max(ox, minX), Math.max(minX, maxX)));
    const ny = Math.round(Math.min(Math.max(oy, minY), Math.max(minY, maxY)));
    if ( (nx !== ox) || (ny !== oy) ) {
      const dx = nx - ox, dy = ny - oy;
      const base = baseTokenOf(scene, tile);
      if ( base ) await base.update({ x: base.x + dx, y: base.y + dy }, { animate: false });
      else await tile.update({ x: nx, y: ny });
      await ship.update({ x: ship._source.x + dx, y: ship._source.y + dy }, { animate: false, neonOdysseyResize: true });
      for ( let i = 0; i < 40 && (tile.x !== nx || tile.y !== ny); i++ ) await sleep(50);
      ui.notifications.info("Ship HUD: moved the display so the whole HUD fits on the scene.");
    }
    ox = nx; oy = ny;
  }
  const at = (p) => ({ x: ox + p.x * k, y: oy + p.y * k });

  const rec = full ? { actorId: ship.actor.id, core: { tokens: [], tiles: [], drawings: [] } } : { ...record };
  rec.actorId = ship.actor.id;
  rec.parts = { tokens: [], tiles: [], drawings: [] };
  const keep = (bucket, r) => {
    if ( r.token ) bucket.tokens.push(r.token.id);
    bucket.tiles.push(...r.tiles); bucket.drawings.push(...r.drawings);
  };

  // Radar, Tempo/Strain and the Component Area art.
  if ( full ) {
    const radar = game.actors.getName("HUD-Radar");
    if ( radar ) {
      const p = at(LAYOUT.radarToken);
      const r = await stamp(scene, radar, p.x, p.y, k, { edit: (type, d) => {
        if ( type === "Drawing" ) for ( const f of ["speedShip", "steerBands", "steerFacings"] ) delete d.flags?.[MODULE_ID]?.[f];
      } });
      keep(rec.core, r);
      // The crew's own ship at the radar's center, friendly: the radar's Speed display runs off it.
      const radarTile = r.tiles.map(id => scene.tiles.get(id)).find(t => t?.getFlag(MODULE_ID, "radar"));
      if ( radarTile ) {
        const base = game.actors.get(ship.actorId) ?? ship.actor;
        const grid = scene.grid.size;
        const cx = radarTile.x + Math.abs(radarTile.width) / 2, cy = radarTile.y + Math.abs(radarTile.height) / 2;
        const td = (await base.getTokenDocument({ x: cx - grid / 2, y: cy - grid / 2, width: 1, height: 1,
          disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY, rotation: 0, name: ship.name === "Vehicle" ? base.name : ship.name })).toObject();
        // The same actor as the ship on the display (John, 2026-10-25: Tempo, Strain and Speed live on it).
        td.actorLink = !!ship.actorLink;
        if ( !ship.actorLink ) td.delta = foundry.utils.deepClone(ship._source.delta ?? {});
        delete td.flags?.["token-attacher"];
        foundry.utils.setProperty(td, `flags.${MODULE_ID}.hudBuilt`, true);
        foundry.utils.setProperty(td, `flags.${MODULE_ID}.radarSelf`, true);
        const [own] = await scene.createEmbeddedDocuments("Token", [td]);
        if ( own ) rec.core.tokens.push(own.id);
      }
    }
    const tempo = game.actors.getName("HUD-Tempo-Strain");
    if ( tempo ) {
      const p = at(LAYOUT.tempoToken);
      keep(rec.core, await stamp(scene, tempo, p.x, p.y, k));
    }
    const a = at(LAYOUT.area);
    const [areaTile] = await scene.createEmbeddedDocuments("Tile", [{
      texture: { src: tile.texture.src }, x: a.x, y: a.y, width: LAYOUT.area.w * k, height: LAYOUT.area.h * k,
      sort: -100, flags: { [MODULE_ID]: { hudBuilt: true, componentArea: true } }
    }]);
    rec.core.tiles.push(areaTile.id);
  }

  // Crew cards: one per role of each installed station.
  const stations = ship.actor.getFlag(MODULE_ID, "stations") ?? [];
  const seats = stations.flatMap(s => (s.roles ?? []).map(role => ({ role, count: s.count ?? null,
    facing: role === "gunner" ? (s.location ?? s.facing ?? null) : null })))
    .filter(s => ROLE_ORDER.includes(s.role))
    .sort((a, b) => (ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
      || (["command", ...FACINGS].indexOf(a.facing ?? "") - ["command", ...FACINGS].indexOf(b.facing ?? "")));
  const bands = LAYOUT.crewBands.map(b => ({ ...at(b), w: b.w * k, h: b.h * k }));
  const ck = fitScale(seats.length, bands, CREW.w * k, CREW.h * k, CREW.gapX * k, CREW.gapY * k) * k;
  const crewSlots = slots(seats.length, bands, CREW.w, CREW.h, CREW.gapX, CREW.gapY, ck);
  for ( const [i, seat] of seats.entries() ) {
    const tmpl = game.actors.getName(ROLE_ACTOR(seat.role));
    if ( !tmpl ) continue;
    const s = crewSlots[i];
    // The Station-* token sits at the card's top-right corner. Gunner cards are named by facing.
    keep(rec.parts, await stamp(scene, tmpl, s.x + (CREW.w - 100) * ck, s.y, ck, { edit: (type, d, e) => {
      if ( type === "Drawing" && seat.role === "deck" && seat.count ) {
        d.text = `Deck Crew (${seat.count})`;
        d.fontSize = fitWidth([d.text], d.fontFamily ?? "Bruno Ace", d.fontSize, d.shape.width);
        return;
      }
      if ( type !== "Drawing" || !seat.facing ) return;
      d.text = gunnerTitle(seat.facing === "bridge" ? "command" : seat.facing);
      d.fontSize = fitWidth([d.text], d.fontFamily ?? "Bruno Ace", d.fontSize, d.shape.width);
    } }));
  }

  // Component Area: one block per system the ship has, with a plain list of what is in it.
  const area = at(LAYOUT.area);
  const cardTmpl = game.actors.getName("HUD-Component");
  const { componentLibrary } = await import("./starship-designer.mjs");
  const lines = blockLines(ship.actor, await componentLibrary());
  const P = cardTmpl?.prototypeToken.flags["token-attacher"]?.pos?.xy;
  const bgTmpl = cardTmpl?.prototypeToken.flags["token-attacher"]?.prototypeAttached?.Tile?.[0];
  const labelTmpl = cardTmpl?.prototypeToken.flags["token-attacher"]?.prototypeAttached?.Drawing?.[0];
  const titleFont = labelTmpl?.fontFamily ?? "Bruno Ace";
  const placed = foundry.utils.deepClone(BLOCKS);
  // Aft Weapons present: Propulsion moves left so the bottom pair is centered (like C&C + Navigation).
  if ( lines.aft?.length ) placed.propulsion.x = BLOCKS.command.x;
  for ( const [key, block] of Object.entries(placed) ) {
    const list = lines[key];
    if ( !list?.length || !P || !bgTmpl ) continue;
    const bx = area.x + block.x * k, by = area.y + block.y * k, bw = block.w * k;
    const kk = bw / CARD.w;
    const pad = 0.05 * bw;
    const titleH = 0.15 * BLOCKS.bow.w * k;
    // Same type sizes in small and large blocks (sized from a large block).
    const big = BLOCKS.bow.w * k;
    const titleSize = fitWidth([block.label], titleFont, Math.round(0.1 * big), bw - 2 * pad);
    // The block itself: the HUD-Component template (background and border), title at the top.
    const r = await stamp(scene, cardTmpl, bx + (P.x - bgTmpl.x) * kk, by + (P.y - bgTmpl.y) * kk, kk, { token: false,
      edit: (type, d) => {
        if ( type !== "Drawing" ) return;
        Object.assign(d, { x: bx + pad, y: by + 0.02 * bw, text: block.label, fontSize: titleSize });
        d.shape.width = bw - 2 * pad; d.shape.height = titleH;
      } });
    keep(rec.parts, r);
    // The readout: one left-aligned line per entry, shrunk to fit the block.
    const texts = list.map(l => l.text);
    const bodyTop = by + titleH + 0.02 * bw, bodyH = bw - titleH - 0.08 * bw;
    let fs = fitWidth(texts, TEXT_FONT, Math.round(0.055 * big), bw - 2 * pad);
    fs = Math.max(8, Math.min(fs, Math.floor(bodyH / (texts.length * 1.3))));
    const lh = fs * 1.3;
    const docs = texts.map((t, i) => {
      const w = Math.ceil(textWidth(t, TEXT_FONT, fs)) + 6;
      return { x: bx + pad, y: bodyTop + i * lh, shape: { type: "r", width: w, height: lh }, text: t,
        fontFamily: TEXT_FONT, fontSize: fs, textColor: "#ffffff", fillType: CONST.DRAWING_FILL_TYPES.NONE,
        strokeWidth: 0, flags: { [MODULE_ID]: { hudBuilt: true, hudBlock: key } } };
    });
    const made = await scene.createEmbeddedDocuments("Drawing", docs);
    rec.parts.drawings.push(...made.map(d => d.id));
  }

  await tile.setFlag(MODULE_ID, "hud", rec);
  if ( tile.getFlag(MODULE_ID, "hudPending") ) await tile.unsetFlag(MODULE_ID, "hudPending");
  const crew = game.modules.get(MODULE_ID).crew;
  await crew?.reconcileScene?.(scene);
  // A (re)build refills Speed, except during an encounter: there only Maneuver refills it (John, 2026-10-25).
  const fighting = game.modules.get(MODULE_ID).ship?.inCombat?.(ship.actor);
  await crew?.syncSpeed?.(scene, { force: !fighting });
}

async function _teardown(scene, { full }) {
  if ( !isGM() || !scene ) return;
  const tile = displayTile(scene);
  const rec = tile?.getFlag(MODULE_ID, "hud");
  if ( !rec ) return;
  const buckets = full ? [rec.core, rec.parts] : [rec.parts];
  for ( const b of buckets.filter(Boolean) ) {
    const toks = (b.tokens ?? []).filter(id => scene.tokens.has(id));
    if ( toks.length ) await scene.deleteEmbeddedDocuments("Token", toks);
    await sleep(300);   // Token Attacher removes each token's attachments on its own
    const tiles = (b.tiles ?? []).filter(id => scene.tiles.has(id));
    if ( tiles.length ) await scene.deleteEmbeddedDocuments("Tile", tiles);
    const drawings = (b.drawings ?? []).filter(id => scene.drawings.has(id));
    if ( drawings.length ) await scene.deleteEmbeddedDocuments("Drawing", drawings);
  }
  if ( full ) await tile.unsetFlag(MODULE_ID, "hud");
  else await tile.setFlag(MODULE_ID, "hud", { ...rec, parts: { tokens: [], tiles: [], drawings: [] } });
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  mod.hud = { buildHud, refreshHud, teardownHud, shortName };
});

// A HUD marked pending (it couldn't be built where the change happened) is built by the GM viewing the bridge.
function tryPending(scene) {
  const p = displayTile(scene)?.getFlag(MODULE_ID, "hudPending");
  if ( !p || !game.user.isGM || (canvas.scene?.id !== scene?.id) || !hudBuilder(scene)?.isSelf ) return;
  (p === "full" ? buildHud : refreshHud)(scene);
}
Hooks.on("canvasReady", () => tryPending(canvas.scene));
Hooks.on("updateTile", (tile, changes) => {
  if ( foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.hudPending`) ) tryPending(tile.parent);
});

// From crew-stations.mjs: a ship arrived on or left the display.
Hooks.on(`${MODULE_ID}.viewscreenEnter`, tokenDoc => { if ( isGM() ) buildHud(tokenDoc.parent); });
Hooks.on(`${MODULE_ID}.viewscreenLeave`, tokenDoc => {
  if ( !isGM() ) return;
  const rec = displayTile(tokenDoc.parent)?.getFlag(MODULE_ID, "hud");
  if ( rec && (!rec.actorId || rec.actorId === tokenDoc.actorId || rec.actorId === tokenDoc.actor?.id) ) teardownHud(tokenDoc.parent);
});

// The ship's design changed (components added, removed or re-faced): rebuild its cards.
const pending = new Map();
Hooks.on("updateActor", (actor, changes) => {
  if ( !isGM() || actor.type !== "vehicle" ) return;
  const f = changes.flags?.[MODULE_ID];
  if ( !f || !(("stations" in f) || ("analysis" in f) || ("description" in f)) ) return;
  for ( const scene of game.scenes ) {
    if ( displayTile(scene)?.getFlag(MODULE_ID, "hud")?.actorId !== actor.id ) continue;
    clearTimeout(pending.get(scene.id));
    pending.set(scene.id, setTimeout(() => refreshHud(scene), 750));
  }
});
// Re-facing a weapon changes no actor flag; rebuild for that too.
Hooks.on("updateItem", (item, changes) => {
  if ( !isGM() || !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.facing`) ) return;
  const actor = item.parent;
  for ( const scene of game.scenes ) {
    if ( displayTile(scene)?.getFlag(MODULE_ID, "hud")?.actorId !== actor?.id ) continue;
    clearTimeout(pending.get(scene.id));
    pending.set(scene.id, setTimeout(() => refreshHud(scene), 750));
  }
});

/* -------------------------------------------- */
/*  Mishap tokens on the Component Area         */
/* -------------------------------------------- */
// John, 2026-10-25: a Mishap actor dropped (as a token) on a system block of the bridge's Component Area
// is an active Mishap on that system of the ship on the display. Moving the token to another block moves
// the Mishap; moving it off the blocks, or deleting it, removes it. These entries carry the token's id
// (fromToken), so Mishaps recorded another way (MISHAP! alerts, a drop on the ship) are left alone.

/** The Component Area block (system key) under a point on a bridge scene, or null. */
/** A system block's square on the bridge's Component Area, in scene pixels: { x, y, w }, or null. */
export function blockRect(scene, key) {
  const area = scene?.tiles.find(t => t.getFlag(MODULE_ID, "componentArea"));
  if ( !area || !BLOCKS[key] ) return null;
  const k = Math.abs(area.width) / LAYOUT.area.w;
  const b = { ...BLOCKS[key] };
  if ( (key === "propulsion") && scene.drawings.some(d => d.getFlag(MODULE_ID, "hudBlock") === "aft") ) b.x = BLOCKS.command.x;
  return { x: area.x + b.x * k, y: area.y + b.y * k, w: b.w * k };
}

export function blockAt(scene, point) {
  const area = scene?.tiles.find(t => t.getFlag(MODULE_ID, "componentArea"));
  if ( !area ) return null;
  const k = Math.abs(area.width) / LAYOUT.area.w;
  const placed = foundry.utils.deepClone(BLOCKS);
  if ( scene.drawings.some(d => d.getFlag(MODULE_ID, "hudBlock") === "aft") ) placed.propulsion.x = BLOCKS.command.x;
  for ( const [key, b] of Object.entries(placed) ) {
    const x = area.x + b.x * k, y = area.y + b.y * k, w = b.w * k;
    if ( (point.x >= x) && (point.x <= x + w) && (point.y >= y) && (point.y <= y + w) ) return key;
  }
  return null;
}

const mishapOf = tokenDoc => tokenDoc?.actor?.flags?.[MODULE_ID]?.mishap ?? null;

/** Rebuild the display ship's block-placed Mishaps from the Mishap tokens on this bridge (GM). */
async function syncBlockMishaps(scene) {
  if ( !isGM() || !scene ) return;
  const shipToken = shipOnDisplay(scene);
  const crew = game.modules.get(MODULE_ID).crew;
  const ship = crew?.shipActor?.(scene) ?? shipToken?.actor;
  if ( !ship ) return;
  const grid = scene.grid.size;
  const fromTokens = [];
  for ( const t of scene.tokens ) {
    const m = mishapOf(t);
    if ( !m || entryOf(t) ) continue;   // tokens kept by the Mishap-token sync stand for existing entries
    const s = t._source;
    const system = blockAt(scene, { x: s.x + (s.width * grid) / 2, y: s.y + (s.height * grid) / 2 });
    if ( !system ) continue;
    const uuid = t.actor?.flags?.core?.sourceId ?? t.actor?._stats?.compendiumSource ?? null;
    fromTokens.push({ id: `tok${t.id}`, fromToken: t.id, system, uuid, name: t.name, img: t.texture?.src ?? t.actor?.img, tier: m.tier ?? null });
  }
  const list = ship.flags?.[MODULE_ID]?.activeMishaps ?? [];
  const next = [...list.filter(m => !m.fromToken), ...fromTokens];
  const sig = l => JSON.stringify(l.map(m => [m.id, m.system, m.name]).sort());
  if ( sig(next) !== sig(list) ) await ship.update({ [`flags.${MODULE_ID}.activeMishaps`]: next });
}

const blockTimers = new Map();
function scheduleBlockMishaps(scene) {
  if ( !isGM() || !scene?.tiles.some(t => t.getFlag(MODULE_ID, "componentArea")) ) return;
  clearTimeout(blockTimers.get(scene.id));
  blockTimers.set(scene.id, setTimeout(() => serial(() => syncBlockMishaps(scene)), 300));
}
Hooks.on("createToken", doc => { if ( mishapOf(doc) ) scheduleBlockMishaps(doc.parent); });
Hooks.on("deleteToken", doc => { if ( mishapOf(doc) ) scheduleBlockMishaps(doc.parent); });
Hooks.on("updateToken", (doc, changes) => { if ( mishapOf(doc) && (("x" in changes) || ("y" in changes)) ) scheduleBlockMishaps(doc.parent); });
Hooks.on("canvasReady", () => scheduleBlockMishaps(canvas.scene));
Hooks.on(`${MODULE_ID}.viewscreenEnter`, doc => setTimeout(() => scheduleBlockMishaps(doc.parent), 3000));

/* -------------------------------------------- */
/*  Mishaps as tokens on the bridge             */
/* -------------------------------------------- */
// (John, 2026-10-26) On a bridge HUD, every Mishap on the display ship is a token on its system's card, so
// players can see it (name and HP on hover), target it and fight it: Mishaps are the ship's monsters.
//  - The GM keeps the tokens in step with the ship's Mishap list (flags.activeMishaps): one token per entry,
//    flagged mishapEntry = entry id. A new Mishap gets a token; a cleared one loses it.
//  - The token's HP is the Mishap's HP: Correct lowers both; damage dealt to the token lowers the Mishap's HP,
//    and at 0 HP the Mishap is cleared. Deleting the token clears the Mishap; dragging it to another system
//    card moves it there.
//  - Mishaps the GM placed as tokens by hand (fromToken entries) are already tokens and are left alone.

const entryOf = doc => doc?.getFlag?.(MODULE_ID, "mishapEntry") ?? null;
const syncing = new Set();   // entry ids whose tokens the sync itself is deleting

/** A world actor for a Mishap (the compendium one is imported into the Mishaps folder once). */
export async function mishapWorldActor(entry) {
  if ( !entry?.uuid ) return null;
  const src = await fromUuid(entry.uuid);
  if ( !src || (src.documentName !== "Actor") ) return null;
  if ( !src.pack ) return src;
  const have = game.actors.find(a => (a._stats?.compendiumSource ?? a.flags?.core?.sourceId) === entry.uuid);
  if ( have ) return have;
  const folder = game.folders.find(f => (f.type === "Actor") && (f.name === "Mishaps"))
    ?? await Folder.implementation.create({ name: "Mishaps", type: "Actor" });
  return game.actors.importFromCompendium(game.packs.get(src.pack), src.id, { folder: folder.id });
}

/** Where the i-th of n Mishap tokens sits on a system card: { x, y, size } (token top-left, grid units). */
function mishapSpot(scene, system, i, n) {
  const card = blockRect(scene, system);
  if ( !card ) return null;
  const grid = scene.grid.size;
  const px = Math.min(0.3 * card.w, (0.92 * card.w) / Math.max(1, n));
  const size = Math.max(0.5, Math.round((px / grid) * 20) / 20);
  const step = Math.min(size * grid * 1.05, (card.w - size * grid) / Math.max(1, n - 1));
  const rowW = size * grid + step * (n - 1);
  return { x: card.x + (card.w - rowW) / 2 + i * step, y: card.y + card.w - size * grid - 0.05 * card.w, size };
}

async function syncMishapTokens(scene) {
  if ( !isGM() || !scene?.tiles.some(t => t.getFlag(MODULE_ID, "componentArea")) ) return;
  const ship = game.modules.get(MODULE_ID).crew?.shipActor?.(scene) ?? shipOnDisplay(scene)?.actor;
  if ( !ship ) return;
  const list = (ship.flags?.[MODULE_ID]?.activeMishaps ?? []).filter(m => !m.fromToken && blockRect(scene, m.system));
  const ids = new Set(list.map(m => m.id));
  const tokens = scene.tokens.filter(t => entryOf(t));
  // Cleared Mishaps lose their tokens (and duplicates go).
  const seen = new Set(), gone = [];
  for ( const t of tokens ) {
    const id = entryOf(t);
    if ( !ids.has(id) || seen.has(id) ) gone.push(t.id); else seen.add(id);
  }
  if ( gone.length ) {
    gone.forEach(id => syncing.add(entryOf(scene.tokens.get(id))));
    await scene.deleteEmbeddedDocuments("Token", gone);
  }
  // New Mishaps get tokens; every token sits in its card's row with the Mishap's HP.
  const bySystem = {};
  for ( const m of list ) (bySystem[m.system] ??= []).push(m);
  const create = [], update = [];
  for ( const [system, ms] of Object.entries(bySystem) ) {
    for ( const [i, m] of ms.entries() ) {
      const spot = mishapSpot(scene, system, i, ms.length);
      if ( !spot ) continue;
      let tok = scene.tokens.find(t => entryOf(t) === m.id);
      // The Mishap changed into another (Fire Suppression knocked it down a level): replace its token.
      if ( tok && (tok.name !== m.name) ) { syncing.add(m.id); await tok.delete(); tok = null; }
      if ( tok ) {
        const upd = { _id: tok.id };
        if ( (Math.abs(tok.x - spot.x) > 1) || (Math.abs(tok.y - spot.y) > 1) ) Object.assign(upd, { x: spot.x, y: spot.y });
        if ( tok.width !== spot.size ) Object.assign(upd, { width: spot.size, height: spot.size });
        const hp = Number(tok.actor?.system.attributes?.hp?.value);
        if ( (m.hp != null) && (hp !== m.hp) ) upd["delta.system.attributes.hp.value"] = m.hp;
        if ( Object.keys(upd).length > 1 ) update.push(upd);
        continue;
      }
      const actor = await mishapWorldActor(m);
      if ( !actor ) continue;
      const max = Number(actor.system.attributes?.hp?.max) || 20;
      const td = (await actor.getTokenDocument({
        x: spot.x, y: spot.y, width: spot.size, height: spot.size, name: m.name,
        actorLink: false, disposition: CONST.TOKEN_DISPOSITIONS.HOSTILE,
        displayName: CONST.TOKEN_DISPLAY_MODES.HOVER, displayBars: CONST.TOKEN_DISPLAY_MODES.HOVER,
        bar1: { attribute: "attributes.hp" }, lockRotation: true, rotation: 0
      })).toObject();
      foundry.utils.setProperty(td, "texture.src", m.img || td.texture?.src);
      foundry.utils.setProperty(td, `flags.${MODULE_ID}.mishapEntry`, m.id);
      foundry.utils.setProperty(td, `flags.${MODULE_ID}.mishapShip`, ship.uuid);
      foundry.utils.setProperty(td, "delta.system.attributes.hp.value", m.hp ?? max);
      if ( td.ring ) td.ring.enabled = false;
      create.push(td);
    }
  }
  if ( update.length ) await scene.updateEmbeddedDocuments("Token", update, { animate: false });
  if ( create.length ) await scene.createEmbeddedDocuments("Token", create);
}

const mishapTimers = new Map();
export function scheduleMishapTokens(scene) {
  if ( !isGM() || !scene?.tiles.some(t => t.getFlag(MODULE_ID, "componentArea")) ) return;
  clearTimeout(mishapTimers.get(scene.id));
  mishapTimers.set(scene.id, setTimeout(() => serial(() => syncMishapTokens(scene)), 400));
}
/** Bridge scenes showing this ship. */
function bridgesOf(actor) {
  const base = actor?.isToken ? game.actors.get(actor.token?.actorId) : actor;
  return game.scenes.filter(s => s.tiles.some(t => t.getFlag(MODULE_ID, "componentArea"))
    && s.tokens.some(t => t.getFlag(MODULE_ID, "viewSize") && ((t.actor === actor) || (t.actorLink && (t.actorId === base?.id)))));
}
Hooks.on("updateActor", (actor, changes) => {
  if ( (actor.type !== "vehicle") || !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) ) return;
  for ( const s of bridgesOf(actor) ) scheduleMishapTokens(s);
});
Hooks.on("canvasReady", () => scheduleMishapTokens(canvas.scene));

/** The ship and Mishap entry behind a Mishap token. */
async function entryFor(doc) {
  const id = entryOf(doc);
  const ship = id ? await fromUuid(doc.getFlag(MODULE_ID, "mishapShip") ?? "") : null;
  const entry = ship?.flags?.[MODULE_ID]?.activeMishaps?.find(m => m.id === id);
  return entry ? { ship, entry } : null;
}

// Damage to the token is damage to the Mishap; a token dragged to another card moves the Mishap there.
Hooks.on("updateActor", (actor, changes) => {
  if ( actor.isToken && entryOf(actor.token) && foundry.utils.hasProperty(changes, "system.attributes.hp") ) mishapTokenChanged(actor.token, true, false);
});
Hooks.on("updateToken", (doc, changes) => {
  if ( !entryOf(doc) ) return;
  mishapTokenChanged(doc, foundry.utils.hasProperty(changes, "delta.system.attributes.hp"), ("x" in changes) || ("y" in changes));
});
function mishapTokenChanged(doc, hpChanged, moved) {
  if ( !isGM() ) return;
  if ( !hpChanged && !moved ) return;
  serial(async () => {
    const found = await entryFor(doc);
    if ( !found ) return;
    const { ship, entry } = found;
    const S = await import("./ship-state.mjs");
    if ( hpChanged ) {
      const hp = Number(doc.actor?.system.attributes?.hp?.value);
      if ( Number.isFinite(hp) && (hp <= 0) ) {
        await S.removeMishap(ship, entry.id);
        await ChatMessage.implementation.create({ content: `<div class="no-crew-card"><p><strong>${foundry.utils.escapeHTML(entry.name)}</strong> is down to 0 HP: repaired.</p></div>` });
        return;
      }
      if ( Number.isFinite(hp) && (hp !== entry.hp) ) {
        await ship.update({ [`flags.${MODULE_ID}.activeMishaps`]: S.activeMishaps(ship).map(m => m.id === entry.id ? { ...m, hp } : m) });
      }
    }
    if ( moved ) {
      const s = doc._source, grid = doc.parent.grid.size;
      const system = blockAt(doc.parent, { x: s.x + (s.width * grid) / 2, y: s.y + (s.height * grid) / 2 });
      if ( system && (system !== entry.system) ) {
        await ship.update({ [`flags.${MODULE_ID}.activeMishaps`]: S.activeMishaps(ship).map(m => m.id === entry.id ? { ...m, system } : m) });
      }
      scheduleMishapTokens(doc.parent);   // snap back into its card's row
    }
  });
}

// Deleting a Mishap token (not by the sync) clears the Mishap.
Hooks.on("deleteToken", doc => {
  const id = entryOf(doc);
  if ( !isGM() || !id ) return;
  if ( syncing.delete(id) ) return;
  serial(async () => {
    const found = await entryFor(doc);
    if ( found ) await (await import("./ship-state.mjs")).removeMishap(found.ship, id);
  });
});

/* -------------------------------------------- */
/*  Crew who leave their station to Correct     */
/* -------------------------------------------- */
// (John, 2026-10-26) A character who leaves their station to Correct walks there: their token on the bridge
// moves from the station to the Mishap's system card. They go back to their station at the start of the
// ship's next turn (when their actions come back). The station spot is kept on the token (flags.crewHome).

export function bridgeOf(ship) {
  const base = ship?.isToken ? game.actors.get(ship.token?.actorId) : ship;
  const id = base?.getFlag(MODULE_ID, "bridgeSceneId");
  return (id && game.scenes.get(id)) || game.scenes.find(s => s.tokens.some(t => (t.actorId === base?.id) && t.getFlag(MODULE_ID, "viewSize"))) || null;
}

/** Move a crew character's bridge token to the card of the Mishap they are correcting (GM). */
export async function crewToMishap(ship, crewActor, entry) {
  const scene = bridgeOf(ship);
  if ( !scene || !crewActor || !entry ) return;
  const tok = scene.tokens.find(t => (t.actorId === crewActor.id) && !t.getFlag(MODULE_ID, "mishapEntry"));
  const card = blockRect(scene, entry.system);
  if ( !tok || !card ) return;
  const grid = scene.grid.size, w = tok.width * grid;
  // Crew already working on this card stand side by side above the Mishap row.
  const here = scene.tokens.filter(t => t.getFlag(MODULE_ID, "crewHome") && (t.id !== tok.id)
    && (blockAt(scene, { x: t.x + t.width * grid / 2, y: t.y + t.height * grid / 2 }) === entry.system)).length;
  const x = card.x + Math.min(card.w - w, 0.08 * card.w + here * (w * 0.75));
  const y = card.y + 0.28 * card.w;
  const home = tok.getFlag(MODULE_ID, "crewHome") ?? { x: tok.x, y: tok.y, shipUuid: ship.uuid };
  await tok.update({ x, y, [`flags.${MODULE_ID}.crewHome`]: home });
}

/** Send every crew token that left its station back to it (GM). */
export async function crewHome(ship) {
  const scene = bridgeOf(ship);
  if ( !scene ) return;
  const back = scene.tokens.filter(t => t.getFlag(MODULE_ID, "crewHome")).map(t => {
    const h = t.getFlag(MODULE_ID, "crewHome");
    return { _id: t.id, x: h.x, y: h.y, [`flags.${MODULE_ID}.-=crewHome`]: null };
  });
  if ( back.length ) await scene.updateEmbeddedDocuments("Token", back);
}
