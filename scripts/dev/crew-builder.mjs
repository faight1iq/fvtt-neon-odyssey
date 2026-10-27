// Rebuild the M-34 Destiny crew as full level 2 Neon Odyssey characters (John, 2026-10-26).
// Console: (await import('/modules/fvtt-neon-odyssey/scripts/dev/crew-builder.mjs?v=N')).buildAll()
//
// Each character keeps its actor (id, name, portrait, token, crew seat) and is rebuilt from the Neon Odyssey
// compendiums: species, the Outrunner background (+2/+1, two skills, a tool, two languages, an origin feat, a
// tech tool) and a class at level 2 with its advancements applied (features, proficiencies, choices, HP: max
// at 1st level, average at 2nd), spells for casters, and starting gear from the Neon Odyssey equipment list.

const MOD = "fvtt-neon-odyssey";
const NO = n => `Compendium.${MOD}.${n}`;
const PHB = "Compendium.dnd5e";

const CLASSES = {};   // name -> doc
const RACES = {};
let OUTRUNNER = null;
const EQUIP = {};     // name -> uuid
const SPELLS = {};    // name -> uuid
const ORIGIN = {};    // origin feat name -> uuid

async function loadPacks() {
  for ( const d of await game.packs.get(`${MOD}.classes`).getDocuments() ) if ( d.type === "class" ) CLASSES[d.name] = d;
  for ( const d of await game.packs.get(`${MOD}.origins`).getDocuments() ) {
    if ( d.type === "race" ) RACES[d.name] = d;
    else if ( d.type === "background" && d.name.startsWith("Outrunner") ) OUTRUNNER = d;
  }
  for ( const e of game.packs.get(`${MOD}.equipment`).index ) EQUIP[e.name] = e.uuid;
  for ( const e of game.packs.get(`${MOD}.spells`).index ) SPELLS[e.name] = e.uuid;
  const choice = OUTRUNNER.system.advancement.find(a => a.type === "ItemChoice");
  for ( const p of choice.configuration.pool ) { const f = await fromUuid(p.uuid); if ( f ) ORIGIN[f.name] = f.uuid; }
}

