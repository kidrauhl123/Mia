use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use mia_core_api_types::{
    AgentSessionSkillRuntimeRequest, AgentSessionSkillRuntimeResponse, ConversationListResponse,
    ConversationMessageListResponse, ConversationResponse, CreateConversationRequest,
    DeleteConversationResponse, RunConversationUtilityTurnRequest,
    RunConversationUtilityTurnResponse, RuntimeControlSnapshot, SendConversationMessageRequest,
    SendConversationMessageResponse, SetRuntimeControlRequest, SkillMaterializationRequest,
    SkillMaterializationResponse,
};
use mia_core_conversation::{
    EVENT_CONVERSATION_CREATED, EVENT_CONVERSATION_MESSAGE_CREATED, materialize_turn_skills,
    plan_agent_session_skill_runtime, with_memory_mode,
};
use mia_core_runtime::{
    EVENT_RUNTIME_CANCEL_REQUESTED, RuntimeEventSink, RuntimeProtocol, RuntimeTurnPlan,
    preflight_memory_isolation,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Error;

use crate::memory_autowrite::{apply_explicit_memory_autowrite, prepend_memory_autowrite_notice};
use crate::runtime::ConversationRuntimeClaim;
use crate::turn_execution::execute_and_complete_runtime_turn;

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
    Json(mut request): Json<CreateConversationRequest>,
) -> Result<Json<ConversationResponse>, StatusCode> {
    let settings = states
        .system
        .memory_settings()
        .await
        .map_err(map_sqlx_status)?;
    request.metadata = with_memory_mode(request.metadata, settings.mode);
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

pub async fn prepare_conversation_runtime_controls(
    State(states): State<ModuleStates>,
    Path(conversation_id): Path<String>,
) -> Result<Json<RuntimeControlSnapshot>, StatusCode> {
    let mut planned = states
        .conversation
        .plan_runtime_session_with_config(&conversation_id)
        .await
        .map_err(map_sqlx_status)?;
    states
        .mia_runtime_proxies
        .prepare_plan(
            &states.cloud,
            &planned.runtime_config,
            &mut planned.runtime_plan,
        )
        .await
        .map_err(|error| {
            tracing::warn!(conversation_id, error = %error, "prepare conversation runtime proxy failed");
            StatusCode::BAD_GATEWAY
        })?;
    let plan = planned.runtime_plan;
    preflight_memory_isolation(&plan).await.map_err(|error| {
        tracing::warn!(
            conversation_id,
            engine = %plan.engine,
            error = %error,
            "prepare interactive runtime memory isolation preflight failed"
        );
        StatusCode::BAD_GATEWAY
    })?;
    states
        .runtime_sessions
        .prepare_session(plan)
        .await
        .map(Json)
        .map_err(|error| {
            tracing::warn!(
                conversation_id,
                error = %error,
                "prepare interactive runtime controls failed"
            );
            StatusCode::BAD_GATEWAY
        })
}

pub async fn set_conversation_runtime_control(
    State(states): State<ModuleStates>,
    Path(conversation_id): Path<String>,
    Json(request): Json<SetRuntimeControlRequest>,
) -> Result<Json<RuntimeControlSnapshot>, StatusCode> {
    let mut planned = states
        .conversation
        .plan_runtime_session_with_config(&conversation_id)
        .await
        .map_err(map_sqlx_status)?;
    let control_id = request.control_id.trim().to_string();
    let value = request.value.trim().to_string();
    apply_runtime_control_override(&mut planned.runtime_config, &control_id, &value);
    states
        .mia_runtime_proxies
        .prepare_plan(
            &states.cloud,
            &planned.runtime_config,
            &mut planned.runtime_plan,
        )
        .await
        .map_err(|error| {
            tracing::warn!(conversation_id, error = %error, "prepare conversation runtime proxy for control update failed");
            StatusCode::BAD_GATEWAY
        })?;
    let plan = planned.runtime_plan;
    preflight_memory_isolation(&plan).await.map_err(|error| {
        tracing::warn!(
            conversation_id,
            engine = %plan.engine,
            error = %error,
            "set interactive runtime memory isolation preflight failed"
        );
        StatusCode::BAD_GATEWAY
    })?;
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
    result.map(Json).map_err(|error| {
        tracing::warn!(
            conversation_id,
            error = %error,
            "set interactive runtime control failed"
        );
        StatusCode::BAD_REQUEST
    })
}

fn apply_runtime_control_override(runtime_config: &mut Value, control_id: &str, value: &str) {
    let Some(config) = runtime_config.as_object_mut() else {
        return;
    };
    match control_id {
        "model" => {
            config.insert("model".into(), Value::String(value.into()));
            config.insert("platformModel".into(), Value::String(value.into()));
        }
        "reasoning_effort" => {
            config.insert("effortLevel".into(), Value::String(value.into()));
        }
        _ => {}
    }
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
    let user_body = request.body.clone();
    let mut runtime_claim = states
        .runtime
        .try_claim_conversation(conversation_id.clone())
        .map_err(|_| StatusCode::CONFLICT)?;
    match states
        .conversation
        .plan_user_turn_preflight(&conversation_id, &request)
        .await
    {
        Ok(plan) => {
            if let Err(error) = preflight_memory_isolation(&plan).await {
                runtime_claim.release();
                tracing::warn!(
                    conversation_id,
                    engine = %plan.engine,
                    error = %error,
                    "conversation memory isolation preflight failed"
                );
                return Err(StatusCode::BAD_GATEWAY);
            }
        }
        Err(error) => {
            runtime_claim.release();
            return Err(map_sqlx_status(error));
        }
    }
    let mut turn = match states
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
    match apply_explicit_memory_autowrite(
        &states.system,
        &states.memory,
        &turn.runtime_plan,
        &user_body,
    )
    .await
    {
        Ok(Some(applied)) => {
            turn.runtime_plan.send_message.content =
                prepend_memory_autowrite_notice(&turn.runtime_plan.send_message.content, &applied);
        }
        Ok(None) => {}
        Err(error) => {
            tracing::warn!(
                conversation_id,
                error = %error,
                "[MemoryAutoWrite] failed to apply explicit memory request"
            );
        }
    }
    if let Err(error) = states
        .mia_runtime_proxies
        .prepare_plan(&states.cloud, &turn.runtime_config, &mut turn.runtime_plan)
        .await
    {
        runtime_claim.release();
        tracing::warn!(
            conversation_id,
            error = %error,
            "prepare conversation runtime proxy failed"
        );
        return Err(StatusCode::BAD_GATEWAY);
    }
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
    if turn.runtime_plan.command.is_some()
        || matches!(
            turn.runtime_plan.protocol,
            RuntimeProtocol::NativeAcp | RuntimeProtocol::HermesGateway
        )
    {
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
    let mut planned = states
        .conversation
        .plan_utility_turn_with_config(request)
        .await
        .map_err(map_sqlx_status)?;
    states
        .mia_runtime_proxies
        .prepare_plan(
            &states.cloud,
            &planned.runtime_config,
            &mut planned.runtime_plan,
        )
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, "prepare conversation utility runtime proxy failed");
            StatusCode::BAD_GATEWAY
        })?;
    let runtime_plan = planned.runtime_plan;
    let event_realtime = states.realtime.clone();
    let sink = RuntimeEventSink::new(move |event| {
        event_realtime.emit(event.name, event.data);
    });
    let execution = states
        .runtime_sessions
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
        let completion = execute_and_complete_runtime_turn(
            &conversation,
            &states.tasks,
            &states.runtime_sessions,
            &realtime,
            runtime_plan.clone(),
            Some(cancellation),
        )
        .await;
        runtime_registry.remove(&runtime_plan.turn_id);
        if let Err(error) = completion {
            tracing::warn!(
                turn_id = runtime_plan.turn_id,
                error = %error,
                "failed to persist runtime turn completion"
            );
        }
        runtime_claim.release();
    });
}

fn map_sqlx_status(error: Error) -> StatusCode {
    match error {
        Error::RowNotFound => StatusCode::NOT_FOUND,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
