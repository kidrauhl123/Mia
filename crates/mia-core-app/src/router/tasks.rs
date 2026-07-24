use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use mia_core_api_types::{
    CreateTaskJobRequest, EmptyResponse, RunTaskJobResponse, TaskJobListResponse, TaskJobResponse,
    TaskJobSummary, UpdateTaskJobRequest,
};
use mia_core_cloud::CloudError;
use mia_core_tasks::{
    EVENT_TASK_CREATED, EVENT_TASK_RUN_FINISHED, EVENT_TASK_RUN_STARTED, EVENT_TASK_UPDATED,
    TaskError,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::scheduler::execute_task_conversation_turn;

use super::state::ModuleStates;

pub async fn list_task_jobs(
    State(states): State<ModuleStates>,
) -> Result<Json<TaskJobListResponse>, ApiRouteError> {
    states
        .tasks
        .list_jobs()
        .await
        .map(Json)
        .map_err(ApiRouteError::from_task)
}

/// Scope supplied by the per-turn built-in MCP process.  The Agent never gets
/// to choose it: `builtin_mcp` derives both values from the active turn.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerScope {
    pub bot_id: String,
    pub conversation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerCreateRequest {
    pub bot_id: String,
    pub conversation_id: String,
    pub name: String,
    pub schedule: Value,
    pub schedule_description: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerUpdateRequest {
    pub bot_id: String,
    pub conversation_id: String,
    pub name: Option<String>,
    pub schedule: Option<Value>,
    pub schedule_description: Option<String>,
    pub message: Option<String>,
    pub status: Option<String>,
}

pub async fn list_scheduler_jobs(
    State(states): State<ModuleStates>,
    Query(scope): Query<SchedulerScope>,
) -> Result<Json<TaskJobListResponse>, ApiRouteError> {
    states
        .tasks
        .list_jobs_for_conversation(&scope.bot_id, &scope.conversation_id)
        .await
        .map(Json)
        .map_err(ApiRouteError::from_task)
}

pub async fn create_scheduler_job(
    State(states): State<ModuleStates>,
    Json(request): Json<SchedulerCreateRequest>,
) -> Result<Json<TaskJobResponse>, ApiRouteError> {
    let name = required_scheduler_text("name", request.name)?;
    let schedule_description =
        required_scheduler_text("scheduleDescription", request.schedule_description)?;
    let message = required_scheduler_text("message", request.message)?;
    let response = states
        .tasks
        .create_job(CreateTaskJobRequest {
            kind: "agent".into(),
            schedule: Some(request.schedule),
            schedule_intent: None,
            target: json!({
                "botId": request.bot_id,
                "conversationId": request.conversation_id,
                "title": name,
                "scheduleDescription": schedule_description,
            }),
            instructions: message,
        })
        .await
        .map_err(ApiRouteError::from_task)?;
    states
        .realtime
        .emit(EVENT_TASK_CREATED, json!({ "job": response.job.clone() }));
    Ok(Json(response))
}

pub async fn update_scheduler_job(
    State(states): State<ModuleStates>,
    Path(job_id): Path<String>,
    Json(request): Json<SchedulerUpdateRequest>,
) -> Result<Json<TaskJobResponse>, ApiRouteError> {
    let job =
        scoped_scheduler_job(&states, &request.bot_id, &request.conversation_id, &job_id).await?;
    let mut target = job.target;
    if !target.is_object() {
        target = json!({});
    }
    let target_object = target
        .as_object_mut()
        .expect("scheduler target normalized to object");
    if let Some(name) = request.name {
        target_object.insert(
            "title".into(),
            Value::String(required_scheduler_text("name", name)?),
        );
    }
    if let Some(description) = request.schedule_description {
        target_object.insert(
            "scheduleDescription".into(),
            Value::String(required_scheduler_text("scheduleDescription", description)?),
        );
    }
    let message = request
        .message
        .map(|message| required_scheduler_text("message", message))
        .transpose()?;
    let response = states
        .tasks
        .update_job(
            &job_id,
            UpdateTaskJobRequest {
                schedule: request.schedule,
                schedule_intent: None,
                target: Some(target),
                instructions: message,
                status: request.status,
            },
        )
        .await
        .map_err(ApiRouteError::from_task)?;
    states
        .realtime
        .emit(EVENT_TASK_UPDATED, json!({ "job": response.job.clone() }));
    Ok(Json(response))
}

pub async fn delete_scheduler_job(
    State(states): State<ModuleStates>,
    Path(job_id): Path<String>,
    Json(scope): Json<SchedulerScope>,
) -> Result<Json<EmptyResponse>, ApiRouteError> {
    scoped_scheduler_job(&states, &scope.bot_id, &scope.conversation_id, &job_id).await?;
    let response = states
        .tasks
        .delete_job(&job_id)
        .await
        .map_err(ApiRouteError::from_task)?;
    states.realtime.emit(
        EVENT_TASK_UPDATED,
        json!({ "jobId": job_id, "deleted": true }),
    );
    Ok(Json(response))
}

async fn scoped_scheduler_job(
    states: &ModuleStates,
    bot_id: &str,
    conversation_id: &str,
    job_id: &str,
) -> Result<TaskJobSummary, ApiRouteError> {
    states
        .tasks
        .list_jobs_for_conversation(bot_id, conversation_id)
        .await
        .map_err(ApiRouteError::from_task)?
        .jobs
        .into_iter()
        .find(|job| job.id == job_id)
        .ok_or_else(|| ApiRouteError::not_found("scheduled task not found in this conversation"))
}

fn required_scheduler_text(field: &str, value: String) -> Result<String, ApiRouteError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(ApiRouteError::bad_request(format!("{field} is required")));
    }
    Ok(value)
}

