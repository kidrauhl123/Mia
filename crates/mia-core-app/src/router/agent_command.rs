use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use mia_core_api_types::{
    AgentCommandExecuteRequest, AgentCommandExecuteResponse, AgentCommandListRequest,
    AgentCommandRegistryResponse,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::process::Command;
use tokio::time::timeout;

use super::state::ModuleStates;

const MIA_BRIDGE_COMMANDS: [(&str, &str); 1] =
    [("/resume", "在 Mia 聊天里选择并恢复外部 agent session")];
const CODEX_CURATED_NATIVE_COMMANDS: [(&str, &str); 1] =
    [("/goal", "Set or inspect the current Codex goal")];
const EXTERNAL_AGENT_BUILT_INS: [&str; 10] = [
    "/help",
    "/clear",
    "/model",
    "/cost",
    "/memory",
    "/config",
    "/status",
    "/permissions",
    "/resume",
    "/rewind",
];

type ExecuteResult = Result<Json<AgentCommandExecuteResponse>, (StatusCode, Json<Value>)>;

#[derive(Debug, Clone)]
struct CommandRuntimeContext {
    data_dir: PathBuf,
    project_path: PathBuf,
    home_dir: PathBuf,
}

#[derive(Debug, Clone)]
struct ParsedCommand {
    command: String,
    args: Vec<String>,
}

#[derive(Debug, Clone)]
struct ParsedMarkdownCommand {
    data: Map<String, Value>,
    content: String,
}

#[derive(Debug, Clone)]
struct ExternalSessionRow {
    id: String,
    title: String,
    preview: String,
    project: String,
    updated_at: u64,
}

pub async fn list_agent_commands(
    State(states): State<ModuleStates>,
    Json(request): Json<AgentCommandListRequest>,
) -> Json<AgentCommandRegistryResponse> {
    let engine = normalize_engine(&request.engine);
    let context = CommandRuntimeContext::new(
        &states,
        request.project_path.as_deref(),
        request.home_dir.as_deref(),
        None,
    );
    let native = native_command_rows(&engine);
    let bridge = bridge_command_rows(&engine);
    let custom = load_custom_commands(&engine, &context);
    let rows = merge_command_rows([bridge.clone(), native.clone(), custom.clone()]);

    Json(AgentCommandRegistryResponse {
        native,
        built_in: bridge.clone(),
        bridge,
        custom,
        count: rows.len(),
        rows,
    })
}

pub async fn execute_agent_command(
    State(states): State<ModuleStates>,
    Json(request): Json<AgentCommandExecuteRequest>,
) -> ExecuteResult {
    let engine = normalize_engine(&request.engine);
    let context_project_path = string_value(&request.context, &["projectPath", "project_path"]);
    let project_path = request
        .project_path
        .as_deref()
        .or(context_project_path.as_deref());
    let context = CommandRuntimeContext::new(
        &states,
        project_path,
        request.home_dir.as_deref(),
        Some(&request.context),
    );
    let parsed = parsed_command(&request);

    if EXTERNAL_AGENT_BUILT_INS.contains(&parsed.command.as_str()) {
        let response = run_builtin_command(&states, &context, &engine, &parsed, &request.context)
            .await
            .map_err(bad_request)?;
        return Ok(Json(response));
    }

    let command_path = request.command_path.as_deref().unwrap_or_default();
    let resolved =
        assert_allowed_agent_command_path(command_path, &engine, &context).map_err(bad_request)?;
    let raw = tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|_| bad_request("Command file not found."))?;
    let markdown = parse_command_frontmatter(&raw);
    let args_string = parsed.args.join(" ");
    let mut content = markdown.content.replace("$ARGUMENTS", &args_string);
    for (index, arg) in parsed.args.iter().enumerate() {
        content = content.replace(&format!("${}", index + 1), arg);
    }

    Ok(Json(AgentCommandExecuteResponse {
        kind: "custom".to_owned(),
        command: parsed.command,
        content: content.clone(),
        command_result: None,
        metadata: Some(Value::Object(markdown.data)),
        has_file_includes: Some(content.contains('@')),
        has_bash_commands: Some(content.contains('!')),
    }))
}

