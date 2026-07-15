//! MCP catalog, records, OAuth, and agent exposure boundary for Mia Rust Core.

mod connection_test;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mia_core_api_types::{
    CreateMcpServerRequest, EmptyResponse, McpAgentConfigsResponse, McpOAuthActionResponse,
    McpServerListResponse, McpServerResponse, McpServerSummary, McpServerTestResponse,
    UpdateMcpServerRequest,
};
use mia_core_common::process::configure_background_command;
use oauth2::basic::BasicClient;
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, CsrfToken, PkceCodeChallenge, PkceCodeVerifier,
    RedirectUrl, RefreshToken, TokenResponse, TokenUrl,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::{Row, SqlitePool};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

pub const EVENT_MCP_SERVER_UPDATED: &str = "mcp.serverUpdated";
pub const MASK: &str = "••••••••";

const DEFAULT_SYNC_ENGINES: [&str; 3] = ["hermes", "claude-code", "codex"];
const MCP_CONNECTION_TEST_TIMEOUT: Duration = Duration::from_secs(15);
const SPLITTABLE_STDIO_LAUNCHERS: [&str; 8] = [
    "npx", "pnpx", "bunx", "uvx", "uv", "node", "python", "python3",
];
const OAUTH_CALLBACK_TIMEOUT: Duration = Duration::from_secs(120);
const DEFAULT_OAUTH_CLIENT_ID: &str = "mia";
const OAUTH_PENDING_TTL_MS: i64 = 10 * 60 * 1000;
const OAUTH_EXPIRY_MARGIN_MS: i64 = 5 * 60 * 1000;

type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;
type ManagedChildren = Arc<Mutex<HashMap<String, Child>>>;

#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("mcp server not found: {0}")]
    NotFound(String),
    #[error("invalid mcp server input: {0}")]
    InvalidInput(String),
    #[error("invalid mcp transport: {0}")]
    InvalidTransport(String),
    #[error("mcp oauth error: {0}")]
    OAuth(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Clone, Deserialize)]
struct OAuthServerMetadata {
    authorization_endpoint: String,
    token_endpoint: String,
}

#[derive(Debug, Clone)]
struct PendingOAuthLogin {
    server_url: String,
    authorization_endpoint: String,
    token_endpoint: String,
    redirect_uri: String,
    client_id: String,
    state: String,
    code_challenge: String,
    code_verifier: String,
    auth_url: String,
}

#[derive(Debug, Clone)]
struct ManagedProcessSpec {
    command: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    cwd: Option<String>,
}

struct ManagedProcessState<'a> {
    state: &'a str,
    last_action: &'a str,
    message: &'a str,
    enabled: bool,
    pid: Option<u32>,
    next_action: &'a str,
}

#[derive(Clone)]
pub struct McpService {
    pool: SqlitePool,
    now_ms: NowFn,
    managed_children: ManagedChildren,
}

impl std::fmt::Debug for McpService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("McpService").finish_non_exhaustive()
    }
}

impl McpService {
    pub fn new(pool: SqlitePool) -> Self {
        Self::with_now(pool, now_ms)
    }

