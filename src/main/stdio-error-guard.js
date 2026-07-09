"use strict";

const GUARD_KEY = Symbol.for("mia.main.stdioErrorGuardInstalled");
const BROKEN_STDIO_CODES = new Set(["EIO", "EPIPE", "EBADF"]);

function isBrokenStdioError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  if (BROKEN_STDIO_CODES.has(code)) return true;
  const message = String(error?.message || error || "");
  return /\b(write\s+)?(EIO|EPIPE|EBADF)\b/i.test(message);
}

function installStreamErrorGuard(stream, rethrow) {
  if (!stream || typeof stream.on !== "function") return;
  stream.on("error", (error) => {
    if (isBrokenStdioError(error)) return;
    rethrow(error);
  });
}

function wrapConsoleMethod(consoleObject, method, rethrow) {
  const original = consoleObject?.[method];
  if (typeof original !== "function") return;
  consoleObject[method] = (...args) => {
    try {
      return original.apply(consoleObject, args);
    } catch (error) {
      if (isBrokenStdioError(error)) return undefined;
      rethrow(error);
      return undefined;
    }
  };
}

function defaultRethrow(error) {
  process.nextTick(() => {
    throw error;
  });
}

function installMainProcessStdioErrorGuard(options = {}) {
  const processObject = options.processObject || process;
  const consoleObject = options.consoleObject || console;
  const rethrow = typeof options.rethrow === "function" ? options.rethrow : defaultRethrow;

  if (processObject[GUARD_KEY]) return { installed: false };
  Object.defineProperty(processObject, GUARD_KEY, {
    value: true,
    configurable: false,
    enumerable: false
  });

  installStreamErrorGuard(processObject.stdout, rethrow);
  installStreamErrorGuard(processObject.stderr, rethrow);
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    wrapConsoleMethod(consoleObject, method, rethrow);
  }

  return { installed: true };
}

module.exports = {
  installMainProcessStdioErrorGuard,
  isBrokenStdioError
};
