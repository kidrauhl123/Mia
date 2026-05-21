// Message context menu module
// Extracted from app.js (formerly lines 4128-4188 + 4248-4408). Mirrors the
// group.js / tasks-panel.js / pet-dialog.js pattern.
//
// This module handles the right-click context menu on chat bubbles: selection
// helpers, open/close, reply/copy/translate/pin/delete actions, and the menu
// render itself. Composer helpers (resizeChatInput, renderComposerReply,
// isComposerComposing, insertComposerText) that sit between these in app.js
// stay in app.js because they belong to the composer, not the menu.
(function () {
  "use strict";

  let state, els, aimashi;
  let messageAtIndex, messageReferenceForIndex, messageContextText, menuItemHtml;
  let activeSession, persistSessionQuietly, replacePersistedSessionQuietly;
  let renderChat, renderSessionMenu, renderComposerReply;
  let escapeHtml, renderMarkdown, copyTextToClipboard;
  let nowIso, cryptoRandomId;
  let closeSkillContextMenu, closeFellowContextMenu, closeGroupContextMenu;

  function initMessageMenu(deps) {
    state = deps.state;
    els = deps.els;
    aimashi = deps.aimashi || (typeof window !== "undefined" ? window.aimashi : null);
    messageAtIndex = deps.messageAtIndex;
    messageReferenceForIndex = deps.messageReferenceForIndex;
    messageContextText = deps.messageContextText;
    menuItemHtml = deps.menuItemHtml;
    activeSession = deps.activeSession;
    persistSessionQuietly = deps.persistSessionQuietly;
    replacePersistedSessionQuietly = deps.replacePersistedSessionQuietly;
    renderChat = deps.renderChat;
    renderSessionMenu = deps.renderSessionMenu;
    renderComposerReply = deps.renderComposerReply;
    escapeHtml = deps.escapeHtml;
    renderMarkdown = deps.renderMarkdown;
    copyTextToClipboard = deps.copyTextToClipboard;
    nowIso = deps.nowIso;
    cryptoRandomId = deps.cryptoRandomId;
    closeSkillContextMenu = deps.closeSkillContextMenu;
    closeFellowContextMenu = deps.closeFellowContextMenu;
    closeGroupContextMenu = deps.closeGroupContextMenu;
  }

  function clearMessageSelectionHighlight() {
    try {
      window.CSS?.highlights?.delete?.("aimashi-message-selection");
    } catch {
      // Highlight API is optional.
    }
  }

  function highlightMessageSelection(range) {
    clearMessageSelectionHighlight();
    try {
      if (!range || !window.Highlight || !window.CSS?.highlights) return;
      window.CSS.highlights.set("aimashi-message-selection", new window.Highlight(range));
    } catch {
      // Keep native selection behavior when custom highlights are unavailable.
    }
  }

  function selectionInsideBubble(bubble) {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString().trim();
    if (!text) return null;
    const anchorInside = selection.anchorNode && bubble.contains(selection.anchorNode);
    const focusInside = selection.focusNode && bubble.contains(selection.focusNode);
    if (!anchorInside || !focusInside) return null;
    const range = selection.getRangeAt(0).cloneRange();
    return { text, range };
  }

  function hasActiveMessageTextSelection() {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    if (!String(selection.toString() || "").trim()) return false;
    const anchorBubble = selection.anchorNode?.parentElement?.closest?.(".bubble[data-message-index]");
    const focusBubble = selection.focusNode?.parentElement?.closest?.(".bubble[data-message-index]");
    return Boolean(anchorBubble && focusBubble && anchorBubble === focusBubble && els.chat?.contains(anchorBubble));
  }

  function openMessageContextMenu(messageIndex, x, y, selection = null) {
    const index = Number(messageIndex);
    if (!messageAtIndex(index)) return;
    closeSkillContextMenu();
    closeFellowContextMenu();
    closeGroupContextMenu();
    const selectionText = String(selection?.text || "").trim();
    state.messageContextMenu = { open: true, x, y, messageIndex: index, selectionText };
    if (selectionText) highlightMessageSelection(selection.range);
    else clearMessageSelectionHighlight();
    renderMessageContextMenu();
  }

  function closeMessageContextMenu() {
    if (!state.messageContextMenu.open) return;
    state.messageContextMenu = { open: false, x: 0, y: 0, messageIndex: -1, selectionText: "" };
    clearMessageSelectionHighlight();
    renderMessageContextMenu();
  }

  function replyToMessage(message, index = state.messageContextMenu.messageIndex, selectionText = "") {
    const reference = messageReferenceForIndex(Number(index), selectionText);
    if (!reference) return;
    state.replyDraft = reference;
    renderComposerReply();
    els.chatInput?.focus();
  }

  function replyContextPrompt(text, replyTo) {
    if (!replyTo?.content) return text;
    return [
      "用户正在回复会话中的某一条消息。请把“被回复消息”作为这次回复的直接上下文，但不要在回答里机械复述它。",
      "",
      `被回复消息作者：${replyTo.author || (replyTo.role === "user" ? "用户" : "助手")}`,
      "被回复消息：",
      replyTo.content,
      "",
      "用户实际输入：",
      text
    ].join("\n");
  }

  function translationHtml(message, index) {
    const translation = message?.translation;
    if (!translation) return "";
    const status = translation.status || (translation.text ? "done" : "");
    const label = translation.sourceText ? "选中文本译文" : "译文";
    const body = status === "loading"
      ? '<p class="message-translation-muted">正在翻译...</p>'
      : status === "error"
        ? `<p class="message-translation-error">${escapeHtml(translation.error || "翻译失败")}</p>`
        : `<div class="message-translation-body">${renderMarkdown(translation.text || "")}</div>`;
    const copyButton = status === "done" && translation.text
      ? `<button type="button" data-copy-translation="${index}" title="复制译文" aria-label="复制译文">⧉</button>`
      : "";
    return `
      <div class="message-translation">
        <div class="message-translation-head">
          <span>${label}</span>
          ${copyButton}
        </div>
        ${body}
      </div>
    `;
  }

  async function translateMessage(message, index = state.messageContextMenu.messageIndex, selectionText = "") {
    const text = messageContextText(message, selectionText);
    const messageIndex = Number(index);
    const session = activeSession();
    const target = messageAtIndex(messageIndex);
    if (!text || !target) return;
    if (state.isGenerating) {
      target.translation = {
        status: "error",
        error: "请等当前回复生成结束后再翻译。",
        sourceText: String(selectionText || "").trim(),
        translatedAt: nowIso()
      };
      renderChat();
      return;
    }
    target.translation = {
      status: "loading",
      text: "",
      error: "",
      sourceText: String(selectionText || "").trim(),
      translatedAt: nowIso()
    };
    renderChat();
    try {
      const prompt = [
        "请把下面这条聊天消息翻译成简体中文。",
        "要求：只输出译文；保持原意、语气和代码/命令/链接；不要添加解释。",
        "",
        text
      ].join("\n");
      const response = await window.aimashi.sendChat({
        fellowKey: state.activeKey,
        personaKey: state.activeKey,
        sessionId: `utility:translate:${cryptoRandomId()}`,
        utility: true,
        messages: [{ role: "user", content: prompt }]
      });
      const translated = String(response.choices?.[0]?.message?.content || "").trim();
      target.translation = translated
        ? { status: "done", text: translated, error: "", sourceText: String(selectionText || "").trim(), translatedAt: nowIso() }
        : { status: "error", text: "", error: "模型没有返回译文。", sourceText: String(selectionText || "").trim(), translatedAt: nowIso() };
    } catch (error) {
      target.translation = {
        status: "error",
        text: "",
        error: `翻译失败: ${error.message || error}`,
        sourceText: String(selectionText || "").trim(),
        translatedAt: nowIso()
      };
    }
    renderChat();
    await persistSessionQuietly(session);
  }

  async function toggleMessagePinned(index) {
    const message = messageAtIndex(index);
    if (!message) return;
    message.pinned = !message.pinned;
    message.pinnedAt = message.pinned ? nowIso() : "";
    const session = activeSession();
    session.updatedAt = nowIso();
    renderChat();
    await replacePersistedSessionQuietly(session);
  }

  async function deleteMessageAt(index) {
    const session = activeSession();
    if (!messageAtIndex(index)) return;
    session.messages.splice(index, 1);
    session.updatedAt = nowIso();
    renderChat();
    renderSessionMenu();
    await replacePersistedSessionQuietly(session);
  }

  function renderMessageContextMenu() {
    if (!els.messageContextMenu) return;
    const menu = els.messageContextMenu;
    const message = messageAtIndex(state.messageContextMenu.messageIndex);
    const open = state.messageContextMenu.open && message;
    menu.classList.toggle("hidden", !open);
    if (!open) return;
    const selectionText = String(state.messageContextMenu.selectionText || "").trim();
    const hasSelection = Boolean(selectionText);
    const contextText = messageContextText(message, selectionText);
    const hasText = Boolean(contextText);
    menu.innerHTML = `
      ${menuItemHtml({ icon: "quote", label: hasSelection ? "回复选中" : "回复", attrs: `data-message-action="reply" ${hasText ? "" : "disabled"}` })}
      ${menuItemHtml({ icon: "copy", label: hasSelection ? "拷贝选中" : "拷贝", attrs: `data-message-action="copy" ${hasText ? "" : "disabled"}` })}
      ${menuItemHtml({ icon: "translate", label: hasSelection ? "翻译选中" : "翻译", attrs: `data-message-action="translate" ${hasText ? "" : "disabled"}` })}
      <div class="skill-context-menu-separator" role="separator"></div>
      ${menuItemHtml({ icon: "pin", label: message.pinned ? "取消置顶" : "置顶", attrs: 'data-message-action="pin"' })}
      ${menuItemHtml({ icon: "delete", label: "删除", attrs: 'data-message-action="delete"', className: "danger" })}
    `;
    const rect = menu.getBoundingClientRect();
    const width = rect.width || 116;
    const height = rect.height || 210;
    menu.style.left = `${Math.max(8, Math.min(state.messageContextMenu.x, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(state.messageContextMenu.y, window.innerHeight - height - 8))}px`;
    menu.querySelectorAll("[data-message-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.dataset.messageAction;
        const index = state.messageContextMenu.messageIndex;
        const actionSelectionText = String(state.messageContextMenu.selectionText || "").trim();
        const targetMessage = messageAtIndex(index);
        closeMessageContextMenu();
        if (!targetMessage) return;
        if (action === "reply") replyToMessage(targetMessage, index, actionSelectionText);
        if (action === "copy") await copyTextToClipboard(messageContextText(targetMessage, actionSelectionText));
        if (action === "translate") await translateMessage(targetMessage, index, actionSelectionText);
        if (action === "pin") await toggleMessagePinned(index);
        if (action === "delete") await deleteMessageAt(index);
      });
    });
  }

  window.aimashiMessageMenu = {
    initMessageMenu,
    clearMessageSelectionHighlight,
    highlightMessageSelection,
    selectionInsideBubble,
    hasActiveMessageTextSelection,
    openMessageContextMenu,
    closeMessageContextMenu,
    replyToMessage,
    replyContextPrompt,
    translationHtml,
    translateMessage,
    toggleMessagePinned,
    deleteMessageAt,
    renderMessageContextMenu,
  };
})();
