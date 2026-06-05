#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocketServer, WebSocket } = require("ws");
let createCloudStore = null;
try {
  ({ createCloudStore } = require("../src/cloud/sqlite-store.js"));
} catch {
  ({ createCloudStore } = require("./src/cloud/sqlite-store.js"));
}
let createSocialStore = null;
try {
  ({ createSocialStore } = require("../src/cloud/social-store.js"));
} catch {
  ({ createSocialStore } = require("./src/cloud/social-store.js"));
}
let createMessagesStore = null;
try {
  ({ createMessagesStore } = require("../src/cloud/messages-store.js"));
} catch {
  ({ createMessagesStore } = require("./src/cloud/messages-store.js"));
}
let createEventLogStore = null;
try {
  ({ createEventLogStore } = require("../src/cloud/event-log-store.js"));
} catch {
  ({ createEventLogStore } = require("./src/cloud/event-log-store.js"));
}
let createBotsStore = null;
try {
  ({ createBotsStore } = require("../src/cloud/bots-store.js"));
} catch {
  ({ createBotsStore } = require("./src/cloud/bots-store.js"));
}
let botConversationId = null;
try {
  ({ botConversationId } = require("../src/shared/bot-identity.js"));
} catch {
  ({ botConversationId } = require("./src/shared/bot-identity.js"));
}
let createSkillsStore = null;
try {
  ({ createSkillsStore } = require("../src/cloud/skills-store.js"));
} catch {
  ({ createSkillsStore } = require("./src/cloud/skills-store.js"));
}
let loadSkillsCatalog = () => [];
try {
  ({ loadSkillsCatalog } = require("../src/cloud/skills-catalog.js"));
} catch {
  ({ loadSkillsCatalog } = require("./src/cloud/skills-catalog.js"));
}
let createHermesSkillsSource = null;
try {
  ({ createHermesSkillsSource } = require("../src/cloud/hermes-skills-source.js"));
} catch {
  ({ createHermesSkillsSource } = require("./src/cloud/hermes-skills-source.js"));
}
const DEFAULT_SKILL_MARKET_LIMIT = 120;
const MAX_SKILL_MARKET_LIMIT = 10000;
let skillSafety = null;
try {
  skillSafety = require("../src/shared/skill-safety.js");
} catch {
  skillSafety = require("./src/shared/skill-safety.js");
}
let createUserSettingsStore = null;
try {
  ({ createUserSettingsStore } = require("../src/cloud/user-settings-store.js"));
} catch {
  ({ createUserSettingsStore } = require("./src/cloud/user-settings-store.js"));
}
let createRuntimeBindingsStore = null;
try {
  ({ createRuntimeBindingsStore } = require("../src/cloud-agent/runtime-bindings-store.js"));
} catch {
  ({ createRuntimeBindingsStore } = require("./src/cloud-agent/runtime-bindings-store.js"));
}
let createCloudAgentRunsStore = null;
try {
  ({ createCloudAgentRunsStore } = require("../src/cloud-agent/cloud-agent-runs-store.js"));
} catch {
  ({ createCloudAgentRunsStore } = require("./src/cloud-agent/cloud-agent-runs-store.js"));
}
let createCloudAgentDispatcher = null;
try {
  ({ createCloudAgentDispatcher } = require("../src/cloud-agent/dispatcher.js"));
} catch {
  ({ createCloudAgentDispatcher } = require("./src/cloud-agent/dispatcher.js"));
}
let createAttachmentMaterializer = null;
try {
  ({ createAttachmentMaterializer } = require("../src/cloud-agent/attachment-materializer.js"));
} catch {
  ({ createAttachmentMaterializer } = require("./src/cloud-agent/attachment-materializer.js"));
}
let dmConversationId = null;
let ensureDmConversation = null;
try {
  ({ dmConversationId, ensureDmConversation } = require("../src/cloud/dm-conversation.js"));
} catch {
  ({ dmConversationId, ensureDmConversation } = require("./src/cloud/dm-conversation.js"));
}
let avatarResolve = null;
try {
  avatarResolve = require("../src/shared/avatar-resolve.js");
} catch {
  avatarResolve = require("./src/shared/avatar-resolve.js");
}
const host = process.env.MIA_CLOUD_HOST || "127.0.0.1";
const port = Number(process.env.MIA_CLOUD_PORT || process.env.PORT || 4175);
const defaultDataDir = process.env.MIA_CLOUD_DATA || path.join(process.cwd(), ".mia-cloud");
const maxUploadBytes = 18 * 1024 * 1024;
const maxBodyBytes = Math.ceil(maxUploadBytes * 4 / 3) + 1024 * 1024;
const bridgeRunTimeoutMs = Number(process.env.MIA_BRIDGE_RUN_TIMEOUT_MS || 1000 * 60 * 5);
const litellmAdminBaseUrl = String(process.env.MIA_LITELLM_ADMIN_BASE_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");
const cloudFeatures = [
  "sqlite-store",
  "auth-sessions",
  "authenticated-files",
  "events-websocket",
  "bridge-websocket-subprotocol-token",
  "bridge-run-lifecycle",
  "bridge-run-cancel",
  "bridge-run-progress",
  "desktop-sync",
  "cloud-hermes-agent",
  "cloud-agent-user-isolation"
];
const defaultAllowedOrigins = String(process.env.MIA_CLOUD_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function defaultReleaseManifest() {
  const candidates = [
    process.env.MIA_CLOUD_RELEASE_MANIFEST || "",
    path.join(__dirname, "release-manifest.json"),
    path.join(__dirname, "..", "manifest.json")
  ].filter(Boolean);
  for (const candidate of candidates) {
    const manifest = readJsonFile(candidate);
    if (manifest && manifest.product === "Mia Cloud") return manifest;
  }
  return null;
}

function releaseHealthPayload(manifest) {
  if (!manifest) return null;
  return {
    version: String(manifest.version || ""),
    builtAt: String(manifest.builtAt || ""),
    gitCommit: String(manifest.source?.gitCommit || ""),
    gitDirty: Boolean(manifest.source?.gitDirty),
    fileCount: manifest.files && typeof manifest.files === "object" ? Object.keys(manifest.files).length : 0
  };
}

function createStore(dataDir = defaultDataDir) {
  return {
    dataDir,
    dbPath: path.join(dataDir, "cloud.sqlite"),
    uploadDir: path.join(dataDir, "uploads")
  };
}

function now() {
  return new Date().toISOString();
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function id(prefix) {
  return `${prefix}_${base64url(crypto.randomBytes(12))}`;
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload ?? {}, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function writeError(res, status, message) {
  writeJson(res, status, { error: String(message || "Request failed.") });
}

function writeText(res, status, body, contentType = "text/plain; charset=utf-8") {
  const text = String(body || "");
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
        body = "";
        return;
      }
      if (!tooLarge) body += String(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        const error = new Error("Request body is too large.");
        error.code = "MIA_BODY_TOO_LARGE";
        reject(error);
        return;
      }
      resolve(body);
    });
    req.on("error", reject);
  });
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Invalid JSON.");
    error.code = "MIA_INVALID_JSON";
    throw error;
  }
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function conversationMemberOwnerPublic(user) {
  if (!user) return null;
  const { avatarImage, avatarCrop, avatarColor, ...identity } = user;
  return identity;
}

function userDisplayNameForIdentity(user, fallback = "") {
  return String(user?.displayName || user?.username || user?.email || fallback || "用户").trim() || "用户";
}

function botDisplayNameForIdentity(bot, fallback = "") {
  return String(bot?.displayName || bot?.name || fallback || "Bot").trim() || "Bot";
}

function memberIdentityForUser(user, fallbackRef = "") {
  const id = String(user?.id || fallbackRef || "");
  const displayName = userDisplayNameForIdentity(user, fallbackRef);
  return {
    kind: "user",
    id,
    ownerId: "",
    displayName,
    avatar: avatarResolve.resolveAvatarForContact({
      id,
      displayName,
      avatarImage: user?.avatarImage || "",
      avatarCrop: user?.avatarCrop || null
    })
  };
}

function memberIdentityForBot(bot, fallbackRef = "", ownerId = "") {
  const id = String(bot?.id || fallbackRef || "");
  const owner = String(ownerId || bot?.ownerUserId || bot?.ownerId || "");
  const displayName = botDisplayNameForIdentity(bot, fallbackRef);
  return {
    kind: "bot",
    id,
    ownerUserId: owner,
    displayName,
    avatar: avatarResolve.resolveAvatarForContact({
      id: owner ? `${owner}:${id}` : id,
      displayName,
      avatarImage: bot?.avatarImage || "",
      avatarCrop: bot?.avatarCrop || null
    }),
    statusBadge: bot?.statusBadge || null
  };
}

function compactPublicUser(user) {
  if (!user) return null;
  const { avatarImage, avatarCrop, avatarColor, ...identity } = user;
  return identity;
}

function compactAuthAccount(account) {
  if (!account || typeof account !== "object") return account;
  return { ...account, user: compactPublicUser(account.user) };
}

function compactBotIdentity(bot) {
  if (!bot) return null;
  const { avatarImage, avatarCrop, avatar, personaText, ...identity } = bot;
  return identity;
}

function wantsCompactPayload(url) {
  return /^(1|true|yes)$/i.test(String(url?.searchParams?.get("compact") || ""));
}

function normalizeMemberRuntimeKind(value) {
  const runtimeKind = String(value || "").trim();
  return runtimeKind === "cloud-hermes" || runtimeKind === "desktop-local" ? runtimeKind : "";
}

function normalizeOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function mergeCategoryCounts(...groups) {
  const counts = new Map();
  for (const group of groups) {
    for (const entry of Array.isArray(group) ? group : []) {
      const category = String(entry?.category || "").trim();
      if (!category) continue;
      counts.set(category, (counts.get(category) || 0) + (Number(entry.count) || 0));
    }
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

function allowedOriginsFromOptions(options = {}) {
  const values = Array.isArray(options.allowedOrigins)
    ? options.allowedOrigins
    : defaultAllowedOrigins;
  return values.map(normalizeOrigin).filter(Boolean);
}

function applySecurityHeaders(req, res, context = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  const requestOrigin = normalizeOrigin(req.headers.origin || "");
  if (!requestOrigin) return;
  res.setHeader("Vary", "Origin");
  if (requestOriginAllowed(req, context)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "false");
  }
}

function isLoopbackHost(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(String(hostname || "").toLowerCase());
}

function requestHostName(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return host.split(":")[0].toLowerCase();
  }
}

function requestOriginAllowed(req, context = {}) {
  const requestOrigin = normalizeOrigin(req.headers.origin || "");
  if (!requestOrigin) return true;
  const allowed = context.allowedOrigins || [];
  if (allowed.length) return allowed.includes(requestOrigin);
  try {
    const originHost = new URL(requestOrigin).hostname.toLowerCase();
    const requestHost = requestHostName(req);
    return originHost === requestHost || isLoopbackHost(originHost);
  } catch {
    return false;
  }
}

function fileContentType(filePath, fallback = "application/octet-stream") {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".webmanifest") return "application/manifest+json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return fallback;
}

function defaultWebRoot() {
  const candidates = [
    process.env.MIA_WEB_ROOT,
    path.join(__dirname, "..", "web"),
    path.join(__dirname, "..", "src", "web")
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) || "";
}

