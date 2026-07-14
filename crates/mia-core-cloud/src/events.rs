use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use mia_core_api_types::{
    CloudBridgeRunRequest, CloudBridgeRunResponse, CloudEventsLifecycleResponse,
    CloudMemorySyncRequest, CloudStatusResponse,
};
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at, sleep};

use crate::bridge::{
    CloudBridgeConnectionSpec, CloudBridgeRunHandler, CloudBridgeSocketCommand,
    CloudBridgeSocketEvent, CloudBridgeSocketTransport, TungsteniteCloudBridgeTransport,
};
use crate::{
    CloudError, CloudService, DEFAULT_CLOUD_URL, bool_field, encode_uri_component,
    normalize_cloud_url, string_field,
};

const DEFAULT_RECONNECT_DELAY_MS: u64 = 3000;
const DEFAULT_HEARTBEAT_INTERVAL_MS: u64 = 20000;
const DEFAULT_READY_TIMEOUT_MS: u64 = 15000;
const DEFAULT_DESKTOP_BUSY_RETRY_DELAY_MS: u64 = 500;
const DEFAULT_DESKTOP_BUSY_RETRY_TIMEOUT_MS: u64 = 30 * 60 * 1000;
const RECENT_DESKTOP_INVOCATION_LIMIT: usize = 512;

pub type CloudEventEmitter = Arc<dyn Fn(String, Value) + Send + Sync>;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct CloudEventsRuntimeState {
    connecting: bool,
    connected: bool,
    last_error: String,
}

#[derive(Clone)]
pub struct CloudEventsManager {
    cloud: CloudService,
    transport: Arc<dyn CloudBridgeSocketTransport>,
    desktop_runner: Option<Arc<dyn CloudBridgeRunHandler>>,
    desktop_invocations: Arc<DesktopInvocationCoordinator>,
    emit: CloudEventEmitter,
    state: Arc<Mutex<CloudEventsRuntimeState>>,
    task: Arc<Mutex<Option<JoinHandle<()>>>>,
    reconnect_delay: Duration,
    heartbeat_interval: Duration,
    ready_timeout: Duration,
    desktop_busy_retry_delay: Duration,
    desktop_busy_retry_timeout: Duration,
}

impl std::fmt::Debug for CloudEventsManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CloudEventsManager")
            .finish_non_exhaustive()
    }
}

impl CloudEventsManager {
    pub fn new(cloud: CloudService, emit: CloudEventEmitter) -> Self {
        Self::with_transport(
            cloud,
            Arc::new(TungsteniteCloudBridgeTransport),
            emit,
            Duration::from_millis(DEFAULT_RECONNECT_DELAY_MS),
            Duration::from_millis(DEFAULT_HEARTBEAT_INTERVAL_MS),
            Duration::from_millis(DEFAULT_READY_TIMEOUT_MS),
        )
    }

    pub fn new_with_desktop_runner(
        cloud: CloudService,
        emit: CloudEventEmitter,
        desktop_runner: Arc<dyn CloudBridgeRunHandler>,
    ) -> Self {
        Self::with_transport_and_desktop_runner(
            cloud,
            Arc::new(TungsteniteCloudBridgeTransport),
            emit,
            Some(desktop_runner),
            Duration::from_millis(DEFAULT_RECONNECT_DELAY_MS),
            Duration::from_millis(DEFAULT_HEARTBEAT_INTERVAL_MS),
            Duration::from_millis(DEFAULT_READY_TIMEOUT_MS),
        )
    }

    pub fn with_transport(
        cloud: CloudService,
        transport: Arc<dyn CloudBridgeSocketTransport>,
        emit: CloudEventEmitter,
        reconnect_delay: Duration,
        heartbeat_interval: Duration,
        ready_timeout: Duration,
    ) -> Self {
        Self::with_transport_and_desktop_runner(
            cloud,
            transport,
            emit,
            None,
            reconnect_delay,
            heartbeat_interval,
            ready_timeout,
        )
    }

