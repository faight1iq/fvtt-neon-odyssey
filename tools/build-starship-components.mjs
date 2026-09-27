// Builds the "Starship Components" compendium from the Paradox 5E Starships spreadsheet.
//
// Usage (from the module root):
//   1. In Google Sheets: File > Download > Microsoft Excel (.xlsx)
//   2. npm install --no-save xlsx @foundryvtt/foundryvtt-cli
//   3. node tools/build-starship-components.mjs "path/to/Paradox 5E Starships.xlsx"
//
// Outputs:
//   src/packs/starship-components/*.json   (readable source, one file per document)
//   packs/starship-components/             (compiled LevelDB pack Foundry loads)
//   scripts/starship-data.mjs              (size table used by the designer math)
//
// Quit Foundry before running: it locks packs it has open.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import XLSX from "xlsx";
import { compilePack } from "@foundryvtt/foundryvtt-cli";

const MODULE_ID = "fvtt-neon-odyssey";
const PACK = "starship-components";
const xlsxPath = process.argv[2];
if ( !xlsxPath ) { console.error("Pass the path to the exported .xlsx"); process.exit(1); }

const wb = XLSX.readFile(xlsxPath);
const ws = wb.Sheets["Components"];
const cell = (col, row) => ws[`${col}${row}`]?.v ?? null;
const num = v => (v === null || v === "" || v === "-" ? 0 : Number(String(v).replace("+", "")) || 0);
const str = v => (v === null ? "" : String(v).trim());
const list = v => str(v).split(",").map(s => s.trim()).filter(Boolean);
const id16 = key => crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
const rows = (a, b, lookupCol) => {
  const out = [];
  for ( let r = a; r <= b; r++ ) if ( str(cell(lookupCol, r)) ) out.push(r);
  return out;
};

// Table locations match the named ranges in the spreadsheet.
const SIZES = rows(2, 10, "M").map(r => ({
  key: str(cell("M", r)), name: str(cell("B", r)), keel: num(cell("C", r)), tons: num(cell("D", r)),
  speed: num(cell("E", r)), hull: str(cell("F", r)), dt: num(cell("G", r)), con: num(cell("I", r)),
  power: num(cell("J", r)), hp: num(cell("N", r)), desc: str(cell("O", r))
}));

const categories = {
  shipType:   { label: "Ship Types",   icon: "icons/svg/cube.svg" },
  material:   { label: "Materials",    icon: "icons/svg/statue.svg" },
  propulsion: { label: "Propulsion",   icon: "icons/svg/wing.svg" },
  power:      { label: "Power Sources", icon: "icons/svg/lightning.svg" },
  defense:    { label: "Defenses",     icon: "icons/svg/shield.svg" },
  special:    { label: "Specials",     icon: "icons/svg/aura.svg" },
  weapon:     { label: "Weapons",      icon: "icons/svg/target.svg" }
};

const components = [];
const add = (category, key, name, stats, extra = {}) => components.push({ category, key, name, stats, ...extra });

for ( const r of rows(214, 217, "M") ) add("shipType", str(cell("M", r)), str(cell("B", r)), {
  desc: str(cell("C", r)), mishaps: list(cell("D", r))
});
for ( const r of rows(14, 32, "M") ) add("material", str(cell("M", r)), str(cell("B", r)), {
  ac: num(cell("C", r)), speed: num(cell("D", r)), dt: num(cell("E", r)), cost: num(cell("F", r)), desc: str(cell("N", r))
});
for ( const r of rows(35, 51, "M") ) add("propulsion", str(cell("M", r)), str(cell("B", r)), {
  power: num(cell("C", r)), speed: num(cell("D", r)), mishap: num(cell("E", r)), dex: num(cell("F", r)),
  crew: num(cell("G", r)), cost: num(cell("H", r)), desc: str(cell("N", r)), mishaps: list(cell("O", r))
});
for ( const r of rows(55, 108, "M") ) add("power", str(cell("M", r)), str(cell("B", r)), {
  power: num(cell("C", r)), mishap: num(cell("D", r)), str: num(cell("E", r)), crew: num(cell("G", r)),
  cost: num(cell("H", r)), desc: str(cell("N", r)), mishaps: list(cell("O", r))
});
for ( const r of rows(112, 121, "M") ) add("defense", str(cell("M", r)), str(cell("B", r)), {
  ac: num(cell("C", r)), power: num(cell("D", r)), mishap: num(cell("E", r)), speed: num(cell("F", r)),
  cost: num(cell("G", r)), mishaps: list(cell("O", r))
});
for ( const r of rows(222, 229, "M") ) add("special", str(cell("M", r)), str(cell("B", r)), {
  desc: str(cell("C", r)), speed: num(cell("D", r)), ac: num(cell("E", r)), hp: num(cell("F", r)),
  dt: num(cell("G", r)), mishap: num(cell("H", r)), power: num(cell("I", r)), other: str(cell("J", r))
});
for ( const r of rows(125, 184, "L") ) add("weapon", str(cell("L", r)), str(cell("B", r)), {
  damage: str(cell("C", r)), range: str(cell("D", r)), crew: num(cell("F", r)), power: num(cell("G", r)),
  mishap: num(cell("H", r)), minSize: str(cell("I", r)), damageType: str(cell("J", r)), cost: num(cell("K", r)),
  desc: str(cell("M", r)), mishaps: list(cell("N", r))
});

/* -------------------------------------------- */

