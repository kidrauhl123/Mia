#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const readline = require("node:readline");

const DAEMON_URL = (process.env.MIA_DAEMON_URL || "http://127.0.0.1:27861").replace(/\/$/, "");
const DAEMON_TOKEN = process.env.MIA_DAEMON_TOKEN || "";
const CONTEXT_FILE = process.env.MIA_APP_CONTEXT_FILE || "";

const READ_TOOLS = new Set([
  "schedule_list",
  "skill_search",
  "skill_show",
  "conversation_list",
  "bot_list"
]);
const WRITE_TOOLS = new Set([
  "schedule_create",
  "schedule_update",
  "schedule_delete",
  "schedule_pause",
  "schedule_resume",
  "skill_install",
  "conversation_create_group",
  "conversation_post_message"
]);

function toolDefinitions() {
  return [
    { name: "schedule_create", description: "Create a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "schedule_list", description: "List Mia scheduled tasks.", inputSchema: { type: "object" } },
    { name: "schedule_update", description: "Update a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "schedule_delete", description: "Delete a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "schedule_pause", description: "Pause a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "schedule_resume", description: "Resume a Mia scheduled task.", inputSchema: { type: "object" } },
    { name: "skill_search", description: "Search Mia skill marketplace.", inputSchema: { type: "object" } },
    { name: "skill_show", description: "Show Mia skill details.", inputSchema: { type: "object" } },
    { name: "skill_install", description: "Install a Mia skill for the current user.", inputSchema: { type: "object" } },
    { name: "conversation_list", description: "List Mia conversations available to the current user.", inputSchema: { type: "object" } },
    { name: "conversation_create_group", description: "Create a Mia group conversation.", inputSchema: { type: "object" } },
    { name: "conversation_post_message", description: "Post a message into a Mia conversation.", inputSchema: { type: "object" } },
    { name: "bot_list", description: "List Mia bots and basic runtime metadata.", inputSchema: { type: "object" } }
  ];
}

function permissionClassForTool(name) {
  if (READ_TOOLS.has(name)) return "read";
  if (WRITE_TOOLS.has(name)) return "write";
  return "unknown";
}

function readContext() {
  if (!CONTEXT_FILE) return {};
  try {
    return JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf8"));
  } catch {
    return {};
  }
}

function queryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

function daemonFetch(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`${DAEMON_URL}${urlPath}`);
    const transport = parsed.protocol === "https:" ? https : http;
    const bodyStr = body == null ? null : JSON.stringify(body);
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        Authorization: `Bearer ${DAEMON_TOKEN}`,
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

function assertOk(status, body) {
  if (status < 200 || status >= 300) throw new Error(body?.error || `Daemon returned ${status}`);
  return body;
}

async function daemonJson(method, urlPath, body) {
  const response = await daemonFetch(method, urlPath, body);
  return assertOk(response.status, response.body);
}

async function callTool(name, args = {}) {
  const ctx = readContext();
  switch (name) {
    case "schedule_create": {
      const { status, body } = await daemonFetch("POST", "/api/tasks", {
        title: args.title,
        botId: ctx.botId || args.botId || "",
        sessionId: ctx.sessionId || args.sessionId || "",
        originMessageId: ctx.originMessageId || args.originMessageId || "",
        trigger: args.trigger,
        timezone: args.timezone || "Asia/Shanghai",
        prompt: args.prompt
      });
      return assertOk(status, body);
    }
    case "schedule_list":
      return daemonJson("GET", "/api/tasks", null);
    case "schedule_update": {
      const { id, ...partial } = args;
      if (!id) throw new Error("id is required");
      return daemonJson("PATCH", `/api/tasks/${encodeURIComponent(id)}`, partial);
    }
    case "schedule_delete":
      if (!args.id) throw new Error("id is required");
      return daemonJson("DELETE", `/api/tasks/${encodeURIComponent(args.id)}`, null);
    case "schedule_pause":
      if (!args.id) throw new Error("id is required");
      return daemonJson("POST", `/api/tasks/${encodeURIComponent(args.id)}/pause`, {});
    case "schedule_resume":
      if (!args.id) throw new Error("id is required");
      return daemonJson("POST", `/api/tasks/${encodeURIComponent(args.id)}/resume`, {});
    case "skill_search":
      return daemonJson("GET", `/api/skills${queryString({ q: args.query, category: args.category, limit: args.limit })}`, null);
    case "skill_show":
      if (!args.id) throw new Error("id is required");
      return daemonJson("GET", `/api/skills/${encodeURIComponent(args.id)}`, null);
    case "skill_install":
      if (!args.id) throw new Error("id is required");
      return daemonJson("POST", `/api/skills/${encodeURIComponent(args.id)}/install`, {});
    case "conversation_list":
      return daemonJson("GET", "/api/conversations", null);
    case "conversation_create_group":
      return daemonJson("POST", "/api/conversations", {
        type: "group",
        title: args.title || args.name || "",
        memberIds: args.memberIds || args.members || []
      });
    case "conversation_post_message":
      if (!args.conversationId) throw new Error("conversationId is required");
      return daemonJson("POST", `/api/conversations/${encodeURIComponent(args.conversationId)}/messages`, {
        bodyMd: args.bodyMd || args.body || args.message || ""
      });
    case "bot_list":
      return daemonJson("GET", "/api/bots", null);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function sendResponse(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handleRequest(req) {
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
    sendResponse({ jsonrpc: "2.0", id, result: { tools: toolDefinitions() } });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await callTool(params?.name, params?.arguments || {});
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
  permissionClassForTool,
  toolDefinitions
};
