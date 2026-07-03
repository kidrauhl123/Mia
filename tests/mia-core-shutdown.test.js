const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCoreBotExecution } = require("../src/core/mia-core.js");

test("closeAgentEngines awaits AgentSession shutdown", async () => {
  const calls = { closeAllSessions: 0 };
  let markCloseStarted = () => {};
  const closeStarted = new Promise((resolveStarted) => { markCloseStarted = resolveStarted; });
  let releaseCloseAllSessions = () => {};
  const closeAllSessionsDone = new Promise((resolveDone) => {
    releaseCloseAllSessions = resolveDone;
  });
  const agentSessionManager = {
    closeAllSessions: async () => {
      calls.closeAllSessions += 1;
      markCloseStarted();
      await closeAllSessionsDone;
    }
  };
  const core = createCoreBotExecution({
    runtimePaths: () => ({ home: "/tmp/x", hermesHome: "/tmp/x/.hermes", workspace: "/tmp/x/ws" }),
    settingsStore: { cloudSettings: () => ({ enabled: false }), enginePermissionMode: () => "ask" },
    hermesBaseUrl: "http://127.0.0.1:1",
    apiKey: "k",
    sendHermesChat: async () => ({ choices: [{ message: { content: "" } }] }),
    agentSessionManager
  });
  assert.equal(typeof core.closeAgentEngines, "function");
  let resolved = false;
  const closePromise = core.closeAgentEngines().then(() => { resolved = true; });
  await closeStarted;
  assert.equal(calls.closeAllSessions, 1, "AgentSession manager shutdown started");
  assert.equal(resolved, false, "closeAgentEngines must await AgentSession shutdown");
  releaseCloseAllSessions();
  await closePromise;
  assert.equal(resolved, true, "closeAgentEngines resolves after AgentSession shutdown");
});
