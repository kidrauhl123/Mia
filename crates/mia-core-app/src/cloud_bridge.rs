use async_trait::async_trait;
use mia_core_api_types::{
    CloudBridgeCancelRequest, CloudBridgeCancelResponse, CloudBridgeRunRequest,
    CloudBridgeRunResponse, SendConversationMessageRequest,
};
use mia_core_cloud::{CloudBridgeRunHandler, CloudError, CloudService};
use mia_core_conversation::{ConversationService, EVENT_CONVERSATION_MESSAGE_CREATED};
use mia_core_realtime::EventBus;
use mia_core_runtime::{
    EVENT_RUNTIME_CANCEL_REQUESTED, EVENT_RUNTIME_STDERR, EVENT_RUNTIME_STDOUT, RuntimeEventSink,
    RuntimeSessionManager, RuntimeTurnPlan,
};
use serde_json::{Value, json};

use crate::claude_code_mia_proxy::{
    ClaudeCodeMiaProxyConfig, RunningClaudeCodeMiaProxy, start_claude_code_mia_proxy,
};
use crate::codex_mia_proxy::{CodexMiaProxyConfig, RunningCodexMiaProxy, start_codex_mia_proxy};
use crate::runtime::RuntimeRegistry;

#[derive(Debug, Clone)]
pub struct AppCloudBridgeRunner {
    cloud: CloudService,
    conversation: ConversationService,
    realtime: EventBus,
    runtime: RuntimeRegistry,
}

impl AppCloudBridgeRunner {
    pub fn new(
        cloud: CloudService,
        conversation: ConversationService,
        realtime: EventBus,
        runtime: RuntimeRegistry,
    ) -> Self {
        Self {
            cloud,
            conversation,
            realtime,
            runtime,
        }
    }
}

#[async_trait]
impl CloudBridgeRunHandler for AppCloudBridgeRunner {
    async fn run(
        &self,
        request: CloudBridgeRunRequest,
    ) -> Result<CloudBridgeRunResponse, CloudError> {
        execute_cloud_bridge_run(
            &self.cloud,
            &self.conversation,
            &self.realtime,
            &self.runtime,
            request,
        )
        .await
    }

    async fn cancel(
        &self,
        request: CloudBridgeCancelRequest,
    ) -> Result<CloudBridgeCancelResponse, CloudError> {
        cancel_cloud_bridge_run(&self.realtime, &self.runtime, request).await
    }
}

