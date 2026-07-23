use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use mia_core_api_types::{
    CloudBridgeCancelRequest, CloudBridgeCancelResponse, CloudBridgeRunRequest,
    CloudBridgeRunResponse, SendConversationMessageRequest,
};
use mia_core_cloud::{CloudBridgeRunHandler, CloudError, CloudService, PreparedCloudBridgeRun};
use mia_core_conversation::{
    AcceptedConversationTurn, ConversationService, EVENT_CONVERSATION_MESSAGE_CREATED,
};
use mia_core_realtime::EventBus;
use mia_core_runtime::{
    EVENT_RUNTIME_CANCEL_REQUESTED, EVENT_RUNTIME_FINISHED, EVENT_RUNTIME_STDERR,
    EVENT_RUNTIME_STDOUT, RuntimeEventSink, RuntimeProcessEvent, RuntimeProtocol,
    RuntimeSessionManager, RuntimeTurnPlan, apply_memory_isolation_to_plan,
};
use mia_core_tasks::TaskService;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;

use crate::claude_code_mia_proxy::{
    ClaudeCodeMiaProxyConfig, RunningClaudeCodeMiaProxy, start_claude_code_mia_proxy,
};
use crate::codex_mia_proxy::{CodexMiaProxyConfig, RunningCodexMiaProxy, start_codex_mia_proxy};
use crate::cron_turn::execute_runtime_with_cron;
use crate::runtime::{ConversationRuntimeClaim, RuntimeRegistry};
use crate::turn_execution::runtime_session_with_actual_id;

#[derive(Debug, Clone)]
pub struct AppCloudBridgeRunner {
    cloud: CloudService,
    conversation: ConversationService,
    tasks: TaskService,
    realtime: EventBus,
    runtime: RuntimeRegistry,
    runtime_sessions: RuntimeSessionManager,
    mia_runtime_proxies: MiaRuntimeProxyRegistry,
}

