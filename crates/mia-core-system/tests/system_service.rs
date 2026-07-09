use mia_core_api_types::{
    CreateProviderRequest, HermesRuntimeConfigPaths, PrepareHermesRuntimeConfigRequest,
    SaveAgentWorkspaceRequest, SaveMemorySettingsRequest, SaveModelSelectionRequest,
    SettingsRuntimeControlOptionsRequest,
};
use mia_core_db::{
    CreateProviderParams, IProviderRepository, SqliteProviderRepository, SqliteSettingsRepository,
    init_database_memory,
};
use mia_core_system::SystemService;
use serde_json::json;

fn temp_runtime_dir(prefix: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::now_v7().simple()))
}

#[tokio::test]
async fn client_settings_are_owned_and_merged_inside_core() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    let first = service
        .patch_client_settings(json!({"theme":"dark","nested":{"a":1}}))
        .await
        .unwrap();
    assert_eq!(first.settings["theme"], "dark");

    let second = service
        .patch_client_settings(json!({"language":"zh","nested":{"b":2}}))
        .await
        .unwrap();
    assert_eq!(second.settings["theme"], "dark");
    assert_eq!(second.settings["language"], "zh");
    assert_eq!(second.settings["nested"]["a"], 1);
    assert_eq!(second.settings["nested"]["b"], 2);
}

#[tokio::test]
async fn agent_workspace_is_persisted_and_resolved_inside_core() {
    let db = init_database_memory().await.unwrap();
    let temp = std::env::temp_dir().join(format!(
        "mia-core-system-workspace-{}",
        uuid::Uuid::now_v7().simple()
    ));
    let default_workspace = temp.join("mia-workspace");
    let project_workspace = temp.join("project");
    std::fs::create_dir_all(&project_workspace).unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    let initial = service.agent_workspace(&default_workspace).await.unwrap();
    let default_workspace_text = default_workspace.to_string_lossy().to_string();
    let project_workspace_text = project_workspace.to_string_lossy().to_string();
    assert_eq!(initial.path, default_workspace_text);
    assert_eq!(initial.custom, "");
    assert_eq!(initial.default, default_workspace_text);

    let saved = service
        .save_agent_workspace(
            SaveAgentWorkspaceRequest {
                path: Some(project_workspace_text.clone()),
                workspace_path: None,
            },
            &default_workspace,
        )
        .await
        .unwrap();
    assert_eq!(saved.path, project_workspace_text);
    assert_eq!(saved.custom, project_workspace_text);

    let missing = service
        .save_agent_workspace(
            SaveAgentWorkspaceRequest {
                path: Some(temp.join("missing").to_string_lossy().to_string()),
                workspace_path: None,
            },
            &default_workspace,
        )
        .await
        .unwrap();
    assert_eq!(missing.path, default_workspace_text);
    assert!(missing.custom.ends_with("missing"));
    std::fs::remove_dir_all(&temp).unwrap();
}

#[tokio::test]
async fn memory_settings_are_persisted_inside_core_client_settings() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    let initial = service.memory_settings().await.unwrap();
    assert!(initial.enabled);

    let disabled = service
        .save_memory_settings(SaveMemorySettingsRequest {
            enabled: Some(false),
        })
        .await
        .unwrap();
    assert!(!disabled.enabled);
    assert_eq!(
        service.client_settings().await.unwrap().settings["memory"]["enabled"],
        false
    );

    let unchanged = service
        .save_memory_settings(SaveMemorySettingsRequest { enabled: None })
        .await
        .unwrap();
    assert!(!unchanged.enabled);

    let enabled = service
        .save_memory_settings(SaveMemorySettingsRequest {
            enabled: Some(true),
        })
        .await
        .unwrap();
    assert!(enabled.enabled);
}

