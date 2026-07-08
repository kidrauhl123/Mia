"use strict";

const MAX_RECONNECT_DELAY_MS = 15000;

function coreWsUrl(baseUrl) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  return `${normalized.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/ws`;
}

function rendererTaskEnvelope(envelope = {}) {
  const name = String(envelope.name || envelope.type || "");
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data : {};
  const legacyTypes = {
    "task.created": "created",
    "task.updated": "updated",
    "task.runStarted": "started",
    "task.runFinished": "finished"
  };
  const payload = {
    ...data,
    ...(data.jobId && !data.taskId ? { taskId: data.jobId } : {})
  };
  return {
    ...envelope,
    type: legacyTypes[name] || name.replace(/^task\./, ""),
    payload
  };
}

function envelopePayload(envelope = {}) {
  const hasData = envelope && Object.prototype.hasOwnProperty.call(envelope, "data");
  const hasPayload = envelope && Object.prototype.hasOwnProperty.call(envelope, "payload");
  return hasData ? envelope.data : (hasPayload ? envelope.payload : {});
}

function coreRuntimeRunId(data = {}) {
  return String(data.runId || data.run_id || data.turnId || data.turn_id || "").trim();
}

function coreConversationRuntimeEnvelope(envelope = {}) {
  const type = String(envelope?.name || envelope?.type || "").trim();
  const data = envelopePayload(envelope);
  const conversationId = String(data?.conversationId || data?.conversation_id || "").trim();
  const runId = coreRuntimeRunId(data);
  if (type === "conversation.messageCreated" && data?.message && typeof data.message === "object") {
    const cloudConversationId = String(data.cloudConversationId || data.cloud_conversation_id || "").trim();
    const rendererConversationId = cloudConversationId || conversationId;
    const cloudBridgeRunId = String(data.cloudBridgeRunId || data.cloud_bridge_run_id || "").trim();
    const message = { ...data.message };
    if (rendererConversationId && rendererConversationId !== conversationId) {
      message.local_conversation_id = message.local_conversation_id || message.conversation_id || conversationId;
      message.conversation_id = rendererConversationId;
      message._localCoreConversationId = conversationId;
    }
    if (cloudBridgeRunId) message._cloudBridgeRunId = cloudBridgeRunId;
    return {
      type: "conversation.message_appended",
      payload: {
        conversationId: rendererConversationId,
        message
      },
      coreEnvelope: envelope
    };
  }
  if (!conversationId || !runId) return null;
  if (type === "conversation.runtimeStarted") {
    return {
      type: "cloud_agent_run_started",
      payload: {
        conversationId,
        runId,
        turnId: String(data.turnId || data.turn_id || runId),
        hermesRunId: String(data.hermesRunId || data.hermes_run_id || runId),
        botId: String(data.botId || data.bot_id || ""),
        engine: String(data.engine || "")
      },
      coreEnvelope: envelope
    };
  }
  if (type === "conversation.runtimeStdout" || type === "conversation.runtimeStderr") {
    const text = String(data.text || data.delta || data.message || "");
    return {
      type: "cloud_agent_run_event",
      payload: {
        conversationId,
        runId,
        turnId: String(data.turnId || data.turn_id || runId),
        event: type === "conversation.runtimeStdout"
          ? { type: "text_delta", text }
          : { type: "status", text }
      },
      coreEnvelope: envelope
    };
  }
  if (type === "conversation.runtimeCancelRequested") {
    return {
      type: "cloud_agent_run_event",
      payload: {
        conversationId,
        runId,
        turnId: String(data.turnId || data.turn_id || runId),
        event: { type: "run.cancelling" }
      },
      coreEnvelope: envelope
    };
  }
  if (type === "conversation.runtimeFinished") {
    const cancelled = data.cancelled === true;
    const ok = data.ok !== false && !cancelled;
    const event = cancelled
      ? { type: "run.cancelled" }
      : ok
        ? { type: "run.completed" }
        : { type: "error", message: String(data.error || data.stderr || "Runtime execution failed.") };
    return {
      type: "cloud_agent_run_event",
      payload: {
        conversationId,
        runId,
        turnId: String(data.turnId || data.turn_id || runId),
        event
      },
      coreEnvelope: envelope
    };
  }
  return null;
}

