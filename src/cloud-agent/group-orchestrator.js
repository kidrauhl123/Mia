"use strict";

const { MemberKind } = require("../shared/conversation-kinds.js");
const { normalizeCloudClaudeCodeModel } = require("./cloud-claude-code-model.js");

const BOT_MEMBER_KIND = "bot";

const DEFAULT_BOT_DISPATCH_PROMPT = [
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

const ORCHESTRATOR_BOT = Object.freeze({
  id: "group-orchestrator",
  key: "group-orchestrator",
  displayName: "Group Orchestrator",
  personaText: ""
});

function normalizeMessages(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.messages)) return result.messages;
  return [];
}

function enrichUserMembers(members, getUserPublic) {
  return (Array.isArray(members) ? members : []).map((member) => {
    if (member?.member_kind !== MemberKind.User || member.user) return member;
    const user = getUserPublic(member.member_ref);
    return user ? { ...member, user } : member;
  });
}

function recentMessagesForDispatch(messagesStore, conversationId, message) {
  const sinceSeq = Math.max(0, Number(message?.seq || 0) - 6);
  return normalizeMessages(messagesStore.listMessagesSince(conversationId, sinceSeq, 6));
}

function botForMember(member, bots) {
  const ref = member?.member_ref;
  return (Array.isArray(bots) ? bots : [])
    .find((item) => item?.id === ref || item?.key === ref) || null;
}

function botDisplayName(bot) {
  return bot?.displayName || bot?.display_name || bot?.name || "";
}

function memberDescriptors(botMembers, bots) {
  return botMembers.map((member) => {
    const bot = botForMember(member, bots);
    return {
      id: member.member_ref,
      name: botDisplayName(bot) || member.bot_name || member.member_ref
    };
  });
}

function botNamesById(botMembers, bots) {
  const names = {};
  for (const member of botMembers) {
    const bot = botForMember(member, bots);
    names[member.member_ref] = botDisplayName(bot) || member.bot_name || member.member_ref;
  }
  return names;
}

function uniqueBotsForMembers(botsStore, botMembers) {
  const bots = [];
  const seen = new Set();
  for (const member of botMembers) {
    const ownerId = String(member?.owner_id || "");
    const botId = String(member?.member_ref || "");
    const key = `${ownerId}:${botId}`;
    if (!ownerId || !botId || seen.has(key)) continue;
    seen.add(key);
    const bot = botsStore.getBot(botId);
    if (bot) bots.push({ ...bot, key: bot.id });
  }
  return bots;
}

function membersByBotId(botMembers) {
  const map = new Map();
  for (const member of botMembers) {
    if (member?.member_ref) map.set(member.member_ref, member);
  }
  return map;
}

function pickMembers(botMembers, botIds) {
  const map = membersByBotId(botMembers);
  const chosen = [];
  const seen = new Set();
  for (const botId of botIds) {
    if (!botId || seen.has(botId)) continue;
    const member = map.get(botId);
    if (!member) continue;
    seen.add(botId);
    chosen.push(member);
    if (chosen.length >= 3) break;
  }
  return chosen;
}

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
    if (message.sender_kind === MemberKind.User) {
      return `${message.sender_username || message.sender_ref || "用户"}: ${message.body_md || ""}`;
    }
    const name = botNamesById[message.sender_ref] || message.sender_ref || "Bot";
    return `${name}: ${message.body_md || ""}`;
  }).join("\n");
}

