const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCoreBotExecution } = require("../src/core/mia-core.js");

// Codex NO-SHIP fix: managed-model turns open Claude/Codex proxy loopback HTTP
// servers (createSession); closeAgentEngines() must close them and stop() must
// AWAIT it, or leaked handles block a clean daemon exit.
function spyProxy() {
  const calls = { stop: 0 };
  return { proxy: { createSession: async () => ({ host: "127.0.0.1", port: 1 }), stop: async () => { calls.stop += 1; } }, calls };
}

test("closeAgentEngines awaits + stops the Claude/Codex managed-model proxies", async () => {
  const claude = spyProxy();
  const codex = spyProxy();
  const core = createCoreBotExecution({
    runtimePaths: () => ({ home: "/tmp/x", hermesHome: "/tmp/x/.hermes", workspace: "/tmp/x/ws" }),
    settingsStore: { cloudSettings: () => ({ enabled: false }), enginePermissionMode: () => "ask" },
    hermesBaseUrl: "http://127.0.0.1:1",
    apiKey: "k",
    sendHermesChat: async () => ({ choices: [{ message: { content: "" } }] }),
    claudeCodeMiaProxy: claude.proxy,
    codexMiaProxy: codex.proxy
  });
  assert.equal(typeof core.closeAgentEngines, "function");
  await core.closeAgentEngines();           // must resolve (awaitable)
  assert.equal(claude.calls.stop, 1, "claude proxy stopped");
  assert.equal(codex.calls.stop, 1, "codex proxy stopped");
});
