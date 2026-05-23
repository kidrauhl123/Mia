const MessageCapability = Object.freeze({
  Reply: "reply",
  Copy: "copy",
  Pin: "pin",
  Delete: "delete"
});

function defaultCapabilities() {
  return { reply: false, copy: false, pin: false, delete: false };
}

function normalizeSpec(input = {}) {
  return {
    source: input.source || "",
    conversationId: input.conversationId || "",
    messageId: input.messageId || "",
    messageIndex: typeof input.messageIndex === "number" ? input.messageIndex : 0,
    role: ["user", "assistant", "system"].includes(input.role) ? input.role : "assistant",
    authorName: input.authorName || "",
    avatar: input.avatar && typeof input.avatar === "object"
      ? { image: input.avatar.image || "", crop: input.avatar.crop || null, color: input.avatar.color || "" }
      : { image: "", crop: null, color: "" },
    bodyMd: typeof input.bodyMd === "string" ? input.bodyMd : "",
    createdAt: input.createdAt || "",
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    mentions: Array.isArray(input.mentions) ? input.mentions : [],
    isOwn: Boolean(input.isOwn),
    isPending: Boolean(input.isPending),
    capabilities: Object.assign(defaultCapabilities(), input.capabilities || {})
  };
}

const __aimashiMessageSpecExports = { MessageCapability, defaultCapabilities, normalizeSpec };
if (typeof module !== "undefined" && module.exports) module.exports = __aimashiMessageSpecExports;
if (typeof window !== "undefined") window.aimashiMessageSpec = __aimashiMessageSpecExports;
