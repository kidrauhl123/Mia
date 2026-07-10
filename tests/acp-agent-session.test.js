const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  AcpAgentSession,
  createAcpAgentSession,
  createPermissionAutoApproval,
  createPermissionFallback,
  defaultCreateTransport
} = require("../src/main/agent-session/acp-agent-session.js");
const {
  normalizeAcpSessionUpdate
} = require("../src/main/agent-session/acp-event-normalizer.js");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createFakeTransport() {
  return {
    closeCalls: 0,
    killCalls: 0,
    process: { pid: 4242 },
    async close() {
      this.closeCalls += 1;
    },
    async kill() {
      this.killCalls += 1;
    }
  };
}

function createSession(options = {}) {
  const state = {
    transport: options.transport || createFakeTransport(),
    initializeCalls: [],
    newSessionCalls: [],
    loadSessionCalls: [],
    resumeSessionCalls: [],
    promptCalls: [],
    cancelCalls: []
  };
  const deferredPrompt = options.deferredPrompt || createDeferred();

  const session = createAcpAgentSession({
    engineSpec: options.engineSpec || { engineId: "codex", command: "npx", args: ["fake-acp"] },
    sessionKey: options.sessionKey || "conversation-1::codex::/repo",
    workspacePath: options.workspacePath || "/repo",
    conversationId: options.conversationId || "conversation-1",
    engineId: options.engineId || "codex",
    botId: options.botId,
    permissionMode: options.permissionMode,
    requestPermission: options.requestPermission,
    nativeSessionId: options.nativeSessionId,
    initializationMetadata: options.initializationMetadata,
    mcpServers: options.mcpServers,
    initialPromptPrefix: options.initialPromptPrefix,
    refreshMcpContext: options.refreshMcpContext,
    env: options.env,
    createTransport: options.createTransport || (async () => state.transport),
    createClient: options.createClient || (async ({ onSessionUpdate, onPermissionRequest }) => ({
      async initialize(params) {
        state.initializeCalls.push(params);
        return options.initializeResult || { protocolVersion: 1 };
      },
      async newSession(params) {
        state.newSessionCalls.push(params);
        return { sessionId: "acp-session-1" };
      },
      async loadSession(params) {
        state.loadSessionCalls.push(params);
        if (typeof options.onLoadSession === "function") {
          await options.onLoadSession({ params, onSessionUpdate, state });
        }
        return options.loadSessionResult || {};
      },
      async resumeSession(params) {
        state.resumeSessionCalls.push(params);
        return options.resumeSessionResult || { sessionId: params.sessionId };
      },
      async prompt(params) {
        state.promptCalls.push(params);
        if (typeof options.onPrompt === "function") {
          await options.onPrompt({ params, onSessionUpdate, deferredPrompt, state });
        }
        return deferredPrompt.promise;
      },
      async cancel(params) {
        state.cancelCalls.push(params);
      }
    }))
  });

  return { session, state, deferredPrompt };
}

function collectEvents(session) {
  const events = [];
  for (const kind of [
    "session-started",
    "message-started",
    "assistant-delta",
    "tool-call-started",
    "tool-call-delta",
    "tool-call-completed",
    "message-completed",
    "message-cancelled",
    "message-failed",
    "session-closed"
  ]) {
    session.on(kind, (payload) => events.push([kind, payload]));
  }
  return events;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("start initializes the ACP session once", async () => {
  const { session, state } = createSession();
  const events = collectEvents(session);

  await session.start();
  await session.start();

  assert.equal(state.initializeCalls.length, 1);
  assert.equal(state.newSessionCalls.length, 1);
  assert.deepEqual(state.newSessionCalls[0], {
    cwd: "/repo",
    mcpServers: [],
    _meta: {
      sessionKey: "conversation-1::codex::/repo",
      conversationId: "conversation-1",
      engineId: "codex",
      initializationMetadata: null
    }
  });
  assert.deepEqual(events, [
    ["session-started", {
      engineId: "codex",
      conversationId: "conversation-1",
      sessionKey: "conversation-1::codex::/repo",
      workspacePath: "/repo",
      acpSessionId: "acp-session-1"
    }]
  ]);
});

test("start loads a persisted ACP session and suppresses replayed history updates", async () => {
  const { session, state } = createSession({
    nativeSessionId: "acp-session-existing",
    initializeResult: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true }
    },
    onLoadSession: async ({ params, onSessionUpdate }) => {
      await onSessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "historical-msg",
          content: { type: "text", text: "old assistant text" }
        }
      });
    }
  });
  const events = collectEvents(session);

  await session.start();

  assert.equal(state.newSessionCalls.length, 0);
  assert.equal(state.loadSessionCalls.length, 1);
  assert.deepEqual(state.loadSessionCalls[0], {
    sessionId: "acp-session-existing",
    cwd: "/repo",
    mcpServers: [],
    _meta: {
      sessionKey: "conversation-1::codex::/repo",
      conversationId: "conversation-1",
      engineId: "codex",
      initializationMetadata: null
    }
  });
  assert.deepEqual(events, [
    ["session-started", {
      engineId: "codex",
      conversationId: "conversation-1",
      sessionKey: "conversation-1::codex::/repo",
      workspacePath: "/repo",
      acpSessionId: "acp-session-existing"
    }]
  ]);
});

