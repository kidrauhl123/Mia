"use strict";

const WECHAT_RELAY_SHUTDOWN_PATH = "/api/im-channels/wechat-clawbot/shutdown";

function createWechatRelayShutdown({
  ping,
  fetchImpl = fetch,
  timeoutSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  appendLog = () => {},
  probeTimeoutMs = 600,
  requestTimeoutMs = 3_000
} = {}) {
  async function prepareForCoreStop({ settings, runtimeHome } = {}) {
    let observed;
    try {
      observed = await ping(settings, probeTimeoutMs, { expectedRuntimeHome: runtimeHome });
    } catch {
      return { attempted: false };
    }
    const baseUrl = String(observed?.baseUrl || "").replace(/\/+$/, "");
    if (!observed?.ok || !baseUrl) return { attempted: false };
    try {
      const response = await fetchImpl(`${baseUrl}${WECHAT_RELAY_SHUTDOWN_PATH}`, {
        method: "POST",
        headers: { accept: "application/json" },
        signal: timeoutSignal(requestTimeoutMs)
      });
      if (!response?.ok) appendLog(`WeChat relay graceful stop returned HTTP ${Number(response?.status) || 0}.`);
      return { attempted: true, ok: Boolean(response?.ok) };
    } catch {
      appendLog("WeChat relay graceful stop did not complete before Core exit.");
      return { attempted: true, ok: false };
    }
  }

  return { prepareForCoreStop };
}

module.exports = { WECHAT_RELAY_SHUTDOWN_PATH, createWechatRelayShutdown };
