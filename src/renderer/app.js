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
const scrollbarTimers = new WeakMap();
let scrollbarOverlayEl = null;
let scrollbarOverlayTarget = null;
let scrollbarDrag = null;
let skillPickerHoverCloseTimer = 0;
let appearanceSaveStatusTimer = 0;
let appearanceAutoSaveTimer = 0;
let appearanceAutoSaveSeq = 0;
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
  workbenchFilter: "",
  workbenchSection: "recent",
  skillFilter: "",
  skillCategoryFilter: "",
  skillStatusFilter: "all",
  skillContextMenu: { open: false, x: 0, y: 0, skillId: "" },
  fellowContextMenu: { open: false, x: 0, y: 0, fellowKey: "" },
  messageContextMenu: { open: false, x: 0, y: 0, messageIndex: -1, selectionText: "" },
  replyDraft: null,
  fellowMenuOpen: false,
  profileDialogOpen: false,
  fellowDialogOpen: false,
  fellowDialogMode: "create",
  fellowAvatarPresetGroup: "human",
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
  animatedTraceKeys: new Set()
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
  fellowAvatarDefaultTabs: document.querySelector(".avatar-default-tabs"),
  fellowAvatarDefaults: document.querySelector(".avatar-defaults"),
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
  workbenchSidebar: document.getElementById("workbenchSidebar"),
  sidebarResizeHandle: document.getElementById("sidebarResizeHandle"),
  narrowBackButtons: document.querySelectorAll("[data-narrow-back]"),
  chatView: document.getElementById("chatView"),
  contactsView: document.getElementById("contactsView"),
  skillsView: document.getElementById("skillsView"),
  workbenchView: document.getElementById("workbenchView"),
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
  workbenchSearch: document.getElementById("workbenchSearch"),
  workbenchNav: document.getElementById("workbenchNav"),
  workbenchPageTitle: document.getElementById("workbenchPageTitle"),
  workbenchPageMeta: document.getElementById("workbenchPageMeta"),
  workbenchContent: document.getElementById("workbenchContent"),
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
  mobileRelayHint: document.getElementById("mobileRelayHint")
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

function showAppearanceSaveStatus(text, kind = "ok") {
  if (!els.appearanceSaveStatus) return;
  if (appearanceSaveStatusTimer) window.clearTimeout(appearanceSaveStatusTimer);
  els.appearanceSaveStatus.textContent = text;
  els.appearanceSaveStatus.dataset.kind = kind;
  els.appearanceSaveStatus.classList.toggle("visible", Boolean(text));
  if (!text) return;
  appearanceSaveStatusTimer = window.setTimeout(() => {
    els.appearanceSaveStatus.textContent = "";
    els.appearanceSaveStatus.classList.remove("visible");
    delete els.appearanceSaveStatus.dataset.kind;
    appearanceSaveStatusTimer = 0;
  }, kind === "error" ? 3600 : 1800);
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

function ensureScrollbarOverlay() {
  if (scrollbarOverlayEl) return scrollbarOverlayEl;
  scrollbarOverlayEl = document.createElement("div");
  scrollbarOverlayEl.className = "scrollbar-overlay";
  scrollbarOverlayEl.addEventListener("pointerdown", startScrollbarOverlayDrag);
  scrollbarOverlayEl.addEventListener("pointerenter", () => {
    const target = scrollbarOverlayTarget;
    if (!target) return;
    const previous = scrollbarTimers.get(target);
    if (previous) {
      window.clearTimeout(previous);
      scrollbarTimers.delete(target);
    }
    target.classList.add("scrollbar-visible", "scrollbar-active");
    updateScrollbarOverlay(target);
  });
  scrollbarOverlayEl.addEventListener("pointerleave", () => {
    if (scrollbarDrag?.active) return;
    const target = scrollbarOverlayTarget;
    if (!target) return;
    scheduleScrollbarHide(target, 500);
  });
  document.body.appendChild(scrollbarOverlayEl);
  return scrollbarOverlayEl;
}

function scrollbarOverlayMetrics(target) {
  if (!(target instanceof Element)) return;
  const maxScroll = target.scrollHeight - target.clientHeight;
  if (maxScroll <= 0) return;
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const trackInset = 3;
  const trackHeight = Math.max(0, rect.height - trackInset * 2);
  const thumbHeight = Math.max(28, Math.min(trackHeight, (target.clientHeight / target.scrollHeight) * trackHeight));
  const travel = Math.max(0, trackHeight - thumbHeight);
  return { rect, maxScroll, trackInset, trackHeight, thumbHeight, travel };
}

function updateScrollbarOverlay(target) {
  const metrics = scrollbarOverlayMetrics(target);
  if (!metrics) return;
  const { rect, maxScroll, trackInset, thumbHeight, travel } = metrics;
  const overlay = ensureScrollbarOverlay();
  const thumbTop = rect.top + trackInset + (target.scrollTop / maxScroll) * travel;
  const thumbLeft = rect.right - 10;

  overlay.style.height = `${thumbHeight}px`;
  overlay.style.transform = `translate3d(${Math.round(thumbLeft)}px, ${Math.round(thumbTop)}px, 0)`;
  overlay.classList.add("visible");
  scrollbarOverlayTarget = target;
}

function hideScrollbarOverlay(target) {
  if (scrollbarDrag?.active) return;
  if (target && scrollbarOverlayTarget !== target) return;
  if (!scrollbarOverlayEl) return;
  scrollbarOverlayEl.classList.remove("visible");
  scrollbarOverlayTarget = null;
}

function scheduleScrollbarHide(target, delay = 850) {
  if (!(target instanceof Element)) return;
  const previous = scrollbarTimers.get(target);
  if (previous) window.clearTimeout(previous);
  scrollbarTimers.set(target, window.setTimeout(() => {
    if (scrollbarDrag?.active && scrollbarDrag.target === target) return;
    if (target.matches(":hover") || scrollbarOverlayEl?.matches(":hover")) return;
    target.classList.remove("scrollbar-visible");
    target.classList.remove("scrollbar-active");
    scrollbarTimers.delete(target);
    hideScrollbarOverlay(target);
  }, delay));
}

function showScrollingScrollbar(target) {
  if (!(target instanceof Element)) return;
  if (target === document.documentElement || target === document.body) return;
  if (target.scrollHeight <= target.clientHeight && target.scrollWidth <= target.clientWidth) return;
  updateScrollbarOverlay(target);
  target.classList.add("scrollbar-visible");
  target.classList.add("scrollbar-active");
  scheduleScrollbarHide(target);
}

function scrollableAncestor(node) {
  let current = node instanceof Element ? node : node?.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    const style = window.getComputedStyle(current);
    const canScrollY = current.scrollHeight > current.clientHeight && /(auto|scroll|overlay)/.test(style.overflowY);
    if (canScrollY) return current;
    current = current.parentElement;
  }
  return null;
}

function maybeShowScrollbarForPointer(event) {
  if (scrollbarDrag?.active) return;
  if (scrollbarOverlayEl?.contains(event.target)) return;
  const target = scrollableAncestor(event.target);
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const nearRightEdge = event.clientX >= rect.right - 18 && event.clientX <= rect.right + 4;
  if (!nearRightEdge && scrollbarOverlayTarget !== target) return;
  showScrollingScrollbar(target);
}

function startScrollbarOverlayDrag(event) {
  const target = scrollbarOverlayTarget;
  const metrics = scrollbarOverlayMetrics(target);
  if (!target || !metrics || !scrollbarOverlayEl) return;
  event.preventDefault();
  event.stopPropagation();
  const previous = scrollbarTimers.get(target);
  if (previous) {
    window.clearTimeout(previous);
    scrollbarTimers.delete(target);
  }
  scrollbarOverlayEl.setPointerCapture?.(event.pointerId);
  scrollbarOverlayEl.classList.add("dragging");
  target.classList.add("scrollbar-visible", "scrollbar-active");
  scrollbarDrag = {
    active: true,
    pointerId: event.pointerId,
    target,
    startY: event.clientY,
    startScrollTop: target.scrollTop,
    maxScroll: metrics.maxScroll,
    travel: metrics.travel || 1
  };
}

function updateScrollbarOverlayDrag(event) {
  if (!scrollbarDrag?.active) return;
  event.preventDefault();
  const { target, startY, startScrollTop, maxScroll, travel } = scrollbarDrag;
  const deltaY = event.clientY - startY;
  target.scrollTop = Math.max(0, Math.min(maxScroll, startScrollTop + (deltaY / travel) * maxScroll));
  updateScrollbarOverlay(target);
}

function stopScrollbarOverlayDrag(event) {
  if (!scrollbarDrag?.active) return;
  const { target, pointerId } = scrollbarDrag;
  scrollbarOverlayEl?.releasePointerCapture?.(pointerId);
  scrollbarOverlayEl?.classList.remove("dragging");
  scrollbarDrag = null;
  updateScrollbarOverlay(target);
  scheduleScrollbarHide(target, 650);
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

function fallbackCatalogFromPresets() {
  return Object.values(providerPresets).map((preset) => ({
    id: `${preset.provider}::${preset.model || ""}`,
    provider: preset.provider,
    providerLabel: providerLabels[preset.provider] || preset.provider,
    model: preset.model || "",
    label: preset.model || "Local Model",
    authType: preset.provider === "openai-codex" ? "oauth_external" : "api_key",
    apiKeyEnv: preset.apiKeyEnv,
    baseUrl: preset.baseUrl,
    apiMode: preset.apiMode || "chat_completions"
  }));
}

function modelKey(model = {}) {
  return `${String(model.provider || "").trim()}::${String(model.model || "").trim()}`;
}

function catalogEntries() {
  const base = state.modelCatalog.length ? state.modelCatalog : fallbackCatalogFromPresets();
  const current = state.runtime?.model || {};
  const currentId = modelKey(current);
  if (!current.provider || base.some((entry) => entry.id === currentId)) return base;
  return [
    {
      id: currentId,
      provider: current.provider,
      providerLabel: providerLabels[current.provider] || current.provider,
      model: current.model || "",
      label: current.model || "Custom Model",
      authType: current.provider === "openai-codex" ? "oauth_external" : "api_key",
      apiKeyEnv: current.apiKeyEnv || "",
      baseUrl: current.baseUrl || "",
      apiMode: current.apiMode || "chat_completions"
    },
    ...base
  ];
}

function catalogEntryForModel(model = {}) {
  const key = modelKey(model);
  return catalogEntries().find((entry) => entry.id === key)
    || catalogEntries().find((entry) => entry.provider === model.provider && entry.model === model.model)
    || null;
}

function providerEntries() {
  const providers = new Map();
  for (const entry of catalogEntries()) {
    if (!entry.provider || providers.has(entry.provider)) continue;
    providers.set(entry.provider, {
      ...entry,
      id: entry.provider,
      model: "",
      label: entry.providerLabel || providerLabels[entry.provider] || entry.provider
    });
  }
  return [...providers.values()];
}

function modelsForProvider(provider) {
  return catalogEntries().filter((entry) => entry.provider === provider);
}

function defaultModelForProvider(provider, runtime = state.runtime) {
  const current = runtime?.model || {};
  if (current.provider === provider) {
    const currentEntry = catalogEntryForModel(current);
    if (currentEntry) return currentEntry;
  }
  return modelsForProvider(provider).find((entry) => entry.model) || modelsForProvider(provider)[0] || null;
}

function providerEntryForProvider(provider) {
  return providerEntries().find((entry) => entry.provider === provider) || null;
}

function providerIconSrc(provider = "") {
  const id = String(provider || "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  if (!id || id === "custom") return "";
  return `./assets/provider-icons/${id}.svg`;
}

function modelIconSrc(model = {}) {
  const id = String(model.model || model.id || model.name || "").toLowerCase();
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
    [/hermes|nous/, "nousresearch.png"],
    [/hugging/, "huggingface.png"],
    [/glm|zai|zhipu/, "zhipu.png"],
    [/step/, "step.png"]
  ];
  const haystack = `${id} ${provider}`;
  const match = rules.find(([regex]) => regex.test(haystack));
  if (match) return `./assets/model-icons/${match[1]}`;
  return providerIconSrc(provider);
}

function providerLabel(provider = "") {
  return providerEntryForProvider(provider)?.providerLabel
    || providerLabels[provider]
    || (state.runtime?.connectedProviders || []).find((entry) => entry.provider === provider)?.providerLabel
    || provider
    || "Provider";
}

function selectedProviderEntry() {
  const provider = els.modelSelect?.value || "";
  return provider ? providerEntryForProvider(provider) : null;
}

function selectedModelEntry() {
  const providerEntry = selectedProviderEntry();
  return providerEntry ? defaultModelForProvider(providerEntry.provider, state.runtime) : null;
}

function presetKeyForModel(model = {}) {
  return catalogEntryForModel(model)?.id || "custom";
}

function modelDisplayName(model = {}) {
  const provider = String(model.provider || "").trim();
  const entry = catalogEntryForModel(model);
  const name = entry?.label || String(model.model || "").trim() || (provider === "lmstudio" ? "Local Model" : "未选择模型");
  const label = providerLabel(provider) || "Custom";
  return `${name} | ${label}`;
}

function activeAgentEngine() {
  const persona = activePersona();
  return persona?.agentEngine || persona?.agent_engine || "hermes";
}

function engineConfigForPersona(persona = activePersona()) {
  return persona?.engineConfig || persona?.engine_config || {};
}

function externalModelEntries(engine) {
  if (engine === "claude-code") {
    return [
      { id: "default", provider: "claude-code", providerLabel: "Claude Code", model: "", label: "Claude Code 默认" },
      { id: "claude-opus-4-7", provider: "claude-code", providerLabel: "Claude Code", model: "claude-opus-4-7", label: "Claude Opus 4.7" },
      { id: "claude-sonnet-4-6", provider: "claude-code", providerLabel: "Claude Code", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "opus", provider: "claude-code", providerLabel: "Claude Code", model: "opus", label: "Opus alias" },
      { id: "sonnet", provider: "claude-code", providerLabel: "Claude Code", model: "sonnet", label: "Sonnet alias" }
    ];
  }
  if (engine === "codex") {
    return [
      { id: "default", provider: "codex", providerLabel: "Codex CLI", model: "", label: "Codex 默认" },
      { id: "gpt-5.3-codex-spark", provider: "codex", providerLabel: "Codex CLI", model: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
      { id: "gpt-5.3-codex", provider: "codex", providerLabel: "Codex CLI", model: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { id: "gpt-5.2-codex", provider: "codex", providerLabel: "Codex CLI", model: "gpt-5.2-codex", label: "GPT-5.2 Codex" }
    ];
  }
  return [];
}

function externalPermissionOptions(engine) {
  if (engine === "claude-code") {
    return [
      { value: "default", label: "Ask Permissions", title: "Claude Code 默认权限，危险操作会询问。" },
      { value: "acceptEdits", label: "Accept Edits", title: "Claude Code 自动接受文件编辑，其他危险操作仍按规则处理。" },
      { value: "plan", label: "Plan Mode", title: "Claude Code 计划模式，只读规划。" },
      { value: "auto", label: "Auto Mode", title: "Claude Code 自动判断低风险操作，高风险操作仍会询问。" },
      { value: "bypassPermissions", label: "Bypass Permissions", title: "Claude Code Bypass Permissions，只在完全信任时使用。" }
    ];
  }
  if (engine === "codex") {
    return [
      { value: "default", label: "Ask", title: "Codex 默认 workspace-write + untrusted。" },
      { value: "acceptEdits", label: "Edits", title: "Codex workspace-write + on-request。" },
      { value: "readOnly", label: "Read", title: "Codex 只读模式。" },
      { value: "bypassPermissions", label: "YOLO", title: "Codex danger-full-access + never。" }
    ];
  }
  // Hermes — pull from real engine capabilities (probed via SETTINGS_SCHEMA).
  // Defaults to the upstream ask/yolo/deny set if the probe hasn't completed.
  const modes = (state.engineCapabilities && Array.isArray(state.engineCapabilities.approvalModes) && state.engineCapabilities.approvalModes.length)
    ? state.engineCapabilities.approvalModes
    : ["ask", "yolo", "deny"];
  return modes.map((value) => ({
    value,
    label: APPROVAL_LABELS[value] || value,
    title: APPROVAL_TITLES[value] || ""
  }));
}

function effortOptions(engine) {
  if (engine === "claude-code") {
    return [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Extra high" },
      { value: "max", label: "Max" }
    ];
  }
  if (engine === "codex") {
    return [
      { value: "minimal", label: "Minimal" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Extra high" }
    ];
  }
  // Hermes — pull from real engine capabilities (probed via SETTINGS_SCHEMA at
  // startup). Defaults to low/medium/high if the probe hasn't completed yet.
  const levels = (state.engineCapabilities && Array.isArray(state.engineCapabilities.effortLevels) && state.engineCapabilities.effortLevels.length)
    ? state.engineCapabilities.effortLevels
    : ["low", "medium", "high"];
  return levels.map((value) => ({ value, label: EFFORT_LABELS[value] || value }));
}

function effortLabelForLevel(level = "") {
  const selected = els.effortSelect?.selectedOptions?.[0];
  if (selected?.textContent) return selected.textContent;
  return effortOptions(activeAgentEngine()).find((item) => item.value === level)?.label || "Medium";
}

function setEffortSelectOptions(engine, currentLevel) {
  if (!els.effortSelect) return;
  const previous = els.effortSelect.value;
  const options = effortOptions(engine);
  const ids = new Set(options.map((option) => option.value));
  const nextValue = ids.has(currentLevel) ? currentLevel : ids.has(previous) ? previous : "medium";
  els.effortSelect.innerHTML = "";
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    els.effortSelect.appendChild(option);
  }
  els.effortSelect.value = ids.has(nextValue) ? nextValue : options[0]?.value || "";
}

function syncEffortControl(runtime = state.runtime) {
  if (!els.effortSelect || !els.effortLabel) return;
  const engine = activeAgentEngine();
  const external = engine === "claude-code" || engine === "codex";
  const level = external ? (engineConfigForPersona().effortLevel || "medium") : (runtime?.effort?.level || "medium");
  if (document.activeElement !== els.effortSelect) setEffortSelectOptions(engine, level);
  if (document.activeElement !== els.effortSelect) {
    els.effortSelect.value = [...els.effortSelect.options].some((option) => option.value === level) ? level : "medium";
  }
  setText(els.effortLabel, effortLabelForLevel(els.effortSelect.value));
  els.effortSelect.title = `推理强度：${effortLabelForLevel(els.effortSelect.value)}`;
}

function fillModelFieldsFromPreset(key) {
  const preset = providerPresets[key];
  if (!preset) return;
  els.modelProvider.value = preset.provider;
  els.modelName.value = preset.model;
  els.modelKeyEnv.value = preset.apiKeyEnv;
  els.modelBaseUrl.value = preset.baseUrl;
  els.modelApiMode.value = preset.apiMode;
  els.authMethod.value = key === "openai-codex" ? "openai-codex" : "api-key";
  els.modelPreset.value = key;
  if (key === "openai-codex") els.modelApiKey.value = "";
  updateModelFieldVisibility();
}

function setSelectOptions(select, entries, currentId) {
  if (!select) return;
  const previous = select.value || currentId;
  select.innerHTML = "";
  if (!entries.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "先连接模型提供商";
    select.appendChild(option);
    select.value = "";
    syncQuickModelLabel();
    return;
  }
  const groups = new Map();
  for (const entry of entries) {
    const provider = entry.provider || "custom";
    if (!groups.has(provider)) {
      groups.set(provider, {
        label: entry.providerLabel || providerLabels[provider] || provider,
        entries: []
      });
    }
    groups.get(provider).entries.push(entry);
  }
  for (const group of groups.values()) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const entry of group.entries) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.label || entry.model || "Local Model";
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }
  const ids = new Set(entries.map((entry) => entry.id));
  if (ids.has(previous)) select.value = previous;
  else if (ids.has(currentId)) select.value = currentId;
  else if (entries[0]) select.value = entries[0].id;
  syncQuickModelLabel();
}

function syncQuickModelLabel() {
  if (!els.quickModelLabel || !els.quickModelSelect) return;
  const hasOptions = els.quickModelSelect.options && els.quickModelSelect.options.length > 0;
  if (!hasOptions || els.quickModelSelect.disabled) {
    setText(els.quickModelLabel, "未配置模型");
    return;
  }
  const selected = els.quickModelSelect.selectedOptions?.[0];
  setText(els.quickModelLabel, selected?.textContent || "未配置模型");
}

function permissionLabelForMode(mode = "") {
  const selected = els.permissionMode?.selectedOptions?.[0];
  if (selected?.textContent) return selected.textContent;
  if (mode === "smart") return "Smart";
  if (mode === "ask" || mode === "manual") return "Ask";
  if (mode === "yolo" || mode === "off") return "YOLO";
  if (mode === "deny" || mode === "dontAsk") return "Deny";
  if (mode === "acceptEdits") return activeAgentEngine() === "claude-code" ? "Accept Edits" : "Edits";
  if (mode === "plan") return activeAgentEngine() === "claude-code" ? "Plan Mode" : "Plan";
  if (mode === "auto") return "Auto Mode";
  if (mode === "bypassPermissions") return activeAgentEngine() === "claude-code" ? "Bypass Permissions" : "YOLO";
  if (mode === "readOnly") return "Read";
  return "Ask";
}

function setPermissionSelectOptions(engine, currentMode) {
  if (!els.permissionMode) return;
  const previous = els.permissionMode.value;
  const options = externalPermissionOptions(engine);
  const ids = new Set(options.map((option) => option.value));
  const nextValue = ids.has(currentMode) ? currentMode : ids.has(previous) ? previous : options[0]?.value || "";
  els.permissionMode.innerHTML = "";
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    option.title = item.title || "";
    els.permissionMode.appendChild(option);
  }
  els.permissionMode.value = nextValue;
}