const RANGE_BANDS = { PB: "Point Blank", Short: "Short", Medium: "Medium", Long: "Long", Extreme: "Extreme" };
const STAT_LABELS = {
  speed: "Speed", ac: "AC", hp: "HP", dt: "Damage Threshold", mishap: "Mishap", power: "Power",
  crew: "Crew", cost: "Cost", str: "STR", dex: "DEX", minSize: "Min Ship Size", other: "Other"
};

function describe(c) {
  const s = c.stats;
  const lines = Object.entries(STAT_LABELS)
    .filter(([k]) => s[k] !== undefined && s[k] !== 0 && s[k] !== "")
    .map(([k, label]) => `<li><strong>${label}:</strong> ${k === "cost" ? `${Number(s[k]).toLocaleString("en-US")} gp` : s[k]}</li>`);
  if ( s.mishaps?.length ) lines.push(`<li><strong>Mishaps:</strong> ${s.mishaps.join(", ")}</li>`);
  return `<p><em>Paradox starship component: ${categories[c.category].label}.</em></p><ul>${lines.join("")}</ul>`;
}

/** Convert the spreadsheet's damage text to dnd5e base damage. */
function parseDamage(text, type) {
  const types = type && type !== "as spell" ? [type.toLowerCase()] : [];
  const simple = /^(\d*)d(\d+)$/i.exec(text);
  if ( simple ) return { number: Number(simple[1] || 1), denomination: Number(simple[2]), types, custom: { enabled: false }, bonus: "" };
  let formula = text
    .replace(/(\d+)k\b/gi, (_, n) => String(Number(n) * 1000))
    .replace(/^d(\d+)/i, "1d$1");
  const perTon = /^1?d(\d+) per Ship ton$/i.exec(text);
  if ( perTon ) formula = `(@traits.weight.value)d${perTon[1]}`;
  if ( text === "as spell" ) return { number: null, denomination: null, types: [], custom: { enabled: false }, bonus: "" };
  return { number: null, denomination: null, types, custom: { enabled: true, formula }, bonus: "" };
}

const stats = { systemId: "dnd5e", coreVersion: "13.351", systemVersion: "5.3.3" };
const folders = Object.entries(categories).map(([key, c], i) => ({
  _id: id16(`folder:${key}`), name: c.label, type: "Item", sorting: "a", sort: (i + 1) * 100000,
  color: null, folder: null, description: "", flags: {}, _stats: stats, _key: `!folders!${id16(`folder:${key}`)}`
}));
const folderId = key => id16(`folder:${key}`);

const docs = components.map((c, i) => {
  const _id = id16(`${c.category}:${c.key}`);
  const flags = { [MODULE_ID]: { component: { category: c.category, key: c.key, ...c.stats } } };
  const base = {
    _id, name: c.name, img: categories[c.category].icon, folder: folderId(c.category), sort: i * 100,
    effects: [], ownership: { default: 0 }, _stats: stats, _key: `!items!${_id}`
  };
  if ( c.category !== "weapon" ) {
    return {
      ...base, type: "equipment", flags,
      system: {
        description: { value: describe(c), chat: "" },
        source: { custom: "Paradox 5E Starships" },
        identifier: c.key.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        quantity: 1, price: { value: c.stats.cost ?? 0, denomination: "gp" },
        type: { value: "vehicle", baseItem: "" }
      }
    };
  }
  flags[MODULE_ID].crew = c.stats.crew || null;
  flags[MODULE_ID].rangeBand = RANGE_BANDS[c.stats.range] ?? c.stats.range;
  return {
    ...base, type: "weapon", flags,
    system: {
      description: { value: `<p>${c.stats.desc}</p>${describe(c)}`, chat: "" },
      source: { custom: "Paradox 5E Starships" },
      identifier: c.key.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      quantity: 1, price: { value: c.stats.cost, denomination: "gp" },
      range: { value: null, long: null, units: "", reach: null },
      damage: { base: parseDamage(c.stats.damage, c.stats.damageType) },
      type: { value: "siege", baseItem: "" },
      properties: [],
      activities: {
        [_id]: {
          _id, type: "attack", sort: 0,
          activation: { type: "action", value: 1, override: false, condition: "" },
          attack: { ability: "none", bonus: "", flat: false, critical: { threshold: null },
            type: { value: "ranged", classification: "weapon" } },
          damage: { critical: { bonus: "" }, includeBase: true, parts: [] },
          range: { value: "", units: "", special: RANGE_BANDS[c.stats.range] ?? "", override: false }
        }
      }
    }
  };
});

/* -------------------------------------------- */

const srcDir = path.join("src", "packs", PACK);
const outDir = path.join("packs", PACK);
fs.rmSync(srcDir, { recursive: true, force: true });
fs.mkdirSync(srcDir, { recursive: true });
for ( const d of [...folders, ...docs] ) {
  const file = `${d.name.replace(/[^A-Za-z0-9]+/g, "_")}_${d._id}.json`;
  fs.writeFileSync(path.join(srcDir, file), JSON.stringify(d, null, 2) + "\n");
}
fs.rmSync(outDir, { recursive: true, force: true });
await compilePack(srcDir, outDir, { log: false });

fs.writeFileSync(path.join("scripts", "starship-data.mjs"),
  "// Auto-generated by tools/build-starship-components.mjs from the Paradox 5E Starships spreadsheet.\n"
  + "// Do not edit by hand.\n"
  + `export const SIZES = ${JSON.stringify(SIZES, null, 2)};\n`);

const counts = Object.fromEntries(Object.keys(categories).map(k => [k, components.filter(c => c.category === k).length]));
console.log(`Starship Components: ${docs.length} items`, counts);
