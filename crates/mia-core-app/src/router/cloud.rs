use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use mia_core_api_types::{
    AcpRuntimeControlChoice, AcpRuntimeControlSnapshot, CloudBridgeCancelRequest,
    CloudBridgeCancelResponse, CloudBridgeLifecycleResponse, CloudBridgeRunRequest,
    CloudBridgeRunResponse, CloudBridgeRuntimeControlRequest, CloudBridgeStartRequest,
    CloudConnectRequest, CloudConnectResponse, CloudEventsLifecycleResponse,
    CloudEventsStartRequest, CloudMemorySyncRequest, CloudMemorySyncResponse,
    CloudSettingsResponse, CloudStatusResponse, PutCloudSettingsRequest,
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
) -> Result<Json<AcpRuntimeControlSnapshot>, StatusCode> {
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
            tracing::warn!(error = %error, "prepare cloud bridge ACP controls failed");
            StatusCode::BAD_GATEWAY
        })?;
    augment_snapshot_with_mia_platform_models(&mut snapshot, &runtime_config, &states).await;
    Ok(Json(snapshot))
}

pub async fn set_cloud_bridge_runtime_control(
    State(states): State<ModuleStates>,
    Json(request): Json<CloudBridgeRuntimeControlRequest>,
) -> Result<Json<AcpRuntimeControlSnapshot>, StatusCode> {
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
    let restarts_platform_session = matches!(control_id.as_str(), "model" | "reasoning_effort")
        && (control_id == "model" || matches!(plan.engine.as_str(), "codex" | "hermes"))
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
        tracing::warn!(error = %error, "set cloud bridge ACP control failed");
        StatusCode::BAD_REQUEST
    })?;
    augment_snapshot_with_mia_platform_models(&mut snapshot, &runtime_config, &states).await;
    Ok(Json(snapshot))
}

async fn cloud_bridge_runtime_control_plan(
    states: &ModuleStates,
    request: CloudBridgeRunRequest,
) -> Result<(mia_core_runtime::RuntimeTurnPlan, serde_json::Value), StatusCode> {
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

async fn augment_snapshot_with_mia_platform_models(
    snapshot: &mut AcpRuntimeControlSnapshot,
    runtime_config: &serde_json::Value,
    states: &ModuleStates,
) {
    if snapshot
        .controls
        .iter()
        .any(|control| control.category == "model" && control.source == "mia_provider")
    {
        return;
    }
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
    let mut models = Vec::new();
    push_mia_platform_model_choice(&mut models, "mia-auto");
    if let Some(entries) = runtime_config
        .get("modelEntries")
        .or_else(|| runtime_config.get("model_entries"))
        .and_then(serde_json::Value::as_array)
    {
        for entry in entries {
            if !runtime_model_entry_is_mia(entry) {
                continue;
            }
            if let Some(model) = first_value_string(entry, &["model", "value", "id"]) {
                push_mia_platform_model_choice(&mut models, &model);
            }
        }
    }
    for model in models {
        if control.options.iter().any(|choice| choice.value == model) {
            continue;
        }
        let label = if matches!(model.as_str(), "mia-auto" | "mia-default") {
            "Auto".to_string()
        } else {
            model.clone()
        };
        control.options.push(AcpRuntimeControlChoice {
            value: model,
            label,
            description: "Mia platform model".into(),
        });
    }
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

fn push_mia_platform_model_choice(models: &mut Vec<String>, model: &str) {
    let model = match model.trim() {
        "mia-default" => "mia-auto",
        other => other,
    };
    if model.is_empty() || models.iter().any(|existing| existing == model) {
        return;
    }
    models.push(model.to_string());
}

fn first_value_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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
