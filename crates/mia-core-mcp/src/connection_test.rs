use std::collections::HashMap;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};

const PROTOCOL_VERSION: &str = "2024-11-05";
const CLIENT_NAME: &str = "mia-mcp-test";
const CLIENT_VERSION: &str = "1.0.0";

pub(crate) async fn test_connection(
    server_name: &str,
    transport: &Value,
    timeout_duration: Duration,
) -> Value {
    let started = Instant::now();
    match transport
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("stdio")
    {
        "stdio" => test_stdio(server_name, transport, timeout_duration, started).await,
        "http" => test_http(server_name, transport, timeout_duration, started).await,
        "sse" => test_sse(server_name, transport, timeout_duration, started).await,
        other => diagnostic_error(
            "connection_failed",
            format!("Unsupported MCP transport: {other}"),
            json!({ "transport": other, "durationMs": duration_ms(started) }),
        ),
    }
}

pub(crate) fn tool_names(diagnostic: &Value) -> Vec<String> {
    diagnostic
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

async fn test_stdio(
    server_name: &str,
    transport: &Value,
    timeout_duration: Duration,
    started: Instant,
) -> Value {
    let command = transport
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if command.is_empty() {
        return diagnostic_error(
            "connection_failed",
            "stdio transport requires command",
            json!({ "transport": "stdio", "durationMs": duration_ms(started) }),
        );
    }

    let mut child_command = Command::new(command);
    child_command
        .args(string_array(transport.get("args")))
        .envs(string_map(transport.get("env")))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = match child_command.spawn() {
        Ok(child) => child,
        Err(error) => return spawn_error_diagnostic(command, &error, started),
    };
    let stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let result = match tokio::time::timeout(
        timeout_duration,
        run_stdio_protocol(server_name, stdin, stdout, started),
    )
    .await
    {
        Ok(diagnostic) => diagnostic,
        Err(_) => timeout_diagnostic(timeout_duration, started),
    };
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

async fn test_http(
    server_name: &str,
    transport: &Value,
    timeout_duration: Duration,
    started: Instant,
) -> Value {
    match tokio::time::timeout(
        timeout_duration,
        test_http_inner(server_name, transport, started),
    )
    .await
    {
        Ok(diagnostic) => diagnostic,
        Err(_) => timeout_diagnostic(timeout_duration, started),
    }
}

async fn test_http_inner(server_name: &str, transport: &Value, started: Instant) -> Value {
    let Some(url) = transport.get("url").and_then(Value::as_str) else {
        return diagnostic_error(
            "connection_failed",
            "http transport requires url",
            json!({ "transport": "http", "durationMs": duration_ms(started) }),
        );
    };
    let client = reqwest::Client::new();
    let mut headers = http_headers(transport);
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        "application/json".parse().expect("valid header"),
    );
    headers.insert(
        reqwest::header::ACCEPT,
        "application/json, text/event-stream"
            .parse()
            .expect("valid header"),
    );

    let init_response = match post_jsonrpc(
        &client,
        url,
        headers.clone(),
        &initialize_request(1),
        "http",
        started,
    )
    .await
    {
        Ok(response) => response,
        Err(diagnostic) => return diagnostic,
    };
    if let Some(error) = init_response.rpc.error {
        return rpc_error_diagnostic("initialize", &error, started);
    }
    if let Some(session_id) = init_response.session_id
        && let Ok(value) = reqwest::header::HeaderValue::from_str(&session_id)
    {
        headers.insert("mcp-session-id", value);
    }

    let _ = client
        .post(url)
        .headers(headers.clone())
        .json(&initialized_notification())
        .send()
        .await;

    let tools_response = match post_jsonrpc(
        &client,
        url,
        headers,
        &tools_list_request(2),
        "http",
        started,
    )
    .await
    {
        Ok(response) => response,
        Err(diagnostic) => return diagnostic,
    };
    if let Some(error) = tools_response.rpc.error {
        return rpc_error_diagnostic("tools/list", &error, started);
    }
    success_diagnostic(server_name, tools_response.rpc.result, started)
}

async fn test_sse(
    server_name: &str,
    transport: &Value,
    timeout_duration: Duration,
    started: Instant,
) -> Value {
    match tokio::time::timeout(
        timeout_duration,
        test_sse_inner(server_name, transport, started),
    )
    .await
    {
        Ok(diagnostic) => diagnostic,
        Err(_) => timeout_diagnostic(timeout_duration, started),
    }
}

async fn test_sse_inner(server_name: &str, transport: &Value, started: Instant) -> Value {
    let Some(url) = transport.get("url").and_then(Value::as_str) else {
        return diagnostic_error(
            "connection_failed",
            "sse transport requires url",
            json!({ "transport": "sse", "durationMs": duration_ms(started) }),
        );
    };
    let client = reqwest::Client::new();
    let headers = http_headers(transport);
    let mut stream = match client
        .get(url)
        .headers(headers.clone())
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return request_error_diagnostic("sse", error, started),
    };
    if stream.status() == reqwest::StatusCode::UNAUTHORIZED {
        return auth_diagnostic(stream.headers(), started);
    }
    if !stream.status().is_success() {
        return diagnostic_error(
            "http_error",
            format!("HTTP {} from MCP server", stream.status().as_u16()),
            json!({ "transport": "sse", "httpStatus": stream.status().as_u16(), "durationMs": duration_ms(started) }),
        );
    }

    let endpoint = match wait_for_sse_event(&mut stream, "endpoint").await {
        Ok(event) => match resolve_endpoint_url(url, &event.data) {
            Ok(endpoint) => endpoint,
            Err(error) => {
                return diagnostic_error(
                    "protocol_error",
                    error,
                    json!({ "transport": "sse", "stage": "endpoint", "durationMs": duration_ms(started) }),
                );
            }
        },
        Err(error) => {
            return diagnostic_error(
                "protocol_error",
                error,
                json!({ "transport": "sse", "stage": "endpoint", "durationMs": duration_ms(started) }),
            );
        }
    };

    if let Err(error) = sse_post(&client, &endpoint, headers.clone(), &initialize_request(1)).await
    {
        return diagnostic_error(
            "protocol_error",
            format!("Failed to send initialize: {error}"),
            json!({ "transport": "sse", "stage": "initialize_send", "durationMs": duration_ms(started) }),
        );
    }
    let init_response = match wait_for_jsonrpc_sse_response(&mut stream).await {
        Ok(response) => response,
        Err(error) => {
            return diagnostic_error(
                "protocol_error",
                format!("initialize response: {error}"),
                json!({ "transport": "sse", "stage": "initialize_response", "durationMs": duration_ms(started) }),
            );
        }
    };
    if let Some(error) = init_response.error {
        return rpc_error_diagnostic("initialize", &error, started);
    }

    let _ = sse_post(
        &client,
        &endpoint,
        headers.clone(),
        &initialized_notification(),
    )
    .await;
    if let Err(error) = sse_post(&client, &endpoint, headers, &tools_list_request(2)).await {
        return diagnostic_error(
            "protocol_error",
            format!("Failed to send tools/list: {error}"),
            json!({ "transport": "sse", "stage": "tools_list_send", "durationMs": duration_ms(started) }),
        );
    }
    let tools_response = match wait_for_jsonrpc_sse_response(&mut stream).await {
        Ok(response) => response,
        Err(error) => {
            return diagnostic_error(
                "protocol_error",
                format!("tools/list response: {error}"),
                json!({ "transport": "sse", "stage": "tools_list_response", "durationMs": duration_ms(started) }),
            );
        }
    };
    if let Some(error) = tools_response.error {
        return rpc_error_diagnostic("tools/list", &error, started);
    }
    success_diagnostic(server_name, tools_response.result, started)
}

