use std::collections::BTreeMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use async_trait::async_trait;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use mia_core_api_types::{
    AgentPermissionListResponse, AgentPermissionPendingRequest, AgentPermissionRespondRequest,
    AgentPermissionRespondResponse, AgentPermissionRule, MemoryMode, RuntimeControl,
    RuntimeControlChoice, RuntimeControlSnapshot,
};
use mia_core_common::process::configure_background_command;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, Notify, broadcast, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use uuid::Uuid;

use crate::{
    EVENT_RUNTIME_FINISHED, EVENT_RUNTIME_STARTED, EVENT_RUNTIME_STDOUT, RuntimeCancellation,
    RuntimeCommand, RuntimeEventSink, RuntimeExecutionResult, RuntimeInitialPromptProvider,
    RuntimeProtocol, RuntimeSendMessage, RuntimeSessionState, RuntimeTurnPlan,
};

const HERMES_STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const HERMES_GATEWAY_READY_TIMEOUT: Duration = Duration::from_secs(20);
const HERMES_AGENT_READY_TIMEOUT: Duration = Duration::from_secs(120);
const HERMES_RPC_TIMEOUT: Duration = Duration::from_secs(120);
const HERMES_STDERR_TAIL_LIMIT: usize = 16 * 1024;

pub(crate) async fn probe_hermes_gateway_command(
    mut command: RuntimeCommand,
    environment: BTreeMap<String, String>,
    workspace_dir: PathBuf,
    timeout: Duration,
) -> Result<RuntimeControlSnapshot> {
    command.args = crate::hermes_gateway_args(&command.args);
    let conversation_id = format!("hermes-probe-{}", Uuid::now_v7().simple());
    let plan = RuntimeTurnPlan {
        turn_id: format!("turn-{conversation_id}"),
        conversation_id: conversation_id.clone(),
        bot_id: None,
        memory_mode: MemoryMode::Native,
        engine: "hermes".into(),
        workspace_dir: workspace_dir.to_string_lossy().to_string(),
        protocol: RuntimeProtocol::HermesGateway,
        command: Some(command),
        environment,
        provider: Value::Null,
        mcp_servers: Value::Null,
        selected_skill_ids: Vec::new(),
        runtime_session: RuntimeSessionState {
            conversation_id: conversation_id.clone(),
            engine: "hermes".into(),
            session_key: conversation_id.clone(),
            resume_session_key: None,
            resumed: false,
        },
        send_message: RuntimeSendMessage {
            content: String::new(),
            msg_id: format!("message-{conversation_id}"),
            turn_id: None,
            files: Vec::new(),
            inject_skills: Vec::new(),
        },
        mock_response: None,
    };
    tokio::time::timeout(timeout, async {
        let mut task = HermesGatewayTask::spawn(&plan, None).await?;
        task.ensure_session_created(&plan, false).await?;
        Ok(task.control_snapshot(&plan))
    })
    .await
    .map_err(|_| {
        anyhow!(
            "Hermes Gateway probe timed out after {}s",
            timeout.as_secs()
        )
    })?
}

#[async_trait]
pub trait HermesGatewayBackend: Send + Sync {
    async fn send_message(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult>;

    async fn prepare_session(&self, _plan: RuntimeTurnPlan) -> Result<RuntimeControlSnapshot> {
        bail!("Hermes Gateway runtime does not expose session controls")
    }

    async fn set_control(
        &self,
        _plan: RuntimeTurnPlan,
        _control_id: String,
        _value: String,
    ) -> Result<RuntimeControlSnapshot> {
        bail!("Hermes Gateway runtime does not expose session controls")
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
pub struct HermesGatewaySessionManager {
    backend: Arc<dyn HermesGatewayBackend>,
}

impl std::fmt::Debug for HermesGatewaySessionManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HermesGatewaySessionManager")
            .finish_non_exhaustive()
    }
}

impl HermesGatewaySessionManager {
    pub fn real() -> Self {
        Self {
            backend: Arc::new(RealHermesGatewayBackend::default()),
        }
    }

    pub fn real_with_initial_prompt_provider(
        provider: Arc<dyn RuntimeInitialPromptProvider>,
    ) -> Self {
        Self {
            backend: Arc::new(RealHermesGatewayBackend::with_initial_prompt_provider(
                provider,
            )),
        }
    }

    pub fn unavailable() -> Self {
        Self {
            backend: Arc::new(UnavailableHermesGatewayBackend),
        }
    }

