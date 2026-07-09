use mia_core_api_types::{CreateMcpServerRequest, UpdateMcpServerRequest};
use mia_core_db::init_database_memory;
use mia_core_mcp::{MASK, McpError, McpService};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use std::sync::Arc;
use tokio::sync::Mutex;

#[tokio::test]
async fn mcp_service_owns_crud_normalization_and_public_redaction() {
    let db = init_database_memory().await.unwrap();
    let service = McpService::with_now(db.pool().clone(), || 1_780_000_000_000);

    let created = service
        .create_server(CreateMcpServerRequest {
            name: "filesystem".to_string(),
            description: Some("Local files".to_string()),
            enabled: Some(false),
            transport: json!({
                "type": "stdio",
                "command": "npx -y @modelcontextprotocol/server-filesystem",
                "env": { "OPENAI_API_KEY": "secret", "SAFE": "visible" }
            }),
            config: None,
        })
        .await
        .unwrap();

    assert!(created.server.id.starts_with("mcp_"));
    assert_eq!(created.server.name, "filesystem");
    assert_eq!(created.server.description.as_deref(), Some("Local files"));
    assert_eq!(created.server.transport["type"], "stdio");
    assert_eq!(created.server.transport["command"], "npx");
    assert_eq!(created.server.transport["args"][0], "-y");
    assert_eq!(created.server.transport["env"]["OPENAI_API_KEY"], MASK);
    assert_eq!(created.server.transport["env"]["SAFE"], "visible");
    assert_eq!(created.server.status, "disconnected");

    let listed = service.list_servers().await.unwrap();
    assert_eq!(listed.servers.len(), 1);
    assert_eq!(listed.servers[0].id, created.server.id);

    let updated = service
        .update_server(
            &created.server.id,
            UpdateMcpServerRequest {
                name: None,
                description: None,
                enabled: Some(true),
                transport: Some(json!({
                    "type": "stdio",
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem"],
                    "env": { "OPENAI_API_KEY": MASK, "SAFE": "next" }
                })),
                config: None,
            },
        )
        .await
        .unwrap();
    assert!(updated.server.enabled);
    assert_eq!(updated.server.transport["env"]["OPENAI_API_KEY"], MASK);
    assert_eq!(updated.server.transport["env"]["SAFE"], "next");

    let deleted = service.delete_server(&created.server.id).await.unwrap();
    assert!(deleted.ok);
    assert!(service.list_servers().await.unwrap().servers.is_empty());
}

#[tokio::test]
async fn mcp_service_tests_connection_and_exports_enabled_servers_for_agents() {
    let db = init_database_memory().await.unwrap();
    let service = McpService::with_now(db.pool().clone(), || 1_780_000_000_000);
    let script = r#"
while IFS= read -r line; do
  case "$line" in
    *\"method\":\"initialize\"*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"docs","version":"1.0.0"}}}'
      ;;
    *\"method\":\"tools/list\"*)
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}'
      ;;
  esac
done
"#;
    let created = service
        .create_server(CreateMcpServerRequest {
            name: "docs".to_string(),
            description: None,
            enabled: Some(true),
            transport: json!({
                "type": "stdio",
                "command": "sh",
                "args": ["-c", script],
                "env": {}
            }),
            config: None,
        })
        .await
        .unwrap();

    let tested = service.test_server(&created.server.id).await.unwrap();
    assert!(tested.ok);
    assert_eq!(tested.diagnostic["status"], "connected");

    let listed = service.list_servers().await.unwrap();
    assert_eq!(listed.servers[0].last_test_status, "connected");

    let agent_configs = service.agent_configs().await.unwrap();
    assert_eq!(agent_configs.configs["mcpServers"]["docs"]["type"], "stdio");
    assert_eq!(agent_configs.configs["mcpServers"]["docs"]["command"], "sh");
}

