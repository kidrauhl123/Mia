use mia_core_api_types::{
    BotCapabilityIntent, BotCapabilityOptionsRequest, BotCapabilityPresetInput,
    BotCapabilitySkillInput, BotRuntimeControlIntent, BotRuntimeControlOptionsRequest,
    BotRuntimeModelEntryIntent, BotRuntimeSyncIntent, BotRuntimeTargetIntent,
    BotRuntimeTargetOptionsRequest, CreateBotRequest, EnsureBotSessionConversationRequest,
    MemoryMode, SaveBotRuntimeRequest, StarterBotEnsureRequest, UpdateBotRequest,
};
use mia_core_bot::BotService;
use mia_core_db::init_database_memory;
use serde_json::json;

#[tokio::test]
async fn bot_service_owns_identity_defaults_and_runtime_binding() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let created = service
        .create_bot(CreateBotRequest {
            display_name: "Mia Helper".to_string(),
            identity: json!({"persona":"direct"}),
            capabilities: json!({"tools":true}),
        })
        .await
        .unwrap();
    assert!(created.bot.id.starts_with("bot_"));
    assert_eq!(created.bot.display_name, "Mia Helper");

    let runtime = service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "agent".to_string(),
                provider_connection_id: Some("provider_openai".to_string()),
                model_profile_id: Some("profile_fast".to_string()),
                model: Some("gpt-5-mini".to_string()),
                target_intent: None,
                sync_intent: None,
                control_intent: None,
                config: json!({"temperature":0.2,"apiKey":"must-not-be-promoted-by-ui"}),
            },
        )
        .await
        .unwrap();

    assert_eq!(runtime.bot_id, created.bot.id);
    assert_eq!(runtime.runtime_kind, "agent");
    assert_eq!(runtime.binding["providerConnectionId"], "provider_openai");
    assert_eq!(runtime.binding["modelProfileId"], "profile_fast");
    assert_eq!(runtime.binding["model"], "gpt-5-mini");

    let loaded_runtime = service.get_runtime(&created.bot.id, "agent").await.unwrap();
    assert_eq!(loaded_runtime.runtime_kind, "agent");
    assert_eq!(
        loaded_runtime.binding["providerConnectionId"],
        "provider_openai"
    );
}

#[tokio::test]
async fn missing_runtime_binding_inherits_the_bot_identity_engine() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());
    let created = service
        .create_bot(CreateBotRequest {
            display_name: "Codex".into(),
            identity: json!({
                "runtimeKind": "desktop-local",
                "agentEngine": "codex"
            }),
            capabilities: json!({}),
        })
        .await
        .unwrap();

    let runtime = service.get_runtime(&created.bot.id, "agent").await.unwrap();

    assert_eq!(runtime.runtime_kind, "agent");
    assert_eq!(runtime.binding["agentEngine"], "codex");
    assert_eq!(runtime.binding["config"]["agentEngine"], "codex");
    assert_eq!(runtime.binding["providerConnectionId"], "mia");
    assert_eq!(runtime.binding["modelProfileId"], "mia:mia-auto");
    assert_eq!(runtime.binding["model"], "mia-auto");
    assert_eq!(runtime.binding["config"]["providerConnectionId"], "mia");
    assert_eq!(runtime.binding["config"]["modelProfileId"], "mia:mia-auto");
    assert_eq!(runtime.binding["config"]["model"], "mia-auto");
}

#[tokio::test]
async fn bot_service_owns_runtime_target_intent_normalization() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());
    let created = service
        .create_bot(CreateBotRequest {
            display_name: "Runner".to_string(),
            identity: json!({}),
            capabilities: json!({}),
        })
        .await
        .unwrap();

    let desktop = service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "desktop-local".to_string(),
                provider_connection_id: None,
                model_profile_id: None,
                model: None,
                target_intent: Some(BotRuntimeTargetIntent {
                    device_id: Some("device_mac".to_string()),
                    device_name: Some("Office Mac.local".to_string()),
                    agent_engine: Some("openai-codex".to_string()),
                }),
                sync_intent: None,
                control_intent: None,
                config: json!({"model":"gpt-5.3","providerConnectionId":"codex","modelProfileId":"codex:gpt-5.3"}),
            },
        )
        .await
        .unwrap();
    assert_eq!(desktop.binding["config"]["agentEngine"], "codex");
    assert_eq!(desktop.binding["config"]["deviceId"], "device_mac");
    assert_eq!(desktop.binding["config"]["deviceName"], "Office Mac");
    assert_eq!(desktop.binding["runtimeKind"], "desktop-local");
    assert_eq!(desktop.binding["agentEngine"], "codex");
    assert_eq!(desktop.binding["targetDeviceId"], "device_mac");
    assert_eq!(desktop.binding["targetDeviceName"], "Office Mac");
    assert_eq!(desktop.binding["runtimeLabel"], "Office Mac");
    assert!(desktop.binding["providerConnectionId"].is_null());
    assert!(desktop.binding["modelProfileId"].is_null());
    assert!(desktop.binding["model"].is_null());
    assert!(desktop.binding["config"].get("model").is_none());
    assert!(
        desktop.binding["config"]
            .get("providerConnectionId")
            .is_none()
    );
    assert!(desktop.binding["config"].get("modelProfileId").is_none());

    let cloud = service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "cloud-claude-code".to_string(),
                provider_connection_id: None,
                model_profile_id: None,
                model: None,
                target_intent: Some(BotRuntimeTargetIntent {
                    device_id: None,
                    device_name: None,
                    agent_engine: Some("claude".to_string()),
                }),
                sync_intent: None,
                control_intent: None,
                config: json!({}),
            },
        )
        .await
        .unwrap();
    assert_eq!(cloud.binding["config"]["agentEngine"], "claude-code");
    assert_eq!(cloud.binding["config"]["model"], "mia-auto");
    assert_eq!(cloud.binding["config"]["providerConnectionId"], "mia");
    assert_eq!(cloud.binding["config"]["modelProfileId"], "mia:mia-auto");
    assert_eq!(cloud.binding["config"]["effortLevel"], "medium");
    assert_eq!(
        cloud.binding["config"]["permissionMode"],
        "bypassPermissions"
    );
    assert_eq!(cloud.binding["runtimeKind"], "cloud-claude-code");
    assert_eq!(cloud.binding["agentEngine"], "claude-code");
    assert_eq!(cloud.binding["targetDeviceId"], "");
    assert_eq!(cloud.binding["targetDeviceName"], "Mia Cloud");
    assert_eq!(cloud.binding["runtimeLabel"], "Mia Cloud");
}

