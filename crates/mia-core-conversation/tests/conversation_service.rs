use mia_core_api_types::{
    AgentSessionSkillRecord, AgentSessionSkillRuntimeRequest, BotSummary, ConversationSummary,
    CreateConversationRequest, MemoryMode, RunConversationUtilityTurnRequest,
    SendConversationMessageRequest, SkillMaterializationRecord, SkillMaterializationRequest,
};
use mia_core_conversation::{
    ConversationService, CurrentSkillService, conversation_memory_mode, materialize_turn_skills,
    plan_agent_session_skill_runtime, with_memory_mode,
};
use mia_core_db::init_database_memory;
use serde_json::json;
use sqlx::Row;
use std::fs;

#[test]
fn memory_mode_metadata_normalizes_only_missing_or_invalid_values() {
    let native = with_memory_mode(
        json!({ "memoryMode": "native", "workspaceDir": "/tmp/workspace" }),
        MemoryMode::Mia,
    );
    assert_eq!(native["memoryMode"], "native");
    assert_eq!(native["workspaceDir"], "/tmp/workspace");

    let repaired = with_memory_mode(
        json!({ "memoryMode": "invalid", "runtimeSession": { "sessionKey": "session_1" } }),
        MemoryMode::Native,
    );
    assert_eq!(repaired["memoryMode"], "native");
    assert_eq!(repaired["runtimeSession"]["sessionKey"], "session_1");

    let legacy = ConversationSummary {
        id: "conv_legacy".into(),
        kind: "direct".into(),
        title: "Legacy".into(),
        bot_id: None,
        metadata: json!({}),
    };
    assert_eq!(conversation_memory_mode(&legacy), MemoryMode::Mia);
}

#[tokio::test]
async fn hermes_turn_plan_falls_back_to_native_memory_without_changing_conversation_metadata() {
    let db = init_database_memory().await.unwrap();
    let service =
        ConversationService::new(db.pool().clone()).with_core_base_url("http://127.0.0.1:27861");
    let created = service
        .create_conversation(CreateConversationRequest {
            kind: "direct".to_string(),
            title: "Hermes".to_string(),
            bot_id: None,
            metadata: json!({
                "memoryMode": "mia",
                "runtime": { "engine": "hermes" }
            }),
        })
        .await
        .unwrap();

    let accepted = service
        .start_user_turn(
            &created.conversation.id,
            SendConversationMessageRequest {
                body: "hello".to_string(),
                attachments: json!([]),
                selected_skill_ids: vec![],
            },
        )
        .await
        .unwrap();

    assert_eq!(
        conversation_memory_mode(&created.conversation),
        MemoryMode::Mia
    );
    assert_eq!(accepted.runtime_plan.engine, "hermes");
    assert_eq!(accepted.runtime_plan.memory_mode, MemoryMode::Native);
    assert_eq!(
        accepted.runtime_plan.mcp_servers["mcpServers"]["mia-app"]["env"]["MIA_MEMORY_MODE"],
        "native"
    );
}

#[test]
fn current_skill_service_lists_and_reads_enabled_bot_skills_from_core_paths() {
    let temp = tempfile::tempdir().unwrap();
    let private_skill_dir = temp.path().join("data").join("skills").join("demo-skill");
    let official_skill_dir = temp.path().join("official").join("mia-scheduler");
    let officecli_skill_dir = temp.path().join("official").join("officecli");
    fs::create_dir_all(&private_skill_dir).unwrap();
    fs::create_dir_all(&official_skill_dir).unwrap();
    fs::create_dir_all(&officecli_skill_dir).unwrap();
    fs::write(
        private_skill_dir.join("SKILL.md"),
        "---\nname: demo-skill\ndescription: A demo.\n---\n# Demo Skill\nUse it.",
    )
    .unwrap();
    fs::write(
        officecli_skill_dir.join("SKILL.md"),
        "---\nname: officecli\ndescription: Office files.\n---\n# OfficeCLI\nUse the real binary.",
    )
    .unwrap();
    fs::write(
        official_skill_dir.join("SKILL.md"),
        "---\nname: mia-scheduler\ndescription: Scheduled tasks.\n---\n# Scheduler\nUse schedule_create.",
    )
    .unwrap();

    let service = CurrentSkillService::with_official_roots(
        temp.path().join("data"),
        vec![temp.path().join("official")],
    );
    let bot = BotSummary {
        id: "bot_1".into(),
        display_name: "Bot".into(),
        identity: json!({}),
        capabilities: json!({
            "enabledSkills": ["demo-skill", "mia-official:mia-scheduler", "missing"],
            "disabledSkills": ["missing"]
        }),
    };

    let listed = service.list_current_bot_skills("bot_1", Some(&bot));
    assert_eq!(listed.bot_id, "bot_1");
    assert_eq!(listed.skills.len(), 3);
    assert_eq!(listed.skills[0].id, "mia-scheduler");
    assert_eq!(listed.skills[1].id, "mia-official:officecli");
    assert_eq!(listed.skills[2].id, "demo-skill");
    assert_eq!(listed.skills[2].name, "demo-skill");
    assert_eq!(listed.skills[2].description, "A demo.");

    let read_by_alias = service
        .read_current_bot_skill("bot_1", Some(&bot), "mia-scheduler")
        .unwrap();
    assert_eq!(read_by_alias.skill.id, "mia-scheduler");
    assert!(read_by_alias.skill.body.contains("schedule_create"));
    assert_eq!(
        read_by_alias.skill.body_chars,
        read_by_alias.skill.body.chars().count()
    );

    let missing = service
        .read_current_bot_skill("bot_1", Some(&bot), "missing")
        .unwrap_err();
    assert!(missing.to_string().contains("not enabled"));

    let plain_bot = BotSummary {
        id: "bot_plain".into(),
        display_name: "Plain Bot".into(),
        identity: json!({}),
        capabilities: json!({}),
    };
    let builtin = service.list_current_bot_skills("bot_plain", Some(&plain_bot));
    assert_eq!(builtin.skills.len(), 2);
    assert_eq!(builtin.skills[0].id, "mia-scheduler");
    assert_eq!(builtin.skills[1].id, "mia-official:officecli");
    assert!(
        service
            .read_current_bot_skill("bot_plain", Some(&plain_bot), "mia-scheduler")
            .is_ok()
    );
}