test("start rebuilds a fresh ACP session when the persisted session id is stale", async () => {
  const { session, state } = createSession({
    nativeSessionId: "acp-session-stale",
    initialPromptPrefix: "## Mia Scoped Context",
    initializeResult: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true }
    },
    createClient: async () => ({
      async initialize(params) {
        state.initializeCalls.push(params);
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true }
        };
      },
      async newSession(params) {
        state.newSessionCalls.push(params);
        return { sessionId: "acp-session-new" };
      },
      async loadSession(params) {
        state.loadSessionCalls.push(params);
        throw new Error("Session not found: acp-session-stale");
      },
      async prompt(params) {
        state.promptCalls.push(params);
        return { stopReason: "end_turn" };
      },
      async cancel() {}
    })
  });

  await session.sendUserInput({ turnId: "turn-1", text: "continue" });

  assert.equal(state.loadSessionCalls.length, 1);
  assert.equal(state.newSessionCalls.length, 1);
  assert.equal(session.acpSessionId, "acp-session-new");
  assert.deepEqual(state.promptCalls[0], {
    sessionId: "acp-session-new",
    prompt: [{ type: "text", text: "## Mia Scoped Context\n\ncontinue" }]
  });
});

test("start resumes a persisted Claude ACP session through claudeCode metadata", async () => {
  const { session, state } = createSession({
    engineId: "claude",
    engineSpec: { engineId: "claude", command: "claude", args: [] },
    nativeSessionId: "claude-session-existing",
    loadSessionResult: { sessionId: "should-not-be-used" }
  });

  await session.start();

  assert.equal(state.loadSessionCalls.length, 0);
  assert.deepEqual(state.newSessionCalls, [{
    cwd: "/repo",
    mcpServers: [],
    _meta: {
      sessionKey: "conversation-1::codex::/repo",
      conversationId: "conversation-1",
      engineId: "claude",
      initializationMetadata: null,
      claudeCode: {
        options: {
          resume: "claude-session-existing"
        }
      }
    }
  }]);
  assert.equal(session.acpSessionId, "acp-session-1");
});

test("start injects configured MCP servers into ACP session/new", async () => {
  const mcpServers = [{
    name: "mia-app",
    command: "/usr/bin/node",
    args: ["/tmp/mia-app-mcp-server.js"],
    env: [{ name: "MIA_CORE_URL", value: "http://127.0.0.1:27861" }]
  }];
  const { session, state } = createSession({ mcpServers });

  await session.start();

  assert.deepEqual(state.newSessionCalls[0].mcpServers, mcpServers);
});