/* ---------- the crew ---------- */
// abilities: before the background's +2/+1. skills/tools/etc. are picked per advancement title.
const CREW = [
  { name: "Captain Ilsa Varn", cls: "Icon", race: "Human", origin: "Space Origin",
    abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 }, asi: { cha: 2, dex: 1 },
    picks: { "Skill Proficiencies": ["prc", "ins", "itm"], "Tool Proficiencies": ["lute", "flute", "drum"], "Expertise": ["prc", "ins"],
      bgSkills: ["per", "his"], bgTool: ["navigationtools"], langs: ["elvish", "dwarvish"], tech: ["computerinterface"] },
    spells: { cantrips: ["Vicious Mockery", "Message"], prepared: ["Healing Word", "Dissonant Whispers", "Heroism", "Command", "Faerie Fire"] },
    gear: [["Light Armor", 1, true], ["Light Laser Pistol", 1, true], ["Combat Knife", 1, true], ["Power Cell", 4]] },
  { name: "Navigator Tobias Rhee", cls: "Tracer", race: "Greeble", origin: "Space Origin",
    abilities: { str: 8, dex: 14, con: 13, int: 12, wis: 15, cha: 10 }, asi: { wis: 2, dex: 1 },
    picks: { "Skill Proficiencies": ["ste", "prc", "sur"], "Deft Explorer": ["ste"], "Weapon Mastery": ["laserrifle", "combatsword"],
      "Fighting Style": ["Archery"], bgSkills: ["dec", "nat"], bgTool: ["navigationtools"], langs: ["elvish", "gnomish"], tech: ["computerinterface"] },
    spells: { cantrips: [], prepared: ["Hunter's Mark", "Cure Wounds", "Longstrider"] },
    gear: [["Light Armor", 1, true], ["Laser Rifle", 1, true], ["Combat Sword", 1, true], ["Power Cell", 4]] },
  { name: "Chief Engineer Mara Okafor", cls: "Machinist", race: "Oculok", origin: "Technologic Origin",
    abilities: { str: 10, dex: 13, con: 14, int: 15, wis: 12, cha: 8 }, asi: { int: 2, con: 1 },
    picks: { "Skill Proficiencies": ["inv", "ins", "prc"], "Deft Explorer": ["inv"], "Neon Odyssey Tool Proficiency": ["technologytoolkit"],
      skipFightingStyle: true, bgSkills: ["arc", "his"], bgTool: ["engineerstools"], langs: ["dwarvish", "gnomish"], tech: ["computerinterface"] },
    spells: { cantrips: [], prepared: ["Cure Wounds", "Faerie Fire", "Grease"] },
    gear: [["Medium Armor Vest", 1, true], ["Heavy Pistol", 1, true], ["Combat Hammer", 1, true], ["Power Cell", 4]] },
  { name: "Doc Selene Arcos", cls: "Oracle", race: "Saurian", origin: "Flourishing Origin",
    abilities: { str: 10, dex: 12, con: 14, int: 8, wis: 15, cha: 13 }, asi: { wis: 2, con: 1 },
    picks: { "Skill Proficiencies": ["med", "ins"], "Divine Order Choice": ["Thaumaturge"], bgSkills: ["prc", "nat"], bgTool: ["pharmakit"], langs: ["celestial", "draconic"], tech: ["computerinterface"] },
    spells: { cantrips: ["Guidance", "Spare the Dying", "Sacred Flame", "Light"], prepared: ["Cure Wounds", "Healing Word", "Bless", "Shield of Faith", "Sanctuary"] },
    gear: [["Medium Armor Vest", 1, true], ["Shield", 1, true], ["Combat Baton", 1, true], ["Pharma Kit", 1], ["Injector", 1]],
    extra: [[`Compendium.fvtt-neon-odyssey.equipment.Item.NOeqMedPack00000`, 1], [`Compendium.fvtt-neon-odyssey.equipment.Item.NOeqHealingStim0`, 3]] },
  { name: "Cookie Pell Harrow", cls: "Soldier", race: "Nematoan", origin: "Aquatic Origin",
    abilities: { str: 14, dex: 12, con: 15, int: 10, wis: 13, cha: 8 }, asi: { con: 2, str: 1 },
    picks: { "Skill Proficiencies": ["sur", "prc"], "Weapon Mastery": ["shotgun", "combatknife", "combathammer"], "Fighting Style": ["Defense"],
      bgSkills: ["his", "med"], bgTool: ["chefsutensils"], langs: ["halfling", "giant"], tech: ["technologytoolkit"] },
    gear: [["Medium Armor Vest", 1, true], ["Shotgun", 1, true], ["Combat Knife", 1, true], ["Shells", 20]] },
  { name: "Deckhand Juno Brask", cls: "Juggernaut", race: "Rangor", origin: "Space Origin",
    abilities: { str: 14, dex: 13, con: 15, int: 8, wis: 12, cha: 10 }, asi: { con: 2, str: 1 },
    picks: { "Skill Proficiencies": ["ath", "prc"], "Weapon Mastery": ["breakeraxe", "throwinghammer"], bgSkills: ["acr", "sur"],
      bgTool: ["mechanicstools"], langs: ["dwarvish", "orc"], tech: ["technologytoolkit"] },
    gear: [["Breaker Axe", 1, true], ["Throwing Hammer", 2, true]] },
  { name: "Deckhand Oren Vasq", cls: "Soldier", race: "Laika", origin: "Adamant Origin",
    abilities: { str: 14, dex: 13, con: 15, int: 10, wis: 12, cha: 8 }, asi: { con: 2, str: 1 },
    picks: { "Skill Proficiencies": ["ath", "prc"], "Weapon Mastery": ["assaultrifle", "combatsword", "vibrospear"], "Fighting Style": ["Defense"],
      bgSkills: ["ins", "sur"], bgTool: ["mechanicstools"], langs: ["halfling", "orc"], tech: ["technologytoolkit"] },
    gear: [["Medium Armor Suit", 1, true], ["Assault Rifle", 1, true], ["Combat Sword", 1, true], ["Magazine", 4]] },
  { name: "Gunner Dace Kolt", cls: "Tracer", race: "Zorbrak", origin: "Technologic Origin",
    abilities: { str: 10, dex: 15, con: 13, int: 12, wis: 14, cha: 8 }, asi: { dex: 2, con: 1 },
    picks: { "Skill Proficiencies": ["prc", "sur", "ste"], "Deft Explorer": ["prc"], "Weapon Mastery": ["laserrifle", "combatsword"],
      "Fighting Style": ["Archery"], bgSkills: ["ath", "itm"], bgTool: ["electronicstools"], langs: ["elvish", "orc"], tech: ["technologytoolkit"] },
    spells: { cantrips: [], prepared: ["Hunter's Mark", "Ensnaring Strike", "Cure Wounds"] },
    gear: [["Light Armor", 1, true], ["Laser Rifle", 1, true], ["Combat Sword", 1, true], ["Power Cell", 4]] },
  { name: "Gunner Rina Sato", cls: "Tracer", race: "Marsoom", origin: "Brilliant Origin",
    abilities: { str: 10, dex: 15, con: 13, int: 12, wis: 14, cha: 8 }, asi: { dex: 2, con: 1 },
    picks: { "Skill Proficiencies": ["prc", "sur", "inv"], "Deft Explorer": ["prc"], "Weapon Mastery": ["sniperrifle", "combatknife"],
      "Fighting Style": ["Archery"], bgSkills: ["acr", "ins"], bgTool: ["electronicstools"], langs: ["elvish", "sign"], tech: ["computerinterface"] },
    spells: { cantrips: [], prepared: ["Hunter's Mark", "Cure Wounds", "Longstrider"] },
    gear: [["Light Armor", 1, true], ["Sniper Rifle", 1, true], ["Combat Knife", 1, true], ["Bullets", 20]] },
  { name: "Gunner Bram Hollis", cls: "Soldier", race: "Clawderan", origin: "Technologic Origin",
    abilities: { str: 13, dex: 15, con: 14, int: 10, wis: 12, cha: 8 }, asi: { dex: 2, con: 1 },
    picks: { "Skill Proficiencies": ["prc", "sur"], "Weapon Mastery": ["heavylaserrifle", "plasmapistol", "combatsword"], "Fighting Style": ["Archery"],
      bgSkills: ["ath", "itm"], bgTool: ["electronicstools"], langs: ["giant", "orc"], tech: ["technologytoolkit"] },
    gear: [["Medium Armor Suit", 1, true], ["Heavy Laser Rifle", 1, true], ["Plasma Pistol", 1, true], ["Combat Sword", 1, true], ["Power Cell", 6]] }
];

