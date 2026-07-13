use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use mia_core_api_types::{
    BotSummary, MiaContextSnapshotResponse, MiaMemoryMutationRequest, MiaMemoryMutationResponse,
    MiaMemorySearchRequest, MiaMemorySearchResponse, MiaMemoryToolNames, MiaSkillToolNames,
};
use mia_core_conversation::CurrentSkillError;
use mia_core_memory::{disabled_mutation_response, disabled_search_response};
use serde::Deserialize;
use serde_json::{Value, json};

use super::state::ModuleStates;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiaContextQuery {
    #[serde(default)]
    bot_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
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
) -> Json<MiaContextSnapshotResponse> {
    let bot_id = clean_or_default(query.bot_id.as_deref(), "mia");
    let session_id = clean_or_default(query.session_id.as_deref(), "default");
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
    let memory_enabled = states
        .system
        .memory_settings()
        .await
        .map(|settings| settings.enabled)
        .unwrap_or(true);

    Json(MiaContextSnapshotResponse {
        user_id,
        bot_id: bot_id.clone(),
        session_id,
        origin_message_id,
        generated_at: now_ms(),
        persona: persona_from_bot(bot, &bot_id),
        memory: String::new(),
        memory_tools: MiaMemoryToolNames {
            enabled: memory_enabled,
            search: "memory_search".to_string(),
            remember: "memory_remember".to_string(),
            update: "memory_update".to_string(),
            forget: "memory_forget".to_string(),
        },
        skill_tools: MiaSkillToolNames {
            list_current: "skill_list_current".to_string(),
            read_current: "skill_read_current".to_string(),
        },
    })
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

pub async fn search_mia_memory(
    State(states): State<ModuleStates>,
    Json(request): Json<MiaMemorySearchRequest>,
) -> Json<MiaMemorySearchResponse> {
    if memory_disabled(&states).await {
        return Json(disabled_search_response());
    }
    Json(
        states
            .memory
            .search(request)
            .await
            .unwrap_or(MiaMemorySearchResponse {
                memories: Vec::new(),
                disabled: None,
                reason: None,
            }),
    )
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

pub async fn list_mia_memory(
    State(states): State<ModuleStates>,
    Json(request): Json<MiaMemorySearchRequest>,
) -> Json<MiaMemorySearchResponse> {
    Json(
        states
            .memory
            .list(request)
            .await
            .unwrap_or(MiaMemorySearchResponse {
                memories: Vec::new(),
                disabled: None,
                reason: None,
            }),
    )
}

pub async fn remember_mia_memory(
    State(states): State<ModuleStates>,
    Json(request): Json<MiaMemoryMutationRequest>,
) -> Json<MiaMemoryMutationResponse> {
    if memory_disabled(&states).await {
        return Json(disabled_mutation_response());
    }
    Json(
        states
            .memory
            .remember(request)
            .await
            .unwrap_or_else(memory_error_response),
    )
}

pub async fn update_mia_memory(
    State(states): State<ModuleStates>,
    Json(request): Json<MiaMemoryMutationRequest>,
) -> Json<MiaMemoryMutationResponse> {
    if memory_disabled(&states).await {
        return Json(disabled_mutation_response());
    }
    Json(
        states
            .memory
            .update(request)
            .await
            .unwrap_or_else(memory_error_response),
    )
}

pub async fn forget_mia_memory(
    State(states): State<ModuleStates>,
    Json(request): Json<MiaMemoryMutationRequest>,
) -> Json<MiaMemoryMutationResponse> {
    if memory_disabled(&states).await {
        return Json(disabled_mutation_response());
    }
    Json(
        states
            .memory
            .forget(request)
            .await
            .unwrap_or_else(memory_error_response),
    )
}

pub async fn delete_mia_memory(
    State(states): State<ModuleStates>,
    Json(request): Json<MiaMemoryMutationRequest>,
) -> Json<MiaMemoryMutationResponse> {
    Json(
        states
            .memory
            .delete(request)
            .await
            .unwrap_or_else(memory_error_response),
    )
}

async fn memory_disabled(states: &ModuleStates) -> bool {
    states
        .system
        .memory_settings()
        .await
        .map(|settings| !settings.enabled)
        .unwrap_or(false)
}

async fn bot_for_mia_scope(states: &ModuleStates, bot_id: &str) -> Option<BotSummary> {
    states
        .bot
        .get_bot(bot_id)
        .await
        .ok()
        .map(|response| response.bot)
}

fn memory_error_response(error: mia_core_memory::MemoryError) -> MiaMemoryMutationResponse {
    MiaMemoryMutationResponse {
        status: "error".to_string(),
        disabled: None,
        reason: None,
        error: Some(error.to_string()),
        effective_scope: None,
        policy_reason: None,
        memory_id: None,
        memory: None,
        matches: Vec::new(),
    }
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
