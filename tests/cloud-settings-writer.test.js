const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createCloudSettingsWriter } = require("../src/main/cloud/cloud-settings-writer.js");

function setup(overrides = {}) {
  const calls = { local: [], core: [] };
  const writer = createCloudSettingsWriter({
    writeLocal: (patch) => {
      calls.local.push(patch);
      return {
        url: "https://mia.example",
        enabled: Boolean(patch.enabled),
        token: patch.token || "",
        user: patch.user || null,
        agentRuntime: patch.agentRuntime || null,
        lastEventSeq: Number(patch.lastEventSeq) || 0,
        lastMemorySyncAt: String(patch.lastMemorySyncAt || ""),
        written: "local"
      };
    },
    syncCore: async (settings) => {
      calls.core.push(settings);
      return { status: { enabled: settings.enabled } };
    },
    ...overrides
  });
  return { writer, calls };
}

test("writes the local UI mirror and syncs the merged cloud settings to Rust Core", async () => {
  const { writer, calls } = setup();

  const result = await writer.write({ token: "tok_new", enabled: true });

  assert.equal(result.written, "local");
  assert.equal(calls.local.length, 1);
  assert.equal(calls.core.length, 1);
  assert.equal(calls.core[0].token, "tok_new");
  assert.equal(calls.core[0].enabled, true);
});

test("cursor-only writes still sync the full local mirror to Rust Core", async () => {
  const { writer, calls } = setup();

  await writer.write({ lastEventSeq: 12 });

  assert.equal(calls.local.length, 1);
  assert.equal(calls.core.length, 1);
  assert.equal(calls.core[0].lastEventSeq, 12);
  assert.equal(calls.core[0].token, "");
});

test("unchanged cloud settings writes do not resync Rust Core", async () => {
  const calls = { local: [], core: [] };
  let current = {
    url: "https://mia.example",
    enabled: true,
    token: "tok_alive",
    user: { id: "u1" },
    agentRuntime: { engine: "codex" },
    lastEventSeq: 5,
    lastMemorySyncAt: "2026-07-01T00:00:00.000Z"
  };
  const writer = createCloudSettingsWriter({
    writeLocal: (patch) => {
      calls.local.push(patch);
      current = { ...current, ...patch };
      return current;
    },
    syncCore: async (settings) => {
      calls.core.push(settings);
      return { status: { enabled: settings.enabled } };
    }
  });

  await writer.write({ agentRuntime: { engine: "codex" } });
  await writer.write({ agentRuntime: { engine: "codex" } });

  assert.equal(calls.local.length, 2);
  assert.equal(calls.core.length, 1);
});

test("concurrent identical cloud settings writes share one Rust Core sync", async () => {
  const calls = { local: [], core: [] };
  let releaseSync;
  let current = {
    url: "https://mia.example",
    enabled: true,
    token: "tok_alive",
    user: { id: "u1" },
    agentRuntime: { engine: "codex" },
    lastEventSeq: 5,
    lastMemorySyncAt: ""
  };
  const writer = createCloudSettingsWriter({
    writeLocal: (patch) => {
      calls.local.push(patch);
      current = { ...current, ...patch };
      return current;
    },
    syncCore: async (settings) => {
      calls.core.push(settings);
      await new Promise((resolve) => { releaseSync = resolve; });
      return { status: { enabled: settings.enabled } };
    }
  });

  const first = writer.write({ user: { id: "u1" } });
  const second = writer.write({ user: { id: "u1" } });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(calls.local.length, 2);
  assert.equal(calls.core.length, 1);
  releaseSync();
  await Promise.all([first, second]);
});

test("Rust Core sync failures surface to the caller", async () => {
  const { writer, calls } = setup({
    syncCore: async () => { throw new Error("ECONNREFUSED"); }
  });

  await assert.rejects(
    () => writer.write({ enabled: false, token: "", user: null }),
    /Rust Core unavailable/i
  );
  assert.equal(calls.local.length, 1);
  assert.equal(calls.core.length, 0);
});

test("requires a Rust Core sync dependency", () => {
  assert.throws(
    () => createCloudSettingsWriter({ writeLocal: () => ({}) }),
    /syncCore dependency is required/
  );
});

test("requires a local mirror writer dependency", () => {
  assert.throws(
    () => createCloudSettingsWriter({ syncCore: async () => {} }),
    /writeLocal dependency is required/
  );
});
