use serde::Deserialize;
use std::collections::HashSet;
use std::sync::OnceLock;

const SKILL_DEFAULTS_JSON: &str = include_str!("../../../packages/shared/skill-defaults.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillDefaultsManifest {
    version: u32,
    system_auto_skill_ids: Vec<String>,
    generic_assistant_skill_ids: Vec<String>,
}

fn manifest() -> &'static SkillDefaultsManifest {
    static MANIFEST: OnceLock<SkillDefaultsManifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        let parsed: SkillDefaultsManifest = serde_json::from_str(SKILL_DEFAULTS_JSON)
            .expect("shared skill-defaults.json must be valid");
        assert_eq!(
            parsed.version, 1,
            "unsupported shared skill defaults version"
        );
        parsed
    })
}

pub fn system_auto_skill_ids() -> &'static [String] {
    &manifest().system_auto_skill_ids
}

pub fn generic_assistant_skill_ids() -> &'static [String] {
    &manifest().generic_assistant_skill_ids
}

pub fn resolve_effective_skill_ids(
    inherit_engine_defaults: bool,
    preset_skill_ids: &[String],
    enabled_skill_ids: &[String],
    disabled_skill_ids: &[String],
    selected_skill_ids: &[String],
) -> Vec<String> {
    let disabled = disabled_skill_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut resolved = Vec::new();

    let mut append = |ids: &[String], ignore_disabled: bool| {
        for id in ids {
            let id = id.trim();
            if id.is_empty()
                || (!ignore_disabled && disabled.contains(id))
                || !seen.insert(id.to_owned())
            {
                continue;
            }
            resolved.push(id.to_owned());
        }
    };

    if inherit_engine_defaults {
        append(system_auto_skill_ids(), false);
    }
    append(preset_skill_ids, false);
    append(enabled_skill_ids, false);
    append(selected_skill_ids, true);
    resolved
}
