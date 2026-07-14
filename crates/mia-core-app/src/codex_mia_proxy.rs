use std::collections::{BTreeMap, BTreeSet};
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
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use uuid::Uuid;

const BIND_HOST: &str = "127.0.0.1";
const MAX_HISTORY_RESPONSES: usize = 128;

#[derive(Debug, Clone)]
pub struct CodexMiaProxyConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub auth_via_path: bool,
}

#[derive(Debug)]
pub struct RunningCodexMiaProxy {
    pub base_url: String,
    pub api_key: String,
    task: JoinHandle<()>,
}

impl Drop for RunningCodexMiaProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Debug, Default)]
struct ResponseHistory {
    response_calls: BTreeMap<String, BTreeMap<String, Value>>,
    response_order: Vec<String>,
    call_index: BTreeMap<String, Vec<Value>>,
}

#[derive(Debug)]
struct ProxySession {
    upstream_base_url: String,
    upstream_api_key: String,
    model: String,
    auth_token: String,
    require_header_auth: bool,
    history: Mutex<ResponseHistory>,
}

#[derive(Debug, Clone)]
struct ProxyState {
    session: Arc<ProxySession>,
    client: reqwest::Client,
}

pub async fn start_codex_mia_proxy(
    config: CodexMiaProxyConfig,
) -> anyhow::Result<RunningCodexMiaProxy> {
    let upstream_base_url = trim_trailing_slash(&config.base_url);
    let upstream_api_key = config.api_key.trim().to_string();
    let model = config.model.trim().to_string();
    if upstream_base_url.is_empty() || upstream_api_key.is_empty() || model.is_empty() {
        anyhow::bail!("Mia Codex proxy requires baseUrl, apiKey, and model.");
    }
    let auth_token = format!("mia_codex_{}", Uuid::now_v7().simple());
    let state = ProxyState {
        session: Arc::new(ProxySession {
            upstream_base_url,
            upstream_api_key,
            model,
            auth_token: auth_token.clone(),
            require_header_auth: !config.auth_via_path,
            history: Mutex::new(ResponseHistory::default()),
        }),
        client: reqwest::Client::new(),
    };
    let api = Router::new()
        .route("/health", get(health))
        .route("/v1/health", get(health))
        .route("/v1/models", get(models))
        .route("/v1/responses", post(responses))
        .route("/v1/responses/compact", post(responses))
        .route("/v1/chat/completions", post(chat_completions))
        .with_state(Arc::new(state));
    let app = if config.auth_via_path {
        Router::new().nest(&format!("/{auth_token}"), api)
    } else {
        api
    };
    let listener = TcpListener::bind((BIND_HOST, 0)).await?;
    let port = listener.local_addr()?.port();
    let task = tokio::spawn(async move {
        let _ = serve(listener, app).await;
    });
    let base_url = if config.auth_via_path {
        format!("http://{BIND_HOST}:{port}/{auth_token}/v1")
    } else {
        format!("http://{BIND_HOST}:{port}/v1")
    };
    Ok(RunningCodexMiaProxy {
        base_url,
        api_key: if config.auth_via_path {
            "no-key-required".into()
        } else {
            auth_token
        },
        task,
    })
}

async fn health() -> Response {
    json_response(StatusCode::OK, json!({ "ok": true }))
}