impl CommandRuntimeContext {
    fn new(
        states: &ModuleStates,
        project_path: Option<&str>,
        home_dir: Option<&str>,
        request_context: Option<&Value>,
    ) -> Self {
        let project = project_path
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| states.workspace_dir.clone());
        let home = home_dir
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                request_context
                    .and_then(|value| string_value(value, &["homeDir", "home_dir"]))
                    .map(PathBuf::from)
            })
            .or_else(home_dir_from_env)
            .unwrap_or_else(|| states.data_dir.clone());
        Self {
            data_dir: states.data_dir.clone(),
            project_path: absolutize_path(project),
            home_dir: absolutize_path(home),
        }
    }
}

fn parsed_command(request: &AgentCommandExecuteRequest) -> ParsedCommand {
    let mut command = request
        .command_name
        .as_deref()
        .or(request.command.as_deref())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let mut args = request.args.clone();
    if command.is_empty()
        && let Some(text) = request.text.as_deref()
    {
        let input = text.trim();
        let first = input.split_whitespace().next().unwrap_or_default();
        command = first.to_ascii_lowercase();
        if args.is_empty() {
            args = input
                .get(first.len()..)
                .unwrap_or_default()
                .split_whitespace()
                .map(str::to_owned)
                .collect();
        }
    }
    if !command.starts_with('/') && !command.is_empty() {
        command = format!("/{command}");
    }
    ParsedCommand { command, args }
}

fn bridge_command_rows(engine: &str) -> Vec<Value> {
    MIA_BRIDGE_COMMANDS
        .iter()
        .map(|(command, description)| {
            command_row(
                command,
                description,
                json!({"source": "mia", "type": "bridge", "engine": engine}),
            )
        })
        .collect()
}

fn native_command_rows(engine: &str) -> Vec<Value> {
    if engine != "codex" {
        return Vec::new();
    }
    CODEX_CURATED_NATIVE_COMMANDS
        .iter()
        .map(|(command, description)| {
            command_row(
                command,
                description,
                json!({"source": "native-curated", "type": "native", "engine": engine}),
            )
        })
        .collect()
}

fn load_custom_commands(engine: &str, context: &CommandRuntimeContext) -> Vec<Value> {
    let mut rows = agent_command_roots(engine, context)
        .into_iter()
        .flat_map(|(namespace, root)| {
            scan_agent_commands_directory(&root, &root, &namespace, engine)
        })
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        a.get("command")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(b.get("command").and_then(Value::as_str).unwrap_or_default())
    });
    rows
}

fn agent_command_roots(engine: &str, context: &CommandRuntimeContext) -> Vec<(String, PathBuf)> {
    if engine != "claude-code" {
        return Vec::new();
    }
    vec![
        (
            "project".to_owned(),
            context.project_path.join(".claude").join("commands"),
        ),
        (
            "user".to_owned(),
            context.home_dir.join(".claude").join("commands"),
        ),
    ]
}

fn scan_agent_commands_directory(
    dir: &Path,
    base_dir: &Path,
    namespace: &str,
    engine: &str,
) -> Vec<Value> {
    let mut rows = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return rows;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            rows.extend(scan_agent_commands_directory(
                &path, base_dir, namespace, engine,
            ));
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            && let Some(row) = command_from_markdown_file(&path, base_dir, namespace, engine)
        {
            rows.push(row);
        }
    }
    rows
}

fn command_from_markdown_file(
    file_path: &Path,
    base_dir: &Path,
    namespace: &str,
    engine: &str,
) -> Option<Value> {
    let content = std::fs::read_to_string(file_path).ok()?;
    let parsed = parse_command_frontmatter(&content);
    let relative_path = file_path.strip_prefix(base_dir).ok()?;
    let command_path = relative_path
        .with_extension("")
        .to_string_lossy()
        .replace('\\', "/");
    let command = format!("/{command_path}");
    let first_line = parsed
        .content
        .trim()
        .lines()
        .next()
        .unwrap_or_default()
        .trim_start_matches('#')
        .trim()
        .to_owned();
    let description = parsed
        .data
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(if first_line.is_empty() {
            "自定义 Claude Code 命令"
        } else {
            &first_line
        });
    Some(json!({
        "command": command,
        "name": command,
        "path": file_path.to_string_lossy(),
        "relativePath": relative_path.to_string_lossy(),
        "description": description,
        "namespace": namespace,
        "source": "custom",
        "type": "custom",
        "engine": engine,
        "metadata": Value::Object(parsed.data)
    }))
}

