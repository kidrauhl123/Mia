use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};

use crate::services::AppServices;

use super::agent_command::{execute_agent_command, list_agent_commands};
use super::attachment::{fetch_file_attachment, save_attachment};
use super::bot::{
    bot_capability_options, bot_runtime_control_options, bot_runtime_target_options, create_bot,
    delete_bot, ensure_bot_session_conversation, ensure_starter_bots, get_bot, get_bot_memory,
    get_bot_runtime, list_bots, replace_bot_memory_entry, save_bot_runtime, update_bot,
};
use super::cloud::{
    cancel_cloud_bridge_run, cloud_status, connect_cloud, disconnect_cloud, get_cloud_settings,
    prepare_cloud_bridge_runtime_controls, put_cloud_settings, run_cloud_bridge,
    run_cloud_bridge_async, set_cloud_bridge_runtime_control, start_cloud_bridge,
    start_cloud_events, stop_cloud_bridge, stop_cloud_events, sync_cloud_memory,
};
use super::conversation::{
    cancel_conversation_turn, create_conversation, delete_conversation, get_conversation,
    list_conversation_messages, list_conversations, materialize_conversation_skills,
    plan_agent_session_skills, prepare_conversation_runtime_controls,
    run_conversation_utility_turn, send_conversation_message, set_conversation_runtime_control,
};
use super::engine::{
    agent_engines, codex_models, engine_capabilities, engine_model_catalog, hermes_slash_commands,
};
use super::health::health_check;
use super::mcp::{
    create_mcp_server, delete_mcp_server, get_mcp_agent_configs, get_mcp_server,
    import_mcp_agent_config, import_mcp_servers, install_mcp_template, list_mcp_servers,
    list_mcp_tools, mcp_marketplace, mcp_oauth_login, mcp_oauth_logout, mcp_oauth_status,
    refresh_mcp_bridge, remove_mcp_from_agents, run_mcp_managed_action, sync_mcp, test_mcp_server,
    update_mcp_server,
};
use super::mia::{
    list_current_mia_skills, mia_context_snapshot, mutate_mia_memory, read_current_mia_skill,
};
use super::realtime::websocket_events;
use super::state::{ModuleStates, build_module_states};
use super::system::{
    create_provider, get_agent_workspace, get_client_settings, get_memory_settings,
    list_agent_permissions, list_providers, patch_client_settings, prepare_hermes_runtime_config,
    resolve_model_runtime, respond_agent_permission, save_agent_workspace, save_memory_settings,
    save_model_selection, settings_runtime_control_options, system_status, test_provider,
};
use super::tasks::{
    create_task_job, delete_cloud_task, delete_task_job, get_cloud_task, get_task_job,
    list_cloud_tasks, list_task_jobs, pause_cloud_task, resume_cloud_task, run_cloud_task_now,
    run_task_job, update_cloud_task, update_task_job,
};

pub fn create_router(services: &AppServices) -> Router {
    let states = build_module_states(services);
    create_router_with_states(states)
}

