#!/usr/bin/env node
// src/main/scheduler-mcp-server.js
// Standalone stdio MCP server (JSON-RPC 2.0) for Mia scheduler.
// Spawned by Claude Code / Codex adapters as a child process.
// Reads per-turn context from MIA_SCHEDULER_CONTEXT_FILE (path to JSON).
// Calls daemon HTTP API at MIA_DAEMON_URL with MIA_DAEMON_TOKEN auth.

"use strict";

const readline = require("node:readline");
const https = require("node:https");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const DAEMON_URL = (process.env.MIA_DAEMON_URL || "http://127.0.0.1:27861").replace(/\/$/, "");
const DAEMON_TOKEN = process.env.MIA_DAEMON_TOKEN || "";
const CONTEXT_FILE = process.env.MIA_SCHEDULER_CONTEXT_FILE || "";

function readContext() {
  if (!CONTEXT_FILE) return {};
  try {
    return JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf8"));
  } catch {
    return {};
  }
}

function daemonFetch(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${DAEMON_URL}${urlPath}`;
    const parsed = new URL(fullUrl);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ""),
      method,
      headers: {
        "Authorization": `Bearer ${DAEMON_TOKEN}`,
        "Content-Type": "application/json",
        ...(bodyStr != null ? { "Content-Length": Buffer.byteLength(bodyStr) } : {})
      }
    };
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        } catch (e) {
          reject(new Error(`Daemon response parse failed: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    if (bodyStr != null) req.write(bodyStr);
    req.end();
  });
}

// Tool schemas exposed to the AI (minimal — context fields injected server-side)
const TOOLS = [
  {
    name: "schedule_create",
    description: "Create a scheduled task. The fellow will execute the given prompt at the scheduled time. Returns the new task id.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short human-readable label for the task" },
        trigger: {
          type: "object",
          description: "When to fire. Use type='oneshot' for a single future time or type='cron' for recurring.",
          properties: {
            type: { type: "string", enum: ["cron", "oneshot"] },
            cron: { type: "string", description: "5-field cron expression, e.g. '30 18 * * *'" },
            at: { type: "string", description: "ISO 8601 timestamp for one-shot tasks, e.g. '2026-05-20T18:30:00+08:00'" }
          },
          required: ["type"]
        },
        timezone: { type: "string", description: "IANA timezone name. Defaults to Asia/Shanghai." },
        prompt: { type: "string", description: "What the fellow should do each time the task fires. Write it as an instruction the fellow will receive." }
      },
      required: ["title", "trigger", "prompt"]
    }
  },
  {
    name: "schedule_list",
    description: "List all scheduled tasks.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "schedule_update",
    description: "Update an existing task by id. Only provide the fields you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id (from schedule_list or schedule_create)" },
        title: { type: "string" },
        trigger: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["cron", "oneshot"] },
            cron: { type: "string" },
            at: { type: "string" }
          }
        },
        timezone: { type: "string" },
        prompt: { type: "string" }
      },
      required: ["id"]
    }
  },
  {
    name: "schedule_delete",
    description: "Delete a task by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id" }
      },
      required: ["id"]
    }
  },
  {
    name: "schedule_pause",
    description: "Pause a task by id (task will not fire until resumed).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id" }
      },
      required: ["id"]
    }
  },
  {
    name: "schedule_resume",
    description: "Resume a paused task by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id" }
      },
      required: ["id"]
    }
  }
];

async function callTool(name, args) {
  const ctx = readContext();
  const fellowId = ctx.fellowId || "";
  const sessionId = ctx.sessionId || "";
  const originMessageId = ctx.originMessageId || "";

  switch (name) {
    case "schedule_create": {
      const payload = {
        title: args.title,
        fellowId,
        sessionId,
        originMessageId,
        trigger: args.trigger,
        timezone: args.timezone || "Asia/Shanghai",
        prompt: args.prompt
      };
      const { status, body } = await daemonFetch("POST", "/api/tasks", payload);
      if (status !== 201) throw new Error(body?.error || `Daemon returned ${status}`);
      return { taskId: body.task?.id, task: body.task };
    }
    case "schedule_list": {
      const { status, body } = await daemonFetch("GET", "/api/tasks", null);
      if (status !== 200) throw new Error(body?.error || `Daemon returned ${status}`);
      return { tasks: body.tasks };
    }
    case "schedule_update": {
      const { id, ...partial } = args;
      if (!id) throw new Error("id is required");
      const { status, body } = await daemonFetch("PATCH", `/api/tasks/${encodeURIComponent(id)}`, partial);
      if (status !== 200) throw new Error(body?.error || `Daemon returned ${status}`);
      return { task: body.task };
    }
    case "schedule_delete": {
      if (!args.id) throw new Error("id is required");
      const { status, body } = await daemonFetch("DELETE", `/api/tasks/${encodeURIComponent(args.id)}`, null);
      if (status !== 200) throw new Error(body?.error || `Daemon returned ${status}`);
      return { ok: true };
    }
    case "schedule_pause": {
      if (!args.id) throw new Error("id is required");
      const { status, body } = await daemonFetch("POST", `/api/tasks/${encodeURIComponent(args.id)}/pause`, {});
      if (status !== 200) throw new Error(body?.error || `Daemon returned ${status}`);
      return { task: body.task };
    }
    case "schedule_resume": {
      if (!args.id) throw new Error("id is required");
      const { status, body } = await daemonFetch("POST", `/api/tasks/${encodeURIComponent(args.id)}/resume`, {});
      if (status !== 200) throw new Error(body?.error || `Daemon returned ${status}`);
      return { task: body.task };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function sendResponse(obj) {
  const line = JSON.stringify(obj);
  process.stdout.write(line + "\n");
}

function errorResponse(id, code, message) {
  sendResponse({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
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
        serverInfo: { name: "mia-scheduler", version: "0.1.0" }
      }
    });
    return;
  }

  if (method === "notifications/initialized") {
    // No response needed for notifications
    return;
  }

  if (method === "tools/list") {
    sendResponse({
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS }
    });
    return;
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    try {
      const result = await callTool(toolName, toolArgs);
      sendResponse({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false
        }
      });
    } catch (err) {
      sendResponse({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true
        }
      });
    }
    return;
  }

  // Ping / other standard methods
  if (method === "ping") {
    sendResponse({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  errorResponse(id, -32601, `Method not found: ${method}`);
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      errorResponse(null, -32700, "Parse error");
      continue;
    }
    if (req.jsonrpc !== "2.0") {
      errorResponse(req.id, -32600, "Invalid Request: jsonrpc must be '2.0'");
      continue;
    }
    // Don't await — process each message, but handle async errors
    handleRequest(req).catch((err) => {
      errorResponse(req.id, -32603, `Internal error: ${err.message}`);
    });
  }
}

main().catch((err) => {
  process.stderr.write(`scheduler-mcp-server fatal: ${err.message}\n`);
  process.exit(1);
});
