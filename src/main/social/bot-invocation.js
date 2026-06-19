"use strict";

const { MemberKind, SenderKind } = require("../../shared/conversation-kinds.js");
const { activeSkillIdsFromMessage } = require("./local-bot-responder.js");

const HISTORY_MESSAGE_LIMIT = 80;
const HISTORY_MESSAGE_CHAR_LIMIT = 4000;
const HISTORY_TOTAL_CHAR_LIMIT = 24000;

function senderTag(message) {
  const senderKind = String(message?.sender_kind || "");
  const senderRef = String(message?.sender_ref || "");
  if (senderKind === SenderKind.Bot) return `bot:${senderRef}`;
  if (senderKind === SenderKind.System) return "system";
  return `user:${senderRef}`;
}

function historyRole(message) {
  const senderKind = String(message?.sender_kind || "");
  if (senderKind === SenderKind.Bot) return "assistant";
  if (senderKind === SenderKind.System) return "system";
  return "user";
}

function truncateText(text, limit = HISTORY_MESSAGE_CHAR_LIMIT) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function memberName(member, bots) {
  if (member?.member_kind === MemberKind.Bot) {
    const bot = (Array.isArray(bots) ? bots : [])
      .find((item) => (item.key || item.id) === member.member_ref);
    return bot?.name || bot?.displayName || member.bot_name || member.bot_name || member.member_ref || "Bot";
  }
  const user = member?.user && typeof member.user === "object" ? member.user : null;
  return member?.username || member?.displayName || member?.display_name || user?.username || user?.displayName || member?.member_ref || "用户";
}

function memberLines(members, bots) {
  return (Array.isArray(members) ? members : [])
    .map((member) => {
      const kind = member?.member_kind === MemberKind.Bot ? "bot" : MemberKind.User;
      return `- ${memberName(member, bots)} (${kind}:${member?.member_ref || ""})`;
    })
    .join("\n");
}

function conversationTypeFromPayload(payload = {}) {
  const explicit = String(payload.conversationType || payload.conversation_type || payload.conversation?.type || "").trim();
  if (explicit) return explicit;
  const id = String(payload.conversationId || "").trim();
  if (id.startsWith("g_") || id.startsWith("g-")) return "group";
  if (id.startsWith("dm:")) return "dm";
  if (id.startsWith("botc_") || id.startsWith("bot:")) return "bot";
  return "";
}

function isGroupConversation(payload = {}) {
  return conversationTypeFromPayload(payload) === "group";
}

function historyMessageContent(message, groupConversation) {
  const body = truncateText(message?.body_md || message?.bodyMd || message?.content || "");
  if (!body) return "";
  return groupConversation ? `[${senderTag(message)}] ${body}` : body;
}

function triggerPrompt(message) {
  return String(message?.task_prompt || message?.taskPrompt || message?.body_md || message?.bodyMd || "").trim();
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
  return raw
    .filter((attachment) => attachment && typeof attachment === "object")
    .slice(0, 20);
}

function buildHistoryMessages({ recentMessages, triggeringMessage, groupConversation }) {
  const triggerId = String(triggeringMessage?.id || "");
  const rows = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((message) => {
      if (!message) return false;
      if (triggerId && String(message.id || "") === triggerId) return false;
      return true;
    })
    .map((message) => ({
      role: historyRole(message),
      content: historyMessageContent(message, groupConversation)
    }))
    .filter((message) => message.content)
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

function buildBotInvocation(payload, bots) {
  const { conversationId, botId, triggeringMessage, recentMessages, members, runtimeConfig } = payload || {};
  const triggerId = triggeringMessage && triggeringMessage.id;
  if (!conversationId || !botId || !triggerId) return null;
  const bot = (Array.isArray(bots) ? bots : []).find((item) => (item.key || item.id) === botId)
    || (Array.isArray(members) ? members : [])
      .filter((member) => member?.member_kind === MemberKind.Bot)
      .map((member) => {
        if (String(member.member_ref || "") !== String(botId)) return null;
        return {
          key: botId,
          id: botId,
          name: member.bot_name || member.displayName || member.display_name || member.member_ref || botId
        };
      })
      .find(Boolean)
    || {
      key: botId,
      id: botId,
      name: botId
    };
  const botAgentEngine = String(bot.agentEngine || bot.agent_engine || "").trim();
  const nextRuntimeConfig = runtimeConfig && typeof runtimeConfig === "object" ? { ...runtimeConfig } : null;
  const runtimeAgentEngine = String(nextRuntimeConfig?.agentEngine || nextRuntimeConfig?.agent_engine || "").trim();
  if (botAgentEngine && (!runtimeAgentEngine || runtimeAgentEngine === "hermes")) {
    if (nextRuntimeConfig) nextRuntimeConfig.agentEngine = botAgentEngine;
  }
  const botSnapshot = {
    ...bot,
    key: bot.key || bot.id || botId,
    id: bot.id || bot.key || botId,
    name: bot.name || bot.displayName || bot.display_name || botId,
    ...(botAgentEngine ? { agentEngine: botAgentEngine } : {}),
    ...(runtimeAgentEngine && !botAgentEngine ? { agentEngine: runtimeAgentEngine } : {})
  };

  const roster = memberLines(members, bots);
  const groupConversation = isGroupConversation(payload);
  const historyMessages = buildHistoryMessages({ recentMessages, triggeringMessage, groupConversation });
  return {
    conversationId,
    botId,
    conversationType: conversationTypeFromPayload(payload),
    botSnapshot,
    dedupKey: `${triggerId}:${botId}`,
    triggerMessageId: triggerId,
    triggerSeq: Number(triggeringMessage?.seq) || 0,
    systemPrompt: [
      groupConversation
        ? `你是 ${botSnapshot.name || botSnapshot.displayName || botId}，正在一个群聊里。`
        : `你是 ${botSnapshot.name || botSnapshot.displayName || botId}，正在和用户私聊。`,
      groupConversation && roster ? `群成员：\n${roster}` : "",
      "请用自然的口吻接话，简短直接。"
    ].filter(Boolean).join("\n\n"),
    historyMessages,
    userPrompt: triggerPrompt(triggeringMessage),
    userAttachments: messageAttachments(triggeringMessage),
    runtimeConfig: nextRuntimeConfig,
    turnId: triggeringMessage.turn_id || null,
    activeSkillIds: activeSkillIdsFromMessage(triggeringMessage)
  };
}

module.exports = { buildBotInvocation };
