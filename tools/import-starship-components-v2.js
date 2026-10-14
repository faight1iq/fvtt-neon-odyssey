// Import the Design Studio components (tools/starship-components-v2.json) into the
// "Starship Components" compendium. Run as a GM in the browser console or a script macro.
// Re-runnable: v2 items keep fixed ids and are replaced; v1 items are moved under "Legacy" once.
(async () => {
  const MOD = "fvtt-neon-odyssey";
  const pack = game.packs.get(`${MOD}.starship-components`);
  const data = await (await fetch(`modules/${MOD}/tools/starship-components-v2.json?${Date.now()}`)).json();
  const wasLocked = pack.locked;
  if ( wasLocked ) await pack.configure({ locked: false });
  await pack.getDocuments();

  // 1. Legacy: every top-level folder that isn't a v2 folder goes under "Legacy", with loose v1 items.
  let legacy = pack.folders.find(f => f.name === "Legacy" && !f.folder);
  if ( !legacy ) legacy = await Folder.create({ name: "Legacy", type: "Item", color: "#555555", sorting: "a" }, { pack: pack.collection });
  const v2Ids = new Set(data.items.map(i => i._id));
  const v2Folder = f => !!f.getFlag?.(MOD, "v2");
  const tops = pack.folders.filter(f => !f.folder && f.id !== legacy.id && !v2Folder(f));
  if ( tops.length ) await Folder.updateDocuments(tops.map(f => ({ _id: f.id, folder: legacy.id })), { pack: pack.collection });
  const loose = pack.index.filter(e => !e.folder && !v2Ids.has(e._id));
  if ( loose.length ) await Item.updateDocuments(loose.map(e => ({ _id: e._id, folder: legacy.id })), { pack: pack.collection });

  // 2. v2 folders (path from item._folder), flagged so a re-run finds them.
  const folderIds = new Map();
  const ensure = async path => {
    const key = path.join("/");
    if ( folderIds.has(key) ) return folderIds.get(key);
    const parent = path.length > 1 ? await ensure(path.slice(0, -1)) : null;
    const name = path.at(-1);
    let f = pack.folders.find(x => x.name === name && (x.folder?.id ?? null) === parent && v2Folder(x));
    if ( !f ) f = await Folder.create({ name, type: "Item", folder: parent, sorting: "a",
      flags: { [MOD]: { v2: true } } }, { pack: pack.collection });
    folderIds.set(key, f.id);
    return f.id;
  };
  const ORDER = ["Ship Classes", "Materials", "Descriptors", "Ship Types", "Propulsion", "Power Sources", "Armor",
    "Shields", "Sensory Gear", "Nexus Cores", "Communications", "Habitats", "Weapons"];
  for ( const [i, n] of ORDER.entries() ) {
    const id = await ensure([n]);
    await pack.folders.get(id).update({ sort: (i + 1) * 1000 });
  }
  await legacy.update({ sort: 99000 });

  // 3. Items: replace existing v2 items, create the rest with their fixed ids.
  const docs = [];
  for ( const it of data.items ) {
    const d = foundry.utils.deepClone(it);
    d.folder = await ensure(d._folder);
    delete d._folder;
    docs.push(d);
  }
  const existing = docs.filter(d => pack.index.has(d._id)).map(d => d._id);
  if ( existing.length ) await Item.deleteDocuments(existing, { pack: pack.collection });
  for ( let i = 0; i < docs.length; i += 100 ) {
    await Item.createDocuments(docs.slice(i, i + 100), { pack: pack.collection, keepId: true });
  }
  if ( wasLocked ) await pack.configure({ locked: true });
  const msg = `Starship Components v2: ${docs.length} items imported (${existing.length} replaced); ${tops.length} folders and ${loose.length} loose items moved to Legacy.`;
  console.log(msg); ui.notifications.info(msg);
  return msg;
})();
