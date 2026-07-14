"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  miaRuntimeSystemPrompt,
  sanitizeMiaMemorySpoof
} = require("../main/mia-runtime-context.js");
const { ENTRY_SEPARATOR } = require("../cloud/memory-document-store.js");
const { resolveEffectiveSkillIds } = require("../../packages/shared/skill-defaults.js");

const ENGINE_IDENTITY_NAMES = ["Claude Code", "Codex", "Hermes"];
const CLOUD_MIA_MCP_SCRIPT = path.join(__dirname, "mia-cloud-mcp-server.js");
const RESERVED_MIA_MCP_NAMES = new Set(["mia-app", "mia-scheduler"]);

function cleanText(value = "") {
  return String(value || "").trim();
}

function safePathSegment(value = "", fallback = "default") {
  const text = cleanText(value).toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return text || fallback;
}

function materializeNativeCloudSkills({ worker = {}, botId = "", conversationId = "", skills = [] } = {}) {
  const workspace = cleanText(worker?.paths?.workspace || "");
  if (!workspace) return { runtimeCwd: "", nativeSkillNames: [], additionalDirectories: [] };
  const runtimeCwd = path.join(
    workspace,
    ".mia-agent-sessions",
    safePathSegment(botId, "bot"),
    safePathSegment(conversationId, "conversation")
  );
  const skillsRoot = path.join(runtimeCwd, ".claude", "skills");
  fs.rmSync(skillsRoot, { recursive: true, force: true });
  const nativeSkillNames = [];
  for (const skill of Array.isArray(skills) ? skills : []) {
    const body = cleanText(skill?.body || "");
    if (!body) continue;
    const name = safePathSegment(cleanText(skill?.id || skill?.name || ""), "");
    if (!name || nativeSkillNames.includes(name)) continue;
    const dir = path.join(skillsRoot, name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `${body}\n`, { mode: 0o600 });
    nativeSkillNames.push(name);
  }
  fs.mkdirSync(runtimeCwd, { recursive: true, mode: 0o700 });
  return {
    runtimeCwd,
    nativeSkillNames,
    additionalDirectories: runtimeCwd === workspace ? [] : [workspace]
  };
}

function botDisplayName(bot = {}) {
  return bot?.displayName || bot?.display_name || bot?.name || "";
}

function normalizedIdentityName(value = "") {
  return cleanText(value).toLowerCase().replace(/[\s_-]+/g, " ");
}