#[test]
fn current_skill_service_links_default_officecli_for_all_native_engines_without_prompt_body() {
    let temp = tempfile::tempdir().unwrap();
    let official = temp.path().join("official");
    for (directory, name, body) in [
        ("mia-scheduler", "mia-scheduler", "# Scheduler"),
        ("officecli", "officecli", "SECRET_OFFICECLI_BODY"),
    ] {
        let skill_dir = official.join(directory);
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Native skill.\n---\n{body}"),
        )
        .unwrap();
    }
    let service =
        CurrentSkillService::with_official_roots(temp.path().join("data"), vec![official]);
    let bot = BotSummary {
        id: "bot_default".into(),
        display_name: "Default Bot".into(),
        identity: json!({}),
        capabilities: json!({ "inheritEngineDefaults": true }),
    };
    let records = service.runtime_skill_records(Some(&bot), &[]).unwrap();
    assert_eq!(
        records
            .iter()
            .map(|record| record.id.as_str())
            .collect::<Vec<_>>(),
        vec!["mia-scheduler", "mia-official:officecli"]
    );

    for (engine, relative_dir) in [
        ("claude-code", ".claude/skills"),
        ("codex", ".codex/skills"),
        ("hermes", ".mia/hermes-skills"),
    ] {
        let workspace = temp.path().join(format!("workspace-{engine}"));
        let result = plan_agent_session_skill_runtime(AgentSessionSkillRuntimeRequest {
            agent_engine: engine.into(),
            runtime_config: json!({}),
            workspace_path: Some(workspace.to_string_lossy().to_string()),
            session_skill_ids: records.iter().map(|record| record.id.clone()).collect(),
            available_skills: records.clone(),
            active_skill_ids: vec![],
            intent_skill_ids: vec![],
            requested_skill_ids: vec![],
        });
        assert!(
            workspace
                .join(relative_dir)
                .join("officecli/SKILL.md")
                .exists()
        );
        assert_eq!(result.selected_skill_prompt, "");
        assert_eq!(result.initial_prompt_prefix, "");
        assert!(
            !result
                .selected_skill_prompt
                .contains("SECRET_OFFICECLI_BODY")
        );
        if engine == "hermes" {
            assert_eq!(
                result.skill_external_dirs,
                vec![workspace.join(relative_dir).to_string_lossy()]
            );
        }
    }
}

#[test]
fn current_skill_service_honors_officecli_disable_and_rejects_a_missing_system_source() {
    let temp = tempfile::tempdir().unwrap();
    let official = temp.path().join("official");
    let scheduler = official.join("mia-scheduler");
    fs::create_dir_all(&scheduler).unwrap();
    fs::write(
        scheduler.join("SKILL.md"),
        "---\nname: mia-scheduler\ndescription: Scheduler.\n---\n# Scheduler",
    )
    .unwrap();
    let service =
        CurrentSkillService::with_official_roots(temp.path().join("data"), vec![official]);
    let disabled = BotSummary {
        id: "bot_disabled".into(),
        display_name: "Disabled".into(),
        identity: json!({}),
        capabilities: json!({
            "inheritEngineDefaults": true,
            "disabledSkills": ["mia-official:officecli"]
        }),
    };
    assert_eq!(
        service
            .runtime_skill_records(Some(&disabled), &[])
            .unwrap()
            .iter()
            .map(|record| record.id.as_str())
            .collect::<Vec<_>>(),
        vec!["mia-scheduler"]
    );

    let inherited = BotSummary {
        id: "bot_inherited".into(),
        display_name: "Inherited".into(),
        identity: json!({}),
        capabilities: json!({ "inheritEngineDefaults": true }),
    };
    let error = service
        .runtime_skill_records(Some(&inherited), &[])
        .unwrap_err();
    assert!(error.to_string().contains("mia-official:officecli"));
}

#[tokio::test]
async fn conversation_service_owns_conversation_crud() {
    let db = init_database_memory().await.unwrap();
    let service = ConversationService::new(db.pool().clone());

    let created = service
        .create_conversation(CreateConversationRequest {
            kind: "direct".to_string(),
            title: "Planning".to_string(),
            bot_id: None,
            metadata: json!({"source":"test"}),
        })
        .await
        .unwrap();

    assert!(created.conversation.id.starts_with("conv_"));
    assert_eq!(created.conversation.title, "Planning");
    assert_eq!(created.conversation.metadata["source"], "test");

    let fetched = service
        .get_conversation(&created.conversation.id)
        .await
        .unwrap();
    let list = service.list_conversations().await.unwrap();

    assert_eq!(fetched.conversation.id, created.conversation.id);
    assert_eq!(list.conversations.len(), 1);
    assert_eq!(list.conversations[0].id, created.conversation.id);
}

#[tokio::test]
async fn conversation_service_pins_a_defensive_memory_mode_when_created() {
    let db = init_database_memory().await.unwrap();
    let service = ConversationService::new(db.pool().clone());

    let defaulted = service
        .create_conversation(CreateConversationRequest {
            kind: "direct".into(),
            title: "Default Mia".into(),
            bot_id: None,
            metadata: json!({ "source": "internal" }),
        })
        .await
        .unwrap();
    assert_eq!(
        conversation_memory_mode(&defaulted.conversation),
        MemoryMode::Mia
    );
    assert_eq!(defaulted.conversation.metadata["memoryMode"], "mia");
    assert_eq!(defaulted.conversation.metadata["source"], "internal");

    let explicit = service
        .create_conversation(CreateConversationRequest {
            kind: "direct".into(),
            title: "Explicit Native".into(),
            bot_id: None,
            metadata: json!({ "memoryMode": "native", "workspaceDir": "/tmp/native" }),
        })
        .await
        .unwrap();
    assert_eq!(
        conversation_memory_mode(&explicit.conversation),
        MemoryMode::Native
    );
    assert_eq!(
        explicit.conversation.metadata["workspaceDir"],
        "/tmp/native"
    );
}

#[tokio::test]
async fn external_conversation_ensure_preserves_mode_and_session_metadata() {
    let db = init_database_memory().await.unwrap();
    let service = ConversationService::new(db.pool().clone());

    let defaulted = service
        .ensure_external_conversation(
            "external_default",
            "cloud-bridge",
            "Default",
            None,
            json!({ "cloudBridge": { "conversationId": "cloud:default" } }),
        )
        .await
        .unwrap();
    assert_eq!(defaulted.conversation.metadata["memoryMode"], "mia");

    let first = service
        .ensure_external_conversation(
            "external_native",
            "cloud-bridge",
            "Native",
            Some("bot_1"),
            json!({
                "memoryMode": "native",
                "sessionId": "external_session_1",
                "starterEngineId": "codex",
                "workspaceDir": "/tmp/external",
                "runtimeSession": { "sessionKey": "native_session_1" },
                "cloudBridge": { "conversationId": "cloud:old" }
            }),
        )
        .await
        .unwrap();
    assert_eq!(first.conversation.metadata["memoryMode"], "native");

    let ensured = service
        .ensure_external_conversation(
            "external_native",
            "cloud-bridge",
            "Renamed",
            Some("bot_1"),
            json!({
                "memoryMode": "mia",
                "sessionId": "spoofed_session",
                "starterEngineId": "spoofed_engine",
                "workspaceDir": "/tmp/spoofed",
                "runtimeSession": { "sessionKey": "spoofed_native_session" },
                "cloudBridge": { "conversationId": "cloud:new" }
            }),
        )
        .await
        .unwrap();
    assert_eq!(ensured.conversation.title, "Renamed");
    assert_eq!(ensured.conversation.metadata["memoryMode"], "native");
    assert_eq!(
        ensured.conversation.metadata["sessionId"],
        "external_session_1"
    );
    assert_eq!(ensured.conversation.metadata["starterEngineId"], "codex");
    assert_eq!(
        ensured.conversation.metadata["runtimeSession"]["sessionKey"],
        "native_session_1"
    );
    assert_eq!(
        ensured.conversation.metadata["workspaceDir"],
        "/tmp/external"
    );
    assert_eq!(
        ensured.conversation.metadata["cloudBridge"]["conversationId"],
        "cloud:new"
    );
}

