use mia_core_api_types::{
    AgentSessionSkillRecord, AgentSessionSkillRuntimeRequest, BotSummary,
    CreateConversationRequest, RunConversationUtilityTurnRequest, SendConversationMessageRequest,
    SkillMaterializationRecord, SkillMaterializationRequest,
};
use mia_core_conversation::{
    ConversationService, CurrentSkillService, materialize_turn_skills,
    plan_agent_session_skill_runtime,
};
use mia_core_db::init_database_memory;
use serde_json::json;
use sqlx::Row;
use std::fs;

#[test]
fn current_skill_service_lists_and_reads_enabled_bot_skills_from_core_paths() {
    let temp = tempfile::tempdir().unwrap();
    let private_skill_dir = temp.path().join("data").join("skills").join("demo-skill");
    let official_skill_dir = temp.path().join("official").join("mia-scheduler");
    fs::create_dir_all(&private_skill_dir).unwrap();
    fs::create_dir_all(&official_skill_dir).unwrap();
    fs::write(
        private_skill_dir.join("SKILL.md"),
        "---\nname: demo-skill\ndescription: A demo.\n---\n# Demo Skill\nUse it.",
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
    assert_eq!(listed.skills.len(), 2);
    assert_eq!(listed.skills[0].id, "demo-skill");
    assert_eq!(listed.skills[0].name, "demo-skill");
    assert_eq!(listed.skills[0].description, "A demo.");
    assert_eq!(listed.skills[1].id, "mia-official:mia-scheduler");

    let read_by_alias = service
        .read_current_bot_skill("bot_1", Some(&bot), "mia-scheduler")
        .unwrap();
    assert_eq!(read_by_alias.skill.id, "mia-official:mia-scheduler");
    assert!(read_by_alias.skill.body.contains("schedule_create"));
    assert_eq!(
        read_by_alias.skill.body_chars,
        read_by_alias.skill.body.chars().count()
    );

    let missing = service
        .read_current_bot_skill("bot_1", Some(&bot), "missing")
        .unwrap_err();
    assert!(missing.to_string().contains("not enabled"));
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
                    "sessionKey": "native-session-1",
                    "resumeSessionKey": "native-session-1",
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

    assert_eq!(second.runtime_plan.protocol, mia_core_runtime::RuntimeProtocol::NativeAcp);
    assert_eq!(second.runtime_plan.send_message.content, "current user question");
    assert_eq!(
        second.runtime_plan.runtime_session.resume_session_key.as_deref(),
        Some("native-session-1")
    );
    assert!(!second
        .runtime_plan
        .send_message
        .content
        .contains("previous user question"));
    assert!(!second
        .runtime_plan
        .send_message
        .content
        .contains("previous assistant answer"));
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

    let service = ConversationService::new(db.pool().clone());
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

    let service = ConversationService::new(db.pool().clone());
    let created = service
        .create_conversation(CreateConversationRequest {
            kind: "direct".to_string(),
            title: "MCP Chat".to_string(),
            bot_id: None,
            metadata: json!({ "runtime": { "engine": "mock-agent" } }),
        })
        .await
        .unwrap();
    let sent = service
        .send_user_message(
            &created.conversation.id,
            SendConversationMessageRequest {
                body: "hello mcp".to_string(),
                attachments: json!([]),
                selected_skill_ids: vec![],
            },
        )
        .await
        .unwrap();

    let row = sqlx::query("SELECT content_json FROM messages WHERE id = ?")
        .bind(sent.assistant_message_id.as_deref().unwrap())
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
    assert!(
        content["runtimePlan"]["mcpServers"]["mcpServers"]
            .get("disabled")
            .is_none()
    );
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
fn conversation_core_plans_agent_session_prompt_fallback_materialization() {
    let result = plan_agent_session_skill_runtime(AgentSessionSkillRuntimeRequest {
        agent_engine: "hermes".into(),
        runtime_config: json!({ "nativeSkillsDirs": null }),
        session_skill_ids: vec![],
        available_skills: vec![AgentSessionSkillRecord {
            id: "xlsx".into(),
            name: "xlsx".into(),
            display_name: "XLSX".into(),
            description: "Excel deliverables".into(),
            summary: "Excel deliverables".into(),
            body: "# XLSX\nUse formulas.".into(),
            source_path: "/skills/xlsx".into(),
            link_name: "xlsx".into(),
        }],
        active_skill_ids: vec![],
        intent_skill_ids: vec!["xlsx".into()],
        requested_skill_ids: vec![],
        workspace_path: None,
    });

    assert_eq!(result.delivery_mode, "prompt-fallback");
    assert!(result.native_skills_dirs.is_empty());
    let materialization = result.skill_materialization.as_ref().unwrap();
    assert!(
        materialization
            .index_block
            .contains("## Available Mia Skills")
    );
    assert!(materialization.loaded_block.contains("=== Skill: xlsx ==="));
}
