const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createMiaAppMcpBridge } = require("../src/main/mia-app-mcp-bridge.js");

test("Mia app MCP spec exposes stdio command and scoped daemon token", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-app-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceServer = path.join(dir, "source-server.js");
  fs.writeFileSync(sourceServer, "process.exit(0);\n");
  const bridge = createMiaAppMcpBridge({
    runtimePaths: () => ({ runtime: path.join(dir, "runtime") }),
    daemonStatus: () => ({ baseUrl: "http://127.0.0.1:18000" }),
    daemonToken: () => "daemon-token",
    nodePath: () => "/opt/node",
    ddgsPythonPath: () => "/opt/hermes/bin/python",
    serverScriptPath: () => sourceServer
  });

  const spec = bridge.getSpec({ botId: "mei", sessionId: "s1" });

  assert.equal(spec.type, "stdio");
  assert.equal(spec.command, "/opt/node");
  assert.equal(spec.env.MIA_DAEMON_URL, "http://127.0.0.1:18000");
  assert.equal(spec.env.MIA_DAEMON_TOKEN, "daemon-token");
  assert.equal(spec.env.MIA_APP_CONTEXT_FILE.endsWith("context.json"), true);
  assert.equal(spec.env.MIA_DDGS_PYTHON, "/opt/hermes/bin/python");
  assert.deepEqual(spec.args, [path.join(dir, "runtime", "mia-app-mcp", "mia-app-mcp-server.js")]);
  assert.deepEqual(JSON.parse(fs.readFileSync(spec.env.MIA_APP_CONTEXT_FILE, "utf8")), {
    botId: "mei",
    sessionId: "s1"
  });
});

test("Mia app MCP spec is null until daemon, server, and node are available", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-app-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bridge = createMiaAppMcpBridge({
    runtimePaths: () => ({ runtime: path.join(dir, "runtime") }),
    daemonStatus: () => ({}),
    daemonSettings: () => ({}),
    daemonToken: () => "daemon-token",
    nodePath: () => "/opt/node",
    serverScriptPath: () => path.join(dir, "missing.js")
  });

  assert.equal(bridge.getSpec(), null);
});
