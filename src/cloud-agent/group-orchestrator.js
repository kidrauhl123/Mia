"use strict";

const { GroupCoordinator, MemberKind } = require("../shared/conversation-kinds.js");
const { normalizeCloudClaudeCodeModel } = require("./cloud-claude-code-model.js");

const BOT_MEMBER_KIND = MemberKind.Bot;
const COORDINATOR_SKILL_ID = "mia-group-coordinator";
const DEFAULT_COORDINATOR_SKILL = [
  "Act as the group's primary conversational partner.",
  "Answer directly when delegation adds no value.",
  "Otherwise delegate distinct tasks to the smallest sufficient set of group Bots, without a fixed count.",
  "Keep user-facing updates concise and synthesize delegated results into one coherent answer."
].join("\n");

const ORCHESTRATOR_BOT = Object.freeze({
  id: GroupCoordinator.id,
  key: GroupCoordinator.id,
  displayName: GroupCoordinator.displayName,
  personaText: ""
});

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

function parseJsonObject(value) {
  const text = cleanText(value);
  if (!text) return null;
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) candidates.push(fenced.trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next representation.
    }
  }
  return null;
}

function enrichUserMembers(members, getUserPublic) {
  return (Array.isArray(members) ? members : []).map((member) => {
    if (member?.member_kind !== MemberKind.User || member.user) return member;
    const user = getUserPublic(member.member_ref);
    return user ? { ...member, user } : member;
  });
}

function botForMember(member, bots) {
  const ref = member?.member_ref;
  return (Array.isArray(bots) ? bots : [])
    .find((item) => item?.id === ref || item?.key === ref) || null;
}

function botDisplayName(bot) {
  return cleanText(bot?.displayName || bot?.display_name || bot?.name);
}

function botCapabilitySummary(bot = {}) {
  const description = cleanText(bot.bio || bot.description || bot.personaText || bot.persona_text);
  const capabilities = bot.capabilities;
  let capabilityText = "";
  if (Array.isArray(capabilities)) capabilityText = capabilities.map(cleanText).filter(Boolean).join(", ");
  else if (capabilities && typeof capabilities === "object") {
    const ids = [
      ...(Array.isArray(capabilities.enabledSkills) ? capabilities.enabledSkills : []),
      ...(Array.isArray(capabilities.skills) ? capabilities.skills : [])
    ].map(cleanText).filter(Boolean);
    capabilityText = ids.join(", ");
  }
  return [description, capabilityText ? `skills: ${capabilityText}` : ""]
    .filter(Boolean)
    .join("; ")
    .slice(0, 600);
}

