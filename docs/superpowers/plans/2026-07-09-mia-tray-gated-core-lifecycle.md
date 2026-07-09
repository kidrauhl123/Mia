# Mia Tray-Gated Core Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mia's desktop Core lifecycle visible and predictable: tray/menu bar icon present means Mia Core is running; tray/menu bar icon absent means Mia Core has stopped.

**Architecture:** Add two small main-process modules: a pure close-window policy module and a tray lifecycle service. Persist the remembered window-close behavior in the existing `mia-window.json` settings file, then wire `src/main.js` so window close hides to tray or fully quits through one shared path.

**Tech Stack:** Electron CommonJS main process, Electron `Tray`/`Menu`/`nativeImage`/`dialog`, existing `node:test` tests, existing `settings-store` and `window-state` patterns.

## Global Constraints

- Make desktop background activity visible through a system tray/menu bar icon.
- Tray/menu bar icon present means Mia Core is running.
- Tray/menu bar icon absent means Mia Core has been fully stopped.
- Closing the window is not the same as quitting Mia.
- Explicit tray quit stops Mia Core and removes the icon.
- Prompt the user the first time they close the main window.
- Persist the user's close-window choice only when they choose `Remember my choice`.
- The default close-window behavior is `ask`.
- The remembered close-window values are exactly `ask`, `close-to-tray`, and `quit`.
- macOS close-to-tray hides the Dock icon so the menu bar icon is the background anchor.
- Windows uses the system tray, not the taskbar, as the background anchor.
- Do not introduce a separate tray/helper process in this implementation.
- Do not redesign logout, local data retention, Core HTTP/SSE contracts, cloud state, memory, tasks, or agent runtime behavior.
- Do not push changes.

---

## File Structure

- Modify `src/main/settings-store.js`
  - Add persisted `windowCloseBehavior` to the existing window settings file.
  - Normalize invalid values back to `ask`.
- Modify `tests/settings-store.test.js`
  - Cover default, normalization, and write semantics for `windowCloseBehavior`.
- Create `src/main/window-close-policy.js`
  - Pure policy functions for deciding whether to prompt, hide to tray, quit, or keep the window visible.
  - Native dialog option builder and dialog response normalizer.
- Create `tests/window-close-policy.test.js`
  - TDD coverage for all close-window decision cases.
- Create `src/main/tray-lifecycle-service.js`
  - Own Electron tray object creation, destruction, menu rebuilds, and open/quit menu actions.
- Create `tests/tray-lifecycle-service.test.js`
  - Unit tests using fake `Tray`, `Menu`, `nativeImage`, and `app.dock`.
- Modify `src/main.js`
  - Import Electron tray primitives.
  - Instantiate tray lifecycle service.
  - Wire window close handling, tray open, full quit, Core start/stop tray state, macOS Dock hide/show.
- Create `tests/tray-gated-core-main.test.js`
  - Source-level guard tests for the main-process integration points that cannot be required directly in Node.

---

### Task 1: Persist Window Close Behavior

**Files:**
- Modify: `src/main/settings-store.js`
- Modify: `tests/settings-store.test.js`

**Interfaces:**
- Consumes: existing `settingsStore.windowSettings()` and `settingsStore.writeWindowSettings(settings)`.
- Produces:
  - `settingsStore.defaultWindowSettings()` returns `{ bounds, maximized, windowCloseBehavior }`.
  - `settingsStore.windowSettings()` returns normalized `windowCloseBehavior`.
  - `settingsStore.writeWindowSettings({ windowCloseBehavior })` writes only `ask`, `close-to-tray`, or `quit`.
  - `settingsStore.normalizeWindowCloseBehavior(value)` is exported for callers that need explicit normalization.

- [ ] **Step 1: Write failing settings tests**

Append these tests near the existing `windowSettings reads and writes normalized bounds` test in `tests/settings-store.test.js`:

```js
test("windowSettings defaults close behavior to ask", (t) => {
  const { store } = setup(t);

  assert.deepEqual(store.windowSettings(), {
    bounds: null,
    maximized: false,
    windowCloseBehavior: "ask"
  });
});

test("windowSettings normalizes invalid close behavior to ask", (t) => {
  const { runtime, store } = setup(t);
  fs.mkdirSync(path.dirname(runtime.windowSettings), { recursive: true });
  fs.writeFileSync(runtime.windowSettings, JSON.stringify({
    bounds: { x: 1, y: 2, width: 1000, height: 700 },
    maximized: true,
    windowCloseBehavior: "background-forever"
  }));

  assert.deepEqual(store.windowSettings(), {
    bounds: { x: 1, y: 2, width: 1000, height: 700 },
    maximized: true,
    windowCloseBehavior: "ask"
  });
});

test("writeWindowSettings persists remembered close behavior without disturbing bounds", (t) => {
  const { runtime, store } = setup(t);

  store.writeWindowSettings({
    bounds: { x: 12, y: 20, width: 1040, height: 700 },
    maximized: true
  });
  const next = store.writeWindowSettings({ windowCloseBehavior: "close-to-tray" });

  assert.deepEqual(next, {
    bounds: { x: 12, y: 20, width: 1040, height: 700 },
    maximized: true,
    windowCloseBehavior: "close-to-tray"
  });
  assert.deepEqual(readJson(runtime.windowSettings, {}), next);
});

test("writeWindowSettings accepts quit and rejects invalid close behavior", (t) => {
  const { store } = setup(t);

  assert.equal(store.writeWindowSettings({ windowCloseBehavior: "quit" }).windowCloseBehavior, "quit");
  assert.equal(store.writeWindowSettings({ windowCloseBehavior: "nope" }).windowCloseBehavior, "ask");
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
node --test tests/settings-store.test.js
```