#[tokio::test]
async fn conversation_service_persists_user_messages_with_monotonic_sequence() {
    let db = init_database_memory().await.unwrap();
    let service = ConversationService::new(db.pool().clone());
    let created = service
        .create_conversation(CreateConversationRequest {
            kind: "direct".to_string(),
            title: "Chat".to_string(),
            bot_id: None,
            metadata: json!({}),
        })
        .await
        .unwrap();

    let first = service
        .send_user_message(
            &created.conversation.id,
            SendConversationMessageRequest {
                body: "第一条".to_string(),
                attachments: json!([]),
                selected_skill_ids: vec!["skill_a".to_string()],
            },
        )
        .await
        .unwrap();
    let second = service
        .send_user_message(
            &created.conversation.id,
            SendConversationMessageRequest {
                body: "第二条".to_string(),
                attachments: json!([]),
                selected_skill_ids: vec![],
            },
        )
        .await
        .unwrap();

    assert!(first.accepted);
    assert!(first.message_id.starts_with("msg_"));
    assert!(first.turn_id.starts_with("turn_"));
    assert!(
        first
            .assistant_message_id
            .as_deref()
            .is_some_and(|id| id.starts_with("msg_"))
    );
    assert_ne!(first.message_id, second.message_id);
    assert!(second.accepted);
}

#[tokio::test]
async fn conversation_service_checkpoints_and_recovers_partial_runtime_turns() {
    let db = init_database_memory().await.unwrap();
    let service = ConversationService::new(db.pool().clone());
    let created = service
        .create_conversation(CreateConversationRequest {
            kind: "direct".to_string(),
            title: "Checkpoint".to_string(),
            bot_id: None,
            metadata: json!({}),
        })
        .await
        .unwrap();

    let checkpoint = service
        .checkpoint_runtime_turn(
            &created.conversation.id,
            "turn_checkpoint",
            "已经显示的部分回复",
            json!({
                "engine": "codex",
                "trace": {
                    "reasoning": "检查中",
                    "tools": []
                },
                "contentBlocks": [
                    { "type": "text", "id": "text_0", "text": "已经显示的部分回复" }
                ]
            }),
        )
        .await
        .unwrap();

    let streaming = sqlx::query(
        "SELECT id, body, status, content_json FROM messages WHERE conversation_id = ? AND role = 'assistant'",
    )
    .bind(&created.conversation.id)
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(streaming.get::<String, _>("id"), checkpoint.message_id);
    assert_eq!(streaming.get::<String, _>("body"), "已经显示的部分回复");
    assert_eq!(streaming.get::<String, _>("status"), "streaming");

    let completed = service
        .complete_runtime_turn(
            &created.conversation.id,
            "turn_checkpoint",
            "已经显示的部分回复",
            json!({
                "engine": "codex",
                "cancelled": true,
                "trace": {
                    "reasoning": "检查中",
                    "tools": []
                },
                "contentBlocks": [
                    { "type": "text", "id": "text_0", "text": "已经显示的部分回复" }
                ]
            }),
        )
        .await
        .unwrap();
    assert_eq!(completed.message_id, checkpoint.message_id);

    let cancelled = sqlx::query(
        "SELECT COUNT(*) AS count, status FROM messages WHERE conversation_id = ? AND role = 'assistant'",
    )
    .bind(&created.conversation.id)
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(cancelled.get::<i64, _>("count"), 1);
    assert_eq!(cancelled.get::<String, _>("status"), "cancelled");

    service
        .checkpoint_runtime_turn(
            &created.conversation.id,
            "turn_interrupted",
            "重启前已经显示",
            json!({ "engine": "codex", "trace": {}, "contentBlocks": [] }),
        )
        .await
        .unwrap();
    assert_eq!(
        service.recover_interrupted_runtime_turns().await.unwrap(),
        1
    );

    let recovered = sqlx::query(
        "SELECT body, status FROM messages WHERE conversation_id = ? AND json_extract(content_json, '$.turnId') = 'turn_interrupted'",
    )
    .bind(&created.conversation.id)
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(recovered.get::<String, _>("body"), "重启前已经显示");
    assert_eq!(recovered.get::<String, _>("status"), "interrupted");
}

#[tokio::test]
async fn conversation_service_orchestrates_mock_agent_turn_inside_core() {
    let db = init_database_memory().await.unwrap();
    let service = ConversationService::new(db.pool().clone());
    let created = service
        .create_conversation(CreateConversationRequest {
            kind: "direct".to_string(),
            title: "Chat".to_string(),
            bot_id: None,
            metadata: json!({
                "runtime": { "engine": "mock-agent" },
                "provider": { "kind": "mock" },
                "workspaceDir": "/tmp/mia-workspace"
            }),
        })
        .await
        .unwrap();

    let sent = service
        .send_user_message(
            &created.conversation.id,
            SendConversationMessageRequest {
                body: "hello from user".to_string(),
                attachments: json!([]),
                selected_skill_ids: vec!["skill_a".to_string()],
            },
        )
        .await
        .unwrap();

    let rows = sqlx::query(
        "SELECT id, role, body, content_json, seq FROM messages WHERE conversation_id = ? ORDER BY seq ASC",
    )
    .bind(&created.conversation.id)
    .fetch_all(db.pool())
    .await
    .unwrap();

    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].get::<String, _>("role"), "user");
    assert_eq!(rows[0].get::<i64, _>("seq"), 1);
    assert_eq!(rows[1].get::<String, _>("role"), "assistant");
    assert_eq!(rows[1].get::<i64, _>("seq"), 2);
    assert_eq!(
        rows[1].get::<String, _>("body"),
        "Mia Rust Core mock response: hello from user"
    );
    let content: serde_json::Value =
        serde_json::from_str(&rows[1].get::<String, _>("content_json")).unwrap();
    assert_eq!(content["turnId"], sent.turn_id);
    assert_eq!(content["runtimePlan"]["workspaceDir"], "/tmp/mia-workspace");
    assert_eq!(
        content["runtimePlan"]["selectedSkillIds"],
        json!(["skill_a"])
    );
    let assistant_row_id = rows[1].get::<String, _>("id");
    assert_eq!(
        sent.assistant_message_id.as_deref(),
        Some(assistant_row_id.as_str())
    );
}