    pub fn with_backend_for_tests(backend: Arc<dyn HermesGatewayBackend>) -> Self {
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

    pub async fn prepare_session(&self, plan: RuntimeTurnPlan) -> Result<RuntimeControlSnapshot> {
        self.backend.prepare_session(plan).await
    }

    pub async fn set_control(
        &self,
        plan: RuntimeTurnPlan,
        control_id: String,
        value: String,
    ) -> Result<RuntimeControlSnapshot> {
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

struct UnavailableHermesGatewayBackend;

#[async_trait]
impl HermesGatewayBackend for UnavailableHermesGatewayBackend {
    async fn send_message(
        &self,
        _plan: RuntimeTurnPlan,
        _sink: RuntimeEventSink,
        _cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult> {
        bail!("Hermes Gateway runtime is unavailable")
    }
}

#[derive(Default)]
struct RealHermesGatewayBackend {
    tasks: DashMap<String, Arc<Mutex<HermesGatewayTask>>>,
    permissions: HermesGatewayPermissionBroker,
    initial_prompt_provider: Option<Arc<dyn RuntimeInitialPromptProvider>>,
}

impl RealHermesGatewayBackend {
    fn with_initial_prompt_provider(provider: Arc<dyn RuntimeInitialPromptProvider>) -> Self {
        Self {
            initial_prompt_provider: Some(provider),
            ..Self::default()
        }
    }

    async fn task_for_plan(&self, plan: &RuntimeTurnPlan) -> Result<Arc<Mutex<HermesGatewayTask>>> {
        let key = hermes_gateway_task_key(plan);
        if let Some(task) = self.tasks.get(&key) {
            let task = task.value().clone();
            if task.lock().await.process.is_connected().await {
                return Ok(task);
            }
            self.tasks.remove(&key);
        }

        let logical_key = hermes_gateway_logical_task_key(plan);
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
            HermesGatewayTask::spawn(plan, self.initial_prompt_provider.clone()).await?,
        ));
        let entry = self.tasks.entry(key).or_insert(task);
        Ok(entry.clone())
    }

    async fn send_message_inner(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult> {
        let key = hermes_gateway_task_key(&plan);
        let mut task = self.task_for_plan(&plan).await?;
        if !task.lock().await.process.is_connected().await {
            self.tasks.remove(&key);
            task = self.task_for_plan(&plan).await?;
        }
        let mut task = task.lock().await;
        let result = task
            .run_turn(plan, sink, cancellation, &self.permissions)
            .await;
        if result.is_err()
            && let Some(stored_session_id) = task.stored_session_id.as_deref()
        {
            self.permissions.cancel_session(stored_session_id);
        }
        result
    }
}

#[async_trait]
impl HermesGatewayBackend for RealHermesGatewayBackend {
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
                "protocol": "hermesGateway",
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

    async fn prepare_session(&self, plan: RuntimeTurnPlan) -> Result<RuntimeControlSnapshot> {
        let task = self.task_for_plan(&plan).await?;
        let mut task = task.lock().await;
        // The official Gateway returns lazy session.create/session.resume
        // snapshots immediately and warms the agent in the background. Runtime
        // controls only need that snapshot; waiting for session.info here turns
        // the lazy API back into a blocking composer load.
        task.ensure_session_created(&plan, false).await?;
        Ok(task.control_snapshot(&plan))
    }

    async fn set_control(
        &self,
        plan: RuntimeTurnPlan,
        control_id: String,
        value: String,
    ) -> Result<RuntimeControlSnapshot> {
        let task = self.task_for_plan(&plan).await?;
        let mut task = task.lock().await;
        task.ensure_session(&plan).await?;
        task.set_control(&plan, &control_id, &value).await?;
        Ok(task.control_snapshot(&plan))
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

struct HermesGatewayTask {
    process: HermesGatewayProcess,
    runtime_session_id: Option<String>,
    stored_session_id: Option<String>,
    session_info: Value,
    approval_mode: String,
    session_yolo: bool,
    agent_ready: bool,
    pending_initial_prompt: Option<String>,
}

impl HermesGatewayTask {
    async fn spawn(
        plan: &RuntimeTurnPlan,
        initial_prompt_provider: Option<Arc<dyn RuntimeInitialPromptProvider>>,
    ) -> Result<Self> {
        let process = HermesGatewayProcess::spawn(plan).await?;
        let pending_initial_prompt = if plan.memory_mode == MemoryMode::Mia {
            match initial_prompt_provider.as_ref() {
                Some(provider) => {
                    let prompt = provider.initial_prompt(plan).await?;
                    (!prompt.trim().is_empty()).then_some(prompt)
                }
                None => None,
            }
        } else {
            None
        };
        Ok(Self {
            process,
            runtime_session_id: None,
            stored_session_id: None,
            session_info: Value::Null,
            approval_mode: desired_permission_mode(plan)
                .as_deref()
                .and_then(normalize_hermes_approval_mode)
                .unwrap_or("smart")
                .into(),
            session_yolo: false,
            agent_ready: false,
            pending_initial_prompt,
        })
    }

    async fn ensure_session(&mut self, plan: &RuntimeTurnPlan) -> Result<()> {
        self.ensure_session_created(plan, true).await
    }

    async fn ensure_session_created(
        &mut self,
        plan: &RuntimeTurnPlan,
        wait_for_agent: bool,
    ) -> Result<()> {
        if self.runtime_session_id.is_some()
            && (!wait_for_agent || self.agent_ready)
            && self.process.is_connected().await
        {
            return Ok(());
        }

        let mut events = self.process.rpc.subscribe();
        if self.runtime_session_id.is_some() && self.process.is_connected().await {
            return self.wait_for_agent_ready(&mut events).await;
        }

        let requested_resume = plan
            .runtime_session
            .resume_session_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(stored_session_id) = requested_resume {
            let refreshes_platform_runtime = uses_mia_platform_proxy(plan);
            match self
                .process
                .rpc
                .request(
                    "session.resume",
                    json!({
                        "session_id": stored_session_id,
                        "source": "mia-desktop",
                        "close_on_disconnect": false,
                        "lazy": refreshes_platform_runtime,
                    }),
                )
                .await
            {
                Ok(result) => {
                    self.apply_session_result(result, Some(stored_session_id.to_string()))?;
                    self.pending_initial_prompt = None;
                    if refreshes_platform_runtime {
                        self.recreate_platform_session(plan, stored_session_id)
                            .await?;
                    } else {
                        self.refresh_approval_mode(plan).await;
                    }
                    if wait_for_agent {
                        self.wait_for_agent_ready(&mut events).await?;
                    }
                    return Ok(());
                }
                Err(error) if is_stale_session_error(&error) => {}
                Err(error) => return Err(error.context("resume Hermes Gateway session")),
            }
        }

        self.create_session(plan, None, None).await?;
        if wait_for_agent {
            self.wait_for_agent_ready(&mut events).await?;
        }
        Ok(())
    }

    async fn create_session(
        &mut self,
        plan: &RuntimeTurnPlan,
        messages: Option<Vec<Value>>,
        parent_session_id: Option<&str>,
    ) -> Result<()> {
        let mut params = Map::new();
        params.insert(
            "cwd".into(),
            Value::String(absolute_workspace_dir_lossy(&plan.workspace_dir)),
        );
        params.insert("source".into(), Value::String("mia-desktop".into()));
        params.insert("close_on_disconnect".into(), Value::Bool(false));
        if let Some(model) = native_model_from_plan(plan) {
            params.insert("model".into(), Value::String(model));
        }
        if let Some(provider) = native_provider_from_plan(plan) {
            params.insert("provider".into(), Value::String(provider));
        }
        if let Some(effort) = desired_reasoning_effort(plan)
            .as_deref()
            .and_then(normalize_hermes_reasoning_effort)
        {
            params.insert("reasoning_effort".into(), Value::String(effort.into()));
        }
        if let Some(messages) = messages {
            params.insert("messages".into(), Value::Array(messages));
        }
        if let Some(parent_session_id) = parent_session_id {
            params.insert(
                "parent_session_id".into(),
                Value::String(parent_session_id.into()),
            );
        }
        let result = self
            .process
            .rpc
            .request("session.create", Value::Object(params))
            .await
            .context("create Hermes Gateway session")?;
        self.apply_session_result(result, None)?;
        self.refresh_approval_mode(plan).await;
        Ok(())
    }

    async fn recreate_platform_session(
        &mut self,
        plan: &RuntimeTurnPlan,
        resumed_session_id: &str,
    ) -> Result<()> {
        let runtime_session_id = self
            .runtime_session_id
            .clone()
            .ok_or_else(|| anyhow!("Hermes Gateway resumed session is missing"))?;
        let history_result = self
            .process
            .rpc
            .request(
                "session.history",
                json!({"session_id": runtime_session_id.clone()}),
            )
            .await;
        if let Err(error) = self
            .process
            .rpc
            .request("session.close", json!({"session_id": runtime_session_id}))
            .await
        {
            tracing::debug!(error = %error, "close temporary Hermes resume session failed");
        }
        let history_result = history_result.context("read Hermes Gateway resume history")?;
        let messages = history_result
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| anyhow!("Hermes Gateway session history did not include messages"))?;

        // Hermes correctly restores a session's persisted provider identity,
        // but Mia's account proxy uses a new loopback URL on every Core start.
        // Rehydrate the transcript into a continuation session so the agent
        // resolves the current proxy config instead of the expired URL.
        self.runtime_session_id = None;
        self.stored_session_id = None;
        self.session_info = Value::Null;
        self.agent_ready = false;
        self.create_session(plan, Some(messages), Some(resumed_session_id))
            .await
            .context("recreate Hermes session with current Mia platform proxy")
    }

    fn apply_session_result(&mut self, result: Value, resumed: Option<String>) -> Result<()> {
        let runtime_session_id = value_string(&result, &["session_id", "sessionId"])
            .ok_or_else(|| anyhow!("Hermes Gateway session response did not include session_id"))?;
        let stored_session_id = value_string(
            &result,
            &[
                "stored_session_id",
                "storedSessionId",
                "session_key",
                "sessionKey",
                "resumed",
            ],
        )
        .or(resumed)
        .unwrap_or_else(|| runtime_session_id.clone());
        self.runtime_session_id = Some(runtime_session_id);
        self.stored_session_id = Some(stored_session_id);
        self.session_info = result.get("info").cloned().unwrap_or(Value::Null);
        if let Some(mode) = value_string(
            &self.session_info,
            &[
                "approval_mode",
                "approvalMode",
                "permission_mode",
                "permissionMode",
            ],
        )
        .as_deref()
        .and_then(normalize_hermes_approval_mode)
        {
            self.approval_mode = mode.into();
        }
        self.agent_ready = !self
            .session_info
            .get("lazy")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(())
    }

    async fn refresh_approval_mode(&mut self, plan: &RuntimeTurnPlan) {
        if let Some(mode) = value_string(
            &self.session_info,
            &[
                "approval_mode",
                "approvalMode",
                "permission_mode",
                "permissionMode",
            ],
        )
        .as_deref()
        .and_then(normalize_hermes_approval_mode)
        {
            self.approval_mode = mode.into();
            return;
        }
        if let Ok(result) = self
            .process
            .rpc
            .request("config.get", json!({"key": "approvals.mode"}))
            .await
            && let Some(mode) = value_string(&result, &["value"])
                .as_deref()
                .and_then(normalize_hermes_approval_mode)
        {
            self.approval_mode = mode.into();
            return;
        }
        if let Some(mode) = approval_mode_from_plan_config(plan).await {
            self.approval_mode = mode;
        }
    }

    async fn wait_for_agent_ready(
        &mut self,
        events: &mut broadcast::Receiver<GatewayEvent>,
    ) -> Result<()> {
        if self.agent_ready {
            return Ok(());
        }
        let runtime_session_id = self
            .runtime_session_id
            .clone()
            .ok_or_else(|| anyhow!("Hermes Gateway runtime session is missing"))?;
        match self
            .process
            .rpc
            .request(
                "session.activate",
                json!({"session_id": runtime_session_id.clone()}),
            )
            .await
        {
            Ok(result) => {
                self.apply_session_result(result, None)?;
                if self.agent_ready {
                    return Ok(());
                }
            }
            Err(error) => {
                tracing::debug!(error = %error, "refresh Hermes agent readiness failed");
            }
        }
        tokio::time::timeout(HERMES_AGENT_READY_TIMEOUT, async {
            loop {
                match events.recv().await {
                    Ok(event) if !gateway_event_matches_session(&event, &runtime_session_id) => {
                        continue;
                    }
                    Ok(event) if event.event_type == "session.info" => {
                        self.session_info = event.payload;
                        self.agent_ready = true;
                        return Ok(());
                    }
                    Ok(event) if event.event_type == "error" => {
                        let message = event
                            .payload
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Hermes agent initialization failed");
                        bail!(message.to_string());
                    }
                    Ok(_) => continue,
                    Err(broadcast::error::RecvError::Lagged(count)) => {
                        bail!("Hermes Gateway warmup event stream lagged by {count} events")
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        bail!("Hermes Gateway connection closed during agent warmup")
                    }
                }
            }
        })
        .await
        .map_err(|_| {
            anyhow!(
                "Hermes agent initialization timed out after {}s",
                HERMES_AGENT_READY_TIMEOUT.as_secs()
            )
        })?
    }

    async fn run_turn(
        &mut self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        cancellation: Option<RuntimeCancellation>,
        permissions: &HermesGatewayPermissionBroker,
    ) -> Result<RuntimeExecutionResult> {
        let cancelled_during_warmup = if let Some(cancellation) = cancellation.as_ref() {
            tokio::select! {
                result = self.ensure_session(&plan) => {
                    result?;
                    false
                }
                _ = cancellation.cancelled() => true,
            }
        } else {
            self.ensure_session(&plan).await?;
            false
        };
        if cancelled_during_warmup {
            if let Some(runtime_session_id) = self.runtime_session_id.as_deref() {
                let _ = self
                    .process
                    .rpc
                    .request(
                        "session.interrupt",
                        json!({"session_id": runtime_session_id}),
                    )
                    .await;
            }
            let stored_session_id = self
                .stored_session_id
                .as_deref()
                .unwrap_or(&plan.runtime_session.session_key);
            permissions.cancel_session(stored_session_id);
            let result = RuntimeExecutionResult {
                exit_code: Some(0),
                cancelled: true,
                stdout: String::new(),
                stderr: String::new(),
            };
            emit_finished(
                &sink,
                &plan,
                stored_session_id,
                self.runtime_session_id.as_deref().unwrap_or(""),
                &result,
                None,
            );
            return Ok(result);
        }
        let runtime_session_id = self
            .runtime_session_id
            .clone()
            .ok_or_else(|| anyhow!("Hermes Gateway runtime session is missing"))?;
        let stored_session_id = self
            .stored_session_id
            .clone()
            .ok_or_else(|| anyhow!("Hermes Gateway stored session is missing"))?;
        let mut content = plan.send_message.content.clone();
        if let Some(prefix) = self.pending_initial_prompt.take() {
            content = join_initial_prompt(&prefix, &content);
        }
        content = self
            .attach_files(&runtime_session_id, &plan, content)
            .await?;

        let mut events = self.process.rpc.subscribe();
        self.process
            .rpc
            .request(
                "prompt.submit",
                json!({
                    "session_id": runtime_session_id,
                    "text": content,
                }),
            )
            .await
            .context("submit Hermes Gateway prompt")?;

        let mut accumulated = String::new();
        loop {
            let next_event = async {
                loop {
                    match events.recv().await {
                        Ok(event) if gateway_event_matches_session(&event, &runtime_session_id) => {
                            return Ok(event);
                        }
                        Ok(_) => continue,
                        Err(broadcast::error::RecvError::Lagged(count)) => {
                            return Err(anyhow!(
                                "Hermes Gateway event stream lagged by {count} events"
                            ));
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            return Err(anyhow!("Hermes Gateway connection closed"));
                        }
                    }
                }
            };
            let event = if let Some(cancellation) = cancellation.as_ref() {
                tokio::select! {
                    event = next_event => event?,
                    _ = cancellation.cancelled() => {
                        let _ = self.process.rpc.request(
                            "session.interrupt",
                            json!({"session_id": runtime_session_id}),
                        ).await;
                        permissions.cancel_session(&stored_session_id);
                        let result = RuntimeExecutionResult {
                            exit_code: Some(0),
                            cancelled: true,
                            stdout: accumulated,
                            stderr: String::new(),
                        };
                        emit_finished(&sink, &plan, &stored_session_id, &runtime_session_id, &result, None);
                        return Ok(result);
                    }
                }
            } else {
                next_event.await?
            };

            match event.event_type.as_str() {
                "message.delta" => {
                    let text = payload_text(&event.payload);
                    accumulated.push_str(&text);
                    emit_gateway_stdout(
                        &sink,
                        &plan,
                        &text,
                        json!({
                            "type": "message.delta",
                            "text": text,
                            "sessionId": stored_session_id,
                            "runtimeSessionId": runtime_session_id,
                        }),
                    );
                }
                "reasoning.delta" | "thinking.delta" => {
                    let text = payload_text(&event.payload);
                    emit_gateway_stdout(
                        &sink,
                        &plan,
                        "",
                        json!({
                            "type": "reasoning_delta",
                            "text": text,
                            "sessionId": stored_session_id,
                            "runtimeSessionId": runtime_session_id,
                        }),
                    );
                }
                "tool.start" | "tool.progress" | "tool.complete" => {
                    emit_gateway_tool_event(
                        &sink,
                        &plan,
                        &stored_session_id,
                        &runtime_session_id,
                        &event,
                    );
                }
                "approval.request" => {
                    if self.approval_mode == "off" || self.session_yolo {
                        let choices = gateway_approval_choices(&event.payload);
                        let choice = hermes_permission_choice("session", &choices);
                        let _ = self
                            .process
                            .rpc
                            .request(
                                "approval.respond",
                                json!({"session_id": runtime_session_id, "choice": choice}),
                            )
                            .await;
                    } else {
                        permissions.add(
                            &plan,
                            &stored_session_id,
                            &runtime_session_id,
                            event.payload,
                            self.process.rpc.clone(),
                            sink.clone(),
                        );
                    }
                }
                "session.info" => {
                    self.session_info = event.payload;
                    if let Some(mode) =
                        value_string(&self.session_info, &["approval_mode", "approvalMode"])
                            .as_deref()
                            .and_then(normalize_hermes_approval_mode)
                    {
                        self.approval_mode = mode.into();
                    }
                }
                "message.complete" => {
                    permissions.cancel_session(&stored_session_id);
                    let final_text = payload_text(&event.payload);
                    if accumulated.is_empty() && !final_text.is_empty() {
                        emit_gateway_stdout(
                            &sink,
                            &plan,
                            &final_text,
                            json!({
                                "type": "message.delta",
                                "text": final_text,
                                "sessionId": stored_session_id,
                                "runtimeSessionId": runtime_session_id,
                            }),
                        );
                    }
                    let status = event
                        .payload
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("complete");
                    let cancelled = status == "interrupted";
                    let failed = status == "error";
                    let result = RuntimeExecutionResult {
                        exit_code: Some(if failed { 1 } else { 0 }),
                        cancelled,
                        stdout: if final_text.is_empty() {
                            accumulated
                        } else {
                            final_text
                        },
                        stderr: event
                            .payload
                            .get("warning")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    };
                    emit_finished(
                        &sink,
                        &plan,
                        &stored_session_id,
                        &runtime_session_id,
                        &result,
                        None,
                    );
                    return Ok(result);
                }
                "error" => {
                    let message = event
                        .payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Hermes Gateway reported an error");
                    bail!(message.to_string());
                }
                _ => {}
            }
        }
    }

    async fn attach_files(
        &self,
        runtime_session_id: &str,
        plan: &RuntimeTurnPlan,
        mut content: String,
    ) -> Result<String> {
        for file in &plan.send_message.files {
            let method = if is_image_path(file) {
                "image.attach"
            } else {
                "file.attach"
            };
            let result = self
                .process
                .rpc
                .request(
                    method,
                    json!({"session_id": runtime_session_id, "path": file}),
                )
                .await
                .with_context(|| format!("attach Hermes file {file}"))?;
            if method == "file.attach"
                && let Some(reference) = value_string(&result, &["ref_text", "refText"])
            {
                if !content.is_empty() {
                    content.push('\n');
                }
                content.push_str(&reference);
            }
        }
        Ok(content)
    }

    async fn set_control(
        &mut self,
        plan: &RuntimeTurnPlan,
        control_id: &str,
        value: &str,
    ) -> Result<()> {
        let runtime_session_id = self
            .runtime_session_id
            .as_deref()
            .ok_or_else(|| anyhow!("Hermes Gateway runtime session is missing"))?;
        let params = match control_id {
            "model" => {
                Some(json!({"session_id": runtime_session_id, "key": "model", "value": value}))
            }
            "thought_level" | "reasoning" | "reasoning_effort" => {
                let effort = normalize_hermes_reasoning_effort(value)
                    .ok_or_else(|| anyhow!("Hermes reasoning effort `{value}` is not supported"))?;
                Some(json!({"session_id": runtime_session_id, "key": "reasoning", "value": effort}))
            }
            "permission" | "permission_mode" | "approval_mode" => None,
            "session_yolo" => Some(json!({
                "session_id": runtime_session_id,
                "key": "yolo",
                "scope": "session",
                "value": if is_enabled_control_value(value) { "1" } else { "0" },
            })),
            _ => bail!("Hermes Gateway control `{control_id}` is not supported"),
        };
        if matches!(
            control_id,
            "permission" | "permission_mode" | "approval_mode"
        ) {
            let mode = normalize_hermes_approval_mode(value)
                .ok_or_else(|| anyhow!("Hermes approval mode `{value}` is not supported"))?;
            match self
                .process
                .rpc
                .request(
                    "config.set",
                    json!({"key": "approvals.mode", "value": mode}),
                )
                .await
            {
                Ok(result) => {
                    self.approval_mode = value_string(&result, &["value"])
                        .as_deref()
                        .and_then(normalize_hermes_approval_mode)
                        .unwrap_or(mode)
                        .into();
                }
                Err(error) if is_legacy_approval_mode_rpc_error(&error) => {
                    persist_legacy_approval_mode(plan, mode).await?;
                    self.approval_mode = mode.into();
                }
                Err(error) => return Err(error),
            }
            self.session_info["approval_mode"] = Value::String(self.approval_mode.clone());
            return Ok(());
        }
        let result = self
            .process
            .rpc
            .request(
                "config.set",
                params.expect("supported Hermes control params"),
            )
            .await?;
        if control_id == "model" {
            self.session_info["model"] = result
                .get("value")
                .cloned()
                .unwrap_or_else(|| Value::String(value.into()));
        } else if matches!(
            control_id,
            "thought_level" | "reasoning" | "reasoning_effort"
        ) {
            let effort = value_string(&result, &["value"])
                .or_else(|| normalize_hermes_reasoning_effort(value).map(str::to_string))
                .unwrap_or_else(|| value.into());
            self.session_info["reasoning_effort"] = Value::String(effort);
        } else {
            self.session_yolo = result
                .get("value")
                .and_then(Value::as_str)
                .map(is_enabled_control_value)
                .unwrap_or_else(|| is_enabled_control_value(value));
        }
        Ok(())
    }

    fn control_snapshot(&self, plan: &RuntimeTurnPlan) -> RuntimeControlSnapshot {
        let model = value_string(&self.session_info, &["model"])
            .or_else(|| desired_model(plan))
            .unwrap_or_default();
        let effort = value_string(&self.session_info, &["reasoning_effort", "reasoningEffort"])
            .as_deref()
            .and_then(normalize_hermes_reasoning_effort)
            .map(str::to_string)
            .or_else(|| {
                desired_reasoning_effort(plan)
                    .as_deref()
                    .and_then(normalize_hermes_reasoning_effort)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "medium".into());
        let mut controls = Vec::new();
        if !model.is_empty() {
            controls.push(RuntimeControl {
                id: "model".into(),
                category: "model".into(),
                current_value: model.clone(),
                source: "hermes_gateway".into(),
                options: vec![control_choice(&model, &model)],
            });
        }
        controls.push(RuntimeControl {
            id: "reasoning_effort".into(),
            category: "thought_level".into(),
            current_value: effort,
            source: "hermes_gateway".into(),
            options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
                .into_iter()
                .map(|value| control_choice(value, reasoning_effort_label(value)))
                .collect(),
        });
        controls.push(RuntimeControl {
            id: "approval_mode".into(),
            category: "permission".into(),
            current_value: self.approval_mode.clone(),
            source: "hermes_gateway".into(),
            options: vec![
                control_choice_with_description("manual", "手动", "危险操作每次都询问"),
                control_choice_with_description("smart", "智能", "低风险自动通过，高风险操作询问"),
                control_choice_with_description("off", "关闭", "不再询问，直接执行"),
            ],
        });
        controls.push(RuntimeControl {
            id: "session_yolo".into(),
            category: "session_permission".into(),
            current_value: if self.session_yolo { "on" } else { "off" }.into(),
            source: "hermes_gateway".into(),
            options: vec![control_choice("off", "关闭"), control_choice("on", "开启")],
        });
        RuntimeControlSnapshot {
            conversation_id: plan.conversation_id.clone(),
            engine: plan.engine.clone(),
            memory_mode: match plan.memory_mode {
                MemoryMode::Mia => "mia",
                MemoryMode::Native => "native",
            }
            .into(),
            session_id: self.stored_session_id.clone(),
            state: if self.runtime_session_id.is_some() {
                "ready".into()
            } else {
                "starting".into()
            },
            controls,
            error: String::new(),
        }
    }
}

struct HermesGatewayProcess {
    _child: Arc<Mutex<Child>>,
    rpc: GatewayRpcClient,
}

impl HermesGatewayProcess {
    async fn spawn(plan: &RuntimeTurnPlan) -> Result<Self> {
        let command = plan
            .command
            .as_ref()
            .ok_or_else(|| anyhow!("Hermes Gateway command is missing"))?;
        let workspace = absolute_workspace_dir(&plan.workspace_dir)?;
        tokio::fs::create_dir_all(&workspace)
            .await
            .with_context(|| format!("create Hermes workspace {}", workspace.display()))?;
        let token = format!("mia_{}{}", Uuid::now_v7().simple(), Uuid::now_v7().simple());
        let mut child_command = Command::new(&command.program);
        configure_background_command(child_command.as_std_mut());
        child_command
            .args(&command.args)
            .env_clear()
            .envs(plan.environment.iter())
            .env("HERMES_DASHBOARD_SESSION_TOKEN", &token)
            .env("HERMES_DESKTOP", "1")
            .env("PYTHONUNBUFFERED", "1")
            .current_dir(&workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = child_command.spawn().with_context(|| {
            format!(
                "spawn Hermes Gateway command `{}` with args {:?}",
                command.program, command.args
            )
        })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Hermes Gateway stdout was not piped"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("Hermes Gateway stderr was not piped"))?;
        let stderr_tail = Arc::new(StdMutex::new(String::new()));
        tokio::spawn(drain_stderr(stderr, stderr_tail.clone()));
        let mut lines = BufReader::new(stdout).lines();
        let port = match tokio::time::timeout(HERMES_STARTUP_TIMEOUT, async {
            loop {
                match lines.next_line().await? {
                    Some(line) => {
                        if let Some(port) = hermes_ready_port(&line) {
                            return Ok::<u16, anyhow::Error>(port);
                        }
                    }
                    None => {
                        let status = child.try_wait()?;
                        bail!("Hermes Gateway exited before readiness marker: {status:?}");
                    }
                }
            }
        })
        .await
        {
            Ok(result) => result?,
            Err(_) => {
                let stderr = stderr_tail.lock().unwrap().clone();
                bail!(
                    "Hermes Gateway startup timed out after {}s{}",
                    HERMES_STARTUP_TIMEOUT.as_secs(),
                    stderr_suffix(&stderr)
                );
            }
        };
        tokio::spawn(async move { while matches!(lines.next_line().await, Ok(Some(_))) {} });

        let url = format!("ws://127.0.0.1:{port}/api/ws?token={token}");
        let rpc = GatewayRpcClient::connect(&url)
            .await
            .with_context(|| format!("connect to Hermes Gateway on 127.0.0.1:{port}"))?;
        Ok(Self {
            _child: Arc::new(Mutex::new(child)),
            rpc,
        })
    }

    async fn is_connected(&self) -> bool {
        if !self.rpc.is_connected() {
            return false;
        }
        self._child.lock().await.try_wait().ok().flatten().is_none()
    }
}

type GatewayWriter =
    futures_util::stream::SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;

#[derive(Clone)]
struct GatewayRpcClient {
    inner: Arc<GatewayRpcInner>,
}

struct GatewayRpcInner {
    writer: Mutex<GatewayWriter>,
    pending: DashMap<String, oneshot::Sender<std::result::Result<Value, String>>>,
    events: broadcast::Sender<GatewayEvent>,
    connected: AtomicBool,
    ready: AtomicBool,
    ready_notify: Notify,
    next_id: AtomicU64,
}

#[derive(Debug, Clone)]
struct GatewayEvent {
    event_type: String,
    session_id: String,
    payload: Value,
}

impl GatewayRpcClient {
    async fn connect(url: &str) -> Result<Self> {
        let (socket, _) = connect_async(url).await?;
        let (writer, mut reader) = socket.split();
        let (events, _) = broadcast::channel(2048);
        let inner = Arc::new(GatewayRpcInner {
            writer: Mutex::new(writer),
            pending: DashMap::new(),
            events,
            connected: AtomicBool::new(true),
            ready: AtomicBool::new(false),
            ready_notify: Notify::new(),
            next_id: AtomicU64::new(1),
        });
        let reader_inner = inner.clone();
        tokio::spawn(async move {
            while let Some(frame) = reader.next().await {
                match frame {
                    Ok(Message::Text(text)) => {
                        if let Ok(value) = serde_json::from_str::<Value>(text.as_str()) {
                            dispatch_gateway_message(&reader_inner, value);
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            reader_inner.connected.store(false, Ordering::SeqCst);
            let ids = reader_inner
                .pending
                .iter()
                .map(|entry| entry.key().clone())
                .collect::<Vec<_>>();
            for id in ids {
                if let Some((_, sender)) = reader_inner.pending.remove(&id) {
                    let _ = sender.send(Err("Hermes Gateway connection closed".into()));
                }
            }
            reader_inner.ready_notify.notify_waiters();
        });
        let client = Self { inner };
        client.wait_ready().await?;
        Ok(client)
    }

    fn is_connected(&self) -> bool {
        self.inner.connected.load(Ordering::SeqCst)
    }

    fn subscribe(&self) -> broadcast::Receiver<GatewayEvent> {
        self.inner.events.subscribe()
    }

    async fn wait_ready(&self) -> Result<()> {
        if self.inner.ready.load(Ordering::SeqCst) {
            return Ok(());
        }
        tokio::time::timeout(HERMES_GATEWAY_READY_TIMEOUT, async {
            loop {
                self.inner.ready_notify.notified().await;
                if self.inner.ready.load(Ordering::SeqCst) {
                    return Ok(());
                }
                if !self.is_connected() {
                    bail!("Hermes Gateway connection closed before gateway.ready");
                }
            }
        })
        .await
        .map_err(|_| anyhow!("Hermes Gateway did not emit gateway.ready"))?
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        if !self.is_connected() {
            bail!("Hermes Gateway connection closed");
        }
        let id = format!("mia-{}", self.inner.next_id.fetch_add(1, Ordering::SeqCst));
        let (sender, receiver) = oneshot::channel();
        self.inner.pending.insert(id.clone(), sender);
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self
            .inner
            .writer
            .lock()
            .await
            .send(Message::Text(message.to_string().into()))
            .await
        {
            self.inner.pending.remove(&id);
            return Err(error.into());
        }
        match tokio::time::timeout(HERMES_RPC_TIMEOUT, receiver).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(anyhow!(error)),
            Ok(Err(_)) => Err(anyhow!("Hermes Gateway request channel closed")),
            Err(_) => {
                self.inner.pending.remove(&id);
                Err(anyhow!("Hermes Gateway request `{method}` timed out"))
            }
        }
    }
}

fn dispatch_gateway_message(inner: &GatewayRpcInner, value: Value) {
    if value.get("method").and_then(Value::as_str) == Some("event") {
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        let event_type = params
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if event_type == "gateway.ready" {
            inner.ready.store(true, Ordering::SeqCst);
            inner.ready_notify.notify_waiters();
        }
        let _ = inner.events.send(GatewayEvent {
            event_type,
            session_id: params
                .get("session_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            payload: params.get("payload").cloned().unwrap_or(Value::Null),
        });
        return;
    }
    let Some(id) = value.get("id").and_then(Value::as_str) else {
        return;
    };
    let Some((_, sender)) = inner.pending.remove(id) else {
        return;
    };
    if let Some(error) = value.get("error") {
        let code = error.get("code").map(Value::to_string).unwrap_or_default();
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Hermes Gateway request failed");
        let _ = sender.send(Err(format!("{code}: {message}")));
    } else {
        let _ = sender.send(Ok(value.get("result").cloned().unwrap_or(Value::Null)));
    }
}

#[derive(Clone, Default)]
struct HermesGatewayPermissionBroker {
    pending: Arc<DashMap<String, Arc<PendingHermesPermission>>>,
}

struct PendingHermesPermission {
    public: AgentPermissionPendingRequest,
    runtime_session_id: String,
    choices: Vec<String>,
    rpc: GatewayRpcClient,
    sink: RuntimeEventSink,
    turn_id: String,
    conversation_id: String,
}

impl HermesGatewayPermissionBroker {
    fn add(
        &self,
        plan: &RuntimeTurnPlan,
        stored_session_id: &str,
        runtime_session_id: &str,
        payload: Value,
        rpc: GatewayRpcClient,
        sink: RuntimeEventSink,
    ) {
        self.cancel_session(stored_session_id);
        let request_id = format!("perm_{}", Uuid::now_v7().simple());
        let tool_name = value_string(&payload, &["tool", "tool_name", "toolName"])
            .unwrap_or_else(|| "terminal".into());
        let command = value_string(&payload, &["command"]).unwrap_or_default();
        let description = value_string(&payload, &["description"]).unwrap_or_default();
        let title = if description.is_empty() {
            format!("Hermes wants to use {tool_name}")
        } else {
            description.clone()
        };
        let choices = gateway_approval_choices(&payload);
        let public = AgentPermissionPendingRequest {
            request_id: request_id.clone(),
            engine: plan.engine.clone(),
            bot_id: plan.bot_id.clone().unwrap_or_default(),
            session_id: stored_session_id.to_string(),
            tool_name: tool_name.clone(),
            title: title.clone(),
            description: description.clone(),
            preview: command.clone(),
            rule: AgentPermissionRule {
                id: format!("{}:{tool_name}", plan.engine),
                engine: plan.engine.clone(),
                tool_name: tool_name.clone(),
                subject_type: "tool".into(),
                subject_value: tool_name.clone(),
                label: title.clone(),
            },
            created_at: current_time_ms().to_string(),
        };
        self.pending.insert(
            request_id.clone(),
            Arc::new(PendingHermesPermission {
                public: public.clone(),
                runtime_session_id: runtime_session_id.to_string(),
                choices,
                rpc,
                sink: sink.clone(),
                turn_id: plan.turn_id.clone(),
                conversation_id: plan.conversation_id.clone(),
            }),
        );
        emit_gateway_stdout(
            &sink,
            plan,
            "",
            json!({
                "type": "permission_request",
                "requestId": public.request_id,
                "engine": public.engine,
                "botId": public.bot_id,
                "sessionId": public.session_id,
                "runtimeSessionId": runtime_session_id,
                "toolName": public.tool_name,
                "title": public.title,
                "description": public.description,
                "preview": public.preview,
                "rule": public.rule,
                "createdAt": public.created_at,
            }),
        );
    }

    fn list_pending(&self, session_id: Option<&str>) -> AgentPermissionListResponse {
        let filter = session_id.map(str::trim).filter(|value| !value.is_empty());
        let mut requests = self
            .pending
            .iter()
            .filter(|entry| filter.is_none_or(|value| entry.value().public.session_id == value))
            .map(|entry| entry.value().public.clone())
            .collect::<Vec<_>>();
        requests.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        AgentPermissionListResponse { requests }
    }

    fn respond(&self, request: AgentPermissionRespondRequest) -> AgentPermissionRespondResponse {
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
        let Some((_, pending)) = self.pending.remove(request_id) else {
            return AgentPermissionRespondResponse {
                ok: false,
                error: Some("permission request not found".into()),
            };
        };
        let choice = hermes_permission_choice(decision, &pending.choices);
        let rpc = pending.rpc.clone();
        let runtime_session_id = pending.runtime_session_id.clone();
        let Some(runtime) = tokio::runtime::Handle::try_current().ok() else {
            self.pending.insert(request_id.to_string(), pending);
            return AgentPermissionRespondResponse {
                ok: false,
                error: Some("async runtime is unavailable".into()),
            };
        };
        runtime.spawn(async move {
            let _ = rpc
                .request(
                    "approval.respond",
                    json!({"session_id": runtime_session_id, "choice": choice}),
                )
                .await;
        });
        pending.sink.emit(
            EVENT_RUNTIME_STDOUT,
            json!({
                "turnId": pending.turn_id,
                "conversationId": pending.conversation_id,
                "engine": pending.public.engine,
                "text": "",
                "event": {
                    "type": "permission_resolved",
                    "requestId": request_id,
                    "decision": decision,
                    "sessionId": pending.public.session_id,
                    "runtimeSessionId": pending.runtime_session_id,
                },
            }),
        );
        AgentPermissionRespondResponse {
            ok: true,
            error: None,
        }
    }

    fn cancel_session(&self, stored_session_id: &str) {
        let ids = self
            .pending
            .iter()
            .filter(|entry| entry.value().public.session_id == stored_session_id)
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>();
        for id in ids {
            self.pending.remove(&id);
        }
    }
}

async fn drain_stderr<R>(stream: R, tail: Arc<StdMutex<String>>)
where
    R: AsyncRead + Unpin,
{
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let mut tail = tail.lock().unwrap();
        tail.push_str(&line);
        tail.push('\n');
        if tail.len() > HERMES_STDERR_TAIL_LIMIT {
            let split = tail.len() - HERMES_STDERR_TAIL_LIMIT;
            tail.drain(..split);
        }
    }
}

fn hermes_ready_port(line: &str) -> Option<u16> {
    let line = line.trim();
    if !(line.starts_with("HERMES_BACKEND_READY") || line.starts_with("HERMES_DASHBOARD_READY")) {
        return None;
    }
    line.split_whitespace()
        .find_map(|part| part.strip_prefix("port="))?
        .parse()
        .ok()
}

fn stderr_suffix(stderr: &str) -> String {
    let stderr = stderr.trim();
    if stderr.is_empty() {
        String::new()
    } else {
        format!("; stderr: {stderr}")
    }
}

fn emit_gateway_stdout(sink: &RuntimeEventSink, plan: &RuntimeTurnPlan, text: &str, event: Value) {
    sink.emit(
        EVENT_RUNTIME_STDOUT,
        json!({
            "turnId": plan.turn_id,
            "conversationId": plan.conversation_id,
            "engine": plan.engine,
            "text": text,
            "event": event,
        }),
    );
}

fn emit_gateway_tool_event(
    sink: &RuntimeEventSink,
    plan: &RuntimeTurnPlan,
    stored_session_id: &str,
    runtime_session_id: &str,
    event: &GatewayEvent,
) {
    let event_type = match event.event_type.as_str() {
        "tool.start" => "tool.started",
        "tool.complete" => "tool.completed",
        _ => "tool.delta",
    };
    let id = value_string(&event.payload, &["tool_id", "toolId", "id"]).unwrap_or_default();
    let name = value_string(&event.payload, &["name", "tool_name", "toolName"])
        .unwrap_or_else(|| "tool".into());
    let preview = value_string(
        &event.payload,
        &["preview", "context", "args_text", "inline_diff", "result"],
    )
    .unwrap_or_else(|| {
        event
            .payload
            .get("args")
            .filter(|value| !value.is_null())
            .map(Value::to_string)
            .unwrap_or_default()
    });
    let error = event
        .payload
        .get("error")
        .is_some_and(|value| value.as_bool().unwrap_or(true));
    emit_gateway_stdout(
        sink,
        plan,
        "",
        json!({
            "type": event_type,
            "id": id,
            "name": name,
            "preview": preview,
            "status": if event_type == "tool.completed" { if error { "failed" } else { "completed" } } else { "in_progress" },
            "error": error,
            "sessionId": stored_session_id,
            "runtimeSessionId": runtime_session_id,
            "toolCall": event.payload,
        }),
    );
}

fn emit_finished(
    sink: &RuntimeEventSink,
    plan: &RuntimeTurnPlan,
    stored_session_id: &str,
    runtime_session_id: &str,
    result: &RuntimeExecutionResult,
    error: Option<&str>,
) {
    sink.emit(
        EVENT_RUNTIME_FINISHED,
        json!({
            "turnId": plan.turn_id,
            "conversationId": plan.conversation_id,
            "engine": plan.engine,
            "exitCode": result.exit_code,
            "cancelled": result.cancelled,
            "ok": result.exit_code == Some(0) && !result.cancelled,
            "sessionId": stored_session_id,
            "runtimeSessionId": runtime_session_id,
            "error": error,
        }),
    );
}

fn hermes_gateway_task_key(plan: &RuntimeTurnPlan) -> String {
    let logical_key = hermes_gateway_logical_task_key(plan);
    let mut hasher = DefaultHasher::new();
    if let Some(command) = &plan.command {
        command.program.hash(&mut hasher);
        command.args.hash(&mut hasher);
    }
    plan.environment.hash(&mut hasher);
    format!("{logical_key}:{:016x}", hasher.finish())
}

fn hermes_gateway_logical_task_key(plan: &RuntimeTurnPlan) -> String {
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

fn is_stale_session_error(error: &anyhow::Error) -> bool {
    let text = error.to_string().to_lowercase();
    text.contains("session") && (text.contains("not found") || text.contains("4007"))
}

fn join_initial_prompt(prefix: &str, user_content: &str) -> String {
    if prefix.trim().is_empty() {
        return user_content.to_string();
    }
    if user_content.is_empty() {
        return prefix.to_string();
    }
    format!("{prefix}\n\n{user_content}")
}

fn value_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn payload_text(payload: &Value) -> String {
    value_string(payload, &["text", "message"]).unwrap_or_default()
}

fn provider_value(plan: &RuntimeTurnPlan, keys: &[&str]) -> Option<String> {
    value_string(&plan.provider, keys)
}

fn desired_model(plan: &RuntimeTurnPlan) -> Option<String> {
    provider_value(plan, &["model", "platformModel", "platform_model"])
}

fn uses_mia_platform_proxy(plan: &RuntimeTurnPlan) -> bool {
    plan.environment
        .get("MIA_PLATFORM_PROVIDER")
        .is_some_and(|provider| provider.eq_ignore_ascii_case("mia"))
}

fn native_model_from_plan(plan: &RuntimeTurnPlan) -> Option<String> {
    let model = desired_model(plan)?;
    (!matches!(model.as_str(), "mia-auto" | "mia-default") && !model.starts_with("mia:"))
        .then_some(model)
}

fn native_provider_from_plan(plan: &RuntimeTurnPlan) -> Option<String> {
    let provider = provider_value(plan, &["provider", "platformProvider", "platform_provider"])?;
    (!provider.eq_ignore_ascii_case("mia")).then_some(provider)
}

fn desired_reasoning_effort(plan: &RuntimeTurnPlan) -> Option<String> {
    plan.environment
        .get("MIA_PLATFORM_REASONING_EFFORT")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            provider_value(
                plan,
                &[
                    "effortLevel",
                    "effort_level",
                    "reasoningEffort",
                    "reasoning_effort",
                ],
            )
        })
}

fn desired_permission_mode(plan: &RuntimeTurnPlan) -> Option<String> {
    provider_value(plan, &["permissionMode", "permission_mode"])
}

fn normalize_hermes_approval_mode(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "manual" | "read-only" | "readonly" | ":read-only" => Some("manual"),
        "smart" | "default" | "ask" | "accept-edits" | "acceptedits" | "auto" => Some("smart"),
        "off"
        | "yolo"
        | "dontask"
        | "never"
        | "agent-full-access"
        | "full-access"
        | "bypasspermissions"
        | ":danger-full-access" => Some("off"),
        _ => None,
    }
}

fn normalize_hermes_reasoning_effort(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "off" | "none" => Some("none"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" | "extra-high" | "extra_high" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

fn reasoning_effort_label(value: &str) -> &str {
    match value {
        "none" => "关闭",
        "minimal" => "极低",
        "low" => "低",
        "medium" => "中",
        "high" => "高",
        "xhigh" => "极高",
        "max" => "最高",
        _ => value,
    }
}

fn is_enabled_control_value(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "on" | "true" | "yes" | "enabled"
    )
}

fn is_legacy_approval_mode_rpc_error(error: &anyhow::Error) -> bool {
    error
        .to_string()
        .to_ascii_lowercase()
        .contains("unknown config key")
}

async fn approval_mode_from_plan_config(plan: &RuntimeTurnPlan) -> Option<String> {
    let home = plan
        .environment
        .get("HERMES_HOME")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let raw = tokio::fs::read_to_string(Path::new(home).join("config.yaml"))
        .await
        .ok()?;
    let config = serde_yaml::from_str::<Value>(&raw).ok()?;
    let mode = config.get("approvals").and_then(|value| value.get("mode"));
    match mode {
        Some(Value::Bool(false)) => Some("off".into()),
        Some(Value::String(value)) => normalize_hermes_approval_mode(value).map(str::to_string),
        Some(_) => Some("manual".into()),
        None => Some("manual".into()),
    }
}

async fn persist_legacy_approval_mode(plan: &RuntimeTurnPlan, mode: &str) -> Result<()> {
    let runtime = plan
        .command
        .as_ref()
        .ok_or_else(|| anyhow!("Hermes Gateway command is missing"))?;
    let mut args = Vec::new();
    if let Some(index) = runtime
        .args
        .windows(2)
        .position(|pair| pair[0] == "-m" && pair[1] == "hermes_cli.main")
    {
        args.extend(runtime.args[..index + 2].iter().cloned());
    }
    args.extend([
        "config".into(),
        "set".into(),
        "approvals.mode".into(),
        mode.into(),
    ]);
    let workspace = absolute_workspace_dir(&plan.workspace_dir)?;
    let mut command = Command::new(&runtime.program);
    configure_background_command(command.as_std_mut());
    let output = command
        .args(args)
        .env_clear()
        .envs(plan.environment.iter())
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("persist Hermes approval mode with the official config command")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        bail!(
            "Hermes config command failed with {}{}",
            output.status,
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        );
    }
    Ok(())
}

fn hermes_permission_choice(decision: &str, choices: &[String]) -> String {
    let desired = match decision {
        "allow_always" | "always" => "always",
        "allow_once" | "allow" => "once",
        "allow_session" | "session" => "session",
        _ => "deny",
    };
    if choices.is_empty() || choices.iter().any(|choice| choice == desired) {
        return desired.into();
    }
    if desired == "always" && choices.iter().any(|choice| choice == "session") {
        return "session".into();
    }
    if matches!(desired, "always" | "session") && choices.iter().any(|choice| choice == "once") {
        return "once".into();
    }
    "deny".into()
}

fn gateway_approval_choices(payload: &Value) -> Vec<String> {
    payload
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn gateway_event_matches_session(event: &GatewayEvent, runtime_session_id: &str) -> bool {
    event.session_id.is_empty() || event.session_id == runtime_session_id
}

fn control_choice(value: &str, label: &str) -> RuntimeControlChoice {
    RuntimeControlChoice {
        value: value.into(),
        label: label.into(),
        description: String::new(),
    }
}

fn control_choice_with_description(
    value: &str,
    label: &str,
    description: &str,
) -> RuntimeControlChoice {
    RuntimeControlChoice {
        value: value.into(),
        label: label.into(),
        description: description.into(),
    }
}

fn is_image_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
            )
        })
}

fn current_time_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn hermes_controls_normalize_legacy_permission_and_effort_values() {
        assert_eq!(normalize_hermes_approval_mode("default"), Some("smart"));
        assert_eq!(normalize_hermes_approval_mode("acceptEdits"), Some("smart"));
        assert_eq!(
            normalize_hermes_approval_mode("bypassPermissions"),
            Some("off")
        );
        assert_eq!(normalize_hermes_approval_mode("manual"), Some("manual"));
        assert_eq!(normalize_hermes_reasoning_effort("off"), Some("none"));
        assert_eq!(normalize_hermes_reasoning_effort("xhigh"), Some("xhigh"));
        assert_eq!(normalize_hermes_reasoning_effort("max"), Some("max"));
    }

    #[test]
    fn parses_official_and_legacy_readiness_markers() {
        assert_eq!(
            hermes_ready_port("HERMES_BACKEND_READY port=43125"),
            Some(43125)
        );
        assert_eq!(
            hermes_ready_port("HERMES_DASHBOARD_READY port=41234"),
            Some(41234)
        );
        assert_eq!(hermes_ready_port("starting"), None);
    }

    #[test]
    fn permission_choices_degrade_to_supported_scope() {
        assert_eq!(
            hermes_permission_choice("allow_always", &["once".into(), "deny".into()]),
            "once"
        );
        assert_eq!(
            hermes_permission_choice("reject_once", &["once".into(), "deny".into()]),
            "deny"
        );
        assert_eq!(
            hermes_permission_choice("session", &["once".into(), "deny".into()]),
            "once"
        );
    }

    #[test]
    fn unscoped_gateway_stream_events_belong_to_the_only_active_session() {
        let event = GatewayEvent {
            event_type: "message.complete".into(),
            session_id: String::new(),
            payload: Value::Null,
        };
        assert!(gateway_event_matches_session(&event, "runtime-1"));
        let other = GatewayEvent {
            session_id: "runtime-2".into(),
            ..event
        };
        assert!(!gateway_event_matches_session(&other, "runtime-1"));
    }

    #[test]
    fn task_key_changes_with_effective_hermes_environment() {
        let plan = |home: &str| RuntimeTurnPlan {
            turn_id: "turn".into(),
            conversation_id: "conversation".into(),
            bot_id: None,
            memory_mode: MemoryMode::Native,
            engine: "hermes".into(),
            workspace_dir: ".".into(),
            protocol: crate::RuntimeProtocol::HermesGateway,
            command: Some(RuntimeCommand {
                program: "hermes".into(),
                args: vec!["serve".into()],
            }),
            environment: BTreeMap::from([("HERMES_HOME".into(), home.into())]),
            provider: Value::Null,
            mcp_servers: Value::Null,
            selected_skill_ids: Vec::new(),
            runtime_session: crate::RuntimeSessionState {
                conversation_id: "conversation".into(),
                engine: "hermes".into(),
                session_key: "session".into(),
                resume_session_key: None,
                resumed: false,
            },
            send_message: crate::RuntimeSendMessage {
                content: "hello".into(),
                msg_id: "message".into(),
                turn_id: None,
                files: Vec::new(),
                inject_skills: Vec::new(),
            },
            mock_response: None,
        };
        assert_ne!(
            hermes_gateway_task_key(&plan("one")),
            hermes_gateway_task_key(&plan("two"))
        );
    }

    #[test]
    fn only_mia_platform_sessions_refresh_the_gateway_runtime_on_resume() {
        let mut plan =
            bundled_turn_plan("hermes".into(), BTreeMap::new(), PathBuf::from("workspace"));
        assert!(!uses_mia_platform_proxy(&plan));

        plan.environment
            .insert("MIA_PLATFORM_PROVIDER".into(), "mia".into());
        assert!(uses_mia_platform_proxy(&plan));
    }

    #[tokio::test]
    #[ignore = "requires MIA_TEST_HERMES_PYTHON and MIA_TEST_HERMES_PYTHONPATH"]
    async fn bundled_hermes_probe_normalizes_legacy_launcher_and_creates_gateway_session() {
        let python = std::env::var("MIA_TEST_HERMES_PYTHON")
            .expect("MIA_TEST_HERMES_PYTHON must point to the bundled Python executable");
        let python_path = std::env::var("MIA_TEST_HERMES_PYTHONPATH")
            .expect("MIA_TEST_HERMES_PYTHONPATH must point to Hermes site-packages");
        let home = std::env::temp_dir().join(format!(
            "mia-hermes-gateway-smoke-{}",
            Uuid::now_v7().simple()
        ));
        let workspace = home.join("workspace");
        let mut environment = std::env::vars().collect::<BTreeMap<_, _>>();
        environment.insert("PYTHONPATH".into(), python_path);
        environment.insert("HERMES_HOME".into(), home.to_string_lossy().to_string());
        let snapshot = probe_hermes_gateway_command(
            RuntimeCommand {
                program: python,
                args: vec!["-m".into(), "hermes_cli.main".into(), "acp".into()],
            },
            environment,
            workspace,
            Duration::from_secs(60),
        )
        .await
        .unwrap();

        assert_eq!(snapshot.engine, "hermes");
        assert_eq!(snapshot.state, "ready");
        assert!(
            snapshot
                .session_id
                .as_deref()
                .is_some_and(|id| !id.is_empty())
        );
        let _ = tokio::fs::remove_dir_all(home).await;
    }

    #[tokio::test]
    #[ignore = "requires MIA_TEST_HERMES_PYTHON and MIA_TEST_HERMES_PYTHONPATH"]
    async fn bundled_hermes_gateway_applies_approval_effort_and_session_yolo_controls() {
        let python = std::env::var("MIA_TEST_HERMES_PYTHON")
            .expect("MIA_TEST_HERMES_PYTHON must point to the bundled Python executable");
        let python_path = std::env::var("MIA_TEST_HERMES_PYTHONPATH")
            .expect("MIA_TEST_HERMES_PYTHONPATH must point to Hermes site-packages");
        let home = std::env::temp_dir().join(format!(
            "mia-hermes-gateway-controls-{}",
            Uuid::now_v7().simple()
        ));
        let workspace = home.join("workspace");
        tokio::fs::create_dir_all(home.join("skills"))
            .await
            .unwrap();
        tokio::fs::write(
            home.join("config.yaml"),
            "approvals:\n  mode: manual\nagent:\n  reasoning_effort: medium\nskills:\n  external_dirs: []\n",
        )
        .await
        .unwrap();
        let mut environment = std::env::vars().collect::<BTreeMap<_, _>>();
        environment.insert("PYTHONPATH".into(), python_path);
        environment.insert("HERMES_HOME".into(), home.to_string_lossy().to_string());
        environment.insert("HERMES_NONINTERACTIVE".into(), "1".into());
        let plan = bundled_turn_plan(python, environment, workspace);
        let mut task = HermesGatewayTask::spawn(&plan, None).await.unwrap();
        task.ensure_session_created(&plan, false).await.unwrap();
        let current = |snapshot: &RuntimeControlSnapshot, category: &str| {
            snapshot
                .controls
                .iter()
                .find(|control| control.category == category)
                .map(|control| control.current_value.clone())
        };
        let initial = task.control_snapshot(&plan);
        assert_eq!(
            current(&initial, "thought_level").as_deref(),
            Some("medium")
        );
        assert_eq!(current(&initial, "permission").as_deref(), Some("manual"));

        task.set_control(&plan, "approval_mode", "smart")
            .await
            .unwrap();
        task.set_control(&plan, "reasoning_effort", "none")
            .await
            .unwrap();
        task.set_control(&plan, "session_yolo", "on").await.unwrap();
        let snapshot = task.control_snapshot(&plan);
        assert_eq!(current(&snapshot, "thought_level").as_deref(), Some("none"));
        assert_eq!(current(&snapshot, "permission").as_deref(), Some("smart"));
        assert_eq!(
            current(&snapshot, "session_permission").as_deref(),
            Some("on")
        );
        let saved = tokio::fs::read_to_string(home.join("config.yaml"))
            .await
            .unwrap();
        let saved: Value = serde_yaml::from_str(&saved).unwrap();
        assert_eq!(saved["approvals"]["mode"], "smart");

        drop(task);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let _ = tokio::fs::remove_dir_all(home).await;
    }

    #[tokio::test]
    #[ignore = "requires MIA_TEST_HERMES_PYTHON and MIA_TEST_HERMES_PYTHONPATH"]
    async fn bundled_hermes_gateway_streams_a_real_turn_from_local_openai_fixture() {
        let python = std::env::var("MIA_TEST_HERMES_PYTHON")
            .expect("MIA_TEST_HERMES_PYTHON must point to the bundled Python executable");
        let python_path = std::env::var("MIA_TEST_HERMES_PYTHONPATH")
            .expect("MIA_TEST_HERMES_PYTHONPATH must point to Hermes site-packages");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_address = listener.local_addr().unwrap();
        let api_task = tokio::spawn(run_openai_fixture(listener));
        let home = std::env::temp_dir().join(format!(
            "mia-hermes-gateway-turn-{}",
            Uuid::now_v7().simple()
        ));
        let workspace = home.join("workspace");
        tokio::fs::create_dir_all(home.join("skills"))
            .await
            .unwrap();
        tokio::fs::write(
            home.join("config.yaml"),
            json!({
                "model": {
                    "provider": "custom",
                    "default": "smoke-model",
                    "base_url": format!("http://{api_address}/v1"),
                    "api_mode": "chat_completions"
                },
                "providers": {
                    "custom": {
                        "name": "Mia smoke fixture",
                        "base_url": format!("http://{api_address}/v1"),
                        "key_env": "OPENAI_API_KEY",
                        "default_model": "smoke-model",
                        "api_mode": "chat_completions"
                    }
                },
                "approvals": { "mode": "off", "timeout": 10 },
                "agent": {
                    "reasoning_effort": "off",
                    "disabled_toolsets": ["browser", "cronjob"]
                },
                "skills": { "external_dirs": [] }
            })
            .to_string(),
        )
        .await
        .unwrap();
        let mut environment = std::env::vars().collect::<BTreeMap<_, _>>();
        environment.insert("PYTHONPATH".into(), python_path);
        environment.insert("HERMES_HOME".into(), home.to_string_lossy().to_string());
        environment.insert("OPENAI_API_KEY".into(), "fixture-key".into());
        environment.insert("HERMES_NONINTERACTIVE".into(), "1".into());
        environment.insert("HERMES_IGNORE_RULES".into(), "1".into());
        environment.insert("HERMES_TUI_TOOLSETS".into(), "terminal".into());
        let plan = bundled_turn_plan(python, environment, workspace);
        let mut task = HermesGatewayTask::spawn(&plan, None).await.unwrap();
        let emitted = Arc::new(StdMutex::new(Vec::new()));
        let sink = {
            let emitted = emitted.clone();
            RuntimeEventSink::new(move |event| emitted.lock().unwrap().push(event))
        };

        let result = tokio::time::timeout(
            Duration::from_secs(60),
            task.run_turn(plan, sink, None, &HermesGatewayPermissionBroker::default()),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "gateway smoke reply");
        let emitted = emitted.lock().unwrap();
        assert!(emitted.iter().any(|event| {
            event.name == EVENT_RUNTIME_STDOUT
                && event.data["event"]["type"] == "message.delta"
                && event.data["event"]["sessionId"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty())
        }));
        assert!(emitted.iter().any(|event| {
            event.name == EVENT_RUNTIME_FINISHED
                && event.data["sessionId"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty())
                && event.data["runtimeSessionId"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty())
        }));
        drop(emitted);
        drop(task);
        api_task.abort();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let _ = tokio::fs::remove_dir_all(home).await;
    }

    fn bundled_turn_plan(
        python: String,
        environment: BTreeMap<String, String>,
        workspace: PathBuf,
    ) -> RuntimeTurnPlan {
        let conversation_id = format!("gateway-turn-{}", Uuid::now_v7().simple());
        RuntimeTurnPlan {
            turn_id: format!("turn-{conversation_id}"),
            conversation_id: conversation_id.clone(),
            bot_id: None,
            memory_mode: MemoryMode::Native,
            engine: "hermes".into(),
            workspace_dir: workspace.to_string_lossy().to_string(),
            protocol: RuntimeProtocol::HermesGateway,
            command: Some(RuntimeCommand {
                program: python,
                args: vec![
                    "-m".into(),
                    "hermes_cli.main".into(),
                    "serve".into(),
                    "--host".into(),
                    "127.0.0.1".into(),
                    "--port".into(),
                    "0".into(),
                ],
            }),
            environment,
            provider: Value::Null,
            mcp_servers: Value::Null,
            selected_skill_ids: Vec::new(),
            runtime_session: RuntimeSessionState {
                conversation_id: conversation_id.clone(),
                engine: "hermes".into(),
                session_key: conversation_id,
                resume_session_key: None,
                resumed: false,
            },
            send_message: RuntimeSendMessage {
                content: "reply from the fixture".into(),
                msg_id: "message-smoke".into(),
                turn_id: None,
                files: Vec::new(),
                inject_skills: Vec::new(),
            },
            mock_response: None,
        }
    }

    async fn run_openai_fixture(listener: TcpListener) {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let Ok(read) = stream.read(&mut buffer).await else {
                        return;
                    };
                    if read == 0 {
                        return;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let head = String::from_utf8_lossy(&request);
                let path = head
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let (content_type, body) = if path.ends_with("/models") {
                    (
                        "application/json",
                        json!({
                            "object": "list",
                            "data": [{"id": "smoke-model", "object": "model", "owned_by": "mia"}]
                        })
                        .to_string(),
                    )
                } else {
                    let first = json!({
                        "id": "chatcmpl-smoke",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": "smoke-model",
                        "choices": [{"index": 0, "delta": {"role": "assistant", "content": "gateway smoke reply"}, "finish_reason": null}]
                    });
                    let final_chunk = json!({
                        "id": "chatcmpl-smoke",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": "smoke-model",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]
                    });
                    (
                        "text/event-stream",
                        format!("data: {first}\n\ndata: {final_chunk}\n\ndata: [DONE]\n\n"),
                    )
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    }
}
