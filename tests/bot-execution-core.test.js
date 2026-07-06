const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createBotExecutionCore } = require("../src/main/bot-execution-core.js");
const { createChatEventEmitter } = require("../src/main/chat-events.js");
const { XLSX_SKILL_ID } = require("../src/shared/skill-intent-detector.js");

// Pure-node stub deps proving Mia Core can drive bot execution with NO electron
// and NO webContents. Everything host-specific is injected.
function makeCore(overrides = {}) {
  const calls = { adapter: [], notifyMessage: [], agentSession: [], cancelActive: [] };
  const deps = {
    createChatEventEmitter,
    cloudBotSnapshotForTurn: () => ({ key: "bot1", id: "bot1", name: "Bot One", agentEngine: "hermes", capabilities: {} }),
    loadBotManifest: () => { throw new Error("loadBotManifest should not run when a snapshot is provided"); },
    requireBot: () => { throw new Error("requireBot should not run when a snapshot is provided"); },
    normalizeTurnRuntimeConfig: (cfg) => cfg || {},
    botWithRuntimeConfig: (bot) => bot,
    normalizeAgentEngine: (engine, fallback) => engine || fallback,
    resolveChatEngineAdapter: (bot) => ({ id: bot.agentEngine || "hermes" }),
    botPetService: { notifyMessage: (key, content) => calls.notifyMessage.push({ key, content }) },
    responseMessageContent: (response) => response?.text || "",
    schedulerSkillIdsForTurn: () => [],
    skillsLoader: { buildActiveSkillsDirective: () => "" },
    nativeTurnHelpers: { slashCommandText: () => "" },
    sendWithChatEngineAdapter: async (adapters, context) => {
      calls.adapter.push(context);
      // Emit a downstream event to prove the injected emit is wired through.
      if (context.emit) context.emit("text_delta", { text: "canned" });
      return { text: "canned-response", finishReason: "stop" };
    },
    createActiveChatEngineAdapters: () => ({ stub: true }),
    agentSessionManager: {
      sendUserInput: async (input) => {
        calls.agentSession.push(input);
        return {
          ok: true,
          mode: "started",
          conversationId: input.conversationId,
          engineId: input.engineId,
          turnId: input.turnId
        };
      },
      cancelActive: async (descriptor) => {
        calls.cancelActive.push(descriptor);
        return true;
      }
    },
    agentSessionWorkspacePath: () => "/repo/workspace",
    prepareAgentSessionRuntime: async () => ({}),
    localBotResponder: () => null,
    isDaemonProcess: false,
    daemonTasksClient: () => null,
    settingsStore: () => ({ daemonSettings: () => ({ enabled: false }) }),
    appendCloudLog: () => {},
    ...overrides
  };
  return { core: createBotExecutionCore(deps), calls, deps };
}

function createDeferred() {
  const deferred = {};
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });
  return deferred;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "condition was not met before timeout");
}

test("sendChat routes interactive AgentSession turns through the session manager without history replay", async () => {
  const { core, calls } = makeCore();
  const sink = [];
  const { emit } = createChatEventEmitter({
    sessionId: "s1",
    runId: "run1",
    now: () => 1,
    emitImpl: (channel, envelope) => sink.push(envelope)
  });

  const response = await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    messages: [
      { role: "user", content: "old prompt" },
      { role: "assistant", content: "old reply" },
      {
        role: "user",
        id: "msg-9",
        content: [{ type: "text", text: "  latest prompt  " }],
        attachments: [{ id: "att-1", name: "error.log" }],
        fileReferences: [{ path: "/repo/README.md" }]
      }
    ],
    emit
  });

  assert.deepEqual(response, {
    ok: true,
    mode: "started",
    conversationId: "conversation:1",
    engineId: "hermes",
    turnId: "msg-9"
  });
  assert.equal(calls.adapter.length, 0);
  assert.deepEqual(calls.agentSession, [{
    conversationId: "conversation:1",
    engineId: "hermes",
    workspacePath: "/repo/workspace",
    turnId: "msg-9",
    text: "latest prompt",
    attachments: [{ id: "att-1", name: "error.log" }],
    fileReferences: [{ path: "/repo/README.md" }]
  }]);
  assert.equal("messages" in calls.agentSession[0], false);
  assert.equal(core.getActiveChatAbortController(), null);
  const kinds = sink.map((e) => e.kind);
  assert.ok(kinds.includes("session_started"), "should emit session_started");
  const started = sink.find((e) => e.kind === "session_started");
  assert.deepEqual(started.data, { botKey: "bot1", engine: "hermes" });
  assert.equal(calls.notifyMessage.length, 0);
});

