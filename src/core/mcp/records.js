"use strict";

const crypto = require("node:crypto");
const { MCP_ENGINE_IDS, MCP_TRANSPORTS, SENSITIVE_KEY_PATTERN } = require("../../shared/mcp-contracts.js");

const MASK = "••••••••";
const RESERVED_BUILTIN_NAMES = new Set(["mia-app", "mia-scheduler"]);
const MCP_MANAGEMENT_MODES = new Set(["native", "managed", "custom"]);

function nowMs() {
  return Date.now();
}

function stableId(name = "") {
  const slug = String(name || "server")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `mcp_${slug || crypto.randomUUID()}`;
}

const SAFE_NATIVE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const GENERIC_NATIVE_NAME_SLUGS = new Set(["mcp", "server", "mcp-server", "mcp_server"]);
const INVALID_NATIVE_NAME_ERROR_PATTERN = /invalid (?:server )?name|names can only contain letters, numbers, hyphens, and underscores/i;

function slugNativeName(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hashNativeName(seed = "") {
  return `mcp_${crypto.createHash("sha256").update(String(seed || "mcp")).digest("hex").slice(0, 12)}`;
}

function normalizeNativeName(input = "", fallback = "") {
  const raw = String(input || "").trim();
  if (SAFE_NATIVE_NAME_PATTERN.test(raw)) return raw;
  const slug = slugNativeName(raw);
  if (slug && !GENERIC_NATIVE_NAME_SLUGS.has(slug)) return slug;
  const fallbackSlug = slugNativeName(fallback);
  if (fallbackSlug && !GENERIC_NATIVE_NAME_SLUGS.has(fallbackSlug)) return fallbackSlug;
  return hashNativeName(`${raw}:${fallback}`);
}

function isLegacyInvalidNativeNameError(entry = {}) {
  return String(entry.status || "") === "error"
    && INVALID_NATIVE_NAME_ERROR_PATTERN.test(String(entry.message || entry.error || ""));
}

function migrateLegacyNativeNameErrors(sync = {}, nativeName = "", displayName = "") {
  if (!nativeName || nativeName === displayName) return sync;
  const next = { ...sync };
  for (const engine of ["codex", "claude-code"]) {
    if (isLegacyInvalidNativeNameError(next[engine])) {
      next[engine] = {
        status: "available",
        message: `Ready to sync as ${nativeName}.`
      };
    }
  }
  return next;
}

function cleanObject(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    const cleanKey = String(key || "").trim();
    if (!cleanKey) continue;
    if (value == null) continue;
    out[cleanKey] = String(value);
  }
  return out;
}

function sanitizeSecretText(message) {
  let text = String(message || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "[redacted]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API(?:_|-)?KEY|AUTHORIZATION|COOKIE|SESSION)[A-Z0-9_]*)(=)(?:"[^"]+"|'[^']+'|[^\s,;]+)/gi, "$1$2[redacted]")
    .replace(/\b((?:api[_-]?key|auth(?:orization)?|auth[_-]?token|authorization|bearer|token|password|secret|cookie|session)\s*[:=]\s*)(?:"[^"]+"|'[^']+'|[^\s,;]+)/gi, "$1[redacted]");
  return text;
}

function defaultSync() {
  return MCP_ENGINE_IDS.reduce((sync, engine) => {
    sync[engine] = { status: "pending", message: "" };
    return sync;
  }, {});
}

function normalizeTransport(input = {}) {
  const rawType = String(input.type || (input.url ? "http" : "stdio"))
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  const type = rawType === "streamable_http" ? "http" : rawType;
  if (!MCP_TRANSPORTS.includes(rawType) && type !== "http") return null;
  if (type === "stdio") {
    const command = String(input.command || "").trim();
    if (!command) return null;
    return {
      type,
      command,
      args: Array.isArray(input.args) ? input.args.map((arg) => String(arg)) : [],
      env: cleanObject(input.env)
    };
  }
  const url = String(input.url || "").trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
  } catch {
    return null;
  }
  const transport = {
    type,
    url,
    headers: cleanObject(input.headers)
  };
  const bearerTokenEnvVar = String(input.bearerTokenEnvVar || input.bearer_token_env_var || "").trim();
  if (bearerTokenEnvVar) transport.bearerTokenEnvVar = bearerTokenEnvVar;
  return transport;
}

function normalizeManagementMode(value, source = "") {
  const mode = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  if (MCP_MANAGEMENT_MODES.has(mode)) return mode;
  return source === "marketplace" ? "native" : "custom";
}

function normalizeRequiredInputs(input) {
  return Array.isArray(input)
    ? input.map((field) => ({
        key: String(field?.key || "").trim(),
        label: String(field?.label || field?.key || "").trim(),
        secret: field?.secret === true,
        target: String(field?.target || "env").trim() || "env",
        required: field?.required !== false
      })).filter((field) => field.key)
    : [];
}

function normalizeConnectionWizard(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    state: String(source.state || "idle").trim() || "idle",
    nextAction: String(source.nextAction || "").trim(),
    message: sanitizeSecretText(source.message || ""),
    missingRequiredInputs: Array.isArray(source.missingRequiredInputs)
      ? source.missingRequiredInputs.map((key) => String(key || "").trim()).filter(Boolean)
      : [],
    actions: Array.isArray(source.actions)
      ? source.actions.map((action) => ({
          id: String(action?.id || "").trim(),
          label: String(action?.label || action?.id || "").trim()
        })).filter((action) => action.id)
      : []
  };
}

