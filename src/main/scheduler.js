// src/main/scheduler.js
const cronParser = require("cron-parser");

function computeNextFire(trigger, timezone, nowMs) {
  if (!trigger) return null;
  if (trigger.type === "cron") {
    try {
      const it = cronParser.parseExpression(trigger.cron, {
        currentDate: new Date(nowMs),
        tz: timezone
      });
      return it.next().getTime();
    } catch {
      return null;
    }
  }
  if (trigger.type === "oneshot") {
    const at = new Date(trigger.at).getTime();
    if (Number.isNaN(at) || at <= nowMs) return null;
    return at;
  }
  return null;
}

function isFireable(task) {
  return task && task.status === "active";
}

const MISSED_SWEEP_CAP = 100000;

function sweepMissedCronTasks(store, nowMs = Date.now(), emit) {
  for (const task of store.list()) {
    if (task.status !== "active" || task.trigger?.type !== "cron") continue;
    const lastFireAt = task.runs.length ? task.runs[task.runs.length - 1].firedAt : 0;
    const baseline = Math.max(task.updatedAt || 0, lastFireAt);
    if (baseline >= nowMs) continue;
    let it;
    try {
      it = cronParser.parseExpression(task.trigger.cron, {
        currentDate: new Date(baseline),
        endDate: new Date(nowMs),
        tz: task.timezone
      });
    } catch { continue; }
    let count = 0;
    let firstMissed = null;
    let lastMissed = null;
    while (count < MISSED_SWEEP_CAP) {
      let next;
      try { next = it.next(); } catch { break; }
      const t = next.getTime();
      if (t > nowMs) break;
      if (firstMissed === null) firstMissed = t;
      lastMissed = t;
      count += 1;
    }
    if (count > 0) {
      const run = store.recordRun(task.id, {
        firedAt: lastMissed,
        finishedAt: nowMs,
        status: "missed",
        missedCount: count,
        firstMissedAt: firstMissed,
        lastMissedAt: lastMissed,
        error: `daemon offline: missed ${count} scheduled fire${count > 1 ? "s" : ""}`
      });
      if (typeof emit === "function") {
        emit("missed", {
          taskId: task.id,
          runId: run?.id,
          missedCount: count,
          firstMissedAt: firstMissed,
          lastMissedAt: lastMissed
        });
      }
    }
  }
}

function createScheduler({ store, onFire, logger = console }) {
  let timer = null;
  let stopped = true;

  function fireableTasks(now) {
    return store.list()
      .filter(isFireable)
      .map((task) => ({ task, nextFire: computeNextFire(task.trigger, task.timezone, now) }))
      .filter(({ nextFire }) => nextFire !== null)
      .sort((a, b) => a.nextFire - b.nextFire);
  }

  function schedule() {
    if (stopped) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const now = Date.now();
    const queue = fireableTasks(now);
    if (queue.length === 0) return;
    const next = queue[0];
    const delay = Math.max(0, next.nextFire - now);
    timer = setTimeout(() => fireAndReschedule(next.task.id), Math.min(delay, 2_147_483_000));
  }

  async function fireAndReschedule(taskId) {
    timer = null;
    const task = store.get(taskId);
    if (!task || !isFireable(task)) { schedule(); return; }
    try {
      await onFire(task);
    } catch (e) {
      logger.error?.("[scheduler] onFire failed", e);
    } finally {
      // For oneshot tasks, mark as done/failed after the fire completes
      const after = store.get(taskId);
      if (after && after.trigger.type === "oneshot") {
        const lastRun = after.runs[after.runs.length - 1];
        if (lastRun && lastRun.status === "ok") {
          store.update(taskId, { status: "done" });
        } else if (lastRun && lastRun.status === "failed") {
          store.update(taskId, { status: "failed" });
        }
      }
      schedule();
    }
  }

  function start() { stopped = false; schedule(); }
  function stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } }
  function rescan() { schedule(); }

  return { start, stop, rescan, _fireableTasks: fireableTasks };
}

module.exports = { computeNextFire, isFireable, createScheduler, sweepMissedCronTasks };
