(function (global) {
  "use strict";

  let state;
  let els;
  let render;
  let setAnimatedText;
  let sessionHistory;
  let allOwnedBots;

  function init(deps = {}) {
    state = deps.state;
    els = deps.els;
    render = deps.render;
    setAnimatedText = deps.setAnimatedText;
    sessionHistory = deps.sessionHistory;
    allOwnedBots = deps.allOwnedBots;
  }

  function activeConversation() {
    const social = global.miaSocial;
    const conversationId = social?.getActiveConversationId?.();
    return conversationId ? social?.getConversationById?.(conversationId) || null : null;
  }

  function conversationSortTime(conversation) {
    return sessionHistory.conversationSortTime(conversation, global.miaSocial?.moduleState?.messageCache);
  }

  function title(conversation) {
    return sessionHistory.sessionTitle(conversation, {
      bots: allOwnedBots?.() || [],
      defaultTitle: "新对话",
      groupTitle: "群聊",
      dmTitleFallback: "私聊"
    });
  }

  function conversationsFor(conversation) {
    return sessionHistory.sessionConversationsForConversation(
      conversation,
      global.miaSocial?.moduleState?.conversations || [],
      {
        messageCache: global.miaSocial?.moduleState?.messageCache,
        activeConversationId: global.miaSocial?.getActiveConversationId?.()
      }
    );
  }

  function updateUnreadBadge(count) {
    if (!els?.sessionUnreadBadge) return;
    const unread = Math.max(0, Number(count) || 0);
    const text = global.miaUnread?.unreadBadgeText?.(unread) || "";
    els.sessionUnreadBadge.textContent = text;
    els.sessionUnreadBadge.classList.toggle("hidden", !text);
    els.sessionUnreadBadge.setAttribute("aria-label", text ? `${unread} 条未读消息` : "");
  }

  function updateTitle(value) {
    if (!els?.currentSessionTitle) return;
    const next = value || "新对话";
    if ((els.currentSessionTitle.dataset?.slotTextValue || els.currentSessionTitle.textContent) === next) return;
    setAnimatedText(els.currentSessionTitle, next, { direction: "up", stagger: 18, duration: 240 });
    els.currentSessionTitle.classList.remove("title-updated");
    void els.currentSessionTitle.offsetWidth;
    els.currentSessionTitle.classList.add("title-updated");
  }

  function resetRename() {
    state.sessionRename = { conversationId: "", draft: "", saving: false, error: "" };
  }

  function focusRenameInput() {
    requestAnimationFrame(() => {
      const input = els?.sessionList?.querySelector?.(".session-row-rename-input");
      input?.focus?.();
      input?.select?.();
    });
  }

  function startRename(conversation) {
    if (!conversation?.id) return;
    state.sessionRename = {
      conversationId: conversation.id,
      draft: title(conversation),
      saving: false,
      error: ""
    };
    renderMenu();
    focusRenameInput();
  }

  function cancelRename() {
    resetRename();
    renderMenu();
  }

  async function commitRename(conversation) {
    const rename = state.sessionRename || {};
    if (!conversation?.id || rename.conversationId !== conversation.id) return;
    const nextTitle = String(rename.draft || "").trim();
    if (!nextTitle) {
      state.sessionRename = { ...rename, saving: false, error: "名称不能为空" };
      renderMenu();
      focusRenameInput();
      return;
    }
    if (nextTitle === title(conversation).trim()) {
      cancelRename();
      return;
    }
    state.sessionRename = { ...rename, draft: nextTitle, saving: true, error: "" };
    renderMenu();
    try {
      const response = await global.mia.social.updateConversation(conversation.id, { name: nextTitle });
      if (!response?.ok) throw new Error(response?.error || "未知错误");
      resetRename();
      global.miaSocial?.upsertBotConversation?.(
        response.data?.conversation || response.conversation || { ...conversation, name: nextTitle }
      );
      renderMenu();
    } catch (error) {
      state.sessionRename = {
        ...rename,
        draft: nextTitle,
        saving: false,
        error: `重命名失败：${error?.message || error}`
      };
      renderMenu();
      focusRenameInput();
    }
  }

  async function selectConversation(conversation, { skipMessageLoad = false } = {}) {
    if (!conversation?.id) return;
    global.miaSocial?.setActiveConversationId?.(conversation.id);
    state.sessionMenuOpen = false;
    state.replyDraft = null;
    state.forceScrollToBottom = true;
    const cache = global.miaSocial?.moduleState?.messageCache;
    if (cache && !cache.has(conversation.id)) cache.set(conversation.id, { messages: [], maxSeq: 0 });
    if (skipMessageLoad) {
      render();
      return;
    }
    try {
      const response = await global.mia.social.listConversationMessages(conversation.id, 0, 100);
      const messages = (response?.ok ? response.data?.messages : response?.messages) || [];
      const ordered = messages.slice().sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
      const maxSeq = ordered.reduce((max, message) => Math.max(max, Number(message.seq) || 0), 0);
      cache?.set(conversation.id, { messages: ordered, maxSeq });
    } catch (error) {
      console.warn("[renderer] cloud session messages load failed:", error?.message || error);
    }
    render();
  }

  function renderConversationMenu(active) {
    const conversations = conversationsFor(active);
    const activeId = active.id;
    const botUnread = global.miaSocial?.getUnreadForBot?.(sessionHistory.botId(active)) || 0;
    updateUnreadBadge(botUnread);
    updateTitle(title(active));
    global.miaReactChatMenus?.publish?.({
      sessionRows: conversations.map((conversation) => {
        const rename = state.sessionRename || {};
        const isRenaming = rename.conversationId === conversation.id;
        return {
          active: conversation.id === activeId,
          cancelRename,
          draft: isRenaming ? String(rename.draft || "") : "",
          edit: () => startRename(conversation),
          error: isRenaming ? String(rename.error || "") : "",
          id: conversation.id,
          rename: isRenaming,
          save: () => commitRename(conversation),
          saving: Boolean(isRenaming && rename.saving),
          select: async () => {
            await selectConversation(conversation);
            render();
          },
          setDraft: (value) => {
            state.sessionRename = { ...state.sessionRename, draft: value, error: "" };
            renderMenu();
          },
          time: new Date(conversationSortTime(conversation) || Date.now()).toLocaleString(),
          title: title(conversation),
          unread: global.miaSocial?.getUnreadForConversation?.(conversation.id) || 0
        };
      })
    });
  }

  function renderMenu() {
    if (!els?.sessionMenu || !els?.sessionList) return;
    els.sessionMenu.classList.toggle("hidden", !state.sessionMenuOpen);
    const conversation = activeConversation();
    if (conversation) {
      renderConversationMenu(conversation);
      return;
    }
    global.miaReactChatMenus?.publish?.({ sessionRows: [] });
    updateUnreadBadge(0);
    updateTitle("新对话");
  }

  global.miaSessionMenuController = {
    init,
    activeConversation,
    renderMenu,
    selectConversation,
    title,
    updateTitle,
    updateUnreadBadge
  };
})(typeof window !== "undefined" ? window : globalThis);
