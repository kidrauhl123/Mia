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
    homeDir: () => path.join(dir, "home"),
    env: { PATH: "" },
    platform: "darwin",
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
    checkedAt: "2026-05-25T12:34:56.000Z"
  });
  assert.equal(service.pythonPath(), python);
  assert.equal(service.commandPath(), hermes);
  assert.deepEqual(calls, ["reset-cache"]);
});

test("probe recognizes official Windows Hermes venv launcher", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-system-hermes-win-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localAppData = path.join(root, "AppData", "Local");
  const scripts = path.join(localAppData, "hermes", "hermes-agent", "venv", "Scripts");
  const hermes = path.join(scripts, "hermes.exe");
  const python = path.join(scripts, "python.exe");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(hermes, "");
  fs.writeFileSync(python, "");
  const spawnCalls = [];
  const { service } = setup(t, {
    platform: "win32",
    homeDir: () => root,
    env: { PATH: "", LOCALAPPDATA: localAppData, APPDATA: path.join(root, "AppData", "Roaming") },
    spawnSync: (command, args, options) => {
      spawnCalls.push({ command, args, path: options?.env?.PATH || "" });
      if (command === "where" && args[0] === "hermes") {
        assert.match(options.env.PATH, /hermes[\\\/]hermes-agent[\\\/]venv[\\\/]Scripts/i);
        return { status: 0, stdout: `${hermes}\r\n`, stderr: "" };
      }
      if (command === hermes && args[0] === "--version") {
        return { status: 0, stdout: "Hermes Agent v0.11.0\n", stderr: "" };
      }
      if (command === python && args[0] === "-c") {
        assert.match(args[1], /aiohttp/);
        return { status: 0, stdout: `${python}\n`, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    }
  });

  const status = service.probe();

  assert.equal(status.available, true);
  assert.equal(status.commandPath, hermes);
  assert.equal(status.pythonPath, python);
  assert.equal(status.version, "Hermes Agent v0.11.0");
  assert.equal(spawnCalls.some((call) => call.command === "python"), false);
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
