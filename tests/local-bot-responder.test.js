const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createLocalBotResponder,
  shouldHandleLocalCloudConversationAi
} = require("../src/main/social/local-bot-responder.js");

function setup(overrides = {}) {
  const calls = { engine: [], post: [], log: [], cloudEvents: [] };
  const responder = createLocalBotResponder({
    sendChat: async (args) => {
      calls.engine.push(args);
      return { choices: [{ message: { content: "hi from codex" } }] };
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    log: (line) => calls.log.push(line),
    ...overrides
  });
  return { responder, calls };
}

const base = {
  conversationId: "g_1",
  botId: "codex",
  dedupKey: "m_1:codex",
  systemPrompt: "sys",
  userPrompt: "hi",
  turnId: "t_1"
};

test("respond runs the local engine and posts the reply as the bot", async () => {
  const { responder, calls } = setup();
  await responder.respond(base);

  assert.equal(calls.engine.length, 1);
  const engineCall = { ...calls.engine[0] };
  assert.equal(typeof engineCall.emit, "function");
  delete engineCall.emit;
  assert.deepEqual(engineCall, {
    botKey: "codex",
    botId: "codex",
    sessionId: "conversation:g_1",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" }
    ],
    group: true,
    utility: true,
    persistAgentSession: true,
    allowSlashCommands: false
  });
  assert.deepEqual(calls.post, [{
    conversationId: "g_1",
    body: {
      botId: "codex",
      bodyMd: "hi from codex",
      turnId: "t_1",
      clientOpId: "op_bot_reply_m_1_codex"
    }
  }]);
});

test("respond folds the message's skill chips into the engine turn", async () => {
  const { responder, calls } = setup();

  await responder.respond({ ...base, activeSkillIds: ["pdf-fill", "data-viz"] });

  assert.deepEqual(calls.engine[0].activeSkillIds, ["pdf-fill", "data-viz"]);
});

test("respond omits activeSkillIds when the message carried no chips", async () => {
  const { responder, calls } = setup();

  await responder.respond(base);

  assert.ok(!("activeSkillIds" in calls.engine[0]));
});

test("activeSkillIdsFromMessage parses skills_json into id list, tolerating junk", () => {
  const { activeSkillIdsFromMessage } = require("../src/main/social/local-bot-responder.js");

  assert.deepEqual(
    activeSkillIdsFromMessage({ skills_json: JSON.stringify([{ id: "trip-planner", name: "行程" }, { id: "weekly" }]) }),
    ["trip-planner", "weekly"]
  );
  // Junk is rejected, not coerced: numbers, id-less objects, nulls dropped;
  // raw string ids accepted; duplicates deduped.
  assert.deepEqual(
    activeSkillIdsFromMessage({ skills_json: JSON.stringify([{ id: "trip-planner" }, 123, { name: "no-id" }, "raw-id", { id: "trip-planner" }, null]) }),
    ["trip-planner", "raw-id"]
  );
  assert.deepEqual(activeSkillIdsFromMessage({ skills_json: null }), []);
  assert.deepEqual(activeSkillIdsFromMessage({ skills_json: "not json" }), []);
  assert.deepEqual(activeSkillIdsFromMessage({ skills_json: JSON.stringify({ not: "an array" }) }), []);
  assert.deepEqual(activeSkillIdsFromMessage({}), []);
});

test("respond emits a transient conversation run start before the local engine call", async () => {
  const { responder, calls } = setup();

  await responder.respond(base);

  assert.equal(calls.cloudEvents[0].type, "cloud_agent_run_started");
  assert.equal(calls.cloudEvents[0].conversationId, "g_1");
  assert.equal(calls.cloudEvents[0].botId, "codex");
  assert.equal(calls.cloudEvents[0].triggerMessageId, "m_1");
  assert.match(calls.cloudEvents[0].runId, /^local_/);
});

test("respond streams local engine trace events through cloud run events and saves final trace", async () => {
  const { responder, calls } = setup({
    sendChat: async (args) => {
      calls.engine.push(args);
      args.emit("reasoning_delta", { id: "r1", text: "检查文件" });
      args.emit("tool_call_started", { id: "tool_1", name: "shell", preview: "ls" });
      args.emit("tool_call_completed", { id: "tool_1", name: "shell", duration: 1.25 });
      return { choices: [{ message: { content: "done" } }] };
    }
  });

  await responder.respond(base);

  assert.equal(typeof calls.engine[0].emit, "function");
  assert.deepEqual(calls.cloudEvents.slice(1).map((item) => item.event.type), [
    "reasoning_delta",
    "tool_call_started",
    "tool_call_completed"
  ]);
  assert.deepEqual(calls.post[0].body.trace, {
    reasoning: "检查文件",
    tools: [{
      id: "tool_1",
      name: "shell",
      preview: "ls",
      status: "completed",
      duration: 1.25,
      error: false
    }]
  });
});

