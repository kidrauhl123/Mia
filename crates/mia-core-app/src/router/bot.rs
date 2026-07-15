use axum::Json;
use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use mia_core_api_types::{
    BotCapabilityOptionsRequest, BotCapabilityOptionsResponse, BotListResponse,
    BotMemoryEntriesResponse, BotResponse, BotRuntimeControlOptionsRequest,
    BotRuntimeControlOptionsResponse, BotRuntimeResponse, BotRuntimeTargetOptionsRequest,
    BotRuntimeTargetOptionsResponse, CreateBotRequest, EmptyResponse,
    EnsureBotSessionConversationRequest, EnsureBotSessionConversationResponse, MemoryMode,
    MiaMemoryAction, MiaMemoryTarget, MiaMemoryToolRequest, ReplaceBotMemoryEntryRequest,
    SaveBotRuntimeRequest, StarterBotEnsureRequest, StarterBotEnsureResponse, UpdateBotRequest,
};
use mia_core_conversation::with_memory_mode;
use mia_core_memory::{count_chars, deserialize_entries, target_limit};
use serde_json::json;
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

/// A product-management projection of one Bot's Mia memory.
///
/// The agent-facing MCP intentionally has no read action. This endpoint is for
/// the authenticated Mia UI only and returns entries rather than the backing
/// delimiter-based text document.
pub async fn get_bot_memory(
    State(states): State<ModuleStates>,
    Path(bot_id): Path<String>,
) -> Result<Json<BotMemoryEntriesResponse>, StatusCode> {
    bot_memory_entries_response(&states, &bot_id)
        .await
        .map(Json)
}

/// Replaces one displayed durable fact. `old_text` is matched by the bounded
/// memory service, so a concurrent Agent update cannot overwrite a different
/// entry by accident.
pub async fn replace_bot_memory_entry(
    State(states): State<ModuleStates>,
    Path(bot_id): Path<String>,
    Json(request): Json<ReplaceBotMemoryEntryRequest>,
) -> Result<Json<BotMemoryEntriesResponse>, StatusCode> {
    let settings = states
        .system
        .memory_settings()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if settings.mode != MemoryMode::Mia {
        return Err(StatusCode::CONFLICT);
    }
    let user_id = current_memory_user_id(&states).await?;
    let result = states
        .memory
        .mutate(
            &user_id,
            &bot_id,
            MiaMemoryToolRequest {
                context: json!({}),
                action: MiaMemoryAction::Replace,
                old_text: Some(request.old_text),
                content: Some(request.content),
            },
        )
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !result.success {
        return Err(StatusCode::UNPROCESSABLE_ENTITY);
    }
    bot_memory_entries_response(&states, &bot_id)
        .await
        .map(Json)
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
    let settings = states
        .system
        .memory_settings()
        .await
        .map_err(map_sqlx_status)?;
    states
        .bot
        .ensure_starter_bots_with_memory_mode(request, settings.mode)
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

pub async fn ensure_bot_session_conversation(
    State(states): State<ModuleStates>,
    Path(bot_id): Path<String>,
    Json(mut request): Json<EnsureBotSessionConversationRequest>,
) -> Result<Json<EnsureBotSessionConversationResponse>, StatusCode> {
    let settings = states
        .system
        .memory_settings()
        .await
        .map_err(map_sqlx_status)?;
    request.metadata = with_memory_mode(request.metadata, settings.mode);
    states
        .bot
        .ensure_session_conversation_with_memory_mode(&bot_id, request, settings.mode)
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

async fn bot_memory_entries_response(
    states: &ModuleStates,
    bot_id: &str,
) -> Result<BotMemoryEntriesResponse, StatusCode> {
    let settings = states
        .system
        .memory_settings()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if settings.mode != MemoryMode::Mia {
        return Ok(BotMemoryEntriesResponse {
            mode: MemoryMode::Native,
            entries: Vec::new(),
            used_chars: 0,
            limit_chars: target_limit(MiaMemoryTarget::Memory),
            revision: 0,
            updated_at: String::new(),
        });
    }
    let user_id = current_memory_user_id(states).await?;
    let document = states
        .memory
        .document(&user_id, bot_id, MiaMemoryTarget::Memory)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let entries =
        deserialize_entries(&document.text).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(BotMemoryEntriesResponse {
        mode: MemoryMode::Mia,
        used_chars: count_chars(&document.text),
        limit_chars: target_limit(MiaMemoryTarget::Memory),
        revision: document.revision,
        updated_at: document.updated_at,
        entries,
    })
}

async fn current_memory_user_id(states: &ModuleStates) -> Result<String, StatusCode> {
    let settings = states
        .system
        .client_settings()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let user_id = settings
        .settings
        .get("userId")
        .or_else(|| settings.settings.get("user_id"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("local");
    Ok(user_id.to_string())
}

fn map_sqlx_status(error: Error) -> StatusCode {
    match error {
        Error::RowNotFound => StatusCode::NOT_FOUND,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
