//! Task scheduling and task execution boundary for Mia Rust Core.

use std::str::FromStr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{NaiveDate, NaiveTime, TimeZone, Timelike};
use cron::Schedule;
use mia_core_api_types::{
    CreateTaskJobRequest, EmptyResponse, RunTaskJobResponse, TaskJobListResponse, TaskJobResponse,
    TaskJobSummary, TaskScheduleIntent, UpdateTaskJobRequest,
};
use serde_json::{Value, json};
use sqlx::{Row, SqlitePool};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

pub const EVENT_TASK_CREATED: &str = "task.created";
pub const EVENT_TASK_UPDATED: &str = "task.updated";
pub const EVENT_TASK_RUN_STARTED: &str = "task.runStarted";
pub const EVENT_TASK_RUN_FINISHED: &str = "task.runFinished";

type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum TaskError {
    #[error("task not found: {0}")]
    NotFound(String),
    #[error("invalid schedule: {0}")]
    InvalidSchedule(String),
    #[error("invalid cron: {0}")]
    InvalidCron(String),
    #[error("invalid timezone: {0}")]
    InvalidTimezone(String),
    #[error("invalid task input: {0}")]
    InvalidInput(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Clone)]
pub struct TaskService {
    pool: SqlitePool,
    now_ms: NowFn,
}

impl std::fmt::Debug for TaskService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TaskService")
            .finish_non_exhaustive()
    }
}

impl TaskService {
    pub fn new(pool: SqlitePool) -> Self {
        Self::with_now(pool, now_ms)
    }

    pub fn with_now<F>(pool: SqlitePool, now_ms: F) -> Self
    where
        F: Fn() -> i64 + Send + Sync + 'static,
    {
        Self {
            pool,
            now_ms: Arc::new(now_ms),
        }
    }

