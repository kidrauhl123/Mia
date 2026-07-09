const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  createAgentSessionManager
} = require("../src/main/agent-session/agent-session-manager.js");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createFakeSession(overrides = {}) {
  const session = new EventEmitter();
  session.sendCalls = [];
  session.cancelCalls = 0;
  session.killCalls = 0;
  session.sendUserInput = async (input) => {
    session.sendCalls.push(input);
    return { ok: true };
  };
  session.cancel = async () => {
    session.cancelCalls += 1;
  };
  session.kill = async () => {
    session.killCalls += 1;
  };
  return Object.assign(session, overrides);
}

function managerOptions(createSession, engineSpecs = [{ engineId: "claude", supportsSteerInput: false }], extra = {}) {
  return {
    createSession,
    engineSpecs,
    ...extra
  };
}

test("getOrCreateSession builds one native session for concurrent calls on the same key", async () => {
  const build = createDeferred();
  const builds = [];
  const session = createFakeSession();
  const manager = createAgentSessionManager(managerOptions(async (descriptor) => {
    builds.push(descriptor);
    return build.promise;
  }));

  const descriptor = {
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo"
  };

  const first = manager.getOrCreateSession(descriptor);
  const second = manager.getOrCreateSession(descriptor);

  assert.equal(builds.length, 1);

  build.resolve(session);
  const [resolvedFirst, resolvedSecond] = await Promise.all([first, second]);

  assert.equal(resolvedFirst, session);
  assert.equal(resolvedSecond, session);
  assert.equal(builds.length, 1);
});

test("getOrCreateSession creates distinct native sessions for distinct session keys", async () => {
  const builds = [];
  const manager = createAgentSessionManager(managerOptions(async (descriptor) => {
    builds.push(descriptor);
    return createFakeSession();
  }));

  const first = await manager.getOrCreateSession({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo-a"
  });
  const second = await manager.getOrCreateSession({
    conversationId: "conversation-1",
    engineId: "codex",
    workspacePath: "/repo-a"
  });
  const third = await manager.getOrCreateSession({
    conversationId: "conversation-2",
    engineId: "claude",
    workspacePath: "/repo-a"
  });

  assert.notEqual(first, second);
  assert.notEqual(first, third);
  assert.notEqual(second, third);
  assert.equal(builds.length, 3);
});

test("closeAllSessions closes every tracked native session and clears manager state", async () => {
  const sessions = [];
  const manager = createAgentSessionManager(managerOptions(async () => {
    const session = createFakeSession();
    sessions.push(session);
    return session;
  }));

  await manager.getOrCreateSession({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo-a"
  });
  await manager.getOrCreateSession({
    conversationId: "conversation-1",
    engineId: "codex",
    workspacePath: "/repo-a"
  });

  await manager.closeAllSessions();

  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((session) => session.killCalls), [1, 1]);
  assert.equal(manager.sessionsByKey.size, 0);
  assert.equal(manager.runningByKey.size, 0);
  assert.equal(manager.queuesByKey.size, 0);
  assert.equal(manager.buildLocks.size, 0);
});

test("sendUserInput starts immediately when the session is idle", async () => {
  const session = createFakeSession();
  const manager = createAgentSessionManager(managerOptions(async () => session));

  const result = await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-1",
    text: "hello"
  });

  assert.deepEqual(result, {
    ok: true,
    mode: "started",
    conversationId: "conversation-1",
    engineId: "claude",
    turnId: "turn-1"
  });
  assert.deepEqual(session.sendCalls, [{ turnId: "turn-1", text: "hello" }]);
});

test("sendUserInput carries runtime env in the session descriptor without leaking it to the prompt payload", async () => {
  const builds = [];
  const sessions = [];
  const manager = createAgentSessionManager(managerOptions(async (descriptor) => {
    builds.push(descriptor);
    const session = createFakeSession();
    sessions.push(session);
    return session;
  }));

  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    runtimeKey: "mia:mia-auto",
    permissionMode: "bypassPermissions",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
      ANTHROPIC_AUTH_TOKEN: "proxy-token"
    },
    turnId: "turn-1",
    text: "hello"
  });
  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    runtimeKey: "native",
    turnId: "turn-2",
    text: "hello again"
  });

  assert.equal(builds.length, 2);
  assert.deepEqual(builds[0], {
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    runtimeKey: "mia:mia-auto",
    permissionMode: "bypassPermissions",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
      ANTHROPIC_AUTH_TOKEN: "proxy-token"
    },
    sessionKey: "conversation-1::claude::/repo::mia:mia-auto::bypassPermissions",
    engineSpec: { engineId: "claude", supportsSteerInput: false }
  });
  assert.deepEqual(sessions.map((session) => session.sendCalls), [
    [{ turnId: "turn-1", text: "hello" }],
    [{ turnId: "turn-2", text: "hello again" }]
  ]);
});

