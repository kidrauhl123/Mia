const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  createSchedulerMcpBridge,
  stripMiaSchedulerSection
} = require("../src/main/scheduler-mcp-bridge.js");

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tomlStringValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-scheduler-mcp-bridge-"));
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

  service.writeContext({ botId: "bot_1", sessionId: "session_1", originMessageId: "message_1" });

  const contextPath = path.join(runtime.runtime, "scheduler-mcp", "context.json");
  assert.equal(service.contextPath(), contextPath);
  assert.deepEqual(JSON.parse(fs.readFileSync(contextPath, "utf8")), {
    botId: "bot_1",
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
  const runtimeScriptPath = path.join(path.dirname(service.contextPath()), "scheduler-mcp-server.js");

  assert.deepEqual(service.getSpec(), {
    type: "stdio",
    command: "/usr/local/bin/node",
    args: [runtimeScriptPath],
    env: {
      MIA_DAEMON_URL: "http://127.0.0.1:27861",
      MIA_DAEMON_TOKEN: "token_1",
      MIA_SCHEDULER_CONTEXT_FILE: service.contextPath()
    },
    alwaysLoad: true
  });
  assert.equal(fs.readFileSync(runtimeScriptPath, "utf8"), "server");
});

test("ensureCodexHome uses user Codex home and rewrites only Mia scheduler config", (t) => {
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
    "[mcp_servers.mia-scheduler]",
    "command = \"old\"",
    "",
    "[mcp_servers.other]",
    "command = \"keep\"",
    ""
  ].join("\n"));

  const codexHome = service.ensureCodexHome();

  assert.equal(codexHome, userCodexHome);
  assert.equal(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"), "{}");
  assert.equal(fs.existsSync(path.join(codexHome, "sessions")), true);

  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  const runtimeScriptPath = path.join(path.dirname(service.contextPath()), "scheduler-mcp-server.js");
  assert.match(config, /model = "gpt"/);
  assert.match(config, /\[mcp_servers\.other\]\ncommand = "keep"/);
  assert.doesNotMatch(config, /command = "old"/);
  assert.match(config, /\[mcp_servers\.mia-scheduler\]/);
  assert.match(config, /command = "\/opt\/node \\"quoted\\""/);
  assert.match(config, new RegExp(`args = \\["${escapeRe(tomlStringValue(runtimeScriptPath))}"\\]`));
  assert.equal(fs.readFileSync(runtimeScriptPath, "utf8"), "server");
  assert.match(config, /MIA_DAEMON_TOKEN = "token_1"/);
});

test("ensureCodexHome can skip scheduler MCP sync for read-only Codex probes", (t) => {
  const { scriptPath, service, userHome } = setup(t);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "server");
  const userCodexHome = path.join(userHome, ".codex");
  fs.mkdirSync(userCodexHome, { recursive: true });
  const configPath = path.join(userCodexHome, "config.toml");
  fs.writeFileSync(configPath, "model = \"gpt\"\n");

  const codexHome = service.ensureCodexHome({ syncSchedulerMcp: false });

  assert.equal(codexHome, userCodexHome);
  assert.equal(fs.readFileSync(configPath, "utf8"), "model = \"gpt\"\n");
  assert.equal(fs.existsSync(path.join(path.dirname(service.contextPath()), "scheduler-mcp-server.js")), false);
});

test("ensureCodexHome read-only probes do not create a missing native Codex home", (t) => {
  const { scriptPath, service, userHome } = setup(t);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "server");
  const userCodexHome = path.join(userHome, ".codex");

  const codexHome = service.ensureCodexHome({ syncSchedulerMcp: false });

  assert.equal(codexHome, userCodexHome);
  assert.equal(fs.existsSync(userCodexHome), false);
  assert.equal(fs.existsSync(path.join(userCodexHome, "config.toml")), false);
  assert.equal(fs.existsSync(path.join(path.dirname(service.contextPath()), "scheduler-mcp-server.js")), false);
});

test("stripMiaSchedulerSection removes stale scheduler env tables even when they appear before the main table", () => {
  const stripped = stripMiaSchedulerSection([
    "model = \"gpt\"",
    "",
    "[mcp_servers.mia-scheduler.env]",
    "MIA_DAEMON_TOKEN = \"old\"",
    "",
    "[mcp_servers.mia-scheduler]",
    "command = \"old\"",
    "",
    "[mcp_servers.other]",
    "command = \"keep\"",
    ""
  ].join("\n"));

  assert.match(stripped, /model = "gpt"/);
  assert.match(stripped, /\[mcp_servers\.other\]\ncommand = "keep"/);
  assert.doesNotMatch(stripped, /mcp_servers\.mia-scheduler/);
  assert.doesNotMatch(stripped, /MIA_DAEMON_TOKEN = "old"/);
});
