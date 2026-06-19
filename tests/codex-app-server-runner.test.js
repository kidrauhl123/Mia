const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const {
  codexConfigOverridesForMcpServers,
  codexDecisionFor,
  createCodexAppServerConnection,
  isCodexApprovalRequest,
  runCodexAppServerTurn,
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

test("toolPayloadFromCodexItem normalizes command items and leaves file changes for file_edit", () => {
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
  assert.equal(toolPayloadFromCodexItem({
    type: "fileChange",
    id: "patch_1",
    changes: [{ kind: "update", path: "src/app.js" }],
    status: "completed"
  }), null);
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

test("codexConfigOverridesForMcpServers supports URL MCP servers", () => {
  const overrides = codexConfigOverridesForMcpServers({
    xhs: { url: "http://127.0.0.1:18060/mcp", bearer_token_env_var: "XHS_TOKEN" }
  });

  assert.deepEqual(overrides, [
    'mcp_servers.xhs.url="http://127.0.0.1:18060/mcp"',
    'mcp_servers.xhs.bearer_token_env_var="XHS_TOKEN"'
  ]);
});

test("codexConfigOverridesForMcpServers quotes server names that are not safe TOML bare keys", () => {
  const overrides = codexConfigOverridesForMcpServers({
    "foo.bar": { url: "http://127.0.0.1:18060/mcp" },
    "小红书 MCP": {
      command: "/opt/node",
      args: ["/tmp/xhs.js"]
    }
  });

  assert.deepEqual(overrides, [
    'mcp_servers."foo.bar".url="http://127.0.0.1:18060/mcp"',
    'mcp_servers."小红书 MCP".command="/opt/node"',
    'mcp_servers."小红书 MCP".args=["/tmp/xhs.js"]'
  ]);
});

test("createCodexAppServerConnection starts app-server with explicit config overrides", () => {
  const spawnCalls = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
  };
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

test("createCodexAppServerConnection writes Codex protocol version on requests", async () => {
  const child = new EventEmitter();
  const written = [];
  child.stdin = {
    destroyed: false,
    write(line) { written.push(line); }
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const connection = createCodexAppServerConnection({
    codexPath: "/bin/codex",
    env: { PATH: "/bin" },
    spawn: () => child
  });

  const pending = connection.request("initialize", { clientInfo: { name: "mia", title: "Mia", version: "0.1.0" } });
  const request = JSON.parse(written[0]);
  assert.equal(request.version, 2);
  assert.equal(request.method, "initialize");

  child.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + "\n");
  assert.deepEqual(await pending, { ok: true });
  connection.close();
});

test("createCodexAppServerConnection runs codex with its own bin dir first in PATH", () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  let spawnOptions = null;
  const connection = createCodexAppServerConnection({
    codexPath: "/opt/codex-node/bin/codex",
    env: { PATH: "/bad-node/bin:/usr/bin:/opt/codex-node/bin" },
    spawn: (_command, _args, options) => {
      spawnOptions = options;
      return child;
    }
  });
  connection.close();

  assert.equal(spawnOptions.env.PATH, "/opt/codex-node/bin:/bad-node/bin:/usr/bin");
});

test("runCodexAppServerTurn keeps full-access approval policy when using Codex permission profiles", async () => {
  const requests = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
  };
  child.stdin = {
    destroyed: false,
    write(line) {
      const request = JSON.parse(line);
      requests.push(request);
      if (request.method === "initialize") {
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + "\n"));
      } else if (request.method === "thread/start") {
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: "thread_1" } } }) + "\n"));
      } else if (request.method === "turn/start") {
        queueMicrotask(() => {
          child.stdout.write(JSON.stringify({
            id: request.id,
            result: {
              turn: {
                id: "turn_1",
                status: "completed",
                items: [{ type: "agentMessage", text: "done" }]
              }
            }
          }) + "\n");
        });
      }
    }
  };

  const result = await runCodexAppServerTurn({
    codexPath: "/bin/codex",
    env: { PATH: "/bin" },
    prompt: "hello",
    options: {
      permissionProfile: ":danger-full-access",
      approvalPolicy: "never",
      workingDirectory: "/repo",
      modelReasoningEffort: "low"
    },
    spawn: () => child
  });

  const threadStart = requests.find((request) => request.method === "thread/start");
  const turnStart = requests.find((request) => request.method === "turn/start");
  assert.deepEqual(threadStart.params.config, { default_permissions: ":danger-full-access" });
  assert.equal(threadStart.params.approvalPolicy, "never");
  assert.equal(Object.hasOwn(threadStart.params, "sandbox"), false);
  assert.equal(turnStart.params.approvalPolicy, "never");
  assert.equal(result.finalResponse, "done");
});

