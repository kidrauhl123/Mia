//! Typed HTTP and realtime payloads exposed by Mia Rust Core.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub ok: bool,
    pub version: String,
    pub pid: u32,
    pub data_dir: String,
    pub runtime_home: String,
    pub mode: String,
    pub daemon_target: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ListeningEvent {
    pub host: String,
    pub port: u16,
    pub pid: u32,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmptyResponse {
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatusResponse {
    pub ok: bool,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClientSettingsResponse {
    pub settings: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PatchClientSettingsRequest {
    pub patch: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveModelSelectionRequest {
    pub selection: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveModelSelectionResponse {
    pub settings: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsRuntimeControlOptionsRequest {
    #[serde(default)]
    pub active_agent_engine: Option<String>,
    #[serde(default)]
    pub runtime: Value,
    #[serde(default)]
    pub engine_config: Value,
    #[serde(default)]
    pub model_catalog: Value,
    #[serde(default)]
    pub platform_models: Value,
    #[serde(default)]
    pub engine_capabilities: Value,
    #[serde(default)]
    pub codex_models: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsRuntimeControlOptionsResponse {
    pub agent_engine: String,
    pub external_engine: bool,
    pub status_text: String,
    pub model_options: Vec<BotRuntimeControlOption>,
    pub selected_model: String,
    pub selected_model_entry: Option<BotRuntimeControlOption>,
    pub effort_options: Vec<BotRuntimeControlOption>,
    pub selected_effort: String,
    pub permission_options: Vec<BotRuntimeControlOption>,
    pub selected_permission: String,
    pub add_provider_options: Vec<BotRuntimeControlOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSummary {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub enabled: bool,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderListResponse {
    pub providers: Vec<ProviderSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResponse {
    pub provider: ProviderSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateProviderRequest {
    pub id: Option<String>,
    pub kind: String,
    pub display_name: String,
    pub base_url: Option<String>,
    pub api_key_env: Option<String>,
    pub api_key: Option<String>,
    pub api_mode: Option<String>,
    pub auth_type: Option<String>,
    pub models: Vec<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestRequest {
    pub provider_id: Option<String>,
    pub candidate: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResponse {
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveModelRuntimeRequest {
    pub config: Value,
    pub context: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveModelRuntimeResponse {
    pub runtime: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrepareHermesRuntimeConfigRequest {
    pub port: u16,
    pub paths: HermesRuntimeConfigPaths,
    #[serde(default)]
    pub permission_settings: Value,
    #[serde(default)]
    pub effort_settings: Value,
    #[serde(default)]
    pub mia_app_mcp_spec: Value,
    #[serde(default)]
    pub scheduler_mcp_spec: Value,
    #[serde(default)]
    pub user_mcp_specs: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HermesRuntimeConfigPaths {
    pub home: String,
    pub hermes_home: String,
    pub config: String,
    pub api_server_key: String,
    pub bot_manifest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrepareHermesRuntimeConfigResponse {
    pub ok: bool,
    pub config_path: String,
    pub api_server_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceResponse {
    pub path: String,
    pub custom: String,
    pub default: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SaveAgentWorkspaceRequest {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemorySettingsResponse {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SaveMemorySettingsRequest {
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionRule {
    pub id: String,
    pub engine: String,
    pub tool_name: String,
    pub subject_type: String,
    pub subject_value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionRequest {
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub bot_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub preview: Option<String>,
    #[serde(default)]
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionPendingRequest {
    pub request_id: String,
    pub engine: String,
    pub bot_id: String,
    pub session_id: String,
    pub tool_name: String,
    pub title: String,
    pub description: String,
    pub preview: String,
    pub rule: AgentPermissionRule,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionListResponse {
    pub requests: Vec<AgentPermissionPendingRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionRespondRequest {
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionRespondResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionDecisionResponse {
    pub decision: String,
    pub scope: String,
    pub remembered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<AgentPermissionRule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MiaMemoryToolNames {
    pub enabled: bool,
    pub search: String,
    pub remember: String,
    pub update: String,
    pub forget: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MiaSkillToolNames {
    pub list_current: String,
    pub read_current: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MiaContextSnapshotResponse {
    pub user_id: String,
    pub bot_id: String,
    pub session_id: String,
    pub origin_message_id: String,
    pub generated_at: u64,
    pub persona: String,
    pub memory: String,
    pub memory_tools: MiaMemoryToolNames,
    pub skill_tools: MiaSkillToolNames,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MiaCurrentSkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub body_chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MiaCurrentSkillDetail {
    pub id: String,
    pub name: String,
    pub description: String,
    pub body_chars: usize,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MiaCurrentSkillsResponse {
    pub bot_id: String,
    pub skills: Vec<MiaCurrentSkillSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MiaCurrentSkillResponse {
    pub bot_id: String,
    pub skill: MiaCurrentSkillDetail,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MiaMemoryEntry {
    pub id: String,
    pub user_id: String,
    pub bot_id: String,
    pub session_id: String,
    pub scope: String,
    pub text: String,
    pub confidence: f64,
    pub source: String,
    pub origin_engine: String,
    pub origin_native_session_id: String,
    pub source_message_ids: Vec<String>,
    pub linked_memory_ids: Vec<String>,
    pub policy_result: Value,
    pub priority: i64,
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_used_at: String,
    pub expires_at: String,
    pub metadata: Value,
    pub deleted_at: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MiaMemorySearchRequest {
    #[serde(default)]
    pub context: Value,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub include_deleted: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MiaMemorySearchResponse {
    pub memories: Vec<MiaMemoryEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MiaMemoryMutationRequest {
    #[serde(default)]
    pub context: Value,
    #[serde(default)]
    pub memory_id: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub old_text: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub new_text: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub source_message_ids: Vec<String>,
    #[serde(default)]
    pub linked_memory_ids: Vec<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MiaMemoryMutationResponse {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<MiaMemoryEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub matches: Vec<MiaMemoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveAttachmentRequest {
    #[serde(default)]
    pub name: Option<String>,
    pub data_url: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub mime: Option<String>,
    #[serde(default)]
    pub thumbnail_data_url: Option<String>,
    #[serde(default)]
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub preview_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FetchFileAttachmentRequest {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentResponse {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub mime: String,
    pub size: u64,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineModelCatalogResponse {
    pub models: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelListResponse {
    pub models: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapabilitiesResponse {
    pub approval_modes: Vec<String>,
    pub effort_levels: Vec<String>,
    pub engines: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandItem {
    pub command: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandListResponse {
    pub commands: Vec<SlashCommandItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandListRequest {
    pub engine: String,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub home_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandRegistryResponse {
    pub native: Vec<Value>,
    pub built_in: Vec<Value>,
    pub bridge: Vec<Value>,
    pub custom: Vec<Value>,
    pub count: usize,
    pub rows: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandExecuteRequest {
    pub engine: String,
    #[serde(default)]
    pub command_name: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub command_path: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub home_dir: Option<String>,
    #[serde(default)]
    pub context: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandExecuteResponse {
    #[serde(rename = "type")]
    pub kind: String,
    pub command: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_file_includes: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_bash_commands: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotSummary {
    pub id: String,
    pub display_name: String,
    pub identity: Value,
    pub capabilities: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotListResponse {
    pub bots: Vec<BotSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotResponse {
    pub bot: BotSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StarterBotEnsureRequest {
    #[serde(default)]
    pub runtime: Value,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub now: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StarterBotMutation {
    pub engine_id: String,
    pub key: String,
    pub bot: BotSummary,
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StarterBotEnsureResponse {
    pub skipped: bool,
    pub created: Vec<StarterBotMutation>,
    pub updated: Vec<StarterBotMutation>,
    pub settings: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateBotRequest {
    pub display_name: String,
    pub identity: Value,
    pub capabilities: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBotRequest {
    pub display_name: Option<String>,
    pub identity: Option<Value>,
    pub capabilities: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveBotRuntimeRequest {
    pub runtime_kind: String,
    pub provider_connection_id: Option<String>,
    pub model_profile_id: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub target_intent: Option<BotRuntimeTargetIntent>,
    #[serde(default)]
    pub sync_intent: Option<BotRuntimeSyncIntent>,
    #[serde(default)]
    pub control_intent: Option<BotRuntimeControlIntent>,
    #[serde(default)]
    pub config: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeTargetIntent {
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub agent_engine: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeSyncIntent {
    #[serde(default)]
    pub agent_engine: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort_level: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub model_entries: Vec<BotRuntimeModelEntryIntent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeControlIntent {
    pub field: String,
    pub value: String,
    #[serde(default)]
    pub model_entries: Vec<BotRuntimeModelEntryIntent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeModelEntryIntent {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub provider_label: Option<String>,
    #[serde(default)]
    pub auth_type: Option<String>,
    #[serde(default)]
    pub model_profile_id: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeResponse {
    pub bot_id: String,
    pub runtime_kind: String,
    pub binding: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeTargetOptionsRequest {
    #[serde(default)]
    pub bot: Value,
    #[serde(default)]
    pub runtime: Value,
    #[serde(default)]
    pub engine_capabilities: Value,
    #[serde(default)]
    pub preferred_agent_engine: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeTargetOptionsResponse {
    pub active_target: BotRuntimeTargetOption,
    pub runtime_label: String,
    pub runs_on_other_device: bool,
    pub groups: Vec<BotRuntimeTargetGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeTargetGroup {
    pub id: String,
    pub label: String,
    pub status_label: String,
    pub runtime_kind: String,
    pub options: Vec<BotRuntimeTargetOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeTargetOption {
    pub id: String,
    pub runtime_kind: String,
    pub device_id: String,
    pub device_name: String,
    pub agent_engine: String,
    pub label: String,
    pub engine_label: String,
    pub title: String,
    pub icon_kind: String,
    pub selected: bool,
    pub disabled: bool,
    pub disabled_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeControlOptionsRequest {
    #[serde(default)]
    pub runtime_kind: Option<String>,
    #[serde(default)]
    pub bot: Value,
    #[serde(default)]
    pub runtime: Value,
    #[serde(default)]
    pub binding: Value,
    #[serde(default)]
    pub model_catalog: Value,
    #[serde(default)]
    pub platform_models: Value,
    #[serde(default)]
    pub engine_capabilities: Value,
    #[serde(default)]
    pub codex_models: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeControlOptionsResponse {
    pub runtime_kind: String,
    pub agent_engine: String,
    pub status_text: String,
    pub model_options: Vec<BotRuntimeControlOption>,
    pub selected_model: String,
    pub selected_model_entry: Option<BotRuntimeControlOption>,
    pub effort_options: Vec<BotRuntimeControlOption>,
    pub selected_effort: String,
    pub permission_options: Vec<BotRuntimeControlOption>,
    pub selected_permission: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeControlOption {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub value: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub provider: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub provider_connection_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub provider_label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub auth_type: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model_profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotCapabilityOptionsRequest {
    #[serde(default)]
    pub bot: Value,
    #[serde(default)]
    pub available_skills: Vec<BotCapabilitySkillInput>,
    #[serde(default)]
    pub bot_presets: Vec<BotCapabilityPresetInput>,
    #[serde(default)]
    pub intent: Option<BotCapabilityIntent>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotCapabilitySkillInput {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub source: String,
    #[serde(default, alias = "plugin_id")]
    pub plugin_id: String,
    #[serde(default, alias = "market_id")]
    pub market_id: String,
    #[serde(default, alias = "market_name_zh")]
    pub market_name_zh: String,
    #[serde(default, alias = "name_zh")]
    pub name_zh: String,
    #[serde(default, alias = "rel_path")]
    pub rel_path: String,
    #[serde(default)]
    pub engine: String,
    #[serde(default)]
    pub provider: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotCapabilityPresetInput {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub capabilities: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotCapabilityIntent {
    pub capability_type: String,
    pub capability_id: String,
    pub checked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotCapabilityOptionsResponse {
    pub capabilities: Value,
    pub summary: String,
    pub groups: Vec<BotCapabilityGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotCapabilityGroup {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub options: Vec<BotCapabilityOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotCapabilityOption {
    pub id: String,
    pub capability_id: String,
    pub label: String,
    pub source: String,
    pub checked: bool,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnsureBotSessionConversationRequest {
    pub session_id: String,
    pub title: Option<String>,
    pub runtime_kind: Option<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnsureBotSessionConversationResponse {
    pub conversation_id: String,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub bot_id: Option<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationListResponse {
    pub conversations: Vec<ConversationSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationResponse {
    pub conversation: ConversationSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessageSummary {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub body: String,
    pub content: Value,
    pub status: String,
    pub seq: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessageListResponse {
    pub messages: Vec<ConversationMessageSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteConversationResponse {
    pub conversation_id: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateConversationRequest {
    pub kind: String,
    pub title: String,
    pub bot_id: Option<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SendConversationMessageRequest {
    pub body: String,
    pub attachments: Value,
    pub selected_skill_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunConversationUtilityTurnRequest {
    #[serde(default)]
    pub bot_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub purpose: String,
    #[serde(default)]
    pub system_prompt: String,
    pub user_prompt: String,
    #[serde(default)]
    pub selected_skill_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunConversationUtilityTurnResponse {
    pub content: String,
    pub turn_id: String,
    pub engine: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillMaterializationRecord {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillMaterializationRequest {
    #[serde(default)]
    pub available_skills: Vec<SkillMaterializationRecord>,
    #[serde(default)]
    pub active_skill_ids: Vec<String>,
    #[serde(default)]
    pub intent_skill_ids: Vec<String>,
    #[serde(default)]
    pub requested_skill_ids: Vec<String>,
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillMaterializationResponse {
    pub index_block: String,
    pub loaded_block: String,
    pub loaded_skill_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSkillRecord {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub source_path: String,
    #[serde(default)]
    pub link_name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSkillRuntimeRequest {
    #[serde(default)]
    pub agent_engine: String,
    #[serde(default)]
    pub runtime_config: Value,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub session_skill_ids: Vec<String>,
    #[serde(default)]
    pub available_skills: Vec<AgentSessionSkillRecord>,
    #[serde(default)]
    pub active_skill_ids: Vec<String>,
    #[serde(default)]
    pub intent_skill_ids: Vec<String>,
    #[serde(default)]
    pub requested_skill_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSkillRuntimeResponse {
    pub delivery_mode: String,
    pub native_skills_dirs: Vec<String>,
    pub resolved_skill_ids: Vec<String>,
    pub resolved_skills: Vec<AgentSessionSkillRecord>,
    pub turn_selected_skills: Vec<AgentSessionSkillRecord>,
    pub skill_external_dirs: Vec<String>,
    pub skill_fingerprint: String,
    pub selected_skill_prompt: String,
    pub initial_prompt_prefix: String,
    pub skill_materialization: Option<SkillMaterializationResponse>,
    pub managed_skill_targets: Vec<String>,
    pub manifest_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SendConversationMessageResponse {
    pub message_id: String,
    pub turn_id: String,
    pub assistant_message_id: Option<String>,
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskJobSummary {
    pub id: String,
    pub kind: String,
    pub schedule: Value,
    pub target: Value,
    pub instructions: String,
    pub status: String,
    pub next_run_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskJobListResponse {
    pub jobs: Vec<TaskJobSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskJobResponse {
    pub job: TaskJobSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskJobRequest {
    pub kind: String,
    #[serde(default)]
    pub schedule: Option<Value>,
    #[serde(default)]
    pub schedule_intent: Option<TaskScheduleIntent>,
    pub target: Value,
    pub instructions: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskScheduleIntent {
    pub kind: String,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub time: Option<String>,
    #[serde(default)]
    pub weekday: Option<u8>,
    #[serde(default)]
    pub day_of_month: Option<u8>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub time_expression: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskJobRequest {
    pub schedule: Option<Value>,
    #[serde(default)]
    pub schedule_intent: Option<TaskScheduleIntent>,
    pub target: Option<Value>,
    pub instructions: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskJobResponse {
    pub run_id: String,
    pub accepted: bool,
    pub conversation_id: Option<String>,
    pub message_id: Option<String>,
    pub turn_id: Option<String>,
    pub assistant_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSummary {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub native_name: String,
    pub enabled: bool,
    pub transport: Value,
    pub config: Value,
    pub status: String,
    pub last_test_status: String,
    pub last_test_code: Option<Value>,
    pub tools: Vec<Value>,
    pub diagnostics: Value,
    pub oauth: Value,
    pub sync: Value,
    pub source_agent: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub last_checked_at: i64,
    pub last_error: String,
    pub registry_id: String,
    pub source: String,
    pub management_mode: String,
    pub required_inputs: Vec<Value>,
    pub connection_wizard: Value,
    pub managed_runtime: Value,
    pub homepage: String,
    pub setup_hint: String,
    pub setup_commands: Vec<String>,
    pub expected_tool_count: i64,
    pub original_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerListResponse {
    pub servers: Vec<McpServerSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerResponse {
    pub server: McpServerSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateMcpServerRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    pub transport: Value,
    #[serde(default)]
    pub config: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMcpServerRequest {
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub transport: Option<Value>,
    pub config: Option<Value>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerTestResponse {
    pub ok: bool,
    pub tools: Vec<String>,
    pub diagnostic: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthActionResponse {
    pub ok: bool,
    pub auth_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpAgentConfigsResponse {
    pub configs: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatusResponse {
    pub enabled: bool,
    pub connected: bool,
    pub connecting: bool,
    pub url: String,
    pub user: Option<Value>,
    pub account: Option<Value>,
    pub agent_runtime: Option<Value>,
    pub device_id: String,
    pub last_error: String,
    pub logs: Vec<String>,
    pub events: Value,
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudConnectRequest {
    pub url: Option<String>,
    pub token: Option<String>,
    pub account_hint: Option<String>,
    pub user: Option<Value>,
    pub account: Option<Value>,
    pub agent_runtime: Option<Value>,
    pub last_event_seq: Option<i64>,
    pub last_memory_sync_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudConnectResponse {
    pub status: CloudStatusResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudSettingsResponse {
    pub settings: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PutCloudSettingsRequest {
    pub settings: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudMemorySyncRequest {
    #[serde(default)]
    pub full: Option<bool>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudMemorySyncResponse {
    pub ok: bool,
    pub skipped: bool,
    pub pushed: usize,
    pub pulled: usize,
    pub conflicts: usize,
    pub errors: usize,
    pub server_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudBridgeStartRequest {
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub engine: String,
    #[serde(default)]
    pub capabilities: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudBridgeLifecycleResponse {
    pub status: CloudStatusResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudEventsStartRequest {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudEventsLifecycleResponse {
    pub status: CloudStatusResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudBridgeRunRequest {
    #[serde(default)]
    pub run_id: String,
    #[serde(default)]
    pub conversation_id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub attachments: Value,
    #[serde(default)]
    pub bot_id: String,
    #[serde(default)]
    pub bot_name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub agent_engine: Option<String>,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub runtime_config: Value,
    #[serde(default)]
    pub config: Value,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort_level: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudBridgeRunResponse {
    pub ok: bool,
    pub run_id: String,
    pub conversation_id: String,
    pub cloud_conversation_id: String,
    pub message_id: String,
    pub turn_id: String,
    pub assistant_message_id: Option<String>,
    pub text: String,
    pub attachments: Value,
    #[serde(default)]
    pub trace: Value,
    #[serde(default)]
    pub content_blocks: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudBridgeCancelRequest {
    #[serde(default)]
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudBridgeCancelResponse {
    pub ok: bool,
    pub cancelled: bool,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatusChangedEvent {
    pub status: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotUpdatedEvent {
    pub bot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCreatedEvent {
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessageCreatedEvent {
    pub conversation_id: String,
    pub message_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreatedEvent {
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdatedEvent {
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunStartedEvent {
    pub task_id: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunFinishedEvent {
    pub task_id: String,
    pub run_id: String,
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerUpdatedEvent {
    pub server_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatusChangedEvent {
    pub connected: bool,
}
