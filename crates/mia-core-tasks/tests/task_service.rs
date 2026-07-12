use mia_core_api_types::{CreateTaskJobRequest, TaskScheduleIntent, UpdateTaskJobRequest};
use mia_core_db::init_database_memory;
use mia_core_tasks::TaskService;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

#[tokio::test]
async fn task_service_owns_crud_and_schedule_normalization() {
    let db = init_database_memory().await.unwrap();
    let service = TaskService::new(db.pool().clone());

    let created = service
        .create_job(CreateTaskJobRequest {
            kind: "agent".to_string(),
            schedule: Some(json!({"type":"cron","cron":"0 9 * * *","timezone":"UTC"})),
            schedule_intent: None,
            target: json!({"botId":"bot_1","conversationId":"conv_1"}),
            instructions: "daily summary".to_string(),
        })
        .await
        .unwrap();

    assert!(created.job.id.starts_with("task_"));
    assert_eq!(created.job.kind, "agent");
    assert_eq!(created.job.schedule["type"], "cron");
    assert_eq!(created.job.schedule["cron"], "0 9 * * *");
    assert_eq!(created.job.schedule["timezone"], "UTC");
    assert_eq!(created.job.status, "active");

    let updated = service
        .update_job(
            &created.job.id,
            UpdateTaskJobRequest {
                schedule: None,
                schedule_intent: None,
                target: None,
                instructions: Some("updated".to_string()),
                status: Some("paused".to_string()),
            },
        )
        .await
        .unwrap();
    assert_eq!(updated.job.instructions, "updated");
    assert_eq!(updated.job.status, "paused");

    let list = service.list_jobs().await.unwrap();
    assert_eq!(list.jobs.len(), 1);
    assert_eq!(list.jobs[0].id, created.job.id);

    let deleted = service.delete_job(&created.job.id).await.unwrap();
    assert!(deleted.ok);
    assert!(service.list_jobs().await.unwrap().jobs.is_empty());
}

#[tokio::test]
async fn task_service_normalizes_relative_schedule_strings_to_future_oneshot() {
    let db = init_database_memory().await.unwrap();
    let service = TaskService::with_now(db.pool().clone(), || 1_780_000_000_000);

    let created = service
        .create_job(CreateTaskJobRequest {
            kind: "deliver".to_string(),
            schedule: Some(json!("1m")),
            schedule_intent: None,
            target: json!({"botId":"bot_1","conversationId":"conv_1"}),
            instructions: "stand up".to_string(),
        })
        .await
        .unwrap();

    assert_eq!(created.job.schedule["type"], "oneshot");
    assert_eq!(created.job.schedule["atMs"], 1_780_000_060_000_i64);
}

