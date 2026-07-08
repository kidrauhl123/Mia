use std::collections::BTreeMap;
use std::io;
use std::sync::Arc;

use async_stream::stream;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router, serve};
use futures_util::StreamExt;
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use uuid::Uuid;

const BIND_HOST: &str = "127.0.0.1";

#[derive(Debug, Clone)]
pub struct ClaudeCodeMiaProxyConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Debug)]
pub struct RunningClaudeCodeMiaProxy {
    pub base_url: String,
    pub auth_token: String,
    task: JoinHandle<()>,
}

impl Drop for RunningClaudeCodeMiaProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Debug)]
struct ProxySession {
    upstream_base_url: String,
    upstream_api_key: String,
    model: String,
    auth_token: String,
}

#[derive(Debug, Clone)]
struct ProxyState {
    session: Arc<ProxySession>,
    client: reqwest::Client,
}

pub async fn start_claude_code_mia_proxy(
    config: ClaudeCodeMiaProxyConfig,
) -> anyhow::Result<RunningClaudeCodeMiaProxy> {
    let upstream_base_url = trim_trailing_slash(&config.base_url);
    let upstream_api_key = config.api_key.trim().to_string();
    let model = config.model.trim().to_string();
    if upstream_base_url.is_empty() || upstream_api_key.is_empty() || model.is_empty() {
        anyhow::bail!("Mia Claude proxy requires baseUrl, apiKey, and model.");
    }
    let auth_token = format!("mia_claude_{}", Uuid::now_v7().simple());
    let state = ProxyState {
        session: Arc::new(ProxySession {
            upstream_base_url,
            upstream_api_key,
            model,
            auth_token: auth_token.clone(),
        }),
        client: reqwest::Client::new(),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/health", get(health))
        .route("/v1/models", get(models))
        .route("/v1/messages/count_tokens", post(count_tokens))
        .route("/v1/messages", post(messages))
        .with_state(Arc::new(state));
    let listener = TcpListener::bind((BIND_HOST, 0)).await?;
    let port = listener.local_addr()?.port();
    let task = tokio::spawn(async move {
        let _ = serve(listener, app).await;
    });
    Ok(RunningClaudeCodeMiaProxy {
        base_url: format!("http://{BIND_HOST}:{port}"),
        auth_token,
        task,
    })
}

async fn health() -> Response {
    json_response(StatusCode::OK, json!({ "ok": true }))
}

async fn models(State(state): State<Arc<ProxyState>>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.session.auth_token) {
        return proxy_error(
            StatusCode::UNAUTHORIZED,
            "Mia Claude proxy token is missing or expired.",
        );
    }
    json_response(
        StatusCode::OK,
        json!({
            "object": "list",
            "data": [{
                "id": state.session.model,
                "object": "model",
                "owned_by": "mia"
            }]
        }),
    )
}

async fn count_tokens(
    State(state): State<Arc<ProxyState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.session.auth_token) {
        return proxy_error(
            StatusCode::UNAUTHORIZED,
            "Mia Claude proxy token is missing or expired.",
        );
    }
    json_response(
        StatusCode::OK,
        json!({ "input_tokens": rough_token_count(&body) }),
    )
}

async fn messages(
    State(state): State<Arc<ProxyState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.session.auth_token) {
        return proxy_error(
            StatusCode::UNAUTHORIZED,
            "Mia Claude proxy token is missing or expired.",
        );
    }
    let upstream_body = anthropic_to_openai_chat_body(&body, &state.session.model);
    let upstream = state
        .client
        .post(format!(
            "{}/chat/completions",
            state.session.upstream_base_url
        ))
        .bearer_auth(&state.session.upstream_api_key)
        .json(&upstream_body)
        .send()
        .await;
    let upstream = match upstream {
        Ok(response) => response,
        Err(error) => return proxy_error(StatusCode::BAD_GATEWAY, &error.to_string()),
    };
    if body.get("stream").and_then(Value::as_bool).unwrap_or(false) {
        return openai_stream_as_anthropic(upstream, request_model(&body, &state.session.model))
            .await;
    }
    let status = upstream.status();
    let payload = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => return proxy_error(StatusCode::BAD_GATEWAY, &error.to_string()),
    };
    let parsed = serde_json::from_slice::<Value>(&payload).unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let message = error_message(&parsed)
            .unwrap_or_else(|| format!("Upstream request failed ({}).", status.as_u16()));
        return proxy_error(status_code(status), &message);
    }
    json_response(
        StatusCode::OK,
        convert_openai_message_to_anthropic(&parsed, &body, &state.session.model),
    )
}

