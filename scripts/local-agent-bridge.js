#!/usr/bin/env node

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const packageJson = require("../package.json");

const cloudUrl = process.env.MIA_CLOUD_URL || "http://127.0.0.1:4175";
let cloudToken = process.env.MIA_CLOUD_TOKEN || "";
const defaultEngine = normalizeAgentEngine(process.env.MIA_BRIDGE_ENGINE || "codex");
const deviceName = process.env.MIA_BRIDGE_NAME || `${os.hostname()} Mia Bridge`;
const cwd = process.env.MIA_BRIDGE_CWD || process.cwd();
const reconnectMs = Number(process.env.MIA_BRIDGE_RECONNECT_MS || 3000);
const activeRuns = new Map();
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

function log(message) {
  process.stdout.write(`[mia-bridge] ${message}\n`);
}

function bridgeCapabilities() {
  const engines = ["hermes", "claude-code", "codex"].includes(defaultEngine)
    ? [defaultEngine]
    : [];
  return {
    chat: true,
    attachments: true,
    generatedImages: true,
    cancellation: true,
    streaming: true,
    engines,
    app: "Mia Local Agent Bridge",
    appVersion: packageJson.version || "",
    hostname: os.hostname()
  };
}

function bridgeUrl(options = {}) {
  const url = new URL(options.cloudUrl || cloudUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/bridge";
  url.search = "";
  url.searchParams.set("deviceName", options.deviceName || deviceName);
  url.searchParams.set("engine", options.engine || defaultEngine || "mia-bridge");
  url.searchParams.set("capabilities", JSON.stringify(options.capabilities || bridgeCapabilities()));
  return url.toString();
}

function normalizeAgentEngine(value, fallback = "codex") {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (raw === "claude" || raw === "claude-code" || raw === "anthropic") return "claude-code";
  if (raw === "codex" || raw === "openai-codex") return "codex";
  if (raw === "hermes") return "hermes";
  if (raw === "echo") return "echo";
  return fallback;
}

function engineLabel(value) {
  const engine = normalizeAgentEngine(value, "codex");
  if (engine === "claude-code") return "Claude Code";
  if (engine === "hermes") return "Hermes";
  if (engine === "echo") return "Echo";
  return "Codex";
}

function bridgeProtocols(inputToken = cloudToken) {
  return [`mia-token.${inputToken}`];
}

async function resolveBridgeToken(env = process.env) {
  const configuredToken = String(env.MIA_CLOUD_TOKEN || "");
  if (configuredToken) return configuredToken;
  throw new Error("MIA_CLOUD_TOKEN is required.");
}

function shellCommandPath(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  return result.status === 0 ? String(result.stdout || "").trim().split(/\r?\n/)[0] : "";
}

function generatedImagesRoot(env = process.env) {
  const codexHome = String(env.CODEX_HOME || "").trim();
  if (codexHome) return path.join(codexHome, "generated_images");
  return path.join(os.homedir(), ".codex", "generated_images");
}

function recentGeneratedImagePaths(sessionId, startedAtMs, max = 8) {
  const dir = path.join(generatedImagesRoot(), String(sessionId || ""));
  if (!fs.existsSync(dir)) return [];
  const since = Number(startedAtMs) - 5000;
  return fs.readdirSync(dir)
    .filter((name) => /\.(?:png|jpe?g|webp)$/i.test(name))
    .map((name) => {
      const filePath = path.join(dir, name);
      try {
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item) => item && item.mtimeMs >= since)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(-max)
    .map((item) => item.filePath);
}

function imageMime(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function imageAttachment(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 18 * 1024 * 1024) return null;
  const mimeType = imageMime(filePath);
  return {
    id: `generated_${crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 16)}`,
    type: "image",
    name: path.basename(filePath),
    mimeType,
    dataUrl: `data:${mimeType};base64,${fs.readFileSync(filePath).toString("base64")}`
  };
}

function sanitizeAttachmentName(value, fallback = "attachment") {
  const raw = path.basename(String(value || fallback)).replace(/[^\w.\-()[\] \u4e00-\u9fff]+/g, "_").trim();
  return raw || fallback;
}

function attachmentKind({ mimeType = "", name = "" } = {}) {
  const type = String(mimeType || "").toLowerCase();
  const ext = path.extname(String(name || "")).toLowerCase();
  if (type.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
  if (type.startsWith("text/") || [".txt", ".md", ".json", ".csv", ".log", ".js", ".ts", ".tsx", ".jsx", ".py", ".html", ".css"].includes(ext)) return "text";
  if (type.includes("pdf") || ext === ".pdf") return "pdf";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "file";
}

function attachmentSummaryLine(attachment, index) {
  const parts = [
    `${index + 1}. ${attachment.name || "attachment"}`,
    `类型：${attachment.mimeType || attachment.kind || "未知"}`,
    attachment.size ? `大小：${attachment.size} bytes` : "",
    attachment.path ? `本地路径：${attachment.path}` : ""
  ].filter(Boolean);
  return parts.join("；");
}

function textPreviewForAttachment(attachment) {
  if (attachment.kind !== "text" || !attachment.path || !fs.existsSync(attachment.path)) return "";
  const stat = fs.statSync(attachment.path);
  if (stat.size > 1024 * 1024) return "";
  try {
    return fs.readFileSync(attachment.path, "utf8").slice(0, 12000);
  } catch {
    return "";
  }
}

function attachmentContext(attachments = []) {
  const normalized = attachments.filter((item) => item?.path || item?.name);
  if (!normalized.length) return "";
  const lines = [
    "本轮用户附带了以下附件。可以直接读取本地路径；如果当前引擎不能读取二进制图片，请根据文件名、类型和用户文字继续处理，并说明限制。",
    ...normalized.map(attachmentSummaryLine)
  ];
  const previews = normalized
    .map((attachment, index) => {
      const preview = textPreviewForAttachment(attachment);
      return preview ? `附件 ${index + 1} 文本预览（${attachment.name}）：\n${preview}` : "";
    })
    .filter(Boolean);
  return [...lines, ...previews].join("\n\n");
}

function buildCodexPrompt(text, attachments = []) {
  const context = attachmentContext(attachments);
  return [String(text || ""), context ? `附件上下文：\n${context}` : ""].filter(Boolean).join("\n\n");
}

function dataUrlToAttachmentBuffer(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) return null;
  return { mimeType: match[1], buffer };
}

function attachmentUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const resolved = new URL(raw, cloudUrl);
    if (resolved.origin !== new URL(cloudUrl).origin || !resolved.pathname.startsWith("/api/files/")) return null;
    return resolved;
  } catch {
    return null;
  }
}

