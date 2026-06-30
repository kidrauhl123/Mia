"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { CloudEvent } = require("../../shared/cloud-events.js");
const { createAssistantContentBlockCollector } = require("../../shared/assistant-content-blocks.js");

const PROCESSED_CAP = 500;
const CANCEL_DRAIN_TIMEOUT_MS = 15000;
const HISTORY_MESSAGE_LIMIT = 80;
const HISTORY_MESSAGE_CHAR_LIMIT = 4000;
const HISTORY_TOTAL_CHAR_LIMIT = 24000;
const MAX_GENERATED_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const ARTIFACT_SCAN_MAX_DEPTH = 6;
const ARTIFACT_SCAN_MAX_FILES = 5000;
const GENERATED_ARTIFACT_EXTENSIONS = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".json",
  ".md",
  ".pdf",
  ".ppt",
  ".pptx",
  ".tsv",
  ".txt",
  ".xls",
  ".xlsm",
  ".xlsx",
  ".zip"
]);
const ARTIFACT_SKIP_DIRS = new Set([".git", "node_modules", "__pycache__"]);

function shouldHandleLocalCloudConversationAi({ isDaemon, daemonEnabled }) {
  // Single owner (ADR 2026-06-12 desktop-single-owner-daemon): only the daemon
  // executes bot turns. The foreground window never falls back to running
  // runtime work because that splits cursor/run/session ownership.
  return Boolean(isDaemon && daemonEnabled);
}

