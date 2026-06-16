const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createAutoUpdateService } = require("../src/main/updater/auto-update-service.js");

class FakeUpdater extends EventEmitter {
  constructor(checkForUpdates) {
    super();
    this.checkForUpdatesImpl = checkForUpdates;
    this.checkCalls = 0;
    this.quitCalled = false;
  }

  checkForUpdates() {
    this.checkCalls += 1;
    return this.checkForUpdatesImpl?.();
  }

  quitAndInstall(...args) {
    this.quitCalled = true;
    this.quitArgs = args;
  }
}

function createService(updater, overrides = {}) {
  return createAutoUpdateService({
    getAutoUpdater: () => updater,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    isPackaged: true,
    getMainWindow: () => null,
    checkIntervalMs: 60 * 60 * 1000,
    logger: { info() {}, warn() {} },
    ...overrides,
  });
}

test("manual update check is disabled in dev or unpacked builds", async () => {
  let constructed = false;
  const service = createAutoUpdateService({
    getAutoUpdater: () => {
      constructed = true;
      throw new Error("updater should stay lazy");
    },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    isPackaged: false,
    logger: { info() {}, warn() {} },
  });

  assert.deepEqual(await service.checkForUpdates(), {
    status: "disabled",
    reason: "dev/unpacked build",
  });
  assert.equal(constructed, false);
});

test("manual update check reports when the current build is latest", async () => {
  let updater;
  updater = new FakeUpdater(() => {
    process.nextTick(() => updater.emit("update-not-available", { version: "0.1.10" }));
    return Promise.resolve({ updateInfo: { version: "0.1.10" } });
  });

  const result = await createService(updater).checkForUpdates();

  assert.deepEqual(result, { status: "not-available", version: "0.1.10" });
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.checkCalls, 1);
});

test("manual update check reports available updates without waiting for download", async () => {
  const updater = new FakeUpdater(() => Promise.resolve({
    updateInfo: { version: "0.1.11" },
    downloadPromise: Promise.resolve(),
  }));

  const result = await createService(updater).checkForUpdates();

  assert.deepEqual(result, { status: "available", version: "0.1.11" });
  assert.equal(updater.checkCalls, 1);
});

test("manual update check serializes update errors for the renderer", async () => {
  const updater = new FakeUpdater(() => {
    throw Object.assign(new Error("network down"), { code: "ENETDOWN" });
  });

  const result = await createService(updater).checkForUpdates();

  assert.deepEqual(result, {
    status: "error",
    error: { message: "network down", code: "ENETDOWN" },
  });
});

test("available updates lock the app, report progress, and force install", async () => {
  const events = [];
  const calls = [];
  const scheduled = [];
  let quitFallbackCalled = false;
  let updater;
  updater = new FakeUpdater(() => {
    updater.emit("update-available", { version: "0.1.12" });
    return Promise.resolve({
      updateInfo: { version: "0.1.12" },
      downloadPromise: Promise.resolve(),
    });
  });

  const win = {
    isDestroyed: () => false,
    show: () => calls.push(["show"]),
    focus: () => calls.push(["focus"]),
    setClosable: (value) => calls.push(["closable", value]),
    setMinimizable: (value) => calls.push(["minimizable", value]),
    setMaximizable: (value) => calls.push(["maximizable", value]),
  };
  const service = createService(updater, {
    getMainWindows: () => [win],
    sendUpdateEvent: (payload) => events.push(payload),
    forceInstallDelayMs: 25,
    installRetryDelayMs: 50,
    installQuitFallbackDelayMs: 75,
    quitApp: () => { quitFallbackCalled = true; },
    setTimeoutFn: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    },
  });

  const result = await service.checkForUpdates();
  assert.deepEqual(result, { status: "available", version: "0.1.12" });
  assert.equal(events[0].status, "available");
  assert.equal(events[0].mandatory, true);
  assert.deepEqual(calls.slice(0, 5), [
    ["show"],
    ["focus"],
    ["closable", false],
    ["minimizable", false],
    ["maximizable", false],
  ]);

  updater.emit("download-progress", {
    percent: 44.4,
    bytesPerSecond: 512,
    transferred: 44,
    total: 100,
  });
  assert.deepEqual(events.at(-1).progress, {
    percent: 44.4,
    bytesPerSecond: 512,
    transferred: 44,
    total: 100,
  });

  updater.emit("update-downloaded", { version: "0.1.12" });
  assert.equal(events.at(-1).status, "downloaded");
  assert.equal(events.at(-1).progress.percent, 100);
  assert.equal(scheduled[0].ms, 25);
  assert.equal(updater.quitCalled, false);

  scheduled[0].fn();
  assert.equal(events.at(-1).status, "installing");
  assert.equal(updater.quitCalled, true);
  assert.deepEqual(updater.quitArgs, [true, true]);
  assert.deepEqual(calls.slice(-3), [
    ["closable", true],
    ["minimizable", true],
    ["maximizable", true],
  ]);
  assert.equal(scheduled[1].ms, 50);
  assert.equal(scheduled[2].ms, 75);

  scheduled[1].fn();
  assert.equal(updater.quitCalled, true);

  scheduled[2].fn();
  assert.equal(quitFallbackCalled, true);
});

test("update install watchdog stops after before-quit-for-update", async () => {
  const scheduled = [];
  let quitFallbackCalled = false;
  let updater;
  updater = new FakeUpdater(() => {
    updater.emit("update-available", { version: "0.1.12" });
    return Promise.resolve({
      updateInfo: { version: "0.1.12" },
      downloadPromise: Promise.resolve(),
    });
  });
  const service = createService(updater, {
    forceInstallDelayMs: 1,
    installRetryDelayMs: 2,
    installQuitFallbackDelayMs: 3,
    quitApp: () => { quitFallbackCalled = true; },
    setTimeoutFn: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    },
  });

  await service.checkForUpdates();
  updater.emit("update-downloaded", { version: "0.1.12" });
  scheduled[0].fn();
  updater.emit("before-quit-for-update");

  scheduled[1].fn();
  scheduled[2].fn();
  assert.equal(quitFallbackCalled, false);
});

test("update errors unlock the app and notify the renderer", async () => {
  const events = [];
  const calls = [];
  const updater = new FakeUpdater(() => Promise.resolve({
    updateInfo: { version: "0.1.12" },
    downloadPromise: Promise.resolve(),
  }));
  const win = {
    isDestroyed: () => false,
    show: () => calls.push(["show"]),
    focus: () => calls.push(["focus"]),
    setClosable: (value) => calls.push(["closable", value]),
    setMinimizable: (value) => calls.push(["minimizable", value]),
    setMaximizable: (value) => calls.push(["maximizable", value]),
  };

  await createService(updater, {
    getMainWindows: () => [win],
    sendUpdateEvent: (payload) => events.push(payload),
  }).checkForUpdates();

  updater.emit("update-available", { version: "0.1.12" });
  updater.emit("error", Object.assign(new Error("download failed"), { code: "EIO" }));

  assert.equal(events.at(-1).status, "error");
  assert.deepEqual(events.at(-1).error, { message: "download failed", code: "EIO" });
  assert.deepEqual(calls.slice(-3), [
    ["closable", true],
    ["minimizable", true],
    ["maximizable", true],
  ]);
});
