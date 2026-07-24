use std::sync::{Arc, Mutex};
use std::time::Instant;

use mia_core_conversation::{
    CompletedRuntimeMessage, ConversationService, EVENT_CONVERSATION_MESSAGE_CREATED,
};
use mia_core_realtime::EventBus;
use mia_core_runtime::{
    EVENT_RUNTIME_FINISHED, RuntimeCancellation, RuntimeEventSink, RuntimeSessionManager,
    RuntimeSessionState, RuntimeTurnPlan,
};
use mia_core_tasks::TaskService;
use serde_json::{Value, json};

use crate::cloud_bridge::{attach_process_duration, normalize_runtime_output};

#[derive(Debug, Clone)]
pub struct RuntimeTurnCompletion {
    pub message: CompletedRuntimeMessage,
    pub runtime: Value,
    pub successful: bool,
    pub error: Option<String>,
}

pub async fn execute_and_complete_runtime_turn(
    conversation: &ConversationService,
    _tasks: &TaskService,
    sessions: &RuntimeSessionManager,
    realtime: &EventBus,
    runtime_plan: RuntimeTurnPlan,
    cancellation: Option<RuntimeCancellation>,
) -> anyhow::Result<RuntimeTurnCompletion> {
    let cloud_conversation_id = conversation
        .get_conversation(&runtime_plan.conversation_id)
        .await?
        .conversation
        .metadata
        .get("cloudBridge")
        .and_then(|value| {
            value
                .get("conversationId")
                .or_else(|| value.get("conversation_id"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let event_realtime = realtime.clone();
    let actual_session_id = Arc::new(Mutex::new(None::<String>));
    let actual_session_id_for_sink = actual_session_id.clone();
    let execution_started = Instant::now();
    let execution = sessions
        .send_message(
            runtime_plan.clone(),
            RuntimeEventSink::new(move |event| {
                if event.name == EVENT_RUNTIME_FINISHED
                    && event.data.get("ok").and_then(Value::as_bool) == Some(true)
                    && let Some(session_id) = event
                        .data
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                {
                    *actual_session_id_for_sink.lock().unwrap() = Some(session_id.to_string());
                }
                event_realtime.emit(event.name, event.data);
            }),
            cancellation,
        )
        .await;

    let (body, runtime, successful, error) = match execution {
        Ok(result) => {
            let runtime_session = runtime_session_with_actual_id(
                &runtime_plan.runtime_session,
                actual_session_id.lock().unwrap().as_deref(),
            );
            let mut output =
                normalize_runtime_output(&runtime_plan.engine, &result.stdout, &result.stderr);
            attach_process_duration(&mut output, execution_started.elapsed());
            let body = if output.text.trim().is_empty() && result.exit_code != Some(0) {
                result.stderr.trim().to_string()
            } else {
                output.text.clone()
            };
            let successful = result.exit_code == Some(0) && !result.cancelled;
            let error = (!successful).then(|| {
                if result.cancelled {
                    "runtime turn was cancelled".to_string()
                } else if result.stderr.trim().is_empty() {
                    format!("runtime exited with {:?}", result.exit_code)
                } else {
                    result.stderr.trim().to_string()
                }
            });
            (
                body,
                json!({
                    "engine": runtime_plan.engine,
                    "exitCode": result.exit_code,
                    "cancelled": result.cancelled,
                    "stderr": result.stderr,
                    "runtimeSession": runtime_session,
                    "trace": output.trace,
                    "contentBlocks": output.content_blocks,
                }),
                successful,
                error,
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
                false,
                Some(error.to_string()),
            )
        }
    };

    let completed = conversation
        .complete_runtime_turn(
            &runtime_plan.conversation_id,
            &runtime_plan.turn_id,
            &body,
            runtime.clone(),
        )
        .await?;
    realtime.emit(
        EVENT_CONVERSATION_MESSAGE_CREATED,
        json!({
            "conversationId": runtime_plan.conversation_id,
            "messageId": completed.message_id,
            "turnId": runtime_plan.turn_id,
            "role": "assistant",
            "accepted": true,
            "cloudConversationId": cloud_conversation_id,
            "message": {
                "id": completed.message_id,
                "conversation_id": runtime_plan.conversation_id,
                "seq": completed.seq,
                "sender_kind": "bot",
                "sender_ref": runtime_plan.bot_id.clone().unwrap_or_else(|| "mia".to_string()),
                "body_md": completed.body,
                "status": completed.status,
                "turn_id": runtime_plan.turn_id,
                "trace": runtime.get("trace").cloned().unwrap_or_else(|| json!({})),
                "contentBlocks": runtime.get("contentBlocks").cloned().unwrap_or_else(|| json!([])),
                "created_at": completed.created_at,
            },
        }),
    );
    Ok(RuntimeTurnCompletion {
        message: completed,
        runtime,
        successful,
        error,
    })
}

pub(crate) fn runtime_session_with_actual_id(
    planned: &RuntimeSessionState,
    actual_session_id: Option<&str>,
) -> RuntimeSessionState {
    let mut resolved = planned.clone();
    if let Some(session_id) = actual_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        resolved.resume_session_key = Some(session_id.to_string());
    }
    resolved
}
