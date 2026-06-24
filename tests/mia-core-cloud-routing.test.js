const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createCoreBotExecution, createCoreCloudRouting } = require("../src/core/mia-core.js");
const { CloudEvent } = require("../src/shared/cloud-events.js");

// The on-disk manifest is never read: every turn carries a cloud bot snapshot
// (built by buildBotInvocation from the event's botId + members), so the
// adapter graph stays fully real while pointing at a non-existent manifest.
function makeRuntimePaths() {
  return () => ({ botManifest: "/dev/null/does-not-exist", botDir: "/dev/null" });
}

// The real Hermes chat adapter returns a chat.completion envelope; the fake
// mirrors that exact shape so the reply flows back through the same graph the
// local-bot-responder reads (responseText → choices[0].message.content).
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

// A realistic cloud bot-invocation event. Shape verified against the real
// contract: cloud-events-client routes CloudEvent.ConversationBotInvocationRequested
// to dispatcher.handleCloudEvent(message); buildBotInvocation reads
// conversationId/botId/triggeringMessage(.id/.seq/.body_md/.turn_id)/members/
// runtimeConfig, and the dispatcher requires targetDeviceId to match Core's own
// device id.
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

test("cloud → dispatcher → responder → Core sendChat (Hermes) → socialApi reply, node-only", async () => {
  const deviceId = "mia-core-device";
  const sendChatSeen = [];

  // Core's REAL bot-execution graph with ONLY the lowest-level Hermes HTTP send
  // faked (proves sendChat ran the real adapter dispatch).
  const botExecution = createCoreBotExecution({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { daemonSettings: () => ({ enabled: false }) },
    hermesBaseUrl: "",
    apiKey: "test-key",
    sendHermesChat: async (context) => {
      sendChatSeen.push(context);
      return fakeHermesResponse("hi from core");
    }
  });

  // MOCK socialApi recording the as-bot post. listConversationMessages returns
  // no prior reply so the responder proceeds to run.
  const posts = [];
  const socialApi = {
    postConversationMessageAsBot: async (conversationId, body) => {
      posts.push({ conversationId, body });
      return { ok: true, message: { id: "posted_1", body_md: body.bodyMd } };
    },
    listConversationMessages: async () => ({ messages: [] })
  };

  const localEvents = [];
  const { dispatcher } = createCoreCloudRouting({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { cloudSettings: () => ({ enabled: false }), normalizeCloudUrl: (v) => String(v || "") },
    botExecution,
    socialApi,
    emitLocalEvent: (envelope) => localEvents.push(envelope),
    deviceId,
    log: () => {}
  });

  const handled = await dispatcher.handleCloudEvent(botInvocationEvent({ deviceId }));

  // (a) Core's sendChat ran (the fake Hermes send was invoked with a real context).
  assert.equal(handled, true);
  assert.equal(sendChatSeen.length, 1);
  assert.equal(sendChatSeen[0].bot.key, "bot1");
  assert.equal(sendChatSeen[0].bot.agentEngine, "hermes");

  // (b) socialApi.postConversationMessageAsBot got the bot's reply content.
  assert.equal(posts.length, 1);
  assert.equal(posts[0].conversationId, "dm:userA:bot1");
  assert.equal(posts[0].body.botId, "bot1");
  assert.equal(posts[0].body.bodyMd, "hi from core");

  // Run streams reached the injected local event sink (not asserting exact set,
  // just that the channel is wired).
  assert.ok(localEvents.length >= 1);
});

test("dispatcher ignores an invocation targeting a different device (single-owner)", async () => {
  const botExecution = createCoreBotExecution({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { daemonSettings: () => ({ enabled: false }) },
    hermesBaseUrl: "",
    apiKey: "test-key",
    sendHermesChat: async () => fakeHermesResponse("unused")
  });
  const posts = [];
  const socialApi = {
    postConversationMessageAsBot: async (conversationId, body) => { posts.push({ conversationId, body }); return { ok: true }; },
    listConversationMessages: async () => ({ messages: [] })
  };
  const { dispatcher } = createCoreCloudRouting({
    botExecution,
    socialApi,
    deviceId: "mia-core-device"
  });

  const handled = await dispatcher.handleCloudEvent(botInvocationEvent({ deviceId: "some-other-device" }));
  assert.equal(handled, false);
  assert.equal(posts.length, 0);
});
