const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const { createMiaCoreResolver, DEFAULT_PATH } = require("../src/main/daemon/executable-resolver.js");

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

test("node-core is preferred over the packaged GUI target when a node binary resolves", () => {
  // Same packaged-macOS deps as the legacy-gui case, but with a usable node:
  // node-core wins, so the daemon never launches under the GUI app identity.
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

test("legacy-gui env overlay stamps GUI identity = 1", () => {
  const env = setup().daemonEnvOverlay();
  assert.equal(env.MIA_DAEMON_TARGET_KIND, "legacy-gui");
  assert.equal(env.MIA_DAEMON_USES_GUI_IDENTITY, "1");
});

test("empty nodePath falls back to electron-dev / legacy-gui", () => {
  // Dev: empty node + defaultApp → electron-dev.
  const dev = setup({ nodePath: () => "", defaultApp: () => true, execPath: () => "/node_modules/.bin/electron" }).resolve();
  assert.equal(dev.kind, "electron-dev");
  // Packaged macOS: empty node → legacy-gui (the GUI fallback is retained).
  const packaged = setup({ nodePath: () => "" }).resolve();
  assert.equal(packaged.kind, "legacy-gui");
});

test("missing coreEntry alone falls back even with a node binary", () => {
  const r = setup({ nodePath: () => "/usr/local/bin/node", coreEntry: () => "", defaultApp: () => true }).resolve();
  assert.equal(r.kind, "electron-dev");
});

test("assertLaunchable passes node-core and throws legacy-gui", () => {
  assert.doesNotThrow(() => setup({
    nodePath: () => "/usr/local/bin/node",
    coreEntry: () => "/repo/src/core/mia-core.js"
  }).assertLaunchable());
  assert.equal(
    setup({ nodePath: () => "/usr/local/bin/node", coreEntry: () => "/repo/src/core/mia-core.js" }).assertLaunchable().kind,
    "node-core"
  );
  assert.throws(() => setup().assertLaunchable(), /GUI app identity/);
});

test("dev electron target keeps app path arg and is not GUI-app identity", () => {
  const r = setup({ defaultApp: () => true, execPath: () => "/node_modules/.bin/electron" }).resolve();
  assert.equal(r.kind, "electron-dev");
  assert.deepEqual(r.args, ["/dev/app.asar", "--daemon"]);
  assert.equal(r.usesGuiAppIdentity, false);
  assert.equal(r.workingDirectory, path.dirname("/node_modules/.bin/electron"));
});

test("packaged macOS still reports legacy GUI identity until the node-core launcher lands", () => {
  const r = setup().resolve();
  assert.equal(r.kind, "legacy-gui");
  assert.equal(r.command, "/Applications/Mia.app/Contents/MacOS/Mia");
  assert.deepEqual(r.args, ["--daemon"]);
  assert.equal(r.usesGuiAppIdentity, true);
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

test("assertLaunchable throws for the legacy GUI target but passes otherwise", () => {
  assert.throws(() => setup().assertLaunchable(), /GUI app identity/);
  assert.doesNotThrow(() => setup({ defaultApp: () => true }).assertLaunchable());
});

test("assertLaunchable returns the resolution for launchable targets", () => {
  const r = setup({ defaultApp: () => true }).assertLaunchable();
  assert.equal(r.kind, "electron-dev");
});

test("describe exposes basename and identity flag for diagnostics", () => {
  const d = setup().describe();
  assert.equal(d.kind, "legacy-gui");
  assert.equal(d.command, "Mia");
  assert.equal(d.usesGuiAppIdentity, true);
  assert.equal(typeof DEFAULT_PATH, "string");
});
