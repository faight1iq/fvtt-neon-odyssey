// Sector map + local ship HUD (John, 2026-10-25). Spec: claude/sector-map-hud-spec.md (Paradox RPG project).
//
//  * Click (select) a ship on a sector map (a scene with "Sector Map" ticked in its configuration) to get a HUD on your own
//    screen around the ship:
//      - Pilot HUD (crew with the Helmsman role: Pilot, Copilot, Helmsman): Tempo / Strain / Speed with
//        up/down arrows, turn left / forward / turn right, the crew's action buttons, Go to Bridge, and
//        the character sheet.
//      - Commander HUD (other crew): the same without the movement buttons.
//      - Ships with no crew record (enemy, neutral or friendly NPC ships), for the GM: the ship's own
//        Crew Role actions, offered by the
//        systems it has, rolled with its crew bonuses.
//    Actions whose system is Offline show a red X and can't be used. The HUD keeps its size on screen.
//  * Players can't drag ship tokens; they move only through the HUD.
//  * Mishap icons sit on every ship token at the spot of the struck system, for everyone (the GM can hide
//    them per ship). Hover names the Mishap. On a bridge scene they can be clicked (open the Mishap) and,
//    for the GM, right-clicked (Repaired); a Mishap dragged onto a ship there is added to it. One Mishap on a
//    system Impairs it; the ship size in Mishaps (Tiny 1 … Gargantuan 6) puts it Offline (red frame, and a red X on the actions it grants).
//  * Bridge scenes get a "Go to Sector Map" button on the ship display, and the GM a gear to pick the ship's
//    sector map (flags.sectorSceneId) from the scenes tagged Sector Map.

import { MODULE_ID, systemOffline, countsTowardOffline, getState, shipSpeed, nextFacingCost, nextForwardCost, shipSystems, activeMishaps, roleOffline,
  roleAvailable, crewOf, userCrew, crewBonus, stationCheck, sectorToken, sectorScene, pickSectorScene, bridgeScene, isBridgeScene, isSectorScene, viewScene, request,
  useForShip, addMishap, SYSTEM_LABELS, baseActor, mustManeuver, canUse, crewKey } from "./ship-state.mjs";
import { ROLE_ITEMS } from "./crew-stations.mjs";
import { blockRect } from "./ship-hud.mjs";

const PACK_ID = `${MODULE_ID}.class-features`;
const ROLE_ORDER = ["any", "commander", "helmsman", "navigator", "engineer", "gunner", "medic", "cook"];
const ROLE_LABEL = { any: "Any Station", commander: "Commander", helmsman: "Helmsman", navigator: "Navigator", engineer: "Engineer", gunner: "Gunner",
  medic: "Medic", cook: "Cook" };
/** Action buttons under the ship: at most 9 columns and 3 rows (John, 2026-10-25). */
const ACTION_COLUMNS = 9;
const MAX_ACTIONS = ACTION_COLUMNS * 3;
const esc = s => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const strip = html => { const d = document.createElement("div"); d.innerHTML = html ?? ""; return d.textContent ?? ""; };

/* -------------------------------------------- */
/*  Which HUD a user gets                       */
/* -------------------------------------------- */

/**
 * @returns {{mode: "crew"|"npc"|"gm"|"observer", pilot: boolean, crew: Array<{actor, roles}>}}
 */
function hudMode(tokenDoc, user = game.user) {
  const ship = tokenDoc.actor;
  const crew = userCrew(baseActor(ship) ?? ship, user);
  const hasCrew = Object.values(crewOf(baseActor(ship) ?? ship)).some(r => r?.length);
  if ( crew.length ) return { mode: "crew", crew, pilot: crew.some(c => c.roles.includes("helmsman")) };
  if ( user.isGM && !hasCrew ) return { mode: "npc", crew: [], pilot: roleAvailable(ship, "helmsman") };
  if ( user.isGM ) return { mode: "gm", crew: [], pilot: true };
  return { mode: "observer", crew: [], pilot: false };
}

/** The action buttons: [{ item, activity, role, offline }] in role order, at most MAX_ACTIONS for the mode. */
function actionsFor(tokenDoc, info) {
  const ship = tokenDoc.actor;
  const out = [];
  let sources = info.mode === "npc" ? [{ actor: ship, roles: ROLE_ORDER.filter(r => roleAvailable(ship, r)) }]
    : info.mode === "crew" ? info.crew : [];
  if ( info.mode === "crew" ) {
    // Each crew member gets their own buttons (their own Action economy). The GM's HUD leaves out
    // characters a logged-in player runs (John, 2026-10-25: he plays Shaddahp, the GM runs the rest).
    const playerRuns = a => game.users.some(u => u.active && !u.isGM && a.testUserPermission(u, "OWNER"));
    if ( game.user.isGM ) sources = sources.filter(c => !playerRuns(c.actor));
    const main = c => Math.min(...c.roles.filter(r => r !== "any").map(r => ROLE_ORDER.indexOf(r)).filter(i => i >= 0), 99);
    sources = [...sources].sort((a, b) => main(a) - main(b));
  }
  for ( const { actor, roles } of sources ) {
    const items = actor.items.filter(i => i.getFlag(MODULE_ID, "crewRole") && roles.includes(i.getFlag(MODULE_ID, "crewRole")));
    // The station's own actions first, then Any Station (Gain Tempo, Correct).
    const order = r => r === "any" ? 98 : ROLE_ORDER.indexOf(r);
    items.sort((a, b) => order(a.getFlag(MODULE_ID, "crewRole")) - order(b.getFlag(MODULE_ID, "crewRole")));
    for ( const item of items ) {
      const role = item.getFlag(MODULE_ID, "crewRole");
      for ( const activity of item.system.activities ) {
        if ( out.some(o => o.actor === actor && o.item.getFlag(MODULE_ID, "crewRole") === role && o.activity.id === activity.id) ) continue;
        // Any Station buttons say whose they are (several crew each have Gain Tempo and Correct).
        const mainRole = roles.find(r => r !== "any");
        const tag = (info.mode === "crew") && (role === "any") ? (mainRole ? (ROLE_LABEL[mainRole] ?? mainRole).slice(0, 4) : "Deck") : "";
        out.push({ actor, item, activity, role, tag, offline: roleOffline(ship, role) });
      }
    }
  }
  return out.slice(0, MAX_ACTIONS);
}