test("sendChat passes prepared MCP session config to AgentSession", async () => {
  const refreshMcpContext = async () => {};
  const mcpServers = [{
    name: "mia-app",
    command: "/usr/bin/node",
    args: ["/tmp/mia-app.js"],
    env: [{ name: "MIA_DAEMON_URL", value: "http://127.0.0.1:27861" }]
  }];
  const { core, calls } = makeCore({
    prepareAgentSessionRuntime: async ({ engineId, conversationId, botId }) => {
      assert.equal(engineId, "hermes");
      assert.equal(conversationId, "conversation:1");
      assert.equal(botId, "bot1");
      return {
        mcpFingerprint: "mcp-abc",
        mcpServers,
        refreshMcpContext,
        initialPromptPrefix: "## Mia Scoped Context"
      };
    }
  });

  await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    messages: [{ role: "user", id: "turn-1", content: "hello" }]
  });

  assert.equal(calls.agentSession.length, 1);
  assert.deepEqual(calls.agentSession[0], {
    conversationId: "conversation:1",
    engineId: "hermes",
    workspacePath: "/repo/workspace",
    mcpFingerprint: "mcp-abc",
    mcpServers,
    refreshMcpContext,
    initialPromptPrefix: "## Mia Scoped Context",
    turnId: "turn-1",
    text: "hello"
  });
});

test("managed AgentSession turns carry prompt-fallback metadata from runtime preparation", async () => {
  const { core, calls } = makeCore({
    prepareAgentSessionRuntime: async () => ({
      skillFingerprint: "skills:abc",
      skillDeliveryMode: "prompt-fallback",
      turnPromptPrefix: "## Prompt Fallback",
      skillFallback: {
        maxRounds: 2,
        detectRequests: () => [],
        materializePrompt: async () => "",
        fallbackText: () => ""
      }
    })
  });

  await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    messages: [{ role: "user", id: "msg-1", content: "hello" }]
  });

  assert.equal(calls.agentSession[0].skillFingerprint, "skills:abc");
  assert.equal(calls.agentSession[0].turnPromptPrefix, "## Prompt Fallback");
  assert.equal(typeof calls.agentSession[0].skillFallback.detectRequests, "function");
});

for (const [inputEngineId, expectedEngineId] of [
  ["claude-code", "claude"],
  ["codex", "codex"],
  ["openclaw", "openclaw"]
]) {
  test(`sendChat routes interactive ${inputEngineId} turns through AgentSession ACP`, async () => {
    const { core, calls } = makeCore({
      cloudBotSnapshotForTurn: () => ({
        key: "bot1",
        id: "bot1",
        name: "Bot One",
        agentEngine: inputEngineId,
        capabilities: {}
      })
    });

    const response = await core.sendChat({
      botKey: "bot1",
      sessionId: "conversation:1",
      messages: [{ role: "user", id: `turn-${expectedEngineId}`, content: "latest prompt" }]
    });

    assert.deepEqual(response, {
      ok: true,
      mode: "started",
      conversationId: "conversation:1",
      engineId: expectedEngineId,
      turnId: `turn-${expectedEngineId}`
    });
    assert.equal(calls.adapter.length, 0);
    assert.deepEqual(calls.agentSession, [{
      conversationId: "conversation:1",
      engineId: expectedEngineId,
      workspacePath: "/repo/workspace",
      turnId: `turn-${expectedEngineId}`,
      text: "latest prompt"
    }]);
  });
}