#[tokio::test]
async fn provider_listing_redacts_runtime_secrets() {
    let db = init_database_memory().await.unwrap();
    let providers = SqliteProviderRepository::new(db.pool().clone());
    providers
        .create(CreateProviderParams {
            id: "openai-main",
            kind: "openai",
            display_name: "OpenAI",
            base_url: Some("https://api.openai.com/v1"),
            api_key_env: Some("OPENAI_API_KEY"),
            encrypted_api_key: Some("secret-key"),
            api_mode: Some("responses"),
            auth_type: Some("api_key"),
            models_json: json!(["gpt-5", "gpt-5-mini"]),
            enabled: true,
            now_ms: 1,
        })
        .await
        .unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        providers,
    );

    let response = service.list_providers().await.unwrap();
    assert_eq!(response.providers.len(), 1);
    assert_eq!(response.providers[0].id, "openai-main");
    assert_eq!(response.providers[0].models, vec!["gpt-5", "gpt-5-mini"]);
    let serialized = serde_json::to_string(&response).unwrap();
    assert!(!serialized.contains("secret-key"));
    assert!(!serialized.contains("apiKey"));
}

#[tokio::test]
async fn provider_test_returns_redacted_core_owned_diagnostics() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    let response = service
        .test_provider(
            None,
            json!({"kind":"openai","apiKey":"secret-key","baseUrl":"https://example.test"}),
        )
        .await
        .unwrap();

    assert!(response.ok);
    let serialized = serde_json::to_string(&response).unwrap();
    assert!(!serialized.contains("secret-key"));
    assert!(serialized.contains("openai"));
}

#[tokio::test]
async fn provider_save_upserts_and_preserves_secret_when_key_is_omitted() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    service
        .create_provider(CreateProviderRequest {
            id: Some("anthropic-main".into()),
            kind: "anthropic".into(),
            display_name: "Anthropic".into(),
            base_url: Some("https://api.anthropic.com".into()),
            api_key_env: Some("ANTHROPIC_API_KEY".into()),
            api_key: Some("stored-key".into()),
            api_mode: Some("messages".into()),
            auth_type: Some("api_key".into()),
            models: vec!["claude-3-5-sonnet".into()],
            enabled: Some(true),
        })
        .await
        .unwrap();

    service
        .create_provider(CreateProviderRequest {
            id: Some("anthropic-main".into()),
            kind: "anthropic".into(),
            display_name: "Claude".into(),
            base_url: Some("https://proxy.example/v1".into()),
            api_key_env: Some("ANTHROPIC_PROXY_KEY".into()),
            api_key: None,
            api_mode: Some("proxy_messages".into()),
            auth_type: Some("api_key".into()),
            models: vec!["claude-3-7-sonnet".into()],
            enabled: Some(true),
        })
        .await
        .unwrap();

    let response = service
        .resolve_model_runtime(
            json!({ "providerConnectionId": "anthropic-main", "model": "claude-3-7-sonnet" }),
            json!({ "engine": "hermes" }),
        )
        .await
        .unwrap();
    let runtime = response.runtime.unwrap();

    assert_eq!(runtime["providerLabel"], "Claude");
    assert_eq!(runtime["apiKey"], "stored-key");
    assert_eq!(runtime["apiKeyEnv"], "ANTHROPIC_PROXY_KEY");
    assert_eq!(runtime["baseUrl"], "https://proxy.example/v1");
    assert_eq!(runtime["apiMode"], "proxy_messages");
}

#[tokio::test]
async fn provider_runtime_resolution_happens_inside_core() {
    let db = init_database_memory().await.unwrap();
    let providers = SqliteProviderRepository::new(db.pool().clone());
    providers
        .create(CreateProviderParams {
            id: "openai-main",
            kind: "openai",
            display_name: "OpenAI",
            base_url: Some("https://api.openai.com/v1"),
            api_key_env: Some("OPENAI_API_KEY"),
            encrypted_api_key: Some("secret-key"),
            api_mode: Some("responses"),
            auth_type: Some("api_key"),
            models_json: json!(["gpt-5"]),
            enabled: true,
            now_ms: 1,
        })
        .await
        .unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        providers,
    );

    let response = service
        .resolve_model_runtime(
            json!({
                "providerConnectionId": "openai-main",
                "model": "gpt-5",
                "modelProfileId": "openai-main:gpt-5"
            }),
            json!({ "engine": "hermes" }),
        )
        .await
        .unwrap();
    let runtime = response.runtime.unwrap();

    assert_eq!(runtime["provider"], "openai");
    assert_eq!(runtime["providerConnectionId"], "openai-main");
    assert_eq!(runtime["apiKey"], "secret-key");
    assert_eq!(runtime["apiKeyEnv"], "OPENAI_API_KEY");
    assert_eq!(runtime["apiMode"], "responses");
    assert_eq!(runtime["source"], "mia-core");
}

