const DEFAULT_FELLOW_ID = "mia";
const { fellowConversationId } = require("./session-history.js");

const DEFAULT_FELLOW_CAPABILITIES = Object.freeze({
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

function normalizeFellowId(input) {
  return String(input || "").trim();
}

function fellowGlobalId(ownerUserId, fellowId) {
  const owner = normalizeFellowId(ownerUserId);
  const id = normalizeFellowId(fellowId);
  return owner && id ? fellowConversationId(owner, id) : "";
}

function parseFellowGlobalId(input) {
  const value = normalizeFellowId(input);
  if (!value.startsWith("fellow:")) return null;
  const parts = value.split(":");
  const ownerUserId = normalizeFellowId(parts[1]);
  const id = normalizeFellowId(parts.slice(2).join(":"));
  const globalId = fellowGlobalId(ownerUserId, id);
  return globalId ? { ownerUserId, id, globalId } : null;
}

function normalizeFellowColor(input) {
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

function normalizeFellowAvatarCrop(input) {
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

function normalizeFellowCapabilities(input = {}) {
  if (Array.isArray(input)) {
    return {
      ...DEFAULT_FELLOW_CAPABILITIES,
      legacyCapabilities: normalizeCapabilityIds(input)
    };
  }
  const value = input && typeof input === "object" ? input : {};
  return {
    ...DEFAULT_FELLOW_CAPABILITIES,
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

function defaultCloudFellowCapabilities() {
  return normalizeFellowCapabilities({
    legacyCapabilities: ["chat", "files", "terminal", "code"]
  });
}

function normalizeFellowIdentity(input = {}, options = {}) {
  if (!input || typeof input !== "object") return null;
  const parsedGlobalId = parseFellowGlobalId(
    input.globalId
      || input.global_id
      || input.fellowGlobalId
      || input.fellow_global_id
      || options.globalId
      || options.global_id
  );
  const id = normalizeFellowId(
    input.id
      || input.key
      || input.fellowId
      || input.fellow_id
      || input.account_id
      || parsedGlobalId?.id
      || options.id
      || options.key
  );
  const key = normalizeFellowId(
    input.key
      || input.id
      || input.fellowKey
      || input.fellow_key
      || input.account_id
      || parsedGlobalId?.id
      || id
  );
  const fellowId = id || key;
  if (!fellowId) return null;
  const ownerUserId = firstNonEmpty(
    input.ownerUserId,
    input.owner_user_id,
    options.ownerUserId,
    options.owner_user_id,
    parsedGlobalId?.ownerUserId
  );
  const displayName = firstNonEmpty(input.displayName, input.display_name, input.name, input.username, fellowId);
  return {
    id: fellowId,
    key: key || fellowId,
    ownerUserId,
    globalId: fellowGlobalId(ownerUserId, fellowId),
    name: displayName,
    displayName,
    color: normalizeFellowColor(firstNonEmpty(input.color, input.avatarColor, input.avatar_color)),
    avatarImage: firstNonEmpty(input.avatarImage, input.avatar_image),
    avatarCrop: normalizeFellowAvatarCrop(
      Object.prototype.hasOwnProperty.call(input, "avatarCrop")
        ? input.avatarCrop
        : Object.prototype.hasOwnProperty.call(input, "avatar_crop")
          ? input.avatar_crop
          : input.avatar_crop_json
    ),
    bio: firstNonEmpty(input.bio, input.description),
    capabilities: normalizeFellowCapabilities(
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
  DEFAULT_FELLOW_ID,
  DEFAULT_FELLOW_CAPABILITIES,
  firstNonEmpty,
  normalizeFellowId,
  fellowGlobalId,
  parseFellowGlobalId,
  normalizeFellowColor,
  normalizeFellowAvatarCrop,
  normalizeCapabilityIds,
  normalizeFellowCapabilities,
  defaultCloudFellowCapabilities,
  normalizeFellowIdentity
};
