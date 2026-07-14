//! System settings and provider/model ownership for Mia Rust Core.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use mia_core_api_types::{
    AgentPermissionDecisionResponse, AgentPermissionListResponse, AgentPermissionPendingRequest,
    AgentPermissionRequest, AgentPermissionRespondRequest, AgentPermissionRespondResponse,
    AgentPermissionRule, AgentWorkspaceResponse, BotRuntimeControlOption, ClientSettingsResponse,
    CreateProviderRequest, MemoryMode, MemorySettingsResponse, PrepareHermesRuntimeConfigRequest,
    PrepareHermesRuntimeConfigResponse, ProviderListResponse, ProviderResponse, ProviderSummary,
    ProviderTestResponse, ResolveModelRuntimeResponse, SaveAgentWorkspaceRequest,
    SaveMemorySettingsRequest, SaveModelSelectionRequest, SaveModelSelectionResponse,
    SettingsRuntimeControlOptionsRequest, SettingsRuntimeControlOptionsResponse,
    SystemStatusResponse, normalize_runtime_mcp_spec,
};
use mia_core_db::{
    CreateProviderParams, IProviderRepository, ISettingsRepository, ProviderRecord,
    SqliteProviderRepository, SqliteSettingsRepository,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const CLIENT_SETTINGS_KEY: &str = "client";
const HERMES_SKILL_DIRECTORY_ENV: &str = "${MIA_HERMES_SKILLS_DIR}";

#[derive(Debug, thiserror::Error)]
pub enum SystemError {
    #[error("invalid system input: {0}")]
    InvalidInput(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Yaml(#[from] serde_yaml::Error),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Clone)]
pub struct SystemService {
    version: String,
    settings: SqliteSettingsRepository,
    providers: SqliteProviderRepository,
}

#[derive(Debug, Clone)]
pub struct AgentPermissionService {
    settings: SqliteSettingsRepository,
    pending: Arc<Mutex<HashMap<String, AgentPermissionPendingRequest>>>,
}

impl SystemService {
    pub fn new(
        version: String,
        settings: SqliteSettingsRepository,
        providers: SqliteProviderRepository,
    ) -> Self {
        Self {
            version,
            settings,
            providers,
        }
    }

    pub fn status(&self) -> SystemStatusResponse {
        SystemStatusResponse {
            ok: true,
            version: self.version.clone(),
        }
    }

    pub async fn client_settings(&self) -> Result<ClientSettingsResponse, sqlx::Error> {
        Ok(ClientSettingsResponse {
            settings: self
                .settings
                .get_json(CLIENT_SETTINGS_KEY)
                .await?
                .unwrap_or_else(|| json!({})),
        })
    }

    pub async fn patch_client_settings(
        &self,
        patch: Value,
    ) -> Result<ClientSettingsResponse, sqlx::Error> {
        let mut current = self.client_settings().await?.settings;
        merge_json(&mut current, patch);
        self.settings
            .set_json(CLIENT_SETTINGS_KEY, current.clone(), now_ms())
            .await?;
        Ok(ClientSettingsResponse { settings: current })
    }

    pub async fn agent_workspace(
        &self,
        default_workspace: &Path,
    ) -> Result<AgentWorkspaceResponse, sqlx::Error> {
        let settings = self.client_settings().await?.settings;
        Ok(agent_workspace_snapshot(
            agent_workspace_custom_path(&settings),
            default_workspace,
        ))
    }

    pub async fn save_agent_workspace(
        &self,
        request: SaveAgentWorkspaceRequest,
        default_workspace: &Path,
    ) -> Result<AgentWorkspaceResponse, sqlx::Error> {
        let custom = request
            .path
            .or(request.workspace_path)
            .unwrap_or_default()
            .trim()
            .to_string();
        let mut current = self.client_settings().await?.settings;
        merge_json(
            &mut current,
            json!({
                "agentWorkspace": {
                    "path": custom,
                },
            }),
        );
        self.settings
            .set_json(CLIENT_SETTINGS_KEY, current.clone(), now_ms())
            .await?;
        Ok(agent_workspace_snapshot(
            agent_workspace_custom_path(&current),
            default_workspace,
        ))
    }

    pub async fn memory_settings(&self) -> Result<MemorySettingsResponse, sqlx::Error> {
        let settings = self.client_settings().await?.settings;
        Ok(memory_settings_snapshot(&settings))
    }

    pub async fn save_memory_settings(
        &self,
        request: SaveMemorySettingsRequest,
    ) -> Result<MemorySettingsResponse, sqlx::Error> {
        let mut current = self.client_settings().await?.settings;
        let mode = request.mode.unwrap_or_else(|| match request.enabled {
            Some(false) => MemoryMode::Native,
            Some(true) => MemoryMode::Mia,
            None => memory_settings_snapshot(&current).mode,
        });
        merge_json(
            &mut current,
            json!({
                "memory": {
                    "mode": mode,
                    "enabled": mode == MemoryMode::Mia,
                },
            }),
        );
        self.settings
            .set_json(CLIENT_SETTINGS_KEY, current.clone(), now_ms())
            .await?;
        Ok(memory_settings_snapshot(&current))
    }

    pub async fn save_model_selection(
        &self,
        request: SaveModelSelectionRequest,
    ) -> Result<SaveModelSelectionResponse, SystemError> {
        if !request.selection.is_object() {
            return Err(SystemError::InvalidInput(
                "model selection must be an object".into(),
            ));
        }
        if let Some(provider_request) = provider_request_from_model_selection(&request.selection)? {
            self.create_provider(provider_request).await?;
        }

        let compact = compact_model_selection(&request.selection);
        let mut current = self.client_settings().await?.settings;
        merge_json(&mut current, model_settings_client_patch(&compact));
        self.settings
            .set_json(CLIENT_SETTINGS_KEY, current, now_ms())
            .await?;
        Ok(SaveModelSelectionResponse { settings: compact })
    }

    pub async fn list_providers(&self) -> Result<ProviderListResponse, sqlx::Error> {
        let records = self.providers.list().await?;
        Ok(ProviderListResponse {
            providers: records
                .into_iter()
                .map(provider_summary_from_record)
                .collect(),
        })
    }

    pub async fn create_provider(
        &self,
        request: CreateProviderRequest,
    ) -> Result<ProviderResponse, SystemError> {
        let id = request
            .id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("provider_{}", Uuid::now_v7().simple()));
        let kind = clean_required(&request.kind, "kind")?;
        let display_name = clean_required(&request.display_name, "displayName")?;
        let models_json = Value::Array(request.models.into_iter().map(Value::String).collect());
        let record = self
            .providers
            .create(CreateProviderParams {
                id: &id,
                kind: &kind,
                display_name: &display_name,
                base_url: request.base_url.as_deref(),
                api_key_env: request.api_key_env.as_deref(),
                encrypted_api_key: request.api_key.as_deref(),
                api_mode: request.api_mode.as_deref(),
                auth_type: request.auth_type.as_deref(),
                models_json,
                enabled: request.enabled.unwrap_or(true),
                now_ms: now_ms(),
            })
            .await?;
        Ok(ProviderResponse {
            provider: provider_summary_from_record(record),
        })
    }

    pub async fn test_provider(
        &self,
        provider_id: Option<String>,
        candidate: Value,
    ) -> Result<ProviderTestResponse, sqlx::Error> {
        let kind = candidate
            .get("kind")
            .and_then(Value::as_str)
            .or_else(|| candidate.get("provider").and_then(Value::as_str))
            .unwrap_or("provider")
            .to_string();
        if let Some(provider_id) = provider_id.as_deref() {
            let exists = self
                .providers
                .list()
                .await?
                .into_iter()
                .any(|provider| provider.id == provider_id);
            if !exists {
                return Ok(ProviderTestResponse {
                    ok: false,
                    message: Some(format!("provider '{provider_id}' was not found")),
                });
            }
        }
        Ok(ProviderTestResponse {
            ok: true,
            message: Some(format!(
                "{kind} provider configuration accepted by Mia Rust Core"
            )),
        })
    }

    pub async fn resolve_model_runtime(
        &self,
        config: Value,
        context: Value,
    ) -> Result<ResolveModelRuntimeResponse, SystemError> {
        if !config.is_object() {
            return Ok(ResolveModelRuntimeResponse { runtime: None });
        }
        if is_mia_managed_reference(&config) {
            return Ok(ResolveModelRuntimeResponse {
                runtime: Some(to_mia_managed_reference(&config)),
            });
        }
        if native_cli_default(&config, &context) {
            return Ok(ResolveModelRuntimeResponse { runtime: None });
        }
        let explicit_provider_id = explicit_provider_connection_id(&config);
        let profile_provider_id = provider_from_profile_id(&config);
        let provider_id = explicit_provider_id
            .clone()
            .or(profile_provider_id.clone())
            .or_else(|| first_string(&config, &["provider", "modelProvider", "model_provider"]));
        let Some(provider_id) = provider_id else {
            return Ok(ResolveModelRuntimeResponse { runtime: None });
        };
        let record = self
            .providers
            .find_by_id(&provider_id)
            .await?
            .ok_or_else(|| {
                SystemError::InvalidInput(format!(
                    "provider connection '{provider_id}' is not available"
                ))
            })?;
        if !record.enabled {
            return Err(SystemError::InvalidInput(format!(
                "provider connection '{provider_id}' is disabled"
            )));
        }
        let model = first_string(&config, &["model"]).unwrap_or_default();
        let model_profile_id = first_string(&config, &["modelProfileId", "model_profile_id"])
            .unwrap_or_else(|| {
                if model.is_empty() {
                    provider_id.clone()
                } else {
                    format!("{provider_id}:{model}")
                }
            });
        Ok(ResolveModelRuntimeResponse {
            runtime: Some(json!({
                "provider": record.kind,
                "providerConnectionId": provider_id,
                "providerLabel": record.display_name,
                "authType": record.auth_type,
                "model": model,
                "modelProfileId": model_profile_id,
                "apiKeyEnv": record.api_key_env.unwrap_or_default(),
                "apiKey": record.encrypted_api_key.unwrap_or_default(),
                "baseUrl": record.base_url.unwrap_or_default(),
                "apiMode": record.api_mode.unwrap_or_default(),
                "managedByMia": false,
                "source": "mia-core"
            })),
        })
    }

    pub async fn prepare_hermes_runtime_config(
        &self,
        request: PrepareHermesRuntimeConfigRequest,
    ) -> Result<PrepareHermesRuntimeConfigResponse, SystemError> {
        if request.port == 0 {
            return Err(SystemError::InvalidInput(
                "Hermes API server port must be greater than zero".into(),
            ));
        }
        let config_path = clean_required(&request.paths.config, "config")?;
        let api_server_key_path = clean_required(&request.paths.api_server_key, "apiServerKey")?;
        let home_path = clean_required(&request.paths.home, "home")?;
        let bot_manifest_path = clean_required(&request.paths.bot_manifest, "botManifest")?;
        let api_server_key = ensure_api_server_key(&PathBuf::from(&api_server_key_path))?;
        let mut config = read_yaml_json(&PathBuf::from(&config_path))?;
        let client_settings = self.client_settings().await?.settings;
        let runtime_settings = self
            .resolve_hermes_runtime_settings(&client_settings)
            .await?;

        apply_hermes_model_config(&mut config, &runtime_settings);
        apply_hermes_api_server_config(&mut config, request.port, &api_server_key);
        apply_hermes_agent_config(
            &mut config,
            &request.permission_settings,
            &request.effort_settings,
        );
        apply_hermes_mcp_config(&mut config, &request.user_mcp_specs);
        apply_hermes_mia_metadata(&mut config, &home_path, &bot_manifest_path);

        atomic_write_yaml(&PathBuf::from(&config_path), &config)?;
        Ok(PrepareHermesRuntimeConfigResponse {
            ok: true,
            config_path,
            api_server_key,
        })
    }

    async fn resolve_hermes_runtime_settings(
        &self,
        settings: &Value,
    ) -> Result<Value, SystemError> {
        if !has_model_runtime_settings(settings) {
            return Ok(json!({}));
        }
        let response = self
            .resolve_model_runtime(settings.clone(), json!({ "engine": "hermes" }))
            .await?;
        Ok(match response.runtime {
            Some(runtime) if runtime.is_object() => merge_runtime_settings(settings, &runtime),
            _ => settings.clone(),
        })
    }

    pub fn runtime_control_options(
        &self,
        request: SettingsRuntimeControlOptionsRequest,
    ) -> SettingsRuntimeControlOptionsResponse {
        settings_runtime_control_options(request)
    }
}

fn ensure_api_server_key(path: &Path) -> Result<String, SystemError> {
    if path.exists() {
        return Ok(fs::read_to_string(path)?.trim().to_string());
    }
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }
    let key = new_api_server_key();
    write_private_file(path, format!("{key}\n").as_bytes())?;
    Ok(key)
}

fn new_api_server_key() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(now.to_le_bytes());
    hasher.update(Uuid::now_v7().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true).mode(0o600);
        std::io::Write::write_all(&mut options.open(path)?, bytes)?;
    }
    #[cfg(not(unix))]
    {
        fs::write(path, bytes)?;
    }
    Ok(())
}