function serveWebAsset(req, res, webRoot, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (!webRoot || pathname.startsWith("/api/")) return false;
  let relative = "";
  try {
    relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.replace(/^\/+/, ""));
  } catch {
    writeError(res, 400, "Bad request.");
    return true;
  }
  if (relative === "favicon.ico") relative = "favicon.svg";
  if (!relative || relative.endsWith("/")) relative = path.join(relative, "index.html");
  const root = path.resolve(webRoot);
  const sourceRoot = path.resolve(__dirname, "..", "src");
  const packageRoot = path.resolve(__dirname, "..", "packages");
  const candidates = [{ resolved: path.resolve(webRoot, relative), allowedRoot: root }];
  if (
    relative === "shared/avatar-resolve.js"
      || relative === "shared/avatar-media.js"
      || relative === "shared/member-color.js"
      || relative === "shared/session-history.js"
      || relative === "shared/contact.js"
      || relative === "shared/group-tiles.js"
      || relative === "shared/send-pipeline.js"
      || relative === "shared/cloud-client.js"
      || relative === "shared/unread.js"
  ) {
    const packageRelative = relative === "shared/avatar-resolve.js" || relative === "shared/avatar-media.js" || relative === "shared/member-color.js"
      ? "shared/avatar.js"
      : relative;
    candidates.push({ resolved: path.resolve(packageRoot, packageRelative), allowedRoot: packageRoot });
  } else if (relative.startsWith("shared/")) {
    candidates.push({ resolved: path.resolve(sourceRoot, relative), allowedRoot: sourceRoot });
  } else if (relative.startsWith("message-sources/")) {
    candidates.push({ resolved: path.resolve(sourceRoot, "renderer", relative), allowedRoot: sourceRoot });
  }
  let resolved = "";
  for (const { resolved: candidate, allowedRoot } of candidates) {
    if (candidate !== allowedRoot && !candidate.startsWith(`${allowedRoot}${path.sep}`)) continue;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      resolved = candidate;
      break;
    }
  }
  if (!resolved) return false;
  const body = fs.readFileSync(resolved);
  res.writeHead(200, {
    "Content-Type": fileContentType(resolved),
    "Content-Length": body.length,
    "Cache-Control": path.basename(resolved) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable"
  });
  if (req.method === "HEAD") res.end();
  else res.end(body);
  return true;
}

function adminCredentials(context = {}) {
  return {
    username: String(context.adminUsername || process.env.MIA_CLOUD_ADMIN_USERNAME || "").trim(),
    password: String(context.adminPassword || process.env.MIA_CLOUD_ADMIN_PASSWORD || "").trim()
  };
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseBasicAuth(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const index = decoded.indexOf(":");
    if (index < 0) return null;
    return { username: decoded.slice(0, index), password: decoded.slice(index + 1) };
  } catch {
    return null;
  }
}

