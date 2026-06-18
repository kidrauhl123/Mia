"use strict";

const FORBIDDEN_SCHEDULER_TOOL_NAMES = Object.freeze(["cronjob"]);

function schedulerDisallowedTools() {
  return [...FORBIDDEN_SCHEDULER_TOOL_NAMES];
}

function isForbiddenSchedulerToolName(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  return text
    .split(/[^a-z0-9_-]+/)
    .filter(Boolean)
    .some((part) => part === "cronjob");
}

module.exports = {
  FORBIDDEN_SCHEDULER_TOOL_NAMES,
  isForbiddenSchedulerToolName,
  schedulerDisallowedTools
};
