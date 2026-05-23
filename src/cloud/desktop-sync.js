const fs = require("node:fs");
const path = require("node:path");

const MAX_CLOUD_IMAGE_BYTES = 18 * 1024 * 1024;
const CLOUD_UPLOAD_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function mimeForAttachment(attachment = {}) {
  const explicit = String(attachment.mimeType || attachment.mime || "").trim();
  if (explicit) return explicit;
  const ext = path.extname(String(attachment.name || attachment.path || "")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "";
}

function imageDataUrlSize(value) {
  const match = String(value || "").trim().match(/^data:image\/[^;,]+;base64,([\s\S]+)$/i);
  if (!match) return 0;
  return Buffer.from(match[1].replace(/\s+/g, ""), "base64").length;
}

function cloudDataUrlFromDesktopAttachment(attachment = {}) {
  const existing = String(attachment.dataUrl || "").trim();
  const existingType = existing.match(/^data:([^;,]+);base64,/i)?.[1]?.toLowerCase() || "";
  if (existingType) {
    if (!CLOUD_UPLOAD_IMAGE_TYPES.has(existingType)) return "";
    return imageDataUrlSize(existing) <= MAX_CLOUD_IMAGE_BYTES ? existing : "";
  }
  const mime = mimeForAttachment(attachment);
  if (!CLOUD_UPLOAD_IMAGE_TYPES.has(mime.toLowerCase())) return "";
  const filePath = String(attachment.path || "").trim();
  if (!filePath || !fs.existsSync(filePath)) return "";
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_CLOUD_IMAGE_BYTES) return "";
  const data = fs.readFileSync(filePath);
  return `data:${mime};base64,${data.toString("base64")}`;
}

function cloudConversationIdForSession(session = {}) {
  return `desktop:${String(session.id || "default").trim() || "default"}`;
}

function cloudConversationFromDesktopSession(session = {}, fellow = {}) {
  // Encode the source personaKey on the conversation so the cloud echo
  // can be merged back under the correct local fellow instead of always
  // collapsing under default_fellow. Use both an explicit field and the
  // existing meta string (legacy clients/servers preserve unknown fields).
  const personaKey = String(
    session.personaKey || fellow.key || fellow.id || ""
  ).trim();
  const conversation = {
    id: cloudConversationIdForSession(session),
    title: String(session.title || "新对话").trim() || "新对话",
    meta: "Aimashi Desktop · 已同步",
    avatar: String(fellow.avatarImage || fellow.avatar || "./assets/avatar-08.png"),
    updatedAt: String(session.updatedAt || session.createdAt || new Date().toISOString()),
    unread: 0,
    messages: [],
    personaKey
  };
  // Forward fellow display knobs so non-desktop clients (web/mobile) can
  // render the avatar with the same crop and fallback color as the desktop.
  // Both fields are optional; when absent the renderer falls back to its
  // own preset crop table.
  if (fellow.avatarCrop && typeof fellow.avatarCrop === "object") {
    conversation.avatarCrop = {
      x: Number(fellow.avatarCrop.x),
      y: Number(fellow.avatarCrop.y),
      zoom: Number(fellow.avatarCrop.zoom)
    };
  }
  if (fellow.color) conversation.color = String(fellow.color);
  return conversation;
}

function cloudAttachmentFromDesktopAttachment(attachment = {}) {
  const mimeType = mimeForAttachment(attachment);
  return {
    id: String(attachment.id || ""),
    type: String(attachment.type || attachment.kind || (String(attachment.mime || "").startsWith("image/") ? "image" : "file")),
    name: String(attachment.name || "附件"),
    mimeType,
    size: Number(attachment.size || 0),
    url: String(attachment.url || ""),
    dataUrl: cloudDataUrlFromDesktopAttachment(attachment)
  };
}

