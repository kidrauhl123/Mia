const crypto = require("node:crypto");

function createChatEventEmitter({
  webContents,
  sessionId = "",
  channel = "chat:event",
  runId = `mia_${crypto.randomUUID()}`,
  now = () => Date.now()
} = {}) {
  let seq = 0;
  const emit = webContents && !webContents.isDestroyed()
    ? (kind, data) => {
      try {
        if (webContents.isDestroyed()) return;
        webContents.send(channel, {
          runId,
          sessionId: sessionId || "",
          seq: ++seq,
          kind,
          data: data || {},
          ts: now()
        });
      } catch {
        // Ignore IPC errors on closed windows.
      }
    }
    : null;
  return { emit, runId };
}

module.exports = {
  createChatEventEmitter
};
