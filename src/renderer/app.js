const SETUP_GUIDE_DISMISSED_KEY = window.miaAppState.SETUP_GUIDE_DISMISSED_KEY;
const AGENT_SETUP_SKIPPED_KEY = window.miaAppState.AGENT_SETUP_SKIPPED_KEY;
const { ConversationKind, MemberKind, SenderKind } = (typeof window !== "undefined" && window.miaConversationKinds) || require("../shared/conversation-kinds");
const { prepareOutgoingMessage } = (typeof window !== "undefined" && window.miaSendPipeline) || require("../shared/send-pipeline");
const sessionHistory = (typeof window !== "undefined" && window.miaSessionHistory) || require("../shared/session-history");
const SIDEBAR_WIDTH_MIN = 260;
const SIDEBAR_WIDTH_MAX = 460;
const SIDEBAR_WIDTH_DEFAULT = 320;
const SHELL_SINGLE_MAX_WIDTH = 720;
let skillPickerHoverCloseTimer = 0;
let profilePopoverHideTimer = 0;
let profileSaveDebounceTimer = 0;
let lastNativeControlsLayout = "";
let profileSaveInFlight = false;
let profileSaveRequested = false;
let profileLastSaveSignature = "";
let avatarTrimDrag = null;
const botRuntimeControlCache = new Map();
const botRuntimeControlInFlight = new Set();
const platformModelCatalog = { loaded: false, loading: false, entries: [] };
let socialBootstrapInFlight = null;
let starterEngineBotsInFlight = null;
let personaSearchTimer = 0;
let personaSearchSerial = 0;
let shellLayoutTransitionTimer = 0;
let sidebarTagIndicatorFrame = 0;
let lastConversationFolderKey = null;
let conversationFolderMotion = { key: "", direction: 1 };
let personaFolderAnimationTimer = 0;
let personaListRenderSignature = "";
let chatConversationMenuRenderSignature = "";
let conversationFolderDrag = null;
let conversationFolderSuppressClick = false;
const CONVERSATION_FOLDER_ORDER_KEY = "mia.conversationFolderOrder.v1";
const CONVERSATION_FOLDER_ALL_KEY = "__all__";
const CONVERSATION_FOLDER_LONG_PRESS_MS = 260;
const ICON_PARK_PIN_SVG = '<svg class="icon-park-pin" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="M10.6963 17.5042C13.3347 14.8657 16.4701 14.9387 19.8781 16.8076L32.62 9.74509L31.8989 4.78683L43.2126 16.1005L38.2656 15.3907L31.1918 28.1214C32.9752 31.7589 33.1337 34.6647 30.4953 37.3032C30.4953 37.3032 26.235 33.0429 22.7171 29.525L6.44305 41.5564L18.4382 25.2461C14.9202 21.7281 10.6963 17.5042 10.6963 17.5042Z"/></svg>';
const rendererPlatform = String(window.mia?.platform || "unknown");
document.body.classList.toggle("platform-win32", rendererPlatform === "win32");
document.body.classList.toggle("platform-darwin", rendererPlatform === "darwin");
document.body.classList.toggle("platform-linux", rendererPlatform === "linux");

function clampSidebarWidth(value) {
  const availableMax = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, window.innerWidth - 430));
  const next = Number(value);
  if (!Number.isFinite(next)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.round(Math.max(SIDEBAR_WIDTH_MIN, Math.min(availableMax, next)));
}