test("sendUserInput prepends the session prelude only on the first prompt and refreshes MCP context each turn", async () => {
  const refreshCalls = [];
  const { session, state, deferredPrompt } = createSession({
    initialPromptPrefix: "## Mia Scoped Context\nUse mia-app tools.",
    refreshMcpContext: async (context) => {
      refreshCalls.push(context);
    }
  });

  const first = session.sendUserInput({ turnId: "turn-1", text: "hello" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.promptCalls[0].prompt, [{
    type: "text",
    text: "## Mia Scoped Context\nUse mia-app tools.\n\nhello"
  }]);
  deferredPrompt.resolve({ stopReason: "end_turn" });
  await first;

  const secondDeferred = createDeferred();
  state.promptCalls.length = 0;
  session.activePrompt = null;
  const originalPrompt = session.client.prompt;
  session.client.prompt = async (params) => {
    state.promptCalls.push(params);
    return secondDeferred.promise;
  };
  const second = session.sendUserInput({ turnId: "turn-2", text: "again" });
  await new Promise((resolve) => setImmediate(resolve));
  secondDeferred.resolve({ stopReason: "end_turn" });
  await second;
  session.client.prompt = originalPrompt;

  assert.deepEqual(refreshCalls.map((call) => call.turnId), ["turn-1", "turn-2"]);
  assert.equal(refreshCalls[0].acpSessionId, "acp-session-1");
  assert.equal(refreshCalls[0].conversationId, "conversation-1");
  assert.equal(refreshCalls[0].engineId, "codex");
  assert.equal(refreshCalls[0].sessionKey, "conversation-1::codex::/repo");
  assert.deepEqual(state.promptCalls[0].prompt, [{ type: "text", text: "again" }]);
});

test("start forwards per-session env to the ACP transport", async () => {
  const transportCalls = [];
  const { session } = createSession({
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
      ANTHROPIC_AUTH_TOKEN: "proxy-token"
    },
    createTransport: async (options) => {
      transportCalls.push(options);
      return createFakeTransport();
    }
  });

  await session.start();

  assert.deepEqual(transportCalls.map((call) => call.env), [{
    ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
    ANTHROPIC_AUTH_TOKEN: "proxy-token"
  }]);
});

test("sendUserInput waits for prompt completion and emits normalized streaming events", async () => {
  const { session, state, deferredPrompt } = createSession({
    onPrompt: async ({ onSessionUpdate, params }) => {
      assert.equal(params.prompt.length, 1);
      assert.deepEqual(params.prompt[0], { type: "text", text: "hello ACP" });
      assert.equal("visibleMessages" in params, false);
      assert.equal("messages" in params, false);

      await onSessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg-1",
          content: { type: "text", text: "hi" }
        }
      });
      await onSessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Shell",
          rawInput: { command: "pwd" }
        }
      });
      await onSessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "in_progress",
          rawOutput: { stdout: "/repo" }
        }
      });
      await onSessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          rawOutput: { stdout: "/repo" }
        }
      });
    }
  });
  const events = collectEvents(session);

  const sendPromise = session.sendUserInput({
    turnId: "turn-1",
    text: "hello ACP"
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.promptCalls.length, 1);

  const notDone = Promise.race([
    sendPromise.then(() => "resolved"),
    new Promise((resolve) => setImmediate(() => resolve("pending")))
  ]);
  assert.equal(await notDone, "pending");

  deferredPrompt.resolve({ stopReason: "end_turn" });
  await sendPromise;

  assert.deepEqual(events, [
    ["session-started", {
      engineId: "codex",
      conversationId: "conversation-1",
      sessionKey: "conversation-1::codex::/repo",
      workspacePath: "/repo",
      acpSessionId: "acp-session-1"
    }],
    ["message-started", {
      engineId: "codex",
      conversationId: "conversation-1",
      sessionKey: "conversation-1::codex::/repo",
      workspacePath: "/repo",
      turnId: "turn-1"
    }],
    ["assistant-delta", {
      engineId: "codex",
      conversationId: "conversation-1",
      sessionKey: "conversation-1::codex::/repo",
      workspacePath: "/repo",
      turnId: "turn-1",
      messageId: "msg-1",
      text: "hi"
    }],
    ["tool-call-started", {
      engineId: "codex",
      conversationId: "conversation-1",
      sessionKey: "conversation-1::codex::/repo",
      workspacePath: "/repo",
      turnId: "turn-1",
      toolCallId: "tool-1",
      title: "Shell",
      preview: "{\"command\":\"pwd\"}"
    }],
    ["tool-call-delta", {
      engineId: "codex",
      conversationId: "conversation-1",
      sessionKey: "conversation-1::codex::/repo",
      workspacePath: "/repo",
      turnId: "turn-1",
      toolCallId: "tool-1",
      title: "Shell",
      status: "in_progress",
      preview: "{\"stdout\":\"/repo\"}"
    }],
    ["tool-call-completed", {
      engineId: "codex",
      conversationId: "conversation-1",
      sessionKey: "conversation-1::codex::/repo",
      workspacePath: "/repo",
      turnId: "turn-1",
      toolCallId: "tool-1",
      title: "Shell",
      status: "completed",
      preview: "{\"stdout\":\"/repo\"}"
    }],
    ["message-completed", {
      engineId: "codex",
      conversationId: "conversation-1",
      sessionKey: "conversation-1::codex::/repo",
      workspacePath: "/repo",
      turnId: "turn-1",
      stopReason: "end_turn"
    }]
  ]);
});