test("sendUserInput restores and persists native ACP session ids outside the prompt payload", async () => {
  const builds = [];
  const saves = [];
  const session = createFakeSession({
    sendUserInput: async (input) => {
      session.sendCalls.push(input);
      session.emit("session-started", { acpSessionId: "native-new" });
    }
  });
  const manager = createAgentSessionManager(managerOptions(
    async (descriptor) => {
      builds.push(descriptor);
      return session;
    },
    [{ engineId: "codex", supportsSteerInput: false }],
    {
      loadNativeSessionId: (descriptor) => {
        assert.equal(descriptor.botId, "codex-bot");
        assert.equal(descriptor.conversationId, "conversation-1");
        assert.equal(descriptor.engineId, "codex");
        assert.equal(descriptor.workspacePath, "/repo");
        return "native-existing";
      },
      saveNativeSessionId: (descriptor, nativeSessionId) => {
        saves.push({ descriptor, nativeSessionId });
      }
    }
  ));

  await manager.sendUserInput({
    conversationId: "conversation-1",
    botId: "codex-bot",
    engineId: "codex",
    workspacePath: "/repo",
    turnId: "turn-1",
    text: "continue"
  });

  assert.equal(builds.length, 1);
  assert.equal(builds[0].nativeSessionId, "native-existing");
  assert.equal(builds[0].botId, "codex-bot");
  assert.deepEqual(session.sendCalls, [{ turnId: "turn-1", text: "continue" }]);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].nativeSessionId, "native-new");
  assert.equal(saves[0].descriptor.botId, "codex-bot");
  assert.equal(saves[0].descriptor.conversationId, "conversation-1");
  assert.equal(saves[0].descriptor.engineId, "codex");
  assert.equal(saves[0].descriptor.workspacePath, "/repo");
});

test("sendUserInput carries MCP session config in the descriptor without leaking it to the prompt payload", async () => {
  const builds = [];
  const sends = [];
  const session = createFakeSession();
  session.sendUserInput = async (input) => {
    sends.push(input);
  };
  const refreshMcpContext = async () => {};
  const mcpServers = [{
    name: "mia-app",
    command: "/usr/bin/node",
    args: ["/tmp/mia-app.js"],
    env: [{ name: "MIA_CORE_URL", value: "http://127.0.0.1:27861" }]
  }];
  const manager = createAgentSessionManager(managerOptions(async (descriptor) => {
    builds.push(descriptor);
    return session;
  }));

  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "codex",
    workspacePath: "/repo",
    mcpFingerprint: "mcp-abc",
    mcpServers,
    refreshMcpContext,
    initialPromptPrefix: "## Mia Scoped Context",
    turnId: "turn-1",
    text: "hello"
  });

  assert.equal(builds.length, 1);
  assert.deepEqual(builds[0], {
    conversationId: "conversation-1",
    engineId: "codex",
    workspacePath: "/repo",
    mcpFingerprint: "mcp-abc",
    mcpServers,
    refreshMcpContext,
    initialPromptPrefix: "## Mia Scoped Context",
    sessionKey: "conversation-1::codex::/repo::mcp-abc",
    engineSpec: null
  });
  assert.deepEqual(sends, [{ turnId: "turn-1", text: "hello" }]);
});

