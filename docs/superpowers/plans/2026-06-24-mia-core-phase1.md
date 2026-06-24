> ⚠️ **SUPERSEDED** by `2026-06-24-mia-core-migration.md`. The nested-`.app`
> Electron-helper approach below was reviewed NO-SHIP (omits Frameworks/asar →
> crashes; unverifiable without a signed build) and abandoned in favour of a
> real standalone Mia Core node process delivered in vertical slices. The
> resolver-seam and diagnostics tasks here did land and are reused; the helper
> packaging tasks (2, 6) did not. Kept for history.

# Mia Core Phase 1: Independent Daemon Executable Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop launching the desktop daemon as the GUI app identity (`Mia.app/Contents/MacOS/Mia --daemon`) by routing every daemon launch through one shared resolver Module, and ship a nested helper-app target with its own identity.

**Architecture:** Introduce `createMiaCoreResolver` — a single main-process Module that owns daemon command/args/workingDirectory/env resolution plus a `kind`/`usesGuiAppIdentity` classification. The two existing launch adapters (`launchd-service.js` plist generation, `daemon/process-launcher.js` detached spawn) currently duplicate `[execPath(), appPath?, "--daemon"]` verbatim; both delegate to the resolver instead. A packaged-macOS guard refuses to start the legacy GUI-identity target, and an `afterPack` hook assembles a nested `Mia Core.app` (bundle id `ai.mia.core`, no Dock) that the resolver prefers when present. Phase 2 can swap the implementation behind this seam without touching GUI callers.

**Tech Stack:** Node.js (CommonJS), Electron main process, `node --test` (built-in test runner), electron-builder (mac arm64 / intel configs).

## Global Constraints

- Test runner is `node --test`; the full suite is `npm test` (`node --test tests/*.test.js`). Project gate is `npm run check` (`node src/check.js`). Both must stay green. (verbatim from spec Testing section)
- Daemon LaunchAgent label stays `ai.mia.daemon`; gateway stays `ai.mia.hermes.gateway`. Nested helper bundle id is `ai.mia.core`, helper app name is `Mia Core.app`, helper executable name is `Mia Core`.
- The daemon runtime contract is unchanged: `MIA_DAEMON=1`, `MIA_HOME`, isolated `MIA_USER_DATA_DIR` (`<root>/daemon-profile`), `HERMES_HOME`, `HERMES_LANGUAGE`, `PYTHONUNBUFFERED=1`, stable `PATH`, daemon token, local HTTP/SSE control API. Do not change these values.
- Keep the existing updater guard (GUI stops the daemon before `quitAndInstall`) and `daemonNeedsReplacement()` string-version-compare semantics. Do not delete or weaken them.
- Faithful-minimal refactor: the resolver must reproduce today's launch behavior exactly in dev and packaged-non-macOS. Do not add defensive special-cases beyond the packaged-macOS legacy guard the spec requires.
- No DOM / UI strings in main (`src/main/AGENTS.md`). Modules that write real user dirs must accept injected paths in tests.
- Source of truth spec: `docs/superpowers/specs/2026-06-24-mia-core-phase1-design.md`.

---

## File Structure

- Create: `src/main/daemon/executable-resolver.js` — the Mia Core resolver Module. Single responsibility: classify + resolve the daemon launch target (command, args, workingDirectory, env overlay, kind, usesGuiAppIdentity) and expose `assertLaunchable()` + `describe()`.
- Create: `tests/daemon-executable-resolver.test.js` — resolver unit tests.
- Create: `build/afterpack-mia-core-helper.js` — electron-builder `afterPack` hook assembling the nested `Mia Core.app`.
- Create: `tests/afterpack-mia-core-helper.test.js` — pure assembly-logic tests (Info.plist + path math) against a temp dir.
- Modify: `src/main/launchd-service.js` — daemon command/dir/env delegate to an injected resolver.
- Modify: `src/main/daemon/process-launcher.js` — same delegation.
- Modify: `src/main.js` — construct one shared resolver, inject into both adapters, add the packaged-macOS launch guard, wire diagnostics.
- Modify: `src/main/daemon/control-server.js` — `status()` and `/health` report the resolved daemon target.
- Modify: `tests/launchd-service.test.js`, `tests/daemon-process-launcher.test.js`, `tests/daemon-control-server.test.js` — assert delegation / new fields.
- Modify: `electron-builder.mac-arm64.js`, `electron-builder.mac-intel.js` — register the `afterPack` hook.
- Modify: `docs/adr/2026-06-12-desktop-single-owner-daemon.md` — cross-link to this plan as the Phase 1/Phase 2 target.

