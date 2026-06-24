const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCoreBotExecution } = require("../src/core/mia-core.js");
const { createRuntimePaths } = require("../src/main/runtime-paths.js");

// PART B proof: a bot turn with agentEngine = codex / claude-code / openclaw
// routes through the REAL adapter Core constructs — the legacy
// "engine not available in Mia Core yet" throw is GONE.
//
// To be deterministic (and NOT spawn a real external agent on the test machine),
// we inject a fake localAgentEngineService whose shellCommandPath returns "" — so
// each engine's REAL adapter hits its OWN distinctive "本机没有检测到 <CLI>" guard.
// That guard lives INSIDE the real adapter (claude-code/codex/openclaw-chat-adapter),
// so reaching it proves Core constructed + invoked the real adapter, not the throw.
//
// A second positive test injects a FAKE claude CLI path + FAKE Claude Agent SDK
// and captures the SDK `query` call — proving the real Claude adapter ran its full
// launch path through to the SDK (constructed + invoked), all node-only.

const ENGINE_NOT_AVAILABLE = "engine not available in Mia Core yet";

function makeRuntimePaths(home) {
  return createRuntimePaths({
    app: { getPath: () => os.homedir() },
    MIA_GATEWAY_SERVICE_LABEL: "ai.mia.hermes.gateway",
    MIA_DAEMON_SERVICE_LABEL: "ai.mia.daemon",
    env: { MIA_HOME: home }
  }).runtimePaths;
}

const settingsStore = {
  daemonSettings: () => ({ enabled: false }),
  cloudSettings: () => ({ enabled: false, url: "", token: "" }),
  normalizeCloudUrl: (v) => String(v || ""),
  normalizeStoredEffortLevel: (v) => String(v || "").trim(),
  enginePermissionMode: () => "default",
  normalizeEffortLevel: (v) => String(v || "medium").trim() || "medium"
};

// A fake local-agent-engine service whose CLI lookup is empty (CLI absent) and
// whose env/runtime helpers are inert — pure node, no spawn.
function cliAbsentEngineService() {
  return {
    shellCommandPath: () => "",
    processEnvWithCliPath: () => ({ PATH: "" }),
    agentRuntimeEnv: () => ({}),
    resolveAgentRuntime: () => null,
    localAgentEngines: () => ({})
  };
}

const CLI_GUARDS = {
  codex: /没有检测到 Codex CLI/,
  "claude-code": /没有检测到 Claude Code CLI/,
  openclaw: /没有检测到 OpenClaw CLI/
};

for (const engine of ["codex", "claude-code", "openclaw"]) {
  test(`PART B: a ${engine} turn routes through the REAL adapter (engineUnavailable throw is GONE)`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `mia-core-engine-${engine}-`));
    try {
      const core = createCoreBotExecution({
        runtimePaths: makeRuntimePaths(home),
        settingsStore,
        hermesBaseUrl: "http://hermes.local",
        apiKey: "k",
        fetchImpl: () => Promise.reject(new Error("no network")),
        localAgentEngineService: cliAbsentEngineService()
      });

      let error = null;
      try {
        await core.sendChat({
          botKey: `bot-${engine}`,
          botSnapshot: { key: `bot-${engine}`, name: engine, agentEngine: engine },
          sessionId: "s1",
          messages: [{ role: "user", content: "hi" }]
        });
      } catch (e) {
        error = e;
      }

      assert.ok(error, `${engine}: expected the real adapter's CLI-absent error`);
      const message = String(error.message || "");
      // NOT the Core throw — the real adapter's own distinctive guard.
      assert.notEqual(message, ENGINE_NOT_AVAILABLE, `${engine} still hit the engineUnavailable throw`);
      assert.match(message, CLI_GUARDS[engine], `${engine}: expected the real adapter's CLI guard, got: ${message}`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test("PART B (positive): a claude-code turn reaches the REAL Claude Agent SDK query (node-only capture)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-claude-pos-"));
  try {
    // Fake `claude` CLI path so the adapter passes its CLI guard.
    const fakeCliPath = path.join(home, "claude");
    fs.writeFileSync(fakeCliPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const engineService = {
      shellCommandPath: (cmd) => (cmd === "claude" ? fakeCliPath : ""),
      processEnvWithCliPath: () => ({ PATH: path.dirname(fakeCliPath) }),
      agentRuntimeEnv: () => ({}),
      resolveAgentRuntime: () => null,
      localAgentEngines: () => ({})
    };

    let capturedQuery = null;
    // Fake Claude Agent SDK: `query` yields one assistant result frame and records
    // that the real adapter reached it with the fake CLI executable path.
    const fakeClaudeAgentSdk = async () => ({
      query(opts) {
        capturedQuery = opts;
        async function* gen() {
          yield { type: "assistant", message: { content: [{ type: "text", text: "done-via-sdk" }] } };
          yield { type: "result", subtype: "success", session_id: "sess-1" };
        }
        return gen();
      }
    });

    const core = createCoreBotExecution({
      runtimePaths: makeRuntimePaths(home),
      settingsStore,
      hermesBaseUrl: "http://hermes.local",
      apiKey: "k",
      fetchImpl: () => Promise.reject(new Error("no network")),
      localAgentEngineService: engineService,
      claudeAgentSdk: fakeClaudeAgentSdk
    });

    const result = await core.sendChat({
      botKey: "bot-claude",
      botSnapshot: { key: "bot-claude", name: "Claude Bot", agentEngine: "claude-code" },
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }]
    });

    // The real Claude adapter ran its full launch path and reached the SDK.
    assert.ok(capturedQuery, "expected the real Claude adapter to call the SDK query()");
    assert.equal(capturedQuery.options.pathToClaudeCodeExecutable, fakeCliPath, "adapter passed the PATH-resolved claude executable to the SDK");
    assert.ok(result && result.choices && result.choices[0].message.content.includes("done-via-sdk"), "expected the SDK result to flow back");

    // Close the user-MCP bridge the turn opened so the test process exits cleanly.
    await core.closeAgentEngines();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