#[tokio::test]
async fn bot_service_runtime_binding_does_not_require_local_bot_identity() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let runtime = service
        .save_runtime(
            "cloud_bot_123",
            SaveBotRuntimeRequest {
                runtime_kind: "desktop-local".to_string(),
                provider_connection_id: Some("mia".to_string()),
                model_profile_id: Some("mia:mia-auto".to_string()),
                model: Some("mia-auto".to_string()),
                target_intent: Some(BotRuntimeTargetIntent {
                    device_id: Some("mac-1".to_string()),
                    device_name: Some("Jung Mac.local".to_string()),
                    agent_engine: Some("hermes".to_string()),
                }),
                sync_intent: None,
                control_intent: None,
                config: json!({
                    "model": "mia-auto",
                    "providerConnectionId": "mia",
                    "modelProfileId": "mia:mia-auto"
                }),
            },
        )
        .await
        .unwrap();
    assert_eq!(runtime.bot_id, "cloud_bot_123");
    assert_eq!(runtime.binding["runtimeKind"], "desktop-local");
    assert_eq!(runtime.binding["agentEngine"], "hermes");
    assert_eq!(runtime.binding["targetDeviceId"], "mac-1");
    assert_eq!(runtime.binding["targetDeviceName"], "Jung Mac");
    assert!(runtime.binding["providerConnectionId"].is_null());
    assert!(runtime.binding["config"].get("model").is_none());

    let conversation = service
        .ensure_session_conversation(
            "cloud_bot_123",
            EnsureBotSessionConversationRequest {
                session_id: "cloud_bot_123".to_string(),
                title: Some("Mia Bot".to_string()),
                runtime_kind: Some("desktop-local".to_string()),
                metadata: json!({}),
            },
        )
        .await
        .unwrap();
    assert!(conversation.conversation_id.starts_with("conv_"));
    assert!(service.get_bot("cloud_bot_123").await.is_err());
}

#[tokio::test]
async fn bot_service_owns_runtime_control_intent_normalization() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());
    let created = service
        .create_bot(CreateBotRequest {
            display_name: "Runtime Controls".to_string(),
            identity: json!({}),
            capabilities: json!({}),
        })
        .await
        .unwrap();

    service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "desktop-local".to_string(),
                provider_connection_id: None,
                model_profile_id: None,
                model: None,
                target_intent: None,
                sync_intent: None,
                control_intent: None,
                config: json!({
                    "agentEngine": "hermes",
                    "model": "old-model",
                    "provider": "legacy-provider",
                    "modelProvider": "legacy-provider",
                    "providerLabel": "Legacy",
                    "authType": "api_key",
                    "apiKeyEnv": "LEGACY_KEY",
                    "baseUrl": "https://legacy.example",
                    "apiMode": "openai",
                    "modelEntries": [{
                        "id": "mia-default",
                        "model": "mia-default",
                        "provider": "mia",
                        "providerLabel": "Mia",
                        "authType": "mia_account",
                        "modelProfileId": "mia:mia-default",
                        "apiKeyEnv": "MIA_CLOUD_MODEL_TOKEN",
                        "baseUrl": "https://should-not-persist.example/v1",
                        "apiMode": "chat_completions"
                    }],
                    "effortLevel": "low",
                    "permissionMode": "ask",
                    "harmlessFlag": "keep-me"
                }),
            },
        )
        .await
        .unwrap();

    let model = service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "desktop-local".to_string(),
                provider_connection_id: None,
                model_profile_id: None,
                model: None,
                target_intent: None,
                sync_intent: None,
                control_intent: Some(BotRuntimeControlIntent {
                    field: "model".to_string(),
                    value: "mia-default".to_string(),
                    model_entries: vec![BotRuntimeModelEntryIntent {
                        id: Some("mia-default".to_string()),
                        value: None,
                        label: Some("Default".to_string()),
                        model: Some("mia-default".to_string()),
                        provider: Some("mia".to_string()),
                        provider_label: Some("Mia".to_string()),
                        auth_type: Some("mia_account".to_string()),
                        model_profile_id: Some("mia:mia-default".to_string()),
                        profile_id: None,
                    }],
                }),
                config: json!({}),
            },
        )
        .await
        .unwrap();
    assert_eq!(model.binding["config"]["model"], "mia-auto");
    assert_eq!(model.binding["config"]["providerConnectionId"], "mia");
    assert_eq!(model.binding["config"]["modelProfileId"], "mia:mia-auto");
    assert_eq!(model.binding["config"]["effortLevel"], "low");
    assert_eq!(model.binding["config"]["permissionMode"], "ask");
    assert_eq!(model.binding["config"]["harmlessFlag"], "keep-me");
    assert_eq!(
        model.binding["config"]["modelEntries"][0],
        json!({
            "id": "mia-auto",
            "model": "mia-auto",
            "provider": "mia",
            "providerLabel": "Mia",
            "authType": "mia_account",
            "modelProfileId": "mia:mia-auto"
        })
    );
    for key in [
        "provider",
        "modelProvider",
        "providerLabel",
        "authType",
        "apiKeyEnv",
        "baseUrl",
        "apiMode",
    ] {
        assert!(
            model.binding["config"].get(key).is_none(),
            "{key} should be stripped"
        );
    }
    for key in ["apiKeyEnv", "baseUrl", "apiMode"] {
        assert!(
            model.binding["config"]["modelEntries"][0]
                .get(key)
                .is_none(),
            "{key} should be stripped from model entries"
        );
    }

    let effort = service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "desktop-local".to_string(),
                provider_connection_id: None,
                model_profile_id: None,
                model: None,
                target_intent: None,
                sync_intent: None,
                control_intent: Some(BotRuntimeControlIntent {
                    field: "effort".to_string(),
                    value: "high".to_string(),
                    model_entries: vec![],
                }),
                config: json!({}),
            },
        )
        .await
        .unwrap();
    assert_eq!(effort.binding["config"]["effortLevel"], "high");

    let permission = service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "desktop-local".to_string(),
                provider_connection_id: None,
                model_profile_id: None,
                model: None,
                target_intent: None,
                sync_intent: None,
                control_intent: Some(BotRuntimeControlIntent {
                    field: "permission".to_string(),
                    value: "yolo".to_string(),
                    model_entries: vec![],
                }),
                config: json!({}),
            },
        )
        .await
        .unwrap();
    assert_eq!(permission.binding["config"]["permissionMode"], "yolo");
}

#[tokio::test]
async fn bot_service_owns_runtime_control_options_selection() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let response = service.runtime_control_options(BotRuntimeControlOptionsRequest {
        runtime_kind: Some("desktop-local".to_string()),
        bot: json!({ "key": "codex", "agentEngine": "codex" }),
        runtime: json!({
            "agentInventory": {
                "agents": [
                    { "id": "codex", "usableInMia": true, "health": "ready" }
                ]
            },
            "permissions": {
                "mode": "ask",
                "engines": { "codex": ":danger-full-access" }
            },
            "model": { "provider": "mia", "model": "mia-auto" }
        }),
        binding: json!({
            "config": {
                "agentEngine": "codex",
                "model": "gpt-5.3-codex",
                "providerConnectionId": "codex",
                "modelProfileId": "codex:gpt-5.3-codex",
                "effortLevel": "xhigh",
                "permissionMode": "readOnly"
            }
        }),
        model_catalog: json!([]),
        platform_models: json!([]),
        engine_capabilities: json!({
            "engines": {
                "codex": {
                    "models": [
                        {
                            "slug": "gpt-5.3-codex",
                            "displayName": "GPT-5.3 Codex",
                            "supportedReasoningLevels": [
                                { "effort": "medium", "label": "Medium" },
                                { "effort": "xhigh", "label": "X High" }
                            ]
                        }
                    ],
                    "permissionProfiles": [
                        { "id": ":danger-full-access", "description": "Full Access" },
                        { "id": ":read-only", "description": "Read Only" }
                    ]
                }
            }
        }),
        codex_models: json!([]),
    });

    assert_eq!(response.runtime_kind, "desktop-local");
    assert_eq!(response.agent_engine, "codex");
    assert_eq!(response.status_text, "Codex");
    assert!(!response.send_blocked);
    assert_eq!(response.send_block_reason, "");
    assert_eq!(
        response
            .model_options
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        vec!["gpt-5.3-codex"]
    );
    assert_eq!(response.selected_model, "gpt-5.3-codex");
    assert_eq!(
        response.selected_model_entry.as_ref().unwrap().label,
        "GPT-5.3 Codex"
    );
    assert_eq!(response.selected_effort, "xhigh");
    assert_eq!(response.selected_permission, "readOnly");
}

