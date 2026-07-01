const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  clearNativePersonaCache,
  normalizePersonaInjectionMode,
  personaBlockForNativeSession
} = require("../src/main/native-persona-context.js");

test("personaBlockForNativeSession injects persona once until the block changes", () => {
  clearNativePersonaCache();
  const context = {
    engine: "openclaw",
    botId: "alice",
    sessionId: "s1",
    nativeSessionId: "openclaw:mia:alice:s1",
    persistAgentSession: true
  };

  assert.equal(personaBlockForNativeSession({ ...context, personaBlock: "PERSONA v1" }), "PERSONA v1");
  assert.equal(personaBlockForNativeSession({ ...context, personaBlock: "PERSONA v1" }), "");
  assert.equal(personaBlockForNativeSession({ ...context, personaBlock: "PERSONA v2" }), "PERSONA v2");
});

test("personaBlockForNativeSession keeps legacy always mode and non-persistent turns", () => {
  clearNativePersonaCache();

  assert.equal(personaBlockForNativeSession({
    engine: "openclaw",
    botId: "alice",
    sessionId: "s1",
    persistAgentSession: true,
    personaInjectionMode: "always",
    personaBlock: "PERSONA"
  }), "PERSONA");

  assert.equal(personaBlockForNativeSession({
    engine: "openclaw",
    botId: "alice",
    sessionId: "s1",
    persistAgentSession: false,
    personaBlock: "PERSONA"
  }), "PERSONA");
});

test("personaBlockForNativeSession reinjects after native session reset", () => {
  clearNativePersonaCache();
  const context = {
    engine: "openclaw",
    botId: "claw",
    sessionId: "s1",
    nativeSessionId: "openclaw:mia:claw:s1",
    persistAgentSession: true,
    personaBlock: "PERSONA"
  };

  assert.equal(personaBlockForNativeSession(context), "PERSONA");
  assert.equal(personaBlockForNativeSession(context), "");
  assert.equal(personaBlockForNativeSession({ ...context, resetNativeSession: true }), "PERSONA");
});

test("personaBlockForNativeSession isolates bot ids and conversation sessions", () => {
  clearNativePersonaCache();

  assert.equal(personaBlockForNativeSession({
    engine: "openclaw",
    botId: "alice",
    sessionId: "s1",
    nativeSessionId: "openclaw:mia:alice:s1",
    persistAgentSession: true,
    personaBlock: "PERSONA"
  }), "PERSONA");
  assert.equal(personaBlockForNativeSession({
    engine: "openclaw",
    botId: "alice",
    sessionId: "s2",
    nativeSessionId: "openclaw:mia:alice:s2",
    persistAgentSession: true,
    personaBlock: "PERSONA"
  }), "PERSONA");
  assert.equal(personaBlockForNativeSession({
    engine: "openclaw",
    botId: "bob",
    sessionId: "s1",
    nativeSessionId: "openclaw:mia:bob:s1",
    persistAgentSession: true,
    personaBlock: "PERSONA"
  }), "PERSONA");
});

test("personaBlockForNativeSession can disable persona prompt injection", () => {
  clearNativePersonaCache();

  assert.equal(personaBlockForNativeSession({
    engine: "openclaw",
    botId: "claw",
    sessionId: "s1",
    persistAgentSession: true,
    personaInjectionMode: "none",
    personaBlock: "PERSONA"
  }), "");

  assert.equal(normalizePersonaInjectionMode("every_turn"), "always");
  assert.equal(normalizePersonaInjectionMode("disabled"), "none");
  assert.equal(normalizePersonaInjectionMode(""), "changed");
});
