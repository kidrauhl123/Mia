const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  clearNativeSkillIndexCache,
  normalizeSkillIndexMode,
  skillMaterializationForNativeSession
} = require("../src/main/native-skill-context.js");

const skillMaterialization = {
  indexBlock: "INDEX",
  loadedBlock: "LOADED"
};

test("skillMaterializationForNativeSession injects skill index once per native session", () => {
  clearNativeSkillIndexCache();
  const context = {
    engine: "hermes",
    botId: "alice",
    sessionId: "s1",
    nativeSessionId: "mia:alice:s1",
    persistAgentSession: true,
    skillMaterialization
  };

  assert.deepEqual(skillMaterializationForNativeSession(context), skillMaterialization);
  assert.deepEqual(skillMaterializationForNativeSession(context), {
    indexBlock: "",
    loadedBlock: "LOADED"
  });
});

test("skillMaterializationForNativeSession keeps legacy always mode and non-persistent turns", () => {
  clearNativeSkillIndexCache();

  assert.deepEqual(skillMaterializationForNativeSession({
    engine: "hermes",
    botId: "alice",
    sessionId: "s1",
    persistAgentSession: true,
    skillIndexMode: "always",
    skillMaterialization
  }), skillMaterialization);

  assert.deepEqual(skillMaterializationForNativeSession({
    engine: "hermes",
    botId: "alice",
    sessionId: "s1",
    persistAgentSession: false,
    skillMaterialization
  }), skillMaterialization);
});

test("skillMaterializationForNativeSession reinjects index after native session reset", () => {
  clearNativeSkillIndexCache();
  const context = {
    engine: "hermes",
    botId: "mei",
    sessionId: "s1",
    nativeSessionId: "mia:mei:s1",
    persistAgentSession: true,
    skillMaterialization
  };

  assert.deepEqual(skillMaterializationForNativeSession(context), skillMaterialization);
  assert.deepEqual(skillMaterializationForNativeSession(context), {
    indexBlock: "",
    loadedBlock: "LOADED"
  });
  assert.deepEqual(skillMaterializationForNativeSession({ ...context, resetNativeSession: true }), skillMaterialization);
});

test("skillMaterializationForNativeSession isolates bot ids and conversation sessions", () => {
  clearNativeSkillIndexCache();

  assert.deepEqual(skillMaterializationForNativeSession({
    engine: "hermes",
    botId: "alice",
    sessionId: "s1",
    nativeSessionId: "mia:alice:s1",
    persistAgentSession: true,
    skillMaterialization
  }), skillMaterialization);
  assert.deepEqual(skillMaterializationForNativeSession({
    engine: "hermes",
    botId: "alice",
    sessionId: "s2",
    nativeSessionId: "mia:alice:s2",
    persistAgentSession: true,
    skillMaterialization
  }), skillMaterialization);
  assert.deepEqual(skillMaterializationForNativeSession({
    engine: "hermes",
    botId: "bob",
    sessionId: "s1",
    nativeSessionId: "mia:bob:s1",
    persistAgentSession: true,
    skillMaterialization
  }), skillMaterialization);
});

test("skillMaterializationForNativeSession can disable index injection", () => {
  clearNativeSkillIndexCache();

  assert.deepEqual(skillMaterializationForNativeSession({
    engine: "hermes",
    botId: "mei",
    sessionId: "s1",
    persistAgentSession: true,
    skillIndexMode: "none",
    skillMaterialization
  }), {
    indexBlock: "",
    loadedBlock: "LOADED"
  });

  assert.equal(normalizeSkillIndexMode("every_turn"), "always");
  assert.equal(normalizeSkillIndexMode("disabled"), "none");
  assert.equal(normalizeSkillIndexMode(""), "once");
});
