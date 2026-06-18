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

function schedulerSkillIdsForTurn({ activeSkillIds = [], background = false, scheduledFire = false } = {}) {
  const ids = dedupeSkillIds(activeSkillIds);
  if (!background && !scheduledFire && !ids.includes(MIA_SCHEDULER_SKILL_ID)) {
    ids.push(MIA_SCHEDULER_SKILL_ID);
  }
  return ids;
}

module.exports = {
  MIA_SCHEDULER_SKILL_ID,
  schedulerSkillIdsForTurn
};