/** Enemy ships carry Crew Role items of their own, for the roles their systems allow (GM). */
async function ensureShipRoles(tokenDoc) {
  const ship = tokenDoc.actor;
  if ( !game.user.isGM || !ship ) return;
  const wanted = ROLE_ORDER.filter(r => roleAvailable(ship, r));
  const have = new Set(ship.items.map(i => i.getFlag(MODULE_ID, "crewRole")).filter(Boolean));
  const missing = wanted.filter(r => !have.has(r) && ROLE_ITEMS[r]);
  const extra = ship.items.filter(i => i.getFlag(MODULE_ID, "crewRole") && !wanted.includes(i.getFlag(MODULE_ID, "crewRole"))).map(i => i.id);
  if ( extra.length ) await ship.deleteEmbeddedDocuments("Item", extra);
  if ( !missing.length ) return;
  const pack = game.packs.get(PACK_ID);
  const docs = await Promise.all(missing.map(r => pack?.getDocument(ROLE_ITEMS[r])));
  const data = docs.filter(Boolean).map(d => {
    const obj = game.items.fromCompendium(d, { keepId: false });
    foundry.utils.setProperty(obj, `flags.${MODULE_ID}.crewRole`, d.getFlag(MODULE_ID, "crewRole"));
    return obj;
  });
  if ( data.length ) await ship.createEmbeddedDocuments("Item", data);
}

/* -------------------------------------------- */
/*  The local HUD                               */
/* -------------------------------------------- */

class ShipHud {
  /** @type {TokenDocument|null} */
  static tokenDoc = null;
  /** @type {HTMLElement|null} */
  static el = null;

  static async open(tokenDoc) {
    this.tokenDoc = tokenDoc;
    if ( game.user.isGM && (hudMode(tokenDoc).mode === "npc") ) {
      try { await ensureShipRoles(tokenDoc); } catch(err) { console.error(`${MODULE_ID} | enemy roles`, err); }
    }
    if ( this.tokenDoc !== tokenDoc ) return;   // closed or switched while waiting
    if ( hudMode(tokenDoc).mode !== "npc" ) { try { checkCrewItems(tokenDoc.actor); } catch(err) { console.error(`${MODULE_ID} | crew check`, err); } }
    this.render();
  }

  static close(tokenDoc = null) {
    if ( tokenDoc && (this.tokenDoc?.id !== tokenDoc.id) ) return;
    this.tokenDoc = null;
    this.el?.remove();
    this.el = null;
  }

  static get token() { return this.tokenDoc?.object ?? null; }

