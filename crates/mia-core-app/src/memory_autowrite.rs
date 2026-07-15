#[cfg(test)]
use mia_core_api_types::MiaMemoryTarget;
use mia_core_api_types::{MemoryMode, MiaMemoryAction, MiaMemoryToolRequest};
use mia_core_memory::{BoundedMemoryService, validate_memory_write};
use mia_core_runtime::RuntimeTurnPlan;
use mia_core_system::SystemService;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplicitMemoryAutoWrite {
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedMemoryAutoWrite {
    pub content: String,
}

pub fn detect_explicit_memory_autowrite(body: &str) -> Option<ExplicitMemoryAutoWrite> {
    let content = clean_memory_request_text(body)?;
    let lower = content.to_lowercase();
    let triggered = lower.contains("remember persistently")
        || lower.starts_with("please remember ")
        || lower.starts_with("remember that ")
        || lower.starts_with("remember:")
        || lower.starts_with("remember ")
        || content.contains("请记住")
        || content.contains("帮我记住")
        || content.contains("记住：")
        || content.contains("记住:")
        || content.contains("更新记忆")
        || content.contains("记忆更新");
    if !triggered || looks_like_memory_question(&content) {
        return None;
    }
    let content = strip_memory_request_prefix(&content);
    if content.is_empty() || validate_memory_write(&content).is_err() {
        return None;
    }
    Some(ExplicitMemoryAutoWrite { content })
}

pub async fn apply_explicit_memory_autowrite(
    system: &SystemService,
    memory: &BoundedMemoryService,
    plan: &RuntimeTurnPlan,
    user_body: &str,
) -> anyhow::Result<Option<AppliedMemoryAutoWrite>> {
    let user_id = current_user_id(system).await?;
    apply_explicit_memory_autowrite_for_owner(memory, plan, &user_id, user_body).await
}

pub async fn apply_explicit_memory_autowrite_for_owner(
    memory: &BoundedMemoryService,
    plan: &RuntimeTurnPlan,
    user_id: &str,
    user_body: &str,
) -> anyhow::Result<Option<AppliedMemoryAutoWrite>> {
    if plan.memory_mode != MemoryMode::Mia {
        return Ok(None);
    }
    let Some(bot_id) = plan
        .bot_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let Some(detected) = detect_explicit_memory_autowrite(user_body) else {
        return Ok(None);
    };
    let response = memory
        .mutate(
            user_id,
            bot_id,
            MiaMemoryToolRequest {
                context: json!({
                    "conversationId": plan.conversation_id,
                    "botId": bot_id,
                    "origin": "mia-explicit-autowrite",
                }),
                action: MiaMemoryAction::Add,
                old_text: None,
                content: Some(detected.content.clone()),
            },
        )
        .await?;
    if !response.success {
        tracing::warn!(
            conversation_id = %plan.conversation_id,
            bot_id,
            error = ?response.error,
            "[MemoryAutoWrite] explicit memory request was not stored"
        );
        return Ok(None);
    }
    Ok(Some(AppliedMemoryAutoWrite {
        content: detected.content,
    }))
}

pub fn prepend_memory_autowrite_notice(
    user_body: &str,
    applied: &AppliedMemoryAutoWrite,
) -> String {
    format!(
        "<mia_memory_write_result>\n\
Mia has already persisted this explicit memory request to the bounded Mia memory document.\n\
Do not call another memory tool and do not write workspace files for this memory request.\n\
Persisted memory: {}\n\
</mia_memory_write_result>\n\n{}",
        applied.content, user_body
    )
}

async fn current_user_id(system: &SystemService) -> anyhow::Result<String> {
    let settings = system.client_settings().await?.settings;
    Ok(first_string(&settings, &["userId", "user_id"]).unwrap_or_else(|| "local".to_string()))
}

fn clean_memory_request_text(body: &str) -> Option<String> {
    let cleaned = body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn strip_memory_request_prefix(value: &str) -> String {
    let mut out = value.trim().to_string();
    for prefix in [
        "Please remember persistently:",
        "please remember persistently:",
        "Please remember:",
        "please remember:",
        "Remember that",
        "remember that",
        "Remember:",
        "remember:",
        "Remember",
        "remember",
        "请记住：",
        "请记住:",
        "请记住",
        "帮我记住：",
        "帮我记住:",
        "帮我记住",
        "记住：",
        "记住:",
    ] {
        if let Some(rest) = out.strip_prefix(prefix) {
            out = rest.trim().to_string();
            break;
        }
    }
    out
}

fn looks_like_memory_question(value: &str) -> bool {
    let lower = value.to_lowercase();
    lower.ends_with('?')
        || value.ends_with('？')
        || lower.starts_with("do you remember")
        || lower.starts_with("what do you remember")
        || value.starts_with("你还记得")
        || value.starts_with("你记得")
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mia_core_api_types::MemoryMode;
    use mia_core_db::init_database_memory;
    use mia_core_memory::BoundedMemoryService;
    use mia_core_runtime::{RuntimeBuilder, RuntimeTurnInput};

    #[test]
    fn detects_explicit_english_memory_request() {
        let detected = detect_explicit_memory_autowrite(
            "Please remember persistently: the Mia memory acceptance code is BIRCH822.",
        )
        .expect("detect memory request");

        assert_eq!(
            detected.content,
            "the Mia memory acceptance code is BIRCH822."
        );
    }

    #[test]
    fn ignores_memory_questions() {
        assert!(detect_explicit_memory_autowrite("Do you remember my code?").is_none());
    }

    #[tokio::test]
    async fn applies_explicit_memory_request_to_mia_mode_document() {
        let database = init_database_memory().await.unwrap();
        let memory = BoundedMemoryService::new(database.pool().clone());
        let plan = test_plan(MemoryMode::Mia);

        let applied = apply_explicit_memory_autowrite_for_owner(
            &memory,
            &plan,
            "local",
            "Please remember persistently: Mia acceptance code is BIRCH822.",
        )
        .await
        .unwrap()
        .expect("applied");
        let document = memory
            .document("local", "bot_1", MiaMemoryTarget::Memory)
            .await
            .unwrap();

        assert_eq!(applied.content, "Mia acceptance code is BIRCH822.");
        assert_eq!(document.text, "Mia acceptance code is BIRCH822.");
    }

    #[tokio::test]
    async fn native_mode_does_not_autowrite_memory() {
        let database = init_database_memory().await.unwrap();
        let memory = BoundedMemoryService::new(database.pool().clone());
        let plan = test_plan(MemoryMode::Native);

        let applied = apply_explicit_memory_autowrite_for_owner(
            &memory,
            &plan,
            "local",
            "Please remember persistently: Mia acceptance code is BIRCH822.",
        )
        .await
        .unwrap();
        let document = memory
            .document("local", "bot_1", MiaMemoryTarget::Memory)
            .await
            .unwrap();

        assert!(applied.is_none());
        assert!(document.text.is_empty());
    }

    fn test_plan(memory_mode: MemoryMode) -> RuntimeTurnPlan {
        RuntimeBuilder::new("/tmp/mia-memory-autowrite").build_turn_plan(RuntimeTurnInput {
            conversation_id: "conv_1".to_string(),
            message_id: "msg_1".to_string(),
            bot_id: Some("bot_1".to_string()),
            memory_mode,
            engine: Some("mock".to_string()),
            previous_session_key: None,
            workspace_dir: "/tmp/mia-memory-autowrite".to_string(),
            provider: json!({}),
            mcp_servers: json!({}),
            attachments: json!([]),
            selected_skill_ids: Vec::new(),
            body: "hello".to_string(),
        })
    }
}