fn command_row(command: &str, description: &str, defaults: Value) -> Value {
    let mut row = defaults.as_object().cloned().unwrap_or_default();
    row.insert("command".to_owned(), json!(command));
    row.insert("name".to_owned(), json!(command));
    row.insert("description".to_owned(), json!(description));
    Value::Object(row)
}

fn merge_command_rows(groups: impl IntoIterator<Item = Vec<Value>>) -> Vec<Value> {
    let mut seen = Vec::<String>::new();
    let mut rows = Vec::new();
    for group in groups {
        for row in group {
            let command = row
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if command.is_empty() || seen.contains(&command) {
                continue;
            }
            seen.push(command);
            rows.push(row);
        }
    }
    rows
}

fn parse_command_frontmatter(markdown: &str) -> ParsedMarkdownCommand {
    let raw = markdown.to_owned();
    if !raw.starts_with("---\n") && !raw.starts_with("---\r\n") {
        return ParsedMarkdownCommand {
            data: Map::new(),
            content: raw,
        };
    }
    let body_start = if raw.starts_with("---\r\n") { 5 } else { 4 };
    let Some(end_offset) = raw[body_start..]
        .find("\n---\n")
        .or_else(|| raw[body_start..].find("\r\n---\r\n"))
    else {
        return ParsedMarkdownCommand {
            data: Map::new(),
            content: raw,
        };
    };
    let end = body_start + end_offset;
    let delimiter_len = if raw[end..].starts_with("\r\n---\r\n") {
        7
    } else {
        5
    };
    let frontmatter = &raw[body_start..end];
    let mut data = Map::new();
    for line in frontmatter.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        {
            continue;
        }
        data.insert(
            key.to_owned(),
            Value::String(value.trim().trim_matches('"').trim_matches('\'').to_owned()),
        );
    }
    ParsedMarkdownCommand {
        data,
        content: raw[end + delimiter_len..].to_owned(),
    }
}

fn assert_allowed_agent_command_path(
    command_path: &str,
    engine: &str,
    context: &CommandRuntimeContext,
) -> Result<PathBuf, String> {
    let resolved = absolutize_path(PathBuf::from(command_path));
    if !resolved.is_file() {
        return Err("Command file not found.".to_owned());
    }
    let roots = agent_command_roots(engine, context);
    if !roots.iter().any(|(_, root)| is_child_path(root, &resolved)) {
        return Err("Command must be inside an allowed .claude/commands directory.".to_owned());
    }
    Ok(resolved)
}

