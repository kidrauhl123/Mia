const fallbackSlashCommands = [
  { command: "/new", description: "Start a new session (fresh session ID + history)" },
  { command: "/topic", description: "Enable or inspect Telegram DM topic sessions" },
  { command: "/retry", description: "Retry the last message (resend to agent)" },
  { command: "/undo", description: "Remove the last user/assistant exchange" },
  { command: "/title", description: "Set a title for the current session" },
  { command: "/branch", description: "Branch the current session (explore a different path)" },
  { command: "/compress", description: "Manually compress conversation context" },
  { command: "/rollback", description: "List or restore filesystem checkpoints" },
  { command: "/commands", description: "Browse all commands and skills" },
  { command: "/help", description: "Show available commands" }
];

const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 380;
const SIDEBAR_WIDTH_DEFAULT = 280;
let skillPickerHoverCloseTimer = 0;
const qrSvgCache = new Map();
const ICON_PARK_PIN_SVG = '<svg class="icon-park-pin" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="M10.6963 17.5042C13.3347 14.8657 16.4701 14.9387 19.8781 16.8076L32.62 9.74509L31.8989 4.78683L43.2126 16.1005L38.2656 15.3907L31.1918 28.1214C32.9752 31.7589 33.1337 34.6647 30.4953 37.3032C30.4953 37.3032 26.235 33.0429 22.7171 29.525L6.44305 41.5564L18.4382 25.2461C14.9202 21.7281 10.6963 17.5042 10.6963 17.5042Z"/></svg>';
const SETUP_GUIDE_DISMISSED_KEY = "aimashi.setupGuideDismissed.v2";

function clampSidebarWidth(value) {
  const availableMax = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, window.innerWidth - 430));
  const next = Number(value);
  if (!Number.isFinite(next)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.round(Math.max(SIDEBAR_WIDTH_MIN, Math.min(availableMax, next)));
}