test("sendChat keeps managed AgentSession turn text raw even when active skill directive text is available", async () => {
  const { core, calls } = makeCore({
    cloudBotSnapshotForTurn: () => ({
      key: "bot1",
      id: "bot1",
      name: "Bot One",
      agentEngine: "hermes",
      capabilities: { enabledSkills: ["index-skill"] }
    }),
    schedulerSkillIdsForTurn: ({ activeSkillIds }) => activeSkillIds,
    skillsLoader: {
      buildActiveSkillsDirective: (ids) => `ACTIVE:${ids.join(",")}`,
      resolveSkillMaterialization: () => {
        throw new Error("resolveSkillMaterialization should not run for managed AgentSession turns");
      }
    }
  });

  await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    messages: [{ role: "user", id: "msg-10", content: "raw user turn" }],
    activeSkillIds: ["active-skill"]
  });

  assert.equal(calls.adapter.length, 0);
  assert.equal(calls.agentSession.length, 1);
  assert.equal(calls.agentSession[0].text, "raw user turn");
});

test("sendChat fails loudly when an interactive AgentSession turn has no manager", async () => {
  const { core, calls } = makeCore({ agentSessionManager: null });

  await assert.rejects(
    core.sendChat({
      botKey: "bot1",
      sessionId: "conversation:1",
      messages: [{ role: "user", content: "hi" }]
    }),
    /AgentSession manager is required/
  );

  assert.equal(calls.adapter.length, 0);
});

test("sendChat accepts a second interactive AgentSession input without using the foreground abort controller", async () => {
  let sendCount = 0;
  const { core, calls } = makeCore({
    agentSessionManager: {
      sendUserInput: async (input) => {
        calls.agentSession.push(input);
        sendCount += 1;
        return sendCount === 1
          ? {
            ok: true,
            mode: "started",
            conversationId: input.conversationId,
            engineId: input.engineId,
            turnId: input.turnId
          }
          : {
            ok: true,
            mode: "queued",
            conversationId: input.conversationId,
            engineId: input.engineId,
            turnId: input.turnId,
            queueDepth: 1
          };
      },
      cancelActive: async (descriptor) => {
        calls.cancelActive.push(descriptor);
        return true;
      }
    }
  });

  const first = await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    messages: [{ role: "user", id: "msg-1", content: "first" }]
  });
  const second = await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    messages: [{ role: "user", id: "msg-2", content: "second" }]
  });

  assert.deepEqual(first, {
    ok: true,
    mode: "started",
    conversationId: "conversation:1",
    engineId: "hermes",
    turnId: "msg-1"
  });
  assert.deepEqual(second, {
    ok: true,
    mode: "queued",
    conversationId: "conversation:1",
    engineId: "hermes",
    turnId: "msg-2",
    queueDepth: 1
  });
  assert.equal(calls.adapter.length, 0);
  assert.equal(core.getActiveChatAbortController(), null);
});

test("group sendChat keeps the legacy adapter path and emits session_started", async () => {
  const { core, calls } = makeCore();
  const sink = [];
  const { emit } = createChatEventEmitter({
    sessionId: "s1",
    runId: "run1",
    now: () => 1,
    emitImpl: (channel, envelope) => sink.push(envelope)
  });

  const response = await core.sendChat({
    botKey: "bot1",
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }],
    group: true,
    emit
  });

  assert.deepEqual(response, { text: "canned-response", finishReason: "stop" });
  assert.equal(calls.adapter.length, 1);
  const kinds = sink.map((e) => e.kind);
  assert.ok(kinds.includes("session_started"), "should emit session_started");
  assert.ok(kinds.includes("text_delta"), "should forward downstream adapter events");
  const started = sink.find((e) => e.kind === "session_started");
  assert.deepEqual(started.data, { botKey: "bot1", engine: "hermes" });
  assert.equal(calls.notifyMessage.length, 1);
});