function savedSidebarWidth() {
  try {
    return clampSidebarWidth(Number(localStorage.getItem("mia.sidebarWidth")) || SIDEBAR_WIDTH_DEFAULT);
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

const state = window.miaAppState.createInitialState({
  localStorage,
  sidebarWidth: savedSidebarWidth(),
  windowWidth: window.innerWidth
});
let desktopWindowFocused = true;
const agentSetupLaunch = new URLSearchParams(window.location.search || "").get("mode") === "agent-setup";
if (agentSetupLaunch && !state.onboardingStep && !state.setupGuideDismissed && !state.agentSetupSkipped) {
  state.onboardingStep = "login";
}
// The standalone onboarding window finished and promoted this window to the main
// app (?onboarding=complete). Mark onboarding done up front so the first-run
// initializeRuntime() check below doesn't bounce the user into the legacy setup
// guide right after they pressed "进入 Mia".
if (new URLSearchParams(window.location.search || "").get("onboarding") === "complete") {
  state.onboardingStep = "done";
  state.setupGuideDismissed = true;
  state.agentSetupSkipped = false;
  try {
    localStorage.setItem("mia.onboardingStep", "done");
    localStorage.setItem(SETUP_GUIDE_DISMISSED_KEY, "1");
    localStorage.removeItem(AGENT_SETUP_SKIPPED_KEY);
  } catch { /* ignore */ }
}
if (window.miaSetupGuide && window.miaSetupGuide.initSetupGuide) {
  window.miaSetupGuide.initSetupGuide({ state, escapeHtml: window.miaMarkdown.escapeHtml });
}
window.miaStartupOverlay?.init?.({ firstRun: agentSetupLaunch });

const els = {
  appShell: document.querySelector(".app-shell"),
  openSettings: document.getElementById("openSettings"),
  userAvatar: document.getElementById("userAvatar"),
  sidebarUserAvatar: document.getElementById("sidebarUserAvatar"),
  userDisplayName: document.getElementById("userDisplayName"),
  activeChatAvatar: document.getElementById("activeChatAvatar"),
  activeChatName: document.getElementById("activeChatName"),
  activeChatBadge: document.getElementById("activeChatBadge"),
  activeChatMeta: document.getElementById("activeChatMeta"),
  activeConversationMenuButton: document.getElementById("activeConversationMenuButton"),
  chatConversationMenu: document.getElementById("chatConversationMenu"),
  chatConversationList: document.getElementById("chatConversationList"),
  initialize: document.getElementById("initialize"),
  engineRowHermes: document.getElementById("engineRowHermes"),
  engineRowClaude: document.getElementById("engineRowClaude"),
  engineRowCodex: document.getElementById("engineRowCodex"),
  engineRowOpenClaw: document.getElementById("engineRowOpenClaw"),
  engineRowHermesButton: document.querySelector('[data-engine-row="hermes"]'),
  engineRowHermesActions: document.getElementById("engineRowHermesActions"),
  engineRowClaudeActions: document.getElementById("engineRowClaudeActions"),
  engineRowCodexActions: document.getElementById("engineRowCodexActions"),
  engineRowOpenClawActions: document.getElementById("engineRowOpenClawActions"),
  engineDetection: document.getElementById("engineDetection"),
  engineInstallActions: document.getElementById("engineInstallActions"),
  openPersonaSearch: document.getElementById("openPersonaSearch"),
  personaSearch: document.getElementById("personaSearch"),
  personaSearchClear: document.getElementById("personaSearchClear"),
  closePersonaSearch: document.getElementById("closePersonaSearch"),
  personaTagFilters: document.getElementById("personaTagFilters"),
  personaCount: document.getElementById("personaCount"),
  botCreateMenu: document.getElementById("botCreateMenu"),
  addBot: document.getElementById("addBot"),
  convMenuAddFriend: document.getElementById("convMenuAddFriend"),
  convMenuNewGroup: document.getElementById("convMenuNewGroup"),
  botDialog: document.getElementById("botDialog"),
  botForm: document.getElementById("botForm"),
  botDialogTitle: document.getElementById("botDialogTitle"),
  botKey: document.getElementById("botKey"),
  botName: document.getElementById("botName"),
  botRuntimeTargetField: document.getElementById("botRuntimeTargetField"),
  botRuntimeTarget: document.getElementById("botRuntimeTarget"),
  botAvatar: document.getElementById("botAvatar"),
  botAvatarFile: document.getElementById("botAvatarFile"),
  chooseBotAvatar: document.getElementById("chooseBotAvatar"),
  botAvatarDrop: document.getElementById("botAvatarDrop"),
  botAvatarPreview: document.getElementById("botAvatarPreview"),
  botAvatarDefaultTabs: document.getElementById("botAvatarDefaultTabs"),
  botAvatarDefaults: document.getElementById("botAvatarDefaults"),
  profileAvatarDefaultTabs: document.getElementById("profileAvatarDefaultTabs"),
  profileAvatarDefaults: document.getElementById("profileAvatarDefaults"),
  botPersonaDetails: document.getElementById("botPersonaDetails"),
  botSeed: document.getElementById("botSeed"),
  closeBotDialog: document.getElementById("closeBotDialog"),
  cancelBot: document.getElementById("cancelBot"),
  avatarCropDialog: document.getElementById("avatarCropDialog"),
  avatarCropStage: document.getElementById("avatarCropStage"),
  avatarTrimControls: document.getElementById("avatarTrimControls"),
  avatarTrimTimeline: document.getElementById("avatarTrimTimeline"),
  avatarTrimFrames: document.getElementById("avatarTrimFrames"),
  avatarTrimPreview: document.getElementById("avatarTrimPreview"),
  avatarTrimLabel: document.getElementById("avatarTrimLabel"),
  avatarTrimStart: document.getElementById("avatarTrimStart"),
  avatarTrimDuration: document.getElementById("avatarTrimDuration"),
  confirmAvatarCrop: document.getElementById("confirmAvatarCrop"),
  cancelAvatarCrop: document.getElementById("cancelAvatarCrop"),
  resetAvatarCrop: document.getElementById("resetAvatarCrop"),
  conversationSidebar: document.getElementById("conversationSidebar"),
  contactsSidebar: document.getElementById("contactsSidebar"),
  exploreSidebar: document.getElementById("exploreSidebar"),
  taskSidebar: document.getElementById("taskSidebar"),
  settingsSidebar: document.getElementById("settingsSidebar"),
  sidebarResizeHandle: document.getElementById("sidebarResizeHandle"),
  sidebarCollapseToggle: document.getElementById("sidebarCollapseToggle"),
  sidebarRailToggle: document.getElementById("sidebarRailToggle"),
  narrowBackButtons: document.querySelectorAll("[data-narrow-back]"),
  chatView: document.getElementById("chatView"),
  contactsView: document.getElementById("contactsView"),
  skillsView: document.getElementById("skillsView"),
  botStoreView: document.getElementById("botStoreView"),
  botStoreCap: document.getElementById("botStoreCap"),
  botStoreGrid: document.getElementById("botStoreGrid"),
  botStoreScrim: document.getElementById("botStoreScrim"),
  botStoreSheet: document.getElementById("botStoreSheet"),
  settingsView: document.getElementById("settingsView"),
  settingsMemoryEnabled: document.getElementById("settingsMemoryEnabled"),
  settingsMemoryList: document.getElementById("settingsMemoryList"),
  settingsMemoryDraftText: document.getElementById("settingsMemoryDraftText"),
  settingsMemoryEditorTitle: document.getElementById("settingsMemoryEditorTitle"),
  settingsMemoryEditorMeta: document.getElementById("settingsMemoryEditorMeta"),
  settingsMemorySave: document.getElementById("settingsMemorySave"),
  settingsMemoryCancelEdit: document.getElementById("settingsMemoryCancelEdit"),
  engineStatus: document.getElementById("engineStatus"),
  hermesHome: document.getElementById("hermesHome"),
  manifestPath: document.getElementById("manifestPath"),
  engineLogs: document.getElementById("engineLogs"),
  personaList: document.getElementById("personaList"),
  contactSearch: document.getElementById("contactSearch"),
  newContact: document.getElementById("newContact"),
  contactCreateMenu: document.getElementById("contactCreateMenu"),
  contactMenuAddFriend: document.getElementById("contactMenuAddFriend"),
  contactMenuAddBot: document.getElementById("contactMenuAddBot"),
  contactMenuNewGroup: document.getElementById("contactMenuNewGroup"),
  discoverModeToggle: document.getElementById("discoverModeToggle"),
  contactMenuDiscoverBots: document.getElementById("contactMenuDiscoverBots"),
  convMenuDiscoverBots: document.getElementById("convMenuDiscoverBots"),
  contactList: document.getElementById("contactList"),
  contactPageTitle: document.getElementById("contactPageTitle"),
  contactPageMeta: document.getElementById("contactPageMeta"),
  contactDetail: document.getElementById("contactDetail"),
  engineWarning: document.getElementById("engineWarning"),
  chat: document.getElementById("chat"),
  skillSearch: document.getElementById("skillSearch"),
  skillPageTitle: document.getElementById("skillPageTitle"),
  skillModeToggle: document.getElementById("skillModeToggle"),
  skillChipRow: document.getElementById("skillChipRow"),
  skillCardGrid: document.getElementById("skillCardGrid"),
  skillContextMenu: document.getElementById("skillContextMenu"),
  botContextMenu: document.getElementById("botContextMenu"),
  messageContextMenu: document.getElementById("messageContextMenu"),
  profileDialog: document.getElementById("profileDialog"),
  profileForm: document.getElementById("profileForm"),
  profileNameText: document.getElementById("profileNameText"),
  profileDisplayName: document.getElementById("profileDisplayName"),
  profileStatusBadge: document.getElementById("profileStatusBadge"),
  profileStatusBadgeDetails: document.getElementById("profileStatusBadgeDetails"),
  profileStatusBadgeTrigger: document.getElementById("profileStatusBadgeTrigger"),
  profileUidValue: document.getElementById("profileUidValue"),
  profileAvatarImage: document.getElementById("profileAvatarImage"),
  profileAvatarFile: document.getElementById("profileAvatarFile"),
  chooseProfileAvatar: document.getElementById("chooseProfileAvatar"),
  profileAvatarDrop: document.getElementById("profileAvatarDrop"),
  profileAvatarPreview: document.getElementById("profileAvatarPreview"),
  closeProfileDialog: document.getElementById("closeProfileDialog"),
  botNameText: document.getElementById("botNameText"),
  botStatusBadge: document.getElementById("botStatusBadge"),
  botStatusBadgeDetails: document.getElementById("botStatusBadgeDetails"),
  botStatusBadgeTrigger: document.getElementById("botStatusBadgeTrigger"),
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
  composerSkills: document.getElementById("composerSkills"),
  composerAttachmentInput: document.getElementById("composerAttachmentInput"),
  slashCommandMenu: document.getElementById("slashCommandMenu"),
  mentionMenu: document.getElementById("mentionMenu"),
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
  navLayoutChoices: document.querySelectorAll("[data-nav-layout-choice]"),
  workspacePath: document.getElementById("workspacePath"),
  workspacePickButton: document.getElementById("workspacePickButton"),
  appearanceAccentColor: document.getElementById("appearanceAccentColor"),
  appearanceAccentPreview: document.getElementById("appearanceAccentPreview"),
  appearanceAccentReset: document.getElementById("appearanceAccentReset"),
  appearanceUserBubbleColor: document.getElementById("appearanceUserBubbleColor"),
  appearanceUserBubblePreview: document.getElementById("appearanceUserBubblePreview"),
  appearanceUserBubbleReset: document.getElementById("appearanceUserBubbleReset"),
  appearanceWorkspaceBackgroundColor: document.getElementById("appearanceWorkspaceBackgroundColor"),
  appearanceWorkspaceBackgroundImage: document.getElementById("appearanceWorkspaceBackgroundImage"),
  appearanceWorkspaceBackgroundPreview: document.getElementById("appearanceWorkspaceBackgroundPreview"),
  appearanceWorkspaceBackgroundPresets: document.getElementById("appearanceWorkspaceBackgroundPresets"),
  appearanceWorkspaceBackgroundReset: document.getElementById("appearanceWorkspaceBackgroundReset"),
  appearanceShowDesktopNotifications: document.getElementById("appearanceShowDesktopNotifications"),
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
  cloudAccountHint: document.getElementById("cloudAccountHint"),
  cloudAccountProfile: document.getElementById("cloudAccountProfile"),
  cloudAccountAvatar: document.getElementById("cloudAccountAvatar"),
  cloudAccountName: document.getElementById("cloudAccountName"),
  cloudAccountUid: document.getElementById("cloudAccountUid"),
  cloudModelBalanceRow: document.getElementById("cloudModelBalanceRow"),
  cloudModelBalanceAmount: document.getElementById("cloudModelBalanceAmount"),
  cloudModelBalanceMeta: document.getElementById("cloudModelBalanceMeta"),
  cloudLogout: document.getElementById("cloudLogout"),
  checkUpdates: document.getElementById("checkUpdates"),
  daemonRestart: document.getElementById("daemonRestart"),
  daemonHint: document.getElementById("daemonHint"),
  appUpdateHint: document.getElementById("appUpdateHint"),
  appUpdateOverlay: document.getElementById("appUpdateOverlay"),
  appUpdateOverlayTitle: document.getElementById("appUpdateOverlayTitle"),
  appUpdateOverlayDetail: document.getElementById("appUpdateOverlayDetail"),
  appUpdateReleaseNotes: document.getElementById("appUpdateReleaseNotes"),
  appUpdateProgressBar: document.getElementById("appUpdateProgressBar"),
  appUpdateProgressFill: document.getElementById("appUpdateProgressFill"),
  appUpdateProgressText: document.getElementById("appUpdateProgressText"),
  tasksUnreadBadge: document.getElementById("tasksUnreadBadge"),
  contactsUnreadBadge: document.getElementById("contactsUnreadBadge"),
  sidebarChatUnreadBadge: document.getElementById("sidebarChatUnreadBadge"),
  sidebarExploreUnreadBadge: document.getElementById("sidebarExploreUnreadBadge"),
  sidebarTasksUnreadBadge: document.getElementById("sidebarTasksUnreadBadge"),
  chatUnreadBadge: document.getElementById("chatUnreadBadge"),
  tasksView: document.getElementById("tasksView"),
  tasksContent: document.getElementById("tasksContent")
};

const ANIMATED_TEXT_IDS = new Set([
  "activeChatMeta",
  "currentSessionTitle",
  "modelSwitchStatus"
]);

function animatedTextOptions(el) {
  const id = el?.id || "";
  if (id === "currentSessionTitle") return { direction: "up", stagger: 18, duration: 240 };
  if (id === "modelSwitchStatus") return { direction: "up", stagger: 16, duration: 220 };
  return { direction: "up", stagger: 14, duration: 220 };
}

function setAnimatedText(el, value, options = {}) {
  if (!el) return;
  const text = String(value ?? "");
  const nextOptions = { ...animatedTextOptions(el), ...options };
  if (window.miaSlotText?.set) {
    const currentHtml = String(el.innerHTML ?? "");
    const currentText = String(el.textContent ?? "");
    const staleRichText = el.dataset?.slotTextValue === text
      && currentText !== text
      && !currentHtml.includes("char-slot");
    if (staleRichText) {
      window.miaSlotText.destroy?.(el);
      if (el.dataset) delete el.dataset.slotTextValue;
    }
    window.miaSlotText.set(el, text, nextOptions);
  } else {
    el.textContent = text;
    if (el.dataset) el.dataset.slotTextValue = text;
  }
}

function flashAnimatedText(el, value, options = {}) {
  if (!el) return;
  const text = String(value ?? "");
  const restingText = String(options.restingText ?? el.dataset?.slotTextValue ?? el.textContent ?? "");
  if (window.miaSlotText?.flash) {
    window.miaSlotText.flash(el, text, {
      revertAfter: 900,
      restingText,
      ...options
    });
  } else {
    el.textContent = text;
    clearTimeout(el._slotTextFlashTimer);
    el._slotTextFlashTimer = setTimeout(() => {
      el.textContent = restingText;
    }, Number(options.revertAfter) || 900);
  }
}

function setText(el, value) {
  if (!el) return;
  if (ANIMATED_TEXT_IDS.has(el.id || "") || el.dataset?.slotText === "true") {
    setAnimatedText(el, value);
    return;
  }
  el.textContent = value;
}

function isMiaModelIcon(icon = "") {
  return /(?:^|\/)mia-logo\.png(?:[?#].*)?$/.test(String(icon || ""));
}

function applyComposerModelAvatar(modelAvatar, icon = "") {
  if (!modelAvatar) return;
  modelAvatar.textContent = icon ? "" : "◇";
  modelAvatar.style.backgroundImage = icon ? `url("${icon}")` : "";
  modelAvatar.classList.toggle("model-avatar--transparent", isMiaModelIcon(icon));
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function updateVersionSuffix(version) {
  const text = String(version || "").trim();
  return text ? ` ${text}` : "";
}

function appUpdateStatusText(result = {}) {
  const version = updateVersionSuffix(result.version);
  if (result.status === "available") return `正在更新${version}`;
  if (result.status === "downloading") return `正在下载${version}`;
  if (result.status === "downloaded") return `正在安装${version}`;
  if (result.status === "installing") return `正在重启${version}`;
  if (result.status === "not-available") return "当前已经是最新版本。";
  if (result.status === "disabled") return "检查更新只在安装版桌面 App 中可用。";
  if (result.status === "error") return `检查失败：${result.error?.message || "请稍后再试"}`;
  return "已发起更新检查。";
}

function appUpdatePercent(payload = {}) {
  const status = payload.status || payload.type || "";
  if (status === "downloaded" || status === "installing") return 100;
  const value = Number(payload.progress?.percent);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function appUpdateReleaseNoteLines(payload = {}) {
  const raw = payload.releaseNotes;
  const source = Array.isArray(raw) ? raw : String(raw || "").split(/\r?\n/);
  const seen = new Set();
  const notes = [];
  for (const value of source) {
    let line = String(value || "").trim();
    if (!line || /^```/.test(line) || /^#{1,6}\s+Mia\b/i.test(line)) continue;
    line = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    notes.push(line.length > 180 ? `${line.slice(0, 177)}...` : line);
    if (notes.length >= 5) break;
  }
  return notes;
}

function renderAppUpdateReleaseNotes(payload = {}) {
  const list = els.appUpdateReleaseNotes;
  if (!list) return;
  list.textContent = "";
  const notes = appUpdateReleaseNoteLines(payload);
  list.hidden = notes.length === 0;
  for (const note of notes) {
    const item = document.createElement("li");
    item.textContent = note;
    list.appendChild(item);
  }
}

function appUpdateOverlayCopy(payload = {}) {
  const status = payload.status || payload.type || "";
  const version = updateVersionSuffix(payload.version);
  if (status === "available") {
    return {
      title: "正在更新",
      detail: `Mia${version || ""}`
    };
  }
  if (status === "downloaded") {
    return {
      title: "正在安装",
      detail: "即将重启"
    };
  }
  if (status === "installing") {
    return {
      title: "正在重启",
      detail: "马上完成"
    };
  }
  return {
    title: "正在下载",
    detail: `Mia${version || ""}`
  };
}

function renderAppUpdateOverlay(payload = {}, visible = true) {
  els.appUpdateOverlay?.classList.toggle("hidden", !visible);
  if (!visible) return;
  const copy = appUpdateOverlayCopy(payload);
  const percent = appUpdatePercent(payload);
  setText(els.appUpdateOverlayTitle, copy.title);
  setText(els.appUpdateOverlayDetail, copy.detail);
  renderAppUpdateReleaseNotes(payload);
  if (els.appUpdateProgressFill) els.appUpdateProgressFill.style.width = `${percent}%`;
  if (els.appUpdateProgressBar) els.appUpdateProgressBar.setAttribute("aria-valuenow", String(Math.round(percent)));
  setText(els.appUpdateProgressText, `${Math.round(percent)}%`);
}

function handleAppUpdateEvent(payload = {}) {
  const status = payload.status || payload.type || "";
  if (status === "error") {
    renderAppUpdateOverlay(payload, false);
    setText(els.appUpdateHint, appUpdateStatusText(payload));
    return;
  }
  if (status === "not-available" || status === "disabled") {
    renderAppUpdateOverlay(payload, false);
    setText(els.appUpdateHint, appUpdateStatusText(payload));
    return;
  }
  if (status === "checking") {
    setText(els.appUpdateHint, "正在检查更新...");
    return;
  }
  if (["available", "downloading", "downloaded", "installing"].includes(status)) {
    setText(els.appUpdateHint, appUpdateStatusText(payload));
    renderAppUpdateOverlay(payload, true);
  }
}

function updateStatusBadgeAssetBaseUrl(runtime = state.runtime) {
  const cloud = runtime?.cloud || {};
  const baseUrl = cloud.enabled ? String(cloud.url || "").trim() : "";
  window.miaNameWithBadge?.setStatusBadgeAssetBaseUrl?.(baseUrl);
}

function hasOwn(obj, key) {
  return Boolean(obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key));
}

function statusBadgeFrom(...sources) {
  for (const source of sources) {
    if (hasOwn(source, "statusBadge")) return source.statusBadge;
    if (hasOwn(source, "status_badge")) return source.status_badge;
  }
  return undefined;
}

function statusBadgeForPreset(value) {
  return window.miaStatusBadgeAssets?.statusBadgeForValue?.(value) || null;
}

function statusBadgePresetValue(badge) {
  return window.miaStatusBadgeAssets?.statusBadgeValue?.(badge) || "";
}

function identityNameEls(kind) {
  return kind === "bot"
    ? { input: els.botName, text: els.botNameText, fallback: "未命名伙伴" }
    : { input: els.profileDisplayName, text: els.profileNameText, fallback: "Mia" };
}

function identityBadgeEls(kind) {
  return kind === "bot"
    ? { select: els.botStatusBadge, trigger: els.botStatusBadgeTrigger, details: els.botStatusBadgeDetails }
    : { select: els.profileStatusBadge, trigger: els.profileStatusBadgeTrigger, details: els.profileStatusBadgeDetails };
}

function syncIdentityNameText(kind) {
  const { input, text, fallback } = identityNameEls(kind);
  if (!input || !text) return;
  text.textContent = input.value.trim() || fallback;
}

function beginIdentityNameEdit(kind) {
  const { input, text } = identityNameEls(kind);
  if (!input || !text) return;
  syncIdentityNameText(kind);
  text.classList.add("hidden");
  input.classList.remove("hidden");
  input.focus();
  input.select?.();
}

function shouldKeepIdentityNameInputVisible(kind) {
  return kind === "bot"
    && state.botDialogMode === "create";
}

function endIdentityNameEdit(kind) {
  const { input, text } = identityNameEls(kind);
  if (!input || !text) return;
  if (shouldKeepIdentityNameInputVisible(kind)) {
    text.classList.add("hidden");
    input.classList.remove("hidden");
    return;
  }
  input.classList.add("hidden");
  text.classList.remove("hidden");
  syncIdentityNameText(kind);
}

function refreshStatusBadgeLotties(root) {
  if (!root) return;
  const run = () => {
    try { window.miaLottieIcons?.init?.(root); } catch { /* badge animation is optional */ }
  };
  run();
  const defer = window.requestAnimationFrame || window.setTimeout;
  if (typeof defer === "function") defer(run, 0);
}

function statusBadgeGlyphKey(badge) {
  if (!badge) return "empty";
  if (badge.kind === "emoji") return `emoji:${badge.emoji || ""}`;
  if (badge.kind === "lottie") {
    const assetId = String(badge.assetId || "").trim();
    const format = window.miaNameWithBadge?.statusBadgeAssetFormat?.(assetId) || "json";
    const path = window.miaNameWithBadge?.statusBadgeAssetUrl?.(assetId) || "";
    return `lottie:${assetId}:${format}:${path}`;
  }
  return `${badge.kind || ""}:${JSON.stringify(badge)}`;
}

function renderStatusBadgeGlyph(target, badge) {
  if (!target) return;
  const key = statusBadgeGlyphKey(badge);
  if (target.dataset.statusBadgeGlyphKey === key) return;
  target.dataset.statusBadgeGlyphKey = key;
  target.innerHTML = "";
  target.classList.toggle("empty", !badge);
  if (!badge) {
    renderEmptyStatusBadgeGlyph(target);
    return;
  }
  if (badge.kind === "emoji") {
    target.textContent = badge.emoji || "";
    return;
  }
  if (badge.kind === "lottie") {
    const assetId = String(badge.assetId || "").trim();
    if (!/^[A-Za-z0-9_-]+$/.test(assetId)) {
      target.classList.add("empty");
      renderEmptyStatusBadgeGlyph(target);
      return;
    }
    const span = document.createElement("span");
    span.className = "name-with-badge-badge name-with-badge-badge-lottie";
    span.dataset.assetId = assetId;
    span.dataset.lottie = assetId;
    span.dataset.lottieTrigger = "loop";
    const format = window.miaNameWithBadge?.statusBadgeAssetFormat?.(assetId);
    if (format === "tgs") {
      span.dataset.lottieFormat = "tgs";
      span.dataset.lottieLocal = "status-badge";
    }
    const remotePath = window.miaNameWithBadge?.statusBadgeAssetUrl?.(assetId);
    if (remotePath) span.dataset.lottiePath = remotePath;
    span.setAttribute("aria-hidden", "true");
    target.appendChild(span);
    window.miaNameWithBadge?.initLottieBadges?.(target);
  }
}

function renderEmptyStatusBadgeGlyph(target) {
  if (!target) return;
  target.innerHTML = `
    <span class="identity-badge-empty-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <circle class="identity-badge-empty-ring" cx="12" cy="12" r="8.25"></circle>
        <circle class="identity-badge-empty-eye" cx="9.4" cy="10.5" r=".78"></circle>
        <circle class="identity-badge-empty-eye" cx="14.6" cy="10.5" r=".78"></circle>
        <path class="identity-badge-empty-smile" d="M8.9 14.3c1.4 1.5 4.8 1.5 6.2 0"></path>
      </svg>
    </span>`;
}

function statusBadgeChoices() {
  return window.miaStatusBadgeAssets?.statusBadgeChoices?.({ includeEmpty: true }) || [
    { value: "", label: "无", badge: null }
  ];
}

function statusBadgeChoiceCatalogKey() {
  return statusBadgeChoices()
    .map((choice) => `${choice.value}:${choice.kind || ""}:${choice.label || ""}:${choice.assetId || ""}:${choice.emoji || ""}`)
    .join("|");
}

function renderStatusBadgeChoicePreview(target, choice) {
  if (!target) return;
  if (!choice?.badge) {
    target.innerHTML = `<span class="identity-badge-choice-empty">无</span>`;
    return;
  }
  if (choice.badge.kind === "emoji") {
    const emoji = document.createElement("span");
    emoji.className = "identity-badge-choice-emoji";
    emoji.textContent = choice.badge.emoji || "";
    target.replaceChildren(emoji);
    return;
  }
  const preview = document.createElement("span");
  preview.className = "identity-badge-choice-preview";
  target.replaceChildren(preview);
  renderStatusBadgeGlyph(preview, choice.badge);
}

function renderStatusBadgeChoiceLists(kind) {
  const { select, details } = identityBadgeEls(kind);
  const panel = details?.querySelector?.(".identity-badge-choices");
  const key = statusBadgeChoiceCatalogKey();
  if (select && select.dataset.statusBadgeCatalogKey !== key) {
    const value = select.value || "";
    select.replaceChildren(...statusBadgeChoices().map((choice) => {
      const option = document.createElement("option");
      option.value = choice.value || "";
      option.textContent = choice.label || "无";
      return option;
    }));
    select.value = statusBadgeChoices().some((choice) => choice.value === value) ? value : "";
    select.dataset.statusBadgeCatalogKey = key;
  }
  if (!panel || panel.dataset.statusBadgeCatalogKey === `${kind}:${key}`) return;
  panel.replaceChildren(...statusBadgeChoices().map((choice) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.statusBadgeChoice = choice.value || "";
    button.dataset.statusBadgeTarget = kind;
    button.setAttribute("aria-label", choice.value ? `${choice.label || choice.value}徽章` : "无徽章");
    renderStatusBadgeChoicePreview(button, choice);
    return button;
  }));
  panel.dataset.statusBadgeCatalogKey = `${kind}:${key}`;
  refreshStatusBadgeLotties(panel);
}

function syncStatusBadgeControl(kind) {
  const { select, trigger, details } = identityBadgeEls(kind);
  if (!select || !trigger) return;
  renderStatusBadgeChoiceLists(kind);
  const badge = statusBadgeForPreset(select.value);
  renderStatusBadgeGlyph(trigger, badge);
  document.querySelectorAll(`[data-status-badge-target="${kind}"]`).forEach((button) => {
    button.classList.toggle("active", button.dataset.statusBadgeChoice === select.value);
  });
  refreshStatusBadgeLotties(details || trigger);
}

function bindStatusBadgeDetailsDismissal(details) {
  if (!details || details.dataset.statusBadgeDismissBound === "1") return;
  details.dataset.statusBadgeDismissBound = "1";
  let hideTimer = 0;
  const cancelHide = () => {
    if (!hideTimer) return;
    window.clearTimeout(hideTimer);
    hideTimer = 0;
  };
  const scheduleHide = () => {
    cancelHide();
    hideTimer = window.setTimeout(() => {
      details.open = false;
      hideTimer = 0;
    }, 90);
  };
  details.addEventListener("mouseenter", cancelHide);
  details.addEventListener("mouseleave", scheduleHide);
  details.addEventListener("toggle", () => {
    if (!details.open) {
      cancelHide();
      return;
    }
    document.querySelectorAll(".identity-badge-details[open]").forEach((node) => {
      if (node !== details) node.open = false;
    });
    refreshStatusBadgeLotties(details);
  });
}

document.querySelectorAll(".identity-badge-details").forEach(bindStatusBadgeDetailsDismissal);
renderStatusBadgeChoiceLists("profile");
renderStatusBadgeChoiceLists("bot");

function openProfileDialogFromRenderer() {
  clearProfilePopoverDismiss();
  if (state.profileDialogOpen) {
    window.miaBotDialog.closeProfileDialog();
    return;
  }
  window.miaBotDialog.openProfileDialog();
  const user = runtimeUserIdentity();
  if (els.profileStatusBadge) els.profileStatusBadge.value = statusBadgePresetValue(user.statusBadge);
  syncIdentityNameText("profile");
  syncStatusBadgeControl("profile");
  profileSaveRequested = false;
  profileLastSaveSignature = JSON.stringify(profileDraftPayload());
}

function clearProfilePopoverDismiss() {
  if (!profilePopoverHideTimer) return;
  window.clearTimeout(profilePopoverHideTimer);
  profilePopoverHideTimer = 0;
}

function profilePopoverHasEditingFocus() {
  const active = document.activeElement;
  if (!active || !els.profileForm?.contains(active)) return false;
  return ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName);
}

function scheduleProfilePopoverDismiss() {
  clearProfilePopoverDismiss();
  profilePopoverHideTimer = window.setTimeout(() => {
    profilePopoverHideTimer = 0;
    if (!state.profileDialogOpen || state.avatarCropEditor?.open || profilePopoverHasEditingFocus()) return;
    if (els.profileDialog?.matches?.(":hover") || els.userAvatar?.matches?.(":hover")) return;
    window.miaBotDialog.closeProfileDialog();
  }, 160);
}

function closeProfilePopoverFromOutside(event) {
  if (!state.profileDialogOpen || state.avatarCropEditor?.open) return;
  const target = event.target;
  if (els.profileDialog?.contains(target) || els.userAvatar?.contains(target) || els.avatarCropDialog?.contains(target)) return;
  clearProfilePopoverDismiss();
  window.miaBotDialog.closeProfileDialog();
}

function profileDraftPayload() {
  const displayName = (els.profileDisplayName?.value || "").trim();
  return {
    displayName,
    avatarText: displayName ? window.miaAvatar.initials(displayName) : "",
    avatarImage: state.profileAvatarDraft?.image || els.profileAvatarImage?.value || "",
    avatarCrop: window.miaAvatar.normalizeCrop(state.profileAvatarDraft?.crop),
    avatarColor: state.profileAvatarDraft?.color || "",
    statusBadge: statusBadgeForPreset(els.profileStatusBadge?.value || "")
  };
}

async function saveProfileDraft() {
  if (profileSaveDebounceTimer) {
    window.clearTimeout(profileSaveDebounceTimer);
    profileSaveDebounceTimer = 0;
  }
  profileSaveRequested = true;
  if (profileSaveInFlight) return;
  profileSaveInFlight = true;
  try {
    while (profileSaveRequested) {
      profileSaveRequested = false;
      const payload = profileDraftPayload();
      const signature = JSON.stringify(payload);
      if (signature === profileLastSaveSignature) continue;
      profileLastSaveSignature = signature;
      try {
        state.runtime = await window.mia.saveProfile(payload);
        render();
      } catch (error) {
        profileLastSaveSignature = "";
        console.error("[profile] save failed:", error);
      }
    }
  } finally {
    profileSaveInFlight = false;
  }
}

function scheduleProfileDraftSave(delay = 520) {
  if (profileSaveDebounceTimer) window.clearTimeout(profileSaveDebounceTimer);
  profileSaveDebounceTimer = window.setTimeout(() => {
    profileSaveDebounceTimer = 0;
    saveProfileDraft();
  }, delay);
}

window.miaProfileControls = {
  saveDraft: saveProfileDraft
};

window.miaStatusBadgeControls = {
  statusBadgeForPreset,
  statusBadgePresetValue,
  syncIdentityNameText,
  syncStatusBadgeControl,
  beginIdentityNameEdit,
  endIdentityNameEdit
};

function nameBadgeIdentity(kind, record, displayName, fallbackId = "") {
  const source = record && typeof record === "object" ? record : {};
  const identity = source.identity && typeof source.identity === "object" ? source.identity : source;
  const id = firstNonEmpty(
    identity.id,
    identity.botId,
    identity.bot_id,
    source.id,
    source.botId,
    source.bot_id,
    source.key,
    source.account,
    fallbackId
  );
  if (!id) return null;
  const out = {
    kind,
    id,
    displayName: firstNonEmpty(identity.displayName, identity.display_name, identity.name, displayName)
  };
  const ownerUserId = firstNonEmpty(identity.ownerUserId, identity.owner_user_id, source.ownerUserId, source.owner_user_id);
  if (ownerUserId) out.ownerUserId = ownerUserId;
  const badge = statusBadgeFrom(identity, source);
  if (typeof badge !== "undefined") out.statusBadge = badge;
  return out;
}

function setNameWithBadge(el, { identity, fallbackName, statusBadge } = {}) {
  if (!el) return;
  const fallback = firstNonEmpty(fallbackName, identity?.displayName, identity?.display_name, identity?.name);
  const renderName = window.miaNameWithBadge?.setNameWithBadge || window.miaNameWithBadge?.renderNameWithBadge;
  if (typeof renderName !== "function") {
    setText(el, fallback);
    return;
  }
  try {
    if (renderName === window.miaNameWithBadge?.setNameWithBadge) {
      renderName(el, { identity, fallbackName: fallback, statusBadge });
    } else {
      const node = renderName({ identity, fallbackName: fallback, statusBadge });
      el.replaceChildren(node);
    }
  } catch {
    setText(el, fallback);
  }
}

function runtimeUserIdentity(runtime = state.runtime) {
  const cloudUser = runtime?.cloud?.enabled && runtime?.cloud?.user ? runtime.cloud.user : null;
  const localUser = runtime?.user || {};
  const self = window.miaSelfIdentity.resolveSelfIdentity({ cloudUser, localUser });
  const avatarText = self.displayName ? window.miaAvatar?.initials?.(self.displayName) : "";
  return {
    id: self.id,
    username: self.username,
    account: self.account,
    displayName: self.displayName,
    avatarText,
    avatarColor: self.avatarColor,
    avatarImage: self.avatarImage,
    avatarCrop: self.avatarCrop,
    statusBadge: statusBadgeFrom(self, cloudUser, localUser) || null
  };
}


function applySidebarWidth(width = state.sidebarWidth, persist = false) {
  const next = clampSidebarWidth(width);
  state.sidebarWidth = next;
  document.documentElement.style.setProperty("--sidebar-width", `${next}px`);
  if (persist) {
    try {
      localStorage.setItem("mia.sidebarWidth", String(next));
    } catch {
      // localStorage may be unavailable in restricted renderer contexts.
    }
  }
}

function syncNarrowLayout() {
  const pane = state.narrowPane === "sidebar" ? "index" : "content";
  document.body.classList.toggle("narrow-sidebar", pane === "index");
  document.body.classList.toggle("narrow-content", pane === "content");
  if (els.appShell) {
    els.appShell.setAttribute("data-narrow-pane", pane);
  }
}

function triggerResponsiveShellTransition(direction) {
  if (!direction || !els.appShell || !viewHasIndexPane(state.activeView)) return;
  els.appShell.setAttribute("data-responsive-transition", direction);
  if (shellLayoutTransitionTimer) window.clearTimeout(shellLayoutTransitionTimer);
  shellLayoutTransitionTimer = window.setTimeout(() => {
    if (els.appShell?.getAttribute("data-responsive-transition") === direction) {
      els.appShell.removeAttribute("data-responsive-transition");
    }
    shellLayoutTransitionTimer = 0;
  }, 240);
}

function sidebarCollapseSupported(view = state.activeView) {
  return state.navLayout !== "sidebar-bottom" && !state.isNarrowWindow && view === "chat";
}

function syncSidebarCollapseState() {
  const supported = sidebarCollapseSupported(state.activeView);
  const collapsed = supported && state.sidebarCollapsed;
  if (els.appShell) {
    els.appShell.setAttribute("data-sidebar-state", collapsed ? "collapsed" : "expanded");
    els.appShell.setAttribute("data-sidebar-toggle", supported ? "available" : "hidden");
  }
  if (els.sidebarCollapseToggle) {
    els.sidebarCollapseToggle.hidden = !supported || collapsed;
    els.sidebarCollapseToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
  if (els.sidebarRailToggle) {
    els.sidebarRailToggle.hidden = !supported || !collapsed;
    els.sidebarRailToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    els.sidebarRailToggle.title = "展开中栏";
    els.sidebarRailToggle.setAttribute("aria-label", "展开中栏");
  }
  window.miaScrollbarOverlay?.validateScrollbarOverlay?.();
}

function setConversationSidebarActionHover(active) {
  els.conversationSidebar?.classList.toggle("sidebar-action-hover", Boolean(active));
}

function pointerIsInsideConversationSidebar(event) {
  const sidebar = els.conversationSidebar;
  if (!sidebar || sidebar.classList.contains("hidden")) return false;
  const x = Number(event?.clientX);
  const y = Number(event?.clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const rect = sidebar.getBoundingClientRect();
  const tolerance = 2;
  return x >= rect.left - tolerance && x <= rect.right + tolerance && y >= rect.top - tolerance && y <= rect.bottom + tolerance;
}

function updateConversationSidebarActionHoverFromPointer(event) {
  if (!sidebarCollapseSupported(state.activeView)) {
    setConversationSidebarActionHover(false);
    return;
  }
  setConversationSidebarActionHover(pointerIsInsideConversationSidebar(event));
}

function setSidebarCollapsed(collapsed, persist = false) {
  state.sidebarCollapsed = Boolean(collapsed);
  if (persist) {
    try {
      localStorage.setItem("mia.sidebarCollapsed.v1", state.sidebarCollapsed ? "1" : "0");
    } catch {
      // localStorage may be unavailable in restricted renderer contexts.
    }
  }
  syncSidebarCollapseState();
}

function setNavLayout(layout, persist = false) {
  state.navLayout = layout === "sidebar-bottom" ? "sidebar-bottom" : "rail";
  if (state.navLayout === "sidebar-bottom" && state.sidebarWidth < SIDEBAR_WIDTH_DEFAULT) {
    applySidebarWidth(SIDEBAR_WIDTH_DEFAULT, persist);
  }
  if (persist) {
    try {
      localStorage.setItem("mia.navLayout.v1", state.navLayout);
    } catch {
      // localStorage may be unavailable in restricted renderer contexts.
    }
  }
  syncNavLayoutState();
}

function primaryNavForView(view = state.activeView) {
  if (view === "chat") return "chat";
  if (view === "tasks") return "tasks";
  if (view === "settings") return "me";
  if (view === "contacts" || view === "bot-store" || view === "skills") return "explore";
  return "chat";
}

function syncNavLayoutState() {
  const layout = state.navLayout === "sidebar-bottom" ? "sidebar-bottom" : "rail";
  const nativeControlsLayout = layout === "sidebar-bottom" ? "default" : "rail";
  els.appShell?.setAttribute("data-nav-layout", layout);
  els.navLayoutChoices?.forEach((button) => {
    const active = button.dataset.navLayoutChoice === layout;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
  });
  if (lastNativeControlsLayout !== nativeControlsLayout) {
    lastNativeControlsLayout = nativeControlsLayout;
    try {
      window.mia?.window?.setNativeControlsLayout?.(nativeControlsLayout)?.catch?.(() => {});
    } catch {
      // Native traffic light positioning is macOS-only and optional in web mocks.
    }
  }
  document.querySelectorAll("[data-primary-nav]").forEach((button) => {
    button.classList.toggle("active", button.dataset.primaryNav === primaryNavForView(state.activeView));
  });
}

function syncExploreSidebarState() {
  document.querySelectorAll("[data-explore-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.exploreView === state.activeView);
  });
}

function syncTaskSidebarState() {
  const mode = state.taskMode === "history" ? "history" : "active";
  document.querySelectorAll("[data-task-sidebar-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.taskSidebarMode === mode);
  });
}

function showPrimaryNav(primary) {
  if (primary === "chat") {
    state.activeView = "chat";
  } else if (primary === "explore") {
    state.activeView = state.exploreSectionView || "bot-store";
    state.discoverSectionView = state.activeView;
  } else if (primary === "tasks") {
    state.activeView = "tasks";
  } else if (primary === "me") {
    openSettingsView();
    return;
  }
  if (state.activeView === "bot-store" && !(state.skillLibrary.botPresets || []).length && !state.skillsLoading) window.miaLoaders.loadSkills();
  if (state.activeView === "skills" && !state.skillLibrary.skills.length && !state.skillsLoading) window.miaLoaders.loadSkills();
  if (state.activeView === "bot-store") window.miaBotStore?.renderBotStore?.();
  if (state.activeView === "tasks") {
    window.miaTasksPanel?.loadTasksFromDaemon().then(() => {
      window.miaTasksPanel?.renderTaskView();
    });
  }
  if (state.isNarrowWindow && viewHasIndexPane(state.activeView)) showNarrowSidebar();
  else showNarrowContent();
  renderView();
}

function showNarrowContent() {
  state.narrowPane = "content";
  syncNarrowLayout();
  syncSidebarCollapseState();
}

function showNarrowSidebar() {
  state.narrowPane = "sidebar";
  syncNarrowLayout();
  syncSidebarCollapseState();
}

function viewHasIndexPane(view = state.activeView) {
  return view === "chat" || view === "contacts" || view === "settings";
}

function activeViewHasDetail(view = state.activeView) {
  if (view === "chat") {
    return Boolean(window.miaSocial?.getActiveConversationId?.() || state.activeKey);
  }
  if (view === "contacts") {
    return Boolean(state.activeContactKey);
  }
  return true;
}

function normalizeNarrowPaneForView(view = state.activeView) {
  if (!viewHasIndexPane(view)) {
    state.narrowPane = "content";
    return;
  }
  if (state.narrowPane === "sidebar") return;
  state.narrowPane = activeViewHasDetail(view) ? "content" : "sidebar";
}

function shellLayoutForView(view) {
  if (state.isNarrowWindow) return "single";
  return viewHasIndexPane(view) ? "dual" : "workspace";
}

function legacyGridLayoutForView(view) {
  return viewHasIndexPane(view) ? "index-workspace" : "workspace";
}

function syncComposerOverlayHeight() {
  if (!els.chatForm) return;
  const layout = els.chatForm.closest(".chat-layout");
  if (!layout) return;
  const rect = els.chatForm.getBoundingClientRect?.();
  const height = Math.ceil(rect?.height || els.chatForm.offsetHeight || 0);
  if (height > 0) layout.style.setProperty("--composer-overlay-height", `${height}px`);
}

function observeComposerOverlayHeight() {
  if (!els.chatForm) return;
  syncComposerOverlayHeight();
  const schedule = () => {
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(syncComposerOverlayHeight);
    else syncComposerOverlayHeight();
  };
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(schedule);
    observer.observe(els.chatForm);
  }
  window.addEventListener("resize", schedule);
}

applySidebarWidth(state.sidebarWidth);
syncNavLayoutState();
syncNarrowLayout();
observeComposerOverlayHeight();

function activeConversationRunStatus() {
  return String(window.miaSocial?.activeConversationRun?.()?.status || "").trim();
}

function isActiveRunRunning() {
  return activeConversationRunStatus() === "running";
}
window.miaIsActiveRunRunning = isActiveRunRunning;

function isActiveConversationBusy() {
  const status = activeConversationRunStatus();
  return status === "running" || status === "cancelling";
}
window.miaIsActiveConversationBusy = isActiveConversationBusy;

function typingDotsHtml(label) {
  const prefix = label ? `${label} ` : "";
  const escape = window.miaMarkdown?.escapeHtml || ((s) => String(s ?? ""));
  return `<span class="typing-status">${escape(prefix)}正在输入<span class="typing-dots"><i></i><i></i><i></i></span></span>`;
}

function safeTagColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#64748b";
}

function resetPersonaMessageSearch() {
  personaSearchSerial += 1;
  if (personaSearchTimer) clearTimeout(personaSearchTimer);
  personaSearchTimer = 0;
  state.personaSearchLoading = false;
  state.personaSearchError = "";
  state.personaSearchQuery = "";
  state.personaSearchResults = [];
  state.personaSearchFocus = { conversationId: "", messageId: "" };
}

function isMissingSearchIpcHandlerError(error) {
  const text = String(error?.message || error || "").replace(/[–—]/g, "-");
  return /No handler registered/i.test(text)
    && /social:search-conversation-messages/i.test(text);
}

function isRemoteSearchUnavailableEnvelope(res) {
  if (!res || res.ok !== false) return false;
  const status = Number(res.status) || 0;
  const text = String(res.error || "").replace(/[–—]/g, "-");
  return status === 404
    || (status === 403 && /not a member of this conversation/i.test(text))
    || /Mia Cloud 404|not found/i.test(text);
}

function rendererMessageSearchSnippet(text, query, radius = 36) {
  const body = String(text || "").replace(/\s+/g, " ").trim();
  const needle = String(query || "").trim().toLowerCase();
  if (!body || !needle) return body.slice(0, radius * 2);
  const idx = body.toLowerCase().indexOf(needle);
  if (idx < 0) return body.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + needle.length + radius);
  return `${start > 0 ? "..." : ""}${body.slice(start, end)}${end < body.length ? "..." : ""}`;
}

async function searchConversationMessagesViaExistingIpc(query, limit = 80) {
  const social = window.miaSocial;
  const fetchMessages = window.mia?.social?.listConversationMessages;
  if (typeof fetchMessages !== "function") return { results: [] };
  const lower = String(query || "").trim().toLowerCase();
  if (!lower) return { results: [] };
  const seen = new Set();
  const rows = social?.renderSidebarRows?.() || [];
  const conversations = rows.map((row) => row?.conversation).filter((conversation) => {
    const id = String(conversation?.id || "").trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const activeConversationId = String(social?.getActiveConversationId?.() || "").trim();
  const activeConversation = activeConversationId ? social?.getConversationById?.(activeConversationId) : null;
  if (activeConversationId && activeConversation && !seen.has(activeConversationId)) {
    seen.add(activeConversationId);
    conversations.unshift(activeConversation);
  }
  const results = [];
  for (const conversation of conversations) {
    const conversationId = String(conversation?.id || "").trim();
    if (!conversationId) continue;
    const cacheEntry = social?.moduleState?.messageCache?.get?.(conversationId);
    const cachedMessages = Array.isArray(cacheEntry?.messages) ? cacheEntry.messages : [];
    let fetchedMessages = [];
    try {
      const res = await fetchMessages(conversationId, 0, 500);
      fetchedMessages = Array.isArray(res?.data?.messages) ? res.data.messages : [];
    } catch (error) {
      console.warn("[search] fallback listConversationMessages failed:", conversationId, error?.message || error);
      fetchedMessages = [];
    }
    const messagesByKey = new Map();
    for (const message of [...cachedMessages, ...fetchedMessages]) {
      const key = String(message?.id || `${message?.conversation_id || conversationId}:${message?.seq || messagesByKey.size}`);
      if (!key) continue;
      messagesByKey.set(key, message);
    }
    const messages = Array.from(messagesByKey.values());
    for (const message of messages) {
      const body = String(message?.body_md || message?.bodyMd || "");
      if (!body.toLowerCase().includes(lower)) continue;
      results.push({
        conversation,
        message,
        matchText: rendererMessageSearchSnippet(body, query)
      });
    }
  }
  results.sort((a, b) => {
    const at = new Date(a.message?.created_at || a.message?.createdAt || 0).getTime() || Number(a.message?.seq || 0);
    const bt = new Date(b.message?.created_at || b.message?.createdAt || 0).getTime() || Number(b.message?.seq || 0);
    return bt - at;
  });
  return { results: results.slice(0, Math.min(Math.max(Number(limit) || 80, 1), 200)) };
}

async function searchConversationMessages(query, limit = 80) {
  const searchRemote = window.mia?.social?.searchConversationMessages;
  if (typeof searchRemote !== "function") {
    return { ok: true, data: await searchConversationMessagesViaExistingIpc(query, limit) };
  }
  try {
    const res = await searchRemote(query, limit);
    if (isRemoteSearchUnavailableEnvelope(res)) {
      console.warn("[search] remote search route unavailable; using listConversationMessages fallback.");
      return { ok: true, data: await searchConversationMessagesViaExistingIpc(query, limit) };
    }
    return res;
  } catch (error) {
    if (!isMissingSearchIpcHandlerError(error)) throw error;
    console.warn("[search] search IPC handler missing; using listConversationMessages fallback.");
    return { ok: true, data: await searchConversationMessagesViaExistingIpc(query, limit) };
  }
}

function schedulePersonaMessageSearch() {
  const query = String(state.personaFilter || "").trim();
  if (personaSearchTimer) clearTimeout(personaSearchTimer);
  if (!query) {
    resetPersonaMessageSearch();
    render();
    return;
  }
  const serial = ++personaSearchSerial;
  state.personaSearchLoading = true;
  state.personaSearchError = "";
  render();
  personaSearchTimer = setTimeout(async () => {
    try {
      const res = await searchConversationMessages(query, 80);
      if (serial !== personaSearchSerial) return;
      if (!res?.ok) {
        state.personaSearchResults = [];
        state.personaSearchError = res?.error || "搜索失败";
      } else {
        state.personaSearchResults = Array.isArray(res.data?.results) ? res.data.results : [];
        state.personaSearchError = "";
      }
      state.personaSearchQuery = query;
    } catch (error) {
      if (serial !== personaSearchSerial) return;
      state.personaSearchResults = [];
      state.personaSearchQuery = query;
      state.personaSearchError = String(error?.message || error || "搜索失败");
    } finally {
      if (serial === personaSearchSerial) {
        state.personaSearchLoading = false;
        render();
      }
    }
  }, 220);
}

function setPersonaSearchOpen(open, options = {}) {
  state.personaSearchOpen = Boolean(open);
  if (!state.personaSearchOpen) {
    state.personaFilter = "";
    if (els.personaSearch) els.personaSearch.value = "";
    resetPersonaMessageSearch();
    if (options.clearTagFilter !== false) {
      window.miaSocial?.setConversationTagFilter?.("");
      if (window.miaSocial) return;
    }
  }
  render();
  if (state.personaSearchOpen) {
    setTimeout(() => els.personaSearch?.focus?.(), 0);
  }
}

function rowMatchesActiveTag(row) {
  const active = String(window.miaSocial?.getConversationTagFilter?.() || "").trim().toLowerCase();
  if (!active) return true;
  const otherDeviceFilter = String(window.miaSocial?.OTHER_DEVICE_CONVERSATION_FILTER || "").trim().toLowerCase();
  if (otherDeviceFilter && active === otherDeviceFilter) {
    return Boolean(window.miaSocial?.conversationRunsOnOtherDevice?.(row?.conversation));
  }
  const tags = row?.conversation?.tags || window.miaSocial?.conversationTagsFor?.(row?.conversation?.id) || [];
  return Array.isArray(tags) && tags.some((tag) => String(tag?.name || "").trim().toLowerCase() === active);
}

function searchResultPreview(result, query) {
  const text = String(result?.matchText || result?.message?.body_md || "").replace(/\s+/g, " ").trim();
  if (text) return text;
  return query ? `匹配「${query}」` : "匹配的会话记录";
}

function conversationRowsFromMessageSearch(results, query) {
  const social = window.miaSocial;
  return (Array.isArray(results) ? results : []).map((result) => {
    const message = result?.message || {};
    const conversationId = String(result?.conversation?.id || message.conversation_id || "").trim();
    const conversation = result?.conversation || social?.getConversationById?.(conversationId);
    if (!conversationId || !conversation) return null;
    const conversationType = conversation.type
      || (conversationId.startsWith("dm:") ? "dm"
        : conversationId.startsWith("botc_") ? "bot"
        : conversationId.startsWith("g_") || conversationId.startsWith("g-") ? "group"
        : "dm");
    const tags = social?.conversationTagsFor?.(conversationId) || [];
    const row = {
      type: conversationType === "group" ? "group-conversation" : "private-conversation",
      key: `search:${conversationId}:${message.id || message.seq || ""}`,
      searchResult: true,
      searchMessageId: message.id || "",
      searchMessageSeq: Number(message.seq) || 0,
      searchMessage: message,
      pinned: false,
      pinnedAt: "",
      updatedAt: new Date(message.created_at || message.createdAt || 0).getTime() || 0,
      conversation: {
        ...conversation,
        id: conversationId,
        type: conversationType,
        otherUser: conversationType === "dm" ? social?.otherUserForConversation?.(conversation) : null,
        lastMessagePreview: searchResultPreview(result, query),
        tags
      }
    };
    return rowMatchesActiveTag(row) ? row : null;
  }).filter(Boolean);
}

function openConversationSearchResult(conversationId, row) {
  const id = String(conversationId || "").trim();
  const messageId = String(row?.searchMessageId || row?.searchMessage?.id || "").trim();
  if (!id || !messageId) return false;
  state.activeKey = "";
  state.activeView = "chat";
  state.personaSearchFocus = { conversationId: id, messageId };
  showNarrowContent();
  render();
  if (typeof window.miaSocial?.focusConversationMessage !== "function") {
    window.miaSocial?.setActiveConversationId?.(id);
    render();
    return true;
  }
  const task = window.miaSocial?.focusConversationMessage?.(id, {
    messageId,
    seq: Number(row?.searchMessageSeq || row?.searchMessage?.seq) || 0,
    message: row?.searchMessage || null
  });
  if (task && typeof task.catch === "function") {
    task.catch((error) => console.warn("[renderer] search result focus failed:", error?.message || error));
  }
  return true;
}

function openDesktopNotificationConversation(payload = {}) {
  const conversationId = String(payload.conversationId || "").trim();
  const messageId = String(payload.messageId || "").trim();
  if (!conversationId) return;
  state.activeView = "chat";
  state.activeKey = "";
  state.personaSearchFocus = messageId ? { conversationId, messageId } : { conversationId: "", messageId: "" };
  showNarrowContent();
  render();
  if (messageId && typeof window.miaSocial?.focusConversationMessage === "function") {
    const task = window.miaSocial.focusConversationMessage(conversationId, { messageId });
    if (task && typeof task.catch === "function") {
      task.catch((error) => console.warn("[renderer] desktop notification focus failed:", error?.message || error));
    }
    return;
  }
  window.miaSocial?.setActiveConversationId?.(conversationId);
  render();
}

function sidebarAllConversationFilterHtml(active) {
  return `
    <button class="sidebar-tag-filter all${active ? " active" : ""}" type="button"
      role="tab" data-sidebar-tag-filter data-tag-name=""
      data-folder-key="${CONVERSATION_FOLDER_ALL_KEY}"
      aria-selected="${active ? "true" : "false"}" title="所有对话">
      <span class="sidebar-tag-filter-name">所有对话</span>
    </button>
  `;
}

function sidebarTagFilterHtml(tag) {
  const name = String(tag?.name || "").trim();
  const filterValue = String(tag?.filterValue || name).trim();
  const folderKey = String(tag?.storageKey || conversationFolderStorageKey(filterValue || name)).trim();
  const count = Number(tag?.count) || 0;
  const active = Boolean(tag?.filterActive);
  const color = safeTagColor(tag?.color);
  const title = count ? `分组「${name}」 · ${count} 个对话` : `分组「${name}」`;
  return `
    <button class="sidebar-tag-filter${active ? " active" : ""}" type="button"
      role="tab"
      data-sidebar-tag-filter data-tag-name="${window.miaMarkdown.escapeHtml(filterValue)}"
      data-folder-key="${window.miaMarkdown.escapeHtml(folderKey)}"
      aria-selected="${active ? "true" : "false"}" title="${window.miaMarkdown.escapeHtml(title)}"
      style="--tag-color:${window.miaMarkdown.escapeHtml(color)}">
      <span class="sidebar-tag-filter-name">${window.miaMarkdown.escapeHtml(name)}</span>
    </button>
  `;
}

function safeRenderSignature(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function readLocalJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocalJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage may be unavailable in restricted renderer contexts.
  }
}

function conversationFolderKey(name) {
  return String(name || "").trim().toLowerCase();
}

function conversationFolderStorageKey(name) {
  const key = conversationFolderKey(name);
  return key ? `tag:${key}` : CONVERSATION_FOLDER_ALL_KEY;
}

function conversationFolderItemStorageKey(tag = {}) {
  const explicit = String(tag?.storageKey || "").trim();
  if (explicit) return explicit;
  return conversationFolderStorageKey(tag?.filterValue || tag?.name);
}

function conversationFilterValue(tag = {}) {
  return String(tag?.filterValue || tag?.name || "").trim();
}

function conversationFolderLabelForFilter(filterValue) {
  const value = String(filterValue || "").trim();
  if (!value) return "";
  const filters = window.miaSocial?.conversationTagFilters?.() || [];
  const matched = filters.find((tag) => conversationFolderKey(conversationFilterValue(tag)) === conversationFolderKey(value));
  if (matched?.name) return String(matched.name).trim();
  const otherDeviceFilter = String(window.miaSocial?.OTHER_DEVICE_CONVERSATION_FILTER || "").trim();
  if (otherDeviceFilter && conversationFolderKey(value) === conversationFolderKey(otherDeviceFilter)) {
    return String(window.miaSocial?.OTHER_DEVICE_CONVERSATION_LABEL || "其他设备").trim();
  }
  return value;
}

function orderedConversationFolderItems(filters, activeFilterName) {
  const items = [
    { type: "all", key: CONVERSATION_FOLDER_ALL_KEY, active: !activeFilterName },
    ...(Array.isArray(filters) ? filters : []).map((tag) => ({
      type: "tag",
      key: conversationFolderItemStorageKey(tag),
      tag
    }))
  ];
  const stored = readLocalJson(CONVERSATION_FOLDER_ORDER_KEY, []);
  const order = new Map((Array.isArray(stored) ? stored : []).map((key, index) => [String(key || ""), index]));
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aOrder = order.has(a.item.key) ? order.get(a.item.key) : Number.MAX_SAFE_INTEGER;
      const bOrder = order.has(b.item.key) ? order.get(b.item.key) : Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

function conversationFolderItemsSignature(items) {
  return safeRenderSignature((Array.isArray(items) ? items : []).map((item) => {
    if (item.type === "all") return { key: item.key, type: item.type };
    const tag = item.tag || {};
    return {
      key: item.key,
      type: item.type,
      name: String(tag.name || "").trim(),
      filterValue: conversationFilterValue(tag),
      storageKey: conversationFolderItemStorageKey(tag),
      count: Number(tag.count) || 0,
      color: safeTagColor(tag.color),
      special: Boolean(tag.special)
    };
  }));
}

function sidebarTagButtonIndex(name) {
  const key = conversationFolderKey(name);
  const buttons = Array.from(els.personaTagFilters?.querySelectorAll?.("[data-sidebar-tag-filter]") || []);
  return buttons.findIndex((button) => conversationFolderKey(button.dataset.tagName || "") === key);
}

function rememberConversationFolderMotion(nextName) {
  const currentName = String(window.miaSocial?.getConversationTagFilter?.() || "").trim();
  const nextKey = conversationFolderKey(nextName);
  if (conversationFolderKey(currentName) === nextKey) return false;
  const currentIndex = sidebarTagButtonIndex(currentName);
  const nextIndex = sidebarTagButtonIndex(nextName);
  const direction = currentIndex >= 0 && nextIndex >= 0 && nextIndex < currentIndex ? -1 : 1;
  conversationFolderMotion = { key: nextKey, direction };
  return true;
}

function updateSidebarTagIndicator() {
  sidebarTagIndicatorFrame = 0;
  const strip = els.personaTagFilters?.querySelector?.(".sidebar-tag-filter-strip");
  const indicator = strip?.querySelector?.(".sidebar-tag-filter-indicator");
  const active = strip?.querySelector?.(".sidebar-tag-filter.active");
  if (!strip || !indicator || !active) {
    indicator?.style?.setProperty?.("--tag-indicator-width", "0px");
    return;
  }
  const x = active.offsetLeft - conversationFolderScrollLeft(strip);
  const width = active.offsetWidth;
  indicator.style.setProperty("--tag-indicator-x", `${Math.round(x)}px`);
  indicator.style.setProperty("--tag-indicator-width", `${Math.max(12, Math.round(width))}px`);
}

function scheduleSidebarTagIndicator() {
  if (sidebarTagIndicatorFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(sidebarTagIndicatorFrame);
  if (typeof requestAnimationFrame !== "function") {
    updateSidebarTagIndicator();
    return;
  }
  sidebarTagIndicatorFrame = requestAnimationFrame(updateSidebarTagIndicator);
}

function conversationFolderTrack(strip = null) {
  return (strip || els.personaTagFilters)?.querySelector?.(".sidebar-tag-filter-track") || null;
}

function conversationFolderScrollLeft(strip) {
  return Number(strip?.dataset?.folderScrollX) || 0;
}

function conversationFolderMaxScroll(strip) {
  const track = conversationFolderTrack(strip);
  if (!strip || !track) return 0;
  return Math.max(0, track.scrollWidth - strip.clientWidth);
}

function setConversationFolderScrollLeft(strip, value) {
  const track = conversationFolderTrack(strip);
  if (!strip || !track) return 0;
  const nextLeft = Math.max(0, Math.min(conversationFolderMaxScroll(strip), Math.round(Number(value) || 0)));
  strip.dataset.folderScrollX = String(nextLeft);
  track.style.setProperty("--tag-scroll-x", `${nextLeft}px`);
  return nextLeft;
}

function ensureActiveConversationFolderVisible(options = {}) {
  const strip = els.personaTagFilters?.querySelector?.(".sidebar-tag-filter-strip");
  const active = strip?.querySelector?.(".sidebar-tag-filter.active");
  if (!strip || !active || conversationFolderMaxScroll(strip) <= 0) return;
  const activeCenter = active.offsetLeft + active.offsetWidth / 2;
  let nextLeft = activeCenter - strip.clientWidth / 2;
  const previousLeft = conversationFolderScrollLeft(strip);
  const actualLeft = setConversationFolderScrollLeft(strip, nextLeft);
  if (Math.abs(actualLeft - previousLeft) < 1 && !options.force) return;
  scheduleSidebarTagIndicator();
}

function handleConversationFolderWheel(event) {
  const strip = event.target?.closest?.(".sidebar-tag-filter-strip");
  const maxLeft = conversationFolderMaxScroll(strip);
  if (!strip || maxLeft <= 0) return;
  const primaryDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!primaryDelta) return;
  const unit = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? strip.clientWidth : 1);
  event.preventDefault();
  event.stopPropagation();
  setConversationFolderScrollLeft(strip, conversationFolderScrollLeft(strip) + primaryDelta * unit);
  scheduleSidebarTagIndicator();
}

function syncSidebarTagFilterSelection(activeName) {
  const activeKey = conversationFolderKey(activeName);
  const buttons = Array.from(els.personaTagFilters?.querySelectorAll?.("[data-sidebar-tag-filter]") || []);
  for (const button of buttons) {
    const selected = conversationFolderKey(button.dataset.tagName || "") === activeKey;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  }
}

function cancelConversationFolderDragStart() {
  if (!conversationFolderDrag?.timer) return;
  clearTimeout(conversationFolderDrag.timer);
  conversationFolderDrag = null;
}

function saveConversationFolderDomOrder() {
  const keys = Array.from(els.personaTagFilters?.querySelectorAll?.("[data-sidebar-tag-filter]") || [])
    .map((button) => String(button.dataset.folderKey || "").trim())
    .filter(Boolean);
  if (!keys.length) return;
  writeLocalJson(CONVERSATION_FOLDER_ORDER_KEY, keys);
}

function startConversationFolderDrag(button, event) {
  const strip = button?.closest?.(".sidebar-tag-filter-strip");
  const track = conversationFolderTrack(strip);
  if (!strip || !conversationFolderDrag || conversationFolderDrag.active) return;
  conversationFolderDrag.active = true;
  conversationFolderDrag.strip = strip;
  conversationFolderDrag.track = track || strip;
  conversationFolderDrag.button = button;
  conversationFolderDrag.timer = 0;
  strip.classList.add("reordering");
  button.classList.add("dragging");
  try { button.setPointerCapture?.(event.pointerId); } catch { /* best effort */ }
}

function beginConversationFolderDrag(event) {
  const button = event.target?.closest?.("[data-sidebar-tag-filter]");
  if (!button || (typeof event.button === "number" && event.button !== 0)) return;
  cancelConversationFolderDragStart();
  conversationFolderDrag = {
    active: false,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    button,
    strip: null,
    track: null,
    timer: setTimeout(() => startConversationFolderDrag(button, event), CONVERSATION_FOLDER_LONG_PRESS_MS)
  };
}

function moveConversationFolderDrag(event) {
  const drag = conversationFolderDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (!drag.active && distance > 8) {
    cancelConversationFolderDragStart();
    return;
  }
  if (!drag.active || !drag.strip || !drag.button) return;
  event.preventDefault();
  const track = drag.track || conversationFolderTrack(drag.strip) || drag.strip;
  const siblings = Array.from(track.querySelectorAll("[data-sidebar-tag-filter]"))
    .filter((button) => button !== drag.button);
  let inserted = false;
  for (const sibling of siblings) {
    const rect = sibling.getBoundingClientRect();
    if (event.clientX < rect.left + rect.width / 2) {
      track.insertBefore(drag.button, sibling);
      inserted = true;
      break;
    }
  }
  if (!inserted) track.appendChild(drag.button);
  scheduleSidebarTagIndicator();
}

function endConversationFolderDrag(event) {
  const drag = conversationFolderDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (drag.timer) clearTimeout(drag.timer);
  if (drag.active) {
    event.preventDefault();
    conversationFolderSuppressClick = true;
    saveConversationFolderDomOrder();
    scheduleSidebarTagIndicator();
    setTimeout(() => { conversationFolderSuppressClick = false; }, 0);
  }
  drag.strip?.classList.remove("reordering");
  drag.button?.classList.remove("dragging");
  conversationFolderDrag = null;
}

function animatePersonaListFolderPage(activeName) {
  if (!els.personaList) return;
  const key = conversationFolderKey(activeName);
  if (lastConversationFolderKey == null) {
    lastConversationFolderKey = key;
    return;
  }
  if (lastConversationFolderKey === key) return;
  const direction = conversationFolderMotion.key === key ? conversationFolderMotion.direction : 1;
  lastConversationFolderKey = key;
  els.personaList.classList.remove("folder-page-forward", "folder-page-back");
  // Restart animation even when two quick taps have the same direction.
  void els.personaList.offsetWidth;
  els.personaList.classList.add(direction < 0 ? "folder-page-back" : "folder-page-forward");
  if (personaFolderAnimationTimer) clearTimeout(personaFolderAnimationTimer);
  personaFolderAnimationTimer = setTimeout(() => {
    els.personaList?.classList.remove("folder-page-forward", "folder-page-back");
  }, 260);
}

function renderConversationSearchTools(cloudReady) {
  const searchValue = String(state.personaFilter || "");
  const activeFilterName = String(window.miaSocial?.getConversationTagFilter?.() || "").trim();
  const searchOpen = Boolean(state.personaSearchOpen || searchValue);
  const filters = cloudReady ? (window.miaSocial?.conversationTagFilters?.() || []) : [];
  const showFilters = cloudReady && (filters.length > 0 || activeFilterName);
  const tools = els.personaSearch?.closest?.(".sidebar-tools") || null;
  const searchBox = els.personaSearch?.closest?.(".search-box") || null;

  if (els.personaSearch && els.personaSearch.value !== searchValue) {
    els.personaSearch.value = searchValue;
  }
  if (els.personaSearch) {
    els.personaSearch.placeholder = "";
  }
  tools?.classList.toggle("search-active", searchOpen);
  searchBox?.classList.toggle("has-query", Boolean(searchValue));
  els.personaSearchClear?.classList.toggle("hidden", !(searchOpen || searchValue));
  els.openPersonaSearch?.classList.add("hidden");
  els.newPersona?.classList.remove("hidden");
  els.closePersonaSearch?.classList.add("hidden");
  searchBox?.classList.remove("hidden");
  tools?.classList.toggle("has-tag-filters", showFilters);
  if (!els.personaTagFilters) return;
  els.personaTagFilters.classList.toggle("hidden", !showFilters);
  if (!showFilters) {
    if (els.personaTagFilters.dataset.renderSignature !== "hidden") {
      els.personaTagFilters.innerHTML = "";
      els.personaTagFilters.dataset.renderSignature = "hidden";
    }
    return;
  }
  const folderItems = orderedConversationFolderItems(filters, activeFilterName);
  const signature = conversationFolderItemsSignature(folderItems);
  if (els.personaTagFilters.dataset.renderSignature !== signature) {
    els.personaTagFilters.innerHTML = `
      <div class="sidebar-tag-filter-strip" role="tablist" aria-label="对话分组">
        <div class="sidebar-tag-filter-track">
          ${folderItems.map((item) => item.type === "all" ? sidebarAllConversationFilterHtml(!activeFilterName) : sidebarTagFilterHtml(item.tag)).join("")}
        </div>
        <span class="sidebar-tag-filter-indicator" aria-hidden="true"></span>
      </div>
    `;
    els.personaTagFilters.dataset.renderSignature = signature;
  }
  syncSidebarTagFilterSelection(activeFilterName);
  ensureActiveConversationFolderVisible();
  scheduleSidebarTagIndicator();
}

function typingLabelForActiveRun(social, conversation) {
  const run = social?.activeConversationRun?.();
  return typingLabelForConversationRun(social, conversation, run);
}

function conversationRunForSidebarPreview(social, conversation) {
  const conversationId = String(conversation?.id || "").trim();
  if (!conversationId) return null;
  const run = typeof social?.conversationRun === "function"
    ? social.conversationRun(conversationId)
    : social?.moduleState?.cloudAgentRunsByConversation?.get?.(conversationId);
  return run?.status === "running" ? run : null;
}

function typingLabelForConversationRun(social, conversation, run = null) {
  const activeRun = run || conversationRunForSidebarPreview(social, conversation);
  const botId = activeRun?.botId || "";
  if (!botId) return "";
  // Only group conversations need to identify the speaker — DM / bot chats
  // already have the bot's name in the header itself.
  if (conversation?.type !== "group") return "";
  const personas = allOwnedBotsForIdentity();
  const owned = personas.find((p) => (p.key || p.id) === botId);
  if (owned?.name) return owned.name;
  const members = social?.getConversationMembers?.(conversation.id) || [];
  const member = members.find((m) => m.member_kind === MemberKind.Bot && m.member_ref === botId);
  return member?.bot_name || botId;
}

function allOwnedBotsForIdentity() {
  const runtime = state.runtime || {};
  if (window.miaBotManager?.allOwnedBots) {
    return window.miaBotManager.allOwnedBots();
  }
  const cloudBots = window.miaSocial?.moduleState?.bots || [];
  if (window.miaBotDirectory?.listOwnedBots) {
    return window.miaBotDirectory.listOwnedBots({ cloudBots, runtime });
  }
  return Array.isArray(cloudBots) ? cloudBots : [];
}

function botAvatarIdentityId(botKey, bot = {}, member = null) {
  const identity = member?.identity || {};
  return window.miaContact?.botAvatarIdentityId?.(botKey, {
    ...(bot || {}),
    id: bot?.id || bot?.key || identity.id || botKey,
    member_ref: botKey
  }) || identity.id || bot?.id || bot?.key || botKey;
}

function hasAvatarIdentityFields(record) {
  if (typeof window.miaAvatarResolve?.hasAvatarIdentityFields === "function") {
    return window.miaAvatarResolve.hasAvatarIdentityFields(record);
  }
  return Boolean(record && typeof record === "object" && (
    Object.prototype.hasOwnProperty.call(record, "avatarImage")
      || Object.prototype.hasOwnProperty.call(record, "avatarCrop")
      || Object.prototype.hasOwnProperty.call(record, "avatar_image")
      || Object.prototype.hasOwnProperty.call(record, "avatar_crop")
  ));
}

function botMemberForConversation(social, conversation, botKey) {
  const members = social?.getConversationMembers?.(conversation?.id) || [];
  return members.find((m) => m.member_kind === MemberKind.Bot && m.member_ref === botKey) || null;
}

function botAvatarForConversation(conversation, botKey, { bot = null, member = null, displayName = "" } = {}) {
  const wanted = String(botKey || "");
  const localHasAvatar = hasAvatarIdentityFields(bot);
  const identityAvatar = member?.identity?.avatar || {};
  const name = displayName || bot?.name || bot?.displayName || member?.identity?.displayName || member?.bot_name || conversation?.name || wanted;
  const avatarId = botAvatarIdentityId(wanted, bot || {}, member || null);
  if (bot && localHasAvatar) {
    return window.miaAvatarResolve.resolveAvatarForContact({
      id: avatarId,
      displayName: name,
      avatarImage: bot.avatarImage || bot.avatar_image || "",
      avatarCrop: bot.avatarCrop || bot.avatar_crop || null,
      color: bot.color || bot.avatarColor || bot.avatar_color || ""
    });
  }
  if (member?.identity?.avatar && (identityAvatar.image || identityAvatar.color || identityAvatar.text)) {
    return identityAvatar;
  }
  return window.miaAvatarResolve.resolveAvatarForContact({
    id: avatarId,
    displayName: name,
    avatarImage: identityAvatar.image || member?.bot_avatar_image || "",
    avatarCrop: identityAvatar.crop || member?.bot_avatar_crop || null,
    color: identityAvatar.color || member?.bot_color || member?.avatarColor || member?.avatar_color || bot?.color || bot?.avatarColor || bot?.avatar_color || ""
  });
}

// Reconcile #activeChatMeta with the active cloud-agent run state. While the
// run is running we show typing dots; otherwise we restore the base meta
// (私聊 / 群聊 / etc.) so a run that ends via run.failed / run.cancelled
// (no message_appended to trigger a full render) doesn't leave stale dots.
function paintHeaderStatus() {
  if (!els.activeChatMeta) return;
  const social = window.miaSocial;
  const conversationId = social?.getActiveConversationId?.();
  const conversation = conversationId ? social?.getConversationById?.(conversationId) : null;
  if (isActiveRunRunning()) {
    els.activeChatMeta.innerHTML = typingDotsHtml(typingLabelForActiveRun(social, conversation));
    return;
  }
  if (!conversation) return;
  const personas = allOwnedBotsForIdentity();
  paintActiveCloudConversationHeader(conversation, { personas, social });
}

function renderSendButton() {
  if (!els.sendChat) return;
  const hasContent = Boolean(String(els.chatInput?.value || "").trim())
    || state.pendingAttachments.length > 0
    || (state.pathPasteRefs || []).length > 0;
  const cloudSignedIn = Boolean(state.runtime?.cloud?.enabled);
  const hasActiveCloudConversation = Boolean(window.miaSocial?.getActiveConversationId?.());
  const canSend = hasContent && (!cloudSignedIn || hasActiveCloudConversation);
  const status = activeConversationRunStatus();
  const generating = status === "running";
  const cancelling = status === "cancelling";
  const busy = generating || cancelling;
  els.sendChat.classList.toggle("stop", busy);
  els.sendChat.classList.toggle("stopping", cancelling);
  const title = cancelling ? "正在停止" : (generating ? "停止生成" : "发送");
  els.sendChat.title = title;
  els.sendChat.setAttribute("aria-label", title);
  els.sendChat.disabled = cancelling || (!generating && !canSend);
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
  mia: "Mia",
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
  serif: 'ui-serif, "Iowan Old Style", "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif'
};

const DEFAULT_ACCENT_COLOR = "#318ad3";
const DEFAULT_USER_BUBBLE_COLOR = "#eeffde";
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

// Resolve a cloud-conversation member record into an avatar tile. The kinds
// recognized here ("user" / "bot") mirror cloud-conversation-source.js's
// authorForMessage dispatch — same data shape, same resolution rules,
// so member tiles in the rail and sender avatars in the message stream
// stay in lockstep. Destructured access keeps the offending operator pattern
// out of app.js (Stage 5.2 will swap these literals for the
// shared MemberKind enum).
// Context passed to the shared resolveGroupMemberTiles for every group
// rendered in the renderer (sidebar + active-chat header). One builder so
// the cloud and local paths can't drift.
function groupTilesCtx(personas) {
  const social = window.miaSocial;
  // Group membership records use the CLOUD user id (state.runtime.cloud.user.id),
  // not the desktop-local user id. If we hand the resolver the local user
  // object the self-match misses and the user gets painted as the
  // "unknown friend" fallback tile.
  const cloudUser = state.runtime?.cloud?.user || null;
  const localUser = state.runtime?.user || null;
  const self = cloudUser
    ? {
        id: cloudUser.id,
        avatarImage: cloudUser.avatarImage || localUser?.avatarImage || "",
        avatarCrop: cloudUser.avatarCrop || localUser?.avatarCrop || null,
        avatarColor: cloudUser.avatarColor || localUser?.avatarColor || ""
      }
    : localUser;
  return {
    self,
    friends: social?.moduleState?.friends || [],
    bots: allOwnedBotsForIdentity()
    // shared/avatar-resolve.js owns the "no avatarImage → text fallback"
    // behavior now, so consumers don't need any local fallback table.
  };
}

// Normalize any sidebar row kind into a unified ConversationCard spec the
// sidebar-card-renderer can paint. Bot private + cloud DM both become
// {kind:"private"} with one member; local bot group + cloud conversation both
// become {kind:"group"} with stacked tiles. Single render path; "real
// human friend" is just another member kind, not a different conversation
// species.
function conversationCardSpecFromRow(row, personas) {
  if (!row) return null;
  const social = window.miaSocial;
  const identityBots = allOwnedBotsForIdentity();

  // ── cloud private conversation (DM with a friend OR bot session) ─────────────
  //     Same card shape; the only branch is "who's the other party" — a
  //     friend (dm conversation) or a bot (bot conversation) — and that flows
  //     through one resolver into a single spec.
  if (row.type === "private-conversation") {
    const conversation = row.conversation;
    const activeConversationId = social?.getActiveConversationId?.();
    const searchResult = Boolean(row.searchResult);
    const searchActive = searchResult
      && String(state.personaSearchFocus?.conversationId || "") === String(conversation.id || "")
      && String(state.personaSearchFocus?.messageId || "") === String(row.searchMessageId || "");
    const isBot = conversation.type === "bot";
    let name, avatar, identity, statusBadge;
    if (isBot) {
      const botKey = sessionHistory.botId(conversation);
      const bot = identityBots.find((p) => (p.id || p.key) === botKey);
      const member = botMemberForConversation(social, conversation, botKey);
      const botRecord = bot || {
        key: botKey,
        id: botKey,
        name: conversation.name || member?.identity?.displayName || member?.bot_name || botKey
      };
      name = sessionHistory.botDisplayTitle(conversation, identityBots, "对话");
      avatar = botAvatarForConversation(conversation, botKey, {
        bot: botRecord,
        member,
        displayName: name || botRecord.name || botKey
      });
      identity = bot || member?.identity || nameBadgeIdentity("bot", botRecord, name, botKey);
      statusBadge = statusBadgeFrom(identity, botRecord, member?.identity, member);
    } else {
      const other = conversation.otherUser || {};
      name = other.displayName || other.username || other.account || "好友";
      avatar = window.miaAvatarResolve.resolveAvatarForContact({
        id: other.id || other.account || name,
        displayName: name,
        avatarImage: other.avatarImage || "",
        avatarCrop: other.avatarCrop || null,
        color: other.avatarColor || other.avatar_color || other.color || ""
      });
      identity = nameBadgeIdentity("user", other.identity || other, name, other.id || other.account || "");
      statusBadge = statusBadgeFrom(other.identity, other);
    }
    const pinned = Boolean(social?.isConversationPinned?.(conversation.id));
    const muted = Boolean(social?.isConversationMuted?.(conversation.id));
    const unread = social?.getUnreadForConversation?.(conversation.id) || 0;
    const typingRun = searchResult ? null : conversationRunForSidebarPreview(social, conversation);
    return {
      kind: "private",
      searchResult,
      active: searchResult ? searchActive : conversation.id === activeConversationId,
      pinned: searchResult ? false : pinned,
      muted,
      name,
      typeLabel: "私聊",
      preview: conversation.lastMessagePreview || "暂无对话",
      typing: Boolean(typingRun),
      typingLabel: searchResult ? "" : typingLabelForConversationRun(social, conversation, typingRun),
      time: formatConversationTime(row.updatedAt),
      unread: searchResult ? 0 : unread,
      tags: searchResult ? [] : (conversation.tags || social?.conversationTagsFor?.(conversation.id) || []),
      tagEditor: searchResult ? null : (social?.conversationTagEditorFor?.(conversation.id) || null),
      avatar,
      identity,
      statusBadge,
      dataAttrs: {
        conversationId: conversation.id,
        ...(row.searchMessageId ? { searchMessageId: row.searchMessageId } : {}),
        ...(row.searchMessageSeq ? { searchMessageSeq: row.searchMessageSeq } : {})
      },
      onClick: () => {
        if (searchResult && openConversationSearchResult(conversation.id, row)) return;
        state.activeKey = "";
        window.miaSocial.setActiveConversationId(conversation.id);
        showNarrowContent();
        render();
      },
      onContextMenu: (x, y) => window.miaConversationContextMenu.openPrivateConversationMenu(
        { id: conversation.id, name, pinned, unread, muted },
        {
          togglePinned: () => { social.setConversationPinned(conversation.id, !pinned); render(); },
          toggleRead: (next) => {
            if (next) social.setConversationManuallyUnread(conversation.id, true);
            else { social.setConversationManuallyUnread(conversation.id, false); social.markConversationRead(conversation.id); }
            render();
          },
          toggleMuted: (next) => { social.setConversationMuted(conversation.id, next); render(); },
          editTags: () => social.editConversationTags?.(conversation.id, name, render, { anchor: { x, y } }),
          remove: async () => {
            if (isBot) {
              await deleteBot(sessionHistory.botId(conversation));
              return;
            }
            if (!confirm(`确定删除与「${name}」的对话？此操作不可撤销。`)) return;
            const res = await social.deleteCloudConversation(conversation.id);
            if (!res?.ok) alert(`删除失败：${res?.error || "未知错误"}`);
          },
          ...(isBot ? { rename: () => openEditBotDialog(sessionHistory.botId(conversation)) } : {})
        },
        x, y
      )
    };
  }

  // ── cloud group (friends + bots mixed) — same shape as local group ────
  if (row.type === "group-conversation") {
    const conversation = row.conversation;
    const activeConversationId = social?.getActiveConversationId?.();
    const searchResult = Boolean(row.searchResult);
    const searchActive = searchResult
      && String(state.personaSearchFocus?.conversationId || "") === String(conversation.id || "")
      && String(state.personaSearchFocus?.messageId || "") === String(row.searchMessageId || "");
    const memberRecords = social?.getConversationMembers?.(conversation.id) || [];
    const tiles = window.miaGroupTiles.resolveGroupMemberTiles(memberRecords, groupTilesCtx(personas));
    const memberCount = memberRecords.length || conversation.memberCount || 0;
    const cgPinned = Boolean(social?.isConversationPinned?.(conversation.id));
    const cgMuted = Boolean(social?.isConversationMuted?.(conversation.id));
    const cgUnread = social?.getUnreadForConversation?.(conversation.id) || 0;
    const cgName = conversation.name || "群聊";
    const cgIdentity = conversation.identity && typeof conversation.identity === "object"
      ? {
          ...conversation.identity,
          displayName: firstNonEmpty(conversation.identity.displayName, conversation.identity.display_name, cgName)
        }
      : null;
    const cgStatusBadge = statusBadgeFrom(conversation.identity, conversation);
    const typingRun = searchResult ? null : conversationRunForSidebarPreview(social, conversation);
    return {
      kind: "group",
      searchResult,
      active: searchResult ? searchActive : conversation.id === activeConversationId,
      pinned: searchResult ? false : cgPinned,
      muted: cgMuted,
      name: cgName,
      typeLabel: memberCount ? `群聊 · ${memberCount}人` : "群聊",
      preview: conversation.lastMessagePreview || "暂无消息",
      typing: Boolean(typingRun),
      typingLabel: searchResult ? "" : typingLabelForConversationRun(social, conversation, typingRun),
      time: formatConversationTime(row.updatedAt),
      unread: searchResult ? 0 : cgUnread,
      tags: searchResult ? [] : (conversation.tags || social?.conversationTagsFor?.(conversation.id) || []),
      tagEditor: searchResult ? null : (social?.conversationTagEditorFor?.(conversation.id) || null),
      members: tiles,
      customAvatar: conversation.decorations?.avatar || null,
      identity: cgIdentity,
      statusBadge: cgStatusBadge,
      dataAttrs: {
        conversationId: conversation.id,
        ...(row.searchMessageId ? { searchMessageId: row.searchMessageId } : {}),
        ...(row.searchMessageSeq ? { searchMessageSeq: row.searchMessageSeq } : {})
      },
      onClick: () => {
        if (searchResult && openConversationSearchResult(conversation.id, row)) return;
        state.activeKey = "";
        window.miaSocial.setActiveConversationId(conversation.id);
        showNarrowContent();
        render();
      },
      onContextMenu: (x, y) => window.miaConversationContextMenu.openGroupConversationMenu(
        { id: conversation.id, name: cgName, pinned: cgPinned, unread: cgUnread, muted: cgMuted },
        {
          togglePinned: () => { social.setConversationPinned(conversation.id, !cgPinned); render(); },
          toggleRead: (next) => {
            if (next) social.setConversationManuallyUnread(conversation.id, true);
            else { social.setConversationManuallyUnread(conversation.id, false); social.markConversationRead(conversation.id); }
            render();
          },
          toggleMuted: (next) => { social.setConversationMuted(conversation.id, next); render(); },
          editTags: () => social.editConversationTags?.(conversation.id, cgName, render, { anchor: { x, y } }),
          openInfo: () => window.miaGroupInfoDialog?.open(conversation.id),
          remove: async () => {
            if (!confirm(`确定删除群组「${cgName}」？此操作不可撤销，所有成员都将无法访问。`)) return;
            const res = await social.deleteCloudConversation(conversation.id);
            if (!res?.ok) alert(`删除失败：${res?.error || "未知错误"}`);
          }
        },
        x, y
      )
    };
  }

  return null;
}

function createConversationCardFromSpec(spec) {
  return spec?.kind === ConversationKind.CloudGroup
    ? window.miaSidebarCards.createGroupCard(spec)
    : window.miaSidebarCards.createPrivateCard(spec);
}

function sidebarCardRenderSignature(spec) {
  return {
    kind: spec?.kind || "",
    searchResult: Boolean(spec?.searchResult),
    pinned: Boolean(spec?.pinned),
    muted: Boolean(spec?.muted),
    name: String(spec?.name || ""),
    typeLabel: String(spec?.typeLabel || ""),
    preview: String(spec?.preview || ""),
    typing: Boolean(spec?.typing),
    typingLabel: String(spec?.typingLabel || ""),
    time: String(spec?.time || ""),
    unread: Number(spec?.unread) || 0,
    avatar: spec?.avatar || null,
    members: Array.isArray(spec?.members) ? spec.members : [],
    customAvatar: spec?.customAvatar || null,
    statusBadge: spec?.statusBadge || null,
    dataAttrs: spec?.dataAttrs || null,
    tags: Array.isArray(spec?.tags)
      ? spec.tags.map((tag) => ({
          name: String(tag?.name || "").trim(),
          color: safeTagColor(tag?.color)
        }))
      : [],
    tagEditor: spec?.tagEditor
      ? {
          active: Boolean(spec.tagEditor.active),
          adding: Boolean(spec.tagEditor.adding),
          mode: String(spec.tagEditor.mode || ""),
          targetName: String(spec.tagEditor.targetName || ""),
          draft: String(spec.tagEditor.draft || ""),
          removingName: String(spec.tagEditor.removingName || ""),
          filterName: String(spec.tagEditor.filterName || "")
        }
      : null
  };
}

function syncPersonaListActiveState(specs) {
  const cards = Array.from(els.personaList?.querySelectorAll?.(".persona.message-card") || []);
  specs.forEach((spec, index) => {
    cards[index]?.classList.toggle("active", Boolean(spec?.active));
  });
}

function renderPersonaListIfChanged(specs, emptyText, activeTagFilterName) {
  const signature = safeRenderSignature({
    emptyText,
    activeTagFilterName,
    rows: specs.map(sidebarCardRenderSignature)
  });
  if (personaListRenderSignature === signature) {
    syncPersonaListActiveState(specs);
    return;
  }
  personaListRenderSignature = signature;
  els.personaList.innerHTML = "";
  for (const spec of specs) {
    els.personaList.appendChild(createConversationCardFromSpec(spec));
  }
  syncPersonaListActiveState(specs);
  if (!specs.length && emptyText) {
    const empty = document.createElement("div");
    empty.className = "persona-empty";
    empty.textContent = emptyText;
    els.personaList.appendChild(empty);
  }
  animatePersonaListFolderPage(activeTagFilterName);
}

function renderChatConversationMenu(rows = [], personas = []) {
  const canOpen = state.activeView === "chat" && Boolean(els.chatConversationMenu && els.chatConversationList);
  const open = canOpen && Boolean(state.chatConversationMenuOpen);
  els.activeConversationMenuButton?.setAttribute("aria-expanded", open ? "true" : "false");
  els.activeConversationMenuButton?.classList.toggle("active", open);
  els.chatConversationMenu?.classList.toggle("hidden", !open);
  syncTopbarClickCapture();
  if (!canOpen || !open) {
    if (els.chatConversationList) els.chatConversationList.innerHTML = "";
    chatConversationMenuRenderSignature = "";
    return;
  }

  const compactRows = rows.slice(0, 18);
  const compactSpecs = [];
  for (const row of compactRows) {
    const spec = conversationCardSpecFromRow(row, personas);
    if (!spec) continue;
    const onClick = spec.onClick;
    compactSpecs.push({
      ...spec,
      searchResult: false,
      tags: [],
      tagEditor: null,
      preview: "",
      typing: false,
      onClick: () => {
        state.chatConversationMenuOpen = false;
        onClick?.();
      }
    });
  }

  const signature = safeRenderSignature({
    rows: compactSpecs.map(sidebarCardRenderSignature)
  });
  if (chatConversationMenuRenderSignature === signature) {
    syncChatConversationMenuActiveState(compactSpecs);
    return;
  }
  chatConversationMenuRenderSignature = signature;
  els.chatConversationList.innerHTML = "";
  for (const compactSpec of compactSpecs) {
    const card = createConversationCardFromSpec(compactSpec);
    card.classList.add("chat-conversation-menu-row");
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", compactSpec.active ? "true" : "false");
    const status = card.querySelector(".persona-side:not(.empty)");
    const nameRow = card.querySelector(".persona-name-row");
    if (status && nameRow) nameRow.appendChild(status);
    card.querySelector(".persona-preview-row")?.remove();
    card.querySelector(".persona-tag-row")?.remove();
    els.chatConversationList.appendChild(card);
  }

  if (!els.chatConversationList.children.length) {
    const empty = document.createElement("div");
    empty.className = "chat-conversation-menu-empty";
    empty.textContent = "暂无对话";
    els.chatConversationList.appendChild(empty);
  }
}

function syncChatConversationMenuActiveState(specs) {
  const cards = Array.from(els.chatConversationList?.querySelectorAll?.(".chat-conversation-menu-row.persona") || []);
  specs.forEach((spec, index) => {
    cards[index]?.classList.toggle("active", Boolean(spec?.active));
    cards[index]?.setAttribute("aria-selected", spec?.active ? "true" : "false");
  });
}

// Paint #activeChatAvatar / #activeChatName / #activeChatMeta for the
// currently-active cloud conversation (type ∈ {dm, group, bot}). Mirrors the
// local-group branch — both paths route through miaGroupAvatar for
// any conversation that has more than one member, so the sidebar and the
// chat header always agree.
function paintActiveCloudConversationHeader(conversation, { personas, social }) {
  const avatarEl = els.activeChatAvatar;
  const nameEl = els.activeChatName;
  const metaEl = els.activeChatMeta;
  const avatarHelper = window.miaAvatar;
  const groupAvatarHelper = window.miaGroupAvatar;
  const identityBots = allOwnedBotsForIdentity();
  // id-prefix fallback for pre-v7 cloud deployments that don't yet return
  // conversation.type. social.renderSidebarRows already normalizes this; mirror it
  // here so a conversation loaded outside the sidebar pipeline (active conversation loaded
  // from cache, etc.) still routes correctly.
  const conversationType = conversation.type
    || (conversation.id?.startsWith("dm:") ? "dm"
      : conversation.id?.startsWith("botc_") ? "bot"
      : (conversation.id?.startsWith("g_") || conversation.id?.startsWith("g-")) ? "group"
      : "dm");

  if (conversationType === "group") {
    const members = social?.getConversationMembers?.(conversation.id) || [];
    const tiles = window.miaGroupTiles.resolveGroupMemberTiles(members, groupTilesCtx(personas));
    const customAvatar = conversation.decorations?.avatar;
    if (avatarEl) {
      if (customAvatar && customAvatar.image) {
        avatarEl.className = "profile-avatar";
        avatarEl.removeAttribute("data-count");
        avatarHelper.applyAvatarMedia(avatarEl, customAvatar.image, customAvatar.crop, "#5e5ce6");
      } else {
        avatarEl.className = "profile-avatar group-avatar";
        groupAvatarHelper.applyGroupAvatar(avatarEl, tiles);
      }
    }
    setNameWithBadge(nameEl, {
      identity: conversation.identity || { kind: "group", id: conversation.id, displayName: conversation.name || "群聊" },
      fallbackName: conversation.name || "群聊",
      statusBadge: statusBadgeFrom(conversation.identity, conversation)
    });
    if (metaEl) setText(metaEl, tiles.length ? `群聊 · ${tiles.length} 人` : "群聊");
    return;
  }

  if (conversationType === "bot") {
    const botKey = sessionHistory.botId(conversation);
    const bot = identityBots.find((p) => (p.id || p.key) === botKey);
    const member = botMemberForConversation(social, conversation, botKey);
    const botRecord = bot || {
      key: botKey,
      id: botKey,
      name: conversation.name || member?.identity?.displayName || member?.bot_name || botKey
    };
    const botName = sessionHistory.botDisplayTitle(conversation, identityBots, "对话");
    const avatar = botAvatarForConversation(conversation, botKey, {
      bot: botRecord,
      member,
      displayName: botName
    });
    if (avatarEl) {
      avatarEl.removeAttribute("data-count");
      avatarEl.className = "profile-avatar";
      avatarHelper.paintAvatar(avatarEl, avatar);
    }
    setNameWithBadge(nameEl, {
      identity: bot || member?.identity || nameBadgeIdentity("bot", botRecord, botName, botKey),
      fallbackName: botName,
      statusBadge: statusBadgeFrom(bot, member?.identity, member, botRecord)
    });
    if (metaEl) setText(metaEl, "私聊");
    return;
  }

  // DM
  const otherUser = social?.otherUserForConversation?.(conversation) || {};
  const otherId = otherUser.id || "";
  const displayName = otherUser.displayName || otherUser.username || otherUser.account || otherId || "好友";
  const avatar = window.miaAvatarResolve.resolveAvatarForContact({
    id: otherId || otherUser.account || displayName,
    displayName,
    avatarImage: otherUser.avatarImage || "",
    avatarCrop: otherUser.avatarCrop || null,
    color: otherUser.avatarColor || otherUser.avatar_color || otherUser.color || ""
  });
  if (avatarEl) {
    avatarEl.removeAttribute("data-count");
    avatarEl.className = "profile-avatar";
    if (typeof avatarHelper.paintAvatar === "function") {
      avatarHelper.paintAvatar(avatarEl, avatar);
    } else {
      avatarHelper.applyAvatarMedia(avatarEl, avatar.image, avatar.crop, avatar.color, avatar.text);
    }
  }
  setNameWithBadge(nameEl, {
    identity: nameBadgeIdentity("user", otherUser.identity || otherUser, displayName, otherId || otherUser.account || ""),
    fallbackName: displayName,
    statusBadge: statusBadgeFrom(otherUser.identity, otherUser)
  });
  if (metaEl) setText(metaEl, "私聊");
}

// (openConversationContextMenu removed — sidebar now uses the unified
// openPrivateConversationMenu / openGroupConversationMenu from
// src/renderer/conversation-context-menu.js so cloud and local
// conversations share one menu shape.)

const { formatConversationTime, formatMessageTime } = (typeof window !== "undefined" && window.miaTimeFormat) || require("../shared/time-format");

function renderMessageTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return `<time class="message-time" datetime="${window.miaMarkdown.escapeHtml(date.toISOString())}" title="${window.miaMarkdown.escapeHtml(date.toLocaleString())}">${window.miaMarkdown.escapeHtml(formatMessageTime(date))}</time>`;
}

function isInlinePathRefAttachment(attachment = {}) {
  return Boolean(
    attachment.inlinePathRef
    || attachment.inline_path_ref
    || attachment.pathRefToken
    || attachment.path_ref_token
  );
}

function visibleMessageAttachments(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).filter((attachment) => !isInlinePathRefAttachment(attachment));
}

function renderAttachmentChips(attachments = []) {
  const visible = visibleMessageAttachments(attachments);
  if (!visible.length) return "";
  return `
    <div class="message-attachments">
      ${visible.map(renderAttachmentChip).join("")}
    </div>
  `;
}

function renderAttachmentThumb(attachment = {}, className = "attachment-thumb") {
  const src = String(attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || attachment.dataUrl || "").trim();
  if (!src || !src.startsWith("data:image/")) return `<span>${window.miaMarkdown.escapeHtml(window.miaFormat.attachmentGlyph(attachment))}</span>`;
  return `<img class="${window.miaMarkdown.escapeHtml(className)}" src="${window.miaMarkdown.escapeHtml(src)}" alt="">`;
}

function renderAttachmentChip(attachment = {}) {
  const image = (attachment.kind || window.miaFormat.attachmentKind(attachment)) === "image" && (attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || attachment.dataUrl || attachment.url);
  const imageSrc = String(attachment.dataUrl || attachment.previewDataUrl || attachment.thumbnailDataUrl || attachment.thumbnail || "").trim();
  const imageSrcAttr = imageSrc.startsWith("data:image/") ? ` data-image-src="${window.miaMarkdown.escapeHtml(imageSrc)}"` : "";
  const href = String(attachment.dataUrl || "").startsWith("data:") ? String(attachment.dataUrl) : "";
  const tag = href ? "a" : "span";
  const download = href ? ` href="${window.miaMarkdown.escapeHtml(href)}" download="${window.miaMarkdown.escapeHtml(attachment.name || "attachment")}"` : "";
  if (image) {
    return `
      <button class="message-attachment image" type="button"${imageSrcAttr} title="${window.miaMarkdown.escapeHtml(attachment.path || attachment.name || "")}" aria-label="预览图片">
        ${renderAttachmentThumb(attachment, "message-attachment-thumb")}
      </button>
    `;
  }
  return `
    <${tag} class="message-attachment"${download} title="${window.miaMarkdown.escapeHtml(attachment.path || attachment.name || "")}">
      ${renderAttachmentThumb(attachment, "message-attachment-thumb")}
      <strong>${window.miaMarkdown.escapeHtml(attachment.name || "附件")}</strong>
      <em>${window.miaMarkdown.escapeHtml(window.miaFormat.formatBytes(attachment.size))}</em>
    </${tag}>
  `;
}

let imagePreviewCleanup = null;

function imageEditorIcon(name) {
  const paths = {
    crop: '<path d="M7 3V17H21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 7H17V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 3V7H21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 17H7V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    draw: '<path d="M4 20L8.3 18.9L19.4 7.8C20.2 7 20.2 5.7 19.4 4.9L19.1 4.6C18.3 3.8 17 3.8 16.2 4.6L5.1 15.7L4 20Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14.8 6L18 9.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    save: '<path d="M5 4H16L19 7V20H5V4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 4V10H15V4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 17H16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    close: '<path d="M6.75 6.75L17.25 17.25M17.25 6.75L6.75 17.25" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || ""}</svg>`;
}

function closeImagePreview() {
  if (imagePreviewCleanup) {
    imagePreviewCleanup();
    imagePreviewCleanup = null;
  }
  document.querySelector(".image-preview-overlay")?.remove();
}

function openImagePreview(src, title = "", options = {}) {
  const imageSrc = String(src || "").trim();
  if (!imageSrc.startsWith("data:image/")) return;
  closeImagePreview();
  const overlay = document.createElement("div");
  overlay.className = "image-preview-overlay image-editor-overlay";
  overlay.innerHTML = `
    <div class="image-editor-dialog" role="dialog" aria-label="图片编辑器">
      <div class="image-editor-toolbar">
        <button class="image-editor-tool" type="button" data-image-editor-action="crop" title="剪裁" aria-label="剪裁">${imageEditorIcon("crop")}</button>
        <button class="image-editor-tool" type="button" data-image-editor-action="draw" title="涂鸦" aria-label="涂鸦">${imageEditorIcon("draw")}</button>
        <button class="image-editor-tool" type="button" data-image-editor-action="save" title="保存" aria-label="保存">${imageEditorIcon("save")}</button>
        <button class="image-editor-tool" type="button" data-image-editor-action="close" title="关闭" aria-label="关闭">${imageEditorIcon("close")}</button>
      </div>
      <div class="image-editor-stage">
        <canvas class="image-editor-canvas" aria-label="${window.miaMarkdown.escapeHtml(title || "图片预览")}"></canvas>
        <div class="image-editor-crop-box hidden" aria-hidden="true"></div>
      </div>
    </div>
  `;
  const dialog = overlay.querySelector(".image-editor-dialog");
  const stage = overlay.querySelector(".image-editor-stage");
  const canvas = overlay.querySelector(".image-editor-canvas");
  const cropBox = overlay.querySelector(".image-editor-crop-box");
  const context = canvas?.getContext("2d");
  const editor = {
    mode: "",
    crop: null,
    selecting: false,
    drawing: false,
    start: null
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || 1;
    const height = rect.height || 1;
    return {
      x: clamp((event.clientX - rect.left) * canvas.width / width, 0, canvas.width),
      y: clamp((event.clientY - rect.top) * canvas.height / height, 0, canvas.height)
    };
  }

  function normalizedRect(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y)
    };
  }

  function renderCropBox() {
    if (!cropBox || !stage || !canvas || !editor.crop || editor.crop.width < 2 || editor.crop.height < 2) {
      cropBox?.classList.add("hidden");
      return;
    }
    const stageRect = stage.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const scaleX = canvasRect.width / (canvas.width || 1);
    const scaleY = canvasRect.height / (canvas.height || 1);
    cropBox.classList.remove("hidden");
    cropBox.style.left = `${canvasRect.left - stageRect.left + editor.crop.x * scaleX}px`;
    cropBox.style.top = `${canvasRect.top - stageRect.top + editor.crop.y * scaleY}px`;
    cropBox.style.width = `${editor.crop.width * scaleX}px`;
    cropBox.style.height = `${editor.crop.height * scaleY}px`;
  }

  function setEditorMode(mode) {
    editor.mode = editor.mode === mode ? "" : mode;
    overlay.querySelectorAll("[data-image-editor-action]").forEach((button) => {
      button.classList.toggle("active", button.dataset.imageEditorAction === editor.mode);
    });
    canvas.classList.toggle("is-cropping", editor.mode === "crop");
    canvas.classList.toggle("is-drawing", editor.mode === "draw");
    renderCropBox();
  }

  function outputDataUrl() {
    const crop = editor.crop && editor.crop.width >= 8 && editor.crop.height >= 8 ? editor.crop : null;
    if (!crop) return canvas.toDataURL("image/png");
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(crop.width));
    out.height = Math.max(1, Math.round(crop.height));
    out.getContext("2d")?.drawImage(
      canvas,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      out.width,
      out.height
    );
    return out.toDataURL("image/png");
  }

  function saveImage() {
    const dataUrl = outputDataUrl();
    if (typeof options.onSave === "function") {
      options.onSave({ dataUrl });
    } else {
      const link = document.createElement("a");
      const baseName = String(title || "image").split(/[\\/]/).pop().replace(/[^\w.\-()[\] \u4e00-\u9fff]+/g, "_") || "image";
      link.download = /\.[a-z0-9]{2,5}$/i.test(baseName) ? baseName : `${baseName}.png`;
      link.href = dataUrl;
      link.click();
    }
    closeImagePreview();
  }

  function handlePointerDown(event) {
    if (!context || !editor.mode) return;
    event.preventDefault();
    const point = canvasPoint(event);
    canvas.setPointerCapture?.(event.pointerId);
    if (editor.mode === "crop") {
      editor.selecting = true;
      editor.start = point;
      editor.crop = { ...point, width: 0, height: 0 };
      renderCropBox();
      return;
    }
    if (editor.mode === "draw") {
      editor.drawing = true;
      context.strokeStyle = "#ff3b30";
      context.lineWidth = Math.max(4, Math.min(canvas.width, canvas.height) / 120);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.beginPath();
      context.moveTo(point.x, point.y);
    }
  }

  function handlePointerMove(event) {
    if (!context) return;
    const point = canvasPoint(event);
    if (editor.selecting && editor.start) {
      editor.crop = normalizedRect(editor.start, point);
      renderCropBox();
      return;
    }
    if (editor.drawing) {
      context.lineTo(point.x, point.y);
      context.stroke();
    }
  }

  function handlePointerUp(event) {
    if (editor.selecting && editor.crop && (editor.crop.width < 8 || editor.crop.height < 8)) {
      editor.crop = null;
      renderCropBox();
    }
    editor.selecting = false;
    editor.drawing = false;
    editor.start = null;
    canvas.releasePointerCapture?.(event.pointerId);
  }

  function handleKeydown(event) {
    if (event.key === "Escape") closeImagePreview();
  }

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeImagePreview();
    const action = event.target.closest("[data-image-editor-action]")?.dataset.imageEditorAction;
    if (!action) return;
    event.preventDefault();
    if (action === "close") closeImagePreview();
    if (action === "save") saveImage();
    if (action === "crop" || action === "draw") setEditorMode(action);
  });
  canvas?.addEventListener("pointerdown", handlePointerDown);
  canvas?.addEventListener("pointermove", handlePointerMove);
  canvas?.addEventListener("pointerup", handlePointerUp);
  canvas?.addEventListener("pointercancel", handlePointerUp);
  window.addEventListener("resize", renderCropBox);
  document.addEventListener("keydown", handleKeydown);
  imagePreviewCleanup = () => {
    window.removeEventListener("resize", renderCropBox);
    document.removeEventListener("keydown", handleKeydown);
  };
  document.body.appendChild(overlay);
  const image = new Image();
  image.onload = () => {
    canvas.width = image.naturalWidth || image.width || 1;
    canvas.height = image.naturalHeight || image.height || 1;
    context?.drawImage(image, 0, 0, canvas.width, canvas.height);
    dialog?.classList.add("ready");
    renderCropBox();
  };
  image.src = imageSrc;
}

async function openPathRefPreviewFromChip(chip) {
  const filePath = String(chip?.dataset?.pathRefPath || "").trim();
  if (!filePath) return false;
  try {
    const attachment = await window.mia?.fetchFileAttachment?.({ path: filePath });
    if (attachment?.error) throw new Error(attachment.message || "图片读取失败");
    const src = String(attachment?.dataUrl || attachment?.previewDataUrl || attachment?.thumbnailDataUrl || "").trim();
    if (!src.startsWith("data:image/")) throw new Error("这不是可预览的图片。");
    openImagePreview(src, attachment?.name || filePath);
    return true;
  } catch (error) {
    appendTransientChat("assistant", `图片预览失败: ${error.message || error}`);
    return false;
  }
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
      return true;
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
    window.mia.fetchFileAttachment?.(filePath.startsWith("/api/files/") ? { url: filePath } : { path: filePath })
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


function cryptoRandomId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `session_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

const EFFORT_LABELS = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high" };
const APPROVAL_LABELS = {
  ask: "Ask",
  yolo: "YOLO",
  deny: "Deny",
  manual: "Ask",   // legacy alias from previous mia schema
  smart: "Smart",
  off: "YOLO"     // legacy alias from previous mia schema
};
const APPROVAL_TITLES = {
  ask: "危险命令会暂停并等待你确认。",
  yolo: "跳过所有危险命令的确认 — 仅在完全信任当前任务时启用。",
  deny: "自动拒绝所有危险命令。",
  smart: "用辅助模型判断低风险命令，高风险仍询问。",
  manual: "(legacy) 等价于 Ask。"
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function trackStartupTask(label, task) {
  const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const start = performance.now();
  state.startupTasks.push({ id, label });
  if (window.miaStartupOverlay?.isBlocking?.()) {
    window.miaStartupOverlay?.setStatus?.(`正在${label}`);
  }
  render();
  try {
    return await task();
  } finally {
    const ms = Math.round(performance.now() - start);
    console.info(`[Mia startup] ${label}: ${ms}ms`);
    state.startupTasks = state.startupTasks.filter((item) => item.id !== id);
    render();
  }
}

function loadInitialRuntimeData() {
  return Promise.allSettled([
    trackStartupTask("加载 Hermes 模型列表", () => window.miaLoaders.loadModelCatalog()),
    trackStartupTask("加载 Codex 模型列表", () => window.miaLoaders.loadCodexModels()),
    trackStartupTask("加载引擎能力", () => window.miaLoaders.loadEngineCapabilities()),
    trackStartupTask("加载命令列表", () => window.miaLoaders.loadSlashCommands()),
    trackStartupTask("扫描本地 Skill", () => window.miaLoaders.loadSkills())
  ]).then(() => render());
}

async function loadTasksFromDaemonForStartup() {
  if (!window.miaTasksPanel?.loadTasksFromDaemon) return;
  try {
    if (window.miaStartupOverlay?.isBlocking?.()) {
      await trackStartupTask("加载任务列表", () => window.miaTasksPanel.loadTasksFromDaemon());
    } else {
      await window.miaTasksPanel.loadTasksFromDaemon();
    }
    window.miaTasksPanel.subscribeTaskEvents?.();
    if (state.activeView === "tasks") {
      window.miaTasksPanel.renderTaskView();
    }
  } catch (error) {
    console.warn("[Mia startup] failed to load daemon tasks", error);
  }
}

async function runFirstRunBackgroundServices() {
  if (typeof window.mia?.startupBackgroundServices !== "function") return null;
  try {
    return await trackStartupTask("启动 Mia Core", () => window.mia.startupBackgroundServices());
  } catch (error) {
    console.warn("[Mia startup] failed to start background services", error);
    return { ok: false, error: error?.message || String(error || "Unknown error") };
  }
}

function selectedAuthMethod(runtime) {
  if ((runtime?.model?.provider || "") === "openai-codex") return "openai-codex";
  return els.authMethod.value || "api-key";
}

function updateModelFieldVisibility(runtime = state.runtime) {
  const providerEntry = window.miaModelHelpers.selectedProviderEntry();
  const entry = window.miaModelHelpers.selectedModelEntry();
  const authType = String(entry?.authType || "api_key");
  const isConnected = window.miaModelSettings.providerIsConnected(entry?.provider, runtime);
  const isCodex = entry ? entry.provider === "openai-codex" : false;
  const needsApiKey = Boolean(entry) && !isConnected && !isCodex && !authType.startsWith("oauth") && entry?.provider !== "lmstudio";
  const needsOauth = Boolean(entry) && !isConnected && (isCodex || authType.startsWith("oauth"));
  const canConnectWithoutKey = Boolean(entry) && !isConnected && entry.provider === "lmstudio";
  els.modelApiKeyField?.classList.toggle("hidden", !needsApiKey);
  els.codexInlineAuth.classList.toggle("hidden", !needsOauth);
  els.modelConnectButton?.classList.toggle("hidden", !(needsApiKey || canConnectWithoutKey));
	  if (entry) {
	    window.miaModelSettings.applyModelEntryToFields(entry);
	    const copy = window.miaModelSettings.modelAuthCopy(entry, runtime);
	  const showAuthState = !needsApiKey && !needsOauth;
	  setText(els.modelAuthState, isConnected ? "已连接" : copy.state);
	  els.modelAuthState?.classList.toggle("hidden", !showAuthState);
	    els.modelApiKey.placeholder = entry.apiKeyEnv || "API Key";
	    if (els.modelConnectButton) {
	      els.modelConnectButton.textContent = "连接";
	      els.modelConnectButton.title = `连接 ${providerEntry?.providerLabel || entry.providerLabel || entry.provider}`;
	    }
  } else {
    els.modelAuthState?.classList.add("hidden");
  }
}


let onboardingWindowState = null;
// Drive the OS window size from the screen actually shown: compact/narrow while
// the onboarding setup guide is up, restore to the main window when leaving it.
// Centralizes the body.onboarding-window class so window sizing can't drift from
// the unreliable create-time heuristic.
function setOnboardingWindow(active) {
  const on = Boolean(active);
  document.body.classList.toggle("onboarding-window", on);
  if (onboardingWindowState === on) return;
  const wasOnboarding = onboardingWindowState;
  onboardingWindowState = on;
  if (on) window.mia.window?.onboarding?.();
  else if (wasOnboarding === true) window.mia.window?.showMain?.();
}

function focusedSidebarTagInput() {
  const input = document.activeElement;
  if (!input?.matches?.("[data-tag-input]")) return null;
  if (!els.personaList?.contains(input)) return null;
  const card = input.closest?.("[data-conversation-id]");
  const conversationId = String(card?.dataset?.conversationId || "").trim();
  if (!conversationId) return null;
  return { conversationId, value: input.value || "" };
}

function render() {
  const runtime = state.runtime;
  if (!runtime) {
    if (window.miaSetupGuide?.shouldShowSetupGuide?.({ messages: [] })) {
      setOnboardingWindow(true);
      els.chat.innerHTML = window.miaSetupGuide.renderSetupGuide();
      window.miaLottieIcons?.init?.(els.chat);
      return;
    }
    setOnboardingWindow(false);
    if (els.chat) els.chat.innerHTML = "";
    return;
  }
  updateStatusBadgeAssetBaseUrl(runtime);
  const cloudSignedIn = Boolean(runtime?.cloud?.enabled);
  els.appShell?.setAttribute("data-auth-state", cloudSignedIn ? "signed-in" : "signed-out");
  renderSendButton();
  window.miaMessageHelpers.renderComposerReply();
  // Re-evaluate composer skill chips every render so switching conversations drops
  // chips that belonged to the previous conversation (self-heal in composer).
  window.miaComposer?.renderComposerSkills?.();
  const editingModel = els.modelForm.contains(document.activeElement);
  const editingProfile = Boolean(state.profileDialogOpen || els.profileForm?.contains(document.activeElement));
  const editingAppearance = Boolean(els.appearanceForm?.contains(document.activeElement));
  const appearance = runtime.appearance || {
    theme: "light",
    fontPreset: "system",
    accentColor: DEFAULT_ACCENT_COLOR,
    userBubbleColor: DEFAULT_USER_BUBBLE_COLOR,
    showUserAvatar: false,
    showAssistantAvatar: false,
    listStyle: "card",
    selectionStyle: DEFAULT_SELECTION_STYLE,
    workspaceBackgroundColor: "",
    workspaceBackgroundImage: ""
  };
  window.miaSettingsAppearance.applyAppearance(appearance);
  if (!editingAppearance) {
    els.appearanceTheme.value = appearance.theme || "light";
    const savedFontPreset = appearance.fontPreset || "system";
    els.appearanceFontPreset.value = fontPresets[savedFontPreset] ? savedFontPreset : "system";
    window.miaSettingsAppearance.syncAppearanceControls(appearance);
  }
  const user = runtimeUserIdentity(runtime);
  window.miaAvatar.applyUserAvatar(els.userAvatar, user);
  window.miaAvatar.applyUserAvatar(els.sidebarUserAvatar, user);
  setText(els.userDisplayName, user.displayName || "");
  if (els.profileUidValue) els.profileUidValue.textContent = user.id || "未登录";
  if (!editingProfile && els.profileForm) {
    els.profileDisplayName.value = user.displayName || "";
    if (els.profileStatusBadge) els.profileStatusBadge.value = statusBadgePresetValue(user.statusBadge);
    syncIdentityNameText("profile");
    syncStatusBadgeControl("profile");
    window.miaBotDialog.setProfileAvatarDraft(user.avatarImage || "", user.avatarCrop);
  }

  if (els.engineStatus) {
    els.engineStatus.textContent = runtime.engineRunning
      ? `Running ${runtime.engineManagedBy ? `via ${runtime.engineManagedBy} ` : ""}at ${runtime.engineBaseUrl}`
      : runtime.engineStarting
        ? "Starting Hermes API..."
        : runtime.engineInstalled
          ? "Hermes engine installed"
          : "Runtime home initialized; engine package not installed";
  }
  renderEngineDetection(runtime);
  if (els.hermesHome) els.hermesHome.textContent = runtime.hermesHome;
  if (els.manifestPath) els.manifestPath.textContent = runtime.manifestPath;
  els.engineWarning?.classList.toggle("hidden", runtime.engineInstalled);
  if (els.engineLogs) {
    els.engineLogs.textContent = [
      runtime.engineLastError ? `ERROR: ${runtime.engineLastError}` : "",
      ...(runtime.engineLogs || [])
    ].filter(Boolean).join("\n");
  }
  window.miaSettingsRemote.renderCloudAccount(runtime.cloud || {});
  const auth = runtime.auth || {};
  const editingModelSelect = document.activeElement === els.modelSelect || document.activeElement === els.quickModelSelect || document.activeElement === els.effortSelect;
  if (!editingModel && !editingModelSelect) window.miaModelSettings.renderModelSelectors(runtime);
  window.miaModelSettings.renderConnectedProviders(runtime);
  updateModelFieldVisibility(runtime);
  const selectedEntry = window.miaModelHelpers.selectedModelEntry();
  const selectedProvider = selectedEntry?.provider || auth.oauthProvider || "openai-codex";
  const selectedProviderLabel = window.miaModelHelpers.providerLabel(selectedProvider);
  const selectedConnected = window.miaModelSettings.providerIsConnected(selectedProvider, runtime);
  if (els.codexStatus) {
    els.codexStatus.textContent = auth.codexStarting
      ? `等待 ${auth.oauthProviderLabel || selectedProviderLabel} 授权`
      : selectedConnected
        ? `已授权 ${selectedProviderLabel}`
        : `需要登录 ${selectedProviderLabel}`;
  }
  els.codexCheck?.classList.toggle("authorized", Boolean(selectedConnected));
  const codexCodeText = auth.codexUserCode
    ? `在浏览器页面输入：${auth.codexUserCode}`
    : auth.codexStarting
      ? (auth.codexVerificationUrl ? `打开：${auth.codexVerificationUrl}` : "正在请求设备码...")
      : "";
  if (els.codexCode) {
    els.codexCode.textContent = codexCodeText;
    els.codexCode.classList.toggle("hidden", !codexCodeText);
  }
  const codexLogsText = [
    auth.codexLastError ? `ERROR: ${auth.codexLastError}` : "",
    ...(auth.codexLogs || [])
  ].filter(Boolean).join("\n");
  if (els.codexLogs) {
    els.codexLogs.textContent = codexLogsText;
    els.codexLogs.classList.toggle("hidden", !codexLogsText || (Boolean(selectedConnected) && !auth.codexLastError));
  }
  els.codexLogin.disabled = Boolean(auth.codexStarting);
  els.codexLogin.textContent = `登录 ${selectedProviderLabel}`;
  els.codexCancel?.classList.toggle("hidden", !auth.codexStarting);
  els.codexLogin.classList.toggle("hidden", Boolean(selectedConnected));
  els.codexCancel.disabled = !auth.codexStarting;
  els.codexCancel.classList.toggle("hidden", !auth.codexStarting);
  if (!editingModel) updateModelFieldVisibility(runtime);
  if (els.quickModelSelect && document.activeElement !== els.quickModelSelect) {
    const engine = window.miaEngineOptions.activeAgentEngine();
    const currentModelId = window.miaEngineOptions.isExternalAgentEngine(engine)
      ? (window.miaEngineOptions.engineConfigForPersona().model || "default")
      : window.miaModelHelpers.presetKeyForModel(runtime.model);
    if ([...els.quickModelSelect.options].some((option) => option.value === currentModelId)) {
      els.quickModelSelect.value = currentModelId;
    }
    window.miaModelSettings.syncQuickModelLabel();
  }
  window.miaModelSettings.syncEffortControl(runtime);
  const connectedEntries = window.miaModelSettings.connectedModelEntries(runtime);
  const engine = window.miaEngineOptions.activeAgentEngine();
  setText(els.modelSwitchStatus, window.miaEngineOptions.isExternalAgentEngine(engine)
    ? window.miaEngineOptions.localEngineStatusText(runtime, engine)
    : connectedEntries.length ? (runtime.engineRunning ? "已连接" : runtime.engineInstalled ? "未启动" : "未安装") : "先连接提供商");
  if (els.quickModelSelect) {
    els.quickModelSelect.title = window.miaEngineOptions.isExternalAgentEngine(engine)
      ? `当前模型：${els.quickModelSelect.selectedOptions?.[0]?.textContent || "默认"}`
      : connectedEntries.length
        ? `当前模型：${window.miaModelHelpers.modelDisplayName(runtime.model)}`
        : "未配置模型";
  }
  const activeIcon = window.miaEngineOptions.isExternalAgentEngine(engine)
    ? window.miaModelHelpers.modelIconSrc({
      provider: window.miaEngineOptions.engineIconProvider(engine),
      model: window.miaEngineOptions.engineIconModel(engine)
    })
    : connectedEntries.length
      ? window.miaModelHelpers.modelIconSrc(runtime.model || {})
      : "";
  applyComposerModelAvatar(document.querySelector(".model-avatar"), activeIcon);
  window.miaModelSettings.syncPermissionControl(runtime);
  syncConversationBotRuntimeControls();

  const personas = allOwnedBotsForIdentity();
  const social = window.miaSocial;
  // cloud.enabled = token present (signed in). NOTE: there is no
  // cloud.loggedIn field — cloudStatus() exposes enabled/connected/
  // connecting only. An earlier version gated on loggedIn, which was
  // always undefined, so the gate never fired and personas always
  // painted first.
  const activeCloudConversationId = social?.getActiveConversationId?.();
  // Only fall back to personas[0] when no persona matches AND no group is active.
  // Without this guard, clicking a group (whose id doesn't match any persona key)
  // immediately resets activeKey back to personas[0], making group selection a no-op.
  if (cloudSignedIn) {
    state.activeKey = "";
  } else if (!personas.some((persona) => persona.key === state.activeKey) && personas.length && !activeCloudConversationId) {
    state.activeKey = personas[0].key;
  }
  const syncedBotKeys = new Set((social?.moduleState?.bots || [])
    .map((bot) => String(bot?.key || bot?.id || "").trim())
    .filter(Boolean));
  const contactKeys = new Set([
    ...personas.map((persona) => String(persona.key || persona.id || "")),
    ...syncedBotKeys
  ].filter(Boolean));
  // The pinned "新的好友" entry uses a sentinel key that is intentionally not a
  // contact — leave it alone here, bot-manager.renderContacts() owns its fallback.
  if (state.activeContactKey !== window.miaBotManager?.FRIEND_REQUESTS_KEY
    && !contactKeys.has(state.activeContactKey) && contactKeys.size) {
    state.activeContactKey = personas.find((persona) => persona.key === state.activeKey)?.key
      || personas[0]?.key
      || [...syncedBotKeys][0]
      || "";
  }
  els.personaCount.textContent = "";
  els.personaCount.classList.add("hidden");
  const active = cloudSignedIn ? null : (personas.find((persona) => persona.key === state.activeKey) || personas[0]);
  const activeCloudConversation = activeCloudConversationId
    ? social?.getConversationById?.(activeCloudConversationId)
    : null;
  const groupInfoBtn = document.getElementById("groupInfoButton");
  const composerBottom = document.querySelector(".composer-toolbar .composer-controls");
  if (activeCloudConversation) {
    paintActiveCloudConversationHeader(activeCloudConversation, { personas, social: window.miaSocial });
    paintHeaderStatus();
    const activeCloudConversationType = conversationTypeForComposer(activeCloudConversation, activeCloudConversation.id || activeCloudConversationId);
    const activeIsGroup = activeCloudConversationType === "group";
    const activeIsHumanDm = activeCloudConversationType === "dm";
    const hideSessionSelector = activeIsGroup || activeIsHumanDm;
    const showPrivateAiControls = activeCloudConversationType === "bot";
    if (groupInfoBtn) groupInfoBtn.classList.toggle("hidden", !activeIsGroup);
    if (hideSessionSelector) state.sessionMenuOpen = false;
    if (els.sessionMenuButton) {
      els.sessionMenuButton.classList.remove("hidden");
      els.sessionMenuButton.classList.toggle("hidden", hideSessionSelector);
    }
    if (composerBottom) composerBottom.classList.toggle("hidden", !showPrivateAiControls);
  } else if (cloudSignedIn) {
    if (els.activeChatAvatar) {
      els.activeChatAvatar.innerHTML = "";
      els.activeChatAvatar.className = "profile-avatar";
    }
    setText(els.activeChatName, "选择对话");
    if (els.activeChatMeta) setText(els.activeChatMeta, "云端同步已开启");
    if (groupInfoBtn) groupInfoBtn.classList.add("hidden");
    if (els.sessionMenuButton) els.sessionMenuButton.classList.add("hidden");
    if (composerBottom) composerBottom.classList.toggle("hidden", true);
  } else if (active) {
    if (els.activeChatAvatar) {
      els.activeChatAvatar.className = "profile-avatar";
    }
    window.miaAvatar.applyBotAvatar(els.activeChatAvatar, active);
    setNameWithBadge(els.activeChatName, {
      identity: nameBadgeIdentity("bot", active, active.name || "Mia", active.key || active.id || ""),
      fallbackName: active.name || "Mia",
      statusBadge: statusBadgeFrom(active)
    });
    if (els.activeChatMeta) {
      const startupLoading = state.startupTasks[0]?.label;
      if (startupLoading) {
        els.activeChatMeta.innerHTML = `正在${window.miaMarkdown.escapeHtml(startupLoading)}`;
      } else {
        setText(els.activeChatMeta, "在线");
      }
    }
    if (groupInfoBtn) groupInfoBtn.classList.add("hidden");
    if (els.sessionMenuButton) els.sessionMenuButton.classList.remove("hidden");
    if (composerBottom) composerBottom.classList.remove("hidden");
  }
  // Cloud-only: the sidebar lists cloud conversations exclusively. Local bot
  // personas are no longer a conversation source — a bot surfaces as its
  // cloud bot conversation once bootstrap completes.
  const cloudReady = !cloudSignedIn || !social || social.isBootstrapped?.();
  const socialRows = cloudReady ? (social?.renderSidebarRows?.() || []) : [];
  renderConversationSearchTools(cloudReady);
  const searchQuery = String(state.personaFilter || "").trim();
  const searchMode = Boolean(state.personaSearchOpen || searchQuery);
  const activeTagFilterName = String(window.miaSocial?.getConversationTagFilter?.() || "").trim();
  const activeTagFilterLabel = conversationFolderLabelForFilter(activeTagFilterName);
  const useMessageSearch = searchMode && Boolean(searchQuery);
  const messageRows = !cloudReady
    ? []
    : searchMode
      ? (useMessageSearch
        ? conversationRowsFromMessageSearch(
          state.personaSearchQuery === searchQuery ? state.personaSearchResults : [],
          searchQuery
        )
        : [])
      : window.miaBotManager.sortMessageCardsForSidebar(socialRows);
  const compactConversationRows = cloudReady ? window.miaBotManager.sortMessageCardsForSidebar(socialRows) : [];
  renderChatConversationMenu(compactConversationRows, personas);
  const tagInput = focusedSidebarTagInput();
  if (tagInput) social?.setConversationTagDraft?.(tagInput.conversationId, tagInput.value);
  const holdSidebarForTagInput = Boolean(tagInput
    && social?.conversationTagEditorFor?.(tagInput.conversationId)?.active);

  if (!holdSidebarForTagInput) {
    const sidebarSpecs = [];
    for (const row of messageRows) {
      const spec = conversationCardSpecFromRow(row, personas);
      if (!spec) continue;
      sidebarSpecs.push(spec);
    }

    let emptyText = "";
    if (!messageRows.length) {
      emptyText = cloudSignedIn
        ? (cloudReady
          ? (searchMode
            ? (useMessageSearch
              ? (state.personaSearchLoading ? "正在搜索会话记录…" : (state.personaSearchError || "没有匹配的会话记录"))
              : "")
            : (activeTagFilterLabel ? `「${activeTagFilterLabel}」分组暂无对话` : "没有匹配的消息"))
          : "正在同步会话…")
        : "正在打开登录引导…";
    }
    renderPersonaListIfChanged(sidebarSpecs, emptyText, activeTagFilterName);
  }
  renderView();
  renderSessionMenu();
  if (!window.miaMessageMenu?.hasActiveMessageTextSelection()) renderChat();
}

function renderView() {
  state.isNarrowWindow = window.innerWidth <= SHELL_SINGLE_MAX_WIDTH;
  normalizeNarrowPaneForView(state.activeView);
  state.shellLayout = shellLayoutForView(state.activeView);
  if (state.activeSettingsTab === "profile") state.activeSettingsTab = "appearance";
  if (state.activeSettingsTab === "runtime") state.activeSettingsTab = "model";
  if (state.activeSettingsTab === "mobile") state.activeSettingsTab = "account";
  if (!document.querySelector(`[data-settings-tab="${state.activeSettingsTab}"]`)) {
    state.activeSettingsTab = "account";
  }
  const cloudSignedIn = Boolean(state.runtime?.cloud?.enabled);
  els.appShell?.setAttribute("data-auth-state", cloudSignedIn ? "signed-in" : "signed-out");
  if (!cloudSignedIn) {
    requestSignedOutOnboardingWindow();
    state.activeView = "chat";
    state.botMenuOpen = false;
    state.contactMenuOpen = false;
  }
  if (state.activeView !== "chat") state.chatConversationMenuOpen = false;
  syncNarrowLayout();
  els.conversationSidebar?.classList.toggle("hidden", state.activeView !== "chat");
  els.contactsSidebar?.classList.toggle("hidden", state.activeView !== "contacts");
  const sidebarBottomLayout = state.navLayout === "sidebar-bottom";
  els.exploreSidebar?.classList.toggle("hidden", !(sidebarBottomLayout && (state.activeView === "bot-store" || state.activeView === "skills")));
  els.taskSidebar?.classList.toggle("hidden", !(sidebarBottomLayout && state.activeView === "tasks"));
  els.settingsSidebar?.classList.toggle("hidden", state.activeView !== "settings");
  els.chatView.classList.toggle("hidden", state.activeView !== "chat");
  els.contactsView?.classList.toggle("hidden", state.activeView !== "contacts");
  els.skillsView?.classList.toggle("hidden", state.activeView !== "skills");
  els.botStoreView?.classList.toggle("hidden", state.activeView !== "bot-store");
  els.tasksView?.classList.toggle("hidden", state.activeView !== "tasks");
  els.settingsView?.classList.toggle("hidden", state.activeView !== "settings");
  els.appShell?.setAttribute("data-active-view", state.activeView);
  els.appShell?.setAttribute("data-layout", legacyGridLayoutForView(state.activeView));
  els.appShell?.setAttribute("data-shell-layout", state.shellLayout);
  syncNavLayoutState();
  syncSidebarCollapseState();
  syncExploreSidebarState();
  syncTaskSidebarState();
  els.discoverModeToggle?.querySelectorAll("[data-discover-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.discoverMode === state.activeView);
  });
  if (typeof syncDiscoverModeIndicator === "function") syncDiscoverModeIndicator();
  els.profileDialog?.classList.toggle("hidden", !state.profileDialogOpen);
  els.profileDialog?.classList.toggle("is-open", state.profileDialogOpen);
  els.userAvatar?.setAttribute("aria-expanded", state.profileDialogOpen ? "true" : "false");
  els.botCreateMenu?.classList.toggle("hidden", !state.botMenuOpen);
  els.contactCreateMenu?.classList.toggle("hidden", !state.contactMenuOpen);
  els.newPersona?.setAttribute("aria-expanded", state.botMenuOpen ? "true" : "false");
  els.newPersona?.classList.toggle("active", state.botMenuOpen);
  els.newContact?.setAttribute("aria-expanded", state.contactMenuOpen ? "true" : "false");
  els.newContact?.classList.toggle("active", state.contactMenuOpen);
  // Contacts unread = number of pending incoming friend requests.
  const incomingCount = window.miaSocial?.moduleState?.incomingRequests?.length || 0;
  if (els.contactsUnreadBadge) {
    if (incomingCount > 0) {
      els.contactsUnreadBadge.classList.remove("hidden");
      els.contactsUnreadBadge.textContent = window.miaUnread.unreadBadgeText(incomingCount);
    } else {
      els.contactsUnreadBadge.classList.add("hidden");
    }
  }
  if (els.sidebarExploreUnreadBadge) {
    if (incomingCount > 0) {
      els.sidebarExploreUnreadBadge.classList.remove("hidden");
      els.sidebarExploreUnreadBadge.textContent = window.miaUnread.unreadBadgeText(incomingCount);
    } else {
      els.sidebarExploreUnreadBadge.classList.add("hidden");
    }
  }
  syncDiscoverModeUnread(incomingCount);
  // Chat unread = total unread DM/group conversation messages.
  const conversationUnread = window.miaSocial?.getTotalConversationUnread?.() || 0;
  if (els.chatUnreadBadge) {
    if (conversationUnread > 0) {
      els.chatUnreadBadge.classList.remove("hidden");
      els.chatUnreadBadge.textContent = window.miaUnread.unreadBadgeText(conversationUnread);
    } else {
      els.chatUnreadBadge.classList.add("hidden");
    }
  }
  if (els.sidebarChatUnreadBadge) {
    if (conversationUnread > 0) {
      els.sidebarChatUnreadBadge.classList.remove("hidden");
      els.sidebarChatUnreadBadge.textContent = window.miaUnread.unreadBadgeText(conversationUnread);
    } else {
      els.sidebarChatUnreadBadge.classList.add("hidden");
    }
  }
  const tasksUnreadTotal = [...(state.tasksUnread?.values?.() || [])].reduce((sum, count) => sum + (Number(count) || 0), 0);
  if (els.sidebarTasksUnreadBadge) {
    if (tasksUnreadTotal > 0) {
      els.sidebarTasksUnreadBadge.classList.remove("hidden");
      els.sidebarTasksUnreadBadge.textContent = window.miaUnread.unreadBadgeText(tasksUnreadTotal);
    } else {
      els.sidebarTasksUnreadBadge.classList.add("hidden");
    }
  }
  els.botDialog?.classList.toggle("hidden", !state.botDialogOpen);
  els.petGenerateDialog?.classList.toggle("hidden", !state.petGenerateOpen);
  els.avatarCropDialog?.classList.toggle("hidden", !state.avatarCropEditor.open);
  window.miaBotManager.renderBotContextMenu();
  window.miaPetDialog?.renderPetGenerateDialog();
  window.miaPetDialog?.renderPetJobs();
  document.querySelectorAll("[data-view]").forEach((button) => {
    // 联系人 图标在「联系人」和「发现 AI 助手」两个子页下都高亮
    const active = button.dataset.view === state.activeView
      || (button.dataset.view === "contacts" && state.activeView === "bot-store");
    button.classList.toggle("active", active);
  });
  els.openSettings?.classList.toggle("active", state.activeView === "settings");
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsTab === state.activeSettingsTab);
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.settingsPanel !== state.activeSettingsTab);
  });
  window.miaSettingsMemory?.renderMemorySettings?.();
  if (state.activeView === "settings" && state.activeSettingsTab === "memory") {
    const memoryPanel = state.settingsMemory || {};
    if (!memoryPanel.loaded && !memoryPanel.loading) {
      window.miaSettingsMemory?.loadMemorySettings?.();
    }
  }
  window.miaSkillLibrary.renderSkillLibrary();
  window.miaBotManager.renderContacts();
  window.miaTasksPanel?.renderTaskView();
}

function openSettingsView(tab = state.activeSettingsTab) {
  state.activeView = "settings";
  if (tab === "profile") tab = "appearance";
  if (tab === "runtime") tab = "model";
  if (tab === "mobile") tab = "account";
  if (tab) state.activeSettingsTab = tab;
  state.botMenuOpen = false;
  state.contactMenuOpen = false;
  showNarrowContent();
  refreshWorkspaceSetting();
  refreshDaemonControls();
  renderView();
}


function syncTopbarClickCapture() {
  document.body.classList.toggle("topbar-click-capture", Boolean(state.skillContextMenu.open || state.sessionMenuOpen || state.chatConversationMenuOpen));
}

function formatRunTime(ms) {
  if (ms == null) return "—";
  const d = new Date(ms);
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}


async function openEditBotDialog(botKey) {
  try {
    const ownedBot = window.miaBotManager?.botByKey?.(botKey);
    if (!ownedBot || !window.miaBotDirectory?.isCloudIdentityBot?.(ownedBot)) {
      throw new Error("Bot 身份不存在，请重新同步联系人。");
    }
    window.miaBotDialog.openBotDialog(ownedBot, ownedBot.personaText || ownedBot.bio || "");
  } catch (error) {
    appendTransientChat("assistant", `编辑 Bot 失败: ${error.message}`);
  }
}

async function deleteBot(botKey) {
  const bot = window.miaBotManager.botByKey(botKey);
  if (!bot) return;
  if (bot.canDelete === false) return;
  const detail = "这会删除该 Bot，并清理当前账号可管理的配置和会话。";
  const ok = window.confirm(`删除「${bot.name || bot.key}」？\n\n${detail}`);
  if (!ok) return;
  try {
    const result = await window.miaBotCommands.deleteBot({
      state,
      bot,
      api: window.mia,
      social: window.miaSocial,
    });
    if (result.runtime) state.runtime = result.runtime;
    if (!result.deleted) return;
    const bots = window.miaBotManager?.allOwnedBots?.() || [];
    const next = bots[0]?.key || "";
    if (!bots.some((item) => item.key === state.activeKey)) state.activeKey = next;
    if (!bots.some((item) => item.key === state.activeContactKey)) state.activeContactKey = state.activeKey;
    render();
  } catch (error) {
    appendTransientChat("assistant", `删除伙伴失败: ${error.message}`);
    await refreshRuntime();
  }
}

async function deleteSkill(skillId) {
  const skill = state.skillLibrary.skills.find((item) => item.id === skillId);
  if (!skill || skill.source !== "mia") return;
  const label = window.miaSkillHelpers.skillDisplayName(skill);
  if (!window.confirm(`删除本地 Skill「${label}」？\n\n会移除 Mia Runtime skills 目录下对应文件夹。`)) return;
  try {
    const library = await window.mia.deleteSkill(skillId);
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
      window.miaSkillLibrary.closeMarketModal();
    }
  } catch (error) {
    console.error("Failed to delete skill", error);
    window.alert(error.message || "删除 Skill 失败");
  }
  window.miaSkillLibrary.renderSkillLibrary();
}

async function openSkillDirectory(skillId) {
  try {
    await window.mia.openSkillDirectory(skillId);
  } catch (error) {
    console.error("Failed to open skill directory", error);
    window.alert(error.message || "打开 Skill 目录失败");
  }
}

// Messages of the conversation currently open in #chat — sourced from the
// active cloud conversation's cache (index-aligned with what social renders,
// so message-index lookups stay correct). Normalized to the {role, content}
// shape index-based consumers (reply / copy) expect.
function messagesForActive() {
  const social = window.miaSocial;
  const conversationId = social?.getActiveConversationId?.();
  if (!conversationId) return [];
  const cache = social?.moduleState?.messageCache?.get(conversationId);
  return (cache?.messages || []).map((message) => ({
    ...message,
    role: message.sender_kind === SenderKind.Bot
      ? "assistant"
      : (message.sender_kind === SenderKind.System ? "system" : "user"),
    content: message.body_md || ""
  }));
}

function agentInventoryById(runtime) {
  const agents = runtime?.agentInventory?.agents || [];
  return Object.fromEntries(agents.map((agent) => [agent.id, agent]));
}

function shortAgentVersion(agent) {
  const version = String(agent?.version || "").trim();
  if (!version) return "";
  return version.split(/\s+/).slice(0, 2).join(" ");
}

function agentInstallMessageFor(engineId) {
  if (typeof state === "undefined" || !state) return "";
  const id = String(engineId || "").trim();
  if (!id) return "";
  if (state.agentSetupInstallInFlight && state.agentSetupInstallEngine === id) {
    return state.agentSetupInstallMessage || "Installing...";
  }
  const errors = state.agentSetupInstallErrors || {};
  if (errors[id]) return String(errors[id]);
  if (id === "hermes" && state.hermesInstallError) return state.hermesInstallError;
  return "";
}

function escapeEngineHtml(value) {
  if (typeof window !== "undefined" && window.miaMarkdown?.escapeHtml) {
    return window.miaMarkdown.escapeHtml(value);
  }
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function installProgressPercentFor(engineId) {
  if (typeof state === "undefined" || !state) return null;
  if (!state.agentSetupInstallInFlight) return null;
  if (state.agentSetupInstallEngine !== engineId) return null;
  const percent = Number(state.agentSetupInstallPercent);
  if (!Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function setEngineStatusText(element, text) {
  if (!element) return;
  const next = String(text || "");
  element.textContent = next;
  element.title = next;
}

function detectedAgentLine(agent, engineId = agent?.id) {
  const installMessage = agentInstallMessageFor(engineId);
  if (installMessage) return installMessage;
  if (!agent) return "未检测到";
  const readiness = agent.readiness || {};
  const readinessText = String(readiness.summary || readiness.detail || "").trim();
  if ((agent.health === "blocked" || readiness.status === "blocked") && readinessText) return readinessText;
  if (readiness.status === "repairable" && readinessText) return readinessText;
  if (agent.usableInMia) {
    const parts = [agent.path || "已接入 Mia", shortAgentVersion(agent)].filter(Boolean);
    return parts.join(" · ");
  }
  if (agent.installed && agent.detectionOnly) return "已就绪";
  if (agent.installed) return "已检测到 · 当前不可直接用于 Mia";
  if (agent.installable) return "未检测到 · 可安装";
  return "未检测到";
}

function legacyAgentStatus(id, legacy) {
  if (!legacy) return null;
  const installed = Boolean(legacy.installed ?? legacy.available);
  const detectionOnly = Boolean(legacy.detectionOnly);
  const usableInMia = legacy.usableInMia === undefined
    ? Boolean(legacy.available && !detectionOnly)
    : Boolean(legacy.usableInMia);
  return { id, ...legacy, installed, detectionOnly, usableInMia };
}

function hermesDetectionLine(runtime, hermes) {
  const installMessage = agentInstallMessageFor("hermes");
  if (installMessage) return installMessage;
  if (hermes) {
    if (hermes.usableInMia || hermes.installed) return detectedAgentLine(hermes);
    return "未检测到 · 可安装官方 Hermes";
  }
  const legacySource = String(runtime?.engineSource || "");
  const legacyUsable = Boolean(
    runtime?.engineInstalled
    || ["bundled", "managed", "local-source", "maintained-local-source", "system"].includes(legacySource)
  );
  return legacyUsable ? "已接入 Mia" : "未检测到 · 可安装官方 Hermes";
}

function renderHermesInstallState(runtime = state.runtime) {
  const installMessage = agentInstallMessageFor("hermes");
  if (installMessage) return installMessage;
  const hermes = runtime?.agentInventory?.agents?.find((agent) => agent.id === "hermes");
  if (state.hermesInstallError) return state.hermesInstallError;
  if (!hermes) return "";
  if (hermes.health === "broken") return "官方 Hermes 状态异常，可修复。";
  if (hermes.source === "system" && !hermes.usableInMia) return "检测到 Hermes，但当前安装方式暂不能用于 Mia。";
  return "";
}

function hermesSetupAction(runtime = state.runtime) {
  const hermes = runtime?.agentInventory?.agents?.find((agent) => agent.id === "hermes");
  if (hermes?.installAction === "repair-hermes" || hermes?.health === "broken") {
    return { action: "repair-hermes", label: "修复官方 Hermes" };
  }
  if (state.hermesInstallError) {
    return { action: "retry-install-hermes", label: "重试安装官方 Hermes" };
  }
  return { action: "install-hermes", label: "安装官方 Hermes" };
}

function agentInstallLabel(agent) {
  if (!agent) return "安装";
  if (agent.id === "hermes") {
    if (agent.health === "broken" || agent.installAction === "repair-hermes") return "修复官方 Hermes";
    return "安装官方 Hermes";
  }
  if (agent.installed && !agent.usableInMia) return `修复 ${agent.label || agent.id}`;
  return `安装 ${agent.label || agent.id}`;
}

function agentInstallAction(agent) {
  if (!agent) return null;
  if (agent.id === "hermes" && (agent.health === "broken" || agent.installAction === "repair-hermes")) {
    return { action: "repair-hermes", label: agentInstallLabel(agent), engineId: "hermes" };
  }
  if (agent.usableInMia) return null;
  if (agent.installed && agent.installAction) {
    return { action: agent.installAction, label: agentInstallLabel(agent), engineId: agent.id };
  }
  if (agent.id === "hermes" && (agent.installable || agent.installAction)) {
    const action = agent.health === "broken" || agent.installAction === "repair-hermes"
      ? "repair-hermes"
      : "install-hermes";
    return { action, label: agentInstallLabel(agent), engineId: "hermes" };
  }
  if (agent.installable && agent.installAction) {
    return { action: agent.installAction, label: agentInstallLabel(agent), engineId: agent.id };
  }
  return null;
}

function engineRowActionElement(engineId) {
  if (!els) return null;
  if (engineId === "hermes") return els.engineRowHermesActions;
  if (engineId === "claude-code") return els.engineRowClaudeActions;
  if (engineId === "codex") return els.engineRowCodexActions;
  if (engineId === "openclaw") return els.engineRowOpenClawActions;
  return null;
}

function renderEngineInstallProgress(engineId) {
  const percent = installProgressPercentFor(engineId);
  if (percent === null) return "";
  const width = Math.max(4, percent);
  return `
    <span class="engine-install-progress" aria-label="安装进度 ${percent}%">
      <span class="engine-install-progress-track" aria-hidden="true">
        <span style="width: ${width}%"></span>
      </span>
      <span class="engine-install-progress-text">${percent}%</span>
    </span>
  `;
}

function renderEngineRowAction(engineId, action) {
  const target = engineRowActionElement(engineId);
  if (!target) return;
  if (!action) {
    target.innerHTML = "";
    return;
  }
  const installing = Boolean(typeof state !== "undefined" && state?.agentSetupInstallInFlight);
  const isCurrentInstall = installing && state?.agentSetupInstallEngine === engineId;
  const percent = installProgressPercentFor(engineId);
  const label = isCurrentInstall
    ? `安装中${percent === null ? "..." : ` ${percent}%`}`
    : action.label;
  target.innerHTML = `
    <span class="engine-action-stack">
      <button class="engine-install-action row" type="button"
        data-engine-settings-install="${escapeEngineHtml(action.engineId)}"
        data-setup-action="${escapeEngineHtml(action.action)}"
        data-engine="${escapeEngineHtml(action.engineId)}"${installing ? " disabled" : ""}${isCurrentInstall ? ' aria-busy="true"' : ""}>${escapeEngineHtml(label)}</button>
      ${isCurrentInstall ? renderEngineInstallProgress(engineId) : ""}
    </span>
  `;
}

function hermesCanConfigure(runtime, hermes = runtime?.agentInventory?.agents?.find((agent) => agent.id === "hermes")) {
  if (hermes) return Boolean(hermes.usableInMia);
  const legacySource = String(runtime?.engineSource || "");
  return Boolean(
    runtime?.engineInstalled
    || ["bundled", "managed", "local-source", "maintained-local-source", "system"].includes(legacySource)
  );
}

function syncHermesConfigAvailability(runtime, hermes) {
  const row = els.engineRowHermesButton;
  const canConfigure = hermesCanConfigure(runtime, hermes);
  if (row) {
    row.classList?.toggle("config-disabled", !canConfigure);
    row.setAttribute?.("aria-disabled", canConfigure ? "false" : "true");
    if ("tabIndex" in row) row.tabIndex = canConfigure ? 0 : -1;
  }
  if (!canConfigure && els.modelForm) {
    row?.setAttribute?.("aria-expanded", "false");
    if (typeof window !== "undefined" && window.miaAccordion?.setElementOpen) window.miaAccordion.setElementOpen(els.modelForm, false);
    else els.modelForm.classList.toggle("hidden", true);
  }
}

function renderEngineInstallActions(runtime) {
  const inventory = agentInventoryById(runtime);
  for (const engineId of ["hermes", "claude-code", "codex", "openclaw"]) {
    renderEngineRowAction(engineId, agentInstallAction(inventory[engineId]));
  }
  if (els.engineInstallActions) {
    els.engineInstallActions.classList?.add?.("hidden");
    els.engineInstallActions.innerHTML = "";
  }
}

function renderEngineDetection(runtime) {
  const engines = runtime?.agentEngines || {};
  const inventory = agentInventoryById(runtime);

  if (els.engineRowHermes) {
    setEngineStatusText(els.engineRowHermes, hermesDetectionLine(runtime, inventory.hermes));
  }
  syncHermesConfigAvailability(runtime, inventory.hermes);

  if (els.engineRowClaude) {
    setEngineStatusText(els.engineRowClaude, detectedAgentLine(
      inventory["claude-code"] || legacyAgentStatus("claude-code", engines.claudeCode),
      "claude-code"
    ));
  }

  if (els.engineRowCodex) {
    setEngineStatusText(els.engineRowCodex, detectedAgentLine(inventory.codex || legacyAgentStatus("codex", engines.codex), "codex"));
  }

  if (els.engineRowOpenClaw) {
    setEngineStatusText(els.engineRowOpenClaw, detectedAgentLine(
      inventory.openclaw || legacyAgentStatus("openclaw", engines.openClaw),
      "openclaw"
    ));
  }

  renderEngineInstallActions(runtime);
}

function renderSessionMenu() {
  if (!els.sessionMenu || !els.sessionList) return;
  els.sessionMenu.classList.toggle("hidden", !state.sessionMenuOpen);
  syncTopbarClickCapture();
  const cloudConversation = activeCloudConversationForSessionMenu();
  if (cloudConversation) {
    renderCloudConversationSessionMenu(cloudConversation);
    return;
  }
  // Cloud-only: with no active conversation the menu is empty.
  els.newSession?.classList.add("hidden");
  els.sessionList.innerHTML = "";
  updateCurrentSessionTitle("新对话");
}

function activeCloudConversationForSessionMenu() {
  const social = window.miaSocial;
  const conversationId = social?.getActiveConversationId?.();
  if (!conversationId) return null;
  return social?.getConversationById?.(conversationId) || null;
}

function cloudConversationSortTime(conversation) {
  return sessionHistory.conversationSortTime(conversation, window.miaSocial?.moduleState?.messageCache);
}

function cloudSessionTitle(conversation) {
  return sessionHistory.sessionTitle(conversation, {
    bots: window.miaBotManager?.allOwnedBots?.() || [],
    defaultTitle: "新对话",
    groupTitle: "群聊",
    dmTitleFallback: "私聊"
  });
}

function cloudSessionConversationsForConversation(conversation) {
  return sessionHistory.sessionConversationsForConversation(conversation, window.miaSocial?.moduleState?.conversations || [], {
    messageCache: window.miaSocial?.moduleState?.messageCache,
    activeConversationId: window.miaSocial?.getActiveConversationId?.()
  });
}

async function renameCloudSessionConversation(conversation) {
  const title = window.prompt("重命名这个会话", cloudSessionTitle(conversation));
  if (!title || !title.trim()) return;
  const response = await window.mia.social.updateConversation(conversation.id, { name: title.trim() });
  if (!response?.ok) {
    alert(`重命名失败：${response?.error || "未知错误"}`);
    return;
  }
  window.miaSocial?.upsertBotConversation?.(response.data?.conversation || response.conversation || { ...conversation, name: title.trim() });
}

async function selectCloudSessionConversation(conversation, { skipMessageLoad = false } = {}) {
  if (!conversation?.id) return;
  window.miaSocial?.setActiveConversationId?.(conversation.id);
  state.sessionMenuOpen = false;
  state.replyDraft = null;
  state.forceScrollToBottom = true;
  const cache = window.miaSocial?.moduleState?.messageCache;
  if (cache && !cache.has(conversation.id)) cache.set(conversation.id, { messages: [], maxSeq: 0 });
  // A freshly created session has no messages yet, so skip the (network)
  // listConversationMessages round-trip — the empty cache set above is correct.
  if (skipMessageLoad) {
    render();
    return;
  }
  try {
    const res = await window.mia.social.listConversationMessages(conversation.id, 0, 100);
    const messages = (res?.ok ? res.data?.messages : res?.messages) || [];
    const ordered = messages.slice().sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
    const maxSeq = ordered.reduce((max, msg) => Math.max(max, Number(msg.seq) || 0), 0);
    cache?.set(conversation.id, { messages: ordered, maxSeq });
  } catch (error) {
    console.warn("[renderer] cloud session messages load failed:", error?.message || error);
  }
  render();
}

function renderCloudConversationSessionMenu(activeConversation) {
  const conversations = cloudSessionConversationsForConversation(activeConversation);
  const activeId = activeConversation.id;
  const canCreate = sessionHistory.canCreateSession(activeConversation);
  updateCurrentSessionTitle(cloudSessionTitle(activeConversation));
  els.newSession?.classList.toggle("hidden", !canCreate);
  els.sessionList.innerHTML = "";
  for (const conversation of conversations) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `session-row${conversation.id === activeId ? " active" : ""}`;
    row.innerHTML = `
      <span>
        <strong>${window.miaMarkdown.escapeHtml(cloudSessionTitle(conversation))}</strong>
        <small>${window.miaMarkdown.escapeHtml(new Date(cloudConversationSortTime(conversation) || Date.now()).toLocaleString())}</small>
      </span>
      <em title="重命名" data-cloud-session-edit="${window.miaMarkdown.escapeHtml(conversation.id)}">${window.miaMarkdown.iconParkIcon("edit", "session-row-edit-icon")}</em>
    `;
    row.addEventListener("click", async (event) => {
      const editTarget = event.target.closest("[data-cloud-session-edit]");
      if (editTarget) {
        event.stopPropagation();
        await renameCloudSessionConversation(conversation);
      } else {
        await selectCloudSessionConversation(conversation);
      }
      render();
    });
    els.sessionList.appendChild(row);
  }
}

function updateCurrentSessionTitle(title) {
  if (!els.currentSessionTitle) return;
  const next = title || "新对话";
  if ((els.currentSessionTitle.dataset?.slotTextValue || els.currentSessionTitle.textContent) === next) return;
  setAnimatedText(els.currentSessionTitle, next, { direction: "up", stagger: 18, duration: 240 });
  els.currentSessionTitle.classList.remove("title-updated");
  requestAnimationFrame(() => els.currentSessionTitle.classList.add("title-updated"));
}

// Once the bot has actually replied, summarize the opening exchange into a
// title (reusing the same engine title generator the old local path used) and
// rename the conversation. Stable bot conversations may initially be named
// after the bot itself, so treat that the same as "新对话".
async function maybeGenerateCloudConversationTitle(conversationId) {
  const social = window.miaSocial;
  if (!conversationId || !social) return;
  const conversation = social.getConversationById?.(conversationId);
  if (!conversation || conversationTypeForComposer(conversation, conversationId) !== "bot") return;
  if (!sessionHistory.isUntitledBotConversation(conversation, {
    bots: window.miaBotManager?.allOwnedBots?.() || [],
    defaultTitle: "新对话"
  })) return;
  if (state.generatingTitleIds.has(conversationId)) return;
  const cache = social.moduleState?.messageCache?.get(conversationId);
  const msgs = (cache?.messages || []).filter((message) => message.body_md && !message._localPending);
  const hasUser = msgs.some((message) => message.sender_kind === SenderKind.User);
  const hasBot = msgs.some((message) => message.sender_kind === SenderKind.Bot);
  if (!hasUser || !hasBot) return;
  state.generatingTitleIds.add(conversationId);
  try {
    const titleMessages = msgs.slice(0, 4).map((message) => ({
      role: message.sender_kind === SenderKind.Bot ? "assistant" : "user",
      content: message.body_md
    }));
    const result = await window.mia.generateConversationTitle({
      botKey: botKeyForConversation(conversation),
      conversationId,
      messages: titleMessages
    });
    const title = String(result?.title || "").trim();
    if (!title || title === "新对话") return;
    const res = await window.mia.social.updateConversation(conversationId, { name: title });
    if (res?.ok && (res.data?.conversation || res.conversation)) social.upsertBotConversation?.(res.data?.conversation || res.conversation);
    renderSessionMenu();
  } catch (error) {
    console.warn("[title] cloud conversation title generation failed:", error?.message || error);
  } finally {
    state.generatingTitleIds.delete(conversationId);
  }
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
         来自定时任务「${window.miaMarkdown.escapeHtml(taskMeta.title)}」 ·
         ${window.miaMarkdown.escapeHtml(formatRunTime(typeof firedAt === "string" ? new Date(firedAt).getTime() : firedAt))} ·
         <button class="link" type="button" data-jump-task="${window.miaMarkdown.escapeHtml(taskMeta.id)}">打开任务</button>
       </div>`
    : "";
  const userAvatarSpec = window.miaAvatarResolve.resolveAvatarForContact({
    id: state.runtime?.cloud?.user?.id || user.id || user.username || user.displayName || "self",
    displayName: user.displayName || user.username || "你",
    avatarImage: user.avatarImage || "",
    avatarCrop: user.avatarCrop || null,
    color: user.avatarColor || user.avatar_color || user.color || ""
  });
  const botAvatarSpec = window.miaAvatarResolve.resolveAvatarForContact({
    id: botAvatarIdentityId(persona?.key || persona?.id || "assistant", persona || {}),
    displayName: persona?.name || "Assistant",
    avatarImage: persona?.avatarImage || "",
    avatarCrop: persona?.avatarCrop || null,
    color: persona?.color || persona?.avatarColor || persona?.avatar_color || ""
  });
  const activeAvatarSpec = message.role === "assistant" ? botAvatarSpec : userAvatarSpec;
  const timeHtml = renderMessageTime(message.createdAt);
  const bodyHtml = String(message.content || "").trim() ? window.miaMarkdown.renderMarkdown(message.content) : "";
  const commandResultHtml = message.role === "assistant" ? renderCommandResultHtml(message.commandResult) : "";
  const replyHtml = window.miaMessageHelpers.replyQuoteHtml(message.replyTo);
  const translation = window.miaMessageMenu?.translationHtml(message, messageIndex) || "";
  const attachmentHtml = renderAttachmentChips([...(message.attachments || []), ...generatedAttachmentsForMessage(message)].map(hydrateAttachmentPreview));
  const pinnedHtml = message.pinned ? `<span class="message-pin-badge">${ICON_PARK_PIN_SVG}置顶</span>` : "";
  let contentBlocks = [];
  if (message.role === "assistant") {
    let rawBlocks = message.contentBlocks || message.content_blocks || message.content_blocks_json || [];
    if (typeof rawBlocks === "string" && rawBlocks.trim()) {
      try { rawBlocks = JSON.parse(rawBlocks); } catch { rawBlocks = []; }
    }
    const normalizer = window.miaAssistantContentBlocks;
    contentBlocks = normalizer && typeof normalizer.normalizeContentBlocks === "function"
      ? normalizer.normalizeContentBlocks(rawBlocks)
      : (Array.isArray(rawBlocks) ? rawBlocks.filter((block) => block && typeof block === "object") : []);
    if (contentBlocks.length && normalizer && typeof normalizer.contentBlocksWithFinalText === "function") {
      contentBlocks = normalizer.contentBlocksWithFinalText(contentBlocks, message.content || "");
    }
  }
  let renderedFirstTextBlock = false;
  const orderedBlocksHtml = contentBlocks.length && window.miaTraceBlocks?.renderAssistantContentBlocks
    ? window.miaTraceBlocks.renderAssistantContentBlocks({
      blocks: contentBlocks,
      expanded: false,
      scopeKey: `msg:${message.createdAt || ""}`,
      renderTextBlock(block) {
        const prefixHtml = renderedFirstTextBlock ? "" : `${attachmentHtml}${pinnedHtml}${replyHtml}`;
        renderedFirstTextBlock = true;
        const blockBodyHtml = String(block.text || "").trim() ? window.miaMarkdown.renderMarkdown(block.text) : "";
        return `<div class="bubble${message.pinned ? " pinned" : ""}" data-message-index="${messageIndex}">${prefixHtml}${blockBodyHtml}</div>`;
      }
    })
    : "";
  const traceHtml = message.role === "assistant" && !orderedBlocksHtml
    ? window.miaTraceBlocks.renderTraceBlocks({
      reasoning: message.reasoning,
      tools: message.tools,
      content: message.content,
      expanded: false,
      scopeKey: `msg:${message.createdAt || ""}`
    })
    : "";
  const roleClass = message.role === "user" ? "user" : "assistant";
  // Tag the avatar so the same app.js handlers fire here as in cloud DM /
  // group bubbles: left-click → contact card, right-click → dropdown. In a
  // local bot session the AI avatar opens its editable 模型/推理强度/权限
  // card; the user avatar opens the self card. (一视同仁 across all chats.)
  const senderKind = message.role === "assistant" ? "bot" : "user";
  const senderRef = message.role === "assistant"
    ? (persona?.key || "")
    : (state.runtime?.cloud?.user?.id || "");
  const avatarTitle = message.role === "assistant" ? (persona?.name || "") : (user.displayName || "");
  const avatarHtml = window.miaAvatar.avatarHtml({
    className: "avatar message-avatar",
    image: activeAvatarSpec.image,
    crop: activeAvatarSpec.crop,
    color: activeAvatarSpec.color || "#111827",
    text: activeAvatarSpec.image ? "" : activeAvatarSpec.text,
    attrs: `data-sender-kind="${senderKind}" data-sender-ref="${window.miaMarkdown.escapeHtml(senderRef)}" title="${window.miaMarkdown.escapeHtml(avatarTitle)}"`
  });
  const orderedBlocksWithAttachments = orderedBlocksHtml && !renderedFirstTextBlock && attachmentHtml
    ? `<div class="bubble${message.pinned ? " pinned" : ""}" data-message-index="${messageIndex}">${attachmentHtml}${pinnedHtml}${replyHtml}</div>${orderedBlocksHtml}`
    : orderedBlocksHtml;
  const defaultBubbleHtml = `<div class="bubble${message.pinned ? " pinned" : ""}" data-message-index="${messageIndex}">${attachmentHtml}${pinnedHtml}${replyHtml}${bodyHtml}${commandResultHtml}${translation}</div>`;
  return `<article class="message ${roleClass}">
      ${avatarHtml}
      <div class="message-stack">${taskAffordanceHtml}${traceHtml}${orderedBlocksWithAttachments || defaultBubbleHtml}${orderedBlocksHtml ? `${commandResultHtml}${translation}` : ""}${timeHtml}</div>
    </article>`;
}

function renderCommandResultHtml(commandResult) {
  if (!commandResult || commandResult.type !== "session-list" || !Array.isArray(commandResult.rows)) return "";
  const engine = String(commandResult.engine || "");
  const sourceDeviceId = String(commandResult.sourceDeviceId || "");
  const currentDeviceId = String(state.runtime?.cloud?.deviceId || "");
  const isForeignDeviceList = Boolean(sourceDeviceId && currentDeviceId && sourceDeviceId !== currentDeviceId);
  const rows = commandResult.rows.slice(0, 10).map((row) => {
    const title = String(row.title || row.id || "Session");
    const preview = String(row.preview || row.project || row.id || "");
    const project = String(row.project || "");
    const previewText = isForeignDeviceList
      ? `${preview || row.id || ""} · 来自另一台设备，请重新发送 /resume`
      : (preview || project || row.id || "");
    const updatedAt = Number(row.updatedAt) || 0;
    const time = updatedAt ? formatConversationTime(new Date(updatedAt).toISOString()) : "";
    return `
      <button class="command-session-row" type="button" data-command-resume-engine="${window.miaMarkdown.escapeHtml(engine)}" data-command-resume-id="${window.miaMarkdown.escapeHtml(row.id || "")}" data-command-source-device-id="${window.miaMarkdown.escapeHtml(sourceDeviceId)}"${isForeignDeviceList ? " disabled title=\"这条列表来自另一台设备，请在当前设备重新发送 /resume\"" : ""}>
        <span class="command-session-main">
          <strong>${window.miaMarkdown.escapeHtml(title)}</strong>
          <small>${window.miaMarkdown.escapeHtml(previewText)}</small>
        </span>
        <span class="command-session-side">${window.miaMarkdown.escapeHtml(time)}</span>
      </button>
    `;
  }).join("");
  return `<div class="command-result session-list">${rows}</div>`;
}

let signedOutOnboardingRequested = false;
function requestSignedOutOnboardingWindow() {
  if (signedOutOnboardingRequested) return;
  signedOutOnboardingRequested = true;
  const task = window.mia?.window?.signedOutOnboarding?.();
  if (task && typeof task.catch === "function") {
    task.catch(() => { signedOutOnboardingRequested = false; });
  }
}

function hasUsableLocalAgent(runtime = state.runtime) {
  const inventory = runtime?.agentInventory;
  if (inventory?.summary) return Boolean(inventory.summary.hasUsableAgent);
  const engines = runtime?.agentEngines || {};
  return Boolean(runtime?.engineInstalled || engines.claudeCode?.available || engines.codex?.available);
}

function renderNoAgentGuide() {
  const hermesState = renderHermesInstallState();
  const hermesAction = hermesSetupAction();
  return `
    <div class="no-agent-guide">
      <h2>本机 Agent 尚未连接</h2>
      <p>要开始本机聊天，请安装官方 Hermes 或配置已有 Agent。</p>
      ${hermesState ? `<p>${window.miaMarkdown.escapeHtml(hermesState)}</p>` : ""}
      <div class="setup-actions">
        <button type="button" class="primary" data-setup-action="${hermesAction.action}">${window.miaMarkdown.escapeHtml(hermesAction.label)}</button>
        <button type="button" class="secondary" data-setup-action="open-agent-settings">查看本机引擎</button>
      </div>
    </div>
  `;
}

function renderChat() {
  const activeConversationId = window.miaSocial?.getActiveConversationId?.();
  let onboardingWindow = false;
  if (activeConversationId) {
    setOnboardingWindow(false);
    if (window.miaSocial && typeof window.miaSocial.renderConversationChat === "function") {
      window.miaSocial.renderConversationChat(els.chat);
    }
    return;
  }
  const messages = [];
  if (window.miaSetupGuide?.shouldShowSetupGuide?.({ messages })) {
    onboardingWindow = true;
    setOnboardingWindow(true);
    els.chat.innerHTML = window.miaSetupGuide.renderSetupGuide();
    window.miaLottieIcons?.init?.(els.chat);
    return;
  }
  setOnboardingWindow(onboardingWindow);
  if (state.agentSetupSkipped && !hasUsableLocalAgent()) {
    els.chat.innerHTML = renderNoAgentGuide();
    return;
  }
  if (state.runtime?.cloud?.enabled) {
    els.chat.innerHTML = "";
    return;
  }
  requestSignedOutOnboardingWindow();
  els.chat.innerHTML = "";
}

function conversationTypeForComposer(conversation, conversationId = "") {
  return sessionHistory.conversationType(conversation, conversationId);
}

function botKeyForConversation(conversation) {
  return sessionHistory.botId(conversation);
}

function runtimeKindForBotConversation(conversation) {
  return sessionHistory.runtimeKind(conversation, "desktop-local");
}

function activeConversationBotContext() {
  const social = window.miaSocial;
  const conversationId = social?.getActiveConversationId?.();
  if (!conversationId) return null;
  const conversation = social?.getConversationById?.(conversationId) || { id: conversationId };
  if (conversationTypeForComposer(conversation, conversationId) !== "bot") return null;
  const botKey = botKeyForConversation(conversation);
  if (!botKey) return null;
  return {
    conversation,
    conversationId,
    botKey,
    runtimeKind: runtimeKindForBotConversation(conversation)
  };
}

// Composer "使用": attach the skill to the conversation the user is currently
// viewing in the messages page — no bot picker. Returns false when there is
// no active bot conversation so the caller can prompt the user to open one.
function useSkillInActiveConversation(skill) {
  if (!skill || !skill.id) return false;
  if (!activeConversationBotContext()) return false;
  state.activeView = "chat";
  showNarrowContent();
  window.miaComposer?.addComposerSkill?.({ id: String(skill.id), name: skill.name || skill.id });
  render();
  return true;
}
window.miaUseSkillInActiveConversation = useSkillInActiveConversation;

// Cloud session expired/invalid (a cloud call came back 401). The token is in
// the runtime so cloud.enabled stays true and the app looks "logged in" while
// every call silently fails. Clear it and re-render so the cloud-only shell
// falls back to the login guide instead of a stuck, empty screen.
// A single 401 is NOT proof the token is dead — cloud deploys/restarts can
// answer 401 transiently. Confirm with a fresh /api/me before destroying the
// local token; a wrong logout here wipes a perfectly valid session.
let cloudAuthExpiredHandling = false;
async function handleCloudAuthExpired() {
  if (cloudAuthExpiredHandling) return;
  if (!state.runtime?.cloud?.enabled) return;
  cloudAuthExpiredHandling = true;
  try {
    const recheck = await window.mia.social?.myIdentity?.().catch(() => null);
    const confirmedExpired = Boolean(recheck && !recheck.ok && recheck.status === 401);
    if (!confirmedExpired) {
      console.warn("[cloud] ignored transient 401: /api/me recheck did not confirm auth expiry");
      return;
    }
    state.runtime = await window.mia.cloudLogout();
  } catch (error) {
    console.warn("[cloud] auto-logout after auth failure failed:", error?.message || error);
  } finally {
    render();
    setTimeout(() => { cloudAuthExpiredHandling = false; }, 3000);
  }
}

function activeBotRuntimeControlContext() {
  const conversationContext = activeConversationBotContext();
  if (conversationContext) {
    const bots = allOwnedBotsForIdentity();
    const bot = bots.find((item) => (item.key || item.id) === conversationContext.botKey) || {};
    return {
      ...conversationContext,
      bot: {
        ...bot,
        key: conversationContext.botKey,
        id: bot.id || bot.key || conversationContext.botKey,
        runtimeKind: conversationContext.runtimeKind
      }
    };
  }
  const bot = activePersona();
  const botKey = String(bot?.key || bot?.id || "").trim();
  if (!botKey) return null;
  return {
    conversation: null,
    conversationId: "",
    botKey,
    runtimeKind: bot.runtimeKind || bot.runtime_kind || "desktop-local",
    bot: { ...bot, key: botKey }
  };
}

function botRuntimeCacheKey(botKey, runtimeKind = "cloud-claude-code") {
  return window.miaBotCommands.runtimeCacheKey(botKey, runtimeKind);
}

function normalizePlatformModelEntry(entry = {}) {
  const id = String(entry.id || entry.model_name || entry.model || "").trim();
  if (!id) return null;
  const displayLabel = typeof window.miaEngineContracts?.platformModelDisplayLabel === "function"
    ? window.miaEngineContracts.platformModelDisplayLabel(entry, id)
    : (id.toLowerCase() === "mia-auto"
      ? "Auto"
      : String(entry.label || entry.name || entry.displayName || id).trim());
  return {
    id,
    label: displayLabel,
    provider: String(entry.provider || "").trim(),
    upstreamModel: String(entry.upstreamModel || entry.upstream_model || entry.model || "").trim()
  };
}

async function loadPlatformModelCatalog() {
  if (platformModelCatalog.loaded || platformModelCatalog.loading) return platformModelCatalog.entries;
  if (!state.runtime?.cloud?.enabled || typeof window.mia?.social?.listPlatformModels !== "function") return platformModelCatalog.entries;
  platformModelCatalog.loading = true;
  try {
    const response = await window.mia.social.listPlatformModels();
    const models = response?.ok ? response.data?.models : response?.models;
    platformModelCatalog.entries = (Array.isArray(models) ? models : [])
      .map(normalizePlatformModelEntry)
      .filter(Boolean);
    state.platformModels = platformModelCatalog.entries;
    platformModelCatalog.loaded = true;
  } catch (error) {
    console.warn("[renderer] platform model catalog load failed:", error?.message || error);
  } finally {
    platformModelCatalog.loading = false;
  }
  return platformModelCatalog.entries;
}

function platformHermesModelEntries() {
  return platformModelCatalog.entries.length
    ? platformModelCatalog.entries.map((entry) => ({
      ...entry,
      provider: "mia",
      providerLabel: "Mia",
      model: entry.id,
      authType: "mia_account",
      modelProfileId: `mia:${entry.id}`
    }))
    : [{
      id: "mia-auto",
      label: "Auto",
      provider: "mia",
      providerLabel: "Mia",
      model: "mia-auto",
      authType: "mia_account",
      modelProfileId: "mia:mia-auto"
    }];
}

function platformHermesPermissionEntries() {
  return [
    {
      value: "bypassPermissions",
      label: "Sandbox",
      title: "Mia Cloud runs Claude Code with tool permissions allowed inside the server sandbox."
    }
  ];
}

function setComposerSelectOptions(select, entries, selectedValue) {
  if (!select) return "";
  const normalized = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && (entry.id !== undefined || entry.value !== undefined))
    .map((entry) => ({
      value: String(entry.id ?? entry.value),
      label: String(entry.label || entry.id || entry.value),
      title: String(entry.title || ""),
      aliases: Array.isArray(entry.aliases) ? entry.aliases.map((item) => String(item)) : []
    }));
  select.innerHTML = normalized.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = entry.label;
    if (entry.title) option.title = entry.title;
    return option.outerHTML;
  }).join("");
  const value = String(selectedValue || normalized[0]?.value || "");
  const selected = normalized.find((entry) => entry.value === value || entry.aliases.includes(value));
  select.value = selected?.value || normalized[0]?.value || "";
  return select.selectedOptions?.[0]?.textContent || "";
}

