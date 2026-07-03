const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  createMiaCoreResolver,
  DEFAULT_PATH,
  packagedNodePath,
  packagedCoreEntry
} = require("../src/main/daemon/executable-resolver.js");

const SRC_ROOT = path.join(__dirname, "..", "src");

test("no GUI-identity daemon target remains anywhere in the resolver / launch path", () => {
  // High-stakes deletion guard: the obsolete `legacy-gui` / `electron-dev`
  // Electron-as-daemon targets must be gone from the resolver and the launchers.
  for (const rel of [
    "main/daemon/executable-resolver.js",
    "main/daemon/process-launcher.js",
    "main/launchd-service.js"
  ]) {
    const src = fs.readFileSync(path.join(SRC_ROOT, rel), "utf8");
    assert.doesNotMatch(src, /["']legacy-gui["']/, `${rel} must not reference the deleted legacy-gui target`);
    assert.doesNotMatch(src, /["']electron-dev["']/, `${rel} must not reference the deleted electron-dev target`);
    assert.doesNotMatch(src, /usesGuiAppIdentity:\s*true/, `${rel} must never emit a GUI-identity daemon target`);
  }
});

test("startDaemonService asserts a launchable node-core target before launching the daemon", () => {
  // The wired launch path (main.js startDaemonService) must fail closed via the
  // resolver's assertLaunchable() before any launchdService/processLauncher start,
  // so a degenerate packaged build refuses rather than launching the GUI app.
  const main = fs.readFileSync(path.join(SRC_ROOT, "main.js"), "utf8");
  assert.match(
    main,
    /miaCoreResolver\.assertLaunchable\(\);[\s\S]{0,400}?(launchdService\.startDaemon\(\)|daemonProcessLauncher\.start\(\))/,
    "startDaemonService must call assertLaunchable() before launching the daemon"
  );
  // The Electron process must never become the daemon: no whenReady daemon-boot.
  assert.doesNotMatch(
    main,
    /if \(IS_DAEMON_PROCESS\) \{[\s\S]*?app\.dock/,
    "main must not contain the deleted Electron daemon-boot branch (dock.hide + sockets)"
  );
});

function setup(overrides = {}) {
  const root = path.join(path.sep, "tmp", "mia-root");
  const runtime = { root, home: path.join(root, "runtime", "engine-home") };
  return createMiaCoreResolver({
    runtimePaths: () => runtime,
    effectiveHermesHome: () => path.join(root, ".hermes"),
    appPath: () => "/dev/app.asar",
    execPath: () => "/Applications/Mia.app/Contents/MacOS/Mia",
    defaultApp: () => false,
    platform: "darwin",
    env: { HERMES_LANGUAGE: "en" },
    ...overrides
  });
}

test("node-core target launches the node binary with the Core entry and is not GUI identity", () => {
  const r = setup({
    nodePath: () => "/usr/local/bin/node",
    coreEntry: () => "/repo/src/core/mia-core.js"
  }).resolve();
  assert.equal(r.kind, "node-core");
  assert.equal(r.command, "/usr/local/bin/node");
  assert.deepEqual(r.args, ["/repo/src/core/mia-core.js", "--daemon"]);
  assert.equal(r.usesGuiAppIdentity, false);
  assert.equal(r.workingDirectory, path.dirname("/repo/src/core/mia-core.js"));
});

test("node-core is the only target on packaged macOS when a node binary resolves", () => {
  // Packaged-macOS deps with a usable node: node-core resolves, so the daemon
  // never launches under the GUI app identity (the deleted legacy-gui target).
  const r = setup({ nodePath: () => "/opt/homebrew/bin/node", coreEntry: () => "/repo/src/core/mia-core.js" }).resolve();
  assert.equal(r.kind, "node-core");
  assert.equal(r.usesGuiAppIdentity, false);
});

test("node-core env overlay stamps the target kind + identity for the launched daemon", () => {
  const env = setup({
    nodePath: () => "/usr/local/bin/node",
    coreEntry: () => "/repo/src/core/mia-core.js"
  }).daemonEnvOverlay();
  assert.equal(env.MIA_DAEMON_TARGET_KIND, "node-core");
  assert.equal(env.MIA_DAEMON_USES_GUI_IDENTITY, "0");
  // The unchanged runtime contract is still carried.
  assert.equal(env.MIA_DAEMON, "1");
});

test("an unresolved macOS target never stamps GUI identity (legacy-gui deleted)", () => {
  // Degenerate packaged macOS (no node, no resourcesPath): the daemon target is
  // `unresolved`, NOT a GUI-identity daemon. The env overlay must never stamp
  // usesGuiAppIdentity = 1 anymore — there is no GUI-identity daemon path left.
  const env = setup().daemonEnvOverlay();
  assert.equal(env.MIA_DAEMON_TARGET_KIND, "unresolved");
  assert.equal(env.MIA_DAEMON_USES_GUI_IDENTITY, "0");
});

test("empty nodePath on packaged macOS is unresolved, never a GUI daemon", () => {
  // Dev always has a node on PATH so node-core wins; this exercises the degenerate
  // packaged-macOS case where neither an injected node nor a derived one resolves.
  const packaged = setup({ nodePath: () => "" }).resolve();
  assert.equal(packaged.kind, "unresolved");
  assert.equal(packaged.usesGuiAppIdentity, false);
});

test("missing coreEntry alone is unresolved on macOS even with a node binary", () => {
  const r = setup({ nodePath: () => "/usr/local/bin/node", coreEntry: () => "" }).resolve();
  assert.equal(r.kind, "unresolved");
  assert.equal(r.usesGuiAppIdentity, false);
});

test("assertLaunchable passes node-core and fails closed on unresolved", () => {
  assert.doesNotThrow(() => setup({
    nodePath: () => "/usr/local/bin/node",
    coreEntry: () => "/repo/src/core/mia-core.js"
  }).assertLaunchable());
  assert.equal(
    setup({ nodePath: () => "/usr/local/bin/node", coreEntry: () => "/repo/src/core/mia-core.js" }).assertLaunchable().kind,
    "node-core"
  );
  // Degenerate packaged macOS: refuse rather than launch the GUI app as daemon.
  assert.throws(() => setup().assertLaunchable(), /GUI app identity/);
});

test("packaged macOS without a node-core target is unresolved (no GUI identity)", () => {
  const r = setup().resolve();
  assert.equal(r.kind, "unresolved");
  assert.equal(r.command, "/Applications/Mia.app/Contents/MacOS/Mia");
  assert.equal(r.usesGuiAppIdentity, false);
});

test("packaged non-macOS uses bundled cli without GUI identity", () => {
  const r = setup({ platform: "linux", execPath: () => "/opt/mia/mia" }).resolve();
  assert.equal(r.kind, "bundled-cli");
  assert.deepEqual(r.args, ["--daemon"]);
  assert.equal(r.usesGuiAppIdentity, false);
});

test("daemon env overlay carries the unchanged runtime contract", () => {
  const env = setup().daemonEnvOverlay();
  assert.equal(env.MIA_DAEMON, "1");
  assert.equal(env.MIA_HOME, path.join(path.sep, "tmp", "mia-root", "runtime", "engine-home"));
  assert.equal(env.MIA_USER_DATA_DIR, path.join(path.sep, "tmp", "mia-root", "daemon-profile"));
  assert.equal(env.HERMES_HOME, path.join(path.sep, "tmp", "mia-root", ".hermes"));
  assert.equal(env.HERMES_LANGUAGE, "en");
  assert.equal(env.PYTHONUNBUFFERED, "1");
});

test("assertLaunchable throws for the unresolved macOS target but passes node-core", () => {
  assert.throws(() => setup().assertLaunchable(), /GUI app identity/);
  assert.doesNotThrow(() => setup({
    nodePath: () => "/usr/local/bin/node",
    coreEntry: () => "/repo/src/core/mia-core.js"
  }).assertLaunchable());
});

test("assertLaunchable returns the node-core resolution for launchable targets", () => {
  const r = setup({
    nodePath: () => "/usr/local/bin/node",
    coreEntry: () => "/repo/src/core/mia-core.js"
  }).assertLaunchable();
  assert.equal(r.kind, "node-core");
});

test("node-core daemon target carries a source fingerprint for dev replacement", () => {
  const resolver = setup({
    nodePath: () => "/usr/local/bin/node",
    coreEntry: () => "/repo/src/core/mia-core.js",
    sourceFingerprint: () => "source-a"
  });

  assert.equal(resolver.describe().sourceFingerprint, "source-a");
  assert.equal(resolver.daemonEnvOverlay().MIA_DAEMON_SOURCE_FINGERPRINT, "source-a");
});

test("packaged path helpers derive the bundled node + unpacked Core entry from resourcesPath", () => {
  const res = "/Applications/Mia.app/Contents/Resources";
  assert.equal(packagedNodePath(res, "darwin"), path.join(res, "mia-node"));
  assert.equal(packagedNodePath(res, "win32"), path.join(res, "mia-node.exe"));
  assert.equal(
    packagedCoreEntry(res),
    path.join(res, "app.asar.unpacked", "src", "core", "mia-core.js")
  );
  // Empty resourcesPath (dev) yields "" so the node-core branch falls through.
  assert.equal(packagedNodePath(""), "");
  assert.equal(packagedCoreEntry(""), "");
  assert.equal(packagedNodePath(undefined), "");
});

test("packaged build resolves node-core from resourcesPath when nodePath/coreEntry are not injected", () => {
  // Mirrors packaged main.js wiring: process.defaultApp false → injected
  // nodePath/coreEntry are "", and the resolver derives both from resourcesPath.
  const res = "/Applications/Mia.app/Contents/Resources";
  const r = setup({
    defaultApp: () => false,
    nodePath: () => "",
    coreEntry: () => "",
    resourcesPath: () => res,
    existsSync: () => true
  }).resolve();
  assert.equal(r.kind, "node-core");
  assert.equal(r.command, path.join(res, "mia-node"));
  assert.deepEqual(r.args, [path.join(res, "app.asar.unpacked", "src", "core", "mia-core.js"), "--daemon"]);
  assert.equal(r.usesGuiAppIdentity, false);
  assert.equal(r.workingDirectory, path.dirname(path.join(res, "app.asar.unpacked", "src", "core", "mia-core.js")));
});

test("packaged Windows build accepts the existing extensionless mia-node resource", () => {
  const res = "C:\\Program Files\\Mia\\resources";
  const node = path.join(res, "mia-node");
  const core = path.join(res, "app.asar.unpacked", "src", "core", "mia-core.js");
  const r = setup({
    platform: "win32",
    defaultApp: () => false,
    nodePath: () => "",
    coreEntry: () => "",
    resourcesPath: () => res,
    existsSync: (candidate) => candidate === node || candidate === core
  }).resolve();

  assert.equal(r.kind, "node-core");
  assert.equal(r.command, node);
  assert.deepEqual(r.args, [core, "--daemon"]);
});

test("packaged build with no resourcesPath and no injected node is unresolved (fail closed)", () => {
  // Defensive: if resourcesPath is somehow empty in a packaged build, the node-core
  // branch must NOT fire (no bogus node path), and the target is `unresolved` so
  // assertLaunchable() refuses — it must NEVER fall back to a GUI-identity daemon.
  const r = setup({ defaultApp: () => false, nodePath: () => "", coreEntry: () => "", resourcesPath: () => "" }).resolve();
  assert.equal(r.kind, "unresolved");
  assert.equal(r.usesGuiAppIdentity, false);
  assert.throws(() => setup({ defaultApp: () => false, nodePath: () => "", coreEntry: () => "", resourcesPath: () => "" }).assertLaunchable(), /GUI app identity/);
});

test("packaged build with a MISSING bundled node/core falls to unresolved (fail fast, no timeout)", () => {
  // The bundle is incomplete (mia-node or the unpacked Core entry not on disk).
  // The DERIVED packaged paths must be existence-checked so the target is
  // `unresolved` (assertLaunchable throws clearly) rather than a node-core target
  // pointing at a non-existent command that would silently time out on /health.
  const res = "/Applications/Mia.app/Contents/Resources";
  const missing = setup({
    defaultApp: () => false,
    nodePath: () => "",
    coreEntry: () => "",
    resourcesPath: () => res,
    existsSync: () => false
  });
  assert.equal(missing.resolve().kind, "unresolved");
  assert.throws(() => missing.assertLaunchable(), /GUI app identity/);

  // Only the node binary is missing → still unresolved (no partial node-core).
  const onlyNodeMissing = setup({
    defaultApp: () => false,
    nodePath: () => "",
    coreEntry: () => "",
    resourcesPath: () => res,
    existsSync: (p) => p.endsWith(path.join("src", "core", "mia-core.js"))
  });
  assert.equal(onlyNodeMissing.resolve().kind, "unresolved");
});

test("injected dev node/core paths are trusted without an existence check", () => {
  // Dev/test inject absolute paths the caller already resolved; they must NOT be
  // existence-checked (the repo Core entry / `which node` result are trusted), so
  // a default fs.existsSync against a fake /repo path still yields node-core.
  const r = setup({
    nodePath: () => "/usr/local/bin/node",
    coreEntry: () => "/repo/src/core/mia-core.js"
  }).resolve();
  assert.equal(r.kind, "node-core");
});

test("describe exposes basename and identity flag for diagnostics", () => {
  const d = setup().describe();
  assert.equal(d.kind, "unresolved");
  assert.equal(d.command, "Mia");
  assert.equal(d.usesGuiAppIdentity, false);
  assert.equal(typeof DEFAULT_PATH, "string");
});
