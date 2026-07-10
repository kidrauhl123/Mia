#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const readline = require("node:readline");

const SCHEDULE_TOOLS = new Set([
  "schedule_create",
  "schedule_list",
  "schedule_update",
  "schedule_delete",
  "schedule_pause",
  "schedule_resume"
]);

const APP_TOOLS = new Set([
  ...SCHEDULE_TOOLS,
  "context_snapshot",
  "memory_search",
  "memory_list",
  "memory_remember",
  "memory_update",
  "memory_forget",
  "skill_list_current",
  "skill_read_current",
  "skill_search",
  "skill_show",
  "skill_install"
]);

const VALID_MEMORY_SCOPES = new Set(["user", "bot", "session"]);
const READ_TOOLS = new Set([
  "schedule_list",
  "context_snapshot",
  "memory_search",
  "memory_list",
  "skill_list_current",
  "skill_read_current",
  "skill_search",
  "skill_show"
]);
const WRITE_TOOLS = new Set([
  "schedule_create",
  "schedule_update",
  "schedule_delete",
  "schedule_pause",
  "schedule_resume",
  "memory_remember",
  "memory_update",
  "memory_forget",
  "skill_install"
]);
const DESTRUCTIVE_TOOLS = new Set(["schedule_delete", "memory_forget"]);

function envOf(options = {}) {
  return options.env || process.env;
}

function cleanText(value = "") {
  return String(value || "").trim();
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function queryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

function permissionClassForTool(name = "") {
  if (READ_TOOLS.has(name)) return "read";
  if (WRITE_TOOLS.has(name)) return "write";
  return "unknown";
}

function withToolAnnotations(tool) {
  const permission = permissionClassForTool(tool.name);
  return {
    ...tool,
    annotations: {
      readOnlyHint: permission === "read",
      destructiveHint: DESTRUCTIVE_TOOLS.has(tool.name),
      idempotentHint: permission === "read" || DESTRUCTIVE_TOOLS.has(tool.name),
      openWorldHint: false
    }
  };
}

function cloudToolDefinitions() {
  return [
    { name: "schedule_create", description: "Create a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "schedule_list", description: "List Mia scheduled tasks.", inputSchema: { type: "object" } },
    { name: "schedule_update", description: "Update a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "schedule_delete", description: "Delete a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "schedule_pause", description: "Pause a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "schedule_resume", description: "Resume a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "context_snapshot", description: "Read current Mia bot/session metadata.", inputSchema: { type: "object" } },
    {
      name: "memory_search",
      description: "Search Mia-owned scoped memories visible to the current bot and conversation.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
          scopes: { type: "array", items: { type: "string", enum: ["user", "bot", "session"] } }
        }
      }
    },
    {
      name: "memory_list",
      description: "List recent Mia-owned memories visible to the current bot and conversation.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          scopes: { type: "array", items: { type: "string", enum: ["user", "bot", "session"] } }
        }
      }
    },
    {
      name: "memory_remember",
      description: "Store a new durable scoped memory for the current bot/session.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          scope: { type: "string", enum: ["user", "bot", "session"] },
          confidence: { type: "number" },
          priority: { type: "number" },
          reason: { type: "string" },
          sourceMessageIds: { type: "array", items: { type: "string" } },
          linkedMemoryIds: { type: "array", items: { type: "string" } },
          metadata: { type: "object" }
        },
        required: ["text"]
      }
    },
    {
      name: "memory_update",
      description: "Replace an existing visible Mia memory by id or matching text.",
      inputSchema: {
        type: "object",
        properties: {
          memoryId: { type: "string" },
          oldText: { type: "string" },
          text: { type: "string" },
          scope: { type: "string", enum: ["user", "bot", "session"] },
          confidence: { type: "number" },
          priority: { type: "number" },
          reason: { type: "string" },
          metadata: { type: "object" }
        },
        required: ["text"]
      }
    },
    {
      name: "memory_forget",
      description: "Delete an existing visible Mia memory by id or matching text.",
      inputSchema: {
        type: "object",
        properties: {
          memoryId: { type: "string" },
          oldText: { type: "string" },
          scope: { type: "string", enum: ["user", "bot", "session"] },
          reason: { type: "string" }
        }
      }
    },
    { name: "skill_list_current", description: "List skills enabled for the current Mia bot.", inputSchema: { type: "object" } },
    {
      name: "skill_read_current",
      description: "Read the full guide for a skill enabled on the current Mia bot.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      }
    },
    { name: "skill_search", description: "Search Mia skill marketplace.", inputSchema: { type: "object" } },
    { name: "skill_show", description: "Show Mia skill details.", inputSchema: { type: "object" } },
    { name: "skill_install", description: "Install a Mia skill for the current user.", inputSchema: { type: "object" } }
  ].map(withToolAnnotations);
}