function syncPermissionControl(runtime = state.runtime) {
  if (!els.permissionMode || !els.permissionLabel) return;
  const engine = activeAgentEngine();
  const external = engine === "claude-code" || engine === "codex";
  const mode = external ? (engineConfigForPersona().permissionMode || "default") : (runtime?.permissions?.mode || "manual");
  setPermissionSelectOptions(engine, mode);
  if (document.activeElement !== els.permissionMode) {
    els.permissionMode.value = [...els.permissionMode.options].some((option) => option.value === mode) ? mode : els.permissionMode.options[0]?.value || "";
  }
  setText(els.permissionLabel, permissionLabelForMode(els.permissionMode.value));
  els.permissionMode.title = `权限模式：${permissionLabelForMode(els.permissionMode.value)}`;
  const switcher = els.permissionMode.closest(".permission-switcher");
  switcher?.classList.toggle("yolo", els.permissionMode.value === "yolo" || els.permissionMode.value === "off" || (engine !== "claude-code" && els.permissionMode.value === "bypassPermissions"));
  switcher?.classList.toggle("claude-bypass", engine === "claude-code" && els.permissionMode.value === "bypassPermissions");
}

function setProviderOptions(select, entries, currentProvider) {
  if (!select) return;
  const previous = select.value || currentProvider;
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = entries.length ? "选择要连接的提供商" : "没有更多可添加的提供商";
  select.appendChild(placeholder);
  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = entry.provider;
    option.textContent = entry.providerLabel || entry.label || entry.provider;
    select.appendChild(option);
  }
  const ids = new Set(entries.map((entry) => entry.provider));
  if (ids.has(previous)) select.value = previous;
  else if (ids.has(currentProvider)) select.value = currentProvider;
  else select.value = "";
}

function providerIsConnected(provider, runtime = state.runtime) {
  if (!provider) return false;
  return Boolean((runtime?.connectedProviders || []).some((entry) => entry.provider === provider && entry.hasApiKey));
}

function connectedModelEntries(runtime = state.runtime) {
  const connectedProviders = (runtime?.connectedProviders || []).map((entry) => entry.provider);
  const entries = connectedProviders.flatMap((provider) => modelsForProvider(provider));
  const current = catalogEntryForModel(runtime.model);
  if (current && providerIsConnected(current.provider, runtime) && !entries.some((entry) => entry.id === current.id)) return [current, ...entries];
  return entries;
}

function renderModelSelectors(runtime = state.runtime) {
  const engine = activeAgentEngine();
  if (engine === "claude-code" || engine === "codex") {
    const config = engineConfigForPersona();
    const entries = externalModelEntries(engine);
    setSelectOptions(els.quickModelSelect, entries, config.model || "default");
    if (els.quickModelSelect) els.quickModelSelect.disabled = !entries.length;
    setProviderOptions(els.modelSelect, providerEntries().filter((entry) => !providerIsConnected(entry.provider, runtime)), "");
    return;
  }
  const providers = providerEntries().filter((entry) => !providerIsConnected(entry.provider, runtime));
  const currentId = catalogEntryForModel(runtime?.model || {})?.id || modelKey(runtime?.model || {});
  setProviderOptions(els.modelSelect, providers, "");
  const connectedEntries = connectedModelEntries(runtime);
  setSelectOptions(els.quickModelSelect, connectedEntries, currentId);
  if (els.quickModelSelect) {
    els.quickModelSelect.disabled = !connectedEntries.length;
  }
}

function applyModelEntryToFields(entry) {
  if (!entry) return;
  els.modelProvider.value = entry.provider || "";
  els.modelName.value = entry.model || "";
  els.modelKeyEnv.value = entry.apiKeyEnv || "";
  els.modelBaseUrl.value = entry.baseUrl || "";
  els.modelApiMode.value = entry.apiMode || "";
  els.authMethod.value = String(entry.authType || "").startsWith("oauth") ? entry.provider : "api-key";
}

function modelAuthCopy(entry, runtime = state.runtime) {
  const authType = String(entry?.authType || "api_key");
  if (!entry) return { state: "未选择", hint: "选择提供商后，Aimashi 会显示它需要的登录方式。" };
  if (entry.provider === "openai-codex") {
    return runtime?.auth?.codexLoggedIn
      ? { state: "已授权 OpenAI Codex", hint: "OAuth token 已保存在 Aimashi 私有 runtime；具体 Codex 模型在聊天框下方切换。" }
      : { state: "需要 OpenAI 登录", hint: "选择 OpenAI Codex 后，用 OpenAI 登录完成授权；不需要 API key。" };
  }
  if (authType.startsWith("oauth")) {
    return { state: "需要登录", hint: "这个 Hermes Provider 使用 OAuth。点击登录后，Aimashi 会展示浏览器链接、激活码和登录日志。" };
  }
  if (entry.provider === "lmstudio") {
    return { state: "本地服务", hint: "LM Studio 通常不需要 API key；请确认本地服务已启动并加载模型。" };
  }
  return runtime?.model?.provider === entry.provider && runtime?.model?.hasApiKey
    ? { state: "已保存 API key", hint: "留空保存会继续使用已保存的 key；具体模型在聊天框下方切换。" }
    : { state: "需要 API key", hint: `填写 ${entry.apiKeyEnv || "API Key"} 后保存，Aimashi 会写入私有 runtime 并重启 Hermes。` };
}

function renderConnectedProviders(runtime = state.runtime) {
  if (!els.connectedProviderList) return;
  const providers = runtime?.connectedProviders || [];
  els.connectedProviderList.innerHTML = "";
  if (!providers.length) {
    const empty = document.createElement("div");
    empty.className = "connected-provider-empty";
    empty.textContent = "还没有连接模型提供商";
    els.connectedProviderList.appendChild(empty);
    return;
  }
  for (const provider of providers) {
    const row = document.createElement("div");
    row.className = "connected-provider";
    row.innerHTML = `
      <span class="provider-logo-wrap"><img class="provider-logo" src="${escapeHtml(modelIconSrc({ provider: provider.provider }))}" alt="" onerror="this.style.display='none'"></span>
      <span class="provider-main">
        <strong>${escapeHtml(provider.providerLabel || provider.provider)}</strong>
      </span>
      <span class="provider-check">✓</span>
    `;
    els.connectedProviderList.appendChild(row);
  }
}

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

function normalizeHexColor(value, fallback = DEFAULT_ACCENT_COLOR) {
  const raw = String(value || "").trim();
  const expanded = raw.replace(/^#([0-9a-fA-F]{3})$/, (_, hex) => `#${hex.split("").map((part) => part + part).join("")}`);
  return /^#[0-9a-fA-F]{6}$/.test(expanded) ? expanded.toLowerCase() : fallback;
}

function normalizeListStyle(value) {
  return value === "flush" ? "flush" : DEFAULT_LIST_STYLE;
}

function normalizeSelectionStyle(value) {
  return value === "solid" ? "solid" : DEFAULT_SELECTION_STYLE;
}

function hexToRgb(value) {
  const hex = normalizeHexColor(value).slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16)
  };
}

