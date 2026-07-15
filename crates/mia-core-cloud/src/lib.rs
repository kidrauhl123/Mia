//! Cloud account/session state boundary for Mia Rust Core.

mod bridge;
mod events;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use mia_core_api_types::{
    CloudBridgeRunRequest, CloudConnectRequest, CloudConnectResponse, CloudMemorySyncRequest,
    CloudMemorySyncResponse, CloudSettingsResponse, CloudStatusResponse, PutCloudSettingsRequest,
};
use mia_core_memory::{MemoryError, MemoryService};
use serde_json::{Map, Value, json};
use sqlx::{Row, SqlitePool};

pub use bridge::{
    CloudBridgeConnectionSpec, CloudBridgeManager, CloudBridgeRunHandler, CloudBridgeSocketCommand,
    CloudBridgeSocketEvent, CloudBridgeSocketTransport, TungsteniteCloudBridgeTransport,
};
pub use events::{CloudEventEmitter, CloudEventsManager};

pub const EVENT_CLOUD_STATUS_CHANGED: &str = "cloud.statusChanged";

const CLOUD_SETTINGS_KEY: &str = "settings";
const CLOUD_USER_SETTINGS_KEY: &str = "user_settings";
pub(crate) const DEFAULT_CLOUD_URL: &str = "https://mia.gifgif.cn";

type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedCloudBridgeRun {
    pub run_id: String,
    pub cloud_conversation_id: String,
    pub local_conversation_id: String,
    pub title: String,
    pub text: String,
    pub attachments: Value,
    pub selected_skill_ids: Vec<String>,
    pub runtime: Value,
    pub metadata: Value,
}

#[derive(Debug, thiserror::Error)]
pub enum CloudError {
    #[error("invalid cloud input: {0}")]
    InvalidInput(String),
    #[error("cloud transport failed: {0}")]
    Transport(String),
    #[error("cloud runtime failed: {0}")]
    Runtime(String),
    #[error("cloud runtime busy: {0}")]
    Busy(String),
    #[error(transparent)]
    Memory(#[from] MemoryError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[async_trait]
pub trait CloudMemoryTransport: Send + Sync {
    async fn post_json(
        &self,
        base_url: &str,
        token: &str,
        path: &str,
        body: Value,
    ) -> Result<Value, CloudError>;

    async fn get_json(&self, base_url: &str, token: &str, path: &str) -> Result<Value, CloudError>;

    async fn patch_json(
        &self,
        base_url: &str,
        token: &str,
        path: &str,
        body: Value,
    ) -> Result<Value, CloudError>;

    async fn delete_json(
        &self,
        base_url: &str,
        token: &str,
        path: &str,
    ) -> Result<Value, CloudError>;
}

#[derive(Debug, Default)]
struct ReqwestCloudMemoryTransport;

#[async_trait]
impl CloudMemoryTransport for ReqwestCloudMemoryTransport {
    async fn post_json(
        &self,
        base_url: &str,
        token: &str,
        path: &str,
        body: Value,
    ) -> Result<Value, CloudError> {
        let client = reqwest::Client::new();
        let response = client
            .post(format!("{base_url}{path}"))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|error| CloudError::Transport(error.to_string()))?;
        response_json(response).await
    }

    async fn get_json(&self, base_url: &str, token: &str, path: &str) -> Result<Value, CloudError> {
        let client = reqwest::Client::new();
        let response = client
            .get(format!("{base_url}{path}"))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| CloudError::Transport(error.to_string()))?;
        response_json(response).await
    }

    async fn patch_json(
        &self,
        base_url: &str,
        token: &str,
        path: &str,
        body: Value,
    ) -> Result<Value, CloudError> {
        let client = reqwest::Client::new();
        let response = client
            .patch(format!("{base_url}{path}"))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|error| CloudError::Transport(error.to_string()))?;
        response_json(response).await
    }

    async fn delete_json(
        &self,
        base_url: &str,
        token: &str,
        path: &str,
    ) -> Result<Value, CloudError> {
        let client = reqwest::Client::new();
        let response = client
            .delete(format!("{base_url}{path}"))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| CloudError::Transport(error.to_string()))?;
        response_json(response).await
    }
}

#[derive(Clone)]
pub struct CloudService {
    pool: SqlitePool,
    now_ms: NowFn,
    memory_transport: Arc<dyn CloudMemoryTransport>,
}

impl std::fmt::Debug for CloudService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CloudService")
            .finish_non_exhaustive()
    }
}

impl CloudService {
    pub fn new(pool: SqlitePool) -> Self {
        Self::with_now(pool, now_ms)
    }

    pub fn with_now<F>(pool: SqlitePool, now_ms: F) -> Self
    where
        F: Fn() -> i64 + Send + Sync + 'static,
    {
        Self::with_memory_transport(pool, now_ms, ReqwestCloudMemoryTransport)
    }

    pub fn with_memory_transport<F, T>(pool: SqlitePool, now_ms: F, memory_transport: T) -> Self
    where
        F: Fn() -> i64 + Send + Sync + 'static,
        T: CloudMemoryTransport + 'static,
    {
        Self {
            pool,
            now_ms: Arc::new(now_ms),
            memory_transport: Arc::new(memory_transport),
        }
    }

