const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  MIA_SCHEDULER_SKILL_ID,
  schedulerSkillIdsForTurn
} = require("../src/main/scheduler-skill-defaults.js");

test("schedulerSkillIdsForTurn makes Mia scheduler available without parsing user text", () => {
  assert.deepEqual(
    schedulerSkillIdsForTurn({
      messages: [{ role: "user", content: "5分钟后提醒我吃饭" }]
    }),
    [MIA_SCHEDULER_SKILL_ID]
  );
  assert.deepEqual(
    schedulerSkillIdsForTurn({
      messages: [{ role: "user", content: "你知道啥是 Mia 吗" }]
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

test("schedulerSkillIdsForTurn skips background and scheduled fire turns", () => {
  assert.deepEqual(
    schedulerSkillIdsForTurn({
      messages: [{ role: "user", content: "提醒你吃饭" }],
      background: true
    }),
    []
  );
  assert.deepEqual(
    schedulerSkillIdsForTurn({
      messages: [{ role: "user", content: "请在 Mia 会话里提醒用户：睡觉" }],
      scheduledFire: true
    }),
    []
  );
});
