const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createAgentPermissionProxy } = require("../src/main/agent-permission-proxy.js");

test("permission response uses Rust Core control path", async () => {
  const coreControlCalls = [];
  const proxy = createAgentPermissionProxy({
    coreControlClient: {
      call: async (path, options) => {
        coreControlCalls.push({ path, options });
        return { ok: true };
      }
    }
  });

  const result = await proxy.respond({ requestId: "perm_1", decision: "allow_once" });

  assert.deepEqual(result, { ok: true });
  assert.equal(coreControlCalls.length, 1);
  assert.equal(coreControlCalls[0].path, "/api/agent-permissions/respond");
  assert.equal(coreControlCalls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(coreControlCalls[0].options.body), { requestId: "perm_1", decision: "allow_once" });
});

test("permission list uses Rust Core control path", async () => {
  const proxy = createAgentPermissionProxy({
    coreControlClient: {
      call: async (path) => {
        assert.equal(path, "/api/agent-permissions?sessionId=s1");
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
});
