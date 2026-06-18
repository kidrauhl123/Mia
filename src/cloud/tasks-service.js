"use strict";

const crypto = require("node:crypto");

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function runtimeTargetDeviceId(config = {}) {
  return String(
    config.deviceId
      || config.device_id
      || config.targetDeviceId
      || config.target_device_id
      || ""
  ).trim();
}

function runtimeSnapshot(context, userId, botId) {
  const active = context.runtimeBindingsStore?.getActiveBinding?.(userId, botId) || null;
  const fallback = active
    || context.runtimeBindingsStore?.getEnabledBinding?.(userId, botId, "cloud-hermes")
    || context.runtimeBindingsStore?.getEnabledBinding?.(userId, botId, "desktop-local")
    || null;
  const runtimeKind = String(fallback?.runtimeKind || "cloud-hermes").trim() || "cloud-hermes";
  const config = fallback?.config && typeof fallback.config === "object" ? fallback.config : {};
  return {
    runtimeKind,
    config,
    targetDeviceId: runtimeKind === "desktop-local" ? runtimeTargetDeviceId(config) : ""
  };
}

function taskRuntimeBinding(task = {}) {
  const runtimeKind = String(task.runtimeKind || "").trim();
  if (!runtimeKind) return null;
  const config = task.runtimeConfig && typeof task.runtimeConfig === "object" ? task.runtimeConfig : {};
  return {
    userId: task.userId,
    botId: task.botId,
    runtimeKind,
    enabled: true,
    config: runtimeKind === "desktop-local"
      ? { ...config, deviceId: task.targetDeviceId || runtimeTargetDeviceId(config) }
      : config
  };
}

function userIsMemberOfConversation(socialStore, conversationId, userId) {
  return Boolean(socialStore?.getConversationMember?.(conversationId, "user", userId));
}

