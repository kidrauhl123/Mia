const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createMainBotRuntimeDispatcher } = require("../src/main/social/bot-runtime-dispatcher.js");

function setup(overrides = {}) {
  const calls = { responder: [], logs: [] };
  const dispatcher = createMainBotRuntimeDispatcher({
    shouldHandle: () => true,
    listBots: () => [{ key: "codex", name: "Codex" }],
    localBotResponder: {
      respond: async (args) => {
        calls.responder.push(args);
        return true;
      }
    },
    log: (line) => calls.logs.push(line),
    ...overrides
  });
  return { dispatcher, calls };
}

test("desktop responds when the cloud requests a bot invocation", async () => {
  const { dispatcher, calls } = setup({ currentDeviceId: () => "device_mac" });

  await dispatcher.handleCloudEvent({
    type: "conversation.bot_invocation_requested",
    conversationId: "g_1",
    botId: "codex",
    targetDeviceId: "device_mac",
    runtimeConfig: {
      deviceId: "device_mac",
      agentEngine: "codex",
      providerConnectionId: "mia",
      modelProfileId: "mia:mia-auto",
      model: "mia-auto",
      apiMode: "chat_completions",
      baseUrl: "https://renderer-native.example",
      apiKeyEnv: "RENDERER_NATIVE"
    },
    invokedBy: { username: "alice" },
    triggeringMessage: { id: "m_1", body_md: "@codex 看看", sender_kind: "user" },
    recentMessages: [{ sender_kind: "user", sender_ref: "u_1", body_md: "背景" }]
  });

  assert.equal(calls.responder.length, 1);
  assert.equal(calls.responder[0].conversationId, "g_1");
  assert.equal(calls.responder[0].botId, "codex");
  assert.equal(calls.responder[0].dedupKey, "m_1:codex");
  assert.equal(calls.responder[0].runtimeConfig.deviceId, "device_mac");
  assert.equal(calls.responder[0].runtimeConfig.agentEngine, "codex");
  assert.equal(calls.responder[0].runtimeConfig.providerConnectionId, "mia");
  assert.equal(calls.responder[0].runtimeConfig.modelProfileId, "mia:mia-auto");
  assert.equal(calls.responder[0].runtimeConfig.model, "mia-auto");
  assert.equal(Object.hasOwn(calls.responder[0].runtimeConfig, "baseUrl"), false);
  assert.equal(Object.hasOwn(calls.responder[0].runtimeConfig, "apiKeyEnv"), false);
  assert.equal(Object.hasOwn(calls.responder[0].runtimeConfig, "apiMode"), false);
  assert.deepEqual(calls.responder[0].historyMessages, [
    { role: "user", content: "[user:u_1] 背景" }
  ]);
});

test("desktop ignores bot invocations without a target device", async () => {
  const { dispatcher, calls } = setup({ currentDeviceId: () => "device_mac" });

  const handled = await dispatcher.handleCloudEvent({
    type: "conversation.bot_invocation_requested",
    conversationId: "g_1",
    botId: "codex",
    triggeringMessage: { id: "m_1", body_md: "@codex 看看", sender_kind: "user" }
  });

  assert.equal(handled, false);
  assert.equal(calls.responder.length, 0);
});

test("conversation.message_appended events do not wake the desktop dispatcher", async () => {
  const { dispatcher, calls } = setup();

  const handled = await dispatcher.handleCloudEvent({
    type: "conversation.message_appended",
    conversationId: "g_1",
    message: { id: "m_2", seq: 2, sender_kind: "user", body_md: "大家看看" }
  });

  assert.equal(handled, false);
  assert.equal(calls.responder.length, 0);
});

test("desktop ignores bot invocations targeted at another device", async () => {
  const { dispatcher, calls } = setup({ currentDeviceId: () => "device_mac" });

  const handled = await dispatcher.handleCloudEvent({
    type: "conversation.bot_invocation_requested",
    conversationId: "g_1",
    botId: "codex",
    targetDeviceId: "device_windows",
    runtimeConfig: { deviceId: "device_windows", agentEngine: "codex" },
    triggeringMessage: { id: "m_1", body_md: "@codex 看看", sender_kind: "user" }
  });

  assert.equal(handled, false);
  assert.equal(calls.responder.length, 0);
});

test("desktop handles bot invocations targeted at this device", async () => {
  const { dispatcher, calls } = setup({ currentDeviceId: () => "device_mac" });

  const handled = await dispatcher.handleCloudEvent({
    type: "conversation.bot_invocation_requested",
    conversationId: "g_1",
    botId: "codex",
    runtimeConfig: { deviceId: "device_mac", agentEngine: "codex" },
    triggeringMessage: { id: "m_1", body_md: "@codex 看看", sender_kind: "user" }
  });

  assert.equal(handled, true);
  assert.equal(calls.responder.length, 1);
});

test("desktop ignores bot invocations targeted at stale bridge aliases", async () => {
  const { dispatcher, calls } = setup({
    currentDeviceId: () => "device_mac"
  });

  const handled = await dispatcher.handleCloudEvent({
    type: "conversation.bot_invocation_requested",
    conversationId: "g_1",
    botId: "codex",
    runtimeConfig: { deviceId: "bridge_live", agentEngine: "codex" },
    triggeringMessage: { id: "m_1", body_md: "@codex 看看", sender_kind: "user" }
  });

  assert.equal(handled, false);
  assert.equal(calls.responder.length, 0);
});

test("shouldHandle gate suppresses invocation events", async () => {
  const { dispatcher, calls } = setup({ shouldHandle: () => false });

  const handled = await dispatcher.handleCloudEvent({
    type: "conversation.bot_invocation_requested",
    conversationId: "g_1",
    botId: "codex",
    triggeringMessage: { id: "m_1", body_md: "@codex 看看" }
  });

  assert.equal(handled, false);
  assert.deepEqual(calls.responder, []);
});
