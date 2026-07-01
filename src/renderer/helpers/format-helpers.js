// Format / attachment helpers
// Extracted from app.js. Pure functions for byte-size formatting and
// attachment kind/glyph detection. No state/els/IPC dependencies.
//
// Reserved as the home for future helpers in the Plan C "helpers" split
// (formatBytes/formatConversationTime/formatMessageTime, attachment*).
(function () {
  "use strict";

  function formatBytes(value) {
    const size = Number(value) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
    return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function attachmentKind(file = {}) {
    const type = String(file.mimeType || file.mime || file.type || "").toLowerCase();
    const name = String(file.name || "");
    const ext = name.split(".").pop()?.toLowerCase() || "";
    if (type.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    if (type.includes("pdf") || ext === "pdf") return "pdf";
    if (type.startsWith("text/") || ["txt", "md", "json", "csv", "log", "js", "ts", "tsx", "jsx", "py", "html", "css"].includes(ext)) return "text";
    return "file";
  }

  function attachmentExtension(attachment = {}) {
    const value = String(attachment.name || attachment.filename || attachment.path || attachment.url || "").trim().toLowerCase();
    const match = value.match(/\.([a-z0-9]+)(?:[?#].*)?$/);
    return match ? match[1] : "";
  }

  function attachmentGlyph(attachment = {}) {
    const mime = String(attachment.mimeType || attachment.mime || attachment.type || "").toLowerCase();
    const ext = attachmentExtension(attachment);
    const kind = attachment.kind || attachmentKind(attachment);
    if (kind === "image") return "IMG";
    if (kind === "video") return "VID";
    if (kind === "audio") return "AUD";
    if (kind === "pdf" || mime.includes("pdf") || ext === "pdf") return "PDF";
    if (mime.includes("spreadsheet") || mime === "application/vnd.ms-excel" || ["xls", "xlsx", "xlsm"].includes(ext)) return "XLS";
    if (mime.includes("wordprocessingml") || mime === "application/msword" || ["doc", "docx"].includes(ext)) return "DOC";
    if (mime.includes("presentationml") || mime === "application/vnd.ms-powerpoint" || ["ppt", "pptx"].includes(ext)) return "PPT";
    if (mime.includes("zip") || ext === "zip") return "ZIP";
    if (mime.includes("json") || ext === "json") return "JSON";
    if (ext === "csv") return "CSV";
    if (ext === "tsv") return "TSV";
    if (["md", "markdown"].includes(ext)) return "MD";
    if (["html", "css", "js", "jsx", "ts", "tsx", "py"].includes(ext)) return "CODE";
    if (kind === "text") return "TXT";
    return "FILE";
  }

  window.miaFormat = {
    formatBytes,
    attachmentKind,
    attachmentGlyph,
  };
})();
