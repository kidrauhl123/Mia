// Mia Web — chat + settings only.
// Conversation list = cloud DM, group rooms, and cloud-mirrored fellow rooms.

const STORAGE_KEY = "mia.web.session";
const API_BASE = "";
const { formatConversationTime, formatMessageTime } = window.miaTimeFormat;
const { computeUnreadForConversation, totalUnreadFromConversations, unreadBadgeHtml } = window.miaUnread;
const { prepareOutgoingMessage } = window.miaSendPipeline;
const { SenderKind } = window.miaConversationKinds;
const sessionHistory = window.miaSessionHistory || {};
const fellowRuntimeControl = window.miaFellowRuntimeControl || {};
const engineContracts = window.miaEngineContracts || {};
const normalizeAgentEngine = engineContracts.normalizeAgentEngine || ((value) => {
  const id = String(value || "hermes").trim().toLowerCase().replace(/_/g, "-");
  if (id === "claude" || id === "claude-code") return "claude-code";
  if (id === "codex" || id === "openai-codex") return "codex";
  return "hermes";
});
const engineLabel = engineContracts.engineLabel || ((value) => {
  const engine = normalizeAgentEngine(value);
  if (engine === "claude-code") return "Claude Code";
  if (engine === "codex") return "Codex";
  return "Hermes";
});
const externalModelEntries = engineContracts.externalModelEntries || ((value) => {
  const engine = normalizeAgentEngine(value);
  if (engine === "claude-code") {
    return [
      { id: "default", model: "", label: "Claude Code 默认" },
      { id: "claude-opus-4-7", model: "claude-opus-4-7", label: "Claude Opus 4.7" },
      { id: "claude-sonnet-4-6", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "opus", model: "opus", label: "Opus alias" },
      { id: "sonnet", model: "sonnet", label: "Sonnet alias" }
    ];
  }
  if (engine === "codex") {
    return [
      { id: "default", model: "", label: "Codex 默认" },
      { id: "gpt-5.3-codex-spark", model: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
      { id: "gpt-5.3-codex", model: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { id: "gpt-5.2", model: "gpt-5.2", label: "GPT-5.2" }
    ];
  }
  return [];
});
const effortOptions = engineContracts.effortOptions || ((value) => {
  const engine = normalizeAgentEngine(value);
  const labels = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
  const levels = engine === "claude-code"
    ? ["low", "medium", "high", "xhigh", "max"]
    : engine === "codex"
      ? ["minimal", "low", "medium", "high", "xhigh"]
      : ["low", "medium", "high"];
  return levels.map((level) => ({ value: level, label: labels[level] || level }));
});
const externalPermissionOptions = engineContracts.externalPermissionOptions || ((value) => {
  const engine = normalizeAgentEngine(value);
  if (engine === "claude-code") {
    return [
      { value: "default", label: "Ask Permissions" },
      { value: "acceptEdits", label: "Accept Edits" },
      { value: "plan", label: "Plan Mode" },
      { value: "auto", label: "Auto Mode" },
      { value: "bypassPermissions", label: "Bypass Permissions" }
    ];
  }
  if (engine === "codex") {
    return [
      { value: "default", label: "Ask" },
      { value: "acceptEdits", label: "Edits" },
      { value: "readOnly", label: "Read" },
      { value: "bypassPermissions", label: "YOLO" }
    ];
  }
  return [
    { value: "ask", label: "Ask" },
    { value: "auto", label: "Auto" },
    { value: "readOnly", label: "Read" }
  ];
});

const els = {
  root: document.querySelector(".app-shell"),
  loginView: document.getElementById("loginView"),
  mainView: document.getElementById("mainView"),
  loginForm: document.getElementById("loginForm"),
  usernameInput: document.getElementById("usernameInput"),
  passwordInput: document.getElementById("passwordInput"),
  registerButton: document.getElementById("registerButton"),
  loginHint: document.getElementById("loginHint"),

  conversationSearch: document.getElementById("conversationSearch"),
  conversationList: document.getElementById("conversationList"),
  newConversation: document.getElementById("newConversation"),
  conversationCreateMenu: document.getElementById("conversationCreateMenu"),
  convMenuAddFriend: document.getElementById("convMenuAddFriend"),
  convMenuNewGroup: document.getElementById("convMenuNewGroup"),
  convMenuNewFellow: document.getElementById("convMenuNewFellow"),
  unreadCount: document.getElementById("unreadCount"),
  mobileBack: document.getElementById("mobileBack"),
  userAvatar: document.getElementById("userAvatar"),

  activeAvatar: document.getElementById("activeAvatar"),
  activeTitle: document.getElementById("activeTitle"),
  activeMeta: document.getElementById("activeMeta"),
  sessionMenuButton: document.getElementById("sessionMenuButton"),
  currentSessionTitle: document.getElementById("currentSessionTitle"),
  sessionMenu: document.getElementById("sessionMenu"),
  sessionList: document.getElementById("sessionList"),
  newSession: document.getElementById("newSession"),
  chat: document.getElementById("chat"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  sendButton: document.getElementById("sendButton"),
  composerBottom: document.getElementById("composerBottom"),
  quickModelAvatar: document.getElementById("quickModelAvatar"),
  quickModelSelect: document.getElementById("quickModelSelect"),
  quickModelLabel: document.getElementById("quickModelLabel"),
  effortSelect: document.getElementById("effortSelect"),
  effortLabel: document.getElementById("effortLabel"),
  permissionMode: document.getElementById("permissionMode"),
  permissionLabel: document.getElementById("permissionLabel"),

  settingsView: document.getElementById("settingsView"),
  openSettings: document.getElementById("openSettings"),
  closeSettings: document.getElementById("closeSettings"),
  cloudAccountUsername: document.getElementById("cloudAccountUsername"),
  cloudLogoutFromSettings: document.getElementById("cloudLogoutFromSettings"),
  appearanceTheme: document.getElementById("appearanceTheme"),
  appearanceListStyle: document.getElementById("appearanceListStyle"),
  appearanceSelectionStyle: document.getElementById("appearanceSelectionStyle"),
  appearanceHoverBackground: document.getElementById("appearanceHoverBackground"),
  appearanceAccentColor: document.getElementById("appearanceAccentColor"),
  appearanceUserBubbleColor: document.getElementById("appearanceUserBubbleColor"),
  appearanceShowUserAvatar: document.getElementById("appearanceShowUserAvatar"),
  appearanceShowAssistantAvatar: document.getElementById("appearanceShowAssistantAvatar"),

  toast: document.getElementById("toast"),
};

let state = {
  token: "",
  user: null,
  theme: "light",
  rooms: [],
  friends: [],
  // Cloud-mirrored fellow identities (Phase 2). Populated from
  // /api/me/fellows on login and kept in sync via fellow.upserted /
  // fellow.deleted WS events. Used as the `fellows` context for the
  // cloud-room-source adapter so room messages render fellow names +
  // avatars instead of fellow-id strings.
  fellows: [],
  // Cross-device user settings (Phase 3). Holds pins + read marks +
  // appearance. Populated from /api/me/settings on bootstrap; updated
  // optimistically via pushSettings() + reconciled by
  // user_settings.updated WS events. Replaces the previous localStorage-
  // backed _pinnedRooms set.
  settings: { pins: [], readMarks: {}, appearance: {} },
  incomingRequests: [],
  outgoingRequests: [],
  messageCache: new Map(),
  roomMembersCache: new Map(),
  // (Phase 4 cutover: state.workspace removed. Every conversation now
  //  lives in state.rooms — fellow chats are rooms-of-type-fellow.)
  bridgeDevices: [],
  bridgeBusy: false,
  cloudAgentRunsByRoom: new Map(),
  fellowRuntimeCache: new Map(),
  platformModels: [],
  activeConversationId: "",
  // Per-conversation unread counters. Incremented when a WS message arrives
  // for a non-active conversation, cleared when the user opens it. In-memory
  // only for v1 — survives until reload.
  unread: new Map(),
  settingsOpen: false,
  activeSettingsTab: "account",
  createMenuOpen: false,
  sessionMenuOpen: false,
};

let eventsSocket = null;
let eventsReconnectTimer = 0;

// ── helpers ────────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function initials(value) {
  const text = String(value || "").trim();
  return (text[0] || "M").toUpperCase();
}

function isPublicImageSrc(value) {
  return /^(https?:|data:|\.?\/assets\/|\/api\/files\/)/i.test(String(value || ""));
}

const avatarMedia = window.miaAvatarMedia || {
  isVideo: () => false,
  trimFromCrop: () => ({ start: 0, duration: 3 })
};

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

function renderMarkdown(value) {
  const text = String(value || "");
  if (!text.trim()) return "";
  const render = window.miaMarkdown?.renderMarkdown;
  if (typeof render === "function") {
    try {
      return render(text);
    } catch (err) {
      console.warn("[web] markdown render failed:", err);
    }
  }
  return escapeHtml(text).replace(/\n/g, "<br>");
}

async function copyTextToClipboard(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the textarea copy path for browsers that block Clipboard API here.
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function flashCopiedCode(code) {
  code.classList.add("copied");
  clearTimeout(code._copiedTimer);
  code._copiedTimer = setTimeout(() => {
    code.classList.remove("copied");
  }, 900);
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

function attachmentThumb(attachment = {}, className = "message-attachment-thumb") {
  const src = String(attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || attachment.dataUrl || "").trim();
  if (!src || !src.startsWith("data:image/")) return `<span>${escapeHtml(attachmentGlyph(attachment))}</span>`;
  return `<img class="${escapeHtml(className)}" src="${escapeHtml(src)}" alt="">`;
}

function renderAttachmentChip(attachment = {}) {
  const image = (attachment.kind || attachmentKind(attachment)) === "image"
    && (attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || attachment.dataUrl || attachment.url);
  const href = String(attachment.url || attachment.dataUrl || "").trim();
  const safeHref = /^(\/api\/files\/[A-Za-z0-9_-]+|data:[^"'<>]+)$/i.test(href) ? href : "";
  const tag = safeHref ? "a" : "span";
  const download = safeHref ? ` href="${escapeHtml(safeHref)}" download="${escapeHtml(attachment.name || "attachment")}"` : "";
  if (image) {
    return `
      <${tag} class="message-attachment image"${download} title="${escapeHtml(attachment.name || "")}" aria-label="预览图片">
        ${attachmentThumb(attachment)}
      </${tag}>
    `;
  }
  return `
    <${tag} class="message-attachment"${download} title="${escapeHtml(attachment.path || attachment.name || "")}">
      ${attachmentThumb(attachment)}
      <strong>${escapeHtml(attachment.name || "附件")}</strong>
      <em>${escapeHtml(formatBytes(attachment.size))}</em>
    </${tag}>
  `;
}

function renderAttachmentChips(attachments = []) {
  if (!Array.isArray(attachments) || !attachments.length) return "";
  return `<div class="message-attachments">${attachments.map(renderAttachmentChip).join("")}</div>`;
}

// Avatar preset crop table — mirrors src/renderer/helpers/avatar-helpers.js
// so web renders fellow avatars the same as desktop. Pet avatars are square
// (default crop); human avatars have face-centered crops that need explicit
// background-size + background-position.
const AVATAR_PRESETS = {
  "./assets/avatars/01.png": { x: 50.0687, y: 14.5495, zoom: 2.04 },
  "./assets/avatars/02.png": { x: 57.2536, y: 8.1635, zoom: 1.56 },
  "./assets/avatars/03.png": { x: 50, y: 14, zoom: 1.48 },
  "./assets/avatars/04.png": { x: 49.0079, y: 23.5736, zoom: 1.72 },
  "./assets/avatars/05.png": { x: 47.6785, y: 11.3611, zoom: 1.88 },
  "./assets/avatars/06.png": { x: 46.8749, y: 10.4285, zoom: 1.64 },
  "./assets/avatars/07.png": { x: 51.6741, y: 8.0209, zoom: 1.72 },
  "./assets/avatars/08.png": { x: 50.974, y: 12.8636, zoom: 1.88 },
  "./assets/avatars/09.png": { x: 47.4999, y: 12.2142, zoom: 1.8 },
  "./assets/avatars/10.png": { x: 50, y: 14, zoom: 1.8 },
  "./assets/avatars/11.png": { x: 55.8037, y: 7.9731, zoom: 1.64 },
  "./assets/avatars/12.png": { x: 47.3214, y: 16.9763, zoom: 1.8 },
  "./assets/avatars/13.png": { x: 50, y: 14, zoom: 1.8 },
  "./assets/avatars/14.png": { x: 50, y: 14, zoom: 1.72 },
  "./assets/avatars/15.png": { x: 45.1848, y: 5.1022, zoom: 1.56 },
  "./assets/avatars/16.png": { x: 51.0913, y: 15.7858, zoom: 1.72 }
};

const WEB_AVATAR_PRESET_GROUP_TABS = [
  { key: "human", label: "人形" },
  { key: "pet", label: "宠物" }
];

const WEB_AVATAR_PRESET_GROUPS = {
  human: [
    { name: "青羽", src: "./assets/avatars/01.png", crop: { x: 50.0687, y: 14.5495, zoom: 2.04 } },
    { name: "桃奈", src: "./assets/avatars/02.png", crop: { x: 57.2536, y: 8.1635, zoom: 1.56 } },
    { name: "紫音", src: "./assets/avatars/03.png", crop: { x: 50, y: 14, zoom: 1.48 } },
    { name: "小栗", src: "./assets/avatars/04.png", crop: { x: 49.0079, y: 23.5736, zoom: 1.72 } },
    { name: "墨川", src: "./assets/avatars/05.png", crop: { x: 47.6785, y: 11.3611, zoom: 1.88 } },
    { name: "珊瑚", src: "./assets/avatars/06.png", crop: { x: 46.8749, y: 10.4285, zoom: 1.64 } },
    { name: "雪璃", src: "./assets/avatars/07.png", crop: { x: 51.6741, y: 8.0209, zoom: 1.72 } },
    { name: "赤焰", src: "./assets/avatars/08.png", crop: { x: 50.974, y: 12.8636, zoom: 1.88 } },
    { name: "蓝汐", src: "./assets/avatars/09.png", crop: { x: 47.4999, y: 12.2142, zoom: 1.8 } },
    { name: "棕野", src: "./assets/avatars/10.png", crop: { x: 50, y: 14, zoom: 1.8 } },
    { name: "夜莓", src: "./assets/avatars/11.png", crop: { x: 55.8037, y: 7.9731, zoom: 1.64 } },
    { name: "空铃", src: "./assets/avatars/12.png", crop: { x: 47.3214, y: 16.9763, zoom: 1.8 } },
    { name: "茉茶", src: "./assets/avatars/13.png", crop: { x: 50, y: 14, zoom: 1.8 } },
    { name: "星柚", src: "./assets/avatars/14.png", crop: { x: 50, y: 14, zoom: 1.72 } },
    { name: "爱丽丝", src: "./assets/avatars/15.png", crop: { x: 45.1848, y: 5.1022, zoom: 1.56 } },
    { name: "岚", src: "./assets/avatars/16.png", crop: { x: 51.0913, y: 15.7858, zoom: 1.72 } }
  ],
  pet: Array.from({ length: 16 }, (_item, index) => {
    const id = String(index + 1).padStart(2, "0");
    return { name: `宠物 ${id}`, src: `./assets/avatars-pet/${id}.png`, crop: { x: 50, y: 50, zoom: 1 } };
  })
};

const WEB_AVATAR_PRESETS = Object.values(WEB_AVATAR_PRESET_GROUPS).flat();

function webAvatarPresetBySrc(src) {
  const value = String(src || "").trim();
  return WEB_AVATAR_PRESETS.find((preset) => preset.src === value) || null;
}

function webAvatarPresetGroupForSrc(src) {
  const value = String(src || "").trim();
  return WEB_AVATAR_PRESET_GROUP_TABS.find(({ key }) =>
    WEB_AVATAR_PRESET_GROUPS[key]?.some((preset) => preset.src === value)
  )?.key || "human";
}

function webNormalizeAvatarCrop(crop = {}) {
  const source = crop && typeof crop === "object" ? crop : {};
  const num = (value, fallback, min, max) => {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.max(min, Math.min(max, next));
  };
  const normalized = {
    x: num(source.x, 50, 0, 100),
    y: num(source.y, 50, 0, 100),
    zoom: num(source.zoom, 1, 1, 2.4)
  };
  if (
    Object.prototype.hasOwnProperty.call(source, "start")
    || Object.prototype.hasOwnProperty.call(source, "duration")
    || Object.prototype.hasOwnProperty.call(source, "trimStart")
    || Object.prototype.hasOwnProperty.call(source, "trimDuration")
  ) {
    Object.assign(normalized, avatarMedia.normalizeTrim?.(source) || avatarMedia.trimFromCrop?.(source) || { start: 0, duration: 3 });
  }
  return normalized;
}

function webAvatarDefaultCropForSrc(src) {
  if (avatarMedia.isVideo?.(src)) return { x: 50, y: 50, zoom: 1, start: 0, duration: avatarMedia.DEFAULT_TRIM_DURATION || 3 };
  return { x: 50, y: 13.5, zoom: 1.72, ...(webAvatarPresetBySrc(src)?.crop || {}) };
}

function avatarBackgroundStyle(image, customCrop, fallbackColor) {
  if (!image) return `background-color:${fallbackColor};color:#fff;display:inline-flex;align-items:center;justify-content:center;`;
  if (avatarMedia.isVideo?.(image)) return "background-color:transparent;";
  const preset = AVATAR_PRESETS[image] || null;
  // Treat (50, 50, 1) as "no crop set" so we fall back to the preset crop
  // for human avatars even when the synced conversation didn't carry one.
  const isNeutral = !customCrop || (
    Math.abs(Number(customCrop.x) - 50) < 0.01 &&
    Math.abs(Number(customCrop.y) - 50) < 0.01 &&
    Math.abs(Number(customCrop.zoom || 1) - 1) < 0.001
  );
  const crop = (!isNeutral && customCrop) || preset || { x: 50, y: 50, zoom: 1 };
  const x = Number.isFinite(Number(crop.x)) ? Number(crop.x) : 50;
  const y = Number.isFinite(Number(crop.y)) ? Number(crop.y) : 50;
  const zoom = Number.isFinite(Number(crop.zoom)) ? Number(crop.zoom) : 1;
  const size = Math.round(zoom * 100);
  return `background-color:transparent;background-image:url('${image}');background-size:${size}%;background-position:${x}% ${y}%;background-repeat:no-repeat;`;
}

function avatarVideoStyle(crop = {}) {
  const x = Number.isFinite(Number(crop?.x)) ? Number(crop.x) : 50;
  const y = Number.isFinite(Number(crop?.y)) ? Number(crop.y) : 50;
  const zoom = Number.isFinite(Number(crop?.zoom)) ? Number(crop.zoom) : 1;
  return `object-position:${x}% ${y}%;transform:scale(${zoom});transform-origin:${x}% ${y}%;`;
}

function avatarVideoHtml(image, crop = {}) {
  const trim = avatarMedia.trimFromCrop?.(crop) || { start: 0, duration: 3 };
  return `<video class="avatar-video" src="${escapeHtml(image)}" muted loop autoplay playsinline aria-hidden="true" data-avatar-start="${escapeHtml(trim.start)}" data-avatar-duration="${escapeHtml(trim.duration)}" style="${avatarVideoStyle(crop)}"></video>`;
}

function avatarHtml({ className = "avatar", image = "", crop = null, color = "#5e5ce6", text = "", attrs = "" } = {}) {
  const useAvatar = image && isPublicImageSrc(image);
  if (useAvatar && avatarMedia.isVideo?.(image)) {
    return `<span class="${escapeHtml(className)}" ${attrs} style="background-color:transparent;">${avatarVideoHtml(image, crop || {})}</span>`;
  }
  const style = useAvatar
    ? avatarBackgroundStyle(image, crop, color)
    : `background-color:${color}; color:#fff; display:inline-flex; align-items:center; justify-content:center;`;
  return `<span class="${escapeHtml(className)}" ${attrs} style="${style}">${useAvatar ? "" : escapeHtml(text || "")}</span>`;
}

function avatarHtmlForConversation(item, color, label) {
  return avatarHtml({
    className: "avatar",
    image: item.avatar,
    crop: item.avatarCrop,
    color,
    text: label
  });
}

function applyAvatarMedia(el, image, crop = null, color = "#5e5ce6", text = "") {
  if (!el) return;
  el.querySelectorAll?.(".avatar-video")?.forEach((node) => node.remove());
  const useAvatar = image && isPublicImageSrc(image);
  if (useAvatar && avatarMedia.isVideo?.(image)) {
    el.style.cssText = "background-color:transparent;";
    el.textContent = "";
    el.insertAdjacentHTML("afterbegin", avatarVideoHtml(image, crop || {}));
    hydrateAvatarVideos(el);
    return;
  }
  if (useAvatar) {
    el.style.cssText = avatarBackgroundStyle(image, crop, color);
    el.textContent = "";
    return;
  }
  el.style.cssText = "";
  el.style.backgroundColor = color;
  el.style.color = "#fff";
  el.style.display = "inline-flex";
  el.style.alignItems = "center";
  el.style.justifyContent = "center";
  el.textContent = text || "";
}

function syncAvatarVideo(video) {
  const start = Math.max(0, Number(video.dataset.avatarStart || 0) || 0);
  const duration = Math.max(1, Number(video.dataset.avatarDuration || 3) || 3);
  const end = start + duration;
  const seekStart = () => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const safeStart = Math.min(start, Math.max(video.duration - 0.1, 0));
    if (Math.abs(video.currentTime - safeStart) > 0.25) video.currentTime = safeStart;
  };
  video.addEventListener("loadedmetadata", seekStart);
  video.addEventListener("timeupdate", () => {
    if (video.currentTime >= end) seekStart();
  });
  video.play?.().catch?.(() => {});
}

function hydrateAvatarVideos(root = document) {
  root.querySelectorAll?.("video.avatar-video")?.forEach((video) => {
    if (video.dataset.avatarHydrated === "true") return;
    video.dataset.avatarHydrated = "true";
    syncAvatarVideo(video);
  });
}

function renderUserAvatar() {
  if (!els.userAvatar) return;
  const user = state.user || {};
  const color = user.avatarColor || "#111827";
  const image = user.avatarImage || "";
  applyAvatarMedia(els.userAvatar, image, user.avatarCrop, color, initials(user.username || user.email || "Mia"));
  els.userAvatar.title = user.username ? `账号与同步：${user.username}` : "账号与同步";
}

function providerIconSrc(provider = "") {
  const id = String(provider || "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  if (!id || id === "custom") return "";
  return `./assets/provider-icons/${id}.svg`;
}

function modelIconSrc(model = {}) {
  const id = String(model.model || model.id || model.name || model.value || "").toLowerCase();
  const provider = String(model.provider || "").toLowerCase();
  const rules = [
    [/codex|openai-codex/, "chatgpt.jpeg"],
    [/gpt-5\.1-chat/, "gpt-5.1-chat.png"],
    [/gpt-5\.1/, "gpt-5.1.png"],
    [/gpt-5.*mini/, "gpt-5-mini.png"],
    [/gpt-5.*nano/, "gpt-5-nano.png"],
    [/gpt-5/, "gpt-5.png"],
    [/gpt-4/, "gpt_4.png"],
    [/gpt-3/, "gpt_3.5.png"],
    [/claude|anthropic/, "claude.png"],
    [/deepseek/, "deepseek.png"],
    [/grok|xai/, "grok.png"],
    [/qwen|qwq|qvq|wan-/, "qwen.png"],
    [/gemini/, "gemini.png"],
    [/gemma/, "gemma.png"],
    [/llama/, "llama.png"],
    [/mistral|mixtral|codestral|ministral|magistral/, "mixtral.png"],
    [/kimi|moonshot/, "moonshot.webp"],
    [/minimax|abab|m2-her/, "minimax.png"],
    [/mimo/, "mimo.svg"],
    [/nvidia|nemotron/, "nvidia.png"],
    [/copilot/, "copilot.png"],
    [/hermes|nous|mia-default/, "nousresearch.png"],
    [/hugging/, "huggingface.png"],
    [/glm|zai|zhipu/, "zhipu.png"],
    [/step/, "step.png"]
  ];
  const haystack = `${id} ${provider}`;
  const match = rules.find(([regex]) => regex.test(haystack));
  if (match) return `./assets/model-icons/${match[1]}`;
  return providerIconSrc(provider);
}

function setModelAvatar(engine, entry = {}, config = {}) {
  if (!els.quickModelAvatar) return;
  const icon = engine === "claude-code"
    ? modelIconSrc({ provider: "anthropic", model: entry.model || config.model || "claude" })
    : engine === "codex"
      ? modelIconSrc({ provider: "openai-codex", model: entry.model || config.model || "codex" })
      : modelIconSrc({
        provider: entry.provider || config.provider || (engine === "hermes" ? "nous" : engine),
        model: entry.model || config.model || entry.value || ""
      });
  els.quickModelAvatar.textContent = icon ? "" : "◇";
  els.quickModelAvatar.style.backgroundImage = icon ? `url("${icon}")` : "";
}

function showToast(text) {
  els.toast.textContent = text;
  els.toast.classList.remove("hidden");
  setTimeout(() => els.toast.classList.add("hidden"), 2400);
}

function loadSession() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "");
    if (parsed?.token) {
      state.token = parsed.token;
      state.user = parsed.user || null;
      state.theme = parsed.theme || "light";
    }
  } catch {}
}

function saveSession() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    token: state.token, user: state.user, theme: state.theme
  }));
}

