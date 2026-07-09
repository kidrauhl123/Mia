const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const {
  installMainProcessStdioErrorGuard,
  isBrokenStdioError
} = require("../src/main/stdio-error-guard.js");

function fakeProcess() {
  return {
    stdout: new EventEmitter(),
    stderr: new EventEmitter()
  };
}

test("broken stdio errors are identified by code and message", () => {
  assert.equal(isBrokenStdioError(Object.assign(new Error("write EIO"), { code: "EIO" })), true);
  assert.equal(isBrokenStdioError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })), true);
  assert.equal(isBrokenStdioError(new Error("write EBADF")), true);
  assert.equal(isBrokenStdioError(Object.assign(new Error("boom"), { code: "ECONNRESET" })), false);
});

test("main process stdio guard swallows broken stream errors", () => {
  const processObject = fakeProcess();
  const rethrown = [];

  installMainProcessStdioErrorGuard({
    processObject,
    consoleObject: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    rethrow: (error) => rethrown.push(error)
  });

  processObject.stdout.emit("error", Object.assign(new Error("write EIO"), { code: "EIO" }));
  processObject.stderr.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

  assert.deepEqual(rethrown, []);
});

test("main process stdio guard rethrows non-stdio stream errors", () => {
  const processObject = fakeProcess();
  const rethrown = [];
  const error = Object.assign(new Error("network reset"), { code: "ECONNRESET" });

  installMainProcessStdioErrorGuard({
    processObject,
    consoleObject: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    rethrow: (value) => rethrown.push(value)
  });
  processObject.stdout.emit("error", error);

  assert.deepEqual(rethrown, [error]);
});

test("main process stdio guard wraps console write failures", () => {
  const processObject = fakeProcess();
  const consoleObject = {
    log() {
      throw Object.assign(new Error("write EIO"), { code: "EIO" });
    },
    info() {},
    warn() {},
    error() {},
    debug() {}
  };
  const rethrown = [];

  installMainProcessStdioErrorGuard({ processObject, consoleObject, rethrow: (error) => rethrown.push(error) });

  assert.doesNotThrow(() => consoleObject.log("hello"));
  assert.deepEqual(rethrown, []);
});