async fn run_builtin_command(
    states: &ModuleStates,
    context: &CommandRuntimeContext,
    engine: &str,
    parsed: &ParsedCommand,
    request_context: &Value,
) -> Result<AgentCommandExecuteResponse, String> {
    let bot = request_context.get("bot").unwrap_or(&Value::Null);
    let bot_key = string_value(bot, &["key", "id"]).unwrap_or_else(|| "mia".to_owned());
    let bot_name = string_value(bot, &["name", "displayName", "display_name"])
        .unwrap_or_else(|| "当前 Bot".to_owned());
    let session_id = string_value(request_context, &["sessionId", "session_id"])
        .unwrap_or_else(|| "default".to_owned());
    let command = parsed.command.as_str();
    let content = match command {
        "/status" => {
            let info = local_engine_info(engine).await;
            let config = bot.get("engineConfig").or_else(|| bot.get("engine_config"));
            let model = config
                .and_then(|value| string_value(value, &["model"]))
                .unwrap_or_else(|| default_model_label(engine));
            let effort = config
                .and_then(|value| string_value(value, &["effortLevel", "effort_level"]))
                .unwrap_or_else(|| "medium".to_owned());
            let permission = engine_permission_mode(context, engine);
            let external_session =
                get_agent_session_id(context, engine, &bot_key, &session_id).unwrap_or_else(|| "尚未创建".to_owned());
            [
                format!("{bot_name} 使用 {} 本地引擎。", local_engine_label(engine)),
                format!("模型：{model}"),
                format!("推理强度：{effort}"),
                format!("权限：{permission}"),
                format!("CLI：{}", info.path.unwrap_or_else(|| "未检测到".to_owned())),
                info.version.map(|value| format!("版本：{value}")).unwrap_or_default(),
                format!("外部会话：{external_session}"),
            ]
            .into_iter()
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
        }
        "/model" => {
            let config = bot.get("engineConfig").or_else(|| bot.get("engine_config"));
            let model = config
                .and_then(|value| string_value(value, &["model"]))
                .unwrap_or_else(|| default_model_label(engine));
            format!("当前模型：{model}。\n可以用底部模型选择器切换这个 Bot 的本地引擎模型。")
        }
        "/permissions" | "/permission" => {
            format!(
                "当前权限模式：{}。\n可以用底部权限选择器切换当前本地引擎权限。",
                engine_permission_mode(context, engine)
            )
        }
        "/clear" => {
            "Mia 还没有把 /clear 接到当前会话清空动作。现在可以用顶部新对话按钮开启干净会话。".to_owned()
        }
        "/cost" => {
            "当前 GUI 通道暂未保存外部 CLI 的 token/cost 汇总。Claude Code 或 Codex CLI 自己的用量以本机 CLI 配置为准。".to_owned()
        }
        "/memory" => {
            let memory_path = context.project_path.join("CLAUDE.md");
            if memory_path.exists() {
                format!("当前项目记忆文件：{}", memory_path.to_string_lossy())
            } else {
                format!("当前项目未找到 CLAUDE.md：{}", memory_path.to_string_lossy())
            }
        }
        "/config" => {
            "本地外部引擎的模型和权限在输入框下方选择器里查看和切换；更底层的账号、默认模型、权限策略仍以用户本机 CLI 配置为准。".to_owned()
        }
        "/resume" => {
            return run_resume_command(states, context, engine, parsed, request_context);
        }
        "/rewind" => {
            format!(
                "Mia 还没有把 /rewind 接到会话回退动作。参数：{}。",
                parsed.args.join(" ").if_empty("默认 1 步")
            )
        }
        "/help" => [
            "当前是本地外部 Agent 引擎，可用命令：",
            "/status - 查看本地 CLI、模型、权限和外部会话",
            "/model - 查看当前模型",
            "/permissions - 查看当前权限模式",
            "/clear - 提示如何开启干净会话",
            "/cost - 查看 GUI 可见的用量状态",
            "/memory - 查看当前项目 CLAUDE.md 状态",
            "/config - 查看当前配置入口",
            "/resume <session-id> - 切换当前 Mia 会话绑定的外部 session",
            "/rewind - 提示如何回退对话",
            "Claude Code 自定义命令会从 .claude/commands 和 ~/.claude/commands 扫描。",
        ]
        .join("\n"),
        _ => return Err("Unknown built-in command.".to_owned()),
    };

    Ok(AgentCommandExecuteResponse {
        kind: "builtin".to_owned(),
        command: parsed.command.clone(),
        content,
        command_result: None,
        metadata: None,
        has_file_includes: None,
        has_bash_commands: None,
    })
}