  static render() {
    const t = this.tokenDoc;
    if ( !t || !t.parent?.isView || !t.actor ) return this.close();
    const ship = t.actor;
    const info = hudMode(t);
    const st = getState(ship);
    const max = shipSpeed(ship);
    const canAdjust = game.user.isGM || info.mode === "crew";
    const propOff = roleOffline(ship, "helmsman");
    const noHelm = !propOff && mustManeuver(ship);   // in combat: Maneuver first (John, 2026-10-25)
    const actions = actionsFor(t, info);
    const systems = shipSystems(ship);
    const shields = ship.flags?.[MODULE_ID]?.shield?.charges;

    const stat = (key, label, value, extra = "", after = "") => `
      <div class="nsh-stat nsh-${key}">
        ${canAdjust ? `<div class="nsh-arrows">
          <a data-nsh="adjust" data-stat="${key}" data-delta="1" data-tooltip="${label} +1"><i class="fa-solid fa-angles-up"></i></a>
          <a data-nsh="adjust" data-stat="${key}" data-delta="-1" data-tooltip="${label} −1"><i class="fa-solid fa-angles-down"></i></a>
        </div>` : ""}
        <div class="nsh-hex"><span class="nsh-val">${value}</span>${extra}<label>${label.toUpperCase()}</label></div>${after}
      </div>`;

    const moveBtn = (move, icon, label, cost) => `
      <button type="button" class="nsh-move nsh-mv-${move}${propOff ? " nsh-off" : ""}" data-nsh="steer" data-move="${move}"
        ${(propOff || noHelm || st.speed < cost) ? "disabled" : ""} data-tooltip="${label}: ${cost} Speed${propOff ? " (Propulsion Offline)" : noHelm ? " (use Maneuver first)" : ""}">
        <i class="fa-solid ${icon}"></i><span class="nsh-cost">${cost}</span></button>`;

    const actionBtn = (a, i) => {
      const cost = strip(a.activity.description?.chatFlavor).replace(/\s+/g, " ").trim();
      // Action economy (John, 2026-10-25): a used Action greys out that station's other Actions.
      const gate = a.offline ? { ok: true } : canUse(ship, a.actor, a.role, a.activity);
      const who = (a.actor?.type === "character") ? ` — ${esc(a.actor.name)}` : "";
      const tip = `<strong>${esc(a.activity.name)}</strong> (${ROLE_LABEL[a.role] ?? a.role})${who}${a.offline ? " — <strong>OFFLINE</strong>" : ""}${gate.ok ? "" : ` — <em>${esc(gate.why)}</em>`}<br>${esc(cost)}`;
      return `<button type="button" class="nsh-act${a.offline ? " nsh-off" : ""}${gate.ok ? "" : " nsh-used"}" data-nsh="act" data-index="${i}" ${(a.offline || !gate.ok) ? "disabled" : ""}
        data-tooltip="${esc(tip)}" style="background-image:url('${a.item.img}')"><span class="nsh-act-name">${esc(a.activity.name)}${a.tag ? ` · ${esc(a.tag)}` : ""}</span></button>`;
    };

    // A ship the GM runs (no crew record) is named by its token's disposition (John, 2026-10-25).
    const D = CONST.TOKEN_DISPOSITIONS;
    const npcTitle = t.disposition === D.FRIENDLY ? "Friendly Ship" : t.disposition === D.HOSTILE ? "Enemy Ship"
      : t.disposition === D.SECRET ? "Secret Ship" : "Neutral Ship";
    const title = info.mode === "npc" ? npcTitle : info.mode === "gm" ? "GM" : info.mode === "observer" ? "Ship" : (info.pilot ? "Pilot HUD" : "Commander HUD");
    const hidden = !!ship.flags?.[MODULE_ID]?.hideMishaps;
    // Rally's Command die (John, 2026-10-25): a die this user's crew holds, armed for the next d20 roll.
    const held = ship.flags?.[MODULE_ID]?.commandDice ?? {};
    const mine = info.mode === "crew" ? info.crew.map(c => c.actor?.id).filter(k => held[k]) : (game.user.isGM ? Object.keys(held) : []);
    const dieKey = mine[0], fire = game.modules.get(MODULE_ID).fire;
    const armed = dieKey && fire?.armedDie?.key === dieKey;
    const dieBtn = dieKey ? `<button type="button" class="nsh-side-btn${armed ? " nsh-armed" : ""}" data-nsh="die" data-key="${dieKey}"
      data-tooltip="Command die ${held[dieKey].die} (${esc(held[dieKey].name)}): ${armed ? "armed for the next roll; click to disarm" : "click to arm for the next attack, check or save"}"><i class="fa-solid fa-dice-d20"></i></button>` : "";
    const html = `
      <div class="nsh-title">${esc(t.name)} <small>${title}</small></div>
      <div class="nsh-left">
        ${systems.has("shields") ? `<div class="nsh-shield" data-tooltip="Shields${shields ? `: ${shields} charges per facing` : ""}"><i class="fa-solid fa-shield-halved"></i></div>` : ""}
        ${stat("tempo", "Tempo", st.tempo)}
        ${stat("strain", "Strain", st.strain)}
        ${stat("speed", "Speed", st.speed, `<span class="nsh-max">/${max}</span>`,
          game.user.isGM ? `<a class="nsh-refill" data-nsh="refill" data-tooltip="GM: refill Speed to ${max} (as if Maneuver were used)"><i class="fa-solid fa-rotate"></i></a>` : "")}
      </div>
      <div class="nsh-side">
        ${bridgeScene(ship) ? `<button type="button" class="nsh-side-btn" data-nsh="bridge" data-tooltip="Go to Bridge"><i class="fa-solid fa-display"></i></button>` : ""}
        <button type="button" class="nsh-side-btn nsh-sheet" data-nsh="sheet" data-tooltip="${info.mode === "crew" ? "Character sheet" : "Ship sheet"}"><i class="fa-solid fa-id-card"></i></button>
        ${info.mode === "npc" ? `<button type="button" class="nsh-side-btn" data-nsh="bonus" data-tooltip="Crew bonuses"><i class="fa-solid fa-users-gear"></i></button>` : ""}
        ${dieBtn}
        ${game.user.isGM ? `<button type="button" class="nsh-side-btn" data-nsh="hide" data-tooltip="${hidden ? "Show Mishap icons to players" : "Hide Mishap icons from players"}"><i class="fa-solid ${hidden ? "fa-eye-slash" : "fa-eye"}"></i></button>` : ""}
      </div>
      <div class="nsh-bottom">
        ${info.pilot && (info.mode !== "observer") ? `<div class="nsh-moves">
          ${moveBtn("left", "fa-rotate-left", "Turn left one facing", nextFacingCost(st.facings))}
          ${moveBtn("forward", "fa-angles-up", "Forward one hex", nextForwardCost(st.bands))}
          ${moveBtn("right", "fa-rotate-right", "Turn right one facing", nextFacingCost(st.facings))}
        </div>` : ""}
        ${actions.length ? `<div class="nsh-actions" style="grid-template-columns: repeat(${Math.min(ACTION_COLUMNS, actions.length)}, 48px)">${actions.map(actionBtn).join("")}</div>` : ""}
      </div>`;

    if ( !this.el ) {
      this.el = document.createElement("div");
      this.el.id = "no-ship-hud";
      this.el.addEventListener("click", ev => this.#onClick(ev));
      this.el.addEventListener("contextmenu", ev => ev.preventDefault());
      document.body.append(this.el);
    }
    this.el.innerHTML = html;
    this.el.classList.toggle("nsh-pilot", info.pilot);
    this._actions = actions;
    this._info = info;
    this.position();
  }

  /** Keep the HUD around the ship: stats on the left, buttons under it. Fixed size on screen. */
  static position() {
    const token = this.token;
    if ( !this.el || !token ) return;
    const rect = canvas.app.view.getBoundingClientRect();
    const p = toScreen(token.center);
    const scale = canvas.stage.scale.x;
    const r = Math.max(24, (Math.max(token.w, token.h) / 2) * scale);
    this.el.style.left = `${rect.left + p.x}px`;
    this.el.style.top = `${rect.top + p.y}px`;
    this.el.style.setProperty("--nsh-r", `${r}px`);
  }

  static async #onClick(ev) {
    const a = ev.target.closest("[data-nsh]");
    if ( !a || a.disabled ) return;
    ev.preventDefault();
    ev.stopPropagation();
    const t = this.tokenDoc;
    const ship = t?.actor;
    if ( !ship ) return;
    switch ( a.dataset.nsh ) {
      case "adjust": return request({ action: "adjust", uuid: ship.uuid, stat: a.dataset.stat, delta: Number(a.dataset.delta) });
      case "refill": return request({ action: "refill", uuid: ship.uuid });
      case "steer": {
        const res = await request({ action: "steer", uuid: t.uuid, move: a.dataset.move });
        if ( res?.ok ) setTimeout(() => announceSolutions(t), 300);
        return res;
      }
      case "act": {
        const entry = this._actions?.[Number(a.dataset.index)];
        if ( !entry || entry.offline ) return;
        const gate = canUse(ship, entry.actor, entry.role, entry.activity);
        if ( !gate.ok ) return ui.notifications.warn(`${entry.activity.name}: ${gate.why}.`);
        const key = crewKey(ship, entry.actor, entry.role);
        const used = await useForShip(ship, entry.activity);
        if ( !used ) return;   // cancelled
        if ( gate.slot ) await request({ action: "useSlot", uuid: ship.uuid, key, slot: gate.slot, name: entry.activity.name });
        if ( entry.activity.name === "Orders" ) await ordersDialog(ship, this._actions);
        return used;
      }
      case "bridge": return viewScene(bridgeScene(ship));
      case "sheet": {
        const who = this._info?.mode === "crew" ? (this._info.crew.find(c => c.actor === game.user.character)?.actor ?? this._info.crew[0].actor) : ship;
        return who?.sheet?.render(true);
      }
      case "bonus": return crewBonusDialog(ship);
      case "die": {
        const held = ship.flags?.[MODULE_ID]?.commandDice?.[a.dataset.key];
        if ( held ) game.modules.get(MODULE_ID).fire?.armDie(ship, a.dataset.key, held.die);
        return this.render?.();
      }
      case "hide": return ship.setFlag(MODULE_ID, "hideMishaps", !ship.flags?.[MODULE_ID]?.hideMishaps);
    }
  }
}

