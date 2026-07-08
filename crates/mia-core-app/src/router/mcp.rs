use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use mia_core_api_types::{
    CreateMcpServerRequest, EmptyResponse, McpAgentConfigsResponse, McpOAuthActionResponse,
    McpServerListResponse, McpServerResponse, McpServerTestResponse, UpdateMcpServerRequest,
};
use mia_core_mcp::McpError;
use serde_json::{Value, json};

use super::state::ModuleStates;

pub async fn list_mcp_servers(
    State(states): State<ModuleStates>,
) -> Result<Json<McpServerListResponse>, StatusCode> {
    states
        .mcp
        .list_servers()
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn create_mcp_server(
    State(states): State<ModuleStates>,
    Json(request): Json<CreateMcpServerRequest>,
) -> Result<Json<McpServerResponse>, StatusCode> {
    states
        .mcp
        .create_server(request)
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn get_mcp_server(
    State(states): State<ModuleStates>,
    Path(server_id): Path<String>,
) -> Result<Json<McpServerResponse>, StatusCode> {
    states
        .mcp
        .get_server(&server_id)
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn update_mcp_server(
    State(states): State<ModuleStates>,
    Path(server_id): Path<String>,
    Json(request): Json<UpdateMcpServerRequest>,
) -> Result<Json<McpServerResponse>, StatusCode> {
    states
        .mcp
        .update_server(&server_id, request)
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn delete_mcp_server(
    State(states): State<ModuleStates>,
    Path(server_id): Path<String>,
) -> Result<Json<EmptyResponse>, StatusCode> {
    states
        .mcp
        .delete_server(&server_id)
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn test_mcp_server(
    State(states): State<ModuleStates>,
    Path(server_id): Path<String>,
) -> Result<Json<McpServerTestResponse>, StatusCode> {
    states
        .mcp
        .test_server(&server_id)
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn import_mcp_servers(
    State(states): State<ModuleStates>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let input = payload.get("input").cloned().unwrap_or_else(|| json!({}));
    let replace_duplicates = payload
        .get("options")
        .and_then(|value| value.get("replaceDuplicates"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    states
        .mcp
        .import_servers(input, replace_duplicates)
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn mcp_marketplace(
    State(states): State<ModuleStates>,
) -> Result<Json<Value>, StatusCode> {
    states
        .mcp
        .marketplace()
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn install_mcp_template(
    State(states): State<ModuleStates>,
    Json(payload): Json<Value>,
) -> Result<Json<McpServerResponse>, StatusCode> {
    let template_id = payload
        .get("templateId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let values = payload.get("values").cloned().unwrap_or_else(|| json!({}));
    states
        .mcp
        .install_template(template_id, values)
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn run_mcp_managed_action(
    State(states): State<ModuleStates>,
    Path((server_id, action)): Path<(String, String)>,
    Json(values): Json<Value>,
) -> Result<Json<McpServerResponse>, StatusCode> {
    states
        .mcp
        .run_managed_action(&server_id, &action, values)
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn sync_mcp(State(states): State<ModuleStates>) -> Result<Json<Value>, StatusCode> {
    states
        .mcp
        .refresh_bridge()
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn refresh_mcp_bridge(
    State(states): State<ModuleStates>,
) -> Result<Json<Value>, StatusCode> {
    states
        .mcp
        .refresh_bridge()
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn list_mcp_tools(State(states): State<ModuleStates>) -> Result<Json<Value>, StatusCode> {
    states
        .mcp
        .list_tools()
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn get_mcp_agent_configs(
    State(states): State<ModuleStates>,
) -> Result<Json<McpAgentConfigsResponse>, StatusCode> {
    states
        .mcp
        .agent_configs()
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn remove_mcp_from_agents(
    State(states): State<ModuleStates>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    states
        .mcp
        .remove_from_agents(payload)
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn import_mcp_agent_config(
    State(states): State<ModuleStates>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    states
        .mcp
        .import_agent_config(payload)
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn mcp_oauth_status(
    State(states): State<ModuleStates>,
    Path(server_id): Path<String>,
) -> Result<Json<McpOAuthActionResponse>, StatusCode> {
    states
        .mcp
        .oauth_status(&server_id)
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn mcp_oauth_login(
    State(states): State<ModuleStates>,
    Path(server_id): Path<String>,
    Json(payload): Json<Value>,
) -> Result<Json<McpOAuthActionResponse>, StatusCode> {
    states
        .mcp
        .oauth_login(&server_id, payload)
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

pub async fn mcp_oauth_logout(
    State(states): State<ModuleStates>,
    Path(server_id): Path<String>,
) -> Result<Json<McpOAuthActionResponse>, StatusCode> {
    states
        .mcp
        .oauth_logout(&server_id)
        .await
        .map(Json)
        .map_err(map_mcp_status)
}

fn map_mcp_status(error: McpError) -> StatusCode {
    match error {
        McpError::NotFound(_) => StatusCode::NOT_FOUND,
        McpError::InvalidInput(_) | McpError::InvalidTransport(_) | McpError::OAuth(_) => {
            StatusCode::BAD_REQUEST
        }
        McpError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