function savedSidebarWidth() {
  try {
    return clampSidebarWidth(Number(localStorage.getItem("aimashi.sidebarWidth")) || SIDEBAR_WIDTH_DEFAULT);
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

const state = {
  runtime: null,
  activeKey: "",
  chatStore: { schema_version: 1, readAt: {}, sessions: {} },
  activeSessionIdByPersona: {},
  generatingTitleIds: new Set(),
  generatedFiles: new Map(),
  startupTasks: [],
  firstRun: false,
  setupGuideDismissed: localStorage.getItem(SETUP_GUIDE_DISMISSED_KEY) === "1",
  onboardingStep: localStorage.getItem("aimashi.onboardingStep") || "engine",
  onboardingPickedEngine: "",
  forceScrollToBottom: false,
  sessionMenuOpen: false,
  activeView: "chat",
  activeContactKey: "",
  narrowPane: "content",
  isNarrowWindow: window.innerWidth <= 720,
  sidebarWidth: savedSidebarWidth(),
  sidebarResize: { dragging: false, startX: 0, startWidth: 0 },
  activeSettingsTab: "appearance",
  mobileLanLinkExpanded: false,
  mobileRelayLinkExpanded: false,
  personaFilter: "",
  contactFilter: "",
  skillFilter: "",
  skillCategoryFilter: "",
  skillStatusFilter: "all",
  skillContextMenu: { open: false, x: 0, y: 0, skillId: "" },
  fellowContextMenu: { open: false, x: 0, y: 0, fellowKey: "" },
  groupContextMenu: { open: false, x: 0, y: 0, groupId: "" },
  messageContextMenu: { open: false, x: 0, y: 0, messageIndex: -1, selectionText: "" },
  replyDraft: null,
  fellowMenuOpen: false,
  profileDialogOpen: false,
  fellowDialogOpen: false,
  fellowDialogMode: "create",
  fellowAvatarPresetGroup: "human",
  profileAvatarPresetGroup: "human",
  petGenerateOpen: false,
  petGenerateFellowKey: "",
  petReferences: [],
  petJobs: [],
  petJobPanelOpen: false,
  fellowAvatarDraft: {
    image: "",
    crop: { x: 50, y: 50, zoom: 1 }
  },
  profileAvatarDraft: {
    image: "",
    crop: { x: 50, y: 50, zoom: 1 }
  },
  avatarCropEditor: {
    open: false,
    target: "fellow",
    image: "",
    crop: { x: 50, y: 50, zoom: 1 },
    dragging: false,
    lastX: 0,
    lastY: 0
  },
  settingsOpen: false,
  modelCatalog: [],
  skillLibrary: { plugins: [], sources: [], extensions: [], connectors: [], skills: [], roots: [] },
  directorySection: "plugins",
  skillPluginFilter: "",
  skillLibraryMode: "skills",
  selectedExtensionId: "",
  installingExtensions: new Set(),
  savingFellowCapabilities: new Set(),
  skillPickerOpen: false,
  skillPickerFilter: "",
  skillPickerPluginId: "",
  selectedSkillId: "",
  selectedSkillDetail: null,
  skillPreviewOpen: false,
  skillsLoading: false,
  slashCommands: fallbackSlashCommands,
  agentSlashCommands: { "claude-code": [], codex: [] },
  slashMenuOpen: false,
  composerAddMenuOpen: false,
  pendingAttachments: [],
  slashSelectedIndex: 0,
  slashFilter: "",
  isGenerating: false,
  streaming: null,
  openTraceKeys: new Set(),
  animatedTraceKeys: new Set(),
  codexModels: [],
  tasks: [],
  taskFilter: "",
  selectedTaskId: "",
  selectedRunId: "",
  historyExpanded: false,
  disabledExpanded: false,
  tasksUnread: new Map()
};

const els = {
  appShell: document.querySelector(".app-shell"),
  openSettings: document.getElementById("openSettings"),
  closeSettings: document.getElementById("closeSettings"),
  userAvatar: document.getElementById("userAvatar"),
  userDisplayName: document.getElementById("userDisplayName"),
  activeChatAvatar: document.getElementById("activeChatAvatar"),
  activeChatName: document.getElementById("activeChatName"),
  activeChatBadge: document.getElementById("activeChatBadge"),
  activeChatMeta: document.getElementById("activeChatMeta"),
  initialize: document.getElementById("initialize"),
  installEngine: document.getElementById("installEngine"),
  startEngine: document.getElementById("startEngine"),
  stopEngine: document.getElementById("stopEngine"),
  uninstallEngine: document.getElementById("uninstallEngine"),
  engineRowHermes: document.getElementById("engineRowHermes"),
  engineRowClaude: document.getElementById("engineRowClaude"),
  engineRowCodex: document.getElementById("engineRowCodex"),
  engineRowHermesButton: document.querySelector('[data-engine-row="hermes"]'),
  personaSearch: document.getElementById("personaSearch"),
  personaCount: document.getElementById("personaCount"),
  fellowCreateMenu: document.getElementById("fellowCreateMenu"),
  addFellow: document.getElementById("addFellow"),
  createGroup: document.getElementById("createGroup"),
  fellowDialog: document.getElementById("fellowDialog"),
  fellowForm: document.getElementById("fellowForm"),
  fellowDialogTitle: document.getElementById("fellowDialogTitle"),
  fellowKey: document.getElementById("fellowKey"),
  fellowName: document.getElementById("fellowName"),
  fellowAgentEngineField: document.getElementById("fellowAgentEngineField"),
  fellowAgentEngine: document.getElementById("fellowAgentEngine"),
  fellowAvatar: document.getElementById("fellowAvatar"),
  fellowAvatarFile: document.getElementById("fellowAvatarFile"),
  chooseFellowAvatar: document.getElementById("chooseFellowAvatar"),
  fellowAvatarDrop: document.getElementById("fellowAvatarDrop"),
  fellowAvatarPreview: document.getElementById("fellowAvatarPreview"),
  fellowAvatarDefaultTabs: document.getElementById("fellowAvatarDefaultTabs"),
  fellowAvatarDefaults: document.getElementById("fellowAvatarDefaults"),
  profileAvatarDefaultTabs: document.getElementById("profileAvatarDefaultTabs"),
  profileAvatarDefaults: document.getElementById("profileAvatarDefaults"),
  fellowPersonaDetails: document.getElementById("fellowPersonaDetails"),
  fellowSeed: document.getElementById("fellowSeed"),
  closeFellowDialog: document.getElementById("closeFellowDialog"),
  cancelFellow: document.getElementById("cancelFellow"),
  avatarCropDialog: document.getElementById("avatarCropDialog"),
  avatarCropStage: document.getElementById("avatarCropStage"),
  confirmAvatarCrop: document.getElementById("confirmAvatarCrop"),
  cancelAvatarCrop: document.getElementById("cancelAvatarCrop"),
  resetAvatarCrop: document.getElementById("resetAvatarCrop"),
  conversationSidebar: document.getElementById("conversationSidebar"),
  contactsSidebar: document.getElementById("contactsSidebar"),
  skillsSidebar: document.getElementById("skillsSidebar"),
  sidebarResizeHandle: document.getElementById("sidebarResizeHandle"),
  narrowBackButtons: document.querySelectorAll("[data-narrow-back]"),
  chatView: document.getElementById("chatView"),
  contactsView: document.getElementById("contactsView"),
  skillsView: document.getElementById("skillsView"),
  settingsView: document.getElementById("settingsView"),
  engineStatus: document.getElementById("engineStatus"),
  hermesHome: document.getElementById("hermesHome"),
  manifestPath: document.getElementById("manifestPath"),
  engineLogs: document.getElementById("engineLogs"),
  personaList: document.getElementById("personaList"),
  contactSearch: document.getElementById("contactSearch"),
  newContact: document.getElementById("newContact"),
  contactList: document.getElementById("contactList"),
  contactPageTitle: document.getElementById("contactPageTitle"),
  contactPageMeta: document.getElementById("contactPageMeta"),
  contactDetail: document.getElementById("contactDetail"),
  engineWarning: document.getElementById("engineWarning"),
  chat: document.getElementById("chat"),
  skillSearch: document.getElementById("skillSearch"),
  skillNav: document.getElementById("skillNav"),
  skillPageTitle: document.getElementById("skillPageTitle"),
  skillChipRow: document.getElementById("skillChipRow"),
  skillCardGrid: document.getElementById("skillCardGrid"),
  skillPreviewDialog: document.getElementById("skillPreviewDialog"),
  closeSkillPreview: document.getElementById("closeSkillPreview"),
  skillPreviewMark: document.getElementById("skillPreviewMark"),
  skillPreviewTitle: document.getElementById("skillPreviewTitle"),
  skillPreviewMeta: document.getElementById("skillPreviewMeta"),
  skillPreviewBody: document.getElementById("skillPreviewBody"),
  skillContextMenu: document.getElementById("skillContextMenu"),
  fellowContextMenu: document.getElementById("fellowContextMenu"),
  groupContextMenu: document.getElementById("groupContextMenu"),
  messageContextMenu: document.getElementById("messageContextMenu"),
  profileDialog: document.getElementById("profileDialog"),
  profileForm: document.getElementById("profileForm"),
  profileDisplayName: document.getElementById("profileDisplayName"),
  profileAvatarImage: document.getElementById("profileAvatarImage"),
  profileAvatarFile: document.getElementById("profileAvatarFile"),
  chooseProfileAvatar: document.getElementById("chooseProfileAvatar"),
  profileAvatarDrop: document.getElementById("profileAvatarDrop"),
  profileAvatarPreview: document.getElementById("profileAvatarPreview"),
  closeProfileDialog: document.getElementById("closeProfileDialog"),
  cancelProfile: document.getElementById("cancelProfile"),
  petGenerateDialog: document.getElementById("petGenerateDialog"),
  petGenerateForm: document.getElementById("petGenerateForm"),
  petGenerateTitle: document.getElementById("petGenerateTitle"),
  petGenerateSubtitle: document.getElementById("petGenerateSubtitle"),
  closePetGenerateDialog: document.getElementById("closePetGenerateDialog"),
  cancelPetGenerate: document.getElementById("cancelPetGenerate"),
  petPrompt: document.getElementById("petPrompt"),
  petStylePreset: document.getElementById("petStylePreset"),
  addPetReference: document.getElementById("addPetReference"),
  petReferenceFile: document.getElementById("petReferenceFile"),
  petReferenceList: document.getElementById("petReferenceList"),
  petJobButton: document.getElementById("petJobButton"),
  petJobPanel: document.getElementById("petJobPanel"),
  sessionMenuButton: document.getElementById("sessionMenuButton"),
  currentSessionTitle: document.getElementById("currentSessionTitle"),
  sessionMenu: document.getElementById("sessionMenu"),
  sessionList: document.getElementById("sessionList"),
  newSession: document.getElementById("newSession"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  composerAdd: document.getElementById("composerAdd"),
  composerAddMenu: document.getElementById("composerAddMenu"),
  composerReply: document.getElementById("composerReply"),
  composerAttachments: document.getElementById("composerAttachments"),
  composerAttachmentInput: document.getElementById("composerAttachmentInput"),
  slashCommandMenu: document.getElementById("slashCommandMenu"),
  skillPicker: document.getElementById("skillPicker"),
  skillPickerSearch: document.getElementById("skillPickerSearch"),
  skillPickerBody: document.getElementById("skillPickerBody"),
  closeSkillPicker: document.getElementById("closeSkillPicker"),
  sendChat: document.getElementById("sendChat"),
  quickModelSelect: document.getElementById("quickModelSelect"),
  quickModelLabel: document.getElementById("quickModelLabel"),
  effortSelect: document.getElementById("effortSelect"),
  effortLabel: document.getElementById("effortLabel"),
  permissionMode: document.getElementById("permissionMode"),
  permissionLabel: document.getElementById("permissionLabel"),
  modelSwitchStatus: document.getElementById("modelSwitchStatus"),
  modelForm: document.getElementById("modelForm"),
  modelSelect: document.getElementById("modelSelect"),
  connectedProviderList: document.getElementById("connectedProviderList"),
  modelConnectButton: document.getElementById("modelConnectButton"),
  modelAuthState: document.getElementById("modelAuthState"),
  modelApiKeyField: document.getElementById("modelApiKeyField"),
  modelApiKeyLabel: document.getElementById("modelApiKeyLabel"),
  appearanceForm: document.getElementById("appearanceForm"),
  appearanceTheme: document.getElementById("appearanceTheme"),
  appearanceFontPreset: document.getElementById("appearanceFontPreset"),
  appearanceFontChoices: document.getElementById("appearanceFontChoices"),
  appearanceListStyle: document.getElementById("appearanceListStyle"),
  appearanceSelectionStyle: document.getElementById("appearanceSelectionStyle"),
  appearanceAccentColor: document.getElementById("appearanceAccentColor"),
  appearanceAccentPreview: document.getElementById("appearanceAccentPreview"),
  appearanceAccentReset: document.getElementById("appearanceAccentReset"),
  appearanceUserBubbleColor: document.getElementById("appearanceUserBubbleColor"),
  appearanceUserBubblePreview: document.getElementById("appearanceUserBubblePreview"),
  appearanceUserBubbleReset: document.getElementById("appearanceUserBubbleReset"),
  appearanceShowHoverBackground: document.getElementById("appearanceShowHoverBackground"),
  appearanceShowUserAvatar: document.getElementById("appearanceShowUserAvatar"),
  appearanceShowAssistantAvatar: document.getElementById("appearanceShowAssistantAvatar"),
  appearanceSaveStatus: document.getElementById("appearanceSaveStatus"),
  authMethod: document.getElementById("authMethod"),
  modelPreset: document.getElementById("modelPreset"),
  modelProvider: document.getElementById("modelProvider"),
  modelName: document.getElementById("modelName"),
  modelKeyEnv: document.getElementById("modelKeyEnv"),
  modelApiKey: document.getElementById("modelApiKey"),
  modelBaseUrl: document.getElementById("modelBaseUrl"),
  modelApiMode: document.getElementById("modelApiMode"),
  codexInlineAuth: document.getElementById("codexInlineAuth"),
  codexCheck: document.getElementById("codexCheck"),
  newPersona: document.getElementById("newPersona"),
  codexStatus: document.getElementById("codexStatus"),
  codexCode: document.getElementById("codexCode"),
  codexLogin: document.getElementById("codexLogin"),
  codexCancel: document.getElementById("codexCancel"),
  codexLogs: document.getElementById("codexLogs"),
  mobileDaemonStatus: document.getElementById("mobileDaemonStatus"),
  cloudAccountHint: document.getElementById("cloudAccountHint"),
  cloudLoginBox: document.getElementById("cloudLoginBox"),
  cloudUsername: document.getElementById("cloudUsername"),
  cloudPassword: document.getElementById("cloudPassword"),
  cloudLogin: document.getElementById("cloudLogin"),
  cloudRegister: document.getElementById("cloudRegister"),
  cloudSync: document.getElementById("cloudSync"),
  cloudLogout: document.getElementById("cloudLogout"),
  cloudLoginHint: document.getElementById("cloudLoginHint"),
  mobileDaemonUrl: document.getElementById("mobileDaemonUrl"),
  mobileLanToggle: document.getElementById("mobileLanToggle"),
  mobilePairingBox: document.getElementById("mobilePairingBox"),
  mobilePairingQr: document.getElementById("mobilePairingQr"),
  mobilePairingReveal: document.getElementById("mobilePairingReveal"),
  mobilePairingLink: document.getElementById("mobilePairingLink"),
  mobilePairingHint: document.getElementById("mobilePairingHint"),
  mobileRelayBox: document.getElementById("mobileRelayBox"),
  mobileRelayQr: document.getElementById("mobileRelayQr"),
  mobileRelayReveal: document.getElementById("mobileRelayReveal"),
  mobileRelayUrl: document.getElementById("mobileRelayUrl"),
  mobileRelayToggle: document.getElementById("mobileRelayToggle"),
  mobileRelayLink: document.getElementById("mobileRelayLink"),
  mobileRelayHint: document.getElementById("mobileRelayHint"),
  tasksUnreadBadge: document.getElementById("tasksUnreadBadge"),
  tasksSidebar: document.getElementById("tasksSidebar"),
  tasksNav: document.getElementById("tasksNav"),
  tasksView: document.getElementById("tasksView"),
  tasksContent: document.getElementById("tasksContent"),
  tasksPageTitle: document.getElementById("tasksPageTitle"),
  tasksPageMeta: document.getElementById("tasksPageMeta"),
  taskActions: document.getElementById("taskActions"),
  taskSearch: document.getElementById("taskSearch")
};

function setText(el, value) {
  if (el) el.textContent = value;
}

function renderQr(el, text) {
  if (!el) return;
  const value = String(text || "").trim();
  el.dataset.qrText = value;
  if (!value) {
    el.innerHTML = "";
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  if (qrSvgCache.has(value)) {
    el.innerHTML = qrSvgCache.get(value);
    return;
  }
  el.textContent = "生成二维码中";
  if (!window.aimashi?.qrSvg) {
    el.textContent = "二维码不可用";
    return;
  }
  window.aimashi.qrSvg(value).then((svg) => {
    qrSvgCache.set(value, svg);
    if (el.dataset.qrText === value) el.innerHTML = svg;
  }).catch(() => {
    if (el.dataset.qrText === value) el.textContent = "二维码生成失败";
  });
}


function applySidebarWidth(width = state.sidebarWidth, persist = false) {
  const next = clampSidebarWidth(width);
  state.sidebarWidth = next;
  document.documentElement.style.setProperty("--sidebar-width", `${next}px`);
  if (persist) {
    try {
      localStorage.setItem("aimashi.sidebarWidth", String(next));
    } catch {
      // localStorage may be unavailable in restricted renderer contexts.
    }
  }
}

function syncNarrowLayout() {
  document.body.classList.toggle("narrow-sidebar", state.narrowPane === "sidebar");
  document.body.classList.toggle("narrow-content", state.narrowPane !== "sidebar");
}

function showNarrowContent() {
  state.narrowPane = "content";
  syncNarrowLayout();
}

function showNarrowSidebar() {
  state.narrowPane = "sidebar";
  syncNarrowLayout();
}

applySidebarWidth(state.sidebarWidth);
syncNarrowLayout();

function renderSendButton() {
  if (!els.sendChat) return;
  const canSend = Boolean(String(els.chatInput?.value || "").trim()) || state.pendingAttachments.length > 0;
  els.sendChat.classList.toggle("stop", state.isGenerating);
  els.sendChat.textContent = state.isGenerating ? "" : "↗";
  els.sendChat.title = state.isGenerating ? "停止生成" : "发送";
  els.sendChat.setAttribute("aria-label", state.isGenerating ? "停止生成" : "发送");
  els.sendChat.disabled = !state.isGenerating && !canSend;
}


const providerPresets = {
  "openai-codex": {
    provider: "openai-codex",
    model: "gpt-5.3-codex",
    apiKeyEnv: "",
    baseUrl: "",
    apiMode: "codex_responses"
  },
  xai: {
    provider: "xai",
    model: "grok-4.1-fast",
    apiKeyEnv: "XAI_API_KEY",
    baseUrl: "",
    apiMode: ""
  },
  anthropic: {
    provider: "anthropic",
    model: "claude-sonnet-4.6",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrl: "",
    apiMode: "anthropic_messages"
  },
  openrouter: {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    apiKeyEnv: "OPENROUTER_API_KEY",
    baseUrl: "",
    apiMode: ""
  },
  deepseek: {
    provider: "deepseek",
    model: "deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "",
    apiMode: ""
  },
  gemini: {
    provider: "gemini",
    model: "gemini-2.5-pro",
    apiKeyEnv: "GEMINI_API_KEY",
    baseUrl: "",
    apiMode: ""
  },
  lmstudio: {
    provider: "lmstudio",
    model: "",
    apiKeyEnv: "LM_API_KEY",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiMode: "chat_completions"
  }
};

const providerLabels = {
  nous: "Nous Portal",
  xai: "xAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  "openai-codex": "OpenAI Codex",
  deepseek: "DeepSeek",
  gemini: "Google",
  lmstudio: "LM Studio"
};



const fontPresets = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "sf-pro": '"SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif',
  pingfang: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  mono: '"SF Mono", "Cascadia Code", Menlo, Consolas, monospace'
};

const DEFAULT_ACCENT_COLOR = "#0162db";
const DEFAULT_USER_BUBBLE_COLOR = "#0162db";
const DEFAULT_LIST_STYLE = "flush";
const DEFAULT_SELECTION_STYLE = "solid";




async function copyTextToClipboard(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the textarea copy path for Electron file:// windows.
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

function nowIso() {
  return new Date().toISOString();
}

function sortSessions(sessions) {
  return [...sessions].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function formatConversationTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatMessageTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function renderMessageTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return `<time class="message-time" datetime="${window.aimashiMarkdown.escapeHtml(date.toISOString())}" title="${window.aimashiMarkdown.escapeHtml(date.toLocaleString())}">${window.aimashiMarkdown.escapeHtml(formatMessageTime(date))}</time>`;
}

function renderAttachmentChips(attachments = []) {
  if (!Array.isArray(attachments) || !attachments.length) return "";
  return `
    <div class="message-attachments">
      ${attachments.map(renderAttachmentChip).join("")}
    </div>
  `;
}

function renderAttachmentThumb(attachment = {}, className = "attachment-thumb") {
  const src = String(attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || attachment.dataUrl || "").trim();
  if (!src || !src.startsWith("data:image/")) return `<span>${window.aimashiMarkdown.escapeHtml(window.aimashiFormat.attachmentGlyph(attachment))}</span>`;
  return `<img class="${window.aimashiMarkdown.escapeHtml(className)}" src="${window.aimashiMarkdown.escapeHtml(src)}" alt="">`;
}

function renderAttachmentChip(attachment = {}) {
  const image = (attachment.kind || window.aimashiFormat.attachmentKind(attachment)) === "image" && (attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || attachment.dataUrl || attachment.url);
  const href = String(attachment.dataUrl || "").startsWith("data:") ? String(attachment.dataUrl) : "";
  const tag = href ? "a" : "span";
  const download = href ? ` href="${window.aimashiMarkdown.escapeHtml(href)}" download="${window.aimashiMarkdown.escapeHtml(attachment.name || "attachment")}"` : "";
  if (image) {
    return `
      <button class="message-attachment image" type="button" title="${window.aimashiMarkdown.escapeHtml(attachment.path || attachment.name || "")}" aria-label="预览图片">
        ${renderAttachmentThumb(attachment, "message-attachment-thumb")}
      </button>
    `;
  }
  return `
    <${tag} class="message-attachment"${download} title="${window.aimashiMarkdown.escapeHtml(attachment.path || attachment.name || "")}">
      ${renderAttachmentThumb(attachment, "message-attachment-thumb")}
      <strong>${window.aimashiMarkdown.escapeHtml(attachment.name || "附件")}</strong>
      <em>${window.aimashiMarkdown.escapeHtml(window.aimashiFormat.formatBytes(attachment.size))}</em>
    </${tag}>
  `;
}

function closeImagePreview() {
  document.querySelector(".image-preview-overlay")?.remove();
}

function openImagePreview(src, title = "") {
  const imageSrc = String(src || "").trim();
  if (!imageSrc.startsWith("data:image/")) return;
  closeImagePreview();
  const overlay = document.createElement("div");
  overlay.className = "image-preview-overlay";
  overlay.innerHTML = `
    <button class="image-preview-close" type="button" aria-label="关闭">×</button>
    <img src="${window.aimashiMarkdown.escapeHtml(imageSrc)}" alt="${window.aimashiMarkdown.escapeHtml(title || "图片预览")}">
  `;
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.closest(".image-preview-close")) closeImagePreview();
  });
  document.body.appendChild(overlay);
}

function extractLocalFilePaths(text = "") {
  const source = String(text || "");
  const paths = new Set();
  const quoted = /[`"“”']((?:\/Users|\/tmp|\/var\/folders|\/opt|\/home)\/[^`"“”'\n\r]+?\.[A-Za-z0-9]{1,10})[`"“”']/g;
  const plain = /(?:^|[\s:：])((?:\/Users|\/tmp|\/var\/folders|\/opt|\/home)\/[^\s`"'“”‘’，。；;]+?\.[A-Za-z0-9]{1,10})(?=$|[\s`"'“”‘’，。；;])/gm;
  for (const regex of [quoted, plain]) {
    let match = regex.exec(source);
    while (match) {
      paths.add(match[1].trim().replace(/[),.。]+$/g, ""));
      match = regex.exec(source);
    }
  }
  return [...paths].slice(0, 8);
}

function generatedAttachmentsForMessage(message = {}) {
  if (message.role !== "assistant") return [];
  return extractLocalFilePaths(message.content).map((filePath) => {
    const entry = state.generatedFiles.get(filePath);
    if (entry?.status === "ready") return entry.attachment;
    if (entry?.status === "error") {
      return {
        id: `generated:${filePath}`,
        name: filePath.split(/[\\/]/).pop() || "文件",
        path: filePath,
        kind: "file",
        size: 0
      };
    }
    return {
      id: `generated:${filePath}`,
      name: filePath.split(/[\\/]/).pop() || "文件",
      path: filePath,
      kind: "file",
      size: 0
    };
  });
}

function hydrateAttachmentPreview(attachment = {}) {
  const filePath = String(attachment.path || "").trim();
  const cloudUrl = String(attachment.url || "").trim();
  if ((!filePath && !cloudUrl) || attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || attachment.dataUrl) return attachment;
  const kind = String(attachment.kind || window.aimashiFormat.attachmentKind(attachment));
  if (kind !== "image") return attachment;
  if (cloudUrl) {
    const entry = state.generatedFiles.get(cloudUrl);
    if (entry?.status === "ready" && entry.attachment) {
      return { ...attachment, ...entry.attachment };
    }
    return attachment;
  }
  const entry = state.generatedFiles.get(filePath);
  if (entry?.status === "ready" && entry.attachment) {
    return { ...attachment, ...entry.attachment };
  }
  return attachment;
}

function attachmentPreviewPaths(messages = []) {
  return messages.flatMap((message) => Array.isArray(message.attachments) ? message.attachments : [])
    .filter((attachment) => {
      const filePath = String(attachment.path || "").trim();
      const cloudUrl = String(attachment.url || "").trim();
      if (!filePath && !cloudUrl) return false;
      if (attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || attachment.dataUrl) return false;
      return String(attachment.kind || window.aimashiFormat.attachmentKind(attachment)) === "image";
    })
    .map((attachment) => String(attachment.path || attachment.url).trim());
}

function queueGeneratedFileFetches(messages = []) {
  const paths = [...new Set(messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => extractLocalFilePaths(message.content))
    .concat(attachmentPreviewPaths(messages)))];
  for (const filePath of paths) {
    if (state.generatedFiles.has(filePath)) continue;
    state.generatedFiles.set(filePath, { status: "loading" });
    window.aimashi.fetchFileAttachment?.(filePath.startsWith("/api/files/") ? { url: filePath } : { path: filePath })
      .then((attachment) => {
        if (attachment?.error) throw new Error(attachment.message || "File not found.");
        state.generatedFiles.set(filePath, { status: "ready", attachment });
        renderChat();
      })
      .catch(() => {
        state.generatedFiles.set(filePath, { status: "error" });
        renderChat();
      });
  }
}


function conversationPreview(persona) {
  const sessions = sessionsForPersona(persona.key);
  const latest = sessions[0];
  const messages = latest?.messages || [];
  const last = [...messages].reverse().find((message) => String(message.content || "").trim() && !message.transient);
  return {
    text: last ? last.content : "",
    time: formatConversationTime(latest?.updatedAt || latest?.createdAt)
  };
}

function conversationUpdatedAt(persona) {
  const latest = sessionsForPersona(persona.key)[0];
  return latest?.updatedAt || latest?.createdAt || "";
}

function sessionsForPersona(personaKey = state.activeKey) {
  if (!state.chatStore.sessions[personaKey]) state.chatStore.sessions[personaKey] = [];
  if (!state.chatStore.sessions[personaKey].length) {
    const now = nowIso();
    state.chatStore.sessions[personaKey].push({
      id: cryptoRandomId(),
      personaKey,
      title: "新对话",
      titleGenerated: false,
      createdAt: now,
      updatedAt: now,
      messages: []
    });
  }
  state.chatStore.sessions[personaKey] = sortSessions(state.chatStore.sessions[personaKey]);
  return state.chatStore.sessions[personaKey];
}

function hasSuccessfulExchange(session) {
  const messages = session?.messages || [];
  const hasUser = messages.some((message) => message.role === "user" && String(message.content || "").trim() && !message.transient);
  const hasAssistant = messages.some((message) => message.role === "assistant" && String(message.content || "").trim() && !message.transient);
  return hasUser && hasAssistant;
}

function hasPersistableMessages(session) {
  return (session?.messages || []).some((message) => (
    String(message.content || "").trim() || (Array.isArray(message.attachments) && message.attachments.length)
  ) && !message.transient);
}

function pruneEmptyDrafts(personaKey = state.activeKey, keepId = "") {
  if (!state.chatStore.sessions[personaKey]) return;
  state.chatStore.sessions[personaKey] = state.chatStore.sessions[personaKey].filter((session) => {
    if (session.id === keepId) return true;
    return hasSuccessfulExchange(session) || (session.messages || []).length > 0;
  });
}

function cryptoRandomId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `session_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function activeSession() {
  const sessions = sessionsForPersona();
  const selected = sessions.find((session) => session.id === state.activeSessionIdByPersona[state.activeKey]);
  const session = selected || sessions[0];
  state.activeSessionIdByPersona[state.activeKey] = session.id;
  return session;
}

async function persistSession(session = activeSession()) {
  if (!hasPersistableMessages(session)) return;
  state.chatStore = await window.aimashi.saveChatSession({
    personaKey: session.personaKey || state.activeKey,
    session
  });
}

async function persistSessionQuietly(session = activeSession()) {
  try {
    await persistSession(session);
    return true;
  } catch (error) {
    console.error("Failed to persist chat session", error);
    return false;
  }
}

async function pushCloudMessageQuietly(session, message) {
  if (!state.runtime?.cloud?.enabled || !window.aimashi?.cloudPushMessage || !session || !message || message.transient) return false;
  try {
    state.runtime = await window.aimashi.cloudPushMessage({
      fellowKey: state.activeKey,
      session,
      message
    });
    window.aimashiSettingsRemote.renderCloudAccount(state.runtime?.cloud || {});
    return true;
  } catch (error) {
    console.error("Failed to push cloud message", error);
    return false;
  }
}

async function replacePersistedSessionQuietly(session = activeSession()) {
  try {
    state.chatStore = await window.aimashi.saveChatSession({
      personaKey: session.personaKey || state.activeKey,
      session,
      replaceMessages: true
    });
    return true;
  } catch (error) {
    console.error("Failed to replace chat session", error);
    return false;
  }
}

async function loadChatSessions(options = {}) {
  const previousActive = { ...state.activeSessionIdByPersona };
  state.chatStore = await window.aimashi.loadChatSessions();
  const personas = state.runtime?.fellows || state.runtime?.personas || [];
  for (const persona of personas) {
    const sessions = sessionsForPersona(persona.key);
    const previous = previousActive[persona.key];
    state.activeSessionIdByPersona[persona.key] = options.preserveActive && sessions.some((session) => session.id === previous)
      ? previous
      : sessions[0]?.id;
  }
}

async function loadModelCatalog() {
  try {
    const rows = await window.aimashi.loadModelCatalog();
    state.modelCatalog = Array.isArray(rows) && rows.length ? rows : window.aimashiModelHelpers.fallbackCatalogFromPresets();
  } catch (error) {
    console.error("Failed to load Hermes model catalog", error);
    state.modelCatalog = window.aimashiModelHelpers.fallbackCatalogFromPresets();
  }
}

async function loadCodexModels() {
  try {
    if (!window.aimashi?.loadCodexModels) return;
    const rows = await window.aimashi.loadCodexModels();
    state.codexModels = Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.error("Failed to load Codex model list", error);
    state.codexModels = [];
  }
}

const EFFORT_LABELS = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high" };
const APPROVAL_LABELS = {
  ask: "Ask",
  yolo: "YOLO",
  deny: "Deny",
  manual: "Ask",   // legacy alias from previous aimashi schema
  smart: "Smart",
  off: "YOLO"     // legacy alias from previous aimashi schema
};
const APPROVAL_TITLES = {
  ask: "危险命令会暂停并等待你确认。",
  yolo: "跳过所有危险命令的确认 — 仅在完全信任当前任务时启用。",
  deny: "自动拒绝所有危险命令。",
  smart: "用辅助模型判断低风险命令，高风险仍询问。",
  manual: "(legacy) 等价于 Ask。"
};

async function loadEngineCapabilities() {
  let caps = { approvalModes: ["ask", "yolo", "deny"], effortLevels: ["low", "medium", "high"] };
  try {
    if (window.aimashi.loadEngineCapabilities) {
      const res = await window.aimashi.loadEngineCapabilities();
      if (res && Array.isArray(res.approvalModes) && res.approvalModes.length
          && Array.isArray(res.effortLevels) && res.effortLevels.length) {
        caps = res;
      }
    }
  } catch (error) {
    console.error("Failed to load engine capabilities", error);
  }
  state.engineCapabilities = caps;
  // `render()` calls syncEffortControl + syncPermissionControl which use
  // window.aimashiEngineOptions.effortOptions()/window.aimashiEngineOptions.externalPermissionOptions() — those now read state.engineCapabilities.
  render();
}

async function loadSlashCommands() {
  try {
    const rows = await window.aimashi.loadSlashCommands();
    state.slashCommands = Array.isArray(rows) && rows.length ? rows : fallbackSlashCommands;
  } catch (error) {
    console.error("Failed to load Hermes slash commands", error);
    state.slashCommands = fallbackSlashCommands;
  }
  await Promise.allSettled(["claude-code", "codex"].map(async (engine) => {
    try {
      const registry = await window.aimashi.loadAgentCommands?.({ engine });
      const rows = Array.isArray(registry?.rows) ? registry.rows : (Array.isArray(registry) ? registry : []);
      state.agentSlashCommands[engine] = rows
        .filter((item) => item?.command || item?.name)
        .map((item) => ({
          ...item,
          command: String(item.command || item.name || "").startsWith("/")
            ? String(item.command || item.name || "")
            : `/${item.command || item.name}`,
          description: String(item.description || "")
        }));
    } catch (error) {
      console.error(`Failed to load ${engine} slash commands`, error);
      state.agentSlashCommands[engine] = [];
    }
  }));
}

async function loadSkills() {
  state.skillsLoading = true;
  window.aimashiSkillLibrary.renderSkillLibrary();
  try {
    const library = await window.aimashi.loadSkills();
    const sources = Array.isArray(library?.sources)
      ? library.sources
      : (Array.isArray(library?.plugins) ? library.plugins : []);
    state.skillLibrary = {
      plugins: Array.isArray(library?.plugins) ? library.plugins : sources,
      sources,
      extensions: Array.isArray(library?.extensions) ? library.extensions : [],
      connectors: Array.isArray(library?.connectors) ? library.connectors : [],
      roots: Array.isArray(library?.roots) ? library.roots : [],
      skills: Array.isArray(library?.skills) ? library.skills : []
    };
    if (!state.selectedSkillId || !state.skillLibrary.skills.some((skill) => skill.id === state.selectedSkillId)) {
      state.selectedSkillId = state.skillLibrary.skills[0]?.id || "";
      state.selectedSkillDetail = null;
    }
    if (state.selectedSkillId) await window.aimashiSkillLibrary.selectSkill(state.selectedSkillId, false);
  } catch (error) {
    console.error("Failed to load local skills", error);
    state.skillLibrary = { plugins: [], sources: [], extensions: [], connectors: [], roots: [], skills: [] };
    state.selectedSkillId = "";
    state.selectedSkillDetail = null;
  } finally {
    state.skillsLoading = false;
    window.aimashiSkillLibrary.renderSkillLibrary();
    renderSkillPicker();
  }
}

async function trackStartupTask(label, task) {
  const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const start = performance.now();
  state.startupTasks.push({ id, label });
  render();
  try {
    return await task();
  } finally {
    const ms = Math.round(performance.now() - start);
    console.info(`[Aimashi startup] ${label}: ${ms}ms`);
    state.startupTasks = state.startupTasks.filter((item) => item.id !== id);
    render();
  }
}

function selectedAuthMethod(runtime) {
  if ((runtime?.model?.provider || "") === "openai-codex") return "openai-codex";
  return els.authMethod.value || "api-key";
}

function updateModelFieldVisibility(runtime = state.runtime) {
  const providerEntry = window.aimashiModelHelpers.selectedProviderEntry();
  const entry = window.aimashiModelHelpers.selectedModelEntry();
  const authType = String(entry?.authType || "api_key");
  const isConnected = window.aimashiModelSettings.providerIsConnected(entry?.provider, runtime);
  const isCodex = entry ? entry.provider === "openai-codex" : false;
  const needsApiKey = Boolean(entry) && !isConnected && !isCodex && !authType.startsWith("oauth") && entry?.provider !== "lmstudio";
  const needsOauth = Boolean(entry) && !isConnected && (isCodex || authType.startsWith("oauth"));
  const canConnectWithoutKey = Boolean(entry) && !isConnected && entry.provider === "lmstudio";
  els.modelApiKeyField?.classList.toggle("hidden", !needsApiKey);
  els.codexInlineAuth.classList.toggle("hidden", !needsOauth);
  els.modelConnectButton?.classList.toggle("hidden", !(needsApiKey || canConnectWithoutKey));
  if (entry) {
    window.aimashiModelSettings.applyModelEntryToFields(entry);
    const copy = window.aimashiModelSettings.modelAuthCopy(entry, runtime);
    setText(els.modelAuthState, isConnected ? "已连接" : copy.state);
    els.modelAuthState?.classList.remove("hidden");
    setText(els.modelApiKeyLabel, entry.apiKeyEnv || "API Key");
    els.modelApiKey.placeholder = "保存在 Aimashi 私有 runtime";
    if (els.modelConnectButton) {
      els.modelConnectButton.textContent = `连接 ${providerEntry?.providerLabel || entry.providerLabel || entry.provider}`;
    }
  } else {
    els.modelAuthState?.classList.add("hidden");
  }
}


function render() {
  const runtime = state.runtime;
  if (!runtime) return;
  renderSendButton();
  renderComposerReply();
  const editingModel = els.modelForm.contains(document.activeElement);
  const editingProfile = Boolean(els.profileForm?.contains(document.activeElement));
  const editingAppearance = Boolean(els.appearanceForm?.contains(document.activeElement));
  const appearance = runtime.appearance || {
    theme: "light",
    fontPreset: "pingfang",
    accentColor: DEFAULT_ACCENT_COLOR,
    userBubbleColor: DEFAULT_USER_BUBBLE_COLOR,
    showHoverBackground: false,
    showUserAvatar: true,
    showAssistantAvatar: true,
    listStyle: DEFAULT_LIST_STYLE,
    selectionStyle: DEFAULT_SELECTION_STYLE
  };
  window.aimashiSettingsAppearance.applyAppearance(appearance);
  if (!editingAppearance) {
    els.appearanceTheme.value = appearance.theme || "light";
    const savedFontPreset = appearance.fontPreset || "system";
    els.appearanceFontPreset.value = fontPresets[savedFontPreset] ? savedFontPreset : "system";
    if (els.appearanceListStyle) els.appearanceListStyle.value = window.aimashiSettingsAppearance.normalizeListStyle(appearance.listStyle);
    if (els.appearanceSelectionStyle) els.appearanceSelectionStyle.value = window.aimashiSettingsAppearance.normalizeSelectionStyle(appearance.selectionStyle);
    window.aimashiSettingsAppearance.syncAppearanceControls(appearance);
  }
  const user = runtime.user || { displayName: "Boss", avatarText: "B", avatarColor: "#111827", avatarImage: "" };
  window.aimashiAvatar.applyUserAvatar(els.userAvatar, user);
  setText(els.userDisplayName, user.displayName || "Boss");
  if (!editingProfile && els.profileForm) {
    els.profileDisplayName.value = user.displayName || "Boss";
    setProfileAvatarDraft(user.avatarImage || "", user.avatarCrop);
  }

  els.engineStatus.textContent = runtime.engineRunning
    ? `Running ${runtime.engineManagedBy ? `via ${runtime.engineManagedBy} ` : ""}at ${runtime.engineBaseUrl}`
    : runtime.engineStarting
      ? "Starting Hermes API..."
      : runtime.engineInstalled
        ? "Hermes engine installed"
        : "Runtime home initialized; engine package not installed";
  renderEngineDetection(runtime);
  els.hermesHome.textContent = runtime.hermesHome;
  els.manifestPath.textContent = runtime.manifestPath;
  els.engineWarning.classList.toggle("hidden", runtime.engineInstalled);
  const source = runtime.engineSource;
  const managedVenvExists = Boolean(runtime.managedVenvExists);
  // Hide "Install Engine" when the runtime is already bundled in the .app.
  if (els.installEngine) els.installEngine.classList.toggle("hidden", source === "bundled");
  if (els.uninstallEngine) els.uninstallEngine.classList.toggle("hidden", !managedVenvExists);
  els.engineLogs.textContent = [
    runtime.engineLastError ? `ERROR: ${runtime.engineLastError}` : "",
    ...(runtime.engineLogs || [])
  ].filter(Boolean).join("\n");
  window.aimashiSettingsRemote.renderMobilePairing(runtime.daemon || {});
  window.aimashiSettingsRemote.renderRelayPairing(runtime.relay || {});
  window.aimashiSettingsRemote.renderCloudAccount(runtime.cloud || {});
  const auth = runtime.auth || {};
  const editingModelSelect = document.activeElement === els.modelSelect || document.activeElement === els.quickModelSelect || document.activeElement === els.effortSelect;
  if (!editingModel && !editingModelSelect) window.aimashiModelSettings.renderModelSelectors(runtime);
  window.aimashiModelSettings.renderConnectedProviders(runtime);
  updateModelFieldVisibility(runtime);
  const selectedEntry = window.aimashiModelHelpers.selectedModelEntry();
  const selectedProvider = selectedEntry?.provider || auth.oauthProvider || "openai-codex";
  const selectedProviderLabel = window.aimashiModelHelpers.providerLabel(selectedProvider);
  const selectedConnected = window.aimashiModelSettings.providerIsConnected(selectedProvider, runtime);
  els.codexStatus.textContent = auth.codexStarting
    ? `等待 ${auth.oauthProviderLabel || selectedProviderLabel} 授权`
    : selectedConnected
      ? `已授权 ${selectedProviderLabel}`
      : `需要登录 ${selectedProviderLabel}`;
  els.codexCheck.classList.toggle("authorized", Boolean(selectedConnected));
  els.codexCode.textContent = auth.codexUserCode
    ? `在浏览器页面输入：${auth.codexUserCode}`
    : auth.codexStarting
      ? (auth.codexVerificationUrl ? `打开：${auth.codexVerificationUrl}` : "正在请求设备码...")
      : "";
  els.codexLogs.textContent = [
    auth.codexLastError ? `ERROR: ${auth.codexLastError}` : "",
    ...(auth.codexLogs || [])
  ].filter(Boolean).join("\n");
  els.codexLogs.classList.toggle("hidden", Boolean(selectedConnected) && !auth.codexLastError);
  els.codexLogin.disabled = Boolean(auth.codexStarting);
  els.codexLogin.textContent = `登录 ${selectedProviderLabel}`;
  els.codexLogin.classList.toggle("hidden", Boolean(selectedConnected));
  els.codexCancel.disabled = !auth.codexStarting;
  els.codexCancel.classList.toggle("hidden", !auth.codexStarting);
  if (!editingModel) updateModelFieldVisibility(runtime);
  if (els.quickModelSelect && document.activeElement !== els.quickModelSelect) {
    const engine = window.aimashiEngineOptions.activeAgentEngine();
    const currentModelId = engine === "claude-code" || engine === "codex"
      ? (window.aimashiEngineOptions.engineConfigForPersona().model || "default")
      : window.aimashiModelHelpers.presetKeyForModel(runtime.model);
    if ([...els.quickModelSelect.options].some((option) => option.value === currentModelId)) {
      els.quickModelSelect.value = currentModelId;
    }
    window.aimashiModelSettings.syncQuickModelLabel();
  }
  window.aimashiModelSettings.syncEffortControl(runtime);
  const connectedEntries = window.aimashiModelSettings.connectedModelEntries(runtime);
  const engine = window.aimashiEngineOptions.activeAgentEngine();
  const engineInfo = runtime.agentEngines || {};
  const externalAvailable = engine === "claude-code"
    ? engineInfo.claudeCode?.available
    : engine === "codex"
      ? engineInfo.codex?.available
      : false;
  setText(els.modelSwitchStatus, engine === "claude-code"
    ? (externalAvailable ? "Claude Code 本地" : "未检测到 Claude Code")
    : engine === "codex"
      ? (externalAvailable ? "Codex 本地" : "未检测到 Codex")
      : connectedEntries.length ? (runtime.engineRunning ? "已连接" : runtime.engineInstalled ? "未启动" : "未安装") : "先连接提供商");
  if (els.quickModelSelect) {
    els.quickModelSelect.title = engine === "claude-code" || engine === "codex"
      ? `当前模型：${els.quickModelSelect.selectedOptions?.[0]?.textContent || "默认"}`
      : connectedEntries.length
        ? `当前模型：${window.aimashiModelHelpers.modelDisplayName(runtime.model)}`
        : "未配置模型";
  }
  const activeIcon = engine === "claude-code"
    ? window.aimashiModelHelpers.modelIconSrc({ provider: "anthropic", model: "claude" })
    : engine === "codex"
      ? window.aimashiModelHelpers.modelIconSrc({ provider: "openai-codex", model: "codex" })
      : connectedEntries.length
        ? window.aimashiModelHelpers.modelIconSrc(runtime.model || {})
        : "";
  const modelAvatar = document.querySelector(".model-avatar");
  if (modelAvatar) {
    modelAvatar.textContent = activeIcon ? "" : "◇";
    modelAvatar.style.backgroundImage = activeIcon ? `url("${activeIcon}")` : "";
  }
  window.aimashiModelSettings.syncPermissionControl(runtime);

  const personas = runtime.fellows || runtime.personas || [];
  // Only fall back to personas[0] when no persona matches AND no group is active.
  // Without this guard, clicking a group (whose id doesn't match any persona key)
  // immediately resets activeKey back to personas[0], making group selection a no-op.
  if (!personas.some((persona) => persona.key === state.activeKey) && personas.length && !activeGroup()) {
    state.activeKey = personas[0].key;
  }
  if (!personas.some((persona) => persona.key === state.activeContactKey) && personas.length) {
    state.activeContactKey = personas.find((persona) => persona.key === state.activeKey)?.key || personas[0].key;
  }
  window.aimashiSessionReadState.initializeReadStateForPersonas(personas);
  window.aimashiSessionReadState.markPersonaRead(state.activeKey, false);
  const unreadTotal = window.aimashiSessionReadState.totalUnreadCount(personas);
  els.personaCount.textContent = unreadTotal > 99 ? "99+" : String(unreadTotal);
  els.personaCount.classList.toggle("hidden", unreadTotal <= 0);
  const groupActive = activeGroup();
  const active = personas.find((persona) => persona.key === state.activeKey) || personas[0];
  const groupInfoBtn = document.getElementById("groupInfoButton");
  if (groupActive) {
    // Render composite group avatar in topbar (Boss first, then all Fellows)
    if (els.activeChatAvatar) {
      els.activeChatAvatar.textContent = "";
      els.activeChatAvatar.setAttribute("style", "");
      els.activeChatAvatar.className = "profile-avatar group-avatar";
      const topbarUser = state.runtime?.user || {};
      const topbarBossColor = topbarUser.avatarColor || "#111827";
      const bossTileTopbar = document.createElement("span");
      bossTileTopbar.className = "group-avatar-tile";
      let topbarBossStyle = "";
      if (typeof window.aimashiAvatar?.avatarThumbBackgroundStyle === "function" && topbarUser.avatarImage) {
        topbarBossStyle = window.aimashiAvatar.avatarThumbBackgroundStyle(topbarUser.avatarImage, topbarUser.avatarCrop, topbarBossColor);
      }
      if (!topbarBossStyle || topbarBossStyle.trim() === "") {
        topbarBossStyle = "background-color:" + topbarBossColor + ";";
      }
      bossTileTopbar.style.cssText = topbarBossStyle;
      els.activeChatAvatar.appendChild(bossTileTopbar);
      for (const mid of (groupActive.members || [])) {
        const tile = document.createElement("span");
        tile.className = "group-avatar-tile";
        const fellow = personas.find((p) => (p.id || p.key) === mid);
        let styleStr = window.aimashiAvatar.avatarThumbBackgroundStyle(
          fellow?.avatarImage || window.aimashiAvatar.avatarAssetForKey(mid),
          fellow?.avatarCrop,
          fellow?.color || "#5e5ce6"
        );
        if (!styleStr || styleStr.trim() === "") {
          styleStr = "background-color:" + (fellow?.color || "#5e5ce6") + ";";
        }
        tile.style.cssText = styleStr;
        els.activeChatAvatar.appendChild(tile);
      }
      els.activeChatAvatar.setAttribute("data-count", String(1 + (groupActive.members || []).length));
    }
    setText(els.activeChatName, groupActive.name || "未命名群聊");
    if (els.activeChatMeta) {
      els.activeChatMeta.textContent = "群聊 · " + ((groupActive.members || []).length + 1) + " 人";
    }
    if (groupInfoBtn) groupInfoBtn.classList.remove("hidden");
    // Hide session menu (not relevant for group chats)
    if (els.sessionMenuButton) els.sessionMenuButton.classList.add("hidden");
    const composerBottom = document.querySelector(".composer-bottom");
    if (composerBottom) composerBottom.classList.add("hidden");
  } else if (active) {
    if (els.activeChatAvatar) {
      els.activeChatAvatar.innerHTML = "";
      els.activeChatAvatar.className = "profile-avatar";
    }
    window.aimashiAvatar.applyFellowAvatar(els.activeChatAvatar, active);
    setText(els.activeChatName, active.name || "Aimashi");
    renderHeaderStatus();
    if (groupInfoBtn) groupInfoBtn.classList.add("hidden");
    if (els.sessionMenuButton) els.sessionMenuButton.classList.remove("hidden");
    const composerBottom = document.querySelector(".composer-bottom");
    if (composerBottom) composerBottom.classList.remove("hidden");
  }
  const filter = state.personaFilter.trim().toLowerCase();
  const visiblePersonas = filter
    ? personas.filter((persona) => `${persona.name || ""} ${persona.key || ""}`.toLowerCase().includes(filter))
    : personas;
  const visibleGroups = listGroups().filter((group) => (
    !filter || `${group.name || ""} ${(group.members || []).join(" ")}`.toLowerCase().includes(filter)
  ));
  const messageRows = window.aimashiFellowManager.sortMessageCardsForSidebar([
    ...visiblePersonas.map((persona) => ({
      type: "fellow",
      key: persona.key,
      pinned: Boolean(persona.pinned),
      pinnedAt: persona.pinnedAt || "",
      updatedAt: conversationUpdatedAt(persona),
      persona
    })),
    ...visibleGroups.map((group) => ({
      type: "group",
      key: group.id,
      pinned: Boolean(group.pinned),
      pinnedAt: group.pinnedAt || "",
      updatedAt: groupConversationUpdatedAt(group),
      group
    }))
  ]);

  els.personaList.innerHTML = "";
  for (const row of messageRows) {
    if (row.type === "fellow") {
      const persona = row.persona;
      const preview = conversationPreview(persona);
      const unread = window.aimashiSessionReadState.unreadCountForPersona(persona.key);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `persona message-card private-message-card${persona.key === state.activeKey ? " active" : ""}${persona.pinned ? " pinned" : ""}`;
      button.innerHTML = `
        <span class="avatar fellow-photo" data-fellow-avatar="${window.aimashiMarkdown.escapeHtml(persona.key)}" style="${window.aimashiAvatar.avatarThumbBackgroundStyle(persona.avatarImage || window.aimashiAvatar.avatarAssetForKey(persona.key), persona.avatarCrop, persona.color || "#5e5ce6")}"></span>
        <span class="persona-main">
          <span class="persona-name-row">
            <span class="persona-name">${window.aimashiMarkdown.escapeHtml(persona.name)}</span>
            <span class="persona-type">私聊</span>
          </span>
          <span class="persona-key">${window.aimashiMarkdown.escapeHtml(preview.text || "暂无对话")}</span>
        </span>
        <span class="persona-side">
          <span class="persona-time">${window.aimashiMarkdown.escapeHtml(preview.time)}</span>
          <span class="persona-pin${persona.pinned ? "" : " hidden"}" aria-label="置顶">${ICON_PARK_PIN_SVG}</span>
          <span class="persona-unread${unread ? "" : " hidden"}">${window.aimashiMarkdown.escapeHtml(unread > 99 ? "99+" : String(unread))}</span>
        </span>
      `;
      button.addEventListener("click", () => {
        state.activeKey = persona.key;
        state.activeGroupId = "";
        if (window.aimashiGroup) window.aimashiGroup.moduleState.activeGroupId = null;
        const latest = sessionsForPersona(persona.key)[0];
        state.activeSessionIdByPersona[persona.key] = latest?.id;
        state.replyDraft = null;
        window.aimashiSessionReadState.markPersonaRead(persona.key);
        state.sessionMenuOpen = false;
        showNarrowContent();
        render();
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.aimashiFellowManager.openFellowContextMenu(persona.key, event.clientX, event.clientY);
      });
      els.personaList.appendChild(button);
      continue;
    }

    const group = row.group;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `persona message-card group-persona${group.id === state.activeKey ? " active" : ""}${group.pinned ? " pinned" : ""}`;
    const preview = groupConversationPreview(group, personas);
    btn.innerHTML = `
      <span class="avatar group-avatar"></span>
      <span class="persona-main">
        <span class="persona-name-row">
          <span class="persona-name">${window.aimashiMarkdown.escapeHtml(group.name || "未命名群聊")}</span>
          <span class="persona-type group">群聊</span>
        </span>
        <span class="persona-key">${window.aimashiMarkdown.escapeHtml(preview.text)}</span>
      </span>
      <span class="persona-side">
        <span class="persona-time">${window.aimashiMarkdown.escapeHtml(preview.time)}</span>
        <span class="persona-pin${group.pinned ? "" : " hidden"}" aria-label="置顶">${ICON_PARK_PIN_SVG}</span>
      </span>
    `;
    // Build composite avatar tiles (Boss first, then all Fellows)
    const avatarEl = btn.querySelector(".avatar.group-avatar");
    const sidebarUser = state.runtime?.user || {};
    const sidebarBossColor = sidebarUser.avatarColor || "#111827";
    const bossTileSidebar = document.createElement("span");
    bossTileSidebar.className = "group-avatar-tile";
    let sidebarBossStyle = "";
    if (typeof window.aimashiAvatar?.avatarThumbBackgroundStyle === "function" && sidebarUser.avatarImage) {
      sidebarBossStyle = window.aimashiAvatar.avatarThumbBackgroundStyle(sidebarUser.avatarImage, sidebarUser.avatarCrop, sidebarBossColor);
    }
    if (!sidebarBossStyle || sidebarBossStyle.trim() === "") {
      sidebarBossStyle = "background-color:" + sidebarBossColor + ";";
    }
    bossTileSidebar.style.cssText = sidebarBossStyle;
    avatarEl.appendChild(bossTileSidebar);
    for (const mid of (group.members || [])) {
      const tile = document.createElement("span");
      tile.className = "group-avatar-tile";
      const fellow = personas.find((p) => (p.id || p.key) === mid);
      let styleStr = window.aimashiAvatar.avatarThumbBackgroundStyle(
        fellow?.avatarImage || window.aimashiAvatar.avatarAssetForKey(mid),
        fellow?.avatarCrop,
        fellow?.color || "#5e5ce6"
      );
      if (!styleStr || styleStr.trim() === "") {
        styleStr = "background-color:" + (fellow?.color || "#5e5ce6") + ";";
      }
      tile.style.cssText = styleStr;
      avatarEl.appendChild(tile);
    }
    avatarEl.setAttribute("data-count", String(1 + (group.members || []).length));
    btn.addEventListener("click", () => {
      state.activeKey = group.id;
      state.activeGroupId = group.id;
      if (window.aimashiGroup) window.aimashiGroup.moduleState.activeGroupId = group.id;
      state.replyDraft = null;
      state.sessionMenuOpen = false;
      showNarrowContent();
      render();
    });
    btn.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openGroupContextMenu(group.id, event.clientX, event.clientY);
    });
    els.personaList.appendChild(btn);
  }

  if (!messageRows.length) {
    const empty = document.createElement("div");
    empty.className = "persona-empty";
    empty.textContent = "没有匹配的消息";
    els.personaList.appendChild(empty);
  }
  renderView();
  renderSessionMenu();
  if (!window.aimashiMessageMenu?.hasActiveMessageTextSelection()) renderChat();
}

function renderView() {
  if (state.activeSettingsTab === "profile") state.activeSettingsTab = "appearance";
  if (state.activeSettingsTab === "runtime") state.activeSettingsTab = "model";
  if (!document.querySelector(`[data-settings-tab="${state.activeSettingsTab}"]`)) {
    state.activeSettingsTab = "appearance";
  }
  syncNarrowLayout();
  els.conversationSidebar?.classList.toggle("hidden", state.activeView !== "chat");
  els.contactsSidebar?.classList.toggle("hidden", state.activeView !== "contacts");
  els.skillsSidebar?.classList.toggle("hidden", state.activeView !== "skills");
  els.tasksSidebar?.classList.toggle("hidden", state.activeView !== "tasks");
  els.chatView.classList.toggle("hidden", state.activeView !== "chat");
  els.contactsView?.classList.toggle("hidden", state.activeView !== "contacts");
  els.skillsView?.classList.toggle("hidden", state.activeView !== "skills");
  els.tasksView?.classList.toggle("hidden", state.activeView !== "tasks");
  els.settingsView.classList.toggle("hidden", !state.settingsOpen);
  els.profileDialog?.classList.toggle("hidden", !state.profileDialogOpen);
  els.fellowCreateMenu?.classList.toggle("hidden", !state.fellowMenuOpen);
  els.fellowDialog?.classList.toggle("hidden", !state.fellowDialogOpen);
  els.petGenerateDialog?.classList.toggle("hidden", !state.petGenerateOpen);
  els.avatarCropDialog?.classList.toggle("hidden", !state.avatarCropEditor.open);
  window.aimashiSkillLibrary.renderSkillPreview();
  window.aimashiFellowManager.renderFellowContextMenu();
  renderGroupContextMenu();
  window.aimashiPetDialog?.renderPetGenerateDialog();
  window.aimashiPetDialog?.renderPetJobs();
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.activeView);
  });
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsTab === state.activeSettingsTab);
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.settingsPanel !== state.activeSettingsTab);
  });
  window.aimashiSkillLibrary.renderSkillLibrary();
  window.aimashiFellowManager.renderContacts();
  window.aimashiTasksPanel?.renderTaskSidebar();
  window.aimashiTasksPanel?.renderTaskView();
}


function syncTopbarClickCapture() {
  document.body.classList.toggle("topbar-click-capture", Boolean(state.skillContextMenu.open || state.groupContextMenu.open || state.sessionMenuOpen));
}

function formatRunTime(ms) {
  if (ms == null) return "—";
  const d = new Date(ms);
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}


function groupById(groupId) {
  return listGroups().find((group) => group.id === groupId) || null;
}

function openGroupContextMenu(groupId, x, y) {
  if (!groupId) return;
  window.aimashiMessageMenu?.closeMessageContextMenu();
  window.aimashiFellowManager.closeFellowContextMenu();
  window.aimashiSkillLibrary.closeSkillContextMenu();
  state.groupContextMenu = { open: true, x, y, groupId };
  renderGroupContextMenu();
}

function closeGroupContextMenu() {
  if (!state.groupContextMenu.open) return;
  state.groupContextMenu = { open: false, x: 0, y: 0, groupId: "" };
  renderGroupContextMenu();
}

function renderGroupContextMenu() {
  if (!els.groupContextMenu) return;
  const menu = els.groupContextMenu;
  const group = groupById(state.groupContextMenu.groupId);
  const open = state.groupContextMenu.open && group;
  menu.classList.toggle("hidden", !open);
  syncTopbarClickCapture();
  if (!open) return;
  menu.innerHTML = `
    ${window.aimashiMarkdown.menuItemHtml({ icon: "pin", label: group.pinned ? "取消置顶" : "置顶", attrs: 'data-group-action="pin"' })}
    ${window.aimashiMarkdown.menuItemHtml({ icon: "edit", label: "编辑群组", attrs: 'data-group-action="edit"' })}
    <div class="skill-context-menu-separator" role="separator"></div>
    ${window.aimashiMarkdown.menuItemHtml({ icon: "delete", label: "删除群组", attrs: 'data-group-action="delete"', className: "danger" })}
  `;
  const rect = menu.getBoundingClientRect();
  const width = rect.width || 138;
  const height = rect.height || 126;
  menu.style.left = `${Math.max(8, Math.min(state.groupContextMenu.x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(state.groupContextMenu.y, window.innerHeight - height - 8))}px`;
  menu.querySelector('[data-group-action="pin"]')?.addEventListener("click", async () => {
    closeGroupContextMenu();
    await setGroupPinned(group.id, !group.pinned);
  });
  menu.querySelector('[data-group-action="edit"]')?.addEventListener("click", () => {
    closeGroupContextMenu();
    if (window.aimashiGroup && typeof window.aimashiGroup.openInfoDialog === "function") {
      window.aimashiGroup.openInfoDialog(group);
    }
  });
  menu.querySelector('[data-group-action="delete"]')?.addEventListener("click", async () => {
    closeGroupContextMenu();
    await deleteGroup(group.id);
  });
}

function messageAtIndex(index) {
  const messages = messagesForActive();
  if (!Number.isInteger(index) || index < 0 || index >= messages.length) return null;
  return messages[index] || null;
}

function messagePlainText(message) {
  return String(message?.content || "").trim();
}

function messageContextText(message, selectionText = "") {
  return String(selectionText || "").trim() || messagePlainText(message);
}

function messageContextSnippet(message, selectionText = "") {
  const text = messageContextText(message, selectionText).replace(/\s+/g, " ");
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function messageAuthorLabel(message) {
  if (message?.role === "user") return "你";
  const persona = activePersona();
  return persona?.name || "AI";
}

function messageReferenceForIndex(index, selectionText = "") {
  const message = messageAtIndex(index);
  const snippet = messageContextSnippet(message, selectionText);
  if (!message || !snippet) return null;
  return {
    role: message.role,
    author: messageAuthorLabel(message),
    content: snippet,
    createdAt: message.createdAt || "",
    messageIndex: index,
    selected: Boolean(String(selectionText || "").trim())
  };
}

function replyQuoteHtml(replyTo) {
  if (!replyTo?.content) return "";
  return `
    <div class="message-reply-quote">
      <span>${window.aimashiMarkdown.escapeHtml(replyTo.author || (replyTo.role === "user" ? "你" : "AI"))}</span>
      <p>${window.aimashiMarkdown.escapeHtml(replyTo.content)}</p>
    </div>
  `;
}

let composerCompositionEndedAt = 0;

function isComposerComposing(event = null) {
  const justCommitted =
    event?.key === "Enter" &&
    composerCompositionEndedAt > 0 &&
    performance.now() - composerCompositionEndedAt < 80;
  return Boolean(
    els.chatInput?.dataset.composing === "true" ||
    event?.isComposing ||
    event?.key === "Process" ||
    event?.keyCode === 229 ||
    justCommitted
  );
}

function resizeChatInput() {
  const input = els.chatInput;
  if (!input) return;
  const style = window.getComputedStyle(input);
  const minHeight = Number.parseFloat(style.minHeight) || 41;
  const maxHeight = Number.parseFloat(style.maxHeight) || 180;
  if (!input.value) {
    input.style.height = `${minHeight}px`;
    input.style.overflowY = "hidden";
    return;
  }
  input.style.height = `${minHeight}px`;
  const nextHeight = Math.max(minHeight, Math.min(input.scrollHeight, maxHeight));
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
}

function insertComposerText(text) {
  const value = String(text || "");
  if (!value || !els.chatInput) return;
  els.chatInput.value = value;
  els.chatInput.focus();
  els.chatInput.setSelectionRange(value.length, value.length);
  resizeChatInput();
  renderSendButton();
  updateSlashCommandState();
}

function renderComposerReply() {
  if (!els.composerReply) return;
  const reply = state.replyDraft;
  els.composerReply.classList.toggle("hidden", !reply);
  if (!reply) {
    els.composerReply.innerHTML = "";
    return;
  }
  els.composerReply.innerHTML = `
    <div>
      <span>回复 ${window.aimashiMarkdown.escapeHtml(reply.author || "消息")}</span>
      <p>${window.aimashiMarkdown.escapeHtml(reply.content || "")}</p>
    </div>
    <button type="button" data-clear-reply title="取消回复" aria-label="取消回复">×</button>
  `;
}

async function openEditFellowDialog(fellowKey) {
  try {
    const details = await window.aimashi.loadFellowDetails(fellowKey);
    openFellowDialog(details.fellow, details.personaText || "");
  } catch (error) {
    appendTransientChat("assistant", `编辑 Fellow 失败: ${error.message}`);
  }
}

async function setFellowPinned(fellowKey, pinned) {
  try {
    state.runtime = await window.aimashi.setFellowPinned({ key: fellowKey, pinned });
    render();
  } catch (error) {
    appendTransientChat("assistant", `置顶失败: ${error.message}`);
    await refreshRuntime();
  }
}

async function deleteFellow(fellowKey) {
  const fellow = window.aimashiFellowManager.fellowByKey(fellowKey);
  if (!fellow || fellow.key === "aimashi") return;
  const ok = window.confirm(`删除「${fellow.name || fellow.key}」？\n\n这会移除该伙伴、人设文件和本地会话记录。`);
  if (!ok) return;
  try {
    state.runtime = await window.aimashi.deleteFellow({ key: fellow.key });
    await loadChatSessions();
    const fellows = state.runtime?.fellows || state.runtime?.personas || [];
    const next = fellows[0]?.key || "aimashi";
    if (!fellows.some((item) => item.key === state.activeKey)) state.activeKey = next;
    if (!fellows.some((item) => item.key === state.activeContactKey)) state.activeContactKey = state.activeKey;
    render();
  } catch (error) {
    appendTransientChat("assistant", `删除伙伴失败: ${error.message}`);
    await refreshRuntime();
  }
}

async function setGroupPinned(groupId, pinned) {
  const group = groupById(groupId);
  if (!group) return;
  try {
    const patch = { pinned: Boolean(pinned), pinnedAt: pinned ? nowIso() : "" };
    const updated = await window.aimashi.groups.update(group.id, patch);
    if (window.aimashiGroup?.moduleState?.groups) {
      const index = window.aimashiGroup.moduleState.groups.findIndex((item) => item.id === group.id);
      if (index >= 0) window.aimashiGroup.moduleState.groups[index] = updated;
    }
    render();
  } catch (error) {
    appendTransientChat("assistant", `群组置顶失败: ${error.message}`);
  }
}

async function deleteGroup(groupId) {
  const group = groupById(groupId);
  if (!group) return;
  const ok = window.confirm(`删除群组「${group.name || "未命名群聊"}」？\n\n这会移除该群组和本地群聊记录。`);
  if (!ok) return;
  try {
    await window.aimashi.groups.delete(group.id);
    if (window.aimashiGroup?.moduleState) {
      window.aimashiGroup.moduleState.groups = (window.aimashiGroup.moduleState.groups || []).filter((item) => item.id !== group.id);
      window.aimashiGroup.moduleState.messagesByGroup?.delete?.(group.id);
      if (window.aimashiGroup.moduleState.activeGroupId === group.id) {
        window.aimashiGroup.moduleState.activeGroupId = null;
      }
    }
    if (state.activeKey === group.id) {
      const fellows = state.runtime?.fellows || state.runtime?.personas || [];
      state.activeKey = fellows[0]?.key || "";
      state.activeGroupId = "";
    }
    render();
  } catch (error) {
    appendTransientChat("assistant", `删除群组失败: ${error.message}`);
  }
}

async function deleteSkill(skillId) {
  const skill = state.skillLibrary.skills.find((item) => item.id === skillId);
  if (!skill || skill.source !== "aimashi") return;
  const label = window.aimashiSkillHelpers.skillDisplayName(skill);
  if (!window.confirm(`删除本地 Skill「${label}」？\n\n会移除 Aimashi Runtime skills 目录下对应文件夹。`)) return;
  try {
    const library = await window.aimashi.deleteSkill(skillId);
    const sources = Array.isArray(library?.sources)
      ? library.sources
      : (Array.isArray(library?.plugins) ? library.plugins : []);
    state.skillLibrary = {
      plugins: Array.isArray(library?.plugins) ? library.plugins : sources,
      sources,
      extensions: Array.isArray(library?.extensions) ? library.extensions : [],
      connectors: Array.isArray(library?.connectors) ? library.connectors : [],
      roots: Array.isArray(library?.roots) ? library.roots : [],
      skills: Array.isArray(library?.skills) ? library.skills : []
    };
    if (state.selectedSkillId === skillId) {
      state.selectedSkillId = "";
      state.selectedSkillDetail = null;
      state.skillPreviewOpen = false;
    }
  } catch (error) {
    console.error("Failed to delete skill", error);
    window.alert(error.message || "删除 Skill 失败");
  }
  window.aimashiSkillLibrary.renderSkillLibrary();
  window.aimashiSkillLibrary.renderSkillPreview();
}

async function installExtension(extensionId) {
  if (!extensionId || state.installingExtensions.has(extensionId)) return;
  state.installingExtensions.add(extensionId);
  window.aimashiSkillLibrary.renderSkillLibrary();
  try {
    const library = await window.aimashi.installPlugin(extensionId);
    const sources = Array.isArray(library?.sources)
      ? library.sources
      : (Array.isArray(library?.plugins) ? library.plugins : []);
    state.skillLibrary = {
      plugins: Array.isArray(library?.plugins) ? library.plugins : sources,
      sources,
      extensions: Array.isArray(library?.extensions) ? library.extensions : [],
      connectors: Array.isArray(library?.connectors) ? library.connectors : [],
      roots: Array.isArray(library?.roots) ? library.roots : [],
      skills: Array.isArray(library?.skills) ? library.skills : []
    };
    state.skillLibraryMode = "plugins";
    state.selectedExtensionId = "";
  } catch (error) {
    window.alert(`安装失败：${error.message || error}`);
  } finally {
    state.installingExtensions.delete(extensionId);
    window.aimashiSkillLibrary.renderSkillLibrary();
    renderSkillPicker();
  }
}

async function openSkillDirectory(skillId) {
  try {
    await window.aimashi.openSkillDirectory(skillId);
  } catch (error) {
    console.error("Failed to open skill directory", error);
    window.alert(error.message || "打开 Skill 目录失败");
  }
}

function messagesForActive() {
  return activeSession().messages;
}

function renderEngineDetection(runtime) {
  const engines = runtime?.agentEngines || {};

  if (els.engineRowHermes) {
    const source = runtime?.engineSource;
    let line;
    if (source === "bundled") {
      line = runtime?.engineRunning ? "随安装包内置 · 运行中" : "随安装包内置 · 就绪";
    } else if (source === "managed") {
      line = runtime?.engineRunning ? "独立副本运行中" : "独立副本已安装";
    } else {
      line = "未安装 · 点开后可安装独立副本";
    }
    els.engineRowHermes.textContent = line;
  }

  if (els.engineRowClaude) {
    const cc = engines.claudeCode || {};
    if (cc.available) {
      const v = cc.version ? ` · ${cc.version.split(" ")[0]}` : "";
      els.engineRowClaude.textContent = `${cc.path || "已检测到"}${v}`;
    } else {
      els.engineRowClaude.textContent = "未检测到";
    }
  }

  if (els.engineRowCodex) {
    const cx = engines.codex || {};
    if (cx.available) {
      const v = cx.version ? ` · ${cx.version.split(" ")[0]}` : "";
      els.engineRowCodex.textContent = `${cx.path || "已检测到"}${v}`;
    } else {
      els.engineRowCodex.textContent = "未检测到";
    }
  }
}

function renderSessionMenu() {
  if (!els.sessionMenu || !els.sessionList) return;
  els.sessionMenu.classList.toggle("hidden", !state.sessionMenuOpen);
  syncTopbarClickCapture();
  const sessions = sessionsForPersona();
  const current = activeSession();
  const activeId = current.id;
  updateCurrentSessionTitle(current.title || "新对话");
  els.sessionList.innerHTML = "";
  for (const session of sessions) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `session-row${session.id === activeId ? " active" : ""}`;
    row.innerHTML = `
      <span>
        <strong>${window.aimashiMarkdown.escapeHtml(session.title || "新对话")}</strong>
        <small>${window.aimashiMarkdown.escapeHtml(new Date(session.updatedAt || session.createdAt || Date.now()).toLocaleString())}</small>
      </span>
      <em title="重命名" data-session-edit="${window.aimashiMarkdown.escapeHtml(session.id)}">${window.aimashiMarkdown.iconParkIcon("edit", "session-row-edit-icon")}</em>
    `;
    row.addEventListener("click", async (event) => {
      const editTarget = event.target.closest("[data-session-edit]");
      if (editTarget) {
        event.stopPropagation();
        const title = window.prompt("重命名这个会话", session.title || "新对话");
        if (!title || !title.trim()) return;
        state.chatStore = await window.aimashi.renameChatSession({
          personaKey: state.activeKey,
          sessionId: session.id,
          title
        });
      } else {
        state.activeSessionIdByPersona[state.activeKey] = session.id;
        state.sessionMenuOpen = false;
        state.forceScrollToBottom = true;
        state.replyDraft = null;
      }
      render();
    });
    els.sessionList.appendChild(row);
  }
}

function updateCurrentSessionTitle(title) {
  if (!els.currentSessionTitle) return;
  const next = title || "新对话";
  if (els.currentSessionTitle.textContent === next) return;
  els.currentSessionTitle.textContent = next;
  els.currentSessionTitle.classList.remove("title-updated");
  requestAnimationFrame(() => els.currentSessionTitle.classList.add("title-updated"));
}

async function maybeGenerateTitleForSession(session) {
  if (!session || session.titleGenerated || !hasSuccessfulExchange(session) || state.generatingTitleIds.has(session.id)) return;
  state.generatingTitleIds.add(session.id);
  try {
    const result = await window.aimashi.generateSessionTitle({
      personaKey: session.personaKey || state.activeKey,
      sessionId: `title:${session.id}`,
      messages: (session.messages || []).filter((message) => !message.transient).slice(0, 4)
    });
    session.title = result.title || session.title || "新对话";
    session.titleGenerated = true;
    session.updatedAt = nowIso();
    await persistSessionQuietly(session);
    renderSessionMenu();
  } finally {
    state.generatingTitleIds.delete(session.id);
  }
}

function normalizeTraceText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[\s\u3000`*_~#>()[\]{}.,，。!?！？:：;；"'“”‘’、|/\\-]+/g, "");
}

function isDuplicateTraceReasoning(reasoning, content) {
  const reasoningText = normalizeTraceText(reasoning);
  const contentText = normalizeTraceText(content);
  if (!reasoningText || !contentText) return false;
  if (reasoningText === contentText) return true;
  const shorter = reasoningText.length <= contentText.length ? reasoningText : contentText;
  const longer = reasoningText.length > contentText.length ? reasoningText : contentText;
  return shorter.length >= 16 && longer.includes(shorter);
}

function traceReasoningForDisplay(reasoning, tools, content = "") {
  const text = String(reasoning || "").trim();
  if (!text) return "";
  const toolList = Array.isArray(tools) ? tools : [];
  if (isDuplicateTraceReasoning(text, content)) return "";
  if (!toolList.length) return "";
  return text;
}

function renderTraceBlocks({ reasoning, tools, content, expanded, scopeKey }) {
  const toolList = Array.isArray(tools) ? tools : [];
  const displayReasoning = traceReasoningForDisplay(reasoning, toolList, content);
  if (!displayReasoning && !toolList.length) return "";
  const rows = [];
  const openState = (key) => {
    if (!key) return { open: Boolean(expanded), userOpen: false, userClosed: false };
    const userOpen = state.openTraceKeys.has(key);
    const userClosed = state.openTraceKeys.has(`!${key}`);
    return {
      open: userOpen || (!userClosed && Boolean(expanded)),
      userOpen,
      userClosed
    };
  };
  const animClass = (key) => {
    if (!key) return "";
    if (state.animatedTraceKeys.has(key)) return "";
    return " trace-anim-enter";
  };
  const rowAttrs = (key, idx, stateForKey) => {
    const attrs = [];
    if (key) attrs.push(`data-trace-key="${window.aimashiMarkdown.escapeHtml(key)}"`);
    if (stateForKey.open) attrs.push("open");
    if (stateForKey.open && stateForKey.userOpen) {
      attrs.push('data-user-open="true"');
    } else if (stateForKey.open) {
      attrs.push('data-auto-open="true"');
    }
    if (key && !state.animatedTraceKeys.has(key)) {
      attrs.push(`style="--trace-delay:${Math.min(idx, 6) * 60}ms"`);
    }
    return attrs.length ? ` ${attrs.join(" ")}` : "";
  };
  if (displayReasoning) {
    const reasoningText = displayReasoning;
    const key = scopeKey ? `${scopeKey}::reasoning` : "";
    const stateForKey = openState(key);
    rows.push(
      `<details class="trace-row reasoning${animClass(key)}"${rowAttrs(key, rows.length, stateForKey)}>` +
        `<summary><span class="trace-chevron">▸</span><span class="trace-cmd">thinking</span><span class="trace-arg">${window.aimashiMarkdown.escapeHtml(reasoningText.slice(0, 80).replace(/\s+/g, " "))}</span></summary>` +
        `<pre class="trace-body">${window.aimashiMarkdown.escapeHtml(reasoningText)}</pre>` +
      `</details>`
    );
  }
  for (let idx = 0; idx < toolList.length; idx++) {
    const tool = toolList[idx];
    const status = tool.status === "completed" ? "ok" : tool.status === "error" ? "err" : "run";
    const glyph = status === "ok" ? "✓" : status === "err" ? "✗" : "●";
    const meta = status === "run"
      ? "…"
      : (tool.duration != null ? `${Number(tool.duration).toFixed(2)}s` : "");
    const name = String(tool.name || "tool");
    const preview = String(tool.preview || "");
    const previewInline = preview.replace(/\s+/g, " ").slice(0, 120);
    const key = scopeKey ? `${scopeKey}::tool::${tool.id || idx}` : "";
    const stateForKey = openState(key);
    rows.push(
      `<details class="trace-row tool${animClass(key)}" data-status="${status}"${rowAttrs(key, rows.length, stateForKey)}>` +
        `<summary>` +
          `<span class="trace-chevron">▸</span>` +
          `<span class="trace-glyph">${glyph}</span>` +
          `<span class="trace-cmd">${window.aimashiMarkdown.escapeHtml(name)}</span>` +
          (previewInline ? `<span class="trace-arg">${window.aimashiMarkdown.escapeHtml(previewInline)}</span>` : "") +
          (meta ? `<span class="trace-meta">${window.aimashiMarkdown.escapeHtml(meta)}</span>` : "") +
        `</summary>` +
        (preview ? `<pre class="trace-body">${window.aimashiMarkdown.escapeHtml(preview)}</pre>` : "") +
      `</details>`
    );
  }
  return `<div class="trace">${rows.join("")}</div>`;
}


function renderMessageHtml(message, ctx) {
  // ctx = {
  //   messageIndex: number,
  //   user: { displayName, avatarText, avatarImage, avatarCrop, avatarColor },
  //   persona: { name, key, color, avatarImage, avatarCrop } | null,
  //   showTaskAffordance: boolean,
  // }
  // Returns: string of <article>...</article> HTML
  const { messageIndex, user, persona } = ctx;
  const taskMeta = (ctx.showTaskAffordance && message?.meta?.taskId)
    ? (state.tasks || []).find((t) => t.id === message.meta.taskId)
    : null;
  const firedAt = message?.meta?.firedAt || message?.createdAt || Date.now();
  const taskAffordanceHtml = taskMeta
    ? `<div class="task-fire-affordance">
         <span class="task-fire-icon">📅</span>
         来自定时任务「${window.aimashiMarkdown.escapeHtml(taskMeta.title)}」 ·
         ${window.aimashiMarkdown.escapeHtml(formatRunTime(typeof firedAt === "string" ? new Date(firedAt).getTime() : firedAt))} ·
         <button class="link" type="button" data-jump-task="${window.aimashiMarkdown.escapeHtml(taskMeta.id)}">打开任务</button>
       </div>`
    : "";
  const label = message.role === "user" ? (user.avatarText || window.aimashiAvatar.initials(user.displayName)) : window.aimashiAvatar.initials(persona?.name || "A");
  const color = message.role === "user" ? user.avatarColor : (persona?.color || "#23444d");
  const fellowAvatarImage = persona?.avatarImage || window.aimashiAvatar.avatarAssetForKey(persona?.key);
  const fellowAvatar = window.aimashiAvatar.avatarImageSrc(fellowAvatarImage);
  const userAvatarImage = user.avatarImage || "";
  const userAvatar = window.aimashiAvatar.avatarImageSrc(userAvatarImage);
  const avatarBackgroundColor = message.role === "assistant"
    ? (fellowAvatar ? "transparent" : (color || "#111827"))
    : (userAvatar ? "transparent" : (color || "#111827"));
  const imageStyle = message.role === "assistant"
    ? window.aimashiAvatar.avatarThumbBackgroundStyle(fellowAvatarImage, persona?.avatarCrop, color)
    : (userAvatar ? window.aimashiAvatar.avatarThumbBackgroundStyle(userAvatarImage, user.avatarCrop, color) : "");
  const traceHtml = message.role === "assistant"
    ? renderTraceBlocks({
      reasoning: message.reasoning,
      tools: message.tools,
      content: message.content,
      expanded: false,
      scopeKey: `msg:${message.createdAt || ""}`
    })
    : "";
  const timeHtml = renderMessageTime(message.createdAt);
  const bodyHtml = String(message.content || "").trim() ? window.aimashiMarkdown.renderMarkdown(message.content) : "";
  const replyHtml = replyQuoteHtml(message.replyTo);
  const translation = window.aimashiMessageMenu?.translationHtml(message, messageIndex) || "";
  const attachmentHtml = renderAttachmentChips([...(message.attachments || []), ...generatedAttachmentsForMessage(message)].map(hydrateAttachmentPreview));
  const pinnedHtml = message.pinned ? `<span class="message-pin-badge">${ICON_PARK_PIN_SVG}置顶</span>` : "";
  const roleClass = message.role === "user" ? "user" : "assistant";
  return `<article class="message ${roleClass}">
      <div class="avatar" style="background-color:${window.aimashiMarkdown.escapeHtml(avatarBackgroundColor)};${imageStyle}">${message.role === "user" && !userAvatar ? window.aimashiMarkdown.escapeHtml(label) : ""}</div>
      <div class="message-stack">${taskAffordanceHtml}${traceHtml}<div class="bubble${message.pinned ? " pinned" : ""}" data-message-index="${messageIndex}">${pinnedHtml}${replyHtml}${bodyHtml}${attachmentHtml}${translation}</div>${timeHtml}</div>
    </article>`;
}

function renderChat() {
  // Branch: if a group is active, delegate to group module
  const groupActive = activeGroup();
  if (groupActive) {
    if (window.aimashiGroup && typeof window.aimashiGroup.renderActiveGroup === "function") {
      window.aimashiGroup.renderActiveGroup(groupActive);
    }
    return;
  }
  const wasNearBottom = !els.chat || (els.chat.scrollHeight - els.chat.scrollTop - els.chat.clientHeight < 80);
  const session = activeSession();
  const messages = session.messages;
  queueGeneratedFileFetches(messages);
  const user = state.runtime?.user || { displayName: "Boss", avatarText: "B", avatarColor: "#111827" };
  const active = activePersona();
  const activeAgentEngine = active?.agentEngine || active?.agent_engine || "hermes";
  const usesHermes = !["claude-code", "codex"].includes(activeAgentEngine);
  els.chat.innerHTML = "";
  if (window.aimashiSetupGuide?.shouldShowSetupGuide({ messages })) {
    els.chat.insertAdjacentHTML("beforeend", window.aimashiSetupGuide.renderSetupGuide());
  }
  for (const [messageIndex, message] of messages.entries()) {
    const html = renderMessageHtml(message, {
      messageIndex,
      user,
      persona: active,
      showTaskAffordance: true
    });
    els.chat.insertAdjacentHTML("beforeend", html);
  }
  const s = state.streaming;
  const hasStreamingContent = s && (
    s.text ||
    s.tools.length ||
    traceReasoningForDisplay(s.reasoning, s.tools, s.text)
  );
  if (s && s.sessionId === session.id && hasStreamingContent) {
    const article = document.createElement("article");
    article.className = "message assistant streaming";
    const personaForStream = active;
    const fellowAvatarImage = personaForStream?.avatarImage || window.aimashiAvatar.avatarAssetForKey(personaForStream?.key);
    const fellowAvatar = window.aimashiAvatar.avatarImageSrc(fellowAvatarImage);
    const avatarBackgroundColor = fellowAvatar ? "transparent" : (personaForStream?.color || "#23444d");
    const imageStyle = window.aimashiAvatar.avatarThumbBackgroundStyle(fellowAvatarImage, personaForStream?.avatarCrop, personaForStream?.color);
    const traceHtml = renderTraceBlocks({
      reasoning: s.reasoning,
      tools: s.tools,
      content: s.text,
      expanded: true,
      scopeKey: `run:${s.runId || ""}`
    });
    const textHtml = s.text ? `<div class="bubble">${window.aimashiMarkdown.renderMarkdown(s.text)}</div>${renderMessageTime(s.createdAt)}` : "";
    article.innerHTML = `
      <div class="avatar" style="background-color:${window.aimashiMarkdown.escapeHtml(avatarBackgroundColor)};${imageStyle}"></div>
      <div class="message-stack">${traceHtml}${textHtml}</div>
    `;
    els.chat.appendChild(article);
  }
  if (state.forceScrollToBottom || wasNearBottom) {
    els.chat.scrollTop = els.chat.scrollHeight;
  }
  state.forceScrollToBottom = false;
  for (const node of els.chat.querySelectorAll("details.trace-row[data-trace-key]")) {
    const key = node.dataset.traceKey;
    if (key) state.animatedTraceKeys.add(key);
  }
}

function activePersona() {
  const personas = state.runtime?.fellows || state.runtime?.personas || [];
  return personas.find((persona) => persona.key === state.activeKey) || personas[0];
}

// ── Group helpers ─────────────────────────────────────────────────────────────
function listGroups() {
  if (!window.aimashiGroup || !window.aimashiGroup.moduleState) return [];
  return window.aimashiGroup.moduleState.groups || [];
}

function activeGroup() {
  const groups = listGroups();
  return groups.find((g) => g.id === state.activeKey) || null;
}

function groupMessagesForPreview(group) {
  return window.aimashiGroup?.moduleState?.messagesByGroup?.get?.(group.id) || [];
}

function groupLastPreviewMessage(group) {
  const messages = groupMessagesForPreview(group);
  const primary = [...messages].reverse().find((message) => (
    (message.role === "user" || message.role === "fellow") &&
    String(message.content || "").trim() &&
    message.status !== "streaming"
  ));
  if (primary) return primary;
  return [...messages].reverse().find((message) => String(message.content || "").trim() && message.status !== "streaming") || null;
}

function groupConversationUpdatedAt(group) {
  const last = groupLastPreviewMessage(group);
  return last?.createdAt || group.updatedAt || group.createdAt || "";
}

function groupMessageSpeaker(message, fellows = []) {
  if (message?.role === "user") return state.runtime?.user?.displayName || "你";
  if (message?.role === "fellow") {
    const fellowId = message.senderFellowId || "";
    const fellow = fellows.find((item) => (item.id || item.key) === fellowId);
    return fellow?.name || fellowId || "伙伴";
  }
  return "系统";
}

function groupConversationPreview(group, fellows = []) {
  const last = groupLastPreviewMessage(group);
  if (!last) {
    return {
      text: "暂无消息",
      time: formatConversationTime(group.updatedAt || group.createdAt)
    };
  }
  const speaker = groupMessageSpeaker(last, fellows);
  const content = String(last.content || "").replace(/\s+/g, " ").trim();
  return {
    text: `${speaker}：${content}`,
    time: formatConversationTime(last.createdAt || group.updatedAt || group.createdAt)
  };
}

function appendChat(role, content, options = {}) {
  const session = activeSession();
  const message = { role, content, createdAt: nowIso(), transient: Boolean(options.transient) };
  if (options.replyTo?.content) {
    message.replyTo = {
      role: String(options.replyTo.role || ""),
      author: String(options.replyTo.author || ""),
      content: String(options.replyTo.content || ""),
      createdAt: String(options.replyTo.createdAt || ""),
      messageIndex: Number.isInteger(options.replyTo.messageIndex) ? options.replyTo.messageIndex : -1
    };
  }
  if (options.translation?.status || options.translation?.text) {
    message.translation = {
      status: String(options.translation.status || ""),
      text: String(options.translation.text || ""),
      error: String(options.translation.error || ""),
      translatedAt: String(options.translation.translatedAt || "")
    };
  }
  if (Array.isArray(options.attachments) && options.attachments.length) {
    message.attachments = options.attachments.map((attachment) => ({
      id: String(attachment.id || cryptoRandomId()),
      name: String(attachment.name || "附件"),
      path: String(attachment.path || ""),
      mime: String(attachment.mime || attachment.type || ""),
      size: Number(attachment.size) || 0,
      kind: String(attachment.kind || window.aimashiFormat.attachmentKind(attachment)),
      thumbnailDataUrl: String(attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || ""),
      dataUrl: String(attachment.dataUrl || "")
    }));
  }
  if (Array.isArray(options.tools) && options.tools.length) {
    message.tools = options.tools.map((tool) => ({
      id: String(tool.id || ""),
      name: String(tool.name || ""),
      preview: String(tool.preview || ""),
      status: tool.status || "completed",
      duration: typeof tool.duration === "number" ? tool.duration : null,
      error: Boolean(tool.error)
    }));
  }
  const reasoning = traceReasoningForDisplay(options.reasoning, message.tools, content);
  if (reasoning) message.reasoning = reasoning;
  session.messages.push(message);
  session.updatedAt = nowIso();
  const shouldMarkRead = role === "assistant" && !message.transient;
  if (shouldMarkRead) window.aimashiSessionReadState.markPersonaRead(session.personaKey || state.activeKey, false);
  state.forceScrollToBottom = true;
  renderChat();
  renderSessionMenu();
  if (options.persist) {
    persistSessionQuietly(session).then(() => {
      if (shouldMarkRead) window.aimashiSessionReadState.persistReadStateQuietly();
    });
  } else if (shouldMarkRead) {
    window.aimashiSessionReadState.persistReadStateQuietly();
  }
  return message;
}

function appendTransientChat(role, content) {
  const session = activeSession();
  session.messages.push({ role, content, createdAt: nowIso(), transient: true });
  session.updatedAt = nowIso();
  state.forceScrollToBottom = true;
  renderChat();
  renderSessionMenu();
}

function filteredSlashCommands() {
  const filter = state.slashFilter.replace(/^\//, "").trim().toLowerCase();
  const engine = window.aimashiEngineOptions.activeAgentEngine();
  const commands = engine === "claude-code" || engine === "codex"
    ? (state.agentSlashCommands[engine] || [])
    : (state.slashCommands || fallbackSlashCommands);
  if (!filter) return commands;
  return commands.filter((item) => `${item.command} ${item.description}`.toLowerCase().includes(filter));
}

function externalSlashInvocation(text) {
  const input = String(text || "").trim();
  const command = input.split(/\s+/)[0]?.toLowerCase() || "";
  if (!command.startsWith("/")) return null;
  const argsText = input.slice(command.length).trim();
  const args = argsText ? argsText.split(/\s+/).filter(Boolean) : [];
  const engine = window.aimashiEngineOptions.activeAgentEngine();
  if (engine !== "claude-code" && engine !== "codex") return null;
  const found = (state.agentSlashCommands[engine] || []).find((item) => String(item.command || "").toLowerCase() === command);
  return found ? { engine, command, args, item: found } : null;
}

async function outgoingMessageForSubmit(text) {
  const invocation = externalSlashInvocation(text);
  if (!invocation || invocation.item.type !== "custom") return text;
  const result = await window.aimashi.executeAgentCommand?.({
    engine: invocation.engine,
    commandName: invocation.command,
    commandPath: invocation.item.path,
    args: invocation.args,
    context: { sessionId: activeSession()?.id || "" }
  });
  if (result?.type !== "custom" || !String(result.content || "").trim()) return text;
  return String(result.content || "").trim();
}

function updateSlashCommandState() {
  const value = els.chatInput.value;
  const cursor = els.chatInput.selectionStart || 0;
  const before = value.slice(0, cursor);
  const line = before.split(/\n/).pop() || "";
  const shouldOpen = /^\/[A-Za-z0-9_/-]*$/.test(line);
  state.slashMenuOpen = shouldOpen;
  state.slashFilter = shouldOpen ? line : "";
  if (shouldOpen && state.slashFilter.length <= 1) state.slashSelectedIndex = 0;
  const commands = filteredSlashCommands();
  if (state.slashSelectedIndex >= commands.length) state.slashSelectedIndex = Math.max(0, commands.length - 1);
  renderSlashCommandMenu();
}

function renderSlashCommandMenu() {
  if (!els.slashCommandMenu) return;
  const commands = filteredSlashCommands();
  els.slashCommandMenu.classList.toggle("hidden", !state.slashMenuOpen);
  if (!state.slashMenuOpen) {
    els.slashCommandMenu.innerHTML = "";
    return;
  }
  if (!commands.length) {
    els.slashCommandMenu.innerHTML = `<div class="slash-command-empty">没有匹配的命令</div>`;
    return;
  }
  els.slashCommandMenu.innerHTML = commands.map((item, index) => `
    <button type="button" class="slash-command-item${index === state.slashSelectedIndex ? " active" : ""}" data-command="${window.aimashiMarkdown.escapeHtml(item.command)}">
      <span class="slash-command-token">${window.aimashiMarkdown.escapeHtml(item.command)}</span>
      <span class="slash-command-description">${window.aimashiMarkdown.escapeHtml(item.description)}</span>
    </button>
  `).join("");
  els.slashCommandMenu.querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const command = commands.find((item) => item.command === button.dataset.command);
      if (command) sendSlashCommand(command);
    });
  });
}