function clientOpIdForDedupKey(dedupKey) {
  const safe = String(dedupKey || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
  return `op_bot_reply_${safe || "unknown"}`;
}

function errorClientOpIdForDedupKey(dedupKey) {
  return clientOpIdForDedupKey(dedupKey).replace(/^op_bot_reply_/, "op_bot_reply_error_");
}

function responseText(result) {
  const message = result?.choices?.[0]?.message || result?.message || {};
  return String(message.content || result?.content || "").trim();
}

function postedMessageFromResult(result) {
  const direct = result?.message;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  const nested = result?.data?.message;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  return null;
}

function normalizeToolStatus(status) {
  const value = String(status || "").trim();
  if (value === "complete" || value === "completed") return "completed";
  if (value === "error" || value === "failed") return "error";
  return "running";
}

function toolFromTrace(trace, data = {}) {
  const id = String(data?.id || "");
  const name = String(data?.name || "");
  let tool = id ? trace.toolsById.get(id) : null;
  if (!tool && name) {
    const queue = trace.toolsByName.get(name);
    tool = queue && queue.find((item) => item.status === "running");
  }
  return tool || null;
}

function createTraceCollector() {
  const trace = {
    reasoning: "",
    tools: [],
    toolsById: new Map(),
    toolsByName: new Map()
  };

  function collect(kind, data = {}) {
    switch (kind) {
      case "reasoning_delta":
        trace.reasoning += String(data?.text || "");
        if (trace.reasoning && !trace.reasoning.endsWith("\n")) trace.reasoning += "\n";
        break;
      case "tool_call_started": {
        const tool = {
          id: String(data?.id || `tool_${trace.tools.length}`),
          name: String(data?.name || "工具"),
          preview: String(data?.preview || ""),
          status: "running",
          duration: null,
          error: false
        };
        trace.tools.push(tool);
        trace.toolsById.set(tool.id, tool);
        const queue = trace.toolsByName.get(tool.name) || [];
        queue.push(tool);
        trace.toolsByName.set(tool.name, queue);
        break;
      }
      case "tool_call_delta": {
        const tool = toolFromTrace(trace, data);
        if (tool) tool.preview = String(data?.preview || tool.preview || "");
        break;
      }
      case "tool_call_completed": {
        const tool = toolFromTrace(trace, data);
        if (tool) {
          tool.status = data?.error ? "error" : normalizeToolStatus(data?.status || "completed");
          tool.duration = typeof data?.duration === "number" ? data.duration : null;
          tool.error = Boolean(data?.error);
          if (data?.preview) tool.preview = String(data.preview);
        }
        break;
      }
      default:
        break;
    }
  }

  function payload() {
    const reasoning = String(trace.reasoning || "").trim();
    const tools = trace.tools.map((tool) => ({
      id: String(tool.id || ""),
      name: String(tool.name || ""),
      preview: String(tool.preview || ""),
      status: normalizeToolStatus(tool.status),
      duration: typeof tool.duration === "number" ? tool.duration : null,
      error: Boolean(tool.error)
    })).filter((tool) => tool.name);
    if (!reasoning && !tools.length) return null;
    return {
      ...(reasoning ? { reasoning } : {}),
      ...(tools.length ? { tools } : {})
    };
  }

  return { collect, payload };
}

function runIdForDedupKey(dedupKey) {
  return `local_${clientOpIdForDedupKey(dedupKey).replace(/^op_/, "")}`;
}

function triggerMessageIdForDedupKey(dedupKey) {
  return String(dedupKey || "").split(":")[0] || "";
}

function sanitizeFailureDetail(message) {
  let text = String(message || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "[redacted]")
    .replace(/\b((?:api[_-]?key|auth(?:orization)?|auth[_-]?token|token|password|secret)\s*[:=]\s*)(?:"[^"]+"|'[^']+'|[^\s,;]+)/gi, "$1[redacted]");
  return text.length > 600 ? `${text.slice(0, 597)}...` : text;
}

function userFacingFailureMessage(message) {
  const detail = sanitizeFailureDetail(message);
  const text = detail || String(message || "").trim();
  let summary = "本地模型运行失败";
  let advice = "请稍后重试或切换模型。";
  if (/(quota|exhaust|RESOURCE_EXHAUSTED|429|credit balance|insufficient credits?|insufficient quota|usage limit|billing|too many requests|rate limit)/i.test(text)) {
    summary = "模型配额已耗尽";
  } else if (/(unauthorized|authentication|auth|login|required to sign in|not logged in|invalid api key|api key invalid|401|403|credential|permission denied)/i.test(text)) {
    summary = "本地引擎认证失败";
    advice = "请检查登录状态、API Key 或切换模型。";
  } else if (/(model.*not found|unknown model|invalid model|model .* unavailable|not available for|unsupported model)/i.test(text)) {
    summary = "当前模型不可用";
  } else if (/(invalid config|config|settings|profile|not configured|missing .*config)/i.test(text)) {
    summary = "本地引擎配置有问题";
    advice = "请检查本地引擎配置或切换模型。";
  } else if (/(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|timed out|network|gateway|connection refused|connect .* failed)/i.test(text)) {
    summary = "本地引擎连接失败";
  }
  const reason = detail ? `原因：${detail}。` : "";
  return `我这次没能生成回复：${summary}。${reason}${advice}`;
}

function normalizedHistoryRole(role) {
  const value = String(role || "").trim();
  if (value === "assistant") return value;
  return "user";
}

function isGeneratedBotFailureText(content) {
  const text = String(content || "").trim();
  if (!text) return false;
  if (/^我这次没能生成回复：/.test(text)) return true;
  if (/^模型调用失败：/.test(text)) return true;
  if (/^[^\s]+ 当前离线，打开该设备上的 Mia 后再试。$/.test(text)) return true;
  return false;
}

function truncateHistoryContent(content) {
  const text = String(content || "").trim();
  if (text.length <= HISTORY_MESSAGE_CHAR_LIMIT) return text;
  return `${text.slice(0, Math.max(0, HISTORY_MESSAGE_CHAR_LIMIT - 1)).trimEnd()}…`;
}

function normalizeHistoryMessages(historyMessages) {
  const rows = (Array.isArray(historyMessages) ? historyMessages : [])
    .map((message) => ({
      role: normalizedHistoryRole(message?.role),
      content: truncateHistoryContent(message?.content)
    }))
    .filter((message) => !(message.role === "assistant" && isGeneratedBotFailureText(message.content)))
    .filter((message) => message.content)
    .slice(-HISTORY_MESSAGE_LIMIT);
  const selected = [];
  let total = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const message = rows[index];
    const nextTotal = total + message.content.length;
    if (selected.length && nextTotal > HISTORY_TOTAL_CHAR_LIMIT) break;
    selected.push(message);
    total = nextTotal;
  }
  return selected.reverse();
}

function normalizeResponderAttachments(attachments = []) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter((attachment) => attachment && typeof attachment === "object")
    .slice(0, 20);
}

function cloudFileUrlFromAttachment(attachment = {}) {
  const url = String(attachment.url || attachment.path || "").trim();
  return /^\/api\/files\/[A-Za-z0-9_-]+$/.test(url) ? url : "";
}

function dataUrlBuffer(value = "") {
  const match = String(value || "").trim().match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length || buffer.length > MAX_GENERATED_ATTACHMENT_BYTES) return null;
  return { mimeType: match[1] || "application/octet-stream", buffer };
}