async fn run_stdio_protocol(
    server_name: &str,
    mut stdin: ChildStdin,
    stdout: ChildStdout,
    started: Instant,
) -> Value {
    let mut reader = BufReader::new(stdout);
    if let Err(error) = write_jsonrpc_line(&mut stdin, &initialize_request(1)).await {
        return diagnostic_error(
            "protocol_error",
            format!("Failed to send initialize: {error}"),
            json!({ "transport": "stdio", "stage": "initialize_send", "durationMs": duration_ms(started) }),
        );
    }
    let init_response = match read_jsonrpc_response(&mut reader).await {
        Ok(response) => response,
        Err(error) => {
            return diagnostic_error(
                "protocol_error",
                format!("initialize response: {error}"),
                json!({ "transport": "stdio", "stage": "initialize_response", "durationMs": duration_ms(started) }),
            );
        }
    };
    if let Some(error) = init_response.error {
        return rpc_error_diagnostic("initialize", &error, started);
    }

    if let Err(error) = write_jsonrpc_line(&mut stdin, &initialized_notification()).await {
        return diagnostic_error(
            "protocol_error",
            format!("Failed to send initialized: {error}"),
            json!({ "transport": "stdio", "stage": "initialized_send", "durationMs": duration_ms(started) }),
        );
    }
    if let Err(error) = write_jsonrpc_line(&mut stdin, &tools_list_request(2)).await {
        return diagnostic_error(
            "protocol_error",
            format!("Failed to send tools/list: {error}"),
            json!({ "transport": "stdio", "stage": "tools_list_send", "durationMs": duration_ms(started) }),
        );
    }
    let tools_response = match read_jsonrpc_response(&mut reader).await {
        Ok(response) => response,
        Err(error) => {
            return diagnostic_error(
                "protocol_error",
                format!("tools/list response: {error}"),
                json!({ "transport": "stdio", "stage": "tools_list_response", "durationMs": duration_ms(started) }),
            );
        }
    };
    if let Some(error) = tools_response.error {
        return rpc_error_diagnostic("tools/list", &error, started);
    }

    success_diagnostic(server_name, tools_response.result, started)
}

