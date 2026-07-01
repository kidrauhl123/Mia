const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHermesChatAdapter } = require("../src/main/hermes-chat-adapter.js");
const { createHermesRunService } = require("../src/main/hermes-run-service.js");
const { clearNativeMemoryCache } = require("../src/main/native-memory-context.js");
const { clearNativeSkillIndexCache } = require("../src/main/native-skill-context.js");

function response({ ok = true, status = 200, statusText = "OK", body = {} } = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => typeof body === "string" ? body : JSON.stringify(body)
  };
}

function createDeps(overrides = {}) {
  const fetchCalls = [];
  const streamCalls = [];
  const schedulerContextWrites = [];
  const miaAppContextWrites = [];
  const deps = {
    fetchCalls,
    streamCalls,
    schedulerContextWrites,
    miaAppContextWrites,
    writeSchedulerMcpContext: (ctx) => { schedulerContextWrites.push(ctx); },
    writeMiaAppMcpContext: (ctx) => { miaAppContextWrites.push(ctx); },
    apiKey: () => "secret",
    baseUrl: () => "http://hermes.test",
    buildGroupHeader: (contextBlock) => `group:${contextBlock}`,
    buildRunPayload: ({ bot, sessionId, messages }) => ({
      model: "hermes-agent",
      input: messages?.at(-1)?.content || "",
      session_id: sessionId || "default",
      account_id: bot.key,
      metadata: { bot_id: bot.key }
    }),
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return overrides.fetchResponse || response({ body: { run_id: "run_1" } });
    },
    normalizeError: (message) => `normalized:${message}`,
    nowSeconds: () => 123,
    randomUUID: () => "uuid_1",
    readRunEventStream: async (input) => {
      streamCalls.push(input);
      return overrides.stream || {
        content: "assistant text",
        finishReason: "stop",
        events: [{ event: "run.completed" }]
      };
    },
    responseModel: "hermes-agent",
    memoryBlock: overrides.memoryBlock || (() => ""),
    ...overrides
  };
  return deps;
}

const bot = { key: "alice", name: "Alice" };

function hermesRunPayloadBuilder() {
  return createHermesRunService({
    normalizeAttachments: (attachments) => Array.isArray(attachments) ? attachments : [],
    attachmentContext: () => "",
    baseUrl: () => "http://hermes.test",
    apiKey: () => "secret"
  }).buildRunPayload;
}

test("slashCommandResponse returns chat completion shape", () => {
  const adapter = createHermesChatAdapter(createDeps());
  const responseBody = adapter.slashCommandResponse({ id: "cmd_1", content: "" });
  assert.equal(responseBody.id, "cmd_1");
  assert.equal(responseBody.object, "chat.completion");
  assert.equal(responseBody.created, 123);
  assert.equal(responseBody.model, "hermes-agent");
  assert.equal(responseBody.choices[0].message.content, "(command completed)");
  assert.equal(responseBody.choices[0].finish_reason, "stop");
});

test("sendChat posts Hermes run with bot and group headers", async () => {
  const deps = createDeps();
  const adapter = createHermesChatAdapter(deps);
  const emitted = [];
  const result = await adapter.sendChat({
    bot,
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }],
    group: { contextBlock: "ctx" },
    signal: null,
    emit: (kind, data) => emitted.push({ kind, data })
  });

  assert.equal(deps.fetchCalls.length, 1);
  assert.equal(deps.fetchCalls[0].url, "http://hermes.test/v1/runs");
  assert.deepEqual(deps.fetchCalls[0].options.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer secret",
    "X-Mia-Bot": "alice",
    "X-Alkaka-Bot": "alice",
    "X-Mia-Group-Context": "group:ctx"
  });
  assert.deepEqual(JSON.parse(deps.fetchCalls[0].options.body), {
    model: "hermes-agent",
    input: "hi",
    session_id: "s1",
    account_id: "alice",
    metadata: { bot_id: "alice" }
  });
  assert.equal(deps.streamCalls[0].runId, "run_1");
  assert.equal(result.id, "run_1");
  assert.equal(result.choices[0].message.content, "assistant text");
  assert.deepEqual(result.mia, {
    transport: "runs",
    run_id: "run_1",
    session_id: "s1",
    bot_id: "alice",
    events: [{ event: "run.completed" }]
  });
  assert.deepEqual(emitted, [
    { kind: "complete", data: { finishReason: "stop", aborted: false } }
  ]);
});

