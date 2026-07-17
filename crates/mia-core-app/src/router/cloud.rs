use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use mia_core_api_types::{
    CloudBridgeCancelRequest, CloudBridgeCancelResponse, CloudBridgeLifecycleResponse,
    CloudBridgeRunRequest, CloudBridgeRunResponse, CloudBridgeRuntimeControlRequest,
    CloudBridgeStartRequest, CloudConnectRequest, CloudConnectResponse,
    CloudEventsLifecycleResponse, CloudEventsStartRequest, CloudMemorySyncRequest,
    CloudMemorySyncResponse, CloudSettingsResponse, CloudStatusResponse, PutCloudSettingsRequest,
    RuntimeControlChoice, RuntimeControlSnapshot,
};
use mia_core_cloud::CloudError;
use serde::Deserialize;

use super::state::ModuleStates;
use crate::cloud_bridge::{
    cancel_cloud_bridge_run as execute_cloud_bridge_cancel, complete_started_cloud_bridge_run,
    execute_cloud_bridge_run, start_cloud_bridge_run,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatusQuery {
    #[serde(default)]
    include_token: bool,
}

pub async fn cloud_status(
    State(states): State<ModuleStates>,
    Query(query): Query<CloudStatusQuery>,
) -> Result<Json<CloudStatusResponse>, StatusCode> {
    combined_cloud_status(&states, query.include_token)
        .await
        .map(Json)
        .map_err(map_cloud_status)
}

pub async fn connect_cloud(
    State(states): State<ModuleStates>,
    Json(request): Json<CloudConnectRequest>,
) -> Result<Json<CloudConnectResponse>, StatusCode> {
    states
        .cloud
        .connect(request)
        .await
        .map(Json)
        .map_err(map_cloud_status)
}

pub async fn disconnect_cloud(
    State(states): State<ModuleStates>,
) -> Result<Json<CloudStatusResponse>, StatusCode> {
    let _ = states.cloud_events.stop().await;
    let _ = states.cloud_bridge.stop().await;
    states
        .cloud
        .disconnect()
        .await
        .map(Json)
        .map_err(map_cloud_status)
}

pub async fn get_cloud_settings(
    State(states): State<ModuleStates>,
) -> Result<Json<CloudSettingsResponse>, StatusCode> {
    states
        .cloud
        .user_settings()
        .await
        .map(Json)
        .map_err(map_cloud_status)
}

pub async fn put_cloud_settings(
    State(states): State<ModuleStates>,
    Json(request): Json<PutCloudSettingsRequest>,
) -> Result<Json<CloudSettingsResponse>, StatusCode> {
    states
        .cloud
        .put_user_settings(request)
        .await
        .map(Json)
        .map_err(map_cloud_status)
}

pub async fn sync_cloud_memory(
    State(states): State<ModuleStates>,
    Json(request): Json<CloudMemorySyncRequest>,
) -> Result<Json<CloudMemorySyncResponse>, StatusCode> {
    states
        .cloud
        .sync_memories(request)
        .await
        .map(Json)
        .map_err(map_cloud_status)
}

pub async fn run_cloud_bridge(
    State(states): State<ModuleStates>,
    Json(request): Json<CloudBridgeRunRequest>,
) -> Result<Json<CloudBridgeRunResponse>, StatusCode> {
    execute_cloud_bridge_run(
        &states.cloud,
        &states.conversation,
        &states.tasks,
        &states.realtime,
        &states.runtime,
        &states.runtime_sessions,
        &states.mia_runtime_proxies,
        request,
    )
    .await
    .map(Json)
    .map_err(map_cloud_status)
}

pub async fn run_cloud_bridge_async(
    State(states): State<ModuleStates>,
    Json(request): Json<CloudBridgeRunRequest>,
) -> Result<Json<CloudBridgeRunResponse>, StatusCode> {
    let started = start_cloud_bridge_run(
        &states.cloud,
        &states.conversation,
        &states.realtime,
        &states.runtime,
        &states.mia_runtime_proxies,
        request,
    )
    .await
    .map_err(map_cloud_status)?;
    if !started.requires_background_runtime() {
        return complete_started_cloud_bridge_run(
            &states.conversation,
            &states.tasks,
            &states.realtime,
            &states.runtime,
            &states.runtime_sessions,
            started,
        )
        .await
        .map(Json)
        .map_err(map_cloud_status);
    }

    let accepted = started.accepted_response();
    let cloud_conversation_id = accepted.cloud_conversation_id.clone();
    let run_id = accepted.run_id.clone();
    let conversation = states.conversation.clone();
    let tasks = states.tasks.clone();
    let realtime = states.realtime.clone();
    let runtime = states.runtime.clone();
    let runtime_sessions = states.runtime_sessions.clone();
    tokio::spawn(async move {
        if let Err(error) = complete_started_cloud_bridge_run(
            &conversation,
            &tasks,
            &realtime,
            &runtime,
            &runtime_sessions,
            started,
        )
        .await
        {
            realtime.emit(
                "cloud_agent_run_event",
                serde_json::json!({
                    "conversationId": cloud_conversation_id,
                    "runId": run_id,
                    "event": {
                        "type": "error",
                        "message": error.to_string(),
                    },
                }),
            );
            tracing::warn!(error = %error, "background cloud bridge turn failed");
        }
    });
    Ok(Json(accepted))
}

pub async fn prepare_cloud_bridge_runtime_controls(
    State(states): State<ModuleStates>,
    Json(request): Json<CloudBridgeRunRequest>,
) -> Result<Json<RuntimeControlSnapshot>, StatusCode> {
    let (mut plan, runtime_config) = cloud_bridge_runtime_control_plan(&states, request).await?;
    states
        .mia_runtime_proxies
        .prepare_plan(&states.cloud, &runtime_config, &mut plan)
        .await
        .map_err(map_cloud_status)?;
    let mut snapshot = states
        .runtime_sessions
        .prepare_session(plan)
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, "prepare cloud bridge runtime controls failed");
            StatusCode::BAD_GATEWAY
        })?;
    augment_snapshot_with_mia_platform_models(&mut snapshot, &runtime_config, &states).await;
    Ok(Json(snapshot))
}

