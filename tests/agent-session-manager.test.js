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

function managerOptions(createSession, engineSpecs = [{ engineId: "claude", supportsSteerInput: false }]) {
  return {
    createSession,
    engineSpecs
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

test("sendUserInput queues when the session is already running and steer support is not proven", async () => {
  const session = createFakeSession();
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
});

test("queued input drains after a terminal message event", async () => {
  const session = createFakeSession();
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

  session.emit("message-completed", { messageId: "msg-1" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [
    { turnId: "turn-1", text: "first" },
    { turnId: "turn-2", text: "second" }
  ]);
});

test("cancelActive cancels the native session and preserves queued input for replay", async () => {
  const session = createFakeSession();
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

  session.emit("message-cancelled", { messageId: "msg-1" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.sendCalls, [
    { turnId: "turn-1", text: "first" },
    { turnId: "turn-2", text: "second" }
  ]);
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
