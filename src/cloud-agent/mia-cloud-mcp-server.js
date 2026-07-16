#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const readline = require("node:readline");
const { fetchPublicPage, searchPublicWeb } = require("./public-web-tools.js");

const WEB_TOOLS = new Set(["web_search", "web_fetch"]);

const APP_TOOLS = new Set([
  "context_snapshot",
  "memory",
  "web_search",
  "web_fetch",
  "skill_list_current",
  "skill_read_current",
  "skill_search",
  "skill_show",
  "skill_install"
]);

const READ_TOOLS = new Set([
  "context_snapshot",
  "web_search",
  "web_fetch",
  "skill_list_current",
  "skill_read_current",
  "skill_search",
  "skill_show"
]);
const WRITE_TOOLS = new Set([
  "memory",
  "skill_install"
]);
const DESTRUCTIVE_TOOLS = new Set(["memory"]);

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
      openWorldHint: WEB_TOOLS.has(tool.name)
    }
  };
}

function cloudToolDefinitions() {
  return [
    { name: "context_snapshot", description: "Read current Mia bot/session metadata.", inputSchema: { type: "object" } },
    {
      name: "web_search",
      description: "Search the live public web for current information and return result titles, URLs, and snippets. Use this whenever the answer depends on recent or external facts.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500, description: "Search query." },
          limit: { type: "integer", minimum: 1, maximum: 10, description: "Maximum result count." }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    {
      name: "web_fetch",
      description: "Fetch and extract readable text from a public HTTP(S) page. Use it to inspect promising web_search results before answering.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1, maxLength: 4096, description: "Public http:// or https:// URL." },
          maxChars: { type: "integer", minimum: 1000, maximum: 30000, description: "Maximum extracted text characters." }
        },
        required: ["url"],
        additionalProperties: false
      }
    },
    {
      name: "memory",
      description: "Add, replace, or remove a concise Mia-owned memory entry for the current bot.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "replace", "remove"] },
          oldText: { type: "string", minLength: 1 },
          content: { type: "string", minLength: 1 }
        },
        required: ["action"],
        allOf: [
          {
            if: { properties: { action: { const: "add" } }, required: ["action"] },
            then: { required: ["content"] }
          },
          {
            if: { properties: { action: { const: "replace" } }, required: ["action"] },
            then: { required: ["oldText", "content"] }
          },
          {
            if: { properties: { action: { const: "remove" } }, required: ["action"] },
            then: { required: ["oldText"] }
          }
        ],
        additionalProperties: false
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

function contextMemoryMode(ctx = {}) {
  const mode = cleanText(ctx.memoryMode || ctx.memory_mode || "").toLowerCase();
  return mode === "native" ? "native" : "mia";
}

function memoryToolEnabled(ctx = {}) {
  return contextMemoryMode(ctx) === "mia";
}

function toolDefinitionsForMode(options = {}) {
  const ctx = readContext(options);
  return cloudToolDefinitions()
    .filter((tool) => APP_TOOLS.has(tool.name))
    .filter((tool) => tool.name !== "memory" || memoryToolEnabled(ctx));
}

function memoryMutationPayload(ctx = {}, args = {}) {
  const action = cleanText(args.action || "").toLowerCase();
  const content = cleanText(args.content ?? args.text ?? args.newText ?? args.new_text ?? "");
  const oldText = cleanText(args.oldText ?? args.old_text ?? "");
  const conversationId = cleanText(ctx.conversationId || ctx.sessionId || args.conversationId || "");
  const botId = cleanText(ctx.botId || args.botId || "");
  const payload = {
    conversationId,
    botId,
    action,
    target: "memory"
  };
  if (content) payload.content = content;
  if (oldText) payload.oldText = oldText;
  if (args.clientOpId) payload.clientOpId = cleanText(args.clientOpId);
  return payload;
}

async function cloudMemoryMutation(ctx = {}, args = {}, options = {}) {
  if (!memoryToolEnabled(ctx)) throw new Error("native_memory_owner");
  const payload = memoryMutationPayload(ctx, args);
  if (!payload.conversationId) throw new Error("conversationId is required");
  if (!payload.botId) throw new Error("botId is required");
  if (!new Set(["add", "replace", "remove"]).has(payload.action)) throw new Error("action must be add, replace, or remove");
  if ((payload.action === "add" || payload.action === "replace") && !payload.content) throw new Error("content is required");
  if ((payload.action === "replace" || payload.action === "remove") && !payload.oldText) throw new Error("oldText is required");
  const result = await cloudJson("POST", "/api/me/memory-documents/mutate", payload, options);
  return memoryResultForAgent(result);
}

// The mutation tool must not double as a hidden memory read API. The Bot sees
// its bounded document only in the first-turn snapshot for a new session.
function memoryResultForAgent(result = {}) {
  const output = { ...(result && typeof result === "object" ? result : {}) };
  delete output.target;
  delete output.currentEntries;
  return output;
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
        memoryMode: contextMemoryMode(ctx),
        memoryTools: memoryToolEnabled(ctx) ? { enabled: true, memory: "memory" } : { enabled: false },
        skillCount: Array.isArray(ctx.skills) ? ctx.skills.length : 0
      };

    case "memory":
      return cloudMemoryMutation(ctx, args, options);

    case "web_search":
      return searchPublicWeb(args, options);

    case "web_fetch":
      return fetchPublicPage(args, options);

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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function sendResponse(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handleRequest(req, options = {}) {
  const { id, method, params } = req;
  if (method === "initialize") {
    sendResponse({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mia-app", version: "0.1.0" }
      }
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    sendResponse({ jsonrpc: "2.0", id, result: { tools: toolDefinitionsForMode(options) } });
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
