const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createExternalAgentCommandCoreAdapter
} = require("../src/main/external-agent-command-core-adapter.js");

test("external Agent command Core adapter maps list and execute calls to typed Core routes", async () => {
  const calls = [];
  const adapter = createExternalAgentCommandCoreAdapter({
    coreRequest: async (request) => {
      calls.push(request);
      if (request.route === "/api/agents/commands/list") return { rows: [{ command: "/resume" }] };
      if (request.route === "/api/agents/commands/execute") return { type: "builtin", command: "/resume", content: "ok" };
      throw new Error(`unexpected route ${request.route}`);
    },
    projectPath: () => "/repo",
    sourceDeviceId: () => "device_1"
  });

  assert.deepEqual(await adapter.loadCommands({ engine: "codex" }), { rows: [{ command: "/resume" }] });
  assert.deepEqual(await adapter.executeCommand({
    engine: "codex",
    commandName: "/resume",
    args: ["s1"],
    context: { sessionId: "local_1" }
  }), { type: "builtin", command: "/resume", content: "ok" });
  assert.deepEqual(await adapter.runSlashCommand({
    engine: "claude-code",
    text: "/status",
    bot: { key: "alice" },
    sessionId: "local_2"
  }), { type: "builtin", command: "/resume", content: "ok" });

  assert.deepEqual(calls, [
    {
      method: "POST",
      route: "/api/agents/commands/list",
      body: { engine: "codex", projectPath: "/repo" }
    },
    {
      method: "POST",
      route: "/api/agents/commands/execute",
      body: {
        engine: "codex",
        commandName: "/resume",
        args: ["s1"],
        projectPath: "/repo",
        context: { sessionId: "local_1", projectPath: "/repo", sourceDeviceId: "device_1" }
      }
    },
    {
      method: "POST",
      route: "/api/agents/commands/execute",
      body: {
        engine: "claude-code",
        text: "/status",
        projectPath: "/repo",
        context: {
          bot: { key: "alice" },
          sessionId: "local_2",
          projectPath: "/repo",
          sourceDeviceId: "device_1"
        }
      }
    }
  ]);
});