function requireAdmin(req, res, context) {
  const expected = adminCredentials(context);
  if (!expected.username || !expected.password) {
    writeError(res, 503, "管理后台还没有配置管理员账号。");
    return false;
  }
  const provided = parseBasicAuth(req);
  if (
    provided &&
    safeEqualString(provided.username, expected.username) &&
    safeEqualString(provided.password, expected.password)
  ) {
    return true;
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Mia Admin", charset="UTF-8"');
  writeError(res, 401, "需要管理员账号。");
  return false;
}

function serveAdminModelPage(req, res, context) {
  if (!requireAdmin(req, res, context)) return true;
  const filePath = path.join(context.webRoot || defaultWebRoot(), "admin-model.html");
  if (!fs.existsSync(filePath)) {
    writeError(res, 404, "Admin page not found.");
    return true;
  }
  writeText(res, 200, fs.readFileSync(filePath, "utf8"), "text/html; charset=utf-8");
  return true;
}

function litellmAdminKey(context = {}) {
  return String(context.litellmAdminKey || process.env.LITELLM_MASTER_KEY || process.env.MIA_LITELLM_MASTER_KEY || "").trim();
}

function litellmServiceKey(context = {}) {
  return String(
    context.litellmServiceKey ||
    process.env.MIA_CLOUD_AGENT_MODEL_API_KEY ||
    process.env.MIA_LITELLM_API_KEY ||
    ""
  ).trim();
}

function redactModelInfo(row = {}) {
  const params = { ...(row.litellm_params || {}) };
  if (params.api_key) params.api_key = "configured";
  return {
    model_name: row.model_name || "",
    model_info: row.model_info || {},
    litellm_params: params
  };
}

function publicPlatformModel(row = {}) {
  const id = String(row.model_name || row.model_info?.id || "").trim();
  if (!id) return null;
  const info = row.model_info || {};
  const params = row.litellm_params || {};
  return {
    id,
    label: String(info.label || info.display_name || info.name || id).trim(),
    provider: String(info.provider || "").trim(),
    upstreamModel: String(info.base_model || params.model || "").trim()
  };
}

function fallbackPlatformModels() {
  return [{ id: "mia-default", label: "Mia Default", provider: "mia-litellm", upstreamModel: "" }];
}

async function litellmRequest(context, pathname, { method = "GET", key = "", body = null } = {}) {
  const token = key || litellmAdminKey(context);
  if (!token) {
    const error = new Error("LiteLLM 管理 key 未配置。");
    error.status = 503;
    throw error;
  }
  const response = await fetch(`${litellmAdminBaseUrl}${pathname}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.detail || data?.message || `LiteLLM request failed (${response.status}).`);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

function normalizeAdminModelInput(input = {}) {
  const upstreamModel = String(input.upstreamModel || input.model || "").trim();
  const apiKey = String(input.apiKey || "").trim();
  const apiBase = String(input.apiBase || "").trim();
  const apiVersion = String(input.apiVersion || "").trim();
  const modelName = String(input.modelName || "mia-default").trim() || "mia-default";
  if (!upstreamModel) throw new Error("请填写真实模型。");
  if (!apiKey) throw new Error("请填写供应商 API Key。");
  if (!/^[A-Za-z0-9_.-]{2,80}$/.test(modelName)) {
    throw new Error("Mia 模型名只能包含字母、数字、点、下划线和横线。");
  }
  if (!/^[a-z0-9_.-]+\/[A-Za-z0-9_.:/@-]+$/i.test(upstreamModel)) {
    throw new Error("真实模型格式不对，例如 deepseek/deepseek-chat。");
  }
  if (apiBase) {
    try {
      const url = new URL(apiBase);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
    } catch {
      throw new Error("API Base URL 格式不对。");
    }
  }
  return {
    provider: String(input.provider || "").trim(),
    modelName,
    upstreamModel,
    apiKey,
    apiBase,
    apiVersion
  };
}

function sanitizeRuntimeModelEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, 80)
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const value = String(entry.value || entry.id || entry.model || "").trim().slice(0, 160);
      const model = String(entry.model || value || "").trim().slice(0, 160);
      const label = String(entry.label || entry.name || model || value || "").trim().slice(0, 160);
      if (!value && !model) return null;
      return {
        value: value || model,
        label: label || value || model,
        model,
        provider: String(entry.provider || "").trim().slice(0, 80),
        providerLabel: String(entry.providerLabel || entry.provider_label || "").trim().slice(0, 120)
      };
    })
    .filter(Boolean);
}

function sanitizeRuntimeConfig(inputConfig = {}) {
  const input = inputConfig && typeof inputConfig === "object" ? inputConfig : {};
  const config = {
    model: String(input.model || "").trim().slice(0, 160),
    effortLevel: String(input.effortLevel || "medium").trim().slice(0, 40),
    permissionMode: String(input.permissionMode || "ask").trim().slice(0, 80)
  };
  const agentEngine = String(input.agentEngine || input.agent_engine || "").trim().slice(0, 80);
  if (agentEngine) config.agentEngine = agentEngine;
  const modelEntries = sanitizeRuntimeModelEntries(input.modelEntries || input.model_entries);
  if (modelEntries.length) config.modelEntries = modelEntries;
  return config;
}

async function listLiteLLMModels(context) {
  const info = await litellmRequest(context, "/model/info");
  const rows = Array.isArray(info?.data) ? info.data : [];
  return rows;
}

async function listMiaLiteLLMModels(context) {
  return (await listLiteLLMModels(context)).filter((row) => row?.model_name === "mia-default");
}

async function listPlatformModelCatalog(context) {
  try {
    const info = await litellmRequest(context, "/model/info", { key: litellmAdminKey(context) || litellmServiceKey(context) });
    const rows = Array.isArray(info?.data) ? info.data : [];
    const models = rows.map(publicPlatformModel).filter(Boolean);
    return models.length ? models : fallbackPlatformModels();
  } catch (error) {
    if (error.status === 503) return fallbackPlatformModels();
    throw error;
  }
}

async function handleAdminModelGateway(req, res, context, url) {
  if (!requireAdmin(req, res, context)) return;
  if (req.method === "GET" && url.pathname === "/api/admin/model-gateway") {
    const models = await listLiteLLMModels(context);
    return writeJson(res, 200, {
      ok: true,
      gateway: {
        baseUrl: litellmAdminBaseUrl,
        adminConfigured: Boolean(litellmAdminKey(context)),
        serviceKeyConfigured: Boolean(litellmServiceKey(context))
      },
      modelName: "mia-default",
      models: models.map(redactModelInfo)
    });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/model-gateway") {
    const input = normalizeAdminModelInput(await readJson(req));
    const existing = await listLiteLLMModels(context);
    for (const row of existing.filter((item) => item?.model_name === input.modelName)) {
      const id = String(row?.model_info?.id || row?.model_id || "").trim();
      if (id) {
        await litellmRequest(context, "/model/delete", { method: "POST", body: { id } });
      }
    }
    const litellmParams = {
      model: input.upstreamModel,
      api_key: input.apiKey
    };
    if (input.apiBase) litellmParams.api_base = input.apiBase;
    if (input.apiVersion) litellmParams.api_version = input.apiVersion;
    const created = await litellmRequest(context, "/model/new", {
      method: "POST",
      body: {
        model_name: input.modelName,
        litellm_params: litellmParams,
        model_info: {
          id: input.modelName,
          base_model: input.upstreamModel,
          label: input.modelName,
          provider: input.provider || undefined
        }
      }
    });
    return writeJson(res, 200, {
      ok: true,
      model: redactModelInfo(created),
      message: "模型配置已保存。"
    });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/model-gateway/test") {
    const serviceKey = litellmServiceKey(context) || litellmAdminKey(context);
    const result = await litellmRequest(context, "/v1/chat/completions", {
      method: "POST",
      key: serviceKey,
      body: {
        model: "mia-default",
        messages: [{ role: "user", content: "Reply with exactly: mia-ok" }],
        max_tokens: 20
      }
    });
    return writeJson(res, 200, {
      ok: true,
      reply: result?.choices?.[0]?.message?.content || "",
      model: result?.model || "mia-default"
    });
  }
  writeError(res, 404, "Not found.");
}

function createBridgeHub(runTimeoutMs = bridgeRunTimeoutMs) {
  return {
    devicesByUser: new Map(),
    pendingRuns: new Map(),
    runTimeoutMs
  };
}

function createEventHub() {
  return {
    socketsByUser: new Map()
  };
}

function sendWsJson(ws, payload) {
  const body = JSON.stringify(payload);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(body);
    return;
  }
  setImmediate(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(body);
  });
}

function attachEventSocket(hub, ws, userId, { eventLog, sinceSeq = 0 } = {}) {
  if (!hub.socketsByUser.has(userId)) hub.socketsByUser.set(userId, new Set());
  hub.socketsByUser.get(userId).add(ws);
  ws.on("close", () => {
    const sockets = hub.socketsByUser.get(userId);
    sockets?.delete(ws);
    if (sockets && !sockets.size) hub.socketsByUser.delete(userId);
  });
  ws.on("error", () => {
    const sockets = hub.socketsByUser.get(userId);
    sockets?.delete(ws);
    if (sockets && !sockets.size) hub.socketsByUser.delete(userId);
  });

  // Replay any events the client missed while disconnected. Stream in
  // 500-row batches so a multi-day-offline client doesn't choke a single
  // socket frame. The server's current seq is sent in events_ready so
  // the client can detect "I'm up to date" even with no replay.
  //
  // Defensive clamp: if a client thinks its cursor is AHEAD of the
  // server (which can happen after a server data wipe / DB restore),
  // we tell the client to reset its cursor to serverSeq via `resetTo`
  // so it doesn't sit forever waiting for events that no longer exist.
  let cursorStart = Number.isFinite(Number(sinceSeq)) ? Math.max(0, Number(sinceSeq)) : 0;
  let serverSeq = cursorStart;
  if (eventLog && typeof eventLog.maxSeqForUser === "function") {
    try { serverSeq = eventLog.maxSeqForUser(userId); } catch { /* fall through with cursorStart */ }
  }
  const resetTo = cursorStart > serverSeq ? serverSeq : null;
  if (resetTo !== null) cursorStart = serverSeq;
  sendWsJson(ws, { type: "events_ready", sinceSeq: cursorStart, serverSeq, resetTo });

  if (eventLog && serverSeq > cursorStart) {
    let cursor = cursorStart;
    const BATCH = 500;
    while (cursor < serverSeq) {
      let batch = [];
      try { batch = eventLog.listEventsSince(userId, cursor, BATCH); }
      catch (err) {
        console.error("[event-log] replay failed", { userId, cursor, err: err?.message });
        break;
      }
      if (!batch.length) break;
      for (const ev of batch) {
        sendWsJson(ws, { ...(ev.payload || {}), seq: ev.seq, eventId: ev.id, replay: true });
      }
      cursor = batch[batch.length - 1].seq;
      if (batch.length < BATCH) break;
    }
  }
}

// Push a state-changing event: persist it in the user_events log so that
// disconnected clients can replay it on reconnect via since_seq, AND
// broadcast it to currently-connected sockets with the assigned seq
// attached. ALL caller paths that mutate shared state (social.*, conversation.*,
// workspace_updated, message_created) must go through this — bridges
// only see the seq-tagged version so duplicate detection works.
//
// Returns the persisted event (so callers may use its seq in responses).
function broadcastPersistedEvent(context, userId, payload) {
  if (!userId || !payload || !payload.type) return null;
  let event = null;
  try {
    event = context.eventLog.appendEvent(userId, {
      kind: payload.type,
      scopeKind: payload.scopeKind || null,
      scopeRef: payload.scopeRef || null,
      payload
    });
  } catch (err) {
    // Persistence is the source of truth — if we can't write the event we
    // should not advertise it either, otherwise reconnect replay would
    // miss it forever.
    console.error("[event-log] appendEvent failed", { userId, kind: payload.type, err: err?.message });
    return null;
  }
  const tagged = { ...payload, seq: event.seq, eventId: event.id };
  for (const ws of context.eventHub.socketsByUser.get(userId) || []) {
    sendWsJson(ws, tagged);
  }
  return event;
}

// Push a transient event (no replay needed): bridge run progress, device
// online/offline. These describe momentary process state, not durable
// user-facing state, so persistence would just inflate the event log
// without value. If the client missed it, the next bridge_run_updated /
// device_updated supersedes anyway.
function broadcastTransientEvent(hub, userId, payload) {
  for (const ws of hub.socketsByUser.get(userId) || []) {
    sendWsJson(ws, payload);
  }
}

// ── write idempotency (Phase 1.D) ─────────────────────────────────────────
//
// Wrap any state-mutating handler so an identical request body
// (clientOpId) replays the same response instead of executing again.
// Necessary because the network can deliver the same POST twice (mobile
// switching networks, browser auto-retry, our own auto-reconnect) and
// we don't want to create two friend requests / two conversations / two
// messages from one user intent.
//
// Usage at top of a POST/PATCH/DELETE handler, AFTER reading body:
//   if (await replayIfCached(context, res, auth.user.id, body)) return;
// And after building the response:
//   rememberOp(context, auth.user.id, body, status, payload);
//   return writeJson(res, status, payload);
//
// Bodies without clientOpId pass through transparently (no caching).
function replayIfCached(context, res, userId, body) {
  if (!body || !body.clientOpId) return false;
  const cached = context.eventLog.getCachedOp(userId, body.clientOpId);
  if (!cached) return false;
  writeJson(res, cached.statusCode, cached.result);
  return true;
}
function rememberOp(context, userId, body, statusCode, payload) {
  if (!body || !body.clientOpId) return;
  context.eventLog.cacheOp(userId, body.clientOpId, { result: payload, statusCode });
}

function sanitizeBridgeRunEvent(event = {}) {
  const kind = String(event.kind || event.type || "status").trim().slice(0, 60) || "status";
  const out = { kind };
  if (event.text != null) out.text = String(event.text).slice(0, 8000);
  if (event.id != null) out.id = String(event.id).slice(0, 120);
  if (event.name != null) out.name = String(event.name).slice(0, 120);
  if (event.preview != null) out.preview = String(event.preview).slice(0, 1000);
  if (event.status != null) out.status = String(event.status).slice(0, 80);
  if (event.error != null) out.error = Boolean(event.error);
  if (typeof event.duration === "number" && Number.isFinite(event.duration)) out.duration = event.duration;
  if (event.finishReason != null) out.finishReason = String(event.finishReason).slice(0, 80);
  if (event.sessionId != null) out.sessionId = String(event.sessionId).slice(0, 160);
  return out;
}

function bridgeDevices(hub, userId) {
  return [...(hub.devicesByUser.get(userId)?.values() || [])]
    .filter((device) => device.ws.readyState === WebSocket.OPEN)
    .map((device) => ({
      id: device.id,
      deviceName: device.deviceName,
      engine: device.engine,
      capabilities: device.capabilities || {},
      connectedAt: device.connectedAt,
      lastSeenAt: device.lastSeenAt,
      status: "online"
    }));
}

function removeBridgeDevice(hub, device) {
  const userDevices = hub.devicesByUser.get(device.userId);
  if (userDevices?.get(device.id) === device) {
    userDevices.delete(device.id);
    if (!userDevices.size) hub.devicesByUser.delete(device.userId);
  }
  try {
    device.cloudStore?.removeBridgeDevice(device.userId, device.id);
    if (device.eventHub) {
      broadcastTransientEvent(device.eventHub, device.userId, {
        type: "device_updated",
        devices: bridgeDevices(hub, device.userId)
      });
    }
  } catch {
    // Server shutdown can close SQLite before late websocket close callbacks drain.
  }
  for (const [runId, pending] of hub.pendingRuns) {
    if (pending.deviceId !== device.id) continue;
    clearTimeout(pending.timer);
    hub.pendingRuns.delete(runId);
    pending.reject(new Error("本机 Agent Bridge 已断开。"));
  }
}

function attachBridgeDevice(hub, ws, { userId, deviceName, engine, capabilities, cloudStore, eventHub }) {
  const device = {
    id: id("bridge"),
    userId,
    deviceName: String(deviceName || "").trim().slice(0, 80) || "本机 Agent",
    engine: String(engine || "").trim().slice(0, 40) || "codex",
    capabilities: capabilities || {},
    cloudStore,
    eventHub,
    ws,
    connectedAt: now(),
    lastSeenAt: now()
  };
  cloudStore?.upsertBridgeDevice(userId, {
    id: device.id,
    deviceName: device.deviceName,
    engine: device.engine,
    capabilities: device.capabilities
  });
  if (!hub.devicesByUser.has(userId)) hub.devicesByUser.set(userId, new Map());
  hub.devicesByUser.get(userId).set(device.id, device);

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    device.lastSeenAt = now();
    if (message.type === "pong") return;
    if (message.type === "run_event") {
      const pending = hub.pendingRuns.get(String(message.runId || ""));
      if (!pending || pending.deviceId !== device.id) return;
      broadcastTransientEvent(device.eventHub, device.userId, {
        type: "bridge_run_event",
        runId: pending.runId,
        event: sanitizeBridgeRunEvent(message.event)
      });
      return;
    }
    if (message.type !== "run_result") return;
    const pending = hub.pendingRuns.get(String(message.runId || ""));
    if (!pending || pending.deviceId !== device.id) return;
    clearTimeout(pending.timer);
    hub.pendingRuns.delete(pending.runId);
    if (message.ok === false) {
      pending.reject(new Error(String(message.error || "本机 Agent 执行失败。")));
      return;
    }
    pending.resolve(message);
  });

  ws.on("close", () => removeBridgeDevice(hub, device));
  ws.on("error", () => removeBridgeDevice(hub, device));
  ws.send(JSON.stringify({ type: "bridge_ready", deviceId: device.id, connectedAt: device.connectedAt }));
  return device;
}

function runBridgeDevice(hub, device, payload) {
  if (!device || device.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("本机 Agent Bridge 不在线。"));
  }
  const runId = String(payload.runId || "") || id("run");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hub.pendingRuns.delete(runId);
      const timeout = new Error("本机 Agent 响应超时。");
      timeout.code = "MIA_BRIDGE_TIMEOUT";
      reject(timeout);
    }, hub.runTimeoutMs || bridgeRunTimeoutMs);
    hub.pendingRuns.set(runId, { runId, userId: device.userId, deviceId: device.id, device, resolve, reject, timer });
    device.ws.send(JSON.stringify({ type: "run", runId, ...payload }), (error) => {
      if (!error) return;
      clearTimeout(timer);
      hub.pendingRuns.delete(runId);
      reject(error);
    });
  });
}

function resolveBridgeRunDevice(hub, userId, requestedDeviceId = "") {
  const onlineDevices = [...(hub.devicesByUser.get(userId)?.values() || [])]
    .filter((device) => device.ws.readyState === WebSocket.OPEN);
  const deviceId = String(requestedDeviceId || "");
  if (deviceId) return onlineDevices.find((device) => device.id === deviceId) || null;
  if (onlineDevices.length === 1) return onlineDevices[0];
  return null;
}

function cancelBridgeRunDevice(hub, userId, runId) {
  const pending = hub.pendingRuns.get(runId);
  if (!pending || pending.userId !== userId) return false;
  clearTimeout(pending.timer);
  hub.pendingRuns.delete(runId);
  if (pending.device?.ws?.readyState === WebSocket.OPEN) {
    pending.device.ws.send(JSON.stringify({ type: "cancel", runId }));
  }
  const cancelled = new Error("本机 Agent 运行已取消。");
  cancelled.code = "MIA_BRIDGE_CANCELLED";
  pending.reject(cancelled);
  return true;
}

function safeAttachmentUrl(value) {
  const raw = String(value || "").trim();
  if (/^\/api\/files\/[a-zA-Z0-9_-]+$/.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
  } catch {
    // Relative or local filesystem-looking URLs are intentionally rejected.
  }
  return "";
}

function userIsMemberOfConversation(socialStore, conversationId, userId) {
  if (conversationId.startsWith("dm:")) {
    const parts = conversationId.split(":");
    if (parts.length !== 3) return false;
    const [, a, b] = parts;
    if (userId !== a && userId !== b) return false;
    const other = userId === a ? b : a;
    return socialStore.areFriends(userId, other);
  }
  return socialStore.listConversationMembers(conversationId).some(
    (m) => m.member_kind === "user" && m.member_ref === userId
  );
}

function mentionedBotIds(body = {}) {
  const ids = [];
  const seen = new Set();
  const mentions = Array.isArray(body.mentions) ? body.mentions : [];
  for (const mention of mentions) {
    const kind = String(mention?.kind || mention?.member_kind || "").trim();
    if (kind && kind !== "bot") continue;
    const botId = String(mention?.botId || mention?.bot_id || mention?.member_ref || mention?.ref || mention?.id || "").trim();
    if (!botId || seen.has(botId)) continue;
    seen.add(botId);
    ids.push(botId);
  }
  return ids;
}

function broadcastBotInvocations(context, conversationId, message, body, invokedBy) {
  const requested = new Set(mentionedBotIds(body));
  if (!requested.size) return;
  const members = context.socialStore.listConversationMembers(conversationId);
  const recentMessages = context.messagesStore.listMessagesSince(conversationId, 0, 20);
  for (const member of members) {
    if (member.member_kind !== "bot" || !member.owner_id || !requested.has(member.member_ref)) continue;
    const bot = context.botsStore.getBot(member.member_ref);
    if (!bot || bot.ownerUserId !== member.owner_id) continue;
    const aiPerms = parseJson(member.ai_perms_json, {});
    broadcastPersistedEvent(context, member.owner_id, {
      type: "conversation.bot_invocation_requested",
      conversationId,
      botId: member.member_ref,
      runtimeKind: aiPerms.runtimeKind || "desktop-local",
      runtimeConfig: aiPerms,
      invokedBy,
      triggeringMessage: message,
      recentMessages,
      members
    });
  }
}

function tokenFromRequest(req) {
  const auth = String(req.headers.authorization || "");
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

function tokenFromWebSocketProtocol(req) {
  const header = String(req.headers["sec-websocket-protocol"] || "");
  const prefix = "mia-token.";
  return header.split(",")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length) || "";
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "")
    .split(",")[0]
    .trim();
}

function clientFile(file) {
  if (!file) return null;
  return {
    id: file.id,
    type: file.type || "image",
    name: file.name,
    mimeType: file.mimeType,
    size: file.size || 0,
    url: file.url
  };
}

// Composer skill chips sent with a message. Untrusted client input → cap the
// count, validate each id against a safe pattern, and bound the display name,
// before it is stored and (on the owner's desktop) used to drive skill loading.
// Skill ids are "<libraryId>:<id>" (e.g. mia:trip-planner) — the colon is part
// of the canonical id, so it must be allowed alongside slug characters.
const SKILL_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;
function sanitizeMessageSkills(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= 16) break;
    const id = String((item && item.id) || "").trim();
    if (!id || id.length > 128 || !SKILL_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = String((item && item.name) || id).trim().slice(0, 128);
    out.push({ id, name });
  }
  return out.length ? out : null;
}

function persistCloudAttachments(cloudStore, userId, attachments = []) {
  return attachments.map((attachment) => {
    if (attachment?.dataUrl) return clientFile(cloudStore.saveImageDataUrl(userId, attachment));
    const url = safeAttachmentUrl(attachment?.url);
    const cloudFileId = url.match(/^\/api\/files\/([a-zA-Z0-9_-]+)$/)?.[1] || "";
    if (cloudFileId) {
      const file = cloudStore.getFileForUser(userId, cloudFileId);
      return file ? clientFile(file) : null;
    }
    if (url) return {
      id: String(attachment.id || id("att")),
      type: attachment.type || "file",
      name: String(attachment.name || "附件"),
      mimeType: attachment.mimeType || attachment.mime || "",
      url
    };
    return null;
  }).filter(Boolean);
}

function sanitizeCloudMessageAttachments(cloudStore, userId, message = {}) {
  const sanitized = {
    ...message,
    attachments: persistCloudAttachments(
      cloudStore,
      userId,
      Array.isArray(message.attachments) ? message.attachments : []
    )
  };
  const commandResult = sanitizeCommandResult(message.commandResult);
  if (commandResult) sanitized.commandResult = commandResult;
  else delete sanitized.commandResult;
  return sanitized;
}

function sanitizeCommandResult(commandResult) {
  if (!commandResult || typeof commandResult !== "object" || commandResult.type !== "session-list") return null;
  const rows = Array.isArray(commandResult.rows)
    ? commandResult.rows
      .map((row) => ({
        id: String(row?.id || "").trim(),
        title: String(row?.title || "").trim().slice(0, 160),
        preview: String(row?.preview || "").trim().slice(0, 240),
        project: String(row?.project || "").trim().slice(0, 240),
        updatedAt: Number(row?.updatedAt) || 0
      }))
      .filter((row) => row.id)
      .slice(0, 20)
    : [];
  if (!rows.length) return null;
  const normalized = {
    type: "session-list",
    command: String(commandResult.command || "/resume").trim() || "/resume",
    engine: String(commandResult.engine || "").trim(),
    rows
  };
  const sourceDeviceId = String(commandResult.sourceDeviceId || "").trim();
  const sourceDeviceName = String(commandResult.sourceDeviceName || "").trim().slice(0, 120);
  if (sourceDeviceId) normalized.sourceDeviceId = sourceDeviceId;
  if (sourceDeviceName) normalized.sourceDeviceName = sourceDeviceName;
  return normalized;
}

// (sanitizeCloudConversationAttachments / sanitizeCloudWorkspaceAttachments
//  / cleanConversation removed in Phase 4 cutover — their callers (the
//  workspace + conversations + messages endpoints) are gone. Per-message
//  attachment sanitization still happens via sanitizeCloudMessageAttachments
//  above and persistCloudAttachments at the conversation-message POST path.)

function serveAuthorizedFile(req, res, cloudStore, auth, pathname) {
  const match = pathname.match(/^\/api\/files\/([a-zA-Z0-9_-]+)$/);
  if (!match) return false;
  if (!auth) {
    writeError(res, 401, "请先登录。");
    return true;
  }
  const file = cloudStore.getFileForUser(auth.user.id, match[1]);
  if (!file) {
    writeError(res, 404, "File not found.");
    return true;
  }
  if (!fs.existsSync(file.path)) {
    writeError(res, 404, "File not found on disk.");
    return true;
  }
  const body = fs.readFileSync(file.path);
  res.writeHead(200, {
    "Content-Type": file.mimeType || fileContentType(file.path),
    "Content-Length": body.length,
    "Cache-Control": "private, max-age=31536000, immutable"
  });
  res.end(body);
  return true;
}

function ensureCloudAgentBootstrap(context, userId) {
  if (!context?.botsStore || !context?.runtimeBindingsStore || !context?.socialStore || !userId) return null;
  return null;
}

async function handleRequest(req, res, context) {
  const cloudStore = context.cloudStore;
  const bridgeHub = context.bridgeHub;
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  applySecurityHeaders(req, res, context);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    writeJson(res, 200, {
      ok: true,
      service: "mia-cloud",
      version: String(process.env.MIA_CLOUD_VERSION || ""),
      release: releaseHealthPayload(context.releaseManifest),
      features: cloudFeatures
    });
    return;
  }

  if (url.pathname === "/admin") {
    res.writeHead(308, { "Location": "/admin/model" });
    res.end();
    return;
  }
  if (req.method === "GET" && (url.pathname === "/admin/model" || url.pathname === "/admin/model/")) {
    serveAdminModelPage(req, res, context);
    return;
  }
  if (url.pathname.startsWith("/api/admin/")) {
    try {
      await handleAdminModelGateway(req, res, context, url);
    } catch (error) {
      writeError(res, error.status || 500, error.message || "Admin request failed.");
    }
    return;
  }

  if (serveWebAsset(req, res, context.webRoot, url.pathname)) return;

  try {
    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      const account = cloudStore.registerUser(await readJson(req));
      ensureCloudAgentBootstrap(context, account.user.id);
      return writeJson(res, 201, compactAuthAccount(account));
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const account = cloudStore.loginUser({ ...(await readJson(req)), ip: clientIp(req) });
      ensureCloudAgentBootstrap(context, account.user.id);
      return writeJson(res, 200, compactAuthAccount(account));
    }

    const auth = cloudStore.authenticateToken(tokenFromRequest(req));
    if (req.method === "GET" && serveAuthorizedFile(req, res, cloudStore, auth, url.pathname)) return;
    if (!auth) return writeError(res, 401, "请先登录。");

    if (req.method === "GET" && url.pathname === "/api/me/model-catalog") {
      const models = await listPlatformModelCatalog(context);
      return writeJson(res, 200, { ok: true, models });
    }

    // POST /api/social/friend-requests
    if (req.method === "POST" && url.pathname === "/api/social/friend-requests") {
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const toUsername = String(body.toUsername || "").trim();
      if (!toUsername) return writeError(res, 400, "toUsername is required");
      const toUser = context.cloudStore.getUserByUsername(toUsername);
      if (!toUser) return writeError(res, 404, "user not found");
      if (toUser.id === auth.user.id) return writeError(res, 400, "cannot add yourself");
      if (context.socialStore.areFriends(auth.user.id, toUser.id)) {
        return writeError(res, 409, "already friends");
      }
      let created;
      try {
        created = context.socialStore.createFriendRequestByUsername({ fromUserId: auth.user.id, toUserId: toUser.id });
      } catch (e) {
        return writeError(res, 409, e.message);
      }
      // notify the addressee
      broadcastPersistedEvent(context, toUser.id, {
        type: "social.friend_request_received",
        request: { ...created, from: context.cloudStore.getUserPublic(auth.user.id) }
      });
      const payload = { request: created };
      rememberOp(context, auth.user.id, body, 201, payload);
      return writeJson(res, 201, payload);
    }

    // GET /api/social/friend-requests?direction=incoming|outgoing
    if (req.method === "GET" && url.pathname === "/api/social/friend-requests") {
      const direction = url.searchParams.get("direction") || "incoming";
      let rows;
      if (direction === "outgoing") {
        rows = context.socialStore.listOutgoingPending(auth.user.id);
      } else {
        rows = context.socialStore.listIncomingPending(auth.user.id);
      }
      // hydrate with public user info on the other side
      const hydrated = rows.map((row) => {
        const otherId = direction === "outgoing" ? row.to_user : row.from_user;
        return { ...row, other: context.cloudStore.getUserPublic(otherId) };
      });
      return writeJson(res, 200, { requests: hydrated });
    }

    // POST /api/social/friend-requests/:id/respond
    const respondMatch = url.pathname.match(/^\/api\/social\/friend-requests\/([a-zA-Z0-9_-]+)\/respond$/);
    if (req.method === "POST" && respondMatch) {
      const requestId = respondMatch[1];
      const body = await readJson(req);
      const action = String(body.action || "");
      if (action !== "accept" && action !== "reject") {
        return writeError(res, 400, "action must be 'accept' or 'reject'");
      }
      let updated;
      try {
        updated = context.socialStore.respondToFriendRequest(requestId, auth.user.id, action);
      } catch (e) {
        return writeError(res, 400, e.message);
      }
      if (action === "accept") {
        const conversation = ensureDmConversation(context.socialStore, updated.from_user, auth.user.id);
        const senderPublic = context.cloudStore.getUserPublic(updated.from_user);
        const accepterPublic = context.cloudStore.getUserPublic(auth.user.id);
        // notify both
        broadcastPersistedEvent(context, updated.from_user, {
          type: "social.friend_added",
          friend: accepterPublic,
          conversation
        });
        broadcastPersistedEvent(context, auth.user.id, {
          type: "social.friend_added",
          friend: senderPublic,
          conversation
        });
        return writeJson(res, 200, { request: updated, friend: senderPublic, conversation });
      }
      // reject: do NOT notify sender (QQ-style)
      return writeJson(res, 200, { request: updated });
    }

    // DELETE /api/social/friend-requests/:id  (cancel by sender)
    const cancelFrMatch = url.pathname.match(/^\/api\/social\/friend-requests\/([a-zA-Z0-9_-]+)$/);
    if (req.method === "DELETE" && cancelFrMatch) {
      const requestId = cancelFrMatch[1];
      try {
        const updated = context.socialStore.cancelFriendRequest(requestId, auth.user.id);
        return writeJson(res, 200, { request: updated });
      } catch (e) {
        return writeError(res, 400, e.message);
      }
    }

    if (req.method === "GET" && url.pathname === "/api/social/friends") {
      const friendIds = context.socialStore.listFriends(auth.user.id);
      const friends = friendIds
        .map((id) => context.cloudStore.getUserPublic(id))
        .filter(Boolean);
      return writeJson(res, 200, { friends });
    }

    const unfriendMatch = url.pathname.match(/^\/api\/social\/friends\/([a-zA-Z0-9_-]+)$/);
    if (req.method === "DELETE" && unfriendMatch) {
      context.socialStore.removeFriendship(auth.user.id, unfriendMatch[1]);
      return writeJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/conversations") {
      ensureCloudAgentBootstrap(context, auth.user.id);
      const conversations = context.socialStore.listConversationsForUser(auth.user.id);
      return writeJson(res, 200, { conversations });
    }

    // POST /api/conversations — create a group conversation. Idempotent on optional
    // `clientGroupId`: if any conversation this user is in already has decorations
    // .clientGroupId === clientGroupId, return that conversation instead of creating
    // a new one. This prevents the desktop sync from re-creating duplicates
    // when the local group was uploaded earlier through a different path.
    if (req.method === "POST" && url.pathname === "/api/conversations") {
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const name = String(body.name || "").trim();
      if (!name || name.length > 80) return writeError(res, 400, "name is required and must be 1..80 chars");
      const memberBots = Array.isArray(body.memberBots) ? body.memberBots : [];
      const memberFriendUserIds = Array.isArray(body.memberFriendUserIds) ? body.memberFriendUserIds : [];
      const clientGroupId = String(body.clientGroupId || "").trim() || null;

      // Idempotency check
      if (clientGroupId) {
        const userConversations = context.socialStore.listConversationsForUser(auth.user.id);
        const existing = userConversations.find((r) => r && r.decorations && r.decorations.clientGroupId === clientGroupId);
        if (existing) {
          const members = context.socialStore.listConversationMembers(existing.id);
          return writeJson(res, 200, { conversation: existing, members, reused: true });
        }
      }

      // Validate friend membership before creating anything
      for (const friendId of memberFriendUserIds) {
        if (!context.socialStore.areFriends(auth.user.id, String(friendId))) {
          return writeError(res, 403, "user is not your friend: " + friendId);
        }
      }
      for (const bot of memberBots) {
        const botId = String(bot.botId || "").trim();
        if (!botId) continue;
        const existingBot = context.botsStore.getBot(botId);
        if (!existingBot) return writeError(res, 404, "bot not found");
        if (existingBot.ownerUserId !== auth.user.id) {
          return writeError(res, 403, "you can only add your own bots");
        }
      }
      const conversationId = "g_" + require("node:crypto").randomBytes(8).toString("hex");
      const decorations = clientGroupId ? { clientGroupId } : null;
      context.socialStore.createConversation({ id: conversationId, name, decorations });
      context.socialStore.addConversationMember({ conversationId, memberKind: "user", memberRef: auth.user.id });
      for (const bot of memberBots) {
        const botId = String(bot.botId || "").trim();
        if (!botId) continue;
        const runtimeKind = normalizeMemberRuntimeKind(bot.runtimeKind);
        context.socialStore.addConversationMember({
          conversationId,
          memberKind: "bot",
          memberRef: botId,
          ownerId: auth.user.id,
          aiPerms: runtimeKind ? { runtimeKind } : null
        });
      }
      for (const friendId of memberFriendUserIds) {
        context.socialStore.addConversationMember({ conversationId, memberKind: "user", memberRef: String(friendId) });
      }
      const conversation = context.socialStore.getConversation(conversationId);
      const members = context.socialStore.listConversationMembers(conversationId);
      const creatorPublic = context.cloudStore.getUserPublic(auth.user.id);
      // Broadcast social.conversation_invited to all user-members except creator
      for (const m of members) {
        if (m.member_kind === "user" && m.member_ref !== auth.user.id) {
          broadcastPersistedEvent(context, m.member_ref, { type: "social.conversation_invited", conversation, invitedBy: creatorPublic });
        }
      }
      const payload = { conversation, members };
      rememberOp(context, auth.user.id, body, 201, payload);
      return writeJson(res, 201, payload);
    }

    const conversationAsBotMatch = url.pathname.match(/^\/api\/conversations\/([A-Za-z0-9_.:-]+)\/messages\/as-bot$/);
    const conversationMembersMatch = url.pathname.match(/^\/api\/conversations\/([A-Za-z0-9_.:-]+)\/members$/);
    const conversationMsgDeleteMatch = url.pathname.match(/^\/api\/conversations\/([A-Za-z0-9_.:-]+)\/messages\/([A-Za-z0-9_-]+)$/);
    const conversationMsgsMatch = !conversationAsBotMatch && url.pathname.match(/^\/api\/conversations\/([A-Za-z0-9_.:-]+)\/messages$/);
    const conversationDetailMatch = !conversationAsBotMatch && !conversationMembersMatch && !conversationMsgsMatch && !conversationMsgDeleteMatch && url.pathname.match(/^\/api\/conversations\/([A-Za-z0-9_.:-]+)$/);

    // POST /api/conversations/:id/members — add member to existing group
    if (req.method === "POST" && conversationMembersMatch) {
      const conversationId = conversationMembersMatch[1];
      if (conversationId.startsWith("dm:")) return writeError(res, 400, "DM conversations cannot be modified");
      if (!userIsMemberOfConversation(context.socialStore, conversationId, auth.user.id)) {
        return writeError(res, 403, "not a member of this conversation");
      }
      const body = await readJson(req);
      const memberKind = String(body.memberKind || "");
      const memberRef = String(body.memberRef || "").trim();
      if (!memberKind || !memberRef) return writeError(res, 400, "memberKind and memberRef are required");
      if (memberKind !== "user" && memberKind !== "bot") return writeError(res, 400, "memberKind must be 'user' or 'bot'");
      if (memberKind === "user") {
        if (!context.socialStore.areFriends(auth.user.id, memberRef)) {
          return writeError(res, 403, "user is not your friend: " + memberRef);
        }
        context.socialStore.addConversationMember({ conversationId, memberKind: "user", memberRef });
        const member = context.socialStore.getConversationMember(conversationId, "user", memberRef);
        const conversation = context.socialStore.getConversation(conversationId);
        const inviterPublic = context.cloudStore.getUserPublic(auth.user.id);
        broadcastPersistedEvent(context, memberRef, { type: "social.conversation_invited", conversation, invitedBy: inviterPublic });
        return writeJson(res, 201, { ok: true, member });
      }
      // memberKind === 'bot'
      const ownerId = String(body.ownerId || "").trim();
      if (ownerId !== auth.user.id) {
        return writeError(res, 403, "you can only add your own bots");
      }
      const existingBot = context.botsStore.getBot(memberRef);
      if (!existingBot) return writeError(res, 404, "bot not found");
      if (existingBot.ownerUserId !== auth.user.id) {
        return writeError(res, 403, "you can only add your own bots");
      }
      const runtimeKind = normalizeMemberRuntimeKind(body.runtimeKind);
      context.socialStore.addConversationMember({
        conversationId,
        memberKind: "bot",
        memberRef,
        ownerId: auth.user.id,
        aiPerms: runtimeKind ? { runtimeKind } : null
      });
      const member = context.socialStore.getConversationMember(conversationId, "bot", memberRef);
      return writeJson(res, 201, { ok: true, member });
    }

    // DELETE /api/conversations/:id/members — remove a member by {memberKind, memberRef}.
    // Same lenient "any member can edit" rule as PATCH; the operation is
    // bounded by the conversation scope and doesn't expose other conversations' state.
    if (req.method === "DELETE" && conversationMembersMatch) {
      const conversationId = conversationMembersMatch[1];
      if (conversationId.startsWith("dm:")) return writeError(res, 400, "DM conversations cannot be modified");
      if (!userIsMemberOfConversation(context.socialStore, conversationId, auth.user.id)) {
        return writeError(res, 403, "not a member of this conversation");
      }
      const body = await readJson(req);
      const memberKind = String(body.memberKind || "");
      const memberRef = String(body.memberRef || "").trim();
      if (!memberKind || !memberRef) return writeError(res, 400, "memberKind and memberRef are required");
      context.socialStore.removeConversationMember(conversationId, memberKind, memberRef);
      // Broadcast conversation.updated so every client refreshes its member cache.
      const conversation = context.socialStore.getConversation(conversationId);
      for (const m of context.socialStore.listConversationMembers(conversationId)) {
        if (m.member_kind === "user") {
          broadcastPersistedEvent(context, m.member_ref, { type: "conversation.updated", conversation });
        }
      }
      return writeJson(res, 200, { ok: true });
    }

    // POST /api/conversations/:id/messages/as-bot — post AS a bot
    if (req.method === "POST" && conversationAsBotMatch) {
      const conversationId = conversationAsBotMatch[1];
      const body = await readJson(req);
      const botId = String(body.botId || "").trim();
      if (!botId) return writeError(res, 400, "botId is required");
      const bot = context.botsStore.getBot(botId);
      if (!bot) return writeError(res, 404, "bot not found");
      if (bot.ownerUserId !== auth.user.id) return writeError(res, 403, "you can only post as your own bot");
      const botMember = context.socialStore.getConversationMember(conversationId, "bot", botId);
      if (!botMember || botMember.owner_id !== auth.user.id) {
        return writeError(res, 403, "you are not the owner of this bot in this conversation");
      }
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const attachments = persistCloudAttachments(
        context.cloudStore,
        auth.user.id,
        Array.isArray(body.attachments) ? body.attachments : []
      );
      const message = context.messagesStore.appendMessage({
        conversationId,
        senderKind: "bot",
        senderRef: botId,
        senderOwnerId: auth.user.id,
        bodyMd: body.bodyMd || "",
        attachments: attachments.length ? attachments : null,
        mentions: body.mentions || null,
        trace: body.trace || null,
        turnId: body.turnId || null,
        status: "complete",
        errorJson: body.errorJson || null,
      });
      for (const m of context.socialStore.listConversationMembers(conversationId)) {
        if (m.member_kind === "user") {
          broadcastPersistedEvent(context, m.member_ref, { type: "conversation.message_appended", conversationId, message });
        }
      }
      const payload = { message };
      rememberOp(context, auth.user.id, body, 201, payload);
      return writeJson(res, 201, payload);
    }

    if (req.method === "GET" && conversationDetailMatch) {
      const conversationId = conversationDetailMatch[1];
      if (!userIsMemberOfConversation(context.socialStore, conversationId, auth.user.id)) {
        return writeError(res, 403, "not a member of this conversation");
      }
      const conversation = context.socialStore.getConversation(conversationId);
      if (!conversation) return writeError(res, 404, "conversation not found");
      const members = context.socialStore.listConversationMembers(conversationId);
      // Enrich members with public identity so clients and conductors can
      // resolve display names without profile-avatar payloads.
      const enriched = members.map((m) => {
        if (m.member_kind === "user") {
          const user = context.cloudStore.getUserPublic(m.member_ref);
          return {
            ...m,
            user: conversationMemberOwnerPublic(user),
            identity: memberIdentityForUser(user, m.member_ref)
          };
        }
        if (m.member_kind === "bot" && m.owner_id) {
          const owner = context.cloudStore.getUserPublic(m.owner_id);
          const conversationBotId = conversation?.decorations?.botId || "";
          const fallbackName = m.bot_name
            || (conversationBotId === m.member_ref && conversation?.name ? conversation.name : "")
            || m.member_ref;
          const bot = context.botsStore.getBot(m.member_ref) || {
            id: m.member_ref,
            ownerUserId: m.owner_id,
            displayName: fallbackName,
            avatarImage: m.bot_avatar_image || "",
            avatarCrop: m.bot_avatar_crop || null,
            color: m.bot_color || ""
          };
          return {
            ...m,
            owner: conversationMemberOwnerPublic(owner),
            identity: memberIdentityForBot(bot, m.member_ref, m.owner_id)
          };
        }
        return m;
      });
      return writeJson(res, 200, { conversation, members: enriched });
    }

    // PATCH /api/conversations/:id — update conversation metadata (name, decorations).
    // Used by sidebar context menu for rename and pin. Any member of the
    // conversation can edit metadata; this is intentionally lenient because the
    // operations are non-destructive and mia has no group-admin model.
    if (req.method === "PATCH" && conversationDetailMatch) {
      const conversationId = conversationDetailMatch[1];
      if (!userIsMemberOfConversation(context.socialStore, conversationId, auth.user.id)) {
        return writeError(res, 403, "not a member of this conversation");
      }
      const existing = context.socialStore.getConversation(conversationId);
      if (!existing) return writeError(res, 404, "conversation not found");
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const patch = {};
      if (Object.prototype.hasOwnProperty.call(body, "name")) {
        const name = String(body.name || "").trim();
        if (!name || name.length > 80) return writeError(res, 400, "name must be 1..80 chars");
        if (conversationId.startsWith("dm:")) return writeError(res, 400, "DM conversations cannot be renamed");
        patch.name = name;
      }
      if (Object.prototype.hasOwnProperty.call(body, "decorations")) {
        patch.decorations = body.decorations && typeof body.decorations === "object" ? body.decorations : null;
      }
      const conversation = context.socialStore.updateConversation(conversationId, patch);
      const members = context.socialStore.listConversationMembers(conversationId);
      // Broadcast conversation.updated to all user-members so other devices/clients refresh.
      for (const m of members) {
        if (m.member_kind === "user") {
          broadcastPersistedEvent(context, m.member_ref, { type: "conversation.updated", conversation });
        }
      }
      const payload = { conversation };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    // DELETE /api/conversations/:id — remove the conversation. ON DELETE CASCADE in the
    // schema removes conversation_members + messages automatically. Any member can
    // initiate (same lenient rule as PATCH).
    if (req.method === "DELETE" && conversationDetailMatch) {
      const conversationId = conversationDetailMatch[1];
      if (!userIsMemberOfConversation(context.socialStore, conversationId, auth.user.id)) {
        return writeError(res, 403, "not a member of this conversation");
      }
      const existing = context.socialStore.getConversation(conversationId);
      if (!existing) return writeError(res, 404, "conversation not found");
      // DELETE bodies are usually empty, but the client can pass a body
      // with a clientOpId. Reading it is best-effort.
      let body = {};
      try { body = await readJson(req); } catch { /* empty body is fine */ }
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const members = context.socialStore.listConversationMembers(conversationId);
      context.socialStore.deleteConversation(conversationId);
      // Broadcast conversation.deleted BEFORE removing connections — let clients
      // close any open subscriptions on this conversation.
      for (const m of members) {
        if (m.member_kind === "user") {
          broadcastPersistedEvent(context, m.member_ref, { type: "conversation.deleted", conversationId });
        }
      }
      const payload = { ok: true };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    if (req.method === "GET" && conversationMsgsMatch) {
      const conversationId = conversationMsgsMatch[1];
      if (!userIsMemberOfConversation(context.socialStore, conversationId, auth.user.id)) {
        return writeError(res, 403, "not a member of this conversation");
      }
      const sinceSeq = Number(url.searchParams.get("since_seq") || 0);
      const limit = Number(url.searchParams.get("limit") || 100);
      // Pass the requesting user so messages they've locally deleted (hidden)
      // are excluded — survives re-sync and new devices.
      const messages = context.messagesStore.listMessagesSince(conversationId, sinceSeq, limit, auth.user.id);
      return writeJson(res, 200, { messages });
    }

    if (req.method === "POST" && conversationMsgsMatch) {
      const conversationId = conversationMsgsMatch[1];
      if (!userIsMemberOfConversation(context.socialStore, conversationId, auth.user.id)) {
        return writeError(res, 403, "not a member of this conversation");
      }
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      // DM conversations are lazy-created on first message (per spec §6)
      if (conversationId.startsWith("dm:") && !context.socialStore.getConversation(conversationId)) {
        const parts = conversationId.split(":");
        const [, a, b] = parts;
        const other = auth.user.id === a ? b : a;
        ensureDmConversation(context.socialStore, auth.user.id, other);
      }
      const attachments = persistCloudAttachments(
        context.cloudStore,
        auth.user.id,
        Array.isArray(body.attachments) ? body.attachments : []
      );
      const message = context.messagesStore.appendMessage({
        conversationId,
        senderKind: "user",
        senderRef: auth.user.id,
        bodyMd: body.bodyMd || "",
        attachments: attachments.length ? attachments : null,
        mentions: body.mentions || null,
        skills: sanitizeMessageSkills(body.skills),
        turnId: body.turnId || null,
        status: "complete",
      });
      // 1. Broadcast conversation.message_appended to all user-members
      const allMembers = context.socialStore.listConversationMembers(conversationId);
      for (const m of allMembers) {
        if (m.member_kind === "user") {
          broadcastPersistedEvent(context, m.member_ref, { type: "conversation.message_appended", conversationId, message });
        }
      }
      broadcastBotInvocations(context, conversationId, message, body, context.cloudStore.getUserPublic(auth.user.id) || { id: auth.user.id });
      if (context.cloudAgentDispatcher) {
        context.cloudAgentDispatcher.handleUserMessage({
          userId: auth.user.id,
          conversationId,
          message
        }).catch((error) => {
          console.warn("[cloud-agent] dispatch failed:", error?.message || error);
        });
      }
      const payload = { message };
      rememberOp(context, auth.user.id, body, 201, payload);
      return writeJson(res, 201, payload);
    }

    // POST /api/conversations/:id/runs/:runId/approval — resolve an interactive
    // tool-permission request raised by an in-flight cloud Hermes run. The
    // approval.request event was delivered to the run owner's web client over the
    // cloud_agent_run_event stream; this carries their decision back to the run's
    // Hermes worker. Only the run owner may answer (spec §13).
    const runApprovalMatch = url.pathname.match(/^\/api\/conversations\/([A-Za-z0-9_.:-]+)\/runs\/([A-Za-z0-9_-]+)\/approval$/);
    if (req.method === "POST" && runApprovalMatch) {
      const conversationId = runApprovalMatch[1];
      const runId = runApprovalMatch[2];
      if (!userIsMemberOfConversation(context.socialStore, conversationId, auth.user.id)) {
        return writeError(res, 403, "not a member of this conversation");
      }
      if (!context.cloudAgentDispatcher) return writeError(res, 503, "cloud agent dispatcher unavailable");
      const body = await readJson(req);
      const decision = String(body.decision || "").trim();
      const allowed = new Set(["allow_once", "allow_always", "deny"]);
      if (!allowed.has(decision)) {
        return writeError(res, 400, "decision must be one of: allow_once, allow_always, deny");
      }
      let result;
      try {
        result = await context.cloudAgentDispatcher.respondApproval({ userId: auth.user.id, runId, conversationId, decision });
      } catch (error) {
        return writeError(res, 502, `approval relay failed: ${error?.message || error}`);
      }
      if (!result || result.ok === false) {
        const message = result?.error || "approval not resolved";
        const status = message.includes("not found") ? 404 : message.includes("owner") ? 403 : 409;
        return writeError(res, status, message);
      }
      return writeJson(res, 200, { ok: true, decision });
    }

    // DELETE /api/conversations/:id/messages/:msgId — WeChat-style local delete: hide
    // the message from THIS user's view only, then tell their other devices to
    // drop it too. Other conversation members keep their copy; a member can never
    // delete a message out of someone else's history. (A future "recall" would
    // be a separate, sender-only, broadcast-to-all action.)
    if (req.method === "DELETE" && conversationMsgDeleteMatch) {
      const conversationId = conversationMsgDeleteMatch[1];
      const messageId = conversationMsgDeleteMatch[2];
      if (!userIsMemberOfConversation(context.socialStore, conversationId, auth.user.id)) {
        return writeError(res, 403, "not a member of this conversation");
      }
      const existing = context.messagesStore.getMessage(messageId);
      if (!existing || existing.conversation_id !== conversationId) {
        return writeError(res, 404, "message not found");
      }
      context.messagesStore.hideMessageForUser(conversationId, messageId, auth.user.id);
      // Only the deleting user's own devices learn about it — never broadcast
      // to the other members.
      broadcastPersistedEvent(context, auth.user.id, { type: "conversation.message_deleted", conversationId, messageId });
      return writeJson(res, 200, { ok: true, conversationId, messageId });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      cloudStore.logoutSession(tokenFromRequest(req));
      return writeJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      ensureCloudAgentBootstrap(context, auth.user.id);
      const user = wantsCompactPayload(url) ? compactPublicUser(auth.user) : auth.user;
      return writeJson(res, 200, { user });
    }

    // PATCH /api/me/profile — update the signed-in user's display avatar so
    // friends (and the user themself, from other devices) see the same image
    // their desktop uses. Body: { avatarImage?, avatarCrop?, avatarColor? }
    if (req.method === "PATCH" && url.pathname === "/api/me/profile") {
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const updated = cloudStore.updateUserProfile(auth.user.id, {
        avatarImage: typeof body.avatarImage === "string" ? body.avatarImage : undefined,
        avatarCrop: body.avatarCrop === null || (body.avatarCrop && typeof body.avatarCrop === "object") ? body.avatarCrop : undefined,
        avatarColor: typeof body.avatarColor === "string" ? body.avatarColor : undefined
      });
      const payload = { user: updated };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    // PUT /api/me/bot-conversations/:sessionId — upsert a single-owner
    // bot chat conversation backed by conversations+messages.
    const botConversationMatch = url.pathname.match(/^\/api\/me\/bot-conversations\/([A-Za-z0-9_.:-]+)$/);
    if (req.method === "PUT" && botConversationMatch) {
      const sessionId = botConversationMatch[1];
      const body = await readJson(req);
      const botId = String(body.botId || "").trim();
      if (!botId) return writeError(res, 400, "botId is required");
      const bot = context.botsStore.getBot(botId);
      if (!bot) return writeError(res, 404, "bot not found");
      if (bot.ownerUserId !== auth.user.id) return writeError(res, 403, "you can only open your own bots");
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const title = String(body.title || "").trim();
      const requestedRuntimeKind = String(body.runtimeKind || "").trim();
      const conversationId = botConversationId(sessionId);
      let conversation = context.socialStore.getConversation(conversationId);
      const decorations = {
        ...(conversation?.decorations || {}),
        botId,
        sessionId,
        runtimeKind: conversation?.decorations?.runtimeKind || requestedRuntimeKind || "desktop-local"
      };
      const sameJson = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
      if (!conversation) {
        context.socialStore.createConversation({
          id: conversationId,
          type: "bot",
          name: title || bot?.displayName || null,
          decorations
        });
        context.socialStore.addConversationMember({ conversationId, memberKind: "user", memberRef: auth.user.id });
        context.socialStore.addConversationMember({ conversationId, memberKind: "bot", memberRef: botId, ownerId: auth.user.id });
        conversation = context.socialStore.getConversation(conversationId);
      } else if ((title && title !== conversation.name) || !sameJson(conversation.decorations, decorations)) {
        conversation = context.socialStore.updateConversation(conversationId, {
          ...(title && title !== conversation.name ? { name: title } : {}),
          decorations
        });
      }
      const members = context.socialStore.listConversationMembers(conversationId);
      const payload = { conversation, members };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    if (req.method === "GET" && url.pathname === "/api/me/bots") {
      let bots = context.botsStore.listBots(auth.user.id);
      if (wantsCompactPayload(url)) bots = bots.map(compactBotIdentity);
      return writeJson(res, 200, { bots });
    }

    const botRuntimeMatch = url.pathname.match(/^\/api\/me\/bots\/([A-Za-z0-9_.-]+)\/runtime$/);
    if (req.method === "GET" && botRuntimeMatch) {
      const botId = botRuntimeMatch[1];
      const runtimeKind = String(url.searchParams.get("kind") || "cloud-hermes").trim() || "cloud-hermes";
      const binding = context.runtimeBindingsStore.getBinding(auth.user.id, botId, runtimeKind) || {
        userId: auth.user.id,
        botId,
        runtimeKind,
        enabled: false,
        config: {}
      };
      return writeJson(res, 200, { binding });
    }

    if (req.method === "PUT" && botRuntimeMatch) {
      const botId = botRuntimeMatch[1];
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const bot = context.botsStore.getBot(botId);
      if (!bot) return writeError(res, 404, "bot not found");
      if (bot.ownerUserId !== auth.user.id) return writeError(res, 403, "you can only update your own bots");
      const runtimeKind = String(body.runtimeKind || "cloud-hermes").trim() || "cloud-hermes";
      const config = sanitizeRuntimeConfig(body.config);
      const binding = context.runtimeBindingsStore.upsertBinding({
        userId: auth.user.id,
        botId,
        runtimeKind,
        enabled: body.enabled !== false,
        config
      });
      broadcastPersistedEvent(context, auth.user.id, { type: "bot.runtime_updated", binding });
      const payload = { binding };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    const botDetailMatch = url.pathname.match(/^\/api\/me\/bots\/([A-Za-z0-9_.-]+)$/);
    if (req.method === "PUT" && botDetailMatch) {
      const id = botDetailMatch[1];
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const displayName = body.displayName || body.display_name || body.name;
      if (!displayName || typeof displayName !== "string") return writeError(res, 400, "displayName is required");
      let bot;
      try {
        bot = context.botsStore.upsertBot(auth.user.id, {
          ...body,
          id,
          displayName
        });
      } catch (error) {
        return writeError(res, 409, error?.message || "bot upsert failed");
      }
      broadcastPersistedEvent(context, auth.user.id, { type: "bot.upserted", bot });
      const payload = { bot };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    // GET /api/me/settings — cross-device user settings (pin / read marks
    // / appearance). Phase 3. Clients fetch on bootstrap + subscribe to
    // user_settings.updated to stay in sync.
    if (req.method === "GET" && url.pathname === "/api/me/settings") {
      return writeJson(res, 200, { settings: context.userSettingsStore.getSettings(auth.user.id) });
    }

    // PUT /api/me/settings — CAS-aware whole-bag replace. Body MAY
    // include expectedVersion; missing → server uses current version
    // (treats request as best-effort). On conflict (some other device
    // wrote between caller's GET and PUT) returns 409 with current
    // settings so client can merge + retry. Broadcasts user_settings
    // .updated only on actual write.
    if (req.method === "PUT" && url.pathname === "/api/me/settings") {
      const body = await readJson(req);
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const out = context.userSettingsStore.putSettings(auth.user.id, {
        pins: body.pins,
        readMarks: body.readMarks,
        appearance: body.appearance,
        expectedVersion: body.expectedVersion
      });
      if (!out.ok) {
        const conflictPayload = { error: "version conflict", settings: out.settings };
        // Don't cache conflicts in op_idempotency — caller will retry
        // with a new expectedVersion and a new clientOpId.
        return writeJson(res, 409, conflictPayload);
      }
      broadcastPersistedEvent(context, auth.user.id, { type: "user_settings.updated", settings: out.settings });
      const payload = { settings: out.settings };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    // DELETE /api/me/bots/:id
    if (req.method === "DELETE" && botDetailMatch) {
      const id = botDetailMatch[1];
      let body = {};
      try { body = await readJson(req); } catch { /* empty */ }
      if (replayIfCached(context, res, auth.user.id, body)) return;
      const existing = context.botsStore.getBot(id);
      if (!existing) return writeError(res, 404, "bot not found");
      if (existing.ownerUserId !== auth.user.id) return writeError(res, 403, "you can only delete your own bots");
      context.botsStore.deleteBot(auth.user.id, id);
      broadcastPersistedEvent(context, auth.user.id, { type: "bot.deleted", botId: id });
      const payload = { ok: true };
      rememberOp(context, auth.user.id, body, 200, payload);
      return writeJson(res, 200, payload);
    }

    // /api/workspace, /api/workspace/sync removed. Bot chats live in
    // conversations+messages now (Phase 4); all conversations route through
    // /api/conversations[/...]. The legacy workspaces table is left in place
    // but no endpoint reads or writes it anymore.

    if (req.method === "GET" && url.pathname === "/api/bridge/devices") {
      return writeJson(res, 200, { devices: bridgeDevices(bridgeHub, auth.user.id) });
    }

    if (req.method === "GET" && url.pathname === "/api/bridge/runs") {
      return writeJson(res, 200, { runs: cloudStore.listBridgeRuns(auth.user.id) });
    }

    const cancelMatch = url.pathname.match(/^\/api\/bridge\/runs\/([a-zA-Z0-9_-]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const runId = cancelMatch[1];
      const wasPending = cancelBridgeRunDevice(bridgeHub, auth.user.id, runId);
      const run = cloudStore.cancelBridgeRun(auth.user.id, runId);
      if (!run) return writeError(res, 404, "Bridge run not found.");
      broadcastTransientEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run });
      return writeJson(res, wasPending || run.status === "cancelled" ? 200 : 409, { run });
    }

    // /api/conversations + /api/messages also removed — all writes go
    // through /api/conversations/:id/messages now. Bridge still uses an
    // internal storage path; see the /api/bridge/run handler.

    if (req.method === "POST" && url.pathname === "/api/bridge/run") {
      const body = await readJson(req);
      const deviceId = String(body.deviceId || "");
      const device = resolveBridgeRunDevice(bridgeHub, auth.user.id, deviceId);
      if (!device) {
        const onlineCount = bridgeDevices(bridgeHub, auth.user.id).length;
        return writeError(res, 409, onlineCount > 1 ? "请选择要连接的本机设备。" : "本机 Agent Bridge 不在线。");
      }
      // Phase 4 cutover: conversationId is now interpreted as a bot
      // conversation id (conversations+messages). The bridge writes the assistant reply
      // through messagesStore.appendMessage into that conversation, and the
      // standard conversation.message_appended event is broadcast as part of
      // the conversation sequence so other devices see it consistently.
      const conversationId = String(body.conversationId || "");
      const requestAttachments = persistCloudAttachments(cloudStore, auth.user.id, Array.isArray(body.attachments) ? body.attachments : []);
      const bridgeRun = cloudStore.createBridgeRun(auth.user.id, {
        deviceId: device.id,
        conversationId,
        text: String(body.text || ""),
        attachments: requestAttachments
      });
      broadcastTransientEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: bridgeRun });
      try {
        const running = cloudStore.startBridgeRun(auth.user.id, bridgeRun.id);
        broadcastTransientEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: running });
        const result = await runBridgeDevice(bridgeHub, device, {
          runId: bridgeRun.id,
          conversationId,
          text: bridgeRun.text,
          attachments: requestAttachments
        });
        const attachments = persistCloudAttachments(cloudStore, auth.user.id, Array.isArray(result.attachments) ? result.attachments : []);
        const completed = cloudStore.completeBridgeRun(auth.user.id, bridgeRun.id, {
          text: result.text,
          attachments
        });
        broadcastTransientEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: completed });
        // Persist the assistant reply into conversations+messages if the
        // conversationId looks like a real conversation id.
        let message = null;
        if (conversationId && context.socialStore.getConversation(conversationId)) {
          const text = String(result.text || "").trim() || "本机 Agent 已完成。";
          message = context.messagesStore.appendMessage({
            conversationId: conversationId,
            senderKind: "bot",
            senderRef: (context.socialStore.getConversation(conversationId)?.decorations?.botId || "agent"),
            senderOwnerId: auth.user.id,
            bodyMd: text,
            attachments,
            status: "complete"
          });
          broadcastPersistedEvent(context, auth.user.id, { type: "conversation.message_appended", conversationId: conversationId, message });
        }
        return writeJson(res, 200, { run: completed, message });
      } catch (error) {
        if (error.code === "MIA_BRIDGE_CANCELLED") {
          const cancelled = cloudStore.getBridgeRun(auth.user.id, bridgeRun.id)
            || cloudStore.cancelBridgeRun(auth.user.id, bridgeRun.id);
          broadcastTransientEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: cancelled });
          return writeJson(res, 200, { run: cancelled, cancelled: true });
        }
        const failed = error.code === "MIA_BRIDGE_TIMEOUT"
          ? cloudStore.timeoutBridgeRun(auth.user.id, bridgeRun.id, error.message || "本机 Agent 响应超时。")
          : cloudStore.failBridgeRun(auth.user.id, bridgeRun.id, error.message || "本机 Agent 执行失败。");
        broadcastTransientEvent(context.eventHub, auth.user.id, { type: "bridge_run_updated", run: failed });
        return writeError(res, 500, error.message || "本机 Agent 执行失败。");
      }
    }

    if (req.method === "POST" && url.pathname === "/api/files") {
      const body = await readJson(req);
      const file = cloudStore.saveImageDataUrl(auth.user.id, { name: body.name, dataUrl: body.dataUrl });
      return writeJson(res, 201, { file: clientFile(file) });
    }

    // ---- Skill marketplace registry (sub-project B) ----
    if (req.method === "GET" && url.pathname === "/api/skills") {
      const category = url.searchParams.get("category") || "";
      const q = url.searchParams.get("q") || "";
      const requestedLimit = Number(url.searchParams.get("limit") || DEFAULT_SKILL_MARKET_LIMIT);
      const limit = Math.min(Math.max(Math.floor(Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_SKILL_MARKET_LIMIT), 1), MAX_SKILL_MARKET_LIMIT);
      const localSkills = context.skillsStore.listSkills({ category, q, limit });
      let remote = { skills: [], categories: [] };
      if (context.hermesSkillsSource) {
        remote = await context.hermesSkillsSource.listSkills({ category, q, limit }).catch(() => remote);
      }
      const skills = [...localSkills, ...(remote.skills || [])].slice(0, limit);
      const categories = mergeCategoryCounts(context.skillsStore.listCategories(), remote.categories);
      return writeJson(res, 200, { skills, categories });
    }
    // Open publish: any signed-in user can publish a packaged skill version.
    if (req.method === "POST" && url.pathname === "/api/skills") {
      const pubBody = await readJson(req).catch(() => ({}));
      const name = String(pubBody?.name || "").trim();
      const packageBase64 = String(pubBody?.packageBase64 || "");
      if (!name || !packageBase64) return writeError(res, 400, "name and packageBase64 required.");
      const username = auth.user.username || auth.user.id;
      const ownerNamespace = `${skillSafety.slugify(username)}.`;
      const requestedId = String(pubBody?.id || "").trim();
      const requestedNamespacedId = requestedId.includes(".");
      if (requestedNamespacedId && !requestedId.startsWith(ownerNamespace)) {
        return writeError(res, 403, "你不是这个技能的拥有者。");
      }
      const id = requestedNamespacedId ? requestedId : `${ownerNamespace}${skillSafety.slugify(name)}`;
      if (!skillSafety.isSafeId(id)) return writeError(res, 400, "invalid skill name.");
      const existing = context.skillsStore.getSkill(id);
      if (existing && existing.ownerUserId !== auth.user.id) {
        // also blocks taking over a null-owner (official/seeded) listing
        return writeError(res, 403, "你不是这个技能的拥有者。");
      }
      if (!existing && context.skillsStore.countByOwner(auth.user.id) >= 50) {
        return writeError(res, 429, "已达到发布数量上限。");
      }
      const zipBuffer = Buffer.from(packageBase64, "base64");
      if (zipBuffer.length > 25 * 1024 * 1024) return writeError(res, 413, "package too large.");
      try {
        const skill = context.skillsStore.publishVersion({
          id,
          ownerUserId: auth.user.id,
          ownerLabel: username,
          name,
          category: String(pubBody?.category || "uncategorized"),
          description: String(pubBody?.description || ""),
          version: String(pubBody?.version || "1.0.0"),
          zipBuffer,
          changelog: String(pubBody?.changelog || "")
        });
        return writeJson(res, 201, { skill });
      } catch (error) {
        return writeError(res, 400, error.message || "publish failed.");
      }
    }
    const hermesSkillPackageMatch = url.pathname.match(/^\/api\/hermes-skills\/([A-Za-z0-9._-]+)\/package\/([a-f0-9]{64})\.zip$/);
    if (req.method === "GET" && hermesSkillPackageMatch) {
      const absPath = context.hermesSkillsSource?.packageAbsPath?.(hermesSkillPackageMatch[1], hermesSkillPackageMatch[2]) || "";
      if (!absPath || !fs.existsSync(absPath)) return writeError(res, 404, "Package not found.");
      const buf = fs.readFileSync(absPath);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": buf.length,
        "X-Skill-Checksum": hermesSkillPackageMatch[2]
      });
      return res.end(buf);
    }
    const skillPackageMatch = url.pathname.match(/^\/api\/skills\/([A-Za-z0-9._-]+)\/versions\/([A-Za-z0-9._-]+)\/package$/);
    if (req.method === "GET" && skillPackageMatch) {
      const version = context.skillsStore.getVersion(skillPackageMatch[1], skillPackageMatch[2]);
      const absPath = version ? context.skillsStore.packageAbsPath(version) : "";
      if (!absPath || !fs.existsSync(absPath)) return writeError(res, 404, "Package not found.");
      const buf = fs.readFileSync(absPath);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": buf.length,
        "X-Skill-Checksum": version.checksum
      });
      return res.end(buf);
    }
    const skillInstallMatch = url.pathname.match(/^\/api\/skills\/([A-Za-z0-9._-]+)\/install$/);
    if (req.method === "POST" && skillInstallMatch) {
      if (context.hermesSkillsSource && String(skillInstallMatch[1]).startsWith("hermes.")) {
        const prepared = await context.hermesSkillsSource.prepareInstall(skillInstallMatch[1]).catch(() => null);
        if (prepared) return writeJson(res, 200, { skill: prepared.skill, download: prepared.download });
      }
      const skill = context.skillsStore.recordInstall(skillInstallMatch[1], auth.user.id);
      if (!skill) return writeError(res, 404, "Skill not found.");
      const download = skill.version ? {
        version: skill.version.version,
        url: `/api/skills/${encodeURIComponent(skill.id)}/versions/${encodeURIComponent(skill.version.version)}/package`,
        checksum: skill.version.checksum,
        entryPath: skill.version.entryPath
      } : null;
      return writeJson(res, 200, { skill, download });
    }
    const skillReportMatch = url.pathname.match(/^\/api\/skills\/([A-Za-z0-9._-]+)\/report$/);
    if (req.method === "POST" && skillReportMatch) {
      const reportBody = await readJson(req).catch(() => ({}));
      const reportId = context.skillsStore.report(skillReportMatch[1], auth.user.id, reportBody?.reason || "");
      if (!reportId) return writeError(res, 404, "Skill not found.");
      return writeJson(res, 200, { reportId });
    }
    const skillDetailMatch = url.pathname.match(/^\/api\/skills\/([A-Za-z0-9._-]+)$/);
    if (req.method === "GET" && skillDetailMatch) {
      const skill = context.skillsStore.getSkill(skillDetailMatch[1]);
      if (!skill) return writeError(res, 404, "Skill not found.");
      return writeJson(res, 200, { skill });
    }

    writeError(res, 404, "Not found.");
  } catch (error) {
    const message = error.message || "Internal error.";
    if (error.code === "MIA_INVALID_JSON") return writeError(res, 400, message);
    if (error.code === "MIA_BODY_TOO_LARGE") return writeError(res, 413, message);
    if (/账号已存在/.test(message)) return writeError(res, 409, message);
    if (/登录尝试过多/.test(message)) return writeError(res, 429, message);
    if (/用户名或密码不正确/.test(message)) return writeError(res, 401, message);
    if (/用户名需要|密码至少|Invalid image|Unsupported image/.test(message)) return writeError(res, 400, message);
    writeError(res, 500, message);
  }
}

function handleBridgeUpgrade(req, socket, head, context, wss) {
  const cloudStore = context.cloudStore;
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname !== "/api/bridge" && url.pathname !== "/api/events") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!requestOriginAllowed(req, context)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const token = tokenFromWebSocketProtocol(req)
    || (context.allowQueryTokenAuth ? url.searchParams.get("token") : "");
  const auth = cloudStore.authenticateToken(token);
  if (!auth) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === "/api/events") {
      const sinceSeq = Number(url.searchParams.get("since_seq") || 0);
      attachEventSocket(context.eventHub, ws, auth.user.id, { eventLog: context.eventLog, sinceSeq });
      return;
    }
    attachBridgeDevice(context.bridgeHub, ws, {
      userId: auth.user.id,
      deviceName: url.searchParams.get("deviceName"),
      engine: url.searchParams.get("engine"),
      capabilities: parseJson(url.searchParams.get("capabilities"), {}),
      cloudStore,
      eventHub: context.eventHub
    });
    broadcastTransientEvent(context.eventHub, auth.user.id, { type: "device_updated", devices: bridgeDevices(context.bridgeHub, auth.user.id) });
  });
}

function createMiaCloudServer(options = {}) {
  const storePaths = createStore(options.dataDir || defaultDataDir);
  const context = {
    store: storePaths,
    cloudStore: options.cloudStore || createCloudStore(storePaths),
    bridgeHub: createBridgeHub(options.bridgeRunTimeoutMs || bridgeRunTimeoutMs),
    eventHub: createEventHub(),
    allowedOrigins: allowedOriginsFromOptions(options),
    allowQueryTokenAuth: Boolean(options.allowQueryTokenAuth || process.env.MIA_CLOUD_ALLOW_QUERY_TOKEN === "1"),
    webRoot: options.webRoot || defaultWebRoot(),
    releaseManifest: options.releaseManifest === undefined ? defaultReleaseManifest() : options.releaseManifest,
    socialStore: null,
    messagesStore: null,
    runtimeBindingsStore: null,
    cloudAgentRunsStore: null,
    cloudAgentDispatcher: null,
    hermesSkillsSource: null
  };
  context.socialStore = createSocialStore(context.cloudStore.getDb());
  context.messagesStore = createMessagesStore(context.cloudStore.getDb());
  context.eventLog = createEventLogStore(context.cloudStore.getDb());
  context.botsStore = createBotsStore(context.cloudStore.getDb());
  context.skillsStore = createSkillsStore(context.cloudStore.getDb(), {
    uploadDir: context.cloudStore.uploadDir,
    dataDir: context.cloudStore.dataDir
  });
  context.skillsStore.backfillBodyVersions();
  context.skillsStore.seedFromCatalog(loadSkillsCatalog());
  const hermesSkillsEnabled = options.hermesSkillsSource
    || options.hermesSkillsMarketEnabled === true
    || (options.hermesSkillsMarketEnabled !== false && process.env.MIA_HERMES_SKILLS_MARKET !== "0");
  context.hermesSkillsSource = options.hermesSkillsSource
    || (hermesSkillsEnabled && createHermesSkillsSource
      ? createHermesSkillsSource({ dataDir: context.cloudStore.dataDir })
      : null);
  context.runtimeBindingsStore = createRuntimeBindingsStore(context.cloudStore.getDb());
  context.cloudAgentRunsStore = createCloudAgentRunsStore(context.cloudStore.getDb());
  if (options.cloudAgentWorkerManager && options.cloudAgentHermesClient && createCloudAgentDispatcher) {
    context.cloudAgentDispatcher = createCloudAgentDispatcher({
      socialStore: context.socialStore,
      messagesStore: context.messagesStore,
      botsStore: context.botsStore,
      runtimeBindingsStore: context.runtimeBindingsStore,
      cloudAgentRunsStore: context.cloudAgentRunsStore,
      workerManager: options.cloudAgentWorkerManager,
      hermesRunsClient: options.cloudAgentHermesClient,
      attachmentMaterializer: createAttachmentMaterializer
        ? createAttachmentMaterializer({ cloudStore: context.cloudStore })
        : null,
      broadcastPersistedEvent: (userId, payload) => broadcastPersistedEvent(context, userId, payload),
      broadcastTransientEvent: (userId, payload) => broadcastTransientEvent(context.eventHub, userId, payload),
      getUserPublic: (userId) => context.cloudStore.getUserPublic(userId)
    });
  }
  // Inject botsStore so listConversationMembers can enrich bot members
  // with name/avatar from the owner's bot definitions in one shot.
  context.socialStore._attachBotsStore?.(context.botsStore);
  // Hourly purge of stale idempotency cache rows (Phase 1.D). Without
  // this the table grows monotonically. Default cutoff 24h matches the
  // store helper's default; tunable via env if pathological retries
  // ever require a larger window.
  context.eventLogPurgeTimer = setInterval(() => {
    try { context.eventLog.purgeStaleOps(); } catch (err) {
      console.warn("[event-log] purgeStaleOps failed:", err?.message || err);
    }
  }, 60 * 60 * 1000);
  if (context.eventLogPurgeTimer.unref) context.eventLogPurgeTimer.unref();
  context.userSettingsStore = createUserSettingsStore(context.cloudStore.getDb());
  const server = http.createServer((req, res) => handleRequest(req, res, context));
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => handleBridgeUpgrade(req, socket, head, context, wss));
  server.on("close", () => context.cloudStore.close?.());
  server.mia = context;
  return server;
}

if (require.main === module) {
  const server = createMiaCloudServer();
  server.listen(port, host, () => {
    console.log(`Mia Cloud API listening on http://${host}:${port}`);
  });
}

module.exports = {
  createMiaCloudServer,
  sanitizeMessageSkills
};