test("sendUserInput accepts direct session update payloads from newer ACP clients", async () => {
  const { session, deferredPrompt } = createSession({
    onPrompt: async ({ onSessionUpdate }) => {
      await onSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "direct update" }
      });
    }
  });
  const events = collectEvents(session);

  const sendPromise = session.sendUserInput({
    turnId: "turn-direct",
    text: "hello"
  });
  await new Promise((resolve) => setImmediate(resolve));
  deferredPrompt.resolve({ stopReason: "end_turn" });
  await sendPromise;

  assert.equal(
    events.some((event) => event[0] === "assistant-delta" && event[1].text === "direct update"),
    true
  );
});

test("sendUserInput retries a managed prompt when the agent requests LOAD_SKILL", async () => {
  let promptCount = 0;
  const { session, state } = createSession({
    createClient: async ({ onSessionUpdate, onPermissionRequest }) => ({
      async initialize() {
        return { protocolVersion: 1 };
      },
      async newSession() {
        return { sessionId: "acp-session-1" };
      },
      async prompt(params) {
        state.promptCalls.push(params);
        promptCount += 1;
        if (promptCount === 1) {
          await onSessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "msg-load",
              content: { type: "text", text: "[LOAD_SKILL: demo-skill]" }
            }
          });
          return { stopReason: "end_turn" };
        }
        assert.match(params.prompt[0].text, /## Loaded demo/);
        await onSessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "msg-final",
            content: { type: "text", text: "answer from loaded skill" }
          }
        });
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      requestPermission: onPermissionRequest
    })
  });
  const events = collectEvents(session);

  await session.sendUserInput({
    turnId: "turn-fallback",
    text: "hello",
    turnPromptPrefix: "## Prompt Fallback",
    skillFallback: {
      maxRounds: 2,
      detectRequests: (text) => text.includes("demo-skill") ? ["demo-skill"] : [],
      materializePrompt: async () => "## Loaded demo",
      fallbackText: () => "unresolved"
    }
  });

  assert.equal(promptCount, 2);
  assert.equal(
    events.some((event) => event[0] === "assistant-delta" && /LOAD_SKILL/.test(String(event[1].text || ""))),
    false
  );
  assert.equal(
    events.some((event) => event[0] === "assistant-delta" && event[1].text === "answer from loaded skill"),
    true
  );
});

