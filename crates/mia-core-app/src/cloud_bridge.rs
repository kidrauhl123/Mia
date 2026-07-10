use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

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
    RuntimeProtocol, RuntimeSessionManager, RuntimeTurnPlan,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

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
    runtime_sessions: RuntimeSessionManager,
    mia_runtime_proxies: MiaRuntimeProxyRegistry,
}

impl AppCloudBridgeRunner {
    pub fn new(
        cloud: CloudService,
        conversation: ConversationService,
        realtime: EventBus,
        runtime: RuntimeRegistry,
        runtime_sessions: RuntimeSessionManager,
        mia_runtime_proxies: MiaRuntimeProxyRegistry,
    ) -> Self {
        Self {
            cloud,
            conversation,
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
    realtime: &EventBus,
    runtime: &RuntimeRegistry,
    runtime_sessions: &RuntimeSessionManager,
    mia_runtime_proxies: &MiaRuntimeProxyRegistry,
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
    let mut response_trace = json!({});
    let mut response_content_blocks = json!([]);
    let text = if runtime_plan_uses_session_manager(&runtime_plan) {
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
        let trace_collector = Arc::new(StdMutex::new(CloudRunCollector::default()));
        let trace_collector_for_sink = trace_collector.clone();
        let sink = RuntimeEventSink::new(move |event| {
            let name = event.name.clone();
            let data = event.data.clone();
            if name == EVENT_RUNTIME_STDOUT {
                let run_events = data
                    .get("event")
                    .filter(|event| event.is_object())
                    .cloned()
                    .map(|event| vec![event])
                    .unwrap_or_else(|| {
                        cloud_run_events_from_stdout(
                            &runtime_event_engine,
                            data.get("text").and_then(Value::as_str).unwrap_or(""),
                        )
                    });
                for run_event in run_events {
                    trace_collector_for_sink
                        .lock()
                        .unwrap()
                        .apply_run_event(&run_event);
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
        let execution = runtime_sessions
            .send_message(runtime_plan.clone(), sink, Some(cancellation))
            .await
            .map_err(|error| CloudError::Runtime(error.to_string()));
        runtime.remove(&cancellation_key);
        let result = match execution {
            Ok(result) => result,
            Err(error) => {
                runtime_claim.release();
                return Err(error);
            }
        };
        let structured_output = trace_collector.lock().unwrap().display_output();
        let output = runtime_output_with_collected_events(
            &runtime_plan.engine,
            &result.stdout,
            &result.stderr,
            structured_output,
        );
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

fn runtime_plan_uses_session_manager(plan: &RuntimeTurnPlan) -> bool {
    plan.command.is_some() || plan.protocol == RuntimeProtocol::NativeAcp
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
        let model = first_string(&plan.provider, &["model"])
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
                plan.environment
                    .insert("CUSTOM_BASE_URL".into(), access.base_url);
                plan.environment
                    .insert("OPENAI_API_KEY".into(), access.api_key);
            }
            _ => {}
        }
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
    for key in ["CUSTOM_BASE_URL", "OPENAI_API_KEY"] {
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
        if source_is_mia_managed(source) {
            return true;
        }
    }
    false
}

fn source_is_mia_managed(source: &Value) -> bool {
    first_string(source, &["providerConnectionId", "provider_connection_id"]).as_deref()
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
        || first_string(source, &["model"]).is_some_and(|value| is_builtin_mia_model(&value))
}

fn is_builtin_mia_model(model: &str) -> bool {
    matches!(model.trim(), "mia-auto" | "mia-default")
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
        object.insert("preview".into(), json!(preview));
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
    use mia_core_runtime::{RuntimeBuilder, RuntimeProtocol, RuntimeTurnInput};

    use super::*;

    fn runtime_plan_for_protocol(protocol: RuntimeProtocol) -> RuntimeTurnPlan {
        let mut plan =
            RuntimeBuilder::new("/tmp/mia-workspace").build_turn_plan(RuntimeTurnInput {
                conversation_id: "conv_runtime_plan".into(),
                message_id: "msg_runtime_plan".into(),
                bot_id: Some("bot_runtime_plan".into()),
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
        assert!(!source_is_mia_managed(&json!({ "model": "gpt-5.3" })));
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
