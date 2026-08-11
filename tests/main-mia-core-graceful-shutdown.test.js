const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  WECHAT_RELAY_SHUTDOWN_PATH,
  createWechatRelayShutdown
} = require("../src/main/mia-core/graceful-shutdown.js");

test("Core shutdown asks the local WeChat relay to stop before Core exits", async () => {
  const calls = [];
  const shutdown = createWechatRelayShutdown({
    ping: async () => ({ ok: true, baseUrl: "http://127.0.0.1:27861/" }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 204 };
    },
    timeoutSignal: () => "shutdown-signal"
  });

  const result = await shutdown.prepareForCoreStop({ settings: {}, runtimeHome: "/tmp/mia" });
  assert.deepEqual(result, { attempted: true, ok: true });
  assert.deepEqual(calls, [{
    url: `http://127.0.0.1:27861${WECHAT_RELAY_SHUTDOWN_PATH}`,
    options: {
      method: "POST",
      headers: { accept: "application/json" },
      signal: "shutdown-signal"
    }
  }]);
});

test("Core shutdown does not wait for a relay when Core is unavailable", async () => {
  let fetched = false;
  const shutdown = createWechatRelayShutdown({
    ping: async () => ({ ok: false }),
    fetchImpl: async () => {
      fetched = true;
      return { ok: true };
    }
  });

  assert.deepEqual(await shutdown.prepareForCoreStop(), { attempted: false });
  assert.equal(fetched, false);
});

test("a relay-stop failure never prevents Core shutdown", async () => {
  const logs = [];
  const shutdown = createWechatRelayShutdown({
    ping: async () => ({ ok: true, baseUrl: "http://127.0.0.1:27861" }),
    fetchImpl: async () => { throw new Error("unreachable"); },
    appendLog: (line) => logs.push(line)
  });

  assert.deepEqual(await shutdown.prepareForCoreStop(), { attempted: true, ok: false });
  assert.deepEqual(logs, ["WeChat relay graceful stop did not complete before Core exit."]);
});
