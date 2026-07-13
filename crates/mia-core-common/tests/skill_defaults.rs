use mia_core_common::skill_defaults::{
    generic_assistant_skill_ids, resolve_effective_skill_ids, system_auto_skill_ids,
};

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[test]
fn rust_core_reads_the_shared_skill_default_manifest() {
    assert_eq!(
        system_auto_skill_ids(),
        ids(&["mia-scheduler", "mia-official:officecli"])
    );
    assert_eq!(
        generic_assistant_skill_ids(),
        ids(&[
            "mia-official:officecli-docx",
            "mia-official:officecli-xlsx",
            "mia-official:officecli-pptx",
        ])
    );
}

#[test]
fn rust_core_resolves_the_same_effective_skill_order_as_node() {
    assert_eq!(
        resolve_effective_skill_ids(true, &[], &[], &[], &[]),
        ids(&["mia-scheduler", "mia-official:officecli"])
    );
    assert_eq!(
        resolve_effective_skill_ids(
            true,
            &ids(&["preset", "role"]),
            &ids(&["manual", "preset"]),
            &ids(&["mia-official:officecli", "preset"]),
            &ids(&["preset", "turn"]),
        ),
        ids(&["mia-scheduler", "role", "manual", "preset", "turn"])
    );
    assert!(resolve_effective_skill_ids(false, &[], &[], &[], &[]).is_empty());
}
