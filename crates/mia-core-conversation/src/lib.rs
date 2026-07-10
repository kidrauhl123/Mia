//! Conversation and turn orchestration boundary for Mia Rust Core.

use std::collections::{HashSet, hash_map::DefaultHasher};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use mia_core_api_types::{
    AgentSessionSkillRecord, AgentSessionSkillRuntimeRequest, AgentSessionSkillRuntimeResponse,
    BotSummary, ConversationListResponse, ConversationMessageListResponse,
    ConversationMessageSummary, ConversationResponse, ConversationSummary,
    CreateConversationRequest, DeleteConversationResponse, MiaCurrentSkillDetail,
    MiaCurrentSkillResponse, MiaCurrentSkillSummary, MiaCurrentSkillsResponse,
    RunConversationUtilityTurnRequest, SendConversationMessageRequest,
    SendConversationMessageResponse, SkillMaterializationRecord, SkillMaterializationRequest,
    SkillMaterializationResponse, normalize_runtime_mcp_spec,
};
use mia_core_runtime::{RuntimeBuilder, RuntimeTurnInput, RuntimeTurnPlan};
use serde_json::{Map, Value, json};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

pub const EVENT_CONVERSATION_CREATED: &str = "conversation.created";
pub const EVENT_CONVERSATION_MESSAGE_CREATED: &str = "conversation.messageCreated";
const CLIENT_SETTINGS_KEY: &str = "client";
const MANAGED_SKILL_MANIFEST_RELATIVE_PATH: &str = ".mia/skill-runtime.json";
const RESERVED_MCP_SPECS_SETTINGS_KEY: &str = "reservedMcpSpecs";

#[cfg(test)]
mod agent_session_skill_link_test_overrides {
    use std::sync::atomic::{AtomicBool, Ordering};

    static FORCE_SYMLINK_FAILURE: AtomicBool = AtomicBool::new(false);

    pub fn should_force_symlink_failure() -> bool {
        FORCE_SYMLINK_FAILURE.load(Ordering::SeqCst)
    }

    pub struct ForceSymlinkFailureGuard;

    impl Drop for ForceSymlinkFailureGuard {
        fn drop(&mut self) {
            FORCE_SYMLINK_FAILURE.store(false, Ordering::SeqCst);
        }
    }

    pub fn force_symlink_failure() -> ForceSymlinkFailureGuard {
        FORCE_SYMLINK_FAILURE.store(true, Ordering::SeqCst);
        ForceSymlinkFailureGuard
    }
}

#[derive(Clone, Debug)]
pub struct ConversationService {
    pool: SqlitePool,
    runtime: RuntimeBuilder,
}

#[derive(Clone, Debug)]
pub struct CurrentSkillService {
    data_dir: PathBuf,
    official_roots: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AcceptedConversationTurn {
    pub response: SendConversationMessageResponse,
    pub runtime_plan: RuntimeTurnPlan,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompletedRuntimeMessage {
    pub message_id: String,
    pub seq: i64,
    pub body: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CurrentSkillError {
    MissingId,
    NotEnabled(String),
}

impl std::fmt::Display for CurrentSkillError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingId => write!(f, "Skill id is required."),
            Self::NotEnabled(id) => write!(f, "Skill is not enabled for the current bot: {id}"),
        }
    }
}

impl std::error::Error for CurrentSkillError {}

#[derive(Clone, Debug)]
struct SkillSourceRoot {
    root: PathBuf,
    id_prefix: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ParsedCurrentSkill {
    canonical_id: String,
    rel_path: String,
    name: String,
    description: String,
    body: String,
    file_path: PathBuf,
}

impl CurrentSkillService {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            official_roots: discover_official_skill_roots(),
        }
    }

    pub fn with_official_roots(data_dir: PathBuf, official_roots: Vec<PathBuf>) -> Self {
        Self {
            data_dir,
            official_roots,
        }
    }

    pub fn list_current_bot_skills(
        &self,
        bot_id: &str,
        bot: Option<&BotSummary>,
    ) -> MiaCurrentSkillsResponse {
        MiaCurrentSkillsResponse {
            bot_id: clean_or_default(bot_id, "mia"),
            skills: enabled_skill_ids(bot)
                .into_iter()
                .filter_map(|id| {
                    self.resolve_enabled_skill(&id)
                        .map(|skill| public_skill(&id, &skill))
                })
                .collect(),
        }
    }

    pub fn read_current_bot_skill(
        &self,
        bot_id: &str,
        bot: Option<&BotSummary>,
        skill_id: &str,
    ) -> Result<MiaCurrentSkillResponse, CurrentSkillError> {
        let target = clean_text(skill_id);
        if target.is_empty() {
            return Err(CurrentSkillError::MissingId);
        }

        for enabled_id in enabled_skill_ids(bot) {
            let Some(skill) = self.resolve_enabled_skill(&enabled_id) else {
                continue;
            };
            if current_skill_matches(&skill, &enabled_id, &target) {
                return Ok(MiaCurrentSkillResponse {
                    bot_id: clean_or_default(bot_id, "mia"),
                    skill: detailed_skill(&enabled_id, &skill),
                });
            }
        }

        Err(CurrentSkillError::NotEnabled(target))
    }

    fn resolve_enabled_skill(&self, enabled_id: &str) -> Option<ParsedCurrentSkill> {
        let target = clean_text(enabled_id);
        if target.is_empty() {
            return None;
        }
        for source in self.skill_sources() {
            if !source.root.exists() {
                continue;
            }
            for file_path in find_skill_files(&source.root, 8) {
                let Some(skill) = parse_current_skill_file(&file_path, &source) else {
                    continue;
                };
                if current_skill_catalog_matches(&skill, &target) {
                    return Some(skill);
                }
            }
        }
        None
    }

    fn skill_sources(&self) -> Vec<SkillSourceRoot> {
        let mut sources = Vec::new();
        let mut seen = HashSet::new();
        let private_root = self.data_dir.join("skills");
        push_skill_source(&mut sources, &mut seen, private_root, "mia");
        for root in &self.official_roots {
            push_skill_source(&mut sources, &mut seen, root.clone(), "mia-official");
        }
        sources
    }
}

fn push_skill_source(
    sources: &mut Vec<SkillSourceRoot>,
    seen: &mut HashSet<PathBuf>,
    root: PathBuf,
    id_prefix: &str,
) {
    let normalized = root.components().collect::<PathBuf>();
    if seen.insert(normalized.clone()) {
        sources.push(SkillSourceRoot {
            root: normalized,
            id_prefix: id_prefix.to_string(),
        });
    }
}

pub fn discover_official_skill_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut seen = HashSet::new();

    if let Some(value) = std::env::var_os("MIA_OFFICIAL_SKILLS_DIR") {
        for root in std::env::split_paths(&value) {
            push_discovered_root(&mut roots, &mut seen, root);
        }
    }

    if let Ok(current_dir) = std::env::current_dir() {
        push_discovered_root(
            &mut roots,
            &mut seen,
            current_dir.join("skills").join("_builtin"),
        );
        push_discovered_root(
            &mut roots,
            &mut seen,
            current_dir
                .join("resources")
                .join("skills")
                .join("_builtin"),
        );
    }

    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(repo_root) = manifest_root.parent().and_then(Path::parent) {
        push_discovered_root(
            &mut roots,
            &mut seen,
            repo_root.join("skills").join("_builtin"),
        );
    }

    if let Ok(exe) = std::env::current_exe()
        && let Some(exe_dir) = exe.parent()
    {
        push_discovered_root(
            &mut roots,
            &mut seen,
            exe_dir.join("skills").join("_builtin"),
        );
        if let Some(resources_dir) = exe_dir.parent().and_then(Path::parent) {
            push_discovered_root(
                &mut roots,
                &mut seen,
                resources_dir.join("skills").join("_builtin"),
            );
        }
    }

    roots
}

