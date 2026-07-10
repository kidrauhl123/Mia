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

function runtimeCall(ensureRuntimeAvailable, fn) {
  return safeCall(async (...args) => {
    if (typeof ensureRuntimeAvailable === "function") await ensureRuntimeAvailable();
    return fn(...args);
  });
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

function replaceResultArray(result, key, value) {
  if (result?.data && Array.isArray(result.data[key])) return { ...result, data: { ...result.data, [key]: value } };
  if (result && Array.isArray(result[key])) return { ...result, [key]: value };
  return result;
}

function replaceResultObject(result, key, value) {
  if (result?.data && result.data[key] && typeof result.data[key] === "object" && !Array.isArray(result.data[key])) {
    return { ...result, data: { ...result.data, [key]: value } };
  }
  if (result && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) return { ...result, [key]: value };
  return result;
}

function currentCacheUserId(getCloudUserId) {
  try {
    return String((typeof getCloudUserId === "function" && getCloudUserId()) || "").trim();
  } catch {
    return "";
  }
}

function hasOwn(source, key) {
  return source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, key);
}

function parseJsonObject(value, fallback = null) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function botIdentityKey(bot = {}) {
  return String(bot?.key || bot?.id || bot?.botId || bot?.bot_id || "").trim();
}

function hasStatusBadgeField(bot = {}) {
  return hasOwn(bot, "statusBadge") || hasOwn(bot, "status_badge") || hasOwn(bot, "status_badge_json");
}

function statusBadgeValue(bot = {}) {
  if (hasOwn(bot, "statusBadge")) return bot.statusBadge || null;
  if (hasOwn(bot, "status_badge")) return bot.status_badge || null;
  if (hasOwn(bot, "status_badge_json")) return parseJsonObject(bot.status_badge_json, null);
  return undefined;
}

function botWithCanonicalStatusBadge(bot = {}, fallback = null) {
  if (!bot || typeof bot !== "object") return bot;
  if (hasStatusBadgeField(bot)) return { ...bot, statusBadge: statusBadgeValue(bot) };
  if (hasStatusBadgeField(fallback)) return { ...bot, statusBadge: statusBadgeValue(fallback) };
  return bot;
}

const BOT_RUNTIME_CACHE_FIELDS = [
  "runtimeKind",
  "runtimeConfig",
  "runtime_config",
  "agentEngine",
  "agent_engine",
  "targetDeviceId",
  "target_device_id",
  "targetDeviceName",
  "target_device_name",
  "deviceId",
  "device_id",
  "deviceName",
  "device_name",
  "runtimeLabel",
  "runtime_label",
  "runtimeStatus",
  "runtime_status",
  "deviceStatus",
  "device_status"
];

function botIdentityWithCachedRuntime(bot = {}, cached = null) {
  const merged = { ...bot };
  for (const field of BOT_RUNTIME_CACHE_FIELDS) {
    if (hasOwn(cached, field)) merged[field] = cached[field];
  }
  return merged;
}

