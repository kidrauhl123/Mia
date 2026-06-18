"use strict";

const cronParser = require("cron-parser");

const RELATIVE_UNITS = new Map([
  ["s", 1000],
  ["sec", 1000],
  ["secs", 1000],
  ["second", 1000],
  ["seconds", 1000],
  ["秒", 1000],
  ["m", 60_000],
  ["min", 60_000],
  ["mins", 60_000],
  ["minute", 60_000],
  ["minutes", 60_000],
  ["分钟", 60_000],
  ["h", 3_600_000],
  ["hr", 3_600_000],
  ["hrs", 3_600_000],
  ["hour", 3_600_000],
  ["hours", 3_600_000],
  ["小时", 3_600_000],
  ["d", 86_400_000],
  ["day", 86_400_000],
  ["days", 86_400_000],
  ["天", 86_400_000]
]);

function nowMs(options = {}) {
  const value = Number(options.nowMs);
  return Number.isFinite(value) ? value : Date.now();
}

function parseRelativeDelay(expression) {
  const text = String(expression || "").trim().toLowerCase();
  const match = text.match(/^(?:in\s+)?([1-9]\d*)\s*([a-z]+|秒|分钟|小时|天)\s*(?:后)?$/u);
  if (!match) return null;
  const amount = Number(match[1]);
  const unitMs = RELATIVE_UNITS.get(match[2]);
  if (!Number.isFinite(amount) || !unitMs) return null;
  return amount * unitMs;
}

function isCronExpression(expression) {
  const text = String(expression || "").trim();
  if (!text) return false;
  try {
    cronParser.parseExpression(text);
    return true;
  } catch {
    return false;
  }
}

function triggerFromScheduleExpression(expression, options = {}) {
  const text = String(expression || "").trim();
  if (!text) throw new Error("schedule is required");

  const delayMs = parseRelativeDelay(text);
  if (delayMs != null) {
    return {
      type: "oneshot",
      at: new Date(nowMs(options) + delayMs).toISOString()
    };
  }

  if (isCronExpression(text)) {
    return { type: "cron", cron: text };
  }

  const absoluteMs = new Date(text).getTime();
  if (!Number.isNaN(absoluteMs)) {
    return { type: "oneshot", at: text };
  }

  throw new Error("schedule must be a relative delay like '1m', a cron expression, or an ISO-8601 timestamp");
}

function normalizeScheduledTaskInput(input = {}, options = {}) {
  if (!input || typeof input !== "object") return input;
  if (!Object.prototype.hasOwnProperty.call(input, "schedule")) return input;
  const schedule = String(input.schedule || "").trim();
  const { schedule: _schedule, ...rest } = input;
  return {
    ...rest,
    trigger: triggerFromScheduleExpression(schedule, options)
  };
}

module.exports = {
  normalizeScheduledTaskInput,
  triggerFromScheduleExpression
};
