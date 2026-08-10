"use strict";

const crypto = require("node:crypto");

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(String(value));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function channelFromRow(row, { includeSecrets = false } = {}) {
  if (!row) return null;
  const result = {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    botId: row.bot_id,
    name: row.name,
    enabled: Boolean(row.enabled),
    settings: parseJson(row.settings_json, {}),
    hasCredentials: Boolean(row.secrets_ciphertext),
    lastError: row.last_error || "",
    lastEventAt: row.last_event_at || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (includeSecrets) result.secretsCiphertext = row.secrets_ciphertext || "";
  return result;
}

function deliveryFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    channelId: row.channel_id,
    conversationId: row.conversation_id,
    triggerMessageId: row.trigger_message_id,
    replyRef: row.reply_ref || "",
    recipient: parseJson(row.recipient_json, {}),
    status: row.status,
    error: row.error || "",
    attemptCount: Number(row.attempt_count || 0),
    lastAttemptAt: row.last_attempt_at || "",
    createdAt: row.created_at,
    deliveredAt: row.delivered_at || ""
  };
}

function createImChannelStore(db) {
  const selectById = db.prepare("SELECT * FROM im_channels WHERE id = ?");
  const selectByUserId = db.prepare("SELECT * FROM im_channels WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?");
  const selectByUserAndId = db.prepare("SELECT * FROM im_channels WHERE user_id = ? AND id = ?");
  const insertChannel = db.prepare(`
    INSERT INTO im_channels (
      id, user_id, provider, bot_id, name, enabled, settings_json,
      secrets_ciphertext, last_error, last_event_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)
  `);
  const updateChannelStmt = db.prepare(`
    UPDATE im_channels
    SET provider = ?, bot_id = ?, name = ?, enabled = ?, settings_json = ?,
        secrets_ciphertext = ?, last_error = ?, last_event_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `);
  const deleteChannelStmt = db.prepare("DELETE FROM im_channels WHERE id = ? AND user_id = ?");
  const updateStatusStmt = db.prepare(`
    UPDATE im_channels
    SET last_error = ?, last_event_at = COALESCE(?, last_event_at), updated_at = ?
    WHERE id = ?
  `);
  const insertEventClaim = db.prepare(`
    INSERT OR IGNORE INTO im_channel_events (channel_id, provider_event_id, status, created_at)
    VALUES (?, ?, 'received', ?)
  `);
  const updateEventStatus = db.prepare(`
    UPDATE im_channel_events
    SET status = ?, delivery_id = COALESCE(NULLIF(?, ''), delivery_id)
    WHERE channel_id = ? AND provider_event_id = ?
  `);
  const selectInboundEvent = db.prepare(`
    SELECT status, delivery_id FROM im_channel_events
    WHERE channel_id = ? AND provider_event_id = ?
  `);
  const insertDelivery = db.prepare(`
    INSERT OR IGNORE INTO im_channel_deliveries (
      id, channel_id, conversation_id, trigger_message_id, reply_ref,
      recipient_json, status, error, created_at, delivered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '')
  `);
  const selectDeliveryForTrigger = db.prepare(`
    SELECT * FROM im_channel_deliveries
    WHERE conversation_id = ? AND trigger_message_id = ? AND status = 'pending'
    ORDER BY created_at ASC LIMIT 1
  `);
  const selectAnyDeliveryForTrigger = db.prepare(`
    SELECT * FROM im_channel_deliveries
    WHERE conversation_id = ? AND trigger_message_id = ?
    ORDER BY created_at ASC LIMIT 1
  `);
  const selectLatestDeliveryForConversation = db.prepare(`
    SELECT * FROM im_channel_deliveries
    WHERE conversation_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `);
  const selectDeliveryById = db.prepare("SELECT * FROM im_channel_deliveries WHERE id = ?");
  const markDelivered = db.prepare(`
    UPDATE im_channel_deliveries
    SET status = 'delivered', error = '', delivered_at = ?
    WHERE id = ? AND status <> 'delivered'
  `);
  const markDeliveryFailedStmt = db.prepare(`
    UPDATE im_channel_deliveries
    SET status = 'failed', error = ?
    WHERE id = ? AND status <> 'delivered'
  `);
  const claimRelayDeliveryStmt = db.prepare(`
    UPDATE im_channel_deliveries
    SET status = 'relay_requested', error = '', attempt_count = attempt_count + 1, last_attempt_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const activateRelayDeliveryStmt = db.prepare(`
    UPDATE im_channel_deliveries
    SET status = 'pending'
    WHERE id = ? AND status = 'awaiting_relay_activation'
  `);

  function getChannel(id, options = {}) {
    return channelFromRow(selectById.get(String(id || "")), options);
  }

  function getChannelForUser(userId, id, options = {}) {
    return channelFromRow(selectByUserAndId.get(String(userId || ""), String(id || "")), options);
  }

  function listChannelsForUser(userId, limit = 100) {
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 200);
    return selectByUserId.all(String(userId || ""), cap).map((row) => channelFromRow(row));
  }

  function createChannel(input = {}) {
    const timestamp = nowIso();
    const id = String(input.id || randomId("imc"));
    insertChannel.run(
      id,
      String(input.userId || ""),
      String(input.provider || ""),
      String(input.botId || ""),
      String(input.name || ""),
      input.enabled ? 1 : 0,
      JSON.stringify(input.settings || {}),
      String(input.secretsCiphertext || ""),
      timestamp,
      timestamp
    );
    return getChannel(id);
  }

  function updateChannel(userId, id, input = {}) {
    const existing = getChannelForUser(userId, id, { includeSecrets: true });
    if (!existing) return null;
    const timestamp = nowIso();
    updateChannelStmt.run(
      String(input.provider ?? existing.provider),
      String(input.botId ?? existing.botId),
      String(input.name ?? existing.name),
      (input.enabled ?? existing.enabled) ? 1 : 0,
      JSON.stringify(input.settings ?? existing.settings ?? {}),
      String(input.secretsCiphertext ?? existing.secretsCiphertext ?? ""),
      String(input.lastError ?? existing.lastError ?? ""),
      String(input.lastEventAt ?? existing.lastEventAt ?? ""),
      timestamp,
      String(id),
      String(userId)
    );
    return getChannel(id);
  }

  function deleteChannel(userId, id) {
    return deleteChannelStmt.run(String(id || ""), String(userId || "")).changes > 0;
  }

  function recordChannelStatus(channelId, { lastError = "", lastEventAt = null } = {}) {
    updateStatusStmt.run(String(lastError || ""), lastEventAt ? String(lastEventAt) : null, nowIso(), String(channelId || ""));
  }

  function claimInboundEvent(channelId, providerEventId) {
    const eventId = String(providerEventId || "").trim();
    if (!eventId) return true;
    return insertEventClaim.run(String(channelId || ""), eventId, nowIso()).changes > 0;
  }

  function getInboundEvent(channelId, providerEventId) {
    const eventId = String(providerEventId || "").trim();
    if (!eventId) return null;
    const row = selectInboundEvent.get(String(channelId || ""), eventId);
    return row ? { status: row.status || "", deliveryId: row.delivery_id || "" } : null;
  }

  function markInboundEvent(channelId, providerEventId, status, deliveryId = "") {
    const eventId = String(providerEventId || "").trim();
    if (!eventId) return;
    updateEventStatus.run(
      String(status || "received"),
      String(deliveryId || ""),
      String(channelId || ""),
      eventId
    );
  }

  function createDelivery(input = {}) {
    const deliveryId = String(input.id || randomId("imd"));
    insertDelivery.run(
      deliveryId,
      String(input.channelId || ""),
      String(input.conversationId || ""),
      String(input.triggerMessageId || ""),
      String(input.replyRef || ""),
      JSON.stringify(input.recipient || {}),
      String(input.status || "pending"),
      nowIso()
    );
    const existing = selectAnyDeliveryForTrigger.get(String(input.conversationId || ""), String(input.triggerMessageId || ""));
    return deliveryFromRow(existing || selectDeliveryById.get(deliveryId));
  }

  function findPendingDelivery(conversationId, triggerMessageId) {
    return deliveryFromRow(selectDeliveryForTrigger.get(String(conversationId || ""), String(triggerMessageId || "")));
  }

  function findDeliveryForTrigger(conversationId, triggerMessageId) {
    return deliveryFromRow(selectAnyDeliveryForTrigger.get(String(conversationId || ""), String(triggerMessageId || "")));
  }

  function findLatestDeliveryForConversation(conversationId) {
    return deliveryFromRow(selectLatestDeliveryForConversation.get(String(conversationId || "")));
  }

  function getDelivery(id) {
    return deliveryFromRow(selectDeliveryById.get(String(id || "")));
  }

  function claimRelayDelivery(id) {
    const deliveryId = String(id || "");
    const claimed = claimRelayDeliveryStmt.run(nowIso(), deliveryId).changes > 0;
    return claimed ? getDelivery(deliveryId) : null;
  }

  function activateRelayDelivery(id) {
    const deliveryId = String(id || "");
    const activated = activateRelayDeliveryStmt.run(deliveryId).changes > 0;
    return activated ? getDelivery(deliveryId) : null;
  }

  function markDeliveryDelivered(id) {
    markDelivered.run(nowIso(), String(id || ""));
    return deliveryFromRow(selectDeliveryById.get(String(id || "")));
  }

  function markDeliveryFailed(id, error = "") {
    markDeliveryFailedStmt.run(String(error || ""), String(id || ""));
    return deliveryFromRow(selectDeliveryById.get(String(id || "")));
  }

  return {
    getChannel,
    getChannelForUser,
    listChannelsForUser,
    createChannel,
    updateChannel,
    deleteChannel,
    recordChannelStatus,
    claimInboundEvent,
    getInboundEvent,
    markInboundEvent,
    createDelivery,
    getDelivery,
    findPendingDelivery,
    findDeliveryForTrigger,
    findLatestDeliveryForConversation,
    claimRelayDelivery,
    activateRelayDelivery,
    markDeliveryDelivered,
    markDeliveryFailed
  };
}

module.exports = { createImChannelStore };
