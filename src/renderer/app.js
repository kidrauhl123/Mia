function assertReactRendererReady() {
  const requiredGlobals = [
    "miaReactRenderer",
    "miaReactBridge",
    "miaReactMessageList",
    "miaReactConversationList",
    "miaReactConversationFolders",
    "miaReactComposerMenus",
    "miaReactComposerContent",
    "miaReactPermissionBanner",
    "miaReactSelectMenu",
    "miaReactBotStore",
    "miaReactContacts",
    "miaReactSkills",
    "miaReactTasks",
    "miaReactSettingsCompat",
    "miaReactChatMenus",
    "miaReactDialogs"
  ];
  const missing = requiredGlobals.filter((name) => !window[name]);
  const framework = document.documentElement?.dataset?.rendererFramework;
  if (!missing.length && framework === "react") return;
  const detail = missing.length
    ? `missing ${missing.join(", ")}`
    : `unexpected framework ${framework || "unset"}`;
  const overlay = document.getElementById("startupOverlay");
  const status = document.getElementById("startupOverlayStatus");
  overlay?.classList?.remove("hidden");
  if (status) status.textContent = "Mia 界面加载失败，请重启应用。";
  document.body?.setAttribute?.("data-renderer-boot-failure", "react-runtime");
  throw new Error(`React renderer failed to initialize: ${detail}`);
}

assertReactRendererReady();

const SETUP_GUIDE_DISMISSED_KEY = window.miaAppState.SETUP_GUIDE_DISMISSED_KEY;
const AGENT_SETUP_SKIPPED_KEY = window.miaAppState.AGENT_SETUP_SKIPPED_KEY;
const { ConversationKind, GroupCoordinator, MemberKind, SenderKind } = (typeof window !== "undefined" && window.miaConversationKinds) || require("../shared/conversation-kinds");
const { prepareOutgoingMessage } = (typeof window !== "undefined" && window.miaSendPipeline) || require("../shared/send-pipeline");
const sessionHistory = (typeof window !== "undefined" && window.miaSessionHistory) || require("../shared/session-history");
const SIDEBAR_WIDTH_MIN = 260;
const SIDEBAR_WIDTH_MAX = 460;
const SIDEBAR_WIDTH_DEFAULT = 320;
const SHELL_SINGLE_MAX_WIDTH = 720;
const messageLinkSelector = "a.message-link[data-external-link], a.message-link[data-local-file-path]";
let skillPickerHoverCloseTimer = 0;
let lastNativeControlsLayout = "";
const botRuntimeControlCache = new Map();
const botRuntimeControlInFlight = new Set();
const botRuntimeControlOptionsCache = new Map();
// Runtime controls belong to a conversation session. Keep both the snapshot
// and its load lifecycle keyed by conversation so a second chat with the same
// bot cannot reuse a stale ACP session snapshot.
const botRuntimeControlOptionsInFlight = new Map();
const botRuntimeControlOptionsLoadStates = new Map();
const MAX_RUNTIME_CONTROL_CACHE_ENTRIES = 32;
const platformModelCatalog = { loaded: false, loading: false, entries: [] };

function pruneRuntimeControlCaches(protectedKey = "") {
  const protectedKeys = protectedKey ? [protectedKey] : [];
  const prune = window.miaResourceCache?.pruneMap;
  if (typeof prune !== "function") return;
  prune(botRuntimeControlCache, {
    maxEntries: MAX_RUNTIME_CONTROL_CACHE_ENTRIES,
    protectedKeys
  });
  prune(botRuntimeControlOptionsCache, {
    maxEntries: MAX_RUNTIME_CONTROL_CACHE_ENTRIES,
    protectedKeys
  });
  prune(botRuntimeControlOptionsLoadStates, {
    maxEntries: MAX_RUNTIME_CONTROL_CACHE_ENTRIES,
    protectedKeys
  });
}
const runtimeRequestBackoff = window.miaRequestBackoff?.createRequestBackoff?.({
  baseDelayMs: 1_000,
  maxDelayMs: 30_000
}) || {
  canRun: () => true,
  fail: () => ({ delayMs: 0, retryAt: 0 }),
  reset: () => {},
  resetAll: () => {},
  succeed: () => {}
};
const PLATFORM_MODEL_CATALOG_REQUEST_KEY = "platform-model-catalog";
let socialBootstrapInFlight = null;
let starterEngineBotsInFlight = null;
let personaSearchTimer = 0;
let personaSearchSerial = 0;
let shellLayoutTransitionTimer = 0;
let lastConversationFolderKey = null;
let conversationFolderMotion = { key: "", direction: 1 };
let personaFolderAnimationTimer = 0;
let chatConversationMenuRenderSignature = "";
const RUNTIME_FALLBACK_REFRESH_MS = 60_000;
const CONVERSATION_FOLDER_ORDER_KEY = "mia.conversationFolderOrder.v1";
const CONVERSATION_FOLDER_ALL_KEY = "__all__";
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
const rendererViewLifecycle = window.miaViewLifecycle?.createViewLifecycle?.({
  document,
  initialView: state.activeView
}) || null;
let rendererLifecycleSubscribed = false;
const rendererPerformanceEnabled = (() => {
  try {
    return new URLSearchParams(window.location.search || "").get("perf") === "1"
      || localStorage.getItem("mia.performanceDiagnostics") === "1";
  } catch {
    return false;
  }
})();
const rendererPerformance = window.miaPerformanceDiagnostics?.createPerformanceDiagnostics?.({
  enabled: rendererPerformanceEnabled,
  performance: window.performance,
  document,
  window
}) || {
  enabled: false,
  measure: (_name, operation) => operation(),
  record: () => {},
  snapshot: () => ({ enabled: false }),
  start: () => {},
  stop: () => {}
};
window.__miaPerformance = {
  enabled: rendererPerformance.enabled,
  measure: (name, operation) => rendererPerformance.measure(name, operation),
  record: (name, value) => rendererPerformance.record(name, value),
  snapshot: () => rendererPerformance.snapshot({
    view: state.activeView,
    social: window.miaSocial?.getPerformanceStats?.() || {}
  })
};
let coreStartupProgressTimer = 0;
let coreStartupSettleTimer = 0;
let coreStartupNudgeTimer = 0;
let coreStartupWatchdogTimer = 0;
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
  engineRowHermesButton: document.querySelector('[data-engine-row="hermes"]'),
  engineRowHermesActions: document.getElementById("engineRowHermesActions"),
  engineRowClaudeActions: document.getElementById("engineRowClaudeActions"),
  engineRowCodexActions: document.getElementById("engineRowCodexActions"),
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
  petJobButton: document.getElementById("petJobButton"),
  petJobPanel: document.getElementById("petJobPanel"),
  sessionMenuButton: document.getElementById("sessionMenuButton"),
  currentSessionTitle: document.getElementById("currentSessionTitle"),
  sessionUnreadBadge: document.getElementById("sessionUnreadBadge"),
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
  appearanceThemeToggle: document.getElementById("appearanceThemeToggle"),
  appearanceThemeToggleText: document.getElementById("appearanceThemeToggleText"),
  appearanceFontPreset: document.getElementById("appearanceFontPreset"),
  appearanceFontChoices: document.getElementById("appearanceFontChoices"),
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
  modelApiKey: document.getElementById("modelApiKey"),
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
  cloudMobileScanCard: document.getElementById("cloudMobileScanCard"),
  cloudMobileScanMeta: document.getElementById("cloudMobileScanMeta"),
  cloudMobileScanQr: document.getElementById("cloudMobileScanQr"),
  cloudMobileScanRefresh: document.getElementById("cloudMobileScanRefresh"),
  cloudLogout: document.getElementById("cloudLogout"),
  checkUpdates: document.getElementById("checkUpdates"),
  daemonRestart: document.getElementById("daemonRestart"),
  daemonHint: document.getElementById("daemonHint"),
  appUpdateHint: document.getElementById("appUpdateHint"),
  appUpdateOverlay: document.getElementById("appUpdateOverlay"),
  appUpdatePanel: document.getElementById("appUpdatePanel"),
  appUpdateOverlayTitle: document.getElementById("appUpdateOverlayTitle"),
  appUpdateOverlayDetail: document.getElementById("appUpdateOverlayDetail"),
  appUpdateReleaseNotes: document.getElementById("appUpdateReleaseNotes"),
  appUpdateActions: document.getElementById("appUpdateActions"),
  appUpdateDefer: document.getElementById("appUpdateDefer"),
  appUpdateInstall: document.getElementById("appUpdateInstall"),
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

function coreStartupStatusText() {
  const mode = state.coreStartup?.mode || "start";
  const percent = Math.max(0, Math.min(100, Number(state.coreStartup?.percent) || 0));
  return `Mia Core ${mode === "restart" ? "重启" : "启动"}中 ${percent}%`;
}

function isCoreStartupStatusVisible() {
  return Boolean(state.coreStartup?.active && activeConversationBotContext());
}

function isCoreStartupSendBlocked() {
  return Boolean(state.coreStartup?.active && activeConversationBotContext());
}

function renderCoreStartupStatus() {
  const showCoreStartupStatus = isCoreStartupStatusVisible();
  els.modelSwitchStatus?.classList.toggle("core-starting", showCoreStartupStatus);
  els.modelSwitchStatus?.classList.toggle("is-nudging", showCoreStartupStatus && Boolean(state.coreStartup?.nudgeTick));
  if (!showCoreStartupStatus) return;
  setText(els.modelSwitchStatus, coreStartupStatusText());
}

function setModelSwitchStatusText(value) {
  const showCoreStartupStatus = isCoreStartupStatusVisible();
  els.modelSwitchStatus?.classList.toggle("core-starting", showCoreStartupStatus);
  els.modelSwitchStatus?.classList.toggle("is-nudging", showCoreStartupStatus && Boolean(state.coreStartup?.nudgeTick));
  if (showCoreStartupStatus) {
    setText(els.modelSwitchStatus, coreStartupStatusText());
    return;
  }
  setText(els.modelSwitchStatus, value);
}

function clearCoreStartupTimers() {
  if (coreStartupProgressTimer) {
    clearTimeout(coreStartupProgressTimer);
    coreStartupProgressTimer = 0;
  }
  if (coreStartupSettleTimer) {
    clearTimeout(coreStartupSettleTimer);
    coreStartupSettleTimer = 0;
  }
  if (coreStartupNudgeTimer) {
    clearTimeout(coreStartupNudgeTimer);
    coreStartupNudgeTimer = 0;
  }
  if (coreStartupWatchdogTimer) {
    clearTimeout(coreStartupWatchdogTimer);
    coreStartupWatchdogTimer = 0;
  }
}

function beginCoreStartupProgress(mode = "start") {
  clearCoreStartupTimers();
  state.coreStartup = {
    ...(state.coreStartup || {}),
    active: true,
    mode,
    percent: 10,
    nudgeTick: 0
  };
  renderCoreStartupStatus();
  renderSendButton();
  coreStartupProgressTimer = setTimeout(() => {
    coreStartupProgressTimer = 0;
    advanceCoreStartupProgress(35);
  }, 180);
  coreStartupWatchdogTimer = setTimeout(() => {
    coreStartupWatchdogTimer = 0;
    completeCoreStartupProgress(false);
  }, 12000);
}

function advanceCoreStartupProgress(percent) {
  if (!state.coreStartup?.active) return;
  const next = Math.max(Number(state.coreStartup?.percent) || 0, Math.max(0, Math.min(100, Math.round(Number(percent) || 0))));
  state.coreStartup = {
    ...(state.coreStartup || {}),
    percent: next
  };
  renderCoreStartupStatus();
  renderSendButton();
}

function completeCoreStartupProgress(success = true) {
  if (!state.coreStartup) return;
  clearCoreStartupTimers();
  const finish = () => {
    state.coreStartup = {
      ...(state.coreStartup || {}),
      active: false,
      mode: "",
      percent: 0,
      nudgeTick: 0
    };
    renderCoreStartupStatus();
    renderSendButton();
  };
  if (success && state.coreStartup.active) {
    state.coreStartup = {
      ...(state.coreStartup || {}),
      percent: 100
    };
    renderCoreStartupStatus();
    renderSendButton();
    coreStartupSettleTimer = setTimeout(() => {
      coreStartupSettleTimer = 0;
      finish();
    }, 240);
    return;
  }
  finish();
}

function nudgeCoreStartupStatus() {
  if (!isCoreStartupSendBlocked()) return;
  state.coreStartup = {
    ...(state.coreStartup || {}),
    nudgeTick: Number(state.coreStartup?.nudgeTick || 0) + 1
  };
  renderCoreStartupStatus();
  if (els.modelSwitchStatus) {
    els.modelSwitchStatus.classList.remove("is-nudging");
    void els.modelSwitchStatus.offsetWidth;
    els.modelSwitchStatus.classList.add("is-nudging");
  }
  if (coreStartupNudgeTimer) clearTimeout(coreStartupNudgeTimer);
  coreStartupNudgeTimer = setTimeout(() => {
    coreStartupNudgeTimer = 0;
    state.coreStartup = {
      ...(state.coreStartup || {}),
      nudgeTick: 0
    };
    renderCoreStartupStatus();
  }, 420);
}