test("sendChat resolves Hermes approval requests through the permission coordinator", async () => {
  const permissionCalls = [];
  const approvalPosts = [];
  const deps = createDeps({
    permissionCoordinator: {
      requestPermission: async (request) => {
        permissionCalls.push(request);
        return { decision: "allow", scope: "once" };
      }
    },
    submitRunApproval: async (input) => {
      approvalPosts.push(input);
      return { ok: true };
    },
    readRunEventStream: async ({ runId, onApprovalRequest }) => {
      await onApprovalRequest({
        runId,
        event: {
          event: "approval.request",
          run_id: runId,
          tool: "terminal",
          command: "python3 read_docx.py"
        }
      });
      return { content: "done", finishReason: "stop", events: [] };
    }
  });
  const adapter = createHermesChatAdapter(deps);
  const emitted = [];

  const result = await adapter.sendChat({
    bot,
    sessionId: "s1",
    messages: [{ role: "user", content: "read file" }],
    signal: null,
    emit: (kind, data) => emitted.push({ kind, data })
  });

  assert.equal(result.choices[0].message.content, "done");
  assert.equal(permissionCalls.length, 1);
  assert.equal(permissionCalls[0].engine, "hermes");
  assert.equal(permissionCalls[0].botKey, "alice");
  assert.equal(permissionCalls[0].sessionId, "s1");
  assert.equal(permissionCalls[0].toolName, "terminal");
  assert.equal(permissionCalls[0].input.command, "python3 read_docx.py");
  assert.equal(typeof permissionCalls[0].emit, "function");
  assert.deepEqual(approvalPosts, [{ runId: "run_1", choice: "once", signal: null }]);
});

test("sendChat maps Hermes non-ask approval modes without waiting for hidden UI prompts", async () => {
  async function runWithPermissionMode(permissionMode) {
    const permissionCalls = [];
    const approvalPosts = [];
    const deps = createDeps({
      permissionCoordinator: {
        requestPermission: async (request) => {
          permissionCalls.push(request);
          return { decision: "allow", scope: "once" };
        }
      },
      submitRunApproval: async (input) => {
        approvalPosts.push(input);
        return { ok: true };
      },
      readRunEventStream: async ({ runId, onApprovalRequest }) => {
        await onApprovalRequest({
          runId,
          event: {
            event: "approval.request",
            run_id: runId,
            tool: "terminal",
            command: "python3 read_docx.py"
          }
        });
        return { content: "done", finishReason: "stop", events: [] };
      }
    });
    const adapter = createHermesChatAdapter(deps);
    await adapter.sendChat({
      bot,
      sessionId: "s1",
      messages: [{ role: "user", content: "read file" }],
      runtimeConfig: { permissionMode },
      signal: null,
      emit: () => {}
    });
    return { permissionCalls, approvalPosts };
  }

  const yolo = await runWithPermissionMode("yolo");
  assert.equal(yolo.permissionCalls.length, 0);
  assert.deepEqual(yolo.approvalPosts, [{ runId: "run_1", choice: "once", signal: null }]);

  const denied = await runWithPermissionMode("deny");
  assert.equal(denied.permissionCalls.length, 0);
  assert.deepEqual(denied.approvalPosts, [{ runId: "run_1", choice: "deny", signal: null }]);
});

test("sendChat passes runtime config into Hermes run payload builder", async () => {
  const buildCalls = [];
  const deps = createDeps({
    buildRunPayload: (input) => {
      buildCalls.push(input);
      return {
        model: input.model,
        input: input.messages?.at(-1)?.content || "",
        session_id: input.sessionId || "default",
        account_id: input.bot.key,
        metadata: {
          bot_id: input.bot.key,
          effort_level: input.effortLevel,
          permission_mode: input.permissionMode
        }
      };
    }
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot,
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }],
    runtimeConfig: {
      model: "mia-pro",
      effortLevel: "high",
      permissionMode: "auto"
    },
    signal: null
  });

  assert.equal(buildCalls[0].model, "mia-pro");
  assert.equal(buildCalls[0].effortLevel, "high");
  assert.equal(buildCalls[0].permissionMode, "auto");
  assert.equal(JSON.parse(deps.fetchCalls[0].options.body).model, "mia-pro");
});

