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

module.exports = {
  createChatSendDelegator,
  daemonChatPayload
};