fn read_yaml_json(path: &Path) -> Result<Value, SystemError> {
    match fs::read_to_string(path) {
        Ok(raw) => {
            let parsed = serde_yaml::from_str::<Value>(&raw).unwrap_or_else(|_| json!({}));
            Ok(if parsed.is_object() {
                parsed
            } else {
                json!({})
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(error.into()),
    }
}

fn atomic_write_yaml(path: &Path, value: &Value) -> Result<(), SystemError> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }
    let content = serde_yaml::to_string(value)?;
    let tmp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config.yaml"),
        std::process::id()
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true).mode(0o600);
        std::io::Write::write_all(&mut options.open(&tmp)?, content.as_bytes())?;
    }
    #[cfg(not(unix))]
    {
        fs::write(&tmp, content)?;
    }
    fs::rename(tmp, path)?;
    Ok(())
}

fn merge_runtime_settings(settings: &Value, runtime: &Value) -> Value {
    let mut merged = settings.as_object().cloned().unwrap_or_default();
    if let Some(runtime) = runtime.as_object() {
        for (key, value) in runtime {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

fn object_mut(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = json!({});
    }
    value
        .as_object_mut()
        .expect("value was normalized to object")
}

fn child_object_mut<'a>(
    parent: &'a mut Map<String, Value>,
    key: &str,
) -> &'a mut Map<String, Value> {
    let needs_object = parent.get(key).and_then(Value::as_object).is_none();
    if needs_object {
        parent.insert(key.into(), json!({}));
    }
    parent
        .get_mut(key)
        .and_then(Value::as_object_mut)
        .expect("child value was normalized to object")
}

fn has_model_runtime_settings(settings: &Value) -> bool {
    first_string(
        settings,
        &[
            "provider",
            "kind",
            "providerConnectionId",
            "provider_connection_id",
            "modelProfileId",
            "model_profile_id",
            "model",
            "apiKey",
            "api_key",
            "baseUrl",
            "base_url",
            "apiMode",
            "api_mode",
        ],
    )
    .is_some()
}

fn apply_hermes_model_config(config: &mut Value, settings: &Value) {
    if !has_model_runtime_settings(settings) {
        clear_stale_mia_owned_model_config(config);
        return;
    }

    let provider = first_string(settings, &["provider"]).unwrap_or_default();
    let model = first_string(settings, &["model"]).unwrap_or_default();
    let api_key_env = first_string(settings, &["apiKeyEnv", "api_key_env"]).unwrap_or_default();
    let api_key = first_string(settings, &["apiKey", "api_key"]).unwrap_or_default();
    let base_url = first_string(settings, &["baseUrl", "base_url"]).unwrap_or_default();
    let api_mode = first_string(settings, &["apiMode", "api_mode"]).unwrap_or_default();
    let provider_label = first_string(settings, &["providerLabel", "provider_label"])
        .unwrap_or_else(|| provider.clone());

    let root = object_mut(config);
    let model_config = child_object_mut(root, "model");
    if !provider.is_empty() {
        model_config.insert("provider".into(), Value::String(provider.clone()));
    }
    if !model.is_empty() {
        model_config.insert("default".into(), Value::String(model.clone()));
    }
    if !base_url.is_empty() {
        model_config.insert("base_url".into(), Value::String(base_url.clone()));
    }
    if !api_mode.is_empty() {
        model_config.insert("api_mode".into(), Value::String(api_mode.clone()));
    }

    if provider.is_empty() || base_url.is_empty() {
        return;
    }

    let providers = child_object_mut(root, "providers");
    let provider_entry = child_object_mut(providers, &provider);
    provider_entry.insert("name".into(), Value::String(provider_label));
    provider_entry.insert("base_url".into(), Value::String(base_url));
    if !api_key_env.is_empty() {
        provider_entry.insert("key_env".into(), Value::String(api_key_env));
    }
    if !api_key.is_empty() {
        provider_entry.insert("api_key".into(), Value::String(api_key));
    }
    if !model.is_empty() {
        provider_entry.insert("default_model".into(), Value::String(model));
    }
    if !api_mode.is_empty() {
        provider_entry.insert("api_mode".into(), Value::String(api_mode));
    }
}

fn clear_stale_mia_owned_model_config(config: &mut Value) {
    let is_mia_owned = config
        .get("mia")
        .and_then(|mia| mia.get("runtime_schema"))
        .and_then(Value::as_i64)
        == Some(1);
    if !is_mia_owned {
        return;
    }
    let stale_provider = config
        .get("model")
        .and_then(|model| first_string(model, &["provider"]))
        .unwrap_or_default();
    let root = object_mut(config);
    root.remove("model");
    if stale_provider.is_empty() {
        return;
    }
    let Some(providers) = root.get_mut("providers").and_then(Value::as_object_mut) else {
        return;
    };
    providers.remove(&stale_provider);
    if providers.is_empty() {
        root.remove("providers");
    }
}

fn apply_hermes_api_server_config(config: &mut Value, port: u16, key: &str) {
    let root = object_mut(config);
    let platforms = child_object_mut(root, "platforms");
    let api_server = child_object_mut(platforms, "api_server");
    api_server.insert("enabled".into(), Value::Bool(true));
    api_server.insert("host".into(), Value::String("127.0.0.1".into()));
    api_server.insert("port".into(), json!(port));
    api_server.insert("key".into(), Value::String(key.into()));
}

fn apply_hermes_agent_config(
    config: &mut Value,
    permission_settings: &Value,
    effort_settings: &Value,
) {
    let approvals_mode =
        first_string(permission_settings, &["mode"]).unwrap_or_else(|| "ask".into());
    let effort_level = first_string(effort_settings, &["level"]).unwrap_or_else(|| "medium".into());
    let root = object_mut(config);
    let approvals = child_object_mut(root, "approvals");
    approvals.insert("mode".into(), Value::String(approvals_mode));
    approvals
        .entry("timeout")
        .or_insert_with(|| Value::Number(60.into()));

    let agent = child_object_mut(root, "agent");
    agent.insert("reasoning_effort".into(), Value::String(effort_level));
    let mut disabled = agent
        .get("disabled_toolsets")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    if !disabled.iter().any(|value| value == "cronjob") {
        disabled.push("cronjob".into());
    }
    agent.insert(
        "disabled_toolsets".into(),
        Value::Array(disabled.into_iter().map(Value::String).collect()),
    );
}

