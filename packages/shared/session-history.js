"use strict";

(function attachSessionHistory(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaSessionHistory = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildSessionHistory() {
  function normalizeRuntimeKind(value, fallback = "desktop-local") {
    const raw = String(value || fallback || "").trim();
    if (!raw) return fallback;
    const normalized = raw.toLowerCase().replace(/_/g, "-");
    if (normalized === "cloud-claude-code" || normalized === "mia-cloud" || normalized === "miacloud") {
      return "cloud-claude-code";
    }
    if (normalized === "desktop-local") return "desktop-local";
    return raw;
  }

  function conversationType(conversation, conversationId = "") {
    const id = String(conversationId || conversation?.id || "");
    return conversation?.type
      || (conversation?.kind === "bot_session" || conversation?.botId || conversation?.bot_id ? "bot"
        : id.startsWith("dm:") ? "dm"
        : id.startsWith("botc_") ? "bot"
        : (id.startsWith("g_") || id.startsWith("g-")) ? "group"
        : "");
  }

  function botId(conversation) {
    return String(conversation?.decorations?.botId || conversation?.botId || conversation?.bot_id || "");
  }

  function runtimeKind(conversation, fallback = "desktop-local") {
    return normalizeRuntimeKind(
      conversation?.decorations?.runtimeKind
      || conversation?.decorations?.runtime_kind
      || conversation?.runtimeKind
      || conversation?.runtime_kind
      || conversation?.runtimeConfig?.runtimeKind
      || conversation?.runtimeConfig?.runtime_kind
      || conversation?.runtime_config?.runtimeKind
      || conversation?.runtime_config?.runtime_kind
      || "",
      fallback
    );
  }

  function conversationSortTime(conversation, messageCache) {
    const cache = messageCache?.get?.(conversation?.id);
    const last = cache?.messages?.[cache.messages.length - 1];
    return new Date(
      last?.created_at
      || last?.createdAt
      || conversation?.last_activity_at
      || conversation?.lastActivityAt
      || conversation?.updated_at
      || conversation?.updatedAt
      || conversation?.created_at
      || conversation?.createdAt
      || 0
    ).getTime() || 0;
  }

  function hasCachedMessages(conversation, messageCache) {
    const cache = messageCache?.get?.(conversation?.id);
    return Array.isArray(cache?.messages) && cache.messages.length > 0;
  }

  function compareConversationActivity(a, b, messageCache) {
    const aHasMessages = hasCachedMessages(a, messageCache);
    const bHasMessages = hasCachedMessages(b, messageCache);
    if (aHasMessages !== bHasMessages) return bHasMessages ? 1 : -1;
    return conversationSortTime(b, messageCache) - conversationSortTime(a, messageCache);
  }

  function findBot(id, bots = []) {
    const wanted = String(id || "");
    return (Array.isArray(bots) ? bots : [])
      .find((item) => String(item?.id || item?.botId || item?.bot_id || "") === wanted) || null;
  }

  function botName(bot) {
    return bot?.displayName || bot?.display_name || bot?.name || "";
  }

  function sessionTitle(conversation, options = {}) {
    if (!conversation) return options.defaultTitle || "新对话";
    const type = conversationType(conversation, conversation.id || "");
    if (type === "bot") {
      if (conversation.name || conversation.title) return conversation.name || conversation.title;
      const id = botId(conversation);
      const bot = findBot(id, options.bots);
      return botName(bot) || id || options.defaultTitle || "新对话";
    }
    if (type === "group") return conversation.name || options.groupTitle || "群聊";
    if (typeof options.dmTitle === "function") return options.dmTitle(conversation) || options.dmTitleFallback || "私聊";
    return conversation.name || options.dmTitle || options.dmTitleFallback || "私聊";
  }

  function sessionConversationsForConversation(conversation, conversations = [], options = {}) {
    if (!conversation) return [];
    if (conversationType(conversation, conversation.id || "") !== "bot") return [conversation];
    const id = botId(conversation);
    if (!id) return [conversation];
    const activeId = String(options.activeConversationId || "");
    return (Array.isArray(conversations) ? conversations : [])
      .filter((candidate) => conversationType(candidate, candidate?.id || "") === "bot")
      .filter((candidate) => botId(candidate) === id)
      .filter((candidate) =>
        conversationHasContent(candidate, options.messageCache)
        || String(candidate?.id || "") === activeId)
      .sort((a, b) => compareConversationActivity(a, b, options.messageCache));
  }

  function conversationHasContent(conversation, messageCache) {
    if (hasCachedMessages(conversation, messageCache)) return true;
    if (conversation?.last_activity_at || conversation?.lastActivityAt) return true;
    const created = String(conversation?.created_at || conversation?.createdAt || "").trim();
    const updated = String(conversation?.updated_at || conversation?.updatedAt || "").trim();
    if (!created && !updated) return true;
    return Boolean(created && updated && updated !== created);
  }

  function preferredBotSidebarConversation(current, candidate, options = {}) {
    if (!current) return candidate;
    const activeConversationId = String(options.activeConversationId || "");
    if (candidate?.id && candidate.id === activeConversationId) return candidate;
    if (current?.id && current.id === activeConversationId) return current;
    const id = botId(candidate) || botId(current);
    const preferredId = preferredConversationIdForBotId(options.preferredConversationIdByBotId, id);
    if (preferredId) {
      if (candidate?.id && candidate.id === preferredId) return candidate;
      if (current?.id && current.id === preferredId) return current;
    }
    return compareConversationActivity(candidate, current, options.messageCache) < 0
      ? candidate
      : current;
  }

  function preferredConversationIdForBotId(preferences, id) {
    const bot = String(id || "");
    if (!bot || !preferences) return "";
    if (typeof preferences.get === "function") return String(preferences.get(bot) || "");
    if (typeof preferences === "object") return String(preferences[bot] || "");
    return "";
  }

  function sidebarConversations(conversations = [], options = {}) {
    const allConversations = Array.isArray(conversations) ? conversations : [];
    const regularConversations = [];
    const botConversationsById = new Map();
    for (const conversation of allConversations) {
      if (conversationType(conversation, conversation?.id || "") !== "bot") {
        regularConversations.push(conversation);
        continue;
      }
      const id = botId(conversation) || String(conversation?.id || "");
      if (!id) continue;
      botConversationsById.set(id, preferredBotSidebarConversation(botConversationsById.get(id), conversation, options));
    }
    return [...regularConversations, ...botConversationsById.values()];
  }

  function botDisplayTitle(conversation, bots = [], fallback = "对话") {
    const id = botId(conversation);
    const bot = findBot(id, bots);
    return botName(bot) || conversation?.decorations?.botName || conversation?.name || conversation?.title || id || fallback;
  }

  function conversationListTitle(conversation, bots = [], fallback = "对话") {
    if (conversationType(conversation, conversation?.id || "") === "bot") {
      return botDisplayTitle(conversation, bots, fallback);
    }
    return conversation?.name || conversation?.title || conversation?.id || fallback;
  }

  function isUntitledBotConversation(conversation, options = {}) {
    if (conversationType(conversation, conversation?.id || "") !== "bot") return false;
    const title = String(conversation?.name || "").trim();
    const defaultTitle = String(options.defaultTitle || "新对话").trim();
    if (!title || (defaultTitle && title === defaultTitle)) return true;
    const id = botId(conversation);
    const bot = findBot(id, options.bots);
    const displayName = String(botName(bot) || conversation?.decorations?.botName || "").trim();
    return Boolean(displayName && title === displayName);
  }

  function canCreateSession(conversation) {
    return conversationType(conversation, conversation?.id || "") === "bot" && Boolean(botId(conversation));
  }

  function createBotSessionPayload(conversation, sessionId, options = {}) {
    return {
      botId: botId(conversation),
      title: options.title || "新对话",
      runtimeKind: runtimeKind(conversation, options.runtimeKindFallback || "desktop-local"),
      sessionId
    };
  }

  return {
    conversationType,
    botId,
    normalizeRuntimeKind,
    runtimeKind,
    conversationSortTime,
    sessionTitle,
    sessionConversationsForConversation,
    sidebarConversations,
    botDisplayTitle,
    conversationListTitle,
    isUntitledBotConversation,
    canCreateSession,
    createBotSessionPayload
  };
});
