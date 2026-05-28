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
    const showAuthor = spec.authorName && !spec.isOwn && role !== "system";
    const accentColor = global.miaMemberColor?.memberAccentColor(spec.authorId || spec.authorName || "");
    const senderTitleHtml = showAuthor
      ? `<span class="bubble-sender"${accentColor ? ` style="color:${accentColor};"` : ""}>${escapeHtml(spec.authorName)}</span>`
      : "";
    stack.innerHTML = `
      <div class="bubble">${senderTitleHtml}${renderMd(spec.bodyMd || "")}</div>
      <span class="message-time">${escapeHtml(shortTime(spec.createdAt))}</span>
    `;
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