function relativeLuminance(rgb) {
  const channel = (value) => {
    const next = Math.max(0, Math.min(255, Number(value) || 0)) / 255;
    return next <= 0.03928 ? next / 12.92 : ((next + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function selectionTextColors(rgb) {
  const lightBackground = relativeLuminance(rgb) > 0.56;
  return lightBackground
    ? {
        text: "rgba(0, 0, 0, 0.90)",
        muted: "rgba(0, 0, 0, 0.66)",
        faint: "rgba(0, 0, 0, 0.48)"
      }
    : {
        text: "#ffffff",
        muted: "rgba(255, 255, 255, 0.78)",
        faint: "rgba(255, 255, 255, 0.62)"
      };
}

function fontStackForAppearance(appearance = {}) {
  return fontPresets[appearance.fontPreset || "system"] || fontPresets.system;
}

function applyAppearance(appearance = {}) {
  const theme = appearance.theme === "dark" ? "dark" : "light";
  const accentColor = normalizeHexColor(appearance.accentColor);
  const rgb = hexToRgb(accentColor);
  const userBubbleColor = normalizeHexColor(appearance.userBubbleColor, DEFAULT_USER_BUBBLE_COLOR);
  const userBubbleRgb = hexToRgb(userBubbleColor);
  const userBubbleText = selectionTextColors(userBubbleRgb).text;
  const listStyle = normalizeListStyle(appearance.listStyle);
  const selectionStyle = normalizeSelectionStyle(appearance.selectionStyle);
  const softActive = `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${theme === "dark" ? "0.22" : "0.16"})`;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.listStyle = listStyle;
  document.documentElement.dataset.selectionStyle = selectionStyle;
  document.documentElement.dataset.hoverBackground = appearance.showHoverBackground === false ? "false" : "true";
  document.documentElement.dataset.showUserAvatar = appearance.showUserAvatar === false ? "false" : "true";
  document.documentElement.dataset.showAssistantAvatar = appearance.showAssistantAvatar === false ? "false" : "true";
  document.documentElement.style.setProperty("--app-font", fontStackForAppearance(appearance));
  document.documentElement.style.setProperty("--accent", accentColor);
  document.documentElement.style.setProperty("--accent-rgb", `${rgb.r} ${rgb.g} ${rgb.b}`);
  document.documentElement.style.setProperty("--active", softActive);
  document.documentElement.style.setProperty("--user-bubble", userBubbleColor);
  document.documentElement.style.setProperty("--user-bubble-text", userBubbleText);
  if (selectionStyle === "solid") {
    const textColors = selectionTextColors(rgb);
    document.documentElement.style.setProperty("--list-active", accentColor);
    document.documentElement.style.setProperty("--list-active-text", textColors.text);
    document.documentElement.style.setProperty("--list-active-muted", textColors.muted);
    document.documentElement.style.setProperty("--list-active-faint", textColors.faint);
  } else {
    document.documentElement.style.setProperty("--list-active", softActive);
    document.documentElement.style.setProperty("--list-active-text", accentColor);
    document.documentElement.style.setProperty("--list-active-muted", "var(--muted)");
    document.documentElement.style.setProperty("--list-active-faint", "var(--faint)");
  }
}

function currentAppearanceDraft() {
  return {
    theme: els.appearanceTheme?.value || "light",
    fontPreset: els.appearanceFontPreset?.value || "system",
    accentColor: normalizeHexColor(els.appearanceAccentColor?.value),
    userBubbleColor: normalizeHexColor(els.appearanceUserBubbleColor?.value, DEFAULT_USER_BUBBLE_COLOR),
    showHoverBackground: els.appearanceShowHoverBackground?.getAttribute("aria-checked") !== "false",
    showUserAvatar: els.appearanceShowUserAvatar?.getAttribute("aria-checked") !== "false",
    showAssistantAvatar: els.appearanceShowAssistantAvatar?.getAttribute("aria-checked") !== "false",
    listStyle: normalizeListStyle(els.appearanceListStyle?.value),
    selectionStyle: normalizeSelectionStyle(els.appearanceSelectionStyle?.value)
  };
}

function setSettingsSwitch(button, enabled) {
  if (!button) return;
  button.classList.toggle("active", Boolean(enabled));
  button.setAttribute("aria-checked", enabled ? "true" : "false");
}

function toggleSettingsSwitch(button) {
  const next = button?.getAttribute("aria-checked") !== "true";
  setSettingsSwitch(button, next);
  scheduleAppearanceSave(0);
}

function syncAppearanceControls(appearance = currentAppearanceDraft()) {
  const fontPreset = fontPresets[appearance.fontPreset] ? appearance.fontPreset : "system";
  if (els.appearanceFontPreset) els.appearanceFontPreset.value = fontPreset;
  document.querySelectorAll("[data-font-preset]").forEach((button) => {
    const active = button.dataset.fontPreset === fontPreset;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
  });
  const listStyle = normalizeListStyle(appearance.listStyle);
  if (els.appearanceListStyle) els.appearanceListStyle.value = listStyle;
  document.querySelectorAll("[data-list-style]").forEach((button) => {
    const active = button.dataset.listStyle === listStyle;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
  });
  const selectionStyle = normalizeSelectionStyle(appearance.selectionStyle);
  if (els.appearanceSelectionStyle) els.appearanceSelectionStyle.value = selectionStyle;
  document.querySelectorAll("[data-selection-style]").forEach((button) => {
    const active = button.dataset.selectionStyle === selectionStyle;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
  });
  const accentColor = normalizeHexColor(appearance.accentColor);
  if (els.appearanceAccentColor) els.appearanceAccentColor.value = accentColor;
  if (els.appearanceAccentPreview) els.appearanceAccentPreview.style.backgroundColor = accentColor;
  const userBubbleColor = normalizeHexColor(appearance.userBubbleColor, DEFAULT_USER_BUBBLE_COLOR);
  if (els.appearanceUserBubbleColor) els.appearanceUserBubbleColor.value = userBubbleColor;
  if (els.appearanceUserBubblePreview) els.appearanceUserBubblePreview.style.backgroundColor = userBubbleColor;
  setSettingsSwitch(els.appearanceShowHoverBackground, appearance.showHoverBackground !== false);
  setSettingsSwitch(els.appearanceShowUserAvatar, appearance.showUserAvatar !== false);
  setSettingsSwitch(els.appearanceShowAssistantAvatar, appearance.showAssistantAvatar !== false);
}

function mergeRuntimeAppearance(appearance) {
  state.runtime = {
    ...(state.runtime || {}),
    appearance: {
      ...(state.runtime?.appearance || {}),
      ...appearance
    }
  };
}

async function persistAppearanceDraft(appearance) {
  if (!window.aimashi?.saveAppearance) return;
  const seq = ++appearanceAutoSaveSeq;
  try {
    const runtime = await window.aimashi.saveAppearance(appearance);
    if (seq !== appearanceAutoSaveSeq) return;
    state.runtime = runtime;
    applyAppearance(runtime.appearance || appearance);
    showAppearanceSaveStatus("已保存");
  } catch (error) {
    console.error(error);
    showAppearanceSaveStatus("保存失败", "error");
  }
}

function scheduleAppearanceSave(delay = 160) {
  const next = currentAppearanceDraft();
  applyAppearance(next);
  syncAppearanceControls(next);
  mergeRuntimeAppearance(next);
  showAppearanceSaveStatus("正在保存...");
  if (appearanceAutoSaveTimer) window.clearTimeout(appearanceAutoSaveTimer);
  appearanceAutoSaveTimer = window.setTimeout(() => {
    appearanceAutoSaveTimer = 0;
    persistAppearanceDraft(currentAppearanceDraft());
  }, delay);
}

function initials(name) {
  return (name || "?").trim().slice(0, 2).toUpperCase();
}

function avatarAssetForKey(key = "") {
  let hash = 0;
  for (const char of String(key || "aimashi")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const index = (hash % 16) + 1;
  return `./assets/avatars/${String(index).padStart(2, "0")}.png`;
}

const AVATAR_MIN_ZOOM = 1;
const DEFAULT_AVATAR_CROP = { x: 50, y: 50, zoom: 1 };
const DEFAULT_PRESET_AVATAR_CROP = { x: 50, y: 13.5, zoom: 1.72 };

const avatarPresetGroupTabs = [
  { key: "human", label: "人形" },
  { key: "pet", label: "宠物" }
];

const avatarPresetGroups = {
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
    return {
      name: `宠物 ${id}`,
      src: `./assets/avatars-pet/${id}.png`,
      thumb: `./assets/avatar-thumbs-pet/${id}.png`,
      crop: { x: 50, y: 50, zoom: 1 }
    };
  })
};

const avatarPresets = Object.values(avatarPresetGroups).flat();

function defaultAvatarAssets() {
  return avatarPresetGroups.human.map((preset) => preset.src);
}

function canonicalAvatarSrc(src) {
  return String(src || "").trim().replace("./assets/avatar-icons/", "./assets/avatars/");
}

function avatarPresetBySrc(src) {
  const canonical = canonicalAvatarSrc(src);
  return avatarPresets.find((preset) => preset.src === canonical) || null;
}

function avatarPresetGroupForSrc(src) {
  const canonical = canonicalAvatarSrc(src);
  return avatarPresetGroupTabs.find(({ key }) =>
    avatarPresetGroups[key]?.some((preset) => preset.src === canonical)
  )?.key || "";
}

function avatarThumbForSrc(src) {
  const preset = avatarPresetBySrc(src);
  if (!preset) return "";
  if (preset.thumb) return preset.thumb;
  return canonicalAvatarSrc(preset.src).replace("./assets/avatars/", "./assets/avatar-thumbs/");
}

function avatarDefaultCropForSrc(src) {
  const preset = avatarPresetBySrc(src);
  if (!preset) return { ...DEFAULT_AVATAR_CROP };
  return { ...DEFAULT_PRESET_AVATAR_CROP, ...(preset.crop || {}) };
}

function isNeutralAvatarCrop(crop) {
  if (!crop) return true;
  const c = normalizeCrop(crop);
  return c.x === 50 && c.y === 50 && Math.abs(c.zoom - 1) < 0.001;
}

function avatarCropForImage(image, crop) {
  if (avatarPresetBySrc(image) && isNeutralAvatarCrop(crop)) {
    return avatarDefaultCropForSrc(image);
  }
  return crop || DEFAULT_AVATAR_CROP;
}

function cropsClose(a = {}, b = {}) {
  const left = normalizeCrop(a);
  const right = normalizeCrop(b);
  return Math.abs(left.x - right.x) < 0.01
    && Math.abs(left.y - right.y) < 0.01
    && Math.abs(left.zoom - right.zoom) < 0.001;
}

function avatarImageSrc(value) {
  const raw = canonicalAvatarSrc(value);
  if (!raw) return "";
  if (/^(https?:|file:|data:)/i.test(raw)) return raw;
  if (raw.startsWith("./") || raw.startsWith("../")) return raw;
  return `file://${raw}`;
}

function normalizeCrop(crop = {}) {
  const num = (value, fallback, min, max) => {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.max(min, Math.min(max, next));
  };
  return {
    x: num(crop.x, 50, 0, 100),
    y: num(crop.y, 50, 0, 100),
    zoom: num(crop.zoom, 1, AVATAR_MIN_ZOOM, 2.4)
  };
}

function avatarBackgroundStyle(image, crop = {}, color = "#5e5ce6") {
  const src = avatarImageSrc(image) || image || "";
  const effectiveCrop = avatarCropForImage(image, crop);
  const c = normalizeCrop(effectiveCrop);
  const imagePart = src ? `background-image:url('${escapeHtml(src)}');` : "";
  const backgroundColor = src ? "transparent" : escapeHtml(color);
  const position = `${c.x}% ${c.y}%`;
  return `background-color:${backgroundColor};${imagePart}background-size:${Math.round(c.zoom * 100)}%;background-position:${position};background-repeat:no-repeat;`;
}

function avatarThumbBackgroundStyle(image, crop = {}, color = "#5e5ce6") {
  const thumb = avatarThumbForSrc(image);
  const effectiveCrop = avatarCropForImage(image, crop);
  if (thumb && cropsClose(effectiveCrop, avatarDefaultCropForSrc(image))) {
    const src = avatarImageSrc(thumb);
    return `background-color:transparent;background-image:url('${escapeHtml(src)}');background-size:cover;background-position:center;background-repeat:no-repeat;`;
  }
  return avatarBackgroundStyle(image, crop, color);
}

function applyFellowAvatar(el, fellow) {
  if (!el) return;
  el.textContent = "";
  const image = fellow?.avatarImage || avatarAssetForKey(fellow?.key);
  el.setAttribute("style", avatarThumbBackgroundStyle(image, fellow?.avatarCrop, fellow?.color || "#5e5ce6"));
}

function applyAvatar(el, text, color, image) {
  if (!el) return;
  el.textContent = text || "?";
  el.style.background = color || "#111827";
  el.style.backgroundImage = "";
  el.style.backgroundSize = "";
  el.style.backgroundPosition = "";
  const src = avatarImageSrc(image);
  if (src) {
    el.textContent = "";
    el.style.backgroundImage = `url("${src.replaceAll('"', "%22")}")`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
  }
}

function applyUserAvatar(el, user = {}) {
  if (!el) return;
  const image = user.avatarImage || "";
  const text = user.avatarText || initials(user.displayName || "Boss");
  if (image) {
    el.textContent = "";
    el.setAttribute("style", avatarThumbBackgroundStyle(image, user.avatarCrop, user.avatarColor || "#111827"));
    return;
  }
  applyAvatar(el, text, user.avatarColor || "#111827", "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Icon path data adapted from ByteDance IconPark (Apache-2.0).
const ICON_PARK = {
  addPic: '<path d="M38 21V40C38 41.1046 37.1046 42 36 42H8C6.89543 42 6 41.1046 6 40V12C6 10.8954 6.89543 10 8 10H26.3636" stroke="currentColor" stroke-width="4" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.0005 31.0308L18.0005 23L21.0005 26L24.5005 20.5L32.0005 31.0308H12.0005Z" fill="none" stroke="currentColor" stroke-width="4" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M34.0005 10H42.0005" stroke="currentColor" stroke-width="4" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M37.9946 5.79541V13.7954" stroke="currentColor" stroke-width="4" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/>',
  copy: '<path d="M13 12.4316V7.8125C13 6.2592 14.2592 5 15.8125 5H40.1875C41.7408 5 43 6.2592 43 7.8125V32.1875C43 33.7408 41.7408 35 40.1875 35H35.5163" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M32.1875 13H7.8125C6.2592 13 5 14.2592 5 15.8125V40.1875C5 41.7408 6.2592 43 7.8125 43H32.1875C33.7408 43 35 41.7408 35 40.1875V15.8125C35 14.2592 33.7408 13 32.1875 13Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  delete: '<path d="M9 10V44H39V10H9Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M20 20V33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M28 20V33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 10H44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 10L19.289 4H28.7771L32 10H16Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  documentFolder: '<path d="M32 6H22V42H32V6Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M42 6H32V42H42V6Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M10 6L18 7L14.5 42L6 41L10 6Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M37 18V15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M27 18V15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  edit: '<path d="M7 42H43" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 26.7199V34H18.3172L39 13.3081L31.6951 6L11 26.7199Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  folderOpen: '<path d="M4 9V41L9 21H39.5V15C39.5 13.8954 38.6046 13 37.5 13H24L19 7H6C4.89543 7 4 7.89543 4 9Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M40 41L44 21H8.8125L4 41H40Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  history: '<path d="M5.81836 6.72729V14H13.0911" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 24C4 35.0457 12.9543 44 24 44V44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C16.598 4 10.1351 8.02111 6.67677 13.9981" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24.005 12L24.0038 24.0088L32.4832 32.4882" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  message: '<path d="M4 6H44V36H29L24 41L19 36H4V6Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M23 21H25.0025" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M33.001 21H34.9999" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M13.001 21H14.9999" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  pin: '<path d="M10.6963 17.5042C13.3347 14.8657 16.4701 14.9387 19.8781 16.8076L32.62 9.74509L31.8989 4.78683L43.2126 16.1005L38.2656 15.3907L31.1918 28.1214C32.9752 31.7589 33.1337 34.6647 30.4953 37.3032C30.4953 37.3032 26.235 33.0429 22.7171 29.525L6.44305 41.5564L18.4382 25.2461C14.9202 21.7281 10.6963 17.5042 10.6963 17.5042Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  preview: '<path d="M24 36C35.0457 36 44 24 44 24C44 24 35.0457 12 24 12C12.9543 12 4 24 4 24C4 24 12.9543 36 24 36Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 29C26.7614 29 29 26.7614 29 24C29 21.2386 26.7614 19 24 19C21.2386 19 19 21.2386 19 24C19 26.7614 21.2386 29 24 29Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  quote: '<path fill-rule="evenodd" clip-rule="evenodd" d="M18.8533 9.11587C11.3227 13.9521 7.13913 19.5811 6.30256 26.0028C5.00021 35.9999 13.9404 40.8932 18.4703 36.4966C23.0002 32.1 20.2848 26.5195 17.0047 24.9941C13.7246 23.4686 11.7187 23.9999 12.0686 21.9614C12.4185 19.923 17.0851 14.2712 21.1849 11.6391C21.4569 11.4078 21.5604 10.959 21.2985 10.6185C21.1262 10.3946 20.7883 9.95545 20.2848 9.30102C19.8445 8.72875 19.4227 8.75017 18.8533 9.11587Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M38.6789 9.11587C31.1484 13.9521 26.9648 19.5811 26.1282 26.0028C24.8259 35.9999 33.7661 40.8932 38.296 36.4966C42.8259 32.1 40.1105 26.5195 36.8304 24.9941C33.5503 23.4686 31.5443 23.9999 31.8943 21.9614C32.2442 19.923 36.9108 14.2712 41.0106 11.6391C41.2826 11.4078 41.3861 10.959 41.1241 10.6185C40.9519 10.3946 40.614 9.95545 40.1105 9.30102C39.6702 8.72875 39.2484 8.75017 38.6789 9.11587Z" fill="currentColor"/>',
  translate: '<path d="M28.2857 37H39.7143M42 42L39.7143 37M26 42L28.2857 37M28.2857 37L34 24L39.7143 37H28.2857Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 6L17 9" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11H28" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 16C10 16 11.7895 22.2609 16.2632 25.7391C20.7368 29.2174 28 32 28 32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 11C24 11 22.2105 19.2174 17.7368 23.7826C13.2632 28.3478 6 32 6 32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>'
};

function iconParkIcon(name, className = "menu-item-icon") {
  const body = ICON_PARK[name];
  if (!body) return "";
  return `<span class="${className}" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" focusable="false">${body}</svg></span>`;
}

function menuItemHtml({ icon, label, attrs = "", className = "" }) {
  return `<button class="${className}" type="button" ${attrs}>${iconParkIcon(icon)}<span>${escapeHtml(label)}</span></button>`;
}

function renderInlineMarkdown(value) {
  const codes = [];
  const protectedText = String(value || "").replace(/`([^`\n]+)`/g, (_match, code) => {
    const index = codes.push(code) - 1;
    return `@@AIMASHI_INLINE_CODE_${index}@@`;
  });
  let html = escapeHtml(protectedText);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\n/g, "<br>");
  for (let index = 0; index < codes.length; index++) {
    html = html.replace(
      `@@AIMASHI_INLINE_CODE_${index}@@`,
      `<code class="inline-code" tabindex="0" title="点击复制">${escapeHtml(codes[index])}</code>`
    );
  }
  return html;
}

function codeLanguageId(language = "") {
  const raw = String(language || "").trim().toLowerCase();
  const aliases = {
    javascript: "js",
    typescript: "ts",
    shell: "bash",
    sh: "bash",
    zsh: "bash",
    yml: "yaml"
  };
  return aliases[raw] || raw || "text";
}

function codeLanguageLabel(language = "") {
  const id = codeLanguageId(language);
  const labels = {
    js: "JavaScript",
    jsx: "JSX",
    ts: "TypeScript",
    tsx: "TSX",
    json: "JSON",
    bash: "Shell",
    yaml: "YAML",
    text: "Text"
  };
  return labels[id] || id.toUpperCase();
}

function highlightPlainSegment(segment, language) {
  const id = codeLanguageId(language);
  const keywords = id === "bash"
    ? new Set(["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "in", "function", "return", "export", "local", "set"])
    : new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "class", "extends", "new", "try", "catch", "finally", "throw", "async", "await", "import", "from", "export", "default", "typeof", "instanceof", "in", "of", "this", "super"]);
  const source = String(segment || "");
  const tokenPattern = /--?[A-Za-z0-9][\w-]*|\b[A-Za-z_$][\w$-]*\b|\b\d+(?:\.\d+)?\b|[=!<>|&+\-*/%?:.,;()[\]{}]+/g;
  let cursor = 0;
  let html = "";
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    const offset = match.index ?? 0;
    if (offset > cursor) html += escapeHtml(source.slice(cursor, offset));
    const escaped = escapeHtml(token);
    if (/^\d/.test(token)) html += `<span class="syntax-number">${escaped}</span>`;
    else if (id === "bash" && token.startsWith("-")) html += `<span class="syntax-parameter">${escaped}</span>`;
    else if (/^[=!<>|&+\-*/%?:]+$/.test(token)) html += `<span class="syntax-operator">${escaped}</span>`;
    else if (/^[.,;()[\]{}]+$/.test(token)) html += `<span class="syntax-punctuation">${escaped}</span>`;
    else if (keywords.has(token)) html += `<span class="syntax-keyword">${escaped}</span>`;
    else if (["true", "false", "null", "undefined"].includes(token)) html += `<span class="syntax-literal">${escaped}</span>`;
    else {
      const before = source.slice(0, offset).replace(/\s+$/g, "");
      const after = source.slice(offset + token.length).replace(/^\s+/g, "");
      if (before.endsWith(".")) html += `<span class="syntax-property">${escaped}</span>`;
      else if (after.startsWith("(")) html += `<span class="syntax-function">${escaped}</span>`;
      else if (/^[A-Z][A-Za-z0-9_$]*$/.test(token)) html += `<span class="syntax-class">${escaped}</span>`;
      else html += `<span class="syntax-variable">${escaped}</span>`;
    }
    cursor = offset + token.length;
  }
  if (cursor < source.length) html += escapeHtml(source.slice(cursor));
  return html;
}

function highlightCode(code, language = "") {
  const id = codeLanguageId(language);
  if (!["js", "jsx", "ts", "tsx", "json", "bash"].includes(id)) return escapeHtml(code);
  const source = String(code || "");
  const parts = [];
  const pattern = id === "json"
    ? /("(?:\\.|[^"\\])*")|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|\b(true|false|null)\b|([{}[\]:,])/gi
    : /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|(\$[A-Za-z_][\w]*|\$\{[^}]+\})/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(highlightPlainSegment(source.slice(cursor, index), id));
    const token = match[0];
    if (id === "json") {
      const after = source.slice(index + token.length).replace(/^\s+/g, "");
      if (match[1] && after.startsWith(":")) parts.push(`<span class="syntax-property">${escapeHtml(token)}</span>`);
      else if (match[1]) parts.push(`<span class="syntax-string">${escapeHtml(token)}</span>`);
      else if (match[2]) parts.push(`<span class="syntax-number">${escapeHtml(token)}</span>`);
      else if (match[3]) parts.push(`<span class="syntax-literal">${escapeHtml(token)}</span>`);
      else parts.push(`<span class="syntax-punctuation">${escapeHtml(token)}</span>`);
    } else if (match[1]) {
      parts.push(`<span class="syntax-string">${escapeHtml(token)}</span>`);
    } else if (match[2]) {
      parts.push(`<span class="syntax-comment">${escapeHtml(token)}</span>`);
    } else if (match[3]) {
      parts.push(`<span class="syntax-variable">${escapeHtml(token)}</span>`);
    }
    cursor = index + token.length;
  }
  if (cursor < source.length) parts.push(highlightPlainSegment(source.slice(cursor), id));
  return parts.join("");
}

function renderCodeBlock(code, language = "") {
  const lang = codeLanguageId(language).replace(/[^A-Za-z0-9_+.-]/g, "").slice(0, 24);
  const label = codeLanguageLabel(lang);
  return `
    <figure class="message-code-block" data-language="${escapeHtml(lang)}">
      <figcaption>
        <span>${escapeHtml(label)}</span>
        <button type="button" data-copy-code aria-label="复制代码" title="复制代码">⧉</button>
      </figcaption>
      <pre><code class="syntax-code language-${escapeHtml(lang)}">${highlightCode(String(code || "").replace(/\n$/, ""), lang)}</code></pre>
    </figure>
  `;
}

function renderMarkdown(value) {
  const lines = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let fence = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join("\n"))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  const flushTextBlocks = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^```([A-Za-z0-9_+.-]*)\s*$/);
    if (fence) {
      if (fenceMatch) {
        html.push(renderCodeBlock(fence.lines.join("\n"), fence.language));
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      flushTextBlocks();
      fence = { language: fenceMatch[1] || "", lines: [] };
      continue;
    }
    if (!line.trim()) {
      flushTextBlocks();
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      flushTextBlocks();
      html.push('<hr class="message-divider">');
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushTextBlocks();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(unordered[1]);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }
    paragraph.push(line);
  }
  flushTextBlocks();
  if (fence) html.push(renderCodeBlock(fence.lines.join("\n"), fence.language));
  return html.join("");
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
  return `<time class="message-time" datetime="${escapeHtml(date.toISOString())}" title="${escapeHtml(date.toLocaleString())}">${escapeHtml(formatMessageTime(date))}</time>`;
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
  const src = String(attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || "").trim();
  if (!src || !src.startsWith("data:image/")) return `<span>${escapeHtml(attachmentGlyph(attachment))}</span>`;
  return `<img class="${escapeHtml(className)}" src="${escapeHtml(src)}" alt="">`;
}

function renderAttachmentChip(attachment = {}) {
  const image = (attachment.kind || attachmentKind(attachment)) === "image" && (attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl);
  const href = String(attachment.dataUrl || "").startsWith("data:") ? String(attachment.dataUrl) : "";
  const tag = href ? "a" : "span";
  const download = href ? ` href="${escapeHtml(href)}" download="${escapeHtml(attachment.name || "attachment")}"` : "";
  return `
    <${tag} class="message-attachment${image ? " image" : ""}"${download} title="${escapeHtml(attachment.path || attachment.name || "")}">
      ${renderAttachmentThumb(attachment, "message-attachment-thumb")}
      <strong>${escapeHtml(attachment.name || "附件")}</strong>
      <em>${escapeHtml(formatBytes(attachment.size))}</em>
    </${tag}>
  `;
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

function queueGeneratedFileFetches(messages = []) {
  const paths = [...new Set(messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => extractLocalFilePaths(message.content)))];
  for (const filePath of paths) {
    if (state.generatedFiles.has(filePath)) continue;
    state.generatedFiles.set(filePath, { status: "loading" });
    window.aimashi.fetchFileAttachment?.({ path: filePath })
      .then((attachment) => {
        state.generatedFiles.set(filePath, { status: "ready", attachment });
        renderChat();
      })
      .catch(() => {
        state.generatedFiles.set(filePath, { status: "error" });
        renderChat();
      });
  }
}

function ensureReadState() {
  if (!state.chatStore || typeof state.chatStore !== "object") {
    state.chatStore = { schema_version: 1, readAt: {}, sessions: {} };
  }
  if (!state.chatStore.readAt || typeof state.chatStore.readAt !== "object") {
    state.chatStore.readAt = {};
  }
  return state.chatStore.readAt;
}

function latestAssistantMessageTime(personaKey) {
  const sessions = state.chatStore.sessions?.[personaKey] || [];
  let latest = "";
  for (const session of sessions) {
    for (const message of session.messages || []) {
      if (message.role !== "assistant" || message.transient || !String(message.content || "").trim()) continue;
      const createdAt = message.createdAt || session.updatedAt || session.createdAt || "";
      if (String(createdAt).localeCompare(latest) > 0) latest = String(createdAt);
    }
  }
  return latest;
}

function initializeReadStateForPersonas(personas) {
  const readAt = ensureReadState();
  let changed = false;
  for (const persona of personas) {
    if (!persona?.key || readAt[persona.key]) continue;
    readAt[persona.key] = latestAssistantMessageTime(persona.key) || nowIso();
    changed = true;
  }
  if (changed) persistReadStateQuietly();
}

function unreadCountForPersona(personaKey) {
  const readAt = ensureReadState()[personaKey] || "";
  let count = 0;
  for (const session of state.chatStore.sessions?.[personaKey] || []) {
    for (const message of session.messages || []) {
      if (message.role !== "assistant" || message.transient || !String(message.content || "").trim()) continue;
      const createdAt = String(message.createdAt || session.updatedAt || session.createdAt || "");
      if (createdAt && createdAt.localeCompare(readAt) > 0) count += 1;
    }
  }
  return count;
}

function totalUnreadCount(personas) {
  return personas.reduce((total, persona) => total + unreadCountForPersona(persona.key), 0);
}

async function persistReadStateQuietly() {
  try {
    if (window.aimashi?.saveChatReadState) {
      const readAt = { ...ensureReadState() };
      await window.aimashi.saveChatReadState({ readAt });
      state.chatStore.readAt = { ...state.chatStore.readAt, ...readAt };
    }
  } catch (error) {
    console.error("Failed to persist read state", error);
  }
}

function markPersonaRead(personaKey, persist = true) {
  if (!personaKey) return;
  const latest = latestAssistantMessageTime(personaKey);
  if (!latest) return;
  const readAt = ensureReadState();
  const next = latest;
  if (String(next).localeCompare(readAt[personaKey] || "") <= 0) return;
  readAt[personaKey] = next;
  if (persist) persistReadStateQuietly();
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

async function loadChatSessions() {
  state.chatStore = await window.aimashi.loadChatSessions();
  const personas = state.runtime?.fellows || state.runtime?.personas || [];
  for (const persona of personas) {
    const sessions = sessionsForPersona(persona.key);
    state.activeSessionIdByPersona[persona.key] = sessions[0]?.id;
  }
}

async function loadModelCatalog() {
  try {
    const rows = await window.aimashi.loadModelCatalog();
    state.modelCatalog = Array.isArray(rows) && rows.length ? rows : fallbackCatalogFromPresets();
  } catch (error) {
    console.error("Failed to load Hermes model catalog", error);
    state.modelCatalog = fallbackCatalogFromPresets();
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
  // effortOptions()/externalPermissionOptions() — those now read state.engineCapabilities.
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
  renderSkillLibrary();
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
    if (state.selectedSkillId) await selectSkill(state.selectedSkillId, false);
  } catch (error) {
    console.error("Failed to load local skills", error);
    state.skillLibrary = { plugins: [], sources: [], extensions: [], connectors: [], roots: [], skills: [] };
    state.selectedSkillId = "";
    state.selectedSkillDetail = null;
  } finally {
    state.skillsLoading = false;
    renderSkillLibrary();
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
  const providerEntry = selectedProviderEntry();
  const entry = selectedModelEntry();
  const authType = String(entry?.authType || "api_key");
  const isConnected = providerIsConnected(entry?.provider, runtime);
  const isCodex = entry ? entry.provider === "openai-codex" : false;
  const needsApiKey = Boolean(entry) && !isConnected && !isCodex && !authType.startsWith("oauth") && entry?.provider !== "lmstudio";
  const needsOauth = Boolean(entry) && !isConnected && (isCodex || authType.startsWith("oauth"));
  const canConnectWithoutKey = Boolean(entry) && !isConnected && entry.provider === "lmstudio";
  els.modelApiKeyField?.classList.toggle("hidden", !needsApiKey);
  els.codexInlineAuth.classList.toggle("hidden", !needsOauth);
  els.modelConnectButton?.classList.toggle("hidden", !(needsApiKey || canConnectWithoutKey));
  if (entry) {
    applyModelEntryToFields(entry);
    const copy = modelAuthCopy(entry, runtime);
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

async function refreshDaemonPairing() {
  try {
    let pairing = await window.aimashi.daemonPairing();
    if (!pairing?.running && window.aimashi.startDaemon) {
      await window.aimashi.startDaemon();
      pairing = await window.aimashi.daemonPairing();
    }
    state.runtime = {
      ...(state.runtime || {}),
      daemon: {
        ...(state.runtime?.daemon || {}),
        ...pairing,
        token: undefined
      }
    };
    renderMobilePairing(pairing);
    return pairing;
  } catch (error) {
    setText(els.mobileDaemonStatus, `Error: ${error.message}`);
    throw error;
  }
}

function renderMobilePairing(daemon = state.runtime?.daemon || {}) {
  if (!els.mobileLanToggle) return;
  const settings = daemon.settings || {};
  const running = Boolean(daemon.running);
  const host = settings.host || daemon.host || "127.0.0.1";
  const lanEnabled = host === "0.0.0.0" || host === "::";
  const links = Array.isArray(daemon.links) && daemon.links.length
    ? daemon.links
    : Array.isArray(daemon.connectUrls)
      ? daemon.connectUrls.map((url) => `${url}/mobile/`)
      : [];
  const link = links[0] || "";
  setText(els.mobileDaemonStatus, running ? "Aimashi 后台已运行" : daemon.starting ? "Aimashi 后台启动中" : "Aimashi 后台未运行");
  setText(els.mobileDaemonUrl, lanEnabled
    ? "同一局域网内扫描二维码连接；公司、校园或公共 Wi-Fi 可能会禁止设备互访。"
    : "关闭时只允许本机访问，不生成手机配对入口。");
  els.mobileLanToggle.classList.toggle("active", lanEnabled);
  els.mobileLanToggle.setAttribute("aria-checked", String(lanEnabled));
  els.mobileLanToggle.disabled = Boolean(daemon.starting);
  if (els.mobilePairingBox) els.mobilePairingBox.classList.toggle("hidden", !lanEnabled || !link);
  renderQr(els.mobilePairingQr, lanEnabled ? link : "");
  if (els.mobilePairingReveal) {
    els.mobilePairingReveal.classList.toggle("hidden", !lanEnabled || !link);
    setText(els.mobilePairingReveal, state.mobileLanLinkExpanded ? "隐藏链接" : "显示链接");
  }
  if (els.mobilePairingLink) {
    const showLink = lanEnabled && Boolean(link) && state.mobileLanLinkExpanded;
    els.mobilePairingLink.classList.toggle("hidden", !showLink);
    els.mobilePairingLink.dataset.link = link;
    setText(els.mobilePairingLink, link);
  }
  if (els.mobilePairingHint) {
    els.mobilePairingHint.textContent = lanEnabled
      ? "扫描二维码即可连接；展开链接后点一下会复制。"
      : "打开局域网访问后才会生成配对二维码。";
  }
}

async function refreshRelayPairing() {
  if (!window.aimashi?.relayStatus) return null;
  try {
    const relay = await window.aimashi.relayStatus();
    state.runtime = {
      ...(state.runtime || {}),
      relay: {
        ...(state.runtime?.relay || {}),
        ...relay,
        secret: undefined
      }
    };
    renderRelayPairing(relay);
    return relay;
  } catch (error) {
    setText(els.mobileRelayHint, `Error: ${error.message}`);
    throw error;
  }
}

function renderRelayPairing(relay = state.runtime?.relay || {}) {
  if (!els.mobileRelayToggle) return;
  const enabled = Boolean(relay.enabled);
  const connected = Boolean(relay.connected);
  const peers = Number(relay.mobilePeers || 0);
  const link = String(relay.pairingLink || "");
  if (els.mobileRelayToggle) {
    els.mobileRelayToggle.classList.toggle("active", enabled);
    els.mobileRelayToggle.setAttribute("aria-checked", String(enabled));
  }
  if (els.mobileRelayBox) els.mobileRelayBox.classList.toggle("hidden", !enabled);
  if (els.mobileRelayUrl && document.activeElement !== els.mobileRelayUrl) {
    els.mobileRelayUrl.value = String(relay.url || "");
  }
  renderQr(els.mobileRelayQr, enabled ? link : "");
  if (els.mobileRelayReveal) {
    els.mobileRelayReveal.classList.toggle("hidden", !enabled || !link);
    setText(els.mobileRelayReveal, state.mobileRelayLinkExpanded ? "隐藏链接" : "显示链接");
  }
  if (els.mobileRelayLink) {
    const showLink = enabled && Boolean(link) && state.mobileRelayLinkExpanded;
    els.mobileRelayLink.classList.toggle("hidden", !showLink);
    els.mobileRelayLink.dataset.link = link;
    setText(els.mobileRelayLink, link);
  }
  if (els.mobileRelayHint) {
    els.mobileRelayHint.textContent = enabled
      ? connected
        ? peers ? `已连接，${peers} 台手机在线。` : "已连接。扫描二维码即可远程连接。"
        : `等待 relay：${relay.lastError || relay.url || "未连接"}`
      : "通过 Aimashi Relay 中继连接，不要求手机和电脑在同一网络。";
  }
}

async function applyDaemonHost(host) {
  if (!window.aimashi?.saveDaemonSettings) return null;
  setText(els.mobilePairingHint, "正在切换手机访问范围...");
  await window.aimashi.saveDaemonSettings({ host });
  await window.aimashi.stopDaemon?.();
  await window.aimashi.startDaemon?.();
  return refreshDaemonPairing();
}

function currentMobilePairingLink() {
  return String(els.mobilePairingLink?.dataset?.link || els.mobilePairingLink?.value || els.mobilePairingLink?.textContent || "").trim();
}

function currentRelayPairingLink() {
  return String(els.mobileRelayLink?.dataset?.link || els.mobileRelayLink?.textContent || "").trim();
}

const workbenchSections = [
  {
    id: "recent",
    title: "最近",
    subtitle: "从近期对话继续整理",
    detail: "适合把刚聊完的修复、调研、创作想法临时收住。"
  },
  {
    id: "projects",
    title: "项目",
    subtitle: "会话变成可推进的事项",
    detail: "例如 Aimashi 输入体验修复、Hermes runtime 调查、消息 UI 重设计。"
  },
  {
    id: "drafts",
    title: "草稿",
    subtitle: "文案、prompt、方案草稿",
    detail: "适合收集产品命名、角色设定、回复模板和待润色文本。"
  },
  {
    id: "materials",
    title: "素材",
    subtitle: "文件、截图、生成物",
    detail: "适合放代码补丁、截图、图片、桌宠资源和工具结果摘要。"
  }
];

function workbenchSectionRows() {
  const sessionCount = sessionsForPersona(state.activeKey).filter(hasPersistableMessages).length;
  return workbenchSections.map((section) => ({
    ...section,
    count: section.id === "recent" ? sessionCount : 0
  }));
}

function renderWorkbenchNav() {
  if (!els.workbenchNav) return;
  const filter = state.workbenchFilter.trim().toLowerCase();
  const rows = workbenchSectionRows().filter((row) => (
    !filter || `${row.title} ${row.subtitle} ${row.detail}`.toLowerCase().includes(filter)
  ));
  els.workbenchNav.innerHTML = rows.length ? rows.map((row) => `
    <button class="workbench-nav-row${row.id === state.workbenchSection ? " active" : ""}" type="button" data-workbench-section="${escapeHtml(row.id)}">
      <span>
        <strong>${escapeHtml(row.title)}</strong>
        <small>${escapeHtml(row.subtitle)}</small>
      </span>
      <em>${escapeHtml(String(row.count))}</em>
    </button>
  `).join("") : `<div class="workbench-empty-nav">没有匹配的工作台分组</div>`;
}

function renderWorkbenchAction({ title, desc, meta }) {
  return `
    <button class="workbench-action" type="button" disabled>
      <span>
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(desc)}</small>
      </span>
      <em>${escapeHtml(meta || "即将支持")}</em>
    </button>
  `;
}

function renderWorkbenchExample({ title, desc, tags }) {
  return `
    <article class="workbench-example">
      <header>
        <strong>${escapeHtml(title)}</strong>
        <span>示例</span>
      </header>
      <p>${escapeHtml(desc)}</p>
      <div>
        ${tags.map((tag) => `<em>${escapeHtml(tag)}</em>`).join("")}
      </div>
    </article>
  `;
}

function renderWorkbench() {
  renderWorkbenchNav();
  if (!els.workbenchContent) return;
  const active = workbenchSections.find((section) => section.id === state.workbenchSection) || workbenchSections[0];
  const currentSession = activeSession();
  const currentFellow = activePersona();
  const exchangeCount = (currentSession.messages || []).filter((message) => !message.transient && String(message.content || "").trim()).length;
  setText(els.workbenchPageTitle, "工作台");
  setText(els.workbenchPageMeta, `${active.title} · ${active.detail}`);
  els.workbenchContent.innerHTML = `
    <section class="workbench-hero">
      <div>
        <span class="workbench-kicker">Workbench</span>
        <h2>把聊天里的过程，整理成下一步能继续用的东西。</h2>
        <p>这里先作为 Aimashi 的第四个入口：项目、草稿、素材和当前任务都可以从对话里沉淀出来。第一版只搭骨架，等方向明确后再接真实存储。</p>
      </div>
      <aside>
        <span>当前上下文</span>
        <strong>${escapeHtml(currentSession.title || "新对话")}</strong>
        <p>${escapeHtml(currentFellow?.name || "当前伙伴")} · ${exchangeCount} 条消息</p>
      </aside>
    </section>

    <section class="workbench-action-grid" aria-label="工作台操作">
      ${renderWorkbenchAction({
        title: "从当前对话创建",
        desc: "把这一轮聊天整理成项目摘要、待办和相关消息。",
        meta: "对话 -> 项目"
      })}
      ${renderWorkbenchAction({
        title: "保存选中消息",
        desc: "以后可从消息右键把关键片段收进项目或草稿。",
        meta: "选区 -> 卡片"
      })}
      ${renderWorkbenchAction({
        title: "新建草稿",
        desc: "放 prompt、文案、角色设定、方案草稿。",
        meta: "空白草稿"
      })}
      ${renderWorkbenchAction({
        title: "导入文件",
        desc: "收纳截图、补丁、文档、图片和生成物。",
        meta: "文件素材"
      })}
    </section>

    <section class="workbench-examples" aria-label="工作台示例">
      ${renderWorkbenchExample({
        title: "Aimashi 输入体验修复",
        desc: "从连续对话里提炼已修复、待验证和相关文件，适合后续生成 PR 描述。",
        tags: ["项目", "代码", "待办"]
      })}
      ${renderWorkbenchExample({
        title: "消息正文样式重设计",
        desc: "收集你挑过的截图、代码块样式要求和最终设计判断。",
        tags: ["创意", "UI", "截图"]
      })}
      ${renderWorkbenchExample({
        title: "Hermes runtime 冲突调查",
        desc: "保留关键结论、后台路径、日志和下一步排查入口。",
        tags: ["调查", "日志", "运行时"]
      })}
    </section>
  `;
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
  applyAppearance(appearance);
  if (!editingAppearance) {
    els.appearanceTheme.value = appearance.theme || "light";
    const savedFontPreset = appearance.fontPreset || "system";
    els.appearanceFontPreset.value = fontPresets[savedFontPreset] ? savedFontPreset : "system";
    if (els.appearanceListStyle) els.appearanceListStyle.value = normalizeListStyle(appearance.listStyle);
    if (els.appearanceSelectionStyle) els.appearanceSelectionStyle.value = normalizeSelectionStyle(appearance.selectionStyle);
    syncAppearanceControls(appearance);
  }
  const user = runtime.user || { displayName: "Boss", avatarText: "B", avatarColor: "#111827", avatarImage: "" };
  applyUserAvatar(els.userAvatar, user);
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
  renderMobilePairing(runtime.daemon || {});
  renderRelayPairing(runtime.relay || {});
  const auth = runtime.auth || {};
  const editingModelSelect = document.activeElement === els.modelSelect || document.activeElement === els.quickModelSelect || document.activeElement === els.effortSelect;
  if (!editingModel && !editingModelSelect) renderModelSelectors(runtime);
  renderConnectedProviders(runtime);
  updateModelFieldVisibility(runtime);
  const selectedEntry = selectedModelEntry();
  const selectedProvider = selectedEntry?.provider || auth.oauthProvider || "openai-codex";
  const selectedProviderLabel = providerLabel(selectedProvider);
  const selectedConnected = providerIsConnected(selectedProvider, runtime);
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
    const engine = activeAgentEngine();
    const currentModelId = engine === "claude-code" || engine === "codex"
      ? (engineConfigForPersona().model || "default")
      : presetKeyForModel(runtime.model);
    if ([...els.quickModelSelect.options].some((option) => option.value === currentModelId)) {
      els.quickModelSelect.value = currentModelId;
    }
    syncQuickModelLabel();
  }
  syncEffortControl(runtime);
  const connectedEntries = connectedModelEntries(runtime);
  const engine = activeAgentEngine();
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
        ? `当前模型：${modelDisplayName(runtime.model)}`
        : "未配置模型";
  }
  const activeIcon = engine === "claude-code"
    ? modelIconSrc({ provider: "anthropic", model: "claude" })
    : engine === "codex"
      ? modelIconSrc({ provider: "openai-codex", model: "codex" })
      : connectedEntries.length
        ? modelIconSrc(runtime.model || {})
        : "";
  const modelAvatar = document.querySelector(".model-avatar");
  if (modelAvatar) {
    modelAvatar.textContent = activeIcon ? "" : "◇";
    modelAvatar.style.backgroundImage = activeIcon ? `url("${activeIcon}")` : "";
  }
  syncPermissionControl(runtime);

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
  initializeReadStateForPersonas(personas);
  markPersonaRead(state.activeKey, false);
  const unreadTotal = totalUnreadCount(personas);
  els.personaCount.textContent = unreadTotal > 99 ? "99+" : String(unreadTotal);
  els.personaCount.classList.toggle("hidden", unreadTotal <= 0);
  const groupActive = activeGroup();
  const active = personas.find((persona) => persona.key === state.activeKey) || personas[0];
  const groupInfoBtn = document.getElementById("groupInfoButton");
  if (groupActive) {
    // Render composite group avatar in topbar
    if (els.activeChatAvatar) {
      els.activeChatAvatar.textContent = "";
      els.activeChatAvatar.setAttribute("style", "");
      els.activeChatAvatar.className = "profile-avatar group-avatar";
      const tiles = (groupActive.members || []).slice(0, 4);
      for (const mid of tiles) {
        const tile = document.createElement("span");
        tile.className = "group-avatar-tile";
        const fellow = personas.find((p) => (p.id || p.key) === mid);
        let styleStr = avatarThumbBackgroundStyle(
          fellow?.avatarImage || avatarAssetForKey(mid),
          fellow?.avatarCrop,
          fellow?.color || "#5e5ce6"
        );
        if (!styleStr || styleStr.trim() === "") {
          styleStr = "background-color:" + (fellow?.color || "#5e5ce6") + ";";
        }
        tile.style.cssText = styleStr;
        els.activeChatAvatar.appendChild(tile);
      }
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
    applyFellowAvatar(els.activeChatAvatar, active);
    setText(els.activeChatName, active.name || "Aimashi");
    renderHeaderStatus();
    if (groupInfoBtn) groupInfoBtn.classList.add("hidden");
    if (els.sessionMenuButton) els.sessionMenuButton.classList.remove("hidden");
    const composerBottom = document.querySelector(".composer-bottom");
    if (composerBottom) composerBottom.classList.remove("hidden");
  }
  const filter = state.personaFilter.trim().toLowerCase();
  const visiblePersonas = sortFellowsForSidebar(filter
    ? personas.filter((persona) => `${persona.name || ""} ${persona.key || ""}`.toLowerCase().includes(filter))
    : personas);

  els.personaList.innerHTML = "";
  for (const persona of visiblePersonas) {
    const preview = conversationPreview(persona);
    const unread = unreadCountForPersona(persona.key);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `persona${persona.key === state.activeKey ? " active" : ""}${persona.pinned ? " pinned" : ""}`;
    button.innerHTML = `
      <span class="avatar fellow-photo" data-fellow-avatar="${escapeHtml(persona.key)}" style="${avatarThumbBackgroundStyle(persona.avatarImage || avatarAssetForKey(persona.key), persona.avatarCrop, persona.color || "#5e5ce6")}"></span>
      <span class="persona-main">
        <span class="persona-name">${escapeHtml(persona.name)}</span>
        <span class="persona-key">${escapeHtml(preview.text)}</span>
      </span>
      <span class="persona-side">
        <span class="persona-time">${escapeHtml(preview.time)}</span>
        <span class="persona-pin${persona.pinned ? "" : " hidden"}" aria-label="置顶">${ICON_PARK_PIN_SVG}</span>
        <span class="persona-unread${unread ? "" : " hidden"}">${escapeHtml(unread > 99 ? "99+" : String(unread))}</span>
      </span>
    `;
    button.addEventListener("click", () => {
      state.activeKey = persona.key;
      const latest = sessionsForPersona(persona.key)[0];
      state.activeSessionIdByPersona[persona.key] = latest?.id;
      state.replyDraft = null;
      markPersonaRead(persona.key);
      state.sessionMenuOpen = false;
      showNarrowContent();
      render();
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openFellowContextMenu(persona.key, event.clientX, event.clientY);
    });
    els.personaList.appendChild(button);
  }

  // Inject group entries after fellow rows
  const groups = listGroups();
  for (const group of groups) {
    if (filter && !(group.name || "").toLowerCase().includes(filter)) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `persona group-persona${group.id === state.activeKey ? " active" : ""}`;
    const previewText = "群聊 · " + ((group.members || []).length + 1) + " 人";
    const updated = group.updatedAt ? formatConversationTime(group.updatedAt) : "";
    btn.innerHTML = `
      <span class="avatar group-avatar"></span>
      <span class="persona-main">
        <span class="persona-name">${escapeHtml(group.name || "未命名群聊")}</span>
        <span class="persona-key">${escapeHtml(previewText)}</span>
      </span>
      <span class="persona-side">
        <span class="persona-time">${escapeHtml(updated)}</span>
      </span>
    `;
    // Build composite avatar tiles
    const avatarEl = btn.querySelector(".avatar.group-avatar");
    const tiles = (group.members || []).slice(0, 4);
    for (const mid of tiles) {
      const tile = document.createElement("span");
      tile.className = "group-avatar-tile";
      const fellow = personas.find((p) => (p.id || p.key) === mid);
      let styleStr = avatarThumbBackgroundStyle(
        fellow?.avatarImage || avatarAssetForKey(mid),
        fellow?.avatarCrop,
        fellow?.color || "#5e5ce6"
      );
      if (!styleStr || styleStr.trim() === "") {
        styleStr = "background-color:" + (fellow?.color || "#5e5ce6") + ";";
      }
      tile.style.cssText = styleStr;
      avatarEl.appendChild(tile);
    }
    btn.addEventListener("click", () => {
      state.activeKey = group.id;
      state.activeGroupId = group.id;
      if (window.aimashiGroup) window.aimashiGroup.moduleState.activeGroupId = group.id;
      showNarrowContent();
      render();
    });
    btn.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      // v1: group context menu deferred
    });
    els.personaList.appendChild(btn);
  }

  if (!visiblePersonas.length && !groups.length) {
    const empty = document.createElement("div");
    empty.className = "persona-empty";
    empty.textContent = "没有匹配的伙伴";
    els.personaList.appendChild(empty);
  }
  renderView();
  renderSessionMenu();
  if (!hasActiveMessageTextSelection()) renderChat();
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
  els.workbenchSidebar?.classList.toggle("hidden", state.activeView !== "workbench");
  els.chatView.classList.toggle("hidden", state.activeView !== "chat");
  els.contactsView?.classList.toggle("hidden", state.activeView !== "contacts");
  els.skillsView?.classList.toggle("hidden", state.activeView !== "skills");
  els.workbenchView?.classList.toggle("hidden", state.activeView !== "workbench");
  els.settingsView.classList.toggle("hidden", !state.settingsOpen);
  els.profileDialog?.classList.toggle("hidden", !state.profileDialogOpen);
  els.fellowCreateMenu?.classList.toggle("hidden", !state.fellowMenuOpen);
  els.fellowDialog?.classList.toggle("hidden", !state.fellowDialogOpen);
  els.petGenerateDialog?.classList.toggle("hidden", !state.petGenerateOpen);
  els.avatarCropDialog?.classList.toggle("hidden", !state.avatarCropEditor.open);
  renderSkillPreview();
  renderFellowContextMenu();
  renderPetGenerateDialog();
  renderPetJobs();
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.activeView);
  });
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsTab === state.activeSettingsTab);
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.settingsPanel !== state.activeSettingsTab);
  });
  renderSkillLibrary();
  renderContacts();
  renderWorkbench();
}

