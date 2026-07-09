"use strict";

// Migration branch: Rust Core owns cloud session state. Electron main keeps a
// local UI mirror only so existing renderer reads can stay stable while cloud
// ownership moves out of Node.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function syncSignature(settings = {}) {
  const token = String(settings.token || "");
  return stableJson({
    enabled: Boolean(settings.enabled && token),
    url: String(settings.url || ""),
    token,
    user: objectOrNull(settings.user),
    agentRuntime: objectOrNull(settings.agentRuntime),
    lastEventSeq: Number.isFinite(Number(settings.lastEventSeq)) ? Number(settings.lastEventSeq) : 0,
    lastMemorySyncAt: String(settings.lastMemorySyncAt || "")
  });
}

function createCloudSettingsWriter({
  writeLocal,
  syncCore,
  log = () => {}
}) {
  if (typeof writeLocal !== "function") throw new Error("writeLocal dependency is required.");
  if (typeof syncCore !== "function") throw new Error("syncCore dependency is required.");

  let lastSyncedSignature = "";
  const inFlightSyncs = new Map();

  async function syncCoreOnce(settings) {
    const signature = syncSignature(settings);
    if (signature === lastSyncedSignature) return null;
    const existing = inFlightSyncs.get(signature);
    if (existing) return existing;
    const pending = Promise.resolve()
      .then(() => syncCore(settings))
      .then((result) => {
        lastSyncedSignature = signature;
        return result;
      })
      .catch((error) => {
        log(`[cloud-settings] Rust Core sync failed: ${error?.message || error}`);
        throw new Error(`Mia Rust Core unavailable for cloud settings sync: ${error?.message || error}`);
      })
      .finally(() => {
        if (inFlightSyncs.get(signature) === pending) inFlightSyncs.delete(signature);
      });
    inFlightSyncs.set(signature, pending);
    return pending;
  }

  async function write(patch = {}) {
    const next = await writeLocal(patch);
    await syncCoreOnce(next);
    return next;
  }

  return { write };
}

module.exports = { createCloudSettingsWriter, syncSignature };
