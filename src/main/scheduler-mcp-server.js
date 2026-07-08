#!/usr/bin/env node
// src/main/scheduler-mcp-server.js
// Standalone stdio MCP server (JSON-RPC 2.0) for Mia scheduler.
// Spawned by Claude Code / Codex adapters as a child process.
// Reads per-turn context from MIA_SCHEDULER_CONTEXT_FILE (path to JSON).
// Calls Rust Core HTTP API at MIA_CORE_URL with MIA_CORE_TOKEN auth.

"use strict";

const readline = require("node:readline");
const https = require("node:https");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const CORE_URL = (process.env.MIA_CORE_URL || process.env.MIA_DAEMON_URL || "http://127.0.0.1:27861").replace(/\/$/, "");
const CORE_TOKEN = process.env.MIA_CORE_TOKEN || process.env.MIA_DAEMON_TOKEN || "";
const CONTEXT_FILE = process.env.MIA_SCHEDULER_CONTEXT_FILE || "";

function readContext() {
  if (!CONTEXT_FILE) return {};
  try {
    return JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf8"));
  } catch {
    return {};
  }
}

function coreFetch(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${CORE_URL}${urlPath}`;
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
        "Authorization": `Bearer ${CORE_TOKEN}`,
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
          reject(new Error(`Core response parse failed: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    if (bodyStr != null) req.write(bodyStr);
    req.end();
  });
}

function nextFireForTask(task = {}) {
  if (task.nextRunAt != null && Number.isFinite(Number(task.nextRunAt))) return Number(task.nextRunAt);
  if (task.nextFireAt != null && Number.isFinite(Number(task.nextFireAt))) return Number(task.nextFireAt);
  if (task.schedule?.atMs != null && Number.isFinite(Number(task.schedule.atMs))) return Number(task.schedule.atMs);
  if (task.schedule?.type === "oneshot" && task.schedule?.at) {
    const at = new Date(task.schedule.at).getTime();
    return Number.isNaN(at) ? null : at;
  }
  if (task.trigger?.type === "oneshot") {
    const at = new Date(task.trigger.at).getTime();
    return Number.isNaN(at) ? null : at;
  }
  return null;
}

function formatLocalFireTime(ms, timezone = "Asia/Shanghai") {
  const at = Number(ms);
  if (!Number.isFinite(at)) return "";
  const tz = String(timezone || "Asia/Shanghai");
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz,
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

function legacyTriggerFromCoreSchedule(schedule = {}) {
  if (schedule?.type === "cron") return { type: "cron", cron: String(schedule.cron || "") };
  if (schedule?.type === "oneshot") {
    const atMs = Number(schedule.atMs || 0);
    return { type: "oneshot", at: atMs > 0 ? new Date(atMs).toISOString() : String(schedule.at || "") };
  }
  if (schedule?.type === "every") return { type: "every", everyMs: Number(schedule.everyMs || 0) };
  return {};
}

function coreScheduleFromArgs(args = {}) {
  if (Object.prototype.hasOwnProperty.call(args, "schedule")) return args.schedule;
  const trigger = args.trigger && typeof args.trigger === "object" ? args.trigger : {};
  if (trigger.type === "cron") {
    return {
      type: "cron",
      cron: String(trigger.cron || ""),
      timezone: String(args.timezone || "Asia/Shanghai")
    };
  }
  if (trigger.type === "oneshot") return { type: "oneshot", at: String(trigger.at || "") };
  if (trigger.type === "every") return { type: "every", everyMs: Number(trigger.everyMs || 0) };
  return {};
}

function coreTaskPayload(args = {}, context = {}) {
  const fireMode = String(args.fireMode || (args.deliveryText ? "deliver" : "agent")).trim() || "agent";
  return {
    kind: fireMode,
    schedule: coreScheduleFromArgs(args),
    target: {
      botId: context.botId || "",
      conversationId: context.sessionId || "",
      sessionId: context.sessionId || "",
      title: args.title || "未命名任务",
      timezone: args.timezone || "Asia/Shanghai",
      fireMode,
      deliveryText: args.deliveryText || "",
      originMessageId: context.originMessageId || ""
    },
    instructions: args.prompt || args.deliveryText || ""
  };
}

function coreTaskPatch(args = {}) {
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(args, "schedule") || Object.prototype.hasOwnProperty.call(args, "trigger")) {
    patch.schedule = coreScheduleFromArgs(args);
  }
  const target = {};
  for (const key of ["title", "timezone", "fireMode", "deliveryText"]) {
    if (Object.prototype.hasOwnProperty.call(args, key)) target[key] = args[key];
  }
  if (Object.keys(target).length) patch.target = target;
  if (Object.prototype.hasOwnProperty.call(args, "prompt")) patch.instructions = args.prompt || "";
  return patch;
}