function skillTone(skill = {}) {
  const text = `${skill.category || ""} ${(skill.tags || []).join(" ")} ${skill.name || ""}`.toLowerCase();
  if (/creative|image|video|art|design|media|p5|ascii|music/.test(text)) return "creative";
  if (/software|github|devops|mcp|agent|plugin|install|author|code/.test(text)) return "build";
  if (/apple|productivity|email|note|calendar|maps|home/.test(text)) return "ops";
  return "docs";
}

function skillInitials(name = "") {
  const parts = String(name || "?").split(/[-_\s/]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : String(name || "?").slice(0, 2)).toUpperCase();
}

function pluginSourceLabel(source = "") {
  const labels = {
    "aimashi-official": "Aimashi 官方",
    aimashi: "Aimashi Runtime",
    codex: "Codex",
    claude: "Claude Code"
  };
  return labels[source] || "Skill";
}

function skillAuthorLabel(skill = {}) {
  if (skill.source === "aimashi-official") return "Aimashi 官方";
  if (skill.source === "aimashi") return "Aimashi Runtime";
  if (skill.source === "codex") return "Codex";
  if (skill.source === "claude") return "Claude Code";
  return skill.sourceLabel || "Local";
}

function skillHasUpdate(_skill) {
  return false;
}

function skillDisplayName(skill = {}) {
  return skill.name || skill.title || "Skill";
}

function skillSummaryZh(skill = {}) {
  const exact = {
    imagegen: "生成或编辑图片素材，适合做视觉参考、头像、纹理、插画和界面 mockup。",
    "openai-docs": "查询 OpenAI 官方文档，适合模型选择、API 用法和迁移升级问题。",
    "plugin-creator": "创建 Codex 插件目录和配置，适合把工具能力打包成可复用插件。",
    "skill-creator": "编写或改造 SKILL.md，适合把稳定工作流沉淀成 Codex 可调用的技能。",
    "skill-installer": "从本地清单或 GitHub 安装 Codex Skill，适合扩展本机技能库。",
    "hatch-pet": "把角色图做成 Codex 宠物 spritesheet，并输出预览和打包文件。"
  };
  if (exact[skill.name]) return exact[skill.name];
  const text = `${skill.category || ""} ${(skill.tags || []).join(" ")} ${skill.name || ""}`.toLowerCase();
  if (/creative|image|video|art|design|media|p5|ascii|music/.test(text)) return "创作与多媒体相关能力，适合图像、视频、音频、设计或可视化任务。";
  if (/software|github|devops|mcp|agent|plugin|install|author|code|test/.test(text)) return "工程开发相关能力，适合代码实现、调试、测试、插件、仓库或自动化工作流。";
  if (/research|paper|search|web|data|analysis|market/.test(text)) return "资料研究相关能力，适合检索、归纳、分析和结构化知识整理。";
  if (/apple|productivity|email|note|calendar|maps|home/.test(text)) return "个人效率和系统集成相关能力，适合连接本机应用、日程、笔记或自动化操作。";
  if (/system|docs|doc|write|markdown/.test(text)) return "文档和通用工作流能力，适合阅读说明、整理内容或辅助写作。";
  return skill.description || "这个 Skill 提供一组可复用的本地指令，点击可预览原始 SKILL.md 内容。";
}

