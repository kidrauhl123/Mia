(function attachContact(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaContact = api;
})(typeof window !== "undefined" ? window : globalThis, function buildContact(root) {
  "use strict";

  const IdentityKind = Object.freeze({
    User: "user",
    Bot: "bot"
  });

  function avatarResolver() {
    if (root && root.miaAvatarResolve) return root.miaAvatarResolve;
    if (typeof globalThis !== "undefined" && globalThis.miaAvatarResolve) return globalThis.miaAvatarResolve;
    if (typeof require === "function") {
      try { return require("./avatar.js"); } catch { /* optional in browser-like sandboxes */ }
    }
    return null;
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const next = String(value || "").trim();
      if (next) return next;
    }
    return "";
  }

  function botAvatarIdentityId(id, record = {}) {
    return firstNonEmpty(record.id, record.botId, record.bot_id, record.key, record.member_ref, id);
  }

  function avatarForRecord(id, record = {}, displayName = "") {
    const resolver = avatarResolver();
    const input = {
      id: String(id || ""),
      displayName: displayName || record.displayName || record.display_name || record.name || record.username || record.account || record.avatarText || "",
      avatarImage: record.avatarImage || record.avatar_image || "",
      avatarCrop: record.avatarCrop || record.avatar_crop || null,
      color: record.color || record.avatarColor || record.avatar_color || ""
    };
    if (resolver && typeof resolver.resolveAvatarForContact === "function") {
      return resolver.resolveAvatarForContact(input);
    }
    return {
      image: input.avatarImage,
      crop: input.avatarCrop,
      color: input.color || "#5e5ce6",
      text: String(input.displayName || input.id || "?").trim().slice(0, 2) || "?"
    };
  }

  function avatarForBotRecord(id, record = {}, displayName = "") {
    return avatarForRecord(botAvatarIdentityId(id, record), record, displayName);
  }

  function resolveContact(query, ctx = {}) {
    const { kind, ref } = query || {};
    if (kind === "self") {
      const u = ctx.self || {};
      const displayName = u.displayName || u.username || u.account || u.avatarText || "";
      return {
        kind: IdentityKind.User,
        id: u.id || "",
        displayName,
        avatar: avatarForRecord(u.id, u, displayName)
      };
    }
    if (kind === IdentityKind.Bot) {
      const bots = Array.isArray(ctx.bots) ? ctx.bots : [];
      const b = bots.find((x) => x.id === ref || x.key === ref || x.botId === ref || x.bot_id === ref);
      const id = String((b && (b.id || b.key || b.botId || b.bot_id)) || ref || "");
      const displayName = (b && (b.displayName || b.display_name || b.name || b.username || b.id)) || String(ref || "");
      return {
        kind: IdentityKind.Bot,
        id,
        ownerUserId: firstNonEmpty(b?.ownerUserId, b?.owner_user_id),
        displayName,
        avatar: avatarForBotRecord(id, b || {}, displayName)
      };
    }
    if (kind === IdentityKind.User) {
      if (ctx.self && ctx.self.id === ref) return resolveContact({ kind: "self" }, ctx);
      const friends = Array.isArray(ctx.friends) ? ctx.friends : [];
      const f = friends.find((x) => x.id === ref);
      const id = String((f && f.id) || ref || "");
      const displayName = (f && (f.displayName || f.username || f.account || f.id)) || String(ref || "");
      return {
        kind: IdentityKind.User,
        id,
        displayName,
        avatar: avatarForRecord(id, f || {}, displayName)
      };
    }
    return {
      kind: "",
      id: "",
      displayName: "",
      avatar: avatarForRecord("", {})
    };
  }

  return { resolveContact, IdentityKind, avatarForRecord, avatarForBotRecord, botAvatarIdentityId };
});
