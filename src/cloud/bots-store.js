// Cloud bot identity definitions. Runtime configuration stays local; the
// cloud row is the globally unique bot identity other devices can render.

function nowIso() {
  return new Date().toISOString();
}

const {
  firstNonEmpty,
  normalizeBotCapabilities,
  normalizeBotIdentity
} = require("../shared/bot-identity.js");
const { sanitizeCssColor } = require("./css-color.js");

function parseJsonOr(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed == null ? fallback : parsed;
  } catch { return fallback; }
}

function withAvatar(identity) {
  if (!identity) return null;
  return {
    ...identity,
    avatar: {
      image: identity.avatarImage || "",
      crop: identity.avatarCrop || null,
      color: identity.color || "",
      text: identity.displayName || identity.name || identity.id
    }
  };
}

function rowToBot(row) {
  if (!row) return null;
  return withAvatar(normalizeBotIdentity({
    id: row.id,
    owner_user_id: row.owner_user_id,
    display_name: row.display_name,
    color: row.color || "",
    avatar_image: row.avatar_image || "",
    avatar_crop_json: row.avatar_crop_json || "",
    status_badge_json: row.status_badge_json || "",
    bio: row.bio || "",
    capabilities: normalizeBotCapabilities(parseJsonOr(row.capabilities_json, {})),
    persona_text: row.persona_text || "",
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
}

function createBotsStore(db) {
  const cols = "id, owner_user_id, display_name, color, avatar_image, avatar_crop_json, status_badge_json, bio, capabilities_json, persona_text, created_at, updated_at";
  const upsertStmt = db.prepare(
    `INSERT INTO bots (${cols}) ` +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT (id) DO UPDATE SET " +
    "  owner_user_id = excluded.owner_user_id, display_name = excluded.display_name, " +
    "  color = excluded.color, avatar_image = excluded.avatar_image, " +
    "  avatar_crop_json = excluded.avatar_crop_json, status_badge_json = excluded.status_badge_json, " +
    "  bio = excluded.bio, capabilities_json = excluded.capabilities_json, " +
    "  persona_text = excluded.persona_text, updated_at = excluded.updated_at " +
    `RETURNING ${cols}`
  );
  const selectStmt = db.prepare(`SELECT ${cols} FROM bots WHERE id = ?`);
  const listStmt = db.prepare(`SELECT ${cols} FROM bots WHERE owner_user_id = ? ORDER BY updated_at DESC`);
  const deleteStmt = db.prepare("DELETE FROM bots WHERE owner_user_id = ? AND id = ?");

  function upsertBot(ownerUserId, bot) {
    if (!ownerUserId) throw new Error("upsertBot: ownerUserId required");
    const explicitName = firstNonEmpty(bot?.displayName, bot?.display_name, bot?.name);
    const normalized = normalizeBotIdentity({ ...bot, displayName: explicitName }, { ownerUserId });
    if (!normalized || !explicitName) throw new Error("upsertBot: bot.id and bot.displayName required");
    const owner = String(ownerUserId);
    const existing = selectStmt.get(normalized.id);
    if (existing && existing.owner_user_id !== owner) {
      throw new Error("bot id already belongs to another owner");
    }
    const now = nowIso();
    const createdAt = existing ? existing.created_at : now;
    const row = upsertStmt.get(
      normalized.id,
      owner,
      normalized.displayName,
      sanitizeCssColor(normalized.color),
      normalized.avatarImage,
      normalized.avatarCrop ? JSON.stringify(normalized.avatarCrop) : "",
      normalized.statusBadge ? JSON.stringify(normalized.statusBadge) : "",
      normalized.bio,
      JSON.stringify(normalized.capabilities),
      normalized.personaText,
      createdAt,
      now
    );
    return rowToBot(row);
  }

  function getBot(botId) {
    return rowToBot(selectStmt.get(String(botId)));
  }

  function listBots(ownerUserId) {
    return listStmt.all(String(ownerUserId)).map(rowToBot);
  }

  function deleteBot(ownerUserId, botId) {
    return deleteStmt.run(String(ownerUserId), String(botId)).changes;
  }

  return { upsertBot, getBot, listBots, deleteBot };
}

module.exports = { createBotsStore };
