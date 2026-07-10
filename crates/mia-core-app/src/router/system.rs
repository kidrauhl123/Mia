use std::collections::HashMap;

use axum::Json;
use axum::extract::Query;
use axum::extract::State;
use axum::http::StatusCode;
use mia_core_api_types::{
    AgentPermissionListResponse, AgentPermissionRespondRequest, AgentPermissionRespondResponse,
    AgentWorkspaceResponse, ClientSettingsResponse, CreateProviderRequest, MemorySettingsResponse,
    PatchClientSettingsRequest, PrepareHermesRuntimeConfigRequest,
    PrepareHermesRuntimeConfigResponse, ProviderListResponse, ProviderResponse,
    ProviderTestRequest, ProviderTestResponse, ResolveModelRuntimeRequest,
    ResolveModelRuntimeResponse, SaveAgentWorkspaceRequest, SaveMemorySettingsRequest,
    SaveModelSelectionRequest, SaveModelSelectionResponse, SettingsRuntimeControlOptionsRequest,
    SettingsRuntimeControlOptionsResponse, SystemStatusResponse,
};
use mia_core_system::SystemError;

use super::state::ModuleStates;

pub async fn system_status(State(states): State<ModuleStates>) -> Json<SystemStatusResponse> {
    Json(states.system.status())
}

pub async fn get_client_settings(
    State(states): State<ModuleStates>,
) -> Result<Json<ClientSettingsResponse>, StatusCode> {
    states
        .system
        .client_settings()
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn patch_client_settings(
    State(states): State<ModuleStates>,
    Json(request): Json<PatchClientSettingsRequest>,
) -> Result<Json<ClientSettingsResponse>, StatusCode> {
    states
        .system
        .patch_client_settings(request.patch)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn get_agent_workspace(
    State(states): State<ModuleStates>,
) -> Result<Json<AgentWorkspaceResponse>, StatusCode> {
    states
        .system
        .agent_workspace(&states.workspace_dir)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn save_agent_workspace(
    State(states): State<ModuleStates>,
    Json(request): Json<SaveAgentWorkspaceRequest>,
) -> Result<Json<AgentWorkspaceResponse>, StatusCode> {
    states
        .system
        .save_agent_workspace(request, &states.workspace_dir)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn get_memory_settings(
    State(states): State<ModuleStates>,
) -> Result<Json<MemorySettingsResponse>, StatusCode> {
    states
        .system
        .memory_settings()
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn save_memory_settings(
    State(states): State<ModuleStates>,
    Json(request): Json<SaveMemorySettingsRequest>,
) -> Result<Json<MemorySettingsResponse>, StatusCode> {
    states
        .system
        .save_memory_settings(request)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn list_agent_permissions(
    State(states): State<ModuleStates>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<AgentPermissionListResponse> {
    Json(
        states
            .runtime_sessions
            .list_pending_permissions(params.get("sessionId").map(String::as_str)),
    )
}

pub async fn respond_agent_permission(
    State(states): State<ModuleStates>,
    Json(request): Json<AgentPermissionRespondRequest>,
) -> Json<AgentPermissionRespondResponse> {
    Json(states.runtime_sessions.respond_permission(request))
}

pub async fn save_model_selection(
    State(states): State<ModuleStates>,
    Json(request): Json<SaveModelSelectionRequest>,
) -> Result<Json<SaveModelSelectionResponse>, StatusCode> {
    states
        .system
        .save_model_selection(request)
        .await
        .map(Json)
        .map_err(map_system_status)
}

pub async fn settings_runtime_control_options(
    State(states): State<ModuleStates>,
    Json(request): Json<SettingsRuntimeControlOptionsRequest>,
) -> Json<SettingsRuntimeControlOptionsResponse> {
    Json(states.system.runtime_control_options(request))
}

pub async fn list_providers(
    State(states): State<ModuleStates>,
) -> Result<Json<ProviderListResponse>, StatusCode> {
    states
        .system
        .list_providers()
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn create_provider(
    State(states): State<ModuleStates>,
    Json(request): Json<CreateProviderRequest>,
) -> Result<Json<ProviderResponse>, StatusCode> {
    states
        .system
        .create_provider(request)
        .await
        .map(Json)
        .map_err(map_system_status)
}

pub async fn test_provider(
    State(states): State<ModuleStates>,
    Json(request): Json<ProviderTestRequest>,
) -> Result<Json<ProviderTestResponse>, StatusCode> {
    states
        .system
        .test_provider(request.provider_id, request.candidate)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn resolve_model_runtime(
    State(states): State<ModuleStates>,
    Json(request): Json<ResolveModelRuntimeRequest>,
) -> Result<Json<ResolveModelRuntimeResponse>, StatusCode> {
    states
        .system
        .resolve_model_runtime(request.config, request.context)
        .await
        .map(Json)
        .map_err(map_system_status)
}

pub async fn prepare_hermes_runtime_config(
    State(states): State<ModuleStates>,
    Json(request): Json<PrepareHermesRuntimeConfigRequest>,
) -> Result<Json<PrepareHermesRuntimeConfigResponse>, StatusCode> {
    states
        .system
        .prepare_hermes_runtime_config(request)
        .await
        .map(Json)
        .map_err(map_system_status)
}

fn map_system_status(error: SystemError) -> StatusCode {
    match error {
        SystemError::InvalidInput(_) => StatusCode::BAD_REQUEST,
        SystemError::Io(_) | SystemError::Yaml(_) => StatusCode::INTERNAL_SERVER_ERROR,
        SystemError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