let activeComposerSelectMenu = null;

function isCustomSelect(select) {
  return select instanceof HTMLSelectElement && !select.multiple && Number(select.size || 0) <= 1;
}

function composerSelectTrigger(select) {
  return select.closest(".model-switcher, .effort-switcher, .permission-switcher") || select;
}

function composerSelectOptions(select) {
  const entries = [];
  const pushOption = (option, groupDisabled = false) => {
    entries.push({
      type: "option",
      value: option.value,
      label: String(option.label || option.textContent || option.value || "").trim(),
      selected: option.selected,
      disabled: Boolean(option.disabled || groupDisabled)
    });
  };
  Array.from(select?.children || []).forEach((child) => {
    if (child.tagName === "OPTGROUP") {
      const groupOptions = Array.from(child.children || []).filter((option) => option.tagName === "OPTION");
      if (!groupOptions.length) return;
      const label = String(child.label || "").trim();
      if (label) entries.push({ type: "group", label, disabled: Boolean(child.disabled) });
      groupOptions.forEach((option) => pushOption(option, Boolean(child.disabled)));
      return;
    }
    if (child.tagName === "OPTION") pushOption(child);
  });
  return entries;
}

function ensureComposerSelectMenu() {
  let menu = document.getElementById("composerSelectMenu");
  if (menu) return menu;
  menu = document.createElement("div");
  menu.id = "composerSelectMenu";
  menu.className = "composer-select-menu hidden";
  menu.setAttribute("role", "listbox");
  document.body.appendChild(menu);
  return menu;
}

