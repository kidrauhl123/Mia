const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createAgentPermissionProxy } = require("../src/main/agent-permission-proxy.js");

test("foreground permission response is daemon-only and never resolves local coordinator state", async () => {
  const daemonCalls = [];
  let localResolveCalls = 0;
  const proxy = createAgentPermissionProxy({
    isDaemonProcess: false,
    coordinator: {
      resolvePermission: () => {
        localResolveCalls += 1;
        return { ok: true };
      },
      listPending: () => []
    },
    daemonClient: {
      call: async (path, options) => {
        daemonCalls.push({ path, options });
        return { ok: true };
      }
    }
  });

  const result = await proxy.respond({ requestId: "perm_1", decision: "allow_once" });

  assert.deepEqual(result, { ok: true });
  assert.equal(localResolveCalls, 0);
  assert.equal(daemonCalls.length, 1);
  assert.equal(daemonCalls[0].path, "/api/chat/permissions/respond");
  assert.equal(daemonCalls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(daemonCalls[0].options.body), { requestId: "perm_1", decision: "allow_once" });
});

test("daemon permission response resolves the daemon coordinator directly", async () => {
  let localResolveCalls = 0;
  const proxy = createAgentPermissionProxy({
    isDaemonProcess: true,
    coordinator: {
      resolvePermission: (payload) => {
        localResolveCalls += 1;
        assert.deepEqual(payload, { requestId: "perm_1", decision: "deny" });
        return { ok: true };
      },
      listPending: () => []
    },
    daemonClient: {
      call: async () => {
        throw new Error("local owner should not call daemon");
      }
    }
  });

  assert.deepEqual(await proxy.respond({ requestId: "perm_1", decision: "deny" }), { ok: true });
  assert.equal(localResolveCalls, 1);
});

test("foreground permission list is daemon-only and never reads local coordinator state", async () => {
  let localListCalls = 0;
  const proxy = createAgentPermissionProxy({
    isDaemonProcess: false,
    coordinator: {
      resolvePermission: () => ({ ok: false, error: "permission request not found" }),
      listPending: () => {
        localListCalls += 1;
        return [{ requestId: "local_1", sessionId: "s1" }];
      }
    },
    daemonClient: {
      call: async (path) => {
        assert.equal(path, "/api/chat/permissions?sessionId=s1");
        return {
          requests: [
            { requestId: "daemon_1", sessionId: "s1" }
          ]
        };
      }
    }
  });

  assert.deepEqual(await proxy.list({ sessionId: "s1" }), [
    { requestId: "daemon_1", sessionId: "s1" }
  ]);
  assert.equal(localListCalls, 0);
});
