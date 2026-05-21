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
    const type = String(file.type || file.mime || "").toLowerCase();
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    if (type.includes("pdf")) return "pdf";
    if (type.startsWith("text/")) return "text";
    return "file";
  }

  function attachmentGlyph(attachment = {}) {
    const kind = attachment.kind || attachmentKind(attachment);
    if (kind === "image") return "IMG";
    if (kind === "video") return "VID";
    if (kind === "audio") return "AUD";
    if (kind === "pdf") return "PDF";
    if (kind === "text") return "TXT";
    return "FILE";
  }

  window.aimashiFormat = {
    formatBytes,
    attachmentKind,
    attachmentGlyph,
  };
})();