async fn openai_stream_as_anthropic(upstream: reqwest::Response, model: String) -> Response {
    let status = upstream.status();
    if !status.is_success() {
        let text = upstream.text().await.unwrap_or_default();
        return sse_response(
            status_code(status),
            sse_frame(
                "error",
                json!({
                    "type": "error",
                    "error": {
                        "type": "upstream_error",
                        "message": if text.trim().is_empty() {
                            format!("Upstream request failed ({}).", status.as_u16())
                        } else {
                            text
                        }
                    }
                }),
            ),
        );
    }

    let message_id = format!("msg_{}", Uuid::now_v7().simple());
    let mut upstream_stream = upstream.bytes_stream();
    let stream = stream! {
        yield Ok::<Bytes, io::Error>(Bytes::from(sse_frame(
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": message_id,
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": [],
                    "stop_reason": null,
                    "stop_sequence": null,
                    "usage": { "input_tokens": 0, "output_tokens": 0 }
                }
            }),
        )));
        let mut buffer = String::new();
        let mut text_block_started = false;
        let mut text_block_stopped = false;
        let mut output_tokens: i64 = 0;
        let mut finish_reason = "end_turn".to_string();
        let mut tool_calls: BTreeMap<i64, ToolCallDelta> = BTreeMap::new();

        while let Some(chunk) = upstream_stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    yield Err(io::Error::other(error));
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(frame) = take_sse_frame(&mut buffer) {
                for data in parse_sse_data_lines(&frame) {
                    for frame in consume_openai_stream_data(
                        &data,
                        &mut text_block_started,
                        &mut output_tokens,
                        &mut finish_reason,
                        &mut tool_calls,
                    ) {
                        yield Ok(Bytes::from(frame));
                    }
                }
            }
        }
        if !buffer.is_empty() {
            for data in parse_sse_data_lines(&buffer) {
                for frame in consume_openai_stream_data(
                    &data,
                    &mut text_block_started,
                    &mut output_tokens,
                    &mut finish_reason,
                    &mut tool_calls,
                ) {
                    yield Ok(Bytes::from(frame));
                }
            }
        }

        if text_block_started && !text_block_stopped {
            text_block_stopped = true;
            yield Ok(Bytes::from(sse_frame(
                "content_block_stop",
                json!({ "type": "content_block_stop", "index": 0 }),
            )));
        }
        let start_index = if text_block_started { 1 } else { 0 };
        for (index, call) in (start_index..).zip(tool_calls.values()) {
            yield Ok(Bytes::from(sse_frame(
                "content_block_start",
                json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": {
                        "type": "tool_use",
                        "id": if call.id.is_empty() {
                            format!("toolu_{}", Uuid::now_v7().simple())
                        } else {
                            call.id.clone()
                        },
                        "name": if call.name.is_empty() { "tool" } else { call.name.as_str() },
                        "input": {}
                    }
                }),
            )));
            yield Ok(Bytes::from(sse_frame(
                "content_block_delta",
                json!({
                    "type": "content_block_delta",
                    "index": index,
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": canonical_tool_input_json(&call.arguments)
                    }
                }),
            )));
            yield Ok(Bytes::from(sse_frame(
                "content_block_stop",
                json!({ "type": "content_block_stop", "index": index }),
            )));
        }
        yield Ok(Bytes::from(sse_frame(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": { "stop_reason": finish_reason, "stop_sequence": null },
                "usage": { "output_tokens": output_tokens }
            }),
        )));
        yield Ok(Bytes::from("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
        let _ = text_block_stopped;
    };
    let mut response = Body::from_stream(stream).into_response();
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn consume_openai_stream_data(
    data: &str,
    text_block_started: &mut bool,
    output_tokens: &mut i64,
    finish_reason: &mut String,
    tool_calls: &mut BTreeMap<i64, ToolCallDelta>,
) -> Vec<String> {
    if data.trim().is_empty() || data.trim() == "[DONE]" {
        return Vec::new();
    }
    let Ok(parsed) = serde_json::from_str::<Value>(data) else {
        return Vec::new();
    };
    if let Some(usage) = parsed.get("usage") {
        *output_tokens = usage_tokens(usage).1;
    }
    let Some(choice) = parsed
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
    else {
        return Vec::new();
    };
    let delta = choice.get("delta").unwrap_or(&Value::Null);
    let mut frames = Vec::new();
    if let Some(text) = delta.get("content").and_then(Value::as_str)
        && !text.is_empty()
    {
        if !*text_block_started {
            *text_block_started = true;
            frames.push(sse_frame(
                "content_block_start",
                json!({
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": { "type": "text", "text": "" }
                }),
            ));
        }
        frames.push(sse_frame(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": text }
            }),
        ));
    }
    for call in delta
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        append_tool_call_delta(tool_calls, call);
    }
    if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
        *finish_reason = map_finish_reason(reason).to_string();
    }
    frames
}

