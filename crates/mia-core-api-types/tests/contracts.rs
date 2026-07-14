use mia_core_api_types::*;
use serde_json::json;

#[test]
fn bounded_memory_contract_serializes_modes_and_tool_operations() {
    assert_eq!(serde_json::to_value(MemoryMode::Mia).unwrap(), json!("mia"));
    assert_eq!(
        serde_json::from_value::<MemoryMode>(json!("native")).unwrap(),
        MemoryMode::Native
    );

    let request: MiaMemoryToolRequest = serde_json::from_value(json!({
        "context": { "conversationId": "conv_1" },
        "action": "replace",
        "target": "memory",
        "oldText": "旧约定",
        "content": "新约定"
    }))
    .unwrap();
    assert_eq!(request.action, MiaMemoryAction::Replace);
    assert_eq!(request.target, MiaMemoryTarget::Memory);
    assert_eq!(request.old_text.as_deref(), Some("旧约定"));
    assert_eq!(request.content.as_deref(), Some("新约定"));
}

#[test]
fn memory_settings_contract_preserves_the_legacy_enabled_mirror() {
    let legacy: SaveMemorySettingsRequest =
        serde_json::from_value(json!({ "enabled": false })).unwrap();
    assert_eq!(legacy.mode, None);
    assert_eq!(legacy.enabled, Some(false));

    let serialized = serde_json::to_value(MemorySettingsResponse {
        mode: MemoryMode::Native,
        enabled: false,
    })
    .unwrap();
    assert_eq!(serialized["mode"], "native");
    assert_eq!(serialized["enabled"], false);
}

#[test]
fn bounded_memory_result_and_document_use_the_shared_transport_shape() {
    let response = MiaMemoryToolResponse {
        success: true,
        action: MiaMemoryAction::Add,
        target: MiaMemoryTarget::User,
        current_entries: vec!["用户喜欢简洁中文".into()],
        used_chars: 8,
        limit_chars: 1_375,
        usage_percent: 8.0 / 1_375.0 * 100.0,
        no_op: false,
        error: None,
        suggestion: None,
    };
    let serialized = serde_json::to_value(response).unwrap();
    assert_eq!(serialized["currentEntries"][0], "用户喜欢简洁中文");
    assert_eq!(serialized["usedChars"], 8);
    assert_eq!(serialized["limitChars"], 1_375);

    let document = MiaMemoryDocument {
        user_id: "user_1".into(),
        bot_id: "".into(),
        target: MiaMemoryTarget::User,
        text: "用户喜欢简洁中文".into(),
        revision: 3,
        updated_at: "2026-07-14T00:00:00Z".into(),
        deleted_at: "".into(),
    };
    let serialized = serde_json::to_value(document).unwrap();
    assert_eq!(serialized["userId"], "user_1");
    assert_eq!(serialized["target"], "user");
    assert_eq!(serialized["revision"], 3);
    assert_eq!(serialized["deletedAt"], "");
}

