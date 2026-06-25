const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createCoreMcpService } = require("../src/core/mcp/service.js");

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-managed-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = { mcpServers: path.join(dir, "mia-mcp-servers.json"), runtime: dir };
  const manager = overrides.manager || {
    refresh: async () => ({ success: true, tools: [], errors: [] }),
    testServer: async (record) => ({
      ok: true,
      success: true,
      status: "connected",
      code: "ok",
      tools: [{ name: `${record.nativeName}_tool`, inputSchema: {} }],
      error: ""
    }),
    toolManifest: () => []
  };
  return {
    service: createCoreMcpService({
      runtimePaths: () => runtime,
      fs,
      manager,
      bridge: overrides.bridge || {
        start: async () => ({
          callbackUrl: "http://127.0.0.1:3333/mcp/execute",
          manifestUrl: "http://127.0.0.1:3333/mcp/manifest",
          secret: "sec"
        })
      },
      nativeSync: overrides.nativeSync || (async () => ({ success: true, statuses: {}, commands: [] })),
      managedSupervisor: overrides.managedSupervisor,
      now: () => 1710000000000,
      idFactory: (name) => `mcp_${String(name).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}`
    }),
    runtime
  };
}

test("native template with no required fields tests and enables", async (t) => {
  const calls = [];
  const { service, runtime } = setup(t, {
    manager: {
      refresh: async (records) => {
        calls.push(["refresh", records.map((record) => record.nativeName)]);
        return { success: true, tools: [], errors: [] };
      },
      testServer: async (record) => {
        calls.push(["test", record.nativeName, record.enabled]);
        return {
          ok: true,
          success: true,
          status: "connected",
          code: "ok",
          tools: [{ name: "browser_open", inputSchema: {} }],
          error: ""
        };
      },
      toolManifest: () => []
    }
  });

  const installed = await service.installTemplate("playwright", {});
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(installed.success, true);
  assert.equal(installed.data.enabled, true);
  assert.equal(installed.data.status, "connected");
  assert.equal(installed.data.managementMode, "native");
  assert.equal(installed.data.transport.command, "npx");
  assert.deepEqual(calls.find((call) => call[0] === "test"), ["test", "playwright", false]);
  assert.equal(stored[0].enabled, true);
});

test("native template requiring a secret saves disabled until field is supplied", async (t) => {
  const { service, runtime } = setup(t);

  const missing = await service.installTemplate("github", {});
  const storedMissing = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(missing.success, true);
  assert.equal(missing.data.enabled, false);
  assert.equal(missing.data.connectionWizard.state, "missing_required_inputs");
  assert.deepEqual(missing.data.connectionWizard.missingRequiredInputs, ["GITHUB_PERSONAL_ACCESS_TOKEN"]);
  assert.equal(storedMissing[0].enabled, false);

  const ready = await service.installTemplate("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" });
  const storedReady = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(ready.success, true);
  assert.equal(ready.data.enabled, true);
  assert.equal(ready.data.transport.env.GITHUB_PERSONAL_ACCESS_TOKEN, "••••••••");
  assert.equal(storedReady[0].transport.env.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_secret");
});

test("native template stays disabled when connection test fails", async (t) => {
  const { service } = setup(t, {
    manager: {
      refresh: async () => ({ success: true, tools: [], errors: [] }),
      testServer: async () => ({
        ok: false,
        success: false,
        status: "disconnected",
        code: "spawn_failed",
        error: "npx failed",
        tools: []
      }),
      toolManifest: () => []
    }
  });

  const result = await service.installTemplate("context7", {});

  assert.equal(result.success, true);
  assert.equal(result.data.enabled, false);
  assert.equal(result.data.status, "disconnected");
  assert.equal(result.data.connectionWizard.state, "test_failed");
  assert.equal(result.data.lastTestCode, "spawn_failed");
});

test("managed xiaohongshu install creates disabled record with managed actions", async (t) => {
  const { service } = setup(t, {
    managedSupervisor: {
      runAction: async () => ({ ok: true, state: "installed", message: "installed", recordPatch: { managedRuntime: { state: "installed", installDir: "/tmp/xhs" } } }),
      ensureRunning: async (records) => ({ records, errors: [] })
    }
  });

  const installed = await service.installTemplate("xiaohongshu", {});

  assert.equal(installed.success, true);
  assert.equal(installed.data.enabled, false);
  assert.equal(installed.data.managementMode, "managed");
  assert.equal(installed.data.managedRuntime.connectorId, "xiaohongshu");
  assert.equal(installed.data.connectionWizard.nextAction, "install");
});

test("runManagedAction updates xiaohongshu runtime state", async (t) => {
  const actions = [];
  const { service } = setup(t, {
    managedSupervisor: {
      runAction: async (record, action) => {
        actions.push([record.nativeName, action]);
        return {
          ok: true,
          state: action === "start" ? "running" : "installed",
          message: action,
          recordPatch: {
            managedRuntime: {
              ...record.managedRuntime,
              state: action === "start" ? "running" : "installed",
              installDir: "/tmp/xhs",
              lastAction: action
            }
          }
        };
      },
      ensureRunning: async (records) => ({ records, errors: [] })
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});

  const started = await service.runManagedAction(installed.data.id, "start", {});

  assert.equal(started.success, true);
  assert.equal(started.data.managedRuntime.state, "running");
  assert.equal(started.data.connectionWizard.nextAction, "test");
  assert.deepEqual(actions, [["xiaohongshu", "start"]]);
});

test("runManagedAction test enables xiaohongshu after successful MCP test", async (t) => {
  const { service } = setup(t, {
    managedSupervisor: {
      runAction: async (record, action) => ({
        ok: true,
        state: action === "start" ? "running" : "installed",
        message: action,
        recordPatch: { managedRuntime: { ...record.managedRuntime, state: "running", installDir: "/tmp/xhs", lastAction: action } }
      }),
      ensureRunning: async (records) => ({ records, errors: [] })
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});
  await service.runManagedAction(installed.data.id, "start", {});

  const tested = await service.runManagedAction(installed.data.id, "test", {});

  assert.equal(tested.success, true);
  assert.equal(tested.data.enabled, true);
  assert.equal(tested.data.status, "connected");
  assert.equal(tested.data.connectionWizard.state, "connected");
});

test("refreshBridge starts enabled managed records before manager refresh", async (t) => {
  const calls = [];
  const { service } = setup(t, {
    managedSupervisor: {
      runAction: async (record, action) => ({ ok: true, state: action, message: action, recordPatch: { managedRuntime: { ...record.managedRuntime, state: action } } }),
      ensureRunning: async (records) => {
        calls.push(["ensureRunning", records.map((record) => record.nativeName)]);
        return { records: records.map((record) => ({ ...record, managedRuntime: { ...record.managedRuntime, state: "running" } })), errors: [] };
      }
    },
    manager: {
      refresh: async (records) => {
        calls.push(["refresh", records.map((record) => `${record.nativeName}:${record.managedRuntime?.state || ""}`)]);
        return { success: true, tools: [], errors: [] };
      },
      testServer: async () => ({ ok: true, success: true, status: "connected", code: "ok", tools: [{ name: "search", inputSchema: {} }] }),
      toolManifest: () => []
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});
  await service.runManagedAction(installed.data.id, "test", {});
  await service.refreshBridge();

  assert.equal(calls.some((call) => call[0] === "ensureRunning"), true);
  assert.equal(calls.some((call) => call[0] === "refresh" && call[1].includes("xiaohongshu:running")), true);
});