async fn models(State(state): State<Arc<ProxyState>>, headers: HeaderMap) -> Response {
    if !request_authorized(&headers, &state.session) {
        return proxy_error(
            StatusCode::UNAUTHORIZED,
            "Mia Codex proxy token is missing or expired.",
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

async fn responses(
    State(state): State<Arc<ProxyState>>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Response {
    if !request_authorized(&headers, &state.session) {
        return proxy_error(
            StatusCode::UNAUTHORIZED,
            "Mia Codex proxy token is missing or expired.",
        );
    }
    {
        let history = state.session.history.lock().await;
        enrich_request_with_history(&mut body, &history);
    }
    let upstream_body = responses_to_chat_completions(&body, &state.session.model);
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
    if upstream_body
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return chat_stream_as_responses(upstream, body, state.session.clone()).await;
    }
    let status = upstream.status();
    let payload = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => return proxy_error(StatusCode::BAD_GATEWAY, &error.to_string()),
    };
    let parsed = serde_json::from_slice::<Value>(&payload).unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let message = error_message(&parsed)
            .unwrap_or_else(|| String::from_utf8_lossy(&payload).trim().to_string())
            .trim()
            .to_string();
        return proxy_error(
            status_code(status),
            if message.is_empty() {
                "Upstream request failed."
            } else {
                &message
            },
        );
    }
    let response = chat_response_to_responses(&parsed, &state.session.model);
    {
        let mut history = state.session.history.lock().await;
        history.record_response(&response);
    }
    json_response(StatusCode::OK, response)
}

async fn chat_completions(
    State(state): State<Arc<ProxyState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !request_authorized(&headers, &state.session) {
        return proxy_error(
            StatusCode::UNAUTHORIZED,
            "Mia Codex proxy token is missing or expired.",
        );
    }
    let mut upstream_body = object_from_value(Some(body));
    upstream_body.insert("model".into(), json!(state.session.model));
    let upstream = state
        .client
        .post(format!(
            "{}/chat/completions",
            state.session.upstream_base_url
        ))
        .bearer_auth(&state.session.upstream_api_key)
        .json(&Value::Object(upstream_body))
        .send()
        .await;
    let upstream = match upstream {
        Ok(response) => response,
        Err(error) => return proxy_error(StatusCode::BAD_GATEWAY, &error.to_string()),
    };
    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json; charset=utf-8")
        .to_string();
    let payload = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => return proxy_error(StatusCode::BAD_GATEWAY, &error.to_string()),
    };
    let mut response = payload.into_response();
    *response.status_mut() = status_code(status);
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/json; charset=utf-8")),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn chat_stream_as_responses(
    upstream: reqwest::Response,
    request_body: Value,
    session: Arc<ProxySession>,
) -> Response {
    let status = upstream.status();
    if !status.is_success() {
        let text = upstream.text().await.unwrap_or_default();
        return stream_error_response(
            status_code(status),
            &session.model,
            if text.trim().is_empty() {
                format!("Upstream request failed ({}).", status.as_u16())
            } else {
                text
            },
        );
    }
    let model = session.model.clone();
    let mut upstream_stream = upstream.bytes_stream();
    let stream = stream! {
        let mut state = ResponseStreamState::new(&request_body, &model);
        let mut buffer = String::new();
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
                    for frame in state.consume_openai_stream_data(&data) {
                        yield Ok::<Bytes, io::Error>(Bytes::from(frame));
                    }
                }
            }
        }
        if !buffer.is_empty() {
            for data in parse_sse_data_lines(&buffer) {
                for frame in state.consume_openai_stream_data(&data) {
                    yield Ok(Bytes::from(frame));
                }
            }
        }
        let (frames, response) = state.finalize();
        for frame in frames {
            yield Ok(Bytes::from(frame));
        }
        {
            let mut history = session.history.lock().await;
            history.record_response(&response);
        }
    };
    let mut response = Body::from_stream(stream).into_response();
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Debug, Clone)]
struct ResponseStreamState {
    response_started: bool,
    completed: bool,
    response_id: String,
    model: String,
    created_at: i64,
    next_output_index: i64,
    text: StreamTextState,
    tools: BTreeMap<i64, StreamToolState>,
    output_items: Vec<(i64, Value)>,
    usage: Value,
    finish_reason: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct StreamTextState {
    added: bool,
    done: bool,
    output_index: i64,
    item_id: String,
    text: String,
}

#[derive(Debug, Clone, Default)]
struct StreamToolState {
    added: bool,
    done: bool,
    output_index: i64,
    item_id: String,
    call_id: String,
    namespace: Option<String>,
    name: String,
    arguments: String,
}

impl ResponseStreamState {
    fn new(request_body: &Value, model: &str) -> Self {
        Self {
            response_started: false,
            completed: false,
            response_id: random_id("resp"),
            model: request_body
                .get("model")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(model)
                .to_string(),
            created_at: now_seconds(),
            next_output_index: 0,
            text: StreamTextState::default(),
            tools: BTreeMap::new(),
            output_items: Vec::new(),
            usage: chat_usage_to_responses_usage(None),
            finish_reason: None,
        }
    }

    fn consume_openai_stream_data(&mut self, data: &str) -> Vec<String> {
        if data.trim().is_empty() || data.trim() == "[DONE]" {
            return Vec::new();
        }
        let Ok(parsed) = serde_json::from_str::<Value>(data) else {
            return Vec::new();
        };
        if let Some(id) = parsed.get("id").and_then(Value::as_str)
            && !id.trim().is_empty()
        {
            self.response_id = response_id_from_chat_id(id);
        }
        if let Some(model) = parsed.get("model").and_then(Value::as_str)
            && !model.trim().is_empty()
        {
            self.model = model.to_string();
        }
        if let Some(created) = parsed.get("created").and_then(Value::as_i64) {
            self.created_at = created;
        }
        if let Some(usage) = parsed.get("usage") {
            self.usage = chat_usage_to_responses_usage(Some(usage));
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
            frames.extend(self.push_text_delta(text));
        }
        for tool_call in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            frames.extend(self.push_tool_delta(tool_call));
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str)
            && !reason.trim().is_empty()
        {
            self.finish_reason = Some(reason.to_string());
        }
        frames
    }

    fn push_text_delta(&mut self, delta: &str) -> Vec<String> {
        let mut frames = self.ensure_response_started();
        if !self.text.added {
            let output_index = self.next_output_index();
            let item_id = format!("{}_msg", self.response_id);
            self.text = StreamTextState {
                added: true,
                done: false,
                output_index,
                item_id: item_id.clone(),
                text: String::new(),
            };
            frames.push(sse_frame(
                "response.output_item.added",
                json!({
                    "type": "response.output_item.added",
                    "output_index": output_index,
                    "item": {
                        "id": item_id,
                        "type": "message",
                        "status": "in_progress",
                        "role": "assistant",
                        "content": []
                    }
                }),
            ));
            frames.push(sse_frame(
                "response.content_part.added",
                json!({
                    "type": "response.content_part.added",
                    "item_id": self.text.item_id,
                    "output_index": output_index,
                    "content_index": 0,
                    "part": { "type": "output_text", "text": "", "annotations": [] }
                }),
            ));
        }
        self.text.text.push_str(delta);
        frames.push(sse_frame(
            "response.output_text.delta",
            json!({
                "type": "response.output_text.delta",
                "item_id": self.text.item_id,
                "output_index": self.text.output_index,
                "content_index": 0,
                "delta": delta
            }),
        ));
        frames
    }

