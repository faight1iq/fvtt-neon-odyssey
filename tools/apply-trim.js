// Trim the SRR loadouts the way John trimmed the Assault Scout (2026-10-12):
// side/aft Small guns -> Tiny (no crew, no station), side Torpedo Racks -> Small Torpedo Tubes,
// no deflector, magazines matched to weapon sizes, Cramped, spare Bunk Rooms / Laundry dropped,
// unused gunnery stations removed, leftover space to cargo.
(async () => {
const MID = "fvtt-neon-odyssey";
const D = await import(`/modules/${MID}/scripts/starship-designer.mjs`);
const CALC = await import(`/modules/${MID}/scripts/starship-calc.mjs`);
const pack = game.packs.get(`${MID}.starship-components`);
const idx = await pack.getIndex({ fields: [`flags.${MID}.component`] });
const get = async (n, slot) => {
  const ok = i => i.name === n && i.flags?.[MID]?.component?.v === 2 && (!slot || i.flags[MID].component.slot === slot);
  const e = idx.find(i => ok(i) && (i.flags[MID].component.magazine || i.flags[MID].component.torpedoMagazine)) ?? idx.find(ok);
  if ( !e ) throw new Error("missing " + n);
  return pack.getDocument(e._id);
};
const make = async (actor, n, qty, flags = {}, slot) => {
  const src = await get(n, slot); const o = src.toObject(); delete o._id;
  o.system.quantity = qty;
  o.flags = foundry.utils.mergeObject(o.flags ?? {}, { [MID]: { sourceId: src.uuid, ...flags } });
  return (await actor.createEmbeddedDocuments("Item", [o]))[0];
};
const SHIPS = {
  "C-26 Light Freighter": {},
  "M-30 Scout Destroyer": { tinyBowMissile: true },
  "M-34 Assault Destroyer": { racksToTubes: true },
  "M-37 Heavy Destroyer": { racksToTubes: true },
  "M-38 Frigate": { racksToTubes: true }
};
const only = window.neonTrimOnly;
const report = [];
for ( const [name, spec] of Object.entries(SHIPS) ) {
  if ( only && !only.includes(name) ) continue;
  const actor = game.actors.getName(name);
  const comp = i => D.componentOf(i);
  // 1. Weapons.
  for ( const item of [...actor.items] ) {
    const c = comp(item); if ( c?.slot !== "weapon" ) continue;
    const facing = item.flags[MID]?.facing;
    const small = c.info?.Size === "Small";
    let to = null;
    if ( small && !c.launcher && (facing !== "bow" || (spec.tinyBowMissile && c.info?.Delivery === "Missile")) ) to = item.name.replace("(Small)", "(Tiny)");
    if ( spec.racksToTubes && /^Torpedo Rack \(Small\)$/.test(item.name) ) to = "Torpedo Tube (Small)";
    if ( !to ) continue;
    const qty = item.system.quantity;
    await actor.deleteEmbeddedDocuments("Item", [item.id]);
    const made = await make(actor, to, qty, { facing }, "weapon");
    if ( CALC.needsStation(comp(made)) ) await D.setStation(actor, made, facing !== "bow" && CALC.FACINGS.includes(facing) ? facing : "command");
  }
  // 2. No deflector.
  await actor.deleteEmbeddedDocuments("Item", actor.items.filter(i => comp(i)?.slot === "deflector").map(i => i.id));
  // 3. Magazines matched to weapon sizes (1 per ammo weapon, 1 Torpedo Magazine per launcher).
  await actor.deleteEmbeddedDocuments("Item", actor.items.filter(i => /^(Ammunition|Torpedo) Magazine|^Cargo Hold/.test(i.name)).map(i => i.id));
  const mags = {}, torps = {};
  for ( const i of actor.items ) {
    const c = comp(i); if ( c?.slot !== "weapon" ) continue;
    const q = Math.max(1, i.system.quantity || 1);
    if ( c.ammo?.size ) mags[c.ammo.size] = (mags[c.ammo.size] ?? 0) + q;
    if ( c.launcher?.class ) torps[c.launcher.class] = (torps[c.launcher.class] ?? 0) + q;
  }
  for ( const [z, q] of Object.entries(mags) ) await make(actor, `Ammunition Magazine (${z})`, q, {}, "habitat");
  for ( const [z, q] of Object.entries(torps) ) await make(actor, `Torpedo Magazine (${z})`, q, {}, "habitat");
  // 4. Gunnery stations nobody uses (the one in Command & Control stays).
  const usedSt = new Set(actor.items.map(i => i.flags[MID]?.station?.itemId).filter(Boolean));
  await actor.deleteEmbeddedDocuments("Item", actor.items.filter(i => comp(i)?.stationRoles?.[0] === "gunner"
    && i.flags[MID]?.location !== "command" && !usedSt.has(i.id)).map(i => i.id));
  // 5. Cramped.
  if ( !actor.items.some(i => i.name === "Cramped" && comp(i)?.slot === "descriptor") ) await make(actor, "Cramped", 1, {}, "descriptor");
  let s = await D.recalculate(actor);
  // 6. Spare living space: Bunk Rooms while berths stay >= crew, then Laundry & Stores down to 1.
  const trim = async (re, keep, test) => {
    for ( ;; ) {
      const it = actor.items.find(i => re.test(i.name)); if ( !it ) return;
      const total = actor.items.filter(i => re.test(i.name)).reduce((a, i) => a + (i.system.quantity || 1), 0);
      if ( total <= keep ) return;
      const before = s;
      if ( (it.system.quantity || 1) > 1 ) await it.update({ "system.quantity": it.system.quantity - 1 });
      else await actor.deleteEmbeddedDocuments("Item", [it.id]);
      s = await D.recalculate(actor);
      if ( !test(s) ) { await make(actor, it.name, 1, {}, "habitat"); s = await D.recalculate(actor); return; }
    }
  };
  const habOk = x => !x.checks.some(c => !c.ok && ["berths", "habitat"].includes(c.key));
  await trim(/^Bunk Room$/, 0, x => x.berths >= x.crew && habOk(x));
  await trim(/^Laundry/, 1, habOk);
  // 7. Leftover space to cargo.
  if ( s.compartments.left > 0 ) {
    const hold = (await get("Cargo Hold (Small)", "habitat")).flags[MID].component;
    const per = Math.max(1, -Number(hold.stats?.compartments) || 1);
    const n = Math.floor(s.compartments.left / per);
    if ( n > 0 ) { await make(actor, "Cargo Hold (Small)", n, {}, "habitat"); s = await D.recalculate(actor); }
  }
  report.push(`${name}: comp ${s.compartments.used}/${s.compartments.budget} (left ${s.compartments.left}) | power ${s.power?.produced}/${s.power?.needed} | crew ${s.crew}/${s.berths} | AC ${s.ac} MT ${s.mt} HP ${s.hp} spd ${s.speed} | fails: ${s.checks.filter(c => !c.ok).map(c => c.label + " - " + (c.detail ?? c.text)).join("; ")}`);
}
window.neonTrimReport = report.join("\n");
return window.neonTrimReport;
})()
