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
    // Scope the direct PATH scan to this test's temp home: files the test
    // creates under it resolve normally, but real system dirs (e.g. a real
    // codex in /opt/homebrew/bin) never do — keeping detection deterministic.
    fs: {
      accessSync: (p, mode) => {
        if (!String(p).startsWith(home)) throw new Error("ENOENT");
        return fs.accessSync(p, mode);
      }
    },
    spawnSync: (...args) => {
      calls.push(args);
      return { status: 1, stdout: "", stderr: "" };
    },
    // Async probe default: resolve nothing, so async detection tests never spawn
    // real processes unless they override execFile.
    execFile: (_file, _args, _options, cb) => cb(new Error("not found"), "", ""),
    platform: "darwin",
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

test("shellCommandPath finds npm CLIs installed under nvm versions", (t) => {
  const { home, service } = makeService(t);
  const bin = path.join(home, ".nvm", "versions", "node", "v24.15.0", "bin");
  const executable = path.join(bin, "codex");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });

  assert.equal(service.shellCommandPath("codex"), executable);
});

test("shellCommandPath uses `where` on Windows and prefers native executables", (t) => {
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

  // Prefer the real executable over npm cmd shims when both are visible.
  assert.equal(service.shellCommandPath("claude"), "C:\\other\\claude.exe");
  assert.equal(calls.filter((call) => call[0] === "zsh").length, 0);
  assert.deepEqual(calls, [["where", ["claude"]]]);
});

