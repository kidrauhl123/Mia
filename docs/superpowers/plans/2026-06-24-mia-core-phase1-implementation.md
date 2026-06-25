# Mia Core Phase 1 Implementation Plan

> Superseded on 2026-06-25 by `docs/adr/2026-06-25-mia-core-runtime-owner.md` and `docs/superpowers/plans/2026-06-25-mia-core-runtime-cutover.md`.
> This document is retained for historical context only; do not implement new daemon-first work from it.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop packaged macOS daemon launches from using the GUI `Mia.app` executable identity, while preserving the current daemon Interface and preparing for the full Mia Core backend split.

**Architecture:** Add one deep Mia Core executable resolver Module, then route both launchd and detached spawn through it. Packaged macOS must use a nested `Mia Core.app` helper with distinct identity; development and non-macOS paths stay compatible but visible as legacy/dev launch targets. The existing local daemon HTTP/SSE Interface, runtime-home ownership, update stop guard, and version replacement semantics remain intact.

**Tech Stack:** Electron main process CommonJS, macOS launchd plist generation, electron-builder `afterPack`, `node:test`, filesystem-based packaging tests, existing `npm run check`.

## Global Constraints

- Phase 1 must not rewrite the daemon runtime into Rust, Go, Swift, or a pure Node backend.
- Packaged macOS must not fall back to `Mia.app/Contents/MacOS/Mia --daemon` when the helper is missing.
- Development builds may use the existing Electron dev command as a visible fallback.
- Non-macOS paths must keep current behavior or fail with explicit diagnostics.
- The daemon local control Interface must remain compatible: local HTTP/SSE, token auth, `MIA_DAEMON=1`, `MIA_HOME`, isolated `MIA_USER_DATA_DIR`, status, and version.
- Keep the first-layer updater guard: GUI stops daemon before `quitAndInstall`.
- Do not run release packaging, signing, notarization, or publishing commands without explicit user approval.
- Tests must use temporary directories and must not write real `~/Library/Application Support/Mia` data.
- Commit after each task with a Chinese summary.

---

## File Structure

Create:

- `src/main/daemon/core-executable-resolver.js`: resolves daemon launch target and metadata for packaged helper, Electron dev, and legacy non-macOS paths.
- `tests/daemon-core-executable-resolver.test.js`: resolver behavior tests.
- `scripts/after-pack-mia-core-helper.js`: electron-builder `afterPack` hook that creates nested `Mia Core.app` for macOS packages.
- `tests/mia-core-helper-packaging.test.js`: filesystem tests for the helper packaging hook.

Modify:

- `src/main/launchd-service.js`: consume resolver for daemon `ProgramArguments`, `WorkingDirectory`, and daemon environment metadata.
- `src/main/daemon/process-launcher.js`: consume resolver for detached daemon spawn.
- `src/main/daemon/control-server.js`: expose sanitized daemon launch target diagnostics in status.
- `src/main.js`: instantiate the resolver and pass it into launchd and detached spawn modules.
- `tests/launchd-service.test.js`: assert launchd uses resolver output and packaged macOS no longer points at GUI executable.
- `tests/daemon-process-launcher.test.js`: assert detached spawn uses resolver output.
- `tests/daemon-control-server.test.js`: assert status includes launch target diagnostics.
- `tests/renderer-shell.test.js`: assert `main.js` wires the resolver into launch modules.
- `package.json`: add `build.afterPack`.
- `tests/packaging-hermes-runtime.test.js`: assert macOS packaging uses the Mia Core helper hook.
- `docs/adr/2026-06-12-desktop-single-owner-daemon.md`: add a note that the accepted single-owner model now requires independent daemon executable identity and points to the Phase 1 spec.

---

### Task 1: Mia Core Executable Resolver

**Files:**
- Create: `src/main/daemon/core-executable-resolver.js`
- Test: `tests/daemon-core-executable-resolver.test.js`

**Interfaces:**
- Produces: `MIA_CORE_HELPER_APP_NAME = "Mia Core.app"`.
- Produces: `MIA_CORE_HELPER_EXECUTABLE_NAME = "Mia Core"`.
- Produces: `MIA_CORE_HELPER_BUNDLE_ID = "ai.mia.core"`.
- Produces: `createMiaCoreExecutableResolver(deps).resolveDaemonTarget() -> { kind, command, args, workingDirectory, usesGuiAppIdentity, helperAppPath }`.
- Produces: `daemonTargetEnvironment(target) -> { MIA_DAEMON_EXECUTABLE_KIND, MIA_DAEMON_USES_GUI_APP_IDENTITY, MIA_DAEMON_COMMAND_BASENAME }`.
- Consumed by: Tasks 2, 3, and 4.

- [ ] **Step 1: Write failing resolver tests**