function materializeFetchedAttachment(attachment = {}, fetched = {}, dir = "", index = 0) {
  const data = dataUrlBuffer(fetched.dataUrl);
  if (!data || !dir) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = sanitizeArtifactName(fetched.name || attachment.name || `attachment-${index + 1}`);
  const target = path.join(dir, `${index + 1}-${name}`);
  fs.writeFileSync(target, data.buffer, { mode: 0o600 });
  const mimeType = String(fetched.mimeType || fetched.mime || attachment.mimeType || attachment.mime || data.mimeType).trim();
  const kind = String(fetched.kind || attachment.kind || "").trim() || artifactKind({ mimeType, name });
  return {
    ...attachment,
    ...fetched,
    name,
    path: target,
    hostPath: target,
    mimeType,
    mime: mimeType,
    kind,
    type: fetched.type || attachment.type || kind,
    size: data.buffer.length
  };
}

async function materializeResponderAttachments(attachments = [], { fetchFileAttachment = null, dedupKey = "", log = () => {} } = {}) {
  const incoming = normalizeResponderAttachments(attachments);
  if (!incoming.length || typeof fetchFileAttachment !== "function") return incoming;
  const dir = path.join(os.tmpdir(), "mia-local-bot-attachments", sanitizeArtifactName(dedupKey || crypto.randomUUID(), "run"));
  const out = [];
  for (const [index, attachment] of incoming.entries()) {
    if (attachment.path || attachment.dataUrl || attachment.hostPath) {
      out.push(attachment);
      continue;
    }
    const url = cloudFileUrlFromAttachment(attachment);
    if (!url) {
      out.push(attachment);
      continue;
    }
    try {
      const fetched = await fetchFileAttachment({ url, name: attachment.name, id: attachment.id });
      if (fetched?.error) throw new Error(fetched.message || "fetch failed");
      const materialized = materializeFetchedAttachment(attachment, fetched, dir, index);
      out.push(materialized || attachment);
    } catch (error) {
      log(`[local-bot-responder] failed to materialize attachment ${url}: ${error?.message || error}`);
      out.push(attachment);
    }
  }
  return out;
}

function artifactMimeForPath(filePath = "", explicit = "") {
  const value = String(explicit || "").trim();
  if (value) return value;
  const ext = path.extname(String(filePath || "")).toLowerCase();
  const map = {
    ".csv": "text/csv",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".xls": "application/vnd.ms-excel",
    ".xlsm": "application/vnd.ms-excel.sheet.macroenabled.12",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip"
  };
  return map[ext] || "application/octet-stream";
}

function artifactKind({ mimeType = "", name = "" } = {}) {
  const mime = String(mimeType || "").toLowerCase();
  const fileName = String(name || "").toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/.test(fileName)) return "image";
  if (mime === "application/pdf" || /\.pdf$/.test(fileName)) return "pdf";
  if (mime.startsWith("text/") || /\.(txt|md|markdown|json|csv|tsv|log)$/.test(fileName)) return "text";
  return "file";
}

function sanitizeArtifactName(value, fallback = "artifact") {
  const base = path.basename(String(value || fallback)).replace(/[\x00-\x1f\x7f]/g, "").trim();
  const cleaned = base.replace(/[^\w.\- ()\[\]\u4e00-\u9fff]/g, "_").slice(0, 160);
  return cleaned || fallback;
}

function artifactIdFor(key) {
  return `generated:${crypto.createHash("sha1").update(String(key || "")).digest("hex").slice(0, 16)}`;
}

function parseDataUrlAttachment(input = {}) {
  const dataUrl = String(input.dataUrl || input.thumbnailDataUrl || "").trim();
  const match = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length || buffer.length > MAX_GENERATED_ATTACHMENT_BYTES) return null;
  const mimeType = String(input.mimeType || input.mime || match[1] || "application/octet-stream").trim();
  const name = sanitizeArtifactName(input.name || input.filename || "artifact");
  const kind = String(input.kind || input.type || "").trim() || artifactKind({ mimeType, name });
  return {
    id: String(input.id || artifactIdFor(`${name}:${buffer.length}:${match[2].slice(0, 64)}`)),
    type: kind,
    name,
    mimeType,
    mime: mimeType,
    size: buffer.length,
    kind,
    ...(kind === "image" ? { thumbnailDataUrl: dataUrl } : {}),
    dataUrl
  };
}

