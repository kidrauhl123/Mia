"use strict";

const nativePersonaCache = new Map();

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

function normalizePersonaInjectionMode(value = "") {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (["always", "every-turn", "legacy", "full"].includes(raw)) return "always";
  if (["none", "off", "disabled", "never"].includes(raw)) return "none";
  return "changed";
}

function personaBlockForNativeSession({
  engine = "",
  botId = "",
  sessionId = "",
  nativeSessionId = "",
  persistAgentSession = true,
  personaBlock = "",
  personaInjectionMode = "",
  resetNativeSession = false
} = {}) {
  const block = cleanText(personaBlock);
  if (!block) return "";
  const mode = normalizePersonaInjectionMode(personaInjectionMode);
  if (mode === "always" || !persistAgentSession) return block;
  if (mode === "none") return "";

  const key = [
    safeKeyPart(engine || "engine"),
    safeKeyPart(botId || "bot"),
    safeKeyPart(nativeSessionId || sessionId || "session")
  ].join(":");
  if (resetNativeSession) nativePersonaCache.delete(key);
  const previous = nativePersonaCache.get(key);
  if (previous === block) return "";
  nativePersonaCache.set(key, block);
  return block;
}

function clearNativePersonaCache() {
  nativePersonaCache.clear();
}

module.exports = {
  clearNativePersonaCache,
  normalizePersonaInjectionMode,
  personaBlockForNativeSession
};
