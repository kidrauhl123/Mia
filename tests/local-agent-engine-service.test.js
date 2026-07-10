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

test("shellCommandPath does not treat managed ACP runtimes as primary CLIs", (t) => {
  const { service } = makeService(t, {
    managedAgentRuntime: {
      resolve: () => ({ path: "/managed/codex-acp", command: "/managed/codex-acp" })
    }
  });

  assert.equal(service.shellCommandPath("codex"), "");
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
    spawnSync: (command, args, options) => {
      calls.push([command, args, options]);
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
  assert.deepEqual(calls.map((call) => [call[0], call[1]]), [["where", ["claude"]]]);
  assert.equal(calls[0][2].windowsHide, true);
});

test("shellCommandPath ignores extensionless Windows npm shims from where output", (t) => {
  const calls = [];
  const { service } = makeService(t, {
    platform: "win32",
    spawnSync: (command, args, options) => {
      calls.push([command, args, options]);
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
  assert.equal(calls.every((call) => call[2].windowsHide === true), true);
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
    spawnSync: (command, args, options) => {
      calls.push([command, args, options]);
      return { status: 1, stdout: "", stderr: "" };
    }
  });
  root = home;

  const hermes = path.join(root, "AppData", "Local", "hermes", "hermes-agent", "venv", "Scripts", "hermes.exe");
  const claude = path.join(root, ".claude", "local", "bin", "claude.exe");
  const codex = path.join(root, "AppData", "Local", "Programs", "OpenAI", "Codex", "bin", "codex.exe");
  for (const filePath of [hermes, claude, codex]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "");
  }

  assert.equal(service.shellCommandPath("hermes"), hermes);
  assert.equal(service.shellCommandPath("claude"), claude);
  assert.equal(service.shellCommandPath("codex"), codex);
  assert.deepEqual(calls, []);
});

test("shellCommandPath returns empty on Windows when `where` finds nothing", (t) => {
  const calls = [];
  const { service } = makeService(t, {
    platform: "win32",
    spawnSync: (command, args, options) => {
      calls.push([command, args, options]);
      return { status: 1, stdout: "", stderr: "" };
    }
  });

  assert.equal(service.shellCommandPath("codex"), "");
  assert.equal(calls.filter((call) => call[0] === "zsh").length, 0);
  assert.equal(calls[0][2].windowsHide, true);
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

test("localAgentEngines is Core-only and reports checking before Core inventory is cached", (t) => {
  let now = 1000;
  const { calls, service } = makeService(t, {
    now: () => now
  });

  const first = service.localAgentEngines();
  now += 1000;
  const cached = service.localAgentEngines();
  service.resetCache();
  const refreshed = service.localAgentEngines();

  assert.equal(calls.length, 0);
  assert.equal(first.hermes.available, false);
  assert.equal(first.hermes.source, "checking");
  assert.equal(first.claudeCode.path, "");
  assert.equal(first.codex.path, "");
  assert.notEqual(cached, first);
  assert.notEqual(refreshed, first);
  assert.equal(refreshed.hermes.source, "checking");
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

test("scanAgentsAsync returns checking inventory when Rust Core is unavailable without fallback probes", async (t) => {
  const progress = [];
  const execCalls = [];
  const { service } = makeService(t, {
    coreAgentInventory: async () => {
      throw new Error("core unavailable");
    },
    execFile: (file, args, _options, cb) => {
      execCalls.push([file, ...args]);
      return cb(new Error("fallback probe must not run"), "", "");
    }
  });

  const inventory = await service.scanAgentsAsync((agent) => progress.push(agent.id));
  const agentsById = Object.fromEntries(inventory.agents.map((agent) => [agent.id, agent]));

  assert.equal(inventory.agents.length, 3);
  assert.deepEqual(progress, ["hermes", "claude-code", "codex"]);
  assert.equal(execCalls.length, 0);
  assert.equal(inventory.summary.scanning, true);
  assert.equal(agentsById.hermes.health, "checking");
  assert.equal(agentsById["claude-code"].source, "checking");
  assert.equal(agentsById.codex.path, "");
  assert.equal(service.cachedAgentInventory().summary.scanning, true);
  assert.equal(service.cachedLocalAgentEngines().hermes.source, "checking");
});

test("scanAgentsAsync prefers Rust Core agent inventory when available", async (t) => {
  const progress = [];
  const execCalls = [];
  const { service } = makeService(t, {
    coreAgentInventory: async () => ({
      generatedAt: 123,
      agents: [
        {
          id: "hermes",
          label: "Hermes",
          commands: ["hermes"],
          command: "hermes",
          installed: false,
          usableInMia: false,
          installable: true,
          installAction: "install-hermes",
          path: "",
          version: "",
          source: "missing",
          health: "missing",
          readiness: { status: "missing", checked: true, summary: "Hermes CLI 未检测到", detail: "hermes", action: "install-hermes" }
        },
        {
          id: "claude-code",
          label: "Claude Code",
          commands: ["claude"],
          command: "claude",
          installed: false,
          usableInMia: false,
          installable: true,
          installAction: "install-claude-code",
          path: "",
          version: "",
          source: "missing",
          health: "missing",
          readiness: { status: "missing", checked: true, summary: "Claude Code CLI 未检测到", detail: "claude", action: "install-claude-code" }
        },
        {
          id: "codex",
          label: "Codex",
          commands: ["codex"],
          command: "codex",
          installed: true,
          usableInMia: true,
          installable: true,
          installAction: "",
          path: "/usr/local/bin/codex",
          version: "codex 1.0.0",
          source: "system",
          health: "ready",
          readiness: {
            status: "warning",
            checked: true,
            summary: "Codex ACP 可用性待确认",
            detail: "/managed/codex-acp --stdio: boom",
            action: "",
            errorCode: "acp_init_failed"
          }
        }
      ],
      summary: {
        installedCount: 1,
        usableCount: 1,
        missingCount: 2,
        hasUsableAgent: true,
        recommendedAction: "continue"
      }
    }),
    execFile: (...args) => {
      execCalls.push(args);
      args[3](new Error("should not run fallback probe"), "", "");
    }
  });

  const inventory = await service.scanAgentsAsync((agent) => progress.push(agent.id));
  const codex = inventory.agents.find((agent) => agent.id === "codex");

  assert.deepEqual(progress, ["hermes", "claude-code", "codex"]);
  assert.equal(execCalls.length, 0);
  assert.equal(codex.installed, true);
  assert.equal(codex.usableInMia, true);
  assert.equal(codex.health, "ready");
  assert.equal(codex.readiness.status, "warning");
  assert.equal(codex.installAction, "");
  assert.equal(codex.readiness.errorCode, "acp_init_failed");
  assert.equal(service.cachedLocalAgentEngines().codex.installAction, "");
});

test("warm runtime scans reuse cached Rust Core inventory without fallback probes", async (t) => {
  let currentTime = 1000;
  let coreCalls = 0;
  const execCalls = [];
  const { service } = makeService(t, {
    now: () => currentTime,
    coreAgentInventory: async () => {
      coreCalls += 1;
      return {
        generatedAt: currentTime,
        agents: [
          {
            id: "hermes",
            label: "Hermes",
            commands: ["hermes"],
            command: "hermes",
            installed: true,
            usableInMia: true,
            installable: true,
            installAction: "",
            path: "/Users/me/.local/bin/hermes",
            version: "Hermes Agent",
            source: "system",
            health: "ready",
            readiness: { status: "ready", checked: true, summary: "Hermes ready", detail: "", action: "" }
          },
          {
            id: "claude-code",
            label: "Claude Code",
            commands: ["claude"],
            command: "claude",
            installed: false,
            usableInMia: false,
            installable: true,
            installAction: "",
            path: "",
            version: "",
            source: "missing",
            health: "missing",
            readiness: { status: "missing", checked: true, summary: "Claude missing", detail: "", action: "" }
          },
          {
            id: "codex",
            label: "Codex",
            commands: ["codex"],
            command: "codex",
            installed: true,
            usableInMia: true,
            installable: true,
            installAction: "",
            path: "/opt/homebrew/bin/codex",
            version: "codex-cli 0.143.0",
            source: "system",
            health: "ready",
            readiness: { status: "ready", checked: true, summary: "Codex ready", detail: "", action: "" }
          }
        ],
        summary: {
          installedCount: 2,
          usableCount: 2,
          missingCount: 1,
          hasUsableAgent: true,
          recommendedAction: "continue"
        }
      };
    },
    execFile: (file, args, _options, cb) => {
      execCalls.push([file, ...args]);
      return cb(new Error("fallback probe must not run"), "", "");
    }
  });

  const first = await service.scanAgentsAsync();
  currentTime += 16000;
  const second = await service.scanAgentsAsync();
  const legacy = service.localAgentEngines();

  assert.equal(coreCalls, 1);
  assert.equal(execCalls.length, 0);
  assert.equal(second, first);
  assert.equal(legacy.hermes.path, "/Users/me/.local/bin/hermes");
  assert.equal(legacy.codex.available, true);
});

test("cachedAgentInventory returns the scanning placeholder before any scan", (t) => {
  const { service } = makeService(t);
  const cached = service.cachedAgentInventory();
  assert.equal(cached.summary.scanning, true);
  // Non-blocking read must not spawn any probe.
  assert.equal(service.cachedLocalAgentEngines().hermes.source, "checking");
});