test("sendUserInput returns accepted metadata after dispatching the native send without waiting for turn completion", async () => {
  const nativeSend = createDeferred();
  const session = createFakeSession({
    sendUserInput: (input) => {
      session.sendCalls.push(input);
      return nativeSend.promise;
    }
  });
  const manager = createAgentSessionManager(managerOptions(async () => session));

  const sendPromise = manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-1",
    text: "hello"
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.sendCalls.length, 1);
  assert.equal(session.sendCalls[0].turnId, "turn-1");
  assert.equal(session.sendCalls[0].text, "hello");

  const timeout = new Promise((_, reject) => {
    setImmediate(() => reject(new Error("sendUserInput did not resolve promptly")));
  });
  const result = await Promise.race([sendPromise, timeout]);

  assert.deepEqual(result, {
    ok: true,
    mode: "started",
    conversationId: "conversation-1",
    engineId: "claude",
    turnId: "turn-1"
  });

  nativeSend.resolve({ ok: true });
  await nativeSend.promise;
});

test("sendUserInput queues when the session is already running and steer support is not proven", async () => {
  const nativeSend = createDeferred();
  const session = createFakeSession({
    sendUserInput: (input) => {
      session.sendCalls.push(input);
      return nativeSend.promise;
    }
  });
  const manager = createAgentSessionManager(managerOptions(async () => session));
  const key = manager.createSessionKey({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo"
  });

  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-1",
    text: "first"
  });

  const result = await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-2",
    text: "second"
  });

  assert.deepEqual(result, {
    ok: true,
    mode: "queued",
    conversationId: "conversation-1",
    engineId: "claude",
    turnId: "turn-2",
    queueDepth: 1
  });
  assert.equal(session.sendCalls.length, 1);
  assert.deepEqual(manager.getQueueSnapshot(key), [{ turnId: "turn-2", text: "second" }]);

  nativeSend.resolve({ ok: true });
  await nativeSend.promise;
});

test("queued input drains after a terminal message event", async () => {
  const firstSend = createDeferred();
  const secondSend = createDeferred();
  const session = createFakeSession({
    sendUserInput: (input) => {
      session.sendCalls.push(input);
      return session.sendCalls.length === 1 ? firstSend.promise : secondSend.promise;
    }
  });
  const manager = createAgentSessionManager(managerOptions(async () => session));

  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-1",
    text: "first"
  });
  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-2",
    text: "second"
  });

  session.emit("message-completed", { messageId: "msg-1", turnId: "turn-1" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [
    { turnId: "turn-1", text: "first" },
    { turnId: "turn-2", text: "second" }
  ]);

  firstSend.resolve({ ok: true });
  secondSend.resolve({ ok: true });
  await Promise.all([firstSend.promise, secondSend.promise]);
});

test("duplicate terminal events without turnId do not clear the active turn or drain queued input", async () => {
  const firstSend = createDeferred();
  const secondSend = createDeferred();
  const session = createFakeSession({
    sendUserInput: (input) => {
      session.sendCalls.push(input);
      return session.sendCalls.length === 1 ? firstSend.promise : secondSend.promise;
    }
  });
  const manager = createAgentSessionManager(managerOptions(async () => session));
  const key = manager.createSessionKey({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo"
  });

  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-1",
    text: "first"
  });
  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-2",
    text: "second"
  });

  session.emit("message-completed", { messageId: "msg-1" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [{ turnId: "turn-1", text: "first" }]);
  assert.deepEqual(manager.getQueueSnapshot(key), [{ turnId: "turn-2", text: "second" }]);

  session.emit("message-completed", { messageId: "msg-1", turnId: "turn-1" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [
    { turnId: "turn-1", text: "first" },
    { turnId: "turn-2", text: "second" }
  ]);

  firstSend.resolve({ ok: true });
  secondSend.resolve({ ok: true });
  await Promise.all([firstSend.promise, secondSend.promise]);
});

test("queued input drains when the active native send settles even if terminal events lack usable turn correlation", async () => {
  const firstSend = createDeferred();
  const secondSend = createDeferred();
  const sends = [firstSend, secondSend];
  const session = createFakeSession({
    sendUserInput: (input) => {
      session.sendCalls.push(input);
      return sends.shift().promise;
    }
  });
  const manager = createAgentSessionManager(managerOptions(async () => session));
  const key = manager.createSessionKey({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo"
  });

  const firstResult = await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-1",
    text: "first"
  });
  const secondResult = await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-2",
    text: "second"
  });

  assert.equal(firstResult.mode, "started");
  assert.equal(secondResult.mode, "queued");
  session.emit("message-completed", { messageId: "msg-1" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [{ turnId: "turn-1", text: "first" }]);
  assert.deepEqual(manager.getQueueSnapshot(key), [{ turnId: "turn-2", text: "second" }]);

  firstSend.resolve({ ok: true });
  await firstSend.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [
    { turnId: "turn-1", text: "first" },
    { turnId: "turn-2", text: "second" }
  ]);
  assert.deepEqual(manager.getQueueSnapshot(key), []);

  secondSend.resolve({ ok: true });
  await secondSend.promise;
});

