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

const isActiveGM = () => game.users.activeGM?.isSelf ?? false;

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

Hooks.once("init", () => {
  CONFIG.DND5E.featureTypes[FEATURE_TYPE] = { label: "Crew Role" };
  game.modules.get(MODULE_ID).crew = { reconcileScene, reconcileActor, readStat, applyCost, adjustStat, ROLE_ITEMS };
});

/* -------------------------------------------- */
/*  Scene helpers                               */
/* -------------------------------------------- */

/** The drawing on a scene tagged with the given Tagger tag (case-insensitive). */
function statDrawing(scene, tag) {
  tag = tag.toLowerCase();
  return scene?.drawings.find(d => (d.flags?.tagger?.tags ?? []).some(t => String(t).toLowerCase() === tag));
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

/** Station keys of every station region that contains this token's center. */
function stationsForToken(tokenDoc, pos = {}) {
  const scene = tokenDoc.parent;
  const out = new Set();
  if ( !scene ) return out;
  const size = scene.grid.size;
  // During updateToken in v13 the document can still report its pre-move position,
  // so callers pass the new coordinates from the change data.
  const x = pos.x ?? tokenDoc.x;
  const y = pos.y ?? tokenDoc.y;
  const point = {
    x: x + (tokenDoc.width * size) / 2,
    y: y + (tokenDoc.height * size) / 2,
    elevation: pos.elevation ?? tokenDoc.elevation ?? 0
  };
  for ( const region of scene.regions ) {
    const key = region.getFlag(MODULE_ID, "station");
    if ( !key || !ROLE_ITEMS[key] ) continue;
    let inside = false;
    try { inside = region.testPoint(point); }
    catch(err) { inside = region.testPoint({ x: point.x, y: point.y }, point.elevation); }
    if ( inside ) out.add(key);
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
  try { await tokenDoc.object?.movementAnimationPromise; } catch(err) { /* animation was cancelled */ }
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
      [`flags.${MODULE_ID}.stationSize`]: { width: tokenDoc.width, height: tokenDoc.height }
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

const sceneHasStations = scene => scene?.regions.some(r => r.getFlag(MODULE_ID, "station"));
const sceneHasRadar = scene => scene?.regions.some(r => r.getFlag(MODULE_ID, "radar"));
const sceneHasViewscreen = scene => scene?.regions.some(r => r.getFlag(MODULE_ID, "viewscreen"));

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
  return scene.regions.some(region => {
    if ( !region.getFlag(MODULE_ID, flag) ) return false;
    try { return region.testPoint(point); }
    catch(err) { return region.testPoint({ x: point.x, y: point.y }, point.elevation); }
  });
}

/** Center of the first region carrying the given module flag (from its first shape). */
function flaggedRegionCenter(scene, flag) {
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
    [`flags.${MODULE_ID}.viewSize`]: { width: src.width, height: src.height, displayName: src.displayName }
  }, { animate: false, neonOdysseyResize: true });
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
});
Hooks.on("deleteToken", tokenDoc => {
  if ( isActiveGM() && (tokenDoc.actor?.type === "vehicle") ) enqueue(() => syncGauges(tokenDoc.parent));
  if ( !isActiveGM() || !sceneHasStations(tokenDoc.parent) ) return;
  // A deleted unlinked token takes its synthetic actor with it; only linked actors need cleanup.
  const actor = tokenDoc.actorLink ? game.actors.get(tokenDoc.actorId) : null;
  if ( actor ) enqueue(() => reconcileActor(actor, tokenDoc.parent));
});
Hooks.on("updateRegion", region => {
  if ( isActiveGM() && sceneHasStations(region.parent) ) enqueue(() => reconcileScene(region.parent));
});
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
  const hasTag = (doc, tag) => (doc.flags?.tagger?.tags ?? []).some(t => String(t).toLowerCase() === tag);
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
  const tags = (drawing.flags?.tagger?.tags ?? []).map(t => String(t).toLowerCase());
  if ( tags.includes("tempo") || tags.includes("strain") ) enqueue(() => syncGauges(drawing.parent));
});
Hooks.on("updateActor", (actor, changes) => {
  if ( !isActiveGM() || (actor.type !== "vehicle") ) return;
  if ( foundry.utils.hasProperty(changes, "system.attributes.hp") ) enqueue(() => syncGauges(canvas.scene));
});
Hooks.on("canvasReady", () => {
  if ( isActiveGM() ) enqueue(() => syncGauges(canvas.scene));
});
// On the first load the active GM isn't settled yet when canvasReady fires, so sync again at ready.
Hooks.once("ready", () => {
  if ( !isActiveGM() || !canvas.scene ) return;
  enqueue(() => syncGauges(canvas.scene));
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
