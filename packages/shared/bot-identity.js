const { normalizeStatusBadge } = require("./identity.js");

const DEFAULT_BOT_CAPABILITIES = Object.freeze({
  inheritEngineDefaults: true,
  enabledPlugins: [],
  disabledPlugins: [],
  enabledSkills: [],
  disabledSkills: [],
  enabledConnectors: [],
  legacyCapabilities: []
});

function firstNonEmpty(...values) {
  for (const value of values) {
    const next = String(value || "").trim();
    if (next) return next;
  }
  return "";
}

function normalizeBotId(input) {
  return String(input || "").trim();
}

function botConversationId(sessionId) {
  const id = normalizeBotId(sessionId);
  if (!id) throw new Error("botConversationId: sessionId required");
  return id.startsWith("botc_") ? id : `botc_${id}`;
}

function normalizeBotColor(input) {
  const value = String(input || "").trim().toLowerCase();
  return /^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/.test(value) ? value : "";
}

function parseJsonObject(input, fallback = null) {
  if (!input) return fallback;
  if (typeof input === "object") return input;
  try {
    const parsed = JSON.parse(String(input || ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function statusBadgeInput(input = {}) {
  if (Object.prototype.hasOwnProperty.call(input, "statusBadge")) return input.statusBadge;
  if (Object.prototype.hasOwnProperty.call(input, "status_badge")) return input.status_badge;
  return parseJsonObject(input.status_badge_json, null);
}

function normalizeBotAvatarCrop(input) {
  return parseJsonObject(input, null);
}

function normalizeCapabilityIds(input) {
  return Array.isArray(input)
    ? [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 500)
    : [];
}

const CANONICAL_CAPABILITY_KEYS = new Set([
  "inheritEngineDefaults",
  "inherit_engine_defaults",
  "enabledPlugins",
  "enabled_plugins",
  "disabledPlugins",
  "disabled_plugins",
  "enabledSkills",
  "enabled_skills",
  "disabledSkills",
  "disabled_skills",
  "enabledConnectors",
  "enabled_connectors",
  "legacyCapabilities",
  "legacy_capabilities"
]);

function legacyBooleanCapabilities(value = {}) {
  return Object.keys(value)
    .filter((key) => !CANONICAL_CAPABILITY_KEYS.has(key) && value[key] === true);
}

function normalizeBotCapabilities(input = {}) {
  if (Array.isArray(input)) {
    return {
      ...DEFAULT_BOT_CAPABILITIES,
      legacyCapabilities: normalizeCapabilityIds(input)
    };
  }
  const value = input && typeof input === "object" ? input : {};
  return {
    ...DEFAULT_BOT_CAPABILITIES,
    inheritEngineDefaults: value.inheritEngineDefaults !== false && value.inherit_engine_defaults !== false,
    enabledPlugins: normalizeCapabilityIds(value.enabledPlugins || value.enabled_plugins),
    disabledPlugins: normalizeCapabilityIds(value.disabledPlugins || value.disabled_plugins),
    enabledSkills: normalizeCapabilityIds(value.enabledSkills || value.enabled_skills),
    disabledSkills: normalizeCapabilityIds(value.disabledSkills || value.disabled_skills),
    enabledConnectors: normalizeCapabilityIds(value.enabledConnectors || value.enabled_connectors),
    legacyCapabilities: normalizeCapabilityIds([
      ...normalizeCapabilityIds(value.legacyCapabilities || value.legacy_capabilities),
      ...legacyBooleanCapabilities(value)
    ])
  };
}

function botIdentityMatchesPreset(bot = {}, preset = {}) {
  const botKeys = [bot.key, bot.id, bot.account_id, bot.accountId]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const presetKeys = [preset.key, preset.id]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (botKeys.some((key) => presetKeys.includes(key))) return true;
  const botNames = [bot.name, bot.displayName, bot.display_name, bot.username]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const presetNames = [preset.name, preset.displayName, preset.display_name]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return botNames.some((name) => presetNames.includes(name));
}

function botCapabilitiesWithPresetDefaults(bot = {}, presets = []) {
  const capabilities = normalizeBotCapabilities(bot.capabilities);
  if (capabilities.inheritEngineDefaults === false) return capabilities;
  const preset = (Array.isArray(presets) ? presets : []).find((item) => botIdentityMatchesPreset(bot, item));
  if (!preset) return capabilities;
  const presetCapabilities = normalizeBotCapabilities({
    ...(preset.capabilities || {}),
    inheritEngineDefaults: false
  });
  if (!presetCapabilities.enabledSkills.length && !presetCapabilities.disabledSkills.length) return capabilities;
  const disabledSkills = [
    ...capabilities.disabledSkills,
    ...presetCapabilities.disabledSkills
  ].filter((id, index, arr) => arr.indexOf(id) === index);
  const disabled = new Set(disabledSkills);
  const enabledSkills = [
    ...capabilities.enabledSkills,
    ...presetCapabilities.enabledSkills.filter((id) => !disabled.has(id))
  ].filter((id, index, arr) => arr.indexOf(id) === index);
  return {
    ...capabilities,
    inheritEngineDefaults: false,
    enabledSkills,
    disabledSkills
  };
}

function normalizeBotIdentity(input = {}, options = {}) {
  if (!input || typeof input !== "object") return null;
  const id = normalizeBotId(input.id || input.botId || input.bot_id || options.id);
  if (!id || id.includes(":")) return null;
  const displayName = firstNonEmpty(input.displayName, input.display_name, input.name, input.username, id);
  return {
    kind: "bot",
    id,
    ownerUserId: firstNonEmpty(input.ownerUserId, input.owner_user_id, options.ownerUserId, options.owner_user_id),
    name: displayName,
    displayName,
    color: normalizeBotColor(firstNonEmpty(input.color, input.avatarColor, input.avatar_color)),
    avatarImage: firstNonEmpty(input.avatarImage, input.avatar_image),
    avatarCrop: normalizeBotAvatarCrop(
      Object.prototype.hasOwnProperty.call(input, "avatarCrop")
        ? input.avatarCrop
        : Object.prototype.hasOwnProperty.call(input, "avatar_crop")
          ? input.avatar_crop
          : input.avatar_crop_json
    ),
    statusBadge: normalizeStatusBadge(statusBadgeInput(input)),
    bio: firstNonEmpty(input.bio, input.description),
    capabilities: normalizeBotCapabilities(
      Object.prototype.hasOwnProperty.call(input, "capabilities")
        ? input.capabilities
        : parseJsonObject(input.capabilities_json, {})
    ),
    personaText: firstNonEmpty(input.personaText, input.persona_text),
    createdAt: firstNonEmpty(input.createdAt, input.created_at),
    updatedAt: firstNonEmpty(input.updatedAt, input.updated_at)
  };
}

module.exports = {
  DEFAULT_BOT_CAPABILITIES,
  firstNonEmpty,
  normalizeBotId,
  botConversationId,
  normalizeBotColor,
  normalizeBotAvatarCrop,
  normalizeCapabilityIds,
  normalizeBotCapabilities,
  botCapabilitiesWithPresetDefaults,
  normalizeBotIdentity
};
