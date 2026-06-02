const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  codexConfigOverridesForMcpServers,
  codexDecisionFor,
  createCodexAppServerConnection,
  isCodexApprovalRequest,
  toolPayloadFromCodexItem
} = require("../src/main/codex-app-server-runner.js");

test("codexDecisionFor maps Mia decisions to app-server approval responses", () => {
  assert.deepEqual(codexDecisionFor("item/commandExecution/requestApproval", { decision: "allow", scope: "once" }), {
    decision: "accept"
  });
  assert.deepEqual(codexDecisionFor("item/commandExecution/requestApproval", { decision: "allow", scope: "always" }), {
    decision: "acceptForSession"
  });
  assert.deepEqual(codexDecisionFor("item/fileChange/requestApproval", { decision: "deny" }), {
    decision: "decline"
  });
  assert.deepEqual(codexDecisionFor("execCommandApproval", { decision: "allow", scope: "always" }), {
    decision: "approved_for_session"
  });
  assert.deepEqual(codexDecisionFor("mcpServer/elicitation/request", { decision: "allow", scope: "once" }), {
    action: "accept",
    content: {}
  });
  assert.deepEqual(codexDecisionFor("mcpServer/elicitation/request", { decision: "deny" }), {
    action: "decline"
  });
});

test("toolPayloadFromCodexItem normalizes command and file-change items", () => {
  assert.deepEqual(toolPayloadFromCodexItem({
    type: "commandExecution",
    id: "cmd_1",
    command: "npm test",
    status: "completed",
    durationMs: 1250
  }), {
    id: "cmd_1",
    name: "shell",
    preview: "npm test",
    status: "completed",
    duration: 1.25,
    error: false
  });
  assert.deepEqual(toolPayloadFromCodexItem({
    type: "fileChange",
    id: "patch_1",
    changes: [{ kind: "update", path: "src/app.js" }],
    status: "completed"
  }), {
    id: "patch_1",
    name: "apply_patch",
    preview: "update src/app.js",
    status: "completed",
    duration: null,
    error: false
  });
});

test("codexConfigOverridesForMcpServers converts Mia scheduler MCP spec to CLI config overrides", () => {
  const overrides = codexConfigOverridesForMcpServers({
    "mia-scheduler": {
      type: "stdio",
      command: "/opt/node",
      args: ["/tmp/server.js"],
      env: {
        MIA_DAEMON_URL: "http://127.0.0.1:27861",
        MIA_DAEMON_TOKEN: "token"
      },
      alwaysLoad: true
    }
  });

  assert.deepEqual(overrides, [
    'mcp_servers.mia-scheduler.command="/opt/node"',
    'mcp_servers.mia-scheduler.args=["/tmp/server.js"]',
    'mcp_servers.mia-scheduler.env.MIA_DAEMON_URL="http://127.0.0.1:27861"',
    'mcp_servers.mia-scheduler.env.MIA_DAEMON_TOKEN="token"'
  ]);
});

test("createCodexAppServerConnection starts app-server with explicit config overrides", () => {
  const spawnCalls = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const spawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return child;
  };

  const connection = createCodexAppServerConnection({
    codexPath: "/bin/codex",
    env: { PATH: "/bin" },
    spawn,
    configOverrides: ["mcp_servers.mia-scheduler.command=\"/opt/node\""]
  });
  connection.close();

  assert.equal(spawnCalls[0].command, "/bin/codex");
  assert.deepEqual(spawnCalls[0].args, [
    "app-server",
    "--listen",
    "stdio://",
    "--config",
    'mcp_servers.mia-scheduler.command="/opt/node"'
  ]);
  assert.deepEqual(spawnCalls[0].options.env, { PATH: "/bin" });
});

test("MCP elicitation requests are treated as Codex approval requests", () => {
  assert.equal(isCodexApprovalRequest("mcpServer/elicitation/request"), true);
});