#[tokio::test]
async fn mcp_service_stdio_connection_test_runs_protocol_and_persists_tools() {
    let db = init_database_memory().await.unwrap();
    let service = McpService::with_now(db.pool().clone(), || 1_780_000_000_000);
    let script = r#"
while IFS= read -r line; do
  case "$line" in
    *\"method\":\"initialize\"*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"fake-mcp","version":"1.0.0"}}}'
      ;;
    *\"method\":\"tools/list\"*)
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search","description":"Search docs","inputSchema":{"type":"object","properties":{"query":{"type":"string"}}}}]}}'
      ;;
  esac
done
"#;
    let created = service
        .create_server(CreateMcpServerRequest {
            name: "fake docs".to_string(),
            description: None,
            enabled: Some(true),
            transport: json!({
                "type": "stdio",
                "command": "sh",
                "args": ["-c", script],
                "env": {}
            }),
            config: None,
        })
        .await
        .unwrap();

    let tested = service.test_server(&created.server.id).await.unwrap();
    assert!(tested.ok);
    assert_eq!(tested.diagnostic["status"], "connected");
    assert_eq!(tested.diagnostic["tools"][0]["server"], "fake docs");
    assert_eq!(tested.diagnostic["tools"][0]["name"], "search");
    assert_eq!(tested.tools, vec!["search"]);

    let listed = service.list_servers().await.unwrap();
    assert_eq!(listed.servers[0].last_test_status, "connected");
    assert_eq!(listed.servers[0].tools[0]["name"], "search");
}

#[tokio::test]
async fn mcp_service_connection_test_reports_missing_stdio_command() {
    let db = init_database_memory().await.unwrap();
    let service = McpService::with_now(db.pool().clone(), || 1_780_000_000_000);
    let created = service
        .create_server(CreateMcpServerRequest {
            name: "missing".to_string(),
            description: None,
            enabled: Some(false),
            transport: json!({
                "type": "stdio",
                "command": "mia-mcp-missing-command-xyz",
                "args": [],
                "env": {}
            }),
            config: None,
        })
        .await
        .unwrap();

    let tested = service.test_server(&created.server.id).await.unwrap();
    assert!(!tested.ok);
    assert_eq!(tested.diagnostic["status"], "disconnected");
    assert_eq!(tested.diagnostic["code"], "command_not_found");
    assert!(
        tested.diagnostic["message"]
            .as_str()
            .unwrap()
            .contains("Command not found")
    );

    let listed = service.list_servers().await.unwrap();
    assert_eq!(listed.servers[0].last_test_status, "disconnected");
    assert_eq!(
        listed.servers[0].last_test_code,
        Some(json!("command_not_found"))
    );
}

