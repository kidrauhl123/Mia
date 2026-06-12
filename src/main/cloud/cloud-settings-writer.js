"use strict";

// ADR 2026-06-12 P3: mia-cloud.json has a single writer. The daemon owns the
// file while it is enabled; the window must hand its credential writes (login,
// logout, profile refresh) to the daemon over the control API instead of
// touching the file itself. With the daemon disabled — or dead, after a probe
// failure — the window is the legitimate owner and writes locally.
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
    if (isDaemonProcess || !isDaemonEnabled()) return writeLocal(patch);
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
      // Unreachable daemon (refused / timed out): the window falls back to
      // owning the write, same rule as the execution fallback in P1.
      log(`[cloud-settings] daemon unreachable, writing locally: ${error?.message || error}`);
      return writeLocal(patch);
    }
    // Version skew: a daemon predating this route answers 404 (or 501 when the
    // dep isn't wired). The capability simply doesn't exist there — the window
    // must keep owning the write or login would brick until the daemon updates.
    if (response.status === 404 || response.status === 501) {
      log(`[cloud-settings] daemon lacks the write route (HTTP ${response.status}), writing locally`);
      return writeLocal(patch);
    }
    // A live daemon that errors (401/5xx) must NOT be papered over with a
    // local write — that would split the single writer and mask the failure.
    if (!response.ok) throw new Error(`daemon cloud-settings write failed: HTTP ${response.status}`);
    const data = await response.json();
    return data?.settings ?? data;
  }

  return { write };
}

module.exports = { createCloudSettingsWriter };
