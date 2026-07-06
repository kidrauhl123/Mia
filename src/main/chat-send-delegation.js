"use strict";

function daemonChatPayload(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const next = { ...source };
  delete next.webContents;
  delete next.emit;
  delete next.signal;
  delete next.abortController;
  return next;
}

function createChatSendDelegator({
  isDaemonProcess = false,
  requireDaemonRuntimeAvailable = () => {},
  daemonClient = null,
  fallbackSendChat = null
} = {}) {
  const isDaemon = typeof isDaemonProcess === "function" ? isDaemonProcess : () => Boolean(isDaemonProcess);

  return async function delegatedSendChat(payload = {}) {
    if (isDaemon()) {
      if (typeof fallbackSendChat !== "function") throw new Error("fallbackSendChat is required in daemon process.");
      return fallbackSendChat(payload || {});
    }
    requireDaemonRuntimeAvailable();
    if (!daemonClient || typeof daemonClient.call !== "function") {
      throw new Error("Mia Core daemon client is unavailable.");
    }
    return daemonClient.call("/api/chat/send", {
      method: "POST",
      body: JSON.stringify(daemonChatPayload(payload))
    });
  };
}

function createChatStopDelegator({
  isDaemonProcess = false,
  requireDaemonRuntimeAvailable = () => {},
  daemonClient = null,
  fallbackStopChat = null
} = {}) {
  const isDaemon = typeof isDaemonProcess === "function" ? isDaemonProcess : () => Boolean(isDaemonProcess);

  return async function delegatedStopChat(payload = {}) {
    if (isDaemon()) {
      if (typeof fallbackStopChat !== "function") throw new Error("fallbackStopChat is required in daemon process.");
      return fallbackStopChat(payload || {});
    }
    requireDaemonRuntimeAvailable();
    if (!daemonClient || typeof daemonClient.call !== "function") {
      throw new Error("Mia Core daemon client is unavailable.");
    }
    return daemonClient.call("/api/chat/stop", {
      method: "POST",
      body: JSON.stringify(payload || {})
    });
  };
}

module.exports = {
  createChatSendDelegator,
  createChatStopDelegator,
  daemonChatPayload
};
