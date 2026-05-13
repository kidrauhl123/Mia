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
let appearanceSaveStatusTimer = 0;
const qrSvgCache = new Map();

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
  activeKey: "aimashi",
  chatStore: { schema_version: 1, readAt: {}, sessions: {} },
  activeSessionIdByPersona: {},
  generatingTitleIds: new Set(),
  startupTasks: [],
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
  skillSourceFilter: "aimashi",
  skillStatusFilter: "all",
  skillContextMenu: { open: false, x: 0, y: 0, skillId: "" },
  fellowContextMenu: { open: false, x: 0, y: 0, fellowKey: "" },
  fellowMenuOpen: false,
  profileDialogOpen: false,
  fellowDialogOpen: false,
  fellowDialogMode: "create",
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
  skillLibrary: { roots: [], skills: [] },
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
  composerAttachments: document.getElementById("composerAttachments"),
  composerAttachmentInput: document.getElementById("composerAttachmentInput"),
  slashCommandMenu: document.getElementById("slashCommandMenu"),
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

function showScrollingScrollbar(target) {
  if (!(target instanceof Element)) return;
  if (target === document.documentElement || target === document.body) return;
  if (target.scrollHeight <= target.clientHeight && target.scrollWidth <= target.clientWidth) return;
  target.classList.add("scrollbar-visible");
  target.classList.add("scrollbar-active");
  const previous = scrollbarTimers.get(target);
  if (previous) window.clearTimeout(previous);
  const hide = () => {
    if (target.matches(":hover")) return;
    target.classList.remove("scrollbar-visible");
    target.classList.remove("scrollbar-active");
    scrollbarTimers.delete(target);
  };
  scrollbarTimers.set(target, window.setTimeout(hide, 850));
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
  "openai-codex": {
    provider: "openai-codex",
    model: "gpt-5.3-codex",
    apiKeyEnv: "",
    baseUrl: "",
    apiMode: "codex_responses"
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
  return [
    { value: "manual", label: "Ask", title: "危险命令会暂停并等待你确认。适合日常使用。" },
    { value: "smart", label: "Smart", title: "Hermes 会用辅助模型判断低风险命令，高风险命令仍会询问你。" },
    { value: "off", label: "YOLO", title: "跳过危险命令确认。只在你完全信任当前任务时使用。" }
  ];
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
  return [
    { value: "none", label: "None" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra high" }
  ];
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
  const selected = els.quickModelSelect.selectedOptions?.[0];
  setText(els.quickModelLabel, selected?.textContent || "选择模型");
}

function permissionLabelForMode(mode = "") {
  const selected = els.permissionMode?.selectedOptions?.[0];
  if (selected?.textContent) return selected.textContent;
  if (mode === "smart") return "Smart";
  if (mode === "off") return "YOLO";
  if (mode === "acceptEdits") return activeAgentEngine() === "claude-code" ? "Accept Edits" : "Edits";
  if (mode === "plan") return activeAgentEngine() === "claude-code" ? "Plan Mode" : "Plan";
  if (mode === "auto") return "Auto Mode";
  if (mode === "dontAsk") return "Deny";
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
  switcher?.classList.toggle("yolo", els.permissionMode.value === "off" || (engine !== "claude-code" && els.permissionMode.value === "bypassPermissions"));
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
  if (current && !entries.some((entry) => entry.id === current.id)) return [current, ...entries];
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
      <span class="provider-logo-wrap"><img class="provider-logo" src="${escapeHtml(providerIconSrc(provider.provider))}" alt="" onerror="this.style.display='none'"></span>
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

const DEFAULT_ACCENT_COLOR = "#5e5ce6";
const DEFAULT_LIST_STYLE = "card";
const DEFAULT_SELECTION_STYLE = "soft";

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
  const listStyle = normalizeListStyle(appearance.listStyle);
  const selectionStyle = normalizeSelectionStyle(appearance.selectionStyle);
  const softActive = `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${theme === "dark" ? "0.22" : "0.16"})`;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.listStyle = listStyle;
  document.documentElement.dataset.selectionStyle = selectionStyle;
  document.documentElement.style.setProperty("--app-font", fontStackForAppearance(appearance));
  document.documentElement.style.setProperty("--accent", accentColor);
  document.documentElement.style.setProperty("--accent-rgb", `${rgb.r} ${rgb.g} ${rgb.b}`);
  document.documentElement.style.setProperty("--active", softActive);
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
    listStyle: normalizeListStyle(els.appearanceListStyle?.value),
    selectionStyle: normalizeSelectionStyle(els.appearanceSelectionStyle?.value)
  };
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

const avatarPresets = [
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
];

function defaultAvatarAssets() {
  return avatarPresets.map((preset) => preset.src);
}

function canonicalAvatarSrc(src) {
  return String(src || "").trim().replace("./assets/avatar-icons/", "./assets/avatars/");
}

function avatarPresetBySrc(src) {
  const canonical = canonicalAvatarSrc(src);
  return avatarPresets.find((preset) => preset.src === canonical) || null;
}

function avatarThumbForSrc(src) {
  const preset = avatarPresetBySrc(src);
  if (!preset) return "";
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

function renderMarkdown(value) {
  let html = escapeHtml(value);
  html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.*)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, '<code tabindex="0" title="点击复制">$1</code>');
  html = html.replace(/^\s*[-*]\s+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>)(\n<li>.*<\/li>)*/gs, (match) => `<ul>${match.replace(/\n/g, "")}</ul>`);
  return html.replace(/\n/g, "<br>");
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
      ${attachments.map((attachment) => `
        <span class="message-attachment" title="${escapeHtml(attachment.path || attachment.name || "")}">
          <span>${escapeHtml(attachmentGlyph(attachment))}</span>
          <strong>${escapeHtml(attachment.name || "附件")}</strong>
          <em>${escapeHtml(formatBytes(attachment.size))}</em>
        </span>
      `).join("")}
    </div>
  `;
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
    state.skillLibrary = {
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
    state.skillLibrary = { roots: [], skills: [] };
    state.selectedSkillId = "";
    state.selectedSkillDetail = null;
  } finally {
    state.skillsLoading = false;
    renderSkillLibrary();
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

function render() {
  const runtime = state.runtime;
  if (!runtime) return;
  renderSendButton();
  const editingModel = els.modelForm.contains(document.activeElement);
  const editingProfile = Boolean(els.profileForm?.contains(document.activeElement));
  const editingAppearance = Boolean(els.appearanceForm?.contains(document.activeElement));
  const appearance = runtime.appearance || {
    theme: "light",
    fontPreset: "system",
    accentColor: DEFAULT_ACCENT_COLOR,
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
  els.hermesHome.textContent = runtime.hermesHome;
  els.manifestPath.textContent = runtime.manifestPath;
  els.engineWarning.classList.toggle("hidden", runtime.engineInstalled);
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
      : `当前模型：${modelDisplayName(runtime.model)}`;
  }
  const activeIcon = engine === "claude-code"
    ? modelIconSrc({ provider: "anthropic", model: "claude" })
    : engine === "codex"
      ? modelIconSrc({ provider: "openai-codex", model: "codex" })
      : modelIconSrc(runtime.model || {});
  const modelAvatar = document.querySelector(".model-avatar");
  if (modelAvatar) {
    modelAvatar.textContent = activeIcon ? "" : "◇";
    modelAvatar.style.backgroundImage = activeIcon ? `url("${activeIcon}")` : "";
  }
  syncPermissionControl(runtime);

  const personas = runtime.fellows || runtime.personas || [];
  if (!personas.some((persona) => persona.key === state.activeKey) && personas.length) {
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
  const active = personas.find((persona) => persona.key === state.activeKey) || personas[0];
  if (active) {
    applyFellowAvatar(els.activeChatAvatar, active);
    setText(els.activeChatName, active.name || "Aimashi");
    renderHeaderStatus();
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
        <span class="persona-pin${persona.pinned ? "" : " hidden"}" aria-label="置顶">⌖</span>
        <span class="persona-unread${unread ? "" : " hidden"}">${escapeHtml(unread > 99 ? "99+" : String(unread))}</span>
      </span>
    `;
    button.addEventListener("click", () => {
      state.activeKey = persona.key;
      const latest = sessionsForPersona(persona.key)[0];
      state.activeSessionIdByPersona[persona.key] = latest?.id;
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
  if (!visiblePersonas.length) {
    const empty = document.createElement("div");
    empty.className = "persona-empty";
    empty.textContent = "没有匹配的伙伴";
    els.personaList.appendChild(empty);
  }
  renderView();
  renderSessionMenu();
  renderChat();
}

function renderView() {
  if (state.activeSettingsTab === "profile") state.activeSettingsTab = "appearance";
  syncNarrowLayout();
  els.conversationSidebar?.classList.toggle("hidden", state.activeView !== "chat");
  els.contactsSidebar?.classList.toggle("hidden", state.activeView !== "contacts");
  els.skillsSidebar?.classList.toggle("hidden", state.activeView !== "skills");
  els.chatView.classList.toggle("hidden", state.activeView !== "chat");
  els.contactsView?.classList.toggle("hidden", state.activeView !== "contacts");
  els.skillsView?.classList.toggle("hidden", state.activeView !== "skills");
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

function skillSourceLabel(source = "") {
  const labels = {
    aimashi: "本地 Skill",
    hermes: "Hermes 外部库",
    codex: "Codex 外部库",
    claude: "Claude Code 外部库"
  };
  return labels[source] || "Skill";
}

function skillAuthorLabel(skill = {}) {
  if (skill.source === "aimashi") return "Aimashi Runtime";
  if (skill.source === "hermes") return "Hermes";
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
    if (state.skillSourceFilter && skill.source !== state.skillSourceFilter) return false;
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
  if (state.skillSourceFilter && skill.source !== state.skillSourceFilter) return false;
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
  const active = state.skillSourceFilter === row.source && state.skillStatusFilter === row.status;
  return `
    <button class="skill-filter-row${row.child ? " child" : ""}${active ? " active" : ""}" type="button" data-skill-source="${escapeHtml(row.source)}" data-skill-status="${escapeHtml(row.status)}">
      <span><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.sub)}</small></span>
      <em>${row.count}</em>
    </button>
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
  const shown = visibleSkills();
  const sourceCounts = skills.reduce((acc, skill) => {
    acc[skill.source] = (acc[skill.source] || 0) + 1;
    return acc;
  }, {});
  const localCount = sourceCounts.aimashi || 0;
  const updateCount = skills.filter((skill) => skill.source === "aimashi" && skillHasUpdate(skill)).length;
  const currentSource = skillSourceLabel(state.skillSourceFilter);
  setText(els.skillPageTitle, state.skillsLoading ? "正在扫描 Skill" : currentSource);

  const categories = skillCategories();
  els.skillChipRow.innerHTML = [
    `<button class="${state.skillCategoryFilter ? "" : "active"}" type="button" data-skill-filter="">全部</button>`,
    ...categories.slice(0, 10).map(([category, count]) => `
      <button class="${state.skillCategoryFilter === category ? "active" : ""}" type="button" data-skill-filter="${escapeHtml(category)}">
        ${escapeHtml(category)} <span>${count}</span>
      </button>
    `)
  ].join("");

  const navRows = [
    { label: "已安装", sub: "Aimashi 自己管理的技能", source: "aimashi", status: "all", count: localCount, child: true },
    { label: "可更新", sub: "来自市场的可升级版本", source: "aimashi", status: "updates", count: updateCount, child: true },
    { label: "Hermes", sub: "外部 Hermes 技能目录", source: "hermes", status: "all", count: sourceCounts.hermes || 0 },
    { label: "Codex", sub: "外部 Codex 技能目录", source: "codex", status: "all", count: sourceCounts.codex || 0 },
    { label: "Claude Code", sub: "外部 Claude 技能目录", source: "claude", status: "all", count: sourceCounts.claude || 0 }
  ];
  els.skillNav.innerHTML = `
    <div class="skill-section-label">本地 Skill</div>
    ${navRows.slice(0, 2).map((row) => renderSkillFilterRow(row)).join("")}
    <div class="skill-section-label">外部来源</div>
    ${navRows.slice(2).map((row) => renderSkillFilterRow(row)).join("")}
    <div class="skill-section-label">市场</div>
    <button class="skill-filter-row disabled" type="button" disabled>
      <span><strong>Skill 市场</strong><small>下载、更新和删除会放在这里收口</small></span>
      <em>Soon</em>
    </button>
  `;

  els.skillCardGrid.innerHTML = shown.length
    ? shown.map((skill) => `
      <article class="skill-card${skill.id === state.selectedSkillId ? " featured" : ""}" data-skill-select="${escapeHtml(skill.id)}">
        <header>
          <strong>${escapeHtml(skillDisplayName(skill))}</strong>
          <small>${escapeHtml(skillAuthorLabel(skill))}</small>
        </header>
        <p>${escapeHtml(skillSummaryZh(skill))}</p>
      </article>
    `).join("")
    : `<div class="skill-empty-state">${skillEmptyText()}</div>`;

  els.skillNav.querySelectorAll("[data-skill-source]").forEach((button) => {
    button.addEventListener("click", () => {
      state.skillSourceFilter = button.dataset.skillSource || "aimashi";
      state.skillStatusFilter = button.dataset.skillStatus || "all";
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
    <button type="button" data-skill-action="preview">预览</button>
    <button type="button" data-skill-action="open-directory">打开目录</button>
    <button class="danger" type="button" data-skill-action="delete" ${canDelete ? "" : "disabled"}>删除</button>
  `;
  const width = 150;
  const height = 96;
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

function renderContacts() {
  if (!els.contactList || !els.contactDetail) return;
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
    const pet = petStatusForKey(fellow.key);
    const petLabel = contactPetLabel(pet);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `contact-row${fellow.key === state.activeContactKey ? " active" : ""}`;
    button.innerHTML = `
      <span class="avatar fellow-photo" style="${avatarThumbBackgroundStyle(fellow.avatarImage || avatarAssetForKey(fellow.key), fellow.avatarCrop, fellow.color || "#5e5ce6")}"></span>
      <span class="contact-row-main">
        <strong>${escapeHtml(fellow.name)}</strong>
        ${petLabel ? `<small>${escapeHtml(petLabel)}</small>` : ""}
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
  const pet = petStatusForKey(fellow.key);
  const petAction = pet.hasAsset
    ? pet.placed
      ? { action: "recall", label: `收回「${fellow.name}」` }
      : { action: "place", label: "放进桌面" }
    : { action: "generate-pet", label: "生成桌宠" };
  const petLabel = contactPetLabel(pet) || "未生成桌宠";
  setText(els.contactPageTitle, fellow.name || "联系人");
  setText(els.contactPageMeta, `${summary.count} 个会话 · ${petLabel}`);
  els.contactDetail.innerHTML = `
    <article class="contact-profile">
      <header class="contact-profile-head">
        <button class="contact-profile-avatar" type="button" data-contact-action="edit" title="编辑联系人头像" style="${avatarBackgroundStyle(fellow.avatarImage || avatarAssetForKey(fellow.key), fellow.avatarCrop, fellow.color || "#5e5ce6")}"></button>
        <div class="contact-profile-title">
          <h2>${escapeHtml(fellow.name || "联系人")}</h2>
          <p>${escapeHtml(fellow.bio || "本地伙伴")}</p>
        </div>
      </header>
      <div class="contact-actions">
        <button class="primary" type="button" data-contact-action="message">发消息</button>
        <button class="secondary" type="button" data-contact-action="edit">编辑</button>
        <button class="secondary" type="button" data-contact-action="${escapeHtml(petAction.action)}">${escapeHtml(petAction.label)}</button>
        ${fellow.key === "aimashi" ? "" : `<button class="secondary danger" type="button" data-contact-action="delete">删除伙伴</button>`}
      </div>
      <dl class="contact-facts">
        <div><dt>账号</dt><dd>${escapeHtml(fellow.account_id || fellow.key)}</dd></div>
        <div><dt>路由</dt><dd>${escapeHtml(fellow.route_profile || fellow.key)}</dd></div>
        <div><dt>会话</dt><dd>${escapeHtml(String(summary.count))}</dd></div>
        <div><dt>桌宠</dt><dd>${escapeHtml(petLabel)}</dd></div>
      </dl>
      <section class="contact-note">
        <strong>最近内容</strong>
        <p>${escapeHtml(summary.preview)}</p>
      </section>
    </article>
  `;
  els.contactDetail.querySelector('[data-contact-action="message"]')?.addEventListener("click", () => openFellowChat(fellow.key));
  els.contactDetail.querySelectorAll('[data-contact-action="edit"]').forEach((button) => {
    button.addEventListener("click", () => openEditFellowDialog(fellow.key));
  });
  els.contactDetail.querySelector('[data-contact-action="generate-pet"]')?.addEventListener("click", () => openPetGenerateDialog(fellow.key));
  els.contactDetail.querySelector('[data-contact-action="place"]')?.addEventListener("click", async () => {
    await placeFellowPet(fellow.key);
  });
  els.contactDetail.querySelector('[data-contact-action="recall"]')?.addEventListener("click", async () => {
    await recallFellowPet(fellow.key);
  });
  els.contactDetail.querySelector('[data-contact-action="delete"]')?.addEventListener("click", async () => {
    await deleteFellow(fellow.key);
  });
}

function petStatusForKey(key) {
  return state.runtime?.pets?.[key] || { hasAsset: false, placed: false, petId: "" };
}

function openFellowContextMenu(fellowKey, x, y) {
  if (!fellowKey) return;
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
      ? `<button type="button" data-fellow-action="recall">收回「${escapeHtml(fellow.name)}」</button>`
      : `<button type="button" data-fellow-action="place">放进桌面</button>`
    : `<button type="button" data-fellow-action="generate-pet">生成桌宠</button>`;
  menu.innerHTML = `
    <button type="button" data-fellow-action="pin">${fellow.pinned ? "取消置顶" : "置顶"}</button>
    <button type="button" data-fellow-action="edit">编辑</button>
    ${petAction}
    ${fellow.key === "aimashi" ? "" : `<button class="danger" type="button" data-fellow-action="delete">删除伙伴</button>`}
  `;
  const width = 168;
  const height = fellow.key === "aimashi" ? 100 : 129;
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
    state.skillLibrary = {
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
      <em title="重命名" data-session-edit="${escapeHtml(session.id)}">✎</em>
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

function renderChat() {
  const wasNearBottom = !els.chat || (els.chat.scrollHeight - els.chat.scrollTop - els.chat.clientHeight < 80);
  const session = activeSession();
  const messages = session.messages;
  const user = state.runtime?.user || { displayName: "Boss", avatarText: "B", avatarColor: "#111827" };
  const active = activePersona();
  const activeAgentEngine = active?.agentEngine || active?.agent_engine || "hermes";
  const usesHermes = !["claude-code", "codex"].includes(activeAgentEngine);
  els.chat.innerHTML = "";
  for (const message of messages) {
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
    const attachmentHtml = renderAttachmentChips(message.attachments);
    article.innerHTML = `
      <div class="avatar" style="background-color:${escapeHtml(avatarBackgroundColor)};${imageStyle}">${message.role === "user" && !userAvatar ? escapeHtml(label) : ""}</div>
      <div class="message-stack">${traceHtml}<div class="bubble has-time">${bodyHtml}${attachmentHtml}${timeHtml}</div></div>
    `;
    els.chat.appendChild(article);
  }
  if (usesHermes && state.runtime && !state.runtime.engineInstalled) {
    const warning = document.createElement("article");
    warning.className = "message warning";
    warning.innerHTML = `
      <div class="avatar">!</div>
      <div class="bubble"><strong>Engine not installed</strong><p>点击 Install Engine，把官方 Hermes package 安装到 Aimashi 私有 runtime。</p></div>
    `;
    els.chat.appendChild(warning);
  }
  if (usesHermes && state.runtime?.engineInstalled && !state.runtime?.model?.hasApiKey) {
    const warning = document.createElement("article");
    warning.className = "message warning";
    warning.innerHTML = `
      <div class="avatar">!</div>
      <div class="bubble"><strong>Model login needed</strong><p>私有 Hermes 已就绪；可以在右侧保存 API key，或使用 OpenAI Codex 登录。</p></div>
    `;
    els.chat.appendChild(warning);
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
    const textHtml = s.text ? `<div class="bubble has-time">${renderMarkdown(s.text)}${renderMessageTime(s.createdAt)}</div>` : "";
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

function appendChat(role, content, options = {}) {
  const session = activeSession();
  const message = { role, content, createdAt: nowIso(), transient: Boolean(options.transient) };
  if (Array.isArray(options.attachments) && options.attachments.length) {
    message.attachments = options.attachments.map((attachment) => ({
      id: String(attachment.id || cryptoRandomId()),
      name: String(attachment.name || "附件"),
      path: String(attachment.path || ""),
      mime: String(attachment.mime || attachment.type || ""),
      size: Number(attachment.size) || 0,
      kind: String(attachment.kind || attachmentKind(attachment))
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
}

function renderComposerAttachments() {
  if (!els.composerAttachments) return;
  const attachments = state.pendingAttachments;
  els.composerAttachments.classList.toggle("hidden", attachments.length === 0);
  els.composerAttachments.innerHTML = attachments.map((attachment) => `
    <div class="composer-attachment" title="${escapeHtml(attachment.path || attachment.name)}">
      <span class="composer-attachment-kind">${escapeHtml(attachmentGlyph(attachment))}</span>
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

async function addComposerFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;
  const existing = new Set(state.pendingAttachments.map((item) => item.path || `${item.name}:${item.size}`));
  const next = [];
  for (const file of files.slice(0, 20)) {
    let filePath = "";
    let saved = null;
    try {
      filePath = await window.aimashi.filePathForFile?.(file);
      if (!filePath) {
        saved = await saveBrowserFileAttachment(file);
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
      kind: saved?.kind || attachmentKind(file)
    });
  }
  if (!next.length) return;
  state.pendingAttachments = [...state.pendingAttachments, ...next].slice(0, 20);
  renderComposerAttachments();
  renderSendButton();
  els.chatInput?.focus();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error || new Error("读取附件失败")));
    reader.readAsDataURL(file);
  });
}

