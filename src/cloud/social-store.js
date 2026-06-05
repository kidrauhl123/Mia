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

  const insertConversation = db.prepare(`
    INSERT INTO conversations (id, type, name, avatar, host_member_json, decorations_json, context_card_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectConversationById = db.prepare("SELECT * FROM conversations WHERE id = ?");
  const updateConversationCols = db.prepare(`
    UPDATE conversations SET
      name = COALESCE(?, name),
      avatar = COALESCE(?, avatar),
      host_member_json = COALESCE(?, host_member_json),
      decorations_json = COALESCE(?, decorations_json),
      context_card_json = COALESCE(?, context_card_json),
      updated_at = ?
    WHERE id = ?
  `);
  const deleteConversationStmt = db.prepare("DELETE FROM conversations WHERE id = ?");

  const insertMember = db.prepare(`
    INSERT OR IGNORE INTO conversation_members (conversation_id, member_kind, member_ref, owner_id, ai_perms_json, joined_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const deleteMember = db.prepare(
    "DELETE FROM conversation_members WHERE conversation_id = ? AND member_kind = ? AND member_ref = ?"
  );
  const selectMembers = db.prepare(
    "SELECT * FROM conversation_members WHERE conversation_id = ? ORDER BY joined_at"
  );
  const selectMember = db.prepare(
    "SELECT * FROM conversation_members WHERE conversation_id = ? AND member_kind = ? AND member_ref = ?"
  );
  const selectConversationsByUser = db.prepare(`
    SELECT r.* FROM conversations r
    INNER JOIN conversation_members m ON m.conversation_id = r.id
    WHERE m.member_kind = 'user' AND m.member_ref = ?
    ORDER BY r.updated_at DESC
  `);
  const updateMemberPerms = db.prepare(`
    UPDATE conversation_members SET ai_perms_json = ?
    WHERE conversation_id = ? AND member_kind = ? AND member_ref = ?
  `);

  function parseConversationRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      type: row.type || (row.id?.startsWith("dm:") ? "dm" : row.id?.startsWith("botc_") ? "bot" : "group"),
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
    if (id.startsWith("botc_")) return "bot";
    return "group";
  }

  function createConversation({ id, type = null, name = null, avatar = null, hostMember = null, decorations = null, contextCard = null }) {
    const now = nowIso();
    const resolvedType = type || inferType(id);
    insertConversation.run(
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
    return parseConversationRow(selectConversationById.get(String(id)));
  }

  function getConversation(conversationId) {
    return parseConversationRow(selectConversationById.get(String(conversationId)));
  }

  function updateConversation(conversationId, patch = {}) {
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    updateConversationCols.run(
      has("name") ? patch.name : null,
      has("avatar") ? patch.avatar : null,
      has("hostMember") ? (patch.hostMember ? JSON.stringify(patch.hostMember) : null) : null,
      has("decorations") ? (patch.decorations ? JSON.stringify(patch.decorations) : null) : null,
      has("contextCard") ? (patch.contextCard ? JSON.stringify(patch.contextCard) : null) : null,
      nowIso(),
      String(conversationId)
    );
    return parseConversationRow(selectConversationById.get(String(conversationId)));
  }

  function deleteConversation(conversationId) {
    deleteConversationStmt.run(String(conversationId));
  }

  function addConversationMember({ conversationId, memberKind, memberRef, ownerId = null, aiPerms = null }) {
    insertMember.run(
      String(conversationId),
      String(memberKind),
      String(memberRef),
      ownerId ? String(ownerId) : null,
      aiPerms ? JSON.stringify(aiPerms) : null,
      nowIso()
    );
  }

  function removeConversationMember(conversationId, memberKind, memberRef) {
    deleteMember.run(String(conversationId), String(memberKind), String(memberRef));
  }

  let _botsStore = null;
  function _attachBotsStore(store) { _botsStore = store || null; }

  function listConversationMembers(conversationId) {
    const rows = selectMembers.all(String(conversationId));
    if (!_botsStore) return rows;
    // Enrich bot members with identity fields needed by chat bubbles and
    // group-info dialogs without forcing clients to fetch bot definitions.
    return rows.map((row) => {
      if (row.member_kind !== "bot") return row;
      const def = _botsStore.getBot(row.member_ref);
      if (!def) return row;
      return {
        ...row,
        bot_name: def.displayName || def.name || "",
        bot_avatar_image: def.avatarImage || def.avatar?.image || "",
        bot_avatar_crop: def.avatarCrop || def.avatar?.crop || null,
        bot_color: def.color || def.avatar?.color || "",
        identity: {
          kind: "bot",
          id: def.id,
          ownerUserId: def.ownerUserId || "",
          displayName: def.displayName || def.name || "",
          avatar: {
            image: def.avatarImage || def.avatar?.image || "",
            crop: def.avatarCrop || def.avatar?.crop || null,
            color: def.color || def.avatar?.color || "",
            text: def.displayName || def.name || def.id
          },
          statusBadge: def.statusBadge || null
        }
      };
    });
  }

  function getConversationMember(conversationId, memberKind, memberRef) {
    return selectMember.get(String(conversationId), String(memberKind), String(memberRef)) || null;
  }

  function listConversationsForUser(userId) {
    return selectConversationsByUser.all(String(userId)).map(parseConversationRow);
  }

  function updateConversationMemberPerms(conversationId, memberKind, memberRef, aiPerms) {
    updateMemberPerms.run(
      aiPerms ? JSON.stringify(aiPerms) : null,
      String(conversationId),
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
    createConversation,
    getConversation,
    updateConversation,
    deleteConversation,
    addConversationMember,
    removeConversationMember,
    listConversationMembers,
    listConversationsForUser,
    updateConversationMemberPerms,
    getConversationMember,
    _attachBotsStore,
  };
}

module.exports = { createSocialStore };