function renderComposerAddMenu() {
  els.composerAddMenu?.classList.toggle("hidden", !state.composerAddMenuOpen);
  els.composerAdd?.classList.toggle("active", state.composerAddMenuOpen);
  if (!els.composerAddMenu) return;
  els.composerAddMenu.innerHTML = `
    <button type="button" data-composer-add="attachment">添加附件</button>
    <button type="button" data-composer-add="skill">插件 / 技能</button>
  `;
}

function renderComposerAttachments() {
  if (!els.composerAttachments) return;
  const attachments = state.pendingAttachments;
  els.composerAttachments.classList.toggle("hidden", attachments.length === 0);
  els.composerAttachments.innerHTML = attachments.map((attachment) => `
    <div class="composer-attachment${attachment.thumbnailDataUrl ? " image" : ""}" title="${window.aimashiMarkdown.escapeHtml(attachment.path || attachment.name)}">
      <span class="composer-attachment-kind">${renderAttachmentThumb(attachment, "composer-attachment-thumb")}</span>
      <span class="composer-attachment-name">${window.aimashiMarkdown.escapeHtml(attachment.name || "附件")}</span>
      <span class="composer-attachment-size">${window.aimashiMarkdown.escapeHtml(window.aimashiFormat.formatBytes(attachment.size))}</span>
      <button type="button" data-attachment-remove="${window.aimashiMarkdown.escapeHtml(attachment.id)}" title="移除附件" aria-label="移除附件">×</button>
    </div>
  `).join("");
  els.composerAttachments.querySelectorAll("[data-attachment-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      state.pendingAttachments = state.pendingAttachments.filter((item) => item.id !== button.dataset.attachmentRemove);
      renderComposerAttachments();
      renderSendButton();
      els.chatInput?.focus();
    });
  });
}

