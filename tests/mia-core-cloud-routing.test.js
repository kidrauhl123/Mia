const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createMiaCore, createCoreBotExecution, createCoreCloudRouting } = require("../src/core/mia-core.js");
const { CloudEvent } = require("../src/shared/cloud-events.js");

function makeRuntimePaths() {
  return () => ({
    botManifest: "/dev/null/does-not-exist",
    botDir: "/dev/null",
    workspace: "/tmp/mia-core-cloud-routing-workspace"
  });
}

function botInvocationEvent({ deviceId }) {
  return {
    type: CloudEvent.ConversationBotInvocationRequested,
    conversationId: "dm:userA:bot1",
    botId: "bot1",
    targetDeviceId: deviceId,
    runtimeConfig: { agentEngine: "hermes", deviceId },
    triggeringMessage: {
      id: "msg_1",
      seq: 1,
      sender_kind: "user",
      sender_ref: "userA",
      body_md: "hello core",
      turn_id: "turn_1"
    },
    members: [
      { member_kind: "bot", member_ref: "bot1", bot_name: "Bot One" },
      { member_kind: "user", member_ref: "userA", username: "userA" }
    ],
    recentMessages: []
  };
}

test("cloud routing hands interactive Hermes turns to AgentSession instead of Hermes HTTP chat", async () => {
  const deviceId = "device_core_fixture";
  const sendHermesChatSeen = [];
  const managerCalls = [];
  const localEvents = [];
  const posts = [];
  const agentSessionManager = {
    sendUserInput: async (input) => {
      managerCalls.push(input);
      return {
        ok: true,
        mode: "started",
        conversationId: input.conversationId,
        engineId: input.engineId,
        turnId: input.turnId
      };
    },
    cancelActive: async () => true,
    closeAllSessions: async () => {}
  };

  const botExecution = createCoreBotExecution({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { daemonSettings: () => ({ enabled: false }) },
    hermesBaseUrl: "",
    apiKey: "test-key",
    sendHermesChat: async (context) => {
      sendHermesChatSeen.push(context);
      throw new Error("legacy Hermes HTTP path should not run");
    },
    agentSessionManager
  });

  const socialApi = {
    postConversationMessageAsBot: async (conversationId, body) => {
      posts.push({ conversationId, body });
      return { ok: true };
    },
    listConversationMessages: async () => ({ messages: [] })
  };

  const routing = createCoreCloudRouting({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { cloudSettings: () => ({ enabled: false }), normalizeCloudUrl: (value) => String(value || "") },
    botExecution,
    socialApi,
    emitLocalEvent: (envelope) => localEvents.push(envelope),
    deviceId,
    log: () => {},
    agentSessionManager
  });

  const handled = await routing.dispatcher.handleCloudEvent(botInvocationEvent({ deviceId }));

  assert.equal(handled, true);
  assert.equal(sendHermesChatSeen.length, 0);
  assert.equal(posts.length, 0);
  assert.equal(managerCalls.length, 1);
  assert.equal(managerCalls[0].conversationId, "dm:userA:bot1");
  assert.equal(managerCalls[0].engineId, "hermes");
  assert.equal(managerCalls[0].turnId, "turn_1");
  assert.equal(managerCalls[0].text, "hello core");
  assert.equal(typeof managerCalls[0].workspacePath, "string");
  assert.notEqual(managerCalls[0].workspacePath, "");
  assert.equal(localEvents.length, 0);
});

test("core cloud routing stopChat cancels the active AgentSession conversation", async () => {
  const deviceId = "device_core_fixture";
  const cancelled = [];
  const agentSessionManager = {
    sendUserInput: async (input) => ({
      ok: true,
      mode: "started",
      conversationId: input.conversationId,
      engineId: input.engineId,
      turnId: input.turnId
    }),
    cancelActive: async (descriptor) => {
      cancelled.push(descriptor);
      return true;
    },
    closeAllSessions: async () => {}
  };
  const botExecution = createCoreBotExecution({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { daemonSettings: () => ({ enabled: false }) },
    hermesBaseUrl: "",
    apiKey: "test-key",
    agentSessionManager
  });
  const routing = createCoreCloudRouting({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { cloudSettings: () => ({ enabled: false }), normalizeCloudUrl: (value) => String(value || "") },
    botExecution,
    socialApi: {
      postConversationMessageAsBot: async () => ({ ok: true }),
      listConversationMessages: async () => ({ messages: [] })
    },
    deviceId,
    log: () => {},
    agentSessionManager
  });

  await routing.dispatcher.handleCloudEvent(botInvocationEvent({ deviceId }));
  const result = routing.stopChat({ conversationId: "dm:userA:bot1", turnId: "turn_1" });

  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].conversationId, "dm:userA:bot1");
  assert.equal(cancelled[0].engineId, "hermes");
  assert.equal(typeof cancelled[0].workspacePath, "string");
  assert.deepEqual(result, {
    stopped: true,
    conversationId: "dm:userA:bot1",
    runId: "local_bot_reply_msg_1_bot1",
    turnId: "turn_1",
    status: "cancelling"
  });
});

