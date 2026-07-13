const manifest = require("./skill-defaults.json");

function normalizeIds(input) {
  return Array.isArray(input)
    ? [...new Set(input.map((value) => String(value || "").trim()).filter(Boolean))]
    : [];
}

const SYSTEM_AUTO_SKILL_IDS = Object.freeze(normalizeIds(manifest.systemAutoSkillIds));
const GENERIC_ASSISTANT_SKILL_IDS = Object.freeze(normalizeIds(manifest.genericAssistantSkillIds));

function resolveEffectiveSkillIds(capabilities = {}, options = {}) {
  const value = capabilities && typeof capabilities === "object" ? capabilities : {};
  const disabled = new Set(normalizeIds(value.disabledSkills || value.disabled_skills));
  const ordered = [];
  const seen = new Set();
  const append = (ids, { ignoreDisabled = false } = {}) => {
    for (const id of normalizeIds(ids)) {
      if ((!ignoreDisabled && disabled.has(id)) || seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
  };

  const inherits = value.inheritEngineDefaults !== false && value.inherit_engine_defaults !== false;
  if (inherits) append(SYSTEM_AUTO_SKILL_IDS);
  append(options.presetSkillIds || options.preset_skill_ids);
  append(value.enabledSkills || value.enabled_skills);
  append(options.selectedSkillIds || options.selected_skill_ids, { ignoreDisabled: true });
  return ordered;
}

module.exports = {
  version: Number(manifest.version || 0),
  SYSTEM_AUTO_SKILL_IDS,
  GENERIC_ASSISTANT_SKILL_IDS,
  resolveEffectiveSkillIds
};