function closeComposerAddMenu() {
  if (!state.composerAddMenuOpen) return;
  state.composerAddMenuOpen = false;
  renderComposerAddMenu();
}

function composerSkillMenuItem() {
  return els.composerAddMenu?.querySelector('[data-composer-add="skill"]') || null;
}

function targetIsSkillPickerZone(target) {
  if (!(target instanceof Node)) return false;
  return Boolean(els.skillPicker?.contains(target) || composerSkillMenuItem()?.contains(target));
}

function cancelSkillPickerHoverClose() {
  if (!skillPickerHoverCloseTimer) return;
  clearTimeout(skillPickerHoverCloseTimer);
  skillPickerHoverCloseTimer = 0;
}

function scheduleSkillPickerHoverClose() {
  cancelSkillPickerHoverClose();
  skillPickerHoverCloseTimer = window.setTimeout(() => {
    skillPickerHoverCloseTimer = 0;
    closeSkillPicker();
  }, 120);
}

function openSkillPicker() {
  cancelSkillPickerHoverClose();
  if (!state.skillLibrary.skills?.length && !state.skillsLoading) {
    loadSkills();
  }
  state.skillPickerOpen = true;
  state.skillPickerFilter = "";
  const firstPlugin = (state.skillLibrary.plugins || []).find((plugin) => plugin.skillCount > 0);
  if (!state.skillPickerPluginId && firstPlugin) state.skillPickerPluginId = firstPlugin.id;
  if (els.skillPickerSearch) els.skillPickerSearch.value = "";
  renderSkillPicker();
  setTimeout(() => els.skillPickerSearch?.focus(), 0);
}