Expected: FAIL because `windowCloseBehavior` and `normalizeWindowCloseBehavior` do not exist yet.

- [ ] **Step 3: Implement window close behavior storage**

In `src/main/settings-store.js`, add constants after `APPEARANCE_FONT_PRESETS`:

```js
const WINDOW_CLOSE_BEHAVIORS = new Set(["ask", "close-to-tray", "quit"]);

function normalizeWindowCloseBehavior(value) {
  const behavior = String(value || "").trim();
  return WINDOW_CLOSE_BEHAVIORS.has(behavior) ? behavior : "ask";
}
```

Change `defaultWindowSettings()` to:

```js
function defaultWindowSettings() {
  return {
    bounds: null,
    maximized: false,
    windowCloseBehavior: "ask"
  };
}
```

Change `windowSettings()` to include the normalized behavior:

```js
function windowSettings() {
  const p = runtimePaths();
  const saved = readJson(p.windowSettings, {});
  return {
    bounds: normalizeWindowBounds(saved.bounds),
    maximized: Boolean(saved.maximized),
    windowCloseBehavior: normalizeWindowCloseBehavior(saved.windowCloseBehavior)
  };
}
```

Change `writeWindowSettings(settings = {})` so `next` includes the new field:

```js
const next = {
  bounds: Object.prototype.hasOwnProperty.call(settings, "bounds")
    ? normalizeWindowBounds(settings.bounds)
    : current.bounds,
  maximized: Object.prototype.hasOwnProperty.call(settings, "maximized")
    ? Boolean(settings.maximized)
    : current.maximized,
  windowCloseBehavior: Object.prototype.hasOwnProperty.call(settings, "windowCloseBehavior")
    ? normalizeWindowCloseBehavior(settings.windowCloseBehavior)
    : current.windowCloseBehavior
};
```

Add `normalizeWindowCloseBehavior` to the returned store object next to `defaultWindowSettings`.

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
node --test tests/settings-store.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/settings-store.js tests/settings-store.test.js
git commit -m "feat: persist window close behavior"
```

---

### Task 2: Add Pure Window Close Policy

**Files:**
- Create: `src/main/window-close-policy.js`
- Create: `tests/window-close-policy.test.js`

**Interfaces:**
- Consumes: remembered close behavior from `settingsStore.windowSettings().windowCloseBehavior`.
- Produces:
  - `WINDOW_CLOSE_ACTIONS` constants: `prompt`, `hide-to-tray`, `full-quit`, `keep-open`, `allow-close`.
  - `WINDOW_CLOSE_CHOICES` constants: `close-to-tray`, `quit`.
  - `windowClosePromptOptions()` returns Electron `dialog.showMessageBox` options.
  - `dialogResultToWindowCloseChoice(result)` returns `{ choice, remember }`.
  - `decideWindowClose(input)` returns `{ action, preferenceToWrite, reason }`.

- [ ] **Step 1: Write failing policy tests**

Create `tests/window-close-policy.test.js`:

```js
const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  WINDOW_CLOSE_ACTIONS,
  dialogResultToWindowCloseChoice,
  decideWindowClose,
  windowClosePromptOptions
} = require("../src/main/window-close-policy.js");

test("default ask behavior prompts when Core is running", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "ask",
    coreRunning: true,
    isExplicitQuit: false
  }), {
    action: WINDOW_CLOSE_ACTIONS.PROMPT,
    preferenceToWrite: null,
    reason: "ask"
  });
});

test("remembered close-to-tray hides only when Core is running", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "close-to-tray",
    coreRunning: true,
    isExplicitQuit: false
  }), {
    action: WINDOW_CLOSE_ACTIONS.HIDE_TO_TRAY,
    preferenceToWrite: null,
    reason: "remembered-close-to-tray"
  });
});

test("close-to-tray keeps visible when Core is not running", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "close-to-tray",
    coreRunning: false,
    isExplicitQuit: false
  }), {
    action: WINDOW_CLOSE_ACTIONS.KEEP_OPEN,
    preferenceToWrite: null,
    reason: "core-not-running"
  });
});

