"use strict";

const nativeSkillIndexCache = new Map();

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

function normalizeSkillIndexMode(value = "") {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (["always", "every-turn", "legacy", "full"].includes(raw)) return "always";
  if (["none", "off", "disabled", "never"].includes(raw)) return "none";
  return "once";
}

function skillMaterializationForNativeSession({
  engine = "",
  botId = "",
  sessionId = "",
  nativeSessionId = "",
  persistAgentSession = true,
  skillMaterialization = null,
  skillIndexMode = "",
  resetNativeSession = false
} = {}) {
  if (!skillMaterialization || typeof skillMaterialization !== "object") return skillMaterialization;
  const mode = normalizeSkillIndexMode(skillIndexMode);
  if (mode === "always" || !persistAgentSession) return skillMaterialization;

  const indexBlock = cleanText(skillMaterialization.indexBlock);
  if (!indexBlock) return skillMaterialization;
  const loadedBlock = skillMaterialization.loadedBlock;
  if (mode === "none") return { ...skillMaterialization, indexBlock: "" };

  const key = [
    safeKeyPart(engine || "engine"),
    safeKeyPart(botId || "bot"),
    safeKeyPart(nativeSessionId || sessionId || "session")
  ].join(":");
  if (resetNativeSession) nativeSkillIndexCache.delete(key);
  const previous = nativeSkillIndexCache.get(key);
  if (previous === indexBlock) return { ...skillMaterialization, indexBlock: "", loadedBlock };
  nativeSkillIndexCache.set(key, indexBlock);
  return skillMaterialization;
}

function clearNativeSkillIndexCache() {
  nativeSkillIndexCache.clear();
}

module.exports = {
  clearNativeSkillIndexCache,
  normalizeSkillIndexMode,
  skillMaterializationForNativeSession
};