function botWithRuntimeBinding(bot = {}, binding = {}) {
  const config = binding.config && typeof binding.config === "object" ? binding.config : {};
  const runtimeKind = String(binding.runtimeKind || binding.runtime_kind || "desktop-local").trim() || "desktop-local";
  const isCloud = runtimeKind === "cloud-claude-code";
  const agentEngine = String(config.agentEngine || config.agent_engine || binding.agentEngine || binding.agent_engine || "").trim();
  const deviceId = isCloud
    ? ""
    : String(config.deviceId || config.device_id || config.targetDeviceId || binding.targetDeviceId || "").trim();
  const deviceName = isCloud
    ? "Mia Cloud"
    : String(config.deviceName || config.device_name || binding.targetDeviceName || "").trim();
  const {
    runtimeStatus: _runtimeStatus,
    runtime_status: _runtime_status,
    deviceStatus: _deviceStatus,
    device_status: _device_status,
    ...identity
  } = bot;
  return {
    ...identity,
    runtimeKind,
    runtimeConfig: config,
    agentEngine,
    targetDeviceId: deviceId,
    targetDeviceName: deviceName,
    deviceId,
    deviceName,
    runtimeLabel: isCloud ? "Mia Cloud" : (deviceName || "当前设备")
  };
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

function mergeBotsWithCachedStatusBadges({ messageCache, getCloudUserId, bots, log }) {
  const list = Array.isArray(bots) ? bots : [];
  const userId = currentCacheUserId(getCloudUserId);
  if (!userId || !messageCache || typeof messageCache.getSocialBootstrap !== "function") {
    return list.map((bot) => botWithCanonicalStatusBadge(bot));
  }
  try {
    const current = messageCache.getSocialBootstrap(userId);
    const cachedBots = Array.isArray(current?.bots) ? current.bots : [];
    const cachedByKey = new Map(cachedBots.map((bot) => [botIdentityKey(bot), bot]).filter(([key]) => key));
    return list.map((bot) => botWithCanonicalStatusBadge(bot, cachedByKey.get(botIdentityKey(bot))));
  } catch (error) {
    log(`[social-ipc] social bootstrap bot merge failed: ${error?.message || error}`);
    return list.map((bot) => botWithCanonicalStatusBadge(bot));
  }
}

function writeCachedBotIdentity({ messageCache, getCloudUserId, bot, log }) {
  const userId = currentCacheUserId(getCloudUserId);
  const key = botIdentityKey(bot);
  if (!userId || !key || !messageCache || typeof messageCache.updateSocialBootstrap !== "function") return;
  try {
    const current = typeof messageCache.getSocialBootstrap === "function" ? messageCache.getSocialBootstrap(userId) : null;
    const bots = Array.isArray(current?.bots) ? current.bots : [];
    const existing = bots.find((item) => botIdentityKey(item) === key) || null;
    const merged = botIdentityWithCachedRuntime(botWithCanonicalStatusBadge(bot, existing), existing);
    const next = [
      merged,
      ...bots.filter((item) => botIdentityKey(item) !== key)
    ];
    messageCache.updateSocialBootstrap(userId, { bots: next });
  } catch (error) {
    log(`[social-ipc] social bootstrap bot cache update failed: ${error?.message || error}`);
  }
}

function writeCachedBotRuntimeBinding({ messageCache, getCloudUserId, botId, binding, log }) {
  const userId = currentCacheUserId(getCloudUserId);
  const key = String(botId || binding?.botId || binding?.bot_id || "").trim();
  if (!userId || !key || !binding || binding.enabled === false || !messageCache || typeof messageCache.updateSocialBootstrap !== "function") return;
  try {
    const current = typeof messageCache.getSocialBootstrap === "function" ? messageCache.getSocialBootstrap(userId) : null;
    const bots = Array.isArray(current?.bots) ? current.bots : [];
    const existing = bots.find((item) => botIdentityKey(item) === key) || { id: key, key };
    const next = [
      botWithRuntimeBinding(existing, binding),
      ...bots.filter((item) => botIdentityKey(item) !== key)
    ];
    messageCache.updateSocialBootstrap(userId, { bots: next });
  } catch (error) {
    log(`[social-ipc] social bootstrap bot runtime cache update failed: ${error?.message || error}`);
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

function cacheLiveConversationMessageEvent({ messageCache, envelope, log = () => {} } = {}) {
  if (!messageCache || typeof messageCache.upsertMessages !== "function") return false;
  const type = String(envelope?.type || envelope?.name || envelope?.payload?.type || envelope?.data?.type || "").trim();
  if (type !== "conversation.message_appended") return false;
  const payload = envelope?.payload && typeof envelope.payload === "object"
    ? envelope.payload
    : (envelope?.data && typeof envelope.data === "object" ? envelope.data : envelope);
  const conversationId = String(payload?.conversationId || payload?.conversation_id || "").trim();
  const message = payload?.message;
  if (!conversationId || !message || typeof message !== "object") return false;
  try {
    messageCache.upsertMessages(conversationId, [message]);
    return true;
  } catch (error) {
    log(`[social-ipc] live message cache upsert failed: ${error?.message || error}`);
    return false;
  }
}

function registerSocialIpc({ ipcMain, socialApi, messageCache = null, getCloudUserId = null, ensureRuntimeAvailable = null, log = () => {} }) {
  const cloudCall = (fn) => runtimeCall(ensureRuntimeAvailable, fn);

  ipcMain.handle(IpcChannel.SocialSendFriendRequest, cloudCall((toUserId) => socialApi.sendFriendRequest(toUserId)));
  ipcMain.handle(IpcChannel.SocialRespondFriendRequest, cloudCall((requestId, action) => socialApi.respondFriendRequest(requestId, action)));
  ipcMain.handle(IpcChannel.SocialCancelFriendRequest, cloudCall((requestId) => socialApi.cancelFriendRequest(requestId)));
  ipcMain.handle(IpcChannel.SocialListFriendRequests, cloudCall((direction) => socialApi.listFriendRequests(direction)));
  ipcMain.handle(IpcChannel.SocialListFriends, cloudCall(async () => {
    const result = await socialApi.listFriends();
    writeSocialBootstrapPatch({ messageCache, getCloudUserId, patch: { friends: resultArray(result, "friends") }, log });
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialRemoveFriend, cloudCall((userId) => socialApi.removeFriend(userId)));
  ipcMain.handle(IpcChannel.SocialListConversations, cloudCall(async () => {
    const result = await socialApi.listConversations();
    writeSocialBootstrapPatch({ messageCache, getCloudUserId, patch: { conversations: resultArray(result, "conversations") }, log });
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialListBots, cloudCall(async () => {
    const result = await socialApi.listBots();
    const bots = mergeBotsWithCachedStatusBadges({ messageCache, getCloudUserId, bots: resultArray(result, "bots"), log });
    writeSocialBootstrapPatch({ messageCache, getCloudUserId, patch: { bots }, log });
    return replaceResultArray(result, "bots", bots);
  }));
  ipcMain.handle(IpcChannel.SocialSaveBotIdentity, cloudCall(async (botId, body = {}) => {
    const result = await socialApi.saveBotIdentity(botId, body);
    const fallback = { ...(body || {}), id: botId, key: botId };
    const saved = resultObject(result, "bot") || fallback;
    const bot = botWithCanonicalStatusBadge(saved, fallback);
    writeCachedBotIdentity({ messageCache, getCloudUserId, bot, log });
    return replaceResultObject(result, "bot", bot);
  }));
  ipcMain.handle(IpcChannel.SocialGetBotIdentity, cloudCall((botId) => socialApi.getBotIdentity(botId)));
  ipcMain.handle(IpcChannel.SocialDeleteBot, cloudCall((botId) => socialApi.deleteBot(botId)));
  ipcMain.handle(IpcChannel.SocialListPlatformModels, cloudCall(() => socialApi.listPlatformModels()));
  ipcMain.handle(IpcChannel.SocialGetConversation, cloudCall(async (conversationId) => {
    const result = await socialApi.getConversation(conversationId);
    const members = resultArray(result, "members");
    if (conversationId && members.length) {
      writeSocialBootstrapPatch({ messageCache, getCloudUserId, patch: { members: { [conversationId]: members } }, log });
    }
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialListConversationMessages, cloudCall(async (conversationId, sinceSeq, limit) => {
    const result = await socialApi.listConversationMessages(conversationId, sinceSeq, limit);
    // Write-through to the local cache so the next cold start renders instantly
    // and subsequent fetches can be incremental (since_seq = cached max seq).
    if (messageCache && Array.isArray(result?.messages)) {
      try {
        if (typeof messageCache.reconcileFetchedMessages === "function") {
          messageCache.reconcileFetchedMessages(conversationId, sinceSeq, result.messages, limit);
        }
        if (result.messages.length) messageCache.upsertMessages(conversationId, result.messages);
      }
      catch (error) { log(`[social-ipc] message cache upsert failed: ${error?.message || error}`); }
    }
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialSearchConversationMessages, cloudCall(async (query, limit) => {
    const result = await socialApi.searchConversationMessages(query, limit);
    const results = resultArray(result, "results");
    if (messageCache && results.length) {
      for (const item of results) {
        const conversationId = item?.conversation?.id || item?.message?.conversation_id;
        if (!conversationId || !item?.message) continue;
        try { messageCache.upsertMessages(conversationId, [item.message]); }
        catch (error) { log(`[social-ipc] search message cache upsert failed: ${error?.message || error}`); }
      }
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
  // User-authored message writes are not runtime ownership: the daemon owns bot
  // execution and event sockets, but the foreground must still be able to POST
  // the user's message so it can be persisted and later picked up by the daemon.
  ipcMain.handle(IpcChannel.SocialPostConversationMessage, safeCall((conversationId, body) => socialApi.postConversationMessage(conversationId, body)));
  ipcMain.handle(IpcChannel.SocialRespondRunApproval, cloudCall((conversationId, runId, decision) => (
    socialApi.respondRunApproval(conversationId, runId, decision)
  )));
  ipcMain.handle(IpcChannel.SocialDeleteConversationMessage, cloudCall(async (conversationId, messageId) => {
    const result = await socialApi.deleteConversationMessage(conversationId, messageId);
    if (messageCache && typeof messageCache.deleteMessage === "function") {
      try { messageCache.deleteMessage(conversationId, messageId); }
      catch (error) { log(`[social-ipc] message cache delete failed: ${error?.message || error}`); }
    }
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialCreateConversation, cloudCall((payload) => socialApi.createConversation(payload)));
  ipcMain.handle(IpcChannel.SocialEnsureBotConversation, cloudCall((botId, body) => socialApi.ensureBotConversation(botId, body)));
  ipcMain.handle(IpcChannel.SocialEnsureBotSessionConversation, cloudCall((sessionId, body) => socialApi.ensureBotSessionConversation(sessionId, body)));
  ipcMain.handle(IpcChannel.SocialGetBotRuntime, cloudCall((botId, runtimeKind) => socialApi.getBotRuntime(botId, runtimeKind)));
  ipcMain.handle(IpcChannel.SocialSaveBotRuntime, cloudCall(async (botId, body) => {
    const result = await socialApi.saveBotRuntime(botId, body);
    writeCachedBotRuntimeBinding({
      messageCache,
      getCloudUserId,
      botId,
      binding: resultObject(result, "binding"),
      log
    });
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialListBridgeDevices, cloudCall((options) => socialApi.listBridgeDevices(options)));
  ipcMain.handle(IpcChannel.SocialUpdateConversation, cloudCall(async (conversationId, patch) => {
    const result = await socialApi.updateConversation(conversationId, patch);
    const conversation = resultObject(result, "conversation");
    writeSocialConversationPatch({ messageCache, getCloudUserId, conversation, log });
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialDeleteConversation, cloudCall(async (conversationId) => {
    const result = await socialApi.deleteConversation(conversationId);
    if (messageCache) {
      try { messageCache.deleteConversation(conversationId); }
      catch (error) { log(`[social-ipc] message cache delete failed: ${error?.message || error}`); }
    }
    return result;
  }));
  ipcMain.handle(IpcChannel.SocialAddConversationMember, cloudCall((conversationId, member) => socialApi.addConversationMember(conversationId, member)));
  ipcMain.handle(IpcChannel.SocialRemoveConversationMember, cloudCall((conversationId, member) => socialApi.removeConversationMember(conversationId, member)));
}

module.exports = { cacheLiveConversationMessageEvent, registerSocialIpc };
