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