function buildBotDispatchPrompt(template, ctx) {
  return fillTemplate(template || DEFAULT_BOT_DISPATCH_PROMPT, {
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

function normalizeComparable(value) {
  return String(value || "").trim().toLowerCase();
}

function mentionedBotIds(message = {}) {
  const mentions = [
    ...parseJsonArray(message.mentions),
    ...parseJsonArray(message.mentions_json)
  ];
  const ids = [];
  const seen = new Set();
  for (const mention of mentions) {
    if (!mention || typeof mention !== "object") continue;
    const kind = String(mention.kind || mention.member_kind || "").trim();
    if (kind && kind !== BOT_MEMBER_KIND) continue;
    const botId = String(mention.botId || mention.bot_id || mention.member_ref || mention.ref || mention.id || "").trim();
    if (!botId || seen.has(botId)) continue;
    seen.add(botId);
    ids.push(botId);
  }
  return ids;
}

function textNamedBotIds(text, botMembers, bots) {
  const haystack = normalizeComparable(text);
  if (!haystack) return [];
  const matchedIds = [];
  for (const member of Array.isArray(botMembers) ? botMembers : []) {
    const bot = botForMember(member, bots);
    const candidates = [member?.member_ref, member?.bot_name, botDisplayName(bot), bot?.id, bot?.key];
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
  const mentionedIds = mentionedBotIds(message).filter((id) => candidateIds.has(id));
  if (mentionedIds.length) return mentionedIds.slice(0, 3);
  return textNamedBotIds(message?.body_md || "", candidates, bots).slice(0, 3);
}

function createGroupOrchestrator({
  socialStore,
  messagesStore,
  botsStore,
  workerManager,
  agentClient,
  loadPrompts = async () => ({ dispatch: DEFAULT_BOT_DISPATCH_PROMPT }),
  getUserPublic = () => null,
  log = () => {}
}) {
  const conductorClient = agentClient;

  async function runConductor({ userId, conversationId, conversation, message, botMembers, bots, recentMessages }) {
    const prompts = await loadPrompts().catch((error) => {
      log(`[group-orchestrator] load conductor prompts failed: ${error?.message || error}`);
      return null;
    });
    const template = prompts?.dispatch || DEFAULT_BOT_DISPATCH_PROMPT;
    const dispatchPrompt = buildBotDispatchPrompt(template, {
      members: memberDescriptors(botMembers, bots),
      summary: conversation.contextCard?.summary || conversation.decorations?.pinnedGoal || null,
      recentMessages,
      botNamesById: botNamesById(botMembers, bots),
      userMessage: message.body_md || ""
    });
    try {
      const worker = await workerManager.ensureWorker(userId);
      const result = await conductorClient.runChat({
        gatewayWsUrl: worker.gatewayWsUrl,
        apiKey: worker.apiKey,
        worker,
        userId,
        bot: ORCHESTRATOR_BOT,
        conversationId,
        transient: true,
        model: normalizeCloudClaudeCodeModel("", { defaultModel: worker.model }),
        workerModel: worker.workerModel || worker.platformModel || worker.model || "mia-auto",
        modelProvider: worker.modelProvider || "mia",
        effortLevel: "medium",
        permissionMode: worker.permissionMode || "ask",
        input: dispatchPrompt,
        attachments: []
      });
      return parseDispatchSpeak(result.content || "");
    } catch (error) {
      log(`[group-orchestrator] conductor dispatch failed: ${error?.message || error}`);
      return [];
    }
  }

  async function chooseTargets({ userId, conversationId, conversation, message, requestedBotId = "" }) {
    if (!conversation || conversation.type !== "group") return null;
    const members = enrichUserMembers(socialStore.listConversationMembers(conversationId), getUserPublic);
    const botMembers = members.filter((member) => member.member_kind === BOT_MEMBER_KIND);
    const bots = uniqueBotsForMembers(botsStore, botMembers);
    const recentMessages = recentMessagesForDispatch(messagesStore, conversationId, message);
    const context = { members, bots, recentMessages };

    if (!botMembers.length) return { chosen: [], ...context };

    if (requestedBotId) {
      return { chosen: pickMembers(botMembers, [requestedBotId]), ...context };
    }

    if (botMembers.length === 1) {
      return { chosen: [botMembers[0]], ...context };
    }

    const directIds = directBotIdsForMessage(message, botMembers, bots);
    if (directIds.length) {
      return { chosen: pickMembers(botMembers, directIds), ...context };
    }

    const spoken = await runConductor({
      userId,
      conversationId,
      conversation,
      message,
      botMembers,
      bots,
      recentMessages
    });
    const chosenByLlm = pickMembers(botMembers, spoken);
    if (chosenByLlm.length) return { chosen: chosenByLlm, ...context };

    // Conductor returned nothing usable, so let the first bot keep the conversation alive.
    return { chosen: [botMembers[0]], ...context };
  }

  return { chooseTargets };
}

module.exports = {
  ORCHESTRATOR_BOT,
  DEFAULT_BOT_DISPATCH_PROMPT,
  createGroupOrchestrator
};
