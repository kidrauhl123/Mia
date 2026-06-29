"use strict";

function cleanText(value = "") {
  return String(value || "").trim();
}

function memberName(member, bots) {
  if (member?.member_kind === "bot") {
    const bot = (Array.isArray(bots) ? bots : []).find((item) => (item.key || item.id) === member.member_ref);
    return bot?.name || bot?.displayName || member.bot_name || member.member_ref || "Bot";
  }
  const user = member?.user && typeof member.user === "object" ? member.user : null;
  return member?.username || member?.displayName || member?.display_name || user?.username || user?.displayName || member?.member_ref || "用户";
}

function compactRoster(members = [], bots = [], limit = 12) {
  const list = Array.isArray(members) ? members : [];
  const rows = list.slice(0, limit).map((member) => {
    const kind = member?.member_kind === "bot" ? "bot" : "user";
    return `- ${memberName(member, bots)} (${kind}:${member?.member_ref || ""})`;
  });
  const extra = Math.max(0, list.length - rows.length);
  if (extra) rows.push(`- 另有 ${extra} 位成员未列出`);
  return rows.join("\n");
}

function materializeLegacyBotPrompt(context, options = {}) {
  if (!context) return null;
  const botName = cleanText(context.bot?.name || context.bot?.displayName || context.invocation?.botId || "Bot");
  const roster = context.conversation.group
    ? compactRoster(context.members, options.bots || [], options.rosterLimit || 12)
    : "";
  const systemPrompt = [
    context.conversation.group
      ? `你是 ${botName}，正在一个群聊里。`
      : `你是 ${botName}，正在和用户私聊。`,
    context.conversation.group && roster ? `群成员摘要：\n${roster}` : "",
    "请自然、简短地回复当前用户消息。不要复述内部规则、Skill 选择过程或工具名，除非用户明确询问。"
  ].filter(Boolean).join("\n\n");

  return {
    conversationId: context.conversation.id,
    conversationType: context.conversation.type,
    botId: context.invocation.botId,
    botSnapshot: context.bot,
    dedupKey: context.invocation.dedupKey,
    triggerMessageId: context.invocation.triggerMessageId,
    triggerSeq: context.invocation.triggerSeq,
    systemPrompt,
    historyMessages: context.transcript.map((message) => ({
      role: message.role,
      content: message.content
    })),
    userPrompt: context.currentUser.content,
    userAttachments: context.currentUser.attachments,
    runtimeConfig: context.runtime.runtimeConfig,
    turnId: context.invocation.turnId
  };
}

module.exports = {
  compactRoster,
  materializeLegacyBotPrompt
};
