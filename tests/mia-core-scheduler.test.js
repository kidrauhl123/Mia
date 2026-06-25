const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { createCoreBotExecution, createCoreScheduler } = require("../src/core/mia-core.js");

// Isolated runtime home so the single-owner mia-tasks.json is a temp file.
function makeRuntimePaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-sched-"));
  return () => ({
    home,
    tasks: path.join(home, "mia-tasks.json"),
    // The bot manifest is never read: the fired turn carries no cloud snapshot,
    // so sendChat would load the manifest — but the faked Hermes send returns
    // before the manifest read matters for resolution? No: sendChat resolves the
    // bot BEFORE the Hermes send. We point at a real empty-manifest dir below.
    botManifest: path.join(home, "bots.json"),
    botDir: home
  });
}

// The real Hermes chat adapter returns a chat.completion envelope; the fake
// mirrors that exact shape so responseMessageContent(response) reads the reply.
function fakeHermesResponse(content) {
  return {
    id: "run_fake",
    object: "chat.completion",
    created: 1,
    model: "hermes-agent",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    mia: { transport: "runs", run_id: "run_fake", bot_id: "bot1", events: [] }
  };
}

// Write a minimal real bot manifest so sendChat's manifest fallback resolves the
// task's botId (the fired task carries no cloud snapshot).
function writeManifest(runtimePaths, botKey) {
  const p = runtimePaths();
  fs.writeFileSync(p.botManifest, JSON.stringify({
    default_bot: botKey,
    bots: [{ key: botKey, name: "Bot One", agentEngine: "hermes" }]
  }) + "\n");
}

test("Core scheduler fireRunner: agent task → Core sendChat (background+scheduledFire) → socialApi reply", async () => {
  const runtimePaths = makeRuntimePaths();
  const botKey = "bot1";
  writeManifest(runtimePaths, botKey);

  const sendChatSeen = [];
  // Core's REAL bot-execution graph with ONLY the lowest-level Hermes HTTP send
  // faked (proves sendChat ran the real adapter dispatch + background/scheduledFire
  // flow through to the engine send).
  const botExecution = createCoreBotExecution({
    runtimePaths,
    settingsStore: { daemonSettings: () => ({ enabled: false }) },
    hermesBaseUrl: "",
    apiKey: "test-key",
    sendHermesChat: async (context) => {
      sendChatSeen.push(context);
      return fakeHermesResponse("scheduled reply from core");
    }
  });

  // MOCK socialApi recording the as-bot post (the reply-delivery sink).
  const posts = [];
  const socialApi = {
    postConversationMessageAsBot: async (conversationId, body) => {
      posts.push({ conversationId, body });
      return { ok: true, message: { id: "posted_task_1", body_md: body.bodyMd } };
    },
    listConversationMessages: async () => ({ messages: [] })
  };

  // Cloud logged-in so deliverTaskReplyToConversation proceeds.
  const settingsStore = {
    cloudSettings: () => ({ enabled: true, token: "tok", user: { id: "userA" } }),
    normalizeCloudUrl: (v) => String(v || "")
  };

  const subsystem = createCoreScheduler({
    runtimePaths,
    settingsStore,
    botExecution,
    socialApi
  });

  // Create a real agent-mode task in the single-owner store.
  const task = subsystem.tasksStore.create({
    title: "daily ping",
    botId: botKey,
    sessionId: "conversation:botc_userA_bot1",
    originMessageId: "m1",
    trigger: { type: "cron", cron: "0 9 * * *" },
    timezone: "UTC",
    prompt: "say good morning"
  });

  // Deterministic fire: invoke the fireRunner directly with the stored task
  // record — fully awaited, no wall-clock timers (initSchedulerSubsystem is never
  // called, so no setTimeout is armed).
  const run = await subsystem.fireRunner.fire(subsystem.tasksStore.get(task.id));

  // (a) Core's sendChat ran with background + scheduledFire semantics. The fired
  // turn reaches the real Hermes adapter send; the run is the independent
  // background run (no foreground single-flight abort).
  assert.equal(sendChatSeen.length, 1, "Hermes send ran exactly once");
  assert.equal(sendChatSeen[0].scheduledFire, true, "scheduledFire propagated to engine send");
  // The background run gets its own abort controller (signal present, not the
  // shared interactive one). The faked send receives the per-turn context.
  assert.ok(sendChatSeen[0].signal, "background run carries an abort signal");

  // (b) The task reply was delivered via the real task-reply path / socialApi.
  assert.equal(posts.length, 1, "reply posted exactly once");
  assert.equal(posts[0].body.bodyMd, "scheduled reply from core", "posted the assistant reply text");
  assert.equal(posts[0].body.botId, botKey, "posted as the task's bot");
  // conversationId derives from the task's sessionId (normalized).
  assert.equal(posts[0].conversationId, "botc_userA_bot1");

  // The run was recorded ok with the reply text + the delivered message id.
  assert.equal(run.status, "ok");
  const after = subsystem.tasksStore.get(task.id);
  assert.equal(after.runs.length, 1);
  assert.equal(after.runs[0].status, "ok");
  assert.equal(after.runs[0].outputText, "scheduled reply from core");
  assert.equal(after.runs[0].outputMessageId, "posted_task_1", "delivered cloud message id recorded on the run");

  // No live timer was ever armed (initSchedulerSubsystem not called); tear down
  // defensively so node --test exits cleanly.
  subsystem.stopScheduler();
});

test("Core scheduler: construction arms no timers; initSchedulerSubsystem is idempotent and stoppable", async () => {
  const runtimePaths = makeRuntimePaths();
  const botExecution = createCoreBotExecution({
    runtimePaths,
    settingsStore: { daemonSettings: () => ({ enabled: false }) },
    hermesBaseUrl: "",
    apiKey: "k",
    sendHermesChat: async () => fakeHermesResponse("x")
  });
  const subsystem = createCoreScheduler({
    runtimePaths,
    settingsStore: { cloudSettings: () => ({ enabled: false }), normalizeCloudUrl: (v) => String(v || "") },
    botExecution,
    socialApi: { postConversationMessageAsBot: async () => ({}), listConversationMessages: async () => ({ messages: [] }) }
  });

  // No tasks → scheduler.start() arms no timer (fireableTasks is empty). This is
  // safe to call and idempotent; stopScheduler clears any timer.
  subsystem.initSchedulerSubsystem();
  subsystem.initSchedulerSubsystem();
  subsystem.stopScheduler();

  // tasksRoutes is the real /api/tasks handler.
  assert.equal(typeof subsystem.tasksRoutes.handle, "function");
  assert.equal(typeof subsystem.tasksRoutes.handleEventsStream, "function");
});
