use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use mia_core_api_types::{
    CreateTaskJobRequest, EmptyResponse, RunTaskJobResponse, TaskJobListResponse, TaskJobResponse,
    UpdateTaskJobRequest,
};
use mia_core_tasks::{
    EVENT_TASK_CREATED, EVENT_TASK_RUN_FINISHED, EVENT_TASK_RUN_STARTED, EVENT_TASK_UPDATED,
    TaskError,
};
use serde_json::json;

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
    let run = execute_task_conversation_turn(
        &states.conversation,
        &states.tasks,
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
            "runId": run.run_id.clone(),
            "ok": true,
            "conversationId": run.conversation_id.clone(),
            "messageId": run.message_id.clone(),
            "turnId": run.turn_id.clone(),
            "assistantMessageId": run.assistant_message_id.clone(),
        }),
    );
    Ok(Json(run))
}

#[derive(Debug)]
pub struct ApiRouteError {
    status: StatusCode,
    message: String,
}

impl ApiRouteError {
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
