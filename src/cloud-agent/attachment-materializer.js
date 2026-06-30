const fs = require("node:fs");
const path = require("node:path");

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
const WORKER_FILE_PATH_PATTERN = /\/data\/(?:workspace|home|attachments|hermes-home)\/[^\s"'`<>\])]+/gu;
const WORKER_GENERATED_FILE_PATH_PATTERN = /\/data\/(?:workspace|home)\/[^\s"'`<>\])]+/gu;
const FILE_DELIVERY_REQUEST_PATTERN = /(?:发给我|发我|发一下|发来|给我|传给我|发送|分享|下载|导出|send|share|attach|download)/iu;
const TRAILING_PATH_PUNCTUATION = /[.,，。:：;；!?！？]+$/u;

function sanitizeAttachmentName(value, fallback = "attachment") {
  const base = path.basename(String(value || "").replace(/[\x00-\x1f\x7f]/g, "").trim());
  const cleaned = base.replace(/[^\w.\- ()\[\]\u4e00-\u9fff]/g, "_").slice(0, 160);
  return cleaned || fallback;
}

function attachmentKind(input = {}) {
  const mime = String(input.mimeType || input.mime || "").toLowerCase();
  const name = String(input.name || "").toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/.test(name)) return "image";
  if (mime.startsWith("text/") || /\.(txt|md|markdown|json|csv|tsv|log|js|ts|tsx|jsx|css|html|xml|yaml|yml)$/i.test(name)) return "text";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  return "file";
}

function parseAttachmentsFromMessage(message = {}) {
  if (Array.isArray(message.attachments)) return message.attachments;
  if (!message.attachments_json) return [];
  try {
    const parsed = JSON.parse(String(message.attachments_json || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) return null;
  return { mimeType: match[1], buffer };
}

function cloudFileIdFromAttachment(attachment = {}) {
  const url = String(attachment.url || "").trim();
  const urlMatch = url.match(/^\/api\/files\/([A-Za-z0-9_-]+)$/);
  if (urlMatch) return urlMatch[1];
  const id = String(attachment.id || "").trim();
  return /^file_[A-Za-z0-9_-]+$/.test(id) ? id : "";
}

function safeJoin(root, fileName) {
  const target = path.join(root, fileName);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Unsafe attachment target path.");
  }
  return target;
}

function textPreviewForAttachment(attachment = {}, fsImpl = fs) {
  if (attachment.kind !== "text" || !attachment.hostPath) return "";
  let stat = null;
  try {
    stat = fsImpl.statSync(attachment.hostPath);
  } catch {
    return "";
  }
  if (!stat.isFile() || stat.size > MAX_TEXT_PREVIEW_BYTES) return "";
  try {
    return fsImpl.readFileSync(attachment.hostPath, "utf8").slice(0, 12000);
  } catch {
    return "";
  }
}

function attachmentSummaryLine(attachment, index) {
  const parts = [
    `附件 ${index + 1}: ${attachment.name || "attachment"}`,
    `类型=${attachment.mimeType || attachment.kind || "unknown"}`,
    `大小=${attachment.size || 0} bytes`,
    `路径=${attachment.path}`
  ];
  return `- ${parts.join("；")}`;
}

function attachmentContext(attachments = [], fsImpl = fs) {
  const visible = attachments.filter((item) => item?.path || item?.name);
  if (!visible.length) return "";
  const lines = [
    "本轮用户附带了以下附件。你可以在云端 worker 内直接读取这些容器路径；这些路径只属于当前用户，不能假设可访问其他用户文件。",
    ...visible.map(attachmentSummaryLine)
  ];
  const previews = visible
    .map((attachment, index) => {
      const preview = textPreviewForAttachment(attachment, fsImpl);
      return preview ? `附件 ${index + 1} 文本预览（${attachment.name}）：\n${preview}` : "";
    })
    .filter(Boolean);
  return [...lines, ...previews].join("\n\n");
}

function inputWithAttachmentContext(text, attachments = [], fsImpl = fs) {
  const context = attachmentContext(attachments, fsImpl);
  return [String(text || ""), context ? `附件上下文：\n${context}` : ""].filter(Boolean).join("\n\n");
}

function trimWorkerFilePath(value = "") {
  let candidate = String(value || "").trim();
  while (candidate && TRAILING_PATH_PUNCTUATION.test(candidate)) {
    candidate = candidate.slice(0, -1);
  }
  return candidate;
}

function workerFilePathsFromText(text = "", pattern = WORKER_FILE_PATH_PATTERN) {
  const out = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(pattern)) {
    const candidate = trimWorkerFilePath(match[0]);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

function collectWorkerFilePathMentions(value, out = []) {
  if (typeof value === "string") {
    for (const filePath of workerFilePathsFromText(value, WORKER_GENERATED_FILE_PATH_PATTERN)) out.push({ path: filePath });
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectWorkerFilePathMentions(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const item of Object.values(value)) collectWorkerFilePathMentions(item, out);
  return out;
}

function workerFileArtifactsForDeliveryRequest(text = "") {
  const input = String(text || "");
  if (!FILE_DELIVERY_REQUEST_PATTERN.test(input)) return [];
  return workerFilePathsFromText(input, WORKER_GENERATED_FILE_PATH_PATTERN)
    .map((filePath) => ({ path: filePath }));
}

function walkArtifacts(value, out = []) {
  if (!value || out.length >= 20) return out;
  if (Array.isArray(value)) {
    for (const item of value) walkArtifacts(item, out);
    return out;
  }
  if (typeof value !== "object") return out;
  const pathValue = value.path || value.file_path || value.filePath;
  if (typeof pathValue === "string" && pathValue.trim()) {
    out.push({
      path: pathValue,
      name: value.name || value.filename || value.file_name || "",
      mimeType: value.mimeType || value.mime || value.content_type || "",
      type: value.type || value.kind || ""
    });
  }
  for (const key of ["attachments", "artifacts", "files", "generated_files", "generatedFiles", "outputs"]) {
    if (value[key]) walkArtifacts(value[key], out);
  }
  return out;
}

function resultArtifacts(result = {}) {
  const artifacts = [];
  walkArtifacts(result.attachments, artifacts);
  walkArtifacts(result.artifacts, artifacts);
  walkArtifacts(result.files, artifacts);
  for (const event of Array.isArray(result.events) ? result.events : []) {
    walkArtifacts(event, artifacts);
  }
  collectWorkerFilePathMentions(result, artifacts);
  const seen = new Set();
  return artifacts.filter((item) => {
    const key = String(item.path || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

function hostPathForWorkerArtifact(workerPaths = {}, artifactPath = "") {
  const raw = String(artifactPath || "").trim();
  if (!raw || /^https?:\/\//i.test(raw)) return "";
  const root = workerPaths.root ? path.resolve(workerPaths.root) : "";
  if (!root) return "";
  let candidate = "";
  if (raw === "/data") candidate = root;
  else if (raw.startsWith("/data/")) candidate = path.join(root, raw.slice("/data/".length));
  else if (!path.isAbsolute(raw)) candidate = path.join(workerPaths.workspace || path.join(root, "workspace"), raw);
  else return "";
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return resolved;
}

function attachmentNameForArchivedArtifact(artifact = {}, realPath = "") {
  const rawExplicit = String(artifact.name || "").trim();
  const explicit = rawExplicit ? sanitizeAttachmentName(rawExplicit, "") : "";
  const basename = realPath ? sanitizeAttachmentName(path.basename(String(realPath || "")), "") : "";
  if (!explicit || /^file_[A-Za-z0-9_-]+$/.test(explicit)) return basename || explicit || "attachment";
  return explicit;
}

function createAttachmentMaterializer(deps = {}) {
  const cloudStore = deps.cloudStore;
  const fsImpl = deps.fs || fs;

  function materialize(args = {}) {
    if (!cloudStore) return { attachments: [], dir: "", input: String(args.text || "") };
    const userId = String(args.userId || "").trim();
    const workerPaths = args.workerPaths || {};
    const incoming = Array.isArray(args.attachments) ? args.attachments.slice(0, 20) : [];
    if (!userId || !workerPaths.attachments || !incoming.length) {
      return { attachments: [], dir: "", input: String(args.text || "") };
    }
    const runSegment = sanitizeAttachmentName(args.runId || `run-${Date.now()}`, "run");
    const runDir = path.join(workerPaths.attachments, runSegment);
    fsImpl.mkdirSync(runDir, { recursive: true, mode: 0o700 });

    const materialized = [];
    for (const [index, attachment] of incoming.entries()) {
      const declaredName = sanitizeAttachmentName(attachment.name || `attachment-${index + 1}`);
      const cloudFileId = cloudFileIdFromAttachment(attachment);
      const dataUrl = dataUrlToBuffer(attachment.dataUrl);
      let sourceFile = null;
      let sourceBuffer = null;
      let mimeType = String(attachment.mimeType || attachment.mime || "").trim();
      let size = 0;

      if (dataUrl) {
        sourceBuffer = dataUrl.buffer;
        mimeType = mimeType || dataUrl.mimeType;
        size = sourceBuffer.length;
      } else if (cloudFileId) {
        sourceFile = cloudStore.getFileForUser(userId, cloudFileId);
        if (!sourceFile || !sourceFile.path) continue;
        mimeType = mimeType || sourceFile.mimeType || sourceFile.mime || "";
        size = Number(sourceFile.size || 0);
      } else {
        continue;
      }

      const name = sanitizeAttachmentName(sourceFile?.name || declaredName, `attachment-${index + 1}`);
      const target = safeJoin(runDir, `${index + 1}-${name}`);
      if (sourceBuffer) {
        fsImpl.writeFileSync(target, sourceBuffer, { mode: 0o600 });
      } else {
        const stat = fsImpl.statSync(sourceFile.path);
        if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) continue;
        fsImpl.copyFileSync(sourceFile.path, target);
        fsImpl.chmodSync(target, 0o600);
        size = stat.size;
      }
      const publicPath = `/data/attachments/${runSegment}/${path.basename(target)}`;
      materialized.push({
        id: cloudFileId || String(attachment.id || `attachment-${index + 1}`),
        name,
        mimeType,
        size,
        kind: attachmentKind({ mimeType, name }),
        path: publicPath,
        hostPath: target
      });
    }

    return {
      attachments: materialized,
      dir: runDir,
      input: inputWithAttachmentContext(args.text || "", materialized, fsImpl)
    };
  }

  function archiveGeneratedAttachments(args = {}) {
    if (!cloudStore || typeof cloudStore.saveLocalFileForUser !== "function") return [];
    const userId = String(args.userId || "").trim();
    const workerPaths = args.workerPaths || {};
    if (!userId || !workerPaths.root) return [];
    const rootReal = fsImpl.realpathSync(workerPaths.root);
    const attachments = [];
    for (const artifact of resultArtifacts(args.result || {})) {
      const hostPath = hostPathForWorkerArtifact(workerPaths, artifact.path);
      if (!hostPath) continue;
      let realPath = "";
      let stat = null;
      try {
        realPath = fsImpl.realpathSync(hostPath);
        stat = fsImpl.statSync(realPath);
      } catch {
        continue;
      }
      const relative = path.relative(rootReal, realPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      if (!stat.isFile() || !stat.size || stat.size > MAX_ATTACHMENT_BYTES) continue;
      const name = attachmentNameForArchivedArtifact(artifact, realPath);
      const mimeType = String(artifact.mimeType || "").trim() || mimeForName(name);
      const kind = attachmentKind({ mimeType, name });
      const saved = cloudStore.saveLocalFileForUser(userId, {
        path: realPath,
        name,
        mimeType,
        type: kind
      });
      if (saved) attachments.push({
        id: saved.id,
        type: saved.type || kind,
        name: saved.name,
        mimeType: saved.mimeType,
        size: saved.size || stat.size,
        url: saved.url
      });
    }
    return attachments;
  }

  return { materialize, archiveGeneratedAttachments };
}

function redactGeneratedArtifactPaths(text = "", attachments = []) {
  const names = (Array.isArray(attachments) ? attachments : [])
    .map((item) => String(item?.name || "").trim())
    .filter(Boolean);
  let index = 0;
  return String(text || "").replace(WORKER_FILE_PATH_PATTERN, (match) => {
    const candidate = trimWorkerFilePath(match);
    const suffix = match.slice(candidate.length);
    const name = names[index] || names[0] || "";
    index += 1;
    return `${name ? `附件「${name}」` : "内部文件"}${suffix}`;
  });
}

function redactGeneratedArtifactPathsInValue(value, attachments = []) {
  if (typeof value === "string") return redactGeneratedArtifactPaths(value, attachments);
  if (Array.isArray(value)) return value.map((item) => redactGeneratedArtifactPathsInValue(item, attachments));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redactGeneratedArtifactPathsInValue(item, attachments);
  }
  return out;
}

function mimeForName(name) {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".pdf") return "application/pdf";
  if (attachmentKind({ name }) === "text") return "text/plain";
  return "application/octet-stream";
}

module.exports = {
  createAttachmentMaterializer,
  parseAttachmentsFromMessage,
  attachmentContext,
  inputWithAttachmentContext,
  resultArtifacts,
  hostPathForWorkerArtifact,
  workerFileArtifactsForDeliveryRequest,
  redactGeneratedArtifactPaths,
  redactGeneratedArtifactPathsInValue
};
