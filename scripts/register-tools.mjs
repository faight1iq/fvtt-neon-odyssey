// Registers Neon Odyssey tools (reskinned Computers & Technology skills) as
// dnd5e base tool types so they appear in tool proficiency pickers (tool:*).
const NO_TOOL_IDS = {
    "computerinterface": "Compendium.fvtt-neon-odyssey.equipment.Item.NOtoolCompInterf",
    "technologytoolkit": "Compendium.fvtt-neon-odyssey.equipment.Item.NOtoolTechToolkt",
};
Hooks.once("setup", () => {
  if (!globalThis.CONFIG?.DND5E?.toolIds) return;
  for (const [key, uuid] of Object.entries(NO_TOOL_IDS)) CONFIG.DND5E.toolIds[key] = uuid;
  console.log(`Neon Odyssey | registered ${Object.keys(NO_TOOL_IDS).length} tools into CONFIG.DND5E.toolIds`);
});