pub async fn execute_cloud_bridge_run(
    cloud: &CloudService,
    conversation: &ConversationService,
    realtime: &EventBus,
    runtime: &RuntimeRegistry,
    request: CloudBridgeRunRequest,
) -> Result<CloudBridgeRunResponse, CloudError> {
    let prepared = cloud.prepare_bridge_run(request)?;
    let conversation_row = conversation
        .ensure_external_conversation(
            &prepared.local_conversation_id,
            "cloud-bridge",
            &prepared.title,
            None,
            prepared.metadata.clone(),
        )
        .await?
        .conversation;
    let mut runtime_claim = runtime
        .try_claim_conversation(conversation_row.id.clone())
        .map_err(|active| {
            CloudError::Busy(format!(
                "conversation {} is already running turn {}",
                active.conversation_id, active.turn_id
            ))
        })?;
    let turn = match conversation
        .start_user_turn(
            &conversation_row.id,
            SendConversationMessageRequest {
                body: prepared.text.clone(),
                attachments: prepared.attachments.clone(),
                selected_skill_ids: Vec::new(),
            },
        )
        .await
    {
        Ok(turn) => turn,
        Err(error) => {
            runtime_claim.release();
            return Err(error.into());
        }
    };
    runtime_claim.set_turn_id(turn.response.turn_id.clone());
    let mut assistant_message_id = turn.response.assistant_message_id.clone();
    realtime.emit(
        EVENT_CONVERSATION_MESSAGE_CREATED,
        json!({
            "conversationId": conversation_row.id,
            "messageId": turn.response.message_id,
            "turnId": turn.response.turn_id,
            "assistantMessageId": assistant_message_id,
            "accepted": turn.response.accepted,
            "cloudBridgeRunId": prepared.run_id,
        }),
    );
    let mut runtime_plan = turn.runtime_plan.clone();
    let _claude_proxy =
        prepare_claude_code_mia_runtime(cloud, &prepared.runtime, &mut runtime_plan).await?;
    let _codex_proxy =
        prepare_codex_mia_runtime(cloud, &prepared.runtime, &mut runtime_plan).await?;
    emit_cloud_run_started(
        realtime,
        &prepared.cloud_conversation_id,
        &prepared.run_id,
        &runtime_plan,
        &prepared.metadata,
    );
    let mut response_trace = json!({});
    let mut response_content_blocks = json!([]);
    let text = if runtime_plan.command.is_some() {
        let cancellation_key = cloud_bridge_runtime_key(&prepared.run_id);
        let cancellation = runtime.register(cancellation_key.clone());
        let event_realtime = realtime.clone();
        let cloud_conversation_id = prepared.cloud_conversation_id.clone();
        let cloud_run_id = prepared.run_id.clone();
        let cloud_bot_id = bot_id_from_metadata(&prepared.metadata).unwrap_or_else(|| {
            runtime_plan
                .bot_id
                .clone()
                .unwrap_or_else(|| "mia".to_string())
        });
        let runtime_event_engine = runtime_plan.engine.clone();
        let sink = RuntimeEventSink::new(move |event| {
            let name = event.name.clone();
            let data = event.data.clone();
            if name == EVENT_RUNTIME_STDOUT {
                for run_event in cloud_run_events_from_stdout(
                    &runtime_event_engine,
                    data.get("text").and_then(Value::as_str).unwrap_or(""),
                ) {
                    event_realtime.emit(
                        "cloud_agent_run_event",
                        json!({
                            "conversationId": cloud_conversation_id,
                            "runId": cloud_run_id,
                            "botId": cloud_bot_id,
                            "event": run_event,
                        }),
                    );
                }
            } else if name == EVENT_RUNTIME_STDERR {
                let text = data.get("text").and_then(Value::as_str).unwrap_or("");
                if let Some(text) = clean_runtime_stderr_status(&runtime_event_engine, text) {
                    event_realtime.emit(
                        "cloud_agent_run_event",
                        json!({
                            "conversationId": cloud_conversation_id,
                            "runId": cloud_run_id,
                            "botId": cloud_bot_id,
                            "event": {
                                "type": "status",
                                "text": text,
                            },
                        }),
                    );
                }
            }
            event_realtime.emit(name, data);
        });
        let execution = RuntimeSessionManager::default()
            .send_message(runtime_plan.clone(), sink, Some(cancellation))
            .await
            .map_err(|error| CloudError::Runtime(error.to_string()));
        runtime.remove(&cancellation_key);
        let result = execution?;
        let output = normalize_runtime_output(&runtime_plan.engine, &result.stdout, &result.stderr);
        response_trace = output.trace.clone();
        response_content_blocks = output.content_blocks.clone();
        let body = if output.text.trim().is_empty() && result.exit_code != Some(0) {
            clean_runtime_stderr_for_display(&runtime_plan.engine, &result.stderr)
        } else {
            output.text.clone()
        };
        let body = if body.trim().is_empty() && result.cancelled {
            "Runtime execution cancelled.".to_string()
        } else {
            body
        };
        let completed = conversation
            .complete_runtime_turn(
                &runtime_plan.conversation_id,
                &runtime_plan.turn_id,
                &body,
                json!({
                    "engine": runtime_plan.engine,
                    "exitCode": result.exit_code,
                    "cancelled": result.cancelled,
                    "stderr": result.stderr,
                    "cloudBridgeRunId": prepared.run_id,
                    "runtimeSession": runtime_plan.runtime_session.clone(),
                    "trace": output.trace,
                    "contentBlocks": output.content_blocks,
                }),
            )
            .await?;
        runtime_claim.release();
        assistant_message_id = Some(completed.message_id.clone());
        realtime.emit(
            "cloud_agent_run_event",
            json!({
                "conversationId": prepared.cloud_conversation_id,
                "runId": prepared.run_id,
                "botId": bot_id_from_metadata(&prepared.metadata)
                    .unwrap_or_else(|| runtime_plan.bot_id.clone().unwrap_or_else(|| "mia".to_string())),
                "event": {
                    "type": "run.completed",
                    "final_response": body,
                },
            }),
        );
        realtime.emit(
            EVENT_CONVERSATION_MESSAGE_CREATED,
            json!({
                "conversationId": runtime_plan.conversation_id,
                "messageId": completed.message_id,
                "turnId": runtime_plan.turn_id,
                "role": "assistant",
                "accepted": true,
                "cloudConversationId": prepared.cloud_conversation_id,
                "cloudBridgeRunId": prepared.run_id,
                "message": {
                    "id": completed.message_id,
                    "conversation_id": runtime_plan.conversation_id,
                    "seq": completed.seq,
                    "sender_kind": "bot",
                    "sender_ref": runtime_plan.bot_id.clone().unwrap_or_else(|| "mia".to_string()),
                    "body_md": completed.body,
                    "turn_id": runtime_plan.turn_id,
                    "trace": output.trace,
                    "contentBlocks": output.content_blocks,
                    "created_at": completed.created_at,
                },
            }),
        );
        body
    } else {
        runtime_claim.release();
        turn.runtime_plan.mock_response.clone().unwrap_or_default()
    };
    Ok(CloudBridgeRunResponse {
        ok: true,
        run_id: prepared.run_id,
        conversation_id: conversation_row.id,
        cloud_conversation_id: prepared.cloud_conversation_id,
        message_id: turn.response.message_id,
        turn_id: turn.response.turn_id,
        assistant_message_id,
        text: text.trim().to_string(),
        attachments: json!([]),
        trace: response_trace,
        content_blocks: response_content_blocks,
    })
}

