// src/main/tasks-store.js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { taskConversationFields } = require("./task-conversation.js");

function atomicWrite(filePath, content) {
  const tmp = filePath + ".tmp." + crypto.randomBytes(6).toString("hex");
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw e;
  }
}

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

function validateInput(input) {
  if (!input || typeof input !== "object") throw new Error("task input must be an object");
  if (!input.botId) throw new Error("botId is required");
  if (!input.conversationId && !input.sessionId) throw new Error("conversationId is required");
  // originMessageId is optional provenance metadata (which user message
  // prompted the task). It is stored but never consumed for delivery or
  // orphaning, so a missing message id must not block task creation — engines
  // legitimately pass "" when the originating message has no id.
  if (!input.prompt) throw new Error("prompt is required");
  if (!input.trigger || !input.trigger.type) throw new Error("trigger.type is required");
  if (input.trigger.type === "event") {
    throw new Error("event-triggered tasks are not supported in v1");
  }
  if (input.trigger.type === "cron") {
    if (!input.trigger.cron) throw new Error("trigger.cron is required for type=cron");
    try {
      require("cron-parser").parseExpression(input.trigger.cron);
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
  // Timezone (optional, defaults to UTC)
  if (input.timezone) {
    try {
      // Intl.DateTimeFormat throws on invalid IANA tz names
      new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
    } catch {
      throw new Error(`invalid timezone: ${input.timezone}`);
    }
  }
}

function createTasksStore(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function load() {
    return readJSON(filePath, { tasks: [] });
  }

  function save(state) {
    atomicWrite(filePath, JSON.stringify(state, null, 2) + "\n");
  }

  function list() {
    return load().tasks;
  }

  function get(id) {
    return load().tasks.find((t) => t.id === id) || null;
  }

  function create(input) {
    validateInput(input);
    const now = Date.now();
    const { conversationId, sessionId } = taskConversationFields(input);
    const task = {
      id: "t-" + crypto.randomBytes(8).toString("hex"),
      title: String(input.title || "未命名任务"),
      botId: String(input.botId),
      conversationId,
      sessionId,
      originMessageId: String(input.originMessageId || ""),
      trigger: { ...input.trigger },
      timezone: String(input.timezone || "UTC"),
      prompt: String(input.prompt),
      status: "active",
      runs: [],
      createdAt: now,
      updatedAt: now
    };
    const state = load();
    state.tasks.push(task);
    save(state);
    return task;
  }

  function update(id, partial) {
    const state = load();
    const idx = state.tasks.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error("task not found: " + id);
    const merged = {
      ...state.tasks[idx],
      ...partial,
      id: state.tasks[idx].id,
      runs: state.tasks[idx].runs,
      createdAt: state.tasks[idx].createdAt,
      updatedAt: Date.now()
    };
    if (partial.trigger) {
      const oldTrigger = state.tasks[idx].trigger;
      // When type changes, replace wholesale so stale fields (e.g. cron) don't
      // linger on a now-oneshot trigger and pollute exports/migrations.
      merged.trigger = partial.trigger.type && partial.trigger.type !== oldTrigger.type
        ? { ...partial.trigger }
        : { ...oldTrigger, ...partial.trigger };
      validateInput(merged);
    }
    state.tasks[idx] = merged;
    save(state);
    return merged;
  }

  function deleteTask(id) {
    const state = load();
    state.tasks = state.tasks.filter((t) => t.id !== id);
    save(state);
  }

  function pause(id) { return update(id, { status: "paused" }); }
  function resume(id) { return update(id, { status: "active" }); }

  function orphanByBot(botId) {
    const state = load();
    let changed = 0;
    state.tasks.forEach((t) => {
      if (t.botId === botId && t.status !== "done") {
        t.status = "paused";
        t.orphanReason = "bot_deleted";
        t.updatedAt = Date.now();
        changed += 1;
      }
    });
    if (changed) save(state);
    return changed;
  }

  function recordRun(id, run) {
    const state = load();
    const task = state.tasks.find((t) => t.id === id);
    if (!task) throw new Error("task not found: " + id);
    const runEntry = {
      id: run.id || ("r-" + crypto.randomBytes(6).toString("hex")),
      firedAt: run.firedAt,
      finishedAt: run.finishedAt || null,
      status: run.status,
      outputMessageId: run.outputMessageId || null,
      outputText: run.outputText || "",
      error: run.error
    };
    if (run.status === "missed") {
      runEntry.missedCount = run.missedCount;
      runEntry.firstMissedAt = run.firstMissedAt;
      runEntry.lastMissedAt = run.lastMissedAt;
    }
    task.runs.push(runEntry);
    task.updatedAt = Date.now();
    save(state);
    return runEntry;
  }

  return { list, get, create, update, delete: deleteTask, pause, resume, orphanByBot, recordRun };
}

module.exports = { createTasksStore };
