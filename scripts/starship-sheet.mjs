// Paradox 5E Vehicle — compact Starship sheet for dnd5e "vehicle" actors.
// Built for dnd5e 5.3.3 on Foundry v13. Reads dnd5e's own vehicle fields; the few
// values dnd5e has no field for live in flags["fvtt-neon-odyssey"].
//
// Actor flags:  descriptor (string), draft (number), landing (string, comma list),
//               cargoSqft (number), mishaps (array of Actor UUIDs)
// Weapon flags: crew (number), rangeBand (string: Point Blank | Short | Medium | Long | Extreme)

import { SLOTS, slotOf, isDesigned, getParts, addComponent, recalculate } from "./starship-designer.mjs";

const MODULE_ID = "fvtt-neon-odyssey";
const HUD_PANEL_NAME = "hud-sheet-panel";   // Drawing text on the HUD scene that marks the panel
const RANGE_BANDS = ["Point Blank", "Short", "Medium", "Long", "Extreme"];
const { HandlebarsApplicationMixin } = foundry.applications.api;
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
      recalculate: StarshipSheet.#onRecalculate
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
    const manual = (flags.mishaps ?? []).map(uuid => {
      const doc = fromUuidSync(uuid);
      return { uuid, name: doc?.name ?? "(missing)", missing: !doc, manual: true };
    });
    const computed = designed ? (flags.mishapNames ?? []).map(name => {
      const doc = game.actors.getName(name);
      return { uuid: doc?.uuid ?? "", name, missing: false, manual: false };
    }) : [];
    const seen = new Set(computed.map(m => m.name));
    const mishaps = [...computed, ...manual.filter(m => !seen.has(m.name))];

    // Weapon Stations
    const weapons = actor.items.filter(i => i.type === "weapon").map(item => {
      const iflags = item.flags[MODULE_ID] ?? {};
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
        crew: iflags.crew ?? null,
        power: iflags.component?.power ?? null,
        powerTotal: iflags.component?.power != null ? iflags.component.power * (item.system.quantity ?? 1) : null,
        multi: (item.system.quantity ?? 1) > 1,
        rangeBand: iflags.rangeBand ?? "",
        line: parts.join(" · "),
        hasAttack: !!attack
      };
    });

    // Designer slots (edit mode)
    const parts = getParts(actor);
    const slots = Object.entries(SLOTS).filter(([k]) => k !== "weapon").map(([key, slot]) => {
      const installed = parts.filter(p => slotOf(p.c) === key).map(p => ({ id: p.item.id, name: p.item.name, qty: p.qty }));
      return { key, label: slot.label, hint: slot.hint ?? "", stack: slot.stack, installed, open: slot.max - installed.length > 0 && !(slot.max === 1 && installed.length) };
    });
    const design = flags.design ?? {};
    const missingDims = !(Number(src.traits.keel?.value) > 0 && Number(src.traits.beam?.value) > 0 && Number(flags.draft) > 0);
    const missingBuilder = !String(design.builtBy ?? "").trim();
    const tonsLabel = w.value != null ? dnd5e.utils.formatWeight(w.value, w.units ?? "tn", { unitDisplay: "long" }) : "";
    const sizeName = flags.sizeName ?? "";
    const powerSurplus = flags.powerSurplus ?? null;

    // Choice lists for edit mode
    const toChoices = (obj, key) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, L(v[key] ?? v)]));

    return Object.assign(context, {
      actor, flags, src,
      editing: this.isEditing,
      designed, slots, design, powerSurplus, missingDims, missingBuilder, tonsLabel, sizeName, powerNegative: (powerSurplus ?? 0) < 0,
      isGM: game.user.isGM, owner: actor.isOwner,
      name: actor.name, priceLabel, line1, line2,
      crewLabel: `${crew}/${crew + pax}`,
      cargo: flags.cargoSqft ? `${Number(flags.cargoSqft).toLocaleString()} sqft` : "",
      ac: sys.attributes.ac?.value ?? sys.attributes.ac?.flat ?? "",
      hp: sys.attributes.hp,
      mt: sys.attributes.hp?.mt ?? "",
      speed, movement, abilities, mishaps, weapons,
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
      if ( item.type !== "weapon" ) {
        ui.notifications.warn("Only weapons can be added as Weapon Stations on this sheet.");
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