function legacyTaskFromCoreJob(job = {}) {
  const target = job.target && typeof job.target === "object" ? job.target : {};
  const schedule = job.schedule && typeof job.schedule === "object" ? job.schedule : {};
  return {
    id: job.id || "",
    title: target.title || job.kind || "未命名任务",
    botId: target.botId || target.bot_id || "",
    conversationId: target.conversationId || target.conversation_id || "",
    sessionId: target.sessionId || target.session_id || target.conversationId || "",
    originMessageId: target.originMessageId || "",
    trigger: legacyTriggerFromCoreSchedule(schedule),
    timezone: schedule.timezone || target.timezone || "Asia/Shanghai",
    prompt: job.instructions || "",
    fireMode: target.fireMode || job.kind || "agent",
    deliveryText: target.deliveryText || "",
    status: job.status || "active",
    nextFireAt: job.nextRunAt ?? null
  };
}

// Tool schemas exposed to the AI (minimal — context fields injected server-side)
const TOOLS = [
  {
    name: "schedule_create",
    description: [
      "Create and activate a scheduled task in Mia. The task is created immediately when this tool returns — there is no separate UI step the user needs to take, and you should not describe one to them.",
      "You (the currently-replying bot) are always the executor: do NOT ask the user which engine/agent should run the task. botId, conversationId, and originMessageId are injected by the runtime and you cannot set them.",
      "Use the `schedule` string for timing, Hermes-style. For relative times like '1 minute later', pass schedule='1m' and let Mia compute the absolute fire time; do NOT calculate an ISO timestamp yourself. For recurring tasks, pass a cron expression such as '0 9 * * *'. Absolute ISO timestamps are also accepted.",
      "For simple reminders, alarms, and countdowns where the expected result is just a reminder message, set fireMode='deliver' and put the exact future bot message in deliveryText. Mia will post deliveryText directly as the bot at fire time; the agent will not run again.",
      "For tasks that require fresh reasoning, tool use, or changing outside state at fire time, set fireMode='agent' and put the full self-contained instruction in prompt. Agent tasks may run tools when they fire.",
      "Features that DO exist: title, schedule, IANA timezone, fireMode, deliveryText, and prompt. Features that do NOT exist and must not be asked about: per-task engine choice, retry/backoff policy, alternate delivery channels (popups, logs, other rooms), notification settings. If user asks for any of those, say they are not currently available.",
      "Returns the new task id."
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short human-readable label, e.g. '每天晨间简报'." },
        schedule: { type: "string", description: "Hermes-style schedule string. Use relative one-shot delays like '1m', '30m', '2h', '1d'; 5-field cron expressions like '0 9 * * *'; or ISO-8601 timestamps. For user requests like '1分钟后', pass '1m' instead of computing a timestamp." },
        trigger: {
          type: "object",
          description: "Legacy structured trigger. Prefer schedule for new calls, especially for relative times.",
          properties: {
            type: { type: "string", enum: ["cron", "oneshot"] },
            cron: { type: "string", description: "Standard 5-field cron expression, e.g. '30 9 * * *' for 09:30 every day." },
            at: { type: "string", description: "ISO 8601 timestamp for one-shot tasks, e.g. '2026-05-20T18:30:00+08:00'." }
          },
          required: ["type"]
        },
        timezone: { type: "string", description: "IANA timezone name, e.g. 'Asia/Shanghai'. Defaults to Asia/Shanghai if you omit it; only ask the user if their request is ambiguous about local time." },
        fireMode: { type: "string", enum: ["deliver", "agent"], description: "Use 'deliver' for simple reminders that should post deliveryText directly; use 'agent' only when the task needs fresh reasoning or tool use at fire time. Defaults to 'deliver' when deliveryText is provided, otherwise 'agent'." },
        deliveryText: { type: "string", description: "For fireMode='deliver': the exact message Mia should post as this bot at fire time, e.g. '该吃饭了。'. Keep it concise and do not include scheduling instructions." },
        prompt: { type: "string", description: "For fireMode='agent': the self-contained instruction the bot should execute at fire time. Optional for fireMode='deliver' and kept only as provenance." }
      },
      required: ["title", "schedule"]
    }
  },
  {
    name: "schedule_list",
    description: "List all scheduled tasks (across every bot and conversation, not just this one). Use this to look up an existing task's id before update / delete / pause / resume.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "schedule_update",
    description: "Update an existing task by id — applies immediately, no UI step needed. Only provide the fields you want to change. Same parameter constraints as schedule_create: retry / engine / delivery channel are not real fields, do not invent them.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id (from schedule_list or schedule_create)" },
        title: { type: "string" },
        schedule: { type: "string", description: "Hermes-style schedule string; prefer this over trigger." },
        trigger: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["cron", "oneshot"] },
            cron: { type: "string" },
            at: { type: "string" }
          }
        },
        timezone: { type: "string" },
        fireMode: { type: "string", enum: ["deliver", "agent"] },
        deliveryText: { type: "string" },
        prompt: { type: "string" }
      },
      required: ["id"]
    }
  },
  {
    name: "schedule_delete",
    description: "Delete a task by id — permanent, takes effect immediately. Prior run history is also dropped. If user just wants to stop a recurring task temporarily, prefer schedule_pause.",
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
    description: "Pause a task by id. It stops firing immediately and stays paused (with its history preserved) until schedule_resume is called. Reversible — use this when the user wants to temporarily stop a task.",
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
    description: "Resume a previously paused task by id. Fires take effect immediately on the next scheduled time. Fires missed while the task was paused are NOT replayed.",
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
  const botId = ctx.botId || "";
  const sessionId = ctx.sessionId || "";
  const originMessageId = ctx.originMessageId || "";

  switch (name) {
    case "schedule_create": {
      const payload = coreTaskPayload(args, { botId, sessionId, originMessageId });
      const { status, body } = await coreFetch("POST", "/api/tasks/jobs", payload);
      if (status !== 200 && status !== 201) throw new Error(body?.error || `Core returned ${status}`);
      const task = legacyTaskFromCoreJob(body.job || body.task || {});
      return { taskId: task.id, ...taskToolPayload(task) };
    }
    case "schedule_list": {
      const { status, body } = await coreFetch("GET", "/api/tasks/jobs", null);
      if (status !== 200) throw new Error(body?.error || `Core returned ${status}`);
      return { tasks: Array.isArray(body.jobs) ? body.jobs.map(legacyTaskFromCoreJob) : body.tasks };
    }
    case "schedule_update": {
      const { id, ...partial } = args;
      if (!id) throw new Error("id is required");
      const { status, body } = await coreFetch("PATCH", `/api/tasks/jobs/${encodeURIComponent(id)}`, coreTaskPatch(partial));
      if (status !== 200) throw new Error(body?.error || `Core returned ${status}`);
      return { task: legacyTaskFromCoreJob(body.job || body.task || {}) };
    }
    case "schedule_delete": {
      if (!args.id) throw new Error("id is required");
      const { status, body } = await coreFetch("DELETE", `/api/tasks/jobs/${encodeURIComponent(args.id)}`, null);
      if (status !== 200) throw new Error(body?.error || `Core returned ${status}`);
      return { ok: true };
    }
    case "schedule_pause": {
      if (!args.id) throw new Error("id is required");
      const { status, body } = await coreFetch("PATCH", `/api/tasks/jobs/${encodeURIComponent(args.id)}`, { status: "paused" });
      if (status !== 200) throw new Error(body?.error || `Core returned ${status}`);
      return { task: legacyTaskFromCoreJob(body.job || body.task || {}) };
    }
    case "schedule_resume": {
      if (!args.id) throw new Error("id is required");
      const { status, body } = await coreFetch("PATCH", `/api/tasks/jobs/${encodeURIComponent(args.id)}`, { status: "active" });
      if (status !== 200) throw new Error(body?.error || `Core returned ${status}`);
      return { task: legacyTaskFromCoreJob(body.job || body.task || {}) };
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