function skillSourceStatusBase() {
  return (state.skillLibrary.skills || []).filter((skill) => {
    if (state.skillPluginFilter && skill.pluginId !== state.skillPluginFilter) return false;
    if (state.skillStatusFilter === "updates" && !skillHasUpdate(skill)) return false;
    return true;
  });
}

function skillMatchesFilters(skill) {
  const needle = state.skillFilter.trim().toLowerCase();
  const category = state.skillCategoryFilter.trim().toLowerCase();
  const haystack = [
    skill.name,
    skill.title,
    skill.description,
    skillDisplayName(skill),
    skillSummaryZh(skill),
    skill.category,
    skill.sourceLabel,
    skill.relPath,
    ...(skill.tags || [])
  ].join(" ").toLowerCase();
  if (state.skillPluginFilter && skill.pluginId !== state.skillPluginFilter) return false;
  if (state.skillStatusFilter === "updates" && !skillHasUpdate(skill)) return false;
  return (!needle || haystack.includes(needle)) && (!category || String(skill.category || "") === category);
}

function visibleSkills() {
  return (state.skillLibrary.skills || []).filter(skillMatchesFilters);
}

function skillCategories() {
  const counts = new Map();
  for (const skill of skillSourceStatusBase()) {
    const category = skill.category || "uncategorized";
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function stripSkillFrontmatter(value = "") {
  const text = String(value || "");
  if (!text.startsWith("---")) return text;
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
  return end > 0 ? lines.slice(end + 1).join("\n").trim() : text;
}

function renderSkillInlineMarkdown(value = "") {
  return escapeHtml(value)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderSkillMarkdownSource(value = "") {
  const lines = stripSkillFrontmatter(value).split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let list = [];
  let quote = [];
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderSkillInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    html.push(`<ul>${list.map((item) => `<li>${renderSkillInlineMarkdown(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    html.push(`<blockquote>${quote.map((item) => `<p>${renderSkillInlineMarkdown(item)}</p>`).join("")}</blockquote>`);
    quote = [];
  };
  const flushFlow = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (code) {
        const lang = code.lang || "text";
        html.push(`
          <div class="code-card">
            <div class="code-caption"><span>${escapeHtml(lang)}</span></div>
            <pre><code>${escapeHtml(code.lines.join("\n"))}</code></pre>
          </div>
        `);
        code = null;
      } else {
        flushFlow();
        code = { lang: fence[1].trim(), lines: [] };
      }
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushFlow();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushFlow();
      html.push(`<h${heading[1].length}>${renderSkillInlineMarkdown(heading[2].trim())}</h${heading[1].length}>`);
      continue;
    }
    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      flushQuote();
      list.push(listItem[1].trim());
      continue;
    }
    const quoteLine = line.match(/^>\s*(.*)$/);
    if (quoteLine) {
      flushParagraph();
      flushList();
      quote.push(quoteLine[1].trim());
      continue;
    }
    paragraph.push(line.trim());
  }
  flushFlow();
  return html.join("");
}

async function selectSkill(skillId, openPreview = true) {
  if (!skillId) return;
  state.selectedSkillId = skillId;
  const listed = state.skillLibrary.skills.find((skill) => skill.id === skillId);
  state.selectedSkillDetail = listed || null;
  if (openPreview) state.skillPreviewOpen = true;
  renderSkillLibrary();
  renderSkillPreview();
  try {
    state.selectedSkillDetail = await window.aimashi.readSkill(skillId);
  } catch (error) {
    console.error("Failed to read skill", error);
  }
  renderSkillLibrary();
  renderSkillPreview();
}

function renderSkillFilterRow(row) {
  const active = state.skillLibraryMode === "skills" && state.skillPluginFilter === row.pluginId && state.skillStatusFilter === row.status;
  return `
    <button class="skill-filter-row${row.child ? " child" : ""}${active ? " active" : ""}" type="button" data-skill-plugin="${escapeHtml(row.pluginId)}" data-skill-status="${escapeHtml(row.status)}">
      <span><strong>${escapeHtml(row.label)}</strong>${row.sub ? `<small>${escapeHtml(row.sub)}</small>` : ""}</span>
      <em>${row.count}</em>
    </button>
  `;
}

function renderExtensionNavRow(extension) {
  const active = state.skillLibraryMode === "extension" && state.selectedExtensionId === extension.id;
  return `
    <button class="skill-filter-row${active ? " active" : ""}" type="button" data-skill-extension="${escapeHtml(extension.id)}">
      <span>
        <strong>${escapeHtml(extension.label || extension.name)}</strong>
        <small>${escapeHtml(extension.engineLabel || extension.source || "Plugin")} · ${escapeHtml(extension.capabilitySummary || extension.status || "已发现")}</small>
      </span>
      <em>${escapeHtml(String(extension.skillCount || extension.commandCount || extension.toolCount || ""))}</em>
    </button>
  `;
}

function extensionDetailMeta(extension) {
  return [
    extension.engineLabel || extension.engine || "",
    extension.version ? `v${extension.version}` : "",
    extension.status || ""
  ].filter(Boolean).join(" · ");
}

function renderExtensionDetail(extension) {
  const relatedSkills = (state.skillLibrary.skills || []).filter((skill) => skill.extensionId === extension.id);
  const installing = state.installingExtensions.has(extension.id);
  const action = extension.installState === "installed"
    ? `<button class="extension-action installed" type="button" disabled aria-label="已安装">✓</button>`
    : extension.installable
      ? `<button class="extension-action" type="button" data-extension-install="${escapeHtml(extension.id)}" ${installing ? "disabled" : ""} aria-label="安装 ${escapeHtml(extension.label || extension.name || "插件")}">${installing ? "…" : "+"}</button>`
      : `<button class="extension-action unavailable" type="button" disabled title="${escapeHtml(extension.status || "暂不支持一键安装")}" aria-label="暂不支持一键安装">–</button>`;
  const stats = [
    ["Skills", extension.skillCount],
    ["Commands", extension.commandCount],
    ["Agents", extension.agentCount],
    ["Tools", extension.toolCount],
    ["Hooks", extension.hookCount],
    ["MCP", extension.mcpCount]
  ].filter(([, value]) => Number(value) > 0);
  return `
    <article class="extension-detail">
      <header>
        <div>
          <small>${escapeHtml(extension.engineLabel || "Plugin")}</small>
          <h2>${escapeHtml(extension.label || extension.name)}</h2>
          <p>${escapeHtml(extension.description || "")}</p>
        </div>
        <div class="extension-detail-actions">
          <span>${escapeHtml(extension.installState === "installed" ? "已安装" : (extension.status || "可安装"))}</span>
          ${action}
        </div>
      </header>
      <dl class="extension-detail-grid">
        <div><dt>状态</dt><dd>${escapeHtml(extension.status || "已发现")}</dd></div>
        <div><dt>路径</dt><dd title="${escapeHtml(extension.root || "")}">${escapeHtml(extension.root || "未知")}</dd></div>
        ${extension.pluginKind ? `<div><dt>类型</dt><dd>${escapeHtml(extension.pluginKind)}</dd></div>` : ""}
        ${stats.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("")}
      </dl>
      <section class="extension-skill-list">
        <h3>包含的 Skill</h3>
        ${relatedSkills.length ? relatedSkills.map((skill) => `
          <button type="button" data-skill-select="${escapeHtml(skill.id)}">
            <strong>${escapeHtml(skillDisplayName(skill))}</strong>
            <small>${escapeHtml(skill.category || skill.name || "Skill")}</small>
          </button>
        `).join("") : `<div class="skill-empty-state compact">这个插件没有可扫描到的 SKILL.md</div>`}
      </section>
    </article>
  `;
}

function directorySectionRows() {
  const skills = state.skillLibrary.skills || [];
  const connectors = state.skillLibrary.connectors || [];
  const extensions = state.skillLibrary.extensions || [];
  const available = extensions.filter((extension) => extension.installState !== "installed").length;
  return [
    { id: "plugins", label: "插件", sub: available ? `${available} 个可安装，${extensions.length - available} 个已安装` : "已安装或已发现的能力包", count: extensions.length },
    { id: "skills", label: "技能", sub: "本机可调用的 SKILL.md 能力", count: skills.length },
    { id: "connectors", label: "应用连接", sub: "真实外部应用与 MCP 配置", count: connectors.length }
  ];
}

function renderDirectorySectionRow(row) {
  const active = state.directorySection === row.id;
  return `
    <button class="skill-filter-row${active ? " active" : ""}" type="button" data-directory-section="${escapeHtml(row.id)}">
      <span><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.sub)}</small></span>
      <em>${escapeHtml(String(row.count || 0))}</em>
    </button>
  `;
}

function directoryHaystack(item = {}) {
  return [
    item.label,
    item.name,
    item.description,
    item.status,
    item.source,
    item.sourceLabel,
    item.provider,
    item.engine,
    item.engineLabel,
    item.kind,
    item.scope,
    item.path,
    item.root,
    item.capabilitySummary
  ].filter(Boolean).join(" ").toLowerCase();
}

function visibleConnectors() {
  const needle = state.skillFilter.trim().toLowerCase();
  const type = state.skillCategoryFilter.trim().toLowerCase();
  return (state.skillLibrary.connectors || []).filter((connector) => {
    if (type && String(connector.kind || "").toLowerCase() !== type) return false;
    return !needle || directoryHaystack(connector).includes(needle);
  });
}

function visibleExtensions() {
  const needle = state.skillFilter.trim().toLowerCase();
  const engine = state.skillCategoryFilter.trim().toLowerCase();
  return (state.skillLibrary.extensions || []).filter((extension) => {
    if (engine && String(extension.engine || "").toLowerCase() !== engine) return false;
    return !needle || directoryHaystack(extension).includes(needle);
  });
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderConnectorCard(connector) {
  return `
    <article class="skill-card connector-card">
      <header>
        <strong>${escapeHtml(connector.label || connector.name || "应用连接")}</strong>
        <small>${escapeHtml([connector.sourceLabel || connector.source || "Local", connector.status || ""].filter(Boolean).join(" · "))}</small>
      </header>
      <p>${escapeHtml(connector.description || "本机真实发现的外部应用或 MCP 连接配置。")}</p>
      <footer>
        <span>${escapeHtml(connector.kind || "连接")}</span>
        ${connector.scope ? `<span>${escapeHtml(connector.scope)}</span>` : ""}
      </footer>
    </article>
  `;
}

function renderPluginCard(extension) {
  const installing = state.installingExtensions.has(extension.id);
  const action = extension.installState === "installed"
    ? `<button class="extension-action installed" type="button" disabled title="已安装" aria-label="已安装">✓</button>`
    : extension.installable
      ? `<button class="extension-action" type="button" data-extension-install="${escapeHtml(extension.id)}" ${installing ? "disabled" : ""} title="安装" aria-label="安装 ${escapeHtml(extension.label || extension.name || "插件")}">${installing ? "…" : "+"}</button>`
      : `<button class="extension-action unavailable" type="button" disabled title="${escapeHtml(extension.status || "暂不支持一键安装")}" aria-label="暂不支持一键安装">–</button>`;
  const iconLabel = skillInitials(extension.label || extension.name || extension.engineLabel || "Plugin");
  const icon = extension.iconUrl
    ? `<span class="plugin-icon"><img src="${escapeHtml(extension.iconUrl)}" alt="" loading="lazy"></span>`
    : `<span class="plugin-icon fallback ${escapeHtml(extension.engine || "plugin")}" aria-hidden="true">${escapeHtml(iconLabel)}</span>`;
  return `
    <article class="skill-card plugin-card${extension.id === state.selectedExtensionId ? " featured" : ""}" data-extension-select="${escapeHtml(extension.id)}">
      <header>
        ${icon}
        <div>
          <strong>${escapeHtml(extension.label || extension.name || "Plugin")}</strong>
          <p>${escapeHtml(extension.description || "")}</p>
        </div>
        ${action}
      </header>
    </article>
  `;
}

function skillEmptyText() {
  if (state.skillsLoading) return "正在扫描本地 Skill...";
  if (state.skillStatusFilter === "updates") return "当前没有可更新的 Skill";
  return "没有匹配的 Skill";
}

function renderSkillLibrary() {
  if (!els.skillNav || !els.skillCardGrid) return;
  const skills = state.skillLibrary.skills || [];
  const sources = state.skillLibrary.sources || state.skillLibrary.plugins || [];
  const extensions = state.skillLibrary.extensions || [];
  const connectors = state.skillLibrary.connectors || [];
  const shown = visibleSkills();
  const totalCount = skills.length;
  const activeSource = sources.find((p) => p.id === state.skillPluginFilter);
  const activeExtension = extensions.find((extension) => extension.id === state.selectedExtensionId);
  const section = state.directorySection || "plugins";
  setText(
    els.skillPageTitle,
    state.skillsLoading
      ? "正在扫描能力"
      : section === "plugins" && state.skillLibraryMode === "extension" && activeExtension
        ? activeExtension.label || activeExtension.name
        : section === "connectors"
          ? "应用连接"
          : section === "plugins"
            ? "插件"
            : (activeSource?.label || "技能")
  );

  if (section === "connectors") {
    const connectorKinds = countBy(connectors, (connector) => connector.kind || "connector");
    els.skillChipRow.innerHTML = [
      `<button class="${state.skillCategoryFilter ? "" : "active"}" type="button" data-skill-filter="">全部</button>`,
      ...connectorKinds.map(([kind, count]) => `
        <button class="${state.skillCategoryFilter === kind ? "active" : ""}" type="button" data-skill-filter="${escapeHtml(kind)}">
          ${escapeHtml(kind)} <span>${count}</span>
        </button>
      `)
    ].join("");
  } else if (section === "plugins" && state.skillLibraryMode === "extension" && activeExtension) {
    els.skillChipRow.innerHTML = `
      <button class="active" type="button" data-skill-filter="">插件详情</button>
      <button type="button" data-skill-filter="">${escapeHtml(activeExtension.engineLabel || activeExtension.engine || "Plugin")}</button>
      ${activeExtension.capabilitySummary ? `<button type="button" data-skill-filter="">${escapeHtml(activeExtension.capabilitySummary)}</button>` : ""}
    `;
  } else if (section === "plugins") {
    const engines = countBy(extensions, (extension) => extension.engine || extension.source || "plugin");
    els.skillChipRow.innerHTML = [
      `<button class="${state.skillCategoryFilter ? "" : "active"}" type="button" data-skill-filter="">全部</button>`,
      ...engines.map(([engine, count]) => `
        <button class="${state.skillCategoryFilter === engine ? "active" : ""}" type="button" data-skill-filter="${escapeHtml(engine)}">
          ${escapeHtml(engine)} <span>${count}</span>
        </button>
      `)
    ].join("");
  } else {
    const categories = skillCategories();
    els.skillChipRow.innerHTML = [
      `<button class="${state.skillCategoryFilter ? "" : "active"}" type="button" data-skill-filter="">全部</button>`,
      ...categories.slice(0, 10).map(([category, count]) => `
        <button class="${state.skillCategoryFilter === category ? "active" : ""}" type="button" data-skill-filter="${escapeHtml(category)}">
          ${escapeHtml(category)} <span>${count}</span>
        </button>
      `)
    ].join("");
  }

  const navRows = [
    { label: "全部 Skill", sub: "聚合所有本地 Skill 来源", pluginId: "", status: "all", count: totalCount }
  ];
  for (const plugin of sources.filter((source) => source.kind !== "plugin-skill-source")) {
    navRows.push({
      label: plugin.label || plugin.name,
      sub: plugin.description || pluginSourceLabel(plugin.source),
      pluginId: plugin.id,
      status: "all",
      count: plugin.skillCount || 0,
      child: true
    });
  }
  els.skillNav.innerHTML = `
    <div class="skill-section-label">Directory</div>
    ${directorySectionRows().map((row) => renderDirectorySectionRow(row)).join("")}
    ${section === "skills" ? `
      <div class="skill-section-label">Skill 来源</div>
      ${navRows.map((row) => renderSkillFilterRow(row)).join("")}
    ` : ""}
  `;

  if (section === "connectors") {
    const visible = visibleConnectors();
    els.skillCardGrid.innerHTML = visible.length
      ? visible.map((connector) => renderConnectorCard(connector)).join("")
      : `<div class="skill-empty-state">${state.skillsLoading ? "正在扫描真实连接..." : "没有发现匹配的外部应用或 MCP 配置"}</div>`;
  } else if (section === "plugins") {
    const visible = visibleExtensions();
    els.skillCardGrid.innerHTML = state.skillLibraryMode === "extension" && activeExtension
      ? renderExtensionDetail(activeExtension)
      : visible.length
        ? visible.map((extension) => renderPluginCard(extension)).join("")
        : `<div class="skill-empty-state">${state.skillsLoading ? "正在扫描插件..." : "没有发现匹配的真实插件"}</div>`;
  } else {
    els.skillCardGrid.innerHTML = shown.length
      ? shown.map((skill) => `
        <article class="skill-card${skill.id === state.selectedSkillId ? " featured" : ""}" data-skill-select="${escapeHtml(skill.id)}">
          <header>
            <strong>${escapeHtml(skillDisplayName(skill))}</strong>
            <small>${escapeHtml(skill.pluginLabel || skillAuthorLabel(skill))}</small>
          </header>
          <p>${escapeHtml(skillSummaryZh(skill))}</p>
        </article>
      `).join("")
      : `<div class="skill-empty-state">${skillEmptyText()}</div>`;
  }

  els.skillNav.querySelectorAll("[data-directory-section]").forEach((button) => {
    button.addEventListener("click", () => {
      state.directorySection = button.dataset.directorySection || "plugins";
      state.skillLibraryMode = "skills";
      state.selectedExtensionId = "";
      state.skillPluginFilter = "";
      state.skillStatusFilter = "all";
      state.skillCategoryFilter = "";
      closeSkillContextMenu();
      showNarrowContent();
      renderSkillLibrary();
    });
  });

  els.skillNav.querySelectorAll("[data-skill-plugin]").forEach((button) => {
    button.addEventListener("click", () => {
      state.skillLibraryMode = "skills";
      state.selectedExtensionId = "";
      state.skillPluginFilter = button.dataset.skillPlugin || "";
      state.skillStatusFilter = button.dataset.skillStatus || "all";
      state.skillCategoryFilter = "";
      closeSkillContextMenu();
      showNarrowContent();
      renderSkillLibrary();
    });
  });
  els.skillNav.querySelectorAll("[data-skill-extension]").forEach((button) => {
    button.addEventListener("click", () => {
      state.directorySection = "plugins";
      state.skillLibraryMode = "extension";
      state.selectedExtensionId = button.dataset.skillExtension || "";
      state.skillCategoryFilter = "";
      closeSkillContextMenu();
      showNarrowContent();
      renderSkillLibrary();
    });
  });
  els.skillCardGrid.querySelectorAll("[data-skill-select]").forEach((card) => {
    card.addEventListener("click", () => selectSkill(card.dataset.skillSelect));
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openSkillContextMenu(card.dataset.skillSelect, event.clientX, event.clientY);
    });
  });
  els.skillCardGrid.querySelectorAll("[data-extension-install]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await installExtension(button.dataset.extensionInstall || "");
    });
  });
  els.skillCardGrid.querySelectorAll("[data-extension-select]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("[data-extension-install]")) return;
      state.directorySection = "plugins";
      state.skillLibraryMode = "extension";
      state.selectedExtensionId = card.dataset.extensionSelect || "";
      state.skillCategoryFilter = "";
      closeSkillContextMenu();
      renderSkillLibrary();
    });
  });
  els.skillChipRow.querySelectorAll("[data-skill-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.skillCategoryFilter = button.dataset.skillFilter || "";
      closeSkillContextMenu();
      renderSkillLibrary();
    });
  });
  renderSkillContextMenu();
}

function renderSkillPreview() {
  if (!els.skillPreviewDialog) return;
  els.skillPreviewDialog.classList.toggle("hidden", !state.skillPreviewOpen);
  const skill = state.selectedSkillDetail || state.skillLibrary.skills.find((item) => item.id === state.selectedSkillId);
  if (!skill) return;
  els.skillPreviewMark.className = `skill-dot ${skillTone(skill)}`;
  els.skillPreviewMark.textContent = skillInitials(skill.name);
  setText(els.skillPreviewTitle, skillDisplayName(skill));
  setText(els.skillPreviewMeta, `${skill.name || "Skill"} · ${skill.sourceLabel || "Local"} · ${skill.relPath || skill.category || ""}`);
  els.skillPreviewBody.innerHTML = skill.body
    ? renderSkillMarkdownSource(skill.body)
    : `<div class="skill-empty-state">正在读取 SKILL.md...</div>`;
  els.skillPreviewBody.querySelectorAll("a[href]").forEach((link) => {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer");
  });
}