pub async fn cancel_cloud_bridge_run(
    realtime: &EventBus,
    runtime: &RuntimeRegistry,
    request: CloudBridgeCancelRequest,
) -> Result<CloudBridgeCancelResponse, CloudError> {
    let run_id = request.run_id.trim().to_string();
    if run_id.is_empty() {
        return Err(CloudError::InvalidInput("runId is required".into()));
    }
    let cancelled = runtime.cancel(&cloud_bridge_runtime_key(&run_id));
    if cancelled {
        realtime.emit(
            EVENT_RUNTIME_CANCEL_REQUESTED,
            json!({
                "runId": run_id,
                "accepted": true,
                "source": "cloudBridge",
            }),
        );
    }
    Ok(CloudBridgeCancelResponse {
        ok: true,
        cancelled,
        run_id,
    })
}

fn cloud_bridge_runtime_key(run_id: &str) -> String {
    format!("cloud_bridge_run:{}", run_id.trim())
}

async fn prepare_claude_code_mia_runtime(
    cloud: &CloudService,
    runtime_config: &Value,
    plan: &mut RuntimeTurnPlan,
) -> Result<Option<RunningClaudeCodeMiaProxy>, CloudError> {
    if plan.engine != "claude-code"
        || plan.command.is_none()
        || !is_mia_managed(plan, runtime_config)
    {
        return Ok(None);
    }
    let status = cloud.status(true).await?;
    let cloud_token = status.token.unwrap_or_default();
    if cloud_token.trim().is_empty() {
        return Err(CloudError::InvalidInput("cloud is not connected".into()));
    }
    let model = first_string(&plan.provider, &["model"])
        .or_else(|| first_string(runtime_config, &["model"]))
        .unwrap_or_else(|| "mia-auto".to_string());
    let base_url = first_string(&plan.provider, &["baseUrl", "base_url"]).unwrap_or_else(|| {
        format!(
            "{}/api/me/model-proxy/v1",
            status.url.trim().trim_end_matches('/')
        )
    });
    let api_key = first_string(&plan.provider, &["apiKey", "api_key"]).unwrap_or(cloud_token);
    let proxy = start_claude_code_mia_proxy(ClaudeCodeMiaProxyConfig {
        base_url,
        api_key,
        model: model.clone(),
    })
    .await
    .map_err(|error| CloudError::Runtime(error.to_string()))?;
    strip_claude_auth_environment(&mut plan.environment);
    plan.environment
        .insert("ANTHROPIC_BASE_URL".into(), proxy.base_url.clone());
    plan.environment
        .insert("ANTHROPIC_AUTH_TOKEN".into(), proxy.auth_token.clone());
    plan.environment
        .insert("ANTHROPIC_MODEL".into(), model.clone());
    plan.environment
        .insert("ANTHROPIC_DEFAULT_OPUS_MODEL".into(), model.clone());
    plan.environment
        .insert("ANTHROPIC_DEFAULT_SONNET_MODEL".into(), model.clone());
    plan.environment
        .insert("ANTHROPIC_DEFAULT_HAIKU_MODEL".into(), model.clone());
    plan.environment
        .insert("CLAUDE_CODE_SUBAGENT_MODEL".into(), model);
    if let Some(effort) = first_string(runtime_config, &["effortLevel", "effort_level"])
        .map(|value| normalize_claude_effort(&value))
        .filter(|value| !value.is_empty())
    {
        plan.environment
            .insert("CLAUDE_CODE_EFFORT_LEVEL".into(), effort.clone());
    }
    Ok(Some(proxy))
}