fn apply_hermes_mcp_config(config: &mut Value, user_specs: &BTreeMap<String, Value>) {
    let mut merged = Map::new();
    for (name, spec) in user_specs {
        if matches!(name.as_str(), "mia-app" | "mia-scheduler") {
            continue;
        }
        if let Some(spec) = normalize_runtime_mcp_spec(spec) {
            merged.insert(name.clone(), spec);
        }
    }
    let root = object_mut(config);
    let mcp_servers = child_object_mut(root, "mcp_servers");
    mcp_servers.remove("mia-app");
    mcp_servers.remove("mia-scheduler");
    for (name, spec) in merged {
        mcp_servers.insert(name, spec);
    }
}

fn apply_hermes_mia_metadata(config: &mut Value, _home_path: &str, bot_manifest_path: &str) {
    let root = object_mut(config);
    let skills = child_object_mut(root, "skills");
    let mut external_dirs = skills
        .get("external_dirs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !external_dirs
        .iter()
        .any(|value| value.as_str() == Some(HERMES_SKILL_DIRECTORY_ENV))
    {
        external_dirs.push(Value::String(HERMES_SKILL_DIRECTORY_ENV.into()));
    }
    skills.insert("external_dirs".into(), Value::Array(external_dirs));
    let mia = child_object_mut(root, "mia");
    mia.insert("runtime_schema".into(), json!(1));
    mia.insert(
        "bots_manifest".into(),
        Value::String(bot_manifest_path.into()),
    );
}

fn settings_runtime_control_options(
    request: SettingsRuntimeControlOptionsRequest,
) -> SettingsRuntimeControlOptionsResponse {
    let runtime_value = request.runtime;
    let runtime = object_or_empty(runtime_value.clone());
    let engine_config = object_or_empty(request.engine_config);
    let agent_engine = normalize_settings_agent_engine(request.active_agent_engine.as_deref());
    let external_engine = is_external_settings_engine(&agent_engine);
    let model_catalog = settings_model_catalog(&request.model_catalog);
    let platform_models = settings_platform_model_entries(&request.platform_models);
    let engine_blocked = settings_runtime_inventory_engine_state(&runtime_value, &agent_engine)
        .is_some_and(|usable| !usable);
    let model_options = if engine_blocked {
        Vec::new()
    } else if external_engine {
        settings_external_model_options(
            &agent_engine,
            &request.engine_capabilities,
            &request.codex_models,
            &platform_models,
        )
    } else {
        settings_hermes_model_options(&runtime, &model_catalog, &platform_models)
    };
    let selected_model =
        selected_settings_model(&agent_engine, &runtime, &engine_config, &model_options);
    let selected_model_entry =
        selected_settings_model_entry(&model_options, &runtime, &engine_config, &selected_model);
    let runtime_controls_available = !model_options.is_empty();
    let effort_options = if runtime_controls_available {
        settings_effort_options(
            &agent_engine,
            &request.engine_capabilities,
            &request.codex_models,
        )
    } else {
        Vec::new()
    };
    let selected_effort =
        selected_settings_effort(&agent_engine, &runtime, &engine_config, &effort_options);
    let permission_options = if runtime_controls_available {
        settings_permission_options(&agent_engine, &request.engine_capabilities)
    } else {
        Vec::new()
    };
    let selected_permission =
        selected_settings_permission(&agent_engine, &runtime, &permission_options);
    SettingsRuntimeControlOptionsResponse {
        agent_engine: agent_engine.clone(),
        external_engine,
        status_text: settings_status_text(&agent_engine, &runtime, &model_options),
        model_options,
        selected_model,
        selected_model_entry,
        effort_options,
        selected_effort,
        permission_options,
        selected_permission,
        add_provider_options: settings_add_provider_options(&runtime, &model_catalog),
    }
}

fn normalize_settings_agent_engine(value: Option<&str>) -> String {
    let normalized = clean_opt(value).to_ascii_lowercase().replace('_', "-");
    match normalized.as_str() {
        "claude" | "claude-code" => "claude-code".into(),
        "codex" | "openai-codex" => "codex".into(),
        _ => "hermes".into(),
    }
}

fn is_external_settings_engine(engine: &str) -> bool {
    matches!(engine, "claude-code" | "codex")
}

fn settings_engine_label(engine: &str) -> &'static str {
    match engine {
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        _ => "Hermes",
    }
}

fn settings_status_text(
    engine: &str,
    runtime: &Value,
    model_options: &[BotRuntimeControlOption],
) -> String {
    if is_external_settings_engine(engine) {
        return settings_engine_label(engine).into();
    }
    if runtime_bool(runtime, &["engineRunning", "engine_running"]) {
        return "已连接".into();
    }
    if model_options.is_empty() {
        return "先连接提供商".into();
    }
    if runtime_bool(runtime, &["engineStarting", "engine_starting"]) {
        return "启动中".into();
    }
    if runtime_bool(runtime, &["engineInstalled", "engine_installed"]) {
        return "未启动".into();
    }
    "未安装".into()
}

fn settings_model_catalog(value: &Value) -> Vec<BotRuntimeControlOption> {
    value_array_or_nested(
        value,
        &["entries", "models", "modelCatalog", "model_catalog"],
    )
    .iter()
    .filter_map(settings_option_from_value)
    .collect()
}

fn settings_platform_model_entries(value: &Value) -> Vec<BotRuntimeControlOption> {
    value_array_or_nested(value, &["models", "platformModels", "platform_models"])
        .iter()
        .filter_map(|item| {
            let id = first_string(
                item,
                &["id", "value", "model_name", "modelName", "model", "slug"],
            )?;
            let label = platform_model_display_label(item, &id);
            Some(BotRuntimeControlOption {
                id: id.clone(),
                value: id.clone(),
                label,
                title: String::new(),
                aliases: vec![],
                model: id.clone(),
                provider: "mia".into(),
                provider_connection_id: "mia".into(),
                provider_label: "Mia".into(),
                auth_type: "mia_account".into(),
                model_profile_id: format!("mia:{id}"),
            })
        })
        .collect::<Vec<_>>()
}

fn platform_model_display_label(entry: &Value, fallback_id: &str) -> String {
    let id = fallback_id.trim();
    let id_lower = id.to_ascii_lowercase();
    if matches!(id_lower.as_str(), "mia-auto" | "mia-default") {
        return "Auto".into();
    }
    let raw = first_string(entry, &["label", "name", "displayName", "display_name"])
        .unwrap_or_else(|| id.to_string());
    raw.trim_start_matches("Mia ").trim().to_string()
}