---

### Task 1: Mia Core executable resolver Module

**Files:**
- Create: `src/main/daemon/executable-resolver.js`
- Test: `tests/daemon-executable-resolver.test.js`

**Interfaces:**
- Consumes: `runtimePaths()` → `{ root, home, ... }`; `effectiveHermesHome()` → string. (Same accessors `launchd-service.js` already receives.)
- Produces:
  - `createMiaCoreResolver(deps) -> resolver`
  - `resolver.resolve() -> { kind, command, args, workingDirectory, usesGuiAppIdentity }` where `kind ∈ {"electron-dev","packaged-helper","legacy-gui","bundled-cli"}`
  - `resolver.daemonEnvOverlay() -> { MIA_DAEMON, MIA_USER_DATA_DIR, HERMES_HOME, MIA_HOME, HERMES_LANGUAGE, PYTHONUNBUFFERED }`
  - `resolver.assertLaunchable() -> resolution` (throws on `kind === "legacy-gui"`)
  - `resolver.describe() -> { kind, command: <basename>, usesGuiAppIdentity, workingDirectory }`
  - `resolver.helperExecutablePath() -> string`
  - module export `DEFAULT_PATH` (launchd PATH fallback, consumed by Task 2)

- [ ] **Step 1: Write the failing test**

Create `tests/daemon-executable-resolver.test.js`:

```js
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

test("describe exposes basename and identity flag for diagnostics", () => {
  const d = setup().describe();
  assert.equal(d.kind, "legacy-gui");
  assert.equal(d.command, "Mia");
  assert.equal(d.usesGuiAppIdentity, true);
  assert.equal(typeof DEFAULT_PATH, "string");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/daemon-executable-resolver.test.js`
Expected: FAIL — `Cannot find module '../src/main/daemon/executable-resolver.js'`.

- [ ] **Step 3: Write the resolver Module**

Create `src/main/daemon/executable-resolver.js`:

```js
"use strict";

const path = require("node:path");
const { existsSync: defaultExistsSync } = require("node:fs");

const DEFAULT_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function createMiaCoreResolver(deps = {}) {
  const {
    runtimePaths,
    effectiveHermesHome,
    appPath = () => "",
    execPath = () => process.execPath,
    defaultApp = () => Boolean(process.defaultApp),
    platform = process.platform,
    env = process.env,
    resourcesPath = () => process.resourcesPath || "",
    existsSync = defaultExistsSync
  } = deps;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  if (typeof effectiveHermesHome !== "function") throw new Error("effectiveHermesHome dependency is required.");

  function helperExecutablePath() {
    return path.join(resourcesPath(), "Mia Core.app", "Contents", "MacOS", "Mia Core");
  }

  function resolve() {
    if (defaultApp()) {
      const command = execPath();
      return {
        kind: "electron-dev",
        command,
        args: [appPath(), "--daemon"],
        workingDirectory: path.dirname(command),
        usesGuiAppIdentity: false
      };
    }
    if (platform === "darwin") {
      const helper = helperExecutablePath();
      if (existsSync(helper)) {
        return {
          kind: "packaged-helper",
          command: helper,
          args: ["--daemon"],
          workingDirectory: path.dirname(helper),
          usesGuiAppIdentity: false
        };
      }
      const command = execPath();
      return {
        kind: "legacy-gui",
        command,
        args: ["--daemon"],
        workingDirectory: path.dirname(command),
        usesGuiAppIdentity: true
      };
    }
    const command = execPath();
    return {
      kind: "bundled-cli",
      command,
      args: ["--daemon"],
      workingDirectory: path.dirname(command),
      usesGuiAppIdentity: false
    };
  }

  function daemonEnvOverlay() {
    const p = runtimePaths();
    return {
      MIA_DAEMON: "1",
      MIA_USER_DATA_DIR: path.join(p.root || path.dirname(path.dirname(p.home)), "daemon-profile"),
      HERMES_HOME: effectiveHermesHome(),
      MIA_HOME: p.home,
      HERMES_LANGUAGE: env.HERMES_LANGUAGE || "zh",
      PYTHONUNBUFFERED: "1"
    };
  }

  function assertLaunchable() {
    const r = resolve();
    if (r.kind === "legacy-gui") {
      throw new Error(
        "Mia Core daemon executable not found in this packaged build; refusing to start the daemon under the GUI app identity. Reinstall Mia."
      );
    }
    return r;
  }

  function describe() {
    const r = resolve();
    return {
      kind: r.kind,
      command: path.basename(r.command),
      usesGuiAppIdentity: r.usesGuiAppIdentity,
      workingDirectory: r.workingDirectory
    };
  }

  return { resolve, daemonEnvOverlay, assertLaunchable, describe, helperExecutablePath };
}

module.exports = { createMiaCoreResolver, DEFAULT_PATH };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/daemon-executable-resolver.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/daemon/executable-resolver.js tests/daemon-executable-resolver.test.js
git commit -m "feat(daemon): add Mia Core executable resolver"
```