#[tokio::test]
async fn conversation_service_resolves_bot_runtime_provider_refs_inside_core() {
    let db = init_database_memory().await.unwrap();
    sqlx::query(
        "INSERT INTO providers (id, kind, display_name, base_url, api_key_env, encrypted_api_key, api_mode, auth_type, models_json, enabled, created_at, updated_at)
         VALUES ('provider_openai', 'openai', 'OpenAI', 'https://api.openai.com/v1', 'OPENAI_API_KEY', 'secret-key', 'responses', 'api_key', '[\"gpt-5\"]', 1, 1, 1)",
    )
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bots (id, display_name, avatar_json, capability_json, identity_json, created_at, updated_at)
         VALUES ('bot_provider', 'Provider Bot', '{}', '{}', '{}', 1, 1)",
    )
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_runtime_bindings (bot_id, runtime_kind, binding_json, updated_at)
         VALUES ('bot_provider', 'agent', ?, 1)",
    )
    .bind(
        json!({
            "engine": "mock-agent",
            "providerConnectionId": "provider_openai",
            "modelProfileId": "provider_openai:gpt-5",
            "model": "gpt-5"
        })
        .to_string(),
    )
    .execute(db.pool())
    .await
    .unwrap();

    let service = ConversationService::new(db.pool().clone());
    let created = service
        .create_conversation(CreateConversationRequest {
            kind: "direct".to_string(),
            title: "Provider Chat".to_string(),
            bot_id: Some("bot_provider".to_string()),
            metadata: json!({ "workspaceDir": "/tmp/mia-provider" }),
        })
        .await
        .unwrap();

    let sent = service
        .send_user_message(
            &created.conversation.id,
            SendConversationMessageRequest {
                body: "hello provider".to_string(),
                attachments: json!([]),
                selected_skill_ids: vec![],
            },
        )
        .await
        .unwrap();

    let row = sqlx::query("SELECT content_json FROM messages WHERE id = ? AND conversation_id = ?")
        .bind(sent.assistant_message_id.as_deref().unwrap())
        .bind(&created.conversation.id)
        .fetch_one(db.pool())
        .await
        .unwrap();
    let content: serde_json::Value =
        serde_json::from_str(&row.get::<String, _>("content_json")).unwrap();

    assert_eq!(content["runtimePlan"]["engine"], "mock-agent");
    assert_eq!(
        content["runtimePlan"]["provider"]["providerConnectionId"],
        "provider_openai"
    );
    assert_eq!(content["runtimePlan"]["provider"]["model"], "gpt-5");
    assert_eq!(content["runtimePlan"]["provider"]["apiKey"], "secret-key");
    assert_eq!(
        content["runtimePlan"]["provider"]["baseUrl"],
        "https://api.openai.com/v1"
    );
}

#[tokio::test]
async fn conversation_service_uses_desktop_local_runtime_binding_for_bot_turns() {
    let db = init_database_memory().await.unwrap();
    sqlx::query(
        "INSERT INTO bots (id, display_name, avatar_json, capability_json, identity_json, created_at, updated_at)
         VALUES ('bot_codex', 'Codex', '{}', '{}', '{}', 1, 1)",
    )
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_runtime_bindings (bot_id, runtime_kind, binding_json, updated_at)
         VALUES ('bot_codex', 'desktop-local', ?, 1)",
    )
    .bind(
        json!({
            "runtimeKind": "desktop-local",
            "agentEngine": "codex",
            "config": {
                "agentEngine": "codex",
                "model": "gpt-5-codex",
                "effortLevel": "xhigh",
                "permissionMode": ":workspace"
            }
        })
        .to_string(),
    )
    .execute(db.pool())
    .await
    .unwrap();

    let service = ConversationService::new(db.pool().clone());
    let created = service
        .create_conversation(CreateConversationRequest {
            kind: "direct".to_string(),
            title: "Codex".to_string(),
            bot_id: Some("bot_codex".to_string()),
            metadata: json!({}),
        })
        .await
        .unwrap();

    let accepted = service
        .start_user_turn(
            &created.conversation.id,
            SendConversationMessageRequest {
                body: "hi".to_string(),
                attachments: json!([]),
                selected_skill_ids: vec![],
            },
        )
        .await
        .unwrap();

    assert_eq!(accepted.runtime_plan.engine, "codex");
    assert_eq!(accepted.runtime_plan.mock_response, None);
    assert_eq!(accepted.runtime_plan.provider["model"], "gpt-5-codex");
    assert_eq!(accepted.runtime_plan.provider["effortLevel"], "xhigh");
    assert_eq!(
        accepted.runtime_plan.provider["permissionMode"],
        ":workspace"
    );
}

#[tokio::test]
async fn conversation_service_prepares_runtime_plan_without_inserting_a_message() {
    let db = init_database_memory().await.unwrap();
    sqlx::query(
        "INSERT INTO bots (id, display_name, avatar_json, capability_json, identity_json, created_at, updated_at)
         VALUES ('bot_claude', 'Claude Code', '{}', '{}', '{}', 1, 1)",
    )
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_runtime_bindings (bot_id, runtime_kind, binding_json, updated_at)
         VALUES ('bot_claude', 'desktop-local', ?, 1)",
    )
    .bind(
        json!({
            "runtimeKind": "desktop-local",
            "agentEngine": "claude-code",
            "config": {
                "agentEngine": "claude-code",
                "model": "claude-sonnet-4-6",
                "effortLevel": "high",
                "permissionMode": "acceptEdits"
            }
        })
        .to_string(),
    )
    .execute(db.pool())
    .await
    .unwrap();
    let service = ConversationService::new(db.pool().clone());
    let created = service
        .create_conversation(CreateConversationRequest {
            kind: "bot_session".into(),
            title: "Claude Code".into(),
            bot_id: Some("bot_claude".into()),
            metadata: json!({}),
        })
        .await
        .unwrap();

    let plan = service
        .plan_runtime_session(&created.conversation.id)
        .await
        .unwrap();
    let message_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE conversation_id = ?")
            .bind(&created.conversation.id)
            .fetch_one(db.pool())
            .await
            .unwrap();

    assert_eq!(message_count, 0);
    assert_eq!(plan.engine, "claude-code");
    assert_eq!(plan.provider["model"], "claude-sonnet-4-6");
    assert_eq!(plan.provider["effortLevel"], "high");
    assert_eq!(plan.provider["permissionMode"], "acceptEdits");
}

#[tokio::test]
async fn conversation_service_defaults_an_unselected_desktop_local_engine_to_native_cli() {
    let db = init_database_memory().await.unwrap();
    sqlx::query(
        "INSERT INTO bots (id, display_name, avatar_json, capability_json, identity_json, created_at, updated_at)
         VALUES ('bot_default_codex', 'Codex', '{}', '{}', '{}', 1, 1)",
    )
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_runtime_bindings (bot_id, runtime_kind, binding_json, updated_at)
         VALUES ('bot_default_codex', 'desktop-local', ?, 1)",
    )
    .bind(
        json!({
            "runtimeKind": "desktop-local",
            "agentEngine": "codex",
            "config": { "agentEngine": "codex" }
        })
        .to_string(),
    )
    .execute(db.pool())
    .await
    .unwrap();
    let service = ConversationService::new(db.pool().clone());
    let created = service
        .create_conversation(CreateConversationRequest {
            kind: "bot_session".into(),
            title: "Codex".into(),
            bot_id: Some("bot_default_codex".into()),
            metadata: json!({}),
        })
        .await
        .unwrap();

    let plan = service
        .plan_runtime_session(&created.conversation.id)
        .await
        .unwrap();

    assert_eq!(plan.provider["providerConnectionId"], "codex");
    assert_eq!(plan.provider["model"], "");
    assert_eq!(plan.provider["modelProfileId"], "codex");
    assert_eq!(plan.provider["managedByMia"], false);
    assert_eq!(plan.provider["nativeCli"], true);
}

