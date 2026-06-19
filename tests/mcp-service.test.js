const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createMcpService } = require("../src/main/mcp/mcp-service.js");

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-mcp-service-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = {
    home: path.join(dir, "home"),
    runtime: path.join(dir, "runtime"),
    mcpServers: path.join(dir, "home", "mia-mcp-servers.json")
  };
  const manager = overrides.manager || {
    testServer: async (record) => ({
      success: true,
      status: "connected",
      tools: [{ server: record.name, name: "search_notes", description: "", inputSchema: {} }],
      error: ""
    }),
    refresh: async () => ({ success: true, tools: [], errors: [] }),
    toolManifest: () => [],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false })
  };
  const bridge = overrides.bridge || {
    start: async () => ({
      callbackUrl: "http://127.0.0.1:3333/mcp/execute",
      manifestUrl: "http://127.0.0.1:3333/mcp/manifest",
      secret: "sec",
      port: 3333
    }),
    stop: async () => {}
  };
  const service = createMcpService({
    runtimePaths: () => runtime,
    fs,
    manager,
    bridge,
    nativeSync: overrides.nativeSync || (async () => ({ success: true, statuses: {}, commands: [] })),
    nodePath: () => "/usr/local/bin/node",
    stdioProxyScriptPath: () => path.join(runtime.runtime, "mcp-stdio-proxy-server.js"),
    now: () => 1710000000000,
    idFactory: overrides.idFactory || (() => "mcp_xhs")
  });
  return { runtime, service };
}

test("save list test and delete persist MCP records", async (t) => {
  const { runtime, service } = setup(t);

  const saved = await service.save({
    name: "xhs",
    transport: {
      type: "http",
      url: "http://127.0.0.1:18060/mcp",
      headers: { Authorization: "Bearer secret-token" }
    }
  });
  const tested = await service.test(saved.data.id);
  const listed = await service.list();
  const deleted = await service.delete(saved.data.id);

  assert.equal(saved.success, true);
  assert.equal(saved.data.transport.headers.Authorization, "••••••••");
  assert.equal(tested.data.status, "connected");
  assert.equal(listed.data.servers[0].tools[0].name, "search_notes");
  assert.equal(listed.data.servers[0].transport.headers.Authorization, "••••••••");
  assert.equal(deleted.success, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8")), []);
});

test("importJson saves imported servers as disabled until tested", async (t) => {
  const { service } = setup(t);
  const imported = await service.importJson({
    mcpServers: {
      xhs: { type: "http", url: "http://127.0.0.1:18060/mcp" }
    }
  });

  assert.equal(imported.success, true);
  assert.equal(imported.data.servers[0].enabled, false);
});

test("save disable sync removeFromAgents and delete refresh bridge and sync native agent configs", async (t) => {
  const syncCalls = [];
  const refreshCalls = [];
  const { runtime, service } = setup(t, {
    manager: {
      testServer: async () => ({ success: true, status: "connected", tools: [], error: "" }),
      refresh: async (records) => {
        refreshCalls.push(records.map((record) => record.name));
        return { success: true, tools: [], errors: [] };
      },
      toolManifest: () => [],
      callTool: async () => ({ content: [], isError: false })
    },
    nativeSync: async (payload) => {
      syncCalls.push(payload);
      return {
        success: true,
        statuses: {
          codex: { status: "synced", error: "", commands: [] },
          "claude-code": { status: "synced", error: "", commands: [] }
        },
        commands: []
      };
    }
  });

  const saved = await service.save({
    name: "xhs",
    enabled: true,
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }
  });
  const storedAfterSave = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));
  const disabled = await service.setEnabled(saved.data.id, false);
  const synced = await service.sync();
  const removed = await service.removeFromAgents([saved.data.id]);
  const deleted = await service.delete(saved.data.id);

  assert.equal(storedAfterSave[0].sync.codex.status, "synced");
  assert.equal(disabled.success, true);
  assert.equal(disabled.data.enabled, false);
  assert.equal(synced.success, true);
  assert.equal(removed.success, true);
  assert.equal(deleted.success, true);
  assert.equal(refreshCalls.length >= 5, true);
  assert.equal(syncCalls.length >= 5, true);
  assert.equal(syncCalls[0].currentRecords.some((record) => record.name === "xhs"), true);
  assert.equal(syncCalls[1].currentRecords.some((record) => record.name === "xhs" && record.enabled === false), true);
  assert.equal(syncCalls[3].previousRecords.some((record) => record.name === "xhs"), true);
  assert.equal(syncCalls[3].currentRecords.some((record) => record.name === "xhs"), false);
  assert.equal(syncCalls.at(-1).previousRecords.some((record) => record.name === "xhs"), true);
});

