"use strict";

const nativeMemoryCache = new Map();

function cleanText(value = "") {
  return String(value || "").trim();
}

function safeKeyPart(value = "") {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w:./@-]/g, "_")
    .slice(0, 180);
}

function normalizeMemoryInjectionMode(value = "") {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (["always", "every-turn", "legacy", "full"].includes(raw)) return "always";
  if (["none", "off", "disabled", "never"].includes(raw)) return "none";
  return "changed";
}

function memoryBlockForNativeSession({
  engine = "",
  botId = "",
  sessionId = "",
  nativeSessionId = "",
  persistAgentSession = true,
  memoryBlock = "",
  memoryInjectionMode = "",
  resetNativeSession = false
} = {}) {
  const block = cleanText(memoryBlock);
  if (!block) return "";
  const mode = normalizeMemoryInjectionMode(memoryInjectionMode);
  if (mode === "always" || !persistAgentSession) return block;
  if (mode === "none") return "";

  const key = [
    safeKeyPart(engine || "engine"),
    safeKeyPart(botId || "bot"),
    safeKeyPart(nativeSessionId || sessionId || "session")
  ].join(":");
  if (resetNativeSession) nativeMemoryCache.delete(key);
  const previous = nativeMemoryCache.get(key);
  if (previous === block) return "";
  nativeMemoryCache.set(key, block);
  return block;
}

function clearNativeMemoryCache() {
  nativeMemoryCache.clear();
}

module.exports = {
  clearNativeMemoryCache,
  memoryBlockForNativeSession,
  normalizeMemoryInjectionMode
};