function clearSession() {
  state.token = "";
  state.user = null;
  state.rooms = [];
  state.friends = [];
  state.fellows = [];
  state.settings = { pins: [], readMarks: {}, appearance: {} };
  state.messageCache.clear?.();
  state.roomMembersCache.clear?.();
  state.incomingRequests = [];
  state.outgoingRequests = [];
  state.messageCache.clear();
  state.roomMembersCache.clear();
  state.bridgeDevices = [];
  state.bridgeBusy = false;
  state.cloudAgentRunsByRoom.clear?.();
  state.fellowRuntimeCache.clear?.();
  state.activeConversationId = "";
  stopCloudEvents();
  localStorage.removeItem(STORAGE_KEY);
}

// All conversations are rooms after Phase 4 cutover.
// Type is encoded in the id prefix (dm:, g_, fellow:) and also lives in
// room.type. Old workspace-conversation helper is gone.
function isRoomId(id) {
  return typeof id === "string" && (id.startsWith("dm:") || id.startsWith("g_") || id.startsWith("fellow:"));
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  // Auto-tag write requests with a clientOpId so a retry (e.g. browser
  // retry on network blip, double-click) returns the same response
  // rather than running again (Phase 1.D). Caller can pre-set
  // body.clientOpId for explicit retry semantics.
  let body = options.body;
  const method = String(options.method || "GET").toUpperCase();
  if ((method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") && body && typeof body === "object" && !body.clientOpId) {
    body = { ...body, clientOpId: `op_${(crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`)}` };
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    body: body && typeof body !== "string" ? JSON.stringify(body) : body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

// ── auth view ──────────────────────────────────────────────────────────────

function setAuthView() {
  els.root.dataset.auth = state.token ? "signed-in" : "signed-out";
  renderUserAvatar();
  // Theme now lives in window.miaAppearance (see web/appearance.js).
  // It applies on script load so the page doesn't flash; don't override here.
}

async function handleLogin(register) {
  const username = els.usernameInput.value.trim();
  const password = els.passwordInput.value;
  if (!username || !password) return;
  try {
    const path = register ? "/api/auth/register" : "/api/auth/login";
    const data = await api(path, { method: "POST", body: { username, password } });
    state.token = data.token;
    state.user = data.user || { username };
    saveSession();
    setAuthView();
    await bootstrap();
    startCloudEvents();
  } catch (err) {
    showToast(err.message);
  }
}

async function handleLogout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  clearSession();
  state.settingsOpen = false;
  setAuthView();
  renderSettings();
  renderConversationList();
  renderActiveChat();
}

// ── bootstrap ──────────────────────────────────────────────────────────────

async function bootstrap() {
  try {
    const me = await api("/api/me");
    state.user = me.user || me;
    saveSession();
  } catch (err) {
    // token bad → log out
    clearSession();
    setAuthView();
    return;
  }
  await Promise.all([
    api("/api/rooms").then((d) => { state.rooms = Array.isArray(d.rooms) ? d.rooms : []; }).catch(() => {}),
    api("/api/social/friends").then((d) => { state.friends = Array.isArray(d.friends) ? d.friends : []; }).catch(() => {}),
    api("/api/social/friend-requests?direction=incoming").then((d) => { state.incomingRequests = Array.isArray(d.requests) ? d.requests : []; }).catch(() => {}),
    api("/api/social/friend-requests?direction=outgoing").then((d) => { state.outgoingRequests = Array.isArray(d.requests) ? d.requests : []; }).catch(() => {}),
    // Phase 2: fellow identities (name + avatar + persona) so room
    // messages from a fellow render with proper attribution rather than
    // a bare fellow-id string.
    api("/api/me/fellows").then((d) => { state.fellows = Array.isArray(d.fellows) ? d.fellows : []; }).catch(() => {}),
    // Phase 3: cross-device user settings (pin / read marks / appearance).
    api("/api/me/settings").then((d) => { if (d.settings) state.settings = d.settings; }).catch(() => {}),
    // Bridge devices: lets Phase B decide whether the owner's desktop is
    // online and we can route the message through it. Empty array if none.
    api("/api/bridge/devices").then((d) => { state.bridgeDevices = Array.isArray(d.devices) ? d.devices : []; }).catch(() => {}),
    loadPlatformModels(),
  ]);
  if (!state.activeConversationId) {
    const first = combinedConversationItems()[0];
    if (first) state.activeConversationId = first.id;
  }
  if (state.activeConversationId && isRoomId(state.activeConversationId)) {
    await ensureRoomMessages(state.activeConversationId);
    await ensureRoomMembers(state.activeConversationId);
  }
  // Prefetch members for every group room so the sidebar mosaic shows real
  // avatars on first paint instead of empty tiles.
  await Promise.all(
    state.rooms
      .filter((r) => r.type === "group" || (!r.id?.startsWith("dm:") && !r.id?.startsWith("fellow:") && (r.id?.startsWith("g_") || r.id?.startsWith("g-"))))
      .map((r) => ensureRoomMembers(r.id))
  );
  renderConversationList();
  renderActiveChat();
  renderSettings();
}

// (applyWorkspace + activeWorkspaceConversation removed in Phase 4 cutover.)

function bridgeIsOnline() {
  return state.bridgeDevices.length > 0;
}

// Room ids are `dm:<a>:<b>` or `g_<hex>` — both fit the server route regex
// /api/rooms/([A-Za-z0-9_:-]+) literally. encodeURIComponent would turn `:`
// into `%3A` and 404 the route, so paths use room.id verbatim.

async function ensureRoomMessages(roomId) {
  if (!roomId) return;
  const cached = state.messageCache.get(roomId);
  const sinceSeq = cached?.maxSeq || 0;
  try {
    const data = await api(`/api/rooms/${roomId}/messages?since_seq=${sinceSeq}&limit=200`);
    const incoming = Array.isArray(data.messages) ? data.messages : [];
    const messages = cached ? [...cached.messages] : [];
    const seen = new Set(messages.map((m) => m.id));
    for (const m of incoming) {
      if (!seen.has(m.id)) { messages.push(m); seen.add(m.id); }
    }
    const maxSeq = messages.reduce((acc, m) => Math.max(acc, Number(m.seq || 0)), sinceSeq);
    state.messageCache.set(roomId, { messages, maxSeq });
  } catch (err) {
    console.warn("[web] ensureRoomMessages failed:", err);
  }
}

async function ensureRoomMembers(roomId) {
  if (!roomId || state.roomMembersCache.has(roomId)) return;
  try {
    const data = await api(`/api/rooms/${roomId}`);
    if (Array.isArray(data.members)) state.roomMembersCache.set(roomId, data.members);
  } catch (err) {
    console.warn("[web] ensureRoomMembers failed:", err);
  }
}

function lastSeenSeqForConversation(roomId) {
  const cached = state.messageCache.get(roomId);
  const maxSeq = Number(cached?.maxSeq || 0);
  return Number.isFinite(maxSeq) && maxSeq > 0 ? maxSeq : 0;
}

// ── cloud events (WS) ──────────────────────────────────────────────────────

// Resume cursor for replay (Phase 1.C). Per-account so logging out of A
// and into B doesn't replay A's events to B's session.
function lastEventSeqKey() { return `mia.web.lastEventSeq.${state.user?.id || "anon"}`; }
function loadLastEventSeq() {
  try { return Number(localStorage.getItem(lastEventSeqKey())) || 0; } catch { return 0; }
}
function saveLastEventSeq(n) {
  try { localStorage.setItem(lastEventSeqKey(), String(Math.max(0, Number(n) || 0))); } catch { /* silent */ }
}

function startCloudEvents() {
  if (!state.token) return;
  stopCloudEvents();
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const sinceSeq = loadLastEventSeq();
  const url = `${proto}//${window.location.host}/api/events?since_seq=${sinceSeq}`;
  let socket;
  try {
    socket = new WebSocket(url, ["mia-token." + state.token]);
  } catch (err) {
    console.warn("[web] WS connect failed:", err);
    scheduleReconnect();
    return;
  }
  eventsSocket = socket;
  // Bind the local `socket` ref so a stale close/error from a previous instance
  // can't clobber a newer healthy connection.
  socket.addEventListener("message", (event) => {
    if (eventsSocket !== socket) return;
    let envelope;
    try { envelope = JSON.parse(event.data); } catch { return; }
    // Track resume cursor (Phase 1.C). Persisted events carry `seq`;
    // events_ready may carry `serverSeq` (no replay needed case).
    if (Number.isFinite(Number(envelope.seq))) {
      if (Number(envelope.seq) > loadLastEventSeq()) saveLastEventSeq(envelope.seq);
    } else if (envelope.type === "events_ready") {
      // Defensive clamp: server tells us when our cursor is ahead of
      // its log (DB wipe / restore). Always honor resetTo; otherwise
      // bump if we're behind.
      if (envelope.resetTo != null && Number.isFinite(Number(envelope.resetTo))) {
        saveLastEventSeq(envelope.resetTo);
      } else if (Number.isFinite(Number(envelope.serverSeq))) {
        if (Number(envelope.serverSeq) > loadLastEventSeq()) saveLastEventSeq(envelope.serverSeq);
      }
    }
    handleCloudEvent(envelope);
  });
  socket.addEventListener("close", () => {
    if (eventsSocket !== socket) return;
    eventsSocket = null;
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    if (eventsSocket !== socket) return;
    try { socket.close(); } catch {}
  });
}

function stopCloudEvents() {
  if (eventsReconnectTimer) { clearTimeout(eventsReconnectTimer); eventsReconnectTimer = 0; }
  if (eventsSocket) {
    try { eventsSocket.close(); } catch {}
    eventsSocket = null;
  }
}

function scheduleReconnect() {
  if (!state.token) return;
  if (eventsReconnectTimer) return;
  eventsReconnectTimer = setTimeout(() => { eventsReconnectTimer = 0; startCloudEvents(); }, 3000);
}

function hermesEventType(event = {}) {
  return String(event.type || event.event || "");
}

function hermesEventText(event = {}) {
  for (const key of ["delta", "content_delta", "text_delta", "text", "content"]) {
    if (typeof event[key] === "string") return event[key];
  }
  const data = event.data && typeof event.data === "object" ? event.data : null;
  return data ? hermesEventText(data) : "";
}

function cloudRunFor(roomId, runId = "") {
  const existing = state.cloudAgentRunsByRoom.get(roomId);
  if (existing) return existing;
  const run = {
    roomId,
    runId,
    text: "",
    status: "running",
    createdAt: new Date().toISOString(),
    tools: [],
  };
  state.cloudAgentRunsByRoom.set(roomId, run);
  return run;
}

function handleCloudEvent(envelope) {
  const type = envelope?.type || "";
  if (type === "room.message_appended") {
    const msg = envelope.message;
    const roomId = msg?.room_id || envelope.room_id;
    if (!roomId) return;
    const entry = state.messageCache.get(roomId) || { messages: [], maxSeq: 0 };
    const fresh = !entry.messages.some((m) => m.id === msg.id);
    if (fresh) {
      entry.messages.push(msg);
      entry.maxSeq = Math.max(entry.maxSeq, Number(msg.seq || 0));
      state.messageCache.set(roomId, entry);
      if (msg.sender_kind === SenderKind.Fellow) state.cloudAgentRunsByRoom.delete(roomId);
      // Bump unread if the message isn't mine and the room isn't currently open.
      // Self-id check goes through shared/contact: resolveContact returns kind="self"
      // only when ref matches ctx.self.id (works for any sender kind).
      const author = window.miaContact.resolveContact(
        { kind: "user", ref: msg.sender_ref },
        { self: state.user, friends: state.friends }
      );
      const isMine = author.kind === "self";
      if (!isMine && roomId !== state.activeConversationId) {
        state.unread.set(roomId, (state.unread.get(roomId) || 0) + 1);
      }
    }
    if (roomId === state.activeConversationId) {
      state.unread.delete(roomId);
      renderActiveChat();
    }
    renderConversationList();
    renderSessionMenu();
    renderRailUnreadBadge();
  } else if (type === "cloud_agent_run_started") {
    const roomId = envelope.roomId;
    if (!roomId) return;
    const run = cloudRunFor(roomId, envelope.runId || "");
    run.runId = envelope.runId || run.runId;
    run.hermesRunId = envelope.hermesRunId || run.hermesRunId || "";
    run.fellowId = envelope.fellowId || run.fellowId || "";
    run.status = "running";
    if (roomId === state.activeConversationId) renderActiveChat();
  } else if (type === "cloud_agent_run_event") {
    const roomId = envelope.roomId;
    const event = envelope.event || {};
    if (!roomId) return;
    const run = cloudRunFor(roomId, envelope.runId || "");
    run.fellowId = envelope.fellowId || run.fellowId || "";
    const name = hermesEventType(event);
    if (name === "message.delta") {
      run.text += hermesEventText(event);
    } else if (name === "message.complete" || name === "message.completed") {
      run.text = hermesEventText(event) || run.text;
    } else if (name === "run.completed") {
      run.text = hermesEventText(event) || run.text;
      run.status = "complete";
    } else if (name === "run.failed") {
      run.status = "error";
    } else if (name === "run.cancelled") {
      run.status = "cancelled";
    } else if (name === "tool.started") {
      run.tools.push({ name: String(event.tool || event.name || event.data?.tool || "工具"), status: "running" });
    } else if (name === "tool.completed") {
      const toolName = String(event.tool || event.name || event.data?.tool || "");
      const tool = [...run.tools].reverse().find((item) => !toolName || item.name === toolName);
      if (tool) tool.status = event.error || event.data?.error ? "error" : "complete";
    }
    if (roomId === state.activeConversationId) renderActiveChat();
  } else if (type === "device_updated") {
    if (Array.isArray(envelope.devices)) state.bridgeDevices = envelope.devices;
    renderActiveChat();
  } else if (type === "bridge_run_updated") {
    const status = envelope.run?.status;
    if (status === "pending" || status === "running") state.bridgeBusy = true;
    else state.bridgeBusy = false;
    renderActiveChat();
  } else if (type === "social.friend_request_received") {
    if (envelope.request) state.incomingRequests = [envelope.request, ...state.incomingRequests];
    showToast(`收到 ${envelope.request?.from?.username || "好友"} 的好友请求`);
  } else if (type === "social.friend_added") {
    if (envelope.friend) {
      state.friends = [envelope.friend, ...state.friends.filter((f) => f.id !== envelope.friend.id)];
    }
    if (envelope.room) {
      state.rooms = [envelope.room, ...state.rooms.filter((r) => r.id !== envelope.room.id)];
    }
    state.incomingRequests = state.incomingRequests.filter((r) => r.from_user !== envelope.friend?.id && r.to_user !== envelope.friend?.id);
    state.outgoingRequests = state.outgoingRequests.filter((r) => r.to_user !== envelope.friend?.id);
    renderConversationList();
  } else if (type === "social.room_invited") {
    if (envelope.room) {
      state.rooms = [envelope.room, ...state.rooms.filter((r) => r.id !== envelope.room.id)];
      state.roomMembersCache.delete(envelope.room.id);
    }
    renderConversationList();
  } else if (type === "room.updated") {
    // PATCH /api/rooms/:id from any device — merge the patched room.
    if (envelope.room) {
      state.rooms = state.rooms.map((r) => (r.id === envelope.room.id ? { ...r, ...envelope.room } : r));
      renderConversationList();
      if (state.activeConversationId === envelope.room.id) renderActiveChat();
      renderSessionMenu();
    }
  } else if (type === "room.deleted") {
    // DELETE /api/rooms/:id from any device — purge local state.
    const roomId = envelope.roomId;
    if (roomId) {
      state.rooms = state.rooms.filter((r) => r.id !== roomId);
      state.unread.delete(roomId);
      state.roomMembersCache.delete(roomId);
      if (state.activeConversationId === roomId) state.activeConversationId = "";
      renderConversationList();
      renderActiveChat();
    }
  } else if (type === "fellow.upserted") {
    // Phase 2: another device created/edited a fellow — replace by id so
    // names/avatars stay current across this browser too.
    const fellow = envelope.fellow;
    if (fellow && fellow.id) {
      state.fellows = [fellow, ...state.fellows.filter((f) => f.id !== fellow.id)];
      renderConversationList();
      renderActiveChat();
      renderSessionMenu();
    }
  } else if (type === "fellow.runtime_updated") {
    const binding = envelope.binding;
    if (binding?.fellowId && binding?.runtimeKind) {
      state.fellowRuntimeCache.set(runtimeCacheKey(binding.fellowId, binding.runtimeKind), binding);
      renderActiveChat();
    }
  } else if (type === "fellow.deleted") {
    const fellowId = envelope.fellowId;
    if (fellowId) {
      state.fellows = state.fellows.filter((f) => f.id !== fellowId);
      renderConversationList();
      renderActiveChat();
    }
  } else if (type === "user_settings.updated") {
    // Phase 3: another device wrote settings — replace local copy. Last
    // write wins because the server stamps updatedAt and we don't try
    // to merge field-by-field (settings bags are small and replaced as
    // a whole).
    if (envelope.settings) {
      state.settings = envelope.settings;
      renderConversationList();
    }
  }
}

// ── conversation list (rooms + desktop-synced fellow chats merged) ────────

function friendById(userId) {
  if (userId === state.user?.id) return state.user;
  return state.friends.find((f) => f.id === userId) || null;
}

function friendUsernameById(userId) {
  return friendById(userId)?.username || userId;
}

function roomDisplayTitle(room) {
  if (room.id?.startsWith("dm:")) {
    const parts = room.id.split(":");
    const otherId = parts[1] === state.user?.id ? parts[2] : parts[1];
    return friendUsernameById(otherId);
  }
  if (room.type === "fellow" || room.id?.startsWith("fellow:")) {
    return sessionHistory.fellowDisplayTitle(room, state.fellows, "对话");
  }
  return room.name || "未命名群聊";
}

function roomTypeForControls(room) {
  return sessionHistory.roomType(room, room?.id || "");
}

function fellowKeyForRoom(room) {
  return sessionHistory.fellowKey(room);
}

function fellowByKey(key) {
  const wanted = String(key || "");
  return state.fellows.find((fellow) => String(fellow.id || fellow.key || "") === wanted) || null;
}

function runtimeKindForFellowRoom(room, fellow) {
  void fellow;
  return sessionHistory.runtimeKind(room, "desktop-local");
}

function engineForRuntimeKind(runtimeKind) {
  const kind = String(runtimeKind || "").trim();
  if (kind === "cloud-hermes" || kind === "desktop-local") return "hermes";
  return normalizeAgentEngine(kind);
}

function engineForRuntimeBinding(runtimeKind, binding) {
  const config = binding?.config || {};
  if (runtimeKind === "desktop-local" && config.agentEngine) return normalizeAgentEngine(config.agentEngine);
  return engineForRuntimeKind(runtimeKind);
}

function runtimeCacheKey(fellowKey, runtimeKind) {
  if (typeof fellowRuntimeControl.runtimeCacheKey === "function") {
    return fellowRuntimeControl.runtimeCacheKey(fellowKey, runtimeKind || "cloud-hermes");
  }
  return `${fellowKey}:${runtimeKind || "cloud-hermes"}`;
}

function runtimeBindingFor(fellowKey, runtimeKind) {
  return state.fellowRuntimeCache.get(runtimeCacheKey(fellowKey, runtimeKind)) || null;
}

function normalizePlatformModel(model = {}) {
  const id = String(model.id || model.model_name || model.model || "").trim();
  if (!id) return null;
  return {
    value: id,
    label: String(model.label || model.name || id).trim(),
    provider: String(model.provider || "").trim(),
    model: String(model.model || model.upstreamModel || model.upstream_model || id).trim()
  };
}

async function loadPlatformModels() {
  try {
    const data = await api("/api/me/model-catalog");
    state.platformModels = (Array.isArray(data.models) ? data.models : [])
      .map(normalizePlatformModel)
      .filter(Boolean);
  } catch (err) {
    console.warn("[web] platform model catalog failed:", err);
    state.platformModels = [];
  }
}

async function ensureFellowRuntime(fellowKey, runtimeKind = "cloud-hermes") {
  if (!fellowKey) return null;
  const key = runtimeCacheKey(fellowKey, runtimeKind);
  if (state.fellowRuntimeCache.has(key)) return state.fellowRuntimeCache.get(key);
  if (typeof fellowRuntimeControl.getFellowRuntimeBinding !== "function") {
    state.fellowRuntimeCache.set(key, null);
    return null;
  }
  try {
    return await fellowRuntimeControl.getFellowRuntimeBinding({
      api,
      cache: state.fellowRuntimeCache,
      fellowKey,
      runtimeKind
    });
  } catch (err) {
    console.warn("[web] fellow runtime GET failed:", err);
    state.fellowRuntimeCache.set(key, null);
    return null;
  }
}

function selectEntriesForModel(engine, runtimeKind, config = {}) {
  if (runtimeKind === "desktop-local" && Array.isArray(config.modelEntries) && config.modelEntries.length) {
    return config.modelEntries.map((entry) => ({
      value: String(entry.value || entry.id || entry.model || ""),
      model: String(entry.model || entry.value || entry.id || ""),
      label: String(entry.label || entry.model || entry.value || entry.id || "Default"),
      provider: String(entry.provider || ""),
      providerLabel: String(entry.providerLabel || entry.provider_label || "")
    })).filter((entry) => entry.value || entry.model);
  }
  if (runtimeKind === "desktop-local" && (engine === "claude-code" || engine === "codex")) {
    return externalModelEntries(engine).map((entry) => ({
      value: entry.model || entry.id,
      model: entry.model,
      label: entry.label || entry.model || entry.id,
      provider: entry.provider || (engine === "codex" ? "openai-codex" : "anthropic")
    }));
  }
  if (runtimeKind === "desktop-local" && config.model) {
    return [{ value: config.model, label: config.model, model: config.model, provider: config.provider || "" }];
  }
  if (runtimeKind === "cloud-hermes" || engine === "hermes") {
    return state.platformModels.length
      ? state.platformModels
      : [{ value: "mia-default", label: "Mia Default" }];
  }
  return externalModelEntries(engine).map((entry) => ({
    value: entry.id,
    model: entry.model,
    label: entry.label || entry.model || entry.id,
    provider: entry.provider || (engine === "codex" ? "openai-codex" : "anthropic")
  }));
}

function selectEntriesForPermission(engine, runtimeKind) {
  if (runtimeKind === "desktop-local" && (engine === "claude-code" || engine === "codex")) {
    return externalPermissionOptions(engine);
  }
  if (runtimeKind === "desktop-local") {
    return [
      { value: "ask", label: "Ask" },
      { value: "yolo", label: "YOLO" },
      { value: "deny", label: "Deny" }
    ];
  }
  if (runtimeKind === "cloud-hermes" || engine === "hermes") {
    return [
      { value: "ask", label: "Ask" },
      { value: "auto", label: "Auto" },
      { value: "readOnly", label: "Read" }
    ];
  }
  return externalPermissionOptions(engine);
}

function setSelectOptions(select, entries, selectedValue, fallbackLabel) {
  if (!select) return "";
  const normalized = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.value !== undefined)
    .map((entry) => ({
      value: String(entry.value),
      label: String(entry.label || entry.value),
      title: String(entry.title || "")
    }));
  const value = String(selectedValue || normalized[0]?.value || "");
  const options = normalized.length ? normalized : [{ value, label: fallbackLabel || value || "Default", title: "" }];
  if (value && !options.some((entry) => entry.value === value)) {
    options.unshift({ value, label: fallbackLabel || value, title: "" });
  }
  select.innerHTML = options.map((entry) => (
    `<option value="${escapeHtml(entry.value)}"${entry.title ? ` title="${escapeHtml(entry.title)}"` : ""}>${escapeHtml(entry.label)}</option>`
  )).join("");
  select.value = value || options[0]?.value || "";
  return select.selectedOptions?.[0]?.textContent || fallbackLabel || "";
}