/* ---------- applying advancements ---------- */

function emptySystem(actor) {
  const sys = { abilities: {}, skills: {}, tools: {}, traits: { weaponProf: { value: [], mastery: { value: [] } }, armorProf: { value: [] }, languages: { value: [] } } };
  for ( const k of Object.keys(actor.system.skills) ) sys.skills[k] = { value: 0 };
  return sys;
}

/** Apply one Trait key ("skills:prc", "weapon:mar", "tool:herb", "languages:standard:common", "saves:wis"). */
function applyKey(sys, key, mode) {
  const [kind, ...rest] = key.split(":");
  const last = rest.at(-1);
  if ( kind === "saves" ) (sys.abilities[last] ??= {}).proficient = 1;
  else if ( kind === "skills" ) sys.skills[last] = { value: Math.max(sys.skills[last]?.value ?? 0, mode === "expertise" ? 2 : 1) };
  else if ( kind === "weapon" ) {
    if ( mode === "mastery" ) sys.traits.weaponProf.mastery.value.push(last);
    else sys.traits.weaponProf.value.push(last);
  }
  else if ( kind === "armor" ) sys.traits.armorProf.value.push(last);
  else if ( kind === "tool" ) sys.tools[last] = { value: mode === "expertise" ? 2 : 1, ability: CONFIG.DND5E.tools[last]?.ability ?? "int" };
  else if ( kind === "languages" ) sys.traits.languages.value.push(last);
}

