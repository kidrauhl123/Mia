use std::collections::BTreeMap;

use anyhow::{Context, bail};
use mia_core_api_types::MemoryMode;
use reqwest::{Client, Method};
use serde_json::{Value, json};
use tokio::io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Debug, Clone, PartialEq, Eq)]
struct MiaMcpContext {
    core_url: String,
    bot_id: String,
    conversation_id: String,
    memory_mode: MemoryMode,
    origin_message_id: String,
    user_id: String,
}

impl MiaMcpContext {
    fn from_env() -> anyhow::Result<Self> {
        let core_url = env_value("MIA_CORE_URL");
        if core_url.is_empty() {
            bail!("MIA_CORE_URL is required");
        }
        Ok(Self {
            core_url: core_url.trim_end_matches('/').to_string(),
            bot_id: env_value("MIA_BOT_ID"),
            conversation_id: env_value("MIA_CONVERSATION_ID"),
            memory_mode: match env_value("MIA_MEMORY_MODE").as_str() {
                "mia" => MemoryMode::Mia,
                _ => MemoryMode::Native,
            },
            origin_message_id: env_value("MIA_ORIGIN_MESSAGE_ID"),
            user_id: env_value("MIA_USER_ID"),
        })
    }

    fn memory_context(&self) -> Value {
        json!({
            "userId": if self.user_id.is_empty() { "local" } else { &self.user_id },
            "botId": self.bot_id,
            "conversationId": self.conversation_id,
            "originMessageId": self.origin_message_id,
        })
    }
}

pub async fn run_builtin_mcp_stdio() -> anyhow::Result<()> {
    let context = MiaMcpContext::from_env()?;
    let client = Client::new();
    let stdin = io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let mut stdout = io::stdout();

    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(line) {
            Ok(request) => request,
            Err(error) => {
                write_response(
                    &mut stdout,
                    json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":error.to_string()}}),
                )
                .await?;
                continue;
            }
        };
        let Some(response) = handle_request(&client, &context, request).await else {
            continue;
        };
        write_response(&mut stdout, response).await?;
    }
    Ok(())
}

async fn write_response(stdout: &mut io::Stdout, response: Value) -> anyhow::Result<()> {
    stdout
        .write_all(format!("{}\n", serde_json::to_string(&response)?).as_bytes())
        .await?;
    stdout.flush().await?;
    Ok(())
}

async fn handle_request(client: &Client, context: &MiaMcpContext, request: Value) -> Option<Value> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match method {
        "initialize" => Some(json!({
            "jsonrpc":"2.0",
            "id":id,
            "result":{
                "protocolVersion":"2024-11-05",
                "capabilities":{"tools":{}},
                "serverInfo":{"name":"mia-app","version":env!("CARGO_PKG_VERSION")}
            }
        })),
        "notifications/initialized" => None,
        "tools/list" => Some(json!({
            "jsonrpc":"2.0",
            "id":id,
            "result":{"tools":tool_definitions(context.memory_mode)}
        })),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let args = params
                .get("arguments")
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = call_tool(client, context, name, args).await;
            Some(match result {
                Ok(value) => json!({
                    "jsonrpc":"2.0",
                    "id":id,
                    "result":{
                        "content":[{"type":"text","text":serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())}],
                        "isError":false
                    }
                }),
                Err(error) => json!({
                    "jsonrpc":"2.0",
                    "id":id,
                    "result":{
                        "content":[{"type":"text","text":error.to_string()}],
                        "isError":true
                    }
                }),
            })
        }
        _ => Some(json!({
            "jsonrpc":"2.0",
            "id":id,
            "error":{"code":-32601,"message":format!("Method not found: {method}")}
        })),
    }
}

