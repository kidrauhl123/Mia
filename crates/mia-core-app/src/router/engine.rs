use std::env;
use std::path::PathBuf;
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use mia_core_api_types::{
    CodexModelListResponse, EngineCapabilitiesResponse, EngineModelCatalogResponse,
    SlashCommandItem, SlashCommandListResponse,
};
use mia_core_common::process::configure_background_command;
use mia_core_runtime::{AgentEngineInventory, AgentEngineScanOptions, AgentEngineScanner};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::time::timeout;

use super::state::ModuleStates;

pub async fn engine_model_catalog(
    State(states): State<ModuleStates>,
) -> Json<EngineModelCatalogResponse> {
    let models = load_hermes_model_catalog(&states)
        .await
        .unwrap_or_else(fallback_model_catalog);
    Json(EngineModelCatalogResponse { models })
}

pub async fn codex_models() -> Json<CodexModelListResponse> {
    Json(CodexModelListResponse {
        models: load_codex_models().await,
    })
}

pub async fn engine_capabilities(
    State(states): State<ModuleStates>,
) -> Json<EngineCapabilitiesResponse> {
    let hermes = load_hermes_engine_capabilities(&states).await;
    let codex = load_codex_models().await;
    let codex_effort_options = codex_effort_options_from_models(&codex);
    let codex_effort_levels = codex_effort_options
        .iter()
        .filter_map(|item| item.get("value").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();

    Json(EngineCapabilitiesResponse {
        approval_modes: hermes.approval_modes.clone(),
        effort_levels: hermes.effort_levels.clone(),
        engines: json!({
            "hermes": {
                "approvalModes": hermes.approval_modes,
                "effortLevels": hermes.effort_levels
            },
            "claude-code": {
                "available": false,
                "cliPath": "",
                "models": [],
                "currentModel": "",
                "currentEffortLevel": "",
                "effortLevels": [],
                "effortOptions": [],
                "permissionModes": [],
                "permissionOptions": [],
                "source": "claude-code",
                "error": ""
            },
            "codex": {
                "models": codex,
                "effortLevels": codex_effort_levels,
                "effortOptions": codex_effort_options,
                "permissionProfiles": []
            }
        }),
    })
}

pub async fn hermes_slash_commands(
    State(states): State<ModuleStates>,
) -> Json<SlashCommandListResponse> {
    Json(SlashCommandListResponse {
        commands: load_hermes_slash_commands(&states).await,
    })
}

pub async fn agent_engines(State(states): State<ModuleStates>) -> Json<AgentEngineInventory> {
    let scanner = AgentEngineScanner::real();
    Json(
        scanner
            .scan(AgentEngineScanOptions::current(states.workspace_dir))
            .await,
    )
}

#[derive(Debug, Clone)]
struct HermesCapabilities {
    approval_modes: Vec<String>,
    effort_levels: Vec<String>,
}

impl Default for HermesCapabilities {
    fn default() -> Self {
        Self {
            approval_modes: Vec::new(),
            effort_levels: Vec::new(),
        }
    }
}

async fn load_hermes_model_catalog(states: &ModuleStates) -> Option<Vec<Value>> {
    if !hermes_engine_dir(states).is_dir() {
        return None;
    }

    let script = r#"
import json

def choose_env(envs):
    values = [str(item or "").strip() for item in (envs or []) if str(item or "").strip()]
    preferred = [item for item in values if item.endswith("_API_KEY")]
    return (preferred or values or [""])[0]

try:
    from hermes_cli.models import CANONICAL_PROVIDERS
    from hermes_cli import models as hermes_models
    from hermes_cli.providers import get_provider, determine_api_mode
except Exception:
    import models as hermes_models
    from models import CANONICAL_PROVIDERS
    from providers import get_provider, determine_api_mode

rows = []
seen = set()
static_provider_models = getattr(hermes_models, "_PROVIDER_MODELS", {}) or {}
openrouter_models = getattr(hermes_models, "OPENROUTER_MODELS", []) or []
for entry in CANONICAL_PROVIDERS:
    provider = str(entry.slug)
    pdef = get_provider(provider)
    provider_label = str(getattr(entry, "label", "") or getattr(pdef, "name", "") or provider)
    auth_type = str(getattr(pdef, "auth_type", "") or "api_key")
    api_key_env = choose_env(getattr(pdef, "api_key_env_vars", ()) if pdef else ())
    base_url = str(getattr(pdef, "base_url", "") or "")
    api_mode = determine_api_mode(provider, base_url)
    if provider == "openrouter":
        models = [item[0] if isinstance(item, (tuple, list)) and item else item for item in openrouter_models]
    else:
        models = list(static_provider_models.get(provider, []))
    if not models:
        models = [""]
    for model in models:
        model_id = str(model or "").strip()
        key = f"{provider}::{model_id}"
        if key in seen:
            continue
        seen.add(key)
        rows.append({
            "id": key,
            "provider": provider,
            "providerLabel": provider_label,
            "model": model_id,
            "label": model_id or "LM Studio current loaded model",
            "authType": auth_type,
            "apiKeyEnv": "" if auth_type.startswith("oauth") else api_key_env,
            "baseUrl": base_url,
            "apiMode": api_mode,
        })
print(json.dumps(rows))
"#;
    let stdout = run_hermes_python(states, script, Duration::from_secs(15)).await?;
    match serde_json::from_str::<Value>(&stdout).ok()? {
        Value::Array(rows) if !rows.is_empty() => Some(rows),
        _ => None,
    }
}

async fn load_hermes_engine_capabilities(states: &ModuleStates) -> HermesCapabilities {
    if !hermes_engine_dir(states).is_dir() {
        return HermesCapabilities::default();
    }

    let script = r#"
import json
result = {"approvalModes": [], "effortLevels": []}
try:
    from hermes_cli.web_server import SETTINGS_SCHEMA
    if "approvals.mode" in SETTINGS_SCHEMA and "options" in SETTINGS_SCHEMA["approvals.mode"]:
        result["approvalModes"] = list(SETTINGS_SCHEMA["approvals.mode"]["options"])
    if "agent.reasoning_effort" in SETTINGS_SCHEMA and "options" in SETTINGS_SCHEMA["agent.reasoning_effort"]:
        result["effortLevels"] = list(SETTINGS_SCHEMA["agent.reasoning_effort"]["options"])
except Exception:
    pass
print(json.dumps(result))
"#;

    let Some(stdout) = run_hermes_python(states, script, Duration::from_secs(8)).await else {
        return HermesCapabilities::default();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&stdout) else {
        return HermesCapabilities::default();
    };
    let approval_modes = unique_string_array(parsed.get("approvalModes"));
    let effort_levels = unique_string_array(parsed.get("effortLevels"));
    if approval_modes.is_empty() || effort_levels.is_empty() {
        return HermesCapabilities::default();
    }
    HermesCapabilities {
        approval_modes,
        effort_levels,
    }
}

async fn load_hermes_slash_commands(states: &ModuleStates) -> Vec<SlashCommandItem> {
    if !hermes_engine_dir(states).is_dir() {
        return Vec::new();
    }

    let script = r#"
import json
try:
    from hermes_cli.commands import telegram_menu_commands
    commands, hidden = telegram_menu_commands(100)
    rows = [{"command": "/" + name, "description": desc} for name, desc in commands]
except Exception:
    rows = []
print(json.dumps(rows))
"#;
    let Some(stdout) = run_hermes_python(states, script, Duration::from_secs(15)).await else {
        return Vec::new();
    };
    let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(&stdout) else {
        return Vec::new();
    };

    rows.into_iter()
        .filter_map(|item| {
            let command = string_field(&item, &["command", "name"]);
            let description = string_field(&item, &["description"]);
            if command.is_empty() || description.is_empty() {
                return None;
            }
            Some(SlashCommandItem {
                command: if command.starts_with('/') {
                    command
                } else {
                    format!("/{command}")
                },
                description,
            })
        })
        .collect()
}

pub(super) async fn load_codex_models() -> Vec<Value> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let cache_path = home.join(".codex").join("models_cache.json");
    let Ok(raw) = tokio::fs::read_to_string(cache_path).await else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let models = parsed
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    normalize_codex_models(&models)
}

