"use strict";

const MemoryEvent = Object.freeze({
  Updated: "memory.updated",
  Deleted: "memory.deleted"
});

function clean(value = "") {
  return String(value || "").trim();
}

function compactMemoryPayload(result = {}, scope = {}) {
  const memory = result && typeof result.memory === "object" && result.memory !== null ? result.memory : {};
  const id = clean(result.memoryId || result.id || memory.id);
  const status = clean(result.status || memory.status);
  const payload = {
    id,
    status,
    scope: clean(result.effectiveScope || memory.scope || scope.scope),
    botId: clean(memory.botId || result.botId || scope.botId),
    sessionId: clean(memory.sessionId || result.sessionId || scope.sessionId),
    revision: Number(memory.revision || result.revision || 0) || undefined,
    deletedAt: clean(memory.deletedAt || result.deletedAt)
  };
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== "" && value !== undefined));
}

function memoryChangedEnvelope(reason = "memory", result = {}, scope = {}) {
  const normalizedReason = clean(reason) || "memory";
  const memory = compactMemoryPayload(result, scope);
  const count = Number(result.count);
  const type = normalizedReason === "delete" || memory.status === "deleted" || Boolean(memory.deletedAt)
    ? MemoryEvent.Deleted
    : MemoryEvent.Updated;
  return {
    type,
    payload: {
      type,
      reason: normalizedReason,
      source: clean(scope.eventSource || result.eventSource || scope.source) || "local",
      memory,
      ...(Number.isFinite(count) ? { count } : {})
    }
  };
}

module.exports = {
  MemoryEvent,
  compactMemoryPayload,
  memoryChangedEnvelope
};
