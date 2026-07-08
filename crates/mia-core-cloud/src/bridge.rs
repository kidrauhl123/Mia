use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use mia_core_api_types::{
    CloudBridgeCancelRequest, CloudBridgeCancelResponse, CloudBridgeLifecycleResponse,
    CloudBridgeRunRequest, CloudBridgeRunResponse, CloudBridgeStartRequest, CloudStatusResponse,
};
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at, sleep};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;

use crate::{
    CloudError, CloudService, bool_field, clean_text, encode_uri_component, normalize_cloud_url,
    string_field,
};

const DEFAULT_RECONNECT_DELAY_MS: u64 = 3000;
const DEFAULT_HEARTBEAT_INTERVAL_MS: u64 = 20000;

#[async_trait]
pub trait CloudBridgeRunHandler: Send + Sync {
    async fn run(
        &self,
        request: CloudBridgeRunRequest,
    ) -> Result<CloudBridgeRunResponse, CloudError>;

    async fn cancel(
        &self,
        request: CloudBridgeCancelRequest,
    ) -> Result<CloudBridgeCancelResponse, CloudError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudBridgeConnectionSpec {
    pub url: String,
    pub protocols: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudBridgeSocketEvent {
    Open,
    Text(String),
    Pong,
    Close,
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudBridgeSocketCommand {
    Text(String),
    Ping,
    Close,
}

#[async_trait]
pub trait CloudBridgeSocketTransport: Send + Sync {
    async fn run(
        &self,
        spec: CloudBridgeConnectionSpec,
        events: mpsc::Sender<CloudBridgeSocketEvent>,
        commands: mpsc::Receiver<CloudBridgeSocketCommand>,
    ) -> Result<(), CloudError>;
}

#[derive(Debug, Default)]
pub struct TungsteniteCloudBridgeTransport;

#[async_trait]
impl CloudBridgeSocketTransport for TungsteniteCloudBridgeTransport {
    async fn run(
        &self,
        spec: CloudBridgeConnectionSpec,
        events: mpsc::Sender<CloudBridgeSocketEvent>,
        mut commands: mpsc::Receiver<CloudBridgeSocketCommand>,
    ) -> Result<(), CloudError> {
        let mut request = spec
            .url
            .as_str()
            .into_client_request()
            .map_err(|error| CloudError::Transport(error.to_string()))?;
        if !spec.protocols.is_empty() {
            let header = spec.protocols.join(", ");
            request.headers_mut().insert(
                SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_str(&header)
                    .map_err(|error| CloudError::Transport(error.to_string()))?,
            );
        }
        let (stream, _) = match connect_async(request).await {
            Ok(connected) => connected,
            Err(error) => {
                let message = error.to_string();
                let _ = events
                    .send(CloudBridgeSocketEvent::Error(message.clone()))
                    .await;
                return Err(CloudError::Transport(message));
            }
        };
        let _ = events.send(CloudBridgeSocketEvent::Open).await;
        let (mut writer, mut reader) = stream.split();
        let write_task = tokio::spawn(async move {
            while let Some(command) = commands.recv().await {
                let message = match command {
                    CloudBridgeSocketCommand::Text(text) => Message::Text(text.into()),
                    CloudBridgeSocketCommand::Ping => Message::Ping(Vec::new().into()),
                    CloudBridgeSocketCommand::Close => Message::Close(None),
                };
                if writer.send(message).await.is_err() {
                    break;
                }
            }
        });
        while let Some(message) = reader.next().await {
            match message {
                Ok(Message::Text(text)) => {
                    let _ = events
                        .send(CloudBridgeSocketEvent::Text(text.to_string()))
                        .await;
                }
                Ok(Message::Pong(_)) => {
                    let _ = events.send(CloudBridgeSocketEvent::Pong).await;
                }
                Ok(Message::Close(_)) => {
                    let _ = events.send(CloudBridgeSocketEvent::Close).await;
                    break;
                }
                Ok(_) => {}
                Err(error) => {
                    let _ = events
                        .send(CloudBridgeSocketEvent::Error(error.to_string()))
                        .await;
                    break;
                }
            }
        }
        write_task.abort();
        let _ = events.send(CloudBridgeSocketEvent::Close).await;
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct CloudBridgeRuntimeState {
    connecting: bool,
    connected: bool,
    device_id: String,
    last_error: String,
    logs: Vec<String>,
}

#[derive(Clone)]
pub struct CloudBridgeManager {
    cloud: CloudService,
    runner: Arc<dyn CloudBridgeRunHandler>,
    transport: Arc<dyn CloudBridgeSocketTransport>,
    state: Arc<Mutex<CloudBridgeRuntimeState>>,
    task: Arc<Mutex<Option<JoinHandle<()>>>>,
    reconnect_delay: Duration,
    heartbeat_interval: Duration,
}

impl std::fmt::Debug for CloudBridgeManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CloudBridgeManager")
            .finish_non_exhaustive()
    }
}

impl CloudBridgeManager {
    pub fn new(cloud: CloudService, runner: Arc<dyn CloudBridgeRunHandler>) -> Self {
        Self::with_transport(
            cloud,
            runner,
            Arc::new(TungsteniteCloudBridgeTransport),
            Duration::from_millis(DEFAULT_RECONNECT_DELAY_MS),
            Duration::from_millis(DEFAULT_HEARTBEAT_INTERVAL_MS),
        )
    }

    pub fn with_transport(
        cloud: CloudService,
        runner: Arc<dyn CloudBridgeRunHandler>,
        transport: Arc<dyn CloudBridgeSocketTransport>,
        reconnect_delay: Duration,
        heartbeat_interval: Duration,
    ) -> Self {
        Self {
            cloud,
            runner,
            transport,
            state: Arc::new(Mutex::new(CloudBridgeRuntimeState::default())),
            task: Arc::new(Mutex::new(None)),
            reconnect_delay,
            heartbeat_interval,
        }
    }

    pub async fn status(&self, include_token: bool) -> Result<CloudStatusResponse, CloudError> {
        let mut status = self.cloud.status(include_token).await?;
        let state = self.state.lock().await.clone();
        status.connected = status.enabled && state.connected;
        status.connecting = status.enabled && state.connecting;
        status.device_id = state.device_id;
        status.last_error = state.last_error;
        status.logs = state.logs.into_iter().rev().take(80).collect::<Vec<_>>();
        status.logs.reverse();
        Ok(status)
    }

    pub async fn start(
        &self,
        request: CloudBridgeStartRequest,
    ) -> Result<CloudBridgeLifecycleResponse, CloudError> {
        let Some(spec) = self.connection_spec(&request).await? else {
            self.stop().await?;
            return Ok(CloudBridgeLifecycleResponse {
                status: self.status(false).await?,
            });
        };
        let mut task = self.task.lock().await;
        if task.as_ref().is_some_and(|handle| !handle.is_finished()) {
            return Ok(CloudBridgeLifecycleResponse {
                status: self.status(false).await?,
            });
        }
        {
            let mut state = self.state.lock().await;
            state.connecting = true;
            state.connected = false;
            state.device_id = request.device_id.trim().to_string();
            state.last_error.clear();
        }
        let manager = self.clone();
        *task = Some(tokio::spawn(async move {
            manager.run_loop(spec).await;
        }));
        Ok(CloudBridgeLifecycleResponse {
            status: self.status(false).await?,
        })
    }

    pub async fn stop(&self) -> Result<CloudBridgeLifecycleResponse, CloudError> {
        if let Some(handle) = self.task.lock().await.take() {
            handle.abort();
        }
        {
            let mut state = self.state.lock().await;
            state.connecting = false;
            state.connected = false;
            state.device_id.clear();
        }
        self.append_log("Mia Cloud Bridge disconnected.").await;
        Ok(CloudBridgeLifecycleResponse {
            status: self.status(false).await?,
        })
    }

    pub async fn append_log(&self, line: impl AsRef<str>) {
        let mut state = self.state.lock().await;
        state.logs.push(redact_line(line.as_ref()));
        if state.logs.len() > 200 {
            let keep_from = state.logs.len() - 200;
            state.logs.drain(0..keep_from);
        }
    }

    async fn connection_spec(
        &self,
        request: &CloudBridgeStartRequest,
    ) -> Result<Option<CloudBridgeConnectionSpec>, CloudError> {
        let settings = self.cloud.read_cloud_settings().await?;
        let token = string_field(&settings, "token").unwrap_or_default();
        if !bool_field(&settings, "enabled") || token.trim().is_empty() {
            return Ok(None);
        }
        let base_url = normalize_cloud_url(
            settings
                .get("url")
                .and_then(Value::as_str)
                .or(Some(crate::DEFAULT_CLOUD_URL)),
        );
        let ws_base = base_url
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        let capabilities = normalized_capabilities(request);
        let engine = clean_text(&request.engine)
            .or_else(|| first_capability_engine(&capabilities))
            .unwrap_or_else(|| "mia-desktop".to_string());
        let query = [
            ("deviceId", request.device_id.trim()),
            ("deviceName", request.device_name.trim()),
            ("engine", engine.as_str()),
            ("capabilities", &capabilities.to_string()),
        ]
        .into_iter()
        .map(|(key, value)| format!("{key}={}", encode_uri_component(value)))
        .collect::<Vec<_>>()
        .join("&");
        Ok(Some(CloudBridgeConnectionSpec {
            url: format!("{ws_base}/api/bridge?{query}"),
            protocols: vec![format!("mia-token.{}", token.trim())],
        }))
    }

    async fn run_loop(self, spec: CloudBridgeConnectionSpec) {
        loop {
            {
                let mut state = self.state.lock().await;
                state.connecting = true;
                state.connected = false;
                state.last_error.clear();
            }
            let (event_tx, event_rx) = mpsc::channel(64);
            let (command_tx, command_rx) = mpsc::channel(64);
            let transport = self.transport.clone();
            let spec_for_transport = spec.clone();
            let transport_task = tokio::spawn(async move {
                let _ = transport
                    .run(spec_for_transport, event_tx, command_rx)
                    .await;
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
                            self.append_log("Connecting to Mia Cloud Bridge.").await;
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
                            match self.handle_text_message(&text, commands.clone()).await {
                                BridgeMessageOutcome::Continue => {}
                                BridgeMessageOutcome::Connected => {
                                    connected = true;
                                }
                                BridgeMessageOutcome::Reconnect => {
                                    let _ = commands.send(CloudBridgeSocketCommand::Close).await;
                                    return;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    async fn handle_text_message(
        &self,
        raw: &str,
        commands: mpsc::Sender<CloudBridgeSocketCommand>,
    ) -> BridgeMessageOutcome {
        let Ok(message) = serde_json::from_str::<Value>(raw) else {
            self.append_log("Cloud bridge sent invalid JSON.").await;
            return BridgeMessageOutcome::Continue;
        };
        let message_type = message
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match message_type {
            "bridge_ready" => {
                let device_id = message
                    .get("deviceId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                {
                    let mut state = self.state.lock().await;
                    state.connected = true;
                    state.connecting = false;
                    state.device_id = device_id;
                    state.last_error.clear();
                }
                self.append_log("Mia Cloud Bridge connected.").await;
                BridgeMessageOutcome::Connected
            }
            "device_identity_conflict" => {
                let message = message
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("device identity conflict");
                self.set_disconnected(message).await;
                BridgeMessageOutcome::Reconnect
            }
            "cancel" => {
                let request =
                    serde_json::from_value::<CloudBridgeCancelRequest>(message).unwrap_or_default();
                let runner = self.runner.clone();
                tokio::spawn(async move {
                    let _ = runner.cancel(request).await;
                });
                BridgeMessageOutcome::Continue
            }
            "run" => {
                let run_id = message
                    .get("runId")
                    .or_else(|| message.get("run_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let request =
                    serde_json::from_value::<CloudBridgeRunRequest>(message).unwrap_or_default();
                let runner = self.runner.clone();
                tokio::spawn(async move {
                    let response = match runner.run(request).await {
                        Ok(response) => json!({
                            "type": "run_result",
                            "runId": if response.run_id.is_empty() { run_id.clone() } else { response.run_id },
                            "ok": true,
                            "text": response.text,
                            "attachments": response.attachments,
                        }),
                        Err(error) => json!({
                            "type": "run_result",
                            "runId": run_id,
                            "ok": false,
                            "error": error.to_string(),
                        }),
                    };
                    let _ = commands
                        .send(CloudBridgeSocketCommand::Text(response.to_string()))
                        .await;
                });
                BridgeMessageOutcome::Continue
            }
            _ => BridgeMessageOutcome::Continue,
        }
    }

    async fn set_disconnected(&self, reason: &str) {
        {
            let mut state = self.state.lock().await;
            state.connecting = false;
            state.connected = false;
            state.device_id.clear();
            state.last_error = reason.to_string();
        }
        self.append_log(format!("Mia Cloud Bridge {reason}; reconnecting."))
            .await;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BridgeMessageOutcome {
    Continue,
    Connected,
    Reconnect,
}

fn normalized_capabilities(request: &CloudBridgeStartRequest) -> Value {
    let mut capabilities = request
        .capabilities
        .as_object()
        .cloned()
        .unwrap_or_else(Map::new);
    let engine = clean_text(&request.engine).unwrap_or_else(|| "mia-desktop".to_string());
    if !capabilities.contains_key("engines") {
        capabilities.insert("engines".into(), json!([engine.clone()]));
    }
    if !capabilities.contains_key("app") {
        capabilities.insert("app".into(), json!("Mia Desktop"));
    }
    if !capabilities.contains_key("chat") {
        capabilities.insert("chat".into(), json!(true));
    }
    Value::Object(capabilities)
}

fn first_capability_engine(capabilities: &Value) -> Option<String> {
    capabilities
        .get("engines")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find_map(clean_text)
}

fn redact_line(line: &str) -> String {
    let text = line.trim();
    if text.is_empty() {
        return String::new();
    }
    text.to_string()
}
