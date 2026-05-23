const ContactKind = Object.freeze({
  Self: "self",
  Fellow: "fellow",
  User: "user"
});

function emptyAvatar(color) {
  return { image: "", crop: null, color: color || "#5e5ce6" };
}

function avatarFromFellow(f) {
  return {
    image: f.avatarImage || "",
    crop: f.avatarCrop || null,
    color: f.color || "#5e5ce6"
  };
}

function avatarFromUser(u) {
  return {
    image: u.avatarImage || "",
    crop: u.avatarCrop || null,
    color: u.avatarColor || "#5e5ce6"
  };
}

function resolveContact(query, ctx = {}) {
  const { kind, ref } = query || {};
  if (kind === ContactKind.Self) {
    const u = ctx.self || {};
    return {
      kind: ContactKind.Self,
      id: u.id || "",
      displayName: u.username || u.account || "",
      avatar: avatarFromUser(u)
    };
  }
  if (kind === ContactKind.Fellow) {
    const fellows = Array.isArray(ctx.fellows) ? ctx.fellows : [];
    const f = fellows.find((x) => x.key === ref || x.id === ref);
    if (f) return { kind: ContactKind.Fellow, id: f.key || f.id, displayName: f.name || f.key, avatar: avatarFromFellow(f) };
    return { kind: ContactKind.Fellow, id: String(ref || ""), displayName: String(ref || ""), avatar: emptyAvatar() };
  }
  if (kind === ContactKind.User) {
    const friends = Array.isArray(ctx.friends) ? ctx.friends : [];
    if (ctx.self && (ctx.self.id === ref)) return resolveContact({ kind: ContactKind.Self }, ctx);
    const f = friends.find((x) => x.id === ref);
    if (f) return { kind: ContactKind.User, id: f.id, displayName: f.username || f.account || f.id, avatar: avatarFromUser(f) };
    return { kind: ContactKind.User, id: String(ref || ""), displayName: String(ref || ""), avatar: emptyAvatar() };
  }
  return { kind: "", id: "", displayName: "", avatar: emptyAvatar() };
}

const __aimashiContactExports = { resolveContact, ContactKind };
if (typeof module !== "undefined" && module.exports) module.exports = __aimashiContactExports;
if (typeof window !== "undefined") window.aimashiContact = __aimashiContactExports;
