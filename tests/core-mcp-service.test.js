const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createCoreMcpService } = require("../src/core/mcp/service.js");

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-mcp-service-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = { mcpServers: path.join(dir, "mia-mcp-servers.json"), runtime: dir };
  const manager = overrides.manager || {
    refresh: async () => ({ success: true, tools: [], errors: [] }),
    testServer: async (record) => ({ ok: true, success: true, status: "connected", code: "ok", tools: [{ server: record.name, name: "search" }], error: "" }),
    toolManifest: () => [{ server: "xhs", name: "search", inputSchema: {} }]
  };
  return {
    service: createCoreMcpService({
      runtimePaths: () => runtime,
      fs,
      manager,
      bridge: overrides.bridge || { start: async () => ({ callbackUrl: "http://127.0.0.1:3333/mcp/execute", manifestUrl: "http://127.0.0.1:3333/mcp/manifest", secret: "sec" }) },
      nativeSync: overrides.nativeSync || (async () => ({ success: true, statuses: {}, commands: [] })),
      connectionTester: overrides.connectionTester,
      agentConfigService: overrides.agentConfigService,
      agentConfigRunner: overrides.agentConfigRunner,
      managedSupervisor: overrides.managedSupervisor,
      oauthService: overrides.oauthService,
      now: () => 1710000000000,
      idFactory: (name) => `mcp_${name}`
    }),
    runtime
  };
}

async function saveManagedFixture(service) {
  const saved = await service.save({
    name: "demo-managed",
    nativeName: "demo-managed",
    managementMode: "managed",
    enabled: false,
    transport: { type: "http", url: "http://127.0.0.1:18100/mcp" },
    managedRuntime: {
      connectorId: "demo-managed",
      endpoint: "http://127.0.0.1:18100/mcp",
      expectedToolCount: 1
    }
  });
  assert.equal(saved.success, true);
  return saved;
}

test("delete soft-deletes and list hides deleted records by default", async (t) => {
  const { service, runtime } = setup(t);
  const saved = await service.save({ name: "xhs", transport: { type: "http", url: "http://127.0.0.1:18060/mcp" } });

  const deleted = await service.delete(saved.data.id);
  const listed = await service.list();
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(deleted.success, true);
  assert.deepEqual(listed.data.servers, []);
  assert.equal(stored[0].deletedAt, 1710000000000);
  assert.equal(stored[0].enabled, false);
});

test("soft-deleted records survive later save setEnabled and import writes", async (t) => {
  const { service, runtime } = setup(t);
  const deletedSource = await service.save({ name: "gone", transport: { type: "stdio", command: "npx", args: ["gone"] } });
  await service.delete(deletedSource.data.id);

  const active = await service.save({ name: "active", transport: { type: "stdio", command: "npx", args: ["active"] } });
  let stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));
  assert.equal(stored.some((record) => record.name === "gone" && record.deletedAt === 1710000000000), true);

  await service.setEnabled(active.data.id, false);
  stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));
  assert.equal(stored.some((record) => record.name === "gone" && record.deletedAt === 1710000000000), true);

  await service.importJson({
    mcpServers: {
      imported: { type: "http", url: "https://example.com/mcp" }
    }
  });
  stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));
  assert.equal(stored.some((record) => record.name === "gone" && record.deletedAt === 1710000000000), true);
  assert.deepEqual(stored.map((record) => record.name).sort(), ["active", "gone", "imported"]);
});

test("failed test persists diagnostics but does not auto-disable existing server", async (t) => {
  const { service, runtime } = setup(t, {
    connectionTester: {
      testConnection: async () => ({
        ok: false,
        success: false,
        status: "auth_required",
        code: "auth_required",
        message: "OAuth login required",
        tools: [],
        auth: { needsAuth: true, method: "oauth", serverUrl: "https://example.com/mcp" }
      })
    }
  });
  const saved = await service.save({ name: "remote", enabled: true, transport: { type: "http", url: "https://example.com/mcp" } });
  const tested = await service.test(saved.data.id);
  const listed = await service.list();
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(tested.success, true);
  assert.equal(tested.data.enabled, true);
  assert.equal(tested.data.lastTestStatus, "auth_required");
  assert.equal(tested.data.lastTestCode, "auth_required");
  assert.equal(listed.data.servers[0].lastTestCode, "auth_required");
  assert.equal(stored[0].lastTestCode, "auth_required");
  assert.equal(tested.data.lastError, "OAuth login required");
});

