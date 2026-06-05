"use strict";

const { normalizeCloudConversationId } = require("./task-conversation.js");

function postedMessageId(result, fallbackMessageId = "") {
  return String(
    result?.message?.id
    || result?.data?.message?.id
    || result?.id
    || fallbackMessageId
    || ""
  );
}

async function deliverTaskReplyToConversation({
  socialApi,
  settingsStore,
  bot,
  conversationId,
  fallbackConversationId = "",
  assistantText,
  assistantTracePayload = {},
  taskRunId = "",
  fallbackMessageId = ""
} = {}) {
  const text = String(assistantText || "").trim();
  if (!text) return { messageId: fallbackMessageId || "", skipped: true };

  const cloud = settingsStore?.cloudSettings?.() || {};
  if (!cloud.enabled || !cloud.token || !cloud.user?.id) {
    throw new Error("Mia Cloud not logged in; cannot deliver scheduled task reply to the conversation.");
  }

  const targetConversationId = normalizeCloudConversationId(conversationId || fallbackConversationId);
  if (!targetConversationId) {
    throw new Error("Task reply conversation id is missing.");
  }

  const trace = assistantTracePayload && typeof assistantTracePayload === "object"
    ? assistantTracePayload
    : {};
  const replyBot = bot || {};
  const result = await socialApi.postConversationMessageAsBot(targetConversationId, {
    botId: replyBot?.key || replyBot?.id || "",
    bodyMd: text,
    ...(Object.keys(trace).length ? { trace } : {}),
    clientOpId: `op_task_${taskRunId || targetConversationId}_${fallbackMessageId || "reply"}`
  });
  return {
    result,
    conversationId: targetConversationId,
    messageId: postedMessageId(result, fallbackMessageId)
  };
}

module.exports = {
  deliverTaskReplyToConversation,
  postedMessageId
};
