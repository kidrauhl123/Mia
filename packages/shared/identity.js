(function attachIdentity(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaIdentity = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildIdentity() {
  "use strict";

  const IdentityKind = Object.freeze({
    User: "user",
    Bot: "bot"
  });

  function clean(value) {
    return String(value || "").trim();
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const next = clean(value);
      if (next) return next;
    }
    return "";
  }

  function hasIllegalIdentitySeparator(id) {
    return id.includes(":");
  }

  function parseJsonObject(input, fallback = null) {
    if (!input) return fallback;
    if (typeof input === "object") return input;
    try {
      const parsed = JSON.parse(String(input || ""));
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
      return fallback;
    }
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
    const label = firstNonEmpty(input.label);
    if (kind === "emoji") {
      const emoji = clean(input.emoji);
      return emoji ? { kind, emoji, ...(label ? { label } : {}) } : null;
    }
    if (kind === "lottie") {
      const assetId = firstNonEmpty(input.assetId, input.asset_id);
      const loop = firstNonEmpty(input.loop);
      return assetId ? { kind, assetId, ...(label ? { label } : {}), ...(loop ? { loop } : {}) } : null;
    }
    if (kind === "gift") {
      const assetId = firstNonEmpty(input.assetId, input.asset_id);
      const collectibleId = firstNonEmpty(input.collectibleId, input.collectible_id);
      return assetId ? { kind, assetId, ...(label ? { label } : {}), ...(collectibleId ? { collectibleId } : {}) } : null;
    }
    return null;
  }

  function normalizeIdentity(input = {}) {
    if (!input || typeof input !== "object") return null;
    const kind = clean(input.kind);
    const id = clean(input.id);
    if (!id || hasIllegalIdentitySeparator(id)) return null;
    if (kind !== IdentityKind.User && kind !== IdentityKind.Bot) return null;
    const displayName = firstNonEmpty(input.displayName, input.display_name, input.name, id);
    const out = {
      kind,
      id,
      displayName,
      avatar: normalizeAvatar(input.avatar || input)
    };
    const badge = normalizeStatusBadge(input.statusBadge || input.status_badge || parseJsonObject(input.status_badge_json, null));
    if (badge) out.statusBadge = badge;
    if (kind === IdentityKind.Bot) {
      const ownerUserId = firstNonEmpty(input.ownerUserId, input.owner_user_id, input.ownerId, input.owner_id);
      if (ownerUserId) out.ownerUserId = ownerUserId;
    }
    return out;
  }

  function identityKey(identity) {
    const normalized = normalizeIdentity(identity);
    if (!normalized) return "";
    return `${normalized.kind}:${normalized.id}`;
  }

  return {
    IdentityKind,
    normalizeIdentity,
    normalizeStatusBadge,
    identityKey
  };
});