test("group sendChat schedules provider-backed memory extraction after a visible bot turn", async () => {
  const extractCalls = [];
  const extractedEvents = [];
  const logs = [];
  const { core } = makeCore({
    miaMemoryService: {
      extractMemoriesFromMessages: async (input) => {
        extractCalls.push(input);
        return {
          status: "ok",
          memories: [{
            status: "active",
            effectiveScope: "bot",
            memoryId: "mem_1",
            memory: {
              id: "mem_1",
              botId: input.botId,
              sessionId: input.sessionId,
              scope: "bot",
              status: "active"
            }
          }]
        };
      }
    },
    isMemoryEnabled: () => true,
    onMemoryExtracted: (result, scope) => extractedEvents.push({ result, scope }),
    appendCloudLog: (line) => logs.push(line)
  });

  const response = await core.sendChat({
    botKey: "bot1",
    sessionId: "s1",
    messages: [{ role: "user", id: "m1", content: "I prefer concise answers" }],
    group: true
  });

  assert.equal(response.text, "canned-response");
  await waitFor(() => extractCalls.length === 1);
  assert.deepEqual(extractCalls[0].messages, [
    { role: "user", content: "I prefer concise answers" },
    { role: "assistant", content: "canned-response" }
  ]);
  assert.equal(extractCalls[0].botId, "bot1");
  assert.equal(extractCalls[0].sessionId, "s1");
  assert.equal(extractCalls[0].scope, "session");
  assert.equal(extractCalls[0].originEngine, "hermes");
  assert.deepEqual(extractCalls[0].sourceMessageIds, ["m1"]);
  await waitFor(() => extractedEvents.length === 1);
  assert.equal(extractedEvents[0].scope.eventSource, "agent_extract");
  assert.match(logs.join("\n"), /extracted 1 memories/);
});

test("sendChat does not auto-extract memories when Mia memory is disabled", async () => {
  let extractCalls = 0;
  const { core } = makeCore({
    miaMemoryService: {
      extractMemoriesFromMessages: async () => {
        extractCalls += 1;
        return { status: "ok", memories: [] };
      }
    },
    isMemoryEnabled: () => false
  });

  await core.sendChat({
    botKey: "bot1",
    sessionId: "s1",
    messages: [{ role: "user", id: "m1", content: "remember that I like tea" }],
    group: true
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(extractCalls, 0);
});

test("background:true sendChat works with NO webContents and NO electron", async () => {
  const { core, calls } = makeCore();

  const response = await core.sendChat({
    botKey: "bot1",
    sessionId: "task:1",
    messages: [{ role: "user", content: "run task" }],
    background: true
    // no webContents, no emit, no electron
  });

  assert.deepEqual(response, { text: "canned-response", finishReason: "stop" });
  assert.equal(calls.adapter.length, 1);
  // Background turns get their own controller and never touch the single-flight
  // interactive controller.
  assert.equal(core.getActiveChatAbortController(), null);
  // No external emit + utility=false defaults to a null IPC emitter (no webContents).
  assert.equal(calls.adapter[0].emit, null);
});

test("sendChat passes turn skill materialization to the adapter", async () => {
  const resolveCalls = [];
  const { core, calls } = makeCore({
    cloudBotSnapshotForTurn: () => ({
      key: "bot1",
      id: "bot1",
      name: "Bot One",
      agentEngine: "hermes",
      capabilities: { enabledSkills: ["index-skill"] }
    }),
    schedulerSkillIdsForTurn: ({ activeSkillIds }) => activeSkillIds,
    skillsLoader: {
      buildActiveSkillsDirective: (ids) => `ACTIVE:${ids.join(",")}`,
      resolveSkillMaterialization: (input) => {
        resolveCalls.push(input);
        return {
          indexBlock: "INDEX",
          loadedBlock: "LOADED",
          loadedSkillIds: ["active-skill"]
        };
      }
    }
  });

  await core.sendChat({
    botKey: "bot1",
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }],
    group: true,
    activeSkillIds: ["active-skill"]
  });

  assert.deepEqual(resolveCalls.map((call) => call.activeSkillIds), [["active-skill"]]);
  assert.deepEqual(resolveCalls[0].bot.capabilities.enabledSkills, ["index-skill", "active-skill"]);
  assert.deepEqual(calls.adapter[0].skillMaterialization, {
    indexBlock: "INDEX",
    loadedBlock: "LOADED",
    loadedSkillIds: ["active-skill"]
  });
  assert.equal(calls.adapter[0].messages[0].content, "ACTIVE:active-skill\n\nhi");
});