async fn prepare_codex_mia_runtime(
    cloud: &CloudService,
    runtime_config: &Value,
    plan: &mut RuntimeTurnPlan,
) -> Result<Option<RunningCodexMiaProxy>, CloudError> {
    if plan.engine != "codex" || plan.command.is_none() || !is_mia_managed(plan, runtime_config) {
        return Ok(None);
    }
    let status = cloud.status(true).await?;
    let cloud_token = status.token.unwrap_or_default();
    if cloud_token.trim().is_empty() {
        return Err(CloudError::InvalidInput("cloud is not connected".into()));
    }
    let model = first_string(&plan.provider, &["model"])
        .or_else(|| first_string(runtime_config, &["model"]))
        .unwrap_or_else(|| "mia-auto".to_string());
    let base_url = first_string(&plan.provider, &["baseUrl", "base_url"]).unwrap_or_else(|| {
        format!(
            "{}/api/me/model-proxy/v1",
            status.url.trim().trim_end_matches('/')
        )
    });
    let api_key = first_string(&plan.provider, &["apiKey", "api_key"]).unwrap_or(cloud_token);
    let proxy = start_codex_mia_proxy(CodexMiaProxyConfig {
        base_url,
        api_key,
        model: model.clone(),
    })
    .await
    .map_err(|error| CloudError::Runtime(error.to_string()))?;
    strip_codex_auth_environment(&mut plan.environment);
    plan.environment
        .insert("CODEX_API_KEY".into(), proxy.api_key.clone());
    plan.environment
        .insert("OPENAI_BASE_URL".into(), proxy.base_url.clone());
    plan.environment.insert("CODEX_MODEL".into(), model);
    Ok(Some(proxy))
}

fn strip_claude_auth_environment(environment: &mut std::collections::BTreeMap<String, String>) {
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "CLAUDE_CODE_EFFORT_LEVEL",
    ] {
        environment.remove(key);
    }
}

fn strip_codex_auth_environment(environment: &mut std::collections::BTreeMap<String, String>) {
    for key in [
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_ORG_ID",
        "MODEL_PROVIDER",
        "CODEX_CONFIG",
        "MIA_CODEX_MODEL_CATALOG_JSON",
    ] {
        environment.remove(key);
    }
}

fn normalize_claude_effort(value: &str) -> String {
    match value.trim() {
        "extra-high" | "extra_high" => "xhigh".into(),
        "low" | "medium" | "high" | "xhigh" | "max" => value.trim().into(),
        "" => String::new(),
        _ => "medium".into(),
    }
}

fn is_mia_managed(plan: &RuntimeTurnPlan, runtime_config: &Value) -> bool {
    for source in [&plan.provider, runtime_config] {
        if first_string(source, &["providerConnectionId", "provider_connection_id"]).as_deref()
            == Some("mia")
            || first_string(source, &["provider", "modelProvider", "model_provider"]).as_deref()
                == Some("mia")
            || first_string(source, &["authType", "auth_type"]).as_deref() == Some("mia_account")
            || first_string(
                source,
                &[
                    "modelProfileId",
                    "model_profile_id",
                    "profileId",
                    "profile_id",
                ],
            )
            .is_some_and(|value| value.starts_with("mia:"))
        {
            return true;
        }
    }
    false
}

fn emit_cloud_run_started(
    realtime: &EventBus,
    cloud_conversation_id: &str,
    run_id: &str,
    plan: &RuntimeTurnPlan,
    metadata: &Value,
) {
    if plan.command.is_none() {
        return;
    }
    realtime.emit(
        "cloud_agent_run_started",
        json!({
            "conversationId": cloud_conversation_id,
            "runId": run_id,
            "turnId": plan.turn_id,
            "botId": bot_id_from_metadata(metadata)
                .unwrap_or_else(|| plan.bot_id.clone().unwrap_or_else(|| "mia".to_string())),
            "engine": plan.engine,
        }),
    );
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RuntimeDisplayOutput {
    pub(crate) text: String,
    pub(crate) trace: Value,
    pub(crate) content_blocks: Value,
}

pub(crate) fn normalize_runtime_output(
    engine: &str,
    stdout: &str,
    stderr: &str,
) -> RuntimeDisplayOutput {
    if engine != "claude-code" && engine != "codex" {
        let stderr = clean_runtime_stderr_for_display(engine, stderr);
        return RuntimeDisplayOutput {
            text: if stdout.trim().is_empty() {
                stderr
            } else {
                stdout.to_string()
            },
            trace: json!({}),
            content_blocks: json!([]),
        };
    }
    let mut collector = CloudRunCollector::default();
    for line in stdout.lines() {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if engine == "claude-code" {
                collector.apply_claude_json_line(&value);
            } else {
                collector.apply_codex_json_line(&value);
            }
        }
    }
    if collector.text.trim().is_empty() {
        collector.text = strip_jsonl_runtime_noise(engine, stdout).trim().to_string();
    }
    if collector.text.trim().is_empty() && !stderr.trim().is_empty() {
        collector.text = clean_runtime_stderr_for_display(engine, stderr);
    }
    RuntimeDisplayOutput {
        text: collector.text.trim().to_string(),
        trace: collector.trace(),
        content_blocks: collector.content_blocks(),
    }
}

