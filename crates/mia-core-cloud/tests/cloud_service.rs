use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mia_core_api_types::{
    CloudBridgeCancelRequest, CloudBridgeCancelResponse, CloudBridgeRunRequest,
    CloudBridgeRunResponse, CloudBridgeStartRequest, CloudConnectRequest, CloudMemorySyncRequest,
    PutCloudSettingsRequest,
};
use mia_core_cloud::{
    CloudBridgeConnectionSpec, CloudBridgeManager, CloudBridgeRunHandler, CloudBridgeSocketCommand,
    CloudBridgeSocketEvent, CloudBridgeSocketTransport, CloudError, CloudEventsManager,
    CloudMemoryTransport, CloudService,
};
use mia_core_db::init_database_memory;
use mia_core_memory::MemoryService;
use serde_json::json;
use sqlx::Row;
use tokio::sync::mpsc;
use tokio::time::{Duration, sleep};

#[derive(Clone, Default)]
struct MockMemoryTransport {
    calls: Arc<Mutex<Vec<(String, String, serde_json::Value)>>>,
    responses: Arc<Mutex<Vec<serde_json::Value>>>,
}

impl MockMemoryTransport {
    fn with_responses(responses: Vec<serde_json::Value>) -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            responses: Arc::new(Mutex::new(responses)),
        }
    }

    fn calls(&self) -> Vec<(String, String, serde_json::Value)> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl CloudMemoryTransport for MockMemoryTransport {
    async fn post_json(
        &self,
        _base_url: &str,
        _token: &str,
        path: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, CloudError> {
        self.calls
            .lock()
            .unwrap()
            .push(("POST".into(), path.into(), body));
        Ok(self.responses.lock().unwrap().remove(0))
    }

    async fn get_json(
        &self,
        _base_url: &str,
        _token: &str,
        path: &str,
    ) -> Result<serde_json::Value, CloudError> {
        self.calls
            .lock()
            .unwrap()
            .push(("GET".into(), path.into(), json!(null)));
        Ok(self.responses.lock().unwrap().remove(0))
    }
}

#[derive(Clone, Default)]
struct MockBridgeRunner {
    runs: Arc<Mutex<Vec<CloudBridgeRunRequest>>>,
    cancels: Arc<Mutex<Vec<CloudBridgeCancelRequest>>>,
    busy_before_success: Arc<Mutex<usize>>,
    run_delay: Duration,
}

impl MockBridgeRunner {
    fn with_busy_before_success(count: usize) -> Self {
        Self {
            busy_before_success: Arc::new(Mutex::new(count)),
            ..Default::default()
        }
    }

    fn with_run_delay(run_delay: Duration) -> Self {
        Self {
            run_delay,
            ..Default::default()
        }
    }
}

#[async_trait]
impl CloudBridgeRunHandler for MockBridgeRunner {
    async fn run(
        &self,
        request: CloudBridgeRunRequest,
    ) -> Result<CloudBridgeRunResponse, CloudError> {
        self.runs.lock().unwrap().push(request.clone());
        let should_report_busy = {
            let mut busy_before_success = self.busy_before_success.lock().unwrap();
            if *busy_before_success > 0 {
                *busy_before_success -= 1;
                true
            } else {
                false
            }
        };
        if should_report_busy {
            return Err(CloudError::Busy(format!(
                "conversation {} is already running turn turn_busy",
                request.conversation_id
            )));
        }
        if !self.run_delay.is_zero() {
            sleep(self.run_delay).await;
        }
        Ok(CloudBridgeRunResponse {
            ok: true,
            run_id: request.run_id,
            conversation_id: "cloud_bridge_c_1".into(),
            cloud_conversation_id: request.conversation_id,
            message_id: "msg_1".into(),
            turn_id: "turn_1".into(),
            assistant_message_id: Some("msg_2".into()),
            text: "done by core".into(),
            attachments: json!([{ "id": "att_1" }]),
            trace: json!({ "reasoning": "checked" }),
            content_blocks: json!([{ "type": "thinking", "id": "think_1", "text": "checked", "status": "completed" }]),
        })
    }

    async fn cancel(
        &self,
        request: CloudBridgeCancelRequest,
    ) -> Result<CloudBridgeCancelResponse, CloudError> {
        self.cancels.lock().unwrap().push(request.clone());
        Ok(CloudBridgeCancelResponse {
            ok: true,
            cancelled: true,
            run_id: request.run_id,
        })
    }
}

#[derive(Clone, Default)]
struct MockBridgeTransport {
    events: Arc<Mutex<Vec<CloudBridgeSocketEvent>>>,
    specs: Arc<Mutex<Vec<CloudBridgeConnectionSpec>>>,
    commands: Arc<Mutex<Vec<CloudBridgeSocketCommand>>>,
}

#[async_trait]
impl CloudBridgeSocketTransport for MockBridgeTransport {
    async fn run(
        &self,
        spec: CloudBridgeConnectionSpec,
        events: mpsc::Sender<CloudBridgeSocketEvent>,
        mut commands: mpsc::Receiver<CloudBridgeSocketCommand>,
    ) -> Result<(), CloudError> {
        self.specs.lock().unwrap().push(spec);
        let scripted = self.events.lock().unwrap().clone();
        for event in scripted {
            let _ = events.send(event).await;
        }
        while let Some(command) = commands.recv().await {
            self.commands.lock().unwrap().push(command);
        }
        Ok(())
    }
}

#[tokio::test]
async fn cloud_service_defaults_to_signed_out_public_status() {
    let database = init_database_memory().await.unwrap();
    let service = CloudService::with_now(database.pool().clone(), || 1000);

    let status = service.status(false).await.unwrap();

    assert!(!status.enabled);
    assert!(!status.connected);
    assert_eq!(status.url, "https://mia.gifgif.cn");
    assert_eq!(status.user, None);
    assert_eq!(status.account, None);
    assert_eq!(status.token, None);
    assert_eq!(status.events["lastEventSeq"], 0);
}

#[tokio::test]
async fn cloud_service_connects_and_redacts_token_by_default() {
    let database = init_database_memory().await.unwrap();
    let service = CloudService::with_now(database.pool().clone(), || 1000);

    let connected = service
        .connect(CloudConnectRequest {
            url: Some("https://mia.example/".into()),
            token: Some("secret-token".into()),
            account_hint: None,
            user: Some(json!({ "id": "u1", "displayName": "Jung" })),
            account: None,
            agent_runtime: Some(json!({ "engine": "codex" })),
            last_event_seq: Some(42),
            last_memory_sync_at: Some("2026-07-07T00:00:00Z".into()),
        })
        .await
        .unwrap();

    assert!(connected.status.enabled);
    assert_eq!(connected.status.token, None);
    assert_eq!(connected.status.url, "https://mia.example");
    assert_eq!(connected.status.user.as_ref().unwrap()["id"], "u1");
    assert_eq!(
        connected.status.agent_runtime.as_ref().unwrap()["engine"],
        "codex"
    );

    let public_status = service.status(false).await.unwrap();
    assert_eq!(public_status.token, None);
    assert_eq!(public_status.events["lastEventSeq"], 42);

    let private_status = service.status(true).await.unwrap();
    assert_eq!(private_status.token.as_deref(), Some("secret-token"));
}

#[tokio::test]
async fn cloud_service_connect_is_idempotent_for_unchanged_settings() {
    let database = init_database_memory().await.unwrap();
    let now = Arc::new(Mutex::new(1000_i64));
    let service = CloudService::with_now(database.pool().clone(), {
        let now = now.clone();
        move || *now.lock().unwrap()
    });
    let request = CloudConnectRequest {
        url: Some("https://mia.example/".into()),
        token: Some("secret-token".into()),
        account_hint: None,
        user: Some(json!({ "id": "u1", "displayName": "Jung" })),
        account: None,
        agent_runtime: Some(json!({ "engine": "codex" })),
        last_event_seq: Some(42),
        last_memory_sync_at: Some("2026-07-07T00:00:00Z".into()),
    };

    service.connect(request.clone()).await.unwrap();
    let first_updated_at: i64 =
        sqlx::query("SELECT updated_at FROM cloud_state WHERE key = 'settings'")
            .fetch_one(database.pool())
            .await
            .unwrap()
            .get("updated_at");
    *now.lock().unwrap() = 2000;
    service.connect(request).await.unwrap();
    let second_updated_at: i64 =
        sqlx::query("SELECT updated_at FROM cloud_state WHERE key = 'settings'")
            .fetch_one(database.pool())
            .await
            .unwrap()
            .get("updated_at");

    assert_eq!(first_updated_at, 1000);
    assert_eq!(second_updated_at, first_updated_at);
}

#[tokio::test]
async fn cloud_service_disconnect_clears_credentials_and_runtime() {
    let database = init_database_memory().await.unwrap();
    let service = CloudService::with_now(database.pool().clone(), || 1000);
    service
        .connect(CloudConnectRequest {
            url: None,
            token: Some("secret-token".into()),
            account_hint: Some("user_hint".into()),
            user: None,
            account: None,
            agent_runtime: Some(json!({ "engine": "codex" })),
            last_event_seq: Some(7),
            last_memory_sync_at: None,
        })
        .await
        .unwrap();

    let status = service.disconnect().await.unwrap();

    assert!(!status.enabled);
    assert!(!status.connected);
    assert_eq!(status.user, None);
    assert_eq!(status.agent_runtime, None);
    assert_eq!(status.token, None);
    assert_eq!(status.events["lastEventSeq"], 0);
    assert_eq!(
        service.status(true).await.unwrap().token.as_deref(),
        Some("")
    );
}

#[tokio::test]
async fn cloud_service_owns_user_cloud_settings_bag() {
    let database = init_database_memory().await.unwrap();
    let service = CloudService::with_now(database.pool().clone(), || 1000);

    let defaults = service.user_settings().await.unwrap().settings;
    assert_eq!(defaults["pins"], json!([]));
    assert_eq!(defaults["readMarks"], json!({}));
    assert_eq!(defaults["tags"], json!({ "items": [], "assignments": {} }));

    let stored = service
        .put_user_settings(PutCloudSettingsRequest {
            settings: json!({
                "pins": ["conversation_1"],
                "readMarks": { "conversation_1": 10 },
                "tags": {
                    "items": [{ "id": "tag_1", "name": "Work" }],
                    "assignments": { "conversation_1": ["tag_1"] }
                }
            }),
        })
        .await
        .unwrap()
        .settings;

    assert_eq!(stored["pins"], json!(["conversation_1"]));
    assert_eq!(stored["mutedConversations"], json!([]));
    assert_eq!(stored["starterEngineBots"], json!({}));
    assert_eq!(
        service.user_settings().await.unwrap().settings["tags"]["assignments"]["conversation_1"],
        json!(["tag_1"])
    );
}

#[tokio::test]
async fn cloud_service_syncs_memory_through_core_memory_store_and_advances_cursor() {
    let database = init_database_memory().await.unwrap();
    let transport = MockMemoryTransport::with_responses(vec![
        json!({
            "memories": [],
            "conflicts": [{
                "id": "mem_conflict",
                "botId": "mei",
                "scope": "bot",
                "text": "Cloud has a newer conflict memory",
                "updatedAt": "2026-01-03T00:00:00.000Z",
                "revision": 4
            }],
            "errors": [],
        }),
        json!({
            "memories": [{
                "id": "mem_remote",
                "botId": "mei",
                "scope": "bot",
                "text": "Remote memory pulled by Rust Core",
                "updatedAt": "2026-01-05T00:00:00.000Z",
                "revision": 1
            }],
            "serverTime": "2026-01-05T00:00:00.000Z"
        }),
    ]);
    let service =
        CloudService::with_memory_transport(database.pool().clone(), || 123456, transport.clone());
    service
        .connect(CloudConnectRequest {
            url: Some("https://mia.example/".into()),
            token: Some("secret-token".into()),
            account_hint: None,
            user: Some(json!({ "id": "u1" })),
            account: None,
            agent_runtime: None,
            last_event_seq: None,
            last_memory_sync_at: Some("2026-01-01T00:00:00.000Z".into()),
        })
        .await
        .unwrap();
    let memory = MemoryService::new(database.pool().clone());
    memory
        .apply_synced_memories(
            "u1",
            &[json!({
                "id": "mem_local",
                "botId": "mei",
                "scope": "bot",
                "text": "Local memory pushed by Rust Core",
                "updatedAt": "2026-01-02T00:00:00.000Z",
                "revision": 2
            })],
            true,
        )
        .await
        .unwrap();

    let summary = service
        .sync_memories(CloudMemorySyncRequest {
            full: None,
            limit: Some(1000),
        })
        .await
        .unwrap();

    assert!(summary.ok);
    assert!(!summary.skipped);
    assert_eq!(summary.pushed, 0);
    assert_eq!(summary.pulled, 2);
    assert_eq!(summary.conflicts, 1);
    assert_eq!(summary.errors, 0);
    assert_eq!(summary.server_time, "2026-01-05T00:00:00.000Z");
    let calls = transport.calls();
    assert_eq!(calls[0].0, "POST");
    assert_eq!(calls[0].1, "/api/me/memory/push");
    assert_eq!(calls[0].2["entries"][0]["id"], "mem_local");
    assert_eq!(
        calls[1].1,
        "/api/me/memory?since=2026-01-01T00%3A00%3A00.000Z"
    );

    let listed = memory.list_sync_memories("u1", "", true, 10).await.unwrap();
    assert!(listed.iter().any(|entry| entry.id == "mem_conflict"));
    assert!(listed.iter().any(|entry| entry.id == "mem_remote"));
    let row = sqlx::query("SELECT value_json FROM cloud_state WHERE key = 'settings'")
        .fetch_one(database.pool())
        .await
        .unwrap();
    let stored: serde_json::Value =
        serde_json::from_str(&row.get::<String, _>("value_json")).unwrap();
    assert_eq!(stored["lastMemorySyncAt"], "2026-01-05T00:00:00.000Z");
}

#[tokio::test]
async fn cloud_service_posts_bot_messages_to_cloud_conversations() {
    let database = init_database_memory().await.unwrap();
    let transport = MockMemoryTransport::with_responses(vec![json!({
        "message": { "id": "m_bot", "body_md": "done" }
    })]);
    let service =
        CloudService::with_memory_transport(database.pool().clone(), || 123456, transport.clone());
    service
        .connect(CloudConnectRequest {
            url: Some("https://mia.example/".into()),
            token: Some("secret-token".into()),
            account_hint: None,
            user: Some(json!({ "id": "u1" })),
            account: None,
            agent_runtime: None,
            last_event_seq: None,
            last_memory_sync_at: None,
        })
        .await
        .unwrap();

    let result = service
        .post_conversation_message_as_bot(
            "botc_1",
            json!({
                "botId": "bot_codex",
                "bodyMd": "done",
                "clientOpId": "op_1"
            }),
        )
        .await
        .unwrap();

    assert_eq!(result["message"]["id"], "m_bot");
    assert_eq!(
        transport.calls(),
        vec![(
            "POST".into(),
            "/api/conversations/botc_1/messages/as-bot".into(),
            json!({
                "botId": "bot_codex",
                "bodyMd": "done",
                "clientOpId": "op_1"
            })
        )]
    );
}

#[tokio::test]
async fn cloud_service_prepares_bridge_run_without_leaking_runtime_secrets() {
    let database = init_database_memory().await.unwrap();
    let service = CloudService::with_now(database.pool().clone(), || 123456);

    let prepared = service
        .prepare_bridge_run(CloudBridgeRunRequest {
            run_id: "run/one".into(),
            conversation_id: "cloud:conversation/one".into(),
            text: "use managed runtime".into(),
            bot_id: "helper".into(),
            bot_name: "Helper".into(),
            runtime_config: json!({
                "agentEngine": "hermes",
                "model": "",
                "effortLevel": "medium",
                "permissionMode": "ask",
                "baseUrl": "https://should-not-cross.example/v1",
                "apiKeyEnv": "SHOULD_NOT_CROSS",
                "apiMode": "responses",
                "providerLabel": "Should Not Cross",
                "authType": "api_key",
                "modelEntries": [{
                    "value": "mia-auto",
                    "model": "mia-auto",
                    "provider": "mia",
                    "authType": "mia_account",
                    "modelProfileId": "mia:mia-auto"
                }]
            }),
            ..Default::default()
        })
        .unwrap();

    assert_eq!(
        prepared.local_conversation_id,
        "cloud_bridge_cloud_conversation_one"
    );
    assert_eq!(prepared.runtime["agentEngine"], "hermes");
    assert_eq!(prepared.runtime["providerConnectionId"], "mia");
    assert_eq!(prepared.runtime["model"], "mia-auto");
    assert_eq!(prepared.runtime["modelProfileId"], "mia:mia-auto");
    assert_eq!(prepared.runtime["effortLevel"], "medium");
    assert_eq!(prepared.runtime["permissionMode"], "ask");
    assert!(prepared.runtime.get("baseUrl").is_none());
    assert!(prepared.runtime.get("apiKeyEnv").is_none());
    assert!(prepared.runtime.get("apiMode").is_none());
    assert!(prepared.runtime.get("providerLabel").is_none());
    assert!(prepared.runtime.get("authType").is_none());
    assert_eq!(
        prepared.metadata["cloudBridge"]["conversationId"],
        "cloud:conversation/one"
    );
}

#[tokio::test]
async fn cloud_bridge_manager_owns_socket_envelope_lifecycle() {
    let database = init_database_memory().await.unwrap();
    let service = CloudService::with_now(database.pool().clone(), || 123456);
    service
        .connect(CloudConnectRequest {
            url: Some("https://mia.example/".into()),
            token: Some("secret-token".into()),
            account_hint: None,
            user: Some(json!({ "id": "u1" })),
            account: None,
            agent_runtime: None,
            last_event_seq: None,
            last_memory_sync_at: None,
        })
        .await
        .unwrap();
    let runner = Arc::new(MockBridgeRunner::default());
    let transport = Arc::new(MockBridgeTransport {
        events: Arc::new(Mutex::new(vec![
            CloudBridgeSocketEvent::Open,
            CloudBridgeSocketEvent::Text(
                json!({ "type": "bridge_ready", "deviceId": "device_core" }).to_string(),
            ),
            CloudBridgeSocketEvent::Text(
                json!({
                    "type": "run",
                    "runId": "run_1",
                    "conversationId": "cloud_conv_1",
                    "text": "hello core",
                    "runtimeConfig": { "agentEngine": "mock-agent" }
                })
                .to_string(),
            ),
        ])),
        ..Default::default()
    });
    let manager = CloudBridgeManager::with_transport(
        service,
        runner.clone(),
        transport.clone(),
        Duration::from_millis(10),
        Duration::from_secs(60),
    );

    let started = manager
        .start(CloudBridgeStartRequest {
            device_id: "device_core".into(),
            device_name: "Office Mac".into(),
            engine: "mock-agent".into(),
            capabilities: json!({ "chat": true, "engines": ["mock-agent"] }),
        })
        .await
        .unwrap();
    assert!(started.status.enabled);
    assert!(started.status.connecting || started.status.connected);

    for _ in 0..50 {
        if !transport.commands.lock().unwrap().is_empty() {
            break;
        }
        sleep(Duration::from_millis(10)).await;
    }

    let specs = transport.specs.lock().unwrap().clone();
    assert_eq!(specs.len(), 1);
    assert!(specs[0].url.starts_with("wss://mia.example/api/bridge?"));
    assert!(specs[0].url.contains("deviceId=device_core"));
    assert_eq!(specs[0].protocols, vec!["mia-token.secret-token"]);
    let runs = runner.runs.lock().unwrap().clone();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].run_id, "run_1");
    assert_eq!(runs[0].conversation_id, "cloud_conv_1");
    assert_eq!(runs[0].runtime_config["agentEngine"], "mock-agent");
    let commands = transport.commands.lock().unwrap().clone();
    assert!(commands.iter().any(|command| {
        matches!(command, CloudBridgeSocketCommand::Text(text) if text.contains("\"type\":\"run_result\"") && text.contains("done by core"))
    }));
    let status = manager.status(false).await.unwrap();
    assert!(status.connected);
    assert!(!status.connecting);
    assert_eq!(status.device_id, "device_core");

    let repeated_start = manager
        .start(CloudBridgeStartRequest {
            device_id: "device_core".into(),
            device_name: "Office Mac".into(),
            engine: "mock-agent".into(),
            capabilities: json!({ "chat": true, "engines": ["mock-agent"] }),
        })
        .await
        .unwrap();
    assert!(repeated_start.status.connected);
    assert!(!repeated_start.status.connecting);
    assert_eq!(transport.specs.lock().unwrap().len(), 1);

    manager.stop().await.unwrap();
}

