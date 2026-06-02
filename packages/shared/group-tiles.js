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

  function fellowAvatarIdentityId(ref, fellow = {}, member = {}) {
    const identity = member.identity || {};
    const record = {
      ...(fellow || {}),
      member_ref: ref,
      globalId: firstNonEmpty(fellow?.globalId, fellow?.global_id, identity.globalId, identity.global_id),
      fellowGlobalId: firstNonEmpty(fellow?.fellowGlobalId, fellow?.fellow_global_id),
      ownerUserId: firstNonEmpty(
        fellow?.ownerUserId,
        fellow?.owner_user_id,
        fellow?.ownerId,
        fellow?.owner_id,
        member.owner_user_id,
        member.owner_id,
        identity.ownerUserId,
        identity.owner_id
      )
    };
    const helper = contactResolver();
    if (helper && typeof helper.fellowAvatarIdentityId === "function") {
      return helper.fellowAvatarIdentityId(ref, record);
    }
    const localId = firstNonEmpty(ref, record.key, record.id);
    if (record.globalId) return record.globalId;
    return record.ownerUserId && localId ? "fellow:" + record.ownerUserId + ":" + localId : localId;
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
    const { self, friends, fellows } = ctx;
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
            avatarCrop: hasSelfAvatar ? self.avatarCrop : identityAvatar.crop
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
          avatarCrop: hasFriend && hasFriendAvatar ? friend.avatarCrop : identityAvatar.crop
        }));
        continue;
      }
      if (kind === "fellow") {
        const fellow = (fellows || []).find((f) => (f.id || f.key) === ref);
        const hasFellow = Boolean(fellow);
        const hasFellowAvatar = hasAvatarIdentityFields(fellow);
        const identityAvatar = m.identity?.avatar || {};
        out.push(resolveTile({
          id: fellowAvatarIdentityId(ref, fellow || {}, m),
          displayName: fellow?.name || fellow?.displayName || m.identity?.displayName || m.fellow_name || ref,
          avatarImage: hasFellow && hasFellowAvatar ? fellow.avatarImage : (identityAvatar.image || m.fellow_avatar_image),
          avatarCrop: hasFellow && hasFellowAvatar ? fellow.avatarCrop : (identityAvatar.crop || m.fellow_avatar_crop)
        }));
      }
    }
    return out;
  }

  function localGroupAsMembers(group, selfId) {
    const members = [];
    if (selfId) members.push({ member_kind: "user", member_ref: selfId });
    for (const m of (group?.members || [])) {
      if (m && m.fellowId) members.push({ member_kind: "fellow", member_ref: m.fellowId });
    }
    return members;
  }

  return { resolveGroupMemberTiles, localGroupAsMembers };
});
