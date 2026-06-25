const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  enabledMcpRecords,
  maskMcpRecord,
  mcpFingerprint,
  normalizeMcpRecord,
  normalizeMcpRegistry,
  parseMcpImportJson
} = require("../src/main/mcp/mcp-records.js");

test("normalizeMcpRecord stores stable MCP fields and defaults sync state", () => {
  const record = normalizeMcpRecord({
    name: " 小红书 ",
    description: "XHS",
    enabled: true,
    transport: {
      type: "http",
      url: " http://127.0.0.1:18060/mcp ",
      headers: { Authorization: "Bearer secret" },
      bearerTokenEnvVar: "XHS_TOKEN"
    }
  }, { now: () => 1710000000000, idFactory: () => "mcp_fixed" });

  assert.equal(record.id, "mcp_fixed");
  assert.equal(record.name, "小红书");
  assert.equal(record.transport.type, "http");
  assert.equal(record.transport.url, "http://127.0.0.1:18060/mcp");
  assert.equal(record.sync.codex.status, "pending");
  assert.equal(record.status, "unknown");
});

test("normalizeMcpRecord derives a safe nativeName from marketplace registry id", () => {
  const record = normalizeMcpRecord({
    name: "小红书 MCP",
    registryId: "xiaohongshu",
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }
  }, { now: () => 1, idFactory: () => "mcp_xhs" });

  assert.equal(record.name, "小红书 MCP");
  assert.equal(record.nativeName, "xiaohongshu");
});

test("normalizeMcpRecord resets legacy invalid-name sync errors after nativeName migration", () => {
  const record = normalizeMcpRecord({
    name: "小红书 MCP",
    registryId: "xiaohongshu",
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
    sync: {
      codex: {
        status: "error",
        message: "Error: invalid server name '小红书 MCP' (use letters, numbers, '-', '_')"
      },
      "claude-code": {
        status: "error",
        message: "Invalid name 小红书 MCP. Names can only contain letters, numbers, hyphens, and underscores."
      }
    }
  }, { now: () => 1, idFactory: () => "mcp_xhs" });

  assert.equal(record.nativeName, "xiaohongshu");
  assert.equal(record.sync.codex.status, "available");
  assert.equal(record.sync["claude-code"].status, "available");
});

test("normalizeMcpRegistry keeps valid records and drops impossible records", () => {
  const records = normalizeMcpRegistry([
    { name: "stdio-one", transport: { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { A: "1" } } },
    { name: "bad-http", transport: { type: "http", url: "" } },
    { name: "sse-one", enabled: false, transport: { type: "sse", url: "https://example.test/sse" } }
  ], { now: () => 1, idFactory: (name) => `mcp_${name}` });

  assert.deepEqual(records.map((record) => record.name), ["stdio-one", "sse-one"]);
  assert.equal(records[0].transport.command, "npx");
  assert.equal(records[1].enabled, false);
});

test("parseMcpImportJson accepts Claude Cursor Codex and generic mcpServers JSON", () => {
  const imported = parseMcpImportJson({
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], env: { TOKEN: "abc" } },
      xhs: { type: "http", url: "http://127.0.0.1:18060/mcp", headers: { Authorization: "Bearer abc" } },
      remote: { type: "streamable_http", url: "https://example.test/mcp" }
    }
  });

  assert.deepEqual(imported.map((item) => item.name), ["filesystem", "xhs", "remote"]);
  assert.equal(imported[0].transport.type, "stdio");
  assert.equal(imported[1].transport.type, "http");
  assert.equal(imported[2].transport.type, "http");
});

test("maskMcpRecord hides secrets without destroying non-secret fields", () => {
  const record = normalizeMcpRecord({
    name: "github",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret", SAFE_FLAG: "1" }
    }
  }, { now: () => 1, idFactory: () => "mcp_github" });

  const masked = maskMcpRecord(record);
  assert.equal(masked.transport.env.GITHUB_PERSONAL_ACCESS_TOKEN, "••••••••");
  assert.equal(masked.transport.env.SAFE_FLAG, "1");
  assert.equal(masked.transport.command, "npx");
});

test("maskMcpRecord also masks secrets preserved in originalJson", () => {
  const originalBlob = JSON.stringify({
    mcpServers: {
      github: {
        type: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer ghp_secret" },
        env: { GITHUB_TOKEN: "ghp_secret" }
      }
    }
  });
  const record = normalizeMcpRecord({
    name: "github",
    originalJson: originalBlob,
    transport: {
      type: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer ghp_secret" }
    }
  }, { now: () => 1, idFactory: () => "mcp_github" });

  const masked = maskMcpRecord(record);
  const parsed = JSON.parse(masked.originalJson);

  assert.ok(!masked.originalJson.includes("ghp_secret"));
  assert.equal(parsed.mcpServers.github.headers.Authorization, "••••••••");
  assert.equal(parsed.mcpServers.github.env.GITHUB_TOKEN, "••••••••");
});

test("maskMcpRecord deeply redacts diagnostic secrets", () => {
  const masked = maskMcpRecord(normalizeMcpRecord({
    name: "github",
    transport: { type: "http", url: "https://example.test/mcp" },
    diagnostics: {
      headers: {
        Authorization: "Bearer ghp_secret",
        Cookie: "session=secret"
      },
      nested: {
        accessToken: "access-secret",
        refreshToken: "refresh-secret"
      }
    }
  }, { now: () => 1, idFactory: () => "mcp_diag" }));

  const serialized = JSON.stringify(masked.diagnostics);
  assert.equal(masked.diagnostics.headers.Authorization, "••••••••");
  assert.equal(masked.diagnostics.headers.Cookie, "••••••••");
  assert.equal(masked.diagnostics.nested.accessToken, "••••••••");
  assert.equal(masked.diagnostics.nested.refreshToken, "••••••••");
  assert.doesNotMatch(serialized, /ghp_secret|access-secret|refresh-secret|session=secret/);
});

test("mcpFingerprint changes when enabled transport config changes", () => {
  const first = normalizeMcpRegistry([
    { name: "a", enabled: true, transport: { type: "http", url: "http://127.0.0.1:1/mcp" } },
    { name: "b", enabled: false, transport: { type: "stdio", command: "npx", args: ["pkg"] } },
    { name: "gone", enabled: true, deletedAt: 171, transport: { type: "stdio", command: "node", args: ["server.js"] } }
  ], { now: () => 1, idFactory: (name) => `mcp_${name}` });
  const second = normalizeMcpRegistry([
    { name: "a", enabled: true, transport: { type: "http", url: "http://127.0.0.1:2/mcp" } },
    { name: "b", enabled: false, transport: { type: "stdio", command: "npx", args: ["pkg"] } }
  ], { now: () => 1, idFactory: (name) => `mcp_${name}` });

  assert.notEqual(mcpFingerprint(first), mcpFingerprint(second));
  assert.deepEqual(enabledMcpRecords(first).map((record) => record.name), ["a"]);
  assert.equal(mcpFingerprint(first), mcpFingerprint([first[0], first[2]]));
});

test("normalizeMcpRecord rejects reserved builtin names for user records", () => {
  assert.equal(normalizeMcpRecord({
    name: "mia-app",
    transport: { type: "stdio", command: "node" }
  }), null);
  assert.equal(normalizeMcpRecord({
    name: "mia-scheduler",
    transport: { type: "stdio", command: "node" }
  }), null);
});