    pub fn with_transport_and_desktop_runner(
        cloud: CloudService,
        transport: Arc<dyn CloudBridgeSocketTransport>,
        emit: CloudEventEmitter,
        desktop_runner: Option<Arc<dyn CloudBridgeRunHandler>>,
        reconnect_delay: Duration,
        heartbeat_interval: Duration,
        ready_timeout: Duration,
    ) -> Self {
        Self {
            cloud,
            transport,
            desktop_runner,
            desktop_invocations: Arc::new(DesktopInvocationCoordinator::default()),
            emit,
            state: Arc::new(Mutex::new(CloudEventsRuntimeState::default())),
            task: Arc::new(Mutex::new(None)),
            reconnect_delay,
            heartbeat_interval,
            ready_timeout,
            desktop_busy_retry_delay: Duration::from_millis(DEFAULT_DESKTOP_BUSY_RETRY_DELAY_MS),
            desktop_busy_retry_timeout: Duration::from_millis(
                DEFAULT_DESKTOP_BUSY_RETRY_TIMEOUT_MS,
            ),
        }
    }

    pub async fn status(&self, include_token: bool) -> Result<CloudStatusResponse, CloudError> {
        let mut status = self.cloud.status(include_token).await?;
        self.apply_status(&mut status).await?;
        Ok(status)
    }

    pub async fn status_value(&self) -> Result<Value, CloudError> {
        let settings = self.cloud.read_cloud_settings().await?;
        let token = string_field(&settings, "token").unwrap_or_default();
        let enabled = bool_field(&settings, "enabled") && !token.trim().is_empty();
        let last_event_seq = settings
            .get("lastEventSeq")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        let state = self.state.lock().await.clone();
        Ok(json!({
            "enabled": enabled,
            "connected": enabled && state.connected,
            "connecting": enabled && state.connecting,
            "lastError": state.last_error,
            "lastEventSeq": last_event_seq
        }))
    }

    pub async fn apply_status(&self, status: &mut CloudStatusResponse) -> Result<(), CloudError> {
        status.events = self.status_value().await?;
        Ok(())
    }

    pub async fn start(&self) -> Result<CloudEventsLifecycleResponse, CloudError> {
        if self.connection_spec().await?.is_none() {
            self.stop().await?;
            return Ok(CloudEventsLifecycleResponse {
                status: self.status(false).await?,
            });
        }
        let mut task = self.task.lock().await;
        if task.as_ref().is_some_and(|handle| !handle.is_finished()) {
            return Ok(CloudEventsLifecycleResponse {
                status: self.status(false).await?,
            });
        }
        {
            let mut state = self.state.lock().await;
            state.connecting = true;
            state.connected = false;
            state.last_error.clear();
        }
        let manager = self.clone();
        *task = Some(tokio::spawn(async move {
            manager.run_loop().await;
        }));
        Ok(CloudEventsLifecycleResponse {
            status: self.status(false).await?,
        })
    }

    pub async fn stop(&self) -> Result<CloudEventsLifecycleResponse, CloudError> {
        if let Some(handle) = self.task.lock().await.take() {
            handle.abort();
        }
        {
            let mut state = self.state.lock().await;
            state.connecting = false;
            state.connected = false;
        }
        Ok(CloudEventsLifecycleResponse {
            status: self.status(false).await?,
        })
    }

    async fn connection_spec(&self) -> Result<Option<CloudBridgeConnectionSpec>, CloudError> {
        let settings = self.cloud.read_cloud_settings().await?;
        let token = string_field(&settings, "token").unwrap_or_default();
        if !bool_field(&settings, "enabled") || token.trim().is_empty() {
            return Ok(None);
        }
        let base_url = normalize_cloud_url(
            settings
                .get("url")
                .and_then(Value::as_str)
                .or(Some(DEFAULT_CLOUD_URL)),
        );
        let ws_base = base_url
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        let last_event_seq = settings
            .get("lastEventSeq")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        Ok(Some(CloudBridgeConnectionSpec {
            url: format!(
                "{ws_base}/api/events?since_seq={}",
                encode_uri_component(&last_event_seq.to_string())
            ),
            protocols: vec![format!("mia-token.{}", token.trim())],
        }))
    }

