const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCoreScheduler } = require("../src/core/mia-core.js");

function makeRuntimePaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-sched-"));
  return () => ({
    home,
    tasks: path.join(home, "mia-tasks.json"),
    botManifest: path.join(home, "bots.json"),
    botDir: home
  });
}

function fakeChatResponse(content) {
  return {
    id: "run_fake",
    object: "chat.completion",
    created: 1,
    model: "codex",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]
  };
}

test("Core scheduler fireRunner drives background botExecution.sendChat and delivers the reply", async () => {
  const runtimePaths = makeRuntimePaths();
  const sendChatSeen = [];
  const posts = [];
  const subsystem = createCoreScheduler({
    runtimePaths,
    settingsStore: {
      cloudSettings: () => ({ enabled: true, token: "tok", user: { id: "userA" } }),
      normalizeCloudUrl: (value) => String(value || "")
    },
    botExecution: {
      sendChat: async (context) => {
        sendChatSeen.push(context);
        return fakeChatResponse("scheduled reply from core");
      }
    },
    socialApi: {
      postConversationMessageAsBot: async (conversationId, body) => {
        posts.push({ conversationId, body });
        return { ok: true, message: { id: "posted_task_1", body_md: body.bodyMd } };
      },
      listConversationMessages: async () => ({ messages: [] })
    }
  });

  const task = subsystem.tasksStore.create({
    title: "daily ping",
    botId: "bot1",
    sessionId: "conversation:botc_userA_bot1",
    originMessageId: "m1",
    trigger: { type: "cron", cron: "0 9 * * *" },
    timezone: "UTC",
    prompt: "say good morning"
  });

  const run = await subsystem.fireRunner.fire(subsystem.tasksStore.get(task.id));

  assert.equal(sendChatSeen.length, 1);
  assert.equal(sendChatSeen[0].background, true);
  assert.equal(sendChatSeen[0].scheduledFire, true);
  assert.equal(sendChatSeen[0].persistAgentSession, true);
  assert.equal(sendChatSeen[0].messages.at(-1).content, "say good morning");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].conversationId, "botc_userA_bot1");
  assert.equal(posts[0].body.bodyMd, "scheduled reply from core");
  assert.equal(posts[0].body.botId, "bot1");
  assert.equal(run.status, "ok");
  const after = subsystem.tasksStore.get(task.id);
  assert.equal(after.runs.length, 1);
  assert.equal(after.runs[0].status, "ok");
  assert.equal(after.runs[0].outputText, "scheduled reply from core");
  assert.equal(after.runs[0].outputMessageId, "posted_task_1");

  subsystem.stopScheduler();
  fs.rmSync(runtimePaths().home, { recursive: true, force: true });
});

test("Core scheduler construction arms no timers; initSchedulerSubsystem is idempotent and stoppable", () => {
  const runtimePaths = makeRuntimePaths();
  const subsystem = createCoreScheduler({
    runtimePaths,
    settingsStore: { cloudSettings: () => ({ enabled: false }), normalizeCloudUrl: (value) => String(value || "") },
    botExecution: { sendChat: async () => fakeChatResponse("x") },
    socialApi: { postConversationMessageAsBot: async () => ({}), listConversationMessages: async () => ({ messages: [] }) }
  });

  subsystem.initSchedulerSubsystem();
  subsystem.initSchedulerSubsystem();
  subsystem.stopScheduler();

  assert.equal(typeof subsystem.tasksRoutes.handle, "function");
  assert.equal(typeof subsystem.tasksRoutes.handleEventsStream, "function");

  fs.rmSync(runtimePaths().home, { recursive: true, force: true });
});
