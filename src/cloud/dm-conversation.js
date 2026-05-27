function dmConversationId(userA, userB) {
  const a = String(userA);
  const b = String(userB);
  if (a === b) throw new Error("DM requires two different users (got same user id)");
  return "dm:" + (a < b ? a + ":" + b : b + ":" + a);
}

function ensureDmConversation(socialStore, userA, userB) {
  if (!socialStore.areFriends(userA, userB)) {
    throw new Error("users are not friends — cannot create DM conversation");
  }
  const id = dmConversationId(userA, userB);
  const existing = socialStore.getConversation(id);
  if (existing) return existing;
  const conversation = socialStore.createConversation({
    id,
    name: null,
    avatar: null,
    hostMember: null,
    decorations: null,
    contextCard: null,
  });
  socialStore.addConversationMember({ conversationId: id, memberKind: "user", memberRef: String(userA), ownerId: null });
  socialStore.addConversationMember({ conversationId: id, memberKind: "user", memberRef: String(userB), ownerId: null });
  return conversation;
}

module.exports = { dmConversationId, ensureDmConversation };
