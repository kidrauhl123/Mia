const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  triggerFromScheduleExpression
} = require("../src/shared/schedule-expression.js");

test("triggerFromScheduleExpression converts Hermes-style relative delays to one-shot triggers", () => {
  const now = new Date("2026-06-18T08:22:34.000Z").getTime();

  assert.deepEqual(triggerFromScheduleExpression("1m", { nowMs: now }), {
    type: "oneshot",
    at: "2026-06-18T08:23:34.000Z"
  });
  assert.deepEqual(triggerFromScheduleExpression("30m", { nowMs: now }), {
    type: "oneshot",
    at: "2026-06-18T08:52:34.000Z"
  });
});

test("triggerFromScheduleExpression accepts cron expressions and ISO timestamps", () => {
  const trigger = triggerFromScheduleExpression("0 9 * * *");
  assert.deepEqual(trigger, { type: "cron", cron: "0 9 * * *" });

  assert.deepEqual(triggerFromScheduleExpression("2026-06-18T23:02:00+08:00"), {
    type: "oneshot",
    at: "2026-06-18T23:02:00+08:00"
  });
});
