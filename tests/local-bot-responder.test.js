const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

test("respond attaches workspace-created spreadsheet artifacts to the bot message", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mia-local-artifacts-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const filePath = path.join(workspace, "world-cup.xlsx");
  const bytes = Buffer.from("fake workbook bytes");
  const { responder, calls } = setup({
    artifactWorkspaceDir: () => workspace,
    sendChat: async (args) => {
      calls.engine.push(args);
      fs.writeFileSync(filePath, bytes);
      return { choices: [{ message: { content: "已生成 Excel。" } }] };
    }
  });

  await responder.respond(base);

  assert.equal(calls.post.length, 1);
  assert.equal(calls.post[0].body.bodyMd, "已生成 Excel。");
  assert.equal(calls.post[0].body.attachments.length, 1);
  assert.deepEqual(
    {
      name: calls.post[0].body.attachments[0].name,
      path: calls.post[0].body.attachments[0].path,
      mimeType: calls.post[0].body.attachments[0].mimeType,
      kind: calls.post[0].body.attachments[0].kind,
      size: calls.post[0].body.attachments[0].size,
      dataUrl: calls.post[0].body.attachments[0].dataUrl
    },
    {
      name: "world-cup.xlsx",
      path: filePath,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      kind: "file",
      size: bytes.length,
      dataUrl: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${bytes.toString("base64")}`
    }
  );
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
    { role: "user", content: "这是一条系统提示" },
    { role: "user", content: "非法 role 当用户处理" },
    { role: "user", content: "那我选 1" }
  ]);
});

test("respond omits generated assistant failure bubbles from engine history", async () => {
  const { responder, calls } = setup();

  await responder.respond({
    ...base,
    historyMessages: [
      { role: "user", content: "刚才怎么了" },
      { role: "assistant", content: "我这次没能生成回复：本地模型运行失败。原因：本地模型这次没有产生任何文本回复（可能是工具权限被拒，或本轮只调用了工具）。请稍后重试或切换模型。" },
      { role: "assistant", content: "现在恢复了。" },
      { role: "assistant", content: "jungdeMacBook-Air-7 当前离线，打开该设备上的 Mia 后再试。" }
    ],
    userPrompt: "继续"
  });

  assert.deepEqual(calls.engine[0].messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "刚才怎么了" },
    { role: "assistant", content: "现在恢复了。" },
    { role: "user", content: "继续" }
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

test("respond materializes cloud file URL attachments for the local engine", async () => {
  const fetched = [];
  const { responder, calls } = setup({
    fetchFileAttachment: async (request) => {
      fetched.push(request);
      return {
        id: "file_sheet",
        name: "世界杯赛果汇总.xlsx",
        url: request.url,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        kind: "file",
        size: 14,
        dataUrl: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${Buffer.from("workbook bytes").toString("base64")}`
      };
    }
  });

  await responder.respond({
    ...base,
    dedupKey: "m_file:bot",
    userPrompt: "看这个表格",
    userAttachments: [{
      id: "file_sheet",
      name: "世界杯赛果汇总.xlsx",
      url: "/api/files/file_sheet",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      kind: "file",
      size: 14
    }]
  });

  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, "/api/files/file_sheet");
  const attachment = calls.engine[0].messages.at(-1).attachments[0];
  assert.equal(attachment.name, "世界杯赛果汇总.xlsx");
  assert.equal(attachment.url, "/api/files/file_sheet");
  assert.ok(attachment.path.endsWith("世界杯赛果汇总.xlsx"));
  assert.equal(fs.readFileSync(attachment.path, "utf8"), "workbook bytes");
  fs.rmSync(path.dirname(attachment.path), { recursive: true, force: true });
});

