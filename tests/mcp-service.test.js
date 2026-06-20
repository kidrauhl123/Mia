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

test("fetchMarketplace exposes AION-style browser automation MCP templates", async (t) => {
  const { service } = setup(t);

  const market = await service.fetchMarketplace();
  const templates = Object.fromEntries(market.data.templates.map((template) => [template.id, template]));

  assert.equal(market.success, true);
  assert.equal(templates["chrome-devtools-cdp"].category, "浏览器自动化");
  assert.deepEqual(templates["chrome-devtools-cdp"].transport, {
    type: "stdio",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@0.16.0", "--browser-url=http://127.0.0.1:9222"],
    env: {}
  });
  assert.deepEqual(templates["playwright-browser"].transport, {
    type: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    env: {}
  });
});

test("installTemplate persists browser MCP templates and syncs native agents", async (t) => {
  let nextId = 0;
  const syncCalls = [];
  const { runtime, service } = setup(t, {
    idFactory: () => `mcp_${++nextId}`,
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

  const installed = await service.installTemplate("playwright-browser");
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(installed.success, true);
  assert.equal(installed.data.name, "Playwright MCP");
  assert.equal(stored[0].registryId, "playwright-browser");
  assert.equal(stored[0].source, "marketplace");
  assert.deepEqual(stored[0].transport, {
    type: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    env: {}
  });
  assert.equal(syncCalls.length, 1);
  assert.deepEqual(syncCalls[0].currentRecords.map((record) => record.name), ["Playwright MCP"]);
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

test("save preserves masked header values when editing non-secret fields", async (t) => {
  const { runtime, service } = setup(t);
  const saved = await service.save({
    name: "xhs",
    description: "before",
    transport: {
      type: "http",
      url: "http://127.0.0.1:18060/mcp",
      headers: { Authorization: "Bearer real-token" }
    }
  });

  const edited = await service.save({
    id: saved.data.id,
    name: "xhs",
    description: "after",
    transport: {
      type: "http",
      url: "http://127.0.0.1:18061/mcp",
      headers: { Authorization: "••••••••" }
    }
  });
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(edited.success, true);
  assert.equal(edited.data.description, "after");
  assert.equal(edited.data.transport.headers.Authorization, "••••••••");
  assert.equal(stored[0].transport.url, "http://127.0.0.1:18061/mcp");
  assert.equal(stored[0].transport.headers.Authorization, "Bearer real-token");
});

test("save preserves masked stdio env values when editing non-secret fields", async (t) => {
  const { runtime, service } = setup(t);
  const saved = await service.save({
    name: "github",
    description: "before",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "pkg"],
      env: { GITHUB_TOKEN: "ghp_real" }
    }
  });

  const edited = await service.save({
    id: saved.data.id,
    name: "github",
    description: "after",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "pkg2"],
      env: { GITHUB_TOKEN: "••••••••" }
    }
  });
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(edited.success, true);
  assert.equal(stored[0].transport.args[1], "pkg2");
  assert.equal(stored[0].transport.env.GITHUB_TOKEN, "ghp_real");
});

test("importJson surfaces duplicate names before confirmed replacement", async (t) => {
  let nextId = 0;
  const syncCalls = [];
  const { runtime, service } = setup(t, {
    idFactory: () => `mcp_${++nextId}`,
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
  syncCalls.length = 0;

  const duplicate = await service.importJson({
    mcpServers: {
      xhs: { type: "http", url: "http://127.0.0.1:18061/mcp" }
    }
  });
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(duplicate.success, true);
  assert.equal(duplicate.data.requiresConfirmation, true);
  assert.deepEqual(duplicate.data.duplicates, ["xhs"]);
  assert.equal(duplicate.data.imported, 0);
  assert.equal(syncCalls.length, 0);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, saved.data.id);
  assert.equal(stored[0].transport.url, "http://127.0.0.1:18060/mcp");
});

test("confirmed duplicate import replaces through runtime cleanup path", async (t) => {
  let nextId = 0;
  const syncCalls = [];
  const { runtime, service } = setup(t, {
    idFactory: () => `mcp_${++nextId}`,
    nativeSync: async (payload) => {
      syncCalls.push(payload);
      return { success: true, statuses: {}, commands: [] };
    }
  });
  await service.save({
    name: "xhs",
    enabled: true,
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }
  });
  syncCalls.length = 0;

  const replaced = await service.importJson({
    mcpServers: {
      xhs: { type: "http", url: "http://127.0.0.1:18061/mcp" }
    }
  }, { replaceDuplicates: true });
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(replaced.success, true);
  assert.equal(replaced.data.replaced, 1);
  assert.equal(replaced.data.imported, 1);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, "xhs");
  assert.equal(stored[0].enabled, false);
  assert.equal(stored[0].transport.url, "http://127.0.0.1:18061/mcp");
  assert.equal(syncCalls.length, 1);
  assert.deepEqual(syncCalls[0].previousRecords.map((record) => [record.name, record.enabled]), [["xhs", true]]);
  assert.deepEqual(syncCalls[0].currentRecords.map((record) => [record.name, record.enabled]), [["xhs", false]]);
});

