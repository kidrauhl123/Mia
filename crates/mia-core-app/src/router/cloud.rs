use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use mia_core_api_types::{
    CloudBridgeCancelRequest, CloudBridgeCancelResponse, CloudBridgeLifecycleResponse,
    CloudBridgeRunRequest, CloudBridgeRunResponse, CloudBridgeStartRequest, CloudConnectRequest,
    CloudConnectResponse, CloudEventsLifecycleResponse, CloudEventsStartRequest,
    CloudMemorySyncRequest, CloudMemorySyncResponse, CloudSettingsResponse, CloudStatusResponse,
    PutCloudSettingsRequest,
};
use mia_core_cloud::CloudError;
use serde::Deserialize;

use super::state::ModuleStates;
use crate::cloud_bridge::{
    cancel_cloud_bridge_run as execute_cloud_bridge_cancel, execute_cloud_bridge_run,
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
        &states.realtime,
        &states.runtime,
        &states.runtime_sessions,
        request,
    )
    .await
    .map(Json)
    .map_err(map_cloud_status)
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
    match error {
        CloudError::InvalidInput(_) => StatusCode::BAD_REQUEST,
        CloudError::Transport(_) => StatusCode::BAD_GATEWAY,
        CloudError::Busy(_) => StatusCode::CONFLICT,
        CloudError::Runtime(_) => StatusCode::INTERNAL_SERVER_ERROR,
        CloudError::Memory(_) => StatusCode::INTERNAL_SERVER_ERROR,
        CloudError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