function positionComposerSelectMenu(menu, trigger) {
  const rect = trigger.getBoundingClientRect();
  const viewportPadding = 8;
  const triggerGap = 6;
  const maxWidth = Math.max(150, window.innerWidth - viewportPadding * 2);
  const width = Math.max(150, Math.min(maxWidth, Math.max(rect.width, menu.scrollWidth || rect.width)));
  const left = Math.max(viewportPadding, Math.min(window.innerWidth - width - viewportPadding, rect.left));
  const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding - triggerGap);
  const spaceAbove = Math.max(0, rect.top - viewportPadding - triggerGap);
  const wantedHeight = Math.min(menu.scrollHeight || 0, 320);
  const usefulHeight = Math.min(wantedHeight, 160);
  const openBelow = spaceBelow >= usefulHeight || spaceBelow >= spaceAbove;
  const availableHeight = openBelow ? spaceBelow : spaceAbove;
  menu.style.width = `${width}px`;
  menu.style.maxHeight = `${Math.min(320, Math.max(0, availableHeight))}px`;
  menu.style.left = `${left}px`;
  menu.style.top = openBelow ? `${rect.bottom + triggerGap}px` : "";
  menu.style.bottom = openBelow ? "" : `${window.innerHeight - rect.top + triggerGap}px`;
  menu.dataset.placement = openBelow ? "below" : "above";
}

