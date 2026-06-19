const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createAgentRuntimeProfileService } = require("../src/main/agent-runtime-profile-service.js");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-agent-profile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userHome = path.join(dir, "user-home");
  const runtime = {
    runtime: path.join(dir, "runtime"),
    home: path.join(dir, "runtime", "engine-home"),
    hermesHome: path.join(userHome, ".hermes")
  };
  fs.mkdirSync(path.join(userHome, ".codex", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(userHome, ".codex", "memory"), { recursive: true });
  fs.writeFileSync(path.join(userHome, ".codex", "auth.json"), "{}");
  fs.writeFileSync(path.join(userHome, ".codex", "history.jsonl"), "{}\n");
  fs.writeFileSync(path.join(userHome, ".codex", "session_index.jsonl"), "{}\n");
  const service = createAgentRuntimeProfileService({
    runtimePaths: () => runtime,
    homeDir: () => userHome
  });
  return { dir, runtime, userHome, service };
}

test("codex profile uses the user's native Codex home", (t) => {
  const { service, userHome } = setup(t);

  const profile = service.ensureCodexProfile();

  assert.equal(profile.env.CODEX_HOME, profile.home);
  assert.equal(profile.home, path.join(userHome, ".codex"));
  assert.equal(profile.userHome, path.join(userHome, ".codex"));
  assert.equal(fs.readFileSync(path.join(profile.home, "auth.json"), "utf8"), "{}");
  assert.equal(fs.existsSync(path.join(profile.home, "sessions")), true);
  assert.equal(fs.existsSync(path.join(profile.home, "history.jsonl")), true);
  assert.equal(fs.existsSync(path.join(profile.home, "session_index.jsonl")), true);
  assert.equal(fs.existsSync(path.join(profile.home, "memory")), true);
});

test("codex probe profile uses a Mia-owned probe home", (t) => {
  const { service, runtime, userHome } = setup(t);

  const profile = service.ensureCodexProbeProfile();

  assert.equal(profile.env.CODEX_HOME, profile.home);
  assert.equal(profile.home, path.join(runtime.runtime, "codex-probe-home"));
  assert.equal(fs.existsSync(profile.home), true);
  assert.equal(fs.existsSync(path.join(userHome, ".codex", "config.toml")), false);
});

test("hermes profile uses the user's native Hermes home with separate Mia data home", (t) => {
  const { service, runtime } = setup(t);

  const profile = service.ensureHermesProfile();

  assert.equal(profile.env.HERMES_HOME, runtime.hermesHome);
  assert.equal(profile.env.MIA_HOME, runtime.home);
  assert.notEqual(profile.env.HERMES_HOME, profile.env.MIA_HOME);
  assert.ok(fs.existsSync(runtime.hermesHome));
  assert.ok(fs.existsSync(runtime.home));
});

test("claude profile uses the engine's native default home", (t) => {
  const { service, runtime } = setup(t);

  const profile = service.claudeRunProfile();

  assert.equal(profile.home, "");
  assert.deepEqual(profile.env, {});
  assert.equal(fs.existsSync(path.join(runtime.runtime, "claude-code-home")), false);
});