    fn push_tool_delta(&mut self, tool_call: &Value) -> Vec<String> {
        let mut frames = self.ensure_response_started();
        let index = tool_call
            .get("index")
            .and_then(Value::as_i64)
            .unwrap_or(self.tools.len() as i64);
        let should_add = {
            let current = self.tools.entry(index).or_default();
            if let Some(id) = tool_call.get("id").and_then(Value::as_str)
                && !id.trim().is_empty()
            {
                current.call_id = id.to_string();
            }
            if let Some(function) = tool_call.get("function") {
                if let Some(name) = function.get("name").and_then(Value::as_str)
                    && !name.trim().is_empty()
                {
                    let tool = codex_tool_identity_from_chat_call(name);
                    current.namespace = tool.namespace;
                    current.name = tool.name;
                }
                if let Some(arguments) = function.get("arguments").and_then(Value::as_str)
                    && !arguments.is_empty()
                {
                    current.arguments.push_str(arguments);
                }
            }
            !current.added && (!current.call_id.is_empty() || !current.name.is_empty())
        };
        if should_add {
            let output_index = self.next_output_index();
            let current = self.tools.entry(index).or_default();
            current.added = true;
            if current.call_id.is_empty() {
                current.call_id = format!("call_{index}");
            }
            if current.name.is_empty() {
                current.name = "tool".to_string();
            }
            current.output_index = output_index;
            current.item_id = format!("fc_{}", sanitize_id(&current.call_id));
            let item = response_function_call_item(
                &current.item_id,
                "in_progress",
                &current.call_id,
                current.namespace.as_deref(),
                &current.name,
                "",
            );
            frames.push(sse_frame(
                "response.output_item.added",
                json!({
                    "type": "response.output_item.added",
                    "output_index": current.output_index,
                    "item": item
                }),
            ));
        }
        if let Some(current) = self.tools.get(&index)
            && current.added
        {
            let delta = tool_call
                .get("function")
                .and_then(|function| function.get("arguments"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !delta.is_empty() {
                frames.push(sse_frame(
                    "response.function_call_arguments.delta",
                    json!({
                        "type": "response.function_call_arguments.delta",
                        "item_id": current.item_id,
                        "output_index": current.output_index,
                        "delta": delta
                    }),
                ));
            }
        }
        frames
    }

    fn finalize(&mut self) -> (Vec<String>, Value) {
        let mut frames = Vec::new();
        if self.completed {
            return (
                frames,
                self.base_response("completed", Value::Array(Vec::new())),
            );
        }
        frames.extend(self.ensure_response_started());
        frames.extend(self.finalize_text());
        frames.extend(self.finalize_tools());
        let mut output_items = self.output_items.clone();
        output_items.sort_by_key(|(index, _)| *index);
        let output = output_items
            .into_iter()
            .map(|(_, item)| item)
            .collect::<Vec<_>>();
        let status = response_status_from_finish_reason(self.finish_reason.as_deref());
        let mut response = self.base_response(status, Value::Array(output.clone()));
        if self.finish_reason.as_deref() == Some("length")
            && let Some(object) = response.as_object_mut()
        {
            object.insert(
                "incomplete_details".into(),
                json!({ "reason": "max_output_tokens" }),
            );
        }
        if output.is_empty()
            && self.finish_reason.is_none()
            && let Some(object) = response.as_object_mut()
        {
            object.insert("status".into(), json!("failed"));
            object.insert(
                "error".into(),
                json!({ "message": "Upstream stream ended before producing output.", "code": "stream_truncated" }),
            );
        }
        frames.push(sse_frame(
            "response.completed",
            json!({ "type": "response.completed", "response": response }),
        ));
        self.completed = true;
        (frames, response)
    }

    fn finalize_text(&mut self) -> Vec<String> {
        if !self.text.added || self.text.done {
            return Vec::new();
        }
        let item = json!({
            "id": self.text.item_id,
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": self.text.text, "annotations": [] }]
        });
        self.output_items
            .push((self.text.output_index, item.clone()));
        self.text.done = true;
        vec![
            sse_frame(
                "response.output_text.done",
                json!({
                    "type": "response.output_text.done",
                    "item_id": self.text.item_id,
                    "output_index": self.text.output_index,
                    "content_index": 0,
                    "text": self.text.text
                }),
            ),
            sse_frame(
                "response.content_part.done",
                json!({
                    "type": "response.content_part.done",
                    "item_id": self.text.item_id,
                    "output_index": self.text.output_index,
                    "content_index": 0,
                    "part": { "type": "output_text", "text": self.text.text, "annotations": [] }
                }),
            ),
            sse_frame(
                "response.output_item.done",
                json!({
                    "type": "response.output_item.done",
                    "output_index": self.text.output_index,
                    "item": item
                }),
            ),
        ]
    }

    fn finalize_tools(&mut self) -> Vec<String> {
        let mut frames = Vec::new();
        let keys = self.tools.keys().copied().collect::<Vec<_>>();
        for index in keys {
            let add_missing = self.tools.get(&index).is_some_and(|current| !current.added);
            if add_missing {
                let output_index = self.next_output_index();
                let current = self.tools.entry(index).or_default();
                current.added = true;
                if current.call_id.is_empty() {
                    current.call_id = format!("call_{index}");
                }
                if current.name.is_empty() {
                    current.name = "tool".to_string();
                }
                current.output_index = output_index;
                current.item_id = format!("fc_{}", sanitize_id(&current.call_id));
                let item = response_function_call_item(
                    &current.item_id,
                    "in_progress",
                    &current.call_id,
                    current.namespace.as_deref(),
                    &current.name,
                    "",
                );
                frames.push(sse_frame(
                    "response.output_item.added",
                    json!({
                        "type": "response.output_item.added",
                        "output_index": current.output_index,
                        "item": item
                    }),
                ));
            }
            let Some(current) = self.tools.get_mut(&index) else {
                continue;
            };
            if current.done {
                continue;
            }
            let arguments = canonical_json_string_from_str(&current.arguments);
            let item = response_function_call_item(
                &current.item_id,
                "completed",
                &current.call_id,
                current.namespace.as_deref(),
                &current.name,
                &arguments,
            );
            self.output_items.push((current.output_index, item.clone()));
            current.done = true;
            frames.push(sse_frame(
                "response.function_call_arguments.done",
                json!({
                    "type": "response.function_call_arguments.done",
                    "item_id": current.item_id,
                    "output_index": current.output_index,
                    "arguments": arguments
                }),
            ));
            frames.push(sse_frame(
                "response.output_item.done",
                json!({
                    "type": "response.output_item.done",
                    "output_index": current.output_index,
                    "item": item
                }),
            ));
        }
        frames
    }

    fn ensure_response_started(&mut self) -> Vec<String> {
        if self.response_started {
            return Vec::new();
        }
        self.response_started = true;
        let response = self.base_response("in_progress", Value::Array(Vec::new()));
        vec![
            sse_frame(
                "response.created",
                json!({ "type": "response.created", "response": response }),
            ),
            sse_frame(
                "response.in_progress",
                json!({ "type": "response.in_progress", "response": response }),
            ),
        ]
    }

    fn next_output_index(&mut self) -> i64 {
        let index = self.next_output_index;
        self.next_output_index += 1;
        index
    }

    fn base_response(&self, status: &str, output: Value) -> Value {
        json!({
            "id": self.response_id,
            "object": "response",
            "created_at": self.created_at,
            "status": status,
            "model": self.model,
            "output": output,
            "usage": self.usage
        })
    }
}

impl ResponseHistory {
    fn record_response(&mut self, response: &Value) {
        let Some(response_id) = response.get("id").and_then(Value::as_str) else {
            return;
        };
        if response_id.trim().is_empty() {
            return;
        }
        let mut calls = BTreeMap::new();
        for item in response
            .get("output")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if !is_tool_call_type(item.get("type").and_then(Value::as_str).unwrap_or("")) {
                continue;
            }
            let call_id = response_item_call_id(item);
            if call_id.is_empty() {
                continue;
            }
            calls.insert(call_id.clone(), item.clone());
            let indexed = self.call_index.entry(call_id).or_default();
            indexed.push(item.clone());
            if indexed.len() > 4 {
                indexed.remove(0);
            }
        }
        if calls.is_empty() {
            return;
        }
        self.response_calls.insert(response_id.to_string(), calls);
        self.response_order.push(response_id.to_string());
        while self.response_order.len() > MAX_HISTORY_RESPONSES {
            if let Some(evicted) = self.response_order.first().cloned() {
                self.response_order.remove(0);
                self.response_calls.remove(&evicted);
            }
        }
    }

    fn lookup_cached_tool_call(&self, previous_response_id: &str, call_id: &str) -> Option<Value> {
        if !previous_response_id.trim().is_empty()
            && let Some(calls) = self.response_calls.get(previous_response_id)
            && let Some(item) = calls.get(call_id)
        {
            return Some(item.clone());
        }
        let indexed = self.call_index.get(call_id)?;
        (indexed.len() == 1).then(|| indexed[0].clone())
    }
}

fn enrich_request_with_history(body: &mut Value, history: &ResponseHistory) -> usize {
    let previous_response_id = body
        .get("previous_response_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let input = body.get_mut("input");
    let Some(input) = input else {
        return 0;
    };
    if !(input.is_array() || input.is_object()) {
        return 0;
    }
    let items = if let Some(items) = input.as_array() {
        items.clone()
    } else {
        vec![input.clone()]
    };
    let existing_call_ids = items
        .iter()
        .filter(|item| is_tool_call_type(item.get("type").and_then(Value::as_str).unwrap_or("")))
        .map(response_item_call_id)
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>();
    let mut restored = Vec::new();
    let mut restored_ids = BTreeSet::new();
    for item in items {
        if is_tool_output_type(item.get("type").and_then(Value::as_str).unwrap_or("")) {
            let call_id = response_item_call_id(&item);
            if !call_id.is_empty()
                && !existing_call_ids.contains(&call_id)
                && !restored_ids.contains(&call_id)
                && let Some(cached) =
                    history.lookup_cached_tool_call(&previous_response_id, &call_id)
            {
                restored.push(cached);
                restored_ids.insert(call_id);
            }
        }
        restored.push(item);
    }
    let restored_count = restored_ids.len();
    if input.is_array() || restored.len() != 1 {
        *input = Value::Array(restored);
    } else if let Some(item) = restored.into_iter().next() {
        *input = item;
    }
    restored_count
}

fn responses_to_chat_completions(body: &Value, model: &str) -> Value {
    let mut messages = Vec::new();
    let instructions = content_text(body.get("instructions").unwrap_or(&Value::Null));
    if !instructions.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": instructions }));
    }
    append_responses_input_as_chat_messages(body.get("input"), &mut messages);
    let mut out = Map::new();
    out.insert("model".into(), json!(model));
    out.insert(
        "messages".into(),
        Value::Array(collapse_system_messages(messages)),
    );
    out.insert(
        "stream".into(),
        json!(body.get("stream").and_then(Value::as_bool).unwrap_or(false)),
    );
    copy_key(body, &mut out, "max_output_tokens", "max_tokens");
    copy_key(body, &mut out, "max_tokens", "max_tokens");
    for key in [
        "temperature",
        "top_p",
        "presence_penalty",
        "frequency_penalty",
        "stop",
        "response_format",
        "seed",
        "user",
    ] {
        copy_key(body, &mut out, key, key);
    }
    if let Some(tools) = convert_response_tools(body.get("tools").and_then(Value::as_array)) {
        out.insert("tools".into(), tools);
        if let Some(tool_choice) = convert_response_tool_choice(body.get("tool_choice")) {
            out.insert("tool_choice".into(), tool_choice);
        }
    }
    if out.get("stream").and_then(Value::as_bool).unwrap_or(false) {
        let mut stream_options = object_from_value(body.get("stream_options").cloned());
        stream_options.insert("include_usage".into(), json!(true));
        out.insert("stream_options".into(), Value::Object(stream_options));
    }
    Value::Object(out)
}

fn append_responses_input_as_chat_messages(input: Option<&Value>, messages: &mut Vec<Value>) {
    let mut pending_tool_calls = Vec::new();
    match input {
        Some(Value::String(text)) => messages.push(json!({ "role": "user", "content": text })),
        Some(Value::Array(items)) => {
            for item in items {
                append_response_item_as_chat_message(item, messages, &mut pending_tool_calls);
            }
        }
        Some(Value::Object(_)) => {
            append_response_item_as_chat_message(input.unwrap(), messages, &mut pending_tool_calls);
        }
        _ => {}
    }
    flush_pending_tool_calls(messages, &mut pending_tool_calls);
}

fn append_response_item_as_chat_message(
    item: &Value,
    messages: &mut Vec<Value>,
    pending_tool_calls: &mut Vec<Value>,
) {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    if is_tool_call_type(item_type) {
        pending_tool_calls.push(response_function_call_to_chat_tool_call(
            item,
            pending_tool_calls.len(),
        ));
        return;
    }
    if is_tool_output_type(item_type) {
        flush_pending_tool_calls(messages, pending_tool_calls);
        messages.push(json!({
            "role": "tool",
            "tool_call_id": response_item_call_id(item),
            "content": canonical_json_value(
                item.get("output")
                    .or_else(|| item.get("result"))
                    .or_else(|| item.get("content"))
                    .unwrap_or(&Value::Null)
            )
        }));
        return;
    }
    if item_type == "reasoning" {
        return;
    }
    flush_pending_tool_calls(messages, pending_tool_calls);
    if item.get("role").is_some() || item.get("content").is_some() {
        messages.push(json!({
            "role": responses_role_to_chat_role(item.get("role").and_then(Value::as_str).unwrap_or("user")),
            "content": content_text(item.get("content").unwrap_or(&Value::Null))
        }));
    }
}

fn flush_pending_tool_calls(messages: &mut Vec<Value>, pending_tool_calls: &mut Vec<Value>) {
    if pending_tool_calls.is_empty() {
        return;
    }
    messages.push(json!({
        "role": "assistant",
        "content": null,
        "tool_calls": std::mem::take(pending_tool_calls)
    }));
}

fn response_function_call_to_chat_tool_call(item: &Value, index: usize) -> Value {
    let call_id = response_item_call_id(item);
    let call_id = if call_id.is_empty() {
        format!("call_{index}")
    } else {
        call_id
    };
    json!({
        "id": call_id,
        "type": "function",
            "function": {
            "name": chat_tool_name_from_response_call(item),
            "arguments": canonical_json_value(
                item.get("arguments")
                    .or_else(|| item.get("input"))
                    .unwrap_or(&Value::Object(Map::new()))
            )
        }
    })
}

fn chat_response_to_responses(payload: &Value, model: &str) -> Value {
    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let message = choice.get("message").unwrap_or(&Value::Null);
    let response_id =
        response_id_from_chat_id(payload.get("id").and_then(Value::as_str).unwrap_or(""));
    let finish_reason = choice.get("finish_reason").and_then(Value::as_str);
    let mut output = Vec::new();
    let text = content_text(message.get("content").unwrap_or(&Value::Null));
    if !text.is_empty() {
        output.push(json!({
            "id": format!("{response_id}_msg"),
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": text, "annotations": [] }]
        }));
    }
    for (index, call) in message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        output.push(response_tool_call_item_from_chat(call, index));
    }
    if message.get("function_call").is_some()
        && let Some(function_call) = message.get("function_call")
    {
        output.push(response_tool_call_item_from_chat(
            &json!({ "id": "call_0", "function": function_call }),
            0,
        ));
    }
    let mut response = json!({
        "id": response_id,
        "object": "response",
        "created_at": payload
            .get("created")
            .and_then(Value::as_i64)
            .unwrap_or_else(now_seconds),
        "status": response_status_from_finish_reason(finish_reason),
        "model": payload
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(model),
        "output": output,
        "usage": chat_usage_to_responses_usage(payload.get("usage"))
    });
    if finish_reason == Some("length")
        && let Some(object) = response.as_object_mut()
    {
        object.insert(
            "incomplete_details".into(),
            json!({ "reason": "max_output_tokens" }),
        );
    }
    response
}