function localPathFromArtifact(input = {}) {
  const raw = String(input.path || input.filePath || input.file_path || input.hostPath || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return "";
  if (/^file:/i.test(raw)) {
    try {
      return fileURLToPath(raw);
    } catch {
      return "";
    }
  }
  return raw;
}

function normalizeGeneratedAttachment(input = {}, fsImpl = fs) {
  if (!input || typeof input !== "object") return null;
  const dataUrlOnly = parseDataUrlAttachment(input);
  const rawPath = localPathFromArtifact(input);
  if (!rawPath) return dataUrlOnly;
  const filePath = path.resolve(rawPath);
  let stat = null;
  try {
    stat = fsImpl.statSync(filePath);
  } catch {
    return dataUrlOnly;
  }
  if (!stat.isFile() || !stat.size || stat.size > MAX_GENERATED_ATTACHMENT_BYTES) return dataUrlOnly;
  const name = sanitizeArtifactName(input.name || input.filename || input.file_name || path.basename(filePath));
  const mimeType = artifactMimeForPath(name || filePath, input.mimeType || input.mime || input.content_type);
  const kind = String(input.kind || input.type || "").trim() || artifactKind({ mimeType, name });
  let dataUrl = String(input.dataUrl || "").trim();
  if (!dataUrl) {
    try {
      dataUrl = `data:${mimeType};base64,${fsImpl.readFileSync(filePath).toString("base64")}`;
    } catch {
      dataUrl = "";
    }
  }
  return {
    id: String(input.id || artifactIdFor(filePath)),
    type: kind,
    name,
    path: filePath,
    mimeType,
    mime: mimeType,
    size: stat.size,
    kind,
    ...(kind === "image" && dataUrl ? { thumbnailDataUrl: dataUrl } : {}),
    ...(dataUrl ? { dataUrl } : {})
  };
}

function walkArtifactObjects(value, out = []) {
  if (!value || out.length >= 40) return out;
  if (Array.isArray(value)) {
    for (const item of value) walkArtifactObjects(item, out);
    return out;
  }
  if (typeof value !== "object") return out;
  if (
    typeof (value.path || value.filePath || value.file_path || value.hostPath || value.dataUrl || value.thumbnailDataUrl) === "string"
  ) {
    out.push(value);
  }
  for (const key of ["attachments", "artifacts", "files", "generated_files", "generatedFiles", "outputs"]) {
    if (value[key]) walkArtifactObjects(value[key], out);
  }
  return out;
}

function resultArtifactInputs(result = {}) {
  const inputs = [];
  const message = result?.choices?.[0]?.message || result?.message || {};
  walkArtifactObjects(message.attachments, inputs);
  walkArtifactObjects(result.attachments, inputs);
  walkArtifactObjects(result.artifacts, inputs);
  walkArtifactObjects(result.files, inputs);
  walkArtifactObjects(result.generated_files, inputs);
  walkArtifactObjects(result.generatedFiles, inputs);
  for (const event of Array.isArray(result.events) ? result.events : []) walkArtifactObjects(event, inputs);
  return inputs;
}

function resolveArtifactWorkspaceDir(provider) {
  try {
    const value = typeof provider === "function" ? provider() : provider;
    const dir = String(value || "").trim();
    return dir ? path.resolve(dir) : "";
  } catch {
    return "";
  }
}

function isArtifactCandidate(filePath) {
  return GENERATED_ARTIFACT_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase());
}

function scanArtifactWorkspace(workspaceDir, fsImpl = fs) {
  const root = resolveArtifactWorkspaceDir(workspaceDir);
  if (!root) return [];
  let rootStat = null;
  try {
    rootStat = fsImpl.statSync(root);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];
  const files = [];
  function walk(dir, depth) {
    if (depth > ARTIFACT_SCAN_MAX_DEPTH || files.length >= ARTIFACT_SCAN_MAX_FILES) return;
    let entries = [];
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= ARTIFACT_SCAN_MAX_FILES) return;
      if (!entry || entry.isSymbolicLink?.()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ARTIFACT_SKIP_DIRS.has(entry.name)) walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isArtifactCandidate(fullPath)) continue;
      try {
        const stat = fsImpl.statSync(fullPath);
        if (stat.isFile() && stat.size > 0 && stat.size <= MAX_GENERATED_ATTACHMENT_BYTES) {
          files.push({ path: path.resolve(fullPath), mtimeMs: stat.mtimeMs, size: stat.size });
        }
      } catch {
        // Ignore files that disappear while the agent is still writing.
      }
    }
  }
  walk(root, 0);
  return files;
}

