"use strict";

const DEFAULT_RECONNECT_DELAY_MS = 2500;

function defaultRelayState() {
  return {
    enabled: false,
    connected: false,
    connecting: false,
    url: "",
    deviceId: "",
    mobilePeers: 0,
    lastError: "",
    logs: []
  };
}

function replaceLiteral(value, needle, replacement) {
  const text = String(value || "");
  const find = String(needle || "");
  if (!find) return text;
  return text.split(find).join(replacement);
}

function relayHttpOrigin(wsUrl) {
  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function relayPairingLink(settings = {}, mobileAssetVersion = "") {
  const origin = relayHttpOrigin(settings.url);
  if (!origin) return "";
  const params = new URLSearchParams({
    mode: "relay",
    device: settings.deviceId,
    relay: settings.url,
    v: mobileAssetVersion
  });
  return `${origin}/mobile/?${params.toString()}#secret=${encodeURIComponent(settings.secret)}`;
}

function createRelayClient({
  WebSocketImpl,
  getSettings,
  mobileAssetVersion,
  daemonToken,
  initializeRuntime,
  hostname,
  randomUUID,
  remoteRouter,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS
}) {
  let activeSocket = null;
  let reconnectTimer = null;
  let relayState = defaultRelayState();

  function settings() {
    return typeof getSettings === "function" ? getSettings() : {};
  }

  function appendLog(line) {
    const current = settings();
    const clean = replaceLiteral(
      replaceLiteral(line, current.secret, "[REDACTED]"),
      typeof daemonToken === "function" ? daemonToken() : "",
      "[REDACTED]"
    );
    relayState.logs.push(clean);
    if (relayState.logs.length > 200) relayState.logs = relayState.logs.slice(-200);
  }

  function recordError(error, label = "Relay error") {
    relayState.lastError = String(error?.message || error || "Relay error.");
    appendLog(`${label}: ${relayState.lastError}`);
  }

  function status(includeSecret = false) {
    const current = settings();
    return {
      enabled: current.enabled,
      connected: Boolean(relayState.connected),
      connecting: Boolean(relayState.connecting),
      url: current.url,
      deviceId: current.deviceId,
      mobilePeers: relayState.mobilePeers || 0,
      pairingLink: relayPairingLink(current, mobileAssetVersion),
      lastError: relayState.lastError,
      logs: relayState.logs.slice(-80),
      ...(includeSecret ? { secret: current.secret } : {})
    };
  }

  function send(payload) {
    if (!activeSocket || activeSocket.readyState !== WebSocketImpl.OPEN) return false;
    activeSocket.send(JSON.stringify(payload));
    return true;
  }

  function rpcResult(clientId, id, ok, payload) {
    send({
      type: "rpc_result",
      clientId,
      id,
      ok,
      ...(ok ? { data: payload } : { error: String(payload?.message || payload || "Request failed.") })
    });
  }

  function rpcStream(clientId, id, event, data) {
    send({
      type: "rpc_stream",
      clientId,
      id,
      event,
      data
    });
  }

  async function handleRpc(message = {}) {
    const id = String(message.id || randomUUID());
    const clientId = String(message.clientId || "");
    const method = String(message.method || "GET").toUpperCase();
    const requestPath = String(message.path || "/");
    const body = message.body && typeof message.body === "object" ? message.body : {};
    try {
      const result = await remoteRouter.route({
        method,
        path: requestPath,
        body,
        emitStream: (event, data) => rpcStream(clientId, id, event, data),
        isStreamDestroyed: () => !activeSocket || activeSocket.readyState !== WebSocketImpl.OPEN
      });
      if (result.handled) rpcResult(clientId, id, true, result.data);
      else rpcResult(clientId, id, false, "Not found.");
    } catch (error) {
      if (method === "POST" && requestPath === "/api/chat/stream") {
        rpcStream(clientId, id, "error", { error: String(error?.message || error) });
      }
      rpcResult(clientId, id, false, error);
    }
  }

  function handleMessage(raw) {
    let message = null;
    try {
      message = JSON.parse(String(raw || ""));
    } catch {
      appendLog("Relay sent invalid JSON.");
      return;
    }
    if (message.type === "ready") {
      relayState.connected = true;
      relayState.connecting = false;
      relayState.mobilePeers = Number(message.device?.mobilePeers || 0);
      relayState.lastError = "";
      appendLog("Relay connected.");
      return;
    }
    if (message.type === "peer_count") {
      relayState.mobilePeers = Number(message.count || 0);
      return;
    }
    if (message.type === "rpc") {
      handleRpc(message).catch((error) => {
        rpcResult(message.clientId, message.id, false, error);
      });
      return;
    }
    if (message.type === "error") {
      relayState.lastError = String(message.error || "Relay error.");
      appendLog(`Relay error: ${relayState.lastError}`);
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const current = settings();
    if (!current.enabled) return;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      start().catch((error) => {
        relayState.lastError = String(error?.message || error);
        appendLog(`Relay reconnect failed: ${relayState.lastError}`);
        scheduleReconnect();
      });
    }, reconnectDelayMs);
  }

  function stop() {
    if (reconnectTimer) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }
    const ws = activeSocket;
    activeSocket = null;
    if (ws && ws.readyState === WebSocketImpl.OPEN) ws.close(1000, "remote disabled");
    relayState = {
      ...relayState,
      enabled: settings().enabled,
      connected: false,
      connecting: false,
      mobilePeers: 0
    };
    return status(true);
  }

  async function start() {
    initializeRuntime();
    const current = settings();
    relayState = {
      ...relayState,
      enabled: current.enabled,
      url: current.url,
      deviceId: current.deviceId
    };
    if (!current.enabled) return status(true);
    if (activeSocket && [WebSocketImpl.CONNECTING, WebSocketImpl.OPEN].includes(activeSocket.readyState)) return status(true);
    if (reconnectTimer) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }
    relayState.connecting = true;
    relayState.connected = false;
    relayState.lastError = "";
    const ws = new WebSocketImpl(current.url);
    activeSocket = ws;
    ws.on("open", () => {
      relayState.connecting = false;
      send({
        type: "hello",
        role: "desktop",
        deviceId: current.deviceId,
        secret: current.secret,
        name: hostname() || "Aimashi Desktop"
      });
    });
    ws.on("message", (raw) => {
      if (activeSocket === ws) handleMessage(raw);
    });
    ws.on("error", (error) => {
      relayState.lastError = String(error?.message || error);
      appendLog(`Relay socket error: ${relayState.lastError}`);
    });
    ws.on("close", () => {
      if (activeSocket !== ws) return;
      activeSocket = null;
      relayState.connected = false;
      relayState.connecting = false;
      relayState.mobilePeers = 0;
      appendLog("Relay disconnected.");
      scheduleReconnect();
    });
    return status(true);
  }

  return {
    appendLog,
    handleMessage,
    recordError,
    send,
    start,
    status,
    stop
  };
}

module.exports = {
  createRelayClient,
  relayHttpOrigin,
  relayPairingLink
};
