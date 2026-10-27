// Paradox 5E Vehicle — compact Starship sheet for dnd5e "vehicle" actors.
// Built for dnd5e 5.3.3 on Foundry v13. Reads dnd5e's own vehicle fields; the few
// values dnd5e has no field for live in flags["fvtt-neon-odyssey"].
//
// Actor flags:  descriptor (string), draft (number), landing (string, comma list),
//               cargoSqft (number), mishaps (array of Actor UUIDs)
// Weapon flags: crew (number), rangeBand (string), facing (bow | port | starboard | aft)
// Designed ships (v2 components) also carry the flags written by starship-designer.mjs.

import { stationLocation, partPower } from "./starship-calc.mjs";
import { SLOT_DEFS, FACINGS, GUNNER_FACINGS, LOCATIONS, needsStation, needsSeat, setStation, componentLibrary, facingLabel, isDesigned, getParts, legacyParts, addComponent, recalculate, askFacing, ammoPools, weaponAmmo, rearm } from "./starship-designer.mjs";
import { MISHAP_TIERS, possibleMishaps, shipStrain, shipPasses, tierForPasses } from "./mishap-links.mjs";

const MODULE_ID = "fvtt-neon-odyssey";
const HUD_PANEL_NAME = "hud-sheet-panel";   // Drawing text on the HUD scene that marks the panel
const RANGE_BANDS = ["Point Blank", "Short", "Medium", "Long", "Extreme"];
const { HandlebarsApplicationMixin } = foundry.applications.api;

const STAT_LABELS = {
  ac: "AC", mt: "MT", speed: "Speed", str: "STR", dex: "DEX", con: "CON", int: "INT", wis: "WIS", cha: "CHA",
  hpBonus: "HP", hpPct: "HP", hitDie: "Hit Die d", hitDice: "Hit Dice", crew: "Crew", passengers: "Passengers", berths: "Berths",
  cargo: "Cargo", power: "Power", compartments: "Compartments", cost: "Cost", shieldAc: "Shield AC",
  shieldCharges: "Charges/facing", ablativeHp: "Ablative HP", ablativeRegen: "Regen"
};
/** Hover text for an installed component: its stat effects, one per line. */
function partTooltip(c) {
  const fmt = (k, v) => {
    if ( k === "cost" ) return `${STAT_LABELS[k]} ${Number(v).toLocaleString()}`;
    if ( ["hitDie", "hitDice"].includes(k) ) return `${STAT_LABELS[k]}${k === "hitDie" ? "" : " "}${v}`;
    if ( k === "compartments" && v > -1 && v < 0 ) return `Compartments ${Math.round(v * 100)}% of class`;
    if ( k === "hpPct" ) return `HP ${v > 0 ? "+" : ""}${Math.round(v * 100)}%`;
    if ( ["str", "dex", "con", "int", "wis", "cha"].includes(k) && !["shipClass", "material"].includes(c.slot) ) return `${STAT_LABELS[k]} ${v}`;
    return `${STAT_LABELS[k] ?? k} ${v > 0 ? "+" : ""}${v}`;
  };
  const lines = Object.entries(c.stats ?? {}).filter(([k]) => STAT_LABELS[k]).map(([k, v]) => fmt(k, v));
  if ( c.size ) lines.unshift(`Size ${c.size}`);
  if ( c.stationRoles?.length ) lines.push(`Station: ${c.stationRoles.join(" + ")}`);
  if ( c.mishaps?.length ) lines.push(`Mishaps: ${c.mishaps.join(", ")}`);
  return lines.join("<br>");
}
const { ActorSheetV2 } = foundry.applications.sheets;

