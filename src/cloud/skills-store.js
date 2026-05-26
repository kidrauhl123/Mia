// Cloud skill marketplace registry (sub-project B, slice 1).
//
// The cloud holds the canonical catalog of installable skills: each row
// carries the FULL SKILL.md body so a desktop client can "添加" by
// downloading the content into its local skills directory. install_count
// is a real, denormalized counter bumped once per distinct user via the
// skill_installs ledger — never seeded with fake numbers (it starts at 0
// and grows as people actually install).

function nowIso() {
  return new Date().toISOString();
}

// List/detail responses omit `body` to keep the catalog payload light;
// only getSkill / recordInstall return the full body the client writes.
function rowToSkillMeta(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description || "",
    sourceLabel: row.source_label || "",
    installCount: row.install_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToSkillFull(row) {
  const meta = rowToSkillMeta(row);
  if (!meta) return null;
  return { ...meta, body: row.body || "" };
}

function createSkillsStore(db) {
  const upsertStmt = db.prepare(
    "INSERT INTO skills (id, name, category, description, source_label, body, install_count, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?) " +
    "ON CONFLICT (id) DO UPDATE SET " +
    "  name = excluded.name, category = excluded.category, description = excluded.description, " +
    "  source_label = excluded.source_label, body = excluded.body, updated_at = excluded.updated_at"
  );
  const getStmt = db.prepare(
    "SELECT id, name, category, description, source_label, body, install_count, created_at, updated_at " +
    "FROM skills WHERE id = ?"
  );
  const categoriesStmt = db.prepare(
    "SELECT category, COUNT(*) AS count FROM skills GROUP BY category ORDER BY count DESC, category ASC"
  );
  const insertInstallStmt = db.prepare(
    "INSERT OR IGNORE INTO skill_installs (skill_id, user_id, created_at) VALUES (?, ?, ?)"
  );
  const bumpStmt = db.prepare("UPDATE skills SET install_count = install_count + 1 WHERE id = ?");
  const deleteStmt = db.prepare("DELETE FROM skills WHERE id = ?");

  function upsertSkill(skill) {
    if (!skill || !skill.id || !skill.name) throw new Error("upsertSkill: skill.id and skill.name required");
    if (!skill.body) throw new Error("upsertSkill: skill.body required");
    const now = nowIso();
    upsertStmt.run(
      String(skill.id),
      String(skill.name),
      String(skill.category || "uncategorized"),
      String(skill.description || ""),
      String(skill.sourceLabel || ""),
      String(skill.body),
      now,
      now
    );
    return getSkill(skill.id);
  }

  function listSkills({ category = "", q = "", limit = 60 } = {}) {
    const where = [];
    const params = [];
    if (category) { where.push("category = ?"); params.push(String(category)); }
    if (q) {
      where.push("(name LIKE ? OR description LIKE ?)");
      const like = `%${String(q)}%`;
      params.push(like, like);
    }
    const sql =
      "SELECT id, name, category, description, source_label, install_count, created_at, updated_at FROM skills" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY install_count DESC, updated_at DESC LIMIT ?";
    params.push(Math.min(Math.max(Number(limit) || 60, 1), 200));
    return db.prepare(sql).all(...params).map(rowToSkillMeta);
  }

  function listCategories() {
    return categoriesStmt.all().map((row) => ({ category: row.category, count: row.count }));
  }

  function getSkill(id) {
    return rowToSkillFull(getStmt.get(String(id)));
  }

  // Idempotent per user: re-installing the same skill does not inflate the
  // count. Returns the full skill (with body) so the caller can hand the
  // content to the desktop client, or null if the skill does not exist.
  function recordInstall(skillId, userId) {
    if (!getStmt.get(String(skillId))) return null;
    const inserted = insertInstallStmt.run(String(skillId), String(userId), nowIso()).changes;
    if (inserted > 0) bumpStmt.run(String(skillId));
    return getSkill(skillId);
  }

  // Insert seed skills that are not already present; never clobbers an
  // existing row (so operator/admin edits survive a server restart).
  function seedSkills(seeds) {
    for (const seed of Array.isArray(seeds) ? seeds : []) {
      if (seed && seed.id && !getStmt.get(String(seed.id))) upsertSkill(seed);
    }
  }

  function deleteSkill(id) {
    return deleteStmt.run(String(id)).changes;
  }

  return { upsertSkill, listSkills, listCategories, getSkill, recordInstall, seedSkills, deleteSkill };
}

module.exports = { createSkillsStore };
