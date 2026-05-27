"use strict";

const { SenderKind } = require("../../shared/conversation-kinds.js");
const { activeSkillIdsFromMessage } = require("./local-fellow-responder.js");

function contextLines(recentMessages) {
  return (Array.isArray(recentMessages) ? recentMessages : [])
    .map((message) => {
      const senderKind = String(message?.sender_kind || "");
      const senderRef = String(message?.sender_ref || "");
      const tag = senderKind === SenderKind.Fellow
        ? `fellow:${senderRef}`
        : (senderKind === SenderKind.System ? "system" : `user:${senderRef}`);
      return `[${tag}] ${message?.body_md || ""}`;
    })
    .join("\n");
}

function buildInvocation(payload, fellows) {
  const { conversationId, fellowId, invokedBy, triggeringMessage, recentMessages } = payload || {};
  const triggerId = triggeringMessage && triggeringMessage.id;
  if (!conversationId || !fellowId || !triggerId) return null;
  const fellow = (Array.isArray(fellows) ? fellows : []).find((item) => (item.key || item.id) === fellowId);
  if (!fellow) return null;

  const invoker = (invokedBy && (invokedBy.username || invokedBy.account || invokedBy.id)) || "someone";
  return {
    conversationId,
    fellowId,
    dedupKey: `${triggerId}:${fellowId}`,
    systemPrompt: `你是 ${fellow.name || fellowId}，正在一个跨用户群聊里。最近的消息上下文：\n${contextLines(recentMessages)}\n\n刚刚 ${invoker} 在群里 @ 了你。请用自然的口吻接话，简短直接。`,
    userPrompt: triggeringMessage.body_md || "",
    turnId: triggeringMessage.turn_id || null,
    activeSkillIds: activeSkillIdsFromMessage(triggeringMessage)
  };
}

module.exports = { buildInvocation };
