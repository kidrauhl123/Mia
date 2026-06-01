// Context menu for cloud-conversation (DM + group) message bubbles.
//
// Cloud-conversation messages are the only conversation messages now; this is
// the live message menu (the legacy fellow-chat menu in
// src/renderer/chat/message-menu.js is retained only for non-cloud surfaces).
// This module renders the SAME
// designed menu — same #messageContextMenu element, same .message-context-menu
// CSS, same menuItemHtml icons + separator + danger styling — but wires the
// actions to cloud-conversation operations:
//   回复  → set composer reply draft (embedded as a markdown quote on send)
//   拷贝  → copy plain text
//   翻译  → translate in place via the utility model
//   删除  → DELETE /api/conversations/:id/messages/:msgId (local delete: hides it for
//          you across your own devices; other members keep their copy)
// 置顶 is intentionally omitted: a shared cloud conversation has no per-message pin.
//
// Wired from app.js's chat-level contextmenu dispatcher, which routes bubbles
// carrying data-message-source="cloud-conversation" here instead of the fellow menu.

(function (global) {
  "use strict";

  function getMenuEl() {
    return document.getElementById("messageContextMenu");
  }

  function escapeHtml(value) {
    const h = global.miaMarkdown?.escapeHtml;
    if (typeof h === "function") return h(value);
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  }

  function menuItemHtml(spec) {
    const fn = global.miaMarkdown?.menuItemHtml;
    if (typeof fn === "function") return fn(spec);
    return `<button type="button" ${spec.attrs || ""}>${escapeHtml(spec.label)}</button>`;
  }

  function plainTextFromMarkdown(md) {
    return String(md || "")
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-zA-Z]*\n?/g, "").replace(/```$/g, ""))
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  }

  function snippetOf(plain) {
    const text = String(plain || "").replace(/\s+/g, " ").trim();
    return text.length > 160 ? `${text.slice(0, 160)}...` : text;
  }

  async function copyToClipboard(text) {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through */ }
    return false;
  }

  let outsideClickHandler = null;
  let escapeHandler = null;

  function closeMenu() {
    const menu = getMenuEl();
    if (!menu) return;
    menu.classList.add("hidden");
    menu.innerHTML = "";
    if (outsideClickHandler) {
      document.removeEventListener("click", outsideClickHandler, true);
      outsideClickHandler = null;
    }
    if (escapeHandler) {
      document.removeEventListener("keydown", escapeHandler);
      escapeHandler = null;
    }
  }

  function openSocialMessageMenu(message, x, y) {
    const menu = getMenuEl();
    if (!menu) return;
    // Tear down a still-open instance of THIS menu first, or its document
    // listeners (outside-click / escape) leak when reopened via right-click.
    closeMenu();
    // If fellow chat had its menu open, close it first.
    const closeFellow = global.miaMessageMenu?.closeMessageContextMenu;
    if (typeof closeFellow === "function") closeFellow();

    const social = global.miaSocial;
    const conversationId = social?.getActiveConversationId?.();
    const desc = social?.describeMessageForMenu?.(message) || { authorName: "", isOwn: false, bodyMd: message?.body_md || "" };
    const plain = plainTextFromMarkdown(desc.bodyMd);
    const hasText = Boolean(plain);

    menu.innerHTML = `
      ${menuItemHtml({ icon: "quote", label: "回复", attrs: `data-social-message-action="reply" ${hasText ? "" : "disabled"}` })}
      ${menuItemHtml({ icon: "copy", label: "拷贝", attrs: `data-social-message-action="copy" ${hasText ? "" : "disabled"}` })}
      ${menuItemHtml({ icon: "translate", label: "翻译", attrs: `data-social-message-action="translate" ${hasText ? "" : "disabled"}` })}
      <div class="skill-context-menu-separator" role="separator"></div>
      ${menuItemHtml({ icon: "delete", label: "删除", attrs: 'data-social-message-action="delete"', className: "danger" })}
    `;
    menu.classList.remove("hidden");
    window.miaLottieIcons?.init(menu);

    const rect = menu.getBoundingClientRect();
    const width = rect.width || 140;
    const height = rect.height || 180;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;

    menu.querySelectorAll("[data-social-message-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.socialMessageAction;
        closeMenu();
        if (action === "copy") {
          await copyToClipboard(plain);
          return;
        }
        if (action === "reply") {
          global.miaMessageHelpers?.setReplyDraft?.({
            role: desc.isOwn ? "user" : "assistant",
            author: desc.isOwn ? "你" : (desc.authorName || "对方"),
            content: snippetOf(plain)
          });
          return;
        }
        if (action === "translate") {
          if (conversationId && message?.id) await social?.translateConversationMessage?.(conversationId, message.id);
          return;
        }
        if (action === "delete") {
          if (conversationId && message?.id) await social?.deleteConversationMessage?.(conversationId, message.id);
          return;
        }
      });
    });

    // Defer outside-click registration so the right-click that opened the
    // menu doesn't immediately close it via bubbling.
    setTimeout(() => {
      outsideClickHandler = (event) => {
        if (menu.contains(event.target)) return;
        closeMenu();
      };
      document.addEventListener("click", outsideClickHandler, true);
      escapeHandler = (event) => {
        if (event.key === "Escape") closeMenu();
      };
      document.addEventListener("keydown", escapeHandler);
    }, 0);
  }

  global.miaSocialMessageMenu = { openSocialMessageMenu, closeSocialMessageMenu: closeMenu };
})(typeof window !== "undefined" ? window : globalThis);