function normalizeManagedRuntime(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    connectorId: String(source.connectorId || "").trim(),
    endpoint: String(source.endpoint || "").trim(),
    installDir: String(source.installDir || "").trim(),
    expectedToolCount: Number.isFinite(Number(source.expectedToolCount)) ? Number(source.expectedToolCount) : 0,
    state: String(source.state || "").trim(),
    lastAction: String(source.lastAction || "").trim()
  };
}

function normalizeTools(tools) {
  return Array.isArray(tools)
    ? tools
        .map((tool) => ({
          name: String(tool?.name || "").trim(),
          description: String(tool?.description || "").trim(),
          inputSchema: tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {}
        }))
        .filter((tool) => tool.name)
    : [];
}

function normalizeDiagnostics(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    ...source,
    message: sanitizeSecretText(source.message || source.error || "")
  };
}

function normalizeNullableNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeNullableDiagnosticCode(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : sanitizeSecretText(text);
}

function normalizeTimestamp(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeCounter(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeOAuth(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    authenticated: source.authenticated === true,
    provider: String(source.provider || "").trim(),
    tokenRef: String(source.tokenRef || "").trim()
  };
}

function normalizeCoreMcpRecord(input = {}, options = {}) {
  const now = typeof options.now === "function" ? options.now() : nowMs();
  const name = String(input.name || "").trim();
  if (!name) return null;
  if (input.builtin !== true && RESERVED_BUILTIN_NAMES.has(name.toLowerCase())) return null;
  const transport = normalizeTransport(input.transport || input);
  if (!transport) return null;
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : stableId;
  const id = String(input.id || idFactory(name)).trim();
  const nativeName = normalizeNativeName(input.nativeName || input.native_name || input.registryId || name, id || name);
  const rawSync = { ...defaultSync(), ...(input.sync && typeof input.sync === "object" ? input.sync : {}) };
  const normalizedSync = Object.fromEntries(
    Object.entries(rawSync).map(([engineId, value]) => {
      const entry = value && typeof value === "object" ? value : {};
      return [engineId, {
        status: String(entry.status || "pending"),
        message: sanitizeSecretText(entry.message || entry.error || "")
      }];
    })
  );
  const sync = migrateLegacyNativeNameErrors(normalizedSync, nativeName, name);

  return {
    id,
    name,
    nativeName,
    displayName: String(input.displayName || "").trim(),
    description: String(input.description || "").trim(),
    enabled: input.enabled !== false,
    builtin: input.builtin === true,
    status: String(input.status || "unknown").trim() || "unknown",
    lastTestStatus: String(input.lastTestStatus || input.status || "unknown").trim() || "unknown",
    lastTestCode: normalizeNullableDiagnosticCode(input.lastTestCode),
    tools: normalizeTools(input.tools),
    transport,
    sync,
    diagnostics: normalizeDiagnostics(input.diagnostics),
    oauth: normalizeOAuth(input.oauth),
    sourceAgent: String(input.sourceAgent || "").trim(),
    createdAt: normalizeTimestamp(input.createdAt, now),
    updatedAt: normalizeTimestamp(input.updatedAt, now),
    deletedAt: normalizeNullableNumber(input.deletedAt),
    lastCheckedAt: normalizeCounter(input.lastCheckedAt, 0),
    lastError: sanitizeSecretText(input.lastError || ""),
    registryId: String(input.registryId || "").trim(),
    source: String(input.source || "custom").trim() || "custom",
    managementMode: normalizeManagementMode(input.managementMode, input.source),
    requiredInputs: normalizeRequiredInputs(input.requiredInputs),
    connectionWizard: normalizeConnectionWizard(input.connectionWizard),
    managedRuntime: normalizeManagedRuntime(input.managedRuntime),
    homepage: String(input.homepage || "").trim(),
    setupHint: sanitizeSecretText(input.setupHint || ""),
    setupCommands: Array.isArray(input.setupCommands)
      ? input.setupCommands.map((command) => sanitizeSecretText(command)).filter(Boolean)
      : [],
    expectedToolCount: Number.isFinite(Number(input.expectedToolCount)) ? Number(input.expectedToolCount) : 0,
    originalJson: String(input.originalJson || "")
  };
}

function normalizeCoreMcpRegistry(value = [], options = {}) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  const records = [];
  for (const item of rows) {
    const record = normalizeCoreMcpRecord(item, options);
    if (!record || seen.has(record.name)) continue;
    seen.add(record.name);
    records.push(record);
  }
  return records;
}

