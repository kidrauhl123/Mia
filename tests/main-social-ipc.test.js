const { test } = require("node:test");
const assert = require("node:assert/strict");

const { registerSocialIpc } = require("../src/main/social/social-ipc.js");
const { IpcChannel } = require("../src/shared/ipc-channels.js");

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    }
  };
}

test("posting a conversation message dispatches the returned user message to main conversation AI", async () => {
  const ipcMain = fakeIpcMain();
  const message = {
    id: "m_1",
    seq: 1,
    sender_kind: "user",
    sender_ref: "u_1",
    body_md: "你好"
  };
  const calls = { dispatched: [] };

  registerSocialIpc({
    ipcMain,
    socialApi: {
      postConversationMessage: async () => ({ message })
    },
    fellowRuntimeDispatcher: {
      handleCloudEvent: async (event) => calls.dispatched.push(event)
    }
  });

  const result = await ipcMain.handlers.get(IpcChannel.SocialPostConversationMessage)(
    null,
    "fellow:u_1:session_1",
    { bodyMd: "你好" }
  );

  assert.deepEqual(result, { ok: true, data: { message } });
  assert.deepEqual(calls.dispatched, [{
    type: "conversation.message_appended",
    conversationId: "fellow:u_1:session_1",
    message
  }]);
});
