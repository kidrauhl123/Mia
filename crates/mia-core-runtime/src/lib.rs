//! Subprocess runtime preparation boundary for Mia Rust Core.
//!
//! This crate mirrors AION's direction: Core produces an execution plan with
//! sanitized process inputs. External Node/Bun tools may appear as subprocesses,
//! but the plan owner remains Rust.

mod agent_engines;
mod hermes_gateway;
mod memory_isolation;
mod native_acp;

use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub use agent_engines::{
    AgentEngineInventory, AgentEngineScanOptions, AgentEngineScanner,
    ManagedAgentResourcePrepareReport, ManagedAgentResourcePrepareStatus,
    cached_agent_runtime_controls, prepare_managed_agent_resources,
};
pub use hermes_gateway::{HermesGatewayBackend, HermesGatewaySessionManager};
pub use memory_isolation::{apply_memory_isolation_to_plan, preflight_memory_isolation};
use mia_core_common::process::configure_background_command;
pub use native_acp::{NativeAcpBackend, NativeAcpSessionManager};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::process::Command;
use tokio::sync::Notify;
use uuid::Uuid;

use mia_core_api_types::MemoryMode;

const POLLUTED_ENV_KEYS: [&str; 4] = ["NODE_OPTIONS", "NODE_INSPECT", "NODE_DEBUG", "CLAUDECODE"];
pub const EVENT_RUNTIME_STARTED: &str = "conversation.runtimeStarted";
pub const EVENT_RUNTIME_CANCEL_REQUESTED: &str = "conversation.runtimeCancelRequested";
pub const EVENT_RUNTIME_STDOUT: &str = "conversation.runtimeStdout";
pub const EVENT_RUNTIME_STDERR: &str = "conversation.runtimeStderr";
pub const EVENT_RUNTIME_FINISHED: &str = "conversation.runtimeFinished";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommand {
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeProtocol {
    Mock,
    Process,
    NativeAcp,
    HermesGateway,
}

impl Default for RuntimeProtocol {
    fn default() -> Self {
        Self::Process
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTurnInput {
    pub conversation_id: String,
    pub message_id: String,
    pub bot_id: Option<String>,
    #[serde(default = "default_runtime_memory_mode")]
    pub memory_mode: MemoryMode,
    pub engine: Option<String>,
    #[serde(default)]
    pub previous_session_key: Option<String>,
    pub workspace_dir: String,
    pub provider: Value,
    pub mcp_servers: Value,
    pub attachments: Value,
    pub selected_skill_ids: Vec<String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeSendMessage {
    pub content: String,
    pub msg_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub inject_skills: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSessionState {
    pub conversation_id: String,
    pub engine: String,
    pub session_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_session_key: Option<String>,
    #[serde(default)]
    pub resumed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTurnPlan {
    pub turn_id: String,
    pub conversation_id: String,
    pub bot_id: Option<String>,
    #[serde(default = "default_runtime_memory_mode")]
    pub memory_mode: MemoryMode,
    pub engine: String,
    pub workspace_dir: String,
    #[serde(default)]
    pub protocol: RuntimeProtocol,
    pub command: Option<RuntimeCommand>,
    pub environment: BTreeMap<String, String>,
    pub provider: Value,
    pub mcp_servers: Value,
    pub selected_skill_ids: Vec<String>,
    pub runtime_session: RuntimeSessionState,
    pub send_message: RuntimeSendMessage,
    pub mock_response: Option<String>,
}

fn default_runtime_memory_mode() -> MemoryMode {
    MemoryMode::Native
}

#[async_trait::async_trait]
pub trait RuntimeInitialPromptProvider: Send + Sync {
    async fn initial_prompt(&self, plan: &RuntimeTurnPlan) -> anyhow::Result<String>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProcessEvent {
    pub name: String,
    pub data: Value,
}

#[derive(Clone)]
pub struct RuntimeEventSink {
    emit: Arc<dyn Fn(RuntimeProcessEvent) + Send + Sync>,
}

impl std::fmt::Debug for RuntimeEventSink {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeEventSink")
            .finish_non_exhaustive()
    }
}

impl RuntimeEventSink {
    pub fn new<F>(emit: F) -> Self
    where
        F: Fn(RuntimeProcessEvent) + Send + Sync + 'static,
    {
        Self {
            emit: Arc::new(emit),
        }
    }

    pub fn emit(&self, name: impl Into<String>, data: Value) {
        (self.emit)(RuntimeProcessEvent {
            name: name.into(),
            data,
        });
    }
}

impl Default for RuntimeEventSink {
    fn default() -> Self {
        Self::new(|_| {})
    }
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeCancellation {
    inner: Arc<RuntimeCancellationInner>,
}

#[derive(Debug, Default)]
struct RuntimeCancellationInner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl RuntimeCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.inner.notify.notified().await;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeExecutionResult {
    pub exit_code: Option<i32>,
    pub cancelled: bool,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeExecutor;

impl RuntimeExecutor {
    pub async fn execute_plan(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> anyhow::Result<RuntimeExecutionResult> {
        let Some(mut command) = plan.command.clone() else {
            return Ok(RuntimeExecutionResult {
                exit_code: Some(0),
                cancelled: false,
                stdout: plan.mock_response.unwrap_or_default(),
                stderr: String::new(),
            });
        };
        let stdin_input = prepare_command_input(&plan, &mut command);

        sink.emit(
            EVENT_RUNTIME_STARTED,
            json!({
                "turnId": plan.turn_id,
                "conversationId": plan.conversation_id,
                "engine": plan.engine,
                "program": command.program,
                "args": command.args,
            }),
        );

        if !plan.workspace_dir.trim().is_empty() {
            tokio::fs::create_dir_all(&plan.workspace_dir).await?;
        }

        let mut child = Command::new(&command.program);
        configure_background_command(child.as_std_mut());
        child
            .args(&command.args)
            .env_clear()
            .envs(plan.environment.iter())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if !plan.workspace_dir.trim().is_empty() {
            child.current_dir(&plan.workspace_dir);
        }
        let mut child = child.spawn()?;
        let stdin_task = tokio::spawn(write_stdin(child.stdin.take(), stdin_input));
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdout_task = tokio::spawn(read_stream(
            stdout,
            EVENT_RUNTIME_STDOUT,
            plan.turn_id.clone(),
            plan.conversation_id.clone(),
            plan.engine.clone(),
            sink.clone(),
        ));
        let stderr_task = tokio::spawn(read_stream(
            stderr,
            EVENT_RUNTIME_STDERR,
            plan.turn_id.clone(),
            plan.conversation_id.clone(),
            plan.engine.clone(),
            sink.clone(),
        ));

        let mut cancelled = false;
        let status = if let Some(cancellation) = cancellation {
            tokio::select! {
                status = child.wait() => status?,
                _ = cancellation.cancelled() => {
                    cancelled = true;
                    let _ = child.kill().await;
                    child.wait().await?
                }
            }
        } else {
            child.wait().await?
        };
        let _ = stdin_task.await;
        let stdout = stdout_task.await??;
        let stderr = stderr_task.await??;
        let result = RuntimeExecutionResult {
            exit_code: status.code(),
            cancelled,
            stdout,
            stderr,
        };
        sink.emit(
            EVENT_RUNTIME_FINISHED,
            json!({
                "turnId": plan.turn_id,
                "conversationId": plan.conversation_id,
                "engine": plan.engine,
                "exitCode": result.exit_code,
                "cancelled": result.cancelled,
                "ok": result.exit_code == Some(0) && !result.cancelled,
            }),
        );
        Ok(result)
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeSessionManager {
    executor: RuntimeExecutor,
    native_acp: NativeAcpSessionManager,
    hermes_gateway: HermesGatewaySessionManager,
}

impl Default for RuntimeSessionManager {
    fn default() -> Self {
        Self {
            executor: RuntimeExecutor,
            native_acp: NativeAcpSessionManager::unavailable(),
            hermes_gateway: HermesGatewaySessionManager::unavailable(),
        }
    }
}

impl RuntimeSessionManager {
    pub fn new(native_acp: NativeAcpSessionManager) -> Self {
        Self {
            executor: RuntimeExecutor,
            native_acp,
            hermes_gateway: HermesGatewaySessionManager::unavailable(),
        }
    }

    pub fn with_interactive_backends(
        native_acp: NativeAcpSessionManager,
        hermes_gateway: HermesGatewaySessionManager,
    ) -> Self {
        Self {
            executor: RuntimeExecutor,
            native_acp,
            hermes_gateway,
        }
    }

    pub fn native_acp() -> Self {
        Self {
            executor: RuntimeExecutor,
            native_acp: NativeAcpSessionManager::real(),
            hermes_gateway: HermesGatewaySessionManager::real(),
        }
    }

    pub fn native_acp_with_initial_prompt_provider(
        provider: Arc<dyn RuntimeInitialPromptProvider>,
    ) -> Self {
        Self {
            executor: RuntimeExecutor,
            native_acp: NativeAcpSessionManager::real_with_initial_prompt_provider(
                provider.clone(),
            ),
            hermes_gateway: HermesGatewaySessionManager::real_with_initial_prompt_provider(
                provider,
            ),
        }
    }

    pub fn new_without_native_acp_for_tests() -> Self {
        Self::default()
    }

    pub async fn send_message(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> anyhow::Result<RuntimeExecutionResult> {
        match plan.protocol {
            RuntimeProtocol::NativeAcp => {
                self.native_acp.send_message(plan, sink, cancellation).await
            }
            RuntimeProtocol::HermesGateway => {
                self.hermes_gateway
                    .send_message(plan, sink, cancellation)
                    .await
            }
            RuntimeProtocol::Mock | RuntimeProtocol::Process => {
                self.executor.execute_plan(plan, sink, cancellation).await
            }
        }
    }

    pub async fn prepare_session(
        &self,
        plan: RuntimeTurnPlan,
    ) -> anyhow::Result<mia_core_api_types::AcpRuntimeControlSnapshot> {
        match plan.protocol {
            RuntimeProtocol::NativeAcp => self.native_acp.prepare_session(plan).await,
            RuntimeProtocol::HermesGateway => self.hermes_gateway.prepare_session(plan).await,
            RuntimeProtocol::Mock | RuntimeProtocol::Process => {
                anyhow::bail!("runtime controls require an interactive agent session")
            }
        }
    }

    pub async fn set_control(
        &self,
        plan: RuntimeTurnPlan,
        control_id: String,
        value: String,
    ) -> anyhow::Result<mia_core_api_types::AcpRuntimeControlSnapshot> {
        match plan.protocol {
            RuntimeProtocol::NativeAcp => {
                self.native_acp.set_control(plan, control_id, value).await
            }
            RuntimeProtocol::HermesGateway => {
                self.hermes_gateway
                    .set_control(plan, control_id, value)
                    .await
            }
            RuntimeProtocol::Mock | RuntimeProtocol::Process => {
                anyhow::bail!("runtime controls require an interactive agent session")
            }
        }
    }

    pub fn list_pending_permissions(
        &self,
        session_id: Option<&str>,
    ) -> mia_core_api_types::AgentPermissionListResponse {
        let mut response = self.native_acp.list_pending_permissions(session_id);
        response.requests.extend(
            self.hermes_gateway
                .list_pending_permissions(session_id)
                .requests,
        );
        response
            .requests
            .sort_by(|left, right| left.created_at.cmp(&right.created_at));
        response
    }

    pub fn respond_permission(
        &self,
        request: mia_core_api_types::AgentPermissionRespondRequest,
    ) -> mia_core_api_types::AgentPermissionRespondResponse {
        let gateway = self.hermes_gateway.respond_permission(request.clone());
        if gateway.ok || gateway.error.as_deref() != Some("permission request not found") {
            return gateway;
        }
        self.native_acp.respond_permission(request)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeBuilder {
    default_engine: String,
    workspace_dir: String,
    command_overrides: BTreeMap<String, RuntimeCommand>,
    environment: Option<BTreeMap<String, String>>,
}

async fn read_stream<R>(
    stream: Option<R>,
    event_name: &'static str,
    turn_id: String,
    conversation_id: String,
    engine: String,
    sink: RuntimeEventSink,
) -> anyhow::Result<String>
where
    R: AsyncRead + Unpin,
{
    let Some(stream) = stream else {
        return Ok(String::new());
    };
    let mut reader = BufReader::new(stream);
    let mut output = String::new();
    loop {
        let mut line = String::new();
        let bytes = reader.read_line(&mut line).await?;
        if bytes == 0 {
            break;
        }
        output.push_str(&line);
        if should_emit_runtime_stream_line(&engine, &line) {
            sink.emit(
                event_name,
                json!({
                    "turnId": turn_id,
                    "conversationId": conversation_id,
                    "engine": engine,
                    "text": line,
                }),
            );
        }
    }
    Ok(output)
}

fn should_emit_runtime_stream_line(engine: &str, line: &str) -> bool {
    !is_runtime_status_noise_line(engine, line)
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

async fn write_stdin(stdin: Option<ChildStdin>, input: String) {
    let Some(mut stdin) = stdin else {
        return;
    };
    if !input.is_empty() {
        let _ = stdin.write_all(input.as_bytes()).await;
    }
    let _ = stdin.shutdown().await;
}

fn prepare_command_input(plan: &RuntimeTurnPlan, _command: &mut RuntimeCommand) -> String {
    let input = plan.send_message.content.clone();
    if matches!(
        plan.protocol,
        RuntimeProtocol::NativeAcp | RuntimeProtocol::HermesGateway
    ) {
        input
    } else {
        input
    }
}

impl RuntimeBuilder {
    pub fn new(workspace_dir: impl Into<String>) -> Self {
        Self {
            default_engine: "mock-agent".into(),
            workspace_dir: workspace_dir.into(),
            command_overrides: BTreeMap::new(),
            environment: None,
        }
    }

    pub fn with_default_engine(mut self, engine: impl Into<String>) -> Self {
        let engine = engine.into();
        self.default_engine = if engine.trim().is_empty() {
            "mock-agent".into()
        } else {
            engine
        };
        self
    }

    pub fn with_engine_command(
        mut self,
        engine: impl Into<String>,
        command: RuntimeCommand,
    ) -> Self {
        self.command_overrides.insert(engine.into(), command);
        self
    }

    pub fn with_environment<I, K, V>(mut self, vars: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        self.environment = Some(
            vars.into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
        );
        self
    }

    pub fn build_turn_plan(&self, input: RuntimeTurnInput) -> RuntimeTurnPlan {
        let engine = input
            .engine
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&self.default_engine)
            .to_string();
        let workspace_dir = if input.workspace_dir.trim().is_empty() {
            self.workspace_dir.clone()
        } else {
            input.workspace_dir
        };
        let has_command_override = self.command_overrides.contains_key(&engine);
        let mut environment = runtime_environment_for_engine(
            &engine,
            self.environment
                .clone()
                .unwrap_or_else(|| std::env::vars().collect()),
        );
        let managed_runtime = (!has_command_override)
            .then(|| agent_engines::resolve_managed_agent_runtime_plan(&engine, &environment))
            .flatten();
        if let Some(runtime) = &managed_runtime {
            environment = runtime.environment.clone();
        }
        let mut command = self
            .command_overrides
            .get(&engine)
            .cloned()
            .or_else(|| managed_runtime.map(|runtime| runtime.command))
            .or_else(|| command_for_engine(&engine, &environment));
        let protocol = if has_command_override {
            RuntimeProtocol::Process
        } else {
            protocol_for_engine(&engine)
        };
        if protocol == RuntimeProtocol::HermesGateway
            && let Some(current) = command.as_mut()
        {
            current.args = hermes_gateway_args(&current.args);
        }
        let body = input.body;
        let turn_id = format!("turn_{}", Uuid::now_v7().simple());
        let message_id = clean_non_empty(&input.message_id)
            .unwrap_or_else(|| format!("msg_{}", Uuid::now_v7().simple()));
        let previous_session_key = input
            .previous_session_key
            .as_deref()
            .and_then(clean_non_empty);
        let runtime_session = RuntimeSessionState {
            conversation_id: input.conversation_id.clone(),
            engine: engine.clone(),
            session_key: previous_session_key
                .clone()
                .unwrap_or_else(|| default_runtime_session_key(&input.conversation_id, &engine)),
            resume_session_key: previous_session_key.clone(),
            resumed: previous_session_key.is_some(),
        };
        let send_message = RuntimeSendMessage {
            content: body.clone(),
            msg_id: message_id,
            turn_id: Some(turn_id.clone()),
            files: file_paths_from_attachments(&input.attachments),
            inject_skills: clean_unique_strings(
                input.selected_skill_ids.iter().map(String::as_str),
            ),
        };
        let mock_response = (protocol == RuntimeProtocol::Mock && command.is_none()).then(|| {
            let body = body.trim();
            if body.is_empty() {
                "Mia Rust Core received an empty turn.".to_string()
            } else {
                format!("Mia Rust Core mock response: {body}")
            }
        });
        let mut plan = RuntimeTurnPlan {
            turn_id,
            conversation_id: input.conversation_id,
            bot_id: input.bot_id,
            memory_mode: input.memory_mode,
            engine,
            workspace_dir,
            protocol,
            command,
            environment,
            provider: input.provider,
            mcp_servers: input.mcp_servers,
            selected_skill_ids: input.selected_skill_ids,
            runtime_session,
            send_message,
            mock_response,
        };
        memory_isolation::apply_memory_isolation_to_plan(&mut plan);
        plan
    }
}

fn file_paths_from_attachments(attachments: &Value) -> Vec<String> {
    let values: Vec<&Value> = match attachments {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => vec![attachments],
        _ => Vec::new(),
    };
    clean_unique_strings(values.into_iter().filter_map(attachment_file_path))
}

fn attachment_file_path(attachment: &Value) -> Option<&str> {
    let object = attachment.as_object()?;
    for key in ["path", "filePath", "file_path", "localPath", "local_path"] {
        if let Some(value) = object.get(key).and_then(Value::as_str)
            && clean_non_empty(value).is_some()
        {
            return Some(value);
        }
    }
    None
}

fn clean_unique_strings<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        let Some(cleaned) = clean_non_empty(value) else {
            continue;
        };
        if !out.contains(&cleaned) {
            out.push(cleaned);
        }
    }
    out
}

fn clean_non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn default_runtime_session_key(conversation_id: &str, engine: &str) -> String {
    let conversation_id = clean_non_empty(conversation_id).unwrap_or_else(|| "utility".to_string());
    let engine = clean_non_empty(engine).unwrap_or_else(|| "mock-agent".to_string());
    format!("{engine}:{conversation_id}")
}

pub fn clean_cli_environment<I, K, V>(vars: I) -> BTreeMap<String, String>
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<String>,
    V: Into<String>,
{
    let mut env = BTreeMap::new();
    for (key, value) in vars {
        let key = key.into();
        if POLLUTED_ENV_KEYS
            .iter()
            .any(|polluted| polluted.eq_ignore_ascii_case(&key))
        {
            continue;
        }
        env.insert(key, value.into());
    }
    env.insert("NO_COLOR".into(), "1".into());
    env.insert("TERM".into(), "dumb".into());
    env
}

fn runtime_environment_for_engine<I, K, V>(engine: &str, vars: I) -> BTreeMap<String, String>
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<String>,
    V: Into<String>,
{
    let mut env = clean_cli_environment(vars);
    if engine == "codex"
        && !env.contains_key("CODEX_PATH")
        && let Some(path) = agent_engines::resolve_agent_command_path("codex", &env)
    {
        env.insert("CODEX_PATH".into(), path);
    }
    env
}

fn protocol_for_engine(engine: &str) -> RuntimeProtocol {
    match engine {
        "mock" | "mock-agent" | "mia-mock" => RuntimeProtocol::Mock,
        "codex" | "claude-code" => RuntimeProtocol::NativeAcp,
        "hermes" => RuntimeProtocol::HermesGateway,
        _ => RuntimeProtocol::Process,
    }
}

fn command_for_engine(engine: &str, env: &BTreeMap<String, String>) -> Option<RuntimeCommand> {
    match engine {
        "mock" | "mock-agent" | "mia-mock" => None,
        "codex" | "claude-code" => None,
        "hermes" => Some(RuntimeCommand {
            program: agent_engines::resolve_agent_command_path("hermes", env)
                .unwrap_or_else(|| "hermes".into()),
            args: hermes_gateway_args(&[]),
        }),
        other => Some(RuntimeCommand {
            program: other.to_string(),
            args: vec![],
        }),
    }
}

fn hermes_gateway_args(existing: &[String]) -> Vec<String> {
    let mut args = existing.to_vec();
    if args.iter().any(|arg| arg == "serve")
        && args.windows(2).any(|pair| pair == ["--host", "127.0.0.1"])
        && args.windows(2).any(|pair| pair == ["--port", "0"])
    {
        return args;
    }
    if args.last().is_some_and(|arg| arg == "acp") {
        args.pop();
    }
    if !args.iter().any(|arg| arg == "serve") {
        args.push("serve".into());
    }
    args.extend([
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        "0".into(),
    ]);
    args
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mia-core-runtime-{name}-{}",
            Uuid::now_v7().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_executable(path: &std::path::Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(path, permissions).unwrap();
        }
    }

    fn write_managed_acp(
        root: &std::path::Path,
        tool_id: &str,
        entrypoint_name: &str,
        version: &str,
        protocol: &str,
    ) -> std::path::PathBuf {
        let runtime_dir = root
            .join("acp")
            .join(tool_id)
            .join(version)
            .join("test-runtime");
        std::fs::create_dir_all(&runtime_dir).unwrap();
        let entrypoint = runtime_dir.join(entrypoint_name);
        write_executable(&entrypoint);
        let manifest = json!({
            "entrypoint": entrypoint_name,
            "version": version,
            "protocol": protocol,
            "args": ["--stdio"]
        });
        std::fs::write(
            runtime_dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        entrypoint
    }

    fn managed_runtime_env(
        resource_root: &std::path::Path,
        bin: &std::path::Path,
    ) -> BTreeMap<String, String> {
        let codex_path = bin.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        [
            (
                "MIA_MANAGED_AGENT_RESOURCES".to_string(),
                resource_root.to_string_lossy().to_string(),
            ),
            ("MIA_MANAGED_AGENT_RESOURCES_ONLY".to_string(), "1".into()),
            (
                "MIA_MANAGED_AGENT_RUNTIME_KEY".to_string(),
                "test-runtime".into(),
            ),
            ("PATH".to_string(), bin.to_string_lossy().to_string()),
            (
                "CODEX_PATH".to_string(),
                codex_path.to_string_lossy().to_string(),
            ),
            ("NO_COLOR".to_string(), "polluted".into()),
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn runtime_builder_produces_mock_turn_plan_inside_core() {
        let builder = RuntimeBuilder::new("/tmp/mia-workspace");
        let plan = builder.build_turn_plan(RuntimeTurnInput {
            conversation_id: "conv_1".into(),
            message_id: "msg_1".into(),
            bot_id: Some("bot_1".into()),
            memory_mode: MemoryMode::Native,
            engine: None,
            previous_session_key: None,
            workspace_dir: "".into(),
            provider: json!({ "kind": "mock" }),
            mcp_servers: json!({ "mcpServers": {} }),
            attachments: json!([]),
            selected_skill_ids: vec!["skill_a".into()],
            body: "hello".into(),
        });

        assert!(plan.turn_id.starts_with("turn_"));
        assert_eq!(plan.engine, "mock-agent");
        assert_eq!(plan.workspace_dir, "/tmp/mia-workspace");
        assert!(plan.command.is_none());
        assert_eq!(plan.runtime_session.session_key, "mock-agent:conv_1");
        assert_eq!(plan.runtime_session.resume_session_key, None);
        assert!(!plan.runtime_session.resumed);
        assert_eq!(
            plan.mock_response.as_deref(),
            Some("Mia Rust Core mock response: hello")
        );
        assert_eq!(plan.selected_skill_ids, vec!["skill_a"]);
    }

    #[test]
    fn persisted_runtime_plan_without_memory_mode_defaults_to_native() {
        let mut stored = serde_json::to_value(test_plan(shell_command("true"))).unwrap();
        stored.as_object_mut().unwrap().remove("memoryMode");

        let restored: RuntimeTurnPlan = serde_json::from_value(stored).unwrap();

        assert_eq!(restored.memory_mode, MemoryMode::Native);
    }

    #[test]
    fn runtime_builder_creates_aion_style_send_message_payload() {
        let builder = RuntimeBuilder::new("/tmp/mia-workspace");
        let plan = builder.build_turn_plan(RuntimeTurnInput {
            conversation_id: "conv_1".into(),
            message_id: "msg_1".into(),
            bot_id: Some("bot_1".into()),
            memory_mode: MemoryMode::Native,
            engine: None,
            previous_session_key: Some("session_existing".into()),
            workspace_dir: "".into(),
            provider: json!({}),
            mcp_servers: json!({}),
            attachments: json!([
                { "path": "/tmp/a.txt" },
                { "filePath": "/tmp/b.pdf" },
                { "localPath": "/tmp/c.png" },
                { "path": "" },
                { "url": "https://example.test/remote.txt" }
            ]),
            selected_skill_ids: vec![
                "skill_a".into(),
                " ".into(),
                "skill_a".into(),
                "skill_b".into(),
            ],
            body: "hello".into(),
        });

        assert_eq!(plan.send_message.content, "hello");
        assert_eq!(plan.send_message.msg_id, "msg_1");
        assert_eq!(
            plan.send_message.turn_id.as_deref(),
            Some(plan.turn_id.as_str())
        );
        assert_eq!(
            plan.send_message.files,
            vec!["/tmp/a.txt", "/tmp/b.pdf", "/tmp/c.png"]
        );
        assert_eq!(plan.send_message.inject_skills, vec!["skill_a", "skill_b"]);
        assert_eq!(plan.runtime_session.session_key, "session_existing");
        assert_eq!(
            plan.runtime_session.resume_session_key.as_deref(),
            Some("session_existing")
        );
        assert!(plan.runtime_session.resumed);
    }

    #[test]
    fn runtime_builder_sanitizes_cli_environment() {
        let env = clean_cli_environment([
            ("NODE_OPTIONS", "--inspect"),
            ("PATH", "/usr/bin"),
            ("CLAUDECODE", "1"),
        ]);

        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(env.get("NO_COLOR").map(String::as_str), Some("1"));
        assert_eq!(env.get("TERM").map(String::as_str), Some("dumb"));
        assert!(!env.contains_key("NODE_OPTIONS"));
        assert!(!env.contains_key("CLAUDECODE"));
    }

    #[test]
    fn runtime_builder_injects_resolved_codex_path_for_codex_acp() {
        let temp = std::env::temp_dir().join(format!(
            "mia-core-runtime-codex-path-{}",
            Uuid::now_v7().simple()
        ));
        let bin = temp.join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let codex_path = bin.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        std::fs::write(&codex_path, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&codex_path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&codex_path, permissions).unwrap();
        }

        let env = runtime_environment_for_engine(
            "codex",
            [
                ("HOME".to_string(), temp.to_string_lossy().to_string()),
                ("PATH".to_string(), String::new()),
            ],
        );

        assert_path_env_eq(env.get("CODEX_PATH"), &codex_path);

        let _ = std::fs::remove_dir_all(temp);
    }

    #[cfg(windows)]
    #[test]
    fn runtime_builder_uses_official_windows_hermes_launcher_path() {
        let root = test_dir("windows-hermes-path");
        let scripts = root
            .join("AppData")
            .join("Local")
            .join("hermes")
            .join("hermes-agent")
            .join("venv")
            .join("Scripts");
        let hermes = scripts.join("hermes.exe");
        write_executable(&hermes);

        let plan = RuntimeBuilder::new("/tmp/mia-workspace")
            .with_environment([
                ("USERPROFILE", root.to_string_lossy().to_string()),
                (
                    "LOCALAPPDATA",
                    root.join("AppData")
                        .join("Local")
                        .to_string_lossy()
                        .to_string(),
                ),
                (
                    "APPDATA",
                    root.join("AppData")
                        .join("Roaming")
                        .to_string_lossy()
                        .to_string(),
                ),
                ("PATH", String::new()),
            ])
            .build_turn_plan(RuntimeTurnInput {
                conversation_id: "conv_hermes".into(),
                message_id: "msg_hermes".into(),
                bot_id: None,
                memory_mode: MemoryMode::Native,
                engine: Some("hermes".into()),
                previous_session_key: None,
                workspace_dir: "".into(),
                provider: json!({}),
                mcp_servers: json!({}),
                attachments: json!([]),
                selected_skill_ids: vec![],
                body: "hello".into(),
            });

        let command = plan.command.expect("hermes command");
        assert!(
            command
                .program
                .eq_ignore_ascii_case(hermes.to_string_lossy().as_ref())
        );
        assert_eq!(
            command.args,
            vec!["serve", "--host", "127.0.0.1", "--port", "0"]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_builder_maps_acp_engines_and_hermes_gateway_specs() {
        let root = test_dir("managed-acp-plan");
        let bin = root.join("bin");
        let resources = root.join("managed-resources");
        let codex_cli = bin.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        let claude_cli = bin.join(if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        });
        write_executable(&codex_cli);
        write_executable(&claude_cli);
        let codex_acp = write_managed_acp(
            &resources,
            "codex-acp",
            "codex-acp",
            "1.1.4",
            "codex-app-server",
        );
        let claude_acp = write_managed_acp(
            &resources,
            "claude-agent-acp",
            "claude-agent-acp",
            "0.59.0",
            "claude-code-cli",
        );
        write_executable(
            &resources
                .join("acp")
                .join("claude-agent-acp")
                .join("0.59.0")
                .join("test-runtime")
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-agent-sdk-test-runtime")
                .join("claude"),
        );
        let builder = RuntimeBuilder::new("/tmp/mia-workspace")
            .with_environment(managed_runtime_env(&resources, &bin));
        let codex_plan = builder.build_turn_plan(RuntimeTurnInput {
            conversation_id: "conv_1".into(),
            message_id: "msg_1".into(),
            bot_id: None,
            memory_mode: MemoryMode::Native,
            engine: Some("codex".into()),
            previous_session_key: None,
            workspace_dir: "/tmp/custom".into(),
            provider: json!({}),
            mcp_servers: json!({}),
            attachments: json!([]),
            selected_skill_ids: vec![],
            body: "hello".into(),
        });

        assert_eq!(codex_plan.protocol, RuntimeProtocol::NativeAcp);
        let codex_command = codex_plan.command.as_ref().expect("codex ACP command");
        assert_eq!(codex_command.program, codex_acp.to_string_lossy());
        assert_eq!(codex_command.args, vec!["--stdio"]);
        assert_eq!(
            codex_plan.environment.get("CODEX_PATH").map(String::as_str),
            Some(codex_cli.to_string_lossy().as_ref())
        );
        assert!(
            !codex_command
                .args
                .iter()
                .any(|arg| arg == "exec" || arg == "--json")
        );
        assert_eq!(codex_plan.workspace_dir, "/tmp/custom");
        assert_eq!(codex_plan.mock_response, None);

        let claude_plan = builder.build_turn_plan(RuntimeTurnInput {
            conversation_id: "conv_2".into(),
            message_id: "msg_2".into(),
            bot_id: None,
            memory_mode: MemoryMode::Native,
            engine: Some("claude-code".into()),
            previous_session_key: None,
            workspace_dir: "".into(),
            provider: json!({}),
            mcp_servers: json!({}),
            attachments: json!([]),
            selected_skill_ids: vec![],
            body: "hello".into(),
        });
        assert_eq!(claude_plan.protocol, RuntimeProtocol::NativeAcp);
        let claude_command = claude_plan.command.as_ref().expect("claude ACP command");
        assert_eq!(claude_command.program, claude_acp.to_string_lossy());
        assert_eq!(claude_command.args, vec!["--stdio"]);
        assert_path_env_eq(
            claude_plan.environment.get("CLAUDE_CODE_EXECUTABLE"),
            &claude_cli,
        );
        assert!(
            !claude_command
                .args
                .iter()
                .any(|arg| { arg == "-p" || arg == "--output-format" || arg == "stream-json" })
        );

        let hermes_plan = builder.build_turn_plan(RuntimeTurnInput {
            conversation_id: "conv_3".into(),
            message_id: "msg_3".into(),
            bot_id: None,
            memory_mode: MemoryMode::Native,
            engine: Some("hermes".into()),
            previous_session_key: None,
            workspace_dir: "".into(),
            provider: json!({}),
            mcp_servers: json!({}),
            attachments: json!([]),
            selected_skill_ids: vec![],
            body: "hello".into(),
        });
        assert_eq!(hermes_plan.protocol, RuntimeProtocol::HermesGateway);
        let hermes_command = hermes_plan.command.expect("Hermes Gateway command");
        assert_eq!(hermes_command.program, "hermes");
        assert_eq!(
            hermes_command.args,
            vec!["serve", "--host", "127.0.0.1", "--port", "0"]
        );
        assert!(
            !hermes_command
                .args
                .iter()
                .any(|arg| { arg == "-z" || arg == "--oneshot" })
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_builder_does_not_fallback_when_managed_acp_is_missing() {
        let root = test_dir("missing-managed-acp-plan");
        let bin = root.join("bin");
        write_executable(&bin.join(if cfg!(windows) { "codex.exe" } else { "codex" }));
        let resources = root.join("empty-managed-resources");
        std::fs::create_dir_all(&resources).unwrap();
        let builder = RuntimeBuilder::new("/tmp/mia-workspace")
            .with_environment(managed_runtime_env(&resources, &bin));

        let plan = builder.build_turn_plan(RuntimeTurnInput {
            conversation_id: "conv_missing".into(),
            message_id: "msg_missing".into(),
            bot_id: None,
            memory_mode: MemoryMode::Native,
            engine: Some("codex".into()),
            previous_session_key: None,
            workspace_dir: "".into(),
            provider: json!({}),
            mcp_servers: json!({}),
            attachments: json!([]),
            selected_skill_ids: vec![],
            body: "hello".into(),
        });

        assert_eq!(plan.protocol, RuntimeProtocol::NativeAcp);
        assert_eq!(plan.command, None);
        assert_eq!(plan.mock_response, None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn runtime_executor_streams_stdout_stderr_and_finish_events() {
        let plan = test_plan(stdout_stderr_command("hello stdout\n", "hello stderr\n"));
        let executor = RuntimeExecutor;
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = {
            let events = events.clone();
            RuntimeEventSink::new(move |event| events.lock().unwrap().push(event))
        };

        let result = executor.execute_plan(plan, sink, None).await.unwrap();
        let events = events.lock().unwrap();

        assert_eq!(result.exit_code, Some(0));
        assert!(!result.cancelled);
        assert_eq!(result.stdout, "hello stdout\n");
        assert_eq!(result.stderr, "hello stderr\n");
        assert!(
            events
                .iter()
                .any(|event| event.name == EVENT_RUNTIME_STARTED)
        );
        assert!(events.iter().any(|event| {
            event.name == EVENT_RUNTIME_STDOUT && event.data["text"] == "hello stdout\n"
        }));
        assert!(events.iter().any(|event| {
            event.name == EVENT_RUNTIME_STDERR && event.data["text"] == "hello stderr\n"
        }));
        assert!(events.iter().any(|event| {
            event.name == EVENT_RUNTIME_FINISHED
                && event.data["exitCode"] == 0
                && event.data["cancelled"] == false
        }));
    }

    #[tokio::test]
    async fn runtime_executor_sends_turn_body_to_command_stdin() {
        let builder = RuntimeBuilder::new(".");
        let plan = builder
            .with_engine_command("stdin-agent", stdin_echo_command())
            .build_turn_plan(RuntimeTurnInput {
                conversation_id: "conv_stdin".into(),
                message_id: "msg_stdin".into(),
                bot_id: Some("bot_stdin".into()),
                memory_mode: MemoryMode::Native,
                engine: Some("stdin-agent".into()),
                previous_session_key: None,
                workspace_dir: ".".into(),
                provider: json!({}),
                mcp_servers: json!({}),
                attachments: json!([]),
                selected_skill_ids: vec![],
                body: "hello from core turn\n".into(),
            });
        let result = RuntimeExecutor
            .execute_plan(plan, RuntimeEventSink::default(), None)
            .await
            .unwrap();

        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "hello from core turn\n");
    }

    #[tokio::test]
    async fn runtime_executor_uses_aion_send_message_content_as_process_input() {
        let mut plan = test_plan(stdin_echo_command());
        plan.send_message.content = "hello from send message\n".into();

        let result = RuntimeExecutor
            .execute_plan(plan, RuntimeEventSink::default(), None)
            .await
            .unwrap();

        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "hello from send message\n");
    }

    #[tokio::test]
    async fn runtime_session_manager_sends_runtime_plan_via_send_message_boundary() {
        let mut plan = test_plan(stdin_echo_command());
        plan.send_message.content = "hello through session manager\n".into();

        let result = RuntimeSessionManager::default()
            .send_message(plan, RuntimeEventSink::default(), None)
            .await
            .unwrap();

        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "hello through session manager\n");
    }

    #[tokio::test]
    async fn runtime_session_manager_rejects_native_acp_without_backend_instead_of_executor_fallback()
     {
        let mut plan = test_plan(shell_command("printf 'executor fallback used\\n'"));
        plan.engine = "codex".into();
        plan.protocol = RuntimeProtocol::NativeAcp;
        plan.send_message.content = "hello native acp".into();

        let result = RuntimeSessionManager::new_without_native_acp_for_tests()
            .send_message(plan, RuntimeEventSink::default(), None)
            .await
            .unwrap_err();

        assert!(
            result
                .to_string()
                .contains("native ACP runtime is unavailable")
        );
    }

    #[test]
    fn runtime_session_manager_can_construct_native_acp_manager_for_app_services() {
        let manager = RuntimeSessionManager::native_acp();

        assert!(format!("{manager:?}").contains("RuntimeSessionManager"));
    }

    #[tokio::test]
    async fn runtime_session_manager_dispatches_native_acp_to_backend() {
        struct RecordingBackend;

        #[async_trait::async_trait]
        impl NativeAcpBackend for RecordingBackend {
            async fn send_message(
                &self,
                plan: RuntimeTurnPlan,
                sink: RuntimeEventSink,
                _cancellation: Option<RuntimeCancellation>,
            ) -> anyhow::Result<RuntimeExecutionResult> {
                sink.emit(
                    EVENT_RUNTIME_STDOUT,
                    json!({
                        "turnId": plan.turn_id,
                        "conversationId": plan.conversation_id,
                        "engine": plan.engine,
                        "text": "native delta",
                    }),
                );
                Ok(RuntimeExecutionResult {
                    exit_code: Some(0),
                    cancelled: false,
                    stdout: "native final".into(),
                    stderr: String::new(),
                })
            }
        }

        let mut plan = test_plan(shell_command("printf 'executor fallback used\\n'"));
        plan.protocol = RuntimeProtocol::NativeAcp;
        plan.engine = "codex".into();
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = {
            let events = events.clone();
            RuntimeEventSink::new(move |event| events.lock().unwrap().push(event))
        };

        let result = RuntimeSessionManager::new(NativeAcpSessionManager::with_backend_for_tests(
            std::sync::Arc::new(RecordingBackend),
        ))
        .send_message(plan, sink, None)
        .await
        .unwrap();

        assert_eq!(result.stdout, "native final");
        assert!(events.lock().unwrap().iter().any(|event| {
            event.name == EVENT_RUNTIME_STDOUT && event.data["text"] == "native delta"
        }));
    }

    #[tokio::test]
    async fn runtime_session_manager_prepares_and_reads_native_acp_controls() {
        struct ControlBackend;

        #[async_trait::async_trait]
        impl NativeAcpBackend for ControlBackend {
            async fn send_message(
                &self,
                _plan: RuntimeTurnPlan,
                _sink: RuntimeEventSink,
                _cancellation: Option<RuntimeCancellation>,
            ) -> anyhow::Result<RuntimeExecutionResult> {
                unreachable!("prepare must not send a prompt")
            }

            async fn prepare_session(
                &self,
                plan: RuntimeTurnPlan,
            ) -> anyhow::Result<mia_core_api_types::AcpRuntimeControlSnapshot> {
                Ok(mia_core_api_types::AcpRuntimeControlSnapshot {
                    conversation_id: plan.conversation_id,
                    engine: plan.engine,
                    memory_mode: String::new(),
                    session_id: Some("session-controls".into()),
                    state: "ready".into(),
                    controls: vec![],
                    error: String::new(),
                })
            }
        }

        let mut plan = test_plan(shell_command("printf 'must not execute'"));
        plan.protocol = RuntimeProtocol::NativeAcp;
        plan.engine = "claude-code".into();
        let manager = RuntimeSessionManager::new(NativeAcpSessionManager::with_backend_for_tests(
            std::sync::Arc::new(ControlBackend),
        ));

        let snapshot = manager.prepare_session(plan).await.unwrap();

        assert_eq!(snapshot.session_id.as_deref(), Some("session-controls"));
        assert_eq!(snapshot.engine, "claude-code");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runtime_executor_does_not_pass_codex_prompt_as_argument() {
        let mut plan = test_plan(shell_command(
            "printf 'arg0:%s\\n' \"$0\"; printf 'stdin:'; cat",
        ));
        plan.engine = "codex".into();
        plan.send_message.content = "hello codex".into();

        let result = RuntimeExecutor
            .execute_plan(plan, RuntimeEventSink::default(), None)
            .await
            .unwrap();

        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "arg0:sh\nstdin:hello codex");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runtime_executor_does_not_add_codex_model_argument() {
        let mut plan = test_plan(shell_command(
            "printf 'args:%s|%s|%s\\n' \"$0\" \"$1\" \"$2\"; printf 'stdin:'; cat",
        ));
        plan.engine = "codex".into();
        plan.provider = json!({ "model": "gpt-5-codex" });
        plan.send_message.content = "hello codex".into();

        let result = RuntimeExecutor
            .execute_plan(plan, RuntimeEventSink::default(), None)
            .await
            .unwrap();

        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "args:sh||\nstdin:hello codex");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runtime_executor_does_not_emit_codex_stdin_status_noise() {
        let mut plan = test_plan(shell_command(
            "printf 'Reading additional input from stdin...\\n'; printf '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hi\"}}\\n'",
        ));
        plan.engine = "codex".into();
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = {
            let events = events.clone();
            RuntimeEventSink::new(move |event| events.lock().unwrap().push(event))
        };

        let result = RuntimeExecutor
            .execute_plan(plan, sink, None)
            .await
            .unwrap();
        let events = events.lock().unwrap();

        assert!(
            result
                .stdout
                .contains("Reading additional input from stdin...")
        );
        assert!(!events.iter().any(|event| {
            event.name == EVENT_RUNTIME_STDOUT
                && event.data["text"] == "Reading additional input from stdin...\n"
        }));
        assert!(events.iter().any(|event| {
            event.name == EVENT_RUNTIME_STDOUT
                && event.data["text"]
                    == "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hi\"}}\n"
        }));
    }

    #[tokio::test]
    async fn runtime_executor_cancels_running_process_and_emits_cancelled_finish() {
        let cancellation = RuntimeCancellation::new();
        let cancel_on_first_line = cancellation.clone();
        let plan = test_plan(delayed_output_command(
            "started\n",
            "should-not-finish\n",
            5,
        ));
        let executor = RuntimeExecutor;
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = {
            let events = events.clone();
            RuntimeEventSink::new(move |event| {
                if event.name == EVENT_RUNTIME_STDOUT && event.data["text"] == "started\n" {
                    cancel_on_first_line.cancel();
                }
                events.lock().unwrap().push(event);
            })
        };

        let result = executor
            .execute_plan(plan, sink, Some(cancellation))
            .await
            .unwrap();
        let events = events.lock().unwrap();

        assert!(result.cancelled);
        assert!(!result.stdout.contains("should-not-finish"));
        assert!(events.iter().any(|event| {
            event.name == EVENT_RUNTIME_FINISHED && event.data["cancelled"] == true
        }));
    }

    fn test_plan(command: RuntimeCommand) -> RuntimeTurnPlan {
        RuntimeTurnPlan {
            turn_id: "turn_test".into(),
            conversation_id: "conv_test".into(),
            bot_id: Some("bot_test".into()),
            memory_mode: MemoryMode::Native,
            engine: "test-stream".into(),
            workspace_dir: ".".into(),
            protocol: RuntimeProtocol::Process,
            command: Some(command),
            environment: clean_cli_environment(std::env::vars()),
            provider: json!({}),
            mcp_servers: json!({}),
            selected_skill_ids: vec![],
            runtime_session: RuntimeSessionState {
                conversation_id: "conv_test".into(),
                engine: "test-stream".into(),
                session_key: "test-stream:conv_test".into(),
                resume_session_key: None,
                resumed: false,
            },
            send_message: RuntimeSendMessage {
                content: String::new(),
                msg_id: "msg_test".into(),
                turn_id: Some("turn_test".into()),
                files: vec![],
                inject_skills: vec![],
            },
            mock_response: None,
        }
    }

    #[cfg(unix)]
    fn shell_command(script: &str) -> RuntimeCommand {
        RuntimeCommand {
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
        }
    }

    #[cfg(windows)]
    fn shell_command(script: &str) -> RuntimeCommand {
        RuntimeCommand {
            program: "cmd".into(),
            args: vec!["/C".into(), script.into()],
        }
    }

    fn assert_path_env_eq(actual: Option<&String>, expected: &std::path::Path) {
        let Some(actual) = actual else {
            panic!("expected path env to be present");
        };
        let expected = expected.to_string_lossy();
        if cfg!(windows) {
            assert!(
                actual.eq_ignore_ascii_case(expected.as_ref()),
                "left: {actual:?}, right: {expected:?}"
            );
        } else {
            assert_eq!(actual, expected.as_ref());
        }
    }

    #[cfg(unix)]
    fn stdin_echo_command() -> RuntimeCommand {
        shell_command("cat")
    }

    #[cfg(windows)]
    fn stdin_echo_command() -> RuntimeCommand {
        powershell_command(r#"$text = [Console]::In.ReadToEnd(); [Console]::Out.Write($text)"#)
    }

    #[cfg(unix)]
    fn stdout_stderr_command(stdout: &str, stderr: &str) -> RuntimeCommand {
        shell_command(&format!(
            "printf '%s' {}; printf '%s' {} >&2",
            sh_quote(stdout),
            sh_quote(stderr)
        ))
    }

    #[cfg(windows)]
    fn stdout_stderr_command(stdout: &str, stderr: &str) -> RuntimeCommand {
        powershell_command(&format!(
            "[Console]::Out.Write({}); [Console]::Error.Write({})",
            ps_quote(stdout),
            ps_quote(stderr)
        ))
    }

    #[cfg(unix)]
    fn delayed_output_command(first: &str, second: &str, seconds: u64) -> RuntimeCommand {
        shell_command(&format!(
            "printf '%s' {}; sleep {}; printf '%s' {}",
            sh_quote(first),
            seconds,
            sh_quote(second)
        ))
    }

    #[cfg(windows)]
    fn delayed_output_command(first: &str, second: &str, seconds: u64) -> RuntimeCommand {
        powershell_command(&format!(
            "[Console]::Out.Write({}); [Console]::Out.Flush(); Start-Sleep -Seconds {}; [Console]::Out.Write({})",
            ps_quote(first),
            seconds,
            ps_quote(second)
        ))
    }

    #[cfg(unix)]
    fn sh_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    #[cfg(windows)]
    fn powershell_command(script: &str) -> RuntimeCommand {
        RuntimeCommand {
            program: "powershell.exe".into(),
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-Command".into(),
                format!(
                    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); {script}"
                ),
            ],
        }
    }

    #[cfg(windows)]
    fn ps_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }
}