#[tokio::test]
async fn cloud_events_manager_owns_remote_socket_cursor_and_fanout() {
    let database = init_database_memory().await.unwrap();
    let service = CloudService::with_now(database.pool().clone(), || 123456);
    service
        .connect(CloudConnectRequest {
            url: Some("https://mia.example/".into()),
            token: Some("secret-token".into()),
            account_hint: None,
            user: Some(json!({ "id": "u1" })),
            account: None,
            agent_runtime: None,
            last_event_seq: Some(3),
            last_memory_sync_at: None,
        })
        .await
        .unwrap();
    let transport = Arc::new(MockBridgeTransport {
        events: Arc::new(Mutex::new(vec![
            CloudBridgeSocketEvent::Open,
            CloudBridgeSocketEvent::Text(
                json!({ "type": "events_ready", "sinceSeq": 3, "serverSeq": 8 }).to_string(),
            ),
            CloudBridgeSocketEvent::Text(
                json!({
                    "type": "conversation.message_appended",
                    "seq": 4,
                    "conversationId": "g_1",
                    "message": { "id": "m_4", "body_md": "hello" }
                })
                .to_string(),
            ),
            CloudBridgeSocketEvent::Text(
                json!({
                    "type": "user.profile_updated",
                    "seq": 5,
                    "user": { "id": "u2", "username": "jung" }
                })
                .to_string(),
            ),
        ])),
        ..Default::default()
    });
    let emitted = Arc::new(Mutex::new(Vec::<(String, serde_json::Value)>::new()));
    let emitted_for_manager = emitted.clone();
    let manager = CloudEventsManager::with_transport(
        service.clone(),
        transport.clone(),
        Arc::new(move |name, payload| {
            emitted_for_manager.lock().unwrap().push((name, payload));
        }),
        Duration::from_millis(10),
        Duration::from_secs(60),
        Duration::from_secs(60),
    );

    let started = manager.start().await.unwrap();
    assert!(started.status.enabled);
    assert!(
        started.status.events["connecting"]
            .as_bool()
            .unwrap_or(false)
            || started.status.events["connected"]
                .as_bool()
                .unwrap_or(false)
    );

    for _ in 0..50 {
        if emitted.lock().unwrap().len() >= 3 {
            break;
        }
        sleep(Duration::from_millis(10)).await;
    }

    let specs = transport.specs.lock().unwrap().clone();
    assert_eq!(specs.len(), 1);
    assert_eq!(specs[0].url, "wss://mia.example/api/events?since_seq=3");
    assert_eq!(specs[0].protocols, vec!["mia-token.secret-token"]);
    let emitted = emitted.lock().unwrap().clone();
    assert_eq!(
        emitted
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        vec![
            "events_ready",
            "conversation.message_appended",
            "user.profile_updated"
        ]
    );
    assert!(
        emitted[0].1["cloud"]["events"]["connected"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(
        manager.status(false).await.unwrap().events["lastEventSeq"],
        5
    );
    let repeated_start = manager.start().await.unwrap();
    assert!(
        repeated_start.status.events["connected"]
            .as_bool()
            .unwrap_or(false)
    );
    assert!(
        !repeated_start.status.events["connecting"]
            .as_bool()
            .unwrap_or(true)
    );
    assert_eq!(transport.specs.lock().unwrap().len(), 1);
    let status = service.status(false).await.unwrap();
    assert_eq!(status.events["lastEventSeq"], 5);
    assert_eq!(status.user.as_ref().unwrap()["id"], "u2");

    manager.stop().await.unwrap();
}

#[tokio::test]
async fn cloud_events_manager_runs_desktop_bot_invocations_and_posts_reply() {
    let database = init_database_memory().await.unwrap();
    let http_transport = MockMemoryTransport::with_responses(vec![json!({
        "message": { "id": "m_reply", "body_md": "done by core" }
    })]);
    let service = CloudService::with_memory_transport(
        database.pool().clone(),
        || 123456,
        http_transport.clone(),
    );
    service
        .connect(CloudConnectRequest {
            url: Some("https://mia.example/".into()),
            token: Some("secret-token".into()),
            account_hint: None,
            user: Some(json!({ "id": "u1" })),
            account: None,
            agent_runtime: None,
            last_event_seq: Some(7),
            last_memory_sync_at: None,
        })
        .await
        .unwrap();
    let socket_transport = Arc::new(MockBridgeTransport {
        events: Arc::new(Mutex::new(vec![
            CloudBridgeSocketEvent::Open,
            CloudBridgeSocketEvent::Text(
                json!({ "type": "events_ready", "sinceSeq": 7, "serverSeq": 8 }).to_string(),
            ),
            CloudBridgeSocketEvent::Text(
                json!({
                    "type": "conversation.bot_invocation_requested",
                    "seq": 8,
                    "conversationId": "botc_1",
                    "botId": "bot_codex",
                    "runtimeKind": "desktop-local",
                    "runtimeConfig": {
                        "agentEngine": "codex",
                        "model": "mia-auto",
                        "effortLevel": "medium"
                    },
                    "triggeringMessage": {
                        "id": "m_user",
                        "body_md": "hi",
                        "attachments_json": "[{\"id\":\"att_1\"}]"
                    },
                    "members": [{
                        "member_kind": "bot",
                        "member_ref": "bot_codex",
                        "identity": { "displayName": "Codex" }
                    }]
                })
                .to_string(),
            ),
        ])),
        ..Default::default()
    });
    let runner = Arc::new(MockBridgeRunner::default());
    let manager = CloudEventsManager::with_transport_and_desktop_runner(
        service.clone(),
        socket_transport,
        Arc::new(|_, _| {}),
        Some(runner.clone()),
        Duration::from_millis(10),
        Duration::from_secs(60),
        Duration::from_secs(60),
    );

    manager.start().await.unwrap();
    for _ in 0..50 {
        if !http_transport.calls().is_empty() {
            break;
        }
        sleep(Duration::from_millis(10)).await;
    }

    let runs = runner.runs.lock().unwrap().clone();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].run_id, "cloud_evt_8_botc_1_bot_codex_m_user");
    assert_eq!(runs[0].conversation_id, "botc_1");
    assert_eq!(runs[0].bot_id, "bot_codex");
    assert_eq!(runs[0].bot_name, "Codex");
    assert_eq!(runs[0].text, "hi");
    assert_eq!(runs[0].attachments, json!([{ "id": "att_1" }]));
    assert_eq!(runs[0].runtime_config["agentEngine"], "codex");
    assert_eq!(runs[0].model.as_deref(), Some("mia-auto"));

    assert_eq!(
        http_transport.calls(),
        vec![(
            "POST".into(),
            "/api/conversations/botc_1/messages/as-bot".into(),
            json!({
                "botId": "bot_codex",
                "bodyMd": "done by core",
                "attachments": [{ "id": "att_1" }],
                "trace": { "reasoning": "checked" },
                "contentBlocks": [{ "type": "thinking", "id": "think_1", "text": "checked", "status": "completed" }],
                "turnId": "turn_1",
                "clientOpId": "core-cloud-invocation-cloud_evt_8_botc_1_bot_codex_m_user"
            })
        )]
    );
    assert_eq!(
        manager.status(false).await.unwrap().events["lastEventSeq"],
        8
    );
    manager.stop().await.unwrap();
}

