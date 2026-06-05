# First-Run Startup Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a first-run loading overlay with the welcome Lottie animation while Mia completes startup work before exposing the main chat UI.

**Architecture:** Keep presentation in the renderer and background/system actions in the main process. Add a narrow main-process startup orchestration service and IPC, then let `app.js` sequence the existing initialization/loaders plus the new startup IPC under an overlay. Use a dedicated CSS file and the existing Lottie player.

**Tech Stack:** Electron main/preload/renderer IPC, vanilla browser JS, Lottie Web, Node test runner.

---

### Task 1: Main Startup Orchestration

**Files:**
- Create: `src/main/startup-background-service.js`
- Modify: `src/shared/ipc-channels.js`
- Modify: `src/preload.js`
- Modify: `src/main.js`
- Test: `tests/startup-background-service.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/startup-background-service.test.js` with tests for best-effort daemon/engine startup:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStartupBackgroundService } = require("../src/main/startup-background-service.js");

test("startup background service runs daemon, system refresh, and engine when installed", async () => {
  const calls = [];
  const service = createStartupBackgroundService({
    getRuntimeStatus: () => ({ engineInstalled: true }),
    startDaemonService: async () => { calls.push("daemon"); return { running: true }; },
    refreshSystemHermesAsync: async () => { calls.push("system-hermes"); },
    startEngine: async () => { calls.push("engine"); return { engineRunning: true }; },
    setDaemonLastError: (message) => calls.push(`daemon-error:${message}`),
    setEngineLastError: (message) => calls.push(`engine-error:${message}`),
    appendDaemonLog: (line) => calls.push(`daemon-log:${line}`),
    appendEngineLog: (line) => calls.push(`engine-log:${line}`)
  });

  const result = await service.run();

  assert.deepEqual(calls, ["daemon", "system-hermes", "engine"]);
  assert.equal(result.ok, true);
  assert.equal(result.steps.daemon.ok, true);
  assert.equal(result.steps.engine.ok, true);
});

test("startup background service skips engine when Hermes is not installed", async () => {
  const calls = [];
  const service = createStartupBackgroundService({
    getRuntimeStatus: () => ({ engineInstalled: false }),
    startDaemonService: async () => { calls.push("daemon"); return { running: true }; },
    refreshSystemHermesAsync: async () => { calls.push("system-hermes"); },
    startEngine: async () => { calls.push("engine"); return {}; },
    appendEngineLog: (line) => calls.push(`engine-log:${line}`)
  });

  const result = await service.run();

  assert.equal(result.ok, true);
  assert.equal(result.steps.engine.skipped, true);
  assert.deepEqual(calls, [
    "daemon",
    "system-hermes",
    "engine-log:No Hermes available (system or managed); waiting for manual setup."
  ]);
});

