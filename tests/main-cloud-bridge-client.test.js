const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createCloudBridgeClient } = require("../src/main/cloud/cloud-bridge-client.js");

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

function setup(overrides = {}) {
  const calls = { starts: [], stops: [], payloads: [] };
  let settings = {
    enabled: true,
    token: "tok_1",
    url: "https://cloud.example",
    user: { id: "u_1", username: "jung" }
  };
  const client = createCloudBridgeClient({
    getSettings: () => settings,
    isDaemonProcess: true,
    isDaemonEnabled: () => true,
    cloudBridgeStartPayload: () => {
      const payload = {
        deviceId: "device_1",
        deviceName: "Office Mac",
        engine: "codex",
        capabilities: { chat: true, cancellation: true, engines: ["codex"] }
      };
      calls.payloads.push(payload);
      return payload;
    },
    startCloudBridgeRequest: async (payload) => {
      calls.starts.push(payload);
      return {
        status: {
          enabled: true,
          connected: true,
          connecting: false,
          url: "https://cloud.example",
          user: settings.user,
          agentRuntime: null,
          deviceId: "device_1",
          lastError: "",
          logs: ["Mia Cloud Bridge connected."]
        }
      };
    },
    stopCloudBridgeRequest: async () => {
      calls.stops.push({});
      return {
        status: {
          enabled: true,
          connected: false,
          connecting: false,
          url: "https://cloud.example",
          user: settings.user,
          agentRuntime: null,
          deviceId: "",
          lastError: "",
          logs: ["Mia Cloud Bridge disconnected."]
        }
      };
    },
    ...overrides
  });
  return {
    client,
    calls,
    setSettings: (patch) => {
      settings = { ...settings, ...patch };
    }
  };
}

test("foreground bridge never starts Core bridge lifecycle", () => {
  const { client, calls } = setup({ isDaemonProcess: false, isDaemonEnabled: () => false });

  client.start();

  assert.equal(calls.starts.length, 0);
  assert.deepEqual(client.status(), {
    enabled: true,
    connected: false,
    connecting: false,
    url: "https://cloud.example",
    user: { id: "u_1", username: "jung" },
    agentRuntime: null,
    deviceId: "",
    lastError: "",
    logs: []
  });
});

test("start delegates device capability intent to Rust Core bridge lifecycle", async () => {
  const { client, calls } = setup();

  const immediate = client.start();
  assert.equal(immediate.connecting, true);
  assert.equal(immediate.connected, false);
  await flushAsync();

  assert.deepEqual(calls.starts, [{
    deviceId: "device_1",
    deviceName: "Office Mac",
    engine: "codex",
    capabilities: { chat: true, cancellation: true, engines: ["codex"] }
  }]);
  assert.equal(client.status().connected, true);
  assert.equal(client.status().deviceId, "device_1");
  assert.deepEqual(client.status().logs, ["Mia Cloud Bridge connected."]);
});

test("start does not open duplicate Core bridge lifecycle requests while pending", () => {
  let release;
  const { client, calls } = setup({
    startCloudBridgeRequest: async (payload) => {
      calls.starts.push(payload);
      await new Promise((resolve) => {
        release = resolve;
      });
      return { status: { connected: true, connecting: false, logs: [], deviceId: "device_1" } };
    }
  });

  client.start();
  client.start();

  assert.equal(calls.starts.length, 0);
  return Promise.resolve()
    .then(() => {
      assert.equal(calls.starts.length, 1);
      release();
    });
});

test("stop delegates to Rust Core and clears local cached connection state", async () => {
  const { client, calls } = setup();

  client.start();
  await flushAsync();
  assert.equal(client.status().connected, true);

  const stopped = client.stop();
  assert.equal(stopped.connected, false);
  assert.equal(stopped.deviceId, "");
  await flushAsync();

  assert.equal(calls.stops.length, 1);
  assert.equal(client.status().connected, false);
  assert.deepEqual(client.status().logs, ["Mia Cloud Bridge disconnected."]);
});

test("Core bridge lifecycle errors update status without local socket fallback", async () => {
  const { client, calls } = setup({
    startCloudBridgeRequest: async (payload) => {
      calls.starts.push(payload);
      throw new Error("Core bridge start failed");
    }
  });

  client.start();
  await flushAsync();

  assert.equal(calls.starts.length, 1);
  assert.equal(client.status().connected, false);
  assert.equal(client.status().connecting, false);
  assert.equal(client.status().lastError, "Core bridge start failed");
  assert.match(client.status().logs.join("\n"), /Core bridge start failed/);
});
