const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  normalizeCoreMcpRecord,
  publicCoreMcpRecord,
  enabledCoreMcpRecords,
  coreMcpFingerprint,
  parseCoreMcpImportJson
} = require("../src/core/mcp/records.js");

test("normalizes AION-style fields and maps old status fields", () => {
  const record = normalizeCoreMcpRecord({
    id: "mcp_xhs",
    name: "xhs",
    displayName: "XHS",
    enabled: true,
    status: "connected",
    tools: [{ name: "search", inputSchema: { type: "object" } }],
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }
  }, { now: () => 1710000000000 });

  assert.equal(record.lastTestStatus, "connected");
  assert.equal(record.deletedAt, null);
  assert.equal(record.oauth.authenticated, false);
  assert.equal(record.sync.codex.status, "pending");
});

test("public record redacts env headers oauth token refs and original json", () => {
  const record = normalizeCoreMcpRecord({
    name: "github",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "pkg"],
      env: { GITHUB_TOKEN: "ghp_real_secret" }
    },
    oauth: { authenticated: true, tokenRef: "oauth_token_1" },
    originalJson: JSON.stringify({ headers: { Authorization: "Bearer secret" } })
  });

  const view = publicCoreMcpRecord(record);
  assert.equal(view.transport.env.GITHUB_TOKEN, "••••••••");
  assert.equal(view.oauth.tokenRef, "");
  assert.doesNotMatch(view.originalJson, /secret|ghp_real_secret/);
});

test("enabled records exclude disabled and soft-deleted records", () => {
  const active = normalizeCoreMcpRecord({ name: "active", transport: { type: "stdio", command: "npx" } });
  const disabled = normalizeCoreMcpRecord({ name: "disabled", enabled: false, transport: { type: "stdio", command: "npx" } });
  const deleted = normalizeCoreMcpRecord({ name: "deleted", deletedAt: 171, transport: { type: "stdio", command: "npx" } });

  assert.deepEqual(enabledCoreMcpRecords([active, disabled, deleted]).map((item) => item.name), ["active"]);
});

test("fingerprint changes when enabled transport changes and ignores deleted records", () => {
  const a = normalizeCoreMcpRecord({ name: "a", transport: { type: "stdio", command: "npx", args: ["one"] } });
  const b = normalizeCoreMcpRecord({ name: "a", transport: { type: "stdio", command: "npx", args: ["two"] } });
  const deleted = normalizeCoreMcpRecord({ name: "gone", deletedAt: 171, transport: { type: "stdio", command: "node" } });

  assert.notEqual(coreMcpFingerprint([a]), coreMcpFingerprint([b]));
  assert.equal(coreMcpFingerprint([a]), coreMcpFingerprint([a, deleted]));
});

test("import parser accepts mcpServers and streamable-http aliases", () => {
  const imported = parseCoreMcpImportJson({
    mcpServers: {
      remote: { type: "streamable-http", url: "https://example.com/mcp" }
    }
  });

  assert.equal(imported[0].name, "remote");
  assert.equal(imported[0].transport.type, "http");
});
