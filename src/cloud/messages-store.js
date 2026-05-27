const crypto = require("node:crypto");

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return prefix + "_" + crypto.randomBytes(8).toString("hex");
}

function createMessagesStore(db) {
  const selectMaxSeq = db.prepare(
    "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE room_id = ?"
  );
  const insertMessage = db.prepare(`
    INSERT INTO messages (
      id, room_id, seq, turn_id, sender_kind, sender_ref, sender_owner_id,
      body_md, attachments_json, mentions_json, skills_json, status, error_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectMessage = db.prepare("SELECT * FROM messages WHERE id = ?");
  const selectSince = db.prepare(`
    SELECT * FROM messages WHERE room_id = ? AND seq > ?
    ORDER BY seq ASC LIMIT ?
  `);
  const selectSinceForViewer = db.prepare(`
    SELECT * FROM messages
    WHERE room_id = ? AND seq > ?
      AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)
    ORDER BY seq ASC LIMIT ?
  `);
  const insertHidden = db.prepare(`
    INSERT OR IGNORE INTO message_hidden (user_id, room_id, message_id, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const updateStatus = db.prepare(
    "UPDATE messages SET status = ?, error_json = COALESCE(?, error_json) WHERE id = ?"
  );
  const deleteById = db.prepare("DELETE FROM messages WHERE id = ?");

  function appendMessage(args) {
    const {
      roomId,
      senderKind,
      senderRef,
      senderOwnerId = null,
      bodyMd = "",
      attachments = null,
      mentions = null,
      skills = null,
      turnId = null,
      status = "complete",
      errorJson = null,
    } = args;
    const id = randomId("m");
    const createdAt = nowIso();
    db.exec("BEGIN");
    try {
      const seq = selectMaxSeq.get(String(roomId)).max_seq + 1;
      insertMessage.run(
        id,
        String(roomId),
        seq,
        turnId,
        String(senderKind),
        String(senderRef),
        senderOwnerId ? String(senderOwnerId) : null,
        String(bodyMd),
        attachments ? JSON.stringify(attachments) : null,
        mentions ? JSON.stringify(mentions) : null,
        skills && Array.isArray(skills) && skills.length ? JSON.stringify(skills) : null,
        String(status),
        errorJson ? JSON.stringify(errorJson) : null,
        createdAt
      );
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* may already be rolled back */ }
      throw err;
    }
    return selectMessage.get(id);
  }

  function getMessage(id) {
    return selectMessage.get(String(id)) || null;
  }

  // When viewerId is given, messages that viewer has locally deleted (hidden)
  // are excluded; without it the full room history is returned (used by
  // fellow-invocation context where there is no single viewer).
  function listMessagesSince(roomId, sinceSeq, limit = 100, viewerId = null) {
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
    if (viewerId) {
      return selectSinceForViewer.all(String(roomId), Number(sinceSeq) || 0, String(viewerId), cap);
    }
    return selectSince.all(String(roomId), Number(sinceSeq) || 0, cap);
  }

  function updateMessageStatus(id, status, errorJson = null) {
    updateStatus.run(String(status), errorJson ? JSON.stringify(errorJson) : null, String(id));
  }

  // Hard-delete a single message. Returns the deleted row (so callers can
  // broadcast room.message_deleted with the room_id) or null if it was gone.
  function deleteMessage(id) {
    const row = selectMessage.get(String(id));
    if (!row) return null;
    deleteById.run(String(id));
    return row;
  }

  // Hide a single message from one user's view only (WeChat-style local
  // delete). Returns the message row so the caller can 404 a missing id, or
  // null when it doesn't exist. The row itself is never removed; other room
  // members keep their copy. Idempotent.
  function hideMessageForUser(roomId, messageId, userId) {
    const row = selectMessage.get(String(messageId));
    if (!row) return null;
    insertHidden.run(String(userId), String(roomId), String(messageId), nowIso());
    return row;
  }

  return { appendMessage, getMessage, listMessagesSince, updateMessageStatus, deleteMessage, hideMessageForUser };
}

module.exports = { createMessagesStore };