Add `tests/daemon-core-executable-resolver.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  MIA_CORE_HELPER_APP_NAME,
  MIA_CORE_HELPER_EXECUTABLE_NAME,
  MIA_CORE_HELPER_BUNDLE_ID,
  createMiaCoreExecutableResolver,
  daemonTargetEnvironment
} = require("../src/main/daemon/core-executable-resolver.js");

function tempApp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-resolver-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const appRoot = path.join(dir, "Mia.app");
  const mainExecutable = path.join(appRoot, "Contents", "MacOS", "Mia");
  const helperExecutable = path.join(
    appRoot,
    "Contents",
    "Library",
    "LoginItems",
    MIA_CORE_HELPER_APP_NAME,
    "Contents",
    "MacOS",
    MIA_CORE_HELPER_EXECUTABLE_NAME
  );
  fs.mkdirSync(path.dirname(mainExecutable), { recursive: true });
  fs.writeFileSync(mainExecutable, "main");
  return { dir, appRoot, mainExecutable, helperExecutable };
}

test("packaged macOS resolves the nested Mia Core helper", (t) => {
  const app = tempApp(t);
  fs.mkdirSync(path.dirname(app.helperExecutable), { recursive: true });
  fs.writeFileSync(app.helperExecutable, "helper");

  const resolver = createMiaCoreExecutableResolver({
    platform: "darwin",
    defaultApp: () => false,
    execPath: () => app.mainExecutable,
    appPath: () => path.join(app.appRoot, "Contents", "Resources", "app.asar"),
    existsSync: fs.existsSync
  });

  const target = resolver.resolveDaemonTarget();

  assert.equal(MIA_CORE_HELPER_BUNDLE_ID, "ai.mia.core");
  assert.equal(target.kind, "packaged-helper");
  assert.equal(target.command, app.helperExecutable);
  assert.deepEqual(target.args, ["--daemon"]);
  assert.equal(target.workingDirectory, path.dirname(app.helperExecutable));
  assert.equal(target.usesGuiAppIdentity, false);
  assert.equal(target.helperAppPath.endsWith(path.join("Library", "LoginItems", "Mia Core.app")), true);
});

test("packaged macOS fails clearly when the helper is missing", (t) => {
  const app = tempApp(t);
  const resolver = createMiaCoreExecutableResolver({
    platform: "darwin",
    defaultApp: () => false,
    execPath: () => app.mainExecutable,
    appPath: () => path.join(app.appRoot, "Contents", "Resources", "app.asar"),
    existsSync: fs.existsSync
  });

  assert.throws(
    () => resolver.resolveDaemonTarget(),
    /Mia Core helper executable was not found/
  );
});

test("Electron development resolves the current dev command visibly", (t) => {
  const app = tempApp(t);
  const resolver = createMiaCoreExecutableResolver({
    platform: "darwin",
    defaultApp: () => true,
    execPath: () => "/usr/local/bin/electron",
    appPath: () => app.appRoot,
    existsSync: fs.existsSync
  });

  const target = resolver.resolveDaemonTarget();

  assert.equal(target.kind, "electron-dev");
  assert.equal(target.command, "/usr/local/bin/electron");
  assert.deepEqual(target.args, [app.appRoot, "--daemon"]);
  assert.equal(target.usesGuiAppIdentity, true);
});

test("non-macOS packaged builds keep the legacy command with explicit metadata", (t) => {
  const app = tempApp(t);
  const resolver = createMiaCoreExecutableResolver({
    platform: "win32",
    defaultApp: () => false,
    execPath: () => path.join(app.dir, "Mia.exe"),
    appPath: () => path.join(app.dir, "resources", "app.asar"),
    existsSync: fs.existsSync
  });

  const target = resolver.resolveDaemonTarget();

  assert.equal(target.kind, "legacy-gui");
  assert.deepEqual(target.args, ["--daemon"]);
  assert.equal(target.usesGuiAppIdentity, true);
});

test("daemonTargetEnvironment exposes sanitized launch metadata", () => {
  const env = daemonTargetEnvironment({
    kind: "packaged-helper",
    command: "/Applications/Mia.app/Contents/Library/LoginItems/Mia Core.app/Contents/MacOS/Mia Core",
    usesGuiAppIdentity: false
  });

  assert.deepEqual(env, {
    MIA_DAEMON_EXECUTABLE_KIND: "packaged-helper",
    MIA_DAEMON_USES_GUI_APP_IDENTITY: "0",
    MIA_DAEMON_COMMAND_BASENAME: "Mia Core"
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/daemon-core-executable-resolver.test.js
```

Expected: fail with `Cannot find module '../src/main/daemon/core-executable-resolver.js'`.

- [ ] **Step 3: Implement the resolver Module**