test("save and list mask invalid originalJson secret text in public records", async (t) => {
  const { service } = setup(t);
  const originalJson = "Authorization: Bearer ghp_secret_token X_API_KEY=super_secret_value HEADER_AUTH: sk-super-secret-token";

  const saved = await service.save({
    name: "masked-invalid-json",
    originalJson,
    transport: {
      type: "http",
      url: "https://example.test/mcp"
    }
  });
  const listed = await service.list();

  assert.equal(saved.success, true);
  assert.match(saved.data.originalJson, /\[redacted\]/);
  assert.doesNotMatch(saved.data.originalJson, /ghp_secret_token|super_secret_value|sk-super-secret-token/);
  assert.equal(listed.success, true);
  assert.match(listed.data.servers[0].originalJson, /\[redacted\]/);
  assert.doesNotMatch(listed.data.servers[0].originalJson, /ghp_secret_token|super_secret_value|sk-super-secret-token/);
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

test("refreshBridge returns sanitized IPC errors when dependencies throw secret-bearing messages", async (t) => {
  const { service } = setup(t, {
    manager: {
      testServer: async () => ({ success: true, status: "connected", tools: [], error: "" }),
      refresh: async () => {
        throw new Error("Authorization: Bearer secret-token X_API_KEY=secret");
      },
      toolManifest: () => [],
      callTool: async () => ({ content: [], isError: false })
    }
  });

  const refreshed = await service.refreshBridge();

  assert.equal(refreshed.success, false);
  assert.match(refreshed.error, /\[redacted\]/);
  assert.doesNotMatch(refreshed.error, /secret-token|X_API_KEY=secret/);
});

test("refreshBridge redacts bridge refresh errors before returning them", async (t) => {
  const { service } = setup(t, {
    manager: {
      testServer: async () => ({ success: true, status: "connected", tools: [], error: "" }),
      refresh: async () => ({
        success: false,
        tools: [],
        errors: [
          { server: "bridge-a", error: "Authorization: Bearer ghp_bridge_secret" },
          "X_API_KEY=super_secret_bridge_value"
        ]
      }),
      toolManifest: () => [],
      callTool: async () => ({ content: [], isError: false })
    }
  });

  const refreshed = await service.refreshBridge();

  assert.equal(refreshed.success, true);
  assert.match(refreshed.data.errors[0].error, /\[redacted\]/);
  assert.doesNotMatch(refreshed.data.errors[0].error, /ghp_bridge_secret/);
  assert.match(refreshed.data.errors[1], /\[redacted\]/);
  assert.doesNotMatch(refreshed.data.errors[1], /super_secret_bridge_value/);
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

test("targeted removeFromAgents preserves non-target sync state exactly", async (t) => {
  let nextId = 0;
  const { runtime, service } = setup(t, {
    idFactory: () => `mcp_${++nextId}`,
    nativeSync: async () => ({
      success: true,
      statuses: {
        codex: { status: "synced", message: "native-cleanup" },
        "claude-code": { status: "synced", message: "native-cleanup" }
      },
      commands: [{ engine: "codex" }, { engine: "claude-code" }]
    })
  });

  const alpha = await service.save({
    name: "alpha",
    enabled: true,
    transport: { type: "http", url: "http://127.0.0.1:18061/mcp" }
  });
  const beta = await service.save({
    name: "beta",
    enabled: true,
    transport: { type: "http", url: "http://127.0.0.1:18062/mcp" }
  });

  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));
  const alphaStored = stored.find((record) => record.id === alpha.data.id);
  const betaStored = stored.find((record) => record.id === beta.data.id);
  alphaStored.sync.codex = { status: "pending", message: "alpha-before" };
  alphaStored.sync["claude-code"] = { status: "pending", message: "alpha-before" };
  betaStored.sync.codex = { status: "error", message: "beta-codex-before" };
  betaStored.sync["claude-code"] = { status: "synced", message: "beta-claude-before" };
  fs.writeFileSync(runtime.mcpServers, JSON.stringify(stored, null, 2));

  const expectedBetaSync = JSON.parse(JSON.stringify(betaStored.sync));
  const removed = await service.removeFromAgents([alpha.data.id]);
  const persisted = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));
  const removedAlpha = removed.data.servers.find((record) => record.id === alpha.data.id);
  const persistedBeta = persisted.find((record) => record.id === beta.data.id);
  const returnedBeta = removed.data.servers.find((record) => record.id === beta.data.id);

  assert.equal(removed.success, true);
  assert.equal(removedAlpha.sync.codex.status, "available");
  assert.equal(removedAlpha.sync.codex.message, "Removed from native agents.");
  assert.equal(removedAlpha.sync["claude-code"].status, "available");
  assert.equal(removedAlpha.sync["claude-code"].message, "Removed from native agents.");
  assert.deepEqual(returnedBeta.sync, expectedBetaSync);
  assert.deepEqual(persistedBeta.sync, expectedBetaSync);
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

test("delete persists refreshed sync status for surviving records after successful removal", async (t) => {
  let syncStep = 0;
  let nextId = 0;
  const { runtime, service } = setup(t, {
    idFactory: () => `mcp_${++nextId}`,
    nativeSync: async () => {
      syncStep += 1;
      if (syncStep < 3) {
        return {
          success: true,
          statuses: {
            codex: { status: "synced", message: `save-${syncStep}` },
            "claude-code": { status: "synced", message: `save-${syncStep}` }
          },
          commands: [{ engine: "codex" }, { engine: "claude-code" }]
        };
      }
      return {
        success: true,
        statuses: {
          codex: { status: "noop", message: "delete-refresh" },
          "claude-code": { status: "synced", message: "delete-refresh" }
        },
        commands: [{ engine: "codex" }, { engine: "claude-code" }]
      };
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
  const deleted = await service.delete(first.data.id);
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(deleted.success, true);
  assert.deepEqual(deleted.data.servers.map((record) => record.name), ["beta"]);
  assert.equal(deleted.data.servers[0].sync.codex.status, "noop");
  assert.equal(deleted.data.servers[0].sync.codex.message, "delete-refresh");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, "beta");
  assert.equal(stored[0].sync.codex.status, "noop");
  assert.equal(stored[0].sync.codex.message, "delete-refresh");
  assert.equal(second.success, true);
});

test("initialize restores bridge specs for cold-start getEngineSpecs", async (t) => {
  const { runtime, service } = setup(t);
  fs.mkdirSync(path.dirname(runtime.mcpServers), { recursive: true });
  fs.writeFileSync(runtime.mcpServers, JSON.stringify([{
    id: "mcp_header",
    name: "header-http",
    description: "",
    enabled: true,
    status: "unknown",
    tools: [],
    transport: {
      type: "http",
      url: "http://127.0.0.1:18060/mcp",
      headers: { Authorization: "Bearer real" }
    },
    sync: {},
    createdAt: 1,
    updatedAt: 1
  }], null, 2));

  const initialized = await service.initialize();
  const codexSpecs = service.getEngineSpecs("codex");
  const openClawServers = service.getEngineSpecs("openclaw", { supportsHttp: false, supportsSse: false });

  assert.equal(initialized.success, true);
  assert.equal(codexSpecs["mia-mcp-bridge"].command, "/usr/local/bin/node");
  assert.deepEqual(openClawServers.map((server) => server.name), ["mia-mcp-bridge"]);
});

test("getEngineSpecs triggers lazy initialization and initialize stays bounded when refresh hangs", async (t) => {
  let refreshCalls = 0;
  const { service } = setup(t, {
    manager: {
      testServer: async () => ({ success: true, status: "connected", tools: [], error: "" }),
      refresh: async () => {
        refreshCalls += 1;
        return new Promise(() => {});
      },
      toolManifest: () => [],
      callTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false })
    }
  });

  service.getEngineSpecs("codex");
  const startedAt = Date.now();
  const initialized = await service.initialize({ timeoutMs: 20 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(refreshCalls, 1);
  assert.equal(initialized.success, false);
  assert.match(initialized.error, /Timed out after 20ms waiting for MCP initialization/);
  assert.ok(elapsedMs < 250);
});
