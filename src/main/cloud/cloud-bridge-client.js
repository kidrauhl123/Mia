"use strict";

function defaultBridgeState() {
  return {
    connecting: false,
    connected: false,
    deviceId: "",
    lastError: "",
    logs: []
  };
}

function createCloudBridgeClient({
  getSettings,
  startCloudBridgeRequest,
  stopCloudBridgeRequest,
  cloudBridgeStartPayload = () => ({}),
  isDaemonProcess = false,
  isDaemonEnabled,
  now = () => Date.now()
}) {
  let bridgeState = defaultBridgeState();
  let pendingStart = null;

  function settings() {
    return typeof getSettings === "function" ? getSettings() : {};
  }

  function appendLog(line) {
    const token = String(settings().token || "");
    const clean = String(line || "").replace(token ? new RegExp(token, "g") : /$a/, "[REDACTED]");
    bridgeState.logs.push(clean);
    if (bridgeState.logs.length > 200) bridgeState.logs = bridgeState.logs.slice(-200);
  }

  function applyCoreStatus(response) {
    const next = response?.status && typeof response.status === "object" ? response.status : response;
    if (!next || typeof next !== "object") return;
    bridgeState = {
      connecting: Boolean(next.connecting),
      connected: Boolean(next.connected),
      deviceId: String(next.deviceId || ""),
      lastError: String(next.lastError || ""),
      logs: Array.isArray(next.logs) ? next.logs.map((line) => String(line || "")).slice(-200) : bridgeState.logs
    };
  }

  function status(includeToken = false) {
    const s = settings();
    return {
      enabled: Boolean(s.enabled && s.token),
      connected: Boolean(bridgeState.connected),
      connecting: Boolean(bridgeState.connecting),
      url: s.url,
      user: s.user,
      agentRuntime: s.agentRuntime || null,
      deviceId: bridgeState.deviceId,
      lastError: bridgeState.lastError,
      logs: bridgeState.logs.slice(-80),
      ...(includeToken ? { token: s.token } : {})
    };
  }

  function shouldHostBridge() {
    if (!isDaemonProcess) return false;
    return typeof isDaemonEnabled === "function" ? Boolean(isDaemonEnabled()) : true;
  }

  function start() {
    if (!shouldHostBridge()) return status(false);
    const s = settings();
    if (!s.enabled || !s.token) return status(false);
    if (pendingStart) return status(false);
    bridgeState = {
      ...bridgeState,
      connecting: true,
      connected: false,
      lastError: ""
    };
    let payload = {};
    try {
      payload = typeof cloudBridgeStartPayload === "function" ? cloudBridgeStartPayload() : {};
    } catch (error) {
      bridgeState.connecting = false;
      bridgeState.lastError = String(error?.message || error);
      appendLog(`Cloud bridge start payload failed: ${bridgeState.lastError}`);
      return status(false);
    }
    pendingStart = Promise.resolve()
      .then(() => startCloudBridgeRequest(payload || {}))
      .then((response) => {
        applyCoreStatus(response);
        return response;
      })
      .catch((error) => {
        bridgeState.connecting = false;
        bridgeState.connected = false;
        bridgeState.lastError = String(error?.message || error);
        appendLog(`Cloud bridge Core start failed: ${bridgeState.lastError}`);
      })
      .finally(() => {
        pendingStart = null;
      });
    if (pendingStart && typeof pendingStart.catch === "function") {
      pendingStart.catch(() => {});
    }
    return status(false);
  }

  function stop() {
    bridgeState = {
      ...bridgeState,
      connecting: false,
      connected: false,
      deviceId: ""
    };
    Promise.resolve()
      .then(() => (typeof stopCloudBridgeRequest === "function" ? stopCloudBridgeRequest() : null))
      .then((response) => applyCoreStatus(response))
      .catch((error) => {
        bridgeState.lastError = String(error?.message || error);
        appendLog(`Cloud bridge Core stop failed: ${bridgeState.lastError}`);
      });
    return status(false);
  }

  return {
    appendLog,
    start,
    status,
    stop,
    _lastUpdatedAt: () => now()
  };
}

module.exports = {
  createCloudBridgeClient
};
