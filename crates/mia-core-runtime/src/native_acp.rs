use std::collections::BTreeMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_client_protocol::schema::{
    AgentCapabilities, CancelNotification, ContentBlock, EnvVariable, Implementation,
    InitializeRequest, McpServer, NewSessionRequest, NewSessionResponse, PermissionOption,
    PermissionOptionId, PermissionOptionKind, PromptRequest, ProtocolVersion,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    ResumeSessionRequest, SelectedPermissionOutcome, SessionConfigKind, SessionConfigOption,
    SessionConfigOptionCategory, SessionConfigSelectOption, SessionConfigSelectOptions, SessionId,
    SessionModeState, SessionModelState, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionModeRequest, SetSessionModelRequest, StopReason,
    TextContent,
};
use agent_client_protocol::{
    Agent, ByteStreams, Client, ConnectionTo, JsonRpcRequest, on_receive_notification,
    on_receive_request,
};
use anyhow::{Context, Result, anyhow, bail};
use async_trait::async_trait;
use dashmap::DashMap;
use mia_core_api_types::{
    AcpRuntimeControl, AcpRuntimeControlChoice, AcpRuntimeControlSnapshot,
    AgentPermissionListResponse, AgentPermissionPendingRequest, AgentPermissionRespondRequest,
    AgentPermissionRespondResponse, AgentPermissionRule,
};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, oneshot};
use tokio::task::JoinHandle;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use uuid::Uuid;

use crate::{
    EVENT_RUNTIME_FINISHED, EVENT_RUNTIME_STARTED, RuntimeCancellation, RuntimeCommand,
    RuntimeEventSink, RuntimeExecutionResult, RuntimeProcessEvent, RuntimeTurnPlan,
};

const ACP_INIT_TIMEOUT: Duration = Duration::from_secs(30);
const ACP_CLIENT_NAME: &str = "Mia";
const ACP_CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const ACP_STDERR_TAIL_LIMIT: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeAcpProbeErrorKind {
    Spawn,
    Initialize,
    NewSession,
    Prompt,
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeAcpProbeError {
    pub kind: NativeAcpProbeErrorKind,
    pub message: String,
    pub stderr: String,
}

pub async fn probe_native_acp_command(
    command: RuntimeCommand,
    environment: BTreeMap<String, String>,
    workspace_dir: PathBuf,
    timeout: Duration,
) -> std::result::Result<(), NativeAcpProbeError> {
    match tokio::time::timeout(
        timeout,
        probe_native_acp_command_inner(command, environment, workspace_dir),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(NativeAcpProbeError {
            kind: NativeAcpProbeErrorKind::Timeout,
            message: "ACP probe timed out".into(),
            stderr: String::new(),
        }),
    }
}

pub(crate) fn runtime_events_from_session_notification(
    turn_id: &str,
    conversation_id: &str,
    engine: &str,
    notification: &SessionNotification,
) -> Vec<RuntimeProcessEvent> {
    let session_id = notification.session_id.to_string();
    match &notification.update {
        SessionUpdate::AgentMessageChunk(chunk) => text_from_content_block(&chunk.content)
            .map(|text| {
                runtime_stdout_event(
                    turn_id,
                    conversation_id,
                    engine,
                    text,
                    json!({
                        "type": "message.delta",
                        "text": text,
                        "sessionId": session_id,
                    }),
                )
            })
            .into_iter()
            .collect(),
        SessionUpdate::AgentThoughtChunk(chunk) => text_from_content_block(&chunk.content)
            .map(|text| {
                runtime_stdout_event(
                    turn_id,
                    conversation_id,
                    engine,
                    text,
                    json!({
                        "type": "thinking.delta",
                        "text": text,
                        "sessionId": session_id,
                    }),
                )
            })
            .into_iter()
            .collect(),
        SessionUpdate::ToolCall(tool_call) => vec![runtime_stdout_event(
            turn_id,
            conversation_id,
            engine,
            "",
            json!({
                "type": "tool_call.started",
                "sessionId": session_id,
                "toolCall": tool_call,
            }),
        )],
        SessionUpdate::ToolCallUpdate(tool_call_update) => vec![runtime_stdout_event(
            turn_id,
            conversation_id,
            engine,
            "",
            json!({
                "type": "tool_call.updated",
                "sessionId": session_id,
                "toolCall": tool_call_update,
            }),
        )],
        SessionUpdate::Plan(plan) => vec![runtime_stdout_event(
            turn_id,
            conversation_id,
            engine,
            "",
            json!({
                "type": "plan.updated",
                "sessionId": session_id,
                "plan": plan,
            }),
        )],
        SessionUpdate::AvailableCommandsUpdate(update) => vec![runtime_stdout_event(
            turn_id,
            conversation_id,
            engine,
            "",
            json!({
                "type": "commands.updated",
                "sessionId": session_id,
                "commands": update.available_commands,
            }),
        )],
        SessionUpdate::CurrentModeUpdate(update) => vec![runtime_stdout_event(
            turn_id,
            conversation_id,
            engine,
            "",
            json!({
                "type": "mode.updated",
                "sessionId": session_id,
                "mode": update,
            }),
        )],
        SessionUpdate::ConfigOptionUpdate(update) => vec![runtime_stdout_event(
            turn_id,
            conversation_id,
            engine,
            "",
            json!({
                "type": "config_option.updated",
                "sessionId": session_id,
                "configOption": update,
            }),
        )],
        SessionUpdate::SessionInfoUpdate(update) => vec![runtime_stdout_event(
            turn_id,
            conversation_id,
            engine,
            "",
            json!({
                "type": "session_info.updated",
                "sessionId": session_id,
                "sessionInfo": update,
            }),
        )],
        SessionUpdate::UsageUpdate(update) => vec![runtime_stdout_event(
            turn_id,
            conversation_id,
            engine,
            "",
            json!({
                "type": "usage.updated",
                "sessionId": session_id,
                "usage": update,
            }),
        )],
        _ => Vec::new(),
    }
}

fn text_from_content_block(block: &ContentBlock) -> Option<&str> {
    match block {
        ContentBlock::Text(text) => Some(text.text.as_str()),
        _ => None,
    }
}

fn runtime_stdout_event(
    turn_id: &str,
    conversation_id: &str,
    engine: &str,
    text: &str,
    event: Value,
) -> RuntimeProcessEvent {
    RuntimeProcessEvent {
        name: crate::EVENT_RUNTIME_STDOUT.to_string(),
        data: json!({
            "turnId": turn_id,
            "conversationId": conversation_id,
            "engine": engine,
            "text": text,
            "event": event,
        }),
    }
}

#[async_trait]
pub trait NativeAcpBackend: Send + Sync {
    async fn send_message(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult>;

    async fn prepare_session(&self, _plan: RuntimeTurnPlan) -> Result<AcpRuntimeControlSnapshot> {
        bail!("native ACP runtime does not expose session controls")
    }

    async fn set_control(
        &self,
        _plan: RuntimeTurnPlan,
        _control_id: String,
        _value: String,
    ) -> Result<AcpRuntimeControlSnapshot> {
        bail!("native ACP runtime does not expose session controls")
    }

    fn list_pending_permissions(&self, _session_id: Option<&str>) -> AgentPermissionListResponse {
        AgentPermissionListResponse {
            requests: Vec::new(),
        }
    }

    fn respond_permission(
        &self,
        _request: AgentPermissionRespondRequest,
    ) -> AgentPermissionRespondResponse {
        AgentPermissionRespondResponse {
            ok: false,
            error: Some("permission request not found".into()),
        }
    }
}

#[derive(Clone)]
pub struct NativeAcpSessionManager {
    backend: Arc<dyn NativeAcpBackend>,
}

impl std::fmt::Debug for NativeAcpSessionManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeAcpSessionManager")
            .finish_non_exhaustive()
    }
}

impl NativeAcpSessionManager {
    pub fn real() -> Self {
        Self {
            backend: Arc::new(RealNativeAcpBackend::default()),
        }
    }

    pub fn unavailable() -> Self {
        Self {
            backend: Arc::new(UnavailableNativeAcpBackend),
        }
    }

    pub fn with_backend_for_tests(backend: Arc<dyn NativeAcpBackend>) -> Self {
        Self { backend }
    }

