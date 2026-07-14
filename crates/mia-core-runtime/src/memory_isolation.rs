use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, bail};
use mia_core_api_types::MemoryMode;
use serde_json::Value;
use tokio::process::Command;
use tokio::time::timeout;

use crate::{RuntimeCommand, RuntimeTurnPlan};

const CLAUDE_DISABLE_AUTO_MEMORY: &str = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";
const HERMES_SKIP_MEMORY_ARG: &str = "--skip-memory";
const HERMES_HELP_TIMEOUT: Duration = Duration::from_secs(3);

pub fn apply_memory_isolation_to_plan(plan: &mut RuntimeTurnPlan) {
    if plan.memory_mode != MemoryMode::Mia {
        return;
    }
    match plan.engine.as_str() {
        "codex" => apply_codex_memory_isolation(&mut plan.environment),
        "claude-code" => {
            plan.environment
                .insert(CLAUDE_DISABLE_AUTO_MEMORY.into(), "1".into());
        }
        "hermes" => {
            if let Some(command) = plan.command.as_mut()
                && !command.args.iter().any(|arg| arg == HERMES_SKIP_MEMORY_ARG)
            {
                command.args.push(HERMES_SKIP_MEMORY_ARG.into());
            }
        }
        _ => {}
    }
}

pub async fn preflight_memory_isolation(plan: &RuntimeTurnPlan) -> anyhow::Result<()> {
    if plan.memory_mode != MemoryMode::Mia || plan.engine != "hermes" {
        return Ok(());
    }
    let Some(command) = plan.command.as_ref() else {
        bail!("Hermes Mia memory mode requires a native ACP command");
    };
    let help = hermes_acp_help(command, &plan.environment).await?;
    if !hermes_help_supports_skip_memory(&help) {
        bail!(
            "Hermes 当前版本不支持 Mia 记忆隔离（缺少 `hermes acp {HERMES_SKIP_MEMORY_ARG}`）。请关闭 Mia 记忆或升级 Hermes。"
        );
    }
    Ok(())
}

fn apply_codex_memory_isolation(environment: &mut BTreeMap<String, String>) {
    let mut config = environment
        .get("CODEX_CONFIG")
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut memories = config
        .remove("memories")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    memories.insert("use_memories".into(), Value::Bool(false));
    memories.insert("generate_memories".into(), Value::Bool(false));
    config.insert("memories".into(), Value::Object(memories));
    environment.insert("CODEX_CONFIG".into(), Value::Object(config).to_string());
}

async fn hermes_acp_help(
    command: &RuntimeCommand,
    environment: &BTreeMap<String, String>,
) -> anyhow::Result<String> {
    let args = hermes_help_args(command);
    let mut child = Command::new(&command.program);
    child
        .args(args)
        .env_clear()
        .envs(environment.iter())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = timeout(HERMES_HELP_TIMEOUT, child.output())
        .await
        .context("probe Hermes ACP help timed out")?
        .with_context(|| format!("probe Hermes ACP help via `{}`", command.program))?;
    Ok(format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
}

fn hermes_help_args(command: &RuntimeCommand) -> Vec<String> {
    let mut args = command
        .args
        .iter()
        .filter(|arg| arg.as_str() != HERMES_SKIP_MEMORY_ARG)
        .filter(|arg| arg.as_str() != "--help" && arg.as_str() != "-h")
        .cloned()
        .collect::<Vec<_>>();
    if !args.iter().any(|arg| arg == "acp") {
        args.insert(0, "acp".into());
    }
    args.push("--help".into());
    args
}

fn hermes_help_supports_skip_memory(help: &str) -> bool {
    help.split_whitespace()
        .any(|token| token.trim_matches(',') == HERMES_SKIP_MEMORY_ARG)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RuntimeProtocol, RuntimeSendMessage, RuntimeSessionState};
    use serde_json::json;

    fn test_plan(engine: &str, memory_mode: MemoryMode) -> RuntimeTurnPlan {
        RuntimeTurnPlan {
            turn_id: "turn_test".into(),
            conversation_id: "conv_test".into(),
            bot_id: Some("bot_test".into()),
            memory_mode,
            engine: engine.into(),
            workspace_dir: ".".into(),
            protocol: RuntimeProtocol::NativeAcp,
            command: Some(RuntimeCommand {
                program: engine.into(),
                args: vec!["acp".into()],
            }),
            environment: BTreeMap::new(),
            provider: json!({}),
            mcp_servers: json!({}),
            selected_skill_ids: Vec::new(),
            runtime_session: RuntimeSessionState {
                conversation_id: "conv_test".into(),
                engine: engine.into(),
                session_key: format!("{engine}:conv_test"),
                resume_session_key: None,
                resumed: false,
            },
            send_message: RuntimeSendMessage {
                content: "hello".into(),
                msg_id: "msg_test".into(),
                turn_id: Some("turn_test".into()),
                files: Vec::new(),
                inject_skills: Vec::new(),
            },
            mock_response: None,
        }
    }

    #[test]
    fn codex_memory_isolation_deep_merges_existing_config() {
        let mut plan = test_plan("codex", MemoryMode::Mia);
        plan.environment.insert(
            "CODEX_CONFIG".into(),
            json!({
                "model_provider": "mia",
                "memories": {
                    "use_memories": true,
                    "other": "kept"
                }
            })
            .to_string(),
        );

        apply_memory_isolation_to_plan(&mut plan);

        let config: Value =
            serde_json::from_str(plan.environment["CODEX_CONFIG"].as_str()).unwrap();
        assert_eq!(config["model_provider"], "mia");
        assert_eq!(config["memories"]["other"], "kept");
        assert_eq!(config["memories"]["use_memories"], false);
        assert_eq!(config["memories"]["generate_memories"], false);
    }

    #[test]
    fn claude_and_hermes_memory_isolation_are_mia_only() {
        let mut native = test_plan("claude-code", MemoryMode::Native);
        apply_memory_isolation_to_plan(&mut native);
        assert!(!native.environment.contains_key(CLAUDE_DISABLE_AUTO_MEMORY));

        let mut claude = test_plan("claude-code", MemoryMode::Mia);
        apply_memory_isolation_to_plan(&mut claude);
        assert_eq!(
            claude
                .environment
                .get(CLAUDE_DISABLE_AUTO_MEMORY)
                .map(String::as_str),
            Some("1")
        );

        let mut hermes = test_plan("hermes", MemoryMode::Mia);
        apply_memory_isolation_to_plan(&mut hermes);
        assert_eq!(
            hermes.command.unwrap().args,
            vec!["acp".to_string(), HERMES_SKIP_MEMORY_ARG.to_string()]
        );
    }

    #[test]
    fn hermes_help_probe_ignores_runtime_skip_arg_and_checks_explicit_support() {
        let command = RuntimeCommand {
            program: "hermes".into(),
            args: vec!["acp".into(), HERMES_SKIP_MEMORY_ARG.into()],
        };
        assert_eq!(hermes_help_args(&command), vec!["acp", "--help"]);
        assert!(hermes_help_supports_skip_memory(
            "Usage: hermes acp [OPTIONS]\n      --skip-memory"
        ));
        assert!(!hermes_help_supports_skip_memory(
            "Usage: hermes acp [OPTIONS]\n      --skip-cache"
        ));
    }
}