fn run_resume_command(
    _states: &ModuleStates,
    context: &CommandRuntimeContext,
    engine: &str,
    parsed: &ParsedCommand,
    request_context: &Value,
) -> Result<AgentCommandExecuteResponse, String> {
    let bot = request_context.get("bot").unwrap_or(&Value::Null);
    let bot_key = string_value(bot, &["key", "id"]).unwrap_or_else(|| "mia".to_owned());
    let session_id = string_value(request_context, &["sessionId", "session_id"])
        .unwrap_or_else(|| "default".to_owned());
    let current = get_agent_session_id(context, engine, &bot_key, &session_id).unwrap_or_default();
    let next = parsed.args.first().map(String::as_str).unwrap_or_default();

    if next.is_empty() {
        let bound = list_bound_external_agent_sessions(context, engine, bot, 10)
            .into_iter()
            .filter(|row| row.id != current)
            .collect::<Vec<_>>();
        let raw = if bound.is_empty() {
            list_external_agent_sessions(engine, &context.home_dir, 30)
                .into_iter()
                .filter(useful_external_session_row)
                .filter(|row| row.id != current)
                .take(10)
                .collect::<Vec<_>>()
        } else {
            bound.into_iter().take(10).collect()
        };
        if raw.is_empty() {
            return Ok(AgentCommandExecuteResponse {
                kind: "builtin".to_owned(),
                command: "/resume".to_owned(),
                content: [
                    format!("当前绑定的外部会话：{}", current.if_empty("尚未创建")),
                    "没有找到可恢复的本地外部会话。".to_owned(),
                    "用法：/resume <session-id>".to_owned(),
                ]
                .join("\n"),
                command_result: None,
                metadata: None,
                has_file_includes: None,
                has_bash_commands: None,
            });
        }
        let rows = raw
            .into_iter()
            .map(|row| {
                json!({
                    "id": row.id,
                    "title": row.title,
                    "preview": row.preview,
                    "project": row.project,
                    "updatedAt": row.updated_at
                })
            })
            .collect::<Vec<_>>();
        return Ok(AgentCommandExecuteResponse {
            kind: "builtin".to_owned(),
            command: "/resume".to_owned(),
            content: format!(
                "当前绑定的外部会话：{}\n选择一个会话继续：",
                current.if_empty("尚未创建")
            ),
            command_result: Some(json!({
                "type": "session-list",
                "command": "/resume",
                "engine": engine,
                "sourceDeviceId": string_value(request_context, &["sourceDeviceId", "source_device_id"]).unwrap_or_default(),
                "rows": rows
            })),
            metadata: None,
            has_file_includes: None,
            has_bash_commands: None,
        });
    }

    if !looks_like_uuid(next) {
        return Ok(AgentCommandExecuteResponse {
            kind: "builtin".to_owned(),
            command: "/resume".to_owned(),
            content: "session-id 看起来不是有效 UUID。用法：/resume <session-id>".to_owned(),
            command_result: None,
            metadata: None,
            has_file_includes: None,
            has_bash_commands: None,
        });
    }

    set_agent_session_id(context, engine, &bot_key, &session_id, next)?;
    Ok(AgentCommandExecuteResponse {
        kind: "builtin".to_owned(),
        command: "/resume".to_owned(),
        content: format!(
            "已把当前 Mia 会话绑定到外部 session：{next}\n下一条消息会从这个 session 继续。"
        ),
        command_result: None,
        metadata: None,
        has_file_includes: None,
        has_bash_commands: None,
    })
}

#[derive(Debug, Clone)]
struct LocalEngineInfo {
    path: Option<String>,
    version: Option<String>,
}

async fn local_engine_info(engine: &str) -> LocalEngineInfo {
    let command = match engine {
        "claude-code" => "claude",
        "codex" => "codex",
        _ => "",
    };
    if command.is_empty() {
        return LocalEngineInfo {
            path: None,
            version: None,
        };
    }
    let path = find_on_path(command);
    let version = if let Some(path) = path.as_deref() {
        command_version(path).await
    } else {
        None
    };
    LocalEngineInfo { path, version }
}

async fn command_version(command_path: &str) -> Option<String> {
    let output = timeout(
        Duration::from_secs(3),
        Command::new(command_path).arg("--version").output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if text.is_empty() { None } else { Some(text) }
}

fn find_on_path(command: &str) -> Option<String> {
    let paths = env::var_os("PATH")?;
    for dir in env::split_paths(&paths) {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

fn engine_permission_mode(context: &CommandRuntimeContext, engine: &str) -> String {
    let path = context.data_dir.join("mia-permissions.json");
    let parsed = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}));
    if engine == "hermes" {
        string_value(&parsed, &["mode"]).unwrap_or_else(|| "ask".to_owned())
    } else {
        parsed
            .get("engines")
            .and_then(|engines| string_value(engines, &[engine]))
            .unwrap_or_else(|| "default".to_owned())
    }
}

fn get_agent_session_id(
    context: &CommandRuntimeContext,
    engine: &str,
    bot_key: &str,
    session_id: &str,
) -> Option<String> {
    let map = load_agent_session_map(context);
    let key = session_key(engine, bot_key, session_id, &context.project_path);
    let value = map.get(&key)?;
    if let Some(id) = value.as_str() {
        return Some(id.trim().to_owned()).filter(|item| !item.is_empty());
    }
    value
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_owned)
        .filter(|item| !item.is_empty())
}

fn set_agent_session_id(
    context: &CommandRuntimeContext,
    engine: &str,
    bot_key: &str,
    session_id: &str,
    external_session_id: &str,
) -> Result<(), String> {
    let mut map = load_agent_session_map(context);
    map.insert(
        session_key(engine, bot_key, session_id, &context.project_path),
        Value::String(external_session_id.to_owned()),
    );
    save_agent_session_map(context, &map)
}

