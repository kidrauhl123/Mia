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

test("posting a conversation message returns the cloud envelope and runs no desktop dispatch", async () => {
  const ipcMain = fakeIpcMain();
  const message = {
    id: "m_1",
    seq: 1,
    sender_kind: "user",
    sender_ref: "u_1",
    body_md: "你好"
  };

  registerSocialIpc({
    ipcMain,
    socialApi: {
      postConversationMessage: async () => ({ message })
    }
  });

  const result = await ipcMain.handlers.get(IpcChannel.SocialPostConversationMessage)(
    null,
    "botc_u_1_session_1",
    { bodyMd: "你好" }
  );

  assert.deepEqual(result, { ok: true, data: { message } });
});

test("listing conversation messages writes through to the local cache; cached read returns them", async () => {
  const ipcMain = fakeIpcMain();
  const upserts = [];
  const fakeCache = {
    upsertMessages: (conversationId, messages) => upserts.push({ conversationId, messages }),
    getRecentMessages: (conversationId) => (conversationId === "dm:a:b" ? [{ id: "m1", seq: 1 }] : [])
  };
  registerSocialIpc({
    ipcMain,
    socialApi: {
      listConversationMessages: async () => ({ messages: [{ id: "m1", seq: 1 }, { id: "m2", seq: 2 }] })
    },
    messageCache: fakeCache
  });

  const listed = await ipcMain.handlers.get(IpcChannel.SocialListConversationMessages)(null, "dm:a:b", 0, 100);
  assert.equal(listed.ok, true);
  assert.deepEqual(upserts, [{ conversationId: "dm:a:b", messages: [{ id: "m1", seq: 1 }, { id: "m2", seq: 2 }] }]);

  const cached = await ipcMain.handlers.get(IpcChannel.SocialGetCachedMessages)(null, "dm:a:b", 50);
  assert.deepEqual(cached, { ok: true, data: { messages: [{ id: "m1", seq: 1 }] } });
});

test("listing conversation messages reconciles stale local cache rows in the fetched window", async () => {
  const ipcMain = fakeIpcMain();
  const calls = [];
  const messages = [{ id: "m1", seq: 1 }];
  registerSocialIpc({
    ipcMain,
    socialApi: {
      listConversationMessages: async () => ({ messages })
    },
    messageCache: {
      reconcileFetchedMessages: (conversationId, sinceSeq, fetched, limit) => calls.push(["reconcile", conversationId, sinceSeq, fetched, limit]),
      upsertMessages: (conversationId, fetched) => calls.push(["upsert", conversationId, fetched])
    }
  });

  const listed = await ipcMain.handlers.get(IpcChannel.SocialListConversationMessages)(null, "dm:a:b", 30, 100);

  assert.equal(listed.ok, true);
  assert.deepEqual(calls, [
    ["reconcile", "dm:a:b", 30, messages, 100],
    ["upsert", "dm:a:b", messages]
  ]);
});

test("searching conversation messages writes hit messages through to the local cache", async () => {
  const ipcMain = fakeIpcMain();
  const upserts = [];
  const fakeCache = {
    upsertMessages: (conversationId, messages) => upserts.push({ conversationId, messages })
  };
  const searchResult = {
    conversation: { id: "botc_sess_1", type: "bot" },
    message: { id: "m_search", conversation_id: "botc_sess_1", body_md: "needle in session one" },
    matchText: "needle in session one"
  };
  registerSocialIpc({
    ipcMain,
    socialApi: {
      searchConversationMessages: async () => ({ results: [searchResult] })
    },
    messageCache: fakeCache
  });

  const result = await ipcMain.handlers.get(IpcChannel.SocialSearchConversationMessages)(null, "needle", 80);

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { results: [searchResult] });
  assert.deepEqual(upserts, [{
    conversationId: "botc_sess_1",
    messages: [searchResult.message]
  }]);
});

