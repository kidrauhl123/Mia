(function (global) {
  "use strict";

  function timeFormat() {
    return global.aimashiTimeFormat || require("../shared/time-format");
  }

  function escapeHtml(value) {
    const h = global.aimashiMarkdown?.escapeHtml;
    if (typeof h === "function") return h(value);
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  }
  function renderMd(md) {
    const fn = global.aimashiMarkdown?.renderMarkdown;
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

    const avatarEl = global.aimashiContactAvatar?.renderAvatar
      ? global.aimashiContactAvatar.renderAvatar({ displayName: spec.authorName, avatar: spec.avatar || {} })
      : null;
    if (avatarEl) article.appendChild(avatarEl);

    const stack = document.createElement("div");
    stack.className = "message-stack";
    const showAuthor = spec.authorName && !spec.isOwn && role !== "system";
    stack.innerHTML = `
      ${showAuthor ? `<span class="message-sender">${escapeHtml(spec.authorName)}</span>` : ""}
      <div class="bubble">${renderMd(spec.bodyMd || "")}</div>
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

  global.aimashiMessageBubble = { createMessageBubble };
})(typeof window !== "undefined" ? window : globalThis);