function isMiaModelIcon(icon = "") {
  return /(?:^|\/)mia-logo\.png(?:[?#].*)?$/.test(String(icon || ""));
}

function applyComposerModelAvatar(modelAvatar, icon = "", options = {}) {
  if (!modelAvatar) return;
  const hidden = Boolean(options.hidden);
  modelAvatar.classList.toggle("hidden", hidden);
  modelAvatar.closest(".model-switcher")?.classList.toggle("model-switcher--no-avatar", hidden);
  if (hidden) {
    modelAvatar.textContent = "";
    modelAvatar.style.backgroundImage = "";
    modelAvatar.classList.remove("model-avatar--transparent");
    return;
  }
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

function openProfileDialogFromRenderer() {
  if (state.profileDialogOpen) {
    window.miaBotDialog.closeProfileDialog();
    return;
  }
  window.miaBotDialog.openProfileDialog();
}

function closeProfilePopoverFromOutside(event) {
  if (!state.profileDialogOpen || state.avatarCropEditor?.open) return;
  const target = event.target;
  if (target?.closest?.(".profile-popover, .avatar-crop-dialog") || els.userAvatar?.contains(target)) return;
  window.miaBotDialog.closeProfileDialog();
}

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
  const cssWidth = `${next}px`;
  if (document.documentElement.style.getPropertyValue("--sidebar-width") !== cssWidth) {
    document.documentElement.style.setProperty("--sidebar-width", cssWidth);
  }
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
  if (lastNativeControlsLayout !== nativeControlsLayout) {
    lastNativeControlsLayout = nativeControlsLayout;
    try {
      window.mia?.window?.setNativeControlsLayout?.(nativeControlsLayout)?.catch?.(() => {});
    } catch {
      // Native traffic light positioning is macOS-only and optional in web mocks.
    }
  }
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

function showRailView(requestedView) {
  const nextView = requestedView === "contacts"
    ? (state.discoverSectionView || "bot-store")
    : requestedView;
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
  if (requestedView === "skills" && !state.skillLibrary.skills.length && !state.skillsLoading) {
    window.miaLoaders.loadSkills();
  }
  if (state.activeView === "bot-store" && !(state.skillLibrary.botPresets || []).length && !state.skillsLoading) {
    window.miaLoaders.loadSkills();
  }
  if (state.activeView === "bot-store") window.miaBotStore?.renderBotStore?.();
  renderView();
  if (state.activeView === "tasks") {
    window.miaTasksPanel?.loadTasksFromDaemon().then(() => {
      window.miaTasksPanel?.renderTaskView();
    });
  }
}

function showExploreView(requestedView) {
  const nextView = requestedView || "bot-store";
  if (state.activeView === nextView) return;
  state.activeView = nextView;
  state.exploreSectionView = nextView;
  state.discoverSectionView = nextView;
  if (nextView === "bot-store" && !(state.skillLibrary.botPresets || []).length && !state.skillsLoading) window.miaLoaders.loadSkills();
  if (nextView === "skills" && !state.skillLibrary.skills.length && !state.skillsLoading) window.miaLoaders.loadSkills();
  if (nextView === "bot-store") window.miaBotStore?.renderBotStore?.();
  showNarrowContent();
  renderView();
}

function showTaskMode(requestedMode) {
  state.activeView = "tasks";
  state.taskMode = requestedMode === "history" ? "history" : "active";
  showNarrowContent();
  renderView();
}

function showSettingsTab(tab) {
  state.activeSettingsTab = tab;
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

function gridLayoutForView(view) {
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
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    if (typeof window.requestAnimationFrame !== "function") {
      syncComposerOverlayHeight();
      return;
    }
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      syncComposerOverlayHeight();
    });
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

function activeConversationRunIsTyping() {
  return Boolean(window.miaSocial?.activeConversationRunIsTyping?.());
}
window.miaIsActiveRunTyping = activeConversationRunIsTyping;

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
    const lastMessageAt = new Date(message.created_at || message.createdAt || 0).getTime() || 0;
    const row = {
      type: conversationType === "group" ? "group-conversation" : "private-conversation",
      key: `search:${conversationId}:${message.id || message.seq || ""}`,
      searchResult: true,
      searchMessageId: message.id || "",
      searchMessageSeq: Number(message.seq) || 0,
      searchMessage: message,
      pinned: false,
      pinnedAt: "",
      lastMessageAt,
      // Search rows are already anchored to the matched visible message.
      updatedAt: lastMessageAt,
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
    window.miaReactConversationFolders.publish({
      items: [],
      reorder: () => {},
      select: () => {},
      visible: false
    });
    return;
  }
  const folderItems = orderedConversationFolderItems(filters, activeFilterName);
  const activeKey = conversationFolderKey(activeFilterName);
  window.miaReactConversationFolders.publish({
    visible: true,
    items: folderItems.map((item) => {
      if (item.type === "all") {
        return {
          active: !activeFilterName,
          color: "",
          count: 0,
          filterValue: "",
          key: item.key,
          name: "\u6240\u6709\u5bf9\u8bdd",
          title: "\u6240\u6709\u5bf9\u8bdd",
          type: "all"
        };
      }
      const tag = item.tag || {};
      const name = String(tag.name || "").trim();
      const filterValue = conversationFilterValue(tag);
      const count = Number(tag.count) || 0;
      return {
        active: conversationFolderKey(filterValue) === activeKey,
        color: safeTagColor(tag.color),
        count,
        filterValue,
        key: item.key,
        name,
        title: count
          ? `\u5206\u7ec4\u300c${name}\u300d \u00b7 ${count} \u4e2a\u5bf9\u8bdd`
          : `\u5206\u7ec4\u300c${name}\u300d`,
        type: "tag"
      };
    }),
    select: (nextName, direction) => {
      const nextKey = conversationFolderKey(nextName);
      if (nextKey === conversationFolderKey(window.miaSocial?.getConversationTagFilter?.() || "")) return;
      conversationFolderMotion = { key: nextKey, direction: Number(direction) < 0 ? -1 : 1 };
      window.miaSocial?.setConversationTagFilter?.(nextName);
    },
    reorder: (keys) => {
      const next = Array.from(keys || []).map((key) => String(key || "").trim()).filter(Boolean);
      if (next.length) writeLocalJson(CONVERSATION_FOLDER_ORDER_KEY, next);
    }
  });
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
  if (!run) return null;
  if (typeof social?.conversationRunIsTyping === "function") {
    return social.conversationRunIsTyping(conversationId) ? run : null;
  }
  return run?.status === "running" && run?.hasTypingActivity ? run : null;
}

function typingLabelForConversationRun(social, conversation, run = null) {
  const activeRun = run || conversationRunForSidebarPreview(social, conversation);
  const botId = activeRun?.botId || "";
  if (!botId) return "";
  if (botId === GroupCoordinator?.id) return GroupCoordinator.displayName || "协调者";
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
  const identityBots = window.miaSocial?.moduleState?.bots || [];
  if (window.miaBotDirectory?.listOwnedBots) {
    return window.miaBotDirectory.listOwnedBots({ identityBots, runtime });
  }
  return Array.isArray(identityBots) ? identityBots : [];
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
  if (activeConversationRunIsTyping()) {
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
  const blockedByCoreStartup = !busy && canSend && isCoreStartupSendBlocked();
  const runtimeBlock = !busy && canSend ? activeBotRuntimeSendBlock() : null;
  const blockedByRuntime = Boolean(runtimeBlock);
  els.sendChat.classList.toggle("stop", busy);
  els.sendChat.classList.toggle("stopping", cancelling);
  els.sendChat.classList.toggle("core-blocked", blockedByCoreStartup || blockedByRuntime);
  const title = cancelling
    ? "正在停止"
    : (generating
      ? "停止生成"
      : (blockedByCoreStartup ? coreStartupStatusText() : (blockedByRuntime ? runtimeBlock.reason : "发送")));
  els.sendChat.title = title;
  els.sendChat.setAttribute("aria-label", title);
  els.sendChat.setAttribute("aria-disabled", (blockedByCoreStartup || blockedByRuntime) ? "true" : "false");
  els.sendChat.disabled = cancelling || (!generating && (!canSend || blockedByCoreStartup || blockedByRuntime));
}


const providerPresets = {
  "openai-codex": {
    provider: "openai-codex",
    model: ""
  },
  xai: {
    provider: "xai",
    model: "grok-4.1-fast"
  },
  anthropic: {
    provider: "anthropic",
    model: "claude-sonnet-4.6"
  },
  openrouter: {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.6"
  },
  deepseek: {
    provider: "deepseek",
    model: "deepseek-chat"
  },
  gemini: {
    provider: "gemini",
    model: "gemini-2.5-pro"
  },
  lmstudio: {
    provider: "lmstudio",
    model: ""
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
    let name, avatar, identity, statusBadge, runtimeBot;
    if (isBot) {
      const botKey = sessionHistory.botId(conversation);
      const bot = identityBots.find((p) => (p.id || p.key) === botKey);
      const member = botMemberForConversation(social, conversation, botKey);
      const botRecord = bot || {
        key: botKey,
        id: botKey,
        name: conversation.name || member?.identity?.displayName || member?.bot_name || botKey
      };
      runtimeBot = botRecord;
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
    const unread = isBot
      ? (social?.getUnreadForBot?.(sessionHistory.botId(conversation)) || 0)
      : (social?.getUnreadForConversation?.(conversation.id) || 0);
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
      time: formatConversationTime(row.lastMessageAt),
      unread: searchResult ? 0 : unread,
      tags: searchResult ? [] : (conversation.tags || social?.conversationTagsFor?.(conversation.id) || []),
      tagEditor: searchResult ? null : (social?.conversationTagEditorFor?.(conversation.id) || null),
      avatar,
      identity,
      statusBadge,
      deviceGroup: isBot ? window.miaBotManager?.botDeviceGroup?.(runtimeBot) : null,
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
      time: formatConversationTime(row.lastMessageAt),
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
    deviceGroup: spec?.deviceGroup
      ? {
          key: String(spec.deviceGroup.key || ""),
          label: String(spec.deviceGroup.label || ""),
          meta: String(spec.deviceGroup.meta || ""),
          status: String(spec.deviceGroup.status || ""),
          order: Number(spec.deviceGroup.order) || 0
        }
      : null,
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

function conversationListEntryKey(spec, index) {
  const attrs = spec?.dataAttrs || {};
  const stableId = [
    attrs.conversationId || "",
    attrs.searchMessageId || "",
    attrs.searchMessageSeq || ""
  ].filter(Boolean).join(":");
  return stableId ? `${spec?.kind || "conversation"}:${stableId}` : `conversation:${index}`;
}

function renderPersonaListIfChanged(specs, emptyText, activeTagFilterName) {
  const deviceGroups = window.miaConversationDeviceGroups;
  const groupByDevice = Boolean(deviceGroups?.isOtherDeviceFilter?.(
    activeTagFilterName,
    window.miaSocial?.OTHER_DEVICE_CONVERSATION_FILTER
  ));
  const renderedSpecs = groupByDevice && typeof deviceGroups?.orderedConversationSpecs === "function"
    ? deviceGroups.orderedConversationSpecs(specs)
    : specs;
  window.miaReactConversationList.publish({
    activeTagFilterName,
    createCard: createConversationCardFromSpec,
    emptyText,
    entries: renderedSpecs.map((spec, index) => ({
      active: Boolean(spec?.active),
      key: conversationListEntryKey(spec, index),
      signature: safeRenderSignature(sidebarCardRenderSignature(spec)),
      spec
    })),
    grouped: groupByDevice,
    renderGrouped: groupByDevice
      ? (options) => deviceGroups.appendGroupedConversationCards(options)
      : undefined
  });
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
    window.miaReactChatMenus?.publish?.({ conversationRows: [] });
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

  chatConversationMenuRenderSignature = safeRenderSignature({
    rows: compactSpecs.map(sidebarCardRenderSignature)
  });
  window.miaReactChatMenus?.publish?.({
    conversationRows: compactSpecs.map((spec, index) => ({
      active: Boolean(spec.active),
      avatar: spec.avatar
        ? {
            color: spec.avatar.color || "#5e5ce6",
            crop: spec.avatar.crop || null,
            image: spec.avatar.image || "",
            text: spec.avatar.text || spec.name || ""
          }
        : null,
      badge: spec.statusBadge || null,
      customAvatar: spec.customAvatar
        ? {
            color: spec.customAvatar.color || "#5e5ce6",
            crop: spec.customAvatar.crop || null,
            image: spec.customAvatar.image || "",
            text: spec.customAvatar.text || spec.name || ""
          }
        : null,
      id: String(spec.dataAttrs?.conversationId || `${spec.kind}:${index}`),
      kind: spec.kind === "group" ? "group" : "private",
      members: Array.isArray(spec.members) ? spec.members : [],
      muted: Boolean(spec.muted),
      name: spec.name || "",
      open: spec.onClick || (() => {}),
      openContextMenu: spec.onContextMenu || (() => {}),
      pinned: Boolean(spec.pinned),
      time: spec.time || "",
      typeLabel: spec.typeLabel || (spec.kind === "group" ? "群聊" : "私聊"),
      unread: Number(spec.unread) || 0
    }))
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

function renderAttachmentFileIcon(attachment = {}, assetRoot = "./assets/file-type-icons") {
  return `
    <span class="message-attachment-icon" aria-hidden="true">
      <img class="message-attachment-icon-image" src="${window.miaMarkdown.escapeHtml(assetRoot)}/${window.miaMarkdown.escapeHtml(window.miaFormat.attachmentIconName(attachment))}.png" alt="">
    </span>
  `;
}

function renderStandaloneAttachmentBlock(attachmentHtml = "", attrs = "") {
  if (!attachmentHtml) return "";
  const extraAttrs = String(attrs || "").trim();
  return attachmentHtml.replace(
    '<div class="message-attachments"',
    `<div class="message-attachments standalone"${extraAttrs ? ` ${extraAttrs}` : ""}`
  );
}

function renderAttachmentChip(attachment = {}) {
  const image = window.miaFormat.attachmentVisualType(attachment) === "image" && (attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || attachment.dataUrl || attachment.url);
  const imageSrc = String(attachment.dataUrl || attachment.previewDataUrl || attachment.thumbnailDataUrl || attachment.thumbnail || "").trim();
  const imageSrcAttr = imageSrc.startsWith("data:image/") ? ` data-image-src="${window.miaMarkdown.escapeHtml(imageSrc)}"` : "";
  const href = String(attachment.dataUrl || "").startsWith("data:") ? String(attachment.dataUrl) : "";
  const localFilePathAttr = ` data-local-file-path="${window.miaMarkdown.escapeHtml(attachment.path || "")}"`;
  const attachmentUrlAttr = attachment.url ? ` data-attachment-url="${window.miaMarkdown.escapeHtml(attachment.url)}"` : "";
  const downloadHrefAttr = href ? ` data-download-href="${window.miaMarkdown.escapeHtml(href)}" data-download-name="${window.miaMarkdown.escapeHtml(attachment.name || "attachment")}"` : "";
  const tag = href ? "a" : "span";
  const download = href ? ` href="${window.miaMarkdown.escapeHtml(href)}" download="${window.miaMarkdown.escapeHtml(attachment.name || "attachment")}"` : "";
  const detail = window.miaFormat.formatBytes(attachment.size) || window.miaFormat.attachmentGlyph(attachment);
  if (image) {
    return `
      <button class="message-attachment image" type="button"${localFilePathAttr}${attachmentUrlAttr}${downloadHrefAttr}${imageSrcAttr} title="${window.miaMarkdown.escapeHtml(attachment.path || attachment.name || "")}" aria-label="预览图片">
        ${renderAttachmentThumb(attachment, "message-attachment-thumb")}
      </button>
    `;
  }
  return `
    <${tag} class="message-attachment file-card type-${window.miaMarkdown.escapeHtml(window.miaFormat.attachmentVisualType(attachment))}"${localFilePathAttr}${attachmentUrlAttr}${downloadHrefAttr}${download} title="${window.miaMarkdown.escapeHtml(attachment.path || attachment.name || "")}">
      ${renderAttachmentFileIcon(attachment)}
      <span class="message-attachment-meta">
        <strong>${window.miaMarkdown.escapeHtml(attachment.name || "附件")}</strong>
        <em>${window.miaMarkdown.escapeHtml(detail)}</em>
      </span>
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
    if (!event.target.closest(".image-editor-dialog")) {
      closeImagePreview();
      return;
    }
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
    const entry = generatedFileCacheEntry(filePath);
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
    const entry = generatedFileCacheEntry(cloudUrl);
    if (entry?.status === "ready" && entry.attachment) {
      return { ...attachment, ...entry.attachment };
    }
    return attachment;
  }
  const entry = generatedFileCacheEntry(filePath);
  if (entry?.status === "ready" && entry.attachment) {
    return { ...attachment, ...entry.attachment };
  }
  return attachment;
}

const MAX_GENERATED_FILE_CACHE_ENTRIES = 64;
const MAX_GENERATED_FILE_CACHE_BYTES = 32 * 1024 * 1024;

function generatedFileCacheEntry(key) {
  if (!state.generatedFiles.has(key)) return undefined;
  return window.miaResourceCache?.touchMapValue?.(state.generatedFiles, key) ?? state.generatedFiles.get(key);
}

function pruneGeneratedFileCache(protectedKey = "") {
  window.miaResourceCache?.pruneMap?.(state.generatedFiles, {
    maxEntries: MAX_GENERATED_FILE_CACHE_ENTRIES,
    maxWeight: MAX_GENERATED_FILE_CACHE_BYTES,
    weightOf: (entry) => window.miaResourceCache?.estimateValueBytes?.(entry) || 0,
    protectedKeys: protectedKey ? [protectedKey] : []
  });
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
    pruneGeneratedFileCache(filePath);
    window.mia.fetchFileAttachment?.(filePath.startsWith("/api/files/") ? { url: filePath } : { path: filePath })
      .then((attachment) => {
        if (attachment?.error) throw new Error(attachment.message || "File not found.");
        state.generatedFiles.set(filePath, { status: "ready", attachment });
        pruneGeneratedFileCache(filePath);
        renderChat();
      })
      .catch(() => {
        state.generatedFiles.set(filePath, { status: "error" });
        pruneGeneratedFileCache(filePath);
        renderChat();
      });
  }
}


function cryptoRandomId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `session_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

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
  return trackStartupTask("加载运行配置", () => Promise.allSettled([
    window.miaLoaders.loadModelCatalog(),
    window.miaLoaders.loadCodexModels(),
    window.miaLoaders.loadEngineCapabilities(),
    window.miaLoaders.loadSlashCommands()
  ])).then(() => render());
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
  beginCoreStartupProgress("start");
  try {
    const result = await trackStartupTask("启动 Mia Core", () => window.mia.startupBackgroundServices());
    advanceCoreStartupProgress(70);
    return result;
  } catch (error) {
    completeCoreStartupProgress(false);
    console.warn("[Mia startup] failed to start background services", error);
    return { ok: false, error: error?.message || String(error || "Unknown error") };
  }
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
		    const copy = window.miaModelSettings.modelAuthCopy(entry, runtime);
	  const showAuthState = !needsApiKey && !needsOauth;
	  setText(els.modelAuthState, isConnected ? "已连接" : copy.state);
	  els.modelAuthState?.classList.toggle("hidden", !showAuthState);
	    els.modelApiKey.placeholder = window.miaModelHelpers.apiKeyPromptLabel(entry);
	    if (els.modelConnectButton) {
	      els.modelConnectButton.textContent = "连接";
	      els.modelConnectButton.title = `连接 ${providerEntry?.providerLabel || entry.providerLabel || entry.provider}`;
	    }
  } else {
    els.modelAuthState?.classList.add("hidden");
  }
}

function modelSelectionIntent(entry, apiKey = null) {
  const provider = String(entry?.provider || "").trim();
  const model = String(entry?.model || "").trim();
  return {
    provider,
    providerConnectionId: entry?.providerConnectionId || provider,
    model,
    modelProfileId: entry?.modelProfileId || (provider && model ? `${provider}:${model}` : provider),
    providerLabel: entry?.providerLabel,
    authType: entry?.authType,
    ...(apiKey != null ? { apiKey } : {})
  };
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

function renderChatHtml(html = "") {
  window.miaReactMessageList.renderHtml(html);
}

function codexAuthDetailsMarkdown(auth = {}) {
  const lines = [];
  const verificationUrl = String(auth.codexVerificationUrl || "").trim();
  const userCode = String(auth.codexUserCode || "").trim();
  if (auth.codexStarting && verificationUrl) lines.push(`打开登录页面：${verificationUrl}`);
  if (auth.codexStarting && userCode) lines.push(`在浏览器页面输入：\`${userCode}\``);
  if (!lines.length && auth.codexStarting) lines.push("正在请求设备码...");
  return lines.join("\n\n");
}

function renderImpl({ conversationOnly = false, conversationScopes = [] } = {}) {
  if (!conversationOnly) conversationRenderScheduler?.cancel?.();
  const runtime = state.runtime;
  if (!runtime) {
    if (window.miaSetupGuide?.shouldShowSetupGuide?.({ messages: [] })) {
      setOnboardingWindow(true);
      renderChatHtml(window.miaSetupGuide.renderSetupGuide());
      window.miaLottieIcons?.init?.(els.chat);
      return;
    }
    setOnboardingWindow(false);
    renderChatHtml();
    return;
  }
  updateStatusBadgeAssetBaseUrl(runtime);
  const cloudSignedIn = Boolean(runtime?.cloud?.enabled);
  els.appShell?.setAttribute("data-auth-state", cloudSignedIn ? "signed-in" : "signed-out");
  const chatViewActive = state.activeView === "chat";
  const rendererInteractive = desktopWindowFocused && !document.hidden;
  if (conversationOnly && (!chatViewActive || !rendererInteractive)) {
    renderNavigationBadges();
    return;
  }
  if (conversationOnly && conversationScopes.length && !conversationScopes.includes("default")) {
    rendererPerformance.record("render.conversation.scopeCount", conversationScopes.length);
  }
  const requestedConversationScopes = new Set(conversationScopes);
  const renderWholeConversation = !conversationOnly
    || !requestedConversationScopes.size
    || requestedConversationScopes.has("default")
    || requestedConversationScopes.has("conversation")
    || requestedConversationScopes.has("activation");
  const renderConversationChrome = renderWholeConversation
    || requestedConversationScopes.has("chrome")
    || requestedConversationScopes.has("header");
  const renderConversationSidebar = renderWholeConversation
    || requestedConversationScopes.has("sidebar");
  const renderConversationChat = renderWholeConversation
    || requestedConversationScopes.has("chat");
  if (chatViewActive && (renderConversationChrome || renderConversationChat)) {
  renderSendButton();
  window.miaMessageHelpers.renderComposerReply();
  // Re-evaluate composer skill chips every render so switching conversations drops
  // chips that belonged to the previous conversation (self-heal in composer).
  window.miaComposer?.renderComposerSkills?.();
  }
  if (!conversationOnly) {
  const editingModel = els.modelForm.contains(document.activeElement);
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
  if (els.codexCode) {
    const codexMarkdown = codexAuthDetailsMarkdown(auth);
    els.codexCode.innerHTML = window.miaMarkdown.renderMarkdown(codexMarkdown);
    els.codexCode.classList.toggle("hidden", !codexMarkdown);
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
  const settingsRuntimeOptions = window.miaModelSettings.runtimeControlOptions(runtime);
  if (els.quickModelSelect && document.activeElement !== els.quickModelSelect) {
    const currentModelId = settingsRuntimeOptions?.selectedModel || "";
    if ([...els.quickModelSelect.options].some((option) => option.value === currentModelId)) {
      els.quickModelSelect.value = currentModelId;
    }
    window.miaModelSettings.syncQuickModelLabel();
  }
  window.miaModelSettings.syncEffortControl(runtime);
  const connectedEntries = window.miaModelSettings.connectedModelEntries(runtime);
  setModelSwitchStatusText(settingsRuntimeOptions?.statusText || "运行配置读取中...");
  if (els.quickModelSelect) {
    const currentModelLabel = els.quickModelSelect.value
      ? (els.quickModelSelect.selectedOptions?.[0]?.textContent || settingsRuntimeOptions?.selectedModel || "")
      : "";
    els.quickModelSelect.title = connectedEntries.length
      ? `当前模型：${currentModelLabel || "模型"}`
      : "未配置模型";
  }
  const selectedRuntimeValue = String(els.quickModelSelect?.value || settingsRuntimeOptions?.selectedModel || "").trim();
  const selectedRuntimeEntry = selectedRuntimeValue
    ? (settingsRuntimeOptions?.selectedModelEntry
      || connectedEntries.find((entry) => String(entry.id || entry.value || entry.model || "") === selectedRuntimeValue)
      || {})
    : {};
  const activeIcon = selectedRuntimeEntry?.id || selectedRuntimeEntry?.value || selectedRuntimeEntry?.model || selectedRuntimeEntry?.provider
    ? window.miaModelHelpers.modelIconSrc({
      provider: selectedRuntimeEntry.provider || runtime.model?.provider,
      model: selectedRuntimeEntry.model || selectedRuntimeEntry.id || runtime.model?.model
    })
    : "";
  applyComposerModelAvatar(document.querySelector(".model-avatar"), activeIcon);
  window.miaModelSettings.syncPermissionControl(runtime);
  }
  if (chatViewActive) {
  if (renderConversationChrome) {
  syncConversationBotRuntimeControls();
  renderCoreStartupStatus();
  }

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
  if (renderConversationChrome) {
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
    els.newSession?.classList.toggle("hidden", hideSessionSelector);
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
    els.newSession?.classList.add("hidden");
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
    els.newSession?.classList.add("hidden");
    if (composerBottom) composerBottom.classList.remove("hidden");
  }
  }
  // Cloud-only: the sidebar lists cloud conversations exclusively. Local bot
  // personas are no longer a conversation source — a bot surfaces as its
  // cloud bot conversation once bootstrap completes.
  if (renderConversationSidebar) {
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
  }
  if (renderConversationChrome) renderSessionMenu();
  if (renderConversationChat && !window.miaMessageMenu?.hasActiveMessageTextSelection()) renderChat();
  }
  if (!conversationOnly) renderView();
  else renderNavigationBadges();
}

function render(options = {}) {
  const label = options?.conversationOnly ? "render.conversation" : "render.full";
  return rendererPerformance.measure(label, () => renderImpl(options));
}

const conversationRenderScheduler = window.miaRenderScheduler?.createRenderScheduler
  ? window.miaRenderScheduler.createRenderScheduler({
    render: (conversationScopes) => render({ conversationOnly: true, conversationScopes }),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id)
  })
  : null;

function scheduleConversationRender(scope = "conversation") {
  if (conversationRenderScheduler) return conversationRenderScheduler.schedule(scope);
  return render({ conversationOnly: true, conversationScopes: [scope] });
}

function renderNavigationBadges() {
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

  const tasksUnreadTotal = [...(state.tasksUnread?.values?.() || [])]
    .reduce((sum, count) => sum + (Number(count) || 0), 0);
  if (els.sidebarTasksUnreadBadge) {
    if (tasksUnreadTotal > 0) {
      els.sidebarTasksUnreadBadge.classList.remove("hidden");
      els.sidebarTasksUnreadBadge.textContent = window.miaUnread.unreadBadgeText(tasksUnreadTotal);
    } else {
      els.sidebarTasksUnreadBadge.classList.add("hidden");
    }
  }
  window.miaReactBridge?.publish?.({
    activeView: state.activeView,
    activeSettingsTab: state.activeSettingsTab,
    chatUnread: conversationUnread,
    contactsUnread: incomingCount,
    taskMode: state.taskMode === "history" ? "history" : "active",
    tasksUnread: tasksUnreadTotal,
    profileDialogOpen: Boolean(state.profileDialogOpen)
  });
}

function pauseInactiveRendererMedia({ documentVisible = true } = {}) {
  document.querySelectorAll("video").forEach((video) => {
    const workspace = video.closest?.(".workspace");
    const hiddenByView = Boolean(workspace?.classList?.contains("hidden"));
    const hiddenByDialog = Boolean(video.closest?.(".hidden"));
    if (!documentVisible || hiddenByView || hiddenByDialog) {
      try { video.pause?.(); } catch { /* media teardown is best-effort */ }
    }
  });
}

function syncRendererViewLifecycle(lifecycleState = rendererViewLifecycle?.snapshot?.("render") || {
  activeView: state.activeView,
  documentVisible: !document.hidden,
  reason: "render"
}) {
  const rendererVisible = lifecycleState.documentVisible && desktopWindowFocused;
  const chatActive = rendererVisible && lifecycleState.activeView === "chat";
  if (!chatActive) conversationRenderScheduler?.cancel?.();
  window.miaSocial?.setLifecycleState?.({
    active: chatActive,
    visible: rendererVisible
  });
  window.miaLottieIcons?.setActive?.(rendererVisible);
  pauseInactiveRendererMedia({ ...lifecycleState, documentVisible: rendererVisible });

  const shouldScanMobile = rendererVisible
    && lifecycleState.activeView === "settings"
    && state.activeSettingsTab === "account"
    && state.runtime?.cloud?.enabled;
  if (shouldScanMobile) {
    refreshCloudMobileScan().catch(() => {});
    window.miaCloudMobileLogin?.ensurePolling?.();
  } else {
    clearCloudMobileScanTimers();
  }

  if (chatActive && (lifecycleState.reason === "view" || lifecycleState.reason === "visibility")) {
    scheduleConversationRender("activation");
  }
}

function renderViewImpl() {
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
  if (!cloudSignedIn) {
    requestSignedOutOnboardingWindow();
    state.activeView = "chat";
    state.botMenuOpen = false;
    state.contactMenuOpen = false;
  }
  if (state.activeView !== "chat") state.chatConversationMenuOpen = false;
  syncNarrowLayout();
  els.appShell?.setAttribute("data-auth-state", cloudSignedIn ? "signed-in" : "signed-out");
  els.conversationSidebar?.classList.toggle("hidden", state.activeView !== "chat");
  els.contactsSidebar?.classList.toggle("hidden", state.activeView !== "contacts");
  const sidebarBottomLayout = state.navLayout === "sidebar-bottom";
  els.exploreSidebar?.classList.toggle("hidden", !(sidebarBottomLayout && (state.activeView === "bot-store" || state.activeView === "skills")));
  els.taskSidebar?.classList.toggle("hidden", !(sidebarBottomLayout && state.activeView === "tasks"));
  els.settingsSidebar?.classList.toggle("hidden", state.activeView !== "settings");
  els.chatView?.classList.toggle("hidden", state.activeView !== "chat");
  els.contactsView?.classList.toggle("hidden", state.activeView !== "contacts");
  els.skillsView?.classList.toggle("hidden", state.activeView !== "skills");
  els.botStoreView?.classList.toggle("hidden", state.activeView !== "bot-store");
  els.tasksView?.classList.toggle("hidden", state.activeView !== "tasks");
  els.settingsView?.classList.toggle("hidden", state.activeView !== "settings");
  els.appShell?.setAttribute("data-active-view", state.activeView);
  els.appShell?.setAttribute("data-layout", gridLayoutForView(state.activeView));
  els.appShell?.setAttribute("data-shell-layout", state.shellLayout);
  syncNavLayoutState();
  syncSidebarCollapseState();
  els.userAvatar?.setAttribute("aria-expanded", state.profileDialogOpen ? "true" : "false");
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsTab === state.activeSettingsTab);
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.settingsPanel !== state.activeSettingsTab);
  });
  els.botCreateMenu?.classList.toggle("hidden", !state.botMenuOpen);
  els.contactCreateMenu?.classList.toggle("hidden", !state.contactMenuOpen);
  els.newPersona?.setAttribute("aria-expanded", state.botMenuOpen ? "true" : "false");
  els.newPersona?.classList.toggle("active", state.botMenuOpen);
  els.newContact?.setAttribute("aria-expanded", state.contactMenuOpen ? "true" : "false");
  els.newContact?.classList.toggle("active", state.contactMenuOpen);
  renderNavigationBadges();
  window.miaBotManager.renderBotContextMenu();
  if (state.petGenerateOpen) {
    window.miaPetDialog?.renderPetGenerateDialog();
    window.miaPetDialog?.renderPetJobs();
  }
  const lifecycleState = rendererViewLifecycle?.setActiveView?.(state.activeView) || {
    activeView: state.activeView,
    documentVisible: !document.hidden,
    reason: "render"
  };
  if (lifecycleState.reason !== "view" || !rendererLifecycleSubscribed) {
    syncRendererViewLifecycle(lifecycleState);
  }
  if (!state.runtime?.cloud?.enabled) {
    closeCloudLoginApproveDialog();
  }
  if (state.activeView === "settings") window.miaSettingsMemory?.renderMemorySettings?.();
  if (state.activeView === "skills") window.miaSkillLibrary.renderSkillLibrary();
  if (state.activeView === "contacts") window.miaBotManager.renderContacts();
  if (state.activeView === "tasks") window.miaTasksPanel?.renderTaskView();
}

function renderView() {
  return rendererPerformance.measure(`render.view.${state.activeView || "unknown"}`, renderViewImpl);
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

function renderHermesInstallState(runtime = state.runtime) {
  return window.miaEngineDetectionController?.renderHermesInstallState?.(runtime) || "";
}

function hermesSetupAction(runtime = state.runtime) {
  return window.miaEngineDetectionController?.hermesSetupAction?.(runtime) || null;
}

function hermesCanConfigure(runtime, hermes = runtime?.agentInventory?.agents?.find((agent) => agent.id === "hermes")) {
  return Boolean(window.miaEngineDetectionController?.canConfigureHermes?.(runtime, hermes));
}

function renderEngineDetection(runtime) {
  return window.miaEngineDetectionController?.renderDetection?.(runtime);
}

function renderSessionMenu() {
  syncTopbarClickCapture();
  return window.miaSessionMenuController?.renderMenu?.();
}

function activeCloudConversationForSessionMenu() {
  return window.miaSessionMenuController?.activeConversation?.() || null;
}

async function selectCloudSessionConversation(conversation, { skipMessageLoad = false } = {}) {
  return window.miaSessionMenuController?.selectConversation?.(conversation, { skipMessageLoad });
}

function updateSessionUnreadBadge(count) {
  return window.miaSessionMenuController?.updateUnreadBadge?.(count);
}

function updateCurrentSessionTitle(title) {
  return window.miaSessionMenuController?.updateTitle?.(title);
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
      botId: botKeyForConversation(conversation),
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
  const attachmentAfterBodyHtml = message.role === "assistant"
    ? renderStandaloneAttachmentBlock(attachmentHtml, `data-message-index="${messageIndex}"`)
    : "";
  const attachmentBeforeBodyHtml = message.role === "assistant" ? "" : attachmentHtml;
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
  let persistedTrace = message.trace || message.trace_json || null;
  if (typeof persistedTrace === "string" && persistedTrace.trim()) {
    try { persistedTrace = JSON.parse(persistedTrace); } catch { persistedTrace = null; }
  }
  if (!persistedTrace || typeof persistedTrace !== "object") persistedTrace = null;
  const rawProcessDuration = Number(persistedTrace?.duration ?? persistedTrace?.durationSeconds);
  const processDurationSeconds = Number.isFinite(rawProcessDuration) && rawProcessDuration > 0
    ? rawProcessDuration
    : 0;
  let renderedFirstTextBlock = false;
  const orderedBlocksHtml = contentBlocks.length && window.miaTraceBlocks?.renderAssistantContentBlocks
    ? window.miaTraceBlocks.renderAssistantContentBlocks({
      blocks: contentBlocks,
      completed: true,
      expanded: false,
      scopeKey: `msg:${message.createdAt || ""}`,
      durationSeconds: processDurationSeconds,
      renderTextBlock(block, _blockIndex, renderState = {}) {
        const prefixHtml = renderedFirstTextBlock || renderState.process
          ? ""
          : `${attachmentBeforeBodyHtml}${pinnedHtml}${replyHtml}`;
        if (!renderState.process) renderedFirstTextBlock = true;
        const blockBodyHtml = String(block.text || "").trim() ? window.miaMarkdown.renderMarkdown(block.text) : "";
        return `<div class="bubble${message.pinned ? " pinned" : ""}" data-message-index="${messageIndex}">${prefixHtml}${blockBodyHtml}</div>`;
      }
    })
    : "";
  const traceHtml = message.role === "assistant" && !orderedBlocksHtml
    ? window.miaTraceBlocks.renderTraceBlocks({
      reasoning: message.reasoning || persistedTrace?.reasoning,
      tools: message.tools || persistedTrace?.tools,
      content: message.content,
      completed: true,
      expanded: false,
      scopeKey: `msg:${message.createdAt || ""}`,
      durationSeconds: processDurationSeconds
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
  const orderedBlocksLeadingBubbleHtml = orderedBlocksHtml && !renderedFirstTextBlock && (attachmentBeforeBodyHtml || pinnedHtml || replyHtml)
    ? `<div class="bubble${message.pinned ? " pinned" : ""}" data-message-index="${messageIndex}">${attachmentBeforeBodyHtml}${pinnedHtml}${replyHtml}</div>`
    : "";
  const orderedBlocksWithAttachments = orderedBlocksHtml
    ? `${orderedBlocksLeadingBubbleHtml}${orderedBlocksHtml}${attachmentAfterBodyHtml}`
    : "";
  const bubbleBodyHtml = `${attachmentBeforeBodyHtml}${pinnedHtml}${replyHtml}${bodyHtml}${commandResultHtml}${translation}`;
  const defaultBubbleHtml = bubbleBodyHtml
    ? `<div class="bubble${message.pinned ? " pinned" : ""}" data-message-index="${messageIndex}">${bubbleBodyHtml}</div>${attachmentAfterBodyHtml}`
    : attachmentAfterBodyHtml;
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
        ${hermesAction ? `<button type="button" class="primary" data-setup-action="${hermesAction.action}">${window.miaMarkdown.escapeHtml(hermesAction.label)}</button>` : ""}
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
    renderChatHtml(window.miaSetupGuide.renderSetupGuide());
    window.miaLottieIcons?.init?.(els.chat);
    return;
  }
  setOnboardingWindow(onboardingWindow);
  if (state.agentSetupSkipped && !hasUsableLocalAgent()) {
    renderChatHtml(renderNoAgentGuide());
    return;
  }
  if (state.runtime?.cloud?.enabled) {
    renderChatHtml();
    return;
  }
  requestSignedOutOnboardingWindow();
  renderChatHtml();
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

function strictAgentEngine(value = "") {
  const shared = globalThis.miaEngineContracts?.normalizeAgentEngineStrict?.(value);
  if (shared) return shared;
  const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "claude" || normalized === "claude-code") return "claude-code";
  if (normalized === "codex" || normalized === "openai-codex") return "codex";
  if (normalized === "hermes") return "hermes";
  return "";
}

function firstValidAgentEngine(...values) {
  const shared = globalThis.miaEngineContracts?.firstValidAgentEngine;
  if (typeof shared === "function") return shared(...values);
  for (const value of values) {
    const engine = strictAgentEngine(value);
    if (engine) return engine;
  }
  return "";
}

function starterAgentEngineForBot(botKey = "") {
  const shared = globalThis.miaEngineContracts?.starterAgentEngineFromBotId?.(botKey);
  if (shared) return shared;
  const id = String(botKey || "").trim().toLowerCase();
  const legacyEngine = strictAgentEngine(id);
  if (legacyEngine) return legacyEngine;
  if (!id.startsWith("starter_")) return "";
  if (id.endsWith("_claude-code") || id.endsWith("_claude_code") || id.endsWith("_claude")) return "claude-code";
  if (id.endsWith("_codex")) return "codex";
  if (id.endsWith("_hermes")) return "hermes";
  return "";
}

function activeConversationBotContext() {
  const social = window.miaSocial;
  const conversationId = social?.getActiveConversationId?.();
  if (!conversationId) return null;
  const conversation = social?.getConversationById?.(conversationId);
  if (!conversation) return null;
  if (conversationTypeForComposer(conversation, conversationId) !== "bot") return null;
  const botKey = botKeyForConversation(conversation);
  if (!botKey) return null;
  // A conversation's saved runtime is authoritative. Identity rows are
  // cloud-sourced and can temporarily carry an older/default runtime while a
  // local binding is being hydrated; letting that row overwrite an explicit
  // desktop-local conversation makes a local Hermes chat look like a cloud
  // agent and hides its native controls.
  const conversationRuntimeKind = sessionHistory.runtimeKind(conversation, "");
  const conversationDecorations = conversation.decorations || {};
  const conversationRuntimeConfig = conversation.runtimeConfig || conversation.runtime_config || {};
  const conversationAgentEngine = firstValidAgentEngine(
    conversationDecorations.agentEngine,
    conversationDecorations.agent_engine,
    conversationRuntimeConfig.agentEngine,
    conversationRuntimeConfig.agent_engine,
    conversation.agentEngine,
    conversation.agent_engine
  );
  const bot = allOwnedBotsForIdentity().find((item) => String(item?.key || item?.id || "") === botKey) || {};
  const botRuntimeKind = sessionHistory.runtimeKind(bot, "");
  const starterAgentEngine = starterAgentEngineForBot(botKey);
  const botAgentEngine = conversationAgentEngine
    || firstValidAgentEngine(bot.agentEngine, bot.agent_engine)
    || starterAgentEngine;
  // Mia Cloud is the hosted Claude Code runtime. A cloud identity row without
  // a runtime binding must not turn a Hermes or Codex chat into a cloud one.
  const knownLocalEngine = botAgentEngine === "hermes"
    || botAgentEngine === "codex"
    || Boolean(starterAgentEngine);
  return {
    conversation,
    conversationId,
    botKey,
    agentEngine: botAgentEngine,
    runtimeKind: conversationRuntimeKind || (knownLocalEngine ? "desktop-local" : botRuntimeKind || "desktop-local")
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
        agentEngine: conversationContext.agentEngine || bot.agentEngine || bot.agent_engine || "",
        runtimeKind: conversationContext.runtimeKind
      }
    };
  }
  const activeConversationId = window.miaSocial?.getActiveConversationId?. ();
  if (activeConversationId) return null;
  const bot = activePersona();
  const botKey = String(bot?.key || bot?.id || "").trim();
  if (!botKey) return null;
  return {
    conversation: null,
    conversationId: "",
    botKey,
    runtimeKind: sessionHistory.runtimeKind(bot, "desktop-local"),
    bot: { ...bot, key: botKey }
  };
}

function activeBotRuntimeSendBlock() {
  if (!activeConversationBotContext()) return null;
  const controlContext = activeBotRuntimeControlContext();
  const options = runtimeControlOptionsForContext(controlContext);
  if (options?.sendBlocked) {
    return { reason: options.sendBlockReason || options.statusText || "Agent 不可用" };
  }
  return null;
}

function nudgeBotRuntimeSendBlock(block = activeBotRuntimeSendBlock()) {
  if (!block) return false;
  setModelSwitchStatusText(block.reason || "Agent 不可用");
  const controlContext = activeBotRuntimeControlContext();
  if (!runtimeControlOptionsForContext(controlContext)) {
    requestRuntimeControlOptions(controlContext);
  }
  renderSendButton();
  return true;
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
  if (platformModelCatalog.loaded) {
    return { entries: platformModelCatalog.entries, loaded: true, changed: false };
  }
  if (platformModelCatalog.loading || !runtimeRequestBackoff.canRun(PLATFORM_MODEL_CATALOG_REQUEST_KEY)) {
    return { entries: platformModelCatalog.entries, loaded: false, changed: false };
  }
  if (!state.runtime?.cloud?.enabled || typeof window.mia?.social?.listPlatformModels !== "function") {
    return { entries: platformModelCatalog.entries, loaded: false, changed: false };
  }
  platformModelCatalog.loading = true;
  try {
    const response = await window.mia.social.listPlatformModels();
    if (response && response.ok === false) {
      throw new Error(response.error || response.message || "Platform model catalog failed");
    }
    const models = response?.ok ? response.data?.models : response?.models;
    const entries = (Array.isArray(models) ? models : [])
      .map(normalizePlatformModelEntry)
      .filter(Boolean);
    const changed = !platformModelCatalog.loaded
      || JSON.stringify(entries) !== JSON.stringify(platformModelCatalog.entries);
    platformModelCatalog.entries = entries;
    state.platformModels = entries;
    platformModelCatalog.loaded = true;
    runtimeRequestBackoff.succeed(PLATFORM_MODEL_CATALOG_REQUEST_KEY);
    return { entries, loaded: true, changed };
  } catch (error) {
    runtimeRequestBackoff.fail(PLATFORM_MODEL_CATALOG_REQUEST_KEY);
    console.warn("[renderer] platform model catalog load failed:", error?.message || error);
    return { entries: platformModelCatalog.entries, loaded: false, changed: false, error };
  } finally {
    platformModelCatalog.loading = false;
  }
}

function setComposerSelectOptions(select, entries, selectedValue, options = {}) {
  if (!select) return "";
  const allowEmpty = Boolean(options.allowEmpty);
  const selectFirst = options.selectFirst !== false;
  const emptyLabel = String(options.emptyLabel || "");
  const emptyOption = allowEmpty ? [{ value: "", label: emptyLabel || "选择", title: "", aliases: [], placeholder: true }] : [];
  const normalized = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && (entry.id !== undefined || entry.value !== undefined || entry.model !== undefined))
    .map((entry) => ({
      value: String(entry.id || entry.value || entry.model || ""),
      label: String(entry.label || entry.id || entry.value),
      title: String(entry.title || ""),
      aliases: Array.isArray(entry.aliases) ? entry.aliases.map((item) => String(item)) : [],
      placeholder: false
    }));
  select.innerHTML = [
    ...emptyOption,
    ...normalized
  ].map((entry) => {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = entry.label;
    if (entry.title) option.title = entry.title;
    if (entry.placeholder) option.dataset.placeholder = "true";
    return option.outerHTML;
  }).join("");
  const value = String(selectedValue || "");
  const selected = normalized.find((entry) => entry.value === value || entry.aliases.includes(value));
  if (selected) select.value = selected.value;
  else select.value = allowEmpty || !selectFirst ? "" : (normalized[0]?.value || "");
  return select.selectedOptions?.[0]?.textContent || "";
}

function composerRuntimeControlForSelect(select) {
  return select?.closest?.(".model-switcher, .effort-switcher, .permission-switcher") || null;
}

function setComposerRuntimeControlVisible(select, visible) {
  const control = composerRuntimeControlForSelect(select);
  control?.classList.toggle("hidden", !visible);
  control?.setAttribute("aria-hidden", visible ? "false" : "true");
  if (!visible) {
    control?.classList.remove("select-open");
    window.miaReactSelectMenu?.close?.(select);
  }
}

function clearComposerRuntimeControl(select, label) {
  if (select) {
    select.innerHTML = "";
    select.value = "";
    select.disabled = true;
  }
  if (label) setText(label, "");
}

async function ensureBotRuntimeBinding(botKey, runtimeKind = "cloud-claude-code") {
  return window.miaBotCommands.getBotRuntimeBinding({
    api: window.mia,
    cache: botRuntimeControlCache,
    botKey,
    runtimeKind
  });
}

function runtimeControlOptionsCacheKey(context = activeBotRuntimeControlContext()) {
  const botKey = String(context?.botKey || "").trim();
  if (!botKey) return "";
  const runtimeKey = botRuntimeCacheKey(botKey, context.runtimeKind || "cloud-claude-code");
  const conversationId = String(context?.conversationId || "").trim();
  return conversationId ? `${runtimeKey}:conversation:${conversationId}` : runtimeKey;
}

function runtimeControlOptionsBackoffKey(context = activeBotRuntimeControlContext()) {
  const key = runtimeControlOptionsCacheKey(context);
  return key ? `runtime-options:${key}` : "";
}

function runtimeControlArray(value) {
  return Array.isArray(value) ? value : [];
}

function usesManagedCloudAgentPermissions(context = activeBotRuntimeControlContext()) {
  return usesCloudAgentRuntimeControls(context);
}

function usesCloudAgentRuntimeControls(context = activeBotRuntimeControlContext()) {
  const runtimeKind = String(context?.runtimeKind || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  return runtimeKind === "cloud-claude-code"
    || runtimeKind === "mia-cloud"
    || runtimeKind === "miacloud";
}

function runtimeControlOptionValue(entry = {}) {
  return String(entry.id || entry.value || entry.model || "").trim();
}

function runtimeControlSelectedEntry(entries = [], selectedValue = "") {
  const value = String(selectedValue || "").trim();
  if (!value) return null;
  return (Array.isArray(entries) ? entries : []).find((entry) => {
    const entryValue = runtimeControlOptionValue(entry);
    if (entryValue === value) return true;
    const aliases = Array.isArray(entry?.aliases) ? entry.aliases.map((item) => String(item || "").trim()) : [];
    return aliases.includes(value);
  }) || null;
}

function activeBotRuntimeSendConfig() {
  const context = activeBotRuntimeControlContext();
  const options = runtimeControlOptionsForContext(context);
  if (!context || !options) return {};
  const config = {};
  const modelEntries = runtimeControlArray(options.modelOptions);
  const selectedModelValue = String(els.quickModelSelect?.value || options.selectedModel || "").trim();
  const selectedModelEntry = runtimeControlSelectedEntry(modelEntries, selectedModelValue);
  if (selectedModelEntry) {
    const model = String(selectedModelEntry.model || selectedModelEntry.id || selectedModelEntry.value || "").trim();
    const providerConnectionId = String(
      selectedModelEntry.providerConnectionId
      || selectedModelEntry.provider_connection_id
      || selectedModelEntry.provider
      || ""
    ).trim();
    const modelProfileId = String(
      selectedModelEntry.modelProfileId
      || selectedModelEntry.model_profile_id
      || selectedModelEntry.profileId
      || selectedModelEntry.profile_id
      || ""
    ).trim();
    if (model) config.model = model;
    if (providerConnectionId) config.providerConnectionId = providerConnectionId;
    if (modelProfileId) config.modelProfileId = modelProfileId;
  }
  const effortEntries = runtimeControlArray(options.effortOptions);
  const selectedEffort = String(els.effortSelect?.value || options.selectedEffort || "").trim();
  if (runtimeControlSelectedEntry(effortEntries, selectedEffort)) config.effortLevel = selectedEffort;
  const permissionEntries = usesManagedCloudAgentPermissions(context)
    ? []
    : runtimeControlArray(options.permissionOptions);
  const selectedPermission = String(els.permissionMode?.value || options.selectedPermission || "").trim();
  if (runtimeControlSelectedEntry(permissionEntries, selectedPermission)) config.permissionMode = selectedPermission;
  return config;
}

function runtimeControlOptionsForContext(context = activeBotRuntimeControlContext()) {
  if (usesCloudAgentRuntimeControls(context)) return null;
  const key = runtimeControlOptionsCacheKey(context);
  return key
    ? (window.miaResourceCache?.touchMapValue?.(botRuntimeControlOptionsCache, key)
      || botRuntimeControlOptionsCache.get(key)
      || null)
    : null;
}

function runtimeControlOptionsLoadStateForContext(context = activeBotRuntimeControlContext()) {
  const key = runtimeControlOptionsCacheKey(context);
  return key
    ? (window.miaResourceCache?.touchMapValue?.(botRuntimeControlOptionsLoadStates, key)
      || botRuntimeControlOptionsLoadStates.get(key)
      || { status: "idle" })
    : { status: "idle" };
}

function setRuntimeControlOptionsLoadState(context, status, error = "") {
  const key = runtimeControlOptionsCacheKey(context);
  if (!key) return;
  botRuntimeControlOptionsLoadStates.set(key, { status, error: String(error || "") });
  pruneRuntimeControlCaches(key);
}

function runtimeControlOptionsStatusText(loadState = {}) {
  if (loadState.status === "error") {
    const detail = String(loadState.error || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    return detail ? `运行配置读取失败：${detail}` : "运行配置读取失败";
  }
  return "运行配置读取中...";
}

function runtimeControlStateSnapshot() {
  return {
    modelCatalog: window.miaModelHelpers?.catalogEntries?.() || [],
    platformModels: Array.isArray(state.platformModels) ? state.platformModels : [],
    engineCapabilities: state.engineCapabilities || {},
    codexModels: state.codexModels || []
  };
}

function platformModelEntriesForNativeRuntimeControls() {
  const rawEntries = Array.isArray(state.platformModels) && state.platformModels.length
    ? state.platformModels
    : (state.runtime?.cloud?.enabled ? [{ id: "mia-auto", label: "Auto" }] : []);
  return rawEntries.map((entry = {}) => {
    const model = String(entry.id || entry.value || entry.model || entry.model_name || "").trim();
    if (!model) return null;
    return {
      id: model,
      value: model,
      label: String(entry.label || entry.name || entry.displayName || (model === "mia-auto" ? "Auto" : model)).trim(),
      model,
      provider: "mia",
      providerConnectionId: "mia",
      providerLabel: "Mia",
      authType: "mia_account",
      modelProfileId: `mia:${model}`
    };
  }).filter(Boolean);
}

function runtimeControlInventorySignature(runtime = state.runtime) {
  const agents = Array.isArray(runtime?.agentInventory?.agents) ? runtime.agentInventory.agents : [];
  if (!agents.length) return "";
  return JSON.stringify(agents.map((agent) => ({
    id: String(agent?.id || ""),
    usableInMia: Boolean(agent?.usableInMia ?? agent?.usable_in_mia),
    health: String(agent?.health || ""),
    readinessStatus: String(agent?.readiness?.status || "")
  })).sort((left, right) => left.id.localeCompare(right.id)));
}

function runtimeControlOptionsRequest(context = activeBotRuntimeControlContext()) {
  const bindingKey = context?.botKey
    ? botRuntimeCacheKey(context.botKey, context.runtimeKind || "cloud-claude-code")
    : "";
  const binding = bindingKey
    ? (window.miaResourceCache?.touchMapValue?.(botRuntimeControlCache, bindingKey)
      || botRuntimeControlCache.get(bindingKey))
    : null;
  return {
    runtimeKind: context?.runtimeKind || "cloud-claude-code",
    bot: context?.bot || {},
    runtime: state.runtime || {},
    binding: binding || {},
    ...runtimeControlStateSnapshot()
  };
}

function runtimeControlOptionsPayload(result) {
  return result?.data && typeof result.data === "object" ? result.data : result;
}

function runtimeControlFieldCategory(field = "") {
  if (field === "model") return "model";
  if (field === "effortLevel" || field === "effort") return "thought_level";
  if (field === "permissionMode" || field === "permission") return "permission";
  return "";
}

function runtimeControlOptionsFromSnapshot(snapshot = {}, runtimeKind = "desktop-local") {
  const controls = Array.isArray(snapshot?.controls) ? snapshot.controls : [];
  const snapshotEngine = String(snapshot?.engine || "").trim().toLowerCase();
  const find = (category) => controls.find((control) => control?.category === category) || null;
  const normalizeOptions = (control) => (Array.isArray(control?.options) ? control.options : []).map((choice) => {
    const value = String(choice?.value || "");
    const isMiaModel = control?.category === "model"
      && (value === "mia-auto"
        || value === "mia-default"
        || String(choice?.description || "") === "Mia platform model");
    const isNativeModel = control?.category === "model" && Boolean(snapshotEngine) && !isMiaModel;
    const upstreamLabel = String(choice?.label || value).trim();
    const label = isMiaModel && typeof globalThis.miaEngineContracts?.platformModelDisplayLabel === "function"
      ? globalThis.miaEngineContracts.platformModelDisplayLabel(choice, value)
      // Claude Code annotates its default alias as "Default (recommended)".
      // The selection value already retains that intent, so avoid repeating it
      // in Mia's compact model picker.
      : (control?.category === "model"
        ? (upstreamLabel.replace(/\s*\(\s*recommended\s*\)\s*$/i, "").trim() || upstreamLabel)
        : upstreamLabel);
    return {
      id: value,
      value,
      model: control?.category === "model" ? value : "",
      ...(isMiaModel ? {
        provider: "mia",
        providerConnectionId: "mia",
        modelProfileId: `mia:${value}`
      } : isNativeModel ? {
        provider: snapshotEngine,
        providerConnectionId: snapshotEngine,
        modelProfileId: `${snapshotEngine}:${value}`
      } : {}),
      label,
      title: String(choice?.description || "")
    };
  }).filter((choice) => choice.id);
  const model = find("model");
  const effort = find("thought_level");
  const permission = find("permission");
  const sessionPermission = find("session_permission");
  const modelOptions = normalizeOptions(model);
  const selectedModel = String(model?.currentValue || "");
  const agentEngine = String(snapshot?.engine || "");
  const memoryMode = String(snapshot?.memoryMode || "").trim();
  const nativeHermesMemory = agentEngine.toLowerCase() === "hermes" && memoryMode === "native";
  return {
    runtimeKind,
    agentEngine,
    memoryMode,
    nativeMemoryFallback: nativeHermesMemory,
    statusText: snapshot?.state === "ready" ? agentEngine : "Agent 连接中...",
    sendBlocked: snapshot?.state !== "ready",
    sendBlockReason: snapshot?.state === "error" ? String(snapshot?.error || "Agent 连接失败") : "",
    modelOptions,
    selectedModel,
    selectedModelEntry: modelOptions.find((entry) => entry.id === selectedModel) || null,
    effortOptions: normalizeOptions(effort),
    selectedEffort: String(effort?.currentValue || ""),
    permissionOptions: normalizeOptions(permission),
    selectedPermission: String(permission?.currentValue || ""),
    hermesSessionYoloActive: String(sessionPermission?.currentValue || "") === "on",
    hermesSessionYoloControlId: String(sessionPermission?.id || ""),
    acpSessionId: String(snapshot?.sessionId || ""),
    _acpControls: controls
  };
}
window.miaRuntimeControlOptionsFromSnapshot = runtimeControlOptionsFromSnapshot;

function usesNativeConversationRuntimeControls(context = {}) {
  return context?.runtimeKind === "desktop-local" && Boolean(context?.conversationId);
}

function nativeConversationRuntimeControlInput(context = {}) {
  const bot = context?.bot || {};
  const agentEngine = String(bot.agentEngine || bot.agent_engine || "").trim();
  const normalizedEngine = agentEngine.toLowerCase().replace(/_/g, "-");
  // Codex and Claude Code permission profiles are an Agent-level preference,
  // not a per-conversation default. Pass the saved engine preference into every
  // prepare/send request so a newly opened conversation starts consistently.
  const enginePermissionMode = ["codex", "claude-code"].includes(normalizedEngine)
    ? String(state.runtime?.permissions?.engines?.[normalizedEngine] || "").trim()
    : "";
  return {
    botId: context?.botKey || bot.id || bot.key || "",
    botName: bot.name || bot.displayName || context?.botKey || "",
    agentEngine,
    runtimeKind: "desktop-local",
    ...(enginePermissionMode ? { permissionMode: enginePermissionMode } : {}),
    // Hermes already advertises its active models through ACP. Supplying Mia's
    // catalog here makes an unselected `mia-auto` look like a native Hermes model.
    ...(agentEngine.toLowerCase() === "hermes"
      ? {}
      : { modelEntries: platformModelEntriesForNativeRuntimeControls() })
  };
}

function invalidateRuntimeControlOptions(context = activeBotRuntimeControlContext()) {
  const key = runtimeControlOptionsCacheKey(context);
  if (key) {
    botRuntimeControlOptionsCache.delete(key);
    botRuntimeControlOptionsLoadStates.delete(key);
  }
  const backoffKey = runtimeControlOptionsBackoffKey(context);
  if (backoffKey) runtimeRequestBackoff.reset(backoffKey);
}

const RUNTIME_CONTROL_REQUEST_TIMEOUT_MS = 65_000;

function runtimeControlRequestWithTimeout(pending, timeoutMs = RUNTIME_CONTROL_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error("运行配置读取超时")), timeoutMs);
    Promise.resolve(pending).then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function requestRuntimeControlOptions(context = activeBotRuntimeControlContext()) {
  if (usesCloudAgentRuntimeControls(context)) return Promise.resolve(null);
  const key = runtimeControlOptionsCacheKey(context);
  const backoffKey = runtimeControlOptionsBackoffKey(context);
  if (!key) return Promise.resolve(null);
  const existing = botRuntimeControlOptionsInFlight.get(key);
  if (existing) return existing;
  if (!runtimeRequestBackoff.canRun(backoffKey)) return Promise.resolve(null);
  const nativeControls = usesNativeConversationRuntimeControls(context);
  const api = nativeControls
    ? window.mia?.social?.prepareConversationRuntimeControls
    : window.mia?.social?.getBotRuntimeControlOptions;
  if (typeof api !== "function") {
    setRuntimeControlOptionsLoadState(context, "error", "运行配置接口不可用");
    setRuntimeControlDisabled(true);
    setModelSwitchStatusText("运行配置接口不可用");
    return Promise.resolve(null);
  }
  const request = nativeControls
    ? nativeConversationRuntimeControlInput(context)
    : runtimeControlOptionsRequest(context);
  setRuntimeControlOptionsLoadState(context, "loading");
  const pending = Promise.resolve().then(() => nativeControls ? api(context.conversationId, request) : api(request));
  const task = runtimeControlRequestWithTimeout(pending)
    .then((result) => {
      if (result && result.ok === false) throw new Error(result.error || result.message || "Runtime control options failed");
      const payload = runtimeControlOptionsPayload(result);
      const options = nativeControls
        ? runtimeControlOptionsFromSnapshot(payload, context.runtimeKind)
        : payload;
      if (!options || typeof options !== "object") throw new Error("Runtime control options response was empty");
      botRuntimeControlOptionsCache.set(key, options);
      pruneRuntimeControlCaches(key);
      setRuntimeControlOptionsLoadState(context, "ready");
      runtimeRequestBackoff.succeed(backoffKey);
      const latest = activeConversationBotContext();
      if (latest?.conversationId === context?.conversationId) render();
      return options;
    })
    .catch((error) => {
      runtimeRequestBackoff.fail(backoffKey);
      setRuntimeControlOptionsLoadState(context, "error", error?.message || error);
      setRuntimeControlDisabled(true);
      setModelSwitchStatusText(runtimeControlOptionsStatusText({
        status: "error",
        error: error?.message || error
      }));
      console.warn("[renderer] bot runtime control options failed:", error?.message || error);
      return null;
    })
    .finally(() => {
      if (botRuntimeControlOptionsInFlight.get(key) === task) {
        botRuntimeControlOptionsInFlight.delete(key);
      }
    });
  botRuntimeControlOptionsInFlight.set(key, task);
  return task;
}

function setComposerModelAvatar(entry = {}, engine = "hermes", options = {}) {
  const modelAvatar = document.querySelector(".model-avatar");
  if (options.hidden) {
    applyComposerModelAvatar(modelAvatar, "", { hidden: true });
    return;
  }
  const icon = window.miaModelHelpers.modelIconSrc({
    provider: entry.provider || (engine === "codex" ? "openai-codex" : engine === "claude-code" ? "anthropic" : engine),
    model: entry.model || entry.id || entry.value || ""
  });
  applyComposerModelAvatar(modelAvatar, icon);
}

function setComposerModelControlSummary(modelLabel = "", effortLabel = "") {
  const model = String(modelLabel || "").trim();
  const effort = String(effortLabel || "").trim();
  setText(els.quickModelLabel, [model, effort].filter(Boolean).join(" · "));
  if (els.quickModelSelect) {
    els.quickModelSelect.title = [model, effort].filter(Boolean).join(" · ");
  }
}

function syncConversationBotRuntimeControls() {
  els.modelSwitchStatus?.classList.remove("runtime-feedback");
  const context = activeConversationBotContext();
  if (!context) {
    if (window.miaSocial?.getActiveConversationId?.()) {
      setRuntimeControlDisabled(true);
      clearComposerRuntimeControl(els.quickModelSelect, els.quickModelLabel);
      clearComposerRuntimeControl(els.effortSelect, els.effortLabel);
      clearComposerRuntimeControl(els.permissionMode, els.permissionLabel);
      window.miaHermesPermissionMenu?.clear?.(els.permissionMode);
      setComposerRuntimeControlVisible(els.quickModelSelect, false);
      setComposerRuntimeControlVisible(els.effortSelect, false);
      setComposerRuntimeControlVisible(els.permissionMode, false);
      setModelSwitchStatusText("当前聊天不支持切换模型");
    }
    return false;
  }
  const controlContext = activeBotRuntimeControlContext();
  if (usesCloudAgentRuntimeControls(controlContext)) {
    setRuntimeControlDisabled(true);
    clearComposerRuntimeControl(els.quickModelSelect, els.quickModelLabel);
    clearComposerRuntimeControl(els.effortSelect, els.effortLabel);
    clearComposerRuntimeControl(els.permissionMode, els.permissionLabel);
    window.miaHermesPermissionMenu?.clear?.(els.permissionMode);
    setComposerRuntimeControlVisible(els.quickModelSelect, false);
    setComposerRuntimeControlVisible(els.effortSelect, false);
    setComposerRuntimeControlVisible(els.permissionMode, false);
    setComposerModelAvatar({}, "", { hidden: true });
    setComposerModelControlSummary("", "");
    setModelSwitchStatusText("Mia Cloud");
    return true;
  }
  const options = runtimeControlOptionsForContext(controlContext);
  if (!options) {
    els.modelSwitchStatus?.classList.add("runtime-feedback");
    requestRuntimeControlOptions(controlContext);
  }
  const loadState = runtimeControlOptionsLoadStateForContext(controlContext);
  const engine = String(options?.agentEngine || "").trim();
  const modelEntries = runtimeControlArray(options?.modelOptions);
  const effortEntries = runtimeControlArray(options?.effortOptions);
  const selectedModelValue = String(options?.selectedModel || "").trim();
  const configuredModelEntry = options?.selectedModelEntry || runtimeControlSelectedEntry(modelEntries, selectedModelValue) || {};
  setComposerRuntimeControlVisible(els.quickModelSelect, modelEntries.length > 0 || effortEntries.length > 0);
  const modelLabel = setComposerSelectOptions(
    els.quickModelSelect,
    modelEntries,
    selectedModelValue,
    { allowEmpty: false, selectFirst: false }
  );
  const selectedEffort = String(options?.selectedEffort || "").trim();
  setComposerRuntimeControlVisible(els.effortSelect, false);
  const effortLabel = setComposerSelectOptions(
    els.effortSelect,
    effortEntries,
    selectedEffort,
    { allowEmpty: false, selectFirst: false }
  );
  setText(els.effortLabel, effortLabel);
  setComposerModelControlSummary(modelLabel, effortLabel);
  const selectedModelSelectValue = String(els.quickModelSelect?.value || selectedModelValue || "").trim();
  const selectedModelEntry = selectedModelSelectValue
    ? (modelEntries.find((entry) => String(entry.id || entry.value || "") === selectedModelSelectValue)
      || options?.selectedModelEntry
      || {})
    : configuredModelEntry;
  const hasSelectedModelEntry = Boolean(selectedModelEntry?.id || selectedModelEntry?.value || selectedModelEntry?.model || selectedModelEntry?.provider);
  setComposerModelAvatar(selectedModelEntry, engine, { hidden: !hasSelectedModelEntry });
  const selectedEffortEntry = runtimeControlSelectedEntry(effortEntries, selectedEffort) || {};
  const cloudPermissionsManaged = usesManagedCloudAgentPermissions(controlContext);
  const permissionEntries = cloudPermissionsManaged
    ? []
    : runtimeControlArray(options?.permissionOptions);
  const selectedPermission = cloudPermissionsManaged ? "" : String(options?.selectedPermission || "").trim();
  const selectedPermissionEntry = runtimeControlSelectedEntry(permissionEntries, selectedPermission) || {};
  const hermesPermissionMenuEnabled = engine.toLowerCase() === "hermes"
    && Boolean(options?.hermesSessionYoloControlId);
  const hermesSessionYoloActive = hermesPermissionMenuEnabled
    && Boolean(options?.hermesSessionYoloActive);
  const hermesGlobalYoloActive = engine.toLowerCase() === "hermes"
    && ["off", "yolo"].includes(selectedPermission.toLowerCase());
  setComposerRuntimeControlVisible(els.permissionMode, permissionEntries.length > 0);
  const permissionLabel = setComposerSelectOptions(
    els.permissionMode,
    permissionEntries,
    selectedPermission,
    { allowEmpty: false, selectFirst: false }
  );
  setText(
    els.permissionLabel,
    hermesSessionYoloActive && !hermesGlobalYoloActive ? "YOLO（仅本会话）" : permissionLabel
  );
  window.miaHermesPermissionMenu?.configure?.({
    select: els.permissionMode,
    enabled: hermesPermissionMenuEnabled,
    approvalMode: selectedPermission,
    sessionYoloActive: hermesSessionYoloActive,
    onToggleYolo: setActiveHermesSessionYolo
  });
  const permissionSwitcher = els.permissionMode?.closest(".permission-switcher");
  const fullAccessPermission = window.miaEngineContracts?.isFullAccessPermissionMode?.(els.permissionMode?.value);
  permissionSwitcher?.classList.toggle("yolo", hermesSessionYoloActive
    || hermesGlobalYoloActive
    || (fullAccessPermission && !(engine === "claude-code" && els.permissionMode?.value === "bypassPermissions")));
  permissionSwitcher?.classList.toggle("claude-bypass", engine === "claude-code" && els.permissionMode?.value === "bypassPermissions");
  if (els.quickModelSelect) els.quickModelSelect.disabled = !(modelEntries.length || effortEntries.length);
  if (els.effortSelect) els.effortSelect.disabled = !effortEntries.length;
  if (els.permissionMode) els.permissionMode.disabled = !permissionEntries.length;
  setModelSwitchStatusText(options?.statusText || runtimeControlOptionsStatusText(loadState));
  if (!platformModelCatalog.loaded && !platformModelCatalog.loading) {
    loadPlatformModelCatalog().then((result) => {
      if (!result?.changed) return;
      const latest = activeConversationBotContext();
      if (latest?.conversationId === context.conversationId) {
        invalidateRuntimeControlOptions(controlContext);
        render();
      }
    });
  }
  const runtimeCacheKey = botRuntimeCacheKey(context.botKey, context.runtimeKind);
  const runtimeBindingBackoffKey = `runtime-binding:${runtimeCacheKey}`;
  if (!botRuntimeControlCache.has(runtimeCacheKey)
    && !botRuntimeControlInFlight.has(runtimeCacheKey)
    && runtimeRequestBackoff.canRun(runtimeBindingBackoffKey)) {
    botRuntimeControlInFlight.add(runtimeCacheKey);
    ensureBotRuntimeBinding(context.botKey, context.runtimeKind)
      .then(() => {
        runtimeRequestBackoff.succeed(runtimeBindingBackoffKey);
        const latest = activeConversationBotContext();
        if (latest?.conversationId === context.conversationId) {
          invalidateRuntimeControlOptions(controlContext);
          render();
        }
      })
      .catch((error) => {
        runtimeRequestBackoff.fail(runtimeBindingBackoffKey);
        setRuntimeControlOptionsLoadState(controlContext, "error", error?.message || error);
        if (activeConversationBotContext()?.conversationId === context.conversationId) render();
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
  if (!context || usesCloudAgentRuntimeControls(context)) return false;
  setModelSwitchStatusText(pendingText);
  setRuntimeControlDisabled(true);
  try {
    let confirmedNativeOptions = null;
    if (usesNativeConversationRuntimeControls(context)) {
      const options = runtimeControlOptionsForContext(context);
      const category = runtimeControlFieldCategory(field);
      const control = runtimeControlArray(options?._acpControls).find((entry) => entry?.category === category);
      if (!control?.id) throw new Error("当前 Agent 没有提供这个控制项");
      const setControl = window.mia?.social?.setConversationRuntimeControl;
      if (typeof setControl !== "function") throw new Error("运行配置接口不可用");
      const observed = await setControl(context.conversationId, {
        ...nativeConversationRuntimeControlInput(context),
        controlId: control.id,
        value
      });
      if (observed && observed.ok === false) throw new Error(observed.error || observed.message || "Agent 未确认设置");
      confirmedNativeOptions = runtimeControlOptionsFromSnapshot(
        runtimeControlOptionsPayload(observed),
        context.runtimeKind
      );
      const confirmedControl = runtimeControlArray(confirmedNativeOptions._acpControls)
        .find((entry) => entry?.category === category);
      if (String(confirmedControl?.currentValue || "") !== String(value || "")) {
        throw new Error("Agent 未确认设置");
      }
    }
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
    if (confirmedNativeOptions) {
      const key = runtimeControlOptionsCacheKey(context);
      if (key) {
        botRuntimeControlOptionsCache.set(key, confirmedNativeOptions);
        pruneRuntimeControlCaches(key);
      }
    } else {
      invalidateRuntimeControlOptions(context);
    }
    setModelSwitchStatusText(successText);
    render();
  } catch (error) {
    setModelSwitchStatusText("保存失败");
    appendTransientChat("assistant", `${errorPrefix}: ${error.message || error}`);
    syncConversationBotRuntimeControls();
  } finally {
    setRuntimeControlDisabled(false);
  }
  return true;
}

async function saveActivePermissionRuntimeControl(mode) {
  if (usesManagedCloudAgentPermissions()) return false;
  const context = activeBotRuntimeControlContext();
  const options = runtimeControlOptionsForContext(context);
  const agentEngine = String(
    options?.agentEngine
    || context?.bot?.agentEngine
    || context?.bot?.agent_engine
    || ""
  ).trim().toLowerCase().replace(/_/g, "-");
  // External ACP engines advertise permission profiles that apply to the
  // Agent itself. Persist that preference before updating the live session so
  // every later conversation inherits the user's last selection.
  if (["codex", "claude-code"].includes(agentEngine)) {
    const savePreference = window.mia?.savePermissionSettings;
    if (typeof savePreference !== "function") {
      setModelSwitchStatusText("权限设置接口不可用");
      return false;
    }
    setModelSwitchStatusText("保存 Agent 权限...");
    setRuntimeControlDisabled(true);
    try {
      const runtime = await savePreference({ agentEngine, mode });
      if (runtime && typeof runtime === "object") state.runtime = runtime;
    } catch (error) {
      setModelSwitchStatusText("权限保存失败");
      appendTransientChat("assistant", `Permission mode failed: ${error.message || error}`);
      return false;
    } finally {
      setRuntimeControlDisabled(false);
    }
  }
  return saveActiveBotRuntimeControl(
    "permissionMode",
    mode || "",
    "保存权限...",
    "权限已更新",
    "Permission mode failed"
  );
}

async function setActiveHermesSessionYolo(enabled) {
  const context = activeBotRuntimeControlContext();
  const options = runtimeControlOptionsForContext(context);
  if (!context || String(options?.agentEngine || "").trim().toLowerCase() !== "hermes") return false;
  const control = runtimeControlArray(options?._acpControls)
    .find((entry) => entry?.category === "session_permission");
  if (!control?.id || !usesNativeConversationRuntimeControls(context)) return false;
  window.miaReactSelectMenu.close(els.permissionMode);
  setModelSwitchStatusText(enabled ? "正在开启会话 YOLO..." : "正在关闭会话 YOLO...");
  setRuntimeControlDisabled(true);
  try {
    const setControl = window.mia?.social?.setConversationRuntimeControl;
    if (typeof setControl !== "function") throw new Error("运行配置接口不可用");
    const observed = await setControl(context.conversationId, {
      ...nativeConversationRuntimeControlInput(context),
      controlId: control.id,
      value: enabled ? "on" : "off"
    });
    if (observed && observed.ok === false) {
      throw new Error(observed.error || observed.message || "Hermes 未确认会话 YOLO 设置");
    }
    const confirmed = runtimeControlOptionsFromSnapshot(
      runtimeControlOptionsPayload(observed),
      context.runtimeKind
    );
    if (Boolean(confirmed.hermesSessionYoloActive) !== Boolean(enabled)) {
      throw new Error("Hermes 未确认会话 YOLO 设置");
    }
    const key = runtimeControlOptionsCacheKey(context);
    if (key) {
      botRuntimeControlOptionsCache.set(key, confirmed);
      pruneRuntimeControlCaches(key);
    }
    setModelSwitchStatusText(enabled ? "当前会话 YOLO 已开启" : "当前会话 YOLO 已关闭");
    render();
    return true;
  } catch (error) {
    setModelSwitchStatusText("会话 YOLO 切换失败");
    appendTransientChat("assistant", `Hermes session YOLO failed: ${error.message || error}`);
    syncConversationBotRuntimeControls();
    return false;
  } finally {
    setRuntimeControlDisabled(false);
  }
}

function activeConversationBotKey() {
  const social = window.miaSocial;
  const conversationId = social?.getActiveConversationId?.();
  if (!conversationId) return "";
  const conversation = social?.getConversationById?.(conversationId);
  if (!conversation) return "";
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
  const activeContext = activeConversationBotContext();
  const runtimeKindFallback = activeContext?.runtimeKind || runtimeKindForBotConversation(conversation);
  const payload = sessionHistory.createBotSessionPayload(conversation, cryptoRandomId(), {
    title: "新对话",
    runtimeKindFallback,
    agentEngine: activeContext?.agentEngine || ""
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
    decorations: {
      botId,
      sessionId: payload.sessionId,
      runtimeKind: payload.runtimeKind,
      ...(payload.agentEngine ? { agentEngine: payload.agentEngine } : {})
    },
    created_at: now,
    updated_at: now
  };
  if (typeof window.mia.social.cacheConversationMetadata === "function") {
    try {
      const cached = await window.mia.social.cacheConversationMetadata(optimisticConversation);
      if (cached?.ok === false) {
        console.warn("[renderer] cacheConversationMetadata failed:", cached.error || "unknown");
      }
    } catch (error) {
      console.warn("[renderer] cacheConversationMetadata error:", error?.message || error);
    }
  }
  window.miaSocial?.upsertBotConversation?.(optimisticConversation);
  await selectCloudSessionConversation(optimisticConversation, { skipMessageLoad: true });

  window.mia.social.ensureBotSessionConversation(payload.sessionId, {
    botId,
    title: payload.title,
    runtimeKind: payload.runtimeKind,
    ...(payload.agentEngine ? { agentEngine: payload.agentEngine } : {})
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

let runtimeRefreshScheduler = null;
let runtimeFallbackRefreshTimer = 0;
let rendererModulesReady = false;

async function performRefreshRuntime() {
  // The visibility event can fire while the first-paint runtime bootstrap is
  // still waiting on IPC. Do not publish a runtime (and trigger a full render)
  // until every extracted renderer module has received its dependencies.
  if (!rendererModulesReady) return state.runtime;
  const previousDaemon = state.runtime?.daemon || {};
  const previousCloud = state.runtime?.cloud || {};
  const previousRuntimeControlInventory = runtimeControlInventorySignature(state.runtime);
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
  if (runtime?.cloud && previousCloud?.mobileScan && !runtime.cloud.mobileScan) {
    runtime.cloud = {
      ...runtime.cloud,
      mobileScan: previousCloud.mobileScan
    };
  }
  state.runtime = runtime;
  const nextRuntimeControlInventory = runtimeControlInventorySignature(runtime);
  if (nextRuntimeControlInventory !== previousRuntimeControlInventory) {
    botRuntimeControlOptionsCache.clear();
    botRuntimeControlOptionsLoadStates.clear();
    runtimeRequestBackoff.resetAll();
  }
  if (state.coreStartup?.active && runtime?.daemon?.running) {
    completeCoreStartupProgress(true);
  }
  renderDaemonStatus(runtime.daemon || {});
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

function refreshRuntime() {
  if (runtimeRefreshScheduler) return runtimeRefreshScheduler.runNow();
  return performRefreshRuntime();
}

function renderCloudAccountFromState() {
  window.miaSettingsRemote.renderCloudAccount(state.runtime?.cloud || {});
}

function clearCloudMobileScanTimers() { window.miaCloudMobileLogin?.clear?.(); }
function closeCloudLoginApproveDialog() { window.miaCloudMobileLogin?.closeApproval?.(); }
function refreshCloudMobileScan(force = false) { return window.miaCloudMobileLogin?.refresh?.(force) || Promise.resolve(); }

function maybeBootstrapSocialAfterRuntime(runtime) {
  if (!runtime?.cloud?.enabled) return;
  if (!window.miaSocial || typeof window.miaSocial.bootstrapAfterLogin !== "function") return;
  const cachedBootstrapReady = typeof window.miaSocial.isBootstrapped === "function"
    && window.miaSocial.isBootstrapped();
  const liveBootstrapReady = typeof window.miaSocial.hasLiveBootstrapCompleted !== "function"
    || window.miaSocial.hasLiveBootstrapCompleted();
  if (cachedBootstrapReady && liveBootstrapReady) {
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
  if (!blockStartup && !runtime?.daemon?.running) {
    beginCoreStartupProgress("start");
    advanceCoreStartupProgress(35);
  }
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
      reportError: (message) => appendTransientChat("assistant", message),
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
      activePersona,
    });
  }
  window.miaCloudMobileLogin?.init?.({
    state,
    mia: window.mia,
    renderCloudAccount: renderCloudAccountFromState
  });
  if (window.miaEngineDetectionController?.init) {
    window.miaEngineDetectionController.init({ state, els });
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
      render,
      providerPresets,
      providerLabels,
    });
  }
  if (window.miaSessionMenuController?.init) {
    window.miaSessionMenuController.init({
      state,
      els,
      render,
      setAnimatedText,
      sessionHistory,
      allOwnedBots: () => window.miaBotManager?.allOwnedBots?.() || []
    });
  }
  if (window.miaBotDialog && window.miaBotDialog.initBotDialog) {
    window.miaBotDialog.initBotDialog({
      state,
      renderView,
      render,
      saveBotDialog: saveBotDialogDraft,
      openModelSettings: () => openSettingsView("model")
    });
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
  if (window.miaBotMemoryPanel && window.miaBotMemoryPanel.initBotMemoryPanel) {
    window.miaBotMemoryPanel.initBotMemoryPanel({
      state,
      renderContacts: () => window.miaBotManager?.renderContacts?.(),
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
      render: scheduleConversationRender,
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
      measurePerformance: (name, operation) => rendererPerformance.measure(name, operation),
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
  rendererModulesReady = true;
  render();
  if (state.runtime?.agentInventory?.summary?.scanning) {
    setTimeout(refreshRuntime, 120);
  }
  if (blockStartup) {
    const backgroundStartup = await runFirstRunBackgroundServices();
    await loadInitialRuntimeData();
    await loadTasksFromDaemonForStartup();
    await trackStartupTask("刷新运行状态", () => refreshRuntime()).catch((error) => {
      console.warn("[Mia startup] failed to refresh runtime", error);
    });
    completeCoreStartupProgress(backgroundStartup?.ok !== false);
    return;
  }
  const scheduleIdle = window.miaIdleScheduler?.schedule;
  if (typeof scheduleIdle === "function") {
    scheduleIdle(() => loadInitialRuntimeData(), {
      delayMs: 1_200,
      timeoutMs: 3_000,
      onError: (error) => console.warn("[Mia startup] failed to load runtime data", error)
    });
    scheduleIdle(() => loadTasksFromDaemonForStartup(), {
      delayMs: 2_800,
      timeoutMs: 4_000,
      onError: (error) => console.warn("[Mia startup] failed to load tasks", error)
    });
  } else {
    setTimeout(() => loadInitialRuntimeData(), 1_200);
    setTimeout(() => loadTasksFromDaemonForStartup(), 2_800);
  }
}

document.getElementById("groupInfoButton")?.addEventListener("click", () => {
  const conversationId = window.miaSocial?.getActiveConversationId?.();
  if (conversationId) window.miaGroupInfoDialog?.open(conversationId);
});

if (els.openSettings?.dataset.reactOwned !== "true") {
  els.openSettings?.addEventListener("click", () => {
    openSettingsView();
  });
}
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
  const attachmentEl = event.target.closest(".message-attachment");
  if (attachmentEl && els.chat.contains(attachmentEl) && openAttachmentContextMenu(attachmentEl, event.clientX, event.clientY)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const bubble = event.target.closest(".bubble[data-message-index], .message-attachments[data-message-index]");
  if (!bubble || !els.chat.contains(bubble)) return;
  const selection = window.miaMessageMenu?.selectionInsideBubble(bubble);
  const linkTarget = messageLinkCopyTarget(event.target.closest(messageLinkSelector));
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
    window.miaSocialMessageMenu?.openSocialMessageMenu(message, event.clientX, event.clientY, selection, linkTarget);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  window.miaMessageMenu?.openMessageContextMenu(bubble.dataset.messageIndex, event.clientX, event.clientY, selection, linkTarget);
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

window.miaReactBridge?.registerActions?.({
  composerBlur: handleComposerBlur,
  composerClick: handleComposerClick,
  composerCompositionEnd: handleComposerCompositionEnd,
  composerCompositionStart: handleComposerCompositionStart,
  composerContextMenu: handleComposerContextMenu,
  composerInput: handleComposerInput,
  composerKeyDown: handleComposerKeyDown,
  composerPaste: handleComposerPaste,
  navigateView: showRailView,
  selectExploreView: showExploreView,
  selectSettingsTab: showSettingsTab,
  selectTaskMode: showTaskMode,
  showPrimaryNavigation: showPrimaryNav,
  openSettings: () => openSettingsView()
});

document.querySelectorAll("[data-view]").forEach((button) => {
  if (button.dataset.reactOwned === "true") return;
  button.addEventListener("click", () => {
    showRailView(button.dataset.view);
  });
});

document.querySelectorAll("[data-primary-nav]").forEach((button) => {
  if (button.dataset.reactOwned === "true") return;
  button.addEventListener("click", () => {
    showPrimaryNav(button.dataset.primaryNav);
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

let windowResizeFrame = 0;
let windowResizeIdleTimer = 0;

function syncWindowResizeLayout() {
  windowResizeFrame = 0;
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
  if (transitionDirection) {
    normalizeNarrowPaneForView(state.activeView);
    state.shellLayout = shellLayoutForView(state.activeView);
    syncNarrowLayout();
    syncSidebarCollapseState();
    els.appShell?.setAttribute("data-shell-layout", state.shellLayout);
  }
  scheduleSidebarTagIndicator();
  triggerResponsiveShellTransition(transitionDirection);
}

function scheduleWindowResizeLayout() {
  document.body.classList.add("window-resizing");
  if (windowResizeIdleTimer) window.clearTimeout(windowResizeIdleTimer);
  windowResizeIdleTimer = window.setTimeout(() => {
    document.body.classList.remove("window-resizing");
    windowResizeIdleTimer = 0;
  }, 140);
  if (windowResizeFrame) return;
  windowResizeFrame = window.requestAnimationFrame(syncWindowResizeLayout);
}

window.addEventListener("resize", scheduleWindowResizeLayout);

els.cloudLogout?.addEventListener("click", async () => {
  els.cloudLogout.disabled = true;
  try {
    clearCloudMobileScanTimers();
    closeCloudLoginApproveDialog();
    state.runtime = await window.mia.cloudLogout();
    render();
  } catch (error) {
    setText(els.cloudAccountHint, `退出失败：${error.message || error}`);
  } finally {
    els.cloudLogout.disabled = false;
  }
});
els.cloudMobileScanRefresh?.addEventListener("click", () => {
  refreshCloudMobileScan(true).catch(() => {});
});
window.miaAppUpdate?.initAppUpdate({ els, api: window.mia, setText });

function renderDaemonStatus(status = {}) {
  const running = Boolean(status?.running);
  if (els.daemonHint) {
    const host = status?.host || status?.settings?.host || "";
    const port = status?.port || status?.settings?.port || "";
    const where = host && port ? ` · ${host}:${port}` : "";
    const lastError = String(status?.lastError || "").trim();
    const errorHint = !running && lastError ? ` · ${lastError}` : "";
    setText(els.daemonHint, running
      ? `运行中${where}  Mia Core 是本机运行核心`
      : `未运行${where}  Mia 暂不可用，请重启 Mia Core${errorHint}`);
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
  const mode = state.runtime?.daemon?.running ? "restart" : "start";
  beginCoreStartupProgress(mode);
  els.daemonRestart.disabled = true;
  setText(els.daemonHint, `Mia Core ${mode === "restart" ? "重启" : "启动"}中…`);
  try {
    if (mode === "restart") await window.mia.stopDaemon();
    advanceCoreStartupProgress(35);
    await window.mia.startDaemon();
    advanceCoreStartupProgress(70);
    await refreshRuntime().catch((error) => {
      console.warn("[Mia startup] failed to refresh runtime after manual daemon start", error);
    });
    completeCoreStartupProgress(true);
  } catch (error) {
    completeCoreStartupProgress(false);
    setText(els.daemonHint, `Mia Core ${mode === "restart" ? "重启" : "启动"}失败：${error.message || error}`);
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
      const runtimeKey = botRuntimeCacheKey(runtimeBinding.botId, runtimeBinding.runtimeKind);
      botRuntimeControlCache.set(
        runtimeKey,
        runtimeBinding
      );
      pruneRuntimeControlCaches(runtimeKey);
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
      renderCloudAccountFromState();
    }
    // Refresh runtime metadata (cloud connection / device list) only.
    // We intentionally do NOT reload chatStore here — that races with
    // unpersisted in-memory messages the user just sent, causing them to
    // disappear/reappear. Cross-device chat sync needs incremental
    // application of cloud message events; until that exists the local
    // device sees its own messages immediately and remote-device messages
    // on the next manual reload.
    const refreshControlPlane = envelope.type === "events_ready"
      || envelope.type === "device_updated"
      || String(envelope.type || "").startsWith("daemon.");
    if (refreshControlPlane) {
      clearTimeout(cloudEventRefreshTimer);
      cloudEventRefreshTimer = setTimeout(() => {
        refreshRuntime().catch((error) => {
          console.error("Failed to refresh runtime after Cloud event", error);
        });
      }, envelope.type === "events_ready" ? 500 : 120);
    }
  });
}

window.mia.onDesktopNotificationClick?.(openDesktopNotificationConversation);

els.codexLogin.addEventListener("click", async () => {
  els.codexLogin.disabled = true;
  try {
    const entry = window.miaModelHelpers.selectedModelEntry();
    if (entry) {
      if (entry.provider === "openai-codex") state.runtime = await window.mia.saveModel(modelSelectionIntent(entry));
    }
    state.runtime = await window.mia.startProviderOAuth({
      provider: entry?.provider || "openai-codex",
      providerLabel: entry?.providerLabel || window.miaModelHelpers.providerLabel(entry?.provider || "openai-codex"),
      authType: entry?.authType || "oauth_external"
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

els.codexInlineAuth?.addEventListener("click", async (event) => {
  const link = event.target.closest(messageLinkSelector);
  if (link && els.codexInlineAuth.contains(link)) {
    event.preventDefault();
    event.stopPropagation();
    openMessageLink(link);
    return;
  }
  const code = event.target.closest("code.inline-code");
  if (!code || !els.codexInlineAuth.contains(code)) return;
  if (await copyTextToClipboard(code.textContent)) flashCopiedCode(code);
});

els.quickModelSelect?.addEventListener("change", async () => {
  setComposerModelControlSummary(
    els.quickModelSelect.selectedOptions?.[0]?.textContent || "",
    els.effortSelect?.selectedOptions?.[0]?.textContent || ""
  );
  const context = activeBotRuntimeControlContext();
  const modelEntries = runtimeControlArray(runtimeControlOptionsForContext(context)?.modelOptions);
  if (!els.quickModelSelect.value) return;
  await saveActiveBotRuntimeControl(
    "model",
    els.quickModelSelect.value || "",
    "保存模型...",
    "模型已更新",
    "Model switch failed",
    modelEntries
  );
});

els.effortSelect?.addEventListener("change", async () => {
  const level = els.effortSelect.value;
  setText(els.effortLabel, els.effortSelect.selectedOptions?.[0]?.textContent || "");
  setComposerModelControlSummary(
    els.quickModelSelect?.selectedOptions?.[0]?.textContent || "",
    els.effortSelect.selectedOptions?.[0]?.textContent || ""
  );
  if (!level) return;
  await saveActiveBotRuntimeControl(
    "effortLevel",
    level,
    "保存推理强度...",
    "推理强度已更新",
    "Effort update failed"
  );
});

els.permissionMode?.addEventListener("change", async () => {
  const mode = els.permissionMode.value;
  setText(els.permissionLabel, els.permissionMode.selectedOptions?.[0]?.textContent || window.miaModelSettings.permissionLabelForMode(mode));
  if (!mode) return;
  await saveActivePermissionRuntimeControl(mode);
});

els.modelSelect?.addEventListener("change", () => {
  updateModelFieldVisibility();
});


els.newPersona.addEventListener("click", (event) => {
  event.stopPropagation();
  state.botMenuOpen = !state.botMenuOpen;
  renderView();
});

// 发现 AI 助手 | 联系人 —— 顶栏滑动胶囊（仿技能 我的技能/探索发现）。
// discover = 整屏卡片网格(bot 商店)；contacts = 列表(浮动白卡)+详情。
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
  window.miaBotDialog.openBotDialog();
});
els.contactMenuNewGroup?.addEventListener("click", () => {
  state.contactMenuOpen = false;
  renderView();
  window.miaSocial?.openCreateGroupDialog?.();
});
els.userAvatar?.addEventListener("click", openProfileDialogFromRenderer);
els.userAvatar?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openProfileDialogFromRenderer();
});
els.petJobButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  state.petJobPanelOpen = !state.petJobPanelOpen;
  window.miaPetDialog?.renderPetJobs();
});
els.appearanceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  window.miaSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceTheme.addEventListener("change", () => {
  window.miaSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceThemeToggle?.addEventListener("click", () => {
  els.appearanceTheme.value = els.appearanceTheme.value === "dark" ? "light" : "dark";
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

async function saveBotDialogDraft(draft) {
  try {
    const existingBot = draft.key
      ? window.miaBotManager?.botByKey?.(draft.key)
      : null;
    const existingBotBio = existingBot?.bio || existingBot?.description || "";
    const selectedRuntime = draft.runtime || {};
    const runtimeKind = selectedRuntime.runtimeKind || existingBot?.runtimeKind || "desktop-local";
    const targetDeviceId = selectedRuntime.targetDeviceId || state.runtime?.localDevice?.id || "";
    const targetDeviceName = selectedRuntime.targetDeviceName || state.runtime?.localDevice?.name || "";
    const agentEngine = selectedRuntime.agentEngine || "";
    if (!agentEngine) return "请先启用并选择可用的 Agent 内核。";
    const existingTargetDeviceId = existingBot?.targetDeviceId || existingBot?.target_device_id || existingBot?.deviceId || existingBot?.device_id || "";
    const runtimeChanged = draft.mode !== "edit"
      || runtimeKind !== (existingBot?.runtimeKind || existingBot?.runtime_kind || "desktop-local")
      || (runtimeKind === "desktop-local" && String(targetDeviceId || "") !== String(existingTargetDeviceId || ""))
      || (runtimeKind === "desktop-local" && String(agentEngine || "") !== String(existingBot?.agentEngine || existingBot?.agent_engine || "hermes"));
    const bot = {
      key: draft.key || "",
      name: draft.name,
      sourceKinds: existingBot?.sourceKinds || [],
      agentEngine,
      targetDeviceId,
      targetDeviceName,
      avatarImage: draft.avatar?.image || "",
      avatarCrop: window.miaAvatar.normalizeCrop(draft.avatar?.crop),
      color: draft.avatar?.color || "",
      statusBadge: statusBadgeForPreset(draft.badgeValue || ""),
      bio: draft.mode === "create" ? draft.persona : existingBotBio,
      description: draft.mode === "create" ? draft.persona : existingBotBio,
      personaText: draft.persona
    };
    const saved = await window.miaBotCommands.saveBot({
      state,
      bot,
      runtimeKind,
      isCreate: draft.mode !== "edit",
      activateRuntime: runtimeChanged,
      api: window.mia,
      social: window.miaSocial,
    });
    if (saved.runtime) state.runtime = saved.runtime;
    const savedKey = saved.key || "";
    const cloudConversation = saved.conversation || null;
    if (runtimeKind !== "cloud-claude-code" && savedKey) state.activeKey = savedKey;
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
    return "";
  } catch (error) {
    console.error("Failed to save bot", error);
    return `保存伙伴失败：${error?.message || error}`;
  }
}

els.modelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const entry = window.miaModelHelpers.selectedModelEntry();
  if (!entry || window.miaModelSettings.providerIsConnected(entry.provider)) return;
  const needsApiKey = entry.provider !== "openai-codex" && entry.provider !== "lmstudio" && !String(entry.authType || "").startsWith("oauth");
  if (needsApiKey && !els.modelApiKey.value.trim()) {
    setText(els.modelAuthState, `需要填写 ${window.miaModelHelpers.apiKeyPromptLabel(entry)}`);
    return;
  }
  state.runtime = await window.mia.saveModel(modelSelectionIntent(entry, els.modelApiKey.value));
  els.modelApiKey.value = "";
  if (els.modelSelect) els.modelSelect.value = "";
  render();
});

function refreshComposerInputDerivedState() {
  window.miaComposer.reconcilePathPasteRefsFromInput();
  window.miaMessageHelpers.resizeChatInput();
  window.miaComposer.updateSlashCommandState();
  window.miaComposer.updateMentionMenuState();
  renderSendButton();
}

const composerInputRefreshScheduler = window.miaComposerInputScheduler?.createComposerInputScheduler
  ? window.miaComposerInputScheduler.createComposerInputScheduler({
    refresh: refreshComposerInputDerivedState,
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id)
  })
  : {
    flush: refreshComposerInputDerivedState,
    schedule: refreshComposerInputDerivedState
  };

function handleComposerKeyDown(event) {
  if (window.miaMessageHelpers.isComposerComposing(event)) return;
  if (["Enter", "Tab", "ArrowDown", "ArrowUp", "Escape"].includes(event.key)) {
    composerInputRefreshScheduler.flush();
  }
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
}

window.mia?.onPathPasteText?.((payload = {}) => {
  if (!els.chatInput || document.activeElement !== els.chatInput) return;
  window.miaComposer.insertPathPastePayload(payload);
});

function handleComposerCompositionStart() {
  els.chatInput.dataset.composing = "true";
}

function handleComposerCompositionEnd() {
  window.miaMessageHelpers.noteCompositionEnded();
  els.chatInput.dataset.composing = "false";
  composerInputRefreshScheduler.schedule();
}

function handleComposerInput() {
  composerInputRefreshScheduler.schedule();
}

function handleComposerContextMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  window.miaComposer.closeComposerAddMenu();
  window.miaComposer.closeSkillPicker();
  els.chatInput.focus();
  window.mia?.showEditContextMenu?.({ x: event.clientX, y: event.clientY });
}

function handleComposerClick() {
  window.miaComposer.updateSlashCommandState();
  window.miaComposer.updateMentionMenuState();
}

function handleComposerBlur() {
  // Delay close so a click on the menu still fires before we hide it.
  setTimeout(() => window.miaComposer.closeMentionMenu(), 120);
}
els.composerAdd?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  state.composerAddMenuOpen = !state.composerAddMenuOpen;
  state.slashMenuOpen = false;
  if (state.composerAddMenuOpen) window.miaComposer.closeSkillPicker();
  window.miaComposer.renderSlashCommandMenu();
  window.miaComposer.renderComposerAddMenu();
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
function handleComposerPaste(event) {
  if (event.clipboardData?.files?.length) {
    event.preventDefault();
    window.miaComposer.addComposerFiles(event.clipboardData.files, { pathRefs: true });
    return;
  }
  window.miaComposer.handleComposerPlainTextPaste(event);
}
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

function messageLinkCopyTarget(link) {
  const external = String(link?.dataset?.externalLink || "").trim();
  if (external) return external;
  const localPath = String(link?.dataset?.localFilePath || "").trim();
  if (!localPath) return "";
  const line = String(link?.dataset?.localFileLine || "").trim();
  const column = String(link?.dataset?.localFileColumn || "").trim();
  return line ? `${localPath}:${line}${column ? `:${column}` : ""}` : localPath;
}

let attachmentContextMenuOutsideClickHandler = null;
let attachmentContextMenuEscapeHandler = null;

function attachmentLocalFilePath(attachmentEl) {
  return String(attachmentEl?.dataset?.localFilePath || "").trim();
}

function attachmentDownloadHref(attachmentEl) {
  return String(attachmentEl?.dataset?.downloadHref || attachmentEl?.getAttribute?.("href") || "").trim();
}

function attachmentCloudFileUrl(attachmentEl) {
  return String(attachmentEl?.dataset?.attachmentUrl || "").trim();
}

function attachmentDownloadName(attachmentEl) {
  return String(attachmentEl?.dataset?.downloadName || attachmentEl?.getAttribute?.("download") || "attachment").trim() || "attachment";
}

function closeAttachmentContextMenu() {
  const menu = els.messageContextMenu;
  if (!menu || menu.dataset.menuKind !== "attachment") return;
  menu.classList.add("hidden");
  menu.innerHTML = "";
  menu.dataset.menuKind = "";
  if (attachmentContextMenuOutsideClickHandler) {
    document.removeEventListener("click", attachmentContextMenuOutsideClickHandler, true);
    attachmentContextMenuOutsideClickHandler = null;
  }
  if (attachmentContextMenuEscapeHandler) {
    document.removeEventListener("keydown", attachmentContextMenuEscapeHandler);
    attachmentContextMenuEscapeHandler = null;
  }
}

async function openAttachmentFromElement(attachmentEl) {
  const localFilePath = attachmentLocalFilePath(attachmentEl);
  if (!localFilePath) return false;
  await window.mia?.openLocalFile?.(localFilePath);
  return true;
}

function rememberSavedAttachmentDownload(attachmentEl, saved) {
  if (!attachmentEl || !saved?.path) return false;
  attachmentEl.dataset.localFilePath = saved.path;
  attachmentEl.setAttribute("data-local-file-path", saved.path);
  const cloudUrl = attachmentCloudFileUrl(attachmentEl) || String(saved.url || "").trim();
  if (cloudUrl) {
    state.generatedFiles.set(cloudUrl, { status: "ready", attachment: { ...saved, url: cloudUrl } });
    pruneGeneratedFileCache(cloudUrl);
  }
  return true;
}

async function downloadAttachmentFromElement(attachmentEl) {
  const href = attachmentDownloadHref(attachmentEl);
  if (!href) return false;
  if (href.startsWith("data:") && typeof window.mia?.saveAttachment === "function") {
    try {
      const saved = await window.mia?.saveAttachment?.({
        name: attachmentDownloadName(attachmentEl),
        url: attachmentCloudFileUrl(attachmentEl),
        dataUrl: href
      });
      if (saved?.path) return rememberSavedAttachmentDownload(attachmentEl, saved);
    } catch (error) {
      appendTransientChat("assistant", `附件下载失败: ${error.message || error}`);
      return false;
    }
  }
  const link = document.createElement("a");
  link.href = href;
  link.download = attachmentDownloadName(attachmentEl);
  link.click();
  return true;
}

async function revealAttachmentInFolderFromElement(attachmentEl) {
  const localFilePath = attachmentLocalFilePath(attachmentEl);
  if (!localFilePath) return false;
  await window.mia?.revealLocalFile?.(localFilePath);
  return true;
}

function openAttachmentContextMenu(attachmentEl, x, y) {
  const menu = els.messageContextMenu;
  if (!menu || !attachmentEl) return false;
  closeAttachmentContextMenu();
  window.miaSocialMessageMenu?.closeSocialMessageMenu?.();
  window.miaMessageMenu?.closeMessageContextMenu?.();
  window.miaSkillLibrary?.closeSkillContextMenu?.();
  window.miaBotManager?.closeBotContextMenu?.();

  const actions = attachmentLocalFilePath(attachmentEl)
    ? [
        { key: "open", icon: "preview", label: "打开" },
        { key: "reveal", icon: "folderOpen", label: "打开文件夹" }
      ]
    : attachmentDownloadHref(attachmentEl)
      ? [{ key: "download", icon: "download", label: "下载" }]
      : [];
  if (!actions.length) return false;

  menu.dataset.menuKind = "attachment";
  menu.innerHTML = actions.map((action) => window.miaMarkdown.menuItemHtml({
    icon: action.icon,
    label: action.label,
    attrs: `data-attachment-menu-action="${action.key}"`
  })).join("");
  menu.classList.remove("hidden");
  window.miaLottieIcons?.init(menu);

  const rect = menu.getBoundingClientRect();
  const width = rect.width || 148;
  const height = rect.height || 132;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;

  menu.querySelectorAll("[data-attachment-menu-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.attachmentMenuAction;
      closeAttachmentContextMenu();
      if (action === "open") {
        await openAttachmentFromElement(attachmentEl);
        return;
      }
      if (action === "reveal") {
        await revealAttachmentInFolderFromElement(attachmentEl);
        return;
      }
      if (action === "download") {
        await downloadAttachmentFromElement(attachmentEl);
      }
    });
  });

  setTimeout(() => {
    attachmentContextMenuOutsideClickHandler = (event) => {
      if (menu.contains(event.target)) return;
      closeAttachmentContextMenu();
    };
    document.addEventListener("click", attachmentContextMenuOutsideClickHandler, true);
    attachmentContextMenuEscapeHandler = (event) => {
      if (event.key === "Escape") closeAttachmentContextMenu();
    };
    document.addEventListener("keydown", attachmentContextMenuEscapeHandler);
  }, 0);

  return true;
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
  if (activeRun?.status !== "running") {
    if (isCoreStartupSendBlocked()) {
      event.preventDefault();
      event.stopPropagation();
      nudgeCoreStartupStatus();
      return;
    }
    const runtimeBlock = activeBotRuntimeSendBlock();
    if (runtimeBlock) {
      event.preventDefault();
      event.stopPropagation();
      nudgeBotRuntimeSendBlock(runtimeBlock);
    }
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const stopped = await window.mia.stopChat?.({
    conversationId: window.miaSocial?.getActiveConversationId?.() || "",
    runId: activeRun?.runId || "",
    turnId: activeRun?.turnId || "",
    runtimeKind: activeBotRuntimeControlContext()?.runtimeKind || ""
  });
  if (stopped && stopped.ok !== false) {
    window.miaSocial?.markConversationRunCancelling?.(
      window.miaSocial?.getActiveConversationId?.() || "",
      activeRun?.runId || ""
    );
  }
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
  const fileCard = event.target.closest(".message-attachment.file-card");
  if (fileCard && els.chat.contains(fileCard)) {
    if (attachmentLocalFilePath(fileCard) || attachmentDownloadHref(fileCard)) {
      event.preventDefault();
      event.stopPropagation();
      if (openAttachmentContextMenu(fileCard, event.clientX, event.clientY)) return;
    }
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
    window.miaTraceBlocks?.hydrateTraceRow?.(row);
    const article = row.closest?.("article[data-message-id]");
    if (article?.dataset?.messageId) {
      Promise.resolve(window.miaSocial?.hydrateCompactConversationMessage?.(article.dataset.messageId)).catch(() => {});
    }
  } else {
    window.miaTraceBlocks?.releaseTraceRow?.(row);
    state.openTraceKeys.delete(key);
    state.openTraceKeys.add(`!${key}`);
    delete row.dataset.userOpen;
    delete row.dataset.autoOpen;
  }
}, true);

els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (window.miaMessageHelpers.isComposerComposing()) return;
  if (isCoreStartupSendBlocked()) {
    nudgeCoreStartupStatus();
    return;
  }
  const runtimeBlock = activeBotRuntimeSendBlock();
  if (runtimeBlock) {
    nudgeBotRuntimeSendBlock(runtimeBlock);
    return;
  }
  // Branch: a cloud conversation (dm / group / bot) is active → send via social.
  if (window.miaSocial?.getActiveConversationId?.()) {
    if (isActiveConversationBusy()) {
      renderSendButton();
      return;
    }
    const conversationId = window.miaSocial.getActiveConversationId();
    const composerText = els.chatInput.value;
    const pendingAttachments = [...state.pendingAttachments].slice(0, 20);
    const attachmentsForSend = window.miaComposer.attachmentsForSend(pendingAttachments);
    let conversationText = window.miaComposer.expandComposerPathRefsForSend(composerText, pendingAttachments);
    const skillCommand = window.miaComposer.consumeLeadingSkillCommand(conversationText);
    if (skillCommand.matched) {
      conversationText = skillCommand.text;
      els.chatInput.value = skillCommand.text;
      window.miaMessageHelpers.resizeChatInput();
      renderSendButton();
    }
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
      botRuntimeControl: activeBotRuntimeSendConfig(),
      attachments: attachmentsForSend
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
  state.agentSetupInstallMessage = repair ? "正在切换稳定版..." : retry ? "正在重试启用..." : "正在启用稳定版...";
  state.agentSetupInstallStage = "";
  state.agentSetupInstallPercent = 0;
  state.agentSetupInstallErrors = state.agentSetupInstallErrors || {};
  delete state.agentSetupInstallErrors[engineId];
  button.disabled = true;
  document.querySelectorAll('[data-setup-action="finish-agent-scan"], [data-onb-action="finish"], [data-setup-action^="install-"], [data-setup-action="retry-install-hermes"], [data-setup-action="repair-hermes"]').forEach((el) => {
    el.disabled = true;
  });
  const original = button.textContent;
  button.textContent = repair ? "切换中..." : retry ? "重试中..." : "启用中...";
  try {
    if (engineId === "hermes") state.hermesInstallError = "";
    state.runtime = repair ? await window.mia.repairEngine() : await window.mia.installEngine(engineId);
    delete state.agentSetupInstallErrors[engineId];
    await window.miaLoaders.loadModelCatalog();
    state.agentSetupSkipped = false;
    try { localStorage.removeItem(AGENT_SETUP_SKIPPED_KEY); } catch { /* ignore */ }
    await refreshRuntime();
  } catch (error) {
    const verb = "启用";
    const label = engineId === "hermes" ? "Mia 稳定版 Hermes" : `Mia 稳定版 ${engineId}`;
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
    const hydrateLottie = () => window.miaLottieIcons?.loadPlayer?.()
      .then(() => window.miaLottieIcons?.init?.(document))
      .catch((error) => console.warn("[Mia startup] deferred Lottie load failed", error));
    if (blockStartup) {
      hydrateLottie();
    } else if (typeof window.miaIdleScheduler?.schedule === "function") {
      window.miaIdleScheduler.schedule(hydrateLottie, { delayMs: 3_500, timeoutMs: 5_000 });
    } else {
      setTimeout(hydrateLottie, 3_500);
    }
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
      renderChatHtml(`
        <article class="setup-guide bootstrap">
          <div class="setup-guide-main">
            <strong>Mia 初始化失败</strong>
            <p>${window.miaMarkdown.escapeHtml(message)}</p>
          </div>
        </article>
      `);
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
if (window.miaRuntimeRefreshScheduler?.createRuntimeRefreshScheduler) {
  runtimeRefreshScheduler = window.miaRuntimeRefreshScheduler.createRuntimeRefreshScheduler({
    // Live chat/task changes arrive over Core's event stream. Runtime status
    // is a fallback/control-plane refresh, so avoid rebuilding the whole shell
    // every five seconds while the window is sitting visibly idle.
    intervalMs: RUNTIME_FALLBACK_REFRESH_MS,
    refresh: performRefreshRuntime,
    isActive: () => desktopWindowFocused && !document.hidden,
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id),
    onError: (error) => console.error("Failed to refresh runtime", error)
  });
  runtimeRefreshScheduler.start();
} else {
  runtimeFallbackRefreshTimer = window.setInterval(refreshRuntime, RUNTIME_FALLBACK_REFRESH_MS);
}
rendererLifecycleSubscribed = Boolean(
  rendererViewLifecycle?.subscribe?.(syncRendererViewLifecycle, { immediate: false })
);
rendererPerformance.start({
  input: els.chatInput,
  getGauges: () => {
    const socialStats = window.miaSocial?.getPerformanceStats?.() || {};
    return {
      activeView: state.activeView,
      ...Object.fromEntries(Object.entries(socialStats).map(([key, value]) => [`social.${key}`, value]))
    };
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    const task = runtimeRefreshScheduler?.runNow?.({ queueIfRunning: true });
    task?.catch?.(() => {});
  }
});
window.addEventListener("pagehide", () => {
  conversationRenderScheduler?.cancel?.();
  runtimeRefreshScheduler?.stop?.();
  if (runtimeFallbackRefreshTimer) window.clearInterval(runtimeFallbackRefreshTimer);
  runtimeFallbackRefreshTimer = 0;
  rendererPerformance.stop();
  window.miaSocial?.setLifecycleState?.({ active: false, visible: false });
  window.miaLottieIcons?.destroy?.();
  rendererViewLifecycle?.destroy?.();
  rendererLifecycleSubscribed = false;
  clearCloudMobileScanTimers();
  window.miaReactRenderer?.destroy?.();
}, { once: true });

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
    syncRendererViewLifecycle({
      ...(rendererViewLifecycle?.snapshot?.("focus") || {
        activeView: state.activeView,
        documentVisible: !document.hidden
      }),
      reason: "focus"
    });
    if (desktopWindowFocused) {
      const task = runtimeRefreshScheduler?.runNow?.({ queueIfRunning: true });
      task?.catch?.(() => {});
    }
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