fn cloud_run_events_from_stdout(engine: &str, text: &str) -> Vec<Value> {
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .flat_map(|value| {
            if engine == "codex" {
                codex_json_line_to_run_events(&value)
            } else {
                claude_json_line_to_run_events(&value)
            }
        })
        .collect()
}

fn codex_json_line_to_run_events(value: &Value) -> Vec<Value> {
    let mut events = Vec::new();
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "agent_message_delta" | "message_delta" | "response.output_text.delta" => {
            if let Some(text) = first_string(
                value,
                &["delta", "text", "message", "content", "output_text_delta"],
            ) && !text.is_empty()
            {
                events.push(json!({ "type": "message.delta", "text": text }));
            }
        }
        "agent_message" | "message" => {
            if let Some(text) = first_string(value, &["message", "text", "content"])
                && !text.trim().is_empty()
            {
                events.push(json!({ "type": "message.complete", "text": text }));
            }
        }
        "task_complete" | "turn_complete" | "response.completed" => {
            let text = first_string(
                value,
                &[
                    "last_agent_message",
                    "final_response",
                    "message",
                    "text",
                    "content",
                ],
            )
            .or_else(|| {
                value
                    .get("response")
                    .and_then(|response| {
                        response
                            .get("output_text")
                            .or_else(|| response.get("text"))
                            .and_then(Value::as_str)
                    })
                    .map(str::to_string)
            });
            if let Some(text) = text
                && !text.trim().is_empty()
            {
                events.push(json!({ "type": "run.completed", "final_response": text }));
            }
        }
        "agent_reasoning" | "agent_reasoning_delta" | "reasoning_delta" => {
            if let Some(text) = first_string(value, &["text", "delta", "reasoning", "summary"])
                && !text.trim().is_empty()
            {
                events.push(json!({ "type": "reasoning_delta", "text": text }));
            }
        }
        "exec_command_begin" | "tool_call_begin" | "tool_call" => {
            events.push(json!({
                "type": "tool.started",
                "id": first_string(value, &["id", "call_id"]).unwrap_or_else(|| "tool".into()),
                "name": first_string(value, &["name", "command", "tool"]).unwrap_or_else(|| "tool".into()),
                "preview": first_string(value, &["command", "text", "input"]).unwrap_or_default(),
            }));
        }
        "exec_command_output_delta" | "tool_call_delta" => {
            if let Some(text) = first_string(value, &["delta", "text", "output", "preview"])
                && !text.is_empty()
            {
                events.push(json!({ "type": "tool.delta", "delta": text, "preview": text }));
            }
        }
        "exec_command_end" | "tool_call_end" | "tool_result" => {
            events.push(json!({ "type": "tool.completed" }));
        }
        "error" => {
            let message = value
                .get("error")
                .and_then(|error| {
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .or_else(|| error.as_str())
                })
                .or_else(|| value.get("message").and_then(Value::as_str))
                .unwrap_or("Codex failed.");
            events.push(json!({ "type": "error", "text": message, "message": message }));
        }
        _ => {
            if let Some(item) = value.get("item")
                && let Some(item_type) = item.get("type").and_then(Value::as_str)
            {
                if item_type == "message" || item_type == "agent_message" {
                    let text = block_text(item);
                    if !text.trim().is_empty() {
                        events.push(json!({ "type": "message.complete", "text": text }));
                    }
                } else if item_type.contains("call") {
                    events.push(json!({
                        "type": "tool.started",
                        "id": string_field(item, &["id", "call_id"]).unwrap_or_else(|| "tool".into()),
                        "name": string_field(item, &["name"]).unwrap_or_else(|| "tool".into()),
                        "preview": block_text(item),
                    }));
                }
            }
        }
    }
    events
}

