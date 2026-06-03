const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLocalAgentEngineService } = require("../src/main/local-agent-engine-service.js");

function makeService(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-local-agent-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const service = createLocalAgentEngineService({
    homeDir: () => home,
    env: { PATH: ["/custom/bin", "/usr/bin"].join(path.delimiter) },
    spawnSync: (...args) => {
      calls.push(args);
      return { status: 1, stdout: "", stderr: "" };
    },
    ...overrides
  });
  return { calls, home, service };
}

test("processEnvWithCliPath prepends common user CLI directories without duplicating PATH entries", (t) => {
  const { home, service } = makeService(t, {
    env: {
      PATH: [
        "/custom/bin",
        "/custom/bin"
      ].join(path.delimiter),
      FOO: "bar"
    }
  });

  const env = service.processEnvWithCliPath();
  const segments = env.PATH.split(path.delimiter);

  assert.equal(env.FOO, "bar");
  assert.equal(segments[0], path.join(home, ".local", "bin"));
  assert.equal(segments[1], path.join(home, ".npm-global", "bin"));
  assert.equal(segments.filter((item) => item === "/custom/bin").length, 1);
});

test("shellCommandPath uses a shell lookup with the enriched PATH and rejects unsafe command names", (t) => {
  const { calls, home, service } = makeService(t, {
    spawnSync: (command, args, options) => {
      calls.push([command, args, options]);
      assert.ok(options.env.PATH.split(path.delimiter).includes(path.join(home, ".local", "bin")));
      return { status: 0, stdout: "/opt/homebrew/bin/claude\n", stderr: "" };
    }
  });

  assert.equal(service.shellCommandPath("claude"), "/opt/homebrew/bin/claude");
  assert.equal(service.shellCommandPath("claude;rm"), "");
  assert.deepEqual(calls.map((call) => [call[0], call[1]]), [
    ["zsh", ["-lc", "command -v claude"]]
  ]);
});

test("shellCommandPath falls back to executable files in user CLI directories", (t) => {
  const { home, service } = makeService(t);
  const bin = path.join(home, ".local", "bin");
  const executable = path.join(bin, "codex");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });

  assert.equal(service.shellCommandPath("codex"), executable);
});