#[tokio::test]
async fn mcp_service_http_connection_test_uses_stored_oauth_token() {
    let seen_authorization = Arc::new(Mutex::new(Vec::<String>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new()
        .route("/mcp", axum::routing::post(mock_http_mcp))
        .with_state(seen_authorization.clone());
    let server_handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let db = init_database_memory().await.unwrap();
    let service = McpService::with_now(db.pool().clone(), || 1_780_000_000_000);
    let created = service
        .create_server(CreateMcpServerRequest {
            name: "oauth docs".to_string(),
            description: None,
            enabled: Some(true),
            transport: json!({
                "type": "http",
                "url": format!("http://{addr}/mcp"),
                "headers": {}
            }),
            config: None,
        })
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO mcp_oauth_tokens (server_id, token_json, updated_at) VALUES (?, ?, ?)",
    )
    .bind(&created.server.id)
    .bind(
        json!({
            "accessToken": "access_123",
            "tokenType": "Bearer",
            "expiresAt": 1_780_000_060_000i64
        })
        .to_string(),
    )
    .bind(1_780_000_000_000i64)
    .execute(db.pool())
    .await
    .unwrap();

    let status = service.oauth_status(&created.server.id).await.unwrap();
    assert!(status.ok);

    let tested = service.test_server(&created.server.id).await.unwrap();
    assert!(tested.ok);
    assert_eq!(tested.diagnostic["tools"][0]["name"], "search");

    let seen = seen_authorization.lock().await;
    assert!(
        seen.iter().all(|value| value == "Bearer access_123"),
        "expected every MCP HTTP request to include the stored OAuth token, got {seen:?}"
    );

    server_handle.abort();
}

#[tokio::test]
async fn mcp_service_http_connection_test_refreshes_expired_oauth_token() {
    let token_requests = Arc::new(Mutex::new(Vec::<OAuthTokenRequest>::new()));
    let token_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let token_addr = token_listener.local_addr().unwrap();
    let token_app = axum::Router::new()
        .route("/token", axum::routing::post(mock_oauth_token))
        .with_state(token_requests.clone());
    let token_server_handle = tokio::spawn(async move {
        axum::serve(token_listener, token_app).await.unwrap();
    });

    let seen_authorization = Arc::new(Mutex::new(Vec::<String>::new()));
    let mcp_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mcp_addr = mcp_listener.local_addr().unwrap();
    let mcp_app = axum::Router::new()
        .route("/mcp", axum::routing::post(mock_http_mcp))
        .with_state(seen_authorization.clone());
    let mcp_server_handle = tokio::spawn(async move {
        axum::serve(mcp_listener, mcp_app).await.unwrap();
    });

    let db = init_database_memory().await.unwrap();
    let service = McpService::with_now(db.pool().clone(), || 1_780_000_000_000);
    let created = service
        .create_server(CreateMcpServerRequest {
            name: "refresh docs".to_string(),
            description: None,
            enabled: Some(true),
            transport: json!({
                "type": "http",
                "url": format!("http://{mcp_addr}/mcp"),
                "headers": {}
            }),
            config: None,
        })
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO mcp_oauth_tokens (server_id, token_json, updated_at) VALUES (?, ?, ?)",
    )
    .bind(&created.server.id)
    .bind(
        json!({
            "pending": false,
            "serverUrl": format!("http://{mcp_addr}/mcp"),
            "authorizationEndpoint": format!("http://{token_addr}/authorize"),
            "tokenEndpoint": format!("http://{token_addr}/token"),
            "accessToken": "expired_access",
            "refreshToken": "refresh_old",
            "tokenType": "Bearer",
            "expiresAt": 1_779_999_999_999i64
        })
        .to_string(),
    )
    .bind(1_780_000_000_000i64)
    .execute(db.pool())
    .await
    .unwrap();

    let tested = service.test_server(&created.server.id).await.unwrap();
    assert!(tested.ok);

    let requests = token_requests.lock().await;
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].grant_type, "refresh_token");
    assert_eq!(requests[0].refresh_token.as_deref(), Some("refresh_old"));

    let seen = seen_authorization.lock().await;
    assert!(
        seen.iter().all(|value| value == "Bearer access_refreshed"),
        "expected every MCP HTTP request to include the refreshed OAuth token, got {seen:?}"
    );

    let row = sqlx::query("SELECT token_json FROM mcp_oauth_tokens WHERE server_id = ?")
        .bind(&created.server.id)
        .fetch_one(db.pool())
        .await
        .unwrap();
    let token: serde_json::Value =
        serde_json::from_str(&row.get::<String, _>("token_json")).unwrap();
    assert_eq!(token["accessToken"], "access_refreshed");
    assert_eq!(token["refreshToken"], "refresh_123");
    assert_eq!(token["expiresAt"], 1_780_003_600_000i64);
    assert!(service.oauth_status(&created.server.id).await.unwrap().ok);

    token_server_handle.abort();
    mcp_server_handle.abort();
}

#[tokio::test]
async fn mcp_service_managed_action_persists_unsupported_connector_error() {
    let db = init_database_memory().await.unwrap();
    let service = McpService::with_now(db.pool().clone(), || 1_780_000_000_000);
    let created = service
        .create_server(CreateMcpServerRequest {
            name: "managed".to_string(),
            description: None,
            enabled: Some(true),
            transport: json!({
                "type": "http",
                "url": "http://127.0.0.1:18070/mcp",
                "headers": {}
            }),
            config: Some(json!({
                "managementMode": "managed",
                "managedRuntime": {
                    "connectorId": "demo-managed",
                    "state": "installed",
                    "endpoint": "http://127.0.0.1:18070/mcp"
                },
                "connectionWizard": {
                    "state": "needs_managed_action",
                    "nextAction": "start",
                    "message": "",
                    "missingRequiredInputs": [],
                    "actions": [{ "id": "start", "label": "启动服务" }, { "id": "test", "label": "检测并启用" }]
                }
            })),
        })
        .await
        .unwrap();

    let started = service
        .run_managed_action(&created.server.id, "start", json!({}))
        .await
        .unwrap();

    assert!(!started.server.enabled);
    assert_eq!(started.server.managed_runtime["state"], "error");
    assert_eq!(started.server.managed_runtime["lastAction"], "start");
    assert_eq!(started.server.connection_wizard["state"], "managed_error");
    assert_eq!(started.server.connection_wizard["nextAction"], "start");
    assert_eq!(
        started.server.connection_wizard["message"],
        "Managed connector is not supported."
    );

    let stored = service.get_server(&created.server.id).await.unwrap();
    assert_eq!(stored.server.managed_runtime["state"], "error");
    assert_eq!(stored.server.connection_wizard["state"], "managed_error");
}

