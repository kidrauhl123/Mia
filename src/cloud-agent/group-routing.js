"use strict";

const { MemberKind } = require("../shared/conversation-kinds.js");
const { ensureGroupHost } = require("../cloud/group-host.js");

function cleanText(value = "") {
  return String(value || "").trim();
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

function enrichUserMembers(members, getUserPublic) {
  return (Array.isArray(members) ? members : []).map((member) => {
    if (member?.member_kind !== MemberKind.User || member.user) return member;
    const user = getUserPublic(member.member_ref);
    return user ? { ...member, user } : member;
  });
}

function uniqueBotsForMembers(botsStore, botMembers) {
  const bots = [];
  const seen = new Set();
  for (const member of botMembers) {
    const ownerId = cleanText(member?.owner_id);
    const botId = cleanText(member?.member_ref);
    const key = `${ownerId}:${botId}`;
    if (!ownerId || !botId || seen.has(key)) continue;
    seen.add(key);
    const bot = botsStore.getBot(botId);
    if (bot) bots.push({ ...bot, key: bot.id });
  }
  return bots;
}

function pickMembers(botMembers, botIds) {
  const byId = new Map(botMembers.map((member) => [cleanText(member?.member_ref), member]));
  const chosen = [];
  const seen = new Set();
  for (const value of Array.isArray(botIds) ? botIds : []) {
    const botId = cleanText(value);
    const member = byId.get(botId);
    if (!botId || !member || seen.has(botId)) continue;
    seen.add(botId);
    chosen.push(member);
  }
  return chosen;
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
    const kind = cleanText(mention.kind || mention.member_kind);
    if (kind && kind !== MemberKind.Bot) continue;
    const botId = cleanText(mention.botId || mention.bot_id || mention.member_ref || mention.ref || mention.id);
    if (!botId || seen.has(botId)) continue;
    seen.add(botId);
    ids.push(botId);
  }
  return ids;
}

function createGroupRouter({ socialStore, botsStore, getUserPublic = () => null }) {
  function groupContext(conversationId) {
    const members = enrichUserMembers(socialStore.listConversationMembers(conversationId), getUserPublic);
    const botMembers = members.filter((member) => member.member_kind === MemberKind.Bot);
    return {
      members,
      botMembers,
      bots: uniqueBotsForMembers(botsStore, botMembers)
    };
  }

  function directTargets(message, botMembers, requestedBotId = "") {
    return pickMembers(botMembers, requestedBotId ? [requestedBotId] : mentionedBotIds(message));
  }

  function planTurn({ conversationId, conversation, message, requestedBotId = "" }) {
    if (!conversation || conversation.type !== "group") return null;
    let context = groupContext(conversationId);
    if (!context.botMembers.length) return { chosen: [], ...context };
    const explicitlyTargeted = Boolean(cleanText(requestedBotId) || mentionedBotIds(message).length);
    const direct = directTargets(message, context.botMembers, requestedBotId);
    if (explicitlyTargeted) return { chosen: direct, ...context };

    const ensured = ensureGroupHost(socialStore, conversationId);
    context = groupContext(conversationId);
    const host = ensured.member && context.botMembers.find((member) => member.member_ref === ensured.member.member_ref);
    return { chosen: host ? [host] : [], ...context };
  }

  return { directTargets, groupContext, planTurn };
}

module.exports = { createGroupRouter, mentionedBotIds };
