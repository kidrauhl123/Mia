const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  AcpAgentSession,
  createAcpAgentSession,
  createPermissionFallback
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
    createTransport: async () => state.transport,
    createClient: options.createClient || (async ({ onSessionUpdate, onPermissionRequest }) => ({
      async initialize(params) {
        state.initializeCalls.push(params);
        return { protocolVersion: 1 };
      },
      async newSession(params) {
        state.newSessionCalls.push(params);
        return { sessionId: "acp-session-1" };
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

test("start initializes the ACP session once", async () => {
  const { session, state } = createSession();
  const events = collectEvents(session);

  await session.start();
  await session.start();

  assert.equal(state.initializeCalls.length, 1);
  assert.equal(state.newSessionCalls.length, 1);
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

test("sendUserInput waits for prompt completion, omits visible history, and emits normalized streaming events", async () => {
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
    text: "hello ACP",
    visibleMessages: [
      { role: "user", content: "older message" },
      { role: "assistant", content: "older reply" }
    ]
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
