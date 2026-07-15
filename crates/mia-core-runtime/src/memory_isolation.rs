use std::collections::BTreeMap;

use mia_core_api_types::MemoryMode;
use serde_json::Value;

use crate::RuntimeTurnPlan;

const CLAUDE_DISABLE_AUTO_MEMORY: &str = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";

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
        _ => {}
    }
}

pub async fn preflight_memory_isolation(_plan: &RuntimeTurnPlan) -> anyhow::Result<()> {
    // Hermes ACP does not have a stable native-memory-disable flag. Hermes plans are
    // downgraded to `MemoryMode::Native` at the conversation boundary, so no probe or
    // command mutation is needed here.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RuntimeCommand, RuntimeProtocol, RuntimeSendMessage, RuntimeSessionState};
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
    fn claude_memory_isolation_is_mia_only_and_never_mutates_hermes() {
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
        assert_eq!(hermes.command.unwrap().args, vec!["acp".to_string()]);
    }
}