Add `src/main/daemon/core-executable-resolver.js`:

```js
"use strict";

const path = require("node:path");
const fs = require("node:fs");

const MIA_CORE_HELPER_APP_NAME = "Mia Core.app";
const MIA_CORE_HELPER_EXECUTABLE_NAME = "Mia Core";
const MIA_CORE_HELPER_BUNDLE_ID = "ai.mia.core";

function normalizePlatform(value) {
  return String(value || process.platform);
}

function helperPathsForExecutable(executablePath) {
  const macosDir = path.dirname(executablePath);
  const contentsDir = path.dirname(macosDir);
  const helperAppPath = path.join(contentsDir, "Library", "LoginItems", MIA_CORE_HELPER_APP_NAME);
  const helperExecutablePath = path.join(helperAppPath, "Contents", "MacOS", MIA_CORE_HELPER_EXECUTABLE_NAME);
  return { helperAppPath, helperExecutablePath };
}

function target(kind, command, args, usesGuiAppIdentity, extra = {}) {
  return {
    kind,
    command,
    args,
    workingDirectory: path.dirname(command),
    usesGuiAppIdentity: Boolean(usesGuiAppIdentity),
    ...extra
  };
}

function createMiaCoreExecutableResolver(deps = {}) {
  const platform = () => normalizePlatform(typeof deps.platform === "function" ? deps.platform() : deps.platform);
  const execPath = typeof deps.execPath === "function" ? deps.execPath : () => process.execPath;
  const appPath = typeof deps.appPath === "function" ? deps.appPath : () => "";
  const defaultApp = typeof deps.defaultApp === "function" ? deps.defaultApp : () => Boolean(process.defaultApp);
  const existsSync = typeof deps.existsSync === "function" ? deps.existsSync : fs.existsSync;

  function resolveDaemonTarget() {
    const command = execPath();
    if (defaultApp()) {
      return target("electron-dev", command, [appPath(), "--daemon"], true);
    }
    if (platform() === "darwin") {
      const paths = helperPathsForExecutable(command);
      if (!existsSync(paths.helperExecutablePath)) {
        throw new Error(`Mia Core helper executable was not found at ${paths.helperExecutablePath}. Reinstall Mia or rebuild the macOS package.`);
      }
      return target("packaged-helper", paths.helperExecutablePath, ["--daemon"], false, {
        helperAppPath: paths.helperAppPath
      });
    }
    return target("legacy-gui", command, ["--daemon"], true);
  }

  return {
    resolveDaemonTarget
  };
}

function daemonTargetEnvironment(launchTarget = {}) {
  return {
    MIA_DAEMON_EXECUTABLE_KIND: String(launchTarget.kind || "unknown"),
    MIA_DAEMON_USES_GUI_APP_IDENTITY: launchTarget.usesGuiAppIdentity ? "1" : "0",
    MIA_DAEMON_COMMAND_BASENAME: path.basename(String(launchTarget.command || ""))
  };
}

module.exports = {
  MIA_CORE_HELPER_APP_NAME,
  MIA_CORE_HELPER_EXECUTABLE_NAME,
  MIA_CORE_HELPER_BUNDLE_ID,
  createMiaCoreExecutableResolver,
  daemonTargetEnvironment,
  helperPathsForExecutable
};
```

- [ ] **Step 4: Run resolver tests**

Run:

```bash
node --test tests/daemon-core-executable-resolver.test.js
```

