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

function buildBotInvocation(payload, bots) {
  const { conversationId, botId, triggeringMessage, recentMessages, members, runtimeConfig } = payload || {};
  const triggerId = triggeringMessage && triggeringMessage.id;
  if (!conversationId || !botId || !triggerId) return null;
  const bot = (Array.isArray(bots) ? bots : []).find((item) => (item.key || item.id) === botId);
  if (!bot) return null;

  const roster = memberLines(members, bots);
  return {
    conversationId,
    botId,
    dedupKey: `${triggerId}:${botId}`,
    systemPrompt: [
      `你是 ${bot.name || bot.displayName || botId}，正在一个群聊里。`,
      roster ? `群成员：\n${roster}` : "",
      `最近的消息上下文：\n${contextLines(recentMessages)}`,
      "请用自然的口吻接话，简短直接。"
    ].filter(Boolean).join("\n\n"),
    userPrompt: triggeringMessage.body_md || "",
    runtimeConfig: runtimeConfig && typeof runtimeConfig === "object" ? runtimeConfig : null,
    turnId: triggeringMessage.turn_id || null,
    activeSkillIds: activeSkillIdsFromMessage(triggeringMessage)
  };
}

module.exports = { buildBotInvocation };
