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
    "这些是当前 Bot 可用的能力索引。只有当用户请求明显匹配时才使用；不要向用户复述这个索引。",
    "如果完成当前请求需要某个 Skill 的完整指南，请只输出 `[LOAD_SKILL: skill-id]`，Mia 会为你加载后继续执行。",
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
    "以下 Skill 是本轮被用户显式选择、被明确意图触发或由你按需请求加载的指南。只在完成当前请求需要时使用；不要向用户解释内部 Skill 选择。",
    "",
    blocks.join("\n\n")
  ].join("\n");
}

function buildSkillMaterializationContext(materialization = {}) {
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
  buildSkillMaterializationContext,
  buildSkillIndexBlock,
  materializeSkillsForTurn,
  normalizeSkillRecord,
  uniqueSkillIds
};
