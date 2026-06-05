"use strict";

const { MemberKind, SenderKind } = require("./conversation-kinds.js");

const DEFAULT_DISPATCH_PROMPT = [
  "你正在协调一个多 Bot 群聊。你的任务：根据最近的群上下文，决定接下来该让哪个或哪几个 Bot 发言。",
  "",
  "群成员（不含用户自己）：",
  "{{members}}",
  "",
  "群摘要：",
  "{{summary}}",
  "",
  "最近 6 条消息：",
  "{{recent}}",
  "",
  "用户刚发了：",
  "{{userMessage}}",
  "",
  "输出 JSON，仅一行，格式：",
  "{\"speak\": [\"<botId>\", ...]}",
  "- 选 1 到 3 个 botId",
  "- 如果用户点名某个 Bot，只能选择被点名的 Bot",
  "- 不要解释，只输出 JSON"
].join("\n");

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function messageHasMentions(message = {}) {
  return parseJsonArray(message.mentions).length > 0 || parseJsonArray(message.mentions_json).length > 0;
}

function messageMentionedBotIds(message = {}) {
  const mentions = [
    ...parseJsonArray(message.mentions),
    ...parseJsonArray(message.mentions_json)
  ];
  const ids = [];
  const seen = new Set();
  for (const mention of mentions) {
    if (!mention || typeof mention !== "object") continue;
    const kind = String(mention.kind || mention.member_kind || "").trim();
    if (kind && kind !== MemberKind.Bot) continue;
    const botId = String(mention.botId || mention.bot_id || mention.member_ref || mention.ref || mention.id || "").trim();
    if (!botId || seen.has(botId)) continue;
    seen.add(botId);
    ids.push(botId);
  }
  return ids;
}

function normalizeComparable(value) {
  return String(value || "").trim().toLowerCase();
}

function botForMember(member, bots) {
  const ref = member?.member_ref;
  return (Array.isArray(bots) ? bots : [])
    .find((item) => item?.id === ref || item?.key === ref) || null;
}

function textNamedBotIds(text, botMembers, bots) {
  const haystack = normalizeComparable(text);
  if (!haystack) return [];
  const matchedIds = [];
  for (const member of Array.isArray(botMembers) ? botMembers : []) {
    const bot = botForMember(member, bots);
    const candidates = [member?.member_ref, member?.bot_name, bot?.name, bot?.id, bot?.key];
    const matched = candidates.some((candidate) => {
      const needle = normalizeComparable(candidate);
      return needle.length >= 2 && haystack.includes(needle);
    });
    if (matched && member?.member_ref) matchedIds.push(member.member_ref);
  }
  return matchedIds;
}

function directBotIdsForMessage(message, botMembers, bots) {
  const candidates = Array.isArray(botMembers) ? botMembers : [];
  const candidateIds = new Set(candidates.map((member) => member?.member_ref).filter(Boolean));
  const mentionedIds = messageMentionedBotIds(message).filter((id) => candidateIds.has(id));
  if (mentionedIds.length) return mentionedIds.slice(0, 3);
  const namedIds = textNamedBotIds(message?.body_md || "", candidates, bots);
  return namedIds.slice(0, 3);
}

function fillTemplate(template, vars) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : ""
  );
}

function formatDispatchMembers(members) {
  return members.map((member) => `- ${member.name} (id=${member.id})`).join("\n");
}

function formatDispatchMessages(messages, botNamesById = {}) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (message.sender_kind === SenderKind.User) {
      return `${message.sender_username || message.sender_ref || "用户"}: ${message.body_md || ""}`;
    }
    const name = botNamesById[message.sender_ref] || message.sender_ref || "Bot";
    return `${name}: ${message.body_md || ""}`;
  }).join("\n");
}

function buildDispatchPrompt(template, ctx) {
  return fillTemplate(template || DEFAULT_DISPATCH_PROMPT, {
    members: formatDispatchMembers(ctx.members || []),
    summary: ctx.summary || "（暂无摘要）",
    recent: formatDispatchMessages(ctx.recentMessages, ctx.botNamesById || {}),
    userMessage: ctx.userMessage || ""
  });
}

function parseDispatchSpeak(text) {
  if (!text || typeof text !== "string") return [];
  try {
    const match = text.match(/\{[^}]*"speak"[^}]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    return Array.isArray(parsed?.speak)
      ? parsed.speak.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

module.exports = {
  DEFAULT_DISPATCH_PROMPT,
  buildDispatchPrompt,
  directBotIdsForMessage,
  botForMember,
  messageHasMentions,
  messageMentionedBotIds,
  parseDispatchSpeak
};