fn claude_json_line_to_run_events(value: &Value) -> Vec<Value> {
    let mut events = Vec::new();
    match value.get("type").and_then(Value::as_str).unwrap_or("") {
        "stream_event" => {
            if let Some(event) = value.get("event") {
                events.extend(claude_stream_event_to_run_events(event));
            }
        }
        "assistant" => {
            let text = assistant_message_text(value);
            if !text.trim().is_empty() {
                events.push(json!({ "type": "message.complete", "text": text }));
            }
        }
        "result" => {
            if let Some(text) = first_string(value, &["result", "output_text", "content"])
                && !text.trim().is_empty()
            {
                events.push(json!({ "type": "run.completed", "final_response": text }));
            }
        }
        "error" => {
            let message = value
                .get("error")
                .and_then(|error| {
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .or_else(|| error.as_str())
                })
                .or_else(|| value.get("message").and_then(Value::as_str))
                .unwrap_or("Claude Code failed.");
            events.push(json!({ "type": "error", "text": message }));
        }
        _ => {}
    }
    events
}

fn claude_stream_event_to_run_events(event: &Value) -> Vec<Value> {
    match event.get("type").and_then(Value::as_str).unwrap_or("") {
        "content_block_start" => {
            let block = event.get("content_block").unwrap_or(&Value::Null);
            match block.get("type").and_then(Value::as_str).unwrap_or("") {
                "tool_use" => vec![json!({
                    "type": "tool.started",
                    "id": string_field(block, &["id"]).unwrap_or_default(),
                    "name": string_field(block, &["name"]).unwrap_or_else(|| "tool".to_string()),
                    "input": block.get("input").cloned().unwrap_or_else(|| json!({})),
                    "preview": block.get("input").map(Value::to_string).unwrap_or_default(),
                })],
                "thinking" => vec![json!({
                    "type": "reasoning_delta",
                    "id": format!("thinking_{}", event.get("index").and_then(Value::as_i64).unwrap_or(0)),
                    "text": block_text(block),
                })],
                _ => Vec::new(),
            }
        }
        "content_block_delta" => {
            let delta = event.get("delta").unwrap_or(&Value::Null);
            match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                "text_delta" => vec![json!({
                    "type": "message.delta",
                    "text": delta.get("text").and_then(Value::as_str).unwrap_or(""),
                })],
                "thinking_delta" => vec![json!({
                    "type": "reasoning_delta",
                    "id": format!("thinking_{}", event.get("index").and_then(Value::as_i64).unwrap_or(0)),
                    "text": delta
                        .get("thinking")
                        .or_else(|| delta.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                })],
                "input_json_delta" => vec![json!({
                    "type": "tool.delta",
                    "delta": delta.get("partial_json").and_then(Value::as_str).unwrap_or(""),
                    "preview": delta.get("partial_json").and_then(Value::as_str).unwrap_or(""),
                })],
                _ => Vec::new(),
            }
        }
        "message_delta" => Vec::new(),
        _ => Vec::new(),
    }
}

#[derive(Debug, Clone, Default)]
struct CloudRunCollector {
    text: String,
    last_assistant_snapshot: String,
    reasoning: String,
    tools: Vec<Value>,
    content_blocks: Vec<Value>,
}

impl CloudRunCollector {
    fn apply_claude_json_line(&mut self, value: &Value) {
        if value.get("type").and_then(Value::as_str) == Some("assistant") {
            let snapshot = assistant_message_text(value);
            if !same_trimmed_text(&self.last_assistant_snapshot, &snapshot) {
                self.text = merge_assistant_text(&self.text, &snapshot);
                self.last_assistant_snapshot = snapshot;
            }
            return;
        }
        for event in claude_json_line_to_run_events(value) {
            self.apply_run_event(&event);
        }
    }

    fn apply_codex_json_line(&mut self, value: &Value) {
        for event in codex_json_line_to_run_events(value) {
            self.apply_run_event(&event);
        }
    }

