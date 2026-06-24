const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createCoreBotExecution } = require("../src/core/mia-core.js");

// Minimal runtimePaths/settingsStore shims: the proof never reads the on-disk
// manifest (every turn carries a cloud snapshot), so loadBotManifest is never
// reached. We still pass real factories so the adapter graph is fully real.
function makeRuntimePaths() {
  return () => ({ botManifest: "/dev/null/does-not-exist", botDir: "/dev/null" });
}

// The real Hermes chat adapter (src/main/hermes-chat-adapter.js sendChat) returns
// a chat.completion envelope; the fake mirrors that exact shape so the assertion
// matches what production would flow back through the same adapter graph.
function fakeHermesResponse(content) {
  return {
    id: "run_fake",
    object: "chat.completion",
    created: 1,
    model: "hermes-agent",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }
    ],
    mia: { transport: "runs", run_id: "run_fake", bot_id: "bot1", events: [] }
  };
}

test("Core builds the REAL adapter graph; a faked Hermes HTTP send flows back through it (node-only)", async () => {
  const seen = [];
  const core = createCoreBotExecution({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { daemonSettings: () => ({ enabled: false }) },
    hermesBaseUrl: "", // no engine → ensureHermesReady is a no-op
    apiKey: "test-key",
    // Lowest-level Hermes HTTP send is the ONLY thing faked. Everything from
    // resolveChatEngineAdapter → createChatEngineAdapters → sendWithChatEngineAdapter
    // → adapters.hermes.send → deps.sendHermesChat is the real graph.
    sendHermesChat: async (context) => {
      seen.push(context);
      return fakeHermesResponse("hi from core");
    }
  });

  const response = await core.sendChat({
    botKey: "bot1",
    botSnapshot: { key: "bot1", name: "Bot One", agentEngine: "hermes", capabilities: {} },
    sessionId: "s1",
    messages: [{ role: "user", content: "hi" }],
    background: true
  });

  // The canned response flowed back through the real adapter dispatch.
  assert.equal(response.choices[0].message.content, "hi from core");
  assert.equal(response.model, "hermes-agent");
  // The real adapter actually invoked our fake with a real adapter context.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].bot.key, "bot1");
  assert.equal(seen[0].bot.agentEngine, "hermes");
});

// PART B: a non-Hermes engine (codex) now routes through its REAL adapter — the
// legacy "engine not available in Mia Core yet" throw is GONE. We inject a
// CLI-absent localAgentEngineService so the REAL codex adapter hits its OWN
// distinctive "本机没有检测到 Codex CLI" guard (deterministic, no real spawn).
test("Core routes a codex turn through the REAL adapter (engineUnavailable throw is gone)", async () => {
  const core = createCoreBotExecution({
    runtimePaths: makeRuntimePaths(),
    settingsStore: { daemonSettings: () => ({ enabled: false }) },
    hermesBaseUrl: "",
    apiKey: "test-key",
    sendHermesChat: async () => fakeHermesResponse("unused"),
    localAgentEngineService: {
      shellCommandPath: () => "",
      processEnvWithCliPath: () => ({ PATH: "" }),
      agentRuntimeEnv: () => ({}),
      resolveAgentRuntime: () => null,
      localAgentEngines: () => ({})
    }
  });

  await assert.rejects(
    core.sendChat({
      botKey: "bot2",
      botSnapshot: { key: "bot2", name: "Bot Two", agentEngine: "codex", capabilities: {} },
      sessionId: "s2",
      messages: [{ role: "user", content: "hi" }],
      background: true
    }),
    (err) => {
      const message = String(err && err.message);
      return /没有检测到 Codex CLI/.test(message) && !/engine not available in Mia Core yet/.test(message);
    }
  );
});