function closeSkillPicker() {
  cancelSkillPickerHoverClose();
  if (!state.skillPickerOpen) return;
  state.skillPickerOpen = false;
  renderSkillPicker();
}

function renderSkillPicker() {
  if (!els.skillPicker) return;
  els.skillPicker.classList.toggle("hidden", !state.skillPickerOpen);
  if (!state.skillPickerOpen || !els.skillPickerBody) return;
  const needle = String(state.skillPickerFilter || "").trim().toLowerCase();
  const skills = state.skillLibrary.skills || [];
  const plugins = (state.skillLibrary.plugins || []).filter((plugin) => plugin.skillCount > 0);
  if (!state.skillPickerPluginId && plugins.length) state.skillPickerPluginId = plugins[0].id;
  if (state.skillPickerPluginId && plugins.length && !plugins.some((plugin) => plugin.id === state.skillPickerPluginId)) {
    state.skillPickerPluginId = plugins[0].id;
  }
  const filtered = needle
    ? skills.filter((skill) => {
        const hay = [
          skill.name,
          skill.title,
          skill.description,
          skill.pluginLabel,
          skill.category,
          ...(skill.tags || [])
        ].join(" ").toLowerCase();
        return hay.includes(needle);
      })
    : skills.filter((skill) => !state.skillPickerPluginId || skill.pluginId === state.skillPickerPluginId);
  if (!filtered.length && !plugins.length) {
    els.skillPickerBody.innerHTML = `<div class="skill-picker-empty">${state.skillsLoading ? "正在加载…" : "没有匹配的 Skill"}</div>`;
    return;
  }
  const pluginCounts = skills.reduce((acc, skill) => {
    const pluginId = skill.pluginId || "_other";
    acc[pluginId] = (acc[pluginId] || 0) + 1;
    return acc;
  }, {});
  const currentPlugin = plugins.find((plugin) => plugin.id === state.skillPickerPluginId);
  els.skillPickerBody.innerHTML = `
    <aside class="skill-picker-plugins">
      ${plugins.map((plugin) => `
        <button class="${plugin.id === state.skillPickerPluginId ? "active" : ""}" type="button" data-skill-picker-plugin="${window.aimashiMarkdown.escapeHtml(plugin.id)}">
          <span>${window.aimashiMarkdown.escapeHtml(plugin.label || plugin.name)}</span>
          <em>${pluginCounts[plugin.id] || plugin.skillCount || 0}</em>
        </button>
      `).join("")}
    </aside>
    <section class="skill-picker-skills">
      <header>
        <span>${window.aimashiMarkdown.escapeHtml(needle ? "搜索结果" : (currentPlugin?.label || "Skills"))}</span>
        <em>${filtered.length}</em>
      </header>
      <div class="skill-picker-list">
        ${filtered.length ? filtered.map((skill) => `
          <button class="skill-picker-item" type="button" data-skill-pick="${window.aimashiMarkdown.escapeHtml(skill.name)}">
            <strong>${window.aimashiMarkdown.escapeHtml(skill.name)}</strong>
            <small>${window.aimashiMarkdown.escapeHtml((skill.description || window.aimashiSkillHelpers.skillSummaryZh(skill) || "").slice(0, 108))}</small>
          </button>
        `).join("") : `<div class="skill-picker-empty">${state.skillsLoading ? "正在加载…" : "没有匹配的 Skill"}</div>`}
      </div>
    </section>
  `;
}

function insertSkillIntoComposer(name) {
  if (!els.chatInput) return;
  const trigger = `/${name} `;
  const current = els.chatInput.value || "";
  els.chatInput.value = current.trim().startsWith("/")
    ? current.replace(/^\s*\/[A-Za-z0-9_/-]+(?:\s+)?/, trigger)
    : `${trigger}${current}`;
  els.chatInput.focus();
  resizeChatInput();
  renderSendButton();
}

async function addComposerFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;
  const existing = new Set(state.pendingAttachments.map((item) => item.path || `${item.name}:${item.size}`));
  const next = [];
  for (const file of files.slice(0, 20)) {
    let filePath = "";
    let saved = null;
    let thumbnailDataUrl = "";
    try {
      thumbnailDataUrl = await thumbnailDataUrlForFile(file);
      filePath = await window.aimashi.filePathForFile?.(file);
      if (!filePath) {
        saved = await saveBrowserFileAttachment(file, thumbnailDataUrl);
        filePath = saved?.path || "";
      }
      if (!filePath && !saved) continue;
    } catch (error) {
      appendTransientChat("assistant", `附件「${file.name || "未命名"}」读取失败: ${error.message}`);
      continue;
    }
    const key = filePath || `${file.name}:${file.size}`;
    if (existing.has(key)) continue;
    existing.add(key);
    next.push({
      id: saved?.id || cryptoRandomId(),
      name: saved?.name || file.name || (filePath ? filePath.split(/[\\/]/).pop() : "附件"),
      path: filePath || "",
      mime: saved?.mime || file.type || "",
      size: saved?.size || file.size || 0,
      kind: saved?.kind || window.aimashiFormat.attachmentKind(file),
      thumbnailDataUrl: saved?.thumbnailDataUrl || thumbnailDataUrl || ""
    });
  }
  if (!next.length) return;
  state.pendingAttachments = [...state.pendingAttachments, ...next].slice(0, 20);
  renderComposerAttachments();
  renderSendButton();
  els.chatInput?.focus();
}

function thumbnailDataUrlForFile(file) {
  if (!file || !String(file.type || "").startsWith("image/")) return Promise.resolve("");
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const max = 180;
        const scale = Math.min(1, max / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
        const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
        const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      } catch {
        resolve("");
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve("");
    };
    image.src = url;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error || new Error("读取附件失败")));
    reader.readAsDataURL(file);
  });
}

async function saveBrowserFileAttachment(file, thumbnailDataUrl = "") {
  if (!file) return null;
  if (file.size > 25 * 1024 * 1024) {
    appendTransientChat("assistant", `附件「${file.name || "未命名"}」超过 25MB，暂时不能发送。`);
    return null;
  }
  const dataUrl = await readFileAsDataUrl(file);
  return window.aimashi.saveAttachment?.({
    name: file.name || "attachment",
    mime: file.type || "",
    size: file.size || 0,
    dataUrl,
    thumbnailDataUrl
  });
}

function commandTextForSend(command) {
  return String(command.command || "").trim();
}

async function sendSlashCommand(command) {
  const text = commandTextForSend(command);
  if (!text) return;
  els.chatInput.value = text;
  resizeChatInput();
  state.slashMenuOpen = false;
  state.slashFilter = "";
  renderSlashCommandMenu();
  els.chatForm.requestSubmit();
}

function fillSlashCommand(command) {
  const value = els.chatInput.value;
  const cursor = els.chatInput.selectionStart || 0;
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  const lineStart = before.lastIndexOf("\n") + 1;
  els.chatInput.value = `${value.slice(0, lineStart)}${command.command} ${after}`;
  const next = lineStart + command.command.length + 1;
  els.chatInput.setSelectionRange(next, next);
  resizeChatInput();
  state.slashMenuOpen = false;
  renderSlashCommandMenu();
  els.chatInput.focus();
}

async function createNewSessionForActive() {
  pruneEmptyDrafts(state.activeKey);
  state.chatStore = await window.aimashi.createChatSession({ personaKey: state.activeKey });
  const latest = sessionsForPersona(state.activeKey)[0];
  state.activeSessionIdByPersona[state.activeKey] = latest?.id;
  state.sessionMenuOpen = false;
  state.replyDraft = null;
  state.forceScrollToBottom = true;
  render();
}

async function refreshRuntime() {
  const previousDaemon = state.runtime?.daemon || {};
  const runtime = await window.aimashi.runtimeStatus();
  if (runtime?.daemon && Array.isArray(previousDaemon.links) && previousDaemon.links.length && !Array.isArray(runtime.daemon.links)) {
    runtime.daemon = {
      ...runtime.daemon,
      links: previousDaemon.links
    };
  }
  state.runtime = runtime;
  state.petJobs = state.runtime?.petJobs || state.petJobs;
  render();
}

async function initializeRuntime() {
  const runtime = await trackStartupTask("初始化 runtime", () => window.aimashi.initializeRuntime());
  state.firstRun = Array.isArray(runtime?.created) && runtime.created.length > 0;
  state.runtime = runtime;
  // Initialize extracted renderer modules BEFORE any subsequent trackStartupTask
  // call, because trackStartupTask itself triggers render() at start and finish;
  // once state.runtime is set, render() no longer early-returns and will call
  // into window.aimashi*.{applyAppearance,renderXxx} — which need fontPresets /
  // state / els / etc. to already be injected.
  // NOTE: group init is intentionally LAST. Its initGroupModule(...) calls
  // deps.triggerRender() during init, which calls render(), which calls
  // applyAppearance() — that lives in window.aimashiSettingsAppearance and
  // needs fontPresets / state / els injected first. If group init runs before
  // settings-appearance init, fontPresets is undefined and render() throws
  // "Cannot read properties of undefined (reading 'pingfang')".
  if (window.aimashiSessionReadState && window.aimashiSessionReadState.initSessionReadState) {
    window.aimashiSessionReadState.initSessionReadState({
      state,
      aimashi: window.aimashi,
      nowIso,
    });
  }
  if (window.aimashiSettingsRemote && window.aimashiSettingsRemote.initSettingsRemote) {
    window.aimashiSettingsRemote.initSettingsRemote({
      state,
      els,
      setText,
      renderQr,
    });
  }
  if (window.aimashiSkillHelpers && window.aimashiSkillHelpers.initSkillHelpers) {
    window.aimashiSkillHelpers.initSkillHelpers({ escapeHtml: window.aimashiMarkdown.escapeHtml });
  }
  if (window.aimashiAvatar && window.aimashiAvatar.initAvatarHelpers) {
    window.aimashiAvatar.initAvatarHelpers({ escapeHtml: window.aimashiMarkdown.escapeHtml });
  }
  if (window.aimashiModelHelpers && window.aimashiModelHelpers.initModelHelpers) {
    window.aimashiModelHelpers.initModelHelpers({
      state,
      els,
      providerLabels,
      providerPresets,
    });
  }
  if (window.aimashiEngineOptions && window.aimashiEngineOptions.initEngineOptions) {
    window.aimashiEngineOptions.initEngineOptions({
      state,
      els,
      activePersona,
      APPROVAL_LABELS,
      APPROVAL_TITLES,
      EFFORT_LABELS,
    });
  }
  if (window.aimashiSetupGuide && window.aimashiSetupGuide.initSetupGuide) {
    window.aimashiSetupGuide.initSetupGuide({ state, escapeHtml: window.aimashiMarkdown.escapeHtml });
  }
  if (window.aimashiModelSettings && window.aimashiModelSettings.initModelSettings) {
    window.aimashiModelSettings.initModelSettings({
      state,
      els,
      escapeHtml: window.aimashiMarkdown.escapeHtml,
      setText,
      updateModelFieldVisibility,
      providerPresets,
      providerLabels,
    });
  }
  if (window.aimashiFellowManager && window.aimashiFellowManager.initFellowManager) {
    window.aimashiFellowManager.initFellowManager({
      state,
      els,
      setText,
      formatConversationTime,
      hasPersistableMessages,
      sessionsForPersona,
      loadSkills,
      showNarrowContent,
      render,
      closeGroupContextMenu,
      openEditFellowDialog,
      deleteFellow,
      setFellowPinned,
    });
  }
  if (window.aimashiSkillLibrary && window.aimashiSkillLibrary.initSkillLibrary) {
    window.aimashiSkillLibrary.initSkillLibrary({
      state,
      els,
      aimashi: window.aimashi,
      escapeHtml: window.aimashiMarkdown.escapeHtml,
      setText,
      menuItemHtml: window.aimashiMarkdown.menuItemHtml,
      syncTopbarClickCapture,
      closeGroupContextMenu,
      showNarrowContent,
      installExtension,
      deleteSkill,
      openSkillDirectory,
    });
  }
  if (window.aimashiTasksPanel && window.aimashiTasksPanel.initTasksPanel) {
    window.aimashiTasksPanel.initTasksPanel({
      state,
      els,
      aimashi: window.aimashi,
      escapeHtml: window.aimashiMarkdown.escapeHtml,
      setText,
      formatRunTime,
      renderMessageHtml,
      render,
      renderView,
      renderChat,
    });
  }
  if (window.aimashiPetDialog && window.aimashiPetDialog.initPetDialog) {
    window.aimashiPetDialog.initPetDialog({
      state,
      els,
      aimashi: window.aimashi,
      fellowByKey: window.aimashiFellowManager.fellowByKey,
      avatarAssetForKey: window.aimashiAvatar.avatarAssetForKey,
      cryptoRandomId,
      avatarBackgroundStyle: window.aimashiAvatar.avatarBackgroundStyle,
      escapeHtml: window.aimashiMarkdown.escapeHtml,
      setText,
      renderView,
      refreshRuntime,
      appendTransientChat,
    });
  }
  if (window.aimashiSettingsAppearance && window.aimashiSettingsAppearance.initSettingsAppearance) {
    window.aimashiSettingsAppearance.initSettingsAppearance({
      state,
      els,
      aimashi: window.aimashi,
      fontPresets,
      DEFAULT_ACCENT_COLOR,
      DEFAULT_USER_BUBBLE_COLOR,
      DEFAULT_LIST_STYLE,
      DEFAULT_SELECTION_STYLE,
    });
  }
  if (window.aimashiMessageMenu && window.aimashiMessageMenu.initMessageMenu) {
    window.aimashiMessageMenu.initMessageMenu({
      state,
      els,
      aimashi: window.aimashi,
      messageAtIndex,
      messageReferenceForIndex,
      messageContextText,
      menuItemHtml: window.aimashiMarkdown.menuItemHtml,
      activeSession,
      persistSessionQuietly,
      replacePersistedSessionQuietly,
      renderChat,
      renderSessionMenu,
      renderComposerReply,
      escapeHtml: window.aimashiMarkdown.escapeHtml,
      renderMarkdown: window.aimashiMarkdown.renderMarkdown,
      copyTextToClipboard,
      nowIso,
      cryptoRandomId,
      closeSkillContextMenu: window.aimashiSkillLibrary.closeSkillContextMenu,
      closeFellowContextMenu: window.aimashiFellowManager.closeFellowContextMenu,
      closeGroupContextMenu,
    });
  }
  // Group init last — see comment above about triggerRender + settings-appearance.
  if (window.aimashiGroup && window.aimashiGroup.initGroupModule) {
    try {
      await window.aimashiGroup.initGroupModule({
        getFellows: () => {
          const list = Array.isArray(state.runtime && state.runtime.fellows) ? state.runtime.fellows
            : Array.isArray(state.runtime && state.runtime.personas) ? state.runtime.personas
            : [];
          return list.map((f) => ({ id: f.id || f.key, name: f.name || f.key, key: f.key, avatarImage: f.avatarImage, avatarCrop: f.avatarCrop, color: f.color }));
        },
        getRuntime: () => state.runtime,
        triggerRender: () => render(),
        openGroup: (groupId) => {
          state.activeKey = groupId;
          if (window.aimashiGroup) window.aimashiGroup.moduleState.activeGroupId = groupId;
          showNarrowContent();
          render();
        },
        engineCall: async ({ kind, prompt, group }) => {
          const hostFellowId = group && group.hostFellowId;
          if (!hostFellowId) throw new Error("no host fellow for group");
          const result = await window.aimashi.sendChatStateless({
            fellowKey: hostFellowId,
            systemPrompt: kind === "summarize"
              ? "你是群聊摘要器，无人设。"
              : "你是群聊调度器，无人设。",
            userPrompt: prompt,
          });
          return result && typeof result.content === "string" ? result.content : "";
        },
      });
    } catch (err) {
      console.error("[group] init bootstrap failed:", err);
    }
  }
  await trackStartupTask("加载会话", loadChatSessions);
  render();
  setTimeout(() => {
    Promise.allSettled([
      trackStartupTask("加载 Hermes 模型列表", loadModelCatalog),
      trackStartupTask("加载 Codex 模型列表", loadCodexModels),
      trackStartupTask("加载引擎能力", loadEngineCapabilities),
      trackStartupTask("加载命令列表", loadSlashCommands),
      trackStartupTask("扫描本地 Skill", loadSkills)
    ]).then(() => render());
  }, 800);
  window.aimashiTasksPanel.loadTasksFromDaemon().then(() => {
    window.aimashiTasksPanel.subscribeTaskEvents();
    if (state.activeView === "tasks") {
      window.aimashiTasksPanel.renderTaskSidebar();
      window.aimashiTasksPanel.renderTaskView();
    }
  });
}

// Group info button in topbar
document.getElementById("groupInfoButton")?.addEventListener("click", () => {
  const group = activeGroup();
  if (group && window.aimashiGroup && typeof window.aimashiGroup.openInfoDialog === "function") {
    window.aimashiGroup.openInfoDialog(group);
  }
});