fn settings_hermes_model_options(
    runtime: &Value,
    model_catalog: &[BotRuntimeControlOption],
    platform_models: &[BotRuntimeControlOption],
) -> Vec<BotRuntimeControlOption> {
    let connected = connected_provider_ids(runtime);
    let mut entries = model_catalog
        .iter()
        .filter(|entry| connected.contains(entry.provider.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if runtime
        .get("cloud")
        .and_then(|cloud| cloud.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        entries.extend(platform_models.iter().cloned());
    }
    if let Some(current) = current_runtime_model_option(runtime)
        && provider_is_connected(runtime, &current.provider)
        && !entries
            .iter()
            .any(|entry| settings_model_option_matches(entry, &current))
    {
        entries.insert(0, current);
    }
    dedupe_settings_options(entries)
}

fn settings_external_model_options(
    engine: &str,
    engine_capabilities: &Value,
    _codex_models: &Value,
    platform_models: &[BotRuntimeControlOption],
) -> Vec<BotRuntimeControlOption> {
    let capability = settings_engine_capability(engine_capabilities, engine);
    let mut entries = Vec::new();
    if engine == "claude-code" {
        entries.extend(
            value_array_or_nested(&capability, &["models"])
                .iter()
                .enumerate()
                .filter_map(|(index, item)| normalize_external_model_option(engine, item, index)),
        );
    } else if engine == "codex" {
        for item in value_array_or_nested(&capability, &["models"]) {
            if let Some(slug) = first_string(&item, &["slug", "id", "model", "value", "name"]) {
                entries.push(BotRuntimeControlOption {
                    id: slug.clone(),
                    value: slug.clone(),
                    label: first_string(&item, &["displayName", "display_name", "label", "name"])
                        .unwrap_or_else(|| slug.clone()),
                    title: first_string(&item, &["description"]).unwrap_or_default(),
                    aliases: vec![],
                    model: slug,
                    provider: "codex".into(),
                    provider_connection_id: "codex".into(),
                    provider_label: "Codex CLI".into(),
                    auth_type: String::new(),
                    model_profile_id: String::new(),
                });
            }
        }
    }
    entries.extend(platform_models.iter().cloned());
    dedupe_settings_options(entries)
}

fn normalize_external_model_option(
    engine: &str,
    item: &Value,
    index: usize,
) -> Option<BotRuntimeControlOption> {
    let id = first_string(item, &["id", "key", "value", "model", "name"])
        .unwrap_or_else(|| format!("{engine}-{index}"));
    let model = first_string(item, &["model", "key", "id", "value", "name"]).unwrap_or_default();
    if id.is_empty() && model.is_empty() {
        return None;
    }
    Some(BotRuntimeControlOption {
        id: if id.is_empty() {
            model.clone()
        } else {
            id.clone()
        },
        value: if id.is_empty() { model.clone() } else { id },
        label: first_string(item, &["label", "displayName", "display_name", "name"])
            .unwrap_or_else(|| {
                if model.is_empty() {
                    settings_engine_label(engine).into()
                } else {
                    model.clone()
                }
            }),
        title: first_string(item, &["title", "description"]).unwrap_or_default(),
        aliases: string_array(item.get("aliases")),
        model,
        provider: first_string(item, &["provider"]).unwrap_or_else(|| engine.into()),
        provider_connection_id: first_string(
            item,
            &["providerConnectionId", "provider_connection_id"],
        )
        .unwrap_or_else(|| engine.into()),
        provider_label: first_string(item, &["providerLabel", "provider_label"])
            .unwrap_or_else(|| settings_engine_label(engine).into()),
        auth_type: first_string(item, &["authType", "auth_type"]).unwrap_or_default(),
        model_profile_id: first_string(
            item,
            &[
                "modelProfileId",
                "model_profile_id",
                "profileId",
                "profile_id",
            ],
        )
        .unwrap_or_default(),
    })
}

fn settings_effort_options(
    engine: &str,
    engine_capabilities: &Value,
    _codex_models: &Value,
) -> Vec<BotRuntimeControlOption> {
    let capability = settings_engine_capability(engine_capabilities, engine);
    let dynamic = value_array_or_nested(&capability, &["effortOptions", "effort_options"]);
    if !dynamic.is_empty() {
        return dynamic
            .iter()
            .filter_map(settings_effort_option_from_value)
            .collect();
    }
    let levels = value_array_or_nested(&capability, &["effortLevels", "effort_levels"]);
    if !levels.is_empty() {
        return levels.iter().filter_map(settings_effort_level).collect();
    }
    if engine == "codex" {
        let models = value_array_or_nested(&capability, &["models"]);
        let mut seen = HashSet::new();
        let mut options = Vec::new();
        for model in models {
            for item in value_array_or_nested(
                &model,
                &["supportedReasoningLevels", "supported_reasoning_levels"],
            ) {
                let level = first_string(&item, &["effort", "value", "id"]).unwrap_or_default();
                if level.is_empty() || !seen.insert(level.clone()) {
                    continue;
                }
                options.push(BotRuntimeControlOption {
                    id: String::new(),
                    value: level.clone(),
                    label: first_string(&item, &["label"]).unwrap_or_else(|| effort_label(&level)),
                    title: first_string(&item, &["description", "title"]).unwrap_or_default(),
                    aliases: vec![],
                    model: String::new(),
                    provider: String::new(),
                    provider_connection_id: String::new(),
                    provider_label: String::new(),
                    auth_type: String::new(),
                    model_profile_id: String::new(),
                });
            }
        }
        if !options.is_empty() {
            return options;
        }
    }
    let levels = if is_external_settings_engine(engine) {
        Vec::new()
    } else {
        value_array_or_nested(engine_capabilities, &["effortLevels", "effort_levels"])
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect::<Vec<_>>()
    };
    levels
        .into_iter()
        .map(|level| BotRuntimeControlOption {
            id: String::new(),
            value: level.clone(),
            label: effort_label(&level),
            title: String::new(),
            aliases: vec![],
            model: String::new(),
            provider: String::new(),
            provider_connection_id: String::new(),
            provider_label: String::new(),
            auth_type: String::new(),
            model_profile_id: String::new(),
        })
        .collect()
}

fn settings_effort_option_from_value(item: &Value) -> Option<BotRuntimeControlOption> {
    let level = first_string(item, &["value", "effort", "id"])
        .or_else(|| item.as_str().map(str::to_string))?;
    Some(BotRuntimeControlOption {
        id: String::new(),
        value: level.clone(),
        label: first_string(item, &["label"]).unwrap_or_else(|| effort_label(&level)),
        title: first_string(item, &["title", "description"]).unwrap_or_default(),
        aliases: vec![],
        model: String::new(),
        provider: String::new(),
        provider_connection_id: String::new(),
        provider_label: String::new(),
        auth_type: String::new(),
        model_profile_id: String::new(),
    })
}

fn settings_effort_level(item: &Value) -> Option<BotRuntimeControlOption> {
    let level = item
        .as_str()
        .map(str::to_string)
        .or_else(|| first_string(item, &["value", "effort", "id"]))?;
    Some(BotRuntimeControlOption {
        id: String::new(),
        value: level.clone(),
        label: effort_label(&level),
        title: String::new(),
        aliases: vec![],
        model: String::new(),
        provider: String::new(),
        provider_connection_id: String::new(),
        provider_label: String::new(),
        auth_type: String::new(),
        model_profile_id: String::new(),
    })
}

fn settings_permission_options(
    engine: &str,
    engine_capabilities: &Value,
) -> Vec<BotRuntimeControlOption> {
    if is_external_settings_engine(engine) {
        let capability = settings_engine_capability(engine_capabilities, engine);
        let dynamic =
            value_array_or_nested(&capability, &["permissionOptions", "permission_options"]);
        if !dynamic.is_empty() {
            return dynamic
                .iter()
                .filter_map(settings_permission_option_from_value)
                .collect();
        }
        let modes = value_array_or_nested(&capability, &["permissionModes", "permission_modes"]);
        if !modes.is_empty() {
            return modes
                .iter()
                .filter_map(|item| {
                    let value = item
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| first_string(item, &["value", "id"]))?;
                    Some(settings_permission_option(
                        &value,
                        external_permission_label(&value),
                        "",
                    ))
                })
                .collect();
        }
        if engine == "codex" {
            let profiles =
                value_array_or_nested(&capability, &["permissionProfiles", "permission_profiles"]);
            return codex_permission_options_from_profiles(&profiles);
        }
        return Vec::new();
    }

    let modes = value_array_or_nested(engine_capabilities, &["approvalModes", "approval_modes"]);
    let values = modes
        .iter()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect::<Vec<_>>();
    values
        .iter()
        .map(|value| settings_permission_option(value, approval_label(value), ""))
        .collect()
}

fn codex_permission_options_from_profiles(profiles: &[Value]) -> Vec<BotRuntimeControlOption> {
    if profiles.is_empty() {
        return Vec::new();
    }
    let mut rows = profiles
        .iter()
        .filter_map(|profile| {
            let id = first_string(profile, &["id", "value"])?;
            Some((
                codex_permission_rank(&id),
                id,
                first_string(profile, &["description", "title"]).unwrap_or_default(),
            ))
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    rows.into_iter()
        .map(|(_, id, description)| BotRuntimeControlOption {
            aliases: codex_permission_aliases(&id),
            ..settings_permission_option(&id, codex_permission_label(&id), &description)
        })
        .collect()
}

fn settings_permission_option(value: &str, label: &str, title: &str) -> BotRuntimeControlOption {
    BotRuntimeControlOption {
        id: String::new(),
        value: value.into(),
        label: label.into(),
        title: title.into(),
        aliases: vec![],
        model: String::new(),
        provider: String::new(),
        provider_connection_id: String::new(),
        provider_label: String::new(),
        auth_type: String::new(),
        model_profile_id: String::new(),
    }
}

fn settings_permission_option_from_value(item: &Value) -> Option<BotRuntimeControlOption> {
    let value = first_string(item, &["value", "id"])?;
    Some(BotRuntimeControlOption {
        aliases: string_array(item.get("aliases")),
        ..settings_permission_option(
            &value,
            &first_string(item, &["label"])
                .unwrap_or_else(|| external_permission_label(&value).into()),
            &first_string(item, &["title", "description"]).unwrap_or_default(),
        )
    })
}

fn selected_settings_model(
    engine: &str,
    runtime: &Value,
    engine_config: &Value,
    options: &[BotRuntimeControlOption],
) -> String {
    if options.is_empty() {
        return String::new();
    }
    let wanted = if is_external_settings_engine(engine) {
        first_string(engine_config, &["model", "id", "value"]).unwrap_or_default()
    } else {
        runtime
            .get("model")
            .and_then(|model| {
                first_string(
                    model,
                    &["modelProfileId", "model_profile_id", "id", "value", "model"],
                )
            })
            .unwrap_or_default()
    };
    if let Some(entry) = options
        .iter()
        .find(|entry| option_matches_value(entry, &wanted))
        .or_else(|| {
            runtime
                .get("model")
                .and_then(current_runtime_model_option_from_value)
                .and_then(|current| {
                    options
                        .iter()
                        .find(|entry| settings_model_option_matches(entry, &current))
                })
        })
    {
        return settings_option_select_value(entry);
    }
    if is_external_settings_engine(engine) {
        return String::new();
    }
    options
        .first()
        .map(settings_option_select_value)
        .unwrap_or_default()
}

fn settings_runtime_inventory_engine_state(runtime: &Value, engine: &str) -> Option<bool> {
    let agents = runtime
        .get("agentInventory")
        .and_then(Value::as_object)
        .and_then(|inventory| inventory.get("agents"))
        .and_then(Value::as_array)?;
    for agent in agents {
        let Some(id) =
            first_string(agent, &["id"]).map(|value| normalize_settings_agent_engine(Some(&value)))
        else {
            continue;
        };
        if id == engine {
            return Some(
                agent
                    .get("usableInMia")
                    .or_else(|| agent.get("usable_in_mia"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            );
        }
    }
    None
}

fn selected_settings_model_entry(
    options: &[BotRuntimeControlOption],
    runtime: &Value,
    engine_config: &Value,
    selected_model: &str,
) -> Option<BotRuntimeControlOption> {
    options
        .iter()
        .find(|entry| option_matches_value(entry, selected_model))
        .cloned()
        .or_else(|| {
            let wanted = first_string(engine_config, &["model", "id", "value"]).unwrap_or_default();
            options
                .iter()
                .find(|entry| option_matches_value(entry, &wanted))
                .cloned()
        })
        .or_else(|| {
            runtime
                .get("model")
                .and_then(current_runtime_model_option_from_value)
                .and_then(|current| {
                    options
                        .iter()
                        .find(|entry| settings_model_option_matches(entry, &current))
                        .cloned()
                })
        })
}

fn selected_settings_effort(
    engine: &str,
    runtime: &Value,
    engine_config: &Value,
    options: &[BotRuntimeControlOption],
) -> String {
    let wanted = if is_external_settings_engine(engine) {
        first_string(engine_config, &["effortLevel", "effort_level"]).unwrap_or_default()
    } else {
        runtime
            .get("effort")
            .and_then(|effort| first_string(effort, &["level", "effortLevel", "effort_level"]))
            .unwrap_or_default()
    };
    selected_settings_option_value(options, &wanted, "medium")
}

fn selected_settings_permission(
    engine: &str,
    runtime: &Value,
    options: &[BotRuntimeControlOption],
) -> String {
    let wanted = if is_external_settings_engine(engine) {
        runtime
            .get("permissions")
            .and_then(|permissions| permissions.get("engines"))
            .and_then(|engines| engines.get(engine))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| "default".into())
    } else {
        runtime
            .get("permissions")
            .and_then(|permissions| {
                first_string(permissions, &["mode", "permissionMode", "permission_mode"])
            })
            .unwrap_or_else(|| "ask".into())
    };
    selected_settings_option_value(options, &wanted, &wanted)
}

fn selected_settings_option_value(
    options: &[BotRuntimeControlOption],
    wanted: &str,
    fallback: &str,
) -> String {
    if options.is_empty() {
        return String::new();
    }
    options
        .iter()
        .find(|option| option_matches_value(option, wanted))
        .or_else(|| {
            options
                .iter()
                .find(|option| option_matches_value(option, fallback))
        })
        .or_else(|| options.first())
        .map(settings_option_select_value)
        .unwrap_or_else(|| fallback.into())
}

fn settings_add_provider_options(
    runtime: &Value,
    model_catalog: &[BotRuntimeControlOption],
) -> Vec<BotRuntimeControlOption> {
    let connected = connected_provider_ids(runtime);
    let mut seen = HashSet::new();
    model_catalog
        .iter()
        .filter(|entry| entry.provider != "mia" && !connected.contains(entry.provider.as_str()))
        .filter(|entry| seen.insert(entry.provider.clone()))
        .map(|entry| BotRuntimeControlOption {
            id: entry.provider.clone(),
            value: entry.provider.clone(),
            label: first_non_empty([
                entry.provider_label.as_str(),
                entry.label.as_str(),
                entry.provider.as_str(),
            ]),
            title: String::new(),
            aliases: vec![],
            model: String::new(),
            provider: entry.provider.clone(),
            provider_connection_id: entry.provider.clone(),
            provider_label: first_non_empty([
                entry.provider_label.as_str(),
                entry.label.as_str(),
                entry.provider.as_str(),
            ]),
            auth_type: entry.auth_type.clone(),
            model_profile_id: String::new(),
        })
        .collect()
}

fn settings_option_from_value(value: &Value) -> Option<BotRuntimeControlOption> {
    if let Some(text) = value
        .as_str()
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        return Some(BotRuntimeControlOption {
            id: text.into(),
            value: text.into(),
            label: text.into(),
            title: String::new(),
            aliases: vec![],
            model: text.into(),
            provider: String::new(),
            provider_connection_id: String::new(),
            provider_label: String::new(),
            auth_type: String::new(),
            model_profile_id: String::new(),
        });
    }
    let object = value.as_object()?;
    let provider = first_string(value, &["provider"]).unwrap_or_default();
    let model = first_string(value, &["model", "slug", "name", "value"]).unwrap_or_default();
    let id = first_string(
        value,
        &["id", "key", "value", "modelProfileId", "model_profile_id"],
    )
    .unwrap_or_else(|| {
        if provider.is_empty() {
            model.clone()
        } else {
            format!("{provider}::{model}")
        }
    });
    if id.is_empty() && model.is_empty() && provider.is_empty() {
        return None;
    }
    let provider_connection_id = first_string(
        value,
        &[
            "providerConnectionId",
            "provider_connection_id",
            "modelProvider",
            "model_provider",
        ],
    )
    .unwrap_or_else(|| provider.clone());
    Some(BotRuntimeControlOption {
        id,
        value: first_string(value, &["value"]).unwrap_or_default(),
        label: first_string(
            value,
            &["label", "displayName", "display_name", "name", "title"],
        )
        .unwrap_or_else(|| {
            if model.is_empty() {
                provider.clone()
            } else {
                model.clone()
            }
        }),
        title: first_string(value, &["title", "description"]).unwrap_or_default(),
        aliases: string_array(object.get("aliases")),
        model,
        provider,
        provider_connection_id,
        provider_label: first_string(value, &["providerLabel", "provider_label"])
            .unwrap_or_default(),
        auth_type: first_string(value, &["authType", "auth_type"]).unwrap_or_default(),
        model_profile_id: first_string(
            value,
            &[
                "modelProfileId",
                "model_profile_id",
                "profileId",
                "profile_id",
            ],
        )
        .unwrap_or_default(),
    })
}

fn current_runtime_model_option(runtime: &Value) -> Option<BotRuntimeControlOption> {
    runtime
        .get("model")
        .and_then(current_runtime_model_option_from_value)
}

fn current_runtime_model_option_from_value(value: &Value) -> Option<BotRuntimeControlOption> {
    let provider = first_string(value, &["provider"])?;
    let model = first_string(value, &["model"]).unwrap_or_default();
    let id = first_string(
        value,
        &["modelProfileId", "model_profile_id", "id", "value"],
    )
    .unwrap_or_else(|| format!("{provider}::{model}"));
    Some(BotRuntimeControlOption {
        id,
        value: String::new(),
        label: first_string(value, &["label"]).unwrap_or_else(|| {
            if model.is_empty() {
                provider.clone()
            } else {
                model.clone()
            }
        }),
        title: String::new(),
        aliases: vec![],
        model,
        provider: provider.clone(),
        provider_connection_id: first_string(
            value,
            &["providerConnectionId", "provider_connection_id"],
        )
        .unwrap_or(provider),
        provider_label: first_string(value, &["providerLabel", "provider_label"])
            .unwrap_or_default(),
        auth_type: first_string(value, &["authType", "auth_type"]).unwrap_or_default(),
        model_profile_id: first_string(value, &["modelProfileId", "model_profile_id"])
            .unwrap_or_default(),
    })
}

fn settings_engine_capability(engine_capabilities: &Value, engine: &str) -> Value {
    engine_capabilities
        .get("engines")
        .and_then(|engines| {
            engines
                .get(engine)
                .or_else(|| engines.get(engine.replace('-', "_")))
                .or_else(|| {
                    if engine == "claude-code" {
                        engines.get("claudeCode")
                    } else {
                        None
                    }
                })
        })
        .cloned()
        .unwrap_or_else(|| json!({}))
}

fn connected_provider_ids(runtime: &Value) -> HashSet<String> {
    runtime
        .get("connectedProviders")
        .or_else(|| runtime.get("connected_providers"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| {
            entry
                .get("hasApiKey")
                .or_else(|| entry.get("has_api_key"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|entry| first_string(entry, &["provider"]))
        .collect()
}

fn provider_is_connected(runtime: &Value, provider: &str) -> bool {
    if provider == "mia" {
        return runtime
            .get("cloud")
            .and_then(|cloud| cloud.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
    }
    connected_provider_ids(runtime).contains(provider)
}

fn settings_model_option_matches(
    left: &BotRuntimeControlOption,
    right: &BotRuntimeControlOption,
) -> bool {
    (!left.id.is_empty() && left.id == right.id)
        || (!left.model_profile_id.is_empty() && left.model_profile_id == right.model_profile_id)
        || (left.provider == right.provider && left.model == right.model)
}

fn option_matches_value(option: &BotRuntimeControlOption, value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() {
        return false;
    }
    option.id == value
        || option.value == value
        || option.model == value
        || option.model_profile_id == value
        || option.provider_connection_id == value
        || option.aliases.iter().any(|alias| alias == value)
}

fn settings_option_select_value(option: &BotRuntimeControlOption) -> String {
    first_non_empty([
        option.id.as_str(),
        option.value.as_str(),
        option.model_profile_id.as_str(),
        option.model.as_str(),
    ])
}

fn dedupe_settings_options(entries: Vec<BotRuntimeControlOption>) -> Vec<BotRuntimeControlOption> {
    let mut seen = HashSet::new();
    entries
        .into_iter()
        .filter(|entry| {
            let model_or_value = if entry.model.is_empty() {
                entry.value.as_str()
            } else {
                entry.model.as_str()
            };
            let key = format!("{}:{}:{}", entry.provider, entry.id, model_or_value);
            !key.trim_matches(':').is_empty() && seen.insert(key)
        })
        .collect()
}

fn value_array_or_nested(value: &Value, keys: &[&str]) -> Vec<Value> {
    if let Some(values) = value.as_array() {
        return values.clone();
    }
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_array))
        .cloned()
        .unwrap_or_default()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn runtime_bool(runtime: &Value, keys: &[&str]) -> bool {
    keys.iter()
        .find_map(|key| runtime.get(*key).and_then(Value::as_bool))
        .unwrap_or(false)
}

fn first_non_empty<'a>(values: impl IntoIterator<Item = &'a str>) -> String {
    values
        .into_iter()
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default()
        .to_string()
}

fn effort_label(value: &str) -> String {
    match value {
        "off" => "Off",
        "none" => "None",
        "minimal" => "Minimal",
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "Extra high",
        "adaptive" => "Adaptive",
        "max" => "Max",
        _ => value,
    }
    .into()
}

fn approval_label(value: &str) -> &'static str {
    match value {
        "ask" | "manual" => "Ask",
        "yolo" | "off" => "YOLO",
        "deny" | "dontAsk" => "Deny",
        _ => "Ask",
    }
}

fn external_permission_label(value: &str) -> &'static str {
    match value {
        "default" => "Ask",
        "acceptEdits" => "Accept Edits",
        "auto" => "Auto",
        "bypassPermissions" => "Bypass Permissions",
        "dontAsk" => "Don't Ask",
        "plan" => "Plan Mode",
        "readOnly" => "Read",
        "yolo" => "YOLO",
        _ => "Ask",
    }
}

fn codex_permission_label(value: &str) -> &'static str {
    match value {
        ":workspace" => "Workspace",
        ":read-only" => "Read Only",
        ":danger-full-access" => "Full Access",
        _ => "Ask",
    }
}

fn codex_permission_aliases(value: &str) -> Vec<String> {
    match value {
        ":workspace" => vec!["default".into(), "acceptEdits".into(), "workspace".into()],
        ":read-only" => vec!["readOnly".into(), "read-only".into()],
        ":danger-full-access" => vec![
            "bypassPermissions".into(),
            "yolo".into(),
            "off".into(),
            "never".into(),
            "danger-full-access".into(),
        ],
        _ => vec![],
    }
}

fn codex_permission_rank(value: &str) -> i32 {
    match value {
        ":workspace" => 0,
        ":read-only" => 1,
        ":danger-full-access" => 2,
        _ => 50,
    }
}

impl AgentPermissionService {
    pub fn new(settings: SqliteSettingsRepository) -> Self {
        Self {
            settings,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn remembered_decision(
        &self,
        request: &AgentPermissionRequest,
    ) -> Result<Option<AgentPermissionDecisionResponse>, sqlx::Error> {
        let rule = build_permission_rule(request);
        let rules = self.load_rules().await?;
        Ok(rules
            .into_iter()
            .find(|item| item.id == rule.id)
            .map(|remembered| AgentPermissionDecisionResponse {
                decision: "allow".into(),
                scope: "always".into(),
                remembered: true,
                rule: Some(remembered),
                message: None,
            }))
    }

    pub async fn enqueue_permission_request(
        &self,
        request: AgentPermissionRequest,
    ) -> Result<AgentPermissionPendingRequest, sqlx::Error> {
        let pending = pending_permission_from_request(request);
        self.pending
            .lock()
            .unwrap()
            .insert(pending.request_id.clone(), pending.clone());
        Ok(pending)
    }

    pub fn list_pending(&self, session_id: Option<&str>) -> AgentPermissionListResponse {
        let session_id = clean_opt(session_id);
        let mut requests = self
            .pending
            .lock()
            .unwrap()
            .values()
            .filter(|item| session_id.is_empty() || item.session_id == session_id)
            .cloned()
            .collect::<Vec<_>>();
        requests.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        AgentPermissionListResponse { requests }
    }

    pub async fn respond(
        &self,
        request: AgentPermissionRespondRequest,
    ) -> Result<AgentPermissionRespondResponse, sqlx::Error> {
        let request_id =
            clean_opt(request.request_id.as_deref()).if_empty(clean_opt(request.id.as_deref()));
        let Some(pending) = self.pending.lock().unwrap().remove(&request_id) else {
            return Ok(AgentPermissionRespondResponse {
                ok: false,
                error: Some("permission request not found".into()),
            });
        };

        let raw_decision =
            clean_opt(request.decision.as_deref()).if_empty(clean_opt(request.action.as_deref()));
        let allow_always = matches!(raw_decision.as_str(), "allow_always" | "always");
        let allow = allow_always || matches!(raw_decision.as_str(), "allow_once" | "allow");
        if allow_always {
            self.remember_rule(pending.rule.clone()).await?;
            self.pending
                .lock()
                .unwrap()
                .retain(|_, other| other.rule.id != pending.rule.id);
        }
        let _decision = AgentPermissionDecisionResponse {
            decision: if allow { "allow" } else { "deny" }.into(),
            scope: if allow_always { "always" } else { "once" }.into(),
            remembered: allow_always,
            rule: Some(pending.rule),
            message: (!allow).then(|| "用户拒绝了工具权限。".into()),
        };
        Ok(AgentPermissionRespondResponse {
            ok: true,
            error: None,
        })
    }

    pub async fn load_rules(&self) -> Result<Vec<AgentPermissionRule>, sqlx::Error> {
        let settings = self
            .settings
            .get_json(CLIENT_SETTINGS_KEY)
            .await?
            .unwrap_or_else(|| json!({}));
        Ok(permission_rules_from_settings(&settings))
    }

    async fn remember_rule(&self, rule: AgentPermissionRule) -> Result<(), sqlx::Error> {
        let mut current = self
            .settings
            .get_json(CLIENT_SETTINGS_KEY)
            .await?
            .unwrap_or_else(|| json!({}));
        let mut rules = permission_rules_from_settings(&current);
        if !rules.iter().any(|item| item.id == rule.id) {
            rules.push(rule);
        }
        let rules_json = Value::Array(
            rules
                .into_iter()
                .map(|rule| {
                    json!({
                        "id": rule.id,
                        "engine": rule.engine,
                        "toolName": rule.tool_name,
                        "subjectType": rule.subject_type,
                        "subjectValue": rule.subject_value,
                        "label": rule.label,
                    })
                })
                .collect(),
        );
        merge_json(
            &mut current,
            json!({
                "agentPermissions": {
                    "rules": rules_json,
                },
            }),
        );
        self.settings
            .set_json(CLIENT_SETTINGS_KEY, current, now_ms())
            .await
    }
}

trait EmptyStringExt {
    fn if_empty(self, fallback: String) -> String;
}

impl EmptyStringExt for String {
    fn if_empty(self, fallback: String) -> String {
        if self.is_empty() { fallback } else { self }
    }
}

fn pending_permission_from_request(
    request: AgentPermissionRequest,
) -> AgentPermissionPendingRequest {
    let engine = clean_opt(request.engine.as_deref()).if_empty("agent".into());
    let tool_name = clean_opt(request.tool_name.as_deref())
        .if_empty(clean_opt(request.tool.as_deref()))
        .if_empty("tool".into());
    let input = object_or_empty(request.input);
    let rule = build_permission_rule_from_parts(&engine, &tool_name, &input);
    AgentPermissionPendingRequest {
        request_id: clean_opt(request.request_id.as_deref())
            .if_empty(format!("perm_{}", Uuid::now_v7().simple())),
        engine: engine.clone(),
        bot_id: clean_opt(request.bot_id.as_deref()),
        session_id: clean_opt(request.session_id.as_deref()),
        tool_name: tool_name.clone(),
        title: format_permission_title(&engine, &tool_name, request.title.as_deref()),
        description: clean_opt(request.description.as_deref()),
        preview: clean_opt(request.preview.as_deref()).if_empty(preview_for_input(&input)),
        rule,
        created_at: now_rfc3339(),
    }
}

fn build_permission_rule(request: &AgentPermissionRequest) -> AgentPermissionRule {
    let engine = clean_opt(request.engine.as_deref()).if_empty("agent".into());
    let tool_name = clean_opt(request.tool_name.as_deref())
        .if_empty(clean_opt(request.tool.as_deref()))
        .if_empty("tool".into());
    let input = object_or_empty(request.input.clone());
    build_permission_rule_from_parts(&engine, &tool_name, &input)
}

fn build_permission_rule_from_parts(
    engine: &str,
    tool_name: &str,
    input: &Value,
) -> AgentPermissionRule {
    let (subject_type, subject_value, label) = rule_subject(tool_name, input);
    let hash_input = format!("{engine}\n{tool_name}\n{subject_type}\n{subject_value}");
    let id = hex_sha256(&hash_input)[..24].to_string();
    AgentPermissionRule {
        id,
        engine: engine.into(),
        tool_name: tool_name.into(),
        subject_type,
        subject_value,
        label,
    }
}

fn rule_subject(tool_name: &str, input: &Value) -> (String, String, String) {
    let tool_compact = tool_name
        .chars()
        .filter(|ch| ch.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase();
    let tool_lower = tool_name.to_ascii_lowercase();
    let command = command_from_input(input);
    if !command.is_empty()
        && (matches!(
            tool_compact.as_str(),
            "bash" | "shell" | "exec" | "command" | "commandexecution"
        ) || tool_lower.contains("bash")
            || tool_lower.contains("shell")
            || tool_lower.contains("command")
            || tool_lower.contains("exec"))
    {
        return ("command".into(), command.clone(), command);
    }

    let file_path = path_from_input(input);
    if !file_path.is_empty()
        && (tool_lower.contains("read")
            || tool_lower.contains("write")
            || tool_lower.contains("edit")
            || tool_lower.contains("patch")
            || tool_lower.contains("file"))
    {
        return ("path".into(), file_path.clone(), file_path);
    }

    let json = stable_json(input);
    let preview = preview_for_input(input);
    (
        "input".into(),
        hex_sha256(&json),
        preview.chars().take(160).collect(),
    )
}

fn permission_rules_from_settings(settings: &Value) -> Vec<AgentPermissionRule> {
    settings
        .get("agentPermissions")
        .and_then(|value| value.get("rules"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(permission_rule_from_json)
        .collect()
}

fn permission_rule_from_json(value: &Value) -> Option<AgentPermissionRule> {
    let id = first_string(value, &["id"])?;
    let engine = first_string(value, &["engine"])?;
    let tool_name = first_string(value, &["toolName", "tool_name"])?;
    let subject_type = first_string(value, &["subjectType", "subject_type"])?;
    let subject_value = first_string(value, &["subjectValue", "subject_value"])?;
    Some(AgentPermissionRule {
        id,
        engine,
        tool_name,
        subject_type,
        subject_value,
        label: first_string(value, &["label"]).unwrap_or_default(),
    })
}

fn format_permission_title(engine: &str, tool_name: &str, title: Option<&str>) -> String {
    let explicit = compact_whitespace(title.unwrap_or_default());
    if is_likely_mcp_tool_name(tool_name) {
        if !explicit.is_empty() {
            if explicit.contains(tool_name) || !explicit.to_ascii_lowercase().contains("mcp") {
                return explicit;
            }
            return format!("{explicit} {}", tool_name.trim());
        }
        return format!(
            "{} 想使用 MCP 工具 {}",
            permission_engine_label(engine),
            tool_name.trim()
        );
    }
    if !explicit.is_empty() {
        return explicit;
    }
    format!(
        "{} 请求使用 {}",
        permission_engine_label(engine),
        clean_opt(Some(tool_name)).if_empty("tool".into())
    )
}

fn is_likely_mcp_tool_name(tool_name: &str) -> bool {
    let value = tool_name.trim();
    if value.contains('.') {
        return true;
    }
    let lower = value.to_ascii_lowercase();
    lower == "mcp"
        || lower.starts_with("mcp:")
        || lower.starts_with("mcp_")
        || lower.starts_with("mcp/")
        || lower.starts_with("mcp-")
        || lower.starts_with("mcp ")
}

fn permission_engine_label(engine: &str) -> &'static str {
    match engine.trim().to_ascii_lowercase().as_str() {
        "codex" => "Codex",
        "claude-code" => "Claude Code",
        "mcp" => "MCP",
        _ => "Agent",
    }
}

fn preview_for_input(input: &Value) -> String {
    let command = command_from_input(input);
    if !command.is_empty() {
        return command;
    }
    let file_path = path_from_input(input);
    if !file_path.is_empty() {
        return file_path;
    }
    serde_json::to_string_pretty(input)
        .unwrap_or_else(|_| input.to_string())
        .chars()
        .take(4000)
        .collect()
}

fn command_from_input(input: &Value) -> String {
    first_permission_string(input, &["command", "cmd", "shellCommand", "args"]).unwrap_or_default()
}

fn path_from_input(input: &Value) -> String {
    first_permission_string(
        input,
        &["file_path", "filePath", "path", "cwd", "grantRoot"],
    )
    .unwrap_or_default()
}

fn object_or_empty(value: Value) -> Value {
    if value.is_object() { value } else { json!({}) }
}

fn compact_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_opt(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_string()
}

fn first_permission_string(source: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| {
            let value = source.get(*key)?;
            match value {
                Value::String(value) => Some(value.trim().to_string()),
                Value::Array(values) => {
                    let joined = values
                        .iter()
                        .filter_map(|item| match item {
                            Value::String(value) => Some(value.trim().to_string()),
                            Value::Number(_) | Value::Bool(_) => Some(item.to_string()),
                            _ => None,
                        })
                        .filter(|item| !item.is_empty())
                        .collect::<Vec<_>>()
                        .join(" ");
                    Some(joined)
                }
                Value::Number(_) | Value::Bool(_) => Some(value.to_string()),
                _ => None,
            }
        })
        .map(|value| compact_whitespace(&value))
        .filter(|value| !value.is_empty())
}

fn stable_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into()),
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(stable_json).collect::<Vec<_>>().join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| {
                        let key_json = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into());
                        format!("{key_json}:{}", stable_json(&values[key]))
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn hex_sha256(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| now_ms().to_string())
}

fn provider_summary_from_record(record: ProviderRecord) -> ProviderSummary {
    ProviderSummary {
        id: record.id,
        kind: record.kind,
        display_name: record.display_name,
        enabled: record.enabled,
        models: models_from_json(record.models_json),
    }
}

fn memory_settings_snapshot(settings: &Value) -> MemorySettingsResponse {
    let mode = settings
        .pointer("/memory/mode")
        .and_then(Value::as_str)
        .and_then(parse_memory_mode)
        .unwrap_or_else(
            || match settings.pointer("/memory/enabled").and_then(Value::as_bool) {
                Some(false) => MemoryMode::Native,
                _ => MemoryMode::Mia,
            },
        );
    MemorySettingsResponse {
        mode,
        enabled: mode == MemoryMode::Mia,
    }
}

fn parse_memory_mode(value: &str) -> Option<MemoryMode> {
    match value {
        "mia" => Some(MemoryMode::Mia),
        "native" => Some(MemoryMode::Native),
        _ => None,
    }
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

fn models_from_json(value: Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn clean_required(value: &str, label: &str) -> Result<String, SystemError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(SystemError::InvalidInput(format!("{label} is required")));
    }
    Ok(trimmed.to_string())
}

fn first_string(source: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| source.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn agent_workspace_custom_path(settings: &Value) -> String {
    settings
        .get("agentWorkspace")
        .and_then(|value| value.get("path").or_else(|| value.get("workspacePath")))
        .and_then(Value::as_str)
        .or_else(|| settings.get("agentWorkspacePath").and_then(Value::as_str))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn agent_workspace_snapshot(custom: String, default_workspace: &Path) -> AgentWorkspaceResponse {
    let default = default_workspace.to_string_lossy().to_string();
    let _ = std::fs::create_dir_all(default_workspace);
    let path = if !custom.is_empty() && Path::new(&custom).exists() {
        custom.clone()
    } else {
        default.clone()
    };
    AgentWorkspaceResponse {
        path,
        custom,
        default,
    }
}

fn optional_present_string(source: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        source.get(*key).map(|value| match value {
            Value::String(value) => value.trim().to_string(),
            Value::Null => String::new(),
            value => value.to_string().trim().to_string(),
        })
    })
}

fn optional_non_empty_string(source: &Value, keys: &[&str]) -> Option<String> {
    optional_present_string(source, keys)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
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

fn is_builtin_mia_model(model: &str) -> bool {
    matches!(model.trim(), "mia-auto" | "mia-default")
}

fn is_mia_managed_reference(config: &Value) -> bool {
    if explicit_provider_connection_id(config).as_deref() == Some("mia")
        || provider_from_profile_id(config).as_deref() == Some("mia")
    {
        return true;
    }
    let provider = first_string(config, &["provider", "modelProvider", "model_provider"]);
    let auth_type = first_string(config, &["authType", "auth_type"]);
    let profile_id = first_string(
        config,
        &[
            "modelProfileId",
            "model_profile_id",
            "profileId",
            "profile_id",
        ],
    )
    .unwrap_or_default();
    let model = first_string(config, &["model"]).unwrap_or_default();
    provider.as_deref() == Some("mia")
        || auth_type.as_deref() == Some("mia_account")
        || profile_id.starts_with("mia:")
        || is_builtin_mia_model(&model)
}

fn canonical_mia_model_id(model: &str) -> String {
    match model.trim() {
        "mia-default" => "mia-auto".into(),
        other => other.into(),
    }
}

fn to_mia_managed_reference(config: &Value) -> Value {
    let raw_profile_id =
        first_string(config, &["modelProfileId", "model_profile_id"]).unwrap_or_default();
    let profile_model = raw_profile_id
        .strip_prefix("mia:")
        .map(str::to_string)
        .unwrap_or_default();
    let model = canonical_mia_model_id(&first_string(config, &["model"]).unwrap_or(profile_model));
    let model = if model.is_empty() {
        "mia-auto".to_string()
    } else {
        model
    };
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

fn compact_mia_client_settings(selection: &Value) -> Value {
    let reference = to_mia_managed_reference(selection);
    json!({
        "provider": "mia",
        "providerConnectionId": "mia",
        "providerLabel": reference["providerLabel"].as_str().unwrap_or("Mia"),
        "authType": reference["authType"].as_str().unwrap_or("mia_account"),
        "model": reference["model"].as_str().unwrap_or("mia-auto"),
        "modelProfileId": reference["modelProfileId"].as_str().unwrap_or("mia:mia-auto")
    })
}

fn compact_model_selection(selection: &Value) -> Value {
    if is_mia_managed_reference(selection) {
        return compact_mia_client_settings(selection);
    }
    let provider_id = explicit_provider_connection_id(selection)
        .or_else(|| first_string(selection, &["provider", "kind"]))
        .unwrap_or_default();
    let provider = first_string(selection, &["provider", "kind"]).unwrap_or(provider_id.clone());
    let defaults = provider_selection_defaults(&provider);
    let model = first_string(selection, &["model"]).unwrap_or_default();
    let model_profile_id = first_string(selection, &["modelProfileId", "model_profile_id"])
        .unwrap_or_else(|| {
            if provider_id.is_empty() || model.is_empty() {
                String::new()
            } else {
                format!("{provider_id}:{model}")
            }
        });

    let mut settings = Map::new();
    if !provider.is_empty() {
        settings.insert("provider".into(), Value::String(provider));
    }
    if !provider_id.is_empty() {
        settings.insert("providerConnectionId".into(), Value::String(provider_id));
    }
    if let Some(label) = first_string(
        selection,
        &[
            "providerLabel",
            "provider_label",
            "displayName",
            "display_name",
        ],
    )
    .or_else(|| defaults.display_name.map(str::to_string))
    {
        settings.insert("providerLabel".into(), Value::String(label));
    }
    if let Some(auth_type) = first_string(selection, &["authType", "auth_type"])
        .or_else(|| defaults.auth_type.map(str::to_string))
    {
        settings.insert("authType".into(), Value::String(auth_type));
    }
    if !model.is_empty() {
        settings.insert("model".into(), Value::String(model));
    }
    if !model_profile_id.is_empty() {
        settings.insert("modelProfileId".into(), Value::String(model_profile_id));
    }
    Value::Object(settings)
}

fn provider_request_from_model_selection(
    selection: &Value,
) -> Result<Option<CreateProviderRequest>, SystemError> {
    if is_mia_managed_reference(selection) {
        return Ok(None);
    }
    let Some(provider_id) = explicit_provider_connection_id(selection)
        .or_else(|| first_string(selection, &["provider", "kind"]))
    else {
        return Ok(None);
    };
    let kind = first_string(selection, &["provider", "kind"]).unwrap_or(provider_id.clone());
    let defaults = provider_selection_defaults(&kind);
    let display_name = first_string(
        selection,
        &[
            "providerLabel",
            "provider_label",
            "displayName",
            "display_name",
        ],
    )
    .unwrap_or_else(|| defaults.display_name.unwrap_or(kind.as_str()).to_string());
    let model = first_string(selection, &["model"]);
    Ok(Some(CreateProviderRequest {
        id: Some(provider_id),
        kind,
        display_name,
        base_url: optional_present_string(selection, &["baseUrl", "base_url"])
            .or_else(|| defaults.base_url.map(str::to_string)),
        api_key_env: optional_present_string(selection, &["apiKeyEnv", "api_key_env"])
            .or_else(|| defaults.api_key_env.map(str::to_string)),
        api_key: optional_non_empty_string(selection, &["apiKey", "api_key"]),
        api_mode: optional_present_string(selection, &["apiMode", "api_mode"])
            .or_else(|| defaults.api_mode.map(str::to_string)),
        auth_type: first_string(selection, &["authType", "auth_type"])
            .or_else(|| defaults.auth_type.map(str::to_string))
            .or_else(|| Some("api_key".into())),
        models: model.into_iter().collect(),
        enabled: Some(true),
    }))
}

struct ProviderSelectionDefaults {
    display_name: Option<&'static str>,
    api_key_env: Option<&'static str>,
    base_url: Option<&'static str>,
    api_mode: Option<&'static str>,
    auth_type: Option<&'static str>,
}

fn provider_selection_defaults(kind: &str) -> ProviderSelectionDefaults {
    match kind {
        "openai-codex" => ProviderSelectionDefaults {
            display_name: Some("OpenAI Codex"),
            api_key_env: Some(""),
            base_url: Some(""),
            api_mode: Some("codex_responses"),
            auth_type: Some("oauth_external"),
        },
        "anthropic" => ProviderSelectionDefaults {
            display_name: Some("Anthropic"),
            api_key_env: Some("ANTHROPIC_API_KEY"),
            base_url: Some(""),
            api_mode: Some("anthropic_messages"),
            auth_type: Some("api_key"),
        },
        "xai" => ProviderSelectionDefaults {
            display_name: Some("xAI"),
            api_key_env: Some("XAI_API_KEY"),
            base_url: Some(""),
            api_mode: Some("chat_completions"),
            auth_type: Some("api_key"),
        },
        "openrouter" => ProviderSelectionDefaults {
            display_name: Some("OpenRouter"),
            api_key_env: Some("OPENROUTER_API_KEY"),
            base_url: Some(""),
            api_mode: Some("chat_completions"),
            auth_type: Some("api_key"),
        },
        "deepseek" => ProviderSelectionDefaults {
            display_name: Some("DeepSeek"),
            api_key_env: Some("DEEPSEEK_API_KEY"),
            base_url: Some(""),
            api_mode: Some("chat_completions"),
            auth_type: Some("api_key"),
        },
        "gemini" => ProviderSelectionDefaults {
            display_name: Some("Google"),
            api_key_env: Some("GEMINI_API_KEY"),
            base_url: Some(""),
            api_mode: Some("chat_completions"),
            auth_type: Some("api_key"),
        },
        "lmstudio" => ProviderSelectionDefaults {
            display_name: Some("LM Studio"),
            api_key_env: Some("LM_API_KEY"),
            base_url: Some("http://127.0.0.1:1234/v1"),
            api_mode: Some("chat_completions"),
            auth_type: Some("api_key"),
        },
        _ => ProviderSelectionDefaults {
            display_name: None,
            api_key_env: None,
            base_url: None,
            api_mode: None,
            auth_type: Some("api_key"),
        },
    }
}

fn model_settings_client_patch(settings: &Value) -> Value {
    let mut patch = match settings {
        Value::Object(value) => value.clone(),
        _ => Map::new(),
    };
    for key in ["apiKey", "apiKeyEnv", "baseUrl", "apiMode"] {
        patch.insert(key.into(), Value::Null);
    }
    Value::Object(patch)
}

fn is_native_cli_engine(engine: &str) -> bool {
    matches!(engine, "codex" | "claude-code")
}

fn is_native_cli_provider(engine: &str, provider: &str) -> bool {
    provider.is_empty()
        || provider == engine
        || (engine == "codex" && provider == "openai-codex")
        || (engine == "claude-code" && provider == "anthropic")
}

fn native_cli_default(config: &Value, context: &Value) -> bool {
    let engine = first_string(context, &["engine"])
        .or_else(|| first_string(config, &["agentEngine", "agent_engine"]))
        .unwrap_or_default();
    if !is_native_cli_engine(&engine) {
        return false;
    }
    let provider = explicit_provider_connection_id(config)
        .or_else(|| provider_from_profile_id(config))
        .or_else(|| first_string(config, &["provider", "modelProvider", "model_provider"]))
        .unwrap_or_default();
    is_native_cli_provider(&engine, &provider)
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
    use mia_core_db::{SqliteSettingsRepository, init_database_memory};
    use serde_json::json;

    async fn permission_service() -> AgentPermissionService {
        let database = init_database_memory().await.expect("memory db");
        AgentPermissionService::new(SqliteSettingsRepository::new(database.pool().clone()))
    }

    #[tokio::test]
    async fn agent_permissions_list_filter_and_remember_always_allow_rules() {
        let service = permission_service().await;
        let pending = service
            .enqueue_permission_request(AgentPermissionRequest {
                request_id: Some("perm_1".into()),
                engine: Some("codex".into()),
                bot_id: Some("mia".into()),
                session_id: Some("s1".into()),
                tool_name: Some("shell".into()),
                input: json!({ "command": "npm test" }),
                ..AgentPermissionRequest::default()
            })
            .await
            .expect("pending request");

        assert_eq!(pending.request_id, "perm_1");
        assert_eq!(pending.preview, "npm test");
        assert_eq!(pending.rule.subject_type, "command");
        assert_eq!(service.list_pending(Some("s1")).requests.len(), 1);
        assert_eq!(service.list_pending(Some("other")).requests.len(), 0);

        let response = service
            .respond(AgentPermissionRespondRequest {
                request_id: Some("perm_1".into()),
                decision: Some("allow_always".into()),
                ..AgentPermissionRespondRequest::default()
            })
            .await
            .expect("response");

        assert!(response.ok);
        assert!(service.list_pending(None).requests.is_empty());
        assert_eq!(service.load_rules().await.expect("rules").len(), 1);

        let remembered = service
            .remembered_decision(&AgentPermissionRequest {
                engine: Some("codex".into()),
                tool_name: Some("shell".into()),
                input: json!({ "command": "npm test" }),
                ..AgentPermissionRequest::default()
            })
            .await
            .expect("remembered")
            .expect("decision");
        assert_eq!(remembered.decision, "allow");
        assert_eq!(remembered.scope, "always");
        assert!(remembered.remembered);
    }

    #[tokio::test]
    async fn agent_permission_response_reports_missing_request_without_js_coordinator() {
        let service = permission_service().await;
        let response = service
            .respond(AgentPermissionRespondRequest {
                request_id: Some("missing".into()),
                decision: Some("allow_once".into()),
                ..AgentPermissionRespondRequest::default()
            })
            .await
            .expect("response");

        assert!(!response.ok);
        assert_eq!(
            response.error.as_deref(),
            Some("permission request not found")
        );
    }

    #[tokio::test]
    async fn agent_permission_mcp_titles_keep_real_tool_name_visible() {
        let service = permission_service().await;
        let pending = service
            .enqueue_permission_request(AgentPermissionRequest {
                request_id: Some("perm_mcp".into()),
                engine: Some("codex".into()),
                session_id: Some("s1".into()),
                tool_name: Some("xhs.search_notes".into()),
                title: Some("Codex 想使用 MCP 工具".into()),
                input: json!({ "q": "coffee" }),
                ..AgentPermissionRequest::default()
            })
            .await
            .expect("pending request");

        assert!(pending.title.contains("xhs.search_notes"));
        assert_eq!(pending.rule.subject_type, "input");
    }
}