    pub async fn status(&self, include_token: bool) -> Result<CloudStatusResponse, CloudError> {
        Ok(status_from_settings(
            self.read_cloud_settings().await?,
            include_token,
        ))
    }

    pub async fn connect(
        &self,
        request: CloudConnectRequest,
    ) -> Result<CloudConnectResponse, CloudError> {
        let mut current = self.read_cloud_settings().await?;
        let previous = current.clone();
        let previous_token = string_field(&current, "token").unwrap_or_default();
        let previous_url = normalize_cloud_url(current.get("url").and_then(Value::as_str));
        let previous_enabled = bool_field(&current, "enabled") && !previous_token.trim().is_empty();
        let previous_last_event_seq = current
            .get("lastEventSeq")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        let token = request
            .token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| string_field(&current, "token").filter(|value| !value.is_empty()))
            .ok_or_else(|| CloudError::InvalidInput("token is required".into()))?;
        let user = request
            .user
            .or(request.account)
            .or_else(|| account_from_hint(request.account_hint.as_deref()));
        let url = normalize_cloud_url(
            request
                .url
                .as_deref()
                .or_else(|| current.get("url").and_then(Value::as_str)),
        );
        let same_resume_session =
            previous_enabled && previous_token == token && previous_url == url;
        let next_last_event_seq = match request.last_event_seq.map(|seq| seq.max(0)) {
            Some(requested) if same_resume_session => previous_last_event_seq.max(requested),
            Some(requested) => requested,
            None if same_resume_session => previous_last_event_seq,
            None => 0,
        };
        set_object_field(&mut current, "enabled", Value::Bool(true));
        set_object_field(&mut current, "url", Value::String(url));
        set_object_field(&mut current, "token", Value::String(token));
        set_object_field(&mut current, "user", user.unwrap_or(Value::Null));
        set_object_field(
            &mut current,
            "agentRuntime",
            request.agent_runtime.unwrap_or(Value::Null),
        );
        set_object_field(
            &mut current,
            "lastEventSeq",
            Value::Number(next_last_event_seq.into()),
        );
        if let Some(last_memory_sync_at) = request.last_memory_sync_at {
            set_object_field(
                &mut current,
                "lastMemorySyncAt",
                Value::String(last_memory_sync_at),
            );
        }
        if current != previous {
            self.write_state(CLOUD_SETTINGS_KEY, current.clone())
                .await?;
        }
        Ok(CloudConnectResponse {
            status: status_from_settings(current, false),
        })
    }

    pub async fn disconnect(&self) -> Result<CloudStatusResponse, CloudError> {
        let mut current = self.read_cloud_settings().await?;
        set_object_field(&mut current, "enabled", Value::Bool(false));
        set_object_field(&mut current, "token", Value::String(String::new()));
        set_object_field(&mut current, "user", Value::Null);
        set_object_field(&mut current, "agentRuntime", Value::Null);
        set_object_field(&mut current, "lastEventSeq", Value::Number(0.into()));
        set_object_field(
            &mut current,
            "lastMemorySyncAt",
            Value::String(String::new()),
        );
        self.write_state(CLOUD_SETTINGS_KEY, current.clone())
            .await?;
        Ok(status_from_settings(current, false))
    }

    pub async fn user_settings(&self) -> Result<CloudSettingsResponse, CloudError> {
        Ok(CloudSettingsResponse {
            settings: normalize_user_settings(
                self.read_state(CLOUD_USER_SETTINGS_KEY)
                    .await?
                    .unwrap_or_else(default_user_settings),
            )?,
        })
    }

    pub async fn put_user_settings(
        &self,
        request: PutCloudSettingsRequest,
    ) -> Result<CloudSettingsResponse, CloudError> {
        let settings = normalize_user_settings(request.settings)?;
        self.write_state(CLOUD_USER_SETTINGS_KEY, settings.clone())
            .await?;
        Ok(CloudSettingsResponse { settings })
    }

    pub async fn sync_memories(
        &self,
        request: CloudMemorySyncRequest,
    ) -> Result<CloudMemorySyncResponse, CloudError> {
        let mut settings = self.read_cloud_settings().await?;
        let token = string_field(&settings, "token").unwrap_or_default();
        let enabled = bool_field(&settings, "enabled") && !token.is_empty();
        if !enabled {
            return Ok(CloudMemorySyncResponse {
                ok: false,
                skipped: true,
                pushed: 0,
                pulled: 0,
                conflicts: 0,
                errors: 0,
                server_time: String::new(),
            });
        }

        let user_id = cloud_user_id(&settings);
        let since = if request.full.unwrap_or(false) {
            String::new()
        } else {
            string_field(&settings, "lastMemorySyncAt").unwrap_or_default()
        };
        let limit = request.limit.unwrap_or(1000).clamp(1, 5000);
        let memory = MemoryService::new(self.pool.clone());
        let local_entries = memory
            .list_sync_memories(&user_id, &since, true, limit)
            .await?;
        let mut summary = CloudMemorySyncResponse {
            ok: true,
            skipped: false,
            pushed: 0,
            pulled: 0,
            conflicts: 0,
            errors: 0,
            server_time: String::new(),
        };
        let base_url = normalize_cloud_url(
            settings
                .get("url")
                .and_then(Value::as_str)
                .or(Some(DEFAULT_CLOUD_URL)),
        );

        if !local_entries.is_empty() {
            let pushed = self
                .memory_transport
                .post_json(
                    &base_url,
                    &token,
                    "/api/me/memory/push",
                    json!({
                        "clientOpId": memory_sync_client_op_id(&user_id, &since, (self.now_ms)()),
                        "entries": local_entries.iter().map(memory_entry_for_cloud).collect::<Vec<_>>(),
                    }),
                )
                .await?;
            let pushed_memories = value_array(&pushed, "memories");
            let push_conflicts = value_array(&pushed, "conflicts");
            let push_errors = value_array(&pushed, "errors");
            summary.pushed = pushed_memories.len();
            summary.conflicts += push_conflicts.len();
            summary.errors += push_errors.len();
            if !push_conflicts.is_empty() {
                let applied = memory
                    .apply_synced_memories(&user_id, &push_conflicts, true)
                    .await?;
                summary.pulled += applied.applied.len();
                summary.errors += applied.errors.len();
            }
        }

        let memory_path = if since.is_empty() {
            "/api/me/memory".to_string()
        } else {
            format!("/api/me/memory?since={}", encode_uri_component(&since))
        };
        let data = self
            .memory_transport
            .get_json(&base_url, &token, &memory_path)
            .await?;
        let remote_memories = value_array(&data, "memories");
        if !remote_memories.is_empty() {
            let applied = memory
                .apply_synced_memories(&user_id, &remote_memories, false)
                .await?;
            summary.pulled += applied.applied.len();
            summary.conflicts += applied.conflicts.len();
            summary.errors += applied.errors.len();
        }
        let server_time = string_field(&data, "serverTime")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| (self.now_ms)().to_string());
        summary.server_time = server_time.clone();
        set_object_field(
            &mut settings,
            "lastMemorySyncAt",
            Value::String(server_time),
        );
        self.write_state(CLOUD_SETTINGS_KEY, settings).await?;
        Ok(summary)
    }

    pub async fn list_tasks(&self) -> Result<Value, CloudError> {
        let (base_url, token) = match self.connected_cloud_api().await {
            Ok(session) => session,
            Err(CloudError::InvalidInput(_)) => return Ok(json!({ "tasks": [] })),
            Err(error) => return Err(error),
        };
        self.memory_transport
            .get_json(&base_url, &token, "/api/tasks")
            .await
    }

    pub async fn get_task(&self, task_id: &str) -> Result<Value, CloudError> {
        let (base_url, token) = self.connected_cloud_api().await?;
        let path = cloud_task_path(task_id)?;
        self.memory_transport
            .get_json(&base_url, &token, &path)
            .await
    }

    pub async fn update_task(&self, task_id: &str, body: Value) -> Result<Value, CloudError> {
        let (base_url, token) = self.connected_cloud_api().await?;
        let path = cloud_task_path(task_id)?;
        self.memory_transport
            .patch_json(&base_url, &token, &path, body)
            .await
    }

    pub async fn delete_task(&self, task_id: &str) -> Result<Value, CloudError> {
        let (base_url, token) = self.connected_cloud_api().await?;
        let path = cloud_task_path(task_id)?;
        self.memory_transport
            .delete_json(&base_url, &token, &path)
            .await
    }

    pub async fn pause_task(&self, task_id: &str) -> Result<Value, CloudError> {
        self.post_task_action(task_id, "pause").await
    }

    pub async fn resume_task(&self, task_id: &str) -> Result<Value, CloudError> {
        self.post_task_action(task_id, "resume").await
    }

    pub async fn run_task_now(&self, task_id: &str) -> Result<Value, CloudError> {
        self.post_task_action(task_id, "run-now").await
    }

    async fn post_task_action(&self, task_id: &str, action: &str) -> Result<Value, CloudError> {
        let (base_url, token) = self.connected_cloud_api().await?;
        let path = format!("{}/{}", cloud_task_path(task_id)?, action);
        self.memory_transport
            .post_json(&base_url, &token, &path, json!({}))
            .await
    }

    async fn connected_cloud_api(&self) -> Result<(String, String), CloudError> {
        let settings = self.read_cloud_settings().await?;
        let token = string_field(&settings, "token").unwrap_or_default();
        if !bool_field(&settings, "enabled") || token.trim().is_empty() {
            return Err(CloudError::InvalidInput("cloud is not connected".into()));
        }
        let base_url = normalize_cloud_url(
            settings
                .get("url")
                .and_then(Value::as_str)
                .or(Some(DEFAULT_CLOUD_URL)),
        );
        Ok((base_url, token))
    }

    pub async fn post_conversation_message_as_bot(
        &self,
        conversation_id: &str,
        body: Value,
    ) -> Result<Value, CloudError> {
        let settings = self.read_cloud_settings().await?;
        let token = string_field(&settings, "token").unwrap_or_default();
        let enabled = bool_field(&settings, "enabled") && !token.trim().is_empty();
        if !enabled {
            return Err(CloudError::InvalidInput("cloud is not connected".into()));
        }
        let conversation_id = cloud_route_id(conversation_id)?;
        let base_url = normalize_cloud_url(
            settings
                .get("url")
                .and_then(Value::as_str)
                .or(Some(DEFAULT_CLOUD_URL)),
        );
        self.memory_transport
            .post_json(
                &base_url,
                &token,
                &format!("/api/conversations/{conversation_id}/messages/as-bot"),
                body,
            )
            .await
    }

    pub fn prepare_bridge_run(
        &self,
        request: CloudBridgeRunRequest,
    ) -> Result<PreparedCloudBridgeRun, CloudError> {
        let run_id = clean_or_default(&request.run_id, || {
            format!("run_{}", (self.now_ms)().max(0))
        });
        let cloud_conversation_id = clean_or_default(&request.conversation_id, || run_id.clone());
        let local_conversation_id = format!(
            "cloud_bridge_{}",
            safe_identifier(&cloud_conversation_id, "conversation")
        );
        let bot_id = clean_text(&request.bot_id);
        let bot_name = clean_text(&request.bot_name)
            .or_else(|| clean_text(&request.display_name))
            .unwrap_or_else(|| engine_label("codex").to_string());
        let text = clean_text(&request.text).unwrap_or_default();
        let runtime = normalize_bridge_runtime_config(&request);
        let engine = runtime
            .get("agentEngine")
            .and_then(Value::as_str)
            .unwrap_or("codex");
        let title = if bot_name.is_empty() {
            engine_label(engine).to_string()
        } else {
            bot_name.clone()
        };
        let attachments = if request.attachments.is_array() {
            request.attachments
        } else {
            json!([])
        };
        let selected_skill_ids = normalize_selected_skill_ids(&request.selected_skill_ids);
        Ok(PreparedCloudBridgeRun {
            run_id: run_id.clone(),
            cloud_conversation_id: cloud_conversation_id.clone(),
            local_conversation_id,
            title: title.clone(),
            text,
            attachments,
            selected_skill_ids,
            runtime: runtime.clone(),
            metadata: json!({
                "runtime": runtime,
                "cloudBridge": {
                    "runId": run_id,
                    "conversationId": cloud_conversation_id,
                    "botId": bot_id,
                    "botName": title,
                }
            }),
        })
    }

    pub(crate) async fn read_cloud_settings(&self) -> Result<Value, CloudError> {
        Ok(normalize_cloud_settings(
            self.read_state(CLOUD_SETTINGS_KEY)
                .await?
                .unwrap_or_else(default_cloud_settings),
        ))
    }

    pub(crate) async fn advance_last_event_seq(&self, next_seq: i64) -> Result<(), CloudError> {
        let mut current = self.read_cloud_settings().await?;
        let current_seq = current
            .get("lastEventSeq")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if next_seq <= current_seq {
            return Ok(());
        }
        set_object_field(
            &mut current,
            "lastEventSeq",
            Value::Number(next_seq.max(0).into()),
        );
        self.write_state(CLOUD_SETTINGS_KEY, current).await
    }

    pub(crate) async fn set_last_event_seq(&self, next_seq: i64) -> Result<(), CloudError> {
        let mut current = self.read_cloud_settings().await?;
        set_object_field(
            &mut current,
            "lastEventSeq",
            Value::Number(next_seq.max(0).into()),
        );
        self.write_state(CLOUD_SETTINGS_KEY, current).await
    }

    pub(crate) async fn set_cloud_user(&self, user: Value) -> Result<(), CloudError> {
        let mut current = self.read_cloud_settings().await?;
        set_object_field(&mut current, "user", user);
        self.write_state(CLOUD_SETTINGS_KEY, current).await
    }

    async fn read_state(&self, key: &str) -> Result<Option<Value>, CloudError> {
        let row = sqlx::query("SELECT value_json FROM cloud_state WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        row.map(|row| parse_json(row.get::<String, _>("value_json")))
            .transpose()
    }

    async fn write_state(&self, key: &str, value: Value) -> Result<(), CloudError> {
        sqlx::query(
            "INSERT INTO cloud_state (key, value_json, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        )
        .bind(key)
        .bind(value.to_string())
        .bind((self.now_ms)())
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

fn status_from_settings(settings: Value, include_token: bool) -> CloudStatusResponse {
    let token = string_field(&settings, "token").unwrap_or_default();
    let enabled = bool_field(&settings, "enabled") && !token.is_empty();
    let user = settings
        .get("user")
        .filter(|value| value.is_object())
        .cloned();
    let last_event_seq = settings
        .get("lastEventSeq")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    CloudStatusResponse {
        enabled,
        connected: enabled,
        connecting: false,
        url: string_field(&settings, "url").unwrap_or_else(|| DEFAULT_CLOUD_URL.to_string()),
        account: user.clone(),
        user,
        agent_runtime: settings
            .get("agentRuntime")
            .filter(|value| value.is_object())
            .cloned(),
        device_id: string_field(&settings, "deviceId").unwrap_or_default(),
        last_error: string_field(&settings, "lastError").unwrap_or_default(),
        logs: settings
            .get("logs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        events: json!({
            "enabled": enabled,
            "connected": false,
            "connecting": false,
            "lastError": "",
            "lastEventSeq": last_event_seq
        }),
        token: include_token.then_some(token),
    }
}

async fn response_json(response: reqwest::Response) -> Result<Value, CloudError> {
    let status = response.status();
    let value = response
        .json::<Value>()
        .await
        .map_err(|error| CloudError::Transport(error.to_string()))?;
    if !status.is_success() {
        let detail = value
            .get("error")
            .or_else(|| value.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("request failed");
        return Err(CloudError::Transport(format!(
            "Mia Cloud HTTP {}: {detail}",
            status.as_u16()
        )));
    }
    Ok(value)
}

fn value_array(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn cloud_user_id(settings: &Value) -> String {
    settings
        .get("user")
        .and_then(Value::as_object)
        .and_then(|user| {
            user.get("id")
                .or_else(|| user.get("username"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "local".to_string())
}

fn memory_entry_for_cloud(entry: &mia_core_api_types::MiaMemoryEntry) -> Value {
    json!({
        "id": &entry.id,
        "botId": &entry.bot_id,
        "sessionId": &entry.session_id,
        "scope": &entry.scope,
        "text": &entry.text,
        "confidence": entry.confidence,
        "source": &entry.source,
        "originEngine": &entry.origin_engine,
        "originNativeSessionId": &entry.origin_native_session_id,
        "sourceMessageIds": &entry.source_message_ids,
        "linkedMemoryIds": &entry.linked_memory_ids,
        "policyResult": &entry.policy_result,
        "priority": entry.priority,
        "pinned": entry.pinned,
        "createdAt": &entry.created_at,
        "updatedAt": &entry.updated_at,
        "lastUsedAt": &entry.last_used_at,
        "expiresAt": &entry.expires_at,
        "metadata": &entry.metadata,
        "deletedAt": &entry.deleted_at,
        "revision": entry.revision,
    })
}

fn memory_sync_client_op_id(user_id: &str, since: &str, now: i64) -> String {
    let safe_user = user_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!(
        "memory-sync-{}-{}-{now}",
        if safe_user.is_empty() {
            "user"
        } else {
            safe_user.as_str()
        },
        if since.is_empty() { "full" } else { since }
    )
}

fn cloud_route_id(value: &str) -> Result<String, CloudError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CloudError::InvalidInput(
            "conversationId is required".into(),
        ));
    }
    if trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == ':' || ch == '-')
    {
        Ok(trimmed.to_string())
    } else {
        Err(CloudError::InvalidInput("conversationId is invalid".into()))
    }
}

fn cloud_task_path(task_id: &str) -> Result<String, CloudError> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Err(CloudError::InvalidInput("taskId is required".into()));
    }
    Ok(format!("/api/tasks/{}", encode_uri_component(task_id)))
}

pub(crate) fn encode_uri_component(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (*byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

fn clean_text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn clean_optional(value: &Option<String>) -> Option<String> {
    value.as_deref().and_then(clean_text)
}

fn clean_or_default<F>(value: &str, fallback: F) -> String
where
    F: FnOnce() -> String,
{
    clean_text(value).unwrap_or_else(fallback)
}

fn normalize_selected_skill_ids(values: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        let Some(id) = clean_text(value) else {
            continue;
        };
        if out.iter().any(|existing| existing == &id) {
            continue;
        }
        out.push(id);
        if out.len() >= 8 {
            break;
        }
    }
    out
}

fn safe_identifier(value: &str, fallback: &str) -> String {
    let safe = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if safe.is_empty() {
        fallback.to_string()
    } else {
        safe
    }
}

fn engine_label(engine: &str) -> &'static str {
    match normalize_agent_engine(engine).as_str() {
        "claude-code" => "Claude Code",
        "hermes" => "Hermes",
        _ => "Codex",
    }
}

fn normalize_agent_engine(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "claude" | "claude-code" | "anthropic" | "cloud-claude-code" => "claude-code".into(),
        "hermes" => "hermes".into(),
        "mock" | "mock-agent" | "mia-mock" => "mock-agent".into(),
        "codex" | "openai-codex" => "codex".into(),
        _ => "codex".into(),
    }
}

