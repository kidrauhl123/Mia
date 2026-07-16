const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createEngineInstallService } = require("../src/main/engine-install-service.js");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(filePath, value = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function writeEngineFixture(engineId, runtimeRoot) {
  if (engineId === "hermes") {
    writeFile(path.join(runtimeRoot, "python", "python.exe"));
    fs.mkdirSync(path.join(runtimeRoot, "site-packages"), { recursive: true });
    writeJson(path.join(runtimeRoot, "runtime-build-info.json"), {
      target: "win32-x64",
      hermesVersion: "2026.7.7.2",
      hermesPackageVersion: "0.18.2",
      hermesWheelSha256: "8f02155cfc84b28bd98551cd18dffec0efa9ec070dd08f90f1a850f1c779492f",
      pythonVersion: "3.11.13"
    });
    return;
  }
  if (engineId === "claude-code") {
    writeFile(path.join(runtimeRoot, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js"), "// acp");
    writeFile(path.join(runtimeRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe"));
    writeJson(path.join(runtimeRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "manifest.json"), { version: "2.1.211" });
    writeJson(path.join(runtimeRoot, "manifest.json"), {
      entrypoint: "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
      protocol: "claude-code-cli",
      version: "0.59.0"
    });
    return;
  }
  writeFile(path.join(runtimeRoot, "node_modules", "@agentclientprotocol", "codex-acp", "dist", "index.js"), "// acp");
  writeFile(path.join(runtimeRoot, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"));
  writeJson(path.join(runtimeRoot, "node_modules", "@openai", "codex", "package.json"), { version: "0.144.5" });
  writeJson(path.join(runtimeRoot, "manifest.json"), {
    entrypoint: "node_modules/@agentclientprotocol/codex-acp/dist/index.js",
    protocol: "codex-app-server",
    version: "1.1.4"
  });
}

function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-engine-fallback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const managedRoot = path.join(root, "resources", "managed-resources");
  const hermesRoot = path.join(root, "resources", "hermes-runtime");
  const calls = [];
  let systemPython = "";
  const serviceOverrides = { ...overrides };
  const seedResources = serviceOverrides.seedResources !== false;
  delete serviceOverrides.seedResources;

  const claudeRuntime = path.join(managedRoot, "acp", "claude-agent-acp", "0.59.0", "win32-x64");
  const codexRuntime = path.join(managedRoot, "acp", "codex-acp", "1.1.4", "win32-x64");
  const bundledPython = path.join(hermesRoot, "python", "python.exe");
  const sitePackages = path.join(hermesRoot, "site-packages");
  if (seedResources) {
    writeEngineFixture("hermes", hermesRoot);
    writeEngineFixture("claude-code", claudeRuntime);
    writeEngineFixture("codex", codexRuntime);
  }

  const service = createEngineInstallService({
    runtimePaths: () => ({
      home,
      engine: path.join(root, "engine"),
      engineBackups: path.join(root, "resources"),
      managedResources: managedRoot,
      engineFallbacks: path.join(home, "mia-engine-fallbacks.json")
    }),
    platform: "win32",
    arch: "x64",
    managedResourceRoots: [managedRoot],
    bundledHermesRuntimeDir: () => hermesRoot,
    bundledPython: () => bundledPython,
    bundledSitePackages: () => sitePackages,
    buildPythonPath: () => [path.join(root, "plugins"), sitePackages].join(";"),
    systemHermesPython: () => systemPython,
    spawnSync: (command, args, options) => {
      calls.push({ type: "spawn", command, args, options });
      return { status: 0, stdout: "import OK\n", stderr: "" };
    },
    appendLog: (line) => calls.push({ type: "log", line }),
    clearLogs: () => calls.push({ type: "clearLogs" }),
    initializeRuntime: () => {
      calls.push({ type: "initializeRuntime" });
      fs.mkdirSync(path.join(root, "engine"), { recursive: true });
    },
    stopEngine: () => calls.push({ type: "stopEngine" }),
    ensureEnginePlugins: () => calls.push({ type: "ensureEnginePlugins" }),
    resetAgentEngineCache: () => calls.push({ type: "resetAgentEngineCache" }),
    getRuntimeStatus: (created) => ({ created }),
    now: () => new Date("2026-07-16T00:00:00.000Z"),
    ...serviceOverrides
  });

  return {
    calls,
    home,
    hermesRoot,
    managedRoot,
    service,
    setSystemPython(value) { systemPython = value; }
  };
}

test("activating all three engines records Mia-private fixed versions without running installers", async (t) => {
  const { calls, home, service } = setup(t);
  const progress = [];

  await service.installEngineAsync("hermes", { onProgress: (value) => progress.push(value) });
  await service.installEngineAsync("claude-code", { onProgress: (value) => progress.push(value) });
  await service.installEngineAsync("codex", { onProgress: (value) => progress.push(value) });

  const state = JSON.parse(fs.readFileSync(path.join(home, "mia-engine-fallbacks.json"), "utf8"));
  assert.equal(state.engines.hermes.version, "2026.7.7.2");
  assert.equal(state.engines["claude-code"].version, "2.1.211");
  assert.equal(state.engines["claude-code"].runtimeVersion, "0.59.0");
  assert.equal(state.engines.codex.version, "0.144.5");
  assert.equal(state.engines.codex.runtimeVersion, "1.1.4");
  assert.equal(calls.some((call) => call.type === "spawn"), false);
  assert.equal(progress.filter((value) => value.status === "success").length, 3);
});

test("system Hermes remains preferred after the Mia stable fallback is enabled", (t) => {
  const fixture = setup(t);
  fixture.service.installEngine("hermes");
  assert.equal(fixture.service.engineSource(), "mia-managed");

  fixture.setSystemPython("C:\\Users\\mia\\hermes\\python.exe");
  assert.equal(fixture.service.enginePython(), "C:\\Users\\mia\\hermes\\python.exe");
  assert.equal(fixture.service.engineSource(), "system");
  assert.equal(fixture.service.isInstalled(), true);
});

test("Hermes activation initializes only Mia-owned runtime state and plugins", (t) => {
  const { calls, service } = setup(t);
  const result = service.installEngine("hermes");

  assert.deepEqual(result, { created: ["hermes"] });
  assert.ok(calls.some((call) => call.type === "initializeRuntime"));
  assert.ok(calls.some((call) => call.type === "ensureEnginePlugins"));
  assert.ok(calls.some((call) => call.type === "resetAgentEngineCache"));
});

test("Claude and Codex activation does not initialize or alter Hermes", (t) => {
  const { calls, service } = setup(t);
  service.installEngine("claude-code");
  service.installEngine("codex");

  assert.equal(calls.some((call) => call.type === "initializeRuntime"), false);
  assert.equal(calls.some((call) => call.type === "ensureEnginePlugins"), false);
});

test("activation fails before writing state when a downloaded stable resource is incomplete", (t) => {
  const fixture = setup(t);
  const codexBinary = path.join(
    fixture.managedRoot,
    "acp",
    "codex-acp",
    "1.1.4",
    "win32-x64",
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe"
  );
  fs.rmSync(codexBinary);

  assert.throws(() => fixture.service.installEngine("codex"), /Codex 备份不完整/);
  assert.equal(fixture.service.fallbackEnabled("codex"), false);
});

test("missing engines are downloaded one at a time from the Mia backup", async (t) => {
  const downloads = [];
  const fixture = setup(t, {
    seedResources: false,
    backupClient: {
      async install(options) {
        downloads.push({
          engineId: options.engineId,
          targetKey: options.targetKey,
          destination: options.destination,
          version: options.expectedVersion,
          runtimeVersion: options.expectedRuntimeVersion
        });
        writeEngineFixture(options.engineId, options.destination);
        await options.prepare(options.destination);
        await options.validate(options.destination);
      }
    }
  });

  await fixture.service.installEngineAsync("claude-code");

  assert.deepEqual(downloads.map((item) => item.engineId), ["claude-code"]);
  assert.equal(downloads[0].targetKey, "win32-x64");
  assert.equal(downloads[0].version, "2.1.211");
  assert.equal(downloads[0].runtimeVersion, "0.59.0");
  assert.equal(fixture.service.fallbackEnabled("claude-code"), true);
  assert.equal(fixture.service.fallbackEnabled("hermes"), false);
  assert.equal(fs.existsSync(fixture.hermesRoot), false);
});

test("backup download failure does not enable the engine", async (t) => {
  const fixture = setup(t, {
    seedResources: false,
    backupClient: {
      async install() {
        throw new Error("backup checksum mismatch");
      }
    }
  });

  await assert.rejects(() => fixture.service.installEngineAsync("codex"), /checksum mismatch/);
  assert.equal(fixture.service.fallbackEnabled("codex"), false);
});

test("Hermes API check runs the selected private Python with the sealed site-packages", (t) => {
  const { calls, service } = setup(t);
  service.installEngine("hermes");

  const check = service.hermesApiRuntimeCheck();
  const spawn = calls.find((call) => call.type === "spawn");
  assert.equal(check.ok, true);
  assert.match(spawn.command, /hermes-runtime[\\/]python[\\/]python\.exe$/);
  assert.match(spawn.options.env.PYTHONPATH, /hermes-runtime[\\/]site-packages/);
  assert.equal(spawn.options.windowsHide, true);
});

test("activation rejects cancellation and unknown engines", async (t) => {
  const { service } = setup(t);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => service.installEngineAsync("codex", { signal: controller.signal }),
    /activation cancelled/
  );
  assert.throws(() => service.installEngine("openclaw"), /not installable/);
});
