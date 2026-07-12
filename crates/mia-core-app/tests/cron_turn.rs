use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use async_trait::async_trait;
use mia_core_app::cron_turn::{
    MAX_CRON_CONTINUATIONS, execute_runtime_with_cron, process_completed_cron_turn,
};
use mia_core_db::init_database_memory;
use mia_core_runtime::{
    EVENT_RUNTIME_STDOUT, NativeAcpBackend, NativeAcpSessionManager, RuntimeCancellation,
    RuntimeEventSink, RuntimeExecutionResult, RuntimeProtocol, RuntimeSendMessage,
    RuntimeSessionManager, RuntimeSessionState, RuntimeTurnPlan,
};
use mia_core_tasks::TaskService;
use serde_json::json;

#[tokio::test]
async fn cron_turn_hides_protocol_and_returns_small_continuation() {
    let database = init_database_memory().await.unwrap();
    let tasks = TaskService::new(database.pool().clone());

    let listed = process_completed_cron_turn(&tasks, "bot_a", "conv_a", "[CRON_LIST]", 0).await;

    assert_eq!(listed.visible_text, "");
    assert_eq!(
        listed.continuation.as_deref(),
        Some(
            "[System: No scheduled tasks. The user's scheduling request is not complete. Output CRON_CREATE now and do not confirm success before creation succeeds.]"
        )
    );
    assert_eq!(listed.next_count, 1);

    let created = process_completed_cron_turn(
        &tasks,
        "bot_a",
        "conv_a",
        "[CRON_CREATE]\nname: 提醒\nschedule: 0 9 * * *\nschedule_description: 每天上午 9 点\nmessage: 提醒我写日报。\n[/CRON_CREATE]",
        listed.next_count,
    )
    .await;
    assert_eq!(created.visible_text, "");
    assert!(
        created
            .continuation
            .as_deref()
            .unwrap()
            .contains("Created cron job '提醒'")
    );
    assert_eq!(created.next_count, 2);
}

#[tokio::test]
async fn normal_assistant_text_does_not_continue_and_limit_stops_protocol_loop() {
    let database = init_database_memory().await.unwrap();
    let tasks = TaskService::new(database.pool().clone());

    let normal =
        process_completed_cron_turn(&tasks, "bot_a", "conv_a", "任务已经设置好了。", 0).await;
    assert_eq!(normal.visible_text, "任务已经设置好了。");
    assert_eq!(normal.continuation, None);
    assert_eq!(normal.next_count, 0);

    let limited = process_completed_cron_turn(
        &tasks,
        "bot_a",
        "conv_a",
        "[CRON_LIST]",
        MAX_CRON_CONTINUATIONS,
    )
    .await;
    assert_eq!(limited.visible_text, "");
    assert_eq!(limited.continuation, None);
    assert_eq!(limited.next_count, MAX_CRON_CONTINUATIONS);
}

#[derive(Debug)]
struct SequencedBackend {
    outputs: Mutex<Vec<String>>,
    prompts: Mutex<Vec<String>>,
}

#[async_trait]
impl NativeAcpBackend for SequencedBackend {
    async fn send_message(
        &self,
        plan: RuntimeTurnPlan,
        sink: RuntimeEventSink,
        _cancellation: Option<RuntimeCancellation>,
    ) -> Result<RuntimeExecutionResult> {
        self.prompts.lock().unwrap().push(plan.send_message.content);
        let output = self.outputs.lock().unwrap().remove(0);
        sink.emit(
            EVENT_RUNTIME_STDOUT,
            json!({
                "turnId": plan.turn_id,
                "conversationId": plan.conversation_id,
                "engine": plan.engine,
                "text": output,
            }),
        );
        Ok(RuntimeExecutionResult {
            exit_code: Some(0),
            cancelled: false,
            stdout: output,
            stderr: String::new(),
        })
    }
}

fn test_plan() -> RuntimeTurnPlan {
    RuntimeTurnPlan {
        turn_id: "turn_initial".into(),
        conversation_id: "conv_a".into(),
        bot_id: Some("bot_a".into()),
        engine: "hermes".into(),
        workspace_dir: "/tmp/mia-cron-turn".into(),
        protocol: RuntimeProtocol::NativeAcp,
        command: None,
        environment: BTreeMap::new(),
        provider: json!({}),
        mcp_servers: json!({}),
        selected_skill_ids: vec![],
        runtime_session: RuntimeSessionState {
            conversation_id: "conv_a".into(),
            engine: "hermes".into(),
            session_key: "hermes:conv_a".into(),
            resume_session_key: None,
            resumed: false,
        },
        send_message: RuntimeSendMessage {
            content: "每天上午九点提醒我写日报".into(),
            msg_id: "msg_initial".into(),
            turn_id: Some("turn_initial".into()),
            files: vec![],
            inject_skills: vec![],
        },
        mock_response: None,
    }
}