---

### Task 2: launchd adapter delegates to the resolver

**Files:**
- Modify: `src/main/launchd-service.js:152-179` (`daemonProgramArguments`, `daemonWorkingDirectory`, `daemonEnvironment`)
- Modify: `src/main.js:361-376` (construct one shared resolver, pass `resolver` into `createLaunchdService`)
- Test: `tests/launchd-service.test.js`

**Interfaces:**
- Consumes: `createMiaCoreResolver` (Task 1), `DEFAULT_PATH` (Task 1).
- Produces: `createLaunchdService` accepts an optional `resolver` dep; when absent it builds one from `runtimePaths/effectiveHermesHome/appPath/execPath/defaultApp/platform/env`. `daemonProgramArguments()/daemonWorkingDirectory()/daemonEnvironment()` return resolver-derived values (behavior-identical to today).

- [ ] **Step 1: Write the failing test**

Add to `tests/launchd-service.test.js` (append after the existing tests):

```js
test("daemon launch agent delegates command, workdir and env to an injected resolver", (t) => {
  const fakeResolver = {
    resolve: () => ({
      command: "/Applications/Mia.app/Contents/Resources/Mia Core.app/Contents/MacOS/Mia Core",
      args: ["--daemon"],
      workingDirectory: "/Applications/Mia.app/Contents/Resources/Mia Core.app/Contents/MacOS"
    }),
    daemonEnvOverlay: () => ({ MIA_DAEMON: "1", MIA_HOME: "/home", HERMES_LANGUAGE: "en" })
  };
  const { service } = setup(t, { resolver: fakeResolver });

  assert.deepEqual(service.daemonProgramArguments(), [
    "/Applications/Mia.app/Contents/Resources/Mia Core.app/Contents/MacOS/Mia Core",
    "--daemon"
  ]);
  const plist = service.daemonLaunchAgentPlist();
  assert.match(plist, /Mia Core\.app\/Contents\/MacOS\/Mia Core/);
  assert.doesNotMatch(plist, /Contents\/MacOS\/Mia<\/string>\n {4}<string>--daemon/);
  const daemonEnv = service.daemonEnvironment();
  assert.equal(daemonEnv.MIA_DAEMON, "1");
  assert.equal(daemonEnv.PATH, "/usr/local/bin:/usr/bin"); // from setup env, preserved
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/launchd-service.test.js`
Expected: FAIL — the new test fails because `createLaunchdService` ignores `resolver` and still builds args from `execPath()/appPath()`.

- [ ] **Step 3: Refactor `launchd-service.js` to delegate**

At the top of `src/main/launchd-service.js`, add the require (after the existing requires on lines 1-3):

```js
const { createMiaCoreResolver, DEFAULT_PATH } = require("./daemon/executable-resolver.js");
```

Inside `createLaunchdService`, after the `appendLog` line (currently line 82), add:

```js
  const resolver = deps.resolver || createMiaCoreResolver({
    runtimePaths,
    effectiveHermesHome,
    appPath,
    execPath,
    defaultApp,
    platform,
    env
  });
```

Replace `daemonProgramArguments` / `daemonWorkingDirectory` / `daemonEnvironment` (currently lines 152-179) with:

```js
  function daemonProgramArguments() {
    const r = resolver.resolve();
    return [r.command, ...r.args];
  }

  function daemonEnvironment() {
    return { ...resolver.daemonEnvOverlay(), PATH: env.PATH || DEFAULT_PATH };
  }

  // launchd chdir()s into WorkingDirectory before exec; the resolver always
  // returns a real directory (never the asar archive) in both dev and packaged
  // builds, so anchoring there avoids EX_CONFIG (exit 78).
  function daemonWorkingDirectory() {
    return resolver.resolve().workingDirectory;
  }
```

