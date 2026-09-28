// Registers all Neon Odyssey tools as dnd5e base tools so they appear as
// selectable options in tool proficiency pickers (tool:*), and so class /
// species / background / feat grants that reference them resolve.
//
// dnd5e 5.x note: CONFIG.DND5E.toolIds is a read-through Proxy over
// CONFIG.DND5E.tools. Assigning toolIds[key]=uuid stores a bare STRING where
// the picker expects { ability, id }, so we write into CONFIG.DND5E.tools
// directly. Source: Outrunner's Handbook v0.1.1 pp.151-153.
const NO_TOOLS = {
  "computerinterface": { ability: "int", id: "Compendium.fvtt-neon-odyssey.equipment.Item.NOtoolCompInterf" },
  "technologytoolkit": { ability: "int", id: "Compendium.fvtt-neon-odyssey.equipment.Item.NOtoolTechToolkt" },
  "artistssupplies": { ability: "dex", id: "Compendium.fvtt-neon-odyssey.equipment.Item.x7D95fnbrvVYXXvK" },
  "brewingsupplies": { ability: "int", id: "Compendium.fvtt-neon-odyssey.equipment.Item.MIt1vJSWSFzUFEMP" },
  "chefsutensils": { ability: "wis", id: "Compendium.fvtt-neon-odyssey.equipment.Item.lEcqNfdnkGrjJUQQ" },
  "chemistssupplies": { ability: "int", id: "Compendium.fvtt-neon-odyssey.equipment.Item.k8AhlEEn7bAR7H7t" },
  "constructiontools": { ability: "str", id: "Compendium.fvtt-neon-odyssey.equipment.Item.4m4sADg3Qvz1UUqR" },
  "electronicstools": { ability: "int", id: "Compendium.fvtt-neon-odyssey.equipment.Item.RNXTQ4BnwZFAnY2j" },
  "engineerstools": { ability: "int", id: "Compendium.fvtt-neon-odyssey.equipment.Item.kyZMQcuU92U8KIEB" },
  "jewelrytools": { ability: "int", id: "Compendium.fvtt-neon-odyssey.equipment.Item.XmnG6ku1SIAIDzpS" },
  "mechanicstools": { ability: "int", id: "Compendium.fvtt-neon-odyssey.equipment.Item.NChvfGKkuNYTApPz" },
  "polymermoldingtools": { ability: "int", id: "Compendium.fvtt-neon-odyssey.equipment.Item.i4uSxUck6BduHuj7" },
  "surveyingtools": { ability: "wis", id: "Compendium.fvtt-neon-odyssey.equipment.Item.ZdSToDtfATSm0Yu0" },
  "textiletools": { ability: "dex", id: "Compendium.fvtt-neon-odyssey.equipment.Item.tv7U1N7zxbY0MjjP" },
  "bypasstools": { ability: "dex", id: "Compendium.fvtt-neon-odyssey.equipment.Item.ofghgSkgaAkxwDpQ" },
  "forgerskit": { ability: "dex", id: "Compendium.fvtt-neon-odyssey.equipment.Item.8JyG1G1o06EgBv2o" },
  "gameset": { ability: "dex", id: "Compendium.fvtt-neon-odyssey.equipment.Item.FvHrAS8IAybjhdb9" },
  "infiltratorskit": { ability: "cha", id: "Compendium.fvtt-neon-odyssey.equipment.Item.WBwQiogUMhrJwQmy" },
  "musiciansinstrument": { ability: "cha", id: "Compendium.fvtt-neon-odyssey.equipment.Item.tv7AF1ePJ3cymEdE" },
  "navigationtools": { ability: "wis", id: "Compendium.fvtt-neon-odyssey.equipment.Item.cdEyPyhUjTWFVtjS" },
  "pharmakit": { ability: "int", id: "Compendium.fvtt-neon-odyssey.equipment.Item.9o0V3aEjpO1W9bl5" },
  "spikingdeck": { ability: "int", id: "Compendium.fvtt-neon-odyssey.equipment.Item.4X1T7zMBq7Jp65pZ" },
  "toxinkit": { ability: "int", id: "Compendium.fvtt-neon-odyssey.equipment.Item.hlRgFQNzGkE6CYO1" },
};
Hooks.once("setup", () => {
  const cfg = globalThis.CONFIG?.DND5E;
  if (!cfg) return;
  if (cfg.tools) {
    for (const [key, data] of Object.entries(NO_TOOLS)) cfg.tools[key] = data;
    console.log(`Neon Odyssey | registered ${Object.keys(NO_TOOLS).length} tools into CONFIG.DND5E.tools`);
  } else if (cfg.toolIds) {
    for (const [key, data] of Object.entries(NO_TOOLS)) cfg.toolIds[key] = data.id;
    console.log(`Neon Odyssey | registered ${Object.keys(NO_TOOLS).length} tools into CONFIG.DND5E.toolIds (legacy)`);
  }
});
