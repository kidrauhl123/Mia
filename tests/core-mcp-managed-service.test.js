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
  const { service, runtime } = setup(t, {
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
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));
  stored[0].lastError = "Xiaohongshu login command failed to start: spawn go ENOENT";
  fs.writeFileSync(runtime.mcpServers, `${JSON.stringify(stored, null, 2)}\n`);

  const started = await service.runManagedAction(installed.data.id, "start", {});

  assert.equal(started.success, true);
  assert.equal(started.data.managedRuntime.state, "running");
  assert.equal(started.data.connectionWizard.nextAction, "test");
  assert.equal(started.data.lastError, "");
  assert.deepEqual(actions, [["xiaohongshu", "start"]]);
});

test("public save cannot patch managedRuntime installDir for built-in managed records", async (t) => {
  const seen = [];
  const { service, runtime } = setup(t, {
    managedSupervisor: {
      runAction: async (record, action) => {
        seen.push(record.managedRuntime.installDir);
        return {
          ok: true,
          state: action,
          message: action,
          recordPatch: {
            managedRuntime: {
              ...record.managedRuntime,
              installDir: "/owned/xhs",
              state: action,
              lastAction: action
            }
          }
        };
      },
      ensureRunning: async (records) => ({ records, errors: [] })
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});

  const saved = await service.save({
    id: installed.data.id,
    name: installed.data.name,
    registryId: "xiaohongshu",
    managementMode: "managed",
    managedRuntime: {
      connectorId: "xiaohongshu",
      installDir: "/tmp/evil",
      endpoint: "http://127.0.0.1:18060/mcp",
      state: "installed"
    },
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }
  });
  const storedAfterSave = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));
  await service.runManagedAction(installed.data.id, "start", {});

  assert.equal(saved.success, true);
  assert.notEqual(storedAfterSave[0].managedRuntime.installDir, "/tmp/evil");
  assert.deepEqual(seen, [""]);
});