#[tokio::test]
async fn hermes_runtime_config_is_prepared_inside_core_with_provider_runtime() {
    let db = init_database_memory().await.unwrap();
    let dir = temp_runtime_dir("mia-core-system-hermes-config");
    let hermes_home = dir.join(".hermes");
    let home = dir.join("engine-home");
    let config_path = hermes_home.join("config.yaml");
    let key_path = hermes_home.join("mia-api-server.key");
    let bot_manifest = home.join("bots").join("manifest.json");
    std::fs::create_dir_all(&hermes_home).unwrap();
    std::fs::write(
        &config_path,
        [
            "platforms:",
            "  telegram:",
            "    enabled: true",
            "agent:",
            "  disabled_toolsets:",
            "    - browser",
            "mcp_servers:",
            "  user_server:",
            "    command: uvx",
            "    args:",
            "      - user-tool",
        ]
        .join("\n"),
    )
    .unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    service
        .save_model_selection(SaveModelSelectionRequest {
            selection: json!({
                "provider": "openai",
                "providerConnectionId": "openai-main",
                "providerLabel": "OpenAI",
                "model": "gpt-5",
                "apiKeyEnv": "OPENAI_API_KEY",
                "apiKey": "stored-key",
                "baseUrl": "https://api.openai.com/v1",
                "apiMode": "responses"
            }),
        })
        .await
        .unwrap();

    let response = service
        .prepare_hermes_runtime_config(PrepareHermesRuntimeConfigRequest {
            port: 19191,
            paths: HermesRuntimeConfigPaths {
                home: home.to_string_lossy().to_string(),
                hermes_home: hermes_home.to_string_lossy().to_string(),
                config: config_path.to_string_lossy().to_string(),
                api_server_key: key_path.to_string_lossy().to_string(),
                bot_manifest: bot_manifest.to_string_lossy().to_string(),
            },
            permission_settings: json!({ "mode": "ask" }),
            effort_settings: json!({ "level": "high" }),
            mia_app_mcp_spec: json!({
                "type": "stdio",
                "command": "/usr/local/bin/node",
                "args": ["/opt/mia/mia-app-mcp-server.js"],
                "env": { "MIA_CORE_URL": "http://127.0.0.1:27861" },
                "alwaysLoad": true
            }),
            scheduler_mcp_spec: json!({
                "command": "/usr/local/bin/node",
                "args": ["/opt/mia/scheduler-mcp-server.js"],
                "env": { "MIA_SCHEDULER_CONTEXT_FILE": "/tmp/ctx.json" }
            }),
            user_mcp_specs: [
                (
                    "mia-app".to_string(),
                    json!({ "url": "http://bad.example/mcp" }),
                ),
                (
                    "xhs".to_string(),
                    json!({ "url": "http://127.0.0.1:18060/mcp", "headers": {} }),
                ),
            ]
            .into_iter()
            .collect(),
        })
        .await
        .unwrap();

    assert!(response.ok);
    assert_eq!(response.config_path, config_path.to_string_lossy());
    assert_ne!(response.api_server_key, "stored-key");
    assert_eq!(
        std::fs::read_to_string(&key_path).unwrap().trim(),
        response.api_server_key
    );

    let parsed: serde_json::Value =
        serde_yaml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(parsed["model"]["provider"], "openai");
    assert_eq!(parsed["model"]["default"], "gpt-5");
    assert_eq!(parsed["model"]["base_url"], "https://api.openai.com/v1");
    assert_eq!(parsed["model"]["api_mode"], "responses");
    assert_eq!(parsed["providers"]["openai"]["name"], "OpenAI");
    assert_eq!(parsed["providers"]["openai"]["key_env"], "OPENAI_API_KEY");
    assert_eq!(parsed["providers"]["openai"]["api_key"], "stored-key");
    assert_eq!(parsed["platforms"]["telegram"]["enabled"], true);
    assert_eq!(parsed["platforms"]["api_server"]["port"], 19191);
    assert_eq!(
        parsed["platforms"]["api_server"]["key"],
        response.api_server_key
    );
    assert_eq!(parsed["approvals"]["mode"], "ask");
    assert_eq!(parsed["agent"]["reasoning_effort"], "high");
    assert_eq!(
        parsed["agent"]["disabled_toolsets"],
        json!(["browser", "cronjob"])
    );
    assert_eq!(
        parsed["mcp_servers"]["mia-app"]["command"],
        "/usr/local/bin/node"
    );
    assert!(parsed["mcp_servers"]["mia-app"].get("alwaysLoad").is_none());
    assert!(parsed["mcp_servers"]["mia-app"].get("url").is_none());
    assert_eq!(
        parsed["mcp_servers"]["xhs"]["url"],
        "http://127.0.0.1:18060/mcp"
    );
    assert_eq!(parsed["mia"]["runtime_schema"], 1);
    assert_eq!(
        parsed["mia"]["bots_manifest"],
        bot_manifest.to_string_lossy().to_string()
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn hermes_runtime_config_clears_stale_mia_owned_provider_when_no_selection_exists() {
    let db = init_database_memory().await.unwrap();
    let dir = temp_runtime_dir("mia-core-system-hermes-stale-config");
    let hermes_home = dir.join(".hermes");
    let home = dir.join("engine-home");
    let config_path = hermes_home.join("config.yaml");
    let key_path = hermes_home.join("mia-api-server.key");
    let bot_manifest = home.join("bots").join("manifest.json");
    std::fs::create_dir_all(&hermes_home).unwrap();
    std::fs::write(
        &config_path,
        [
            "mia:",
            "  runtime_schema: 1",
            "model:",
            "  provider: openai",
            "  default: gpt-x",
            "providers:",
            "  openai:",
            "    name: OpenAI",
            "    base_url: https://api.example.test/v1",
        ]
        .join("\n"),
    )
    .unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    service
        .prepare_hermes_runtime_config(PrepareHermesRuntimeConfigRequest {
            port: 19191,
            paths: HermesRuntimeConfigPaths {
                home: home.to_string_lossy().to_string(),
                hermes_home: hermes_home.to_string_lossy().to_string(),
                config: config_path.to_string_lossy().to_string(),
                api_server_key: key_path.to_string_lossy().to_string(),
                bot_manifest: bot_manifest.to_string_lossy().to_string(),
            },
            permission_settings: json!({}),
            effort_settings: json!({}),
            mia_app_mcp_spec: json!(null),
            scheduler_mcp_spec: json!(null),
            user_mcp_specs: Default::default(),
        })
        .await
        .unwrap();

    let parsed: serde_json::Value =
        serde_yaml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert!(parsed.get("model").is_none());
    assert!(parsed.get("providers").is_none());
    assert_eq!(parsed["platforms"]["api_server"]["port"], 19191);
    assert_eq!(parsed["mia"]["runtime_schema"], 1);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn provider_runtime_resolution_keeps_native_cli_defaults_unassembled() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    let response = service
        .resolve_model_runtime(
            json!({ "providerConnectionId": "openai-codex", "model": "gpt-5" }),
            json!({ "engine": "codex" }),
        )
        .await
        .unwrap();

    assert_eq!(response.runtime, None);
}

#[tokio::test]
async fn provider_runtime_resolution_returns_mia_managed_reference_without_cloud_secret() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    let response = service
        .resolve_model_runtime(
            json!({ "modelProfileId": "mia:mia-default" }),
            json!({ "engine": "hermes" }),
        )
        .await
        .unwrap();
    let runtime = response.runtime.unwrap();

    assert_eq!(runtime["provider"], "mia");
    assert_eq!(runtime["model"], "mia-auto");
    assert_eq!(runtime["requiresCloud"], true);
    assert!(runtime.get("apiKey").is_none());
}

#[tokio::test]
async fn model_selection_intent_persists_provider_and_redacted_client_settings_inside_core() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    let response = service
        .save_model_selection(SaveModelSelectionRequest {
            selection: json!({
                "provider": "anthropic",
                "providerConnectionId": "anthropic-main",
                "providerLabel": "Claude",
                "authType": "api_key",
                "model": "claude-3-5-sonnet",
                "modelProfileId": "anthropic-main:claude-3-5-sonnet",
                "apiKeyEnv": "ANTHROPIC_API_KEY",
                "apiKey": "stored-key",
                "baseUrl": "https://api.anthropic.com",
                "apiMode": "messages"
            }),
        })
        .await
        .unwrap();

    assert_eq!(response.settings["provider"], "anthropic");
    assert_eq!(response.settings["providerConnectionId"], "anthropic-main");
    assert_eq!(response.settings["model"], "claude-3-5-sonnet");
    assert!(response.settings.get("apiKey").is_none());
    assert!(response.settings.get("apiKeyEnv").is_none());
    assert!(response.settings.get("baseUrl").is_none());
    assert!(response.settings.get("apiMode").is_none());

    let persisted = service.client_settings().await.unwrap();
    assert_eq!(persisted.settings, response.settings);

    let runtime = service
        .resolve_model_runtime(
            json!({ "providerConnectionId": "anthropic-main", "model": "claude-3-5-sonnet" }),
            json!({ "engine": "hermes" }),
        )
        .await
        .unwrap()
        .runtime
        .unwrap();
    assert_eq!(runtime["apiKey"], "stored-key");
    assert_eq!(runtime["apiKeyEnv"], "ANTHROPIC_API_KEY");
    assert_eq!(runtime["baseUrl"], "https://api.anthropic.com");
    assert_eq!(runtime["apiMode"], "messages");
}

