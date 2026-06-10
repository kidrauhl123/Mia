"use strict";

// Local, bundled skill marketplace source.
//
// The curated catalog ships in the repo `skills/` folder (one `<id>/SKILL.md`
// per skill, git-versioned) plus a single `catalog.zh.json` that holds the
// Chinese display metadata (name/summary/category/order). This module merges
// the two into the market listing the desktop renders — no cloud, no network.
// `_`-prefixed dirs (e.g. `_builtin/`) ship pre-installed and are not market
// entries. `validateCatalog` is run at build time to keep dirs and manifest
// in lock-step.

const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_ZH_FIELDS = ["name_zh", "summary_zh", "category_zh"];

// In a packaged app the catalog ships via electron-builder extraResources
// (skills/ → <resources>/skills); in dev it is the repo `skills/` folder.
function packagedCatalogDir() {
  const base = process.resourcesPath;
  if (!base) return "";
  const dir = path.join(base, "skills");
  return fs.existsSync(path.join(dir, "catalog.zh.json")) ? dir : "";
}

function defaultCatalogDir() {
  return packagedCatalogDir() || path.join(__dirname, "..", "..", "..", "skills");
}

// Minimal YAML frontmatter scalar parser (keys: name/description/category).
function parseFrontmatter(raw) {
  const meta = {};
  const text = String(raw || "");
  if (!text.startsWith("---")) return meta;
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
  if (end <= 0) return meta;
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) meta[match[1]] = String(match[2] || "").trim().replace(/^['"]|['"]$/g, "");
  }
  return meta;
}

// A market-eligible skill dir: a real directory, not `_`-prefixed, with a SKILL.md.
function skillDirEntries(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .filter((id) => fs.existsSync(path.join(dir, id, "SKILL.md")))
    .sort();
}

function readZhManifest(dir) {
  const file = path.join(dir, "catalog.zh.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  return Array.isArray(parsed?.skills) ? parsed.skills : [];
}

function zhMapById(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (entry && entry.id) map.set(String(entry.id), entry);
  }
  return map;
}

// Returns the merged market listing, sorted by `order` (asc) then `id`.
function loadLocalSkillMarket({ catalogDir = defaultCatalogDir() } = {}) {
  const zh = zhMapById(readZhManifest(catalogDir));
  const skills = [];
  for (const id of skillDirEntries(catalogDir)) {
    const body = fs.readFileSync(path.join(catalogDir, id, "SKILL.md"), "utf8");
    const meta = parseFrontmatter(body);
    const zhEntry = zh.get(id) || {};
    skills.push({
      id,
      name: meta.name || id,
      name_zh: String(zhEntry.name_zh || "").trim() || meta.name || id,
      summary_zh: String(zhEntry.summary_zh || "").trim() || meta.description || "",
      category: meta.category || "",
      category_zh: String(zhEntry.category_zh || "").trim() || meta.category || "",
      sourceLabel: String(zhEntry.source_label || "").trim(),
      order: Number.isFinite(Number(zhEntry.order)) ? Number(zhEntry.order) : Number.MAX_SAFE_INTEGER,
      body
    });
  }
  skills.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return skills;
}

// Build-time consistency gate. Throws on the first problem found:
//  - a skill dir not present in the manifest
//  - a manifest id with no skill dir
//  - a manifest entry missing a required Chinese field
function validateCatalog({ catalogDir = defaultCatalogDir() } = {}) {
  const dirIds = new Set(skillDirEntries(catalogDir));
  const manifest = readZhManifest(catalogDir);
  const manifestIds = new Set(manifest.map((entry) => String(entry?.id || "")).filter(Boolean));

  const missingFromManifest = [...dirIds].filter((id) => !manifestIds.has(id));
  if (missingFromManifest.length) {
    throw new Error(`catalog.zh.json 缺少这些技能条目：${missingFromManifest.join(", ")}`);
  }

  const missingDirs = [...manifestIds].filter((id) => !dirIds.has(id));
  if (missingDirs.length) {
    throw new Error(`catalog.zh.json 含有无对应技能目录的 id：${missingDirs.join(", ")}`);
  }

  for (const entry of manifest) {
    for (const field of REQUIRED_ZH_FIELDS) {
      if (!String(entry?.[field] || "").trim()) {
        throw new Error(`技能 ${entry?.id || "?"} 的清单缺少必填字段 ${field}`);
      }
    }
  }
}

// Renderer-shaped market payload. The market UI keys filtering, search and
// cards off `category`/`description`, so surface the Chinese fields there.
function loadLocalSkillMarketPayload(opts = {}) {
  const skills = loadLocalSkillMarket(opts).map((skill) => ({
    ...skill,
    category: skill.category_zh || skill.category,
    description: skill.summary_zh
  }));
  const counts = new Map();
  for (const skill of skills) {
    const key = skill.category || "";
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const categories = [...counts.entries()].map(([category, count]) => ({ category, count }));
  return { skills, categories };
}

// Zip a bundled catalog skill dir into a buffer for local install (no download).
function packageLocalCatalogSkill(id, { catalogDir = defaultCatalogDir() } = {}) {
  if (!id) throw new Error("packageLocalCatalogSkill: id required");
  const dir = path.join(catalogDir, String(id));
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) throw new Error(`技能不存在：${id}`);
  const AdmZip = require("adm-zip");
  const zip = new AdmZip();
  zip.addLocalFolder(dir);
  return zip.toBuffer();
}

module.exports = {
  loadLocalSkillMarket,
  loadLocalSkillMarketPayload,
  packageLocalCatalogSkill,
  validateCatalog,
  parseFrontmatter,
  defaultCatalogDir
};
