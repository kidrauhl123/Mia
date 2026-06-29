"use strict";

const { MemberKind, SenderKind } = require("./conversation-kinds.js");

const HISTORY_MESSAGE_LIMIT = 80;
const HISTORY_MESSAGE_CHAR_LIMIT = 4000;
const HISTORY_TOTAL_CHAR_LIMIT = 24000;

function cleanText(value = "") {
  return String(value || "").trim();
}

function truncateText(text, limit = HISTORY_MESSAGE_CHAR_LIMIT) {
  const value = cleanText(text);
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function senderTag(message) {
  const senderKind = cleanText(message?.sender_kind || message?.senderKind);
  const senderRef = cleanText(message?.sender_ref || message?.senderRef);
  if (senderKind === SenderKind.Bot || senderKind === "bot") return `bot:${senderRef}`;
  return `user:${senderRef}`;
}

function conversationTypeFromPayload(payload = {}) {
  const explicit = cleanText(payload.conversationType || payload.conversation_type || payload.conversation?.type);
  if (explicit) return explicit;
  const id = cleanText(payload.conversationId);
  if (id.startsWith("g_") || id.startsWith("g-")) return "group";
  if (id.startsWith("dm:")) return "dm";
  if (id.startsWith("botc_") || id.startsWith("bot:")) return "bot";
  return "";
}

function isGeneratedFailure(content = "") {
  const text = cleanText(content);
  return /^我这次没能生成回复：/.test(text)
    || /^模型调用失败：/.test(text)
    || /^[^\s]+ 当前离线，打开该设备上的 Mia 后再试。$/.test(text);
}

function historyRoleFor(message, botId) {
  const senderKind = cleanText(message?.sender_kind || message?.senderKind);
  const senderRef = cleanText(message?.sender_ref || message?.senderRef);
  if (senderKind === SenderKind.System || senderKind === "system") return "omit";
  if ((senderKind === SenderKind.Bot || senderKind === "bot") && senderRef === cleanText(botId)) return "assistant";
  return "user";
}

function messagePromptContent(message, groupConversation) {
  const body = truncateText(message?.body_md || message?.bodyMd || message?.content || "");
  if (!body) return "";
  return groupConversation ? `[${senderTag(message)}] ${body}` : body;
}

function safeJsonArray(input) {
  if (Array.isArray(input)) return input;
  if (!input) return [];
  try {
    const parsed = JSON.parse(String(input));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function messageAttachments(message = {}) {
  const raw = Array.isArray(message.attachments)
    ? message.attachments
    : safeJsonArray(message.attachments_json || message.attachmentsJson);
  return raw.filter((attachment) => attachment && typeof attachment === "object").slice(0, 20);
}

function triggerPrompt(message = {}) {
  return cleanText(message.task_prompt || message.taskPrompt || message.body_md || message.bodyMd);
}

function botSnapshotFor(payload = {}, bots = []) {
  const botId = cleanText(payload.botId);
  const bot = (Array.isArray(bots) ? bots : []).find((item) => cleanText(item.key || item.id) === botId)
    || (Array.isArray(payload.members) ? payload.members : [])
      .filter((member) => member?.member_kind === MemberKind.Bot || member?.member_kind === "bot")
      .map((member) => cleanText(member.member_ref) === botId ? {
        key: botId,
        id: botId,
        name: member.bot_name || member.displayName || member.display_name || member.member_ref || botId
      } : null)
      .find(Boolean)
    || { key: botId, id: botId, name: botId };
  return {
    ...bot,
    key: bot.key || bot.id || botId,
    id: bot.id || bot.key || botId,
    name: bot.name || bot.displayName || bot.display_name || botId
  };
}

function buildTranscript({ recentMessages = [], triggeringMessage = {}, groupConversation = false, botId = "" } = {}) {
  const triggerId = cleanText(triggeringMessage.id);
  const rows = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((message) => {
      if (!message) return false;
      if (triggerId && cleanText(message.id) === triggerId) return false;
      if (isGeneratedFailure(message.body_md || message.bodyMd || message.content)) return false;
      return true;
    })
    .map((message) => ({
      role: historyRoleFor(message, botId),
      content: messagePromptContent(message, groupConversation),
      messageId: cleanText(message.id),
      speaker: {
        kind: cleanText(message.sender_kind || message.senderKind),
        ref: cleanText(message.sender_ref || message.senderRef)
      }
    }))
    .filter((message) => message.role !== "omit" && message.content)
    .slice(-HISTORY_MESSAGE_LIMIT);

  const selected = [];
  let total = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const message = rows[index];
    const nextTotal = total + message.content.length;
    if (selected.length && nextTotal > HISTORY_TOTAL_CHAR_LIMIT) break;
    selected.push(message);
    total = nextTotal;
  }
  return selected.reverse();
}

function buildBotTurnContext(payload = {}, options = {}) {
  const conversationId = cleanText(payload.conversationId);
  const botId = cleanText(payload.botId);
  const triggeringMessage = payload.triggeringMessage || {};
  const triggerId = cleanText(triggeringMessage.id);
  if (!conversationId || !botId || !triggerId) return null;
  const conversationType = conversationTypeFromPayload(payload);
  const groupConversation = conversationType === "group";
  const bot = botSnapshotFor(payload, options.bots || []);
  return {
    conversation: { id: conversationId, type: conversationType, group: groupConversation },
    bot,
    invocation: {
      botId,
      triggerMessageId: triggerId,
      triggerSeq: Number(triggeringMessage.seq) || 0,
      dedupKey: `${triggerId}:${botId}`,
      turnId: triggeringMessage.turn_id || triggeringMessage.turnId || null
    },
    transcript: buildTranscript({
      recentMessages: payload.recentMessages,
      triggeringMessage,
      groupConversation,
      botId
    }),
    currentUser: {
      content: triggerPrompt(triggeringMessage),
      attachments: messageAttachments(triggeringMessage),
      sender: {
        kind: cleanText(triggeringMessage.sender_kind || triggeringMessage.senderKind),
        ref: cleanText(triggeringMessage.sender_ref || triggeringMessage.senderRef)
      }
    },
    members: Array.isArray(payload.members) ? payload.members : [],
    runtime: {
      runtimeConfig: payload.runtimeConfig && typeof payload.runtimeConfig === "object" ? payload.runtimeConfig : null
    }
  };
}

module.exports = {
  buildBotTurnContext,
  conversationTypeFromPayload,
  historyRoleFor,
  senderTag
};
