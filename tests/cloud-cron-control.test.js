const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  detectCronCommands,
  processCloudCronTurn,
  stripCronCommands
} = require("../src/cloud-agent/cron-control.js");

test("cloud cron protocol parses complete commands and hides only control text", () => {
  const text = [
    "我先处理。",
    "[CRON_CREATE]",
    "name: 喝水提醒",
    "schedule: in 1 minute",
    "schedule_description: 1 分钟后",
    "message: 用一句简短中文提醒用户喝水。",
    "[/CRON_CREATE]",
    "正在设置。"
  ].join("\n");

  assert.deepEqual(detectCronCommands(text), [{
    type: "create",
    name: "喝水提醒",
    schedule: "in 1 minute",
    scheduleDescription: "1 分钟后",
    message: "用一句简短中文提醒用户喝水。"
  }]);
  assert.equal(stripCronCommands(text), "我先处理。\n\n正在设置。");
  assert.deepEqual(detectCronCommands("[CRON_CREATE]\nname: 缺少闭合标签"), []);
});

test("cloud cron control creates a real scoped task and returns a hidden continuation", async () => {
  const created = [];
  const taskApi = {
    list() { return []; },
    create(userId, input) {
      created.push({ userId, input });
      return { id: "t-cloud-1", status: "active", ...input };
    }
  };

  const result = await processCloudCronTurn({
    assistantText: [
      "[CRON_CREATE]",
      "name: 喝水提醒",
      "schedule: in 1 minute",
      "schedule_description: 1 分钟后",
      "message: 用一句简短中文提醒用户喝水。",
      "[/CRON_CREATE]"
    ].join("\n"),
    continuationCount: 0,
    userId: "user-1",
    botId: "bot-1",
    conversationId: "conv-1",
    originMessageId: "msg-1",
    taskApi
  });

  assert.equal(result.visibleText, "");
  assert.match(result.continuation, /Created cron job '喝水提醒' \(id: t-cloud-1\)/);
  assert.equal(result.nextCount, 1);
  assert.deepEqual(created, [{
    userId: "user-1",
    input: {
      title: "喝水提醒",
      botId: "bot-1",
      conversationId: "conv-1",
      sessionId: "conv-1",
      originMessageId: "msg-1",
      schedule: "in 1 minute",
      timezone: "Asia/Shanghai",
      fireMode: "agent",
      prompt: "用一句简短中文提醒用户喝水。"
    }
  }]);
  assert.equal(result.traceEvents[1].name, "创建 Mia 定时任务");
});

test("cloud cron update and delete cannot cross bot or conversation scope", async () => {
  const updates = [];
  const deletions = [];
  const taskApi = {
    list() {
      return [
        { id: "mine", botId: "bot-1", conversationId: "conv-1", title: "旧任务", status: "active", prompt: "旧消息", trigger: { type: "cron", cron: "0 9 * * *" } },
        { id: "foreign", botId: "bot-2", conversationId: "conv-2", title: "别人的任务", status: "active", prompt: "不能改" }
      ];
    },
    update(userId, taskId, partial) {
      updates.push({ userId, taskId, partial });
      return { id: taskId, ...partial };
    },
    delete(userId, taskId) {
      deletions.push({ userId, taskId });
      return { ok: true };
    }
  };

  const foreign = await processCloudCronTurn({
    assistantText: "[CRON_DELETE: foreign]",
    userId: "user-1",
    botId: "bot-1",
    conversationId: "conv-1",
    taskApi
  });
  assert.match(foreign.continuation, /not found in this conversation/);
  assert.deepEqual(deletions, []);

  await processCloudCronTurn({
    assistantText: [
      "[CRON_UPDATE: mine]",
      "name: 新任务",
      "schedule: 0 10 * * *",
      "schedule_description: 每天上午 10 点",
      "message: 提醒用户写日报。",
      "[/CRON_UPDATE]"
    ].join("\n"),
    userId: "user-1",
    botId: "bot-1",
    conversationId: "conv-1",
    taskApi
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].taskId, "mine");
  assert.equal(updates[0].partial.schedule, "0 10 * * *");
});
