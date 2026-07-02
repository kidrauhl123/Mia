function nowIso() {
  return new Date().toISOString();
}

function rowToSession(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    runtimeSessionId: row.runtime_session_id || "",
    storedSessionId: row.stored_session_id || "",
    lastTriggerMessageId: row.last_trigger_message_id || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requiredId(label, value) {
  const id = String(value || "").trim();
  if (!id) throw new Error(`${label} required`);
  return id;
}

function createCloudHermesSessionsStore(db) {
  const selectStmt = db.prepare(`
    SELECT user_id, bot_id, conversation_id, runtime_session_id, stored_session_id,
           last_trigger_message_id, created_at, updated_at
    FROM cloud_hermes_sessions
    WHERE user_id = ? AND bot_id = ? AND conversation_id = ?
  `);
  const upsertStmt = db.prepare(`
    INSERT INTO cloud_hermes_sessions (
      user_id, bot_id, conversation_id, runtime_session_id, stored_session_id,
      last_trigger_message_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, bot_id, conversation_id) DO UPDATE SET
      runtime_session_id = excluded.runtime_session_id,
      stored_session_id = excluded.stored_session_id,
      last_trigger_message_id = excluded.last_trigger_message_id,
      updated_at = excluded.updated_at
  `);
  const clearRuntimeStmt = db.prepare(`
    UPDATE cloud_hermes_sessions
    SET runtime_session_id = '', updated_at = ?
    WHERE user_id = ? AND bot_id = ? AND conversation_id = ?
  `);

  function getSession(userId, botId, conversationId) {
    const row = selectStmt.get(
      requiredId("getSession: userId", userId),
      requiredId("getSession: botId", botId),
      requiredId("getSession: conversationId", conversationId)
    );
    return rowToSession(row);
  }

  function upsertSession(args = {}) {
    const userId = requiredId("upsertSession: userId", args.userId);
    const botId = requiredId("upsertSession: botId", args.botId);
    const conversationId = requiredId("upsertSession: conversationId", args.conversationId);
    const now = nowIso();
    upsertStmt.run(
      userId,
      botId,
      conversationId,
      String(args.runtimeSessionId || "").trim(),
      String(args.storedSessionId || "").trim(),
      String(args.lastTriggerMessageId || "").trim(),
      now,
      now
    );
    return getSession(userId, botId, conversationId);
  }

  function clearRuntimeSession(userId, botId, conversationId) {
    const normalizedUserId = requiredId("clearRuntimeSession: userId", userId);
    const normalizedBotId = requiredId("clearRuntimeSession: botId", botId);
    const normalizedConversationId = requiredId("clearRuntimeSession: conversationId", conversationId);
    clearRuntimeStmt.run(nowIso(), normalizedUserId, normalizedBotId, normalizedConversationId);
    return getSession(normalizedUserId, normalizedBotId, normalizedConversationId);
  }

  return { getSession, upsertSession, clearRuntimeSession };
}

module.exports = { createCloudHermesSessionsStore };
