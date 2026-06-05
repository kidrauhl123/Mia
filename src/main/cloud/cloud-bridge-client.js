"use strict";

const DEFAULT_RECONNECT_DELAY_MS = 3000;

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
  WebSocketImpl,
  getSettings,
  isDaemonProcess = false,
  isDaemonEnabled,
  cloudBridgeUrl,
  cloudWebSocketProtocols,
  createActiveCodexChatAdapter,
  randomUUID,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS
}) {
  let activeSocket = null;
  let reconnectTimer = null;
  const abortControllers = new Map();
  let bridgeState = defaultBridgeState();

  function settings() {
    return typeof getSettings === "function" ? getSettings() : {};
  }

  function appendLog(line) {
    const token = String(settings().token || "");
    const clean = String(line || "").replace(token ? new RegExp(token, "g") : /$a/, "[REDACTED]");
    bridgeState.logs.push(clean);
    if (bridgeState.logs.length > 200) bridgeState.logs = bridgeState.logs.slice(-200);
  }

  function status(includeToken = false) {
    const s = settings();
    return {
      enabled: Boolean(s.enabled && s.token),
      connected: Boolean(bridgeState.connected),
      connecting: Boolean(bridgeState.connecting),
      url: s.url,
      user: s.user,
      deviceId: bridgeState.deviceId,
      lastError: bridgeState.lastError,
      logs: bridgeState.logs.slice(-80),
      ...(includeToken ? { token: s.token } : {})
    };
  }

  function shouldHostBridge() {
    return Boolean(isDaemonProcess) || !(typeof isDaemonEnabled === "function" && isDaemonEnabled());
  }

  function sendCloudBridgeRunEvent(ws, runId, kind, payload = {}) {
    if (!ws || ws.readyState !== WebSocketImpl.OPEN || !runId) return;
    ws.send(JSON.stringify({
      type: "run_event",
      runId,
      event: {
        kind: String(kind || "status"),
        ...payload
      }
    }));
  }

  async function runCloudBridgeRequest(ws, message = {}) {
    const runId = String(message.runId || randomUUID());
    const abortController = new AbortController();
    abortControllers.set(runId, abortController);
    const adapter = createActiveCodexChatAdapter();
    try {
      sendCloudBridgeRunEvent(ws, runId, "status", { text: "本机 Codex 已开始运行。" });
      const response = await adapter.sendChat({
        bot: {
          key: "mia_cloud_codex",
          name: "Codex",
          bio: "",
          engineConfig: {
            effortLevel: "medium",
            permissionMode: "default"
          }
        },
        sessionId: `cloud:${String(message.conversationId || "default")}`,
        messages: [{
          role: "user",
          content: String(message.text || ""),
          attachments: Array.isArray(message.attachments) ? message.attachments : []
        }],
        signal: abortController.signal,
        emit: (kind, payload) => sendCloudBridgeRunEvent(ws, runId, kind, payload),
        utility: false
      });
      const assistant = response.choices?.[0]?.message || {};
      const attachments = (assistant.attachments || []).map((attachment) => ({
        id: attachment.id || `att_${randomUUID()}`,
        type: attachment.type || attachment.kind || "file",
        name: attachment.name || "附件",
        mimeType: attachment.mimeType || attachment.mime || "",
        dataUrl: attachment.dataUrl || attachment.thumbnailDataUrl || "",
        url: attachment.url || ""
      })).filter((attachment) => attachment.dataUrl || attachment.url);
      return {
        text: String(assistant.content || "").trim() || (attachments.length ? "图片已生成。" : "本机 Codex 已完成。"),
        attachments
      };
    } finally {
      abortControllers.delete(runId);
    }
  }

  function handleMessage(ws, raw) {
    let message = null;
    try {
      message = JSON.parse(String(raw || ""));
    } catch {
      appendLog("Cloud bridge sent invalid JSON.");
      return;
    }
    if (message.type === "bridge_ready") {
      bridgeState.connected = true;
      bridgeState.connecting = false;
      bridgeState.deviceId = String(message.deviceId || "");
      bridgeState.lastError = "";
      appendLog("Mia Cloud Bridge connected.");
      return;
    }
    if (message.type === "cancel") {
      abortControllers.get(String(message.runId || ""))?.abort();
      return;
    }
    if (message.type !== "run") return;
    const runId = String(message.runId || "");
    runCloudBridgeRequest(ws, message)
      .then((result) => {
        if (ws.readyState === WebSocketImpl.OPEN) ws.send(JSON.stringify({ type: "run_result", runId, ok: true, ...result }));
      })
      .catch((error) => {
        if (ws.readyState === WebSocketImpl.OPEN) {
          ws.send(JSON.stringify({ type: "run_result", runId, ok: false, error: String(error?.message || error) }));
        }
        appendLog(`Cloud run failed: ${error?.message || error}`);
      });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const s = settings();
    if (!s.enabled || !s.token) return;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      start();
    }, reconnectDelayMs);
  }

  function stop() {
    if (reconnectTimer) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }
    const ws = activeSocket;
    activeSocket = null;
    if (ws && (ws.readyState === WebSocketImpl.OPEN || ws.readyState === WebSocketImpl.CONNECTING)) {
      ws.close(1000, "cloud disabled");
    }
    bridgeState = {
      ...bridgeState,
      connecting: false,
      connected: false,
      deviceId: ""
    };
    return status(false);
  }

  function start() {
    if (!shouldHostBridge()) return status(false);
    const s = settings();
    if (!s.enabled || !s.token) return status(false);
    if (activeSocket && [WebSocketImpl.CONNECTING, WebSocketImpl.OPEN].includes(activeSocket.readyState)) {
      return status(false);
    }
    bridgeState.connecting = true;
    bridgeState.connected = false;
    bridgeState.lastError = "";
    const ws = new WebSocketImpl(cloudBridgeUrl(s), cloudWebSocketProtocols(s));
    activeSocket = ws;
    ws.on("open", () => {
      appendLog(`Connecting to Mia Cloud: ${s.url}`);
    });
    ws.on("message", (raw) => handleMessage(ws, raw));
    ws.on("error", (error) => {
      bridgeState.lastError = String(error?.message || error);
      appendLog(`Cloud bridge socket error: ${bridgeState.lastError}`);
    });
    ws.on("close", () => {
      if (activeSocket !== ws) return;
      activeSocket = null;
      bridgeState.connected = false;
      bridgeState.connecting = false;
      bridgeState.deviceId = "";
      appendLog("Mia Cloud Bridge disconnected.");
      scheduleReconnect();
    });
    return status(false);
  }

  return {
    appendLog,
    handleMessage,
    start,
    status,
    stop
  };
}

module.exports = {
  createCloudBridgeClient
};