pub async fn list_cloud_tasks(
    State(states): State<ModuleStates>,
) -> Result<Json<Value>, ApiRouteError> {
    states
        .cloud
        .list_tasks()
        .await
        .map(Json)
        .map_err(ApiRouteError::from_cloud)
}

pub async fn get_cloud_task(
    State(states): State<ModuleStates>,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiRouteError> {
    states
        .cloud
        .get_task(&task_id)
        .await
        .map(Json)
        .map_err(ApiRouteError::from_cloud)
}

pub async fn update_cloud_task(
    State(states): State<ModuleStates>,
    Path(task_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiRouteError> {
    states
        .cloud
        .update_task(&task_id, body)
        .await
        .map(Json)
        .map_err(ApiRouteError::from_cloud)
}

pub async fn delete_cloud_task(
    State(states): State<ModuleStates>,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiRouteError> {
    states
        .cloud
        .delete_task(&task_id)
        .await
        .map(Json)
        .map_err(ApiRouteError::from_cloud)
}

pub async fn pause_cloud_task(
    State(states): State<ModuleStates>,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiRouteError> {
    states
        .cloud
        .pause_task(&task_id)
        .await
        .map(Json)
        .map_err(ApiRouteError::from_cloud)
}

pub async fn resume_cloud_task(
    State(states): State<ModuleStates>,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiRouteError> {
    states
        .cloud
        .resume_task(&task_id)
        .await
        .map(Json)
        .map_err(ApiRouteError::from_cloud)
}

pub async fn run_cloud_task_now(
    State(states): State<ModuleStates>,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, ApiRouteError> {
    states
        .cloud
        .run_task_now(&task_id)
        .await
        .map(Json)
        .map_err(ApiRouteError::from_cloud)
}

pub async fn create_task_job(
    State(states): State<ModuleStates>,
    Json(request): Json<CreateTaskJobRequest>,
) -> Result<Json<TaskJobResponse>, ApiRouteError> {
    let response = states
        .tasks
        .create_job(request)
        .await
        .map_err(ApiRouteError::from_task)?;
    states
        .realtime
        .emit(EVENT_TASK_CREATED, json!({ "job": response.job.clone() }));
    Ok(Json(response))
}

pub async fn get_task_job(
    State(states): State<ModuleStates>,
    Path(job_id): Path<String>,
) -> Result<Json<TaskJobResponse>, ApiRouteError> {
    states
        .tasks
        .get_job(&job_id)
        .await
        .map(Json)
        .map_err(ApiRouteError::from_task)
}

pub async fn update_task_job(
    State(states): State<ModuleStates>,
    Path(job_id): Path<String>,
    Json(request): Json<UpdateTaskJobRequest>,
) -> Result<Json<TaskJobResponse>, ApiRouteError> {
    let response = states
        .tasks
        .update_job(&job_id, request)
        .await
        .map_err(ApiRouteError::from_task)?;
    states
        .realtime
        .emit(EVENT_TASK_UPDATED, json!({ "job": response.job.clone() }));
    Ok(Json(response))
}

pub async fn delete_task_job(
    State(states): State<ModuleStates>,
    Path(job_id): Path<String>,
) -> Result<Json<EmptyResponse>, ApiRouteError> {
    let response = states
        .tasks
        .delete_job(&job_id)
        .await
        .map_err(ApiRouteError::from_task)?;
    states.realtime.emit(
        EVENT_TASK_UPDATED,
        json!({ "jobId": job_id, "deleted": true }),
    );
    Ok(Json(response))
}

pub async fn run_task_job(
    State(states): State<ModuleStates>,
    Path(job_id): Path<String>,
) -> Result<Json<RunTaskJobResponse>, ApiRouteError> {
    let job = states
        .tasks
        .get_job(&job_id)
        .await
        .map_err(ApiRouteError::from_task)?
        .job;
    states
        .realtime
        .emit(EVENT_TASK_RUN_STARTED, json!({ "jobId": job_id.clone() }));
    let run = states.tasks.run_now(&job_id).await.map_err(|error| {
        states.realtime.emit(
            EVENT_TASK_RUN_FINISHED,
            json!({ "jobId": job_id.clone(), "ok": false, "error": error.to_string() }),
        );
        ApiRouteError::from_task(error)
    })?;
    let execution = execute_task_conversation_turn(
        &states.conversation,
        &states.tasks,
        &states.cloud,
        &states.mia_runtime_proxies,
        &states.runtime,
        &states.runtime_sessions,
        &states.realtime,
        &job,
        run,
    )
    .await
    .map_err(|error| {
        states.realtime.emit(
            EVENT_TASK_RUN_FINISHED,
            json!({ "jobId": job_id.clone(), "ok": false, "error": error.to_string() }),
        );
        ApiRouteError::internal(error.to_string())
    })?;
    states.realtime.emit(
        EVENT_TASK_RUN_FINISHED,
        json!({
            "jobId": job_id,
            "runId": execution.run.run_id.clone(),
            "ok": true,
            "conversationId": execution.run.conversation_id.clone(),
            "messageId": execution.run.message_id.clone(),
            "turnId": execution.run.turn_id.clone(),
            "assistantMessageId": execution.run.assistant_message_id.clone(),
        }),
    );
    Ok(Json(execution.run))
}

#[derive(Debug)]
pub struct ApiRouteError {
    status: StatusCode,
    message: String,
}

impl ApiRouteError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn from_task(error: TaskError) -> Self {
        let status = match &error {
            TaskError::NotFound(_) => StatusCode::NOT_FOUND,
            TaskError::InvalidSchedule(_)
            | TaskError::InvalidCron(_)
            | TaskError::InvalidTimezone(_)
            | TaskError::InvalidInput(_) => StatusCode::BAD_REQUEST,
            TaskError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self {
            status,
            message: error.to_string(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }

    fn from_cloud(error: CloudError) -> Self {
        let status = match &error {
            CloudError::InvalidInput(_) => StatusCode::BAD_REQUEST,
            CloudError::Transport(_) => StatusCode::BAD_GATEWAY,
            CloudError::Busy(_) => StatusCode::CONFLICT,
            CloudError::Runtime(_) | CloudError::Memory(_) | CloudError::Database(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        Self {
            status,
            message: error.to_string(),
        }
    }
}

impl IntoResponse for ApiRouteError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({
                "ok": false,
                "error": self.message,
            })),
        )
            .into_response()
    }
}
