const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createAgentPermissionCoordinator,
  formatPermissionTitle
} = require("../src/main/agent-permission-coordinator.js");

function tempRuntime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-perms-"));
  return {
    dir,
    runtimePaths: () => ({
      home: dir,
      agentPermissionRules: path.join(dir, "mia-agent-permissions.json")
    })
  };
}

test("permission coordinator emits pending request and persists always-allow rules", async () => {
  const { runtimePaths } = tempRuntime();
  const emitted = [];
  const coordinator = createAgentPermissionCoordinator({
    runtimePaths,
    timeoutMs: 0,
    randomUUID: () => "req_1",
    now: () => "2026-05-27T00:00:00.000Z"
  });

  const pending = coordinator.requestPermission({
    engine: "claude-code",
    fellowKey: "mia",
    sessionId: "s1",
    toolName: "Bash",
    input: { command: "npm test" },
    emit: (kind, data) => emitted.push({ kind, data })
  });

  assert.equal(emitted[0].kind, "permission_request");
  assert.equal(emitted[0].data.requestId, "perm_req_1");
  assert.equal(emitted[0].data.preview, "npm test");
  assert.deepEqual(coordinator.resolvePermission({ requestId: "perm_req_1", decision: "allow_always" }), { ok: true });
  const decision = await pending;
  assert.equal(decision.decision, "allow");
  assert.equal(decision.scope, "always");

  const remembered = await coordinator.requestPermission({
    engine: "claude-code",
    toolName: "Bash",
    input: { command: "npm test" },
    emit: () => assert.fail("remembered permission should not emit a new request")
  });
  assert.equal(remembered.decision, "allow");
  assert.equal(remembered.remembered, true);
});

test("permission coordinator denies when no approval UI is available", async () => {
  const { runtimePaths } = tempRuntime();
  const coordinator = createAgentPermissionCoordinator({ runtimePaths, timeoutMs: 0 });

  const decision = await coordinator.requestPermission({
    engine: "codex",
    toolName: "shell",
    input: { command: "rm -rf out" }
  });

  assert.equal(decision.decision, "deny");
  assert.match(decision.message, /审批界面/);
});

test("permission title keeps user-added MCP tool names visible", () => {
  assert.match(
    formatPermissionTitle({ engine: "codex", toolName: "xhs.search_notes" }),
    /xhs\.search_notes/
  );
});
