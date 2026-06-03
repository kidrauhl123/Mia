"use strict";

const CONVERSATION_SESSION_PREFIX = "conversation:";

function normalizeCloudConversationId(value) {
  const text = String(value || "").trim();
  if (text.startsWith(CONVERSATION_SESSION_PREFIX)) {
    return text.slice(CONVERSATION_SESSION_PREFIX.length);
  }
  return text;
}

function taskConversationFields(input = {}) {
  const rawConversationId = String(input.conversationId || "").trim();
  const rawSessionId = String(input.sessionId || "").trim();
  const source = rawConversationId || rawSessionId;
  return {
    conversationId: normalizeCloudConversationId(source),
    sessionId: rawSessionId || source
  };
}

function taskCloudConversationId(task = {}) {
  return normalizeCloudConversationId(task.conversationId || task.sessionId || "");
}

function taskAgentSessionId(task = {}) {
  return String(task.sessionId || task.conversationId || "").trim();
}

module.exports = {
  CONVERSATION_SESSION_PREFIX,
  normalizeCloudConversationId,
  taskAgentSessionId,
  taskCloudConversationId,
  taskConversationFields
};