#[tokio::test]
async fn conversation_service_repairs_desktop_local_mia_provider_metadata() {
    let db = init_database_memory().await.unwrap();
    let service = ConversationService::new(db.pool().clone());
    let created = service
        .create_conversation(CreateConversationRequest {
            kind: "cloud-bridge".into(),
            title: "Codex".into(),
            bot_id: None,
            metadata: json!({
                "runtime": {
                    "agentEngine": "codex",
                    "deviceId": "device_1",
                    "deviceName": "Windows",
                    "model": "gpt-5.5",
                    "modelProfileId": "mia:gpt-5.5",
                    "providerConnectionId": "mia",
                    "effortLevel": "medium",
                    "permissionMode": "default"
                }
            }),
        })
        .await
        .unwrap();

    let plan = service
        .plan_runtime_session(&created.conversation.id)
        .await
        .unwrap();

    assert_eq!(plan.engine, "codex");
    assert_eq!(plan.provider["providerConnectionId"], "codex");
    assert_eq!(plan.provider["model"], "gpt-5.5");
    assert_eq!(plan.provider["modelProfileId"], "codex:gpt-5.5");
    assert_eq!(plan.provider["effortLevel"], "medium");
    assert_eq!(plan.provider["permissionMode"], "default");
    assert_eq!(plan.provider["managedByMia"], false);
    assert_eq!(plan.provider["nativeCli"], true);
}

#[tokio::test]
async fn internal_turn_keeps_full_runtime_config_alongside_native_provider_reference() {
    let db = init_database_memory().await.unwrap();
    let service = ConversationService::new(db.pool().clone());
    let created = service
        .create_conversation(CreateConversationRequest {
            kind: "cloud-bridge".into(),
            title: "Hermes scheduled turn".into(),
            bot_id: None,
            metadata: json!({
                "runtime": {
                    "agentEngine": "hermes",
                    "runtimeKind": "desktop-local",
                    "platformProvider": "mia",
                    "platformModel": "mia-auto",
                    "platformModelProfileId": "mia:mia-auto",
                    "modelEntries": [{
                        "provider": "mia",
                        "model": "mia-auto",
                        "authType": "mia_account"
                    }],
                    "effortLevel": "medium",
                    "permissionMode": "default"
                }
            }),
        })
        .await
        .unwrap();

    let planned = service
        .plan_internal_turn(&created.conversation.id, "remind me to eat", vec![])
        .await
        .unwrap();

    assert_eq!(planned.runtime_plan.engine, "hermes");
    assert_eq!(
        planned.runtime_plan.provider["providerConnectionId"],
        "hermes"
    );
    assert_eq!(planned.runtime_plan.provider["nativeCli"], true);
    assert_eq!(planned.runtime_config["runtimeKind"], "desktop-local");
    assert_eq!(planned.runtime_config["platformProvider"], "mia");
    assert_eq!(planned.runtime_config["platformModel"], "mia-auto");
    assert_eq!(
        planned.runtime_config["modelEntries"][0]["authType"],
        "mia_account"
    );
}

#[tokio::test]
async fn conversation_service_formal_turn_payload_contains_current_user_message_only() {
    let db = init_database_memory().await.unwrap();
    sqlx::query(
        "INSERT INTO bots (id, display_name, avatar_json, capability_json, identity_json, created_at, updated_at)
         VALUES ('bot_codex', 'Codex', '{}', '{}', '{}', 1, 1)",
    )
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_runtime_bindings (bot_id, runtime_kind, binding_json, updated_at)
         VALUES ('bot_codex', 'desktop-local', ?, 1)",
    )
    .bind(
        json!({
            "runtimeKind": "desktop-local",
            "agentEngine": "codex",
            "config": {
                "agentEngine": "codex",
                "model": "gpt-5-codex"
            }
        })
        .to_string(),
    )
    .execute(db.pool())
    .await
    .unwrap();

    let service = ConversationService::new(db.pool().clone());
    let created = service
        .create_conversation(CreateConversationRequest {
            kind: "direct".to_string(),
            title: "Codex".to_string(),
            bot_id: Some("bot_codex".to_string()),
            metadata: json!({}),
        })
        .await
        .unwrap();
    let first = service
        .start_user_turn(
            &created.conversation.id,
            SendConversationMessageRequest {
                body: "previous user question".to_string(),
                attachments: json!([]),
                selected_skill_ids: vec![],
            },
        )
        .await
        .unwrap();
    service
        .complete_runtime_turn(
            &created.conversation.id,
            &first.response.turn_id,
            "previous assistant answer",
            json!({
                "runtimeSession": {
                    "conversationId": created.conversation.id,
                    "engine": "codex",
                    "sessionKey": "codex:logical-conversation-key",
                    "resumeSessionKey": "019f562e-49a5-7b42-a02a-5869f2719bb2",
                    "resumed": false
                }
            }),
        )
        .await
        .unwrap();

    let second = service
        .start_user_turn(
            &created.conversation.id,
            SendConversationMessageRequest {
                body: "current user question".to_string(),
                attachments: json!([]),
                selected_skill_ids: vec![],
            },
        )
        .await
        .unwrap();

    assert_eq!(
        second.runtime_plan.protocol,
        mia_core_runtime::RuntimeProtocol::NativeAcp
    );
    assert_eq!(
        second.runtime_plan.send_message.content,
        "current user question"
    );
    assert_eq!(
        second
            .runtime_plan
            .runtime_session
            .resume_session_key
            .as_deref(),
        Some("019f562e-49a5-7b42-a02a-5869f2719bb2")
    );
    assert!(
        !second
            .runtime_plan
            .send_message
            .content
            .contains("previous user question")
    );
    assert!(
        !second
            .runtime_plan
            .send_message
            .content
            .contains("previous assistant answer")
    );
}

#[tokio::test]
async fn conversation_service_plans_utility_turn_with_core_owned_runtime_resolution() {
    let db = init_database_memory().await.unwrap();
    sqlx::query(
        "INSERT INTO providers (id, kind, display_name, base_url, api_key_env, encrypted_api_key, api_mode, auth_type, models_json, enabled, created_at, updated_at)
         VALUES ('provider_openai', 'openai', 'OpenAI', 'https://api.openai.com/v1', 'OPENAI_API_KEY', 'secret-key', 'responses', 'api_key', '[\"gpt-5\"]', 1, 1, 1)",
    )
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bots (id, display_name, avatar_json, capability_json, identity_json, created_at, updated_at)
         VALUES ('bot_utility', 'Utility Bot', '{}', '{}', '{}', 1, 1)",
    )
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_runtime_bindings (bot_id, runtime_kind, binding_json, updated_at)
         VALUES ('bot_utility', 'agent', ?, 1)",
    )
    .bind(
        json!({
            "engine": "mock-agent",
            "providerConnectionId": "provider_openai",
            "modelProfileId": "provider_openai:gpt-5",
            "model": "gpt-5"
        })
        .to_string(),
    )
    .execute(db.pool())
    .await
    .unwrap();

    let service =
        ConversationService::new(db.pool().clone()).with_core_base_url("http://127.0.0.1:27861");
    let plan = service
        .plan_utility_turn(RunConversationUtilityTurnRequest {
            bot_id: Some("bot_utility".to_string()),
            conversation_id: Some("conv_transient".to_string()),
            purpose: "translate".to_string(),
            system_prompt: "system".to_string(),
            user_prompt: "translate this".to_string(),
            selected_skill_ids: vec!["skill_translate".to_string()],
        })
        .await
        .unwrap();

    assert_eq!(plan.conversation_id, "conv_transient");
    assert_eq!(plan.bot_id.as_deref(), Some("bot_utility"));
    assert_eq!(plan.memory_mode, MemoryMode::Native);
    assert_eq!(
        plan.mcp_servers["mcpServers"]["mia-app"]["env"]["MIA_MEMORY_MODE"],
        "native"
    );
    assert_eq!(plan.engine, "mock-agent");
    assert_eq!(plan.selected_skill_ids, vec!["skill_translate"]);
    assert_eq!(
        plan.provider["providerConnectionId"],
        json!("provider_openai")
    );
    assert_eq!(plan.provider["apiKey"], json!("secret-key"));
    assert_eq!(
        plan.mock_response.as_deref(),
        Some("Mia Rust Core mock response: system\n\ntranslate this")
    );
}

