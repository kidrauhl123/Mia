"use strict";

const { CloudEvent } = require("../../shared/cloud-events.js");

const DEFAULT_RECONNECT_DELAY_MS = 3000;

function createCloudEventsClient({
  WebSocketImpl,
  getSettings,
  writeCloudSettings,
  cloudStatus,
  cloudEventsUrl,
  cloudWebSocketProtocols,
  broadcastRendererEvent,
  cloudEventChannel,
  appendCloudLog,
  botRuntimeDispatcher,
  messageCache = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  nowFn = () => Date.now(),
  readyTimeoutMs = 15000
}) {
  let activeSocket = null;
  let reconnectTimer = null;
  let eventState = {
    connecting: false,
    connected: false,
    lastError: "",
    openedAt: 0,
    readyAt: 0
  };

  function cloudUiStatus() {
    return typeof cloudStatus === "function" ? cloudStatus() : {};
  }

  function status() {
    const s = settings();
    return {
      enabled: Boolean(s.enabled && s.token),
      connecting: Boolean(eventState.connecting),
      connected: Boolean(eventState.connected),
      lastError: eventState.lastError,
      lastEventSeq: Number(s.lastEventSeq) || 0
    };
  }

  function log(line) {
    if (typeof appendCloudLog === "function") appendCloudLog(line);
  }

  function emitToRenderer(envelope) {
    broadcastRendererEvent(cloudEventChannel, envelope);
  }

  function writeMessageToCache(conversationId, message) {
    if (!messageCache || !conversationId || !message?.id) return;
    try {
      messageCache.upsertMessages(conversationId, [message]);
    } catch (error) {
      log(`[cloud-events] message cache upsert failed: ${error?.message || error}`);
    }
  }

  function settings() {
    return typeof getSettings === "function" ? getSettings() : {};
  }

  function saveLastEventSeq(nextSeq) {
    const n = Number(nextSeq);
    if (!Number.isFinite(n)) return;
    const current = Number(settings().lastEventSeq) || 0;
    if (n > current) writeCloudSettings({ lastEventSeq: n });
  }

  function applyResumeCursor(message) {
    if (Number.isFinite(Number(message.seq))) {
      saveLastEventSeq(message.seq);
      return;
    }
    if (message.type !== CloudEvent.EventsReady) return;
    if (message.resetTo != null && Number.isFinite(Number(message.resetTo))) {
      writeCloudSettings({ lastEventSeq: Number(message.resetTo) });
    }
  }

  function shouldReplaceStaleSocket(ws) {
    if (!ws) return false;
    if (eventState.connected) return false;
    if (![WebSocketImpl.CONNECTING, WebSocketImpl.OPEN].includes(ws.readyState)) return false;
    const openedAt = Number(eventState.openedAt) || 0;
    return openedAt > 0 && nowFn() - openedAt > readyTimeoutMs;
  }

  function handleMessage(raw) {
    let message = null;
    try {
      message = JSON.parse(String(raw || ""));
    } catch {
      log("Cloud events sent invalid JSON.");
      return;
    }

    applyResumeCursor(message);

    if (message.type === CloudEvent.EventsReady) {
      eventState.connected = true;
      eventState.connecting = false;
      eventState.readyAt = nowFn();
      eventState.lastError = "";
      log(`Mia Cloud events connected (since_seq=${message.sinceSeq || 0}, serverSeq=${message.serverSeq || 0}).`);
      emitToRenderer({ type: CloudEvent.EventsReady, cloud: cloudUiStatus() });
      return;
    }
    if (message.type && message.type.startsWith("social.")) {
      emitToRenderer({ type: message.type, payload: message });
      return;
    }
    if (message.type === "user_settings.updated") {
      emitToRenderer({ type: message.type, payload: message });
      return;
    }
    if (message.type === CloudEvent.BotUpserted || message.type === CloudEvent.BotDeleted || message.type === "bot.runtime_updated") {
      emitToRenderer({ type: message.type, payload: message });
      return;
    }
    if (message.type === CloudEvent.ConversationBotInvocationRequested) {
      botRuntimeDispatcher?.handleCloudEvent?.(message)
        ?.catch((error) => log(`Cloud bot invocation failed: ${error?.message || error}`));
      emitToRenderer({ type: message.type, payload: message });
      return;
    }
    if (message.type === CloudEvent.ConversationMessageAppended) {
      writeMessageToCache(message.conversationId, message.message);
      emitToRenderer({ type: message.type, payload: message });
      return;
    }
    if (message.type && message.type.startsWith("conversation.")) {
      emitToRenderer({ type: message.type, payload: message });
      return;
    }
    if (message.type === CloudEvent.CloudAgentRunStarted || message.type === CloudEvent.CloudAgentRunEvent) {
      emitToRenderer({ type: message.type, payload: message });
      return;
    }
    if (message.type === CloudEvent.BridgeRunUpdated || message.type === CloudEvent.DeviceUpdated) {
      emitToRenderer({
        type: String(message.type || "cloud_event"),
        cloud: cloudUiStatus()
      });
    }
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
    eventState = {
      ...eventState,
      connecting: false,
      connected: false,
      openedAt: 0,
      readyAt: 0
    };
    return status();
  }

  function start() {
    const s = settings();
    if (!s.enabled || !s.token) return status();
    if (activeSocket && [WebSocketImpl.CONNECTING, WebSocketImpl.OPEN].includes(activeSocket.readyState)) {
      if (!shouldReplaceStaleSocket(activeSocket)) return status();
      const stale = activeSocket;
      activeSocket = null;
      eventState.connecting = false;
      eventState.connected = false;
      try { stale.close(1000, "cloud events ready timeout"); } catch { /* ignore close failures */ }
    }
    eventState.connecting = true;
    eventState.connected = false;
    eventState.lastError = "";
    eventState.openedAt = nowFn();
    eventState.readyAt = 0;
    const ws = new WebSocketImpl(cloudEventsUrl(s), cloudWebSocketProtocols(s));
    activeSocket = ws;
    ws.on("open", () => {
      log(`Listening to Mia Cloud events: ${s.url}`);
    });
    ws.on("message", (raw) => handleMessage(raw));
    ws.on("error", (error) => {
      eventState.lastError = String(error?.message || error);
      log(`Cloud events socket error: ${eventState.lastError}`);
    });
    ws.on("close", () => {
      if (activeSocket !== ws) return;
      activeSocket = null;
      eventState.connecting = false;
      eventState.connected = false;
      eventState.openedAt = 0;
      eventState.readyAt = 0;
      log("Mia Cloud events disconnected.");
      scheduleReconnect();
    });
    return status();
  }

  return {
    handleMessage,
    scheduleReconnect,
    start,
    status,
    stop
  };
}

module.exports = {
  createCloudEventsClient
};