function setModelSwitchStatus() {
}

function renderComposerControls(room = null) {
  const show = roomTypeForControls(room) === "fellow";
  els.composerBottom?.classList.toggle("hidden", !show);
  if (!show) return;

  const fellowKey = fellowKeyForRoom(room);
  const fellow = fellowByKey(fellowKey);
  const runtimeKind = runtimeKindForFellowRoom(room, fellow);
  const binding = runtimeBindingFor(fellowKey, runtimeKind);
  const config = binding?.config || {};
  const engine = engineForRuntimeBinding(runtimeKind, binding);
  const editable = Boolean(fellowKey);

  const cloudModelEntries = selectEntriesForModel(engine, runtimeKind, config);
  const modelValue = config.model || (runtimeKind === "desktop-local" && (engine === "claude-code" || engine === "codex") ? "default" : cloudModelEntries[0]?.value || "mia-default");
  const modelLabel = setSelectOptions(els.quickModelSelect, cloudModelEntries, modelValue, config.model || "Default");
  const selectedModelEntry = cloudModelEntries.find((entry) => String(entry.value) === String(els.quickModelSelect?.value || modelValue))
    || cloudModelEntries.find((entry) => String(entry.model) === String(config.model || ""))
    || {};
  setModelAvatar(engine, selectedModelEntry, config);
  if (els.quickModelLabel) els.quickModelLabel.textContent = modelLabel || "Default";

  const effort = config.effortLevel || "medium";
  const effortLabel = setSelectOptions(els.effortSelect, effortOptions(engine), effort, "Medium");
  if (els.effortLabel) els.effortLabel.textContent = effortLabel || "Medium";

  const permission = config.permissionMode || (runtimeKind === "desktop-local" && (engine === "claude-code" || engine === "codex") ? "default" : "ask");
  const permissionLabel = setSelectOptions(els.permissionMode, selectEntriesForPermission(engine, runtimeKind), permission, "Ask");
  if (els.permissionLabel) els.permissionLabel.textContent = permissionLabel || "Ask";
  const permissionWrap = els.permissionMode?.closest?.(".permission-switcher");
  permissionWrap?.classList.toggle("yolo", permission === "bypassPermissions");
  permissionWrap?.classList.toggle("claude-bypass", engine === "claude-code" && permission === "bypassPermissions");

  if (els.quickModelSelect) els.quickModelSelect.disabled = !editable;
  if (els.effortSelect) els.effortSelect.disabled = !editable;
  if (els.permissionMode) els.permissionMode.disabled = !editable;
  setModelSwitchStatus(engineLabel(engine), editable);

  if (editable && !state.fellowRuntimeCache.has(runtimeCacheKey(fellowKey, runtimeKind))) {
    ensureFellowRuntime(fellowKey, runtimeKind).then(() => {
      if (state.activeConversationId === room.id) renderActiveChat();
    });
  }
}