    pub async fn send_message(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult> {
        self.backend.send_message(plan, sink, cancellation).await
    }

    pub async fn prepare_session(
        &self,
        plan: RuntimeTurnPlan,
    ) -> Result<AcpRuntimeControlSnapshot> {
        self.backend.prepare_session(plan).await
    }

    pub async fn set_control(
        &self,
        plan: RuntimeTurnPlan,
        control_id: String,
        value: String,
    ) -> Result<AcpRuntimeControlSnapshot> {
        self.backend.set_control(plan, control_id, value).await
    }

    pub fn list_pending_permissions(
        &self,
        session_id: Option<&str>,
    ) -> AgentPermissionListResponse {
        self.backend.list_pending_permissions(session_id)
    }

    pub fn respond_permission(
        &self,
        request: AgentPermissionRespondRequest,
    ) -> AgentPermissionRespondResponse {
        self.backend.respond_permission(request)
    }
}

#[derive(Debug, Default)]
pub struct RealNativeAcpBackend {
    tasks: DashMap<String, Arc<Mutex<NativeAcpTask>>>,
    permissions: NativeAcpPermissionBroker,
}

#[async_trait]
impl NativeAcpBackend for RealNativeAcpBackend {
    async fn send_message(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult> {
        sink.emit(
            EVENT_RUNTIME_STARTED,
            json!({
                "turnId": plan.turn_id,
                "conversationId": plan.conversation_id,
                "engine": plan.engine,
                "protocol": "nativeAcp",
            }),
        );

        match self
            .send_message_inner(plan.clone(), sink.clone(), cancellation)
            .await
        {
            Ok(result) => Ok(result),
            Err(error) => {
                sink.emit(
                    EVENT_RUNTIME_FINISHED,
                    json!({
                        "turnId": plan.turn_id,
                        "conversationId": plan.conversation_id,
                        "engine": plan.engine,
                        "exitCode": null,
                        "cancelled": false,
                        "ok": false,
                        "error": error.to_string(),
                    }),
                );
                Err(error)
            }
        }
    }

    async fn prepare_session(&self, plan: RuntimeTurnPlan) -> Result<AcpRuntimeControlSnapshot> {
        let key = native_acp_task_key(&plan);
        let task = self.task_for_plan(&key, &plan).await?;
        let mut task = task.lock().await;
        task.ensure_session(&plan).await?;
        task.reconcile_plan_controls(&plan).await?;
        Ok(task.control_snapshot(&plan))
    }

    async fn set_control(
        &self,
        plan: RuntimeTurnPlan,
        control_id: String,
        value: String,
    ) -> Result<AcpRuntimeControlSnapshot> {
        let key = native_acp_task_key(&plan);
        let task = self.task_for_plan(&key, &plan).await?;
        let mut task = task.lock().await;
        task.ensure_session(&plan).await?;
        task.set_control(&plan, &control_id, &value).await
    }

    fn list_pending_permissions(&self, session_id: Option<&str>) -> AgentPermissionListResponse {
        self.permissions.list_pending(session_id)
    }

    fn respond_permission(
        &self,
        request: AgentPermissionRespondRequest,
    ) -> AgentPermissionRespondResponse {
        self.permissions.respond(request)
    }
}

impl RealNativeAcpBackend {
    async fn send_message_inner(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult> {
        let key = native_acp_task_key(&plan);
        let task = self.task_for_plan(&key, &plan).await?;
        let mut task = task.lock().await;
        if !task.protocol.is_connected() {
            drop(task);
            self.tasks.remove(&key);
            let task = self.task_for_plan(&key, &plan).await?;
            task.lock().await.run_turn(plan, sink, cancellation).await
        } else {
            task.run_turn(plan, sink, cancellation).await
        }
    }

    async fn task_for_plan(
        &self,
        key: &str,
        plan: &RuntimeTurnPlan,
    ) -> Result<Arc<Mutex<NativeAcpTask>>> {
        if let Some(task) = self.tasks.get(key) {
            return Ok(task.value().clone());
        }

        let logical_key = native_acp_logical_task_key(plan);
        let stale_keys = self
            .tasks
            .iter()
            .filter(|entry| entry.key().starts_with(&format!("{logical_key}:")))
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>();
        for stale_key in stale_keys {
            self.tasks.remove(&stale_key);
        }

        let task = Arc::new(Mutex::new(
            NativeAcpTask::spawn(plan, self.permissions.clone()).await?,
        ));
        let entry = self.tasks.entry(key.to_string()).or_insert(task);
        Ok(entry.clone())
    }
}

fn native_acp_task_key(plan: &RuntimeTurnPlan) -> String {
    let logical_key = native_acp_logical_task_key(plan);
    let mut hasher = DefaultHasher::new();
    if let Some(command) = &plan.command {
        command.program.hash(&mut hasher);
        command.args.hash(&mut hasher);
    }
    plan.environment.hash(&mut hasher);
    format!("{logical_key}:{:016x}", hasher.finish())
}

fn native_acp_logical_task_key(plan: &RuntimeTurnPlan) -> String {
    format!(
        "{}:{}:{}",
        plan.engine,
        plan.conversation_id,
        absolute_workspace_dir_lossy(&plan.workspace_dir)
    )
}

fn desired_control_value<'a>(plan: &'a RuntimeTurnPlan, category: &str) -> Option<&'a str> {
    let keys: &[&str] = match category {
        "model" => &["model"],
        "thought_level" => &["effortLevel", "effort_level", "reasoningEffort"],
        "permission" => &["permissionMode", "permission_mode"],
        _ => &[],
    };
    keys.iter()
        .find_map(|key| plan.provider.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn absolute_workspace_dir_lossy(workspace_dir: &str) -> String {
    absolute_workspace_dir(workspace_dir)
        .unwrap_or_else(|_| PathBuf::from(workspace_dir))
        .to_string_lossy()
        .to_string()
}

fn absolute_workspace_dir(workspace_dir: &str) -> Result<PathBuf> {
    let trimmed = workspace_dir.trim();
    if trimmed.is_empty() {
        return std::env::current_dir().context("resolve current workspace directory");
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()
            .context("resolve current workspace directory")?
            .join(path))
    }
}

fn resumable_session_id(plan: &RuntimeTurnPlan) -> Option<SessionId> {
    plan.runtime_session
        .resume_session_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| SessionId::new(value.to_string()))
}

fn capabilities_support_session_resume(capabilities: &AgentCapabilities) -> bool {
    capabilities.session_capabilities.resume.is_some()
}

fn is_stale_session_error(error: &anyhow::Error) -> bool {
    let text = error.to_string().to_lowercase();
    text.contains("session") && (text.contains("not found") || text.contains("not_found"))
}

fn mcp_servers_from_plan(plan: &RuntimeTurnPlan) -> Vec<McpServer> {
    let Some(servers) = plan
        .mcp_servers
        .get("mcpServers")
        .or_else(|| plan.mcp_servers.get("mcp_servers"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    servers
        .iter()
        .filter_map(|(name, server)| normalize_mcp_server(name, server))
        .collect()
}

fn normalize_mcp_server(name: &str, server: &Value) -> Option<McpServer> {
    let mut value = server.clone();
    let object = value.as_object_mut()?;
    object
        .entry("name".to_string())
        .or_insert_with(|| Value::String(name.to_string()));
    if let Some(env) = object.get("env").cloned() {
        object.insert("env".to_string(), normalize_mcp_env(env));
    }
    serde_json::from_value(value).ok()
}

fn normalize_mcp_env(value: Value) -> Value {
    match value {
        Value::Object(env) => Value::Array(
            env.into_iter()
                .filter_map(|(name, value)| {
                    let value = match value {
                        Value::String(text) => text,
                        Value::Null => return None,
                        other => other.to_string(),
                    };
                    Some(json!(EnvVariable::new(name, value)))
                })
                .collect(),
        ),
        Value::Array(_) => value,
        _ => Value::Array(Vec::new()),
    }
}

async fn probe_native_acp_command_inner(
    command: RuntimeCommand,
    environment: BTreeMap<String, String>,
    workspace_dir: PathBuf,
) -> std::result::Result<(), NativeAcpProbeError> {
    let workspace_dir =
        absolute_workspace_dir(&workspace_dir.to_string_lossy()).map_err(|error| {
            NativeAcpProbeError {
                kind: NativeAcpProbeErrorKind::Spawn,
                message: error.to_string(),
                stderr: String::new(),
            }
        })?;
    tokio::fs::create_dir_all(&workspace_dir)
        .await
        .map_err(|error| NativeAcpProbeError {
            kind: NativeAcpProbeErrorKind::Spawn,
            message: format!(
                "create ACP probe workspace {}: {error}",
                workspace_dir.display()
            ),
            stderr: String::new(),
        })?;

    let mut child_command = Command::new(&command.program);
    child_command
        .args(&command.args)
        .env_clear()
        .envs(environment.iter())
        .current_dir(&workspace_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = child_command.spawn().map_err(|error| NativeAcpProbeError {
        kind: NativeAcpProbeErrorKind::Spawn,
        message: format!(
            "spawn ACP agent command `{}` with args {:?}: {error}",
            command.program, command.args
        ),
        stderr: String::new(),
    })?;
    let stderr_task = tokio::spawn(read_limited_stream(child.stderr.take(), 16 * 1024));
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            let stderr = finish_probe_child(child, stderr_task).await;
            return Err(NativeAcpProbeError {
                kind: NativeAcpProbeErrorKind::Spawn,
                message: "ACP agent stdin was not piped".into(),
                stderr,
            });
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let stderr = finish_probe_child(child, stderr_task).await;
            return Err(NativeAcpProbeError {
                kind: NativeAcpProbeErrorKind::Spawn,
                message: "ACP agent stdout was not piped".into(),
                stderr,
            });
        }
    };

    let result: std::result::Result<(), (NativeAcpProbeErrorKind, String)> = async {
        let protocol = AcpProtocol::connect(
            stdin,
            stdout,
            Arc::new(StdMutex::new(NativeAcpSessionState::default())),
            NativeAcpPermissionBroker::default(),
        )
        .await
        .map_err(|error| (NativeAcpProbeErrorKind::Initialize, error.to_string()))?;
        let session = protocol
            .new_session(workspace_dir, Vec::new())
            .await
            .map_err(|error| (NativeAcpProbeErrorKind::NewSession, error.to_string()))?;
        let accumulated_text = Arc::new(StdMutex::new(String::new()));
        protocol.set_active_turn(Some(ActiveTurnContext {
            turn_id: "probe".into(),
            conversation_id: "probe".into(),
            engine: "probe".into(),
            bot_id: "probe".into(),
            permission_mode: "".into(),
            sink: RuntimeEventSink::default(),
            accumulated_text: accumulated_text.clone(),
        }));
        let prompt_result = protocol
            .prompt(session.session_id, "Reply with OK.".into())
            .await;
        protocol.set_active_turn(None);
        let prompt_response =
            prompt_result.map_err(|error| (NativeAcpProbeErrorKind::Prompt, error.to_string()))?;
        validate_probe_prompt_output(
            &accumulated_text.lock().unwrap(),
            prompt_response.stop_reason,
        )
        .map_err(|message| (NativeAcpProbeErrorKind::Prompt, message))?;
        Ok(())
    }
    .await;
    let stderr = finish_probe_child(child, stderr_task).await;
    result.map_err(|(kind, message)| NativeAcpProbeError {
        kind,
        message,
        stderr,
    })
}

async fn finish_probe_child(mut child: Child, stderr_task: JoinHandle<String>) -> String {
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    tokio::time::timeout(Duration::from_millis(500), stderr_task)
        .await
        .ok()
        .and_then(|result| result.ok())
        .unwrap_or_default()
}

async fn read_limited_stream<R>(stream: Option<R>, limit: u64) -> String
where
    R: AsyncRead + Unpin,
{
    let Some(stream) = stream else {
        return String::new();
    };
    let mut stream = stream.take(limit);
    let mut bytes = Vec::new();
    let _ = stream.read_to_end(&mut bytes).await;
    String::from_utf8_lossy(&bytes).to_string()
}

#[derive(Debug, Clone, Default)]
struct NativeAcpSessionState {
    session_id: Option<SessionId>,
    models: Option<SessionModelState>,
    modes: Option<SessionModeState>,
    config_options: Option<Vec<SessionConfigOption>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AcpControlSetPath {
    ConfigOption { config_id: String },
    LegacyModel,
    LegacyMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
enum AcpControlSetError {
    #[error("ACP control was not advertised by the active session")]
    ControlNotAdvertised,
    #[error("ACP control value was not advertised by the active session")]
    ValueNotAdvertised,
}

impl NativeAcpSessionState {
    fn apply_new_session_response(&mut self, response: NewSessionResponse) {
        self.session_id = Some(response.session_id);
        self.models = response.models;
        self.modes = response.modes;
        self.config_options = response.config_options;
    }

    fn apply_session_notification(&mut self, notification: &SessionNotification) {
        if self
            .session_id
            .as_ref()
            .is_some_and(|session_id| session_id != &notification.session_id)
        {
            return;
        }
        match &notification.update {
            SessionUpdate::ConfigOptionUpdate(update) => {
                self.config_options = Some(update.config_options.clone());
            }
            SessionUpdate::CurrentModeUpdate(update) => {
                if let Some(modes) = self.modes.as_mut() {
                    modes.current_mode_id = update.current_mode_id.clone();
                }
                if let Some(options) = self.config_options.as_mut() {
                    for option in options {
                        if control_category(option) != Some("permission") {
                            continue;
                        }
                        if let SessionConfigKind::Select(select) = &mut option.kind {
                            select.current_value = update.current_mode_id.to_string().into();
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn control_snapshot(&self, conversation_id: &str, engine: &str) -> AcpRuntimeControlSnapshot {
        let mut controls = self
            .config_options
            .as_deref()
            .into_iter()
            .flatten()
            .filter_map(control_from_config_option)
            .collect::<Vec<_>>();

        if !controls.iter().any(|control| control.category == "model")
            && let Some(models) = self.models.as_ref()
        {
            controls.push(control_from_legacy_models(models));
        }
        if !controls
            .iter()
            .any(|control| control.category == "permission")
            && let Some(modes) = self.modes.as_ref()
        {
            controls.push(control_from_legacy_modes(modes));
        }

        AcpRuntimeControlSnapshot {
            conversation_id: conversation_id.to_string(),
            engine: engine.to_string(),
            session_id: self.session_id.as_ref().map(ToString::to_string),
            state: if self.session_id.is_some() {
                "ready".to_string()
            } else {
                "starting".to_string()
            },
            controls,
            error: String::new(),
        }
    }

    fn resolve_control_set(
        &self,
        control_id: &str,
        value: &str,
    ) -> std::result::Result<AcpControlSetPath, AcpControlSetError> {
        let snapshot = self.control_snapshot("", "");
        let control = snapshot
            .controls
            .iter()
            .find(|control| control.id == control_id)
            .ok_or(AcpControlSetError::ControlNotAdvertised)?;
        if !control.options.iter().any(|choice| choice.value == value) {
            return Err(AcpControlSetError::ValueNotAdvertised);
        }
        match control.source.as_str() {
            "config_option" => Ok(AcpControlSetPath::ConfigOption {
                config_id: control.id.clone(),
            }),
            "legacy_model" => Ok(AcpControlSetPath::LegacyModel),
            "legacy_mode" => Ok(AcpControlSetPath::LegacyMode),
            _ => Err(AcpControlSetError::ControlNotAdvertised),
        }
    }

    fn apply_legacy_model(&mut self, value: &str) {
        if let Some(models) = self.models.as_mut() {
            models.current_model_id = value.to_string().into();
        }
    }

    fn apply_legacy_mode(&mut self, value: &str) {
        if let Some(modes) = self.modes.as_mut() {
            modes.current_mode_id = value.to_string().into();
        }
    }
}

fn control_from_config_option(option: &SessionConfigOption) -> Option<AcpRuntimeControl> {
    let category = control_category(option)?;
    let SessionConfigKind::Select(select) = &option.kind else {
        return None;
    };
    let options = flatten_config_select_options(&select.options)
        .into_iter()
        .map(|choice| AcpRuntimeControlChoice {
            value: choice.value.to_string(),
            label: choice.name.clone(),
            description: choice.description.clone().unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    if options.is_empty() {
        return None;
    }
    let current_value = select.current_value.to_string();
    if current_value.is_empty() || !options.iter().any(|choice| choice.value == current_value) {
        return None;
    }
    Some(AcpRuntimeControl {
        id: option.id.to_string(),
        category: category.to_string(),
        current_value,
        source: "config_option".to_string(),
        options,
    })
}

fn control_category(option: &SessionConfigOption) -> Option<&'static str> {
    match option.category.as_ref() {
        Some(SessionConfigOptionCategory::Model) => Some("model"),
        Some(SessionConfigOptionCategory::ThoughtLevel) => Some("thought_level"),
        Some(SessionConfigOptionCategory::Mode) => Some("permission"),
        Some(SessionConfigOptionCategory::Other(_)) => None,
        _ => match option.id.to_string().trim().to_ascii_lowercase().as_str() {
            "model" => Some("model"),
            "effort" | "thought_level" | "reasoning_effort" => Some("thought_level"),
            "mode" | "permission" | "permission_mode" => Some("permission"),
            _ => None,
        },
    }
}

fn flatten_config_select_options(
    options: &SessionConfigSelectOptions,
) -> Vec<&SessionConfigSelectOption> {
    match options {
        SessionConfigSelectOptions::Ungrouped(options) => options.iter().collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| group.options.iter())
            .collect(),
        _ => Vec::new(),
    }
}

fn control_from_legacy_models(models: &SessionModelState) -> AcpRuntimeControl {
    AcpRuntimeControl {
        id: "model".to_string(),
        category: "model".to_string(),
        current_value: models.current_model_id.to_string(),
        source: "legacy_model".to_string(),
        options: models
            .available_models
            .iter()
            .map(|model| AcpRuntimeControlChoice {
                value: model.model_id.to_string(),
                label: model.name.clone(),
                description: model.description.clone().unwrap_or_default(),
            })
            .collect(),
    }
}

fn control_from_legacy_modes(modes: &SessionModeState) -> AcpRuntimeControl {
    AcpRuntimeControl {
        id: "mode".to_string(),
        category: "permission".to_string(),
        current_value: modes.current_mode_id.to_string(),
        source: "legacy_mode".to_string(),
        options: modes
            .available_modes
            .iter()
            .map(|mode| AcpRuntimeControlChoice {
                value: mode.id.to_string(),
                label: mode.name.clone(),
                description: mode.description.clone().unwrap_or_default(),
            })
            .collect(),
    }
}

#[derive(Debug)]
struct NativeAcpTask {
    protocol: AcpProtocol,
    _child: Child,
    stderr_tail: Arc<StdMutex<String>>,
    _stderr_task: JoinHandle<()>,
    session_state: SharedSessionState,
    workspace_dir: PathBuf,
    platform_model_applied: Option<String>,
}

type SharedSessionState = Arc<StdMutex<NativeAcpSessionState>>;

impl NativeAcpTask {
    async fn spawn(
        plan: &RuntimeTurnPlan,
        permission_broker: NativeAcpPermissionBroker,
    ) -> Result<Self> {
        let command = plan
            .command
            .clone()
            .ok_or_else(|| anyhow!("native ACP runtime requires an ACP command"))?;
        let workspace_dir = absolute_workspace_dir(&plan.workspace_dir)?;
        tokio::fs::create_dir_all(&workspace_dir)
            .await
            .with_context(|| format!("create ACP workspace {}", workspace_dir.display()))?;

        let mut child_command = Command::new(&command.program);
        child_command
            .args(&command.args)
            .env_clear()
            .envs(plan.environment.iter())
            .current_dir(&workspace_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = child_command.spawn().with_context(|| {
            format!(
                "spawn ACP agent command `{}` with args {:?}",
                command.program, command.args
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("ACP agent stdin was not piped"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("ACP agent stdout was not piped"))?;
        let stderr_tail = Arc::new(StdMutex::new(String::new()));
        let stderr_task = tokio::spawn(read_stderr_tail(child.stderr.take(), stderr_tail.clone()));
        let session_state = Arc::new(StdMutex::new(NativeAcpSessionState::default()));
        let protocol =
            AcpProtocol::connect(stdin, stdout, session_state.clone(), permission_broker).await?;

        Ok(Self {
            protocol,
            _child: child,
            stderr_tail,
            _stderr_task: stderr_task,
            session_state,
            workspace_dir,
            platform_model_applied: None,
        })
    }

    async fn run_turn(
        &mut self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult> {
        let session_id = self.ensure_session(&plan).await?;
        self.reconcile_plan_controls(&plan).await?;
        let session_key = session_id.to_string();
        let accumulated_text = Arc::new(StdMutex::new(String::new()));
        self.protocol.set_active_turn(Some(ActiveTurnContext {
            turn_id: plan.turn_id.clone(),
            conversation_id: plan.conversation_id.clone(),
            engine: plan.engine.clone(),
            bot_id: plan.bot_id.clone().unwrap_or_default(),
            permission_mode: desired_control_value(&plan, "permission")
                .unwrap_or_default()
                .to_string(),
            sink: sink.clone(),
            accumulated_text: accumulated_text.clone(),
        }));

        let prompt = self
            .protocol
            .prompt(session_id.clone(), plan.send_message.content.clone());
        tokio::pin!(prompt);

        let mut cancelled = false;
        let prompt_result = if let Some(cancellation) = cancellation {
            tokio::select! {
                result = &mut prompt => Some(result),
                _ = cancellation.cancelled() => {
                    cancelled = true;
                    self.protocol.cancel(session_id.clone());
                    None
                }
            }
        } else {
            Some(prompt.await)
        };

        self.protocol.set_active_turn(None);
        let stdout = accumulated_text.lock().unwrap().clone();

        if cancelled {
            let result = RuntimeExecutionResult {
                exit_code: None,
                cancelled: true,
                stdout,
                stderr: String::new(),
            };
            sink.emit(
                EVENT_RUNTIME_FINISHED,
                json!({
                    "turnId": plan.turn_id,
                    "conversationId": plan.conversation_id,
                    "engine": plan.engine,
                    "exitCode": null,
                    "cancelled": true,
                    "ok": false,
                    "sessionId": session_key,
                }),
            );
            return Ok(result);
        }

        let prompt_response = match prompt_result.expect("cancelled prompt returned earlier") {
            Ok(response) => response,
            Err(error) => {
                sink.emit(
                    EVENT_RUNTIME_FINISHED,
                    json!({
                        "turnId": plan.turn_id,
                        "conversationId": plan.conversation_id,
                        "engine": plan.engine,
                        "exitCode": null,
                        "cancelled": false,
                        "ok": false,
                        "sessionId": session_key,
                        "error": error.to_string(),
                    }),
                );
                return Err(error);
            }
        };
        tracing::debug!(
            stop_reason = ?prompt_response.stop_reason,
            "ACP session/prompt completed"
        );

        if stdout.trim().is_empty() {
            let error = empty_native_acp_output_error(
                &plan.engine,
                prompt_response.stop_reason,
                &stderr_tail_snapshot(&self.stderr_tail),
            );
            sink.emit(
                EVENT_RUNTIME_FINISHED,
                json!({
                    "turnId": plan.turn_id,
                    "conversationId": plan.conversation_id,
                    "engine": plan.engine,
                    "exitCode": null,
                    "cancelled": false,
                    "ok": false,
                    "sessionId": session_key,
                    "error": error,
                }),
            );
            return Err(anyhow!(error));
        }

        let result = RuntimeExecutionResult {
            exit_code: Some(0),
            cancelled: false,
            stdout,
            stderr: String::new(),
        };
        sink.emit(
            EVENT_RUNTIME_FINISHED,
            json!({
                "turnId": plan.turn_id,
                "conversationId": plan.conversation_id,
                "engine": plan.engine,
                "exitCode": 0,
                "cancelled": false,
                "ok": true,
                "sessionId": session_key,
            }),
        );
        Ok(result)
    }

    async fn ensure_session(&mut self, plan: &RuntimeTurnPlan) -> Result<SessionId> {
        if let Some(session_id) = self.session_state.lock().unwrap().session_id.clone() {
            return Ok(session_id);
        }
        let mcp_servers = mcp_servers_from_plan(plan);
        if let Some(session_id) = resumable_session_id(plan)
            && self.protocol.supports_session_resume()
        {
            match self
                .protocol
                .resume_session(
                    session_id.clone(),
                    self.workspace_dir.clone(),
                    mcp_servers.clone(),
                )
                .await
            {
                Ok(response) => {
                    let mut state = self.session_state.lock().unwrap();
                    state.session_id = Some(session_id.clone());
                    state.models = response.models;
                    state.modes = response.modes;
                    state.config_options = response.config_options;
                    return Ok(session_id);
                }
                Err(error) if is_stale_session_error(&error) => {
                    tracing::debug!(?error, "ACP resume session failed; opening a new session");
                }
                Err(error) => return Err(error),
            }
        }
        let response = self
            .protocol
            .new_session(self.workspace_dir.clone(), mcp_servers)
            .await?;
        let session_id = response.session_id.clone();
        self.session_state
            .lock()
            .unwrap()
            .apply_new_session_response(response);
        Ok(session_id)
    }

    fn control_snapshot(&self, plan: &RuntimeTurnPlan) -> AcpRuntimeControlSnapshot {
        let mut snapshot = self
            .session_state
            .lock()
            .unwrap()
            .control_snapshot(&plan.conversation_id, &plan.engine);
        if let Some(model) = platform_model_from_plan(plan) {
            snapshot
                .controls
                .retain(|control| control.category != "model");
            snapshot.controls.insert(
                0,
                AcpRuntimeControl {
                    id: "model".into(),
                    category: "model".into(),
                    current_value: model.to_string(),
                    source: "mia_provider".into(),
                    options: vec![AcpRuntimeControlChoice {
                        value: model.to_string(),
                        label: if matches!(model, "mia-auto" | "mia-default") {
                            "Auto".into()
                        } else {
                            model.to_string()
                        },
                        description: "Mia platform model".into(),
                    }],
                },
            );
        }
        if plan.engine == "codex"
            && let Some(current_effort) = plan
                .environment
                .get("MIA_PLATFORM_REASONING_EFFORT")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            && let Some(raw_efforts) = plan.environment.get("MIA_PLATFORM_REASONING_EFFORTS")
        {
            let options = raw_efforts
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| AcpRuntimeControlChoice {
                    value: value.to_string(),
                    label: match value {
                        "none" => "None".into(),
                        "low" => "Low".into(),
                        "medium" => "Medium".into(),
                        "high" => "High".into(),
                        other => other.to_string(),
                    },
                    description: String::new(),
                })
                .collect::<Vec<_>>();
            if options.iter().any(|choice| choice.value == current_effort) {
                snapshot
                    .controls
                    .retain(|control| control.category != "thought_level");
                let index = usize::from(!snapshot.controls.is_empty());
                snapshot.controls.insert(
                    index,
                    AcpRuntimeControl {
                        id: "reasoning_effort".into(),
                        category: "thought_level".into(),
                        current_value: current_effort.to_string(),
                        source: "mia_provider".into(),
                        options,
                    },
                );
            }
        }
        snapshot
    }

    async fn reconcile_plan_controls(&mut self, plan: &RuntimeTurnPlan) -> Result<()> {
        self.ensure_platform_model(plan).await?;
        for category in ["model", "thought_level", "permission"] {
            let Some(desired) = desired_control_value(plan, category) else {
                continue;
            };
            let snapshot = self.control_snapshot(plan);
            let Some(control) = snapshot
                .controls
                .iter()
                .find(|control| control.category == category)
            else {
                continue;
            };
            if control.current_value == desired {
                continue;
            }
            if !control.options.iter().any(|choice| choice.value == desired) {
                tracing::warn!(
                    engine = %plan.engine,
                    conversation_id = %plan.conversation_id,
                    category,
                    desired,
                    "ignoring stale ACP control selection not advertised by the active session"
                );
                continue;
            }
            self.set_control(plan, &control.id, desired).await?;
        }
        Ok(())
    }

    async fn set_control(
        &mut self,
        plan: &RuntimeTurnPlan,
        control_id: &str,
        value: &str,
    ) -> Result<AcpRuntimeControlSnapshot> {
        if control_id == "model"
            && platform_model_from_plan(plan).is_some_and(|model| model == value)
        {
            self.ensure_platform_model(plan).await?;
            return Ok(self.control_snapshot(plan));
        }
        self.set_advertised_control(plan, control_id, value).await
    }

    async fn set_advertised_control(
        &mut self,
        plan: &RuntimeTurnPlan,
        control_id: &str,
        value: &str,
    ) -> Result<AcpRuntimeControlSnapshot> {
        let (session_id, path) = {
            let state = self.session_state.lock().unwrap();
            let session_id = state
                .session_id
                .clone()
                .ok_or_else(|| anyhow!("ACP session is not ready"))?;
            let path = state
                .resolve_control_set(control_id, value)
                .map_err(|error| anyhow!(error))?;
            (session_id, path)
        };

        match path {
            AcpControlSetPath::ConfigOption { config_id } => {
                let response = self
                    .protocol
                    .set_config_option(session_id, config_id, value.to_string())
                    .await?;
                if !response.config_options.is_empty() {
                    self.session_state.lock().unwrap().config_options =
                        Some(response.config_options);
                }
            }
            AcpControlSetPath::LegacyModel => {
                self.protocol
                    .set_model(session_id, value.to_string())
                    .await?;
                self.session_state.lock().unwrap().apply_legacy_model(value);
            }
            AcpControlSetPath::LegacyMode => {
                self.protocol
                    .set_mode(session_id, value.to_string())
                    .await?;
                self.session_state.lock().unwrap().apply_legacy_mode(value);
            }
        }

        let snapshot = self.control_snapshot(plan);
        let observed = snapshot
            .controls
            .iter()
            .find(|control| control.id == control_id)
            .map(|control| control.current_value.as_str());
        if observed != Some(value) {
            bail!("ACP control update was not observed by the active session");
        }
        Ok(snapshot)
    }

    async fn ensure_platform_model(&mut self, plan: &RuntimeTurnPlan) -> Result<()> {
        let Some(model) = platform_model_from_plan(plan).map(str::to_string) else {
            return Ok(());
        };
        if self.platform_model_applied.as_deref() == Some(model.as_str()) {
            return Ok(());
        }
        let session_id = self
            .session_state
            .lock()
            .unwrap()
            .session_id
            .clone()
            .ok_or_else(|| anyhow!("ACP session is not ready"))?;
        match plan.engine.as_str() {
            "hermes" => {
                let transport_model = format!("custom:{model}");
                self.protocol
                    .set_model(session_id, transport_model.clone())
                    .await?;
                self.session_state
                    .lock()
                    .unwrap()
                    .apply_legacy_model(&transport_model);
            }
            "codex" => {
                let raw_snapshot = self.session_state.lock().unwrap().control_snapshot("", "");
                let control = raw_snapshot
                    .controls
                    .iter()
                    .find(|control| control.category == "model")
                    .ok_or_else(|| anyhow!("Codex ACP did not advertise its active model"))?;
                if control.current_value != model {
                    if !control.options.iter().any(|choice| choice.value == model) {
                        bail!("Codex ACP did not confirm the Mia platform model `{model}`");
                    }
                    self.set_advertised_control(plan, &control.id, &model)
                        .await?;
                }
            }
            "claude-code" => {
                if plan.environment.get("ANTHROPIC_MODEL").map(String::as_str)
                    != Some(model.as_str())
                {
                    bail!("Claude Code Mia platform model was not applied to the ACP process");
                }
            }
            _ => {}
        }
        self.platform_model_applied = Some(model);
        Ok(())
    }
}

fn platform_model_from_plan(plan: &RuntimeTurnPlan) -> Option<&str> {
    (plan
        .environment
        .get("MIA_PLATFORM_PROVIDER")
        .map(String::as_str)
        == Some("mia"))
    .then(|| plan.environment.get("MIA_PLATFORM_MODEL"))
    .flatten()
    .map(String::as_str)
    .map(str::trim)
    .filter(|model| !model.is_empty())
}

#[derive(Debug)]
struct AcpProtocol {
    connection: ConnectionTo<Agent>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    alive: Arc<AtomicBool>,
    active_turn: SharedActiveTurn,
    permission_broker: NativeAcpPermissionBroker,
    agent_capabilities: AgentCapabilities,
}

type SharedActiveTurn = Arc<StdMutex<Option<ActiveTurnContext>>>;

#[derive(Clone, Debug)]
struct ActiveTurnContext {
    turn_id: String,
    conversation_id: String,
    engine: String,
    bot_id: String,
    permission_mode: String,
    sink: RuntimeEventSink,
    accumulated_text: Arc<StdMutex<String>>,
}

#[derive(Debug)]
struct PendingNativeAcpPermission {
    public: AgentPermissionPendingRequest,
    options: Vec<PermissionOption>,
    responder: StdMutex<Option<oneshot::Sender<RequestPermissionOutcome>>>,
    active: ActiveTurnContext,
}

#[derive(Clone, Debug, Default)]
pub struct NativeAcpPermissionBroker {
    pending: Arc<DashMap<String, Arc<PendingNativeAcpPermission>>>,
}

impl NativeAcpPermissionBroker {
    async fn request(
        &self,
        request: RequestPermissionRequest,
        active: ActiveTurnContext,
    ) -> RequestPermissionOutcome {
        if is_full_access_permission_mode(&active.permission_mode) {
            return selected_permission_outcome(&request.options, "allow_always")
                .or_else(|| selected_permission_outcome(&request.options, "allow_once"))
                .unwrap_or(RequestPermissionOutcome::Cancelled);
        }

        let request_id = format!("perm_{}", Uuid::now_v7().simple());
        let tool_name = permission_tool_name(&request);
        let title = request
            .tool_call
            .fields
            .title
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("{} 想使用工具", engine_label(&active.engine)));
        let preview = permission_preview(&request);
        let public = AgentPermissionPendingRequest {
            request_id: request_id.clone(),
            engine: active.engine.clone(),
            bot_id: active.bot_id.clone(),
            session_id: request.session_id.to_string(),
            tool_name: tool_name.clone(),
            title: title.clone(),
            description: request
                .options
                .iter()
                .map(|option| option.name.trim())
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
                .join(" / "),
            preview: preview.clone(),
            rule: AgentPermissionRule {
                id: format!("{}:{}", active.engine, tool_name),
                engine: active.engine.clone(),
                tool_name: tool_name.clone(),
                subject_type: "tool".into(),
                subject_value: tool_name.clone(),
                label: title.clone(),
            },
            created_at: current_time_ms().to_string(),
        };
        let (tx, rx) = oneshot::channel();
        let pending = Arc::new(PendingNativeAcpPermission {
            public: public.clone(),
            options: request.options,
            responder: StdMutex::new(Some(tx)),
            active: active.clone(),
        });
        self.pending.insert(request_id.clone(), pending);
        emit_permission_event(
            &active,
            json!({
                "type": "permission_request",
                "requestId": public.request_id,
                "engine": public.engine,
                "botId": public.bot_id,
                "sessionId": public.session_id,
                "toolName": public.tool_name,
                "title": public.title,
                "description": public.description,
                "preview": public.preview,
                "rule": public.rule,
                "createdAt": public.created_at,
            }),
        );

        let outcome = rx.await.unwrap_or(RequestPermissionOutcome::Cancelled);
        self.pending.remove(&request_id);
        outcome
    }

    pub fn list_pending(&self, session_id: Option<&str>) -> AgentPermissionListResponse {
        let session_id = session_id.map(str::trim).filter(|value| !value.is_empty());
        let mut requests = self
            .pending
            .iter()
            .filter(|entry| session_id.is_none_or(|value| entry.value().public.session_id == value))
            .map(|entry| entry.value().public.clone())
            .collect::<Vec<_>>();
        requests.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        AgentPermissionListResponse { requests }
    }

    pub fn respond(
        &self,
        request: AgentPermissionRespondRequest,
    ) -> AgentPermissionRespondResponse {
        let request_id = request
            .request_id
            .as_deref()
            .or(request.id.as_deref())
            .map(str::trim)
            .unwrap_or("");
        let decision = request
            .decision
            .as_deref()
            .or(request.action.as_deref())
            .map(str::trim)
            .unwrap_or("");
        let Some(pending) = self
            .pending
            .get(request_id)
            .map(|entry| entry.value().clone())
        else {
            return AgentPermissionRespondResponse {
                ok: false,
                error: Some("permission request not found".into()),
            };
        };
        let outcome = selected_permission_outcome(&pending.options, decision)
            .unwrap_or(RequestPermissionOutcome::Cancelled);
        let Some(responder) = pending.responder.lock().unwrap().take() else {
            return AgentPermissionRespondResponse {
                ok: false,
                error: Some("permission request already resolved".into()),
            };
        };
        self.pending.remove(request_id);
        emit_permission_event(
            &pending.active,
            json!({
                "type": "permission_resolved",
                "requestId": request_id,
                "decision": decision,
            }),
        );
        let _ = responder.send(outcome);
        AgentPermissionRespondResponse {
            ok: true,
            error: None,
        }
    }

    fn cancel_session(&self, session_id: &SessionId) {
        let session_id = session_id.to_string();
        let request_ids = self
            .pending
            .iter()
            .filter(|entry| entry.value().public.session_id == session_id)
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>();
        for request_id in request_ids {
            let Some((_, pending)) = self.pending.remove(&request_id) else {
                continue;
            };
            if let Some(responder) = pending.responder.lock().unwrap().take() {
                emit_permission_event(
                    &pending.active,
                    json!({
                        "type": "permission_resolved",
                        "requestId": request_id,
                        "decision": "cancelled",
                    }),
                );
                let _ = responder.send(RequestPermissionOutcome::Cancelled);
            }
        }
    }
}

fn emit_permission_event(active: &ActiveTurnContext, event: Value) {
    let event = runtime_stdout_event(
        &active.turn_id,
        &active.conversation_id,
        &active.engine,
        "",
        event,
    );
    active.sink.emit(event.name, event.data);
}

fn selected_permission_outcome(
    options: &[PermissionOption],
    decision: &str,
) -> Option<RequestPermissionOutcome> {
    let desired_kinds: &[PermissionOptionKind] = match decision.trim() {
        "allow_always" | "always" => &[
            PermissionOptionKind::AllowAlways,
            PermissionOptionKind::AllowOnce,
        ],
        "allow_once" | "allow" => &[
            PermissionOptionKind::AllowOnce,
            PermissionOptionKind::AllowAlways,
        ],
        "reject_always" | "deny_always" => &[
            PermissionOptionKind::RejectAlways,
            PermissionOptionKind::RejectOnce,
        ],
        "reject_once" | "deny" | "reject" => &[
            PermissionOptionKind::RejectOnce,
            PermissionOptionKind::RejectAlways,
        ],
        option_id if !option_id.is_empty() => {
            return options
                .iter()
                .find(|option| option.option_id.to_string() == option_id)
                .map(|option| selected_permission_option(option.option_id.clone()));
        }
        _ => return None,
    };
    desired_kinds.iter().find_map(|kind| {
        options
            .iter()
            .find(|option| option.kind == *kind)
            .map(|option| selected_permission_option(option.option_id.clone()))
    })
}

fn selected_permission_option(option_id: PermissionOptionId) -> RequestPermissionOutcome {
    RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id))
}

fn permission_tool_name(request: &RequestPermissionRequest) -> String {
    request
        .tool_call
        .fields
        .kind
        .as_ref()
        .and_then(|kind| serde_json::to_value(kind).ok())
        .and_then(|value| value.as_str().map(str::to_string))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "tool".into())
}

fn permission_preview(request: &RequestPermissionRequest) -> String {
    let preview = request
        .tool_call
        .fields
        .raw_input
        .as_ref()
        .map(|input| match input {
            Value::String(text) => text.clone(),
            other => serde_json::to_string(other).unwrap_or_default(),
        })
        .unwrap_or_default();
    truncate_from_start(preview.trim(), 1200)
}

fn is_full_access_permission_mode(value: &str) -> bool {
    matches!(
        value.trim(),
        "agent-full-access" | "full-access" | "bypassPermissions" | ":danger-full-access"
    )
}

fn engine_label(engine: &str) -> &str {
    match engine {
        "codex" => "Codex",
        "claude-code" => "Claude Code",
        "hermes" => "Hermes",
        _ => "Agent",
    }
}

fn current_time_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

impl AcpProtocol {
    async fn connect(
        stdin: ChildStdin,
        stdout: ChildStdout,
        session_state: SharedSessionState,
        permission_broker: NativeAcpPermissionBroker,
    ) -> Result<Self> {
        let alive = Arc::new(AtomicBool::new(true));
        let active_turn = Arc::new(StdMutex::new(None));
        let (init_tx, init_rx) = oneshot::channel::<Result<AgentCapabilities, String>>();
        let (ready_tx, ready_rx) = oneshot::channel::<ConnectionTo<Agent>>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        tokio::spawn(run_sdk_background(
            stdin,
            stdout,
            active_turn.clone(),
            session_state,
            permission_broker.clone(),
            init_tx,
            ready_tx,
            shutdown_rx,
            alive.clone(),
        ));

        let agent_capabilities = tokio::time::timeout(ACP_INIT_TIMEOUT, init_rx)
            .await
            .context("ACP initialize timed out")?
            .context("ACP initialize channel closed")?
            .map_err(|error| anyhow!(error))?;
        let connection = ready_rx
            .await
            .context("ACP connection was not published after initialize")?;

        Ok(Self {
            connection,
            shutdown_tx: Some(shutdown_tx),
            alive,
            active_turn,
            permission_broker,
            agent_capabilities,
        })
    }

    fn set_active_turn(&self, active: Option<ActiveTurnContext>) {
        *self.active_turn.lock().unwrap() = active;
    }

    fn is_connected(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    fn supports_session_resume(&self) -> bool {
        capabilities_support_session_resume(&self.agent_capabilities)
    }

    async fn new_session(
        &self,
        cwd: PathBuf,
        mcp_servers: Vec<McpServer>,
    ) -> Result<agent_client_protocol::schema::NewSessionResponse> {
        self.send_request(NewSessionRequest::new(cwd).mcp_servers(mcp_servers))
            .await
    }

    async fn resume_session(
        &self,
        session_id: SessionId,
        cwd: PathBuf,
        mcp_servers: Vec<McpServer>,
    ) -> Result<agent_client_protocol::schema::ResumeSessionResponse> {
        self.send_request(ResumeSessionRequest::new(session_id, cwd).mcp_servers(mcp_servers))
            .await
    }

    async fn prompt(
        &self,
        session_id: SessionId,
        content: String,
    ) -> Result<agent_client_protocol::schema::PromptResponse> {
        let request = PromptRequest::new(
            session_id,
            vec![ContentBlock::Text(TextContent::new(content))],
        );
        self.send_request(request).await
    }

    async fn set_config_option(
        &self,
        session_id: SessionId,
        config_id: String,
        value: String,
    ) -> Result<agent_client_protocol::schema::SetSessionConfigOptionResponse> {
        self.send_request(SetSessionConfigOptionRequest::new(
            session_id, config_id, value,
        ))
        .await
    }

    async fn set_model(&self, session_id: SessionId, model_id: String) -> Result<()> {
        self.send_request(SetSessionModelRequest::new(session_id, model_id))
            .await
            .map(|_: agent_client_protocol::schema::SetSessionModelResponse| ())
    }

    async fn set_mode(&self, session_id: SessionId, mode_id: String) -> Result<()> {
        self.send_request(SetSessionModeRequest::new(session_id, mode_id))
            .await
            .map(|_: agent_client_protocol::schema::SetSessionModeResponse| ())
    }

    fn cancel(&self, session_id: SessionId) {
        self.permission_broker.cancel_session(&session_id);
        if self.is_connected() {
            let _ = self
                .connection
                .send_notification(CancelNotification::new(session_id));
        }
    }

    async fn send_request<Req>(&self, request: Req) -> Result<Req::Response>
    where
        Req: JsonRpcRequest + serde::Serialize + std::fmt::Debug,
        Req::Response: serde::Serialize + std::fmt::Debug + Send,
    {
        if !self.is_connected() {
            bail!("ACP connection is not connected");
        }
        self.connection
            .send_request(request)
            .block_task()
            .await
            .map_err(|error| anyhow!("{error:?}"))
    }
}

impl Drop for AcpProtocol {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

async fn run_sdk_background(
    stdin: ChildStdin,
    stdout: ChildStdout,
    active_turn: SharedActiveTurn,
    session_state: SharedSessionState,
    permission_broker: NativeAcpPermissionBroker,
    init_tx: oneshot::Sender<Result<AgentCapabilities, String>>,
    ready_tx: oneshot::Sender<ConnectionTo<Agent>>,
    shutdown_rx: oneshot::Receiver<()>,
    alive: Arc<AtomicBool>,
) {
    let transport = ByteStreams::new(stdin.compat_write(), stdout.compat());
    let mut init_tx = Some(init_tx);
    let mut ready_tx = Some(ready_tx);
    let mut shutdown_rx = Some(shutdown_rx);

    let result = Client
        .builder()
        .on_receive_notification(
            {
                let active_turn = active_turn.clone();
                let session_state = session_state.clone();
                async move |notification: SessionNotification, _cx: ConnectionTo<Agent>| {
                    session_state
                        .lock()
                        .unwrap()
                        .apply_session_notification(&notification);
                    handle_session_notification(notification, &active_turn);
                    Ok(())
                }
            },
            on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let active = { active_turn.lock().unwrap().clone() };
                let outcome = match active {
                    Some(active) => permission_broker.request(request, active).await,
                    None => RequestPermissionOutcome::Cancelled,
                };
                let _ = responder.respond(RequestPermissionResponse::new(outcome));
                Ok(())
            },
            on_receive_request!(),
        )
        .connect_with(transport, async move |connection: ConnectionTo<Agent>| {
            let initialize = InitializeRequest::new(ProtocolVersion::LATEST)
                .client_info(Implementation::new(ACP_CLIENT_NAME, ACP_CLIENT_VERSION));
            match connection.send_request(initialize).block_task().await {
                Ok(response) => {
                    if let Some(tx) = init_tx.take() {
                        let _ = tx.send(Ok(response.agent_capabilities));
                    }
                }
                Err(error) => {
                    if let Some(tx) = init_tx.take() {
                        let _ = tx.send(Err(format!("{error:?}")));
                    }
                    return Err(error);
                }
            }

            if let Some(tx) = ready_tx.take()
                && tx.send(connection).is_err()
            {
                return Ok(());
            }

            if let Some(rx) = shutdown_rx.take() {
                let _ = rx.await;
            }
            Ok(())
        })
        .await;

    alive.store(false, Ordering::Release);
    if let Err(error) = result {
        tracing::debug!(?error, "ACP SDK background connection closed");
    }
}

fn handle_session_notification(notification: SessionNotification, active_turn: &SharedActiveTurn) {
    tracing::debug!(?notification, "ACP session/update received");
    let Some(active) = active_turn.lock().unwrap().clone() else {
        return;
    };
    let events = runtime_events_from_session_notification(
        &active.turn_id,
        &active.conversation_id,
        &active.engine,
        &notification,
    );
    for event in events {
        if event.data["event"]["type"] == "message.delta"
            && let Some(text) = event.data.get("text").and_then(Value::as_str)
        {
            active.accumulated_text.lock().unwrap().push_str(text);
        }
        active.sink.emit(event.name, event.data);
    }
}

async fn read_stderr_tail<R>(stream: Option<R>, tail: Arc<StdMutex<String>>)
where
    R: AsyncRead + Unpin,
{
    let Some(mut stream) = stream else {
        return;
    };
    let mut buffer = [0_u8; 1024];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) => break,
            Ok(bytes) => append_stderr_tail(&tail, &String::from_utf8_lossy(&buffer[..bytes])),
            Err(_) => break,
        }
    }
}

fn append_stderr_tail(tail: &Arc<StdMutex<String>>, chunk: &str) {
    let mut tail = tail.lock().unwrap();
    tail.push_str(chunk);
    if tail.len() > ACP_STDERR_TAIL_LIMIT {
        let excess = tail.len() - ACP_STDERR_TAIL_LIMIT;
        let split = tail
            .char_indices()
            .find_map(|(idx, _)| (idx >= excess).then_some(idx))
            .unwrap_or(excess);
        tail.drain(..split);
    }
}

fn stderr_tail_snapshot(tail: &Arc<StdMutex<String>>) -> String {
    tail.lock().unwrap().trim().to_string()
}

fn empty_native_acp_output_error(
    engine: &str,
    stop_reason: StopReason,
    stderr_tail: &str,
) -> String {
    let engine_label = match engine {
        "hermes" => "Hermes",
        "codex" => "Codex",
        "claude-code" => "Claude Code",
        other => other,
    };
    let detail = summarize_acp_stderr(stderr_tail);
    if detail.is_empty() {
        format!(
            "{engine_label} native ACP completed with stopReason={stop_reason:?} but produced no assistant output."
        )
    } else {
        format!("{engine_label} native ACP produced no assistant output. stderr: {detail}")
    }
}

fn validate_probe_prompt_output(output: &str, stop_reason: StopReason) -> Result<(), String> {
    if output.trim().is_empty() {
        return Err(format!(
            "ACP prompt self-check completed with stopReason={stop_reason:?} but produced no assistant output"
        ));
    }
    Ok(())
}

fn summarize_acp_stderr(stderr_tail: &str) -> String {
    let lines: Vec<&str> = stderr_tail
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return String::new();
    }

    let keywords = [
        "ERROR",
        "Error",
        "error",
        "HTTP ",
        "Non-retryable",
        "AuthenticationError",
        "ValueError",
        "❌",
        "⚠️",
        "请先登录",
    ];
    let relevant: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| keywords.iter().any(|keyword| line.contains(keyword)))
        .collect();
    let source = if relevant.is_empty() {
        &lines
    } else {
        &relevant
    };
    let start = source.len().saturating_sub(8);
    truncate_from_start(&source[start..].join("\n"), 2000)
}

fn truncate_from_start(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let start = value
        .char_indices()
        .find_map(|(idx, _)| (idx + limit >= value.len()).then_some(idx))
        .unwrap_or(value.len().saturating_sub(limit));
    format!("...{}", &value[start..])
}

struct UnavailableNativeAcpBackend;

#[async_trait]
impl NativeAcpBackend for UnavailableNativeAcpBackend {
    async fn send_message(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        _cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult> {
        sink.emit(
            EVENT_RUNTIME_STARTED,
            json!({
                "turnId": plan.turn_id,
                "conversationId": plan.conversation_id,
                "engine": plan.engine,
                "protocol": "nativeAcp",
            }),
        );
        sink.emit(
            EVENT_RUNTIME_FINISHED,
            json!({
                "turnId": plan.turn_id,
                "conversationId": plan.conversation_id,
                "engine": plan.engine,
                "exitCode": null,
                "cancelled": false,
                "ok": false,
                "error": "native ACP runtime is unavailable",
            }),
        );
        Err(anyhow!("native ACP runtime is unavailable"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RuntimeProtocol, RuntimeSendMessage, RuntimeSessionState};
    use agent_client_protocol::schema::{
        ConfigOptionUpdate, ContentBlock, ContentChunk, CurrentModeUpdate, ModelInfo,
        NewSessionResponse, PermissionOption, PermissionOptionKind, SessionCapabilities,
        SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption, SessionMode,
        SessionModeState, SessionModelState, SessionNotification, SessionResumeCapabilities,
        SessionUpdate, TextContent, ToolCallUpdate, ToolCallUpdateFields,
    };

    fn native_acp_test_plan() -> RuntimeTurnPlan {
        RuntimeTurnPlan {
            turn_id: "turn_test".into(),
            conversation_id: "conv_test".into(),
            bot_id: Some("bot_test".into()),
            engine: "codex".into(),
            workspace_dir: ".".into(),
            protocol: RuntimeProtocol::NativeAcp,
            command: Some(RuntimeCommand {
                program: "fake-acp".into(),
                args: vec![],
            }),
            environment: BTreeMap::new(),
            provider: json!({}),
            mcp_servers: json!({}),
            selected_skill_ids: vec![],
            runtime_session: RuntimeSessionState {
                conversation_id: "conv_test".into(),
                engine: "codex".into(),
                session_key: "codex:conv_test".into(),
                resume_session_key: None,
                resumed: false,
            },
            send_message: RuntimeSendMessage {
                content: "hello".into(),
                msg_id: "msg_test".into(),
                turn_id: Some("turn_test".into()),
                files: vec![],
                inject_skills: vec![],
            },
            mock_response: None,
        }
    }

    #[test]
    fn native_acp_translates_agent_message_chunk_to_runtime_stdout_delta() {
        let notification = SessionNotification::new(
            "acp-session-1",
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                TextContent::new("你"),
            ))),
        );

        let events =
            runtime_events_from_session_notification("turn_1", "conv_1", "codex", &notification);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].name, crate::EVENT_RUNTIME_STDOUT);
        assert_eq!(events[0].data["turnId"], "turn_1");
        assert_eq!(events[0].data["conversationId"], "conv_1");
        assert_eq!(events[0].data["engine"], "codex");
        assert_eq!(events[0].data["text"], "你");
        assert_eq!(events[0].data["event"]["type"], "message.delta");
        assert_eq!(events[0].data["event"]["text"], "你");
        assert_eq!(events[0].data["event"]["sessionId"], "acp-session-1");
    }

    #[tokio::test]
    async fn native_acp_permission_broker_waits_for_and_returns_the_real_selected_option() {
        let broker = NativeAcpPermissionBroker::default();
        let events = Arc::new(StdMutex::new(Vec::<RuntimeProcessEvent>::new()));
        let event_target = events.clone();
        let active = ActiveTurnContext {
            turn_id: "turn_permission".into(),
            conversation_id: "conv_permission".into(),
            engine: "codex".into(),
            bot_id: "bot_permission".into(),
            permission_mode: "agent".into(),
            sink: RuntimeEventSink::new(move |event| event_target.lock().unwrap().push(event)),
            accumulated_text: Arc::new(StdMutex::new(String::new())),
        };
        let request = RequestPermissionRequest::new(
            "session_permission",
            ToolCallUpdate::new(
                "tool_permission",
                ToolCallUpdateFields::new()
                    .title("Run npm test")
                    .raw_input(json!({ "command": "npm test" })),
            ),
            vec![
                PermissionOption::new("allow-once", "Allow once", PermissionOptionKind::AllowOnce),
                PermissionOption::new("reject-once", "Reject", PermissionOptionKind::RejectOnce),
            ],
        );
        let broker_waiter = broker.clone();
        let outcome = tokio::spawn(async move { broker_waiter.request(request, active).await });
        for _ in 0..20 {
            if !broker.list_pending(None).requests.is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        let pending = broker.list_pending(None).requests;

        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].engine, "codex");
        assert_eq!(pending[0].session_id, "session_permission");
        assert!(
            broker
                .respond(mia_core_api_types::AgentPermissionRespondRequest {
                    request_id: Some(pending[0].request_id.clone()),
                    decision: Some("allow_once".into()),
                    ..Default::default()
                })
                .ok
        );
        let selected = outcome.await.expect("permission task");
        let RequestPermissionOutcome::Selected(selected) = selected else {
            panic!("expected selected permission outcome");
        };
        assert_eq!(selected.option_id.to_string(), "allow-once");
        assert!(broker.list_pending(None).requests.is_empty());
        let events = events.lock().unwrap();
        assert_eq!(events[0].data["event"]["type"], "permission_request");
        assert_eq!(events[1].data["event"]["type"], "permission_resolved");
    }

    #[test]
    fn native_acp_detects_resume_capability_from_initialize_response() {
        let capabilities = AgentCapabilities::new().session_capabilities(
            SessionCapabilities::new().resume(SessionResumeCapabilities::new()),
        );

        assert!(capabilities_support_session_resume(&capabilities));
        assert!(!capabilities_support_session_resume(
            &AgentCapabilities::new()
        ));
    }

    #[test]
    fn native_acp_uses_only_persisted_resume_session_key_for_resume() {
        let mut plan = native_acp_test_plan();
        assert_eq!(resumable_session_id(&plan), None);

        plan.runtime_session.resume_session_key = Some(" acp-session-1 ".into());

        assert_eq!(
            resumable_session_id(&plan).map(|session_id| session_id.to_string()),
            Some("acp-session-1".into())
        );
    }

    #[test]
    fn native_acp_normalizes_core_mcp_server_map_for_acp_requests() {
        let mut plan = native_acp_test_plan();
        plan.mcp_servers = json!({
            "mcpServers": {
                "playwright": {
                    "command": "npx",
                    "args": ["-y", "@playwright/mcp"],
                    "env": {
                        "TOKEN": "secret",
                        "EMPTY": null
                    }
                }
            }
        });

        let servers = mcp_servers_from_plan(&plan);

        assert_eq!(servers.len(), 1);
        match &servers[0] {
            McpServer::Stdio(server) => {
                assert_eq!(server.name, "playwright");
                assert_eq!(server.command.to_string_lossy(), "npx");
                assert_eq!(server.args, vec!["-y", "@playwright/mcp"]);
                assert_eq!(server.env.len(), 1);
                assert_eq!(server.env[0].name, "TOKEN");
                assert_eq!(server.env[0].value, "secret");
            }
            other => panic!("expected stdio MCP server, got {other:?}"),
        }
    }

    #[test]
    fn native_acp_stale_session_detection_is_narrow() {
        assert!(is_stale_session_error(&anyhow!("session not found")));
        assert!(is_stale_session_error(&anyhow!("SESSION_NOT_FOUND")));
        assert!(!is_stale_session_error(&anyhow!("permission denied")));
    }

    #[test]
    fn native_acp_session_manager_can_construct_real_backend() {
        let manager = NativeAcpSessionManager::real();

        assert!(format!("{manager:?}").contains("NativeAcpSessionManager"));
    }

    #[test]
    fn native_acp_empty_output_is_visible_failure() {
        let message = empty_native_acp_output_error("hermes", StopReason::EndTurn, "");

        assert!(message.contains("Hermes native ACP completed"));
        assert!(message.contains("produced no assistant output"));
        assert!(message.contains("EndTurn"));
    }

    #[test]
    fn native_acp_probe_requires_assistant_output() {
        let message = validate_probe_prompt_output("", StopReason::EndTurn).unwrap_err();

        assert!(message.contains("ACP prompt self-check completed"));
        assert!(message.contains("produced no assistant output"));
        assert!(message.contains("EndTurn"));
        assert!(validate_probe_prompt_output("OK", StopReason::EndTurn).is_ok());
    }

    #[test]
    fn native_acp_empty_output_includes_stderr_tail() {
        let message =
            empty_native_acp_output_error("codex", StopReason::EndTurn, "provider auth failed");

        assert!(message.contains("Codex native ACP produced no assistant output"));
        assert!(message.contains("provider auth failed"));
    }

    #[test]
    fn native_acp_empty_output_summarizes_noisy_stderr() {
        let stderr = [
            "2026-07-09 [INFO] startup",
            "2026-07-09 [INFO] many tools registered",
            "2026-07-09 [WARNING] transient auxiliary warning",
            "⚠️  API call failed (attempt 1/3): ValueError",
            "   📝 Error: Codex Responses request 'model' must be a non-empty string.",
            "❌ Non-retryable client error (HTTP None). Aborting.",
            "2026-07-09 [ERROR] Non-retryable client error: Codex Responses request 'model' must be a non-empty string.",
        ]
        .join("\n");

        let message = empty_native_acp_output_error("hermes", StopReason::EndTurn, &stderr);

        assert!(message.contains("ValueError"));
        assert!(message.contains("model' must be a non-empty string"));
        assert!(!message.contains("many tools registered"));
    }

    #[test]
    fn native_acp_snapshot_hides_controls_the_agent_did_not_advertise() {
        let response = NewSessionResponse::new("hermes-session")
            .models(SessionModelState::new(
                "openrouter:grok-4.3",
                vec![ModelInfo::new("openrouter:grok-4.3", "grok-4.3")],
            ))
            .modes(SessionModeState::new(
                "default",
                vec![SessionMode::new("default", "Default")],
            ));
        let mut state = NativeAcpSessionState::default();

        state.apply_new_session_response(response);
        let snapshot = state.control_snapshot("conv_hermes", "hermes");

        assert_eq!(snapshot.session_id.as_deref(), Some("hermes-session"));
        assert_eq!(snapshot.state, "ready");
        assert_eq!(
            snapshot
                .controls
                .iter()
                .map(|control| control.category.as_str())
                .collect::<Vec<_>>(),
            vec!["model", "permission"]
        );
        assert!(
            snapshot
                .controls
                .iter()
                .all(|control| control.category != "thought_level")
        );
    }

    #[test]
    fn native_acp_snapshot_prefers_real_config_options_over_legacy_catalogs() {
        let config_options = vec![
            SessionConfigOption::select(
                "model",
                "Model",
                "claude-sonnet-4-6",
                vec![SessionConfigSelectOption::new(
                    "claude-sonnet-4-6",
                    "Sonnet 4.6",
                )],
            )
            .category(SessionConfigOptionCategory::Model),
            SessionConfigOption::select(
                "effort",
                "Effort",
                "high",
                vec![SessionConfigSelectOption::new("high", "High")],
            )
            .category(SessionConfigOptionCategory::ThoughtLevel),
        ];
        let mut response =
            NewSessionResponse::new("claude-session").models(SessionModelState::new(
                "legacy-model",
                vec![ModelInfo::new("legacy-model", "Legacy")],
            ));
        response.config_options = Some(config_options);
        let mut state = NativeAcpSessionState::default();

        state.apply_new_session_response(response);
        let snapshot = state.control_snapshot("conv_claude", "claude-code");

        assert_eq!(snapshot.controls.len(), 2);
        assert_eq!(snapshot.controls[0].source, "config_option");
        assert_eq!(snapshot.controls[0].current_value, "claude-sonnet-4-6");
        assert_eq!(snapshot.controls[1].category, "thought_level");
        assert_eq!(snapshot.controls[1].current_value, "high");
    }

    #[test]
    fn native_acp_snapshot_tracks_observed_config_and_mode_updates() {
        let mut state = NativeAcpSessionState::default();
        state.apply_new_session_response(NewSessionResponse::new("session-updates").modes(
            SessionModeState::new(
                "default",
                vec![
                    SessionMode::new("default", "Default"),
                    SessionMode::new("acceptEdits", "Accept Edits"),
                ],
            ),
        ));
        state.apply_session_notification(&SessionNotification::new(
            "session-updates",
            SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(vec![
                SessionConfigOption::select(
                    "effort",
                    "Effort",
                    "xhigh",
                    vec![SessionConfigSelectOption::new("xhigh", "Extra High")],
                )
                .category(SessionConfigOptionCategory::ThoughtLevel),
            ])),
        ));
        state.apply_session_notification(&SessionNotification::new(
            "session-updates",
            SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new("acceptEdits")),
        ));

        let snapshot = state.control_snapshot("conv_updates", "claude-code");

        assert_eq!(
            snapshot
                .controls
                .iter()
                .find(|control| control.category == "thought_level")
                .map(|control| control.current_value.as_str()),
            Some("xhigh")
        );
        assert_eq!(
            snapshot
                .controls
                .iter()
                .find(|control| control.category == "permission")
                .map(|control| control.current_value.as_str()),
            Some("acceptEdits")
        );
    }

    #[test]
    fn native_acp_control_set_path_uses_only_advertised_values() {
        let mut state = NativeAcpSessionState::default();
        state.apply_new_session_response(
            NewSessionResponse::new("session-controls")
                .models(SessionModelState::new(
                    "model-a",
                    vec![
                        ModelInfo::new("model-a", "Model A"),
                        ModelInfo::new("model-b", "Model B"),
                    ],
                ))
                .modes(SessionModeState::new(
                    "default",
                    vec![SessionMode::new("default", "Default")],
                )),
        );

        assert_eq!(
            state.resolve_control_set("model", "model-b"),
            Ok(AcpControlSetPath::LegacyModel)
        );
        assert_eq!(
            state.resolve_control_set("mode", "default"),
            Ok(AcpControlSetPath::LegacyMode)
        );
        assert_eq!(
            state.resolve_control_set("effort", "high"),
            Err(AcpControlSetError::ControlNotAdvertised)
        );
        assert_eq!(
            state.resolve_control_set("model", "invented-model"),
            Err(AcpControlSetError::ValueNotAdvertised)
        );
    }

    #[test]
    fn native_acp_control_set_path_prefers_real_config_option() {
        let mut response = NewSessionResponse::new("session-config-controls");
        response.config_options = Some(vec![
            SessionConfigOption::select(
                "reasoning_effort",
                "Reasoning Effort",
                "medium",
                vec![
                    SessionConfigSelectOption::new("medium", "Medium"),
                    SessionConfigSelectOption::new("high", "High"),
                ],
            )
            .category(SessionConfigOptionCategory::ThoughtLevel),
        ]);
        let mut state = NativeAcpSessionState::default();
        state.apply_new_session_response(response);

        assert_eq!(
            state.resolve_control_set("reasoning_effort", "high"),
            Ok(AcpControlSetPath::ConfigOption {
                config_id: "reasoning_effort".into(),
            })
        );
    }

    #[test]
    fn native_acp_reads_only_explicit_desired_controls_from_turn_plan() {
        let mut plan = native_acp_test_plan();
        plan.provider = json!({
            "model": "gpt-5.5",
            "effortLevel": "xhigh",
            "permissionMode": ":workspace"
        });

        assert_eq!(desired_control_value(&plan, "model"), Some("gpt-5.5"));
        assert_eq!(desired_control_value(&plan, "thought_level"), Some("xhigh"));
        assert_eq!(
            desired_control_value(&plan, "permission"),
            Some(":workspace")
        );

        plan.provider = json!({});
        assert_eq!(desired_control_value(&plan, "model"), None);
        assert_eq!(desired_control_value(&plan, "thought_level"), None);
        assert_eq!(desired_control_value(&plan, "permission"), None);
    }
}
