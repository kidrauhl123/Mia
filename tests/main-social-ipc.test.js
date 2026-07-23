const { test } = require("node:test");
const assert = require("node:assert/strict");

const { cacheLiveConversationMessageEvent, registerSocialIpc } = require("../src/main/social/social-ipc.js");
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

test("run approval IPC forwards the owner decision to socialApi", async () => {
  const ipcMain = fakeIpcMain();
  const calls = [];

  registerSocialIpc({
    ipcMain,
    socialApi: {
      respondRunApproval: async (conversationId, runId, decision) => {
        calls.push({ conversationId, runId, decision });
        return { ok: true, decision };
      }
    }
  });

  const result = await ipcMain.handlers.get(IpcChannel.SocialRespondRunApproval)(
    null,
    "botc_u_1_mia",
    "car_run_1",
    "allow_once"
  );

  assert.deepEqual(result, { ok: true, data: { ok: true, decision: "allow_once" } });
  assert.deepEqual(calls, [{ conversationId: "botc_u_1_mia", runId: "car_run_1", decision: "allow_once" }]);
});

test("run cancellation IPC forwards the active run to socialApi", async () => {
  const ipcMain = fakeIpcMain();
  const calls = [];

  registerSocialIpc({
    ipcMain,
    socialApi: {
      cancelConversationRun: async (conversationId, runId) => {
        calls.push({ conversationId, runId });
        return { ok: true, status: "cancelling" };
      }
    }
  });

  const result = await ipcMain.handlers.get(IpcChannel.SocialCancelConversationRun)(
    null,
    "botc_u_1_mia",
    "car_run_1"
  );

  assert.deepEqual(result, { ok: true, data: { ok: true, status: "cancelling" } });
  assert.deepEqual(calls, [{ conversationId: "botc_u_1_mia", runId: "car_run_1" }]);
});

