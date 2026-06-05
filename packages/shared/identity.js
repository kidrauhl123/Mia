"use strict";

const IdentityKind = Object.freeze({
  User: "user",
  Bot: "bot"
});

function clean(value) {
  return String(value || "").trim();
}

function hasIllegalIdentityPrefix(id) {
  return id.startsWith("user:") || id.startsWith("bot:") || id.startsWith("fellow:");
}

function normalizeAvatar(input = {}) {
  const avatar = input && typeof input === "object" ? input : {};
  return {
    image: clean(avatar.image),
    crop: avatar.crop && typeof avatar.crop === "object" ? avatar.crop : null,
    color: clean(avatar.color),
    text: clean(avatar.text)
  };
}

function normalizeStatusBadge(input) {
  if (!input || typeof input !== "object") return null;
  const kind = clean(input.kind);
  const label = clean(input.label);
  if (kind === "emoji") {
    const emoji = clean(input.emoji);
    return emoji ? { kind, emoji, ...(label ? { label } : {}) } : null;
  }
  if (kind === "lottie") {
    const assetId = clean(input.assetId || input.asset_id);
    const loop = clean(input.loop);
    return assetId ? { kind, assetId, ...(label ? { label } : {}), ...(loop ? { loop } : {}) } : null;
  }
  if (kind === "gift") {
    const assetId = clean(input.assetId || input.asset_id);
    const collectibleId = clean(input.collectibleId || input.collectible_id);
    return assetId ? { kind, assetId, ...(label ? { label } : {}), ...(collectibleId ? { collectibleId } : {}) } : null;
  }
  return null;
}

function normalizeIdentity(input = {}) {
  if (!input || typeof input !== "object") return null;
  const kind = clean(input.kind);
  const id = clean(input.id);
  if (!id || hasIllegalIdentityPrefix(id)) return null;
  if (kind !== IdentityKind.User && kind !== IdentityKind.Bot) return null;
  const displayName = clean(input.displayName || input.display_name || input.name || id);
  const out = {
    kind,
    id,
    displayName,
    avatar: normalizeAvatar(input.avatar || input)
  };
  const badge = normalizeStatusBadge(input.statusBadge || input.status_badge);
  if (badge) out.statusBadge = badge;
  if (kind === IdentityKind.Bot) {
    const ownerUserId = clean(input.ownerUserId || input.owner_user_id || input.ownerId || input.owner_id);
    if (ownerUserId) out.ownerUserId = ownerUserId;
  }
  return out;
}

function identityKey(identity) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) return "";
  return `${normalized.kind}:${normalized.id}`;
}

module.exports = {
  IdentityKind,
  normalizeIdentity,
  normalizeStatusBadge,
  identityKey
};