test("new methods delegate to agent discovery oauth and manager manifest", async (t) => {
  const calls = [];
  const { service } = setup(t, {
    agentConfigService: {
      getAgentConfigs: async () => [{ source: "codex", installed: true, servers: [] }],
      importAgentConfig: async (input) => ({ imported: 1, input })
    },
    oauthService: {
      checkStatus: async (input) => ({ authenticated: true, input }),
      login: async () => ({ loginUrl: "http://127.0.0.1/login" }),
      logout: async () => ({ authenticated: false })
    },
    manager: {
      refresh: async () => ({ success: true, tools: [], errors: [] }),
      testServer: async () => ({ ok: true, status: "connected", tools: [] }),
      toolManifest: () => { calls.push("manifest"); return [{ server: "xhs", name: "search" }]; }
    }
  });

  assert.equal((await service.listTools()).data.tools[0].name, "search");
  assert.equal((await service.getAgentConfigs()).data.sources[0].source, "codex");
  assert.equal((await service.oauth.checkStatus({ serverUrl: "https://example.com/mcp" })).data.authenticated, true);
  assert.deepEqual(calls, ["manifest"]);
});

test("default agent discovery service uses runner", async (t) => {
  const calls = [];
  const { service } = setup(t, {
    agentConfigRunner: async (command) => {
      calls.push(command);
      if (command === "claude") return { ok: true, stdout: "xhs: npx -y xhs - ✓ Connected", stderr: "" };
      return { ok: false, stdout: "", stderr: "missing" };
    }
  });

  const result = await service.getAgentConfigs();

  assert.equal(result.success, true);
  assert.deepEqual(result.data.sources.map((source) => source.source), ["claude-code", "codex", "hermes"]);
  assert.equal(result.data.sources[0].servers[0].name, "xhs");
  assert.ok(calls.includes("claude"));
});

test("getAgentConfigs masks discovered env and header secrets", async (t) => {
  const { service } = setup(t, {
    agentConfigRunner: async (command) => {
      if (command === "claude") return { ok: true, stdout: "", stderr: "" };
      if (command === "codex") {
        return {
          ok: true,
          stdout: JSON.stringify([
            {
              name: "stdio-secret",
              enabled: true,
              transport: {
                type: "stdio",
                command: "npx",
                args: ["-y", "secret-mcp"],
                env: { API_TOKEN: "raw-token", SAFE_VALUE: "visible" }
              }
            },
            {
              name: "http-secret",
              enabled: true,
              transport: {
                type: "http",
                url: "https://example.com/mcp",
                headers: { Authorization: "Bearer raw-header", Cookie: "sid=raw-cookie", "X-Trace": "visible" }
              }
            }
          ]),
          stderr: ""
        };
      }
      return { ok: false, stdout: "", stderr: "" };
    }
  });

  const result = await service.getAgentConfigs();
  const servers = result.data.sources.find((source) => source.source === "codex").servers;

  assert.equal(result.success, true);
  assert.equal(servers.find((server) => server.name === "stdio-secret").transport.env.API_TOKEN, "••••••••");
  assert.equal(servers.find((server) => server.name === "stdio-secret").transport.env.SAFE_VALUE, "visible");
  assert.equal(servers.find((server) => server.name === "http-secret").transport.headers.Authorization, "••••••••");
  assert.equal(servers.find((server) => server.name === "http-secret").transport.headers.Cookie, "••••••••");
  assert.equal(servers.find((server) => server.name === "http-secret").transport.headers["X-Trace"], "visible");
});