fn push_discovered_root(roots: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, root: PathBuf) {
    let normalized = root.components().collect::<PathBuf>();
    if seen.insert(normalized.clone()) {
        roots.push(normalized);
    }
}

fn enabled_skill_ids(bot: Option<&BotSummary>) -> Vec<String> {
    let Some(bot) = bot else {
        return Vec::new();
    };
    let mut ids = string_list_field(&bot.capabilities, &["enabledSkills", "enabled_skills"]);
    let disabled = string_list_field(&bot.capabilities, &["disabledSkills", "disabled_skills"]);
    if !disabled.is_empty() {
        ids.retain(|id| !disabled.iter().any(|disabled_id| disabled_id == id));
    }
    unique_strings(ids)
}

fn string_list_field(value: &Value, keys: &[&str]) -> Vec<String> {
    if let Some(array) = value.as_array() {
        return clean_string_array(array);
    }
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    for key in keys {
        if let Some(array) = object.get(*key).and_then(Value::as_array) {
            return clean_string_array(array);
        }
    }
    Vec::new()
}

fn clean_string_array(values: &[Value]) -> Vec<String> {
    values
        .iter()
        .filter_map(Value::as_str)
        .map(clean_text)
        .filter(|value| !value.is_empty())
        .collect()
}

fn find_skill_files(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    let mut files = Vec::new();
    walk_skill_files(root, 0, max_depth, &mut files);
    files.sort();
    files
}

fn walk_skill_files(dir: &Path, depth: usize, max_depth: usize, files: &mut Vec<PathBuf>) {
    if depth > max_depth {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_file() && entry.file_name() == "SKILL.md" {
            files.push(path);
        } else if file_type.is_dir()
            && !ignored_skill_dir_name(&entry.file_name().to_string_lossy())
        {
            walk_skill_files(&path, depth + 1, max_depth, files);
        }
    }
}

fn ignored_skill_dir_name(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "__pycache__")
}

fn parse_current_skill_file(
    file_path: &Path,
    source: &SkillSourceRoot,
) -> Option<ParsedCurrentSkill> {
    let raw = fs::read_to_string(file_path).ok()?;
    let skill_dir = file_path.parent()?;
    let rel_path = path_to_slash(skill_dir.strip_prefix(&source.root).ok()?);
    if rel_path.is_empty() {
        return None;
    }
    let fallback_name = skill_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&rel_path);
    let (frontmatter, body) = split_skill_frontmatter(&raw);
    let name = yaml_scalar(frontmatter, "name").unwrap_or_else(|| fallback_name.to_string());
    let description = yaml_scalar(frontmatter, "description")
        .or_else(|| first_body_paragraph(body))
        .unwrap_or_default();
    Some(ParsedCurrentSkill {
        canonical_id: format!("{}:{rel_path}", source.id_prefix),
        rel_path,
        name,
        description,
        body: raw.trim().to_string(),
        file_path: file_path.to_path_buf(),
    })
}

fn split_skill_frontmatter(raw: &str) -> (&str, &str) {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return ("", raw);
    }
    let after_open = &trimmed[3..];
    let Some(close_idx) = after_open.find("\n---") else {
        return ("", raw);
    };
    let frontmatter = &after_open[..close_idx];
    let body_start = close_idx + 4;
    let body = after_open
        .get(body_start..)
        .unwrap_or_default()
        .trim_start_matches(['\r', '\n']);
    (frontmatter, body)
}