async fn write_jsonrpc_line<T: Serialize>(
    stdin: &mut ChildStdin,
    message: &T,
) -> std::io::Result<()> {
    let body = serde_json::to_string(message).map_err(std::io::Error::other)?;
    stdin.write_all(body.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

async fn read_jsonrpc_response(
    reader: &mut BufReader<ChildStdout>,
) -> Result<JsonRpcResponse, String> {
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .await
            .map_err(|error| format!("I/O error: {error}"))?;
        if bytes == 0 {
            return Err("Server closed stdout before responding".to_string());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(response) = serde_json::from_str::<JsonRpcResponse>(trimmed)
            && response.id.is_some()
        {
            return Ok(response);
        }
    }
}

async fn post_jsonrpc(
    client: &reqwest::Client,
    url: &str,
    headers: reqwest::header::HeaderMap,
    body: &Value,
    transport: &str,
    started: Instant,
) -> Result<HttpMcpResponse, Value> {
    let response = client
        .post(url)
        .headers(headers)
        .json(body)
        .send()
        .await
        .map_err(|error| request_error_diagnostic(transport, error, started))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(auth_diagnostic(response.headers(), started));
    }
    if !response.status().is_success() {
        return Err(diagnostic_error(
            "http_error",
            format!("HTTP {} from MCP server", response.status().as_u16()),
            json!({ "transport": transport, "httpStatus": response.status().as_u16(), "durationMs": duration_ms(started) }),
        ));
    }
    let session_id = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let is_sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|content_type| content_type.contains("text/event-stream"));
    let text = response.text().await.map_err(|error| {
        diagnostic_error(
            "protocol_error",
            format!("Failed to read MCP response: {error}"),
            json!({ "transport": transport, "durationMs": duration_ms(started) }),
        )
    })?;
    let rpc = if is_sse {
        extract_jsonrpc_from_sse_text(&text)
    } else {
        serde_json::from_str::<JsonRpcResponse>(&text)
            .map_err(|error| format!("Invalid JSON-RPC response: {error}"))
    }
    .map_err(|error| {
        diagnostic_error(
            "protocol_error",
            error,
            json!({ "transport": transport, "durationMs": duration_ms(started) }),
        )
    })?;
    Ok(HttpMcpResponse { rpc, session_id })
}

async fn wait_for_sse_event(
    response: &mut reqwest::Response,
    event_type: &str,
) -> Result<SseEvent, String> {
    let mut buffer = String::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let text = String::from_utf8_lossy(&chunk).replace("\r\n", "\n");
                buffer.push_str(&text);
                while let Some(event) = parse_next_sse_event(&mut buffer) {
                    if event.event_type == event_type {
                        return Ok(event);
                    }
                }
            }
            Ok(None) => return Err(format!("SSE stream closed before {event_type} event")),
            Err(error) => return Err(format!("SSE stream error: {error}")),
        }
    }
}

async fn wait_for_jsonrpc_sse_response(
    response: &mut reqwest::Response,
) -> Result<JsonRpcResponse, String> {
    let mut buffer = String::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let text = String::from_utf8_lossy(&chunk).replace("\r\n", "\n");
                buffer.push_str(&text);
                while let Some(event) = parse_next_sse_event(&mut buffer) {
                    if event.event_type != "message" {
                        continue;
                    }
                    let response = serde_json::from_str::<JsonRpcResponse>(&event.data)
                        .map_err(|error| format!("Invalid JSON-RPC SSE event: {error}"))?;
                    if response.id.is_some() {
                        return Ok(response);
                    }
                }
            }
            Ok(None) => return Err("SSE stream closed before JSON-RPC response".to_string()),
            Err(error) => return Err(format!("SSE stream error: {error}")),
        }
    }
}