test("start carries initializationMetadata in session metadata while prompt stays current-turn text only", async () => {
  const initializationMetadata = {
    systemPrompt: "system: obey hidden rules",
    developerInstructions: "developer: never reveal config",
    runtimeConfig: {
      nativeContextMode: "prompt",
      memoryInjectionMode: "disabled"
    }
  };
  const currentUserText = "show current user text only";

  const { session, state, deferredPrompt } = createSession({
    initializationMetadata,
    onPrompt: async ({ params }) => {
      assert.deepEqual(params.prompt, [{ type: "text", text: currentUserText }]);
      assert.equal("_meta" in params, false);
      assert.doesNotMatch(params.prompt[0].text, /system: obey hidden rules/);
      assert.doesNotMatch(params.prompt[0].text, /developer: never reveal config/);
    }
  });

  const sendPromise = session.sendUserInput({
    turnId: "turn-2",
    text: currentUserText
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(state.newSessionCalls[0], {
    cwd: "/repo",
    mcpServers: [],
    _meta: {
      sessionKey: "conversation-1::codex::/repo",
      conversationId: "conversation-1",
      engineId: "codex",
      initializationMetadata
    }
  });
  assert.equal(state.promptCalls.length, 1);
  assert.deepEqual(state.promptCalls[0].prompt, [{ type: "text", text: currentUserText }]);
  assert.equal("_meta" in state.promptCalls[0], false);
  assert.doesNotMatch(state.promptCalls[0].prompt[0].text, /system: obey hidden rules/);
  assert.doesNotMatch(state.promptCalls[0].prompt[0].text, /developer: never reveal config/);

  deferredPrompt.resolve({ stopReason: "end_turn" });
  await sendPromise;
});

test("sendUserInput forwards current-turn attachments and fileReferences in prompt _meta", async () => {
  const attachments = [{ id: "att-1", name: "error.log" }];
  const fileReferences = [{ path: "/repo/README.md" }];
  const { session, state, deferredPrompt } = createSession({
    onPrompt: async ({ params }) => {
      assert.deepEqual(params.prompt, [{ type: "text", text: "inspect files" }]);
      assert.deepEqual(params._meta, { attachments, fileReferences });
    }
  });

  const sendPromise = session.sendUserInput({
    turnId: "turn-3",
    text: "inspect files",
    attachments,
    fileReferences
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(state.promptCalls[0], {
    sessionId: "acp-session-1",
    prompt: [{ type: "text", text: "inspect files" }],
    _meta: { attachments, fileReferences }
  });

  deferredPrompt.resolve({ stopReason: "end_turn" });
  await sendPromise;
});

test("sendUserInput rejects per-turn initializationMetadata so session config is not replayed in prompt metadata", async () => {
  const { session, state } = createSession();

  await assert.rejects(
    () => session.sendUserInput({
      turnId: "turn-4",
      text: "hello ACP",
      initializationMetadata: { systemPromptId: "native-default" }
    }),
    /initializationMetadata.*session/i
  );

  assert.equal(state.newSessionCalls.length, 0);
  assert.equal(state.promptCalls.length, 0);
});

test("sendUserInput rejects visible transcript replay before constructing the ACP prompt", async () => {
  const { session, state } = createSession();

  for (const key of ["messages", "visibleMessages"]) {
    await assert.rejects(
      () => session.sendUserInput({
        turnId: "turn-1",
        text: "hello ACP",
        [key]: [
          { role: "user", content: "older message" },
          { role: "assistant", content: "older reply" }
        ]
      }),
      /native input policy/i
    );
  }

  assert.equal(state.promptCalls.length, 0);
});

test("cancel sends an ACP cancel request while the prompt is in flight", async () => {
  const { session, state, deferredPrompt } = createSession();

  const sendPromise = session.sendUserInput({
    turnId: "turn-1",
    text: "hello ACP"
  });
  await new Promise((resolve) => setImmediate(resolve));

  await session.cancel();

  assert.deepEqual(state.cancelCalls, [{ sessionId: "acp-session-1" }]);

  deferredPrompt.resolve({ stopReason: "cancelled" });
  await assert.rejects(sendPromise, /cancelled/i);
});

test("createPermissionFallback prefers reject_once over reject_always", () => {
  const result = createPermissionFallback({
    options: [
      { optionId: "allow", kind: "allow_once" },
      { optionId: "reject-always", kind: "reject_always" },
      { optionId: "reject-once", kind: "reject_once" }
    ]
  });

  assert.deepEqual(result, {
    outcome: { outcome: "selected", optionId: "reject-once" }
  });
});

test("createPermissionAutoApproval prefers allow_always for full access runs", () => {
  const result = createPermissionAutoApproval({
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
      { optionId: "allow-always", kind: "allow_always" }
    ]
  });

  assert.deepEqual(result, {
    outcome: { outcome: "selected", optionId: "allow-always" }
  });
});

test("permission requests without full access wait for the injected approval coordinator", async () => {
  let permissionHandler;
  const permissionEvents = [];
  const requestCalls = [];
  const { session } = createSession({
    requestPermission: async (request) => {
      requestCalls.push(request);
      request.emit("permission_request", {
        requestId: "perm_acp_1",
        engine: request.engine,
        botId: request.botId,
        sessionId: request.sessionId,
        toolName: request.toolName,
        title: request.title,
        preview: request.preview
      });
      await Promise.resolve();
      request.emit("permission_resolved", {
        requestId: "perm_acp_1",
        decision: "allow_once"
      });
      return { decision: "allow", scope: "once" };
    },
    createClient: async ({ onSessionUpdate, onPermissionRequest }) => {
      permissionHandler = onPermissionRequest;
      return {
        async initialize() {
          return { protocolVersion: 1 };
        },
        async newSession() {
          return { sessionId: "acp-session-1" };
        },
        async prompt() {
          return new Promise(() => {});
        },
        async cancel() {}
      };
    }
  });
  session.on("permission-requested", (payload) => permissionEvents.push(payload));

  const sendPromise = session.sendUserInput({
    turnId: "turn-1",
    text: "show process list"
  });
  await new Promise((resolve) => setImmediate(resolve));

  const result = await permissionHandler({
    toolCall: {
      toolCallId: "tool-1",
      kind: "execute",
      title: "Shell command",
      rawInput: { command: "ps -axo rss=,comm=" }
    },
    options: [
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" }
    ]
  });

  assert.equal(requestCalls.length, 1);
  assert.equal(requestCalls[0].engine, "codex");
  assert.equal(requestCalls[0].sessionId, "conversation-1");
  assert.equal(requestCalls[0].toolName, "Shell command");
  assert.match(requestCalls[0].preview, /ps -axo/);
  assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "allow-once" } });
  assert.equal(permissionEvents.length, 3);
  assert.equal(permissionEvents[1].event.type, "permission_request");
  assert.equal(permissionEvents[1].event.requestId, "perm_acp_1");
  assert.equal(permissionEvents[2].event.type, "permission_resolved");

  void sendPromise;
});

