(function attachContact(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaContact = api;
})(typeof window !== "undefined" ? window : globalThis, function buildContact(root) {
  "use strict";

  const ContactKind = Object.freeze({
    Self: "self",
    Fellow: "fellow",
    User: "user"
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

  function fellowIdentity() {
    if (root && root.miaFellowIdentity) return root.miaFellowIdentity;
    if (typeof globalThis !== "undefined" && globalThis.miaFellowIdentity) return globalThis.miaFellowIdentity;
    if (typeof require === "function") {
      try { return require("./fellow-identity.js"); } catch { /* optional in browser-like sandboxes */ }
    }
    return null;
  }

  function fellowAvatarIdentityId(id, record = {}) {
    const localId = firstNonEmpty(id, record.key, record.id, record.fellowId, record.fellow_id, record.member_ref);
    const globalId = firstNonEmpty(record.globalId, record.global_id, record.fellowGlobalId, record.fellow_global_id);
    if (globalId) return globalId;
    const ownerUserId = firstNonEmpty(record.ownerUserId, record.owner_user_id, record.ownerId, record.owner_id);
    if (ownerUserId && localId) {
      const fromIdentity = fellowIdentity()?.fellowGlobalId?.(ownerUserId, localId);
      return fromIdentity || "fellow:" + ownerUserId + ":" + localId;
    }
    return localId;
  }

  function avatarForRecord(id, record = {}, displayName = "") {
    const resolver = avatarResolver();
    const input = {
      id: String(id || ""),
      displayName: displayName || record.displayName || record.name || record.username || record.account || record.avatarText || "",
      avatarImage: record.avatarImage || "",
      avatarCrop: record.avatarCrop || null,
      color: record.color || record.avatarColor || ""
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

  function avatarForFellowRecord(id, record = {}, displayName = "") {
    return avatarForRecord(fellowAvatarIdentityId(id, record), record, displayName);
  }

  function resolveContact(query, ctx = {}) {
    const { kind, ref } = query || {};
    if (kind === ContactKind.Self) {
      const u = ctx.self || {};
      const displayName = u.displayName || u.username || u.account || u.avatarText || "";
      return {
        kind: ContactKind.Self,
        id: u.id || "",
        displayName,
        avatar: avatarForRecord(u.id, u, displayName)
      };
    }
    if (kind === ContactKind.Fellow) {
      const fellows = Array.isArray(ctx.fellows) ? ctx.fellows : [];
      const f = fellows.find((x) => x.key === ref || x.id === ref);
      const id = String((f && (f.key || f.id)) || ref || "");
      const displayName = (f && (f.name || f.key)) || String(ref || "");
      return {
        kind: ContactKind.Fellow,
        id,
        displayName,
        avatar: avatarForFellowRecord(id, f || {}, displayName)
      };
    }
    if (kind === ContactKind.User) {
      if (ctx.self && ctx.self.id === ref) return resolveContact({ kind: ContactKind.Self }, ctx);
      const friends = Array.isArray(ctx.friends) ? ctx.friends : [];
      const f = friends.find((x) => x.id === ref);
      const id = String((f && f.id) || ref || "");
      const displayName = (f && (f.username || f.account || f.id)) || String(ref || "");
      return {
        kind: ContactKind.User,
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

  return { resolveContact, ContactKind, avatarForRecord, avatarForFellowRecord, fellowAvatarIdentityId };
});
