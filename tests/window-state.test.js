const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const {
  DEFAULT_WINDOW_BOUNDS,
  createWindowStateManager
} = require("../src/main/window-state.js");

function fakeScreen(workArea = { x: 0, y: 0, width: 1440, height: 900 }) {
  return {
    getPrimaryDisplay: () => ({ workArea }),
    getDisplayMatching: () => ({ workArea })
  };
}

function storeWith(settings = {}) {
  const writes = [];
  return {
    writes,
    store: {
      windowSettings: () => settings,
      writeWindowSettings: (next) => {
        writes.push(next);
        return next;
      }
    }
  };
}

class FakeWindow extends EventEmitter {
  constructor(bounds, options = {}) {
    super();
    this.bounds = bounds;
    this.maximized = Boolean(options.maximized);
    this.fullscreen = Boolean(options.fullscreen);
    this.destroyed = false;
  }

  isDestroyed() { return this.destroyed; }
  getNormalBounds() { return { ...this.bounds }; }
  isMaximized() { return this.maximized; }
  isFullScreen() { return this.fullscreen; }
}

test("initialWindowState uses the smaller default when there is no saved user layout", () => {
  const { store } = storeWith({ bounds: null, maximized: false });
  const manager = createWindowStateManager({ settingsStore: store, screen: fakeScreen() });

  assert.deepEqual(manager.initialWindowState(), {
    bounds: { ...DEFAULT_WINDOW_BOUNDS },
    maximized: false
  });
});

test("initialWindowState restores saved bounds and maximized state", () => {
  const { store } = storeWith({
    bounds: { x: 80, y: 44, width: 1180, height: 780 },
    maximized: true
  });
  const manager = createWindowStateManager({ settingsStore: store, screen: fakeScreen() });

  assert.deepEqual(manager.initialWindowState(), {
    bounds: { x: 80, y: 44, width: 1180, height: 780 },
    maximized: true
  });
});

test("initialWindowState preserves the compact narrow saved width", () => {
  const { store } = storeWith({
    bounds: { x: 80, y: 44, width: 360, height: 640 },
    maximized: false
  });
  const manager = createWindowStateManager({ settingsStore: store, screen: fakeScreen() });

  assert.deepEqual(manager.initialWindowState(), {
    bounds: { x: 80, y: 44, width: 360, height: 640 },
    maximized: false
  });
});

test("initialWindowState drops offscreen position but keeps a usable saved size", () => {
  const { store } = storeWith({
    bounds: { x: 3000, y: 1200, width: 1200, height: 780 },
    maximized: false
  });
  const manager = createWindowStateManager({
    settingsStore: store,
    screen: fakeScreen({ x: 0, y: 0, width: 1280, height: 800 })
  });

  assert.deepEqual(manager.initialWindowState(), {
    bounds: { width: 1200, height: 780 },
    maximized: false
  });
});

test("attachWindowStatePersistence saves normal bounds on close", () => {
  const { store, writes } = storeWith();
  const manager = createWindowStateManager({
    settingsStore: store,
    screen: fakeScreen(),
    setTimeoutFn: (fn) => { fn(); return 1; },
    clearTimeoutFn: () => {}
  });
  const win = new FakeWindow({ x: 24, y: 36, width: 1100, height: 720 }, { maximized: true });

  manager.attachWindowStatePersistence(win);
  win.emit("close");

  assert.deepEqual(writes.at(-1), {
    bounds: { x: 24, y: 36, width: 1100, height: 720 },
    maximized: true
  });
});