    fn apply_run_event(&mut self, event: &Value) {
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "message.delta" | "text_delta" => {
                let text = event_text(event);
                if !text.is_empty() {
                    self.text.push_str(&text);
                    self.append_text_block(&text);
                }
            }
            "message.complete" | "message.completed" | "run.completed" => {
                let text = event_text(event);
                if !text.trim().is_empty() {
                    self.text = merge_assistant_text(&self.text, &text);
                }
            }
            "reasoning_delta" | "reasoning.available" => {
                let text = event_text(event);
                if !text.is_empty() {
                    self.reasoning.push_str(&text);
                    if !self.reasoning.ends_with('\n') {
                        self.reasoning.push('\n');
                    }
                    self.append_thinking_block(event, &text);
                }
            }
            "tool.started" | "tool_call_started" => {
                let tool = json!({
                    "id": string_field(event, &["id"]).unwrap_or_else(|| format!("tool_{}", self.tools.len())),
                    "name": string_field(event, &["name", "tool"]).unwrap_or_else(|| "tool".to_string()),
                    "preview": event_text(event),
                    "status": "running",
                    "duration": null,
                    "error": false,
                });
                self.tools.push(tool.clone());
                self.content_blocks.push(json!({
                    "type": "tool",
                    "id": tool["id"],
                    "name": tool["name"],
                    "preview": tool["preview"],
                    "status": "running",
                    "duration": null,
                    "error": false,
                }));
            }
            "tool.delta" | "tool_call_delta" => {
                let preview = event_text(event);
                if !preview.is_empty() {
                    if let Some(tool) = self.tools.last_mut()
                        && let Some(object) = tool.as_object_mut()
                    {
                        object.insert("preview".into(), json!(preview.clone()));
                    }
                    if let Some(block) = self
                        .content_blocks
                        .iter_mut()
                        .rev()
                        .find(|block| block.get("type").and_then(Value::as_str) == Some("tool"))
                        && let Some(object) = block.as_object_mut()
                    {
                        object.insert("preview".into(), json!(preview));
                    }
                }
            }
            "tool.completed" | "tool_call_completed" => {
                if let Some(tool) = self.tools.last_mut()
                    && let Some(object) = tool.as_object_mut()
                {
                    object.insert("status".into(), json!("completed"));
                }
                if let Some(block) = self
                    .content_blocks
                    .iter_mut()
                    .rev()
                    .find(|block| block.get("type").and_then(Value::as_str) == Some("tool"))
                    && let Some(object) = block.as_object_mut()
                {
                    object.insert("status".into(), json!("completed"));
                }
            }
            _ => {}
        }
    }

    fn append_text_block(&mut self, text: &str) {
        if let Some(last) = self.content_blocks.last_mut()
            && last.get("type").and_then(Value::as_str) == Some("text")
            && let Some(object) = last.as_object_mut()
        {
            let next = object
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
                + text;
            object.insert("text".into(), json!(next));
            return;
        }
        self.content_blocks.push(json!({
            "type": "text",
            "id": format!("text_{}", self.content_blocks.len()),
            "text": text,
        }));
    }

    fn append_thinking_block(&mut self, event: &Value, text: &str) {
        if let Some(last) = self.content_blocks.last_mut()
            && last.get("type").and_then(Value::as_str) == Some("thinking")
            && let Some(object) = last.as_object_mut()
        {
            let next = object
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
                + text;
            object.insert("text".into(), json!(next));
            return;
        }
        self.content_blocks.push(json!({
            "type": "thinking",
            "id": string_field(event, &["id"]).unwrap_or_else(|| format!("thinking_{}", self.content_blocks.len())),
            "text": text,
            "status": "running",
            "duration": null,
        }));
    }

    fn trace(&self) -> Value {
        let tools = self
            .tools
            .iter()
            .filter(|tool| {
                tool.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| !name.trim().is_empty())
            })
            .cloned()
            .collect::<Vec<_>>();
        let reasoning = self.reasoning.trim();
        if reasoning.is_empty() && tools.is_empty() {
            json!({})
        } else {
            json!({
                "reasoning": reasoning,
                "tools": tools,
            })
        }
    }

    fn content_blocks(&self) -> Value {
        if self.content_blocks.iter().any(|block| {
            matches!(
                block.get("type").and_then(Value::as_str),
                Some("thinking") | Some("tool") | Some("file_edit")
            )
        }) {
            Value::Array(self.content_blocks.clone())
        } else {
            json!([])
        }
    }
}

fn assistant_message_text(value: &Value) -> String {
    value
        .get("message")
        .and_then(|message| message.get("content"))
        .map(content_text)
        .or_else(|| value.get("content").map(content_text))
        .or_else(|| first_string(value, &["text", "delta"]))
        .unwrap_or_default()
}

fn content_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(block_text).collect::<Vec<_>>().join(""),
        Value::Object(_) => block_text(value),
        _ => String::new(),
    }
}