function coreLocalEventEnvelope(envelope = {}, options = {}) {
  const type = String(envelope?.name || envelope?.type || "").trim();
  if (!type) return null;
  if (type.startsWith("task.")) {
    if (options.includeTaskEvents !== true) return null;
    return {
      ...rendererTaskEnvelope(envelope),
      coreEnvelope: envelope
    };
  }
  if (type.startsWith("conversation.")) {
    const runtimeEnvelope = coreConversationRuntimeEnvelope(envelope);
    if (runtimeEnvelope) return runtimeEnvelope;
  }
  const payload = envelopePayload(envelope);
  const localEnvelope = {
    type,
    payload,
    coreEnvelope: envelope
  };
  if (payload?.cloud && typeof payload.cloud === "object") {
    localEnvelope.cloud = payload.cloud;
  }
  return localEnvelope;
}

function createMiaCoreLocalEventsClient({
  baseUrl,
  enabled = () => true,
  onEnvelope = () => {},
  onStateChange = () => {},
  WebSocketImpl = globalThis.WebSocket,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  initialReconnectDelayMs = 1000,
  includeTaskEvents = false,
  eventMapper = coreLocalEventEnvelope
}) {
  let stopped = false;
  let timer = null;
  let socket = null;
  let connected = false;
  let reconnectDelay = initialReconnectDelayMs;

  function setConnected(next) {
    if (connected === next) return;
    connected = next;
    try {
      onStateChange(connected);
    } catch {
      // Listener failures must not tear down the Core event subscription.
    }
  }

  function clearReconnectTimer() {
    if (!timer) return;
    clearTimeoutFn(timer);
    timer = null;
  }

  function scheduleReconnect() {
    setConnected(false);
    socket = null;
    if (stopped || timer) return;
    timer = setTimeoutFn(() => {
      timer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  function handleMessage(event) {
    const raw = Object.prototype.hasOwnProperty.call(event || {}, "data") ? event.data : event;
    let envelope;
    try {
      envelope = JSON.parse(String(raw || ""));
    } catch {
      return;
    }
    const localEnvelope = eventMapper(envelope, { includeTaskEvents });
    if (!localEnvelope) return;
    try {
      onEnvelope(localEnvelope);
    } catch {
      // A renderer/broadcast failure should not break the Core websocket.
    }
  }

  function connect() {
    if (stopped || socket) return;
    if (!enabled() || !WebSocketImpl) {
      scheduleReconnect();
      return;
    }
    let url;
    try {
      url = coreWsUrl(baseUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    if (!url || url === "/ws") {
      scheduleReconnect();
      return;
    }
    const nextSocket = new WebSocketImpl(url);
    socket = nextSocket;
    if (typeof nextSocket.addEventListener === "function") {
      nextSocket.addEventListener("open", () => {
        reconnectDelay = initialReconnectDelayMs;
        setConnected(true);
      });
      nextSocket.addEventListener("message", handleMessage);
      nextSocket.addEventListener("close", scheduleReconnect);
      nextSocket.addEventListener("error", scheduleReconnect);
    } else if (typeof nextSocket.on === "function") {
      nextSocket.on("open", () => {
        reconnectDelay = initialReconnectDelayMs;
        setConnected(true);
      });
      nextSocket.on("message", (data) => handleMessage(data));
      nextSocket.on("close", scheduleReconnect);
      nextSocket.on("error", scheduleReconnect);
    }
  }

  function start() {
    stopped = false;
    clearReconnectTimer();
    if (!socket) connect();
    return status();
  }

  function stop() {
    stopped = true;
    clearReconnectTimer();
    const current = socket;
    socket = null;
    try {
      current?.close?.();
    } catch {
      // Ignore teardown failures from already-closed sockets.
    }
    setConnected(false);
    return status();
  }

  function status() {
    return { connected, stopped };
  }

  return { start, stop, status };
}

module.exports = {
  coreConversationRuntimeEnvelope,
  coreWsUrl,
  coreLocalEventEnvelope,
  createMiaCoreLocalEventsClient,
  rendererTaskEnvelope
};