test("sendChat materializes xlsx skill when the user asks for an Excel deliverable", async () => {
  const resolveCalls = [];
  const { core, calls } = makeCore({
    skillsLoader: {
      buildActiveSkillsDirective: () => "",
      resolveSkillMaterialization: (input) => {
        resolveCalls.push(input);
        return {
          indexBlock: "INDEX",
          loadedBlock: "XLSX GUIDE",
          loadedSkillIds: [XLSX_SKILL_ID]
        };
      }
    }
  });

  await core.sendChat({
    botKey: "bot1",
    sessionId: "s1",
    messages: [{ role: "user", content: "给我生成一个写着2026年世界杯小组赛战果的Excel" }],
    group: true
  });

  assert.deepEqual(resolveCalls[0].activeSkillIds, []);
  assert.deepEqual(resolveCalls[0].intentSkillIds, [XLSX_SKILL_ID]);
  assert.deepEqual(resolveCalls[0].bot.capabilities.enabledSkills, [XLSX_SKILL_ID]);
  assert.equal(calls.adapter[0].skillMaterialization.loadedBlock, "XLSX GUIDE");
});

test("sendChat handles LOAD_SKILL requests as an internal skill-loading retry", async () => {
  const resolveCalls = [];
  const visibleEvents = [];
  const { core, calls } = makeCore({
    cloudBotSnapshotForTurn: () => ({
      key: "bot1",
      id: "bot1",
      name: "Bot One",
      agentEngine: "hermes",
      capabilities: { enabledSkills: ["demo-skill"] }
    }),
    skillsLoader: {
      buildActiveSkillsDirective: () => "",
      resolveSkillMaterialization: (input) => {
        resolveCalls.push(input);
        const requested = input.requestedSkillIds || [];
        return {
          indexBlock: "## Available Mia Skills\n\n- demo-skill: Demo skill.\n\n需要完整指南时输出 [LOAD_SKILL: demo-skill]",
          loadedBlock: requested.includes("demo-skill") ? "## Loaded Mia Skill Guides\n\n=== Skill: demo-skill ===\nDEMO GUIDE\n=== End Skill ===" : "",
          loadedSkillIds: requested.includes("demo-skill") ? ["demo-skill"] : []
        };
      }
    },
    sendWithChatEngineAdapter: async (_adapters, context) => {
      calls.adapter.push(context);
      if (calls.adapter.length === 1) {
        if (context.emit) context.emit("text_delta", { text: "[LOAD_SKILL: demo-skill]" });
        return { text: "[LOAD_SKILL: demo-skill]", finishReason: "stop" };
      }
      assert.match(context.skillMaterialization.loadedBlock, /DEMO GUIDE/);
      if (context.emit) context.emit("text_delta", { text: "used demo" });
      return { text: "used demo", finishReason: "stop" };
    }
  });

  const response = await core.sendChat({
    botKey: "bot1",
    sessionId: "s1",
    messages: [{ role: "user", content: "帮我处理一下" }],
    group: true,
    emit: (kind, data) => visibleEvents.push({ kind, data })
  });

  assert.equal(response.text, "used demo");
  assert.equal(calls.adapter.length, 2);
  assert.deepEqual(resolveCalls.map((call) => call.requestedSkillIds || []), [[], ["demo-skill"]]);
  assert.deepEqual(
    visibleEvents.filter((event) => event.kind === "text_delta").map((event) => event.data.text),
    ["used demo"]
  );
});