/**
 * After a move: pause and resolve (John, 2026-10-25). Tell the user about firing solutions the move opened,
 * for the moving ship and against it. The moving ship fires first; a target with a solution back can return
 * fire as its Gunner's Reaction.
 */
function announceSolutions(tokenDoc) {
  const fire = game.modules.get(MODULE_ID).fire;
  if ( !fire || !tokenDoc?.parent ) return;
  const mine = fire.firingSolutions(tokenDoc);
  const back = tokenDoc.parent.tokens.filter(o => o.id !== tokenDoc.id && o.actor?.type === "vehicle")
    .flatMap(o => fire.firingSolutions(o).filter(s => s.target.id === tokenDoc.id));
  const sig = JSON.stringify([mine.map(s => [s.item.id, s.target.id]), back.map(s => [s.item.id, s.target.id])]);
  if ( (sig === tokenDoc._noSolSig) || (!mine.length && !back.length) ) { tokenDoc._noSolSig = sig; return; }
  tokenDoc._noSolSig = sig;
  const names = list => [...new Set(list.map(s => s.target.name))].join(", ");
  const parts = [];
  if ( mine.length ) parts.push(`${tokenDoc.name} can fire on ${names(mine)}`);
  if ( back.length ) parts.push(`${[...new Set(back.map(s => s.item.parent?.name))].join(", ")} can fire on ${tokenDoc.name}`);
  ui.notifications.info(`Firing solution: ${parts.join("; ")}.`, { permanent: false });
}

/** Crew characters missing the Crew Role items their crew record says they have: ask the GM to re-check. */
function checkCrewItems(ship) {
  const crew = crewOf(baseActor(ship) ?? ship);
  const missing = Object.entries(crew).some(([id, roles]) => {
    const a = game.actors.get(id);
    if ( !a ) return false;
    const have = new Set(a.items.map(i => i.getFlag(MODULE_ID, "crewRole")).filter(Boolean));
    return (roles ?? []).some(r => ROLE_ITEMS[r] && !have.has(r));
  });
  if ( missing ) request({ action: "crewCheck", uuid: (baseActor(ship) ?? ship).uuid });
}

