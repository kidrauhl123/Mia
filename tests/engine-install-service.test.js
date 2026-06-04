const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createEngineInstallService } = require("../src/main/engine-install-service.js");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-engine-install-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = {
    engine: path.join(dir, "hermes-engine"),
    home: path.join(dir, "engine-home"),
    pluginsDir: path.join(dir, "plugins")
  };
  const calls = [];
  const logs = [];
  const service = createEngineInstallService({
    runtimePaths: () => runtime,
    venvPythonPath: () => path.join(runtime.engine, ".venv", "bin", "python"),
    bundledPython: () => "",
    bundledSitePackages: () => "",
    buildPythonPath: () => `${runtime.pluginsDir}:${path.join(dir, "site-packages")}`,
    engineMarkerPath: () => path.join(runtime.engine, "mia-runtime.json"),
    readJson,
    appendLog: (line) => logs.push(line),
    clearLogs: () => calls.push({ type: "clearLogs" }),
    spawnSync: (command, args, options) => {
      calls.push({ type: "spawn", command, args, options });
      return { status: 0, stdout: "stdout line\n", stderr: "stderr line\n" };
    },
    initializeRuntime: () => calls.push({ type: "initializeRuntime" }),
    stopEngine: () => calls.push({ type: "stopEngine" }),
    ensureEnginePlugins: () => calls.push({ type: "ensureEnginePlugins" }),
    resetAgentEngineCache: () => calls.push({ type: "resetAgentEngineCache" }),
    getRuntimeStatus: (created) => {
      calls.push({ type: "getRuntimeStatus", created });
      return { created, engineInstalled: true };
    },
    now: () => new Date("2026-05-25T00:00:00.000Z"),
    officialPackage: "hermes-agent",
    officialRepoUrl: "https://github.com/NousResearch/hermes-agent/",
    officialRef: "release/candidate 1",
    officialUrl: "",
    officialExtras: "web",
    officialPython: "",
    devEngineSource: "",
    ...overrides
  });
  return { calls, dir, logs, runtime, service };
}

test("official package URL and requirement are derived from install config", (t) => {
  const { service } = setup(t);

  assert.equal(
    service.officialEngineUrl(),
    "https://github.com/NousResearch/hermes-agent/archive/release%2Fcandidate%201.tar.gz"
  );
  assert.equal(
    service.officialEngineRequirement("web"),
    "hermes-agent[web] @ https://github.com/NousResearch/hermes-agent/archive/release%2Fcandidate%201.tar.gz"
  );
  assert.equal(
    service.officialEngineRequirement(""),
    "hermes-agent @ https://github.com/NousResearch/hermes-agent/archive/release%2Fcandidate%201.tar.gz"
  );
});

test("official package URL uses explicit override when configured", (t) => {
  const { service } = setup(t, {
    officialUrl: " https://downloads.example.test/hermes.tar.gz "
  });

  assert.equal(service.officialEngineUrl(), "https://downloads.example.test/hermes.tar.gz");
});

test("selectOfficialEnginePython chooses the first Python 3.11+ candidate", (t) => {
  const seen = [];
  const { service } = setup(t, {
    officialPython: "custom-python",
    spawnSync: (command) => {
      seen.push(command);
      const versions = {
        "custom-python": "3.10.9",
        "python3.13": "3.13.1"
      };
      return { status: 0, stdout: `${versions[command] || "3.9.9"}\n`, stderr: "" };
    }
  });

  assert.equal(service.selectOfficialEnginePython(), "python3.13");
  assert.deepEqual(seen, ["custom-python", "python3.13"]);
});

test("selectOfficialEnginePython fails clearly when no candidate is new enough", (t) => {
  const { service } = setup(t, {
    officialPython: "custom-python",
    spawnSync: () => ({ status: 0, stdout: "3.10.12\n", stderr: "" })
  });

  assert.throws(
    () => service.selectOfficialEnginePython(),
    /Official Hermes requires Python 3\.11\+/
  );
});