test("remembered quit routes to full quit even when Core is already stopped", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "quit",
    coreRunning: false,
    isExplicitQuit: false
  }), {
    action: WINDOW_CLOSE_ACTIONS.FULL_QUIT,
    preferenceToWrite: null,
    reason: "remembered-quit"
  });
});

test("explicit app quit is not intercepted by close policy", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "close-to-tray",
    coreRunning: true,
    isExplicitQuit: true
  }), {
    action: WINDOW_CLOSE_ACTIONS.ALLOW_CLOSE,
    preferenceToWrite: null,
    reason: "explicit-quit"
  });
});

test("unremembered dialog choice does not write preference", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "ask",
    coreRunning: true,
    isExplicitQuit: false,
    dialogChoice: { choice: "close-to-tray", remember: false }
  }), {
    action: WINDOW_CLOSE_ACTIONS.HIDE_TO_TRAY,
    preferenceToWrite: null,
    reason: "dialog-close-to-tray"
  });
});

test("remembered dialog choice writes preference", () => {
  assert.deepEqual(decideWindowClose({
    storedBehavior: "ask",
    coreRunning: true,
    isExplicitQuit: false,
    dialogChoice: { choice: "quit", remember: true }
  }), {
    action: WINDOW_CLOSE_ACTIONS.FULL_QUIT,
    preferenceToWrite: "quit",
    reason: "dialog-quit"
  });
});

test("dialog result maps first button and cancel to close-to-tray", () => {
  assert.deepEqual(dialogResultToWindowCloseChoice({ response: 0, checkboxChecked: true }), {
    choice: "close-to-tray",
    remember: true
  });
  assert.deepEqual(dialogResultToWindowCloseChoice({ response: -1, checkboxChecked: false }), {
    choice: "close-to-tray",
    remember: false
  });
});

test("dialog result maps second button to quit", () => {
  assert.deepEqual(dialogResultToWindowCloseChoice({ response: 1, checkboxChecked: true }), {
    choice: "quit",
    remember: true
  });
});