test("full access permission mode auto-approves ACP permission requests", async () => {
  let permissionHandler;
  const { session } = createSession({
    permissionMode: ":danger-full-access",
    createClient: async ({ onSessionUpdate, onPermissionRequest }) => {
      permissionHandler = onPermissionRequest;
      return {
        async initialize() {
          return { protocolVersion: 1 };
        },
        async newSession() {
          return { sessionId: "acp-session-1" };
        },
        async prompt() {
          return new Promise(() => {});
        },
        async cancel() {}
      };
    }
  });

  const sendPromise = session.sendUserInput({
    turnId: "turn-1",
    text: "start dev server"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    await permissionHandler({
      options: [
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "reject-once", kind: "reject_once" }
      ]
    }),
    { outcome: { outcome: "selected", optionId: "allow-once" } }
  );

  void sendPromise;
});

test("permission requests after cancel return cancelled for the active prompt", async () => {
  let permissionHandler;
  const { session } = createSession({
    createClient: async ({ onSessionUpdate, onPermissionRequest }) => {
      permissionHandler = onPermissionRequest;
      return {
        async initialize() {
          return { protocolVersion: 1 };
        },
        async newSession() {
          return { sessionId: "acp-session-1" };
        },
        async prompt() {
          return new Promise(() => {});
        },
        async cancel() {}
      };
    }
  });

  const sendPromise = session.sendUserInput({
    turnId: "turn-1",
    text: "hello ACP"
  });
  await new Promise((resolve) => setImmediate(resolve));

  await session.cancel();

  assert.deepEqual(
    await permissionHandler({
      options: [
        { optionId: "reject-always", kind: "reject_always" },
        { optionId: "reject-once", kind: "reject_once" }
      ]
    }),
    { outcome: { outcome: "cancelled" } }
  );

  void sendPromise;
});