impl AppCloudBridgeRunner {
    pub fn new(
        cloud: CloudService,
        conversation: ConversationService,
        tasks: TaskService,
        realtime: EventBus,
        runtime: RuntimeRegistry,
        runtime_sessions: RuntimeSessionManager,
        mia_runtime_proxies: MiaRuntimeProxyRegistry,
    ) -> Self {
        Self {
            cloud,
            conversation,
            tasks,
            realtime,
            runtime,
            runtime_sessions,
            mia_runtime_proxies,
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
            &self.tasks,
            &self.realtime,
            &self.runtime,
            &self.runtime_sessions,
            &self.mia_runtime_proxies,
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
    tasks: &TaskService,
    realtime: &EventBus,
    runtime: &RuntimeRegistry,
    runtime_sessions: &RuntimeSessionManager,
    mia_runtime_proxies: &MiaRuntimeProxyRegistry,
    request: CloudBridgeRunRequest,
) -> Result<CloudBridgeRunResponse, CloudError> {
    let started = start_cloud_bridge_run(
        cloud,
        conversation,
        realtime,
        runtime,
        mia_runtime_proxies,
        request,
    )
    .await?;
    complete_started_cloud_bridge_run(
        conversation,
        tasks,
        realtime,
        runtime,
        runtime_sessions,
        started,
    )
    .await
}

pub struct StartedCloudBridgeRun {
    prepared: PreparedCloudBridgeRun,
    conversation_id: String,
    turn: AcceptedConversationTurn,
    runtime_plan: RuntimeTurnPlan,
    runtime_claim: ConversationRuntimeClaim,
}

const RUNTIME_EVENT_CHECKPOINT_DELAY: Duration = Duration::from_millis(50);

struct CloudRuntimeEventState {
    structured_output: RuntimeDisplayOutput,
    actual_session_id: Option<String>,
}

struct CloudRuntimeEventProcessor {
    sender: mpsc::UnboundedSender<RuntimeProcessEvent>,
    task: JoinHandle<Result<CloudRuntimeEventState, CloudError>>,
}

impl CloudRuntimeEventProcessor {
    fn spawn(
        conversation: ConversationService,
        realtime: EventBus,
        local_conversation_id: String,
        turn_id: String,
        engine: String,
        cloud_conversation_id: String,
        cloud_run_id: String,
        cloud_bot_id: String,
    ) -> Self {
        let (sender, mut receiver) = mpsc::unbounded_channel::<RuntimeProcessEvent>();
        let task = tokio::spawn(async move {
            let mut collector = CloudRunCollector::default();
            let mut actual_session_id = None;
            while let Some(first) = receiver.recv().await {
                let mut batch = vec![first];
                let mut channel_closed = false;
                let delay = tokio::time::sleep(RUNTIME_EVENT_CHECKPOINT_DELAY);
                tokio::pin!(delay);
                loop {
                    tokio::select! {
                        event = receiver.recv() => {
                            match event {
                                Some(event) => batch.push(event),
                                None => {
                                    channel_closed = true;
                                    break;
                                }
                            }
                        }
                        _ = &mut delay => break,
                    }
                }

                let mut outbound = Vec::new();
                let mut checkpoint_changed = false;
                for event in batch {
                    let name = event.name;
                    let data = event.data;
                    if name == EVENT_RUNTIME_FINISHED
                        && data.get("ok").and_then(Value::as_bool) == Some(true)
                        && let Some(session_id) = data
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                    {
                        actual_session_id = Some(session_id.to_string());
                    }
                    if name == EVENT_RUNTIME_STDOUT {
                        let run_events = data
                            .get("event")
                            .filter(|event| event.is_object())
                            .cloned()
                            .map(|event| vec![event])
                            .unwrap_or_else(|| {
                                cloud_run_events_from_stdout(
                                    &engine,
                                    data.get("text").and_then(Value::as_str).unwrap_or(""),
                                )
                            });
                        for run_event in run_events {
                            checkpoint_changed |= run_event_updates_persisted_output(&run_event);
                            collector.apply_run_event(&run_event);
                            outbound.push((
                                "cloud_agent_run_event".to_string(),
                                json!({
                                    "conversationId": cloud_conversation_id,
                                    "runId": cloud_run_id,
                                    "botId": cloud_bot_id,
                                    "event": run_event,
                                }),
                            ));
                        }
                    } else if name == EVENT_RUNTIME_STDERR {
                        let text = data.get("text").and_then(Value::as_str).unwrap_or("");
                        if let Some(text) = clean_runtime_stderr_status(&engine, text) {
                            outbound.push((
                                "cloud_agent_run_event".to_string(),
                                json!({
                                    "conversationId": cloud_conversation_id,
                                    "runId": cloud_run_id,
                                    "botId": cloud_bot_id,
                                    "event": {
                                        "type": "status",
                                        "text": text,
                                    },
                                }),
                            ));
                        }
                    }
                    outbound.push((name, data));
                }

                if checkpoint_changed {
                    let output = collector.display_output();
                    conversation
                        .checkpoint_runtime_turn(
                            &local_conversation_id,
                            &turn_id,
                            &output.text,
                            json!({
                                "engine": engine,
                                "cloudBridgeRunId": cloud_run_id,
                                "trace": output.trace,
                                "contentBlocks": output.content_blocks,
                            }),
                        )
                        .await?;
                }
                for (name, data) in outbound {
                    realtime.emit(name, data);
                }
                if channel_closed {
                    break;
                }
            }
            Ok(CloudRuntimeEventState {
                structured_output: collector.display_output(),
                actual_session_id,
            })
        });
        Self { sender, task }
    }

    async fn finish(self) -> Result<CloudRuntimeEventState, CloudError> {
        drop(self.sender);
        self.task
            .await
            .map_err(|error| CloudError::Runtime(error.to_string()))?
    }
}

fn run_event_updates_persisted_output(event: &Value) -> bool {
    matches!(
        event.get("type").and_then(Value::as_str).unwrap_or(""),
        "message.delta"
            | "text_delta"
            | "message.complete"
            | "message.completed"
            | "run.completed"
            | "reasoning_delta"
            | "reasoning.available"
            | "tool.started"
            | "tool_call_started"
            | "tool.delta"
            | "tool_call_delta"
            | "tool.completed"
            | "tool_call_completed"
            | "file_edit"
            | "file.edit"
            | "file_edit.completed"
    )
}

impl StartedCloudBridgeRun {
    pub fn accepted_response(&self) -> CloudBridgeRunResponse {
        CloudBridgeRunResponse {
            ok: true,
            run_id: self.prepared.run_id.clone(),
            conversation_id: self.conversation_id.clone(),
            cloud_conversation_id: self.prepared.cloud_conversation_id.clone(),
            message_id: self.turn.response.message_id.clone(),
            turn_id: self.turn.response.turn_id.clone(),
            assistant_message_id: self.turn.response.assistant_message_id.clone(),
            text: String::new(),
            attachments: json!([]),
            trace: json!({}),
            content_blocks: json!([]),
        }
    }

    pub fn requires_background_runtime(&self) -> bool {
        runtime_plan_uses_session_manager(&self.runtime_plan)
    }
}

pub async fn start_cloud_bridge_run(
    cloud: &CloudService,
    conversation: &ConversationService,
    realtime: &EventBus,
    runtime: &RuntimeRegistry,
    mia_runtime_proxies: &MiaRuntimeProxyRegistry,
    request: CloudBridgeRunRequest,
) -> Result<StartedCloudBridgeRun, CloudError> {
    let prepared = cloud.prepare_bridge_run(request)?;
    let bot_id = bot_id_from_metadata(&prepared.metadata);
    let conversation_row = conversation
        .ensure_external_conversation(
            &prepared.local_conversation_id,
            "cloud-bridge",
            &prepared.title,
            bot_id.as_deref(),
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
                selected_skill_ids: prepared.selected_skill_ids.clone(),
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
    let assistant_message_id = turn.response.assistant_message_id.clone();
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
    mia_runtime_proxies
        .prepare_plan(cloud, &prepared.runtime, &mut runtime_plan)
        .await?;
    emit_cloud_run_started(
        realtime,
        &prepared.cloud_conversation_id,
        &prepared.run_id,
        &runtime_plan,
        &prepared.metadata,
    );
    Ok(StartedCloudBridgeRun {
        prepared,
        conversation_id: conversation_row.id,
        turn,
        runtime_plan,
        runtime_claim,
    })
}

pub async fn complete_started_cloud_bridge_run(
    conversation: &ConversationService,
    tasks: &TaskService,
    realtime: &EventBus,
    runtime: &RuntimeRegistry,
    runtime_sessions: &RuntimeSessionManager,
    started: StartedCloudBridgeRun,
) -> Result<CloudBridgeRunResponse, CloudError> {
    let StartedCloudBridgeRun {
        prepared,
        conversation_id,
        turn,
        runtime_plan,
        mut runtime_claim,
    } = started;
    let mut assistant_message_id = turn.response.assistant_message_id.clone();
    let mut response_trace = json!({});
    let mut response_content_blocks = json!([]);
    let text = if runtime_plan_uses_session_manager(&runtime_plan) {
        let cancellation_key = cloud_bridge_runtime_key(&prepared.run_id);
        let cancellation = runtime.register(cancellation_key.clone());
        let cloud_bot_id = bot_id_from_metadata(&prepared.metadata).unwrap_or_else(|| {
            runtime_plan
                .bot_id
                .clone()
                .unwrap_or_else(|| "mia".to_string())
        });
        let event_processor = CloudRuntimeEventProcessor::spawn(
            conversation.clone(),
            realtime.clone(),
            runtime_plan.conversation_id.clone(),
            runtime_plan.turn_id.clone(),
            runtime_plan.engine.clone(),
            prepared.cloud_conversation_id.clone(),
            prepared.run_id.clone(),
            cloud_bot_id.clone(),
        );
        let event_sender = event_processor.sender.clone();
        let execution_started = Instant::now();
        let execution = execute_runtime_with_cron(
            runtime_sessions,
            tasks,
            runtime_plan.clone(),
            move |_| {
                let event_sender = event_sender.clone();
                RuntimeEventSink::new(move |event| {
                    let _ = event_sender.send(event);
                })
            },
            Some(cancellation),
        )
        .await
        .map_err(|error| CloudError::Runtime(error.to_string()));
        runtime.remove(&cancellation_key);
        let mut event_state = match event_processor.finish().await {
            Ok(event_state) => event_state,
            Err(error) => {
                runtime_claim.release();
                return Err(error);
            }
        };
        let cron_result = match execution {
            Ok(result) => result,
            Err(error) => {
                attach_process_duration(
                    &mut event_state.structured_output,
                    execution_started.elapsed(),
                );
                let body = if event_state.structured_output.text.trim().is_empty() {
                    format!("Runtime execution interrupted: {error}")
                } else {
                    event_state.structured_output.text.trim().to_string()
                };
                let interrupted = conversation
                    .interrupt_runtime_turn(
                        &runtime_plan.conversation_id,
                        &runtime_plan.turn_id,
                        &body,
                        json!({
                            "engine": runtime_plan.engine,
                            "cancelled": false,
                            "interrupted": true,
                            "error": error.to_string(),
                            "cloudBridgeRunId": prepared.run_id,
                            "trace": event_state.structured_output.trace.clone(),
                            "contentBlocks": event_state.structured_output.content_blocks.clone(),
                        }),
                    )
                    .await?;
                emit_persisted_assistant_message(
                    realtime,
                    &prepared,
                    &runtime_plan,
                    &interrupted,
                    &event_state.structured_output,
                );
                runtime_claim.release();
                return Err(error);
            }
        };
        let result = cron_result.execution;
        let runtime_session = runtime_session_with_actual_id(
            &runtime_plan.runtime_session,
            event_state.actual_session_id.as_deref(),
        );
        if cron_result.continuation_count > 0 {
            replace_collected_text(
                &mut event_state.structured_output,
                &cron_result.visible_text,
            );
        }
        let mut output = runtime_output_with_collected_events(
            &runtime_plan.engine,
            &cron_result.visible_text,
            &result.stderr,
            event_state.structured_output,
        );
        attach_process_duration(&mut output, execution_started.elapsed());
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
                    "runtimeSession": runtime_session,
                    "trace": output.trace,
                    "contentBlocks": output.content_blocks,
                }),
            )
            .await?;
        runtime_claim.release();
        assistant_message_id = Some(completed.message_id.clone());
        let run_event_type = if result.cancelled {
            "run.cancelled"
        } else if result.exit_code == Some(0) {
            "run.completed"
        } else {
            "run.failed"
        };
        realtime.emit(
            "cloud_agent_run_event",
            json!({
                "conversationId": prepared.cloud_conversation_id,
                "runId": prepared.run_id,
                "botId": bot_id_from_metadata(&prepared.metadata)
                    .unwrap_or_else(|| runtime_plan.bot_id.clone().unwrap_or_else(|| "mia".to_string())),
                "event": {
                    "type": run_event_type,
                    "final_response": body,
                },
            }),
        );
        emit_persisted_assistant_message(realtime, &prepared, &runtime_plan, &completed, &output);
        body
    } else {
        runtime_claim.release();
        turn.runtime_plan.mock_response.clone().unwrap_or_default()
    };
    Ok(CloudBridgeRunResponse {
        ok: true,
        run_id: prepared.run_id,
        conversation_id,
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

fn emit_persisted_assistant_message(
    realtime: &EventBus,
    prepared: &PreparedCloudBridgeRun,
    runtime_plan: &RuntimeTurnPlan,
    message: &mia_core_conversation::CompletedRuntimeMessage,
    output: &RuntimeDisplayOutput,
) {
    realtime.emit(
        EVENT_CONVERSATION_MESSAGE_CREATED,
        json!({
            "conversationId": runtime_plan.conversation_id,
            "messageId": message.message_id,
            "turnId": runtime_plan.turn_id,
            "role": "assistant",
            "accepted": true,
            "cloudConversationId": prepared.cloud_conversation_id,
            "cloudBridgeRunId": prepared.run_id,
            "message": {
                "id": message.message_id,
                "conversation_id": runtime_plan.conversation_id,
                "seq": message.seq,
                "sender_kind": "bot",
                "sender_ref": runtime_plan.bot_id.clone().unwrap_or_else(|| "mia".to_string()),
                "body_md": message.body,
                "status": message.status,
                "turn_id": runtime_plan.turn_id,
                "trace": output.trace,
                "contentBlocks": output.content_blocks,
                "created_at": message.created_at,
            },
        }),
    );
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

fn runtime_plan_uses_session_manager(plan: &RuntimeTurnPlan) -> bool {
    plan.command.is_some()
        || matches!(
            plan.protocol,
            RuntimeProtocol::NativeAcp | RuntimeProtocol::HermesGateway
        )
}

#[derive(Debug, Clone)]
pub struct MiaRuntimeProxyRegistry {
    data_dir: Arc<PathBuf>,
    entries: Arc<Mutex<HashMap<String, MiaRuntimeProxyEntry>>>,
}

impl MiaRuntimeProxyRegistry {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: Arc::new(data_dir.into()),
            entries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn prepare_plan(
        &self,
        cloud: &CloudService,
        runtime_config: &Value,
        plan: &mut RuntimeTurnPlan,
    ) -> Result<(), CloudError> {
        if plan.command.is_none() || !is_mia_managed(plan, runtime_config) {
            return Ok(());
        }
        let status = cloud.status(true).await?;
        let cloud_token = status.token.unwrap_or_default();
        if cloud_token.trim().is_empty() {
            return Err(CloudError::InvalidInput("cloud is not connected".into()));
        }
        let model = first_string(runtime_config, &["platformModel", "platform_model"])
            .or_else(|| first_string(&plan.provider, &["model"]))
            .or_else(|| first_string(runtime_config, &["model"]))
            .unwrap_or_else(|| "mia-auto".to_string());
        let upstream_base_url = first_string(&plan.provider, &["baseUrl", "base_url"])
            .unwrap_or_else(|| {
                format!(
                    "{}/api/me/model-proxy/v1",
                    status.url.trim().trim_end_matches('/')
                )
            });
        let upstream_api_key =
            first_string(&plan.provider, &["apiKey", "api_key"]).unwrap_or(cloud_token);
        let key = format!("{}:{}", plan.engine, plan.conversation_id);
        let identity = proxy_identity(&plan.engine, &upstream_base_url, &upstream_api_key, &model);
        let access = {
            let mut entries = self.entries.lock().await;
            let reusable = entries
                .get(&key)
                .filter(|entry| entry.identity == identity)
                .map(MiaRuntimeProxyEntry::access);
            if let Some(access) = reusable {
                access
            } else {
                let handle = match plan.engine.as_str() {
                    "claude-code" => MiaRuntimeProxyHandle::Claude(
                        start_claude_code_mia_proxy(ClaudeCodeMiaProxyConfig {
                            base_url: upstream_base_url.clone(),
                            api_key: upstream_api_key.clone(),
                            model: model.clone(),
                        })
                        .await
                        .map_err(|error| CloudError::Runtime(error.to_string()))?,
                    ),
                    "codex" | "hermes" => MiaRuntimeProxyHandle::OpenAi(
                        start_codex_mia_proxy(CodexMiaProxyConfig {
                            base_url: upstream_base_url.clone(),
                            api_key: upstream_api_key.clone(),
                            model: model.clone(),
                            auth_via_path: plan.engine == "hermes",
                        })
                        .await
                        .map_err(|error| CloudError::Runtime(error.to_string()))?,
                    ),
                    _ => return Ok(()),
                };
                let entry = MiaRuntimeProxyEntry { identity, handle };
                let access = entry.access();
                entries.insert(key.clone(), entry);
                access
            }
        };

        plan.environment
            .insert("MIA_PLATFORM_PROVIDER".into(), "mia".into());
        plan.environment
            .insert("MIA_PLATFORM_MODEL".into(), model.clone());
        let platform_models = platform_model_options(runtime_config, &model);
        if !platform_models.is_empty() {
            plan.environment
                .insert("MIA_PLATFORM_MODELS".into(), platform_models.join(","));
        }
        match plan.engine.as_str() {
            "claude-code" => {
                strip_claude_auth_environment(&mut plan.environment);
                plan.environment
                    .insert("ANTHROPIC_BASE_URL".into(), access.base_url);
                plan.environment
                    .insert("ANTHROPIC_AUTH_TOKEN".into(), access.api_key);
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
                        .insert("CLAUDE_CODE_EFFORT_LEVEL".into(), effort);
                }
            }
            "codex" => {
                strip_codex_auth_environment(&mut plan.environment);
                let catalog_path = self.write_codex_model_catalog(&key, &model).await?;
                let real_codex_path = plan
                    .environment
                    .get("CODEX_PATH")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .ok_or_else(|| {
                        CloudError::Runtime("Codex executable path is missing".into())
                    })?;
                let codex_launcher = self.write_codex_launcher().await?;
                let effort = first_string(runtime_config, &["effortLevel", "effort_level"])
                    .filter(|effort| {
                        matches!(
                            effort.as_str(),
                            "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
                        )
                    })
                    .unwrap_or_else(|| "high".into());
                let config = codex_mia_session_config(
                    &access.base_url,
                    &model,
                    &catalog_path,
                    &effort,
                    runtime_config,
                );
                plan.environment
                    .insert("CODEX_API_KEY".into(), access.api_key);
                plan.environment
                    .insert("MIA_CODEX_REAL_PATH".into(), real_codex_path);
                plan.environment.insert(
                    "MIA_CODEX_MODEL_CATALOG_JSON".into(),
                    catalog_path.to_string_lossy().into_owned(),
                );
                plan.environment.insert(
                    "CODEX_PATH".into(),
                    codex_launcher.to_string_lossy().into_owned(),
                );
                plan.environment
                    .insert("MODEL_PROVIDER".into(), "custom".into());
                plan.environment.insert(
                    "MIA_PLATFORM_REASONING_EFFORTS".into(),
                    "none,low,medium,high".into(),
                );
                plan.environment
                    .insert("MIA_PLATFORM_REASONING_EFFORT".into(), effort);
                plan.environment.insert(
                    "CODEX_CONFIG".into(),
                    serde_json::to_string(&config)
                        .map_err(|error| CloudError::Runtime(error.to_string()))?,
                );
            }
            "hermes" => {
                strip_hermes_mia_environment(&mut plan.environment);
                let effort = hermes_effort_level(runtime_config);
                let hermes_home = self
                    .write_hermes_mia_runtime_home(&key, &access, &model, runtime_config)
                    .await?;
                plan.environment
                    .insert("CUSTOM_BASE_URL".into(), access.base_url);
                plan.environment
                    .insert("OPENAI_API_KEY".into(), access.api_key);
                plan.environment.insert(
                    "HERMES_HOME".into(),
                    hermes_home.to_string_lossy().into_owned(),
                );
                plan.environment
                    .insert("HERMES_NONINTERACTIVE".into(), "1".into());
                plan.environment.insert(
                    "MIA_PLATFORM_REASONING_EFFORTS".into(),
                    "none,minimal,low,medium,high,xhigh,max".into(),
                );
                plan.environment
                    .insert("MIA_PLATFORM_REASONING_EFFORT".into(), effort);
            }
            _ => {}
        }
        apply_memory_isolation_to_plan(plan);
        Ok(())
    }

    async fn write_codex_model_catalog(
        &self,
        key: &str,
        model: &str,
    ) -> Result<PathBuf, CloudError> {
        let directory = self.data_dir.join("runtime").join("mia-model-catalogs");
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|error| CloudError::Runtime(error.to_string()))?;
        let path = directory.join(format!("{}.json", short_hash(&format!("{key}:{model}"))));
        let bytes = serde_json::to_vec_pretty(&codex_mia_model_catalog(model))
            .map_err(|error| CloudError::Runtime(error.to_string()))?;
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|error| CloudError::Runtime(error.to_string()))?;
        Ok(path)
    }

    async fn write_codex_launcher(&self) -> Result<PathBuf, CloudError> {
        let directory = self.data_dir.join("runtime").join("codex-launcher");
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|error| CloudError::Runtime(error.to_string()))?;
        #[cfg(windows)]
        let (path, contents) = (
            directory.join("mia-codex-launcher.cmd"),
            "@echo off\r\nif \"%MIA_CODEX_REAL_PATH%\"==\"\" exit /b 2\r\nif \"%MIA_CODEX_MODEL_CATALOG_JSON%\"==\"\" exit /b 2\r\n\"%MIA_CODEX_REAL_PATH%\" %* -c \"model_catalog_json=\\\"%MIA_CODEX_MODEL_CATALOG_JSON%\\\"\"\r\n",
        );
        #[cfg(not(windows))]
        let (path, contents) = (
            directory.join("mia-codex-launcher"),
            "#!/bin/sh\nset -eu\n: \"${MIA_CODEX_REAL_PATH:?}\"\n: \"${MIA_CODEX_MODEL_CATALOG_JSON:?}\"\nexec \"$MIA_CODEX_REAL_PATH\" \"$@\" -c \"model_catalog_json=\\\"$MIA_CODEX_MODEL_CATALOG_JSON\\\"\"\n",
        );
        tokio::fs::write(&path, contents)
            .await
            .map_err(|error| CloudError::Runtime(error.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
                .await
                .map_err(|error| CloudError::Runtime(error.to_string()))?;
        }
        Ok(path)
    }

    async fn write_hermes_mia_runtime_home(
        &self,
        key: &str,
        access: &MiaRuntimeProxyAccess,
        model: &str,
        runtime_config: &Value,
    ) -> Result<PathBuf, CloudError> {
        let model = model.trim();
        let model = if model.is_empty() { "mia-auto" } else { model };
        let home = self
            .data_dir
            .join("runtime")
            .join("hermes-cloud-bridge")
            .join(short_hash(key));
        tokio::fs::create_dir_all(home.join("skills"))
            .await
            .map_err(|error| CloudError::Runtime(error.to_string()))?;
        let config = json!({
            "mia": {
                "runtime_schema": 1,
                "managed_by": "mia-cloud-bridge",
            },
            "model": {
                "provider": "custom",
                "default": model,
                "base_url": access.base_url,
                "api_mode": "chat_completions",
            },
            "providers": {
                "custom": {
                    "name": "Mia",
                    "base_url": access.base_url,
                    "key_env": "OPENAI_API_KEY",
                    "default_model": model,
                    "api_mode": "chat_completions",
                },
            },
            "approvals": {
                "mode": hermes_permission_mode(runtime_config),
                "timeout": 60,
            },
            "agent": {
                "reasoning_effort": hermes_effort_level(runtime_config),
                "disabled_toolsets": ["browser", "cronjob"],
            },
            "skills": {
                "external_dirs": ["${MIA_HERMES_SKILLS_DIR}"],
            },
        });
        let bytes = serde_json::to_vec_pretty(&config)
            .map_err(|error| CloudError::Runtime(error.to_string()))?;
        tokio::fs::write(home.join("config.yaml"), bytes)
            .await
            .map_err(|error| CloudError::Runtime(error.to_string()))?;
        Ok(home)
    }
}

#[derive(Debug)]
struct MiaRuntimeProxyEntry {
    identity: String,
    handle: MiaRuntimeProxyHandle,
}

impl MiaRuntimeProxyEntry {
    fn access(&self) -> MiaRuntimeProxyAccess {
        match &self.handle {
            MiaRuntimeProxyHandle::Claude(proxy) => MiaRuntimeProxyAccess {
                base_url: proxy.base_url.clone(),
                api_key: proxy.auth_token.clone(),
            },
            MiaRuntimeProxyHandle::OpenAi(proxy) => MiaRuntimeProxyAccess {
                base_url: proxy.base_url.clone(),
                api_key: proxy.api_key.clone(),
            },
        }
    }
}

#[derive(Debug)]
enum MiaRuntimeProxyHandle {
    Claude(RunningClaudeCodeMiaProxy),
    OpenAi(RunningCodexMiaProxy),
}

#[derive(Debug)]
struct MiaRuntimeProxyAccess {
    base_url: String,
    api_key: String,
}

fn proxy_identity(engine: &str, base_url: &str, api_key: &str, model: &str) -> String {
    short_hash(&format!("{engine}\n{base_url}\n{api_key}\n{model}"))
}

fn short_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn codex_mia_model_catalog(model: &str) -> Value {
    let model = model.trim();
    let label = if matches!(model, "mia-auto" | "mia-default") {
        "Auto"
    } else {
        model
    };
    json!({
        "models": [{
            "slug": model,
            "display_name": label,
            "description": label,
            "base_instructions": "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.",
            "default_reasoning_level": "high",
            "supported_reasoning_levels": [
                { "effort": "none", "description": "Disable Thinking" },
                { "effort": "low", "description": "Fast responses with lighter reasoning" },
                { "effort": "medium", "description": "Balanced responses" },
                { "effort": "high", "description": "Enabled Thinking" }
            ],
            "shell_type": "shell_command",
            "visibility": "list",
            "supported_in_api": true,
            "priority": 1000,
            "additional_speed_tiers": [],
            "service_tiers": [],
            "availability_nux": null,
            "upgrade": null,
            "supports_reasoning_summaries": true,
            "default_reasoning_summary": "none",
            "support_verbosity": false,
            "truncation_policy": { "mode": "bytes", "limit": 10000 },
            "supports_parallel_tool_calls": false,
            "supports_image_detail_original": false,
            "context_window": 262144,
            "max_context_window": 262144,
            "effective_context_window_percent": 95,
            "experimental_supported_tools": [],
            "input_modalities": ["text"],
            "supports_search_tool": false
        }]
    })
}

fn codex_mia_session_config(
    base_url: &str,
    model: &str,
    model_catalog_path: &Path,
    effort: &str,
    runtime_config: &Value,
) -> Value {
    let mut config = serde_json::Map::from_iter([
        ("model".into(), json!(model)),
        ("model_provider".into(), json!("custom")),
        (
            "model_catalog_json".into(),
            json!(model_catalog_path.to_string_lossy()),
        ),
        ("disable_response_storage".into(), json!(true)),
        ("model_reasoning_effort".into(), json!(effort)),
        (
            "model_providers".into(),
            json!({
                "custom": {
                    "name": "Mia",
                    "base_url": base_url.trim_end_matches('/'),
                    "wire_api": "responses",
                    "env_key": "CODEX_API_KEY",
                    "requires_openai_auth": false
                }
            }),
        ),
    ]);
    if let Some(permission) = first_string(runtime_config, &["permissionMode", "permission_mode"]) {
        let (approval_policy, sandbox_mode) = codex_permission_config(&permission);
        config.insert("approval_policy".into(), json!(approval_policy));
        config.insert("sandbox_mode".into(), json!(sandbox_mode));
    }
    Value::Object(config)
}

fn codex_permission_config(value: &str) -> (&'static str, &'static str) {
    match value.trim() {
        "read-only" | ":read-only" | "readOnly" => ("never", "read-only"),
        "full-access" | ":danger-full-access" | "bypassPermissions" | "yolo" | "off" | "never" => {
            ("never", "danger-full-access")
        }
        "auto" | ":workspace" => ("on-request", "workspace-write"),
        "acceptEdits" => ("on-request", "workspace-write"),
        _ => ("untrusted", "workspace-write"),
    }
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

fn strip_hermes_mia_environment(environment: &mut std::collections::BTreeMap<String, String>) {
    for key in [
        "CUSTOM_BASE_URL",
        "OPENAI_BASE_URL",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "CODEX_API_KEY",
        "XAI_API_KEY",
        "DEEPSEEK_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "DASHSCOPE_API_KEY",
        "KIMI_API_KEY",
        "MINIMAX_API_KEY",
        "GROQ_API_KEY",
        "MISTRAL_API_KEY",
        "OLLAMA_API_KEY",
        "MODEL_PROVIDER",
        "HERMES_HOME",
    ] {
        environment.remove(key);
    }
}

fn hermes_permission_mode(runtime_config: &Value) -> String {
    match first_string(runtime_config, &["permissionMode", "permission_mode"])
        .unwrap_or_else(|| "smart".into())
        .to_ascii_lowercase()
        .as_str()
    {
        "yolo"
        | "dontask"
        | "bypasspermissions"
        | "never"
        | "off"
        | "agent-full-access"
        | "full-access"
        | ":danger-full-access" => "off".into(),
        "manual" | "read-only" | "readonly" | ":read-only" => "manual".into(),
        "smart" | "acceptedits" | "auto" | "ask" | "default" => "smart".into(),
        other if !other.trim().is_empty() => other.trim().into(),
        _ => "smart".into(),
    }
}

fn hermes_effort_level(runtime_config: &Value) -> String {
    match first_string(runtime_config, &["effortLevel", "effort_level"])
        .unwrap_or_else(|| "medium".into())
        .as_str()
    {
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" => {
            first_string(runtime_config, &["effortLevel", "effort_level"])
                .unwrap_or_else(|| "medium".into())
        }
        "off" => "none".into(),
        "extra-high" | "extra_high" => "xhigh".into(),
        _ => "medium".into(),
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
        if source_is_mia_managed(source) {
            return true;
        }
    }
    false
}

fn source_is_mia_managed(source: &Value) -> bool {
    first_string(source, &["providerConnectionId", "provider_connection_id"]).as_deref()
        == Some("mia")
        || first_string(source, &["platformProvider", "platform_provider"]).as_deref()
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
        || first_string(
            source,
            &[
                "platformModelProfileId",
                "platform_model_profile_id",
                "platformProfileId",
                "platform_profile_id",
            ],
        )
        .is_some_and(|value| value.starts_with("mia:"))
        || first_string(source, &["model"]).is_some_and(|value| is_builtin_mia_model(&value))
        || first_string(source, &["platformModel", "platform_model"])
            .is_some_and(|value| is_builtin_mia_model(&value))
}

fn is_builtin_mia_model(model: &str) -> bool {
    matches!(model.trim(), "mia-auto" | "mia-default")
}

fn platform_model_options(runtime_config: &Value, current_model: &str) -> Vec<String> {
    let mut models = Vec::new();
    push_platform_model_option(&mut models, current_model);
    push_platform_model_option(&mut models, "mia-auto");
    if let Some(entries) = runtime_config
        .get("modelEntries")
        .or_else(|| runtime_config.get("model_entries"))
        .and_then(Value::as_array)
    {
        for entry in entries {
            if !model_entry_is_mia_managed(entry) {
                continue;
            }
            if let Some(model) = first_string(entry, &["model", "value", "id"])
                .as_deref()
                .map(canonical_mia_model_id)
            {
                push_platform_model_option(&mut models, &model);
            }
        }
    }
    models
}

fn push_platform_model_option(models: &mut Vec<String>, model: &str) {
    let model = canonical_mia_model_id(model);
    if model.is_empty() || models.iter().any(|existing| existing == &model) {
        return;
    }
    models.push(model);
}

fn model_entry_is_mia_managed(entry: &Value) -> bool {
    first_string(
        entry,
        &["provider", "providerConnectionId", "provider_connection_id"],
    )
    .as_deref()
        == Some("mia")
        || first_string(entry, &["authType", "auth_type"]).as_deref() == Some("mia_account")
        || first_string(
            entry,
            &[
                "modelProfileId",
                "model_profile_id",
                "profileId",
                "profile_id",
            ],
        )
        .is_some_and(|value| value.starts_with("mia:"))
        || first_string(entry, &["model", "value", "id"])
            .is_some_and(|value| is_builtin_mia_model(&value))
}

fn canonical_mia_model_id(model: &str) -> String {
    let model = model.trim();
    if model == "mia-default" {
        "mia-auto".into()
    } else {
        model.into()
    }
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

pub(crate) fn attach_process_duration(output: &mut RuntimeDisplayOutput, duration: Duration) {
    let has_trace = output
        .trace
        .as_object()
        .is_some_and(|trace| !trace.is_empty());
    let has_content_blocks = output
        .content_blocks
        .as_array()
        .is_some_and(|blocks| !blocks.is_empty());
    if !has_trace && !has_content_blocks {
        return;
    }
    if !output.trace.is_object() {
        output.trace = json!({});
    }
    if let Some(trace) = output.trace.as_object_mut() {
        trace.insert("duration".into(), json!(duration.as_secs_f64()));
    }
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

fn runtime_output_with_collected_events(
    engine: &str,
    stdout: &str,
    stderr: &str,
    structured: RuntimeDisplayOutput,
) -> RuntimeDisplayOutput {
    let mut output = normalize_runtime_output(engine, stdout, stderr);
    if !structured.text.trim().is_empty() {
        output.text = structured.text;
    }
    if structured
        .trace
        .as_object()
        .is_some_and(|trace| !trace.is_empty())
    {
        output.trace = structured.trace;
    }
    if structured
        .content_blocks
        .as_array()
        .is_some_and(|blocks| !blocks.is_empty())
    {
        output.content_blocks = structured.content_blocks;
    }
    output
}

fn replace_collected_text(output: &mut RuntimeDisplayOutput, text: &str) {
    let text = text.trim();
    output.text = text.to_string();
    let Some(blocks) = output.content_blocks.as_array_mut() else {
        return;
    };
    blocks.retain(|block| block.get("type").and_then(Value::as_str) != Some("text"));
    if !text.is_empty() {
        blocks.push(json!({
            "type": "text",
            "id": format!("text_{}", blocks.len()),
            "text": text,
        }));
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

const MAX_RUNTIME_REASONING_CHARS: usize = 128 * 1024;
const MAX_RUNTIME_TOOL_PREVIEW_CHARS: usize = 16 * 1024;
const MAX_RUNTIME_FILE_DIFF_CHARS: usize = 128 * 1024;

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
                    truncate_middle(&mut self.reasoning, MAX_RUNTIME_REASONING_CHARS);
                    self.append_thinking_block(event, &text);
                }
            }
            "tool.started" | "tool_call_started" => {
                let preview = truncated_text(&event_text(event), MAX_RUNTIME_TOOL_PREVIEW_CHARS);
                let tool = json!({
                    "id": string_field(event, &["id"]).unwrap_or_else(|| format!("tool_{}", self.tools.len())),
                    "name": string_field(event, &["name", "tool"]).unwrap_or_else(|| "tool".to_string()),
                    "preview": preview,
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
                    update_tool_record(
                        matching_tool_record(&mut self.tools, event, None),
                        event,
                        Some(&preview),
                        None,
                    );
                    update_tool_record(
                        matching_tool_record(&mut self.content_blocks, event, Some("tool")),
                        event,
                        Some(&preview),
                        None,
                    );
                }
            }
            "tool.completed" | "tool_call_completed" => {
                let preview = event_text(event);
                update_tool_record(
                    matching_tool_record(&mut self.tools, event, None),
                    event,
                    (!preview.is_empty()).then_some(preview.as_str()),
                    Some("completed"),
                );
                update_tool_record(
                    matching_tool_record(&mut self.content_blocks, event, Some("tool")),
                    event,
                    (!preview.is_empty()).then_some(preview.as_str()),
                    Some("completed"),
                );
            }
            "file_edit" | "file.edit" | "file_edit.completed" => {
                self.upsert_file_edit_block(event);
            }
            _ => {}
        }
    }

    fn upsert_file_edit_block(&mut self, event: &Value) {
        let path = string_field(event, &["path", "file", "file_path"]).unwrap_or_default();
        if path.is_empty() {
            return;
        }
        let id = string_field(event, &["id"])
            .unwrap_or_else(|| format!("file_edit_{}", self.content_blocks.len()));
        let tool_call_id = string_field(event, &["toolCallId", "tool_call_id"]).unwrap_or_default();
        if !tool_call_id.is_empty() {
            self.content_blocks.retain(|block| {
                if block.get("type").and_then(Value::as_str) != Some("tool")
                    || block.get("id").and_then(Value::as_str) != Some(tool_call_id.as_str())
                {
                    return true;
                }
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let preview = block.get("preview").and_then(Value::as_str).unwrap_or("");
                !preview.trim().is_empty() && !name.contains("edit")
            });
        }
        let block = json!({
            "type": "file_edit",
            "id": id,
            "path": path,
            "action": string_field(event, &["action", "kind"]).unwrap_or_else(|| "update".to_string()),
            "title": string_field(event, &["title", "name"]).unwrap_or_default(),
            "diff": truncated_text(
                &string_field(event, &["diff", "preview"]).unwrap_or_default(),
                MAX_RUNTIME_FILE_DIFF_CHARS,
            ),
            "additions": event.get("additions").and_then(Value::as_u64).unwrap_or(0),
            "deletions": event.get("deletions").and_then(Value::as_u64).unwrap_or(0),
            "status": string_field(event, &["status"]).unwrap_or_else(|| "completed".to_string()),
            "error": event.get("error").and_then(Value::as_bool).unwrap_or(false),
        });
        if let Some(existing) = self.content_blocks.iter_mut().find(|item| {
            item.get("type").and_then(Value::as_str) == Some("file_edit")
                && item.get("id").and_then(Value::as_str) == Some(id.as_str())
        }) {
            *existing = block;
        } else {
            self.content_blocks.push(block);
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
            object.insert(
                "text".into(),
                json!(truncated_text(&next, MAX_RUNTIME_REASONING_CHARS)),
            );
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
            object.insert(
                "text".into(),
                json!(truncated_text(&next, MAX_RUNTIME_REASONING_CHARS)),
            );
            return;
        }
        self.content_blocks.push(json!({
            "type": "thinking",
            "id": string_field(event, &["id"]).unwrap_or_else(|| format!("thinking_{}", self.content_blocks.len())),
            "text": truncated_text(text, MAX_RUNTIME_REASONING_CHARS),
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

    fn display_output(&self) -> RuntimeDisplayOutput {
        RuntimeDisplayOutput {
            text: self.text.trim().to_string(),
            trace: self.trace(),
            content_blocks: self.content_blocks(),
        }
    }
}

fn matching_tool_record<'a>(
    records: &'a mut [Value],
    event: &Value,
    record_type: Option<&str>,
) -> Option<&'a mut Value> {
    let event_id = string_field(event, &["id"]).unwrap_or_default();
    let matches_type = |record: &&mut Value| {
        record_type
            .is_none_or(|expected| record.get("type").and_then(Value::as_str) == Some(expected))
    };
    if !event_id.is_empty() {
        let matching_index = records.iter().rposition(|record| {
            record_type
                .is_none_or(|expected| record.get("type").and_then(Value::as_str) == Some(expected))
                && record.get("id").and_then(Value::as_str) == Some(event_id.as_str())
        });
        if let Some(index) = matching_index {
            return records.get_mut(index);
        }
    }
    records.iter_mut().rev().find(matches_type)
}

fn update_tool_record(
    record: Option<&mut Value>,
    event: &Value,
    preview: Option<&str>,
    default_status: Option<&str>,
) {
    let Some(object) = record.and_then(Value::as_object_mut) else {
        return;
    };
    if let Some(status) =
        string_field(event, &["status"]).or_else(|| default_status.map(str::to_string))
    {
        object.insert("status".into(), json!(status));
    }
    object.insert(
        "error".into(),
        json!(event.get("error").and_then(Value::as_bool).unwrap_or(false)),
    );
    if let Some(duration) = event.get("duration").and_then(Value::as_f64) {
        object.insert("duration".into(), json!(duration));
    }
    if let Some(preview) = preview {
        object.insert(
            "preview".into(),
            json!(truncated_text(preview, MAX_RUNTIME_TOOL_PREVIEW_CHARS)),
        );
    }
}

fn truncated_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head_chars = max_chars.saturating_mul(3) / 4;
    let tail_chars = max_chars.saturating_sub(head_chars);
    let head = text.chars().take(head_chars).collect::<String>();
    let tail = text
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}\n… output truncated …\n{tail}")
}

fn truncate_middle(text: &mut String, max_chars: usize) {
    if text.chars().count() > max_chars {
        *text = truncated_text(text, max_chars);
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
    use mia_core_api_types::CreateConversationRequest;
    use mia_core_db::init_database_memory;
    use mia_core_runtime::{RuntimeBuilder, RuntimeProtocol, RuntimeTurnInput};
    use sqlx::Row;
    use tokio::time::timeout;

    use super::*;

    fn runtime_plan_for_protocol(protocol: RuntimeProtocol) -> RuntimeTurnPlan {
        let mut plan =
            RuntimeBuilder::new("/tmp/mia-workspace").build_turn_plan(RuntimeTurnInput {
                conversation_id: "conv_runtime_plan".into(),
                message_id: "msg_runtime_plan".into(),
                bot_id: Some("bot_runtime_plan".into()),
                memory_mode: mia_core_api_types::MemoryMode::Native,
                engine: Some("mock-agent".into()),
                previous_session_key: None,
                workspace_dir: String::new(),
                provider: json!({}),
                mcp_servers: json!({}),
                attachments: json!([]),
                selected_skill_ids: Vec::new(),
                body: "hello".into(),
            });
        plan.protocol = protocol;
        plan.command = None;
        plan.mock_response = (protocol == RuntimeProtocol::Mock).then(|| "mock reply".into());
        plan
    }

    #[test]
    fn runtime_plan_uses_session_manager_for_native_acp_without_command() {
        let native_acp = runtime_plan_for_protocol(RuntimeProtocol::NativeAcp);
        let mock = runtime_plan_for_protocol(RuntimeProtocol::Mock);

        assert!(runtime_plan_uses_session_manager(&native_acp));
        assert!(!runtime_plan_uses_session_manager(&mock));
    }

    #[tokio::test]
    async fn cloud_runtime_events_are_checkpointed_before_they_are_displayed() {
        let database = init_database_memory().await.unwrap();
        let conversation = ConversationService::new(database.pool().clone());
        let created = conversation
            .create_conversation(CreateConversationRequest {
                kind: "direct".into(),
                title: "Durable stream".into(),
                bot_id: None,
                metadata: json!({}),
            })
            .await
            .unwrap();
        let realtime = EventBus::default();
        let mut events = realtime.subscribe();
        let processor = CloudRuntimeEventProcessor::spawn(
            conversation,
            realtime,
            created.conversation.id.clone(),
            "turn_durable".into(),
            "codex".into(),
            "cloud:durable".into(),
            "run_durable".into(),
            "mia".into(),
        );

        processor
            .sender
            .send(RuntimeProcessEvent {
                name: EVENT_RUNTIME_STDOUT.into(),
                data: json!({
                    "event": {
                        "type": "message.delta",
                        "text": "先持久化，再显示"
                    }
                }),
            })
            .unwrap();

        let displayed = timeout(Duration::from_secs(2), events.recv())
            .await
            .expect("stream event")
            .expect("realtime event");
        assert_eq!(displayed.name, "cloud_agent_run_event");
        let persisted = sqlx::query(
            "SELECT body, status FROM messages \
             WHERE conversation_id = ? AND role = 'assistant'",
        )
        .bind(&created.conversation.id)
        .fetch_one(database.pool())
        .await
        .unwrap();
        assert_eq!(persisted.get::<String, _>("body"), "先持久化，再显示");
        assert_eq!(persisted.get::<String, _>("status"), "streaming");

        let state = processor.finish().await.unwrap();
        assert_eq!(state.structured_output.text, "先持久化，再显示");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_launcher_injects_mia_catalog_before_app_server_startup() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("temp dir");
        let fake_codex = root.path().join("fake-codex");
        std::fs::write(&fake_codex, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n")
            .expect("write fake codex");
        std::fs::set_permissions(&fake_codex, std::fs::Permissions::from_mode(0o700))
            .expect("make fake codex executable");
        let catalog = root.path().join("model catalog.json");
        std::fs::write(&catalog, "{\"models\":[]}").expect("write catalog");
        let registry = MiaRuntimeProxyRegistry::new(root.path());
        let launcher = registry
            .write_codex_launcher()
            .await
            .expect("write Codex launcher");

        let output = std::process::Command::new(launcher)
            .arg("app-server")
            .env("MIA_CODEX_REAL_PATH", &fake_codex)
            .env("MIA_CODEX_MODEL_CATALOG_JSON", &catalog)
            .output()
            .expect("run Codex launcher");
        let args = String::from_utf8_lossy(&output.stdout);

        assert!(output.status.success());
        assert!(args.lines().any(|line| line == "app-server"));
        assert!(args.lines().any(|line| line == "-c"));
        assert!(args.contains(&format!("model_catalog_json=\"{}\"", catalog.display())));
    }

    #[test]
    fn mia_managed_detection_accepts_builtin_mia_model_reference() {
        assert!(source_is_mia_managed(&json!({ "model": "mia-auto" })));
        assert!(source_is_mia_managed(&json!({ "model": "mia-default" })));
        assert!(source_is_mia_managed(&json!({ "platformProvider": "mia" })));
        assert!(source_is_mia_managed(
            &json!({ "platformModelProfileId": "mia:gpt-5.5" })
        ));
        assert!(source_is_mia_managed(
            &json!({ "platformModel": "mia-auto" })
        ));
        assert!(!source_is_mia_managed(&json!({ "model": "gpt-5.3" })));
    }

    #[test]
    fn platform_model_options_include_auto_fallback_and_mia_entries() {
        let options = platform_model_options(
            &json!({
                "modelEntries": [
                    { "provider": "codex", "model": "gpt-5.5" },
                    { "provider": "mia", "model": "gpt-5.4" },
                    { "authType": "mia_account", "value": "mia-default" }
                ]
            }),
            "gpt-5.5",
        );

        assert_eq!(options, vec!["gpt-5.5", "mia-auto", "gpt-5.4"]);
    }

    #[tokio::test]
    async fn hermes_mia_runtime_home_contains_provider_config() {
        let root = tempfile::tempdir().expect("temp dir");
        let registry = MiaRuntimeProxyRegistry::new(root.path());
        let access = MiaRuntimeProxyAccess {
            base_url: "http://127.0.0.1:4567/v1".into(),
            api_key: "proxy-key".into(),
        };

        let home = registry
            .write_hermes_mia_runtime_home(
                "hermes:conv",
                &access,
                "gpt-5.5",
                &json!({
                    "permissionMode": "yolo",
                    "effortLevel": "high"
                }),
            )
            .await
            .expect("write Hermes runtime home");
        let config_path = home.join("config.yaml");
        let config: Value =
            serde_json::from_str(&std::fs::read_to_string(config_path).unwrap()).unwrap();

        assert_eq!(config["model"]["provider"], "custom");
        assert_eq!(config["model"]["default"], "gpt-5.5");
        assert_eq!(config["model"]["base_url"], "http://127.0.0.1:4567/v1");
        assert_eq!(config["providers"]["custom"]["key_env"], "OPENAI_API_KEY");
        assert_eq!(config["providers"]["custom"]["default_model"], "gpt-5.5");
        assert_eq!(config["approvals"]["mode"], "off");
        assert_eq!(config["agent"]["reasoning_effort"], "high");
        assert!(home.join("skills").is_dir());
    }

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
    fn native_acp_structured_events_build_persistable_trace_and_ordered_blocks() {
        let mut collector = CloudRunCollector::default();
        collector.apply_run_event(&json!({
            "type": "reasoning_delta",
            "text": "检查内存"
        }));
        collector.apply_run_event(&json!({
            "type": "tool.started",
            "id": "tool_1",
            "name": "读取内存",
            "preview": "vm_stat"
        }));
        collector.apply_run_event(&json!({
            "type": "tool.completed",
            "id": "tool_1",
            "status": "completed",
            "preview": "Pages free: 4050"
        }));
        collector.apply_run_event(&json!({
            "type": "message.delta",
            "text": "内存正常。"
        }));

        let output = collector.display_output();

        assert_eq!(output.text, "内存正常。");
        assert_eq!(output.trace["reasoning"], "检查内存");
        assert_eq!(output.trace["tools"][0]["name"], "读取内存");
        assert_eq!(output.trace["tools"][0]["status"], "completed");
        assert_eq!(output.trace["tools"][0]["preview"], "Pages free: 4050");
        assert_eq!(output.content_blocks[0]["type"], "thinking");
        assert_eq!(output.content_blocks[1]["type"], "tool");
        assert_eq!(output.content_blocks[2]["type"], "text");
    }

    #[test]
    fn cloud_run_collector_bounds_large_tool_previews_for_checkpoints() {
        let oversized = "x".repeat(MAX_RUNTIME_TOOL_PREVIEW_CHARS * 4);
        let mut collector = CloudRunCollector::default();
        collector.apply_run_event(&json!({
            "type": "tool.started",
            "id": "tool_large",
            "name": "shell",
            "preview": oversized
        }));

        let output = collector.display_output();
        let trace_preview = output.trace["tools"][0]["preview"].as_str().unwrap();
        let block_preview = output.content_blocks[0]["preview"].as_str().unwrap();

        assert!(trace_preview.chars().count() <= MAX_RUNTIME_TOOL_PREVIEW_CHARS + 32);
        assert_eq!(trace_preview, block_preview);
        assert!(trace_preview.contains("output truncated"));
    }

    #[test]
    fn cloud_run_collector_bounds_large_reasoning_blocks_for_checkpoints() {
        let oversized = "x".repeat(MAX_RUNTIME_REASONING_CHARS * 4);
        let mut collector = CloudRunCollector::default();
        collector.apply_run_event(&json!({
            "type": "reasoning_delta",
            "text": oversized
        }));

        let output = collector.display_output();
        let trace_reasoning = output.trace["reasoning"].as_str().unwrap();
        let block_reasoning = output.content_blocks[0]["text"].as_str().unwrap();

        assert!(trace_reasoning.chars().count() <= MAX_RUNTIME_REASONING_CHARS + 32);
        assert!(block_reasoning.chars().count() <= MAX_RUNTIME_REASONING_CHARS + 32);
        assert!(trace_reasoning.contains("output truncated"));
        assert!(block_reasoning.contains("output truncated"));
    }

    #[test]
    fn native_acp_file_edits_survive_final_message_collection() {
        let mut collector = CloudRunCollector::default();
        collector.apply_run_event(&json!({
            "type": "file_edit",
            "id": "tool_edit_1:file_edit:0",
            "toolCallId": "tool_edit_1",
            "path": "src/app.js",
            "action": "update",
            "diff": "@@\n-old\n+draft",
            "additions": 1,
            "deletions": 1,
            "status": "running"
        }));
        collector.apply_run_event(&json!({
            "type": "file_edit",
            "id": "tool_edit_1:file_edit:0",
            "toolCallId": "tool_edit_1",
            "path": "src/app.js",
            "action": "update",
            "diff": "@@\n-old\n+final",
            "additions": 1,
            "deletions": 1,
            "status": "completed"
        }));

        let output = collector.display_output();
        let blocks = output.content_blocks.as_array().unwrap();

        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "file_edit");
        assert_eq!(blocks[0]["path"], "src/app.js");
        assert_eq!(blocks[0]["diff"], "@@\n-old\n+final");
        assert_eq!(blocks[0]["status"], "completed");
    }

    #[test]
    fn native_acp_runtime_output_prefers_collected_trace_over_plain_stdout() {
        let mut collector = CloudRunCollector::default();
        collector.apply_run_event(&json!({
            "type": "tool.started",
            "id": "tool_1",
            "name": "读取内存",
            "preview": "vm_stat"
        }));
        collector.apply_run_event(&json!({
            "type": "tool.completed",
            "id": "tool_1",
            "status": "completed"
        }));
        collector.apply_run_event(&json!({
            "type": "message.delta",
            "text": "内存正常。"
        }));

        let output = runtime_output_with_collected_events(
            "hermes",
            "内存正常。",
            "",
            collector.display_output(),
        );

        assert_eq!(output.text, "内存正常。");
        assert_eq!(output.trace["tools"][0]["name"], "读取内存");
        assert_eq!(output.content_blocks[0]["type"], "tool");
        assert_eq!(output.content_blocks[1]["type"], "text");
    }

    #[test]
    fn cron_continuation_replaces_collected_protocol_text_but_keeps_trace() {
        let mut collector = CloudRunCollector::default();
        collector.apply_run_event(&json!({
            "type": "tool.started",
            "id": "tool_1",
            "name": "读取上下文",
            "status": "running"
        }));
        collector.apply_run_event(&json!({
            "type": "tool.completed",
            "id": "tool_1",
            "name": "读取上下文",
            "status": "completed"
        }));
        collector.apply_run_event(&json!({
            "type": "message.delta",
            "text": "准备创建。 [CRON_CREATE]...[/CRON_CREATE]"
        }));
        let mut structured = collector.display_output();

        replace_collected_text(&mut structured, "已经设置好每天上午 9 点的日报提醒。");

        assert_eq!(structured.text, "已经设置好每天上午 9 点的日报提醒。");
        assert_eq!(structured.trace["tools"][0]["name"], "读取上下文");
        assert_eq!(structured.content_blocks[0]["type"], "tool");
        assert_eq!(structured.content_blocks[1]["type"], "text");
        assert_eq!(
            structured.content_blocks[1]["text"],
            "已经设置好每天上午 9 点的日报提醒。"
        );
        assert!(
            !structured
                .content_blocks
                .to_string()
                .contains("CRON_CREATE")
        );
    }

    #[test]
    fn tool_delta_without_status_keeps_the_tool_running() {
        let mut collector = CloudRunCollector::default();
        collector.apply_run_event(&json!({
            "type": "tool.started",
            "id": "tool_1",
            "name": "读取内存",
            "preview": "vm_stat"
        }));
        collector.apply_run_event(&json!({
            "type": "tool.delta",
            "id": "tool_1",
            "preview": "Pages free"
        }));

        assert_eq!(collector.trace()["tools"][0]["status"], "running");
        assert_eq!(collector.trace()["tools"][0]["preview"], "Pages free");
    }

    #[test]
    fn reasoning_deltas_preserve_agent_spacing_without_inserting_newlines() {
        let mut collector = CloudRunCollector::default();
        collector.apply_run_event(&json!({
            "type": "reasoning_delta",
            "text": "The"
        }));
        collector.apply_run_event(&json!({
            "type": "reasoning_delta",
            "text": " user"
        }));

        assert_eq!(collector.trace()["reasoning"], "The user");
        assert_eq!(collector.content_blocks()[0]["text"], "The user");
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

    #[test]
    fn process_duration_is_attached_to_structured_runtime_output() {
        let mut output = RuntimeDisplayOutput {
            text: "done".into(),
            trace: json!({}),
            content_blocks: json!([{ "type": "thinking", "text": "checking" }]),
        };

        attach_process_duration(&mut output, Duration::from_secs(212));

        assert_eq!(output.trace["duration"], 212.0);
    }

    #[test]
    fn process_duration_is_not_attached_to_plain_text_output() {
        let mut output = RuntimeDisplayOutput {
            text: "done".into(),
            trace: json!({}),
            content_blocks: json!([]),
        };

        attach_process_duration(&mut output, Duration::from_secs(212));

        assert_eq!(output.trace, json!({}));
    }
}
