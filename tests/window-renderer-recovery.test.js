const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  installWindowRendererRecovery,
  isRendererRecoveryUrl
} = require("../src/main/window-renderer-recovery.js");

function createWebContents(url = "file:///app/src/renderer/index.html") {
  const webContents = new EventEmitter();
  webContents.destroyed = false;
  webContents.url = url;
  webContents.getURL = () => webContents.url;
  webContents.isDestroyed = () => webContents.destroyed;
  return webContents;
}

function createClock() {
  let currentTime = 1_000;
  let nextTimerId = 1;
  const timers = new Map();
  return {
    advance(ms) {
      currentTime += ms;
    },
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    now: () => currentTime,
    async runNext() {
      const entry = timers.entries().next().value;
      assert.ok(entry, "expected a scheduled renderer recovery timer");
      const [timerId, timer] = entry;
      timers.delete(timerId);
      timer.callback();
      await Promise.resolve();
      await Promise.resolve();
      return timer.delayMs;
    },
    setTimeout(callback, delayMs) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, { callback, delayMs });
      return timerId;
    },
    timerCount: () => timers.size
  };
}

test("renderer recovery reloads a crashed renderer with bounded backoff", async () => {
  const webContents = createWebContents();
  const clock = createClock();
  const logs = [];
  let reloadCalls = 0;
  let fallbackCalls = 0;
  const recovery = installWindowRendererRecovery({
    clearTimeoutFn: clock.clearTimeout,
    log: (...args) => logs.push(args),
    now: clock.now,
    reload: () => { reloadCalls += 1; },
    reloadDelaysMs: [10, 25],
    retryWindowMs: 100,
    setTimeoutFn: clock.setTimeout,
    showFallback: () => { fallbackCalls += 1; },
    webContents
  });

  webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  assert.equal(recovery.state(), "scheduled");
  assert.equal(await clock.runNext(), 10);
  assert.equal(reloadCalls, 1);
  assert.equal(recovery.state(), "loading");

  webContents.emit("did-finish-load");
  assert.equal(recovery.state(), "idle");
  webContents.emit("render-process-gone", {}, { reason: "oom", exitCode: 9 });
  assert.equal(await clock.runNext(), 25);
  assert.equal(reloadCalls, 2);

  webContents.emit("render-process-gone", {}, { reason: "memory-eviction", exitCode: 0 });
  await Promise.resolve();
  assert.equal(fallbackCalls, 1);
  assert.equal(recovery.state(), "loading-fallback");
  assert.match(logs[0][1], /scheduling reload 1\/2/);
  assert.ok(logs.some((entry) => /automatic reload limit reached/.test(entry[1])));
});

test("renderer recovery retries main-frame load failures but ignores cancellation and subframes", async () => {
  const webContents = createWebContents();
  const clock = createClock();
  let reloadCalls = 0;
  installWindowRendererRecovery({
    clearTimeoutFn: clock.clearTimeout,
    now: clock.now,
    reload: () => { reloadCalls += 1; },
    reloadDelaysMs: [5],
    setTimeoutFn: clock.setTimeout,
    showFallback: () => {},
    webContents
  });

  webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "file:///app", true);
  webContents.emit("did-fail-load", {}, -2, "ERR_FAILED", "file:///asset", false);
  assert.equal(clock.timerCount(), 0);

  webContents.emit("did-fail-load", {}, -2, "ERR_FAILED", "file:///app", true);
  assert.equal(clock.timerCount(), 1);
  await clock.runNext();
  assert.equal(reloadCalls, 1);
});

test("renderer recovery resets its attempt window after a stable interval", async () => {
  const webContents = createWebContents();
  const clock = createClock();
  let reloadCalls = 0;
  let fallbackCalls = 0;
  installWindowRendererRecovery({
    clearTimeoutFn: clock.clearTimeout,
    now: clock.now,
    reload: () => { reloadCalls += 1; },
    reloadDelaysMs: [5],
    retryWindowMs: 50,
    setTimeoutFn: clock.setTimeout,
    showFallback: () => { fallbackCalls += 1; },
    webContents
  });

  webContents.emit("render-process-gone", {}, { reason: "crashed" });
  await clock.runNext();
  webContents.emit("did-finish-load");
  clock.advance(51);
  webContents.emit("render-process-gone", {}, { reason: "crashed" });
  await clock.runNext();

  assert.equal(reloadCalls, 2);
  assert.equal(fallbackCalls, 0);
});

test("renderer recovery stops during quit and disposes event listeners and timers", () => {
  const webContents = createWebContents();
  const clock = createClock();
  let shuttingDown = true;
  const recovery = installWindowRendererRecovery({
    clearTimeoutFn: clock.clearTimeout,
    isShuttingDown: () => shuttingDown,
    now: clock.now,
    reload: () => {},
    setTimeoutFn: clock.setTimeout,
    showFallback: () => {},
    webContents
  });

  webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(clock.timerCount(), 0);
  shuttingDown = false;
  webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(clock.timerCount(), 1);
  recovery.dispose();
  assert.equal(clock.timerCount(), 0);
  assert.equal(webContents.listenerCount("render-process-gone"), 0);
  assert.equal(webContents.listenerCount("did-fail-load"), 0);
  assert.equal(webContents.listenerCount("did-finish-load"), 0);
});

test("renderer recovery never loops when the fallback page itself cannot load", async () => {
  const webContents = createWebContents();
  const clock = createClock();
  const logs = [];
  let fallbackCalls = 0;
  installWindowRendererRecovery({
    clearTimeoutFn: clock.clearTimeout,
    log: (...args) => logs.push(args),
    now: clock.now,
    reload: () => {},
    reloadDelaysMs: [],
    setTimeoutFn: clock.setTimeout,
    showFallback: () => {
      fallbackCalls += 1;
    },
    webContents
  });

  webContents.emit("render-process-gone", {}, { reason: "crashed" });
  await Promise.resolve();
  assert.equal(fallbackCalls, 1);
  webContents.emit(
    "did-fail-load",
    {},
    -6,
    "ERR_FILE_NOT_FOUND",
    "file:///app/src/renderer/recovery/renderer-crashed.html",
    true
  );
  webContents.emit("render-process-gone", {}, { reason: "launch-failed" });
  await Promise.resolve();

  assert.equal(fallbackCalls, 1);
  assert.ok(logs.some((entry) => /recovery page load failed/.test(entry[1])));
  assert.ok(logs.some((entry) => /recovery page renderer failed/.test(entry[1])));
});

test("renderer recovery recognizes the lightweight fallback and is wired into every main window", () => {
  assert.equal(
    isRendererRecoveryUrl("file:///app/src/renderer/recovery/renderer-crashed.html?target=main"),
    true
  );
  assert.equal(isRendererRecoveryUrl("file:///app/src/renderer/index.html"), false);

  const mainSource = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const createWindowSource = mainSource.match(/function createWindow\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(createWindowSource, /installWindowRendererRecovery\(\{/);
  assert.match(createWindowSource, /renderer-crashed\.html/);
  assert.match(createWindowSource, /win\.once\("closed", \(\) => rendererRecovery\.dispose\(\)\)/);
});
