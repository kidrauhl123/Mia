"use strict";

const crypto = require("node:crypto");
const cronParser = require("cron-parser");

function nowMs() {
  return Date.now();
}

function randomId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function validateTaskInput(input) {
  if (!input || typeof input !== "object") throw new Error("task input must be an object");
  if (!input.botId) throw new Error("botId is required");
  if (!input.conversationId && !input.sessionId) throw new Error("conversationId is required");
  if (!input.prompt) throw new Error("prompt is required");
  if (!input.trigger || !input.trigger.type) throw new Error("trigger.type is required");
  if (input.trigger.type === "event") throw new Error("event-triggered tasks are not supported in v1");
  if (input.trigger.type === "cron") {
    if (!input.trigger.cron) throw new Error("trigger.cron is required for type=cron");
    try {
      cronParser.parseExpression(input.trigger.cron);
    } catch {
      throw new Error("trigger.cron is not a valid cron expression");
    }
  }
  if (input.trigger.type === "oneshot") {
    if (!input.trigger.at) throw new Error("trigger.at is required for type=oneshot");
    if (Number.isNaN(new Date(input.trigger.at).getTime())) {
      throw new Error("trigger.at is not a valid ISO-8601 timestamp");
    }
  }
  if (input.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
    } catch {
      throw new Error(`invalid timezone: ${input.timezone}`);
    }
  }
}

function normalizeConversationId(value) {
  const text = String(value || "").trim();
  return text.startsWith("conversation:") ? text.slice("conversation:".length) : text;
}

function taskConversationFields(input = {}) {
  const rawConversationId = String(input.conversationId || "").trim();
  const rawSessionId = String(input.sessionId || "").trim();
  const source = rawConversationId || rawSessionId;
  return {
    conversationId: normalizeConversationId(source),
    sessionId: rawSessionId || source
  };
}

function computeNextFire(trigger, timezone, now = nowMs()) {
  if (!trigger) return null;
  if (trigger.type === "cron") {
    try {
      const it = cronParser.parseExpression(trigger.cron, {
        currentDate: new Date(now),
        tz: timezone
      });
      return it.next().getTime();
    } catch {
      return null;
    }
  }
  if (trigger.type === "oneshot") {
    const at = new Date(trigger.at).getTime();
    if (Number.isNaN(at) || at <= now) return null;
    return at;
  }
  return null;
}

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    firedAt: Number(row.fired_at) || 0,
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    status: row.status,
    outputMessageId: row.output_message_id || null,
    outputText: row.output_text || "",
    error: row.error || "",
    missedCount: Number(row.missed_count) || 0,
    firstMissedAt: row.first_missed_at == null ? null : Number(row.first_missed_at),
    lastMissedAt: row.last_missed_at == null ? null : Number(row.last_missed_at)
  };
}

function rowToTask(row, runs = [], nextFireNow = nowMs()) {
  if (!row) return null;
  const trigger = parseJson(row.trigger_json, {});
  const timezone = row.timezone || "UTC";
  const storedNextFire = row.next_fire_at == null ? null : Number(row.next_fire_at);
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title || "未命名任务",
    botId: row.bot_id,
    conversationId: row.conversation_id,
    sessionId: row.session_id || row.conversation_id,
    originMessageId: row.origin_message_id || "",
    trigger,
    timezone,
    prompt: row.prompt || "",
    status: row.status || "active",
    runtimeKind: row.runtime_kind || "",
    runtimeConfig: parseJson(row.runtime_config_json, {}),
    targetDeviceId: row.target_device_id || "",
    runs,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    nextFireAt: Number.isFinite(storedNextFire) ? storedNextFire : null
  };
}

