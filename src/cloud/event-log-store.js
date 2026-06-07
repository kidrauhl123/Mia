// Per-user persistent event log. Every state-changing broadcast lands here
// transactionally with a monotonically increasing per-user seq number.
// Clients track their
// last seen seq and on reconnect ask the server "give me everything
// since N". That makes disconnect tolerance and replay free.
//
// Schema (created by sqlite-store.js):
//   user_events(id PK, user_id, seq, kind, scope_kind, scope_ref, payload, created_at)
//   UNIQUE(user_id, seq)
//   users.event_seq  -- cached MAX(user_events.seq) for fast monotonic bump
//
// API:
//   appendEvent(userId, { kind, scopeKind, scopeRef, payload }) -> { id, seq, ...input }
//   listEventsSince(userId, sinceSeq, limit=500) -> [...event rows]
//   maxSeqForUser(userId) -> number

function nowIso() {
  return new Date().toISOString();
}

function createEventLogStore(db) {
  // node:sqlite (DatabaseSync) doesn't have better-sqlite3's
  // db.transaction(fn) wrapper — we explicit BEGIN IMMEDIATE / COMMIT /
  // ROLLBACK. INSERT + UPDATE pair runs inside the transaction so we
  // never get a duplicate (user_id, seq) under any concurrent caller.
  const selectEventSeq = db.prepare("SELECT event_seq FROM users WHERE id = ?");
  const updateEventSeq = db.prepare("UPDATE users SET event_seq = ? WHERE id = ?");
  const insertEvent = db.prepare(
    "INSERT INTO user_events (user_id, seq, kind, scope_kind, scope_ref, payload, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, seq, kind, scope_kind, scope_ref, payload, created_at"
  );

  function appendEvent(userId, { kind, scopeKind = null, scopeRef = null, payload }) {
    if (!userId || !kind) throw new Error("appendEvent: userId + kind required");
    const json = JSON.stringify(payload ?? {});
    db.exec("BEGIN IMMEDIATE");
    let row;
    try {
      const next = (selectEventSeq.get(String(userId))?.event_seq ?? 0) + 1;
      updateEventSeq.run(next, String(userId));
      row = insertEvent.get(String(userId), next, String(kind), scopeKind || null, scopeRef || null, json, nowIso());
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* rollback failure not actionable */ }
      throw e;
    }
    return {
      id: row.id,
      seq: row.seq,
      userId,
      kind: row.kind,
      scopeKind: row.scope_kind,
      scopeRef: row.scope_ref,
      payload: JSON.parse(row.payload),
      createdAt: row.created_at
    };
  }

  function listEventsSince(userId, sinceSeq, limit = 500) {
    const rows = db.prepare(
      "SELECT id, seq, kind, scope_kind, scope_ref, payload, created_at " +
      "FROM user_events WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?"
    ).all(String(userId), Number(sinceSeq) || 0, Math.min(Math.max(1, Number(limit) || 500), 5000));
    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      userId,
      kind: r.kind,
      scopeKind: r.scope_kind,
      scopeRef: r.scope_ref,
      payload: JSON.parse(r.payload),
      createdAt: r.created_at
    }));
  }

  function maxSeqForUser(userId) {
    const row = db.prepare("SELECT event_seq FROM users WHERE id = ?").get(String(userId));
    return row?.event_seq ?? 0;
  }

  // Op idempotency — separate but lives in same store for cohesion.
  function getCachedOp(userId, clientOp) {
    if (!userId || !clientOp) return null;
    const row = db.prepare("SELECT result_json, status_code FROM op_idempotency WHERE user_id = ? AND client_op = ?")
      .get(String(userId), String(clientOp));
    if (!row) return null;
    return { result: JSON.parse(row.result_json), statusCode: row.status_code };
  }

  function cacheOp(userId, clientOp, { result, statusCode = 200 }) {
    if (!userId || !clientOp) return;
    db.prepare(
      "INSERT OR REPLACE INTO op_idempotency (user_id, client_op, result_json, status_code, created_at) " +
      "VALUES (?, ?, ?, ?, ?)"
    ).run(String(userId), String(clientOp), JSON.stringify(result ?? null), Number(statusCode) || 200, nowIso());
  }

  function purgeStaleOps(maxAgeMs = 24 * 60 * 60 * 1000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return db.prepare("DELETE FROM op_idempotency WHERE created_at < ?").run(cutoff).changes;
  }

  return {
    appendEvent,
    listEventsSince,
    maxSeqForUser,
    getCachedOp,
    cacheOp,
    purgeStaleOps
  };
}

module.exports = { createEventLogStore };
