const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createAgentCommandProvider } = require("../src/main/agent-command-provider.js");

function provider(overrides = {}) {
  return createAgentCommandProvider({
    homeDir: () => "/home/alice",
    cwd: () => "/repo",
    normalizeFellowAgentEngine: (engine) => engine,
    shellCommandPath: (name) => name === "claude" ? "/bin/claude" : name === "codex" ? "/bin/codex" : "",
    claudeAgentSdk: async () => ({
      query: () => ({
        supportedCommands: async () => [
          { name: "goal", description: "Set a goal", argumentHint: "<condition>" },
          { name: "context", description: "Show context usage" }
        ],
        interrupt: () => {}
      })
    }),
    ...overrides
  });
}

test("claude command list includes native supported commands", async () => {
  const result = await provider().loadExternalAgentCommands({ engine: "claude-code", projectPath: "/repo" });

  assert.equal(result.rows.find((row) => row.command === "/goal")?.source, "native");
  assert.equal(result.rows.find((row) => row.command === "/goal")?.argumentHint, "<condition>");
  assert.equal(result.rows.find((row) => row.command === "/resume")?.source, "mia");
});

test("codex command list exposes curated native goal command", async () => {
  const result = await provider().loadExternalAgentCommands({ engine: "codex", projectPath: "/repo" });

  assert.equal(result.rows.find((row) => row.command === "/goal")?.source, "native-curated");
  assert.equal(result.rows.find((row) => row.command === "/resume")?.source, "mia");
});

