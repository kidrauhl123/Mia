"use strict";

// Migration branch: Rust Core owns cloud session state. Electron main keeps a
// local UI mirror only so existing renderer reads can stay stable while cloud
// ownership moves out of Node.
function createCloudSettingsWriter({
  writeLocal,
  syncCore,
  log = () => {}
}) {
  if (typeof writeLocal !== "function") throw new Error("writeLocal dependency is required.");
  if (typeof syncCore !== "function") throw new Error("syncCore dependency is required.");

  async function write(patch = {}) {
    const next = await writeLocal(patch);
    try {
      await syncCore(next);
    } catch (error) {
      log(`[cloud-settings] Rust Core sync failed: ${error?.message || error}`);
      throw new Error(`Mia Rust Core unavailable for cloud settings sync: ${error?.message || error}`);
    }
    return next;
  }

  return { write };
}

module.exports = { createCloudSettingsWriter };