test("respond forwards runtime config to the local chat engine", async () => {
  const { responder, calls } = setup();
  await responder.respond({
    ...base,
    runtimeConfig: {
      model: "mia-pro",
      effortLevel: "high",
      permissionMode: "auto"
    }
  });

  assert.deepEqual(calls.engine[0].runtimeConfig, {
    model: "mia-pro",
    effortLevel: "high",
    permissionMode: "auto"
  });
});

test("respond forwards cloud bot snapshots for cloud-only bots", async () => {
  const { responder, calls } = setup();
  await responder.respond({
    ...base,
    botSnapshot: { key: "codex", name: "Cloud Codex", agentEngine: "codex" }
  });

  assert.deepEqual(calls.engine[0].botSnapshot, { key: "codex", name: "Cloud Codex", agentEngine: "codex" });
});

test("respond uses the same clientOpId for the same dedupKey", async () => {
  const first = setup();
  const second = setup();

  await first.responder.respond(base);
  await second.responder.respond(base);

  assert.equal(first.calls.post[0].body.clientOpId, "op_bot_reply_m_1_codex");
  assert.equal(second.calls.post[0].body.clientOpId, "op_bot_reply_m_1_codex");
});

test("respond uses conversation scoped chat sessions for bot conversations", async () => {
  const { responder, calls } = setup();

  await responder.respond({
    conversationId: "bot:u_1:alice",
    botId: "alice",
    dedupKey: "m_2:alice",
    systemPrompt: "You are Alice",
    userPrompt: "你好"
  });

  assert.equal(calls.engine[0].botKey, "alice");
  assert.equal(calls.engine[0].sessionId, "conversation:bot:u_1:alice");
});

test("respond dedups by dedupKey", async () => {
  const { responder, calls } = setup();
  await responder.respond(base);
  await responder.respond(base);

  assert.equal(calls.engine.length, 1);
  assert.equal(calls.post.length, 1);
});

test("respond retries after post failure and dedups after post success", async () => {
  const calls = { engine: [], post: [], log: [] };
  const responder = createLocalBotResponder({
    sendChat: async (args) => {
      calls.engine.push(args);
      return { choices: [{ message: { content: "retry reply" } }] };
    },
    postConversationMessageAsBot: async () => {
      calls.post.push({});
      if (calls.post.length === 1) return { ok: false, error: "temporary" };
      return { ok: true };
    },
    log: (line) => calls.log.push(line)
  });

  await responder.respond(base);
  await responder.respond(base);
  await responder.respond(base);

  assert.equal(calls.engine.length, 2);
  assert.equal(calls.post.length, 2);
  assert.equal(calls.log.some((line) => line.includes("temporary")), true);
});

test("respond posts a visible bot error when the local engine fails", async () => {
  const { responder, calls } = setup({
    sendChat: async (args) => {
      calls.engine.push(args);
      throw new Error("HTTP 429: Gemini quota exhausted");
    }
  });

  const result = await responder.respond(base);

  assert.equal(result, true);
  assert.equal(calls.engine.length, 1);
  assert.equal(calls.post.length, 1);
  assert.equal(calls.post[0].conversationId, "g_1");
  assert.equal(calls.post[0].body.botId, "codex");
  assert.match(calls.post[0].body.bodyMd, /模型配额已耗尽/);
  assert.deepEqual(calls.post[0].body.errorJson, {
    stage: "engine",
    message: "HTTP 429: Gemini quota exhausted"
  });
  assert.equal(calls.post[0].body.clientOpId, "op_bot_reply_error_m_1_codex");
});

test("respond skips empty replies and incomplete invocations", async () => {
  const { responder, calls } = setup({
    sendChat: async (args) => {
      calls.engine.push(args);
      return { choices: [{ message: { content: "  " } }] };
    }
  });

  await responder.respond(base);
  await responder.respond({ ...base, dedupKey: "" });
  await responder.respond({ ...base, conversationId: "" });
  await responder.respond({ ...base, botId: "" });

  assert.equal(calls.engine.length, 1);
  assert.equal(calls.post.length, 0);
});

test("shouldHandleLocalCloudConversationAi lets foreground handle events when daemon may share the cursor", () => {
  assert.equal(shouldHandleLocalCloudConversationAi({ isDaemon: false, daemonEnabled: true }), true);
  assert.equal(shouldHandleLocalCloudConversationAi({ isDaemon: false, daemonEnabled: false }), true);
  assert.equal(shouldHandleLocalCloudConversationAi({ isDaemon: true, daemonEnabled: true }), true);
  assert.equal(shouldHandleLocalCloudConversationAi({ isDaemon: true, daemonEnabled: false }), false);
});