#[tokio::test]
async fn bot_service_includes_platform_models_in_desktop_external_controls() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let response = service.runtime_control_options(BotRuntimeControlOptionsRequest {
        runtime_kind: Some("desktop-local".to_string()),
        bot: json!({ "key": "codex", "agentEngine": "codex" }),
        runtime: json!({
            "agentInventory": {
                "agents": [
                    { "id": "codex", "usableInMia": true, "health": "ready" }
                ]
            }
        }),
        binding: json!({ "config": { "agentEngine": "codex" } }),
        model_catalog: json!([]),
        platform_models: json!([{ "id": "mia-auto", "label": "Auto" }]),
        engine_capabilities: json!({
            "engines": {
                "codex": {
                    "models": [
                        { "slug": "gpt-5.5", "displayName": "GPT-5.5" }
                    ]
                }
            }
        }),
        codex_models: json!([]),
    });

    assert_eq!(
        response
            .model_options
            .iter()
            .map(|entry| (entry.provider.as_str(), entry.id.as_str()))
            .collect::<Vec<_>>(),
        vec![("mia", "mia-auto"), ("codex", "gpt-5.5")]
    );
    assert_eq!(response.selected_model, "mia-auto");
    assert_eq!(
        response.selected_model_entry.as_ref().unwrap().provider,
        "mia"
    );
}