test("sendChat uses Hermes native session history by default for persistent bot turns", async () => {
  const deps = createDeps({
    buildRunPayload: hermesRunPayloadBuilder()
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot,
    sessionId: "s1",
    persistAgentSession: true,
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "last" }
    ],
    signal: null
  });

  const body = JSON.parse(deps.fetchCalls[0].options.body);
  assert.equal(body.input, "last");
  assert.equal(body.session_id, "mia:alice:s1");
  assert.equal(body.conversation_history, undefined);
});

test("sendChat can keep legacy Hermes conversation-only session scope", async () => {
  const deps = createDeps({
    buildRunPayload: hermesRunPayloadBuilder()
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot,
    sessionId: "s1",
    persistAgentSession: true,
    runtimeConfig: { hermesSessionScope: "conversation" },
    messages: [
      { role: "user", content: "last" }
    ],
    signal: null
  });

  const body = JSON.parse(deps.fetchCalls[0].options.body);
  assert.equal(body.session_id, "s1");
});

test("sendChat logs Hermes context budget without prompt bodies", async () => {
  const logs = [];
  const deps = createDeps({
    appendEngineLog: (line) => logs.push(line),
    buildRunPayload: hermesRunPayloadBuilder(),
    memoryBlock: () => "secret-memory"
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot,
    sessionId: "s1",
    persistAgentSession: true,
    messages: [
      { role: "user", content: "secret-history" },
      { role: "assistant", content: "secret-reply" },
      { role: "user", content: "secret-last" }
    ],
    skillMaterialization: {
      indexBlock: "secret-index",
      loadedBlock: "secret-loaded"
    },
    signal: null
  });

  const budget = logs.find((line) => line.includes("[Mia context budget]"));
  assert.match(budget, /engine=hermes/);
  assert.match(budget, /nativeSession=mia:alice:s1/);
  assert.match(budget, /historyMode=native/);
  assert.match(budget, /nativeHistory=1/);
  assert.match(budget, /visibleHistoryChars=[1-9]\d*/);
  assert.match(budget, /includedHistoryChars=0/);
  assert.match(budget, /memoryChars=[1-9]\d*/);
  assert.match(budget, /skillIndexChars=[1-9]\d*/);
  assert.match(budget, /loadedSkillChars=[1-9]\d*/);
  assert.doesNotMatch(budget, /secret-/);
});

test("sendChat ignores legacy Hermes bridge history config for persistent native turns", async () => {
  const deps = createDeps({
    buildRunPayload: hermesRunPayloadBuilder()
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot: { ...bot, engineConfig: { hermesHistoryMode: "bridge" } },
    sessionId: "s1",
    persistAgentSession: true,
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "last" }
    ],
    signal: null
  });

  const body = JSON.parse(deps.fetchCalls[0].options.body);
  assert.equal(body.input, "last");
  assert.equal(body.conversation_history, undefined);
});

test("sendChat bridges visible history when Hermes native persistence is disabled", async () => {
  const deps = createDeps({
    buildRunPayload: hermesRunPayloadBuilder()
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot,
    sessionId: "s1",
    persistAgentSession: false,
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "last" }
    ],
    signal: null
  });

  const body = JSON.parse(deps.fetchCalls[0].options.body);
  assert.deepEqual(body.conversation_history, [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" }
  ]);
});

test("sendChat prepends materialized skill context to the last user turn", async () => {
  clearNativeSkillIndexCache();
  const deps = createDeps();
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot,
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }],
    skillMaterialization: {
      indexBlock: "## Available Mia Skills\n\n- demo: Demo index.",
      loadedBlock: "## Loaded Mia Skill Guides\n\n=== Skill: demo ===\nDemo body.\n=== End Skill ==="
    },
    signal: null
  });

  const body = JSON.parse(deps.fetchCalls[0].options.body);
  assert.match(body.input, /^## Available Mia Skills/);
  assert.match(body.input, /Loaded Mia Skill Guides/);
  assert.match(body.input, /\n\nhi$/);
});