#[tokio::test]
async fn model_selection_infers_provider_defaults_when_ui_sends_only_selection_intent() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    let response = service
        .save_model_selection(SaveModelSelectionRequest {
            selection: json!({
                "provider": "anthropic",
                "providerConnectionId": "anthropic-main",
                "model": "claude-sonnet-4.6",
                "apiKey": "stored-key"
            }),
        })
        .await
        .unwrap();

    assert_eq!(response.settings["provider"], "anthropic");
    assert_eq!(response.settings["providerConnectionId"], "anthropic-main");
    assert_eq!(response.settings["providerLabel"], "Anthropic");
    assert_eq!(response.settings["authType"], "api_key");
    assert_eq!(response.settings["model"], "claude-sonnet-4.6");
    assert!(response.settings.get("apiKey").is_none());
    assert!(response.settings.get("apiKeyEnv").is_none());
    assert!(response.settings.get("baseUrl").is_none());
    assert!(response.settings.get("apiMode").is_none());

    let runtime = service
        .resolve_model_runtime(
            json!({ "providerConnectionId": "anthropic-main", "model": "claude-sonnet-4.6" }),
            json!({ "engine": "hermes" }),
        )
        .await
        .unwrap()
        .runtime
        .unwrap();
    assert_eq!(runtime["providerLabel"], "Anthropic");
    assert_eq!(runtime["apiKeyEnv"], "ANTHROPIC_API_KEY");
    assert_eq!(runtime["apiKey"], "stored-key");
    assert_eq!(runtime["apiMode"], "anthropic_messages");
}