Expected: all resolver tests pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/main/daemon/core-executable-resolver.js tests/daemon-core-executable-resolver.test.js
git commit -m "feat(daemon): 添加 Mia Core 可执行解析器"
```

---

### Task 2: Launch Adapters Use The Resolver

**Files:**
- Modify: `src/main/launchd-service.js`
- Modify: `src/main/daemon/process-launcher.js`
- Test: `tests/launchd-service.test.js`
- Test: `tests/daemon-process-launcher.test.js`

**Interfaces:**
- Consumes: `resolver.resolveDaemonTarget()`.
- Consumes: `daemonTargetEnvironment(target)`.
- Produces: `launchdService.daemonLaunchTarget() -> target`.
- Produces: `daemonProcessLauncher.daemonLaunchTarget() -> target`.

- [ ] **Step 1: Write failing launch adapter tests**

In `tests/launchd-service.test.js`, add a resolver to `setup()` defaults:

```js
const helperTarget = {
  kind: "packaged-helper",
  command: "/Applications/Mia.app/Contents/Library/LoginItems/Mia Core.app/Contents/MacOS/Mia Core",
  args: ["--daemon"],
  workingDirectory: "/Applications/Mia.app/Contents/Library/LoginItems/Mia Core.app/Contents/MacOS",
  usesGuiAppIdentity: false
};
```

Pass it into `createLaunchdService`:

```js
daemonExecutableResolver: {
  resolveDaemonTarget: () => helperTarget
},
```

Update the daemon plist test to assert:

```js
assert.deepEqual(args, [helperTarget.command, "--daemon"]);
assert.doesNotMatch(args.join(" "), /Contents\/MacOS\/Mia --daemon/);
assert.match(plist, /<key>MIA_DAEMON_EXECUTABLE_KIND<\/key>\n      <string>packaged-helper<\/string>/);
assert.match(plist, /<key>MIA_DAEMON_USES_GUI_APP_IDENTITY<\/key>\n      <string>0<\/string>/);
assert.match(plist, new RegExp(`<string>${escapeRe(helperTarget.workingDirectory)}</string>`));
```

Add a missing-helper launchd test:

```js
test("packaged macOS daemon launch fails before writing a legacy GUI plist when helper is missing", async (t) => {
  const { service, runtime } = setup(t, {
    daemonExecutableResolver: {
      resolveDaemonTarget: () => {
        throw new Error("Mia Core helper executable was not found at /missing/Mia Core");
      }
    }
  });

  await assert.rejects(() => service.startDaemon(), /Mia Core helper executable was not found/);
  assert.equal(fs.existsSync(runtime.daemonLaunchAgent), false);
});
```

In `tests/daemon-process-launcher.test.js`, update `setup()` to pass:

```js
daemonExecutableResolver: {
  resolveDaemonTarget: () => ({
    kind: "electron-dev",
    command: path.join(dir, "electron.exe"),
    args: [path.join(dir, "Mia App"), "--daemon"],
    workingDirectory: dir,
    usesGuiAppIdentity: true
  })
},
```

Add assertions:

```js
assert.equal(calls[0].options.env.MIA_DAEMON_EXECUTABLE_KIND, "electron-dev");
assert.equal(calls[0].options.env.MIA_DAEMON_USES_GUI_APP_IDENTITY, "1");
assert.equal(calls[0].options.env.MIA_DAEMON_COMMAND_BASENAME, "electron.exe");
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/launchd-service.test.js tests/daemon-process-launcher.test.js
```

Expected: fail because both launch modules still build commands directly from `execPath()`.

- [ ] **Step 3: Refactor launchd daemon command generation**

In `src/main/launchd-service.js`, import:

```js
const { daemonTargetEnvironment } = require("./daemon/core-executable-resolver.js");
```

Inside `createLaunchdService`, define:

```js
  const daemonExecutableResolver = deps.daemonExecutableResolver || {
    resolveDaemonTarget: () => {
      const args = [execPath()];
      if (defaultApp()) args.push(appPath());
      args.push("--daemon");
      return {
        kind: defaultApp() ? "electron-dev" : "legacy-gui",
        command: args[0],
        args: args.slice(1),
        workingDirectory: path.dirname(args[0]),
        usesGuiAppIdentity: true
      };
    }
  };

  function daemonLaunchTarget() {
    return daemonExecutableResolver.resolveDaemonTarget();
  }
```

Replace `daemonProgramArguments()` with:

```js
  function daemonProgramArguments() {
    const launchTarget = daemonLaunchTarget();
    return [launchTarget.command, ...(launchTarget.args || [])];
  }
```

Merge metadata into `daemonEnvironment()`:

```js
      PYTHONUNBUFFERED: "1",
      ...daemonTargetEnvironment(daemonLaunchTarget())
```

Replace `daemonWorkingDirectory()` with:

```js
  function daemonWorkingDirectory() {
    return daemonLaunchTarget().workingDirectory;
  }
```

Return `daemonLaunchTarget` from `createLaunchdService`.

- [ ] **Step 4: Refactor detached spawn**

In `src/main/daemon/process-launcher.js`, import:

```js
const { daemonTargetEnvironment } = require("./core-executable-resolver.js");
```

Inside `createDaemonProcessLauncher`, define a fallback resolver:

```js
  const daemonExecutableResolver = deps.daemonExecutableResolver || {
    resolveDaemonTarget: () => {
      const args = [];
      if (defaultApp()) args.push(appPath());
      args.push("--daemon");
      return {
        kind: defaultApp() ? "electron-dev" : "legacy-gui",
        command: execPath(),
        args,
        workingDirectory: path.dirname(execPath()),
        usesGuiAppIdentity: true
      };
    }
  };

  function daemonLaunchTarget() {
    return daemonExecutableResolver.resolveDaemonTarget();
  }
```

Replace `daemonProgramArguments()`:

```js
  function daemonProgramArguments() {
    const launchTarget = daemonLaunchTarget();
    return [launchTarget.command, ...(launchTarget.args || [])];
  }
