function dmRoomId(userA, userB) {
  const a = String(userA);
  const b = String(userB);
  if (a === b) throw new Error("DM requires two different users (got same user id)");
  return "dm:" + (a < b ? a + ":" + b : b + ":" + a);
}

function ensureDmRoom(socialStore, userA, userB) {
  if (!socialStore.areFriends(userA, userB)) {
    throw new Error("users are not friends — cannot create DM room");
  }
  const id = dmRoomId(userA, userB);
  const existing = socialStore.getRoom(id);
  if (existing) return existing;
  const room = socialStore.createRoom({
    id,
    name: null,
    avatar: null,
    hostMember: null,
    decorations: null,
    contextCard: null,
  });
  socialStore.addRoomMember({ roomId: id, memberKind: "user", memberRef: String(userA), ownerId: null });
  socialStore.addRoomMember({ roomId: id, memberKind: "user", memberRef: String(userB), ownerId: null });
  return room;
}

module.exports = { dmRoomId, ensureDmRoom };
