// Chat store (main process)
// Extracted from src/main.js. Owns the on-disk chat-sessions JSON:
// load, normalize, save, plus the small helpers for session title
// generation, message reply/translation/tool record normalization, and
// the merge key used when reconciling cloud-pushed messages.
//
// The session mutation surface (saveChatSession, deleteChatSession,
// pushCloudMessage, etc.) stays in main.js for now — those touch a
// large IPC + cloud-sync pipeline and need a separate plan.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function createChatStore(deps = {}) {
  const {
    runtimePaths,
    readJson,
    normalizeAttachments,
  } = deps;

  function defaultChatStore() {
    return {
      schema_version: 1,
      readAt: {},
      sessions: {}
    };
  }

  function cleanSessionTitle(value) {
    return String(value || "")
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’。.!！?？:：]+$/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 32);
  }

  function fallbackSessionTitle(messages = []) {
    const firstUser = messages.find((message) => message.role === "user" && String(message.content || "").trim());
    return cleanSessionTitle(firstUser?.content || "新对话") || "新对话";
  }

  function normalizeMessageReply(replyTo) {
    if (!replyTo || typeof replyTo !== "object" || !String(replyTo.content || "").trim()) return null;
    return {
      role: ["user", "assistant", "system"].includes(replyTo.role) ? replyTo.role : "",
      author: String(replyTo.author || "").slice(0, 80),
      content: String(replyTo.content || "").trim().slice(0, 500),
      createdAt: String(replyTo.createdAt || ""),
      messageIndex: Number.isInteger(replyTo.messageIndex) ? replyTo.messageIndex : -1
    };
  }

  function normalizeMessageTranslation(translation) {
    if (!translation || typeof translation !== "object") return null;
    const status = ["loading", "done", "error"].includes(translation.status) ? translation.status : "";
    const text = String(translation.text || "").trim();
    const error = String(translation.error || "").trim();
    if (!status && !text && !error) return null;
    return {
      status: status || (text ? "done" : "error"),
      text,
      error,
      sourceText: String(translation.sourceText || "").trim().slice(0, 1000),
      translatedAt: String(translation.translatedAt || "")
    };
  }

  function chatMessageMergeKey(message) {
    return `${message.role}\n${message.createdAt}\n${message.content}`;
  }

  function mergeChatMessageRecord(existing, next) {
    return {
      ...existing,
      ...next,
      attachments: next.attachments || existing.attachments,
      reasoning: next.reasoning || existing.reasoning,
      tools: next.tools || existing.tools,
      replyTo: next.replyTo || existing.replyTo,
      translation: next.translation || existing.translation,
      pinned: Boolean(existing.pinned || next.pinned),
      pinnedAt: next.pinnedAt || existing.pinnedAt
    };
  }

  function normalizeChatStore(input) {
    const store = input && typeof input === "object" ? input : defaultChatStore();
    const sessions = store.sessions && typeof store.sessions === "object" ? store.sessions : {};
    const readAt = store.readAt && typeof store.readAt === "object" ? store.readAt : {};
    const normalized = { schema_version: 1, readAt: {}, sessions: {} };
    for (const [personaKey, value] of Object.entries(readAt)) {
      if (typeof value === "string" && value.trim()) {
        normalized.readAt[String(personaKey)] = value;
      }
    }
    for (const [personaKey, list] of Object.entries(sessions)) {
      if (!Array.isArray(list)) continue;
      normalized.sessions[personaKey] = list
        .filter((session) => session && typeof session === "object" && session.id)
        .map((session) => ({
          id: String(session.id),
          personaKey: String(session.personaKey || personaKey),
          title: cleanSessionTitle(session.title) || "新对话",
          titleGenerated: Boolean(session.titleGenerated),
          createdAt: session.createdAt || new Date().toISOString(),
          updatedAt: session.updatedAt || session.createdAt || new Date().toISOString(),
          messages: Array.isArray(session.messages)
            ? session.messages
              .filter((message) => message && ["user", "assistant", "system"].includes(message.role))
              .map((message) => {
                const out = {
                  role: message.role,
                  content: String(message.content || ""),
                  createdAt: message.createdAt || session.updatedAt || new Date().toISOString()
                };
                if (message.pinned) {
                  out.pinned = true;
                  out.pinnedAt = String(message.pinnedAt || message.pinned_at || session.updatedAt || "");
                }
                const replyTo = normalizeMessageReply(message.replyTo);
                if (replyTo) out.replyTo = replyTo;
                const translation = normalizeMessageTranslation(message.translation);
                if (translation && translation.status !== "loading") out.translation = translation;
                const attachments = normalizeAttachments(message.attachments);
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
            : []
        }))
        .filter((session) => session.id);
    }
    return normalized;
  }

  function loadChatStore() {
    return normalizeChatStore(readJson(runtimePaths().chatSessions, defaultChatStore()));
  }

  function saveChatStore(store) {
    const p = runtimePaths();
    fs.mkdirSync(path.dirname(p.chatSessions), { recursive: true });
    const normalized = normalizeChatStore(store);
    fs.writeFileSync(p.chatSessions, JSON.stringify(normalized, null, 2) + "\n", { mode: 0o600 });
    return normalized;
  }

  function createChatSession(personaKey) {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      personaKey,
      title: "新对话",
      titleGenerated: false,
      createdAt: now,
      updatedAt: now,
      messages: []
    };
  }

  function ensurePersonaSession(store, personaKey) {
    if (!store.sessions[personaKey]) store.sessions[personaKey] = [];
    if (!store.sessions[personaKey].length) {
      store.sessions[personaKey].push(createChatSession(personaKey));
    }
    store.sessions[personaKey].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return store.sessions[personaKey][0];
  }

  return {
    defaultChatStore,
    cleanSessionTitle,
    fallbackSessionTitle,
    normalizeMessageReply,
    normalizeMessageTranslation,
    chatMessageMergeKey,
    mergeChatMessageRecord,
    normalizeChatStore,
    loadChatStore,
    saveChatStore,
    createChatSession,
    ensurePersonaSession,
  };
}

module.exports = { createChatStore };