test("a new prompt clears cancelled permission state", async () => {
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  const promptQueue = [firstPrompt, secondPrompt];
  let permissionHandler;
  const { session } = createSession({
    deferredPrompt: promptQueue[0],
    createClient: async ({ onSessionUpdate, onPermissionRequest }) => {
      permissionHandler = onPermissionRequest;
      return {
        async initialize() {
          return { protocolVersion: 1 };
        },
        async newSession() {
          return { sessionId: "acp-session-1" };
        },
        async prompt() {
          return promptQueue.shift().promise;
        },
        async cancel() {}
      };
    }
  });

  const firstSend = session.sendUserInput({
    turnId: "turn-1",
    text: "first"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await session.cancel();

  assert.deepEqual(
    await permissionHandler({
      options: [
        { optionId: "reject-always", kind: "reject_always" },
        { optionId: "reject-once", kind: "reject_once" }
      ]
    }),
    { outcome: { outcome: "cancelled" } }
  );

  firstPrompt.resolve({ stopReason: "cancelled" });
  await assert.rejects(firstSend, /cancelled/i);

  const secondSend = session.sendUserInput({
    turnId: "turn-2",
    text: "second"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    await permissionHandler({
      options: [
        { optionId: "reject-always", kind: "reject_always" },
        { optionId: "reject-once", kind: "reject_once" }
      ]
    }),
    { outcome: { outcome: "selected", optionId: "reject-once" } }
  );

  secondPrompt.resolve({ stopReason: "end_turn" });
  await secondSend;
});

test("kill closes the transport and emits session-closed once", async () => {
  const transport = createFakeTransport();
  const { session } = createSession({ transport });
  const events = collectEvents(session);

  await session.start();
  await session.kill();
  await session.kill();

  assert.equal(transport.closeCalls, 1);
  assert.equal(transport.killCalls, 1);
  assert.deepEqual(events.at(-1), ["session-closed", {
    engineId: "codex",
    conversationId: "conversation-1",
    sessionKey: "conversation-1::codex::/repo",
    workspacePath: "/repo"
  }]);
});

test("prompt errors emit message-failed with engine and session metadata", async () => {
  const failure = new Error("prompt exploded");
  const { session } = createSession({
    onPrompt: async () => {
      throw failure;
    }
  });
  const events = collectEvents(session);

  await assert.rejects(
    session.sendUserInput({ turnId: "turn-9", text: "boom" }),
    /prompt exploded/
  );

  assert.deepEqual(events.at(-1), ["message-failed", {
    engineId: "codex",
    conversationId: "conversation-1",
    sessionKey: "conversation-1::codex::/repo",
    workspacePath: "/repo",
    turnId: "turn-9",
    error: failure
  }]);
});

test("startup errors emit message-failed with engine and session metadata", async () => {
  const failure = new Error("acp failed to start");
  const { session } = createSession({
    createTransport: async () => {
      throw failure;
    }
  });
  const events = collectEvents(session);

  await assert.rejects(
    session.sendUserInput({ turnId: "turn-start", text: "hello" }),
    /acp failed to start/
  );

  assert.deepEqual(events.at(-1), ["message-failed", {
    engineId: "codex",
    conversationId: "conversation-1",
    sessionKey: "conversation-1::codex::/repo",
    workspacePath: "/repo",
    turnId: "turn-start",
    error: failure
  }]);
});

test("transport startup process errors emit message-failed instead of hanging", async () => {
  const error = new Error("spawn npx ENOENT");
  error.code = "ENOENT";
  const startupError = new Promise((_resolve, reject) => {
    setImmediate(() => reject(error));
  });
  startupError.catch(() => {});
  const transport = {
    ...createFakeTransport(),
    startupError
  };
  const { session } = createSession({
    createTransport: async () => transport,
    createClient: async () => ({
      initialize: () => new Promise(() => {}),
      newSession: async () => ({ sessionId: "never-reached" }),
      prompt: async () => ({ stopReason: "end_turn" })
    })
  });
  const events = collectEvents(session);

  const result = await Promise.race([
    session.sendUserInput({ turnId: "turn-enoent", text: "hi" })
      .then(() => ({ status: "resolved" }), (thrown) => ({ status: "rejected", thrown })),
    wait(60).then(() => ({ status: "timeout" }))
  ]);

  assert.equal(result.status, "rejected");
  assert.equal(result.thrown, error);
  assert.deepEqual(events, [[
    "message-failed",
    {
      engineId: "codex",
      conversationId: "conversation-1",
      sessionKey: "conversation-1::codex::/repo",
      workspacePath: "/repo",
      turnId: "turn-enoent",
      error
    }
  ]]);
});

test("normalizeAcpSessionUpdate maps ACP updates into AgentSession event kinds", () => {
  const toolTitles = new Map([["tool-1", "Shell"]]);

  assert.deepEqual(
    normalizeAcpSessionUpdate({
      turnId: "turn-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-1",
        content: { type: "text", text: "hello" }
      },
      toolTitles
    }),
    [{
      kind: "assistant-delta",
      payload: {
        turnId: "turn-1",
        messageId: "msg-1",
        text: "hello"
      }
    }]
  );

  assert.deepEqual(
    normalizeAcpSessionUpdate({
      turnId: "turn-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { stdout: "/repo" }
      },
      toolTitles
    }),
    [{
      kind: "tool-call-completed",
      payload: {
        turnId: "turn-1",
        toolCallId: "tool-1",
        title: "Shell",
        status: "completed",
        preview: "{\"stdout\":\"/repo\"}"
      }
    }]
  );
});

test("normalizeAcpSessionUpdate extracts ACP file diffs from completed tool output", () => {
  const toolTitles = new Map([["tool-1", "Editing files"]]);

  assert.deepEqual(
    normalizeAcpSessionUpdate({
      turnId: "turn-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: {
          result_display: {
            file_diff: {
              path: "src/app.js",
              diff: "@@\n-old\n+new"
            }
          }
        }
      },
      toolTitles
    }),
    [
      {
        kind: "tool-call-completed",
        payload: {
          turnId: "turn-1",
          toolCallId: "tool-1",
          title: "Editing files",
          status: "completed",
          preview: "{\"result_display\":{\"file_diff\":{\"path\":\"src/app.js\",\"diff\":\"@@\\n-old\\n+new\"}}}"
        }
      },
      {
        kind: "file-edit",
        payload: {
          turnId: "turn-1",
          toolCallId: "tool-1",
          id: "tool-1_diff_0",
          path: "src/app.js",
          action: "update",
          title: "Edited src/app.js (+1 -1)",
          diff: "@@\n-old\n+new",
          additions: 1,
          deletions: 1,
          status: "completed",
          error: false
        }
      }
    ]
  );
});