function readContext(options = {}) {
  const env = envOf(options);
  const contextFile = cleanText(options.contextPath || env.MIA_CLOUD_MCP_CONTEXT_FILE || "");
  if (!contextFile) return {};
  try {
    return JSON.parse(fs.readFileSync(contextFile, "utf8"));
  } catch {
    return {};
  }
}

function cloudUrl(options = {}) {
  const env = envOf(options);
  return cleanText(options.cloudUrl || env.MIA_CLOUD_URL || env.MIA_CLOUD_MCP_URL || "").replace(/\/$/, "");
}

function cloudToken(options = {}) {
  const env = envOf(options);
  return cleanText(options.cloudToken || env.MIA_CLOUD_TOKEN || "");
}

function hasCloudApi(options = {}) {
  return Boolean(cloudUrl(options) && cloudToken(options));
}

function requireCloudApi(options = {}) {
  if (!hasCloudApi(options)) {
    throw new Error("MIA_CLOUD_URL and MIA_CLOUD_TOKEN are required for this cloud Mia MCP tool");
  }
}

function cloudFetch(method, urlPath, body, options = {}) {
  requireCloudApi(options);
  return new Promise((resolve, reject) => {
    const parsed = new URL(`${cloudUrl(options)}${urlPath}`);
    const transport = parsed.protocol === "https:" ? https : http;
    const bodyStr = body == null ? null : JSON.stringify(body);
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        Authorization: `Bearer ${cloudToken(options)}`,
        "Content-Type": "application/json",
        ...(bodyStr == null ? {} : { "Content-Length": Buffer.byteLength(bodyStr) })
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsedBody = {};
        try {
          parsedBody = text ? JSON.parse(text) : {};
        } catch {
          parsedBody = { text };
        }
        resolve({ status: res.statusCode || 0, body: parsedBody });
      });
    });
    req.on("error", reject);
    if (bodyStr != null) req.write(bodyStr);
    req.end();
  });
}

async function cloudJson(method, urlPath, body, options = {}) {
  const response = await cloudFetch(method, urlPath, body, options);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(response.body?.error || `Mia Cloud returned ${response.status}`);
  }
  return response.body;
}

function randomMemoryId() {
  return `mem_${crypto.randomBytes(12).toString("base64url")}`;
}

function normalizeScope(value = "", fallback = "bot") {
  const scope = cleanText(value).toLowerCase();
  return VALID_MEMORY_SCOPES.has(scope) ? scope : fallback;
}

function requestedScopes(args = {}) {
  const raw = Array.isArray(args.scopes) ? args.scopes : (args.scope ? [args.scope] : []);
  const out = [];
  for (const item of raw) {
    const scope = normalizeScope(item, "");
    if (scope && !out.includes(scope)) out.push(scope);
  }
  return out.length ? out : ["user", "bot", "session"];
}

function contextMemoryVisible(ctx = {}, memory = {}, scopes = []) {
  const scope = normalizeScope(memory.scope, "bot");
  if (!scopes.includes(scope)) return false;
  if (scope === "bot" && ctx.botId && memory.botId && memory.botId !== ctx.botId) return false;
  if (scope === "session") {
    const sessionId = cleanText(ctx.sessionId || ctx.conversationId || "");
    if (sessionId && memory.sessionId && memory.sessionId !== sessionId) return false;
  }
  return true;
}

