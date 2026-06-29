const MIA_SCHEDULER_SKILL_ID = "mia-scheduler";

function dedupeSkillIds(ids = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(ids) ? ids : []) {
    const id = String(value || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function schedulerSkillIdsForTurn({ activeSkillIds = [] } = {}) {
  return dedupeSkillIds(activeSkillIds);
}

module.exports = {
  MIA_SCHEDULER_SKILL_ID,
  schedulerSkillIdsForTurn
};