test("stopChat cancels the active interactive AgentSession turn", async () => {
  const { core, calls } = makeCore();

  await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    messages: [{ role: "user", id: "msg-1", content: "hi" }]
  });

  const result = await core.stopChat({});
  assert.equal(result.stopped, true);
  assert.deepEqual(calls.cancelActive, [{
    conversationId: "conversation:1",
    engineId: "hermes",
    workspacePath: "/repo/workspace"
  }]);
  assert.equal(core.getActiveChatAbortController(), null);
});

test("stopChat cancels the requested managed AgentSession conversation instead of the most recent one", async () => {
  const { core, calls } = makeCore();

  await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    messages: [{ role: "user", id: "msg-1", content: "first" }]
  });
  await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:2",
    messages: [{ role: "user", id: "msg-2", content: "second" }]
  });

  const result = await core.stopChat({ conversationId: "conversation:1" });

  assert.equal(result.stopped, true);
  assert.deepEqual(calls.cancelActive, [{
    conversationId: "conversation:1",
    engineId: "hermes",
    workspacePath: "/repo/workspace"
  }]);
});

test("stopChat notifies the local responder before awaiting slow AgentSession cancellation", async () => {
  const cancelDeferred = createDeferred();
  const localStops = [];
  const calls = { agentSession: [], cancelActive: [] };
  const { core } = makeCore({
    agentSessionManager: {
      sendUserInput: async (input) => {
        calls.agentSession.push(input);
        return {
          ok: true,
          mode: "started",
          conversationId: input.conversationId,
          engineId: input.engineId,
          turnId: input.turnId
        };
      },
      cancelActive: async (descriptor) => {
        calls.cancelActive.push(descriptor);
        return cancelDeferred.promise;
      }
    },
    localBotResponder: () => ({
      stopActiveConversationRun: (payload) => {
        localStops.push(payload);
        return {
          stopped: true,
          conversationId: payload.conversationId,
          runId: payload.runId,
          status: "cancelling"
        };
      }
    })
  });

  await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    messages: [{ role: "user", id: "msg-1", content: "first" }]
  });

  const stopPromise = core.stopChat({ conversationId: "conversation:1", runId: "run-1" });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(localStops, [{ conversationId: "conversation:1", runId: "run-1" }]);
  cancelDeferred.resolve(true);
  const result = await stopPromise;
  assert.equal(result.stopped, true);
  assert.equal(result.status, "cancelling");
});

test("sendChat passes Claude Code Mia managed model runtime to AgentSession", async () => {
  const { core, calls } = makeCore({
    cloudBotSnapshotForTurn: () => ({
      key: "bot1",
      id: "bot1",
      name: "Bot One",
      agentEngine: "claude-code",
      capabilities: {}
    }),
    prepareAgentSessionRuntime: async ({ engineId, runtimeConfig }) => {
      assert.equal(engineId, "claude");
      assert.deepEqual(runtimeConfig, {
        agentEngine: "claude-code",
        providerConnectionId: "mia",
        modelProfileId: "mia:mia-auto",
        model: "mia-auto"
      });
      return {
        runtimeKey: "mia:mia-auto",
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
          ANTHROPIC_AUTH_TOKEN: "proxy-token"
        }
      };
    }
  });

  await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    runtimeConfig: {
      agentEngine: "claude-code",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto"
    },
    messages: [{ role: "user", id: "turn-claude", content: "latest prompt" }]
  });

  assert.deepEqual(calls.agentSession, [{
    conversationId: "conversation:1",
    engineId: "claude",
    workspacePath: "/repo/workspace",
    runtimeKey: "mia:mia-auto",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
      ANTHROPIC_AUTH_TOKEN: "proxy-token"
    },
    turnId: "turn-claude",
    text: "latest prompt"
  }]);
});