test("runManagedAction returns failure and persists managed error when supervisor action fails", async (t) => {
  const { service, runtime } = setup(t, {
    managedSupervisor: {
      runAction: async (record, action) => ({
        ok: false,
        state: "start_failed",
        message: "start failed TOKEN=secret-value",
        recordPatch: {
          managedRuntime: {
            ...record.managedRuntime,
            state: "start_failed",
            lastAction: action
          },
          connectionWizard: {
            state: "test_failed",
            nextAction: "test",
            message: "should be overridden"
          }
        }
      }),
      ensureRunning: async (records) => ({ records, errors: [] })
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});

  const started = await service.runManagedAction(installed.data.id, "start", {});
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(started.success, false);
  assert.equal(started.error, "start failed TOKEN=[redacted]");
  assert.equal(started.data.id, installed.data.id);
  assert.equal(started.data.managedRuntime.state, "start_failed");
  assert.equal(started.data.connectionWizard.state, "managed_error");
  assert.equal(started.data.connectionWizard.message, "start failed TOKEN=[redacted]");
  assert.equal(stored[0].enabled, false);
  assert.equal(stored[0].managedRuntime.state, "start_failed");
  assert.equal(stored[0].connectionWizard.state, "managed_error");
  assert.equal(stored[0].connectionWizard.nextAction, "start");
  assert.equal(stored[0].connectionWizard.message, "start failed TOKEN=[redacted]");
  assert.equal(stored[0].connectionWizard.actions.some((action) => action.id === "start"), true);
  assert.equal(stored[0].connectionWizard.actions.some((action) => action.id === "test"), true);
});

test("runManagedAction persists managed error when a non-test supervisor action throws", async (t) => {
  const { service, runtime } = setup(t, {
    managedSupervisor: {
      runAction: async (_record, action) => {
        if (action === "start") throw new Error("spawn failed TOKEN=secret-value");
        return { ok: true, state: action, message: action, recordPatch: {} };
      },
      ensureRunning: async (records) => ({ records, errors: [] })
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});

  const started = await service.runManagedAction(installed.data.id, "start", {});
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(started.success, false);
  assert.equal(started.error, "spawn failed TOKEN=[redacted]");
  assert.equal(started.data.id, installed.data.id);
  assert.equal(started.data.enabled, false);
  assert.equal(started.data.connectionWizard.state, "managed_error");
  assert.equal(started.data.connectionWizard.nextAction, "start");
  assert.equal(started.data.connectionWizard.message, "spawn failed TOKEN=[redacted]");
  assert.equal(started.data.managedRuntime.state, "error");
  assert.equal(started.data.lastError, "spawn failed TOKEN=[redacted]");
  assert.equal(stored[0].enabled, false);
  assert.equal(stored[0].connectionWizard.state, "managed_error");
  assert.equal(stored[0].connectionWizard.actions.some((action) => action.id === "start"), true);
  assert.equal(stored[0].connectionWizard.actions.some((action) => action.id === "test"), true);
  assert.equal(stored[0].managedRuntime.state, "error");
  assert.equal(stored[0].lastError, "spawn failed TOKEN=[redacted]");
});

test("runManagedAction repairs empty managed error actions on failure", async (t) => {
  const { service, runtime } = setup(t, {
    managedSupervisor: {
      runAction: async () => {
        throw new Error("spawn failed TOKEN=secret-value");
      },
      ensureRunning: async (records) => ({ records, errors: [] })
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});
  const storedBefore = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));
  storedBefore[0].connectionWizard = {
    state: "managed_error",
    nextAction: "start",
    message: "old failure",
    missingRequiredInputs: [],
    actions: []
  };
  fs.writeFileSync(runtime.mcpServers, `${JSON.stringify(storedBefore, null, 2)}\n`);

  const started = await service.runManagedAction(installed.data.id, "start", {});
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(started.success, false);
  assert.equal(stored[0].connectionWizard.state, "managed_error");
  assert.deepEqual(stored[0].connectionWizard.actions.map((action) => action.id), ["start", "test"]);
});

test("setEnabled blocks managed enable until a connected test already exists", async (t) => {
  const { service, runtime } = setup(t, {
    managedSupervisor: {
      ensureRunning: async (records) => ({ records, errors: [] })
    }
  });

  const installed = await service.installTemplate("xiaohongshu", {});
  const enabled = await service.setEnabled(installed.data.id, true);
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(enabled.success, false);
  assert.equal(enabled.data.id, installed.data.id);
  assert.equal(enabled.data.enabled, false);
  assert.equal(enabled.error, "连接检测未通过，暂时不能启用。");
  assert.equal(stored[0].enabled, false);
});

test("setEnabled blocks native built-ins until required inputs and connection test are complete", async (t) => {
  const { service, runtime } = setup(t);

  const missing = await service.installTemplate("github", {});
  const missingEnabled = await service.setEnabled(missing.data.id, true);

  assert.equal(missingEnabled.success, false);
  assert.equal(missingEnabled.data.enabled, false);
  assert.equal(missingEnabled.data.connectionWizard.state, "missing_required_inputs");
  assert.equal(missingEnabled.error, "请先完成这个 MCP 的必填配置。");

  const ready = await service.installTemplate("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" });
  let stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));
  stored[0].enabled = false;
  stored[0].status = "disconnected";
  stored[0].lastTestStatus = "disconnected";
  stored[0].connectionWizard = { state: "ready_to_test", nextAction: "test", message: "Retest required.", missingRequiredInputs: [], actions: [{ id: "test", label: "Test" }] };
  fs.writeFileSync(runtime.mcpServers, `${JSON.stringify(stored, null, 2)}\n`);

  const untested = await service.setEnabled(ready.data.id, true);
  stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(untested.success, false);
  assert.equal(untested.data.enabled, false);
  assert.equal(untested.data.connectionWizard.state, "ready_to_test");
  assert.equal(untested.error, "连接检测未通过，暂时不能启用。");
  assert.equal(stored[0].enabled, false);
});

