// Message + composer helpers — shared between renderMessageHtml,
// message-menu, and composer. Extracted from app.js to keep the chat
// helper surface in one place.
(function () {
  "use strict";

  let state, els;
  let activePersona, messagesForActive, renderSendButton;

  // Composer IME composition tracker — used to ignore the Enter key that
  // commits a Chinese/Japanese candidate so it doesn't accidentally send.
  let composerCompositionEndedAt = 0;

  function initMessageHelpers(deps) {
    state = deps.state;
    els = deps.els;
    activePersona = deps.activePersona;
    messagesForActive = deps.messagesForActive;
    renderSendButton = deps.renderSendButton;
  }

  function noteCompositionEnded() {
    composerCompositionEndedAt = (typeof performance !== "undefined") ? performance.now() : Date.now();
  }

  function messageAtIndex(index) {
    if (!messagesForActive) return null;
    const messages = messagesForActive();
    if (!Number.isInteger(index) || index < 0 || index >= messages.length) return null;
    return messages[index] || null;
  }

  function messagePlainText(message) {
    return String(message?.content || "").trim();
  }

  function messageContextText(message, selectionText = "") {
    return String(selectionText || "").trim() || messagePlainText(message);
  }

  function messageContextSnippet(message, selectionText = "") {
    const text = messageContextText(message, selectionText).replace(/\s+/g, " ");
    return text.length > 160 ? `${text.slice(0, 160)}...` : text;
  }

  function messageAuthorLabel(message) {
    if (message?.role === "user") return "你";
    const persona = activePersona?.();
    return persona?.name || "AI";
  }

  function messageReferenceForIndex(index, selectionText = "") {
    const message = messageAtIndex(index);
    const snippet = messageContextSnippet(message, selectionText);
    if (!message || !snippet) return null;
    return {
      role: message.role,
      author: messageAuthorLabel(message),
      content: snippet,
      createdAt: message.createdAt || "",
      messageIndex: index,
      selected: Boolean(String(selectionText || "").trim())
    };
  }

  function replyQuoteHtml(replyTo) {
    if (!replyTo?.content) return "";
    return `
      <div class="message-reply-quote">
        <span>${window.miaMarkdown.escapeHtml(replyTo.author || (replyTo.role === "user" ? "你" : "AI"))}</span>
        <p>${window.miaMarkdown.escapeHtml(replyTo.content)}</p>
      </div>
    `;
  }

  function isComposerComposing(event = null) {
    const justCommitted =
      event?.key === "Enter" &&
      composerCompositionEndedAt > 0 &&
      performance.now() - composerCompositionEndedAt < 80;
    return Boolean(
      els?.chatInput?.dataset.composing === "true" ||
      event?.isComposing ||
      event?.key === "Process" ||
      event?.keyCode === 229 ||
      justCommitted
    );
  }

  function resizeChatInput() {
    if (!els) return;
    const input = els.chatInput;
    if (!input) return;
    const style = window.getComputedStyle(input);
    const minHeight = Number.parseFloat(style.minHeight) || 41;
    const maxHeight = Number.parseFloat(style.maxHeight) || 180;
    if (!input.value) {
      input.style.height = `${minHeight}px`;
      input.style.overflowY = "hidden";
      return;
    }
    input.style.height = `${minHeight}px`;
    const nextHeight = Math.max(minHeight, Math.min(input.scrollHeight, maxHeight));
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function insertComposerText(text) {
    if (!els) return;
    const value = String(text || "");
    if (!value || !els.chatInput) return;
    els.chatInput.value = value;
    els.chatInput.focus();
    els.chatInput.setSelectionRange(value.length, value.length);
    resizeChatInput();
    renderSendButton?.();
    window.miaComposer.updateSlashCommandState();
  }

  // Set a reply draft from any source (fellow message OR cloud-room message)
  // and render the composer reply chip. Cloud-room bubbles call this so the
  // same designed reply UI shows for groups/DMs as for private fellow chat.
  function setReplyDraft(reference) {
    if (!state) return;
    state.replyDraft = reference || null;
    renderComposerReply();
    els?.chatInput?.focus();
  }

  function renderComposerReply() {
    if (!state || !els || !els.composerReply) return;
    const reply = state.replyDraft;
    els.composerReply.classList.toggle("hidden", !reply);
    if (!reply) {
      els.composerReply.innerHTML = "";
      return;
    }
    els.composerReply.innerHTML = `
      <div>
        <span>回复 ${window.miaMarkdown.escapeHtml(reply.author || "消息")}</span>
        <p>${window.miaMarkdown.escapeHtml(reply.content || "")}</p>
      </div>
      <button type="button" data-clear-reply title="取消回复" aria-label="取消回复">×</button>
    `;
  }

  window.miaMessageHelpers = {
    initMessageHelpers,
    noteCompositionEnded,
    messageAtIndex,
    messagePlainText,
    messageContextText,
    messageContextSnippet,
    messageAuthorLabel,
    messageReferenceForIndex,
    setReplyDraft,
    replyQuoteHtml,
    isComposerComposing,
    resizeChatInput,
    insertComposerText,
    renderComposerReply,
  };
})();