#[tokio::test]
async fn bot_service_leaves_external_model_empty_when_saved_model_is_not_available() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let response = service.runtime_control_options(BotRuntimeControlOptionsRequest {
        runtime_kind: Some("desktop-local".to_string()),
        bot: json!({ "key": "codex", "agentEngine": "codex" }),
        runtime: json!({
            "agentInventory": {
                "agents": [
                    { "id": "codex", "usableInMia": true, "health": "ready" }
                ]
            }
        }),
        binding: json!({
            "config": {
                "agentEngine": "codex",
                "model": "gpt-5.3-codex",
                "providerConnectionId": "codex",
                "modelProfileId": "codex:gpt-5.3-codex"
            }
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

    assert_eq!(response.selected_model, "");
    assert!(response.selected_model_entry.is_none());
    let model_ids = response
        .model_options
        .iter()
        .map(|entry| entry.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(model_ids, vec!["gpt-5.5"]);
    assert!(!model_ids.contains(&"gpt-5.3-codex"));
}

#[tokio::test]
async fn bot_service_does_not_synthesize_external_effort_or_permissions() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let response = service.runtime_control_options(BotRuntimeControlOptionsRequest {
        runtime_kind: Some("desktop-local".to_string()),
        bot: json!({ "key": "codex", "agentEngine": "codex" }),
        runtime: json!({
            "agentInventory": {
                "agents": [
                    { "id": "codex", "usableInMia": true, "health": "ready" }
                ]
            }
        }),
        binding: json!({
            "config": {
                "agentEngine": "codex",
                "model": "gpt-5.5",
                "effortLevel": "medium",
                "permissionMode": "default"
            }
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

    assert_eq!(response.selected_model, "gpt-5.5");
    assert_eq!(response.model_options.len(), 1);
    assert!(response.effort_options.is_empty());
    assert_eq!(response.selected_effort, "");
    assert!(response.permission_options.is_empty());
    assert_eq!(response.selected_permission, "");
}

#[tokio::test]
async fn bot_service_blocks_desktop_runtime_controls_until_inventory_is_ready() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let response = service.runtime_control_options(BotRuntimeControlOptionsRequest {
        runtime_kind: Some("desktop-local".to_string()),
        bot: json!({ "key": "hermes", "agentEngine": "hermes" }),
        runtime: json!({}),
        binding: json!({
            "config": {
                "agentEngine": "hermes",
                "model": "mia-auto",
                "providerConnectionId": "mia",
                "modelProfileId": "mia:mia-auto"
            }
        }),
        model_catalog: json!([]),
        platform_models: json!([{ "id": "mia-auto", "label": "Auto" }]),
        engine_capabilities: json!({}),
        codex_models: json!([]),
    });

    assert!(response.model_options.is_empty());
    assert_eq!(response.selected_model, "");
    assert!(response.selected_model_entry.is_none());
    assert!(response.effort_options.is_empty());
    assert_eq!(response.selected_effort, "");
    assert!(response.permission_options.is_empty());
    assert_eq!(response.selected_permission, "");
    assert!(response.send_blocked);
    assert_eq!(response.send_block_reason, "Hermes 运行时自检未完成");
}

#[tokio::test]
async fn bot_service_leaves_model_empty_when_codex_inventory_is_blocked() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let response = service.runtime_control_options(BotRuntimeControlOptionsRequest {
        runtime_kind: Some("desktop-local".to_string()),
        bot: json!({ "key": "codex", "agentEngine": "codex" }),
        runtime: json!({
            "agentInventory": {
                "agents": [
                    {
                        "id": "codex",
                        "usableInMia": false,
                        "health": "blocked",
                        "readiness": {
                            "status": "blocked",
                            "summary": "Codex ACP launcher 未检测到: npx",
                            "detail": "npx",
                            "action": ""
                        }
                    }
                ]
            }
        }),
        binding: json!({
            "config": {
                "agentEngine": "codex",
                "model": "gpt-5.5"
            }
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
    assert!(response.effort_options.is_empty());
    assert_eq!(response.selected_effort, "");
    assert!(response.permission_options.is_empty());
    assert_eq!(response.selected_permission, "");
    assert!(response.send_blocked);
    assert_eq!(
        response.send_block_reason,
        "Codex ACP launcher 未检测到: npx"
    );
}

#[tokio::test]
async fn bot_service_leaves_model_empty_when_hermes_inventory_is_blocked() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let response = service.runtime_control_options(BotRuntimeControlOptionsRequest {
        runtime_kind: Some("desktop-local".to_string()),
        bot: json!({ "key": "hermes", "agentEngine": "hermes" }),
        runtime: json!({
            "agentInventory": {
                "agents": [
                    {
                        "id": "hermes",
                        "usableInMia": false,
                        "health": "blocked",
                        "readiness": {
                            "status": "blocked",
                            "summary": "Hermes runtime 协议暂不受 Mia 支持",
                            "detail": "protocol=legacy",
                            "action": ""
                        }
                    }
                ]
            },
            "cloud": { "enabled": true },
            "connectedProviders": [
                { "provider": "openai", "hasApiKey": true }
            ]
        }),
        binding: json!({}),
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
    assert!(response.effort_options.is_empty());
    assert_eq!(response.selected_effort, "");
    assert!(response.permission_options.is_empty());
    assert_eq!(response.selected_permission, "");
    assert!(response.send_blocked);
    assert_eq!(
        response.send_block_reason,
        "Hermes runtime 协议暂不受 Mia 支持"
    );
}

#[tokio::test]
async fn bot_service_treats_checking_agent_inventory_as_not_ready() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let response = service.runtime_control_options(BotRuntimeControlOptionsRequest {
        runtime_kind: Some("desktop-local".to_string()),
        bot: json!({ "key": "hermes", "agentEngine": "hermes" }),
        runtime: json!({
            "agentInventory": {
                "summary": { "scanning": true },
                "agents": [
                    {
                        "id": "hermes",
                        "usableInMia": false,
                        "health": "checking",
                        "source": "checking",
                        "readiness": { "status": "checking", "summary": "正在检查" }
                    }
                ]
            }
        }),
        binding: json!({}),
        model_catalog: json!([]),
        platform_models: json!([{ "id": "mia-auto", "label": "Auto" }]),
        engine_capabilities: json!({}),
        codex_models: json!([]),
    });

    assert!(response.send_blocked);
    assert_eq!(response.send_block_reason, "Hermes 运行时自检未完成");
}

#[tokio::test]
async fn bot_service_owns_cloud_runtime_control_permission_options() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let response = service.runtime_control_options(BotRuntimeControlOptionsRequest {
        runtime_kind: Some("cloud-claude-code".to_string()),
        bot: json!({ "key": "mia", "agentEngine": "claude-code" }),
        runtime: json!({}),
        binding: json!({}),
        model_catalog: json!([]),
        platform_models: json!([{ "id": "mia-auto", "label": "Auto" }]),
        engine_capabilities: json!({}),
        codex_models: json!([]),
    });

    assert_eq!(response.runtime_kind, "cloud-claude-code");
    assert_eq!(response.agent_engine, "claude-code");
    assert_eq!(response.permission_options.len(), 1);
    assert_eq!(response.permission_options[0].value, "bypassPermissions");
    assert_eq!(response.permission_options[0].label, "Sandbox");
    assert_eq!(response.selected_permission, "bypassPermissions");
}

#[tokio::test]
async fn bot_service_cloud_runtime_control_ignores_local_agent_inventory_blocks() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let response = service.runtime_control_options(BotRuntimeControlOptionsRequest {
        runtime_kind: Some("cloud-claude-code".to_string()),
        bot: json!({ "key": "mia", "agentEngine": "claude-code" }),
        runtime: json!({
            "agentInventory": {
                "agents": [
                    { "id": "claude-code", "usableInMia": false, "health": "blocked" }
                ]
            }
        }),
        binding: json!({}),
        model_catalog: json!([]),
        platform_models: json!([]),
        engine_capabilities: json!({}),
        codex_models: json!([]),
    });

    assert_eq!(response.runtime_kind, "cloud-claude-code");
    assert_eq!(response.agent_engine, "claude-code");
    assert!(!response.send_blocked);
    assert_eq!(response.send_block_reason, "");
    assert_eq!(response.status_text, "Mia Cloud");
}

#[tokio::test]
async fn bot_service_owns_runtime_sync_intent_normalization() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());
    let created = service
        .create_bot(CreateBotRequest {
            display_name: "Runtime Sync".to_string(),
            identity: json!({}),
            capabilities: json!({}),
        })
        .await
        .unwrap();

    let initial = service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "desktop-local".to_string(),
                provider_connection_id: None,
                model_profile_id: None,
                model: None,
                target_intent: None,
                sync_intent: Some(BotRuntimeSyncIntent {
                    agent_engine: Some("hermes".to_string()),
                    device_id: Some("device_mac".to_string()),
                    device_name: Some("Office Mac.local".to_string()),
                    model: Some("deepseek-chat".to_string()),
                    effort_level: Some("high".to_string()),
                    permission_mode: Some("yolo".to_string()),
                    model_entries: vec![BotRuntimeModelEntryIntent {
                        id: Some("deepseek-chat".to_string()),
                        value: None,
                        label: Some("DeepSeek".to_string()),
                        model: Some("deepseek-chat".to_string()),
                        provider: Some("deepseek".to_string()),
                        provider_label: Some("DeepSeek".to_string()),
                        auth_type: Some("api_key".to_string()),
                        model_profile_id: None,
                        profile_id: None,
                    }],
                }),
                control_intent: None,
                config: json!({}),
            },
        )
        .await
        .unwrap();
    assert_eq!(initial.binding["config"]["agentEngine"], "hermes");
    assert_eq!(initial.binding["config"]["deviceName"], "Office Mac");
    assert_eq!(initial.binding["config"]["model"], "deepseek-chat");
    assert_eq!(
        initial.binding["config"]["providerConnectionId"],
        "deepseek"
    );
    assert_eq!(
        initial.binding["config"]["modelProfileId"],
        "deepseek:deepseek-chat"
    );
    assert_eq!(initial.binding["config"]["effortLevel"], "high");
    assert_eq!(initial.binding["config"]["permissionMode"], "yolo");

    service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "desktop-local".to_string(),
                provider_connection_id: None,
                model_profile_id: None,
                model: None,
                target_intent: None,
                sync_intent: None,
                control_intent: None,
                config: json!({
                    "agentEngine": "hermes",
                    "model": "mia-default",
                    "providerConnectionId": "mia",
                    "modelProfileId": "mia:mia-default",
                    "effortLevel": "low",
                    "permissionMode": "ask",
                    "modelEntries": [{
                        "id": "mia-default",
                        "model": "mia-default",
                        "provider": "mia",
                        "providerLabel": "Mia",
                        "authType": "mia_account",
                        "modelProfileId": "mia:mia-default",
                        "apiKeyEnv": "MIA_CLOUD_MODEL_TOKEN",
                        "baseUrl": "https://should-not-persist.example/v1",
                        "apiMode": "chat_completions"
                    }]
                }),
            },
        )
        .await
        .unwrap();

    let preserved = service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "desktop-local".to_string(),
                provider_connection_id: None,
                model_profile_id: None,
                model: None,
                target_intent: None,
                sync_intent: Some(BotRuntimeSyncIntent {
                    agent_engine: Some("hermes".to_string()),
                    device_id: Some("device_mac".to_string()),
                    device_name: Some("Office Mac.local".to_string()),
                    model: Some("deepseek-chat".to_string()),
                    effort_level: Some("high".to_string()),
                    permission_mode: Some("yolo".to_string()),
                    model_entries: vec![BotRuntimeModelEntryIntent {
                        id: Some("deepseek-chat".to_string()),
                        value: None,
                        label: Some("DeepSeek".to_string()),
                        model: Some("deepseek-chat".to_string()),
                        provider: Some("deepseek".to_string()),
                        provider_label: Some("DeepSeek".to_string()),
                        auth_type: Some("api_key".to_string()),
                        model_profile_id: None,
                        profile_id: None,
                    }],
                }),
                control_intent: None,
                config: json!({}),
            },
        )
        .await
        .unwrap();
    assert_eq!(preserved.binding["config"]["model"], "deepseek-chat");
    assert_eq!(
        preserved.binding["config"]["providerConnectionId"],
        "deepseek"
    );
    assert_eq!(
        preserved.binding["config"]["modelProfileId"],
        "deepseek:deepseek-chat"
    );
    assert_eq!(preserved.binding["config"]["effortLevel"], "low");
    assert_eq!(preserved.binding["config"]["permissionMode"], "ask");
    assert_eq!(
        preserved.binding["config"]["modelEntries"][0],
        json!({
            "id": "deepseek-chat",
            "label": "DeepSeek",
            "model": "deepseek-chat",
            "provider": "deepseek",
            "providerLabel": "DeepSeek",
            "authType": "api_key"
        })
    );
    assert_eq!(
        preserved.binding["config"]["modelEntries"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    for key in ["apiKeyEnv", "baseUrl", "apiMode"] {
        assert!(
            preserved.binding["config"]["modelEntries"][0]
                .get(key)
                .is_none(),
            "{key} should be stripped from synced model entries"
        );
    }

    let external = service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "desktop-local".to_string(),
                provider_connection_id: None,
                model_profile_id: None,
                model: None,
                target_intent: None,
                sync_intent: Some(BotRuntimeSyncIntent {
                    agent_engine: Some("codex".to_string()),
                    device_id: Some("device_mac".to_string()),
                    device_name: Some("Office Mac.local".to_string()),
                    model: Some("gpt-5.3-codex".to_string()),
                    effort_level: Some("xhigh".to_string()),
                    permission_mode: Some("readOnly".to_string()),
                    model_entries: vec![BotRuntimeModelEntryIntent {
                        id: Some("gpt-5.3-codex".to_string()),
                        value: None,
                        label: Some("GPT-5.3 Codex".to_string()),
                        model: Some("gpt-5.3-codex".to_string()),
                        provider: Some("codex".to_string()),
                        provider_label: None,
                        auth_type: None,
                        model_profile_id: Some("codex:gpt-5.3-codex".to_string()),
                        profile_id: None,
                    }],
                }),
                control_intent: None,
                config: json!({}),
            },
        )
        .await
        .unwrap();
    assert_eq!(external.binding["config"]["agentEngine"], "codex");
    assert_eq!(external.binding["config"]["model"], "gpt-5.3-codex");
    assert_eq!(external.binding["config"]["providerConnectionId"], "codex");
    assert_eq!(
        external.binding["config"]["modelProfileId"],
        "codex:gpt-5.3-codex"
    );
    assert_eq!(external.binding["config"]["effortLevel"], "xhigh");
    assert!(external.binding["config"].get("permissionMode").is_none());
    assert_eq!(
        external.binding["config"]["modelEntries"][0],
        json!({"id":"gpt-5.3-codex","label":"GPT-5.3 Codex","model":"gpt-5.3-codex","provider":"codex","modelProfileId":"codex:gpt-5.3-codex"})
    );
}

