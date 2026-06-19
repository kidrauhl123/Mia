"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function isPathPasteInput(input = {}, platform = process.platform) {
  const key = String(input.key || "").toLowerCase();
  const code = String(input.code || "").toLowerCase();
  const isV = key === "v" || code === "keyv" || input.key === "\u0016";
  if (!isV || input.isAutoRepeat) return false;
  if (platform === "darwin") {
    return Boolean(input.control && !input.meta && !input.alt);
  }
  return Boolean(input.alt && !input.control && !input.meta);
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, `"`)
    .replace(/&#39;/g, "'");
}

function normalizeClipboardCandidate(value) {
  const raw = String(value || "").replace(/\u0000/g, "\n").trim();
  if (!raw) return "";
  const plistStrings = [...raw.matchAll(/<string>([\s\S]*?)<\/string>/g)]
    .map((match) => decodeXmlEntities(match[1]).trim())
    .filter(Boolean);
  const lines = (plistStrings.length ? plistStrings : raw.split(/\r?\n/))
    .map((line) => String(line || "").trim())
    .filter((line) => line && !line.startsWith("#"));
  return lines.join("\n");
}

function uniqueFormats(formats = []) {
  return [...new Set(formats.map((item) => String(item || "").trim()).filter(Boolean))];
}

function readClipboardFormat(clipboard, format) {
  try {
    if (format === "text/plain" && typeof clipboard.readText === "function") return clipboard.readText();
    if (typeof clipboard.read === "function") return clipboard.read(format);
  } catch {
    return "";
  }
  return "";
}

function clipboardImageToTempPath(clipboard, {
  tempDir = path.join(os.tmpdir(), "mia-clipboard"),
  now = () => Date.now(),
  randomId = () => crypto.randomUUID()
} = {}) {
  if (typeof clipboard?.readImage !== "function") return "";
  let image = null;
  try {
    image = clipboard.readImage();
  } catch {
    return "";
  }
  if (!image || (typeof image.isEmpty === "function" && image.isEmpty())) return "";
  let data = null;
  try {
    data = image.toPNG();
  } catch {
    return "";
  }
  if (!Buffer.isBuffer(data) || !data.length) return "";
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    const fileName = `clipboard-${now()}-${String(randomId()).slice(0, 8)}.png`;
    const target = path.join(tempDir, fileName);
    fs.writeFileSync(target, data, { mode: 0o600 });
    return target;
  } catch {
    return "";
  }
}

function readClipboardPathPastePayload(clipboard, options = {}) {
  if (!clipboard) return null;
  let available = [];
  try {
    available = typeof clipboard.availableFormats === "function" ? clipboard.availableFormats() : [];
  } catch {
    available = [];
  }
  const preferred = [
    "text/plain",
    "text/uri-list",
    "public.file-url",
    "NSFilenamesPboardType",
    "com.apple.pasteboard.promised-file-url"
  ];
  const pathish = available.filter((format) => /file|filename|uri|url|path/i.test(format));
  for (const format of uniqueFormats([...preferred, ...pathish])) {
    const text = normalizeClipboardCandidate(readClipboardFormat(clipboard, format));
    if (text) return { text, kind: "text" };
  }
  const imagePath = clipboardImageToTempPath(clipboard, options);
  return imagePath ? { text: imagePath, kind: "image" } : null;
}

function readClipboardPathPasteText(clipboard, options = {}) {
  return readClipboardPathPastePayload(clipboard, options)?.text || "";
}

function installPathPasteShortcut(win, {
  clipboard,
  channel,
  platform = process.platform
} = {}) {
  if (!win?.webContents?.on || !channel) return () => {};
  const handler = (event, input = {}) => {
    if (!isPathPasteInput(input, platform)) return;
    const payload = readClipboardPathPastePayload(clipboard);
    if (!payload?.text) return;
    event?.preventDefault?.();
    if (win.isDestroyed?.()) return;
    win.webContents.send(channel, payload);
  };
  win.webContents.on("before-input-event", handler);
  return () => win.webContents.removeListener?.("before-input-event", handler);
}

module.exports = {
  clipboardImageToTempPath,
  decodeXmlEntities,
  installPathPasteShortcut,
  isPathPasteInput,
  normalizeClipboardCandidate,
  readClipboardPathPastePayload,
  readClipboardPathPasteText
};
