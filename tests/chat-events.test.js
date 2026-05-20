const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createChatEventEmitter } = require("../src/main/chat-events.js");

function fakeWebContents() {
  const sent = [];
  let destroyed = false;
  return {
    sent,
    destroy() {
      destroyed = true;
    },
    isDestroyed() {
      return destroyed;
    },
    send(channel, payload) {
      sent.push({ channel, payload });
    }
  };
}

test("createChatEventEmitter sends stable chat event envelopes", () => {
  const webContents = fakeWebContents();
  const { emit, runId } = createChatEventEmitter({
    webContents,
    sessionId: "s1",
    runId: "run1",
    now: () => 123
  });
  assert.equal(runId, "run1");
  emit("session_started", { fellowKey: "alice" });
  emit("text_delta", { id: "t1", text: "hi" });
  assert.deepEqual(webContents.sent, [
    {
      channel: "chat:event",
      payload: {
        runId: "run1",
        sessionId: "s1",
        seq: 1,
        kind: "session_started",
        data: { fellowKey: "alice" },
        ts: 123
      }
    },
    {
      channel: "chat:event",
      payload: {
        runId: "run1",
        sessionId: "s1",
        seq: 2,
        kind: "text_delta",
        data: { id: "t1", text: "hi" },
        ts: 123
      }
    }
  ]);
});

test("createChatEventEmitter returns null emit for missing or destroyed webContents", () => {
  assert.equal(createChatEventEmitter({ webContents: null }).emit, null);
  const webContents = fakeWebContents();
  webContents.destroy();
  assert.equal(createChatEventEmitter({ webContents }).emit, null);
});

test("chat event emitter ignores close races after creation", () => {
  const webContents = fakeWebContents();
  const { emit } = createChatEventEmitter({ webContents, runId: "run1" });
  webContents.destroy();
  emit("text_delta", { text: "ignored" });
  assert.equal(webContents.sent.length, 0);
});
