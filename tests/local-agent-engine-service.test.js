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

test("localAgentEngines reports Hermes default and caches CLI probes until reset", (t) => {
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

  assert.equal(first.hermes.available, true);
  assert.deepEqual(first.hermes.system, { available: false, disabled: true });
  assert.equal(first.claudeCode.path, "/bin/claude");
  assert.equal(first.claudeCode.version, "claude 1.2.3");
  assert.equal(first.codex.path, "/bin/codex");
  assert.equal(first.codex.version, "codex 2.3.4");
  assert.equal(cached, first);
  assert.notEqual(refreshed, first);
  assert.equal(calls.filter((call) => call[0] === "zsh").length, 4);
});
