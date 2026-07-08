const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createChatSendDelegator,
  coreChatPayload
} = require("../src/main/chat-send-delegation.js");

test("coreChatPayload strips non-serializable foreground-only fields", () => {
  const payload = coreChatPayload({
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

test("GUI chat send posts a typed Core conversation message", async () => {
  const calls = [];
  const sendChat = createChatSendDelegator({
    isDaemonProcess: false,
    requireDaemonRuntimeAvailable: () => calls.push(["require-daemon"]),
    coreClient: {
      call: async (...args) => {
        calls.push(["core-call", ...args]);
        return { ok: true };
      }
    },
    fallbackSendChat: async () => {
      throw new Error("foreground must not execute chat locally");
    }
  });

  const result = await sendChat({
    botKey: "bot1",
    sessionId: "conversation:1",
    messages: [{ role: "user", content: "hello" }],
    selectedSkillIds: ["mia-official:xlsx"],
    webContents: { id: 1 }
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0][0], "require-daemon");
  assert.equal(calls[1][1], "/api/conversations/conversation%3A1/messages");
  assert.deepEqual(JSON.parse(calls[1][2].body), {
    body: "hello",
    attachments: [],
    selectedSkillIds: ["mia-official:xlsx"]
  });
});

test("daemon-process chat send uses the local fallback", async () => {
  const sendChat = createChatSendDelegator({
    isDaemonProcess: true,
    coreClient: {
      call: async () => {
        throw new Error("daemon process must not call itself over HTTP");
      }
    },
    fallbackSendChat: async (payload) => ({ local: payload.sessionId })
  });

  assert.deepEqual(await sendChat({ sessionId: "s1" }), { local: "s1" });
});