    pub fn with_now<F>(pool: SqlitePool, now_ms: F) -> Self
    where
        F: Fn() -> i64 + Send + Sync + 'static,
    {
        Self {
            pool,
            now_ms: Arc::new(now_ms),
            managed_children: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn list_servers(&self) -> Result<McpServerListResponse, McpError> {
        let rows = sqlx::query(
            "SELECT id, name, transport, config_json, enabled, last_test_json, deleted_at, created_at, updated_at \
             FROM mcp_servers WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(McpServerListResponse {
            servers: rows
                .into_iter()
                .map(mcp_server_from_row)
                .collect::<Result<Vec<_>, _>>()?,
        })
    }

    pub async fn get_server(&self, server_id: &str) -> Result<McpServerResponse, McpError> {
        let row = self.fetch_visible_server(server_id).await?;
        Ok(McpServerResponse {
            server: mcp_server_from_row(row)?,
        })
    }

    pub async fn create_server(
        &self,
        request: CreateMcpServerRequest,
    ) -> Result<McpServerResponse, McpError> {
        let name = clean_name(&request.name)?;
        let now = self.now();
        let transport =
            normalize_transport_request(&request.transport, request.config.as_ref(), None)?;
        let config = server_config_json(ServerConfigInput {
            name: &name,
            description: request.description.as_deref(),
            transport: &transport,
            enabled: request.enabled.unwrap_or(false),
            created_at: now,
            updated_at: now,
            existing: None,
            input_config: request.config.as_ref(),
        });
        let id = format!("mcp_{}", Uuid::now_v7().simple());

        if let Some(existing) = self.fetch_any_server_by_name(&name).await? {
            let existing_id: String = existing.get("id");
            sqlx::query(
                "UPDATE mcp_servers SET transport = ?, config_json = ?, enabled = ?, deleted_at = NULL, updated_at = ? WHERE id = ?",
            )
            .bind(transport_type(&transport))
            .bind(config.to_string())
            .bind(request.enabled.unwrap_or(false))
            .bind(now)
            .bind(&existing_id)
            .execute(&self.pool)
            .await?;
            return self.get_server(&existing_id).await;
        }

        sqlx::query(
            "INSERT INTO mcp_servers \
             (id, name, transport, config_json, enabled, last_test_json, deleted_at, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, '{}', NULL, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(transport_type(&transport))
        .bind(config.to_string())
        .bind(request.enabled.unwrap_or(false))
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_server(&id).await
    }

    pub async fn update_server(
        &self,
        server_id: &str,
        request: UpdateMcpServerRequest,
    ) -> Result<McpServerResponse, McpError> {
        let current_row = self.fetch_visible_server(server_id).await?;
        let current = mcp_server_from_row(current_row)?;
        let current_raw_transport =
            unredacted_transport_for_server(&self.pool, &current.id).await?;
        let name = match request.name {
            Some(name) => clean_name(&name)?,
            None => current.name.clone(),
        };
        let description = request.description.or_else(|| current.description.clone());
        let enabled = request.enabled.unwrap_or(current.enabled);
        let created_at = current.created_at;
        let now = self.now();
        let transport = match request.transport {
            Some(transport) => normalize_transport_request(
                &transport,
                request.config.as_ref(),
                Some(&current_raw_transport),
            )?,
            None => current_raw_transport,
        };
        let config = server_config_json(ServerConfigInput {
            name: &name,
            description: description.as_deref(),
            transport: &transport,
            enabled,
            created_at,
            updated_at: now,
            existing: Some(&current),
            input_config: request.config.as_ref(),
        });

        sqlx::query(
            "UPDATE mcp_servers SET name = ?, transport = ?, config_json = ?, enabled = ?, updated_at = ? WHERE id = ?",
        )
        .bind(name)
        .bind(transport_type(&transport))
        .bind(config.to_string())
        .bind(enabled)
        .bind(now)
        .bind(server_id)
        .execute(&self.pool)
        .await?;
        self.get_server(server_id).await
    }

    pub async fn delete_server(&self, server_id: &str) -> Result<EmptyResponse, McpError> {
        let _ = self.fetch_visible_server(server_id).await?;
        let result = sqlx::query(
            "UPDATE mcp_servers SET enabled = 0, deleted_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(self.now())
        .bind(self.now())
        .bind(server_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(McpError::NotFound(server_id.to_string()));
        }
        Ok(EmptyResponse { ok: true })
    }

    pub async fn test_server(&self, server_id: &str) -> Result<McpServerTestResponse, McpError> {
        let row = self.fetch_visible_server(server_id).await?;
        let current = mcp_server_from_row(row)?;
        let transport = unredacted_transport_for_server(&self.pool, &current.id).await?;
        validate_normalized_transport(&transport)?;
        let transport = self
            .transport_with_oauth_headers(&current.id, &transport)
            .await?;
        let now = self.now();
        let mut diagnostic = connection_test::test_connection(
            &current.name,
            &transport,
            MCP_CONNECTION_TEST_TIMEOUT,
        )
        .await;
        if !diagnostic.get("details").is_some_and(Value::is_object) {
            diagnostic["details"] = json!({});
        }
        if let Some(details) = diagnostic.get_mut("details").and_then(Value::as_object_mut) {
            details.insert("validatedAt".to_string(), json!(now));
        }
        let ok = diagnostic.get("ok").and_then(Value::as_bool) == Some(true);
        let tools = connection_test::tool_names(&diagnostic);
        sqlx::query("UPDATE mcp_servers SET last_test_json = ?, updated_at = ? WHERE id = ?")
            .bind(diagnostic.to_string())
            .bind(now)
            .bind(server_id)
            .execute(&self.pool)
            .await?;
        Ok(McpServerTestResponse {
            ok,
            tools,
            diagnostic,
        })
    }

    pub async fn import_servers(
        &self,
        input: Value,
        replace_duplicates: bool,
    ) -> Result<Value, McpError> {
        let records = parse_import_records(input)?;
        let mut imported = 0;
        let mut duplicates = Vec::new();
        for request in records {
            let exists = self
                .fetch_any_server_by_name(&request.name)
                .await?
                .is_some();
            if exists && !replace_duplicates {
                duplicates.push(request.name);
                continue;
            }
            self.create_server(request).await?;
            imported += 1;
        }
        let list = self.list_servers().await?;
        let requires_confirmation = !duplicates.is_empty();
        Ok(json!({
            "servers": list.servers,
            "imported": imported,
            "duplicates": duplicates,
            "requiresConfirmation": requires_confirmation
        }))
    }

    pub async fn marketplace(&self) -> Result<Value, McpError> {
        Ok(json!({ "templates": builtin_mcp_templates() }))
    }

    pub async fn install_template(
        &self,
        template_id: &str,
        values: Value,
    ) -> Result<McpServerResponse, McpError> {
        let template = builtin_mcp_template_by_id(template_id)
            .ok_or_else(|| McpError::NotFound(template_id.to_string()))?;
        let materialized = materialize_builtin_template(&template, values)?;
        self.create_server(materialized).await
    }

    pub async fn run_managed_action(
        &self,
        server_id: &str,
        action: &str,
        _values: Value,
    ) -> Result<McpServerResponse, McpError> {
        let current = self.get_server(server_id).await?.server;
        if current.management_mode != "managed" {
            return Err(McpError::InvalidInput(
                "MCP server is not managed by Mia.".to_string(),
            ));
        }
        let action = clean_text(action);
        match managed_connector_id(&current).as_str() {
            "process" => {
                self.run_process_managed_action(server_id, &current, &action)
                    .await
            }
            _ => {
                let message = "Managed connector is not supported.";
                self.apply_managed_action_failure(server_id, &current, &action, message)
                    .await
            }
        }
    }

    pub async fn refresh_bridge(&self) -> Result<Value, McpError> {
        let servers = self.list_servers().await?.servers;
        let mut errors = Vec::new();
        for server in servers {
            if !server.enabled || server.management_mode != "managed" {
                continue;
            }
            match managed_connector_id(&server).as_str() {
                "process" => {
                    let response = self
                        .ensure_managed_process_running(&server.id, &server)
                        .await?;
                    if response.server.managed_runtime["state"] != "running" {
                        errors.push(json!({
                            "id": response.server.id,
                            "name": response.server.name,
                            "message": response.server.connection_wizard["message"].as_str().unwrap_or("Managed connector failed to start.")
                        }));
                    }
                }
                _ => {
                    let response = self
                        .apply_managed_action_failure(
                            &server.id,
                            &server,
                            "start",
                            "Managed connector is not supported.",
                        )
                        .await?;
                    errors.push(json!({
                        "id": response.server.id,
                        "name": response.server.name,
                        "message": response.server.connection_wizard["message"].as_str().unwrap_or("Managed connector is not supported.")
                    }));
                }
            }
        }
        Ok(json!({ "tools": [], "errors": errors, "bridge": null }))
    }

    pub async fn list_tools(&self) -> Result<Value, McpError> {
        let servers = self.list_servers().await?.servers;
        let tools: Vec<Value> = servers
            .into_iter()
            .filter(|server| server.enabled)
            .flat_map(|server| {
                server.tools.into_iter().map(move |tool| {
                    let name = tool
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    json!({
                        "server": server.name,
                        "name": name,
                        "description": tool.get("description").cloned().unwrap_or_else(|| json!("")),
                        "inputSchema": tool.get("inputSchema").cloned().unwrap_or_else(|| json!({}))
                    })
                })
            })
            .collect();
        Ok(json!({ "tools": tools }))
    }

    pub async fn agent_configs(&self) -> Result<McpAgentConfigsResponse, McpError> {
        let rows = sqlx::query(
            "SELECT id, name, transport, config_json, enabled, last_test_json, deleted_at, created_at, updated_at \
             FROM mcp_servers WHERE enabled = 1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut servers = Map::new();
        for row in rows {
            let server = mcp_server_from_row(row)?;
            servers.insert(
                server.native_name.clone(),
                public_agent_transport(&server.transport),
            );
        }
        Ok(McpAgentConfigsResponse {
            configs: json!({
                "mcpServers": Value::Object(servers.clone()),
                "mcp_servers": Value::Object(servers)
            }),
        })
    }

    pub async fn remove_from_agents(&self, _records_or_ids: Value) -> Result<Value, McpError> {
        Ok(json!({ "removed": 0 }))
    }

    pub async fn import_agent_config(&self, _input: Value) -> Result<Value, McpError> {
        Ok(json!({ "imported": 0, "sources": [] }))
    }

    pub async fn oauth_status(&self, server_id: &str) -> Result<McpOAuthActionResponse, McpError> {
        let token = self.oauth_token_json(server_id).await?;
        Ok(McpOAuthActionResponse {
            ok: token
                .as_ref()
                .is_some_and(|token| oauth_token_is_current(token, self.now())),
            auth_url: None,
        })
    }

    pub async fn oauth_login(
        &self,
        server_id: &str,
        input: Value,
    ) -> Result<McpOAuthActionResponse, McpError> {
        let row = self.fetch_visible_server(server_id).await?;
        let current = mcp_server_from_row(row)?;
        let transport = unredacted_transport_for_server(&self.pool, &current.id).await?;
        let server_url = oauth_server_url(&transport, &input)?;
        let metadata = self.discover_oauth_metadata(&server_url, &input).await?;
        let client_id = oauth_input_string(&input, &["clientId", "client_id"])
            .unwrap_or_else(|| DEFAULT_OAUTH_CLIENT_ID.to_string());

        let auth_url = AuthUrl::new(metadata.authorization_endpoint.clone())
            .map_err(|error| McpError::OAuth(format!("Invalid auth URL: {error}")))?;
        let token_url = TokenUrl::new(metadata.token_endpoint.clone())
            .map_err(|error| McpError::OAuth(format!("Invalid token URL: {error}")))?;
        let (redirect_uri, callback_listener) =
            match oauth_input_string(&input, &["redirectUri", "redirect_uri"]) {
                Some(value) => (value, None),
                None => {
                    let (redirect_uri, listener) = bind_loopback_callback_listener().await?;
                    (redirect_uri, Some(listener))
                }
            };
        let server_id_for_callback = server_id.to_string();
        let redirect = RedirectUrl::new(redirect_uri.clone())
            .map_err(|error| McpError::OAuth(format!("Invalid redirect URL: {error}")))?;
        let client = BasicClient::new(ClientId::new(client_id.clone()))
            .set_auth_uri(auth_url)
            .set_token_uri(token_url)
            .set_redirect_uri(redirect);
        let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
        let code_challenge = pkce_challenge.as_str().to_string();
        let code_verifier = pkce_verifier.secret().to_string();
        let (authorize_url, csrf_token) = client
            .authorize_url(CsrfToken::new_random)
            .set_pkce_challenge(pkce_challenge)
            .url();
        let state = csrf_token.secret().to_string();
        let authorize_url_string = authorize_url.to_string();
        self.persist_pending_oauth_login(
            server_id,
            PendingOAuthLogin {
                server_url,
                authorization_endpoint: metadata.authorization_endpoint,
                token_endpoint: metadata.token_endpoint,
                redirect_uri,
                client_id,
                state,
                code_challenge,
                code_verifier,
                auth_url: authorize_url_string.clone(),
            },
        )
        .await?;

        if let Some(listener) = callback_listener {
            self.spawn_oauth_callback_listener(server_id_for_callback, listener);
        };

        Ok(McpOAuthActionResponse {
            ok: true,
            auth_url: Some(authorize_url_string),
        })
    }

    fn spawn_oauth_callback_listener(&self, server_id: String, listener: TcpListener) {
        let service = self.clone();
        tokio::spawn(async move {
            let callback = tokio::time::timeout(
                OAUTH_CALLBACK_TIMEOUT,
                handle_oauth_callback_connection(listener),
            )
            .await;
            if let Ok(Ok((code, state))) = callback {
                let _ = service
                    .complete_oauth_callback(&server_id, &state, code)
                    .await;
            }
        });
    }

    async fn complete_oauth_callback(
        &self,
        server_id: &str,
        state: &str,
        code: String,
    ) -> Result<(), McpError> {
        let pending = self
            .oauth_token_json(server_id)
            .await?
            .ok_or_else(|| McpError::OAuth("No pending OAuth login state".to_string()))?;
        if pending.get("pending").and_then(Value::as_bool) != Some(true) {
            return Err(McpError::OAuth("OAuth login is not pending".to_string()));
        }
        if token_expires_at(&pending).is_some_and(|expires_at| expires_at <= self.now()) {
            return Err(McpError::OAuth("OAuth login state expired".to_string()));
        }
        let expected_state = required_json_string(&pending, "state")?;
        if state != expected_state {
            return Err(McpError::OAuth("CSRF state mismatch".to_string()));
        }

        let auth_url = AuthUrl::new(required_json_string(&pending, "authorizationEndpoint")?)
            .map_err(|error| McpError::OAuth(format!("Invalid auth URL: {error}")))?;
        let token_url = TokenUrl::new(required_json_string(&pending, "tokenEndpoint")?)
            .map_err(|error| McpError::OAuth(format!("Invalid token URL: {error}")))?;
        let redirect = RedirectUrl::new(required_json_string(&pending, "redirectUri")?)
            .map_err(|error| McpError::OAuth(format!("Invalid redirect URL: {error}")))?;
        let client_id = required_json_string(&pending, "clientId")?;
        let client = BasicClient::new(ClientId::new(client_id.clone()))
            .set_auth_uri(auth_url)
            .set_token_uri(token_url)
            .set_redirect_uri(redirect);
        let http_client = build_no_redirect_client()?;
        let token_result = client
            .exchange_code(AuthorizationCode::new(code))
            .set_pkce_verifier(PkceCodeVerifier::new(required_json_string(
                &pending,
                "codeVerifier",
            )?))
            .request_async(&http_client)
            .await
            .map_err(|error| McpError::OAuth(format!("Token exchange failed: {error}")))?;

        self.persist_oauth_token(server_id, &pending, &token_result, None)
            .await
    }

    pub async fn oauth_logout(&self, server_id: &str) -> Result<McpOAuthActionResponse, McpError> {
        sqlx::query("DELETE FROM mcp_oauth_tokens WHERE server_id = ?")
            .bind(server_id)
            .execute(&self.pool)
            .await?;
        Ok(McpOAuthActionResponse {
            ok: true,
            auth_url: None,
        })
    }

    async fn transport_with_oauth_headers(
        &self,
        server_id: &str,
        transport: &Value,
    ) -> Result<Value, McpError> {
        if !transport_accepts_oauth_headers(transport) || has_authorization_header(transport) {
            return Ok(transport.clone());
        }
        let Some(header) = self.oauth_authorization_header(server_id).await? else {
            return Ok(transport.clone());
        };
        let mut next = transport.clone();
        if !next.get("headers").is_some_and(Value::is_object)
            && let Some(object) = next.as_object_mut()
        {
            object.insert("headers".to_string(), json!({}));
        }
        if let Some(headers) = next.get_mut("headers").and_then(Value::as_object_mut) {
            headers.insert("Authorization".to_string(), Value::String(header));
        }
        Ok(next)
    }

    async fn oauth_authorization_header(
        &self,
        server_id: &str,
    ) -> Result<Option<String>, McpError> {
        let Some(mut token) = self.oauth_token_json(server_id).await? else {
            return Ok(None);
        };
        if oauth_token_needs_refresh(&token, self.now())
            && !token_string(&token, "refreshToken", "refresh_token").is_empty()
        {
            match self.refresh_oauth_token(server_id, &token).await {
                Ok(Some(refreshed)) => token = refreshed,
                Ok(None) => {}
                Err(_) if oauth_token_is_current(&token, self.now()) => {}
                Err(error) => return Err(error),
            }
        }
        if !oauth_token_is_current(&token, self.now()) {
            return Ok(None);
        }
        let access_token = token_string(&token, "accessToken", "access_token");
        if access_token.is_empty() {
            return Ok(None);
        }
        let token_type = token_string(&token, "tokenType", "token_type");
        let token_type = if token_type.is_empty() {
            "Bearer".to_string()
        } else {
            token_type
        };
        Ok(Some(format!("{token_type} {access_token}")))
    }

    async fn oauth_token_json(&self, server_id: &str) -> Result<Option<Value>, McpError> {
        let row = sqlx::query("SELECT token_json FROM mcp_oauth_tokens WHERE server_id = ?")
            .bind(server_id)
            .fetch_optional(&self.pool)
            .await?;
        row.map(|row| parse_json(row.get::<String, _>("token_json")))
            .transpose()
    }

    async fn refresh_oauth_token(
        &self,
        server_id: &str,
        current: &Value,
    ) -> Result<Option<Value>, McpError> {
        let refresh_token = token_string(current, "refreshToken", "refresh_token");
        if refresh_token.is_empty() {
            return Ok(None);
        }
        let token_endpoint = match json_string(current, "tokenEndpoint") {
            value if !value.is_empty() => value,
            _ => {
                let server_url = required_json_string(current, "serverUrl")?;
                self.discover_oauth_metadata(&server_url, &json!({}))
                    .await?
                    .token_endpoint
            }
        };
        let token_url = TokenUrl::new(token_endpoint)
            .map_err(|error| McpError::OAuth(format!("Invalid token URL: {error}")))?;
        let client_id = match json_string(current, "clientId") {
            value if !value.is_empty() => value,
            _ => DEFAULT_OAUTH_CLIENT_ID.to_string(),
        };
        let client = BasicClient::new(ClientId::new(client_id)).set_token_uri(token_url);
        let http_client = build_no_redirect_client()?;
        let token_result = client
            .exchange_refresh_token(&RefreshToken::new(refresh_token.clone()))
            .request_async(&http_client)
            .await
            .map_err(|error| McpError::OAuth(format!("Token refresh failed: {error}")))?;
        self.persist_oauth_token(server_id, current, &token_result, Some(&refresh_token))
            .await?;
        self.oauth_token_json(server_id).await
    }

    async fn discover_oauth_metadata(
        &self,
        server_url: &str,
        input: &Value,
    ) -> Result<OAuthServerMetadata, McpError> {
        if let Some(metadata) = oauth_metadata_from_input(input) {
            return Ok(metadata);
        }

        let base = server_url.trim_end_matches('/');
        let oauth_metadata_url = format!("{base}/.well-known/oauth-authorization-server");
        if let Ok(metadata) = self.fetch_oauth_metadata(&oauth_metadata_url).await {
            return Ok(metadata);
        }

        let oidc_metadata_url = format!("{base}/.well-known/openid-configuration");
        if let Ok(metadata) = self.fetch_oauth_metadata(&oidc_metadata_url).await {
            return Ok(metadata);
        }

        Err(McpError::OAuth(format!(
            "Failed to discover OAuth endpoints for '{server_url}'"
        )))
    }

    async fn fetch_oauth_metadata(&self, url: &str) -> Result<OAuthServerMetadata, McpError> {
        let response = reqwest::Client::new()
            .get(url)
            .send()
            .await
            .map_err(|error| McpError::OAuth(format!("Metadata request failed: {error}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err(McpError::OAuth(format!(
                "Metadata endpoint returned {status}"
            )));
        }
        response
            .json::<OAuthServerMetadata>()
            .await
            .map_err(|error| McpError::OAuth(format!("Failed to parse metadata: {error}")))
    }

    async fn persist_pending_oauth_login(
        &self,
        server_id: &str,
        pending: PendingOAuthLogin,
    ) -> Result<(), McpError> {
        let now = self.now();
        let token_json = json!({
            "pending": true,
            "serverUrl": pending.server_url,
            "authorizationEndpoint": pending.authorization_endpoint,
            "tokenEndpoint": pending.token_endpoint,
            "redirectUri": pending.redirect_uri,
            "clientId": pending.client_id,
            "state": pending.state,
            "codeChallenge": pending.code_challenge,
            "codeChallengeMethod": "S256",
            "codeVerifier": pending.code_verifier,
            "authUrl": pending.auth_url,
            "createdAt": now,
            "expiresAt": now + OAUTH_PENDING_TTL_MS
        });
        sqlx::query(
            "INSERT INTO mcp_oauth_tokens (server_id, token_json, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(server_id) DO UPDATE SET token_json = excluded.token_json, updated_at = excluded.updated_at",
        )
        .bind(server_id)
        .bind(token_json.to_string())
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn persist_oauth_token<TR>(
        &self,
        server_id: &str,
        context: &Value,
        token_result: &TR,
        fallback_refresh_token: Option<&str>,
    ) -> Result<(), McpError>
    where
        TR: TokenResponse,
        TR::TokenType: AsRef<str>,
    {
        let now = self.now();
        let refresh_token = token_result
            .refresh_token()
            .map(|token| token.secret().to_string())
            .or_else(|| fallback_refresh_token.map(str::to_string));
        let expires_at = token_result
            .expires_in()
            .map(|duration| now + duration.as_millis() as i64);
        let token_json = json!({
            "pending": false,
            "serverUrl": required_json_string(context, "serverUrl")?,
            "authorizationEndpoint": json_string(context, "authorizationEndpoint"),
            "tokenEndpoint": required_json_string(context, "tokenEndpoint")?,
            "redirectUri": json_string(context, "redirectUri"),
            "clientId": json_string(context, "clientId"),
            "accessToken": token_result.access_token().secret(),
            "refreshToken": refresh_token,
            "tokenType": normalize_oauth_token_type(token_result.token_type().as_ref()),
            "expiresAt": expires_at,
            "updatedAt": now
        });
        sqlx::query(
            "INSERT INTO mcp_oauth_tokens (server_id, token_json, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(server_id) DO UPDATE SET token_json = excluded.token_json, updated_at = excluded.updated_at",
        )
        .bind(server_id)
        .bind(token_json.to_string())
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn run_process_managed_action(
        &self,
        server_id: &str,
        current: &McpServerSummary,
        action: &str,
    ) -> Result<McpServerResponse, McpError> {
        match action {
            "start" => self.start_managed_process(server_id, current).await,
            "stop" => self.stop_managed_process(server_id, current).await,
            "test" => self.test_managed_process(server_id, current).await,
            _ => Err(McpError::InvalidInput(format!(
                "unsupported managed process action: {action}"
            ))),
        }
    }

    async fn start_managed_process(
        &self,
        server_id: &str,
        current: &McpServerSummary,
    ) -> Result<McpServerResponse, McpError> {
        if let Some(pid) = self.running_managed_child_pid(server_id).await {
            return self
                .persist_managed_process_state(
                    server_id,
                    current,
                    ManagedProcessState {
                        state: "running",
                        last_action: "start",
                        message: "Managed connector is already running.",
                        enabled: false,
                        pid: Some(pid),
                        next_action: "test",
                    },
                )
                .await;
        }

        let spec = match managed_process_spec(current) {
            Ok(spec) => spec,
            Err(error) => {
                return self
                    .apply_managed_action_failure(server_id, current, "start", &error.to_string())
                    .await;
            }
        };
        let mut command = Command::new(&spec.command);
        configure_background_command(command.as_std_mut());
        command
            .args(&spec.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_INSPECT")
            .env_remove("NODE_DEBUG")
            .env_remove("CLAUDECODE");
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return self
                    .apply_managed_action_failure(
                        server_id,
                        current,
                        "start",
                        &format!("Managed connector failed to start: {error}"),
                    )
                    .await;
            }
        };
        let pid = child.id().unwrap_or(0);
        self.managed_children
            .lock()
            .await
            .insert(server_id.to_string(), child);
        self.persist_managed_process_state(
            server_id,
            current,
            ManagedProcessState {
                state: "running",
                last_action: "start",
                message: "Managed connector started.",
                enabled: false,
                pid: Some(pid),
                next_action: "test",
            },
        )
        .await
    }

    async fn stop_managed_process(
        &self,
        server_id: &str,
        current: &McpServerSummary,
    ) -> Result<McpServerResponse, McpError> {
        let child = self.managed_children.lock().await.remove(server_id);
        if let Some(mut child) = child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.persist_managed_process_state(
            server_id,
            current,
            ManagedProcessState {
                state: "stopped",
                last_action: "stop",
                message: "Managed connector stopped.",
                enabled: false,
                pid: None,
                next_action: "start",
            },
        )
        .await
    }

    async fn test_managed_process(
        &self,
        server_id: &str,
        current: &McpServerSummary,
    ) -> Result<McpServerResponse, McpError> {
        if self.running_managed_child_pid(server_id).await.is_none() {
            self.start_managed_process(server_id, current).await?;
        }
        let tested = self.test_server(server_id).await?;
        if !tested.ok {
            let message = diagnostic_message(&tested.diagnostic);
            let current = self.get_server(server_id).await?.server;
            return self
                .apply_managed_action_failure(server_id, &current, "test", &message)
                .await;
        }
        let current = self.get_server(server_id).await?.server;
        let pid = self.running_managed_child_pid(server_id).await;
        self.persist_managed_process_test_success(server_id, &current, pid)
            .await
    }

    async fn ensure_managed_process_running(
        &self,
        server_id: &str,
        current: &McpServerSummary,
    ) -> Result<McpServerResponse, McpError> {
        let response = self.start_managed_process(server_id, current).await?;
        let current = self.get_server(server_id).await?.server;
        if current.managed_runtime["state"] != "running" {
            return Ok(response);
        }
        let pid = self.running_managed_child_pid(server_id).await;
        self.persist_managed_process_state(
            server_id,
            &current,
            ManagedProcessState {
                state: "running",
                last_action: "start",
                message: "Managed connector is running.",
                enabled: true,
                pid,
                next_action: "test",
            },
        )
        .await
    }

    async fn running_managed_child_pid(&self, server_id: &str) -> Option<u32> {
        let mut children = self.managed_children.lock().await;
        let child = children.get_mut(server_id)?;
        match child.try_wait() {
            Ok(None) => child.id(),
            Ok(Some(_)) | Err(_) => {
                children.remove(server_id);
                None
            }
        }
    }

    async fn persist_managed_process_state(
        &self,
        server_id: &str,
        current: &McpServerSummary,
        state: ManagedProcessState<'_>,
    ) -> Result<McpServerResponse, McpError> {
        let mut managed_runtime = current.managed_runtime.clone();
        if !managed_runtime.is_object() {
            managed_runtime = json!({});
        }
        if let Some(runtime) = managed_runtime.as_object_mut() {
            runtime.insert("state".to_string(), json!(state.state));
            runtime.insert("lastAction".to_string(), json!(state.last_action));
            if let Some(pid) = state.pid {
                runtime.insert("pid".to_string(), json!(pid));
            } else {
                runtime.remove("pid");
            }
        }
        let config = json!({
            "managedRuntime": managed_runtime,
            "connectionWizard": managed_process_wizard(state.next_action, state.message),
        });
        self.update_server(
            server_id,
            UpdateMcpServerRequest {
                name: None,
                description: None,
                transport: None,
                config: Some(config),
                enabled: Some(state.enabled),
            },
        )
        .await
    }

    async fn persist_managed_process_test_success(
        &self,
        server_id: &str,
        current: &McpServerSummary,
        pid: Option<u32>,
    ) -> Result<McpServerResponse, McpError> {
        let mut managed_runtime = current.managed_runtime.clone();
        if !managed_runtime.is_object() {
            managed_runtime = json!({});
        }
        if let Some(runtime) = managed_runtime.as_object_mut() {
            runtime.insert("state".to_string(), json!("running"));
            runtime.insert("lastAction".to_string(), json!("test"));
            if let Some(pid) = pid {
                runtime.insert("pid".to_string(), json!(pid));
            }
        }
        let config = json!({
            "managedRuntime": managed_runtime,
            "connectionWizard": managed_connected_wizard(),
        });
        self.update_server(
            server_id,
            UpdateMcpServerRequest {
                name: None,
                description: None,
                transport: None,
                config: Some(config),
                enabled: Some(true),
            },
        )
        .await
    }

    async fn apply_managed_action_failure(
        &self,
        server_id: &str,
        current: &McpServerSummary,
        action: &str,
        message: &str,
    ) -> Result<McpServerResponse, McpError> {
        let mut managed_runtime = current.managed_runtime.clone();
        if !managed_runtime.is_object() {
            managed_runtime = json!({});
        }
        if let Some(runtime) = managed_runtime.as_object_mut() {
            runtime.insert("state".to_string(), json!("error"));
            runtime.insert("lastAction".to_string(), json!(action));
        }
        let config = json!({
            "managedRuntime": managed_runtime,
            "connectionWizard": managed_action_failure_wizard(action, message),
        });
        self.update_server(
            server_id,
            UpdateMcpServerRequest {
                name: None,
                description: None,
                transport: None,
                config: Some(config),
                enabled: Some(false),
            },
        )
        .await
    }

    async fn fetch_visible_server(
        &self,
        server_id: &str,
    ) -> Result<sqlx::sqlite::SqliteRow, McpError> {
        sqlx::query(
            "SELECT id, name, transport, config_json, enabled, last_test_json, deleted_at, created_at, updated_at \
             FROM mcp_servers WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(server_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| McpError::NotFound(server_id.to_string()))
    }

    async fn fetch_any_server_by_name(
        &self,
        name: &str,
    ) -> Result<Option<sqlx::sqlite::SqliteRow>, McpError> {
        let row = sqlx::query(
            "SELECT id, name, transport, config_json, enabled, last_test_json, deleted_at, created_at, updated_at \
             FROM mcp_servers WHERE name = ?",
        )
        .bind(name)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    fn now(&self) -> i64 {
        (self.now_ms)()
    }
}

fn mcp_server_from_row(row: sqlx::sqlite::SqliteRow) -> Result<McpServerSummary, McpError> {
    let config = parse_json(row.get::<String, _>("config_json"))?;
    let last_test = parse_json(row.get::<String, _>("last_test_json"))?;
    let transport = config.get("transport").cloned().ok_or_else(|| {
        McpError::InvalidInput("stored MCP record is missing transport".to_string())
    })?;
    let status = last_test
        .get("status")
        .and_then(Value::as_str)
        .or_else(|| config.get("status").and_then(Value::as_str))
        .unwrap_or("disconnected")
        .to_string();
    let created_at: i64 = row.get("created_at");
    let updated_at: i64 = row.get("updated_at");

    Ok(McpServerSummary {
        id: row.get("id"),
        name: row.get("name"),
        description: config
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|value| !value.is_empty()),
        native_name: config
            .get("nativeName")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| stable_native_name(row.get::<String, _>("name").as_str())),
        enabled: row.get("enabled"),
        transport: public_transport(&transport),
        config: public_config(&config),
        status: status.clone(),
        last_test_status: status,
        last_test_code: last_test.get("code").cloned(),
        tools: last_test
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        diagnostics: public_diagnostics(&last_test),
        oauth: config
            .get("oauth")
            .cloned()
            .unwrap_or_else(|| json!({ "authenticated": false, "provider": "", "tokenRef": "" })),
        sync: config
            .get("sync")
            .cloned()
            .unwrap_or_else(default_sync_json),
        source_agent: config
            .get("sourceAgent")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        created_at,
        updated_at,
        deleted_at: row.get("deleted_at"),
        last_checked_at: last_test
            .get("details")
            .and_then(|value| value.get("validatedAt"))
            .and_then(Value::as_i64)
            .unwrap_or(0),
        last_error: clean_text(
            last_test
                .get("error")
                .or_else(|| last_test.get("message"))
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
        registry_id: config
            .get("registryId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        source: config
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("custom")
            .to_string(),
        management_mode: config
            .get("managementMode")
            .and_then(Value::as_str)
            .unwrap_or("custom")
            .to_string(),
        required_inputs: config
            .get("requiredInputs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        connection_wizard: config
            .get("connectionWizard")
            .cloned()
            .unwrap_or_else(default_connection_wizard),
        managed_runtime: config
            .get("managedRuntime")
            .cloned()
            .unwrap_or_else(|| json!({})),
        homepage: config
            .get("homepage")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        setup_hint: clean_text(
            config
                .get("setupHint")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
        setup_commands: config
            .get("setupCommands")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(clean_text)
            .collect(),
        expected_tool_count: config
            .get("expectedToolCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        original_json: clean_text(
            config
                .get("originalJson")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
    })
}

async fn unredacted_transport_for_server(
    pool: &SqlitePool,
    server_id: &str,
) -> Result<Value, McpError> {
    let row = sqlx::query("SELECT config_json FROM mcp_servers WHERE id = ?")
        .bind(server_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| McpError::NotFound(server_id.to_string()))?;
    let config = parse_json(row.get::<String, _>("config_json"))?;
    config
        .get("transport")
        .cloned()
        .ok_or_else(|| McpError::InvalidInput("stored MCP record is missing transport".to_string()))
}

fn normalize_transport_request(
    transport: &Value,
    config: Option<&Value>,
    existing: Option<&Value>,
) -> Result<Value, McpError> {
    let mut source = match transport {
        Value::String(kind) => {
            let mut object = match config {
                Some(Value::Object(object)) => object.clone(),
                _ => Map::new(),
            };
            object.insert("type".to_string(), Value::String(kind.clone()));
            Value::Object(object)
        }
        Value::Object(_) => transport.clone(),
        _ => {
            return Err(McpError::InvalidTransport(
                "transport must be an object or type string".to_string(),
            ));
        }
    };
    preserve_masked_transport_values(&mut source, existing);
    normalize_transport(&source)
}

fn normalize_transport(input: &Value) -> Result<Value, McpError> {
    let object = input
        .as_object()
        .ok_or_else(|| McpError::InvalidTransport("transport must be an object".to_string()))?;
    let raw_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if object.get("url").and_then(Value::as_str).is_some() {
                "http"
            } else {
                "stdio"
            }
        })
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_");
    let kind = if raw_type == "streamable_http" {
        "http".to_string()
    } else {
        raw_type
    };

    if kind == "stdio" {
        let command = object
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if command.is_empty() {
            return Err(McpError::InvalidTransport(
                "stdio transport requires command".to_string(),
            ));
        }
        let input_args = string_array(object.get("args"));
        let (command, args) = if input_args.is_empty() {
            split_stdio_command(command)
        } else {
            (command.to_string(), input_args)
        };
        return Ok(json!({
            "type": "stdio",
            "command": command,
            "args": args,
            "env": clean_object(object.get("env"))
        }));
    }

    if kind == "http" || kind == "sse" {
        let url = object
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if !is_http_url(&url) {
            return Err(McpError::InvalidTransport(format!(
                "{kind} transport requires http(s) url"
            )));
        }
        let mut out = json!({
            "type": kind,
            "url": url,
            "headers": clean_object(object.get("headers"))
        });
        let bearer_token_env_var = object
            .get("bearerTokenEnvVar")
            .or_else(|| object.get("bearer_token_env_var"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if !bearer_token_env_var.is_empty() {
            out["bearerTokenEnvVar"] = Value::String(bearer_token_env_var.to_string());
        }
        return Ok(out);
    }

    Err(McpError::InvalidTransport(format!(
        "unsupported MCP transport type: {kind}"
    )))
}

fn validate_normalized_transport(transport: &Value) -> Result<(), McpError> {
    let kind = transport
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "stdio"
            if transport
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("")
                .is_empty() =>
        {
            Err(McpError::InvalidTransport(
                "stdio transport requires command".to_string(),
            ))
        }
        "http" | "sse"
            if !is_http_url(transport.get("url").and_then(Value::as_str).unwrap_or("")) =>
        {
            Err(McpError::InvalidTransport(
                "url transport requires http(s) url".to_string(),
            ))
        }
        "stdio" | "http" | "sse" => Ok(()),
        other => Err(McpError::InvalidTransport(format!(
            "unsupported MCP transport type: {other}"
        ))),
    }
}

struct ServerConfigInput<'a> {
    name: &'a str,
    description: Option<&'a str>,
    transport: &'a Value,
    enabled: bool,
    created_at: i64,
    updated_at: i64,
    existing: Option<&'a McpServerSummary>,
    input_config: Option<&'a Value>,
}

fn server_config_json(input: ServerConfigInput<'_>) -> Value {
    let mut config = json!({
        "description": clean_text(input.description.unwrap_or("")),
        "nativeName": input.existing.map(|server| server.native_name.clone()).unwrap_or_else(|| stable_native_name(input.name)),
        "transport": input.transport,
        "enabled": input.enabled,
        "status": input.existing.map(|server| server.status.clone()).unwrap_or_else(|| "disconnected".to_string()),
        "sync": input.existing.map(|server| server.sync.clone()).unwrap_or_else(default_sync_json),
        "oauth": input.existing.map(|server| server.oauth.clone()).unwrap_or_else(|| json!({ "authenticated": false, "provider": "", "tokenRef": "" })),
        "source": input.existing.map(|server| server.source.clone()).unwrap_or_else(|| "custom".to_string()),
        "managementMode": input.existing.map(|server| server.management_mode.clone()).unwrap_or_else(|| "custom".to_string()),
        "requiredInputs": input.existing.map(|server| Value::Array(server.required_inputs.clone())).unwrap_or_else(|| json!([])),
        "connectionWizard": input.existing.map(|server| server.connection_wizard.clone()).unwrap_or_else(default_connection_wizard),
        "managedRuntime": input.existing.map(|server| server.managed_runtime.clone()).unwrap_or_else(|| json!({})),
        "createdAt": input.created_at,
        "updatedAt": input.updated_at,
    });
    if let Some(Value::Object(patch)) = input.input_config {
        merge_config_patch(&mut config, patch);
    }
    config["description"] = Value::String(clean_text(
        input
            .description
            .or_else(|| config.get("description").and_then(Value::as_str))
            .unwrap_or(""),
    ));
    config["transport"] = input.transport.clone();
    config["enabled"] = Value::Bool(input.enabled);
    config["createdAt"] = json!(input.created_at);
    config["updatedAt"] = json!(input.updated_at);
    config
}

fn merge_config_patch(target: &mut Value, patch: &Map<String, Value>) {
    let Some(target) = target.as_object_mut() else {
        return;
    };
    for (key, value) in patch {
        if key == "transport" || key == "enabled" || key == "createdAt" || key == "updatedAt" {
            continue;
        }
        target.insert(key.clone(), value.clone());
    }
}

fn public_config(config: &Value) -> Value {
    redact_value("", config)
}

fn public_transport(transport: &Value) -> Value {
    redact_value("", transport)
}

fn public_diagnostics(diagnostics: &Value) -> Value {
    redact_value("", diagnostics)
}

fn public_agent_transport(transport: &Value) -> Value {
    public_transport(transport)
}

fn diagnostic_message(diagnostic: &Value) -> String {
    clean_text(
        diagnostic
            .get("message")
            .or_else(|| diagnostic.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("Managed connector connection test failed."),
    )
}

fn transport_accepts_oauth_headers(transport: &Value) -> bool {
    matches!(
        transport.get("type").and_then(Value::as_str),
        Some("http" | "sse")
    )
}

fn has_authorization_header(transport: &Value) -> bool {
    transport
        .get("headers")
        .and_then(Value::as_object)
        .is_some_and(|headers| {
            headers
                .keys()
                .any(|key| key.trim().eq_ignore_ascii_case("authorization"))
        })
}

fn managed_connector_id(server: &McpServerSummary) -> String {
    json_string(&server.managed_runtime, "connectorId")
}

fn managed_process_spec(server: &McpServerSummary) -> Result<ManagedProcessSpec, McpError> {
    let command = json_string(&server.managed_runtime, "command");
    if command.is_empty() {
        return Err(McpError::InvalidInput(
            "managed process command is required".to_string(),
        ));
    }
    let args = string_array(server.managed_runtime.get("args"));
    let cwd = match json_string(&server.managed_runtime, "cwd") {
        value if value.is_empty() => None,
        value => Some(value),
    };
    let env = server
        .managed_runtime
        .get("env")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| {
            value
                .as_str()
                .map(|value| (key.to_string(), value.to_string()))
        })
        .collect();
    Ok(ManagedProcessSpec {
        command,
        args,
        env,
        cwd,
    })
}

fn oauth_token_is_current(token: &Value, now: i64) -> bool {
    if token_string(token, "accessToken", "access_token").is_empty() {
        return false;
    }
    token_expires_at(token).is_none_or(|expires_at| expires_at > now)
}

fn oauth_token_needs_refresh(token: &Value, now: i64) -> bool {
    token_expires_at(token).is_some_and(|expires_at| expires_at <= now + OAUTH_EXPIRY_MARGIN_MS)
}

fn oauth_server_url(transport: &Value, input: &Value) -> Result<String, McpError> {
    let server_url = oauth_input_string(input, &["serverUrl", "server_url", "url"])
        .or_else(|| {
            input
                .get("transport")
                .and_then(|transport| oauth_input_string(transport, &["url"]))
        })
        .or_else(|| oauth_input_string(transport, &["url"]))
        .ok_or_else(|| McpError::InvalidInput("serverUrl is required for MCP OAuth".to_string()))?;
    if !is_http_url(&server_url) {
        return Err(McpError::InvalidInput(
            "serverUrl must be an http(s) URL for MCP OAuth".to_string(),
        ));
    }
    Ok(server_url)
}

fn oauth_metadata_from_input(input: &Value) -> Option<OAuthServerMetadata> {
    let authorization_endpoint = oauth_input_string(
        input,
        &[
            "authorizationEndpoint",
            "authorizationUrl",
            "authorization_endpoint",
            "authorization_url",
        ],
    )?;
    let token_endpoint = oauth_input_string(input, &["tokenEndpoint", "token_endpoint"])?;
    Some(OAuthServerMetadata {
        authorization_endpoint,
        token_endpoint,
    })
}

fn oauth_input_string(input: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| input.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

async fn bind_loopback_callback_listener() -> Result<(String, TcpListener), McpError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| McpError::OAuth(format!("Failed to bind OAuth callback port: {error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| McpError::OAuth(format!("Failed to read OAuth callback port: {error}")))?
        .port();
    Ok((format!("http://127.0.0.1:{port}/callback"), listener))
}

async fn handle_oauth_callback_connection(
    listener: TcpListener,
) -> Result<(String, String), McpError> {
    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|error| McpError::OAuth(format!("Failed to accept OAuth callback: {error}")))?;
    let mut buffer = vec![0_u8; 4096];
    let bytes_read = stream
        .read(&mut buffer)
        .await
        .map_err(|error| McpError::OAuth(format!("Failed to read OAuth callback: {error}")))?;
    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    let parsed = parse_oauth_callback_query(&request);
    let (status, body) = if parsed.is_ok() {
        (
            "200 OK",
            "<html><body><h1>Authorization successful</h1><p>You can close this window.</p></body></html>",
        )
    } else {
        (
            "400 Bad Request",
            "<html><body><h1>Authorization failed</h1><p>Return to Mia and try again.</p></body></html>",
        )
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    parsed
}

fn parse_oauth_callback_query(request: &str) -> Result<(String, String), McpError> {
    let first_line = request
        .lines()
        .next()
        .ok_or_else(|| McpError::OAuth("Empty OAuth callback request".to_string()))?;
    let path = first_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| McpError::OAuth("Malformed OAuth callback request".to_string()))?;
    let query = path
        .split_once('?')
        .map(|(_, query)| query)
        .ok_or_else(|| McpError::OAuth("OAuth callback is missing query parameters".to_string()))?;
    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            match key {
                "code" => code = Some(url_decode(value)),
                "state" => state = Some(url_decode(value)),
                _ => {}
            }
        }
    }
    Ok((
        code.ok_or_else(|| McpError::OAuth("OAuth callback is missing code".to_string()))?,
        state.ok_or_else(|| McpError::OAuth("OAuth callback is missing state".to_string()))?,
    ))
}

fn url_decode(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut bytes = input.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let high = bytes.next();
            let low = bytes.next();
            if let (Some(high), Some(low)) = (high, low) {
                let hex = [high, low];
                if let Ok(text) = std::str::from_utf8(&hex)
                    && let Ok(decoded) = u8::from_str_radix(text, 16)
                {
                    result.push(decoded as char);
                    continue;
                }
                result.push('%');
                result.push(high as char);
                result.push(low as char);
            }
        } else if byte == b'+' {
            result.push(' ');
        } else {
            result.push(byte as char);
        }
    }
    result
}

fn build_no_redirect_client() -> Result<reqwest::Client, McpError> {
    reqwest::ClientBuilder::new()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| McpError::OAuth(format!("Failed to build OAuth HTTP client: {error}")))
}

fn required_json_string(input: &Value, key: &str) -> Result<String, McpError> {
    let value = json_string(input, key);
    if value.is_empty() {
        return Err(McpError::OAuth(format!(
            "OAuth token state is missing {key}"
        )));
    }
    Ok(value)
}

fn json_string(input: &Value, key: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn normalize_oauth_token_type(value: &str) -> String {
    if value.eq_ignore_ascii_case("bearer") {
        "Bearer".to_string()
    } else {
        value.trim().to_string()
    }
}

fn token_string(token: &Value, camel: &str, snake: &str) -> String {
    token
        .get(camel)
        .or_else(|| token.get(snake))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn token_expires_at(token: &Value) -> Option<i64> {
    token
        .get("expiresAt")
        .or_else(|| token.get("expires_at"))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
        })
}

fn redact_value(key: &str, value: &Value) -> Value {
    match value {
        Value::String(text) => {
            if is_sensitive_key(key) && !text.is_empty() {
                Value::String(MASK.to_string())
            } else {
                Value::String(clean_text(text))
            }
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| redact_value("", item)).collect())
        }
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(child_key, child_value)| {
                    (child_key.clone(), redact_value(child_key, child_value))
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn preserve_masked_transport_values(input: &mut Value, existing: Option<&Value>) {
    let Some(existing) = existing.and_then(Value::as_object) else {
        return;
    };
    let Some(input_object) = input.as_object_mut() else {
        return;
    };
    for key in ["env", "headers"] {
        let Some(input_child) = input_object.get_mut(key).and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(existing_child) = existing.get(key).and_then(Value::as_object) else {
            continue;
        };
        for (entry_key, entry_value) in input_child.iter_mut() {
            if entry_value.as_str() == Some(MASK)
                && let Some(existing_value) = existing_child.get(entry_key)
            {
                *entry_value = existing_value.clone();
            }
        }
    }
}

fn parse_import_records(input: Value) -> Result<Vec<CreateMcpServerRequest>, McpError> {
    let source = match input {
        Value::String(text) => serde_json::from_str::<Value>(&text)
            .map_err(|error| McpError::InvalidInput(error.to_string()))?,
        value => value,
    };
    let servers = source
        .get("mcpServers")
        .or_else(|| source.get("mcp_servers"))
        .or_else(|| source.get("servers"))
        .and_then(Value::as_object)
        .ok_or_else(|| McpError::InvalidInput("import JSON must contain mcpServers".to_string()))?;
    Ok(servers
        .iter()
        .map(|(name, value)| {
            let spec = value.as_object().cloned().unwrap_or_default();
            let transport = if spec.contains_key("transport") {
                spec.get("transport").cloned().unwrap_or_else(|| json!({}))
            } else {
                Value::Object(spec.clone())
            };
            CreateMcpServerRequest {
                name: spec
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(name)
                    .to_string(),
                description: spec
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                enabled: Some(false),
                transport,
                config: None,
            }
        })
        .collect())
}

fn builtin_mcp_templates() -> Vec<Value> {
    vec![
        json!({
            "id": "playwright",
            "name": "Playwright MCP",
            "nativeName": "playwright",
            "description": "浏览器自动化、截图、点击、输入和页面验证。",
            "category": "浏览器自动化",
            "managementMode": "native",
            "transport": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@latest"], "env": {} },
            "requiredInputs": []
        }),
        json!({
            "id": "context7",
            "name": "Context7 MCP",
            "nativeName": "context7",
            "description": "为编程 Agent 提供库文档和版本化代码示例。",
            "category": "开发",
            "managementMode": "native",
            "transport": { "type": "stdio", "command": "npx", "args": ["-y", "@upstash/context7-mcp@latest"], "env": {} },
            "requiredInputs": []
        }),
        json!({
            "id": "github",
            "name": "GitHub MCP",
            "nativeName": "github",
            "description": "读取仓库、issue 和 pull request。",
            "category": "开发",
            "managementMode": "native",
            "transport": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {} },
            "requiredInputs": [
                { "key": "GITHUB_PERSONAL_ACCESS_TOKEN", "label": "GitHub Personal Access Token", "secret": true, "target": "env", "required": true }
            ]
        }),
        json!({
            "id": "tavily",
            "name": "Tavily MCP",
            "nativeName": "tavily",
            "description": "联网搜索和网页检索。",
            "category": "搜索",
            "managementMode": "native",
            "transport": { "type": "stdio", "command": "npx", "args": ["-y", "tavily-mcp@latest"], "env": {} },
            "requiredInputs": [
                { "key": "TAVILY_API_KEY", "label": "Tavily API Key", "secret": true, "target": "env", "required": true }
            ]
        }),
        json!({
            "id": "firecrawl",
            "name": "Firecrawl MCP",
            "nativeName": "firecrawl",
            "description": "网页抓取、结构化提取和站点爬取。",
            "category": "网页抓取",
            "managementMode": "native",
            "transport": { "type": "stdio", "command": "npx", "args": ["-y", "firecrawl-mcp@latest"], "env": {} },
            "requiredInputs": [
                { "key": "FIRECRAWL_API_KEY", "label": "Firecrawl API Key", "secret": true, "target": "env", "required": true }
            ]
        }),
        json!({
            "id": "managed-process",
            "name": "本地进程 MCP",
            "nativeName": "managed-process",
            "description": "由 Mia Rust Core 启动、检测和停止的本地 HTTP MCP 进程。",
            "category": "本地服务",
            "managementMode": "managed",
            "transport": { "type": "http", "url": "http://127.0.0.1:18060/mcp", "headers": {} },
            "requiredInputs": [
                { "key": "MCP_PROCESS_COMMAND", "label": "启动命令", "target": "managedRuntime.commandLine", "required": true },
                { "key": "MCP_PROCESS_ENDPOINT", "label": "MCP HTTP Endpoint", "target": "transport.url", "required": true },
                { "key": "MCP_PROCESS_CWD", "label": "工作目录", "target": "managedRuntime.cwd", "required": false }
            ],
            "managedRuntime": {
                "connectorId": "process",
                "command": "",
                "args": [],
                "env": {},
                "cwd": "",
                "state": "not_started",
                "lastAction": "",
                "expectedToolCount": 0
            }
        }),
    ]
}

fn builtin_mcp_template_by_id(template_id: &str) -> Option<Value> {
    let needle = template_id.trim();
    builtin_mcp_templates()
        .into_iter()
        .find(|template| template.get("id").and_then(Value::as_str) == Some(needle))
}

fn materialize_builtin_template(
    template: &Value,
    values: Value,
) -> Result<CreateMcpServerRequest, McpError> {
    let template_id = template
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| McpError::InvalidInput("template id is required".to_string()))?;
    let template_name = template
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(template_id);
    let description = template
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("");
    let native_name = template
        .get("nativeName")
        .and_then(Value::as_str)
        .unwrap_or(template_id);
    let management_mode = template
        .get("managementMode")
        .and_then(Value::as_str)
        .unwrap_or("native");
    if management_mode != "native" && management_mode != "managed" {
        return Err(McpError::InvalidInput(format!(
            "unsupported built-in MCP management mode: {management_mode}"
        )));
    }

    let required_inputs = template
        .get("requiredInputs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let missing_required_inputs = required_inputs
        .iter()
        .filter(|field| field.get("required").and_then(Value::as_bool) != Some(false))
        .filter_map(|field| field.get("key").and_then(Value::as_str))
        .filter(|key| input_value(&values, key).is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut transport = template
        .get("transport")
        .cloned()
        .ok_or_else(|| McpError::InvalidInput("template transport is required".to_string()))?;
    let mut managed_runtime = template
        .get("managedRuntime")
        .cloned()
        .unwrap_or_else(|| json!({}));
    fill_template_inputs(
        &mut transport,
        &mut managed_runtime,
        &values,
        &required_inputs,
    );
    let status = if missing_required_inputs.is_empty() {
        "disconnected"
    } else {
        "configuration_required"
    };
    let name = values
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(template_name);
    let config = json!({
        "description": description,
        "nativeName": values.get("nativeName").or_else(|| values.get("native_name")).and_then(Value::as_str).unwrap_or(native_name),
        "registryId": template_id,
        "source": "marketplace",
        "status": status,
        "managementMode": management_mode,
        "requiredInputs": required_inputs,
        "connectionWizard": wizard_for_template(management_mode, &missing_required_inputs),
        "managedRuntime": managed_runtime,
        "homepage": template.get("homepage").and_then(Value::as_str).unwrap_or(""),
        "expectedToolCount": template.get("managedRuntime").and_then(|value| value.get("expectedToolCount")).and_then(Value::as_i64).unwrap_or(0),
    });
    Ok(CreateMcpServerRequest {
        name: name.to_string(),
        description: Some(description.to_string()),
        enabled: Some(false),
        transport,
        config: Some(config),
    })
}

fn input_value(values: &Value, key: &str) -> String {
    values
        .get(key)
        .or_else(|| values.get("env").and_then(|env| env.get(key)))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn fill_template_inputs(
    transport: &mut Value,
    managed_runtime: &mut Value,
    values: &Value,
    required_inputs: &[Value],
) {
    for field in required_inputs {
        let Some(key) = field.get("key").and_then(Value::as_str) else {
            continue;
        };
        let value = input_value(values, key);
        match field.get("target").and_then(Value::as_str).unwrap_or("env") {
            "env" => insert_transport_env(transport, key, value),
            "transport.url" => insert_json_string(transport, "url", value),
            "managedRuntime.commandLine" => insert_managed_process_command(managed_runtime, &value),
            "managedRuntime.cwd" => insert_json_string(managed_runtime, "cwd", value),
            _ => {}
        }
    }
    if managed_runtime.get("connectorId").and_then(Value::as_str) == Some("process")
        && let Some(object) = managed_runtime.as_object_mut()
    {
        object.insert("env".to_string(), clean_object(values.get("env")));
    }
}

fn insert_transport_env(transport: &mut Value, key: &str, value: String) {
    if transport.get("type").and_then(Value::as_str) != Some("stdio") {
        return;
    }
    if !transport.get("env").is_some_and(Value::is_object)
        && let Some(object) = transport.as_object_mut()
    {
        object.insert("env".to_string(), json!({}));
    }
    if let Some(env) = transport.get_mut("env").and_then(Value::as_object_mut) {
        env.insert(key.to_string(), Value::String(value));
    }
}

fn insert_json_string(target: &mut Value, key: &str, value: String) {
    let Some(object) = target.as_object_mut() else {
        return;
    };
    object.insert(key.to_string(), Value::String(value));
}

fn insert_managed_process_command(managed_runtime: &mut Value, command_line: &str) {
    let tokens = shell_split(command_line);
    let Some(command) = tokens.first() else {
        return;
    };
    let Some(object) = managed_runtime.as_object_mut() else {
        return;
    };
    object.insert("command".to_string(), Value::String(command.to_string()));
    object.insert(
        "args".to_string(),
        Value::Array(
            tokens[1..]
                .iter()
                .map(|token| Value::String(token.to_string()))
                .collect(),
        ),
    );
}

fn wizard_for_template(management_mode: &str, missing_required_inputs: &[String]) -> Value {
    if management_mode == "managed" {
        return json!({
            "state": "needs_managed_action",
            "nextAction": "start",
            "message": "",
            "missingRequiredInputs": missing_required_inputs,
            "actions": [{ "id": "start", "label": "启动服务" }, { "id": "test", "label": "检测并启用" }]
        });
    }
    json!({
        "state": if missing_required_inputs.is_empty() { "ready_to_test" } else { "missing_required_inputs" },
        "nextAction": if missing_required_inputs.is_empty() { "test" } else { "enter_required_inputs" },
        "message": if missing_required_inputs.is_empty() { "Mia 将检测连接，成功后启用到新对话。" } else { "填写必填字段后，Mia 会检测连接并启用。" },
        "missingRequiredInputs": missing_required_inputs,
        "actions": [{ "id": "test", "label": "检测并启用" }]
    })
}

fn managed_action_failure_wizard(action: &str, message: &str) -> Value {
    let next_action = if action == "test" { "test" } else { "start" };
    json!({
        "state": "managed_error",
        "nextAction": next_action,
        "message": clean_text(message),
        "missingRequiredInputs": [],
        "actions": [{ "id": "start", "label": "启动服务" }, { "id": "test", "label": "检测并启用" }]
    })
}

fn managed_process_wizard(next_action: &str, message: &str) -> Value {
    json!({
        "state": "needs_managed_action",
        "nextAction": next_action,
        "message": clean_text(message),
        "missingRequiredInputs": [],
        "actions": [{ "id": "start", "label": "启动服务" }, { "id": "test", "label": "检测并启用" }]
    })
}

fn managed_connected_wizard() -> Value {
    json!({
        "state": "connected",
        "nextAction": "test",
        "message": "MCP 已连接。",
        "missingRequiredInputs": [],
        "actions": [{ "id": "test", "label": "重新检测" }, { "id": "start", "label": "重启服务" }]
    })
}

fn transport_type(transport: &Value) -> String {
    transport
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("stdio")
        .to_string()
}

fn clean_name(value: &str) -> Result<String, McpError> {
    let name = clean_text(value);
    if name.is_empty() {
        return Err(McpError::InvalidInput("name is required".to_string()));
    }
    Ok(name)
}

fn clean_text(value: &str) -> String {
    value
        .replace('\u{001b}', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn stable_native_name(value: &str) -> String {
    let slug = value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if slug.is_empty() {
        "mcp".to_string()
    } else {
        slug
    }
}

fn default_sync_json() -> Value {
    let mut sync = Map::new();
    for engine in DEFAULT_SYNC_ENGINES {
        sync.insert(
            engine.to_string(),
            json!({ "status": "pending", "message": "" }),
        );
    }
    Value::Object(sync)
}

fn default_connection_wizard() -> Value {
    json!({
        "state": "idle",
        "nextAction": "",
        "message": "",
        "missingRequiredInputs": [],
        "actions": []
    })
}

fn clean_object(value: Option<&Value>) -> Value {
    let object = value.and_then(Value::as_object);
    Value::Object(
        object
            .into_iter()
            .flatten()
            .filter_map(|(key, value)| {
                let key = key.trim();
                if key.is_empty() {
                    return None;
                }
                Some((key.to_string(), Value::String(value_to_clean_string(value))))
            })
            .collect(),
    )
}

fn value_to_clean_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.to_string(),
        other => other.to_string(),
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn is_http_url(value: &str) -> bool {
    let text = value.trim().to_ascii_lowercase();
    text.starts_with("http://") || text.starts_with("https://")
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "passwd",
        "api_key",
        "apikey",
        "api-key",
        "authorization",
        "bearer",
        "cookie",
        "session",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

fn split_stdio_command(command: &str) -> (String, Vec<String>) {
    let trimmed = command.trim();
    if !trimmed.contains(char::is_whitespace) {
        return (trimmed.to_string(), Vec::new());
    }
    let tokens = shell_split(trimmed);
    if tokens.len() < 2 || !SPLITTABLE_STDIO_LAUNCHERS.contains(&tokens[0].as_str()) {
        return (trimmed.to_string(), Vec::new());
    }
    (tokens[0].clone(), tokens[1..].to_vec())
}

fn shell_split(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaping = false;
    for ch in input.chars() {
        if escaping {
            current.push(ch);
            escaping = false;
            continue;
        }
        if ch == '\\' {
            escaping = true;
            continue;
        }
        if let Some(active) = quote {
            if ch == active {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '"' | '\'' => quote = Some(ch),
            c if c.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn parse_json(raw: String) -> Result<Value, McpError> {
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&raw).map_err(|error| McpError::InvalidInput(error.to_string()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