async fn sse_post<T: Serialize>(
    client: &reqwest::Client,
    endpoint: &str,
    headers: reqwest::header::HeaderMap,
    body: &T,
) -> Result<(), String> {
    client
        .post(endpoint)
        .headers(headers)
        .json(body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn parse_next_sse_event(buffer: &mut String) -> Option<SseEvent> {
    let end = buffer.find("\n\n")?;
    let event_text: String = buffer.drain(..end + 2).collect();
    let mut event_type = String::new();
    let mut data_parts = Vec::new();
    for line in event_text.lines() {
        if let Some(rest) = line.strip_prefix("event:") {
            event_type = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_parts.push(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    Some(SseEvent {
        event_type,
        data: data_parts.join("\n"),
    })
}

fn extract_jsonrpc_from_sse_text(body: &str) -> Result<JsonRpcResponse, String> {
    for line in body.lines() {
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.strip_prefix(' ').unwrap_or(data);
            if let Ok(response) = serde_json::from_str::<JsonRpcResponse>(data)
                && response.id.is_some()
            {
                return Ok(response);
            }
        }
    }
    Err("No JSON-RPC response found in SSE response".to_string())
}

fn resolve_endpoint_url(base_url: &str, endpoint: &str) -> Result<String, String> {
    let base =
        reqwest::Url::parse(base_url).map_err(|error| format!("Invalid base URL: {error}"))?;
    base.join(endpoint)
        .map(|url| url.to_string())
        .map_err(|error| format!("Invalid endpoint URL: {error}"))
}

fn http_headers(transport: &Value) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    for (key, value) in string_map(transport.get("headers")) {
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(key.as_bytes()),
            reqwest::header::HeaderValue::from_str(&value),
        ) {
            headers.insert(name, value);
        }
    }
    if !headers.contains_key(reqwest::header::AUTHORIZATION)
        && let Some(env_var) = transport
            .get("bearerTokenEnvVar")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        && let Ok(token) = std::env::var(env_var)
        && !token.trim().is_empty()
        && let Ok(value) =
            reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token.trim()))
    {
        headers.insert(reqwest::header::AUTHORIZATION, value);
    }
    headers
}

fn success_diagnostic(server_name: &str, tools_value: Option<Value>, started: Instant) -> Value {
    let tools = tool_manifest_for(server_name, tools_value);
    json!({
        "ok": true,
        "success": true,
        "status": "connected",
        "code": "ok",
        "message": "MCP server connection verified by Mia Rust Core.",
        "error": "",
        "details": { "durationMs": duration_ms(started) },
        "tools": tools,
        "auth": { "needsAuth": false, "method": "", "serverUrl": "" }
    })
}

fn diagnostic_error(code: &str, message: impl Into<String>, details: Value) -> Value {
    let message = sanitize_secret_text(&message.into());
    json!({
        "ok": false,
        "success": false,
        "status": if code == "auth_required" { "auth_required" } else { "disconnected" },
        "code": code,
        "message": message,
        "error": message,
        "details": details,
        "tools": [],
        "auth": { "needsAuth": code == "auth_required", "method": if code == "auth_required" { "oauth" } else { "" }, "serverUrl": "" }
    })
}

fn request_error_diagnostic(transport: &str, error: reqwest::Error, started: Instant) -> Value {
    let code = if error.is_timeout() {
        "timeout"
    } else {
        "connection_failed"
    };
    diagnostic_error(
        code,
        format!("MCP connection failed: {error}"),
        json!({ "transport": transport, "durationMs": duration_ms(started) }),
    )
}

fn spawn_error_diagnostic(command: &str, error: &std::io::Error, started: Instant) -> Value {
    match error.kind() {
        std::io::ErrorKind::NotFound => diagnostic_error(
            "command_not_found",
            command_not_found_message(command),
            json!({ "command": command, "durationMs": duration_ms(started) }),
        ),
        std::io::ErrorKind::PermissionDenied => diagnostic_error(
            "permission_denied",
            format!("Permission denied: {command}"),
            json!({ "command": command, "durationMs": duration_ms(started) }),
        ),
        _ => diagnostic_error(
            "connection_failed",
            format!("Failed to start '{command}': {error}"),
            json!({ "command": command, "durationMs": duration_ms(started) }),
        ),
    }
}