fn yaml_scalar(frontmatter: &str, key: &str) -> Option<String> {
    for line in frontmatter.lines() {
        let Some((left, right)) = line.split_once(':') else {
            continue;
        };
        if left.trim() == key {
            let value = right.trim().trim_matches(['"', '\'']).trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn first_body_paragraph(body: &str) -> Option<String> {
    body.split("\n\n")
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))
        .find(|value| !value.is_empty())
}

fn path_to_slash(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn current_skill_matches(skill: &ParsedCurrentSkill, enabled_id: &str, target: &str) -> bool {
    let target = clean_text(target);
    if target.is_empty() {
        return false;
    }
    if clean_text(enabled_id) == target {
        return true;
    }
    current_skill_catalog_matches(skill, &target)
}

fn current_skill_catalog_matches(skill: &ParsedCurrentSkill, target: &str) -> bool {
    let target = clean_text(target);
    if target.is_empty() {
        return false;
    }
    let basename = skill
        .file_path
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    [
        skill.canonical_id.clone(),
        skill.name.clone(),
        format!(
            "{}:{}",
            skill.canonical_id.split(':').next().unwrap_or_default(),
            skill.rel_path
        ),
        basename,
    ]
    .into_iter()
    .any(|alias| clean_text(&alias) == target)
}

fn public_skill(enabled_id: &str, skill: &ParsedCurrentSkill) -> MiaCurrentSkillSummary {
    MiaCurrentSkillSummary {
        id: clean_or_default(enabled_id, &skill.canonical_id),
        name: clean_or_default(&skill.name, enabled_id),
        description: clean_text(&skill.description),
        body_chars: skill.body.chars().count(),
    }
}

fn detailed_skill(enabled_id: &str, skill: &ParsedCurrentSkill) -> MiaCurrentSkillDetail {
    let summary = public_skill(enabled_id, skill);
    MiaCurrentSkillDetail {
        id: summary.id,
        name: summary.name,
        description: summary.description,
        body_chars: summary.body_chars,
        body: skill.body.clone(),
    }
}

fn clean_or_default(value: &str, default: &str) -> String {
    let value = clean_text(value);
    if value.is_empty() {
        default.to_string()
    } else {
        value
    }
}

pub fn materialize_turn_skills(
    request: SkillMaterializationRequest,
) -> SkillMaterializationResponse {
    let records = request
        .available_skills
        .into_iter()
        .filter_map(normalize_skill_record)
        .collect::<Vec<_>>();
    let load_ids = unique_strings(
        request
            .active_skill_ids
            .into_iter()
            .chain(request.intent_skill_ids)
            .chain(request.requested_skill_ids),
    );
    let mut loaded = Vec::new();
    let mut seen_loaded = Vec::new();
    for id in load_ids {
        let Some(skill) = records
            .iter()
            .find(|record| skill_record_matches(record, &id) && !seen_loaded.contains(&record.id))
            .cloned()
        else {
            continue;
        };
        seen_loaded.push(skill.id.clone());
        loaded.push(skill);
    }

    SkillMaterializationResponse {
        index_block: if clean_text(request.mode.as_deref().unwrap_or("index")) == "none" {
            String::new()
        } else {
            build_skill_index_block(&records)
        },
        loaded_block: build_loaded_skill_blocks(&loaded),
        loaded_skill_ids: loaded.into_iter().map(|skill| skill.id).collect(),
    }
}

pub fn plan_agent_session_skill_runtime(
    request: AgentSessionSkillRuntimeRequest,
) -> AgentSessionSkillRuntimeResponse {
    let AgentSessionSkillRuntimeRequest {
        agent_engine,
        runtime_config,
        workspace_path,
        session_skill_ids,
        available_skills,
        active_skill_ids,
        intent_skill_ids,
        requested_skill_ids,
    } = request;
    let engine = normalize_agent_engine(&agent_engine);
    let native_skills_dirs = resolve_native_skills_dirs(&engine, &runtime_config);
    let delivery_mode = if native_skills_dirs.is_some() {
        "native-link"
    } else {
        "prompt-fallback"
    };
    let native_skills_dirs = native_skills_dirs.unwrap_or_default();
    let mut all_skills = available_skills
        .into_iter()
        .filter_map(normalize_agent_session_skill_record)
        .collect::<Vec<_>>();
    all_skills.sort_by(|left, right| {
        agent_session_skill_sort_key(left).cmp(&agent_session_skill_sort_key(right))
    });
    let mut resolved_skills = resolve_agent_session_session_skills(&session_skill_ids, &all_skills);
    resolved_skills.sort_by(|left, right| {
        agent_session_skill_sort_key(left).cmp(&agent_session_skill_sort_key(right))
    });
    let resolved_skill_ids = resolved_skills
        .iter()
        .map(|skill| skill.id.clone())
        .collect::<Vec<_>>();
    let turn_selected_skills =
        resolve_agent_session_selected_skills(&active_skill_ids, &all_skills);
    let skill_external_dirs = if engine == "hermes" {
        unique_strings(
            resolved_skills
                .iter()
                .map(|skill| skill.source_path.clone()),
        )
    } else {
        Vec::new()
    };
    let skill_materialization = if delivery_mode == "prompt-fallback" {
        Some(materialize_turn_skills(SkillMaterializationRequest {
            available_skills: resolved_skills
                .iter()
                .map(|skill| SkillMaterializationRecord {
                    id: skill.id.clone(),
                    name: skill.name.clone(),
                    description: first_non_empty([
                        skill.description.as_str(),
                        skill.summary.as_str(),
                    ]),
                    body: skill.body.clone(),
                })
                .collect(),
            active_skill_ids: Vec::new(),
            intent_skill_ids,
            requested_skill_ids,
            mode: Some("index".to_string()),
        }))
    } else {
        None
    };
    let skill_fingerprint = agent_session_skill_fingerprint(
        delivery_mode,
        &native_skills_dirs,
        &resolved_skills,
        &skill_external_dirs,
    );
    let (manifest_path, managed_skill_targets) = reconcile_agent_session_workspace_skills(
        workspace_path.as_deref().unwrap_or_default(),
        delivery_mode,
        &native_skills_dirs,
        &resolved_skills,
        &skill_fingerprint,
    );

    AgentSessionSkillRuntimeResponse {
        delivery_mode: delivery_mode.to_string(),
        native_skills_dirs,
        resolved_skill_ids,
        resolved_skills,
        turn_selected_skills: turn_selected_skills.clone(),
        skill_external_dirs,
        skill_fingerprint,
        selected_skill_prompt: build_selected_skill_prompt(&turn_selected_skills),
        initial_prompt_prefix: String::new(),
        skill_materialization,
        managed_skill_targets,
        manifest_path,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NormalizedSkillRecord {
    id: String,
    name: String,
    description: String,
    body: String,
}

fn normalize_agent_session_skill_record(
    record: AgentSessionSkillRecord,
) -> Option<AgentSessionSkillRecord> {
    let id = first_clean([record.id.as_str(), record.name.as_str()])?;
    let name = first_non_empty([record.name.as_str(), id.as_str()]);
    let display_name = first_non_empty([
        record.display_name.as_str(),
        record.name.as_str(),
        id.as_str(),
    ]);
    let summary = first_non_empty([record.summary.as_str(), record.description.as_str()]);
    let source_path = clean_text(&record.source_path);
    let link_name = first_non_empty([
        record.link_name.as_str(),
        id.split(':').next_back().unwrap_or(id.as_str()),
        name.as_str(),
    ]);
    Some(AgentSessionSkillRecord {
        id,
        name,
        display_name,
        description: clean_text(&record.description),
        summary,
        body: clean_text(&record.body),
        source_path,
        link_name,
    })
}

fn agent_session_skill_sort_key(record: &AgentSessionSkillRecord) -> String {
    format!(
        "{}\n{}\n{}",
        record.id, record.link_name, record.source_path
    )
}

fn normalize_skill_record(record: SkillMaterializationRecord) -> Option<NormalizedSkillRecord> {
    let id = first_clean([record.id.as_str(), record.name.as_str()])?;
    let name = clean_text(if record.name.trim().is_empty() {
        &id
    } else {
        &record.name
    });
    Some(NormalizedSkillRecord {
        id,
        name,
        description: clean_text(&record.description),
        body: clean_text(&record.body),
    })
}

fn first_non_empty<const N: usize>(values: [&str; N]) -> String {
    first_clean(values).unwrap_or_default()
}

fn first_clean<const N: usize>(values: [&str; N]) -> Option<String> {
    values
        .into_iter()
        .map(clean_text)
        .find(|value| !value.is_empty())
}

fn clean_text(value: &str) -> String {
    value.trim().to_string()
}

fn normalize_agent_engine(value: &str) -> String {
    let id = clean_text(value).to_lowercase().replace('_', "-");
    match id.as_str() {
        "claude" | "claude-code" => "claude-code".to_string(),
        "codex" | "openai-codex" => "codex".to_string(),
        "hermes" | "" => "hermes".to_string(),
        _ => "hermes".to_string(),
    }
}

fn resolve_native_skills_dirs(engine: &str, runtime_config: &Value) -> Option<Vec<String>> {
    if let Some(value) = find_native_skills_dirs_override(runtime_config) {
        return normalize_native_skills_dirs_value(value);
    }
    match engine {
        "claude-code" => Some(vec![".claude/skills".to_string()]),
        "codex" => Some(vec![".codex/skills".to_string()]),
        _ => Some(Vec::new()),
    }
}

fn find_native_skills_dirs_override(value: &Value) -> Option<&Value> {
    let obj = value.as_object()?;
    for key in ["nativeSkillsDirs", "native_skills_dirs"] {
        if let Some(found) = obj.get(key) {
            return Some(found);
        }
    }
    for key in [
        "agentMetadata",
        "agent_metadata",
        "engineMetadata",
        "engine_metadata",
        "engineConfig",
        "engine_config",
    ] {
        if let Some(found) = obj.get(key).and_then(find_native_skills_dirs_override) {
            return Some(found);
        }
    }
    None
}

fn normalize_native_skills_dirs_value(value: &Value) -> Option<Vec<String>> {
    if value.is_null() {
        return None;
    }
    if let Some(text) = value.as_str() {
        let text = clean_text(text);
        if text.is_empty() {
            return Some(Vec::new());
        }
        return Some(vec![text]);
    }
    let Some(items) = value.as_array() else {
        return Some(Vec::new());
    };
    Some(unique_strings(items.iter().map(|item| {
        item.as_str()
            .map(clean_text)
            .unwrap_or_else(|| clean_text(&item.to_string()))
    })))
}

fn unique_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        let id = clean_text(&value);
        if !id.is_empty() && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

fn normalize_managed_targets(values: impl IntoIterator<Item = String>) -> Vec<String> {
    unique_strings(
        values
            .into_iter()
            .map(|value| clean_text(&value).replace('\\', "/")),
    )
}

fn managed_manifest_path(workspace_path: &Path) -> PathBuf {
    workspace_path.join(MANAGED_SKILL_MANIFEST_RELATIVE_PATH)
}

fn read_managed_manifest_targets(manifest_path: &Path) -> Vec<String> {
    let Ok(raw) = fs::read_to_string(manifest_path) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(targets) = parsed.get("managedTargets").and_then(Value::as_array) else {
        return Vec::new();
    };
    normalize_managed_targets(targets.iter().map(|target| {
        target
            .as_str()
            .map(clean_text)
            .unwrap_or_else(|| clean_text(&target.to_string()))
    }))
}

fn relative_skill_target_path(native_skills_dir: &str, link_name: &str) -> String {
    Path::new(native_skills_dir)
        .join(link_name)
        .to_string_lossy()
        .replace('\\', "/")
}

fn path_for_compare(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn target_path_matches_source(target_path: &Path, source_path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(target_path) else {
        return false;
    };
    if !metadata.file_type().is_symlink() {
        return false;
    }
    let Ok(linked_target) = fs::read_link(target_path) else {
        return false;
    };
    let resolved_linked_target = if linked_target.is_absolute() {
        linked_target
    } else {
        target_path
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join(linked_target)
    };
    path_for_compare(&resolved_linked_target) == path_for_compare(source_path)
}

fn remove_managed_path(path: &Path) {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    let file_type = metadata.file_type();
    if file_type.is_dir() && !file_type.is_symlink() {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

#[cfg(unix)]
fn symlink_skill_dir(source_path: &Path, target_path: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if agent_session_skill_link_test_overrides::should_force_symlink_failure() {
        return Err(std::io::Error::other("forced symlink failure"));
    }
    std::os::unix::fs::symlink(source_path, target_path)
}

#[cfg(windows)]
fn symlink_skill_dir(source_path: &Path, target_path: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if agent_session_skill_link_test_overrides::should_force_symlink_failure() {
        return Err(std::io::Error::other("forced symlink failure"));
    }
    std::os::windows::fs::symlink_dir(source_path, target_path)
}

fn copy_dir_recursive(source_path: &Path, target_path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(target_path)?;
    for entry in fs::read_dir(source_path)? {
        let entry = entry?;
        let source_child = entry.path();
        let target_child = target_path.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_child)?;
        if metadata.file_type().is_dir() {
            copy_dir_recursive(&source_child, &target_child)?;
        } else {
            fs::copy(&source_child, &target_child)?;
        }
    }
    Ok(())
}

fn link_skill_dir_or_copy(source_path: &Path, target_path: &Path) -> bool {
    if symlink_skill_dir(source_path, target_path).is_ok() {
        return true;
    }
    if target_path.exists() {
        remove_managed_path(target_path);
    }
    copy_dir_recursive(source_path, target_path).is_ok()
}

fn ensure_managed_skill_link(
    target_path: &Path,
    source_path: &Path,
    target_relative_path: &str,
    previous_managed_targets: &HashSet<String>,
) -> bool {
    if !source_path.is_dir() {
        return false;
    }
    if target_path_matches_source(target_path, source_path) {
        return true;
    }
    if fs::symlink_metadata(target_path).is_ok() {
        if !previous_managed_targets.contains(target_relative_path) {
            return false;
        }
        remove_managed_path(target_path);
    }
    let Some(parent) = target_path.parent() else {
        return false;
    };
    if fs::create_dir_all(parent).is_err() {
        return false;
    }
    link_skill_dir_or_copy(source_path, target_path)
}

fn write_managed_skill_manifest(
    manifest_path: &Path,
    skill_fingerprint: &str,
    managed_targets: &[String],
) {
    let Some(parent) = manifest_path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(body) = serde_json::to_string_pretty(&json!({
        "skillFingerprint": clean_text(skill_fingerprint),
        "managedTargets": managed_targets,
    })) else {
        return;
    };
    let _ = fs::write(manifest_path, format!("{body}\n"));
}

fn reconcile_agent_session_workspace_skills(
    workspace_path: &str,
    delivery_mode: &str,
    native_skills_dirs: &[String],
    resolved_skills: &[AgentSessionSkillRecord],
    skill_fingerprint: &str,
) -> (String, Vec<String>) {
    let workspace_path = clean_text(workspace_path);
    if workspace_path.is_empty() {
        return (String::new(), Vec::new());
    }
    let workspace = PathBuf::from(workspace_path);
    let manifest_path = managed_manifest_path(&workspace);
    let previous_targets = read_managed_manifest_targets(&manifest_path);
    let previous_target_set = previous_targets.iter().cloned().collect::<HashSet<_>>();
    let mut managed_targets = Vec::new();

    if delivery_mode == "native-link" {
        for native_skills_dir in native_skills_dirs {
            let native_skills_dir = clean_text(native_skills_dir);
            if native_skills_dir.is_empty() {
                continue;
            }
            if fs::create_dir_all(workspace.join(&native_skills_dir)).is_err() {
                continue;
            }
            let mut seen_targets = HashSet::new();
            for skill in resolved_skills {
                if skill.source_path.is_empty() || skill.link_name.is_empty() {
                    continue;
                }
                let target_relative_path =
                    relative_skill_target_path(&native_skills_dir, &skill.link_name);
                if !seen_targets.insert(target_relative_path.clone()) {
                    continue;
                }
                let target_path = workspace.join(&target_relative_path);
                let source_path = PathBuf::from(&skill.source_path);
                if ensure_managed_skill_link(
                    &target_path,
                    &source_path,
                    &target_relative_path,
                    &previous_target_set,
                ) {
                    managed_targets.push(target_relative_path);
                }
            }
        }
    }

    let next_targets = normalize_managed_targets(managed_targets);
    for target_relative_path in previous_targets {
        if next_targets.contains(&target_relative_path) {
            continue;
        }
        remove_managed_path(&workspace.join(target_relative_path));
    }
    write_managed_skill_manifest(&manifest_path, skill_fingerprint, &next_targets);

    (manifest_path.to_string_lossy().to_string(), next_targets)
}

fn agent_session_skill_aliases(record: &AgentSessionSkillRecord) -> Vec<String> {
    unique_strings([
        record.id.clone(),
        record.name.clone(),
        record
            .id
            .split(':')
            .next_back()
            .unwrap_or(record.id.as_str())
            .to_string(),
    ])
}

fn resolve_agent_session_session_skills(
    skill_ids: &[String],
    records: &[AgentSessionSkillRecord],
) -> Vec<AgentSessionSkillRecord> {
    let targets = unique_strings(skill_ids.iter().cloned());
    if targets.is_empty() {
        return records.to_vec();
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for record in records {
        if !agent_session_skill_aliases(record)
            .into_iter()
            .any(|alias| targets.contains(&alias))
        {
            continue;
        }
        if seen.insert(record.id.clone()) {
            out.push(record.clone());
        }
    }
    out
}

fn resolve_agent_session_selected_skills(
    skill_ids: &[String],
    records: &[AgentSessionSkillRecord],
) -> Vec<AgentSessionSkillRecord> {
    let mut out = Vec::new();
    let mut seen = Vec::new();
    for skill_id in skill_ids {
        let target = clean_text(skill_id);
        if target.is_empty() {
            continue;
        }
        let Some(record) = records.iter().find(|record| {
            agent_session_skill_aliases(record)
                .into_iter()
                .any(|alias| alias == target)
        }) else {
            continue;
        };
        if seen.contains(&record.id) {
            continue;
        }
        seen.push(record.id.clone());
        out.push(record.clone());
    }
    out
}

fn escape_xml_text(value: &str) -> String {
    clean_text(value)
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn skill_markdown_path(skill: &AgentSessionSkillRecord) -> String {
    let source_path = clean_text(&skill.source_path).replace('\\', "/");
    if source_path.is_empty() {
        String::new()
    } else {
        format!("{}/SKILL.md", source_path.trim_end_matches('/'))
    }
}

fn build_selected_skill_prompt(skills: &[AgentSessionSkillRecord]) -> String {
    let mut paths = Vec::new();
    for skill in skills {
        let path = skill_markdown_path(skill);
        if path.is_empty() || paths.contains(&path) {
            continue;
        }
        paths.push(path);
    }
    if paths.is_empty() {
        return String::new();
    }
    let mut lines = vec!["<selected_skill_paths>".to_string()];
    lines.extend(
        paths
            .into_iter()
            .map(|path| format!("  <path>{}</path>", escape_xml_text(&path))),
    );
    lines.push("</selected_skill_paths>".to_string());
    lines.join("\n")
}

fn agent_session_skill_fingerprint(
    delivery_mode: &str,
    native_skills_dirs: &[String],
    resolved_skills: &[AgentSessionSkillRecord],
    skill_external_dirs: &[String],
) -> String {
    let payload = format!(
        "{}\n{}\n{}\n{}",
        delivery_mode,
        native_skills_dirs.join("\n"),
        resolved_skills
            .iter()
            .map(|skill| format!(
                "{}\t{}\t{}\t{}\t{}",
                skill.id,
                skill.name,
                skill.link_name,
                skill.source_path,
                stable_short_hash(&skill.body)
            ))
            .collect::<Vec<_>>()
            .join("\n"),
        skill_external_dirs.join("\n")
    );
    stable_short_hash(&payload)
}

fn stable_short_hash(value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn skill_record_matches(record: &NormalizedSkillRecord, skill_id: &str) -> bool {
    let target = clean_text(skill_id);
    !target.is_empty()
        && skill_record_aliases(record)
            .into_iter()
            .any(|alias| alias == target)
}

fn skill_record_aliases(record: &NormalizedSkillRecord) -> Vec<String> {
    unique_strings([
        record.id.clone(),
        record.name.clone(),
        record
            .id
            .split(':')
            .next_back()
            .unwrap_or(record.id.as_str())
            .to_string(),
        if record.id.contains(':') {
            String::new()
        } else {
            format!("mia:{}", record.id)
        },
    ])
}

fn build_skill_index_block(records: &[NormalizedSkillRecord]) -> String {
    if records.is_empty() {
        return String::new();
    }
    let mut lines = vec![
        "## Available Mia Skills".to_string(),
        String::new(),
        "These are capability indexes available to the current Mia bot. Use a skill only when the user's request clearly matches it, and do not repeat this index to the user.".to_string(),
        "If completing the current request requires a full skill guide that is not loaded yet, output only `[LOAD_SKILL: skill-id]`; Mia will load it and continue the turn.".to_string(),
        String::new(),
    ];
    lines.extend(records.iter().map(|skill| {
        let label = if skill.id == skill.name {
            skill.id.clone()
        } else {
            format!("{} ({})", skill.id, skill.name)
        };
        format!(
            "- {label}: {}",
            if skill.description.is_empty() {
                "No description."
            } else {
                skill.description.as_str()
            }
        )
    }));
    lines.join("\n")
}

fn build_loaded_skill_blocks(records: &[NormalizedSkillRecord]) -> String {
    let blocks = records
        .iter()
        .filter(|skill| !skill.body.is_empty())
        .map(|skill| {
            format!(
                "=== Skill: {} ===\n{}\n=== End Skill ===",
                skill.name, skill.body
            )
        })
        .collect::<Vec<_>>();
    if blocks.is_empty() {
        return String::new();
    }
    [
        "## Loaded Mia Skill Guides".to_string(),
        String::new(),
        "The following skills were explicitly selected by the user, matched by intent, or loaded after a `[LOAD_SKILL: skill-id]` request. Use them only when needed for the current request, and do not explain internal skill selection to the user.".to_string(),
        String::new(),
        blocks.join("\n\n"),
    ]
    .join("\n")
}

impl ConversationService {
    pub fn new(pool: SqlitePool) -> Self {
        Self::with_runtime(pool, RuntimeBuilder::new(""))
    }

    pub fn with_runtime(pool: SqlitePool, runtime: RuntimeBuilder) -> Self {
        Self { pool, runtime }
    }

    pub async fn list_conversations(&self) -> Result<ConversationListResponse, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, kind, title, bot_id, metadata_json FROM conversations ORDER BY updated_at DESC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(ConversationListResponse {
            conversations: rows
                .into_iter()
                .map(conversation_summary_from_row)
                .collect::<Result<Vec<_>, _>>()?,
        })
    }

    pub async fn create_conversation(
        &self,
        request: CreateConversationRequest,
    ) -> Result<ConversationResponse, sqlx::Error> {
        let id = format!("conv_{}", Uuid::now_v7().simple());
        let now = now_ms();
        sqlx::query(
            "INSERT INTO conversations (id, kind, title, bot_id, runtime_json, metadata_json, created_at, updated_at) \
             VALUES (?, ?, ?, ?, '{}', ?, ?, ?)",
        )
        .bind(&id)
        .bind(&request.kind)
        .bind(&request.title)
        .bind(&request.bot_id)
        .bind(request.metadata.to_string())
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_conversation(&id).await
    }

    pub async fn ensure_external_conversation(
        &self,
        conversation_id: &str,
        kind: &str,
        title: &str,
        bot_id: Option<&str>,
        metadata: Value,
    ) -> Result<ConversationResponse, sqlx::Error> {
        let id = clean_or_default(conversation_id, "cloud_bridge_default");
        let kind = clean_or_default(kind, "cloud-bridge");
        let title = clean_or_default(title, "Cloud Bridge");
        let now = now_ms();
        sqlx::query(
            "INSERT INTO conversations (id, kind, title, bot_id, runtime_json, metadata_json, created_at, updated_at) \
             VALUES (?, ?, ?, ?, '{}', ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, bot_id = excluded.bot_id, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at",
        )
        .bind(&id)
        .bind(&kind)
        .bind(&title)
        .bind(bot_id.filter(|value| !value.trim().is_empty()))
        .bind(metadata.to_string())
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_conversation(&id).await
    }

    pub async fn get_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<ConversationResponse, sqlx::Error> {
        let row = sqlx::query(
            "SELECT id, kind, title, bot_id, metadata_json FROM conversations WHERE id = ?",
        )
        .bind(conversation_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(ConversationResponse {
            conversation: conversation_summary_from_row(row)?,
        })
    }

    pub async fn list_conversation_messages(
        &self,
        conversation_id: &str,
        since_seq: i64,
        limit: i64,
    ) -> Result<ConversationMessageListResponse, sqlx::Error> {
        self.get_conversation(conversation_id).await?;
        let capped_limit = limit.clamp(1, 500);
        let rows = sqlx::query(
            "SELECT id, conversation_id, role, body, content_json, status, seq, created_at, updated_at \
             FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
        )
        .bind(conversation_id)
        .bind(since_seq.max(0))
        .bind(capped_limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(ConversationMessageListResponse {
            messages: rows
                .into_iter()
                .map(conversation_message_from_row)
                .collect::<Result<Vec<_>, _>>()?,
        })
    }

    pub async fn delete_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<DeleteConversationResponse, sqlx::Error> {
        let result = sqlx::query("DELETE FROM conversations WHERE id = ?")
            .bind(conversation_id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(sqlx::Error::RowNotFound);
        }
        Ok(DeleteConversationResponse {
            conversation_id: conversation_id.to_string(),
            deleted: true,
        })
    }

    pub async fn send_user_message(
        &self,
        conversation_id: &str,
        request: SendConversationMessageRequest,
    ) -> Result<SendConversationMessageResponse, sqlx::Error> {
        Ok(self
            .start_user_turn(conversation_id, request)
            .await?
            .response)
    }

    pub async fn start_user_turn(
        &self,
        conversation_id: &str,
        request: SendConversationMessageRequest,
    ) -> Result<AcceptedConversationTurn, sqlx::Error> {
        let conversation = self.get_conversation(conversation_id).await?.conversation;
        let next_seq: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(&self.pool)
        .await?;
        let message_id = format!("msg_{}", Uuid::now_v7().simple());
        let now = now_ms();
        let content = json!({
            "attachments": request.attachments,
            "selectedSkillIds": request.selected_skill_ids,
        });
        insert_message(
            &self.pool,
            InsertMessage {
                id: &message_id,
                conversation_id,
                role: "user",
                body: &request.body,
                content,
                status: "accepted",
                seq: next_seq,
                now,
            },
        )
        .await?;

        let runtime_config = runtime_config_for_turn(&self.pool, &conversation).await?;
        let engine = runtime_engine_from_config(&runtime_config)
            .or_else(|| runtime_engine_from_metadata(&conversation.metadata));
        let previous_session_key = runtime_session_key_from_metadata(&conversation.metadata);
        let provider = runtime_provider_with_controls(
            provider_for_runtime_config(&self.pool, &runtime_config, engine.as_deref()).await?,
            &runtime_config,
        );
        let mcp_servers = mcp_servers_for_turn(&self.pool).await?;
        let turn_plan = self.runtime.build_turn_plan(RuntimeTurnInput {
            conversation_id: conversation_id.to_string(),
            message_id: message_id.clone(),
            bot_id: conversation.bot_id.clone(),
            engine,
            previous_session_key,
            workspace_dir: workspace_from_metadata(&conversation.metadata),
            provider,
            mcp_servers,
            attachments: request.attachments.clone(),
            selected_skill_ids: request.selected_skill_ids,
            body: request.body,
        });
        let turn_id = turn_plan.turn_id.clone();
        let assistant_message_id = if let Some(mock_response) = turn_plan.mock_response.as_deref() {
            let assistant_message_id = format!("msg_{}", Uuid::now_v7().simple());
            insert_message(
                &self.pool,
                InsertMessage {
                    id: &assistant_message_id,
                    conversation_id,
                    role: "assistant",
                    body: mock_response,
                    content: json!({
                        "turnId": turn_id,
                        "engine": turn_plan.engine,
                        "runtimePlan": runtime_plan_for_storage(&turn_plan),
                    }),
                    status: "complete",
                    seq: next_seq + 1,
                    now,
                },
            )
            .await?;
            Some(assistant_message_id)
        } else {
            None
        };
        sqlx::query("UPDATE conversations SET updated_at = ? WHERE id = ?")
            .bind(now)
            .bind(conversation_id)
            .execute(&self.pool)
            .await?;
        let response = SendConversationMessageResponse {
            message_id,
            turn_id,
            assistant_message_id,
            accepted: true,
        };
        Ok(AcceptedConversationTurn {
            response,
            runtime_plan: turn_plan,
        })
    }

    pub async fn plan_utility_turn(
        &self,
        request: RunConversationUtilityTurnRequest,
    ) -> Result<RuntimeTurnPlan, sqlx::Error> {
        let bot_id = request
            .bot_id
            .as_deref()
            .map(clean_text)
            .filter(|value| !value.is_empty());
        let runtime_config = match bot_id.as_deref() {
            Some(bot_id) => bot_runtime_binding(&self.pool, bot_id)
                .await?
                .unwrap_or_else(|| json!({})),
            None => json!({}),
        };
        let engine = runtime_engine_from_config(&runtime_config);
        let provider = runtime_provider_with_controls(
            provider_for_runtime_config(&self.pool, &runtime_config, engine.as_deref()).await?,
            &runtime_config,
        );
        let mcp_servers = mcp_servers_for_turn(&self.pool).await?;
        Ok(self.runtime.build_turn_plan(RuntimeTurnInput {
            conversation_id: utility_conversation_id(request.conversation_id.as_deref()),
            message_id: format!("msg_{}", Uuid::now_v7().simple()),
            bot_id,
            engine,
            previous_session_key: None,
            workspace_dir: String::new(),
            provider,
            mcp_servers,
            attachments: json!([]),
            selected_skill_ids: request.selected_skill_ids,
            body: utility_prompt_body(&request.system_prompt, &request.user_prompt),
        }))
    }

    pub async fn plan_runtime_session(
        &self,
        conversation_id: &str,
    ) -> Result<RuntimeTurnPlan, sqlx::Error> {
        let conversation = self.get_conversation(conversation_id).await?.conversation;
        let runtime_config = runtime_config_for_turn(&self.pool, &conversation).await?;
        let engine = runtime_engine_from_config(&runtime_config)
            .or_else(|| runtime_engine_from_metadata(&conversation.metadata));
        let provider = runtime_provider_with_controls(
            provider_for_runtime_config(&self.pool, &runtime_config, engine.as_deref()).await?,
            &runtime_config,
        );
        let mcp_servers = mcp_servers_for_turn(&self.pool).await?;
        Ok(self.runtime.build_turn_plan(RuntimeTurnInput {
            conversation_id: conversation_id.to_string(),
            message_id: format!("runtime_prepare_{}", Uuid::now_v7().simple()),
            bot_id: conversation.bot_id,
            engine,
            previous_session_key: runtime_session_key_from_metadata(&conversation.metadata),
            workspace_dir: workspace_from_metadata(&conversation.metadata),
            provider,
            mcp_servers,
            attachments: json!([]),
            selected_skill_ids: Vec::new(),
            body: String::new(),
        }))
    }

    pub async fn complete_runtime_turn(
        &self,
        conversation_id: &str,
        turn_id: &str,
        body: &str,
        runtime: Value,
    ) -> Result<CompletedRuntimeMessage, sqlx::Error> {
        let next_seq: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(&self.pool)
        .await?;
        let message_id = format!("msg_{}", Uuid::now_v7().simple());
        let now = now_ms();
        let runtime_session_metadata =
            runtime_session_metadata_from_runtime(conversation_id, &runtime, now);
        insert_message(
            &self.pool,
            InsertMessage {
                id: &message_id,
                conversation_id,
                role: "assistant",
                body,
                content: json!({
                    "turnId": turn_id,
                    "runtime": runtime,
                }),
                status: "complete",
                seq: next_seq,
                now,
            },
        )
        .await?;
        if let Some(runtime_session_metadata) = runtime_session_metadata {
            persist_runtime_session_metadata(
                &self.pool,
                conversation_id,
                runtime_session_metadata,
                now,
            )
            .await?;
        } else {
            sqlx::query("UPDATE conversations SET updated_at = ? WHERE id = ?")
                .bind(now)
                .bind(conversation_id)
                .execute(&self.pool)
                .await?;
        }
        Ok(CompletedRuntimeMessage {
            message_id,
            seq: next_seq,
            body: body.to_string(),
            created_at: now,
        })
    }
}

fn utility_conversation_id(value: Option<&str>) -> String {
    let value = value.map(clean_text).unwrap_or_default();
    if value.is_empty() {
        format!("utility_{}", Uuid::now_v7().simple())
    } else {
        value
    }
}

fn utility_prompt_body(system_prompt: &str, user_prompt: &str) -> String {
    let system_prompt = clean_text(system_prompt);
    let user_prompt = clean_text(user_prompt);
    if system_prompt.is_empty() {
        user_prompt
    } else if user_prompt.is_empty() {
        system_prompt
    } else {
        format!("{system_prompt}\n\n{user_prompt}")
    }
}

struct InsertMessage<'a> {
    id: &'a str,
    conversation_id: &'a str,
    role: &'a str,
    body: &'a str,
    content: Value,
    status: &'a str,
    seq: i64,
    now: i64,
}

async fn insert_message(pool: &SqlitePool, params: InsertMessage<'_>) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, body, content_json, status, seq, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(params.id)
    .bind(params.conversation_id)
    .bind(params.role)
    .bind(params.body)
    .bind(params.content.to_string())
    .bind(params.status)
    .bind(params.seq)
    .bind(params.now)
    .bind(params.now)
    .execute(pool)
    .await?;
    Ok(())
}

fn runtime_engine_from_metadata(metadata: &Value) -> Option<String> {
    metadata
        .get("runtime")
        .and_then(|runtime| runtime.get("engine"))
        .or_else(|| metadata.get("engine"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn runtime_engine_from_config(config: &Value) -> Option<String> {
    first_string(
        config,
        &[
            "engine",
            "agentEngine",
            "agent_engine",
            "runtimeEngine",
            "runtime_engine",
        ],
    )
}

fn workspace_from_metadata(metadata: &Value) -> String {
    metadata
        .get("workspaceDir")
        .or_else(|| metadata.get("workspace_dir"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn runtime_session_key_from_metadata(metadata: &Value) -> Option<String> {
    metadata
        .get("runtimeSession")
        .and_then(|session| session.get("sessionKey"))
        .and_then(Value::as_str)
        .or_else(|| metadata.get("sessionKey").and_then(Value::as_str))
        .map(clean_text)
        .filter(|value| !value.is_empty())
}

fn runtime_session_metadata_from_runtime(
    conversation_id: &str,
    runtime: &Value,
    now: i64,
) -> Option<Value> {
    let session = runtime.get("runtimeSession")?;
    let session_key = session
        .get("sessionKey")
        .and_then(Value::as_str)
        .map(clean_text)
        .filter(|value| !value.is_empty())?;
    let engine = session
        .get("engine")
        .and_then(Value::as_str)
        .map(clean_text)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "mock-agent".to_string());
    let mut metadata = json!({
        "conversationId": conversation_id,
        "engine": engine,
        "sessionKey": session_key,
        "updatedAt": now,
    });
    if let Some(resume_session_key) = session
        .get("resumeSessionKey")
        .and_then(Value::as_str)
        .map(clean_text)
        .filter(|value| !value.is_empty())
    {
        metadata["resumeSessionKey"] = Value::String(resume_session_key);
    }
    if let Some(resumed) = session.get("resumed").and_then(Value::as_bool) {
        metadata["resumed"] = Value::Bool(resumed);
    }
    Some(metadata)
}

async fn persist_runtime_session_metadata(
    pool: &SqlitePool,
    conversation_id: &str,
    runtime_session: Value,
    now: i64,
) -> Result<(), sqlx::Error> {
    let row = sqlx::query("SELECT metadata_json FROM conversations WHERE id = ?")
        .bind(conversation_id)
        .fetch_one(pool)
        .await?;
    let mut metadata = parse_json(row.get::<String, _>("metadata_json"))?;
    if !metadata.is_object() {
        metadata = json!({});
    }
    metadata["runtimeSession"] = runtime_session;
    sqlx::query("UPDATE conversations SET metadata_json = ?, updated_at = ? WHERE id = ?")
        .bind(metadata.to_string())
        .bind(now)
        .bind(conversation_id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn runtime_config_for_turn(
    pool: &SqlitePool,
    conversation: &ConversationSummary,
) -> Result<Value, sqlx::Error> {
    let mut config = match conversation.bot_id.as_deref() {
        Some(bot_id) => bot_runtime_binding(pool, bot_id)
            .await?
            .unwrap_or_else(|| json!({})),
        None => json!({}),
    };
    if let Some(runtime) = conversation
        .metadata
        .get("runtime")
        .filter(|value| value.is_object())
    {
        merge_json(&mut config, runtime.clone());
    }
    if let Some(provider) = conversation.metadata.get("provider")
        && let Value::Object(config) = &mut config
    {
        config.insert("provider".into(), provider.clone());
    }
    Ok(config)
}

async fn bot_runtime_binding(
    pool: &SqlitePool,
    bot_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT binding_json FROM bot_runtime_bindings WHERE bot_id = ? \
         ORDER BY CASE runtime_kind WHEN 'desktop-local' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END \
         LIMIT 1",
    )
    .bind(bot_id)
    .fetch_optional(pool)
    .await?;
    row.map(|row| parse_json(row.get::<String, _>("binding_json")).map(runtime_config_from_binding))
        .transpose()
}

fn runtime_config_from_binding(binding: Value) -> Value {
    let mut config = binding
        .get("config")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    merge_json(&mut config, binding);
    if let Value::Object(object) = &mut config {
        object.remove("config");
    }
    config
}

async fn provider_for_runtime_config(
    pool: &SqlitePool,
    config: &Value,
    engine: Option<&str>,
) -> Result<Value, sqlx::Error> {
    if let Some(provider) = config.get("provider").filter(|value| value.is_object()) {
        return Ok(provider.clone());
    }
    if is_mia_managed_reference(config)
        || local_agent_defaults_to_mia(config, engine.unwrap_or_default())
    {
        return Ok(mia_managed_provider_reference(config));
    }
    if native_cli_default(config, engine.unwrap_or_default()) {
        return Ok(native_cli_provider_reference(
            config,
            engine.unwrap_or_default(),
        ));
    }
    let provider_id = explicit_provider_connection_id(config)
        .or_else(|| provider_from_profile_id(config))
        .or_else(|| first_string(config, &["provider", "modelProvider", "model_provider"]));
    let Some(provider_id) = provider_id else {
        return Ok(json!({}));
    };
    let row = sqlx::query(
        "SELECT kind, display_name, base_url, api_key_env, encrypted_api_key, api_mode, auth_type, enabled \
         FROM providers WHERE id = ?",
    )
    .bind(&provider_id)
    .fetch_optional(pool)
    .await?
    .ok_or(sqlx::Error::RowNotFound)?;
    if row.get::<i64, _>("enabled") == 0 {
        return Err(sqlx::Error::RowNotFound);
    }
    let model = first_string(config, &["model"]).unwrap_or_default();
    let model_profile_id = first_string(config, &["modelProfileId", "model_profile_id"])
        .unwrap_or_else(|| {
            if model.is_empty() {
                provider_id.clone()
            } else {
                format!("{provider_id}:{model}")
            }
        });
    Ok(json!({
        "provider": row.get::<String, _>("kind"),
        "providerConnectionId": provider_id,
        "providerLabel": row.get::<String, _>("display_name"),
        "authType": row.get::<String, _>("auth_type"),
        "model": model,
        "modelProfileId": model_profile_id,
        "apiKeyEnv": row.get::<Option<String>, _>("api_key_env").unwrap_or_default(),
        "apiKey": row.get::<Option<String>, _>("encrypted_api_key").unwrap_or_default(),
        "baseUrl": row.get::<Option<String>, _>("base_url").unwrap_or_default(),
        "apiMode": row.get::<Option<String>, _>("api_mode").unwrap_or_default(),
        "managedByMia": false,
        "source": "mia-core"
    }))
}

fn runtime_provider_with_controls(mut provider: Value, config: &Value) -> Value {
    if !provider.is_object() {
        provider = json!({});
    }
    let Value::Object(provider) = &mut provider else {
        return provider;
    };
    for keys in [
        &["model"][..],
        &["effortLevel", "effort_level"][..],
        &["permissionMode", "permission_mode"][..],
    ] {
        let Some(value) = first_string(config, keys) else {
            continue;
        };
        let canonical = match keys[0] {
            "effortLevel" => "effortLevel",
            "permissionMode" => "permissionMode",
            other => other,
        };
        provider.insert(canonical.to_string(), Value::String(value));
    }
    Value::Object(provider.clone())
}

fn merge_json(target: &mut Value, patch: Value) {
    match (target, patch) {
        (Value::Object(target), Value::Object(patch)) => merge_object(target, patch),
        (target, patch) => *target = patch,
    }
}

fn merge_object(target: &mut Map<String, Value>, patch: Map<String, Value>) {
    for (key, value) in patch {
        if value.is_null() {
            target.remove(&key);
            continue;
        }
        match (target.get_mut(&key), value) {
            (Some(existing @ Value::Object(_)), Value::Object(next)) => {
                if let Value::Object(existing) = existing {
                    merge_object(existing, next);
                }
            }
            (_, value) => {
                target.insert(key, value);
            }
        }
    }
}

fn first_string(source: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| source.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn explicit_provider_connection_id(config: &Value) -> Option<String> {
    first_string(config, &["providerConnectionId", "provider_connection_id"])
}

fn provider_from_profile_id(config: &Value) -> Option<String> {
    let profile_id = first_string(
        config,
        &[
            "modelProfileId",
            "model_profile_id",
            "profileId",
            "profile_id",
        ],
    )?;
    let index = profile_id.find(':')?;
    (index > 0).then(|| profile_id[..index].to_string())
}

fn is_mia_managed_reference(config: &Value) -> bool {
    explicit_provider_connection_id(config).as_deref() == Some("mia")
        || provider_from_profile_id(config).as_deref() == Some("mia")
        || first_string(config, &["provider", "modelProvider", "model_provider"]).as_deref()
            == Some("mia")
        || first_string(config, &["authType", "auth_type"]).as_deref() == Some("mia_account")
        || first_string(config, &["model"])
            .is_some_and(|model| matches!(model.as_str(), "mia-auto" | "mia-default"))
}

fn local_agent_defaults_to_mia(config: &Value, engine: &str) -> bool {
    if !matches!(engine, "hermes" | "claude-code" | "codex") {
        return false;
    }
    explicit_provider_connection_id(config).is_none()
        && provider_from_profile_id(config).is_none()
        && first_string(config, &["provider", "modelProvider", "model_provider"]).is_none()
        && first_string(config, &["model"]).is_none()
}

fn mia_managed_provider_reference(config: &Value) -> Value {
    let model = first_string(config, &["model"]).unwrap_or_else(|| "mia-auto".to_string());
    json!({
        "provider": "mia",
        "providerConnectionId": "mia",
        "providerLabel": "Mia",
        "authType": "mia_account",
        "model": model,
        "modelProfileId": format!("mia:{model}"),
        "managedByMia": true,
        "requiresCloud": true,
        "source": "mia-core"
    })
}

fn native_cli_default(config: &Value, engine: &str) -> bool {
    if !matches!(engine, "codex" | "claude-code") {
        return false;
    }
    let provider = explicit_provider_connection_id(config)
        .or_else(|| provider_from_profile_id(config))
        .or_else(|| first_string(config, &["provider", "modelProvider", "model_provider"]))
        .unwrap_or_default();
    provider.is_empty()
        || provider == engine
        || (engine == "codex" && provider == "openai-codex")
        || (engine == "claude-code" && provider == "anthropic")
}

fn native_cli_provider_reference(config: &Value, engine: &str) -> Value {
    let model = first_string(config, &["model"]).unwrap_or_default();
    let provider = if engine == "codex" {
        "codex"
    } else if engine == "claude-code" {
        "anthropic"
    } else {
        engine
    };
    let model_profile_id = first_string(config, &["modelProfileId", "model_profile_id"])
        .unwrap_or_else(|| {
            if model.is_empty() {
                provider.to_string()
            } else {
                format!("{provider}:{model}")
            }
        });
    json!({
        "provider": provider,
        "providerConnectionId": provider,
        "model": model,
        "modelProfileId": model_profile_id,
        "managedByMia": false,
        "nativeCli": true,
        "source": "mia-core"
    })
}

async fn mcp_servers_for_turn(pool: &SqlitePool) -> Result<Value, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT name, config_json FROM mcp_servers \
         WHERE enabled = 1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC",
    )
    .fetch_all(pool)
    .await?;
    let mut servers = Map::new();
    for row in rows {
        let config = parse_json(row.get::<String, _>("config_json"))?;
        let name = config
            .get("nativeName")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| stable_native_name(row.get::<String, _>("name").as_str()));
        if matches!(name.as_str(), "mia-app" | "mia-scheduler") {
            continue;
        }
        let transport = config
            .get("transport")
            .cloned()
            .unwrap_or_else(|| json!({}));
        servers.insert(name, transport);
    }
    let reserved = reserved_mcp_specs_for_turn(pool).await?;
    if let Some(spec) = reserved_runtime_mcp_spec(&reserved, &["miaApp", "mia-app"]) {
        servers.insert("mia-app".into(), spec);
    }
    if let Some(spec) =
        reserved_runtime_mcp_spec(&reserved, &["scheduler", "miaScheduler", "mia-scheduler"])
    {
        servers.insert("mia-scheduler".into(), spec);
    }
    Ok(json!({
        "mcpServers": Value::Object(servers.clone()),
        "mcp_servers": Value::Object(servers),
    }))
}

async fn reserved_mcp_specs_for_turn(pool: &SqlitePool) -> Result<Value, sqlx::Error> {
    let row = sqlx::query("SELECT value_json FROM settings WHERE key = ?")
        .bind(CLIENT_SETTINGS_KEY)
        .fetch_optional(pool)
        .await?;
    let Some(row) = row else {
        return Ok(json!({}));
    };
    let settings = parse_json(row.get::<String, _>("value_json"))?;
    Ok(settings
        .get(RESERVED_MCP_SPECS_SETTINGS_KEY)
        .cloned()
        .unwrap_or_else(|| json!({})))
}

fn reserved_runtime_mcp_spec(source: &Value, keys: &[&str]) -> Option<Value> {
    keys.iter()
        .find_map(|key| source.get(*key))
        .and_then(normalize_runtime_mcp_spec)
}

fn runtime_plan_for_storage(plan: &RuntimeTurnPlan) -> Value {
    let mut value = serde_json::to_value(plan).unwrap_or_else(|_| json!({}));
    if let Some(object) = value.as_object_mut()
        && let Some(mcp_servers) = object.get_mut("mcpServers")
    {
        *mcp_servers = redact_value("", mcp_servers);
    }
    value
}

fn stable_native_name(name: &str) -> String {
    let mut out = String::new();
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "mcp_server".to_string()
    } else {
        trimmed
    }
}

fn redact_value(key: &str, value: &Value) -> Value {
    match value {
        Value::String(text) => {
            if is_sensitive_key(key) && !text.is_empty() {
                Value::String("\u{2022}\u{2022}\u{2022}\u{2022}".to_string())
            } else {
                Value::String(text.clone())
            }
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| redact_value("", item)).collect())
        }
        Value::Object(object) => {
            let mut redacted = Map::new();
            for (key, value) in object {
                redacted.insert(key.clone(), redact_value(key, value));
            }
            Value::Object(redacted)
        }
        other => other.clone(),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("authorization")
        || lower.contains("token")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("api_key")
        || lower.contains("apikey")
}

fn conversation_summary_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> Result<ConversationSummary, sqlx::Error> {
    Ok(ConversationSummary {
        id: row.get("id"),
        kind: row.get("kind"),
        title: row.get("title"),
        bot_id: row.get("bot_id"),
        metadata: parse_json(row.get::<String, _>("metadata_json"))?,
    })
}

fn conversation_message_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> Result<ConversationMessageSummary, sqlx::Error> {
    Ok(ConversationMessageSummary {
        id: row.get("id"),
        conversation_id: row.get("conversation_id"),
        role: row.get("role"),
        body: row.get("body"),
        content: parse_json(row.get::<String, _>("content_json"))?,
        status: row.get("status"),
        seq: row.get("seq"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

fn parse_json(raw: String) -> Result<Value, sqlx::Error> {
    serde_json::from_str(&raw).map_err(|error| sqlx::Error::Decode(Box::new(error)))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mia_core_api_types::AgentSessionSkillRecord;

    #[test]
    fn agent_session_skill_link_falls_back_to_recursive_copy_when_symlink_fails() {
        let _guard = agent_session_skill_link_test_overrides::force_symlink_failure();
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let source_pdf = temp.path().join("source-pdf");
        fs::create_dir_all(source_pdf.join("nested")).unwrap();
        fs::write(source_pdf.join("SKILL.md"), "# PDF").unwrap();
        fs::write(source_pdf.join("nested").join("data.txt"), "payload").unwrap();

        let result = plan_agent_session_skill_runtime(AgentSessionSkillRuntimeRequest {
            agent_engine: "codex".into(),
            runtime_config: json!({}),
            workspace_path: Some(workspace.to_string_lossy().to_string()),
            session_skill_ids: vec!["pdf".into()],
            available_skills: vec![AgentSessionSkillRecord {
                id: "pdf".into(),
                name: "pdf".into(),
                display_name: "PDF".into(),
                description: "PDF guide".into(),
                summary: "PDF guide".into(),
                body: "# PDF".into(),
                source_path: source_pdf.to_string_lossy().to_string(),
                link_name: "pdf".into(),
            }],
            active_skill_ids: vec![],
            intent_skill_ids: vec![],
            requested_skill_ids: vec![],
        });

        let copied_pdf = workspace.join(".codex/skills/pdf");
        assert!(copied_pdf.is_dir());
        assert!(
            !fs::symlink_metadata(&copied_pdf)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read_to_string(copied_pdf.join("SKILL.md")).unwrap(),
            "# PDF"
        );
        assert_eq!(
            fs::read_to_string(copied_pdf.join("nested").join("data.txt")).unwrap(),
            "payload"
        );
        assert_eq!(result.managed_skill_targets, vec![".codex/skills/pdf"]);
    }
}