/** Fill a Trait choice: picks first, then anything legal from the pool. */
function fillChoice(choice, picks, kindPrefix) {
  const out = [];
  const legal = k => choice.pool.some(p => p.endsWith("*") ? k.startsWith(p.slice(0, -1)) : (p === k));
  for ( const p of picks ?? [] ) {
    const k = p.includes(":") ? p : `${kindPrefix}:${p}`;
    const cands = [k, ...choice.pool.filter(x => x.endsWith("*")).map(x => `${x.slice(0, -1)}${p}`)];
    const hit = cands.find(legal);
    if ( hit && !out.includes(hit) && (out.length < choice.count) ) out.push(hit);
  }
  for ( const p of choice.pool ) if ( (out.length < choice.count) && !p.endsWith("*") && !out.includes(p) ) out.push(p);
  return out;
}

const prefixOf = choice => (choice.pool[0] ?? "skills:").split(":")[0];

async function itemData(uuid, extra = {}) {
  const src = await fromUuid(uuid);
  if ( !src ) { console.warn(`crew-builder | missing ${uuid}`); return null; }
  const data = src.toObject();
  delete data.folder; delete data.sort; delete data.ownership;
  data._id = foundry.utils.randomID();
  foundry.utils.setProperty(data, "_stats.compendiumSource", uuid);
  return foundry.utils.mergeObject(data, extra);
}

/** Process an item's advancements up to a level; returns child items, and fills `sys` and the item's advancement values. */
async function advance(item, level, spec, sys, opts = {}) {
  const children = [];
  const advs = Array.isArray(item.system.advancement) ? item.system.advancement : Object.values(item.system.advancement ?? {});
  for ( const a of advs ) {
    const lv = a.level ?? 0;
    const cfg = a.configuration ?? {};
    const restr = cfg.classRestriction ?? a.classRestriction;
    if ( restr === "secondary" ) continue;
    const title = a.title ?? "";
    switch ( a.type ) {
      case "HitPoints": {
        const v = {}; for ( let l = 1; l <= level; l++ ) v[l] = l === 1 ? "max" : "avg";
        a.value = v; break;
      }
      case "ItemGrant": {
        if ( lv > level ) break;
        const added = {};
        for ( const g of cfg.items ?? [] ) {
          const d = await itemData(g.uuid, { flags: { dnd5e: { sourceId: g.uuid, advancementOrigin: `${item._id}.${a._id}` } } });
          if ( !d ) continue;
          added[d._id] = g.uuid; children.push(d);
        }
        a.value = { added };
        break;
      }
      case "ItemChoice": {
        // Choices by level: { "1": {count}, "2": {count} }; picks by title.
        if ( (title === "Fighting Style") && spec.picks?.skipFightingStyle ) break;
        // Oracle: the Divine Order choice is how Destined Path (Protector or Thaumaturge) is picked.
        const added = {};
        for ( const [l, c] of Object.entries(cfg.choices ?? {}) ) {
          if ( Number(l) > level || !c.count ) continue;
          const pool = cfg.pool ?? [];
          const want = spec.picks?.[title] ?? spec.picks?.[opts.choiceKey] ?? [];
          const picked = [];
          for ( const w of want ) {
            for ( const p of pool ) {
              const d = await fromUuid(p.uuid);
              if ( d && (d.name === w || d.name.startsWith(`${w}`) || d.name.includes(w)) && !picked.includes(p.uuid) ) { picked.push(p.uuid); break; }
            }
          }
          if ( !picked.length && pool.length ) picked.push(pool[0].uuid);
          added[l] = {};
          for ( const u of picked.slice(0, c.count) ) {
            const d = await itemData(u, { flags: { dnd5e: { sourceId: u, advancementOrigin: `${item._id}.${a._id}` } } });
            if ( d ) { added[l][d._id] = u; children.push(d); }
          }
        }
        a.value = { added };
        break;
      }
      case "Trait": {
        if ( lv > level ) break;
        const mode = cfg.mode ?? "default";
        const chosen = [...(cfg.grants ?? [])];
        for ( const ch of cfg.choices ?? [] ) {
          const pref = prefixOf(ch);
          let want = spec.picks?.[title];
          if ( !want && pref === "skills" && opts.bg ) want = spec.picks?.bgSkills;
          if ( !want && pref === "tool" && opts.bg ) want = title.includes("Tech") ? spec.picks?.tech : spec.picks?.bgTool;
          if ( !want && pref === "languages" ) want = spec.picks?.langs;
          chosen.push(...fillChoice(ch, want, pref));
        }
        for ( const k of chosen ) applyKey(sys, k, mode);
        a.value = { chosen };
        break;
      }
      case "Size": {
        const sizes = [...(cfg.sizes ?? ["med"])];
        a.value = { size: sizes.includes("med") ? "med" : sizes[0] };
        sys.size = a.value.size;
        break;
      }
      case "AbilityScoreImprovement": {
        if ( lv > level ) break;
        if ( opts.bg ) a.value = { type: "asi", assignments: spec.asi };
        break;
      }
      default: break;
    }
  }
  return children;
}

