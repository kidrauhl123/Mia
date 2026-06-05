(function (global) {
  "use strict";

  function timeFormat() {
    return global.miaTimeFormat || require("../shared/time-format");
  }

  function escapeHtml(value) {
    const h = global.miaMarkdown?.escapeHtml;
    if (typeof h === "function") return h(value);
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  }
  function renderMd(md) {
    const fn = global.miaMarkdown?.renderMarkdown;
    if (typeof fn === "function") { try { return fn(md); } catch { /* fall */ } }
    return escapeHtml(md);
  }
  function shortTime(value) {
    if (!value) return "";
    return timeFormat().formatMessageTime(value);
  }
  function nameWithBadgeRenderer() {
    const renderer = global.miaNameWithBadge?.renderNameWithBadge;
    return typeof renderer === "function" ? renderer : null;
  }
  function authorDisplayName(spec) {
    return spec.authorName || spec.authorIdentity?.displayName || "";
  }
  function appendSenderTitle(bubble, spec, accentColor) {
    const fallbackName = authorDisplayName(spec);
    const sender = document.createElement("span");
    sender.className = "bubble-sender";
    if (accentColor) sender.style.color = accentColor;

    const renderName = nameWithBadgeRenderer();
    if (renderName) {
      try {
        const nameEl = renderName({
          identity: spec.authorIdentity,
          fallbackName,
          statusBadge: spec.statusBadge
        });
        if (nameEl) {
          sender.appendChild(nameEl);
          bubble.appendChild(sender);
          return;
        }
      } catch {
        // Keep message rendering resilient if an optional badge payload is bad.
      }
    }

    sender.textContent = fallbackName;
    bubble.appendChild(sender);
  }

  function createMessageBubble(spec, options = {}) {
    const article = document.createElement("article");
    const role = spec.role === "user" ? "user" : (spec.role === "system" ? "system" : "assistant");
    article.className = `message ${role}${spec.isOwn ? " is-own" : ""}${spec.isPending ? " is-pending" : ""}`;
    article.setAttribute("data-message-id", spec.messageId || "");
    article.setAttribute("data-source", spec.source || "");

    const avatarEl = global.miaContactAvatar?.renderAvatar
      ? global.miaContactAvatar.renderAvatar({ displayName: spec.authorName, avatar: spec.avatar || {} })
      : null;
    if (avatarEl) article.appendChild(avatarEl);

    const stack = document.createElement("div");
    stack.className = "message-stack";
    const showAuthor = authorDisplayName(spec) && !spec.isOwn && role !== "system";
    const accentColor = global.miaMemberColor?.memberAccentColor(spec.authorId || spec.authorName || "");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (showAuthor) appendSenderTitle(bubble, spec, accentColor);
    bubble.insertAdjacentHTML("beforeend", renderMd(spec.bodyMd || ""));
    const timeEl = document.createElement("span");
    timeEl.className = "message-time";
    timeEl.textContent = shortTime(spec.createdAt);
    stack.appendChild(bubble);
    stack.appendChild(timeEl);
    article.appendChild(stack);

    article.addEventListener("contextmenu", (event) => {
      if (typeof options.onContextMenu !== "function") return;
      event.preventDefault();
      event.stopPropagation();
      options.onContextMenu(spec, event.clientX, event.clientY);
    });
    return article;
  }

  global.miaMessageBubble = { createMessageBubble };
})(typeof window !== "undefined" ? window : globalThis);
