const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createCloudSettingsWriter } = require("../src/main/cloud/cloud-settings-writer.js");

function setup(overrides = {}) {
  const calls = { local: [], remote: [] };
  const writer = createCloudSettingsWriter({
    isDaemonProcess: false,
    isDaemonEnabled: () => true,
    writeLocal: (patch) => {
      calls.local.push(patch);
      return { ...patch, written: "local" };
    },
    daemonBaseUrl: () => "http://127.0.0.1:27861",
    daemonToken: () => "secret-token",
    fetchImpl: async (url, options) => {
      calls.remote.push({ url, options });
      return {
        ok: true,
        json: async () => ({ settings: { written: "daemon" } })
      };
    },
    ...overrides
  });
  return { writer, calls };
}

test("window delegates writes to the daemon while it is enabled", async () => {
  const { writer, calls } = setup();

  const result = await writer.write({ token: "tok_new", enabled: true });

  assert.equal(result.written, "daemon");
  assert.equal(calls.local.length, 0);
  assert.equal(calls.remote.length, 1);
  assert.match(calls.remote[0].url, /\/api\/cloud-settings$/);
  assert.equal(JSON.parse(calls.remote[0].options.body).patch.token, "tok_new");
  assert.equal(calls.remote[0].options.headers.Authorization, "Bearer secret-token");
});

test("daemon process and daemon-off window write locally", async () => {
  const daemon = setup({ isDaemonProcess: true });
  await daemon.writer.write({ lastEventSeq: 5 });
  assert.equal(daemon.calls.local.length, 1);
  assert.equal(daemon.calls.remote.length, 0);

  const windowOwner = setup({ isDaemonEnabled: () => false });
  await windowOwner.writer.write({ lastEventSeq: 6 });
  assert.equal(windowOwner.calls.local.length, 1);
  assert.equal(windowOwner.calls.remote.length, 0);
});

test("dead daemon falls back to a local write", async () => {
  const { writer, calls } = setup({
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); }
  });

  const result = await writer.write({ enabled: false, token: "", user: null });

  assert.equal(result.written, "local");
  assert.equal(calls.local.length, 1);
});

test("version skew (404/501) keeps the window as the writer", async () => {
  const { writer, calls } = setup({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) })
  });

  const result = await writer.write({ user: { id: "u1" } });

  assert.equal(result.written, "local");
  assert.equal(calls.local.length, 1);
});

test("a live daemon erroring (5xx) throws instead of splitting the writer", async () => {
  const { writer, calls } = setup({
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) })
  });

  await assert.rejects(() => writer.write({ user: { id: "u1" } }), /HTTP 500/);
  assert.equal(calls.local.length, 0);
});