function contextMemorySearch(ctx = {}, args = {}) {
  const limit = clampNumber(args.limit, 1, 100, 36);
  const query = cleanText(args.query || args.q || "").toLowerCase();
  const scopes = requestedScopes(args);
  const memories = Array.isArray(ctx.memories) ? ctx.memories : [];
  return {
    memories: memories
      .filter((memory) => contextMemoryVisible(ctx, memory, scopes))
      .filter((memory) => !query || cleanText(memory.text).toLowerCase().includes(query))
      .slice(0, limit)
  };
}

function memoryQueryForScope(ctx = {}, scope = "bot", args = {}) {
  const sessionId = cleanText(ctx.sessionId || ctx.conversationId || "");
  const botId = cleanText(ctx.botId || "");
  return {
    scope,
    q: args.query || args.q || "",
    limit: clampNumber(args.limit, 1, 100, 36),
    ...(scope === "bot" || scope === "session" ? { botId } : {}),
    ...(scope === "session" ? { sessionId } : {})
  };
}

async function cloudMemorySearch(ctx = {}, args = {}, options = {}) {
  const seen = new Set();
  const memories = [];
  for (const scope of requestedScopes(args)) {
    const params = memoryQueryForScope(ctx, scope, args);
    const body = await cloudJson("GET", `/api/me/memory${queryString(params)}`, null, options);
    for (const memory of Array.isArray(body.memories) ? body.memories : []) {
      const id = cleanText(memory.id);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      memories.push(memory);
    }
  }
  return { memories };
}

function memorySearch(ctx = {}, args = {}, options = {}) {
  return hasCloudApi(options)
    ? cloudMemorySearch(ctx, args, options)
    : Promise.resolve(contextMemorySearch(ctx, args));
}

function memoryPayload(args = {}, ctx = {}) {
  const scope = normalizeScope(args.scope, "bot");
  const botId = cleanText(ctx.botId || args.botId || "");
  const sessionId = cleanText(ctx.sessionId || ctx.conversationId || args.sessionId || "");
  return {
    text: cleanText(args.text),
    scope,
    confidence: Number.isFinite(Number(args.confidence)) ? Number(args.confidence) : 1,
    priority: Number.isFinite(Number(args.priority)) ? Math.trunc(Number(args.priority)) : 0,
    source: "mia-cloud-mcp",
    sourceMessageIds: Array.isArray(args.sourceMessageIds)
      ? args.sourceMessageIds.map(cleanText).filter(Boolean)
      : (ctx.originMessageId ? [ctx.originMessageId] : []),
    linkedMemoryIds: Array.isArray(args.linkedMemoryIds)
      ? args.linkedMemoryIds.map(cleanText).filter(Boolean)
      : [],
    metadata: args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)
      ? args.metadata
      : {},
    ...(scope === "bot" || scope === "session" ? { botId } : {}),
    ...(scope === "session" ? { sessionId } : {})
  };
}

async function resolveMemoryId(args = {}, ctx = {}, options = {}) {
  const explicit = cleanText(args.memoryId || args.id || "");
  if (explicit) return explicit;
  const oldText = cleanText(args.oldText || args.old_text || "");
  if (!oldText) throw new Error("memoryId or oldText is required");
  const result = await memorySearch(ctx, { query: oldText, scope: args.scope, limit: 10 }, options);
  const needle = oldText.toLowerCase();
  const match = (result.memories || []).find((memory) => cleanText(memory.text).toLowerCase().includes(needle));
  if (!match?.id) throw new Error("memory not found");
  return match.id;
}

function skillAliases(skill = {}) {
  const id = cleanText(skill.id || "");
  const name = cleanText(skill.name || skill.name_zh || "");
  return new Set([id, name, id && `mia:${id}`, id && id.split(":").pop()].filter(Boolean));
}

