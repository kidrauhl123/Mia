use std::time::Duration;

use anyhow::Context;
use mia_core_api_types::{RunTaskJobResponse, SendConversationMessageRequest, TaskJobSummary};
use mia_core_conversation::{ConversationService, EVENT_CONVERSATION_MESSAGE_CREATED};
use mia_core_realtime::EventBus;
use mia_core_runtime::{RuntimeProtocol, RuntimeSessionManager};
use mia_core_tasks::{
    EVENT_TASK_RUN_FINISHED, EVENT_TASK_RUN_STARTED, EVENT_TASK_UPDATED, TaskService,
};
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tracing::warn;

use crate::runtime::RuntimeRegistry;
use crate::services::AppServices;
use crate::turn_execution::execute_and_complete_runtime_turn;

#[derive(Clone, Debug)]
pub struct TaskScheduler {
    services: AppServices,
    poll_interval: Duration,
    batch_size: i64,
}

impl TaskScheduler {
    pub fn new(services: AppServices) -> Self {
        Self {
            services,
            poll_interval: Duration::from_secs(1),
            batch_size: 25,
        }
    }

    pub fn with_poll_interval(mut self, poll_interval: Duration) -> Self {
        self.poll_interval = poll_interval;
        self
    }

    pub fn start(self) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(self.poll_interval);
            loop {
                interval.tick().await;
                if let Err(error) = run_due_tasks_batch(&self.services, self.batch_size).await {
                    warn!(error = %error, "failed to run due task scheduler batch");
                }
            }
        })
    }
}

pub async fn run_due_tasks_once(services: &AppServices) -> anyhow::Result<usize> {
    run_due_tasks_batch(services, 25).await
}

async fn run_due_tasks_batch(services: &AppServices, limit: i64) -> anyhow::Result<usize> {
    let jobs = services.tasks.claim_due_jobs(limit).await?;
    let count = jobs.len();
    for job in jobs {
        run_claimed_job(services, job).await;
    }
    Ok(count)
}

async fn run_claimed_job(services: &AppServices, job: TaskJobSummary) {
    services.realtime.emit(
        EVENT_TASK_RUN_STARTED,
        json!({ "jobId": job.id.clone(), "scheduled": true }),
    );

    let run = match services.tasks.run_now(&job.id).await {
        Ok(run) => run,
        Err(error) => {
            finish_failed_job(services, &job.id, None, error.to_string()).await;
            return;
        }
    };

    match execute_task_conversation_turn(
        &services.conversation,
        &services.tasks,
        &services.runtime,
        &services.runtime_sessions,
        &services.realtime,
        &job,
        run,
    )
    .await
    {
        Ok(run) => finish_successful_job(services, &job.id, run).await,
        Err(error) => finish_failed_job(services, &job.id, None, error.to_string()).await,
    }
}

pub async fn execute_task_conversation_turn(
    conversation: &ConversationService,
    tasks: &TaskService,
    runtime: &RuntimeRegistry,
    runtime_sessions: &RuntimeSessionManager,
    realtime: &EventBus,
    job: &TaskJobSummary,
    mut run: RunTaskJobResponse,
) -> anyhow::Result<RunTaskJobResponse> {
    let conversation_id = target_string(&job.target, &["conversationId", "conversation_id"])
        .context("task target conversationId is required")?;
    let selected_skill_ids = selected_skill_ids_from_target(&job.target);
    let mut runtime_claim = runtime
        .try_claim_conversation(conversation_id.clone())
        .map_err(|_| anyhow::anyhow!("conversation already has an active runtime turn"))?;
    let turn = match conversation
        .start_user_turn(
            &conversation_id,
            SendConversationMessageRequest {
                body: job.instructions.clone(),
                attachments: json!([]),
                selected_skill_ids,
            },
        )
        .await
    {
        Ok(turn) => turn,
        Err(error) => {
            runtime_claim.release();
            return Err(error.into());
        }
    };
    let message = turn.response;
    runtime_claim.set_turn_id(message.turn_id.clone());
    realtime.emit(
        EVENT_CONVERSATION_MESSAGE_CREATED,
        json!({
            "conversationId": conversation_id,
            "messageId": message.message_id.clone(),
            "turnId": message.turn_id.clone(),
            "assistantMessageId": message.assistant_message_id.clone(),
            "accepted": message.accepted,
            "scheduled": true,
        }),
    );

    let assistant_message_id = if turn.runtime_plan.command.is_some()
        || turn.runtime_plan.protocol == RuntimeProtocol::NativeAcp
    {
        let cancellation = runtime.register(message.turn_id.clone());
        let completion = execute_and_complete_runtime_turn(
            conversation,
            tasks,
            runtime_sessions,
            realtime,
            turn.runtime_plan,
            Some(cancellation),
        )
        .await;
        runtime.remove(&message.turn_id);
        runtime_claim.release();
        let completion = completion?;
        if !completion.successful {
            anyhow::bail!(
                "{}",
                completion
                    .error
                    .unwrap_or_else(|| "scheduled runtime failed".into())
            );
        }
        Some(completion.message.message_id)
    } else {
        runtime_claim.release();
        message.assistant_message_id.clone()
    };
    run.conversation_id = Some(conversation_id);
    run.message_id = Some(message.message_id);
    run.turn_id = Some(message.turn_id);
    run.assistant_message_id = assistant_message_id;
    Ok(run)
}

async fn finish_successful_job(services: &AppServices, job_id: &str, run: RunTaskJobResponse) {
    match services.tasks.complete_scheduled_run(job_id).await {
        Ok(updated) => {
            services
                .realtime
                .emit(EVENT_TASK_UPDATED, json!({ "job": updated.job }));
        }
        Err(error) => {
            warn!(job_id, error = %error, "failed to complete scheduled task");
        }
    }
    services.realtime.emit(
        EVENT_TASK_RUN_FINISHED,
        json!({
            "jobId": job_id,
            "runId": run.run_id,
            "scheduled": true,
            "ok": true,
            "conversationId": run.conversation_id,
            "messageId": run.message_id,
            "turnId": run.turn_id,
            "assistantMessageId": run.assistant_message_id,
        }),
    );
}

async fn finish_failed_job(
    services: &AppServices,
    job_id: &str,
    run_id: Option<String>,
    error: String,
) {
    match services.tasks.fail_scheduled_run(job_id).await {
        Ok(updated) => {
            services
                .realtime
                .emit(EVENT_TASK_UPDATED, json!({ "job": updated.job }));
        }
        Err(finish_error) => {
            warn!(job_id, error = %finish_error, "failed to mark scheduled task failed");
        }
    }
    services.realtime.emit(
        EVENT_TASK_RUN_FINISHED,
        json!({
            "jobId": job_id,
            "runId": run_id,
            "scheduled": true,
            "ok": false,
            "error": error,
        }),
    );
}

fn target_string(target: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| target.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn selected_skill_ids_from_target(target: &Value) -> Vec<String> {
    target
        .get("selectedSkillIds")
        .or_else(|| target.get("selected_skill_ids"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}