function snapshotArtifactWorkspace(workspaceDir, fsImpl = fs) {
  const snapshot = new Map();
  for (const file of scanArtifactWorkspace(workspaceDir, fsImpl)) {
    snapshot.set(file.path, { mtimeMs: file.mtimeMs, size: file.size });
  }
  return snapshot;
}

function workspaceArtifactInputs({ workspaceDir, beforeSnapshot, startedAtMs, fsImpl = fs } = {}) {
  const before = beforeSnapshot instanceof Map ? beforeSnapshot : new Map();
  const threshold = Number(startedAtMs || 0) - 5000;
  return scanArtifactWorkspace(workspaceDir, fsImpl).filter((file) => {
    const previous = before.get(file.path);
    if (previous && previous.mtimeMs === file.mtimeMs && previous.size === file.size) return false;
    return file.mtimeMs >= threshold;
  }).map((file) => ({ path: file.path }));
}

function collectGeneratedAttachments({ result, workspaceDir, beforeSnapshot, startedAtMs, fsImpl = fs } = {}) {
  const inputs = [
    ...resultArtifactInputs(result || {}),
    ...workspaceArtifactInputs({ workspaceDir, beforeSnapshot, startedAtMs, fsImpl })
  ];
  const attachments = [];
  const seen = new Set();
  for (const input of inputs) {
    if (attachments.length >= 20) break;
    const attachment = normalizeGeneratedAttachment(input, fsImpl);
    if (!attachment) continue;
    const key = attachment.path || attachment.dataUrl || attachment.id || attachment.name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    attachments.push(attachment);
  }
  return attachments;
}