async function fetchAttachmentBuffer(attachment) {
  const dataUrl = dataUrlToAttachmentBuffer(attachment.dataUrl);
  if (dataUrl) return dataUrl;
  const url = attachmentUrl(attachment.url);
  if (!url) return null;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${cloudToken}` } });
  if (!response.ok) throw new Error(`附件下载失败：${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) throw new Error("附件大小无效。");
  return {
    mimeType: response.headers.get("content-type") || attachment.mimeType || "",
    buffer
  };
}

async function materializeAttachments(attachments = [], runId = crypto.randomUUID()) {
  const incoming = Array.isArray(attachments) ? attachments.slice(0, 20) : [];
  if (!incoming.length) return { attachments: [], dir: "" };
  const dir = path.join(os.tmpdir(), "mia-bridge-attachments", sanitizeAttachmentName(runId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const materialized = [];
  for (const [index, attachment] of incoming.entries()) {
    const name = sanitizeAttachmentName(attachment.name || `attachment-${index + 1}`);
    const existingPath = String(attachment.path || "").trim();
    if (existingPath && fs.existsSync(existingPath)) {
      const stat = fs.statSync(existingPath);
      materialized.push({
        name,
        path: existingPath,
        mimeType: attachment.mimeType || attachment.mime || "",
        size: stat.size,
        kind: attachmentKind({ mimeType: attachment.mimeType || attachment.mime || "", name })
      });
      continue;
    }
    const fetched = await fetchAttachmentBuffer(attachment);
    if (!fetched) continue;
    const target = path.join(dir, `${index + 1}-${name}`);
    fs.writeFileSync(target, fetched.buffer, { mode: 0o600 });
    materialized.push({
      name,
      path: target,
      mimeType: attachment.mimeType || attachment.mime || fetched.mimeType,
      size: fetched.buffer.length,
      kind: attachmentKind({ mimeType: attachment.mimeType || attachment.mime || fetched.mimeType, name })
    });
  }
  return { attachments: materialized, dir };
}

function mapPermissionMode(value) {
  const mode = String(value || "default");
  if (mode === "bypass" || mode === "bypassPermissions" || mode === "yolo") return { sandboxMode: "danger-full-access", approvalPolicy: "never" };
  if (mode === "readOnly") return { sandboxMode: "read-only", approvalPolicy: "never" };
  if (mode === "acceptEdits") return { sandboxMode: "workspace-write", approvalPolicy: "never" };
  return { sandboxMode: "workspace-write", approvalPolicy: "never" };
}

function sendRunEvent(ws, runId, kind, payload = {}) {
  sendJson(ws, { type: "run_event", runId, event: { kind, ...payload } });
}

function emitCodexStreamEvent(ws, runId, event, textByItem) {
  if (!event?.item) return;
  const item = event.item;
  if (item.type === "agent_message") {
    const id = String(item.id || "agent_message");
    const text = String(item.text || "");
    const previous = textByItem.get(id) || "";
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    textByItem.set(id, text);
    if (delta) sendRunEvent(ws, runId, "text_delta", { id, text: delta });
  } else if (item.type === "command_execution") {
    const payload = {
      id: String(item.id || "command"),
      name: "shell",
      preview: String(item.command || ""),
      status: String(item.status || ""),
      error: item.status === "failed"
    };
    if (event.type === "item.started") sendRunEvent(ws, runId, "tool_call_started", payload);
    if (event.type === "item.completed") sendRunEvent(ws, runId, "tool_call_completed", payload);
  }
}

async function runCodex(text, { signal = null, ws = null, runId = "", attachments = [], runtimeConfig = {} } = {}) {
  const codexPath = shellCommandPath("codex");
  if (!codexPath) throw new Error("本机没有检测到 Codex CLI。请先安装并登录 Codex。");
  const materialized = await materializeAttachments(attachments, runId || crypto.randomUUID());
  try {
    const { Codex } = await import("@openai/codex-sdk");
    const codex = new Codex({ codexPathOverride: codexPath, env: process.env });
    const threadOptions = {
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      modelReasoningEffort: runtimeConfig.effortLevel || runtimeConfig.effort_level || process.env.MIA_CODEX_EFFORT || "medium",
      ...mapPermissionMode(process.env.MIA_CODEX_PERMISSION || "default")
    };
    if (runtimeConfig.model) threadOptions.model = String(runtimeConfig.model);
    const thread = codex.startThread(threadOptions);
    const startedAtMs = Date.now();
    let finalResponse = "";
    const prompt = buildCodexPrompt(text, materialized.attachments);
    if (ws && runId && typeof thread.runStreamed === "function") {
      const textByItem = new Map();
      const { events } = await thread.runStreamed(prompt, { signal });
      for await (const event of events) {
        if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
          emitCodexStreamEvent(ws, runId, event, textByItem);
          if (event.type === "item.completed" && event.item?.type === "agent_message") {
            finalResponse = String(event.item.text || "");
          }
        }
        if (event.type === "turn.failed") throw new Error(event.error?.message || "Codex turn failed.");
        if (event.type === "error") throw new Error(event.message || "Codex stream failed.");
      }
    } else {
      const turn = await thread.run(prompt, signal ? { signal } : {});
      finalResponse = String(turn?.finalResponse || "");
    }
    const imagePaths = recentGeneratedImagePaths(thread.id, startedAtMs);
    const generatedAttachments = imagePaths.map(imageAttachment).filter(Boolean);
    return {
      text: finalResponse.trim() || (generatedAttachments.length ? "图片已生成。" : "本机 Codex 已完成。"),
      attachments: generatedAttachments
    };
  } finally {
    if (materialized.dir) fs.rmSync(materialized.dir, { recursive: true, force: true });
  }
}

async function runLocalAgent(message, context = {}) {
  const runtimeConfig = message?.runtimeConfig || message?.runtime_config || message?.config || {};
  const requestedEngine = normalizeAgentEngine(
    message?.agentEngine || message?.agent_engine || message?.engine || runtimeConfig.agentEngine || runtimeConfig.agent_engine,
    defaultEngine
  );
  if (requestedEngine === "echo") {
    return { text: `本机 Bridge 已收到：${message.text || ""}`, attachments: [] };
  }
  if (requestedEngine !== "codex") {
    throw new Error(`命令行 Bridge 暂不支持 ${engineLabel(requestedEngine)}。请使用 Mia Desktop Bridge，或把该 Bot 切到 Codex。`);
  }
  return runCodex(message.text || "", {
    ...context,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    runtimeConfig
  });
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

async function connect() {
  if (!cloudToken) {
    try {
      cloudToken = await resolveBridgeToken();
    } catch (error) {
      process.stderr.write(`${error.message || error}\n`);
      process.exitCode = 1;
      return;
    }
  }
  if (!cloudToken) {
    process.stderr.write("MIA_CLOUD_TOKEN is required.\n");
    process.exitCode = 1;
    return;
  }
  const ws = new WebSocket(bridgeUrl(), bridgeProtocols());
  ws.on("open", () => log(`connected to ${cloudUrl} as ${deviceName} (${defaultEngine})`));
  ws.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.type === "bridge_ready") {
      log(`device online: ${message.deviceId}`);
      return;
    }
    if (message.type === "ping") {
      sendJson(ws, { type: "pong" });
      return;
    }
    if (message.type === "cancel") {
      activeRuns.get(String(message.runId || ""))?.abort();
      return;
    }
    if (message.type !== "run") return;
    log(`run ${message.runId} started`);
    const abortController = new AbortController();
    activeRuns.set(String(message.runId || ""), abortController);
    try {
      sendRunEvent(ws, message.runId, "status", { text: "本机 Agent 已接收任务。" });
      const result = await runLocalAgent(message, { signal: abortController.signal, ws, runId: message.runId });
      sendJson(ws, { type: "run_result", runId: message.runId, ok: true, ...result });
      log(`run ${message.runId} completed`);
    } catch (error) {
      sendJson(ws, { type: "run_result", runId: message.runId, ok: false, error: error.message || String(error) });
      log(`run ${message.runId} failed: ${error.message || error}`);
    } finally {
      activeRuns.delete(String(message.runId || ""));
    }
  });
  ws.on("close", () => {
    log(`disconnected; reconnecting in ${reconnectMs}ms`);
    setTimeout(connect, reconnectMs);
  });
  ws.on("error", (error) => log(`socket error: ${error.message || error}`));
}

if (require.main === module) {
  connect();
}

module.exports = {
  bridgeCapabilities,
  bridgeProtocols,
  bridgeUrl,
  buildCodexPrompt,
  imageAttachment,
  materializeAttachments,
  mapPermissionMode,
  recentGeneratedImagePaths,
  resolveBridgeToken
};