#[tokio::test]
async fn mcp_service_process_managed_action_start_and_stop_tracks_child() {
    let db = init_database_memory().await.unwrap();
    let service = McpService::with_now(db.pool().clone(), || 1_780_000_000_000);
    let created = service
        .create_server(CreateMcpServerRequest {
            name: "process managed".to_string(),
            description: None,
            enabled: Some(false),
            transport: json!({
                "type": "http",
                "url": "http://127.0.0.1:18071/mcp",
                "headers": {}
            }),
            config: Some(json!({
                "managementMode": "managed",
                "managedRuntime": {
                    "connectorId": "process",
                    "command": "sh",
                    "args": ["-c", "while true; do sleep 1; done"],
                    "endpoint": "http://127.0.0.1:18071/mcp",
                    "state": "installed"
                },
                "connectionWizard": {
                    "state": "needs_managed_action",
                    "nextAction": "start",
                    "message": "",
                    "missingRequiredInputs": [],
                    "actions": [{ "id": "start", "label": "启动服务" }, { "id": "test", "label": "检测并启用" }]
                }
            })),
        })
        .await
        .unwrap();

    let started = service
        .run_managed_action(&created.server.id, "start", json!({}))
        .await
        .unwrap();

    assert!(!started.server.enabled);
    assert_eq!(started.server.managed_runtime["state"], "running");
    assert_eq!(started.server.managed_runtime["lastAction"], "start");
    assert!(started.server.managed_runtime["pid"].as_u64().unwrap() > 0);
    assert_eq!(
        started.server.connection_wizard["state"],
        "needs_managed_action"
    );
    assert_eq!(started.server.connection_wizard["nextAction"], "test");

    let stopped = service
        .run_managed_action(&created.server.id, "stop", json!({}))
        .await
        .unwrap();

    assert!(!stopped.server.enabled);
    assert_eq!(stopped.server.managed_runtime["state"], "stopped");
    assert_eq!(stopped.server.managed_runtime["lastAction"], "stop");
    assert_eq!(stopped.server.connection_wizard["nextAction"], "start");
}

