// Automated fighter duel on the radar (GM console). Watch the blips move and the rolls in chat.
//   const src = await fetch("modules/fvtt-neon-odyssey/tools/fighter-duel.js").then(r => r.text());
//   (0, eval)(src);                       // starts the duel on the current scene
//   window.neonDuel.stop();               // stops it early
// Options: window.neonDuelOptions = { actor: "M-18 Fighter", attack: 6, delay: 1200, rounds: 20, keepTokens: false }
// Rules used (John, 2026-10-12): Speed per round (bands 1,2,4.. / facings 1,2,3..), bow weapon arc
// (90°) and range bands, d20 + attack vs AC, damage to Strain; once Strain passes MT every hit is a
// Mishap (Armor takes the first 2, then a random system); 2 Mishaps on a system disables it, on
// Power / Propulsion / Command & Control disables the ship; Strain over HP disables the ship.
// Strain is tracked by this script only: the actors are not damaged.
(async () => {
  const MOD = "fvtt-neon-odyssey";
  const opt = { actor: "M-18 Fighter", attack: 6, delay: 1200, rounds: 20, keepTokens: false, ...(window.neonDuelOptions ?? {}) };
  const scene = canvas.scene;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let stopped = false;
  window.neonDuel = { stop: () => { stopped = true; } };
  const say = (html, alias = "Duel Control") => ChatMessage.implementation.create({ content: `<div class="no-crew-card">${html}</div>`, speaker: { alias } });

  // Radar area (same as crew-stations.mjs).
  const tile = scene.tiles.find(t => t.getFlag(MOD, "radar"));
  if (!tile) return ui.notifications.warn("No radar tile on this scene.");
  const scale = Number(tile.getFlag(MOD, "areaScale")) || 1;
  const W = Math.abs(tile._source.width), H = Math.abs(tile._source.height);
  const area = { x: tile._source.x + W / 2, y: tile._source.y + H / 2, r: (Math.min(W, H) / 2) * scale };
  const BAND = area.r / 5;
  const actor = game.actors.find(a => a.name === opt.actor);
  if (!actor) return ui.notifications.warn(`No actor named ${opt.actor}.`);
  const crew = game.modules.get(MOD).crew;
  const ML = await import(`/modules/${MOD}/scripts/mishap-links.mjs`);
  const weapon = actor.items.find(i => i.type === "weapon" && i.flags[MOD]?.component);
  const wc = weapon.flags[MOD].component;
  const dmgFormula = String(wc.info.Damage).match(/\d+d\d+/)[0];
  const [minR, maxR] = String(wc.info.Range).split(/[–-]/).map(s => s.trim());
  const RANGES = ["PB", "Short", "Medium", "Long", "Extreme"];
  const RANGE_KEY = { "PB": "PB", "Point Blank": "PB", "Short": "Short", "Medium": "Medium", "Long": "Long", "Extreme": "Extreme" };
  const wMin = RANGE_KEY[minR] ?? "Short", wMax = RANGE_KEY[maxR ?? minR] ?? "Long";
  const facing = weapon.flags[MOD]?.facing ?? "bow";
  const ARC = { bow: 0, starboard: 90, aft: 180, port: 270 };
  const SIZE_TIER = { Tiny: 1, Small: 1, Medium: 2, Large: 3, Huge: 4, Gargantuan: 5 };
  const tierPass = SIZE_TIER[wc.info.Size] ?? 1;
  const hasArmor = actor.items.some(i => i.flags[MOD]?.component?.slot === "armor");
  const SYSTEMS = ["Command & Control", "Navigation", "Power", "Propulsion", "Bow", "Habitat"];
  const CRIT = new Set(["Command & Control", "Power", "Propulsion"]);
  const stats = { ac: actor.system.attributes.ac.flat ?? actor.system.attributes.ac.value, hp: actor.system.attributes.hp.max,
    mt: actor.system.attributes.hp.mt, speed: crew.shipSpeed(actor), dexMod: actor.system.abilities.dex.mod };

  // Ships: position in bands from the radar center (x right, y forward/up), heading in degrees clockwise from up.
  const mk = (name, x, y, h, disposition) => ({ name, x, y, h, disposition, strain: 0, armorM: 0, sys: {}, disabled: null });
  const ships = [mk("Red Leader", -0.5, -2.2, 0, -1), mk("Blue Leader", 0.5, 2.2, 180, 0)];
  const toScreen = s => ({ x: area.x + s.x * BAND, y: area.y - s.y * BAND });

  // Tokens.
  for (const s of ships) {
    const p = toScreen(s);
    const td = (await actor.getTokenDocument({ name: s.name, disposition: s.disposition, rotation: s.h, actorLink: false,
      displayName: CONST.TOKEN_DISPLAY_MODES.ALWAYS, x: p.x - 50, y: p.y - 50 })).toObject();
    [s.token] = await scene.createEmbeddedDocuments("Token", [td]);
  }
  await sleep(2500);   // crew-stations shrinks them to radar blips
  const place = async s => {
    const p = toScreen(s), t = s.token, half = (t._source.width * scene.grid.size) / 2;
    await t.update({ x: Math.round(p.x - half), y: Math.round(p.y - half), rotation: (s.h % 360 + 360) % 360 },
      { neonOdysseyResize: true, animation: { duration: 700 } });
    await sleep(800);
  };
  for (const s of ships) await place(s);

  const rel = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
    const bear = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    return { dist, rb: ((bear - a.h) % 360 + 360) % 360 };
  };
  const band = d => d < 1 ? "PB" : d < 2 ? "Short" : d < 3 ? "Medium" : d < 4 ? "Long" : d < 5 ? "Extreme" : "Out";
  const clock = rb => (Math.round(rb / 30) % 12) || 12;
  const shot = (a, b) => {
    if ((a.sys.Bow ?? 0) >= 2) return null;
    const { dist, rb } = rel(a, b);
    if (Math.abs(((rb - ARC[facing]) + 540) % 360 - 180) > 45) return null;
    const bd = band(dist), i = RANGES.indexOf(bd);
    if (i < 0) return null;
    if (bd === "PB" && wMin !== "PB") return { dis: true, bd };
    if (i < RANGES.indexOf(wMin) || i > RANGES.indexOf(wMax)) return null;
    return { dis: false, bd };
  };
  const step = (s, a) => {
    const n = { ...s };
    if (a === "F") { const r = n.h * Math.PI / 180; n.x += Math.sin(r); n.y += Math.cos(r);
      const d = Math.hypot(n.x, n.y); if (d > 4.6) { n.x *= 4.6 / d; n.y *= 4.6 / d; } }
    else n.h = (n.h + (a === "L" ? -30 : 30) + 360) % 360;
    return n;
  };
  const plans = speed => { const out = [[]]; const rec = (seq, b, f, sp) => { for (const a of ["F", "L", "R"]) {
    const c = a === "F" ? 2 ** b : f + 1; if (sp + c > speed) continue; const s2 = [...seq, a]; out.push(s2);
    rec(s2, b + (a === "F"), f + (a !== "F"), sp + c); } }; rec([], 0, 0, 0); return out; };
  const choose = (me, foe) => { let best = [], bs = -1e9;
    for (const p of plans(stats.speed)) { let s = me; for (const a of p) s = step(s, a);
      const f = shot(s, foe), back = shot(foe, s), { dist } = rel(s, foe);
      const score = (f ? (f.dis ? 40 : 100) : 0) - (back ? 60 : 0) - Math.abs(dist - 2.5) * 5 + Math.random();
      if (score > bs) { bs = score; best = p; } } return best; };
  const WORD = { F: "forward one band", L: "turn left (30°)", R: "turn right (30°)" };

  await say(`<h3>Dogfight: ${ships[0].name} vs ${ships[1].name}</h3>
    <p>${opt.actor}: AC ${stats.ac}, HP ${stats.hp}, MT ${stats.mt}, Speed ${stats.speed}${hasArmor ? ", armored" : ""}.
    Weapon: ${weapon.name} (${dmgFormula}, ${facing}, ${wMin}–${wMax}). Pilots +${opt.attack} to hit.</p>`);

  // Initiative.
  for (const s of ships) {
    s.init = await new Roll(`1d20 + ${stats.dexMod}`).evaluate();
    await s.init.toMessage({ flavor: `${s.name}: initiative`, speaker: { alias: s.name } });
  }
  const order = [...ships].sort((a, b) => b.init.total - a.init.total);
  await sleep(opt.delay);

  for (let round = 1; round <= opt.rounds && !stopped; round++) {
    await say(`<h3>Round ${round}</h3>`);
    for (const me of order) {
      if (stopped) break;
      const foe = me === ships[0] ? ships[1] : ships[0];
      if (me.disabled || foe.disabled) continue;
      const plan = choose(me, foe);
      let spent = 0, b = 0, f = 0;
      for (const a of plan) { spent += a === "F" ? 2 ** b++ : ++f; Object.assign(me, step(me, a)); await place(me); }
      const { dist, rb } = rel(me, foe);
      await say(`<p><strong>${me.name}</strong>: ${plan.length ? plan.map(a => WORD[a]).join(", ") : "holds course"}
        (${spent} of ${stats.speed} Speed). ${foe.name} at ${clock(rb)} o'clock, ${band(dist)} range.</p>`, me.name);
      const sh = shot(me, foe);
      if (!sh) { await say(`<p>${me.name}: no shot (target outside the ${facing} arc or out of range).</p>`, me.name); await sleep(opt.delay); continue; }
      const atk = await new Roll(sh.dis ? `2d20kl + ${opt.attack}` : `1d20 + ${opt.attack}`).evaluate();
      const nat = atk.dice[0].total, crit = nat === 20;
      await atk.toMessage({ flavor: `${me.name} fires ${weapon.name} at ${foe.name} (${sh.bd}${sh.dis ? ", disadvantage" : ""}) vs AC ${stats.ac}`, speaker: { alias: me.name } });
      await sleep(opt.delay);
      if (!crit && atk.total < stats.ac) { await say(`<p>${me.name}: <strong>miss</strong>.</p>`, me.name); continue; }
      const dmg = await new Roll(crit ? dmgFormula.replace(/^(\d+)d/, (m, n) => `${2 * n}d`) : dmgFormula).evaluate();
      await dmg.toMessage({ flavor: `${me.name}: ${crit ? "CRITICAL " : ""}hit! ${wc.info["Damage Type"] ?? ""} damage to ${foe.name}`, speaker: { alias: me.name } });
      const before = foe.strain; foe.strain += dmg.total;
      let msg = `<p><strong>${foe.name}</strong>: Strain ${before} → <strong>${foe.strain}</strong> of ${stats.hp} (MT ${stats.mt}).</p>`;
      if (foe.strain > stats.mt) {
        let where;
        if (hasArmor && foe.armorM < 2) { foe.armorM++; where = `Armor (${foe.armorM} of 2)`; }
        else { const sys = SYSTEMS[Math.floor(Math.random() * SYSTEMS.length)]; foe.sys[sys] = (foe.sys[sys] ?? 0) + 1; where = `${sys} (${foe.sys[sys]})`;
          if (foe.sys[sys] >= 2) { if (CRIT.has(sys)) foe.disabled ??= `${sys} has 2 Mishaps`; else msg += `<p>${sys} is <strong>disabled</strong> until a Mishap is cleared.</p>`; } }
        const m = await ML.rollMishap(actor, tierPass);
        msg += `<p class="no-crew-alert"><strong>MISHAP</strong> on ${where}: ${m ? `@UUID[${m.uuid}]{${m.name}}` : "roll one"} (${ML.MISHAP_TIERS[tierPass - 1]}).</p>`;
      }
      if (foe.strain > stats.hp) foe.disabled ??= `Strain ${foe.strain} exceeds HP ${stats.hp}`;
      if (foe.disabled) msg += `<p class="no-crew-alert"><strong>${foe.name} DISABLED</strong>: ${foe.disabled}.</p>`;
      await say(msg, foe.name);
      await sleep(opt.delay);
    }
    const down = ships.find(s => s.disabled);
    if (down) { const win = ships.find(s => s !== down);
      await say(`<h3>${win.name} wins in round ${round}</h3><p>${win.name}: Strain ${win.strain}/${stats.hp}, Mishaps ${win.armorM + Object.values(win.sys).reduce((a, b) => a + b, 0)}.
        ${down.name}: Strain ${down.strain}/${stats.hp}, Mishaps ${down.armorM + Object.values(down.sys).reduce((a, b) => a + b, 0)}.</p>`);
      break; }
  }
  if (stopped) await say(`<p>Duel stopped.</p>`);
  if (!opt.keepTokens) { await say(`<p>Removing the duel tokens in 20 seconds.</p>`); await sleep(20000); await scene.deleteEmbeddedDocuments("Token", ships.map(s => s.token.id).filter(id => scene.tokens.has(id))); }
})();
