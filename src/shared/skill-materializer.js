"use strict";

function cleanText(value = "") {
  return String(value || "").trim();
}

function uniqueSkillIds(ids = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(ids) ? ids : []) {
    const id = cleanText(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeSkillRecord(skill = {}) {
  const id = cleanText(skill.id || skill.key || skill.name);
  const name = cleanText(skill.name || skill.displayName || skill.display_name || id);
  const description = cleanText(skill.description || skill.desc || "");
  const body = cleanText(skill.body || skill.raw || "");
  if (!id && !name) return null;
  return { id: id || name, name: name || id, description, body };
}

function skillLookupMap(records = []) {
  const map = new Map();
  for (const input of Array.isArray(records) ? records : []) {
    const skill = normalizeSkillRecord(input);
    if (!skill) continue;
    map.set(skill.id, skill);
    map.set(skill.name, skill);
    if (!skill.id.includes(":")) map.set(`mia:${skill.id}`, skill);
    if (skill.id.includes(":")) map.set(skill.id.split(":").pop(), skill);
  }
  return map;
}

function buildSkillIndexBlock(skills = []) {
  const rows = (Array.isArray(skills) ? skills : [])
    .map(normalizeSkillRecord)
    .filter(Boolean);
  if (!rows.length) return "";
  return [
    "## Available Mia Skills",
    "",
    "These are capability indexes available to the current Mia bot. Use a skill only when the user's request clearly matches it, and do not repeat this index to the user.",
    "If completing the current request requires a full skill guide that is not loaded yet, output only `[LOAD_SKILL: skill-id]`; Mia will load it and continue the turn.",
    "",
    ...rows.map((skill) => {
      const label = skill.id === skill.name ? skill.id : `${skill.id} (${skill.name})`;
      return `- ${label}: ${skill.description || "No description."}`;
    })
  ].join("\n");
}

function buildLoadedSkillBlocks(skills = []) {
  const blocks = (Array.isArray(skills) ? skills : [])
    .map(normalizeSkillRecord)
    .filter((skill) => skill && skill.body)
    .map((skill) => `=== Skill: ${skill.name} ===\n${skill.body}\n=== End Skill ===`);
  if (!blocks.length) return "";
  return [
    "## Loaded Mia Skill Guides",
    "",
    "The following skills were explicitly selected by the user, matched by intent, or loaded after a `[LOAD_SKILL: skill-id]` request. Use them only when needed for the current request, and do not explain internal skill selection to the user.",
    "",
    blocks.join("\n\n")
  ].join("\n");
}

function buildMcpSkillMaterializationContext(materialization = {}) {
  const loadedIds = uniqueSkillIds(materialization?.loadedSkillIds);
  const hasSkillIndex = Boolean(cleanText(materialization?.indexBlock));
  if (!hasSkillIndex && !loadedIds.length) return "";
  const lines = [
    "## Mia Skill Tools",
    "",
    "Use `skill_list_current` to list skills enabled for the current Mia bot, then use `skill_read_current` to read a full skill guide only when needed. Do not use the text-based skill loading protocol in MCP-capable turns.",
    loadedIds.length
      ? `For this turn, prioritize these selected or inferred skills and read their guide with \`skill_read_current\`: ${loadedIds.join(", ")}.`
      : ""
  ].map((block) => cleanText(block)).filter(Boolean);
  return lines.join("\n\n");
}

function buildSkillMaterializationContext(materialization = {}, options = {}) {
  const deliveryMode = cleanText(options.deliveryMode || options.mode || "prompt").toLowerCase();
  if (deliveryMode === "mcp" || deliveryMode === "tools") {
    return buildMcpSkillMaterializationContext(materialization);
  }
  if (deliveryMode === "file" || deliveryMode === "native-file" || deliveryMode === "native") return "";
  return [
    materialization?.indexBlock,
    materialization?.loadedBlock
  ].map((block) => cleanText(block)).filter(Boolean).join("\n\n");
}

function materializeSkillsForTurn({ availableSkills = [], activeSkillIds = [], intentSkillIds = [], requestedSkillIds = [], mode = "index" } = {}) {
  const records = (Array.isArray(availableSkills) ? availableSkills : [])
    .map(normalizeSkillRecord)
    .filter(Boolean);
  const lookup = skillLookupMap(records);
  const loadIds = uniqueSkillIds([...activeSkillIds, ...intentSkillIds, ...requestedSkillIds]);
  const loaded = [];
  const seenLoaded = new Set();
  for (const id of loadIds) {
    const skill = lookup.get(id);
    if (!skill || seenLoaded.has(skill.id)) continue;
    seenLoaded.add(skill.id);
    loaded.push(skill);
  }
  return {
    indexBlock: mode === "none" ? "" : buildSkillIndexBlock(records),
    loadedBlock: buildLoadedSkillBlocks(loaded),
    loadedSkillIds: loaded.map((skill) => skill.id)
  };
}

module.exports = {
  buildLoadedSkillBlocks,
  buildMcpSkillMaterializationContext,
  buildSkillMaterializationContext,
  buildSkillIndexBlock,
  materializeSkillsForTurn,
  normalizeSkillRecord,
  uniqueSkillIds
};