test("setEnabled allows native built-ins when the last connection test passed despite stale wizard state", async (t) => {
  const { service, runtime } = setup(t);

  const ready = await service.installTemplate("playwright", {});
  let stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));
  stored[0].enabled = false;
  stored[0].status = "connected";
  stored[0].lastTestStatus = "connected";
  stored[0].lastTestCode = "ok";
  stored[0].connectionWizard = { state: "ready_to_test", nextAction: "test", message: "Old UI state.", missingRequiredInputs: [], actions: [{ id: "test", label: "Test" }] };
  fs.writeFileSync(runtime.mcpServers, `${JSON.stringify(stored, null, 2)}\n`);

  const enabled = await service.setEnabled(ready.data.id, true);
  stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(enabled.success, true);
  assert.equal(enabled.data.enabled, true);
  assert.equal(stored[0].enabled, true);
});

test("test updates native built-in connection wizard after a successful connection check", async (t) => {
  const { service, runtime } = setup(t);

  const ready = await service.installTemplate("playwright", {});
  let stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));
  stored[0].enabled = false;
  stored[0].status = "disconnected";
  stored[0].lastTestStatus = "disconnected";
  stored[0].connectionWizard = { state: "ready_to_test", nextAction: "test", message: "Old UI state.", missingRequiredInputs: [], actions: [{ id: "test", label: "Test" }] };
  fs.writeFileSync(runtime.mcpServers, `${JSON.stringify(stored, null, 2)}\n`);

  const tested = await service.test(ready.data.id);
  stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(tested.success, true);
  assert.equal(tested.data.status, "connected");
  assert.equal(tested.data.connectionWizard.state, "connected");
  assert.equal(stored[0].connectionWizard.state, "connected");
});