async function saveWebAiControl(kind, value) {
  const room = state.rooms.find((r) => r.id === state.activeConversationId);
  if (roomTypeForControls(room) !== "fellow") return;
  const fellowKey = fellowKeyForRoom(room);
  const runtimeKind = runtimeKindForFellowRoom(room, fellowByKey(fellowKey));
  if (!fellowKey) {
    showToast("当前对话没有可配置的 fellow。");
    renderComposerControls(room);
    return;
  }
  const key = runtimeCacheKey(fellowKey, runtimeKind);
  const current = runtimeBindingFor(fellowKey, runtimeKind) || await ensureFellowRuntime(fellowKey, runtimeKind) || {
    fellowId: fellowKey,
    runtimeKind,
    enabled: true,
    config: {}
  };
  const config = { ...(current.config || {}) };
  const engine = engineForRuntimeBinding(runtimeKind, current);
  const modelEntries = kind === "model" ? selectEntriesForModel(engine, runtimeKind, config) : [];
  setModelSwitchStatus("保存中...", true);
  try {
    if (typeof fellowRuntimeControl.saveFellowRuntimeControl !== "function") {
      throw new Error("Fellow runtime control is unavailable.");
    }
    const result = await fellowRuntimeControl.saveFellowRuntimeControl({
      api,
      cache: state.fellowRuntimeCache,
      fellow: { key: fellowKey, id: fellowKey, runtimeKind },
      fellowKey,
      runtimeKind,
      field: kind,
      value,
      modelEntries
    });
    if (result?.binding) state.fellowRuntimeCache.set(key, result.binding);
    renderComposerControls(room);
    setModelSwitchStatus("已更新", true);
  } catch (err) {
    showToast(err.message || "设置保存失败");
    setModelSwitchStatus("保存失败", false);
    renderComposerControls(room);
  }
}

function roomLastMessageText(room) {
  const cached = state.messageCache.get(room.id);
  const last = cached?.messages?.[cached.messages.length - 1];
  if (!last) return "暂无对话";
  return last.body_md || (last.attachments ? "[附件]" : "");
}

function roomSortKey(room) {
  return sessionHistory.roomSortTime(room, state.messageCache);
}

