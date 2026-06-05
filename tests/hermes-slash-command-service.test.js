const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createHermesSlashCommandService } = require("../src/main/hermes-slash-command-service.js");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-hermes-slash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = {
    engine: path.join(dir, "hermes-engine"),
    home: path.join(dir, "engine-home"),
    userProfile: path.join(dir, "engine-home", "mia-user.json")
  };
  const calls = [];
  const service = createHermesSlashCommandService({
    runtimePaths: () => runtime,
    readJson,
    defaultUserProfile: () => ({ displayName: "Boss" }),
    cleanRunSessionId: (sessionId, botId) => `clean-${botId}-${sessionId}`,
    enginePython: () => path.join(dir, "python"),
    effectiveHermesHome: () => path.join(dir, "hermes-home"),
    buildPythonPath: () => path.join(dir, "plugins"),
    env: { PATH: "/usr/bin" },
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "noise\n{\"content\":\"设置完成\"}\n", stderr: "" };
    },
    ...overrides
  });
  return { calls, dir, runtime, service };
}

test("run sends a localized Hermes slash-command script with session and user context", (t) => {
  const { calls, dir, runtime, service } = setup(t);
  fs.mkdirSync(path.dirname(runtime.userProfile), { recursive: true });
  fs.writeFileSync(runtime.userProfile, JSON.stringify({ displayName: "Alice" }));

  const content = service.run({
    text: "/model gpt-5",
    bot: { key: "f1", name: "小明" },
    sessionId: "s9"
  });

  assert.equal(content, "设置完成");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, path.join(dir, "python"));
  assert.equal(calls[0].args[0], "-c");
  assert.match(calls[0].args[1], /_MIA_ZH_I18N/);
  assert.match(calls[0].args[1], /GatewayRunner/);
  assert.match(calls[0].args[1], /MessageEvent/);
  assert.deepEqual(JSON.parse(calls[0].args[2]), {
    text: "/model gpt-5",
    sessionKey: "clean-f1-s9",
    chatName: "小明",
    userName: "Alice"
  });
  assert.equal(calls[0].options.cwd, runtime.engine);
  assert.equal(calls[0].options.env.HERMES_HOME, path.join(dir, "hermes-home"));
  assert.equal(calls[0].options.env.MIA_HOME, runtime.home);
  assert.equal(calls[0].options.env.HERMES_LANGUAGE, "zh");
  assert.equal(calls[0].options.env.GATEWAY_ALLOW_ALL_USERS, "true");
  assert.equal(calls[0].options.env.PYTHONPATH, path.join(dir, "plugins"));
  assert.equal(calls[0].options.timeout, 45000);
});

test("run falls back to Mia names when bot or profile names are empty", (t) => {
  const { calls, service } = setup(t, {
    defaultUserProfile: () => ({ displayName: "" }),
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "{\"content\":\"\"}\n", stderr: "" };
    }
  });

  assert.equal(service.run({ text: "/status", bot: { key: "f1", name: "" }, sessionId: "" }), "");
  assert.deepEqual(JSON.parse(calls[0].args[2]), {
    text: "/status",
    sessionKey: "clean-f1-",
    chatName: "Mia",
    userName: "Mia"
  });
});

test("run surfaces process errors and non-zero exits", (t) => {
  const failed = setup(t, {
    spawnSync: () => ({ status: 1, stdout: "", stderr: "command failed" })
  });
  assert.throws(
    () => failed.service.run({ text: "/bad", bot: { key: "f1" }, sessionId: "s1" }),
    /command failed/
  );

  const errored = setup(t, {
    spawnSync: () => ({ error: new Error("spawn boom"), status: null, stdout: "", stderr: "" })
  });
  assert.throws(
    () => errored.service.run({ text: "/bad", bot: { key: "f1" }, sessionId: "s1" }),
    /spawn boom/
  );
});