function parseCoreMcpImportJson(input) {
  const source = typeof input === "string" ? JSON.parse(input) : input;
  const servers = source?.mcpServers || source?.mcp_servers || source?.servers || {};
  return Object.entries(servers).map(([name, spec]) => {
    const transport = normalizeTransport({
      type: spec?.type || spec?.transport || (spec?.url ? "http" : "stdio"),
      command: spec?.command,
      args: spec?.args,
      env: spec?.env,
      url: spec?.url,
      headers: spec?.headers,
      bearerTokenEnvVar: spec?.bearer_token_env_var || spec?.bearerTokenEnvVar
    });
    if (!transport) return null;
    return {
      name: String(spec?.name || spec?.displayName || name || ""),
      nativeName: spec?.nativeName || spec?.native_name || name,
      description: String(spec?.description || ""),
      enabled: spec?.enabled !== false,
      transport
    };
  }).filter(Boolean);
}

function maskValue(key, value) {
  return SENSITIVE_KEY_PATTERN.test(String(key || "")) && String(value || "") ? MASK : value;
}

function maskSensitiveJsonValue(key, value) {
  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveJsonValue("", item));
  }
  if (!value || typeof value !== "object") {
    return maskValue(key, value);
  }
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = maskSensitiveJsonValue(childKey, childValue);
  }
  return out;
}

function redactPublicValue(key, value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactPublicValue("", item));
  }
  if (typeof value === "string") {
    return SENSITIVE_KEY_PATTERN.test(String(key || "")) && value ? MASK : sanitizeSecretText(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = redactPublicValue(childKey, childValue);
  }
  return out;
}

function maskOriginalJson(originalJson) {
  const source = String(originalJson || "");
  if (!source) return source;
  try {
    return JSON.stringify(maskSensitiveJsonValue("", JSON.parse(source)));
  } catch {
    return sanitizeSecretText(source);
  }
}

function publicCoreMcpRecord(record = {}) {
  const copy = JSON.parse(JSON.stringify(record || {}));
  if (copy.transport?.env) {
    for (const key of Object.keys(copy.transport.env)) copy.transport.env[key] = maskValue(key, copy.transport.env[key]);
  }
  if (copy.transport?.headers) {
    for (const key of Object.keys(copy.transport.headers)) copy.transport.headers[key] = maskValue(key, copy.transport.headers[key]);
  }
  if (copy.oauth && typeof copy.oauth === "object") {
    copy.oauth.tokenRef = "";
  }
  if (typeof copy.originalJson === "string") {
    copy.originalJson = maskOriginalJson(copy.originalJson);
  }
  if (typeof copy.lastError === "string") {
    copy.lastError = sanitizeSecretText(copy.lastError);
  }
  if (copy.diagnostics && typeof copy.diagnostics === "object") {
    copy.diagnostics = redactPublicValue("", copy.diagnostics);
  }
  if (Array.isArray(copy.requiredInputs)) {
    copy.requiredInputs = copy.requiredInputs.map((field) => ({
      ...field,
      value: undefined
    }));
  }
  if (copy.managedRuntime && typeof copy.managedRuntime === "object") {
    copy.managedRuntime = {
      ...copy.managedRuntime,
      installDir: copy.managedRuntime.installDir ? "[managed]" : ""
    };
  }
  if (copy.connectionWizard && typeof copy.connectionWizard === "object") {
    copy.connectionWizard.message = sanitizeSecretText(copy.connectionWizard.message || "");
  }
  if (copy.sync && typeof copy.sync === "object") {
    for (const value of Object.values(copy.sync)) {
      if (value && typeof value === "object" && typeof value.message === "string") {
        value.message = sanitizeSecretText(value.message);
      }
    }
  }
  return copy;
}

function publicCoreMcpRecords(records = [], options = {}) {
  return normalizeCoreMcpRegistry(records)
    .filter((record) => options.includeDeleted === true || !record.deletedAt)
    .map((record) => publicCoreMcpRecord(record));
}

function enabledCoreMcpRecords(records = []) {
  return normalizeCoreMcpRegistry(records).filter((record) => record.enabled && !record.deletedAt);
}

function fingerprintPayload(records = []) {
  return enabledCoreMcpRecords(records)
    .map((record) => ({
      name: record.name,
      nativeName: record.nativeName,
      transport: record.transport
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function coreMcpFingerprint(records = []) {
  return crypto.createHash("sha256").update(JSON.stringify(fingerprintPayload(records))).digest("hex");
}

module.exports = {
  MASK,
  cleanObject,
  coreMcpFingerprint,
  enabledCoreMcpRecords,
  normalizeNativeName,
  normalizeCoreMcpRecord,
  normalizeCoreMcpRegistry,
  normalizeTransport,
  parseCoreMcpImportJson,
  publicCoreMcpRecord,
  publicCoreMcpRecords,
  sanitizeSecretText
};