test("shellCommandPath uses `where` on Windows and returns the first resolved path", (t) => {
  const calls = [];
  const { service } = makeService(t, {
    platform: "win32",
    spawnSync: (command, args) => {
      calls.push([command, args]);
      if (command === "where" && args[0] === "claude") {
        return {
          status: 0,
          stdout: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\r\nC:\\other\\claude.exe\r\n",
          stderr: ""
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    }
  });

  // The resolved path keeps its extension so the engine SDKs get a runnable
  // executable, and we never shell out to zsh (absent on Windows).
  assert.equal(service.shellCommandPath("claude"), "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd");
  assert.equal(calls.filter((call) => call[0] === "zsh").length, 0);
  assert.deepEqual(calls, [["where", ["claude"]]]);
});

test("shellCommandPath returns empty on Windows when `where` finds nothing", (t) => {
  const calls = [];
  const { service } = makeService(t, {
    platform: "win32",
    spawnSync: (command, args) => {
      calls.push([command, args]);
      return { status: 1, stdout: "", stderr: "" };
    }
  });

  assert.equal(service.shellCommandPath("codex"), "");
  assert.equal(calls.filter((call) => call[0] === "zsh").length, 0);
});

test("commandVersion returns the first version line from stdout or stderr", (t) => {
  const { service } = makeService(t, {
    spawnSync: (command, args) => {
      if (command === "/bin/claude" && args[0] === "--version") {
        return { status: 0, stdout: "", stderr: "claude 1.2.3\nextra\n" };
      }
      return { status: 1, stdout: "", stderr: "" };
    }
  });

  assert.equal(service.commandVersion("/bin/claude"), "claude 1.2.3");
  assert.equal(service.commandVersion(""), "");
});

test("localAgentEngines reports the legacy engine view and caches CLI probes until reset", (t) => {
  let now = 1000;
  const { calls, service } = makeService(t, {
    now: () => now,
    spawnSync: (command, args) => {
      calls.push([command, ...args]);
      if (command === "zsh" && args[1] === "command -v claude") {
        return { status: 0, stdout: "/bin/claude\n", stderr: "" };
      }
      if (command === "zsh" && args[1] === "command -v codex") {
        return { status: 0, stdout: "/bin/codex\n", stderr: "" };
      }
      if (command === "/bin/claude") {
        return { status: 0, stdout: "claude 1.2.3\n", stderr: "" };
      }
      if (command === "/bin/codex") {
        return { status: 0, stdout: "codex 2.3.4\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    }
  });

  const first = service.localAgentEngines();
  now += 1000;
  const cached = service.localAgentEngines();
  service.resetCache();
  const refreshed = service.localAgentEngines();

  assert.equal(first.hermes.available, false);
  assert.deepEqual(first.hermes.system, { available: false, path: "", version: "" });
  assert.equal(first.claudeCode.path, "/bin/claude");
  assert.equal(first.claudeCode.version, "claude 1.2.3");
  assert.equal(first.codex.path, "/bin/codex");
  assert.equal(first.codex.version, "codex 2.3.4");
  assert.equal(cached, first);
  assert.notEqual(refreshed, first);
  assert.equal(calls.filter((call) => call[0] === "zsh").length, 10);
});

test("agentInventory separates system Hermes detection from Mia Hermes usability", (t) => {
  let now = 1000;
  const { service } = makeService(t, {
    now: () => now,
    isHermesInstalled: () => true,
    hermesSource: () => "managed",
    spawnSync: (command, args) => {
      if (command === "zsh" && args[1] === "command -v hermes") {
        return { status: 0, stdout: "/bin/hermes\n", stderr: "" };
      }
      if (command === "zsh" && args[1] === "command -v claude") {
        return { status: 0, stdout: "/bin/claude\n", stderr: "" };
      }
      if (command === "zsh" && args[1] === "command -v codex") {
        return { status: 0, stdout: "/bin/codex\n", stderr: "" };
      }
      if (command === "zsh" && args[1] === "command -v openclaw") {
        return { status: 0, stdout: "/bin/openclaw\n", stderr: "" };
      }
      if (command === "/bin/hermes") return { status: 0, stdout: "hermes 0.4.0\n", stderr: "" };
      if (command === "/bin/claude") return { status: 0, stdout: "claude 1.2.3\n", stderr: "" };
      if (command === "/bin/codex") return { status: 0, stdout: "codex 2.3.4\n", stderr: "" };
      if (command === "/bin/openclaw") return { status: 0, stdout: "openclaw 0.1.0\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    }
  });

  const inventory = service.agentInventory();
  now += 1000;
  const cached = service.agentInventory();
  const agentsById = Object.fromEntries(inventory.agents.map((agent) => [agent.id, agent]));

  assert.equal(cached, inventory);
  assert.equal(inventory.summary.installedCount, 4);
  assert.equal(inventory.summary.usableCount, 3);
  assert.equal(inventory.summary.missingCount, 0);
  assert.equal(inventory.summary.hasUsableAgent, true);
  assert.equal(inventory.summary.recommendedAction, "continue");
  assert.equal(agentsById.hermes.installed, true);
  assert.equal(agentsById.hermes.usableInMia, true);
  assert.equal(agentsById.hermes.source, "mia-managed");
  assert.deepEqual(agentsById.hermes.system, {
    available: true,
    path: "/bin/hermes",
    version: "hermes 0.4.0"
  });
  assert.equal(agentsById["claude-code"].usableInMia, true);
  assert.equal(agentsById.codex.usableInMia, true);
  assert.equal(agentsById.openclaw.installed, true);
  assert.equal(agentsById.openclaw.usableInMia, false);
  assert.equal(agentsById.openclaw.detectionOnly, true);
});

test("agentInventory recommends Hermes install when no usable agent is detected", (t) => {
  const { service } = makeService(t, {
    isHermesInstalled: () => false,
    hermesSource: () => "",
    fs: {
      accessSync: () => {
        throw new Error("missing");
      }
    },
    spawnSync: () => ({ status: 1, stdout: "", stderr: "" })
  });

  const inventory = service.agentInventory();
  const agentsById = Object.fromEntries(inventory.agents.map((agent) => [agent.id, agent]));
  const legacy = service.localAgentEngines();

  assert.equal(inventory.summary.installedCount, 0);
  assert.equal(inventory.summary.usableCount, 0);
  assert.equal(inventory.summary.missingCount, 4);
  assert.equal(inventory.summary.hasUsableAgent, false);
  assert.equal(inventory.summary.recommendedAction, "install-hermes");
  assert.equal(agentsById.hermes.installable, true);
  assert.equal(agentsById.hermes.installAction, "install-hermes");
  assert.equal(agentsById.hermes.health, "missing");
  assert.equal(agentsById.openclaw.installable, false);
  assert.equal(legacy.hermes.available, false);
  assert.equal(legacy.claudeCode.available, false);
  assert.equal(legacy.codex.available, false);
  assert.equal(legacy.openClaw.available, false);
});
