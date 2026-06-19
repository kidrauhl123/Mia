const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createLocalBotResponder,
  shouldHandleLocalCloudConversationAi
} = require("../src/main/social/local-bot-responder.js");

function setup(overrides = {}) {
  const calls = { engine: [], post: [], log: [], cloudEvents: [], task: [] };
  const responder = createLocalBotResponder({
    sendChat: async (args) => {
      calls.engine.push(args);
      return { choices: [{ message: { content: "hi from codex" } }] };
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true };
    },
    createScheduledTask: async (input) => {
      calls.task.push(input);
      return {
        id: "t_1",
        ...input,
        nextFireAt: new Date(input.trigger.at).getTime()
      };
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
  assert.equal(engineCall.signal.aborted, false);
  assert.equal(typeof engineCall.abortController.abort, "function");
  delete engineCall.emit;
  delete engineCall.signal;
  delete engineCall.abortController;
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
    persistAgentSession: false,
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

test("respond passes structured conversation history before the current user turn", async () => {
  const { responder, calls } = setup();

  await responder.respond({
    ...base,
    historyMessages: [
      { role: "user", content: "前面问：要不要去" },
      { role: "assistant", content: "建议先别表态" },
      { role: "system", content: "这是一条系统提示" },
      { role: "ignored", content: "非法 role 当用户处理" },
      { role: "assistant", content: "   " }
    ],
    userPrompt: "那我选 1"
  });

  assert.deepEqual(calls.engine[0].messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "前面问：要不要去" },
    { role: "assistant", content: "建议先别表态" },
    { role: "system", content: "这是一条系统提示" },
    { role: "user", content: "非法 role 当用户处理" },
    { role: "user", content: "那我选 1" }
  ]);
});

test("respond folds the message's skill chips into the engine turn", async () => {
  const { responder, calls } = setup();

  await responder.respond({ ...base, activeSkillIds: ["pdf-fill", "data-viz"] });

  assert.deepEqual(calls.engine[0].activeSkillIds, ["pdf-fill", "data-viz"]);
});

test("respond passes trigger attachments on the current user turn", async () => {
  const { responder, calls } = setup();
  const attachment = {
    id: "path-ref:IMG1",
    name: "screen.png",
    path: "/tmp/screen.png",
    kind: "image",
    inlinePathRef: true,
    pathRefToken: "IMG1"
  };

  await responder.respond({ ...base, userPrompt: "IMG1 这是什么", userAttachments: [attachment] });

  assert.deepEqual(calls.engine[0].messages.at(-1), {
    role: "user",
    content: "IMG1 这是什么",
    attachments: [attachment]
  });
});

test("respond sends explicit reminder requests through the engine scheduler path", async () => {
  const { responder, calls } = setup();

  await responder.respond({
    ...base,
    conversationId: "botc_7d852259-ed51-47c5-a84f-2f3e1987ad72",
    botId: "6859845",
    userPrompt: "1分钟后提醒我🦌",
    triggerMessageId: "m_user_1",
    dedupKey: "m_user_1:6859845"
  });

  assert.equal(calls.engine.length, 1);
  assert.deepEqual(calls.task, []);
  assert.equal(calls.engine[0].sessionId, "conversation:botc_7d852259-ed51-47c5-a84f-2f3e1987ad72");
  assert.deepEqual(calls.engine[0].messages.at(-1), { role: "user", content: "1分钟后提醒我🦌" });
  assert.equal(calls.post.length, 1);
  assert.equal(calls.post[0].conversationId, "botc_7d852259-ed51-47c5-a84f-2f3e1987ad72");
  assert.equal(calls.post[0].body.bodyMd, "hi from codex");
  assert.ok(!calls.post[0].body.trace);
});

test("respond treats reminder engine failures as engine failures, not scheduler parser failures", async () => {
  const { responder, calls } = setup({
    sendChat: async (args) => {
      calls.engine.push(args);
      throw new Error("scheduler tool unavailable");
    }
  });

  const handled = await responder.respond({
    ...base,
    userPrompt: "2分钟后提醒我睡觉",
    triggerMessageId: "m_sleep",
    dedupKey: "m_sleep:codex"
  });

  assert.equal(handled, true);
  assert.equal(calls.engine.length, 1);
  assert.equal(calls.task.length, 0);
  assert.match(calls.post[0].body.bodyMd, /本地模型运行失败/);
  assert.equal(calls.post[0].body.errorJson.stage, "engine");
});

test("respond does not mark bot private conversations as group turns", async () => {
  const { responder, calls } = setup();

  await responder.respond({
    ...base,
    conversationId: "botc_private",
    conversationType: "bot"
  });

  assert.equal(calls.engine.length, 1);
  assert.equal(calls.engine[0].group, false);
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

test("stopActiveConversationRun aborts the in-flight local engine turn without posting an error bubble", async () => {
  const { responder, calls } = setup({
    sendChat: async (args) => {
      calls.engine.push(args);
      return new Promise((_resolve, reject) => {
        args.signal.addEventListener("abort", () => {
          const stopped = new Error("生成已停止");
          stopped.code = "MIA_STOPPED";
          reject(stopped);
        }, { once: true });
      });
    }
  });

  const responsePromise = responder.respond(base);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(calls.engine.length, 1);
  assert.equal(calls.engine[0].signal.aborted, false);

  const stopResult = responder.stopActiveConversationRun({ conversationId: "g_1" });
  const handled = await responsePromise;

  assert.deepEqual(stopResult, {
    stopped: true,
    conversationId: "g_1",
    runId: calls.cloudEvents[0].runId
  });
  assert.equal(handled, true);
  assert.equal(calls.engine[0].signal.aborted, true);
  assert.equal(calls.post.length, 0);
  assert.equal(calls.cloudEvents.at(-1).type, "cloud_agent_run_event");
  assert.equal(calls.cloudEvents.at(-1).event.type, "run.cancelled");
});

test("respond publishes the persisted bot message immediately after posting it", async () => {
  const postedMessage = {
    id: "m_bot_1",
    seq: 2,
    sender_kind: "bot",
    sender_ref: "codex",
    body_md: "hi from codex"
  };
  const { responder, calls } = setup({
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { message: postedMessage };
    }
  });

  await responder.respond(base);

  assert.deepEqual(calls.cloudEvents.at(-1), {
    type: "conversation.message_appended",
    conversationId: "g_1",
    message: postedMessage
  });
});

test("respond skips replayed invocations when the bot already replied to the trigger turn", async () => {
  const calls = { engine: [], post: [], list: [], cloudEvents: [], log: [] };
  const responder = createLocalBotResponder({
    sendChat: async (args) => {
      calls.engine.push(args);
      return { choices: [{ message: { content: "should not run" } }] };
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true };
    },
    listConversationMessages: async (conversationId, sinceSeq, limit) => {
      calls.list.push({ conversationId, sinceSeq, limit });
      return {
        messages: [
          { id: "m_1", seq: 21, sender_kind: "user", sender_ref: "u_1", turn_id: "t_1", body_md: "3" },
          { id: "m_2", seq: 22, sender_kind: "bot", sender_ref: "codex", turn_id: "t_1", body_md: "done", created_at: "2026-06-17T09:17:02.599Z" }
        ]
      };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    log: (line) => calls.log.push(line)
  });

  const handled = await responder.respond({
    ...base,
    triggerSeq: 21,
    triggerMessageId: "m_1"
  });

  assert.equal(handled, false);
  assert.deepEqual(calls.list, [{ conversationId: "g_1", sinceSeq: 20, limit: 50 }]);
  assert.equal(calls.engine.length, 0);
  assert.equal(calls.post.length, 0);
  assert.equal(calls.cloudEvents.length, 0);
});

test("respond streams local engine trace events through cloud run events and saves final trace", async () => {
  const { responder, calls } = setup({
    sendChat: async (args) => {
      calls.engine.push(args);
      args.emit("reasoning_delta", { id: "r1", text: "检查文件" });
      args.emit("text_delta", { id: "text_1", text: "我先看目录。" });
      args.emit("tool_call_started", { id: "tool_1", name: "shell", preview: "ls" });
      args.emit("tool_call_completed", { id: "tool_1", name: "shell", duration: 1.25 });
      args.emit("text_delta", { id: "text_2", text: "结论是 done。" });
      return { choices: [{ message: { content: "我先看目录。\n\n结论是 done。" } }] };
    }
  });

  await responder.respond(base);

  assert.equal(typeof calls.engine[0].emit, "function");
  assert.deepEqual(calls.cloudEvents.slice(1).map((item) => item.event.type), [
    "reasoning_delta",
    "text_delta",
    "tool_call_started",
    "tool_call_completed",
    "text_delta"
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
  assert.deepEqual(calls.post[0].body.contentBlocks, [
    { type: "thinking", id: "r1", status: "running", duration: null, text: "检查文件" },
    { type: "text", id: "text_1", text: "我先看目录。" },
    {
      type: "tool",
      id: "tool_1",
      name: "shell",
      preview: "ls",
      status: "completed",
      duration: 1.25,
      error: false
    },
    { type: "text", id: "text_2", text: "结论是 done。" }
  ]);
});

test("respond keeps streamed process text and appends unstreamed final text", async () => {
  const { responder, calls } = setup({
    sendChat: async (args) => {
      calls.engine.push(args);
      args.emit("text_delta", { id: "text_1", text: "我先检查。" });
      args.emit("tool_call_started", { id: "tool_1", name: "shell", preview: "pwd" });
      args.emit("tool_call_completed", { id: "tool_1", name: "shell" });
      return { choices: [{ message: { content: "最终结论。" } }] };
    }
  });

  await responder.respond(base);

  assert.deepEqual(calls.post[0].body.contentBlocks, [
    { type: "text", id: "text_1", text: "我先检查。" },
    { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed", duration: null, error: false },
    { type: "text", id: "text_final_2", text: "最终结论。" }
  ]);
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
  assert.match(calls.post[0].body.bodyMd, /HTTP 429: Gemini quota exhausted/);
  assert.deepEqual(calls.post[0].body.errorJson, {
    stage: "engine",
    message: "HTTP 429: Gemini quota exhausted"
  });
  assert.equal(calls.post[0].body.clientOpId, "op_bot_reply_error_m_1_codex");
});

test("respond posts the real local engine error with secrets redacted", async () => {
  const { responder, calls } = setup({
    sendChat: async (args) => {
      calls.engine.push(args);
      throw new Error("Claude Code authentication failed: token=sk-abcdefghijklmnopqrstuvwxyz123456 Bearer gho_abcdefghijklmnopqrstuvwxyz1234567890");
    }
  });

  const result = await responder.respond(base);

  assert.equal(result, true);
  assert.match(calls.post[0].body.bodyMd, /本地引擎认证失败/);
  assert.match(calls.post[0].body.bodyMd, /Claude Code authentication failed/);
  assert.match(calls.post[0].body.bodyMd, /token=\[redacted\]/);
  assert.match(calls.post[0].body.bodyMd, /Bearer \[redacted\]/);
  assert.doesNotMatch(calls.post[0].body.bodyMd, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(calls.post[0].body.bodyMd, /gho_abcdefghijklmnopqrstuvwxyz1234567890/);
});

test("respond posts a visible bot error when the local engine returns empty text", async () => {
  const { responder, calls } = setup({
    sendChat: async (args) => {
      calls.engine.push(args);
      return { choices: [{ message: { content: "  " } }] };
    }
  });

  const result = await responder.respond(base);

  assert.equal(result, true);
  assert.equal(calls.engine.length, 1);
  assert.equal(calls.post.length, 1);
  assert.equal(calls.post[0].conversationId, "g_1");
  assert.equal(calls.post[0].body.botId, "codex");
  assert.match(calls.post[0].body.bodyMd, /没能生成回复/);
  assert.equal(calls.post[0].body.clientOpId, "op_bot_reply_error_m_1_codex");
  assert.equal(calls.post[0].body.errorJson.stage, "empty");
});

test("respond dedups an empty-reply error and does not double-post", async () => {
  const { responder, calls } = setup({
    sendChat: async (args) => {
      calls.engine.push(args);
      return { choices: [{ message: { content: "" } }] };
    }
  });

  await responder.respond(base);
  await responder.respond(base);

  assert.equal(calls.post.length, 1);
});

test("respond skips incomplete invocations", async () => {
  const { responder, calls } = setup();

  await responder.respond({ ...base, dedupKey: "" });
  await responder.respond({ ...base, conversationId: "" });
  await responder.respond({ ...base, botId: "" });

  assert.equal(calls.engine.length, 0);
  assert.equal(calls.post.length, 0);
});

test("shouldHandleLocalCloudConversationAi keeps a single execution owner (ADR 2026-06-12)", () => {
  // Daemon owns execution; the window never covers a dead or disabled daemon.
  assert.equal(shouldHandleLocalCloudConversationAi({ isDaemon: true, daemonEnabled: true }), true);
  assert.equal(shouldHandleLocalCloudConversationAi({ isDaemon: false, daemonEnabled: true, daemonReachable: true }), false);
  assert.equal(shouldHandleLocalCloudConversationAi({ isDaemon: false, daemonEnabled: true, daemonReachable: false }), false);
  assert.equal(shouldHandleLocalCloudConversationAi({ isDaemon: false, daemonEnabled: false }), false);
  assert.equal(shouldHandleLocalCloudConversationAi({ isDaemon: true, daemonEnabled: false }), false);
});
