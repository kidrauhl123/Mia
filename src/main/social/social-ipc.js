const { IpcChannel } = require("../../shared/ipc-channels");

function safeCall(fn) {
  return async (_event, ...args) => {
    try {
      const data = await fn(...args);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: String(error?.message || error), status: error?.status || 500 };
    }
  };
}

function resultArray(result, key) {
  const direct = result && result[key];
  if (Array.isArray(direct)) return direct;
  const nested = result?.data && result.data[key];
  return Array.isArray(nested) ? nested : [];
}

function resultObject(result, key) {
  const direct = result && result[key];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  const nested = result?.data && result.data[key];
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested : null;
}

function currentCacheUserId(getCloudUserId) {
  try {
    return String((typeof getCloudUserId === "function" && getCloudUserId()) || "").trim();
  } catch {
    return "";
  }
}

function writeSocialBootstrapPatch({ messageCache, getCloudUserId, patch, log }) {
  const userId = currentCacheUserId(getCloudUserId);
  if (!userId || !messageCache || typeof messageCache.updateSocialBootstrap !== "function") return;
  try {
    messageCache.updateSocialBootstrap(userId, patch);
  } catch (error) {
    log(`[social-ipc] social bootstrap cache update failed: ${error?.message || error}`);
  }
}

function writeSocialConversationPatch({ messageCache, getCloudUserId, conversation, log }) {
  const userId = currentCacheUserId(getCloudUserId);
  if (!userId || !conversation?.id || !messageCache || typeof messageCache.updateSocialBootstrap !== "function") return;
  try {
    const current = typeof messageCache.getSocialBootstrap === "function" ? messageCache.getSocialBootstrap(userId) : null;
    const conversations = Array.isArray(current?.conversations) ? current.conversations : [];
    const idx = conversations.findIndex((item) => item?.id === conversation.id);
    const next = idx >= 0
      ? conversations.map((item, index) => (index === idx ? { ...item, ...conversation } : item))
      : [...conversations, conversation];
    messageCache.updateSocialBootstrap(userId, { conversations: next });
  } catch (error) {
    log(`[social-ipc] social conversation cache update failed: ${error?.message || error}`);
  }
}

function cachedSocialBootstrap({ messageCache, getCloudUserId, requestedUserId }) {
  if (!messageCache || typeof messageCache.getSocialBootstrap !== "function") return null;
  const currentUserId = currentCacheUserId(getCloudUserId);
  const requested = String(requestedUserId || "").trim();
  if (currentUserId && requested && currentUserId !== requested) return null;
  const userId = currentUserId || requested;
  if (!userId) return null;
  return messageCache.getSocialBootstrap(userId);
}