test("engine source and executable prefer bundled runtime, managed venv, local source, system Hermes, then python3", (t) => {
  const bundled = setup(t, {
    bundledPython: () => "/app/hermes-runtime/bin/python",
    bundledSitePackages: () => "/app/hermes-runtime/site-packages"
  });
  assert.equal(bundled.service.enginePython(), "/app/hermes-runtime/bin/python");
  assert.equal(bundled.service.engineSource(), "bundled");

  const managed = setup(t);
  fs.mkdirSync(path.dirname(managed.service.venvPythonPath()), { recursive: true });
  fs.writeFileSync(managed.service.venvPythonPath(), "");
  assert.equal(managed.service.enginePython(), managed.service.venvPythonPath());
  assert.equal(managed.service.engineSource(), "managed");

  const local = setup(t);
  fs.mkdirSync(path.join(local.runtime.engine, "hermes_cli"), { recursive: true });
  fs.writeFileSync(path.join(local.runtime.engine, "hermes_cli", "main.py"), "");
  fs.writeFileSync(local.service.engineMarkerPath(), JSON.stringify({ source: "maintained-local-source" }));
  assert.equal(local.service.enginePython(), "python3");
  assert.equal(local.service.engineSource(), "local-source");

  const system = setup(t, {
    systemHermesPython: () => "/Users/test/.hermes/hermes-agent/venv/bin/python3"
  });
  assert.equal(system.service.enginePython(), "/Users/test/.hermes/hermes-agent/venv/bin/python3");
  assert.equal(system.service.engineSource(), "system");

  const missing = setup(t);
  assert.equal(missing.service.enginePython(), "python3");
  assert.equal(missing.service.engineSource(), "none");
});

test("isInstalled recognizes bundled, official managed, and maintained local source installs", (t) => {
  const bundled = setup(t, {
    bundledPython: () => "/app/hermes-runtime/bin/python",
    bundledSitePackages: () => "/app/hermes-runtime/site-packages"
  });
  assert.equal(bundled.service.isInstalled(), true);

  const official = setup(t);
  fs.mkdirSync(path.dirname(official.service.venvPythonPath()), { recursive: true });
  fs.writeFileSync(official.service.venvPythonPath(), "");
  fs.writeFileSync(official.service.engineMarkerPath(), JSON.stringify({ source: "official-github-archive" }));
  assert.equal(official.service.isInstalled(), true);

  const mirror = setup(t);
  fs.mkdirSync(path.dirname(mirror.service.venvPythonPath()), { recursive: true });
  fs.writeFileSync(mirror.service.venvPythonPath(), "");
  fs.writeFileSync(mirror.service.engineMarkerPath(), JSON.stringify({ source: "mia-mirror" }));
  assert.equal(mirror.service.isInstalled(), true);

  const local = setup(t);
  fs.mkdirSync(path.join(local.runtime.engine, "hermes_cli"), { recursive: true });
  fs.writeFileSync(path.join(local.runtime.engine, "hermes_cli", "main.py"), "");
  fs.writeFileSync(local.service.engineMarkerPath(), JSON.stringify({ source: "maintained-local-source" }));
  assert.equal(local.service.isInstalled(), true);

  const system = setup(t, {
    systemHermesPython: () => "/Users/test/.hermes/hermes-agent/venv/bin/python3"
  });
  assert.equal(system.service.isInstalled(), true);

  const missing = setup(t);
  assert.equal(missing.service.isInstalled(), false);
});

