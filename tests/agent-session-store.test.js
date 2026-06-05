const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createAgentSessionStore } = require("../src/main/agent-session-store.js");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-agent-session-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = {
    agentSessions: path.join(dir, "home", "mia-agent-sessions.json")
  };
  const service = createAgentSessionStore({
    runtimePaths: () => runtime,
    readJson,
    normalizeBotAgentEngine: (engine) => `engine:${String(engine || "").trim() || "hermes"}`
  });
  return { runtime, service };
}

test("sessionKey normalizes engine, bot, and local session defaults", (t) => {
  const { service } = setup(t);

  assert.equal(service.sessionKey(" codex ", " alice ", " local_1 "), "engine:codex:alice:local_1");
  assert.equal(service.sessionKey("", "", ""), "engine:hermes:mia:default");
});

test("loadMap falls back to an empty object and saveMap persists with private permissions", (t) => {
  const { runtime, service } = setup(t);
  fs.mkdirSync(path.dirname(runtime.agentSessions), { recursive: true });
  fs.writeFileSync(runtime.agentSessions, "{bad json");

  assert.deepEqual(service.loadMap(), {});

  service.saveMap({ "engine:codex:alice:local": "thread_1" });
  assert.deepEqual(readJson(runtime.agentSessions, {}), { "engine:codex:alice:local": "thread_1" });
  assert.equal(fs.statSync(runtime.agentSessions).mode & 0o777, 0o600);
});

test("getEntry reads missing, legacy string, and fingerprint object entries", (t) => {
  const { service } = setup(t);
  service.saveMap({
    "engine:codex:alice:local_1": " thread_1 ",
    "engine:claude-code:alice:local_2": { id: " thread_2 ", fingerprint: " fp_1 " }
  });

  assert.deepEqual(service.getEntry("codex", "alice", "missing"), { id: "", fingerprint: "" });
  assert.deepEqual(service.getEntry("codex", "alice", "local_1"), { id: "thread_1", fingerprint: "" });
  assert.deepEqual(service.getEntry("claude-code", "alice", "local_2"), { id: "thread_2", fingerprint: "fp_1" });
  assert.equal(service.getId("codex", "alice", "local_1"), "thread_1");
});

test("setId and setEntry update the store and ignore empty external ids", (t) => {
  const { service } = setup(t);

  service.setId("codex", "alice", "local_1", " thread_1 ");
  service.setEntry("claude-code", "alice", "local_2", " thread_2 ", " fp_1 ");
  service.setEntry("codex", "alice", "empty", "   ", "fp_ignored");

  assert.deepEqual(service.loadMap(), {
    "engine:codex:alice:local_1": "thread_1",
    "engine:claude-code:alice:local_2": { id: "thread_2", fingerprint: "fp_1" }
  });
});

test("deleteEntry removes a stored session and reports whether it existed", (t) => {
  const { service } = setup(t);
  service.saveMap({
    "engine:codex:alice:local_1": "thread_1",
    "engine:claude-code:alice:local_2": { id: "thread_2", fingerprint: "fp_1" }
  });

  assert.equal(service.deleteEntry("codex", "alice", "local_1"), true);
  assert.equal(service.deleteEntry("codex", "alice", "missing"), false);
  assert.deepEqual(service.loadMap(), {
    "engine:claude-code:alice:local_2": { id: "thread_2", fingerprint: "fp_1" }
  });
});
