const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createCloudEventsClient } = require("../src/main/cloud/cloud-events-client.js");

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

function setup(overrides = {}) {
  const calls = {
    starts: [],
    stops: [],
    logs: []
  };
  let settings = {
    enabled: true,
    token: "tok_1",
    url: "https://cloud.example",
    lastEventSeq: 3
  };
  const client = createCloudEventsClient({
    getSettings: () => settings,
    appendCloudLog: (line) => calls.logs.push(line),
    startCloudEventsRequest: async (payload) => {
      calls.starts.push(payload);
      return {
        status: {
          enabled: true,
          events: {
            enabled: true,
            connecting: false,
            connected: true,
            lastError: "",
            lastEventSeq: 8
          }
        }
      };
    },
    stopCloudEventsRequest: async () => {
      calls.stops.push({});
      return {
        status: {
          enabled: true,
          events: {
            enabled: true,
            connecting: false,
            connected: false,
            lastError: "",
            lastEventSeq: 8
          }
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

test("start delegates Cloud Events lifecycle to Rust Core", async () => {
  const { client, calls } = setup();

  const immediate = client.start();
  assert.equal(immediate.connecting, true);
  assert.equal(immediate.connected, false);
  await flushAsync();

  assert.deepEqual(calls.starts, [{}]);
  assert.deepEqual(client.status(), {
    enabled: true,
    connecting: false,
    connected: true,
    lastError: "",
    lastEventSeq: 8
  });
});

test("start does not open duplicate Core lifecycle requests while pending", async () => {
  let release;
  const { client, calls } = setup({
    startCloudEventsRequest: async (payload) => {
      calls.starts.push(payload);
      await new Promise((resolve) => {
        release = resolve;
      });
      return { status: { events: { connected: true, connecting: false, lastEventSeq: 4 } } };
    }
  });

  client.start();
  client.start();
  await Promise.resolve();

  assert.equal(calls.starts.length, 1);
  release();
  await flushAsync();
  assert.equal(client.status().connected, true);
});

test("stop delegates Cloud Events lifecycle to Rust Core and clears cached state", async () => {
  const { client, calls } = setup();

  client.start();
  await flushAsync();
  assert.equal(client.status().connected, true);

  const stopped = client.stop();
  assert.equal(stopped.connected, false);
  await flushAsync();

  assert.equal(calls.stops.length, 1);
  assert.deepEqual(client.status(), {
    enabled: true,
    connecting: false,
    connected: false,
    lastError: "",
    lastEventSeq: 8
  });
});

test("disabled settings do not send lifecycle requests", () => {
  const { client, calls, setSettings } = setup();
  setSettings({ enabled: false });

  assert.deepEqual(client.start(), {
    enabled: false,
    connecting: false,
    connected: false,
    lastError: "",
    lastEventSeq: 3
  });
  assert.equal(calls.starts.length, 0);
});

test("Core lifecycle errors update local status without a socket fallback", async () => {
  const { client, calls } = setup({
    startCloudEventsRequest: async (payload) => {
      calls.starts.push(payload);
      throw new Error("Core events start failed");
    }
  });

  client.start();
  await flushAsync();

  assert.equal(calls.starts.length, 1);
  assert.equal(client.status().connected, false);
  assert.equal(client.status().connecting, false);
  assert.equal(client.status().lastError, "Core events start failed");
  assert.match(calls.logs.join("\n"), /Core events start failed/);
});