test("runInstallCommand logs command output, injects install environment, and throws on failures", (t) => {
  const { calls, logs, runtime, service } = setup(t, {
    spawnSync: (command, args, options) => {
      calls.push({ type: "spawn", command, args, options });
      return { status: command === "bad-python" ? 2 : 0, stdout: "ok\n", stderr: "warn\n" };
    }
  });

  service.runInstallCommand("python3", ["-m", "pip"], runtime.engine);
  assert.deepEqual(logs, ["$ python3 -m pip", "ok", "warn"]);
  assert.equal(calls[0].options.cwd, runtime.engine);
  assert.equal(calls[0].options.env.PIP_DISABLE_PIP_VERSION_CHECK, "1");
  assert.equal(calls[0].options.env.PYTHONPATH, `${runtime.pluginsDir}:${path.join(path.dirname(runtime.engine), "site-packages")}`);

  assert.throws(
    () => service.runInstallCommand("bad-python", ["-m", "pip"], runtime.engine),
    /bad-python exited with code 2/
  );
});

test("installFromDevSource replaces managed engine with filtered source copy and marker", (t) => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "mia-dev-engine-"));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.mkdirSync(path.join(source, "hermes_cli"), { recursive: true });
  fs.writeFileSync(path.join(source, "hermes_cli", "main.py"), "print('ok')\n");
  fs.mkdirSync(path.join(source, ".git"), { recursive: true });
  fs.writeFileSync(path.join(source, ".git", "ignored"), "");
  fs.mkdirSync(path.join(source, "tests"), { recursive: true });
  fs.writeFileSync(path.join(source, "tests", "ignored.py"), "");
  fs.writeFileSync(path.join(source, "kept.py"), "");

  const { calls, runtime, service } = setup(t, { devEngineSource: source });
  fs.mkdirSync(runtime.engine, { recursive: true });
  fs.writeFileSync(path.join(runtime.engine, "old.py"), "");

  const status = service.installFromDevSource();

  assert.deepEqual(calls.map((call) => call.type), [
    "initializeRuntime",
    "stopEngine",
    "ensureEnginePlugins",
    "resetAgentEngineCache",
    "getRuntimeStatus"
  ]);
  assert.deepEqual(status, { created: ["runtime/hermes-engine"], engineInstalled: true });
  assert.equal(fs.existsSync(path.join(runtime.engine, "old.py")), false);
  assert.equal(fs.existsSync(path.join(runtime.engine, "kept.py")), true);
  assert.equal(fs.existsSync(path.join(runtime.engine, ".git", "ignored")), false);
  assert.equal(fs.existsSync(path.join(runtime.engine, "tests", "ignored.py")), false);
  assert.deepEqual(readJson(service.engineMarkerPath(), {}), {
    product: "mia",
    source: "maintained-local-source",
    source_path: source,
    installed_at: "2026-05-25T00:00:00.000Z"
  });
});