#[tokio::test]
async fn bot_service_persists_external_runtime_permission_control_on_bot_binding() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());
    let created = service
        .create_bot(CreateBotRequest {
            display_name: "External Runtime".to_string(),
            identity: json!({}),
            capabilities: json!({}),
        })
        .await
        .unwrap();

    service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "desktop-local".to_string(),
                provider_connection_id: None,
                model_profile_id: None,
                model: None,
                target_intent: None,
                sync_intent: None,
                control_intent: None,
                config: json!({
                    "agentEngine": "codex",
                    "model": "gpt-5.3-codex",
                    "effortLevel": "xhigh",
                    "permissionMode": "readOnly"
                }),
            },
        )
        .await
        .unwrap();

    let response = service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "desktop-local".to_string(),
                provider_connection_id: None,
                model_profile_id: None,
                model: None,
                target_intent: None,
                sync_intent: None,
                control_intent: Some(BotRuntimeControlIntent {
                    field: "permissionMode".to_string(),
                    value: ":danger-full-access".to_string(),
                    model_entries: vec![],
                }),
                config: json!({}),
            },
        )
        .await
        .unwrap();

    assert_eq!(response.binding["config"]["agentEngine"], "codex");
    assert_eq!(
        response.binding["config"]["permissionMode"],
        ":danger-full-access"
    );
}

#[tokio::test]
async fn bot_service_owns_runtime_target_option_normalization() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let options = service.runtime_target_options(BotRuntimeTargetOptionsRequest {
        bot: json!({
            "key": "writer",
            "runtimeKind": "desktop-local",
            "targetIntent": {
                "agentEngine": "codex",
                "deviceId": "mac-local",
                "deviceName": "Studio Mac.local Mia Desktop · 本机"
            }
        }),
        runtime: json!({
            "cloud": {
                "enabled": true,
                "agentRuntime": {
                    "runtimeKind": "cloud-claude-code",
                    "agentEngine": "claude-code",
                    "available": true
                },
                "devices": [{
                    "id": "remote-mac",
                    "deviceName": "Remote Mac",
                    "status": "online",
                    "capabilities": { "engines": ["codex"] }
                }]
            },
            "localDevice": { "id": "mac-local", "name": "Studio Mac.local Mia Desktop · 本机" },
            "agentEngines": {
                "hermes": { "available": true },
                "claudeCode": { "installed": true }
            },
            "agentInventory": {
                "agents": [
                    { "id": "openai-codex", "usableInMia": true }
                ]
            }
        }),
        engine_capabilities: json!({
            "engines": {
                "codex": { "available": true },
                "claude-code": { "available": true }
            }
        }),
        preferred_agent_engine: Some("hermes".to_string()),
    });

    assert_eq!(options.groups.len(), 2);
    assert_eq!(options.groups[0].id, "cloud-claude-code");
    assert_eq!(options.groups[0].options[0].agent_engine, "claude-code");
    assert!(!options.groups[0].options[0].disabled);
    assert_eq!(options.groups[1].label, "本机");
    assert_eq!(
        options.groups[1]
            .options
            .iter()
            .map(|option| option.agent_engine.as_str())
            .collect::<Vec<_>>(),
        vec!["hermes", "claude-code", "codex"]
    );
    assert!(options.groups[1].options[2].selected);
    assert_eq!(options.active_target.agent_engine, "codex");
    assert_eq!(options.active_target.device_id, "mac-local");
    assert_eq!(options.runtime_label, "本机运行");
    assert!(!options.runs_on_other_device);

    let remote = service.runtime_target_options(BotRuntimeTargetOptionsRequest {
        bot: json!({
            "key": "remote-writer",
            "runtimeKind": "desktop-local",
            "targetIntent": {
                "agentEngine": "codex",
                "deviceId": "remote-mac",
                "deviceName": "Remote Mac.local Mia Desktop"
            }
        }),
        runtime: json!({
            "localDevice": { "id": "mac-local", "name": "Studio Mac.local Mia Desktop · 本机" },
            "cloud": {
                "devices": [{
                    "id": "remote-mac",
                    "deviceName": "Remote Mac.local Mia Desktop",
                    "status": "online"
                }]
            },
            "agentEngines": {
                "codex": { "available": true }
            }
        }),
        engine_capabilities: json!({ "engines": {} }),
        preferred_agent_engine: Some("hermes".to_string()),
    });
    assert_eq!(remote.runtime_label, "Remote Mac · 在线");
    assert!(remote.runs_on_other_device);

    let fallback = service.runtime_target_options(BotRuntimeTargetOptionsRequest {
        bot: json!({}),
        runtime: json!({
            "cloud": {
                "enabled": true,
                "agentRuntime": {
                    "runtimeKind": "",
                    "agentEngine": "",
                    "available": false
                }
            }
        }),
        engine_capabilities: json!({}),
        preferred_agent_engine: Some("codex".to_string()),
    });
    assert!(fallback.groups[0].options[0].disabled);
    assert_eq!(fallback.runtime_label, "运行设备未配置");
    assert!(!fallback.runs_on_other_device);
    assert_eq!(
        fallback.groups[0].options[0].disabled_reason.as_deref(),
        Some("Mia Cloud 运行内核未同步")
    );
    assert_eq!(fallback.groups[1].options[0].agent_engine, "codex");
    assert_eq!(fallback.groups[1].options[0].device_id, "current-device");
}

