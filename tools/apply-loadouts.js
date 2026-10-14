// Apply John's SRR loadouts (2026-10-12). Backs each ship up to "Loadout Backups" first.
// Replaces weapons, magazines and cargo (and armor/shields when listed), adds Small Ammunition
// Magazines (1 per Small ammo weapon), a Torpedo Magazine per launcher, Bunk Rooms for missing
// berths, then fills any space left with Cargo Hold (Small).
(async () => {
const MID = "fvtt-neon-odyssey";
const D = await import(`/modules/${MID}/scripts/starship-designer.mjs`);
const CALC = await import(`/modules/${MID}/scripts/starship-calc.mjs`);
const pack = game.packs.get(`${MID}.starship-components`);
const idx = await pack.getIndex({ fields: [`flags.${MID}.component`] });
const docs = new Map();
const get = async (n, slot) => {
  const k = n + "|" + (slot ?? "");
  if ( !docs.has(k) ) {
    const ok = i => i.name === n && i.flags?.[MID]?.component?.v === 2 && (!slot || i.flags[MID].component.slot === slot);
    // Duplicate names (old magazine ids): prefer the one the calculator understands.
    const e = idx.find(i => ok(i) && (i.flags[MID].component.magazine || i.flags[MID].component.torpedoMagazine)) ?? idx.find(ok);
    if ( !e ) throw new Error("missing " + n);
    docs.set(k, await pack.getDocument(e._id));
  }
  return docs.get(k);
};
const SBB = "Ballistic Bolter (Small)", SM = "Boomer Missile (Small)", SMLA = "MLA (Small)", MMLA = "MLA (Medium)";
const MT = "Torpedo Tube (Medium)", SR = "Torpedo Rack (Small)", MR = "Torpedo Rack (Medium)";
const W = (n, facing, qty = 1) => ({ n, facing, qty });
const L = {
  "M-21 Fighter/Bomber": { addDesc: ["Heavy"], crewless: true,
    w: [W(SBB, "bow"), W(MT, "bow"), W(SM, "port"), W(SM, "starboard")] },
  "M-24 Assault Scout": { w: [W(SBB, "bow"), W(SM, "bow"), W(SBB, "aft")] },
  "C-26 Light Freighter": { w: [W(SMLA, "aft")] },
  "M-30 Scout Destroyer": { w: [W(SBB, "bow"), W(SM, "bow"), W(SBB, "aft")] },
  "M-34 Assault Destroyer": { armor: "Carapace, Standard",
    w: [W(MMLA, "bow"), W(MT, "bow", 2), W(SMLA, "port"), W(SR, "port"), W(SMLA, "starboard"), W(SR, "starboard"), W(SBB, "aft")] },
  "M-37 Heavy Destroyer": { armor: "Carapace, Reinforced",
    w: [W(MMLA, "bow", 2), W(MR, "bow"), W(SMLA, "port"), W(SR, "port"), W(SMLA, "starboard"), W(SR, "starboard"), W(SBB, "aft")] },
  "M-38 Frigate": { armor: "Carapace, Battle",
    w: [W(MMLA, "bow", 2), W(MR, "bow"), W(SMLA, "port"), W(SR, "port"), W(SMLA, "starboard"), W(SR, "starboard"), W(SBB, "aft")] }
};
const only = window.neonLoadoutOnly;
let backups = game.folders.find(f => f.type === "Actor" && f.name === "Loadout Backups");
backups ??= await Folder.create({ name: "Loadout Backups", type: "Actor" });
const report = [];
for ( const [name, spec] of Object.entries(L) ) {
  if ( only && !only.includes(name) ) continue;
  const actor = game.actors.getName(name);
  if ( !actor ) { report.push(name + ": not found"); continue; }
  if ( !game.actors.find(a => a.folder?.id === backups.id && a.name === name + " (backup)") )
    await actor.clone({ name: name + " (backup)", folder: backups.id }, { save: true });
  // Remove what the loadout replaces.
  const del = actor.items.filter(i => {
    const c = D.componentOf(i); if ( !c ) return false;
    if ( c.slot === "weapon" ) return true;
    if ( /^(Ammunition|Torpedo) Magazine|^Cargo Hold/.test(i.name) ) return true;
    if ( spec.armor && c.slot === "armor" ) return true;
    if ( spec.shields && ["deflector", "ablative"].includes(c.slot) ) return true;
    return false;
  }).map(i => i.id);
  await actor.deleteEmbeddedDocuments("Item", del);
  // New parts.
  const add = [];
  const mk = async (n, qty, f = {}, slot) => {
    const src = await get(n, slot); const o = src.toObject(); delete o._id;
    o.system.quantity = qty;
    o.flags = foundry.utils.mergeObject(o.flags ?? {}, { [MID]: { sourceId: src.uuid, ...f } });
    add.push(o);
  };
  for ( const [k, w] of spec.w.entries() ) await mk(w.n, w.qty, { facing: w.facing, loadoutKey: k,
    ...(spec.crewless ? { station: { location: "none", itemId: null } } : {}) }, "weapon");
  if ( spec.armor ) await mk(spec.armor, 1, {}, "armor");
  for ( const [k, s] of (spec.shields ?? []).entries() ) await mk(s, 1, { loadoutKey: 100 + k,
    ...(spec.crewless ? { station: { location: "none", itemId: null } } : {}) });
  for ( const d of spec.addDesc ?? [] ) if ( !actor.items.some(i => i.name === d && D.componentOf(i)?.slot === "descriptor") ) await mk(d, 1, {}, "descriptor");
  // Magazines: 1 Ammunition Magazine per ammo weapon (of its size), 1 Torpedo Magazine per launcher.
  const mags = {}, torps = {};
  for ( const w of spec.w ) {
    const c = (await get(w.n, "weapon")).flags[MID].component;
    if ( c.ammo?.size ) mags[c.ammo.size] = (mags[c.ammo.size] ?? 0) + w.qty;
    if ( c.launcher?.class ) torps[c.launcher.class] = (torps[c.launcher.class] ?? 0) + w.qty;
  }
  for ( const [z, n] of Object.entries(mags) ) await mk(`Ammunition Magazine (${z})`, n, {}, "habitat");
  for ( const [z, n] of Object.entries(torps) ) await mk(`Torpedo Magazine (${z})`, n, {}, "habitat");
  await actor.createEmbeddedDocuments("Item", add);
  // Stations: weapons sit with their facing (bow on the bridge); shields at their default location.
  if ( !spec.crewless ) {
    for ( const item of actor.items.filter(i => i.flags[MID]?.loadoutKey != null) ) {
      const c = D.componentOf(item); const role = CALC.systemRole(c);
      if ( !role ) continue;
      const f = item.flags[MID].facing;
      const loc = role === "gunner" ? (CALC.FACINGS.includes(f) && f !== "bow" ? f : "command") : (CALC.DEFAULT_LOCATION[role] ?? "command");
      await D.setStation(actor, actor.items.get(item.id), loc);
    }
  }
  let s = await D.recalculate(actor);
  // Berths: Bunk Rooms (6 berths each) for any shortfall.
  const short = s.checks.find(c => c.key === "berths" && !c.ok);
  if ( short ) {
    const need = Math.ceil((s.crew - s.berths) / 6);
    await mk("Bunk Room", need, {}, "habitat"); await actor.createEmbeddedDocuments("Item", [add.pop()]);
    s = await D.recalculate(actor);
  }
  // Leftover space to cargo.
  if ( s.compartments.left > 0 ) {
    const hold = (await get("Cargo Hold (Small)", "habitat")).flags[MID].component;
    const per = Math.max(1, -Number(hold.stats?.compartments) || 1);
    const n = Math.floor(s.compartments.left / per);
    if ( n > 0 ) { await mk("Cargo Hold (Small)", n, {}, "habitat"); await actor.createEmbeddedDocuments("Item", [add.pop()]); s = await D.recalculate(actor); }
  }
  report.push(`${name}: comp ${s.compartments.used}/${s.compartments.budget} (left ${s.compartments.left}) | crew ${s.crew} berths ${s.berths} | power ${s.power?.produced}/${s.power?.needed} | AC ${s.ac} MT ${s.mt} HP ${s.hp} spd ${s.speed} | fails: ${s.checks.filter(c => !c.ok).map(c => c.label + " - " + (c.detail ?? c.text)).join("; ")}`);
}
window.neonLoadoutReport = report.join("\n");
return window.neonLoadoutReport;
})()