test("sendChat injects Hermes skill index once per native session but keeps loaded skills", async () => {
  clearNativeSkillIndexCache();
  const deps = createDeps({
    buildRunPayload: hermesRunPayloadBuilder()
  });
  const adapter = createHermesChatAdapter(deps);
  const skillMaterialization = {
    indexBlock: "## Available Mia Skills\n\n- demo: Demo index.",
    loadedBlock: "## Loaded Mia Skill Guides\n\n=== Skill: demo ===\nDemo body.\n=== End Skill ==="
  };

  await adapter.sendChat({
    bot,
    sessionId: "s1",
    messages: [{ role: "user", content: "first" }],
    skillMaterialization,
    signal: null
  });
  await adapter.sendChat({
    bot,
    sessionId: "s1",
    messages: [{ role: "user", content: "second" }],
    skillMaterialization,
    signal: null
  });

  const first = JSON.parse(deps.fetchCalls[0].options.body).input;
  const second = JSON.parse(deps.fetchCalls[1].options.body).input;
  assert.match(first, /Available Mia Skills/);
  assert.match(first, /Loaded Mia Skill Guides/);
  assert.doesNotMatch(second, /Available Mia Skills/);
  assert.match(second, /Loaded Mia Skill Guides/);
});

test("sendChat resolves Mia managed models into Hermes runtime config", async () => {
  const writes = [];
  const deps = createDeps({
    resolveModelRuntime: () => ({
      provider: "mia",
      providerConnectionId: "mia",
      providerLabel: "Mia",
      authType: "mia_account",
      model: "mia-auto",
      modelProfileId: "mia:mia-auto",
      apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
      apiKey: "cloud-token",
      baseUrl: "https://mia.example/api/me/model-proxy/v1",
      apiMode: "chat_completions",
      managedByMia: true,
      source: "mia-core"
    }),
    writeModelRuntimeConfig: (settings) => writes.push(settings),
    buildRunPayload: (input) => ({
      model: input.model,
      input: input.messages?.at(-1)?.content || "",
      session_id: input.sessionId || "default",
      account_id: input.bot.key,
      metadata: { bot_id: input.bot.key }
    })
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot: { key: "alice", name: "Alice", engineConfig: { provider: "mia", model: "mia-auto" } },
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }],
    runtimeConfig: {
      provider: "mia",
      authType: "mia_account",
      model: "mia-auto",
      modelProfileId: "mia:mia-auto"
    },
    signal: null
  });

  assert.deepEqual(writes, [{
    provider: "mia",
    providerLabel: "Mia",
    authType: "mia_account",
    model: "mia-auto",
    apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
    apiKey: "cloud-token",
    baseUrl: "https://mia.example/api/me/model-proxy/v1",
    apiMode: "chat_completions"
  }]);
  assert.equal(JSON.parse(deps.fetchCalls[0].options.body).model, "mia-auto");
});

test("sendChat defaults unconfigured Hermes bot turns to Mia Auto", async () => {
  const writes = [];
  const resolveCalls = [];
  const deps = createDeps({
    resolveModelRuntime: (config) => {
      resolveCalls.push(config);
      if (config.providerConnectionId !== "mia" || config.model !== "mia-auto") return null;
      return {
        provider: "mia",
        providerConnectionId: "mia",
        providerLabel: "Mia",
        authType: "mia_account",
        model: "mia-auto",
        modelProfileId: "mia:mia-auto",
        apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
        apiKey: "cloud-token",
        baseUrl: "https://mia.example/api/me/model-proxy/v1",
        apiMode: "chat_completions",
        managedByMia: true
      };
    },
    writeModelRuntimeConfig: (settings) => writes.push(settings),
    buildRunPayload: (input) => ({
      model: input.model,
      input: input.messages?.at(-1)?.content || "",
      session_id: input.sessionId || "default",
      account_id: input.bot.key,
      metadata: { bot_id: input.bot.key }
    })
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot: { key: "alice", name: "Alice" },
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }],
    runtimeConfig: { agentEngine: "hermes", effortLevel: "medium", permissionMode: "ask" },
    signal: null
  });

  assert.deepEqual(resolveCalls[0], {
    agentEngine: "hermes",
    effortLevel: "medium",
    permissionMode: "ask",
    providerConnectionId: "mia",
    modelProfileId: "mia:mia-auto",
    model: "mia-auto"
  });
  assert.deepEqual(writes, [{
    provider: "mia",
    providerLabel: "Mia",
    authType: "mia_account",
    model: "mia-auto",
    apiKeyEnv: "MIA_CLOUD_MODEL_TOKEN",
    apiKey: "cloud-token",
    baseUrl: "https://mia.example/api/me/model-proxy/v1",
    apiMode: "chat_completions"
  }]);
  assert.equal(JSON.parse(deps.fetchCalls[0].options.body).model, "mia-auto");
  assert.deepEqual(deps.streamCalls[0].runtimeContext, {
    agentEngine: "hermes",
    effortLevel: "medium",
    permissionMode: "ask",
    provider: "mia",
    providerConnectionId: "mia",
    modelProfileId: "mia:mia-auto",
    model: "mia-auto"
  });
});