#[test]
fn endpoint_dtos_cover_the_initial_core_contract() {
    let _ = SystemStatusResponse {
        ok: true,
        version: "0.1.0".into(),
    };
    let _ = ClientSettingsResponse {
        settings: json!({}),
    };
    let _ = PatchClientSettingsRequest { patch: json!({}) };
    let _ = SaveModelSelectionRequest {
        selection: json!({ "provider": "anthropic", "model": "claude-sonnet" }),
    };
    let _ = SaveModelSelectionResponse {
        settings: json!({ "provider": "anthropic", "model": "claude-sonnet" }),
    };
    let _ = ProviderListResponse { providers: vec![] };
    let _ = CreateProviderRequest {
        id: Some("openai-main".into()),
        kind: "openai".into(),
        display_name: "OpenAI".into(),
        base_url: Some("https://api.openai.com/v1".into()),
        api_key_env: Some("OPENAI_API_KEY".into()),
        api_key: Some("secret".into()),
        api_mode: Some("responses".into()),
        auth_type: Some("api_key".into()),
        models: vec!["gpt-5".into()],
        enabled: Some(true),
    };
    let _ = ProviderResponse {
        provider: ProviderSummary {
            id: "openai-main".into(),
            kind: "openai".into(),
            display_name: "OpenAI".into(),
            enabled: true,
            models: vec!["gpt-5".into()],
        },
    };
    let _ = ProviderTestRequest {
        provider_id: Some("provider_1".into()),
        candidate: json!({}),
    };
    let _ = ResolveModelRuntimeRequest {
        config: json!({ "providerConnectionId": "openai-main" }),
        context: json!({ "engine": "hermes" }),
    };
    let _ = ResolveModelRuntimeResponse {
        runtime: Some(json!({ "provider": "openai" })),
    };
    let _ = AgentWorkspaceResponse {
        path: "/Users/mia/project".into(),
        custom: "/Users/mia/project".into(),
        default: "/Users/mia/Library/Application Support/Mia/workspace".into(),
    };
    let _ = SaveAgentWorkspaceRequest {
        path: Some("/Users/mia/project".into()),
        workspace_path: None,
    };
    let utility_request = RunConversationUtilityTurnRequest {
        bot_id: Some("bot_1".into()),
        conversation_id: Some("conv_1".into()),
        purpose: "translate".into(),
        system_prompt: "system".into(),
        user_prompt: "hello".into(),
        selected_skill_ids: vec!["skill_a".into()],
    };
    let utility_response = RunConversationUtilityTurnResponse {
        content: "你好".into(),
        turn_id: "turn_1".into(),
        engine: "mock-agent".into(),
    };
    let serialized_utility_request = serde_json::to_value(utility_request).unwrap();
    assert_eq!(serialized_utility_request["botId"], "bot_1");
    assert_eq!(serialized_utility_request["userPrompt"], "hello");
    let serialized_utility_response = serde_json::to_value(utility_response).unwrap();
    assert_eq!(serialized_utility_response["turnId"], "turn_1");
    let _ = MemorySettingsResponse {
        mode: MemoryMode::Mia,
        enabled: true,
    };
    let _ = SaveMemorySettingsRequest {
        mode: None,
        enabled: Some(false),
    };
    let _ = MiaContextSnapshotResponse {
        user_id: "local".into(),
        bot_id: "mia".into(),
        session_id: "default".into(),
        origin_message_id: "msg_1".into(),
        generated_at: 1,
        persona: "# Mia".into(),
        memory_mode: MemoryMode::Mia,
        memory_tools: MiaMemoryToolNames {
            enabled: true,
            memory: "memory".into(),
        },
        skill_tools: MiaSkillToolNames {
            list_current: "skill_list_current".into(),
            read_current: "skill_read_current".into(),
        },
    };
    let skill_summary = MiaCurrentSkillSummary {
        id: "mia-official:xlsx".into(),
        name: "xlsx".into(),
        description: "Spreadsheet work".into(),
        body_chars: 42,
    };
    let skill_detail = MiaCurrentSkillDetail {
        id: skill_summary.id.clone(),
        name: skill_summary.name.clone(),
        description: skill_summary.description.clone(),
        body_chars: skill_summary.body_chars,
        body: "# XLSX".into(),
    };
    let current_skills = MiaCurrentSkillsResponse {
        bot_id: "mia".into(),
        skills: vec![skill_summary],
    };
    let current_skill = MiaCurrentSkillResponse {
        bot_id: "mia".into(),
        skill: skill_detail,
    };
    let serialized_current_skills = serde_json::to_value(current_skills).unwrap();
    assert_eq!(serialized_current_skills["botId"], "mia");
    assert_eq!(serialized_current_skills["skills"][0]["bodyChars"], 42);
    let serialized_current_skill = serde_json::to_value(current_skill).unwrap();
    assert_eq!(serialized_current_skill["skill"]["body"], "# XLSX");
    let memory_entry = MiaMemoryEntry {
        id: "mem_1".into(),
        user_id: "local".into(),
        bot_id: "mia".into(),
        session_id: "default".into(),
        scope: "bot".into(),
        text: "likes rust".into(),
        confidence: 1.0,
        source: "agent_tool".into(),
        origin_engine: "codex".into(),
        origin_native_session_id: "".into(),
        source_message_ids: vec!["msg_1".into()],
        linked_memory_ids: vec![],
        policy_result: json!({}),
        priority: 0,
        pinned: false,
        created_at: "2026-07-08T00:00:00Z".into(),
        updated_at: "2026-07-08T00:00:00Z".into(),
        last_used_at: "".into(),
        expires_at: "".into(),
        metadata: json!({}),
        deleted_at: "".into(),
        revision: 1,
    };
    let _ = MiaMemorySearchRequest {
        context: json!({ "botId": "mia" }),
        query: Some("rust".into()),
        q: None,
        scopes: vec!["bot".into()],
        limit: Some(10),
        include_deleted: None,
    };
    let _ = MiaMemorySearchResponse {
        memories: vec![memory_entry.clone()],
        disabled: None,
        reason: None,
    };
    let _ = MiaMemoryMutationRequest {
        context: json!({ "botId": "mia" }),
        memory_id: Some("mem_1".into()),
        text: Some("likes Rust Core".into()),
        ..Default::default()
    };
    let _ = MiaMemoryMutationResponse {
        status: "ok".into(),
        disabled: None,
        reason: None,
        error: None,
        effective_scope: Some("bot".into()),
        policy_reason: Some("safe scoped memory".into()),
        memory_id: Some("mem_1".into()),
        memory: Some(memory_entry),
        matches: vec![],
    };
    let _ = SaveAttachmentRequest {
        name: Some("pixel.png".into()),
        data_url: "data:image/png;base64,cG5n".into(),
        url: Some("/api/files/file_1".into()),
        mime: Some("image/png".into()),
        thumbnail_data_url: None,
        thumbnail: None,
        preview_data_url: None,
    };
    let _ = FetchFileAttachmentRequest {
        path: Some("/tmp/report.xlsx".into()),
        file_path: None,
        id: None,
    };
    let _ = AttachmentResponse {
        id: "att_1".into(),
        name: "report.xlsx".into(),
        path: "/tmp/report.xlsx".into(),
        url: None,
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into(),
        size: 10,
        kind: "file".into(),
        thumbnail_data_url: None,
        data_url: Some("data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,eGxzeA==".into()),
    };
    let _ = BotListResponse { bots: vec![] };
    let _ = CreateBotRequest {
        display_name: "Mia".into(),
        identity: json!({}),
        capabilities: json!({}),
    };
    let _ = SaveBotRuntimeRequest {
        runtime_kind: "desktop-local".into(),
        provider_connection_id: Some("provider_1".into()),
        model_profile_id: Some("profile_1".into()),
        model: Some("mia-auto".into()),
        target_intent: Some(BotRuntimeTargetIntent {
            device_id: Some("device_mac".into()),
            device_name: Some("Mac".into()),
            agent_engine: Some("codex".into()),
        }),
        sync_intent: None,
        control_intent: Some(BotRuntimeControlIntent {
            field: "model".into(),
            value: "mia-auto".into(),
            model_entries: vec![BotRuntimeModelEntryIntent {
                id: Some("mia-auto".into()),
                value: None,
                label: Some("Auto".into()),
                model: Some("mia-auto".into()),
                provider: Some("mia".into()),
                provider_label: Some("Mia".into()),
                auth_type: Some("mia_account".into()),
                model_profile_id: Some("mia:mia-auto".into()),
                profile_id: None,
            }],
        }),
        config: json!({}),
    };
    let _ = BotRuntimeTargetOptionsRequest {
        bot: json!({ "id": "bot_1" }),
        runtime: json!({ "localDevice": { "id": "device_mac" } }),
        engine_capabilities: json!({}),
        preferred_agent_engine: Some("hermes".into()),
    };
    let _ = BotRuntimeTargetOptionsResponse {
        active_target: BotRuntimeTargetOption {
            id: "desktop-local:device_mac:hermes".into(),
            runtime_kind: "desktop-local".into(),
            device_id: "device_mac".into(),
            device_name: "本机".into(),
            agent_engine: "hermes".into(),
            label: "Hermes".into(),
            engine_label: "Hermes".into(),
            title: "本机 · Hermes".into(),
            icon_kind: "hermes".into(),
            selected: true,
            disabled: false,
            disabled_reason: None,
        },
        runtime_label: "本机运行".into(),
        runs_on_other_device: false,
        groups: vec![BotRuntimeTargetGroup {
            id: "device_mac".into(),
            label: "本机".into(),
            status_label: "本机".into(),
            runtime_kind: "desktop-local".into(),
            options: vec![],
        }],
    };
    let _ = EnsureBotSessionConversationRequest {
        session_id: "session_1".into(),
        title: Some("Chat".into()),
        runtime_kind: Some("desktop-local".into()),
        metadata: json!({}),
    };
    let _ = ConversationListResponse {
        conversations: vec![],
    };
    let _ = CreateConversationRequest {
        kind: "bot".into(),
        title: "Chat".into(),
        bot_id: Some("bot_1".into()),
        metadata: json!({}),
    };
    let _ = SendConversationMessageRequest {
        body: "hello".into(),
        attachments: json!([]),
        selected_skill_ids: vec![],
    };
    let _ = SendConversationMessageResponse {
        message_id: "message_1".into(),
        turn_id: "turn_1".into(),
        assistant_message_id: Some("message_2".into()),
        accepted: true,
    };
    let _ = TaskJobListResponse { jobs: vec![] };
    let _ = CreateTaskJobRequest {
        kind: "cron".into(),
        schedule: Some(json!({})),
        schedule_intent: Some(TaskScheduleIntent {
            kind: "daily".into(),
            date: None,
            time: Some("09:00".into()),
            weekday: None,
            day_of_month: None,
            timezone: Some("UTC".into()),
            time_expression: None,
        }),
        target: json!({}),
        instructions: "Run".into(),
    };
    let _ = RunTaskJobResponse {
        run_id: "run_1".into(),
        accepted: true,
        conversation_id: Some("conversation_1".into()),
        message_id: Some("message_1".into()),
        turn_id: Some("turn_1".into()),
        assistant_message_id: Some("message_2".into()),
    };
    let _ = McpServerListResponse { servers: vec![] };
    let _ = CreateMcpServerRequest {
        name: "filesystem".into(),
        description: Some("Files".into()),
        enabled: Some(false),
        transport: json!({"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]}),
        config: None,
    };
    let _ = CloudStatusResponse {
        enabled: false,
        connected: false,
        connecting: false,
        url: "https://mia.gifgif.cn".into(),
        user: None,
        account: None,
        agent_runtime: None,
        device_id: "".into(),
        last_error: "".into(),
        logs: vec![],
        events: json!({}),
        token: None,
    };
    let cloud_status = CloudStatusResponse {
        enabled: true,
        connected: true,
        connecting: false,
        url: "https://mia.example".into(),
        user: Some(json!({ "id": "u1" })),
        account: Some(json!({ "id": "u1" })),
        agent_runtime: None,
        device_id: "".into(),
        last_error: "".into(),
        logs: vec![],
        events: json!({}),
        token: None,
    };
    let _ = CloudConnectRequest {
        url: Some("https://mia.example".into()),
        token: Some("token".into()),
        account_hint: None,
        user: Some(json!({ "id": "u1" })),
        account: None,
        agent_runtime: None,
        last_event_seq: Some(1),
        last_memory_sync_at: None,
    };
    let _ = CloudConnectResponse {
        status: cloud_status,
    };
    let _ = CloudSettingsResponse {
        settings: json!({ "pins": [] }),
    };
    let _ = PutCloudSettingsRequest {
        settings: json!({ "pins": [] }),
    };
    let _ = CloudMemorySyncRequest {
        full: Some(true),
        limit: Some(1000),
    };
    let sync_response = CloudMemorySyncResponse {
        ok: true,
        skipped: false,
        pushed: 1,
        pulled: 2,
        conflicts: 0,
        errors: 0,
        server_time: "2026-07-08T00:00:00Z".into(),
    };
    let serialized_sync = serde_json::to_value(sync_response).unwrap();
    assert_eq!(serialized_sync["serverTime"], "2026-07-08T00:00:00Z");
    let bridge_start = CloudBridgeStartRequest {
        device_id: "device_1".into(),
        device_name: "Office Mac".into(),
        engine: "codex".into(),
        capabilities: json!({ "chat": true, "engines": ["codex"] }),
    };
    let serialized_bridge_start = serde_json::to_value(bridge_start).unwrap();
    assert_eq!(serialized_bridge_start["deviceId"], "device_1");
    let _ = CloudBridgeLifecycleResponse {
        status: CloudStatusResponse {
            enabled: true,
            connected: false,
            connecting: true,
            url: "https://mia.example".into(),
            user: None,
            account: None,
            agent_runtime: None,
            device_id: "device_1".into(),
            last_error: "".into(),
            logs: vec!["Connecting to Mia Cloud".into()],
            events: json!({}),
            token: None,
        },
    };
    let bridge_run = CloudBridgeRunRequest {
        run_id: "run_1".into(),
        conversation_id: "cloud_conv_1".into(),
        text: "hello from cloud".into(),
        attachments: json!([]),
        selected_skill_ids: vec!["mia:flashcards".into()],
        bot_id: "mia".into(),
        bot_name: "Mia".into(),
        display_name: "Mia".into(),
        agent_engine: Some("codex".into()),
        engine: None,
        runtime_kind: None,
        runtime_config: json!({ "agentEngine": "codex" }),
        config: json!({}),
        model: Some("mia-auto".into()),
        effort_level: Some("medium".into()),
        permission_mode: None,
    };
    let serialized_bridge_run = serde_json::to_value(bridge_run).unwrap();
    assert_eq!(serialized_bridge_run["runId"], "run_1");
    assert_eq!(
        serialized_bridge_run["runtimeConfig"]["agentEngine"],
        "codex"
    );
    assert_eq!(
        serialized_bridge_run["selectedSkillIds"][0],
        "mia:flashcards"
    );
    let _ = CloudBridgeRunResponse {
        ok: true,
        run_id: "run_1".into(),
        conversation_id: "cloud_bridge_cloud_conv_1".into(),
        cloud_conversation_id: "cloud_conv_1".into(),
        message_id: "msg_1".into(),
        turn_id: "turn_1".into(),
        assistant_message_id: Some("msg_2".into()),
        text: "done".into(),
        attachments: json!([]),
        trace: json!({}),
        content_blocks: json!([]),
    };
    let _ = CloudBridgeCancelRequest {
        run_id: "run_1".into(),
    };
    let _ = CloudBridgeCancelResponse {
        ok: true,
        cancelled: true,
        run_id: "run_1".into(),
    };
}

#[test]
fn agent_workspace_contract_keeps_core_owned_workspace_terms() {
    let request = SaveAgentWorkspaceRequest {
        path: Some("/Users/mia/project".into()),
        workspace_path: None,
    };
    let serialized_request = serde_json::to_value(request).unwrap();
    assert_eq!(serialized_request["path"], "/Users/mia/project");

    let response = AgentWorkspaceResponse {
        path: "/Users/mia/project".into(),
        custom: "/Users/mia/project".into(),
        default: "/Users/mia/Library/Application Support/Mia/workspace".into(),
    };
    let serialized_response = serde_json::to_value(response).unwrap();
    assert_eq!(serialized_response["path"], "/Users/mia/project");
    assert_eq!(serialized_response["custom"], "/Users/mia/project");
    assert_eq!(
        serialized_response["default"],
        "/Users/mia/Library/Application Support/Mia/workspace"
    );
}

#[test]
fn mia_context_contract_keeps_mcp_tool_names_stable() {
    let response = MiaContextSnapshotResponse {
        user_id: "local".into(),
        bot_id: "mia".into(),
        session_id: "default".into(),
        origin_message_id: "msg_1".into(),
        generated_at: 1,
        persona: "# Mia".into(),
        memory_mode: MemoryMode::Mia,
        memory_tools: MiaMemoryToolNames {
            enabled: true,
            memory: "memory".into(),
        },
        skill_tools: MiaSkillToolNames {
            list_current: "skill_list_current".into(),
            read_current: "skill_read_current".into(),
        },
    };
    let serialized = serde_json::to_value(response).unwrap();
    assert_eq!(serialized["botId"], "mia");
    assert_eq!(serialized["memoryMode"], "mia");
    assert!(serialized.get("memory").is_none());
    assert_eq!(serialized["memoryTools"]["enabled"], true);
    assert_eq!(serialized["memoryTools"]["memory"], "memory");
    assert_eq!(
        serialized["skillTools"]["listCurrent"],
        "skill_list_current"
    );
    assert_eq!(
        serialized["skillTools"]["readCurrent"],
        "skill_read_current"
    );
}

#[test]
fn runtime_binding_request_serializes_as_camel_case_contract() {
    let body = SaveBotRuntimeRequest {
        runtime_kind: "desktop-local".into(),
        provider_connection_id: Some("provider_1".into()),
        model_profile_id: Some("profile_1".into()),
        model: Some("mia-auto".into()),
        target_intent: Some(BotRuntimeTargetIntent {
            device_id: Some("device_mac".into()),
            device_name: Some("Mac".into()),
            agent_engine: Some("codex".into()),
        }),
        sync_intent: Some(BotRuntimeSyncIntent {
            agent_engine: Some("hermes".into()),
            device_id: Some("device_mac".into()),
            device_name: Some("Mac".into()),
            model: Some("mia-auto".into()),
            effort_level: Some("medium".into()),
            permission_mode: Some("ask".into()),
            model_entries: vec![BotRuntimeModelEntryIntent {
                id: Some("mia-auto".into()),
                value: None,
                label: Some("Auto".into()),
                model: Some("mia-auto".into()),
                provider: Some("mia".into()),
                provider_label: Some("Mia".into()),
                auth_type: Some("mia_account".into()),
                model_profile_id: Some("mia:mia-auto".into()),
                profile_id: None,
            }],
        }),
        control_intent: Some(BotRuntimeControlIntent {
            field: "model".into(),
            value: "mia-auto".into(),
            model_entries: vec![BotRuntimeModelEntryIntent {
                id: Some("mia-auto".into()),
                value: None,
                label: Some("Auto".into()),
                model: Some("mia-auto".into()),
                provider: Some("mia".into()),
                provider_label: Some("Mia".into()),
                auth_type: Some("mia_account".into()),
                model_profile_id: Some("mia:mia-auto".into()),
                profile_id: None,
            }],
        }),
        config: json!({ "effort": "medium" }),
    };

    let serialized = serde_json::to_value(body).unwrap();
    assert_eq!(serialized["runtimeKind"], "desktop-local");
    assert_eq!(serialized["providerConnectionId"], "provider_1");
    assert_eq!(serialized["modelProfileId"], "profile_1");
    assert_eq!(serialized["targetIntent"]["agentEngine"], "codex");
    assert_eq!(serialized["syncIntent"]["permissionMode"], "ask");
    assert_eq!(serialized["controlIntent"]["field"], "model");
    assert_eq!(
        serialized["controlIntent"]["modelEntries"][0]["modelProfileId"],
        "mia:mia-auto"
    );
}

#[test]
fn runtime_target_options_serialize_as_camel_case_contract() {
    let request = BotRuntimeTargetOptionsRequest {
        bot: json!({ "runtimeKind": "desktop-local" }),
        runtime: json!({ "localDevice": { "id": "device_mac" } }),
        engine_capabilities: json!({ "engines": {} }),
        preferred_agent_engine: Some("codex".into()),
    };
    let serialized_request = serde_json::to_value(request).unwrap();
    assert_eq!(serialized_request["preferredAgentEngine"], "codex");
    assert_eq!(
        serialized_request["engineCapabilities"]["engines"],
        json!({})
    );

    let response = BotRuntimeTargetOptionsResponse {
        active_target: BotRuntimeTargetOption {
            id: "desktop-local:device_mac:codex".into(),
            runtime_kind: "desktop-local".into(),
            device_id: "device_mac".into(),
            device_name: "本机".into(),
            agent_engine: "codex".into(),
            label: "Codex".into(),
            engine_label: "Codex".into(),
            title: "本机 · Codex".into(),
            icon_kind: "codex".into(),
            selected: true,
            disabled: false,
            disabled_reason: None,
        },
        runtime_label: "本机运行".into(),
        runs_on_other_device: false,
        groups: vec![BotRuntimeTargetGroup {
            id: "device_mac".into(),
            label: "本机".into(),
            status_label: "本机".into(),
            runtime_kind: "desktop-local".into(),
            options: vec![],
        }],
    };
    let serialized_response = serde_json::to_value(response).unwrap();
    assert_eq!(serialized_response["activeTarget"]["agentEngine"], "codex");
    assert_eq!(serialized_response["runtimeLabel"], "本机运行");
    assert_eq!(serialized_response["runsOnOtherDevice"], false);
    assert_eq!(serialized_response["groups"][0]["statusLabel"], "本机");
}

#[test]
fn runtime_control_options_serialize_as_camel_case_contract() {
    let request = BotRuntimeControlOptionsRequest {
        runtime_kind: Some("desktop-local".into()),
        bot: json!({ "key": "codex", "agentEngine": "codex" }),
        runtime: json!({ "permissions": { "engines": { "codex": ":danger-full-access" } } }),
        binding: json!({ "config": { "model": "gpt-5.3-codex" } }),
        model_catalog: json!([]),
        platform_models: json!([]),
        engine_capabilities: json!({
            "engines": {
                "codex": {
                    "models": [{ "slug": "gpt-5.3-codex", "displayName": "GPT-5.3 Codex" }],
                    "permissionProfiles": [{ "id": ":danger-full-access", "description": "Full Access" }]
                }
            }
        }),
        codex_models: json!([]),
    };
    let serialized_request = serde_json::to_value(request).unwrap();
    assert_eq!(serialized_request["runtimeKind"], "desktop-local");
    assert_eq!(
        serialized_request["engineCapabilities"]["engines"]["codex"]["models"][0]["slug"],
        "gpt-5.3-codex"
    );

    let response = BotRuntimeControlOptionsResponse {
        runtime_kind: "desktop-local".into(),
        agent_engine: "codex".into(),
        status_text: "Codex".into(),
        send_blocked: false,
        send_block_reason: "".into(),
        model_options: vec![BotRuntimeControlOption {
            id: "gpt-5.3-codex".into(),
            model: "gpt-5.3-codex".into(),
            provider: "codex".into(),
            label: "GPT-5.3 Codex".into(),
            ..Default::default()
        }],
        selected_model: "gpt-5.3-codex".into(),
        selected_model_entry: Some(BotRuntimeControlOption {
            id: "gpt-5.3-codex".into(),
            model: "gpt-5.3-codex".into(),
            provider: "codex".into(),
            label: "GPT-5.3 Codex".into(),
            ..Default::default()
        }),
        effort_options: vec![BotRuntimeControlOption {
            value: "xhigh".into(),
            label: "X High".into(),
            ..Default::default()
        }],
        selected_effort: "xhigh".into(),
        permission_options: vec![BotRuntimeControlOption {
            value: ":danger-full-access".into(),
            label: "Full Access".into(),
            ..Default::default()
        }],
        selected_permission: ":danger-full-access".into(),
    };
    let serialized_response = serde_json::to_value(response).unwrap();
    assert_eq!(serialized_response["agentEngine"], "codex");
    assert_eq!(serialized_response["sendBlocked"], false);
    assert!(serialized_response.get("permissionSaveTarget").is_none());
    assert_eq!(
        serialized_response["selectedModelEntry"]["id"],
        "gpt-5.3-codex"
    );
}

#[test]
fn acp_runtime_control_snapshot_serializes_only_observed_controls() {
    let snapshot = AcpRuntimeControlSnapshot {
        conversation_id: "conv_1".into(),
        engine: "claude-code".into(),
        session_id: Some("session_1".into()),
        state: "ready".into(),
        controls: vec![AcpRuntimeControl {
            id: "model".into(),
            category: "model".into(),
            current_value: "claude-sonnet-4-6".into(),
            source: "config_option".into(),
            options: vec![AcpRuntimeControlChoice {
                value: "claude-sonnet-4-6".into(),
                label: "Sonnet 4.6".into(),
                description: String::new(),
            }],
        }],
        error: String::new(),
    };

    let value = serde_json::to_value(snapshot).unwrap();

    assert_eq!(value["conversationId"], "conv_1");
    assert_eq!(value["sessionId"], "session_1");
    assert_eq!(value["controls"][0]["currentValue"], "claude-sonnet-4-6");
    assert_eq!(value["controls"][0]["source"], "config_option");
    assert_eq!(value["controls"][0]["options"][0]["label"], "Sonnet 4.6");
}

#[test]
fn bot_capability_options_serialize_as_camel_case_contract() {
    let request = BotCapabilityOptionsRequest {
        bot: json!({ "key": "writer", "agentEngine": "codex" }),
        available_skills: vec![BotCapabilitySkillInput {
            id: "mia-official:paper-research".into(),
            name: "paper-research".into(),
            title: "Paper Research".into(),
            source: "mia-official".into(),
            engine: "codex".into(),
            ..Default::default()
        }],
        bot_presets: vec![BotCapabilityPresetInput {
            key: "writer".into(),
            name: "Writer".into(),
            capabilities: json!({ "enabledSkills": ["mia-official:paper-research"] }),
        }],
        intent: Some(BotCapabilityIntent {
            capability_type: "skill".into(),
            capability_id: "mia-official:paper-research".into(),
            checked: false,
        }),
    };
    let serialized_request = serde_json::to_value(request).unwrap();
    assert_eq!(
        serialized_request["availableSkills"][0]["id"],
        "mia-official:paper-research"
    );
    assert_eq!(
        serialized_request["botPresets"][0]["capabilities"]["enabledSkills"][0],
        "mia-official:paper-research"
    );
    assert_eq!(serialized_request["intent"]["capabilityType"], "skill");

    let response = BotCapabilityOptionsResponse {
        capabilities: json!({ "inheritEngineDefaults": false, "enabledSkills": [] }),
        summary: "未设置默认技能".into(),
        groups: vec![BotCapabilityGroup {
            id: "addable-skills".into(),
            label: "添加技能".into(),
            kind: "skill".into(),
            options: vec![BotCapabilityOption {
                id: "mia-official:paper-research".into(),
                capability_id: "mia-official:paper-research".into(),
                label: "Paper Research".into(),
                source: "mia-official".into(),
                origin: "assistant-preset".into(),
                inherited: true,
                checked: false,
                missing: false,
            }],
        }],
    };
    let serialized_response = serde_json::to_value(response).unwrap();
    assert_eq!(
        serialized_response["capabilities"]["inheritEngineDefaults"],
        false
    );
    assert_eq!(
        serialized_response["groups"][0]["options"][0]["capabilityId"],
        "mia-official:paper-research"
    );
    assert_eq!(
        serialized_response["groups"][0]["options"][0]["origin"],
        "assistant-preset"
    );
    assert_eq!(
        serialized_response["groups"][0]["options"][0]["inherited"],
        true
    );
}

#[test]
fn starter_bot_ensure_serialize_as_camel_case_contract() {
    let request = StarterBotEnsureRequest {
        runtime: json!({ "cloud": { "enabled": true } }),
        user_id: Some("u_123".into()),
        now: Some("2026-06-26T08:00:00.000Z".into()),
    };
    let serialized_request = serde_json::to_value(request).unwrap();
    assert_eq!(serialized_request["userId"], "u_123");
    assert_eq!(serialized_request["runtime"]["cloud"]["enabled"], true);

    let response = StarterBotEnsureResponse {
        skipped: false,
        created: vec![StarterBotMutation {
            engine_id: "cloud-claude-code".into(),
            key: "starter_u_123_mia".into(),
            bot: BotSummary {
                id: "starter_u_123_mia".into(),
                display_name: "Mia".into(),
                identity: json!({ "name": "Mia" }),
                capabilities: json!({ "inheritEngineDefaults": true }),
            },
            conversation_id: "botc_starter_u_123_mia".into(),
        }],
        updated: vec![],
        settings: json!({ "starterEngineBots": { "engineIds": ["cloud-claude-code"] } }),
    };
    let serialized_response = serde_json::to_value(response).unwrap();
    assert_eq!(
        serialized_response["created"][0]["engineId"],
        "cloud-claude-code"
    );
    assert_eq!(
        serialized_response["created"][0]["conversationId"],
        "botc_starter_u_123_mia"
    );
    assert_eq!(
        serialized_response["created"][0]["bot"]["displayName"],
        "Mia"
    );
}

#[test]
fn skill_materialization_contract_uses_core_owned_turn_terms() {
    let request = SkillMaterializationRequest {
        available_skills: vec![SkillMaterializationRecord {
            id: "mia-official:xlsx".into(),
            name: "xlsx".into(),
            description: "Excel deliverables".into(),
            body: "# XLSX\nUse formulas.".into(),
        }],
        active_skill_ids: vec![],
        intent_skill_ids: vec!["xlsx".into()],
        requested_skill_ids: vec![],
        mode: Some("index".into()),
    };
    let serialized_request = serde_json::to_value(request).unwrap();
    assert_eq!(
        serialized_request["availableSkills"][0]["id"],
        "mia-official:xlsx"
    );
    assert_eq!(serialized_request["intentSkillIds"][0], "xlsx");

    let response = SkillMaterializationResponse {
        index_block: "## Available Mia Skills".into(),
        loaded_block: "## Loaded Mia Skill Guides".into(),
        loaded_skill_ids: vec!["mia-official:xlsx".into()],
    };
    let serialized_response = serde_json::to_value(response).unwrap();
    assert_eq!(serialized_response["indexBlock"], "## Available Mia Skills");
    assert_eq!(
        serialized_response["loadedSkillIds"][0],
        "mia-official:xlsx"
    );
}

#[test]
fn agent_session_skill_runtime_contract_uses_core_owned_runtime_terms() {
    let request = AgentSessionSkillRuntimeRequest {
        agent_engine: "codex".into(),
        runtime_config: json!({ "nativeSkillsDirs": [".codex/skills"] }),
        workspace_path: Some("/workspace".into()),
        session_skill_ids: vec!["deep-research".into()],
        available_skills: vec![AgentSessionSkillRecord {
            id: "deep-research".into(),
            name: "deep-research".into(),
            display_name: "Deep Research".into(),
            description: "Research guide".into(),
            summary: "Research guide".into(),
            body: "# Deep".into(),
            source_path: "/skills/deep-research".into(),
            link_name: "deep-research".into(),
        }],
        active_skill_ids: vec!["deep-research".into()],
        intent_skill_ids: vec![],
        requested_skill_ids: vec![],
    };
    let serialized_request = serde_json::to_value(request).unwrap();
    assert_eq!(serialized_request["agentEngine"], "codex");
    assert_eq!(serialized_request["workspacePath"], "/workspace");
    assert_eq!(serialized_request["sessionSkillIds"][0], "deep-research");
    assert_eq!(
        serialized_request["availableSkills"][0]["sourcePath"],
        "/skills/deep-research"
    );

    let response = AgentSessionSkillRuntimeResponse {
        delivery_mode: "native-link".into(),
        native_skills_dirs: vec![".codex/skills".into()],
        resolved_skill_ids: vec!["deep-research".into()],
        resolved_skills: vec![],
        turn_selected_skills: vec![],
        skill_external_dirs: vec![],
        skill_fingerprint: "abcdef1234567890".into(),
        selected_skill_prompt: "<selected_skill_paths/>".into(),
        initial_prompt_prefix: "".into(),
        skill_materialization: None,
        managed_skill_targets: vec![".codex/skills/deep-research".into()],
        manifest_path: "/workspace/.mia/skill-runtime.json".into(),
    };
    let serialized_response = serde_json::to_value(response).unwrap();
    assert_eq!(serialized_response["deliveryMode"], "native-link");
    assert_eq!(serialized_response["nativeSkillsDirs"][0], ".codex/skills");
    assert_eq!(
        serialized_response["selectedSkillPrompt"],
        "<selected_skill_paths/>"
    );
    assert_eq!(
        serialized_response["managedSkillTargets"][0],
        ".codex/skills/deep-research"
    );
    assert_eq!(
        serialized_response["manifestPath"],
        "/workspace/.mia/skill-runtime.json"
    );
}

#[test]
fn event_payloads_cover_initial_realtime_contract() {
    let _ = SystemStatusChangedEvent { status: json!({}) };
    let _ = BotUpdatedEvent {
        bot_id: "bot_1".into(),
    };
    let _ = ConversationCreatedEvent {
        conversation_id: "conversation_1".into(),
    };
    let _ = ConversationMessageCreatedEvent {
        conversation_id: "conversation_1".into(),
        message_id: "message_1".into(),
    };
    let _ = TaskCreatedEvent {
        task_id: "task_1".into(),
    };
    let _ = TaskUpdatedEvent {
        task_id: "task_1".into(),
    };
    let _ = TaskRunStartedEvent {
        task_id: "task_1".into(),
        run_id: "run_1".into(),
    };
    let _ = TaskRunFinishedEvent {
        task_id: "task_1".into(),
        run_id: "run_1".into(),
        ok: true,
    };
    let _ = McpServerUpdatedEvent {
        server_id: "mcp_1".into(),
    };
    let _ = CloudStatusChangedEvent { connected: true };
}