```

Merge metadata into `daemonEnvironment()`:

```js
      PYTHONUNBUFFERED: "1",
      ...daemonTargetEnvironment(daemonLaunchTarget())
```

Replace `daemonWorkingDirectory()`:

```js
  function daemonWorkingDirectory() {
    return daemonLaunchTarget().workingDirectory;
  }
```

Update `start()`:

```js
    const launchTarget = daemonLaunchTarget();
    const child = spawn(launchTarget.command, launchTarget.args || [], {
      cwd: launchTarget.workingDirectory,
      detached: true,
      stdio: "ignore",
      env: daemonEnvironment()
    });
```

Return `daemonLaunchTarget` from the launcher.

- [ ] **Step 5: Run adapter tests**

Run:

```bash
node --test tests/launchd-service.test.js tests/daemon-process-launcher.test.js
```

Expected: all launch adapter tests pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/main/launchd-service.js src/main/daemon/process-launcher.js tests/launchd-service.test.js tests/daemon-process-launcher.test.js
git commit -m "refactor(daemon): 统一后台进程启动入口"
```

---

### Task 3: Main Wiring And Launch Diagnostics

**Files:**
- Modify: `src/main.js`
- Modify: `src/main/daemon/control-server.js`
- Test: `tests/renderer-shell.test.js`
- Test: `tests/daemon-control-server.test.js`

**Interfaces:**
- Consumes: `createMiaCoreExecutableResolver`.
- Produces daemon status field: `launchTarget: { kind, command, usesGuiAppIdentity }`.

- [ ] **Step 1: Write failing wiring and status tests**

In `tests/renderer-shell.test.js`, add source assertions:

```js
assert.match(mainSource, /createMiaCoreExecutableResolver/);
assert.match(mainSource, /const miaCoreExecutableResolver\s*=\s*createMiaCoreExecutableResolver/);
assert.match(mainSource, /daemonExecutableResolver:\s*miaCoreExecutableResolver/);
```

In `tests/daemon-control-server.test.js`, add to the status test:

```js
const server = createDaemonControlServer({
  // existing setup values...
  env: {
    MIA_DAEMON_EXECUTABLE_KIND: "packaged-helper",
    MIA_DAEMON_COMMAND_BASENAME: "Mia Core",
    MIA_DAEMON_USES_GUI_APP_IDENTITY: "0"
  }
});

const status = server.status();
assert.deepEqual(status.launchTarget, {
  kind: "packaged-helper",
  command: "Mia Core",
  usesGuiAppIdentity: false
});
```

If the existing setup helper is easier to use, pass the `env` override through `setup(t, { env: ... })`.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/renderer-shell.test.js tests/daemon-control-server.test.js
```

Expected: fail because `main.js` does not wire the resolver and control server status does not expose `launchTarget`.

- [ ] **Step 3: Wire resolver in `main.js`**

Import near other daemon imports:

```js
const { createMiaCoreExecutableResolver } = require("./main/daemon/core-executable-resolver.js");
```

Create the resolver after `runtimePaths`/path services are initialized and before launchd/process launcher construction:

```js
const miaCoreExecutableResolver = createMiaCoreExecutableResolver({
  platform: process.platform,
  execPath: () => process.execPath,
  appPath: () => app.getAppPath(),
  defaultApp: () => Boolean(process.defaultApp),
  existsSync: fs.existsSync
});
```

Pass it into both modules:

```js
daemonExecutableResolver: miaCoreExecutableResolver,
```

Keep existing `execPath`, `appPath`, and `defaultApp` dependencies only where tests or fallback behavior still require them.

- [ ] **Step 4: Add control-server launch diagnostics**

In `src/main/daemon/control-server.js`, add `env = process.env` to the factory dependencies.

Add helper:

```js
  function launchTargetStatus() {
    return {
      kind: String(env.MIA_DAEMON_EXECUTABLE_KIND || ""),
      command: String(env.MIA_DAEMON_COMMAND_BASENAME || ""),
      usesGuiAppIdentity: String(env.MIA_DAEMON_USES_GUI_APP_IDENTITY || "") === "1"
    };
  }
```

Add to `status()`:

```js
      launchTarget: launchTargetStatus(),