test("native sync failure redacts secrets before persisting or listing public sync status", async (t) => {
  const secretHeader = "Bearer ghp_secret_header_value";
  const secretEnv = "TOP_SECRET_ENV_VALUE";
  const secretToken = "sk-super-secret-token";
  const { runtime, service } = setup(t, {
    nativeSync: async () => ({
      success: false,
      statuses: {
        codex: {
          status: "error",
          message: `Authorization: ${secretHeader}; X_API_KEY=${secretEnv}; token=${secretToken}`
        }
      },
      commands: []
    })
  });

  const saved = await service.save({
    name: "github",
    enabled: true,
    transport: {
      type: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: secretHeader }
    }
  });
  const listed = await service.list();
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(saved.success, true);
  assert.equal(listed.success, true);
  assert.equal(stored[0].sync.codex.status, "error");
  assert.match(stored[0].sync.codex.message, /\[redacted\]/);
  assert.doesNotMatch(stored[0].sync.codex.message, /ghp_secret_header_value|TOP_SECRET_ENV_VALUE|sk-super-secret-token/);
  assert.match(listed.data.servers[0].sync.codex.message, /\[redacted\]/);
  assert.doesNotMatch(listed.data.servers[0].sync.codex.message, /ghp_secret_header_value|TOP_SECRET_ENV_VALUE|sk-super-secret-token/);
});

test("failed test disables a server through the shared runtime-change path", async (t) => {
  const syncCalls = [];
  const refreshCalls = [];
  const { runtime, service } = setup(t, {
    manager: {
      testServer: async () => ({
        success: false,
        status: "disconnected",
        tools: [],
        error: "Authorization: Bearer ghp_secret_test_failure"
      }),
      refresh: async (records) => {
        refreshCalls.push(records.map((record) => ({ name: record.name, enabled: record.enabled })));
        return { success: true, tools: [], errors: [] };
      },
      toolManifest: () => [],
      callTool: async () => ({ content: [], isError: false })
    },
    nativeSync: async (payload) => {
      syncCalls.push(payload);
      return { success: true, statuses: {}, commands: [] };
    }
  });

  const saved = await service.save({
    name: "xhs",
    enabled: true,
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }
  });
  const tested = await service.test(saved.data.id);
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(tested.success, true);
  assert.equal(tested.data.enabled, false);
  assert.equal(stored[0].enabled, false);
  assert.match(stored[0].lastError, /\[redacted\]/);
  assert.equal(refreshCalls.length >= 2, true);
  assert.equal(syncCalls.length >= 2, true);
  assert.equal(syncCalls.at(-1).previousRecords.some((record) => record.name === "xhs" && record.enabled === true), true);
  assert.equal(syncCalls.at(-1).currentRecords.some((record) => record.name === "xhs" && record.enabled === false), true);
});