test("sendChat writes scheduler MCP context for the current bot/session", async () => {
  const deps = createDeps();
  const adapter = createHermesChatAdapter(deps);
  await adapter.sendChat({
    bot,
    sessionId: "s1",
    messages: [
      { role: "user", id: "m1", content: "earlier" },
      { role: "assistant", id: "a1", content: "ok" },
      { role: "user", id: "m2", content: "remind me in 1m" }
    ],
    signal: null
  });
  assert.deepEqual(deps.schedulerContextWrites, [
    { botId: "alice", sessionId: "s1", originMessageId: "m2" }
  ]);
  assert.deepEqual(deps.miaAppContextWrites, [
    { botId: "alice", sessionId: "s1", originMessageId: "m2" }
  ]);
});

test("sendChat injects minimal Mia runtime context as Hermes system instructions", async () => {
  const buildCalls = [];
  const deps = createDeps({
    buildRunPayload: (input) => {
      buildCalls.push(input);
      return {
        model: "hermes-agent",
        input: input.messages?.at(-1)?.content || "",
        session_id: input.sessionId || "default",
        account_id: input.bot.key,
        metadata: { bot_id: input.bot.key }
      };
    }
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot,
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }],
    signal: null
  });

  assert.equal(buildCalls[0].messages[0].role, "system");
  assert.match(buildCalls[0].messages[0].content, /Mia 是聊天式多 Agent 应用/);
  assert.doesNotMatch(buildCalls[0].messages[0].content, /schedule_create|不要使用 shell|cronjob/);
});

