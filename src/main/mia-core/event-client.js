"use strict";

const MAX_RECONNECT_DELAY_MS = 15000;

function coreWsUrl(baseUrl) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  return `${normalized.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/ws`;
}

function websocketMessageData(event) {
  if (event && typeof event === "object" && "data" in event) return event.data;
  return event;
}

function websocketMessageText(raw) {
  if (typeof raw === "string") return raw;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  return String(raw == null ? "" : raw);
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

function firstString(source, keys) {
  for (const key of keys) {
    const value = source && source[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(blockText).join("");
  if (value && typeof value === "object") return blockText(value);
  return "";
}

function blockText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(blockText).join("");
  if (!value || typeof value !== "object") return "";
  for (const key of ["text", "content", "delta", "output", "message", "final_response", "thinking"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const text = contentText(value[key]);
      if (text) return text;
    }
  }
  return "";
}

function assistantMessageText(value) {
  const messageContent = value?.message?.content;
  return contentText(messageContent)
    || contentText(value?.content)
    || firstString(value, ["text", "delta"]);
}

function codexJsonLineToRunEvent(value) {
  const type = String(value?.type || "");
  if (["agent_message_delta", "message_delta", "response.output_text.delta"].includes(type)) {
    const text = firstString(value, ["delta", "text", "message", "content", "output_text_delta"]);
    return text ? { type: "message.delta", text } : null;
  }
  if (["agent_message", "message"].includes(type)) {
    const text = firstString(value, ["message", "text", "content"]);
    return text.trim() ? { type: "message.complete", text } : null;
  }
  if (["task_complete", "turn_complete", "response.completed"].includes(type)) {
    const text = firstString(value, ["last_agent_message", "final_response", "message", "text", "content"])
      || firstString(value?.response || {}, ["output_text", "text"]);
    return text.trim() ? { type: "run.completed", final_response: text } : null;
  }
  if (["agent_reasoning", "agent_reasoning_delta", "reasoning_delta"].includes(type)) {
    const text = firstString(value, ["text", "delta", "reasoning", "summary"]);
    return text.trim() ? { type: "reasoning_delta", text } : null;
  }
  if (["exec_command_begin", "tool_call_begin", "tool_call"].includes(type)) {
    return {
      type: "tool.started",
      id: firstString(value, ["id", "call_id"]) || "tool",
      name: firstString(value, ["name", "command", "tool"]) || "tool",
      preview: firstString(value, ["command", "text", "input"])
    };
  }
  if (["exec_command_output_delta", "tool_call_delta"].includes(type)) {
    const text = firstString(value, ["delta", "text", "output", "preview"]);
    return text ? { type: "tool.delta", delta: text, preview: text } : null;
  }
  if (["exec_command_end", "tool_call_end", "tool_result"].includes(type)) {
    return { type: "tool.completed" };
  }
  if (type === "error") {
    const message = firstString(value?.error || {}, ["message"])
      || (typeof value?.error === "string" ? value.error : "")
      || firstString(value, ["message"])
      || "Codex failed.";
    return { type: "error", text: message, message };
  }
  const item = value?.item;
  if (item && typeof item === "object") {
    const itemType = String(item.type || "");
    if (itemType === "message" || itemType === "agent_message") {
      const text = blockText(item);
      return text.trim() ? { type: "message.complete", text } : null;
    }
    if (itemType.includes("call")) {
      return {
        type: "tool.started",
        id: firstString(item, ["id", "call_id"]) || "tool",
        name: firstString(item, ["name"]) || "tool",
        preview: blockText(item)
      };
    }
  }
  return null;
}

function claudeJsonLineToRunEvent(value) {
  const type = String(value?.type || "");
  if (type === "stream_event") return claudeStreamEventToRunEvent(value.event || {});
  if (type === "assistant") {
    const text = assistantMessageText(value);
    return text.trim() ? { type: "message.complete", text } : null;
  }
  if (type === "result") {
    const text = firstString(value, ["result", "output_text", "content"]);
    return text.trim() ? { type: "run.completed", final_response: text } : null;
  }
  if (type === "error") {
    const message = firstString(value?.error || {}, ["message"])
      || (typeof value?.error === "string" ? value.error : "")
      || firstString(value, ["message"])
      || "Claude Code failed.";
    return { type: "error", text: message, message };
  }
  return null;
}

function claudeStreamEventToRunEvent(event) {
  const type = String(event?.type || "");
  if (type === "content_block_start") {
    const block = event?.content_block || {};
    const blockType = String(block.type || "");
    if (blockType === "tool_use") {
      return {
        type: "tool.started",
        id: firstString(block, ["id"]),
        name: firstString(block, ["name"]) || "tool",
        input: block.input || {},
        preview: block.input ? JSON.stringify(block.input) : ""
      };
    }
    if (blockType === "thinking") {
      return { type: "reasoning_delta", id: `thinking_${Number(event.index) || 0}`, text: blockText(block) };
    }
  }
  if (type === "content_block_delta") {
    const delta = event?.delta || {};
    const deltaType = String(delta.type || "");
    if (deltaType === "text_delta") return { type: "message.delta", text: firstString(delta, ["text"]) };
    if (deltaType === "thinking_delta") {
      return { type: "reasoning_delta", id: `thinking_${Number(event.index) || 0}`, text: firstString(delta, ["thinking", "text"]) };
    }
    if (deltaType === "input_json_delta") {
      const text = firstString(delta, ["partial_json"]);
      return { type: "tool.delta", delta: text, preview: text };
    }
  }
  return null;
}

function runtimeStatusNoiseLine(engine, text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return true;
  if (engine === "codex") {
    return trimmed === "Reading prompt from stdin..."
      || trimmed === "Reading prompt from stdin…"
      || trimmed === "Reading additional input from stdin..."
      || trimmed === "Reading additional input from stdin…";
  }
  return false;
}

function coreRuntimeStdoutEvent(engine, text) {
  const raw = String(text || "");
  const trimmed = raw.trim();
  const normalizedEngine = String(engine || "").trim();
  if (runtimeStatusNoiseLine(normalizedEngine, raw)) return null;
  let sawJson = false;
  const parsedEvents = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
      sawJson = true;
    } catch {
      continue;
    }
    const event = normalizedEngine === "codex"
      ? codexJsonLineToRunEvent(value)
      : claudeJsonLineToRunEvent(value);
    if (event) parsedEvents.push(event);
  }
  if (parsedEvents.length) return parsedEvents[0];
  if (sawJson) return null;
  return { type: "text_delta", text: raw };
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
    const structuredEvent = data.event
      && typeof data.event === "object"
      && !Array.isArray(data.event)
      && String(data.event.type || "").trim()
      ? { ...data.event }
      : null;
    const event = type === "conversation.runtimeStdout"
      ? (structuredEvent || coreRuntimeStdoutEvent(String(data.engine || ""), text))
      : { type: "status", text };
    if (!event) return null;
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

  function disposeSocket(current, immediate = false) {
    try {
      if (immediate && typeof current?.terminate === "function") {
        current.terminate();
        return;
      }
      current?.close?.();
    } catch {
      // Ignore teardown failures from sockets that already closed themselves.
    }
  }

  function scheduleReconnect() {
    setConnected(false);
    if (stopped || timer) return;
    timer = setTimeoutFn(() => {
      timer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  function disconnectSocket(current, { immediate = false } = {}) {
    // A delayed close/error from a retired socket must never clear the active
    // replacement or schedule another reconnect behind its back.
    if (!current || socket !== current) return;
    socket = null;
    if (immediate) disposeSocket(current, true);
    scheduleReconnect();
  }

  function handleMessage(event) {
    const raw = websocketMessageData(event);
    let envelope;
    try {
      envelope = JSON.parse(websocketMessageText(raw));
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
        if (socket !== nextSocket) {
          disposeSocket(nextSocket, true);
          return;
        }
        reconnectDelay = initialReconnectDelayMs;
        setConnected(true);
      });
      nextSocket.addEventListener("message", (event) => {
        if (socket === nextSocket) handleMessage(event);
      });
      nextSocket.addEventListener("close", () => disconnectSocket(nextSocket));
      nextSocket.addEventListener("error", () => disconnectSocket(nextSocket, { immediate: true }));
    } else if (typeof nextSocket.on === "function") {
      nextSocket.on("open", () => {
        if (socket !== nextSocket) {
          disposeSocket(nextSocket, true);
          return;
        }
        reconnectDelay = initialReconnectDelayMs;
        setConnected(true);
      });
      nextSocket.on("message", (data) => {
        if (socket === nextSocket) handleMessage(data);
      });
      nextSocket.on("close", () => disconnectSocket(nextSocket));
      nextSocket.on("error", () => disconnectSocket(nextSocket, { immediate: true }));
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
    disposeSocket(current);
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