fn normalize_codex_models(models: &[Value]) -> Vec<Value> {
    let mut rows = models
        .iter()
        .enumerate()
        .filter(|(_, model)| {
            !matches!(
                model.get("visibility").and_then(Value::as_str),
                Some("hide")
            ) && model.get("hidden").and_then(Value::as_bool) != Some(true)
        })
        .filter_map(|(index, model)| normalize_codex_model(model, index))
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| priority_value(a).total_cmp(&priority_value(b)));
    rows
}

fn normalize_codex_model(model: &Value, index: usize) -> Option<Value> {
    let slug = string_field(model, &["slug", "model", "id"]);
    if slug.is_empty() {
        return None;
    }
    let supported_reasoning_levels = supported_reasoning_levels(model);
    Some(json!({
        "slug": slug,
        "displayName": string_field(model, &["display_name", "displayName", "name"]).if_empty(&slug),
        "description": string_field(model, &["description"]),
        "priority": model.get("priority").and_then(Value::as_f64).unwrap_or(index as f64),
        "defaultReasoningLevel": string_field(model, &["default_reasoning_level", "defaultReasoningEffort"]),
        "supportedReasoningLevels": supported_reasoning_levels
    }))
}

fn supported_reasoning_levels(model: &Value) -> Vec<Value> {
    let mut rows = Vec::new();
    for key in ["supported_reasoning_levels", "supportedReasoningEfforts"] {
        if let Some(items) = model.get(key).and_then(Value::as_array) {
            rows.extend(items.iter().filter_map(normalize_codex_reasoning_option));
        }
    }
    rows
}