async fn call_tool(
    client: &Client,
    context: &MiaMcpContext,
    name: &str,
    args: Value,
) -> anyhow::Result<Value> {
    match name {
        "context_snapshot" => {
            let mut query = BTreeMap::new();
            query.insert("conversationId", context.conversation_id.as_str());
            query.insert("originMessageId", context.origin_message_id.as_str());
            core_json(
                client,
                context,
                Method::GET,
                "/api/mia/context",
                Some(&query),
                None,
            )
            .await
        }
        "memory" if context.memory_mode == MemoryMode::Mia => {
            let mut body = args.as_object().cloned().unwrap_or_default();
            body.insert("context".into(), context.memory_context());
            core_json(
                client,
                context,
                Method::POST,
                "/api/mia/memory",
                None,
                Some(Value::Object(body)),
            )
            .await
        }
        "skill_list_current" => {
            let mut query = BTreeMap::new();
            query.insert("botId", context.bot_id.as_str());
            core_json(
                client,
                context,
                Method::GET,
                "/api/mia/skills/current",
                Some(&query),
                None,
            )
            .await
        }
        "skill_read_current" => {
            let id = args.get("id").and_then(Value::as_str).unwrap_or_default();
            if id.trim().is_empty() {
                bail!("id is required");
            }
            let mut query = BTreeMap::new();
            query.insert("botId", context.bot_id.as_str());
            query.insert("id", id);
            core_json(
                client,
                context,
                Method::GET,
                "/api/mia/skills/current/read",
                Some(&query),
                None,
            )
            .await
        }
        _ => bail!("Unknown tool: {name}"),
    }
}

async fn core_json(
    client: &Client,
    context: &MiaMcpContext,
    method: Method,
    route: &str,
    query: Option<&BTreeMap<&str, &str>>,
    body: Option<Value>,
) -> anyhow::Result<Value> {
    let mut request = client.request(method, format!("{}{}", context.core_url, route));
    if let Some(query) = query {
        request = request.query(query);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.context("request Mia Core")?;
    let status = response.status();
    let text = response.text().await.context("read Mia Core response")?;
    let value = serde_json::from_str::<Value>(&text).context("decode Mia Core response")?;
    if !status.is_success() {
        bail!(
            "{}",
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Mia Core request failed")
        );
    }
    Ok(value)
}

fn tool_definitions(memory_mode: MemoryMode) -> Vec<Value> {
    let mut tools = vec![
        tool(
            "context_snapshot",
            "Read the current Mia bot and conversation context.",
            json!({"type":"object","properties":{}}),
            true,
            false,
        ),
        tool(
            "skill_list_current",
            "List summaries of skills enabled for the current Mia bot.",
            json!({"type":"object","properties":{}}),
            true,
            false,
        ),
        tool(
            "skill_read_current",
            "Read a skill enabled for the current Mia bot.",
            json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}),
            true,
            false,
        ),
    ];
    if memory_mode == MemoryMode::Mia {
        tools.insert(
            1,
            tool(
                "memory",
                "Add, replace, or remove an entry in Mia-owned bounded memory.",
                json!({
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["add", "replace", "remove"]},
                        "target": {"type": "string", "enum": ["user", "memory"]},
                        "oldText": {"type": "string", "minLength": 1},
                        "content": {"type": "string", "minLength": 1}
                    },
                    "required": ["action", "target"],
                    "allOf": [
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
                    ],
                    "additionalProperties": false
                }),
                false,
                true,
            ),
        );
    }
    tools
}

fn tool(
    name: &str,
    description: &str,
    input_schema: Value,
    read_only: bool,
    destructive: bool,
) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
        "annotations": {
            "readOnlyHint": read_only,
            "destructiveHint": destructive,
            "idempotentHint": read_only || destructive,
            "openWorldHint": false,
        }
    })
}

fn env_value(name: &str) -> String {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_catalog_has_no_scheduler_tools() {
        let names = tool_definitions(MemoryMode::Mia)
            .into_iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        assert!(!names.iter().any(|name| name.starts_with("schedule_")));
    }

    #[test]
    fn memory_context_is_owned_by_process_environment() {
        let context = MiaMcpContext {
            core_url: "http://127.0.0.1:1".into(),
            bot_id: "bot_a".into(),
            conversation_id: "conv_a".into(),
            memory_mode: MemoryMode::Mia,
            origin_message_id: "msg_a".into(),
            user_id: "user_a".into(),
        };
        assert_eq!(
            context.memory_context(),
            json!({
                "userId":"user_a",
                "botId":"bot_a",
                "conversationId":"conv_a",
                "originMessageId":"msg_a"
            })
        );
    }
}