test("shellCommandPath ignores extensionless Windows npm shims from where output", (t) => {
  const calls = [];
  const { service } = makeService(t, {
    platform: "win32",
    spawnSync: (command, args) => {
      calls.push([command, args]);
      if (command === "where" && args[0] === "codex") {
        return {
          status: 0,
          stdout: [
            "C:\\Users\\me\\AppData\\Roaming\\npm\\codex",
            "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd"
          ].join("\r\n"),
          stderr: ""
        };
      }
      if (command === "cmd.exe") {
        assert.deepEqual(args.slice(0, 4), ["/d", "/s", "/c", "call"]);
        assert.match(args[4], /codex\.cmd/);
        return { status: 0, stdout: "codex-cli 0.142.0\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    }
  });

  const commandPath = service.shellCommandPath("codex");
  assert.equal(commandPath, "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd");
  assert.equal(service.commandVersion(commandPath), "codex-cli 0.142.0");
  assert.deepEqual(calls.map((call) => call[0]), ["where", "cmd.exe"]);
});

test("shellCommandPath scans official Windows agent install directories before PATH lookup", (t) => {
  let root = "";
  const calls = [];
  const { home, service } = makeService(t, {
    platform: "win32",
    env: () => ({
      PATH: "",
      LOCALAPPDATA: path.join(root, "AppData", "Local"),
      APPDATA: path.join(root, "AppData", "Roaming")
    }),
    fs: {
      accessSync: (p, mode) => {
        if (!String(p).startsWith(home)) throw new Error("ENOENT");
        return fs.accessSync(p, mode);
      }
    },
    spawnSync: (command, args) => {
      calls.push([command, args]);
      return { status: 1, stdout: "", stderr: "" };
    }
  });
  root = home;

  const hermes = path.join(root, "AppData", "Local", "hermes", "hermes-agent", "venv", "Scripts", "hermes.exe");
  const claude = path.join(root, ".claude", "local", "bin", "claude.exe");
  const codex = path.join(root, "AppData", "Local", "Programs", "OpenAI", "Codex", "bin", "codex.exe");
  const openclaw = path.join(root, "AppData", "Roaming", "npm", "openclaw.cmd");
  for (const filePath of [hermes, claude, codex, openclaw]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "");
  }

  assert.equal(service.shellCommandPath("hermes"), hermes);
  assert.equal(service.shellCommandPath("claude"), claude);
  assert.equal(service.shellCommandPath("codex"), codex);
  assert.equal(service.shellCommandPath("openclaw"), openclaw);
  assert.deepEqual(calls, []);
});

test("agentInventory prefers managed runtime manifests before system PATH probes", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-local-agent-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "managed-resources");
  const service = createLocalAgentEngineService({
    homeDir: () => home,
    env: { PATH: "" },
    platform: "win32",
    arch: "x64",
    managedResourceRoots: [root],
    fs: {
      accessSync: (p, mode) => {
        if (!String(p).startsWith(home)) throw new Error("ENOENT");
        return fs.accessSync(p, mode);
      },
      readdirSync: (...args) => fs.readdirSync(...args),
      readFileSync: (...args) => fs.readFileSync(...args)
    },
    spawnSync: (command, args) => {
      if (command === "where" && args[0] === "codex") {
        return { status: 0, stdout: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd\r\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    }
  });
  const runtimeDir = path.join(root, "acp", "codex-acp", "0.14.0", "win32-x64");
  const entrypoint = path.join(runtimeDir, "codex-acp.exe");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(entrypoint, "");
  fs.writeFileSync(path.join(runtimeDir, "manifest.json"), JSON.stringify({
    entrypoint: "codex-acp.exe",
    protocol: "codex-app-server"
  }));

  const inventory = service.agentInventory();
  const codex = inventory.agents.find((agent) => agent.id === "codex");

  assert.equal(codex.source, "managed");
  assert.equal(codex.usableInMia, true);
  assert.equal(codex.path, entrypoint);
  assert.equal(codex.version, "0.14.0");
  assert.equal(codex.system.available, false);
  assert.deepEqual(codex.runtime, {
    source: "managed",
    managed: true,
    supported: true,
    path: entrypoint,
    version: "0.14.0",
    protocol: "codex-app-server"
  });
});

test("agentInventory detects unsupported managed ACP runtimes without exposing them as usable CLI adapters", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mia-local-agent-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "managed-resources");
  const runtimeDir = path.join(root, "acp", "codex-acp", "0.14.0", "win32-x64");
  const entrypoint = path.join(runtimeDir, "codex-acp.exe");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(entrypoint, "");
  fs.writeFileSync(path.join(runtimeDir, "manifest.json"), JSON.stringify({
    entrypoint: "codex-acp.exe",
    protocol: "acp"
  }));
  const service = createLocalAgentEngineService({
    homeDir: () => home,
    env: { PATH: "" },
    platform: "win32",
    arch: "x64",
    managedResourceRoots: [root],
    fs: {
      accessSync: (p, mode) => {
        if (!String(p).startsWith(home)) throw new Error("ENOENT");
        return fs.accessSync(p, mode);
      },
      readdirSync: (...args) => fs.readdirSync(...args),
      readFileSync: (...args) => fs.readFileSync(...args)
    },
    spawnSync: () => ({ status: 1, stdout: "", stderr: "" })
  });

  const codex = service.agentInventory().agents.find((agent) => agent.id === "codex");

  assert.equal(codex.installed, true);
  assert.equal(codex.usableInMia, false);
  assert.equal(codex.health, "detected");
  assert.equal(codex.source, "managed");
  assert.equal(codex.runtime.protocol, "acp");
  assert.equal(codex.runtime.supported, false);
  assert.equal(service.shellCommandPath("codex"), "");
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

test("pendingAgentInventory reports checking state without spawning CLI probes", (t) => {
  const { calls, service } = makeService(t);

  const inventory = service.pendingAgentInventory();
  const legacy = service.pendingLocalAgentEngines();
  const agentsById = Object.fromEntries(inventory.agents.map((agent) => [agent.id, agent]));

  assert.equal(calls.length, 0);
  assert.equal(inventory.summary.scanning, true);
  assert.equal(inventory.summary.recommendedAction, "scan");
  assert.equal(agentsById.hermes.health, "checking");
  assert.equal(agentsById.hermes.source, "checking");
  assert.equal(agentsById.hermes.installed, false);
  assert.equal(legacy.hermes.source, "checking");
  assert.equal(legacy.claudeCode.available, false);
});

test("agentInventory does not treat legacy managed Hermes source as usable", (t) => {
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
  assert.equal(agentsById.hermes.usableInMia, false);
  assert.equal(agentsById.hermes.source, "system");
  assert.equal(agentsById.hermes.health, "detected");
  assert.equal(agentsById.hermes.installAction, "repair-hermes");
  assert.deepEqual(agentsById.hermes.system, {
    available: true,
    path: "/bin/hermes",
    version: "hermes 0.4.0"
  });
  assert.equal(agentsById["claude-code"].usableInMia, true);
  assert.equal(agentsById.codex.usableInMia, true);
  assert.equal(agentsById.openclaw.installed, true);
  assert.equal(agentsById.openclaw.usableInMia, true);
  assert.equal(agentsById.openclaw.detectionOnly, false);
});

test("agentInventory treats system Hermes as usable when Mia can launch its Python runtime", (t) => {
  const { service } = makeService(t, {
    isHermesInstalled: () => true,
    isHermesApiRuntimeReady: () => true,
    hermesSource: () => "system",
    fs: {
      accessSync: () => {
        throw new Error("missing");
      }
    },
    spawnSync: (command, args) => {
      if (command === "zsh" && args[1] === "command -v hermes") {
        return { status: 0, stdout: "/bin/hermes\n", stderr: "" };
      }
      if (command === "/bin/hermes") return { status: 0, stdout: "Hermes Agent v0.11.0\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    }
  });

  const inventory = service.agentInventory();
  const hermes = inventory.agents.find((agent) => agent.id === "hermes");
  const legacy = service.localAgentEngines();

  assert.equal(hermes.installed, true);
  assert.equal(hermes.usableInMia, true);
  assert.equal(hermes.source, "system");
  assert.equal(hermes.health, "ready");
  assert.equal(hermes.installAction, "");
  assert.equal(inventory.summary.usableCount, 1);
  assert.equal(inventory.summary.recommendedAction, "continue");
  assert.equal(legacy.hermes.available, true);
  assert.equal(legacy.hermes.source, "system");
});

test("agentInventory marks Hermes broken when API runtime dependency is missing", (t) => {
  const { service } = makeService(t, {
    isHermesInstalled: () => true,
    isHermesApiRuntimeReady: () => false,
    hermesSource: () => "system",
    fs: {
      accessSync: () => {
        throw new Error("missing");
      }
    },
    spawnSync: (command, args) => {
      if (command === "zsh" && args[1] === "command -v hermes") {
        return { status: 0, stdout: "/bin/hermes\n", stderr: "" };
      }
      if (command === "/bin/hermes") return { status: 0, stdout: "Hermes Agent v0.16.0\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    }
  });

  const inventory = service.agentInventory();
  const hermes = inventory.agents.find((agent) => agent.id === "hermes");
  const legacy = service.localAgentEngines();

  assert.equal(hermes.installed, true);
  assert.equal(hermes.usableInMia, false);
  assert.equal(hermes.health, "broken");
  assert.equal(hermes.installAction, "repair-hermes");
  assert.equal(inventory.summary.usableCount, 0);
  assert.equal(inventory.summary.recommendedAction, "repair-hermes");
  assert.equal(legacy.hermes.available, false);
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
  assert.equal(agentsById.openclaw.installable, true);
  assert.equal(agentsById.openclaw.installAction, "install-openclaw");
  assert.equal(agentsById.openclaw.detectionOnly, false);
  assert.equal(legacy.hermes.available, false);
  assert.equal(legacy.claudeCode.available, false);
  assert.equal(legacy.codex.available, false);
  assert.equal(legacy.openClaw.available, false);
});

test("agentInventory ignores legacy local-source Hermes runtime", (t) => {
  const { service } = makeService(t, {
    isHermesInstalled: () => true,
    hermesSource: () => "local-source",
    fs: {
      accessSync: () => {
        throw new Error("missing");
      }
    },
    spawnSync: () => ({ status: 1, stdout: "", stderr: "" })
  });

  const inventory = service.agentInventory();
  const hermes = inventory.agents.find((agent) => agent.id === "hermes");
  const legacy = service.localAgentEngines();

  assert.equal(hermes.installed, false);
  assert.equal(hermes.usableInMia, false);
  assert.equal(hermes.source, "missing");
  assert.equal(hermes.health, "missing");
  assert.equal(hermes.installAction, "install-hermes");
  assert.equal(inventory.summary.installedCount, 0);
  assert.equal(inventory.summary.usableCount, 0);
  assert.equal(inventory.summary.hasUsableAgent, false);
  assert.equal(legacy.hermes.available, false);
  assert.equal(legacy.hermes.source, "missing");
});

test("scanAgentsAsync probes agents asynchronously, reports progress, and warms the cache", async (t) => {
  const progress = [];
  const execCalls = [];
  const { service } = makeService(t, {
    execFile: (file, args, _options, cb) => {
      execCalls.push([file, ...args]);
      if (file === "zsh" && args[1] === "command -v claude") return cb(null, "/bin/claude\n", "");
      if (file === "/bin/claude") return cb(null, "claude 9.9.9\n", "");
      return cb(new Error("not found"), "", "");
    }
  });

  const inventory = await service.scanAgentsAsync((agent) => progress.push(agent.id));

  assert.equal(inventory.agents.length, 4);
  assert.equal(progress.length, 4, "every agent reported once");
  const claude = inventory.agents.find((a) => a.id === "claude-code");
  assert.equal(claude.path, "/bin/claude");
  assert.equal(claude.usableInMia, true);
  assert.equal(claude.readiness.status, "ready");
  assert.ok(execCalls.some((call) => call[0] === "/bin/claude" && call[1] === "--help"));
  // Cache warmed: the non-blocking read returns the same scanned inventory.
  assert.equal(service.cachedAgentInventory(), inventory);
  assert.equal(service.cachedLocalAgentEngines().claudeCode.available, true);
});

test("scanAgentsAsync marks installed agents blocked when CLI handshake fails", async (t) => {
  const { service } = makeService(t, {
    execFile: (file, args, _options, cb) => {
      if (file === "zsh" && args[1] === "command -v codex") return cb(null, "/bin/codex\n", "");
      if (file === "/bin/codex" && args[0] === "--version") return cb(null, "codex 2.3.4\n", "");
      if (file === "/bin/codex" && args[0] === "--help") return cb(new Error("spawn failed"), "", "Cannot start Codex");
      return cb(new Error("not found"), "", "");
    }
  });

  const inventory = await service.scanAgentsAsync();
  const codex = inventory.agents.find((agent) => agent.id === "codex");

  assert.equal(codex.installed, true);
  assert.equal(codex.usableInMia, false);
  assert.equal(codex.health, "blocked");
  assert.equal(codex.installAction, "install-codex");
  assert.equal(codex.readiness.status, "blocked");
  assert.match(codex.readiness.detail, /Cannot start Codex/);
  assert.equal(inventory.summary.recommendedAction, "install-codex");
  assert.equal(service.cachedLocalAgentEngines().codex.available, false);
  assert.equal(service.cachedLocalAgentEngines().codex.installAction, "install-codex");
});

test("cachedAgentInventory returns the scanning placeholder before any scan", (t) => {
  const { service } = makeService(t);
  const cached = service.cachedAgentInventory();
  assert.equal(cached.summary.scanning, true);
  // Non-blocking read must not spawn any probe.
  assert.equal(service.cachedLocalAgentEngines().hermes.source, "checking");
});
