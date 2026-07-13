export const version: number;
export const SYSTEM_AUTO_SKILL_IDS: readonly string[];
export const GENERIC_ASSISTANT_SKILL_IDS: readonly string[];

export interface SkillCapabilityInput {
  inheritEngineDefaults?: boolean;
  inherit_engine_defaults?: boolean;
  enabledSkills?: string[];
  enabled_skills?: string[];
  disabledSkills?: string[];
  disabled_skills?: string[];
}

export interface EffectiveSkillOptions {
  presetSkillIds?: string[];
  preset_skill_ids?: string[];
  selectedSkillIds?: string[];
  selected_skill_ids?: string[];
}

export function resolveEffectiveSkillIds(
  capabilities?: SkillCapabilityInput,
  options?: EffectiveSkillOptions
): string[];