function memberDescriptors(botMembers, bots) {
  return botMembers.map((member) => {
    const bot = botForMember(member, bots);
    return {
      id: member.member_ref,
      name: botDisplayName(bot) || member.bot_name || member.member_ref,
      capabilities: botCapabilitySummary(bot || {})
    };
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

function membersByBotId(botMembers) {
  const map = new Map();
  for (const member of botMembers) {
    const botId = cleanText(member?.member_ref);
    if (botId) map.set(botId, member);
  }
  return map;
}

function pickMembers(botMembers, botIds) {
  const map = membersByBotId(botMembers);
  const chosen = [];
  const seen = new Set();
  for (const value of Array.isArray(botIds) ? botIds : []) {
    const botId = cleanText(value);
    if (!botId || seen.has(botId)) continue;
    const member = map.get(botId);
    if (!member) continue;
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
    if (kind && kind !== BOT_MEMBER_KIND) continue;
    const botId = cleanText(mention.botId || mention.bot_id || mention.member_ref || mention.ref || mention.id);
    if (!botId || seen.has(botId)) continue;
    seen.add(botId);
    ids.push(botId);
  }
  return ids;
}

function coordinatorSkillBody(skillsCatalog = []) {
  const skill = (Array.isArray(skillsCatalog) ? skillsCatalog : []).find((item) => {
    const id = cleanText(item?.id || item?.key || item?.name);
    return id === COORDINATOR_SKILL_ID || id.endsWith(`:${COORDINATOR_SKILL_ID}`);
  });
  return cleanText(skill?.body || skill?.raw) || DEFAULT_COORDINATOR_SKILL;
}

function formatMembers(descriptors) {
  if (!descriptors.length) return "- No specialist Bots are currently in this group.";
  return descriptors.map((member) => [
    `- ${member.name} (botId=${member.id})`,
    member.capabilities ? `  ${member.capabilities}` : ""
  ].filter(Boolean).join("\n")).join("\n");
}

function memberName(member, members, bots) {
  if (member?.sender_kind === MemberKind.User) {
    const row = members.find((item) => item.member_kind === MemberKind.User && item.member_ref === member.sender_ref);
    return cleanText(row?.user?.displayName || row?.user?.display_name || row?.user?.username || member.sender_ref || "用户");
  }
  if (member?.sender_kind === BOT_MEMBER_KIND) {
    if (member.sender_ref === GroupCoordinator.id) return GroupCoordinator.displayName;
    const row = members.find((item) => item.member_kind === BOT_MEMBER_KIND && item.member_ref === member.sender_ref);
    return botDisplayName(botForMember(row, bots)) || cleanText(row?.bot_name || member.sender_ref || "Bot");
  }
  return "系统";
}

function formatRecentMessages(messages, members, bots) {
  const rows = Array.isArray(messages) ? messages : [];
  if (!rows.length) return "- No earlier messages.";
  return rows.map((message) => {
    const body = cleanText(message?.body_md).replace(/\s+/g, " ").slice(0, 500);
    return `- ${memberName(message, members, bots)}: ${body || "(empty message)"}`;
  }).join("\n");
}

function normalizeDelegations(value, botMembers, fallbackTask) {
  const memberMap = membersByBotId(botMembers);
  const delegations = [];
  const seen = new Set();
  for (const input of Array.isArray(value) ? value : []) {
    if (!input || typeof input !== "object") continue;
    const botId = cleanText(input.botId || input.bot_id || input.id);
    if (!botId || seen.has(botId) || !memberMap.has(botId)) continue;
    const task = cleanText(input.task || input.message || input.instruction || fallbackTask);
    if (!task) continue;
    seen.add(botId);
    delegations.push({ botId, task, member: memberMap.get(botId) });
  }
  return delegations;
}

function delegationUpdate(delegations, descriptors) {
  const names = new Map(descriptors.map((item) => [item.id, item.name]));
  return delegations.length
    ? `我来协调，正在请 ${delegations.map((item) => `@${names.get(item.botId) || item.botId}`).join("、")} 分工处理。`
    : "";
}

function createGroupOrchestrator({
  socialStore,
  messagesStore,
  botsStore,
  workerManager,
  agentClient,
  skillsCatalog = [],
  getUserPublic = () => null,
  log = () => {}
}) {
  const skillBody = coordinatorSkillBody(skillsCatalog);

  function groupContext(conversationId, userId) {
    const members = enrichUserMembers(socialStore.listConversationMembers(conversationId), getUserPublic);
    const botMembers = members.filter((member) => member.member_kind === BOT_MEMBER_KIND);
    const bots = uniqueBotsForMembers(botsStore, botMembers);
    const latest = messagesStore.listLatestMessages(conversationId, 12, userId);
    return {
      members,
      botMembers,
      bots,
      descriptors: memberDescriptors(botMembers, bots),
      recentMessages: Array.isArray(latest) ? latest : (latest?.messages || [])
    };
  }

  async function runCoordinator({ userId, conversationId, input }) {
    try {
      const worker = await workerManager.ensureWorker(userId);
      const result = await agentClient.runChat({
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
        instructions: skillBody,
        input,
        attachments: []
      });
      return cleanText(result?.content);
    } catch (error) {
      log(`[group-orchestrator] coordinator turn failed: ${error?.message || error}`);
      return "";
    }
  }

  function directTargets(message, botMembers, requestedBotId = "") {
    if (requestedBotId) return pickMembers(botMembers, [requestedBotId]);
    return pickMembers(botMembers, mentionedBotIds(message));
  }

  async function planTurn({ userId, conversationId, conversation, message, requestedBotId = "" }) {
    if (!conversation || conversation.type !== "group") return null;
    const context = groupContext(conversationId, userId);
    const direct = directTargets(message, context.botMembers, requestedBotId);
    if (direct.length) return { mode: "direct", chosen: direct, delegations: [], reply: "", ...context };

    const input = [
      "Coordinate this Mia group turn using the loaded group-coordination skill.",
      "Group Bot roster:",
      formatMembers(context.descriptors),
      "",
      "Recent group messages:",
      formatRecentMessages(
        context.recentMessages.filter((row) => row.id !== message?.id),
        context.members,
        context.bots
      ),
      "",
      "Current user message:",
      cleanText(message?.body_md),
      "",
      "Return the initial-turn JSON object required by the skill."
    ].join("\n");
    const raw = await runCoordinator({ userId, conversationId, input });
    const parsed = parseJsonObject(raw);
    const delegations = normalizeDelegations(parsed?.delegations, context.botMembers, message?.body_md);
    let reply = cleanText(parsed?.reply);
    if (!parsed && raw) reply = raw;
    if (!reply && delegations.length) reply = delegationUpdate(delegations, context.descriptors);
    if (!reply && !delegations.length) reply = "这条消息暂时没有得到有效的协调结果，请重试一次。";
    return { mode: "coordinator", reply, delegations, ...context };
  }

  async function synthesizeTurn({ userId, conversationId, originalMessage, delegations, replies }) {
    const context = groupContext(conversationId, userId);
    const names = new Map(context.descriptors.map((item) => [item.id, item.name]));
    const tasks = new Map((Array.isArray(delegations) ? delegations : []).map((item) => [item.botId, item.task]));
    const resultRows = (Array.isArray(replies) ? replies : []).map((reply) => [
      `- @${names.get(reply.sender_ref) || reply.sender_ref}`,
      `  assigned: ${tasks.get(reply.sender_ref) || "contribute relevant findings"}`,
      `  result: ${cleanText(reply.body_md)}`
    ].join("\n"));
    const input = [
      "Synthesize this delegated Mia group work using the loaded group-coordination skill.",
      "Original user message:",
      cleanText(originalMessage?.body_md),
      "",
      "Delegated results:",
      resultRows.join("\n") || "- No usable result was returned.",
      "",
      "Return the synthesis JSON object required by the skill."
    ].join("\n");
    const raw = await runCoordinator({ userId, conversationId, input });
    const parsed = parseJsonObject(raw);
    const reply = cleanText(parsed?.reply || (!parsed ? raw : ""));
    if (reply) return reply;
    return resultRows.length
      ? `分工结果已返回：\n${resultRows.map((row) => row.replace(/\n  assigned:[^\n]*/, "")).join("\n")}`
      : "这次分工没有返回可用结果。";
  }

  return { directTargets, groupContext, planTurn, synthesizeTurn };
}

module.exports = {
  COORDINATOR_SKILL_ID,
  DEFAULT_COORDINATOR_SKILL,
  ORCHESTRATOR_BOT,
  createGroupOrchestrator,
  parseJsonObject
};