fn response_tool_call_item_from_chat(tool_call: &Value, index: usize) -> Value {
    let call_id = tool_call
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("call_{index}"));
    let function = tool_call.get("function").unwrap_or(&Value::Null);
    let tool = codex_tool_identity_from_chat_call(
        function
            .get("name")
            .or_else(|| tool_call.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("tool"),
    );
    let arguments = canonical_json_value(
        function
            .get("arguments")
            .or_else(|| tool_call.get("arguments"))
            .unwrap_or(&Value::Object(Map::new())),
    );
    response_function_call_item(
        &format!("fc_{}", sanitize_id(&call_id)),
        "completed",
        &call_id,
        tool.namespace.as_deref(),
        &tool.name,
        &arguments,
    )
}

fn convert_response_tools(tools: Option<&Vec<Value>>) -> Option<Value> {
    let mut converted = Vec::new();
    for tool in tools.into_iter().flatten() {
        add_response_tool(&mut converted, tool, "");
    }
    (!converted.is_empty()).then_some(Value::Array(converted))
}

fn add_response_tool(out: &mut Vec<Value>, tool: &Value, namespace: &str) {
    if let Some(name) = tool.as_str() {
        let name = safe_tool_name(name);
        if !name.is_empty() {
            out.push(json!({
                "type": "function",
                "function": {
                    "name": name,
                    "description": "Custom Codex tool.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "input": { "type": "string", "description": "Input to pass to the custom Codex tool." }
                        },
                        "required": ["input"]
                    }
                }
            }));
        }
        return;
    }
    let Some(object) = tool.as_object() else {
        return;
    };
    let tool_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("function");
    if tool_type == "namespace" {
        let namespace = object
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(namespace);
        for child in object
            .get("tools")
            .or_else(|| object.get("children"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            add_response_tool(out, child, namespace);
        }
        return;
    }
    let original_name = object
        .get("name")
        .or_else(|| object.get("function").and_then(|value| value.get("name")))
        .and_then(Value::as_str)
        .unwrap_or("");
    let name = if namespace.trim().is_empty() {
        safe_tool_name(original_name)
    } else {
        safe_tool_name(&namespaced_tool_name(namespace, original_name))
    };
    if name.is_empty() {
        return;
    }
    if tool_type == "custom" || tool_type == "tool_search" {
        out.push(json!({
            "type": "function",
            "function": {
                "name": name,
                "description": object
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("Custom Codex tool."),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "input": { "type": "string", "description": "Input to pass to the custom Codex tool." }
                    },
                    "required": ["input"]
                }
            }
        }));
        return;
    }
    out.push(json!({
        "type": "function",
        "function": {
            "name": name,
            "description": object
                .get("description")
                .or_else(|| object.get("function").and_then(|value| value.get("description")))
                .and_then(Value::as_str)
                .unwrap_or(""),
            "parameters": object
                .get("parameters")
                .or_else(|| object.get("input_schema"))
                .or_else(|| object.get("inputSchema"))
                .or_else(|| object.get("function").and_then(|value| value.get("parameters")))
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} }))
        }
    }));
}