test("setEnabled(false) surfaces native cleanup errors instead of synthetic available status", async (t) => {
  let syncStep = 0;
  const { runtime, service } = setup(t, {
    nativeSync: async () => {
      syncStep += 1;
      if (syncStep === 1) {
        return {
          success: true,
          statuses: {
            codex: { status: "synced", error: "", commands: [{ command: "codex", args: ["mcp", "add"] }] },
            "claude-code": { status: "synced", error: "", commands: [{ command: "claude", args: ["mcp", "add"] }] }
          },
          commands: [{ engine: "codex" }, { engine: "claude-code" }]
        };
      }
      return {
        success: false,
        statuses: {
          codex: { status: "error", message: "Authorization: Bearer ghp_disable_secret" },
          "claude-code": { status: "synced", error: "", commands: [{ command: "claude", args: ["mcp", "remove"] }] }
        },
        commands: [{ engine: "codex" }, { engine: "claude-code" }]
      };
    }
  });

  const saved = await service.save({
    name: "xhs",
    enabled: true,
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }
  });
  const disabled = await service.setEnabled(saved.data.id, false);
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(disabled.success, true);
  assert.equal(disabled.data.sync.codex.status, "error");
  assert.match(disabled.data.sync.codex.message, /\[redacted\]/);
  assert.doesNotMatch(disabled.data.sync.codex.message, /Disabled in Mia\.|ghp_disable_secret/);
  assert.equal(disabled.data.sync["claude-code"].status, "available");
  assert.equal(disabled.data.sync["claude-code"].message, "Disabled in Mia.");
  assert.equal(stored[0].sync.codex.status, "error");
  assert.match(stored[0].sync.codex.message, /\[redacted\]/);
});

test("targeted removeFromAgents surfaces native cleanup errors instead of synthetic available status", async (t) => {
  let syncStep = 0;
  const { runtime, service } = setup(t, {
    nativeSync: async () => {
      syncStep += 1;
      if (syncStep === 1) {
        return {
          success: true,
          statuses: {
            codex: { status: "synced", error: "", commands: [{ command: "codex", args: ["mcp", "add"] }] },
            "claude-code": { status: "synced", error: "", commands: [{ command: "claude", args: ["mcp", "add"] }] }
          },
          commands: [{ engine: "codex" }, { engine: "claude-code" }]
        };
      }
      return {
        success: false,
        statuses: {
          codex: { status: "synced", error: "", commands: [{ command: "codex", args: ["mcp", "remove"] }] },
          "claude-code": { status: "error", message: "token=sk-remove-secret-token" }
        },
        commands: [{ engine: "codex" }, { engine: "claude-code" }]
      };
    }
  });

  const saved = await service.save({
    name: "xhs",
    enabled: true,
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }
  });
  const removed = await service.removeFromAgents([saved.data.id]);
  const target = removed.data.servers.find((record) => record.id === saved.data.id);
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(removed.success, true);
  assert.equal(target.sync.codex.status, "available");
  assert.equal(target.sync.codex.message, "Removed from native agents.");
  assert.equal(target.sync["claude-code"].status, "error");
  assert.match(target.sync["claude-code"].message, /\[redacted\]/);
  assert.doesNotMatch(target.sync["claude-code"].message, /Removed from native agents\.|sk-remove-secret-token/);
  assert.equal(stored[0].sync["claude-code"].status, "error");
  assert.match(stored[0].sync["claude-code"].message, /\[redacted\]/);
});

test("failed test cleanup surfaces native disable errors instead of synthetic available status", async (t) => {
  let syncStep = 0;
  const { runtime, service } = setup(t, {
    manager: {
      testServer: async () => ({
        success: false,
        status: "disconnected",
        tools: [],
        error: "Authorization: Bearer ghp_test_cleanup_secret"
      }),
      refresh: async () => ({ success: true, tools: [], errors: [] }),
      toolManifest: () => [],
      callTool: async () => ({ content: [], isError: false })
    },
    nativeSync: async () => {
      syncStep += 1;
      if (syncStep === 1) {
        return {
          success: true,
          statuses: {
            codex: { status: "synced", error: "", commands: [{ command: "codex", args: ["mcp", "add"] }] },
            "claude-code": { status: "synced", error: "", commands: [{ command: "claude", args: ["mcp", "add"] }] }
          },
          commands: [{ engine: "codex" }, { engine: "claude-code" }]
        };
      }
      return {
        success: false,
        statuses: {
          codex: { status: "error", message: "Authorization: Bearer ghp_native_disable_secret" },
          "claude-code": { status: "synced", error: "", commands: [{ command: "claude", args: ["mcp", "remove"] }] }
        },
        commands: [{ engine: "codex" }, { engine: "claude-code" }]
      };
    }
  });

  const saved = await service.save({
    name: "xhs",
    enabled: true,
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }
  });
  const tested = await service.test(saved.data.id);
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(tested.success, true);
  assert.equal(tested.data.enabled, false);
  assert.equal(tested.data.sync.codex.status, "error");
  assert.match(tested.data.sync.codex.message, /\[redacted\]/);
  assert.doesNotMatch(tested.data.sync.codex.message, /Disabled in Mia after failed test\.|ghp_native_disable_secret/);
  assert.equal(tested.data.sync["claude-code"].status, "available");
  assert.equal(tested.data.sync["claude-code"].message, "Disabled in Mia after failed test.");
  assert.equal(stored[0].sync.codex.status, "error");
  assert.match(stored[0].sync.codex.message, /\[redacted\]/);
});

