const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  createSystemHermesService,
  readShebangPython
} = require("../src/main/system-hermes-service.js");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-system-hermes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = { home: path.join(dir, "engine-home") };
  const calls = [];
  const service = createSystemHermesService({
    runtimePaths: () => runtime,
    readJson,
    now: () => new Date("2026-05-25T12:34:56.000Z"),
    resetAgentEngineCache: () => calls.push("reset-cache"),
    ...overrides
  });
  return { calls, runtime, service };
}

test("loadCache returns pending system Hermes status when no cache exists", (t) => {
  const { service } = setup(t);

  assert.deepEqual(service.loadCache(), { available: false, pending: true });
});

test("readShebangPython resolves Python console script shebangs", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-system-hermes-script-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const direct = path.join(dir, "hermes-direct");
  const envScript = path.join(dir, "hermes-env");
  fs.writeFileSync(direct, `#!${path.join(dir, "venv", "bin", "python3")}\n`);
  fs.writeFileSync(envScript, "#!/usr/bin/env -S python3 -I\n");

  assert.equal(readShebangPython(direct), path.join(dir, "venv", "bin", "python3"));
  assert.equal(readShebangPython(envScript), "python3");
});

test("refresh records usable system Hermes command and Python while resetting Agent cache", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-system-hermes-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hermes = path.join(dir, "hermes");
  const python = path.join(dir, "venv", "bin", "python3");
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, "");
  fs.writeFileSync(hermes, `#!${python}\n`);
  fs.chmodSync(hermes, 0o755);
  const { calls, runtime, service } = setup(t, {
    spawnSync: (command, args) => {
      if (command === "zsh" && args[1] === "command -v hermes") {
        return { status: 0, stdout: `${hermes}\n`, stderr: "" };
      }
      if (command === hermes && args[0] === "--version") {
        return { status: 0, stdout: "Hermes Agent v0.11.0\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    }
  });

  await service.refresh();

  const cachePath = path.join(runtime.home, "mia-system-hermes.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, "utf8")), {
    available: true,
    pending: false,
    source: "system",
    commandPath: hermes,
    pythonPath: python,
    version: "Hermes Agent v0.11.0",
    usesMiaHome: true,
    checkedAt: "2026-05-25T12:34:56.000Z"
  });
  assert.equal(service.pythonPath(), python);
  assert.equal(service.commandPath(), hermes);
  assert.deepEqual(calls, ["reset-cache"]);
});

test("system Hermes never leaks legacy user Hermes home or dotenv values", (t) => {
  const { runtime, service } = setup(t);
  const oldHermesHome = path.join(path.dirname(runtime.home), "old-hermes");
  fs.mkdirSync(oldHermesHome, { recursive: true });
  fs.writeFileSync(path.join(oldHermesHome, ".env"), "OPENAI_API_KEY=secret\n");
  fs.mkdirSync(runtime.home, { recursive: true });
  fs.writeFileSync(path.join(runtime.home, "mia-system-hermes.json"), JSON.stringify({
    available: true,
    hermesHome: oldHermesHome
  }, null, 2));

  assert.equal(service.userHomePath(), "");
  assert.deepEqual(service.loadDotenv(), {});
});