function closeComposerSelectMenu() {
  const menu = document.getElementById("composerSelectMenu");
  if (menu) {
    menu.classList.add("hidden");
    menu.innerHTML = "";
  }
  activeComposerSelectMenu?.trigger?.classList.remove("select-open");
  activeComposerSelectMenu = null;
}

function chooseComposerSelectOption(select, value) {
  if (!select || select.disabled) return;
  if (select.value !== value) {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  closeComposerSelectMenu();
  select.focus({ preventScroll: true });
}

function openComposerSelectMenu(select) {
  if (!isCustomSelect(select) || select.disabled) return;
  const trigger = composerSelectTrigger(select);
  if (activeComposerSelectMenu?.select === select) {
    closeComposerSelectMenu();
    return;
  }
  closeComposerSelectMenu();
  const menu = ensureComposerSelectMenu();
  const entries = composerSelectOptions(select);
  const options = entries.filter((option) => option.type === "option" && !option.disabled);
  if (!options.length) return;
  const selectedValue = String(select.value || options.find((option) => option.selected)?.value || options[0]?.value || "");
  menu.innerHTML = entries.map((option) => {
    if (option.type === "group") {
      return `<div class="composer-select-group${option.disabled ? " disabled" : ""}">${window.miaMarkdown.escapeHtml(option.label)}</div>`;
    }
    const selected = String(option.value) === selectedValue;
    return `<button class="composer-select-option${selected ? " selected" : ""}" type="button" role="option" aria-selected="${selected ? "true" : "false"}" data-value="${window.miaMarkdown.escapeHtml(option.value)}"${option.disabled ? " disabled" : ""}>${window.miaMarkdown.escapeHtml(option.label)}</button>`;
  }).join("");
  menu.classList.remove("hidden");
  trigger.classList.add("select-open");
  activeComposerSelectMenu = { select, trigger, menu };
  positionComposerSelectMenu(menu, trigger);
  const selectedButton = menu.querySelector(".composer-select-option.selected:not(:disabled)") || menu.querySelector(".composer-select-option:not(:disabled)");
  selectedButton?.scrollIntoView({ block: "nearest" });
}

function currentComposerSelectMenuOption() {
  const menu = activeComposerSelectMenu?.menu;
  if (!menu) return null;
  return menu.querySelector(".composer-select-option.keyboard-active:not(:disabled)")
    || menu.querySelector(".composer-select-option.selected:not(:disabled)")
    || menu.querySelector(".composer-select-option:not(:disabled)");
}

function moveComposerSelectMenuSelection(delta) {
  const menu = activeComposerSelectMenu?.menu;
  if (!menu) return;
  const options = Array.from(menu.querySelectorAll(".composer-select-option:not(:disabled)"));
  if (!options.length) return;
  const current = options.findIndex((button) => button.classList.contains("keyboard-active"));
  const selected = options.findIndex((button) => button.classList.contains("selected"));
  const index = current >= 0 ? current : selected >= 0 ? selected : 0;
  const next = (index + delta + options.length) % options.length;
  options.forEach((button) => button.classList.remove("keyboard-active"));
  options[next].classList.add("keyboard-active");
  options[next].scrollIntoView({ block: "nearest" });
}

async function ensureBotRuntimeBinding(botKey, runtimeKind = "cloud-claude-code") {
  return window.miaBotCommands.getBotRuntimeBinding({
    api: window.mia,
    cache: botRuntimeControlCache,
    botKey,
    runtimeKind
  });
}

function normalizeAgentEngineForRuntime(value) {
  const normalizer = window.miaEngineContracts?.normalizeAgentEngine;
  if (typeof normalizer === "function") return normalizer(value);
  const raw = String(value || "hermes").trim().toLowerCase().replace(/_/g, "-");
  if (raw === "claude" || raw === "claude-code") return "claude-code";
  if (raw === "codex" || raw === "openai-codex") return "codex";
  if (raw === "openclaw" || raw === "open-claw") return "openclaw";
  return "hermes";
}

function strictAgentEngineForRuntime(value = "") {
  const strict = window.miaCloudRuntime?.normalizeAgentEngineStrict?.(value);
  if (strict) return strict;
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (raw === "claude" || raw === "claude-code") return "claude-code";
  if (raw === "codex" || raw === "openai-codex") return "codex";
  if (raw === "openclaw" || raw === "open-claw") return "openclaw";
  if (raw === "hermes") return "hermes";
  return "";
}

function cloudAgentEngineForRuntimeControl(context = activeBotRuntimeControlContext()) {
  const binding = context?.botKey
    ? botRuntimeControlCache.get(botRuntimeCacheKey(context.botKey, context.runtimeKind || "cloud-claude-code"))
    : null;
  const bindingConfig = binding?.config || {};
  const botConfig = context?.bot?.runtimeConfig || context?.bot?.runtime_config || {};
  return strictAgentEngineForRuntime(
    bindingConfig.agentEngine
      || bindingConfig.agent_engine
      || context?.bot?.agentEngine
      || context?.bot?.agent_engine
      || botConfig.agentEngine
      || botConfig.agent_engine
  ) || window.miaCloudRuntime?.cloudAgentRuntimeFromState?.(state)?.agentEngine || "";
}

function agentEngineForRuntimeControl(context = activeBotRuntimeControlContext()) {
  if (context?.runtimeKind === "cloud-claude-code") return cloudAgentEngineForRuntimeControl(context);
  return normalizeAgentEngineForRuntime(
    context?.bot?.agentEngine
      || context?.bot?.agent_engine
      || window.miaEngineOptions.activeAgentEngine()
  );
}

function isExternalAgentEngineForRuntimeControl(engine) {
  return Boolean(window.miaEngineOptions?.isExternalAgentEngine?.(engine));
}

function enginePermissionModeForRuntimeControl(engine, runtime = state.runtime) {
  if (!isExternalAgentEngineForRuntimeControl(engine)) return runtime?.permissions?.mode || "ask";
  return runtime?.permissions?.engines?.[engine] || "default";
}

function modelEntriesForRuntimeControl(context = activeBotRuntimeControlContext()) {
  const engine = agentEngineForRuntimeControl(context);
  if (context?.runtimeKind === "cloud-claude-code") return platformHermesModelEntries();
  if (isExternalAgentEngineForRuntimeControl(engine)) {
    return window.miaEngineOptions.externalModelEntries(engine);
  }
  return window.miaModelSettings.connectedModelEntries(state.runtime);
}

function runtimeConfigForControl(context = activeBotRuntimeControlContext()) {
  if (!context) return {};
  const binding = botRuntimeControlCache.get(botRuntimeCacheKey(context.botKey, context.runtimeKind));
  const botConfig = context.bot?.engineConfig || context.bot?.engine_config || {};
  if (context.runtimeKind === "cloud-claude-code") return { ...botConfig, ...(binding?.config || {}) };
  const engine = agentEngineForRuntimeControl(context);
  const mergedConfig = { ...botConfig, ...(binding?.config || {}) };
  if (isExternalAgentEngineForRuntimeControl(engine)) {
    return {
      ...mergedConfig,
      permissionMode: enginePermissionModeForRuntimeControl(engine)
    };
  }
  if (binding?.config) return mergedConfig;
  const runtimeModel = state.runtime?.model || {};
  return {
    provider: runtimeModel.provider || "",
    model: runtimeModel.model || "",
    effortLevel: state.runtime?.effort?.level || "medium",
    permissionMode: state.runtime?.permissions?.mode || "ask"
  };
}

function modelValueForRuntimeControl(context, entries = [], config = {}) {
  const engine = agentEngineForRuntimeControl(context);
  const provider = String(config.providerConnectionId || config.provider_connection_id || config.provider || "").trim();
  const model = String(config.model || "").trim();
  if (provider === "mia" && model) {
    const entry = entries.find((item) => (item.providerConnectionId || item.provider) === "mia" && (item.model === model || item.id === model || item.value === model));
    return entry?.id || entry?.value || model;
  }
  if (context?.runtimeKind === "cloud-claude-code") return model || entries[0]?.id || entries[0]?.value || "mia-auto";
  if (isExternalAgentEngineForRuntimeControl(engine)) {
    if (!model) return "default";
    const entry = entries.find((item) => item.model === model || item.id === model || item.value === model);
    return entry?.id || entry?.value || model;
  }
  const savedEntry = provider && model
    ? entries.find((item) => (item.providerConnectionId || item.provider) === provider && item.model === model)
    : null;
  const runtimeModel = state.runtime?.model || {};
  return savedEntry?.id
    || savedEntry?.value
    || window.miaModelHelpers.catalogEntryForModel(runtimeModel)?.id
    || entries[0]?.id
    || entries[0]?.value
    || "";
}

function permissionEntriesForRuntimeControl(context = activeBotRuntimeControlContext()) {
  const engine = agentEngineForRuntimeControl(context);
  if (context?.runtimeKind === "cloud-claude-code") return platformHermesPermissionEntries();
  return window.miaEngineOptions.externalPermissionOptions(engine);
}

function setComposerModelAvatar(entry = {}, engine = "hermes") {
  const icon = window.miaModelHelpers.modelIconSrc({
    provider: entry.provider || (engine === "codex" ? "openai-codex" : engine === "claude-code" ? "anthropic" : engine),
    model: entry.model || entry.id || entry.value || ""
  });
  const modelAvatar = document.querySelector(".model-avatar");
  applyComposerModelAvatar(modelAvatar, icon);
}

function syncConversationBotRuntimeControls() {
  const context = activeConversationBotContext();
  if (!context) return false;
  const controlContext = activeBotRuntimeControlContext();
  const config = runtimeConfigForControl(controlContext);
  const engine = agentEngineForRuntimeControl(controlContext);
  const modelEntries = modelEntriesForRuntimeControl(controlContext);
  const selectedModelValue = modelValueForRuntimeControl(controlContext, modelEntries, config);
  const modelLabel = setComposerSelectOptions(els.quickModelSelect, modelEntries, selectedModelValue);
  setText(els.quickModelLabel, modelLabel || "Default");
  const selectedModelEntry = modelEntries.find((entry) => String(entry.id || entry.value || "") === String(els.quickModelSelect?.value || selectedModelValue))
    || modelEntries.find((entry) => String(entry.model || "") === String(config.model || ""))
    || modelEntries[0]
    || {};
  setComposerModelAvatar(selectedModelEntry, engine);
  const effortEntries = window.miaEngineOptions.effortOptions(engine);
  const defaultEffort = effortEntries.find((entry) => entry.value === "medium")?.value || effortEntries[0]?.value || "medium";
  const effortLabel = setComposerSelectOptions(
    els.effortSelect,
    effortEntries,
    config.effortLevel || defaultEffort
  );
  setText(els.effortLabel, effortLabel || "Medium");
  const permissionEntries = permissionEntriesForRuntimeControl(controlContext);
  const permissionLabel = setComposerSelectOptions(
    els.permissionMode,
    permissionEntries,
    config.permissionMode || (context.runtimeKind === "cloud-claude-code" ? "bypassPermissions" : (permissionEntries[0]?.value || "default"))
  );
  setText(els.permissionLabel, permissionLabel || "Ask");
  const permissionSwitcher = els.permissionMode?.closest(".permission-switcher");
  permissionSwitcher?.classList.toggle("yolo", els.permissionMode?.value === "yolo" || els.permissionMode?.value === ":danger-full-access" || (engine !== "claude-code" && els.permissionMode?.value === "bypassPermissions"));
  permissionSwitcher?.classList.toggle("claude-bypass", engine === "claude-code" && els.permissionMode?.value === "bypassPermissions");
  if (els.quickModelSelect) els.quickModelSelect.disabled = false;
  if (els.effortSelect) els.effortSelect.disabled = false;
  if (els.permissionMode) els.permissionMode.disabled = false;
  setText(els.modelSwitchStatus, context.runtimeKind === "cloud-claude-code"
    ? (engine ? "Mia Cloud" : "Mia Cloud · 内核未同步")
    : window.miaEngineContracts?.engineLabel?.(engine) || engine);
  if (!platformModelCatalog.loaded && !platformModelCatalog.loading) {
    loadPlatformModelCatalog().then(() => {
      const latest = activeConversationBotContext();
      if (latest?.conversationId === context.conversationId) render();
    });
  }
  const runtimeCacheKey = botRuntimeCacheKey(context.botKey, context.runtimeKind);
  if (!botRuntimeControlCache.has(runtimeCacheKey)
    && !botRuntimeControlInFlight.has(runtimeCacheKey)) {
    botRuntimeControlInFlight.add(runtimeCacheKey);
    ensureBotRuntimeBinding(context.botKey, context.runtimeKind)
      .then(() => {
        const latest = activeConversationBotContext();
        if (latest?.conversationId === context.conversationId) render();
      })
      .catch((error) => {
        setText(els.modelSwitchStatus, "运行配置读取失败");
        console.warn("[renderer] bot runtime load failed:", error?.message || error);
      })
      .finally(() => {
        botRuntimeControlInFlight.delete(runtimeCacheKey);
      });
  }
  return true;
}

function setRuntimeControlDisabled(disabled) {
  if (els.quickModelSelect) els.quickModelSelect.disabled = disabled;
  if (els.effortSelect) els.effortSelect.disabled = disabled;
  if (els.permissionMode) els.permissionMode.disabled = disabled;
}

async function saveActiveBotRuntimeControl(field, value, pendingText, successText, errorPrefix, modelEntries = []) {
  const context = activeBotRuntimeControlContext();
  if (!context) return false;
  setText(els.modelSwitchStatus, pendingText);
  setRuntimeControlDisabled(true);
  try {
    const result = await window.miaBotCommands.saveBotRuntimeControl({
      api: window.mia,
      cache: botRuntimeControlCache,
      bot: context.bot,
      runtimeKind: context.runtimeKind,
      field,
      value,
      modelEntries,
      engineContracts: window.miaEngineContracts
    });
    if (!result?.saved) return false;
    if (result.runtime) state.runtime = result.runtime;
    setText(els.modelSwitchStatus, successText);
    render();
  } catch (error) {
    setText(els.modelSwitchStatus, "保存失败");
    appendTransientChat("assistant", `${errorPrefix}: ${error.message || error}`);
    syncConversationBotRuntimeControls();
  } finally {
    setRuntimeControlDisabled(false);
  }
  return true;
}

async function saveActivePermissionRuntimeControl(mode) {
  const context = activeBotRuntimeControlContext();
  if (!context) return false;
  const engine = agentEngineForRuntimeControl(context);
  if (context.runtimeKind === "cloud-claude-code" || !isExternalAgentEngineForRuntimeControl(engine)) {
    return saveActiveBotRuntimeControl(
      "permissionMode",
      mode || "ask",
      "保存权限...",
      "权限已更新",
      "Permission mode failed"
    );
  }
  setText(els.modelSwitchStatus, "保存权限...");
  setRuntimeControlDisabled(true);
  try {
    state.runtime = await window.mia.savePermissions({
      engine,
      mode: mode || "default"
    });
    setText(els.modelSwitchStatus, "权限已更新");
    render();
  } catch (error) {
    setText(els.modelSwitchStatus, "保存失败");
    appendTransientChat("assistant", `Permission mode failed: ${error.message || error}`);
    syncConversationBotRuntimeControls();
  } finally {
    setRuntimeControlDisabled(false);
  }
  return true;
}

function activeConversationBotKey() {
  const social = window.miaSocial;
  const conversationId = social?.getActiveConversationId?.();
  if (!conversationId) return "";
  const conversation = social?.getConversationById?.(conversationId) || { id: conversationId };
  return conversationTypeForComposer(conversation, conversationId) === "bot" ? botKeyForConversation(conversation) : "";
}

function activePersona() {
  const personas = allOwnedBotsForIdentity();
  const conversationBotKey = activeConversationBotKey();
  if (conversationBotKey) {
    const conversationPersona = personas.find((persona) => (persona.key || persona.id) === conversationBotKey);
    if (conversationPersona) return conversationPersona;
    return null;
  }
  return personas.find((persona) => persona.key === state.activeKey) || personas[0];
}




// Ephemeral, client-only feedback (operation errors / status). Shown as a
// transient toast — NOT injected into the conversation cache, so it never
// pollutes sidebar previews, persisted snapshots, or leaks across conversations.
function appendTransientChat(role, content) {
  void role;
  const text = String(content || "").trim();
  if (!text || typeof document === "undefined") return;
  let host = document.getElementById("miaToastHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "miaToastHost";
    document.body.appendChild(host);
  }
  const toast = document.createElement("div");
  toast.className = "mia-toast";
  toast.textContent = text;
  host.appendChild(toast);
  setTimeout(() => toast.classList.add("mia-toast-out"), 3200);
  setTimeout(() => toast.remove(), 3600);
}

let visibleMemoryRefreshTimer = 0;

function refreshVisibleMemoryPanels(memory = {}) {
  clearTimeout(visibleMemoryRefreshTimer);
  visibleMemoryRefreshTimer = setTimeout(() => {
    visibleMemoryRefreshTimer = 0;
    if (state.activeView === "settings" && state.activeSettingsTab === "memory") {
      window.miaSettingsMemory?.loadMemorySettings?.();
    }
    if (memory.botId) {
      window.miaBotManager?.refreshContactMemoryForBot?.(memory.botId);
    }
  }, 120);
}

function handleMemoryEvent(envelope = {}) {
  const payload = envelope.payload || {};
  const memory = payload.memory || {};
  refreshVisibleMemoryPanels(memory);
}


async function createNewSessionForActive() {
  const cloudConversation = activeCloudConversationForSessionMenu();
  if (cloudConversation && conversationTypeForComposer(cloudConversation, cloudConversation.id || "") === "bot") {
    await createNewCloudSessionForActive(cloudConversation);
    return;
  }
  // Cloud-only: 新对话 only applies to an active bot conversation (handled
  // above). With no active bot conversation there is nothing to create.
}

async function createNewCloudSessionForActive(conversation) {
  const payload = sessionHistory.createBotSessionPayload(conversation, cryptoRandomId(), {
    title: "新对话",
    runtimeKindFallback: "desktop-local"
  });
  const botId = payload.botId;
  const ownerUserId = String(state.runtime?.cloud?.user?.id || state.runtime?.cloud?.user?.userId || "").trim();
  if (!botId || !ownerUserId || !window.mia?.social?.ensureBotSessionConversation) return;

  // Optimistic create: the cloud conversation id is deterministic
  // (`botc_<sessionId>`), so build the conversation locally and
  // switch into it with zero wait, then ensure it on the cloud in the
  // background. ensureBotSessionConversation is idempotent, so a slow or
  // failed call is safe — we keep the local session and the first sent message
  // re-ensures it.
  const now = new Date().toISOString();
  const optimisticConversation = {
    id: `botc_${payload.sessionId}`,
    type: "bot",
    name: payload.title,
    decorations: { botId, sessionId: payload.sessionId, runtimeKind: payload.runtimeKind },
    created_at: now,
    updated_at: now
  };
  window.miaSocial?.upsertBotConversation?.(optimisticConversation);
  await selectCloudSessionConversation(optimisticConversation, { skipMessageLoad: true });

  window.mia.social.ensureBotSessionConversation(payload.sessionId, {
    botId,
    title: payload.title,
    runtimeKind: payload.runtimeKind
  }).then((response) => {
    if (response?.ok) {
      const createdConversation = response.data?.conversation || response.conversation;
      if (createdConversation?.id) window.miaSocial?.upsertBotConversation?.(createdConversation);
    } else {
      console.warn("[renderer] ensureBotSessionConversation failed:", response?.error || "unknown");
      appendTransientChat("assistant", "会话云端同步失败，发消息时会自动重试。");
    }
  }).catch((error) => {
    console.warn("[renderer] ensureBotSessionConversation error:", error?.message || error);
  });
}

function botByKey(botKey) {
  const key = String(botKey || "");
  // Canonical owned-bot list. Bot identities are cloud-stored; runtimeKind only
  // describes where that identity runs.
  const bots = window.miaBotManager?.allOwnedBots?.() || [];
  return bots.find((item) => String(item?.key || item?.id || "") === key) || { key };
}

async function openBotConversation(botKey) {
  const key = String(botKey || "").trim();
  if (!key) return;
  const bot = botByKey(key);
  state.activeContactKey = key;
  state.activeView = "chat";
  state.sessionMenuOpen = false;
  state.replyDraft = null;
  showNarrowContent();

  if (state.runtime?.cloud?.enabled && window.miaSocial?.ensureBotConversation) {
    const existingConversation = window.miaSocial?.botConversationForKey?.(key);
    if (existingConversation?.id) {
      state.activeKey = "";
      window.miaSocial.setActiveConversationId(existingConversation.id);
      state.forceScrollToBottom = true;
      render();
      requestAnimationFrame(() => els.chatInput?.focus());
      return;
    }
    const conversation = await window.miaSocial.ensureBotConversation(bot);
    if (conversation?.id) {
      state.activeKey = "";
      window.miaSocial.setActiveConversationId(conversation.id);
      state.forceScrollToBottom = true;
      render();
      requestAnimationFrame(() => els.chatInput?.focus());
      return;
    }
  }

  // Cloud-only: reaching here means the cloud conversation couldn't be opened
  // (e.g. an expired session — handled by the auth-expired flow). Re-render so
  // the shell reflects the real state instead of silently creating a dead local
  // session that masks the failure.
  render();
}

window.miaOpenBotConversation = openBotConversation;

async function refreshRuntime() {
  const previousDaemon = state.runtime?.daemon || {};
  const runtime = await window.mia.runtimeStatus();
  if (runtime?.daemon && Array.isArray(previousDaemon.links) && previousDaemon.links.length && !Array.isArray(runtime.daemon.links)) {
    runtime.daemon = {
      ...runtime.daemon,
      links: previousDaemon.links
    };
  }
  if (runtime?.appearance && state.runtime?.appearance) {
    runtime.appearance = window.miaSettingsAppearance?.mergeCloudAppearance?.(state.runtime.appearance, runtime.appearance) || {
      ...(state.runtime.appearance || {}),
      ...runtime.appearance
    };
  }
  state.runtime = runtime;
  state.petJobs = state.runtime?.petJobs || state.petJobs;
  if (state.botDialogOpen
    && typeof window.miaBotDialog?.readSelectedRuntimeTarget === "function"
    && typeof window.miaBotDialog?.renderBotRuntimeTargetSelect === "function") {
    const selected = window.miaBotDialog.readSelectedRuntimeTarget();
    window.miaBotDialog.renderBotRuntimeTargetSelect({
      runtimeKind: selected.runtimeKind,
      deviceId: selected.targetDeviceId,
      deviceName: selected.targetDeviceName,
      agentEngine: selected.agentEngine
    }, { preservePrevious: true });
  }
  maybeBootstrapSocialAfterRuntime(runtime);
  render();
}

function maybeBootstrapSocialAfterRuntime(runtime) {
  if (!runtime?.cloud?.enabled) return;
  if (!window.miaSocial || typeof window.miaSocial.bootstrapAfterLogin !== "function") return;
  if (typeof window.miaSocial.isBootstrapped === "function" && window.miaSocial.isBootstrapped()) {
    maybeEnsureStarterEngineBots();
    return;
  }
  if (socialBootstrapInFlight) return;
  socialBootstrapInFlight = Promise.resolve(window.miaSocial.bootstrapAfterLogin())
    .then(() => maybeEnsureStarterEngineBots())
    .catch((err) => {
      console.warn("[social] runtime bootstrap failed:", err);
    })
    .finally(() => {
      socialBootstrapInFlight = null;
    });
}

function maybeEnsureStarterEngineBots() {
  if (!state.runtime?.cloud?.enabled) return Promise.resolve(null);
  if (!window.miaSocial || typeof window.miaSocial.isBootstrapped !== "function" || !window.miaSocial.isBootstrapped()) {
    return Promise.resolve(null);
  }
  if (!window.miaStarterEngineBots || typeof window.miaStarterEngineBots.ensureStarterEngineBots !== "function") {
    return Promise.resolve(null);
  }
  if (starterEngineBotsInFlight) return starterEngineBotsInFlight;
  starterEngineBotsInFlight = Promise.resolve(window.miaStarterEngineBots.ensureStarterEngineBots({
    state,
    api: window.mia,
    social: window.miaSocial,
    commands: window.miaBotCommands
  }))
    .then((result) => {
      if (result?.created?.length) render();
      return result;
    })
    .catch((err) => {
      console.warn("[starter-engine-bots] seed failed:", err?.message || err);
      return null;
    })
    .finally(() => {
      starterEngineBotsInFlight = null;
    });
  return starterEngineBotsInFlight;
}

async function initializeRuntime(options = {}) {
  const blockStartup = Boolean(options.blockStartup);
  const runtime = await trackStartupTask("初始化 runtime", () => window.mia.initializeRuntime());
  state.firstRun = Array.isArray(runtime?.created) && runtime.created.length > 0;
  if (state.firstRun && !state.onboardingStep && !state.setupGuideDismissed && !state.agentSetupSkipped) {
    advanceOnboarding("engine");
  }
  state.runtime = runtime;
  // Initialize extracted renderer modules BEFORE any subsequent trackStartupTask
  // call, because trackStartupTask itself triggers render() at start and finish;
  // once state.runtime is set, render() no longer early-returns and will call
  // into window.mia*.{applyAppearance,renderXxx} — which need fontPresets /
  // state / els / etc. to already be injected.
  // Keep appearance init ahead of any module that receives render() or can
  // trigger it during init. Otherwise cloud/social startup can abort before
  // the active conversation header and avatar media are repainted.
  if (window.miaSettingsRemote && window.miaSettingsRemote.initSettingsRemote) {
    window.miaSettingsRemote.initSettingsRemote({
      state,
      els,
      setText,
      fetchModelBalance: () => window.mia.cloudModelBalance(),
    });
  }
  if (window.miaSkillHelpers && window.miaSkillHelpers.initSkillHelpers) {
    window.miaSkillHelpers.initSkillHelpers({ escapeHtml: window.miaMarkdown.escapeHtml });
  }
  if (window.miaAvatar && window.miaAvatar.initAvatarHelpers) {
    window.miaAvatar.initAvatarHelpers({ escapeHtml: window.miaMarkdown.escapeHtml });
  }
  if (window.miaSettingsAppearance && window.miaSettingsAppearance.initSettingsAppearance) {
    window.miaSettingsAppearance.initSettingsAppearance({
      state,
      els,
      mia: window.mia,
      fontPresets,
      DEFAULT_ACCENT_COLOR,
      DEFAULT_USER_BUBBLE_COLOR,
      DEFAULT_SELECTION_STYLE,
    });
  }
  if (window.miaSettingsMemory && window.miaSettingsMemory.initSettingsMemory) {
    window.miaSettingsMemory.initSettingsMemory({
      state,
      els,
      renderView,
    });
  }
  if (window.miaModelHelpers && window.miaModelHelpers.initModelHelpers) {
    window.miaModelHelpers.initModelHelpers({
      state,
      els,
      providerLabels,
      providerPresets,
    });
  }
  if (window.miaEngineOptions && window.miaEngineOptions.initEngineOptions) {
    window.miaEngineOptions.initEngineOptions({
      state,
      els,
      activePersona,
      APPROVAL_LABELS,
      APPROVAL_TITLES,
      EFFORT_LABELS,
    });
  }
  if (window.miaSetupGuide && window.miaSetupGuide.initSetupGuide) {
    window.miaSetupGuide.initSetupGuide({ state, escapeHtml: window.miaMarkdown.escapeHtml });
  }
  if (window.miaModelSettings && window.miaModelSettings.initModelSettings) {
    window.miaModelSettings.initModelSettings({
      state,
      els,
      escapeHtml: window.miaMarkdown.escapeHtml,
      setText,
      updateModelFieldVisibility,
      providerPresets,
      providerLabels,
    });
  }
  if (window.miaBotDialog && window.miaBotDialog.initBotDialog) {
    window.miaBotDialog.initBotDialog({ state, els, renderView, render });
  }
  if (window.miaTraceBlocks && window.miaTraceBlocks.initTraceBlocks) {
    window.miaTraceBlocks.initTraceBlocks({ state });
  }
  if (window.miaMessageHelpers && window.miaMessageHelpers.initMessageHelpers) {
    window.miaMessageHelpers.initMessageHelpers({
      state,
      els,
      activePersona,
      messagesForActive,
      renderSendButton,
    });
  }
  if (window.miaLoaders && window.miaLoaders.initLoaders) {
    window.miaLoaders.initLoaders({ state, render });
  }
  if (window.miaComposer && window.miaComposer.initComposer) {
    window.miaComposer.initComposer({
      state,
      els,
      mia: window.mia,
      loadSkills: () => window.miaLoaders.loadSkills(),
      renderAttachmentThumb,
      renderSendButton,
      resizeChatInput: () => window.miaMessageHelpers.resizeChatInput(),
      openImagePreview,
      appendTransientChat,
      cryptoRandomId,
    });
  }
  if (window.miaBotManager && window.miaBotManager.initBotManager) {
    window.miaBotManager.initBotManager({
      state,
      els,
      setText,
      formatConversationTime,
      loadSkills: () => window.miaLoaders.loadSkills(),
      showNarrowContent,
      render,
      openEditBotDialog,
      deleteBot,
    });
  }
  if (window.miaSkillLibrary && window.miaSkillLibrary.initSkillLibrary) {
    window.miaSkillLibrary.initSkillLibrary({
      state,
      els,
      mia: window.mia,
      escapeHtml: window.miaMarkdown.escapeHtml,
      setText,
      menuItemHtml: window.miaMarkdown.menuItemHtml,
      syncTopbarClickCapture,
      showNarrowContent,
      deleteSkill,
      openSkillDirectory,
    });
  }
  if (window.miaMcpLibrary && window.miaMcpLibrary.initMcpLibrary) {
    window.miaMcpLibrary.initMcpLibrary({
      state,
      els,
      escapeHtml: window.miaMarkdown.escapeHtml,
      setText,
      layoutCards: () => window.miaSkillLibrary?.layoutSkillCards?.(),
    });
  }
  if (window.miaBotStore && window.miaBotStore.initBotStore) {
    window.miaBotStore.initBotStore({
      state,
      els,
      mia: window.mia,
      escapeHtml: window.miaMarkdown.escapeHtml,
      loadSkills: () => window.miaLoaders.loadSkills(),
      openBotConversation,
      render,
    });
  }
  if (window.miaTasksPanel && window.miaTasksPanel.initTasksPanel) {
    window.miaTasksPanel.initTasksPanel({
      state,
      els,
      mia: window.mia,
      escapeHtml: window.miaMarkdown.escapeHtml,
      setText,
      formatRunTime,
      render,
      renderView,
      renderChat,
    });
  }
  if (window.miaPetDialog && window.miaPetDialog.initPetDialog) {
    window.miaPetDialog.initPetDialog({
      state,
      els,
      mia: window.mia,
      botByKey: window.miaBotManager.botByKey,
      cryptoRandomId,
      avatarBackgroundStyle: window.miaAvatar.avatarBackgroundStyle,
      escapeHtml: window.miaMarkdown.escapeHtml,
      setText,
      renderView,
      refreshRuntime,
      appendTransientChat,
    });
  }
  if (window.miaMessageMenu && window.miaMessageMenu.initMessageMenu) {
    window.miaMessageMenu.initMessageMenu({
      state,
      els,
      mia: window.mia,
      messageAtIndex: window.miaMessageHelpers.messageAtIndex,
      messageReferenceForIndex: window.miaMessageHelpers.messageReferenceForIndex,
      messageContextText: window.miaMessageHelpers.messageContextText,
      menuItemHtml: window.miaMarkdown.menuItemHtml,
      renderChat,
      renderSessionMenu,
      renderComposerReply: window.miaMessageHelpers.renderComposerReply,
      escapeHtml: window.miaMarkdown.escapeHtml,
      renderMarkdown: window.miaMarkdown.renderMarkdown,
      copyTextToClipboard,
      nowIso,
      cryptoRandomId,
      closeSkillContextMenu: window.miaSkillLibrary.closeSkillContextMenu,
      closeBotContextMenu: window.miaBotManager.closeBotContextMenu,
    });
  }
  if (window.miaSocial && window.miaSocial.initSocialModule) {
    window.miaSocial.initSocialModule({
      getState: () => state,
      render,
      els,
      appendTransientChat,
      maybeGenerateConversationTitle: maybeGenerateCloudConversationTitle,
      onCloudAuthExpired: handleCloudAuthExpired,
      onActiveConversationChanged: (previousId, nextId) => {
        window.miaComposer?.switchConversationDraft?.(previousId, nextId);
      },
      isWindowFocused: () => desktopWindowFocused,
      showDesktopMessageNotification: (payload) => window.mia.showDesktopNotification?.(payload),
      paintHeaderStatus,
    });
    // Bootstrap social data if signed in to cloud (token present).
    // (cloud.enabled, not cloud.loggedIn — the latter never existed, so
    // this used to never run; bootstrap only fired later via the WS
    // events_ready event, which is part of why the list arrived late.)
    if (state.runtime && state.runtime.cloud && state.runtime.cloud.enabled) {
      window.miaSocial.bootstrapAfterLogin()
        .then(() => maybeEnsureStarterEngineBots())
        .catch((err) => {
          console.warn("[social] boot bootstrap failed:", err);
        });
    }
  }
  render();
  if (state.runtime?.agentInventory?.summary?.scanning) {
    setTimeout(refreshRuntime, 120);
  }
  if (blockStartup) {
    await runFirstRunBackgroundServices();
    await loadInitialRuntimeData();
    await loadTasksFromDaemonForStartup();
    await trackStartupTask("刷新运行状态", () => refreshRuntime()).catch((error) => {
      console.warn("[Mia startup] failed to refresh runtime", error);
    });
    return;
  }
  setTimeout(() => {
    loadInitialRuntimeData();
  }, 800);
  loadTasksFromDaemonForStartup();
}

document.getElementById("groupInfoButton")?.addEventListener("click", () => {
  const conversationId = window.miaSocial?.getActiveConversationId?.();
  if (conversationId) window.miaGroupInfoDialog?.open(conversationId);
});

document.addEventListener("pointerdown", (event) => {
  const select = event.target?.closest?.("select");
  if (isCustomSelect(select) && !select.disabled) {
    event.preventDefault();
    event.stopPropagation();
    select.focus({ preventScroll: true });
    openComposerSelectMenu(select);
    return;
  }
  if (!activeComposerSelectMenu) return;
  if (activeComposerSelectMenu.menu?.contains(event.target)) return;
  if (activeComposerSelectMenu.trigger?.contains(event.target)) return;
  closeComposerSelectMenu();
}, true);

document.addEventListener("click", (event) => {
  const select = event.target?.closest?.("select");
  if (!isCustomSelect(select) || select.disabled) return;
  event.preventDefault();
  event.stopPropagation();
}, true);

document.addEventListener("click", (event) => {
  const option = event.target?.closest?.(".composer-select-option");
  if (!option || !activeComposerSelectMenu?.menu?.contains(option)) return;
  event.preventDefault();
  event.stopPropagation();
  chooseComposerSelectOption(activeComposerSelectMenu.select, option.dataset.value || "");
});

document.addEventListener("keydown", (event) => {
  const select = isCustomSelect(event.target) ? event.target : null;
  if (select && !select.disabled) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!activeComposerSelectMenu || activeComposerSelectMenu.select !== select) openComposerSelectMenu(select);
      else moveComposerSelectMenuSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!activeComposerSelectMenu || activeComposerSelectMenu.select !== select) openComposerSelectMenu(select);
      else moveComposerSelectMenuSelection(-1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!activeComposerSelectMenu || activeComposerSelectMenu.select !== select) {
        openComposerSelectMenu(select);
        return;
      }
      const active = currentComposerSelectMenuOption();
      if (active) chooseComposerSelectOption(select, active.dataset.value || "");
      return;
    }
    if (event.key === "Escape" && activeComposerSelectMenu?.select === select) {
      event.preventDefault();
      closeComposerSelectMenu();
      return;
    }
  }
  if (!activeComposerSelectMenu) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeComposerSelectMenu();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveComposerSelectMenuSelection(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveComposerSelectMenuSelection(-1);
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    const active = currentComposerSelectMenuOption();
    if (active) {
      event.preventDefault();
      chooseComposerSelectOption(activeComposerSelectMenu.select, active.dataset.value || "");
    }
  }
});