function registerSocialIpc({ ipcMain, socialApi, messageCache = null, getCloudUserId = null, log = () => {} }) {
  ipcMain.handle(IpcChannel.SocialSendFriendRequest, safeCall((toUsername) => socialApi.sendFriendRequest(toUsername)));
  ipcMain.handle(IpcChannel.SocialRespondFriendRequest, safeCall((requestId, action) => socialApi.respondFriendRequest(requestId, action)));
  ipcMain.handle(IpcChannel.SocialCancelFriendRequest, safeCall((requestId) => socialApi.cancelFriendRequest(requestId)));
  ipcMain.handle(IpcChannel.SocialListFriendRequests, safeCall((direction) => socialApi.listFriendRequests(direction)));
  ipcMain.handle(IpcChannel.SocialListFriends, safeCall(async () => {
    const result = await socialApi.listFriends();
    writeSocialBootstrapPatch({ messageCache, getCloudUserId, patch: { friends: resultArray(result, "friends") }, log });
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialRemoveFriend, safeCall((userId) => socialApi.removeFriend(userId)));
  ipcMain.handle(IpcChannel.SocialListConversations, safeCall(async () => {
    const result = await socialApi.listConversations();
    writeSocialBootstrapPatch({ messageCache, getCloudUserId, patch: { conversations: resultArray(result, "conversations") }, log });
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialListBots, safeCall(async () => {
    const result = await socialApi.listBots();
    writeSocialBootstrapPatch({ messageCache, getCloudUserId, patch: { bots: resultArray(result, "bots") }, log });
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialSaveBotIdentity, safeCall((botId, body) => socialApi.saveBotIdentity(botId, body)));
  ipcMain.handle(IpcChannel.SocialDeleteBot, safeCall((botId) => socialApi.deleteBot(botId)));
  ipcMain.handle(IpcChannel.SocialListPlatformModels, safeCall(() => socialApi.listPlatformModels()));
  ipcMain.handle(IpcChannel.SocialGetConversation, safeCall(async (conversationId) => {
    const result = await socialApi.getConversation(conversationId);
    const members = resultArray(result, "members");
    if (conversationId && members.length) {
      writeSocialBootstrapPatch({ messageCache, getCloudUserId, patch: { members: { [conversationId]: members } }, log });
    }
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialListConversationMessages, safeCall(async (conversationId, sinceSeq, limit) => {
    const result = await socialApi.listConversationMessages(conversationId, sinceSeq, limit);
    // Write-through to the local cache so the next cold start renders instantly
    // and subsequent fetches can be incremental (since_seq = cached max seq).
    if (messageCache && Array.isArray(result?.messages) && result.messages.length) {
      try { messageCache.upsertMessages(conversationId, result.messages); }
      catch (error) { log(`[social-ipc] message cache upsert failed: ${error?.message || error}`); }
    }
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialGetCachedMessages, safeCall((conversationId, limit) => {
    if (!messageCache) return { messages: [] };
    return { messages: messageCache.getRecentMessages(conversationId, limit) };
  }));
  ipcMain.handle(IpcChannel.SocialGetCachedBootstrap, safeCall((userId) => (
    cachedSocialBootstrap({ messageCache, getCloudUserId, requestedUserId: userId })
  )));
  ipcMain.handle(IpcChannel.SocialPostConversationMessage, safeCall((conversationId, body) => socialApi.postConversationMessage(conversationId, body)));
  ipcMain.handle(IpcChannel.SocialDeleteConversationMessage, safeCall((conversationId, messageId) => socialApi.deleteConversationMessage(conversationId, messageId)));
  ipcMain.handle(IpcChannel.SocialCreateConversation, safeCall((payload) => socialApi.createConversation(payload)));
  ipcMain.handle(IpcChannel.SocialEnsureBotConversation, safeCall((botId, body) => socialApi.ensureBotConversation(botId, body)));
  ipcMain.handle(IpcChannel.SocialEnsureBotSessionConversation, safeCall((sessionId, body) => socialApi.ensureBotSessionConversation(sessionId, body)));
  ipcMain.handle(IpcChannel.SocialGetBotRuntime, safeCall((botId, runtimeKind) => socialApi.getBotRuntime(botId, runtimeKind)));
  ipcMain.handle(IpcChannel.SocialSaveBotRuntime, safeCall((botId, body) => socialApi.saveBotRuntime(botId, body)));
  ipcMain.handle(IpcChannel.SocialUpdateConversation, safeCall(async (conversationId, patch) => {
    const result = await socialApi.updateConversation(conversationId, patch);
    const conversation = resultObject(result, "conversation");
    writeSocialConversationPatch({ messageCache, getCloudUserId, conversation, log });
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialDeleteConversation, safeCall(async (conversationId) => {
    const result = await socialApi.deleteConversation(conversationId);
    if (messageCache) {
      try { messageCache.deleteConversation(conversationId); }
      catch (error) { log(`[social-ipc] message cache delete failed: ${error?.message || error}`); }
    }
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialAddConversationMember, safeCall((conversationId, member) => socialApi.addConversationMember(conversationId, member)));
  ipcMain.handle(IpcChannel.SocialRemoveConversationMember, safeCall((conversationId, member) => socialApi.removeConversationMember(conversationId, member)));
}

module.exports = { registerSocialIpc };