function cryptoRandomId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `session_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function activeSessionRoom() {
  return state.rooms.find((room) => room.id === state.activeConversationId) || null;
}

function sessionTitleForRoom(room) {
  return sessionHistory.sessionTitle(room, {
    fellows: state.fellows,
    defaultTitle: "新对话",
    groupTitle: "群聊",
    dmTitle: roomDisplayTitle,
    dmTitleFallback: "私聊"
  });
}

function sessionRoomsForRoom(room) {
  return sessionHistory.sessionRoomsForRoom(room, state.rooms, { messageCache: state.messageCache });
}

function updateCurrentSessionTitle(title) {
  if (!els.currentSessionTitle) return;
  const next = title || "新对话";
  if (els.currentSessionTitle.textContent === next) return;
  els.currentSessionTitle.textContent = next;
  els.currentSessionTitle.classList.remove("title-updated");
  requestAnimationFrame(() => els.currentSessionTitle?.classList.add("title-updated"));
}

async function renameSessionRoom(room) {
  if (!room || roomTypeForControls(room) === "dm") return;
  const title = window.prompt("重命名这个会话", sessionTitleForRoom(room));
  if (title === null) return;
  const trimmed = String(title || "").trim();
  if (!trimmed) return;
  try {
    const res = await api(`/api/rooms/${room.id}`, { method: "PATCH", body: { name: trimmed } });
    const updated = res?.room || { ...room, name: trimmed };
    state.rooms = state.rooms.map((candidate) => (candidate.id === room.id ? { ...candidate, ...updated } : candidate));
    renderConversationList();
    renderActiveChat();
    renderSessionMenu();
  } catch (err) {
    showToast(err.message || "重命名失败");
  }
}

function selectSessionRoom(room) {
  if (!room?.id) return;
  state.sessionMenuOpen = false;
  setActiveConversation(room.id);
}

async function createNewSessionForActive() {
  const room = activeSessionRoom();
  if (!sessionHistory.canCreateSession(room)) return;
  const payload = sessionHistory.createFellowSessionPayload(room, cryptoRandomId(), {
    title: "新对话",
    runtimeKindFallback: "desktop-local"
  });
  const fellowKey = payload.fellowKey;
  if (!fellowKey) return;
  try {
    const res = await api(`/api/me/fellow-rooms/${encodeURIComponent(payload.sessionId)}`, {
      method: "PUT",
      body: {
        fellowKey,
        title: payload.title,
        runtimeKind: payload.runtimeKind
      }
    });
    const created = res?.room;
    if (!created?.id) return;
    state.rooms = [created, ...state.rooms.filter((candidate) => candidate.id !== created.id)];
    if (Array.isArray(res.members)) state.roomMembersCache.set(created.id, res.members);
    state.messageCache.set(created.id, { messages: [], maxSeq: 0 });
    state.sessionMenuOpen = false;
    setActiveConversation(created.id);
  } catch (err) {
    showToast(err.message || "新建会话失败");
  }
}

function renderSessionMenu() {
  if (!els.sessionMenu || !els.sessionList) return;
  const room = activeSessionRoom();
  const hasRoom = Boolean(room);
  els.sessionMenuButton?.classList.toggle("hidden", !hasRoom);
  els.sessionMenu.classList.toggle("hidden", !hasRoom || !state.sessionMenuOpen);
  if (!hasRoom) {
    els.sessionList.innerHTML = "";
    updateCurrentSessionTitle("新对话");
    return;
  }

  const rooms = sessionRoomsForRoom(room);
  const canCreate = sessionHistory.canCreateSession(room);
  els.newSession?.classList.toggle("hidden", !canCreate);
  updateCurrentSessionTitle(sessionTitleForRoom(room));
  els.sessionList.innerHTML = "";
  for (const item of rooms) {
    const editable = roomTypeForControls(item) !== "dm";
    const row = document.createElement("button");
    row.type = "button";
    row.className = `session-row${item.id === room.id ? " active" : ""}`;
    row.innerHTML = `
      <span>
        <strong>${escapeHtml(sessionTitleForRoom(item))}</strong>
        <small>${escapeHtml(new Date(roomSortKey(item) || Date.now()).toLocaleString())}</small>
      </span>
      ${editable ? `<em title="重命名" data-session-edit="${escapeHtml(item.id)}">✎</em>` : "<i></i>"}
    `;
    row.addEventListener("click", (event) => {
      if (event.target.closest("[data-session-edit]")) {
        event.stopPropagation();
        renameSessionRoom(item);
        return;
      }
      selectSessionRoom(item);
    });
    els.sessionList.appendChild(row);
  }
}

// (desktopConvLastMessageText / desktopConvSortKey removed in
//  Phase 4 cutover.)

function groupTilesCtx() {
  return {
    self: state.user || null,
    friends: state.friends || [],
    fellows: state.fellows || []
  };
}

// Unified item shape so the renderer doesn't have to branch every time.
// Pinned items sort to the top regardless of recency, mirroring the
// ChatGPT-style pin behavior the user asked for.
function combinedConversationItems() {
  const sidebarRooms = sessionHistory.sidebarRooms(state.rooms, {
    activeRoomId: state.activeConversationId,
    messageCache: state.messageCache
  });
  const room = sidebarRooms.map((r) => {
    // id-prefix fallback for cloud deployments that haven't shipped the v7
    // type column yet. Remove once every server is on schema ≥ v7.
    const isDM = r.type === "dm" || r.id?.startsWith("dm:");
    const isFellow = r.type === "fellow" || r.id?.startsWith("fellow:");
    const isGroup = r.type === "group" || (!isDM && !isFellow && (r.id?.startsWith("g_") || r.id?.startsWith("g-")));
    let avatar = "";
    let avatarCrop = null;
    let color = "";
    let memberTiles = null;
    if (isGroup) {
      const records = state.roomMembersCache.get(r.id) || [];
      memberTiles = window.miaGroupTiles.resolveGroupMemberTiles(records, groupTilesCtx());
    } else if (isDM) {
      const parts = r.id.split(":");
      const otherId = parts[1] === state.user?.id ? parts[2] : parts[1];
      const friend = friendById(otherId);
      if (friend) {
        avatar = friend.avatarImage || "";
        avatarCrop = friend.avatarCrop || null;
        color = friend.avatarColor || "";
      }
    } else if (isFellow) {
      const fellowKey = r.decorations?.fellowKey || (r.id?.split(":")[2] || "");
      const fellow = state.fellows?.find((f) => f.id === fellowKey);
      if (fellow) {
        avatar = fellow.avatarImage || "";
        avatarCrop = fellow.avatarCrop || null;
        color = fellow.color || "";
      }
    }
    return {
      kind: "room",
      id: r.id,
      title: roomDisplayTitle(r),
      preview: roomLastMessageText(r),
      sortKey: roomSortKey(r),
      isDM,
      isFellow,
      isGroup,
      avatar,
      avatarCrop,
      color,
      memberTiles,
      pinned: isRoomPinned(r.id)
    };
  });
  // (Phase 4 cutover: workspace conversations gone — every conversation
  //  is a room.)
  return room.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.sortKey - a.sortKey;
  });
}

function renderConversationList() {
  const query = String(els.conversationSearch.value || "").trim().toLowerCase();
  const all = combinedConversationItems();
  const items = query ? all.filter((it) => it.title.toLowerCase().includes(query)) : all;

  if (!items.length) {
    const empty = state.user
      ? "没有会话。点击右上 + 添加好友或发起群聊；或在桌面端登录同账号并点同步。"
      : "请先登录。";
    els.conversationList.innerHTML = `<p class="persona-empty">${empty}</p>`;
    return;
  }

  els.conversationList.innerHTML = items.map((it) => {
    const avatarLabel = (it.title[0] || "?").toUpperCase();
    let color = "#5e5ce6";
    if (it.kind === "room") color = it.color || (it.isDM ? "#5e5ce6" : "#34c759");
    if (it.kind === "desktop") color = it.color || "#ff9f0a";
    // Group rooms: paint a mosaic from real member avatars. The tile
    // markup is built into avatarHtml, replacing the single-letter avatar
    // span used for 1-on-1 rows.
    let avatarMarkup = "";
    if (it.isGroup) {
      const tiles = Array.isArray(it.memberTiles) ? it.memberTiles : [];
      const tileSpans = tiles.map((tile) => {
        const fallback = tile.color || "#5e5ce6";
        return avatarHtml({
          className: "group-avatar-tile",
          image: tile.image,
          crop: tile.crop,
          color: fallback
        });
      }).join("");
      avatarMarkup = `<span class="avatar group-avatar" data-count="${tiles.length}">${tileSpans}</span>`;
    } else {
      avatarMarkup = avatarHtmlForConversation(it, color, avatarLabel);
    }
    // ⋯ menu: workspace conversations + cloud rooms (PATCH/DELETE /api/rooms
    // shipped — see commit 90671e4). Pin uses local storage; rename + delete
    // hit the cloud.
    const hasMenu = it.kind === "desktop" || it.kind === "room";
    const unread = computeUnreadForConversation({ id: it.id }, state.unread);
    // Shared module owns the truncation policy (e.g. "99+"). Web uses its own
    // .persona-unread class for the list row, so re-extract the truncated
    // text from the shared badge HTML and re-wrap it with the web class.
    const unreadText = unreadBadgeText(unread);
    const unreadHtml = unread > 0
      ? `<span class="persona-unread" aria-label="${unread} 条未读">${escapeHtml(unreadText)}</span>`
      : "";
    const timeLabel = it.sortKey ? formatConversationTime(it.sortKey) : "";
    // Right-side column: when unread, show the red badge; otherwise show the
    // last-activity timestamp (HH:MM / 昨天 / M/D) like desktop cards.
    const sideHtml = unread > 0
      ? unreadHtml
      : (timeLabel ? `<span class="persona-time">${escapeHtml(timeLabel)}</span>` : "");
    return `
      <div class="persona-row${it.pinned ? " pinned" : ""}${it.id === state.activeConversationId ? " active" : ""}${unread > 0 ? " has-unread" : ""}">
        <button class="persona" type="button" data-conv-id="${escapeHtml(it.id)}" data-conv-kind="${it.kind}">
          ${avatarMarkup}
          <span class="persona-main">
            <strong class="persona-name">${it.pinned ? "📌 " : ""}${escapeHtml(it.title)}</strong>
            <span class="persona-preview">${escapeHtml(it.preview)}</span>
          </span>
          ${sideHtml}
        </button>
        ${hasMenu ? `<button class="persona-more" type="button" data-conv-more="${escapeHtml(it.id)}" aria-label="更多操作" title="更多操作">⋯</button>` : ""}
      </div>
    `;
  }).join("");
  hydrateAvatarVideos(els.conversationList);
}

// Strip the wrapping <span class="unread-badge"> shared/unread produces so we
// can drop the truncated text into the rail <em> (already styled as a badge)
// or the .persona-unread list span. Keeps "99+" policy in one place.
function unreadBadgeText(count) {
  const html = unreadBadgeHtml(count);
  if (!html) return "";
  return html.replace(/<\/?span[^>]*>/g, "");
}

function renderRailUnreadBadge() {
  if (!els.unreadCount) return;
  const total = totalUnreadFromConversations(null, state.unread);
  if (total > 0) {
    els.unreadCount.textContent = unreadBadgeText(total);
    els.unreadCount.hidden = false;
  } else {
    els.unreadCount.hidden = true;
  }
}

// ── per-conversation ⋯ menu ────────────────────────────────────────────────

let _convMenuEl = null;
let _convMenuTargetId = "";

function ensureConvMenuEl() {
  if (_convMenuEl) return _convMenuEl;
  _convMenuEl = document.createElement("div");
  _convMenuEl.className = "conv-menu hidden";
  document.body.appendChild(_convMenuEl);
  document.addEventListener("click", (event) => {
    if (_convMenuEl?.contains(event.target)) return;
    if (event.target.closest("[data-conv-more]")) return;
    closeConvMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeConvMenu();
  });
  return _convMenuEl;
}

// Pin state lives in state.settings.pins (cloud-canonical, Phase 3).
// state.settings is loaded from GET /api/me/settings on bootstrap and
// kept current via user_settings.updated WS events. Local mutation goes
// through pushSettings() which optimistically updates state.settings,
// fires a PUT, and the broadcast comes back to confirm (or replace) it.
function isRoomPinned(roomId) {
  if (!roomId) return false;
  return Array.isArray(state.settings?.pins) && state.settings.pins.includes(roomId);
}
async function setRoomPinned(roomId, pinned) {
  if (!roomId) return;
  const current = Array.isArray(state.settings?.pins) ? state.settings.pins : [];
  const nextPins = pinned ? [...new Set([...current, roomId])] : current.filter((id) => id !== roomId);
  await pushSettings({ pins: nextPins });
}

// Optimistic settings update with CAS retry. Stages the patch locally,
// PUTs with expectedVersion; on 409 conflict re-reads server state,
// merges our delta on top (last-writer-wins per field), retries once.
async function pushSettings(patch, _retried = false) {
  const base = state.settings || { pins: [], readMarks: {}, appearance: {}, version: 0 };
  const next = {
    pins: patch.pins !== undefined ? patch.pins : base.pins,
    readMarks: patch.readMarks !== undefined ? { ...(base.readMarks || {}), ...patch.readMarks } : base.readMarks,
    appearance: patch.appearance !== undefined ? { ...(base.appearance || {}), ...patch.appearance } : base.appearance,
    expectedVersion: base.version || 0
  };
  state.settings = { ...next, version: base.version };
  renderConversationList();
  try {
    const res = await api("/api/me/settings", { method: "PUT", body: next });
    if (res?.settings) state.settings = res.settings;
  } catch (err) {
    // /HTTP 409/ → conflict: server state moved on; refresh + retry once
    // with patch reapplied so our delta isn't lost.
    if (!_retried && /409|version conflict/i.test(String(err?.message || ""))) {
      try {
        const fresh = await api("/api/me/settings", { method: "GET" });
        if (fresh?.settings) state.settings = fresh.settings;
        return pushSettings(patch, true);
      } catch { /* fall through */ }
    }
    console.warn("[web] settings PUT failed:", err);
  }
}

function openConvMenu(convId, anchorButton) {
  const el = ensureConvMenuEl();
  _convMenuTargetId = convId;
  const room = state.rooms.find((r) => r.id === convId);
  if (!room) return;
  const isDM = convId.startsWith("dm:");
  const pinned = isRoomPinned(convId);
  // Cloud DM rename is hidden — display name comes from the peer's profile,
  // not the room record. Server rejects it.
  const showRename = !isDM;
  el.innerHTML = `
    <button type="button" data-conv-action="pin">${pinned ? "取消置顶" : "置顶"}</button>
    ${showRename ? `<button type="button" data-conv-action="rename">编辑</button>` : ""}
    <button type="button" data-conv-action="delete" class="conv-menu-danger">删除</button>
  `;
  el.classList.remove("hidden");
  // Anchor under-right of the ⋯ button.
  const rect = anchorButton.getBoundingClientRect();
  const menuW = 130;
  const left = Math.min(window.innerWidth - menuW - 8, Math.max(8, rect.right - menuW));
  const top = rect.bottom + 4;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function closeConvMenu() {
  if (!_convMenuEl) return;
  _convMenuEl.classList.add("hidden");
  _convMenuTargetId = "";
}

// (syncWorkspaceChange removed in Phase 4 cutover — every action
//  routes through handleRoomAction now.)

async function handleConvAction(action, convId) {
  const room = state.rooms.find((r) => r.id === convId);
  if (room) return handleRoomAction(action, room);
}

async function handleRoomAction(action, room) {
  const title = roomDisplayTitle(room);
  if (action === "pin") {
    await setRoomPinned(room.id, !isRoomPinned(room.id));
    return;
  }
  if (action === "rename") {
    if (room.id.startsWith("dm:")) return; // Hidden in menu; defensive.
    const next = window.prompt("编辑群组名称：", room.name || "");
    if (next === null) return;
    const trimmed = String(next).trim();
    if (!trimmed) return;
    try {
      const res = await api(`/api/rooms/${room.id}`, { method: "PATCH", body: { name: trimmed } });
      if (res?.room) {
        state.rooms = state.rooms.map((r) => (r.id === room.id ? { ...r, ...res.room } : r));
        renderConversationList();
      }
    } catch (err) {
      showToast(err.message || "重命名失败");
    }
    return;
  }
  if (action === "delete") {
    if (!window.confirm(`确认删除"${title}"？此操作不可撤销，所有成员都将无法访问。`)) return;
    try {
      await api(`/api/rooms/${room.id}`, { method: "DELETE" });
      state.rooms = state.rooms.filter((r) => r.id !== room.id);
      state.unread.delete(room.id);
      state.roomMembersCache.delete(room.id);
      if (state.activeConversationId === room.id) state.activeConversationId = "";
      renderConversationList();
      renderActiveChat();
    } catch (err) {
      showToast(err.message || "删除失败");
    }
    return;
  }
}

// ── active chat view ───────────────────────────────────────────────────────

function buildRoomMessageArticle(msg, room) {
  // Sender resolution routes through the canonical adapter (cloud-room-source).
  // Web reads only MessageSpec fields — no schema branching here.
  const members = state.roomMembersCache.get(room.id) || [];
  const ctx = { self: state.user, friends: state.friends, fellows: state.fellows };
  const source = window.miaCloudRoomSource.createCloudRoomSource({
    room, messages: [msg], members, ctx
  });
  const spec = source.listMessages()[0];
  const isOwn = spec.isOwn;
  const senderLabel = spec.authorName;
  const senderAvatar = spec.avatar?.image || "";
  const senderCrop = spec.avatar?.crop || null;
  const senderColor = spec.avatar?.color || "";
  const cls = isOwn ? "message user" : "message assistant";
  const initial = isOwn
    ? (state.user?.username?.[0] || "M").toUpperCase()
    : (senderLabel?.[0] || "?").toUpperCase();
  const fallbackColor = isOwn ? "#0162db" : (senderColor || "#5e5ce6");
  const avatarMarkup = avatarHtml({
    className: "avatar",
    image: senderAvatar,
    crop: senderCrop,
    color: fallbackColor,
    text: initial
  });
  const bodyHtml = spec.bodyMd ? `<div class="bubble">${renderMarkdown(spec.bodyMd)}</div>` : "";
  const attachmentHtml = renderAttachmentChips(spec.attachments || msg.attachments || []);
  return `
    <article class="${cls}">
      ${avatarMarkup}
      <div class="message-stack">
        ${senderLabel && !isOwn ? `<span class="message-sender">${escapeHtml(senderLabel)}</span>` : ""}
        ${bodyHtml}
        ${attachmentHtml}
        <span class="message-time">${escapeHtml(formatMessageTime(spec.createdAt))}</span>
      </div>
    </article>
  `;
}

function buildCloudAgentStreamingArticle(room, run) {
  if (!room || !run || (run.status === "complete" && !run.text && !run.tools.length)) return "";
  const fellowKey = run.fellowId || room.decorations?.fellowKey || (room.id?.startsWith("fellow:") ? room.id.split(":")[2] : "mia");
  const msg = {
    id: `cloud-agent-stream-${run.runId || room.id}`,
    sender_kind: "fellow",
    sender_ref: fellowKey,
    body_md: run.text || "",
    created_at: run.createdAt || new Date().toISOString(),
    seq: 0,
  };
  const members = state.roomMembersCache.get(room.id) || [];
  const ctx = { self: state.user, friends: state.friends, fellows: state.fellows };
  const source = window.miaCloudRoomSource.createCloudRoomSource({ room, messages: [msg], members, ctx });
  const spec = source.listMessages()[0];
  const avatar = spec.avatar || {};
  const avatarMarkup = avatarHtml({
    className: "avatar",
    image: avatar.image,
    crop: avatar.crop,
    color: avatar.color || "#5e5ce6",
    text: (spec.authorName?.[0] || "?").toUpperCase()
  });
  const textHtml = run.text ? `<div class="bubble">${renderMarkdown(run.text)}</div>` : "";
  const statusHtml = run.status === "running"
    ? `<div class="bubble"><span class="typing-status">正在输入<span class="typing-dots"><i></i><i></i><i></i></span></span></div>`
    : "";
  const toolsHtml = run.tools.length
    ? `<div class="message-attachments">${run.tools.slice(-3).map((tool) => `<span class="message-attachment"><span>TOOL</span><strong>${escapeHtml(tool.name || "工具")}</strong><em>${escapeHtml(tool.status || "")}</em></span>`).join("")}</div>`
    : "";
  return `
    <article class="message assistant streaming">
      ${avatarMarkup}
      <div class="message-stack">${textHtml}${statusHtml}${toolsHtml}</div>
    </article>
  `;
}

function renderCommandResultHtml(commandResult) {
  if (!commandResult || commandResult.type !== "session-list" || !Array.isArray(commandResult.rows)) return "";
  const rows = commandResult.rows.slice(0, 10).map((row) => {
    const title = String(row.title || row.id || "Session");
    const preview = String(row.preview || row.project || row.id || "");
    const updatedAt = Number(row.updatedAt) || 0;
    const time = updatedAt ? formatConversationTime(new Date(updatedAt).toISOString()) : "";
    return `
      <div class="command-session-row" data-command-resume-id="${escapeHtml(row.id || "")}">
        <span class="command-session-main">
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(preview || row.id || "")}</small>
        </span>
        <span class="command-session-side">${escapeHtml(time)}</span>
      </div>
    `;
  }).join("");
  return rows ? `<div class="command-result session-list">${rows}</div>` : "";
}

// (buildDesktopMessageArticle removed in Phase 4 cutover — fellow chats
//  render through buildRoomMessageArticle now.)

function setComposerEnabled(enabled, placeholder) {
  els.chatInput.disabled = !enabled;
  els.sendButton.disabled = !enabled;
  if (placeholder) els.chatInput.placeholder = placeholder;
}

function renderActiveChat() {
  const id = state.activeConversationId;
  if (!id) {
    els.activeAvatar.style.backgroundImage = "";
    els.activeAvatar.style.backgroundColor = "transparent";
    els.activeAvatar.textContent = "";
    els.activeTitle.textContent = "Mia";
    els.activeMeta.textContent = "选择一个会话开始聊天";
    els.chat.innerHTML = `<p class="persona-empty">还没有选中的会话。</p>`;
    setComposerEnabled(false, "选择一个会话开始聊天");
    renderComposerControls(null);
    state.sessionMenuOpen = false;
    renderSessionMenu();
    return;
  }

  if (isRoomId(id)) {
    const room = state.rooms.find((r) => r.id === id);
    if (!room) {
      setComposerEnabled(false, "会话不存在");
      renderComposerControls(null);
      state.sessionMenuOpen = false;
      renderSessionMenu();
      return;
    }
    const title = roomDisplayTitle(room);
    const roomType = roomTypeForControls(room);
    const isDM = roomType === "dm";
    const isFellow = roomType === "fellow";
    let peerAvatar = "";
    let peerCrop = null;
    let peerColor = "";
    if (isDM) {
      const parts = room.id.split(":");
      const otherId = parts[1] === state.user?.id ? parts[2] : parts[1];
      const friend = friendById(otherId);
      peerAvatar = friend?.avatarImage || "";
      peerCrop = friend?.avatarCrop || null;
      peerColor = friend?.avatarColor || "";
    } else if (isFellow) {
      const fellow = fellowByKey(fellowKeyForRoom(room));
      peerAvatar = fellow?.avatarImage || "";
      peerCrop = fellow?.avatarCrop || null;
      peerColor = fellow?.color || "";
    }
    applyAvatarMedia(
      els.activeAvatar,
      peerAvatar,
      peerCrop,
      peerColor || (isDM ? "#5e5ce6" : isFellow ? "#ff9f0a" : "#34c759"),
      (title[0] || "?").toUpperCase()
    );
    els.activeTitle.textContent = title;
    els.activeMeta.textContent = isDM ? "私聊" : isFellow ? "AI 私聊" : "群聊";
    renderSessionMenu();
    renderComposerControls(room);
    const cached = state.messageCache.get(room.id);
    const messages = cached?.messages || [];
    const streaming = buildCloudAgentStreamingArticle(room, state.cloudAgentRunsByRoom.get(room.id));
    els.chat.innerHTML = messages.length
      ? `${messages.map((m) => buildRoomMessageArticle(m, room)).join("")}${streaming}`
      : `<p class="persona-empty">还没有消息。</p>`;
    if (!messages.length && streaming) els.chat.innerHTML = streaming;
    hydrateAvatarVideos(els.chat);
    if (messages.length || streaming) els.chat.scrollTop = els.chat.scrollHeight;
    setComposerEnabled(true, "输入消息，Enter 发送，Shift+Enter 换行");
    return;
  }

  // (workspace-only render branch removed in Phase 4 cutover.)

  // Unknown conversation kind — defensively disable.
  setComposerEnabled(false, "不支持的会话类型");
  renderComposerControls(null);
  state.sessionMenuOpen = false;
  renderSessionMenu();
  els.chat.innerHTML = `<p class="persona-empty">不支持的会话类型。</p>`;
}

async function hydrateActiveConversation(id) {
  if (!id || !isRoomId(id)) return;
  await ensureRoomMessages(id);
  await ensureRoomMembers(id);
  const room = state.rooms.find((item) => item.id === id);
  if (roomTypeForControls(room) === "fellow") {
    await ensureFellowRuntime(fellowKeyForRoom(room), runtimeKindForFellowRoom(room, fellowByKey(fellowKeyForRoom(room))));
  }
  if (state.activeConversationId !== id) return;
  // Phase 3: persist the read mark to cloud so other devices clear their badge.
  // readMarks are message seq cursors, so compute after ensureRoomMessages().
  pushSettings({ readMarks: { [id]: lastSeenSeqForConversation(id) } })
    .catch((err) => console.warn("[web] mark-read settings PUT failed:", err));
  renderConversationList();
  renderActiveChat();
  renderRailUnreadBadge();
}

function setActiveConversation(id) {
  state.activeConversationId = id;
  state.unread.delete(id);
  renderConversationList();
  renderActiveChat();
  renderRailUnreadBadge();
  hydrateActiveConversation(id);
}

async function sendInActive() {
  const id = state.activeConversationId;
  if (!id) return;
  const rawText = els.chatInput.value || "";
  const members = isRoomId(id) ? (state.roomMembersCache.get(id) || []) : [];
  let prepared;
  try {
    prepared = prepareOutgoingMessage({ text: rawText }, { members });
  } catch (err) {
    if (err && err.code === "EMPTY_MESSAGE") return;
    showToast(err.message);
    return;
  }
  const text = prepared.bodyMd;

  if (isRoomId(id)) {
    els.chatInput.value = "";
    try {
      const res = await api(`/api/rooms/${id}/messages`, {
        method: "POST",
        body: {
          bodyMd: text,
          ...(prepared.mentions.length ? { mentions: prepared.mentions } : {})
        }
      });
      const msg = res?.message;
      if (msg && msg.id) {
        const entry = state.messageCache.get(id) || { messages: [], maxSeq: 0 };
        if (!entry.messages.some((m) => m.id === msg.id)) {
          entry.messages.push(msg);
          entry.maxSeq = Math.max(entry.maxSeq, Number(msg.seq || 0));
          state.messageCache.set(id, entry);
          if (id === state.activeConversationId) renderActiveChat();
          renderConversationList();
        }
      }
    } catch (err) {
      showToast(err.message);
      els.chatInput.value = text;
    }
    return;
  }

  // (workspace conversation send removed — fellow chats are rooms and
  //  go through the isRoomId branch above. If we ever want web-triggered
  //  agent execution for a fellow room, dispatch a bridge run AFTER the
  //  /api/rooms/:id/messages POST above; the bridge handler now writes
  //  the assistant reply into the same room via messagesStore.)
}

// ── create cloud fellow dialog ─────────────────────────────────────────────

let _createFellowModal = null;
let _avatarCropModal = null;

function webSlugFromFellowName(name) {
  return String(name || "fellow")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "fellow";
}

function cloudFellowKeyFromName(name, existingKeys = []) {
  const used = new Set(existingKeys.map((key) => String(key || "").trim()).filter(Boolean));
  const base = webSlugFromFellowName(name);
  let key = base;
  let index = 2;
  while (used.has(key)) {
    key = `${base}_${index}`;
    index += 1;
  }
  return key;
}

function webFellowDefaultDraft() {
  const first = WEB_AVATAR_PRESET_GROUPS.human[0];
  return {
    name: "",
    personaText: "",
    avatarImage: first.src,
    avatarCrop: webAvatarDefaultCropForSrc(first.src),
    avatarPresetGroup: "human",
    saving: false
  };
}

function setWebFellowAvatarDraft(draft, image, crop = null) {
  const src = String(image || "").trim();
  draft.avatarImage = src;
  draft.avatarCrop = webNormalizeAvatarCrop(crop || webAvatarDefaultCropForSrc(src));
  draft.avatarPresetGroup = webAvatarPresetGroupForSrc(src);
}

function renderWebFellowAvatarPreview(root, draft) {
  const preview = root?.querySelector?.("#webFellowAvatarPreview");
  if (!preview) return;
  applyAvatarMedia(preview, draft.avatarImage, draft.avatarCrop, "#eef0ff", "");
  preview.title = "点击调整头像";
}

function renderWebFellowAvatarDefaults(root, draft) {
  const tabs = root?.querySelector?.("#webFellowAvatarDefaultTabs");
  const defaults = root?.querySelector?.("#webFellowAvatarDefaults");
  if (!tabs || !defaults) return;
  const active = WEB_AVATAR_PRESET_GROUPS[draft.avatarPresetGroup] ? draft.avatarPresetGroup : "human";
  draft.avatarPresetGroup = active;
  tabs.innerHTML = WEB_AVATAR_PRESET_GROUP_TABS.map((group) => `
    <button type="button" class="${active === group.key ? "active" : ""}" data-avatar-group="${escapeHtml(group.key)}" role="tab" aria-selected="${active === group.key ? "true" : "false"}">${escapeHtml(group.label)}</button>
  `).join("");
  defaults.innerHTML = (WEB_AVATAR_PRESET_GROUPS[active] || []).map((preset) => `
    <button type="button" class="avatar-default${draft.avatarImage === preset.src ? " active" : ""}" data-avatar="${escapeHtml(preset.src)}" data-avatar-name="${escapeHtml(preset.name)}" title="${escapeHtml(preset.name)}" aria-label="${escapeHtml(preset.name)}" style="${avatarBackgroundStyle(preset.src, webAvatarDefaultCropForSrc(preset.src), "#eef0ff")}"></button>
  `).join("");
  tabs.querySelectorAll("[data-avatar-group]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!WEB_AVATAR_PRESET_GROUPS[button.dataset.avatarGroup]) return;
      draft.avatarPresetGroup = button.dataset.avatarGroup;
      renderWebFellowAvatarDefaults(root, draft);
    });
  });
  defaults.querySelectorAll("[data-avatar]").forEach((button) => {
    button.addEventListener("click", () => {
      setWebFellowAvatarDraft(draft, button.dataset.avatar, webAvatarDefaultCropForSrc(button.dataset.avatar));
      draft.name = button.dataset.avatarName || draft.name;
      const nameInput = root.querySelector("#webFellowName");
      if (nameInput) nameInput.value = draft.name;
      renderWebFellowAvatarPreview(root, draft);
      renderWebFellowAvatarDefaults(root, draft);
    });
  });
}

function readWebFellowAvatarFile(file, draft, root) {
  if (!file) return;
  const isImage = file.type?.startsWith("image/");
  const isVideo = file.type?.startsWith("video/");
  if (!isImage && !isVideo) {
    showToast("请选择图片或视频文件。");
    return;
  }
  if (isVideo && file.size > 8 * 1024 * 1024) {
    showToast("视频头像请控制在 8MB 以内。");
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    const image = String(reader.result || "");
    openWebAvatarCropEditor({
      draft,
      root,
      image,
      crop: isVideo ? { x: 50, y: 50, zoom: 1, start: 0, duration: 3 } : { x: 50, y: 50, zoom: 1.12 }
    });
  });
  reader.readAsDataURL(file);
}

function openWebAvatarCropEditor({ draft, root, image, crop }) {
  if (!_avatarCropModal) {
    _avatarCropModal = document.createElement("section");
    _avatarCropModal.className = "settings-modal web-avatar-crop-modal";
    document.body.appendChild(_avatarCropModal);
  }
  const editor = {
    image: String(image || draft.avatarImage || ""),
    crop: webNormalizeAvatarCrop(crop || draft.avatarCrop),
    dragging: false,
    lastX: 0,
    lastY: 0
  };
  _avatarCropModal.classList.remove("hidden");

  const render = () => {
    _avatarCropModal.innerHTML = `
      <div class="avatar-crop-card">
        <header class="avatar-crop-head">
          <h2>调整头像</h2>
          <button class="icon-button" type="button" data-action="close" aria-label="关闭">×</button>
        </header>
        <div id="webAvatarCropStage" class="avatar-crop-stage">
          <div class="avatar-crop-circle"></div>
        </div>
        <footer class="avatar-crop-actions">
          <button class="secondary" type="button" data-action="reset">重置</button>
          <span>拖拽移动，滚轮缩放</span>
          <button class="primary" type="button" data-action="confirm">使用头像</button>
        </footer>
      </div>
    `;
    const stage = _avatarCropModal.querySelector("#webAvatarCropStage");
    applyAvatarMedia(stage, editor.image, editor.crop, "#eef0ff", "");
    stage.insertAdjacentHTML("beforeend", '<div class="avatar-crop-circle"></div>');
    stage.addEventListener("pointerdown", (event) => {
      editor.dragging = true;
      editor.lastX = event.clientX;
      editor.lastY = event.clientY;
      stage.setPointerCapture?.(event.pointerId);
    });
    stage.addEventListener("pointermove", (event) => {
      if (!editor.dragging) return;
      const dx = event.clientX - editor.lastX;
      const dy = event.clientY - editor.lastY;
      editor.lastX = event.clientX;
      editor.lastY = event.clientY;
      const stageSize = stage.clientWidth || 320;
      const zoom = editor.crop.zoom || 1;
      const percentPerPx = 100 / (stageSize * zoom);
      editor.crop = webNormalizeAvatarCrop({
        ...editor.crop,
        x: editor.crop.x + dx * percentPerPx,
        y: editor.crop.y + dy * percentPerPx
      });
      applyAvatarMedia(stage, editor.image, editor.crop, "#eef0ff", "");
      stage.insertAdjacentHTML("beforeend", '<div class="avatar-crop-circle"></div>');
    });
    stage.addEventListener("pointerup", (event) => {
      editor.dragging = false;
      stage.releasePointerCapture?.(event.pointerId);
    });
    stage.addEventListener("pointercancel", () => { editor.dragging = false; });
    stage.addEventListener("wheel", (event) => {
      event.preventDefault();
      const direction = event.deltaY > 0 ? -1 : 1;
      editor.crop = webNormalizeAvatarCrop({ ...editor.crop, zoom: editor.crop.zoom + direction * 0.04 });
      applyAvatarMedia(stage, editor.image, editor.crop, "#eef0ff", "");
      stage.insertAdjacentHTML("beforeend", '<div class="avatar-crop-circle"></div>');
    }, { passive: false });
    _avatarCropModal.querySelector('[data-action="close"]')?.addEventListener("click", close);
    _avatarCropModal.querySelector('[data-action="reset"]')?.addEventListener("click", () => {
      editor.crop = webAvatarDefaultCropForSrc(editor.image);
      render();
    });
    _avatarCropModal.querySelector('[data-action="confirm"]')?.addEventListener("click", () => {
      setWebFellowAvatarDraft(draft, editor.image, editor.crop);
      renderWebFellowAvatarPreview(root, draft);
      renderWebFellowAvatarDefaults(root, draft);
      close();
    });
  };

  function close() {
    _avatarCropModal.classList.add("hidden");
    document.removeEventListener("keydown", onEsc);
  }
  function onEsc(event) {
    if (event.key === "Escape") close();
  }
  document.addEventListener("keydown", onEsc);
  _avatarCropModal.onclick = (event) => {
    if (event.target === _avatarCropModal) close();
  };
  render();
}

async function saveCloudOnlyFellowFromWeb(draft) {
  const name = String(draft.name || "").trim();
  if (!name) throw new Error("请输入智能体名称。");
  const key = cloudFellowKeyFromName(name, state.fellows.map((fellow) => fellow.id || fellow.key));
  const identity = {
    name,
    color: "#2563eb",
    avatarImage: draft.avatarImage || "",
    avatarCrop: draft.avatarCrop,
    bio: draft.personaText || "",
    personaText: draft.personaText || "",
    capabilities: ["chat", "files", "terminal", "code"]
  };
  const saved = await api(`/api/me/fellows/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: identity
  });
  const runtime = await api(`/api/me/fellows/${encodeURIComponent(key)}/runtime`, {
    method: "PUT",
    body: {
      runtimeKind: "cloud-hermes",
      enabled: true,
      config: {
        model: state.platformModels[0]?.value || "mia-default",
        effortLevel: "medium",
        permissionMode: "ask"
      }
    }
  });
  const ensured = await api(`/api/me/fellows/${encodeURIComponent(key)}/room`, {
    method: "PUT",
    body: {
      title: name,
      runtimeKind: "cloud-hermes"
    }
  });
  const fellow = { ...(saved.fellow || identity), key, id: key };
  state.fellows = [fellow, ...state.fellows.filter((item) => String(item.id || item.key || "") !== key)];
  if (runtime.binding) state.fellowRuntimeCache.set(runtimeCacheKey(key, "cloud-hermes"), runtime.binding);
  if (ensured.room) {
    state.rooms = [ensured.room, ...state.rooms.filter((room) => room.id !== ensured.room.id)];
    if (Array.isArray(ensured.members)) state.roomMembersCache.set(ensured.room.id, ensured.members);
  }
  return { key, fellow, room: ensured.room || null };
}

