const crypto = require("node:crypto");

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function parseJsonOr(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    triggerMessageId: row.trigger_message_id,
    hermesRunId: row.hermes_run_id || "",
    status: row.status,
    error: parseJsonOr(row.error_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeError(error) {
  if (!error) return null;
  if (typeof error === "string") return { message: error };
  return { message: error.message || String(error) };
}

function createCloudAgentRunsStore(db) {
  const insertStmt = db.prepare(`
    INSERT INTO cloud_agent_runs (
      id, user_id, bot_id, conversation_id, trigger_message_id, hermes_run_id,
      status, error_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '', 'queued', '', ?, ?)
  `);
  const selectStmt = db.prepare(`
    SELECT id, user_id, bot_id, conversation_id, trigger_message_id, hermes_run_id,
           status, error_json, created_at, updated_at
    FROM cloud_agent_runs WHERE id = ?
  `);
  const updateRunningStmt = db.prepare(`
    UPDATE cloud_agent_runs
    SET status = 'running', hermes_run_id = ?, updated_at = ?
    WHERE id = ?
  `);
  const updateCompleteStmt = db.prepare(`
    UPDATE cloud_agent_runs
    SET status = 'complete', updated_at = ?
    WHERE id = ?
  `);
  const updateErrorStmt = db.prepare(`
    UPDATE cloud_agent_runs
    SET status = 'error', error_json = ?, updated_at = ?
    WHERE id = ?
  `);

  function createRun(args = {}) {
    const userId = String(args.userId || "").trim();
    const botId = String(args.botId || "").trim();
    const conversationId = String(args.conversationId || "").trim();
    const triggerMessageId = String(args.triggerMessageId || "").trim();
    if (!userId) throw new Error("createRun: userId required");
    if (!botId) throw new Error("createRun: botId required");
    if (!conversationId) throw new Error("createRun: conversationId required");
    if (!triggerMessageId) throw new Error("createRun: triggerMessageId required");
    const id = randomId("car");
    const now = nowIso();
    insertStmt.run(id, userId, botId, conversationId, triggerMessageId, now, now);
    return getRun(id);
  }

  function getRun(id) {
    return rowToRun(selectStmt.get(String(id)));
  }

  function markRunning(id, hermesRunId) {
    updateRunningStmt.run(String(hermesRunId || ""), nowIso(), String(id));
    return getRun(id);
  }

  function markComplete(id) {
    updateCompleteStmt.run(nowIso(), String(id));
    return getRun(id);
  }

  function markError(id, error) {
    updateErrorStmt.run(JSON.stringify(normalizeError(error)), nowIso(), String(id));
    return getRun(id);
  }

  return { createRun, getRun, markRunning, markComplete, markError };
}

module.exports = { createCloudAgentRunsStore };
