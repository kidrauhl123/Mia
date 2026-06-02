const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  MIA_SCHEDULER_SKILL_ID,
  schedulerSkillIdsForTurn
} = require("../src/main/scheduler-skill-detector.js");

test("schedulerSkillIdsForTurn activates Mia scheduler for reminder requests", () => {
  assert.deepEqual(
    schedulerSkillIdsForTurn({
      messages: [{ role: "user", content: "5分钟后提醒我吃饭" }]
    }),
    [MIA_SCHEDULER_SKILL_ID]
  );
  assert.deepEqual(
    schedulerSkillIdsForTurn({
      messages: [{ role: "user", content: "每天早上9点提醒我写日报" }]
    }),
    [MIA_SCHEDULER_SKILL_ID]
  );
});

test("schedulerSkillIdsForTurn preserves explicit skill ids and dedupes scheduler", () => {
  assert.deepEqual(
    schedulerSkillIdsForTurn({
      messages: [{ role: "user", content: "2分钟后提醒我喝水" }],
      activeSkillIds: ["trip-planner", MIA_SCHEDULER_SKILL_ID]
    }),
    ["trip-planner", MIA_SCHEDULER_SKILL_ID]
  );
});

test("schedulerSkillIdsForTurn ignores non-scheduler questions and unsafe utility turns", () => {
  assert.deepEqual(
    schedulerSkillIdsForTurn({
      messages: [{ role: "user", content: "你知道啥是 Mia 吗" }]
    }),
    []
  );
  assert.deepEqual(
    schedulerSkillIdsForTurn({
      messages: [{ role: "user", content: "请把下面这条消息翻译成简体中文。\n\n5分钟后提醒我吃饭" }],
      utility: true,
      group: false
    }),
    []
  );
  assert.deepEqual(
    schedulerSkillIdsForTurn({
      messages: [{ role: "user", content: "提醒你吃饭" }],
      background: true
    }),
    []
  );
});
