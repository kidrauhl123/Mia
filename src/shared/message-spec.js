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

function normalizeIdentity(input) {
  const api = identityApi();
  return api && typeof api.normalizeIdentity === "function" ? api.normalizeIdentity(input) : null;
}

function normalizeStatusBadge(input) {
  const api = identityApi();
  return api && typeof api.normalizeStatusBadge === "function" ? api.normalizeStatusBadge(input) : null;
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