#[tokio::test]
async fn cloud_events_manager_deduplicates_replayed_desktop_bot_invocations() {
    let database = init_database_memory().await.unwrap();
    let http_transport = MockMemoryTransport::with_responses(vec![json!({
        "message": { "id": "m_reply", "body_md": "done by core" }
    })]);
    let service = CloudService::with_memory_transport(
        database.pool().clone(),
        || 123456,
        http_transport.clone(),
    );
    service
        .connect(CloudConnectRequest {
            url: Some("https://mia.example/".into()),
            token: Some("secret-token".into()),
            account_hint: None,
            user: Some(json!({ "id": "u1" })),
            account: None,
            agent_runtime: None,
            last_event_seq: Some(7),
            last_memory_sync_at: None,
        })
        .await
        .unwrap();
    let invocation = json!({
        "type": "conversation.bot_invocation_requested",
        "seq": 8,
        "conversationId": "botc_1",
        "botId": "bot_codex",
        "runtimeKind": "desktop-local",
        "runtimeConfig": { "agentEngine": "codex" },
        "triggeringMessage": { "id": "m_user", "body_md": "hi" },
        "members": [{
            "member_kind": "bot",
            "member_ref": "bot_codex",
            "identity": { "displayName": "Codex" }
        }]
    });
    let socket_transport = Arc::new(MockBridgeTransport {
        events: Arc::new(Mutex::new(vec![
            CloudBridgeSocketEvent::Open,
            CloudBridgeSocketEvent::Text(
                json!({ "type": "events_ready", "sinceSeq": 7, "serverSeq": 8 }).to_string(),
            ),
            CloudBridgeSocketEvent::Text(invocation.to_string()),
            CloudBridgeSocketEvent::Text(invocation.to_string()),
        ])),
        ..Default::default()
    });
    let runner = Arc::new(MockBridgeRunner::with_run_delay(Duration::from_millis(50)));
    let manager = CloudEventsManager::with_transport_and_desktop_runner(
        service,
        socket_transport,
        Arc::new(|_, _| {}),
        Some(runner.clone()),
        Duration::from_millis(10),
        Duration::from_secs(60),
        Duration::from_secs(60),
    );

    manager.start().await.unwrap();
    for _ in 0..50 {
        if !http_transport.calls().is_empty() {
            break;
        }
        sleep(Duration::from_millis(10)).await;
    }

    assert_eq!(runner.runs.lock().unwrap().len(), 1);
    assert_eq!(http_transport.calls().len(), 1);
    manager.stop().await.unwrap();
}