pub fn create_router_with_states(states: ModuleStates) -> Router {
    Router::new()
        .route("/health", get(health_check))
        .route("/ws", get(websocket_events))
        .route("/api/system/status", get(system_status))
        .route(
            "/api/settings/client",
            get(get_client_settings).patch(patch_client_settings),
        )
        .route(
            "/api/agent-workspace",
            get(get_agent_workspace).post(save_agent_workspace),
        )
        .route(
            "/api/memory/settings",
            get(get_memory_settings).post(save_memory_settings),
        )
        .route("/api/agent-permissions", get(list_agent_permissions))
        .route(
            "/api/agent-permissions/respond",
            post(respond_agent_permission),
        )
        .route("/api/settings/model-selection", post(save_model_selection))
        .route(
            "/api/settings/runtime-control-options",
            post(settings_runtime_control_options),
        )
        .route("/api/providers", get(list_providers).post(create_provider))
        .route("/api/providers/test", post(test_provider))
        .route("/api/providers/resolve", post(resolve_model_runtime))
        .route(
            "/api/engines/hermes/runtime-config",
            post(prepare_hermes_runtime_config),
        )
        .route("/api/mia/context", get(mia_context_snapshot))
        .route("/api/mia/skills/current", get(list_current_mia_skills))
        .route("/api/mia/skills/current/read", get(read_current_mia_skill))
        .route("/api/mia/memory", post(mutate_mia_memory))
        .route("/api/engines/model-catalog", get(engine_model_catalog))
        .route("/api/engines/codex/models", get(codex_models))
        .route("/api/engines/capabilities", get(engine_capabilities))
        .route("/api/engines/agents", get(agent_engines))
        .route("/api/engines/slash-commands", get(hermes_slash_commands))
        .route("/api/agents/commands/list", post(list_agent_commands))
        .route("/api/agents/commands/execute", post(execute_agent_command))
        .route(
            "/api/attachments/save",
            post(save_attachment).layer(DefaultBodyLimit::max(40 * 1024 * 1024)),
        )
        .route("/api/attachments/file", post(fetch_file_attachment))
        .route("/api/bots", get(list_bots).post(create_bot))
        .route(
            "/api/bots/runtime-target-options",
            post(bot_runtime_target_options),
        )
        .route(
            "/api/bots/runtime-control-options",
            post(bot_runtime_control_options),
        )
        .route("/api/bots/capability-options", post(bot_capability_options))
        .route("/api/bots/starter-ensure", post(ensure_starter_bots))
        .route(
            "/api/bots/{bot_id}",
            get(get_bot).patch(update_bot).delete(delete_bot),
        )
        .route(
            "/api/bots/{bot_id}/memory",
            get(get_bot_memory).patch(replace_bot_memory_entry),
        )
        .route(
            "/api/bots/{bot_id}/runtime",
            get(get_bot_runtime).post(save_bot_runtime),
        )
        .route(
            "/api/bots/{bot_id}/session-conversation",
            post(ensure_bot_session_conversation),
        )
        .route(
            "/api/conversations",
            get(list_conversations).post(create_conversation),
        )
        .route(
            "/api/conversations/skill-materialization",
            post(materialize_conversation_skills),
        )
        .route(
            "/api/conversations/agent-session-skill-runtime",
            post(plan_agent_session_skills),
        )
        .route(
            "/api/conversations/utility-turns",
            post(run_conversation_utility_turn),
        )
        .route(
            "/api/conversations/{conversation_id}",
            get(get_conversation).delete(delete_conversation),
        )
        .route(
            "/api/conversations/{conversation_id}/runtime-controls/prepare",
            post(prepare_conversation_runtime_controls),
        )
        .route(
            "/api/conversations/{conversation_id}/runtime-controls",
            axum::routing::patch(set_conversation_runtime_control),
        )
        .route(
            "/api/conversations/{conversation_id}/messages",
            get(list_conversation_messages).post(send_conversation_message),
        )
        .route(
            "/api/conversations/{conversation_id}/turns/{turn_id}/cancel",
            post(cancel_conversation_turn),
        )
        .route("/api/tasks/jobs", get(list_task_jobs).post(create_task_job))
        .route(
            "/api/tasks/jobs/{job_id}",
            get(get_task_job)
                .patch(update_task_job)
                .delete(delete_task_job),
        )
        .route("/api/tasks/jobs/{job_id}/run", post(run_task_job))
        .route("/api/tasks/cloud", get(list_cloud_tasks))
        .route(
            "/api/tasks/cloud/{task_id}",
            get(get_cloud_task)
                .patch(update_cloud_task)
                .delete(delete_cloud_task),
        )
        .route("/api/tasks/cloud/{task_id}/pause", post(pause_cloud_task))
        .route("/api/tasks/cloud/{task_id}/resume", post(resume_cloud_task))
        .route(
            "/api/tasks/cloud/{task_id}/run-now",
            post(run_cloud_task_now),
        )
        .route(
            "/api/mcp/servers",
            get(list_mcp_servers).post(create_mcp_server),
        )
        .route("/api/mcp/servers/import", post(import_mcp_servers))
        .route(
            "/api/mcp/servers/install-template",
            post(install_mcp_template),
        )
        .route(
            "/api/mcp/servers/{server_id}",
            get(get_mcp_server)
                .patch(update_mcp_server)
                .delete(delete_mcp_server),
        )
        .route("/api/mcp/servers/{server_id}/test", post(test_mcp_server))
        .route(
            "/api/mcp/servers/{server_id}/managed-actions/{action}",
            post(run_mcp_managed_action),
        )
        .route("/api/mcp/marketplace", get(mcp_marketplace))
        .route("/api/mcp/sync", post(sync_mcp))
        .route("/api/mcp/bridge/refresh", post(refresh_mcp_bridge))
        .route("/api/mcp/tools", get(list_mcp_tools))
        .route("/api/mcp/agent-configs", get(get_mcp_agent_configs))
        .route(
            "/api/mcp/agent-configs/import",
            post(import_mcp_agent_config),
        )
        .route(
            "/api/mcp/agent-configs/remove",
            post(remove_mcp_from_agents),
        )
        .route("/api/mcp/oauth/{server_id}/status", get(mcp_oauth_status))
        .route("/api/mcp/oauth/{server_id}/login", post(mcp_oauth_login))
        .route("/api/mcp/oauth/{server_id}/logout", post(mcp_oauth_logout))
        .route("/api/cloud/status", get(cloud_status))
        .route("/api/cloud/connect", post(connect_cloud))
        .route("/api/cloud/disconnect", post(disconnect_cloud))
        .route("/api/cloud/memory/sync", post(sync_cloud_memory))
        .route("/api/cloud/bridge/run", post(run_cloud_bridge))
        .route("/api/cloud/bridge/run-async", post(run_cloud_bridge_async))
        .route(
            "/api/cloud/bridge/runtime-controls/prepare",
            post(prepare_cloud_bridge_runtime_controls),
        )
        .route(
            "/api/cloud/bridge/runtime-controls",
            axum::routing::patch(set_cloud_bridge_runtime_control),
        )
        .route("/api/cloud/bridge/cancel", post(cancel_cloud_bridge_run))
        .route("/api/cloud/bridge/start", post(start_cloud_bridge))
        .route("/api/cloud/bridge/stop", post(stop_cloud_bridge))
        .route("/api/cloud/events/start", post(start_cloud_events))
        .route("/api/cloud/events/stop", post(stop_cloud_events))
        .route(
            "/api/cloud/settings",
            get(get_cloud_settings).put(put_cloud_settings),
        )
        .with_state(states)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use std::time::Duration;

    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use mia_core_conversation::{EVENT_CONVERSATION_CREATED, EVENT_CONVERSATION_MESSAGE_CREATED};
    use mia_core_realtime::RealtimeEvent;
    use mia_core_runtime::{
        EVENT_RUNTIME_CANCEL_REQUESTED, EVENT_RUNTIME_FINISHED, EVENT_RUNTIME_STDOUT,
        NativeAcpBackend, NativeAcpSessionManager, RuntimeBuilder, RuntimeCancellation,
        RuntimeCommand, RuntimeEventSink, RuntimeExecutionResult, RuntimeSessionManager,
        RuntimeTurnPlan,
    };
    use mia_core_tasks::{
        EVENT_TASK_CREATED, EVENT_TASK_RUN_FINISHED, EVENT_TASK_RUN_STARTED, EVENT_TASK_UPDATED,
    };
    use serde_json::{Value, json};
    use sqlx::Row;
    use tokio::time::timeout;
    use tower::ServiceExt;

    use crate::scheduler::run_due_tasks_once;
    use crate::{AppConfig, AppServices};
    use mia_core_conversation::ConversationService;

    use super::*;

    #[tokio::test]
    async fn health_route_reports_core_process_state() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        config.parent_pid = Some(4321);
        let services = AppServices::from_config(&config).await.unwrap();
        let response = create_router(&services)
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["ok"], true);
        assert_eq!(json["mode"], "daemon");
        assert_eq!(
            json["runtimeHome"],
            temp.path().to_string_lossy().to_string()
        );
        assert_eq!(json["daemonTarget"]["kind"], "rust-core");
        assert_eq!(json["daemonTarget"]["usesGuiAppIdentity"], false);
        assert_eq!(json["daemonTarget"]["parentPid"], 4321);
    }

    #[tokio::test]
    async fn conversation_runtime_controls_prepare_returns_native_acp_snapshot() {
        struct SnapshotBackend;

        #[async_trait::async_trait]
        impl NativeAcpBackend for SnapshotBackend {
            async fn send_message(
                &self,
                _plan: RuntimeTurnPlan,
                _sink: RuntimeEventSink,
                _cancellation: Option<RuntimeCancellation>,
            ) -> anyhow::Result<RuntimeExecutionResult> {
                unreachable!("preparing controls must not send a prompt")
            }

            async fn prepare_session(
                &self,
                plan: RuntimeTurnPlan,
            ) -> anyhow::Result<mia_core_api_types::AcpRuntimeControlSnapshot> {
                Ok(mia_core_api_types::AcpRuntimeControlSnapshot {
                    conversation_id: plan.conversation_id,
                    engine: plan.engine,
                    memory_mode: String::new(),
                    session_id: Some("session-route".into()),
                    state: "ready".into(),
                    controls: vec![],
                    error: String::new(),
                })
            }
        }

        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        sqlx::query(
            "INSERT INTO bots (id, display_name, avatar_json, capability_json, identity_json, created_at, updated_at)
             VALUES ('bot_route_codex', 'Codex', '{}', '{}', '{}', 1, 1)",
        )
        .execute(services.database.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO bot_runtime_bindings (bot_id, runtime_kind, binding_json, updated_at)
             VALUES ('bot_route_codex', 'desktop-local', ?, 1)",
        )
        .bind(
            json!({
                "runtimeKind": "desktop-local",
                "agentEngine": "codex",
                "config": { "agentEngine": "codex" }
            })
            .to_string(),
        )
        .execute(services.database.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversations (id, kind, title, bot_id, runtime_json, metadata_json, created_at, updated_at)
             VALUES ('conv_route_controls', 'bot_session', 'Codex', 'bot_route_codex', '{}', '{}', 1, 1)",
        )
        .execute(services.database.pool())
        .await
        .unwrap();
        let mut states = build_module_states(&services);
        states.runtime_sessions = RuntimeSessionManager::new(
            NativeAcpSessionManager::with_backend_for_tests(std::sync::Arc::new(SnapshotBackend)),
        );

        let response = create_router_with_states(states)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/conversations/conv_route_controls/runtime-controls/prepare")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["conversationId"], "conv_route_controls");
        assert_eq!(body["engine"], "codex");
        assert_eq!(body["sessionId"], "session-route");
    }

    #[tokio::test]
    async fn attachment_routes_save_data_urls_and_read_local_files_in_core() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);

        let save_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/attachments/save")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"name":"../bad<>name.png","dataUrl":"data:image/png;base64,cG5n"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(save_response.status(), StatusCode::OK);
        let save_body: Value = serde_json::from_slice(
            &to_bytes(save_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(save_body["name"], "bad__name.png");
        assert_eq!(save_body["mime"], "image/png");
        assert_eq!(save_body["kind"], "image");
        assert_eq!(save_body["size"], 3);
        let saved_path = save_body["path"].as_str().unwrap();
        assert!(saved_path.starts_with(temp.path().join("attachments").to_str().unwrap()));
        assert_eq!(fs::read_to_string(saved_path).unwrap(), "png");

        let xlsx_path = temp.path().join("sheet.xlsx");
        fs::write(&xlsx_path, b"xlsx bytes").unwrap();
        let read_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/attachments/file")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "path": xlsx_path.to_string_lossy().to_string() }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read_response.status(), StatusCode::OK);
        let read_body: Value = serde_json::from_slice(
            &to_bytes(read_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(read_body["name"], "sheet.xlsx");
        assert_eq!(
            read_body["mime"],
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        assert_eq!(read_body["kind"], "file");
        assert_eq!(
            read_body["dataUrl"],
            "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,eGxzeCBieXRlcw=="
        );
    }

    #[tokio::test]
    async fn engine_catalog_routes_return_core_owned_fallbacks() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);

        let catalog_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/engines/model-catalog")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(catalog_response.status(), StatusCode::OK);
        let catalog: Value = serde_json::from_slice(
            &to_bytes(catalog_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(
            catalog["models"]
                .as_array()
                .is_some_and(|rows| rows.iter().all(|row| row["provider"] != "openai-codex"))
        );
        assert!(
            catalog["models"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|row| row["provider"] == "anthropic"))
        );

        let codex_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/engines/codex/models")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(codex_response.status(), StatusCode::OK);
        let codex: Value = serde_json::from_slice(
            &to_bytes(codex_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(codex["models"].is_array());

        let capabilities_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/engines/capabilities")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(capabilities_response.status(), StatusCode::OK);
        let capabilities: Value = serde_json::from_slice(
            &to_bytes(capabilities_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(capabilities["approvalModes"], json!([]));
        assert_eq!(capabilities["effortLevels"], json!([]));
        assert!(capabilities["engines"]["hermes"].is_object());
        assert!(capabilities["engines"]["codex"]["models"].is_array());

        let slash_response = app
            .oneshot(
                Request::builder()
                    .uri("/api/engines/slash-commands")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(slash_response.status(), StatusCode::OK);
        let slash: Value = serde_json::from_slice(
            &to_bytes(slash_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(slash["commands"].is_array());
    }

    #[tokio::test]
    async fn agent_command_routes_scan_execute_and_bind_sessions_in_core() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let project = temp.path().join("repo");
        let home = temp.path().join("home");
        let command_root = project.join(".claude").join("commands");
        fs::create_dir_all(&command_root).unwrap();
        fs::create_dir_all(&home).unwrap();
        let command_path = command_root.join("review.md");
        fs::write(
            &command_path,
            [
                "---",
                "description: Review a target",
                "---",
                "Review $1 with $ARGUMENTS.",
                "Read @README.md and run !npm test.",
            ]
            .join("\n"),
        )
        .unwrap();
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);

        let list_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/agents/commands/list")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "engine": "claude-code",
                            "projectPath": project,
                            "homeDir": home
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let list: Value = serde_json::from_slice(
            &to_bytes(list_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(list["rows"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|row| row["command"] == "/resume" && row["type"] == "bridge")
        }));
        assert!(list["rows"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|row| row["command"] == "/review" && row["type"] == "custom")
        }));

        let custom_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/agents/commands/execute")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "engine": "claude-code",
                            "commandName": "/review",
                            "commandPath": command_path,
                            "args": ["src/main.js", "--fast"],
                            "context": { "projectPath": project }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(custom_response.status(), StatusCode::OK);
        let custom: Value = serde_json::from_slice(
            &to_bytes(custom_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(custom["type"], "custom");
        assert_eq!(
            custom["content"],
            "Review src/main.js with src/main.js --fast.\nRead @README.md and run !npm test."
        );
        assert_eq!(custom["metadata"]["description"], "Review a target");
        assert_eq!(custom["hasFileIncludes"], true);
        assert_eq!(custom["hasBashCommands"], true);

        let next_id = "44444444-2222-4333-8444-555555555555";
        let resume_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/agents/commands/execute")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "engine": "claude-code",
                            "commandName": "/resume",
                            "args": [next_id],
                            "context": {
                                "projectPath": project,
                                "sessionId": "local_1",
                                "sourceDeviceId": "device_1",
                                "bot": { "key": "alice", "name": "Alice" }
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resume_response.status(), StatusCode::OK);
        let resume: Value = serde_json::from_slice(
            &to_bytes(resume_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(resume["type"], "builtin");
        assert!(resume["content"].as_str().unwrap().contains(next_id));
        let sessions: Value = serde_json::from_str(
            &fs::read_to_string(temp.path().join("mia-agent-sessions.json")).unwrap(),
        )
        .unwrap();
        assert!(
            sessions
                .as_object()
                .unwrap()
                .values()
                .any(|value| value == next_id)
        );
    }

    #[tokio::test]
    async fn system_routes_round_trip_client_settings_and_provider_contracts() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);

        let patch_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/settings/client")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"patch":{"language":"zh","theme":"dark"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(patch_response.status(), StatusCode::OK);

        let settings_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/settings/client")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(settings_response.status(), StatusCode::OK);

        let workspace_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/agent-workspace")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(workspace_response.status(), StatusCode::OK);
        let workspace_body = to_bytes(workspace_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let workspace: Value = serde_json::from_slice(&workspace_body).unwrap();
        let default_workspace_text = config.workspace_dir.to_string_lossy().to_string();
        assert_eq!(workspace["path"].as_str().unwrap(), default_workspace_text);
        assert_eq!(workspace["custom"].as_str().unwrap(), "");
        assert_eq!(
            workspace["default"].as_str().unwrap(),
            default_workspace_text
        );

        let picked_workspace = temp.path().join("picked-workspace");
        fs::create_dir_all(&picked_workspace).unwrap();
        let picked_workspace_text = picked_workspace.to_string_lossy().to_string();
        let save_workspace_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/agent-workspace")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "path": picked_workspace_text }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(save_workspace_response.status(), StatusCode::OK);
        let save_workspace_body = to_bytes(save_workspace_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let saved_workspace: Value = serde_json::from_slice(&save_workspace_body).unwrap();
        assert_eq!(
            saved_workspace["path"].as_str().unwrap(),
            picked_workspace_text
        );
        assert_eq!(
            saved_workspace["custom"].as_str().unwrap(),
            picked_workspace_text
        );

        let memory_settings_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/memory/settings")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(memory_settings_response.status(), StatusCode::OK);
        let memory_settings_body = to_bytes(memory_settings_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let memory_settings: Value = serde_json::from_slice(&memory_settings_body).unwrap();
        assert_eq!(memory_settings["enabled"], true);

        let save_memory_settings_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/memory/settings")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"enabled":false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(save_memory_settings_response.status(), StatusCode::OK);
        let save_memory_settings_body =
            to_bytes(save_memory_settings_response.into_body(), usize::MAX)
                .await
                .unwrap();
        let saved_memory_settings: Value =
            serde_json::from_slice(&save_memory_settings_body).unwrap();
        assert_eq!(saved_memory_settings["enabled"], false);

        let agent_permissions_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/agent-permissions?sessionId=s1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(agent_permissions_response.status(), StatusCode::OK);
        let agent_permissions_body = to_bytes(agent_permissions_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let agent_permissions: Value = serde_json::from_slice(&agent_permissions_body).unwrap();
        assert_eq!(agent_permissions["requests"].as_array().unwrap().len(), 0);

        let permission_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/agent-permissions/respond")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"requestId":"missing","decision":"allow_once"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(permission_response.status(), StatusCode::OK);
        let permission_body = to_bytes(permission_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let permission_result: Value = serde_json::from_slice(&permission_body).unwrap();
        assert_eq!(permission_result["ok"], false);
        assert_eq!(
            permission_result["error"].as_str().unwrap(),
            "permission request not found"
        );

        let model_selection_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/settings/model-selection")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"selection":{"provider":"anthropic","providerConnectionId":"anthropic-main","providerLabel":"Claude","authType":"api_key","model":"claude-3-5-sonnet","modelProfileId":"anthropic-main:claude-3-5-sonnet","apiKeyEnv":"ANTHROPIC_API_KEY","apiKey":"stored-key","baseUrl":"https://api.anthropic.com","apiMode":"messages"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(model_selection_response.status(), StatusCode::OK);
        let model_selection_body = to_bytes(model_selection_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let model_selection: Value = serde_json::from_slice(&model_selection_body).unwrap();
        assert_eq!(
            model_selection["settings"]["providerConnectionId"],
            "anthropic-main"
        );
        assert!(model_selection["settings"].get("apiKey").is_none());

        let settings_runtime_options_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/settings/runtime-control-options")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"activeAgentEngine":"codex","runtime":{"permissions":{"engines":{"codex":":workspace"}}},"engineConfig":{"model":"gpt-5.3-codex","effortLevel":"xhigh"},"engineCapabilities":{"engines":{"codex":{"permissionProfiles":[{"id":":workspace"}],"models":[{"slug":"gpt-5.3-codex","displayName":"GPT-5.3 Codex","supportedReasoningLevels":[{"effort":"xhigh","label":"Extra high"}]}]}}}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(settings_runtime_options_response.status(), StatusCode::OK);
        let settings_runtime_options_body =
            to_bytes(settings_runtime_options_response.into_body(), usize::MAX)
                .await
                .unwrap();
        let settings_runtime_options: Value =
            serde_json::from_slice(&settings_runtime_options_body).unwrap();
        assert_eq!(settings_runtime_options["agentEngine"], "codex");
        assert_eq!(settings_runtime_options["selectedModel"], "gpt-5.3-codex");
        assert_eq!(settings_runtime_options["selectedEffort"], "xhigh");
        assert_eq!(settings_runtime_options["selectedPermission"], ":workspace");

        let create_provider_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/providers")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"id":"openai-main","kind":"openai","displayName":"OpenAI","baseUrl":"https://api.openai.com/v1","apiKeyEnv":"OPENAI_API_KEY","apiKey":"secret-key","apiMode":"responses","authType":"api_key","models":["gpt-5"],"enabled":true}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(create_provider_response.status(), StatusCode::OK);

        let providers_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/providers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(providers_response.status(), StatusCode::OK);

        let resolve_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/providers/resolve")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"config":{"providerConnectionId":"openai-main","model":"gpt-5"},"context":{"engine":"hermes"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resolve_response.status(), StatusCode::OK);
        let resolve_body = to_bytes(resolve_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let resolved: Value = serde_json::from_slice(&resolve_body).unwrap();
        assert_eq!(resolved["runtime"]["providerConnectionId"], "openai-main");
        assert_eq!(resolved["runtime"]["apiKey"], "secret-key");

        let hermes_home = temp.path().join(".hermes");
        let engine_home = temp.path().join("engine-home");
        let hermes_config = hermes_home.join("config.yaml");
        let api_server_key = hermes_home.join("mia-api-server.key");
        let bot_manifest = engine_home.join("bots").join("manifest.json");
        fs::create_dir_all(&hermes_home).unwrap();
        let runtime_config_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/engines/hermes/runtime-config")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "port": 19191,
                            "paths": {
                                "home": engine_home,
                                "hermesHome": hermes_home,
                                "config": hermes_config,
                                "apiServerKey": api_server_key,
                                "botManifest": bot_manifest
                            },
                            "permissionSettings": { "mode": "ask" },
                            "effortSettings": { "level": "high" },
                            "miaAppMcpSpec": null,
                            "schedulerMcpSpec": null,
                            "userMcpSpecs": {}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(runtime_config_response.status(), StatusCode::OK);
        let runtime_config_body = to_bytes(runtime_config_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let runtime_config: Value = serde_json::from_slice(&runtime_config_body).unwrap();
        assert_eq!(runtime_config["ok"], true);
        assert!(runtime_config["apiServerKey"].as_str().unwrap().len() >= 32);
        let hermes_config_yaml: Value =
            serde_yaml::from_str(&fs::read_to_string(&hermes_config).unwrap()).unwrap();
        assert_eq!(hermes_config_yaml["model"]["provider"], "anthropic");
        assert_eq!(
            hermes_config_yaml["providers"]["anthropic"]["api_key"],
            "stored-key"
        );
        assert_eq!(hermes_config_yaml["platforms"]["api_server"]["port"], 19191);

        let test_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/providers/test")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"providerId":null,"candidate":{"kind":"openai","apiKey":"secret"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(test_response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn mia_context_route_uses_the_conversation_fixed_memory_mode() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let bot = services
            .bot
            .create_bot(mia_core_api_types::CreateBotRequest {
                display_name: "研究员".to_string(),
                identity: json!({
                    "personaText": "你是负责文献梳理的研究助手。",
                    "bio": "整理重点。"
                }),
                capabilities: json!({ "enabledSkills": ["mia-official:paper-research"] }),
            })
            .await
            .unwrap()
            .bot;
        let conversation = services
            .conversation
            .create_conversation(mia_core_api_types::CreateConversationRequest {
                kind: "bot_session".into(),
                title: "Native conversation".into(),
                bot_id: Some(bot.id.clone()),
                metadata: json!({ "memoryMode": "native" }),
            })
            .await
            .unwrap();
        let app = create_router(&services);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/mia/context?conversationId={}&botId=spoofed&originMessageId=m1",
                        conversation.conversation.id
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let context: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(context["botId"], bot.id);
        assert_eq!(context["sessionId"], conversation.conversation.id);
        assert_eq!(context["originMessageId"], "m1");
        assert_eq!(context["persona"], "你是负责文献梳理的研究助手。");
        assert_eq!(context["memoryMode"], "native");
        assert!(context.get("memory").is_none());
        assert_eq!(context["memoryTools"]["enabled"], false);
        assert_eq!(context["memoryTools"]["memory"], "memory");
        assert_eq!(context["skillTools"]["readCurrent"], "skill_read_current");

        let missing = app
            .oneshot(
                Request::builder()
                    .uri("/api/mia/context?conversationId=missing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn mia_current_skill_routes_are_core_owned_and_bot_scoped() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let skill_dir = config.data_dir.join("skills").join("demo-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo-skill\ndescription: Demo skill.\n---\n# Demo Skill\nUse this guide.",
        )
        .unwrap();
        let services = AppServices::from_config(&config).await.unwrap();
        let bot = services
            .bot
            .create_bot(mia_core_api_types::CreateBotRequest {
                display_name: "技能助手".to_string(),
                identity: json!({}),
                capabilities: json!({ "enabledSkills": ["demo-skill", "missing"], "disabledSkills": ["missing"] }),
            })
            .await
            .unwrap()
            .bot;
        let app = create_router(&services);

        let list_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/mia/skills/current?botId={}", bot.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let list_body = to_bytes(list_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let listed: Value = serde_json::from_slice(&list_body).unwrap();
        assert_eq!(listed["botId"], bot.id);
        let skills = listed["skills"].as_array().unwrap();
        assert_eq!(skills.len(), 3);
        let demo = skills
            .iter()
            .find(|skill| skill["id"] == "demo-skill")
            .unwrap();
        assert_eq!(demo["name"], "demo-skill");
        assert_eq!(demo["description"], "Demo skill.");
        assert!(demo["bodyChars"].as_u64().unwrap() > 0);
        assert!(skills.iter().any(|skill| skill["id"] == "mia-scheduler"));
        assert!(
            skills
                .iter()
                .any(|skill| skill["id"] == "mia-official:officecli")
        );

        let read_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/mia/skills/current/read?botId={}&id=demo-skill",
                        bot.id
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read_response.status(), StatusCode::OK);
        let read_body = to_bytes(read_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let read: Value = serde_json::from_slice(&read_body).unwrap();
        assert_eq!(read["botId"], bot.id);
        assert_eq!(read["skill"]["id"], "demo-skill");
        assert!(
            read["skill"]["body"]
                .as_str()
                .unwrap()
                .contains("# Demo Skill")
        );

        let missing_response = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/mia/skills/current/read?botId={}&id=missing",
                        bot.id
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn mia_memory_route_uses_trusted_conversation_ownership() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        services
            .system
            .patch_client_settings(json!({ "userId": "user_real" }))
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO bots (id, display_name, avatar_json, capability_json, identity_json, created_at, updated_at)
             VALUES ('bot_real', 'Real Bot', '{}', '{}', '{}', 1, 1)",
        )
        .execute(services.database.pool())
        .await
        .unwrap();
        for (id, bot_id, mode) in [
            ("conv_mia", Some("bot_real"), "mia"),
            ("conv_native", Some("bot_real"), "native"),
            ("conv_without_bot", None, "mia"),
        ] {
            sqlx::query(
                "INSERT INTO conversations (id, kind, title, bot_id, runtime_json, metadata_json, created_at, updated_at)
                 VALUES (?, 'bot_session', ?, ?, '{}', ?, 1, 1)",
            )
            .bind(id)
            .bind(id)
            .bind(bot_id)
            .bind(json!({ "memoryMode": mode }).to_string())
            .execute(services.database.pool())
            .await
            .unwrap();
        }
        let app = create_router(&services);

        let add_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mia/memory")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"context":{"conversationId":"conv_mia","userId":"user_spoofed","botId":"bot_real"},"action":"add","target":"user","content":"用户偏好简洁回答"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(add_response.status(), StatusCode::OK);
        let add_body = to_bytes(add_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let added: Value = serde_json::from_slice(&add_body).unwrap();
        assert_eq!(added["success"], true);
        assert_eq!(added["currentEntries"], json!(["用户偏好简洁回答"]));
        assert_eq!(
            services
                .memory
                .document(
                    "user_real",
                    "bot_real",
                    mia_core_api_types::MiaMemoryTarget::Memory
                )
                .await
                .unwrap()
                .text,
            "用户偏好简洁回答"
        );
        assert!(
            services
                .memory
                .document("user_real", "", mia_core_api_types::MiaMemoryTarget::User)
                .await
                .unwrap()
                .text
                .is_empty()
        );

        let mismatch_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mia/memory")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"context":{"conversationId":"conv_mia","botId":"bot_spoofed"},"action":"add","target":"memory","content":"不可写入"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(mismatch_response.status(), StatusCode::FORBIDDEN);
        let mismatch_body = to_bytes(mismatch_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let mismatch: Value = serde_json::from_slice(&mismatch_body).unwrap();
        assert_eq!(mismatch["error"], "conversation_bot_mismatch");

        let native_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mia/memory")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"context":{"conversationId":"conv_native","botId":"bot_real"},"action":"add","target":"memory","content":"不可写入"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(native_response.status(), StatusCode::CONFLICT);
        let native_body = to_bytes(native_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let native_error: Value = serde_json::from_slice(&native_body).unwrap();
        assert_eq!(native_error["error"], "native_memory_owner");

        let no_bot_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mia/memory")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"context":{"conversationId":"conv_without_bot"},"action":"add","target":"memory","content":"不可写入"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(no_bot_response.status(), StatusCode::FORBIDDEN);
        let no_bot_body = to_bytes(no_bot_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let no_bot: Value = serde_json::from_slice(&no_bot_body).unwrap();
        assert_eq!(no_bot["error"], "conversation_bot_required");

        let business_failure = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mia/memory")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"context":{"conversationId":"conv_mia","botId":"bot_real"},"action":"remove","target":"memory","oldText":"不存在"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(business_failure.status(), StatusCode::OK);
        let failure_body = to_bytes(business_failure.into_body(), usize::MAX)
            .await
            .unwrap();
        let failure: Value = serde_json::from_slice(&failure_body).unwrap();
        assert_eq!(failure["success"], false);
        assert_eq!(failure["error"], "old_text_not_found");

        let missing_conversation = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mia/memory")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"context":{"conversationId":"missing","botId":"bot_real"},"action":"add","target":"memory","content":"不可写入"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_conversation.status(), StatusCode::NOT_FOUND);

        for route in ["search", "list", "remember", "update", "forget", "delete"] {
            let old_route = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/api/mia/memory/{route}"))
                        .header("content-type", "application/json")
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(old_route.status(), StatusCode::NOT_FOUND, "{route}");
        }
    }

    #[tokio::test]
    async fn bot_memory_management_route_supports_cloud_owned_bot_keys() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        services
            .system
            .patch_client_settings(json!({ "userId": "user_real" }))
            .await
            .unwrap();
        services
            .memory
            .mutate(
                "user_real",
                "bot_cloud_owned",
                mia_core_api_types::MiaMemoryToolRequest {
                    context: json!({}),
                    action: mia_core_api_types::MiaMemoryAction::Add,
                    old_text: None,
                    content: Some("Codex 回复时保持简洁。".to_string()),
                },
            )
            .await
            .unwrap();
        let app = create_router(&services);

        let read_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/bots/bot_cloud_owned/memory")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read_response.status(), StatusCode::OK);
        let read_body = to_bytes(read_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let read: Value = serde_json::from_slice(&read_body).unwrap();
        assert_eq!(read["mode"], "mia");
        assert_eq!(read["entries"], json!(["Codex 回复时保持简洁。"]));
        assert!(read.get("text").is_none());

        let edit_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/bots/bot_cloud_owned/memory")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"oldText":"Codex 回复时保持简洁。","content":"Codex 回复要简洁、直接。"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(edit_response.status(), StatusCode::OK);
        let edit_body = to_bytes(edit_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let edited: Value = serde_json::from_slice(&edit_body).unwrap();
        assert_eq!(edited["entries"], json!(["Codex 回复要简洁、直接。"]));
        assert_eq!(edited["revision"], 2);

        services
            .system
            .save_memory_settings(mia_core_api_types::SaveMemorySettingsRequest {
                mode: Some(mia_core_api_types::MemoryMode::Native),
                enabled: None,
            })
            .await
            .unwrap();
        let native_read_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/bots/bot_cloud_owned/memory")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(native_read_response.status(), StatusCode::OK);
        let native_read_body = to_bytes(native_read_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let native_read: Value = serde_json::from_slice(&native_read_body).unwrap();
        assert_eq!(native_read["mode"], "native");
        assert_eq!(native_read["entries"], json!([]));

        let native_edit_response = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/bots/bot_cloud_owned/memory")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"oldText":"Codex 回复要简洁、直接。","content":"不应写入"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(native_edit_response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn bot_routes_round_trip_core_owned_identity_runtime_and_session_conversation() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);

        let marketplace_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/mcp/marketplace")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(marketplace_response.status(), StatusCode::OK);
        let marketplace_body = to_bytes(marketplace_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let marketplace: Value = serde_json::from_slice(&marketplace_body).unwrap();
        assert_eq!(marketplace["templates"][0]["id"], "playwright");

        let install_template_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mcp/servers/install-template")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"templateId":"playwright","values":{}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(install_template_response.status(), StatusCode::OK);
        let install_template_body = to_bytes(install_template_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let installed_template: Value = serde_json::from_slice(&install_template_body).unwrap();
        assert_eq!(installed_template["server"]["registryId"], "playwright");

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"displayName":"Mia Helper","identity":{"persona":"direct"},"capabilities":{"tools":true}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);
        let create_body = to_bytes(create_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: Value = serde_json::from_slice(&create_body).unwrap();
        let bot_id = created["bot"]["id"].as_str().unwrap();
        assert!(bot_id.starts_with("bot_"));

        let target_options_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/runtime-target-options")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"bot":{"runtimeKind":"desktop-local","targetIntent":{"agentEngine":"codex","deviceId":"mac-local"}},"runtime":{"localDevice":{"id":"mac-local","name":"Office Mac"},"agentEngines":{"hermes":{"available":true},"codex":{"available":true}}},"engineCapabilities":{"engines":{}},"preferredAgentEngine":"hermes"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(target_options_response.status(), StatusCode::OK);
        let target_options_body = to_bytes(target_options_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let target_options: Value = serde_json::from_slice(&target_options_body).unwrap();
        assert_eq!(
            target_options["activeTarget"]["runtimeKind"],
            "desktop-local"
        );
        assert_eq!(target_options["runtimeLabel"], "本机运行");
        assert_eq!(target_options["runsOnOtherDevice"], false);
        assert_eq!(target_options["groups"][0]["label"], "本机");
        assert_eq!(
            target_options["groups"][0]["options"][1]["agentEngine"],
            "codex"
        );

        let control_options_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/runtime-control-options")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"runtimeKind":"desktop-local","bot":{"key":"codex","agentEngine":"codex"},"runtime":{"agentInventory":{"agents":[{"id":"codex","usableInMia":true,"health":"ready"}]},"permissions":{"engines":{"codex":":danger-full-access"}}},"binding":{"config":{"agentEngine":"codex","model":"gpt-5.3-codex","providerConnectionId":"codex","modelProfileId":"codex:gpt-5.3-codex","effortLevel":"xhigh"}},"engineCapabilities":{"engines":{"codex":{"models":[{"slug":"gpt-5.3-codex","displayName":"GPT-5.3 Codex","supportedReasoningLevels":[{"effort":"medium","label":"Medium"},{"effort":"xhigh","label":"X High"}]}],"permissionProfiles":[{"id":":danger-full-access","description":"Full Access"}]}}}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(control_options_response.status(), StatusCode::OK);
        let control_options_body = to_bytes(control_options_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let control_options: Value = serde_json::from_slice(&control_options_body).unwrap();
        assert_eq!(control_options["agentEngine"], "codex");
        assert_eq!(control_options["selectedModel"], "gpt-5.3-codex");
        assert_eq!(control_options["selectedEffort"], "xhigh");
        assert_eq!(control_options["selectedPermission"], ":danger-full-access");
        assert!(control_options.get("permissionSaveTarget").is_none());

        let capability_options_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots/capability-options")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"bot":{"key":"writer","agentEngine":"codex","capabilities":{"enabledSkills":["mia-official:paper-research"]}},"availableSkills":[{"id":"mia-official:paper-research","name":"paper-research","title":"Paper Research","source":"mia-official","engine":"codex"}],"intent":{"capabilityType":"skill","capabilityId":"mia-official:paper-research","checked":false}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(capability_options_response.status(), StatusCode::OK);
        let capability_options_body = to_bytes(capability_options_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let capability_options: Value = serde_json::from_slice(&capability_options_body).unwrap();
        assert_eq!(
            capability_options["capabilities"]["enabledSkills"],
            json!([])
        );
        assert_eq!(capability_options["summary"], "2 个默认技能");

        let runtime_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/bots/{bot_id}/runtime"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"runtimeKind":"agent","providerConnectionId":"provider_openai","modelProfileId":"profile_fast","model":"gpt-5-mini","config":{"temperature":0.2}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(runtime_response.status(), StatusCode::OK);

        let read_runtime_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/bots/{bot_id}/runtime?kind=agent"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read_runtime_response.status(), StatusCode::OK);
        let read_runtime_body = to_bytes(read_runtime_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let read_runtime: Value = serde_json::from_slice(&read_runtime_body).unwrap();
        assert_eq!(read_runtime["binding"]["modelProfileId"], "profile_fast");

        let first_session_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/bots/{bot_id}/session-conversation"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"sessionId":"sess_123","title":"Runner Session","runtimeKind":"agent","metadata":{"source":"route-test"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first_session_response.status(), StatusCode::OK);
        let first_session_body = to_bytes(first_session_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let first_session: Value = serde_json::from_slice(&first_session_body).unwrap();
        assert_eq!(first_session["created"], true);

        let second_session_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/bots/{bot_id}/session-conversation"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"sessionId":"sess_123","title":"Runner Session","runtimeKind":"agent","metadata":{"source":"route-test"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second_session_response.status(), StatusCode::OK);
        let second_session_body = to_bytes(second_session_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let second_session: Value = serde_json::from_slice(&second_session_body).unwrap();
        assert_eq!(second_session["created"], false);
        assert_eq!(
            first_session["conversationId"],
            second_session["conversationId"]
        );

        let list_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/bots")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let list_body = to_bytes(list_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let list: Value = serde_json::from_slice(&list_body).unwrap();
        assert_eq!(list["bots"][0]["id"], bot_id);

        let delete_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/bots/{bot_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::OK);

        let empty_list_response = app
            .oneshot(
                Request::builder()
                    .uri("/api/bots")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let empty_list_body = to_bytes(empty_list_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let empty_list: Value = serde_json::from_slice(&empty_list_body).unwrap();
        assert_eq!(empty_list["bots"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn bot_starter_route_materializes_default_bots_and_pins_memory_mode() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        services
            .system
            .save_memory_settings(mia_core_api_types::SaveMemorySettingsRequest {
                mode: Some(mia_core_api_types::MemoryMode::Native),
                enabled: None,
            })
            .await
            .unwrap();
        let app = create_router(&services);
        let starter_request = || {
            Request::builder()
                .method("POST")
                .uri("/api/bots/starter-ensure")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"userId":"u_123","now":"2026-06-26T08:00:00.000Z","runtime":{"cloud":{"enabled":true,"agentRuntime":{"runtimeKind":"cloud-claude-code","agentEngine":"claude-code","label":"Claude Code","available":true}},"localDevice":{"id":"mac-1","name":"Jung Mac.local Mia Desktop"},"agentInventory":{"agents":[{"id":"hermes","usableInMia":true}]}}}"#,
                ))
                .unwrap()
        };

        let starter_response = app.clone().oneshot(starter_request()).await.unwrap();
        assert_eq!(starter_response.status(), StatusCode::OK);
        let starter_body = to_bytes(starter_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let starter: Value = serde_json::from_slice(&starter_body).unwrap();
        assert_eq!(starter["skipped"], false);
        assert_eq!(starter["created"][0]["key"], "starter_u_123_mia");
        assert_eq!(starter["created"][1]["engineId"], "hermes");
        assert_eq!(
            starter["settings"]["starterEngineBots"]["engineIds"],
            json!(["cloud-claude-code", "hermes"])
        );
        for entry in starter["created"].as_array().unwrap() {
            let conversation = services
                .conversation
                .get_conversation(entry["conversationId"].as_str().unwrap())
                .await
                .unwrap();
            assert_eq!(conversation.conversation.metadata["memoryMode"], "native");
        }

        services
            .system
            .save_memory_settings(mia_core_api_types::SaveMemorySettingsRequest {
                mode: Some(mia_core_api_types::MemoryMode::Mia),
                enabled: None,
            })
            .await
            .unwrap();
        let again = app.clone().oneshot(starter_request()).await.unwrap();
        assert_eq!(again.status(), StatusCode::OK);
        for entry in starter["created"].as_array().unwrap() {
            let conversation = services
                .conversation
                .get_conversation(entry["conversationId"].as_str().unwrap())
                .await
                .unwrap();
            assert_eq!(conversation.conversation.metadata["memoryMode"], "native");
        }

        let list_response = app
            .oneshot(
                Request::builder()
                    .uri("/api/bots")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let list_body = to_bytes(list_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let list: Value = serde_json::from_slice(&list_body).unwrap();
        assert_eq!(list["bots"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn conversation_routes_pin_memory_mode_at_creation_time() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);

        let create = |title: &str| {
            Request::builder()
                .method("POST")
                .uri("/api/conversations")
                .header("content-type", "application/json")
                .body(Body::from(format!(
                    r#"{{"kind":"direct","title":"{title}","botId":null,"metadata":{{"source":"route"}}}}"#
                )))
                .unwrap()
        };

        let mia_response = app.clone().oneshot(create("Mia Before")).await.unwrap();
        assert_eq!(mia_response.status(), StatusCode::OK);
        let mia: Value = serde_json::from_slice(
            &to_bytes(mia_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        let mia_id = mia["conversation"]["id"].as_str().unwrap().to_string();
        assert_eq!(mia["conversation"]["metadata"]["memoryMode"], "mia");

        services
            .system
            .save_memory_settings(mia_core_api_types::SaveMemorySettingsRequest {
                mode: Some(mia_core_api_types::MemoryMode::Native),
                enabled: None,
            })
            .await
            .unwrap();
        let native_response = app.clone().oneshot(create("Native After")).await.unwrap();
        let native: Value = serde_json::from_slice(
            &to_bytes(native_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        let native_id = native["conversation"]["id"].as_str().unwrap().to_string();
        assert_eq!(native["conversation"]["metadata"]["memoryMode"], "native");

        let existing_mia = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/conversations/{mia_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let existing_mia: Value = serde_json::from_slice(
            &to_bytes(existing_mia.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            existing_mia["conversation"]["metadata"]["memoryMode"],
            "mia"
        );

        services
            .system
            .save_memory_settings(mia_core_api_types::SaveMemorySettingsRequest {
                mode: Some(mia_core_api_types::MemoryMode::Mia),
                enabled: None,
            })
            .await
            .unwrap();
        let mia_after_response = app.clone().oneshot(create("Mia After")).await.unwrap();
        let mia_after: Value = serde_json::from_slice(
            &to_bytes(mia_after_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(mia_after["conversation"]["metadata"]["memoryMode"], "mia");

        let existing_native = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/conversations/{native_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let existing_native: Value = serde_json::from_slice(
            &to_bytes(existing_native.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            existing_native["conversation"]["metadata"]["memoryMode"],
            "native"
        );
    }

    #[tokio::test]
    async fn bot_session_route_pins_memory_mode_without_overwriting_an_existing_session() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let bot = services
            .bot
            .create_bot(mia_core_api_types::CreateBotRequest {
                display_name: "Mode Bot".into(),
                identity: json!({}),
                capabilities: json!({}),
            })
            .await
            .unwrap()
            .bot;
        services
            .system
            .save_memory_settings(mia_core_api_types::SaveMemorySettingsRequest {
                mode: Some(mia_core_api_types::MemoryMode::Native),
                enabled: None,
            })
            .await
            .unwrap();
        let app = create_router(&services);

        let ensure = |session_id: &str, requested_mode: &str| {
            Request::builder()
                .method("POST")
                .uri(format!("/api/bots/{}/session-conversation", bot.id))
                .header("content-type", "application/json")
                .body(Body::from(format!(
                    r#"{{"sessionId":"{session_id}","title":"Mode Session","runtimeKind":"desktop-local","metadata":{{"source":"route","memoryMode":"{requested_mode}"}}}}"#
                )))
                .unwrap()
        };

        let first_response = app
            .clone()
            .oneshot(ensure("session_1", "invalid"))
            .await
            .unwrap();
        let first: Value = serde_json::from_slice(
            &to_bytes(first_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        let first_id = first["conversationId"].as_str().unwrap().to_string();
        let first_conversation = services
            .conversation
            .get_conversation(&first_id)
            .await
            .unwrap();
        assert_eq!(
            first_conversation.conversation.metadata["memoryMode"],
            "native"
        );

        services
            .system
            .save_memory_settings(mia_core_api_types::SaveMemorySettingsRequest {
                mode: Some(mia_core_api_types::MemoryMode::Mia),
                enabled: None,
            })
            .await
            .unwrap();
        let existing_response = app
            .clone()
            .oneshot(ensure("session_1", "mia"))
            .await
            .unwrap();
        let existing: Value = serde_json::from_slice(
            &to_bytes(existing_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(existing["created"], false);
        assert_eq!(existing["conversationId"], first_id);
        let existing_conversation = services
            .conversation
            .get_conversation(&first_id)
            .await
            .unwrap();
        assert_eq!(
            existing_conversation.conversation.metadata["memoryMode"],
            "native"
        );

        let fresh_response = app.oneshot(ensure("session_2", "invalid")).await.unwrap();
        let fresh: Value = serde_json::from_slice(
            &to_bytes(fresh_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        let fresh_conversation = services
            .conversation
            .get_conversation(fresh["conversationId"].as_str().unwrap())
            .await
            .unwrap();
        assert_eq!(
            fresh_conversation.conversation.metadata["memoryMode"],
            "mia"
        );
    }

    #[tokio::test]
    async fn conversation_routes_create_list_read_and_accept_user_message() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);
        let mut events = services.realtime.subscribe();

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/conversations")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"kind":"direct","title":"Planning","botId":null,"metadata":{"source":"route-test"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);
        let create_body = to_bytes(create_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: Value = serde_json::from_slice(&create_body).unwrap();
        let conversation_id = created["conversation"]["id"].as_str().unwrap();
        assert!(conversation_id.starts_with("conv_"));
        let created_event = next_event(&mut events).await;
        assert_eq!(created_event.name, EVENT_CONVERSATION_CREATED);
        assert_eq!(created_event.data["conversation"]["id"], conversation_id);

        let message_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/conversations/{conversation_id}/messages"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"body":"hello","attachments":[{"path":"/tmp/a.txt"},{"filePath":"/tmp/b.pdf"},{"url":"https://example.test/remote.txt"}],"selectedSkillIds":["skill_a"]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(message_response.status(), StatusCode::OK);
        let message_body = to_bytes(message_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let message: Value = serde_json::from_slice(&message_body).unwrap();
        assert!(message["messageId"].as_str().unwrap().starts_with("msg_"));
        assert!(message["turnId"].as_str().unwrap().starts_with("turn_"));
        assert!(
            message["assistantMessageId"]
                .as_str()
                .unwrap()
                .starts_with("msg_")
        );
        let message_event = next_event(&mut events).await;
        assert_eq!(message_event.name, EVENT_CONVERSATION_MESSAGE_CREATED);
        assert_eq!(message_event.data["conversationId"], conversation_id);
        assert_eq!(message_event.data["messageId"], message["messageId"]);
        assert_eq!(message_event.data["turnId"], message["turnId"]);

        let assistant = sqlx::query(
            "SELECT content_json FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1",
        )
        .bind(conversation_id)
        .fetch_one(services.database.pool())
        .await
        .unwrap();
        let assistant_content: Value =
            serde_json::from_str(&assistant.get::<String, _>("content_json")).unwrap();
        let runtime_send = &assistant_content["runtimePlan"]["sendMessage"];
        assert_eq!(runtime_send["content"], "hello");
        assert_eq!(runtime_send["msg_id"], message["messageId"]);
        assert_eq!(runtime_send["turn_id"], message["turnId"]);
        assert_eq!(runtime_send["files"], json!(["/tmp/a.txt", "/tmp/b.pdf"]));
        assert_eq!(runtime_send["inject_skills"], json!(["skill_a"]));

        let get_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/conversations/{conversation_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get_response.status(), StatusCode::OK);

        let list_response = app
            .oneshot(
                Request::builder()
                    .uri("/api/conversations")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let list_body = to_bytes(list_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let list: Value = serde_json::from_slice(&list_body).unwrap();
        assert_eq!(list["conversations"][0]["id"], conversation_id);
    }

    #[tokio::test]
    async fn conversation_route_runs_utility_turn_inside_core() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/conversations/utility-turns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"botId":"bot_missing","purpose":"translate","systemPrompt":"system","userPrompt":"hello"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert!(payload["turnId"].as_str().unwrap().starts_with("turn_"));
        assert_eq!(payload["engine"], "mock-agent");
        assert_eq!(
            payload["content"],
            "Mia Rust Core mock response: system\n\nhello"
        );
    }

    #[tokio::test]
    async fn conversation_route_materializes_turn_skills_inside_core() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/conversations/skill-materialization")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r##"{"availableSkills":[{"id":"mia-official:xlsx","name":"xlsx","description":"Excel deliverables","body":"# XLSX\nUse formulas."}],"activeSkillIds":[],"intentSkillIds":["xlsx"],"requestedSkillIds":[],"mode":"index"}"##,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let materialization: Value = serde_json::from_slice(&body).unwrap();

        assert!(
            materialization["indexBlock"]
                .as_str()
                .unwrap()
                .contains("## Available Mia Skills")
        );
        assert!(
            materialization["loadedBlock"]
                .as_str()
                .unwrap()
                .contains("=== Skill: xlsx ===")
        );
        assert_eq!(
            materialization["loadedSkillIds"],
            json!(["mia-official:xlsx"])
        );
    }

    #[tokio::test]
    async fn conversation_route_plans_agent_session_skill_runtime_inside_core() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let pdf_source = temp.path().join("source-pdf");
        let research_source = temp.path().join("source-deep-research");
        fs::create_dir_all(&pdf_source).unwrap();
        fs::create_dir_all(&research_source).unwrap();
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);
        let request = json!({
            "agentEngine": "codex",
            "runtimeConfig": {},
            "workspacePath": config.workspace_dir.to_string_lossy(),
            "sessionSkillIds": ["pdf"],
            "availableSkills": [
                {
                    "id": "pdf",
                    "name": "pdf",
                    "displayName": "PDF",
                    "description": "PDF guide",
                    "summary": "PDF guide",
                    "body": "# PDF",
                    "sourcePath": pdf_source.to_string_lossy(),
                    "linkName": "pdf"
                },
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "displayName": "Deep Research",
                    "description": "Research guide",
                    "summary": "Research guide",
                    "body": "# Deep",
                    "sourcePath": research_source.to_string_lossy(),
                    "linkName": "deep-research"
                }
            ],
            "activeSkillIds": ["deep-research"],
            "intentSkillIds": [],
            "requestedSkillIds": []
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/conversations/agent-session-skill-runtime")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&request).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let plan: Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(plan["deliveryMode"], "native-link");
        assert_eq!(plan["nativeSkillsDirs"], json!([".codex/skills"]));
        assert_eq!(plan["resolvedSkillIds"], json!(["pdf"]));
        assert_eq!(plan["managedSkillTargets"], json!([".codex/skills/pdf"]));
        assert_eq!(
            plan["manifestPath"],
            config
                .workspace_dir
                .join(".mia/skill-runtime.json")
                .to_string_lossy()
                .to_string()
        );
        assert!(
            plan["selectedSkillPrompt"]
                .as_str()
                .unwrap()
                .contains("source-deep-research/SKILL.md")
        );
        assert!(
            fs::symlink_metadata(config.workspace_dir.join(".codex/skills/pdf"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(
            !config
                .workspace_dir
                .join(".codex/skills/deep-research")
                .exists()
        );
    }

    #[tokio::test]
    async fn conversation_route_streams_external_runtime_output_and_persists_assistant_message() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let mut services = AppServices::from_config(&config).await.unwrap();
        services.conversation = ConversationService::with_runtime(
            services.database.pool().clone(),
            RuntimeBuilder::new(config.workspace_dir.to_string_lossy())
                .with_engine_command("test-stream", stdout_command("streamed assistant\n")),
        );
        let app = create_router(&services);

        let conversation_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/conversations")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"kind":"direct","title":"Runtime Stream","botId":null,"metadata":{"runtime":{"engine":"test-stream"}}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(conversation_response.status(), StatusCode::OK);
        let conversation_body = to_bytes(conversation_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let conversation: Value = serde_json::from_slice(&conversation_body).unwrap();
        let conversation_id = conversation["conversation"]["id"].as_str().unwrap();
        let mut events = services.realtime.subscribe();

        let message_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/conversations/{conversation_id}/messages"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"body":"run external","attachments":[],"selectedSkillIds":[]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(message_response.status(), StatusCode::OK);
        let message_body = to_bytes(message_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let message: Value = serde_json::from_slice(&message_body).unwrap();
        assert!(message["assistantMessageId"].is_null());

        let stdout = next_named_event(&mut events, EVENT_RUNTIME_STDOUT).await;
        assert_eq!(stdout.data["conversationId"], conversation_id);
        assert_eq!(stdout.data["text"], "streamed assistant\n");
        let finished = next_named_event(&mut events, EVENT_RUNTIME_FINISHED).await;
        assert_eq!(finished.data["conversationId"], conversation_id);
        assert_eq!(finished.data["ok"], true);
        let assistant_event =
            next_named_event(&mut events, EVENT_CONVERSATION_MESSAGE_CREATED).await;
        assert_eq!(assistant_event.data["conversationId"], conversation_id);
        assert_eq!(assistant_event.data["role"], "assistant");
        assert_eq!(assistant_event.data["turnId"], message["turnId"]);
        assert_eq!(
            assistant_event.data["message"]["id"],
            assistant_event.data["messageId"]
        );
        assert_eq!(
            assistant_event.data["message"]["conversation_id"],
            conversation_id
        );
        assert_eq!(assistant_event.data["message"]["sender_kind"], "bot");
        assert_eq!(
            assistant_event.data["message"]["body_md"],
            "streamed assistant\n"
        );
        assert_eq!(
            assistant_event.data["message"]["turn_id"],
            message["turnId"]
        );

        let assistant = sqlx::query(
            "SELECT body, content_json FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1",
        )
        .bind(conversation_id)
        .fetch_one(services.database.pool())
        .await
        .unwrap();
        assert_eq!(assistant.get::<String, _>("body"), "streamed assistant\n");
        let content: Value =
            serde_json::from_str(&assistant.get::<String, _>("content_json")).unwrap();
        assert_eq!(content["turnId"], message["turnId"]);
        assert_eq!(content["runtime"]["exitCode"], 0);
    }

    #[tokio::test]
    async fn conversation_runtime_session_state_persists_and_resumes_inside_core() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let mut services = AppServices::from_config(&config).await.unwrap();
        services.conversation = ConversationService::with_runtime(
            services.database.pool().clone(),
            RuntimeBuilder::new(config.workspace_dir.to_string_lossy())
                .with_engine_command("test-session", stdout_command("session assistant\n")),
        );
        let app = create_router(&services);

        let conversation_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/conversations")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"kind":"direct","title":"Runtime Session","botId":null,"metadata":{"runtime":{"engine":"test-session"}}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(conversation_response.status(), StatusCode::OK);
        let conversation_body = to_bytes(conversation_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let conversation: Value = serde_json::from_slice(&conversation_body).unwrap();
        let conversation_id = conversation["conversation"]["id"].as_str().unwrap();
        let mut events = services.realtime.subscribe();

        let first_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/conversations/{conversation_id}/messages"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"body":"first","attachments":[],"selectedSkillIds":[]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first_response.status(), StatusCode::OK);
        let _ = next_named_event(&mut events, EVENT_RUNTIME_FINISHED).await;
        let _ = next_named_event(&mut events, EVENT_CONVERSATION_MESSAGE_CREATED).await;

        let metadata_row = sqlx::query("SELECT metadata_json FROM conversations WHERE id = ?")
            .bind(conversation_id)
            .fetch_one(services.database.pool())
            .await
            .unwrap();
        let metadata: Value =
            serde_json::from_str(&metadata_row.get::<String, _>("metadata_json")).unwrap();
        let session_key = metadata["runtimeSession"]["sessionKey"]
            .as_str()
            .expect("first completed runtime turn persists a session key")
            .to_owned();
        assert_eq!(
            metadata["runtimeSession"]["conversationId"],
            conversation_id
        );
        assert_eq!(metadata["runtimeSession"]["engine"], "test-session");

        let second_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/conversations/{conversation_id}/messages"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"body":"second","attachments":[],"selectedSkillIds":[]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second_response.status(), StatusCode::OK);
        let _ = next_named_event(&mut events, EVENT_RUNTIME_FINISHED).await;
        let _ = next_named_event(&mut events, EVENT_CONVERSATION_MESSAGE_CREATED).await;

        let assistant = sqlx::query(
            "SELECT content_json FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1",
        )
        .bind(conversation_id)
        .fetch_one(services.database.pool())
        .await
        .unwrap();
        let content: Value =
            serde_json::from_str(&assistant.get::<String, _>("content_json")).unwrap();
        assert_eq!(
            content["runtime"]["runtimeSession"]["sessionKey"],
            session_key
        );
        assert_eq!(
            content["runtime"]["runtimeSession"]["resumeSessionKey"],
            Value::Null
        );
        assert_eq!(content["runtime"]["runtimeSession"]["resumed"], false);
    }

    #[test]
    fn app_runtime_callers_enter_session_manager_not_executor_directly() {
        for path in ["src/router/conversation.rs", "src/cloud_bridge.rs"] {
            let source =
                fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap();
            assert!(
                !source.contains("RuntimeExecutor"),
                "{path} must call RuntimeSessionManager::send_message instead of RuntimeExecutor directly"
            );
        }
    }

    #[test]
    fn cloud_bridge_does_not_rewrite_desktop_local_acp_into_legacy_cli_fallback() {
        let source =
            fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/cloud_bridge.rs"))
                .unwrap();
        assert!(
            !source.contains("ensure_codex_exec_json_args"),
            "cloud bridge must not force Codex exec/json fallback for desktop-local bot sends"
        );
        assert!(
            !source.contains("ensure_claude_print_stream_args"),
            "cloud bridge must not force Claude print stream-json fallback for desktop-local bot sends"
        );
    }

    #[tokio::test]
    async fn conversation_route_cancels_external_runtime_process() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let mut services = AppServices::from_config(&config).await.unwrap();
        services.conversation = ConversationService::with_runtime(
            services.database.pool().clone(),
            RuntimeBuilder::new(config.workspace_dir.to_string_lossy())
                .with_engine_command("test-cancel", long_running_start_command("started\n", 10)),
        );
        let app = create_router(&services);

        let conversation_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/conversations")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"kind":"direct","title":"Runtime Cancel","botId":null,"metadata":{"runtime":{"engine":"test-cancel"}}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(conversation_response.status(), StatusCode::OK);
        let conversation_body = to_bytes(conversation_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let conversation: Value = serde_json::from_slice(&conversation_body).unwrap();
        let conversation_id = conversation["conversation"]["id"].as_str().unwrap();
        let mut events = services.realtime.subscribe();

        let message_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/conversations/{conversation_id}/messages"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"body":"run external","attachments":[],"selectedSkillIds":[]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(message_response.status(), StatusCode::OK);
        let message_body = to_bytes(message_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let message: Value = serde_json::from_slice(&message_body).unwrap();
        let turn_id = message["turnId"].as_str().unwrap();

        let stdout = next_named_event(&mut events, EVENT_RUNTIME_STDOUT).await;
        assert_eq!(stdout.data["text"], "started\n");

        let cancel_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/conversations/{conversation_id}/turns/{turn_id}/cancel"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cancel_response.status(), StatusCode::OK);
        let cancel_event = next_named_event(&mut events, EVENT_RUNTIME_CANCEL_REQUESTED).await;
        assert_eq!(cancel_event.data["turnId"], turn_id);

        let finished = next_named_event(&mut events, EVENT_RUNTIME_FINISHED).await;
        assert_eq!(finished.data["conversationId"], conversation_id);
        assert_eq!(finished.data["turnId"], turn_id);
        assert_eq!(finished.data["cancelled"], true);
        assert_eq!(finished.data["ok"], false);
        let assistant_event =
            next_named_event(&mut events, EVENT_CONVERSATION_MESSAGE_CREATED).await;
        assert_eq!(assistant_event.data["role"], "assistant");

        let assistant = sqlx::query(
            "SELECT body, content_json FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1",
        )
        .bind(conversation_id)
        .fetch_one(services.database.pool())
        .await
        .unwrap();
        assert_eq!(assistant.get::<String, _>("body"), "started\n");
        let content: Value =
            serde_json::from_str(&assistant.get::<String, _>("content_json")).unwrap();
        assert_eq!(content["runtime"]["cancelled"], true);
    }

    #[tokio::test]
    async fn conversation_route_rejects_overlapping_runtime_turns_for_same_conversation() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let mut services = AppServices::from_config(&config).await.unwrap();
        services.conversation = ConversationService::with_runtime(
            services.database.pool().clone(),
            RuntimeBuilder::new(config.workspace_dir.to_string_lossy())
                .with_engine_command("test-busy", long_running_start_command("started\n", 10)),
        );
        let app = create_router(&services);

        let conversation_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/conversations")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"kind":"direct","title":"Runtime Busy","botId":null,"metadata":{"runtime":{"engine":"test-busy"}}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(conversation_response.status(), StatusCode::OK);
        let conversation_body = to_bytes(conversation_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let conversation: Value = serde_json::from_slice(&conversation_body).unwrap();
        let conversation_id = conversation["conversation"]["id"].as_str().unwrap();
        let mut events = services.realtime.subscribe();

        let first_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/conversations/{conversation_id}/messages"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"body":"first","attachments":[],"selectedSkillIds":[]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first_response.status(), StatusCode::OK);
        let first_body = to_bytes(first_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let first: Value = serde_json::from_slice(&first_body).unwrap();
        let first_turn_id = first["turnId"].as_str().unwrap();
        let stdout = next_named_event(&mut events, EVENT_RUNTIME_STDOUT).await;
        assert_eq!(stdout.data["text"], "started\n");

        let overlapping_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/conversations/{conversation_id}/messages"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"body":"second","attachments":[],"selectedSkillIds":[]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(overlapping_response.status(), StatusCode::CONFLICT);

        let cancel_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/conversations/{conversation_id}/turns/{first_turn_id}/cancel"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cancel_response.status(), StatusCode::OK);
        let finished = next_named_event(&mut events, EVENT_RUNTIME_FINISHED).await;
        assert_eq!(finished.data["turnId"], first_turn_id);
        assert_eq!(finished.data["cancelled"], true);
        let assistant_event =
            next_named_event(&mut events, EVENT_CONVERSATION_MESSAGE_CREATED).await;
        assert_eq!(assistant_event.data["role"], "assistant");

        let next_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/conversations/{conversation_id}/messages"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"body":"third","attachments":[],"selectedSkillIds":[]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(next_response.status(), StatusCode::OK);
        let next_body = to_bytes(next_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let next: Value = serde_json::from_slice(&next_body).unwrap();
        let next_turn_id = next["turnId"].as_str().unwrap();
        assert_ne!(next_turn_id, first_turn_id);
        let _ = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/conversations/{conversation_id}/turns/{next_turn_id}/cancel"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn task_routes_create_update_run_and_delete_core_owned_jobs() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);

        let bot_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"displayName":"Task Bot","identity":{"persona":"runner"},"capabilities":{}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bot_response.status(), StatusCode::OK);
        let bot_body = to_bytes(bot_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let bot: Value = serde_json::from_slice(&bot_body).unwrap();
        let bot_id = bot["bot"]["id"].as_str().unwrap();

        let conversation_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/conversations")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"kind":"direct","title":"Task Conversation","botId":"{bot_id}","metadata":{{"runtime":{{"engine":"mock-agent"}}}}}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(conversation_response.status(), StatusCode::OK);
        let conversation_body = to_bytes(conversation_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let conversation: Value = serde_json::from_slice(&conversation_body).unwrap();
        let conversation_id = conversation["conversation"]["id"].as_str().unwrap();
        let mut events = services.realtime.subscribe();

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/tasks/jobs")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"kind":"agent","schedule":{{"type":"cron","cron":"0 9 * * *","timezone":"UTC"}},"target":{{"botId":"{bot_id}","conversationId":"{conversation_id}","selectedSkillIds":["skill_task"]}},"instructions":"daily summary"}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);
        let create_body = to_bytes(create_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: Value = serde_json::from_slice(&create_body).unwrap();
        let job_id = created["job"]["id"].as_str().unwrap();
        assert!(job_id.starts_with("task_"));
        assert_eq!(created["job"]["schedule"]["type"], "cron");
        let created_event = next_event(&mut events).await;
        assert_eq!(created_event.name, EVENT_TASK_CREATED);
        assert_eq!(created_event.data["job"]["id"], job_id);

        let list_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/tasks/jobs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);

        let update_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/tasks/jobs/{job_id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"status":"paused","instructions":"updated"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(update_response.status(), StatusCode::OK);
        let update_body = to_bytes(update_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let updated: Value = serde_json::from_slice(&update_body).unwrap();
        assert_eq!(updated["job"]["status"], "paused");
        assert_eq!(updated["job"]["instructions"], "updated");
        let updated_event = next_event(&mut events).await;
        assert_eq!(updated_event.name, EVENT_TASK_UPDATED);
        assert_eq!(updated_event.data["job"]["id"], job_id);

        let run_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/tasks/jobs/{job_id}/run"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(run_response.status(), StatusCode::OK);
        let run_body = to_bytes(run_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let run: Value = serde_json::from_slice(&run_body).unwrap();
        assert!(run["runId"].as_str().unwrap().starts_with("run_"));
        assert_eq!(run["conversationId"], conversation_id);
        assert!(run["messageId"].is_null());
        assert!(run["turnId"].as_str().unwrap().starts_with("turn_"));
        assert!(
            run["assistantMessageId"]
                .as_str()
                .unwrap()
                .starts_with("msg_")
        );
        let started_event = next_event(&mut events).await;
        assert_eq!(started_event.name, EVENT_TASK_RUN_STARTED);
        assert_eq!(started_event.data["jobId"], job_id);
        let finished_event = loop {
            let event = next_event(&mut events).await;
            if event.name == EVENT_TASK_RUN_FINISHED {
                break event;
            }
            assert_eq!(event.name, EVENT_CONVERSATION_MESSAGE_CREATED);
        };
        assert_eq!(finished_event.name, EVENT_TASK_RUN_FINISHED);
        assert_eq!(finished_event.data["jobId"], job_id);
        assert_eq!(finished_event.data["ok"], true);
        assert_eq!(finished_event.data["conversationId"], conversation_id);

        let get_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/tasks/jobs/{job_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get_response.status(), StatusCode::OK);

        let delete_response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/tasks/jobs/{job_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::OK);
        let deleted_event = next_event(&mut events).await;
        assert_eq!(deleted_event.name, EVENT_TASK_UPDATED);
        assert_eq!(deleted_event.data["jobId"], job_id);
        assert_eq!(deleted_event.data["deleted"], true);
    }

    #[tokio::test]
    async fn cloud_task_routes_proxy_the_connected_account_owner() {
        use std::sync::Mutex;

        use mia_core_api_types::CloudConnectRequest;
        use mia_core_cloud::{CloudError, CloudMemoryTransport, CloudService};

        #[derive(Clone)]
        struct TaskCloudTransport {
            calls: Arc<Mutex<Vec<(String, String)>>>,
            responses: Arc<Mutex<Vec<Value>>>,
        }

        #[async_trait::async_trait]
        impl CloudMemoryTransport for TaskCloudTransport {
            async fn post_json(
                &self,
                _base_url: &str,
                _token: &str,
                path: &str,
                _body: Value,
            ) -> Result<Value, CloudError> {
                self.calls
                    .lock()
                    .unwrap()
                    .push(("POST".into(), path.into()));
                Ok(self.responses.lock().unwrap().remove(0))
            }

            async fn get_json(
                &self,
                _base_url: &str,
                _token: &str,
                path: &str,
            ) -> Result<Value, CloudError> {
                self.calls.lock().unwrap().push(("GET".into(), path.into()));
                Ok(self.responses.lock().unwrap().remove(0))
            }

            async fn patch_json(
                &self,
                _base_url: &str,
                _token: &str,
                _path: &str,
                _body: Value,
            ) -> Result<Value, CloudError> {
                unreachable!("this test does not patch cloud tasks")
            }

            async fn delete_json(
                &self,
                _base_url: &str,
                _token: &str,
                _path: &str,
            ) -> Result<Value, CloudError> {
                unreachable!("this test does not delete cloud tasks")
            }
        }

        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let transport = TaskCloudTransport {
            calls: Arc::new(Mutex::new(Vec::new())),
            responses: Arc::new(Mutex::new(vec![
                json!({
                    "tasks": [{
                        "id": "t-cloud-route",
                        "title": "吃饭提醒",
                        "runs": [{ "id": "r-cloud-route", "status": "ok" }]
                    }]
                }),
                json!({ "runId": "r-cloud-route-2" }),
            ])),
        };
        let cloud = CloudService::with_memory_transport(
            services.database.pool().clone(),
            || 1000,
            transport.clone(),
        );
        cloud
            .connect(CloudConnectRequest {
                url: Some("https://mia.example".into()),
                token: Some("secret-token".into()),
                account_hint: None,
                user: Some(json!({ "id": "u1" })),
                account: None,
                agent_runtime: None,
                last_event_seq: None,
                last_memory_sync_at: None,
            })
            .await
            .unwrap();
        let mut states = build_module_states(&services);
        states.cloud = cloud;
        let app = create_router_with_states(states);

        let list_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/tasks/cloud")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let list_body: Value = serde_json::from_slice(
            &to_bytes(list_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(list_body["tasks"][0]["id"], "t-cloud-route");
        assert_eq!(list_body["tasks"][0]["runs"][0]["id"], "r-cloud-route");

        let run_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/tasks/cloud/t-cloud-route/run-now")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(run_response.status(), StatusCode::OK);
        let run_body: Value = serde_json::from_slice(
            &to_bytes(run_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(run_body["runId"], "r-cloud-route-2");
        assert_eq!(
            transport.calls.lock().unwrap().as_slice(),
            &[
                ("GET".into(), "/api/tasks".into()),
                ("POST".into(), "/api/tasks/t-cloud-route/run-now".into()),
            ]
        );
    }

    #[tokio::test]
    async fn task_routes_return_core_validation_error_body_for_invalid_schedule() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/tasks/jobs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"kind":"agent","schedule":{"type":"oneshot","atMs":1},"target":{"botId":"bot_1","conversationId":"conv_1"},"instructions":"bad time"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let error: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(error["ok"], false);
        assert!(error["error"].as_str().unwrap().contains("future"));
    }

    #[tokio::test]
    async fn scheduler_runs_due_task_jobs_through_conversation_and_realtime() {
        struct ScheduledBackend(Arc<AtomicUsize>);

        #[async_trait::async_trait]
        impl NativeAcpBackend for ScheduledBackend {
            async fn send_message(
                &self,
                _plan: RuntimeTurnPlan,
                _sink: RuntimeEventSink,
                _cancellation: Option<RuntimeCancellation>,
            ) -> anyhow::Result<RuntimeExecutionResult> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(RuntimeExecutionResult {
                    exit_code: Some(0),
                    stdout: "定时任务已完成".into(),
                    stderr: String::new(),
                    cancelled: false,
                })
            }
        }

        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let mut services = AppServices::from_config(&config).await.unwrap();
        let runtime_calls = Arc::new(AtomicUsize::new(0));
        services.runtime_sessions =
            RuntimeSessionManager::new(NativeAcpSessionManager::with_backend_for_tests(Arc::new(
                ScheduledBackend(runtime_calls.clone()),
            )));
        let app = create_router(&services);

        let bot_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/bots")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"displayName":"Scheduled Bot","identity":{"persona":"runner"},"capabilities":{}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bot_response.status(), StatusCode::OK);
        let bot_body = to_bytes(bot_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let bot: Value = serde_json::from_slice(&bot_body).unwrap();
        let bot_id = bot["bot"]["id"].as_str().unwrap();

        let conversation_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/conversations")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"kind":"direct","title":"Scheduled Conversation","botId":"{bot_id}","metadata":{{"runtime":{{"engine":"codex"}},"cloudBridge":{{"conversationId":"cloud:scheduled"}}}}}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(conversation_response.status(), StatusCode::OK);
        let conversation_body = to_bytes(conversation_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let conversation: Value = serde_json::from_slice(&conversation_body).unwrap();
        let conversation_id = conversation["conversation"]["id"].as_str().unwrap();

        let create_task_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/tasks/jobs")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"kind":"agent","schedule":{{"type":"oneshot","atMs":4102444800000}},"target":{{"botId":"{bot_id}","conversationId":"cloud:scheduled"}},"instructions":"scheduled smoke"}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(create_task_response.status(), StatusCode::OK);
        let create_task_body = to_bytes(create_task_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let task: Value = serde_json::from_slice(&create_task_body).unwrap();
        let task_id = task["job"]["id"].as_str().unwrap();
        sqlx::query("UPDATE tasks SET next_run_at = 0 WHERE id = ?")
            .bind(task_id)
            .execute(services.database.pool())
            .await
            .unwrap();

        let mut events = services.realtime.subscribe();
        let ran = run_due_tasks_once(&services).await.unwrap();
        assert_eq!(ran, 1);
        assert_eq!(runtime_calls.load(Ordering::SeqCst), 1);

        let started = next_event(&mut events).await;
        assert_eq!(started.name, EVENT_TASK_RUN_STARTED);
        assert_eq!(started.data["jobId"], task_id);
        assert_eq!(started.data["scheduled"], true);

        let mut observed = vec![];
        let finished = loop {
            let event = next_event(&mut events).await;
            if event.name == EVENT_TASK_RUN_FINISHED {
                break event;
            }
            observed.push(event);
        };
        assert!(observed.iter().any(|event| {
            event.name == EVENT_TASK_UPDATED
                && event.data["job"]["id"] == task_id
                && event.data["job"]["status"] == "done"
        }));
        assert_eq!(
            observed
                .iter()
                .filter(|event| event.name == EVENT_CONVERSATION_MESSAGE_CREATED)
                .count(),
            1
        );
        let assistant_event = observed
            .iter()
            .find(|event| event.name == EVENT_CONVERSATION_MESSAGE_CREATED)
            .unwrap();
        assert_eq!(
            assistant_event.data["cloudConversationId"],
            "cloud:scheduled"
        );
        assert_eq!(finished.name, EVENT_TASK_RUN_FINISHED);
        assert_eq!(finished.data["jobId"], task_id);
        assert_eq!(finished.data["ok"], true);
        assert_eq!(finished.data["conversationId"], conversation_id);

        let status_row = sqlx::query("SELECT status FROM tasks WHERE id = ?")
            .bind(task_id)
            .fetch_one(services.database.pool())
            .await
            .unwrap();
        assert_eq!(status_row.get::<String, _>("status"), "done");
        let completed_job = services.tasks.get_job(task_id).await.unwrap().job;
        assert_eq!(completed_job.target["runs"][0]["status"], "ok");
        assert!(completed_job.target["runs"][0]["messageId"].is_null());
        assert_eq!(
            completed_job.target["runs"][0]["outputText"],
            "定时任务已完成"
        );
        let message_roles: Vec<String> = sqlx::query_scalar(
            "SELECT role FROM messages WHERE conversation_id = ? ORDER BY seq ASC",
        )
        .bind(conversation_id)
        .fetch_all(services.database.pool())
        .await
        .unwrap();
        assert_eq!(message_roles, vec!["assistant"]);
        let assistant_body: String = sqlx::query_scalar(
            "SELECT body FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1",
        )
        .bind(conversation_id)
        .fetch_one(services.database.pool())
        .await
        .unwrap();
        assert_eq!(assistant_body, "定时任务已完成");
    }

    async fn next_event(
        events: &mut tokio::sync::broadcast::Receiver<RealtimeEvent>,
    ) -> RealtimeEvent {
        timeout(Duration::from_secs(1), events.recv())
            .await
            .expect("timed out waiting for realtime event")
            .expect("realtime event bus closed")
    }

    async fn next_named_event(
        events: &mut tokio::sync::broadcast::Receiver<RealtimeEvent>,
        name: &str,
    ) -> RealtimeEvent {
        timeout(Duration::from_secs(2), async {
            loop {
                let event = events.recv().await.expect("realtime event bus closed");
                if event.name == name {
                    return event;
                }
            }
        })
        .await
        .expect("timed out waiting for named realtime event")
    }

    #[cfg(unix)]
    fn shell_command(script: &str) -> RuntimeCommand {
        RuntimeCommand {
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
        }
    }

    #[cfg(unix)]
    fn stdout_command(stdout: &str) -> RuntimeCommand {
        shell_command(&format!("printf '%s' {}", sh_quote(stdout)))
    }

    #[cfg(windows)]
    fn stdout_command(stdout: &str) -> RuntimeCommand {
        powershell_command(&format!("[Console]::Out.Write({})", ps_quote(stdout)))
    }

    #[cfg(unix)]
    fn long_running_start_command(started: &str, seconds: u64) -> RuntimeCommand {
        shell_command(&format!(
            "printf '%s' {}; exec sleep {}",
            sh_quote(started),
            seconds
        ))
    }

    #[cfg(windows)]
    fn long_running_start_command(started: &str, seconds: u64) -> RuntimeCommand {
        powershell_command(&format!(
            "[Console]::Out.Write({}); [Console]::Out.Flush(); Start-Sleep -Seconds {}",
            ps_quote(started),
            seconds
        ))
    }

    #[cfg(unix)]
    fn delayed_output_command(first: &str, second: &str, seconds: u64) -> RuntimeCommand {
        shell_command(&format!(
            "printf '%s' {}; sleep {}; printf '%s' {}",
            sh_quote(first),
            seconds,
            sh_quote(second)
        ))
    }

    #[cfg(windows)]
    fn delayed_output_command(first: &str, second: &str, seconds: u64) -> RuntimeCommand {
        powershell_command(&format!(
            "[Console]::Out.Write({}); [Console]::Out.Flush(); Start-Sleep -Seconds {}; [Console]::Out.Write({})",
            ps_quote(first),
            seconds,
            ps_quote(second)
        ))
    }

    #[cfg(unix)]
    fn sh_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    #[cfg(windows)]
    fn powershell_command(script: &str) -> RuntimeCommand {
        RuntimeCommand {
            program: "powershell.exe".into(),
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-Command".into(),
                format!(
                    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); {script}"
                ),
            ],
        }
    }

    #[cfg(windows)]
    fn ps_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    #[cfg(unix)]
    fn mcp_test_transport(script: &str) -> Value {
        json!({
            "type": "stdio",
            "command": "sh",
            "args": ["-c", script],
            "env": { "DOCS_API_TOKEN": "secret" }
        })
    }

    #[cfg(windows)]
    fn mcp_test_transport(_script: &str) -> Value {
        let script = r#"
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ($line.Contains('"method":"initialize"')) {
    [Console]::Out.WriteLine('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"docs","version":"1.0.0"}}}')
    [Console]::Out.Flush()
  } elseif ($line.Contains('"method":"tools/list"')) {
    [Console]::Out.WriteLine('{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search","description":"Search docs","inputSchema":{"type":"object"}}]}}')
    [Console]::Out.Flush()
  }
}
"#;
        json!({
            "type": "stdio",
            "command": "powershell.exe",
            "args": [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                format!(
                    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); {script}"
                )
            ],
            "env": { "DOCS_API_TOKEN": "secret" }
        })
    }

    #[tokio::test]
    async fn cloud_routes_own_status_session_and_user_settings() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);

        let initial_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/cloud/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(initial_response.status(), StatusCode::OK);
        let initial_body = to_bytes(initial_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let initial: Value = serde_json::from_slice(&initial_body).unwrap();
        assert_eq!(initial["enabled"], false);
        assert!(initial.get("token").is_some_and(Value::is_null));

        let skipped_memory_sync_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/cloud/memory/sync")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"limit":1000}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(skipped_memory_sync_response.status(), StatusCode::OK);
        let skipped_memory_sync_body =
            to_bytes(skipped_memory_sync_response.into_body(), usize::MAX)
                .await
                .unwrap();
        let skipped_memory_sync: Value = serde_json::from_slice(&skipped_memory_sync_body).unwrap();
        assert_eq!(skipped_memory_sync["ok"], false);
        assert_eq!(skipped_memory_sync["skipped"], true);

        let connect_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/cloud/connect")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"url":"https://mia.example/","token":"secret-token","user":{"id":"u1"},"agentRuntime":{"engine":"codex"},"lastEventSeq":12}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(connect_response.status(), StatusCode::OK);
        let connect_body = to_bytes(connect_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let connected: Value = serde_json::from_slice(&connect_body).unwrap();
        assert_eq!(connected["status"]["enabled"], true);
        assert!(connected["status"]["token"].is_null());

        let private_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/cloud/status?includeToken=true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let private_body = to_bytes(private_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let private_status: Value = serde_json::from_slice(&private_body).unwrap();
        assert_eq!(private_status["token"], "secret-token");
        assert_eq!(private_status["events"]["lastEventSeq"], 12);

        let put_settings_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/cloud/settings")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"settings":{"pins":["conversation_1"],"readMarks":{"conversation_1":1},"tags":{"items":[],"assignments":{}}}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(put_settings_response.status(), StatusCode::OK);

        let get_settings_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/cloud/settings")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let get_settings_body = to_bytes(get_settings_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let settings: Value = serde_json::from_slice(&get_settings_body).unwrap();
        assert_eq!(settings["settings"]["pins"], json!(["conversation_1"]));
        assert_eq!(settings["settings"]["mutedConversations"], json!([]));

        let disconnect_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/cloud/disconnect")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(disconnect_response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn cloud_bridge_run_enters_core_conversation_runtime_boundary() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/cloud/bridge/run")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{
                          "runId":"run_1",
                          "conversationId":"cloud:conv/1",
                          "text":"hello from cloud",
                          "runtimeConfig":{
                            "agentEngine":"mock-agent",
                            "providerConnectionId":"mia",
                            "model":"mia-default",
                            "baseUrl":"https://should-not-cross.example/v1",
                            "apiKeyEnv":"SHOULD_NOT_CROSS",
                            "apiMode":"responses"
                          }
                        }"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let run: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(run["ok"], true);
        assert_eq!(run["runId"], "run_1");
        assert_eq!(run["cloudConversationId"], "cloud:conv/1");
        assert_eq!(run["conversationId"], "cloud_bridge_cloud_conv_1");
        assert!(run["messageId"].as_str().unwrap().starts_with("msg_"));
        assert!(
            run["text"]
                .as_str()
                .unwrap()
                .contains("Mia Rust Core mock response: hello from cloud")
        );

        let row = sqlx::query("SELECT metadata_json FROM conversations WHERE id = ?")
            .bind("cloud_bridge_cloud_conv_1")
            .fetch_one(services.database.pool())
            .await
            .unwrap();
        let metadata: Value = serde_json::from_str(&row.get::<String, _>("metadata_json")).unwrap();
        assert_eq!(metadata["runtime"]["agentEngine"], "mock-agent");
        assert_eq!(metadata["runtime"]["providerConnectionId"], "mia");
        assert_eq!(metadata["runtime"]["model"], "mia-auto");
        assert!(metadata["runtime"].get("baseUrl").is_none());
        assert!(metadata["runtime"].get("apiKeyEnv").is_none());
        assert!(metadata["runtime"].get("apiMode").is_none());
        assert_eq!(metadata["cloudBridge"]["runId"], "run_1");
    }

    #[tokio::test]
    async fn cloud_bridge_async_run_acknowledges_before_runtime_finishes() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let mut services = AppServices::from_config(&config).await.unwrap();
        services.conversation = ConversationService::with_runtime(
            services.database.pool().clone(),
            RuntimeBuilder::new(config.workspace_dir.to_string_lossy()).with_engine_command(
                "hermes",
                delayed_output_command("started\n", "finished\n", 1),
            ),
        );
        let app = create_router(&services);
        let connect_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/cloud/connect")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"url":"https://mia.example","token":"test-token","user":{"id":"u1"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(connect_response.status(), StatusCode::OK);
        let mut events = services.realtime.subscribe();

        let response = timeout(
            Duration::from_millis(500),
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/cloud/bridge/run-async")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{
                          "runId":"run_async",
                          "conversationId":"cloud:async",
                          "text":"long task",
                          "runtimeConfig":{
                            "agentEngine":"hermes",
                            "providerConnectionId":"mia",
                            "model":"mia-auto"
                          }
                        }"#,
                    ))
                    .unwrap(),
            ),
        )
        .await
        .expect("async cloud bridge response should not wait for the runtime")
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let accepted: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(accepted["ok"], true);
        assert_eq!(accepted["runId"], "run_async");
        assert_eq!(accepted["conversationId"], "cloud_bridge_cloud_async");
        assert_eq!(accepted["text"], "");
        assert!(accepted["messageId"].as_str().unwrap().starts_with("msg_"));

        let stdout = next_named_event(&mut events, EVENT_RUNTIME_STDOUT).await;
        assert_eq!(stdout.data["text"], "started\n");
        let _ = next_named_event(&mut events, EVENT_RUNTIME_FINISHED).await;
    }

    #[tokio::test]
    async fn cloud_bridge_run_respects_active_conversation_runtime_claims() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let mut services = AppServices::from_config(&config).await.unwrap();
        services.conversation = ConversationService::with_runtime(
            services.database.pool().clone(),
            RuntimeBuilder::new(config.workspace_dir.to_string_lossy()).with_engine_command(
                "test-cloud-busy",
                long_running_start_command("started\n", 10),
            ),
        );
        services
            .conversation
            .ensure_external_conversation(
                "cloud_bridge_cloud_busy",
                "cloud-bridge",
                "Cloud Busy",
                None,
                json!({
                    "runtime": { "engine": "test-cloud-busy" },
                    "cloudBridge": { "conversationId": "cloud:busy" }
                }),
            )
            .await
            .unwrap();
        let app = create_router(&services);
        let mut events = services.realtime.subscribe();

        let first_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/conversations/cloud_bridge_cloud_busy/messages")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"body":"foreground","attachments":[],"selectedSkillIds":[]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first_response.status(), StatusCode::OK);
        let first_body = to_bytes(first_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let first: Value = serde_json::from_slice(&first_body).unwrap();
        let first_turn_id = first["turnId"].as_str().unwrap();
        let stdout = next_named_event(&mut events, EVENT_RUNTIME_STDOUT).await;
        assert_eq!(stdout.data["text"], "started\n");

        let cloud_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/cloud/bridge/run")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"runId":"run_busy","conversationId":"cloud:busy","text":"from cloud"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cloud_response.status(), StatusCode::CONFLICT);

        let cancel_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/conversations/cloud_bridge_cloud_busy/turns/{first_turn_id}/cancel"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cancel_response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn mcp_routes_create_test_enable_list_and_delete_core_owned_servers() {
        let mut config = AppConfig::default();
        let temp = tempfile::tempdir().unwrap();
        config.data_dir = temp.path().to_path_buf();
        config.workspace_dir = config.data_dir.join("workspace");
        let services = AppServices::from_config(&config).await.unwrap();
        let app = create_router(&services);
        let mcp_script = r#"
while IFS= read -r line; do
  case "$line" in
    *\"method\":\"initialize\"*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"docs","version":"1.0.0"}}}'
      ;;
    *\"method\":\"tools/list\"*)
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search","description":"Search docs","inputSchema":{"type":"object"}}]}}'
      ;;
  esac
done
"#;

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mcp/servers")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "name": "docs",
                            "description": "Docs MCP",
                            "enabled": false,
                            "transport": mcp_test_transport(mcp_script)
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);
        let create_body = to_bytes(create_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: Value = serde_json::from_slice(&create_body).unwrap();
        let server_id = created["server"]["id"].as_str().unwrap();
        assert!(server_id.starts_with("mcp_"));
        assert_eq!(
            created["server"]["transport"]["env"]["DOCS_API_TOKEN"],
            "••••••••"
        );

        let test_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/mcp/servers/{server_id}/test"))
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(test_response.status(), StatusCode::OK);
        let test_body = to_bytes(test_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let tested: Value = serde_json::from_slice(&test_body).unwrap();
        assert_eq!(tested["ok"], true);
        assert_eq!(tested["diagnostic"]["status"], "connected");
        assert_eq!(tested["diagnostic"]["tools"][0]["name"], "search");

        let update_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/mcp/servers/{server_id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"enabled":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(update_response.status(), StatusCode::OK);

        let list_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/mcp/servers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let list_body = to_bytes(list_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let list: Value = serde_json::from_slice(&list_body).unwrap();
        assert_eq!(list["servers"][0]["id"], server_id);
        assert_eq!(list["servers"][0]["enabled"], true);
        assert_eq!(list["servers"][0]["lastTestStatus"], "connected");

        let agent_configs_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/mcp/agent-configs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(agent_configs_response.status(), StatusCode::OK);

        let delete_response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/mcp/servers/{server_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::OK);
    }
}