fn convert_response_tool_choice(choice: Option<&Value>) -> Option<Value> {
    match choice {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value == "auto" => Some(json!("auto")),
        Some(Value::String(value)) if value == "none" => Some(json!("none")),
        Some(Value::String(value)) if value == "required" || value == "any" => {
            Some(json!("required"))
        }
        Some(Value::Object(object)) => {
            let name = object
                .get("name")
                .or_else(|| {
                    object
                        .get("function")
                        .and_then(|function| function.get("name"))
                })
                .and_then(Value::as_str)?;
            Some(json!({ "type": "function", "function": { "name": safe_tool_name(name) } }))
        }
        _ => None,
    }
}

fn collapse_system_messages(messages: Vec<Value>) -> Vec<Value> {
    let mut system = Vec::new();
    let mut rest = Vec::new();
    for message in messages {
        if message.get("role").and_then(Value::as_str) == Some("system") {
            let content = message.get("content").and_then(Value::as_str).unwrap_or("");
            if !content.trim().is_empty() {
                system.push(content.to_string());
            }
        } else {
            rest.push(message);
        }
    }
    if system.is_empty() {
        rest
    } else {
        let mut out = vec![json!({ "role": "system", "content": system.join("\n\n") })];
        out.extend(rest);
        out
    }
}