```

Do not include full executable paths or tokens in this status field.

- [ ] **Step 5: Run wiring and status tests**

Run:

```bash
node --test tests/renderer-shell.test.js tests/daemon-control-server.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/main.js src/main/daemon/control-server.js tests/renderer-shell.test.js tests/daemon-control-server.test.js
git commit -m "feat(daemon): 暴露 Mia Core 启动诊断"
```

---

### Task 4: macOS Packaging Hook Creates `Mia Core.app`

**Files:**
- Create: `scripts/after-pack-mia-core-helper.js`
- Test: `tests/mia-core-helper-packaging.test.js`

**Interfaces:**
- Consumes constants from `src/main/daemon/core-executable-resolver.js`.
- Produces: `createMiaCoreHelperApp({ appPath, productName, appId, log }) -> { helperAppPath, helperExecutablePath }`.
- Produces: default electron-builder hook `module.exports = async function afterPackMiaCoreHelper(context)`.

- [ ] **Step 1: Write failing packaging hook tests**

Add `tests/mia-core-helper-packaging.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  MIA_CORE_HELPER_APP_NAME,
  MIA_CORE_HELPER_EXECUTABLE_NAME
} = require("../src/main/daemon/core-executable-resolver.js");
const {
  createMiaCoreHelperApp,
  helperInfoPlist
} = require("../scripts/after-pack-mia-core-helper.js");

function writeFakeApp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-helper-package-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const appPath = path.join(dir, "Mia.app");
  const contents = path.join(appPath, "Contents");
  fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
  fs.writeFileSync(path.join(contents, "MacOS", "Mia"), "main executable");
  fs.chmodSync(path.join(contents, "MacOS", "Mia"), 0o755);
  fs.writeFileSync(path.join(contents, "Resources", "app.asar"), "asar");
  fs.writeFileSync(path.join(contents, "Info.plist"), helperInfoPlist({
    productName: "Mia",
    bundleId: "ai.mia.app",
    executableName: "Mia",
    isHelper: false
  }));
  return { dir, appPath };
}

test("createMiaCoreHelperApp creates a nested helper app with distinct identity", (t) => {
  const { appPath } = writeFakeApp(t);
  const result = createMiaCoreHelperApp({
    appPath,
    productName: "Mia",
    appId: "ai.mia.app",
    log: () => {}
  });

  const expectedHelper = path.join(appPath, "Contents", "Library", "LoginItems", MIA_CORE_HELPER_APP_NAME);
  assert.equal(result.helperAppPath, expectedHelper);
  assert.equal(result.helperExecutablePath, path.join(expectedHelper, "Contents", "MacOS", MIA_CORE_HELPER_EXECUTABLE_NAME));
  assert.equal(fs.existsSync(result.helperExecutablePath), true);
  assert.equal(fs.statSync(result.helperExecutablePath).mode & 0o111, 0o111);

  const plist = fs.readFileSync(path.join(expectedHelper, "Contents", "Info.plist"), "utf8");
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>ai\.mia\.core<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>Mia Core<\/string>/);
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
});