fn timeout_diagnostic(timeout_duration: Duration, started: Instant) -> Value {
    diagnostic_error(
        "timeout",
        format!(
            "Timed out after {}ms",
            u64::try_from(timeout_duration.as_millis()).unwrap_or(u64::MAX)
        ),
        json!({ "timeoutMs": timeout_duration.as_millis(), "durationMs": duration_ms(started) }),
    )
}

fn rpc_error_diagnostic(method: &str, error: &JsonRpcError, started: Instant) -> Value {
    diagnostic_error(
        "protocol_error",
        format!("{method} error: {} (code {})", error.message, error.code),
        json!({ "method": method, "rpcCode": error.code, "durationMs": duration_ms(started) }),
    )
}

fn auth_diagnostic(headers: &reqwest::header::HeaderMap, started: Instant) -> Value {
    let www_authenticate = headers
        .get(reqwest::header::WWW_AUTHENTICATE)
        .and_then(|value| value.to_str().ok())
        .map(sanitize_authenticate_header)
        .unwrap_or_default();
    diagnostic_error(
        "auth_required",
        "MCP server requires authentication.",
        json!({ "httpStatus": 401, "wwwAuthenticate": www_authenticate, "durationMs": duration_ms(started) }),
    )
}

fn tool_manifest_for(server_name: &str, tools_value: Option<Value>) -> Vec<Value> {
    tools_value
        .and_then(|value| serde_json::from_value::<ToolsListResult>(value).ok())
        .map(|result| {
            result
                .tools
                .into_iter()
                .filter(|tool| !tool.name.trim().is_empty())
                .map(|tool| {
                    json!({
                        "server": server_name,
                        "name": tool.name.trim(),
                        "description": tool.description.unwrap_or_default(),
                        "inputSchema": tool.input_schema.unwrap_or_else(|| json!({}))
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn initialize_request(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": CLIENT_NAME,
                "version": CLIENT_VERSION
            }
        }
    })
}

fn initialized_notification() -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    })
}

fn tools_list_request(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/list"
    })
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

fn string_map(value: Option<&Value>) -> HashMap<String, String> {
    value
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
        .collect()
}

fn command_not_found_message(command: &str) -> String {
    let runtime = match command_basename(command).as_str() {
        "npx" | "npm" | "node" | "pnpx" => "Node",
        "bun" | "bunx" => "Bun",
        "uv" | "uvx" => "uv",
        "python" | "python3" => "Python",
        "deno" => "Deno",
        _ => "the command",
    };
    format!(
        "Command not found: {command}. Install {runtime} or configure this MCP server with an absolute command path."
    )
}

fn command_basename(command: &str) -> String {
    let mut name = command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .to_ascii_lowercase();
    for suffix in [".exe", ".cmd", ".bat"] {
        if let Some(stripped) = name.strip_suffix(suffix) {
            name = stripped.to_string();
            break;
        }
    }
    name
}

fn sanitize_secret_text(value: &str) -> String {
    crate::clean_text(&value.replace(['\n', '\r', '\t'], " "))
}

fn sanitize_authenticate_header(value: &str) -> String {
    let mut redacted = Vec::new();
    for part in value.split(',') {
        let trimmed = part.trim();
        if trimmed.to_ascii_lowercase().contains("token=")
            || trimmed.to_ascii_lowercase().contains("password=")
            || trimmed.to_ascii_lowercase().contains("secret=")
        {
            redacted.push("[redacted]");
        } else {
            redacted.push(trimmed);
        }
    }
    redacted.join(", ")
}

fn duration_ms(started: Instant) -> u128 {
    started.elapsed().as_millis()
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    id: Option<Value>,
    result: Option<Value>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

#[derive(Debug, Deserialize)]
struct ToolsListResult {
    tools: Vec<McpToolInfo>,
}

#[derive(Debug, Deserialize)]
struct McpToolInfo {
    name: String,
    description: Option<String>,
    #[serde(rename = "inputSchema")]
    input_schema: Option<Value>,
}

struct HttpMcpResponse {
    rpc: JsonRpcResponse,
    session_id: Option<String>,
}

struct SseEvent {
    event_type: String,
    data: String,
}
