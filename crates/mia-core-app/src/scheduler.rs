use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use mia_core_api_types::{RunTaskJobResponse, TaskJobSummary};
use mia_core_cloud::CloudService;
use mia_core_conversation::ConversationService;
use mia_core_realtime::EventBus;
use mia_core_runtime::RuntimeSessionManager;
use mia_core_tasks::{
    EVENT_TASK_RUN_FINISHED, EVENT_TASK_RUN_STARTED, EVENT_TASK_UPDATED, TaskService,
};
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tracing::warn;

use crate::cloud_bridge::MiaRuntimeProxyRegistry;
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

    let run_id = run.run_id.clone();
    match execute_task_conversation_turn(
        &services.conversation,
        &services.tasks,
        &services.cloud,
        &services.mia_runtime_proxies,
        &services.runtime,
        &services.runtime_sessions,
        &services.realtime,
        &job,
        run,
    )
    .await
    {
        Ok(execution) => finish_successful_job(services, &job.id, execution).await,
        Err(error) => finish_failed_job(services, &job.id, Some(run_id), error.to_string()).await,
    }
}

#[derive(Debug, Clone)]
pub struct ExecutedTaskRun {
    pub run: RunTaskJobResponse,
    pub output_text: String,
}

pub async fn execute_task_conversation_turn(
    conversation: &ConversationService,
    tasks: &TaskService,
    cloud: &CloudService,
    mia_runtime_proxies: &MiaRuntimeProxyRegistry,
    runtime: &RuntimeRegistry,
    runtime_sessions: &RuntimeSessionManager,
    realtime: &EventBus,
    job: &TaskJobSummary,
    mut run: RunTaskJobResponse,
) -> anyhow::Result<ExecutedTaskRun> {
    let requested_conversation_id =
        target_string(&job.target, &["conversationId", "conversation_id"])
            .context("task target conversationId is required")?;
    let conversation_id = conversation
        .resolve_local_conversation_id(&requested_conversation_id)
        .await
        .with_context(|| {
            format!("task target conversation {requested_conversation_id} is unavailable")
        })?;
    let selected_skill_ids = selected_skill_ids_from_target(&job.target);
    let mut runtime_claim = runtime
        .try_claim_conversation(conversation_id.clone())
        .map_err(|_| anyhow::anyhow!("conversation already has an active runtime turn"))?;
    let mut runtime_plan = match conversation
        .plan_internal_turn(&conversation_id, &job.instructions, selected_skill_ids)
        .await
    {
        Ok(runtime_plan) => runtime_plan,
        Err(error) => {
            runtime_claim.release();
            return Err(error.into());
        }
    };
    let runtime_config = runtime_plan.provider.clone();
    if let Err(error) = mia_runtime_proxies
        .prepare_plan(cloud, &runtime_config, &mut runtime_plan)
        .await
    {
        runtime_claim.release();
        return Err(anyhow::anyhow!(error.to_string()));
    }
    let turn_id = runtime_plan.turn_id.clone();
    runtime_claim.set_turn_id(turn_id.clone());

    let cancellation = runtime.register(turn_id.clone());
    let completion = execute_and_complete_runtime_turn(
        conversation,
        tasks,
        runtime_sessions,
        realtime,
        runtime_plan,
        Some(cancellation),
    )
    .await;
    runtime.remove(&turn_id);
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
    let output_text = completion.message.body.clone();
    run.conversation_id = Some(conversation_id);
    run.message_id = None;
    run.turn_id = Some(turn_id);
    run.assistant_message_id = Some(completion.message.message_id);
    Ok(ExecutedTaskRun { run, output_text })
}

async fn finish_successful_job(services: &AppServices, job_id: &str, execution: ExecutedTaskRun) {
    let run = execution.run;
    let run_record = json!({
        "id": run.run_id,
        "status": "ok",
        "firedAt": now_ms(),
        "outputText": execution.output_text,
        "conversationId": run.conversation_id,
        "messageId": run.message_id,
        "turnId": run.turn_id,
        "assistantMessageId": run.assistant_message_id,
    });
    match services
        .tasks
        .complete_scheduled_run_with_record(job_id, run_record)
        .await
    {
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
    let run_record = json!({
        "id": run_id.clone().unwrap_or_else(|| format!("run_{}", uuid::Uuid::now_v7().simple())),
        "status": "failed",
        "firedAt": now_ms(),
        "error": error,
    });
    match services
        .tasks
        .fail_scheduled_run_with_record(job_id, run_record)
        .await
    {
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
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