#[tokio::test]
async fn cloud_events_manager_retries_desktop_bot_invocation_while_runtime_is_busy() {
    let database = init_database_memory().await.unwrap();
    let http_transport = MockMemoryTransport::with_responses(vec![json!({
        "message": { "id": "m_reply", "body_md": "done by core" }
    })]);
    let service = CloudService::with_memory_transport(
        database.pool().clone(),
        || 123456,
        http_transport.clone(),
    );
    service
        .connect(CloudConnectRequest {
            url: Some("https://mia.example/".into()),
            token: Some("secret-token".into()),
            account_hint: None,
            user: Some(json!({ "id": "u1" })),
            account: None,
            agent_runtime: None,
            last_event_seq: Some(7),
            last_memory_sync_at: None,
        })
        .await
        .unwrap();
    let socket_transport = Arc::new(MockBridgeTransport {
        events: Arc::new(Mutex::new(vec![
            CloudBridgeSocketEvent::Open,
            CloudBridgeSocketEvent::Text(
                json!({ "type": "events_ready", "sinceSeq": 7, "serverSeq": 8 }).to_string(),
            ),
            CloudBridgeSocketEvent::Text(
                json!({
                    "type": "conversation.bot_invocation_requested",
                    "seq": 8,
                    "conversationId": "botc_1",
                    "botId": "bot_codex",
                    "runtimeKind": "desktop-local",
                    "runtimeConfig": { "agentEngine": "codex" },
                    "triggeringMessage": { "id": "m_user", "body_md": "hi" },
                    "members": [{
                        "member_kind": "bot",
                        "member_ref": "bot_codex",
                        "identity": { "displayName": "Codex" }
                    }]
                })
                .to_string(),
            ),
        ])),
        ..Default::default()
    });
    let runner = Arc::new(MockBridgeRunner::with_busy_before_success(1));
    let manager = CloudEventsManager::with_transport_and_desktop_runner(
        service,
        socket_transport,
        Arc::new(|_, _| {}),
        Some(runner.clone()),
        Duration::from_millis(10),
        Duration::from_secs(60),
        Duration::from_secs(60),
    );

    manager.start().await.unwrap();
    for _ in 0..120 {
        if !http_transport.calls().is_empty() {
            break;
        }
        sleep(Duration::from_millis(10)).await;
    }

    assert_eq!(runner.runs.lock().unwrap().len(), 2);
    assert_eq!(
        http_transport.calls(),
        vec![(
            "POST".into(),
            "/api/conversations/botc_1/messages/as-bot".into(),
            json!({
                "botId": "bot_codex",
                "bodyMd": "done by core",
                "attachments": [{ "id": "att_1" }],
                "trace": { "reasoning": "checked" },
                "contentBlocks": [{ "type": "thinking", "id": "think_1", "text": "checked", "status": "completed" }],
                "turnId": "turn_1",
                "clientOpId": "core-cloud-invocation-cloud_evt_8_botc_1_bot_codex_m_user"
            })
        )]
    );
    manager.stop().await.unwrap();
}