fn normalize_bridge_runtime_config(request: &CloudBridgeRunRequest) -> Value {
    let mut object = object_from_value(if request.runtime_config.is_object() {
        request.runtime_config.clone()
    } else {
        request.config.clone()
    });
    let engine = clean_optional(&request.agent_engine)
        .or_else(|| clean_optional(&request.engine))
        .or_else(|| map_string(&object, "agentEngine"))
        .or_else(|| map_string(&object, "agent_engine"))
        .unwrap_or_else(|| "codex".to_string());
    let engine = normalize_agent_engine(&engine);
    object.insert("agentEngine".into(), json!(engine.clone()));
    let runtime_kind = clean_optional(&request.runtime_kind)
        .or_else(|| map_string(&object, "runtimeKind"))
        .or_else(|| map_string(&object, "runtime_kind"))
        .map(|value| value.replace('_', "-"));
    let is_desktop_local = runtime_kind.as_deref() == Some("desktop-local");
    if let Some(runtime_kind) = runtime_kind.as_deref().filter(|value| !value.is_empty()) {
        object.insert("runtimeKind".into(), json!(runtime_kind));
    }
    promote_string_key(&mut object, "deviceId", &["device_id"]);
    promote_string_key(
        &mut object,
        "providerConnectionId",
        &["provider_connection_id"],
    );
    promote_string_key(&mut object, "modelProfileId", &["model_profile_id"]);
    promote_string_key(&mut object, "effortLevel", &["effort_level"]);
    promote_string_key(&mut object, "permissionMode", &["permission_mode"]);
    if let Some(model) = clean_optional(&request.model) {
        object.insert("model".into(), json!(canonical_mia_model_id(&model)));
    }
    if let Some(effort_level) = clean_optional(&request.effort_level) {
        object.insert("effortLevel".into(), json!(effort_level));
    }
    if let Some(permission_mode) = clean_optional(&request.permission_mode) {
        object.insert("permissionMode".into(), json!(permission_mode));
    }
    let entries = remove_model_entries(&mut object);
    if !entries.is_empty() {
        object.insert("modelEntries".into(), Value::Array(entries.clone()));
    }
    apply_desktop_local_model_entry_selection(&mut object, &entries, is_desktop_local, &engine);
    apply_mia_managed_runtime_references(&mut object, &entries, is_desktop_local);
    if !is_desktop_local
        && engine == "hermes"
        && !has_non_empty(&object, "providerConnectionId")
        && !has_non_empty(&object, "modelProfileId")
        && !has_non_empty(&object, "model")
        && let Some(entry) = entries.iter().find(|entry| is_mia_managed_entry(entry))
    {
        object.insert("providerConnectionId".into(), json!("mia"));
        if let Some(model) = map_string_value(entry, "model")
            .or_else(|| map_string_value(entry, "value"))
            .map(|model| canonical_mia_model_id(&model))
            .filter(|model| !model.is_empty())
        {
            object.insert("model".into(), json!(model.clone()));
            object.insert("modelProfileId".into(), json!(format!("mia:{model}")));
        }
    }
    sanitize_desktop_local_runtime_references(&mut object, is_desktop_local);
    for key in [
        "provider",
        "modelProvider",
        "providerLabel",
        "authType",
        "apiKeyEnv",
        "apiKey",
        "baseUrl",
        "apiMode",
        "provider_label",
        "model_provider",
        "agent_engine",
        "model_profile_id",
        "runtime_kind",
        "auth_type",
        "api_key_env",
        "api_key",
        "base_url",
        "api_mode",
        "model_entries",
    ] {
        object.remove(key);
    }
    Value::Object(object)
}

