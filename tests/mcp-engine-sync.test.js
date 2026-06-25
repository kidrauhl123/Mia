const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  bridgeMcpSpec,
  mcpServersForOpenClawAcp,
  mcpSpecsForClaudeSdk,
  mcpSpecsForCodex,
  mcpSpecsForHermes,
  planClaudeCliRemove,
  planClaudeCliSync,
  planCodexCliRemove,
  planCodexCliSync,
  runNativeMcpCliSync
} = require("../src/main/mcp/mcp-engine-sync.js");

const records = [
  { name: "stdio", enabled: true, transport: { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { TOKEN: "abc" } } },
  { name: "xhs", enabled: true, transport: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: {}, bearerTokenEnvVar: "XHS_TOKEN" } },
  { name: "header-http", enabled: true, transport: { type: "http", url: "http://127.0.0.1:1999/mcp", headers: { Authorization: "Bearer abc" } } },
  {
    name: "header-bearer-http",
    enabled: true,
    transport: {
      type: "http",
      url: "http://127.0.0.1:2000/mcp",
      headers: { "X-Trace": "trace-value" },
      bearerTokenEnvVar: "HEADER_TOKEN"
    }
  }
];

test("mcpSpecsForClaudeSdk preserves stdio and URL transports", () => {
  assert.deepEqual(mcpSpecsForClaudeSdk(records).xhs, {
    type: "http",
    url: "http://127.0.0.1:18060/mcp",
    headers: {},
    bearer_token_env_var: "XHS_TOKEN"
  });
  assert.equal(mcpSpecsForClaudeSdk(records).stdio.command, "npx");
});

test("engine specs ignore soft-deleted records", () => {
  const softDeleteRecords = [
    { name: "active", enabled: true, transport: { type: "stdio", command: "npx", args: [] } },
    { name: "deleted", enabled: true, deletedAt: 171, transport: { type: "stdio", command: "node", args: [] } }
  ];
  const specs = mcpSpecsForClaudeSdk(softDeleteRecords);

  assert.deepEqual(Object.keys(specs), ["active"]);
});

test("mcpSpecsForCodex uses native URL for bearer-token HTTP and bridge for arbitrary headers", () => {
  const bridge = bridgeMcpSpec({ command: "/usr/local/bin/node", scriptPath: "/app/mcp-stdio-proxy-server.js", bridgeUrl: "http://127.0.0.1:3333", secret: "sec" });
  const specs = mcpSpecsForCodex(records, { bridge });

  assert.equal(specs.xhs.url, "http://127.0.0.1:18060/mcp");
  assert.equal(specs.xhs.bearer_token_env_var, "XHS_TOKEN");
  assert.equal(Object.hasOwn(specs, "header-bearer-http"), false);
  assert.equal(specs["mia-mcp-bridge"].command, "/usr/local/bin/node");
});

test("mcpSpecsForCodex reports bridge-required records when bridge is absent", () => {
  const statusCollector = [];
  const specs = mcpSpecsForCodex(records, { statusCollector });

  assert.equal(Object.hasOwn(specs, "header-http"), false);
  assert.equal(Object.hasOwn(specs, "header-bearer-http"), false);
  assert.deepEqual(statusCollector, [
    {
      engine: "codex",
      name: "header-http",
      transportType: "http",
      status: "unsupported",
      reason: "bridge_required_for_http_headers",
      bridgeRequired: true
    },
    {
      engine: "codex",
      name: "header-bearer-http",
      transportType: "http",
      status: "unsupported",
      reason: "bridge_required_for_http_headers",
      bridgeRequired: true
    }
  ]);
});

