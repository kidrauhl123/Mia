(function attachConversationMessageIdentity(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaConversationMessageIdentity = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildConversationMessageIdentity() {
  const LEGACY_USER_MIRROR_WINDOW_MS = 1500;

  function firstText(...values) {
    for (const value of values) {
      const text = String(value == null ? "" : value).trim();
      if (text) return text;
    }
    return "";
  }

  function parseObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value !== "string" || !value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function messageContent(message = {}) {
    return {
      ...parseObject(message.content_json),
      ...parseObject(message.content)
    };
  }

  function senderKind(message = {}) {
    const value = firstText(message.sender_kind, message.senderKind, message.role).toLowerCase();
    return value === "assistant" ? "bot" : value;
  }

  function bodyText(message = {}) {
    return String(message.body_md ?? message.bodyMd ?? message.body ?? message.text ?? "")
      .replace(/\r\n/g, "\n")
      .trim();
  }

  function turnId(message = {}) {
    const content = messageContent(message);
    return firstText(
      message.turn_id,
      message.turnId,
      content.turn_id,
      content.turnId
    );
  }

  function explicitLogicalId(message = {}) {
    const content = messageContent(message);
    return firstText(
      message.logical_message_id,
      message.logicalMessageId,
      message._logicalMessageId,
      message.origin_message_id,
      message.originMessageId,
      message.client_op_id,
      message.clientOpId,
      content.logical_message_id,
      content.logicalMessageId,
      content.origin_message_id,
      content.originMessageId,
      content.client_op_id,
      content.clientOpId
    );
  }

  function logicalMessageId(message = {}) {
    const kind = senderKind(message);
    const turn = turnId(message);
    if (kind === "bot" && turn) return `assistant:${turn}`;
    const explicit = explicitLogicalId(message);
    if (/^(assistant|user|bot|system|message):/.test(explicit)) return explicit;
    if (explicit && (explicit === firstText(message.id) || isCloudPhysicalId(explicit) || isCorePhysicalId(explicit))) {
      return `message:${explicit}`;
    }
    if (explicit) return `${kind || "message"}:${explicit}`;
    const id = firstText(message.id);
    return id ? `message:${id}` : "";
  }

  function createdAtMs(message = {}) {
    const raw = message.created_at ?? message.createdAt ?? "";
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    const numeric = Number(raw);
    if (String(raw).trim() && Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(String(raw || ""));
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function normalizedAttachments(message = {}) {
    let attachments = message.attachments;
    if (!Array.isArray(attachments)) {
      try {
        attachments = JSON.parse(message.attachments_json || message.attachmentsJson || "[]");
      } catch {
        attachments = [];
      }
    }
    return Array.isArray(attachments) ? attachments : [];
  }

  function isCloudPhysicalId(id) {
    return /^m_[A-Za-z0-9]/.test(String(id || ""));
  }

  function isCorePhysicalId(id) {
    return /^msg_[A-Za-z0-9]/.test(String(id || ""));
  }

  function isLocalCoreMirror(message = {}) {
    return Boolean(
      message._localCoreConversationId
      || message._cloudBridgeRunId
      || firstText(message.local_conversation_id, message.localConversationId).startsWith("cloud_bridge_")
      || isCorePhysicalId(message.id)
    );
  }

  function legacyBucketKey(message = {}) {
    const id = firstText(message.id);
    if (!isCloudPhysicalId(id) && !isCorePhysicalId(id)) return "";
    return [
      senderKind(message),
      bodyText(message),
      stableJson(normalizedAttachments(message))
    ].join("\u0000");
  }

  function isLegacyBridgeDuplicate(left = {}, right = {}) {
    const leftId = firstText(left.id);
    const rightId = firstText(right.id);
    if (!leftId || !rightId || leftId === rightId) return false;
    const physicalPair = (
      (isCloudPhysicalId(leftId) && isCorePhysicalId(rightId))
      || (isCloudPhysicalId(rightId) && isCorePhysicalId(leftId))
    );
    if (!physicalPair || senderKind(left) !== senderKind(right)) return false;
    if (bodyText(left) !== bodyText(right)) return false;
    if (stableJson(normalizedAttachments(left)) !== stableJson(normalizedAttachments(right))) return false;

    const kind = senderKind(left);
    const leftTurn = turnId(left);
    const rightTurn = turnId(right);
    if (kind === "bot" && leftTurn && rightTurn) return leftTurn === rightTurn;

    const leftTime = createdAtMs(left);
    const rightTime = createdAtMs(right);
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return false;
    const delta = Math.abs(leftTime - rightTime);
    if (kind === "user") {
      return delta <= LEGACY_USER_MIRROR_WINDOW_MS
        && (isLocalCoreMirror(left) || isLocalCoreMirror(right));
    }
    return kind === "bot" && delta <= LEGACY_USER_MIRROR_WINDOW_MS;
  }

  function canonicalScore(message = {}) {
    const id = firstText(message.id);
    let score = 0;
    if (isCloudPhysicalId(id)) score += 100;
    if (!isLocalCoreMirror(message)) score += 20;
    if (!String(message.status || "").toLowerCase().includes("processing")) score += 5;
    if (Number.isFinite(Number(message.seq))) score += 2;
    return score;
  }

  function overlayDefined(target, source) {
    for (const [key, value] of Object.entries(source || {})) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value) && value.length === 0 && Array.isArray(target[key]) && target[key].length) continue;
      target[key] = value;
    }
    return target;
  }

  function mergeLogicalMessages(left = {}, right = {}) {
    const samePhysicalId = firstText(left.id) && firstText(left.id) === firstText(right.id);
    const primary = (samePhysicalId || canonicalScore(right) > canonicalScore(left)) ? right : left;
    const secondary = primary === left ? right : left;
    const merged = overlayDefined(overlayDefined({}, secondary), primary);
    merged.id = firstText(primary.id, secondary.id);
    merged.logical_message_id = logicalMessageId(merged) || logicalMessageId(primary) || logicalMessageId(secondary);
    if (isCloudPhysicalId(merged.id)) {
      delete merged._localCoreConversationId;
      delete merged._cloudBridgeRunId;
      delete merged.local_conversation_id;
      delete merged.localConversationId;
    }
    return merged;
  }

  function compareMessages(left = {}, right = {}) {
    const leftSeq = Number(left.seq);
    const rightSeq = Number(right.seq);
    if (Number.isFinite(leftSeq) && Number.isFinite(rightSeq) && leftSeq !== rightSeq) {
      return leftSeq - rightSeq;
    }
    const leftTime = createdAtMs(left);
    const rightTime = createdAtMs(right);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return firstText(left.id).localeCompare(firstText(right.id));
  }

  function collapseConversationMessages(messages = []) {
    const collapsed = [];
    const logicalIndexes = new Map();
    const legacyIndexes = new Map();
    for (const raw of Array.isArray(messages) ? messages : []) {
      if (!raw || typeof raw !== "object" || !firstText(raw.id)) continue;
      const message = { ...raw };
      const logicalId = logicalMessageId(message);
      if (logicalId) message.logical_message_id = logicalId;
      const exactIndex = logicalId ? logicalIndexes.get(logicalId) : undefined;
      if (exactIndex !== undefined) {
        collapsed[exactIndex] = mergeLogicalMessages(collapsed[exactIndex], message);
        continue;
      }
      const legacyKey = legacyBucketKey(message);
      const legacyIndex = (legacyIndexes.get(legacyKey) || [])
        .find((index) => isLegacyBridgeDuplicate(collapsed[index], message)) ?? -1;
      if (legacyIndex >= 0) {
        const previousLogicalId = logicalMessageId(collapsed[legacyIndex]);
        collapsed[legacyIndex] = mergeLogicalMessages(collapsed[legacyIndex], message);
        const mergedLogicalId = logicalMessageId(collapsed[legacyIndex]);
        if (previousLogicalId) logicalIndexes.delete(previousLogicalId);
        if (mergedLogicalId) logicalIndexes.set(mergedLogicalId, legacyIndex);
        continue;
      }
      const index = collapsed.length;
      collapsed.push(message);
      if (logicalId) logicalIndexes.set(logicalId, index);
      if (legacyKey) {
        if (!legacyIndexes.has(legacyKey)) legacyIndexes.set(legacyKey, []);
        legacyIndexes.get(legacyKey).push(index);
      }
    }
    return collapsed.sort(compareMessages);
  }

  return {
    LEGACY_USER_MIRROR_WINDOW_MS,
    logicalMessageId,
    isLegacyBridgeDuplicate,
    mergeLogicalMessages,
    collapseConversationMessages,
    compareMessages
  };
});