window.addEventListener("resize", closeComposerSelectMenu);

els.openSettings.addEventListener("click", () => {
  openSettingsView();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeImagePreview();
  if (state.chatConversationMenuOpen) {
    event.preventDefault();
    state.chatConversationMenuOpen = false;
    render();
  }
  if (state.skillContextMenu.open) window.miaSkillLibrary.closeSkillContextMenu();
  if (state.botContextMenu.open) window.miaBotManager.closeBotContextMenu();
  if (state.messageContextMenu.open) window.miaMessageMenu?.closeMessageContextMenu();
  window.miaComposer.closeComposerAddMenu();
  if (state.profileDialogOpen && !state.avatarCropEditor?.open) {
    event.preventDefault();
    window.miaBotDialog.closeProfileDialog();
  }
});
document.addEventListener("pointerdown", closeProfilePopoverFromOutside);
els.activeConversationMenuButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  state.chatConversationMenuOpen = !state.chatConversationMenuOpen;
  if (state.chatConversationMenuOpen) state.sessionMenuOpen = false;
  render();
});
els.activeConversationMenuButton?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  state.chatConversationMenuOpen = !state.chatConversationMenuOpen;
  if (state.chatConversationMenuOpen) state.sessionMenuOpen = false;
  render();
});
els.sessionMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  state.sessionMenuOpen = !state.sessionMenuOpen;
  if (state.sessionMenuOpen) state.chatConversationMenuOpen = false;
  renderSessionMenu();
  renderChatConversationMenu([], []);
});
document.addEventListener("click", (event) => {
  if (state.skillContextMenu.open && !els.skillContextMenu?.contains(event.target)) window.miaSkillLibrary.closeSkillContextMenu();
});
document.addEventListener("click", (event) => {
  if (state.botContextMenu.open && !els.botContextMenu?.contains(event.target)) window.miaBotManager.closeBotContextMenu();
});
document.addEventListener("click", (event) => {
  if (state.messageContextMenu.open && !els.messageContextMenu?.contains(event.target)) window.miaMessageMenu?.closeMessageContextMenu();
});
// Left/right click on cloud-conversation avatars → contact card / quick menu.
els.chat?.addEventListener("click", (event) => {
  const avatarEl = event.target.closest(".message-avatar[data-sender-kind][data-sender-ref]");
  if (!avatarEl || !els.chat.contains(avatarEl)) return;
  const kind = avatarEl.dataset.senderKind;
  const ref = avatarEl.dataset.senderRef;
  if (!kind || !ref) return;
  const conversationId = window.miaSocial?.getActiveConversationId?.();
  event.stopPropagation();
  window.miaContactCard?.openCard({ kind, ref, conversationId, anchor: avatarEl });
});
els.chat?.addEventListener("contextmenu", (event) => {
  const avatarEl = event.target.closest(".message-avatar[data-sender-kind][data-sender-ref]");
  if (avatarEl && els.chat.contains(avatarEl)) {
    const kind = avatarEl.dataset.senderKind;
    const ref = avatarEl.dataset.senderRef;
    if (!kind || !ref) return;
    const conversationId = window.miaSocial?.getActiveConversationId?.();
    event.preventDefault();
    event.stopPropagation();
    window.miaContactCard?.openContextMenu({ kind, ref, conversationId, anchor: avatarEl, x: event.clientX, y: event.clientY });
    return;
  }
  const bubble = event.target.closest(".bubble[data-message-index]");
  if (!bubble || !els.chat.contains(bubble)) return;
  const selection = window.miaMessageMenu?.selectionInsideBubble(bubble);
  // Cloud-conversation bubbles (cloud DM + cloud group) carry data-message-source +
  // data-message-id and live in social.moduleState.messageCache, not the
  // bot session, so dispatch to the lightweight social message menu.
  if (bubble.dataset.messageSource === "cloud-conversation") {
    const social = window.miaSocial;
    const messageId = bubble.dataset.messageId;
    if (!social || !messageId) return;
    const conversationId = social.getActiveConversationId?.();
    const cache = conversationId ? social.moduleState?.messageCache?.get?.(conversationId) : null;
    const message = cache?.messages?.find?.((m) => m.id === messageId);
    if (!message) return;
    event.preventDefault();
    event.stopPropagation();
    window.miaSocialMessageMenu?.openSocialMessageMenu(message, event.clientX, event.clientY, selection);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  window.miaMessageMenu?.openMessageContextMenu(bubble.dataset.messageIndex, event.clientX, event.clientY, selection);
});
document.addEventListener("click", (event) => {
  if (!state.sessionMenuOpen) return;
  if (els.sessionMenu?.contains(event.target)) return;
  state.sessionMenuOpen = false;
  renderSessionMenu();
});
document.addEventListener("click", (event) => {
  if (!state.chatConversationMenuOpen) return;
  if (els.chatConversationMenu?.contains(event.target) || els.activeConversationMenuButton?.contains(event.target)) return;
  state.chatConversationMenuOpen = false;
  render();
});
document.addEventListener("click", (event) => {
  if (!state.botMenuOpen) return;
  if (els.botCreateMenu?.contains(event.target) || els.newPersona?.contains(event.target)) return;
  state.botMenuOpen = false;
  renderView();
});
document.addEventListener("click", (event) => {
  if (!state.contactMenuOpen) return;
  if (els.contactCreateMenu?.contains(event.target) || els.newContact?.contains(event.target)) return;
  state.contactMenuOpen = false;
  renderView();
});
document.addEventListener("click", (event) => {
  if (!state.composerAddMenuOpen) return;
  if (els.composerAddMenu?.contains(event.target) || els.skillPicker?.contains(event.target) || els.composerAdd?.contains(event.target)) return;
  window.miaComposer.closeComposerAddMenu();
});
document.addEventListener("click", (event) => {
  if (!state.petJobPanelOpen) return;
  if (els.petJobPanel?.contains(event.target) || els.petJobButton?.contains(event.target)) return;
  state.petJobPanelOpen = false;
  window.miaPetDialog?.renderPetJobs();
});
els.newSession.addEventListener("click", async (event) => {
  event.stopPropagation();
  await createNewSessionForActive();
});
els.initialize?.addEventListener("click", initializeRuntime);
els.openPersonaSearch?.addEventListener("click", (event) => {
  event.preventDefault();
  setPersonaSearchOpen(true);
});
els.personaSearch.addEventListener("focus", () => {
  if (!state.personaSearchOpen) setPersonaSearchOpen(true);
});
els.personaSearch.addEventListener("input", () => {
  state.personaSearchOpen = true;
  state.personaFilter = els.personaSearch.value;
  schedulePersonaMessageSearch();
});
els.personaSearch.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  if (state.personaFilter) {
    state.personaFilter = "";
    els.personaSearch.value = "";
    resetPersonaMessageSearch();
    render();
    return;
  }
  setPersonaSearchOpen(false);
});
els.personaSearchClear?.addEventListener("click", (event) => {
  event.preventDefault();
  setPersonaSearchOpen(false);
});
els.closePersonaSearch?.addEventListener("click", (event) => {
  event.preventDefault();
  setPersonaSearchOpen(false);
});
els.personaTagFilters?.addEventListener("pointerdown", beginConversationFolderDrag);
els.personaTagFilters?.addEventListener("wheel", handleConversationFolderWheel, { passive: false });
document.addEventListener("pointermove", moveConversationFolderDrag, { passive: false });
document.addEventListener("pointerup", endConversationFolderDrag);
document.addEventListener("pointercancel", endConversationFolderDrag);
els.personaTagFilters?.addEventListener("click", (event) => {
  const chip = event.target?.closest?.("[data-sidebar-tag-filter]");
  if (!chip) return;
  event.preventDefault();
  if (conversationFolderSuppressClick) return;
  const nextName = chip.dataset.tagName || "";
  if (!rememberConversationFolderMotion(nextName)) {
    ensureActiveConversationFolderVisible();
    return;
  }
  window.miaSocial?.setConversationTagFilter?.(nextName);
});
els.contactSearch?.addEventListener("input", () => {
  state.contactFilter = els.contactSearch.value;
  window.miaBotManager.renderContacts();
});
els.skillSearch?.addEventListener("input", () => {
  state.skillFilter = els.skillSearch.value;
  window.miaSkillLibrary.renderSkillLibrary();
});
window.miaTasksPanel?.bindCreateControls?.();
document.querySelectorAll("[data-skill-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.skillCategoryFilter = button.dataset.skillFilter || "";
    window.miaSkillLibrary.renderSkillLibrary();
  });
});

