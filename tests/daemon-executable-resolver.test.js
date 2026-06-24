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
    resourcesPath: () => "/Applications/Mia.app/Contents/Resources",
    existsSync: () => false,
    ...overrides
  });
}

test("dev electron target keeps app path arg and is not GUI-app identity", () => {
  const r = setup({ defaultApp: () => true, execPath: () => "/node_modules/.bin/electron" }).resolve();
  assert.equal(r.kind, "electron-dev");
  assert.deepEqual(r.args, ["/dev/app.asar", "--daemon"]);
  assert.equal(r.usesGuiAppIdentity, false);
  assert.equal(r.workingDirectory, path.dirname("/node_modules/.bin/electron"));
});

test("packaged macOS prefers the nested helper when present", () => {
  const helper = "/Applications/Mia.app/Contents/Resources/Mia Core.app/Contents/MacOS/Mia Core";
  const r = setup({ existsSync: (p) => p === helper }).resolve();
  assert.equal(r.kind, "packaged-helper");
  assert.equal(r.command, helper);
  assert.deepEqual(r.args, ["--daemon"]);
  assert.equal(r.usesGuiAppIdentity, false);
});

test("packaged macOS with no helper reports legacy GUI identity", () => {
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
