"use strict";

(function attachSessionHistory(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaSessionHistory = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildSessionHistory() {
  function conversationType(conversation, conversationId = "") {
    const id = String(conversationId || conversation?.id || "");
    return conversation?.type
      || (id.startsWith("dm:") ? "dm"
        : id.startsWith("fellow:") ? "fellow"
        : (id.startsWith("g_") || id.startsWith("g-")) ? "group"
        : "");
  }

  function fellowKey(conversation) {
    const decorated = conversation?.decorations?.fellowKey || conversation?.fellowKey || conversation?.fellow_id || "";
    if (decorated) return String(decorated);
    const id = String(conversation?.id || "");
    return id.startsWith("fellow:") ? id.split(":").slice(2).join(":") : "";
  }

  function fellowConversationId(ownerUserId, key) {
    const owner = String(ownerUserId || "").trim();
    const fellow = String(key || "").trim();
    if (!owner) throw new Error("fellowConversationId: ownerUserId required");
    if (!fellow) throw new Error("fellowConversationId: fellowKey required");
    return `fellow:${owner}:${fellow}`;
  }

  function runtimeKind(conversation, fallback = "desktop-local") {
    return String(conversation?.decorations?.runtimeKind || "").trim() || fallback;
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

  function findFellow(key, fellows = []) {
    const wanted = String(key || "");
    return (Array.isArray(fellows) ? fellows : [])
      .find((item) => String(item?.key || item?.id || "") === wanted) || null;
  }

  function sessionTitle(conversation, options = {}) {
    if (!conversation) return options.defaultTitle || "新对话";
    const type = conversationType(conversation, conversation.id || "");
    if (type === "fellow") {
      if (conversation.name) return conversation.name;
      const key = fellowKey(conversation);
      const fellow = findFellow(key, options.fellows);
      return fellow?.name || key || options.defaultTitle || "新对话";
    }
    if (type === "group") return conversation.name || options.groupTitle || "群聊";
    if (typeof options.dmTitle === "function") return options.dmTitle(conversation) || options.dmTitleFallback || "私聊";
    return conversation.name || options.dmTitle || options.dmTitleFallback || "私聊";
  }

  function sessionConversationsForConversation(conversation, conversations = [], options = {}) {
    if (!conversation) return [];
    if (conversationType(conversation, conversation.id || "") !== "fellow") return [conversation];
    const key = fellowKey(conversation);
    if (!key) return [conversation];
    // Only surface sessions that actually hold a conversation, plus whichever
    // one is open right now (a freshly created session has no messages yet but
    // must still show while the user is in it). This hides the empty "新对话"
    // drafts — e.g. the ones a failed/retried create left behind — without
    // deleting anything: a session reappears the moment it gets a first message.
    //
    // Emptiness is judged by updated_at === created_at (a first message bumps
    // updated_at) rather than the message cache, because the cache is only
    // pre-warmed for a capped number of conversations — relying on it would
    // wrongly hide real sessions whose messages just weren't fetched yet.
    const activeId = String(options.activeConversationId || "");
    return (Array.isArray(conversations) ? conversations : [])
      .filter((candidate) => conversationType(candidate, candidate?.id || "") === "fellow")
      .filter((candidate) => fellowKey(candidate) === key)
      .filter((candidate) =>
        conversationHasContent(candidate, options.messageCache)
        || String(candidate?.id || "") === activeId)
      .sort((a, b) => compareConversationActivity(a, b, options.messageCache));
  }

  // A session has content if a message bumped its updated_at past created_at,
  // or if the (best-effort) message cache already holds messages for it. Either
  // signal alone is enough — the timestamp check works even when the cache is
  // cold, the cache check covers records whose timestamps somehow match.
  function conversationHasContent(conversation, messageCache) {
    if (hasCachedMessages(conversation, messageCache)) return true;
    if (conversation?.last_activity_at || conversation?.lastActivityAt) return true;
    const created = String(conversation?.created_at || conversation?.createdAt || "").trim();
    const updated = String(conversation?.updated_at || conversation?.updatedAt || "").trim();
    if (!created && !updated) return true;
    return Boolean(created && updated && updated !== created);
  }

  function preferredFellowSidebarConversation(current, candidate, options = {}) {
    if (!current) return candidate;
    const activeConversationId = String(options.activeConversationId || "");
    if (candidate?.id && candidate.id === activeConversationId) return candidate;
    if (current?.id && current.id === activeConversationId) return current;
    const key = fellowKey(candidate) || fellowKey(current);
    const preferredId = preferredConversationIdForFellowKey(options.preferredConversationIdByFellowKey, key);
    if (preferredId) {
      if (candidate?.id && candidate.id === preferredId) return candidate;
      if (current?.id && current.id === preferredId) return current;
    }
    return compareConversationActivity(candidate, current, options.messageCache) < 0
      ? candidate
      : current;
  }

  function preferredConversationIdForFellowKey(preferences, key) {
    const fellow = String(key || "");
    if (!fellow || !preferences) return "";
    if (typeof preferences.get === "function") return String(preferences.get(fellow) || "");
    if (typeof preferences === "object") return String(preferences[fellow] || "");
    return "";
  }

  function sidebarConversations(conversations = [], options = {}) {
    const allConversations = Array.isArray(conversations) ? conversations : [];
    const regularConversations = [];
    const fellowConversationsByKey = new Map();
    for (const conversation of allConversations) {
      if (conversationType(conversation, conversation?.id || "") !== "fellow") {
        regularConversations.push(conversation);
        continue;
      }
      const key = fellowKey(conversation) || String(conversation?.id || "");
      if (!key) continue;
      fellowConversationsByKey.set(key, preferredFellowSidebarConversation(fellowConversationsByKey.get(key), conversation, options));
    }
    return [...regularConversations, ...fellowConversationsByKey.values()];
  }

  function fellowDisplayTitle(conversation, fellows = [], fallback = "对话") {
    const key = fellowKey(conversation);
    const fellow = findFellow(key, fellows);
    return fellow?.name || conversation?.decorations?.fellowName || conversation?.name || key || fallback;
  }

  function conversationListTitle(conversation, fellows = [], fallback = "对话") {
    if (conversationType(conversation, conversation?.id || "") === "fellow") {
      return fellowDisplayTitle(conversation, fellows, fallback);
    }
    return conversation?.name || conversation?.title || conversation?.id || fallback;
  }

  function isUntitledFellowConversation(conversation, options = {}) {
    if (conversationType(conversation, conversation?.id || "") !== "fellow") return false;
    const title = String(conversation?.name || "").trim();
    const defaultTitle = String(options.defaultTitle || "新对话").trim();
    if (!title || (defaultTitle && title === defaultTitle)) return true;
    const key = fellowKey(conversation);
    const fellow = findFellow(key, options.fellows);
    const fellowName = String(fellow?.name || conversation?.decorations?.fellowName || "").trim();
    return Boolean(fellowName && title === fellowName);
  }

  function canCreateSession(conversation) {
    return conversationType(conversation, conversation?.id || "") === "fellow" && Boolean(fellowKey(conversation));
  }

  function createFellowSessionPayload(conversation, sessionId, options = {}) {
    return {
      fellowKey: fellowKey(conversation),
      title: options.title || "新对话",
      runtimeKind: runtimeKind(conversation, options.runtimeKindFallback || "desktop-local"),
      sessionId
    };
  }

  return {
    conversationType,
    fellowKey,
    fellowConversationId,
    runtimeKind,
    conversationSortTime,
    sessionTitle,
    sessionConversationsForConversation,
    sidebarConversations,
    fellowDisplayTitle,
    conversationListTitle,
    isUntitledFellowConversation,
    canCreateSession,
    createFellowSessionPayload
  };
});
