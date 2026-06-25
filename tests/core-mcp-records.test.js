const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  normalizeCoreMcpRecord,
  publicCoreMcpRecord,
  enabledCoreMcpRecords,
  coreMcpFingerprint,
  isCoreMcpExposureReady,
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

test("normalizes lastTestCode numeric legacy values and string diagnostics", () => {
  const numeric = normalizeCoreMcpRecord({
    name: "numeric",
    lastTestCode: "401",
    transport: { type: "http", url: "https://example.test/mcp" }
  });
  const stringCode = normalizeCoreMcpRecord({
    name: "string",
    lastTestCode: "auth_required",
    transport: { type: "http", url: "https://example.test/mcp" }
  });

  assert.equal(numeric.lastTestCode, 401);
  assert.equal(stringCode.lastTestCode, "auth_required");
  assert.equal(publicCoreMcpRecord(stringCode).lastTestCode, "auth_required");
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

test("public record deeply redacts diagnostic secrets beyond message fields", () => {
  const record = normalizeCoreMcpRecord({
    name: "diag",
    transport: { type: "http", url: "https://example.test/mcp" },
    diagnostics: {
      message: "Authorization: Bearer super-secret",
      headers: {
        Authorization: "Bearer super-secret",
        Cookie: "session=abc123"
      },
      nested: {
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        apiKey: "api-secret",
        note: "Bearer nested-secret"
      }
    }
  });

  const view = publicCoreMcpRecord(record);
  const serialized = JSON.stringify(view.diagnostics);

  assert.equal(view.diagnostics.headers.Authorization, "••••••••");
  assert.equal(view.diagnostics.headers.Cookie, "••••••••");
  assert.equal(view.diagnostics.nested.accessToken, "••••••••");
  assert.equal(view.diagnostics.nested.refreshToken, "••••••••");
  assert.equal(view.diagnostics.nested.apiKey, "••••••••");
  assert.match(view.diagnostics.nested.note, /\[redacted\]/);
  assert.doesNotMatch(serialized, /super-secret|abc123|access-secret|refresh-secret|api-secret|nested-secret/);
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

test("fingerprint changes when managed exposure readiness changes without transport changes", () => {
  const connected = normalizeCoreMcpRecord({
    name: "managed",
    nativeName: "managed",
    managementMode: "managed",
    enabled: true,
    status: "connected",
    lastTestStatus: "connected",
    transport: { type: "stdio", command: "npx", args: ["managed"] },
    connectionWizard: { state: "connected", nextAction: "", message: "ready" },
    managedRuntime: { state: "running" }
  });
  const disconnected = normalizeCoreMcpRecord({
    name: "managed",
    nativeName: "managed",
    managementMode: "managed",
    enabled: true,
    status: "disconnected",
    lastTestStatus: "disconnected",
    transport: { type: "stdio", command: "npx", args: ["managed"] },
    connectionWizard: { state: "managed_error", nextAction: "test", message: "retry" },
    managedRuntime: { state: "error" }
  });
  const nativeA = normalizeCoreMcpRecord({
    name: "native",
    nativeName: "native",
    managementMode: "native",
    enabled: true,
    transport: { type: "stdio", command: "npx", args: ["native"] }
  });
  const nativeB = normalizeCoreMcpRecord({
    name: "native",
    nativeName: "native",
    managementMode: "native",
    enabled: true,
    status: "disconnected",
    lastTestStatus: "disconnected",
    transport: { type: "stdio", command: "npx", args: ["native"] }
  });

  assert.notEqual(coreMcpFingerprint([connected]), coreMcpFingerprint([disconnected]));
  assert.equal(coreMcpFingerprint([nativeA]), coreMcpFingerprint([nativeB]));
});

test("managed failure state overrides stale connected readiness", () => {
  const connected = normalizeCoreMcpRecord({
    name: "managed",
    nativeName: "managed",
    managementMode: "managed",
    enabled: true,
    status: "connected",
    lastTestStatus: "connected",
    transport: { type: "stdio", command: "npx", args: ["managed"] },
    connectionWizard: { state: "connected", nextAction: "", message: "ready" },
    managedRuntime: { state: "running" }
  });
  const staleManagedError = normalizeCoreMcpRecord({
    name: "managed",
    nativeName: "managed",
    managementMode: "managed",
    enabled: true,
    status: "connected",
    lastTestStatus: "connected",
    transport: { type: "stdio", command: "npx", args: ["managed"] },
    connectionWizard: { state: "managed_error", nextAction: "test", message: "retry" },
    managedRuntime: { state: "error" }
  });

  assert.equal(isCoreMcpExposureReady(connected), true);
  assert.equal(isCoreMcpExposureReady(staleManagedError), false);
  assert.notEqual(coreMcpFingerprint([connected]), coreMcpFingerprint([staleManagedError]));
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

test("normalize rejects reserved builtin names for user records", () => {
  assert.equal(normalizeCoreMcpRecord({
    name: "mia-app",
    transport: { type: "stdio", command: "node" }
  }), null);
  assert.equal(normalizeCoreMcpRecord({
    name: "mia-scheduler",
    transport: { type: "stdio", command: "node" }
  }), null);

  const builtin = normalizeCoreMcpRecord({
    name: "mia-app",
    builtin: true,
    transport: { type: "stdio", command: "node" }
  });
  assert.equal(builtin.name, "mia-app");
});

test("normalizes managed runtime fields and public projection redacts managed-runtime internals", () => {
  const record = normalizeCoreMcpRecord({
    name: "小红书 MCP",
    nativeName: "xiaohongshu",
    managementMode: "managed",
    source: "marketplace",
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" },
    requiredInputs: [{ key: "TOKEN", label: "Token", secret: true, target: "env" }],
    connectionWizard: { state: "needs_managed_action", nextAction: "install", message: "ready" },
    managedRuntime: {
      connectorId: "xiaohongshu",
      endpoint: "http://127.0.0.1:18060/mcp",
      installDir: "/Users/me/.mia/xhs",
      lastAction: "Install command: npx -y xiaohongshu-mcp --api-key ghp_secret",
      expectedToolCount: 13,
      state: "not_installed"
    }
  });

  assert.equal(record.managementMode, "managed");
  assert.equal(record.requiredInputs[0].key, "TOKEN");
  assert.equal(record.connectionWizard.nextAction, "install");
  assert.equal(record.managedRuntime.expectedToolCount, 13);

  const view = publicCoreMcpRecord(record);
  assert.equal(view.managedRuntime.installDir, "[managed]");
  assert.equal(view.managedRuntime.lastAction, "[managed]");
  assert.equal(view.managedRuntime.lastAction.includes("npx"), false);
  assert.equal(view.managedRuntime.lastAction.includes("ghp_secret"), false);
});
