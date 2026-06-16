(function attachIds(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaIds = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildIds() {
  "use strict";

  const PUBLIC_ID_ALPHABET = "0123456789";
  const PUBLIC_ID_LENGTH = 7;
  const PUBLIC_ID_MIN_LENGTH = 6;
  const PUBLIC_ID_MAX_LENGTH = 12;
  const PUBLIC_ID_BYTES = PUBLIC_ID_LENGTH;
  const PUBLIC_ID_RE = new RegExp(`^(?:[1-9][0-9]{${PUBLIC_ID_MIN_LENGTH - 1},${PUBLIC_ID_MAX_LENGTH - 1}}|[23456789abcdefghjkmnpqrstuvwxyz]{12}|[a-f0-9]{20})$`);

  function nodeRandomBytes(size) {
    if (typeof require === "function") {
      try {
        return require("node:crypto").randomBytes(size);
      } catch {
        return null;
      }
    }
    return null;
  }

  function browserRandomBytes(size) {
    const cryptoApi = typeof crypto !== "undefined" ? crypto : null;
    if (!cryptoApi?.getRandomValues) return null;
    const out = new Uint8Array(size);
    cryptoApi.getRandomValues(out);
    return out;
  }

  function randomBytes(size, provider) {
    if (typeof provider === "function") return provider(size);
    return nodeRandomBytes(size) || browserRandomBytes(size);
  }

  function toPublicId(bytes) {
    if (!bytes) throw new Error("secure random bytes unavailable");
    return Array.from(bytes, (byte, index) => {
      const value = Number(byte);
      if (index === 0) return String((value % 9) + 1);
      return String(value % 10);
    }).join("");
  }

  function generatePublicId(provider) {
    return toPublicId(randomBytes(PUBLIC_ID_BYTES, provider));
  }

  function generatePrincipalId(provider) {
    return generatePublicId(provider);
  }

  function generateGroupPublicId(provider) {
    return generatePublicId(provider);
  }

  function isPublicId(value) {
    return PUBLIC_ID_RE.test(String(value || "").trim().toLowerCase());
  }

  function publicIdFromConversationId(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id.startsWith("g_")) return "";
    return id.slice(2);
  }

  function groupConversationId(publicId) {
    const id = String(publicId || "").trim();
    if (!id) throw new Error("groupConversationId: publicId required");
    return id.startsWith("g_") ? id : `g_${id}`;
  }

  return {
    PUBLIC_ID_BYTES,
    PUBLIC_ID_LENGTH,
    PUBLIC_ID_MIN_LENGTH,
    PUBLIC_ID_MAX_LENGTH,
    PUBLIC_ID_ALPHABET,
    PUBLIC_ID_RE,
    generatePublicId,
    generatePrincipalId,
    generateGroupPublicId,
    isPublicId,
    publicIdFromConversationId,
    groupConversationId
  };
});