test("codex reports bridge-required status for http headers without bridge", () => {
  const statuses = [];
  const specs = mcpSpecsForCodex([
    { name: "remote", enabled: true, transport: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer token" } } }
  ], { statusCollector: statuses });

  assert.deepEqual(specs, {});
  assert.equal(statuses[0].reason, "bridge_required_for_http_headers");
});

test("mcpSpecsForHermes emits direct URL when supported and bridge when URL support is disabled", () => {
  const bridge = bridgeMcpSpec({ command: "/node", scriptPath: "/proxy.js", bridgeUrl: "http://127.0.0.1:1", secret: "sec" });

  assert.equal(mcpSpecsForHermes(records, { hermesSupportsUrl: true, bridge }).xhs.url, "http://127.0.0.1:18060/mcp");
  assert.deepEqual(Object.keys(mcpSpecsForHermes(records, { hermesSupportsUrl: false, bridge })), ["stdio", "mia-mcp-bridge"]);
});

test("mcpSpecsForHermes reports unsupported non-stdio records when bridge is absent", () => {
  const statusCollector = [];
  const specs = mcpSpecsForHermes(records, { hermesSupportsUrl: false, statusCollector });

  assert.deepEqual(Object.keys(specs), ["stdio"]);
  assert.deepEqual(statusCollector.map((entry) => [entry.name, entry.reason]), [
    ["xhs", "bridge_required_for_non_stdio_transport"],
    ["header-http", "bridge_required_for_non_stdio_transport"],
    ["header-bearer-http", "bridge_required_for_non_stdio_transport"]
  ]);
});

test("mcpServersForOpenClawAcp maps records into ACP wire shape", () => {
  const acp = mcpServersForOpenClawAcp(records, { supportsHttp: true, supportsSse: true, bridge: null });
  assert.deepEqual(acp[0], { name: "stdio", command: "npx", args: ["-y", "pkg"], env: [{ name: "TOKEN", value: "abc" }] });
  assert.deepEqual(acp[1], { type: "http", name: "xhs", url: "http://127.0.0.1:18060/mcp", headers: [] });
});

test("mcpServersForOpenClawAcp reports unsupported records when bridge is absent", () => {
  const statusCollector = [];
  const acp = mcpServersForOpenClawAcp(records, {
    supportsHttp: false,
    supportsSse: false,
    bridge: null,
    statusCollector
  });

  assert.deepEqual(acp, [
    { name: "stdio", command: "npx", args: ["-y", "pkg"], env: [{ name: "TOKEN", value: "abc" }] }
  ]);
  assert.deepEqual(statusCollector.map((entry) => [entry.engine, entry.name, entry.reason]), [
    ["openclaw", "xhs", "bridge_required_for_unsupported_transport"],
    ["openclaw", "header-http", "bridge_required_for_unsupported_transport"],
    ["openclaw", "header-bearer-http", "bridge_required_for_unsupported_transport"]
  ]);
});

test("native CLI planners generate safe command argument arrays", () => {
  assert.deepEqual(planCodexCliSync([records[1]])[0].args, ["mcp", "add", "xhs", "--url", "http://127.0.0.1:18060/mcp", "--bearer-token-env-var", "XHS_TOKEN"]);
  assert.equal(planClaudeCliSync([records[0]])[0].args[0], "mcp");
});

test("native CLI planners use nativeName instead of localized display name", () => {
  const localized = {
    ...records[1],
    name: "小红书 MCP",
    nativeName: "xhs-local-http"
  };

  assert.deepEqual(planCodexCliSync([localized])[0].args, [
    "mcp",
    "add",
    "xhs-local-http",
    "--url",
    "http://127.0.0.1:18060/mcp",
    "--bearer-token-env-var",
    "XHS_TOKEN"
  ]);
  assert.deepEqual(planClaudeCliSync([localized])[0].args, [
    "mcp",
    "add",
    "-s",
    "user",
    "--transport",
    "http",
    "xhs-local-http",
    "http://127.0.0.1:18060/mcp"
  ]);
});

test("native CLI planners generate safe removal command argument arrays", () => {
  assert.deepEqual(planCodexCliRemove([records[1]])[0].args, ["mcp", "remove", "xhs"]);
  assert.deepEqual(planClaudeCliRemove([records[0]])[0].args, ["mcp", "remove", "-s", "user", "stdio"]);
});

test("runNativeMcpCliSync removes disabled or deleted records before adding enabled records", async () => {
  const commands = [];
  const result = await runNativeMcpCliSync({
    previousRecords: records,
    currentRecords: [{ ...records[0], enabled: false }, records[1]],
    cliPaths: { codex: "/usr/local/bin/codex", claude: "/usr/local/bin/claude" },
    runCommand: async (command, args) => {
      commands.push([command, args]);
      return { ok: true, stdout: "", stderr: "" };
    }
  });

  assert.equal(result.success, true);
  assert.deepEqual(commands[0], ["/usr/local/bin/codex", ["mcp", "remove", "stdio"]]);
  assert.equal(commands.some((entry) => entry[1].includes("add")), true);
  assert.equal(result.statuses.codex.status, "synced");
  assert.equal(result.statuses["claude-code"].status, "synced");
});

test("runNativeMcpCliSync removes changed records before re-adding them", async () => {
  const commands = [];
  const result = await runNativeMcpCliSync({
    previousRecords: [records[1]],
    currentRecords: [{
      ...records[1],
      transport: { ...records[1].transport, bearerTokenEnvVar: "XHS_TOKEN_V2" }
    }],
    cliPaths: { codex: "/usr/local/bin/codex", claude: "/usr/local/bin/claude" },
    runCommand: async (command, args) => {
      commands.push([command, args]);
      return { ok: true, stdout: "", stderr: "" };
    }
  });

  assert.equal(result.success, true);
  assert.deepEqual(commands[0], ["/usr/local/bin/codex", ["mcp", "remove", "xhs"]]);
  assert.deepEqual(commands[1], ["/usr/local/bin/claude", ["mcp", "remove", "-s", "user", "xhs"]]);
  assert.equal(commands[2][1][1], "add");
});

test("runNativeMcpCliSync reports Codex unsupported arbitrary headers as an error without running broken add commands", async () => {
  const commands = [];
  const result = await runNativeMcpCliSync({
    previousRecords: [],
    currentRecords: [records[2]],
    cliPaths: { codex: "/usr/local/bin/codex", claude: "/usr/local/bin/claude" },
    runCommand: async (command, args) => {
      commands.push([command, args]);
      return { ok: true, stdout: "", stderr: "" };
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.statuses.codex.status, "error");
  assert.match(result.statuses.codex.error, /unsupported/i);
  assert.equal(commands.some(([command, args]) => command === "/usr/local/bin/codex" && args[1] === "add"), false);
  assert.equal(commands.some(([command, args]) => command === "/usr/local/bin/claude" && args[1] === "add"), true);
});

test("runNativeMcpCliSync treats bearer-plus-header HTTP records as unsupported for Codex native sync", async () => {
  const commands = [];
  const result = await runNativeMcpCliSync({
    previousRecords: [],
    currentRecords: [records[3]],
    cliPaths: { codex: "/usr/local/bin/codex", claude: "/usr/local/bin/claude" },
    runCommand: async (command, args) => {
      commands.push([command, args]);
      return { ok: true, stdout: "", stderr: "" };
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.statuses.codex.status, "error");
  assert.match(result.statuses.codex.error, /unsupported/i);
  assert.equal(commands.some(([command, args]) => command === "/usr/local/bin/codex" && args[1] === "add"), false);
  assert.equal(commands.some(([command, args]) => command === "/usr/local/bin/claude" && args[1] === "add"), true);
});
