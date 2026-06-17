"use strict";

const { MemberKind, SenderKind } = require("../../shared/conversation-kinds.js");
const { activeSkillIdsFromMessage } = require("./local-bot-responder.js");

function contextLines(recentMessages) {
  return (Array.isArray(recentMessages) ? recentMessages : [])
    .map((message) => {
      const senderKind = String(message?.sender_kind || "");
      const senderRef = String(message?.sender_ref || "");
      const tag = senderKind === SenderKind.Bot
        ? `bot:${senderRef}`
        : (senderKind === SenderKind.System ? "system" : `user:${senderRef}`);
      return `[${tag}] ${message?.body_md || ""}`;
    })
    .join("\n");
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
  return {
    conversationId,
    botId,
    conversationType: conversationTypeFromPayload(payload),
    botSnapshot,
    dedupKey: `${triggerId}:${botId}`,
    systemPrompt: [
      groupConversation
        ? `你是 ${botSnapshot.name || botSnapshot.displayName || botId}，正在一个群聊里。`
        : `你是 ${botSnapshot.name || botSnapshot.displayName || botId}，正在和用户私聊。`,
      groupConversation && roster ? `群成员：\n${roster}` : "",
      `最近的消息上下文：\n${contextLines(recentMessages)}`,
      "请用自然的口吻接话，简短直接。"
    ].filter(Boolean).join("\n\n"),
    userPrompt: triggeringMessage.body_md || "",
    runtimeConfig: nextRuntimeConfig,
    turnId: triggeringMessage.turn_id || null,
    activeSkillIds: activeSkillIdsFromMessage(triggeringMessage)
  };
}

module.exports = { buildBotInvocation };