test("importAgentConfig writes disabled agent-config registry record", async (t) => {
  const { service, runtime } = setup(t, {
    agentConfigService: {
      getAgentConfigs: async () => [],
      importAgentConfig: async () => ({
        imported: 1,
        server: {
          source: "codex",
          name: "pw",
          importable: true,
          transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp"], env: { API_TOKEN: "secret" } }
        }
      })
    }
  });

  const imported = await service.importAgentConfig({ sourceAgent: "codex", serverName: "pw" });
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(imported.success, true);
  assert.equal(imported.data.imported, 1);
  assert.equal(imported.data.server.name, "pw");
  assert.equal(imported.data.server.enabled, false);
  assert.equal(imported.data.server.source, "agent-config");
  assert.equal(imported.data.server.sourceAgent, "codex");
  assert.equal(imported.data.server.transport.env.API_TOKEN, "••••••••");
  assert.equal(stored[0].enabled, false);
  assert.equal(stored[0].source, "agent-config");
  assert.equal(stored[0].sourceAgent, "codex");
  assert.equal(stored[0].transport.env.API_TOKEN, "secret");
});

test("default importAgentConfig stores raw discovered secret and returns masked record", async (t) => {
  const { service, runtime } = setup(t, {
    agentConfigRunner: async (command) => {
      if (command === "codex") {
        return {
          ok: true,
          stdout: JSON.stringify([
            {
              name: "pw",
              enabled: true,
              transport: {
                type: "stdio",
                command: "npx",
                args: ["-y", "@playwright/mcp"],
                env: { API_TOKEN: "raw-token" }
              }
            }
          ]),
          stderr: ""
        };
      }
      return { ok: true, stdout: "", stderr: "" };
    }
  });

  const imported = await service.importAgentConfig({ sourceAgent: "codex", serverName: "pw" });
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(imported.success, true);
  assert.equal(imported.data.server.transport.env.API_TOKEN, "••••••••");
  assert.equal(stored[0].transport.env.API_TOKEN, "raw-token");
});

test("importAgentConfig rejects plugin-managed disabled and failed discoveries", async (t) => {
  const { service } = setup(t, {
    agentConfigRunner: async (command) => {
      if (command === "claude") {
        return {
          ok: true,
          stdout: "plugin:skip: node skip.js - ✓ Connected\nbroken: node bad.js - ✗ Failed TOKEN=raw-secret",
          stderr: ""
        };
      }
      if (command === "codex") {
        return {
          ok: true,
          stdout: JSON.stringify([
            { name: "disabled", enabled: false, transport: { type: "stdio", command: "npx", args: ["disabled"] } }
          ]),
          stderr: ""
        };
      }
      return { ok: true, stdout: "", stderr: "" };
    }
  });

  const plugin = await service.importAgentConfig({ sourceAgent: "claude-code", serverName: "plugin:skip" });
  const failed = await service.importAgentConfig({ sourceAgent: "claude-code", serverName: "broken" });
  const disabled = await service.importAgentConfig({ sourceAgent: "codex", serverName: "disabled" });

  assert.equal(plugin.success, false);
  assert.equal(plugin.error, "Plugin-managed MCP");
  assert.equal(failed.success, false);
  assert.equal(failed.error, "Failed TOKEN=[redacted]");
  assert.equal(disabled.success, false);
  assert.equal(disabled.error, "Disabled");
});

test("default importAgentConfig rejects object-shaped disabled Codex discovery", async (t) => {
  const { service, runtime } = setup(t, {
    agentConfigRunner: async (command) => {
      if (command === "codex") {
        return {
          ok: true,
          stdout: JSON.stringify({
            mcpServers: {
              disabled: {
                enabled: false,
                type: "stdio",
                command: "npx",
                args: ["disabled"],
                env: { API_TOKEN: "raw-secret" }
              }
            }
          }),
          stderr: ""
        };
      }
      return { ok: true, stdout: "", stderr: "" };
    }
  });

  const disabled = await service.importAgentConfig({ sourceAgent: "codex", serverName: "disabled" });

  assert.equal(disabled.success, false);
  assert.equal(disabled.error, "Disabled");
  assert.doesNotMatch(disabled.error, /raw-secret/);
  assert.equal(fs.existsSync(runtime.mcpServers), false);
});

