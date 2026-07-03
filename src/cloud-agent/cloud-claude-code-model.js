const DEFAULT_CLOUD_CLAUDE_CODE_MODEL = "claude-sonnet-4-5";

const LEGACY_CLOUD_MODEL_ALIASES = new Set([
  "auto",
  "default",
  "hermes",
  "hermes-agent",
  "mia",
  "mia:auto",
  "mia/default",
  "mia-auto",
  "mia-default",
  "mia:mia-auto",
  "mia:mia-default"
]);

function normalizeCloudClaudeCodeModel(value, options = {}) {
  const fallback = String(options.defaultModel || DEFAULT_CLOUD_CLAUDE_CODE_MODEL).trim()
    || DEFAULT_CLOUD_CLAUDE_CODE_MODEL;
  const raw = String(value || "").trim().slice(0, 160);
  if (!raw) return fallback;
  const key = raw.toLowerCase().replace(/_/g, "-");
  if (LEGACY_CLOUD_MODEL_ALIASES.has(key)) return fallback;
  return raw;
}

module.exports = {
  DEFAULT_CLOUD_CLAUDE_CODE_MODEL,
  normalizeCloudClaudeCodeModel
};