#[tokio::test]
async fn mcp_service_process_managed_action_test_starts_process_and_enables_after_probe() {
    let seen_authorization = Arc::new(Mutex::new(Vec::<String>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new()
        .route("/mcp", axum::routing::post(mock_http_mcp))
        .with_state(seen_authorization);
    let server_handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let db = init_database_memory().await.unwrap();
    let service = McpService::with_now(db.pool().clone(), || 1_780_000_000_000);
    let created = service
        .create_server(CreateMcpServerRequest {
            name: "process managed test".to_string(),
            description: None,
            enabled: Some(false),
            transport: json!({
                "type": "http",
                "url": format!("http://{addr}/mcp"),
                "headers": {}
            }),
            config: Some(json!({
                "managementMode": "managed",
                "managedRuntime": {
                    "connectorId": "process",
                    "command": "sh",
                    "args": ["-c", "while true; do sleep 1; done"],
                    "endpoint": format!("http://{addr}/mcp"),
                    "state": "installed"
                },
                "connectionWizard": {
                    "state": "needs_managed_action",
                    "nextAction": "test",
                    "message": "",
                    "missingRequiredInputs": [],
                    "actions": [{ "id": "start", "label": "启动服务" }, { "id": "test", "label": "检测并启用" }]
                }
            })),
        })
        .await
        .unwrap();

    let tested = service
        .run_managed_action(&created.server.id, "test", json!({}))
        .await
        .unwrap();

    assert!(tested.server.enabled);
    assert_eq!(tested.server.status, "connected");
    assert_eq!(tested.server.managed_runtime["state"], "running");
    assert_eq!(tested.server.managed_runtime["lastAction"], "test");
    assert_eq!(tested.server.connection_wizard["state"], "connected");
    assert_eq!(tested.server.connection_wizard["nextAction"], "test");
    assert_eq!(tested.server.tools[0]["name"], "search");

    let _ = service
        .run_managed_action(&created.server.id, "stop", json!({}))
        .await;
    server_handle.abort();
}

#[tokio::test]
async fn mcp_service_refresh_bridge_ensures_enabled_process_managed_servers_are_running() {
    let db = init_database_memory().await.unwrap();
    let service = McpService::with_now(db.pool().clone(), || 1_780_000_000_000);
    let created = service
        .create_server(CreateMcpServerRequest {
            name: "process managed refresh".to_string(),
            description: None,
            enabled: Some(true),
            transport: json!({
                "type": "http",
                "url": "http://127.0.0.1:18072/mcp",
                "headers": {}
            }),
            config: Some(json!({
                "managementMode": "managed",
                "managedRuntime": {
                    "connectorId": "process",
                    "command": "sh",
                    "args": ["-c", "while true; do sleep 1; done"],
                    "endpoint": "http://127.0.0.1:18072/mcp",
                    "state": "installed"
                },
                "connectionWizard": {
                    "state": "connected",
                    "nextAction": "test",
                    "message": "",
                    "missingRequiredInputs": [],
                    "actions": [{ "id": "test", "label": "检测并启用" }]
                }
            })),
        })
        .await
        .unwrap();

    let refreshed = service.refresh_bridge().await.unwrap();
    assert_eq!(refreshed["errors"], json!([]));

    let stored = service.get_server(&created.server.id).await.unwrap();
    assert!(stored.server.enabled);
    assert_eq!(stored.server.managed_runtime["state"], "running");
    assert_eq!(stored.server.managed_runtime["lastAction"], "start");
    assert!(stored.server.managed_runtime["pid"].as_u64().unwrap() > 0);

    let _ = service
        .run_managed_action(&created.server.id, "stop", json!({}))
        .await;
}

#[tokio::test]
async fn mcp_service_oauth_login_discovers_metadata_and_persists_pending_pkce() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new().route(
        "/mcp/.well-known/oauth-authorization-server",
        axum::routing::get(move || async move {
            axum::Json(json!({
                "authorization_endpoint": format!("http://{addr}/authorize"),
                "token_endpoint": format!("http://{addr}/token")
            }))
        }),
    );
    let server_handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let db = init_database_memory().await.unwrap();
    let service = McpService::with_now(db.pool().clone(), || 1_780_000_000_000);
    let created = service
        .create_server(CreateMcpServerRequest {
            name: "oauth login".to_string(),
            description: None,
            enabled: Some(false),
            transport: json!({
                "type": "http",
                "url": format!("http://{addr}/mcp"),
                "headers": {}
            }),
            config: None,
        })
        .await
        .unwrap();

    let login = service
        .oauth_login(&created.server.id, json!({ "clientId": "mia-test" }))
        .await
        .unwrap();

    assert!(login.ok);
    let auth_url = login.auth_url.as_deref().unwrap();
    let parsed = reqwest::Url::parse(auth_url).unwrap();
    assert_eq!(
        parsed.as_str().split('?').next().unwrap(),
        format!("http://{addr}/authorize")
    );
    assert_eq!(
        parsed
            .query_pairs()
            .find(|(key, _)| key == "response_type")
            .unwrap()
            .1,
        "code"
    );
    assert_eq!(
        parsed
            .query_pairs()
            .find(|(key, _)| key == "client_id")
            .unwrap()
            .1,
        "mia-test"
    );
    assert_eq!(
        parsed
            .query_pairs()
            .find(|(key, _)| key == "code_challenge_method")
            .unwrap()
            .1,
        "S256"
    );
    let state = parsed
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .to_string();
    let code_challenge = parsed
        .query_pairs()
        .find(|(key, _)| key == "code_challenge")
        .unwrap()
        .1
        .to_string();

    let row = sqlx::query("SELECT token_json FROM mcp_oauth_tokens WHERE server_id = ?")
        .bind(&created.server.id)
        .fetch_one(db.pool())
        .await
        .unwrap();
    let pending: serde_json::Value =
        serde_json::from_str(&row.get::<String, _>("token_json")).unwrap();
    assert_eq!(pending["pending"], true);
    assert_eq!(pending["serverUrl"], format!("http://{addr}/mcp"));
    assert_eq!(
        pending["authorizationEndpoint"],
        format!("http://{addr}/authorize")
    );
    assert_eq!(pending["tokenEndpoint"], format!("http://{addr}/token"));
    assert_eq!(pending["state"], state);
    assert_eq!(pending["codeChallenge"], code_challenge);
    assert!(pending["codeVerifier"].as_str().unwrap().len() >= 43);
    assert!(
        pending["redirectUri"]
            .as_str()
            .unwrap()
            .starts_with("http://127.0.0.1:")
    );

    let status = service.oauth_status(&created.server.id).await.unwrap();
    assert!(!status.ok);

    server_handle.abort();
}

#[tokio::test]
async fn mcp_service_oauth_callback_exchanges_code_and_persists_access_token() {
    let token_requests = Arc::new(Mutex::new(Vec::<OAuthTokenRequest>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new()
        .route(
            "/mcp/.well-known/oauth-authorization-server",
            axum::routing::get(move || async move {
                axum::Json(json!({
                    "authorization_endpoint": format!("http://{addr}/authorize"),
                    "token_endpoint": format!("http://{addr}/token")
                }))
            }),
        )
        .route("/token", axum::routing::post(mock_oauth_token))
        .with_state(token_requests.clone());
    let server_handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let db = init_database_memory().await.unwrap();
    let service = McpService::with_now(db.pool().clone(), || 1_780_000_000_000);
    let created = service
        .create_server(CreateMcpServerRequest {
            name: "oauth callback".to_string(),
            description: None,
            enabled: Some(false),
            transport: json!({
                "type": "http",
                "url": format!("http://{addr}/mcp"),
                "headers": {}
            }),
            config: None,
        })
        .await
        .unwrap();

    let login = service
        .oauth_login(&created.server.id, json!({ "clientId": "mia-test" }))
        .await
        .unwrap();
    let parsed = reqwest::Url::parse(login.auth_url.as_deref().unwrap()).unwrap();
    let redirect_uri = parsed
        .query_pairs()
        .find(|(key, _)| key == "redirect_uri")
        .unwrap()
        .1
        .to_string();
    let state = parsed
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .to_string();

    let callback_response = reqwest::get(format!("{redirect_uri}?code=code_123&state={state}"))
        .await
        .unwrap();
    assert!(callback_response.status().is_success());

    let mut authenticated = false;
    for _ in 0..50 {
        if service.oauth_status(&created.server.id).await.unwrap().ok {
            authenticated = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(
        authenticated,
        "OAuth callback should persist a usable access token"
    );

    let row = sqlx::query("SELECT token_json FROM mcp_oauth_tokens WHERE server_id = ?")
        .bind(&created.server.id)
        .fetch_one(db.pool())
        .await
        .unwrap();
    let token: serde_json::Value =
        serde_json::from_str(&row.get::<String, _>("token_json")).unwrap();
    assert_eq!(token["accessToken"], "access_123");
    assert_eq!(token["refreshToken"], "refresh_123");
    assert_eq!(token["tokenType"], "Bearer");
    assert_eq!(token["expiresAt"], 1_780_003_600_000i64);
    assert_eq!(token["pending"], false);

    let requests = token_requests.lock().await;
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].grant_type, "authorization_code");
    assert_eq!(requests[0].code.as_deref(), Some("code_123"));
    assert_eq!(requests[0].client_id.as_deref(), Some("mia-test"));
    assert_eq!(
        requests[0].redirect_uri.as_deref(),
        Some(redirect_uri.as_str())
    );
    assert!(requests[0].code_verifier.as_deref().unwrap_or("").len() >= 43);

    server_handle.abort();
}

#[derive(Debug, Clone, Deserialize)]
struct OAuthTokenRequest {
    grant_type: String,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    redirect_uri: Option<String>,
    #[serde(default)]
    code_verifier: Option<String>,
}

async fn mock_oauth_token(
    axum::extract::State(token_requests): axum::extract::State<Arc<Mutex<Vec<OAuthTokenRequest>>>>,
    axum::Form(form): axum::Form<OAuthTokenRequest>,
) -> axum::Json<serde_json::Value> {
    token_requests.lock().await.push(form.clone());
    let access_token = if form.grant_type == "refresh_token" {
        "access_refreshed"
    } else {
        "access_123"
    };
    axum::Json(json!({
        "access_token": access_token,
        "refresh_token": "refresh_123",
        "token_type": "Bearer",
        "expires_in": 3600
    }))
}

async fn mock_http_mcp(
    axum::extract::State(seen_authorization): axum::extract::State<Arc<Mutex<Vec<String>>>>,
    headers: axum::http::HeaderMap,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> axum::Json<serde_json::Value> {
    let authorization = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    seen_authorization.lock().await.push(authorization);
    match body.get("method").and_then(serde_json::Value::as_str) {
        Some("initialize") => axum::Json(json!({
            "jsonrpc": "2.0",
            "id": body["id"],
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "oauth-docs", "version": "1.0.0" }
            }
        })),
        Some("tools/list") => axum::Json(json!({
            "jsonrpc": "2.0",
            "id": body["id"],
            "result": {
                "tools": [{
                    "name": "search",
                    "description": "Search docs",
                    "inputSchema": { "type": "object" }
                }]
            }
        })),
        _ => axum::Json(json!({ "ok": true })),
    }
}

#[tokio::test]
async fn mcp_service_rejects_invalid_records_and_tracks_oauth_status() {
    let db = init_database_memory().await.unwrap();
    let service = McpService::new(db.pool().clone());

    let invalid = service
        .create_server(CreateMcpServerRequest {
            name: "broken".to_string(),
            description: None,
            enabled: Some(false),
            transport: json!({ "type": "stdio", "command": "" }),
            config: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(invalid, McpError::InvalidTransport(_)));

    let status = service.oauth_status("missing").await.unwrap();
    assert!(!status.ok);
    assert_eq!(status.auth_url, None);
}

#[tokio::test]
async fn mcp_service_exposes_and_installs_builtin_catalog_templates() {
    let db = init_database_memory().await.unwrap();
    let service = McpService::with_now(db.pool().clone(), || 1_780_000_000_000);

    let marketplace = service.marketplace().await.unwrap();
    let templates = marketplace["templates"].as_array().unwrap();
    assert_eq!(
        templates
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "playwright",
            "context7",
            "github",
            "tavily",
            "firecrawl",
            "managed-process"
        ]
    );
    assert_eq!(
        templates[0]["transport"]["args"][1],
        "@playwright/mcp@latest"
    );

    let missing = service.install_template("github", json!({})).await.unwrap();
    assert_eq!(missing.server.registry_id, "github");
    assert_eq!(missing.server.source, "marketplace");
    assert_eq!(missing.server.management_mode, "native");
    assert_eq!(missing.server.status, "configuration_required");
    assert_eq!(
        missing.server.connection_wizard["missingRequiredInputs"][0],
        "GITHUB_PERSONAL_ACCESS_TOKEN"
    );
    assert!(!missing.server.enabled);

    let ready = service
        .install_template(
            "github",
            json!({ "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_secret" }),
        )
        .await
        .unwrap();
    assert_eq!(ready.server.status, "disconnected");
    assert_eq!(ready.server.connection_wizard["state"], "ready_to_test");
    assert_eq!(
        ready.server.transport["env"]["GITHUB_PERSONAL_ACCESS_TOKEN"],
        MASK
    );

    let managed = service
        .install_template(
            "managed-process",
            json!({
                "name": "local docs",
                "MCP_PROCESS_COMMAND": "node ./server.js --port 18060",
                "MCP_PROCESS_ENDPOINT": "http://127.0.0.1:18060/mcp",
                "MCP_PROCESS_CWD": "/tmp/mia-managed-docs",
                "env": { "NODE_ENV": "test" }
            }),
        )
        .await
        .unwrap();
    assert_eq!(managed.server.registry_id, "managed-process");
    assert_eq!(managed.server.management_mode, "managed");
    assert_eq!(managed.server.transport["type"], "http");
    assert_eq!(
        managed.server.transport["url"],
        "http://127.0.0.1:18060/mcp"
    );
    assert_eq!(managed.server.managed_runtime["connectorId"], "process");
    assert_eq!(managed.server.managed_runtime["command"], "node");
    assert_eq!(managed.server.managed_runtime["args"][0], "./server.js");
    assert_eq!(managed.server.managed_runtime["args"][1], "--port");
    assert_eq!(managed.server.managed_runtime["args"][2], "18060");
    assert_eq!(
        managed.server.managed_runtime["cwd"],
        "/tmp/mia-managed-docs"
    );
    assert_eq!(managed.server.managed_runtime["env"]["NODE_ENV"], "test");
    assert_eq!(
        managed.server.connection_wizard["state"],
        "needs_managed_action"
    );
    assert_eq!(managed.server.connection_wizard["nextAction"], "start");
    assert!(!managed.server.enabled);

    assert_eq!(service.list_servers().await.unwrap().servers.len(), 2);
}