- [ ] **Step 4: Wire the shared resolver in `src/main.js`**

In `src/main.js`, add the require next to the other daemon requires (near line 99):

```js
const { createMiaCoreResolver } = require("./main/daemon/executable-resolver.js");
```

Immediately before the `const launchdService = createLaunchdService({` call (line 361), add:

```js
const miaCoreResolver = createMiaCoreResolver({
  runtimePaths,
  effectiveHermesHome,
  appPath: () => app.getAppPath(),
  execPath: () => process.execPath,
  defaultApp: () => Boolean(process.defaultApp),
  platform: process.platform,
  env: process.env,
  resourcesPath: () => process.resourcesPath || ""
});
```

Then add `resolver: miaCoreResolver,` to the `createLaunchdService({ ... })` deps object (line 361-376).

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/launchd-service.test.js`
Expected: PASS — all existing tests stay green (the resolver reproduces today's args/workdir/env) and the new delegation test passes.

Run: `node -c src/main.js`
Expected: no output (syntax OK).

- [ ] **Step 6: Commit**

```bash
git add src/main/launchd-service.js src/main.js tests/launchd-service.test.js
git commit -m "refactor(daemon): launchd plist delegates daemon target to resolver"
```

---

### Task 3: detached spawn adapter delegates to the resolver

**Files:**
- Modify: `src/main/daemon/process-launcher.js:21-43`
- Modify: `src/main.js:377-386` (pass the shared `miaCoreResolver`)
- Test: `tests/daemon-process-launcher.test.js`

**Interfaces:**
- Consumes: `createMiaCoreResolver` (Task 1), shared `miaCoreResolver` instance from `src/main.js` (Task 2).
- Produces: `createDaemonProcessLauncher` accepts an optional `resolver` dep; `daemonProgramArguments()/daemonWorkingDirectory()/daemonEnvironment()` are resolver-derived. `daemonEnvironment()` still spreads the parent `env` then applies the overlay (unchanged behavior).

- [ ] **Step 1: Write the failing test**

Add to `tests/daemon-process-launcher.test.js` (append after the existing tests):

```js
test("detached launcher delegates command and env overlay to an injected resolver", async () => {
  const fakeResolver = {
    resolve: () => ({
      command: "/opt/mia/Mia Core",
      args: ["--daemon"],
      workingDirectory: "/opt/mia"
    }),
    daemonEnvOverlay: () => ({ MIA_DAEMON: "1", MIA_HOME: "/home" })
  };
  const { calls, launcher } = setup({ resolver: fakeResolver });

  await launcher.start();

  assert.equal(calls[0].command, "/opt/mia/Mia Core");
  assert.deepEqual(calls[0].args, ["--daemon"]);
  assert.equal(calls[0].options.cwd, "/opt/mia");
  assert.equal(calls[0].options.env.MIA_DAEMON, "1");
  assert.equal(calls[0].options.env.CUSTOM_ENV, "kept"); // parent env still spread through
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/daemon-process-launcher.test.js`
Expected: FAIL — launcher ignores `resolver` and still builds args from `execPath()/appPath()`.

- [ ] **Step 3: Refactor `process-launcher.js` to delegate**

At the top of `src/main/daemon/process-launcher.js`, after the existing requires (lines 3-4), add:

```js
const { createMiaCoreResolver } = require("./executable-resolver.js");
```

Inside `createDaemonProcessLauncher`, after the dependency validation block (currently ends line 19), add:

```js
  const resolver = deps.resolver || createMiaCoreResolver({
    runtimePaths,
    effectiveHermesHome,
    appPath,
    execPath,
    defaultApp,
    env
  });
```

Replace `daemonProgramArguments` / `daemonEnvironment` / `daemonWorkingDirectory` (currently lines 21-43) with:

```js
  function daemonProgramArguments() {
    const r = resolver.resolve();
    return [r.command, ...r.args];
  }

  function daemonEnvironment() {
    return { ...env, ...resolver.daemonEnvOverlay() };
  }

  function daemonWorkingDirectory() {
    return resolver.resolve().workingDirectory;
  }
```

- [ ] **Step 4: Pass the shared resolver in `src/main.js`**

Add `resolver: miaCoreResolver,` to the `createDaemonProcessLauncher({ ... })` deps object (lines 377-386).

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/daemon-process-launcher.test.js`
Expected: PASS — both existing tests stay green (resolver reproduces today's behavior) plus the new delegation test.

Run: `node -c src/main/daemon/process-launcher.js`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/main/daemon/process-launcher.js src/main.js tests/daemon-process-launcher.test.js
git commit -m "refactor(daemon): detached spawn delegates daemon target to resolver"
```

---

### Task 4: Refuse the legacy GUI-identity target on packaged macOS

**Files:**
- Modify: `src/main.js:1249-1295` (`startDaemonService`)
- Test: `tests/daemon-executable-resolver.test.js` (guard is already unit-tested via `assertLaunchable` in Task 1; this task adds the call site)

**Interfaces:**
- Consumes: `miaCoreResolver.assertLaunchable()` (Task 1).
- Produces: on packaged macOS with no helper, `startDaemonService()` throws before any launch attempt; dev (`electron-dev`) and packaged-non-macOS (`bundled-cli`) are unaffected.

- [ ] **Step 1: Add a focused assertion test for the guard contract**

Append to `tests/daemon-executable-resolver.test.js`:

```js
test("assertLaunchable returns the resolution for launchable targets", () => {
  const r = setup({ defaultApp: () => true }).assertLaunchable();
  assert.equal(r.kind, "electron-dev");
});
```

- [ ] **Step 2: Run it to verify it passes (assertLaunchable already exists)**

Run: `node --test tests/daemon-executable-resolver.test.js`
Expected: PASS (this codifies the contract the call site relies on).

- [ ] **Step 3: Add the guard at the launch site in `src/main.js`**

In `startDaemonService` (lines 1249-1295), immediately before the platform branch that calls `launchdService.startDaemon()` / `daemonProcessLauncher.start()` (around line 1272), add:

```js
    // Packaged macOS must not fall back to the GUI app identity for the daemon.
    // Dev (electron-dev) and non-macOS (bundled-cli) pass through.
    miaCoreResolver.assertLaunchable();
```

- [ ] **Step 4: Verify syntax and that the existing daemon flow is intact**

Run: `node -c src/main.js`
Expected: no output.

Run: `node --test tests/daemon-control-server.test.js tests/launchd-service.test.js tests/daemon-process-launcher.test.js`
Expected: PASS (guard does not affect these unit paths).

- [ ] **Step 5: Commit**

```bash
git add src/main.js tests/daemon-executable-resolver.test.js
git commit -m "feat(daemon): refuse legacy GUI-identity daemon on packaged macOS"
```

---

### Task 5: Diagnostics — report the resolved daemon target

**Files:**
- Modify: `src/main/daemon/control-server.js:6-35` (constructor dep), `:94-112` (`status()`), `:325-335` (`/health`)
- Modify: `src/main.js` (the `createDaemonControlServer({ ... })` call — locate with `grep -n "createDaemonControlServer(" src/main.js`)
- Test: `tests/daemon-control-server.test.js`

**Interfaces:**
- Consumes: `miaCoreResolver.describe()` (Task 1) → `{ kind, command, usesGuiAppIdentity, workingDirectory }`.
- Produces: `createDaemonControlServer` accepts `describeDaemonTarget = () => null`. `status()` and `/health` both include `daemonTarget: describeDaemonTarget()`.

- [ ] **Step 1: Write the failing test**

Append to `tests/daemon-control-server.test.js`:

```js
test("status and health report the resolved daemon target", async (t) => {
  const target = { kind: "packaged-helper", command: "Mia Core", usesGuiAppIdentity: false, workingDirectory: "/x" };
  const { server } = setup(t, { describeDaemonTarget: () => target });

  assert.deepEqual(server.status().daemonTarget, target);

  const port = await freePort();
  await server.start({ host: "127.0.0.1", port });
  t.after(() => server.stop());
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json();
  assert.deepEqual(body.daemonTarget, target);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/daemon-control-server.test.js`
Expected: FAIL — `status().daemonTarget` is `undefined`.

- [ ] **Step 3: Add the dep and emit the field**

In `src/main/daemon/control-server.js`, add to the destructured deps (inside the object on lines 6-35, e.g. after `localEventHeartbeatMs = 15000`):

```js
  ,describeDaemonTarget = () => null
```

In `status()` (lines 94-112), add a field to the returned object (after `launchAgent: paths.daemonLaunchAgent,`):

```js
      daemonTarget: describeDaemonTarget(),
```

In the `/health` response (lines 326-334), add (after `version: String(appVersion() || "")`):

```js
        ,daemonTarget: describeDaemonTarget()
```

- [ ] **Step 4: Wire it from `src/main.js`**

In the `createDaemonControlServer({ ... })` call, add:

```js
  describeDaemonTarget: () => miaCoreResolver.describe(),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/daemon-control-server.test.js`
Expected: PASS — existing tests stay green (default `describeDaemonTarget` returns `null`) plus the new test.

Run: `node -c src/main/daemon/control-server.js && node -c src/main.js`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/main/daemon/control-server.js src/main.js tests/daemon-control-server.test.js
git commit -m "feat(daemon): report resolved daemon target in status and health"
```

---

### Task 6: Nested `Mia Core.app` helper packaging hook

**Files:**
- Create: `build/afterpack-mia-core-helper.js`
- Test: `tests/afterpack-mia-core-helper.test.js`
- Modify: `electron-builder.mac-arm64.js`, `electron-builder.mac-intel.js`

**Interfaces:**
- Consumes: electron-builder `afterPack` context `{ appOutDir, packager, electronPlatformName }`.
- Produces: a nested `Mia Core.app` inside `<App>.app/Contents/Resources/` whose `Contents/MacOS/Mia Core` is a copy of the packed app's main executable, with an `Info.plist` carrying `CFBundleIdentifier=ai.mia.core`, `CFBundleExecutable=Mia Core`, `LSUIElement=true`. Resolver (Task 1) already points at `Contents/Resources/Mia Core.app/Contents/MacOS/Mia Core`.
- Exposes pure helpers for unit testing: `buildHelperInfoPlist({ appName }) -> string`, `helperLayout(appOutDir, productFilename) -> { helperAppDir, helperMacOSDir, helperExecPath, helperInfoPlistPath, sourceExecPath }`.

> **Note on scope:** This task makes the helper *exist with a distinct identity and no Dock presence* — the spec's observable acceptance condition. Copying the app's own Mach-O executable (not a shell wrapper that re-execs `Contents/MacOS/Mia`) gives the helper its own process identity while still loading the same `app.asar` daemon entry under `MIA_DAEMON=1`. Code-signing the nested app and the full Dock/update behavior are proven by the manual packaged checklist below, not by unit tests — consistent with the spec's "Manual or packaging verification".

- [ ] **Step 1: Write the failing test (pure assembly logic)**

Create `tests/afterpack-mia-core-helper.test.js`:

```js
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const { buildHelperInfoPlist, helperLayout } = require("../build/afterpack-mia-core-helper.js");

test("helper Info.plist declares ai.mia.core identity with no Dock presence", () => {
  const plist = buildHelperInfoPlist({ appName: "Mia Core" });
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>ai\.mia\.core<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>Mia Core<\/string>/);
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
});

test("helper layout nests under Resources and copies the packed executable", () => {
  const layout = helperLayout("/out/mac/Mia.app", "Mia");
  assert.equal(
    layout.helperExecPath,
    path.join("/out/mac/Mia.app", "Contents", "Resources", "Mia Core.app", "Contents", "MacOS", "Mia Core")
  );
  assert.equal(layout.sourceExecPath, path.join("/out/mac/Mia.app", "Contents", "MacOS", "Mia"));
  assert.equal(
    layout.helperInfoPlistPath,
    path.join("/out/mac/Mia.app", "Contents", "Resources", "Mia Core.app", "Contents", "Info.plist")
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/afterpack-mia-core-helper.test.js`
Expected: FAIL — `Cannot find module '../build/afterpack-mia-core-helper.js'`.

- [ ] **Step 3: Write the hook**

Create `build/afterpack-mia-core-helper.js`:

```js
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const HELPER_APP_NAME = "Mia Core";
const HELPER_BUNDLE_ID = "ai.mia.core";

function buildHelperInfoPlist({ appName }) {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>CFBundleExecutable</key>`,
    `  <string>${appName}</string>`,
    `  <key>CFBundleIdentifier</key>`,
    `  <string>${HELPER_BUNDLE_ID}</string>`,
    `  <key>CFBundleName</key>`,
    `  <string>${appName}</string>`,
    `  <key>CFBundlePackageType</key>`,
    `  <string>APPL</string>`,
    `  <key>LSUIElement</key>`,
    `  <true/>`,
    `  <key>LSBackgroundOnly</key>`,
    `  <true/>`,
    `</dict>`,
    `</plist>`,
    ``
  ].join("\n");
}

function helperLayout(appOutDir, productFilename) {
  const appBundle = appOutDir.endsWith(".app") ? appOutDir : path.join(appOutDir, `${productFilename}.app`);
  const helperAppDir = path.join(appBundle, "Contents", "Resources", `${HELPER_APP_NAME}.app`);
  const helperMacOSDir = path.join(helperAppDir, "Contents", "MacOS");
  return {
    appBundle,
    helperAppDir,
    helperMacOSDir,
    helperExecPath: path.join(helperMacOSDir, HELPER_APP_NAME),
    helperInfoPlistPath: path.join(helperAppDir, "Contents", "Info.plist"),
    sourceExecPath: path.join(appBundle, "Contents", "MacOS", productFilename)
  };
}

async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const productFilename = context.packager.appInfo.productFilename;
  const layout = helperLayout(context.appOutDir, productFilename);
  fs.mkdirSync(layout.helperMacOSDir, { recursive: true });
  fs.copyFileSync(layout.sourceExecPath, layout.helperExecPath);
  fs.chmodSync(layout.helperExecPath, 0o755);
  fs.writeFileSync(layout.helperInfoPlistPath, buildHelperInfoPlist({ appName: HELPER_APP_NAME }));
}

module.exports = afterPack;
module.exports.afterPack = afterPack;
module.exports.buildHelperInfoPlist = buildHelperInfoPlist;
module.exports.helperLayout = helperLayout;
module.exports.HELPER_APP_NAME = HELPER_APP_NAME;
module.exports.HELPER_BUNDLE_ID = HELPER_BUNDLE_ID;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/afterpack-mia-core-helper.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Register the hook in both mac builder configs**

In `electron-builder.mac-arm64.js`, change the `module.exports` to add `afterPack`:

```js
const pkg = require("./package.json");
const afterPack = require("./build/afterpack-mia-core-helper.js");

const build = pkg.build || {};

module.exports = {
  ...build,
  afterPack,
  mac: {
    ...(build.mac || {}),
    target: ["dir", "zip"]
  },
  dmg: {
    ...(build.dmg || {}),
    artifactName: "${productName}-${version}-Apple-Silicon.${ext}"
  }
};
```

Apply the same two added lines (`const afterPack = require(...)` and `afterPack,`) to `electron-builder.mac-intel.js`.

- [ ] **Step 6: Verify configs load**

Run: `node -e "require('./electron-builder.mac-arm64.js'); require('./electron-builder.mac-intel.js'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 7: Commit**

```bash
git add build/afterpack-mia-core-helper.js tests/afterpack-mia-core-helper.test.js electron-builder.mac-arm64.js electron-builder.mac-intel.js
git commit -m "feat(packaging): assemble nested Mia Core helper app on macOS"
```

---

### Task 7: Full gate, doc cross-links, and packaged verification checklist

**Files:**
- Modify: `docs/adr/2026-06-12-desktop-single-owner-daemon.md`
- Modify: `docs/superpowers/specs/2026-06-24-mia-core-phase1-design.md` (status line)

**Interfaces:** none (verification + docs).

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS — all tests including the new resolver / launchd / process-launcher / control-server / afterpack tests. Note specifically that `tests/auto-update-service.test.js` stays green (updater guard untouched).

- [ ] **Step 2: Run the project gate**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 3: Add the Phase 2 cross-link to the ADR**

In `docs/adr/2026-06-12-desktop-single-owner-daemon.md`, append a section:

```markdown
## Phase 1 / Phase 2 follow-up

The single-owner daemon's process-identity problem is addressed by the Mia Core
executable seam. See `docs/superpowers/specs/2026-06-24-mia-core-phase1-design.md`
(design) and `docs/superpowers/plans/2026-06-24-mia-core-phase1.md` (implementation).
Phase 2 replaces the implementation behind `src/main/daemon/executable-resolver.js`
with a standalone Mia Core process without changing GUI callers, LaunchAgent
ownership, or the runtime-home contract.
```

- [ ] **Step 4: Mark the spec implemented**

In `docs/superpowers/specs/2026-06-24-mia-core-phase1-design.md`, change line 3 from
`Status: approved direction, pending implementation plan.` to
`Status: approved; implemented per docs/superpowers/plans/2026-06-24-mia-core-phase1.md.`

- [ ] **Step 5: Commit the docs**

```bash
git add docs/adr/2026-06-12-desktop-single-owner-daemon.md docs/superpowers/specs/2026-06-24-mia-core-phase1-design.md
git commit -m "docs(daemon): cross-link Mia Core seam from single-owner ADR and spec"
```

- [ ] **Step 6: Manual packaged verification (requires release env / signing credentials)**

This is the real acceptance gate for the macOS identity change; the unit tests cannot prove it. Perform when release credentials/environment are available:

```bash
npm run release:mac    # or the project's mac dir/zip build command
```

Then verify:
1. Inspect the bundle: `ls "dist/mac-arm64/Mia.app/Contents/Resources/Mia Core.app/Contents/MacOS/"` shows `Mia Core`.
2. Confirm helper identity: `/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "dist/mac-arm64/Mia.app/Contents/Resources/Mia Core.app/Contents/Info.plist"` prints `ai.mia.core`.
3. Launch the installed app, then read the generated plist: `cat ~/Library/LaunchAgents/ai.mia.daemon.plist` — `ProgramArguments` points at `Mia Core.app/Contents/MacOS/Mia Core`, NOT `Mia.app/Contents/MacOS/Mia`.
4. Close the main window. Confirm Dock does not show Mia as running while `daemon status` (or `curl 127.0.0.1:<port>/health`) still reports `"mode":"daemon"` and `daemonTarget.kind` is `packaged-helper`.
5. Trigger an app update/install and confirm `quitAndInstall` proceeds without `App Still Running Error` after the GUI stops the daemon.
6. Relaunch after a version bump and confirm an old-version daemon is replaced (`daemonNeedsReplacement` path still fires).

Record the results in the PR description.

---

## Self-Review

**Spec coverage:**
- §1 Resolver → Task 1 (`resolve`, `kind`, `usesGuiAppIdentity`, legacy visibility via `describe`/`daemonTarget`). ✓
- §2 Independent executable → Task 6 (nested `Mia Core.app`, `ai.mia.core`, no Dock; copies the Mach-O, not a shell wrapper re-execing the GUI). ✓
- §3 LaunchAgent adapter → Task 2 (ProgramArguments from resolver; label/env/RunAtLoad/KeepAlive preserved; plist test asserts no `Contents/MacOS/Mia` daemon target). ✓
- §4 Detached spawn adapter → Task 3. ✓
- §5 Updater interaction → guard untouched; Task 7 Step 1 keeps `auto-update-service.test.js` green; Task 7 Step 6.5 manual check. ✓
- §6 Version replacement → `daemonNeedsReplacement` untouched (Global Constraints); resolver does not hide version; `version` still in `/health` (Task 5 leaves it). Task 7 Step 6.6. ✓
- §7 Diagnostics → Task 5 (`daemonTarget` = kind/command-basename/usesGuiAppIdentity; `launchAgent`, `runtimeHome` already in `status()`). ✓
- Testing section → resolver unit tests (Task 1), launchd plist tests (Task 2), detached spawn tests (Task 3), `npm run check` (Task 7). ✓
- Path To Phase 2 / Acceptance docs → Task 7 Steps 3-4. ✓
- Error Handling (packaged macOS must fail, not start legacy; dev visible fallback) → Task 4 `assertLaunchable`. ✓

**Placeholder scan:** No TBD/"handle edge cases"/"similar to Task N" — every code step shows full code. The one deliberately-manual step (Task 7 Step 6) is the spec's own "Manual or packaging verification" and is labeled as such. ✓

**Type consistency:** `resolve()` shape `{ kind, command, args, workingDirectory, usesGuiAppIdentity }`, `daemonEnvOverlay()`, `describe()` → `daemonTarget`, and `helperLayout().helperExecPath` (`Contents/Resources/Mia Core.app/Contents/MacOS/Mia Core`) match the resolver's `helperExecutablePath()` in Task 1. The fake resolvers in Tasks 2-3 tests implement the same `resolve()`/`daemonEnvOverlay()` shape. ✓