test("sendChat passes Hermes Mia managed runtime to AgentSession", async () => {
  const { core, calls } = makeCore({
    cloudBotSnapshotForTurn: () => ({
      key: "bot1",
      id: "bot1",
      name: "Bot One",
      agentEngine: "hermes",
      capabilities: {}
    }),
    prepareAgentSessionRuntime: async ({ engineId, runtimeConfig }) => {
      assert.equal(engineId, "hermes");
      assert.deepEqual(runtimeConfig, {
        agentEngine: "hermes",
        providerConnectionId: "mia",
        modelProfileId: "mia:mia-auto",
        model: "mia-auto",
        effortLevel: "medium",
        permissionMode: "yolo"
      });
      return {
        runtimeKey: "mia:mia-auto",
        env: {
          HERMES_HOME: "/tmp/mia-hermes-session",
          MIA_HOME: "/tmp/mia-home",
          MIA_CLOUD_MODEL_TOKEN: "cloud-token"
        }
      };
    }
  });

  await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    runtimeConfig: {
      agentEngine: "hermes",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto",
      effortLevel: "medium",
      permissionMode: "yolo"
    },
    messages: [{ role: "user", id: "turn-hermes", content: "latest prompt" }]
  });

  assert.deepEqual(calls.agentSession, [{
    conversationId: "conversation:1",
    engineId: "hermes",
    workspacePath: "/repo/workspace",
    runtimeKey: "mia:mia-auto",
    env: {
      HERMES_HOME: "/tmp/mia-hermes-session",
      MIA_HOME: "/tmp/mia-home",
      MIA_CLOUD_MODEL_TOKEN: "cloud-token"
    },
    turnId: "turn-hermes",
    text: "latest prompt"
  }]);
});

test("stopChat honors full managed AgentSession tuple when the same conversation uses different workspaces", async () => {
  let workspacePath = "/repo/a";
  const { core, calls } = makeCore({
    agentSessionWorkspacePath: () => workspacePath
  });

  await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    messages: [{ role: "user", id: "msg-1", content: "first" }]
  });

  workspacePath = "/repo/b";
  await core.sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    messages: [{ role: "user", id: "msg-2", content: "second" }]
  });

  const result = await core.stopChat({
    conversationId: "conversation:1",
    engineId: "hermes",
    workspacePath: "/repo/a"
  });

  assert.equal(result.stopped, true);
  assert.deepEqual(calls.cancelActive, [{
    conversationId: "conversation:1",
    engineId: "hermes",
    workspacePath: "/repo/a"
  }]);
});

test("stopChat aborts an active title controller on the legacy adapter path", async () => {
  const { core } = makeCore({
    // Block the adapter so a foreground turn stays in-flight while we stop it.
    sendWithChatEngineAdapter: (adapters, context) => new Promise((_resolve, reject) => {
      context.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        reject(err);
      });
    })
  });

  const pending = core.sendChat({
    botKey: "bot1",
    sessionId: "title:s1",
    messages: [{ role: "user", content: "hi" }]
  });

  // Foreground (non-group/utility/background) turn registers the single-flight controller.
  assert.notEqual(core.getActiveChatAbortController(), null);
  assert.equal(core.getActiveChatAbortController().signal.aborted, false);

  const result = await core.stopChat({});
  assert.equal(result.stopped, true);
  assert.equal(core.getActiveChatAbortController(), null);

  await assert.rejects(pending, (err) => err.code === "MIA_STOPPED");
});

test("stopChat delegates to daemon even when the foreground has no local run", async () => {
  const daemonCalls = [];
  const { core } = makeCore({
    daemonTasksClient: () => ({
      call: async (path, opts) => {
        daemonCalls.push({ path, opts });
        return { stopped: true, conversationId: "botc_1", runId: "run_1", status: "cancelling" };
      }
    }),
    settingsStore: () => ({ daemonSettings: () => ({ enabled: false }) })
  });

  const result = await core.stopChat({ conversationId: "botc_1", runId: "run_1" });

  assert.deepEqual(daemonCalls.map((call) => call.path), ["/api/chat/stop"]);
  assert.deepEqual(JSON.parse(daemonCalls[0].opts.body), { conversationId: "botc_1", runId: "run_1" });
  assert.deepEqual(result, {
    stopped: true,
    conversationId: "botc_1",
    runId: "run_1",
    status: "cancelling"
  });
});