/* ---------- one character ---------- */

async function rebuild(spec) {
  const actor = game.actors.getName(spec.name);
  if ( !actor ) return `${spec.name}: no actor`;
  const sys = emptySystem(actor);
  const created = [];

  // Species.
  const race = (await itemData(RACES[spec.race].uuid));
  created.push(race, ...(await advance(race, 2, spec, sys)));
  // Background (Outrunner) and its origin feat.
  const bg = await itemData(OUTRUNNER.uuid);
  spec.picks["Origin Feat"] = [spec.origin];
  created.push(bg, ...(await advance(bg, 2, spec, sys, { bg: true })));
  // Class at level 2.
  const cls = await itemData(CLASSES[spec.cls].uuid, { system: { levels: 2 } });
  created.push(cls, ...(await advance(cls, 2, spec, sys)));
  // Spells.
  const ident = cls.system.identifier;
  for ( const n of spec.spells?.cantrips ?? [] ) {
    const d = await itemData(SPELLS[n]); if ( d ) { d.system.sourceItem = `class:${ident}`; created.push(d); }
  }
  for ( const n of spec.spells?.prepared ?? [] ) {
    const d = await itemData(SPELLS[n]); if ( d ) { d.system.sourceItem = `class:${ident}`; d.system.prepared = 1; d.system.method = "spell"; created.push(d); }
  }
  // Gear: Neon Odyssey equipment, a Potion of Healing for everyone, and extras.
  for ( const [n, q, equip] of spec.gear ?? [] ) {
    const d = await itemData(EQUIP[n]); if ( !d ) continue;
    d.system.quantity = q ?? 1;
    if ( equip ) d.system.equipped = true;
    if ( d.type === "weapon" ) d.system.proficient = null;
    created.push(d);
  }
  const extras = [[`Compendium.fvtt-neon-odyssey.equipment.Item.NOeqHealingStim0`, 1], ...(spec.extra ?? [])];
  const merged = {};
  for ( const [u, q] of extras ) merged[u] = (merged[u] ?? 0) + q;
  for ( const [u, q] of Object.entries(merged) ) { const d = await itemData(u); if ( d ) { d.system.quantity = q; created.push(d); } }

  // Reset the actor and write the build.
  await actor.deleteEmbeddedDocuments("Item", actor.items.map(i => i.id));
  if ( actor.effects.size ) await actor.deleteEmbeddedDocuments("ActiveEffect", actor.effects.map(e => e.id));
  const abil = {};
  for ( const [k, v] of Object.entries(spec.abilities) ) abil[k] = { value: v + (spec.asi[k] ?? 0), proficient: sys.abilities[k]?.proficient ?? 0 };
  const tools = {};
  for ( const k of Object.keys(actor.system.tools ?? {}) ) tools[`-=${k}`] = null;
  await actor.update({
    "system.abilities": abil, "system.tools": { ...tools, ...sys.tools },
    // Skill proficiency only: each skill keeps its own ability (replacing the object resets it to DEX).
    ...Object.fromEntries(Object.entries(sys.skills).map(([k, v]) => [`system.skills.${k}.value`, v.value])),
    "system.traits.weaponProf": { value: [...new Set(sys.traits.weaponProf.value)], mastery: { value: [...new Set(sys.traits.weaponProf.mastery.value)] } },
    "system.traits.armorProf.value": [...new Set(sys.traits.armorProf.value)],
    "system.traits.languages.value": [...new Set(sys.traits.languages.value)],
    "system.traits.size": sys.size ?? "med",
    "system.details.level": 2, "system.details.xp.value": 300,
    "system.currency": { pp: 0, gp: 15, ep: 0, sp: 0, cp: 0 }
  });
  await actor.createEmbeddedDocuments("Item", created.filter(Boolean), { keepId: true });
  // Spellcasting ability from the class; full HP and spell slots.
  const castAb = cls.system.spellcasting?.ability;
  if ( castAb ) await actor.update({ "system.attributes.spellcasting": castAb });
  // Juggernaut's Hardened Form: Unarmored Defense (10 + DEX + CON).
  if ( spec.cls === "Juggernaut" ) await actor.update({ "system.attributes.ac.calc": "unarmoredBarb" });
  const max = actor.system.attributes.hp.max;
  const upd = { "system.attributes.hp.value": max, "system.attributes.hp.temp": 0 };
  for ( const [k, v] of Object.entries(actor.system.spells ?? {}) ) if ( v?.max ) upd[`system.spells.${k}.value`] = v.max;
  await actor.update(upd);
  return `${spec.name}: ${spec.race} ${spec.cls} 2, HP ${max}, AC ${actor.system.attributes.ac.value}${castAb ? `, spell DC ${actor.system.attributes.spell?.dc}` : ""}, ${actor.items.size} items`;
}