function createCloudTasksService(context, options = {}) {
  const tasksStore = context.cloudTasksStore;
  const nowMs = options.nowMs || (() => Date.now());
  const logger = options.logger || console;
  const setTimeoutImpl = options.setTimeout || setTimeout;
  const clearTimeoutImpl = options.clearTimeout || clearTimeout;
  const randomUUID = options.randomUUID || (() => crypto.randomUUID());
  const inflight = new Set();
  let timer = null;
  let stopped = true;

  function emitTask(userId, type, payload = {}) {
    context.broadcastPersistedEvent(userId, {
      type: `task.${type}`,
      ...payload
    });
  }

  function assertTaskOwnership(userId, input = {}) {
    const botId = String(input.botId || "").trim();
    if (!botId) throw new Error("botId is required");
    const bot = context.botsStore.getBot(botId);
    if (!bot) throw new Error("bot not found");
    if (String(bot.ownerUserId || "") !== String(userId || "")) {
      throw new Error("you can only schedule your own bots");
    }
    const conversationId = String(input.conversationId || input.sessionId || "").trim().replace(/^conversation:/, "");
    if (!conversationId) throw new Error("conversationId is required");
    if (!context.socialStore.getConversation(conversationId)) throw new Error("conversation not found");
    if (!userIsMemberOfConversation(context.socialStore, conversationId, userId)) {
      throw new Error("not a member of this conversation");
    }
  }

  function list(userId) {
    return tasksStore.list(userId);
  }

  function get(userId, taskId) {
    return tasksStore.get(userId, taskId);
  }

  function create(userId, input = {}) {
    assertTaskOwnership(userId, input);
    const snapshot = runtimeSnapshot(context, userId, String(input.botId || ""));
    const task = tasksStore.create(userId, input, snapshot);
    emitTask(userId, "created", { taskId: task.id, task });
    rescan();
    return task;
  }

  function update(userId, taskId, partial = {}) {
    const current = tasksStore.get(userId, taskId);
    if (!current) throw new Error("task not found");
    const candidate = { ...current, ...partial };
    assertTaskOwnership(userId, candidate);
    const runtime = Object.prototype.hasOwnProperty.call(partial, "botId")
      ? runtimeSnapshot(context, userId, String(candidate.botId || ""))
      : null;
    const task = tasksStore.update(userId, taskId, partial, runtime);
    emitTask(userId, "updated", { taskId: task.id, task });
    rescan();
    return task;
  }

  function remove(userId, taskId) {
    const ok = tasksStore.delete(userId, taskId);
    if (!ok) throw new Error("task not found");
    emitTask(userId, "deleted", { taskId });
    rescan();
    return { ok: true };
  }

  function pause(userId, taskId) {
    const task = tasksStore.pause(userId, taskId);
    emitTask(userId, "updated", { taskId: task.id, task });
    rescan();
    return task;
  }

  function resume(userId, taskId) {
    const task = tasksStore.resume(userId, taskId);
    emitTask(userId, "updated", { taskId: task.id, task });
    rescan();
    return task;
  }

  function finalizeTaskRun(task, run, eventType, options = {}) {
    const saved = tasksStore.recordRun(task.userId, task.id, run);
    let updatedTask = null;
    if (task.trigger?.type === "oneshot" && eventType === "finished") {
      updatedTask = tasksStore.setStatus(task.userId, task.id, "done");
    } else if (task.trigger?.type === "oneshot" && eventType === "failed") {
      updatedTask = tasksStore.setStatus(task.userId, task.id, "failed");
    } else if (options.advanceSchedule) {
      updatedTask = tasksStore.advanceNextFire(task.userId, task.id, run.firedAt || nowMs());
    } else {
      updatedTask = tasksStore.get(task.userId, task.id);
    }
    emitTask(task.userId, eventType, { taskId: task.id, runId: saved.id, run: saved, task: updatedTask });
    return saved;
  }

  async function fire(task, options = {}) {
    if (!task?.id || inflight.has(task.id)) {
      if (task?.id) {
        return finalizeTaskRun(task, {
          firedAt: nowMs(),
          finishedAt: nowMs(),
          status: "skipped",
          error: "previous run still in progress"
        }, "skipped", { advanceSchedule: options.advanceSchedule });
      }
      return null;
    }
    inflight.add(task.id);
    const runId = `r-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const firedAt = nowMs();
    emitTask(task.userId, "started", { taskId: task.id, runId, firedAt });
    try {
      const conversation = context.socialStore.getConversation(task.conversationId);
      if (!conversation) throw new Error("conversation not found");
      if (!userIsMemberOfConversation(context.socialStore, task.conversationId, task.userId)) {
        throw new Error("not a member of this conversation");
      }
      const message = {
        id: `task:${task.id}:${runId}`,
        conversation_id: task.conversationId,
        sender_kind: "system",
        sender_ref: "mia.scheduler",
        body_md: "",
        task_prompt: task.prompt,
        turn_id: `task:${task.id}:${runId}`,
        status: "complete"
      };
      if (!context.cloudAgentDispatcher?.invokeBot) {
        throw new Error("cloud agent dispatcher is not enabled");
      }
      const reply = await context.cloudAgentDispatcher.invokeBot({
        userId: task.userId,
        botId: task.botId,
        conversationId: task.conversationId,
        message,
        runtimeBinding: taskRuntimeBinding(task)
      });
      const run = finalizeTaskRun(task, {
        id: runId,
        firedAt,
        finishedAt: nowMs(),
        status: "ok",
        outputMessageId: reply?.id || null,
        outputText: reply?.body_md || (task.runtimeKind === "desktop-local" ? "任务已发送到运行设备，回复会出现在对话里。" : "")
      }, "finished", { advanceSchedule: options.advanceSchedule });
      if (options.rescan !== false) rescan();
      return run;
    } catch (error) {
      logger.warn?.("[cloud-tasks] task fire failed", task.id, error?.message || error);
      const run = finalizeTaskRun(task, {
        id: runId,
        firedAt,
        finishedAt: nowMs(),
        status: "failed",
        error: String(error?.message || error)
      }, "failed", { advanceSchedule: options.advanceSchedule });
      if (options.rescan !== false) rescan();
      return run;
    } finally {
      inflight.delete(task.id);
    }
  }

  async function runNow(userId, taskId) {
    const task = tasksStore.get(userId, taskId);
    if (!task) throw new Error("task not found");
    const run = await fire(task);
    return { runId: run?.id || "" };
  }

  async function fireDue() {
    const due = tasksStore.dueTasks(nowMs());
    for (const task of due) {
      await fire(task, { rescan: false, advanceSchedule: true });
    }
    rescan();
  }

  function rescan() {
    if (stopped) return;
    if (timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    const next = tasksStore.nextDueTime(nowMs());
    if (next == null) return;
    const delay = Math.max(0, next - nowMs());
    timer = setTimeoutImpl(() => {
      timer = null;
      fireDue().catch((error) => logger.warn?.("[cloud-tasks] scheduler failed", error?.message || error));
    }, Math.min(delay, 2_147_483_000));
    if (timer?.unref) timer.unref();
  }

  function start() {
    stopped = false;
    rescan();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeoutImpl(timer);
    timer = null;
  }

  return {
    list,
    get,
    create,
    update,
    delete: remove,
    pause,
    resume,
    runNow,
    fire,
    fireDue,
    start,
    stop,
    rescan,
    _runtimeSnapshot: runtimeSnapshot,
    _taskRuntimeBinding: taskRuntimeBinding,
    _parseJson: parseJson
  };
}

module.exports = {
  createCloudTasksService,
  runtimeSnapshot,
  taskRuntimeBinding
};