#[tokio::test]
async fn cloud_events_manager_applies_events_ready_cursor_reset() {
    let database = init_database_memory().await.unwrap();
    let service = CloudService::with_now(database.pool().clone(), || 123456);
    service
        .connect(CloudConnectRequest {
            url: Some("https://mia.example/".into()),
            token: Some("secret-token".into()),
            account_hint: None,
            user: Some(json!({ "id": "u1" })),
            account: None,
            agent_runtime: None,
            last_event_seq: Some(99),
            last_memory_sync_at: None,
        })
        .await
        .unwrap();
    let transport = Arc::new(MockBridgeTransport {
        events: Arc::new(Mutex::new(vec![
            CloudBridgeSocketEvent::Open,
            CloudBridgeSocketEvent::Text(
                json!({ "type": "events_ready", "resetTo": 7, "serverSeq": 100 }).to_string(),
            ),
        ])),
        ..Default::default()
    });
    let manager = CloudEventsManager::with_transport(
        service.clone(),
        transport,
        Arc::new(|_, _| {}),
        Duration::from_millis(10),
        Duration::from_secs(60),
        Duration::from_secs(60),
    );

    manager.start().await.unwrap();
    for _ in 0..50 {
        if manager.status(false).await.unwrap().events["connected"]
            .as_bool()
            .unwrap_or(false)
        {
            break;
        }
        sleep(Duration::from_millis(10)).await;
    }

    assert_eq!(
        service.status(false).await.unwrap().events["lastEventSeq"],
        7
    );
    manager.stop().await.unwrap();
}