export async function buildAll(names = null) {
  await loadPacks();
  const restore = [];
  const out = [];
  for ( const spec of CREW ) {
    if ( names && !names.includes(spec.name) ) continue;
    try { out.push(await rebuild(spec)); }
    catch(err) { console.error(err); out.push(`${spec.name}: ERROR ${err.message}`); }
  }
  // Crew Role items come from standing on a station: re-run the station check on every bridge.
  const crew = game.modules.get(MOD).crew;
  for ( const sc of game.scenes.filter(s => s.tiles.some(t => t.getFlag(MOD, "componentArea"))) ) await crew?.reconcileScene?.(sc);
  return out;
}
export { CREW };

/* ---------- S.S. Swiffer crew (John, 2026-10-26) ---------- */
// One new character per station on the Swiffer; each is seated by placing their token on the station card.
const SWIFFER = [
  { name: "Commander Aurelia Voss", station: "commander", cls: "Enforcer", race: "Cygnian", origin: "Brilliant Origin",
    abilities: { str: 14, dex: 10, con: 13, int: 8, wis: 12, cha: 15 }, asi: { cha: 2, str: 1 },
    picks: { "Skill Proficiencies": ["ins", "itm"], "Weapon Mastery": ["saber", "heavypistol"], "Fighting Style": ["Defense"],
      bgSkills: ["prc", "per"], bgTool: ["navigationtools"], langs: ["celestial", "elvish"], tech: ["computerinterface"] },
    spells: { cantrips: [], prepared: ["Bless", "Cure Wounds", "Shield of Faith"] },
    gear: [["Heavy Armor", 1, true], ["Shield", 1, true], ["Saber", 1, true], ["Heavy Pistol", 1, true], ["Power Cell", 4]] },
  { name: "Pilot Kip Marrow", station: "helmsman", cls: "Scoundrel", race: "Aetheron", origin: "Space Origin",
    abilities: { str: 8, dex: 15, con: 14, int: 12, wis: 13, cha: 10 }, asi: { dex: 2, con: 1 },
    picks: { "Skill Proficiencies": ["acr", "slt", "prc", "ste"], "Expertise": ["slt", "acr"], "Weapon Mastery": ["lightlaserpistol", "quickblade"],
      bgSkills: ["dec", "ins"], bgTool: ["navigationtools"], langs: ["elvish", "halfling"], tech: ["computerinterface"] },
    gear: [["Light Armor", 1, true], ["Light Laser Pistol", 1, true], ["Quickblade", 1, true], ["Throwing Blade", 5], ["Power Cell", 4]] },
  { name: "Navigator Ione Zeth", station: "navigator", cls: "Tracer", race: "Zeticulan", origin: "Awakened Mind Origin",
    abilities: { str: 8, dex: 14, con: 13, int: 12, wis: 15, cha: 10 }, asi: { wis: 2, dex: 1 },
    picks: { "Skill Proficiencies": ["ste", "prc", "sur"], "Deft Explorer": ["ste"], "Weapon Mastery": ["lasercarbine", "combatsword"],
      "Fighting Style": ["Archery"], bgSkills: ["dec", "nat"], bgTool: ["navigationtools"], langs: ["elvish", "gnomish"], tech: ["computerinterface"] },
    spells: { cantrips: [], prepared: ["Hunter's Mark", "Cure Wounds", "Longstrider"] },
    gear: [["Light Armor", 1, true], ["Laser Carbine", 1, true], ["Combat Sword", 1, true], ["Power Cell", 4]] },
  { name: "Engineer Hex Calloway", station: "engineer", cls: "Gridrunner", race: "Isotron", origin: "Technologic Origin",
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }, asi: { int: 2, con: 1 },
    picks: { "Skill Proficiencies": ["inv", "ins"], "Scholar": ["inv"], "Neon Odyssey Tool Proficiency": ["technologytoolkit"],
      bgSkills: ["arc", "his"], bgTool: ["electronicstools"], langs: ["dwarvish", "gnomish"], tech: ["computerinterface"] },
    spells: { cantrips: ["Fire Bolt", "Mage Hand", "Circuit Shock"], prepared: ["Shield", "Magic Missile", "Mage Armor", "Grease", "Digitize Knowledge"] },
    gear: [["Combat Staff", 1, true], ["Light Laser Pistol", 1, true], ["Power Cell", 4]] },
  { name: "Gunner Rook Tanaka", station: "gunner", cls: "Soldier", race: "Raizo", origin: "Technologic Origin",
    abilities: { str: 12, dex: 15, con: 14, int: 10, wis: 13, cha: 8 }, asi: { dex: 2, con: 1 },
    picks: { "Skill Proficiencies": ["prc", "sur"], "Weapon Mastery": ["laserrifle", "combatsword", "heavypistol"], "Fighting Style": ["Archery"],
      bgSkills: ["ath", "itm"], bgTool: ["electronicstools"], langs: ["giant", "orc"], tech: ["technologytoolkit"] },
    gear: [["Medium Armor Suit", 1, true], ["Laser Rifle", 1, true], ["Combat Sword", 1, true], ["Power Cell", 4]] },
  { name: "Deckhand Brann Okoro", station: "deck", cls: "Juggernaut", race: "Volcar", origin: "Blazing Origin",
    abilities: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 }, asi: { con: 2, str: 1 },
    picks: { "Skill Proficiencies": ["ath", "sur"], "Weapon Mastery": ["combathammer", "throwingspear"], bgSkills: ["acr", "prc"],
      bgTool: ["mechanicstools"], langs: ["dwarvish", "giant"], tech: ["technologytoolkit"] },
    gear: [["Combat Hammer", 1, true], ["Throwing Spear", 2, true]] }
];