fn normalize_codex_reasoning_option(option: &Value) -> Option<Value> {
    let effort = option
        .as_str()
        .map(|item| item.trim().to_owned())
        .unwrap_or_else(|| {
            string_field(option, &["effort", "reasoningEffort", "reasoning_effort"])
        });
    if effort.is_empty() {
        return None;
    }
    Some(json!({
        "effort": effort,
        "description": string_field(option, &["description"])
    }))
}

fn codex_effort_options_from_models(models: &[Value]) -> Vec<Value> {
    let mut seen = Vec::<String>::new();
    let mut options = Vec::new();
    for model in models {
        let Some(items) = model
            .get("supportedReasoningLevels")
            .and_then(Value::as_array)
        else {
            continue;
        };
        for item in items {
            let value = string_field(item, &["effort"]);
            if value.is_empty() || seen.contains(&value) {
                continue;
            }
            seen.push(value.clone());
            options.push(json!({
                "value": value,
                "description": string_field(item, &["description"])
            }));
        }
    }
    options
}

fn fallback_model_catalog() -> Vec<Value> {
    vec![
        json!({
            "id": "xai::grok-4.1-fast",
            "provider": "xai",
            "providerLabel": "xAI",
            "model": "grok-4.1-fast",
            "label": "grok-4.1-fast",
            "authType": "api_key",
            "apiKeyEnv": "XAI_API_KEY",
            "baseUrl": "",
            "apiMode": "chat_completions"
        }),
        json!({
            "id": "openrouter::anthropic/claude-sonnet-4.6",
            "provider": "openrouter",
            "providerLabel": "OpenRouter",
            "model": "anthropic/claude-sonnet-4.6",
            "label": "anthropic/claude-sonnet-4.6",
            "authType": "api_key",
            "apiKeyEnv": "OPENROUTER_API_KEY",
            "baseUrl": "",
            "apiMode": "chat_completions"
        }),
        json!({
            "id": "anthropic::claude-sonnet-4-6",
            "provider": "anthropic",
            "providerLabel": "Anthropic",
            "model": "claude-sonnet-4-6",
            "label": "claude-sonnet-4-6",
            "authType": "api_key",
            "apiKeyEnv": "ANTHROPIC_API_KEY",
            "baseUrl": "",
            "apiMode": "anthropic_messages"
        }),
        json!({
            "id": "deepseek::deepseek-chat",
            "provider": "deepseek",
            "providerLabel": "DeepSeek",
            "model": "deepseek-chat",
            "label": "deepseek-chat",
            "authType": "api_key",
            "apiKeyEnv": "DEEPSEEK_API_KEY",
            "baseUrl": "",
            "apiMode": "chat_completions"
        }),
    ]
}

