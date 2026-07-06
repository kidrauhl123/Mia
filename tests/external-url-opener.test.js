const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const { createExternalUrlOpener } = require("../src/main/external-url-opener.js");

function spawnedChild({ error = null, exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.unref = () => {};
  queueMicrotask(() => {
    if (error) {
      child.emit("error", error);
      return;
    }
    child.emit("spawn");
    queueMicrotask(() => child.emit("close", exitCode, null));
  });
  return child;
}

test("openExternalUrl rejects non-http urls without side effects", async () => {
  const calls = [];
  const openExternalUrl = createExternalUrlOpener({
    platform: "darwin",
    spawnProcess: (...args) => {
      calls.push(["spawn", ...args]);
      return spawnedChild();
    },
    shellOpenExternal: async (url) => {
      calls.push(["shell", url]);
    }
  });

  assert.equal(await openExternalUrl("file:///tmp/nope"), false);
  assert.deepEqual(calls, []);
});

test("openExternalUrl uses macOS open command for browser urls", async () => {
  const calls = [];
  const openExternalUrl = createExternalUrlOpener({
    platform: "darwin",
    spawnProcess: (...args) => {
      calls.push(["spawn", ...args]);
      return spawnedChild();
    },
    shellOpenExternal: async (url) => {
      calls.push(["shell", url]);
    }
  });

  assert.equal(await openExternalUrl("https://auth.openai.com/codex/device"), true);
  assert.deepEqual(calls, [[
    "spawn",
    "open",
    ["https://auth.openai.com/codex/device"],
    { stdio: "ignore" }
  ]]);
});

test("openExternalUrl falls back to Electron shell when macOS open fails", async () => {
  const calls = [];
  const openExternalUrl = createExternalUrlOpener({
    platform: "darwin",
    spawnProcess: (...args) => {
      calls.push(["spawn", ...args]);
      return spawnedChild({ error: new Error("open unavailable") });
    },
    shellOpenExternal: async (url) => {
      calls.push(["shell", url]);
    }
  });

  assert.equal(await openExternalUrl("https://auth.openai.com/codex/device"), true);
  assert.equal(calls.at(-1)[0], "shell");
  assert.equal(calls.at(-1)[1], "https://auth.openai.com/codex/device");
});

test("openExternalUrl falls back to Electron shell when macOS open exits unsuccessfully", async () => {
  const calls = [];
  const openExternalUrl = createExternalUrlOpener({
    platform: "darwin",
    spawnProcess: (...args) => {
      calls.push(["spawn", ...args]);
      return spawnedChild({ exitCode: 1 });
    },
    shellOpenExternal: async (url) => {
      calls.push(["shell", url]);
    }
  });

  assert.equal(await openExternalUrl("https://auth.x.ai/oauth2/authorize?state=abc"), true);
  assert.equal(calls.at(-1)[0], "shell");
  assert.equal(calls.at(-1)[1], "https://auth.x.ai/oauth2/authorize?state=abc");
});

test("openExternalUrl uses Electron shell outside macOS", async () => {
  const calls = [];
  const openExternalUrl = createExternalUrlOpener({
    platform: "linux",
    spawnProcess: (...args) => {
      calls.push(["spawn", ...args]);
      return spawnedChild();
    },
    shellOpenExternal: async (url) => {
      calls.push(["shell", url]);
    }
  });

  assert.equal(await openExternalUrl("https://auth.openai.com/codex/device"), true);
  assert.deepEqual(calls, [["shell", "https://auth.openai.com/codex/device"]]);
});
