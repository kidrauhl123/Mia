"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

function createChatAttachments({
  initializeRuntime,
  runtimePaths,
  getCloudSettings,
  normalizeCloudUrl,
  fetchImpl = fetch,
  timeoutSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  randomUUID = () => crypto.randomUUID(),
  now = () => Date.now()
}) {
  function mimeToExtension(mimeValue) {
    const mime = String(mimeValue || "").toLowerCase();
    if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
    if (mime.includes("png")) return ".png";
    if (mime.includes("webp")) return ".webp";
    if (mime.includes("gif")) return ".gif";
    if (mime.includes("pdf")) return ".pdf";
    if (mime.includes("json")) return ".json";
    if (mime.includes("markdown")) return ".md";
    if (mime.startsWith("text/")) return ".txt";
    return "";
  }

  function dataUrlToBuffer(value) {
    const match = String(value || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/);
    if (!match) return null;
    const mime = match[1] || "image/png";
    const data = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
    return { data, ext: mimeToExtension(mime), mime };
  }

  function sanitizeAttachmentName(value, fallback = "attachment") {
    const raw = path.basename(String(value || fallback)).replace(/[^\w.\-()[\] \u4e00-\u9fff]+/g, "_").trim();
    return raw || fallback;
  }

  function normalizeAttachmentDataUrl(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.length > 35 * 1024 * 1024) return "";
    if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(raw)) return "";
    return raw.replace(/\s+/g, "");
  }

  function normalizeAttachmentThumbnail(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.length > 700 * 1024) return "";
    if (!/^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i.test(raw)) return "";
    return raw.replace(/\s+/g, "");
  }

  function attachmentKind({ mime = "", name = "" } = {}) {
    const type = String(mime || "").toLowerCase();
    const ext = path.extname(String(name || "")).toLowerCase();
    if (type.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    if (type.includes("pdf") || ext === ".pdf") return "pdf";
    if (type.startsWith("text/") || [".txt", ".md", ".json", ".csv", ".log", ".js", ".ts", ".tsx", ".jsx", ".py", ".html", ".css"].includes(ext)) return "text";
    return "file";
  }

  function normalizeAttachment(input = {}) {
    const rawPath = String(input.path || "").trim();
    let filePath = rawPath;
    if (/^file:/i.test(filePath)) {
      try {
        filePath = fileURLToPath(filePath);
      } catch {
        filePath = "";
      }
    }
    const name = sanitizeAttachmentName(input.name || filePath || "attachment");
    const mime = String(input.mime || input.type || "").trim();
    const size = Number(input.size) || (filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);
    const kind = String(input.kind || "").trim() || attachmentKind({ mime, name });
    const thumbnailDataUrl = normalizeAttachmentThumbnail(input.thumbnailDataUrl || input.thumbnail || input.previewDataUrl);
    const dataUrl = normalizeAttachmentDataUrl(input.dataUrl);
    const url = String(input.url || "").trim();
    const next = {
      id: String(input.id || randomUUID()),
      name,
      path: filePath,
      mime,
      size,
      kind
    };
    if (/^\/api\/files\/[a-zA-Z0-9_-]+$/.test(url) || /^https?:\/\//i.test(url)) next.url = url;
    if (thumbnailDataUrl && kind === "image") next.thumbnailDataUrl = thumbnailDataUrl;
    if (dataUrl && kind === "image") next.dataUrl = dataUrl;
    return next;
  }

  function normalizeAttachments(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).map(normalizeAttachment).filter((item) => item.name || item.path);
  }

  function cloudDownloadCachePath() {
    return path.join(runtimePaths().attachmentsDir, ".cloud-download-cache.json");
  }

  function defaultCloudDownloadCache() {
    return {
      version: 1,
      files: {}
    };
  }

  function cloudDownloadCacheKeys(urlPath) {
    const cleanPath = String(urlPath || "").trim();
    if (!/^\/api\/files\/[a-zA-Z0-9_-]+$/.test(cleanPath)) return [];
    const settings = getCloudSettings?.() || {};
    const normalizedBase = String(settings?.url || "").trim() ? normalizeCloudUrl(settings.url) : "";
    return [...new Set([
      normalizedBase ? `${normalizedBase}${cleanPath}` : "",
      cleanPath
    ].filter(Boolean))];
  }

  function readCloudDownloadCache() {
    initializeRuntime();
    const filePath = cloudDownloadCachePath();
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return {
        version: 1,
        files: parsed?.files && typeof parsed.files === "object" ? parsed.files : {}
      };
    } catch {
      return defaultCloudDownloadCache();
    }
  }

  function writeCloudDownloadCache(store = defaultCloudDownloadCache()) {
    const filePath = cloudDownloadCachePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  }

  function rememberCloudDownload(input = {}, saved = {}) {
    const keys = cloudDownloadCacheKeys(input.url || input.path);
    const filePath = String(saved.path || "").trim();
    if (!keys.length || !filePath) return;
    const store = readCloudDownloadCache();
    const entry = {
      path: filePath,
      name: sanitizeAttachmentName(saved.name || input.name || path.basename(filePath)),
      mime: String(saved.mime || input.mime || "").trim(),
      savedAt: now()
    };
    for (const key of keys) store.files[key] = entry;
    writeCloudDownloadCache(store);
  }

  function cachedCloudAttachment(input = {}) {
    const urlPath = String(input.url || input.path || "").trim();
    const keys = cloudDownloadCacheKeys(urlPath);
    if (!keys.length) return null;
    const store = readCloudDownloadCache();
    for (const key of keys) {
      const entry = store.files[key];
      const cachedPath = String(entry?.path || "").trim();
      if (!cachedPath) continue;
      try {
        if (!fs.existsSync(cachedPath) || !fs.statSync(cachedPath).isFile()) {
          delete store.files[key];
          continue;
        }
        const local = readLocalFileAttachment({ path: cachedPath });
        const name = sanitizeAttachmentName(input.name || entry.name || local.name || path.basename(cachedPath));
        const mime = String(input.mime || entry.mime || local.mime || "").trim() || local.mime;
        const kind = attachmentKind({ mime, name });
        return {
          id: String(input.id || randomUUID()),
          name,
          path: cachedPath,
          url: urlPath,
          mime,
          size: local.size,
          kind,
          thumbnailDataUrl: kind === "image" ? String(local.thumbnailDataUrl || "") : "",
          dataUrl: local.dataUrl
        };
      } catch {
        delete store.files[key];
      }
    }
    writeCloudDownloadCache(store);
    return null;
  }

  function attachmentSummaryLine(attachment, index) {
    const parts = [
      `${index + 1}. ${attachment.name}`,
      `类型：${attachment.mime || attachment.kind || "未知"}`,
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
    const normalized = normalizeAttachments(attachments).filter((item) => item.path || item.name);
    if (!normalized.length) return "";
    const lines = [
      "本轮用户附带了以下本地附件。可以直接读取本地路径；如果当前引擎不能读取二进制图片，请根据文件名、类型和用户文字继续处理，并说明限制。",
      "必须使用上面列出的“本地路径”逐字读取附件；不要根据文件名猜测 /Users、Downloads 或当前工作目录中的路径。",
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

  function saveChatAttachment(input = {}) {
    initializeRuntime();
    const data = dataUrlToBuffer(input.dataUrl);
    if (!data) throw new Error("Attachment data is invalid.");
    if (data.data.length > 25 * 1024 * 1024) throw new Error("附件超过 25MB，暂时不能内嵌保存。");
    const p = runtimePaths();
    fs.mkdirSync(p.attachmentsDir, { recursive: true });
    const name = sanitizeAttachmentName(input.name || `attachment${data.ext || ""}`);
    const ext = path.extname(name) || data.ext || "";
    const base = path.basename(name, path.extname(name));
    const fileName = `${now()}-${randomUUID().slice(0, 8)}-${sanitizeAttachmentName(base, "attachment")}${ext}`;
    const target = path.join(p.attachmentsDir, fileName);
    fs.writeFileSync(target, data.data, { mode: 0o600 });
    const saved = normalizeAttachment({
      id: randomUUID(),
      name,
      path: target,
      url: input.url,
      mime: input.mime || data.mime,
      size: data.data.length,
      thumbnailDataUrl: input.thumbnailDataUrl || input.thumbnail || input.previewDataUrl
    });
    rememberCloudDownload(input, saved);
    return saved;
  }

  function mimeForFilePath(filePath) {
    const ext = path.extname(String(filePath || "")).toLowerCase();
    const map = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".pdf": "application/pdf",
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".markdown": "text/markdown",
      ".json": "application/json",
      ".csv": "text/csv",
      ".tsv": "text/tab-separated-values",
      ".log": "text/plain",
      ".js": "text/javascript",
      ".ts": "text/typescript",
      ".tsx": "text/typescript",
      ".jsx": "text/javascript",
      ".py": "text/x-python",
      ".html": "text/html",
      ".css": "text/css",
      ".xls": "application/vnd.ms-excel",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xlsm": "application/vnd.ms-excel.sheet.macroenabled.12",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".ppt": "application/vnd.ms-powerpoint",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".zip": "application/zip"
    };
    return map[ext] || "application/octet-stream";
  }

  function readLocalFileAttachment(input = {}) {
    initializeRuntime();
    const rawPath = String(input.path || input.filePath || "").trim();
    if (!rawPath) throw new Error("File path is required.");
    let filePath = rawPath;
    if (/^file:/i.test(filePath)) filePath = fileURLToPath(filePath);
    filePath = path.resolve(filePath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error("File not found.");
    }
    const stat = fs.statSync(filePath);
    if (stat.size > 25 * 1024 * 1024) {
      throw new Error("文件超过 25MB，暂时不能通过手机传回。");
    }
    const mime = mimeForFilePath(filePath);
    const data = fs.readFileSync(filePath);
    const dataUrl = `data:${mime};base64,${data.toString("base64")}`;
    const attachment = normalizeAttachment({
      id: randomUUID(),
      name: path.basename(filePath),
      path: filePath,
      mime,
      size: stat.size,
      thumbnailDataUrl: mime.startsWith("image/") ? dataUrl : ""
    });
    return {
      ...attachment,
      dataUrl
    };
  }

  function safeReadLocalFileAttachment(input = {}) {
    try {
      return readLocalFileAttachment(input);
    } catch (error) {
      return {
        error: true,
        message: String(error?.message || error),
        path: String(input.path || input.filePath || "")
      };
    }
  }

  async function fetchCloudFileAttachment(input = {}) {
    const urlPath = String(input.url || input.path || "").trim();
    if (!/^\/api\/files\/[a-zA-Z0-9_-]+$/.test(urlPath)) throw new Error("Cloud file URL is invalid.");
    const cached = cachedCloudAttachment(input);
    if (cached) return cached;
    const settings = getCloudSettings();
    if (!settings.enabled || !settings.token) throw new Error("请先登录 Mia Cloud。");
    const response = await fetchImpl(`${normalizeCloudUrl(settings.url)}${urlPath}`, {
      headers: { Authorization: `Bearer ${settings.token}` },
      signal: timeoutSignal(15000)
    });
    if (!response.ok) throw new Error(`Mia Cloud ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const data = Buffer.from(arrayBuffer);
    if (data.length > 25 * 1024 * 1024) throw new Error("文件超过 25MB，暂时不能内嵌预览。");
    const mime = response.headers.get("content-type") || "application/octet-stream";
    const name = sanitizeAttachmentName(input.name || path.basename(urlPath));
    const dataUrl = `data:${mime};base64,${data.toString("base64")}`;
    return {
      id: String(input.id || randomUUID()),
      name,
      path: "",
      url: urlPath,
      mime,
      size: data.length,
      kind: attachmentKind({ mime, name }),
      thumbnailDataUrl: mime.startsWith("image/") ? dataUrl : "",
      dataUrl
    };
  }

  async function safeFetchFileAttachment(input = {}) {
    try {
      const cloudUrl = String(input.url || input.path || "").trim();
      if (/^\/api\/files\/[a-zA-Z0-9_-]+$/.test(cloudUrl)) {
        return await fetchCloudFileAttachment(input);
      }
      return readLocalFileAttachment(input);
    } catch (error) {
      return {
        error: true,
        message: String(error?.message || error),
        path: String(input.path || input.filePath || input.url || "")
      };
    }
  }

  return {
    dataUrlToBuffer,
    sanitizeAttachmentName,
    normalizeAttachment,
    normalizeAttachmentDataUrl,
    normalizeAttachmentThumbnail,
    attachmentKind,
    normalizeAttachments,
    attachmentSummaryLine,
    textPreviewForAttachment,
    attachmentContext,
    saveChatAttachment,
    mimeForFilePath,
    readLocalFileAttachment,
    safeReadLocalFileAttachment,
    fetchCloudFileAttachment,
    safeFetchFileAttachment
  };
}

module.exports = {
  createChatAttachments
};