test("installFromOfficialPackage builds venv, retries without extras, verifies plugins, and writes marker", (t) => {
  const seen = [];
  const { calls, logs, runtime, service } = setup(t, {
    officialPython: "/opt/python3.11",
    officialRef: "main",
    spawnSync: (command, args, options) => {
      if (args[0] === "-c" && String(args[1] || "").includes("version_info")) {
        return { status: 0, stdout: "3.11.8\n", stderr: "" };
      }
      seen.push({ command, args, cwd: options.cwd });
      if (args.includes("hermes-agent[web] @ https://github.com/NousResearch/hermes-agent/archive/main.tar.gz")) {
        return { status: 1, stdout: "", stderr: "missing extra\n" };
      }
      calls.push({ type: "spawn", command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  const status = service.installFromOfficialPackage();

  assert.deepEqual(calls.map((call) => call.type), [
    "initializeRuntime",
    "stopEngine",
    "clearLogs",
    "spawn",
    "spawn",
    "spawn",
    "spawn",
    "ensureEnginePlugins",
    "spawn",
    "resetAgentEngineCache",
    "getRuntimeStatus"
  ]);
  assert.deepEqual(seen.map((entry) => [entry.command, ...entry.args]), [
    ["/opt/python3.11", "-m", "venv", ".venv"],
    [service.venvPythonPath(), "-m", "pip", "install", "--upgrade", "pip"],
    [service.venvPythonPath(), "-m", "pip", "install", "--upgrade", "hermes-agent[web] @ https://github.com/NousResearch/hermes-agent/archive/main.tar.gz"],
    [service.venvPythonPath(), "-m", "pip", "install", "--upgrade", "hermes-agent @ https://github.com/NousResearch/hermes-agent/archive/main.tar.gz"],
    [service.venvPythonPath(), "-c", "import hermes_cli.main, fastapi, uvicorn; print('hermes_cli + web deps import OK')"],
    [service.venvPythonPath(), "-c", "import mia_plugins; print('mia_plugins import OK')"]
  ]);
  assert.match(logs.join("\n"), /Official Hermes install with extras failed; retrying base install/);
  assert.deepEqual(status, { created: ["runtime/hermes-engine"], engineInstalled: true });
  assert.match(fs.readFileSync(path.join(runtime.engine, "README.md"), "utf8"), /official Hermes source archive/);
  assert.deepEqual(readJson(service.engineMarkerPath(), {}), {
    product: "mia",
    source: "official-github-archive",
    package: "hermes-agent",
    repo: "https://github.com/NousResearch/hermes-agent",
    ref: "main",
    url: "https://github.com/NousResearch/hermes-agent/archive/main.tar.gz",
    upstream_url: "https://github.com/NousResearch/hermes-agent/archive/main.tar.gz",
    extras: "web",
    checksum_sha256: "",
    python: "/opt/python3.11",
    spec: "hermes-agent[web] @ https://github.com/NousResearch/hermes-agent/archive/main.tar.gz",
    installed_at: "2026-05-25T00:00:00.000Z"
  });
});

test("installFromOfficialPackage records source metadata and checksum", (t) => {
  const { runtime, service } = setup(t, {
    officialPython: "/opt/python3.11",
    installSourceService: {
      resolveInstallSource: () => ({
        kind: "mia-mirror",
        package: "hermes-agent",
        repo: "https://github.com/NousResearch/hermes-agent",
        ref: "main",
        url: "https://cdn.example.test/hermes.tar.gz",
        upstreamUrl: "https://github.com/NousResearch/hermes-agent/archive/main.tar.gz",
        extras: "web",
        requirement: "hermes-agent[web] @ https://cdn.example.test/hermes.tar.gz",
        baseRequirement: "hermes-agent @ https://cdn.example.test/hermes.tar.gz",
        checksum: "a".repeat(64)
      })
    },
    spawnSync: (command, args) => {
      if (args[0] === "-c" && String(args[1] || "").includes("version_info")) {
        return { status: 0, stdout: "3.11.8\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  service.installFromOfficialPackage();

  const marker = readJson(path.join(runtime.engine, "mia-runtime.json"), {});
  assert.equal(marker.source, "mia-mirror");
  assert.equal(marker.url, "https://cdn.example.test/hermes.tar.gz");
  assert.equal(marker.upstream_url, "https://github.com/NousResearch/hermes-agent/archive/main.tar.gz");
  assert.equal(marker.checksum_sha256, "a".repeat(64));
});

test("repair removes broken managed install before reinstalling", (t) => {
  const { calls, runtime, service } = setup(t, {
    officialPython: "/opt/python3.11",
    spawnSync: (command, args, options) => {
      calls.push({ type: "spawn", command, args, options });
      if (args[0] === "-c" && String(args[1] || "").includes("version_info")) {
        return { status: 0, stdout: "3.11.8\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  });
  fs.mkdirSync(runtime.engine, { recursive: true });
  fs.writeFileSync(path.join(runtime.engine, "broken.txt"), "broken");

  service.repair();

  assert.equal(fs.existsSync(path.join(runtime.engine, "broken.txt")), false);
  assert.ok(calls.some((call) => call.type === "stopEngine"));
});

test("install throws a user-visible cancellation error when signal is aborted", (t) => {
  const controller = new AbortController();
  controller.abort();
  const { service } = setup(t);

  assert.throws(
    () => service.install({ signal: controller.signal }),
    /Hermes install cancelled/
  );
});