function openSkillContextMenu(skillId, x, y) {
  if (!skillId) return;
  closeMessageContextMenu();
  state.skillContextMenu = { open: true, x, y, skillId };
  renderSkillContextMenu();
}

function closeSkillContextMenu() {
  if (!state.skillContextMenu.open) return;
  state.skillContextMenu = { open: false, x: 0, y: 0, skillId: "" };
  renderSkillContextMenu();
}

function syncTopbarClickCapture() {
  document.body.classList.toggle("topbar-click-capture", Boolean(state.skillContextMenu.open || state.sessionMenuOpen));
}

function renderSkillContextMenu() {
  if (!els.skillContextMenu) return;
  const menu = els.skillContextMenu;
  const skill = state.skillLibrary.skills.find((item) => item.id === state.skillContextMenu.skillId);
  const open = state.skillContextMenu.open && skill;
  menu.classList.toggle("hidden", !open);
  syncTopbarClickCapture();
  if (!open) return;
  const canDelete = skill.source === "aimashi";
  menu.innerHTML = `
    ${menuItemHtml({ icon: "preview", label: "预览", attrs: 'data-skill-action="preview"' })}
    ${menuItemHtml({ icon: "folderOpen", label: "打开目录", attrs: 'data-skill-action="open-directory"' })}
    <div class="skill-context-menu-separator" role="separator"></div>
    ${menuItemHtml({ icon: "delete", label: "删除", attrs: `data-skill-action="delete" ${canDelete ? "" : "disabled"}`, className: "danger" })}
  `;
  const rect = menu.getBoundingClientRect();
  const width = rect.width || 112;
  const height = rect.height || 122;
  menu.style.left = `${Math.max(8, Math.min(state.skillContextMenu.x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(state.skillContextMenu.y, window.innerHeight - height - 8))}px`;
  menu.querySelector('[data-skill-action="preview"]')?.addEventListener("click", () => {
    closeSkillContextMenu();
    selectSkill(skill.id);
  });
  menu.querySelector('[data-skill-action="delete"]')?.addEventListener("click", () => {
    closeSkillContextMenu();
    deleteSkill(skill.id);
  });
  menu.querySelector('[data-skill-action="open-directory"]')?.addEventListener("click", () => {
    closeSkillContextMenu();
    openSkillDirectory(skill.id);
  });
}

function fellowByKey(key) {
  const fellows = state.runtime?.fellows || state.runtime?.personas || [];
  return fellows.find((item) => item.key === key) || null;
}

function sortFellowsForSidebar(fellows = []) {
  return fellows
    .map((fellow, index) => ({ fellow, index }))
    .sort((a, b) => {
      const pinnedDiff = Number(Boolean(b.fellow.pinned)) - Number(Boolean(a.fellow.pinned));
      if (pinnedDiff) return pinnedDiff;
      if (a.fellow.pinned && b.fellow.pinned) {
        const timeDiff = String(b.fellow.pinnedAt || "").localeCompare(String(a.fellow.pinnedAt || ""));
        if (timeDiff) return timeDiff;
      }
      return a.index - b.index;
    })
    .map((item) => item.fellow);
}

function contactSessionSummary(fellow) {
  const sessions = state.chatStore.sessions[fellow.key] || [];
  const meaningful = sessions.filter(hasPersistableMessages);
  const latest = sessions[0];
  const messages = latest?.messages || [];
  const last = [...messages].reverse().find((message) => String(message.content || "").trim() && !message.transient);
  const preview = last
    ? String(last.content || "")
    : (fellow.bio || "本地伙伴 · 暂无对话");
  return {
    count: meaningful.length || sessions.length,
    preview,
    time: formatConversationTime(latest?.updatedAt || latest?.createdAt)
  };
}

function contactPetLabel(pet = {}) {
  if (pet.placed) return "桌面中";
  if (pet.hasAsset) return "已生成桌宠";
  return "";
}

function openFellowChat(fellowKey) {
  if (!fellowKey) return;
  state.activeKey = fellowKey;
  state.activeContactKey = fellowKey;
  const latest = sessionsForPersona(fellowKey)[0];
  state.activeSessionIdByPersona[fellowKey] = latest?.id;
  state.activeView = "chat";
  state.sessionMenuOpen = false;
  markPersonaRead(fellowKey);
  showNarrowContent();
  render();
  requestAnimationFrame(() => els.chatInput?.focus());
}

function defaultFellowCapabilities() {
  return {
    inheritEngineDefaults: true,
    enabledPlugins: [],
    disabledPlugins: [],
    enabledSkills: [],
    disabledSkills: [],
    enabledConnectors: []
  };
}

function normalizeCapabilityIds(input) {
  return Array.isArray(input)
    ? [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

function fellowCapabilities(fellow = {}) {
  const raw = fellow.capabilities && typeof fellow.capabilities === "object" ? fellow.capabilities : {};
  return {
    ...defaultFellowCapabilities(),
    inheritEngineDefaults: raw.inheritEngineDefaults !== false && raw.inherit_engine_defaults !== false,
    enabledPlugins: normalizeCapabilityIds(raw.enabledPlugins || raw.enabled_plugins),
    disabledPlugins: normalizeCapabilityIds(raw.disabledPlugins || raw.disabled_plugins),
    enabledSkills: normalizeCapabilityIds(raw.enabledSkills || raw.enabled_skills),
    disabledSkills: normalizeCapabilityIds(raw.disabledSkills || raw.disabled_skills),
    enabledConnectors: normalizeCapabilityIds(raw.enabledConnectors || raw.enabled_connectors)
  };
}

function capabilityForEngine(item = {}, engine = "") {
  const itemEngine = String(item.engine || item.provider || "").trim();
  return !itemEngine || itemEngine === "aimashi" || itemEngine === engine || (engine === "hermes" && item.source === "hermes");
}

function engineLabel(engine = "") {
  if (engine === "aimashi") return "Aimashi";
  if (engine === "claude-code") return "Claude Code";
  if (engine === "codex") return "Codex";
  return "Hermes";
}

function fellowCapabilityItems(fellow = {}) {
  const engine = fellow.agentEngine || fellow.agent_engine || "hermes";
  const plugins = (state.skillLibrary.extensions || [])
    .filter((item) => item.installState === "installed" && capabilityForEngine(item, engine))
    .slice(0, 24);
  const skills = (state.skillLibrary.skills || [])
    .filter((item) => capabilityForEngine(item, engine))
    .slice(0, 32);
  const connectors = (state.skillLibrary.connectors || [])
    .filter((item) => capabilityForEngine(item, engine))
    .slice(0, 16);
  return { plugins, skills, connectors };
}

function capabilityChecked(capabilities, id, enabledKey, disabledKey) {
  if (capabilities.inheritEngineDefaults) return !capabilities[disabledKey].includes(id);
  return capabilities[enabledKey].includes(id);
}

function renderCapabilityCheckbox({ item, checked, disabled, type }) {
  const title = item.label || item.name || item.id;
  const meta = item.engineLabel || item.sourceLabel || item.category || item.status || "";
  return `
    <label class="capability-row">
      <input type="checkbox" data-capability-type="${escapeHtml(type)}" data-capability-id="${escapeHtml(item.id)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}>
      <span>
        <strong>${escapeHtml(title)}</strong>
        ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
      </span>
    </label>
  `;
}

function renderFellowCapabilitiesPanel(fellow) {
  const capabilities = fellowCapabilities(fellow);
  const { plugins, skills, connectors } = fellowCapabilityItems(fellow);
  const disabled = capabilities.inheritEngineDefaults;
  const engine = fellow.agentEngine || fellow.agent_engine || "hermes";
  return `
    <section class="contact-capabilities">
      <header>
        <div>
          <strong>能力</strong>
          <p>${escapeHtml(engineLabel(engine))} · ${plugins.length} 插件 · ${skills.length} 技能 · ${connectors.length} 连接</p>
        </div>
        <label class="capability-default-toggle">
          <input type="checkbox" data-capability-default ${capabilities.inheritEngineDefaults ? "checked" : ""}>
          <span>使用引擎默认能力</span>
        </label>
      </header>
      <div class="capability-columns${disabled ? " inherited" : ""}">
        <section>
          <h3>插件</h3>
          ${plugins.length ? plugins.map((item) => renderCapabilityCheckbox({
            item,
            checked: capabilityChecked(capabilities, item.id, "enabledPlugins", "disabledPlugins"),
            disabled,
            type: "plugin"
          })).join("") : `<div class="capability-empty">当前引擎没有已安装插件</div>`}
        </section>
        <section>
          <h3>技能</h3>
          ${skills.length ? skills.map((item) => renderCapabilityCheckbox({
            item,
            checked: capabilityChecked(capabilities, item.id, "enabledSkills", "disabledSkills"),
            disabled,
            type: "skill"
          })).join("") : `<div class="capability-empty">当前引擎没有可选技能</div>`}
        </section>
        <section>
          <h3>应用连接</h3>
          ${connectors.length ? connectors.map((item) => renderCapabilityCheckbox({
            item,
            checked: capabilities.enabledConnectors.includes(item.id),
            disabled,
            type: "connector"
          })).join("") : `<div class="capability-empty">没有发现连接配置</div>`}
        </section>
      </div>
    </section>
  `;
}

function renderContacts() {
  if (!els.contactList || !els.contactDetail) return;
  if (!state.skillsLoading && !(state.skillLibrary.extensions || []).length && !(state.skillLibrary.skills || []).length) {
    loadSkills().catch(() => {});
  }
  const fellows = state.runtime?.fellows || state.runtime?.personas || [];
  if (!fellows.length) {
    els.contactList.innerHTML = `<div class="contact-empty">还没有联系人</div>`;
    els.contactDetail.innerHTML = `<div class="contact-empty detail-empty">添加一个伙伴后会显示在这里</div>`;
    return;
  }
  if (!fellows.some((fellow) => fellow.key === state.activeContactKey)) {
    state.activeContactKey = fellows[0].key;
  }
  const filter = state.contactFilter.trim().toLowerCase();
  const visibleContacts = sortFellowsForSidebar(filter
    ? fellows.filter((fellow) => `${fellow.name || ""} ${fellow.key || ""} ${fellow.bio || ""}`.toLowerCase().includes(filter))
    : fellows);
  els.contactList.innerHTML = "";
  for (const fellow of visibleContacts) {
    const summary = contactSessionSummary(fellow);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `contact-row${fellow.key === state.activeContactKey ? " active" : ""}`;
    button.innerHTML = `
      <span class="avatar fellow-photo" style="${avatarThumbBackgroundStyle(fellow.avatarImage || avatarAssetForKey(fellow.key), fellow.avatarCrop, fellow.color || "#5e5ce6")}"></span>
      <span class="contact-row-main">
        <strong>${escapeHtml(fellow.name)}</strong>
        <small>${escapeHtml(fellow.bio || "本地伙伴")}</small>
      </span>
      <span class="contact-row-side">${escapeHtml(summary.time || "")}</span>
    `;
    button.addEventListener("click", () => {
      state.activeContactKey = fellow.key;
      showNarrowContent();
      renderContacts();
    });
    button.addEventListener("dblclick", () => openFellowChat(fellow.key));
    els.contactList.appendChild(button);
  }
  if (!visibleContacts.length) {
    els.contactList.innerHTML = `<div class="contact-empty">没有匹配的联系人</div>`;
  }
  renderContactDetail(fellows.find((fellow) => fellow.key === state.activeContactKey) || visibleContacts[0] || fellows[0]);
}

function renderContactDetail(fellow) {
  if (!els.contactDetail || !fellow) return;
  const summary = contactSessionSummary(fellow);
  const engine = fellow.agentEngine || fellow.agent_engine || fellow.engine || "hermes";
  setText(els.contactPageTitle, fellow.name || "联系人");
  setText(els.contactPageMeta, `${summary.count} 个会话`);
  els.contactDetail.innerHTML = `
    <article class="contact-profile">
      <header class="contact-profile-head">
        <button class="contact-profile-avatar" type="button" data-contact-action="edit" title="编辑联系人头像" style="${avatarBackgroundStyle(fellow.avatarImage || avatarAssetForKey(fellow.key), fellow.avatarCrop, fellow.color || "#5e5ce6")}"></button>
        <div class="contact-profile-title">
          <h2>${escapeHtml(fellow.name || "联系人")}</h2>
          <div class="contact-engine-badge" title="Agent 引擎">
            <span>Agent</span>
            <strong>${escapeHtml(engineLabel(engine))}</strong>
          </div>
          <p>${escapeHtml(fellow.bio || "本地伙伴")}</p>
        </div>
        <div class="contact-actions">
          <button class="primary contact-message-action" type="button" data-contact-action="message" title="发消息" aria-label="发消息">${iconParkIcon("message", "contact-action-icon")}</button>
          <button class="secondary" type="button" data-contact-action="edit">编辑</button>
          ${fellow.key === "aimashi" ? "" : `<button class="secondary danger" type="button" data-contact-action="delete">删除伙伴</button>`}
        </div>
      </header>
      <section class="contact-note">
        <strong>最近内容</strong>
        <p>${escapeHtml(summary.preview)}</p>
      </section>
      ${renderFellowCapabilitiesPanel(fellow)}
    </article>
  `;
  els.contactDetail.querySelector('[data-contact-action="message"]')?.addEventListener("click", () => openFellowChat(fellow.key));
  els.contactDetail.querySelectorAll('[data-contact-action="edit"]').forEach((button) => {
    button.addEventListener("click", () => openEditFellowDialog(fellow.key));
  });
  els.contactDetail.querySelector('[data-contact-action="delete"]')?.addEventListener("click", async () => {
    await deleteFellow(fellow.key);
  });
  wireFellowCapabilities(fellow);
}

async function saveFellowCapabilities(fellow, capabilities) {
  if (!fellow?.key) return;
  state.savingFellowCapabilities.add(fellow.key);
  try {
    state.runtime = await window.aimashi.saveFellow({
      ...fellow,
      capabilities
    });
  } catch (error) {
    window.alert(`保存能力设置失败：${error.message || error}`);
  } finally {
    state.savingFellowCapabilities.delete(fellow.key);
    renderContacts();
  }
}

function toggleCapabilityId(capabilities, id, enabledKey, disabledKey, checked) {
  const next = {
    ...capabilities,
    [enabledKey]: [...capabilities[enabledKey]],
    [disabledKey]: [...capabilities[disabledKey]]
  };
  if (next.inheritEngineDefaults) {
    next[disabledKey] = checked
      ? next[disabledKey].filter((item) => item !== id)
      : [...new Set([...next[disabledKey], id])];
  } else {
    next[enabledKey] = checked
      ? [...new Set([...next[enabledKey], id])]
      : next[enabledKey].filter((item) => item !== id);
  }
  return next;
}

function wireFellowCapabilities(fellow) {
  if (!els.contactDetail || !fellow) return;
  const defaultToggle = els.contactDetail.querySelector("[data-capability-default]");
  defaultToggle?.addEventListener("change", async () => {
    const capabilities = fellowCapabilities(fellow);
    capabilities.inheritEngineDefaults = Boolean(defaultToggle.checked);
    await saveFellowCapabilities(fellow, capabilities);
  });
  els.contactDetail.querySelectorAll("[data-capability-type][data-capability-id]").forEach((input) => {
    input.addEventListener("change", async () => {
      const id = input.dataset.capabilityId || "";
      const type = input.dataset.capabilityType || "";
      let capabilities = fellowCapabilities(fellow);
      if (type === "plugin") {
        capabilities = toggleCapabilityId(capabilities, id, "enabledPlugins", "disabledPlugins", input.checked);
      } else if (type === "skill") {
        capabilities = toggleCapabilityId(capabilities, id, "enabledSkills", "disabledSkills", input.checked);
      } else if (type === "connector") {
        capabilities.enabledConnectors = input.checked
          ? [...new Set([...capabilities.enabledConnectors, id])]
          : capabilities.enabledConnectors.filter((item) => item !== id);
      }
      await saveFellowCapabilities(fellow, capabilities);
    });
  });
}

function petStatusForKey(key) {
  return state.runtime?.pets?.[key] || { hasAsset: false, placed: false, petId: "" };
}

function openFellowContextMenu(fellowKey, x, y) {
  if (!fellowKey) return;
  closeMessageContextMenu();
  state.fellowContextMenu = { open: true, x, y, fellowKey };
  renderFellowContextMenu();
}

function closeFellowContextMenu() {
  if (!state.fellowContextMenu.open) return;
  state.fellowContextMenu = { open: false, x: 0, y: 0, fellowKey: "" };
  renderFellowContextMenu();
}

function renderFellowContextMenu() {
  if (!els.fellowContextMenu) return;
  const menu = els.fellowContextMenu;
  const fellow = fellowByKey(state.fellowContextMenu.fellowKey);
  const open = state.fellowContextMenu.open && fellow;
  menu.classList.toggle("hidden", !open);
  if (!open) return;
  const pet = petStatusForKey(fellow.key);
  const petAction = pet.hasAsset
    ? pet.placed
      ? menuItemHtml({ icon: "message", label: `收回「${fellow.name}」`, attrs: 'data-fellow-action="recall"' })
      : menuItemHtml({ icon: "message", label: "放进桌面", attrs: 'data-fellow-action="place"' })
    : menuItemHtml({ icon: "addPic", label: "生成桌宠", attrs: 'data-fellow-action="generate-pet"' });
  menu.innerHTML = `
    ${menuItemHtml({ icon: "pin", label: fellow.pinned ? "取消置顶" : "置顶", attrs: 'data-fellow-action="pin"' })}
    ${menuItemHtml({ icon: "edit", label: "编辑", attrs: 'data-fellow-action="edit"' })}
    ${petAction}
    ${fellow.key === "aimashi" ? "" : `<div class="skill-context-menu-separator" role="separator"></div>${menuItemHtml({ icon: "delete", label: "删除伙伴", attrs: 'data-fellow-action="delete"', className: "danger" })}`}
  `;
  const rect = menu.getBoundingClientRect();
  const width = rect.width || 138;
  const height = rect.height || (fellow.key === "aimashi" ? 114 : 158);
  menu.style.left = `${Math.max(8, Math.min(state.fellowContextMenu.x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(state.fellowContextMenu.y, window.innerHeight - height - 8))}px`;
  menu.querySelector('[data-fellow-action="edit"]')?.addEventListener("click", () => {
    closeFellowContextMenu();
    openEditFellowDialog(fellow.key);
  });
  menu.querySelector('[data-fellow-action="pin"]')?.addEventListener("click", async () => {
    closeFellowContextMenu();
    await setFellowPinned(fellow.key, !fellow.pinned);
  });
  menu.querySelector('[data-fellow-action="generate-pet"]')?.addEventListener("click", () => {
    closeFellowContextMenu();
    openPetGenerateDialog(fellow.key);
  });
  menu.querySelector('[data-fellow-action="place"]')?.addEventListener("click", async () => {
    closeFellowContextMenu();
    await placeFellowPet(fellow.key);
  });
  menu.querySelector('[data-fellow-action="recall"]')?.addEventListener("click", async () => {
    closeFellowContextMenu();
    await recallFellowPet(fellow.key);
  });
  menu.querySelector('[data-fellow-action="delete"]')?.addEventListener("click", async () => {
    closeFellowContextMenu();
    await deleteFellow(fellow.key);
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
      <span>${escapeHtml(replyTo.author || (replyTo.role === "user" ? "你" : "AI"))}</span>
      <p>${escapeHtml(replyTo.content)}</p>
    </div>
  `;
}

function clearMessageSelectionHighlight() {
  try {
    window.CSS?.highlights?.delete?.("aimashi-message-selection");
  } catch {
    // Highlight API is optional.
  }
}

function highlightMessageSelection(range) {
  clearMessageSelectionHighlight();
  try {
    if (!range || !window.Highlight || !window.CSS?.highlights) return;
    window.CSS.highlights.set("aimashi-message-selection", new window.Highlight(range));
  } catch {
    // Keep native selection behavior when custom highlights are unavailable.
  }
}

function selectionInsideBubble(bubble) {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const anchorInside = selection.anchorNode && bubble.contains(selection.anchorNode);
  const focusInside = selection.focusNode && bubble.contains(selection.focusNode);
  if (!anchorInside || !focusInside) return null;
  const range = selection.getRangeAt(0).cloneRange();
  return { text, range };
}

function hasActiveMessageTextSelection() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  if (!String(selection.toString() || "").trim()) return false;
  const anchorBubble = selection.anchorNode?.parentElement?.closest?.(".bubble[data-message-index]");
  const focusBubble = selection.focusNode?.parentElement?.closest?.(".bubble[data-message-index]");
  return Boolean(anchorBubble && focusBubble && anchorBubble === focusBubble && els.chat?.contains(anchorBubble));
}

function openMessageContextMenu(messageIndex, x, y, selection = null) {
  const index = Number(messageIndex);
  if (!messageAtIndex(index)) return;
  closeSkillContextMenu();
  closeFellowContextMenu();
  const selectionText = String(selection?.text || "").trim();
  state.messageContextMenu = { open: true, x, y, messageIndex: index, selectionText };
  if (selectionText) highlightMessageSelection(selection.range);
  else clearMessageSelectionHighlight();
  renderMessageContextMenu();
}

function closeMessageContextMenu() {
  if (!state.messageContextMenu.open) return;
  state.messageContextMenu = { open: false, x: 0, y: 0, messageIndex: -1, selectionText: "" };
  clearMessageSelectionHighlight();
  renderMessageContextMenu();
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
      <span>回复 ${escapeHtml(reply.author || "消息")}</span>
      <p>${escapeHtml(reply.content || "")}</p>
    </div>
    <button type="button" data-clear-reply title="取消回复" aria-label="取消回复">×</button>
  `;
}

function replyToMessage(message, index = state.messageContextMenu.messageIndex, selectionText = "") {
  const reference = messageReferenceForIndex(Number(index), selectionText);
  if (!reference) return;
  state.replyDraft = reference;
  renderComposerReply();
  els.chatInput?.focus();
}

function replyContextPrompt(text, replyTo) {
  if (!replyTo?.content) return text;
  return [
    "用户正在回复会话中的某一条消息。请把“被回复消息”作为这次回复的直接上下文，但不要在回答里机械复述它。",
    "",
    `被回复消息作者：${replyTo.author || (replyTo.role === "user" ? "用户" : "助手")}`,
    "被回复消息：",
    replyTo.content,
    "",
    "用户实际输入：",
    text
  ].join("\n");
}

function translationHtml(message, index) {
  const translation = message?.translation;
  if (!translation) return "";
  const status = translation.status || (translation.text ? "done" : "");
  const label = translation.sourceText ? "选中文本译文" : "译文";
  const body = status === "loading"
    ? '<p class="message-translation-muted">正在翻译...</p>'
    : status === "error"
      ? `<p class="message-translation-error">${escapeHtml(translation.error || "翻译失败")}</p>`
      : `<div class="message-translation-body">${renderMarkdown(translation.text || "")}</div>`;
  const copyButton = status === "done" && translation.text
    ? `<button type="button" data-copy-translation="${index}" title="复制译文" aria-label="复制译文">⧉</button>`
    : "";
  return `
    <div class="message-translation">
      <div class="message-translation-head">
        <span>${label}</span>
        ${copyButton}
      </div>
      ${body}
    </div>
  `;
}

async function translateMessage(message, index = state.messageContextMenu.messageIndex, selectionText = "") {
  const text = messageContextText(message, selectionText);
  const messageIndex = Number(index);
  const session = activeSession();
  const target = messageAtIndex(messageIndex);
  if (!text || !target) return;
  if (state.isGenerating) {
    target.translation = {
      status: "error",
      error: "请等当前回复生成结束后再翻译。",
      sourceText: String(selectionText || "").trim(),
      translatedAt: nowIso()
    };
    renderChat();
    return;
  }
  target.translation = {
    status: "loading",
    text: "",
    error: "",
    sourceText: String(selectionText || "").trim(),
    translatedAt: nowIso()
  };
  renderChat();
  try {
    const prompt = [
      "请把下面这条聊天消息翻译成简体中文。",
      "要求：只输出译文；保持原意、语气和代码/命令/链接；不要添加解释。",
      "",
      text
    ].join("\n");
    const response = await window.aimashi.sendChat({
      fellowKey: state.activeKey,
      personaKey: state.activeKey,
      sessionId: `utility:translate:${cryptoRandomId()}`,
      utility: true,
      messages: [{ role: "user", content: prompt }]
    });
    const translated = String(response.choices?.[0]?.message?.content || "").trim();
    target.translation = translated
      ? { status: "done", text: translated, error: "", sourceText: String(selectionText || "").trim(), translatedAt: nowIso() }
      : { status: "error", text: "", error: "模型没有返回译文。", sourceText: String(selectionText || "").trim(), translatedAt: nowIso() };
  } catch (error) {
    target.translation = {
      status: "error",
      text: "",
      error: `翻译失败: ${error.message || error}`,
      sourceText: String(selectionText || "").trim(),
      translatedAt: nowIso()
    };
  }
  renderChat();
  await persistSessionQuietly(session);
}

async function toggleMessagePinned(index) {
  const message = messageAtIndex(index);
  if (!message) return;
  message.pinned = !message.pinned;
  message.pinnedAt = message.pinned ? nowIso() : "";
  const session = activeSession();
  session.updatedAt = nowIso();
  renderChat();
  await replacePersistedSessionQuietly(session);
}

async function deleteMessageAt(index) {
  const session = activeSession();
  if (!messageAtIndex(index)) return;
  session.messages.splice(index, 1);
  session.updatedAt = nowIso();
  renderChat();
  renderSessionMenu();
  await replacePersistedSessionQuietly(session);
}

function renderMessageContextMenu() {
  if (!els.messageContextMenu) return;
  const menu = els.messageContextMenu;
  const message = messageAtIndex(state.messageContextMenu.messageIndex);
  const open = state.messageContextMenu.open && message;
  menu.classList.toggle("hidden", !open);
  if (!open) return;
  const selectionText = String(state.messageContextMenu.selectionText || "").trim();
  const hasSelection = Boolean(selectionText);
  const contextText = messageContextText(message, selectionText);
  const hasText = Boolean(contextText);
  menu.innerHTML = `
    ${menuItemHtml({ icon: "quote", label: hasSelection ? "回复选中" : "回复", attrs: `data-message-action="reply" ${hasText ? "" : "disabled"}` })}
    ${menuItemHtml({ icon: "copy", label: hasSelection ? "拷贝选中" : "拷贝", attrs: `data-message-action="copy" ${hasText ? "" : "disabled"}` })}
    ${menuItemHtml({ icon: "translate", label: hasSelection ? "翻译选中" : "翻译", attrs: `data-message-action="translate" ${hasText ? "" : "disabled"}` })}
    <div class="skill-context-menu-separator" role="separator"></div>
    ${menuItemHtml({ icon: "pin", label: message.pinned ? "取消置顶" : "置顶", attrs: 'data-message-action="pin"' })}
    ${menuItemHtml({ icon: "delete", label: "删除", attrs: 'data-message-action="delete"', className: "danger" })}
  `;
  const rect = menu.getBoundingClientRect();
  const width = rect.width || 116;
  const height = rect.height || 210;
  menu.style.left = `${Math.max(8, Math.min(state.messageContextMenu.x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(state.messageContextMenu.y, window.innerHeight - height - 8))}px`;
  menu.querySelectorAll("[data-message-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.messageAction;
      const index = state.messageContextMenu.messageIndex;
      const actionSelectionText = String(state.messageContextMenu.selectionText || "").trim();
      const targetMessage = messageAtIndex(index);
      closeMessageContextMenu();
      if (!targetMessage) return;
      if (action === "reply") replyToMessage(targetMessage, index, actionSelectionText);
      if (action === "copy") await copyTextToClipboard(messageContextText(targetMessage, actionSelectionText));
      if (action === "translate") await translateMessage(targetMessage, index, actionSelectionText);
      if (action === "pin") await toggleMessagePinned(index);
      if (action === "delete") await deleteMessageAt(index);
    });
  });
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
  const fellow = fellowByKey(fellowKey);
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

function openPetGenerateDialog(fellowKey) {
  const fellow = fellowByKey(fellowKey);
  if (!fellow) return;
  state.petGenerateOpen = true;
  state.petGenerateFellowKey = fellow.key;
  const reference = fellow.avatarImage || avatarAssetForKey(fellow.key);
  state.petReferences = reference ? [{ id: cryptoRandomId(), src: reference }] : [];
  if (els.petPrompt) els.petPrompt.value = "";
  if (els.petStylePreset) els.petStylePreset.value = "codex";
  renderView();
}

function closePetGenerateDialog() {
  state.petGenerateOpen = false;
  state.petGenerateFellowKey = "";
  state.petReferences = [];
  renderView();
}

function renderPetGenerateDialog() {
  if (!els.petGenerateDialog || !state.petGenerateOpen) return;
  const fellow = fellowByKey(state.petGenerateFellowKey);
  if (!fellow) return;
  setText(els.petGenerateTitle, `生成「${fellow.name}」桌宠`);
  setText(els.petGenerateSubtitle, "会在后台调用 AlkakaPet/Hatch Pet 流程，耗时可能较长。");
  if (!els.petReferenceList) return;
  els.petReferenceList.innerHTML = state.petReferences.length
    ? state.petReferences.map((item) => `
      <div class="pet-reference-thumb" style="${avatarBackgroundStyle(item.src, { x: 50, y: 50, zoom: 1 }, "#eef0ff")}">
        <button type="button" data-remove-pet-reference="${escapeHtml(item.id)}" title="删除">×</button>
      </div>
    `).join("")
    : `<div class="pet-reference-empty">没有参考图片</div>`;
  els.petReferenceList.querySelectorAll("[data-remove-pet-reference]").forEach((button) => {
    button.addEventListener("click", () => {
      state.petReferences = state.petReferences.filter((item) => item.id !== button.dataset.removePetReference);
      renderPetGenerateDialog();
    });
  });
}

function readPetReferenceFile(file) {
  if (!file || !file.type?.startsWith("image/")) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    state.petReferences.push({ id: cryptoRandomId(), src: String(reader.result || "") });
    renderPetGenerateDialog();
  });
  reader.readAsDataURL(file);
}

