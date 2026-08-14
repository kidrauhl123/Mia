"use strict";

const { MemberKind } = require("../shared/conversation-kinds.js");

function cleanText(value = "") {
  return String(value || "").trim();
}

function configuredHostBotId(conversation = {}) {
  const decorations = conversation?.decorations;
  const hasDecoratedHost = decorations && Object.prototype.hasOwnProperty.call(decorations, "hostMember");
  const host = hasDecoratedHost ? decorations.hostMember : conversation?.hostMember;
  return cleanText(host?.botId || host?.bot_id || host?.memberRef || host?.member_ref || host?.ref || host?.id);
}

function groupBotMembers(members = []) {
  return (Array.isArray(members) ? members : []).filter((member) => (
    member?.member_kind === MemberKind.Bot && cleanText(member.member_ref)
  ));
}

function selectGroupHostMember(conversation, members) {
  const bots = groupBotMembers(members);
  const configuredId = configuredHostBotId(conversation);
  return bots.find((member) => member.member_ref === configuredId) || bots[0] || null;
}

function decorationsWithGroupHost(conversation = {}, member = null) {
  const decorations = { ...(conversation?.decorations || {}) };
  if (member?.member_ref) {
    decorations.hostMember = { kind: MemberKind.Bot, botId: member.member_ref };
  } else {
    decorations.hostMember = null;
  }
  return decorations;
}

function ensureGroupHost(socialStore, conversationId) {
  const conversation = socialStore.getConversation(conversationId);
  if (!conversation || conversation.type !== "group") return { conversation, member: null };
  const member = selectGroupHostMember(conversation, socialStore.listConversationMembers(conversationId));
  const configuredId = configuredHostBotId(conversation);
  const selectedId = cleanText(member?.member_ref);
  if (configuredId !== selectedId || (!conversation.decorations?.hostMember && selectedId)) {
    const updated = socialStore.updateConversation(conversationId, {
      decorations: decorationsWithGroupHost(conversation, member)
    });
    return { conversation: updated, member };
  }
  return { conversation, member };
}

module.exports = {
  configuredHostBotId,
  decorationsWithGroupHost,
  ensureGroupHost,
  groupBotMembers,
  selectGroupHostMember
};