#[tokio::test]
async fn model_selection_canonicalizes_mia_managed_defaults_inside_core() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    let response = service
        .save_model_selection(SaveModelSelectionRequest {
            selection: json!({
                "model": "mia-default",
                "modelProfileId": "mia:mia-default"
            }),
        })
        .await
        .unwrap();

    assert_eq!(
        response.settings,
        json!({
            "provider": "mia",
            "providerConnectionId": "mia",
            "providerLabel": "Mia",
            "authType": "mia_account",
            "model": "mia-auto",
            "modelProfileId": "mia:mia-auto"
        })
    );
}

#[tokio::test]
async fn model_selection_treats_empty_api_key_as_no_secret_update() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    service
        .save_model_selection(SaveModelSelectionRequest {
            selection: json!({
                "provider": "openai",
                "providerConnectionId": "openai-main",
                "providerLabel": "OpenAI",
                "model": "gpt-5.3",
                "apiKey": "stored-key",
                "apiKeyEnv": "OPENAI_API_KEY"
            }),
        })
        .await
        .unwrap();
    service
        .save_model_selection(SaveModelSelectionRequest {
            selection: json!({
                "provider": "openai",
                "providerConnectionId": "openai-main",
                "providerLabel": "OpenAI",
                "model": "gpt-5.4",
                "apiKey": "",
                "apiKeyEnv": "OPENAI_API_KEY"
            }),
        })
        .await
        .unwrap();

    let runtime = service
        .resolve_model_runtime(
            json!({ "providerConnectionId": "openai-main", "model": "gpt-5.4" }),
            json!({ "engine": "hermes" }),
        )
        .await
        .unwrap()
        .runtime
        .unwrap();
    assert_eq!(runtime["apiKey"], "stored-key");
}