function contextSkills(ctx = {}) {
  const enabled = new Set((Array.isArray(ctx.enabledSkillIds) ? ctx.enabledSkillIds : []).map(cleanText).filter(Boolean));
  const skills = Array.isArray(ctx.skills) ? ctx.skills : [];
  return enabled.size
    ? skills.filter((skill) => enabled.has(cleanText(skill.id)) || enabled.has(cleanText(skill.id).split(":").pop()))
    : skills;
}

function findContextSkill(ctx = {}, rawId = "") {
  const wanted = cleanText(rawId);
  if (!wanted) return null;
  const normalized = wanted.replace(/^mia:/, "");
  return contextSkills(ctx).find((skill) => {
    const aliases = skillAliases(skill);
    return aliases.has(wanted) || aliases.has(normalized);
  }) || null;
}

function contextSkillList(ctx = {}) {
  return {
    skills: contextSkills(ctx).map((skill) => ({
      id: cleanText(skill.id),
      name: cleanText(skill.name || skill.name_zh || skill.id),
      description: cleanText(skill.description || "")
    }))
  };
}

function contextSkillSearch(ctx = {}, args = {}) {
  const limit = clampNumber(args.limit, 1, 100, 20);
  const query = cleanText(args.query || args.q || "").toLowerCase();
  return {
    skills: contextSkills(ctx)
      .filter((skill) => !query || [
        skill.id,
        skill.name,
        skill.name_zh,
        skill.description,
        skill.body
      ].some((value) => cleanText(value).toLowerCase().includes(query)))
      .slice(0, limit)
  };
}

function taskPayload(args = {}, ctx = {}) {
  const payload = {
    title: args.title || "未命名任务",
    botId: cleanText(ctx.botId || args.botId || ""),
    conversationId: cleanText(ctx.conversationId || ctx.sessionId || args.conversationId || args.sessionId || ""),
    sessionId: cleanText(ctx.sessionId || ctx.conversationId || args.sessionId || args.conversationId || ""),
    originMessageId: cleanText(ctx.originMessageId || args.originMessageId || ""),
    timezone: args.timezone || "Asia/Shanghai",
    fireMode: args.fireMode,
    deliveryText: args.deliveryText,
    prompt: args.prompt
  };
  if (Object.prototype.hasOwnProperty.call(args, "schedule")) payload.schedule = args.schedule;
  if (Object.prototype.hasOwnProperty.call(args, "trigger")) payload.trigger = args.trigger;
  return payload;
}

function taskPatch(args = {}) {
  const patch = {};
  for (const key of ["title", "schedule", "trigger", "timezone", "fireMode", "deliveryText", "prompt"]) {
    if (Object.prototype.hasOwnProperty.call(args, key)) patch[key] = args[key];
  }
  return patch;
}

function toolDefinitionsForMode(mode = "app") {
  const wanted = cleanText(mode) === "scheduler" ? SCHEDULE_TOOLS : APP_TOOLS;
  return cloudToolDefinitions().filter((tool) => wanted.has(tool.name));
}

