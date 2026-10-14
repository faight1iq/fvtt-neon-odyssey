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
  if ( !isGM() || !scene ) return;
  const tile = displayTile(scene);
  const ship = shipOnDisplay(scene);
  if ( !tile || !ship?.actor ) return;
  if ( canvas.scene?.id !== scene.id ) {
    ui.notifications.warn("Ship HUD: open the bridge scene to build its HUD.");
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
  const crew = game.modules.get(MODULE_ID).crew;
  await crew?.reconcileScene?.(scene);
  await crew?.syncSpeed?.(scene, { force: true });
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
