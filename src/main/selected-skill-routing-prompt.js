"use strict";

const path = require("node:path");

function cleanText(value = "") {
  return String(value || "").trim();
}

function escapeXmlText(value = "") {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function skillDirectoryFromPath(skillPath = "") {
  const normalized = cleanText(skillPath).replace(/\\/g, "/");
  return normalized.replace(/\/SKILL\.md$/i, "") || normalized;
}

function skillMarkdownPath(skill = {}) {
  const sourcePath = cleanText(
    skill.sourcePath
    || skill.source_path
    || (skill.filePath ? path.dirname(skill.filePath) : "")
  );
  return sourcePath ? path.join(sourcePath, "SKILL.md") : "";
}

function normalizeRoutingSkill(skill = {}) {
  const location = skillMarkdownPath(skill);
  if (!location) return null;
  return {
    location,
    directory: skillDirectoryFromPath(location)
  };
}

function buildSelectedSkillRoutingPrompt(skills = []) {
  const entries = [];
  const seen = new Set();
  for (const rawSkill of Array.isArray(skills) ? skills : []) {
    const skill = normalizeRoutingSkill(rawSkill);
    if (!skill || seen.has(skill.location)) continue;
    seen.add(skill.location);
    entries.push(`  <path>${escapeXmlText(skill.location)}</path>`);
  }
  if (!entries.length) return "";
  return [
    "<selected_skill_paths>",
    ...entries,
    "</selected_skill_paths>"
  ].join("\n");
}

module.exports = Object.freeze({
  buildSelectedSkillRoutingPrompt,
  skillDirectoryFromPath,
  skillMarkdownPath
});
