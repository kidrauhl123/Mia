const crypto = require("node:crypto");

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return prefix + "_" + crypto.randomBytes(8).toString("hex");
}

function orderPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function createSocialStore(db) {
  const insertFriendship = db.prepare(
    "INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)"
  );
  const deleteFriendship = db.prepare(
    "DELETE FROM friendships WHERE user_a = ? AND user_b = ?"
  );
  const selectFriendship = db.prepare(
    "SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?"
  );
  const selectFriendsOf = db.prepare(
    "SELECT user_a, user_b FROM friendships WHERE user_a = ? OR user_b = ?"
  );

  const insertRequest = db.prepare(`
    INSERT INTO friend_requests (id, from_user, to_user, code, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `);
  const selectRequestByCode = db.prepare(
    "SELECT * FROM friend_requests WHERE code = ?"
  );
  const updateRequestStatus = db.prepare(
    "UPDATE friend_requests SET status = ?, resolved_at = ? WHERE id = ?"
  );
  const selectIncomingPending = db.prepare(`
    SELECT * FROM friend_requests
    WHERE to_user = ? AND status = 'pending'
    ORDER BY created_at DESC
  `);
  const expirePendingOlderThan = db.prepare(
    "UPDATE friend_requests SET status = 'expired' WHERE status = 'pending' AND created_at < ?"
  );

  function addFriendship(userA, userB) {
    if (userA === userB) throw new Error("cannot befriend self");
    const [a, b] = orderPair(String(userA), String(userB));
    insertFriendship.run(a, b, nowIso());
  }

  function removeFriendship(userA, userB) {
    const [a, b] = orderPair(String(userA), String(userB));
    deleteFriendship.run(a, b);
  }

  function areFriends(userA, userB) {
    const [a, b] = orderPair(String(userA), String(userB));
    return Boolean(selectFriendship.get(a, b));
  }

  function listFriends(userId) {
    const id = String(userId);
    return selectFriendsOf.all(id, id).map((row) => (row.user_a === id ? row.user_b : row.user_a));
  }

  function createFriendRequest({ fromUser, toUser = null, code }) {
    const id = randomId("fr");
    const createdAt = nowIso();
    insertRequest.run(id, String(fromUser), toUser ? String(toUser) : null, String(code), createdAt);
    return { id, from_user: String(fromUser), to_user: toUser ? String(toUser) : null, code: String(code), status: "pending", created_at: createdAt, resolved_at: null };
  }

  function getFriendRequestByCode(code) {
    return selectRequestByCode.get(String(code)) || null;
  }

  function acceptFriendRequest(code, accepterUserId) {
    const row = selectRequestByCode.get(String(code));
    if (!row) throw new Error("friend request not found");
    if (row.status !== "pending") throw new Error("friend request not pending");
    if (row.from_user === String(accepterUserId)) throw new Error("cannot accept self friend request");
    const resolvedAt = nowIso();
    db.exec("BEGIN");
    try {
      updateRequestStatus.run("accepted", resolvedAt, row.id);
      const [a, b] = orderPair(row.from_user, String(accepterUserId));
      insertFriendship.run(a, b, resolvedAt);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { ...row, status: "accepted", resolved_at: resolvedAt };
  }

  function revokeFriendRequest(code, ownerUserId) {
    const row = selectRequestByCode.get(String(code));
    if (!row) throw new Error("friend request not found");
    if (row.from_user !== String(ownerUserId)) throw new Error("not owner of friend request");
    if (row.status !== "pending") return row;
    const resolvedAt = nowIso();
    updateRequestStatus.run("expired", resolvedAt, row.id);
    return { ...row, status: "expired", resolved_at: resolvedAt };
  }

  function listIncomingPending(userId) {
    return selectIncomingPending.all(String(userId));
  }

  function expireOldRequests(maxAgeMs) {
    const cutoff = new Date(Date.now() - Number(maxAgeMs)).toISOString();
    const info = expirePendingOlderThan.run(cutoff);
    return info.changes;
  }

  const insertRoom = db.prepare(`
    INSERT INTO rooms (id, name, avatar, host_member_json, decorations_json, context_card_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRoomById = db.prepare("SELECT * FROM rooms WHERE id = ?");
  const updateRoomCols = db.prepare(`
    UPDATE rooms SET
      name = COALESCE(?, name),
      avatar = COALESCE(?, avatar),
      host_member_json = COALESCE(?, host_member_json),
      decorations_json = COALESCE(?, decorations_json),
      context_card_json = COALESCE(?, context_card_json),
      updated_at = ?
    WHERE id = ?
  `);
  const deleteRoomStmt = db.prepare("DELETE FROM rooms WHERE id = ?");

  const insertMember = db.prepare(`
    INSERT OR IGNORE INTO room_members (room_id, member_kind, member_ref, owner_id, ai_perms_json, joined_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const deleteMember = db.prepare(
    "DELETE FROM room_members WHERE room_id = ? AND member_kind = ? AND member_ref = ?"
  );
  const selectMembers = db.prepare(
    "SELECT * FROM room_members WHERE room_id = ? ORDER BY joined_at"
  );
  const selectRoomsByUser = db.prepare(`
    SELECT r.* FROM rooms r
    INNER JOIN room_members m ON m.room_id = r.id
    WHERE m.member_kind = 'user' AND m.member_ref = ?
    ORDER BY r.updated_at DESC
  `);
  const updateMemberPerms = db.prepare(`
    UPDATE room_members SET ai_perms_json = ?
    WHERE room_id = ? AND member_kind = ? AND member_ref = ?
  `);

  function parseRoomRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      avatar: row.avatar,
      hostMember: row.host_member_json ? JSON.parse(row.host_member_json) : null,
      decorations: row.decorations_json ? JSON.parse(row.decorations_json) : null,
      contextCard: row.context_card_json ? JSON.parse(row.context_card_json) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function createRoom({ id, name = null, avatar = null, hostMember = null, decorations = null, contextCard = null }) {
    const now = nowIso();
    insertRoom.run(
      String(id),
      name,
      avatar,
      hostMember ? JSON.stringify(hostMember) : null,
      decorations ? JSON.stringify(decorations) : null,
      contextCard ? JSON.stringify(contextCard) : null,
      now,
      now
    );
    return parseRoomRow(selectRoomById.get(String(id)));
  }

  function getRoom(roomId) {
    return parseRoomRow(selectRoomById.get(String(roomId)));
  }

  function updateRoom(roomId, patch = {}) {
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    updateRoomCols.run(
      has("name") ? patch.name : null,
      has("avatar") ? patch.avatar : null,
      has("hostMember") ? (patch.hostMember ? JSON.stringify(patch.hostMember) : null) : null,
      has("decorations") ? (patch.decorations ? JSON.stringify(patch.decorations) : null) : null,
      has("contextCard") ? (patch.contextCard ? JSON.stringify(patch.contextCard) : null) : null,
      nowIso(),
      String(roomId)
    );
    return parseRoomRow(selectRoomById.get(String(roomId)));
  }

  function deleteRoom(roomId) {
    deleteRoomStmt.run(String(roomId));
  }

  function addRoomMember({ roomId, memberKind, memberRef, ownerId = null, aiPerms = null }) {
    insertMember.run(
      String(roomId),
      String(memberKind),
      String(memberRef),
      ownerId ? String(ownerId) : null,
      aiPerms ? JSON.stringify(aiPerms) : null,
      nowIso()
    );
  }

  function removeRoomMember(roomId, memberKind, memberRef) {
    deleteMember.run(String(roomId), String(memberKind), String(memberRef));
  }

  function listRoomMembers(roomId) {
    return selectMembers.all(String(roomId));
  }

  function listRoomsForUser(userId) {
    return selectRoomsByUser.all(String(userId)).map(parseRoomRow);
  }

  function updateRoomMemberPerms(roomId, memberKind, memberRef, aiPerms) {
    updateMemberPerms.run(
      aiPerms ? JSON.stringify(aiPerms) : null,
      String(roomId),
      String(memberKind),
      String(memberRef)
    );
  }

  return {
    addFriendship,
    removeFriendship,
    areFriends,
    listFriends,
    createFriendRequest,
    getFriendRequestByCode,
    acceptFriendRequest,
    revokeFriendRequest,
    listIncomingPending,
    expireOldRequests,
    createRoom,
    getRoom,
    updateRoom,
    deleteRoom,
    addRoomMember,
    removeRoomMember,
    listRoomMembers,
    listRoomsForUser,
    updateRoomMemberPerms,
  };
}

module.exports = { createSocialStore };