    async fn run_loop(self) {
        loop {
            let spec = match self.connection_spec().await {
                Ok(Some(spec)) => spec,
                Ok(None) => {
                    self.set_idle().await;
                    return;
                }
                Err(error) => {
                    self.set_disconnected(&error.to_string()).await;
                    sleep(self.reconnect_delay).await;
                    continue;
                }
            };
            {
                let mut state = self.state.lock().await;
                state.connecting = true;
                state.connected = false;
                state.last_error.clear();
            }
            let (event_tx, event_rx) = mpsc::channel(64);
            let (command_tx, command_rx) = mpsc::channel(64);
            let transport = self.transport.clone();
            let transport_task = tokio::spawn(async move {
                let _ = transport.run(spec, event_tx, command_rx).await;
            });
            self.run_socket_events(event_rx, command_tx).await;
            transport_task.abort();
            sleep(self.reconnect_delay).await;
        }
    }

    async fn run_socket_events(
        &self,
        mut events: mpsc::Receiver<CloudBridgeSocketEvent>,
        commands: mpsc::Sender<CloudBridgeSocketCommand>,
    ) {
        let mut connected = false;
        let mut opened_at: Option<Instant> = None;
        let mut alive = true;
        let mut heartbeat = interval_at(
            Instant::now() + self.heartbeat_interval,
            self.heartbeat_interval,
        );
        heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    if !connected {
                        if opened_at.is_some_and(|opened| opened.elapsed() > self.ready_timeout) {
                            self.set_disconnected("handshake timeout").await;
                            let _ = commands.send(CloudBridgeSocketCommand::Close).await;
                            return;
                        }
                        continue;
                    }
                    if !alive {
                        self.set_disconnected("heartbeat timeout").await;
                        let _ = commands.send(CloudBridgeSocketCommand::Close).await;
                        return;
                    }
                    alive = false;
                    let _ = commands.send(CloudBridgeSocketCommand::Ping).await;
                }
                event = events.recv() => {
                    let Some(event) = event else {
                        self.set_disconnected("socket closed").await;
                        return;
                    };
                    match event {
                        CloudBridgeSocketEvent::Open => {
                            opened_at = Some(Instant::now());
                        }
                        CloudBridgeSocketEvent::Pong => {
                            alive = true;
                        }
                        CloudBridgeSocketEvent::Close => {
                            self.set_disconnected("socket closed").await;
                            return;
                        }
                        CloudBridgeSocketEvent::Error(message) => {
                            self.set_disconnected(&message).await;
                            return;
                        }
                        CloudBridgeSocketEvent::Text(text) => {
                            alive = true;
                            if self.handle_text_message(&text).await == CloudEventsMessageOutcome::Connected {
                                connected = true;
                            }
                        }
                    }
                }
            }
        }
    }

    async fn handle_text_message(&self, raw: &str) -> CloudEventsMessageOutcome {
        let Ok(message) = serde_json::from_str::<Value>(raw) else {
            self.set_last_error("Cloud events sent invalid JSON.").await;
            return CloudEventsMessageOutcome::Continue;
        };
        if let Err(error) = self.apply_resume_cursor(&message).await {
            self.set_last_error(&error.to_string()).await;
        }
        self.apply_domain_side_effects(&message).await;
        let message_type = message
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if message_type.is_empty() {
            return CloudEventsMessageOutcome::Continue;
        }
        if message_type == "events_ready" {
            {
                let mut state = self.state.lock().await;
                state.connected = true;
                state.connecting = false;
                state.last_error.clear();
            }
            self.emit_cloud_event(&message_type, message).await;
            return CloudEventsMessageOutcome::Connected;
        }
        self.emit_cloud_event(&message_type, message).await;
        CloudEventsMessageOutcome::Continue
    }

    async fn apply_resume_cursor(&self, message: &Value) -> Result<(), CloudError> {
        if message.get("type").and_then(Value::as_str) == Some("events_ready")
            && let Some(reset_to) = message.get("resetTo").and_then(Value::as_i64)
        {
            self.cloud.set_last_event_seq(reset_to).await?;
            return Ok(());
        }
        if let Some(seq) = message.get("seq").and_then(Value::as_i64) {
            self.cloud.advance_last_event_seq(seq).await?;
        }
        Ok(())
    }

    async fn apply_domain_side_effects(&self, message: &Value) {
        match message
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "user.profile_updated" => {
                if let Some(user) = message.get("user").filter(|value| value.is_object()) {
                    let _ = self.cloud.set_cloud_user(user.clone()).await;
                }
            }
            "memory.updated" | "memory.deleted" => {
                let cloud = self.cloud.clone();
                tokio::spawn(async move {
                    let _ = cloud.sync_memories(CloudMemorySyncRequest::default()).await;
                });
            }
            "conversation.bot_invocation_requested" => {
                if message
                    .get("replay")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return;
                }
                let manager = self.clone();
                let message = message.clone();
                tokio::spawn(async move {
                    if let Err(error) = manager.handle_desktop_invocation(message).await {
                        manager.set_last_error(&error.to_string()).await;
                    }
                });
            }
            _ => {}
        }
    }

    async fn handle_desktop_invocation(&self, message: Value) -> Result<(), CloudError> {
        let Some(runner) = self.desktop_runner.clone() else {
            return Ok(());
        };
        let request = desktop_invocation_run_request(&message)?;
        let conversation_id = request.conversation_id.clone();
        let bot_id = request.bot_id.clone();
        if !self.desktop_invocations.begin(&request.run_id).await {
            return Ok(());
        }
        let run_id = request.run_id.clone();
        let client_op_id = format!(
            "core-cloud-invocation-{}",
            sanitize_id_part(&request.run_id)
        );
        let lock = self
            .desktop_invocations
            .conversation_lock(&conversation_id)
            .await;
        let response = {
            let _guard = lock.lock().await;
            self.run_desktop_invocation_with_busy_retry(runner, request)
                .await
        };
        self.desktop_invocations.finish(&run_id).await;
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                let error_message = error.to_string();
                let _ = self
                    .cloud
                    .post_conversation_message_as_bot(
                        &conversation_id,
                        json!({
                            "botId": bot_id.clone(),
                            "bodyMd": format!("本机运行失败：{error_message}"),
                            "clientOpId": format!("{client_op_id}-error"),
                            "errorJson": { "message": error_message },
                        }),
                    )
                    .await;
                return Err(error);
            }
        };
        let text = response.text.trim().to_string();
        if text.is_empty() {
            return Ok(());
        }
        self.cloud
            .post_conversation_message_as_bot(
                &conversation_id,
                json!({
                    "botId": bot_id,
                    "bodyMd": text,
                    "attachments": array_or_empty(response.attachments),
                    "trace": empty_object_as_null(response.trace),
                    "contentBlocks": array_or_empty(response.content_blocks),
                    "turnId": response.turn_id,
                    "clientOpId": client_op_id,
                }),
            )
            .await?;
        self.set_last_error("").await;
        Ok(())
    }

    async fn run_desktop_invocation_with_busy_retry(
        &self,
        runner: Arc<dyn CloudBridgeRunHandler>,
        request: CloudBridgeRunRequest,
    ) -> Result<CloudBridgeRunResponse, CloudError> {
        let started_at = Instant::now();
        loop {
            match runner.run(request.clone()).await {
                Err(CloudError::Busy(message))
                    if started_at.elapsed() < self.desktop_busy_retry_timeout =>
                {
                    self.set_last_error(&message).await;
                    sleep(self.desktop_busy_retry_delay).await;
                }
                other => return other,
            }
        }
    }

    async fn emit_cloud_event(&self, message_type: &str, message: Value) {
        let mut payload = message;
        if (message_type == "events_ready" || message_type == "user.profile_updated")
            && let Ok(cloud) = self.status(false).await
            && let Ok(value) = serde_json::to_value(cloud)
            && let Some(object) = payload.as_object_mut()
        {
            object.insert("cloud".into(), value);
        }
        (self.emit)(message_type.to_string(), payload);
    }

    async fn set_idle(&self) {
        let mut state = self.state.lock().await;
        state.connecting = false;
        state.connected = false;
    }

    async fn set_last_error(&self, reason: &str) {
        let mut state = self.state.lock().await;
        state.last_error = reason.to_string();
    }

    async fn set_disconnected(&self, reason: &str) {
        let mut state = self.state.lock().await;
        state.connecting = false;
        state.connected = false;
        state.last_error = reason.to_string();
    }
}