fn object_from_value(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn promote_string_key(object: &mut Map<String, Value>, target: &str, aliases: &[&str]) {
    if has_non_empty(object, target) {
        return;
    }
    for alias in aliases {
        if let Some(value) = map_string(object, alias) {
            object.insert(target.to_string(), json!(value));
            return;
        }
    }
}

fn remove_model_entries(object: &mut Map<String, Value>) -> Vec<Value> {
    let value = object
        .remove("modelEntries")
        .or_else(|| object.remove("model_entries"))
        .unwrap_or(Value::Null);
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(sanitize_model_entry)
        .collect()
}

fn sanitize_model_entry(entry: &Value) -> Option<Value> {
    let input = entry.as_object()?;
    let mut output = Map::new();
    for (target, keys) in [
        ("value", &["value", "id"][..]),
        ("label", &["label"][..]),
        ("model", &["model", "value", "id"][..]),
        (
            "provider",
            &["provider", "providerConnectionId", "provider_connection_id"][..],
        ),
        ("authType", &["authType", "auth_type"][..]),
        (
            "modelProfileId",
            &[
                "modelProfileId",
                "model_profile_id",
                "profileId",
                "profile_id",
            ][..],
        ),
    ] {
        if let Some(value) = first_entry_string(input, keys) {
            output.insert(target.to_string(), json!(value));
        }
    }
    (!output.is_empty()).then_some(Value::Object(output))
}

fn apply_mia_managed_runtime_references(
    object: &mut Map<String, Value>,
    entries: &[Value],
    is_desktop_local: bool,
) {
    let model = map_string(object, "model")
        .map(|value| canonical_mia_model_id(&value))
        .unwrap_or_default();
    if !model.is_empty() {
        object.insert("model".into(), json!(model.clone()));
    }
    let profile_id = map_string(object, "modelProfileId").unwrap_or_default();
    let provider = map_string(object, "providerConnectionId")
        .or_else(|| map_string(object, "provider"))
        .unwrap_or_default();
    let auth_type = map_string(object, "authType").unwrap_or_default();
    let selected_mia_entry = selected_model_entry_is_mia_managed(entries, &model, &profile_id);
    let has_platform_selection = has_non_empty(object, "platformProvider")
        || has_non_empty(object, "platform_provider")
        || has_non_empty(object, "platformModel")
        || has_non_empty(object, "platform_model")
        || has_non_empty(object, "platformModelProfileId")
        || has_non_empty(object, "platform_model_profile_id");
    let fallback_to_mia_entry = !is_desktop_local
        && !has_platform_selection
        && model.is_empty()
        && profile_id.is_empty()
        && provider.is_empty()
        && auth_type.is_empty()
        && entries.iter().any(is_mia_managed_entry);
    let explicit_mia_reference = !is_desktop_local
        && (provider == "mia" || auth_type == "mia_account" || profile_id.starts_with("mia:"));
    if explicit_mia_reference
        || model == "mia-auto"
        || model == "mia-default"
        || selected_mia_entry
        || fallback_to_mia_entry
    {
        object.insert("providerConnectionId".into(), json!("mia"));
        if !model.is_empty() {
            object.insert("modelProfileId".into(), json!(format!("mia:{model}")));
        } else if !profile_id.is_empty() {
            object.insert(
                "modelProfileId".into(),
                json!(canonical_mia_profile_id(&profile_id)),
            );
        } else if let Some(entry_model) = entries
            .iter()
            .find(|entry| is_mia_managed_entry(entry))
            .and_then(|entry| {
                map_string_value(entry, "model").or_else(|| map_string_value(entry, "value"))
            })
            .map(|value| canonical_mia_model_id(&value))
            .filter(|value| !value.is_empty())
        {
            object.insert("model".into(), json!(entry_model.clone()));
            object.insert("modelProfileId".into(), json!(format!("mia:{entry_model}")));
        }
    }
}

fn apply_desktop_local_model_entry_selection(
    object: &mut Map<String, Value>,
    entries: &[Value],
    is_desktop_local: bool,
    engine: &str,
) {
    if !is_desktop_local {
        return;
    }
    let Some(model) = map_string(object, "model") else {
        return;
    };
    let Some(entry) = entries.iter().find(|entry| {
        first_entry_value(entry, &["model", "value", "id"]).as_deref() == Some(model.as_str())
    }) else {
        return;
    };
    if is_mia_managed_entry(entry) {
        return;
    }

    for key in [
        "platformProvider",
        "platform_provider",
        "platformModel",
        "platform_model",
        "platformModelProfileId",
        "platform_model_profile_id",
    ] {
        object.remove(key);
    }
    let provider = first_entry_value(
        entry,
        &["providerConnectionId", "provider_connection_id", "provider"],
    )
    .unwrap_or_else(|| engine.to_string());
    let profile_id = first_entry_value(
        entry,
        &[
            "modelProfileId",
            "model_profile_id",
            "profileId",
            "profile_id",
        ],
    )
    .unwrap_or_else(|| format!("{provider}:{model}"));
    object.insert("providerConnectionId".into(), json!(provider));
    object.insert("modelProfileId".into(), json!(profile_id));
}

fn sanitize_desktop_local_runtime_references(
    object: &mut Map<String, Value>,
    is_desktop_local: bool,
) {
    if !is_desktop_local {
        return;
    }
    let model = map_string(object, "model")
        .map(|value| canonical_mia_model_id(&value))
        .unwrap_or_default();
    let profile_id = map_string(object, "modelProfileId").unwrap_or_default();
    let is_mia_platform_reference = map_string(object, "providerConnectionId").as_deref()
        == Some("mia")
        || profile_id.starts_with("mia:")
        || matches!(model.as_str(), "mia-auto" | "mia-default");
    if is_mia_platform_reference {
        object.insert("platformProvider".into(), json!("mia"));
        let platform_model = if !model.is_empty() {
            model.clone()
        } else if let Some((provider, profile_model)) = profile_id.split_once(':') {
            if provider == "mia" && !profile_model.trim().is_empty() {
                canonical_mia_model_id(profile_model)
            } else {
                "mia-auto".into()
            }
        } else {
            "mia-auto".into()
        };
        object.insert("platformModel".into(), json!(platform_model.clone()));
        object.insert(
            "platformModelProfileId".into(),
            json!(format!("mia:{platform_model}")),
        );
    }
    if map_string(object, "providerConnectionId").as_deref() == Some("mia") {
        object.remove("providerConnectionId");
    }
    if profile_id.starts_with("mia:") {
        object.remove("modelProfileId");
    }
    if matches!(model.as_str(), "mia-auto" | "mia-default") {
        object.remove("model");
    }
}

fn selected_model_entry_is_mia_managed(entries: &[Value], model: &str, profile_id: &str) -> bool {
    if model.is_empty() && profile_id.is_empty() {
        return false;
    }
    let mut matched_mia_entry = false;
    for entry in entries {
        let entry_model = map_string_value(entry, "model")
            .or_else(|| map_string_value(entry, "value"))
            .map(|value| canonical_mia_model_id(&value))
            .unwrap_or_default();
        let entry_profile = map_string_value(entry, "modelProfileId")
            .map(|value| canonical_mia_profile_id(&value))
            .unwrap_or_default();
        let matches = (!model.is_empty() && entry_model == model)
            || (!profile_id.is_empty() && entry_profile == profile_id);
        if !matches {
            continue;
        }
        if !is_mia_managed_entry(entry) {
            return false;
        }
        matched_mia_entry = true;
    }
    matched_mia_entry
}

fn is_mia_managed_entry(entry: &Value) -> bool {
    map_string_value(entry, "provider").as_deref() == Some("mia")
        || map_string_value(entry, "authType").as_deref() == Some("mia_account")
        || map_string_value(entry, "modelProfileId").is_some_and(|value| value.starts_with("mia:"))
        || map_string_value(entry, "model")
            .map(|value| canonical_mia_model_id(&value))
            .as_deref()
            == Some("mia-auto")
}

fn canonical_mia_model_id(value: &str) -> String {
    let value = value.trim();
    if value == "mia-default" {
        "mia-auto".to_string()
    } else {
        value.to_string()
    }
}

fn canonical_mia_profile_id(value: &str) -> String {
    let value = value.trim();
    if value == "mia:mia-default" {
        "mia:mia-auto".to_string()
    } else {
        value.to_string()
    }
}

fn map_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn map_string_value(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn first_entry_value(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| map_string_value(value, key))
}

fn first_entry_string(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| map_string(object, key))
}