async function refreshPetJobs() {
  try {
    state.petJobs = await window.aimashi.loadPetJobs();
    renderPetJobs();
    if (state.petJobs.some((job) => job.status === "completed")) {
      await refreshRuntime();
    }
  } catch (error) {
    console.error("Failed to load pet jobs", error);
  }
}

function renderPetJobs() {
  const jobs = state.petJobs?.length ? state.petJobs : (state.runtime?.petJobs || []);
  if (!els.petJobButton || !els.petJobPanel) return;
  const running = jobs.filter((job) => job.status === "running");
  const latest = jobs[0];
  const visible = running.length || latest;
  els.petJobButton.classList.toggle("hidden", !visible);
  if (!visible) {
    els.petJobPanel.classList.add("hidden");
    return;
  }
  els.petJobButton.textContent = running.length
    ? `桌宠生成中 ${running.length}`
    : latest.status === "completed"
      ? "桌宠已生成"
      : "桌宠生成失败";
  els.petJobPanel.classList.toggle("hidden", !state.petJobPanelOpen);
  if (!state.petJobPanelOpen) return;
  els.petJobPanel.innerHTML = jobs.slice(0, 5).map((job) => `
    <article class="pet-job-item ${escapeHtml(job.status)}">
      <strong>${escapeHtml(job.fellowName || job.petId)}</strong>
      <span>${escapeHtml(job.status === "running" ? "生成中" : job.status === "completed" ? "已完成" : "失败")}</span>
      ${job.error ? `<p>${escapeHtml(job.error)}</p>` : ""}
      ${job.logPath ? `<small>${escapeHtml(job.logPath)}</small>` : ""}
    </article>
  `).join("");
}

async function placeFellowPet(fellowKey) {
  try {
    await window.aimashi.placeFellowPet(fellowKey);
    await refreshRuntime();
  } catch (error) {
    appendTransientChat("assistant", `放进桌面失败: ${error.message}`);
  }
}

async function recallFellowPet(fellowKey) {
  try {
    await window.aimashi.recallFellowPet(fellowKey);
    await refreshRuntime();
  } catch (error) {
    appendTransientChat("assistant", `收回桌宠失败: ${error.message}`);
  }
}

async function deleteSkill(skillId) {
  const skill = state.skillLibrary.skills.find((item) => item.id === skillId);
  if (!skill || skill.source !== "aimashi") return;
  const label = skillDisplayName(skill);
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
  renderSkillLibrary();
  renderSkillPreview();
}

async function installExtension(extensionId) {
  if (!extensionId || state.installingExtensions.has(extensionId)) return;
  state.installingExtensions.add(extensionId);
  renderSkillLibrary();
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
    renderSkillLibrary();
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
        <strong>${escapeHtml(session.title || "新对话")}</strong>
        <small>${escapeHtml(new Date(session.updatedAt || session.createdAt || Date.now()).toLocaleString())}</small>
      </span>
      <em title="重命名" data-session-edit="${escapeHtml(session.id)}">${iconParkIcon("edit", "session-row-edit-icon")}</em>
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
    if (key) attrs.push(`data-trace-key="${escapeHtml(key)}"`);
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
        `<summary><span class="trace-chevron">▸</span><span class="trace-cmd">thinking</span><span class="trace-arg">${escapeHtml(reasoningText.slice(0, 80).replace(/\s+/g, " "))}</span></summary>` +
        `<pre class="trace-body">${escapeHtml(reasoningText)}</pre>` +
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
          `<span class="trace-cmd">${escapeHtml(name)}</span>` +
          (previewInline ? `<span class="trace-arg">${escapeHtml(previewInline)}</span>` : "") +
          (meta ? `<span class="trace-meta">${escapeHtml(meta)}</span>` : "") +
        `</summary>` +
        (preview ? `<pre class="trace-body">${escapeHtml(preview)}</pre>` : "") +
      `</details>`
    );
  }
  return `<div class="trace">${rows.join("")}</div>`;
}

function detectedLocalAgentLabels(runtime = state.runtime) {
  const engines = runtime?.agentEngines || {};
  const labels = [];
  if (engines.claudeCode?.available) labels.push("Claude Code");
  if (engines.codex?.available) labels.push("Codex");
  return labels;
}

function shouldShowSetupGuide({ messages }) {
  if (!state.runtime) return false;
  // Onboarding takes over the chat panel until the user has at least one fellow.
  const fellows = state.runtime.fellows || state.runtime.personas || [];
  if (fellows.length === 0) return true;
  if (state.setupGuideDismissed) return false;
  if (messages.length > 0) return false;
  return true;
}

function engineChoiceRow({ id, label, status, available, action, actionLabel }) {
  const stateClass = available ? "" : " unavailable";
  const actionAttr = action ? `data-setup-action="${action}" data-engine="${id}"` : "";
  const button = action
    ? `<button class="setup-engine-action${available ? " primary" : ""}" type="button" ${actionAttr}>${escapeHtml(actionLabel)}</button>`
    : "";
  return `
    <div class="setup-engine-row${stateClass}" data-engine-id="${id}">
      <span class="setup-engine-dot ${id}"></span>
      <div class="setup-engine-body">
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(status)}</small>
      </div>
      ${button}
    </div>
  `;
}

function renderSetupGuide() {
  const runtime = state.runtime || {};
  const engines = runtime.agentEngines || {};
  const source = runtime.engineSource;
  const fellows = runtime.fellows || runtime.personas || [];

  // If no fellow exists, force flow into onboarding regardless of prior dismiss.
  if (fellows.length === 0 && state.onboardingStep === "done") {
    state.onboardingStep = "engine";
  }

  if (state.onboardingStep === "create-fellow") {
    return renderSetupGuideCreateFellowStep();
  }

  // Default: "engine" step
  let hermesStatus;
  let hermesAvailable;
  let hermesAction;
  let hermesActionLabel;
  if (source === "bundled") {
    hermesStatus = "随 Aimashi 安装包内置，无需额外安装";
    hermesAvailable = true;
    hermesAction = "use-engine";
    hermesActionLabel = "使用 Hermes";
  } else if (source === "managed") {
    hermesStatus = "Aimashi 独立 Hermes 副本已安装";
    hermesAvailable = true;
    hermesAction = "use-engine";
    hermesActionLabel = "使用 Hermes";
  } else {
    hermesStatus = "未安装 · 点击会装一份独立副本到 Aimashi 私有目录（不影响你自己的 hermes）";
    hermesAvailable = false;
    hermesAction = "install-hermes";
    hermesActionLabel = "安装 Hermes";
  }

  const cc = engines.claudeCode || {};
  const claudeStatus = cc.available
    ? `${cc.path || "已检测到"}${cc.version ? ` · ${cc.version.split(" ")[0]}` : ""}`
    : "未检测到 · 需先用 npm 装 @anthropic-ai/claude-code";
  const codex = engines.codex || {};
  const codexStatus = codex.available
    ? `${codex.path || "已检测到"}${codex.version ? ` · ${codex.version.split(" ")[0]}` : ""}`
    : "未检测到 · 需先安装 OpenAI Codex CLI";

  return `
    <article class="setup-guide">
      <div class="setup-guide-main">
        <span class="setup-kicker">第 1 步 / 共 2 步</span>
        <strong>选个 Agent 引擎</strong>
        <p>这是你的第一个伙伴默认会用的引擎，以后任意时候都能换。</p>
      </div>
      <div class="setup-engine-list">
        ${engineChoiceRow({
          id: "hermes",
          label: "Hermes",
          status: hermesStatus,
          available: hermesAvailable,
          action: hermesAction,
          actionLabel: hermesActionLabel
        })}
        ${engineChoiceRow({
          id: "claude-code",
          label: "Claude Code",
          status: claudeStatus,
          available: cc.available,
          action: cc.available ? "use-engine" : "",
          actionLabel: "使用 Claude Code"
        })}
        ${engineChoiceRow({
          id: "codex",
          label: "Codex",
          status: codexStatus,
          available: codex.available,
          action: codex.available ? "use-engine" : "",
          actionLabel: "使用 Codex"
        })}
      </div>
    </article>
  `;
}

