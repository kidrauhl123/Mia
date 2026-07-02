const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createHermesImClient } = require("../src/cloud-agent/hermes-im-client.js");

function createGatewayHarness() {
  const requests = [];
  const handlers = new Map();
  const gateway = {
    closed: false,
    async connect(url) {
      gateway.connectedUrl = url;
    },
    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(handler);
    },
    async request(method, params) {
      requests.push({ method, params });
      if (method === "session.resume") {
        if (gateway.resumeError) throw gateway.resumeError;
        return gateway.resumeResult || { session_id: params.session_id, stored_session_id: params.session_id };
      }
      if (method === "session.create") {
        return gateway.createResult || { session_id: "runtime_new", stored_session_id: "stored_new" };
      }
      if (method === "image.attach") return { image_id: `img_${requests.length}` };
      if (method === "pdf.attach") return { document_id: `pdf_${requests.length}` };
      if (method === "file.attach") {
        return {
          file_id: `file_${requests.length}`,
          ref_text: `[Attached file: ${params.name}]`
        };
      }
      if (method === "prompt.submit") {
        if (typeof gateway.promptSubmitImpl === "function") {
          return gateway.promptSubmitImpl(params);
        }
        const events = gateway.events || [
          { type: "message.delta", session_id: params.session_id, payload: { text: "hel" } },
          { type: "message.complete", session_id: params.session_id, payload: { content: "hello" } }
        ];
        queueMicrotask(() => {
          for (const event of events) gateway.emit(event.type, event);
        });
        return { submitted: true };
      }
      if (method === "approval.respond") {
        if (typeof gateway.approvalRespondImpl === "function") {
          return gateway.approvalRespondImpl(params);
        }
        return { resolved: 1 };
      }
      throw new Error(`unexpected request ${method}`);
    },
    emit(type, event) {
      for (const handler of handlers.get(type) || []) handler(event);
      for (const handler of handlers.get("*") || []) handler(event);
    },
    close() {
      gateway.closed = true;
    }
  };
  return { gateway, requests };
}

