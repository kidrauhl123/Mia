"use strict";

function coreChatPayload(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const next = { ...source };
  delete next.webContents;
  delete next.emit;
  delete next.signal;
  delete next.abortController;
  return next;
}

function messageContentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part == null) return "";
        if (typeof part === "string") return part;
        if (typeof part === "object") return String(part.text || part.content || "");
        return String(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

function latestUserMessageText(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const message = [...list].reverse().find((item) => String(item?.role || "").toLowerCase() === "user") || list.at(-1);
  return messageContentText(message?.content);
}

function coreConversationMessageRequest(payload = {}) {
  const source = coreChatPayload(payload);
  const conversationId = String(source.conversationId || source.conversation_id || source.sessionId || "").trim();
  const explicitBody = source.body || source.text || source.message || source.prompt;
  return {
    conversationId,
    body: {
      body: String(explicitBody || latestUserMessageText(source.messages) || ""),
      attachments: Array.isArray(source.attachments) ? source.attachments : [],
      selectedSkillIds: Array.isArray(source.selectedSkillIds) ? source.selectedSkillIds : []
    }
  };
}

function createChatSendDelegator({
  isDaemonProcess = false,
  requireDaemonRuntimeAvailable = () => {},
  coreClient = null,
  fallbackSendChat = null
} = {}) {
  const isDaemon = typeof isDaemonProcess === "function" ? isDaemonProcess : () => Boolean(isDaemonProcess);

  return async function delegatedSendChat(payload = {}) {
    if (isDaemon()) {
      if (typeof fallbackSendChat !== "function") throw new Error("fallbackSendChat is required in daemon process.");
      return fallbackSendChat(payload || {});
    }
    requireDaemonRuntimeAvailable();
    if (!coreClient || typeof coreClient.call !== "function") {
      throw new Error("Mia Core conversation client is unavailable.");
    }
    const request = coreConversationMessageRequest(payload);
    if (!request.conversationId) {
      return { ok: false, error: "conversationId is required for Core conversation send." };
    }
    return coreClient.call(`/api/conversations/${encodeURIComponent(request.conversationId)}/messages`, {
      method: "POST",
      body: JSON.stringify(request.body)
    });
  };
}

module.exports = {
  createChatSendDelegator,
  coreConversationMessageRequest,
  coreChatPayload
};