#[tokio::test]
async fn conversation_service_injects_enabled_mcp_servers_into_turn_plan() {
    let db = init_database_memory().await.unwrap();
    sqlx::query(
        "INSERT INTO settings (key, value_json, updated_at) VALUES ('client', ?, 1) \
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    )
        .bind(
            json!({
                "userId": "user_real",
                "reservedMcpSpecs": {
                    "miaApp": {
                        "command": "/bin/node",
                        "args": ["/opt/mia/mia-app-mcp-server.js"],
                        "env": {
                            "MIA_CORE_URL": "http://127.0.0.1:27861",
                            "MIA_CORE_TOKEN": "core-token"
                        },
                        "alwaysLoad": true
                    },
                    "scheduler": {
                        "command": "/bin/node",
                        "args": ["/opt/mia/scheduler-mcp-server.js"],
                        "env": {
                            "MIA_SCHEDULER_CONTEXT_FILE": "/tmp/scheduler-context.json"
                        }
                    }
                }
            })
            .to_string(),
        )
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO bots (id, display_name, identity_json, capability_json, avatar_json, created_at, updated_at)
         VALUES ('bot_scope', 'Scoped Bot', '{}', '{}', '{}', 1, 1)",
    )
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO mcp_servers (id, name, transport, config_json, enabled, last_test_json, deleted_at, created_at, updated_at)
         VALUES ('mcp_docs', 'docs', 'http', ?, 1, '{}', NULL, 1, 1)",
    )
    .bind(
        json!({
            "nativeName": "docs",
            "transport": {
                "type": "http",
                "url": "https://example.test/mcp",
                "headers": { "Authorization": "Bearer secret" }
            }
        })
        .to_string(),
    )
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO mcp_servers (id, name, transport, config_json, enabled, last_test_json, deleted_at, created_at, updated_at)
         VALUES ('mcp_disabled', 'disabled-docs', 'stdio', ?, 0, '{}', NULL, 1, 1)",
    )
    .bind(json!({"nativeName":"disabled","transport":{"type":"stdio","command":"npx","args":["disabled"]}}).to_string())
    .execute(db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO mcp_servers (id, name, transport, config_json, enabled, last_test_json, deleted_at, created_at, updated_at)
         VALUES ('mcp_user_mia_app', 'mia-app', 'http', ?, 1, '{}', NULL, 1, 1)",
    )
    .bind(json!({"nativeName":"mia-app","transport":{"url":"https://bad.example/mcp"}}).to_string())
    .execute(db.pool())
    .await
    .unwrap();

    let service =
        ConversationService::new(db.pool().clone()).with_core_base_url("http://127.0.0.1:27861");
    let created = service
        .create_conversation(CreateConversationRequest {
            kind: "direct".to_string(),
            title: "MCP Chat".to_string(),
            bot_id: Some("bot_scope".into()),
            metadata: json!({ "runtime": { "engine": "mock-agent" } }),
        })
        .await
        .unwrap();
    let accepted = service
        .start_user_turn(
            &created.conversation.id,
            SendConversationMessageRequest {
                body: "hello mcp".to_string(),
                attachments: json!([]),
                selected_skill_ids: vec![],
            },
        )
        .await
        .unwrap();
    assert_eq!(
        accepted.runtime_plan.mcp_servers["mcpServers"]["mia-app"]["args"][0],
        "mcp-mia-stdio"
    );
    assert_eq!(
        accepted.runtime_plan.mcp_servers["mcpServers"]["mia-app"]["env"]["MIA_CORE_URL"],
        "http://127.0.0.1:27861"
    );
    assert_eq!(
        accepted.runtime_plan.mcp_servers["mcpServers"]["mia-app"]["env"]["MIA_BOT_ID"],
        "bot_scope"
    );
    assert_eq!(
        accepted.runtime_plan.mcp_servers["mcpServers"]["mia-app"]["env"]["MIA_CONVERSATION_ID"],
        created.conversation.id
    );
    assert_eq!(
        accepted.runtime_plan.mcp_servers["mcpServers"]["mia-app"]["env"]["MIA_ORIGIN_MESSAGE_ID"],
        accepted.response.message_id
    );
    assert_eq!(
        accepted.runtime_plan.mcp_servers["mcpServers"]["mia-app"]["env"]["MIA_USER_ID"],
        "user_real"
    );
    assert_eq!(accepted.runtime_plan.memory_mode, MemoryMode::Mia);
    assert_eq!(
        accepted.runtime_plan.mcp_servers["mcpServers"]["mia-app"]["env"]["MIA_MEMORY_MODE"],
        "mia"
    );
    assert!(
        accepted.runtime_plan.mcp_servers["mcpServers"]
            .get("mia-scheduler")
            .is_none()
    );

    let row = sqlx::query("SELECT content_json FROM messages WHERE id = ?")
        .bind(accepted.response.assistant_message_id.as_deref().unwrap())
        .fetch_one(db.pool())
        .await
        .unwrap();
    let content: serde_json::Value =
        serde_json::from_str(&row.get::<String, _>("content_json")).unwrap();

    assert_eq!(
        content["runtimePlan"]["mcpServers"]["mcpServers"]["docs"]["type"],
        "http"
    );
    assert_eq!(
        content["runtimePlan"]["mcpServers"]["mcpServers"]["docs"]["url"],
        "https://example.test/mcp"
    );
    assert_eq!(
        content["runtimePlan"]["mcpServers"]["mcpServers"]["docs"]["headers"]["Authorization"],
        "••••"
    );
    assert_eq!(
        content["runtimePlan"]["mcpServers"]["mcpServers"]["mia-app"]["env"]["MIA_BOT_ID"],
        "bot_scope"
    );
    assert!(
        content["runtimePlan"]["mcpServers"]["mcpServers"]
            .get("disabled")
            .is_none()
    );
}