/** Create (if needed), build and seat the Swiffer's crew. */
export async function buildSwiffer() {
  await loadPacks();
  const scene = game.scenes.getName("S.S. Swiffer");
  const folder = game.folders.find(f => (f.type === "Actor") && (f.name === "S.S. Swiffer Crew"))
    ?? await Folder.implementation.create({ name: "S.S. Swiffer Crew", type: "Actor" });
  const out = [];
  for ( const spec of SWIFFER ) {
    let actor = game.actors.getName(spec.name);
    const img = RACES[spec.race]?.img ?? "icons/svg/mystery-man.svg";
    if ( !actor ) actor = await Actor.implementation.create({ name: spec.name, type: "character", folder: folder.id, img,
      prototypeToken: { actorLink: true, disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY, texture: { src: img }, displayName: CONST.TOKEN_DISPLAY_MODES.HOVER } });
    out.push(await rebuild(spec));
    // Seat: the token stands on its station card.
    const tile = scene?.tiles.find(t => t.getFlag(MOD, "station") === spec.station);
    if ( tile ) {
      const g = scene.grid.size, x = tile.x + tile.width / 2 - g / 2, y = tile.y + tile.height / 2 - g / 2;
      const tok = scene.tokens.find(t => t.actorId === actor.id);
      if ( tok ) await tok.update({ x, y });
      else await scene.createEmbeddedDocuments("Token", [(await actor.getTokenDocument({ x, y })).toObject()]);
    }
  }
  await game.modules.get(MOD).crew?.reconcileScene?.(scene);
  return out;
}