#[tokio::test]
async fn runtime_loop_reuses_native_session_until_agent_returns_visible_confirmation() {
    let database = init_database_memory().await.unwrap();
    let tasks = TaskService::new(database.pool().clone());
    let backend = Arc::new(SequencedBackend {
        outputs: Mutex::new(vec![
            "[CRON_LIST]".into(),
            "[CRON_CREATE]\nname: 日报提醒\nschedule: 0 9 * * *\nschedule_description: 每天上午 9 点\nmessage: 提醒我写日报。\n[/CRON_CREATE]".into(),
            "已经设置好每天上午 9 点的日报提醒。".into(),
        ]),
        prompts: Mutex::new(Vec::new()),
    });
    let sessions = RuntimeSessionManager::new(NativeAcpSessionManager::with_backend_for_tests(
        backend.clone(),
    ));
    let visible_events = Arc::new(Mutex::new(Vec::new()));
    let captured_events = visible_events.clone();

    let result = execute_runtime_with_cron(
        &sessions,
        &tasks,
        test_plan(),
        move |_| {
            let captured_events = captured_events.clone();
            RuntimeEventSink::new(move |event| captured_events.lock().unwrap().push(event))
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(result.visible_text, "已经设置好每天上午 9 点的日报提醒。");
    assert_eq!(result.continuation_count, 2);
    assert_eq!(
        tasks
            .list_jobs_for_conversation("bot_a", "conv_a")
            .await
            .unwrap()
            .jobs
            .len(),
        1
    );
    let prompts = backend.prompts.lock().unwrap();
    assert_eq!(prompts.len(), 3);
    assert_eq!(prompts[0], "每天上午九点提醒我写日报");
    assert!(prompts[1].contains("Output CRON_CREATE now"));
    assert!(prompts[2].contains("Created cron job '日报提醒'"));
    let events = visible_events.lock().unwrap();
    assert!(events.iter().any(|event| {
        event.data["event"]["type"] == "tool.completed"
            && event.data["event"]["name"] == "创建 Mia 定时任务"
            && event.data["event"]["preview"]
                .as_str()
                .is_some_and(|preview| preview.contains("task_"))
    }));
    assert!(events.iter().any(|event| {
        event.data["turnId"] == "turn_initial"
            && event.data["text"] == "已经设置好每天上午 9 点的日报提醒。"
    }));
}

#[tokio::test]
async fn runtime_loop_hides_protocol_that_appears_after_visible_preamble() {
    let database = init_database_memory().await.unwrap();
    let tasks = TaskService::new(database.pool().clone());
    let backend = Arc::new(SequencedBackend {
        outputs: Mutex::new(vec![
            "我先创建任务。\n[CRON_CREATE]\nname: 日报提醒\nschedule: 0 9 * * *\nschedule_description: 每天上午 9 点\nmessage: 提醒我写日报。\n[/CRON_CREATE]\n任务已提交。".into(),
            "已经设置好每天上午 9 点的日报提醒。".into(),
        ]),
        prompts: Mutex::new(Vec::new()),
    });
    let sessions =
        RuntimeSessionManager::new(NativeAcpSessionManager::with_backend_for_tests(backend));
    let visible_events = Arc::new(Mutex::new(Vec::new()));
    let captured_events = visible_events.clone();

    let result = execute_runtime_with_cron(
        &sessions,
        &tasks,
        test_plan(),
        move |_| {
            let captured_events = captured_events.clone();
            RuntimeEventSink::new(move |event| captured_events.lock().unwrap().push(event))
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(result.visible_text, "已经设置好每天上午 9 点的日报提醒。");
    let streamed = visible_events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.name == EVENT_RUNTIME_STDOUT)
        .filter_map(|event| event.data["text"].as_str())
        .collect::<String>();
    assert!(!streamed.contains("CRON_CREATE"), "{streamed}");
    assert_eq!(streamed, "已经设置好每天上午 9 点的日报提醒。");
}
