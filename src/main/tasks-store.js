// src/main/tasks-store.js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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
  if (!input.fellowId) throw new Error("fellowId is required");
  if (!input.sessionId) throw new Error("sessionId is required");
  if (!input.originMessageId) throw new Error("originMessageId is required");
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
    const task = {
      id: "t-" + crypto.randomBytes(8).toString("hex"),
      title: String(input.title || "未命名任务"),
      fellowId: String(input.fellowId),
      sessionId: String(input.sessionId),
      originMessageId: String(input.originMessageId),
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
      merged.trigger = { ...state.tasks[idx].trigger, ...partial.trigger };
      validateInput({ ...merged, prompt: merged.prompt });
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

  function orphanByFellow(fellowId) {
    const state = load();
    let changed = 0;
    state.tasks.forEach((t) => {
      if (t.fellowId === fellowId && t.status !== "done") {
        t.status = "paused";
        t.orphanReason = "fellow_deleted";
        t.updatedAt = Date.now();
        changed += 1;
      }
    });
    if (changed) save(state);
    return changed;
  }

  // Called by the renderer's session-delete flow when that handler exists.
  // As of v1, mia only supports deleting a fellow (which deletes its
  // session bucket as a unit) — that path uses orphanByFellow above.
  // Kept for the future per-session delete flow.
  function orphanBySession(sessionId) {
    const state = load();
    let changed = 0;
    state.tasks.forEach((t) => {
      if (t.sessionId === sessionId && t.status !== "done") {
        t.status = "paused";
        t.orphanReason = "session_deleted";
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
      error: run.error
    };
    task.runs.push(runEntry);
    task.updatedAt = Date.now();
    save(state);
    return runEntry;
  }

  return { list, get, create, update, delete: deleteTask, pause, resume, orphanByFellow, orphanBySession, recordRun };
}

module.exports = { createTasksStore };