// Composer "使用" chips travel with the user's cloud message (skills_json). Pull
// the selected skill ids off the triggering message so the responder can drive
// the agent with them — one source of truth, works across devices.
function activeSkillIdsFromMessage(message) {
  const raw = message && message.skills_json;
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const ids = [];
  const seen = new Set();
  for (const skill of parsed) {
    if (ids.length >= 16) break;
    // Accept only a plain string id or a { id: string } object — never coerce
    // arbitrary objects/numbers (which would stringify to junk skill ids).
    const value = typeof skill === "string" ? skill : (skill && typeof skill.id === "string" ? skill.id : "");
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeMessageSeq(message) {
  const value = Number(message?.seq);
  return Number.isFinite(value) ? value : 0;
}

function isStoppedError(error, signal) {
  return Boolean(signal?.aborted || error?.code === "MIA_STOPPED");
}

function elapsedMs(startedAt) {
  return `${Math.max(0, Date.now() - startedAt)}ms`;
}

function hasBotReplyAfterTrigger(messages, { botId, triggerSeq, triggerMessageId, turnId }) {
  const rows = Array.isArray(messages) ? messages : [];
  const targetBot = String(botId || "");
  const targetTurn = String(turnId || "");
  const triggerId = String(triggerMessageId || "");
  const afterSeq = Number(triggerSeq) || 0;
  for (const message of rows) {
    if (!message || String(message.sender_kind || "") !== "bot") continue;
    if (targetBot && String(message.sender_ref || "") !== targetBot) continue;
    if (afterSeq && normalizeMessageSeq(message) <= afterSeq) continue;
    if (targetTurn && String(message.turn_id || "") === targetTurn) return true;
    const body = String(message.body_md || "").trim();
    const createdAt = String(message.created_at || "").trim();
    if (!targetTurn && (body || createdAt)) return true;
    if (triggerId && String(message.trigger_message_id || "") === triggerId) return true;
  }
  return false;
}

function createLocalBotResponder({ sendChat, postConversationMessageAsBot, listConversationMessages = null, emitCloudEvent = () => {}, log = () => {}, artifactWorkspaceDir = null, fetchFileAttachment = null }) {
  const processed = new Set();
  const inFlight = new Set();
  const activeRunsByConversation = new Map();
  const queuedInvocationsByConversation = new Map();

  function remember(key) {
    processed.add(key);
    if (processed.size > PROCESSED_CAP) processed.delete(processed.values().next().value);
  }

  function clearActiveRun(conversationId, dedupKey) {
    const entry = activeRunsByConversation.get(conversationId);
    if (entry && entry.dedupKey === dedupKey) activeRunsByConversation.delete(conversationId);
  }

  function queueInvocation(args, activeRun) {
    const conversationId = String(args?.conversationId || "").trim();
    const dedupKey = String(args?.dedupKey || "").trim();
    if (!conversationId || !dedupKey) return false;
    queuedInvocationsByConversation.set(conversationId, { ...args });
    log(`[local-bot-responder] queue ${dedupKey}: conversation ${conversationId} already has active run ${activeRun?.runId || ""}`);
    return true;
  }

  function drainQueuedInvocation(conversationId) {
    const queued = queuedInvocationsByConversation.get(conversationId);
    if (!queued) return;
    queuedInvocationsByConversation.delete(conversationId);
    Promise.resolve()
      .then(() => respond(queued))
      .catch((error) => {
        log(`[local-bot-responder] queued run failed: ${error?.message || error}`);
      });
  }

  function emitRunEvent(entry, event = {}) {
    if (!entry || !event?.type) return;
    emitCloudEvent({
      type: "cloud_agent_run_event",
      runId: entry.runId,
      conversationId: entry.conversationId,
      botId: entry.botId,
      event
    });
  }

  function clearCancelDrainTimer(entry) {
    if (!entry?.cancelDrainTimer) return;
    clearTimeout(entry.cancelDrainTimer);
    entry.cancelDrainTimer = null;
  }

  function markRunTerminal(entry) {
    if (!entry) return;
    entry.finalized = true;
    clearCancelDrainTimer(entry);
    inFlight.delete(entry.dedupKey);
    clearActiveRun(entry.conversationId, entry.dedupKey);
    drainQueuedInvocation(entry.conversationId);
  }

  function finishCancelledRun(entry, event = {}) {
    if (!entry || entry.finalized) return false;
    entry.status = "cancelled";
    emitRunEvent(entry, { type: "run.cancelled", ...event });
    remember(entry.dedupKey);
    markRunTerminal(entry);
    return true;
  }

  function scheduleCancelDrainTimeout(entry) {
    if (!entry || entry.cancelDrainTimer) return;
    entry.cancelDrainTimer = setTimeout(() => {
      const active = activeRunsByConversation.get(entry.conversationId);
      if (active !== entry || entry.finalized) return;
      log(`[local-bot-responder] cancel drain timed out for ${entry.runId}`);
      finishCancelledRun(entry, { reason: "cancel_timeout" });
    }, CANCEL_DRAIN_TIMEOUT_MS);
    entry.cancelDrainTimer?.unref?.();
  }

  function stoppedRunResult(entry) {
    return {
      stopped: true,
      conversationId: entry.conversationId,
      runId: entry.runId,
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
      status: "cancelling"
    };
  }

  function stopActiveConversationRun(payload = {}) {
    const conversationId = String(payload?.conversationId || "").trim();
    const runId = String(payload?.runId || "").trim();
    const turnId = String(payload?.turnId || payload?.turn_id || "").trim();
    const candidates = conversationId
      ? [activeRunsByConversation.get(conversationId)].filter(Boolean)
      : [...activeRunsByConversation.values()];
    const entry = candidates.find((item) => {
      if (!item || item.finalized) return false;
      if (turnId) return item.turnId === turnId;
      return !runId || item.runId === runId;
    });
    if (!entry) return { stopped: false };
    if (entry.status === "cancelling" || entry.abortController.signal.aborted) {
      return stoppedRunResult(entry);
    }
    entry.status = "cancelling";
    entry.cancelRequestedAt = new Date().toISOString();
    emitRunEvent(entry, { type: "run.cancelling" });
    scheduleCancelDrainTimeout(entry);
    entry.abortController.abort();
    return stoppedRunResult(entry);
  }

  function emitPostedMessage(conversationId, result) {
    const message = postedMessageFromResult(result);
    if (!conversationId || !message?.id) return;
    emitCloudEvent({
      type: CloudEvent.ConversationMessageAppended,
      conversationId,
      message
    });
  }

  async function postFailureMessage({ conversationId, botId, dedupKey, turnId, stage, error }) {
    const message = String(error?.message || error || "unknown error");
    try {
      const result = await postConversationMessageAsBot(conversationId, {
        botId,
        bodyMd: userFacingFailureMessage(message),
        turnId,
        errorJson: { stage, message },
        clientOpId: errorClientOpIdForDedupKey(dedupKey)
      });
      if (result && result.ok === false) throw new Error(result.error || result.message || "post failed");
      emitPostedMessage(conversationId, result);
      return true;
    } catch (postError) {
      log(`[local-bot-responder] failure post failed: ${postError?.message || postError}`);
      return false;
    }
  }

  function isGroupConversation(conversationId, conversationType = "") {
    const type = String(conversationType || "").trim();
    if (type) return type === "group";
    const id = String(conversationId || "").trim();
    return id.startsWith("g_") || id.startsWith("g-");
  }

  async function replyAlreadyExists({ conversationId, botId, triggerSeq, triggerMessageId, turnId }) {
    if (typeof listConversationMessages !== "function") return false;
    const sinceSeq = Math.max(0, (Number(triggerSeq) || 0) - 1);
    try {
      const result = await listConversationMessages(conversationId, sinceSeq, 50);
      const messages = Array.isArray(result?.messages) ? result.messages : (Array.isArray(result) ? result : []);
      return hasBotReplyAfterTrigger(messages, { botId, triggerSeq, triggerMessageId, turnId });
    } catch (error) {
      log(`[local-bot-responder] reply existence check failed: ${error?.message || error}`);
      return false;
    }
  }

  async function respond({ conversationId, conversationType = "", botId, botSnapshot = null, dedupKey, triggerMessageId = "", triggerSeq = 0, systemPrompt, historyMessages = [], userPrompt, userAttachments = [], turnId = null, runtimeConfig = null, activeSkillIds = [] }) {
    if (!conversationId || !botId || !dedupKey) return;
    if (processed.has(dedupKey)) return;
    if (inFlight.has(dedupKey)) return;
    const requestStartedAt = Date.now();
    const activeRun = activeRunsByConversation.get(conversationId);
    if (activeRun && !activeRun.finalized) {
      queueInvocation({ conversationId, conversationType, botId, botSnapshot, dedupKey, triggerMessageId, triggerSeq, systemPrompt, historyMessages, userPrompt, userAttachments, turnId, runtimeConfig, activeSkillIds }, activeRun);
      return false;
    }
    inFlight.add(dedupKey);

    const resolvedTriggerMessageId = triggerMessageId || triggerMessageIdForDedupKey(dedupKey);
    if (await replyAlreadyExists({ conversationId, botId, triggerSeq, triggerMessageId: resolvedTriggerMessageId, turnId })) {
      remember(dedupKey);
      inFlight.delete(dedupKey);
      return false;
    }

    let text = "";
    let generatedAttachments = [];
    const runId = runIdForDedupKey(dedupKey);
    const abortController = new AbortController();
    const { signal } = abortController;
    const runEntry = {
      conversationId,
      runId,
      turnId: String(turnId || ""),
      botId,
      dedupKey,
      abortController,
      status: "running",
      startedAt: new Date().toISOString(),
      cancelRequestedAt: "",
      cancelDrainTimer: null,
      finalized: false
    };
    activeRunsByConversation.set(conversationId, runEntry);
    log(`[local-bot-responder] run ${runId} start bot=${botId} conversation=${conversationId} preflight=${elapsedMs(requestStartedAt)}`);
    const trace = createTraceCollector();
    const contentBlocks = createAssistantContentBlockCollector();
    emitCloudEvent({
      type: "cloud_agent_run_started",
      runId,
      turnId,
      conversationId,
      botId,
      triggerMessageId: resolvedTriggerMessageId
    });
    try {
      const artifactWorkspace = resolveArtifactWorkspaceDir(artifactWorkspaceDir);
      const artifactStartedAt = Date.now();
      const artifactSnapshot = artifactWorkspace
        ? snapshotArtifactWorkspace(artifactWorkspace)
        : new Map();
      const currentUserMessage = { role: "user", content: userPrompt || "" };
      const currentUserAttachments = await materializeResponderAttachments(userAttachments, { fetchFileAttachment, dedupKey, log });
      if (currentUserAttachments.length) currentUserMessage.attachments = currentUserAttachments;
      const chatArgs = {
        botKey: botId,
        botId,
        sessionId: `conversation:${conversationId}`,
        messages: [
          { role: "system", content: systemPrompt || "" },
          ...normalizeHistoryMessages(historyMessages),
          currentUserMessage
        ],
        group: isGroupConversation(conversationId, conversationType),
        utility: true,
        // Keep the native agent session attached to this Mia conversation. The
        // app conversation owns visible history; the agent runtime owns warm
        // thread/session state, matching ACP-style backends.
        persistAgentSession: true,
        allowSlashCommands: false,
        signal,
        abortController
      };
      if (botSnapshot && typeof botSnapshot === "object") chatArgs.botSnapshot = botSnapshot;
      if (runtimeConfig && typeof runtimeConfig === "object") chatArgs.runtimeConfig = runtimeConfig;
      // Composer skill chips that rode in on the triggering message: merge them
      // into this turn so the chip actually reaches the engine (sendChat folds
      // them into capabilities.enabledSkills and prepends a "use these" directive).
      if (Array.isArray(activeSkillIds) && activeSkillIds.length) chatArgs.activeSkillIds = activeSkillIds;
      const sendStartedAt = Date.now();
      let firstEngineEventLogged = false;
      chatArgs.emit = (kind, data = {}) => {
        if (!kind || kind === "session_started") return;
        if (!firstEngineEventLogged) {
          firstEngineEventLogged = true;
          log(`[local-bot-responder] run ${runId} first engine event=${kind} send=${elapsedMs(sendStartedAt)} total=${elapsedMs(requestStartedAt)}`);
        }
        trace.collect(kind, data);
        contentBlocks.collect(kind, data);
        emitCloudEvent({
          type: "cloud_agent_run_event",
          runId,
          conversationId,
          botId,
          event: { type: kind, ...(data && typeof data === "object" ? data : {}) }
        });
      };
      const result = await sendChat(chatArgs);
      log(`[local-bot-responder] run ${runId} sendChat completed send=${elapsedMs(sendStartedAt)} total=${elapsedMs(requestStartedAt)}`);
      if (runEntry.finalized) return true;
      if (signal.aborted || runEntry.status === "cancelling") {
        finishCancelledRun(runEntry);
        return true;
      }
      generatedAttachments = collectGeneratedAttachments({
        result,
        workspaceDir: artifactWorkspace,
        beforeSnapshot: artifactSnapshot,
        startedAtMs: artifactStartedAt
      });
      text = responseText(result);
    } catch (error) {
      if (runEntry.finalized) return true;
      if (isStoppedError(error, signal)) {
        log(`[local-bot-responder] engine stopped: ${error?.message || error}`);
        finishCancelledRun(runEntry);
        return true;
      }
      log(`[local-bot-responder] engine failed: ${error?.message || error}`);
      emitRunEvent(runEntry, { type: "run.failed", error: String(error?.message || error) });
      const didPostFailure = await postFailureMessage({
        conversationId,
        botId,
        dedupKey,
        turnId,
        stage: "engine",
        error
      });
      if (didPostFailure) remember(dedupKey);
      markRunTerminal(runEntry);
      return didPostFailure;
    }
    if (runEntry.finalized) return true;
    if (!text && generatedAttachments.length) {
      text = "已生成文件。";
    }

    if (!text) {
      emitRunEvent(runEntry, { type: "run.failed", error: "empty response" });
      // The engine ran but produced no text (e.g. a tool permission was denied
      // or the turn ended on tool calls only). Post a visible bubble instead of
      // returning silently, so the bot never looks like a dead no-op.
      const didPostEmpty = await postFailureMessage({
        conversationId,
        botId,
        dedupKey,
        turnId,
        stage: "empty",
        error: new Error("本地模型这次没有产生任何文本回复（可能是工具权限被拒，或本轮只调用了工具）")
      });
      if (didPostEmpty) remember(dedupKey);
      markRunTerminal(runEntry);
      return didPostEmpty;
    }

    try {
      const tracePayload = trace.payload();
      const contentBlocksPayload = contentBlocks.payload(text);
      const result = await postConversationMessageAsBot(conversationId, {
        botId,
        bodyMd: text,
        turnId,
        clientOpId: clientOpIdForDedupKey(dedupKey),
        ...(generatedAttachments.length ? { attachments: generatedAttachments } : {}),
        ...(tracePayload ? { trace: tracePayload } : {}),
        ...(contentBlocksPayload.length ? { contentBlocks: contentBlocksPayload } : {})
      });
      if (result && result.ok === false) throw new Error(result.error || result.message || "post failed");
      emitPostedMessage(conversationId, result);
      remember(dedupKey);
      markRunTerminal(runEntry);
      return true;
    } catch (error) {
      log(`[local-bot-responder] post failed: ${error?.message || error}`);
      emitRunEvent(runEntry, { type: "run.failed", error: String(error?.message || error) });
      markRunTerminal(runEntry);
      return false;
    }
  }

  return { respond, stopActiveConversationRun };
}

module.exports = {
  activeSkillIdsFromMessage,
  clientOpIdForDedupKey,
  createLocalBotResponder,
  isGeneratedBotFailureText,
  postedMessageFromResult,
  runIdForDedupKey,
  responseText,
  shouldHandleLocalCloudConversationAi
};
