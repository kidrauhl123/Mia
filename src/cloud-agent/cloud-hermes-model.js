const DEFAULT_CLOUD_HERMES_MODEL = "mia-default";

const LEGACY_CLOUD_HERMES_MODELS = new Set([
  "auto",
  "default",
  "hermes",
  "hermes-agent",
  "mia",
  "mia-auto",
  "mia:auto",
  "mia/default",
  "mia:mia-auto"
]);

function normalizeCloudHermesModel(value, options = {}) {
  const fallback = String(options.defaultModel || DEFAULT_CLOUD_HERMES_MODEL).trim() || DEFAULT_CLOUD_HERMES_MODEL;
  const raw = String(value || "").trim().slice(0, 160);
  if (!raw) return fallback;
  const legacyKey = raw.toLowerCase().replace(/_/g, "-");
  if (LEGACY_CLOUD_HERMES_MODELS.has(legacyKey)) return fallback;
  return raw;
}

module.exports = {
  DEFAULT_CLOUD_HERMES_MODEL,
  normalizeCloudHermesModel
};
