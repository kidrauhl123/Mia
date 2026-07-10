const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  createMiaCoreResolver,
  DEFAULT_PATH,
  devRustCorePath,
  findExecutableOnPath,
  packagedRustCorePath,
  repoBundledRustCorePath
} = require("../src/main/mia-core/process-resolver.js");

const SRC_ROOT = path.join(__dirname, "..", "src");
const LEGACY_DAEMON_ENV = `MIA_${"DAEMON"}`;
const LEGACY_DAEMON_TARGET_KIND_ENV = `${LEGACY_DAEMON_ENV}_TARGET_KIND`;

test("no GUI-identity daemon target remains anywhere in the resolver / launch path", () => {
  for (const rel of [
    "main/mia-core/process-resolver.js",
    "main/mia-core/process-launcher.js",
    "main/launchd-service.js"
  ]) {
    const src = fs.readFileSync(path.join(SRC_ROOT, rel), "utf8");
    assert.doesNotMatch(src, /["']legacy-gui["']/, `${rel} must not reference the deleted legacy-gui target`);
    assert.doesNotMatch(src, /["']electron-dev["']/, `${rel} must not reference the deleted electron-dev target`);
    assert.doesNotMatch(src, /usesGuiAppIdentity:\s*true/, `${rel} must never emit a GUI-identity Core target`);
  }
});

test("startDaemonService asserts a launchable rust-core target before launching Core", () => {
  const main = fs.readFileSync(path.join(SRC_ROOT, "main.js"), "utf8");
  const startBody = main.slice(
    main.indexOf("async function startDaemonService()"),
    main.indexOf("async function stopDaemonService()")
  );
  assert.match(startBody, /if \(daemonStartPromise\) return daemonStartPromise;/);
  assert.match(startBody, /daemonStartPromise = \(async \(\) => \{/);
  assert.ok(
    startBody.indexOf("await launchdService.cleanupLegacyNodeCore();") >= 0,
    "startDaemonService must call legacy Node daemon cleanup"
  );
  assert.ok(
    startBody.indexOf("await launchdService.cleanupLegacyNodeCore();") < startBody.indexOf("miaCoreResolver.assertLaunchable();"),
    "startDaemonService must clean legacy Node daemon jobs before launching Rust Core"
  );
  assert.match(
    main,
    /miaCoreResolver\.assertLaunchable\(\);[\s\S]{0,400}?(launchdService\.startCore\(\)|miaCoreProcessLauncher\.start\(\))/,
    "startDaemonService must call assertLaunchable() before launching Core"
  );
  assert.ok(
    startBody.indexOf("miaCoreProcessLauncher.stopObservedProcess(existing.pid);") > startBody.indexOf("miaCoreResolver.assertLaunchable();")
      && startBody.indexOf("miaCoreProcessLauncher.stopObservedProcess(existing.pid);") < startBody.indexOf("miaCoreProcessLauncher.start()"),
    "process-mode start must stop a stale observed Core before starting a replacement"
  );
  assert.ok(
    startBody.indexOf("await miaCoreProcessLauncher.stopCurrentProcess();") > startBody.indexOf("const ping = await waitForReusableCore"),
    "process-mode start must clean up a spawned Core process when it times out"
  );
  assert.doesNotMatch(
    main,
    /if \(IS_CORE_PROCESS\) \{[\s\S]*?app\.dock/,
    "main must not contain the deleted Electron daemon-boot branch"
  );
});

test("update install path removes legacy Node daemon before quitting", () => {
  const main = fs.readFileSync(path.join(SRC_ROOT, "main.js"), "utf8");
  assert.match(
    main,
    /prepareForUpdateInstall:\s*async\s*\(\)\s*=>\s*\{[\s\S]{0,260}?await launchdService\.cleanupLegacyNodeCore\(\);[\s\S]{0,260}?await stopDaemonService\(\);/,
    "update install preparation must remove legacy Node daemon before stopping Core"
  );
});

test("stopDaemonService cleans process-mode Core children as well as launchd jobs", () => {
  const main = fs.readFileSync(path.join(SRC_ROOT, "main.js"), "utf8");
  const stopBody = main.slice(
    main.indexOf("async function stopDaemonService()"),
    main.indexOf("function appendCloudLog")
  );

  assert.match(stopBody, /if \(daemonStartPromise\)/);
  assert.match(stopBody, /await launchdService\.cleanupLegacyNodeCore\(\);/);
  assert.match(stopBody, /await miaCoreProcessLauncher\.stopObservedProcess\(observed\.pid\);/);
  assert.match(stopBody, /await miaCoreProcessLauncher\.stopCurrentProcess\(\);/);
});

test("dev verification can start Core as a process without touching launchd", () => {
  const main = fs.readFileSync(path.join(SRC_ROOT, "main.js"), "utf8");

  assert.match(main, /function shouldUseLaunchdForCore\(\)/);
  assert.match(main, /MIA_CORE_START_MODE/);
  assert.match(main, /MIA_FORCE_MAIN_WINDOW/);
  assert.match(main, /!process\.defaultApp/);
  assert.match(main, /coreStartMode\(\) !== "process"/);
  assert.match(main, /const onboarding = !forceMainWindow && !Boolean/);
  assert.match(main, /MIA_CORE_START_MODE=process: starting Mia Rust Core as a child process/);
  assert.match(main, /Mia Rust Core reachable at \$\{ping\.baseUrl\}/);
});

test("startDaemonService uses a larger timeout budget in development mode", () => {
  const main = fs.readFileSync(path.join(SRC_ROOT, "main.js"), "utf8");
  const startBody = main.slice(
    main.indexOf("async function startDaemonService()"),
    main.indexOf("async function stopDaemonService()")
  );

  assert.match(main, /function coreStartTimeoutMs\(/);
  assert.match(main, /MIA_CORE_START_TIMEOUT_MS/);
  assert.match(startBody, /await waitForReusableCore\(/);
  assert.doesNotMatch(startBody, /for \(let i = 0; i < 20; i \+= 1\)/);
});

function setup(overrides = {}) {
  const root = path.join(path.sep, "tmp", "mia-root");
  const runtime = {
    root,
    home: path.join(root, "runtime", "core-home"),
    engine: path.join(root, "runtime", "hermes-engine"),
    pluginsDir: path.join(root, "runtime", "mia-plugins")
  };
  return createMiaCoreResolver({
    runtimePaths: () => runtime,
    effectiveHermesHome: () => path.join(root, ".hermes"),
    appPath: () => "/dev/app.asar",
    execPath: () => "/Applications/Mia.app/Contents/MacOS/Mia",
    defaultApp: () => true,
    platform: "darwin",
    arch: "arm64",
    env: { HERMES_LANGUAGE: "en" },
    parentPid: () => 4321,
    repoRoot: () => "/repo",
    appVersion: () => "0.1.39",
    ...overrides
  });
}

test("dev rust-core target prefers repo bundled binary when present", () => {
  const repoRoot = path.resolve("/repo");
  const bundled = repoBundledRustCorePath(repoRoot, "darwin", "arm64");
  const r = setup({
    existsSync: (candidate) => candidate === bundled
  }).resolve();

  assert.equal(r.kind, "rust-core");
  assert.equal(r.command, bundled);
  assert.deepEqual(r.args.slice(0, 5), ["serve", "--host", "127.0.0.1", "--port", "27861"]);
  assert.equal(r.workingDirectory, path.dirname(bundled));
  assert.equal(r.usesGuiAppIdentity, false);
});

test("dev rust-core target prefers built debug binary over stale repo bundled binary", () => {
  const repoRoot = path.resolve("/repo");
  const bundled = repoBundledRustCorePath(repoRoot, "darwin", "arm64");
  const debug = devRustCorePath(repoRoot, "debug", "darwin");
  const r = setup({
    existsSync: (candidate) => candidate === bundled || candidate === debug
  }).resolve();

  assert.equal(r.kind, "rust-core");
  assert.equal(r.command, debug);
  assert.equal(r.workingDirectory, path.dirname(debug));
});

test("dev rust-core target prefers built debug binary after bundled resources", () => {
  const repoRoot = path.resolve("/repo");
  const debug = devRustCorePath(repoRoot, "debug", "darwin");
  const r = setup({
    existsSync: (candidate) => candidate === debug
  }).resolve();

  assert.equal(r.kind, "rust-core");
  assert.equal(r.command, debug);
  assert.deepEqual(r.args.slice(0, 5), ["serve", "--host", "127.0.0.1", "--port", "27861"]);
  assert.equal(r.workingDirectory, path.dirname(debug));
  assert.equal(r.usesGuiAppIdentity, false);
});

test("dev rust-core target is unresolved when no binary is prepared", () => {
  const r = setup({ existsSync: () => false }).resolve();
  const repoRoot = path.resolve("/repo");

  assert.equal(r.kind, "unresolved");
  assert.equal(r.command, "/Applications/Mia.app/Contents/MacOS/Mia");
  assert.equal(r.workingDirectory, repoRoot);
  assert.equal(r.usesGuiAppIdentity, false);
});

test("dev rust-core target can resolve mia-core from PATH", () => {
  const bin = "/opt/homebrew/bin/mia-core";
  const r = setup({
    existsSync: (candidate) => candidate === bin,
    pathLookup: () => bin
  }).resolve();

  assert.equal(r.kind, "rust-core");
  assert.equal(r.command, bin);
  assert.equal(r.workingDirectory, path.dirname(bin));
  assert.deepEqual(r.args.slice(0, 5), ["serve", "--host", "127.0.0.1", "--port", "27861"]);
});

test("dev rust-core target description includes the owning Electron parent pid", () => {
  const repoRoot = path.resolve("/repo");
  const debug = devRustCorePath(repoRoot, "debug", "darwin");
  const description = setup({
    env: { HERMES_LANGUAGE: "en" },
    existsSync: (candidate) => candidate === debug
  }).describe();

  assert.equal(description.kind, "rust-core");
  assert.equal(description.parentPid, 4321);
});

test("MIA_CORE_BIN overrides dev and packaged resource resolution", () => {
  const bin = "/opt/mia-core/bin/mia-core";
  const r = setup({ env: { MIA_CORE_BIN: bin, HERMES_LANGUAGE: "zh" } }).resolve();

  assert.equal(r.kind, "rust-core");
  assert.equal(r.command, bin);
  assert.deepEqual(r.args.slice(0, 7), [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    "27861",
    "--data-dir",
    path.join(path.sep, "tmp", "mia-root", "runtime", "core-home")
  ]);
  assert.equal(r.workingDirectory, path.dirname(bin));
});

test("packaged build resolves rust-core from bundled resources", () => {
  const res = "/Applications/Mia.app/Contents/Resources";
  const bundled = packagedRustCorePath(res, "darwin", "arm64");
  const r = setup({
    defaultApp: () => false,
    resourcesPath: () => res,
    existsSync: (candidate) => candidate === bundled
  }).resolve();

  assert.equal(r.kind, "rust-core");
  assert.equal(r.command, bundled);
  assert.equal(r.workingDirectory, path.dirname(bundled));
  assert.deepEqual(r.args.slice(0, 5), ["serve", "--host", "127.0.0.1", "--port", "27861"]);
});

test("packaged helper derives resources/bundled-mia-core platform arch path", () => {
  const res = "/Applications/Mia.app/Contents/Resources";
  assert.equal(
    packagedRustCorePath(res, "darwin", "arm64"),
    path.join(res, "bundled-mia-core", "darwin-arm64", "mia-core")
  );
  assert.equal(packagedRustCorePath("", "darwin", "arm64"), "");
  assert.equal(packagedRustCorePath(undefined, "darwin", "arm64"), "");
});

test("packaged build with a missing bundled rust-core is unresolved and fail-closed", () => {
  const missing = setup({
    defaultApp: () => false,
    resourcesPath: () => "/Applications/Mia.app/Contents/Resources",
    existsSync: () => false
  });

  assert.equal(missing.resolve().kind, "unresolved");
  assert.equal(missing.resolve().usesGuiAppIdentity, false);
  assert.throws(() => missing.assertLaunchable(), /Rust Core executable not found/);
});

test("core env overlay stamps rust-core target identity without daemon aliases", () => {
  const repoRoot = path.resolve("/repo");
  const debug = devRustCorePath(repoRoot, "debug", "darwin");
  const env = setup({
    env: { HERMES_LANGUAGE: "en" },
    existsSync: (candidate) => candidate === debug
  }).coreEnvOverlay();

  assert.equal(env.MIA_CORE, "1");
  assert.equal(env.MIA_CORE_HOST, "127.0.0.1");
  assert.equal(env.MIA_CORE_PORT, "27861");
  assert.equal(env.MIA_CORE_HOME, path.join(path.sep, "tmp", "mia-root", "runtime", "core-home"));
  assert.equal(env.MIA_CORE_APP_VERSION, "0.1.39");
  assert.equal(env.MIA_OFFICIAL_SKILLS_DIR, path.join(repoRoot, "skills", "_builtin"));
  assert.equal(env.MIA_MANAGED_AGENT_RESOURCES, [
    path.join(path.sep, "tmp", "mia-root", "runtime", "core-home", "managed-resources"),
    path.join(repoRoot, "resources", "managed-resources")
  ].join(path.delimiter));
  assert.equal(env.MIA_CORE_RESOURCES_PATH, "");
  assert.equal(env.MIA_HERMES_ENGINE_DIR, path.join(path.sep, "tmp", "mia-root", "runtime", "hermes-engine"));
  assert.equal(env.MIA_PLUGINS_DIR, path.join(path.sep, "tmp", "mia-root", "runtime", "mia-plugins"));
  assert.equal(env.MIA_CORE_TARGET_KIND, "rust-core");
  assert.equal(env.MIA_CORE_TARGET_COMMAND, "mia-core");
  assert.equal(env.MIA_CORE_WORKING_DIRECTORY, path.dirname(debug));
  assert.equal(env.MIA_CORE_USES_GUI_IDENTITY, "0");
  assert.equal(env.HERMES_LANGUAGE, "en");
  assert.equal(env.PYTHONUNBUFFERED, "1");
  assert.equal(env[LEGACY_DAEMON_ENV], undefined);
  assert.equal(env.MIA_USER_DATA_DIR, undefined);
  assert.equal(env[LEGACY_DAEMON_TARGET_KIND_ENV], undefined);
});

test("core settings override Core host and port in args and env overlay", () => {
  const repoRoot = path.resolve("/repo");
  const debug = devRustCorePath(repoRoot, "debug", "darwin");
  const resolver = setup({
    env: { HERMES_LANGUAGE: "en" },
    existsSync: (candidate) => candidate === debug,
    coreSettings: () => ({ host: "localhost", port: 27991 })
  });
  const r = resolver.resolve();
  const env = resolver.coreEnvOverlay();
  const serveIndex = r.args.indexOf("serve");

  assert.deepEqual(r.args.slice(serveIndex, serveIndex + 5), ["serve", "--host", "localhost", "--port", "27991"]);
  assert.equal(env.MIA_CORE_HOST, "localhost");
  assert.equal(env.MIA_CORE_PORT, "27991");
});

test("core env overlay points packaged Rust Core at extraResource official skills", () => {
  const res = "/Applications/Mia.app/Contents/Resources";
  const bundled = packagedRustCorePath(res, "darwin", "arm64");
  const env = setup({
    defaultApp: () => false,
    resourcesPath: () => res,
    existsSync: (candidate) => candidate === bundled
  }).coreEnvOverlay();

  assert.equal(env.MIA_OFFICIAL_SKILLS_DIR, path.join(res, "skills", "_builtin"));
  assert.equal(env.MIA_MANAGED_AGENT_RESOURCES, [
    path.join(path.sep, "tmp", "mia-root", "runtime", "core-home", "managed-resources"),
    path.join(res, "managed-resources"),
    path.join(res, "bundled-aioncore", "darwin-arm64", "managed-resources"),
    path.join(path.resolve("/repo"), "resources", "managed-resources")
  ].join(path.delimiter));
  assert.equal(env.MIA_CORE_RESOURCES_PATH, res);
});

test("assertLaunchable returns rust-core resolution for launchable targets", () => {
  const repoRoot = path.resolve("/repo");
  const debug = devRustCorePath(repoRoot, "debug", "darwin");
  const r = setup({
    env: { HERMES_LANGUAGE: "en" },
    existsSync: (candidate) => candidate === debug
  }).assertLaunchable();
  assert.equal(r.kind, "rust-core");
});

test("Core resolver exposes the default launch PATH", () => {
  assert.equal(typeof DEFAULT_PATH, "string");
});

test("PATH lookup finds the first prepared mia-core executable", () => {
  const found = findExecutableOnPath("mia-core", ["/missing", "/bin"].join(path.delimiter), {
    statSync: (candidate) => {
      if (candidate === path.join("/bin", "mia-core")) return { isFile: () => true };
      throw new Error("missing");
    }
  });

  assert.equal(found, path.join("/bin", "mia-core"));
});

test("describe exposes basename and identity flag for diagnostics", () => {
  const repoRoot = path.resolve("/repo");
  const debug = devRustCorePath(repoRoot, "debug", "darwin");
  const d = setup({
    env: { HERMES_LANGUAGE: "en" },
    existsSync: (candidate) => candidate === debug
  }).describe();
  assert.equal(d.kind, "rust-core");
  assert.equal(d.command, "mia-core");
  assert.equal(d.usesGuiAppIdentity, false);
});