async function callTool(name, args = {}, options = {}) {
  const ctx = readContext(options);
  switch (name) {
    case "context_snapshot":
      return {
        userId: cleanText(ctx.userId || ""),
        botId: cleanText(ctx.botId || ""),
        conversationId: cleanText(ctx.conversationId || ""),
        sessionId: cleanText(ctx.sessionId || ctx.conversationId || ""),
        originMessageId: cleanText(ctx.originMessageId || ""),
        enabledSkillIds: Array.isArray(ctx.enabledSkillIds) ? ctx.enabledSkillIds : [],
        memoryCount: Array.isArray(ctx.memories) ? ctx.memories.length : 0,
        skillCount: Array.isArray(ctx.skills) ? ctx.skills.length : 0
      };

    case "memory_search":
      return memorySearch(ctx, args, options);

    case "memory_list":
      return memorySearch(ctx, { ...args, query: "" }, options);

    case "memory_remember": {
      if (!cleanText(args.text)) throw new Error("text is required");
      const id = cleanText(args.id || args.memoryId || "") || randomMemoryId();
      return cloudJson("PUT", `/api/me/memory/${encodeURIComponent(id)}`, {
        ...memoryPayload(args, ctx),
        id,
        force: args.force === true
      }, options);
    }

    case "memory_update": {
      if (!cleanText(args.text)) throw new Error("text is required");
      const id = await resolveMemoryId(args, ctx, options);
      return cloudJson("PUT", `/api/me/memory/${encodeURIComponent(id)}`, {
        ...memoryPayload(args, ctx),
        id,
        force: args.force === true
      }, options);
    }

    case "memory_forget": {
      const id = await resolveMemoryId(args, ctx, options);
      return cloudJson("DELETE", `/api/me/memory/${encodeURIComponent(id)}`, {
        reason: args.reason || ""
      }, options);
    }

    case "skill_list_current":
      return contextSkillList(ctx);

    case "skill_read_current": {
      const skill = findContextSkill(ctx, args.id);
      if (!skill) throw new Error("skill is not enabled for the current bot");
      return { skill };
    }

    case "skill_search":
      return hasCloudApi(options)
        ? cloudJson("GET", `/api/skills${queryString({ q: args.query || args.q || "", category: args.category, limit: args.limit })}`, null, options)
        : contextSkillSearch(ctx, args);

    case "skill_show": {
      if (!args.id) throw new Error("id is required");
      if (hasCloudApi(options)) return cloudJson("GET", `/api/skills/${encodeURIComponent(args.id)}`, null, options);
      const skill = findContextSkill(ctx, args.id);
      if (!skill) throw new Error("skill not found");
      return { skill };
    }

    case "skill_install":
      if (!args.id) throw new Error("id is required");
      return cloudJson("POST", `/api/skills/${encodeURIComponent(args.id)}/install`, {}, options);

    case "schedule_create": {
      const created = await cloudJson("POST", "/api/tasks", taskPayload(args, ctx), options);
      const task = created.task || created;
      return { taskId: task?.id || "", task };
    }

    case "schedule_list":
      return cloudJson("GET", "/api/tasks", null, options);

    case "schedule_update": {
      const id = cleanText(args.id || args.taskId || "");
      if (!id) throw new Error("id is required");
      return cloudJson("PATCH", `/api/tasks/${encodeURIComponent(id)}`, taskPatch(args), options);
    }

    case "schedule_delete": {
      const id = cleanText(args.id || args.taskId || "");
      if (!id) throw new Error("id is required");
      return cloudJson("DELETE", `/api/tasks/${encodeURIComponent(id)}`, null, options);
    }

    case "schedule_pause": {
      const id = cleanText(args.id || args.taskId || "");
      if (!id) throw new Error("id is required");
      return cloudJson("POST", `/api/tasks/${encodeURIComponent(id)}/pause`, {}, options);
    }

    case "schedule_resume": {
      const id = cleanText(args.id || args.taskId || "");
      if (!id) throw new Error("id is required");
      return cloudJson("POST", `/api/tasks/${encodeURIComponent(id)}/resume`, {}, options);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function sendResponse(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handleRequest(req, options = {}) {
  const { id, method, params } = req;
  const env = envOf(options);
  const mode = cleanText(options.mode || env.MIA_CLOUD_MCP_MODE || "app");
  if (method === "initialize") {
    sendResponse({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: mode === "scheduler" ? "mia-scheduler" : "mia-app", version: "0.1.0" }
      }
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    sendResponse({ jsonrpc: "2.0", id, result: { tools: toolDefinitionsForMode(mode) } });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await callTool(params?.name, params?.arguments || {}, options);
      sendResponse({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false
        }
      });
    } catch (error) {
      sendResponse({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true
        }
      });
    }
    return;
  }
  sendResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

function startServer() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      await handleRequest(JSON.parse(line));
    } catch (error) {
      sendResponse({ jsonrpc: "2.0", id: null, error: { code: -32603, message: error.message } });
    }
  });
}

if (require.main === module) startServer();

module.exports = {
  callTool,
  handleRequest,
  readContext,
  toolDefinitionsForMode
};