async fn run_hermes_python(
    states: &ModuleStates,
    script: &str,
    timeout_after: Duration,
) -> Option<String> {
    let engine_dir = hermes_engine_dir(states);
    if !engine_dir.is_dir() {
        return None;
    }

    let mut command = Command::new(python_bin());
    configure_background_command(command.as_std_mut());
    command.arg("-c").arg(script);
    command.current_dir(&engine_dir);
    command.env("HERMES_HOME", hermes_home(states));
    command.env("MIA_HOME", mia_home(states));
    command.env("MIA_PLUGINS_DIR", plugins_dir(states));
    command.env("PYTHONPATH", python_path(states));
    command.env("PYTHONUNBUFFERED", "1");

    let output = timeout(timeout_after, command.output()).await.ok()?.ok()?;
    if !output.status.success() {
        tracing::debug!(
            status = ?output.status.code(),
            stderr = %String::from_utf8_lossy(&output.stderr),
            "Hermes Python discovery script failed"
        );
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

fn hermes_engine_dir(states: &ModuleStates) -> PathBuf {
    env_path("MIA_HERMES_ENGINE_DIR")
        .unwrap_or_else(|| sibling_runtime_dir(states, "hermes-engine"))
}

fn plugins_dir(states: &ModuleStates) -> PathBuf {
    env_path("MIA_PLUGINS_DIR").unwrap_or_else(|| sibling_runtime_dir(states, "mia-plugins"))
}

fn hermes_home(states: &ModuleStates) -> PathBuf {
    env_path("HERMES_HOME").unwrap_or_else(|| states.data_dir.join(".hermes"))
}

fn mia_home(states: &ModuleStates) -> PathBuf {
    env_path("MIA_HOME").unwrap_or_else(|| states.data_dir.clone())
}

fn sibling_runtime_dir(states: &ModuleStates, name: &str) -> PathBuf {
    states
        .data_dir
        .parent()
        .map(|parent| parent.join(name))
        .unwrap_or_else(|| states.data_dir.join(name))
}

fn python_bin() -> String {
    env::var("MIA_ENGINE_PYTHON")
        .or_else(|_| env::var("MIA_PYTHON"))
        .or_else(|_| env::var("PYTHON"))
        .unwrap_or_else(|_| "python3".to_owned())
}

fn python_path(states: &ModuleStates) -> String {
    let mut parts = vec![plugins_dir(states).to_string_lossy().to_string()];
    if let Ok(existing) = env::var("PYTHONPATH")
        && !existing.trim().is_empty()
    {
        parts.push(existing);
    }
    parts.join(if cfg!(windows) { ";" } else { ":" })
}

fn home_dir() -> Option<PathBuf> {
    env_path("HOME").or_else(|| env_path("USERPROFILE"))
}

fn env_path(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn string_field(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .unwrap_or("")
        .to_owned()
}

fn unique_string_array(value: Option<&Value>) -> Vec<String> {
    let mut rows = Vec::new();
    let Some(items) = value.and_then(Value::as_array) else {
        return rows;
    };
    for item in items {
        let Some(text) = item.as_str().map(str::trim).filter(|text| !text.is_empty()) else {
            continue;
        };
        if !rows.iter().any(|seen| seen == text) {
            rows.push(text.to_owned());
        }
    }
    rows
}

fn priority_value(model: &Value) -> f64 {
    model.get("priority").and_then(Value::as_f64).unwrap_or(0.0)
}

trait EmptyStringExt {
    fn if_empty(self, fallback: &str) -> String;
}

impl EmptyStringExt for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_owned()
        } else {
            self
        }
    }
}