test("default oauth service stores tokens outside registry and reports status", async (t) => {
  const { service, runtime } = setup(t);

  const before = await service.oauth.checkStatus({ serverUrl: "https://example.com/mcp" });
  const logout = await service.oauth.logout({ serverUrl: "https://example.com/mcp" });

  assert.equal(before.success, true);
  assert.equal(before.data.authenticated, false);
  assert.equal(before.data.accessToken, undefined);
  assert.equal(logout.success, true);
  assert.equal(logout.data.authenticated, false);
  assert.equal(fs.existsSync(runtime.mcpServers), false);
});

test("fetchMarketplace exposes only supported native and managed templates", async (t) => {
  const { service } = setup(t);

  const result = await service.fetchMarketplace();

  assert.equal(result.success, true);
  assert.deepEqual(result.data.templates.map((item) => item.id), [
    "playwright",
    "context7",
    "github",
    "tavily",
    "firecrawl"
  ]);
  assert.equal(result.data.templates.some((item) => String(item.managementMode).includes("external")), false);
});

test("refreshBridge sanitizes managed supervisor errors", async (t) => {
  const { service } = setup(t, {
    managedSupervisor: {
      ensureRunning: async () => ({
        records: [],
        errors: [{ message: "managed failure TOKEN=secret-value" }]
      })
    }
  });

  const refreshed = await service.refreshBridge();

  assert.equal(refreshed.success, true);
  assert.equal(refreshed.data.errors[0].message, "managed failure TOKEN=[redacted]");
});

test("refreshBridge excludes ensureRunning failures from same-cycle native sync current records", async (t) => {
  const nativeSyncCalls = [];
  const { service } = setup(t, {
    managedSupervisor: {
      runAction: async (record, action) => ({
        ok: true,
        state: action,
        message: action,
        recordPatch: {
          managedRuntime: { ...record.managedRuntime, state: action === "test" ? "running" : action }
        }
      }),
      ensureRunning: async (records) => ({
        records: records.map((record) => {
          if (record.nativeName === "demo-managed") {
            return {
              ...record,
              managedRuntime: { ...record.managedRuntime, state: "error" },
              connectionWizard: {
                ...record.connectionWizard,
                state: "managed_error",
                nextAction: "start",
                message: "demo-managed startup failed"
              }
            };
          }
          return record;
        }),
        errors: [{ id: "mcp_demo-managed", name: "demo-managed", message: "startup failed" }]
      })
    },
    nativeSync: async ({ currentRecords }) => {
      nativeSyncCalls.push(currentRecords.map((record) => record.nativeName));
      return { success: true, statuses: {}, commands: [] };
    }
  });

  const installed = await saveManagedFixture(service);
  await service.runManagedAction(installed.data.id, "test", {});
  nativeSyncCalls.length = 0;

  const refreshed = await service.installTemplate("playwright", {});

  assert.equal(refreshed.success, true);
  assert.deepEqual(nativeSyncCalls, [["playwright"]]);
});

