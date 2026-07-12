use std::collections::HashMap;
use std::process::Stdio;

use axum::{Json, Router, extract::Query, routing::get};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};

async fn context(Query(query): Query<HashMap<String, String>>) -> Json<Value> {
    Json(json!({
        "botId": query.get("botId").cloned().unwrap_or_default(),
        "sessionId": query.get("sessionId").cloned().unwrap_or_default(),
        "originMessageId": query.get("originMessageId").cloned().unwrap_or_default(),
    }))
}

async fn start_fake_core() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/api/mia/context", get(context)),
        )
        .await
        .unwrap();
    });
    format!("http://{address}")
}

fn spawn_mcp(core_url: &str, bot_id: &str, conversation_id: &str) -> Child {
    Command::new(env!("CARGO_BIN_EXE_mia-core"))
        .arg("mcp-mia-stdio")
        .env("MIA_CORE_URL", core_url)
        .env("MIA_BOT_ID", bot_id)
        .env("MIA_CONVERSATION_ID", conversation_id)
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
async fn builtin_mcp_exposes_scoped_context_and_memory_tools_without_scheduler() {
    let core_url = start_fake_core().await;
    let mut child = spawn_mcp(&core_url, "bot_real", "conv_real");

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
    assert!(names.contains(&"context_snapshot"));
    assert!(names.contains(&"memory_search"));
    assert!(names.contains(&"memory_remember"));
    assert!(names.contains(&"skill_list_current"));
    assert!(!names.iter().any(|name| name.starts_with("schedule_")));

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
    assert_eq!(payload["botId"], "bot_real");
    assert_eq!(payload["sessionId"], "conv_real");
    assert_eq!(payload["originMessageId"], "msg_origin");

    child.kill().await.unwrap();
}

#[tokio::test]
async fn builtin_mcp_processes_keep_conversation_context_isolated() {
    let core_url = start_fake_core().await;
    let mut first = spawn_mcp(&core_url, "bot_a", "conv_a");
    let mut second = spawn_mcp(&core_url, "bot_b", "conv_b");

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

    assert_eq!(first_payload["botId"], "bot_a");
    assert_eq!(first_payload["sessionId"], "conv_a");
    assert_eq!(second_payload["botId"], "bot_b");
    assert_eq!(second_payload["sessionId"], "conv_b");

    first.kill().await.unwrap();
    second.kill().await.unwrap();
}