function escapeRegExp(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripCopiedEngineIdentity(persona = "", bot = {}) {
  let text = cleanText(persona);
  if (!text) return "";
  const botName = normalizedIdentityName(botDisplayName(bot) || bot?.id || bot?.key || "");
  for (const engineName of ENGINE_IDENTITY_NAMES) {
    if (normalizedIdentityName(engineName) === botName) continue;
    const escaped = escapeRegExp(engineName).replace(/\s+/g, "\\s+");
    text = text
      .replace(new RegExp(`^\\s*(?:你是|你叫|你的名字是)\\s*${escaped}\\s*[。.!！]?\\s*`, "i"), "")
      .replace(new RegExp(`^\\s*(?:You are|Your name is)\\s+${escaped}\\s*[。.!！]?\\s*`, "i"), "");
  }
  return text.trim();
}

function isScheduledFireMessage(message = {}) {
  return String(message.turn_id || message.turnId || "").startsWith("task:");
}

function botIdentityInstructions(bot = {}) {
  const name = cleanText(botDisplayName(bot) || bot?.id || bot?.key || "Bot");
  const id = cleanText(bot?.id || bot?.key || "");
  return [
    `你是 ${name}，Mia 里的 Bot。`,
    id && id !== name ? `你的 Bot ID 是 ${id}。` : "",
    `当用户询问你的名字、身份或“你是谁”时，请回答你是 ${name}。`
  ].filter(Boolean).join("\n");
}

function cloudRuntimeInstructions(bot, message = {}) {
  const persona = stripCopiedEngineIdentity(bot?.personaText || bot?.persona_text || "", bot);
  return [
    miaRuntimeSystemPrompt({ scheduledFire: isScheduledFireMessage(message) }),
    persona,
    botIdentityInstructions(bot)
  ].filter(Boolean).join("\n\n");
}

function selectedSkillIdsFromMessage(message = {}) {
  let parsed = null;
  try {
    parsed = JSON.parse(message?.skills_json || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids = [];
  const seen = new Set();
  for (const skill of parsed) {
    if (ids.length >= 8) break;
    const raw = typeof skill === "string" ? skill : (skill && typeof skill.id === "string" ? skill.id : "");
    const id = cleanText(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function skillRecordsFromCatalog(skillsCatalog = []) {
  return (Array.isArray(skillsCatalog) ? skillsCatalog : []).map((skill) => ({
    id: cleanText(skill?.id || ""),
    name: cleanText(skill?.name || skill?.name_zh || skill?.id || ""),
    description: cleanText(skill?.description || ""),
    body: cleanText(skill?.body || "")
  }));
}

function skillCatalogLookup(records = []) {
  const map = new Map();
  for (const skill of Array.isArray(records) ? records : []) {
    if (!skill?.id && !skill?.name) continue;
    const id = cleanText(skill.id || skill.name || "");
    const name = cleanText(skill.name || id);
    for (const key of [id, name, id && `mia:${id}`, id && `mia-official:${id}`, id && id.split(":").pop()]) {
      const alias = cleanText(key);
      if (alias && !map.has(alias)) map.set(alias, skill);
    }
  }
  return map;
}

function enabledSkillIds(bot = {}) {
  return resolveEffectiveSkillIds(bot?.capabilities || {});
}

function cloudSkillMaterialization({ bot = {}, message = {}, skillsCatalog = [], requestedSkillIds = [] } = {}) {
  const records = skillRecordsFromCatalog(skillsCatalog);
  const lookup = skillCatalogLookup(records);
  const activeSkillIds = selectedSkillIdsFromMessage(message);
  const enabledIds = enabledSkillIds(bot);
  const availableSkills = [];
  const seen = new Set();
  for (const id of [...enabledIds, ...activeSkillIds, ...(Array.isArray(requestedSkillIds) ? requestedSkillIds : [])]) {
    const skill = lookup.get(cleanText(id));
    if (!skill || seen.has(skill.id)) continue;
    seen.add(skill.id);
    availableSkills.push(skill);
  }
  return {
    availableSkills,
    activeSkillIds
  };
}

function splitMemoryDocumentText(text = "") {
  return String(text || "")
    .split(ENTRY_SEPARATOR)
    .map((entry) => sanitizeMiaMemorySpoof(cleanText(entry)))
    .filter(Boolean);
}

function visibleMemoryEntries({ memoryDocumentStore, ownerId = "", botId = "", limit = 36 } = {}) {
  if (!memoryDocumentStore || typeof memoryDocumentStore.listDocuments !== "function") return [];
  const perScopeLimit = Math.max(1, Math.min(120, Math.trunc(Number(limit) || 36)));
  let documents = [];
  try {
    const result = memoryDocumentStore.listDocuments(ownerId, { limit: 500 });
    documents = Array.isArray(result?.documents) ? result.documents : [];
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const document of documents) {
    if (document?.deletedAt) continue;
    const target = cleanText(document?.target || "");
    if (target === "memory" && cleanText(document?.botId || "") !== botId) continue;
    if (target !== "user" && target !== "memory") continue;
    for (const text of splitMemoryDocumentText(document?.text || "")) {
      const key = text.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        scope: target === "user" ? "user" : "bot",
        text
      });
      if (out.length >= perScopeLimit) return out;
    }
  }
  return out;
}

function buildMemoryBlock(entries = []) {
  const rows = (Array.isArray(entries) ? entries : []).filter((entry) => cleanText(entry?.text));
  if (!rows.length) return "";
  return [
    "## Mia Memory",
    "",
    "The following scoped Mia memories are visible to this bot and conversation. Use them as context, but do not quote this section unless the user asks.",
    "",
    ...rows.map((entry) => `- [${entry.scope || "bot"}] ${sanitizeMiaMemorySpoof(entry.text)}`)
  ].join("\n");
}

function objectFromMcpSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function mcpServersFromRuntimeConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const nested = value.mcpServers || value.mcp_servers;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  return {};
}

function isDesktopReservedMcpSpec(name = "", spec = {}) {
  const serverName = cleanText(name);
  if (!RESERVED_MIA_MCP_NAMES.has(serverName)) return false;
  const env = spec && typeof spec.env === "object" && !Array.isArray(spec.env) ? spec.env : {};
  return Boolean(env.MIA_CORE_URL || env.MIA_CORE_TOKEN || env.MIA_SCHEDULER_CONTEXT_FILE || env.MIA_APP_CONTEXT_FILE);
}

function userMcpServersFromRuntimeConfig(runtimeConfig = {}) {
  const out = {};
  for (const [name, spec] of Object.entries(mcpServersFromRuntimeConfig(runtimeConfig))) {
    const serverName = cleanText(name);
    if (!serverName || serverName === "mia-scheduler" || isDesktopReservedMcpSpec(serverName, spec)) continue;
    out[serverName] = spec;
  }
  return out;
}

function resolveCloudBaseUrl(value, context = {}) {
  const resolved = typeof value === "function" ? value(context) : value;
  return cleanText(resolved || process.env.MIA_CLOUD_MCP_URL || process.env.MIA_CLOUD_PUBLIC_URL || process.env.MIA_PUBLIC_URL || "");
}

function resolveCloudSessionToken(createCloudSessionToken, ownerId) {
  if (typeof createCloudSessionToken !== "function") return "";
  try {
    const result = createCloudSessionToken(ownerId);
    return cleanText(result?.token || result);
  } catch {
    return "";
  }
}

function cloudMcpRoot(worker = {}) {
  const paths = worker?.paths || {};
  return cleanText(paths.mcpHome || paths.agentHome || paths.hermesHome || paths.home)
    || path.join(os.tmpdir(), "mia-cloud-mcp");
}

function normalizeMemoryMode(value = "") {
  return cleanText(value || "").toLowerCase() === "native" ? "native" : "mia";
}

function writeCloudMcpContext({ worker = {}, ownerId = "", botId = "", conversationId = "", message = {}, enabledIds = [], skills = [], memoryMode = "mia" } = {}) {
  const dir = path.join(cloudMcpRoot(worker), "mia-cloud-mcp", safePathSegment(ownerId, "user"), safePathSegment(conversationId, "conversation"));
  fs.mkdirSync(dir, { recursive: true });
  const contextPath = path.join(dir, "context.json");
  const payload = {
    userId: ownerId,
    botId,
    conversationId,
    sessionId: conversationId,
    originMessageId: cleanText(message?.id || ""),
    memoryMode: normalizeMemoryMode(memoryMode),
    enabledSkillIds: enabledIds,
    skills,
    generatedAt: new Date().toISOString()
  };
  fs.writeFileSync(contextPath, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  return contextPath;
}

function cloudMiaMcpSpec({ contextPath = "", cloudBaseUrl = "", cloudToken = "", mode = "app" } = {}) {
  const env = {
    MIA_CLOUD_MCP_CONTEXT_FILE: contextPath,
    MIA_CLOUD_MCP_MODE: mode,
    ...(cloudBaseUrl ? { MIA_CLOUD_URL: cloudBaseUrl } : {}),
    ...(cloudToken ? { MIA_CLOUD_TOKEN: cloudToken } : {})
  };
  return {
    type: "stdio",
    command: process.execPath,
    args: [CLOUD_MIA_MCP_SCRIPT],
    env,
    source: "mia-cloud",
    trusted: true
  };
}

function assembleCloudRuntimeTurn(args = {}) {
  const ownerId = cleanText(args.ownerId || args.userId || "");
  const botId = cleanText(args.botId || args.bot?.id || args.bot?.key || "");
  const conversationId = cleanText(args.conversationId || "");
  const memoryMode = normalizeMemoryMode(args.memoryMode || args.memory_mode);
  const requestedSkillIds = Array.isArray(args.requestedSkillIds) ? args.requestedSkillIds : [];
  const skills = cloudSkillMaterialization({
    bot: args.bot,
    message: args.message,
    skillsCatalog: args.skillsCatalog,
    requestedSkillIds
  });
  const memories = visibleMemoryEntries({
    memoryDocumentStore: args.memoryDocumentStore,
    ownerId,
    botId,
    limit: args.memoryLimit
  });
  const memoryBlock = memoryMode === "mia" ? buildMemoryBlock(memories) : "";
  const promptPrefix = memoryMode === "mia" && args.includeMemorySnapshot === true ? memoryBlock : "";
  const nativeSkills = materializeNativeCloudSkills({
    worker: args.worker,
    botId,
    conversationId,
    skills: skills.availableSkills
  });
  const enabledIds = skills.availableSkills.map((skill) => cleanText(skill?.id || "")).filter(Boolean);
  const contextPath = writeCloudMcpContext({
    worker: args.worker,
    ownerId,
    botId,
    conversationId,
    message: args.message,
    enabledIds,
    skills: skills.availableSkills,
    memoryMode
  });
  const cloudBaseUrl = resolveCloudBaseUrl(args.cloudBaseUrl, args);
  const cloudToken = resolveCloudSessionToken(args.createCloudSessionToken, ownerId);
  const mcpServers = {
    ...userMcpServersFromRuntimeConfig(args.runtimeConfig || {}),
    "mia-app": cloudMiaMcpSpec({ contextPath, cloudBaseUrl, cloudToken, mode: "app" })
  };
  const runtimeConfig = {
    ...(args.runtimeConfig && typeof args.runtimeConfig === "object" ? args.runtimeConfig : {}),
    mcpServers
  };
  return {
    instructions: cloudRuntimeInstructions(args.bot, args.message),
    promptPrefix,
    memoryBlock,
    mcpServers,
    runtimeConfig,
    contextPath,
    ...nativeSkills
  };
}

module.exports = {
  assembleCloudRuntimeTurn,
  buildMemoryBlock,
  cloudSkillMaterialization,
  materializeNativeCloudSkills,
  selectedSkillIdsFromMessage,
  visibleMemoryEntries
};
