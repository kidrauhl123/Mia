const crypto = require("node:crypto");
const {
  contentBlocksWithFinalText,
  normalizeContentBlocks
} = require("../shared/assistant-content-blocks.js");

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return prefix + "_" + crypto.randomBytes(8).toString("hex");
}

function normalizeTriggerMessageId(value) {
  return String(value || "").trim();
}

function markAlreadyExisted(row) {
  if (row && typeof row === "object") {
    Object.defineProperty(row, "_alreadyExisted", {
      value: true,
      enumerable: false,
      configurable: true
    });
  }
  return row;
}

function isSqliteConstraintError(error) {
  const code = String(error?.code || error?.name || "");
  const message = String(error?.message || "");
  return code.includes("SQLITE_CONSTRAINT") || /UNIQUE constraint failed|constraint failed/i.test(message);
}

function normalizeTrace(input) {
  if (!input || typeof input !== "object") return null;
  const reasoning = String(input.reasoning || "").trim();
  const rawTools = Array.isArray(input.tools) ? input.tools : [];
  const tools = rawTools.slice(0, 50).map((tool, idx) => {
    if (!tool || typeof tool !== "object") return null;
    const statusValue = String(tool.status || "").trim();
    const status = statusValue === "complete" || statusValue === "completed"
      ? "completed"
      : (statusValue === "error" || statusValue === "failed" ? "error" : "running");
    const name = String(tool.name || "").trim();
    if (!name) return null;
    return {
      id: String(tool.id || `tool_${idx}`),
      name,
      preview: String(tool.preview || ""),
      status,
      duration: typeof tool.duration === "number" ? tool.duration : null,
      error: Boolean(tool.error)
    };
  }).filter(Boolean);
  if (!reasoning && !tools.length) return null;
  return {
    ...(reasoning ? { reasoning } : {}),
    ...(tools.length ? { tools } : {})
  };
}

