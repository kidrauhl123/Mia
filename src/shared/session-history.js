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

  function runtimeKind(conversation, fallback = "desktop-local") {
    return String(conversation?.decorations?.runtimeKind || "").trim() || fallback;
  }

  function conversationSortTime(conversation, messageCache) {
    const cache = messageCache?.get?.(conversation?.id);
    const last = cache?.messages?.[cache.messages.length - 1];
    return new Date(
      last?.created_at
      || last?.createdAt
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
    return (Array.isArray(conversations) ? conversations : [])
      .filter((candidate) => conversationType(candidate, candidate?.id || "") === "fellow")
      .filter((candidate) => fellowKey(candidate) === key)
      .sort((a, b) => compareConversationActivity(a, b, options.messageCache));
  }

  function preferredFellowSidebarConversation(current, candidate, options = {}) {
    if (!current) return candidate;
    const activeConversationId = String(options.activeConversationId || "");
    if (candidate?.id && candidate.id === activeConversationId) return candidate;
    if (current?.id && current.id === activeConversationId) return current;
    return compareConversationActivity(candidate, current, options.messageCache) < 0
      ? candidate
      : current;
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
    return fellow?.name || conversation?.decorations?.fellowName || key || fallback;
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
    runtimeKind,
    conversationSortTime,
    sessionTitle,
    sessionConversationsForConversation,
    sidebarConversations,
    fellowDisplayTitle,
    isUntitledFellowConversation,
    canCreateSession,
    createFellowSessionPayload
  };
});
