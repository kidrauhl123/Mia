use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use mia_core_api_types::{
    BotSummary, MemoryMode, MiaContextSnapshotResponse, MiaMemoryToolNames, MiaMemoryToolRequest,
    MiaSkillToolNames,
};
use mia_core_conversation::{CurrentSkillError, conversation_memory_mode};
use serde::Deserialize;
use serde_json::{Value, json};

use super::state::ModuleStates;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiaContextQuery {
    #[serde(default)]
    conversation_id: Option<String>,
    #[serde(default)]
    origin_message_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiaCurrentSkillQuery {
    #[serde(default)]
    bot_id: Option<String>,
    #[serde(default)]
    id: Option<String>,
}

pub async fn mia_context_snapshot(
    State(states): State<ModuleStates>,
    Query(query): Query<MiaContextQuery>,
) -> impl IntoResponse {
    let conversation_id = clean_or_default(query.conversation_id.as_deref(), "");
    if conversation_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "conversation_id_required" })),
        )
            .into_response();
    }
    let conversation = match states.conversation.get_conversation(&conversation_id).await {
        Ok(response) => response.conversation,
        Err(sqlx::Error::RowNotFound) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "conversation_not_found" })),
            )
                .into_response();
        }
        Err(error) => {
            tracing::error!(conversation_id, error = %error, "[MiaContext] failed to read conversation");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "context_snapshot_failed" })),
            )
                .into_response();
        }
    };
    let memory_mode = conversation_memory_mode(&conversation);
    let bot_id = conversation.bot_id.clone().unwrap_or_default();
    let origin_message_id = query.origin_message_id.unwrap_or_default();
    let bot = states
        .bot
        .get_bot(&bot_id)
        .await
        .ok()
        .map(|response| response.bot);
    let user_id = states
        .system
        .client_settings()
        .await
        .ok()
        .and_then(|response| first_string(&response.settings, &["userId", "user_id"]))
        .unwrap_or_else(|| "local".to_string());
    Json(MiaContextSnapshotResponse {
        user_id,
        bot_id: bot_id.clone(),
        session_id: conversation_id,
        origin_message_id,
        generated_at: now_ms(),
        persona: persona_from_bot(bot, &bot_id),
        memory_mode,
        memory_tools: MiaMemoryToolNames {
            enabled: memory_mode == MemoryMode::Mia,
            memory: "memory".to_string(),
        },
        skill_tools: MiaSkillToolNames {
            list_current: "skill_list_current".to_string(),
            read_current: "skill_read_current".to_string(),
        },
    })
    .into_response()
}

pub async fn list_current_mia_skills(
    State(states): State<ModuleStates>,
    Query(query): Query<MiaCurrentSkillQuery>,
) -> impl IntoResponse {
    let bot_id = clean_or_default(query.bot_id.as_deref(), "mia");
    let bot = bot_for_mia_scope(&states, &bot_id).await;
    Json(
        states
            .current_skills
            .list_current_bot_skills(&bot_id, bot.as_ref()),
    )
    .into_response()
}

pub async fn read_current_mia_skill(
    State(states): State<ModuleStates>,
    Query(query): Query<MiaCurrentSkillQuery>,
) -> impl IntoResponse {
    let bot_id = clean_or_default(query.bot_id.as_deref(), "mia");
    let skill_id = query.id.unwrap_or_default();
    let bot = bot_for_mia_scope(&states, &bot_id).await;
    match states
        .current_skills
        .read_current_bot_skill(&bot_id, bot.as_ref(), &skill_id)
    {
        Ok(response) => Json(response).into_response(),
        Err(error) => {
            let (status, payload) = current_skill_error_payload(error);
            (status, Json(payload)).into_response()
        }
    }
}

fn current_skill_error_payload(error: CurrentSkillError) -> (StatusCode, Value) {
    match error {
        CurrentSkillError::MissingId => (
            StatusCode::BAD_REQUEST,
            json!({ "error": "id is required" }),
        ),
        CurrentSkillError::NotEnabled(message) => {
            (StatusCode::NOT_FOUND, json!({ "error": message }))
        }
        CurrentSkillError::MissingSource(id) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": format!("Required native skill source is missing: {id}") }),
        ),
    }
}

