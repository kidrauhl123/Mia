use std::collections::HashMap;
use std::process::Stdio;

use axum::{
    Json, Router,
    extract::Query,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};

async fn context(Query(query): Query<HashMap<String, String>>) -> Json<Value> {
    Json(json!({
        "conversationId": query.get("conversationId").cloned().unwrap_or_default(),
        "originMessageId": query.get("originMessageId").cloned().unwrap_or_default(),
    }))
}

async fn memory(Json(request): Json<Value>) -> impl IntoResponse {
    if request["content"] == "trigger_server_error" {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "memory_service_failed" })),
        )
            .into_response();
    }
    Json(request).into_response()
}

async fn start_fake_core() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/api/mia/context", get(context))
                .route("/api/mia/memory", post(memory)),
        )
        .await
        .unwrap();
    });
    format!("http://{address}")
}

fn spawn_mcp(core_url: &str, bot_id: &str, conversation_id: &str, memory_mode: &str) -> Child {
    Command::new(env!("CARGO_BIN_EXE_mia-core"))
        .arg("mcp-mia-stdio")
        .env("MIA_CORE_URL", core_url)
        .env("MIA_BOT_ID", bot_id)
        .env("MIA_CONVERSATION_ID", conversation_id)
        .env("MIA_MEMORY_MODE", memory_mode)
        .env("MIA_ORIGIN_MESSAGE_ID", "msg_origin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

async fn rpc(child: &mut Child, request: Value) -> Value {
    let stdin = child.stdin.as_mut().unwrap();
    stdin
        .write_all(format!("{}\n", request).as_bytes())
        .await
        .unwrap();
    stdin.flush().await.unwrap();
    let stdout = child.stdout.as_mut().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    serde_json::from_str(&line).unwrap()
}

#[tokio::test]
async fn builtin_mcp_exposes_one_memory_tool_only_in_mia_mode() {
    let core_url = start_fake_core().await;
    let mut child = spawn_mcp(&core_url, "bot_real", "conv_real", "mia");

    let initialized = rpc(
        &mut child,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
    )
    .await;
    assert_eq!(initialized["result"]["serverInfo"]["name"], "mia-app");

    let listed = rpc(
        &mut child,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
    )
    .await;
    let names = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![
            "context_snapshot",
            "memory",
            "skill_list_current",
            "skill_read_current"
        ]
    );
    for old_name in [
        "memory_search",
        "memory_list",
        "memory_remember",
        "memory_update",
        "memory_forget",
    ] {
        assert!(!names.contains(&old_name));
    }

    let memory_schema = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "memory")
        .unwrap()["inputSchema"]
        .clone();
    assert_eq!(memory_schema["required"], json!(["action"]));
    assert_eq!(
        memory_schema["properties"]["action"]["enum"],
        json!(["add", "replace", "remove"])
    );
    assert!(memory_schema["properties"].get("target").is_none());
    assert_eq!(
        memory_schema["allOf"],
        json!([
            {
                "if": {"properties": {"action": {"const": "add"}}, "required": ["action"]},
                "then": {"required": ["content"]}
            },
            {
                "if": {"properties": {"action": {"const": "replace"}}, "required": ["action"]},
                "then": {"required": ["oldText", "content"]}
            },
            {
                "if": {"properties": {"action": {"const": "remove"}}, "required": ["action"]},
                "then": {"required": ["oldText"]}
            }
        ])
    );

    let called = rpc(
        &mut child,
        json!({
            "jsonrpc":"2.0",
            "id":3,
            "method":"tools/call",
            "params":{"name":"context_snapshot","arguments":{}}
        }),
    )
    .await;
    let text = called["result"]["content"][0]["text"].as_str().unwrap();
    let payload: Value = serde_json::from_str(text).unwrap();
    assert_eq!(payload["conversationId"], "conv_real");
    assert_eq!(payload["originMessageId"], "msg_origin");

    let memory_call = rpc(
        &mut child,
        json!({
            "jsonrpc":"2.0",
            "id":4,
            "method":"tools/call",
            "params":{
                "name":"memory",
                "arguments":{
                    "context":{"conversationId":"spoofed","botId":"spoofed"},
                    "action":"add",
                    "target":"user",
                    "content":"可信路由"
                }
            }
        }),
    )
    .await;
    assert_eq!(memory_call["result"]["isError"], false);
    let memory_payload: Value = serde_json::from_str(
        memory_call["result"]["content"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(memory_payload["context"]["conversationId"], "conv_real");
    assert_eq!(memory_payload["context"]["botId"], "bot_real");
    assert_eq!(memory_payload["context"]["userId"], "local");
    assert!(memory_payload.get("target").is_none());

    let failed = rpc(
        &mut child,
        json!({
            "jsonrpc":"2.0",
            "id":5,
            "method":"tools/call",
            "params":{
                "name":"memory",
                "arguments":{
                    "action":"add",
                    "content":"trigger_server_error"
                }
            }
        }),
    )
    .await;
    assert_eq!(failed["result"]["isError"], true);

    child.kill().await.unwrap();
}

#[tokio::test]
async fn builtin_mcp_hides_memory_tool_in_native_mode() {
    let core_url = start_fake_core().await;
    let mut child = spawn_mcp(&core_url, "bot_real", "conv_real", "native");

    let listed = rpc(
        &mut child,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}),
    )
    .await;
    let names = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![
            "context_snapshot",
            "skill_list_current",
            "skill_read_current"
        ]
    );

    child.kill().await.unwrap();
}

#[tokio::test]
async fn builtin_mcp_processes_keep_conversation_context_isolated() {
    let core_url = start_fake_core().await;
    let mut first = spawn_mcp(&core_url, "bot_a", "conv_a", "mia");
    let mut second = spawn_mcp(&core_url, "bot_b", "conv_b", "mia");

    let request = json!({
        "jsonrpc":"2.0",
        "id":1,
        "method":"tools/call",
        "params":{"name":"context_snapshot","arguments":{}}
    });
    let first_result = rpc(&mut first, request.clone()).await;
    let second_result = rpc(&mut second, request).await;
    let first_payload: Value = serde_json::from_str(
        first_result["result"]["content"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let second_payload: Value = serde_json::from_str(
        second_result["result"]["content"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();

    assert_eq!(first_payload["conversationId"], "conv_a");
    assert_eq!(second_payload["conversationId"], "conv_b");

    first.kill().await.unwrap();
    second.kill().await.unwrap();
}