fn load_agent_session_map(context: &CommandRuntimeContext) -> BTreeMap<String, Value> {
    std::fs::read_to_string(agent_sessions_path(context))
        .ok()
        .and_then(|raw| serde_json::from_str::<BTreeMap<String, Value>>(&raw).ok())
        .unwrap_or_default()
}

fn save_agent_session_map(
    context: &CommandRuntimeContext,
    map: &BTreeMap<String, Value>,
) -> Result<(), String> {
    let path = agent_sessions_path(context);
    std::fs::create_dir_all(path.parent().unwrap_or(&context.data_dir))
        .map_err(|error| error.to_string())?;
    let raw = serde_json::to_string_pretty(map).map_err(|error| error.to_string())? + "\n";
    std::fs::write(path, raw).map_err(|error| error.to_string())
}

fn agent_sessions_path(context: &CommandRuntimeContext) -> PathBuf {
    context.data_dir.join("mia-agent-sessions.json")
}

fn session_key(engine: &str, bot_key: &str, session_id: &str, workspace_path: &Path) -> String {
    let mut parts = vec![
        normalize_engine(engine),
        bot_key.if_empty("mia").to_owned(),
        session_id.if_empty("default").to_owned(),
    ];
    let workspace = workspace_key(workspace_path);
    if !workspace.is_empty() {
        parts.push("workspace".to_owned());
        parts.push(workspace);
    }
    parts.join(":")
}

fn workspace_key(path: &Path) -> String {
    let text = absolutize_path(path.to_path_buf())
        .to_string_lossy()
        .to_string();
    if text.trim().is_empty() {
        return String::new();
    }
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        .chars()
        .take(16)
        .collect()
}

fn list_bound_external_agent_sessions(
    context: &CommandRuntimeContext,
    engine: &str,
    bot: &Value,
    limit: usize,
) -> Vec<ExternalSessionRow> {
    let bot_key = string_value(bot, &["key", "id"]).unwrap_or_default();
    if bot_key.is_empty() {
        return Vec::new();
    }
    let prefix = format!("{engine}:{bot_key}:");
    let metadata = list_external_agent_sessions(engine, &context.home_dir, 160)
        .into_iter()
        .map(|row| (row.id.clone(), row))
        .collect::<BTreeMap<_, _>>();
    let mut rows_by_external_id = BTreeMap::<String, ExternalSessionRow>::new();
    for (key, entry) in load_agent_session_map(context) {
        if !key.starts_with(&prefix) {
            continue;
        }
        let local_conversation_id = key[prefix.len()..].to_owned();
        let external_id = agent_session_entry_id(&entry);
        if external_id.is_empty() || rows_by_external_id.contains_key(&external_id) {
            continue;
        }
        let Some((title, preview)) =
            mia_conversation_title_for_agent_binding(&local_conversation_id, bot)
        else {
            continue;
        };
        let external = metadata.get(&external_id);
        rows_by_external_id.insert(
            external_id.clone(),
            ExternalSessionRow {
                id: external_id,
                title,
                preview: [
                    preview,
                    external.map(|row| row.project.clone()).unwrap_or_default(),
                ]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join(" · "),
                project: external.map(|row| row.project.clone()).unwrap_or_default(),
                updated_at: external.map(|row| row.updated_at).unwrap_or(0),
            },
        );
    }
    let mut rows = rows_by_external_id.into_values().collect::<Vec<_>>();
    rows.sort_by_key(|row| Reverse(row.updated_at));
    rows.truncate(limit);
    rows
}

fn agent_session_entry_id(entry: &Value) -> String {
    if let Some(text) = entry.as_str() {
        return text.trim().to_owned();
    }
    entry
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned()
}

