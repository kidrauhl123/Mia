"use strict";

const WebSocket = require("ws");

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function normalizeMessageData(message) {
  if (typeof message === "string") return message;
  if (Buffer.isBuffer(message)) return message.toString("utf8");
  if (message && Buffer.isBuffer(message.data)) return message.data.toString("utf8");
  if (message && typeof message.data === "string") return message.data;
  return String(message || "");
}

function gatewayError(message, details) {
  const error = new Error(message);
  if (details && typeof details === "object") Object.assign(error, details);
  return error;
}

function createHermesGatewayClient(deps = {}) {
  const WebSocketImpl = deps.WebSocketImpl || WebSocket;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const requestTimeoutMs = Number(deps.requestTimeoutMs) > 0 ? Number(deps.requestTimeoutMs) : DEFAULT_REQUEST_TIMEOUT_MS;

  let socket = null;
  let connectPromise = null;
  let nextRequestId = 1;
  const pending = new Map();
  const handlers = new Map();
  let intentionalClose = false;
  let terminalEventDispatched = false;

  function clearPendingRequest(id, error, result) {
    const pendingRequest = pending.get(id);
    if (!pendingRequest) return;
    pending.delete(id);
    clearTimeoutFn(pendingRequest.timeoutId);
    if (error) pendingRequest.reject(error);
    else pendingRequest.resolve(result);
  }

  function rejectAllPending(error) {
    for (const id of [...pending.keys()]) {
      clearPendingRequest(id, error);
    }
  }

  function dispatchEvent(event) {
    const exactHandlers = handlers.get(event.type) || [];
    for (const handler of exactHandlers) handler(event);
    const allHandlers = handlers.get("*") || [];
    for (const handler of allHandlers) handler(event);
  }

  function dispatchTerminalEvent(message, details = {}) {
    if (intentionalClose || terminalEventDispatched) return;
    terminalEventDispatched = true;
    dispatchEvent({
      type: "error",
      session_id: "",
      payload: { message },
      ...details
    });
  }

  function handleFrame(frameText) {
    if (!frameText.trim()) return;
    const frame = JSON.parse(frameText);
    if (frame && frame.method === "event" && frame.params && typeof frame.params === "object") {
      dispatchEvent(frame.params);
      return;
    }
    if (frame && Object.prototype.hasOwnProperty.call(frame, "id")) {
      if (frame.error) {
        clearPendingRequest(
          frame.id,
          gatewayError(frame.error.message || "Hermes gateway request failed.", {
            code: frame.error.code,
            data: frame.error.data
          })
        );
      } else {
        clearPendingRequest(frame.id, null, frame.result);
      }
    }
  }

  function handleMessage(message) {
    const text = normalizeMessageData(message);
    for (const frame of text.split(/\n+/)) {
      if (frame.trim()) handleFrame(frame);
    }
  }

  function bindSocket(nextSocket, resolve, reject) {
    nextSocket.on("open", () => {
      resolve();
    });
    nextSocket.on("message", handleMessage);
    nextSocket.on("error", (error) => {
      const socketError = gatewayError(error?.message || "Hermes gateway connection error.");
      if (connectPromise) reject(socketError);
      dispatchTerminalEvent(socketError.message, { error: socketError });
      rejectAllPending(socketError);
    });
    nextSocket.on("close", () => {
      connectPromise = null;
      socket = null;
      const closeError = gatewayError("Hermes gateway connection closed.");
      dispatchTerminalEvent(closeError.message, { error: closeError });
      rejectAllPending(closeError);
    });
  }

  async function connect(wsUrl) {
    if (socket && socket.readyState === WebSocketImpl.OPEN) return;
    if (connectPromise) return connectPromise;
    intentionalClose = false;
    terminalEventDispatched = false;
    connectPromise = new Promise((resolve, reject) => {
      socket = new WebSocketImpl(wsUrl);
      bindSocket(socket, () => {
        connectPromise = null;
        resolve();
      }, (error) => {
        connectPromise = null;
        reject(error);
      });
    });
    return connectPromise;
  }

  function request(method, params = {}, options = {}) {
    if (!socket || socket.readyState !== WebSocketImpl.OPEN) {
      return Promise.reject(gatewayError("Hermes gateway is not connected."));
    }
    const id = nextRequestId++;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : requestTimeoutMs;
    const frame = {
      jsonrpc: "2.0",
      id,
      method,
      params: params && typeof params === "object" ? params : {}
    };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeoutFn(() => {
        pending.delete(id);
        reject(gatewayError(`Hermes gateway request timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeoutId });
      socket.send(JSON.stringify(frame));
    });
  }

  function on(type, handler) {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(handler);
  }

  function close() {
    intentionalClose = true;
    if (socket && typeof socket.close === "function") socket.close();
    else rejectAllPending(gatewayError("Hermes gateway connection closed."));
  }

  return {
    close,
    connect,
    on,
    request
  };
}

module.exports = {
  createHermesGatewayClient
};