function renderSetupGuideCreateFellowStep() {
  const engine = state.onboardingPickedEngine || "hermes";
  const label = engine === "hermes" ? "Hermes" : engine === "claude-code" ? "Claude Code" : "Codex";
  return `
    <article class="setup-guide">
      <div class="setup-guide-main">
        <span class="setup-kicker">第 2 步 / 共 2 步</span>
        <strong>创建你的第一个伙伴</strong>
        <p>名字、头像、人设都已经预填好，点 "开始创建" 后可以随便改。引擎已选：<b>${escapeHtml(label)}</b>。</p>
      </div>
      <div class="setup-actions" style="justify-content: flex-start;">
        <button class="setup-action primary" type="button" data-setup-action="create-first-fellow">开始创建</button>
      </div>
    </article>
  `;
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
  if (shouldShowSetupGuide({ messages })) {
    els.chat.insertAdjacentHTML("beforeend", renderSetupGuide());
  }
  for (const [messageIndex, message] of messages.entries()) {
    const article = document.createElement("article");
    article.className = `message ${message.role === "user" ? "user" : "assistant"}`;
    const persona = active;
    const label = message.role === "user" ? (user.avatarText || initials(user.displayName)) : initials(persona?.name || "A");
    const color = message.role === "user" ? user.avatarColor : (persona?.color || "#23444d");
    const fellowAvatarImage = persona?.avatarImage || avatarAssetForKey(persona?.key);
    const fellowAvatar = avatarImageSrc(fellowAvatarImage);
    const userAvatarImage = user.avatarImage || "";
    const userAvatar = avatarImageSrc(userAvatarImage);
    const avatarBackgroundColor = message.role === "assistant"
      ? (fellowAvatar ? "transparent" : (color || "#111827"))
      : (userAvatar ? "transparent" : (color || "#111827"));
    const imageStyle = message.role === "assistant"
      ? avatarThumbBackgroundStyle(fellowAvatarImage, persona?.avatarCrop, color)
      : (userAvatar ? avatarThumbBackgroundStyle(userAvatarImage, user.avatarCrop, color) : "");
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
    const bodyHtml = String(message.content || "").trim() ? renderMarkdown(message.content) : "";
    const replyHtml = replyQuoteHtml(message.replyTo);
    const translation = translationHtml(message, messageIndex);
    const attachmentHtml = renderAttachmentChips([...(message.attachments || []), ...generatedAttachmentsForMessage(message)]);
    const pinnedHtml = message.pinned ? `<span class="message-pin-badge">${ICON_PARK_PIN_SVG}置顶</span>` : "";
    article.innerHTML = `
      <div class="avatar" style="background-color:${escapeHtml(avatarBackgroundColor)};${imageStyle}">${message.role === "user" && !userAvatar ? escapeHtml(label) : ""}</div>
      <div class="message-stack">${traceHtml}<div class="bubble${message.pinned ? " pinned" : ""}" data-message-index="${messageIndex}">${pinnedHtml}${replyHtml}${bodyHtml}${attachmentHtml}${translation}</div>${timeHtml}</div>
    `;
    els.chat.appendChild(article);
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
    const fellowAvatarImage = personaForStream?.avatarImage || avatarAssetForKey(personaForStream?.key);
    const fellowAvatar = avatarImageSrc(fellowAvatarImage);
    const avatarBackgroundColor = fellowAvatar ? "transparent" : (personaForStream?.color || "#23444d");
    const imageStyle = avatarThumbBackgroundStyle(fellowAvatarImage, personaForStream?.avatarCrop, personaForStream?.color);
    const traceHtml = renderTraceBlocks({
      reasoning: s.reasoning,
      tools: s.tools,
      content: s.text,
      expanded: true,
      scopeKey: `run:${s.runId || ""}`
    });
    const textHtml = s.text ? `<div class="bubble">${renderMarkdown(s.text)}</div>${renderMessageTime(s.createdAt)}` : "";
    article.innerHTML = `
      <div class="avatar" style="background-color:${escapeHtml(avatarBackgroundColor)};${imageStyle}"></div>
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
      kind: String(attachment.kind || attachmentKind(attachment)),
      thumbnailDataUrl: String(attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || "")
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
  if (shouldMarkRead) markPersonaRead(session.personaKey || state.activeKey, false);
  state.forceScrollToBottom = true;
  renderChat();
  renderSessionMenu();
  if (options.persist) {
    persistSessionQuietly(session).then(() => {
      if (shouldMarkRead) persistReadStateQuietly();
    });
  } else if (shouldMarkRead) {
    persistReadStateQuietly();
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
  const engine = activeAgentEngine();
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
  const engine = activeAgentEngine();
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
    <button type="button" class="slash-command-item${index === state.slashSelectedIndex ? " active" : ""}" data-command="${escapeHtml(item.command)}">
      <span class="slash-command-token">${escapeHtml(item.command)}</span>
      <span class="slash-command-description">${escapeHtml(item.description)}</span>
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
    <div class="composer-attachment${attachment.thumbnailDataUrl ? " image" : ""}" title="${escapeHtml(attachment.path || attachment.name)}">
      <span class="composer-attachment-kind">${renderAttachmentThumb(attachment, "composer-attachment-thumb")}</span>
      <span class="composer-attachment-name">${escapeHtml(attachment.name || "附件")}</span>
      <span class="composer-attachment-size">${escapeHtml(formatBytes(attachment.size))}</span>
      <button type="button" data-attachment-remove="${escapeHtml(attachment.id)}" title="移除附件" aria-label="移除附件">×</button>
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
        <button class="${plugin.id === state.skillPickerPluginId ? "active" : ""}" type="button" data-skill-picker-plugin="${escapeHtml(plugin.id)}">
          <span>${escapeHtml(plugin.label || plugin.name)}</span>
          <em>${pluginCounts[plugin.id] || plugin.skillCount || 0}</em>
        </button>
      `).join("")}
    </aside>
    <section class="skill-picker-skills">
      <header>
        <span>${escapeHtml(needle ? "搜索结果" : (currentPlugin?.label || "Skills"))}</span>
        <em>${filtered.length}</em>
      </header>
      <div class="skill-picker-list">
        ${filtered.length ? filtered.map((skill) => `
          <button class="skill-picker-item" type="button" data-skill-pick="${escapeHtml(skill.name)}">
            <strong>${escapeHtml(skill.name)}</strong>
            <small>${escapeHtml((skill.description || skillSummaryZh(skill) || "").slice(0, 108))}</small>
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
      kind: saved?.kind || attachmentKind(file),
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
  await trackStartupTask("加载会话", loadChatSessions);
  render();
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
  setTimeout(() => {
    Promise.allSettled([
      trackStartupTask("加载 Hermes 模型列表", loadModelCatalog),
      trackStartupTask("加载引擎能力", loadEngineCapabilities),
      trackStartupTask("加载命令列表", loadSlashCommands),
      trackStartupTask("扫描本地 Skill", loadSkills)
    ]).then(() => render());
  }, 800);
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
    refreshDaemonPairing().catch(console.error);
    refreshRelayPairing().catch(console.error);
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
  renderSkillPreview();
});
els.skillPreviewDialog?.addEventListener("click", (event) => {
  if (event.target === els.skillPreviewDialog) {
    state.skillPreviewOpen = false;
    renderSkillPreview();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.skillContextMenu.open) closeSkillContextMenu();
  if (state.fellowContextMenu.open) closeFellowContextMenu();
  if (state.messageContextMenu.open) closeMessageContextMenu();
  closeComposerAddMenu();
  if (state.skillPreviewOpen) {
    state.skillPreviewOpen = false;
    renderSkillPreview();
  }
});
els.sessionMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  state.sessionMenuOpen = !state.sessionMenuOpen;
  renderSessionMenu();
});
document.addEventListener("click", (event) => {
  if (state.skillContextMenu.open && !els.skillContextMenu?.contains(event.target)) closeSkillContextMenu();
});
document.addEventListener("click", (event) => {
  if (state.fellowContextMenu.open && !els.fellowContextMenu?.contains(event.target)) closeFellowContextMenu();
});
document.addEventListener("click", (event) => {
  if (state.messageContextMenu.open && !els.messageContextMenu?.contains(event.target)) closeMessageContextMenu();
});
els.chat?.addEventListener("contextmenu", (event) => {
  const bubble = event.target.closest(".bubble[data-message-index]");
  if (!bubble || !els.chat.contains(bubble)) return;
  const selection = selectionInsideBubble(bubble);
  event.preventDefault();
  event.stopPropagation();
  openMessageContextMenu(bubble.dataset.messageIndex, event.clientX, event.clientY, selection);
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
  renderPetJobs();
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
  renderContacts();
});
els.skillSearch?.addEventListener("input", () => {
  state.skillFilter = els.skillSearch.value;
  renderSkillLibrary();
});
els.workbenchSearch?.addEventListener("input", () => {
  state.workbenchFilter = els.workbenchSearch.value;
  renderWorkbench();
});
els.workbenchNav?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-workbench-section]");
  if (!button) return;
  state.workbenchSection = button.dataset.workbenchSection || "recent";
  renderWorkbench();
});
document.querySelectorAll("[data-skill-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.skillCategoryFilter = button.dataset.skillFilter || "";
    renderSkillLibrary();
  });
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    state.activeView = button.dataset.view;
    showNarrowContent();
    if (button.dataset.view === "settings") state.settingsOpen = true;
    if (button.dataset.view === "skills" && !state.skillLibrary.skills.length && !state.skillsLoading) loadSkills();
    renderView();
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
  showScrollingScrollbar(event.target);
}, { capture: true, passive: true });
document.addEventListener("pointermove", (event) => {
  updateScrollbarOverlayDrag(event);
  maybeShowScrollbarForPointer(event);
}, { capture: true });
document.addEventListener("pointerup", stopScrollbarOverlayDrag, { capture: true });
document.addEventListener("pointercancel", stopScrollbarOverlayDrag, { capture: true });
document.addEventListener("mouseover", (event) => {
  const target = event.target?.closest?.(".scrollbar-active");
  if (!target) return;
  const previous = scrollbarTimers.get(target);
  if (previous) {
    window.clearTimeout(previous);
    scrollbarTimers.delete(target);
  }
  updateScrollbarOverlay(target);
  target.classList.add("scrollbar-visible");
}, { capture: true, passive: true });
document.addEventListener("mouseout", (event) => {
  const target = event.target?.closest?.(".scrollbar-active");
  if (!target || target.contains(event.relatedTarget)) return;
  scheduleScrollbarHide(target, 500);
}, { capture: true, passive: true });
window.addEventListener("resize", () => {
  if (scrollbarOverlayTarget) updateScrollbarOverlay(scrollbarOverlayTarget);
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
      refreshDaemonPairing().catch(console.error);
      refreshRelayPairing().catch(console.error);
    }
  });
});

els.mobileLanToggle?.addEventListener("click", async () => {
  const enabled = els.mobileLanToggle.getAttribute("aria-checked") === "true";
  try {
    await applyDaemonHost(enabled ? "127.0.0.1" : "0.0.0.0");
  } catch (error) {
    setText(els.mobilePairingHint, `切换失败：${error.message}`);
  }
});

els.mobilePairingReveal?.addEventListener("click", () => {
  state.mobileLanLinkExpanded = !state.mobileLanLinkExpanded;
  renderMobilePairing(state.runtime?.daemon || {});
});

els.mobilePairingLink?.addEventListener("click", async () => {
  const link = currentMobilePairingLink();
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
  renderRelayPairing(state.runtime?.relay || {});
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
    renderRelayPairing(relay);
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
    renderRelayPairing(relay);
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
  const link = currentRelayPairingLink();
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
    const entry = selectedModelEntry();
    if (entry) {
      applyModelEntryToFields(entry);
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
      providerLabel: entry?.providerLabel || providerLabel(entry?.provider || "openai-codex"),
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
  fillModelFieldsFromPreset(els.modelPreset.value);
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
  syncQuickModelLabel();
  const engine = activeAgentEngine();
  if (engine === "claude-code" || engine === "codex") {
    const persona = activePersona();
    const entry = externalModelEntries(engine).find((item) => item.id === els.quickModelSelect.value);
    if (!persona || !entry) return;
    els.quickModelSelect.disabled = true;
    setText(els.modelSwitchStatus, "保存模型...");
    try {
      state.runtime = await window.aimashi.saveFellowEngine({
        key: persona.key,
        agentEngine: engine,
        engineConfig: {
          ...engineConfigForPersona(persona),
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
  const entry = connectedModelEntries().find((item) => item.id === els.quickModelSelect.value);
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
    applyModelEntryToFields(entry);
    setText(els.modelSwitchStatus, "已切换");
    const auth = modelAuthCopy(entry, state.runtime);
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
    els.quickModelSelect.disabled = !connectedModelEntries(state.runtime).length;
  }
});

els.effortSelect?.addEventListener("change", async () => {
  const level = els.effortSelect.value;
  syncEffortControl(state.runtime);
  const engine = activeAgentEngine();
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
          ...engineConfigForPersona(persona),
          effortLevel: level
        }
      });
      syncEffortControl(state.runtime);
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
    syncEffortControl(state.runtime);
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
  const engine = activeAgentEngine();
  if (engine === "claude-code" || engine === "codex") {
    const persona = activePersona();
    if (!persona) return;
    setText(els.permissionLabel, permissionLabelForMode(mode));
    setText(els.modelSwitchStatus, "保存权限...");
    els.permissionMode.disabled = true;
    try {
      state.runtime = await window.aimashi.saveFellowEngine({
        key: persona.key,
        agentEngine: engine,
        engineConfig: {
          ...engineConfigForPersona(persona),
          permissionMode: mode
        }
      });
      syncPermissionControl(state.runtime);
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
  syncPermissionControl({ permissions: { mode } });
  setText(els.modelSwitchStatus, "保存权限...");
  els.permissionMode.disabled = true;
  try {
    state.runtime = await window.aimashi.savePermissions({ mode });
    syncPermissionControl(state.runtime);
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
  const entry = selectedModelEntry();
  applyModelEntryToFields(entry);
  updateModelFieldVisibility();
});

function setFellowAvatarDraft(image, crop = null) {
  const src = canonicalAvatarSrc(image);
  state.fellowAvatarDraft = {
    image: src,
    crop: normalizeCrop(crop || avatarDefaultCropForSrc(src))
  };
  if (els.fellowAvatar) els.fellowAvatar.value = state.fellowAvatarDraft.image;
  renderFellowAvatarDraft();
}

function setProfileAvatarDraft(image, crop = null) {
  const src = canonicalAvatarSrc(image);
  state.profileAvatarDraft = {
    image: src,
    crop: normalizeCrop(crop || avatarDefaultCropForSrc(src))
  };
  if (els.profileAvatarImage) els.profileAvatarImage.value = state.profileAvatarDraft.image;
  renderProfileAvatarDraft();
}

function renderProfileAvatarDraft() {
  if (!els.profileAvatarPreview) return;
  const draft = state.profileAvatarDraft;
  const user = state.runtime?.user || {};
  const crop = normalizeCrop(draft.crop);
  els.profileAvatarPreview.setAttribute("style", avatarBackgroundStyle(draft.image, crop, user.avatarColor || "#111827"));
  els.profileAvatarPreview.title = draft.image ? "点击调整头像裁剪" : "选择头像";
  els.profileAvatarPreview.setAttribute("role", "button");
  els.profileAvatarPreview.setAttribute("tabindex", "0");
  els.profileAvatarPreview.setAttribute("aria-label", "调整头像裁剪");
}

function openProfileDialog() {
  const user = state.runtime?.user || { displayName: "Boss", avatarImage: "", avatarCrop: DEFAULT_AVATAR_CROP };
  state.profileDialogOpen = true;
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
  const activeGroup = avatarPresetGroups[state.fellowAvatarPresetGroup]
    ? state.fellowAvatarPresetGroup
    : "human";
  state.fellowAvatarPresetGroup = activeGroup;
  if (els.fellowAvatarDefaultTabs) {
    els.fellowAvatarDefaultTabs.innerHTML = avatarPresetGroupTabs.map((group) => `
      <button type="button" class="${activeGroup === group.key ? "active" : ""}" data-avatar-group="${escapeHtml(group.key)}" role="tab" aria-selected="${activeGroup === group.key ? "true" : "false"}">${escapeHtml(group.label)}</button>
    `).join("");
    els.fellowAvatarDefaultTabs.querySelectorAll("[data-avatar-group]").forEach((button) => {
      button.addEventListener("click", () => {
        const group = button.dataset.avatarGroup || "human";
        if (!avatarPresetGroups[group] || state.fellowAvatarPresetGroup === group) return;
        state.fellowAvatarPresetGroup = group;
        renderFellowAvatarDefaults();
      });
    });
  }
  const selected = state.fellowAvatarDraft.image;
  const presets = avatarPresetGroups[activeGroup] || avatarPresetGroups.human;
  els.fellowAvatarDefaults.innerHTML = presets.map((preset) => `
    <button type="button" class="avatar-default${selected === preset.src ? " active" : ""}" data-avatar="${escapeHtml(preset.src)}" data-avatar-name="${escapeHtml(preset.name)}" title="${escapeHtml(preset.name)}" aria-label="${escapeHtml(preset.name)}" style="${avatarThumbBackgroundStyle(preset.src, avatarDefaultCropForSrc(preset.src), "#eef0ff")}"></button>
  `).join("");
  els.fellowAvatarDefaults.querySelectorAll("[data-avatar]").forEach((button) => {
    button.addEventListener("click", () => {
      setFellowAvatarDraft(button.dataset.avatar, avatarDefaultCropForSrc(button.dataset.avatar));
      if (els.fellowName) els.fellowName.value = button.dataset.avatarName || avatarPresetBySrc(button.dataset.avatar)?.name || "";
    });
  });
}

function renderFellowAvatarDraft() {
  const draft = state.fellowAvatarDraft;
  const crop = normalizeCrop(draft.crop);
  if (els.fellowAvatarPreview) {
    els.fellowAvatarPreview.setAttribute("style", avatarBackgroundStyle(draft.image, crop, "#eef0ff"));
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
  const crop = normalizeCrop(editor.crop);
  els.avatarCropStage.setAttribute("style", avatarBackgroundStyle(editor.image, crop, "#eef0ff"));
}

function openAvatarCropEditor(image, crop = null, target = "fellow") {
  const src = canonicalAvatarSrc(image);
  state.avatarCropEditor = {
    open: true,
    target,
    image: src,
    crop: normalizeCrop(crop || avatarDefaultCropForSrc(src)),
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
  state.avatarCropEditor.crop = normalizeCrop({
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
  const avatarImage = actualFellow?.avatarImage || defaultAvatarAssets()[0];
  state.fellowAvatarPresetGroup = avatarPresetGroupForSrc(avatarImage) || "human";
  setFellowAvatarDraft(avatarImage, avatarCropForImage(avatarImage, actualFellow?.avatarCrop));
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
els.closePetGenerateDialog?.addEventListener("click", closePetGenerateDialog);
els.cancelPetGenerate?.addEventListener("click", closePetGenerateDialog);
els.addPetReference?.addEventListener("click", () => els.petReferenceFile?.click());
els.petReferenceFile?.addEventListener("change", () => {
  readPetReferenceFile(els.petReferenceFile.files?.[0]);
  els.petReferenceFile.value = "";
});
els.petJobButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  state.petJobPanelOpen = !state.petJobPanelOpen;
  renderPetJobs();
});
els.petGenerateForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fellow = fellowByKey(state.petGenerateFellowKey);
  if (!fellow) return;
  const job = await window.aimashi.generateFellowPet({
    fellowKey: fellow.key,
    prompt: els.petPrompt?.value || "",
    stylePreset: els.petStylePreset?.value || "codex",
    referenceImages: state.petReferences.map((item) => item.src)
  });
  state.petJobs = [job, ...state.petJobs.filter((item) => item.id !== job.id)];
  state.petJobPanelOpen = true;
  closePetGenerateDialog();
  renderPetJobs();
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
  const zoom = Math.max(state.avatarCropEditor.crop.zoom || 1, 1.001);
  const percentDelta = 100 / (stageSize * (1 - zoom));
  updateAvatarCropEditor({
    x: state.avatarCropEditor.crop.x + dx * percentDelta,
    y: state.avatarCropEditor.crop.y + dy * percentDelta
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
    zoom: state.avatarCropEditor.crop.zoom + direction * 0.08
  });
});
els.confirmAvatarCrop?.addEventListener("click", () => {
  if (state.avatarCropEditor.target === "profile") {
    setProfileAvatarDraft(state.avatarCropEditor.image, state.avatarCropEditor.crop);
  } else {
    setFellowAvatarDraft(state.avatarCropEditor.image, state.avatarCropEditor.crop);
  }
  closeAvatarCropEditor();
});
els.cancelAvatarCrop?.addEventListener("click", closeAvatarCropEditor);
els.resetAvatarCrop?.addEventListener("click", () => {
  state.avatarCropEditor.crop = normalizeCrop(avatarDefaultCropForSrc(state.avatarCropEditor.image));
  renderAvatarCropEditor();
});

els.profileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const displayName = els.profileDisplayName.value.trim() || "Boss";
  state.runtime = await window.aimashi.saveProfile({
    displayName,
    avatarText: initials(displayName),
    avatarImage: state.profileAvatarDraft.image || els.profileAvatarImage.value,
    avatarCrop: normalizeCrop(state.profileAvatarDraft.crop)
  });
  closeProfileDialog();
  render();
});

els.appearanceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  scheduleAppearanceSave(0);
});

els.appearanceTheme.addEventListener("change", () => {
  scheduleAppearanceSave(0);
});

els.appearanceFontPreset.addEventListener("change", () => {
  scheduleAppearanceSave(0);
});

els.appearanceFontChoices?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-font-preset]");
  if (!button || !els.appearanceFontChoices.contains(button)) return;
  els.appearanceFontPreset.value = button.dataset.fontPreset || "system";
  scheduleAppearanceSave(0);
});

els.appearanceListStyle?.addEventListener("change", () => {
  scheduleAppearanceSave(0);
});

els.appearanceSelectionStyle?.addEventListener("change", () => {
  scheduleAppearanceSave(0);
});

els.appearanceAccentColor?.addEventListener("input", () => {
  scheduleAppearanceSave();
});

els.appearanceAccentReset?.addEventListener("click", () => {
  if (els.appearanceAccentColor) els.appearanceAccentColor.value = DEFAULT_ACCENT_COLOR;
  scheduleAppearanceSave(0);
});

els.appearanceUserBubbleColor?.addEventListener("input", () => {
  scheduleAppearanceSave();
});

els.appearanceUserBubbleReset?.addEventListener("click", () => {
  if (els.appearanceUserBubbleColor) els.appearanceUserBubbleColor.value = DEFAULT_USER_BUBBLE_COLOR;
  scheduleAppearanceSave(0);
});

els.appearanceShowHoverBackground?.addEventListener("click", () => {
  toggleSettingsSwitch(els.appearanceShowHoverBackground);
});

els.appearanceShowUserAvatar?.addEventListener("click", () => {
  toggleSettingsSwitch(els.appearanceShowUserAvatar);
});

els.appearanceShowAssistantAvatar?.addEventListener("click", () => {
  toggleSettingsSwitch(els.appearanceShowAssistantAvatar);
});

els.fellowForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fellow = {
    key: els.fellowKey?.value || "",
    name: els.fellowName.value,
    agentEngine: els.fellowAgentEngine?.value || "hermes",
    avatarImage: state.fellowAvatarDraft.image || els.fellowAvatar.value,
    avatarCrop: normalizeCrop(state.fellowAvatarDraft.crop),
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
  const entry = selectedModelEntry();
  if (!entry || providerIsConnected(entry.provider)) return;
  const needsApiKey = entry.provider !== "openai-codex" && entry.provider !== "lmstudio" && !String(entry.authType || "").startsWith("oauth");
  if (needsApiKey && !els.modelApiKey.value.trim()) {
    setText(els.modelAuthState, `需要填写 ${entry.apiKeyEnv || "API Key"}`);
    return;
  }
  if (entry) applyModelEntryToFields(entry);
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
    const outgoingText = replyContextPrompt(await outgoingMessageForSubmit(text), replyTo);
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
    const answer = response.choices?.[0]?.message?.content || "(No response)";
    const traceSnapshot = state.streaming
      ? { reasoning: state.streaming.reasoning || "", tools: state.streaming.tools.slice() }
      : { reasoning: "", tools: [] };
    state.streaming = null;
    appendChat("assistant", answer, { reasoning: traceSnapshot.reasoning, tools: traceSnapshot.tools });
    await persistSessionQuietly(session);
    persistReadStateQuietly();
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
    if (String(error.message || "").includes("生成已停止")) {
      await persistSessionQuietly(session);
    } else {
      appendChat("assistant", `Request failed: ${error.message}`);
      await persistSessionQuietly(session);
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
  const trailing = startupLoading ? ` · 正在${escapeHtml(startupLoading)}` : "";
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
initializeRuntime();
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