#[derive(Debug, Clone, Default)]
struct ToolCallDelta {
    id: String,
    name: String,
    arguments: String,
}

fn append_tool_call_delta(tool_calls: &mut BTreeMap<i64, ToolCallDelta>, value: &Value) {
    let index = value
        .get("index")
        .and_then(Value::as_i64)
        .unwrap_or(tool_calls.len() as i64);
    let current = tool_calls.entry(index).or_default();
    if let Some(id) = value.get("id").and_then(Value::as_str)
        && !id.is_empty()
    {
        current.id = id.to_string();
    }
    if let Some(function) = value.get("function") {
        if let Some(name) = function.get("name").and_then(Value::as_str)
            && !name.is_empty()
        {
            current.name = name.to_string();
        }
        if let Some(arguments) = function.get("arguments").and_then(Value::as_str)
            && !arguments.is_empty()
        {
            current.arguments.push_str(arguments);
        }
    }
}

fn anthropic_to_openai_chat_body(body: &Value, model: &str) -> Value {
    let mut out = Map::new();
    out.insert("model".into(), json!(model));
    out.insert(
        "messages".into(),
        Value::Array(convert_anthropic_messages(
            body.get("messages").and_then(Value::as_array),
            body.get("system"),
        )),
    );
    out.insert(
        "stream".into(),
        json!(body.get("stream").and_then(Value::as_bool).unwrap_or(false)),
    );
    copy_key(body, &mut out, "max_tokens", "max_tokens");
    copy_key(body, &mut out, "temperature", "temperature");
    copy_key(body, &mut out, "top_p", "top_p");
    copy_key(body, &mut out, "stop_sequences", "stop");
    if let Some(tools) = convert_tools(body.get("tools").and_then(Value::as_array)) {
        out.insert("tools".into(), tools);
    }
    if let Some(choice) =
        convert_tool_choice(body.get("tool_choice"), anthropic_thinking_enabled(body))
    {
        out.insert("tool_choice".into(), choice);
    }
    if out.get("stream").and_then(Value::as_bool).unwrap_or(false) {
        let mut stream_options = object_from_value(body.get("stream_options").cloned());
        stream_options.insert("include_usage".into(), json!(true));
        out.insert("stream_options".into(), Value::Object(stream_options));
    }
    Value::Object(out)
}