/** Orders: one station that has already used its Action takes one more. */
async function ordersDialog(ship, actions) {
  const { econOf } = await import("./ship-state.mjs");
  const econ = econOf(ship);
  const seen = new Map();
  for ( const a of actions ?? [] ) {
    const key = crewKey(ship, a.actor, a.role);
    if ( !econ[key]?.action || seen.has(key) ) continue;
    seen.set(key, a.actor?.type === "character" ? a.actor.name : (ROLE_LABEL[a.role] ?? key));
  }
  if ( !seen.size ) return ui.notifications.info("Orders: no station has used its Action yet.");
  const opts = [...seen].map(([k, n]) => `<option value="${esc(k)}">${esc(n)}</option>`).join("");
  const key = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Orders: who takes another Action?" },
    content: `<div class="form-group"><label>Station</label><select name="key">${opts}</select></div>`,
    ok: { label: "Order", callback: (event, button) => button.form.elements.key.value },
    rejectClose: false
  });
  if ( key ) await request({ action: "freeAction", uuid: ship.uuid, key });
}

/** GM: set an enemy ship's crew quality and per-station bonuses. */
async function crewBonusDialog(ship) {
  const b = ship.flags?.[MODULE_ID]?.crewBonus ?? {};
  const field = (k, label, placeholder) => `<div class="form-group"><label>${label}</label>
    <input type="number" name="${k}" value="${b[k] ?? ""}" placeholder="${placeholder}"></div>`;
  const q = crewBonus(ship, "any");
  const content = `<p>Crew quality stands in for a crew member's ability + PB; the ship's PB is added on station checks.
    A Crew item on the ship (Green +2, Regular +4, Veteran +6, Elite +8) sets the quality. Leave a station blank to use it.</p>
    ${field("quality", "Crew quality (no Crew item)", 2)}
    ${["commander", "helmsman", "navigator", "engineer", "gunner"].map(r => field(r, ROLE_LABEL[r], q)).join("")}`;
  const data = await foundry.applications.api.DialogV2.prompt({
    window: { title: `Crew Bonuses: ${ship.name}` }, content,
    ok: { label: "Save", callback: (event, button) => Object.fromEntries(["quality", "commander", "helmsman", "navigator", "engineer", "gunner"]
      .map(k => [k, button.form.elements[k].value === "" ? null : Number(button.form.elements[k].value)])) },
    rejectClose: false
  });
  if ( data ) await ship.update({ [`flags.${MODULE_ID}.crewBonus`]: data });
}

/* -------------------------------------------- */
/*  HUD hooks                                   */
/* -------------------------------------------- */

const isShipToken = doc => doc?.actor?.type === "vehicle";

/**
 * Canvas point to screen pixels, from the stage's pivot, scale and position. During and right after a
 * pan the stage's worldTransform hasn't been recomputed yet, so it would give the previous frame.
 */
function toScreen(pt) {
  const st = canvas.stage;
  return { x: (pt.x - st.pivot.x) * st.scale.x + st.position.x, y: (pt.y - st.pivot.y) * st.scale.y + st.position.y };
}

Hooks.on("controlToken", (token, controlled) => {
  const doc = token.document;
  if ( !isShipToken(doc) || !isSectorScene(doc.parent) ) return;
  if ( controlled ) ShipHud.open(doc);
  else ShipHud.close(doc);
});
Hooks.on("canvasTearDown", () => ShipHud.close());
Hooks.on("canvasPan", () => ShipHud.position());
Hooks.on("refreshToken", token => { if ( token.document === ShipHud.tokenDoc ) ShipHud.position(); });
window.addEventListener("resize", () => ShipHud.position());
Hooks.on("deleteToken", doc => ShipHud.close(doc));
Hooks.on("updateToken", doc => { if ( doc === ShipHud.tokenDoc ) ShipHud.render(); });

// Re-render when the ship, its crew or their role items change.
const touchesHud = actor => {
  const t = ShipHud.tokenDoc;
  if ( !t || !actor ) return false;
  if ( (actor === t.actor) || (baseActor(actor) === baseActor(t.actor)) ) return true;
  return !!crewOf(baseActor(t.actor) ?? t.actor)[actor.id];
};
let renderTimer = null;
const rerender = () => { clearTimeout(renderTimer); renderTimer = setTimeout(() => ShipHud.render(), 50); };
Hooks.on("updateActor", actor => { if ( touchesHud(actor) ) rerender(); });
// The move buttons depend on the encounter (Maneuver first while in combat).
for ( const h of ["updateCombat", "deleteCombat", "createCombatant", "deleteCombatant"] ) Hooks.on(h, () => { if ( ShipHud.tokenDoc ) rerender(); });
for ( const h of ["createItem", "deleteItem", "updateItem"] ) Hooks.on(h, item => { if ( touchesHud(item.parent) ) rerender(); });

