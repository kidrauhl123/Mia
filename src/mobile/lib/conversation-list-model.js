(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaConversationListModel = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function () {
  function activityTime(c) {
    const t = c.last_activity_at || c.updated_at || c.created_at || "";
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : 0;
  }
  // deps: { conversations: [], unreadByConversation: { [id]: n } }
  function buildConversationListItems(deps) {
    const convs = Array.isArray(deps.conversations) ? deps.conversations.slice() : [];
    const unread = deps.unreadByConversation || {};
    convs.sort((a, b) => activityTime(b) - activityTime(a));
    return convs.map((c) => ({
      id: c.id,
      title: c.name || c.title || c.id,
      subtitle: String(c.last_message_text || ""),
      unread: Number(unread[c.id]) || 0,
      raw: c
    }));
  }
  return { buildConversationListItems };
});