#[tokio::test]
async fn settings_runtime_options_for_hermes_are_owned_by_core() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    let response = service.runtime_control_options(SettingsRuntimeControlOptionsRequest {
        active_agent_engine: Some("hermes".into()),
        runtime: json!({
            "engineRunning": true,
            "cloud": { "enabled": true },
            "connectedProviders": [
                { "provider": "anthropic", "providerLabel": "Claude", "hasApiKey": true }
            ],
            "model": {
                "provider": "anthropic",
                "providerConnectionId": "anthropic",
                "providerLabel": "Claude",
                "model": "claude-sonnet-4.6",
                "modelProfileId": "anthropic:claude-sonnet-4.6"
            },
            "effort": { "level": "high" },
            "permissions": { "mode": "yolo" }
        }),
        engine_config: json!({}),
        model_catalog: json!([
            {
                "id": "anthropic::claude-sonnet-4.6",
                "provider": "anthropic",
                "providerLabel": "Claude",
                "model": "claude-sonnet-4.6",
                "label": "Claude Sonnet 4.6",
                "authType": "api_key",
                "modelProfileId": "anthropic:claude-sonnet-4.6"
            },
            {
                "id": "openai::gpt-5.3",
                "provider": "openai",
                "providerLabel": "OpenAI",
                "model": "gpt-5.3",
                "label": "GPT-5.3",
                "authType": "api_key"
            }
        ]),
        platform_models: json!([
            { "id": "mia-auto", "label": "Auto" }
        ]),
        engine_capabilities: json!({
            "approvalModes": ["ask", "yolo", "deny"],
            "effortLevels": ["low", "medium", "high"]
        }),
        codex_models: json!([]),
    });

    assert_eq!(response.agent_engine, "hermes");
    assert!(!response.external_engine);
    assert_eq!(response.status_text, "已连接");
    assert_eq!(response.selected_model, "anthropic::claude-sonnet-4.6");
    assert_eq!(response.selected_effort, "high");
    assert_eq!(response.selected_permission, "yolo");
    assert_eq!(
        response
            .model_options
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        vec!["anthropic::claude-sonnet-4.6", "mia-auto"]
    );
    assert_eq!(
        response
            .add_provider_options
            .iter()
            .map(|entry| entry.provider.as_str())
            .collect::<Vec<_>>(),
        vec!["openai"]
    );
}

#[tokio::test]
async fn settings_runtime_options_for_codex_use_core_capability_fallbacks() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    let response = service.runtime_control_options(SettingsRuntimeControlOptionsRequest {
        active_agent_engine: Some("openai-codex".into()),
        runtime: json!({
            "permissions": {
                "mode": "ask",
                "engines": { "codex": ":danger-full-access" }
            }
        }),
        engine_config: json!({
            "model": "gpt-5.3-codex",
            "effortLevel": "xhigh"
        }),
        model_catalog: json!([]),
        platform_models: json!([{ "id": "mia-auto" }]),
        engine_capabilities: json!({
            "engines": {
                "codex": {
                    "permissionProfiles": [
                        { "id": ":workspace", "description": "workspace write" },
                        { "id": ":danger-full-access", "description": "full access" }
                    ],
                    "models": [
                        {
                            "slug": "gpt-5.3-codex",
                            "displayName": "GPT-5.3 Codex",
                            "supportedReasoningLevels": [
                                { "effort": "medium", "label": "Medium" },
                                { "effort": "xhigh", "label": "Extra high" }
                            ]
                        }
                    ]
                }
            }
        }),
        codex_models: json!([]),
    });

    assert_eq!(response.agent_engine, "codex");
    assert!(response.external_engine);
    assert_eq!(response.status_text, "Codex");
    assert_eq!(response.selected_model, "gpt-5.3-codex");
    assert_eq!(response.selected_effort, "xhigh");
    assert_eq!(response.selected_permission, ":danger-full-access");
    assert_eq!(
        response
            .model_options
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        vec!["default", "gpt-5.3-codex", "mia-auto"]
    );
    assert_eq!(
        response
            .permission_options
            .iter()
            .map(|entry| entry.value.as_str())
            .collect::<Vec<_>>(),
        vec![":workspace", ":danger-full-access"]
    );
    assert_eq!(
        response
            .effort_options
            .iter()
            .map(|entry| entry.value.as_str())
            .collect::<Vec<_>>(),
        vec!["medium", "xhigh"]
    );
}