// Players move ships only through the HUD (John, 2026-10-25). The GM can still drag them.
Hooks.on("preUpdateToken", (doc, changes, options) => {
  if ( game.user.isGM || !isShipToken(doc) || !isSectorScene(doc.parent) ) return;
  if ( !("x" in changes) && !("y" in changes) && !("rotation" in changes) ) return;
  ui.notifications.warn("Move your ship with the HUD's turn and forward buttons.");
  return false;
});

/* -------------------------------------------- */
/*  Enemy checks                                */
/* -------------------------------------------- */

// An enemy ship's action card gets a crew check to click (d20 + that station's crew bonus).
Hooks.on("dnd5e.preCreateUsageMessage", (activity, messageConfig) => {
  const actor = activity?.item?.actor;
  const role = activity?.item?.getFlag(MODULE_ID, "crewRole");
  if ( (actor?.type !== "vehicle") || !role || !messageConfig.data?.content ) return;
  // Station actions roll a station check (crew quality + the ship's PB); Any Station actions crew quality only.
  const chk = role === "any" ? { bonus: crewBonus(actor, "any"), dice: "1d20", impaired: "" } : stationCheck(actor, null, role);
  messageConfig.data.content += `<div class="no-crew-check">Crew check: [[/r ${chk.dice} + ${chk.bonus} # ${ROLE_LABEL[role] ?? role} check${chk.impaired ? `, Disadvantage: ${chk.impaired}` : ""}]]</div>`;
});

/* -------------------------------------------- */
/*  Mishap icons on ship tokens                 */
/* -------------------------------------------- */

/** Where each system's icons sit on the ship, as fractions of the token box, nose up. */
const SPOTS = {
  bow: [0.5, 0.12], command: [0.36, 0.3], navigation: [0.64, 0.3],
  port: [0.2, 0.5], habitat: [0.5, 0.5], starboard: [0.8, 0.5],
  power: [0.5, 0.68], propulsion: [0.5, 0.88], aft: [0.75, 0.88]
};
/** Armor, Hull and Shields: a column beside the ship's top-left corner (not rotated). */
const COLUMN = { shields: 0, armor: 1, hull: 2 };

let tip = null;
function showTip(text, x, y) {
  tip ??= Object.assign(document.createElement("div"), { id: "no-mishap-tip" });
  if ( !tip.isConnected ) document.body.append(tip);
  tip.innerHTML = text;
  tip.style.left = `${x + 14}px`;
  tip.style.top = `${y + 14}px`;
  tip.style.display = "block";
}
const hideTip = () => { if ( tip ) tip.style.display = "none"; };

function drawMishaps(token) {
  const doc = token.document;
  const actor = doc.actor;
  if ( !isShipToken(doc) || !actor ) return;
  const list = activeMishaps(actor);
  const hidden = !!actor.flags?.[MODULE_ID]?.hideMishaps;
  const show = list.length && (!hidden || game.user.isGM);
  // On the bridge, the display ship's Mishaps sit on the Component Area cards, one row per system card
  // (John, 2026-10-25). Elsewhere (sector maps, radar) they sit on the ship.
  const onCards = isBridgeScene(doc.parent) && !!doc.getFlag(MODULE_ID, "viewSize");
  // A bridge with a Component Area shows its Mishaps as tokens on the cards instead (ship-hud).
  const asTokens = onCards && doc.parent.tiles.some(t => t.getFlag(MODULE_ID, "componentArea"));
  const cardOf = system => onCards ? blockRect(doc.parent, system) : null;
  const sig = (show && !asTokens) ? JSON.stringify([list, hidden, token.w, token.h, doc.rotation, onCards, onCards ? [doc.x, doc.y] : 0]) : "";
  if ( token._noMishapSig === sig ) return;
  token._noMishapSig = sig;
  token._noMishaps?.destroy({ children: true });
  token._noMishaps = null;
  token._noMishapHits = null;
  if ( !show || asTokens ) return;

  const box = new PIXI.Container();
  box.eventMode = "passive";
  box.alpha = hidden ? 0.5 : 1;
  token._noMishaps = box;
  token.addChild(box);
  const w = token.w, h = token.h;
  const baseSize = Math.max(12, 0.22 * Math.min(w, h));
  const a = Math.toRadians(doc.rotation ?? 0), cos = Math.cos(a), sin = Math.sin(a);
  const bySystem = {};
  for ( const m of list ) (bySystem[m.system] ??= []).push(m);
  const bridge = isBridgeScene(doc.parent);

  for ( const [system, ms] of Object.entries(bySystem) ) {
    let cx, cy, size = baseSize;
    const card = cardOf(system);
    if ( card ) {
      // A row along the bottom of the card, in scene pixels relative to the token's top-left corner.
      size = Math.min(0.24 * card.w, (0.9 * card.w) / Math.max(1, ms.length) / 1.05);
      cx = card.x + card.w / 2 - doc.x;
      cy = card.y + card.w - 0.62 * size - doc.y;
    }
    else if ( system in COLUMN ) { cx = -0.6 * size; cy = (COLUMN[system] + 0.5) * size * 1.15; }
    else {
      const [fx, fy] = SPOTS[system] ?? SPOTS.habitat;
      const dx = (fx - 0.5) * w, dy = (fy - 0.5) * h;
      cx = w / 2 + dx * cos - dy * sin;
      cy = h / 2 + dx * sin + dy * cos;
    }
    ms.forEach((m, i) => {
      const x = cx + (i - (ms.length - 1) / 2) * size * 1.05;
      const icon = new PIXI.Container();
      icon.position.set(x, cy);
      const frame = new PIXI.Graphics();
      const off = systemOffline(actor, system);
      frame.lineStyle(Math.max(1.5, size * 0.08), off ? 0xFF2020 : 0xFFA500, 1);
      frame.beginFill(0x000000, 0.75);
      frame.drawRoundedRect(-size / 2, -size / 2, size, size, size * 0.15);
      frame.endFill();
      icon.addChild(frame);
      foundry.canvas.loadTexture(m.img || "icons/svg/hazard.svg").then(tex => {
        if ( icon.destroyed || !tex ) return;
        const sp = new PIXI.Sprite(tex);
        sp.anchor.set(0.5);
        sp.width = sp.height = size * 0.82;
        icon.addChildAt(sp, 1);
      }).catch(() => {});
      // An Offline system's Mishaps get a red frame; the red X goes on the actions it grants (John).
      icon.eventMode = "static";
      icon.cursor = bridge ? "pointer" : "help";
      icon.hitArea = new PIXI.Rectangle(-size / 2, -size / 2, size, size);
      const label = `<strong>${esc(SYSTEM_LABELS[m.system] ?? m.system)}</strong>: ${esc(m.name)}${m.tier ? ` (${esc(m.tier)})` : ""}${off ? " — <span class='no-off'>OFFLINE</span>" : countsTowardOffline(m) ? " — Impaired" : ""}`;
      // Hover tips work from the page, not the token's own events, so players see them on any ship (John).
      (token._noMishapHits ??= []).push({ x: x - size / 2, y: cy - size / 2, size, label });
      // Only the bridge HUD scene works the Mishaps (John): left opens it, right (GM) marks it Repaired.
      icon.on("pointerdown", ev => {
        if ( !bridge ) return;
        ev.stopPropagation();
        hideTip();
        if ( ev.button === 2 ) { if ( game.user.isGM ) mishapMenu(actor, m, ev.client.x, ev.client.y); return; }
        if ( m.uuid ) fromUuid(m.uuid).then(d => d?.sheet?.render(true));
      });
      box.addChild(icon);
    });
  }
}