#[derive(Debug, Default)]
struct DesktopInvocationCoordinator {
    state: Mutex<DesktopInvocationState>,
    conversation_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

#[derive(Debug, Default)]
struct DesktopInvocationState {
    active_run_ids: HashSet<String>,
    recent_run_ids: HashSet<String>,
    recent_order: VecDeque<String>,
}

impl DesktopInvocationCoordinator {
    async fn begin(&self, run_id: &str) -> bool {
        let run_id = run_id.trim();
        if run_id.is_empty() {
            return true;
        }
        let mut state = self.state.lock().await;
        if state.active_run_ids.contains(run_id) || state.recent_run_ids.contains(run_id) {
            return false;
        }
        state.active_run_ids.insert(run_id.to_string());
        true
    }

    async fn finish(&self, run_id: &str) {
        let run_id = run_id.trim();
        if run_id.is_empty() {
            return;
        }
        let mut state = self.state.lock().await;
        state.active_run_ids.remove(run_id);
        if state.recent_run_ids.insert(run_id.to_string()) {
            state.recent_order.push_back(run_id.to_string());
        }
        while state.recent_order.len() > RECENT_DESKTOP_INVOCATION_LIMIT {
            if let Some(expired) = state.recent_order.pop_front() {
                state.recent_run_ids.remove(&expired);
            }
        }
    }

