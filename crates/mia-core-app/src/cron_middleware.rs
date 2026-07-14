use mia_core_api_types::{CreateTaskJobRequest, TaskJobSummary, UpdateTaskJobRequest};
use mia_core_conversation::cron_protocol::CronCommand;
use mia_core_tasks::TaskService;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronCommandOutcome {
    pub system_response: String,
    pub trace_name: String,
    pub trace_preview: String,
    pub successful: bool,
}

pub async fn process_cron_commands(
    tasks: &TaskService,
    bot_id: &str,
    conversation_id: &str,
    commands: &[CronCommand],
) -> Vec<String> {
    process_cron_command_outcomes(tasks, bot_id, conversation_id, commands)
        .await
        .into_iter()
        .map(|outcome| outcome.system_response)
        .collect()
}

pub async fn process_cron_command_outcomes(
    tasks: &TaskService,
    bot_id: &str,
    conversation_id: &str,
    commands: &[CronCommand],
) -> Vec<CronCommandOutcome> {
    let mut responses = Vec::new();
    for command in commands {
        let response = match command {
            CronCommand::Create(params) => {
                let request = CreateTaskJobRequest {
                    kind: "agent".into(),
                    schedule: Some(protocol_schedule(&params.schedule)),
                    schedule_intent: None,
                    target: json!({
                        "botId": bot_id,
                        "conversationId": conversation_id,
                        "title": params.name,
                        "scheduleDescription": params.schedule_description,
                    }),
                    instructions: params.message.clone(),
                };
                match tasks.create_job(request).await {
                    Ok(created) => format!(
                        "[System: Created cron job '{}' (id: {})]",
                        params.name, created.job.id
                    ),
                    Err(error) => format!("[System: Failed to create cron job: {error}]"),
                }
            }
            CronCommand::List => match tasks
                .list_jobs_for_conversation(bot_id, conversation_id)
                .await
            {
                Ok(listed) if listed.jobs.is_empty() => concat!(
                    "[System: No scheduled tasks. The user's scheduling request is not complete. ",
                    "Output CRON_CREATE now and do not confirm success before creation succeeds.]"
                )
                .into(),
                Ok(listed) => format_task_list(&listed.jobs),
                Err(error) => format!("[System: Failed to list scheduled tasks: {error}]"),
            },
            CronCommand::Update(params) => {
                match scoped_job(tasks, bot_id, conversation_id, &params.job_id).await {
                    Some(job) => {
                        let mut target = job.target;
                        target["title"] = Value::String(params.name.clone());
                        target["scheduleDescription"] =
                            Value::String(params.schedule_description.clone());
                        match tasks
                            .update_job(
                                &params.job_id,
                                UpdateTaskJobRequest {
                                    schedule: Some(protocol_schedule(&params.schedule)),
                                    schedule_intent: None,
                                    target: Some(target),
                                    instructions: Some(params.message.clone()),
                                    status: Some("active".to_string()),
                                },
                            )
                            .await
                        {
                            Ok(_) => format!(
                                "[System: Updated cron job '{}' (id: {})]",
                                params.name, params.job_id
                            ),
                            Err(error) => format!("[System: Failed to update cron job: {error}]"),
                        }
                    }
                    None => format!(
                        "[System: Scheduled task {} not found in this conversation]",
                        params.job_id
                    ),
                }
            }
            CronCommand::Delete(job_id) => {
                if scoped_job(tasks, bot_id, conversation_id, job_id)
                    .await
                    .is_none()
                {
                    format!("[System: Scheduled task {job_id} not found in this conversation]")
                } else {
                    match tasks.delete_job(job_id).await {
                        Ok(_) => format!("[System: Deleted cron job {job_id}]"),
                        Err(error) => format!("[System: Failed to delete cron job: {error}]"),
                    }
                }
            }
        };
        responses.push(CronCommandOutcome {
            trace_name: cron_trace_name(command).to_string(),
            trace_preview: cron_trace_preview(command, &response),
            successful: cron_response_successful(&response),
            system_response: response,
        });
    }
    responses
}

fn cron_trace_name(command: &CronCommand) -> &'static str {
    match command {
        CronCommand::Create(_) => "创建 Mia 定时任务",
        CronCommand::Update(_) => "更新 Mia 定时任务",
        CronCommand::List => "读取 Mia 定时任务",
        CronCommand::Delete(_) => "删除 Mia 定时任务",
    }
}

fn cron_trace_preview(command: &CronCommand, response: &str) -> String {
    if !cron_response_successful(response) {
        return format!("处理失败：{}", clean_system_response(response));
    }
    match command {
        CronCommand::Create(params) => format!(
            "已创建「{}」 · {}",
            params.name,
            response_id(response).unwrap_or("任务已落库")
        ),
        CronCommand::Update(params) => format!("已更新「{}」 · {}", params.name, params.job_id),
        CronCommand::List => "已读取当前会话的定时任务列表".to_string(),
        CronCommand::Delete(job_id) => format!("已删除任务 · {job_id}"),
    }
}

fn cron_response_successful(response: &str) -> bool {
    !response.contains("Failed") && !response.contains("not found")
}

fn response_id(response: &str) -> Option<&str> {
    response
        .split("(id: ")
        .nth(1)
        .and_then(|value| value.strip_suffix(")]"))
}

fn clean_system_response(response: &str) -> &str {
    response
        .strip_prefix("[System: ")
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(response)
}

async fn scoped_job(
    tasks: &TaskService,
    bot_id: &str,
    conversation_id: &str,
    job_id: &str,
) -> Option<TaskJobSummary> {
    tasks
        .list_jobs_for_conversation(bot_id, conversation_id)
        .await
        .ok()?
        .jobs
        .into_iter()
        .find(|job| job.id == job_id)
}

fn task_name(job: &TaskJobSummary) -> String {
    job.target
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&job.instructions)
        .to_string()
}

fn format_task_list(jobs: &[TaskJobSummary]) -> String {
    let mut lines = vec!["[System: Scheduled tasks for this conversation:".to_string()];
    for job in jobs {
        let description = job
            .target
            .get("scheduleDescription")
            .and_then(Value::as_str)
            .unwrap_or_default();
        lines.push(format!(
            "- id: {}; name: {}; schedule: {}; status: {}; message: {}",
            job.id,
            task_name(job),
            if description.is_empty() {
                job.schedule.to_string()
            } else {
                description.to_string()
            },
            job.status,
            job.instructions
        ));
    }
    lines.push("]".into());
    lines.join("\n")
}

fn protocol_schedule(schedule: &str) -> Value {
    let field_count = schedule.split_whitespace().count();
    if matches!(field_count, 5 | 6) {
        json!({
            "type": "cron",
            "cron": schedule.trim(),
            "timezone": "Asia/Shanghai",
        })
    } else {
        Value::String(schedule.trim().to_string())
    }
}
