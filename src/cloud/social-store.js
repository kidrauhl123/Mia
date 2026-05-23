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

  const insertRequestByUsername = db.prepare(`
    INSERT INTO friend_requests (id, from_user, to_user, code, status, created_at)
    VALUES (?, ?, ?, NULL, 'pending', ?)
  `);
  const selectRequestById = db.prepare(
    "SELECT * FROM friend_requests WHERE id = ?"
  );
  const updateRequestStatus = db.prepare(
    "UPDATE friend_requests SET status = ?, resolved_at = ? WHERE id = ?"
  );
  const selectIncomingPending = db.prepare(`
    SELECT * FROM friend_requests
    WHERE to_user = ? AND status = 'pending'
    ORDER BY created_at DESC
  `);
  const selectOutgoingPending = db.prepare(`
    SELECT * FROM friend_requests
    WHERE from_user = ? AND status = 'pending'
    ORDER BY created_at DESC
  `);
  const selectDuplicatePending = db.prepare(
    "SELECT 1 FROM friend_requests WHERE from_user = ? AND to_user = ? AND status = 'pending'"
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

  function createFriendRequestByUsername({ fromUserId, toUserId }) {
    const from = String(fromUserId);
    const to = String(toUserId);
    if (from === to) throw new Error("cannot send friend request to yourself");
    if (areFriends(from, to)) throw new Error("already friends");
    if (selectDuplicatePending.get(from, to)) throw new Error("friend request already pending");
    const reqId = randomId("fr");
    const createdAt = nowIso();
    insertRequestByUsername.run(reqId, from, to, createdAt);
    return { id: reqId, from_user: from, to_user: to, code: null, status: "pending", created_at: createdAt, resolved_at: null };
  }

  function getFriendRequestById(requestId) {
    return selectRequestById.get(String(requestId)) || null;
  }

  function listIncomingPending(userId) {
    return selectIncomingPending.all(String(userId));
  }

  function listOutgoingPending(userId) {
    return selectOutgoingPending.all(String(userId));
  }

  function respondToFriendRequest(requestId, accepterUserId, action) {
    if (action !== "accept" && action !== "reject") throw new Error("action must be 'accept' or 'reject'");
    const row = selectRequestById.get(String(requestId));
    if (!row) throw new Error("friend request not found");
    if (row.status !== "pending") throw new Error("friend request not pending");
    if (row.to_user !== String(accepterUserId)) throw new Error("not the recipient of this friend request");
    const resolvedAt = nowIso();
    db.exec("BEGIN");
    try {
      updateRequestStatus.run(action === "accept" ? "accepted" : "rejected", resolvedAt, row.id);
      if (action === "accept") {
        const [a, b] = orderPair(row.from_user, String(accepterUserId));
        insertFriendship.run(a, b, resolvedAt);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { ...row, status: action === "accept" ? "accepted" : "rejected", resolved_at: resolvedAt };
  }

  function cancelFriendRequest(requestId, fromUserId) {
    const row = selectRequestById.get(String(requestId));
    if (!row) throw new Error("friend request not found");
    if (row.from_user !== String(fromUserId)) throw new Error("not the sender of this friend request");
    if (row.status === "cancelled") return row;
    if (row.status !== "pending") throw new Error("friend request not pending");
    const resolvedAt = nowIso();
    updateRequestStatus.run("cancelled", resolvedAt, row.id);
    return { ...row, status: "cancelled", resolved_at: resolvedAt };
  }

  const insertRoom = db.prepare(`
    INSERT INTO rooms (id, type, name, avatar, host_member_json, decorations_json, context_card_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  const selectMember = db.prepare(
    "SELECT * FROM room_members WHERE room_id = ? AND member_kind = ? AND member_ref = ?"
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
      type: row.type || (row.id?.startsWith("dm:") ? "dm" : row.id?.startsWith("fellow:") ? "fellow" : "group"),
      name: row.name,
      avatar: row.avatar,
      hostMember: row.host_member_json ? JSON.parse(row.host_member_json) : null,
      decorations: row.decorations_json ? JSON.parse(row.decorations_json) : null,
      contextCard: row.context_card_json ? JSON.parse(row.context_card_json) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function inferType(id) {
    if (typeof id !== "string") return "group";
    if (id.startsWith("dm:")) return "dm";
    if (id.startsWith("fellow:")) return "fellow";
    return "group";
  }

  function createRoom({ id, type = null, name = null, avatar = null, hostMember = null, decorations = null, contextCard = null }) {
    const now = nowIso();
    const resolvedType = type || inferType(id);
    insertRoom.run(
      String(id),
      resolvedType,
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

  function getRoomMember(roomId, memberKind, memberRef) {
    return selectMember.get(String(roomId), String(memberKind), String(memberRef)) || null;
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
    createFriendRequestByUsername,
    getFriendRequestById,
    listIncomingPending,
    listOutgoingPending,
    respondToFriendRequest,
    cancelFriendRequest,
    createRoom,
    getRoom,
    updateRoom,
    deleteRoom,
    addRoomMember,
    removeRoomMember,
    listRoomMembers,
    listRoomsForUser,
    updateRoomMemberPerms,
    getRoomMember,
  };
}

module.exports = { createSocialStore };
