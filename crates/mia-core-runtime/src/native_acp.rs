use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use agent_client_protocol::schema::{
    CancelNotification, ContentBlock, Implementation, InitializeRequest, NewSessionRequest,
    PromptRequest, ProtocolVersion, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SessionId, SessionNotification, SessionUpdate, TextContent,
};
use agent_client_protocol::{
    Agent, ByteStreams, Client, ConnectionTo, JsonRpcRequest, on_receive_notification,
    on_receive_request,
};
use anyhow::{Context, Result, anyhow, bail};
use async_trait::async_trait;
use dashmap::DashMap;
use serde_json::{Value, json};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::{
    EVENT_RUNTIME_FINISHED, EVENT_RUNTIME_STARTED, RuntimeCancellation, RuntimeEventSink,
    RuntimeExecutionResult, RuntimeProcessEvent, RuntimeTurnPlan,
};

const ACP_INIT_TIMEOUT: Duration = Duration::from_secs(30);
const ACP_CLIENT_NAME: &str = "Mia";
const ACP_CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

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
}

#[derive(Debug, Default)]
pub struct RealNativeAcpBackend {
    tasks: DashMap<String, Arc<Mutex<NativeAcpTask>>>,
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

        let task = Arc::new(Mutex::new(NativeAcpTask::spawn(plan).await?));
        let entry = self.tasks.entry(key.to_string()).or_insert(task);
        Ok(entry.clone())
    }
}

fn native_acp_task_key(plan: &RuntimeTurnPlan) -> String {
    format!(
        "{}:{}:{}",
        plan.engine,
        plan.conversation_id,
        absolute_workspace_dir_lossy(&plan.workspace_dir)
    )
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

#[derive(Debug)]
struct NativeAcpTask {
    protocol: AcpProtocol,
    _child: Child,
    session_id: Option<SessionId>,
    workspace_dir: PathBuf,
}

impl NativeAcpTask {
    async fn spawn(plan: &RuntimeTurnPlan) -> Result<Self> {
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
            .stderr(Stdio::null())
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
        let protocol = AcpProtocol::connect(stdin, stdout).await?;

        Ok(Self {
            protocol,
            _child: child,
            session_id: None,
            workspace_dir,
        })
    }

    async fn run_turn(
        &mut self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult> {
        let session_id = self.ensure_session().await?;
        let session_key = session_id.to_string();
        let accumulated_text = Arc::new(StdMutex::new(String::new()));
        self.protocol.set_active_turn(Some(ActiveTurnContext {
            turn_id: plan.turn_id.clone(),
            conversation_id: plan.conversation_id.clone(),
            engine: plan.engine.clone(),
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
                result = &mut prompt => result,
                _ = cancellation.cancelled() => {
                    cancelled = true;
                    self.protocol.cancel(session_id.clone());
                    Ok(())
                }
            }
        } else {
            prompt.await
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

        if let Err(error) = prompt_result {
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

    async fn ensure_session(&mut self) -> Result<SessionId> {
        if let Some(session_id) = &self.session_id {
            return Ok(session_id.clone());
        }
        let response = self
            .protocol
            .new_session(self.workspace_dir.clone())
            .await?;
        let session_id = response.session_id;
        self.session_id = Some(session_id.clone());
        Ok(session_id)
    }
}

#[derive(Debug)]
struct AcpProtocol {
    connection: ConnectionTo<Agent>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    alive: Arc<AtomicBool>,
    active_turn: SharedActiveTurn,
}

type SharedActiveTurn = Arc<StdMutex<Option<ActiveTurnContext>>>;

#[derive(Clone, Debug)]
struct ActiveTurnContext {
    turn_id: String,
    conversation_id: String,
    engine: String,
    sink: RuntimeEventSink,
    accumulated_text: Arc<StdMutex<String>>,
}

impl AcpProtocol {
    async fn connect(stdin: ChildStdin, stdout: ChildStdout) -> Result<Self> {
        let alive = Arc::new(AtomicBool::new(true));
        let active_turn = Arc::new(StdMutex::new(None));
        let (init_tx, init_rx) = oneshot::channel::<Result<(), String>>();
        let (ready_tx, ready_rx) = oneshot::channel::<ConnectionTo<Agent>>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        tokio::spawn(run_sdk_background(
            stdin,
            stdout,
            active_turn.clone(),
            init_tx,
            ready_tx,
            shutdown_rx,
            alive.clone(),
        ));

        tokio::time::timeout(ACP_INIT_TIMEOUT, init_rx)
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
        })
    }

    fn set_active_turn(&self, active: Option<ActiveTurnContext>) {
        *self.active_turn.lock().unwrap() = active;
    }

    fn is_connected(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    async fn new_session(
        &self,
        cwd: PathBuf,
    ) -> Result<agent_client_protocol::schema::NewSessionResponse> {
        self.send_request(NewSessionRequest::new(cwd)).await
    }

    async fn prompt(&self, session_id: SessionId, content: String) -> Result<()> {
        let request = PromptRequest::new(
            session_id,
            vec![ContentBlock::Text(TextContent::new(content))],
        );
        let _response: agent_client_protocol::schema::PromptResponse =
            self.send_request(request).await?;
        Ok(())
    }

    fn cancel(&self, session_id: SessionId) {
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
    init_tx: oneshot::Sender<Result<(), String>>,
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
                async move |notification: SessionNotification, _cx: ConnectionTo<Agent>| {
                    handle_session_notification(notification, &active_turn);
                    Ok(())
                }
            },
            on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let _ = request;
                let _ = responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ));
                Ok(())
            },
            on_receive_request!(),
        )
        .connect_with(transport, async move |connection: ConnectionTo<Agent>| {
            let initialize = InitializeRequest::new(ProtocolVersion::LATEST)
                .client_info(Implementation::new(ACP_CLIENT_NAME, ACP_CLIENT_VERSION));
            match connection.send_request(initialize).block_task().await {
                Ok(_response) => {
                    if let Some(tx) = init_tx.take() {
                        let _ = tx.send(Ok(()));
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
    use agent_client_protocol::schema::{
        ContentBlock, ContentChunk, SessionNotification, SessionUpdate, TextContent,
    };

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

    #[test]
    fn native_acp_session_manager_can_construct_real_backend() {
        let manager = NativeAcpSessionManager::real();

        assert!(format!("{manager:?}").contains("NativeAcpSessionManager"));
    }
}