test("runtime gate allows user message writes but blocks runtime social reads while cached reads stay available", async () => {
  const ipcMain = fakeIpcMain();
  let posted = false;

  registerSocialIpc({
    ipcMain,
    socialApi: {
      postConversationMessage: async () => {
        posted = true;
        return { message: { id: "m_live" } };
      },
      listConversations: async () => ({ conversations: [{ id: "live" }] })
    },
    messageCache: {
      getRecentMessages: () => [{ id: "m_cached", seq: 1 }]
    },
    ensureRuntimeAvailable: () => {
      const error = new Error("Mia Core 未运行，Mia 暂不可用。");
      error.status = 503;
      throw error;
    }
  });

  const blocked = await ipcMain.handlers.get(IpcChannel.SocialPostConversationMessage)(
    null,
    "botc_u_1_session_1",
    { bodyMd: "你好" }
  );
  const blockedList = await ipcMain.handlers.get(IpcChannel.SocialListConversations)(null);
  const cached = await ipcMain.handlers.get(IpcChannel.SocialGetCachedMessages)(null, "botc_u_1_session_1", 50);

  assert.equal(posted, true);
  assert.deepEqual(blocked, { ok: true, data: { message: { id: "m_live" } } });
  assert.deepEqual(blockedList, {
    ok: false,
    error: "Mia Core 未运行，Mia 暂不可用。",
    status: 503
  });
  assert.deepEqual(cached, { ok: true, data: { messages: [{ id: "m_cached", seq: 1 }] } });
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

test("listing conversation messages passes the fetched window to the local cache", async () => {
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

test("caching a merged local Core history writes user and bot messages to the visible conversation cache", async () => {
  const ipcMain = fakeIpcMain();
  const upserts = [];
  const messages = [
    { id: "core_user_1", seq: 1, sender_kind: "user", body_md: "你好" },
    { id: "core_bot_1", seq: 2, sender_kind: "bot", body_md: "你好呀" }
  ];
  registerSocialIpc({
    ipcMain,
    socialApi: {},
    messageCache: {
      upsertMessages: (conversationId, fetched) => {
        upserts.push({ conversationId, messages: fetched });
        return fetched.length;
      }
    }
  });

  const cached = await ipcMain.handlers.get(IpcChannel.SocialCacheConversationMessages)(
    null,
    "botc_u_1_local",
    messages
  );

  assert.deepEqual(cached, { ok: true, data: { written: 2 } });
  assert.deepEqual(upserts, [{ conversationId: "botc_u_1_local", messages }]);
});

test("caching optimistic conversation metadata makes a new local bot session reloadable offline", async () => {
  const ipcMain = fakeIpcMain();
  const patches = [];
  const conversation = {
    id: "botc_local_offline",
    type: "bot",
    name: "新对话",
    decorations: {
      botId: "codex",
      sessionId: "local_offline",
      runtimeKind: "desktop-local"
    }
  };
  registerSocialIpc({
    ipcMain,
    socialApi: {},
    messageCache: {
      getSocialBootstrap: () => ({ conversations: [] }),
      updateSocialBootstrap: (userId, patch) => patches.push({ userId, patch })
    },
    getCloudUserId: () => "u_me"
  });

  const cached = await ipcMain.handlers.get(IpcChannel.SocialCacheConversation)(null, conversation);

  assert.deepEqual(cached, { ok: true, data: { conversation } });
  assert.deepEqual(patches, [{
    userId: "u_me",
    patch: { conversations: [{ ...conversation, localPendingSync: true }] }
  }]);
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

test("live conversation message events write through to the local cache", () => {
  const upserts = [];
  const message = { id: "m_live", seq: 4, sender_kind: "bot", body_md: "live reply" };

  const written = cacheLiveConversationMessageEvent({
    messageCache: {
      upsertMessages: (conversationId, messages) => upserts.push({ conversationId, messages })
    },
    envelope: {
      type: "conversation.message_appended",
      payload: { conversationId: "botc_u_1_mia", message }
    }
  });

  assert.equal(written, true);
  assert.deepEqual(upserts, [{ conversationId: "botc_u_1_mia", messages: [message] }]);
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

test("listing cloud conversations preserves locally pending bot sessions across reload", async () => {
  const ipcMain = fakeIpcMain();
  const patches = [];
  const pending = {
    id: "botc_local_pending",
    type: "bot",
    name: "新对话",
    decorations: {
      botId: "codex",
      sessionId: "local_pending",
      runtimeKind: "desktop-local"
    },
    localPendingSync: true
  };
  registerSocialIpc({
    ipcMain,
    socialApi: {
      listConversations: async () => ({ conversations: [{ id: "c_live", type: "dm" }] })
    },
    messageCache: {
      getSocialBootstrap: () => ({ conversations: [pending] }),
      updateSocialBootstrap: (userId, patch) => patches.push({ userId, patch })
    },
    getCloudUserId: () => "u_me"
  });

  const listed = await ipcMain.handlers.get(IpcChannel.SocialListConversations)(null);

  assert.deepEqual(listed.data.conversations, [
    { id: "c_live", type: "dm" },
    pending
  ]);
  assert.deepEqual(patches, [{
    userId: "u_me",
    patch: { conversations: [{ id: "c_live", type: "dm" }, pending] }
  }]);
});

test("ensuring a bot session writes the visible conversation and members through to the bootstrap cache", async () => {
  const ipcMain = fakeIpcMain();
  const patches = [];
  const conversation = {
    id: "botc_session_new",
    type: "bot",
    name: "新对话",
    decorations: {
      botId: "codex",
      sessionId: "session_new",
      runtimeKind: "desktop-local"
    }
  };
  const members = [
    { member_kind: "user", member_ref: "u_me" },
    { member_kind: "bot", member_ref: "codex" }
  ];
  const fakeCache = {
    getSocialBootstrap: (userId) => userId === "u_me" ? {
      userId,
      conversations: [
        { id: "botc_existing", type: "bot", name: "Existing" },
        { ...conversation, localPendingSync: true }
      ],
      members: {}
    } : null,
    updateSocialBootstrap: (userId, patch) => patches.push({ userId, patch })
  };
  registerSocialIpc({
    ipcMain,
    socialApi: {
      ensureBotSessionConversation: async () => ({ conversation, members })
    },
    messageCache: fakeCache,
    getCloudUserId: () => "u_me"
  });

  const result = await ipcMain.handlers.get(IpcChannel.SocialEnsureBotSessionConversation)(
    null,
    "session_new",
    { botId: "codex", runtimeKind: "desktop-local" }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(patches, [
    {
      userId: "u_me",
      patch: {
        conversations: [
          { id: "botc_existing", type: "bot", name: "Existing" },
          conversation
        ]
      }
    },
    {
      userId: "u_me",
      patch: { members: { [conversation.id]: members } }
    }
  ]);
});

test("listing bots preserves cached status badges when older cloud lists omit them", async () => {
  const ipcMain = fakeIpcMain();
  const badge = { kind: "lottie", assetId: "blue-fire", label: "蓝色火焰" };
  const patches = [];
  const fakeCache = {
    getSocialBootstrap: (userId) => userId === "u_me" ? {
      userId,
      bots: [{ id: "mia", key: "mia", name: "Mia", statusBadge: badge }]
    } : null,
    updateSocialBootstrap: (userId, patch) => patches.push({ userId, patch })
  };
  registerSocialIpc({
    ipcMain,
    socialApi: {
      listBots: async () => ({ bots: [{ id: "mia", key: "mia", name: "Mia" }] })
    },
    messageCache: fakeCache,
    getCloudUserId: () => "u_me"
  });

  const result = await ipcMain.handlers.get(IpcChannel.SocialListBots)(null);

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.bots[0].statusBadge, badge);
  assert.deepEqual(patches, [{
    userId: "u_me",
    patch: { bots: [{ id: "mia", key: "mia", name: "Mia", statusBadge: badge }] }
  }]);
});

test("listing bots respects explicit null status badges over cached badges", async () => {
  const ipcMain = fakeIpcMain();
  const badge = { kind: "lottie", assetId: "blue-fire", label: "蓝色火焰" };
  const patches = [];
  const fakeCache = {
    getSocialBootstrap: (userId) => userId === "u_me" ? {
      userId,
      bots: [{ id: "mia", key: "mia", name: "Mia", statusBadge: badge }]
    } : null,
    updateSocialBootstrap: (userId, patch) => patches.push({ userId, patch })
  };
  registerSocialIpc({
    ipcMain,
    socialApi: {
      listBots: async () => ({ bots: [{ id: "mia", key: "mia", name: "Mia", statusBadge: null }] })
    },
    messageCache: fakeCache,
    getCloudUserId: () => "u_me"
  });

  const result = await ipcMain.handlers.get(IpcChannel.SocialListBots)(null);

  assert.equal(result.ok, true);
  assert.equal(result.data.bots[0].statusBadge, null);
  assert.deepEqual(patches, [{
    userId: "u_me",
    patch: { bots: [{ id: "mia", key: "mia", name: "Mia", statusBadge: null }] }
  }]);
});

test("saving a bot identity writes submitted status badge through to the local bootstrap cache", async () => {
  const ipcMain = fakeIpcMain();
  const badge = { kind: "lottie", assetId: "blue-fire", label: "蓝色火焰" };
  const patches = [];
  const fakeCache = {
    getSocialBootstrap: (userId) => userId === "u_me" ? {
      userId,
      bots: [{ id: "mia", key: "mia", name: "Mia" }]
    } : null,
    updateSocialBootstrap: (userId, patch) => patches.push({ userId, patch })
  };
  registerSocialIpc({
    ipcMain,
    socialApi: {
      saveBotIdentity: async () => ({ bot: { id: "mia", key: "mia", name: "Mia" } })
    },
    messageCache: fakeCache,
    getCloudUserId: () => "u_me"
  });

  const result = await ipcMain.handlers.get(IpcChannel.SocialSaveBotIdentity)(
    null,
    "mia",
    { name: "Mia", statusBadge: badge }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.bot.statusBadge, badge);
  assert.deepEqual(patches, [{
    userId: "u_me",
    patch: { bots: [{ id: "mia", key: "mia", name: "Mia", statusBadge: badge }] }
  }]);
});

test("saving a bot identity preserves cached runtime binding fields", async () => {
  const ipcMain = fakeIpcMain();
  const patches = [];
  const runtimeConfig = {
    agentEngine: "codex",
    deviceId: "device-1",
    deviceName: "Office Mac"
  };
  const cachedBot = {
    id: "mia",
    key: "mia",
    name: "Mia",
    runtimeKind: "desktop-local",
    runtimeConfig,
    agentEngine: "codex",
    targetDeviceId: "device-1",
    targetDeviceName: "Office Mac",
    deviceId: "device-1",
    deviceName: "Office Mac",
    runtimeLabel: "Office Mac",
    runtimeStatus: "remote_online"
  };
  const fakeCache = {
    getSocialBootstrap: (userId) => userId === "u_me" ? { userId, bots: [cachedBot] } : null,
    updateSocialBootstrap: (userId, patch) => patches.push({ userId, patch })
  };
  registerSocialIpc({
    ipcMain,
    socialApi: {
      saveBotIdentity: async () => ({
        bot: {
          id: "mia",
          key: "mia",
          name: "Renamed Mia",
          agentEngine: "hermes",
          targetDeviceId: "",
          targetDeviceName: ""
        }
      })
    },
    messageCache: fakeCache,
    getCloudUserId: () => "u_me"
  });

  await ipcMain.handlers.get(IpcChannel.SocialSaveBotIdentity)(null, "mia", { name: "Renamed Mia" });

  assert.equal(patches.length, 1);
  const bot = patches[0].patch.bots[0];
  assert.equal(bot.name, "Renamed Mia");
  assert.equal(bot.agentEngine, "codex");
  assert.equal(bot.targetDeviceId, "device-1");
  assert.equal(bot.targetDeviceName, "Office Mac");
  assert.deepEqual(bot.runtimeConfig, runtimeConfig);
  assert.equal(bot.runtimeStatus, "remote_online");
});

test("saving a bot runtime writes the authoritative binding through to the local bootstrap cache", async () => {
  const ipcMain = fakeIpcMain();
  const patches = [];
  const config = {
    model: "",
    effortLevel: "medium",
    agentEngine: "codex",
    deviceId: "device-1",
    deviceName: "Office Mac"
  };
  const fakeCache = {
    getSocialBootstrap: (userId) => userId === "u_me" ? {
      userId,
      bots: [{
        id: "mia",
        key: "mia",
        name: "Mia",
        runtimeKind: "desktop-local",
        agentEngine: "hermes",
        runtimeStatus: "invalid_config"
      }]
    } : null,
    updateSocialBootstrap: (userId, patch) => patches.push({ userId, patch })
  };
  registerSocialIpc({
    ipcMain,
    socialApi: {
      saveBotRuntime: async () => ({
        binding: {
          botId: "mia",
          runtimeKind: "desktop-local",
          enabled: true,
          config
        }
      })
    },
    messageCache: fakeCache,
    getCloudUserId: () => "u_me"
  });

  await ipcMain.handlers.get(IpcChannel.SocialSaveBotRuntime)(null, "mia", {
    runtimeKind: "desktop-local",
    activate: true,
    targetIntent: { agentEngine: "codex", deviceId: "device-1", deviceName: "Office Mac" }
  });

  assert.equal(patches.length, 1);
  const bot = patches[0].patch.bots[0];
  assert.equal(bot.agentEngine, "codex");
  assert.equal(bot.targetDeviceId, "device-1");
  assert.equal(bot.targetDeviceName, "Office Mac");
  assert.equal(bot.runtimeLabel, "Office Mac");
  assert.deepEqual(bot.runtimeConfig, config);
  assert.equal(Object.hasOwn(bot, "runtimeStatus"), false);
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