pub async fn mutate_mia_memory(
    State(states): State<ModuleStates>,
    Json(request): Json<MiaMemoryToolRequest>,
) -> impl IntoResponse {
    let conversation_id =
        first_string(&request.context, &["conversationId", "conversation_id"]).unwrap_or_default();
    if conversation_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "conversation_id_required" })),
        )
            .into_response();
    }
    let conversation = match states.conversation.get_conversation(&conversation_id).await {
        Ok(response) => response.conversation,
        Err(sqlx::Error::RowNotFound) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "conversation_not_found" })),
            )
                .into_response();
        }
        Err(error) => {
            tracing::error!(
                conversation_id,
                action = ?request.action,
                error = %error,
                "[MiaMemory] failed to read conversation owner"
            );
            return memory_server_error();
        }
    };
    if conversation_memory_mode(&conversation) != MemoryMode::Mia {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "native_memory_owner" })),
        )
            .into_response();
    }
    let Some(bot_id) = conversation
        .bot_id
        .as_deref()
        .map(str::trim)
        .filter(|bot_id| !bot_id.is_empty())
    else {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "conversation_bot_required" })),
        )
            .into_response();
    };
    if first_string(&request.context, &["botId", "bot_id"])
        .is_some_and(|request_bot_id| request_bot_id != bot_id)
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "conversation_bot_mismatch" })),
        )
            .into_response();
    }
    let user_id = match states.system.client_settings().await {
        Ok(response) => first_string(&response.settings, &["userId", "user_id"])
            .unwrap_or_else(|| "local".to_string()),
        Err(error) => {
            tracing::error!(
                conversation_id,
                action = ?request.action,
                error = %error,
                "[MiaMemory] failed to read user owner"
            );
            return memory_server_error();
        }
    };
    let action = request.action;
    match states.memory.mutate(&user_id, bot_id, request).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => {
            tracing::error!(
                conversation_id,
                action = ?action,
                error = %error,
                "[MiaMemory] mutation failed"
            );
            memory_server_error()
        }
    }
}

fn memory_server_error() -> axum::response::Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "memory_service_failed" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_required_skill_source_maps_to_an_explicit_server_error() {
        let (status, payload) = current_skill_error_payload(CurrentSkillError::MissingSource(
            "mia-official:officecli".to_string(),
        ));
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            payload["error"],
            "Required native skill source is missing: mia-official:officecli"
        );
    }
}

async fn bot_for_mia_scope(states: &ModuleStates, bot_id: &str) -> Option<BotSummary> {
    states
        .bot
        .get_bot(bot_id)
        .await
        .ok()
        .map(|response| response.bot)
}

fn clean_or_default(value: Option<&str>, default: &str) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default)
        .to_string()
}

fn persona_from_bot(bot: Option<BotSummary>, bot_id: &str) -> String {
    let Some(bot) = bot else {
        return default_persona(bot_id, "");
    };
    let display_name = if bot.display_name.trim().is_empty() {
        first_string(&bot.identity, &["displayName", "name"]).unwrap_or_else(|| bot.id.clone())
    } else {
        bot.display_name.clone()
    };
    if let Some(persona) = first_string(
        &bot.identity,
        &["personaText", "persona_text", "persona", "systemPrompt"],
    )
    .filter(|value| !value.trim().is_empty())
    {
        return persona;
    }
    let bio = first_string(&bot.identity, &["bio", "description", "summary"]).unwrap_or_default();
    default_persona(&display_name, &bio)
}

fn default_persona(display_name: &str, bio: &str) -> String {
    let name = if display_name.trim().is_empty() {
        "mia"
    } else {
        display_name.trim()
    };
    let bio = bio.trim();
    if bio.is_empty() {
        format!("# {name}\n\n你是{name}，Mia App 里的 Bot。")
    } else {
        format!("# {name}\n\n你是{name}，Mia App 里的 Bot。\n{bio}")
    }
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            let text = text.trim();
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