// Mishap tips for everyone: hit-test the pointer against every drawn Mishap icon.
document.addEventListener("pointermove", ev => {
  if ( !canvas?.ready || !(ev.target instanceof HTMLCanvasElement) ) { if ( tip?.style.display === "block" && tip._fromCanvas ) hideTip(); return; }
  const pt = canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY });
  for ( const t of canvas.tokens.placeables ) {
    if ( !t._noMishapHits || !t.visible || !t._noMishaps?.visible ) continue;
    const p = t.toLocal(new PIXI.Point(pt.x, pt.y), canvas.stage);
    const hit = t._noMishapHits.find(h => (p.x >= h.x) && (p.x <= h.x + h.size) && (p.y >= h.y) && (p.y <= h.y + h.size));
    if ( hit ) { showTip(hit.label, ev.clientX, ev.clientY); tip._fromCanvas = true; return; }
  }
  if ( tip?._fromCanvas ) { hideTip(); tip._fromCanvas = false; }
}, { passive: true });

/** GM menu for a Mishap icon on the bridge: Repaired (remove), Open. */
function mishapMenu(actor, m, x, y) {
  document.getElementById("no-mishap-menu")?.remove();
  const menu = document.createElement("div");
  menu.id = "no-mishap-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.innerHTML = `<div class="nmm-head">${esc(m.name)}</div>
    <a data-op="remove"><i class="fa-solid fa-wrench"></i> Repaired (remove)</a>
    <a data-op="open"><i class="fa-solid fa-book-open"></i> Open Mishap</a>`;
  menu.addEventListener("click", ev => {
    const op = ev.target.closest("[data-op]")?.dataset.op;
    menu.remove();
    if ( op === "remove" ) request({ action: "mishapRemove", uuid: actor.uuid, id: m.id });
    else if ( op === "open" && m.uuid ) fromUuid(m.uuid).then(d => d?.sheet?.render(true));
  });
  document.body.append(menu);
  setTimeout(() => document.addEventListener("pointerdown", function off(e) {
    if ( !menu.contains(e.target) ) { menu.remove(); document.removeEventListener("pointerdown", off, true); }
  }, true), 0);
}

Hooks.on("refreshToken", token => drawMishaps(token));
Hooks.on("updateActor", actor => {
  if ( actor.type !== "vehicle" || !canvas.ready ) return;
  for ( const t of canvas.tokens.placeables ) if ( (t.actor === actor) || (t.document.actorLink && t.document.actorId === actor.id) ) drawMishaps(t);
});
Hooks.on("updateToken", doc => { if ( doc.object ) drawMishaps(doc.object); });

// A Mishap dragged (from a chat link or the compendium) onto a ship on the bridge is added to it (GM).
Hooks.on("dropCanvasData", (cnv, data) => {
  if ( !game.user.isGM || (data?.type !== "Actor") || !data.uuid || !isBridgeScene(canvas.scene) ) return;
  const entry = fromUuidSync(data.uuid);
  const mishap = entry?.flags?.[MODULE_ID]?.mishap;
  if ( !mishap ) return;
  const token = canvas.tokens.placeables.find(t => isShipToken(t.document) && t.bounds.contains(data.x, data.y));
  if ( !token ) return;
  (async () => {
    const ship = token.actor;
    const systems = [...shipSystems(ship)];
    const options = systems.map(s => `<option value="${s}">${SYSTEM_LABELS[s] ?? s}</option>`).join("");
    const system = await foundry.applications.api.DialogV2.prompt({
      window: { title: `Add Mishap: ${entry.name}` },
      content: `<div class="form-group"><label>Struck system</label><select name="system">${options}</select></div>`,
      ok: { label: "Add", callback: (event, button) => button.form.elements.system.value },
      rejectClose: false
    });
    if ( system ) await addMishap(ship, { uuid: data.uuid, name: entry.name, img: entry.img, tier: mishap.tier, system });
  })();
  return false;
});

/* -------------------------------------------- */
/*  Bridge: Go to Sector Map                    */
/* -------------------------------------------- */

const BridgeLink = {
  el: null,
  render() {
    this.el?.remove();
    this.el = null;
    const scene = canvas.scene;
    if ( !scene || !isBridgeScene(scene) ) return;
    const ship = game.modules.get(MODULE_ID).crew?.shipActor?.(scene);
    if ( !ship ) return;
    const target = sectorScene(ship);
    if ( !target && !game.user.isGM ) return;
    const el = document.createElement("div");
    el.id = "no-sector-link";
    el.innerHTML = `${target ? `<button type="button" data-op="go" data-tooltip="${foundry.utils.escapeHTML(target.name)}"><i class="fa-solid fa-map"></i> Go to Sector Map</button>` : ""}
      ${game.user.isGM ? `<button type="button" data-op="pick" data-tooltip="Choose this ship's sector map${target ? ` (now: ${foundry.utils.escapeHTML(target.name)})` : ""}"><i class="fa-solid fa-gear"></i>${target ? "" : " Choose Sector Map"}</button>` : ""}`;
    el.addEventListener("click", async ev => {
      const op = ev.target.closest("[data-op]")?.dataset.op;
      if ( op === "go" ) viewScene(sectorScene(ship));
      else if ( op === "pick" ) { await pickSectorScene(ship); this.render(); }
    });
    // Drawn like part of the map: under Foundry's own panels (toolbar, scene list, sidebar).
    document.body.insertBefore(el, document.getElementById("interface"));
    this.el = el;
    this.position();
  },
  position() {
    if ( !this.el ) return;
    const el = this.el;
    const rect = canvas.app.view.getBoundingClientRect();
    const radar = canvas.scene?.tiles.find(t => t.getFlag(MODULE_ID, "radar"));
    const tile = radar ?? canvas.scene?.tiles.find(t => t.getFlag(MODULE_ID, "viewscreen"));
    if ( !tile ) { el.style.transform = ""; el.style.left = `${rect.left + 100}px`; el.style.top = `${rect.top + 60}px`; return; }
    // Part of the radar widget (John, 2026-10-25): pinned to the map just above the radar's 12, and
    // scaled with the zoom so it moves and sizes with the radar. Without a radar: over the display's top edge.
    const tw = Math.abs(tile.width), th = Math.abs(tile.height);
    const anchor = radar ? { x: tile.x + tw / 2, y: tile.y + 0.06 * th } : { x: tile.x + tw / 2, y: tile.y };
    const p = toScreen(anchor);
    const w = el.offsetWidth || 220, h = el.offsetHeight || 30;
    const k = (0.34 * tw * canvas.stage.scale.x) / w;
    // Its bottom sits 1.5 of its own heights above the anchor, over the radar frame's long orange bar (John).
    const lift = radar ? 2.5 : 1;
    el.style.transformOrigin = "0 0";
    el.style.transform = `scale(${k.toFixed(4)})`;
    // The "Go to Sector Map" button itself is centered on the anchor (over the 12); the gear sits to its right.
    const go = el.querySelector('[data-op="go"]');
    const cw = go ? (go.offsetLeft + go.offsetWidth / 2) : (w / 2);
    el.style.left = `${Math.round(rect.left + p.x - cw * k)}px`;
    el.style.top = `${Math.round(rect.top + p.y - h * k * lift)}px`;
  }
};
Hooks.on("canvasReady", () => BridgeLink.render());
Hooks.on("canvasTearDown", () => { BridgeLink.el?.remove(); BridgeLink.el = null; });
Hooks.on("canvasPan", () => BridgeLink.position());
for ( const h of ["createToken", "updateToken", "deleteToken"] ) Hooks.on(h, () => setTimeout(() => BridgeLink.render(), 300));
Hooks.on("updateActor", (actor, changes) => {
  if ( foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.sectorSceneId`) || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.-=sectorSceneId`) ) BridgeLink.render();
});

// The stylesheet is listed in module.json; load it here too, for a world launched before it was added.
Hooks.once("init", () => {
  const href = `modules/${MODULE_ID}/styles/sector-hud.css`;
  if ( ![...document.styleSheets].some(s => s.href?.includes("sector-hud.css")) ) {
    document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href }));
  }
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  mod.sectorHud = { open: doc => ShipHud.open(doc), close: () => ShipHud.close(), hudMode, actionsFor };
  // The Mishap index carries each actor's mishap flags, which the drop handler reads synchronously.
  import("./mishap-links.mjs").then(m => m.mishapIndex()).catch(() => {});
});