#[tokio::test]
async fn task_service_normalizes_declarative_schedule_intents() {
    let db = init_database_memory().await.unwrap();
    let service = TaskService::with_now(db.pool().clone(), || 1_780_000_000_000);

    let daily = service
        .create_job(CreateTaskJobRequest {
            kind: "agent".to_string(),
            schedule: None,
            schedule_intent: Some(schedule_intent("daily", Some("09:30"))),
            target: json!({"botId":"bot_1","conversationId":"conv_1"}),
            instructions: "daily summary".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(daily.job.schedule["type"], "cron");
    assert_eq!(daily.job.schedule["cron"], "30 9 * * *");
    assert_eq!(daily.job.schedule["timezone"], "Asia/Shanghai");

    let weekly = service
        .create_job(CreateTaskJobRequest {
            kind: "agent".to_string(),
            schedule: None,
            schedule_intent: Some(TaskScheduleIntent {
                weekday: Some(2),
                ..schedule_intent("weekly", Some("10:05"))
            }),
            target: json!({"botId":"bot_1","conversationId":"conv_1"}),
            instructions: "weekly summary".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(weekly.job.schedule["cron"], "5 10 * * 2");

    let monthly = service
        .create_job(CreateTaskJobRequest {
            kind: "agent".to_string(),
            schedule: None,
            schedule_intent: Some(TaskScheduleIntent {
                day_of_month: Some(15),
                ..schedule_intent("monthly", Some("11:45"))
            }),
            target: json!({"botId":"bot_1","conversationId":"conv_1"}),
            instructions: "monthly summary".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(monthly.job.schedule["cron"], "45 11 15 * *");

    let oneshot = service
        .create_job(CreateTaskJobRequest {
            kind: "agent".to_string(),
            schedule: None,
            schedule_intent: Some(TaskScheduleIntent {
                date: Some("2099-01-01".to_string()),
                ..schedule_intent("oneshot", Some("12:00"))
            }),
            target: json!({"botId":"bot_1","conversationId":"conv_1"}),
            instructions: "future run".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(oneshot.job.schedule["type"], "oneshot");
    assert_eq!(oneshot.job.schedule["timezone"], "Asia/Shanghai");
    assert!(oneshot.job.schedule["atMs"].as_i64().unwrap() > 1_780_000_000_000);
}

#[tokio::test]
async fn task_service_rejects_invalid_cron_timezone_and_past_oneshot() {
    let db = init_database_memory().await.unwrap();
    let service = TaskService::with_now(db.pool().clone(), || 1_780_000_000_000);

    let bad_cron = service
        .create_job(CreateTaskJobRequest {
            kind: "agent".to_string(),
            schedule: Some(json!({"type":"cron","cron":"not cron","timezone":"UTC"})),
            schedule_intent: None,
            target: json!({"botId":"bot_1","conversationId":"conv_1"}),
            instructions: "bad".to_string(),
        })
        .await
        .unwrap_err();
    assert!(bad_cron.to_string().contains("invalid cron"));

    let bad_timezone = service
        .create_job(CreateTaskJobRequest {
            kind: "agent".to_string(),
            schedule: Some(json!({"type":"cron","cron":"0 9 * * *","timezone":"Not/A_Zone"})),
            schedule_intent: None,
            target: json!({"botId":"bot_1","conversationId":"conv_1"}),
            instructions: "bad".to_string(),
        })
        .await
        .unwrap_err();
    assert!(bad_timezone.to_string().contains("invalid timezone"));

    let past = service
        .create_job(CreateTaskJobRequest {
            kind: "deliver".to_string(),
            schedule: Some(json!({"type":"oneshot","atMs":1_779_999_999_000_i64})),
            schedule_intent: None,
            target: json!({"botId":"bot_1","conversationId":"conv_1"}),
            instructions: "bad".to_string(),
        })
        .await
        .unwrap_err();
    assert!(past.to_string().contains("future"));
}

#[tokio::test]
async fn task_service_run_now_records_core_owned_run_acceptance() {
    let db = init_database_memory().await.unwrap();
    let service = TaskService::new(db.pool().clone());
    let created = service
        .create_job(CreateTaskJobRequest {
            kind: "agent".to_string(),
            schedule: Some(json!({"type":"cron","cron":"0 9 * * *","timezone":"UTC"})),
            schedule_intent: None,
            target: json!({"botId":"bot_1","conversationId":"conv_1"}),
            instructions: "run".to_string(),
        })
        .await
        .unwrap();

    let run = service.run_now(&created.job.id).await.unwrap();

    assert!(run.accepted);
    assert!(run.run_id.starts_with("run_"));
}

#[tokio::test]
async fn task_service_claims_due_jobs_once_and_reschedules_after_completion() {
    let db = init_database_memory().await.unwrap();
    let now = Arc::new(AtomicI64::new(1_000));
    let service = TaskService::with_now(db.pool().clone(), {
        let now = now.clone();
        move || now.load(Ordering::SeqCst)
    });
    let created = service
        .create_job(CreateTaskJobRequest {
            kind: "agent".to_string(),
            schedule: Some(json!({"type":"every","everyMs":1_000})),
            schedule_intent: None,
            target: json!({"botId":"bot_1","conversationId":"conv_1"}),
            instructions: "run every second".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(created.job.next_run_at, Some(2_000));

    now.store(2_500, Ordering::SeqCst);
    let due = service.claim_due_jobs(10).await.unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].id, created.job.id);
    assert!(service.claim_due_jobs(10).await.unwrap().is_empty());

    let completed = service
        .complete_scheduled_run(&created.job.id)
        .await
        .unwrap();
    assert_eq!(completed.job.status, "active");
    assert_eq!(completed.job.next_run_at, Some(3_500));
}

#[tokio::test]
async fn task_service_marks_due_oneshot_done_after_scheduled_attempt() {
    let db = init_database_memory().await.unwrap();
    let now = Arc::new(AtomicI64::new(1_000));
    let service = TaskService::with_now(db.pool().clone(), {
        let now = now.clone();
        move || now.load(Ordering::SeqCst)
    });
    let created = service
        .create_job(CreateTaskJobRequest {
            kind: "agent".to_string(),
            schedule: Some(json!({"type":"oneshot","atMs":2_000})),
            schedule_intent: None,
            target: json!({"botId":"bot_1","conversationId":"conv_1"}),
            instructions: "run once".to_string(),
        })
        .await
        .unwrap();

    now.store(2_000, Ordering::SeqCst);
    let due = service.claim_due_jobs(10).await.unwrap();
    assert_eq!(due.len(), 1);
    let completed = service
        .complete_scheduled_run(&created.job.id)
        .await
        .unwrap();
    assert_eq!(completed.job.status, "done");
    assert_eq!(completed.job.next_run_at, None);
}

#[tokio::test]
async fn task_service_marks_failed_oneshot_and_persists_real_run_record() {
    let db = init_database_memory().await.unwrap();
    let now = Arc::new(AtomicI64::new(1_000));
    let service = TaskService::with_now(db.pool().clone(), {
        let now = now.clone();
        move || now.load(Ordering::SeqCst)
    });
    let created = service
        .create_job(CreateTaskJobRequest {
            kind: "agent".to_string(),
            schedule: Some(json!({"type":"oneshot","atMs":2_000})),
            schedule_intent: None,
            target: json!({"botId":"bot_1","conversationId":"conv_1"}),
            instructions: "run once".to_string(),
        })
        .await
        .unwrap();

    now.store(2_000, Ordering::SeqCst);
    service.claim_due_jobs(10).await.unwrap();
    let failed = service
        .fail_scheduled_run_with_record(
            &created.job.id,
            json!({
                "id": "run_1",
                "status": "failed",
                "firedAt": 2_000,
                "error": "agent process exited",
            }),
        )
        .await
        .unwrap();

    assert_eq!(failed.job.status, "failed");
    assert_eq!(failed.job.next_run_at, None);
    assert_eq!(failed.job.target["runs"][0]["id"], "run_1");
    assert_eq!(failed.job.target["runs"][0]["status"], "failed");
}

fn schedule_intent(kind: &str, time: Option<&str>) -> TaskScheduleIntent {
    TaskScheduleIntent {
        kind: kind.to_string(),
        date: None,
        time: time.map(str::to_string),
        weekday: None,
        day_of_month: None,
        timezone: Some("Asia/Shanghai".to_string()),
        time_expression: None,
    }
}
