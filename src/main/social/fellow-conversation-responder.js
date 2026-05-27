"use strict";

const { MemberKind, SenderKind } = require("../../shared/conversation-kinds.js");
const { activeSkillIdsFromMessage } = require("./local-fellow-responder.js");

const PROCESSED_CAP = 500;

function inferConversationType(conversation) {
  if (!conversation) return null;
  if (conversation.type) return conversation.type;
  if (String(conversation.id || "").startsWith("fellow:")) return "fellow";
  return null;
}

function normalizeMessages(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.messages)) return result.messages;
  return [];
}

function normalizeConversations(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.conversations)) return result.conversations;
  return [];
}

function fellowIdForConversation(conversation, members, currentUserId) {
  const decorated = conversation?.decorations?.fellowKey || conversation?.decorations?.fellowId || conversation?.fellowKey;
  if (decorated) return String(decorated);
  const parts = String(conversation?.id || "").split(":");
  if (parts[0] === "fellow" && parts[1] === currentUserId && parts[2]) return parts[2];
  const fellowMember = (Array.isArray(members) ? members : [])
    .find((member) => member?.member_kind === MemberKind.Fellow && member.owner_id === currentUserId);
  return fellowMember?.member_ref || null;
}

function formatRecentMessages(messages) {
  return normalizeMessages(messages)
    .map((message) => {
      const sender = message.sender_kind === SenderKind.Fellow
        ? `fellow:${message.sender_ref || ""}`
        : `user:${message.sender_ref || ""}`;
      return `[${sender}] ${message.body_md || ""}`;
    })
    .join("\n");
}

function normalizeRuntimeBinding(result) {
  const binding = result?.binding || result?.data?.binding || result;
  if (!binding || typeof binding !== "object") return null;
  return binding;
}

function createMainFellowConversationResponder({
  getCurrentUserId,
  getConversationDetails,
  listConversations = async () => [],
  listRecentMessages,
  getFellowRuntime = async () => null,
  responder,
  log = () => {}
}) {
  const processed = new Set();
  const inFlight = new Set();

  function markProcessed(key) {
    processed.add(key);
    if (processed.size > PROCESSED_CAP) processed.delete(processed.values().next().value);
  }

  async function handleConversationMessageAppended(payload) {
    const { conversationId, message } = payload || {};
    if (!conversationId || !message?.id) return;
    if (message.sender_kind !== SenderKind.User) return;
    if (processed.has(message.id)) return;

    const currentUserId = getCurrentUserId();
    if (!currentUserId) return;
    if (message.sender_ref && message.sender_ref !== currentUserId) return;
    if (inFlight.has(message.id)) return;
    inFlight.add(message.id);

    try {
      let details;
      try {
        details = await getConversationDetails(conversationId);
      } catch (error) {
        log(`[main-fellow-conversation-responder] get conversation failed: ${error?.message || error}`);
        try {
          const conversation = normalizeConversations(await listConversations()).find((candidate) => candidate?.id === conversationId);
          if (conversation) details = { conversation, members: [] };
        } catch (listError) {
          log(`[main-fellow-conversation-responder] list conversations fallback failed: ${listError?.message || listError}`);
        }
        if (!details) return;
      }

      const conversation = details?.conversation || details;
      if (inferConversationType(conversation) !== "fellow") return;
      const runtimeKind = String(conversation?.decorations?.runtimeKind || "").trim() || "desktop-local";
      if (runtimeKind !== "desktop-local") return;
      const members = Array.isArray(details?.members) ? details.members : [];
      const fellowId = fellowIdForConversation(conversation, members, currentUserId);
      if (!fellowId) return;
      const ownedMember = members.find((member) =>
        member.member_kind === MemberKind.Fellow
        && member.member_ref === fellowId
        && member.owner_id === currentUserId
      );
      if (members.length && !ownedMember) return;

      const sinceSeq = Math.max(0, Number(message.seq || 0) - 6);
      const recentMessages = normalizeMessages(await listRecentMessages(conversationId, sinceSeq, 6));
      let runtimeConfig = {};
      try {
        const binding = normalizeRuntimeBinding(await getFellowRuntime(fellowId, runtimeKind));
        runtimeConfig = binding?.enabled !== false && binding?.config && typeof binding.config === "object" ? binding.config : {};
      } catch (error) {
        log(`[main-fellow-conversation-responder] get runtime failed: ${error?.message || error}`);
      }
      const didRespond = await responder.respond({
        conversationId,
        fellowId,
        dedupKey: `${message.id}:${fellowId}`,
        runtimeConfig,
        systemPrompt: [
          `你是 ${fellowId}，正在和用户进行一对一私聊。`,
          "最近消息上下文：",
          formatRecentMessages(recentMessages)
        ].join("\n"),
        userPrompt: message.body_md || "",
        turnId: message.turn_id || null,
        activeSkillIds: activeSkillIdsFromMessage(message)
      });
      if (didRespond) markProcessed(message.id);
    } finally {
      inFlight.delete(message.id);
    }
  }

  return { handleConversationMessageAppended };
}

module.exports = {
  createMainFellowConversationResponder,
  fellowIdForConversation
};
