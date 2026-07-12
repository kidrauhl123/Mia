// Skill marketplace catalog source-of-truth (sub-project B, slice 3).
//
// The catalog lives in the repo `skills/` folder, one `<id>/SKILL.md` per
// skill (git-versioned). Top-level entries are the marketplace catalog —
// add a folder to publish, edit to update, delete to retire. The `_builtin/`
// subfolder (and any `_`-prefixed dir) is excluded: those ship pre-installed
// with the app and are scanned locally, not offered as market installs.
// `scripts/sync-cloud-skills.js` pushes the catalog into the cloud `skills`
// table; the cloud server also seeds a fresh DB from it on startup.

const fs = require("node:fs");
const path = require("node:path");

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

function defaultCatalogDir() {
  return path.join(__dirname, "..", "..", "skills");
}

function defaultBuiltinSkillsDir() {
  return path.join(defaultCatalogDir(), "_builtin");
}

// Returns [{ id, name, category, description, sourceLabel, body }] sorted by id.
// `id` is the folder name; `body` is the full SKILL.md (frontmatter included,
// because that is exactly what gets written to the user's local skills dir on
// install). Folders without a SKILL.md are skipped.
function loadSkillDirectory(dir, { skipPrivate = false } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (skipPrivate && entry.name.startsWith("_")) continue;
    let body;
    try {
      body = fs.readFileSync(path.join(dir, entry.name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const meta = parseFrontmatter(body);
    skills.push({
      id: entry.name,
      name: meta.name || entry.name,
      category: meta.category || "uncategorized",
      description: meta.description || "",
      sourceLabel: meta.source || meta.sourceLabel || "Mia 官方",
      dir: path.join(dir, entry.name),
      body
    });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

function loadSkillsCatalog(dir = defaultCatalogDir()) {
  return loadSkillDirectory(dir, { skipPrivate: true });
}

function loadBuiltinSkillsCatalog(dir = defaultBuiltinSkillsDir()) {
  return loadSkillDirectory(dir);
}

module.exports = {
  defaultBuiltinSkillsDir,
  defaultCatalogDir,
  loadBuiltinSkillsCatalog,
  loadSkillsCatalog,
  parseFrontmatter
};