test("getEngineSpecs excludes managed records until connection is confirmed", async (t) => {
  const { service } = setup(t);

  await service.save({
    id: "managed_error",
    name: "managed-error",
    nativeName: "managed-error",
    managementMode: "managed",
    enabled: true,
    status: "disconnected",
    transport: { type: "stdio", command: "npx", args: ["managed-error"] },
    connectionWizard: { state: "managed_error", nextAction: "test", message: "retry" },
    managedRuntime: { state: "error" }
  });
  await service.save({
    id: "managed_disconnected",
    name: "managed-disconnected",
    nativeName: "managed-disconnected",
    managementMode: "managed",
    enabled: true,
    status: "running",
    lastTestStatus: "disconnected",
    transport: { type: "stdio", command: "npx", args: ["managed-disconnected"] },
    connectionWizard: { state: "ready_to_test", nextAction: "test", message: "test me" },
    managedRuntime: { state: "running" }
  });
  await service.save({
    id: "managed_connected",
    name: "managed-connected",
    nativeName: "managed-connected",
    managementMode: "managed",
    enabled: true,
    status: "connected",
    lastTestStatus: "connected",
    transport: { type: "stdio", command: "npx", args: ["managed-connected"] },
    connectionWizard: { state: "connected", nextAction: "", message: "ready" },
    managedRuntime: { state: "running" }
  });
  await service.save({
    id: "native_enabled",
    name: "native-enabled",
    nativeName: "native-enabled",
    managementMode: "native",
    enabled: true,
    transport: { type: "stdio", command: "npx", args: ["native-enabled"] }
  });

  const codexSpecs = service.getEngineSpecs("codex");

  assert.equal("managed-error" in codexSpecs, false);
  assert.equal("managed-disconnected" in codexSpecs, false);
  assert.equal("managed-connected" in codexSpecs, true);
  assert.equal("native-enabled" in codexSpecs, true);
});

test("getEngineSpecs excludes stale-connected managed records after startup failure", async (t) => {
  const { service } = setup(t);

  await service.save({
    id: "managed_stale_connected_error",
    name: "managed-stale-connected-error",
    nativeName: "managed-stale-connected-error",
    managementMode: "managed",
    enabled: true,
    status: "connected",
    lastTestStatus: "connected",
    transport: { type: "stdio", command: "npx", args: ["managed-stale-connected-error"] },
    connectionWizard: { state: "managed_error", nextAction: "start", message: "startup failed" },
    managedRuntime: { state: "error" }
  });
  await service.save({
    id: "managed_connected_ok",
    name: "managed-connected-ok",
    nativeName: "managed-connected-ok",
    managementMode: "managed",
    enabled: true,
    status: "connected",
    lastTestStatus: "connected",
    transport: { type: "stdio", command: "npx", args: ["managed-connected-ok"] },
    connectionWizard: { state: "connected", nextAction: "", message: "ready" },
    managedRuntime: { state: "running" }
  });

  const beforeFailureFingerprint = service.fingerprint();
  const codexSpecs = service.getEngineSpecs("codex");

  assert.equal("managed-stale-connected-error" in codexSpecs, false);
  assert.equal("managed-connected-ok" in codexSpecs, true);

  await service.save({
    id: "managed_stale_connected_error",
    name: "managed-stale-connected-error",
    nativeName: "managed-stale-connected-error",
    managementMode: "managed",
    enabled: true,
    status: "connected",
    lastTestStatus: "connected",
    transport: { type: "stdio", command: "npx", args: ["managed-stale-connected-error"] },
    connectionWizard: { state: "connected", nextAction: "", message: "ready" },
    managedRuntime: { state: "running" }
  });

  assert.notEqual(service.fingerprint(), beforeFailureFingerprint);
});

test("fingerprint changes when managed exposure readiness changes", async (t) => {
  const { service } = setup(t);

  const connected = await service.save({
    id: "managed_connected",
    name: "managed-connected",
    nativeName: "managed-connected",
    managementMode: "managed",
    enabled: true,
    status: "connected",
    lastTestStatus: "connected",
    transport: { type: "stdio", command: "npx", args: ["managed-connected"] },
    connectionWizard: { state: "connected", nextAction: "", message: "ready" },
    managedRuntime: { state: "running" }
  });
  assert.equal(connected.success, true);
  const connectedFingerprint = service.fingerprint();

  const failed = await service.save({
    id: "managed_connected",
    name: "managed-connected",
    nativeName: "managed-connected",
    managementMode: "managed",
    enabled: true,
    status: "disconnected",
    lastTestStatus: "disconnected",
    transport: { type: "stdio", command: "npx", args: ["managed-connected"] },
    connectionWizard: { state: "managed_error", nextAction: "test", message: "retry" },
    managedRuntime: { state: "error" }
  });

  assert.equal(failed.success, true);
  assert.notEqual(service.fingerprint(), connectedFingerprint);
});
