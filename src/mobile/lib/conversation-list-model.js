(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaConversationListModel = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function () {
  function avatarResolver() {
    if (typeof window !== "undefined" && window.miaAvatarResolve) return window.miaAvatarResolve;
    if (typeof require === "function") {
      try { return require("../../shared/avatar-resolve.js"); } catch { /* shared module not loaded */ }
    }
    return null;
  }

  function activityTime(c) {
    const t = c.last_activity_at || c.updated_at || c.created_at || "";
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : 0;
  }

  function fallbackAvatar(title, id) {
    const resolver = avatarResolver();
    if (resolver && typeof resolver.resolveAvatarForContact === "function") {
      return resolver.resolveAvatarForContact({
        id: id || title,
        displayName: title || id,
        avatarImage: "",
        avatarCrop: null
      });
    }
    const text = String(title || id || "?").trim().slice(0, 2) || "?";
    return { image: "", crop: null, color: "#5e5ce6", text };
  }

  // deps: { conversations: [], unreadByConversation: { [id]: n } }
  function buildConversationListItems(deps) {
    const convs = Array.isArray(deps.conversations) ? deps.conversations.slice() : [];
    const unread = deps.unreadByConversation || {};
    convs.sort((a, b) => activityTime(b) - activityTime(a));
    return convs.map((c) => {
      const title = c.name || c.title || c.id;
      return {
        id: c.id,
        title,
        subtitle: String(c.last_message_text || ""),
        unread: Number(unread[c.id]) || 0,
        avatar: c.identity?.avatar || fallbackAvatar(title, c.id),
        raw: c
      };
    });
  }
  return { buildConversationListItems };
});