test("normalizeAcpSessionUpdate suppresses Codex Mia Auto metadata warnings", () => {
  assert.deepEqual(
    normalizeAcpSessionUpdate({
      turnId: "turn-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Warning: Model metadata for mia-auto not found.\nDefaulting to fallback metadata; this can degrade performance and cause issues.\n\n"
        }
      }
    }),
    []
  );
});

test("normalizeAcpSessionUpdate strips Codex Mia Auto metadata warnings from mixed assistant text", () => {
  assert.deepEqual(
    normalizeAcpSessionUpdate({
      turnId: "turn-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Warning: Model metadata for `mia-auto` not found.\nDefaulting to fallback metadata; this can degrade performance and cause issues.\n\n你好"
        }
      }
    }),
    [{
      kind: "assistant-delta",
      payload: {
        turnId: "turn-1",
        text: "你好"
      }
    }]
  );
});

test("normalizeAcpSessionUpdate suppresses arbitrary Codex model metadata warnings", () => {
  assert.deepEqual(
    normalizeAcpSessionUpdate({
      turnId: "turn-2",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Model metadata for gpt-5.6-terra should stay out of chat"
        }
      }
    }),
    [{
      kind: "assistant-delta",
      payload: {
        turnId: "turn-2",
        text: "Model metadata for gpt-5.6-terra should stay out of chat"
      }
    }]
  );
  assert.deepEqual(
    normalizeAcpSessionUpdate({
      turnId: "turn-3",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Warning: Model metadata for gpt-5.6-terra not found.\nDefaulting to fallback metadata; this can degrade performance and cause issues.\n\n"
        }
      }
    }),
    []
  );
  assert.deepEqual(
    normalizeAcpSessionUpdate({
      turnId: "turn-4",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Warning: Model metadata for `gpt-5.6-terra` not found.\nDefaulting to fallback metadata; this can degrade performance and cause issues.\n\n你好"
        }
      }
    }),
    [{
      kind: "assistant-delta",
      payload: {
        turnId: "turn-4",
        text: "你好"
      }
    }]
  );
});
