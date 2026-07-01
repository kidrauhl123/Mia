const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  clearNativeMemoryCache,
  memoryBlockForNativeSession,
  normalizeMemoryInjectionMode
} = require("../src/main/native-memory-context.js");

test("memoryBlockForNativeSession injects memory once until the block changes", () => {
  clearNativeMemoryCache();
  const context = {
    engine: "hermes",
    botId: "alice",
    sessionId: "s1",
    nativeSessionId: "mia:alice:s1",
    persistAgentSession: true
  };

  assert.equal(memoryBlockForNativeSession({ ...context, memoryBlock: "MEMORY v1" }), "MEMORY v1");
  assert.equal(memoryBlockForNativeSession({ ...context, memoryBlock: "MEMORY v1" }), "");
  assert.equal(memoryBlockForNativeSession({ ...context, memoryBlock: "MEMORY v2" }), "MEMORY v2");
});

test("memoryBlockForNativeSession keeps legacy always mode and non-persistent turns", () => {
  clearNativeMemoryCache();

  assert.equal(memoryBlockForNativeSession({
    engine: "hermes",
    botId: "alice",
    sessionId: "s1",
    persistAgentSession: true,
    memoryInjectionMode: "always",
    memoryBlock: "MEMORY"
  }), "MEMORY");

  assert.equal(memoryBlockForNativeSession({
    engine: "hermes",
    botId: "alice",
    sessionId: "s1",
    persistAgentSession: false,
    memoryBlock: "MEMORY"
  }), "MEMORY");
});

test("memoryBlockForNativeSession reinjects after native session reset", () => {
  clearNativeMemoryCache();
  const context = {
    engine: "openclaw",
    botId: "claw",
    sessionId: "s1",
    nativeSessionId: "openclaw:mia:claw:s1",
    persistAgentSession: true,
    memoryBlock: "MEMORY"
  };

  assert.equal(memoryBlockForNativeSession(context), "MEMORY");
  assert.equal(memoryBlockForNativeSession(context), "");
  assert.equal(memoryBlockForNativeSession({ ...context, resetNativeSession: true }), "MEMORY");
});

test("memoryBlockForNativeSession isolates bot ids and conversation sessions", () => {
  clearNativeMemoryCache();

  assert.equal(memoryBlockForNativeSession({
    engine: "hermes",
    botId: "alice",
    sessionId: "s1",
    nativeSessionId: "mia:alice:s1",
    persistAgentSession: true,
    memoryBlock: "MEMORY"
  }), "MEMORY");
  assert.equal(memoryBlockForNativeSession({
    engine: "hermes",
    botId: "alice",
    sessionId: "s2",
    nativeSessionId: "mia:alice:s2",
    persistAgentSession: true,
    memoryBlock: "MEMORY"
  }), "MEMORY");
  assert.equal(memoryBlockForNativeSession({
    engine: "hermes",
    botId: "bob",
    sessionId: "s1",
    nativeSessionId: "mia:bob:s1",
    persistAgentSession: true,
    memoryBlock: "MEMORY"
  }), "MEMORY");
});

test("memoryBlockForNativeSession can disable memory prompt injection", () => {
  clearNativeMemoryCache();

  assert.equal(memoryBlockForNativeSession({
    engine: "openclaw",
    botId: "claw",
    sessionId: "s1",
    persistAgentSession: true,
    memoryInjectionMode: "none",
    memoryBlock: "MEMORY"
  }), "");

  assert.equal(normalizeMemoryInjectionMode("every_turn"), "always");
  assert.equal(normalizeMemoryInjectionMode("disabled"), "none");
  assert.equal(normalizeMemoryInjectionMode(""), "changed");
});
