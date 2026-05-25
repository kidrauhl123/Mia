// Session read-state module
// Extracted from app.js (formerly lines 1825-1897). Pure data layer for
// per-persona unread badge tracking and read-marker persistence. No DOM
// access, so the module is fully self-contained behind window.miaSessionReadState.
//
// Defensive: all exposed methods no-op if init hasn't run (state ref still
// undefined). Avoids the init-order class of bug fixed in commit b2d6fa3.
(function () {
  "use strict";

  const __global = typeof window !== "undefined" ? window : globalThis;
  function unreadShared() {
    if (__global.miaUnread) return __global.miaUnread;
    if (typeof require !== "undefined") return require("../../shared/unread");
    throw new Error("miaUnread is not loaded");
  }

  let state, mia;
  let nowIso;

  function initSessionReadState(deps) {
    state = deps.state;
    mia = deps.mia || (typeof window !== "undefined" ? window.mia : null);
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

  // Personas the user explicitly "标为未读". A manual override that surfaces a
  // single-pip badge even when no assistant message is newer than the read
  // mark; cleared by markPersonaRead. Persisted alongside readAt.
  function ensureManualUnread() {
    if (!state) return {};
    ensureReadState();
    if (!state.chatStore.manualUnread || typeof state.chatStore.manualUnread !== "object") {
      state.chatStore.manualUnread = {};
    }
    return state.chatStore.manualUnread;
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
    const computed = unreadShared().computeUnreadForConversation(conversation, readState);
    if (computed > 0) return computed;
    // No genuinely-unread messages, but the user may have "标为未读" → single pip.
    return ensureManualUnread()[personaKey] ? 1 : 0;
  }

  function totalUnreadCount(personas) {
    if (!state) return 0;
    // Sum per-persona so the manual-unread override is reflected in the badge
    // total exactly as it is per row.
    let total = 0;
    for (const persona of personas) total += unreadCountForPersona(persona.key);
    return total;
  }

  async function persistReadStateQuietly() {
    if (!state) return;
    try {
      if (window.mia?.saveChatReadState) {
        const readAt = { ...ensureReadState() };
        const manualUnread = { ...ensureManualUnread() };
        await window.mia.saveChatReadState({ readAt, manualUnread });
        state.chatStore.readAt = { ...state.chatStore.readAt, ...readAt };
        state.chatStore.manualUnread = manualUnread;
      }
    } catch (error) {
      console.error("Failed to persist read state", error);
    }
  }

  // clearManual=false is used by the passive, render-time auto-read of the
  // active persona: it should advance the read mark but NOT wipe an explicit
  // "标为未读" override, otherwise marking the currently-open fellow unread is an
  // instant no-op. Explicit reads (opening the chat, 标为已读) keep the default.
  function markPersonaRead(personaKey, persist = true, { clearManual = true } = {}) {
    if (!state) return;
    if (!personaKey) return;
    let changed = false;
    if (clearManual) {
      const manual = ensureManualUnread();
      if (manual[personaKey]) { delete manual[personaKey]; changed = true; }
    }
    const latest = latestAssistantMessageTime(personaKey);
    const readAt = ensureReadState();
    if (latest && String(latest).localeCompare(readAt[personaKey] || "") > 0) {
      readAt[personaKey] = latest;
      changed = true;
    }
    if (changed && persist) persistReadStateQuietly();
  }

  function markPersonaUnread(personaKey, persist = true) {
    if (!state || !personaKey) return;
    const manual = ensureManualUnread();
    if (manual[personaKey]) return;
    manual[personaKey] = true;
    if (persist) persistReadStateQuietly();
  }

  window.miaSessionReadState = {
    initSessionReadState,
    ensureReadState,
    latestAssistantMessageTime,
    initializeReadStateForPersonas,
    unreadCountForPersona,
    totalUnreadCount,
    persistReadStateQuietly,
    markPersonaRead,
    markPersonaUnread,
  };
})();