fn has_non_empty(object: &Map<String, Value>, key: &str) -> bool {
    object
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn normalize_cloud_settings(value: Value) -> Value {
    let input = value.as_object().cloned().unwrap_or_default();
    let token = input
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let enabled = input
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && !token.is_empty();
    let user = if enabled {
        input.get("user").filter(|value| value.is_object()).cloned()
    } else {
        None
    };
    let agent_runtime = if enabled {
        input
            .get("agentRuntime")
            .filter(|value| value.is_object())
            .cloned()
    } else {
        None
    };
    json!({
        "enabled": enabled,
        "url": normalize_cloud_url(input.get("url").and_then(Value::as_str)),
        "token": if enabled { token } else { String::new() },
        "user": user.unwrap_or(Value::Null),
        "agentRuntime": agent_runtime.unwrap_or(Value::Null),
        "lastEventSeq": input.get("lastEventSeq").and_then(Value::as_i64).unwrap_or(0),
        "lastMemorySyncAt": input.get("lastMemorySyncAt").and_then(Value::as_str).unwrap_or(""),
        "logs": input.get("logs").and_then(Value::as_array).cloned().unwrap_or_default()
    })
}

fn default_cloud_settings() -> Value {
    json!({
        "enabled": false,
        "url": DEFAULT_CLOUD_URL,
        "token": "",
        "user": null,
        "agentRuntime": null,
        "lastEventSeq": 0,
        "lastMemorySyncAt": "",
        "logs": []
    })
}

fn default_user_settings() -> Value {
    json!({
        "pins": [],
        "readMarks": {},
        "appearance": {},
        "mutedConversations": [],
        "unreadOverrides": {},
        "tags": { "items": [], "assignments": {} },
        "starterEngineBots": {},
        "version": 1
    })
}

fn normalize_user_settings(value: Value) -> Result<Value, CloudError> {
    let mut object = value
        .as_object()
        .cloned()
        .ok_or_else(|| CloudError::InvalidInput("settings must be an object".into()))?;
    let defaults = default_user_settings()
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (key, value) in defaults {
        object.entry(key).or_insert(value);
    }
    Ok(Value::Object(object))
}

pub(crate) fn normalize_cloud_url(value: Option<&str>) -> String {
    let mut raw = value.unwrap_or(DEFAULT_CLOUD_URL).trim().to_string();
    if raw.is_empty() {
        raw = DEFAULT_CLOUD_URL.to_string();
    }
    if !(raw.starts_with("https://") || raw.starts_with("http://")) {
        return DEFAULT_CLOUD_URL.to_string();
    }
    while raw.ends_with('/') {
        raw.pop();
    }
    if raw == "http:" || raw == "https:" {
        DEFAULT_CLOUD_URL.to_string()
    } else {
        raw
    }
}

fn account_from_hint(account_hint: Option<&str>) -> Option<Value> {
    let hint = account_hint?.trim();
    if hint.is_empty() {
        return None;
    }
    Some(json!({ "id": hint }))
}

fn set_object_field(value: &mut Value, key: &str, field_value: Value) {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    if let Value::Object(object) = value {
        object.insert(key.to_string(), field_value);
    }
}

pub(crate) fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

pub(crate) fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn parse_json(raw: String) -> Result<Value, CloudError> {
    serde_json::from_str(&raw).map_err(|error| CloudError::InvalidInput(error.to_string()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