test("prompt copy and button order match product decision", () => {
  assert.deepEqual(windowClosePromptOptions(), {
    type: "question",
    title: "Keep Mia running in the background?",
    message: "Keep Mia running in the background?",
    detail: "After closing the window, Mia will stay in the menu bar/system tray and Mia Core will keep running for background tasks and local services. You can reopen Mia from the menu bar/system tray, or choose \"Quit Mia\" there to fully stop it.",
    buttons: ["Close to Tray", "Quit Mia"],
    defaultId: 0,
    cancelId: 0,
    checkboxLabel: "Remember my choice",
    checkboxChecked: false,
    noLink: true
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
node --test tests/window-close-policy.test.js
```

Expected: FAIL because `src/main/window-close-policy.js` does not exist.

- [ ] **Step 3: Implement policy module**

Create `src/main/window-close-policy.js`:

```js
const WINDOW_CLOSE_BEHAVIORS = new Set(["ask", "close-to-tray", "quit"]);

const WINDOW_CLOSE_ACTIONS = Object.freeze({
  PROMPT: "prompt",
  HIDE_TO_TRAY: "hide-to-tray",
  FULL_QUIT: "full-quit",
  KEEP_OPEN: "keep-open",
  ALLOW_CLOSE: "allow-close"
});

const WINDOW_CLOSE_CHOICES = Object.freeze({
  CLOSE_TO_TRAY: "close-to-tray",
  QUIT: "quit"
});

function normalizeWindowCloseBehavior(value) {
  const behavior = String(value || "").trim();
  return WINDOW_CLOSE_BEHAVIORS.has(behavior) ? behavior : "ask";
}

function windowClosePromptOptions() {
  return {
    type: "question",
    title: "Keep Mia running in the background?",
    message: "Keep Mia running in the background?",
    detail: "After closing the window, Mia will stay in the menu bar/system tray and Mia Core will keep running for background tasks and local services. You can reopen Mia from the menu bar/system tray, or choose \"Quit Mia\" there to fully stop it.",
    buttons: ["Close to Tray", "Quit Mia"],
    defaultId: 0,
    cancelId: 0,
    checkboxLabel: "Remember my choice",
    checkboxChecked: false,
    noLink: true
  };
}

function dialogResultToWindowCloseChoice(result = {}) {
  const response = Number(result.response);
  return {
    choice: response === 1 ? WINDOW_CLOSE_CHOICES.QUIT : WINDOW_CLOSE_CHOICES.CLOSE_TO_TRAY,
    remember: result.checkboxChecked === true
  };
}

function decision(action, preferenceToWrite, reason) {
  return { action, preferenceToWrite, reason };
}

function decideWindowClose(input = {}) {
  if (input.isExplicitQuit === true) {
    return decision(WINDOW_CLOSE_ACTIONS.ALLOW_CLOSE, null, "explicit-quit");
  }

  const dialogChoice = input.dialogChoice && typeof input.dialogChoice === "object"
    ? input.dialogChoice
    : null;
  if (dialogChoice) {
    const choice = dialogChoice.choice === WINDOW_CLOSE_CHOICES.QUIT
      ? WINDOW_CLOSE_CHOICES.QUIT
      : WINDOW_CLOSE_CHOICES.CLOSE_TO_TRAY;
    const preferenceToWrite = dialogChoice.remember === true ? choice : null;
    if (choice === WINDOW_CLOSE_CHOICES.QUIT) {
      return decision(WINDOW_CLOSE_ACTIONS.FULL_QUIT, preferenceToWrite, "dialog-quit");
    }
    if (input.coreRunning !== true) {
      return decision(WINDOW_CLOSE_ACTIONS.KEEP_OPEN, preferenceToWrite, "core-not-running");
    }
    return decision(WINDOW_CLOSE_ACTIONS.HIDE_TO_TRAY, preferenceToWrite, "dialog-close-to-tray");
  }

  const storedBehavior = normalizeWindowCloseBehavior(input.storedBehavior);
  if (storedBehavior === "quit") {
    return decision(WINDOW_CLOSE_ACTIONS.FULL_QUIT, null, "remembered-quit");
  }
  if (storedBehavior === "close-to-tray") {
    if (input.coreRunning !== true) {
      return decision(WINDOW_CLOSE_ACTIONS.KEEP_OPEN, null, "core-not-running");
    }
    return decision(WINDOW_CLOSE_ACTIONS.HIDE_TO_TRAY, null, "remembered-close-to-tray");
  }
  if (input.coreRunning !== true) {
    return decision(WINDOW_CLOSE_ACTIONS.KEEP_OPEN, null, "core-not-running");
  }
  return decision(WINDOW_CLOSE_ACTIONS.PROMPT, null, "ask");
}

module.exports = {
  WINDOW_CLOSE_ACTIONS,
  WINDOW_CLOSE_CHOICES,
  normalizeWindowCloseBehavior,
  windowClosePromptOptions,
  dialogResultToWindowCloseChoice,
  decideWindowClose
};
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
node --test tests/window-close-policy.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/window-close-policy.js tests/window-close-policy.test.js
git commit -m "feat: add window close policy"
```

---

### Task 3: Add Tray Lifecycle Service

**Files:**
- Create: `src/main/tray-lifecycle-service.js`
- Create: `tests/tray-lifecycle-service.test.js`

**Interfaces:**
- Consumes:
  - Electron-like dependencies: `{ app, Tray, Menu, nativeImage }`.
  - `getCoreStatus(): { running?: boolean, baseUrl?: string, lastError?: string }`.
  - `getActivityCount(): number`.
  - `openMainWindow(): void`.
  - `quitMia(): void | Promise<void>`.
- Produces:
  - `createTrayLifecycleService(deps)`.
  - Service methods: `createOrUpdateTray()`, `refresh()`, `destroyTray()`, `isTrayVisible()`, `setCoreRunning(running)`.

- [ ] **Step 1: Write failing tray service tests**

Create `tests/tray-lifecycle-service.test.js`:

```js
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const { createTrayLifecycleService } = require("../src/main/tray-lifecycle-service.js");

class FakeTray extends EventEmitter {
  constructor(image) {
    super();
    this.image = image;
    this.tooltip = "";
    this.contextMenu = null;
    this.destroyed = false;
  }
  setToolTip(value) { this.tooltip = value; }
  setContextMenu(menu) { this.contextMenu = menu; }
  destroy() { this.destroyed = true; }
}

function fakeDeps(overrides = {}) {
  const calls = [];
  const deps = {
    app: {
      dock: {
        show: () => calls.push(["dock.show"]),
        hide: () => calls.push(["dock.hide"])
      }
    },
    Tray: FakeTray,
    Menu: {
      buildFromTemplate: (template) => ({ template })
    },
    nativeImage: {
      createFromPath: (iconPath) => ({
        iconPath,
        resize: (size) => ({ iconPath, size })
      })
    },
    platform: "darwin",
    iconPath: "/tmp/mia-icon.png",
    getCoreStatus: () => ({ running: true, baseUrl: "http://127.0.0.1:27861" }),
    getActivityCount: () => 2,
    openMainWindow: () => calls.push(["open"]),
    quitMia: () => calls.push(["quit"]),
    log: (line) => calls.push(["log", line]),
    ...overrides
  };
  return { deps, calls };
}

test("createOrUpdateTray creates icon and menu while Core is running", () => {
  const { deps } = fakeDeps();
  const service = createTrayLifecycleService(deps);

  service.createOrUpdateTray();

  assert.equal(service.isTrayVisible(), true);
  const tray = service._testOnlyTray();
  assert.equal(tray.tooltip, "Mia Core running");
  assert.deepEqual(tray.image, { iconPath: "/tmp/mia-icon.png", size: { width: 16, height: 16 } });
  assert.deepEqual(tray.contextMenu.template.map((item) => item.label), [
    "Open Mia",
    "Mia Core: Running",
    "Background activity: 2",
    "Quit Mia"
  ]);
});

test("setCoreRunning false destroys tray", () => {
  const { deps } = fakeDeps();
  const service = createTrayLifecycleService(deps);

  service.setCoreRunning(true);
  const tray = service._testOnlyTray();
  service.setCoreRunning(false);

  assert.equal(tray.destroyed, true);
  assert.equal(service.isTrayVisible(), false);
});

test("open menu item shows Dock before opening on macOS", () => {
  const { deps, calls } = fakeDeps();
  const service = createTrayLifecycleService(deps);

  service.setCoreRunning(true);
  service._testOnlyTray().contextMenu.template[0].click();

  assert.deepEqual(calls, [["dock.show"], ["open"]]);
});

test("quit menu item calls quitMia", () => {
  const { deps, calls } = fakeDeps();
  const service = createTrayLifecycleService(deps);

  service.setCoreRunning(true);
  service._testOnlyTray().contextMenu.template[3].click();

  assert.deepEqual(calls, [["quit"]]);
});

test("createOrUpdateTray skips misleading icon when Core is not running", () => {
  const { deps } = fakeDeps({ getCoreStatus: () => ({ running: false }) });
  const service = createTrayLifecycleService(deps);

  service.createOrUpdateTray();

  assert.equal(service.isTrayVisible(), false);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
node --test tests/tray-lifecycle-service.test.js
```

Expected: FAIL because `src/main/tray-lifecycle-service.js` does not exist.

- [ ] **Step 3: Implement tray lifecycle service**

Create `src/main/tray-lifecycle-service.js`:

```js
function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function createTrayLifecycleService(deps = {}) {
  const {
    app,
    Tray,
    Menu,
    nativeImage,
    platform = process.platform,
    iconPath,
    getCoreStatus = () => ({ running: false }),
    getActivityCount = () => 0,
    openMainWindow = () => {},
    quitMia = () => {},
    log = () => {}
  } = deps;

  let tray = null;

  function coreStatus() {
    const status = getCoreStatus() || {};
    return {
      ...status,
      running: status.running === true
    };
  }

  function trayImage() {
    const image = nativeImage.createFromPath(iconPath);
    if (image && typeof image.resize === "function") {
      return image.resize(platform === "darwin"
        ? { width: 16, height: 16 }
        : { width: 32, height: 32 });
    }
    return image;
  }

  function buildMenu() {
    const status = coreStatus();
    const activityCount = safeNumber(getActivityCount());
    return Menu.buildFromTemplate([
      {
        label: "Open Mia",
        click: () => {
          if (platform === "darwin" && app?.dock && typeof app.dock.show === "function") {
            app.dock.show();
          }
          openMainWindow();
        }
      },
      {
        label: status.running ? "Mia Core: Running" : "Mia Core: Stopped",
        enabled: false
      },
      {
        label: `Background activity: ${activityCount}`,
        enabled: false
      },
      { type: "separator" },
      {
        label: "Quit Mia",
        click: () => quitMia()
      }
    ]);
  }

  function createOrUpdateTray() {
    const status = coreStatus();
    if (!status.running) {
      destroyTray();
      return null;
    }
    if (!Tray || !Menu || !nativeImage || !iconPath) {
      log("Tray unavailable; keeping the main window visible.");
      return null;
    }
    if (!tray) {
      tray = new Tray(trayImage());
      tray.setToolTip("Mia Core running");
      tray.on?.("double-click", () => {
        if (platform === "darwin" && app?.dock && typeof app.dock.show === "function") app.dock.show();
        openMainWindow();
      });
      tray.on?.("click", () => {
        if (platform !== "darwin") openMainWindow();
      });
    }
    tray.setContextMenu(buildMenu());
    return tray;
  }

  function refresh() {
    return createOrUpdateTray();
  }

  function destroyTray() {
    if (!tray) return;
    try {
      tray.destroy();
    } finally {
      tray = null;
    }
  }

  function setCoreRunning(running) {
    if (running === true) {
      createOrUpdateTray();
      return;
    }
    destroyTray();
  }

  function isTrayVisible() {
    return Boolean(tray);
  }

  return {
    createOrUpdateTray,
    refresh,
    destroyTray,
    isTrayVisible,
    setCoreRunning,
    _testOnlyTray: () => tray
  };
}

module.exports = { createTrayLifecycleService };
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
node --test tests/tray-lifecycle-service.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/tray-lifecycle-service.js tests/tray-lifecycle-service.test.js
git commit -m "feat: add tray lifecycle service"
```

---

### Task 4: Wire Main Window Close And Full Quit

**Files:**
- Modify: `src/main.js`
- Create: `tests/tray-gated-core-main.test.js`

**Interfaces:**
- Consumes:
  - `settingsStore.windowSettings().windowCloseBehavior`
  - `settingsStore.writeWindowSettings({ windowCloseBehavior })`
  - `startDaemonService()`
  - `stopDaemonService()`
  - `getDaemonStatus()`
  - `dialog.showMessageBox()`
  - `app.dock.show()` / `app.dock.hide()` on macOS
- Produces:
  - `requestFullMiaQuit(reason)` in `src/main.js`
  - `showMainWindowFromTray()` in `src/main.js`
  - `handleMainWindowClose(event, win)` in `src/main.js`
  - Core start creates/refreshes tray.
  - Core stop destroys tray.
  - Window close prompt applies remembered choices.

- [ ] **Step 1: Write failing main integration guard tests**

Create `tests/tray-gated-core-main.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("main imports tray lifecycle and window close policy modules", () => {
  const main = read("src/main.js");

  assert.match(main, /const \{ app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray \} = require\("electron"\)/);
  assert.match(main, /createTrayLifecycleService/);
  assert.match(main, /decideWindowClose/);
  assert.match(main, /windowClosePromptOptions/);
  assert.match(main, /dialogResultToWindowCloseChoice/);
});

test("main wires BrowserWindow close through tray-gated close policy", () => {
  const main = read("src/main.js");
  const createWindowSource = main.match(/function createWindow\(\) \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(createWindowSource, /win\.on\("close", \(event\) => \{/);
  assert.match(createWindowSource, /handleMainWindowClose\(event, win\)/);
  assert.match(main, /function handleMainWindowClose\(event, win\)/);
  assert.match(main, /settingsStore\.windowSettings\(\)\.windowCloseBehavior/);
  assert.match(main, /settingsStore\.writeWindowSettings\(\{ windowCloseBehavior: decision\.preferenceToWrite \}\)/);
});

test("main full quit path stops Core before removing tray and quitting", () => {
  const main = read("src/main.js");
  const quitSource = main.match(/async function requestFullMiaQuit\(reason = "app"\) \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(quitSource, /explicitMiaQuitInProgress = true/);
  assert.match(quitSource, /await stopDaemonService\(\)/);
  assert.match(quitSource, /trayLifecycleService\.destroyTray\(\)/);
  assert.match(quitSource, /app\.quit\(\)/);
});

test("main updates tray state from Core start and stop", () => {
  const main = read("src/main.js");
  const startSource = main.match(/async function startDaemonService\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  const stopSource = main.match(/async function stopDaemonService\(\) \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(startSource, /markCoreRunningForTray\(true\)/);
  assert.match(stopSource, /markCoreRunningForTray\(false\)/);
});

test("window-all-closed does not bypass tray-visible background state", () => {
  const main = read("src/main.js");
  const block = main.match(/app\.on\("window-all-closed", \(\) => \{[\s\S]*?\n\}\);/)?.[0] || "";

  assert.match(block, /trayLifecycleService\.isTrayVisible\(\)/);
  assert.match(block, /requestFullMiaQuit\("window-all-closed"\)/);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
node --test tests/tray-gated-core-main.test.js
```

Expected: FAIL because `src/main.js` has not been wired yet.

- [ ] **Step 3: Import Electron tray primitives and new services**

Change the first line of `src/main.js` to:

```js
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } = require("electron");
```

Add imports near the other main-process service imports:

```js
const { createTrayLifecycleService } = require("./main/tray-lifecycle-service.js");
const {
  WINDOW_CLOSE_ACTIONS,
  decideWindowClose,
  dialogResultToWindowCloseChoice,
  windowClosePromptOptions
} = require("./main/window-close-policy.js");
```

- [ ] **Step 4: Add tray and quit state helpers**

After `const windowStateManager = createWindowStateManager({ settingsStore, screen });`, add:

```js
let explicitMiaQuitInProgress = false;
let fullMiaQuitPromise = null;

function coreRunningForTray() {
  try {
    return getDaemonStatus()?.running === true;
  } catch {
    return false;
  }
}

function markCoreRunningForTray(running) {
  if (!shouldRunDesktopInstance || IS_CORE_PROCESS) return;
  trayLifecycleService.setCoreRunning(running === true);
}

function trayActivityCount() {
  return 0;
}

function trayIconPath() {
  return path.join(__dirname, "..", "build", "icon.png");
}
```

Then instantiate the service:

```js
const trayLifecycleService = createTrayLifecycleService({
  app,
  Tray,
  Menu,
  nativeImage,
  platform: process.platform,
  iconPath: trayIconPath(),
  getCoreStatus: getDaemonStatus,
  getActivityCount: trayActivityCount,
  openMainWindow: showMainWindowFromTray,
  quitMia: () => requestFullMiaQuit("tray"),
  log: appendDaemonLog
});
```

Function declarations are hoisted, so `getDaemonStatus`, `showMainWindowFromTray`, and `requestFullMiaQuit` can be defined later in the file.

- [ ] **Step 5: Add restore and full quit functions**

Add these functions near `showSignedOutOnboardingWindow(win)`:

```js
function showMainWindowFromTray() {
  if (process.platform === "darwin" && app.dock && typeof app.dock.show === "function") {
    app.dock.show();
  }
  let target = BrowserWindow.getAllWindows().find((win) => win && !win.isDestroyed());
  if (!target) {
    target = createWindow();
  }
  if (typeof target.isMinimized === "function" && target.isMinimized()) target.restore();
  if (!target.isVisible()) target.show();
  if (typeof target.focus === "function") target.focus();
  return target;
}

async function requestFullMiaQuit(reason = "app") {
  if (fullMiaQuitPromise) return fullMiaQuitPromise;
  explicitMiaQuitInProgress = true;
  fullMiaQuitPromise = (async () => {
    try {
      await stopDaemonService();
    } catch (error) {
      appendDaemonLog(`Full Mia quit Core stop failed (${reason}): ${error?.message || error}`);
    } finally {
      trayLifecycleService.destroyTray();
      app.quit();
    }
  })();
  return fullMiaQuitPromise;
}
```

- [ ] **Step 6: Add close decision application**

Add these functions near `showMainWindowFromTray()`:

```js
function applyMainWindowCloseDecision(event, win, decision) {
  if (decision.preferenceToWrite) {
    settingsStore.writeWindowSettings({ windowCloseBehavior: decision.preferenceToWrite });
  }

  if (decision.action === WINDOW_CLOSE_ACTIONS.ALLOW_CLOSE) return;

  event.preventDefault();

  if (decision.action === WINDOW_CLOSE_ACTIONS.HIDE_TO_TRAY) {
    if (win && !win.isDestroyed()) win.hide();
    if (process.platform === "darwin" && app.dock && typeof app.dock.hide === "function") {
      app.dock.hide();
    }
    trayLifecycleService.refresh();
    return;
  }

  if (decision.action === WINDOW_CLOSE_ACTIONS.FULL_QUIT) {
    requestFullMiaQuit("window-close");
    return;
  }

  if (win && !win.isDestroyed() && typeof win.show === "function") {
    win.show();
    if (typeof win.focus === "function") win.focus();
  }
}

async function promptAndApplyMainWindowClose(event, win) {
  try {
    const result = await dialog.showMessageBox(win, windowClosePromptOptions());
    const dialogChoice = dialogResultToWindowCloseChoice(result);
    const decision = decideWindowClose({
      storedBehavior: "ask",
      coreRunning: coreRunningForTray(),
      isExplicitQuit: explicitMiaQuitInProgress,
      dialogChoice
    });
    applyMainWindowCloseDecision(event, win, decision);
  } catch (error) {
    appendDaemonLog(`Window close prompt failed: ${error?.message || error}`);
    if (win && !win.isDestroyed()) {
      win.show();
      if (typeof win.focus === "function") win.focus();
    }
  }
}

function handleMainWindowClose(event, win) {
  const decision = decideWindowClose({
    storedBehavior: settingsStore.windowSettings().windowCloseBehavior,
    coreRunning: coreRunningForTray(),
    isExplicitQuit: explicitMiaQuitInProgress
  });

  if (decision.action === WINDOW_CLOSE_ACTIONS.PROMPT) {
    event.preventDefault();
    promptAndApplyMainWindowClose(event, win);
    return;
  }

  applyMainWindowCloseDecision(event, win, decision);
}
```

- [ ] **Step 7: Attach close handler to created windows**

Inside `createWindow()`, after the existing window event listeners:

```js
win.on("close", (event) => {
  handleMainWindowClose(event, win);
});
```

Place it near the existing `focus`, `blur`, `maximize`, and `unmaximize` handlers so all window lifecycle hooks are together.

- [ ] **Step 8: Update Core start/stop to drive tray state**

In every successful branch of `startDaemonService()`, before returning a running status, set the tray state. Use this exact pattern:

```js
const status = { ...getDaemonStatus(), running: true, baseUrl: existing.baseUrl };
markCoreRunningForTray(true);
return status;
```

Apply the same pattern to the two other successful return branches that currently return `{ ...getDaemonStatus(), running: true, baseUrl: ping.baseUrl }`.

Change `stopDaemonService()` to destroy tray state after Core stop:

```js
async function stopDaemonService() {
  await launchdService.cleanupLegacyNodeCore();
  if (shouldUseLaunchdForCore() && !IS_CORE_PROCESS) {
    await launchdService.stopCore();
  }
  const result = miaCoreControlServer.stop();
  markCoreRunningForTray(false);
  return result;
}
```

- [ ] **Step 9: Update app quit and window-all-closed hooks**

Add a `before-quit` handler after the existing agent-session cleanup handler:

```js
app.on("before-quit", (event) => {
  if (IS_CORE_PROCESS || !shouldRunDesktopInstance || explicitMiaQuitInProgress) return;
  event.preventDefault();
  requestFullMiaQuit("before-quit");
});
```

Change `window-all-closed` to:

```js
app.on("window-all-closed", () => {
  authService.cancelCodexOAuth();
  if (IS_CORE_PROCESS) return;
  if (trayLifecycleService.isTrayVisible()) return;
  if (process.platform !== "darwin") requestFullMiaQuit("window-all-closed");
});
```

Change `activate` so macOS restore also shows the Dock:

```js
app.on("activate", () => {
  if (IS_CORE_PROCESS) return;
  if (process.platform === "darwin" && app.dock && typeof app.dock.show === "function") app.dock.show();
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (!cloudStatus(false).enabled) showSignedOutOnboardingWindow(BrowserWindow.getAllWindows()[0]);
  else showMainWindowFromTray();
});
```

- [ ] **Step 10: Run focused tests**

Run:

```bash
node --test tests/tray-gated-core-main.test.js tests/window-close-policy.test.js tests/tray-lifecycle-service.test.js tests/settings-store.test.js
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/main.js tests/tray-gated-core-main.test.js
git commit -m "feat: gate Core lifecycle behind tray"
```

---

### Task 5: Verification And Manual QA

**Files:**
- Modify only if tests reveal a narrow issue from prior tasks.

**Interfaces:**
- Consumes: all prior task deliverables.
- Produces: verified tray-gated lifecycle behavior and final implementation commit if fixes were needed.

- [ ] **Step 1: Run the full Node test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run package-level Core packaging verification**

Run:

```bash
npm run desktop:package:verify
```

Expected: PASS.

This command is focused on bundled Core packaging. It does not prove tray UI behavior, but it protects the Core launch surface touched by the lifecycle work.

- [ ] **Step 3: Manual macOS QA**

Run the app:

```bash
npm start
```

Verify manually:

- first close button click shows the native prompt;
- choosing `Close to Tray` without `Remember my choice` hides the window and leaves the menu bar icon;
- reopening from the menu bar shows the Dock icon and focuses the window;
- closing again prompts again;
- choosing `Close to Tray` with `Remember my choice` skips future prompts;
- tray/menu bar `Quit Mia` removes the icon, stops Core, and exits Mia;
- relaunching, choosing `Quit Mia` with `Remember my choice`, and clicking the close button fully exits without leaving a menu bar icon;
- if Core is stopped from the existing Core controls, the tray/menu bar icon disappears.

- [ ] **Step 4: Manual Windows QA**

On Windows, run the app and verify:

- first close button click shows the native prompt;
- `Close to Tray` hides the taskbar entry and leaves the system tray icon;
- system tray `Open Mia` restores and focuses the window;
- system tray `Quit Mia` removes the tray icon, stops Core, and exits Mia;
- no Mia Core process remains after tray quit.

- [ ] **Step 5: Final source audit**

Run:

```bash
rg -n "windowCloseBehavior|createTrayLifecycleService|requestFullMiaQuit|handleMainWindowClose|app\\.dock\\.(hide|show)" src/main.js src/main tests
```

Expected:

- `windowCloseBehavior` appears in settings tests, settings store, close policy, and main integration.
- `createTrayLifecycleService` appears in `src/main/tray-lifecycle-service.js`, its tests, and `src/main.js`.
- `requestFullMiaQuit` is the only new full-product quit path.
- `app.dock.hide()` is only used for close-to-tray.
- `app.dock.show()` is used for tray/open/activate restore.

- [ ] **Step 6: Commit any verification fixes**

Only if Step 1-5 required fixes:

```bash
git add src/main.js src/main/settings-store.js src/main/window-close-policy.js src/main/tray-lifecycle-service.js tests/settings-store.test.js tests/window-close-policy.test.js tests/tray-lifecycle-service.test.js tests/tray-gated-core-main.test.js
git commit -m "fix: verify tray gated core lifecycle"
```

Expected: no commit is needed if all prior task commits already passed.

---

## Plan Self-Review

- Spec coverage:
  - Tray/menu bar icon maps to Core running state: Task 3 and Task 4.
  - First close prompt and remembered checkbox: Task 1, Task 2, Task 4.
  - Tray quit fully stops Core: Task 3 and Task 4.
  - macOS Dock hidden while closed to tray: Task 4.
  - Windows system tray model: Task 3 and manual QA in Task 5.
  - No helper process: covered by architecture and file structure.
  - No logout/Core protocol redesign: covered by global constraints and scoped files.
- Marker scan: no unfinished-work markers or undefined future tasks are required.
- Type consistency:
  - Stored values are `ask`, `close-to-tray`, `quit`.
  - Dialog choices are `close-to-tray`, `quit`.
  - Policy actions are `prompt`, `hide-to-tray`, `full-quit`, `keep-open`, `allow-close`.
  - Main integration consumes only the interfaces produced by Tasks 1-3.
