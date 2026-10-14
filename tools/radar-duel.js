// Automated radar battle (GM console): the Player ship at the radar center against one or more
// Enemies on the radar. The Player steers with the radar's own buttons (crew.steerForward / steerTurn,
// spending the Speed display); each Enemy steers with the GM Helm (crew.steerShip). Rolls go to chat.
//   const src = await fetch("modules/fvtt-neon-odyssey/tools/radar-duel.js").then(r => r.text());
//   (0, eval)(src);            // window.neonDuel.stop() ends it early
// Options: window.neonDuelOptions = { attack: 6, delay: 1500, rounds: 20, enemies: ["<token id>", ...],
//   approach: { clock: 5, ranges: [3.3, 3.7, 4.1] },   // optional: place the Enemies at that bearing first
//   cover: 2,             // the Player turns to keep its bow and side weapons on at least this many Enemies
//   torpedoLife: 5 }      // rounds a torpedo runs before it burns out
//   (default enemies: every other ship on the radar)
// Torpedoes (John, 2026-10-12): the Player launches from its launchers at Enemies in their facing
// (Long range or closer); a Rack fires its whole salvo. Each torpedo is a token of the torpedo
// actor (M-00 Small / M-03 Medium / M-07 Large Torpedo) that chases its target at its own Speed;
// reaching Point Blank is an attack roll with its warhead's damage. Empty launchers reload from
// the Torpedo Magazines (1 torpedo each) at the start of the Player's turn.
// Every weapon fires if a target is in its facing (90°) and range. Weapons whose description says
// "Ignores armor" (MLA) put their Mishaps straight on systems. Missiles and Ballistic weapons spend
// magazine ammo (rule 20) from a working copy: the ships' own magazines aren't touched.
// Damage, Strain and Mishaps follow rule 16 (John, 2026-10-12), tracked by this script only: no HP,
// Strain drawing or Tempo is changed. Speed is refilled each round for every ship.
(async () => {
  const MOD = "fvtt-neon-odyssey";
  window.neonDuel = { stop: () => { window.neonDuel.stopped = true; }, done: false };
  const opt = { attack: 6, delay: 1500, rounds: 20, cover: 2, torpedoLife: 5, ...(window.neonDuelOptions ?? {}) };
  const scene = canvas.scene;
  const crew = game.modules.get(MOD).crew;
  const ML = await import(`/modules/${MOD}/scripts/mishap-links.mjs`);
  const DS = await import(`/modules/${MOD}/scripts/starship-designer.mjs`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const stopped = () => !!window.neonDuel.stopped;

  const tile = scene.tiles.find(t => t.getFlag(MOD, "radar"));
  if (!tile) return ui.notifications.warn("No radar on this scene.");
  const sc = Number(tile.getFlag(MOD, "areaScale")) || 1;
  const W = Math.abs(tile._source.width), H = Math.abs(tile._source.height);
  const area = { x: tile._source.x + W / 2, y: tile._source.y + H / 2, r: (Math.min(W, H) / 2) * sc };
  const BAND = area.r / 5;
  const playerTok = crew.radarCenterShip(scene);
  const enemyToks = opt.enemies ? opt.enemies.map(id => scene.tokens.get(id)).filter(Boolean)
    : scene.tokens.filter(t => t.actor?.type === "vehicle" && t.id !== playerTok?.id && t.getFlag(MOD, "radarSize"));
  if (!playerTok || !enemyToks.length) return ui.notifications.warn("Need a Player ship at the radar center and Enemy ships on the radar.");

  const ARC = { bow: 0, starboard: 90, aft: 180, port: 270 };
  const RANGES = ["PB", "Short", "Medium", "Long", "Extreme"];
  const SIZE_TIER = { Tiny: 1, Small: 1, Medium: 2, Large: 3, Huge: 4, Gargantuan: 5 };
  const SYSTEMS = ["Command & Control", "Navigation", "Power", "Propulsion", "Bow", "Port", "Starboard", "Aft", "Habitat"];
  const CRIT = new Set(["Command & Control", "Power", "Propulsion"]);
  const FACING_SYS = { bow: "Bow", port: "Port", starboard: "Starboard", aft: "Aft" };
  const side = (label, token) => {
    const a = token.actor;
    // Launchers have no damage of their own: torpedoes wait on the launch-and-chase rules.
    const weapons = a.items.filter(i => i.type === "weapon" && i.flags[MOD]?.component
      && /\d+d\d+/.test(String(i.flags[MOD].component.info?.Damage ?? ""))).map(w => {
      const wc = w.flags[MOD].component;
      const [lo, hi] = String(wc.info.Range).replace("Point Blank", "PB").split(/[–-]/).map(s => s.trim());
      return { item: w, name: w.name, dmg: String(wc.info.Damage).match(/\d+d\d+/)[0], type: wc.info["Damage Type"] ?? "",
        facing: w.flags[MOD]?.facing ?? "bow", lo: lo || "Short", hi: hi || lo || "Long", tier: SIZE_TIER[wc.info.Size] ?? 1,
        qty: Math.max(1, Number(w.system.quantity) || 1), ignoresArmor: /ignores armor/i.test(wc.info.Description ?? ""),
        ammo: DS.weaponAmmo(a, w.id), delivery: wc.info.Delivery ?? "", pd: !!wc.pointDefense,
        // Missile Racks (rule 26): area volley, DEX save for half; loaded volleys per rack.
        rack: wc.rack ? { ...wc.rack, ready: true, loaded: (Number(wc.rack.volleys) || 2) * Math.max(1, Number(w.system.quantity) || 1) } : null };
    });
    // Magazines (rule 20): a working copy, so the ship's own ammo isn't spent by the simulation.
    const pools = foundry.utils.deepClone(DS.ammoPools(a));
    // One magazine per ammo weapon: each weapon draws from its own magazine, so missiles can't
    // empty the gun's rounds. Fewer magazines than weapons: the size's magazines are shared.
    const bySize = {};
    for (const w of weapons) if (w.ammo) (bySize[w.ammo.size] ??= []).push(w);
    for (const [z, ws] of Object.entries(bySize)) {
      const p = pools[z]; if (!p) continue;
      const n = ws.reduce((t, w) => t + w.qty, 0);
      if (p.capacity / 12 < n) continue;
      const each = Math.floor(p.capacity / n / 12) * 12;
      for (const w of ws) { const key = `${z} (${w.name}, ${w.facing})`; pools[key] = { capacity: each * w.qty, left: each * w.qty }; w.ammo = { ...w.ammo, size: key }; }
      delete pools[z];
    }
    return { label, token, name: `${label}: ${token.name}`, actor: a, weapons, pools,
      ac: a.system.attributes.ac.flat ?? a.system.attributes.ac.value, hp: a.system.attributes.hp.max, mt: a.system.attributes.hp.mt,
      speed: crew.shipSpeed(a), dex: a.system.abilities.dex.mod,
      rackReloads: Object.fromEntries(Object.entries(a.getFlag(MOD, "analysis")?.ammo?.racks ?? {}).map(([z, t]) => [z, t.reloads ?? 0])),
      armor: a.items.some(i => i.flags[MOD]?.component?.slot === "armor"), strain: 0, armorM: 0, sys: {}, disabled: null };
  };
  // Fresh analysis first: ammo and torpedo data come from it.
  for (const t of [playerTok, ...enemyToks]) if (t.actor) await DS.recalculate(t.actor).catch(() => null);
  const P = side("Player", playerTok);
  const E = enemyToks.map((t, i) => side(enemyToks.length > 1 ? `Enemy ${i + 1}` : "Enemy", t));
  const say = (html, who) => ChatMessage.implementation.create({ content: `<div class="no-crew-card">${html}</div>`, speaker: { alias: who?.name ?? "Radar Battle" } });

  // Geometry in bands, relative to the Player (center, nose up); y is forward (up on screen).
  const stateOf = e => { const s = e.token._source, half = (s.width * scene.grid.size) / 2;
    return { x: (s.x + half - area.x) / BAND, y: (area.y - (s.y + half)) / BAND, h: s.rotation ?? 0 }; };
  const ORIGIN = { x: 0, y: 0, h: 0 };
  const rel = (from, to) => { const dx = to.x - from.x, dy = to.y - from.y;
    const bear = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360; return { dist: Math.hypot(dx, dy), rb: ((bear - from.h) % 360 + 360) % 360 }; };
  const band = d => d < 1 ? "PB" : d < 2 ? "Short" : d < 3 ? "Medium" : d < 4 ? "Long" : d < 5 ? "Extreme" : "Out";
  const clock = rb => (Math.round(rb / 30) % 12) || 12;
  const weaponShot = (ship, w, from, to) => {
    if ((ship.sys[FACING_SYS[w.facing]] ?? 0) >= 2) return null;            // that weapon block is disabled
    if (w.ammo && ((ship.pools[w.ammo.size]?.left ?? 0) < w.ammo.cost)) return null;   // out of ammo
    if (w.rack && (w.rack.loaded < 1 || !w.rack.ready)) return null;            // rack empty or recharging
    const { dist, rb } = rel(from, to);
    if (Math.abs(((rb - ARC[w.facing]) + 540) % 360 - 180) > 45) return null;
    const bd = band(dist), i = RANGES.indexOf(bd); if (i < 0) return null;
    if (bd === "PB" && w.lo !== "PB") return { dis: true, bd };
    if (i < RANGES.indexOf(w.lo) || i > RANGES.indexOf(w.hi)) return null;
    return { dis: false, bd };
  };
  const anyShot = (ship, from, to) => ship.weapons.some(w => weaponShot(ship, w, from, to));
  const clamp = s => { const d = Math.hypot(s.x, s.y); return d > 4.7 ? { ...s, x: s.x * 4.7 / d, y: s.y * 4.7 / d } : s; };
  const playerStep = (e, a) => {     // the Player's maneuver, seen as every other ship moving
    if (a === "F") return clamp({ ...e, y: e.y - 1 });
    const deg = a === "L" ? 30 : -30, r = deg * Math.PI / 180;
    return clamp({ x: e.x * Math.cos(r) + e.y * Math.sin(r), y: -e.x * Math.sin(r) + e.y * Math.cos(r), h: (e.h + deg + 360) % 360 });
  };
  const enemyStep = (e, a) => {
    if (a === "F") { const r = e.h * Math.PI / 180; return clamp({ ...e, x: e.x + Math.sin(r), y: e.y + Math.cos(r) }); }
    return { ...e, h: (e.h + (a === "L" ? -30 : 30) + 360) % 360 };
  };
  const plans = speed => { const out = [[]]; const rec = (seq, b, f, sp) => { if (seq.length >= 6) return; for (const a of ["F", "L", "R"]) {
    const c = a === "F" ? 2 ** b : f + 1; if (sp + c > speed) continue; const s2 = [...seq, a]; out.push(s2);
    rec(s2, b + (a === "F"), f + (a !== "F"), sp + c); } }; rec([], 0, 0, 0); return out; };
  const live = () => E.filter(e => !e.disabled);
  const choosePlayer = speed => {
    let best = [], bs = -1e9;
    for (const p of plans(speed)) {
      const st = live().map(e => { let s = stateOf(e); for (const a of p) s = playerStep(s, a); return { e, s }; });
      let score = 0;
      // Keep the bow and side weapons facing at least `cover` Enemies (John, 2026-10-12).
      const covered = st.filter(({ s }) => { const { dist, rb } = rel(ORIGIN, s);
        return dist < 5 && ["bow", "port", "starboard"].some(f => Math.abs(((rb - ARC[f]) + 540) % 360 - 180) <= 45); }).length;
      score += Math.min(covered, opt.cover) * 150 + covered * 20;
      for (const { e, s } of st) {
        const n = P.weapons.filter(w => weaponShot(P, w, ORIGIN, s)).length;
        score += n * 100 / (1 + e.strain / e.hp);                       // prefer shots, slightly on fresher targets
        if (anyShot(e, s, ORIGIN)) score -= 40;
        score -= Math.abs(Math.hypot(s.x, s.y) - 2.5) * 3;
      }
      score += Math.random() - p.length * 0.3;
      if (score > bs) { bs = score; best = p; }
    }
    return best;
  };
  const chooseEnemy = (me, speed) => {
    let best = [], bs = -1e9;
    for (const p of plans(speed)) {
      let s = stateOf(me); for (const a of p) s = enemyStep(s, a);
      const mine = me.weapons.filter(w => weaponShot(me, w, s, ORIGIN)).length;
      const score = mine * 100 - (anyShot(P, ORIGIN, s) ? 30 : 0) - Math.abs(Math.hypot(s.x, s.y) - 2.5) * 5 + Math.random() - p.length * 0.3;
      if (score > bs) { bs = score; best = p; }
    }
    return best;
  };
  const WORD = { F: "Forward", L: "Turn Left", R: "Turn Right" };

  const mishapCount = s => s.armorM + Object.values(s.sys).reduce((a, b) => a + b, 0);
  const attack = async (att, def, w, sh) => {
    let ammoNote = "";
    if (w.ammo) { const pool = att.pools[w.ammo.size]; pool.left -= w.ammo.cost;
      ammoNote = `, ${w.ammo.size} magazine ${pool.left}/${pool.capacity} left`; }
    const pd = ["Missile", "Warhead"].includes(w.delivery) && pdCovers(def, att);
    const atk = await new Roll((sh.dis || pd) ? `2d20kl + ${opt.attack}` : `1d20 + ${opt.attack}`).evaluate();
    const crit = atk.dice[0].total === 20;
    await atk.toMessage({ flavor: `${att.name} fires ${w.name} (${w.facing}) at ${def.name} (${sh.bd}${sh.dis ? ", disadvantage" : ""}${pd ? ", Point Defense: disadvantage" : ""}${ammoNote}) vs AC ${def.ac}`, speaker: { alias: att.name } });
    await sleep(opt.delay);
    if (!crit && atk.total < def.ac) return say(`<p><strong>Miss.</strong></p>`, att);
    const dmg = await new Roll(crit ? w.dmg.replace(/^(\d+)d/, (m, n) => `${2 * n}d`) : w.dmg).evaluate();
    await dmg.toMessage({ flavor: `${att.name}: ${crit ? "CRITICAL " : ""}hit! ${w.type} damage to ${def.name}`, speaker: { alias: att.name } });
    const before = def.strain; def.strain += dmg.total;
    let msg = `<p><strong>${def.name}</strong>: Strain ${before} → <strong>${def.strain}</strong> of ${def.hp} HP (MT ${def.mt}).</p>`;
    if (def.strain > def.mt) {
      let where;
      if (def.armor && def.armorM < 2 && !w.ignoresArmor) { def.armorM++; where = `Armor (${def.armorM} of 2)`; }
      else { const s = SYSTEMS[Math.floor(Math.random() * SYSTEMS.length)]; def.sys[s] = (def.sys[s] ?? 0) + 1;
        where = `${s} (${def.sys[s]})${w.ignoresArmor && def.armor && def.armorM < 2 ? " — ignores armor" : ""}`;
        if (def.sys[s] >= 2) { if (CRIT.has(s)) def.disabled ??= `${s} has 2 Mishaps`; else msg += `<p>${s} is <strong>disabled</strong> until a Mishap is cleared.</p>`; } }
      const m = await ML.rollMishap(def.actor, w.tier);
      msg += `<p class="no-crew-alert"><strong>MISHAP</strong> on ${where}: ${m ? `@UUID[${m.uuid}]{${m.name}}` : "roll one"} (${ML.MISHAP_TIERS[w.tier - 1]}).</p>`;
    }
    if (def.strain > def.hp) def.disabled ??= `Strain ${def.strain} exceeds ${def.hp} HP`;
    if (def.disabled) msg += `<p class="no-crew-alert"><strong>${def.name} DISABLED</strong>: ${def.disabled}.</p>`;
    await say(msg, def);
    await sleep(opt.delay);
  };
  // Point Defense (rule 27): a working Point Defense Cannon whose facing points at the attacker.
  const posOf = s => s === P ? ORIGIN : stateOf(s);
  const pdCovers = (def, att) => {
    if (!def?.weapons) return false;
    const { rb } = rel(posOf(def), posOf(att));
    return def.weapons.some(w => w.pd && (def.sys[FACING_SYS[w.facing]] ?? 0) < 2
      && Math.abs(((rb - ARC[w.facing]) + 540) % 360 - 180) <= 45);
  };
  // Strain, Mishaps and disabling from one hit (rule 16).
  const hurt = async (att, def, w, amount, note = "") => {
    const before = def.strain; def.strain += amount;
    let msg = `<p><strong>${def.name}</strong>: ${note}Strain ${before} → <strong>${def.strain}</strong> of ${def.hp} HP (MT ${def.mt}).</p>`;
    if (amount > 0 && def.strain > def.mt) {
      let where;
      if (def.armor && def.armorM < 2 && !w.ignoresArmor) { def.armorM++; where = `Armor (${def.armorM} of 2)`; }
      else { const s = SYSTEMS[Math.floor(Math.random() * SYSTEMS.length)]; def.sys[s] = (def.sys[s] ?? 0) + 1; where = `${s} (${def.sys[s]})`;
        if (def.sys[s] >= 2) { if (CRIT.has(s)) def.disabled ??= `${s} has 2 Mishaps`; else msg += `<p>${s} is <strong>disabled</strong> until a Mishap is cleared.</p>`; } }
      const m = await ML.rollMishap(def.actor, w.tier);
      msg += `<p class="no-crew-alert"><strong>MISHAP</strong> on ${where}: ${m ? `@UUID[${m.uuid}]{${m.name}}` : "roll one"} (${ML.MISHAP_TIERS[w.tier - 1]}).</p>`;
    }
    if (def.strain > def.hp) def.disabled ??= `Strain ${def.strain} exceeds ${def.hp} HP`;
    if (def.disabled) msg += `<p class="no-crew-alert"><strong>${def.name} DISABLED</strong>: ${def.disabled}.</p>`;
    await say(msg, def);
  };
  // Missile Rack volley: every ship in the facing at PB–Medium saves (friendly ships with advantage).
  const volley = async (att, w) => {
    const from = att === P ? ORIGIN : stateOf(att);
    const caught = [P, ...E].filter(s => s !== att && !s.disabled && (s.torpedo !== true)).filter(s => {
      const to = s === P ? ORIGIN : stateOf(s); const { dist, rb } = rel(from, to);
      return dist < 3 && Math.abs(((rb - ARC[w.facing]) + 540) % 360 - 180) <= 45; });
    if (!caught.some(s => (s === P) !== (att === P))) return false;            // no enemy in the cone
    w.rack.loaded--; w.rack.ready = false;      // every volley needs Recharge 5–6 before the next
    const dmg = await new Roll(w.dmg).evaluate();
    await dmg.toMessage({ flavor: `${att.name} fires a ${w.name} volley (${w.facing}) — DC ${w.rack.dc} Dexterity save, half on a success; ${w.rack.loaded} volley${w.rack.loaded === 1 ? "" : "s"} left in the rack`, speaker: { alias: att.name } });
    await sleep(opt.delay);
    for (const s of caught) {
      const friendly = (s === P) === (att === P), pd = pdCovers(s, att);
      const sv = await new Roll(`${(friendly || pd) ? "2d20kh" : "1d20"} + ${s.dex}`).evaluate();
      await sv.toMessage({ flavor: `${s.name}: Dexterity save vs DC ${w.rack.dc}${friendly ? " (friendly, advantage)" : pd ? " (Point Defense, advantage)" : ""}`, speaker: { alias: s.name } });
      const ok = sv.total >= w.rack.dc, amt = ok ? Math.floor(dmg.total / 2) : dmg.total;
      await hurt(att, s, w, amt, ok ? "saves, half damage. " : "fails the save. ");
      await sleep(opt.delay * 0.5);
    }
    return true;
  };
  // Start of a ship's turn (John, 2026-10-13): a rack that has fired rolls Recharge 5–6 (new missiles
  // moved into place and targeted). An empty rack reloads from its magazines as part of that recharge.
  const rackReload = async ship => {
    for (const w of ship.weapons) {
      if (!w.rack || w.rack.ready) continue;
      const need = Number(w.rack.volleys) || 2;
      const canLoad = w.rack.loaded > 0 || (ship.rackReloads[w.rack.size] ?? 0) >= need;
      if (!canLoad) continue;                                                   // empty, no reloads left
      const r = await new Roll("1d6").evaluate();
      if (r.total >= (w.rack.recharge ?? 5)) {
        w.rack.ready = true;
        let note = `${w.rack.loaded} volley${w.rack.loaded === 1 ? "" : "s"} in the rack`;
        if (w.rack.loaded < 1) { w.rack.loaded = need; ship.rackReloads[w.rack.size] -= need;
          note = `reloaded ${need} volleys; ${ship.rackReloads[w.rack.size]} left in the magazines`; }
        await say(`<p>${ship.name}: ${w.name} (${w.facing}) recharged (${r.total}); ${note}.</p>`, ship);
      } else await say(`<p>${ship.name}: ${w.name} (${w.facing}) still recharging (${r.total}).</p>`, ship);
    }
  };
  const fireAll = async (att, targets, fromOf) => {
    let fired = false;
    for (const w of att.weapons) for (let q = 0; q < w.qty; q++) {
      if (w.rack) { if (w.rack.loaded > 0 && w.rack.ready && await volley(att, w)) fired = true; if (P.disabled || !live().length) return true; continue; }
      const opts = targets.filter(t => !t.ship.disabled).map(t => ({ ...t, sh: weaponShot(att, w, fromOf(att, t), fromOf(t.ship, t, true)) })).filter(t => t.sh);
      if (!opts.length) continue;
      const tgt = opts.sort((a, b) => (b.ship.strain / b.ship.hp) - (a.ship.strain / a.ship.hp))[0];   // finish the most damaged
      fired = true; await attack(att, tgt.ship, w, tgt.sh);
      if (P.disabled || !live().length) return true;
    }
    return fired;
  };

  // ---- Torpedoes ----
  const TORP_ACTOR = { Small: "M-00 Small Torpedo", Medium: "M-03 Medium Torpedo", Large: "M-07 Large Torpedo" };
  const launchers = playerTok.actor.items.filter(i => i.flags[MOD]?.component?.launcher).map(i => {
    const L = i.flags[MOD].component.launcher;
    return { item: i, name: i.name, cls: L.class, tubes: Number(L.tubes) || 1, facing: i.flags[MOD]?.facing ?? "bow",
      qty: Math.max(1, Number(i.system.quantity) || 1), loaded: (Number(L.tubes) || 1) * Math.max(1, Number(i.system.quantity) || 1) };
  });
  const reloads = Object.fromEntries(Object.entries(DS.ammoPools ? (playerTok.actor.getFlag(MOD, "analysis")?.ammo?.torpedoes ?? {}) : {})
    .map(([z, t]) => [z, t.reloads ?? 0]));
  const torpedoes = [];   // { token, cls, target, life, w }
  const torpProto = {};
  for (const cls of new Set(launchers.map(l => l.cls))) {
    const a = game.actors.getName(TORP_ACTOR[cls]);
    if (!a) { ui.notifications.warn(`No ${TORP_ACTOR[cls]} actor: ${cls} launchers won't fire.`); continue; }
    const wh = a.items.find(i => i.flags[MOD]?.component?.info?.Delivery === "Warhead");
    const wc = wh?.flags[MOD]?.component;
    torpProto[cls] = { actor: a, w: { name: wh?.name ?? `${cls} warhead`, dmg: String(wc?.info?.Damage ?? "2d6").match(/\d+d\d+/)[0],
      type: wc?.info?.["Damage Type"] ?? "", facing: "bow", tier: SIZE_TIER[cls] ?? 1, ignoresArmor: false, ammo: null, delivery: "Warhead" } };
  }
  const blip = E[0]?.token._source;
  const inArc = (facing, s) => { const { dist, rb } = rel(ORIGIN, s); return dist < 4 && Math.abs(((rb - ARC[facing]) + 540) % 360 - 180) <= 45; };
  const launch = async () => {
    for (const l of launchers) {     // reload from the Torpedo Magazines
      const room = l.tubes * l.qty - l.loaded, take = Math.min(room, reloads[l.cls] ?? 0);
      if (take > 0) { l.loaded += take; reloads[l.cls] -= take;
        await say(`<p>${P.name}: ${l.name} reloads ${take} (${reloads[l.cls]} ${l.cls} reload${reloads[l.cls] === 1 ? "" : "s"} left).</p>`, P); }
    }
    for (const l of launchers) {
      if (!l.loaded || !torpProto[l.cls] || (P.sys[FACING_SYS[l.facing]] ?? 0) >= 2) continue;
      const tg = live().filter(e => inArc(l.facing, stateOf(e)));
      if (!tg.length) continue;
      const n = l.loaded; l.loaded = 0;
      const made = [];
      for (let k = 0; k < n; k++) {
        const target = tg[k % tg.length], h = ARC[l.facing], r = h * Math.PI / 180;
        const grid = scene.grid.size, w = blip?.width ?? 1, half = (w * grid) / 2;
        const off = 0.35 + 0.1 * k;
        const data = (await torpProto[l.cls].actor.getTokenDocument({
          x: Math.round(area.x + Math.sin(r) * off * BAND - half), y: Math.round(area.y - Math.cos(r) * off * BAND - half),
          width: w, height: blip?.height ?? w, rotation: h, disposition: 1,
          flags: { [MOD]: { radarSize: { width: 1, height: 1 }, duelTorpedo: true } } })).toObject();
        const [tok] = await scene.createEmbeddedDocuments("Token", [data], { neonOdysseyResize: true });
        const t = { token: tok, cls: l.cls, target, life: opt.torpedoLife, w: torpProto[l.cls].w, name: `${l.cls} Torpedo ${torpedoes.length + 1}`, pools: {} };
        torpedoes.push(t); made.push(`${t.name} → ${target.name}`);
      }
      await say(`<p><strong>${P.name}</strong> launches from ${l.name} (${l.facing}): ${made.join(", ")}.</p>`, P);
      await sleep(opt.delay);
    }
  };
  const torpedoTurn = async () => {
    for (const t of [...torpedoes]) {
      if (stopped() || !live().length) break;
      if (t.target.disabled) { const alt = live().sort((a, b) => rel(stateOf(t), stateOf(a)).dist - rel(stateOf(t), stateOf(b)).dist)[0];
        if (!alt) break; t.target = alt; }
      // Steer: the plan that ends closest to the target.
      let best = [], bd = 1e9;
      for (const p of plans(crew.shipSpeed(t.token.actor))) { let s = stateOf(t); for (const a of p) s = enemyStep(s, a);
        const d = rel(s, stateOf(t.target)).dist + p.length * 0.01; if (d < bd) { bd = d; best = p; } }
      await crew.steerShip(t.token, "reset");
      for (const a of best) await crew.steerShip(t.token, a === "F" ? "forward" : a === "L" ? "left" : "right");
      await sleep(opt.delay * 0.3);
      const d = rel(stateOf(t), stateOf(t.target)).dist;
      if (d < 1) {
        await say(`<p><strong>${t.name}</strong> reaches ${t.target.name} at Point Blank.</p>`, t);
        await attack(t, t.target, t.w, { dis: false, bd: "PB" });
        await t.token.delete(); torpedoes.splice(torpedoes.indexOf(t), 1);
      } else if (--t.life <= 0) {
        await say(`<p>${t.name} burns out (${t.target.name} ${band(d)}).</p>`, t);
        await t.token.delete(); torpedoes.splice(torpedoes.indexOf(t), 1);
      }
    }
  };
  // Optional setup: Enemies come in from a clock bearing, nose on the Player.
  if (opt.approach) {
    const rb = ((opt.approach.clock ?? 6) % 12) * 30, ranges = opt.approach.ranges ?? [3.5];
    const ups = E.map((e, k) => { const d = ranges[k % ranges.length], b = (rb + (k - (E.length - 1) / 2) * 8) * Math.PI / 180;
      const x = d * Math.sin(b), y = d * Math.cos(b), src = e.token._source, half = (src.width * scene.grid.size) / 2;
      return { _id: e.token.id, x: Math.round(area.x + x * BAND - half), y: Math.round(area.y - y * BAND - half),
        rotation: ((Math.atan2(-x, -y) * 180 / Math.PI) + 360) % 360 }; });
    await scene.updateEmbeddedDocuments("Token", ups, { animate: false, neonOdysseyResize: true });
    await sleep(500);
  }

  const stat = s => `AC ${s.ac}, HP ${s.hp}, MT ${s.mt}, Speed ${s.speed}; ammo ${Object.entries(s.pools).map(([z, p]) => `${z} ${p.left}/${p.capacity}`).join(", ") || "none"}; ${s.weapons.map(w => `${w.qty > 1 ? w.qty + "× " : ""}${w.name} (${w.dmg}, ${w.facing}, ${w.lo}–${w.hi}${w.ignoresArmor ? ", ignores armor" : ""})`).join(", ")}`;
  await say(`<h3>Radar battle</h3><p><strong>${P.name}</strong> (radar buttons): ${stat(P)}.</p>${E.map(e => `<p><strong>${e.name}</strong> (GM Helm): ${stat(e)}.</p>`).join("")}${launchers.length ? `<p>Torpedoes: ${launchers.map(l => `${l.qty > 1 ? l.qty + "× " : ""}${l.name} (${l.facing}, ${l.loaded} loaded)`).join(", ")}; reloads ${Object.entries(reloads).map(([z, n]) => `${z} ${n}`).join(", ") || "none"}.</p>` : ""}<p>Gunners +${opt.attack} to hit.</p>`);
  for (const s of [P, ...E]) { s.init = await new Roll(`1d20 + ${s.dex}`).evaluate(); await s.init.toMessage({ flavor: `${s.name}: initiative`, speaker: { alias: s.name } }); }
  const order = [P, ...E].sort((a, b) => b.init.total - a.init.total);
  await sleep(opt.delay);

  let outcome = null;
  for (let round = 1; round <= opt.rounds && !stopped(); round++) {
    await crew.syncSpeed(scene, { force: true });
    for (const e of E) await crew.steerShip(e.token, "reset");
    await say(`<h3>Round ${round}</h3>`);
    for (const me of order) {
      if (stopped() || P.disabled || !live().length) break;
      if (me.disabled) continue;
      await rackReload(me);
      if (me === P) {
        const plan = choosePlayer(crew.readStat(scene, "speed") ?? P.speed);
        await say(`<p><strong>${P.name}</strong>: ${plan.length ? plan.map(a => WORD[a]).join(" → ") : "holds course"}</p>`, P);
        for (const a of plan) { if (a === "F") await crew.steerForward(scene); else await crew.steerTurn(a === "L" ? "ccw" : "cw", scene); await sleep(opt.delay * 0.5); }
        await launch();
        const fired = await fireAll(P, live().map(e => ({ ship: e })), (s, t, target) => target ? stateOf(t.ship) : ORIGIN);
        if (!fired) await say(`<p>${P.name}: no shot. ${live().map(e => { const { dist, rb } = rel(ORIGIN, stateOf(e)); return `${e.name} at ${clock(rb)} o'clock, ${band(dist)}`; }).join("; ")}.</p>`, P);
        await torpedoTurn();
      } else {
        const plan = chooseEnemy(me, me.speed);
        await say(`<p><strong>${me.name}</strong>: ${plan.length ? plan.map(a => WORD[a]).join(" → ") : "holds course"}</p>`, me);
        for (const a of plan) { await crew.steerShip(me.token, a === "F" ? "forward" : a === "L" ? "left" : "right"); await sleep(opt.delay * 0.5); }
        const fired = await fireAll(me, [{ ship: P }], (s, t, target) => target ? ORIGIN : stateOf(me));
        if (!fired) { const { dist, rb } = rel(stateOf(me), ORIGIN); await say(`<p>${me.name}: no shot (Player at ${clock(rb)} o'clock, ${band(dist)}).</p>`, me); }
      }
      await sleep(opt.delay * 0.5);
    }
    if (P.disabled) { outcome = `Enemies win in round ${round}`; break; }
    if (!live().length) { outcome = `${P.name} wins in round ${round}`; break; }
  }
  const line = s => `${s.name}: Strain ${s.strain}/${s.hp}, ${mishapCount(s)} Mishaps${s.disabled ? " (disabled)" : ""}${s.weapons.some(w => w.rack) ? `, rack volleys ${s.weapons.filter(w => w.rack).map(w => `${w.facing} ${w.rack.loaded}`).join("/")} + ${Object.values(s.rackReloads).reduce((a, b) => a + b, 0)} in magazines` : ""}${Object.keys(s.pools).length ? `, ammo ${Object.entries(s.pools).map(([z, p]) => `${z} ${p.left}/${p.capacity}`).join(", ")}` : ""}`;
  await say(`<h3>${outcome ?? (stopped() ? "Battle stopped" : `No result after ${opt.rounds} rounds`)}</h3><p>${[P, ...E].map(line).join("<br>")}</p>`);
  for (const t of torpedoes) await t.token.delete().catch(() => null);
  window.neonDuel.done = true;
  window.neonDuel.result = { outcome, ships: [P, ...E].map(s => ({ name: s.name, strain: s.strain, hp: s.hp, mishaps: mishapCount(s), disabled: s.disabled })),
    torpedoes: { reloadsLeft: reloads, loaded: launchers.map(l => `${l.name}: ${l.loaded}`) } };
})();
