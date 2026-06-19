const crypto = require("node:crypto");
const { MCP_ENGINE_IDS, MCP_TRANSPORTS, SENSITIVE_KEY_PATTERN } = require("../../shared/mcp-contracts.js");

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
  const type = String(input.type || (input.url ? "http" : "stdio"))
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (!MCP_TRANSPORTS.includes(type)) return null;
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

function normalizeMcpRecord(input = {}, options = {}) {
  const now = typeof options.now === "function" ? options.now() : nowMs();
  const name = String(input.name || "").trim();
  const transport = normalizeTransport(input.transport || input);
  if (!name || !transport) return null;
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : stableId;
  const rawSync = { ...defaultSync(), ...(input.sync && typeof input.sync === "object" ? input.sync : {}) };
  const sync = Object.fromEntries(
    Object.entries(rawSync).map(([engineId, value]) => {
      const entry = value && typeof value === "object" ? value : {};
      return [engineId, {
        status: String(entry.status || "pending"),
        message: sanitizeSecretText(entry.message || entry.error || "")
      }];
    })
  );

  return {
    id: String(input.id || idFactory(name)).trim(),
    name,
    description: String(input.description || "").trim(),
    enabled: input.enabled !== false,
    status: String(input.status || "unknown").trim() || "unknown",
    tools: Array.isArray(input.tools)
      ? input.tools
          .map((tool) => ({
            name: String(tool?.name || "").trim(),
            description: String(tool?.description || "").trim(),
            inputSchema: tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {}
          }))
          .filter((tool) => tool.name)
      : [],
    transport,
    sync,
    createdAt: Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : now,
    updatedAt: Number.isFinite(Number(input.updatedAt)) ? Number(input.updatedAt) : now,
    lastCheckedAt: Number.isFinite(Number(input.lastCheckedAt)) ? Number(input.lastCheckedAt) : 0,
    lastError: sanitizeSecretText(input.lastError || ""),
    registryId: String(input.registryId || "").trim(),
    source: String(input.source || "custom").trim() || "custom",
    originalJson: String(input.originalJson || "")
  };
}

function normalizeMcpRegistry(value = [], options = {}) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  const records = [];
  for (const item of rows) {
    const record = normalizeMcpRecord(item, options);
    if (!record || seen.has(record.name)) continue;
    seen.add(record.name);
    records.push(record);
  }
  return records;
}

function parseMcpImportJson(input) {
  const source = typeof input === "string" ? JSON.parse(input) : input;
  const servers = source?.mcpServers || source?.mcp_servers || source?.servers || {};
  return Object.entries(servers).map(([name, spec]) => ({
    name,
    description: String(spec?.description || ""),
    enabled: spec?.enabled !== false,
    transport: {
      type: spec?.type || spec?.transport || (spec?.url ? "http" : "stdio"),
      command: spec?.command,
      args: spec?.args,
      env: spec?.env,
      url: spec?.url,
      headers: spec?.headers,
      bearerTokenEnvVar: spec?.bearer_token_env_var || spec?.bearerTokenEnvVar
    }
  }));
}

function maskValue(key, value) {
  return SENSITIVE_KEY_PATTERN.test(String(key || "")) && String(value || "") ? "••••••••" : value;
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

function maskOriginalJson(originalJson) {
  const source = String(originalJson || "");
  if (!source) return source;
  try {
    return JSON.stringify(maskSensitiveJsonValue("", JSON.parse(source)));
  } catch {
    return sanitizeSecretText(source);
  }
}

function maskMcpRecord(record = {}) {
  const copy = JSON.parse(JSON.stringify(record || {}));
  if (copy.transport?.env) {
    for (const key of Object.keys(copy.transport.env)) copy.transport.env[key] = maskValue(key, copy.transport.env[key]);
  }
  if (copy.transport?.headers) {
    for (const key of Object.keys(copy.transport.headers)) copy.transport.headers[key] = maskValue(key, copy.transport.headers[key]);
  }
  if (typeof copy.originalJson === "string") {
    copy.originalJson = maskOriginalJson(copy.originalJson);
  }
  if (typeof copy.lastError === "string") {
    copy.lastError = sanitizeSecretText(copy.lastError);
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

function enabledMcpRecords(records = []) {
  return normalizeMcpRegistry(records).filter((record) => record.enabled);
}

function fingerprintPayload(records = []) {
  return enabledMcpRecords(records)
    .map((record) => ({
      name: record.name,
      transport: record.transport
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mcpFingerprint(records = []) {
  return crypto.createHash("sha256").update(JSON.stringify(fingerprintPayload(records))).digest("hex");
}

module.exports = {
  enabledMcpRecords,
  maskMcpRecord,
  mcpFingerprint,
  normalizeMcpRecord,
  normalizeMcpRegistry,
  normalizeTransport,
  parseMcpImportJson,
  sanitizeSecretText
};