test("targeted removeFromAgents does not add or re-sync other enabled servers", async (t) => {
  const syncCalls = [];
  let nextId = 0;
  const { service } = setup(t, {
    idFactory: () => `mcp_${++nextId}`,
    nativeSync: async (payload) => {
      syncCalls.push(payload);
      return { success: true, statuses: {}, commands: [] };
    }
  });

  const first = await service.save({
    name: "alpha",
    enabled: true,
    transport: { type: "http", url: "http://127.0.0.1:18061/mcp" }
  });
  const second = await service.save({
    name: "beta",
    enabled: true,
    transport: { type: "http", url: "http://127.0.0.1:18062/mcp" }
  });

  syncCalls.length = 0;

  const removedFirst = await service.removeFromAgents([first.data.id]);
  const firstRemovalSync = syncCalls.at(-1);
  const removedSecond = await service.removeFromAgents([second.data.id]);
  const secondRemovalSync = syncCalls.at(-1);
  const listed = await service.list();

  assert.equal(removedFirst.success, true);
  assert.deepEqual(firstRemovalSync.previousRecords.map((record) => record.name), ["alpha"]);
  assert.deepEqual(firstRemovalSync.currentRecords, []);

  assert.equal(removedSecond.success, true);
  assert.deepEqual(secondRemovalSync.previousRecords.map((record) => record.name), ["beta"]);
  assert.deepEqual(secondRemovalSync.currentRecords, []);

  assert.equal(listed.success, true);
  assert.deepEqual(listed.data.servers.map((record) => [record.name, record.enabled]), [
    ["alpha", true],
    ["beta", true]
  ]);
});

test("delete keeps the record with sanitized native cleanup errors when removal fails", async (t) => {
  let syncStep = 0;
  const { runtime, service } = setup(t, {
    nativeSync: async () => {
      syncStep += 1;
      if (syncStep === 1) {
        return {
          success: true,
          statuses: {
            codex: { status: "synced", error: "", commands: [{ command: "codex", args: ["mcp", "add"] }] },
            "claude-code": { status: "synced", error: "", commands: [{ command: "claude", args: ["mcp", "add"] }] }
          },
          commands: [{ engine: "codex" }, { engine: "claude-code" }]
        };
      }
      return {
        success: false,
        statuses: {
          codex: { status: "error", message: "Authorization: Bearer ghp_delete_secret" },
          "claude-code": { status: "synced", error: "", commands: [{ command: "claude", args: ["mcp", "remove"] }] }
        },
        commands: [{ engine: "codex" }, { engine: "claude-code" }]
      };
    }
  });

  const saved = await service.save({
    name: "xhs",
    enabled: true,
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }
  });
  const deleted = await service.delete(saved.data.id);
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(deleted.success, true);
  assert.equal(deleted.data.servers.length, 1);
  assert.equal(deleted.data.servers[0].id, saved.data.id);
  assert.equal(deleted.data.servers[0].sync.codex.status, "error");
  assert.match(deleted.data.servers[0].sync.codex.message, /\[redacted\]/);
  assert.doesNotMatch(deleted.data.servers[0].sync.codex.message, /ghp_delete_secret/);
  assert.equal(deleted.data.servers[0].sync["claude-code"].status, "synced");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, saved.data.id);
  assert.equal(stored[0].sync.codex.status, "error");
  assert.match(stored[0].sync.codex.message, /\[redacted\]/);
  assert.doesNotMatch(stored[0].sync.codex.message, /ghp_delete_secret/);
});
