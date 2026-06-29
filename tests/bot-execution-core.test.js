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
