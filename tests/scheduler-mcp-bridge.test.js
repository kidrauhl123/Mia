const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createSchedulerMcpBridge } = require("../src/main/scheduler-mcp-bridge.js");

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-scheduler-mcp-bridge-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = {
    runtime: path.join(dir, "runtime")
  };
  const userHome = path.join(dir, "user home");
  const scriptPath = path.join(dir, "app", "scheduler-mcp-server.js");
  const service = createSchedulerMcpBridge({
    runtimePaths: () => runtime,
    daemonStatus: () => ({ baseUrl: "http://127.0.0.1:27861" }),
    daemonSettings: () => ({ host: "127.0.0.1", port: 27861 }),
    daemonToken: () => "token_1",
    nodePath: () => "/usr/local/bin/node",
    serverScriptPath: () => scriptPath,
    homeDir: () => userHome,
    ...overrides
  });
  return { dir, runtime, scriptPath, service, userHome };
}

test("writeContext persists per-turn scheduler context under runtime", (t) => {
  const { runtime, service } = setup(t);

  service.writeContext({ fellowId: "fellow_1", sessionId: "session_1", originMessageId: "message_1" });

  const contextPath = path.join(runtime.runtime, "scheduler-mcp", "context.json");
  assert.equal(service.contextPath(), contextPath);
  assert.deepEqual(JSON.parse(fs.readFileSync(contextPath, "utf8")), {
    fellowId: "fellow_1",
    sessionId: "session_1",
    originMessageId: "message_1"
  });
});

test("getSpec returns null until daemon, script, and node are available", (t) => {
  const { service } = setup(t, {
    daemonStatus: () => ({}),
    daemonSettings: () => ({})
  });

  assert.equal(service.getSpec(), null);
});

test("getSpec returns the stdio MCP config with daemon token and context path", (t) => {
  const { scriptPath, service } = setup(t);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "server");

  assert.deepEqual(service.getSpec(), {
    type: "stdio",
    command: "/usr/local/bin/node",
    args: [scriptPath],
    env: {
      AIMASHI_DAEMON_URL: "http://127.0.0.1:27861",
      AIMASHI_DAEMON_TOKEN: "token_1",
      AIMASHI_SCHEDULER_CONTEXT_FILE: service.contextPath()
    },
    alwaysLoad: true
  });
});

test("ensureCodexHome links user Codex state and rewrites only Aimashi scheduler config", (t) => {
  const { scriptPath, service, userHome } = setup(t, {
    nodePath: () => "/opt/node \"quoted\""
  });
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "server");
  const userCodexHome = path.join(userHome, ".codex");
  fs.mkdirSync(path.join(userCodexHome, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(userCodexHome, "auth.json"), "{}");
  fs.writeFileSync(path.join(userCodexHome, "config.toml"), [
    "model = \"gpt\"",
    "",
    "[mcp_servers.aimashi-scheduler]",
    "command = \"old\"",
    "",
    "[mcp_servers.other]",
    "command = \"keep\"",
    ""
  ].join("\n"));

  const codexHome = service.ensureCodexHome();

  assert.equal(codexHome.endsWith(path.join("runtime", "codex-home")), true);
  assert.equal(fs.lstatSync(path.join(codexHome, "auth.json")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(codexHome, "sessions")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(codexHome, "config.toml")).isSymbolicLink(), false);

  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  assert.match(config, /model = "gpt"/);
  assert.match(config, /\[mcp_servers\.other\]\ncommand = "keep"/);
  assert.doesNotMatch(config, /command = "old"/);
  assert.match(config, /\[mcp_servers\.aimashi-scheduler\]/);
  assert.match(config, /command = "\/opt\/node \\"quoted\\""/);
  assert.match(config, /AIMASHI_DAEMON_TOKEN = "token_1"/);
});