test("runManagedAction test enables xiaohongshu after successful MCP test", async (t) => {
  const calls = [];
  const { service } = setup(t, {
    managedSupervisor: {
      runAction: async (record, action) => {
        calls.push(["supervisor", action, record.nativeName]);
        return {
          ok: true,
          state: action === "start" ? "running" : "installed",
          message: action,
          recordPatch: { managedRuntime: { ...record.managedRuntime, state: "running", installDir: "/tmp/xhs", lastAction: action } }
        };
      },
      ensureRunning: async (records) => ({ records, errors: [] })
    },
    manager: {
      refresh: async () => ({ success: true, tools: [], errors: [] }),
      testServer: async (record) => {
        calls.push(["generic", record.nativeName, record.enabled]);
        return {
          ok: true,
          success: true,
          status: "connected",
          code: "ok",
          tools: [{ name: "search", inputSchema: {} }],
          error: ""
        };
      },
      toolManifest: () => []
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});
  await service.runManagedAction(installed.data.id, "start", {});

  const tested = await service.runManagedAction(installed.data.id, "test", {});

  assert.equal(tested.success, true);
  assert.equal(tested.data.enabled, true);
  assert.equal(tested.data.status, "connected");
  assert.equal(tested.data.connectionWizard.state, "connected");
  assert.deepEqual(calls, [
    ["supervisor", "start", "xiaohongshu"],
    ["supervisor", "test", "xiaohongshu"],
    ["generic", "xiaohongshu", false]
  ]);
});

test("runManagedAction test returns failure and skips generic test when supervisor returns ok false", async (t) => {
  const calls = [];
  const { service, runtime } = setup(t, {
    managedSupervisor: {
      runAction: async (record, action) => {
        calls.push(["supervisor", action, record.nativeName]);
        if (action === "test") {
          return {
            ok: false,
            state: "error",
            message: "endpoint unhealthy TOKEN=secret-value",
            recordPatch: {
              transport: { type: "http", url: "https://override.invalid/mcp" },
              managedRuntime: {
                ...record.managedRuntime,
                state: "error",
                exposure: { endpointUrl: "https://xhs.example/mcp" }
              },
              connectionWizard: {
                state: "test_failed",
                nextAction: "test",
                message: "should be overridden"
              }
            }
          };
        }
        return {
          ok: true,
          state: action,
          message: action,
          recordPatch: { managedRuntime: { ...record.managedRuntime, state: "running" } }
        };
      },
      ensureRunning: async (records) => ({ records, errors: [] })
    },
    manager: {
      refresh: async () => ({ success: true, tools: [], errors: [] }),
      testServer: async () => {
        calls.push(["generic"]);
        assert.fail("generic testServer should not run when supervisor test returns ok false");
      },
      toolManifest: () => []
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});

  const tested = await service.runManagedAction(installed.data.id, "test", { probe: true });
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(tested.success, false);
  assert.equal(tested.error, "endpoint unhealthy TOKEN=[redacted]");
  assert.equal(tested.data.enabled, false);
  assert.equal(tested.data.connectionWizard.state, "managed_error");
  assert.equal(tested.data.connectionWizard.nextAction, "test");
  assert.equal(tested.data.connectionWizard.message, "endpoint unhealthy TOKEN=[redacted]");
  assert.equal(tested.data.transport.url, installed.data.transport.url);
  assert.equal(tested.data.managedRuntime.state, "error");
  assert.equal(tested.data.lastError, "endpoint unhealthy TOKEN=[redacted]");
  assert.deepEqual(calls, [["supervisor", "test", "xiaohongshu"]]);
  assert.equal(stored[0].enabled, false);
  assert.equal(stored[0].connectionWizard.state, "managed_error");
  assert.equal(stored[0].transport.url, installed.data.transport.url);
});

test("runManagedAction test returns failure and skips generic test when supervisor throws", async (t) => {
  const calls = [];
  const { service, runtime } = setup(t, {
    managedSupervisor: {
      runAction: async (record, action) => {
        calls.push(["supervisor", action, record.nativeName]);
        if (action === "test") {
          throw new Error("supervisor boom TOKEN=secret-value");
        }
        return {
          ok: true,
          state: action,
          message: action,
          recordPatch: { managedRuntime: { ...record.managedRuntime, state: "running" } }
        };
      },
      ensureRunning: async (records) => ({ records, errors: [] })
    },
    manager: {
      refresh: async () => ({ success: true, tools: [], errors: [] }),
      testServer: async () => {
        calls.push(["generic"]);
        assert.fail("generic testServer should not run when supervisor test throws");
      },
      toolManifest: () => []
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});

  const tested = await service.runManagedAction(installed.data.id, "test", {});
  const stored = JSON.parse(fs.readFileSync(runtime.mcpServers, "utf8"));

  assert.equal(tested.success, false);
  assert.equal(tested.error, "supervisor boom TOKEN=[redacted]");
  assert.equal(tested.data.enabled, false);
  assert.equal(tested.data.connectionWizard.state, "managed_error");
  assert.equal(tested.data.connectionWizard.nextAction, "test");
  assert.equal(tested.data.connectionWizard.message, "supervisor boom TOKEN=[redacted]");
  assert.equal(tested.data.transport.url, installed.data.transport.url);
  assert.equal(tested.data.lastError, "supervisor boom TOKEN=[redacted]");
  assert.deepEqual(calls, [["supervisor", "test", "xiaohongshu"]]);
  assert.equal(stored[0].enabled, false);
  assert.equal(stored[0].connectionWizard.state, "managed_error");
  assert.equal(stored[0].transport.url, installed.data.transport.url);
});

test("runManagedAction test failure points xiaohongshu back to start when endpoint is down", async (t) => {
  const { service } = setup(t, {
    managedSupervisor: {
      runAction: async (_record, action) => {
        if (action === "test") {
          throw new Error("Xiaohongshu endpoint health check failed for http://127.0.0.1:18060/mcp. fetch failed");
        }
        return {
          ok: true,
          state: action,
          message: action,
          recordPatch: {}
        };
      },
      ensureRunning: async (records) => ({ records, errors: [] })
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});

  const tested = await service.runManagedAction(installed.data.id, "test", {});

  assert.equal(tested.success, false);
  assert.equal(tested.data.connectionWizard.state, "managed_error");
  assert.equal(tested.data.connectionWizard.nextAction, "start");
  assert.deepEqual(tested.data.connectionWizard.actions.map((action) => action.id), ["start", "test"]);
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
  const listed = await service.list();

  assert.equal(calls.some((call) => call[0] === "ensureRunning"), true);
  assert.equal(calls.some((call) => call[0] === "refresh" && call[1].includes("xiaohongshu:running")), true);
  assert.equal(listed.data.servers[0].managedRuntime.state, "running");
});

test("refreshBridge persists managed error patches returned by ensureRunning", async (t) => {
  const { service } = setup(t, {
    managedSupervisor: {
      runAction: async (record, action) => ({
        ok: true,
        state: "running",
        message: action,
        recordPatch: { managedRuntime: { ...record.managedRuntime, state: "running" } }
      }),
      ensureRunning: async (records) => ({
        records: records.map((record) => ({
          ...record,
          managedRuntime: { ...record.managedRuntime, state: "error" },
          connectionWizard: {
            ...record.connectionWizard,
            state: "managed_error",
            nextAction: "start",
            message: "ensure failed API_KEY=shh"
          }
        })),
        errors: []
      })
    }
  });
  const installed = await service.installTemplate("xiaohongshu", {});
  await service.runManagedAction(installed.data.id, "test", {});

  const refreshed = await service.refreshBridge();
  const listed = await service.list();

  assert.equal(refreshed.success, true);
  assert.equal(listed.data.servers[0].managedRuntime.state, "error");
  assert.equal(listed.data.servers[0].connectionWizard.state, "managed_error");
  assert.equal(listed.data.servers[0].connectionWizard.message, "ensure failed API_KEY=[redacted]");
});

test("refreshBridge excludes ensureRunning failures from same-cycle manager refresh", async (t) => {
  const refreshCalls = [];
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
          if (record.nativeName === "xiaohongshu") {
            return {
              ...record,
              managedRuntime: { ...record.managedRuntime, state: "error" },
              connectionWizard: {
                ...record.connectionWizard,
                state: "managed_error",
                nextAction: "start",
                message: "xiaohongshu startup failed"
              }
            };
          }
          return {
            ...record,
            managedRuntime: { ...record.managedRuntime, state: "running" }
          };
        }),
        errors: [{ id: "mcp_xiaohongshu", name: "xiaohongshu", message: "startup failed" }]
      })
    },
    manager: {
      refresh: async (records) => {
        refreshCalls.push(records.map((record) => record.nativeName));
        return { success: true, tools: [], errors: [] };
      },
      testServer: async () => ({ ok: true, success: true, status: "connected", code: "ok", tools: [{ name: "search", inputSchema: {} }] }),
      toolManifest: () => []
    }
  });

  const installed = await service.installTemplate("xiaohongshu", {});
  await service.installTemplate("playwright", {});
  await service.runManagedAction(installed.data.id, "test", {});
  refreshCalls.length = 0;

  const refreshed = await service.refreshBridge();
  const listed = await service.list();
  const failed = listed.data.servers.find((record) => record.nativeName === "xiaohongshu");
  const healthy = listed.data.servers.find((record) => record.nativeName === "playwright");

  assert.equal(refreshed.success, true);
  assert.deepEqual(refreshCalls, [["playwright"]]);
  assert.equal(failed.connectionWizard.state, "managed_error");
  assert.equal(failed.connectionWizard.message, "xiaohongshu startup failed");
  assert.equal(failed.enabled, true);
  assert.equal(healthy.enabled, true);
  assert.notEqual(healthy.connectionWizard.state, "managed_error");
});

test("refreshBridge returns sanitized error and persists managed_error when ensureRunning throws", async (t) => {
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
      ensureRunning: async () => {
        throw new Error("ensure failed TOKEN=secret-value");
      }
    },
    manager: {
      refresh: async () => {
        assert.fail("manager.refresh should not run after ensureRunning throws");
      },
      testServer: async () => ({ ok: true, success: true, status: "connected", code: "ok", tools: [{ name: "search", inputSchema: {} }] }),
      toolManifest: () => []
    }
  });

  const installed = await service.installTemplate("xiaohongshu", {});
  await service.runManagedAction(installed.data.id, "test", {});

  const refreshed = await service.refreshBridge();
  const listed = await service.list();

  assert.equal(refreshed.success, true);
  assert.equal(refreshed.data.errors.length, 1);
  assert.equal(refreshed.data.errors[0].message, "ensure failed TOKEN=[redacted]");
  assert.equal(listed.data.servers[0].managedRuntime.state, "error");
  assert.equal(listed.data.servers[0].connectionWizard.state, "managed_error");
  assert.equal(listed.data.servers[0].connectionWizard.message, "ensure failed TOKEN=[redacted]");
  assert.equal(listed.data.servers[0].lastError, "ensure failed TOKEN=[redacted]");
});