function createSessionsStore(initialSession = null) {
  const state = {
    session: initialSession,
    getCalls: [],
    upsertCalls: [],
    clearCalls: []
  };
  return {
    state,
    getSession(userId, botId, conversationId) {
      state.getCalls.push({ userId, botId, conversationId });
      return state.session;
    },
    upsertSession(args) {
      state.upsertCalls.push(args);
      state.session = {
        userId: args.userId,
        botId: args.botId,
        conversationId: args.conversationId,
        runtimeSessionId: args.runtimeSessionId,
        storedSessionId: args.storedSessionId,
        lastTriggerMessageId: args.lastTriggerMessageId || "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
      return state.session;
    },
    clearRuntimeSession(userId, botId, conversationId) {
      state.clearCalls.push({ userId, botId, conversationId });
      state.session = state.session ? { ...state.session, runtimeSessionId: "" } : null;
      return state.session;
    }
  };
}

function baseArgs(overrides = {}) {
  return {
    gatewayWsUrl: "ws://gateway.test/ws",
    apiKey: "secret",
    userId: "user_1",
    bot: { id: "bot_1", displayName: "Bot One" },
    conversationId: "conv_1",
    input: "Hello Hermes",
    ...overrides
  };
}

test("runChat creates a session when no mapping exists and uses mia defaults", async () => {
  const { gateway, requests } = createGatewayHarness();
  const sessionsStore = createSessionsStore();
  const client = createHermesImClient({
    sessionsStore,
    gatewayClientFactory: () => gateway
  });

  const result = await client.runChat(baseArgs());

  assert.equal(gateway.connectedUrl, "ws://gateway.test/ws");
  assert.deepEqual(requests[0], {
    method: "session.create",
    params: {
      title: "Bot One",
      source: "mia-cloud",
      cwd: "/data/workspace",
      model: "mia-auto",
      provider: "mia",
      reasoning_effort: "medium",
      messages: []
    }
  });
  assert.deepEqual(sessionsStore.state.upsertCalls[0], {
    userId: "user_1",
    botId: "bot_1",
    conversationId: "conv_1",
    runtimeSessionId: "runtime_new",
    storedSessionId: "stored_new"
  });
  assert.equal(result.runId, "runtime_new");
  assert.equal(result.content, "hello");
  assert.equal(gateway.closed, true);
});

test("runChat resumes by storedSessionId when a mapping exists", async () => {
  const { gateway, requests } = createGatewayHarness();
  const sessionsStore = createSessionsStore({
    userId: "user_1",
    botId: "bot_1",
    conversationId: "conv_1",
    runtimeSessionId: "runtime_old",
    storedSessionId: "stored_123"
  });
  const client = createHermesImClient({
    sessionsStore,
    gatewayClientFactory: () => gateway
  });

  const result = await client.runChat(baseArgs());

  assert.equal(requests[0].method, "session.resume");
  assert.deepEqual(requests[0].params, { session_id: "stored_123" });
  assert.equal(result.runId, "stored_123");
});

test("runChat clears runtime and creates a fresh session when resume fails", async () => {
  const { gateway, requests } = createGatewayHarness();
  gateway.resumeError = new Error("session gone");
  const sessionsStore = createSessionsStore({
    userId: "user_1",
    botId: "bot_1",
    conversationId: "conv_1",
    runtimeSessionId: "runtime_old",
    storedSessionId: "stored_123"
  });
  const client = createHermesImClient({
    sessionsStore,
    gatewayClientFactory: () => gateway
  });

  const result = await client.runChat(baseArgs());

  assert.equal(sessionsStore.state.clearCalls.length, 1);
  assert.equal(requests[0].method, "session.resume");
  assert.equal(requests[1].method, "session.create");
  assert.equal(result.runId, "runtime_new");
});

test("runChat in transient mode does not read or write the sessions store", async () => {
  const { gateway } = createGatewayHarness();
  const sessionsStore = createSessionsStore({
    userId: "user_1",
    botId: "bot_1",
    conversationId: "conv_1",
    runtimeSessionId: "runtime_old",
    storedSessionId: "stored_123"
  });
  const client = createHermesImClient({
    sessionsStore,
    gatewayClientFactory: () => gateway
  });

  const result = await client.runChat(baseArgs({ transient: true }));

  assert.equal(sessionsStore.state.getCalls.length, 0);
  assert.equal(sessionsStore.state.upsertCalls.length, 0);
  assert.equal(result.runId, "runtime_new");
});

test("runChat prepends file attachment ref_text and streams normalized events", async () => {
  const { gateway, requests } = createGatewayHarness();
  gateway.events = [
    { type: "approval.request", session_id: "runtime_new", payload: { choices: ["once", "deny"] } },
    { type: "message.delta", session_id: "runtime_new", payload: { text: "hel" } },
    { type: "message.complete", session_id: "runtime_new", payload: { content: "hello" } }
  ];
  const sessionsStore = createSessionsStore();
  const seen = [];
  let runCreated = "";
  const client = createHermesImClient({
    sessionsStore,
    gatewayClientFactory: () => gateway
  });

  const result = await client.runChat(baseArgs({
    attachments: [
      { path: "/tmp/doc.txt", mimeType: "text/plain", name: "doc.txt" }
    ],
    onRunCreated(runId) {
      runCreated = runId;
    },
    onEvent(event) {
      seen.push(event);
    }
  }));

  assert.equal(runCreated, "runtime_new");
  assert.equal(requests[1].method, "file.attach");
  assert.equal(requests[2].method, "prompt.submit");
  assert.equal(requests[2].params.prompt, "[Attached file: doc.txt]\n\nHello Hermes");
  assert.deepEqual(seen.map((event) => event.type), [
    "approval.request",
    "message.delta",
    "message.complete"
  ]);
  assert.equal(result.content, "hello");
  assert.deepEqual(result.events.map((event) => event.type), [
    "approval.request",
    "message.delta",
    "message.complete"
  ]);
});

test("runChat ignores text-bearing non-message events when building returned content", async () => {
  const { gateway } = createGatewayHarness();
  gateway.events = [
    { type: "reasoning.delta", session_id: "runtime_new", payload: { text: "internal-thought" } },
    { type: "message.delta", session_id: "runtime_new", payload: { text: "hel" } },
    { type: "message.complete", session_id: "runtime_new", payload: { content: "hello" } }
  ];
  const client = createHermesImClient({
    sessionsStore: createSessionsStore(),
    gatewayClientFactory: () => gateway
  });

  const result = await client.runChat(baseArgs());

  assert.equal(result.content, "hello");
  assert.deepEqual(result.events.map((event) => [event.type, event.text || ""]), [
    ["reasoning_delta", "internal-thought"],
    ["message.delta", "hel"],
    ["message.complete", ""]
  ]);
});

test("runChat rejects when error arrives while prompt.submit is still pending", async () => {
  const { gateway } = createGatewayHarness();
  gateway.promptSubmitImpl = (params) => new Promise(() => {
    queueMicrotask(() => {
      gateway.emit("error", {
        type: "error",
        session_id: params.session_id,
        payload: { message: "submit failed" }
      });
    });
  });
  const client = createHermesImClient({
    sessionsStore: createSessionsStore(),
    gatewayClientFactory: () => gateway
  });

  await assert.rejects(client.runChat(baseArgs()), /submit failed/);
  assert.equal(gateway.closed, true);
});

test("runChat throws when the gateway emits an error event", async () => {
  const { gateway } = createGatewayHarness();
  gateway.events = [
    { type: "error", session_id: "runtime_new", payload: { message: "permission denied" } }
  ];
  const sessionsStore = createSessionsStore();
  const client = createHermesImClient({
    sessionsStore,
    gatewayClientFactory: () => gateway
  });

  await assert.rejects(() => client.runChat(baseArgs()), /permission denied/);
  assert.equal(gateway.closed, true);
});

test("submitApproval calls approval.respond through the gateway", async () => {
  const { gateway, requests } = createGatewayHarness();
  const client = createHermesImClient({
    sessionsStore: createSessionsStore(),
    gatewayClientFactory: () => gateway
  });

  const result = await client.submitApproval({
    gatewayWsUrl: "ws://gateway.test/ws",
    sessionId: "sess_approve",
    choice: "once",
    all: true
  });

  assert.equal(gateway.connectedUrl, "ws://gateway.test/ws");
  assert.deepEqual(requests[0], {
    method: "approval.respond",
    params: { session_id: "sess_approve", choice: "once", all: true }
  });
  assert.deepEqual(result, { resolved: 1 });
  assert.equal(gateway.closed, true);
});

test("submitApproval rejects when aborted before approval.respond resolves", async () => {
  const { gateway } = createGatewayHarness();
  gateway.approvalRespondImpl = () => new Promise(() => {});
  const client = createHermesImClient({
    sessionsStore: createSessionsStore(),
    gatewayClientFactory: () => gateway
  });
  const controller = new AbortController();

  const pending = client.submitApproval({
    gatewayWsUrl: "ws://gateway.test/ws",
    sessionId: "sess_approve",
    choice: "once",
    signal: controller.signal
  });

  controller.abort(new Error("approval aborted"));

  await assert.rejects(pending, /approval aborted/);
  assert.equal(gateway.closed, true);
});

test("submitApproval does not require sessionsStore at client construction", async () => {
  const { gateway, requests } = createGatewayHarness();
  const client = createHermesImClient({
    gatewayClientFactory: () => gateway
  });

  const result = await client.submitApproval({
    gatewayWsUrl: "ws://gateway.test/ws",
    sessionId: "sess_approve",
    choice: "once"
  });

  assert.deepEqual(requests[0], {
    method: "approval.respond",
    params: { session_id: "sess_approve", choice: "once", all: false }
  });
  assert.deepEqual(result, { resolved: 1 });
});