#[tokio::test]
async fn conversation_service_materializes_selected_skill_as_native_link_and_short_path_only() {
    let db = init_database_memory().await.unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let official = temp.path().join("official");
    let skill_dir = official.join("meeting-notes");
    let scheduler_dir = official.join("mia-scheduler");
    let officecli_dir = official.join("officecli");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::create_dir_all(&scheduler_dir).unwrap();
    fs::create_dir_all(&officecli_dir).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: meeting-notes\ndescription: Meeting notes.\n---\nSECRET_SKILL_BODY",
    )
    .unwrap();
    fs::write(
        scheduler_dir.join("SKILL.md"),
        "---\nname: mia-scheduler\ndescription: Scheduler.\n---\n# Scheduler",
    )
    .unwrap();
    fs::write(
        officecli_dir.join("SKILL.md"),
        "---\nname: officecli\ndescription: Office files.\n---\n# OfficeCLI",
    )
    .unwrap();
    sqlx::query(
        "INSERT INTO bots (id, display_name, identity_json, capability_json, avatar_json, created_at, updated_at)
         VALUES ('bot_skill', 'Skill Bot', '{}', ?, '{}', 1, 1)",
    )
    .bind(json!({"enabledSkills":["mia-official:meeting-notes"]}).to_string())
    .execute(db.pool())
    .await
    .unwrap();

    let current_skills =
        CurrentSkillService::with_official_roots(temp.path().join("data"), vec![official]);
    let service = ConversationService::new(db.pool().clone()).with_current_skills(current_skills);
    let conversation = service
        .create_conversation(CreateConversationRequest {
            kind: "bot_session".into(),
            title: "Skill Chat".into(),
            bot_id: Some("bot_skill".into()),
            metadata: json!({
                "runtime":{"engine":"codex"},
                "workspaceDir": workspace,
            }),
        })
        .await
        .unwrap();

    let turn = service
        .start_user_turn(
            &conversation.conversation.id,
            SendConversationMessageRequest {
                body: "整理这次会议".into(),
                attachments: json!([]),
                selected_skill_ids: vec!["mia-official:meeting-notes".into()],
            },
        )
        .await
        .unwrap();

    assert!(
        workspace
            .join(".codex/skills/meeting-notes/SKILL.md")
            .exists()
    );
    assert!(
        turn.runtime_plan
            .send_message
            .content
            .contains("<selected_skill_paths>")
    );
    assert!(
        turn.runtime_plan
            .send_message
            .content
            .contains("SKILL.md</path>")
    );
    assert!(
        turn.runtime_plan
            .send_message
            .content
            .ends_with("整理这次会议")
    );
    assert!(
        !turn
            .runtime_plan
            .send_message
            .content
            .contains("SECRET_SKILL_BODY")
    );
    assert_eq!(
        turn.runtime_plan
            .environment
            .get("MIA_SKILL_DELIVERY_MODE")
            .map(String::as_str),
        Some("native-link")
    );
}

#[tokio::test]
async fn conversation_service_uses_default_workspace_for_builtin_native_skills() {
    let db = init_database_memory().await.unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let official = temp.path().join("official");
    let scheduler = official.join("mia-scheduler");
    let officecli = official.join("officecli");
    fs::create_dir_all(&scheduler).unwrap();
    fs::create_dir_all(&officecli).unwrap();
    fs::write(
        scheduler.join("SKILL.md"),
        "---\nname: mia-scheduler\ndescription: Mia scheduler protocol.\n---\n# Scheduler\nUse [CRON_CREATE].",
    )
    .unwrap();
    fs::write(
        officecli.join("SKILL.md"),
        "---\nname: officecli\ndescription: Office files.\n---\n# OfficeCLI",
    )
    .unwrap();
    sqlx::query(
        "INSERT INTO bots (id, display_name, identity_json, capability_json, avatar_json, created_at, updated_at)
         VALUES ('bot_default_workspace', 'Scheduler Bot', '{}', '{}', '{}', 1, 1)",
    )
    .execute(db.pool())
    .await
    .unwrap();

    let current_skills =
        CurrentSkillService::with_official_roots(temp.path().join("data"), vec![official]);
    let service = ConversationService::new(db.pool().clone())
        .with_current_skills(current_skills)
        .with_default_workspace_dir(workspace.clone());
    let conversation = service
        .create_conversation(CreateConversationRequest {
            kind: "bot_session".into(),
            title: "Scheduler Chat".into(),
            bot_id: Some("bot_default_workspace".into()),
            metadata: json!({"runtime":{"engine":"claude-code"}}),
        })
        .await
        .unwrap();

    let turn = service
        .start_user_turn(
            &conversation.conversation.id,
            SendConversationMessageRequest {
                body: "每天九点提醒我写日报".into(),
                attachments: json!([]),
                selected_skill_ids: vec![],
            },
        )
        .await
        .unwrap();

    assert_eq!(turn.runtime_plan.workspace_dir, workspace.to_string_lossy());
    assert!(
        workspace
            .join(".claude/skills/mia-scheduler/SKILL.md")
            .exists()
    );
    assert!(workspace.join(".claude/skills/officecli/SKILL.md").exists());
}

#[test]
fn conversation_core_materializes_turn_skills_with_index_and_loaded_blocks() {
    let result = materialize_turn_skills(SkillMaterializationRequest {
        available_skills: vec![
            SkillMaterializationRecord {
                id: "mia-official:xlsx".into(),
                name: "xlsx".into(),
                description: "Excel deliverables".into(),
                body: "# XLSX\nUse formulas and preserve workbook structure.".into(),
            },
            SkillMaterializationRecord {
                id: "demo".into(),
                name: "demo".into(),
                description: "Demo guide".into(),
                body: "# Demo\nFull guide.".into(),
            },
        ],
        active_skill_ids: vec![],
        intent_skill_ids: vec!["xlsx".into()],
        requested_skill_ids: vec![],
        mode: Some("index".into()),
    });

    assert!(result.index_block.contains("## Available Mia Skills"));
    assert!(result.index_block.contains("mia-official:xlsx"));
    assert!(!result.index_block.contains("Use formulas and preserve"));
    assert!(result.loaded_block.contains("=== Skill: xlsx ==="));
    assert!(
        result
            .loaded_block
            .contains("Use formulas and preserve workbook structure.")
    );
    assert_eq!(result.loaded_skill_ids, vec!["mia-official:xlsx"]);
}

#[test]
fn conversation_core_plans_agent_session_native_skill_runtime() {
    let result = plan_agent_session_skill_runtime(AgentSessionSkillRuntimeRequest {
        agent_engine: "codex".into(),
        runtime_config: json!({}),
        session_skill_ids: vec![],
        available_skills: vec![
            AgentSessionSkillRecord {
                id: "pdf".into(),
                name: "pdf".into(),
                display_name: "PDF".into(),
                description: "PDF guide".into(),
                summary: "PDF guide".into(),
                body: "# PDF".into(),
                source_path: "/skills/pdf".into(),
                link_name: "pdf".into(),
            },
            AgentSessionSkillRecord {
                id: "deep-research".into(),
                name: "deep-research".into(),
                display_name: "Deep Research".into(),
                description: "Research guide".into(),
                summary: "Research guide".into(),
                body: "# Deep".into(),
                source_path: "/skills/deep-research".into(),
                link_name: "deep-research".into(),
            },
        ],
        active_skill_ids: vec!["deep-research".into()],
        intent_skill_ids: vec![],
        requested_skill_ids: vec![],
        workspace_path: None,
    });

    assert_eq!(result.delivery_mode, "native-link");
    assert_eq!(result.native_skills_dirs, vec![".codex/skills"]);
    assert_eq!(result.resolved_skill_ids, vec!["deep-research", "pdf"]);
    assert_eq!(result.turn_selected_skills[0].id, "deep-research");
    assert!(
        result
            .selected_skill_prompt
            .contains("<selected_skill_paths>")
    );
    assert!(
        result
            .selected_skill_prompt
            .contains("<path>/skills/deep-research/SKILL.md</path>")
    );
    assert!(result.skill_fingerprint.len() >= 8);
    assert!(result.skill_materialization.is_none());
}