fn mia_conversation_title_for_agent_binding(
    local_conversation_id: &str,
    bot: &Value,
) -> Option<(String, String)> {
    let id = local_conversation_id.trim();
    if id.is_empty()
        || id.starts_with("title:")
        || id.starts_with("utility:")
        || id.starts_with("group:")
    {
        return None;
    }
    let bot_key = string_value(bot, &["key", "id"]).unwrap_or_default();
    let bot_name = string_value(bot, &["name", "displayName", "display_name"])
        .unwrap_or_else(|| bot_key.if_empty("当前 Bot").to_owned());
    let title = if id.starts_with("bot:") {
        "Mia 云端对话"
    } else {
        "Mia 对话"
    };
    Some((title.to_owned(), format!("{bot_name} 的 Mia 对话")))
}

fn list_external_agent_sessions(
    engine: &str,
    home_dir: &Path,
    limit: usize,
) -> Vec<ExternalSessionRow> {
    match engine {
        "claude-code" => list_claude_sessions(home_dir, limit),
        "codex" => list_codex_sessions(home_dir, limit),
        _ => Vec::new(),
    }
}

fn list_claude_sessions(home_dir: &Path, limit: usize) -> Vec<ExternalSessionRow> {
    let mut rows = newest_files(&home_dir.join(".claude").join("projects"), "jsonl", 120)
        .into_iter()
        .filter_map(|file_path| {
            let id = file_path.file_stem()?.to_string_lossy().to_string();
            if !looks_like_uuid(&id) {
                return None;
            }
            let tail = read_jsonl_tail(&file_path, 40);
            let prompt = tail.iter().rev().find_map(|item| {
                item.get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_str)
            });
            let title = truncate_text(prompt.unwrap_or(&id), 80);
            Some(ExternalSessionRow {
                id,
                title,
                preview: truncate_text(prompt.unwrap_or_default(), 120),
                project: String::new(),
                updated_at: file_mtime_ms(&file_path),
            })
        })
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| Reverse(row.updated_at));
    rows.truncate(limit);
    rows
}

fn list_codex_sessions(home_dir: &Path, limit: usize) -> Vec<ExternalSessionRow> {
    let index = load_codex_index(home_dir);
    let mut rows = newest_files(&home_dir.join(".codex").join("sessions"), "jsonl", 120)
        .into_iter()
        .filter_map(|file_path| {
            let entries = {
                let mut values = read_jsonl_head(&file_path, 20);
                values.extend(read_jsonl_tail(&file_path, 80));
                values
            };
            let meta = entries
                .iter()
                .find(|item| item.get("type").and_then(Value::as_str) == Some("session_meta"))
                .and_then(|item| item.get("payload"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            let turn_context = entries
                .iter()
                .find(|item| item.get("type").and_then(Value::as_str) == Some("turn_context"))
                .and_then(|item| item.get("payload"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            let id = string_value(&meta, &["id"])
                .or_else(|| uuid_from_text(&file_path.to_string_lossy()))
                .unwrap_or_default();
            if !looks_like_uuid(&id) {
                return None;
            }
            let user_text = entries
                .iter()
                .rev()
                .find_map(codex_user_text)
                .unwrap_or_default();
            let indexed = index.get(&id);
            Some(ExternalSessionRow {
                id: id.clone(),
                title: indexed
                    .map(|row| row.title.clone())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| truncate_text(user_text.if_empty(&id), 80)),
                preview: truncate_text(&user_text, 120),
                project: string_value(&meta, &["cwd"])
                    .or_else(|| string_value(&turn_context, &["cwd"]))
                    .unwrap_or_default(),
                updated_at: indexed
                    .map(|row| row.updated_at)
                    .unwrap_or_else(|| file_mtime_ms(&file_path)),
            })
        })
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| Reverse(row.updated_at));
    rows.truncate(limit);
    rows
}

fn load_codex_index(home_dir: &Path) -> BTreeMap<String, ExternalSessionRow> {
    read_jsonl_tail(&home_dir.join(".codex").join("session_index.jsonl"), 5000)
        .into_iter()
        .filter_map(|item| {
            let id = string_value(&item, &["id"])?;
            Some((
                id.clone(),
                ExternalSessionRow {
                    id,
                    title: string_value(&item, &["thread_name"]).unwrap_or_default(),
                    preview: String::new(),
                    project: String::new(),
                    updated_at: parse_timestamp_ms(item.get("updated_at")),
                },
            ))
        })
        .collect()
}

fn codex_user_text(item: &Value) -> Option<String> {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    let payload = item.get("payload").unwrap_or(&Value::Null);
    if item_type == "event_msg"
        && payload.get("type").and_then(Value::as_str) == Some("user_message")
    {
        return string_value(payload, &["message"]);
    }
    if item_type == "user_message"
        || payload.get("type").and_then(Value::as_str) == Some("user_message")
    {
        return string_value(payload, &["message"])
            .or_else(|| string_value(item, &["message", "text"]));
    }
    if item_type == "response_item"
        && payload.get("type").and_then(Value::as_str) == Some("message")
        && payload.get("role").and_then(Value::as_str) == Some("user")
        && let Some(content) = payload.get("content").and_then(Value::as_array)
    {
        let text = content
            .iter()
            .filter_map(|part| string_value(part, &["text"]))
            .collect::<Vec<_>>()
            .join(" ");
        return Some(text).filter(|value| !value.trim().is_empty());
    }
    None
}

fn useful_external_session_row(row: &ExternalSessionRow) -> bool {
    let text = format!("{}\n{}", row.title, row.preview);
    if row.title.is_empty() && row.preview.is_empty() {
        return false;
    }
    if looks_like_uuid(&row.title) && row.preview.is_empty() {
        return false;
    }
    if text.contains("<command-name>")
        || text.contains("<command-message>")
        || text.contains("<command-args>")
    {
        return false;
    }
    !matches!(
        row.title.split_whitespace().next().unwrap_or_default(),
        "/goal" | "/clear" | "/usage" | "/context" | "/compact" | "/resume" | "/export"
    )
}

fn newest_files(root: &Path, extension: &str, limit: usize) -> Vec<PathBuf> {
    let mut files = Vec::<(PathBuf, u64)>::new();
    collect_files(root, extension, &mut files);
    files.sort_by_key(|(_, mtime)| Reverse(*mtime));
    files.truncate(limit);
    files.into_iter().map(|(path, _)| path).collect()
}

fn collect_files(root: &Path, extension: &str, files: &mut Vec<(PathBuf, u64)>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_files(&path, extension, files);
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
        {
            files.push((path.clone(), file_mtime_ms(&path)));
        }
    }
}

fn read_jsonl_tail(path: &Path, max_lines: usize) -> Vec<Value> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let lines = raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    lines
        .into_iter()
        .rev()
        .take(max_lines)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn read_jsonl_head(path: &Path, max_lines: usize) -> Vec<Value> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .take(max_lines)
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn file_mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_timestamp_ms(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(number)) => number.as_u64().unwrap_or(0),
        _ => 0,
    }
}