window.miaLottieIcons?.init();

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    // 联系人 rail 图标进的是 发现/联系人 section，默认落到发现页。
    const nextView = button.dataset.view === "contacts"
      ? (state.discoverSectionView || "bot-store")
      : button.dataset.view;
    if (nextView === "chat") setPersonaSearchOpen(false);
    if (nextView === "contacts" || nextView === "bot-store" || nextView === "skills") {
      state.exploreSectionView = nextView;
    }
    const reselectingCollapsedIndex = state.activeView === nextView
      && sidebarCollapseSupported(nextView)
      && state.sidebarCollapsed;
    state.activeView = nextView;
    if (reselectingCollapsedIndex) setSidebarCollapsed(false, true);
    if (state.isNarrowWindow && viewHasIndexPane(state.activeView)) {
      showNarrowSidebar();
    } else {
      showNarrowContent();
    }
    if (button.dataset.view === "skills" && !state.skillLibrary.skills.length && !state.skillsLoading) window.miaLoaders.loadSkills();
    if (state.activeView === "bot-store" && !(state.skillLibrary.botPresets || []).length && !state.skillsLoading) window.miaLoaders.loadSkills();
    if (state.activeView === "bot-store") window.miaBotStore?.renderBotStore?.();
    renderView();
    if (state.activeView === "tasks") {
      window.miaTasksPanel?.loadTasksFromDaemon().then(() => {
        window.miaTasksPanel?.renderTaskView();
      });
    }
  });
});

document.querySelectorAll("[data-primary-nav]").forEach((button) => {
  button.addEventListener("click", () => {
    showPrimaryNav(button.dataset.primaryNav);
  });
});

document.querySelectorAll("[data-explore-view]").forEach((button) => {
  button.addEventListener("click", () => {
    const nextView = button.dataset.exploreView || "bot-store";
    if (state.activeView === nextView) return;
    state.activeView = nextView;
    state.exploreSectionView = nextView;
    state.discoverSectionView = nextView;
    if (nextView === "bot-store" && !(state.skillLibrary.botPresets || []).length && !state.skillsLoading) window.miaLoaders.loadSkills();
    if (nextView === "skills" && !state.skillLibrary.skills.length && !state.skillsLoading) window.miaLoaders.loadSkills();
    if (nextView === "bot-store") window.miaBotStore?.renderBotStore?.();
    showNarrowContent();
    renderView();
  });
});

document.querySelectorAll("[data-task-sidebar-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    state.activeView = "tasks";
    state.taskMode = button.dataset.taskSidebarMode === "history" ? "history" : "active";
    showNarrowContent();
    renderView();
  });
});

els.conversationSidebar?.addEventListener("pointerenter", () => setConversationSidebarActionHover(true));
els.conversationSidebar?.addEventListener("pointermove", updateConversationSidebarActionHoverFromPointer);
els.conversationSidebar?.addEventListener("pointerleave", (event) => {
  if (!pointerIsInsideConversationSidebar(event)) setConversationSidebarActionHover(false);
});
document.addEventListener("pointermove", (event) => {
  if (!els.conversationSidebar?.classList.contains("sidebar-action-hover")) return;
  updateConversationSidebarActionHoverFromPointer(event);
});

els.sidebarCollapseToggle?.addEventListener("click", () => {
  if (!sidebarCollapseSupported(state.activeView)) return;
  setSidebarCollapsed(true, true);
  renderView();
});

els.sidebarRailToggle?.addEventListener("click", () => {
  if (!sidebarCollapseSupported(state.activeView)) return;
  setSidebarCollapsed(false, true);
  renderView();
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
  window.miaScrollbarOverlay.showScrollingScrollbar(event.target);
}, { capture: true, passive: true });
document.addEventListener("pointermove", (event) => {
  window.miaScrollbarOverlay.updateScrollbarOverlayDrag(event);
}, { capture: true });
document.addEventListener("pointerup", (event) => window.miaScrollbarOverlay.stopScrollbarOverlayDrag(event), { capture: true });
document.addEventListener("pointercancel", (event) => window.miaScrollbarOverlay.stopScrollbarOverlayDrag(event), { capture: true });
window.addEventListener("resize", () => {
  const overlayTarget = window.miaScrollbarOverlay.getScrollbarOverlayTarget();
  if (overlayTarget) window.miaScrollbarOverlay.updateScrollbarOverlay(overlayTarget);
  const isNarrow = window.innerWidth <= SHELL_SINGLE_MAX_WIDTH;
  const wasNarrow = state.isNarrowWindow;
  const transitionDirection = wasNarrow === isNarrow ? "" : isNarrow ? "collapse" : "expand";
  if (!wasNarrow && isNarrow) {
    state.narrowPane = activeViewHasDetail(state.activeView) ? "content" : "sidebar";
  }
  state.isNarrowWindow = isNarrow;
  applySidebarWidth(state.sidebarWidth);
  normalizeNarrowPaneForView(state.activeView);
  state.shellLayout = shellLayoutForView(state.activeView);
  syncNarrowLayout();
  syncSidebarCollapseState();
  if (els.appShell) els.appShell.setAttribute("data-shell-layout", state.shellLayout);
  scheduleSidebarTagIndicator();
  triggerResponsiveShellTransition(transitionDirection);
});

document.querySelectorAll("[data-settings-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    state.activeSettingsTab = button.dataset.settingsTab;
    renderView();
  });
});

els.cloudLogout?.addEventListener("click", async () => {
  els.cloudLogout.disabled = true;
  try {
    state.runtime = await window.mia.cloudLogout();
    render();
  } catch (error) {
    setText(els.cloudAccountHint, `退出失败：${error.message || error}`);
  } finally {
    els.cloudLogout.disabled = false;
  }
});
window.mia.onUpdateEvent?.((payload) => handleAppUpdateEvent(payload || {}));
els.checkUpdates?.addEventListener("click", async () => {
  els.checkUpdates.disabled = true;
  setText(els.appUpdateHint, "正在检查更新...");
  try {
    const result = await window.mia.checkForUpdates();
    handleAppUpdateEvent(result || {});
    setText(els.appUpdateHint, appUpdateStatusText(result));
  } catch (error) {
    setText(els.appUpdateHint, `检查失败：${error.message || error}`);
  } finally {
    els.checkUpdates.disabled = false;
  }
});

function renderDaemonStatus(status = {}) {
  const running = Boolean(status?.running);
  if (els.daemonHint) {
    const host = status?.host || status?.settings?.host || "";
    const port = status?.port || status?.settings?.port || "";
    const where = host && port ? ` · ${host}:${port}` : "";
    setText(els.daemonHint, running
      ? `运行中${where}  Mia Core 是本机运行核心`
      : `未运行${where}  Mia 暂不可用，请重启 Mia Core`);
  }
  if (els.daemonRestart) {
    els.daemonRestart.disabled = false;
    els.daemonRestart.textContent = running ? "重启" : "启动";
  }
}

async function refreshDaemonControls() {
  if (!els.daemonHint) return;
  try {
    renderDaemonStatus(await window.mia.daemonStatus());
  } catch (error) {
    setText(els.daemonHint, `状态获取失败：${error.message || error}`);
  }
}

els.daemonRestart?.addEventListener("click", async () => {
  els.daemonRestart.disabled = true;
  setText(els.daemonHint, "Mia Core 重启中…");
  try {
    await window.mia.stopDaemon();
    await window.mia.startDaemon();
  } catch (error) {
    setText(els.daemonHint, `Mia Core 重启失败：${error.message || error}`);
  }
  await refreshDaemonControls();
});

function toggleHermesModelForm() {
  if (!els.engineRowHermesButton || !els.modelForm) return;
  if (!hermesCanConfigure(state.runtime)) return;
  const expanded = els.engineRowHermesButton.getAttribute("aria-expanded") === "true";
  const next = !expanded;
  els.engineRowHermesButton.setAttribute("aria-expanded", next ? "true" : "false");
  if (window.miaAccordion?.setElementOpen) window.miaAccordion.setElementOpen(els.modelForm, next);
  else els.modelForm.classList.toggle("hidden", !next);
}

if (els.engineRowHermesButton && els.modelForm) {
  els.engineRowHermesButton.addEventListener("click", (event) => {
    if (event.target.closest("[data-engine-settings-install]")) return;
    toggleHermesModelForm();
  });
  els.engineRowHermesButton.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    toggleHermesModelForm();
  });
}

els.engineDetection?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-engine-settings-install]");
  if (!button || !els.engineDetection.contains(button)) return;
  event.preventDefault();
  event.stopPropagation();
  await runHermesSetupAction(button, button.dataset.setupAction || "");
});

if (window.mia.onEnginesChanged) {
  window.mia.onEnginesChanged(() => { refreshRuntime().catch(() => {}); });
}

if (window.mia.onEngineInstallProgress) {
  window.mia.onEngineInstallProgress((payload = {}) => {
    const engineId = String(payload.engineId || "").trim();
    if (!engineId) return;
    const message = String(payload.message || payload.stage || payload.status || "").trim();
    const percent = Number(payload.percent);
    state.agentSetupInstallErrors = state.agentSetupInstallErrors || {};
    state.agentSetupInstallEngine = engineId;
    if (message) state.agentSetupInstallMessage = message;
    if (payload.stage) state.agentSetupInstallStage = String(payload.stage);
    if (Number.isFinite(percent)) state.agentSetupInstallPercent = Math.max(0, Math.min(100, Math.round(percent)));
    if (payload.status === "running") delete state.agentSetupInstallErrors[engineId];
    if (payload.status === "success") state.agentSetupInstallPercent = 100;
    if (payload.status === "error") {
      const label = engineId === "hermes" ? "官方 Hermes" : engineId;
      const errorMessage = `${label} 安装失败：${message || "Unknown installer error"}`;
      state.agentSetupInstallErrors[engineId] = errorMessage;
      if (engineId === "hermes") state.hermesInstallError = errorMessage;
      state.agentSetupInstallMessage = errorMessage;
      state.agentSetupInstallStage = "";
    }
    if (!state.agentSetupInstallProgressTimer) {
      state.agentSetupInstallProgressTimer = setTimeout(() => {
        state.agentSetupInstallProgressTimer = 0;
        renderView();
      }, 120);
    }
  });
}

if (window.mia.onCloudEvent) {
  let cloudEventRefreshTimer = 0;
  window.mia.onCloudEvent((envelope = {}) => {
    const runtimeBinding = envelope.type === "bot.runtime_updated"
      ? envelope.binding
      : envelope.payload?.binding;
    if (runtimeBinding?.botId && runtimeBinding?.runtimeKind) {
      botRuntimeControlCache.set(
        botRuntimeCacheKey(runtimeBinding.botId, runtimeBinding.runtimeKind),
        runtimeBinding
      );
    }
    if (envelope.type === "memory.updated" || envelope.type === "memory.deleted") {
      handleMemoryEvent(envelope);
      return;
    }
    if (String(envelope.type || "").startsWith("task.")) {
      window.miaTasksPanel?.handleTaskEvent?.(envelope);
    }
    window.miaSocial?.handleCloudEvent?.(envelope);
    const updatedDevices = envelope.type === "device_updated" ? envelope.payload?.devices : null;
    if (Array.isArray(updatedDevices) && state.runtime) {
      state.runtime = {
        ...state.runtime,
        cloud: {
          ...(state.runtime.cloud || {}),
          devices: updatedDevices
        }
      };
    }
    if (envelope.cloud && state.runtime) {
      state.runtime = {
        ...state.runtime,
        cloud: {
          ...(state.runtime.cloud || {}),
          ...envelope.cloud
        }
      };
      window.miaSettingsRemote.renderCloudAccount(envelope.cloud);
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

window.mia.onDesktopNotificationClick?.(openDesktopNotificationConversation);

els.codexLogin.addEventListener("click", async () => {
  els.codexLogin.disabled = true;
  try {
    const entry = window.miaModelHelpers.selectedModelEntry();
    if (entry) {
      window.miaModelSettings.applyModelEntryToFields(entry);
      if (entry.provider === "openai-codex") state.runtime = await window.mia.saveModel({
        provider: entry.provider,
        model: entry.model,
        apiKeyEnv: entry.apiKeyEnv,
        baseUrl: entry.baseUrl,
        apiMode: entry.apiMode,
        providerLabel: entry.providerLabel,
        authType: entry.authType
      });
    }
    state.runtime = await window.mia.startProviderOAuth({
      provider: entry?.provider || "openai-codex",
      providerLabel: entry?.providerLabel || window.miaModelHelpers.providerLabel(entry?.provider || "openai-codex"),
      authType: entry?.authType || "oauth_external",
      baseUrl: entry?.baseUrl || "",
      apiMode: entry?.apiMode || ""
    });
    render();
  } catch (error) {
    window.alert(`登录失败：${error.message}`);
    await refreshRuntime();
  }
});

els.codexCancel.addEventListener("click", async () => {
  state.runtime = await window.mia.cancelProviderOAuth();
  render();
});

els.modelPreset.addEventListener("change", () => {
  window.miaModelSettings.fillModelFieldsFromPreset(els.modelPreset.value);
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
  window.miaModelSettings.syncQuickModelLabel();
  const context = activeBotRuntimeControlContext();
  const modelEntries = modelEntriesForRuntimeControl(context);
  await saveActiveBotRuntimeControl(
    "model",
    els.quickModelSelect.value || modelEntries[0]?.id || modelEntries[0]?.value || modelEntries[0]?.model || "",
    "保存模型...",
    "模型已更新",
    "Model switch failed",
    modelEntries
  );
});

els.effortSelect?.addEventListener("change", async () => {
  const level = els.effortSelect.value;
  window.miaModelSettings.syncEffortControl(state.runtime);
  await saveActiveBotRuntimeControl(
    "effortLevel",
    level || "medium",
    "保存推理强度...",
    "推理强度已更新",
    "Effort update failed"
  );
});

els.permissionMode?.addEventListener("change", async () => {
  const mode = els.permissionMode.value;
  setText(els.permissionLabel, window.miaModelSettings.permissionLabelForMode(mode));
  await saveActivePermissionRuntimeControl(mode || "ask");
});

els.modelSelect?.addEventListener("change", () => {
  const entry = window.miaModelHelpers.selectedModelEntry();
  window.miaModelSettings.applyModelEntryToFields(entry);
  updateModelFieldVisibility();
});


els.newPersona.addEventListener("click", (event) => {
  event.stopPropagation();
  state.botMenuOpen = !state.botMenuOpen;
  renderView();
});

// 发现 AI 助手 | 联系人 —— 顶栏滑动胶囊（仿技能 我的技能/探索发现）。
// discover = 整屏卡片网格(bot 商店)；contacts = 列表(浮动白卡)+详情。
const DISCOVER_MODES = [
  { view: "bot-store", label: "发现 AI 助手" },
  { view: "contacts", label: "联系人" }
];

function discoverModeUnreadHtml(mode) {
  if (mode.view !== "contacts") return "";
  return `<span class="discover-mode-unread hidden" data-discover-unread="contacts" aria-hidden="true">0</span>`;
}

function renderDiscoverModeToggle() {
  const host = els.discoverModeToggle;
  if (!host) return;
  host.innerHTML = DISCOVER_MODES.map((m) => `
    <button type="button" role="tab" class="${m.view === state.activeView ? "active" : ""}" data-discover-mode="${m.view}" aria-label="${m.label}">
      <span class="discover-mode-label">${m.label}</span>
      ${discoverModeUnreadHtml(m)}
    </button>
  `).join("");
  host.querySelectorAll("[data-discover-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.activeView === btn.dataset.discoverMode) return;
      state.botMenuOpen = false;
      state.contactMenuOpen = false;
      state.activeView = btn.dataset.discoverMode;
      state.discoverSectionView = state.activeView; // 记住子页，rail 回来时恢复
      state.exploreSectionView = state.activeView;
      if (state.isNarrowWindow && viewHasIndexPane(state.activeView)) {
        showNarrowSidebar();
      } else {
        showNarrowContent();
      }
      if (state.activeView === "bot-store" && !(state.skillLibrary.botPresets || []).length && !state.skillsLoading) window.miaLoaders.loadSkills();
      if (state.activeView === "bot-store") window.miaBotStore?.renderBotStore?.();
      renderView();
    });
  });
  syncDiscoverModeUnread(window.miaSocial?.moduleState?.incomingRequests?.length || 0);
  syncDiscoverModeIndicator();
}

function syncDiscoverModeUnread(incomingCount) {
  const host = els.discoverModeToggle;
  const count = Math.max(0, Number(incomingCount) || 0);
  const button = host?.querySelector?.('[data-discover-mode="contacts"]');
  const badge = button?.querySelector?.('[data-discover-unread="contacts"]');
  if (!button || !badge) return;
  if (count > 0) {
    badge.classList.remove("hidden");
    badge.textContent = window.miaUnread?.unreadBadgeText?.(count) || String(count);
    button.setAttribute("aria-label", `联系人，${count} 个新好友请求`);
  } else {
    badge.classList.add("hidden");
    badge.textContent = "0";
    button.setAttribute("aria-label", "联系人");
  }
}

function syncDiscoverModeIndicator() {
  const host = els.discoverModeToggle;
  if (!host) return;
  const active = host.querySelector("button.active");
  if (!active || typeof active.getBoundingClientRect !== "function") return;
  const hostRect = host.getBoundingClientRect();
  if (!hostRect.width) return;
  const activeRect = active.getBoundingClientRect();
  host.style.setProperty("--pill-x", `${activeRect.left - hostRect.left}px`);
  host.style.setProperty("--pill-w", `${activeRect.width}px`);
  host.style.setProperty("--pill-ready", "1");
}
renderDiscoverModeToggle();
function openBotStore() {
  state.botMenuOpen = false;
  state.contactMenuOpen = false;
  state.activeView = "bot-store";
  state.exploreSectionView = "bot-store";
  state.discoverSectionView = "bot-store";
  showNarrowContent();
  if (!(state.skillLibrary.botPresets || []).length && !state.skillsLoading) window.miaLoaders.loadSkills();
  renderView();
  window.miaBotStore?.renderBotStore?.();
}
els.convMenuDiscoverBots?.addEventListener("click", openBotStore);
els.contactMenuDiscoverBots?.addEventListener("click", openBotStore);

els.convMenuAddFriend?.addEventListener("click", () => {
  state.botMenuOpen = false;
  renderView();
  window.miaSocial?.openAddFriendDialog?.();
});
els.addBot?.addEventListener("click", () => {
  state.botMenuOpen = false;
  renderView();
  window.miaBotDialog.openBotDialog();
});
els.convMenuNewGroup?.addEventListener("click", () => {
  state.botMenuOpen = false;
  renderView();
  window.miaSocial?.openCreateGroupDialog?.();
});
els.newContact?.addEventListener("click", (event) => {
  event.stopPropagation();
  state.contactMenuOpen = !state.contactMenuOpen;
  renderView();
});
els.contactMenuAddFriend?.addEventListener("click", () => {
  state.contactMenuOpen = false;
  renderView();
  window.miaSocial?.openAddFriendDialog?.();
});
els.contactMenuAddBot?.addEventListener("click", () => {
  state.contactMenuOpen = false;
  renderView();
  window.miaBotDialog.openBotDialog();
});
els.contactMenuNewGroup?.addEventListener("click", () => {
  state.contactMenuOpen = false;
  renderView();
  window.miaSocial?.openCreateGroupDialog?.();
});
els.userAvatar?.addEventListener("mouseenter", clearProfilePopoverDismiss);
els.userAvatar?.addEventListener("mouseleave", scheduleProfilePopoverDismiss);
els.profileDialog?.addEventListener("mouseenter", clearProfilePopoverDismiss);
els.profileDialog?.addEventListener("mouseleave", scheduleProfilePopoverDismiss);
els.profileDialog?.addEventListener("focusin", clearProfilePopoverDismiss);
els.userAvatar?.addEventListener("click", openProfileDialogFromRenderer);
els.userAvatar?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openProfileDialogFromRenderer();
});
els.closeProfileDialog?.addEventListener("click", () => window.miaBotDialog.closeProfileDialog());
els.closeBotDialog?.addEventListener("click", () => window.miaBotDialog.closeBotDialog());
els.cancelBot?.addEventListener("click", () => window.miaBotDialog.closeBotDialog());
els.closePetGenerateDialog?.addEventListener("click", () => window.miaPetDialog?.closePetGenerateDialog());
els.cancelPetGenerate?.addEventListener("click", () => window.miaPetDialog?.closePetGenerateDialog());
els.addPetReference?.addEventListener("click", () => els.petReferenceFile?.click());
els.petReferenceFile?.addEventListener("change", () => {
  window.miaPetDialog?.readPetReferenceFile(els.petReferenceFile.files?.[0]);
  els.petReferenceFile.value = "";
});
els.petJobButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  state.petJobPanelOpen = !state.petJobPanelOpen;
  window.miaPetDialog?.renderPetJobs();
});
els.petGenerateForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const bot = window.miaBotManager.botByKey(state.petGenerateBotKey);
  if (!bot) return;
  const job = await window.mia.generateBotPet({
    botKey: bot.key,
    bot: {
      id: bot.id || bot.key,
      key: bot.key,
      name: bot.name || bot.displayName || bot.key,
      displayName: bot.displayName || bot.name || bot.key,
      avatarImage: bot.avatarImage || "",
      avatarCrop: bot.avatarCrop || null
    },
    prompt: els.petPrompt?.value || "",
    stylePreset: els.petStylePreset?.value || "codex",
    referenceImages: state.petReferences.map((item) => item.src)
  });
  state.petJobs = [job, ...state.petJobs.filter((item) => item.id !== job.id)];
  state.petJobPanelOpen = true;
  window.miaPetDialog?.closePetGenerateDialog();
  window.miaPetDialog?.renderPetJobs();
});
els.chooseBotAvatar?.addEventListener("click", () => els.botAvatarFile?.click());
els.botAvatarFile?.addEventListener("change", () => {
  window.miaBotDialog.readBotAvatarFile(els.botAvatarFile.files?.[0]);
  els.botAvatarFile.value = "";
});
els.botAvatarPreview?.addEventListener("click", () => {
  const draft = state.botAvatarDraft;
  if (!draft?.image) return;
  window.miaBotDialog.openAvatarCropEditor(draft.image, draft.crop);
});
els.botAvatarPreview?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  const draft = state.botAvatarDraft;
  if (!draft?.image) return;
  window.miaBotDialog.openAvatarCropEditor(draft.image, draft.crop);
});

function hasDraggedFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

els.botForm?.addEventListener("dragover", (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
});
els.botForm?.addEventListener("drop", (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  window.miaBotDialog.readBotAvatarFile(event.dataTransfer?.files?.[0]);
});
els.chooseProfileAvatar?.addEventListener("click", () => els.profileAvatarFile?.click());
els.profileAvatarFile?.addEventListener("change", () => {
  window.miaBotDialog.readProfileAvatarFile(els.profileAvatarFile.files?.[0]);
  els.profileAvatarFile.value = "";
});
els.profileAvatarPreview?.addEventListener("click", () => {
  const draft = state.profileAvatarDraft;
  if (!draft?.image) {
    els.profileAvatarFile?.click();
    return;
  }
  window.miaBotDialog.openAvatarCropEditor(draft.image, draft.crop, "profile");
});
els.profileAvatarPreview?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  const draft = state.profileAvatarDraft;
  if (!draft?.image) {
    els.profileAvatarFile?.click();
    return;
  }
  window.miaBotDialog.openAvatarCropEditor(draft.image, draft.crop, "profile");
});
els.profileForm?.addEventListener("dragover", (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
});
els.profileForm?.addEventListener("drop", (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  window.miaBotDialog.readProfileAvatarFile(event.dataTransfer?.files?.[0]);
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
  if (panRangePx < 0.5) return; // no pan conversation; image fits the stage
  // Mathematically 1px drag = 100/panRangePx percent. At low zoom that ratio
  // explodes (e.g. zoom=1.01 → ~31% per pixel) which feels chaotic. Cap the
  // felt sensitivity at 3% per pixel — the user just has to drag farther to
  // span the full crop range, but every pixel of drag stays smooth.
  const rawPerPx = 100 / panRangePx;
  const sensitivity = Math.min(rawPerPx, 3);
  // Negative: dragging image right exposes its left side (crop x decreases).
  const percentPerPx = -sensitivity;
  window.miaBotDialog.updateAvatarCropEditor({
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
  window.miaBotDialog.updateAvatarCropEditor({
    zoom: state.avatarCropEditor.crop.zoom + direction * 0.03
  });
});
function avatarTrimTimelineDuration() {
  const metadataDuration = Number(els.avatarTrimPreview?.duration) || 0;
  const crop = state.avatarCropEditor?.crop || {};
  const trim = window.miaAvatarMedia?.normalizeTrim?.(crop) || { start: 0, duration: 3 };
  return Math.max(metadataDuration, trim.start + trim.duration, window.miaAvatarMedia?.MAX_TRIM_DURATION || 5);
}
function avatarTrimSecondsFromPointer(event) {
  const rect = els.avatarTrimTimeline?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  return ratio * avatarTrimTimelineDuration();
}
function setAvatarTrimRange(start, duration) {
  const media = window.miaAvatarMedia;
  const total = avatarTrimTimelineDuration();
  const minDuration = media?.MIN_TRIM_DURATION || 1;
  const maxDuration = Math.min(media?.MAX_TRIM_DURATION || 5, total || 5);
  const nextDuration = Math.max(minDuration, Math.min(maxDuration, Number(duration) || maxDuration));
  const maxStart = Math.max(0, total - nextDuration);
  const nextStart = Math.max(0, Math.min(maxStart, Number(start) || 0));
  const trim = media?.normalizeTrim?.({ start: nextStart, duration: nextDuration }) || { start: nextStart, duration: nextDuration };
  if (els.avatarTrimStart) els.avatarTrimStart.value = String(trim.start);
  if (els.avatarTrimDuration) els.avatarTrimDuration.value = String(trim.duration);
  window.miaBotDialog.updateAvatarCropEditor(trim);
}
function beginAvatarTrimDrag(event) {
  if (!state.avatarCropEditor?.open || !window.miaAvatarMedia?.isVideo?.(state.avatarCropEditor.image)) return;
  const timeline = els.avatarTrimTimeline;
  if (!timeline) return;
  event.preventDefault();
  const crop = state.avatarCropEditor.crop || {};
  const trim = window.miaAvatarMedia.normalizeTrim(crop);
  const seconds = avatarTrimSecondsFromPointer(event);
  const mode = event.target?.dataset?.avatarTrimHandle || "track";
  if (mode === "selection") {
    avatarTrimDrag = { mode, start: trim.start, duration: trim.duration, offset: seconds - trim.start };
  } else if (mode === "start" || mode === "end") {
    avatarTrimDrag = { mode, start: trim.start, duration: trim.duration };
  } else {
    const nextStart = seconds - trim.duration / 2;
    setAvatarTrimRange(nextStart, trim.duration);
    avatarTrimDrag = { mode: "selection", start: nextStart, duration: trim.duration, offset: trim.duration / 2 };
  }
  timeline.setPointerCapture?.(event.pointerId);
}
function updateAvatarTrimDrag(event) {
  if (!avatarTrimDrag) return;
  event.preventDefault();
  const seconds = avatarTrimSecondsFromPointer(event);
  const minDuration = window.miaAvatarMedia?.MIN_TRIM_DURATION || 1;
  const maxDuration = window.miaAvatarMedia?.MAX_TRIM_DURATION || 5;
  if (avatarTrimDrag.mode === "start") {
    const end = avatarTrimDrag.start + avatarTrimDrag.duration;
    const lower = Math.max(0, end - maxDuration);
    const upper = Math.max(lower, end - minDuration);
    const nextStart = Math.max(lower, Math.min(seconds, upper));
    setAvatarTrimRange(nextStart, end - nextStart);
    return;
  }
  if (avatarTrimDrag.mode === "end") {
    const nextEnd = Math.max(avatarTrimDrag.start + minDuration, Math.min(seconds, avatarTrimDrag.start + maxDuration, avatarTrimTimelineDuration()));
    setAvatarTrimRange(avatarTrimDrag.start, nextEnd - avatarTrimDrag.start);
    return;
  }
  setAvatarTrimRange(seconds - avatarTrimDrag.offset, avatarTrimDrag.duration);
}
function endAvatarTrimDrag(event) {
  if (!avatarTrimDrag) return;
  avatarTrimDrag = null;
  els.avatarTrimTimeline?.releasePointerCapture?.(event.pointerId);
}
els.avatarTrimTimeline?.addEventListener("pointerdown", beginAvatarTrimDrag);
els.avatarTrimTimeline?.addEventListener("pointermove", updateAvatarTrimDrag);
els.avatarTrimTimeline?.addEventListener("pointerup", endAvatarTrimDrag);
els.avatarTrimTimeline?.addEventListener("pointercancel", endAvatarTrimDrag);
els.avatarTrimPreview?.addEventListener("loadedmetadata", () => {
  window.miaBotDialog.updateAvatarTrimControls?.();
});
if (els.avatarTrimStart) els.avatarTrimStart.addEventListener("input", () => {
  const trim = window.miaAvatarMedia?.normalizeTrim?.({
    ...state.avatarCropEditor.crop,
    start: els.avatarTrimStart.value
  }) || { start: 0, duration: 3 };
  window.miaBotDialog.updateAvatarCropEditor(trim);
});
if (els.avatarTrimDuration) els.avatarTrimDuration.addEventListener("input", () => {
  const trim = window.miaAvatarMedia?.normalizeTrim?.({
    ...state.avatarCropEditor.crop,
    duration: els.avatarTrimDuration.value
  }) || { start: 0, duration: 3 };
  window.miaBotDialog.updateAvatarCropEditor(trim);
});
els.confirmAvatarCrop?.addEventListener("click", async () => {
  if (state.avatarCropEditor.target === "groupConversation") {
    const image = state.avatarCropEditor.image;
    const crop = state.avatarCropEditor.crop;
    window.miaBotDialog.closeAvatarCropEditor();
    window.miaGroupInfoDialog?.applyAvatarFromCropEditor(image, crop);
    return;
  }
  if (state.avatarCropEditor.target === "profile") {
    window.miaBotDialog.setProfileAvatarDraft(state.avatarCropEditor.image, state.avatarCropEditor.crop);
    await saveProfileDraft();
  } else {
    window.miaBotDialog.setBotAvatarDraft(state.avatarCropEditor.image, state.avatarCropEditor.crop);
  }
  window.miaBotDialog.closeAvatarCropEditor();
});
els.cancelAvatarCrop?.addEventListener("click", () => window.miaBotDialog.closeAvatarCropEditor());
els.resetAvatarCrop?.addEventListener("click", () => {
  state.avatarCropEditor.crop = window.miaAvatar.normalizeCrop(window.miaAvatar.avatarDefaultCropForSrc(state.avatarCropEditor.image));
  window.miaBotDialog.renderAvatarCropEditor();
});

// Live-update the avatar preview as the name is typed, so a generated avatar
// follows the name instead of freezing the previous name's initials.
els.profileDisplayName?.addEventListener("input", () => {
  window.miaBotDialog?.renderProfileAvatarDraft?.();
  syncIdentityNameText("profile");
  scheduleProfileDraftSave();
});
els.profileNameText?.addEventListener("click", () => beginIdentityNameEdit("profile"));
els.profileDisplayName?.addEventListener("blur", () => {
  endIdentityNameEdit("profile");
  saveProfileDraft();
});
els.profileDisplayName?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    els.profileDisplayName.blur();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    els.profileDisplayName.blur();
  }
});
els.profileStatusBadge?.addEventListener("change", () => {
  syncStatusBadgeControl("profile");
  saveProfileDraft();
});
document.addEventListener("click", (event) => {
  const button = event.target?.closest?.("[data-status-badge-choice]");
  if (!button) return;
  const kind = button.dataset.statusBadgeTarget || "profile";
  const { select, details } = identityBadgeEls(kind);
  if (!select) return;
  select.value = button.dataset.statusBadgeChoice || "";
  syncStatusBadgeControl(kind);
  if (details) details.open = false;
  if (kind === "profile") saveProfileDraft();
});

