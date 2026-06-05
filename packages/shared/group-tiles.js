(function attachGroupTiles(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaGroupTiles = api;
})(typeof window !== "undefined" ? window : globalThis, function buildGroupTiles(root) {
  "use strict";

  function avatarResolver() {
    if (root && root.miaAvatarResolve) return root.miaAvatarResolve;
    if (typeof globalThis !== "undefined" && globalThis.miaAvatarResolve) return globalThis.miaAvatarResolve;
    if (typeof require === "function") {
      try { return require("./avatar.js"); } catch { /* optional in browser-like sandboxes */ }
    }
    return null;
  }

  function contactResolver() {
    if (root && root.miaContact) return root.miaContact;
    if (typeof globalThis !== "undefined" && globalThis.miaContact) return globalThis.miaContact;
    if (typeof require === "function") {
      try { return require("./contact.js"); } catch { /* optional in browser-like sandboxes */ }
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

  function botAvatarIdentityId(ref, bot = {}, member = {}) {
    const identity = member.identity || {};
    const record = {
      ...(bot || {}),
      member_ref: ref,
      botId: firstNonEmpty(bot?.botId, bot?.bot_id, identity.botId, identity.bot_id),
      ownerUserId: firstNonEmpty(
        bot?.ownerUserId,
        bot?.owner_user_id,
        bot?.ownerId,
        bot?.owner_id,
        member.owner_user_id,
        member.owner_id,
        identity.ownerUserId,
        identity.owner_id
      )
    };
    const helper = contactResolver();
    if (helper && typeof helper.botAvatarIdentityId === "function") {
      return helper.botAvatarIdentityId(ref, record);
    }
    return firstNonEmpty(ref, record.id, record.botId, record.bot_id, record.member_ref);
  }

  function resolveTile(input) {
    const resolver = avatarResolver();
    if (resolver && typeof resolver.resolveAvatarForContact === "function") {
      const result = resolver.resolveAvatarForContact(input);
      return { image: result.image, crop: result.crop, color: result.color, text: result.text };
    }
    return {
      image: input.avatarImage || "",
      crop: input.avatarCrop || null,
      color: input.color || "#5e5ce6",
      text: String(input.displayName || input.id || "?").trim().slice(0, 2) || "?"
    };
  }

  function hasAvatarIdentityFields(record) {
    const resolver = avatarResolver();
    if (resolver && typeof resolver.hasAvatarIdentityFields === "function") {
      return resolver.hasAvatarIdentityFields(record);
    }
    return Boolean(record && typeof record === "object" && (
      Object.prototype.hasOwnProperty.call(record, "avatarImage")
        || Object.prototype.hasOwnProperty.call(record, "avatarCrop")
        || Object.prototype.hasOwnProperty.call(record, "avatar_image")
        || Object.prototype.hasOwnProperty.call(record, "avatar_crop")
    ));
  }

  function resolveGroupMemberTiles(members, ctx = {}) {
    if (!Array.isArray(members)) return [];
    const { self, friends, bots } = ctx;
    const out = [];
    for (const m of members) {
      if (!m) continue;
      const kind = m.member_kind;
      const ref = String(m.member_ref || "");
      if (kind === "user") {
        const identityAvatar = m.identity?.avatar || {};
        if (self && ref === self.id) {
          const hasSelfAvatar = hasAvatarIdentityFields(self);
          out.push(resolveTile({
            id: self.id,
            displayName: self.displayName || self.username || self.account || m.identity?.displayName || self.id,
            avatarImage: hasSelfAvatar ? self.avatarImage : identityAvatar.image,
            avatarCrop: hasSelfAvatar ? self.avatarCrop : identityAvatar.crop,
            color: hasSelfAvatar ? (self.avatarColor || self.color || "") : (identityAvatar.color || "")
          }));
          continue;
        }
        const friend = (friends || []).find((f) => f.id === ref);
        const hasFriend = Boolean(friend);
        const hasFriendAvatar = hasAvatarIdentityFields(friend);
        out.push(resolveTile({
          id: ref,
          displayName: friend?.displayName || friend?.username || friend?.account || m.identity?.displayName || ref,
          avatarImage: hasFriend && hasFriendAvatar ? friend.avatarImage : identityAvatar.image,
          avatarCrop: hasFriend && hasFriendAvatar ? friend.avatarCrop : identityAvatar.crop,
          color: hasFriend && hasFriendAvatar ? (friend.avatarColor || friend.color || "") : (identityAvatar.color || "")
        }));
        continue;
      }
      if (kind === "bot") {
        const bot = (bots || []).find((b) => (b.id || b.botId || b.bot_id) === ref);
        const hasBot = Boolean(bot);
        const hasBotAvatar = hasAvatarIdentityFields(bot);
        const identityAvatar = m.identity?.avatar || {};
        out.push(resolveTile({
          id: botAvatarIdentityId(ref, bot || {}, m),
          displayName: bot?.displayName || bot?.display_name || bot?.name || m.identity?.displayName || m.bot_name || ref,
          avatarImage: hasBot && hasBotAvatar ? (bot.avatarImage || bot.avatar_image) : (identityAvatar.image || m.bot_avatar_image),
          avatarCrop: hasBot && hasBotAvatar ? (bot.avatarCrop || bot.avatar_crop) : (identityAvatar.crop || m.bot_avatar_crop),
          color: hasBot && hasBotAvatar
            ? (bot.color || bot.avatarColor || bot.avatar_color || "")
            : (identityAvatar.color || m.bot_color || m.avatarColor || m.avatar_color || "")
        }));
      }
    }
    return out;
  }

  function localGroupAsMembers(group, selfId) {
    const members = [];
    if (selfId) members.push({ member_kind: "user", member_ref: selfId });
    for (const m of (group?.members || [])) {
      if (m && m.botId) members.push({ member_kind: "bot", member_ref: m.botId });
    }
    return members;
  }

  return { resolveGroupMemberTiles, localGroupAsMembers };
});