fn responses_role_to_chat_role(role: &str) -> &str {
    match role {
        "assistant" => "assistant",
        "system" | "developer" => "system",
        "tool" => "tool",
        _ => "user",
    }
}

fn content_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(block_text).collect::<Vec<_>>().join("\n"),
        Value::Object(_) => block_text(value),
        _ => String::new(),
    }
}

fn block_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(block_text).collect::<Vec<_>>().join("\n"),
        Value::Object(object) => {
            let block_type = object.get("type").and_then(Value::as_str).unwrap_or("");
            if matches!(
                block_type,
                "input_text" | "output_text" | "text" | "summary_text"
            ) {
                return object
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
            }
            if block_type == "refusal" {
                return object
                    .get("refusal")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
            }
            if matches!(block_type, "input_image" | "image" | "image_url") {
                return "[Image attachment]".to_string();
            }
            if let Some(text) = object.get("text").and_then(Value::as_str) {
                return text.to_string();
            }
            if let Some(content) = object.get("content") {
                return content_text(content);
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn chat_usage_to_responses_usage(usage: Option<&Value>) -> Value {
    let usage = usage.unwrap_or(&Value::Null);
    let input = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let output = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let total = usage
        .get("total_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(input + output);
    json!({
        "input_tokens": input,
        "output_tokens": output,
        "total_tokens": total
    })
}

fn stream_error_response(status: StatusCode, model: &str, message: String) -> Response {
    let response_id = random_id("resp");
    let body = sse_frame(
        "response.failed",
        json!({
            "type": "response.failed",
            "response": {
                "id": response_id,
                "object": "response",
                "created_at": now_seconds(),
                "status": "failed",
                "model": model,
                "output": [],
                "error": { "message": message },
                "usage": chat_usage_to_responses_usage(None)
            }
        }),
    );
    let mut response = body.into_response();
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn parse_sse_data_lines(text: &str) -> Vec<String> {
    text.split("\n\n")
        .flat_map(|frame| {
            frame
                .split('\n')
                .map(str::trim)
                .filter(|line| line.starts_with("data:"))
                .map(|line| line.trim_start_matches("data:").trim().to_string())
                .collect::<Vec<_>>()
        })
        .filter(|line| !line.is_empty())
        .collect()
}

fn take_sse_frame(buffer: &mut String) -> Option<String> {
    let lf = buffer.find("\n\n").map(|index| (index, 2));
    let crlf = buffer.find("\r\n\r\n").map(|index| (index, 4));
    let (index, len) = match (lf, crlf) {
        (Some(left), Some(right)) if right.0 < left.0 => right,
        (Some(left), _) => left,
        (_, Some(right)) => right,
        _ => return None,
    };
    let frame = buffer[..index].to_string();
    buffer.drain(..index + len);
    Some(frame)
}

fn sse_frame(event: &str, data: Value) -> String {
    format!("event: {event}\ndata: {}\n\n", data)
}

fn is_tool_call_type(value: &str) -> bool {
    matches!(
        value,
        "function_call" | "custom_tool_call" | "tool_search_call"
    )
}

fn is_tool_output_type(value: &str) -> bool {
    matches!(
        value,
        "function_call_output" | "custom_tool_call_output" | "tool_search_output"
    )
}

fn response_item_call_id(item: &Value) -> String {
    string_field(item, &["call_id", "callId", "id"]).unwrap_or_default()
}

fn response_id_from_chat_id(id: &str) -> String {
    let trimmed = id.trim();
    if trimmed.starts_with("resp_") {
        return trimmed.to_string();
    }
    let safe = sanitize_id(trimmed);
    if safe.is_empty() {
        random_id("resp")
    } else {
        format!("resp_{safe}")
    }
}

fn response_status_from_finish_reason(reason: Option<&str>) -> &'static str {
    match reason {
        Some("length") => "incomplete",
        Some("content_filter") => "failed",
        _ => "completed",
    }
}

fn canonical_json_value(value: &Value) -> String {
    match value {
        Value::String(text) => canonical_json_string_from_str(text),
        Value::Null => String::new(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn canonical_json_string_from_str(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(parsed) => serde_json::to_string(&parsed).unwrap_or_else(|_| trimmed.to_string()),
        Err(_) => value.to_string(),
    }
}

fn safe_tool_name(value: &str) -> String {
    let name = value.trim();
    let out = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    out.chars().take(64).collect::<String>()
}

fn namespaced_tool_name(namespace: &str, name: &str) -> String {
    let namespace = namespace.trim();
    let name = name.trim();
    format!("{namespace}__{name}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexToolIdentity {
    namespace: Option<String>,
    name: String,
}

fn codex_tool_identity_from_chat_call(value: &str) -> CodexToolIdentity {
    let name = safe_tool_name(value);
    match name.as_str() {
        "context_snapshot" | "memory" | "skill_list_current" | "skill_read_current" => {
            CodexToolIdentity {
                namespace: Some("mcp__mia_app".to_string()),
                name,
            }
        }
        _ if name.starts_with("mcp__mia_app_") && !name.starts_with("mcp__mia_app__") => {
            let suffix = name.trim_start_matches("mcp__mia_app_");
            CodexToolIdentity {
                namespace: Some("mcp__mia_app".to_string()),
                name: suffix.to_string(),
            }
        }
        _ if name.starts_with("mcp__") => {
            if let Some((namespace, tool_name)) = split_flat_mcp_tool_name(&name) {
                CodexToolIdentity {
                    namespace: Some(namespace),
                    name: tool_name,
                }
            } else {
                CodexToolIdentity {
                    namespace: None,
                    name,
                }
            }
        }
        _ => CodexToolIdentity {
            namespace: None,
            name,
        },
    }
}

fn split_flat_mcp_tool_name(name: &str) -> Option<(String, String)> {
    let split_at = name.rfind("__")?;
    if split_at <= "mcp".len() {
        return None;
    }
    let namespace = name[..split_at].to_string();
    let tool_name = name[split_at + 2..].to_string();
    if namespace == "mcp" || tool_name.is_empty() {
        return None;
    }
    Some((namespace, tool_name))
}

fn chat_tool_name_from_response_call(item: &Value) -> String {
    let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
    let Some(namespace) = item.get("namespace").and_then(Value::as_str) else {
        return safe_tool_name(name);
    };
    safe_tool_name(&namespaced_tool_name(namespace, name))
}

fn response_function_call_item(
    id: &str,
    status: &str,
    call_id: &str,
    namespace: Option<&str>,
    name: &str,
    arguments: &str,
) -> Value {
    let mut item = json!({
        "id": id,
        "type": "function_call",
        "status": status,
        "call_id": call_id,
        "name": name,
        "arguments": arguments
    });
    if let Some(namespace) = namespace.filter(|value| !value.trim().is_empty())
        && let Some(object) = item.as_object_mut()
    {
        object.insert("namespace".into(), json!(namespace));
    }
    item
}

fn sanitize_id(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
}

fn random_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::now_v7().simple())
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn object_from_value(value: Option<Value>) -> Map<String, Value> {
    value
        .and_then(|value| match value {
            Value::Object(object) => Some(object),
            _ => None,
        })
        .unwrap_or_default()
}

fn copy_key(body: &Value, out: &mut Map<String, Value>, source: &str, target: &str) {
    if let Some(value) = body.get(source) {
        out.insert(target.to_string(), value.clone());
    }
}

fn trim_trailing_slash(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn request_authorized(headers: &HeaderMap, session: &ProxySession) -> bool {
    !session.require_header_auth || authorized(headers, &session.auth_token)
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    bearer_token(headers).is_some_and(|value| value == token)
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if authorization.to_ascii_lowercase().starts_with("bearer ") {
        return Some(authorization[7..].trim().to_string());
    }
    ["x-api-key", "openai-api-key"]
        .iter()
        .find_map(|key| headers.get(*key).and_then(|value| value.to_str().ok()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn json_response(status: StatusCode, payload: Value) -> Response {
    let mut response = Json(payload).into_response();
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn proxy_error(status: StatusCode, message: &str) -> Response {
    json_response(
        status,
        json!({
            "error": {
                "type": "mia_codex_proxy_error",
                "message": message
            }
        }),
    )
}

fn status_code(status: reqwest::StatusCode) -> StatusCode {
    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY)
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
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn string_field(source: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| source.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_request_converts_to_chat_completions() {
        let body = json!({
            "model": "ignored",
            "instructions": "system",
            "input": [{ "role": "user", "content": [{ "type": "input_text", "text": "hello" }] }],
            "stream": true,
            "tools": [{ "type": "function", "name": "read_file", "parameters": { "type": "object" } }]
        });

        let converted = responses_to_chat_completions(&body, "mia-auto");

        assert_eq!(converted["model"], "mia-auto");
        assert_eq!(converted["stream"], true);
        assert_eq!(converted["messages"][0]["role"], "system");
        assert_eq!(converted["messages"][1]["content"], "hello");
        assert_eq!(converted["tools"][0]["function"]["name"], "read_file");
    }

    #[test]
    fn responses_request_flattens_mia_memory_tool_for_chat_completions() {
        let body = json!({
            "model": "ignored",
            "input": "remember this",
            "tools": [{
                "type": "namespace",
                "name": "mcp__mia_app",
                "tools": [{
                    "type": "function",
                    "name": "memory",
                    "parameters": { "type": "object" }
                }]
            }]
        });

        let converted = responses_to_chat_completions(&body, "mia-auto");

        assert_eq!(
            converted["tools"][0]["function"]["name"],
            "mcp__mia_app__memory"
        );
    }

    #[test]
    fn chat_response_restores_namespaced_mia_memory_tool_for_codex() {
        let response = chat_response_to_responses(
            &json!({
                "id": "chatcmpl_1",
                "created": 123,
                "model": "deepseek",
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "tool_calls": [{
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "memory",
                                "arguments": "{\"action\":\"add\",\"target\":\"memory\",\"content\":\"code OAK271\"}"
                            }
                        }]
                    }
                }]
            }),
            "mia-auto",
        );

        assert_eq!(response["output"][0]["namespace"], "mcp__mia_app");
        assert_eq!(response["output"][0]["name"], "memory");
    }

    #[test]
    fn chat_response_restores_legacy_collapsed_mia_mcp_tool_name_for_codex() {
        let response = chat_response_to_responses(
            &json!({
                "id": "chatcmpl_1",
                "created": 123,
                "model": "deepseek",
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "tool_calls": [{
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "mcp__mia_app_memory",
                                "arguments": "{}"
                            }
                        }]
                    }
                }]
            }),
            "mia-auto",
        );

        assert_eq!(response["output"][0]["namespace"], "mcp__mia_app");
        assert_eq!(response["output"][0]["name"], "memory");
    }

    #[test]
    fn response_history_flattens_namespaced_tool_call_for_chat_completions() {
        let body = json!({
            "model": "ignored",
            "input": [{
                "type": "function_call",
                "call_id": "call_1",
                "namespace": "mcp__mia_app",
                "name": "memory",
                "arguments": "{\"action\":\"add\"}"
            }]
        });

        let converted = responses_to_chat_completions(&body, "mia-auto");

        assert_eq!(
            converted["messages"][0]["tool_calls"][0]["function"]["name"],
            "mcp__mia_app__memory"
        );
    }

    #[test]
    fn chat_response_converts_to_responses_output() {
        let response = chat_response_to_responses(
            &json!({
                "id": "chatcmpl_1",
                "created": 123,
                "model": "deepseek",
                "choices": [{
                    "finish_reason": "stop",
                    "message": { "content": "hi" }
                }],
                "usage": { "prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3 }
            }),
            "mia-auto",
        );

        assert_eq!(response["id"], "resp_chatcmpl_1");
        assert_eq!(response["status"], "completed");
        assert_eq!(response["output"][0]["content"][0]["text"], "hi");
        assert_eq!(response["usage"]["total_tokens"], 3);
    }

    #[test]
    fn response_history_restores_missing_tool_call_before_tool_output() {
        let mut history = ResponseHistory::default();
        history.record_response(&json!({
            "id": "resp_1",
            "output": [{
                "type": "function_call",
                "call_id": "call_1",
                "name": "read_file",
                "arguments": "{}"
            }]
        }));
        let mut body = json!({
            "previous_response_id": "resp_1",
            "input": [{ "type": "function_call_output", "call_id": "call_1", "output": "ok" }]
        });

        assert_eq!(enrich_request_with_history(&mut body, &history), 1);
        assert_eq!(body["input"][0]["type"], "function_call");
        assert_eq!(body["input"][1]["type"], "function_call_output");
    }

    #[tokio::test]
    async fn path_authenticated_proxy_supports_hermes_loopback_key_filtering() {
        let proxy = start_codex_mia_proxy(CodexMiaProxyConfig {
            base_url: "http://127.0.0.1:9/v1".into(),
            api_key: "upstream-token".into(),
            model: "mia-auto".into(),
            auth_via_path: true,
        })
        .await
        .expect("start proxy");

        let response = reqwest::get(format!("{}/models", proxy.base_url))
            .await
            .expect("request proxy models");

        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(proxy.api_key, "no-key-required");
        assert!(proxy.base_url.contains("/mia_codex_"));
    }
}
