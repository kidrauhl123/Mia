// Session read-state module
// Extracted from app.js (formerly lines 1825-1897). Pure data layer for
// per-persona unread badge tracking and read-marker persistence. No DOM
// access, so the module is fully self-contained behind window.aimashiSessionReadState.
//
// Defensive: all exposed methods no-op if init hasn't run (state ref still
// undefined). Avoids the init-order class of bug fixed in commit b2d6fa3.
(function () {
  "use strict";

  const __global = typeof window !== "undefined" ? window : globalThis;
  function unreadShared() {
    if (__global.aimashiUnread) return __global.aimashiUnread;
    if (typeof require !== "undefined") return require("../../shared/unread");
    throw new Error("aimashiUnread is not loaded");
  }

  let state, aimashi;
  let nowIso;

  function initSessionReadState(deps) {
    state = deps.state;
    aimashi = deps.aimashi || (typeof window !== "undefined" ? window.aimashi : null);
    nowIso = deps.nowIso;
  }

  function ensureReadState() {
    if (!state) return {};
    if (!state.chatStore || typeof state.chatStore !== "object") {
      state.chatStore = { schema_version: 1, readAt: {}, sessions: {} };
    }
    if (!state.chatStore.readAt || typeof state.chatStore.readAt !== "object") {
      state.chatStore.readAt = {};
    }
    return state.chatStore.readAt;
  }

  function latestAssistantMessageTime(personaKey) {
    if (!state) return "";
    const sessions = state.chatStore.sessions?.[personaKey] || [];
    let latest = "";
    for (const session of sessions) {
      for (const message of session.messages || []) {
        if (message.role !== "assistant" || message.transient || !String(message.content || "").trim()) continue;
        const createdAt = message.createdAt || session.updatedAt || session.createdAt || "";
        if (String(createdAt).localeCompare(latest) > 0) latest = String(createdAt);
      }
    }
    return latest;
  }

  function initializeReadStateForPersonas(personas) {
    if (!state) return;
    const readAt = ensureReadState();
    let changed = false;
    for (const persona of personas) {
      if (!persona?.key || readAt[persona.key]) continue;
      readAt[persona.key] = latestAssistantMessageTime(persona.key) || nowIso();
      changed = true;
    }
    if (changed) persistReadStateQuietly();
  }

  function unreadCountForPersona(personaKey) {
    if (!state) return 0;
    const readState = { readAt: ensureReadState() };
    const conversation = {
      key: personaKey,
      sessions: state.chatStore.sessions?.[personaKey] || [],
    };
    return unreadShared().computeUnreadForConversation(conversation, readState);
  }

  function totalUnreadCount(personas) {
    if (!state) return 0;
    const readState = { readAt: ensureReadState() };
    const conversations = personas.map((persona) => ({
      key: persona.key,
      sessions: state.chatStore.sessions?.[persona.key] || [],
    }));
    return unreadShared().totalUnreadFromConversations(conversations, readState);
  }

  async function persistReadStateQuietly() {
    if (!state) return;
    try {
      if (window.aimashi?.saveChatReadState) {
        const readAt = { ...ensureReadState() };
        await window.aimashi.saveChatReadState({ readAt });
        state.chatStore.readAt = { ...state.chatStore.readAt, ...readAt };
      }
    } catch (error) {
      console.error("Failed to persist read state", error);
    }
  }

  function markPersonaRead(personaKey, persist = true) {
    if (!state) return;
    if (!personaKey) return;
    const latest = latestAssistantMessageTime(personaKey);
    if (!latest) return;
    const readAt = ensureReadState();
    const next = latest;
    if (String(next).localeCompare(readAt[personaKey] || "") <= 0) return;
    readAt[personaKey] = next;
    if (persist) persistReadStateQuietly();
  }

  window.aimashiSessionReadState = {
    initSessionReadState,
    ensureReadState,
    latestAssistantMessageTime,
    initializeReadStateForPersonas,
    unreadCountForPersona,
    totalUnreadCount,
    persistReadStateQuietly,
    markPersonaRead,
  };
})();
