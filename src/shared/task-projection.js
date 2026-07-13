"use strict";

const TASK_SOURCE_LOCAL = "local-core";
const TASK_SOURCE_CLOUD = "mia-cloud";

function taskSourceFor(taskOrSource) {
  if (typeof taskOrSource === "string") {
    if (taskOrSource === TASK_SOURCE_CLOUD || taskOrSource === TASK_SOURCE_LOCAL) return taskOrSource;
    return taskOrSource.startsWith("t-") ? TASK_SOURCE_CLOUD : TASK_SOURCE_LOCAL;
  }
  const task = taskOrSource && typeof taskOrSource === "object" ? taskOrSource : {};
  const explicit = String(task.taskSource || "").trim();
  if (explicit === TASK_SOURCE_CLOUD || explicit === TASK_SOURCE_LOCAL) return explicit;
  return String(task.id || "").startsWith("t-") ? TASK_SOURCE_CLOUD : TASK_SOURCE_LOCAL;
}

function projectTask(task, source) {
  const input = task && typeof task === "object" ? task : {};
  return {
    ...input,
    runs: Array.isArray(input.runs) ? input.runs : [],
    taskSource: source
  };
}

function mergeTaskProjections(localTasks = [], cloudTasks = []) {
  const merged = new Map();
  for (const task of Array.isArray(localTasks) ? localTasks : []) {
    const projected = projectTask(task, TASK_SOURCE_LOCAL);
    if (projected.id) merged.set(projected.id, projected);
  }
  for (const task of Array.isArray(cloudTasks) ? cloudTasks : []) {
    const projected = projectTask(task, TASK_SOURCE_CLOUD);
    if (projected.id) merged.set(projected.id, projected);
  }
  return [...merged.values()];
}

module.exports = {
  TASK_SOURCE_CLOUD,
  TASK_SOURCE_LOCAL,
  mergeTaskProjections,
  taskSourceFor
};