fn truncate_text(value: &str, max: usize) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        return text;
    }
    text.chars().take(max.saturating_sub(3)).collect::<String>() + "..."
}

fn uuid_from_text(value: &str) -> Option<String> {
    value
        .split(|ch: char| !(ch.is_ascii_hexdigit() || ch == '-'))
        .find(|part| looks_like_uuid(part))
        .map(str::to_owned)
}

fn looks_like_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        match index {
            8 | 13 | 18 | 23 => {
                if *byte != b'-' {
                    return false;
                }
            }
            _ => {
                if !byte.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    matches!(bytes[19], b'8' | b'9' | b'a' | b'A' | b'b' | b'B')
}

fn string_value(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
}

fn normalize_engine(engine: &str) -> String {
    match engine.trim() {
        "claude" | "claude_code" | "claude-code" => "claude-code".to_owned(),
        "openai-codex" | "codex-cli" | "codex" => "codex".to_owned(),
        other => other.to_owned(),
    }
}

fn local_engine_label(engine: &str) -> &'static str {
    match engine {
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        _ => "本地 Agent",
    }
}

fn default_model_label(engine: &str) -> String {
    format!("{} 默认模型", local_engine_label(engine))
}

fn is_child_path(parent_path: &Path, target_path: &Path) -> bool {
    let parent = absolutize_path(parent_path.to_path_buf());
    let target = absolutize_path(target_path.to_path_buf());
    target.starts_with(&parent) && target != parent
}

fn absolutize_path(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn home_dir_from_env() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn bad_request(message: impl ToString) -> (StatusCode, Json<Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": message.to_string() })),
    )
}

trait EmptyStringExt {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str;
}

impl EmptyStringExt for str {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str {
        if self.is_empty() { fallback } else { self }
    }
}

impl EmptyStringExt for String {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str {
        self.as_str().if_empty(fallback)
    }
}