test("respond materializes cloud file URLs carried in the attachment path field", async () => {
  const fetched = [];
  const { responder, calls } = setup({
    fetchFileAttachment: async (request) => {
      fetched.push(request);
      return {
        id: "file_doc",
        name: "业务信息调查表.docx",
        url: request.url,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        kind: "file",
        size: 9,
        dataUrl: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${Buffer.from("doc bytes").toString("base64")}`
      };
    }
  });

  await responder.respond({
    ...base,
    dedupKey: "m_doc:bot",
    userPrompt: "看这个文档",
    userAttachments: [{
      id: "file_doc",
      name: "业务信息调查表.docx",
      path: "/api/files/file_doc",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      kind: "file",
      size: 9
    }]
  });

  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, "/api/files/file_doc");
  const attachment = calls.engine[0].messages.at(-1).attachments[0];
  assert.equal(attachment.name, "业务信息调查表.docx");
  assert.equal(attachment.url, "/api/files/file_doc");
  assert.ok(attachment.path.endsWith("业务信息调查表.docx"));
  assert.equal(fs.readFileSync(attachment.path, "utf8"), "doc bytes");
  fs.rmSync(path.dirname(attachment.path), { recursive: true, force: true });
});

test("respond forwards trigger attachments into AgentSession input for Hermes ACP turns", async () => {
  const docMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const calls = { engine: [], manager: [], post: [], log: [], cloudEvents: [] };
  const responder = createLocalBotResponder({
    sendChat: async (args) => {
      calls.engine.push(args);
      return { choices: [{ message: { content: "should not run" } }] };
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    log: (line) => calls.log.push(line),
    agentSessionManager: {
      sendUserInput: async (input) => {
        calls.manager.push(input);
        return {
          ok: true,
          mode: "started",
          conversationId: input.conversationId,
          engineId: input.engineId,
          turnId: input.turnId
        };
      }
    },
    agentSessionWorkspacePath: () => "/repo/workspace"
  });

  assert.equal(await responder.respond({
    ...base,
    conversationId: "g_docx",
    botId: "hermes",
    dedupKey: "m_docx:hermes",
    turnId: "t_docx",
    userPrompt: "请读取这份调查表",
    runtimeConfig: { agentEngine: "hermes" },
    userAttachments: [{
      id: "file_doc",
      name: "业务信息调查表.docx",
      url: "/api/files/file_doc",
      mimeType: docMime,
      kind: "file",
      size: 9
    }]
  }), true);
  assert.equal(calls.engine.length, 0);
  assert.equal(calls.post.length, 0);
  assert.deepEqual(calls.manager, [{
    conversationId: "g_docx",
    engineId: "hermes",
    workspacePath: "/repo/workspace",
    turnId: "t_docx",
    text: "请读取这份调查表",
    attachments: [{
      id: "file_doc",
      name: "业务信息调查表.docx",
      url: "/api/files/file_doc",
      mimeType: docMime,
      kind: "file",
      size: 9
    }]
  }]);
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
  assert.equal(calls.cloudEvents.at(-1).type, "cloud_agent_run_event");
  assert.equal(calls.cloudEvents.at(-1).event.type, "run.cancelling");
  const handled = await responsePromise;

  assert.deepEqual(stopResult, {
    stopped: true,
    conversationId: "g_1",
    runId: calls.cloudEvents[0].runId,
    turnId: "t_1",
    status: "cancelling"
  });
  assert.equal(handled, true);
  assert.equal(calls.engine[0].signal.aborted, true);
  assert.equal(calls.post.length, 0);
  assert.equal(calls.cloudEvents.at(-1).type, "cloud_agent_run_event");
  assert.equal(calls.cloudEvents.at(-1).event.type, "run.cancelled");
});

test("stopActiveConversationRun is idempotent while the local turn is cancelling", async () => {
  const { responder, calls } = setup({
    sendChat: async (args) => {
      calls.engine.push(args);
      return new Promise((_resolve, reject) => {
        args.signal.addEventListener("abort", () => {
          setTimeout(() => {
            const stopped = new Error("生成已停止");
            stopped.code = "MIA_STOPPED";
            reject(stopped);
          }, 5);
        }, { once: true });
      });
    }
  });

  const responsePromise = responder.respond(base);
  await Promise.resolve();
  await Promise.resolve();

  const first = responder.stopActiveConversationRun({ conversationId: "g_1" });
  const second = responder.stopActiveConversationRun({ conversationId: "g_1", runId: first.runId });

  assert.deepEqual(second, {
    stopped: true,
    conversationId: "g_1",
    runId: first.runId,
    turnId: "t_1",
    status: "cancelling"
  });
  assert.equal(calls.cloudEvents.filter((event) => event.event?.type === "run.cancelling").length, 1);

  await responsePromise;
});

test("stopActiveConversationRun matches the active turn id even when run ids differ", async () => {
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
  const staleRun = responder.stopActiveConversationRun({
    conversationId: "g_1",
    runId: "cloud_run_mismatch",
    turnId: "wrong_turn"
  });
  assert.deepEqual(staleRun, { stopped: false });
  assert.equal(calls.engine[0].signal.aborted, false);

  const stopResult = responder.stopActiveConversationRun({
    conversationId: "g_1",
    runId: "cloud_run_mismatch",
    turnId: "t_1"
  });

  assert.equal(stopResult.stopped, true);
  assert.equal(stopResult.runId, calls.cloudEvents[0].runId);
  assert.equal(stopResult.turnId, "t_1");
  assert.equal(calls.engine[0].signal.aborted, true);

  await responsePromise;
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

test("respond queues the latest same-conversation invocation instead of dropping it", async () => {
  const firstTurn = deferred();
  const calls = { engine: [], post: [], log: [], cloudEvents: [] };
  const responder = createLocalBotResponder({
    sendChat: async (args) => {
      calls.engine.push(args);
      if (calls.engine.length === 1) {
        await firstTurn.promise;
        return { choices: [{ message: { content: "first reply" } }] };
      }
      return { choices: [{ message: { content: `reply to ${args.messages.at(-1).content}` } }] };
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    log: (line) => calls.log.push(line)
  });

  const first = responder.respond({ ...base, dedupKey: "m_1:codex", userPrompt: "first", turnId: "t_1" });
  await waitFor(() => calls.engine.length === 1);

  const secondHandled = await responder.respond({ ...base, dedupKey: "m_2:codex", userPrompt: "second", turnId: "t_2" });
  const thirdHandled = await responder.respond({ ...base, dedupKey: "m_3:codex", userPrompt: "third", turnId: "t_3" });

  assert.equal(secondHandled, false);
  assert.equal(thirdHandled, false);
  assert.equal(calls.engine.length, 1);

  firstTurn.resolve();
  await first;
  await waitFor(() => calls.engine.length === 2 && calls.post.length === 2);

  assert.equal(calls.engine[0].messages.at(-1).content, "first");
  assert.equal(calls.engine[1].messages.at(-1).content, "third");
  assert.equal(calls.post[0].body.bodyMd, "first reply");
  assert.equal(calls.post[1].body.bodyMd, "reply to third");
  assert.equal(calls.post[1].body.turnId, "t_3");
  assert.equal(calls.log.some((line) => line.includes("queue m_2:codex")), true);
  assert.equal(calls.log.some((line) => line.includes("queue m_3:codex")), true);
});

test("respond hands same-conversation AgentSession sends to the manager immediately instead of queueing local sendChat work", async () => {
  const releaseFirst = deferred();
  const calls = { engine: [], manager: [], post: [], log: [], cloudEvents: [] };
  const responder = createLocalBotResponder({
    sendChat: async (args) => {
      calls.engine.push(args);
      return { choices: [{ message: { content: "should not run" } }] };
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    log: (line) => calls.log.push(line),
    agentSessionManager: {
      sendUserInput: async (input) => {
        calls.manager.push(input);
        if (calls.manager.length === 1) {
          await releaseFirst.promise;
          return {
            ok: true,
            mode: "started",
            conversationId: input.conversationId,
            engineId: input.engineId,
            turnId: input.turnId
          };
        }
        return {
          ok: true,
          mode: "queued",
          conversationId: input.conversationId,
          engineId: input.engineId,
          turnId: input.turnId,
          queueDepth: 1
        };
      }
    },
    agentSessionWorkspacePath: () => "/repo/workspace"
  });

  const first = responder.respond({
    ...base,
    dedupKey: "m_1:codex",
    userPrompt: "first",
    turnId: "t_1",
    runtimeConfig: { agentEngine: "claude" },
    historyMessages: [{ role: "user", content: "older visible history" }]
  });
  await waitFor(() => calls.manager.length === 1);

  const second = responder.respond({
    ...base,
    dedupKey: "m_2:codex",
    userPrompt: "second",
    turnId: "t_2",
    runtimeConfig: { agentEngine: "claude" },
    historyMessages: [{ role: "assistant", content: "should not be replayed" }]
  });
  await waitFor(() => calls.manager.length === 2);

  assert.equal(calls.engine.length, 0);
  assert.deepEqual(calls.manager, [
    {
      conversationId: "g_1",
      engineId: "claude",
      workspacePath: "/repo/workspace",
      turnId: "t_1",
      text: "first"
    },
    {
      conversationId: "g_1",
      engineId: "claude",
      workspacePath: "/repo/workspace",
      turnId: "t_2",
      text: "second"
    }
  ]);
  assert.equal(calls.log.some((line) => line.includes("queue m_2:codex")), false);

  releaseFirst.resolve();
  assert.equal(await first, true);
  assert.equal(await second, true);
});

test("managed AgentSession turns pass prepared Claude Code Mia runtime env to the manager", async () => {
  const calls = { manager: [], runtime: [], post: [], log: [], cloudEvents: [] };
  const responder = createLocalBotResponder({
    sendChat: async () => {
      throw new Error("sendChat should not run for managed AgentSession turns");
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    log: (line) => calls.log.push(line),
    agentSessionManager: {
      sendUserInput: async (input) => {
        calls.manager.push(input);
        return {
          ok: true,
          mode: "started",
          conversationId: input.conversationId,
          engineId: input.engineId,
          turnId: input.turnId
        };
      }
    },
    agentSessionWorkspacePath: () => "/repo/workspace",
    prepareAgentSessionRuntime: async (args) => {
      calls.runtime.push(args);
      return {
        runtimeKey: "mia:mia-auto",
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
          ANTHROPIC_AUTH_TOKEN: "proxy-token"
        }
      };
    }
  });

  await responder.respond({
    ...base,
    dedupKey: "m_managed_runtime:claude",
    turnId: "t_runtime",
    botSnapshot: { key: "starter_100001_claude_code", name: "Claude", agentEngine: "claude-code" },
    runtimeConfig: {
      agentEngine: "claude-code",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto"
    }
  });

  assert.equal(calls.runtime.length, 1);
  assert.equal(calls.runtime[0].engineId, "claude");
  assert.deepEqual(calls.manager, [{
    conversationId: "g_1",
    engineId: "claude",
    workspacePath: "/repo/workspace",
    runtimeKey: "mia:mia-auto",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
      ANTHROPIC_AUTH_TOKEN: "proxy-token"
    },
    turnId: "t_runtime",
    text: "hi"
  }]);
});

test("managed AgentSession turns pass prepared MCP session config to the manager", async () => {
  const refreshMcpContext = async () => {};
  const mcpServers = [{
    name: "mia-app",
    command: "/usr/bin/node",
    args: ["/tmp/mia-app.js"],
    env: [{ name: "MIA_DAEMON_URL", value: "http://127.0.0.1:27861" }]
  }];
  const calls = { manager: [], runtime: [], post: [], log: [], cloudEvents: [] };
  const responder = createLocalBotResponder({
    sendChat: async () => {
      throw new Error("sendChat should not run for managed AgentSession turns");
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    log: (line) => calls.log.push(line),
    agentSessionManager: {
      sendUserInput: async (input) => {
        calls.manager.push(input);
        return {
          ok: true,
          mode: "started",
          conversationId: input.conversationId,
          engineId: input.engineId,
          turnId: input.turnId
        };
      }
    },
    agentSessionWorkspacePath: () => "/repo/workspace",
    prepareAgentSessionRuntime: async (args) => {
      calls.runtime.push(args);
      return {
        mcpFingerprint: "mcp-abc",
        mcpServers,
        refreshMcpContext,
        initialPromptPrefix: "## Mia Scoped Context"
      };
    }
  });

  await responder.respond({
    ...base,
    dedupKey: "m_managed_mcp:codex",
    turnId: "t_mcp",
    botSnapshot: { key: "starter_100002_codex", name: "Codex", agentEngine: "codex" },
    runtimeConfig: { agentEngine: "codex" }
  });

  assert.equal(calls.runtime.length, 1);
  assert.equal(calls.runtime[0].engineId, "codex");
  assert.deepEqual(calls.manager, [{
    conversationId: "g_1",
    engineId: "codex",
    workspacePath: "/repo/workspace",
    mcpFingerprint: "mcp-abc",
    mcpServers,
    refreshMcpContext,
    initialPromptPrefix: "## Mia Scoped Context",
    turnId: "t_mcp",
    text: "hi"
  }]);
});

test("managed AgentSession turns pass prompt-fallback skill metadata to the manager", async () => {
  const calls = { manager: [], runtime: [], post: [], log: [], cloudEvents: [] };
  const responder = createLocalBotResponder({
    sendChat: async () => {
      throw new Error("sendChat should not run for managed AgentSession turns");
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    log: (line) => calls.log.push(line),
    agentSessionManager: {
      sendUserInput: async (input) => {
        calls.manager.push(input);
        return {
          ok: true,
          mode: "started",
          conversationId: input.conversationId,
          engineId: input.engineId,
          turnId: input.turnId
        };
      }
    },
    agentSessionWorkspacePath: () => "/repo/workspace",
    prepareAgentSessionRuntime: async (args) => {
      calls.runtime.push(args);
      return {
        skillFingerprint: "skills:abc",
        turnPromptPrefix: "## Prompt Fallback",
        skillFallback: {
          maxRounds: 2,
          detectRequests: () => [],
          materializePrompt: async () => "",
          fallbackText: () => ""
        }
      };
    }
  });

  await responder.respond({
    ...base,
    dedupKey: "m_managed_skill_fallback:openclaw",
    turnId: "t_skill_fallback",
    botSnapshot: { key: "starter_100003_openclaw", name: "OpenClaw", agentEngine: "openclaw" },
    runtimeConfig: { agentEngine: "openclaw" }
  });

  assert.equal(calls.runtime.length, 1);
  assert.deepEqual(calls.manager, [{
    conversationId: "g_1",
    engineId: "openclaw",
    workspacePath: "/repo/workspace",
    skillFingerprint: "skills:abc",
    turnPromptPrefix: "## Prompt Fallback",
    skillFallback: {
      maxRounds: 2,
      detectRequests: calls.manager[0]?.skillFallback?.detectRequests,
      materializePrompt: calls.manager[0]?.skillFallback?.materializePrompt,
      fallbackText: calls.manager[0]?.skillFallback?.fallbackText
    },
    turnId: "t_skill_fallback",
    text: "hi"
  }]);
  assert.equal(typeof calls.manager[0].skillFallback.detectRequests, "function");
  assert.equal(typeof calls.manager[0].skillFallback.materializePrompt, "function");
  assert.equal(typeof calls.manager[0].skillFallback.fallbackText, "function");
});

test("starter engine bot ids route visible replies through AgentSession without runtime config", async () => {
  const calls = { manager: [], post: [], cloudEvents: [] };
  const responder = createLocalBotResponder({
    sendChat: async () => {
      throw new Error("sendChat should not run for starter AgentSession bots");
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    agentSessionManager: {
      sendUserInput: async (input) => {
        calls.manager.push(input);
        return {
          ok: true,
          mode: "started",
          conversationId: input.conversationId,
          engineId: input.engineId,
          turnId: input.turnId
        };
      }
    },
    agentSessionWorkspacePath: () => "/repo/workspace"
  });

  assert.equal(await responder.respond({
    ...base,
    conversationId: "bot:u_1:codex",
    botId: "codex",
    dedupKey: "m_starter_codex:codex",
    turnId: "t_starter",
    userPrompt: "hello"
  }), true);

  assert.deepEqual(calls.manager, [{
    conversationId: "bot:u_1:codex",
    engineId: "codex",
    workspacePath: "/repo/workspace",
    turnId: "t_starter",
    text: "hello"
  }]);
  assert.equal(calls.post.length, 0);
});

test("managed AgentSession deltas are streamed and posted as the bot reply", async () => {
  const manager = new EventEmitter();
  const calls = { manager: [], post: [], log: [], cloudEvents: [] };
  manager.sendUserInput = async (input) => {
    calls.manager.push(input);
    return {
      ok: true,
      mode: "started",
      conversationId: input.conversationId,
      engineId: input.engineId,
      turnId: input.turnId
    };
  };
  const responder = createLocalBotResponder({
    sendChat: async () => {
      throw new Error("sendChat should not run for managed AgentSession turns");
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true, message: { id: "posted_1", ...body } };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    log: (line) => calls.log.push(line),
    agentSessionManager: manager,
    agentSessionWorkspacePath: () => "/repo/workspace"
  });

  await responder.respond({
    ...base,
    dedupKey: "m_managed:claude",
    turnId: "t_managed",
    runtimeConfig: { agentEngine: "claude" }
  });

  manager.emit("assistant-delta", {
    conversationId: "g_1",
    engineId: "claude",
    turnId: "t_managed",
    text: "hello "
  });
  manager.emit("assistant-delta", {
    conversationId: "g_1",
    engineId: "claude",
    turnId: "t_managed",
    text: "world"
  });
  manager.emit("message-completed", {
    conversationId: "g_1",
    engineId: "claude",
    turnId: "t_managed"
  });

  await waitFor(() => calls.post.length === 1);
  assert.equal(calls.post[0].conversationId, "g_1");
  assert.deepEqual(calls.post[0].body, {
    botId: "codex",
    bodyMd: "hello world",
    turnId: "t_managed",
    clientOpId: "op_bot_reply_m_managed_claude",
    contentBlocks: [{ type: "text", id: "t_managed", text: "hello world" }]
  });
  const runEvents = calls.cloudEvents.filter((event) => event.type !== "conversation.message_appended");
  assert.deepEqual(runEvents.map((event) => event.type), [
    "cloud_agent_run_started",
    "cloud_agent_run_event",
    "cloud_agent_run_event",
    "cloud_agent_run_event"
  ]);
  assert.deepEqual(runEvents.slice(1).map((event) => event.event.type), [
    "text_delta",
    "text_delta",
    "run.completed"
  ]);
});

test("managed AgentSession failures post a visible bot error", async () => {
  const manager = new EventEmitter();
  const calls = { manager: [], post: [], log: [], cloudEvents: [] };
  manager.sendUserInput = async (input) => {
    calls.manager.push(input);
    return {
      ok: true,
      mode: "started",
      conversationId: input.conversationId,
      engineId: input.engineId,
      turnId: input.turnId
    };
  };
  const responder = createLocalBotResponder({
    sendChat: async () => {
      throw new Error("sendChat should not run for managed AgentSession turns");
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    log: (line) => calls.log.push(line),
    agentSessionManager: manager,
    agentSessionWorkspacePath: () => "/repo/workspace"
  });

  await responder.respond({
    ...base,
    dedupKey: "m_failed:codex",
    turnId: "t_failed",
    runtimeConfig: { agentEngine: "codex" }
  });

  manager.emit("message-failed", {
    conversationId: "g_1",
    engineId: "codex",
    turnId: "t_failed",
    error: new Error("401 Invalid authentication credentials")
  });

  await waitFor(() => calls.post.length === 1);
  assert.equal(calls.post[0].conversationId, "g_1");
  assert.equal(calls.post[0].body.botId, "codex");
  assert.equal(calls.post[0].body.turnId, "t_failed");
  assert.equal(calls.post[0].body.clientOpId, "op_bot_reply_error_m_failed_codex");
  assert.match(calls.post[0].body.bodyMd, /^我这次没能生成回复：本地引擎认证失败。/);
  assert.deepEqual(calls.cloudEvents.at(-1).event, {
    type: "run.failed",
    error: "401 Invalid authentication credentials"
  });
});

test("managed AgentSession startup failures emitted before acceptance are not lost", async () => {
  const manager = new EventEmitter();
  const calls = { manager: [], post: [], log: [], cloudEvents: [] };
  manager.sendUserInput = async (input) => {
    calls.manager.push(input);
    manager.emit("message-failed", {
      conversationId: input.conversationId,
      engineId: input.engineId,
      turnId: input.turnId,
      error: new Error("ACP bridge failed: connect ECONNREFUSED 127.0.0.1:18789")
    });
    return {
      ok: true,
      mode: "started",
      conversationId: input.conversationId,
      engineId: input.engineId,
      turnId: input.turnId
    };
  };
  const responder = createLocalBotResponder({
    sendChat: async () => {
      throw new Error("sendChat should not run for managed AgentSession turns");
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    log: (line) => calls.log.push(line),
    agentSessionManager: manager,
    agentSessionWorkspacePath: () => "/repo/workspace"
  });

  await responder.respond({
    ...base,
    dedupKey: "m_start_failed:codex",
    turnId: "t_start_failed",
    runtimeConfig: { agentEngine: "codex" }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.post.length, 1);
  assert.equal(calls.post[0].conversationId, "g_1");
  assert.equal(calls.post[0].body.botId, "codex");
  assert.equal(calls.post[0].body.turnId, "t_start_failed");
  assert.equal(calls.post[0].body.clientOpId, "op_bot_reply_error_m_start_failed_codex");
  assert.match(calls.post[0].body.bodyMd, /^我这次没能生成回复：本地引擎连接失败。/);
  assert.equal(
    calls.cloudEvents.filter((event) => event.type === "cloud_agent_run_started").length,
    0
  );
  assert.deepEqual(calls.cloudEvents.at(-1).event, {
    type: "run.failed",
    error: "ACP bridge failed: connect ECONNREFUSED 127.0.0.1:18789"
  });
});

test("managed AgentSession queued turns keep separate reply metadata", async () => {
  const manager = new EventEmitter();
  const calls = { manager: [], post: [], log: [], cloudEvents: [] };
  manager.sendUserInput = async (input) => {
    calls.manager.push(input);
    return {
      ok: true,
      mode: calls.manager.length === 1 ? "started" : "queued",
      conversationId: input.conversationId,
      engineId: input.engineId,
      turnId: input.turnId,
      ...(calls.manager.length === 1 ? {} : { queueDepth: 1 })
    };
  };
  const responder = createLocalBotResponder({
    sendChat: async () => {
      throw new Error("sendChat should not run for managed AgentSession turns");
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true, message: { id: `posted_${calls.post.length}`, ...body } };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    log: (line) => calls.log.push(line),
    agentSessionManager: manager,
    agentSessionWorkspacePath: () => "/repo/workspace"
  });

  await responder.respond({
    ...base,
    dedupKey: "m_first:codex",
    turnId: "t_first",
    userPrompt: "first",
    runtimeConfig: { agentEngine: "codex" }
  });
  await responder.respond({
    ...base,
    dedupKey: "m_second:codex",
    turnId: "t_second",
    userPrompt: "second",
    runtimeConfig: { agentEngine: "codex" }
  });

  manager.emit("assistant-delta", { conversationId: "g_1", turnId: "t_first", text: "first reply" });
  manager.emit("message-completed", { conversationId: "g_1", turnId: "t_first" });
  await waitFor(() => calls.post.length === 1);
  manager.emit("message-started", { conversationId: "g_1", turnId: "t_second" });
  manager.emit("assistant-delta", { conversationId: "g_1", turnId: "t_second", text: "second reply" });
  manager.emit("message-completed", { conversationId: "g_1", turnId: "t_second" });

  await waitFor(() => calls.post.length === 2);
  assert.deepEqual(calls.post.map((item) => ({
    bodyMd: item.body.bodyMd,
    turnId: item.body.turnId,
    clientOpId: item.body.clientOpId
  })), [
    {
      bodyMd: "first reply",
      turnId: "t_first",
      clientOpId: "op_bot_reply_m_first_codex"
    },
    {
      bodyMd: "second reply",
      turnId: "t_second",
      clientOpId: "op_bot_reply_m_second_codex"
    }
  ]);
  const runEvents = calls.cloudEvents.filter((event) => event.type !== "conversation.message_appended");
  assert.deepEqual(runEvents.map((event) => ({
    type: event.type,
    runId: event.runId,
    eventType: event.event?.type || ""
  })), [
    { type: "cloud_agent_run_started", runId: "local_bot_reply_m_first_codex", eventType: "" },
    { type: "cloud_agent_run_event", runId: "local_bot_reply_m_first_codex", eventType: "text_delta" },
    { type: "cloud_agent_run_event", runId: "local_bot_reply_m_first_codex", eventType: "run.completed" },
    { type: "cloud_agent_run_started", runId: "local_bot_reply_m_second_codex", eventType: "" },
    { type: "cloud_agent_run_event", runId: "local_bot_reply_m_second_codex", eventType: "text_delta" },
    { type: "cloud_agent_run_event", runId: "local_bot_reply_m_second_codex", eventType: "run.completed" }
  ]);
});

test("stopActiveConversationRun cancels an AgentSession-backed social run using the stored session descriptor", async () => {
  const calls = { engine: [], manager: [], cancel: [], post: [], log: [], cloudEvents: [] };
  const responder = createLocalBotResponder({
    sendChat: async (args) => {
      calls.engine.push(args);
      return { choices: [{ message: { content: "should not run" } }] };
    },
    postConversationMessageAsBot: async (conversationId, body) => {
      calls.post.push({ conversationId, body });
      return { ok: true };
    },
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    log: (line) => calls.log.push(line),
    agentSessionManager: {
      sendUserInput: async (input) => {
        calls.manager.push(input);
        return {
          ok: true,
          mode: "started",
          conversationId: input.conversationId,
          engineId: input.engineId,
          turnId: input.turnId
        };
      },
      cancelActive: async (descriptor) => {
        calls.cancel.push(descriptor);
        return true;
      }
    },
    agentSessionWorkspacePath: () => "/repo/workspace"
  });

  assert.equal(await responder.respond({
    ...base,
    dedupKey: "m_stop:codex",
    userPrompt: "first",
    turnId: "t_stop",
    runtimeConfig: { agentEngine: "claude" }
  }), true);

  const stopResult = await responder.stopActiveConversationRun({
    conversationId: "g_1",
    runId: "car_managed_1",
    turnId: "t_stop"
  });

  assert.deepEqual(calls.cancel, [{
    conversationId: "g_1",
    engineId: "claude",
    workspacePath: "/repo/workspace"
  }]);
  assert.deepEqual(stopResult, {
    stopped: true,
    conversationId: "g_1",
    runId: "car_managed_1",
    turnId: "t_stop",
    status: "cancelling"
  });
  assert.deepEqual(calls.cloudEvents.map((event) => ({
    type: event.type,
    runId: event.runId,
    eventType: event.event?.type || ""
  })), [
    { type: "cloud_agent_run_started", runId: "local_bot_reply_m_stop_codex", eventType: "" },
    { type: "cloud_agent_run_event", runId: "local_bot_reply_m_stop_codex", eventType: "run.cancelling" }
  ]);
});

test("stopActiveConversationRun preserves runtime-scoped AgentSession descriptor fields", async () => {
  const calls = { manager: [], runtime: [], cancel: [], cloudEvents: [] };
  const responder = createLocalBotResponder({
    sendChat: async () => {
      throw new Error("sendChat should not run for managed AgentSession turns");
    },
    postConversationMessageAsBot: async () => ({ ok: true }),
    emitCloudEvent: (event) => calls.cloudEvents.push(event),
    agentSessionManager: {
      sendUserInput: async (input) => {
        calls.manager.push(input);
        return {
          ok: true,
          mode: "started",
          conversationId: input.conversationId,
          engineId: input.engineId,
          turnId: input.turnId
        };
      },
      cancelActive: async (descriptor) => {
        calls.cancel.push(descriptor);
        return true;
      }
    },
    agentSessionWorkspacePath: () => "/repo/workspace",
    prepareAgentSessionRuntime: async (args) => {
      calls.runtime.push(args);
      return {
        runtimeKey: "mia:mia-auto",
        mcpFingerprint: "mcp-abc",
        skillFingerprint: "skills:abc"
      };
    }
  });

  assert.equal(await responder.respond({
    ...base,
    dedupKey: "m_stop_runtime_scoped:codex",
    turnId: "t_stop_runtime_scoped",
    botSnapshot: { key: "starter_100002_codex", name: "Codex", agentEngine: "codex" },
    runtimeConfig: { agentEngine: "codex" }
  }), true);

  const stopResult = await responder.stopActiveConversationRun({
    conversationId: "g_1",
    turnId: "t_stop_runtime_scoped"
  });

  assert.deepEqual(calls.cancel, [{
    conversationId: "g_1",
    engineId: "codex",
    workspacePath: "/repo/workspace",
    runtimeKey: "mia:mia-auto",
    mcpFingerprint: "mcp-abc",
    skillFingerprint: "skills:abc"
  }]);
  assert.equal(stopResult.stopped, true);
});

test("managed AgentSession workspace validation failure does not poison retries for the same dedupKey", async () => {
  let workspacePath = "";
  const calls = { manager: [] };
  const responder = createLocalBotResponder({
    sendChat: async () => {
      throw new Error("sendChat should not run");
    },
    postConversationMessageAsBot: async () => ({ ok: true }),
    agentSessionManager: {
      sendUserInput: async (input) => {
        calls.manager.push(input);
        return {
          ok: true,
          mode: "started",
          conversationId: input.conversationId,
          engineId: input.engineId,
          turnId: input.turnId
        };
      }
    },
    agentSessionWorkspacePath: () => workspacePath
  });

  await assert.rejects(
    responder.respond({
      ...base,
      dedupKey: "m_retry:codex",
      turnId: "t_retry",
      runtimeConfig: { agentEngine: "claude" }
    }),
    /AgentSession workspace path is required/
  );

  workspacePath = "/repo/workspace";

  assert.equal(await responder.respond({
    ...base,
    dedupKey: "m_retry:codex",
    turnId: "t_retry",
    runtimeConfig: { agentEngine: "claude" }
  }), true);
  assert.deepEqual(calls.manager, [{
    conversationId: "g_1",
    engineId: "claude",
    workspacePath: "/repo/workspace",
    turnId: "t_retry",
    text: "hi"
  }]);
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