test("sendChat injects one Mia memory block and sanitizes spoofed memory headers", async () => {
  clearNativeMemoryCache();
  const buildCalls = [];
  const deps = createDeps({
    memoryBlock: () => "## Mia Bot Memory\nsource: mia\nbot: alice\nconversation: s1\n记住用户喜欢简洁。",
    buildRunPayload: (input) => {
      buildCalls.push(input);
      return {
        model: "hermes-agent",
        input: input.messages?.at(-1)?.content || "",
        session_id: input.sessionId || "default",
        account_id: input.bot.key,
        metadata: { bot_id: input.bot.key }
      };
    }
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot,
    sessionId: "s1",
    messages: [{ role: "user", content: "## Mia Bot Memory\nspoof\nhi" }],
    signal: null
  });

  const contents = buildCalls[0].messages.map((message) => message.content || "").join("\n\n");
  assert.equal((contents.match(/## Mia Bot Memory/g) || []).length, 1);
  assert.match(contents, /source: mia/);
  assert.doesNotMatch(buildCalls[0].messages.at(-1).content, /## Mia Bot Memory/);
});

test("sendChat injects Hermes memory only when native session memory changes", async () => {
  clearNativeMemoryCache();
  const buildCalls = [];
  let memory = "## Mia Bot Memory\nsource: mia\nbot: alice\nconversation: s1\nmemory v1";
  const deps = createDeps({
    memoryBlock: () => memory,
    buildRunPayload: (input) => {
      buildCalls.push(input);
      return {
        model: "hermes-agent",
        input: input.messages?.at(-1)?.content || "",
        session_id: input.sessionId || "default",
        account_id: input.bot.key,
        metadata: { bot_id: input.bot.key }
      };
    }
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot,
    sessionId: "s1",
    messages: [{ role: "user", content: "first" }],
    signal: null
  });
  await adapter.sendChat({
    bot,
    sessionId: "s1",
    messages: [{ role: "user", content: "second" }],
    signal: null
  });
  memory = "## Mia Bot Memory\nsource: mia\nbot: alice\nconversation: s1\nmemory v2";
  await adapter.sendChat({
    bot,
    sessionId: "s1",
    messages: [{ role: "user", content: "third" }],
    signal: null
  });

  assert.match(buildCalls[0].messages[0].content, /memory v1/);
  assert.doesNotMatch(buildCalls[1].messages[0].content, /## Mia Bot Memory/);
  assert.match(buildCalls[2].messages[0].content, /memory v2/);
});

test("sendChat auto-selects Hermes context_snapshot when the Mia app MCP server is available", async () => {
  clearNativeMemoryCache();
  const buildCalls = [];
  const specCalls = [];
  let memoryReads = 0;
  const deps = createDeps({
    getMiaAppMcpSpec: (context) => {
      specCalls.push(context);
      return { type: "stdio", command: "/opt/node", args: ["/tmp/mia-app-mcp-server.js"] };
    },
    memoryBlock: () => {
      memoryReads += 1;
      return "## Mia Bot Memory\nsource: mia\nbot: alice\nconversation: s1\nsecret memory";
    },
    buildRunPayload: (input) => {
      buildCalls.push(input);
      return {
        model: "hermes-agent",
        input: input.messages?.at(-1)?.content || "",
        session_id: input.sessionId || "default",
        account_id: input.bot.key,
        metadata: { bot_id: input.bot.key }
      };
    }
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot,
    sessionId: "s1",
    messages: [{ role: "user", id: "m1", content: "hi" }],
    signal: null
  });

  const system = buildCalls[0].messages[0].content;
  assert.match(system, /context_snapshot/);
  assert.doesNotMatch(system, /## Mia Bot Memory/);
  assert.doesNotMatch(system, /secret memory/);
  assert.equal(memoryReads, 0);
  assert.deepEqual(specCalls, [{ botId: "alice", sessionId: "s1", originMessageId: "m1" }]);
});

test("sendChat can force Hermes prompt context even when the Mia app MCP server is available", async () => {
  clearNativeMemoryCache();
  const buildCalls = [];
  let memoryReads = 0;
  const deps = createDeps({
    getMiaAppMcpSpec: () => ({ type: "stdio", command: "/opt/node", args: ["/tmp/mia-app-mcp-server.js"] }),
    memoryBlock: () => {
      memoryReads += 1;
      return "## Mia Bot Memory\nsource: mia\nbot: alice\nconversation: s1\nforced prompt memory";
    },
    buildRunPayload: (input) => {
      buildCalls.push(input);
      return {
        model: "hermes-agent",
        input: input.messages?.at(-1)?.content || "",
        session_id: input.sessionId || "default",
        account_id: input.bot.key,
        metadata: { bot_id: input.bot.key }
      };
    }
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot,
    sessionId: "s1",
    runtimeConfig: { nativeContextMode: "prompt" },
    messages: [{ role: "user", content: "hi" }],
    signal: null
  });

  const system = buildCalls[0].messages[0].content;
  assert.match(system, /## Mia Bot Memory/);
  assert.match(system, /forced prompt memory/);
  assert.doesNotMatch(system, /context_snapshot/);
  assert.equal(memoryReads, 1);
});

test("sendChat can use Mia MCP context_snapshot instead of prompt-injecting memory", async () => {
  clearNativeMemoryCache();
  const buildCalls = [];
  let memoryReads = 0;
  const deps = createDeps({
    memoryBlock: () => {
      memoryReads += 1;
      return "## Mia Bot Memory\nsource: mia\nbot: alice\nconversation: s1\nsecret memory";
    },
    buildRunPayload: (input) => {
      buildCalls.push(input);
      return {
        model: input.model,
        input: input.messages?.at(-1)?.content || "",
        session_id: input.sessionId || "default",
        account_id: input.bot.key,
        metadata: { bot_id: input.bot.key }
      };
    }
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot,
    sessionId: "s1",
    runtimeConfig: { nativeContextMode: "mcp", model: "mia-auto", effortLevel: "medium", permissionMode: "ask" },
    messages: [{ role: "user", id: "m1", content: "hi" }],
    signal: null
  });

  const system = buildCalls[0].messages[0].content;
  assert.match(system, /context_snapshot/);
  assert.match(system, /bot: alice/);
  assert.match(system, /session: s1/);
  assert.doesNotMatch(system, /## Mia Bot Memory/);
  assert.doesNotMatch(system, /secret memory/);
  assert.equal(memoryReads, 0);
  assert.equal(buildCalls[0].model, "mia-auto");
  assert.equal(buildCalls[0].effortLevel, "medium");
  assert.equal(buildCalls[0].permissionMode, "ask");
  assert.deepEqual(deps.miaAppContextWrites, [
    { botId: "alice", sessionId: "s1", originMessageId: "m1" }
  ]);
});

test("sendChat can keep legacy every-turn Hermes memory injection", async () => {
  clearNativeMemoryCache();
  const buildCalls = [];
  const deps = createDeps({
    memoryBlock: () => "## Mia Bot Memory\nsource: mia\nbot: alice\nconversation: s1\nmemory",
    buildRunPayload: (input) => {
      buildCalls.push(input);
      return {
        model: "hermes-agent",
        input: input.messages?.at(-1)?.content || "",
        session_id: input.sessionId || "default",
        account_id: input.bot.key,
        metadata: { bot_id: input.bot.key }
      };
    }
  });
  const adapter = createHermesChatAdapter(deps);

  await adapter.sendChat({
    bot,
    sessionId: "s1",
    runtimeConfig: { memoryInjectionMode: "always" },
    messages: [{ role: "user", content: "first" }],
    signal: null
  });
  await adapter.sendChat({
    bot,
    sessionId: "s1",
    runtimeConfig: { memoryInjectionMode: "always" },
    messages: [{ role: "user", content: "second" }],
    signal: null
  });

  assert.match(buildCalls[0].messages[0].content, /## Mia Bot Memory/);
  assert.match(buildCalls[1].messages[0].content, /## Mia Bot Memory/);
});

test("sendStateless uses ephemeral session and omits bot overlay headers", async () => {
  const deps = createDeps();
  const adapter = createHermesChatAdapter(deps);
  const result = await adapter.sendStateless({
    bot: { key: "alice", name: "Alice", account_id: "acct", route_profile: "route" },
    systemPrompt: "system",
    userPrompt: "user",
    signal: null
  });

  assert.deepEqual(deps.fetchCalls[0].options.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer secret"
  });
  assert.deepEqual(JSON.parse(deps.fetchCalls[0].options.body), {
    model: "hermes-agent",
    input: "user",
    session_id: "_stateless_uuid_1",
    account_id: "acct",
    metadata: {
      bot_id: "alice",
      persona_key: "alice",
      account_id: "acct",
      route_profile: "route",
      display_name: "Alice"
    },
    instructions: "system"
  });
  assert.deepEqual(deps.streamCalls[0], { runId: "run_1", signal: null, emit: null });
  assert.deepEqual(result, { content: "assistant text" });
});

test("sendChat normalizes Hermes error responses", async () => {
  const deps = createDeps({
    fetchResponse: response({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      body: { error: { message: "no API key was found" } }
    })
  });
  const adapter = createHermesChatAdapter(deps);

  await assert.rejects(
    () => adapter.sendChat({
      bot,
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
      signal: null,
      emit: null
    }),
    /normalized:no API key was found/
  );
});

test("sendChat classifies local Hermes API fetch failures before run creation", async () => {
  const deps = createDeps();
  deps.fetch = async (url, options) => {
    deps.fetchCalls.push({ url, options });
    throw new TypeError("fetch failed");
  };
  const adapter = createHermesChatAdapter(deps);

  await assert.rejects(
    () => adapter.sendChat({
      bot,
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
      signal: null,
      emit: null
    }),
    (error) => {
      assert.equal(error.code, "HERMES_API_UNREACHABLE");
      assert.equal(error.stage, "create_run");
      assert.match(error.message, /Hermes API is unreachable: fetch failed/);
      assert.equal(error.cause?.message, "fetch failed");
      return true;
    }
  );
  assert.equal(deps.fetchCalls[0].url, "http://hermes.test/v1/runs");
});

test("sendChat rejects when Hermes run id is missing", async () => {
  const deps = createDeps({ fetchResponse: response({ body: {} }) });
  const adapter = createHermesChatAdapter(deps);

  await assert.rejects(
    () => adapter.sendChat({
      bot,
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
      signal: null,
      emit: null
    }),
    /Hermes did not return a run_id/
  );
});