function createCloudTasksStore(db, options = {}) {
  const idFactory = options.idFactory || randomId;
  const now = options.nowMs || nowMs;

  const taskColumns = `
    id, user_id, title, bot_id, conversation_id, session_id, origin_message_id,
    trigger_json, timezone, prompt, status, runtime_kind, runtime_config_json,
    target_device_id, next_fire_at, created_at, updated_at
  `;
  const runColumns = `
    id, task_id, user_id, fired_at, finished_at, status, output_message_id,
    output_text, error, missed_count, first_missed_at, last_missed_at
  `;
  const selectTask = db.prepare(`SELECT ${taskColumns} FROM scheduled_tasks WHERE user_id = ? AND id = ?`);
  const selectAllTasks = db.prepare(`SELECT ${taskColumns} FROM scheduled_tasks WHERE user_id = ? ORDER BY updated_at DESC`);
  const selectDueFireable = db.prepare(`SELECT ${taskColumns} FROM scheduled_tasks WHERE status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at ASC`);
  const selectNextDue = db.prepare("SELECT MIN(next_fire_at) AS nextFireAt FROM scheduled_tasks WHERE status = 'active' AND next_fire_at IS NOT NULL");
  const selectRuns = db.prepare(`SELECT ${runColumns} FROM scheduled_task_runs WHERE task_id = ? ORDER BY fired_at ASC`);
  const insertTask = db.prepare(`
    INSERT INTO scheduled_tasks (
      ${taskColumns}
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateTask = db.prepare(`
    UPDATE scheduled_tasks SET
      title = ?, bot_id = ?, conversation_id = ?, session_id = ?, origin_message_id = ?,
      trigger_json = ?, timezone = ?, prompt = ?, status = ?, runtime_kind = ?,
      runtime_config_json = ?, target_device_id = ?, next_fire_at = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
  `);
  const updateTaskNextFire = db.prepare("UPDATE scheduled_tasks SET next_fire_at = ?, updated_at = ? WHERE user_id = ? AND id = ?");
  const touchTask = db.prepare("UPDATE scheduled_tasks SET updated_at = ? WHERE user_id = ? AND id = ?");
  const deleteTask = db.prepare("DELETE FROM scheduled_tasks WHERE user_id = ? AND id = ?");
  const insertRun = db.prepare(`
    INSERT INTO scheduled_task_runs (
      ${runColumns}
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function runsFor(taskId) {
    return selectRuns.all(String(taskId)).map(rowToRun);
  }

  function hydrate(row, nextFireNow = now()) {
    return rowToTask(row, runsFor(row.id), nextFireNow);
  }

  function list(userId) {
    const at = now();
    return selectAllTasks.all(String(userId)).map((row) => hydrate(row, at));
  }

  function get(userId, taskId) {
    const row = selectTask.get(String(userId), String(taskId));
    return row ? hydrate(row) : null;
  }

  function activeNextFire(task, at = now()) {
    if (!task || String(task.status || "active") !== "active") return null;
    return computeNextFire(task.trigger, task.timezone, at);
  }

  function create(userId, input = {}, runtime = {}) {
    validateTaskInput(input);
    const timestamp = now();
    const { conversationId, sessionId } = taskConversationFields(input);
    const task = {
      id: idFactory("t"),
      userId: String(userId),
      title: String(input.title || "未命名任务"),
      botId: String(input.botId),
      conversationId,
      sessionId,
      originMessageId: String(input.originMessageId || ""),
      trigger: { ...input.trigger },
      timezone: String(input.timezone || "UTC"),
      prompt: String(input.prompt),
      status: "active",
      runtimeKind: String(runtime.runtimeKind || ""),
      runtimeConfig: runtime.config && typeof runtime.config === "object" ? runtime.config : {},
      targetDeviceId: String(runtime.targetDeviceId || ""),
      nextFireAt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    task.nextFireAt = activeNextFire(task, timestamp);
    insertTask.run(
      task.id,
      task.userId,
      task.title,
      task.botId,
      task.conversationId,
      task.sessionId,
      task.originMessageId,
      JSON.stringify(task.trigger),
      task.timezone,
      task.prompt,
      task.status,
      task.runtimeKind,
      JSON.stringify(task.runtimeConfig),
      task.targetDeviceId,
      task.nextFireAt,
      task.createdAt,
      task.updatedAt
    );
    return get(task.userId, task.id);
  }

  function update(userId, taskId, partial = {}, runtime = null) {
    const current = get(userId, taskId);
    if (!current) throw new Error("task not found");
    const merged = {
      ...current,
      ...partial,
      id: current.id,
      userId: current.userId,
      runs: current.runs,
      createdAt: current.createdAt,
      updatedAt: now()
    };
    if (partial.trigger) {
      const oldTrigger = current.trigger || {};
      merged.trigger = partial.trigger.type && partial.trigger.type !== oldTrigger.type
        ? { ...partial.trigger }
        : { ...oldTrigger, ...partial.trigger };
    }
    if (runtime && typeof runtime === "object") {
      merged.runtimeKind = String(runtime.runtimeKind || merged.runtimeKind || "");
      merged.runtimeConfig = runtime.config && typeof runtime.config === "object" ? runtime.config : {};
      merged.targetDeviceId = String(runtime.targetDeviceId || "");
    }
    validateTaskInput(merged);
    const fields = taskConversationFields(merged);
    merged.conversationId = fields.conversationId;
    merged.sessionId = fields.sessionId;
    merged.nextFireAt = activeNextFire(merged, merged.updatedAt);
    updateTask.run(
      String(merged.title || "未命名任务"),
      String(merged.botId),
      String(merged.conversationId),
      String(merged.sessionId),
      String(merged.originMessageId || ""),
      JSON.stringify(merged.trigger || {}),
      String(merged.timezone || "UTC"),
      String(merged.prompt || ""),
      String(merged.status || "active"),
      String(merged.runtimeKind || ""),
      JSON.stringify(merged.runtimeConfig || {}),
      String(merged.targetDeviceId || ""),
      merged.nextFireAt,
      merged.updatedAt,
      String(userId),
      String(taskId)
    );
    return get(userId, taskId);
  }

  function setStatus(userId, taskId, status) {
    return update(userId, taskId, { status: String(status || "active") });
  }

  function advanceNextFire(userId, taskId, after = now()) {
    const task = get(userId, taskId);
    if (!task) throw new Error("task not found");
    const nextFireAt = activeNextFire(task, Number(after) + 1000);
    updateTaskNextFire.run(nextFireAt, now(), String(userId), String(taskId));
    return get(userId, taskId);
  }

  function remove(userId, taskId) {
    return deleteTask.run(String(userId), String(taskId)).changes > 0;
  }

  function recordRun(userId, taskId, run = {}) {
    const task = get(userId, taskId);
    if (!task) throw new Error("task not found");
    const runId = String(run.id || idFactory("r"));
    const firedAt = Number(run.firedAt) || now();
    const finishedAt = Object.prototype.hasOwnProperty.call(run, "finishedAt")
      ? (run.finishedAt == null ? null : Number(run.finishedAt))
      : now();
    insertRun.run(
      runId,
      String(taskId),
      String(userId),
      firedAt,
      finishedAt,
      String(run.status || "ok"),
      run.outputMessageId ? String(run.outputMessageId) : null,
      String(run.outputText || ""),
      String(run.error || ""),
      Number(run.missedCount) || 0,
      run.firstMissedAt == null ? null : Number(run.firstMissedAt),
      run.lastMissedAt == null ? null : Number(run.lastMissedAt)
    );
    touchTask.run(now(), String(userId), String(taskId));
    return rowToRun(db.prepare(`SELECT ${runColumns} FROM scheduled_task_runs WHERE id = ?`).get(runId));
  }

  function dueTasks(at = now()) {
    return selectDueFireable.all(Number(at)).map((row) => hydrate(row, at));
  }

  function nextDueTime() {
    const row = selectNextDue.get();
    const next = row?.nextFireAt == null ? null : Number(row.nextFireAt);
    return Number.isFinite(next) ? next : null;
  }

  return {
    list,
    get,
    create,
    update,
    delete: remove,
    pause: (userId, taskId) => setStatus(userId, taskId, "paused"),
    resume: (userId, taskId) => setStatus(userId, taskId, "active"),
    setStatus,
    advanceNextFire,
    recordRun,
    dueTasks,
    nextDueTime,
    computeNextFire
  };
}

module.exports = {
  computeNextFire,
  createCloudTasksStore,
  validateTaskInput
};
