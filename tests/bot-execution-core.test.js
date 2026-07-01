const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createBotExecutionCore } = require("../src/main/bot-execution-core.js");
const { createChatEventEmitter } = require("../src/main/chat-events.js");
const { XLSX_SKILL_ID } = require("../src/shared/skill-intent-detector.js");

// Pure-node stub deps proving Mia Core can drive bot execution with NO electron
// and NO webContents. Everything host-specific is injected.
function makeCore(overrides = {}) {
  const calls = { adapter: [], notifyMessage: [] };
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
    hermesRunService: { slashCommandText: () => "" },
    sendWithChatEngineAdapter: async (adapters, context) => {
      calls.adapter.push(context);
      // Emit a downstream event to prove the injected emit is wired through.
      if (context.emit) context.emit("text_delta", { text: "canned" });
      return { text: "canned-response", finishReason: "stop" };
    },
    createActiveChatEngineAdapters: () => ({ stub: true }),
    localBotResponder: () => null,
    isDaemonProcess: false,
    daemonTasksClient: () => null,
    settingsStore: () => ({ daemonSettings: () => ({ enabled: false }) }),
    appendCloudLog: () => {},
    ...overrides
  };
  return { core: createBotExecutionCore(deps), calls, deps };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "condition was not met before timeout");
}

test("sendChat returns the canned response and emits session_started (node-only)", async () => {
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
    emit
  });

  assert.deepEqual(response, { text: "canned-response", finishReason: "stop" });
  assert.equal(calls.adapter.length, 1);
  const kinds = sink.map((e) => e.kind);
  assert.ok(kinds.includes("session_started"), "should emit session_started");
  assert.ok(kinds.includes("text_delta"), "should forward downstream adapter events");
  const started = sink.find((e) => e.kind === "session_started");
  assert.deepEqual(started.data, { botKey: "bot1", engine: "hermes" });
  // Interactive (non-utility, non-title) turn notifies the pet service.
  assert.equal(calls.notifyMessage.length, 1);
});

test("sendChat schedules provider-backed memory extraction after a visible bot turn", async () => {
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
    messages: [{ role: "user", id: "m1", content: "I prefer concise answers" }]
  });

  assert.equal(response.text, "canned-response");
  await waitFor(() => extractCalls.length === 1);
  assert.deepEqual(extractCalls[0].messages, [
    { role: "user", content: "I prefer concise answers" },
    { role: "assistant", content: "canned-response" }
  ]);
  assert.equal(extractCalls[0].botId, "bot1");
  assert.equal(extractCalls[0].sessionId, "s1");
  assert.equal(extractCalls[0].scope, "bot");
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
    messages: [{ role: "user", id: "m1", content: "remember that I like tea" }]
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
    messages: [{ role: "user", content: "给我生成一个写着2026年世界杯小组赛战果的Excel" }]
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

test("stopChat aborts an active interactive controller", async () => {
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
    sessionId: "s1",
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
