"use strict";

function normalizeBrowserUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input || "").trim());
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  return parsed.href;
}

function spawnMacOpen(spawnProcess, url) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess("open", [url], { stdio: "ignore" });
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    child.once("error", (error) => settle(reject, error));
    child.once("close", (code, signal) => {
      if (code === 0) settle(resolve, true);
      else settle(reject, new Error(`macOS open exited with code ${code ?? "null"} signal ${signal ?? "null"}`));
    });
  });
}

function createExternalUrlOpener({
  shellOpenExternal,
  spawnProcess,
  platform = process.platform
}) {
  return async function openExternalUrl(input) {
    const url = normalizeBrowserUrl(input);
    if (!url) return false;
    if (platform === "darwin" && typeof spawnProcess === "function") {
      try {
        await spawnMacOpen(spawnProcess, url);
        return true;
      } catch {
        // Fall back to Electron shell below.
      }
    }
    await shellOpenExternal(url);
    return true;
  };
}

module.exports = {
  createExternalUrlOpener,
  normalizeBrowserUrl
};