export class StarshipSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["no-starship-sheet"],
    position: { width: 560, height: 516 },
    form: { submitOnChange: true, closeOnSubmit: false },
    window: {
      resizable: true,
      controls: [
        { icon: "fa-solid fa-table-list", label: "Open dnd5e Vehicle Sheet", action: "openDefault", ownership: "OWNER" }
      ]
    },
    actions: {
      toggleMode: StarshipSheet.#onToggleMode,
      openDefault: StarshipSheet.#onOpenDefault,
      useWeapon: StarshipSheet.#onUseWeapon,
      rollAttack: StarshipSheet.#onRollAttack,
      rollDamage: StarshipSheet.#onRollDamage,
      openItem: StarshipSheet.#onOpenItem,
      deleteItem: StarshipSheet.#onDeleteItem,
      openMishap: StarshipSheet.#onOpenMishap,
      removeMishap: StarshipSheet.#onRemoveMishap,
      recalculate: StarshipSheet.#onRecalculate,
      editShipImage: StarshipSheet.#onEditShipImage,
      rearm: StarshipSheet.#onRearm,
      removeCrew: StarshipSheet.#onRemoveCrew
    }
  };

  static PARTS = {
    sheet: { template: `modules/${MODULE_ID}/templates/starship-sheet.hbs` }
  };

  /** Current sheet mode. */
  #editing = false;

  get isEditing() {
    return this.#editing && this.isEditable;
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.actor;
    const sys = actor.system;
    const src = actor._source.system;
    const flags = actor.flags[MODULE_ID] ?? {};
    const cfg = CONFIG.DND5E;
    const L = k => game.i18n.localize(k ?? "");

    // Line 1: size + descriptor
    const designed = isDesigned(actor);
    const size = cfg.actorSizes[sys.traits.size]?.label ?? "";
    const line1 = designed && flags.description ? flags.description : [size, flags.descriptor].filter(Boolean).join(", ");

    // Line 2: weight (keel, beam, draft), Landing
    const w = sys.traits.weight ?? {};
    const weight = w.value ? dnd5e.utils.formatWeight(w.value, w.units, { unitDisplay: "long" }) : "";
    const dims = [
      sys.traits.keel?.value != null ? `keel ${sys.traits.keel.value}` : null,
      sys.traits.beam?.value != null ? `beam ${sys.traits.beam.value}` : null,
      flags.draft != null && flags.draft !== "" ? `draft ${flags.draft}` : null
    ].filter(Boolean).join(", ");
    let line2 = weight;
    if ( dims ) line2 += `${line2 ? " " : ""}(${dims})`;
    if ( flags.landing ) line2 += `${line2 ? ", " : ""}Landing: ${flags.landing}`;

    // Price
    const price = sys.attributes.price ?? {};
    const priceLabel = price.value != null ? `${Number(price.value).toLocaleString()} ${price.denomination ?? ""}`.trim() : "";

    // Crew: fully manned / with passengers
    const crew = sys.crew?.max ?? 0;
    const pax = sys.passengers?.max ?? 0;

    // Speed: every non-zero movement type (view); every visible type (edit)
    const mv = sys.attributes.movement ?? {};
    const moveTypes = Object.entries(cfg.movementTypes).filter(([, t]) => !t.hidden);
    let speed = moveTypes
      .filter(([k]) => Number(mv[k]) > 0)
      .map(([k, t]) => `${L(t.label)} ${mv[k]}`)
      .join(", ");
    // Designed ships: show the signed speed; negative N = one move every |N| turns.
    if ( isDesigned(actor) && Number.isFinite(flags.speed) ) {
      const label = L(cfg.movementTypes[flags.movementKey ?? "fly"]?.label ?? "DND5E.MOVEMENT.Type.Fly");
      const n = flags.speed;
      speed = n < 0 ? `${label} ${n} (1 move every ${-n} turns)` : n === 0 ? `${label} 0 (no movement)` : `${label} ${n}`;
    }
    const movement = moveTypes.map(([k, t]) => ({ key: k, label: L(t.label), value: src.attributes.movement?.[k] ?? null }));

    // Abilities: a score of 0 renders blank in view mode
    const abilities = Object.entries(cfg.abilities).map(([k, a]) => {
      const abl = sys.abilities[k] ?? {};
      const show = Number(abl.value) > 0;
      return {
        key: k,
        abbr: (a.abbreviation ?? k).toUpperCase(),
        raw: src.abilities?.[k]?.value ?? 0,
        value: show ? abl.value : "",
        mod: show ? (abl.mod >= 0 ? `+${abl.mod}` : `${abl.mod}`) : ""
      };
    });

    // Possible Mishaps
    // Component keys resolve to the Actors compendium at the tier Strain has reached
    // (see mishap-links.mjs); mishaps dropped on the sheet by hand stay as dropped.
    const strain = shipStrain(actor);
    const passes = shipPasses(actor, strain);
    const tier = tierForPasses(passes);
    const mishaps = (await possibleMishaps(actor, tier)).filter(m => designed || m.manual);
    const mishapTier = strain === null ? "" : `${MISHAP_TIERS[tier]} at Strain ${strain}`;

    // Live component data (the compendium), as the calculator uses.
    const lib = await componentLibrary();

    // Weapon Stations
    const weapons = actor.items.filter(i => i.type === "weapon").map(item => {
      const iflags = item.flags[MODULE_ID] ?? {};
      const own = iflags.component?.v === 2 ? iflags.component : null;
      const comp = own ? (lib.byId.get(`${own.slot}|${own.id}`) ?? own) : null;
      // v2: the draw for this ship's size (power scales with the part's compartments).
      const pwr = comp ? Math.abs(partPower(comp, Number(flags.analysis?.compartments?.budget) || 0)) || null
        : (iflags.component?.power ?? null);
      const attack = item.system.activities?.getByType?.("attack")?.[0];
      const damages = attack?.labels?.damage ?? [];
      const damage = damages.map(d => d.label ?? d.formula).filter(Boolean).join(" + ");
      const range = iflags.rangeBand || item.labels?.range || "";
      const parts = [attack?.attack?.type?.value === "melee" ? "Melee Weapon Attack" : "Ranged Weapon Attack"];
      if ( range ) parts.push(`Range: ${range}`);
      if ( damage ) parts.push(`Hit: ${damage}`);
      return {
        id: item.id,
        name: item.name,
        qty: item.system.quantity ?? 1,
        crew: iflags.crew ?? comp?.stats?.crew ?? null,
        power: pwr,
        powerTotal: pwr != null ? pwr * (item.system.quantity ?? 1) : null,
        facing: iflags.facing ?? "",
        crewed: needsStation(comp), station: iflags.station?.location ?? "",
        facingLabel: iflags.facing ? iflags.facing[0].toUpperCase() + iflags.facing.slice(1) : "",
        size: comp?.size ?? "",
        multi: (item.system.quantity ?? 1) > 1,
        rangeBand: iflags.rangeBand ?? "",
        line: parts.join(" · "),
        ammoText: (a => a ? `${a.shots} shot${a.shots === 1 ? "" : "s"} left (${a.size} magazine ${a.left}/${a.capacity})` : "")(weaponAmmo(actor, item.id)),
        ammoOut: (a => !!a && a.shots < 1)(weaponAmmo(actor, item.id)),
        hasAttack: !!attack
      };
    });

    // Designer slots (edit mode), checks and analysis (v2 components)
    const parts = getParts(actor);
    // The Ship Class comes from keel, beam and draft, so it has no slot.
    const slots = Object.entries(SLOT_DEFS).filter(([k]) => !["weapon", "shipClass"].includes(k)).map(([key, def]) => {
      const installed = parts.filter(p => p.c.slot === key).map(p => ({
        id: p.id, name: p.name, qty: p.qty, tip: partTooltip(p.c),
        located: !!p.c.stationRoles?.length,
        location: p.c.stationRoles?.length ? (stationLocation(p.location, p.facing, p.c.stationRoles[0]) ?? "") : "",
        crewed: needsStation(p.c), station: p.station ?? "", auto: p.auto,
        seat: needsSeat(p.c), seatAuto: p.station === "none"
      }));
      return { key, label: def.label, stack: def.qty, installed, open: installed.length < def.max || def.max > 1 };
    });
    const analysis = flags.analysis ?? null;
    const checks = analysis?.checks ?? [];
    const warnings = checks.filter(c => !c.ok);
    const legacy = legacyParts(actor).map(i => i.name);
    const shield = flags.shield ?? {};
    const shieldLine = [
      shield.charges ? `Deflector ${shield.acRaised} AC raised, ${shield.charges} charges per facing` : "",
      shield.ablativeHp ? `Ablative field ${shield.ablativeHp} HP, regen ${shield.ablativeRegen}` : ""
    ].filter(Boolean).join(" · ");
    const pools = ammoPools(actor);
    const torpedoLine = Object.entries(analysis?.ammo?.torpedoes ?? {}).filter(([, t]) => t.launchers)
      .map(([z, t]) => `${z} torpedoes ${t.loaded} loaded + ${t.reloads} reload${t.reloads === 1 ? "" : "s"}`);
    const ammoLine = Object.entries(pools).map(([z, p]) => `${z} ${p.left}/${p.capacity} (${Math.floor(p.left / 6)} missiles or ${p.left} rounds)`)
      .concat(torpedoLine)
      .concat(Object.entries(analysis?.ammo?.racks ?? {}).filter(([, t]) => t.racks)
        .map(([z, t]) => `${z} missile racks ${t.loaded} volleys + ${t.reloads} in magazines`)).join(" · ");
    const powerSurplus = flags.powerSurplus ?? null;
    const design = flags.design ?? {};
    const sizeName = flags.sizeName ?? "";

    // Choice lists for edit mode
    const toChoices = (obj, key) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, L(v[key] ?? v)]));

    return Object.assign(context, {
      // Actors made from the dnd5e default still carry its placeholder icon; show the token art instead.
      shipImg: (!actor.img || actor.img.startsWith("systems/dnd5e/icons/") || actor.img.startsWith("icons/svg/"))
        ? (actor.prototypeToken?.texture?.src || actor.img) : actor.img,
      actor, flags, src,
      editing: this.isEditing,
      designed, slots, design, powerSurplus, sizeName, powerNegative: (powerSurplus ?? 0) < 0,
      analysis, checks, warnings, legacy, shieldLine, ammoLine, facings: FACINGS,
      locations: LOCATIONS.map(l => ({ value: l.key, label: l.label })),
      hitDiceLabel: analysis?.hitDice ? `${analysis.hitDice}d${analysis.hitDie}` : "",
      tonsText: analysis?.tons ? Number(analysis.tons).toLocaleString() : "",
      prisoners: analysis?.prisoners ?? 0,
      isGM: game.user.isGM, owner: actor.isOwner,
      name: actor.name, priceLabel, line1, line2,
      shipLevel: Math.max(1, Math.floor(Number(flags.level) || 1)),
      shipProf: Math.ceil(Math.max(1, Math.floor(Number(flags.level) || 1)) / 4) + 1,
      crewItem: (() => { const it = actor.items.find(i => (i.flags?.[MODULE_ID]?.crewQuality ?? null) !== null);
        return it ? { id: it.id, name: it.name, q: Number(it.flags[MODULE_ID].crewQuality) } : null; })(),
      crewLabel: designed ? `${crew}${pax ? ` + ${pax} passengers` : ""}${analysis ? `, ${analysis.berths} berths` : ""}` : `${crew}/${crew + pax}`,
      cargo: designed ? (flags.cargo ? `${Number(flags.cargo).toLocaleString()}` : "")
        : (flags.cargoSqft ? `${Number(flags.cargoSqft).toLocaleString()} sqft` : ""),
      ac: sys.attributes.ac?.value ?? sys.attributes.ac?.flat ?? "",
      hp: sys.attributes.hp,
      mt: sys.attributes.hp?.mt ?? "",
      speed, movement, abilities, mishaps, mishapTier, weapons,
      rangeBands: RANGE_BANDS,
      sizeChoices: toChoices(cfg.actorSizes, "label"),
      weightChoices: toChoices(cfg.weightUnits, "abbreviation"),
      currencyChoices: toChoices(cfg.currencies, "abbreviation")
    });
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** Add the view/edit toggle to the window header, like the dnd5e sheets. */
  async _renderFrame(options) {
    const frame = await super._renderFrame(options);
    if ( this.isEditable ) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "header-control no-ss-mode fa-solid fa-lock";
      btn.dataset.action = "toggleMode";
      btn.dataset.tooltip = "Toggle Edit Mode";
      this.window.header.prepend(btn);
    }
    return frame;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const el = this.element;
    el.classList.toggle("editing", this.isEditing);
    const toggle = el.querySelector(".no-ss-mode");
    if ( toggle ) {
      toggle.classList.toggle("fa-lock", !this.isEditing);
      toggle.classList.toggle("fa-lock-open", this.isEditing);
    }

    // Mishap chips drag out as Actors, so the GM can drop them on the canvas as tokens.
    for ( const chip of el.querySelectorAll(".mishap-chip[data-uuid]") ) {
      chip.addEventListener("dragstart", ev => {
        ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "Actor", uuid: chip.dataset.uuid }));
      });
    }

    // Drops: Mishap actors onto Possible Mishaps; weapon items anywhere on the sheet.
    const root = el.querySelector(".no-ss");
    if ( root && this.isEditable ) {
      root.addEventListener("dragover", ev => ev.preventDefault());
      root.addEventListener("drop", ev => this.#onDrop(ev));
    }

    // Station pickers on crewed systems: use or add the station at that location.
    for ( const sel of el.querySelectorAll("select[data-station-for]") ) {
      sel.addEventListener("change", ev => {
        ev.stopPropagation();
        const item = this.actor.items.get(sel.dataset.stationFor);
        if ( item && sel.value ) setStation(this.actor, item, sel.value);
      });
    }

    // Weapon station fields edit the item, not the vehicle.
    for ( const input of el.querySelectorAll("[data-item-field]") ) {
      input.addEventListener("change", ev => this.#onItemFieldChange(ev));
    }

    if ( options.isFirstRender ) this.fitToHudPanel();
  }

  /**
   * If the current scene has a Drawing whose text is HUD_PANEL_NAME, place and size this
   * window over it. Called on first render and whenever the canvas pans or zooms.
   */
  fitToHudPanel() {
    if ( !canvas?.ready ) return;
    const drawing = canvas.scene?.drawings.find(d => d.text?.trim() === HUD_PANEL_NAME);
    if ( !drawing ) return;
    const t = canvas.stage.worldTransform;
    const board = canvas.app.view.getBoundingClientRect();
    this.setPosition({
      left: Math.round(board.left + drawing.x * t.a + t.tx),
      top: Math.round(board.top + drawing.y * t.d + t.ty),
      width: Math.round(drawing.shape.width * t.a),
      height: Math.round(drawing.shape.height * t.d)
    });
  }

  /* -------------------------------------------- */
  /*  Form                                        */
  /* -------------------------------------------- */

  /** Keep the vehicle's AC on flat calculation when AC is edited here. */
  _prepareSubmitData(event, form, formData, updateData) {
    const data = super._prepareSubmitData(event, form, formData, updateData);
    if ( foundry.utils.hasProperty(data, "system.attributes.ac.flat") ) {
      foundry.utils.setProperty(data, "system.attributes.ac.calc", "flat");
    }
    return data;
  }

  async #onItemFieldChange(event) {
    event.stopPropagation();
    const input = event.currentTarget;
    const item = this.actor.items.get(input.closest("[data-item-id]")?.dataset.itemId);
    if ( !item ) return;
    let value = input.value;
    if ( input.type === "number" ) value = value === "" ? null : Number(value);
    await item.update({ [input.dataset.itemField]: value });
  }

  async #onDrop(event) {
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
    if ( !data?.uuid ) return;
    event.preventDefault();
    event.stopPropagation();

    if ( data.type === "Actor" ) {
      const list = this.actor.getFlag(MODULE_ID, "mishaps") ?? [];
      if ( list.includes(data.uuid) ) return;
      await this.actor.setFlag(MODULE_ID, "mishaps", [...list, data.uuid]);
      return;
    }

    if ( data.type === "Item" ) {
      const item = await fromUuid(data.uuid);
      if ( !item || item.parent === this.actor ) return;
      if ( item.flags[MODULE_ID]?.component ) {
        await addComponent(this.actor, item);
        return;
      }
      // A Crew item (Crew: Green / Regular / Veteran / Elite) sets the crew quality; one per ship (John, 2026-10-26).
      if ( (item.flags[MODULE_ID]?.crewQuality ?? null) !== null ) {
        const old = this.actor.items.filter(i => (i.flags?.[MODULE_ID]?.crewQuality ?? null) !== null).map(i => i.id);
        if ( old.length ) await this.actor.deleteEmbeddedDocuments("Item", old);
        await this.actor.createEmbeddedDocuments("Item", [item.toObject()]);
        ui.notifications.info(`${this.actor.name}: ${item.name} aboard (crew quality +${item.flags[MODULE_ID].crewQuality}).`);
        return;
      }
      if ( item.type !== "weapon" ) {
        ui.notifications.warn("Only weapons, ship components and Crew items can be dropped on this sheet.");
        return;
      }
      await this.actor.createEmbeddedDocuments("Item", [item.toObject()]);
    }
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  #getItem(target) {
    return this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId);
  }

  static #onToggleMode() {
    this.#editing = !this.#editing;
    this.render();
  }

  static #onUseWeapon(event, target) {
    if ( this.isEditing ) return;
    if ( event.target.closest("button, input, select, a") ) return;
    this.#getItem(target)?.use({ event });
  }

  static #onRollAttack(event, target) {
    this.#getItem(target)?.system.activities?.getByType("attack")?.[0]?.rollAttack({ event });
  }

  static #onRollDamage(event, target) {
    this.#getItem(target)?.system.activities?.getByType("attack")?.[0]?.rollDamage({ event });
  }

  static #onOpenItem(event, target) {
    this.#getItem(target)?.sheet.render({ force: true });
  }

  static async #onDeleteItem(event, target) {
    const item = this.#getItem(target);
    if ( item ) await item.deleteDialog();
  }

  static #onOpenMishap(event, target) {
    fromUuid(target.dataset.uuid).then(doc => doc?.sheet.render({ force: true }));
  }

  static async #onRemoveMishap(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const uuid = target.closest("[data-uuid]")?.dataset.uuid;
    const list = (this.actor.getFlag(MODULE_ID, "mishaps") ?? []).filter(u => u !== uuid);
    await this.actor.setFlag(MODULE_ID, "mishaps", list);
  }

  /**
   * Pick a new ship image. It becomes the actor portrait, the prototype token image, and the
   * image of every token of this ship already placed on a scene (linked tokens, or this
   * token itself when the sheet belongs to an unlinked token).
   */
  static async #onEditShipImage(event, target) {
    const actor = this.actor;
    const FilePicker = foundry.applications.apps.FilePicker.implementation;
    const picker = new FilePicker({
      type: "image",
      current: actor.img,
      callback: async path => {
        if ( !path || (path === actor.img) ) return;
        if ( actor.isToken ) {
          await actor.update({ img: path });
          await actor.token.update({ "texture.src": path });
          return;
        }
        await actor.update({ img: path, "prototypeToken.texture.src": path });
        for ( const scene of game.scenes ) {
          const updates = scene.tokens
            .filter(t => t.actorLink && (t.actorId === actor.id))
            .map(t => ({ _id: t.id, "texture.src": path }));
          if ( !updates.length ) continue;
          try { await scene.updateEmbeddedDocuments("Token", updates); }
          catch(err) { console.warn(`${MODULE_ID} | could not update tokens on ${scene.name}`, err); }
        }
      }
    });
    return picker.browse();
  }

  static async #onRemoveCrew(event, target) {
    const id = target.closest("[data-crew-id]")?.dataset.crewId;
    if ( id ) await this.actor.deleteEmbeddedDocuments("Item", [id]);
  }

  static async #onRearm() {
    await rearm(this.actor);
    ui.notifications.info(`${this.actor.name}: magazines refilled.`);
  }

  static async #onRecalculate() {
    const s = await recalculate(this.actor);
    if ( s ) ui.notifications.info(`${this.actor.name} recalculated.`);
  }

  static #onOpenDefault() {
    const cls = CONFIG.Actor.sheetClasses.vehicle?.["dnd5e.VehicleActorSheet"]?.cls;
    if ( cls ) new cls({ document: this.actor }).render({ force: true });
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

Hooks.once("init", () => {
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, MODULE_ID, StarshipSheet, {
    types: ["vehicle"],
    makeDefault: false,
    label: "Paradox 5E Vehicle"
  });
  console.log("Neon Odyssey | registered Paradox 5E Vehicle sheet");
});

// Keep any open Starship sheets locked over the HUD panel while the canvas pans or zooms.
Hooks.on("canvasPan", () => {
  for ( const app of foundry.applications.instances.values() ) {
    if ( app instanceof StarshipSheet && app.rendered ) app.fitToHudPanel();
  }
});