function normalizeCommandResult(commandResult) {
  if (!commandResult || typeof commandResult !== "object" || commandResult.type !== "session-list") return null;
  const rows = Array.isArray(commandResult.rows)
    ? commandResult.rows
      .map((row) => ({
        id: String(row?.id || "").trim(),
        title: String(row?.title || "").trim().slice(0, 160),
        preview: String(row?.preview || "").trim().slice(0, 240),
        project: String(row?.project || "").trim().slice(0, 240),
        updatedAt: Number(row?.updatedAt) || 0
      }))
      .filter((row) => row.id)
      .slice(0, 20)
    : [];
  if (!rows.length) return null;
  const normalized = {
    type: "session-list",
    command: String(commandResult.command || "/resume").trim() || "/resume",
    engine: String(commandResult.engine || "").trim(),
    rows
  };
  const sourceDeviceId = String(commandResult.sourceDeviceId || "").trim();
  const sourceDeviceName = String(commandResult.sourceDeviceName || "").trim().slice(0, 120);
  if (sourceDeviceId) normalized.sourceDeviceId = sourceDeviceId;
  if (sourceDeviceName) normalized.sourceDeviceName = sourceDeviceName;
  return normalized;
}

function cloudMessageFromDesktopMessage(message = {}) {
  const out = {
    role: message.role === "assistant" ? "assistant" : "user",
    text: String(message.content || message.text || "").trim(),
    // Forward the client timestamp so dedup keys (which include createdAt)
    // match between local storage and the cloud's echoed workspace. The
    // server should preserve this when present rather than overwriting
    // with now().
    createdAt: String(message.createdAt || ""),
    attachments: Array.isArray(message.attachments)
      ? message.attachments.map(cloudAttachmentFromDesktopAttachment)
      : []
  };
  const commandResult = normalizeCommandResult(message.commandResult);
  if (commandResult) out.commandResult = commandResult;
  return out;
}

function desktopSessionIdFromCloudConversation(conversation = {}) {
  const id = String(conversation.id || "").trim() || "default";
  return id.startsWith("desktop:") ? id.slice("desktop:".length) || "default" : `cloud:${id}`;
}

function desktopAttachmentFromCloudAttachment(attachment = {}) {
  return {
    id: String(attachment.id || ""),
    name: String(attachment.name || "附件"),
    path: "",
    mime: String(attachment.mimeType || attachment.mime || ""),
    size: Number(attachment.size || 0),
    kind: String(attachment.type || "file"),
    url: String(attachment.url || "")
  };
}

function desktopMessageFromCloudMessage(message = {}) {
  const out = {
    role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
    content: String(message.content || message.text || ""),
    createdAt: String(message.createdAt || new Date().toISOString())
  };
  if (Array.isArray(message.attachments) && message.attachments.length) {
    out.attachments = message.attachments.map(desktopAttachmentFromCloudAttachment);
  }
  const commandResult = normalizeCommandResult(message.commandResult);
  if (commandResult) out.commandResult = commandResult;
  return out;
}

function desktopSessionFromCloudConversation(conversation = {}, personaKey = "aimashi") {
  const updatedAt = String(conversation.updatedAt || new Date().toISOString());
  // Prefer the conversation's own personaKey if the desktop client encoded
  // one when uploading. Falls back to the caller's default.
  const source = String(conversation.personaKey || personaKey || "aimashi").trim();
  return {
    id: desktopSessionIdFromCloudConversation(conversation),
    personaKey: source,
    title: String(conversation.title || "新对话").trim() || "新对话",
    titleGenerated: true,
    createdAt: String(conversation.createdAt || updatedAt),
    updatedAt,
    messages: Array.isArray(conversation.messages)
      ? conversation.messages.map(desktopMessageFromCloudMessage)
      : []
  };
}

module.exports = {
  cloudAttachmentFromDesktopAttachment,
  cloudConversationFromDesktopSession,
  cloudConversationIdForSession,
  cloudMessageFromDesktopMessage,
  desktopSessionFromCloudConversation,
  desktopSessionIdFromCloudConversation,
  normalizeCommandResult
};
