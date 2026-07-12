use mia_core_app::cron_middleware::process_cron_commands;
use mia_core_conversation::cron_protocol::{CronCommand, CronCreateParams, CronUpdateParams};
use mia_core_db::init_database_memory;
use mia_core_tasks::TaskService;

#[tokio::test]
async fn cron_commands_create_list_update_and_delete_within_conversation_scope() {
    let database = init_database_memory().await.unwrap();
    let tasks = TaskService::new(database.pool().clone());

    let created = process_cron_commands(
        &tasks,
        "bot_a",
        "conv_a",
        &[CronCommand::Create(CronCreateParams {
            name: "每日简报".into(),
            schedule: "0 9 * * *".into(),
            schedule_description: "每天上午 9 点".into(),
            message: "输出每日简报。".into(),
        })],
    )
    .await;
    assert_eq!(created.len(), 1);
    assert!(created[0].contains("Created cron job '每日简报'"));

    let listed = process_cron_commands(&tasks, "bot_a", "conv_a", &[CronCommand::List]).await;
    assert_eq!(listed.len(), 1);
    assert!(listed[0].contains("每日简报"));
    assert!(listed[0].contains("每天上午 9 点"));

    let jobs = tasks
        .list_jobs_for_conversation("bot_a", "conv_a")
        .await
        .unwrap();
    assert_eq!(jobs.jobs.len(), 1);
    assert_eq!(jobs.jobs[0].schedule["timezone"], "Asia/Shanghai");
    let job_id = jobs.jobs[0].id.clone();

    let foreign_list = process_cron_commands(&tasks, "bot_b", "conv_b", &[CronCommand::List]).await;
    assert_eq!(foreign_list, vec!["[System: No scheduled tasks]"]);

    let foreign_update = process_cron_commands(
        &tasks,
        "bot_b",
        "conv_b",
        &[CronCommand::Update(CronUpdateParams {
            job_id: job_id.clone(),
            name: "越权修改".into(),
            schedule: "30 8 * * *".into(),
            schedule_description: "每天上午 8:30".into(),
            message: "不应成功。".into(),
        })],
    )
    .await;
    assert!(foreign_update[0].contains("not found"));

    let updated = process_cron_commands(
        &tasks,
        "bot_a",
        "conv_a",
        &[CronCommand::Update(CronUpdateParams {
            job_id: job_id.clone(),
            name: "工作日简报".into(),
            schedule: "30 8 * * 1-5".into(),
            schedule_description: "工作日上午 8:30".into(),
            message: "输出工作日简报。".into(),
        })],
    )
    .await;
    assert!(updated[0].contains("Updated cron job '工作日简报'"));

    let job = tasks.get_job(&job_id).await.unwrap().job;
    assert_eq!(job.instructions, "输出工作日简报。");
    assert_eq!(job.target["title"], "工作日简报");
    assert_eq!(job.target["scheduleDescription"], "工作日上午 8:30");

    let foreign_delete = process_cron_commands(
        &tasks,
        "bot_b",
        "conv_b",
        &[CronCommand::Delete(job_id.clone())],
    )
    .await;
    assert!(foreign_delete[0].contains("not found"));

    let deleted =
        process_cron_commands(&tasks, "bot_a", "conv_a", &[CronCommand::Delete(job_id)]).await;
    assert!(deleted[0].contains("Deleted cron job"));
    assert!(
        tasks
            .list_jobs_for_conversation("bot_a", "conv_a")
            .await
            .unwrap()
            .jobs
            .is_empty()
    );
}

#[tokio::test]
async fn cron_create_is_idempotently_blocked_when_conversation_already_has_a_job() {
    let database = init_database_memory().await.unwrap();
    let tasks = TaskService::new(database.pool().clone());
    let command = CronCommand::Create(CronCreateParams {
        name: "提醒".into(),
        schedule: "0 9 * * *".into(),
        schedule_description: "每天上午 9 点".into(),
        message: "提醒我。".into(),
    });

    process_cron_commands(&tasks, "bot_a", "conv_a", std::slice::from_ref(&command)).await;
    let duplicate = process_cron_commands(&tasks, "bot_a", "conv_a", &[command]).await;

    assert!(duplicate[0].contains("already has scheduled task"));
    assert_eq!(
        tasks
            .list_jobs_for_conversation("bot_a", "conv_a")
            .await
            .unwrap()
            .jobs
            .len(),
        1
    );
}