fn block_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(block_text).collect::<Vec<_>>().join(""),
        Value::Object(object) => {
            for key in [
                "text",
                "content",
                "delta",
                "output",
                "message",
                "final_response",
                "thinking",
            ] {
                if let Some(value) = object.get(key) {
                    let text = content_text(value);
                    if !text.is_empty() {
                        return text;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn event_text(event: &Value) -> String {
    for key in [
        "reasoning",
        "delta",
        "content_delta",
        "text_delta",
        "text",
        "content",
        "final_response",
        "preview",
    ] {
        if let Some(value) = event.get(key).and_then(Value::as_str) {
            return value.to_string();
        }
    }
    event
        .get("data")
        .filter(|value| value.is_object())
        .map(event_text)
        .unwrap_or_default()
}

fn merge_assistant_text(current: &str, next: &str) -> String {
    let current_trim = current.trim();
    let next_trim = next.trim();
    if next_trim.is_empty() {
        return current.to_string();
    }
    if current_trim.is_empty() {
        return next.to_string();
    }
    if current_trim == next_trim || current_trim.starts_with(next_trim) {
        return current.to_string();
    }
    if next.starts_with(current) {
        return next.to_string();
    }
    if current.ends_with('\n') || next.starts_with('\n') {
        format!("{current}{next}")
    } else {
        format!("{current}\n\n{next}")
    }
}

fn same_trimmed_text(left: &str, right: &str) -> bool {
    left.trim() == right.trim()
}

fn clean_runtime_stderr_status(engine: &str, text: &str) -> Option<String> {
    let cleaned = clean_runtime_stderr_for_display(engine, text);
    (!cleaned.trim().is_empty()).then(|| cleaned.trim().to_string())
}

fn clean_runtime_stderr_for_display(engine: &str, stderr: &str) -> String {
    if engine == "codex" {
        return stderr
            .lines()
            .filter_map(|line| {
                (!is_runtime_status_noise_line(engine, line))
                    .then(|| line.trim())
                    .filter(|line| !line.is_empty())
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    if engine != "claude-code" {
        return stderr.trim().to_string();
    }
    let mut out = Vec::new();
    let mut skipping_claude_connector_warning = false;
    for line in stderr.lines() {
        let trimmed = line.trim();
        if trimmed.contains("claude.ai connectors are disabled because") {
            skipping_claude_connector_warning = true;
            continue;
        }
        if skipping_claude_connector_warning {
            if trimmed.starts_with("Unset it to load your organization's connectors") {
                continue;
            }
            skipping_claude_connector_warning = false;
        }
        if !trimmed.is_empty() {
            out.push(trimmed.to_string());
        }
    }
    out.join("\n")
}

fn strip_jsonl_runtime_noise(engine: &str, stdout: &str) -> String {
    stdout
        .lines()
        .filter(|line| {
            serde_json::from_str::<Value>(line).is_err()
                && !is_runtime_status_noise_line(engine, line)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_runtime_status_noise_line(engine: &str, line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return true;
    }
    match engine {
        "codex" => matches!(
            trimmed,
            "Reading prompt from stdin..."
                | "Reading prompt from stdin…"
                | "Reading additional input from stdin..."
                | "Reading additional input from stdin…"
        ),
        _ => false,
    }
}

fn bot_id_from_metadata(metadata: &Value) -> Option<String> {
    metadata
        .get("cloudBridge")
        .and_then(|bridge| bridge.get("botId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn string_field(source: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| source.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn first_string(source: &Value, keys: &[&str]) -> Option<String> {
    string_field(source, keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_run_collector_does_not_duplicate_assistant_snapshot() {
        let mut collector = CloudRunCollector::default();
        collector.apply_run_event(&json!({
            "type": "message.delta",
            "text": "hello"
        }));
        collector.apply_claude_json_line(&json!({
            "type": "assistant",
            "message": {
                "content": [
                    { "type": "text", "text": "hello world" }
                ]
            }
        }));

        assert_eq!(collector.text, "hello world");
    }

    #[test]
    fn codex_prompt_status_noise_is_not_treated_as_reply_text() {
        let output = normalize_runtime_output("codex", "Reading prompt from stdin...\n", "");

        assert_eq!(output.text, "");
    }

    #[test]
    fn codex_additional_input_status_noise_is_not_treated_as_reply_text() {
        let output =
            normalize_runtime_output("codex", "Reading additional input from stdin...\n", "");

        assert_eq!(output.text, "");
    }

    #[test]
    fn codex_item_completed_agent_message_is_treated_as_reply_text() {
        let output = normalize_runtime_output(
            "codex",
            r#"Reading additional input from stdin...
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hi. What do you want to work on in Mia?"}}
{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}
"#,
            "",
        );

        assert_eq!(output.text, "Hi. What do you want to work on in Mia?");
    }
}