fn convert_anthropic_messages(messages: Option<&Vec<Value>>, system: Option<&Value>) -> Vec<Value> {
    let mut out = Vec::new();
    add_system_messages(&mut out, system);
    for message in messages.into_iter().flatten() {
        let role = if message.get("role").and_then(Value::as_str) == Some("assistant") {
            "assistant"
        } else {
            "user"
        };
        let content = message.get("content").unwrap_or(&Value::Null);
        if role == "assistant" && content.as_array().is_some() {
            let mut text_parts = Vec::new();
            let mut tool_calls = Vec::new();
            for block in content.as_array().into_iter().flatten() {
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    let id = string_field(block, &["id"])
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| format!("tool_{}", tool_calls.len()));
                    tool_calls.push(json!({
                        "id": id,
                        "type": "function",
                        "function": {
                            "name": string_field(block, &["name"]).unwrap_or_else(|| "tool".into()),
                            "arguments": normalize_json_value(block.get("input")).to_string()
                        }
                    }));
                } else {
                    let text = block_text(block);
                    if !text.is_empty() {
                        text_parts.push(text);
                    }
                }
            }
            let mut item = Map::new();
            item.insert("role".into(), json!("assistant"));
            item.insert(
                "content".into(),
                if text_parts.is_empty() {
                    Value::Null
                } else {
                    Value::String(text_parts.join("\n"))
                },
            );
            if !tool_calls.is_empty() {
                item.insert("tool_calls".into(), Value::Array(tool_calls));
            }
            out.push(Value::Object(item));
            continue;
        }
        if role == "user" && content.as_array().is_some() {
            let mut text_parts = Vec::new();
            for block in content.as_array().into_iter().flatten() {
                if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                    if !text_parts.is_empty() {
                        out.push(json!({ "role": "user", "content": text_parts.join("\n") }));
                        text_parts.clear();
                    }
                    out.push(json!({
                        "role": "tool",
                        "tool_call_id": string_field(block, &["tool_use_id"]).unwrap_or_default(),
                        "content": content_text(block.get("content").unwrap_or(&Value::Null))
                    }));
                    continue;
                }
                let text = block_text(block);
                if !text.is_empty() {
                    text_parts.push(text);
                }
            }
            if !text_parts.is_empty() {
                out.push(json!({ "role": "user", "content": text_parts.join("\n") }));
            }
            continue;
        }
        out.push(json!({ "role": role, "content": content_text(content) }));
    }
    out
}

fn add_system_messages(out: &mut Vec<Value>, system: Option<&Value>) {
    let Some(system) = system else {
        return;
    };
    let text = match system {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(block_text).collect::<Vec<_>>().join("\n"),
        other => content_text(other),
    };
    if !text.trim().is_empty() {
        out.push(json!({ "role": "system", "content": text }));
    }
}

fn convert_tools(tools: Option<&Vec<Value>>) -> Option<Value> {
    let converted = tools?
        .iter()
        .filter_map(|tool| {
            let name = string_field(tool, &["name"])?;
            (!name.is_empty()).then(|| {
                json!({
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": string_field(tool, &["description"]).unwrap_or_default(),
                        "parameters": tool
                            .get("input_schema")
                            .or_else(|| tool.get("inputSchema"))
                            .or_else(|| tool.get("parameters"))
                            .cloned()
                            .unwrap_or_else(|| json!({ "type": "object", "properties": {} }))
                    }
                })
            })
        })
        .collect::<Vec<_>>();
    (!converted.is_empty()).then_some(Value::Array(converted))
}

fn convert_tool_choice(choice: Option<&Value>, thinking_enabled: bool) -> Option<Value> {
    match choice {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value == "auto" => Some(json!("auto")),
        Some(Value::String(value)) if value == "none" => Some(json!("none")),
        Some(Value::String(value)) if value == "any" => Some(json!("required")),
        Some(Value::Object(object))
            if object.get("type").and_then(Value::as_str) == Some("tool") =>
        {
            let name = object.get("name").and_then(Value::as_str)?;
            if thinking_enabled {
                Some(json!("auto"))
            } else {
                Some(json!({ "type": "function", "function": { "name": name } }))
            }
        }
        _ => None,
    }
}

