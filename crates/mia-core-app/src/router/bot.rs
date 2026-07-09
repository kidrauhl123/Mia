use axum::Json;
use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use mia_core_api_types::{
    BotCapabilityOptionsRequest, BotCapabilityOptionsResponse, BotListResponse, BotResponse,
    BotRuntimeControlOptionsRequest, BotRuntimeControlOptionsResponse, BotRuntimeResponse,
    BotRuntimeTargetOptionsRequest, BotRuntimeTargetOptionsResponse, CreateBotRequest,
    EmptyResponse, EnsureBotSessionConversationRequest, EnsureBotSessionConversationResponse,
    SaveBotRuntimeRequest, StarterBotEnsureRequest, StarterBotEnsureResponse, UpdateBotRequest,
};
use sqlx::Error;

use super::state::ModuleStates;

pub async fn list_bots(
    State(states): State<ModuleStates>,
) -> Result<Json<BotListResponse>, StatusCode> {
    states
        .bot
        .list_bots()
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

pub async fn create_bot(
    State(states): State<ModuleStates>,
    Json(request): Json<CreateBotRequest>,
) -> Result<Json<BotResponse>, StatusCode> {
    states
        .bot
        .create_bot(request)
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

pub async fn get_bot(
    State(states): State<ModuleStates>,
    Path(bot_id): Path<String>,
) -> Result<Json<BotResponse>, StatusCode> {
    states
        .bot
        .get_bot(&bot_id)
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

pub async fn update_bot(
    State(states): State<ModuleStates>,
    Path(bot_id): Path<String>,
    Json(request): Json<UpdateBotRequest>,
) -> Result<Json<BotResponse>, StatusCode> {
    states
        .bot
        .update_bot(&bot_id, request)
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

pub async fn delete_bot(
    State(states): State<ModuleStates>,
    Path(bot_id): Path<String>,
) -> Result<Json<EmptyResponse>, StatusCode> {
    states
        .bot
        .delete_bot(&bot_id)
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

pub async fn save_bot_runtime(
    State(states): State<ModuleStates>,
    Path(bot_id): Path<String>,
    Json(request): Json<SaveBotRuntimeRequest>,
) -> Result<Json<BotRuntimeResponse>, StatusCode> {
    states
        .bot
        .save_runtime(&bot_id, request)
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

pub async fn get_bot_runtime(
    State(states): State<ModuleStates>,
    Path(bot_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<BotRuntimeResponse>, StatusCode> {
    let runtime_kind = query
        .get("kind")
        .map(String::as_str)
        .unwrap_or("cloud-claude-code");
    states
        .bot
        .get_runtime(&bot_id, runtime_kind)
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

pub async fn bot_runtime_target_options(
    State(states): State<ModuleStates>,
    Json(request): Json<BotRuntimeTargetOptionsRequest>,
) -> Json<BotRuntimeTargetOptionsResponse> {
    Json(states.bot.runtime_target_options(request))
}

pub async fn bot_runtime_control_options(
    State(states): State<ModuleStates>,
    Json(request): Json<BotRuntimeControlOptionsRequest>,
) -> Json<BotRuntimeControlOptionsResponse> {
    Json(states.bot.runtime_control_options(request))
}

pub async fn bot_capability_options(
    State(states): State<ModuleStates>,
    Json(request): Json<BotCapabilityOptionsRequest>,
) -> Json<BotCapabilityOptionsResponse> {
    Json(states.bot.capability_options(request))
}

pub async fn ensure_starter_bots(
    State(states): State<ModuleStates>,
    Json(request): Json<StarterBotEnsureRequest>,
) -> Result<Json<StarterBotEnsureResponse>, StatusCode> {
    states
        .bot
        .ensure_starter_bots(request)
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

pub async fn ensure_bot_session_conversation(
    State(states): State<ModuleStates>,
    Path(bot_id): Path<String>,
    Json(request): Json<EnsureBotSessionConversationRequest>,
) -> Result<Json<EnsureBotSessionConversationResponse>, StatusCode> {
    states
        .bot
        .ensure_session_conversation(&bot_id, request)
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

fn map_sqlx_status(error: Error) -> StatusCode {
    match error {
        Error::RowNotFound => StatusCode::NOT_FOUND,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