test("dispatcher ignores an invocation targeting a different device", async () => {
  const posts = [];
  const { dispatcher } = createCoreCloudRouting({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { cloudSettings: () => ({ enabled: false }), normalizeCloudUrl: (value) => String(value || "") },
    botExecution: { sendChat: async () => ({ ok: true, mode: "started" }) },
    socialApi: {
      postConversationMessageAsBot: async (conversationId, body) => {
        posts.push({ conversationId, body });
        return { ok: true };
      },
      listConversationMessages: async () => ({ messages: [] })
    },
    deviceId: "device_core_fixture"
  });

  const handled = await dispatcher.handleCloudEvent(botInvocationEvent({ deviceId: "some-other-device" }));
  assert.equal(handled, false);
  assert.equal(posts.length, 0);
});

test("createCoreCloudRouting requires an explicit persisted device id", () => {
  assert.throws(() => createCoreCloudRouting({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { cloudSettings: () => ({ enabled: false }), normalizeCloudUrl: (value) => String(value || "") },
    botExecution: { sendChat: async () => ({ ok: true }) },
    socialApi: {
      postConversationMessageAsBot: async () => ({ ok: true }),
      listConversationMessages: async () => ({ messages: [] })
    }
  }), /deviceId/);
});

test("createMiaCore cloud routing accepts invocations for the persisted desktop device identity", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-routing-identity-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "mia-device.json"), JSON.stringify({
    id: "device_existing_air7",
    createdAt: "2026-06-18T03:09:46.142Z"
  }, null, 2));

  const managerCalls = [];
  const core = createMiaCore({ env: { MIA_HOME: home }, version: "0.0.0-test" });
  const { dispatcher } = core.cloudRouting({
    agentSessionManager: {
      sendUserInput: async (input) => {
        managerCalls.push(input);
        return { ok: true, mode: "started", conversationId: input.conversationId, engineId: input.engineId, turnId: input.turnId };
      }
    },
    socialApi: {
      postConversationMessageAsBot: async () => ({ ok: true }),
      listConversationMessages: async () => ({ messages: [] })
    }
  });

  const handled = await dispatcher.handleCloudEvent(botInvocationEvent({ deviceId: "device_existing_air7" }));

  assert.equal(handled, true);
  assert.equal(managerCalls.length, 1);
});

test("createMiaCore cloud routing rereads the persisted device identity", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-routing-reset-identity-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const identityPath = path.join(home, "mia-device.json");
  fs.writeFileSync(identityPath, JSON.stringify({
    id: "device_existing_air7",
    createdAt: "2026-06-18T03:09:46.142Z"
  }, null, 2));

  const managerCalls = [];
  const core = createMiaCore({ env: { MIA_HOME: home }, version: "0.0.0-test" });
  const { dispatcher } = core.cloudRouting({
    agentSessionManager: {
      sendUserInput: async (input) => {
        managerCalls.push(input);
        return { ok: true, mode: "started", conversationId: input.conversationId, engineId: input.engineId, turnId: input.turnId };
      }
    },
    socialApi: {
      postConversationMessageAsBot: async () => ({ ok: true }),
      listConversationMessages: async () => ({ messages: [] })
    }
  });

  fs.writeFileSync(identityPath, JSON.stringify({
    id: "device_after_reset",
    previousId: "device_existing_air7",
    createdAt: "2026-06-25T00:00:00.000Z"
  }, null, 2));

  const handled = await dispatcher.handleCloudEvent(botInvocationEvent({ deviceId: "device_after_reset" }));

  assert.equal(handled, true);
  assert.equal(managerCalls.length, 1);
});
