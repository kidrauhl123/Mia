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
  "web_search",
  "web_fetch"
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
    {
      name: "web_search",
      description: "Search the public web and return concise result titles, URLs, and snippets.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: { type: "number", description: "Maximum number of results, 1-10." }
        },
        required: ["query"]
      }
    },
    {
      name: "web_fetch",
      description: "Fetch a public HTTP(S) page and return cleaned text for reading cited sources.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Public http:// or https:// URL to fetch." },
          maxChars: { type: "number", description: "Maximum cleaned text characters, 1000-20000." }
        },
        required: ["url"]
      }
    }
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

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isBlockedPublicWebHost(hostname = "") {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^0\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
}

function assertPublicHttpUrl(value = "") {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("url must be a valid http:// or https:// URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use http:// or https://");
  }
  if (isBlockedPublicWebHost(parsed.hostname)) {
    throw new Error("refusing to fetch local or private network URL");
  }
  parsed.hash = "";
  return parsed;
}

function requestPublicText(url, { timeoutMs = 12000, maxBytes = 1024 * 1024, redirects = 3, headers = {} } = {}) {
  const parsed = assertPublicHttpUrl(url);
  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "GET",
      timeout: timeoutMs,
      headers: {
        "User-Agent": "MiaBot/0.1 (+https://mia.local)",
        Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
        ...headers
      }
    }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location && redirects > 0) {
        res.resume();
        const next = new URL(location, parsed).toString();
        requestPublicText(next, { timeoutMs, maxBytes, redirects: redirects - 1, headers }).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          req.destroy(new Error("response too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({
        url: parsed.toString(),
        status,
        contentType: String(res.headers["content-type"] || ""),
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function decodeHtmlEntities(text = "") {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => {
      const n = Number.parseInt(code, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    });
}

function stripHtml(text = "") {
  return decodeHtmlEntities(String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

function duckDuckGoResultUrl(rawHref = "") {
  const href = decodeHtmlEntities(rawHref);
  try {
    const parsed = new URL(href, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? new URL(uddg).toString() : parsed.toString();
  } catch {
    return "";
  }
}

function parseDuckDuckGoHtml(html = "", limit = 5) {
  const out = [];
  const blocks = String(html || "").match(/<div[^>]+class="[^"]*\bresult\b[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*\bresult\b|$)/gi) || [];
  for (const block of blocks) {
    if (out.length >= limit) break;
    const anchor = block.match(/<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = duckDuckGoResultUrl(anchor[1]);
    const title = stripHtml(anchor[2]);
    if (!url || !title || /duckduckgo\.com\/y\.js/i.test(url)) continue;
    const snippetMatch = block.match(/<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "";
    if (!out.some((item) => item.url === url)) out.push({ title, url, snippet });
  }
  return out;
}

function relatedTopicsFromDuckDuckGo(topics = [], out = []) {
  for (const topic of Array.isArray(topics) ? topics : []) {
    if (topic?.FirstURL && topic?.Text) {
      out.push({ title: String(topic.Text).split(" - ")[0], url: String(topic.FirstURL), snippet: String(topic.Text) });
    }
    if (Array.isArray(topic?.Topics)) relatedTopicsFromDuckDuckGo(topic.Topics, out);
  }
  return out;
}

async function webSearch(args = {}) {
  const query = String(args.query || args.q || "").trim();
  if (!query) throw new Error("query is required");
  const limit = clampNumber(args.limit, 1, 10, 5);
  const searchUrl = `https://duckduckgo.com/html/${queryString({ q: query })}`;
  let results = [];
  let source = "duckduckgo-html";
  try {
    const response = await requestPublicText(searchUrl, { maxBytes: 2 * 1024 * 1024 });
    results = parseDuckDuckGoHtml(response.text, limit);
  } catch {
    results = [];
  }
  if (!results.length) {
    source = "duckduckgo-instant-answer";
    const apiUrl = `https://api.duckduckgo.com/${queryString({ q: query, format: "json", no_html: 1, skip_disambig: 1 })}`;
    const response = await requestPublicText(apiUrl, { headers: { Accept: "application/json" } });
    const data = JSON.parse(response.text || "{}");
    if (data.AbstractURL && data.AbstractText) {
      results.push({ title: data.Heading || query, url: data.AbstractURL, snippet: data.AbstractText });
    }
    results.push(...relatedTopicsFromDuckDuckGo(data.RelatedTopics, []));
    results = results.filter((item, index, arr) => item.url && arr.findIndex((other) => other.url === item.url) === index).slice(0, limit);
  }
  return {
    query,
    source,
    results: results.slice(0, limit)
  };
}

function parseWebPageText(html = "", sourceUrl = "", maxChars = 12000) {
  const titleMatch = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripHtml(titleMatch[1]) : "";
  const cleaned = stripHtml(html).slice(0, maxChars);
  return {
    url: sourceUrl,
    title,
    text: cleaned,
    truncated: stripHtml(html).length > maxChars
  };
}

async function webFetch(args = {}) {
  const url = String(args.url || "").trim();
  if (!url) throw new Error("url is required");
  const maxChars = clampNumber(args.maxChars, 1000, 20000, 12000);
  const response = await requestPublicText(url, { maxBytes: 2 * 1024 * 1024 });
  return parseWebPageText(response.text, response.url, maxChars);
}

function nextFireForTask(task = {}) {
  if (Number.isFinite(Number(task.nextFireAt))) return Number(task.nextFireAt);
  if (task.trigger?.type === "oneshot") {
    const at = new Date(task.trigger.at).getTime();
    return Number.isNaN(at) ? null : at;
  }
  return null;
}

function formatLocalFireTime(ms, timezone = "Asia/Shanghai") {
  const at = Number(ms);
  if (!Number.isFinite(at)) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: String(timezone || "Asia/Shanghai"),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString();
  }
}

function taskToolPayload(task = {}) {
  const nextFireAt = nextFireForTask(task);
  const timezone = String(task.timezone || "Asia/Shanghai");
  return {
    task: {
      ...task,
      ...(nextFireAt == null ? {} : { nextFireAt }),
      ...(nextFireAt == null ? {} : { nextFireAtLocal: formatLocalFireTime(nextFireAt, timezone) })
    },
    ...(nextFireAt == null ? {} : { nextFireAt }),
    ...(nextFireAt == null ? {} : { nextFireAtLocal: formatLocalFireTime(nextFireAt, timezone) }),
    timezone
  };
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
      const payload = {
        title: args.title,
        botId: ctx.botId || args.botId || "",
        sessionId: ctx.sessionId || args.sessionId || "",
        originMessageId: ctx.originMessageId || args.originMessageId || "",
        timezone: args.timezone || "Asia/Shanghai",
        fireMode: args.fireMode,
        deliveryText: args.deliveryText,
        prompt: args.prompt
      };
      if (args.schedule) payload.schedule = args.schedule;
      else if (args.trigger) payload.trigger = args.trigger;
      const { status, body } = await daemonFetch("POST", "/api/tasks", payload);
      const created = assertOk(status, body);
      return { ...created, ...taskToolPayload(created.task) };
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
    case "web_search":
      return webSearch(args);
    case "web_fetch":
      return webFetch(args);
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
  parseDuckDuckGoHtml,
  parseWebPageText,
  permissionClassForTool,
  toolDefinitions
};