#[tokio::test]
async fn bot_service_owns_capability_options_and_toggle_intents() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let response = service.capability_options(BotCapabilityOptionsRequest {
        bot: json!({
            "key": "paper-buddy",
            "name": "论文搭子",
            "agentEngine": "codex",
            "capabilities": { "inheritEngineDefaults": true, "enabledSkills": [], "disabledSkills": [] }
        }),
        available_skills: vec![
            BotCapabilitySkillInput {
                id: "mia-scheduler".into(),
                name: "mia-scheduler".into(),
                title: "定时任务".into(),
                source: "mia-official".into(),
                engine: "mia".into(),
                ..Default::default()
            },
            BotCapabilitySkillInput {
                id: "mia-official:officecli".into(),
                name: "officecli".into(),
                title: "Office 文件".into(),
                source: "mia-official".into(),
                engine: "mia".into(),
                ..Default::default()
            },
            BotCapabilitySkillInput {
                id: "mia-official:paper-research".into(),
                name: "paper-research".into(),
                title: "Paper Research".into(),
                source: "mia-official".into(),
                engine: "codex".into(),
                ..Default::default()
            },
            BotCapabilitySkillInput {
                id: "mia-official:meeting-notes".into(),
                name: "meeting-notes".into(),
                title: "Meeting Notes".into(),
                source: "mia-official".into(),
                engine: "hermes".into(),
                ..Default::default()
            },
            BotCapabilitySkillInput {
                id: "mia-official:xlsx".into(),
                name: "xlsx".into(),
                title: "Spreadsheet".into(),
                source: "mia-official".into(),
                ..Default::default()
            },
        ],
        bot_presets: vec![BotCapabilityPresetInput {
            key: "paper-buddy".into(),
            name: "论文搭子".into(),
            capabilities: json!({ "enabledSkills": ["mia-official:paper-research"] }),
        }],
        intent: None,
    });

    assert_eq!(response.capabilities["inheritEngineDefaults"], true);
    assert_eq!(
        response.capabilities["enabledSkills"],
        json!(["mia-official:paper-research"])
    );
    assert_eq!(response.summary, "3 个默认技能");
    assert_eq!(response.groups[0].id, "enabled-skills");
    assert_eq!(
        response.groups[0].options[2].capability_id,
        "mia-official:paper-research"
    );
    assert!(response.groups[0].options[2].checked);
    assert_eq!(response.groups[0].options[0].origin, "system-default");
    assert_eq!(response.groups[0].options[1].origin, "system-default");
    assert_eq!(response.groups[0].options[2].origin, "assistant-preset");
    assert!(response.groups[0].options[0].inherited);
    assert_eq!(
        response.groups[1]
            .options
            .iter()
            .map(|option| option.capability_id.as_str())
            .collect::<Vec<_>>(),
        vec!["mia-official:xlsx"]
    );

    let toggled = service.capability_options(BotCapabilityOptionsRequest {
        bot: json!({
            "key": "paper-buddy",
            "name": "论文搭子",
            "agentEngine": "codex",
            "capabilities": response.capabilities
        }),
        available_skills: vec![],
        bot_presets: vec![],
        intent: Some(BotCapabilityIntent {
            capability_type: "skill".into(),
            capability_id: "mia-official:paper-research".into(),
            checked: false,
        }),
    });

    assert_eq!(toggled.capabilities["inheritEngineDefaults"], true);
    assert_eq!(toggled.capabilities["enabledSkills"], json!([]));
    assert_eq!(
        toggled.capabilities["disabledSkills"],
        json!(["mia-official:paper-research"])
    );
    assert_eq!(toggled.summary, "2 个默认技能");

    let office_disabled = service.capability_options(BotCapabilityOptionsRequest {
        bot: json!({
            "key": "paper-buddy",
            "name": "论文搭子",
            "agentEngine": "codex",
            "capabilities": toggled.capabilities
        }),
        available_skills: vec![],
        bot_presets: vec![],
        intent: Some(BotCapabilityIntent {
            capability_type: "skill".into(),
            capability_id: "mia-official:officecli".into(),
            checked: false,
        }),
    });
    assert_eq!(office_disabled.capabilities["inheritEngineDefaults"], true);
    assert_eq!(
        office_disabled.capabilities["disabledSkills"],
        json!(["mia-official:paper-research", "mia-official:officecli"])
    );
    assert_eq!(office_disabled.summary, "1 个默认技能");
}

#[tokio::test]
async fn bot_service_owns_session_conversation_idempotency() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());
    let created = service
        .create_bot(CreateBotRequest {
            display_name: "Runner".to_string(),
            identity: json!({}),
            capabilities: json!({}),
        })
        .await
        .unwrap();
    let request = EnsureBotSessionConversationRequest {
        session_id: "sess_123".to_string(),
        title: Some("Runner Session".to_string()),
        runtime_kind: Some("agent".to_string()),
        metadata: json!({
            "source": "first",
            "runtimeSession": { "sessionKey": "native_session_1" }
        }),
    };

    let first = service
        .ensure_session_conversation_with_memory_mode(&created.bot.id, request, MemoryMode::Native)
        .await
        .unwrap();

    service
        .update_bot(
            &created.bot.id,
            UpdateBotRequest {
                display_name: Some("Renamed Runner".into()),
                identity: Some(json!({ "persona": "updated" })),
                capabilities: None,
            },
        )
        .await
        .unwrap();
    service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "desktop-local".into(),
                provider_connection_id: None,
                model_profile_id: None,
                model: None,
                target_intent: None,
                sync_intent: None,
                control_intent: None,
                config: json!({ "agentEngine": "codex" }),
            },
        )
        .await
        .unwrap();

    let second = service
        .ensure_session_conversation_with_memory_mode(
            &created.bot.id,
            EnsureBotSessionConversationRequest {
                session_id: "sess_123".into(),
                title: Some("Changed Title".into()),
                runtime_kind: Some("desktop-local".into()),
                metadata: json!({ "source": "second", "memoryMode": "mia" }),
            },
            MemoryMode::Mia,
        )
        .await
        .unwrap();

    assert!(first.created);
    assert!(!second.created);
    assert_eq!(first.conversation_id, second.conversation_id);

    let metadata: String =
        sqlx::query_scalar("SELECT metadata_json FROM conversations WHERE id = ?")
            .bind(&first.conversation_id)
            .fetch_one(db.pool())
            .await
            .unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(metadata["memoryMode"], "native");
    assert_eq!(metadata["source"], "first");
    assert_eq!(metadata["runtimeSession"]["sessionKey"], "native_session_1");

    let fresh = service
        .ensure_session_conversation_with_memory_mode(
            &created.bot.id,
            EnsureBotSessionConversationRequest {
                session_id: "sess_456".into(),
                title: None,
                runtime_kind: Some("desktop-local".into()),
                metadata: json!({}),
            },
            MemoryMode::Mia,
        )
        .await
        .unwrap();
    let fresh_metadata: String =
        sqlx::query_scalar("SELECT metadata_json FROM conversations WHERE id = ?")
            .bind(fresh.conversation_id)
            .fetch_one(db.pool())
            .await
            .unwrap();
    let fresh_metadata: serde_json::Value = serde_json::from_str(&fresh_metadata).unwrap();
    assert_eq!(fresh_metadata["memoryMode"], "mia");
}

