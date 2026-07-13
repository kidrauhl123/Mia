const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  TASK_SOURCE_CLOUD,
  TASK_SOURCE_LOCAL,
  mergeTaskProjections,
  taskSourceFor
} = require("../src/shared/task-projection.js");

test("task projection merges real local and cloud tasks without dropping cloud run history", () => {
  const local = {
    id: "task_local_1",
    title: "本机巡检",
    runs: []
  };
  const cloud = {
    id: "t-cloud-1",
    title: "吃饭提醒",
    status: "done",
    conversationId: "botc_u_1_mia",
    runs: [{ id: "r-cloud-1", status: "ok", outputText: "该吃饭啦" }]
  };

  const tasks = mergeTaskProjections([local], [cloud]);

  assert.deepEqual(tasks.map((task) => [task.id, task.taskSource]), [
    ["task_local_1", TASK_SOURCE_LOCAL],
    ["t-cloud-1", TASK_SOURCE_CLOUD]
  ]);
  assert.deepEqual(tasks[1].runs, cloud.runs);
  assert.equal(tasks[1].conversationId, "botc_u_1_mia");
  assert.equal(taskSourceFor(tasks[0]), TASK_SOURCE_LOCAL);
  assert.equal(taskSourceFor(tasks[1]), TASK_SOURCE_CLOUD);
});

test("task projection de-duplicates a repeated cloud task id in favor of its cloud owner", () => {
  const tasks = mergeTaskProjections(
    [{ id: "shared", title: "stale local copy", runs: [] }],
    [{ id: "shared", title: "cloud owner", runs: [{ id: "r1" }] }]
  );

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "cloud owner");
  assert.equal(tasks[0].taskSource, TASK_SOURCE_CLOUD);
  assert.deepEqual(tasks[0].runs, [{ id: "r1" }]);
});
