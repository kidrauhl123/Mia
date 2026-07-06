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
    const child = spawnProcess("open", [url], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      try { child.unref?.(); } catch { /* ignore */ }
      resolve(true);
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