#[test]
fn conversation_core_reconciles_agent_session_workspace_skill_links() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let source_pdf = temp.path().join("source-pdf");
    let source_research = temp.path().join("source-deep-research");
    fs::create_dir_all(&source_pdf).unwrap();
    fs::create_dir_all(&source_research).unwrap();
    fs::create_dir_all(workspace.join(".codex/skills/user-owned")).unwrap();
    fs::create_dir_all(workspace.join(".codex/skills/stale-skill")).unwrap();
    fs::create_dir_all(workspace.join(".mia")).unwrap();
    fs::write(
        workspace.join(".mia/skill-runtime.json"),
        serde_json::to_string_pretty(&json!({
            "skillFingerprint": "old",
            "managedTargets": [".codex/skills/stale-skill"]
        }))
        .unwrap(),
    )
    .unwrap();

    let result = plan_agent_session_skill_runtime(AgentSessionSkillRuntimeRequest {
        agent_engine: "codex".into(),
        runtime_config: json!({}),
        workspace_path: Some(workspace.to_string_lossy().to_string()),
        session_skill_ids: vec!["pdf".into()],
        available_skills: vec![
            AgentSessionSkillRecord {
                id: "pdf".into(),
                name: "pdf".into(),
                display_name: "PDF".into(),
                description: "PDF guide".into(),
                summary: "PDF guide".into(),
                body: "# PDF".into(),
                source_path: source_pdf.to_string_lossy().to_string(),
                link_name: "pdf".into(),
            },
            AgentSessionSkillRecord {
                id: "deep-research".into(),
                name: "deep-research".into(),
                display_name: "Deep Research".into(),
                description: "Research guide".into(),
                summary: "Research guide".into(),
                body: "# Deep".into(),
                source_path: source_research.to_string_lossy().to_string(),
                link_name: "deep-research".into(),
            },
        ],
        active_skill_ids: vec!["deep-research".into()],
        intent_skill_ids: vec![],
        requested_skill_ids: vec![],
    });

    let linked_pdf = workspace.join(".codex/skills/pdf");
    assert!(
        fs::symlink_metadata(&linked_pdf)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_link(&linked_pdf).unwrap(), source_pdf);
    assert!(!workspace.join(".codex/skills/deep-research").exists());
    assert!(!workspace.join(".codex/skills/stale-skill").exists());
    assert!(workspace.join(".codex/skills/user-owned").exists());
    assert_eq!(result.managed_skill_targets, vec![".codex/skills/pdf"]);
    assert_eq!(
        result.manifest_path,
        workspace.join(".mia/skill-runtime.json").to_string_lossy()
    );

    let manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(workspace.join(".mia/skill-runtime.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["skillFingerprint"], result.skill_fingerprint);
    assert_eq!(manifest["managedTargets"], json!([".codex/skills/pdf"]));
}

#[test]
fn conversation_core_plans_hermes_native_external_skill_directory_without_prompt_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let source = temp.path().join("xlsx");
    fs::create_dir_all(&source).unwrap();
    fs::write(
        source.join("SKILL.md"),
        "---\nname: xlsx\n---\nUse formulas.",
    )
    .unwrap();
    let result = plan_agent_session_skill_runtime(AgentSessionSkillRuntimeRequest {
        agent_engine: "hermes".into(),
        runtime_config: json!({ "nativeSkillsDirs": null }),
        session_skill_ids: vec!["xlsx".into()],
        available_skills: vec![AgentSessionSkillRecord {
            id: "xlsx".into(),
            name: "xlsx".into(),
            display_name: "XLSX".into(),
            description: "Excel deliverables".into(),
            summary: "Excel deliverables".into(),
            body: "# XLSX\nUse formulas.".into(),
            source_path: source.to_string_lossy().to_string(),
            link_name: "xlsx".into(),
        }],
        active_skill_ids: vec![],
        intent_skill_ids: vec![],
        requested_skill_ids: vec![],
        workspace_path: Some(workspace.to_string_lossy().to_string()),
    });

    assert_eq!(result.delivery_mode, "native-link");
    assert_eq!(result.native_skills_dirs, vec![".mia/hermes-skills"]);
    assert_eq!(
        result.skill_external_dirs,
        vec![workspace.join(".mia/hermes-skills").to_string_lossy()]
    );
    assert!(result.skill_materialization.is_none());
    assert!(workspace.join(".mia/hermes-skills/xlsx/SKILL.md").exists());
}

#[test]
fn conversation_core_reuses_matching_hermes_home_skill_without_external_name_collision() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let hermes_skills = temp.path().join("hermes-home").join("skills");
    let native_officecli = hermes_skills.join("officecli");
    let source_officecli = temp.path().join("mia-officecli");
    fs::create_dir_all(&native_officecli).unwrap();
    fs::create_dir_all(&source_officecli).unwrap();
    fs::write(
        native_officecli.join("SKILL.md"),
        "---\nname: officecli\n---\nNative Hermes OfficeCLI.",
    )
    .unwrap();
    fs::write(
        source_officecli.join("SKILL.md"),
        "---\nname: officecli\n---\nMia OfficeCLI.",
    )
    .unwrap();

    let result = plan_agent_session_skill_runtime(AgentSessionSkillRuntimeRequest {
        agent_engine: "hermes".into(),
        runtime_config: json!({
            "hermesNativeSkillsDir": hermes_skills.to_string_lossy(),
        }),
        session_skill_ids: vec!["mia-official:officecli".into()],
        available_skills: vec![AgentSessionSkillRecord {
            id: "mia-official:officecli".into(),
            name: "officecli".into(),
            display_name: "OfficeCLI".into(),
            description: "Office files".into(),
            summary: "Office files".into(),
            body: "# OfficeCLI".into(),
            source_path: source_officecli.to_string_lossy().to_string(),
            link_name: "officecli".into(),
        }],
        active_skill_ids: vec!["mia-official:officecli".into()],
        intent_skill_ids: vec![],
        requested_skill_ids: vec![],
        workspace_path: Some(workspace.to_string_lossy().to_string()),
    });

    assert!(result.managed_skill_targets.is_empty());
    assert!(!workspace.join(".mia/hermes-skills/officecli").exists());
    assert!(
        result.selected_skill_prompt.contains(
            &native_officecli
                .join("SKILL.md")
                .to_string_lossy()
                .replace('\\', "/")
                .to_string()
        )
    );
    assert!(
        !result
            .selected_skill_prompt
            .contains(&source_officecli.to_string_lossy().to_string())
    );
}
