"use strict";

// ADR 2026-06-12 P3: mia-cloud.json has a single writer. The daemon owns the
// file while it is enabled; the window must hand its credential writes (login,
// logout, profile refresh) to the daemon over the control API instead of
// touching the file itself. There is no foreground fallback: if the daemon is
// unavailable, runtime state is unavailable too.
function createCloudSettingsWriter({
  isDaemonProcess = false,
  isDaemonEnabled = () => false,
  writeLocal,
  daemonBaseUrl,
  daemonToken,
  fetchImpl = fetch,
  timeoutMs = 1500,
  log = () => {}
}) {
  if (typeof writeLocal !== "function") throw new Error("writeLocal dependency is required.");

  async function write(patch = {}) {
    if (isDaemonProcess) return writeLocal(patch);
    if (!isDaemonEnabled()) throw new Error("Mia daemon is required for cloud settings writes.");
    let response;
    try {
      response = await fetchImpl(`${daemonBaseUrl()}/api/cloud-settings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${daemonToken()}`
        },
        body: JSON.stringify({ patch }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      log(`[cloud-settings] daemon unavailable: ${error?.message || error}`);
      throw new Error(`Mia daemon unavailable for cloud settings writes: ${error?.message || error}`);
    }
    if (response.status === 404 || response.status === 501) {
      throw new Error(`daemon cloud-settings write route unavailable: HTTP ${response.status}`);
    }
    if (!response.ok) throw new Error(`daemon cloud-settings write failed: HTTP ${response.status}`);
    const data = await response.json();
    return data?.settings ?? data;
  }

  return { write };
}

module.exports = { createCloudSettingsWriter };
