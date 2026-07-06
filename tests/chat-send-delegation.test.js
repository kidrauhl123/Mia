const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createChatSendDelegator,
  createChatStopDelegator,
  daemonChatPayload
} = require("../src/main/chat-send-delegation.js");

test("daemonChatPayload strips non-serializable foreground-only fields", () => {
  const payload = daemonChatPayload({
    botKey: "bot1",
    sessionId: "s1",
    webContents: { send() {} },
    emit: () => {},
    signal: new AbortController().signal,
    abortController: new AbortController()
  });

  assert.deepEqual(payload, {
    botKey: "bot1",
    sessionId: "s1"
  });
});

test("GUI chat send delegates to the Core daemon send route", async () => {
  const calls = [];
  const sendChat = createChatSendDelegator({
    isDaemonProcess: false,
    requireDaemonRuntimeAvailable: () => calls.push(["require-daemon"]),
    daemonClient: {
      call: async (...args) => {
        calls.push(["daemon-call", ...args]);
        return { ok: true };
      }
    },
    fallbackSendChat: async () => {
      throw new Error("foreground must not execute chat locally");
    }
  });

  const result = await sendChat({
    botKey: "bot1",
    sessionId: "s1",
    webContents: { id: 1 }
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0][0], "require-daemon");
  assert.equal(calls[1][1], "/api/chat/send");
  assert.deepEqual(JSON.parse(calls[1][2].body), {
    botKey: "bot1",
    sessionId: "s1"
  });
});

test("daemon-process chat send uses the local fallback", async () => {
  const sendChat = createChatSendDelegator({
    isDaemonProcess: true,
    daemonClient: {
      call: async () => {
        throw new Error("daemon process must not call itself over HTTP");
      }
    },
    fallbackSendChat: async (payload) => ({ local: payload.sessionId })
  });

  assert.deepEqual(await sendChat({ sessionId: "s1" }), { local: "s1" });
});

test("GUI chat stop delegates to the Core daemon stop route", async () => {
  const calls = [];
  const stopChat = createChatStopDelegator({
    isDaemonProcess: false,
    requireDaemonRuntimeAvailable: () => calls.push(["require-daemon"]),
    daemonClient: {
      call: async (...args) => {
        calls.push(["daemon-call", ...args]);
        return { stopped: true };
      }
    },
    fallbackStopChat: async () => {
      throw new Error("foreground must not stop chat locally");
    }
  });

  const result = await stopChat({ sessionId: "s1", botKey: "bot1" });

  assert.deepEqual(result, { stopped: true });
  assert.equal(calls[0][0], "require-daemon");
  assert.equal(calls[1][1], "/api/chat/stop");
  assert.deepEqual(JSON.parse(calls[1][2].body), {
    sessionId: "s1",
    botKey: "bot1"
  });
});

test("daemon-process chat stop uses the local fallback", async () => {
  const stopChat = createChatStopDelegator({
    isDaemonProcess: true,
    daemonClient: {
      call: async () => {
        throw new Error("daemon process must not call itself over HTTP");
      }
    },
    fallbackStopChat: async (payload) => ({ local: payload.sessionId })
  });

  assert.deepEqual(await stopChat({ sessionId: "s1" }), { local: "s1" });
});
