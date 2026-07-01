const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createMiaCore, createCoreBotExecution, createCoreCloudRouting } = require("../src/core/mia-core.js");
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
  const deviceId = "device_core_fixture";
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

test("core cloud routing materializes cloud attachments before local bot execution", async () => {
  const deviceId = "device_core_fixture";
  const sendChatSeen = [];
  const posts = [];
  const fetchCalls = [];
  const docBytes = Buffer.from("doc bytes");
  const docMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const socialApi = {
    postConversationMessageAsBot: async (conversationId, body) => {
      posts.push({ conversationId, body });
      return { ok: true, message: { id: "posted_1", body_md: body.bodyMd } };
    },
    listConversationMessages: async () => ({ messages: [] })
  };
  const settingsStore = {
    cloudSettings: () => ({ enabled: true, url: "https://mia.test", token: "token_1" }),
    normalizeCloudUrl: (value) => String(value || "").replace(/\/+$/, "")
  };

  const { dispatcher } = createCoreCloudRouting({
    runtimePaths: makeRuntimePaths(),
    settingsStore,
    botExecution: {
      sendChat: async (context) => {
        sendChatSeen.push(context);
        return fakeHermesResponse("看到了文档");
      }
    },
    socialApi,
    fetchImpl: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), headers: options.headers || {} });
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => String(name || "").toLowerCase() === "content-type" ? docMime : null },
        arrayBuffer: async () => docBytes.buffer.slice(docBytes.byteOffset, docBytes.byteOffset + docBytes.byteLength)
      };
    },
    timeoutSignal: () => undefined,
    emitLocalEvent: () => {},
    deviceId,
    log: () => {}
  });

  const event = botInvocationEvent({ deviceId });
  event.triggeringMessage.attachments_json = JSON.stringify([{
    id: "file_doc",
    name: "业务信息调查表.docx",
    url: "/api/files/file_doc",
    mimeType: docMime,
    kind: "file",
    size: docBytes.length
  }]);

  const handled = await dispatcher.handleCloudEvent(event);

  assert.equal(handled, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://mia.test/api/files/file_doc");
  assert.equal(fetchCalls[0].headers.Authorization, "Bearer token_1");
  assert.equal(sendChatSeen.length, 1);
  const attachment = sendChatSeen[0].messages.at(-1).attachments[0];
  assert.equal(attachment.name, "业务信息调查表.docx");
  assert.equal(attachment.url, "/api/files/file_doc");
  assert.ok(path.isAbsolute(attachment.path));
  assert.equal(fs.readFileSync(attachment.path, "utf8"), "doc bytes");
  assert.equal(posts[0].body.bodyMd, "看到了文档");
  fs.rmSync(path.dirname(attachment.path), { recursive: true, force: true });
});

test("core cloud routing stopChat aborts the active conversation run", async () => {
  const deviceId = "device_core_fixture";
  const seenSignals = [];

  const botExecution = {
    sendChat: async (context) => {
      seenSignals.push(context.signal);
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          const stopped = new Error("生成已停止");
          stopped.code = "MIA_STOPPED";
          reject(stopped);
        }, { once: true });
      });
    }
  };
  const socialApi = {
    postConversationMessageAsBot: async () => ({ ok: true }),
    listConversationMessages: async () => ({ messages: [] })
  };
  const localEvents = [];
  const routing = createCoreCloudRouting({
    botExecution,
    socialApi,
    emitLocalEvent: (envelope) => localEvents.push(envelope),
    deviceId,
    log: () => {}
  });

  const pending = routing.dispatcher.handleCloudEvent(botInvocationEvent({ deviceId }));
  for (let i = 0; i < 20 && seenSignals.length === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(seenSignals.length, 1);
  assert.equal(seenSignals[0].aborted, false);
  const result = routing.stopChat({ conversationId: "dm:userA:bot1" });
  assert.equal(result.stopped, true);
  assert.equal(seenSignals[0].aborted, true);
  await pending;
  assert.equal(localEvents.at(-1).payload.event.type, "run.cancelled");
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
    deviceId: "device_core_fixture"
  });

  const handled = await dispatcher.handleCloudEvent(botInvocationEvent({ deviceId: "some-other-device" }));
  assert.equal(handled, false);
  assert.equal(posts.length, 0);
});

test("createCoreCloudRouting requires an explicit persisted device id", () => {
  assert.throws(() => createCoreCloudRouting({
    botExecution: { sendChat: async () => fakeHermesResponse("unused") },
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

  const sendChatSeen = [];
  const posts = [];
  const core = createMiaCore({ env: { MIA_HOME: home }, version: "0.0.0-test" });
  const { dispatcher } = core.cloudRouting({
    botExecution: {
      sendChat: async (context) => {
        sendChatSeen.push(context);
        return fakeHermesResponse("hi from persisted device");
      }
    },
    socialApi: {
      postConversationMessageAsBot: async (conversationId, body) => {
        posts.push({ conversationId, body });
        return { ok: true, message: { id: "posted_1", body_md: body.bodyMd } };
      },
      listConversationMessages: async () => ({ messages: [] })
    }
  });

  const handled = await dispatcher.handleCloudEvent(botInvocationEvent({ deviceId: "device_existing_air7" }));

  assert.equal(handled, true);
  assert.equal(sendChatSeen.length, 1);
  assert.equal(posts.length, 1);
});

test("createMiaCore cloud routing rereads the persisted device identity", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-routing-reset-identity-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const identityPath = path.join(home, "mia-device.json");
  fs.writeFileSync(identityPath, JSON.stringify({
    id: "device_existing_air7",
    createdAt: "2026-06-18T03:09:46.142Z"
  }, null, 2));

  const sendChatSeen = [];
  const core = createMiaCore({ env: { MIA_HOME: home }, version: "0.0.0-test" });
  const { dispatcher } = core.cloudRouting({
    botExecution: {
      sendChat: async (context) => {
        sendChatSeen.push(context);
        return fakeHermesResponse("hi from reset device");
      }
    },
    socialApi: {
      postConversationMessageAsBot: async () => ({ ok: true, message: { id: "posted_1" } }),
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
  assert.equal(sendChatSeen.length, 1);
});
