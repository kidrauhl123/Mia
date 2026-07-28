(function initMessageWindow(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.miaMessageWindow = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function messageWindowFactory() {
  "use strict";

  const DEFAULT_MESSAGE_WINDOW_SIZE = 160;

  function normalizedSize(value) {
    const size = Math.floor(Number(value) || DEFAULT_MESSAGE_WINDOW_SIZE);
    return Math.max(1, size);
  }

  function stableMessageId(message) {
    return String(message?.id || message?.seq || message?.created_at || message?.createdAt || "");
  }

  function indexOfMessage(messages, messageId) {
    const target = String(messageId || "");
    if (!target) return -1;
    return messages.findIndex((message) => stableMessageId(message) === target);
  }

  function buildWindow(messages, start, size, mode) {
    const total = messages.length;
    const safeSize = normalizedSize(size);
    const maxStart = Math.max(0, total - safeSize);
    const safeStart = Math.max(0, Math.min(maxStart, Math.floor(Number(start) || 0)));
    const end = Math.min(total, safeStart + safeSize);
    const resolvedMode = mode === "history" && end < total ? "history" : "tail";
    const visibleMessages = messages.slice(safeStart, end);
    return {
      start: safeStart,
      end,
      total,
      size: safeSize,
      mode: resolvedMode,
      hasOlder: safeStart > 0,
      hasNewer: end < total,
      olderCount: safeStart,
      newerCount: Math.max(0, total - end),
      messages: visibleMessages,
      state: {
        mode: resolvedMode,
        start: safeStart,
        anchorId: stableMessageId(visibleMessages[0])
      }
    };
  }

  function resolveMessageWindow(messagesInput, currentState = null, options = {}) {
    const messages = Array.isArray(messagesInput) ? messagesInput : [];
    const size = normalizedSize(options.size);
    const total = messages.length;
    if (total <= size) return buildWindow(messages, 0, size, "tail");

    const focusIndex = indexOfMessage(messages, options.focusId);
    if (focusIndex >= 0) {
      const centeredStart = focusIndex - Math.floor(size / 2);
      return buildWindow(messages, centeredStart, size, "history");
    }

    if (currentState?.mode === "history") {
      const anchorIndex = indexOfMessage(messages, currentState.anchorId);
      const start = anchorIndex >= 0 ? anchorIndex : currentState.start;
      return buildWindow(messages, start, size, "history");
    }

    return buildWindow(messages, Math.max(0, total - size), size, "tail");
  }

  function moveMessageWindow(messagesInput, currentState, direction, options = {}) {
    const messages = Array.isArray(messagesInput) ? messagesInput : [];
    const size = normalizedSize(options.size);
    const current = resolveMessageWindow(messages, currentState, { size });
    if (direction === "latest") {
      return buildWindow(messages, Math.max(0, messages.length - size), size, "tail");
    }
    if (direction === "older") {
      return buildWindow(messages, Math.max(0, current.start - size), size, "history");
    }
    if (direction === "newer") {
      const nextStart = current.start + size;
      const nextMode = nextStart + size >= messages.length ? "tail" : "history";
      return buildWindow(messages, nextStart, size, nextMode);
    }
    return current;
  }

  return {
    DEFAULT_MESSAGE_WINDOW_SIZE,
    resolveMessageWindow,
    moveMessageWindow,
    stableMessageId
  };
});