function openCreateFellowDialog() {
  if (!_createFellowModal) {
    _createFellowModal = document.createElement("section");
    _createFellowModal.className = "settings-modal web-fellow-dialog";
    document.body.appendChild(_createFellowModal);
  }
  state.createMenuOpen = false;
  renderCreateMenu();
  const draft = webFellowDefaultDraft();
  _createFellowModal.classList.remove("hidden");

  function close() {
    _createFellowModal.classList.add("hidden");
    document.removeEventListener("keydown", onEsc);
    _createFellowModal.removeEventListener("click", onBackdrop);
  }
  function onEsc(event) {
    if (event.key === "Escape") close();
  }
  function onBackdrop(event) {
    if (event.target === _createFellowModal) close();
  }

  function render() {
    _createFellowModal.innerHTML = `
      <form id="webCreateFellowForm" class="fellow-form">
        <header class="fellow-dialog-head">
          <div>
            <h2>创建智能体</h2>
          </div>
          <button class="icon-button" type="button" data-action="close" title="关闭" aria-label="关闭">×</button>
        </header>
        <label>
          姓名
          <input id="webFellowName" autocomplete="off" value="${escapeHtml(draft.name)}">
        </label>
        <label>
          运行位置
          <div class="web-fellow-runtime-fixed">
            <span class="web-fellow-runtime-logo" aria-hidden="true">M</span>
            <strong>Mia Cloud</strong>
          </div>
        </label>
        <section class="avatar-picker">
          <div id="webFellowAvatarPreview" class="avatar-crop-preview" role="button" tabindex="0" aria-label="调整头像"></div>
          <div id="webFellowAvatarDrop" class="avatar-drop">
            <input id="webFellowAvatarFile" type="file" accept="image/*,video/*" class="hidden">
            <button id="webChooseFellowAvatar" class="secondary avatar-file-button" type="button" title="选择图片" aria-label="选择图片">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12"/></svg>
              选择图片
            </button>
            <span>也可以把图片拖到这里</span>
          </div>
        </section>
        <section class="avatar-default-panel" aria-label="默认头像">
          <div id="webFellowAvatarDefaultTabs" class="avatar-default-tabs" role="tablist" aria-label="默认头像风格"></div>
          <section id="webFellowAvatarDefaults" class="avatar-defaults" aria-label="默认头像"></section>
        </section>
        <details class="persona-details">
          <summary>人设</summary>
          <label>
            <span>会保存在 Mia Cloud，并作为该 Fellow 的系统人设注入。</span>
            <textarea id="webFellowSeed" placeholder="可留空，后续在对话中慢慢形成">${escapeHtml(draft.personaText)}</textarea>
          </label>
        </details>
        <footer class="fellow-dialog-actions">
          <button class="secondary" type="button" data-action="close">取消</button>
          <button class="primary" type="submit" ${draft.saving ? "disabled" : ""}>${draft.saving ? "保存中..." : "保存伙伴"}</button>
        </footer>
      </form>
    `;
    renderWebFellowAvatarPreview(_createFellowModal, draft);
    renderWebFellowAvatarDefaults(_createFellowModal, draft);
    const nameInput = _createFellowModal.querySelector("#webFellowName");
    const seedInput = _createFellowModal.querySelector("#webFellowSeed");
    const fileInput = _createFellowModal.querySelector("#webFellowAvatarFile");
    const drop = _createFellowModal.querySelector("#webFellowAvatarDrop");
    nameInput?.addEventListener("input", () => { draft.name = nameInput.value; });
    seedInput?.addEventListener("input", () => { draft.personaText = seedInput.value; });
    _createFellowModal.querySelector('[data-action="close"]')?.addEventListener("click", close);
    _createFellowModal.querySelector("#webChooseFellowAvatar")?.addEventListener("click", () => fileInput?.click());
    _createFellowModal.querySelector("#webFellowAvatarPreview")?.addEventListener("click", () => {
      openWebAvatarCropEditor({ draft, root: _createFellowModal, image: draft.avatarImage, crop: draft.avatarCrop });
    });
    _createFellowModal.querySelector("#webFellowAvatarPreview")?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openWebAvatarCropEditor({ draft, root: _createFellowModal, image: draft.avatarImage, crop: draft.avatarCrop });
    });
    fileInput?.addEventListener("change", () => {
      readWebFellowAvatarFile(fileInput.files?.[0], draft, _createFellowModal);
      fileInput.value = "";
    });
    drop?.addEventListener("dragover", (event) => {
      event.preventDefault();
      drop.classList.add("dragging");
    });
    drop?.addEventListener("dragleave", () => drop.classList.remove("dragging"));
    drop?.addEventListener("drop", (event) => {
      event.preventDefault();
      drop.classList.remove("dragging");
      readWebFellowAvatarFile(event.dataTransfer?.files?.[0], draft, _createFellowModal);
    });
    _createFellowModal.querySelector("#webCreateFellowForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      draft.name = nameInput?.value || draft.name;
      draft.personaText = seedInput?.value || draft.personaText;
      draft.saving = true;
      render();
      try {
        const saved = await saveCloudOnlyFellowFromWeb(draft);
        close();
        renderConversationList();
        if (saved.room?.id) setActiveConversation(saved.room.id);
      } catch (err) {
        draft.saving = false;
        render();
        showToast(err.message || "创建智能体失败");
      }
    });
  }

  document.addEventListener("keydown", onEsc);
  _createFellowModal.addEventListener("click", onBackdrop);
  render();
  setTimeout(() => _createFellowModal.querySelector("#webFellowName")?.focus(), 0);
}