test("createMiaCoreHelperApp replaces stale helper content", (t) => {
  const { appPath } = writeFakeApp(t);
  const first = createMiaCoreHelperApp({ appPath, productName: "Mia", appId: "ai.mia.app", log: () => {} });
  fs.writeFileSync(path.join(first.helperAppPath, "stale.txt"), "stale");

  createMiaCoreHelperApp({ appPath, productName: "Mia", appId: "ai.mia.app", log: () => {} });

  assert.equal(fs.existsSync(path.join(first.helperAppPath, "stale.txt")), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/mia-core-helper-packaging.test.js
```

Expected: fail because `scripts/after-pack-mia-core-helper.js` does not exist.

- [ ] **Step 3: Implement the packaging hook**

Add `scripts/after-pack-mia-core-helper.js`:

```js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  MIA_CORE_HELPER_APP_NAME,
  MIA_CORE_HELPER_EXECUTABLE_NAME,
  MIA_CORE_HELPER_BUNDLE_ID
} = require("../src/main/daemon/core-executable-resolver.js");

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function helperInfoPlist({ productName, bundleId, executableName, isHelper }) {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>CFBundleDevelopmentRegion</key>`,
    `  <string>en</string>`,
    `  <key>CFBundleExecutable</key>`,
    `  <string>${xmlEscape(executableName)}</string>`,
    `  <key>CFBundleIdentifier</key>`,
    `  <string>${xmlEscape(bundleId)}</string>`,
    `  <key>CFBundleName</key>`,
    `  <string>${xmlEscape(productName)}</string>`,
    `  <key>CFBundleDisplayName</key>`,
    `  <string>${xmlEscape(productName)}</string>`,
    `  <key>CFBundlePackageType</key>`,
    `  <string>APPL</string>`,
    `  <key>CFBundleVersion</key>`,
    `  <string>1</string>`,
    `  <key>CFBundleShortVersionString</key>`,
    `  <string>1.0</string>`,
    ...(isHelper ? [
      `  <key>LSUIElement</key>`,
      `  <true/>`
    ] : []),
    `</dict>`,
    `</plist>`,
    ``
  ].join("\n");
}

function copyAppBundle(sourceAppPath, tempHelperPath) {
  fs.rmSync(tempHelperPath, { recursive: true, force: true });
  fs.cpSync(sourceAppPath, tempHelperPath, {
    recursive: true,
    filter: (source) => !String(source).includes(`${path.sep}Library${path.sep}LoginItems${path.sep}${MIA_CORE_HELPER_APP_NAME}`)
  });
}

function createMiaCoreHelperApp({ appPath, productName = "Mia", appId = "ai.mia.app", log = () => {} }) {
  const contentsDir = path.join(appPath, "Contents");
  const loginItemsDir = path.join(contentsDir, "Library", "LoginItems");
  const helperAppPath = path.join(loginItemsDir, MIA_CORE_HELPER_APP_NAME);
  const tempHelperPath = path.join(path.dirname(appPath), `.mia-core-helper-${process.pid}.app`);
  const sourceExecutable = path.join(tempHelperPath, "Contents", "MacOS", productName);
  const helperExecutablePath = path.join(helperAppPath, "Contents", "MacOS", MIA_CORE_HELPER_EXECUTABLE_NAME);

  copyAppBundle(appPath, tempHelperPath);
  fs.rmSync(helperAppPath, { recursive: true, force: true });
  fs.mkdirSync(loginItemsDir, { recursive: true });
  fs.renameSync(tempHelperPath, helperAppPath);

  const copiedExecutable = path.join(helperAppPath, "Contents", "MacOS", productName);
  if (copiedExecutable !== helperExecutablePath) {
    fs.renameSync(copiedExecutable, helperExecutablePath);
  }
  fs.chmodSync(helperExecutablePath, 0o755);
  fs.writeFileSync(path.join(helperAppPath, "Contents", "Info.plist"), helperInfoPlist({
    productName: "Mia Core",
    bundleId: MIA_CORE_HELPER_BUNDLE_ID,
    executableName: MIA_CORE_HELPER_EXECUTABLE_NAME,
    isHelper: true
  }));
  log(`Created Mia Core helper at ${helperAppPath}`);
  return { helperAppPath, helperExecutablePath };
}

async function afterPackMiaCoreHelper(context) {
  if (context.electronPlatformName !== "darwin") return;
  const productName = context.packager.appInfo.productFilename || context.packager.appInfo.productName || "Mia";
  const appId = context.packager.appInfo.id || "ai.mia.app";
  const appPath = path.join(context.appOutDir, `${productName}.app`);
  createMiaCoreHelperApp({
    appPath,
    productName,
    appId,
    log: (line) => console.log(`[MiaCoreHelper] ${line}`)
  });
}

module.exports = afterPackMiaCoreHelper;
module.exports.createMiaCoreHelperApp = createMiaCoreHelperApp;
module.exports.helperInfoPlist = helperInfoPlist;
module.exports.xmlEscape = xmlEscape;
```

During implementation, verify the fake app test passes. If real Electron app bundles use a different executable name than `productName`, add an explicit `executableName` resolver in this script and update the test with that exact behavior.

- [ ] **Step 4: Run packaging hook tests**

Run:

```bash
node --test tests/mia-core-helper-packaging.test.js
```

Expected: tests pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add scripts/after-pack-mia-core-helper.js tests/mia-core-helper-packaging.test.js
git commit -m "build(mac): 打包 Mia Core 后台 helper"
```

---

### Task 5: Packaging Config And Documentation

**Files:**
- Modify: `package.json`
- Modify: `tests/packaging-hermes-runtime.test.js`
- Modify: `docs/adr/2026-06-12-desktop-single-owner-daemon.md`

**Interfaces:**
- Consumes: electron-builder `afterPack` hook path `scripts/after-pack-mia-core-helper.js`.
- Produces: documented requirement that the single-owner daemon must not use the GUI app executable identity in packaged macOS builds.

- [ ] **Step 1: Write failing packaging config test**

In `tests/packaging-hermes-runtime.test.js`, add:

```js
test("macOS packaging creates a nested Mia Core helper before signing", () => {
  const pkg = packageJson();

  assert.equal(pkg.build.afterPack, "scripts/after-pack-mia-core-helper.js");
  const hook = fs.readFileSync(path.join(root, "scripts", "after-pack-mia-core-helper.js"), "utf8");
  assert.match(hook, /MIA_CORE_HELPER_APP_NAME/);
  assert.match(hook, /MIA_CORE_HELPER_BUNDLE_ID/);
  assert.match(hook, /LSUIElement/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/packaging-hermes-runtime.test.js
```

Expected: fail because `pkg.build.afterPack` is not set.

- [ ] **Step 3: Add package config**

In `package.json` under `build`, add:

```json
"afterPack": "scripts/after-pack-mia-core-helper.js",
```

Keep it at the base `build` level so `electron-builder.mac-arm64.js` and `electron-builder.mac-intel.js` inherit it.

- [ ] **Step 4: Update the daemon ADR**

In `docs/adr/2026-06-12-desktop-single-owner-daemon.md`, add a short amendment after the Decision section:

```md
### 2026-06-24 amendment: daemon process identity

The single-owner decision does not mean the daemon should be launched as the
GUI app executable. Packaged macOS builds must launch the owner through an
independent Mia Core helper identity so Dock, LaunchServices, and auto-update
do not treat the background owner as the foreground `Mia.app`.

The Phase 1 migration is specified in
`docs/superpowers/specs/2026-06-24-mia-core-phase1-design.md`. The final target
remains a deeper Mia Core Implementation that can replace the current
Electron-main daemon without changing GUI callers.
```

- [ ] **Step 5: Run packaging config test**

Run:

```bash
node --test tests/packaging-hermes-runtime.test.js
```

Expected: pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add package.json tests/packaging-hermes-runtime.test.js docs/adr/2026-06-12-desktop-single-owner-daemon.md
git commit -m "docs(daemon): 固化 Mia Core helper 打包约束"
```

---

### Task 6: Full Automated Verification

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes all previous task outputs.
- Produces verified automated test evidence.

- [ ] **Step 1: Run targeted daemon and packaging tests**

Run:

```bash
node --test \
  tests/daemon-core-executable-resolver.test.js \
  tests/launchd-service.test.js \
  tests/daemon-process-launcher.test.js \
  tests/daemon-control-server.test.js \
  tests/mia-core-helper-packaging.test.js \
  tests/packaging-hermes-runtime.test.js \
  tests/auto-update-service.test.js \
  tests/renderer-shell.test.js
```

Expected: all listed test files pass.

- [ ] **Step 2: Run project check**

Run:

```bash
npm run check
```

Expected: check completes successfully.

- [ ] **Step 3: Inspect git status**

Run:

```bash
git status -sb
```

Expected: clean working tree on `main`, ahead of `origin/main` by the implementation commits.

---

### Task 7: Manual macOS Package Verification Gate

**Files:**
- No source changes expected unless verification exposes a concrete bug.

**Interfaces:**
- Consumes the packaging hook and resolver.
- Produces manual evidence for the acceptance criteria that cannot be proven by unit tests.

- [ ] **Step 1: Ask before running packaging**

Do not run packaging automatically. Ask the user for approval because repo rules say not to run packaging/signing/release commands without an explicit request.

Use this exact prompt:

```text
Automated tests pass. To verify Dock/LaunchServices behavior, I need to run a macOS package build and inspect the generated helper app and LaunchAgent. This can take time and touches release output. Should I run `npm run dist:mac` now?
```

- [ ] **Step 2: If approved, build macOS package**

Run:

```bash
npm run dist:mac
```

Expected: `release/mac-arm64/Mia.app` exists and contains `Contents/Library/LoginItems/Mia Core.app/Contents/MacOS/Mia Core`.

- [ ] **Step 3: Inspect packaged helper**

Run:

```bash
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "release/mac-arm64/Mia.app/Contents/Library/LoginItems/Mia Core.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Print :LSUIElement" "release/mac-arm64/Mia.app/Contents/Library/LoginItems/Mia Core.app/Contents/Info.plist"
test -x "release/mac-arm64/Mia.app/Contents/Library/LoginItems/Mia Core.app/Contents/MacOS/Mia Core"
```

Expected:

```text
ai.mia.core
true
```

and `test -x` exits with status `0`.

- [ ] **Step 4: Verify generated LaunchAgent points at helper**

Launch the packaged app in a temporary user-data/runtime configuration if needed, then inspect the generated plist:

```bash
plutil -p "$HOME/Library/LaunchAgents/ai.mia.daemon.plist"
```

Expected: `ProgramArguments` contains `Mia Core.app/Contents/MacOS/Mia Core` and does not contain `Mia.app/Contents/MacOS/Mia`.

- [ ] **Step 5: Verify Dock/update acceptance manually**

Manual acceptance:

- Close the GUI window while daemon remains alive.
- Confirm Dock does not show `Mia.app` as running solely because of the daemon.
- Confirm daemon status reports `launchTarget.kind = "packaged-helper"` and `usesGuiAppIdentity = false`.
- Trigger or simulate update install preparation and confirm the updater still stops the daemon before `quitAndInstall`.

- [ ] **Step 6: Commit verification-only fixes if needed**

If manual verification exposes a source bug, make the minimal fix with a failing test first, rerun Task 6, then commit:

```bash
git add <fixed-files>
git commit -m "fix(daemon): 修正 Mia Core helper 打包验证问题"
```

If no source changes are needed, do not create an empty commit.