test("startup background service reports best-effort daemon and engine failures", async () => {
  const calls = [];
  const service = createStartupBackgroundService({
    getRuntimeStatus: () => ({ engineInstalled: true }),
    startDaemonService: async () => { throw new Error("daemon failed"); },
    refreshSystemHermesAsync: async () => { throw new Error("probe failed"); },
    startEngine: async () => { throw new Error("engine failed"); },
    setDaemonLastError: (message) => calls.push(`daemon-error:${message}`),
    setEngineLastError: (message) => calls.push(`engine-error:${message}`),
    appendDaemonLog: (line) => calls.push(`daemon-log:${line}`),
    appendEngineLog: (line) => calls.push(`engine-log:${line}`)
  });

  const result = await service.run();

  assert.equal(result.ok, false);
  assert.match(result.steps.daemon.error, /daemon failed/);
  assert.match(result.steps.systemHermes.error, /probe failed/);
  assert.match(result.steps.engine.error, /engine failed/);
  assert.deepEqual(calls, [
    "daemon-error:daemon failed",
    "daemon-log:Startup daemon registration failed: daemon failed",
    "engine-error:engine failed",
    "engine-log:Startup engine auto-start failed: engine failed"
  ]);
});
```

- [ ] **Step 2: Run tests to verify red**

Run: `node --test tests/startup-background-service.test.js`

Expected: FAIL with module-not-found for `src/main/startup-background-service.js`.

- [ ] **Step 3: Implement startup service and IPC**

Create `src/main/startup-background-service.js` exporting `createStartupBackgroundService({ ...deps })` with a `run()` method. It should run daemon startup, system Hermes refresh, then engine start if `getRuntimeStatus().engineInstalled` is true. Daemon and engine errors are captured in result objects and written through existing log/error callbacks.

Add `StartupBackgroundServices` to `src/shared/ipc-channels.js`.

Expose `startupBackgroundServices()` in `src/preload.js`.

In `src/main.js`, create the service with existing dependencies and add `ipcMain.handle(IpcChannel.StartupBackgroundServices, () => startupBackgroundService.run())`. In `app.whenReady()`, skip `runtimeLifecycle().scheduleBackgroundStartup()` when the window is in compact onboarding mode, because renderer will call the explicit IPC.

- [ ] **Step 4: Run tests to verify green**

Run: `node --test tests/startup-background-service.test.js`

Expected: PASS.

### Task 2: Renderer Startup Overlay

**Files:**
- Create: `src/renderer/startup/startup-overlay.js`
- Create: `src/renderer/styles/startup.css`
- Copy asset: `src/renderer/assets/lottie/welcome.json`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/app.js`
- Test: `tests/renderer-shell.test.js`

- [ ] **Step 1: Write failing renderer shell checks**

Add assertions to `tests/renderer-shell.test.js` that `index.html` includes `styles/startup.css`, the startup overlay script, and an overlay node with `data-lottie="welcome"`.

- [ ] **Step 2: Run test to verify red**

Run: `node --test tests/renderer-shell.test.js`

Expected: FAIL because the overlay assets and markup are not present.

- [ ] **Step 3: Add overlay markup, CSS, animation asset, and script**

Copy `/Users/jung/Documents/UI资源/welcome.json` to `src/renderer/assets/lottie/welcome.json`.

Add a startup overlay section to `src/renderer/index.html` after `<body>` and before `<main>`, load `styles/startup.css` in the head, and load `startup/startup-overlay.js` before `app.js`.

Create `src/renderer/startup/startup-overlay.js` exposing `window.miaStartupOverlay` with:

- `init({ firstRun })`
- `setStatus(text)`
- `setWelcome()`
- `finish()`
- `fail(message)`
- `isBlocking()`

The module should add/remove CSS classes only; `app.js` owns task sequencing.

- [ ] **Step 4: Route first-run startup through the overlay**

In `src/renderer/app.js`, detect `agentSetupLaunch` as the first-run blocking condition. Initialize the overlay before `initializeRuntime()`. During first-run startup:

1. Show "正在准备 Mia".
2. Call `window.mia.initializeRuntime()` through existing `initializeRuntime()` flow.
3. Run initial loaders.
4. Call `window.mia.startupBackgroundServices()`.
5. Show welcome briefly.
6. Fade out overlay.

For existing users, keep current behavior: no blocking overlay and no startup background IPC from renderer.

- [ ] **Step 5: Run renderer shell test**

Run: `node --test tests/renderer-shell.test.js`

Expected: PASS or only existing unrelated renderer-shell assertion failures should be documented.

### Task 3: Verification

**Files:**
- Verify only; no planned production file changes.

- [ ] **Step 1: Run targeted unit tests**

Run:

```bash
node --test tests/startup-background-service.test.js
node --test tests/renderer-shell.test.js
```

Expected: startup service tests pass; renderer shell results should be reported exactly.

- [ ] **Step 2: Run project check**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 3: Run Electron smoke if feasible**

Run: `MIA_USER_DATA_DIR="$(mktemp -d)" MIA_DISABLE_BACKGROUND_STARTUP=1 npm start`

Expected: app opens without a blank renderer. If full visual QA cannot be completed in the current environment, report the limitation.