    pub async fn list_jobs(&self) -> Result<TaskJobListResponse, TaskError> {
        let rows = sqlx::query(
            "SELECT id, kind, schedule_json, target_json, instructions, status, next_run_at \
             FROM tasks ORDER BY created_at ASC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(TaskJobListResponse {
            jobs: rows
                .into_iter()
                .map(task_job_from_row)
                .collect::<Result<Vec<_>, _>>()?,
        })
    }

    pub async fn list_jobs_for_conversation(
        &self,
        bot_id: &str,
        conversation_id: &str,
    ) -> Result<TaskJobListResponse, TaskError> {
        let bot_id = bot_id.trim();
        let conversation_id = conversation_id.trim();
        let mut response = self.list_jobs().await?;
        response.jobs.retain(|job| {
            target_string(&job.target, &["botId", "bot_id"]).as_deref() == Some(bot_id)
                && target_string(&job.target, &["conversationId", "conversation_id"]).as_deref()
                    == Some(conversation_id)
        });
        Ok(response)
    }

    pub async fn get_job(&self, job_id: &str) -> Result<TaskJobResponse, TaskError> {
        let row = sqlx::query(
            "SELECT id, kind, schedule_json, target_json, instructions, status, next_run_at \
             FROM tasks WHERE id = ?",
        )
        .bind(job_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| TaskError::NotFound(job_id.to_string()))?;
        Ok(TaskJobResponse {
            job: task_job_from_row(row)?,
        })
    }

    pub async fn create_job(
        &self,
        request: CreateTaskJobRequest,
    ) -> Result<TaskJobResponse, TaskError> {
        let now = self.now();
        let schedule = normalize_create_schedule(request.schedule, request.schedule_intent, now)?;
        let next_run_at = compute_next_run(&schedule, now)?;
        validate_target(&request.target)?;
        validate_instructions(&request.instructions)?;
        let id = format!("task_{}", Uuid::now_v7().simple());
        sqlx::query(
            "INSERT INTO tasks (id, kind, schedule_json, target_json, instructions, status, next_run_at, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)",
        )
        .bind(&id)
        .bind(clean_kind(&request.kind))
        .bind(schedule.to_string())
        .bind(request.target.to_string())
        .bind(request.instructions)
        .bind(next_run_at)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_job(&id).await
    }

    pub async fn update_job(
        &self,
        job_id: &str,
        request: UpdateTaskJobRequest,
    ) -> Result<TaskJobResponse, TaskError> {
        let current = self.get_job(job_id).await?.job;
        let now = self.now();
        let schedule = normalize_update_schedule(
            request.schedule,
            request.schedule_intent,
            current.schedule,
            now,
        )?;
        let target = match request.target {
            Some(target) => {
                validate_target(&target)?;
                target
            }
            None => current.target,
        };
        let instructions = request.instructions.unwrap_or(current.instructions);
        validate_instructions(&instructions)?;
        let status = request.status.unwrap_or(current.status);
        validate_status(&status)?;
        let next_run_at = if status == "active" {
            compute_next_run(&schedule, now)?
        } else {
            None
        };
        sqlx::query(
            "UPDATE tasks SET schedule_json = ?, target_json = ?, instructions = ?, status = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(schedule.to_string())
        .bind(target.to_string())
        .bind(instructions)
        .bind(status)
        .bind(next_run_at)
        .bind(now)
        .bind(job_id)
        .execute(&self.pool)
        .await?;
        self.get_job(job_id).await
    }

    pub async fn delete_job(&self, job_id: &str) -> Result<EmptyResponse, TaskError> {
        let result = sqlx::query("DELETE FROM tasks WHERE id = ?")
            .bind(job_id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(TaskError::NotFound(job_id.to_string()));
        }
        Ok(EmptyResponse { ok: true })
    }

    pub async fn run_now(&self, job_id: &str) -> Result<RunTaskJobResponse, TaskError> {
        let _ = self.get_job(job_id).await?;
        let run_id = format!("run_{}", Uuid::now_v7().simple());
        sqlx::query("UPDATE tasks SET last_run_at = ?, updated_at = ? WHERE id = ?")
            .bind(self.now())
            .bind(self.now())
            .bind(job_id)
            .execute(&self.pool)
            .await?;
        Ok(RunTaskJobResponse {
            run_id,
            accepted: true,
            conversation_id: None,
            message_id: None,
            turn_id: None,
            assistant_message_id: None,
        })
    }

    pub async fn claim_due_jobs(&self, limit: i64) -> Result<Vec<TaskJobSummary>, TaskError> {
        let now = self.now();
        let rows = sqlx::query(
            "SELECT id, kind, schedule_json, target_json, instructions, status, next_run_at \
             FROM tasks \
             WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? \
             ORDER BY next_run_at ASC, id ASC \
             LIMIT ?",
        )
        .bind(now)
        .bind(limit.max(1))
        .fetch_all(&self.pool)
        .await?;
        let mut claimed = Vec::with_capacity(rows.len());
        for row in rows {
            let job = task_job_from_row(row)?;
            let result = sqlx::query(
                "UPDATE tasks SET status = 'running', next_run_at = NULL, updated_at = ? \
                 WHERE id = ? AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?",
            )
            .bind(now)
            .bind(&job.id)
            .bind(now)
            .execute(&self.pool)
            .await?;
            if result.rows_affected() == 1 {
                claimed.push(self.get_job(&job.id).await?.job);
            }
        }
        Ok(claimed)
    }

    pub async fn complete_scheduled_run(&self, job_id: &str) -> Result<TaskJobResponse, TaskError> {
        self.finish_scheduled_run(job_id, true, None).await
    }

    pub async fn fail_scheduled_run(&self, job_id: &str) -> Result<TaskJobResponse, TaskError> {
        self.finish_scheduled_run(job_id, false, None).await
    }

    pub async fn complete_scheduled_run_with_record(
        &self,
        job_id: &str,
        run_record: Value,
    ) -> Result<TaskJobResponse, TaskError> {
        self.finish_scheduled_run(job_id, true, Some(run_record))
            .await
    }

    pub async fn fail_scheduled_run_with_record(
        &self,
        job_id: &str,
        run_record: Value,
    ) -> Result<TaskJobResponse, TaskError> {
        self.finish_scheduled_run(job_id, false, Some(run_record))
            .await
    }

    async fn finish_scheduled_run(
        &self,
        job_id: &str,
        successful: bool,
        run_record: Option<Value>,
    ) -> Result<TaskJobResponse, TaskError> {
        let current = self.get_job(job_id).await?.job;
        let now = self.now();
        let (status, next_run_at) =
            next_state_after_scheduled_attempt(&current.schedule, now, successful)?;
        let mut target = current.target;
        if let Some(run_record) = run_record {
            append_run_record(&mut target, run_record);
        }
        sqlx::query(
            "UPDATE tasks SET status = ?, next_run_at = ?, target_json = ?, last_run_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(status)
        .bind(next_run_at)
        .bind(target.to_string())
        .bind(now)
        .bind(now)
        .bind(job_id)
        .execute(&self.pool)
        .await?;
        self.get_job(job_id).await
    }

    fn now(&self) -> i64 {
        (self.now_ms)()
    }
}

fn task_job_from_row(row: sqlx::sqlite::SqliteRow) -> Result<TaskJobSummary, TaskError> {
    Ok(TaskJobSummary {
        id: row.get("id"),
        kind: row.get("kind"),
        schedule: parse_json(row.get::<String, _>("schedule_json"))?,
        target: parse_json(row.get::<String, _>("target_json"))?,
        instructions: row.get("instructions"),
        status: row.get("status"),
        next_run_at: row.get("next_run_at"),
    })
}

fn parse_json(raw: String) -> Result<Value, TaskError> {
    serde_json::from_str(&raw).map_err(|error| TaskError::InvalidInput(error.to_string()))
}

fn clean_kind(kind: &str) -> String {
    let trimmed = kind.trim();
    if trimmed.is_empty() {
        "agent".to_string()
    } else {
        trimmed.to_string()
    }
}

fn validate_target(target: &Value) -> Result<(), TaskError> {
    if !target.is_object() {
        return Err(TaskError::InvalidInput("target must be an object".into()));
    }
    let has_bot = target
        .get("botId")
        .or_else(|| target.get("bot_id"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let has_conversation = target
        .get("conversationId")
        .or_else(|| target.get("conversation_id"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    if !has_bot {
        return Err(TaskError::InvalidInput("target.botId is required".into()));
    }
    if !has_conversation {
        return Err(TaskError::InvalidInput(
            "target.conversationId is required".into(),
        ));
    }
    Ok(())
}

fn target_string(target: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| target.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn validate_instructions(instructions: &str) -> Result<(), TaskError> {
    if instructions.trim().is_empty() {
        return Err(TaskError::InvalidInput("instructions are required".into()));
    }
    Ok(())
}

fn validate_status(status: &str) -> Result<(), TaskError> {
    match status {
        "active" | "paused" | "running" | "done" | "cancelled" => Ok(()),
        other => Err(TaskError::InvalidInput(format!("invalid status: {other}"))),
    }
}

fn next_state_after_scheduled_attempt(
    schedule: &Value,
    now: i64,
    successful: bool,
) -> Result<(String, Option<i64>), TaskError> {
    if schedule.get("type").and_then(Value::as_str) == Some("oneshot") {
        return Ok((if successful { "done" } else { "failed" }.to_string(), None));
    }
    Ok(("active".to_string(), compute_next_run(schedule, now)?))
}

fn append_run_record(target: &mut Value, run_record: Value) {
    if !target.is_object() {
        *target = json!({});
    }
    let object = target.as_object_mut().expect("target normalized to object");
    let runs = object.entry("runs").or_insert_with(|| json!([]));
    if !runs.is_array() {
        *runs = json!([]);
    }
    let runs = runs.as_array_mut().expect("runs normalized to array");
    runs.push(run_record);
    if runs.len() > 50 {
        runs.drain(..runs.len() - 50);
    }
}

fn normalize_schedule(input: &Value, now: i64) -> Result<Value, TaskError> {
    if let Some(text) = input.as_str() {
        return normalize_schedule_string(text, now);
    }
    let object = input
        .as_object()
        .ok_or_else(|| TaskError::InvalidSchedule("schedule must be a string or object".into()))?;
    let schedule_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    match schedule_type {
        "cron" => {
            let expr = object
                .get("cron")
                .or_else(|| object.get("expr"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            validate_cron_expression(expr)?;
            let timezone = object
                .get("timezone")
                .or_else(|| object.get("tz"))
                .and_then(Value::as_str)
                .unwrap_or("UTC")
                .trim();
            validate_timezone(timezone)?;
            Ok(json!({ "type": "cron", "cron": expr, "timezone": timezone }))
        }
        "oneshot" | "at" => {
            let at_ms = match object.get("atMs").and_then(Value::as_i64) {
                Some(value) => value,
                None => {
                    let text = object.get("at").and_then(Value::as_str).ok_or_else(|| {
                        TaskError::InvalidSchedule("oneshot at is required".into())
                    })?;
                    parse_iso_ms(text)?
                }
            };
            if at_ms <= now {
                return Err(TaskError::InvalidSchedule(
                    "oneshot schedule must be in the future".into(),
                ));
            }
            Ok(json!({ "type": "oneshot", "atMs": at_ms }))
        }
        "every" => {
            let every_ms = object
                .get("everyMs")
                .or_else(|| object.get("every_ms"))
                .and_then(Value::as_i64)
                .ok_or_else(|| TaskError::InvalidSchedule("everyMs is required".into()))?;
            if every_ms <= 0 {
                return Err(TaskError::InvalidSchedule(
                    "everyMs must be positive".into(),
                ));
            }
            Ok(json!({ "type": "every", "everyMs": every_ms }))
        }
        _ => Err(TaskError::InvalidSchedule(format!(
            "unknown schedule type: {schedule_type}"
        ))),
    }
}

fn normalize_create_schedule(
    schedule: Option<Value>,
    intent: Option<TaskScheduleIntent>,
    now: i64,
) -> Result<Value, TaskError> {
    if let Some(intent) = intent {
        return normalize_schedule_intent(&intent, now);
    }
    let schedule = schedule.ok_or_else(|| {
        TaskError::InvalidSchedule("schedule or scheduleIntent is required".into())
    })?;
    normalize_schedule(&schedule, now)
}

fn normalize_update_schedule(
    schedule: Option<Value>,
    intent: Option<TaskScheduleIntent>,
    current: Value,
    now: i64,
) -> Result<Value, TaskError> {
    if let Some(intent) = intent {
        return normalize_schedule_intent(&intent, now);
    }
    match schedule {
        Some(schedule) => normalize_schedule(&schedule, now),
        None => Ok(current),
    }
}

fn normalize_schedule_intent(intent: &TaskScheduleIntent, now: i64) -> Result<Value, TaskError> {
    if let Some(expression) = clean_optional(&intent.time_expression) {
        return normalize_schedule_string(&expression, now);
    }
    let kind = intent.kind.trim().to_ascii_lowercase();
    let timezone = clean_optional(&intent.timezone).unwrap_or_else(|| "UTC".to_string());
    validate_timezone(&timezone)?;
    match kind.as_str() {
        "oneshot" | "once" | "at" => {
            let date = clean_optional(&intent.date).ok_or_else(|| {
                TaskError::InvalidSchedule("scheduleIntent.date is required".into())
            })?;
            let time = clean_optional(&intent.time).ok_or_else(|| {
                TaskError::InvalidSchedule("scheduleIntent.time is required".into())
            })?;
            let at_ms = local_datetime_ms(&date, &time, &timezone)?;
            if at_ms <= now {
                return Err(TaskError::InvalidSchedule(
                    "oneshot schedule must be in the future".into(),
                ));
            }
            Ok(json!({ "type": "oneshot", "atMs": at_ms, "timezone": timezone }))
        }
        "daily" => {
            let (hour, minute) = intent_clock(&intent.time)?;
            Ok(
                json!({ "type": "cron", "cron": format!("{minute} {hour} * * *"), "timezone": timezone }),
            )
        }
        "weekly" => {
            let (hour, minute) = intent_clock(&intent.time)?;
            let weekday = intent.weekday.ok_or_else(|| {
                TaskError::InvalidSchedule("scheduleIntent.weekday is required".into())
            })?;
            if weekday > 6 {
                return Err(TaskError::InvalidSchedule(
                    "scheduleIntent.weekday must be 0..6".into(),
                ));
            }
            Ok(
                json!({ "type": "cron", "cron": format!("{minute} {hour} * * {weekday}"), "timezone": timezone }),
            )
        }
        "monthly" => {
            let (hour, minute) = intent_clock(&intent.time)?;
            let day = intent.day_of_month.ok_or_else(|| {
                TaskError::InvalidSchedule("scheduleIntent.dayOfMonth is required".into())
            })?;
            if !(1..=31).contains(&day) {
                return Err(TaskError::InvalidSchedule(
                    "scheduleIntent.dayOfMonth must be 1..31".into(),
                ));
            }
            Ok(
                json!({ "type": "cron", "cron": format!("{minute} {hour} {day} * *"), "timezone": timezone }),
            )
        }
        other => Err(TaskError::InvalidSchedule(format!(
            "unknown scheduleIntent kind: {other}"
        ))),
    }
}

fn clean_optional(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn intent_clock(value: &Option<String>) -> Result<(u32, u32), TaskError> {
    let text = clean_optional(value)
        .ok_or_else(|| TaskError::InvalidSchedule("scheduleIntent.time is required".into()))?;
    let time = parse_local_time(&text)?;
    Ok((time.hour(), time.minute()))
}

fn local_datetime_ms(date: &str, time: &str, timezone: &str) -> Result<i64, TaskError> {
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|error| {
        TaskError::InvalidSchedule(format!("invalid scheduleIntent.date: {error}"))
    })?;
    let time = parse_local_time(time)?;
    let tz = validate_timezone(timezone)?;
    let local = date.and_time(time);
    let at = tz.from_local_datetime(&local).single().ok_or_else(|| {
        TaskError::InvalidSchedule("scheduleIntent local time is invalid for timezone".into())
    })?;
    Ok(at.timestamp_millis())
}

fn parse_local_time(text: &str) -> Result<NaiveTime, TaskError> {
    NaiveTime::parse_from_str(text, "%H:%M")
        .or_else(|_| NaiveTime::parse_from_str(text, "%H:%M:%S"))
        .map_err(|error| {
            TaskError::InvalidSchedule(format!("invalid scheduleIntent.time: {error}"))
        })
}

fn normalize_schedule_string(text: &str, now: i64) -> Result<Value, TaskError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(TaskError::InvalidSchedule("schedule is required".into()));
    }
    if let Some(delay_ms) = parse_relative_delay_ms(trimmed) {
        return Ok(json!({ "type": "oneshot", "atMs": now + delay_ms }));
    }
    if validate_cron_expression(trimmed).is_ok() {
        return Ok(json!({ "type": "cron", "cron": trimmed, "timezone": "UTC" }));
    }
    let at_ms = parse_iso_ms(trimmed)?;
    if at_ms <= now {
        return Err(TaskError::InvalidSchedule(
            "oneshot schedule must be in the future".into(),
        ));
    }
    Ok(json!({ "type": "oneshot", "atMs": at_ms }))
}

fn compute_next_run(schedule: &Value, now: i64) -> Result<Option<i64>, TaskError> {
    match schedule.get("type").and_then(Value::as_str).unwrap_or("") {
        "oneshot" => Ok(schedule.get("atMs").and_then(Value::as_i64)),
        "every" => Ok(schedule
            .get("everyMs")
            .and_then(Value::as_i64)
            .map(|every_ms| now + every_ms)),
        "cron" => {
            let expr = schedule
                .get("cron")
                .and_then(Value::as_str)
                .ok_or_else(|| TaskError::InvalidSchedule("cron is required".into()))?;
            let timezone = schedule
                .get("timezone")
                .and_then(Value::as_str)
                .unwrap_or("UTC");
            compute_cron_next_run(expr, timezone, now).map(Some)
        }
        other => Err(TaskError::InvalidSchedule(format!(
            "unknown schedule type: {other}"
        ))),
    }
}

fn normalize_cron_expr(expr: &str) -> String {
    let trimmed = expr.trim();
    if trimmed.split_whitespace().count() == 5 {
        format!("0 {trimmed}")
    } else {
        trimmed.to_string()
    }
}

fn validate_cron_expression(expr: &str) -> Result<Schedule, TaskError> {
    let normalized = normalize_cron_expr(expr);
    Schedule::from_str(&normalized)
        .map_err(|error| TaskError::InvalidCron(format!("{expr}: {error}")))
}

fn validate_timezone(timezone: &str) -> Result<chrono_tz::Tz, TaskError> {
    timezone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| TaskError::InvalidTimezone(timezone.to_string()))
}

fn compute_cron_next_run(expr: &str, timezone: &str, now: i64) -> Result<i64, TaskError> {
    let schedule = validate_cron_expression(expr)?;
    let tz = validate_timezone(timezone)?;
    let now_dt = tz
        .timestamp_millis_opt(now)
        .single()
        .ok_or_else(|| TaskError::InvalidSchedule("invalid current timestamp".into()))?;
    let next = schedule
        .after(&now_dt)
        .next()
        .ok_or_else(|| TaskError::InvalidSchedule("cron schedule has no next run".into()))?;
    Ok(next.timestamp_millis())
}

fn parse_iso_ms(text: &str) -> Result<i64, TaskError> {
    OffsetDateTime::parse(text, &Rfc3339)
        .map(|value| value.unix_timestamp_nanos() / 1_000_000)
        .map(|value| value as i64)
        .map_err(|error| TaskError::InvalidSchedule(format!("invalid ISO-8601 timestamp: {error}")))
}

fn parse_relative_delay_ms(text: &str) -> Option<i64> {
    let lower = text.trim().to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let mut index = 0;
    if lower.starts_with("in ") {
        index = 3;
    }
    let start_digits = index;
    while index < chars.len() && chars[index].is_ascii_digit() {
        index += 1;
    }
    if index == start_digits {
        return None;
    }
    let amount = lower[start_digits..index].parse::<i64>().ok()?;
    if amount <= 0 {
        return None;
    }
    while index < chars.len() && chars[index].is_whitespace() {
        index += 1;
    }
    let unit_start = index;
    while index < chars.len() && !chars[index].is_whitespace() && chars[index] != '后' {
        index += 1;
    }
    let unit = &lower[unit_start..index];
    let multiplier = match unit {
        "s" | "sec" | "secs" | "second" | "seconds" | "秒" => 1_000,
        "m" | "min" | "mins" | "minute" | "minutes" | "分钟" => 60_000,
        "h" | "hr" | "hrs" | "hour" | "hours" | "小时" => 3_600_000,
        "d" | "day" | "days" | "天" => 86_400_000,
        _ => return None,
    };
    Some(amount * multiplier)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