pub async fn set_cloud_bridge_runtime_control(
    State(states): State<ModuleStates>,
    Json(request): Json<CloudBridgeRuntimeControlRequest>,
) -> Result<Json<RuntimeControlSnapshot>, StatusCode> {
    let control_id = request.control_id.trim().to_string();
    let value = request.value.trim().to_string();
    let mut run = request.run;
    match control_id.as_str() {
        "model" => run.model = Some(value.clone()),
        "reasoning_effort" => run.effort_level = Some(value.clone()),
        _ => {}
    }
    let (mut plan, runtime_config) = cloud_bridge_runtime_control_plan(&states, run).await?;
    states
        .mia_runtime_proxies
        .prepare_plan(&states.cloud, &runtime_config, &mut plan)
        .await
        .map_err(map_cloud_status)?;
    let restarts_platform_session = control_id == "model"
        && plan
            .environment
            .get("MIA_PLATFORM_PROVIDER")
            .is_some_and(|provider| provider == "mia");
    let result = if restarts_platform_session {
        states.runtime_sessions.prepare_session(plan).await
    } else {
        states
            .runtime_sessions
            .set_control(plan, control_id, value)
            .await
    };
    let mut snapshot = result.map_err(|error| {
        tracing::warn!(error = %error, "set cloud bridge runtime control failed");
        StatusCode::BAD_REQUEST
    })?;
    augment_snapshot_with_mia_platform_models(&mut snapshot, &runtime_config, &states).await;
    Ok(Json(snapshot))
}