// ── add-friend dialog ──────────────────────────────────────────────────────

let _addFriendModal = null;
function openAddFriendDialog() {
  if (!_addFriendModal) {
    _addFriendModal = document.createElement("section");
    _addFriendModal.className = "settings-modal";
    document.body.appendChild(_addFriendModal);
  }
  state.createMenuOpen = false;
  renderCreateMenu();
  _addFriendModal.classList.remove("hidden");
  renderAddFriendModal();
  function onEsc(e) { if (e.key === "Escape") close(); }
  function onBackdrop(e) { if (e.target === _addFriendModal) close(); }
  function close() {
    _addFriendModal.classList.add("hidden");
    document.removeEventListener("keydown", onEsc);
    _addFriendModal.removeEventListener("click", onBackdrop);
  }
  _addFriendModal._closeModal = close;
  document.addEventListener("keydown", onEsc);
  _addFriendModal.addEventListener("click", onBackdrop);
}

function renderAddFriendModal() {
  if (!_addFriendModal) return;
  const myName = state.user?.username || "—";
  const incoming = state.incomingRequests || [];
  const outgoing = state.outgoingRequests || [];
  _addFriendModal.innerHTML = `
    <div class="settings-dialog" style="width:min(440px,calc(100vw - 40px))">
      <button class="icon-button settings-close-button" type="button" data-action="close" aria-label="关闭">×</button>
      <section class="settings-layout" style="grid-template-columns:1fr;">
        <div class="settings-content">
          <section class="settings-panel">
            <div class="runtime-card mobile-pairing-card">
              <section class="connection-row">
                <div class="connection-row-head">
                  <div>
                    <strong>我的用户名</strong>
                    <p>把这个发给朋友，让对方添加你。</p>
                  </div>
                </div>
                <section class="connection-details">
                  <p class="pairing-hint" style="font-family:monospace;">${escapeHtml(myName)}</p>
                </section>
              </section>
              <section class="connection-row">
                <div class="connection-row-head">
                  <div>
                    <strong>添加好友</strong>
                    <p>输入对方的用户名发送请求。</p>
                  </div>
                </div>
                <section class="connection-details">
                  <div class="cloud-login-grid" style="grid-template-columns:1fr auto;">
                    <input id="addFriendInput" placeholder="用户名" autocomplete="off">
                    <button class="primary" type="button" data-action="send">发送</button>
                  </div>
                  <p id="addFriendStatus" class="pairing-hint">—</p>
                </section>
              </section>
              ${incoming.length ? `
                <section class="connection-row">
                  <div class="connection-row-head">
                    <div>
                      <strong>收到的请求</strong>
                      <p>同意后会自动创建私聊。</p>
                    </div>
                  </div>
                  <section class="connection-details">
                    ${incoming.map((r) => `
                      <div style="display:flex; align-items:center; gap:8px; padding:6px 0;">
                        <span style="flex:1;">${escapeHtml(r.other?.username || r.from_user)}</span>
                        <button class="primary" type="button" data-respond="${escapeHtml(r.id)}" data-action-arg="accept">同意</button>
                        <button class="secondary" type="button" data-respond="${escapeHtml(r.id)}" data-action-arg="reject">拒绝</button>
                      </div>
                    `).join("")}
                  </section>
                </section>` : ""}
              ${outgoing.length ? `
                <section class="connection-row">
                  <div class="connection-row-head">
                    <div>
                      <strong>已发送的请求</strong>
                      <p>等待对方处理。</p>
                    </div>
                  </div>
                  <section class="connection-details">
                    ${outgoing.map((r) => `
                      <div style="display:flex; align-items:center; gap:8px; padding:6px 0;">
                        <span style="flex:1;">${escapeHtml(r.other?.username || r.to_user)}</span>
                        <button class="secondary" type="button" data-cancel="${escapeHtml(r.id)}">撤回</button>
                      </div>
                    `).join("")}
                  </section>
                </section>` : ""}
            </div>
          </section>
        </div>
      </section>
    </div>
  `;
  _addFriendModal.querySelector('[data-action="close"]')?.addEventListener("click", () => _addFriendModal._closeModal?.());
  _addFriendModal.querySelector('[data-action="send"]')?.addEventListener("click", async () => {
    const input = _addFriendModal.querySelector("#addFriendInput");
    const statusEl = _addFriendModal.querySelector("#addFriendStatus");
    const username = String(input?.value || "").trim();
    if (!username) { statusEl.textContent = "请输入用户名"; return; }
    try {
      const res = await api("/api/social/friend-requests", { method: "POST", body: { toUsername: username } });
      if (res.request) {
        state.outgoingRequests = [{ ...res.request, other: { username } }, ...state.outgoingRequests];
        statusEl.textContent = "已发送请求";
        if (input) input.value = "";
        renderAddFriendModal();
      }
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });
  _addFriendModal.querySelectorAll("[data-respond]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.respond;
      const action = btn.dataset.actionArg;
      try {
        const res = await api(`/api/social/friend-requests/${encodeURIComponent(id)}/respond`, { method: "POST", body: { action } });
        state.incomingRequests = state.incomingRequests.filter((r) => r.id !== id);
        if (action === "accept" && res.friend && res.room) {
          state.friends = [res.friend, ...state.friends.filter((f) => f.id !== res.friend.id)];
          state.rooms = [res.room, ...state.rooms.filter((r) => r.id !== res.room.id)];
          renderConversationList();
        }
        renderAddFriendModal();
      } catch (err) { showToast(err.message); }
    });
  });
  _addFriendModal.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.cancel;
      try {
        await api(`/api/social/friend-requests/${encodeURIComponent(id)}`, { method: "DELETE" });
        state.outgoingRequests = state.outgoingRequests.filter((r) => r.id !== id);
        renderAddFriendModal();
      } catch (err) { showToast(err.message); }
    });
  });
}