test("runCodexAppServerTurn emits Codex fileChange items as file_edit events", async () => {
  const emitted = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
  };
  child.stdin = {
    destroyed: false,
    write(line) {
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + "\n"));
      } else if (request.method === "thread/start") {
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: "thread_1" } } }) + "\n"));
      } else if (request.method === "turn/start") {
        queueMicrotask(() => {
          child.stdout.write(JSON.stringify({
            method: "item/completed",
            params: {
              item: {
                type: "fileChange",
                id: "patch_1",
                status: "completed",
                changes: [{
                  kind: "update",
                  path: "src/app.js",
                  diff: "@@\n-old\n+new"
                }]
              }
            }
          }) + "\n");
          child.stdout.write(JSON.stringify({
            id: request.id,
            result: {
              turn: {
                id: "turn_1",
                status: "completed",
                items: [{ type: "agentMessage", text: "done" }]
              }
            }
          }) + "\n");
        });
      }
    }
  };

  const result = await runCodexAppServerTurn({
    codexPath: "/bin/codex",
    env: { PATH: "/bin" },
    prompt: "hello",
    options: { workingDirectory: "/repo" },
    spawn: () => child,
    emit: (kind, payload) => emitted.push({ kind, payload })
  });

  assert.equal(result.finalResponse, "done");
  assert.deepEqual(emitted.filter((event) => event.kind === "file_edit"), [{
    kind: "file_edit",
    payload: {
      id: "patch_1_diff_0",
      path: "src/app.js",
      action: "update",
      title: "Edited src/app.js (+1 -1)",
      diff: "@@\n-old\n+new",
      additions: 1,
      deletions: 1,
      status: "completed",
      error: false
    }
  }]);
});

test("runCodexAppServerTurn emits shell-created workspace files as file_edit events", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mia-codex-app-shell-diff-"));
  const emitted = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
  };
  child.stdin = {
    destroyed: false,
    write(line) {
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + "\n"));
      } else if (request.method === "thread/start") {
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: "thread_1" } } }) + "\n"));
      } else if (request.method === "turn/start") {
        queueMicrotask(() => {
          fs.writeFileSync(path.join(workspace, "mia-diff-demo.txt"), "hello mia\n");
          child.stdout.write(JSON.stringify({
            method: "item/completed",
            params: {
              item: {
                type: "commandExecution",
                id: "cmd_1",
                command: "/bin/zsh -lc \"printf 'hello mia\\n' > mia-diff-demo.txt\"",
                status: "completed"
              }
            }
          }) + "\n");
          child.stdout.write(JSON.stringify({
            id: request.id,
            result: {
              turn: {
                id: "turn_1",
                status: "completed",
                items: [{ type: "agentMessage", text: "done" }]
              }
            }
          }) + "\n");
        });
      }
    }
  };

  const result = await runCodexAppServerTurn({
    codexPath: "/bin/codex",
    env: { PATH: "/bin" },
    prompt: "hello",
    options: { workingDirectory: workspace },
    spawn: () => child,
    emit: (kind, payload) => emitted.push({ kind, payload })
  });

  assert.equal(result.finalResponse, "done");
  assert.deepEqual(emitted.filter((event) => event.kind === "file_edit"), [{
    kind: "file_edit",
    payload: {
      id: "cmd_1_diff_0",
      path: "mia-diff-demo.txt",
      action: "add",
      title: "Added mia-diff-demo.txt (+1 -0)",
      diff: [
        "diff --git a/mia-diff-demo.txt b/mia-diff-demo.txt",
        "--- /dev/null",
        "+++ b/mia-diff-demo.txt",
        "@@ -0,0 +1,1 @@",
        "+hello mia"
      ].join("\n"),
      additions: 1,
      deletions: 0,
      status: "completed",
      error: false
    }
  }]);
});

test("MCP elicitation requests are treated as Codex approval requests", () => {
  assert.equal(isCodexApprovalRequest("mcpServer/elicitation/request"), true);
});

test("runCodexAppServerTurn rejects cronjob MCP requests before user permission", async () => {
  const requests = [];
  let elicitationResponse = null;
  let turnStartId = null;
  let permissionCalled = false;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
  };
  child.stdin = {
    destroyed: false,
    write(line) {
      const request = JSON.parse(line);
      requests.push(request);
      if (request.method === "initialize") {
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + "\n"));
      } else if (request.method === "thread/start") {
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: "thread_1" } } }) + "\n"));
      } else if (request.method === "turn/start") {
        turnStartId = request.id;
        queueMicrotask(() => child.stdout.write(JSON.stringify({
          id: 900,
          method: "mcpServer/elicitation/request",
          params: {
            serverName: "cronjob",
            tool: "create",
            message: "Use tool \"create\"",
            _meta: { tool_params: { schedule: "2m", prompt: "提醒我吃饭" } }
          }
        }) + "\n"));
      } else if (request.id === 900) {
        elicitationResponse = request.result;
        queueMicrotask(() => child.stdout.write(JSON.stringify({
          id: turnStartId,
          result: {
            turn: {
              id: "turn_1",
              status: "completed",
              items: [{ type: "agentMessage", text: "done" }]
            }
          }
        }) + "\n"));
      }
    }
  };

  const result = await runCodexAppServerTurn({
    codexPath: "/bin/codex",
    env: { PATH: "/bin" },
    prompt: "2分钟后提醒我吃饭",
    options: { workingDirectory: "/repo" },
    permissionCoordinator: {
      requestPermission: async () => {
        permissionCalled = true;
        return { decision: "allow", scope: "always" };
      }
    },
    spawn: () => child
  });

  assert.deepEqual(elicitationResponse, { action: "decline" });
  assert.equal(permissionCalled, false);
  assert.equal(result.finalResponse, "done");
});
