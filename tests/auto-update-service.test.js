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

  quitAndInstall() {
    this.quitCalled = true;
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