els.openSettings.addEventListener("click", () => {
  state.settingsOpen = true;
  if (state.activeSettingsTab === "profile") state.activeSettingsTab = "appearance";
  renderView();
  if (state.activeSettingsTab === "mobile") {
    window.aimashiSettingsRemote.refreshDaemonPairing().catch(console.error);
    window.aimashiSettingsRemote.refreshRelayPairing().catch(console.error);
  }
});
els.closeSettings.addEventListener("click", () => {
  state.settingsOpen = false;
  renderView();
});
els.settingsView.addEventListener("click", (event) => {
  if (event.target === els.settingsView) {
    state.settingsOpen = false;
    renderView();
  }
});
els.closeSkillPreview?.addEventListener("click", () => {
  state.skillPreviewOpen = false;
  window.aimashiSkillLibrary.renderSkillPreview();
});
els.skillPreviewDialog?.addEventListener("click", (event) => {
  if (event.target === els.skillPreviewDialog) {
    state.skillPreviewOpen = false;
    window.aimashiSkillLibrary.renderSkillPreview();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeImagePreview();
  if (state.skillContextMenu.open) window.aimashiSkillLibrary.closeSkillContextMenu();
  if (state.fellowContextMenu.open) window.aimashiFellowManager.closeFellowContextMenu();
  if (state.groupContextMenu.open) closeGroupContextMenu();
  if (state.messageContextMenu.open) window.aimashiMessageMenu?.closeMessageContextMenu();
  closeComposerAddMenu();
  if (state.skillPreviewOpen) {
    state.skillPreviewOpen = false;
    window.aimashiSkillLibrary.renderSkillPreview();
  }
});
els.sessionMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  state.sessionMenuOpen = !state.sessionMenuOpen;
  renderSessionMenu();
});
document.addEventListener("click", (event) => {
  if (state.skillContextMenu.open && !els.skillContextMenu?.contains(event.target)) window.aimashiSkillLibrary.closeSkillContextMenu();
});
document.addEventListener("click", (event) => {
  if (state.fellowContextMenu.open && !els.fellowContextMenu?.contains(event.target)) window.aimashiFellowManager.closeFellowContextMenu();
});
document.addEventListener("click", (event) => {
  if (state.groupContextMenu.open && !els.groupContextMenu?.contains(event.target)) closeGroupContextMenu();
});
document.addEventListener("click", (event) => {
  if (state.messageContextMenu.open && !els.messageContextMenu?.contains(event.target)) window.aimashiMessageMenu?.closeMessageContextMenu();
});
els.chat?.addEventListener("contextmenu", (event) => {
  const bubble = event.target.closest(".bubble[data-message-index]");
  if (!bubble || !els.chat.contains(bubble)) return;
  const selection = window.aimashiMessageMenu?.selectionInsideBubble(bubble);
  event.preventDefault();
  event.stopPropagation();
  window.aimashiMessageMenu?.openMessageContextMenu(bubble.dataset.messageIndex, event.clientX, event.clientY, selection);
});
document.addEventListener("click", (event) => {
  if (!state.sessionMenuOpen) return;
  if (els.sessionMenu?.contains(event.target)) return;
  state.sessionMenuOpen = false;
  renderSessionMenu();
});
document.addEventListener("click", (event) => {
  if (!state.fellowMenuOpen) return;
  if (els.fellowCreateMenu?.contains(event.target) || els.newPersona?.contains(event.target)) return;
  state.fellowMenuOpen = false;
  renderView();
});
document.addEventListener("click", (event) => {
  if (!state.composerAddMenuOpen) return;
  if (els.composerAddMenu?.contains(event.target) || els.skillPicker?.contains(event.target) || els.composerAdd?.contains(event.target)) return;
  closeComposerAddMenu();
});
document.addEventListener("click", (event) => {
  if (!state.petJobPanelOpen) return;
  if (els.petJobPanel?.contains(event.target) || els.petJobButton?.contains(event.target)) return;
  state.petJobPanelOpen = false;
  window.aimashiPetDialog?.renderPetJobs();
});
els.newSession.addEventListener("click", async (event) => {
  event.stopPropagation();
  await createNewSessionForActive();
});
els.initialize.addEventListener("click", initializeRuntime);
els.personaSearch.addEventListener("input", () => {
  state.personaFilter = els.personaSearch.value;
  render();
});
els.contactSearch?.addEventListener("input", () => {
  state.contactFilter = els.contactSearch.value;
  window.aimashiFellowManager.renderContacts();
});
els.skillSearch?.addEventListener("input", () => {
  state.skillFilter = els.skillSearch.value;
  window.aimashiSkillLibrary.renderSkillLibrary();
});
els.taskSearch?.addEventListener("input", (e) => {
  state.taskFilter = e.target.value;
  window.aimashiTasksPanel?.renderTaskSidebar();
});
document.querySelectorAll("[data-skill-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.skillCategoryFilter = button.dataset.skillFilter || "";
    window.aimashiSkillLibrary.renderSkillLibrary();
  });
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    state.activeView = button.dataset.view;
    showNarrowContent();
    if (button.dataset.view === "settings") state.settingsOpen = true;
    if (button.dataset.view === "skills" && !state.skillLibrary.skills.length && !state.skillsLoading) loadSkills();
    renderView();
    if (state.activeView === "tasks") {
      window.aimashiTasksPanel?.loadTasksFromDaemon().then(() => {
        window.aimashiTasksPanel?.renderTaskSidebar();
        window.aimashiTasksPanel?.renderTaskView();
      });
    }
  });
});

els.narrowBackButtons?.forEach((button) => {
  button.addEventListener("click", () => {
    showNarrowSidebar();
    renderView();
  });
});

els.sidebarResizeHandle?.addEventListener("pointerdown", (event) => {
  if (window.innerWidth <= 720) return;
  event.preventDefault();
  state.sidebarResize = {
    dragging: true,
    startX: event.clientX,
    startWidth: state.sidebarWidth
  };
  document.body.classList.add("sidebar-resizing");
  els.sidebarResizeHandle.setPointerCapture?.(event.pointerId);
});

document.addEventListener("pointermove", (event) => {
  if (!state.sidebarResize.dragging) return;
  const delta = event.clientX - state.sidebarResize.startX;
  applySidebarWidth(state.sidebarResize.startWidth + delta);
});

function stopSidebarResize(event) {
  if (!state.sidebarResize.dragging) return;
  state.sidebarResize.dragging = false;
  document.body.classList.remove("sidebar-resizing");
  applySidebarWidth(state.sidebarWidth, true);
  if (event?.pointerId !== undefined) {
    els.sidebarResizeHandle?.releasePointerCapture?.(event.pointerId);
  }
}

document.addEventListener("pointerup", stopSidebarResize);
document.addEventListener("pointercancel", stopSidebarResize);
document.addEventListener("scroll", (event) => {
  window.aimashiScrollbarOverlay.showScrollingScrollbar(event.target);
}, { capture: true, passive: true });
document.addEventListener("pointermove", (event) => {
  window.aimashiScrollbarOverlay.updateScrollbarOverlayDrag(event);
  window.aimashiScrollbarOverlay.maybeShowScrollbarForPointer(event);
}, { capture: true });
document.addEventListener("pointerup", (event) => window.aimashiScrollbarOverlay.stopScrollbarOverlayDrag(event), { capture: true });
document.addEventListener("pointercancel", (event) => window.aimashiScrollbarOverlay.stopScrollbarOverlayDrag(event), { capture: true });
document.addEventListener("mouseover", (event) => {
  const target = event.target?.closest?.(".scrollbar-active");
  if (!target) return;
  window.aimashiScrollbarOverlay.cancelScrollbarHide(target);
  window.aimashiScrollbarOverlay.updateScrollbarOverlay(target);
  target.classList.add("scrollbar-visible");
}, { capture: true, passive: true });
document.addEventListener("mouseout", (event) => {
  const target = event.target?.closest?.(".scrollbar-active");
  if (!target || target.contains(event.relatedTarget)) return;
  window.aimashiScrollbarOverlay.scheduleScrollbarHide(target, 500);
}, { capture: true, passive: true });
window.addEventListener("resize", () => {
  const overlayTarget = window.aimashiScrollbarOverlay.getScrollbarOverlayTarget();
  if (overlayTarget) window.aimashiScrollbarOverlay.updateScrollbarOverlay(overlayTarget);
  const isNarrow = window.innerWidth <= 720;
  if (!state.isNarrowWindow && isNarrow) {
    state.narrowPane = "content";
  }
  state.isNarrowWindow = isNarrow;
  applySidebarWidth(state.sidebarWidth);
  syncNarrowLayout();
});

document.querySelectorAll("[data-settings-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    state.activeSettingsTab = button.dataset.settingsTab;
    renderView();
    if (state.activeSettingsTab === "mobile") {
      window.aimashiSettingsRemote.refreshDaemonPairing().catch(console.error);
      window.aimashiSettingsRemote.refreshRelayPairing().catch(console.error);
    }
  });
});

els.mobileLanToggle?.addEventListener("click", async () => {
  const enabled = els.mobileLanToggle.getAttribute("aria-checked") === "true";
  try {
    await window.aimashiSettingsRemote.applyDaemonHost(enabled ? "127.0.0.1" : "0.0.0.0");
  } catch (error) {
    setText(els.mobilePairingHint, `切换失败：${error.message}`);
  }
});

async function submitCloudLogin(mode) {
  const username = String(els.cloudUsername?.value || "").trim();
  const password = String(els.cloudPassword?.value || "");
  if (!username) {
    setText(els.cloudLoginHint, "请输入用户名。");
    els.cloudUsername?.focus();
    return;
  }
  if (password.length < 6) {
    setText(els.cloudLoginHint, "密码至少 6 位。");
    els.cloudPassword?.focus();
    return;
  }
  const buttons = [els.cloudLogin, els.cloudRegister].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; });
  setText(els.cloudLoginHint, mode === "register" ? "正在注册并连接..." : "正在登录并连接...");
  try {
    state.runtime = await window.aimashi.cloudLogin({ mode, username, password });
    if (els.cloudPassword) els.cloudPassword.value = "";
    render();
  } catch (error) {
    setText(els.cloudLoginHint, `连接失败：${error.message || error}`);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

els.cloudLogin?.addEventListener("click", () => submitCloudLogin("login"));
els.cloudRegister?.addEventListener("click", () => submitCloudLogin("register"));
els.cloudSync?.addEventListener("click", async () => {
  els.cloudSync.disabled = true;
  try {
    state.runtime = await window.aimashi.cloudSync();
    render();
  } catch (error) {
    setText(els.cloudLoginHint, `同步失败：${error.message || error}`);
  } finally {
    els.cloudSync.disabled = false;
  }
});
els.cloudLogout?.addEventListener("click", async () => {
  els.cloudLogout.disabled = true;
  try {
    state.runtime = await window.aimashi.cloudLogout();
    render();
  } catch (error) {
    setText(els.cloudLoginHint, `退出失败：${error.message || error}`);
  } finally {
    els.cloudLogout.disabled = false;
  }
});

els.mobilePairingReveal?.addEventListener("click", () => {
  state.mobileLanLinkExpanded = !state.mobileLanLinkExpanded;
  window.aimashiSettingsRemote.renderMobilePairing(state.runtime?.daemon || {});
});

els.mobilePairingLink?.addEventListener("click", async () => {
  const link = window.aimashiSettingsRemote.currentMobilePairingLink();
  if (!link) {
    setText(els.mobilePairingHint, "当前没有可复制的配对链接。");
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    setText(els.mobilePairingHint, "已复制。把链接发到手机浏览器打开即可。");
  } catch {
    setText(els.mobilePairingHint, "复制失败，可以长按链接文本手动复制。");
  }
});

els.mobileRelayReveal?.addEventListener("click", () => {
  state.mobileRelayLinkExpanded = !state.mobileRelayLinkExpanded;
  window.aimashiSettingsRemote.renderRelayPairing(state.runtime?.relay || {});
});

els.mobileRelayToggle?.addEventListener("click", async () => {
  const enabled = Boolean(state.runtime?.relay?.enabled);
  setText(els.mobileRelayHint, enabled ? "正在关闭远程访问..." : "正在连接 relay...");
  try {
    const relayUrl = String(els.mobileRelayUrl?.value || "").trim();
    if (relayUrl && window.aimashi.saveRelaySettings) {
      await window.aimashi.saveRelaySettings({ url: relayUrl, enabled });
    }
    const relay = enabled
      ? await window.aimashi.stopRelay()
      : await window.aimashi.startRelay();
    state.runtime = {
      ...(state.runtime || {}),
      relay: {
        ...relay,
        secret: undefined
      }
    };
    window.aimashiSettingsRemote.renderRelayPairing(relay);
  } catch (error) {
    setText(els.mobileRelayHint, `远程访问切换失败：${error.message}`);
    await refreshRuntime();
  }
});

async function saveRelayUrlFromField() {
  const url = String(els.mobileRelayUrl?.value || "").trim();
  if (!url || !window.aimashi?.saveRelaySettings) return;
  setText(els.mobileRelayHint, "正在保存 Relay 地址...");
  try {
    const relay = await window.aimashi.saveRelaySettings({
      url,
      enabled: Boolean(state.runtime?.relay?.enabled)
    });
    state.runtime = {
      ...(state.runtime || {}),
      relay: {
        ...relay,
        secret: undefined
      }
    };
    window.aimashiSettingsRemote.renderRelayPairing(relay);
  } catch (error) {
    setText(els.mobileRelayHint, `Relay 地址保存失败：${error.message}`);
  }
}

els.mobileRelayUrl?.addEventListener("change", saveRelayUrlFromField);
els.mobileRelayUrl?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  els.mobileRelayUrl?.blur();
  saveRelayUrlFromField();
});

els.mobileRelayLink?.addEventListener("click", async () => {
  const link = window.aimashiSettingsRemote.currentRelayPairingLink();
  if (!link) {
    setText(els.mobileRelayHint, "当前没有可复制的远程配对链接。");
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    setText(els.mobileRelayHint, "已复制远程配对链接。手机和电脑不需要在同一网络。");
  } catch {
    setText(els.mobileRelayHint, "复制失败，可以长按链接文本手动复制。");
  }
});

if (els.engineRowHermesButton && els.modelForm) {
  els.engineRowHermesButton.addEventListener("click", () => {
    const expanded = els.engineRowHermesButton.getAttribute("aria-expanded") === "true";
    const next = !expanded;
    els.engineRowHermesButton.setAttribute("aria-expanded", next ? "true" : "false");
    els.modelForm.classList.toggle("hidden", !next);
  });
}

if (els.uninstallEngine) {
  els.uninstallEngine.addEventListener("click", async () => {
    if (!window.confirm("将卸载 Aimashi 独立 Hermes 副本（launchd plist + runtime 目录），系统 Hermes 不受影响。确认？")) return;
    els.uninstallEngine.disabled = true;
    const label = els.uninstallEngine.textContent;
    els.uninstallEngine.textContent = "卸载中…";
    try {
      state.runtime = await window.aimashi.uninstallStandaloneEngine();
      render();
    } catch (error) {
      window.alert(`卸载失败：${error.message || error}`);
    } finally {
      els.uninstallEngine.disabled = false;
      els.uninstallEngine.textContent = label;
    }
  });
}

if (window.aimashi.onEnginesChanged) {
  window.aimashi.onEnginesChanged(() => { refreshRuntime().catch(() => {}); });
}

if (window.aimashi.onCloudEvent) {
  let cloudEventRefreshTimer = 0;
  window.aimashi.onCloudEvent((envelope = {}) => {
    if (envelope.cloud && state.runtime) {
      state.runtime = {
        ...state.runtime,
        cloud: envelope.cloud
      };
      window.aimashiSettingsRemote.renderCloudAccount(envelope.cloud);
    }
    // Refresh runtime metadata (cloud connection / device list) only.
    // We intentionally do NOT reload chatStore here — that races with
    // unpersisted in-memory messages the user just sent, causing them to
    // disappear/reappear. Cross-device chat sync needs incremental
    // application of cloud message events; until that exists the local
    // device sees its own messages immediately and remote-device messages
    // on the next manual reload.
    clearTimeout(cloudEventRefreshTimer);
    cloudEventRefreshTimer = setTimeout(() => {
      refreshRuntime().catch((error) => {
        console.error("Failed to refresh runtime after Cloud event", error);
      });
    }, envelope.type === "events_ready" ? 500 : 120);
  });
}

els.installEngine.addEventListener("click", async () => {
  els.installEngine.disabled = true;
  els.installEngine.textContent = "Installing...";
  try {
    state.runtime = await window.aimashi.installEngine();
    await loadModelCatalog();
    render();
  } catch (error) {
    appendChat("assistant", `Install failed: ${error.message}`);
  } finally {
    els.installEngine.disabled = false;
    els.installEngine.textContent = "Install Engine";
  }
});
els.startEngine.addEventListener("click", async () => {
  els.startEngine.disabled = true;
  els.startEngine.textContent = "Starting...";
  try {
    state.runtime = await window.aimashi.startEngine();
    render();
  } catch (error) {
    appendChat("assistant", `Start failed: ${error.message}`);
    await refreshRuntime();
  } finally {
    els.startEngine.disabled = false;
    els.startEngine.textContent = "Start";
  }
});
els.stopEngine.addEventListener("click", async () => {
  state.runtime = await window.aimashi.stopEngine();
  render();
});

els.codexLogin.addEventListener("click", async () => {
  els.codexLogin.disabled = true;
  try {
    const entry = window.aimashiModelHelpers.selectedModelEntry();
    if (entry) {
      window.aimashiModelSettings.applyModelEntryToFields(entry);
      if (entry.provider === "openai-codex") state.runtime = await window.aimashi.saveModel({
        provider: entry.provider,
        model: entry.model,
        apiKeyEnv: entry.apiKeyEnv,
        baseUrl: entry.baseUrl,
        apiMode: entry.apiMode,
        providerLabel: entry.providerLabel,
        authType: entry.authType
      });
    }
    state.runtime = await window.aimashi.startProviderOAuth({
      provider: entry?.provider || "openai-codex",
      providerLabel: entry?.providerLabel || window.aimashiModelHelpers.providerLabel(entry?.provider || "openai-codex"),
      authType: entry?.authType || "oauth_external",
      baseUrl: entry?.baseUrl || "",
      apiMode: entry?.apiMode || ""
    });
    render();
  } catch (error) {
    appendChat("assistant", `OAuth login failed: ${error.message}`);
    await refreshRuntime();
  }
});

els.codexCancel.addEventListener("click", async () => {
  state.runtime = await window.aimashi.cancelProviderOAuth();
  render();
});

els.modelPreset.addEventListener("change", () => {
  window.aimashiModelSettings.fillModelFieldsFromPreset(els.modelPreset.value);
});

els.authMethod.addEventListener("change", () => {
  if (els.authMethod.value === "openai-codex") {
    const preset = providerPresets["openai-codex"];
    els.modelProvider.value = preset.provider;
    els.modelName.value = preset.model;
    els.modelKeyEnv.value = "";
    els.modelApiKey.value = "";
    els.modelBaseUrl.value = "";
    els.modelApiMode.value = preset.apiMode;
    els.modelPreset.value = "";
  }
  updateModelFieldVisibility();
});

els.quickModelSelect?.addEventListener("change", async () => {
  window.aimashiModelSettings.syncQuickModelLabel();
  const engine = window.aimashiEngineOptions.activeAgentEngine();
  if (engine === "claude-code" || engine === "codex") {
    const persona = activePersona();
    const entry = window.aimashiEngineOptions.externalModelEntries(engine).find((item) => item.id === els.quickModelSelect.value);
    if (!persona || !entry) return;
    els.quickModelSelect.disabled = true;
    setText(els.modelSwitchStatus, "保存模型...");
    try {
      state.runtime = await window.aimashi.saveFellowEngine({
        key: persona.key,
        agentEngine: engine,
        engineConfig: {
          ...window.aimashiEngineOptions.engineConfigForPersona(persona),
          model: entry.model || ""
        }
      });
      setText(els.modelSwitchStatus, "模型已更新");
      render();
    } catch (error) {
      setText(els.modelSwitchStatus, "模型更新失败");
      appendTransientChat("assistant", `Model switch failed: ${error.message}`);
      await refreshRuntime();
    } finally {
      els.quickModelSelect.disabled = false;
    }
    return;
  }
  const entry = window.aimashiModelSettings.connectedModelEntries().find((item) => item.id === els.quickModelSelect.value);
  if (!entry) return;
  els.quickModelSelect.disabled = true;
  setText(els.modelSwitchStatus, "切换中...");
  try {
    state.runtime = await window.aimashi.saveModel({
      provider: entry.provider,
      model: entry.model,
      apiKeyEnv: entry.apiKeyEnv,
      baseUrl: entry.baseUrl,
      apiMode: entry.apiMode,
      providerLabel: entry.providerLabel,
      authType: entry.authType
    });
    window.aimashiModelSettings.applyModelEntryToFields(entry);
    setText(els.modelSwitchStatus, "已切换");
    const auth = window.aimashiModelSettings.modelAuthCopy(entry, state.runtime);
    if (auth.state.includes("需要")) {
      state.settingsOpen = true;
      state.activeSettingsTab = "model";
    }
    render();
  } catch (error) {
    setText(els.modelSwitchStatus, "切换失败");
    appendTransientChat("assistant", `Model switch failed: ${error.message}`);
    await refreshRuntime();
  } finally {
    els.quickModelSelect.disabled = !window.aimashiModelSettings.connectedModelEntries(state.runtime).length;
  }
});

els.effortSelect?.addEventListener("change", async () => {
  const level = els.effortSelect.value;
  window.aimashiModelSettings.syncEffortControl(state.runtime);
  const engine = window.aimashiEngineOptions.activeAgentEngine();
  if (engine === "claude-code" || engine === "codex") {
    const persona = activePersona();
    if (!persona) return;
    setText(els.modelSwitchStatus, "保存推理强度...");
    els.effortSelect.disabled = true;
    try {
      state.runtime = await window.aimashi.saveFellowEngine({
        key: persona.key,
        agentEngine: engine,
        engineConfig: {
          ...window.aimashiEngineOptions.engineConfigForPersona(persona),
          effortLevel: level
        }
      });
      window.aimashiModelSettings.syncEffortControl(state.runtime);
      setText(els.modelSwitchStatus, "推理强度已更新");
      render();
    } catch (error) {
      setText(els.modelSwitchStatus, "推理强度更新失败");
      appendTransientChat("assistant", `Effort update failed: ${error.message}`);
      await refreshRuntime();
    } finally {
      els.effortSelect.disabled = false;
    }
    return;
  }
  setText(els.modelSwitchStatus, "保存推理强度...");
  els.effortSelect.disabled = true;
  try {
    state.runtime = await window.aimashi.saveEffort({ level });
    window.aimashiModelSettings.syncEffortControl(state.runtime);
    setText(els.modelSwitchStatus, "推理强度已更新");
    render();
  } catch (error) {
    setText(els.modelSwitchStatus, "推理强度更新失败");
    appendTransientChat("assistant", `Effort update failed: ${error.message}`);
    await refreshRuntime();
  } finally {
    els.effortSelect.disabled = false;
  }
});

els.permissionMode?.addEventListener("change", async () => {
  const mode = els.permissionMode.value;
  const engine = window.aimashiEngineOptions.activeAgentEngine();
  if (engine === "claude-code" || engine === "codex") {
    const persona = activePersona();
    if (!persona) return;
    setText(els.permissionLabel, window.aimashiModelSettings.permissionLabelForMode(mode));
    setText(els.modelSwitchStatus, "保存权限...");
    els.permissionMode.disabled = true;
    try {
      state.runtime = await window.aimashi.saveFellowEngine({
        key: persona.key,
        agentEngine: engine,
        engineConfig: {
          ...window.aimashiEngineOptions.engineConfigForPersona(persona),
          permissionMode: mode
        }
      });
      window.aimashiModelSettings.syncPermissionControl(state.runtime);
      setText(els.modelSwitchStatus, "权限已更新");
      render();
    } catch (error) {
      setText(els.modelSwitchStatus, "权限更新失败");
      appendTransientChat("assistant", `Permission mode failed: ${error.message}`);
      await refreshRuntime();
    } finally {
      els.permissionMode.disabled = false;
    }
    return;
  }
  window.aimashiModelSettings.syncPermissionControl({ permissions: { mode } });
  setText(els.modelSwitchStatus, "保存权限...");
  els.permissionMode.disabled = true;
  try {
    state.runtime = await window.aimashi.savePermissions({ mode });
    window.aimashiModelSettings.syncPermissionControl(state.runtime);
    setText(els.modelSwitchStatus, "权限已更新");
    render();
  } catch (error) {
    setText(els.modelSwitchStatus, "权限更新失败");
    appendTransientChat("assistant", `Permission mode failed: ${error.message}`);
    await refreshRuntime();
  } finally {
    els.permissionMode.disabled = false;
  }
});

els.modelSelect?.addEventListener("change", () => {
  const entry = window.aimashiModelHelpers.selectedModelEntry();
  window.aimashiModelSettings.applyModelEntryToFields(entry);
  updateModelFieldVisibility();
});

function setFellowAvatarDraft(image, crop = null) {
  const src = window.aimashiAvatar.canonicalAvatarSrc(image);
  state.fellowAvatarDraft = {
    image: src,
    crop: window.aimashiAvatar.normalizeCrop(crop || window.aimashiAvatar.avatarDefaultCropForSrc(src))
  };
  if (els.fellowAvatar) els.fellowAvatar.value = state.fellowAvatarDraft.image;
  renderFellowAvatarDraft();
}