// ── create-group dialog ────────────────────────────────────────────────────

let _createGroupModal = null;
function openCreateGroupDialog() {
  if (!_createGroupModal) {
    _createGroupModal = document.createElement("section");
    _createGroupModal.className = "settings-modal";
    document.body.appendChild(_createGroupModal);
  }
  state.createMenuOpen = false;
  renderCreateMenu();
  const selected = new Set();
  _createGroupModal.classList.remove("hidden");

  function render() {
    const friends = state.friends;
    _createGroupModal.innerHTML = `
      <div class="settings-dialog" style="width:min(440px,calc(100vw - 40px))">
        <button class="icon-button settings-close-button" type="button" data-action="close" aria-label="关闭">×</button>
        <section class="settings-layout" style="grid-template-columns:1fr;">
          <div class="settings-content">
            <section class="settings-panel">
              <div class="runtime-card mobile-pairing-card">
                <section class="connection-row">
                  <div class="connection-row-head">
                    <div>
                      <strong>选择朋友</strong>
                      <p>勾选要加入群聊的朋友。</p>
                    </div>
                    <div style="color:var(--fg-muted, #888); font-size:13px;">${selected.size} / 5</div>
                  </div>
                  <section class="connection-details">
                    ${friends.length === 0
                      ? `<p class="pairing-hint">还没有朋友，先去添加好友。</p>`
                      : friends.map((f) => `
                        <label style="display:flex; align-items:center; gap:8px; padding:6px 0; cursor:pointer;">
                          <input type="checkbox" data-friend-id="${escapeHtml(f.id)}" ${selected.has(f.id) ? "checked" : ""}>
                          <span>${escapeHtml(f.username || f.id)}</span>
                        </label>
                      `).join("")}
                  </section>
                </section>
                <section class="connection-row">
                  <div class="connection-row-head">
                    <div>
                      <strong>群名</strong>
                      <p>留空则用成员名拼接。</p>
                    </div>
                  </div>
                  <section class="connection-details">
                    <input id="groupNameInput" class="pairing-hint" style="width:100%; border:1px solid var(--line, #ddd); border-radius:8px; padding:8px 10px;" placeholder="未命名群聊">
                  </section>
                </section>
                <section class="connection-row">
                  <div class="connection-row-head">
                    <div></div>
                    <div style="display:flex; gap:8px;">
                      <button class="secondary" type="button" data-action="close">取消</button>
                      <button class="primary" type="button" data-action="create" ${selected.size < 1 ? "disabled" : ""}>创建</button>
                    </div>
                  </div>
                  <p id="createGroupStatus" class="pairing-hint" style="color:#ff3b30; min-height:18px;"></p>
                </section>
              </div>
            </section>
          </div>
        </section>
      </div>
    `;
    _createGroupModal.querySelectorAll('[data-action="close"]').forEach((b) => b.addEventListener("click", close));
    _createGroupModal.querySelectorAll("[data-friend-id]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.dataset.friendId;
        if (cb.checked) {
          if (selected.size >= 5) { cb.checked = false; return; }
          selected.add(id);
        } else {
          selected.delete(id);
        }
        render();
      });
    });
    _createGroupModal.querySelector('[data-action="create"]')?.addEventListener("click", create);
  }

  async function create() {
    const statusEl = _createGroupModal.querySelector("#createGroupStatus");
    const nameInput = _createGroupModal.querySelector("#groupNameInput");
    const ids = Array.from(selected);
    if (ids.length === 0) { statusEl.textContent = "至少选 1 位"; return; }
    const namesList = ids.map((id) => friendUsernameById(id));
    const name = (nameInput?.value || "").trim() || namesList.join(" · ");
    try {
      const res = await api("/api/rooms", { method: "POST", body: { name, memberFriendUserIds: ids, memberFellows: [] } });
      const room = res.room || res.data?.room;
      if (room) {
        state.rooms = [room, ...state.rooms.filter((r) => r.id !== room.id)];
        if (Array.isArray(res.members)) state.roomMembersCache.set(room.id, res.members);
        renderConversationList();
        setActiveConversation(room.id);
      }
      close();
    } catch (err) { statusEl.textContent = err.message; }
  }

  function onEsc(e) { if (e.key === "Escape") close(); }
  function onBackdrop(e) { if (e.target === _createGroupModal) close(); }
  function close() {
    _createGroupModal.classList.add("hidden");
    document.removeEventListener("keydown", onEsc);
    _createGroupModal.removeEventListener("click", onBackdrop);
  }
  document.addEventListener("keydown", onEsc);
  _createGroupModal.addEventListener("click", onBackdrop);
  render();
}

// ── create-menu (＋) ───────────────────────────────────────────────────────

function renderCreateMenu() {
  els.conversationCreateMenu?.classList.toggle("hidden", !state.createMenuOpen);
}

// ── settings dialog ────────────────────────────────────────────────────────

function renderSettings() {
  els.settingsView.classList.toggle("hidden", !state.settingsOpen);
  if (!state.settingsOpen) return;
  document.querySelectorAll("[data-settings-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.settingsTab === state.activeSettingsTab);
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.settingsPanel !== state.activeSettingsTab);
  });
  if (els.cloudAccountUsername) {
    els.cloudAccountUsername.textContent = state.user?.username ? `已登录：${state.user.username}` : "未登录";
  }
  // Reflect current appearance state into the inputs every time the dialog
  // opens so it survives external mutations (multiple tabs, reset action).
  const ap = window.miaAppearance?.get?.() || {};
  if (els.appearanceTheme) els.appearanceTheme.value = ap.theme || "light";
  if (els.appearanceListStyle) els.appearanceListStyle.value = ap.listStyle || "card";
  if (els.appearanceSelectionStyle) els.appearanceSelectionStyle.value = ap.selectionStyle || "soft";
  if (els.appearanceHoverBackground) els.appearanceHoverBackground.checked = ap.hoverBackground !== false;
  if (els.appearanceAccentColor) els.appearanceAccentColor.value = ap.accentColor || "#5e5ce6";
  if (els.appearanceUserBubbleColor) els.appearanceUserBubbleColor.value = ap.userBubbleColor || "#0162db";
  if (els.appearanceShowUserAvatar) els.appearanceShowUserAvatar.checked = ap.showUserAvatar !== false;
  if (els.appearanceShowAssistantAvatar) els.appearanceShowAssistantAvatar.checked = ap.showAssistantAvatar !== false;
}

function openSettings() {
  state.settingsOpen = true;
  state.activeSettingsTab = "account";
  renderSettings();
}

function closeSettings() {
  state.settingsOpen = false;
  renderSettings();
}

// ── narrow layout pane switch ──────────────────────────────────────────────

function setPane(pane) {
  els.mainView.dataset.pane = pane;
}

// ── wiring ─────────────────────────────────────────────────────────────────

els.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const isRegister = event.submitter === els.registerButton;
  handleLogin(isRegister);
});

els.conversationSearch.addEventListener("input", renderConversationList);

els.userAvatar?.addEventListener("click", () => {
  state.activeSettingsTab = "account";
  state.settingsOpen = true;
  renderSettings();
});

els.conversationList.addEventListener("click", (event) => {
  const moreBtn = event.target.closest("[data-conv-more]");
  if (moreBtn) {
    event.stopPropagation();
    openConvMenu(moreBtn.dataset.convMore, moreBtn);
    return;
  }
  const button = event.target.closest("[data-conv-id]");
  if (!button) return;
  setActiveConversation(button.dataset.convId);
  setPane("chat");
});

document.addEventListener("click", (event) => {
  const action = event.target.closest("[data-conv-action]");
  if (!action || !_convMenuTargetId) return;
  const id = _convMenuTargetId;
  closeConvMenu();
  handleConvAction(action.dataset.convAction, id);
});

els.newConversation.addEventListener("click", (event) => {
  event.stopPropagation();
  state.createMenuOpen = !state.createMenuOpen;
  renderCreateMenu();
});
els.convMenuAddFriend?.addEventListener("click", () => openAddFriendDialog());
els.convMenuNewGroup?.addEventListener("click", () => openCreateGroupDialog());
els.convMenuNewFellow?.addEventListener("click", () => openCreateFellowDialog());
document.addEventListener("click", (event) => {
  if (!state.createMenuOpen) return;
  if (els.conversationCreateMenu?.contains(event.target) || els.newConversation?.contains(event.target)) return;
  state.createMenuOpen = false;
  renderCreateMenu();
});

els.sessionMenuButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!activeSessionRoom()) return;
  state.sessionMenuOpen = !state.sessionMenuOpen;
  renderSessionMenu();
});
els.newSession?.addEventListener("click", async (event) => {
  event.stopPropagation();
  await createNewSessionForActive();
});
document.addEventListener("click", (event) => {
  if (!state.sessionMenuOpen) return;
  if (els.sessionMenu?.contains(event.target) || els.sessionMenuButton?.contains(event.target)) return;
  state.sessionMenuOpen = false;
  renderSessionMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !state.sessionMenuOpen) return;
  state.sessionMenuOpen = false;
  renderSessionMenu();
});

els.chat.addEventListener("click", async (event) => {
  const copyButton = event.target.closest("[data-copy-code]");
  if (copyButton && els.chat.contains(copyButton)) {
    const code = copyButton.closest(".message-code-block")?.querySelector("code");
    if (!code) return;
    if (await copyTextToClipboard(code.textContent)) {
      copyButton.classList.add("copied");
      copyButton.disabled = true;
      setTimeout(() => {
        copyButton.classList.remove("copied");
        copyButton.disabled = false;
      }, 900);
    }
    return;
  }

  const link = event.target.closest("a.message-link[data-external-link]");
  if (link && els.chat.contains(link)) {
    event.preventDefault();
    event.stopPropagation();
    window.open(link.dataset.externalLink, "_blank", "noopener,noreferrer");
    return;
  }

  const code = event.target.closest(".bubble code.inline-code");
  if (!code || !els.chat.contains(code)) return;
  if (await copyTextToClipboard(code.textContent)) flashCopiedCode(code);
});

els.chat.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const link = event.target.closest("a.message-link[data-external-link]");
  if (link && els.chat.contains(link)) {
    event.preventDefault();
    window.open(link.dataset.externalLink, "_blank", "noopener,noreferrer");
    return;
  }
  const code = event.target.closest(".bubble code.inline-code");
  if (!code || !els.chat.contains(code)) return;
  event.preventDefault();
  if (await copyTextToClipboard(code.textContent)) flashCopiedCode(code);
});

els.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendInActive();
});
els.chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendInActive();
  }
});
els.quickModelSelect?.addEventListener("change", () => saveWebAiControl("model", els.quickModelSelect.value));
els.effortSelect?.addEventListener("change", () => saveWebAiControl("effort", els.effortSelect.value));
els.permissionMode?.addEventListener("change", () => saveWebAiControl("permission", els.permissionMode.value));

els.mobileBack?.addEventListener("click", () => setPane("list"));

document.querySelectorAll("[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    // only chat exists on web now; ignore other data-view attempts
  });
});

els.openSettings.addEventListener("click", openSettings);
els.closeSettings.addEventListener("click", closeSettings);
els.settingsView.addEventListener("click", (event) => {
  if (event.target === els.settingsView) closeSettings();
});
document.querySelectorAll("[data-settings-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.activeSettingsTab = btn.dataset.settingsTab;
    renderSettings();
  });
});
els.cloudLogoutFromSettings?.addEventListener("click", handleLogout);
function bindAppearanceInput(el, key, getValue) {
  if (!el) return;
  el.addEventListener("change", () => {
    window.miaAppearance?.update({ [key]: getValue(el) });
  });
  // Color pickers also fire "input" — capture so the page reacts live.
  if (el.type === "color") {
    el.addEventListener("input", () => {
      window.miaAppearance?.update({ [key]: getValue(el) });
    });
  }
}
bindAppearanceInput(els.appearanceTheme, "theme", (e) => e.value);
bindAppearanceInput(els.appearanceListStyle, "listStyle", (e) => e.value);
bindAppearanceInput(els.appearanceSelectionStyle, "selectionStyle", (e) => e.value);
bindAppearanceInput(els.appearanceHoverBackground, "hoverBackground", (e) => e.checked);
bindAppearanceInput(els.appearanceAccentColor, "accentColor", (e) => e.value);
bindAppearanceInput(els.appearanceUserBubbleColor, "userBubbleColor", (e) => e.value);
bindAppearanceInput(els.appearanceShowUserAvatar, "showUserAvatar", (e) => e.checked);
bindAppearanceInput(els.appearanceShowAssistantAvatar, "showAssistantAvatar", (e) => e.checked);

// rail rail-rail button → chat is the only view; already active by default

// ── init ───────────────────────────────────────────────────────────────────

loadSession();
setAuthView();
if (els.mainView && !els.mainView.dataset.pane) els.mainView.dataset.pane = "list";

if (state.token) {
  bootstrap().then(() => startCloudEvents()).catch((err) => {
    console.warn("[web] bootstrap failed:", err);
  });
} else {
  renderConversationList();
  renderActiveChat();
}
