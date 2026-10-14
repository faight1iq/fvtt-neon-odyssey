// Fleet battle simulator (John, 2026-10-13). One rules engine, two ways to run it:
//   silent  - positions, facings and status live in variables only; fast; batch runs give win rates.
//   foundry - the same fight played out with temporary tokens on the current scene and a
//             play-by-play in chat, so it can be watched. Tokens are removed afterwards.
//
//   const src = await fetch("modules/fvtt-neon-odyssey/tools/fleet-sim.js").then(r => r.text());
//   await (0, eval)(src);                                   // defines window.neonSim
//   await neonSim.batch("fighter-mirror", 20);              // silent, 20 runs, summary in chat
//   await neonSim.run("frigate-vs-fighters", { mode: "foundry" });
//   neonSim.scenarios                                         // the preset fights
//   neonSim.stop()                                            // ends a foundry run early
//
// A scenario: { name, sides: { A: [ship...], B: [ship...] } } where a ship is
//   { actor: "M-38 Frigate", x, y, h, goal: "fight" | "flee", label?,
//     remove: ["Ion Spear (Small)", ...], add: [{ name, facing?, qty? }, ...] }
// x/y are range bands (1 band = one range step), y up; h is heading in degrees (0 = up, clockwise).
// remove/add change the ship for the simulation only; the actor isn't touched.
//
// Rules, from the rule-changes doc: weapons fire in their facing (90°) and range band; PB is at
// disadvantage unless the weapon's range starts at PB; magazines (rule 20, one per weapon when there
// are enough); Strain and Mishaps (rule 16); torpedoes (rule 22/24, dodged with a DEX save, rule 31) for both sides; Missile Racks
// (rule 26: area volley, DEX save for half, recharge 5-6 after every volley); Point Defense (rule 27).
// Movement: each move is Forward (1 band; the nth forward costs 2^(n-1) Speed) or a 30° turn (the
// nth turn costs n). Speed refills each round.
(() => {
const MOD = "fvtt-neon-odyssey";
const RANGES = ["PB", "Short", "Medium", "Long", "Extreme"];
const ARC = { bow: 0, starboard: 90, aft: 180, port: 270 };
const FACING_SYS = { bow: "Bow", port: "Port", starboard: "Starboard", aft: "Aft" };
const SYSTEMS = ["Command & Control", "Navigation", "Power", "Propulsion", "Bow", "Port", "Starboard", "Aft", "Habitat"];
const CRIT = new Set(["Command & Control", "Power", "Propulsion"]);
const SIZE_TIER = { Tiny: 1, Small: 1, Medium: 2, Large: 3, Huge: 4, Gargantuan: 5 };
const TORP_ACTOR = { Small: "M-00 Small Torpedo", Medium: "M-03 Medium Torpedo", Large: "M-07 Large Torpedo" };
// Torpedo dodge (John, 2026-10-13): reaching PB, the target makes a DEX save against the torpedo's DC
// (smaller torpedoes are harder to shake). A miss leaves the torpedo chasing; it is spent after 3
// misses or 3 of its turns. Point Defense facing the torpedo gives advantage on the save, and a
// successful save with Point Defense destroys the torpedo.
const TORP_DC = { Small: 15, Medium: 14, Large: 13 };

const scenarios = {
  "fighter-mirror": { name: "Fighter vs Fighter", sides: {
    A: [{ actor: "M-18 Fighter", x: 0, y: -2.5, h: 0 }],
    B: [{ actor: "M-18 Fighter", x: 0, y: 2.5, h: 180 }] } },
  "heavy-vs-frigate": { name: "Heavy Destroyer vs Frigate", sides: {
    A: [{ actor: "M-37 Heavy Destroyer", x: 0, y: -3, h: 0 }],
    B: [{ actor: "M-38 Frigate", x: 0, y: 3, h: 180 }] } },
  "raider-vs-assault": { name: "Scout Destroyer vs Assault Destroyer", sides: {
    A: [{ actor: "M-30 Scout Destroyer", x: 0, y: -3, h: 0 }],
    B: [{ actor: "M-34 Assault Destroyer", x: 0, y: 3, h: 180 }] } },
  "bombers-vs-frigate": { name: "2 Fighter/Bombers vs Frigate", sides: {
    A: [{ actor: "M-21 Fighter/Bomber", x: -0.6, y: -3.5, h: 0 }, { actor: "M-21 Fighter/Bomber", x: 0.6, y: -3.5, h: 0 }],
    B: [{ actor: "M-38 Frigate", x: 0, y: 1, h: 180 }] } },
  "scout-escape": { name: "Assault Scout escapes a Fighter", sides: {
    A: [{ actor: "M-24 Assault Scout", x: 0, y: 0, h: 0, goal: "flee" }],
    B: [{ actor: "M-18 Fighter", x: 0, y: -2.5, h: 0 }] } },
  // The Frigate against 3 fighters coming in from its 5 o'clock, in three loadouts.
  "frigate-vs-fighters": { name: "Frigate vs 3 Fighters (current loadout)", sides: {
    A: [{ actor: "M-38 Frigate", x: 0, y: 0, h: 0 }],
    B: fightersAt(5, [3.3, 3.7, 4.1]) } },
  "frigate-racks-vs-fighters": { name: "Frigate with Missile Racks vs 3 Fighters", sides: {
    A: [{ actor: "M-38 Frigate", x: 0, y: 0, h: 0, label: "Frigate (racks)",
      remove: ["Ion Spear (Small)"],
      add: [{ name: "Missile Rack (Small)", facing: "port" }, { name: "Missile Rack (Small)", facing: "starboard" },
            { name: "Missile Rack Magazine (Small)", qty: 2 }] }],
    B: fightersAt(5, [3.3, 3.7, 4.1]) } },
  "frigate-racks-pd-vs-fighters": { name: "Frigate with Missile Racks and aft Point Defense vs 3 Fighters", sides: {
    A: [{ actor: "M-38 Frigate", x: 0, y: 0, h: 0, label: "Frigate (racks + PD)",
      remove: ["Ion Spear (Small)", "Boomer Missile (Small)"],
      add: [{ name: "Missile Rack (Small)", facing: "port" }, { name: "Missile Rack (Small)", facing: "starboard" },
            { name: "Missile Rack Magazine (Small)", qty: 2 }, { name: "Point Defense Cannon (Small)", facing: "aft" }] }],
    B: fightersAt(5, [3.3, 3.7, 4.1]) } },
  "strike-vs-escort": { name: "3 Fighters + Fighter/Bomber (A) vs 2 Fighters + Frigate (B)", sides: {
    A: [{ actor: "M-21 Fighter/Bomber", x: 0, y: -4, h: 0 }, { actor: "M-18 Fighter", x: -1.2, y: -3.6, h: 0 },
        { actor: "M-18 Fighter", x: 1.2, y: -3.6, h: 0 }, { actor: "M-18 Fighter", x: 0, y: -3.2, h: 0 }],
    B: [{ actor: "M-38 Frigate", x: 0, y: 2, h: 180 }, { actor: "M-18 Fighter", x: -1, y: 1.4, h: 180 }, { actor: "M-18 Fighter", x: 1, y: 1.4, h: 180 }] } },
  "combined-arms": { name: "Assault Destroyer + 2 Fighters vs Frigate", sides: {
    A: [{ actor: "M-34 Assault Destroyer", x: 0, y: -4, h: 0 },
        { actor: "M-18 Fighter", x: -1.2, y: -3.6, h: 0 }, { actor: "M-18 Fighter", x: 1.2, y: -3.6, h: 0 }],
    B: [{ actor: "M-38 Frigate", x: 0, y: 1, h: 180 }] } }
};
function fightersAt(clock, ranges) {
  const rb = (clock % 12) * 30;
  return ranges.map((d, k) => { const b = (rb + (k - (ranges.length - 1) / 2) * 8) * Math.PI / 180;
    const x = d * Math.sin(b), y = d * Math.cos(b);
    return { actor: "M-18 Fighter", x, y, h: ((Math.atan2(-x, -y) * 180 / Math.PI) + 360) % 360 }; });
}

// ---------------------------------------------------------------- dice
const rollDice = f => { let t = 0; const s = String(f).replace(/\s/g, "");
  for (const m of s.matchAll(/([+-]?)(\d*)d(\d+)|([+-]?)(\d+)/g)) {
    if (m[3]) { const n = Number(m[2] || 1), d = Number(m[3]), sg = m[1] === "-" ? -1 : 1; for (let i = 0; i < n; i++) t += sg * (1 + Math.floor(Math.random() * d)); }
    else if (m[5]) t += (m[4] === "-" ? -1 : 1) * Number(m[5]); }
  return t; };
const d20 = adv => { const a = 1 + Math.floor(Math.random() * 20), b = 1 + Math.floor(Math.random() * 20);
  return adv > 0 ? Math.max(a, b) : adv < 0 ? Math.min(a, b) : a; };
const rollAvg = f => { const m = String(f).match(/(\d*)d(\d+)/); return m ? Number(m[1] || 1) * (Number(m[2]) + 1) / 2 : 0; };
const dexMod = score => Math.floor((Number(score) - 10) / 2);

// ---------------------------------------------------------------- ships from actors
async function libs() {
  const DS = await import(`/modules/${MOD}/scripts/starship-designer.mjs`);
  const CALC = await import(`/modules/${MOD}/scripts/starship-calc.mjs`);
  const pack = game.packs.get(`${MOD}.starship-components`);
  const idx = await pack.getIndex({ fields: [`flags.${MOD}.component`] });
  return { DS, CALC, idx };
}
function component(L, name) {
  const ok = e => e.name === name && e.flags?.[MOD]?.component?.v === 2;
  const e = L.idx.find(e => ok(e) && (e.flags[MOD].component.magazine || e.flags[MOD].component.torpedoMagazine || e.flags[MOD].component.rackMagazine)) ?? L.idx.find(ok);
  if (!e) throw new Error(`No component "${name}" in the Starship Components compendium.`);
  return e.flags[MOD].component;
}
let uid = 0;
async function buildShip(L, spec, side) {
  // A ship can be a token already on the scene: { token: "<id>" } (its own items and position).
  const tokenDoc = spec.token ? canvas.scene.tokens.get(spec.token) : null;
  if (spec.token && !tokenDoc) throw new Error(`No token "${spec.token}" on this scene.`);
  const actor = tokenDoc?.actor ?? game.actors.getName(spec.actor);
  if (!actor) throw new Error(`No actor "${spec.actor}".`);
  if (tokenDoc) { const F = sceneFrame(); spec = { ...spec,
    x: (tokenDoc.x + tokenDoc.width * F.grid / 2 - F.cx) / F.BAND, y: (F.cy - (tokenDoc.y + tokenDoc.height * F.grid / 2)) / F.BAND, h: tokenDoc.rotation ?? 0 }; }
  let { parts, dims } = await L.DS.designParts(actor);
  parts = parts.map(p => ({ ...p, id: p.id ?? `p${++uid}` }));
  for (const n of spec.remove ?? []) parts = parts.filter(p => p.name !== n);
  for (const a of spec.add ?? []) parts.push({ c: component(L, a.name), name: a.name, qty: a.qty ?? 1, facing: a.facing ?? null, id: `p${++uid}` });
  const s = L.CALC.computeShip(parts, { tons: dims.tons });
  const weapons = [], launchers = [];
  for (const p of parts) {
    const c = p.c; if (c.slot !== "weapon") continue;
    const qty = Math.max(1, Number(p.qty) || 1), facing = p.facing ?? "bow";
    if (c.launcher) { launchers.push({ name: p.name, cls: c.launcher.class, tubes: (Number(c.launcher.tubes) || 1) * qty, loaded: (Number(c.launcher.tubes) || 1) * qty, facing }); continue; }
    const dmg = String(c.info?.Damage ?? "").match(/\d+d\d+/)?.[0]; if (!dmg) continue;
    const [lo, hi] = String(c.info?.Range ?? "").replace("Point Blank", "PB").split(/[–-]/).map(x => x.trim());
    weapons.push({ name: p.name, dmg, type: c.info?.["Damage Type"] ?? "", facing, qty, lo: lo || "Short", hi: hi || lo || "Long",
      tier: SIZE_TIER[c.info?.Size] ?? 1, delivery: c.info?.Delivery ?? "", ignoresArmor: /ignores armor/i.test(c.info?.Description ?? ""),
      pd: !!c.pointDefense, crewed: Number(c.stats?.crew) > 0, ammo: c.ammo ? { size: c.ammo.size, cost: c.ammo.cost } : null,
      rack: c.rack ? { ...c.rack, ready: true, loaded: (Number(c.rack.volleys) || 2) * qty } : null });
  }
  // Magazines: one per ammo weapon when there are enough, otherwise shared by size.
  const pools = {};
  for (const [z, cap] of Object.entries(s.ammo?.capacity ?? {})) pools[z] = { capacity: cap, left: cap };
  const bySize = {}; for (const w of weapons) if (w.ammo) (bySize[w.ammo.size] ??= []).push(w);
  for (const [z, ws] of Object.entries(bySize)) {
    const p = pools[z]; const n = ws.reduce((t, w) => t + w.qty, 0);
    if (!p || p.capacity / 12 < n) continue;
    const each = Math.floor(p.capacity / n / 12) * 12;
    for (const w of ws) { const key = `${z}:${w.name}:${w.facing}`; pools[key] = { capacity: each * w.qty, left: each * w.qty }; w.ammo = { ...w.ammo, size: key }; }
    delete pools[z];
  }
  return { id: `s${++uid}`, side, actor, tokenDoc, tokW: tokenDoc?.width, label: spec.label ?? tokenDoc?.name ?? actor.name, goal: spec.goal ?? "fight",
    x: spec.x, y: spec.y, h: spec.h ?? 0, speed: s.speed, ac: s.ac, hp: s.hp, mt: s.mt, dex: dexMod(s.abilities?.dex ?? 10),
    pb: Math.ceil(Math.max(1, Math.floor(Number(actor.flags?.["fvtt-neon-odyssey"]?.level) || 1)) / 4) + 1, // ship Level: saves and damage
    armor: parts.some(p => p.c.slot === "armor"), weapons, launchers, pools, reactUsed: new Set(),
    pilot: parts.some(p => p.c.stationRoles?.includes("pilot")),
    torpReloads: Object.fromEntries(Object.entries(s.ammo?.torpedoes ?? {}).map(([z, t]) => [z, t.reloads ?? 0])),
    rackReloads: Object.fromEntries(Object.entries(s.ammo?.racks ?? {}).map(([z, t]) => [z, t.reloads ?? 0])),
    strain: 0, armorM: 0, sys: {}, disabled: null, escaped: false, stats: { shots: 0, hits: 0, dmg: 0, torps: 0, torpHits: 0, volleys: 0 } };
}
async function torpedoTypes(L) {
  const out = {};
  for (const [cls, n] of Object.entries(TORP_ACTOR)) {
    const a = game.actors.getName(n); if (!a) continue;
    const { parts, dims } = await L.DS.designParts(a);
    const s = L.CALC.computeShip(parts, { tons: dims.tons });
    const wh = parts.find(p => p.c.info?.Delivery === "Warhead");
    out[cls] = { actor: a, speed: s.speed, ac: s.ac, hp: s.hp, w: { name: wh?.name ?? `${cls} warhead`, dmg: String(wh?.c.info?.Damage ?? "2d6").match(/\d+d\d+/)[0],
      type: wh?.c.info?.["Damage Type"] ?? "", facing: "bow", tier: SIZE_TIER[cls] ?? 1, delivery: "Warhead", ignoresArmor: false } };
  }
  return out;
}

// ---------------------------------------------------------------- the engine
async function fight(scenarioKey, opts = {}) {
  const sc = typeof scenarioKey === "string" ? scenarios[scenarioKey] : scenarioKey;
  if (!sc) throw new Error(`Unknown scenario "${scenarioKey}". See neonSim.scenarios.`);
  const opt = { mode: "silent", rounds: 20, attack: 6, cover: 2, torpedoLife: 3, torpedoMisses: 3, shootTorpedoes: true, reactions: true, threat: true, broadside: false, delay: 900, escape: 6, ...opts };
  const L = await libs();
  const ships = [];
  for (const side of ["A", "B"]) for (let spec of sc.sides[side]) {
    // Relative placement: { at: { ship: <index of a ship already listed>, clock, range, spread } } puts
    // this ship at that clock bearing and range from the other ship, nose on it.
    if (spec.at) { const ref = ships[spec.at.ship ?? 0]; const b = ((ref.h + (spec.at.clock % 12) * 30 + (spec.at.spread ?? 0)) * Math.PI) / 180;
      const x = ref.x + spec.at.range * Math.sin(b), y = ref.y + spec.at.range * Math.cos(b);
      spec = { ...spec, x, y, h: ((Math.atan2(ref.x - x, ref.y - y) * 180 / Math.PI) + 360) % 360 }; }
    ships.push(await buildShip(L, spec, side));
  }
  // Number duplicate names: "M-18 Fighter 1", "M-18 Fighter 2".
  const counts = {}; for (const s of ships) counts[s.label] = (counts[s.label] ?? 0) + 1;
  const seen = {}; for (const s of ships) if (counts[s.label] > 1) s.label = `${s.label} ${seen[s.label] = (seen[s.label] ?? 0) + 1}`;
  for (const s of ships) s.name = `${s.side}: ${s.label}`;
  const torpTypes = await torpedoTypes(L);
  const torps = [];
  const V = opt.mode === "foundry" ? await foundryView(ships, opt) : silentView();
  const log = [];
  const say = async (html, who) => { if (opt.log) log.push(html.replace(/<[^>]+>/g, "")); await V.say(html, who); };

  // geometry
  const rel = (from, to) => { const dx = to.x - from.x, dy = to.y - from.y;
    return { dist: Math.hypot(dx, dy), rb: (((Math.atan2(dx, dy) * 180 / Math.PI) - from.h) % 360 + 360) % 360 }; };
  const inArc = (rb, facing) => Math.abs(((rb - ARC[facing]) + 540) % 360 - 180) <= 45;
  const band = d => d < 1 ? "PB" : d < 2 ? "Short" : d < 3 ? "Medium" : d < 4 ? "Long" : d < 5 ? "Extreme" : "Out";
  const clock = rb => (Math.round(rb / 30) % 12) || 12;
  const step = (s, a) => { if (a === "F") { const r = s.h * Math.PI / 180; return { ...s, x: s.x + Math.sin(r), y: s.y + Math.cos(r) }; }
    return { ...s, h: (s.h + (a === "L" ? -30 : 30) + 360) % 360 }; };
  const planList = {}; const plans = speed => planList[speed] ??= (() => { const out = [[]];
    const rec = (seq, f, t, sp) => { if (seq.length >= 6) return; for (const a of ["F", "L", "R"]) {
      const c = a === "F" ? 2 ** f : t + 1; if (sp + c > speed) continue; const s2 = [...seq, a]; out.push(s2);
      rec(s2, f + (a === "F"), t + (a !== "F"), sp + c); } }; rec([], 0, 0, 0); return out; })();
  const active = s => !s.disabled && !s.escaped;
  const foes = s => ships.filter(o => o.side !== s.side && active(o));
  const friends = s => ships.filter(o => o.side === s.side && active(o) && o !== s);

  const weaponShot = (ship, w, from, to) => {
    if ((ship.sys[FACING_SYS[w.facing]] ?? 0) >= 2) return null;
    if (w.ammo && ((ship.pools[w.ammo.size]?.left ?? 0) < w.ammo.cost)) return null;
    if (w.rack && (w.rack.loaded < 1 || !w.rack.ready)) return null;
    const { dist, rb } = rel(from, to); if (!inArc(rb, w.facing)) return null;
    const bd = band(dist), i = RANGES.indexOf(bd); if (i < 0) return null;
    if (bd === "PB" && w.lo !== "PB") return { dis: true, bd };
    if (i < RANGES.indexOf(w.lo) || i > RANGES.indexOf(w.hi)) return null;
    return { dis: false, bd };
  };
  const pdCovers = (def, att) => { const { rb } = rel(def, att);
    return def.weapons?.some(w => w.pd && (def.sys[FACING_SYS[w.facing]] ?? 0) < 2 && inArc(rb, w.facing)); };

  // Threat (John, 2026-10-13): a ship carrying loaded torpedoes (or with torpedoes in flight) is the
  // priority. Fighters close on it and fire on it first.
  const threat = e => 1 + (e.launchers.some(l => l.loaded > 0) || Object.values(e.torpReloads).some(n => n > 0) ? 2 : 0)
    + (torps.some(t => !t.dead && t.launcher === e) ? 1 : 0);
  // AI: score every plan by the shots it opens up, the shots it gives the enemy, and a preferred range.
  const choose = me => {
    const enemies = foes(me); let best = [], bs = -1e9;
    for (const p of plans(me.speed)) {
      let st = { x: me.x, y: me.y, h: me.h }; for (const a of p) st = step(st, a);
      let score = 0;
      if (me.goal === "flee") {
        const near = Math.min(...enemies.map(e => Math.hypot(e.x - st.x, e.y - st.y)));
        score = near * 20 - enemies.filter(e => e.weapons.some(w => weaponShot(e, w, e, st))).length * 30;
      } else {
        for (const e of enemies) {
          const tw = opt.threat ? threat(e) : 1;
          score += me.weapons.filter(w => weaponShot(me, w, st, e)).length * 100 * tw / (1 + e.strain / e.hp);
          score += me.launchers.filter(l => l.loaded && inArc(rel(st, e).rb, l.facing) && rel(st, e).dist < 4).length * 80;
          if (e.weapons.some(w => weaponShot(e, w, e, st))) score -= 40;
          score -= Math.abs(Math.hypot(e.x - st.x, e.y - st.y) - 2.5) * 4 * tw;
        }
        // Capital ships keep bow and side weapons on at least `cover` enemies (John, 2026-10-13).
        if (me.speed <= 6 && opt.cover) {
          if (opt.broadside) {
            // Broadside-aware (2026-10-13): each enemy counts by the firepower of the facing it sits in
            // (average damage of that facing's weapons; a Missile Rack counts double for its area).
            const fp = f => me.weapons.filter(w => w.facing === f && (me.sys[FACING_SYS[f]] ?? 0) < 2)
              .reduce((a, w) => a + rollAvg(w.dmg) * w.qty * (w.rack ? 2 : 1), 0)
              + me.launchers.filter(l => l.facing === f && l.loaded).length * 14;
            const fw = Object.fromEntries(Object.keys(ARC).map(f => [f, fp(f)])), top = Math.max(1, ...Object.values(fw));
            const vals = enemies.map(e => { const r = rel(st, e); if (r.dist >= 5) return 0;
              return Math.max(0, ...Object.keys(ARC).filter(f => inArc(r.rb, f)).map(f => fw[f] / top)); }).sort((a, b) => b - a);
            score += vals.slice(0, opt.cover).reduce((a, v) => a + v * 150, 0) + vals.reduce((a, v) => a + v * 20, 0);
          } else {
            const covered = enemies.filter(e => { const r = rel(st, e); return r.dist < 5 && ["bow", "port", "starboard"].some(f => inArc(r.rb, f)); }).length;
            score += Math.min(covered, opt.cover) * 150 + covered * 20;
          }
        }
      }
      // Torpedoes chasing this ship: put distance between them.
      for (const t of torps) if (!t.dead && t.target === me) score += Math.min(Math.hypot(t.x - st.x, t.y - st.y), 4) * 60;
      score += Math.random() - p.length * 0.3;
      if (score > bs) { bs = score; best = p; }
    }
    return best;
  };

  const hurt = async (att, def, w, amount, note = "") => {
    const before = def.strain; def.strain += amount; att.stats && (att.stats.dmg += amount);
    let msg = `<p><strong>${def.name}</strong>: ${note}Strain ${before} → <strong>${def.strain}</strong> of ${def.hp} HP (MT ${def.mt}).</p>`;
    if (amount > 0 && def.strain > def.mt) {
      let where;
      if (def.armor && def.armorM < 2 && !w.ignoresArmor) { def.armorM++; where = `Armor (${def.armorM} of 2)`; }
      else { const sys = SYSTEMS[Math.floor(Math.random() * SYSTEMS.length)]; def.sys[sys] = (def.sys[sys] ?? 0) + 1; where = `${sys} (${def.sys[sys]})`;
        if (def.sys[sys] >= 2) { if (CRIT.has(sys)) def.disabled ??= `${sys} has 2 Mishaps`; else msg += `<p>${sys} is <strong>disabled</strong>.</p>`; } }
      msg += `<p><strong>MISHAP</strong> on ${where}${await V.mishap(def, w.tier)}.</p>`;
    }
    if (def.strain > def.hp) def.disabled ??= `Strain ${def.strain} exceeds ${def.hp} HP`;
    if (def.disabled) msg += `<p><strong>${def.name} DISABLED</strong>: ${def.disabled}.</p>`;
    await say(msg, def);
  };
  const attack = async (att, def, w, sh) => {
    let note = "";
    if (w.ammo) { const p = att.pools[w.ammo.size]; p.left -= w.ammo.cost; note = `, ammo ${p.left}/${p.capacity}`; }
    const pd = ["Missile", "Warhead"].includes(w.delivery) && pdCovers(def, att);
    const r = d20((sh.dis || pd) ? -1 : 0), total = r + opt.attack, crit = r === 20;
    att.stats.shots++;
    const hit = crit || total >= def.ac;
    await say(`<p><strong>${att.name}</strong> fires ${w.name} (${w.facing}) at ${def.name} (${sh.bd}${sh.dis ? ", disadvantage" : ""}${pd ? ", Point Defense: disadvantage" : ""}${note}): ${total} vs AC ${def.ac} — <strong>${crit ? "CRITICAL" : hit ? "hit" : "miss"}</strong>.</p>`, att);
    await V.pause(0.6);
    if (!hit) return;
    att.stats.hits++;
    const dmg = rollDice(crit ? w.dmg.replace(/^(\d+)d/, (m, n) => `${2 * n}d`) : w.dmg) + att.pb;
    await hurt(att, def, w, dmg, `${dmg} ${w.type.toLowerCase()}. `);
  };
  const volley = async (att, w) => {
    const caught = ships.filter(s => s !== att && active(s)).filter(s => { const r = rel(att, s); return r.dist < 3 && inArc(r.rb, w.facing); });
    if (!caught.some(s => s.side !== att.side)) return false;
    w.rack.loaded--; w.rack.ready = false; att.stats.volleys++;
    const dmg = rollDice(w.dmg) + att.pb;
    await say(`<p><strong>${att.name}</strong> fires a ${w.name} volley (${w.facing}): ${dmg} damage, DC ${w.rack.dc} Dexterity save for half; ${w.rack.loaded} volley${w.rack.loaded === 1 ? "" : "s"} left in the rack.</p>`, att);
    for (const s of caught) {
      const friendly = s.side === att.side, pd = pdCovers(s, att);
      const sv = d20((friendly || pd) ? 1 : 0) + s.dex + s.pb, ok = sv >= w.rack.dc;
      await hurt(att, s, w, ok ? Math.floor(dmg / 2) : dmg, `save ${sv}${friendly ? " (friendly, advantage)" : pd ? " (Point Defense, advantage)" : ""} — ${ok ? "half" : "full"} damage. `);
    }
    await V.pause(0.6);
    return true;
  };
  const rackRecharge = async ship => {
    for (const w of ship.weapons) {
      if (!w.rack || w.rack.ready) continue;
      const need = Number(w.rack.volleys) || 2;
      if (w.rack.loaded < 1 && (ship.rackReloads[w.rack.size] ?? 0) < need) continue;
      const r = 1 + Math.floor(Math.random() * 6);
      if (r >= (w.rack.recharge ?? 5)) { w.rack.ready = true;
        if (w.rack.loaded < 1) { w.rack.loaded = need; ship.rackReloads[w.rack.size] -= need; }
        await say(`<p>${ship.name}: ${w.name} (${w.facing}) recharged (${r}).</p>`, ship); }
    }
  };
  const shootTorpedo = async (att, t, w, sh, how = "") => {
    if (w.ammo) { const p = att.pools[w.ammo.size]; p.left -= w.ammo.cost; }
    const r = d20(sh.dis ? -1 : 0), total = r + opt.attack, hit = r === 20 || total >= t.ac;
    att.stats.shots++; att.stats.torpShots = (att.stats.torpShots ?? 0) + 1;
    let msg = `<p><strong>${att.name}</strong>${how ? ` (${how})` : ""} fires ${w.name} at ${t.name} (${sh.bd}): ${total} vs AC ${t.ac} — <strong>${hit ? "hit" : "miss"}</strong>`;
    if (hit) { const dmg = rollDice(w.dmg); t.strain += dmg; msg += `, ${dmg} damage`;
      if (t.strain >= t.hp) { t.dead = true; att.stats.torpKills = (att.stats.torpKills ?? 0) + 1; msg += `; <strong>torpedo destroyed</strong>`; await V.remove(t); } }
    await say(msg + ".</p>", att);
  };
  // "Shoot it Down" (Gunner/Pilot reaction, John 2026-10-13): when an enemy torpedo moves to Short range
  // or closer of a ship (its target or a friendly ship nearby), one gunner whose crewed weapon covers it (or the pilot, for the weapons the
  // pilot fires) attacks it. Once per gunner per round; no Tempo for now.
  const reactShoot = async (def, t) => {
    const opts3 = def.weapons.filter(w => w.delivery !== "Missile" && !w.rack).map(w => {
      const who = w.crewed ? `gunner:${w.facing}` : def.pilot ? "pilot" : null;
      if (!who || def.reactUsed.has(who)) return null;
      const sh = weaponShot(def, w, def, t); return sh ? { w, sh, who } : null; }).filter(Boolean);
    if (!opts3.length) return;
    const o = opts3.sort((a, b) => (a.sh.dis - b.sh.dis) || (rollAvg(b.w.dmg) - rollAvg(a.w.dmg)))[0];
    def.reactUsed.add(o.who); def.stats.reactions = (def.stats.reactions ?? 0) + 1;
    const before = def.stats.torpKills ?? 0;
    await shootTorpedo(def, t, o.w, o.sh, `${o.who.startsWith("pilot") ? "pilot" : "gunner"} reaction`);
    if ((def.stats.torpKills ?? 0) > before) def.stats.reactKills = (def.stats.reactKills ?? 0) + 1;
  };
  const fireAll = async att => {
    let fired = false;
    for (const w of att.weapons) for (let q = 0; q < w.qty; q++) {
      if (!active(att) || !foes(att).length) return fired;
      if (w.rack) { if (w.rack.ready && w.rack.loaded > 0 && await volley(att, w)) fired = true; continue; }
      // Shooting down torpedoes (2026-10-13): guns (not missiles) can fire at an enemy torpedo that is
      // chasing this ship or an ally; one hit that does at least its HP destroys it.
      if (opt.shootTorpedoes && w.delivery !== "Missile") {
        const threat = torps.filter(t => !t.dead && t.side !== att.side && t.target.side === att.side)
          .map(t => ({ t, sh: weaponShot(att, w, att, t) })).filter(o => o.sh)
          .sort((a, b) => (a.t.target === att ? -1 : 0) - (b.t.target === att ? -1 : 0))[0];
        if (threat) { fired = true; await shootTorpedo(att, threat.t, w, threat.sh); continue; }
      }
      const opts2 = foes(att).map(e => ({ e, sh: weaponShot(att, w, att, e) })).filter(o => o.sh);
      if (!opts2.length) continue;
      const t = opts2.sort((a, b) => (opt.threat ? threat(b.e) - threat(a.e) : 0) || ((b.e.strain / b.e.hp) - (a.e.strain / a.e.hp)))[0];
      fired = true; await attack(att, t.e, w, t.sh);
    }
    return fired;
  };
  const launch = async att => {
    for (const l of att.launchers) {
      const room = l.tubes - l.loaded, take = Math.min(room, att.torpReloads[l.cls] ?? 0);
      if (take > 0) { l.loaded += take; att.torpReloads[l.cls] -= take; }
      const T = torpTypes[l.cls];
      if (!l.loaded || !T || (att.sys[FACING_SYS[l.facing]] ?? 0) >= 2) continue;
      const tg = foes(att).filter(e => { const r = rel(att, e); return r.dist < 4 && inArc(r.rb, l.facing); });
      if (!tg.length) continue;
      const n = l.loaded; l.loaded = 0; const made = [];
      for (let k = 0; k < n; k++) {
        const target = tg[k % tg.length], h = (att.h + ARC[l.facing]) % 360, r = h * Math.PI / 180, off = 0.35 + 0.1 * k;
        const t = { id: `t${++uid}`, side: att.side, torpedo: true, cls: l.cls, actor: T.actor, speed: T.speed, w: T.w, target, life: opt.torpedoLife, misses: 0, ac: T.ac, hp: T.hp, strain: 0, dc: TORP_DC[l.cls] ?? 14,
          x: att.x + Math.sin(r) * off, y: att.y + Math.cos(r) * off, h, label: `${l.cls} Torpedo`, stats: { shots: 0, hits: 0, dmg: 0 }, launcher: att };
        t.name = `${att.side}: ${l.cls} Torpedo ${torps.length + 1}`;
        torps.push(t); att.stats.torps++; made.push(`${t.name} → ${target.name}`);
        await V.spawn(t);
      }
      await say(`<p><strong>${att.name}</strong> launches from ${l.name} (${l.facing}): ${made.join(", ")}.</p>`, att);
    }
  };
  const torpedoTurn = async side => {
    for (const t of torps.filter(t => t.side === side && !t.dead)) {
      if (!active(t.target)) { const alt = foes(t).sort((a, b) => rel(t, a).dist - rel(t, b).dist)[0]; if (!alt) { t.dead = true; continue; } t.target = alt; }
      let best = [], bd = 1e9;
      for (const p of plans(t.speed)) { let s = { x: t.x, y: t.y, h: t.h }; for (const a of p) s = step(s, a);
        const d = Math.hypot(t.target.x - s.x, t.target.y - s.y) + p.length * 0.01; if (d < bd) { bd = d; best = p; } }
      // Shoot it Down (John, 2026-10-13): any ship on the target's side may react once this move when the
      // torpedo comes within Short range of it, whatever the torpedo's target. The target goes first.
      const reacted = new Set();
      for (const a of best) { Object.assign(t, step(t, a)); await V.move(t);
        if (!opt.reactions) continue;
        const near = ships.filter(f => f.side === t.target.side && active(f) && !reacted.has(f) && rel(f, t).dist < 2)
          .sort((x, y) => (y === t.target) - (x === t.target));
        for (const f of near) { reacted.add(f); await reactShoot(f, t); if (t.dead) break; }
        if (t.dead) break; }
      if (t.dead) continue;
      const d = rel(t, t.target).dist;
      if (d < 1) {
        const pd = pdCovers(t.target, t);
        const sv = d20(pd ? 1 : 0) + t.target.dex + t.target.pb, dodged = sv >= t.dc;
        await say(`<p><strong>${t.name}</strong> reaches ${t.target.name}: Dexterity save ${sv} vs DC ${t.dc}${pd ? " (Point Defense, advantage)" : ""} — <strong>${dodged ? "dodged" : "hit"}</strong>.</p>`, t);
        if (!dodged) { t.launcher.stats.torpHits++; const dmg = rollDice(t.w.dmg) + t.launcher.pb; await hurt(t.launcher, t.target, t.w, dmg, `${dmg} ${t.w.type.toLowerCase()}. `); t.dead = true; }
        else if (pd) { t.dead = true; t.target.stats.pdKills = (t.target.stats.pdKills ?? 0) + 1; await say(`<p>${t.target.name}'s Point Defense destroys ${t.name}.</p>`, t); }
        else if (++t.misses >= opt.torpedoMisses) { t.dead = true; await say(`<p>${t.name} is spent (${t.misses} misses).</p>`, t); }
      }
      if (!t.dead && --t.life <= 0) { t.dead = true; await say(`<p>${t.name} burns out (${t.target.name} avoided it for ${opt.torpedoLife} turns).</p>`, t); }
      if (t.dead) await V.remove(t);
    }
    for (let i = torps.length - 1; i >= 0; i--) if (torps[i].dead) torps.splice(i, 1);
  };

  await say(`<h3>${sc.name}</h3>${ships.map(s => `<p><strong>${s.name}</strong>: Speed ${s.speed}, AC ${s.ac}, HP ${s.hp}, MT ${s.mt}, DEX ${s.dex >= 0 ? "+" : ""}${s.dex}; ${s.weapons.map(w => `${w.qty > 1 ? w.qty + "× " : ""}${w.name} (${w.facing})`).concat(s.launchers.map(l => `${l.name} (${l.facing}, ${l.loaded})`)).join(", ")}${s.goal === "flee" ? "; trying to escape" : ""}.</p>`).join("")}`);
  for (const s of ships) s.init = d20(0) + s.dex;
  const order = [...ships].sort((a, b) => b.init - a.init);
  let outcome = null, round = 0;
  for (round = 1; round <= opt.rounds && !V.stopped(); round++) {
    for (const s of ships) s.reactUsed = new Set();
    await say(`<h3>Round ${round}</h3>`);
    for (const me of order) {
      if (V.stopped() || !active(me)) continue;
      if (!foes(me).length) break;
      await rackRecharge(me);
      const plan = choose(me);
      for (const a of plan) { Object.assign(me, step(me, a)); await V.move(me); }
      if (opt.mode === "foundry") await say(`<p><strong>${me.name}</strong>: ${plan.length ? plan.map(a => ({ F: "Forward", L: "Turn Left", R: "Turn Right" })[a]).join(" → ") : "holds course"}.</p>`, me);
      if (me.goal === "flee") {
        const near = Math.min(...foes(me).map(e => rel(me, e).dist));
        if (near >= opt.escape) { me.escaped = true; await say(`<p><strong>${me.name}</strong> escapes (${near.toFixed(1)} bands clear).</p>`, me); await V.remove(me); continue; }
      }
      await launch(me);
      const fired = await fireAll(me);
      if (!fired && opt.mode === "foundry") await say(`<p>${me.name}: no shot (${foes(me).map(e => { const r = rel(me, e); return `${e.label} at ${clock(r.rb)} o'clock, ${band(r.dist)}`; }).join("; ")}).</p>`, me);
      await torpedoTurn(me.side);
      await V.pause(0.4);
    }
    const sideUp = side => ships.some(s => s.side === side && active(s));
    const fled = ships.filter(s => s.escaped);
    if (fled.length && !ships.some(s => s.goal === "flee" && active(s))) { outcome = { winner: fled[0].side, how: "escaped", round }; break; }
    if (!sideUp("A") || !sideUp("B")) { outcome = { winner: sideUp("A") ? "A" : sideUp("B") ? "B" : null, how: "disabled", round }; break; }
  }
  round = Math.min(round, opt.rounds);
  outcome ??= { winner: null, how: V.stopped() ? "stopped" : "time", round };
  const result = { scenario: sc.name, outcome, ships: ships.map(s => ({ name: s.name, side: s.side, strain: s.strain, hp: s.hp,
    mishaps: s.armorM + Object.values(s.sys).reduce((a, b) => a + b, 0), disabled: !!s.disabled, escaped: s.escaped, ...s.stats })) };
  await say(`<h3>${outcome.winner ? `Side ${outcome.winner} wins` : "No result"} (${outcome.how}, round ${outcome.round})</h3><p>${result.ships.map(s => `${s.name}: Strain ${s.strain}/${s.hp}, ${s.mishaps} Mishaps${s.disabled ? " (disabled)" : s.escaped ? " (escaped)" : ""}; ${s.hits}/${s.shots} hits, ${s.dmg} damage${s.torps ? `, torpedoes ${s.torpHits}/${s.torps}` : ""}${s.volleys ? `, ${s.volleys} volleys` : ""}`).join("<br>")}</p>`);
  await V.end();
  if (opt.log) result.log = log;
  return result;
}

// ---------------------------------------------------------------- views
function silentView() {
  return { say: async () => {}, move: async () => {}, spawn: async () => {}, remove: async () => {}, pause: async () => {},
    mishap: async () => "", stopped: () => false, end: async () => {} };
}
// The scene frame: centered on the radar tile (1 band = one radar ring), else the scene's center.
function sceneFrame(opt = {}) {
  const scene = canvas.scene, grid = scene.grid.size;
  const tile = scene.tiles.find(t => t.getFlag(MOD, "radar"));
  const W = tile ? Math.abs(tile._source.width) : scene.dimensions.sceneWidth, H = tile ? Math.abs(tile._source.height) : scene.dimensions.sceneHeight;
  const cx = tile ? tile._source.x + W / 2 : scene.dimensions.sceneX + W / 2, cy = tile ? tile._source.y + H / 2 : scene.dimensions.sceneY + H / 2;
  const sc = tile ? (Number(tile.getFlag(MOD, "areaScale")) || 1) : 1;
  return { scene, grid, cx, cy, BAND: opt.band ?? (Math.min(W, H) / 2) * sc / 5 };
}
async function foundryView(ships, opt) {
  const { scene, grid, cx, cy, BAND } = sceneFrame(opt);
  const ML = await import(`/modules/${MOD}/scripts/mishap-links.mjs`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const toks = new Map();
  const place = e => { const w = e.tokW ?? 1, half = (w * grid) / 2;
    return { x: Math.round(cx + e.x * BAND - half), y: Math.round(cy - e.y * BAND - half), rotation: e.h }; };
  const spawn = async e => {
    // Same size as a token of that actor already on the scene (radar blips are often 0.5).
    e.tokW ??= scene.tokens.find(t => t.actorId === e.actor.id && !t.getFlag(MOD, "fleetSim"))?.width ?? 1;
    const data = (await e.actor.getTokenDocument({ ...place(e), width: e.tokW, height: e.tokW, name: e.name, disposition: e.side === "A" ? 1 : -1,
      flags: { [MOD]: { fleetSim: true } } })).toObject();
    const [t] = await scene.createEmbeddedDocuments("Token", [data], { neonOdysseyResize: true, [`${MOD}.sectorFit`]: true });
    toks.set(e.id, t);
  };
  // Ships that are tokens already on the scene are moved, then put back where they were.
  const orig = new Map();
  for (const s of ships) {
    if (s.tokenDoc) { toks.set(s.id, s.tokenDoc); orig.set(s.id, { x: s.tokenDoc.x, y: s.tokenDoc.y, rotation: s.tokenDoc.rotation }); }
    else await spawn(s);
  }
  window.neonSim.stopFlag = false;
  return {
    say: (html, who) => ChatMessage.implementation.create({ content: `<div class="no-crew-card">${html}</div>`, speaker: { alias: who?.name ?? "Fleet Sim" } }),
    move: async e => { const t = toks.get(e.id); if (t) await t.update(place(e), { animate: true }); await sleep(opt.delay * 0.35); },
    spawn, remove: async e => { const t = toks.get(e.id); toks.delete(e.id);
      if (t && orig.has(e.id)) await t.update({ ...orig.get(e.id) }, { animate: false }); else if (t) await t.delete().catch(() => null); },
    pause: f => sleep(opt.delay * (f ?? 1)),
    mishap: async (def, tier) => { const m = await ML.rollMishap(def.actor, tier).catch(() => null); return m ? `: @UUID[${m.uuid}]{${m.name}} (${ML.MISHAP_TIERS[tier - 1]})` : ""; },
    stopped: () => !!window.neonSim.stopFlag,
    end: async () => { await sleep(opt.keep ?? 4000);
      for (const [id, t] of toks) { if (orig.has(id)) { if (opt.restore !== false) await t.update({ ...orig.get(id) }, { animate: false }); } else await t.delete().catch(() => null); }
      toks.clear(); }
  };
}

// ---------------------------------------------------------------- batch runs
async function batch(key, n = 10, opts = {}) {
  const runs = [];
  for (let i = 0; i < n; i++) runs.push(await fight(key, { ...opts, mode: "silent" }));
  const sc = runs[0].scenario, wins = { A: 0, B: 0, none: 0 }, rounds = [];
  const per = {};
  for (const r of runs) {
    wins[r.outcome.winner ?? "none"]++; if (r.outcome.winner) rounds.push(r.outcome.round);
    for (const s of r.ships) { const p = (per[s.name] ??= { n: 0, strain: 0, hp: s.hp, disabled: 0, escaped: 0, shots: 0, hits: 0, dmg: 0, torps: 0, torpHits: 0, volleys: 0 });
      p.n++; p.strain += s.strain; p.disabled += s.disabled; p.escaped += s.escaped; for (const k of ["shots", "hits", "dmg", "torps", "torpHits", "volleys"]) p[k] += s[k]; }
  }
  const avg = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : "–";
  const summary = { scenario: sc, runs: n, wins, avgRounds: avg(rounds), ships: Object.entries(per).map(([name, p]) => ({ name,
    avgStrain: (p.strain / p.n).toFixed(1), hp: p.hp, disabledPct: Math.round(100 * p.disabled / p.n), escapedPct: Math.round(100 * p.escaped / p.n),
    hitPct: p.shots ? Math.round(100 * p.hits / p.shots) : 0, avgDamage: (p.dmg / p.n).toFixed(1),
    torpedoes: p.torps ? `${(p.torpHits / p.n).toFixed(1)}/${(p.torps / p.n).toFixed(1)}` : "", volleys: p.volleys ? (p.volleys / p.n).toFixed(1) : "" })) };
  if (opts.chat !== false) await ChatMessage.implementation.create({ speaker: { alias: "Fleet Sim" }, content: `<div class="no-crew-card"><h3>${sc}</h3>
    <p>${n} silent runs: Side A wins ${wins.A}, Side B wins ${wins.B}, no result ${wins.none}; average ${summary.avgRounds} rounds to a result.</p>
    <table><tr><th>Ship</th><th>Disabled</th><th>Strain</th><th>Hit %</th><th>Damage</th></tr>${summary.ships.map(s => `<tr><td>${s.name}</td><td>${s.disabledPct}%${s.escapedPct ? ` (escaped ${s.escapedPct}%)` : ""}</td><td>${s.avgStrain}/${s.hp}</td><td>${s.hitPct}%</td><td>${s.avgDamage}${s.torpedoes ? `; torp ${s.torpedoes}` : ""}${s.volleys ? `; ${s.volleys} volleys` : ""}</td></tr>`).join("")}</table></div>` });
  return summary;
}

window.neonSim = { scenarios, run: (key, opts) => fight(key, opts), batch, stop: () => { window.neonSim.stopFlag = true; }, stopFlag: false };
return Object.keys(scenarios);
})()