test("native send rejection is observed while clearing the active run and draining queued input", async () => {
  const firstSend = createDeferred();
  const secondSend = createDeferred();
  const sends = [firstSend, secondSend];
  const session = createFakeSession({
    sendUserInput: (input) => {
      session.sendCalls.push(input);
      return sends.shift().promise;
    }
  });
  const manager = createAgentSessionManager(managerOptions(async () => session));
  const key = manager.createSessionKey({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo"
  });
  const unhandled = [];
  const onUnhandledRejection = (error) => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    await manager.sendUserInput({
      conversationId: "conversation-1",
      engineId: "claude",
      workspacePath: "/repo",
      turnId: "turn-1",
      text: "first"
    });
    await manager.sendUserInput({
      conversationId: "conversation-1",
      engineId: "claude",
      workspacePath: "/repo",
      turnId: "turn-2",
      text: "second"
    });

    firstSend.reject(new Error("native send failed"));
    await assert.rejects(firstSend.promise, /native send failed/);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    assert.deepEqual(session.sendCalls, [
      { turnId: "turn-1", text: "first" },
      { turnId: "turn-2", text: "second" }
    ]);
    assert.equal(manager.runningByKey.has(key), true);
    assert.deepEqual(manager.getQueueSnapshot(key), []);

    secondSend.resolve({ ok: true });
    await secondSend.promise;
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

test("stale terminal events for a previous turn do not interrupt the next active turn", async () => {
  const firstSend = createDeferred();
  const secondSend = createDeferred();
  const thirdSend = createDeferred();
  const session = createFakeSession({
    sendUserInput: (input) => {
      session.sendCalls.push(input);
      return session.sendCalls.length === 1
        ? firstSend.promise
        : session.sendCalls.length === 2
          ? secondSend.promise
          : thirdSend.promise;
    }
  });
  const manager = createAgentSessionManager(managerOptions(async () => session));
  const key = manager.createSessionKey({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo"
  });

  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-1",
    text: "first"
  });
  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-2",
    text: "second"
  });
  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-3",
    text: "third"
  });

  session.emit("message-completed", { messageId: "msg-1", turnId: "turn-1" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [
    { turnId: "turn-1", text: "first" },
    { turnId: "turn-2", text: "second" }
  ]);
  assert.deepEqual(manager.getQueueSnapshot(key), [{ turnId: "turn-3", text: "third" }]);

  session.emit("message-completed", { messageId: "msg-1-duplicate", turnId: "turn-1" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [
    { turnId: "turn-1", text: "first" },
    { turnId: "turn-2", text: "second" }
  ]);
  assert.deepEqual(manager.getQueueSnapshot(key), [{ turnId: "turn-3", text: "third" }]);

  session.emit("message-completed", { messageId: "msg-2", turnId: "turn-2" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [
    { turnId: "turn-1", text: "first" },
    { turnId: "turn-2", text: "second" },
    { turnId: "turn-3", text: "third" }
  ]);

  firstSend.resolve({ ok: true });
  secondSend.resolve({ ok: true });
  thirdSend.resolve({ ok: true });
  await Promise.all([firstSend.promise, secondSend.promise, thirdSend.promise]);
});

test("duplicate or stale terminal events do not clear a later active run matched by message id", async () => {
  const firstSend = createDeferred();
  const secondSend = createDeferred();
  const thirdSend = createDeferred();
  const sends = [firstSend, secondSend, thirdSend];
  const session = createFakeSession({
    sendUserInput: (input) => {
      session.sendCalls.push(input);
      return sends.shift().promise;
    }
  });
  const manager = createAgentSessionManager(managerOptions(async () => session));
  const key = manager.createSessionKey({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo"
  });

  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-1",
    text: "first"
  });
  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-2",
    text: "second"
  });
  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-3",
    text: "third"
  });

  session.emit("message-started", { messageId: "msg-1", turnId: "turn-1" });
  firstSend.resolve({ ok: true });
  await firstSend.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [
    { turnId: "turn-1", text: "first" },
    { turnId: "turn-2", text: "second" }
  ]);
  assert.deepEqual(manager.getQueueSnapshot(key), [{ turnId: "turn-3", text: "third" }]);

  session.emit("message-started", { messageId: "msg-2", turnId: "turn-2" });
  session.emit("message-completed", { messageId: "msg-1" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [
    { turnId: "turn-1", text: "first" },
    { turnId: "turn-2", text: "second" }
  ]);
  assert.deepEqual(manager.getQueueSnapshot(key), [{ turnId: "turn-3", text: "third" }]);

  session.emit("message-completed", { messageId: "msg-2" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [
    { turnId: "turn-1", text: "first" },
    { turnId: "turn-2", text: "second" },
    { turnId: "turn-3", text: "third" }
  ]);

  session.emit("message-started", { messageId: "msg-3", turnId: "turn-3" });
  secondSend.resolve({ ok: true });
  await secondSend.promise;
  await new Promise((resolve) => setImmediate(resolve));

  session.emit("message-completed", { messageId: "msg-2", turnId: "turn-2" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [
    { turnId: "turn-1", text: "first" },
    { turnId: "turn-2", text: "second" },
    { turnId: "turn-3", text: "third" }
  ]);
  assert.equal(manager.getQueueSnapshot(key).length, 0);

  thirdSend.resolve({ ok: true });
  await thirdSend.promise;
});

test("cancelActive cancels the native session and preserves queued input for replay", async () => {
  const firstSend = createDeferred();
  const secondSend = createDeferred();
  const session = createFakeSession({
    sendUserInput: (input) => {
      session.sendCalls.push(input);
      return session.sendCalls.length === 1 ? firstSend.promise : secondSend.promise;
    }
  });
  const manager = createAgentSessionManager(managerOptions(async () => session));
  const key = manager.createSessionKey({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo"
  });

  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-1",
    text: "first"
  });
  await manager.sendUserInput({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo",
    turnId: "turn-2",
    text: "second"
  });

  await manager.cancelActive({
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo"
  });

  assert.equal(session.cancelCalls, 1);
  assert.deepEqual(manager.getQueueSnapshot(key), [{ turnId: "turn-2", text: "second" }]);

  session.emit("message-cancelled", { messageId: "msg-1", turnId: "turn-1" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [
    { turnId: "turn-1", text: "first" },
    { turnId: "turn-2", text: "second" }
  ]);

  firstSend.resolve({ ok: true });
  secondSend.resolve({ ok: true });
  await Promise.all([firstSend.promise, secondSend.promise]);
});