fn convert_openai_message_to_anthropic(
    payload: &Value,
    request_body: &Value,
    model: &str,
) -> Value {
    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let message = choice.get("message").unwrap_or(&Value::Null);
    let mut content = Vec::new();
    let text = message
        .get("content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| content_text(message.get("content").unwrap_or(&Value::Null)));
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    for call in message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let function = call.get("function").unwrap_or(&Value::Null);
        content.push(json!({
            "type": "tool_use",
            "id": string_field(call, &["id"]).unwrap_or_else(|| format!("toolu_{}", Uuid::now_v7().simple())),
            "name": string_field(function, &["name"]).unwrap_or_else(|| "tool".into()),
            "input": normalize_json_value(function.get("arguments"))
        }));
    }
    json!({
        "id": anthropic_message_id(payload.get("id").and_then(Value::as_str).unwrap_or("")),
        "type": "message",
        "role": "assistant",
        "model": request_model(request_body, model),
        "content": content,
        "stop_reason": map_finish_reason(choice.get("finish_reason").and_then(Value::as_str).unwrap_or("")),
        "stop_sequence": null,
        "usage": {
            "input_tokens": usage_tokens(payload.get("usage").unwrap_or(&Value::Null)).0,
            "output_tokens": usage_tokens(payload.get("usage").unwrap_or(&Value::Null)).1
        }
    })
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    let token = token.trim();
    !token.is_empty()
        && request_token(headers)
            .as_deref()
            .is_some_and(|value| value == token)
}

fn request_token(headers: &HeaderMap) -> Option<String> {
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if authorization.to_ascii_lowercase().starts_with("bearer ") {
        return Some(authorization[7..].trim().to_string());
    }
    for key in ["x-api-key", "anthropic-api-key"] {
        if let Some(value) = headers
            .get(key)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }
    }
    None
}

fn proxy_error(status: StatusCode, message: &str) -> Response {
    json_response(
        status,
        json!({
            "type": "error",
            "error": {
                "type": "mia_proxy_error",
                "message": message
            }
        }),
    )
}

fn json_response(status: StatusCode, value: Value) -> Response {
    let mut response = (status, Json(value)).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn sse_response(status: StatusCode, body: String) -> Response {
    let mut response = (status, Body::from(body)).into_response();
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn sse_frame(event: &str, data: Value) -> String {
    format!("event: {event}\ndata: {}\n\n", data)
}

fn parse_sse_data_lines(text: &str) -> Vec<String> {
    text.split("\n\n")
        .flat_map(|frame| {
            let lines = frame
                .lines()
                .map(str::trim)
                .filter_map(|line| line.strip_prefix("data:").map(str::trim))
                .collect::<Vec<_>>();
            (!lines.is_empty()).then(|| lines.join("\n"))
        })
        .collect()
}

fn take_sse_frame(buffer: &mut String) -> Option<String> {
    let newline = buffer.find("\n\n").map(|index| (index, 2));
    let crlf = buffer.find("\r\n\r\n").map(|index| (index, 4));
    let (index, len) = match (newline, crlf) {
        (Some(left), Some(right)) => {
            if left.0 <= right.0 {
                left
            } else {
                right
            }
        }
        (Some(item), None) | (None, Some(item)) => item,
        (None, None) => return None,
    };
    let frame = buffer[..index].to_string();
    buffer.drain(..index + len);
    Some(frame)
}

fn copy_key(source: &Value, target: &mut Map<String, Value>, source_key: &str, target_key: &str) {
    if let Some(value) = source.get(source_key)
        && !value.is_null()
    {
        target.insert(target_key.into(), value.clone());
    }
}

fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(block_text).collect::<Vec<_>>().join("\n"),
        Value::Object(_) => block_text(content),
        _ => String::new(),
    }
}