async fn cloud_bridge_runtime_control_plan(
    states: &ModuleStates,
    mut request: CloudBridgeRunRequest,
) -> Result<(mia_core_runtime::RuntimeTurnPlan, serde_json::Value), StatusCode> {
    enrich_native_runtime_model_entries(&mut request).await;
    let prepared = states
        .cloud
        .prepare_bridge_run(request)
        .map_err(map_cloud_status)?;
    let conversation = states
        .conversation
        .ensure_external_conversation(
            &prepared.local_conversation_id,
            "cloud-bridge",
            &prepared.title,
            None,
            prepared.metadata,
        )
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .conversation;
    let plan = states
        .conversation
        .plan_runtime_session(&conversation.id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((plan, prepared.runtime))
}

async fn enrich_native_runtime_model_entries(request: &mut CloudBridgeRunRequest) {
    let runtime_config = if request.runtime_config.is_object() {
        &request.runtime_config
    } else if request.config.is_object() {
        &request.config
    } else {
        return;
    };
    let engine = request
        .agent_engine
        .as_deref()
        .or(request.engine.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .or_else(|| {
            first_value_string(runtime_config, &["agentEngine", "agent_engine", "engine"])
                .map(|value| value.to_ascii_lowercase())
        })
        .unwrap_or_default();
    let runtime_kind = request
        .runtime_kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.replace('_', "-"))
        .or_else(|| {
            first_value_string(runtime_config, &["runtimeKind", "runtime_kind"])
                .map(|value| value.replace('_', "-"))
        })
        .unwrap_or_default();
    let engine = normalize_native_agent_engine(&engine);
    if engine.is_empty() || runtime_kind != "desktop-local" {
        return;
    }

    let mut models = mia_core_runtime::cached_agent_runtime_controls(&engine)
        .into_iter()
        .find(|control| control.category == "model")
        .map(|control| {
            control
                .options
                .into_iter()
                .map(|choice| {
                    serde_json::json!({
                        "id": choice.value,
                        "label": choice.label,
                        "description": choice.description
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if models.is_empty() && engine == "codex" {
        models = super::engine::load_codex_models().await;
    }
    let runtime_config = if request.runtime_config.is_object() {
        &mut request.runtime_config
    } else {
        &mut request.config
    };
    merge_discovered_native_model_entries(runtime_config, &engine, &models);
}

fn normalize_native_agent_engine(engine: &str) -> String {
    match engine.trim().to_ascii_lowercase().as_str() {
        "claude" | "claude-code" | "anthropic" => "claude-code".into(),
        "codex" | "openai-codex" => "codex".into(),
        "hermes" => "hermes".into(),
        _ => String::new(),
    }
}

fn native_agent_engine_label(engine: &str) -> &str {
    match engine {
        "claude-code" => "Claude Code",
        "codex" => "Codex CLI",
        "hermes" => "Hermes",
        _ => engine,
    }
}

fn merge_discovered_native_model_entries(
    runtime_config: &mut serde_json::Value,
    engine: &str,
    models: &[serde_json::Value],
) {
    let Some(object) = runtime_config.as_object_mut() else {
        return;
    };
    let existing = object
        .remove("modelEntries")
        .or_else(|| object.remove("model_entries"))
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let mut entries = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for model in models {
        let Some(id) = first_value_string(model, &["slug", "model", "id", "value"]) else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let label = first_value_string(model, &["displayName", "display_name", "label", "name"])
            .unwrap_or_else(|| id.clone());
        let profile_id = format!("{engine}:{id}");
        entries.push(serde_json::json!({
            "id": id.clone(),
            "value": id.clone(),
            "label": label,
            "model": id,
            "provider": engine,
            "providerConnectionId": engine,
            "providerLabel": native_agent_engine_label(engine),
            "modelProfileId": profile_id
        }));
    }
    for entry in existing {
        if !runtime_model_entry_is_mia(&entry) {
            if models.is_empty()
                && let Some(model) = first_value_string(&entry, &["model", "value", "id"])
                && seen.insert(model)
            {
                entries.push(entry);
            }
            continue;
        }
        let Some(model) = first_value_string(&entry, &["model", "value", "id"]) else {
            continue;
        };
        if seen.insert(model) {
            entries.push(entry);
        }
    }
    if !entries.is_empty() {
        object.insert("modelEntries".into(), serde_json::Value::Array(entries));
    }
}

async fn augment_snapshot_with_mia_platform_models(
    snapshot: &mut RuntimeControlSnapshot,
    runtime_config: &serde_json::Value,
    states: &ModuleStates,
) {
    let connected = states
        .cloud
        .status(false)
        .await
        .map(|status| status.connected)
        .unwrap_or(false);
    if !connected {
        return;
    }
    let Some(control) = snapshot
        .controls
        .iter_mut()
        .find(|control| control.category == "model")
    else {
        return;
    };
    let mut choices = vec![RuntimeControlChoice {
        value: "mia-auto".into(),
        label: "Auto".into(),
        description: "Mia platform model".into(),
    }];
    let include_discovered_native_models = control.source == "mia_provider";
    if let Some(entries) = runtime_config
        .get("modelEntries")
        .or_else(|| runtime_config.get("model_entries"))
        .and_then(serde_json::Value::as_array)
    {
        for entry in entries {
            if !runtime_model_entry_is_visible(entry, include_discovered_native_models) {
                continue;
            }
            if let Some(choice) = runtime_model_entry_choice(entry) {
                push_runtime_model_choice(&mut choices, choice);
            }
        }
    }
    for choice in choices {
        if control
            .options
            .iter()
            .any(|existing| existing.value == choice.value)
        {
            continue;
        }
        control.options.push(choice);
    }
}

fn runtime_model_entry_is_visible(
    entry: &serde_json::Value,
    include_discovered_native_models: bool,
) -> bool {
    include_discovered_native_models || runtime_model_entry_is_mia(entry)
}

fn runtime_model_entry_choice(entry: &serde_json::Value) -> Option<RuntimeControlChoice> {
    let raw_model = first_value_string(entry, &["model", "value", "id"])?;
    let model = if raw_model == "mia-default" {
        "mia-auto".to_string()
    } else {
        raw_model
    };
    let label = first_value_string(entry, &["label", "displayName", "display_name", "name"])
        .unwrap_or_else(|| {
            if model == "mia-auto" {
                "Auto".to_string()
            } else {
                model.clone()
            }
        });
    Some(RuntimeControlChoice {
        value: model,
        label,
        description: if runtime_model_entry_is_mia(entry) {
            "Mia platform model".into()
        } else {
            "Agent native model".into()
        },
    })
}

fn runtime_model_entry_is_mia(entry: &serde_json::Value) -> bool {
    first_value_string(
        entry,
        &["provider", "providerConnectionId", "provider_connection_id"],
    )
    .as_deref()
        == Some("mia")
        || first_value_string(entry, &["authType", "auth_type"]).as_deref() == Some("mia_account")
        || first_value_string(
            entry,
            &[
                "modelProfileId",
                "model_profile_id",
                "profileId",
                "profile_id",
            ],
        )
        .is_some_and(|value| value.starts_with("mia:"))
        || first_value_string(entry, &["model", "value", "id"])
            .is_some_and(|value| matches!(value.as_str(), "mia-auto" | "mia-default"))
}

fn push_runtime_model_choice(
    choices: &mut Vec<RuntimeControlChoice>,
    choice: RuntimeControlChoice,
) {
    if choice.value.is_empty()
        || choices
            .iter()
            .any(|existing| existing.value == choice.value)
    {
        return;
    }
    choices.push(choice);
}

fn first_value_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::{
        merge_discovered_native_model_entries, push_runtime_model_choice,
        runtime_model_entry_choice, runtime_model_entry_is_visible,
    };
    use mia_core_api_types::RuntimeControlChoice;
    use serde_json::json;

    #[test]
    fn runtime_model_choices_keep_platform_and_native_identity_distinct() {
        let auto = runtime_model_entry_choice(&json!({
            "model": "mia-auto",
            "label": "Auto",
            "provider": "mia"
        }))
        .expect("Auto should be a runtime choice");
        let native = runtime_model_entry_choice(&json!({
            "model": "gpt-5.6-sol",
            "label": "GPT-5.6-Sol",
            "provider": "codex"
        }))
        .expect("Codex model should be a runtime choice");

        assert_eq!(auto.description, "Mia platform model");
        assert_eq!(native.description, "Agent native model");
        assert_eq!(native.label, "GPT-5.6-Sol");

        let mut choices = vec![RuntimeControlChoice {
            value: "mia-auto".into(),
            label: "Auto".into(),
            description: "Mia platform model".into(),
        }];
        push_runtime_model_choice(&mut choices, auto);
        push_runtime_model_choice(&mut choices, native);
        assert_eq!(choices.len(), 2);
        assert_eq!(choices[1].value, "gpt-5.6-sol");
        assert!(runtime_model_entry_is_visible(
            &json!({ "model": "mia-auto", "provider": "mia" }),
            false
        ));
        assert!(!runtime_model_entry_is_visible(
            &json!({ "model": "gpt-5.6-sol", "provider": "codex" }),
            false
        ));
        assert!(runtime_model_entry_is_visible(
            &json!({ "model": "gpt-5.6-sol", "provider": "codex" }),
            true
        ));
    }

    #[test]
    fn discovered_native_models_replace_stale_entries_without_a_builtin_catalog() {
        let mut runtime = json!({
            "modelEntries": [
                { "model": "old-model", "provider": "codex" },
                { "model": "mia-auto", "provider": "mia", "label": "Auto" }
            ]
        });
        merge_discovered_native_model_entries(
            &mut runtime,
            "claude-code",
            &[json!({
                "id": "future-native-model",
                "label": "Future Native Model"
            })],
        );

        let entries = runtime["modelEntries"].as_array().expect("model entries");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["model"], "future-native-model");
        assert_eq!(entries[0]["label"], "Future Native Model");
        assert_eq!(entries[0]["provider"], "claude-code");
        assert_eq!(
            entries[0]["modelProfileId"],
            "claude-code:future-native-model"
        );
        assert_eq!(entries[1]["model"], "mia-auto");
        assert!(!entries.iter().any(|entry| entry["model"] == "old-model"));
    }

    #[test]
    fn empty_discovery_keeps_live_native_session_models() {
        let mut runtime = json!({
            "modelEntries": [
                {
                    "model": "runtime-advertised-model",
                    "provider": "hermes",
                    "modelProfileId": "hermes:runtime-advertised-model"
                },
                { "model": "mia-auto", "provider": "mia", "label": "Auto" }
            ]
        });

        merge_discovered_native_model_entries(&mut runtime, "hermes", &[]);

        let entries = runtime["modelEntries"].as_array().expect("model entries");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["model"], "runtime-advertised-model");
        assert_eq!(entries[0]["provider"], "hermes");
        assert_eq!(entries[1]["model"], "mia-auto");
    }
}

pub async fn cancel_cloud_bridge_run(
    State(states): State<ModuleStates>,
    Json(request): Json<CloudBridgeCancelRequest>,
) -> Result<Json<CloudBridgeCancelResponse>, StatusCode> {
    execute_cloud_bridge_cancel(&states.realtime, &states.runtime, request)
        .await
        .map(Json)
        .map_err(map_cloud_status)
}

pub async fn start_cloud_bridge(
    State(states): State<ModuleStates>,
    Json(request): Json<CloudBridgeStartRequest>,
) -> Result<Json<CloudBridgeLifecycleResponse>, StatusCode> {
    states
        .cloud_bridge
        .start(request)
        .await
        .map(Json)
        .map_err(map_cloud_status)
}

pub async fn stop_cloud_bridge(
    State(states): State<ModuleStates>,
) -> Result<Json<CloudBridgeLifecycleResponse>, StatusCode> {
    states
        .cloud_bridge
        .stop()
        .await
        .map(Json)
        .map_err(map_cloud_status)
}

pub async fn start_cloud_events(
    State(states): State<ModuleStates>,
    Json(_request): Json<CloudEventsStartRequest>,
) -> Result<Json<CloudEventsLifecycleResponse>, StatusCode> {
    states
        .cloud_events
        .start()
        .await
        .map(Json)
        .map_err(map_cloud_status)
}

pub async fn stop_cloud_events(
    State(states): State<ModuleStates>,
) -> Result<Json<CloudEventsLifecycleResponse>, StatusCode> {
    states
        .cloud_events
        .stop()
        .await
        .map(Json)
        .map_err(map_cloud_status)
}

async fn combined_cloud_status(
    states: &ModuleStates,
    include_token: bool,
) -> Result<CloudStatusResponse, CloudError> {
    let mut status = states.cloud_bridge.status(include_token).await?;
    states.cloud_events.apply_status(&mut status).await?;
    Ok(status)
}

fn map_cloud_status(error: CloudError) -> StatusCode {
    tracing::error!(error = %error, "cloud request failed");
    match error {
        CloudError::InvalidInput(_) => StatusCode::BAD_REQUEST,
        CloudError::Transport(_) => StatusCode::BAD_GATEWAY,
        CloudError::Busy(_) => StatusCode::CONFLICT,
        CloudError::Runtime(_) => StatusCode::INTERNAL_SERVER_ERROR,
        CloudError::Memory(_) => StatusCode::INTERNAL_SERVER_ERROR,
        CloudError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