test("closeSession kills the native session and removes the cached session key", async () => {
  const session = createFakeSession();
  let builds = 0;
  const manager = createAgentSessionManager(managerOptions(async () => {
    builds += 1;
    return session;
  }));

  const descriptor = {
    conversationId: "conversation-1",
    engineId: "claude",
    workspacePath: "/repo"
  };

  const first = await manager.getOrCreateSession(descriptor);
  await manager.closeSession(descriptor);
  const second = await manager.getOrCreateSession(descriptor);

  assert.equal(first, session);
  assert.equal(session.killCalls, 1);
  assert.equal(builds, 2);
  assert.equal(second, session);
});

test("manager re-emits session events with normalized session metadata", async () => {
  const session = createFakeSession();
  const manager = createAgentSessionManager(managerOptions(async () => session));
  const received = [];

  manager.on("message-failed", (event) => received.push(event));

  await manager.getOrCreateSession({
    conversationId: "conversation-9",
    engineId: "claude",
    workspacePath: "/repo"
  });

  session.emit("message-failed", { error: "boom" });

  assert.deepEqual(received, [{
    conversationId: "conversation-9",
    engineId: "claude",
    workspacePath: "/repo",
    sessionKey: "conversation-9::claude::/repo",
    error: "boom"
  }]);
});