async function saveBrowserFileAttachment(file) {
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
    dataUrl
  });
}

function commandTextForSend(command) {
  return String(command.command || "").trim();
}

async function sendSlashCommand(command) {
  const text = commandTextForSend(command);
  if (!text) return;
  els.chatInput.value = text;
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
  state.runtime = await trackStartupTask("初始化 runtime", () => window.aimashi.initializeRuntime());
  await trackStartupTask("加载会话", loadChatSessions);
  render();
  setTimeout(() => {
    Promise.allSettled([
      trackStartupTask("加载 Hermes 模型列表", loadModelCatalog),
      trackStartupTask("加载命令列表", loadSlashCommands),
      trackStartupTask("扫描本地 Skill", loadSkills)
    ]).then(() => render());
  }, 800);
}

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
  if (els.composerAddMenu?.contains(event.target) || els.composerAdd?.contains(event.target)) return;
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
document.addEventListener("mouseover", (event) => {
  const target = event.target?.closest?.(".scrollbar-active");
  if (!target) return;
  const previous = scrollbarTimers.get(target);
  if (previous) {
    window.clearTimeout(previous);
    scrollbarTimers.delete(target);
  }
  target.classList.add("scrollbar-visible");
}, { capture: true, passive: true });
document.addEventListener("mouseout", (event) => {
  const target = event.target?.closest?.(".scrollbar-active");
  if (!target || target.contains(event.relatedTarget)) return;
  const previous = scrollbarTimers.get(target);
  if (previous) window.clearTimeout(previous);
  scrollbarTimers.set(target, window.setTimeout(() => {
    if (target.matches(":hover")) return;
    target.classList.remove("scrollbar-visible");
    target.classList.remove("scrollbar-active");
    scrollbarTimers.delete(target);
  }, 500));
}, { capture: true, passive: true });
window.addEventListener("resize", () => {
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
  const selected = state.fellowAvatarDraft.image;
  els.fellowAvatarDefaults.innerHTML = avatarPresets.map((preset) => `
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
  state.fellowMenuOpen = false;
  state.fellowDialogMode = fellow ? "edit" : "create";
  state.fellowDialogOpen = true;
  const titleName = String(fellow?.name || "").trim();
  if (els.fellowDialogTitle) els.fellowDialogTitle.textContent = fellow ? `编辑「${titleName || "伙伴"}」` : "添加伙伴";
  if (els.fellowKey) els.fellowKey.value = fellow?.key || "";
  els.fellowName.value = fellow?.name || "";
  renderFellowAgentEngineSelect(fellow?.agentEngine || fellow?.agent_engine || "hermes");
  const avatarImage = fellow?.avatarImage || defaultAvatarAssets()[0];
  setFellowAvatarDraft(avatarImage, avatarCropForImage(avatarImage, fellow?.avatarCrop));
  els.fellowSeed.value = fellow ? personaText : "";
  if (els.fellowPersonaDetails) els.fellowPersonaDetails.open = false;
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
  const next = currentAppearanceDraft();
  const submitButton = els.appearanceForm.querySelector('button[type="submit"]');
  const previousText = submitButton?.textContent || "保存外观";
  applyAppearance(next);
  showAppearanceSaveStatus("正在保存...");
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "保存中";
  }
  try {
    state.runtime = await window.aimashi.saveAppearance(next);
    render();
    showAppearanceSaveStatus("已保存");
    if (submitButton) submitButton.textContent = "已保存";
    window.setTimeout(() => {
      if (submitButton) submitButton.textContent = previousText;
    }, 1000);
  } catch (error) {
    console.error(error);
    showAppearanceSaveStatus("保存失败", "error");
    if (submitButton) submitButton.textContent = previousText;
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

els.appearanceTheme.addEventListener("change", () => {
  const next = currentAppearanceDraft();
  applyAppearance(next);
  syncAppearanceControls(next);
});

els.appearanceFontPreset.addEventListener("change", () => {
  const next = currentAppearanceDraft();
  applyAppearance(next);
  syncAppearanceControls(next);
});

els.appearanceFontChoices?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-font-preset]");
  if (!button || !els.appearanceFontChoices.contains(button)) return;
  els.appearanceFontPreset.value = button.dataset.fontPreset || "system";
  const next = currentAppearanceDraft();
  applyAppearance(next);
  syncAppearanceControls(next);
});

els.appearanceListStyle?.addEventListener("change", () => {
  const next = currentAppearanceDraft();
  applyAppearance(next);
  syncAppearanceControls(next);
});

els.appearanceSelectionStyle?.addEventListener("change", () => {
  const next = currentAppearanceDraft();
  applyAppearance(next);
  syncAppearanceControls(next);
});

els.appearanceAccentColor?.addEventListener("input", () => {
  const next = currentAppearanceDraft();
  applyAppearance(next);
  syncAppearanceControls(next);
});

els.appearanceAccentReset?.addEventListener("click", () => {
  if (els.appearanceAccentColor) els.appearanceAccentColor.value = DEFAULT_ACCENT_COLOR;
  const next = currentAppearanceDraft();
  applyAppearance(next);
  syncAppearanceControls(next);
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

els.chatInput.addEventListener("input", () => {
  updateSlashCommandState();
  renderSendButton();
});
els.chatInput.addEventListener("click", updateSlashCommandState);
els.composerAdd?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  state.composerAddMenuOpen = !state.composerAddMenuOpen;
  state.slashMenuOpen = false;
  renderSlashCommandMenu();
  renderComposerAddMenu();
});
els.composerAddMenu?.addEventListener("click", (event) => {
  const action = event.target.closest("[data-composer-add]")?.dataset.composerAdd;
  if (!action) return;
  event.preventDefault();
  closeComposerAddMenu();
  if (action === "attachment") {
    els.composerAttachmentInput?.click();
    return;
  }
  els.chatInput?.focus();
});
els.composerAttachmentInput?.addEventListener("change", () => {
  addComposerFiles(els.composerAttachmentInput.files);
  els.composerAttachmentInput.value = "";
});
els.composerAttachments?.addEventListener("click", (event) => {
  if (event.target.closest("[data-attachment-remove]")) return;
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
  const code = event.target.closest(".bubble code");
  if (!code || !els.chat.contains(code)) return;
  if (await copyTextToClipboard(code.textContent)) flashCopiedCode(code);
});
els.chat.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const code = event.target.closest(".bubble code");
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
  if (state.isGenerating) {
    await window.aimashi.stopChat?.();
    return;
  }
  const text = els.chatInput.value.trim();
  const attachments = state.pendingAttachments.map((attachment) => ({ ...attachment }));
  if (!text && !attachments.length) return;
  const session = activeSession();
  const shouldGenerateTitle = !session.titleGenerated && !hasSuccessfulExchange(session);
  els.chatInput.value = "";
  state.pendingAttachments = [];
  renderComposerAttachments();
  renderSendButton();
  const userText = text || "请查看附件。";
  appendChat("user", userText, { attachments });
  state.streaming = null;
  state.isGenerating = true;
  renderSendButton();
  renderHeaderStatus();
  try {
    const outgoingText = await outgoingMessageForSubmit(text);
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

function renderHeaderStatus() {
  if (!els.activeChatMeta) return;
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

initializeRuntime();
renderSendButton();
renderHeaderStatus();
setInterval(refreshRuntime, 2000);