function createMessagesStore(db) {
  const selectMaxSeq = db.prepare(
    "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE conversation_id = ?"
  );
  const insertMessage = db.prepare(`
    INSERT INTO messages (
      id, conversation_id, seq, turn_id, trigger_message_id, sender_kind, sender_ref, sender_owner_id,
      body_md, attachments_json, mentions_json, skills_json, trace_json, content_blocks_json, status, error_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectMessage = db.prepare("SELECT * FROM messages WHERE id = ?");
  const selectBotTriggerReply = db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ? AND sender_kind = 'bot' AND sender_ref = ? AND trigger_message_id = ?
    ORDER BY seq ASC
    LIMIT 1
  `);
  const selectSince = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? AND seq > ?
    ORDER BY seq ASC LIMIT ?
  `);
  const selectSinceForViewer = db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ? AND seq > ?
      AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)
    ORDER BY seq ASC LIMIT ?
  `);
  const selectLatest = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ?
    ORDER BY seq DESC LIMIT ?
  `);
  const selectLatestForViewer = db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ?
      AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)
    ORDER BY seq DESC LIMIT ?
  `);
  const selectBefore = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? AND seq < ?
    ORDER BY seq DESC LIMIT ?
  `);
  const selectBeforeForViewer = db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ? AND seq < ?
      AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)
    ORDER BY seq DESC LIMIT ?
  `);
  const searchForViewer = db.prepare(`
    SELECT m.*
    FROM messages m
    INNER JOIN conversation_members cm
      ON cm.conversation_id = m.conversation_id
      AND cm.member_kind = 'user'
      AND cm.member_ref = ?
    WHERE m.body_md LIKE ? ESCAPE '\\'
      AND m.id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)
    ORDER BY m.created_at DESC, m.seq DESC
    LIMIT ?
  `);
  const insertHidden = db.prepare(`
    INSERT OR IGNORE INTO message_hidden (user_id, conversation_id, message_id, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const updateStatus = db.prepare(
    "UPDATE messages SET status = ?, error_json = COALESCE(?, error_json) WHERE id = ?"
  );
  const deleteById = db.prepare("DELETE FROM messages WHERE id = ?");

  function appendMessage(args) {
    const {
      conversationId,
      senderKind,
      senderRef,
      senderOwnerId = null,
      bodyMd = "",
      attachments = null,
      mentions = null,
      skills = null,
      trace = null,
      contentBlocks = null,
      turnId = null,
      triggerMessageId = null,
      status = "complete",
      errorJson = null,
    } = args;
    const normalizedConversationId = String(conversationId);
    const normalizedSenderKind = String(senderKind);
    const normalizedSenderRef = String(senderRef);
    const normalizedTriggerMessageId = normalizeTriggerMessageId(triggerMessageId || args.trigger_message_id);
    const botTriggerClaim = normalizedSenderKind === "bot" && normalizedTriggerMessageId;
    const id = randomId("m");
    const createdAt = nowIso();
    const tracePayload = normalizeTrace(trace);
    const normalizedContentBlocks = normalizeContentBlocks(contentBlocks);
    const contentBlocksPayload = normalizedContentBlocks.length
      ? contentBlocksWithFinalText(normalizedContentBlocks, bodyMd)
      : [];
    db.exec("BEGIN IMMEDIATE");
    try {
      if (botTriggerClaim) {
        const existing = selectBotTriggerReply.get(normalizedConversationId, normalizedSenderRef, normalizedTriggerMessageId);
        if (existing) {
          db.exec("COMMIT");
          return markAlreadyExisted(existing);
        }
      }
      const seq = selectMaxSeq.get(normalizedConversationId).max_seq + 1;
      insertMessage.run(
        id,
        normalizedConversationId,
        seq,
        turnId,
        normalizedTriggerMessageId || null,
        normalizedSenderKind,
        normalizedSenderRef,
        senderOwnerId ? String(senderOwnerId) : null,
        String(bodyMd),
        attachments ? JSON.stringify(attachments) : null,
        mentions ? JSON.stringify(mentions) : null,
        skills && Array.isArray(skills) && skills.length ? JSON.stringify(skills) : null,
        tracePayload ? JSON.stringify(tracePayload) : null,
        contentBlocksPayload.length ? JSON.stringify(contentBlocksPayload) : null,
        String(status),
        errorJson ? JSON.stringify(errorJson) : null,
        createdAt
      );
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* may already be rolled back */ }
      if (botTriggerClaim && isSqliteConstraintError(err)) {
        const existing = selectBotTriggerReply.get(normalizedConversationId, normalizedSenderRef, normalizedTriggerMessageId);
        if (existing) return markAlreadyExisted(existing);
      }
      throw err;
    }
    return selectMessage.get(id);
  }

  function getMessage(id) {
    return selectMessage.get(String(id)) || null;
  }

  // When viewerId is given, messages that viewer has locally deleted (hidden)
  // are excluded; without it the full conversation history is returned for
  // system-side contexts where there is no single viewer.
  function listMessagesSince(conversationId, sinceSeq, limit = 100, viewerId = null) {
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
    if (viewerId) {
      return selectSinceForViewer.all(String(conversationId), Number(sinceSeq) || 0, String(viewerId), cap);
    }
    return selectSince.all(String(conversationId), Number(sinceSeq) || 0, cap);
  }

  function boundedPage(rows, cap) {
    const hasMoreBefore = rows.length > cap;
    const messages = rows.slice(0, cap).reverse();
    return { messages, hasMoreBefore };
  }

  function listLatestMessages(conversationId, limit = 100, viewerId = null) {
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const rows = viewerId
      ? selectLatestForViewer.all(String(conversationId), String(viewerId), cap + 1)
      : selectLatest.all(String(conversationId), cap + 1);
    return boundedPage(rows, cap);
  }

  function listMessagesBefore(conversationId, beforeSeq, limit = 100, viewerId = null) {
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const before = Math.max(1, Number(beforeSeq) || 1);
    const rows = viewerId
      ? selectBeforeForViewer.all(String(conversationId), before, String(viewerId), cap + 1)
      : selectBefore.all(String(conversationId), before, cap + 1);
    return boundedPage(rows, cap);
  }

  function searchMessagesForUser(userId, query, limit = 80) {
    const user = String(userId || "").trim();
    const text = String(query || "").trim();
    if (!user || !text) return [];
    const cap = Math.min(Math.max(Number(limit) || 80, 1), 200);
    const escaped = text.replace(/[\\%_]/g, (ch) => "\\" + ch);
    return searchForViewer.all(user, `%${escaped}%`, user, cap);
  }

  function updateMessageStatus(id, status, errorJson = null) {
    updateStatus.run(String(status), errorJson ? JSON.stringify(errorJson) : null, String(id));
  }

  // Hard-delete a single message. Returns the deleted row (so callers can
  // broadcast conversation.message_deleted with the conversation_id) or null if it was gone.
  function deleteMessage(id) {
    const row = selectMessage.get(String(id));
    if (!row) return null;
    deleteById.run(String(id));
    return row;
  }

  // Hide a single message from one user's view only (WeChat-style local
  // delete). Returns the message row so the caller can 404 a missing id, or
  // null when it doesn't exist. The row itself is never removed; other conversation
  // members keep their copy. Idempotent.
  function hideMessageForUser(conversationId, messageId, userId) {
    const row = selectMessage.get(String(messageId));
    if (!row) return null;
    insertHidden.run(String(userId), String(conversationId), String(messageId), nowIso());
    return row;
  }

  return {
    appendMessage,
    getMessage,
    listMessagesSince,
    listLatestMessages,
    listMessagesBefore,
    searchMessagesForUser,
    updateMessageStatus,
    deleteMessage,
    hideMessageForUser
  };
}

module.exports = { createMessagesStore, normalizeTrace };