#[tokio::test]
async fn settings_runtime_options_fall_back_to_codex_default_for_unknown_saved_model() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    let response = service.runtime_control_options(SettingsRuntimeControlOptionsRequest {
        active_agent_engine: Some("codex".into()),
        runtime: json!({}),
        engine_config: json!({
            "model": "gpt-5.3-codex",
            "effortLevel": "medium"
        }),
        model_catalog: json!([]),
        platform_models: json!([]),
        engine_capabilities: json!({
            "engines": {
                "codex": {
                    "models": [
                        { "slug": "gpt-5.5", "displayName": "gpt-5.5" }
                    ]
                }
            }
        }),
        codex_models: json!([]),
    });

    assert_eq!(response.selected_model, "default");
    assert_eq!(
        response.selected_model_entry.as_ref().unwrap().label,
        "Codex 默认"
    );
    let model_ids = response
        .model_options
        .iter()
        .map(|entry| entry.id.as_str())
        .collect::<Vec<_>>();
    assert!(model_ids.contains(&"default"));
    assert!(model_ids.contains(&"gpt-5.5"));
    assert!(!model_ids.contains(&"gpt-5.3-codex"));
}

#[tokio::test]
async fn settings_runtime_options_leave_model_empty_when_codex_inventory_is_blocked() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    let response = service.runtime_control_options(SettingsRuntimeControlOptionsRequest {
        active_agent_engine: Some("codex".into()),
        runtime: json!({
            "agentInventory": {
                "agents": [
                    { "id": "codex", "usableInMia": false, "health": "blocked" }
                ]
            }
        }),
        engine_config: json!({
            "model": "gpt-5.5",
            "effortLevel": "medium"
        }),
        model_catalog: json!([]),
        platform_models: json!([{ "id": "mia-auto", "label": "Auto" }]),
        engine_capabilities: json!({
            "engines": {
                "codex": {
                    "models": [
                        { "slug": "gpt-5.5", "displayName": "gpt-5.5" }
                    ]
                }
            }
        }),
        codex_models: json!([]),
    });

    assert!(response.model_options.is_empty());
    assert_eq!(response.selected_model, "");
    assert!(response.selected_model_entry.is_none());
}

#[tokio::test]
async fn settings_runtime_options_leave_model_empty_when_hermes_inventory_is_blocked() {
    let db = init_database_memory().await.unwrap();
    let service = SystemService::new(
        "0.1.0".to_string(),
        SqliteSettingsRepository::new(db.pool().clone()),
        SqliteProviderRepository::new(db.pool().clone()),
    );

    let response = service.runtime_control_options(SettingsRuntimeControlOptionsRequest {
        active_agent_engine: Some("hermes".into()),
        runtime: json!({
            "agentInventory": {
                "agents": [
                    { "id": "hermes", "usableInMia": false, "health": "blocked" }
                ]
            },
            "cloud": { "enabled": true },
            "connectedProviders": [
                { "provider": "openai", "hasApiKey": true }
            ]
        }),
        engine_config: json!({}),
        model_catalog: json!([
            {
                "id": "openai::gpt-5.5",
                "provider": "openai",
                "model": "gpt-5.5",
                "label": "GPT-5.5"
            }
        ]),
        platform_models: json!([{ "id": "mia-auto", "label": "Auto" }]),
        engine_capabilities: json!({}),
        codex_models: json!([]),
    });

    assert!(response.model_options.is_empty());
    assert_eq!(response.selected_model, "");
    assert!(response.selected_model_entry.is_none());
}
