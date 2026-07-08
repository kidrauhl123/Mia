use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use mia_core_api_types::{
    AgentSessionSkillRuntimeRequest, AgentSessionSkillRuntimeResponse, ConversationListResponse,
    ConversationMessageListResponse, ConversationResponse, CreateConversationRequest,
    DeleteConversationResponse, RunConversationUtilityTurnRequest,
    RunConversationUtilityTurnResponse, SendConversationMessageRequest,
    SendConversationMessageResponse, SkillMaterializationRequest, SkillMaterializationResponse,
};
use mia_core_conversation::{
    EVENT_CONVERSATION_CREATED, EVENT_CONVERSATION_MESSAGE_CREATED, materialize_turn_skills,
    plan_agent_session_skill_runtime,
};
use mia_core_runtime::{
    EVENT_RUNTIME_CANCEL_REQUESTED, EVENT_RUNTIME_FINISHED, RuntimeEventSink,
    RuntimeSessionManager, RuntimeTurnPlan,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::Error;

use crate::cloud_bridge::normalize_runtime_output;
use crate::runtime::ConversationRuntimeClaim;

use super::state::ModuleStates;

pub async fn list_conversations(
    State(states): State<ModuleStates>,
) -> Result<Json<ConversationListResponse>, StatusCode> {
    states
        .conversation
        .list_conversations()
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

pub async fn create_conversation(
    State(states): State<ModuleStates>,
    Json(request): Json<CreateConversationRequest>,
) -> Result<Json<ConversationResponse>, StatusCode> {
    let response = states
        .conversation
        .create_conversation(request)
        .await
        .map_err(map_sqlx_status)?;
    states.realtime.emit(
        EVENT_CONVERSATION_CREATED,
        json!({ "conversation": response.conversation.clone() }),
    );
    Ok(Json(response))
}

pub async fn get_conversation(
    State(states): State<ModuleStates>,
    Path(conversation_id): Path<String>,
) -> Result<Json<ConversationResponse>, StatusCode> {
    states
        .conversation
        .get_conversation(&conversation_id)
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConversationMessagesQuery {
    #[serde(default)]
    pub since_seq: i64,
    #[serde(default = "default_message_limit")]
    pub limit: i64,
}

fn default_message_limit() -> i64 {
    200
}

pub async fn list_conversation_messages(
    State(states): State<ModuleStates>,
    Path(conversation_id): Path<String>,
    Query(query): Query<ListConversationMessagesQuery>,
) -> Result<Json<ConversationMessageListResponse>, StatusCode> {
    states
        .conversation
        .list_conversation_messages(&conversation_id, query.since_seq, query.limit)
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

pub async fn delete_conversation(
    State(states): State<ModuleStates>,
    Path(conversation_id): Path<String>,
) -> Result<Json<DeleteConversationResponse>, StatusCode> {
    states
        .conversation
        .delete_conversation(&conversation_id)
        .await
        .map(Json)
        .map_err(map_sqlx_status)
}

pub async fn send_conversation_message(
    State(states): State<ModuleStates>,
    Path(conversation_id): Path<String>,
    Json(request): Json<SendConversationMessageRequest>,
) -> Result<Json<SendConversationMessageResponse>, StatusCode> {
    let mut runtime_claim = states
        .runtime
        .try_claim_conversation(conversation_id.clone())
        .map_err(|_| StatusCode::CONFLICT)?;
    let turn = match states
        .conversation
        .start_user_turn(&conversation_id, request)
        .await
    {
        Ok(turn) => turn,
        Err(error) => {
            runtime_claim.release();
            return Err(map_sqlx_status(error));
        }
    };
    let response = turn.response.clone();
    runtime_claim.set_turn_id(response.turn_id.clone());
    states.realtime.emit(
        EVENT_CONVERSATION_MESSAGE_CREATED,
        json!({
            "conversationId": conversation_id,
            "messageId": response.message_id.clone(),
            "turnId": response.turn_id.clone(),
            "assistantMessageId": response.assistant_message_id.clone(),
            "accepted": response.accepted,
        }),
    );
    if turn.runtime_plan.command.is_some() {
        spawn_runtime_turn(states, turn.runtime_plan, runtime_claim);
    } else {
        runtime_claim.release();
    }
    Ok(Json(response))
}

pub async fn cancel_conversation_turn(
    State(states): State<ModuleStates>,
    Path((conversation_id, turn_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !states.runtime.cancel(&turn_id) {
        return Err(StatusCode::NOT_FOUND);
    }
    states.realtime.emit(
        EVENT_RUNTIME_CANCEL_REQUESTED,
        json!({
            "conversationId": conversation_id,
            "turnId": turn_id,
            "accepted": true,
        }),
    );
    Ok(Json(json!({ "accepted": true })))
}

pub async fn materialize_conversation_skills(
    Json(request): Json<SkillMaterializationRequest>,
) -> Json<SkillMaterializationResponse> {
    Json(materialize_turn_skills(request))
}

pub async fn plan_agent_session_skills(
    Json(request): Json<AgentSessionSkillRuntimeRequest>,
) -> Json<AgentSessionSkillRuntimeResponse> {
    Json(plan_agent_session_skill_runtime(request))
}

pub async fn run_conversation_utility_turn(
    State(states): State<ModuleStates>,
    Json(request): Json<RunConversationUtilityTurnRequest>,
) -> Result<Json<RunConversationUtilityTurnResponse>, StatusCode> {
    let runtime_plan = states
        .conversation
        .plan_utility_turn(request)
        .await
        .map_err(map_sqlx_status)?;
    let event_realtime = states.realtime.clone();
    let sink = RuntimeEventSink::new(move |event| {
        event_realtime.emit(event.name, event.data);
    });
    let execution = RuntimeSessionManager::default()
        .send_message(runtime_plan.clone(), sink, None)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let content = if execution.stdout.trim().is_empty() {
        execution.stderr.trim()
    } else {
        execution.stdout.trim()
    }
    .to_string();
    Ok(Json(RunConversationUtilityTurnResponse {
        content,
        turn_id: runtime_plan.turn_id,
        engine: runtime_plan.engine,
    }))
}

fn spawn_runtime_turn(
    states: ModuleStates,
    runtime_plan: RuntimeTurnPlan,
    mut runtime_claim: ConversationRuntimeClaim,
) {
    let conversation = states.conversation.clone();
    let realtime = states.realtime.clone();
    let runtime_registry = states.runtime.clone();
    let cancellation = runtime_registry.register(runtime_plan.turn_id.clone());
    tokio::spawn(async move {
        let event_realtime = realtime.clone();
        let sink = RuntimeEventSink::new(move |event| {
            event_realtime.emit(event.name, event.data);
        });
        let execution = RuntimeSessionManager::default()
            .send_message(runtime_plan.clone(), sink, Some(cancellation))
            .await;
        runtime_registry.remove(&runtime_plan.turn_id);
        let (body, runtime) = match execution {
            Ok(result) => {
                let output =
                    normalize_runtime_output(&runtime_plan.engine, &result.stdout, &result.stderr);
                let body = if output.text.trim().is_empty() && result.exit_code != Some(0) {
                    result.stderr.trim().to_string()
                } else {
                    output.text.clone()
                };
                (
                    body,
                    json!({
                        "engine": runtime_plan.engine,
                        "exitCode": result.exit_code,
                        "cancelled": result.cancelled,
                        "stderr": result.stderr,
                        "runtimeSession": runtime_plan.runtime_session.clone(),
                        "trace": output.trace,
                        "contentBlocks": output.content_blocks,
                    }),
                )
            }
            Err(error) => {
                realtime.emit(
                    EVENT_RUNTIME_FINISHED,
                    json!({
                        "turnId": runtime_plan.turn_id,
                        "conversationId": runtime_plan.conversation_id,
                        "engine": runtime_plan.engine,
                        "exitCode": null,
                        "cancelled": false,
                        "ok": false,
                        "error": error.to_string(),
                    }),
                );
                (
                    format!("Runtime execution failed: {error}"),
                    json!({
                        "engine": runtime_plan.engine,
                        "exitCode": null,
                        "cancelled": false,
                        "error": error.to_string(),
                        "runtimeSession": runtime_plan.runtime_session.clone(),
                    }),
                )
            }
        };
        if let Ok(completed) = conversation
            .complete_runtime_turn(
                &runtime_plan.conversation_id,
                &runtime_plan.turn_id,
                &body,
                runtime.clone(),
            )
            .await
        {
            runtime_claim.release();
            realtime.emit(
                EVENT_CONVERSATION_MESSAGE_CREATED,
                json!({
                    "conversationId": runtime_plan.conversation_id,
                    "messageId": completed.message_id,
                    "turnId": runtime_plan.turn_id,
                    "role": "assistant",
                    "accepted": true,
                    "message": {
                        "id": completed.message_id,
                        "conversation_id": runtime_plan.conversation_id,
                        "seq": completed.seq,
                        "sender_kind": "bot",
                        "sender_ref": runtime_plan.bot_id.clone().unwrap_or_else(|| "mia".to_string()),
                        "body_md": completed.body,
                        "turn_id": runtime_plan.turn_id,
                        "trace": runtime.get("trace").cloned().unwrap_or_else(|| json!({})),
                        "contentBlocks": runtime.get("contentBlocks").cloned().unwrap_or_else(|| json!([])),
                        "created_at": completed.created_at,
                    },
                }),
            );
        } else {
            runtime_claim.release();
        }
    });
}

fn map_sqlx_status(error: Error) -> StatusCode {
    match error {
        Error::RowNotFound => StatusCode::NOT_FOUND,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