function setProfileAvatarDraft(image, crop = null) {
  const src = window.aimashiAvatar.canonicalAvatarSrc(image);
  state.profileAvatarDraft = {
    image: src,
    crop: window.aimashiAvatar.normalizeCrop(crop || window.aimashiAvatar.avatarDefaultCropForSrc(src))
  };
  if (els.profileAvatarImage) els.profileAvatarImage.value = state.profileAvatarDraft.image;
  renderProfileAvatarDraft();
}

function renderProfileAvatarDraft() {
  if (!els.profileAvatarPreview) return;
  const draft = state.profileAvatarDraft;
  const user = state.runtime?.user || {};
  const crop = window.aimashiAvatar.normalizeCrop(draft.crop);
  els.profileAvatarPreview.setAttribute("style", window.aimashiAvatar.avatarBackgroundStyle(draft.image, crop, user.avatarColor || "#111827"));
  els.profileAvatarPreview.title = draft.image ? "点击调整头像裁剪" : "选择头像";
  els.profileAvatarPreview.setAttribute("role", "button");
  els.profileAvatarPreview.setAttribute("tabindex", "0");
  els.profileAvatarPreview.setAttribute("aria-label", "调整头像裁剪");
  renderProfileAvatarDefaults();
}

function openProfileDialog() {
  const user = state.runtime?.user || { displayName: "Boss", avatarImage: "", avatarCrop: window.aimashiAvatar.DEFAULT_AVATAR_CROP };
  state.profileDialogOpen = true;
  state.profileAvatarPresetGroup = window.aimashiAvatar.avatarPresetGroupForSrc(user.avatarImage || "") || "human";
  if (els.profileDisplayName) els.profileDisplayName.value = user.displayName || "Boss";
  setProfileAvatarDraft(user.avatarImage || "", user.avatarCrop);
  renderView();
  setTimeout(() => els.profileDisplayName?.focus(), 0);
}

function closeProfileDialog() {
  state.profileDialogOpen = false;
  renderView();
}

function renderFellowAvatarDefaults() {
  if (!els.fellowAvatarDefaults) return;
  const activeGroup = window.aimashiAvatar.avatarPresetGroups[state.fellowAvatarPresetGroup]
    ? state.fellowAvatarPresetGroup
    : "human";
  state.fellowAvatarPresetGroup = activeGroup;
  if (els.fellowAvatarDefaultTabs) {
    els.fellowAvatarDefaultTabs.innerHTML = window.aimashiAvatar.avatarPresetGroupTabs.map((group) => `
      <button type="button" class="${activeGroup === group.key ? "active" : ""}" data-avatar-group="${window.aimashiMarkdown.escapeHtml(group.key)}" role="tab" aria-selected="${activeGroup === group.key ? "true" : "false"}">${window.aimashiMarkdown.escapeHtml(group.label)}</button>
    `).join("");
    els.fellowAvatarDefaultTabs.querySelectorAll("[data-avatar-group]").forEach((button) => {
      button.addEventListener("click", () => {
        const group = button.dataset.avatarGroup || "human";
        if (!window.aimashiAvatar.avatarPresetGroups[group] || state.fellowAvatarPresetGroup === group) return;
        state.fellowAvatarPresetGroup = group;
        renderFellowAvatarDefaults();
      });
    });
  }
  const selected = state.fellowAvatarDraft.image;
  const presets = window.aimashiAvatar.avatarPresetGroups[activeGroup] || window.aimashiAvatar.avatarPresetGroups.human;
  els.fellowAvatarDefaults.innerHTML = presets.map((preset) => `
    <button type="button" class="avatar-default${selected === preset.src ? " active" : ""}" data-avatar="${window.aimashiMarkdown.escapeHtml(preset.src)}" data-avatar-name="${window.aimashiMarkdown.escapeHtml(preset.name)}" title="${window.aimashiMarkdown.escapeHtml(preset.name)}" aria-label="${window.aimashiMarkdown.escapeHtml(preset.name)}" style="${window.aimashiAvatar.avatarThumbBackgroundStyle(preset.src, window.aimashiAvatar.avatarDefaultCropForSrc(preset.src), "#eef0ff")}"></button>
  `).join("");
  els.fellowAvatarDefaults.querySelectorAll("[data-avatar]").forEach((button) => {
    button.addEventListener("click", () => {
      setFellowAvatarDraft(button.dataset.avatar, window.aimashiAvatar.avatarDefaultCropForSrc(button.dataset.avatar));
      if (els.fellowName) els.fellowName.value = button.dataset.avatarName || window.aimashiAvatar.avatarPresetBySrc(button.dataset.avatar)?.name || "";
    });
  });
}

function renderProfileAvatarDefaults() {
  if (!els.profileAvatarDefaults) return;
  const activeGroup = window.aimashiAvatar.avatarPresetGroups[state.profileAvatarPresetGroup]
    ? state.profileAvatarPresetGroup
    : "human";
  state.profileAvatarPresetGroup = activeGroup;
  if (els.profileAvatarDefaultTabs) {
    els.profileAvatarDefaultTabs.innerHTML = window.aimashiAvatar.avatarPresetGroupTabs.map((group) => `
      <button type="button" class="${activeGroup === group.key ? "active" : ""}" data-avatar-group="${window.aimashiMarkdown.escapeHtml(group.key)}" role="tab" aria-selected="${activeGroup === group.key ? "true" : "false"}">${window.aimashiMarkdown.escapeHtml(group.label)}</button>
    `).join("");
    els.profileAvatarDefaultTabs.querySelectorAll("[data-avatar-group]").forEach((button) => {
      button.addEventListener("click", () => {
        const group = button.dataset.avatarGroup || "human";
        if (!window.aimashiAvatar.avatarPresetGroups[group] || state.profileAvatarPresetGroup === group) return;
        state.profileAvatarPresetGroup = group;
        renderProfileAvatarDefaults();
      });
    });
  }
  const selected = state.profileAvatarDraft.image;
  const presets = window.aimashiAvatar.avatarPresetGroups[activeGroup] || window.aimashiAvatar.avatarPresetGroups.human;
  els.profileAvatarDefaults.innerHTML = presets.map((preset) => `
    <button type="button" class="avatar-default${selected === preset.src ? " active" : ""}" data-avatar="${window.aimashiMarkdown.escapeHtml(preset.src)}" data-avatar-name="${window.aimashiMarkdown.escapeHtml(preset.name)}" title="${window.aimashiMarkdown.escapeHtml(preset.name)}" aria-label="${window.aimashiMarkdown.escapeHtml(preset.name)}" style="${window.aimashiAvatar.avatarThumbBackgroundStyle(preset.src, window.aimashiAvatar.avatarDefaultCropForSrc(preset.src), "#eef0ff")}"></button>
  `).join("");
  els.profileAvatarDefaults.querySelectorAll("[data-avatar]").forEach((button) => {
    button.addEventListener("click", async () => {
      const src = button.dataset.avatar;
      setProfileAvatarDraft(src, window.aimashiAvatar.avatarDefaultCropForSrc(src));
      // Auto-save: clicking a preset is a decisive choice. Pull the current
      // displayName from the input so we don't drop user's in-progress edit.
      try {
        const displayName = (els.profileDisplayName?.value || "").trim()
          || state.runtime?.user?.displayName
          || "Boss";
        state.runtime = await window.aimashi.saveProfile({
          displayName,
          avatarText: window.aimashiAvatar.initials(displayName),
          avatarImage: state.profileAvatarDraft.image || src,
          avatarCrop: window.aimashiAvatar.normalizeCrop(state.profileAvatarDraft.crop),
        });
        render();
      } catch (err) {
        console.error("[profile] preset avatar auto-save failed:", err);
      }
    });
  });
}

function renderFellowAvatarDraft() {
  const draft = state.fellowAvatarDraft;
  const crop = window.aimashiAvatar.normalizeCrop(draft.crop);
  if (els.fellowAvatarPreview) {
    els.fellowAvatarPreview.setAttribute("style", window.aimashiAvatar.avatarBackgroundStyle(draft.image, crop, "#eef0ff"));
    els.fellowAvatarPreview.title = "点击调整头像裁剪";
    els.fellowAvatarPreview.setAttribute("role", "button");
    els.fellowAvatarPreview.setAttribute("tabindex", "0");
    els.fellowAvatarPreview.setAttribute("aria-label", "调整头像裁剪");
  }
  renderFellowAvatarDefaults();
}

function renderAvatarCropEditor() {
  if (!els.avatarCropStage) return;
  const editor = state.avatarCropEditor;
  const crop = window.aimashiAvatar.normalizeCrop(editor.crop);
  els.avatarCropStage.setAttribute("style", window.aimashiAvatar.avatarBackgroundStyle(editor.image, crop, "#eef0ff"));
}

function openAvatarCropEditor(image, crop = null, target = "fellow") {
  const src = window.aimashiAvatar.canonicalAvatarSrc(image);
  state.avatarCropEditor = {
    open: true,
    target,
    image: src,
    crop: window.aimashiAvatar.normalizeCrop(crop || window.aimashiAvatar.avatarDefaultCropForSrc(src)),
    dragging: false,
    lastX: 0,
    lastY: 0
  };
  renderView();
  renderAvatarCropEditor();
}

function closeAvatarCropEditor() {
  state.avatarCropEditor.open = false;
  state.avatarCropEditor.dragging = false;
  renderView();
}

function updateAvatarCropEditor(crop) {
  state.avatarCropEditor.crop = window.aimashiAvatar.normalizeCrop({
    ...state.avatarCropEditor.crop,
    ...crop
  });
  renderAvatarCropEditor();
}

function readFellowAvatarFile(file) {
  if (!file || !file.type?.startsWith("image/")) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    openAvatarCropEditor(String(reader.result || ""), { x: 50, y: 50, zoom: 1.12 }, "fellow");
  });
  reader.readAsDataURL(file);
}

function readProfileAvatarFile(file) {
  if (!file || !file.type?.startsWith("image/")) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    openAvatarCropEditor(String(reader.result || ""), { x: 50, y: 50, zoom: 1.12 }, "profile");
  });
  reader.readAsDataURL(file);
}

function detectedAgentEngineOptions() {
  const engines = state.runtime?.agentEngines || {};
  const options = [{ id: "hermes", label: "默认" }];
  if (engines.claudeCode?.available) options.push({ id: "claude-code", label: "Claude Code" });
  if (engines.codex?.available) options.push({ id: "codex", label: "Codex" });
  return options;
}

function renderFellowAgentEngineSelect(current = "hermes") {
  const options = detectedAgentEngineOptions();
  const showField = options.length > 1;
  els.fellowAgentEngineField?.classList.toggle("hidden", !showField);
  if (!els.fellowAgentEngine) return;
  els.fellowAgentEngine.innerHTML = "";
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.id;
    node.textContent = option.label;
    els.fellowAgentEngine.appendChild(node);
  }
  els.fellowAgentEngine.value = options.some((option) => option.id === current) ? current : "hermes";
}

function openFellowDialog(fellow = null, personaText = "") {
  if (fellow && fellow.currentTarget) fellow = null;
  // Allow a seed object in place of `fellow` to prefill create mode (used by
  // initial-onboarding flow). Detected by absence of a real key.
  const seed = fellow && !fellow.key && (fellow.name || fellow.agentEngine || fellow.bio) ? fellow : null;
  const actualFellow = seed ? null : fellow;
  state.fellowMenuOpen = false;
  state.fellowDialogMode = actualFellow ? "edit" : "create";
  state.fellowDialogOpen = true;
  const titleName = String(actualFellow?.name || "").trim();
  if (els.fellowDialogTitle) els.fellowDialogTitle.textContent = actualFellow
    ? `编辑「${titleName || "伙伴"}」`
    : (seed ? "创建你的第一个伙伴" : "添加伙伴");
  if (els.fellowKey) els.fellowKey.value = actualFellow?.key || "";
  els.fellowName.value = actualFellow?.name || seed?.name || "";
  renderFellowAgentEngineSelect(actualFellow?.agentEngine || actualFellow?.agent_engine || seed?.agentEngine || "hermes");
  const avatarImage = actualFellow?.avatarImage || window.aimashiAvatar.defaultAvatarAssets()[0];
  state.fellowAvatarPresetGroup = window.aimashiAvatar.avatarPresetGroupForSrc(avatarImage) || "human";
  setFellowAvatarDraft(avatarImage, window.aimashiAvatar.avatarCropForImage(avatarImage, actualFellow?.avatarCrop));
  els.fellowSeed.value = actualFellow ? personaText : (seed?.bio || "");
  if (els.fellowPersonaDetails) els.fellowPersonaDetails.open = Boolean(seed);
  renderView();
  setTimeout(() => els.fellowName?.focus(), 0);
}

function closeFellowDialog() {
  state.fellowDialogOpen = false;
  renderView();
}

els.newPersona.addEventListener("click", (event) => {
  event.stopPropagation();
  state.fellowMenuOpen = !state.fellowMenuOpen;
  renderView();
});

els.addFellow?.addEventListener("click", () => openFellowDialog());
els.newContact?.addEventListener("click", () => openFellowDialog());
els.userAvatar?.addEventListener("click", openProfileDialog);
els.userAvatar?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openProfileDialog();
});
els.closeProfileDialog?.addEventListener("click", closeProfileDialog);
els.cancelProfile?.addEventListener("click", closeProfileDialog);
els.closeFellowDialog?.addEventListener("click", closeFellowDialog);
els.cancelFellow?.addEventListener("click", closeFellowDialog);
els.closePetGenerateDialog?.addEventListener("click", () => window.aimashiPetDialog?.closePetGenerateDialog());
els.cancelPetGenerate?.addEventListener("click", () => window.aimashiPetDialog?.closePetGenerateDialog());
els.addPetReference?.addEventListener("click", () => els.petReferenceFile?.click());
els.petReferenceFile?.addEventListener("change", () => {
  window.aimashiPetDialog?.readPetReferenceFile(els.petReferenceFile.files?.[0]);
  els.petReferenceFile.value = "";
});
els.petJobButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  state.petJobPanelOpen = !state.petJobPanelOpen;
  window.aimashiPetDialog?.renderPetJobs();
});
els.petGenerateForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fellow = window.aimashiFellowManager.fellowByKey(state.petGenerateFellowKey);
  if (!fellow) return;
  const job = await window.aimashi.generateFellowPet({
    fellowKey: fellow.key,
    prompt: els.petPrompt?.value || "",
    stylePreset: els.petStylePreset?.value || "codex",
    referenceImages: state.petReferences.map((item) => item.src)
  });
  state.petJobs = [job, ...state.petJobs.filter((item) => item.id !== job.id)];
  state.petJobPanelOpen = true;
  window.aimashiPetDialog?.closePetGenerateDialog();
  window.aimashiPetDialog?.renderPetJobs();
});
els.chooseFellowAvatar?.addEventListener("click", () => els.fellowAvatarFile?.click());
els.fellowAvatarFile?.addEventListener("change", () => {
  readFellowAvatarFile(els.fellowAvatarFile.files?.[0]);
  els.fellowAvatarFile.value = "";
});
els.fellowAvatarPreview?.addEventListener("click", () => {
  const draft = state.fellowAvatarDraft;
  if (!draft?.image) return;
  openAvatarCropEditor(draft.image, draft.crop);
});
els.fellowAvatarPreview?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  const draft = state.fellowAvatarDraft;
  if (!draft?.image) return;
  openAvatarCropEditor(draft.image, draft.crop);
});
els.fellowAvatarDrop?.addEventListener("dragover", (event) => {
  event.preventDefault();
  els.fellowAvatarDrop.classList.add("dragging");
});
els.fellowAvatarDrop?.addEventListener("dragleave", () => {
  els.fellowAvatarDrop.classList.remove("dragging");
});
els.fellowAvatarDrop?.addEventListener("drop", (event) => {
  event.preventDefault();
  els.fellowAvatarDrop.classList.remove("dragging");
  readFellowAvatarFile(event.dataTransfer?.files?.[0]);
});
els.chooseProfileAvatar?.addEventListener("click", () => els.profileAvatarFile?.click());
els.profileAvatarFile?.addEventListener("change", () => {
  readProfileAvatarFile(els.profileAvatarFile.files?.[0]);
  els.profileAvatarFile.value = "";
});
els.profileAvatarPreview?.addEventListener("click", () => {
  const draft = state.profileAvatarDraft;
  if (!draft?.image) {
    els.profileAvatarFile?.click();
    return;
  }
  openAvatarCropEditor(draft.image, draft.crop, "profile");
});
els.profileAvatarPreview?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  const draft = state.profileAvatarDraft;
  if (!draft?.image) {
    els.profileAvatarFile?.click();
    return;
  }
  openAvatarCropEditor(draft.image, draft.crop, "profile");
});
els.profileAvatarDrop?.addEventListener("dragover", (event) => {
  event.preventDefault();
  els.profileAvatarDrop.classList.add("dragging");
});
els.profileAvatarDrop?.addEventListener("dragleave", () => {
  els.profileAvatarDrop.classList.remove("dragging");
});
els.profileAvatarDrop?.addEventListener("drop", (event) => {
  event.preventDefault();
  els.profileAvatarDrop.classList.remove("dragging");
  readProfileAvatarFile(event.dataTransfer?.files?.[0]);
});
els.avatarCropStage?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  state.avatarCropEditor.dragging = true;
  state.avatarCropEditor.lastX = event.clientX;
  state.avatarCropEditor.lastY = event.clientY;
  els.avatarCropStage.setPointerCapture?.(event.pointerId);
});
els.avatarCropStage?.addEventListener("pointermove", (event) => {
  if (!state.avatarCropEditor.dragging) return;
  const dx = event.clientX - state.avatarCropEditor.lastX;
  const dy = event.clientY - state.avatarCropEditor.lastY;
  state.avatarCropEditor.lastX = event.clientX;
  state.avatarCropEditor.lastY = event.clientY;
  const stageSize = els.avatarCropStage?.clientWidth || 320;
  const zoom = state.avatarCropEditor.crop.zoom || 1;
  // Pan range in pixels = how far the image extends beyond the stage on one side.
  const panRangePx = stageSize * Math.max(zoom - 1, 0);
  if (panRangePx < 0.5) return; // no pan room; image fits the stage
  // Mathematically 1px drag = 100/panRangePx percent. At low zoom that ratio
  // explodes (e.g. zoom=1.01 → ~31% per pixel) which feels chaotic. Cap the
  // felt sensitivity at 3% per pixel — the user just has to drag farther to
  // span the full crop range, but every pixel of drag stays smooth.
  const rawPerPx = 100 / panRangePx;
  const sensitivity = Math.min(rawPerPx, 3);
  // Negative: dragging image right exposes its left side (crop x decreases).
  const percentPerPx = -sensitivity;
  updateAvatarCropEditor({
    x: state.avatarCropEditor.crop.x + dx * percentPerPx,
    y: state.avatarCropEditor.crop.y + dy * percentPerPx
  });
});
els.avatarCropStage?.addEventListener("pointerup", (event) => {
  state.avatarCropEditor.dragging = false;
  els.avatarCropStage.releasePointerCapture?.(event.pointerId);
});
els.avatarCropStage?.addEventListener("pointercancel", () => {
  state.avatarCropEditor.dragging = false;
});
els.avatarCropStage?.addEventListener("wheel", (event) => {
  event.preventDefault();
  const direction = event.deltaY > 0 ? -1 : 1;
  updateAvatarCropEditor({
    zoom: state.avatarCropEditor.crop.zoom + direction * 0.03
  });
});
els.confirmAvatarCrop?.addEventListener("click", async () => {
  if (state.avatarCropEditor.target === "profile") {
    setProfileAvatarDraft(state.avatarCropEditor.image, state.avatarCropEditor.crop);
    // Auto-persist the avatar so closing the profile dialog without clicking
    // "保存资料" doesn't silently drop the new avatar. The display name field
    // is preserved by reading whatever is currently in the input.
    try {
      const displayName = (els.profileDisplayName?.value || "").trim()
        || state.runtime?.user?.displayName
        || "Boss";
      state.runtime = await window.aimashi.saveProfile({
        displayName,
        avatarText: window.aimashiAvatar.initials(displayName),
        avatarImage: state.profileAvatarDraft.image || els.profileAvatarImage?.value || "",
        avatarCrop: window.aimashiAvatar.normalizeCrop(state.profileAvatarDraft.crop),
      });
      render();
    } catch (err) {
      console.error("[profile] avatar auto-save failed:", err);
    }
  } else {
    setFellowAvatarDraft(state.avatarCropEditor.image, state.avatarCropEditor.crop);
  }
  closeAvatarCropEditor();
});
els.cancelAvatarCrop?.addEventListener("click", closeAvatarCropEditor);
els.resetAvatarCrop?.addEventListener("click", () => {
  state.avatarCropEditor.crop = window.aimashiAvatar.normalizeCrop(window.aimashiAvatar.avatarDefaultCropForSrc(state.avatarCropEditor.image));
  renderAvatarCropEditor();
});

els.profileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const displayName = els.profileDisplayName.value.trim() || "Boss";
  state.runtime = await window.aimashi.saveProfile({
    displayName,
    avatarText: window.aimashiAvatar.initials(displayName),
    avatarImage: state.profileAvatarDraft.image || els.profileAvatarImage.value,
    avatarCrop: window.aimashiAvatar.normalizeCrop(state.profileAvatarDraft.crop)
  });
  closeProfileDialog();
  render();
});

