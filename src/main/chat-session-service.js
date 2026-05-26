"use strict";

const crypto = require("node:crypto");

function createChatSessionService({
  initializeRuntime,
  chatStore,
  randomUUID = () => crypto.randomUUID(),
  sendChat
}) {
  function loadChatSessions() {
    initializeRuntime();
    // Pure read: loadChatStore already returns a normalized store. It must NOT
    // write — the foreground app reads through this, and a write-on-read would
    // make it a second writer racing the daemon (the single writer).
    return chatStore.loadChatStore();
  }

  function saveChatSession({ personaKey, session, replaceMessages = false }) {
    initializeRuntime();
    const key = String(personaKey || session?.personaKey || "").trim();
    if (!key) throw new Error("personaKey is required.");
    const store = chatStore.loadChatStore();
    if (!store.sessions[key]) store.sessions[key] = [];
    const now = new Date().toISOString();
    const next = {
      id: String(session?.id || randomUUID()),
      personaKey: key,
      title: chatStore.cleanSessionTitle(session?.title) || "新对话",
      titleGenerated: Boolean(session?.titleGenerated),
      createdAt: session?.createdAt || now,
      updatedAt: session?.updatedAt || now,
      messages: Array.isArray(session?.messages)
        ? session.messages.map((message) => {
          const out = {
            role: ["user", "assistant", "system"].includes(message.role) ? message.role : "assistant",
            content: String(message.content || ""),
            createdAt: message.createdAt || now,
            transient: Boolean(message.transient)
          };
          if (message.pinned) {
            out.pinned = true;
            out.pinnedAt = String(message.pinnedAt || message.pinned_at || now);
          }
          const replyTo = chatStore.normalizeMessageReply(message.replyTo);
          if (replyTo) out.replyTo = replyTo;
          const translation = chatStore.normalizeMessageTranslation(message.translation);
          if (translation && translation.status !== "loading") out.translation = translation;
          const commandResult = chatStore.normalizeCommandResult(message.commandResult);
          if (commandResult) out.commandResult = commandResult;
          const attachments = chatStore.normalizeAttachments(message.attachments);
          if (attachments.length) out.attachments = attachments;
          if (message.reasoning) out.reasoning = String(message.reasoning);
          if (Array.isArray(message.tools) && message.tools.length) {
            out.tools = message.tools.map((tool) => ({
              id: String(tool.id || ""),
              name: String(tool.name || ""),
              preview: String(tool.preview || ""),
              status: ["running", "completed", "error"].includes(tool.status) ? tool.status : "completed",
              duration: typeof tool.duration === "number" ? tool.duration : null,
              error: Boolean(tool.error)
            }));
          }
          return out;
        })
          .filter((message) => !message.transient)
          .map(({ transient, ...message }) => message)
        : []
    };
    const index = store.sessions[key].findIndex((item) => item.id === next.id);
    if (index >= 0) {
      const existing = store.sessions[key][index];
      const mergedMessages = [...(existing.messages || [])];
      const seen = new Map(mergedMessages.map((message, messageIndex) => [chatStore.chatMessageMergeKey(message), messageIndex]));
      for (const message of next.messages) {
        const messageKey = chatStore.chatMessageMergeKey(message);
        const existingIndex = seen.get(messageKey);
        if (existingIndex == null) {
          mergedMessages.push(message);
          seen.set(messageKey, mergedMessages.length - 1);
        } else {
          mergedMessages[existingIndex] = chatStore.mergeChatMessageRecord(mergedMessages[existingIndex], message);
        }
      }
      mergedMessages.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
      store.sessions[key][index] = {
        ...existing,
        ...next,
        title: next.titleGenerated ? next.title : (existing.title || next.title),
        titleGenerated: Boolean(existing.titleGenerated || next.titleGenerated),
        createdAt: existing.createdAt || next.createdAt,
        updatedAt: String(next.updatedAt || "").localeCompare(String(existing.updatedAt || "")) >= 0 ? next.updatedAt : existing.updatedAt,
        messages: replaceMessages ? next.messages : mergedMessages
      };
    } else {
      store.sessions[key].push(next);
    }
    return chatStore.saveChatStore(store);
  }

  function saveChatReadState({ readAt, manualUnread }) {
    initializeRuntime();
    const store = chatStore.loadChatStore();
    if (readAt && typeof readAt === "object") {
      store.readAt = Object.fromEntries(
        Object.entries(readAt)
          .filter(([key, value]) => key && typeof value === "string" && value.trim())
          .map(([key, value]) => [String(key), value])
      );
    }
    if (manualUnread && typeof manualUnread === "object") {
      store.manualUnread = Object.fromEntries(
        Object.entries(manualUnread)
          .filter(([key, value]) => key && value === true)
          .map(([key]) => [String(key), true])
      );
    }
    return chatStore.saveChatStore(store);
  }

  function newChatSession({ personaKey }) {
    initializeRuntime();
    const key = String(personaKey || "").trim();
    if (!key) throw new Error("personaKey is required.");
    const store = chatStore.loadChatStore();
    if (!store.sessions[key]) store.sessions[key] = [];
    store.sessions[key] = store.sessions[key].filter((session) => (session.messages || []).some((message) => String(message.content || "").trim()));
    const session = chatStore.createChatSession(key);
    store.sessions[key].unshift(session);
    return chatStore.saveChatStore(store);
  }

  function renameChatSession({ personaKey, sessionId, title }) {
    initializeRuntime();
    const key = String(personaKey || "").trim();
    const id = String(sessionId || "").trim();
    const nextTitle = chatStore.cleanSessionTitle(title);
    if (!key || !id || !nextTitle) throw new Error("personaKey, sessionId and title are required.");
    const store = chatStore.loadChatStore();
    const session = (store.sessions[key] || []).find((item) => item.id === id);
    if (!session) throw new Error("Session not found.");
    session.title = nextTitle;
    session.titleGenerated = true;
    session.updatedAt = new Date().toISOString();
    return chatStore.saveChatStore(store);
  }

  async function generateSessionTitle({ personaKey, sessionId, messages }) {
    const clipped = (Array.isArray(messages) ? messages : [])
      .filter((message) => ["user", "assistant"].includes(message.role) && String(message.content || "").trim())
      .slice(0, 4);
    if (!clipped.length) return { title: "新对话" };
    try {
      const response = await sendChat({
        personaKey,
        sessionId: sessionId || `title:${randomUUID()}`,
        messages: [
          {
            role: "system",
            content: "请给下面这段对话生成一个简短标题。要求：不超过12个中文字；只输出标题；不要解释；不要引号；不要句号。"
          },
          {
            role: "user",
            content: clipped.map((message) => `${message.role}: ${message.content}`).join("\n").slice(0, 1600)
          }
        ]
      });
      const content = response.choices?.[0]?.message?.content || "";
      return { title: chatStore.cleanSessionTitle(content) || chatStore.fallbackSessionTitle(clipped) };
    } catch {
      return { title: chatStore.fallbackSessionTitle(clipped) };
    }
  }

  return {
    loadChatSessions,
    saveChatSession,
    saveChatReadState,
    newChatSession,
    renameChatSession,
    generateSessionTitle
  };
}

module.exports = {
  createChatSessionService
};