    async fn conversation_lock(&self, conversation_id: &str) -> Arc<Mutex<()>> {
        let key = conversation_id.trim();
        let key = if key.is_empty() { "conversation" } else { key };
        let mut locks = self.conversation_locks.lock().await;
        locks
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

fn desktop_invocation_run_request(message: &Value) -> Result<CloudBridgeRunRequest, CloudError> {
    if value_string(message, "runtimeKind").as_deref() != Some("desktop-local") {
        return Err(CloudError::InvalidInput(
            "cloud invocation is not desktop-local".into(),
        ));
    }
    let conversation_id = value_string(message, "conversationId")
        .ok_or_else(|| CloudError::InvalidInput("conversationId is required".into()))?;
    let bot_id = value_string(message, "botId")
        .ok_or_else(|| CloudError::InvalidInput("botId is required".into()))?;
    let triggering = message.get("triggeringMessage").unwrap_or(&Value::Null);
    let text = value_string(triggering, "body_md")
        .or_else(|| value_string(triggering, "bodyMd"))
        .or_else(|| value_string(triggering, "text"))
        .or_else(|| value_string(triggering, "body"))
        .unwrap_or_default();
    let attachments = message_attachments(triggering);
    let selected_skill_ids = selected_skill_ids_from_message(triggering);
    let runtime_config = message
        .get("runtimeConfig")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let run_id = invocation_run_id(message, triggering, &conversation_id, &bot_id);
    Ok(CloudBridgeRunRequest {
        run_id,
        conversation_id,
        text,
        attachments,
        selected_skill_ids,
        bot_id,
        bot_name: bot_display_name(message).unwrap_or_default(),
        display_name: bot_display_name(message).unwrap_or_default(),
        agent_engine: value_string(&runtime_config, "agentEngine")
            .or_else(|| value_string(&runtime_config, "agent_engine")),
        engine: value_string(&runtime_config, "engine"),
        runtime_kind: Some("desktop-local".to_string()),
        model: value_string(&runtime_config, "model"),
        effort_level: value_string(&runtime_config, "effortLevel")
            .or_else(|| value_string(&runtime_config, "effort_level")),
        permission_mode: value_string(&runtime_config, "permissionMode")
            .or_else(|| value_string(&runtime_config, "permission_mode")),
        runtime_config,
        config: json!({}),
    })
}

fn selected_skill_ids_from_message(message: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    if let Some(array) = message.get("selectedSkillIds").and_then(Value::as_array) {
        collect_skill_ids(array, &mut ids, &mut seen);
    }
    if let Some(array) = message.get("selected_skill_ids").and_then(Value::as_array) {
        collect_skill_ids(array, &mut ids, &mut seen);
    }
    if let Some(array) = message.get("skills").and_then(Value::as_array) {
        collect_skill_ids(array, &mut ids, &mut seen);
    }
    let skills_json =
        value_string(message, "skills_json").or_else(|| value_string(message, "skillsJson"));
    if let Some(raw) = skills_json
        && let Ok(Value::Array(array)) = serde_json::from_str::<Value>(&raw)
    {
        collect_skill_ids(&array, &mut ids, &mut seen);
    }
    ids
}

fn collect_skill_ids(array: &[Value], ids: &mut Vec<String>, seen: &mut HashSet<String>) {
    for item in array {
        if ids.len() >= 8 {
            break;
        }
        let id = match item {
            Value::String(value) => clean_skill_id(value),
            Value::Object(object) => object
                .get("id")
                .and_then(Value::as_str)
                .and_then(clean_skill_id),
            _ => None,
        };
        let Some(id) = id else {
            continue;
        };
        if seen.insert(id.clone()) {
            ids.push(id);
        }
    }
}

fn clean_skill_id(value: &str) -> Option<String> {
    let id = value.trim();
    (!id.is_empty()).then(|| id.to_string())
}

fn invocation_run_id(
    message: &Value,
    triggering: &Value,
    conversation_id: &str,
    bot_id: &str,
) -> String {
    let seq = message
        .get("seq")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let message_id = value_string(triggering, "id").unwrap_or_else(|| "message".into());
    format!(
        "cloud_evt_{}_{}_{}_{}",
        seq.max(0),
        sanitize_id_part(conversation_id),
        sanitize_id_part(bot_id),
        sanitize_id_part(&message_id)
    )
}

fn sanitize_id_part(value: &str) -> String {
    let safe = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let safe = safe.trim_matches('_').to_string();
    if safe.is_empty() { "id".into() } else { safe }
}

fn value_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn message_attachments(message: &Value) -> Value {
    if let Some(attachments) = message.get("attachments").filter(|value| value.is_array()) {
        return attachments.clone();
    }
    if let Some(raw) = message
        .get("attachments_json")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        && let Ok(value) = serde_json::from_str::<Value>(raw)
        && value.is_array()
    {
        return value;
    }
    json!([])
}

fn array_or_empty(value: Value) -> Value {
    if value.is_array() { value } else { json!([]) }
}

fn empty_object_as_null(value: Value) -> Value {
    match value {
        Value::Object(object) if object.is_empty() => Value::Null,
        other => other,
    }
}

fn bot_display_name(message: &Value) -> Option<String> {
    let bot_id = value_string(message, "botId")?;
    let members = message.get("members").and_then(Value::as_array)?;
    members.iter().find_map(|member| {
        let is_bot = value_string(member, "member_kind")
            .or_else(|| value_string(member, "memberKind"))
            .as_deref()
            == Some("bot");
        let member_ref =
            value_string(member, "member_ref").or_else(|| value_string(member, "memberRef"));
        if !is_bot || member_ref.as_deref() != Some(bot_id.as_str()) {
            return None;
        }
        let identity = member.get("identity").unwrap_or(&Value::Null);
        value_string(identity, "displayName")
            .or_else(|| value_string(identity, "display_name"))
            .or_else(|| value_string(identity, "name"))
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloudEventsMessageOutcome {
    Continue,
    Connected,
}
