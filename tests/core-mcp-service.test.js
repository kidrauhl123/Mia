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
      oauthService: overrides.oauthService,
      now: () => 1710000000000,
      idFactory: (name) => `mcp_${name}`
    }),
    runtime
  };
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
  assert.equal((await service.importAgentConfig({ sourceAgent: "codex", serverName: "x" })).data.imported, 1);
  assert.equal((await service.oauth.checkStatus({ serverUrl: "https://example.com/mcp" })).data.authenticated, true);
  assert.deepEqual(calls, ["manifest"]);
});
