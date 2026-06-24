const crypto = require("node:crypto");

function createChatEventEmitter({
  webContents,
  sessionId = "",
  channel = "chat:event",
  runId = `mia_${crypto.randomUUID()}`,
  now = () => Date.now(),
  // Non-Electron sink (Mia Core): a `(channel, envelope) => void` callback that
  // receives the same envelope `webContents.send` would. When supplied it takes
  // precedence over `webContents`, letting the backend stream chat events over
  // the local control channel with no renderer/IPC dependency. When absent the
  // behaviour is identical to before (IPC emitter, or null with no webContents).
  emitImpl = null
} = {}) {
  let seq = 0;
  const envelope = (kind, data) => ({
    runId,
    sessionId: sessionId || "",
    seq: ++seq,
    kind,
    data: data || {},
    ts: now()
  });
  let emit;
  if (typeof emitImpl === "function") {
    emit = (kind, data) => {
      try {
        emitImpl(channel, envelope(kind, data));
      } catch {
        // Ignore sink errors; chat execution must not fail on a dropped event.
      }
    };
  } else if (webContents && !webContents.isDestroyed()) {
    emit = (kind, data) => {
      try {
        if (webContents.isDestroyed()) return;
        webContents.send(channel, envelope(kind, data));
      } catch {
        // Ignore IPC errors on closed windows.
      }
    };
  } else {
    emit = null;
  }
  return { emit, runId };
}

module.exports = {
  createChatEventEmitter
};