els.appearanceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  window.aimashiSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceTheme.addEventListener("change", () => {
  window.aimashiSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceFontPreset.addEventListener("change", () => {
  window.aimashiSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceFontChoices?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-font-preset]");
  if (!button || !els.appearanceFontChoices.contains(button)) return;
  els.appearanceFontPreset.value = button.dataset.fontPreset || "system";
  window.aimashiSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceListStyle?.addEventListener("change", () => {
  window.aimashiSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceSelectionStyle?.addEventListener("change", () => {
  window.aimashiSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceAccentColor?.addEventListener("input", () => {
  window.aimashiSettingsAppearance.scheduleAppearanceSave();
});

els.appearanceAccentReset?.addEventListener("click", () => {
  if (els.appearanceAccentColor) els.appearanceAccentColor.value = DEFAULT_ACCENT_COLOR;
  window.aimashiSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceUserBubbleColor?.addEventListener("input", () => {
  window.aimashiSettingsAppearance.scheduleAppearanceSave();
});

els.appearanceUserBubbleReset?.addEventListener("click", () => {
  if (els.appearanceUserBubbleColor) els.appearanceUserBubbleColor.value = DEFAULT_USER_BUBBLE_COLOR;
  window.aimashiSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceShowHoverBackground?.addEventListener("click", () => {
  window.aimashiSettingsAppearance.toggleSettingsSwitch(els.appearanceShowHoverBackground);
});

els.appearanceShowUserAvatar?.addEventListener("click", () => {
  window.aimashiSettingsAppearance.toggleSettingsSwitch(els.appearanceShowUserAvatar);
});

els.appearanceShowAssistantAvatar?.addEventListener("click", () => {
  window.aimashiSettingsAppearance.toggleSettingsSwitch(els.appearanceShowAssistantAvatar);
});

els.fellowForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fellow = {
    key: els.fellowKey?.value || "",
    name: els.fellowName.value,
    agentEngine: els.fellowAgentEngine?.value || "hermes",
    avatarImage: state.fellowAvatarDraft.image || els.fellowAvatar.value,
    avatarCrop: window.aimashiAvatar.normalizeCrop(state.fellowAvatarDraft.crop),
    description: state.fellowDialogMode === "create" ? els.fellowSeed.value : "",
    personaText: els.fellowSeed.value
  };
  state.runtime = await window.aimashi.saveFellow(fellow);
  const fellows = state.runtime?.fellows || state.runtime?.personas || [];
  const saved = fellow.key
    ? fellows.find((item) => item.key === fellow.key)
    : [...fellows].reverse().find((item) => item.name === fellow.name.trim()) || fellows[0];
  if (saved?.key) state.activeKey = saved.key;
  await loadChatSessions();
  state.fellowDialogOpen = false;
  // If this was the initial onboarding create-fellow step, mark onboarding done.
  if (state.onboardingStep && state.onboardingStep !== "done") {
    advanceOnboarding("done");
    state.setupGuideDismissed = true;
    localStorage.setItem(SETUP_GUIDE_DISMISSED_KEY, "1");
  }
  render();
});

els.modelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const entry = window.aimashiModelHelpers.selectedModelEntry();
  if (!entry || window.aimashiModelSettings.providerIsConnected(entry.provider)) return;
  const needsApiKey = entry.provider !== "openai-codex" && entry.provider !== "lmstudio" && !String(entry.authType || "").startsWith("oauth");
  if (needsApiKey && !els.modelApiKey.value.trim()) {
    setText(els.modelAuthState, `需要填写 ${entry.apiKeyEnv || "API Key"}`);
    return;
  }
  if (entry) window.aimashiModelSettings.applyModelEntryToFields(entry);
  state.runtime = await window.aimashi.saveModel({
    provider: els.modelProvider.value,
    model: els.modelName.value,
    apiKeyEnv: els.modelKeyEnv.value,
    apiKey: els.modelApiKey.value,
    baseUrl: els.modelBaseUrl.value,
    apiMode: els.modelApiMode.value,
    providerLabel: entry.providerLabel,
    authType: entry.authType
  });
  els.modelApiKey.value = "";
  if (els.modelSelect) els.modelSelect.value = "";
  render();
});

els.chatInput.addEventListener("keydown", (event) => {
  if (isComposerComposing(event)) return;
  if (state.slashMenuOpen) {
    const commands = filteredSlashCommands();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.slashSelectedIndex = commands.length ? (state.slashSelectedIndex + 1) % commands.length : 0;
      renderSlashCommandMenu();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.slashSelectedIndex = commands.length ? (state.slashSelectedIndex - 1 + commands.length) % commands.length : 0;
      renderSlashCommandMenu();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const command = commands[state.slashSelectedIndex];
      if (command) {
        fillSlashCommand(command);
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const command = commands[state.slashSelectedIndex];
      if (command) sendSlashCommand(command);
      return;
    }
    if (event.key === "Escape") {
      state.slashMenuOpen = false;
      renderSlashCommandMenu();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.chatForm.requestSubmit();
  }
});

els.chatInput.addEventListener("compositionstart", () => {
  composerCompositionEndedAt = 0;
  els.chatInput.dataset.composing = "true";
});

els.chatInput.addEventListener("compositionend", () => {
  composerCompositionEndedAt = performance.now();
  els.chatInput.dataset.composing = "false";
  resizeChatInput();
  updateSlashCommandState();
  renderSendButton();
});

els.chatInput.addEventListener("input", () => {
  resizeChatInput();
  updateSlashCommandState();
  renderSendButton();
});
els.chatInput.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeComposerAddMenu();
  closeSkillPicker();
  els.chatInput.focus();
  window.aimashi?.showEditContextMenu?.({ x: event.clientX, y: event.clientY });
});
els.chatInput.addEventListener("click", updateSlashCommandState);
els.composerAdd?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  state.composerAddMenuOpen = !state.composerAddMenuOpen;
  state.slashMenuOpen = false;
  if (state.composerAddMenuOpen) closeSkillPicker();
  renderSlashCommandMenu();
  renderComposerAddMenu();
});
els.composerAddMenu?.addEventListener("click", (event) => {
  const action = event.target.closest("[data-composer-add]")?.dataset.composerAdd;
  if (!action) return;
  event.preventDefault();
  if (action === "attachment") {
    closeComposerAddMenu();
    els.composerAttachmentInput?.click();
    return;
  }
  if (action === "skill") {
    openSkillPicker();
    return;
  }
  els.chatInput?.focus();
});
els.composerAddMenu?.addEventListener("pointerover", (event) => {
  const action = event.target.closest("[data-composer-add]")?.dataset.composerAdd;
  if (action === "skill") {
    openSkillPicker();
    return;
  }
  if (action) scheduleSkillPickerHoverClose();
});
els.composerAddMenu?.addEventListener("pointerout", (event) => {
  const item = event.target.closest('[data-composer-add="skill"]');
  if (!item) return;
  if (targetIsSkillPickerZone(event.relatedTarget)) return;
  scheduleSkillPickerHoverClose();
});
els.skillPicker?.addEventListener("pointerenter", cancelSkillPickerHoverClose);
els.skillPicker?.addEventListener("pointerleave", (event) => {
  if (targetIsSkillPickerZone(event.relatedTarget)) return;
  scheduleSkillPickerHoverClose();
});

els.skillPickerSearch?.addEventListener("input", () => {
  state.skillPickerFilter = els.skillPickerSearch.value || "";
  renderSkillPicker();
});
els.closeSkillPicker?.addEventListener("click", () => closeSkillPicker());
els.skillPickerBody?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-skill-pick]");
  if (!button) return;
  insertSkillIntoComposer(button.dataset.skillPick);
  closeComposerAddMenu();
  closeSkillPicker();
});
els.skillPickerBody?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-skill-picker-plugin]");
  if (!button) return;
  state.skillPickerPluginId = button.dataset.skillPickerPlugin || "";
  state.skillPickerFilter = "";
  if (els.skillPickerSearch) els.skillPickerSearch.value = "";
  renderSkillPicker();
});
els.skillPickerBody?.addEventListener("pointerover", (event) => {
  const button = event.target.closest("[data-skill-picker-plugin]");
  if (!button || button.dataset.skillPickerPlugin === state.skillPickerPluginId) return;
  state.skillPickerPluginId = button.dataset.skillPickerPlugin || "";
  state.skillPickerFilter = "";
  if (els.skillPickerSearch) els.skillPickerSearch.value = "";
  renderSkillPicker();
});
els.skillPickerSearch?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSkillPicker();
  if (event.key === "Enter") {
    event.preventDefault();
    const first = els.skillPickerBody?.querySelector("[data-skill-pick]");
    if (first) {
      insertSkillIntoComposer(first.dataset.skillPick);
      closeComposerAddMenu();
      closeSkillPicker();
    }
  }
});
document.addEventListener("click", (event) => {
  if (!state.skillPickerOpen) return;
  if (els.skillPicker?.contains(event.target)) return;
  if (els.composerAddMenu?.contains(event.target)) return;
  if (els.composerAdd?.contains(event.target)) return;
  closeSkillPicker();
});
els.composerAttachmentInput?.addEventListener("change", () => {
  addComposerFiles(els.composerAttachmentInput.files);
  els.composerAttachmentInput.value = "";
});
els.composerAttachments?.addEventListener("click", (event) => {
  if (event.target.closest("[data-attachment-remove]")) return;
  els.chatInput?.focus();
});
els.composerReply?.addEventListener("click", (event) => {
  if (!event.target.closest("[data-clear-reply]")) return;
  state.replyDraft = null;
  renderComposerReply();
  els.chatInput?.focus();
});
els.chatForm?.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  els.chatForm.classList.add("dragging-attachment");
});
els.chatForm?.addEventListener("dragleave", () => {
  els.chatForm.classList.remove("dragging-attachment");
});
els.chatForm?.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  els.chatForm.classList.remove("dragging-attachment");
  addComposerFiles(event.dataTransfer.files);
});
els.chatInput?.addEventListener("paste", (event) => {
  if (!event.clipboardData?.files?.length) return;
  addComposerFiles(event.clipboardData.files);
});
els.sendChat.addEventListener("click", async (event) => {
  if (!state.isGenerating) return;
  event.preventDefault();
  event.stopPropagation();
  await window.aimashi.stopChat?.();
});
els.chat.addEventListener("click", async (event) => {
  const jumpBtn = event.target.closest?.("[data-jump-task]");
  if (jumpBtn && els.chat.contains(jumpBtn)) {
    const taskId = jumpBtn.dataset.jumpTask;
    state.selectedTaskId = taskId;
    state.selectedRunId = "";
    state.activeView = "tasks";
    state.tasksUnread?.delete(taskId);
    window.aimashiTasksPanel?.updateTasksRailBadge();
    render();
    return;
  }
  const imageButton = event.target.closest(".message-attachment.image");
  if (imageButton && els.chat.contains(imageButton)) {
    event.preventDefault();
    event.stopPropagation();
    openImagePreview(imageButton.querySelector("img")?.src || "", imageButton.title || "");
    return;
  }
  const setupButton = event.target.closest("[data-setup-action]");
  if (setupButton && els.chat.contains(setupButton)) {
    event.preventDefault();
    event.stopPropagation();
    await handleSetupGuideAction(setupButton);
    return;
  }
  const code = event.target.closest(".bubble code.inline-code");
  if (!code || !els.chat.contains(code)) return;
  if (event.target.closest("[data-copy-code]")) return;
  if (await copyTextToClipboard(code.textContent)) flashCopiedCode(code);
});
els.chat.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-code]");
  if (!button || !els.chat.contains(button)) return;
  const code = button.closest(".message-code-block")?.querySelector("code");
  if (!code) return;
  if (await copyTextToClipboard(code.textContent)) {
    button.classList.add("copied");
    button.disabled = true;
    setTimeout(() => {
      button.classList.remove("copied");
      button.disabled = false;
    }, 900);
  }
});
els.chat.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-translation]");
  if (!button || !els.chat.contains(button)) return;
  const message = messageAtIndex(Number(button.dataset.copyTranslation));
  const text = message?.translation?.text || "";
  if (!text) return;
  if (await copyTextToClipboard(text)) {
    button.classList.add("copied");
    button.disabled = true;
    setTimeout(() => {
      button.classList.remove("copied");
      button.disabled = false;
    }, 900);
  }
});
els.chat.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const code = event.target.closest(".bubble code.inline-code");
  if (!code || !els.chat.contains(code)) return;
  event.preventDefault();
  if (await copyTextToClipboard(code.textContent)) flashCopiedCode(code);
});
els.chat.addEventListener("toggle", (event) => {
  const row = event.target.closest?.("details.trace-row[data-trace-key]");
  if (!row || !els.chat.contains(row)) return;
  const key = row.dataset.traceKey;
  if (!key) return;
  if (row.open) {
    state.openTraceKeys.add(key);
    state.openTraceKeys.delete(`!${key}`);
    row.dataset.userOpen = "true";
    delete row.dataset.autoOpen;
  } else {
    state.openTraceKeys.delete(key);
    state.openTraceKeys.add(`!${key}`);
    delete row.dataset.userOpen;
    delete row.dataset.autoOpen;
  }
}, true);

els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isComposerComposing()) return;
  // Branch: group chat
  if (activeGroup()) {
    if (window.aimashiGroup && typeof window.aimashiGroup.sendInActiveGroup === "function") {
      await window.aimashiGroup.sendInActiveGroup();
    }
    return;
  }
  if (state.isGenerating) {
    await window.aimashi.stopChat?.();
    return;
  }
  const text = els.chatInput.value.trim();
  const attachments = state.pendingAttachments.map((attachment) => ({ ...attachment }));
  if (!text && !attachments.length) return;
  const session = activeSession();
  const replyTo = state.replyDraft ? { ...state.replyDraft } : null;
  const shouldGenerateTitle = !session.titleGenerated && !hasSuccessfulExchange(session);
  els.chatInput.value = "";
  state.pendingAttachments = [];
  state.replyDraft = null;
  renderComposerReply();
  renderComposerAttachments();
  resizeChatInput();
  renderSendButton();
  const userText = text || "请查看附件。";
  appendChat("user", userText, { attachments, replyTo });
  state.streaming = null;
  state.isGenerating = true;
  renderSendButton();
  renderHeaderStatus();
  try {
    const userMessage = session.messages[session.messages.length - 1];
    // Persist BEFORE pushing to cloud: even though the cloud:event
    // listener no longer reloads chatStore wholesale, persisting first
    // still avoids races with anything else that may read from disk.
    await persistSessionQuietly(session);
    // Capture the user-push promise so the later assistant push can wait
    // on it — otherwise a fast local agent + slow user-attachment upload
    // can cause the assistant message to land in /api/messages first,
    // and Web/mobile clients will show the assistant before the prompt.
    const userCloudPush = pushCloudMessageQuietly(session, userMessage);
    const outgoingBase = await outgoingMessageForSubmit(text);
    const outgoingText = window.aimashiMessageMenu
      ? window.aimashiMessageMenu.replyContextPrompt(outgoingBase, replyTo)
      : outgoingBase;
    const history = messagesForActive()
      .filter((message) => message.content || (Array.isArray(message.attachments) && message.attachments.length))
      .map((message) => ({ role: message.role, content: message.content, attachments: message.attachments || [] }));
    const lastUserIndex = history.map((message) => message.role).lastIndexOf("user");
    if (lastUserIndex >= 0) history[lastUserIndex] = { ...history[lastUserIndex], content: outgoingText };
    const response = await window.aimashi.sendChat({
      fellowKey: state.activeKey,
      personaKey: state.activeKey,
      sessionId: session.id,
      messages: history
    });
    const responseMessage = response.choices?.[0]?.message || {};
    const responseAttachments = Array.isArray(responseMessage.attachments) ? responseMessage.attachments : [];
    const answer = responseMessage.content || (responseAttachments.length ? "" : "(No response)");
    const traceSnapshot = state.streaming
      ? { reasoning: state.streaming.reasoning || "", tools: state.streaming.tools.slice() }
      : { reasoning: "", tools: [] };
    state.streaming = null;
    appendChat("assistant", answer, { reasoning: traceSnapshot.reasoning, tools: traceSnapshot.tools, attachments: responseAttachments });
    // The `session` captured at the top of this handler is now orphan:
    // persistSessionQuietly(session) at the start of the try block reassigned
    // state.chatStore via IPC (saveChatSession returns a freshly normalized
    // store), so the original session object no longer lives inside it.
    // appendChat above pushed the assistant message into the LIVE session
    // (state.chatStore.sessions[...]), not into the orphan ref. Persisting
    // the orphan here would save its stale messages and clobber the assistant
    // we just appended — that's the "回复被吞" regression introduced by
    // 0eb1458. Re-resolve to the live session before persist + cloud push.
    const liveSession = activeSession();
    await persistSessionQuietly(liveSession);
    const assistantMessage = liveSession.messages[liveSession.messages.length - 1];
    // Wait for the earlier user push to land first so /api/messages
    // receives user → assistant in order (Codex review P2).
    try { await userCloudPush; } catch { /* user push errors are non-fatal */ }
    await pushCloudMessageQuietly(liveSession, assistantMessage);
    window.aimashiSessionReadState.persistReadStateQuietly();
    if (shouldGenerateTitle) {
      const current = activeSession();
      const result = await window.aimashi.generateSessionTitle({
        personaKey: state.activeKey,
        sessionId: `title:${current.id}`,
        messages: current.messages.slice(0, 4)
      });
      current.title = result.title || userText.slice(0, 24) || "新对话";
      current.titleGenerated = true;
      current.updatedAt = nowIso();
      await persistSessionQuietly(current);
      renderSessionMenu();
    }
    await refreshRuntime();
  } catch (error) {
    // Re-resolve session — see comment on `liveSession` above for why the
    // captured `session` is orphan once persistSessionQuietly has reassigned
    // state.chatStore. The "生成已停止" branch persists whatever's in memory
    // (typically just the user message); the error branch first appends an
    // assistant-side error message via appendChat (which targets the live
    // session via activeSession()), then persists.
    if (String(error.message || "").includes("生成已停止")) {
      await persistSessionQuietly(activeSession());
    } else {
      appendChat("assistant", `Request failed: ${error.message}`);
      await persistSessionQuietly(activeSession());
    }
    await refreshRuntime();
  } finally {
    state.isGenerating = false;
    state.streaming = null;
    renderSendButton();
    renderHeaderStatus();
    els.chatInput.focus();
  }
});

let pendingStreamRender = false;
function scheduleStreamRender() {
  if (pendingStreamRender) return;
  pendingStreamRender = true;
  requestAnimationFrame(() => {
    pendingStreamRender = false;
    const s = state.streaming;
    if (s && s.sessionId === activeSession().id) renderChat();
    renderHeaderStatus();
  });
}

function advanceOnboarding(step) {
  state.onboardingStep = step;
  try { localStorage.setItem("aimashi.onboardingStep", step); } catch { /* ignore */ }
}

function afterEnginePicked(engine) {
  state.onboardingPickedEngine = engine;
  advanceOnboarding("create-fellow");
  // For Hermes: pop the model-settings panel so the user can add provider + API
  // key right away. For CC/Codex auth happens externally — skip.
  if (engine === "hermes") {
    state.settingsOpen = true;
    state.activeSettingsTab = "model";
  }
  renderView();
}

async function handleSetupGuideAction(button) {
  const action = button?.dataset?.setupAction || "";
  if (!action) return false;
  if (action === "dismiss") {
    state.setupGuideDismissed = true;
    localStorage.setItem(SETUP_GUIDE_DISMISSED_KEY, "1");
    renderChat();
    return true;
  }
  if (action === "open-model-settings") {
    state.settingsOpen = true;
    state.activeSettingsTab = "model";
    renderView();
    return true;
  }
  if (action === "use-engine") {
    const engine = String(button.dataset.engine || "");
    if (!["hermes", "claude-code", "codex"].includes(engine)) return true;
    afterEnginePicked(engine);
    return true;
  }
  if (action === "install-hermes") {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "安装中…";
    try {
      state.runtime = await window.aimashi.installEngine();
      await loadModelCatalog();
      afterEnginePicked("hermes");
    } catch (error) {
      appendTransientChat("assistant", `Hermes install failed: ${error.message}`);
      await refreshRuntime();
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
    return true;
  }
  if (action === "create-first-fellow") {
    openInitialFellowDialog();
    return true;
  }
  return false;
}

function openInitialFellowDialog() {
  const engine = state.onboardingPickedEngine || "hermes";
  const seed = {
    name: "Aimashi",
    agentEngine: engine,
    bio: "你是 Aimashi，一个轻松友好的桌面 AI 伙伴，回答简洁、口语化。"
  };
  // Reuse existing fellow create dialog with prefilled values.
  if (typeof openFellowDialog === "function") {
    openFellowDialog(null, seed);
  } else {
    // Fallback: at least open settings
    state.settingsOpen = true;
    state.activeSettingsTab = "model";
    renderView();
  }
}

function renderHeaderStatus() {
  if (!els.activeChatMeta) return;
  // If a group is active, the meta is already set by the render() topbar block
  if (activeGroup()) return;
  const personas = state.runtime?.fellows || state.runtime?.personas || [];
  const active = personas.find((persona) => persona.key === state.activeKey) || personas[0];
  if (!active) return;
  if (state.isGenerating) {
    els.activeChatMeta.innerHTML = `<span class="typing-status">正在输入<span class="typing-dots"><i></i><i></i><i></i></span></span>`;
    return;
  }
  const count = sessionsForPersona(active.key).length;
  const startupLoading = state.startupTasks[0]?.label;
  const trailing = startupLoading ? ` · 正在${window.aimashiMarkdown.escapeHtml(startupLoading)}` : "";
  els.activeChatMeta.innerHTML = `${count} 个会话 · 在线${trailing}`;
}

window.aimashi.onChatEvent((envelope) => {
  if (!envelope || typeof envelope !== "object") return;
  const { runId, sessionId, kind, data } = envelope;
  if (!kind) return;
  if (!state.streaming || state.streaming.runId !== runId) {
    if (kind !== "session_started") return;
    state.streaming = {
      runId,
      sessionId: sessionId || "",
      createdAt: nowIso(),
      status: "正在输入",
      text: "",
      textBlockId: null,
      reasoning: "",
      tools: [],
      toolsById: new Map(),
      toolsByName: new Map()
    };
    scheduleStreamRender();
    return;
  }
  const s = state.streaming;
  switch (kind) {
    case "status":
      s.status = String(data?.text || "");
      break;
    case "text_delta":
      if (!s.textBlockId) s.textBlockId = data?.id || `text_${runId}`;
      s.text += String(data?.text || "");
      break;
    case "reasoning_delta":
      s.reasoning += String(data?.text || "");
      if (s.reasoning && !s.reasoning.endsWith("\n")) s.reasoning += "\n";
      break;
    case "tool_call_started": {
      const tool = {
        id: String(data?.id || `tool_${s.tools.length}`),
        name: String(data?.name || "工具"),
        preview: String(data?.preview || ""),
        status: "running",
        duration: null,
        error: false
      };
      s.tools.push(tool);
      s.toolsById.set(tool.id, tool);
      const queue = s.toolsByName.get(tool.name) || [];
      queue.push(tool);
      s.toolsByName.set(tool.name, queue);
      break;
    }
    case "tool_call_delta": {
      const id = String(data?.id || "");
      const name = String(data?.name || "");
      let tool = id ? s.toolsById.get(id) : null;
      if (!tool) {
        const queue = s.toolsByName.get(name);
        tool = queue && queue.find((t) => t.status === "running");
      }
      if (tool) tool.preview = String(data?.preview || tool.preview || "");
      break;
    }
    case "tool_call_completed": {
      const id = String(data?.id || "");
      const name = String(data?.name || "");
      let tool = id ? s.toolsById.get(id) : null;
      if (!tool) {
        const queue = s.toolsByName.get(name);
        tool = queue && queue.find((t) => t.status === "running");
      }
      if (tool) {
        tool.status = data?.error ? "error" : "completed";
        tool.duration = typeof data?.duration === "number" ? data.duration : null;
        tool.error = Boolean(data?.error);
        if (data?.preview) tool.preview = String(data.preview);
      }
      break;
    }
    case "complete":
      // Intentionally do NOT clear state.streaming here. The chatForm submit
      // takes a snapshot AFTER chat:send resolves and BEFORE it clears
      // state.streaming — that's the single source of truth for trace
      // persistence. If we cleared on complete (which can arrive before
      // chat:send resolves), the snapshot would be empty.
      if (s.status) s.status = "";
      break;
    case "error":
      if (s.status) s.status = "";
      break;
    default:
      break;
  }
  scheduleStreamRender();
});

resizeChatInput();
function startAfterFirstPaint() {
  const start = () => {
    try { window.aimashi?.notifyFirstPaint?.(); } catch { /* main may not expose this in older builds */ }
    initializeRuntime().catch((error) => {
      console.error("Failed to initialize Aimashi runtime", error);
      const message = error?.message || String(error || "Unknown error");
      els.chat.innerHTML = `
        <article class="setup-guide bootstrap">
          <div class="setup-guide-main">
            <strong>Aimashi 初始化失败</strong>
            <p>${window.aimashiMarkdown.escapeHtml(message)}</p>
          </div>
        </article>
      `;
    });
  };
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => setTimeout(start, 0));
  } else {
    setTimeout(start, 0);
  }
}
startAfterFirstPaint();
renderSendButton();
renderHeaderStatus();
setInterval(refreshRuntime, 2000);

(function wireTrafficLights() {
  const spacer = document.getElementById("trafficSpacer");
  const api = window.aimashi?.window;
  if (!spacer || !api) return;
  spacer.addEventListener("click", (event) => {
    const btn = event.target.closest(".traffic-light");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "close") api.close();
    else if (action === "minimize") api.minimize();
    else if (action === "green") api.green();
  });
  const applyFocus = (focused) => {
    document.body.classList.toggle("window-blurred", !focused);
  };
  const applyFullscreen = (fullscreen) => {
    spacer.dataset.fullscreen = fullscreen ? "true" : "false";
  };
  api.onFocusState?.(applyFocus);
  api.onFullscreen?.(applyFullscreen);
  api.state?.().then((s) => {
    if (s) {
      applyFocus(s.focused);
      applyFullscreen(s.fullscreen);
    }
  }).catch(() => {});
})();