#[tokio::test]
async fn bot_service_owns_starter_bot_materialization_and_marker() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());

    let response = service
        .ensure_starter_bots(StarterBotEnsureRequest {
            runtime: json!({
                "cloud": {
                    "enabled": true,
                    "agentRuntime": {
                        "runtimeKind": "cloud-claude-code",
                        "agentEngine": "claude-code",
                        "label": "Claude Code",
                        "available": true
                    }
                },
                "localDevice": { "id": "mac-1", "name": "Jung Mac.local Mia Desktop" },
                "agentInventory": {
                    "agents": [
                        { "id": "hermes", "label": "Hermes", "usableInMia": true },
                        { "id": "codex", "label": "Codex", "usableInMia": false }
                    ]
                }
            }),
            user_id: Some("u_123".to_string()),
            now: Some("2026-06-26T08:00:00.000Z".to_string()),
        })
        .await
        .unwrap();

    assert!(!response.skipped);
    assert_eq!(
        response
            .created
            .iter()
            .map(|entry| entry.engine_id.as_str())
            .collect::<Vec<_>>(),
        vec!["cloud-claude-code", "hermes"]
    );
    assert_eq!(response.created[0].key, "starter_u_123_mia");
    assert_eq!(
        response.created[0].conversation_id,
        "botc_starter_u_123_mia"
    );
    assert_eq!(
        response.settings["starterEngineBots"],
        json!({
            "seededAt": "2026-06-26T08:00:00.000Z",
            "engineIds": ["cloud-claude-code", "hermes"]
        })
    );
    let cloud_tag_id = response.settings["tags"]["items"][0]["id"]
        .as_str()
        .unwrap();
    assert_eq!(response.settings["tags"]["items"][0]["name"], "云端");
    assert_eq!(
        response.settings["tags"]["assignments"]["botc_starter_u_123_mia"],
        json!([cloud_tag_id])
    );

    let bots = service.list_bots().await.unwrap().bots;
    assert_eq!(bots.len(), 2);
    let mia = bots
        .iter()
        .find(|bot| bot.id == "starter_u_123_mia")
        .unwrap();
    assert_eq!(mia.display_name, "Mia");
    assert_eq!(mia.identity["avatarImage"], "./assets/mia-logo.png");
    assert_eq!(mia.identity["statusBadge"]["assetId"], "rainbow-fire");
    assert_eq!(mia.capabilities["inheritEngineDefaults"], true);
    assert_eq!(
        mia.capabilities["enabledSkills"],
        json!([
            "mia-official:officecli-docx",
            "mia-official:officecli-xlsx",
            "mia-official:officecli-pptx"
        ])
    );
    let hermes = bots
        .iter()
        .find(|bot| bot.id == "starter_u_123_hermes")
        .unwrap();
    assert_eq!(
        hermes.identity["avatarImage"],
        "./assets/engine-icons/hermesagent.svg"
    );
    assert_eq!(hermes.identity["statusBadge"]["assetId"], "blue-fire");
    assert_eq!(
        hermes.capabilities["enabledSkills"],
        json!([
            "mia-official:officecli-docx",
            "mia-official:officecli-xlsx",
            "mia-official:officecli-pptx"
        ])
    );

    let cloud_runtime = service
        .get_runtime("starter_u_123_mia", "cloud-claude-code")
        .await
        .unwrap();
    assert_eq!(
        cloud_runtime.binding["config"]["agentEngine"],
        "claude-code"
    );
    assert_eq!(
        cloud_runtime.binding["config"]["permissionMode"],
        "bypassPermissions"
    );
    let desktop_runtime = service
        .get_runtime("starter_u_123_hermes", "desktop-local")
        .await
        .unwrap();
    assert_eq!(desktop_runtime.binding["config"]["agentEngine"], "hermes");
    assert_eq!(desktop_runtime.binding["config"]["deviceId"], "mac-1");
    assert_eq!(desktop_runtime.binding["config"]["deviceName"], "Jung Mac");
    assert_eq!(desktop_runtime.binding["agentEngine"], "hermes");
    assert_eq!(desktop_runtime.binding["targetDeviceId"], "mac-1");
    assert_eq!(desktop_runtime.binding["targetDeviceName"], "Jung Mac");

    let again = service
        .ensure_starter_bots(StarterBotEnsureRequest {
            runtime: json!({ "cloud": { "enabled": true } }),
            user_id: Some("u_123".to_string()),
            now: Some("2026-06-27T08:00:00.000Z".to_string()),
        })
        .await
        .unwrap();
    assert!(again.skipped);
    assert!(again.created.is_empty());
    assert_eq!(service.list_bots().await.unwrap().bots.len(), 2);
}

