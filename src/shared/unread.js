// Shared unread-count + badge HTML helpers.
//
// Three call sites consume this module with structurally different
// state shapes (see docs/superpowers/plans/2026-05-23-shared-migration.md
// Stage 3):
//
//   1. session-read-state.js — per-persona; walks message lists and
//      compares each assistant message's createdAt against a stored
//      `readAt` ISO timestamp.
//   2. social.js / web/app.js — already track per-conversation counts in
//      a Map<id, number>; the module just needs to read & sum them.
//
// Rather than fork into two modules we accept a polymorphic `readState`:
//   - Map<string, number>           → count is the map value
//   - { readAt: { [key]: iso } }    → count = messages with createdAt > readAt
//   - null / undefined              → fall back to conversation.unreadCount
//
// `unreadBadgeHtml(count, { maxDisplay })` is pure presentation: empty
// string for zero/falsy, otherwise `<span class="unread-badge">N</span>`
// with `99+` (or `${maxDisplay}+`) truncation.

(function attachUnread(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaUnread = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildUnread() {
  function isMap(value) {
    return value && typeof value.get === "function" && typeof value.values === "function";
  }

  function hasReadAt(value) {
    return value && typeof value === "object" && value.readAt && typeof value.readAt === "object";
  }

  function countMessagesAfter(messages, readAtIso) {
    if (!Array.isArray(messages)) return 0;
    const cutoff = String(readAtIso || "");
    let count = 0;
    for (const message of messages) {
      if (!message) continue;
      if (message.role && message.role !== "assistant") continue;
      if (message.transient) continue;
      if (message.role === "assistant" && !String(message.content || "").trim()) continue;
      const createdAt = String(message.createdAt || message.created_at || "");
      if (!createdAt) continue;
      if (createdAt.localeCompare(cutoff) > 0) count += 1;
    }
    return count;
  }

  // conversation can be:
  //   - { id, unreadCount }  (pre-computed)
  //   - { id, messages: [...] }  (compute from readState.readAt[id])
  //   - { key, sessions: [{ messages: [...] }, ...] }  (persona shape)
  function computeUnreadForConversation(conversation, readState) {
    if (!conversation) return 0;
    const id = conversation.id || conversation.key || conversation.roomId || "";

    if (isMap(readState)) {
      const n = readState.get(id);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    if (hasReadAt(readState)) {
      const readAtIso = readState.readAt[id] || "";
      if (Array.isArray(conversation.sessions)) {
        let total = 0;
        for (const session of conversation.sessions) {
          total += countMessagesAfter(session.messages, readAtIso);
        }
        return total;
      }
      return countMessagesAfter(conversation.messages, readAtIso);
    }

    if (Number.isFinite(conversation.unreadCount) && conversation.unreadCount > 0) {
      return conversation.unreadCount;
    }
    return 0;
  }

  function totalUnreadFromConversations(conversations, readState) {
    // Fast path: a Map of pre-computed counts.
    if (isMap(readState) && !conversations) {
      let total = 0;
      for (const n of readState.values()) {
        if (Number.isFinite(n) && n > 0) total += n;
      }
      return total;
    }
    if (!Array.isArray(conversations)) return 0;
    let total = 0;
    for (const conversation of conversations) {
      total += computeUnreadForConversation(conversation, readState);
    }
    return total;
  }

  function unreadBadgeText(count, options) {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) return "";
    const maxDisplay = options && Number.isFinite(options.maxDisplay) ? options.maxDisplay : 99;
    return n > maxDisplay ? `${maxDisplay}+` : String(Math.trunc(n));
  }

  function unreadBadgeHtml(count, options) {
    const text = unreadBadgeText(count, options);
    if (!text) return "";
    return `<span class="unread-badge">${text}</span>`;
  }

  return {
    computeUnreadForConversation,
    totalUnreadFromConversations,
    unreadBadgeHtml,
    unreadBadgeText,
  };
});
