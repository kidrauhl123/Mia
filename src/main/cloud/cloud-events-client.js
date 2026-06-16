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
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  nowFn = () => Date.now(),
  readyTimeoutMs = 15000,
  heartbeatIntervalMs = 20000,
  // The lastEventSeq cursor has a single writer (ADR 2026-06-12): the daemon
  // while it is enabled, the window otherwise. A non-owner persisting the
  // cursor would mark events as consumed that the owner never processed.
  persistCursor = true,
  // P2: the /api/events socket itself has a single host, mirroring the bridge.
  // While the daemon is enabled the window defers entirely — it receives the
  // forwarded feed over the daemon's local channel instead. A lingering daemon
  // whose toggle is off must release the socket too (codex review).
  isDaemonProcess = false,
  isDaemonEnabled = null
}) {
  let activeSocket = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  // Liveness flag for the active socket: set true on every inbound frame (events
  // or a pong), flipped false right after we send a ping. If it's still false at
  // the next heartbeat tick, the socket went silent (half-open) and we recycle it.
  let isAlive = true;
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

  function deleteMessageFromCache(conversationId, messageId) {
    if (!messageCache || !conversationId || !messageId || typeof messageCache.deleteMessage !== "function") return;
    try {
      messageCache.deleteMessage(conversationId, messageId);
    } catch (error) {
      log(`Mia Cloud message cache delete failed: ${error?.message || error}`);
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

  function ownsCursor() {
    return typeof persistCursor === "function" ? Boolean(persistCursor()) : Boolean(persistCursor);
  }

  function applyResumeCursor(message) {
    if (!ownsCursor()) return;
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
    // Any inbound frame proves the socket is still live this heartbeat window.
    isAlive = true;
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
    if (message.type === CloudEvent.UserProfileUpdated) {
      if (message.user && typeof message.user === "object") {
        writeCloudSettings({ user: message.user });
      }
      emitToRenderer({ type: message.type, payload: message, cloud: cloudUiStatus() });
      return;
    }
    if (message.type && message.type.startsWith("task.")) {
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
    if (message.type === "conversation.message_deleted") {
      deleteMessageFromCache(message.conversationId, message.messageId);
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
        cloud: cloudUiStatus(),
        payload: message
      });
    }
  }

  // Force-recycle the active socket and reconnect. Used by the heartbeat when a
  // socket goes silent (TCP half-open) or never finishes the handshake — cases
  // where "close" never fires on its own, so the renderer would otherwise stop
  // receiving events (no replies, no typing) until a full app restart.
  function recycleSocket(ws, reason) {
    if (!ws) return;
    eventState.lastError = reason;
    log(`Mia Cloud events ${reason}; reconnecting.`);
    try {
      if (typeof ws.terminate === "function") ws.terminate();
      else ws.close(4000, reason);
    } catch { /* ignore terminate failures */ }
    // terminate()/close() may fire "close" async (or not at all for a half-open
    // socket); drive the disconnect path here if this is still the active socket.
    if (activeSocket === ws) {
      activeSocket = null;
      eventState.connecting = false;
      eventState.connected = false;
      eventState.openedAt = 0;
      eventState.readyAt = 0;
      scheduleReconnect();
    }
  }

  function heartbeatTick() {
    const ws = activeSocket;
    if (!ws) return;
    if (!eventState.connected) {
      // Connected at TCP level but never received events_ready: stuck handshake.
      if (shouldReplaceStaleSocket(ws)) recycleSocket(ws, "handshake timeout");
      return;
    }
    if (!isAlive) {
      // Pinged last tick, got neither a pong nor any event since: socket is dead.
      recycleSocket(ws, "heartbeat timeout");
      return;
    }
    isAlive = false;
    try {
      if (typeof ws.ping === "function") ws.ping();
    } catch {
      recycleSocket(ws, "ping failed");
    }
  }

  function ensureHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setIntervalFn(heartbeatTick, heartbeatIntervalMs);
    // Don't let the heartbeat keep the process alive on its own.
    if (heartbeatTimer && typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
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
    if (heartbeatTimer) {
      clearIntervalFn(heartbeatTimer);
      heartbeatTimer = null;
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

  function shouldHostEvents() {
    const enabled = typeof isDaemonEnabled === "function" ? Boolean(isDaemonEnabled()) : null;
    if (enabled === null) return true;
    return isDaemonProcess ? enabled : !enabled;
  }

  function start() {
    if (!shouldHostEvents()) {
      // Daemon owns the socket now (e.g. the toggle just flipped on): release
      // ours so there's exactly one /api/events consumer per machine.
      if (activeSocket) stop();
      return status();
    }
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
    isAlive = true;
    const ws = new WebSocketImpl(cloudEventsUrl(s), cloudWebSocketProtocols(s));
    activeSocket = ws;
    ensureHeartbeat();
    ws.on("open", () => {
      log(`Listening to Mia Cloud events: ${s.url}`);
    });
    ws.on("pong", () => { isAlive = true; });
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
