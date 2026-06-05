const MessageCapability = Object.freeze({
  Reply: "reply",
  Copy: "copy",
  Pin: "pin",
  Delete: "delete"
});

function defaultCapabilities() {
  return { reply: false, copy: false, pin: false, delete: false };
}

function identityApi() {
  if (typeof window !== "undefined" && window.miaIdentity) return window.miaIdentity;
  if (typeof globalThis !== "undefined" && globalThis.miaIdentity) return globalThis.miaIdentity;
  if (typeof require === "function") {
    try { return require("./identity.js"); } catch { /* optional in browser-like sandboxes */ }
  }
  return null;
}

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

function normalizeLocalAvatar(input = {}) {
  const avatar = input && typeof input === "object" ? input : {};
  return {
    image: clean(avatar.image),
    crop: avatar.crop && typeof avatar.crop === "object" ? avatar.crop : null,
    color: clean(avatar.color),
    text: clean(avatar.text)
  };
}

function normalizeLocalStatusBadge(input) {
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

function normalizeLocalIdentity(input = {}) {
  if (!input || typeof input !== "object") return null;
  const kind = clean(input.kind);
  const id = clean(input.id);
  if ((kind !== "user" && kind !== "bot") || !id || id.includes(":")) return null;
  const out = {
    kind,
    id,
    displayName: firstNonEmpty(input.displayName, input.display_name, input.name, id),
    avatar: normalizeLocalAvatar(input.avatar || input)
  };
  const badge = normalizeLocalStatusBadge(input.statusBadge || input.status_badge);
  if (badge) out.statusBadge = badge;
  if (kind === "bot") {
    const ownerUserId = firstNonEmpty(input.ownerUserId, input.owner_user_id, input.ownerId, input.owner_id);
    if (ownerUserId) out.ownerUserId = ownerUserId;
  }
  return out;
}

function normalizeIdentity(input) {
  const api = identityApi();
  return api && typeof api.normalizeIdentity === "function"
    ? api.normalizeIdentity(input)
    : normalizeLocalIdentity(input);
}

function normalizeStatusBadge(input) {
  const api = identityApi();
  return api && typeof api.normalizeStatusBadge === "function"
    ? api.normalizeStatusBadge(input)
    : normalizeLocalStatusBadge(input);
}

function normalizeSpec(input = {}) {
  const normalizedIdentity = normalizeIdentity(input.authorIdentity || input.author_identity);
  return {
    source: input.source || "",
    conversationId: input.conversationId || "",
    messageId: input.messageId || "",
    messageIndex: typeof input.messageIndex === "number" ? input.messageIndex : 0,
    role: ["user", "assistant", "system"].includes(input.role) ? input.role : "assistant",
    authorIdentity: normalizedIdentity || null,
    authorName: normalizedIdentity?.displayName || input.authorName || "",
    statusBadge: normalizedIdentity?.statusBadge || normalizeStatusBadge(input.statusBadge || input.status_badge),
    avatar: input.avatar && typeof input.avatar === "object"
      ? { image: input.avatar.image || "", crop: input.avatar.crop || null, color: input.avatar.color || "", text: input.avatar.text || "" }
      : { image: "", crop: null, color: "", text: "" },
    bodyMd: typeof input.bodyMd === "string" ? input.bodyMd : "",
    createdAt: input.createdAt || "",
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    mentions: Array.isArray(input.mentions) ? input.mentions : [],
    isOwn: Boolean(input.isOwn),
    isPending: Boolean(input.isPending),
    capabilities: Object.assign(defaultCapabilities(), input.capabilities || {})
  };
}

const __miaMessageSpecExports = { MessageCapability, defaultCapabilities, normalizeSpec };
if (typeof module !== "undefined" && module.exports) module.exports = __miaMessageSpecExports;
if (typeof window !== "undefined") window.miaMessageSpec = __miaMessageSpecExports;