els.appearanceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  window.miaSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceTheme.addEventListener("change", () => {
  window.miaSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceFontPreset.addEventListener("change", () => {
  window.miaSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceFontChoices?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-font-preset]");
  if (!button || !els.appearanceFontChoices.contains(button)) return;
  els.appearanceFontPreset.value = button.dataset.fontPreset || "system";
  window.miaSettingsAppearance.scheduleAppearanceSave(0);
});

// Agent working-directory setting (Settings → 模型 → Agent 工作目录).
function refreshWorkspaceSetting() {
  if (!els.workspacePath || !window.mia?.getAgentWorkspace) return;
  window.mia.getAgentWorkspace()
    .then((ws) => { if (ws?.path && els.workspacePath) els.workspacePath.textContent = ws.path; })
    .catch(() => { /* leave placeholder */ });
}

els.workspacePickButton?.addEventListener("click", async () => {
  if (!window.mia?.pickAgentWorkspace) return;
  try {
    const ws = await window.mia.pickAgentWorkspace();
    if (ws?.path && els.workspacePath) els.workspacePath.textContent = ws.path;
    if (ws?.changed) { await refreshRuntime(); renderView(); }
  } catch { /* ignore pick errors */ }
});

els.navLayoutChoices?.forEach((button) => {
  button.addEventListener("click", () => {
    setNavLayout(button.dataset.navLayoutChoice, true);
    renderView();
  });
});

els.appearanceAccentColor?.addEventListener("input", () => {
  window.miaSettingsAppearance.scheduleAppearanceSave();
});

els.appearanceAccentReset?.addEventListener("click", () => {
  if (els.appearanceAccentColor) els.appearanceAccentColor.value = DEFAULT_ACCENT_COLOR;
  window.miaSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceUserBubbleColor?.addEventListener("input", () => {
  window.miaSettingsAppearance.scheduleAppearanceSave();
});

els.appearanceUserBubbleReset?.addEventListener("click", () => {
  if (els.appearanceUserBubbleColor) els.appearanceUserBubbleColor.value = DEFAULT_USER_BUBBLE_COLOR;
  window.miaSettingsAppearance.scheduleAppearanceSave(0);
});

function clearWorkspaceBackgroundImageDraft() {
  if (els.appearanceWorkspaceBackgroundImage) els.appearanceWorkspaceBackgroundImage.value = "";
}

function saveWorkspaceBackgroundColor() {
  clearWorkspaceBackgroundImageDraft();
  window.miaSettingsAppearance.scheduleAppearanceSave(0);
}

els.appearanceWorkspaceBackgroundColor?.addEventListener("input", saveWorkspaceBackgroundColor);

els.appearanceWorkspaceBackgroundColor?.addEventListener("change", saveWorkspaceBackgroundColor);

els.appearanceWorkspaceBackgroundPresets?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-workspace-background-color], [data-workspace-background-image-preset]");
  if (!button || !els.appearanceWorkspaceBackgroundPresets.contains(button)) return;
  if (button.dataset.workspaceBackgroundImagePreset) {
    if (els.appearanceWorkspaceBackgroundImage) {
      els.appearanceWorkspaceBackgroundImage.value = button.dataset.workspaceBackgroundImage || "";
    }
    window.miaSettingsAppearance.scheduleAppearanceSave(0);
    return;
  }
  if (els.appearanceWorkspaceBackgroundColor) {
    els.appearanceWorkspaceBackgroundColor.value = button.dataset.workspaceBackgroundColor || "#f0f0f3";
  }
  clearWorkspaceBackgroundImageDraft();
  window.miaSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceWorkspaceBackgroundReset?.addEventListener("click", () => {
  clearWorkspaceBackgroundImageDraft();
  window.miaSettingsAppearance.resetWorkspaceBackground();
});

els.appearanceShowDesktopNotifications?.addEventListener("click", () => {
  window.miaSettingsAppearance.toggleSettingsSwitch(els.appearanceShowDesktopNotifications);
});

els.appearanceShowUserAvatar?.addEventListener("click", () => {
  window.miaSettingsAppearance.toggleSettingsSwitch(els.appearanceShowUserAvatar);
});

els.appearanceShowAssistantAvatar?.addEventListener("click", () => {
  window.miaSettingsAppearance.toggleSettingsSwitch(els.appearanceShowAssistantAvatar);
});

// Live-update the bot avatar preview as the name is typed (mirrors the
// profile dialog), so a generated avatar follows the name in create mode.
els.botName?.addEventListener("input", () => {
  window.miaBotDialog?.renderBotAvatarDraft?.();
  syncIdentityNameText("bot");
});
els.botNameText?.addEventListener("click", () => beginIdentityNameEdit("bot"));
els.botName?.addEventListener("blur", () => endIdentityNameEdit("bot"));
els.botName?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    els.botName.blur();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    els.botName.blur();
  }
});
els.botStatusBadge?.addEventListener("change", () => syncStatusBadgeControl("bot"));

els.botForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const existingBot = els.botKey?.value
    ? window.miaBotManager?.botByKey?.(els.botKey.value)
    : null;
  const existingBotBio = existingBot?.bio || existingBot?.description || "";
  const selectedRuntime = window.miaBotDialog?.readSelectedRuntimeTarget?.() || {};
  const runtimeKind = selectedRuntime.runtimeKind || existingBot?.runtimeKind || "desktop-local";
  const targetDeviceId = selectedRuntime.targetDeviceId || state.runtime?.localDevice?.id || "";
  const targetDeviceName = selectedRuntime.targetDeviceName || state.runtime?.localDevice?.name || "";
  const agentEngine = selectedRuntime.agentEngine || "hermes";
  const existingTargetDeviceId = existingBot?.targetDeviceId || existingBot?.target_device_id || existingBot?.deviceId || existingBot?.device_id || existingBot?.runtimeConfig?.deviceId || "";
  const runtimeChanged = state.botDialogMode !== "edit"
    || runtimeKind !== (existingBot?.runtimeKind || existingBot?.runtime_kind || "desktop-local")
    || (runtimeKind === "desktop-local" && String(targetDeviceId || "") !== String(existingTargetDeviceId || ""))
    || (runtimeKind === "desktop-local" && String(agentEngine || "") !== String(existingBot?.agentEngine || existingBot?.agent_engine || "hermes"));
  const bot = {
    key: els.botKey?.value || "",
    name: els.botName.value,
    sourceKinds: existingBot?.sourceKinds || [],
    agentEngine,
    targetDeviceId,
    targetDeviceName,
    avatarImage: state.botAvatarDraft.image || els.botAvatar.value,
    avatarCrop: window.miaAvatar.normalizeCrop(state.botAvatarDraft.crop),
    color: state.botAvatarDraft.color || "",
    statusBadge: statusBadgeForPreset(els.botStatusBadge?.value || ""),
    bio: state.botDialogMode === "create" ? els.botSeed.value : existingBotBio,
    description: state.botDialogMode === "create" ? els.botSeed.value : existingBotBio,
    personaText: els.botSeed.value
  };
  const saved = await window.miaBotCommands.saveBot({
    state,
    bot,
    runtimeKind,
    isCreate: state.botDialogMode !== "edit",
    activateRuntime: runtimeChanged,
    api: window.mia,
    social: window.miaSocial,
    cloudModelEntries: platformHermesModelEntries,
  });
  if (saved.runtime) state.runtime = saved.runtime;
  const savedKey = saved.key || "";
  const cloudConversation = saved.conversation || null;
  if (runtimeKind !== "cloud-claude-code" && savedKey) state.activeKey = savedKey;
  state.botDialogOpen = false;
  // If this was the initial onboarding create-bot step, mark onboarding done.
  if (state.onboardingStep && state.onboardingStep !== "done") {
    advanceOnboarding("done");
    state.setupGuideDismissed = true;
    localStorage.setItem(SETUP_GUIDE_DISMISSED_KEY, "1");
  }
  if (cloudConversation?.id) {
    state.activeKey = "";
    state.activeContactKey = savedKey;
    window.miaSocial?.setActiveConversationId(cloudConversation.id);
    state.forceScrollToBottom = true;
    render();
  } else if (savedKey) await openBotConversation(savedKey);
  else render();
});

els.modelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const entry = window.miaModelHelpers.selectedModelEntry();
  if (!entry || window.miaModelSettings.providerIsConnected(entry.provider)) return;
  const needsApiKey = entry.provider !== "openai-codex" && entry.provider !== "lmstudio" && !String(entry.authType || "").startsWith("oauth");
  if (needsApiKey && !els.modelApiKey.value.trim()) {
    setText(els.modelAuthState, `需要填写 ${entry.apiKeyEnv || "API Key"}`);
    return;
  }
  if (entry) window.miaModelSettings.applyModelEntryToFields(entry);
  state.runtime = await window.mia.saveModel({
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
  if (window.miaMessageHelpers.isComposerComposing(event)) return;
  if (window.miaComposer.handleComposerEditorKeydown(event)) return;
  if (window.miaComposer.handleComposerSkillBackspace(event)) return;
  if (window.miaComposer.handlePathPasteRefBackspace(event)) return;
  if (window.miaComposer.handlePathPasteShortcut(event)) return;
  if (state.mentionMenuOpen) {
    const items = window.miaComposer.filteredMentionMembers();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.mentionSelectedIndex = items.length ? (state.mentionSelectedIndex + 1) % items.length : 0;
      window.miaComposer.renderMentionMenu();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.mentionSelectedIndex = items.length ? (state.mentionSelectedIndex - 1 + items.length) % items.length : 0;
      window.miaComposer.renderMentionMenu();
      return;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      const pick = items[state.mentionSelectedIndex];
      if (pick) {
        event.preventDefault();
        window.miaComposer.applyMentionPick(pick.member);
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      window.miaComposer.closeMentionMenu();
      return;
    }
  }
  if (state.slashMenuOpen) {
    const commands = window.miaComposer.filteredSlashCommands();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.slashSelectedIndex = commands.length ? (state.slashSelectedIndex + 1) % commands.length : 0;
      window.miaComposer.renderSlashCommandMenu();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.slashSelectedIndex = commands.length ? (state.slashSelectedIndex - 1 + commands.length) % commands.length : 0;
      window.miaComposer.renderSlashCommandMenu();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const command = commands[state.slashSelectedIndex];
      if (command) {
        window.miaComposer.fillSlashCommand(command);
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const command = commands[state.slashSelectedIndex];
      if (command) window.miaComposer.sendSlashCommand(command);
      return;
    }
    if (event.key === "Escape") {
      state.slashMenuOpen = false;
      window.miaComposer.renderSlashCommandMenu();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.chatForm.requestSubmit();
  }
});

window.mia?.onPathPasteText?.((payload = {}) => {
  if (!els.chatInput || document.activeElement !== els.chatInput) return;
  window.miaComposer.insertPathPastePayload(payload);
});

els.chatInput.addEventListener("compositionstart", () => {
  els.chatInput.dataset.composing = "true";
});

els.chatInput.addEventListener("compositionend", () => {
  window.miaMessageHelpers.noteCompositionEnded();
  els.chatInput.dataset.composing = "false";
  window.miaComposer.reconcilePathPasteRefsFromInput();
  window.miaMessageHelpers.resizeChatInput();
  window.miaComposer.updateSlashCommandState();
  window.miaComposer.updateMentionMenuState();
  renderSendButton();
});

els.chatInput.addEventListener("input", () => {
  window.miaComposer.reconcilePathPasteRefsFromInput();
  window.miaMessageHelpers.resizeChatInput();
  window.miaComposer.updateSlashCommandState();
  window.miaComposer.updateMentionMenuState();
  renderSendButton();
});
els.chatInput.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  event.stopPropagation();
  window.miaComposer.closeComposerAddMenu();
  window.miaComposer.closeSkillPicker();
  els.chatInput.focus();
  window.mia?.showEditContextMenu?.({ x: event.clientX, y: event.clientY });
});
els.chatInput.addEventListener("click", () => {
  window.miaComposer.updateSlashCommandState();
  window.miaComposer.updateMentionMenuState();
});
els.chatInput.addEventListener("blur", () => {
  // Delay close so a click on the menu still fires before we hide it.
  setTimeout(() => window.miaComposer.closeMentionMenu(), 120);
});
els.composerAdd?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  state.composerAddMenuOpen = !state.composerAddMenuOpen;
  state.slashMenuOpen = false;
  if (state.composerAddMenuOpen) window.miaComposer.closeSkillPicker();
  window.miaComposer.renderSlashCommandMenu();
  window.miaComposer.renderComposerAddMenu();
});
els.composerAddMenu?.addEventListener("click", (event) => {
  const action = event.target.closest("[data-composer-add]")?.dataset.composerAdd;
  if (!action) return;
  event.preventDefault();
  if (action === "attachment") {
    window.miaComposer.closeComposerAddMenu();
    els.composerAttachmentInput?.click();
    return;
  }
  if (action === "skill") {
    window.miaComposer.openSkillPicker();
    return;
  }
  els.chatInput?.focus();
});
els.composerAddMenu?.addEventListener("pointerover", (event) => {
  const action = event.target.closest("[data-composer-add]")?.dataset.composerAdd;
  if (action === "skill") {
    window.miaComposer.openSkillPicker();
    return;
  }
  if (action) window.miaComposer.scheduleSkillPickerHoverClose();
});
els.composerAddMenu?.addEventListener("pointerout", (event) => {
  const item = event.target.closest('[data-composer-add="skill"]');
  if (!item) return;
  if (window.miaComposer.targetIsSkillPickerZone(event.relatedTarget)) return;
  window.miaComposer.scheduleSkillPickerHoverClose();
});
els.skillPicker?.addEventListener("pointerenter", () => window.miaComposer.cancelSkillPickerHoverClose());
els.skillPicker?.addEventListener("pointerleave", (event) => {
  if (window.miaComposer.targetIsSkillPickerZone(event.relatedTarget)) return;
  window.miaComposer.scheduleSkillPickerHoverClose();
});

els.skillPickerSearch?.addEventListener("input", () => {
  state.skillPickerFilter = els.skillPickerSearch.value || "";
  window.miaComposer.renderSkillPicker();
});
els.closeSkillPicker?.addEventListener("click", () => window.miaComposer.closeSkillPicker());
els.skillPickerBody?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-skill-pick]");
  if (!button) return;
  window.miaComposer.insertSkillIntoComposer(button.dataset.skillPick);
  window.miaComposer.closeComposerAddMenu();
  window.miaComposer.closeSkillPicker();
});
els.skillPickerSearch?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.miaComposer.closeSkillPicker();
  if (event.key === "Enter") {
    event.preventDefault();
    const first = els.skillPickerBody?.querySelector("[data-skill-pick]");
    if (first) {
      window.miaComposer.insertSkillIntoComposer(first.dataset.skillPick);
      window.miaComposer.closeComposerAddMenu();
      window.miaComposer.closeSkillPicker();
    }
  }
});
document.addEventListener("click", (event) => {
  if (!state.skillPickerOpen) return;
  if (els.skillPicker?.contains(event.target)) return;
  if (els.composerAddMenu?.contains(event.target)) return;
  if (els.composerAdd?.contains(event.target)) return;
  window.miaComposer.closeSkillPicker();
});
els.composerAttachmentInput?.addEventListener("change", () => {
  window.miaComposer.addComposerFiles(els.composerAttachmentInput.files);
  els.composerAttachmentInput.value = "";
});
els.composerAttachments?.addEventListener("click", (event) => {
  if (event.target.closest("[data-attachment-remove]")) return;
  els.chatInput?.focus();
});
els.composerReply?.addEventListener("click", (event) => {
  if (!event.target.closest("[data-clear-reply]")) return;
  state.replyDraft = null;
  window.miaMessageHelpers.renderComposerReply();
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
  window.miaComposer.addComposerFiles(event.dataTransfer.files);
});
els.chatInput?.addEventListener("paste", (event) => {
  if (event.clipboardData?.files?.length) {
    window.miaComposer.addComposerFiles(event.clipboardData.files);
    return;
  }
  window.miaComposer.handleComposerPlainTextPaste(event);
});
const messageLinkSelector = "a.message-link[data-external-link], a.message-link[data-local-file-path]";
const TRACE_LINK_MODIFIER_CLASS = "trace-link-modifier-active";
function traceLinkUsesAppleModifier() {
  const platform = typeof navigator !== "undefined" ? String(navigator.platform || "") : "";
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

function isTraceLinkModifierPressed(event) {
  return traceLinkUsesAppleModifier() ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
}

function setTraceLinkModifierActive(active) {
  els.chat?.classList.toggle(TRACE_LINK_MODIFIER_CLASS, Boolean(active));
}

function updateTraceLinkModifierState(event) {
  setTraceLinkModifierActive(isTraceLinkModifierPressed(event));
}

function isTraceLink(link) {
  return link?.dataset?.traceLink === "true";
}

function shouldOpenMessageLink(link, event) {
  return !isTraceLink(link) || isTraceLinkModifierPressed(event);
}

function openMessageLink(link) {
  if (link.dataset.localFilePath) {
    window.mia?.openLocalFile?.(link.dataset.localFilePath);
    return;
  }
  if (link.dataset.externalLink) {
    window.mia?.openExternal?.(link.dataset.externalLink);
  }
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Meta" || event.key === "Control" || event.metaKey || event.ctrlKey) {
    updateTraceLinkModifierState(event);
  }
});
window.addEventListener("keyup", (event) => {
  if (event.key === "Meta" || event.key === "Control" || event.metaKey || event.ctrlKey) {
    updateTraceLinkModifierState(event);
  }
});
window.addEventListener("blur", () => {
  setTraceLinkModifierActive(false);
});

els.sendChat.addEventListener("click", async (event) => {
  const activeRun = window.miaSocial?.activeConversationRun?.();
  if (activeRun?.status !== "running") return;
  event.preventDefault();
  event.stopPropagation();
  await window.mia.stopChat?.({
    conversationId: window.miaSocial?.getActiveConversationId?.() || "",
    runId: activeRun?.runId || "",
    turnId: activeRun?.turnId || ""
  });
  renderSendButton();
});
els.chat.addEventListener("click", async (event) => {
  const jumpBtn = event.target.closest?.("[data-jump-task]");
  if (jumpBtn && els.chat.contains(jumpBtn)) {
    const taskId = jumpBtn.dataset.jumpTask;
    state.selectedTaskId = taskId;
    state.selectedRunId = "";
    state.activeView = "tasks";
    state.tasksUnread?.delete(taskId);
    window.miaTasksPanel?.updateTasksRailBadge();
    render();
    return;
  }
  const resumeButton = event.target.closest?.("[data-command-resume-id]");
  if (resumeButton && els.chat.contains(resumeButton)) {
    event.preventDefault();
    event.stopPropagation();
    const sessionIdToResume = String(resumeButton.dataset.commandResumeId || "").trim();
    if (!sessionIdToResume || resumeButton.disabled) return;
    const sourceDeviceId = String(resumeButton.dataset.commandSourceDeviceId || "").trim();
    const currentDeviceId = String(state.runtime?.cloud?.deviceId || "").trim();
    if (sourceDeviceId && currentDeviceId && sourceDeviceId !== currentDeviceId) {
      appendTransientChat("assistant", "这条 /resume 列表来自另一台设备。请在当前设备重新发送 /resume，生成本机可恢复的 session 列表。");
      return;
    }
    const engine = resumeButton.dataset.commandResumeEngine || window.miaEngineOptions.activeAgentEngine();
    const bot = activePersona() || { key: state.activeKey };
    resumeButton.disabled = true;
    resumeButton.classList.add("loading");
    try {
      const result = await window.mia.executeAgentCommand?.({
        engine,
        commandName: "/resume",
        args: [sessionIdToResume],
        context: {
          sessionId: window.miaSocial?.getActiveConversationId?.() || "",
          bot
        }
      });
      const content = result?.content && typeof result.content === "object"
        ? result.content.content
        : result?.content;
      appendTransientChat("assistant", String(content || "已切换外部会话。"));
    } catch (error) {
      appendTransientChat("assistant", `恢复外部会话失败: ${error.message}`);
    } finally {
      resumeButton.classList.remove("loading");
      resumeButton.disabled = false;
    }
    return;
  }
  const imageButton = event.target.closest(".message-attachment.image");
  if (imageButton && els.chat.contains(imageButton)) {
    event.preventDefault();
    event.stopPropagation();
    openImagePreview(imageButton.dataset.imageSrc || imageButton.querySelector("img")?.src || "", imageButton.title || "");
    return;
  }
  const pathRefChip = event.target.closest("[data-path-ref-path]");
  if (pathRefChip && els.chat.contains(pathRefChip)) {
    event.preventDefault();
    event.stopPropagation();
    await openPathRefPreviewFromChip(pathRefChip);
    return;
  }
  const setupButton = event.target.closest("[data-setup-action]");
  if (setupButton && els.chat.contains(setupButton)) {
    event.preventDefault();
    event.stopPropagation();
    await handleSetupGuideAction(setupButton);
    return;
  }
  const link = event.target.closest(messageLinkSelector);
  if (link && els.chat.contains(link)) {
    if (!shouldOpenMessageLink(link, event)) return;
    event.preventDefault();
    event.stopPropagation();
    openMessageLink(link);
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
    const restingText = button.dataset.slotCopyLabel || button.dataset.slotTextValue || button.textContent || "复制";
    button.dataset.slotCopyLabel = restingText;
    button.classList.add("copied");
    button.disabled = true;
    flashAnimatedText(button, "已复制", { restingText, revertAfter: 900 });
    setTimeout(() => {
      button.classList.remove("copied");
      button.disabled = false;
    }, 900);
  }
});
els.chat.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-translation]");
  if (!button || !els.chat.contains(button)) return;
  const message = window.miaMessageHelpers.messageAtIndex(Number(button.dataset.copyTranslation));
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
  const pathRefChip = event.target.closest("[data-path-ref-path]");
  if (pathRefChip && els.chat.contains(pathRefChip)) {
    event.preventDefault();
    await openPathRefPreviewFromChip(pathRefChip);
    return;
  }
  const link = event.target.closest(messageLinkSelector);
  if (link && els.chat.contains(link)) {
    if (!shouldOpenMessageLink(link, event)) return;
    event.preventDefault();
    openMessageLink(link);
    return;
  }
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
  if (window.miaMessageHelpers.isComposerComposing()) return;
  // Branch: a cloud conversation (dm / group / bot) is active → send via social.
  if (window.miaSocial?.getActiveConversationId?.()) {
    const conversationId = window.miaSocial.getActiveConversationId();
    const composerText = els.chatInput.value;
    const pendingAttachments = [...state.pendingAttachments].slice(0, 20);
    let conversationText = window.miaComposer.expandPathPasteRefsForSend(composerText);
    if (!conversationText.trim() && !pendingAttachments.length) return;
    // Cloud conversations have no reply_to column, so a quote-reply is embedded as a
    // markdown blockquote at the head of the message — visible to every member.
    const conversationReply = state.replyDraft ? { ...state.replyDraft } : null;
    if (conversationReply && conversationReply.content) {
      const quoted = String(conversationReply.content).split("\n").map((line) => `> ${line}`).join("\n");
      conversationText = `> **${conversationReply.author || "回复"}**\n${quoted}\n\n${conversationText}`;
      state.replyDraft = null;
      window.miaMessageHelpers.renderComposerReply();
    }
    els.chatInput.value = "";
    window.miaComposer.clearPathPasteRefs();
    state.pendingAttachments = [];
    window.miaMessageHelpers.resizeChatInput();
    window.miaComposer.renderComposerAttachments();
    renderSendButton();
    // Composer skill chips ride along with the message — stored on it, shown in
    // the bubble, used by the bot responder. Only send them for a bot conversation
    // (they drive that bot's AI) and only when they were attached in THIS conversation
    // (guards a programmatic conversation switch with no intervening render). Clear them
    // on send regardless: the chip belongs to this message, not the next one.
    const chips = (state.composerActiveSkills || []).filter((skill) => skill && skill.id);
    const chipsBelongHere = chips.length && state.composerSkillsConversationId === conversationId && Boolean(activeConversationBotContext());
    const messageSkills = chipsBelongHere
      ? chips.map((skill) => ({ id: String(skill.id), name: skill.name || skill.id }))
      : null;
    if (chips.length) {
      state.composerActiveSkills = [];
      state.composerSkillSelected = false;
      window.miaComposer.renderComposerSkills();
    }
    await window.miaSocial.sendInActiveConversation(conversationText, {
      ...(messageSkills ? { skills: messageSkills } : {}),
      attachments: pendingAttachments
    });
    return;
  }
  // Cloud-only: with no active conversation there is nothing to send. The chat area
  // shows the login guide for signed-out users.
});

function advanceOnboarding(step) {
  state.onboardingStep = step;
  try { localStorage.setItem("mia.onboardingStep", step); } catch { /* ignore */ }
}

async function completeAgentSetup(engine, options = {}) {
  const pickedEngine = String(engine || "").trim();
  if (pickedEngine) {
    state.onboardingPickedEngine = pickedEngine;
    state.preferredAgentEngine = pickedEngine;
    try { localStorage.setItem("mia.preferredAgentEngine.v1", pickedEngine); } catch { /* ignore */ }
  }
  state.agentSetupSkipped = Boolean(options.skipped);
  state.setupGuideDismissed = true;
  try {
    if (state.agentSetupSkipped) localStorage.setItem(AGENT_SETUP_SKIPPED_KEY, "1");
    else localStorage.removeItem(AGENT_SETUP_SKIPPED_KEY);
    localStorage.setItem(SETUP_GUIDE_DISMISSED_KEY, "1");
  } catch { /* ignore */ }
  advanceOnboarding("done");
  await window.mia.window?.showMain?.();
}

function afterEnginePicked(engine) {
  completeAgentSetup(engine).finally(() => {
    renderView();
  });
}

async function runHermesSetupAction(button, action) {
  // Generic per-engine install/repair. engineId comes from the button; defaults
  // to hermes for the legacy install-hermes action. On success we re-detect and
  // re-render in place (the wizard's "进入 Mia" button is the explicit finish),
  // so installing one engine never auto-leaves onboarding.
  const engineId = String(button?.dataset?.engine || "").trim() || "hermes";
  const repair = action === "repair-hermes";
  const retry = action === "retry-install-hermes";
  state.agentSetupInstallInFlight = true;
  state.agentSetupInstallEngine = engineId;
  state.agentSetupInstallMessage = repair ? "Repairing..." : retry ? "Retrying install..." : "Installing...";
  state.agentSetupInstallStage = "";
  state.agentSetupInstallPercent = 0;
  state.agentSetupInstallErrors = state.agentSetupInstallErrors || {};
  delete state.agentSetupInstallErrors[engineId];
  button.disabled = true;
  document.querySelectorAll('[data-setup-action="finish-agent-scan"], [data-onb-action="finish"], [data-setup-action^="install-"], [data-setup-action="retry-install-hermes"], [data-setup-action="repair-hermes"]').forEach((el) => {
    el.disabled = true;
  });
  const original = button.textContent;
  button.textContent = repair ? "修复中..." : retry ? "重试中..." : "安装中...";
  try {
    if (engineId === "hermes") state.hermesInstallError = "";
    state.runtime = repair ? await window.mia.repairEngine() : await window.mia.installEngine(engineId);
    delete state.agentSetupInstallErrors[engineId];
    await window.miaLoaders.loadModelCatalog();
    state.agentSetupSkipped = false;
    try { localStorage.removeItem(AGENT_SETUP_SKIPPED_KEY); } catch { /* ignore */ }
    await refreshRuntime();
  } catch (error) {
    const verb = repair ? "修复" : "安装";
    const label = engineId === "hermes" ? "官方 Hermes" : engineId;
    const message = `${label} ${verb}失败：${error.message || error}`;
    state.agentSetupInstallMessage = message;
    state.agentSetupInstallErrors = state.agentSetupInstallErrors || {};
    state.agentSetupInstallErrors[engineId] = message;
    if (engineId === "hermes") state.hermesInstallError = message;
    appendTransientChat("assistant", message);
    await refreshRuntime();
  } finally {
    state.agentSetupInstallInFlight = false;
    state.agentSetupInstallEngine = "";
    state.agentSetupInstallStage = "";
    state.agentSetupInstallPercent = 0;
    button.disabled = false;
    button.textContent = original;
    renderView();
  }
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
    openSettingsView("model");
    return true;
  }
  if (action === "open-agent-settings") {
    openSettingsView("model");
    return true;
  }
  if (action === "continue-no-agent") {
    await completeAgentSetup("", { skipped: true });
    renderView();
    return true;
  }
  if (action === "finish-agent-scan") {
    if (state.agentSetupInstallInFlight) return true;
    await completeAgentSetup("", { skipped: !hasUsableLocalAgent() });
    renderView();
    return true;
  }
  if (action === "retry-install-hermes" || action === "repair-hermes" || action.startsWith("install-")) {
    if (state.agentSetupInstallInFlight) return true;
    await runHermesSetupAction(button, action);
    return true;
  }
  if (action === "use-engine") {
    const engine = String(button.dataset.engine || "");
    if (!["hermes", "claude-code", "codex"].includes(engine)) return true;
    afterEnginePicked(engine);
    return true;
  }
  return false;
}

function openInitialBotDialog() {
  const engine = state.onboardingPickedEngine || "hermes";
  const seed = {
    name: "Mia",
    agentEngine: engine,
    bio: "你是 Mia，一个轻松友好的桌面 AI 伙伴，回答简洁、口语化。"
  };
  // Reuse existing bot create dialog with prefilled values.
  if (typeof window.miaBotDialog?.openBotDialog === "function") {
    window.miaBotDialog.openBotDialog(null, seed);
  } else {
    // Fallback: at least open settings
    openSettingsView("model");
  }
}

window.miaMessageHelpers.resizeChatInput();
function startAfterFirstPaint() {
  const start = () => {
    try { window.mia?.notifyFirstPaint?.(); } catch { /* main may not expose this in older builds */ }
    const blockStartup = Boolean(window.miaStartupOverlay?.isBlocking?.());
    if (blockStartup) window.miaStartupOverlay?.setStatus?.("正在准备 Mia");
    initializeRuntime({ blockStartup }).then(async () => {
      if (!blockStartup) return;
      window.miaStartupOverlay?.setWelcome?.();
      await delay(850);
      await window.miaStartupOverlay?.finish?.();
    }).catch((error) => {
      console.error("Failed to initialize Mia runtime", error);
      const message = error?.message || String(error || "Unknown error");
      if (blockStartup) window.miaStartupOverlay?.fail?.(message);
      els.chat.innerHTML = `
        <article class="setup-guide bootstrap">
          <div class="setup-guide-main">
            <strong>Mia 初始化失败</strong>
            <p>${window.miaMarkdown.escapeHtml(message)}</p>
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
setInterval(refreshRuntime, 2000);

(function wireTrafficLights() {
  const controls = document.getElementById("windowControls");
  const spacer = document.getElementById("trafficSpacer");
  const api = window.mia?.window;
  if (!api) return;
  const isWindows = rendererPlatform === "win32";
  const controlRoot = controls || spacer;
  const maximizeButton = controlRoot?.querySelector('[data-action="green"]');
  const applyMaximized = (maximized) => {
    document.body.classList.toggle("window-maximized", Boolean(maximized));
    if (!isWindows || !maximizeButton) return;
    const label = maximized ? "还原" : "最大化";
    maximizeButton.setAttribute("aria-label", label);
    maximizeButton.title = label;
  };
  if (isWindows && maximizeButton) {
    maximizeButton.setAttribute("aria-label", "最大化");
    maximizeButton.title = "最大化";
  }
  if (!controlRoot) return;
  const handleControlClick = (event) => {
    const btn = event.target.closest(".window-control, .traffic-light");
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    const action = btn.dataset.action;
    if (action === "close") api.close();
    else if (action === "minimize") api.minimize();
    else if (action === "green") {
      const task = isWindows ? (api.maximize?.() || api.green()) : api.green();
      Promise.resolve(task).then((state) => {
        if (state && Object.prototype.hasOwnProperty.call(state, "maximized")) applyMaximized(state.maximized);
      }).catch(() => {});
    }
  };
  controlRoot.addEventListener("click", handleControlClick);
  controlRoot.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".window-control, .traffic-light")) return;
    event.stopPropagation();
  });
  const applyFocus = (focused) => {
    desktopWindowFocused = Boolean(focused);
    document.body.classList.toggle("window-blurred", !focused);
  };
  const applyFullscreen = (fullscreen) => {
    document.body.classList.toggle("window-fullscreen", Boolean(fullscreen));
    if (controls) controls.dataset.fullscreen = fullscreen ? "true" : "false";
    if (spacer) spacer.dataset.fullscreen = fullscreen ? "true" : "false";
  };
  api.onFocusState?.(applyFocus);
  api.onFullscreen?.(applyFullscreen);
  api.onMaximized?.(applyMaximized);
  api.state?.().then((s) => {
    if (s) {
      applyFocus(s.focused);
      applyFullscreen(s.fullscreen);
      applyMaximized(s.maximized);
    }
  }).catch(() => {});
})();