test("deleting a conversation message removes it from the local cache after cloud success", async () => {
  const ipcMain = fakeIpcMain();
  const deletes = [];
  registerSocialIpc({
    ipcMain,
    socialApi: {
      deleteConversationMessage: async () => ({ ok: true, conversationId: "dm:a:b", messageId: "m1" })
    },
    messageCache: {
      deleteMessage: (conversationId, messageId) => deletes.push({ conversationId, messageId })
    }
  });

  const result = await ipcMain.handlers.get(IpcChannel.SocialDeleteConversationMessage)(null, "dm:a:b", "m1");

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { ok: true, conversationId: "dm:a:b", messageId: "m1" });
  assert.deepEqual(deletes, [{ conversationId: "dm:a:b", messageId: "m1" }]);
});

test("social list IPC writes bootstrap data through to the local cache", async () => {
  const ipcMain = fakeIpcMain();
  const patches = [];
  const fakeCache = {
    updateSocialBootstrap: (userId, patch) => patches.push({ userId, patch }),
    getSocialBootstrap: (userId) => userId === "u_me" ? { userId, conversations: [{ id: "c_cached" }] } : null
  };
  registerSocialIpc({
    ipcMain,
    socialApi: {
      listFriends: async () => ({ friends: [{ id: "u_friend" }] }),
      listBots: async () => ({ bots: [{ id: "mia" }] }),
      listConversations: async () => ({ conversations: [{ id: "c_live" }] })
    },
    messageCache: fakeCache,
    getCloudUserId: () => "u_me"
  });

  await ipcMain.handlers.get(IpcChannel.SocialListFriends)(null);
  await ipcMain.handlers.get(IpcChannel.SocialListBots)(null);
  await ipcMain.handlers.get(IpcChannel.SocialListConversations)(null);
  const cached = await ipcMain.handlers.get(IpcChannel.SocialGetCachedBootstrap)(null, "u_me");

  assert.deepEqual(patches, [
    { userId: "u_me", patch: { friends: [{ id: "u_friend" }] } },
    { userId: "u_me", patch: { bots: [{ id: "mia" }] } },
    { userId: "u_me", patch: { conversations: [{ id: "c_live" }] } }
  ]);
  assert.deepEqual(cached, { ok: true, data: { userId: "u_me", conversations: [{ id: "c_cached" }] } });
});

test("updating a conversation writes the returned title through to the social bootstrap cache", async () => {
  const ipcMain = fakeIpcMain();
  const patches = [];
  const fakeCache = {
    getSocialBootstrap: (userId) => userId === "u_me" ? {
      userId,
      conversations: [
        { id: "bot:u_me:kongling", type: "bot", name: "空铃" },
        { id: "g_1", type: "group", name: "Group" }
      ]
    } : null,
    updateSocialBootstrap: (userId, patch) => patches.push({ userId, patch })
  };
  registerSocialIpc({
    ipcMain,
    socialApi: {
      updateConversation: async () => ({
        conversation: { id: "bot:u_me:kongling", type: "bot", name: "查看package.json行数" }
      })
    },
    messageCache: fakeCache,
    getCloudUserId: () => "u_me"
  });

  const result = await ipcMain.handlers.get(IpcChannel.SocialUpdateConversation)(
    null,
    "bot:u_me:kongling",
    { name: "查看package.json行数" }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(patches, [{
    userId: "u_me",
    patch: {
      conversations: [
        { id: "bot:u_me:kongling", type: "bot", name: "查看package.json行数" },
        { id: "g_1", type: "group", name: "Group" }
      ]
    }
  }]);
});

test("cached read returns empty envelope when no cache is wired", async () => {
  const ipcMain = fakeIpcMain();
  registerSocialIpc({ ipcMain, socialApi: {} });
  const cached = await ipcMain.handlers.get(IpcChannel.SocialGetCachedMessages)(null, "dm:a:b", 50);
  assert.deepEqual(cached, { ok: true, data: { messages: [] } });
  const cachedBootstrap = await ipcMain.handlers.get(IpcChannel.SocialGetCachedBootstrap)(null, "u_me");
  assert.deepEqual(cachedBootstrap, { ok: true, data: null });
});
