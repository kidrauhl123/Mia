const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  AcpAgentSession,
  createAcpAgentSession,
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
    initializationMetadata: options.initializationMetadata,
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

test("defaultCreateTransport uses the shared OpenClaw ACP launcher for shimmed commands", async () => {
  const tempDir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "acp-openclaw-"));
  try {
    const shimPath = require("node:path").join(tempDir, "openclaw.cmd");
    const scriptPath = require("node:path").join(tempDir, "node_modules", "openclaw", "openclaw.mjs");
    require("node:fs").mkdirSync(require("node:path").dirname(scriptPath), { recursive: true });
    require("node:fs").writeFileSync(scriptPath, "export default {};", "utf8");

    const spawnCalls = [];
    const child = createFakeTransport().process;
    child.stdin = new (require("node:stream").PassThrough)();
    child.stdout = new (require("node:stream").PassThrough)();
    child.kill = () => {};

    const transport = await defaultCreateTransport({
      engineSpec: {
        engineId: "openclaw",
        command: shimPath,
        args: ["acp", "--no-prefix-cwd"]
      },
      workspacePath: "/repo",
      env: { PATH: "/bin" },
      platform: "win32",
      nodePath: "/custom/node",
      spawnProcess: (file, args, options) => {
        spawnCalls.push({ file, args, options });
        return child;
      }
    });

    assert.deepEqual(spawnCalls[0], {
      file: "/custom/node",
      args: [scriptPath, "acp", "--no-prefix-cwd"],
      options: {
        cwd: "/repo",
        env: { ...process.env, PATH: "/bin" },
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true
      }
    });
    await transport.close();
    await transport.kill();
  } finally {
    require("node:fs").rmSync(tempDir, { recursive: true, force: true });
  }
});
