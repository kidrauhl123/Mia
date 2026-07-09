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

test("refresh destroys visible tray when Core is no longer running", () => {
  let running = true;
  const { deps } = fakeDeps({ getCoreStatus: () => ({ running }) });
  const service = createTrayLifecycleService(deps);

  service.createOrUpdateTray();
  const tray = service._testOnlyTray();
  running = false;
  service.refresh();

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

test("non-mac tray click opens the main window", () => {
  const { deps, calls } = fakeDeps({ platform: "win32" });
  const service = createTrayLifecycleService(deps);

  service.setCoreRunning(true);
  service._testOnlyTray().emit("click");

  assert.deepEqual(calls, [["open"]]);
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

test("missing tray dependencies are logged without creating an icon", () => {
  const { deps, calls } = fakeDeps({ Tray: null });
  const service = createTrayLifecycleService(deps);

  service.createOrUpdateTray();

  assert.equal(service.isTrayVisible(), false);
  assert.deepEqual(calls, [["log", "Tray unavailable; keeping the main window visible."]]);
});
