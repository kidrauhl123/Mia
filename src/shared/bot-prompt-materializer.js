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
  return member?.displayName || member?.display_name || member?.username || user?.displayName || user?.username || member?.member_ref || "用户";
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
  const groupName = cleanText(context.conversation.name).slice(0, 80);
  const groupBackground = cleanText(context.conversation.decorations?.pinnedGoal).slice(0, 500);
  const speakerMember = context.conversation.group
    ? (Array.isArray(context.members) ? context.members : []).find((member) => (
        cleanText(member?.member_kind || member?.memberKind) === cleanText(context.currentUser.sender.kind)
          && cleanText(member?.member_ref || member?.memberRef) === cleanText(context.currentUser.sender.ref)
      ))
    : null;
  const speaker = speakerMember
    ? `${memberName(speakerMember, options.bots || [])} (${context.currentUser.sender.kind}:${context.currentUser.sender.ref})`
    : "";
  const systemPrompt = [
    context.conversation.group
      ? `你是 ${botName}，正在${groupName ? `群聊「${groupName}」` : "一个群聊"}里。`
      : `你是 ${botName}，正在和用户私聊。`,
    context.conversation.group && speaker ? `当前发言者：${speaker}` : "",
    context.conversation.group && roster ? `群成员摘要：\n${roster}` : "",
    context.conversation.group && groupBackground
      ? `群背景（由群成员明确设置）：${groupBackground}`
      : "",
    context.conversation.group
      ? "区分不同真人的身份和观点。只把群成员明确设置的背景和聊天内容当作关系依据，不要自行猜测谁是情侣、朋友或室友。"
      : "",
    context.conversation.group
      ? "你可以使用 team_send_message 将明确任务委派给群内其他 Bot。只有确实需要分工时才使用；不要用普通 @ 文本代替工具调用。"
      : "",
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
    historyMessages: [],
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