fn block_text(block: &Value) -> String {
    match block {
        Value::String(text) => text.clone(),
        Value::Object(object) => match object.get("type").and_then(Value::as_str) {
            Some("text") => string_field(block, &["text"]).unwrap_or_default(),
            Some("thinking") => string_field(block, &["thinking", "text"]).unwrap_or_default(),
            Some("tool_result") => {
                let content = content_text(object.get("content").unwrap_or(&Value::Null));
                if content.is_empty() {
                    String::new()
                } else {
                    format!(
                        "Tool result ({}):\n{}",
                        object
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or("tool"),
                        content
                    )
                }
            }
            Some("image") => "[Image attachment]".into(),
            _ => string_field(block, &["text", "content"]).unwrap_or_default(),
        },
        Value::Array(items) => items.iter().map(block_text).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn string_field(source: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| source.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn object_from_value(value: Option<Value>) -> Map<String, Value> {
    value
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn normalize_json_value(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => {
            serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!({}))
        }
        Some(Value::Object(_)) | Some(Value::Array(_)) => {
            value.cloned().unwrap_or_else(|| json!({}))
        }
        _ => json!({}),
    }
}

fn anthropic_thinking_enabled(body: &Value) -> bool {
    let Some(thinking) = body.get("thinking").filter(|value| value.is_object()) else {
        return false;
    };
    let type_id = thinking
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    type_id != "disabled"
        && (type_id == "enabled"
            || thinking
                .get("budget_tokens")
                .or_else(|| thinking.get("budgetTokens"))
                .and_then(Value::as_i64)
                .unwrap_or(0)
                > 0)
}

fn map_finish_reason(reason: &str) -> &'static str {
    match reason {
        "length" => "max_tokens",
        "tool_calls" | "function_call" => "tool_use",
        "content_filter" => "stop",
        _ => "end_turn",
    }
}

fn usage_tokens(usage: &Value) -> (i64, i64) {
    (
        usage
            .get("prompt_tokens")
            .or_else(|| usage.get("input_tokens"))
            .and_then(Value::as_i64)
            .unwrap_or(0),
        usage
            .get("completion_tokens")
            .or_else(|| usage.get("output_tokens"))
            .and_then(Value::as_i64)
            .unwrap_or(0),
    )
}

fn request_model(request_body: &Value, fallback: &str) -> String {
    request_body
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn anthropic_message_id(source: &str) -> String {
    let id = source.trim();
    if id.starts_with("msg_") {
        id.to_string()
    } else {
        format!("msg_{}", Uuid::now_v7().simple())
    }
}

fn canonical_tool_input_json(value: &str) -> String {
    serde_json::from_str::<Value>(value)
        .unwrap_or_else(|_| json!({}))
        .to_string()
}

fn rough_token_count(body: &Value) -> i64 {
    let text = [
        content_text(body.get("system").unwrap_or(&Value::Null)),
        body.get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|message| content_text(message.get("content").unwrap_or(&Value::Null)))
            .collect::<Vec<_>>()
            .join("\n"),
    ]
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    ((text.chars().count() as f64 / 4.0).ceil() as i64).max(1)
}

fn error_message(value: &Value) -> Option<String> {
    value
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .or_else(|| value.get("message").and_then(Value::as_str))
        .map(str::to_string)
}

fn status_code(status: reqwest::StatusCode) -> StatusCode {
    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY)
}

fn trim_trailing_slash(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_to_openai_body_forces_mia_model() {
        let body = json!({
            "model": "claude-sonnet-4-5",
            "system": "system rules",
            "max_tokens": 64,
            "messages": [{ "role": "user", "content": [{ "type": "text", "text": "hello" }] }],
            "tools": [{ "name": "Bash", "description": "Run shell", "input_schema": { "type": "object" } }]
        });
        let converted = anthropic_to_openai_chat_body(&body, "mia-auto");
        assert_eq!(converted["model"], "mia-auto");
        assert_eq!(converted["messages"][0]["role"], "system");
        assert_eq!(converted["messages"][1]["content"], "hello");
        assert_eq!(converted["tools"][0]["function"]["name"], "Bash");
    }

    #[test]
    fn openai_message_response_becomes_anthropic_message() {
        let converted = convert_openai_message_to_anthropic(
            &json!({
                "id": "chatcmpl_1",
                "choices": [{ "message": { "content": "mia-ok" }, "finish_reason": "stop" }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 2 }
            }),
            &json!({ "model": "claude-sonnet-4-5" }),
            "mia-auto",
        );
        assert_eq!(converted["type"], "message");
        assert_eq!(converted["content"][0]["text"], "mia-ok");
        assert_eq!(converted["usage"]["input_tokens"], 3);
    }
}