#[tokio::test]
async fn starter_conversation_memory_mode_survives_repairs_and_upgrades_legacy_metadata() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());
    let runtime = json!({
        "cloud": {
            "enabled": true,
            "agentRuntime": {
                "runtimeKind": "cloud-claude-code",
                "agentEngine": "claude-code",
                "available": true
            }
        }
    });
    let request = |runtime| StarterBotEnsureRequest {
        runtime,
        user_id: Some("u_mode".into()),
        now: Some("2026-07-14T00:00:00Z".into()),
    };

    service
        .ensure_starter_bots_with_memory_mode(request(runtime.clone()), MemoryMode::Native)
        .await
        .unwrap();
    let conversation_id = "botc_starter_u_mode_mia";
    let first_metadata: String =
        sqlx::query_scalar("SELECT metadata_json FROM conversations WHERE id = ?")
            .bind(conversation_id)
            .fetch_one(db.pool())
            .await
            .unwrap();
    let mut first_metadata: serde_json::Value = serde_json::from_str(&first_metadata).unwrap();
    assert_eq!(first_metadata["memoryMode"], "native");
    first_metadata["runtimeSession"] = json!({ "sessionKey": "starter_session_1" });
    sqlx::query("UPDATE conversations SET metadata_json = ? WHERE id = ?")
        .bind(first_metadata.to_string())
        .bind(conversation_id)
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE bots SET identity_json = '{}' WHERE id = 'starter_u_mode_mia'")
        .execute(db.pool())
        .await
        .unwrap();

    service
        .ensure_starter_bots_with_memory_mode(request(runtime.clone()), MemoryMode::Mia)
        .await
        .unwrap();
    let repaired_metadata: String =
        sqlx::query_scalar("SELECT metadata_json FROM conversations WHERE id = ?")
            .bind(conversation_id)
            .fetch_one(db.pool())
            .await
            .unwrap();
    let repaired_metadata: serde_json::Value = serde_json::from_str(&repaired_metadata).unwrap();
    assert_eq!(repaired_metadata["memoryMode"], "native");
    assert_eq!(repaired_metadata["sessionId"], "starter_u_mode_mia");
    assert_eq!(repaired_metadata["starterEngineId"], "cloud-claude-code");
    assert_eq!(
        repaired_metadata["runtimeSession"]["sessionKey"],
        "starter_session_1"
    );

    sqlx::query("UPDATE conversations SET metadata_json = ? WHERE id = ?")
        .bind(
            json!({
                "sessionId": "starter_u_mode_mia",
                "starterEngineId": "cloud-claude-code",
                "runtimeSession": { "sessionKey": "legacy_session" }
            })
            .to_string(),
        )
        .bind(conversation_id)
        .execute(db.pool())
        .await
        .unwrap();
    service
        .ensure_starter_bots_with_memory_mode(request(runtime), MemoryMode::Native)
        .await
        .unwrap();
    let upgraded_metadata: String =
        sqlx::query_scalar("SELECT metadata_json FROM conversations WHERE id = ?")
            .bind(conversation_id)
            .fetch_one(db.pool())
            .await
            .unwrap();
    let upgraded_metadata: serde_json::Value = serde_json::from_str(&upgraded_metadata).unwrap();
    assert_eq!(upgraded_metadata["memoryMode"], "native");
    assert_eq!(
        upgraded_metadata["runtimeSession"]["sessionKey"],
        "legacy_session"
    );
}

#[tokio::test]
async fn bot_service_repairs_existing_starter_identity_and_runtime_binding() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());
    let request_runtime = json!({
        "cloud": {
            "enabled": true,
            "agentRuntime": {
                "runtimeKind": "cloud-claude-code",
                "agentEngine": "claude-code",
                "label": "Claude Code",
                "available": true
            }
        },
        "localDevice": { "id": "mac-1", "name": "Jung Mac.local Mia Desktop" },
        "agentInventory": {
            "agents": [
                { "id": "claude-code", "label": "Claude Code", "usableInMia": true }
            ]
        }
    });

    service
        .ensure_starter_bots(StarterBotEnsureRequest {
            runtime: request_runtime.clone(),
            user_id: Some("u_123".to_string()),
            now: Some("2026-06-26T08:00:00.000Z".to_string()),
        })
        .await
        .unwrap();

    sqlx::query("UPDATE bots SET identity_json = '{}' WHERE id = ?")
        .bind("starter_u_123_claude_code")
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE bot_runtime_bindings SET binding_json = ? WHERE bot_id = ? AND runtime_kind = ?",
    )
    .bind(
        json!({
            "runtimeKind": "desktop-local",
            "agentEngine": "hermes",
            "config": { "agentEngine": "hermes", "deviceId": "mac-1", "deviceName": "Jung Mac" }
        })
        .to_string(),
    )
    .bind("starter_u_123_claude_code")
    .bind("desktop-local")
    .execute(db.pool())
    .await
    .unwrap();

    let repaired = service
        .ensure_starter_bots(StarterBotEnsureRequest {
            runtime: request_runtime,
            user_id: Some("u_123".to_string()),
            now: Some("2026-06-27T08:00:00.000Z".to_string()),
        })
        .await
        .unwrap();

    assert!(!repaired.skipped);
    assert!(repaired.created.is_empty());
    assert_eq!(repaired.updated.len(), 1);
    assert_eq!(repaired.updated[0].engine_id, "claude-code");

    let bot = service
        .get_bot("starter_u_123_claude_code")
        .await
        .unwrap()
        .bot;
    assert_eq!(bot.identity["agentEngine"], "claude-code");
    assert_eq!(bot.identity["runtimeKind"], "desktop-local");

    let runtime = service
        .get_runtime("starter_u_123_claude_code", "desktop-local")
        .await
        .unwrap();
    assert_eq!(runtime.binding["agentEngine"], "claude-code");
    assert_eq!(runtime.binding["config"]["agentEngine"], "claude-code");
    assert_eq!(runtime.binding["targetDeviceId"], "mac-1");
}

#[tokio::test]
async fn bot_service_repairs_only_missing_starter_office_defaults() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());
    let runtime = json!({
        "cloud": {
            "enabled": true,
            "agentRuntime": {
                "runtimeKind": "cloud-claude-code",
                "agentEngine": "claude-code",
                "label": "Claude Code",
                "available": true
            }
        }
    });
    service
        .ensure_starter_bots(StarterBotEnsureRequest {
            runtime: runtime.clone(),
            user_id: Some("u_123".to_string()),
            now: Some("2026-06-26T08:00:00.000Z".to_string()),
        })
        .await
        .unwrap();
    sqlx::query("UPDATE bots SET capability_json = ? WHERE id = ?")
        .bind(json!({ "inheritEngineDefaults": true }).to_string())
        .bind("starter_u_123_mia")
        .execute(db.pool())
        .await
        .unwrap();

    let repaired = service
        .ensure_starter_bots(StarterBotEnsureRequest {
            runtime,
            user_id: Some("u_123".to_string()),
            now: Some("2026-06-27T08:00:00.000Z".to_string()),
        })
        .await
        .unwrap();

    assert!(!repaired.skipped);
    assert_eq!(repaired.updated.len(), 1);
    assert_eq!(
        repaired.updated[0].bot.capabilities["enabledSkills"],
        json!([
            "mia-official:officecli-docx",
            "mia-official:officecli-xlsx",
            "mia-official:officecli-pptx"
        ])
    );
}

#[tokio::test]
async fn bot_service_deletes_bot_identity_and_runtime_binding() {
    let db = init_database_memory().await.unwrap();
    let service = BotService::new(db.pool().clone());
    let created = service
        .create_bot(CreateBotRequest {
            display_name: "Disposable".to_string(),
            identity: json!({}),
            capabilities: json!({}),
        })
        .await
        .unwrap();
    service
        .save_runtime(
            &created.bot.id,
            SaveBotRuntimeRequest {
                runtime_kind: "agent".to_string(),
                provider_connection_id: None,
                model_profile_id: None,
                model: None,
                target_intent: None,
                sync_intent: None,
                control_intent: None,
                config: json!({}),
            },
        )
        .await
        .unwrap();

    let deleted = service.delete_bot(&created.bot.id).await.unwrap();
    let list = service.list_bots().await.unwrap();

    assert!(deleted.ok);
    assert!(list.bots.is_empty());
}
