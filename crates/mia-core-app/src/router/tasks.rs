use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use mia_core_api_types::{
    CreateTaskJobRequest, EmptyResponse, RunTaskJobResponse, SendConversationMessageRequest,
    TaskJobListResponse, TaskJobResponse, UpdateTaskJobRequest,
};
use mia_core_tasks::{
    EVENT_TASK_CREATED, EVENT_TASK_RUN_FINISHED, EVENT_TASK_RUN_STARTED, EVENT_TASK_UPDATED,
    TaskError,
};
use serde_json::{Value, json};

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
    let mut run = states.tasks.run_now(&job_id).await.map_err(|error| {
        states.realtime.emit(
            EVENT_TASK_RUN_FINISHED,
            json!({ "jobId": job_id.clone(), "ok": false, "error": error.to_string() }),
        );
        ApiRouteError::from_task(error)
    })?;
    let conversation_id = target_string(&job.target, &["conversationId", "conversation_id"])
        .ok_or_else(|| ApiRouteError::bad_request("task target conversationId is required"))?;
    let selected_skill_ids = selected_skill_ids_from_target(&job.target);
    let message = states
        .conversation
        .send_user_message(
            &conversation_id,
            SendConversationMessageRequest {
                body: job.instructions,
                attachments: json!([]),
                selected_skill_ids,
            },
        )
        .await
        .map_err(|error| {
            states.realtime.emit(
                EVENT_TASK_RUN_FINISHED,
                json!({ "jobId": job_id.clone(), "ok": false, "error": error.to_string() }),
            );
            match error {
                sqlx::Error::RowNotFound => ApiRouteError::not_found("conversation not found"),
                _ => ApiRouteError::internal(error.to_string()),
            }
        })?;

    run.conversation_id = Some(conversation_id);
    run.message_id = Some(message.message_id);
    run.turn_id = Some(message.turn_id);
    run.assistant_message_id = message.assistant_message_id;
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
