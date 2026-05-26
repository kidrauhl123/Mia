// Skill marketplace catalog source-of-truth (sub-project B, slice 3).
//
// The catalog is a folder of `<id>/SKILL.md` files (git-versioned). This is
// the ONE place an operator edits the marketplace: add a folder to publish,
// edit a file to update, delete a folder to retire. `scripts/sync-cloud-skills.js`
// pushes the folder into the cloud `skills` table; the cloud server also
// seeds a fresh DB from it on startup.

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
  return path.join(__dirname, "..", "..", "skills-catalog");
}

// Returns [{ id, name, category, description, sourceLabel, body }] sorted by id.
// `id` is the folder name; `body` is the full SKILL.md (frontmatter included,
// because that is exactly what gets written to the user's local skills dir on
// install). Folders without a SKILL.md are skipped.
function loadSkillsCatalog(dir = defaultCatalogDir()) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
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
      body
    });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { loadSkillsCatalog, parseFrontmatter, defaultCatalogDir };
