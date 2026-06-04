const fallbackSlashCommands = window.miaAppState.fallbackSlashCommands;
const SETUP_GUIDE_DISMISSED_KEY = window.miaAppState.SETUP_GUIDE_DISMISSED_KEY;
const AGENT_SETUP_SKIPPED_KEY = window.miaAppState.AGENT_SETUP_SKIPPED_KEY;
const { ConversationKind, MemberKind, SenderKind } = (typeof window !== "undefined" && window.miaConversationKinds) || require("../shared/conversation-kinds");
const { prepareOutgoingMessage } = (typeof window !== "undefined" && window.miaSendPipeline) || require("../shared/send-pipeline");
const sessionHistory = (typeof window !== "undefined" && window.miaSessionHistory) || require("../shared/session-history");
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 380;
const SIDEBAR_WIDTH_DEFAULT = 280;
let skillPickerHoverCloseTimer = 0;
let avatarTrimDrag = null;
const fellowRuntimeControlCache = new Map();
const platformModelCatalog = { loaded: false, loading: false, entries: [] };
const ICON_PARK_PIN_SVG = '<svg class="icon-park-pin" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="M10.6963 17.5042C13.3347 14.8657 16.4701 14.9387 19.8781 16.8076L32.62 9.74509L31.8989 4.78683L43.2126 16.1005L38.2656 15.3907L31.1918 28.1214C32.9752 31.7589 33.1337 34.6647 30.4953 37.3032C30.4953 37.3032 26.235 33.0429 22.7171 29.525L6.44305 41.5564L18.4382 25.2461C14.9202 21.7281 10.6963 17.5042 10.6963 17.5042Z"/></svg>';

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
const agentSetupLaunch = new URLSearchParams(window.location.search || "").get("mode") === "agent-setup";
if (agentSetupLaunch && !state.onboardingStep && !state.setupGuideDismissed && !state.agentSetupSkipped) {
  state.onboardingStep = "engine";
}
if (window.miaSetupGuide && window.miaSetupGuide.initSetupGuide) {
  window.miaSetupGuide.initSetupGuide({ state, escapeHtml: window.miaMarkdown.escapeHtml });
}

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
  startEngine: document.getElementById("startEngine"),
  stopEngine: document.getElementById("stopEngine"),
  engineRowHermes: document.getElementById("engineRowHermes"),
  engineRowClaude: document.getElementById("engineRowClaude"),
  engineRowCodex: document.getElementById("engineRowCodex"),
  engineRowOpenClaw: document.getElementById("engineRowOpenClaw"),
  engineRowHermesButton: document.querySelector('[data-engine-row="hermes"]'),
  personaSearch: document.getElementById("personaSearch"),
  personaCount: document.getElementById("personaCount"),
  fellowCreateMenu: document.getElementById("fellowCreateMenu"),
  addFellow: document.getElementById("addFellow"),
  convMenuAddFriend: document.getElementById("convMenuAddFriend"),
  convMenuNewGroup: document.getElementById("convMenuNewGroup"),
  fellowDialog: document.getElementById("fellowDialog"),
  fellowForm: document.getElementById("fellowForm"),
  fellowDialogTitle: document.getElementById("fellowDialogTitle"),
  fellowKey: document.getElementById("fellowKey"),
  fellowName: document.getElementById("fellowName"),
  fellowRuntimeLocationField: document.getElementById("fellowRuntimeLocationField"),
  fellowRuntimeLocation: document.getElementById("fellowRuntimeLocation"),
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
  contactCreateMenu: document.getElementById("contactCreateMenu"),
  contactMenuAddFriend: document.getElementById("contactMenuAddFriend"),
  contactMenuAddFellow: document.getElementById("contactMenuAddFellow"),
  contactMenuNewGroup: document.getElementById("contactMenuNewGroup"),
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
  cloudAccountHint: document.getElementById("cloudAccountHint"),
  cloudLoginBox: document.getElementById("cloudLoginBox"),
  cloudUsername: document.getElementById("cloudUsername"),
  cloudPassword: document.getElementById("cloudPassword"),
  cloudLogin: document.getElementById("cloudLogin"),
  cloudRegister: document.getElementById("cloudRegister"),
  cloudSync: document.getElementById("cloudSync"),
  cloudLogout: document.getElementById("cloudLogout"),
  cloudLoginHint: document.getElementById("cloudLoginHint"),
  tasksUnreadBadge: document.getElementById("tasksUnreadBadge"),
  contactsUnreadBadge: document.getElementById("contactsUnreadBadge"),
  chatUnreadBadge: document.getElementById("chatUnreadBadge"),
  tasksView: document.getElementById("tasksView"),
  tasksContent: document.getElementById("tasksContent")
};

function setText(el, value) {
  if (el) el.textContent = value;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
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
    avatarColor: self.avatarColor || "#111827",
    avatarImage: self.avatarImage,
    avatarCrop: self.avatarCrop
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

function isActiveRunRunning() {
  return window.miaSocial?.activeConversationRun?.()?.status === "running";
}
window.miaIsActiveRunRunning = isActiveRunRunning;

function typingDotsHtml(label) {
  const prefix = label ? `${label} ` : "";
  const escape = window.miaMarkdown?.escapeHtml || ((s) => String(s ?? ""));
  return `<span class="typing-status">${escape(prefix)}正在输入<span class="typing-dots"><i></i><i></i><i></i></span></span>`;
}

function typingLabelForActiveRun(social, conversation) {
  const run = social?.activeConversationRun?.();
  const fellowId = run?.fellowId || "";
  if (!fellowId) return "";
  // Only group conversations need to identify the speaker — DM / fellow chats
  // already have the fellow's name in the header itself.
  if (conversation?.type !== "group") return "";
  const personas = allOwnedFellowsForIdentity(state.runtime?.fellows || state.runtime?.personas || []);
  const owned = personas.find((p) => (p.key || p.id) === fellowId);
  if (owned?.name) return owned.name;
  const members = social?.getConversationMembers?.(conversation.id) || [];
  const member = members.find((m) => m.member_kind === MemberKind.Fellow && m.member_ref === fellowId);
  return member?.fellow_name || fellowId;
}

function allOwnedFellowsForIdentity(personas = []) {
  const runtime = state.runtime || {};
  if (window.miaFellowManager?.allOwnedFellows) {
    return window.miaFellowManager.allOwnedFellows();
  }
  const cloudFellows = window.miaSocial?.moduleState?.fellows || [];
  const localFellows = [
    ...((Array.isArray(personas) && personas.length) ? personas : []),
    ...(Array.isArray(runtime.fellows) ? runtime.fellows : []),
    ...(Array.isArray(runtime.personas) ? runtime.personas : [])
  ];
  if (window.miaFellowDirectory?.listOwnedFellows) {
    return window.miaFellowDirectory.listOwnedFellows({ cloudFellows, localFellows, runtime });
  }
  return [...cloudFellows, ...localFellows];
}

function fellowAvatarIdentityId(fellowKey, fellow = {}) {
  const ownerUserId = fellow?.ownerUserId || fellow?.owner_user_id || fellow?.ownerId || fellow?.owner_id || "";
  return window.miaContact?.fellowAvatarIdentityId?.(fellowKey, fellow)
    || fellow?.globalId
    || fellow?.global_id
    || fellow?.fellowGlobalId
    || fellow?.fellow_global_id
    || (ownerUserId && fellowKey ? sessionHistory.fellowConversationId(ownerUserId, fellowKey) : "")
    || fellowKey;
}

function fellowGlobalIdFromConversation(conversation, fellowKey) {
  const id = String(conversation?.id || "");
  const key = String(fellowKey || "");
  if (!id.startsWith("fellow:") || !key) return "";
  return id.split(":").slice(2).join(":") === key ? id : "";
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
  const personas = state.runtime?.fellows || state.runtime?.personas || [];
  paintActiveCloudConversationHeader(conversation, { personas, social });
}

function renderSendButton() {
  if (!els.sendChat) return;
  const hasContent = Boolean(String(els.chatInput?.value || "").trim()) || state.pendingAttachments.length > 0;
  const cloudSignedIn = Boolean(state.runtime?.cloud?.enabled);
  const hasActiveCloudConversation = Boolean(window.miaSocial?.getActiveConversationId?.());
  const canSend = hasContent && (!cloudSignedIn || hasActiveCloudConversation);
  const generating = isActiveRunRunning();
  els.sendChat.classList.toggle("stop", generating);
  els.sendChat.title = generating ? "停止生成" : "发送";
  els.sendChat.setAttribute("aria-label", generating ? "停止生成" : "发送");
  els.sendChat.disabled = !generating && !canSend;
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
  pingfang: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  serif: 'ui-serif, "Iowan Old Style", "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif'
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

// Resolve a cloud-conversation member record into an avatar tile. The kinds
// recognized here ("user" / "fellow") mirror cloud-conversation-source.js's
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
    fellows: allOwnedFellowsForIdentity(personas || [])
    // shared/avatar-resolve.js owns the "no avatarImage → text fallback"
    // behavior now, so consumers don't need any local fallback table.
  };
}

// Normalize any sidebar row kind into a unified ConversationCard spec the
// sidebar-card-renderer can paint. Fellow private + cloud DM both become
// {kind:"private"} with one member; local fellow group + cloud conversation both
// become {kind:"group"} with stacked tiles. Single render path; "real
// human friend" is just another member kind, not a different conversation
// species.
function conversationCardSpecFromRow(row, personas) {
  if (!row) return null;
  const social = window.miaSocial;
  const identityFellows = allOwnedFellowsForIdentity(personas || []);

  // ── cloud private conversation (DM with a friend OR fellow session) ─────────────
  //     Same card shape; the only branch is "who's the other party" — a
  //     friend (dm conversation) or a fellow (fellow conversation) — and that flows
  //     through one resolver into a single spec.
  if (row.type === "private-conversation") {
    const conversation = row.conversation;
    const activeConversationId = social?.getActiveConversationId?.();
    const isFellow = conversation.type === "fellow";
    let name, avatar;
    if (isFellow) {
      const fellowKey = sessionHistory.fellowKey(conversation);
      const fellow = identityFellows.find((p) => (p.id || p.key) === fellowKey);
      const fellowRecord = fellow || {
        key: fellowKey,
        id: fellowKey,
        name: conversation.name || fellowKey,
        globalId: fellowGlobalIdFromConversation(conversation, fellowKey)
      };
      name = sessionHistory.fellowDisplayTitle(conversation, identityFellows, "对话");
      const resolved = window.miaContact?.resolveContact?.(
        { kind: window.miaContact.ContactKind.Fellow, ref: fellowKey },
        { fellows: fellow ? identityFellows : [fellowRecord] }
      );
      avatar = resolved?.avatar || window.miaAvatarResolve.resolveAvatarForContact({
        id: fellowAvatarIdentityId(fellowKey, fellowRecord),
        displayName: name || fellowRecord.name || fellowKey,
        avatarImage: fellowRecord.avatarImage || "",
        avatarCrop: fellowRecord.avatarCrop || null
      });
    } else {
      const other = conversation.otherUser || {};
      name = other.username || other.account || "好友";
      avatar = window.miaAvatarResolve.resolveAvatarForContact({
        id: other.id || other.account || name,
        displayName: name,
        avatarImage: other.avatarImage || "",
        avatarCrop: other.avatarCrop || null
      });
    }
    const pinned = Boolean(social?.isConversationPinned?.(conversation.id));
    const muted = Boolean(social?.isConversationMuted?.(conversation.id));
    const unread = social?.getUnreadForConversation?.(conversation.id) || 0;
    return {
      kind: "private",
      active: conversation.id === activeConversationId,
      pinned,
      muted,
      name,
      typeLabel: "私聊",
      preview: conversation.lastMessagePreview || "暂无对话",
      time: formatConversationTime(row.updatedAt),
      unread,
      avatar,
      onClick: () => {
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
          remove: async () => {
            if (!confirm(`确定删除与「${name}」的对话？此操作不可撤销。`)) return;
            const res = await social.deleteCloudConversation(conversation.id);
            if (!res?.ok) alert(`删除失败：${res?.error || "未知错误"}`);
          },
          // DM display name follows the peer's username, so server rejects
          // PATCH name on dm:* conversations — surface that to the menu.
          ...(isFellow ? {} : { notSupported: { rename: "私聊对方名称由对方用户名决定，无法在此重命名" } })
        },
        x, y
      )
    };
  }

  // ── cloud group (friends + fellows mixed) — same shape as local group ────
  if (row.type === "group-conversation") {
    const conversation = row.conversation;
    const activeConversationId = social?.getActiveConversationId?.();
    const memberRecords = social?.getConversationMembers?.(conversation.id) || [];
    const tiles = window.miaGroupTiles.resolveGroupMemberTiles(memberRecords, groupTilesCtx(personas));
    const memberCount = memberRecords.length || conversation.memberCount || 0;
    const cgPinned = Boolean(social?.isConversationPinned?.(conversation.id));
    const cgMuted = Boolean(social?.isConversationMuted?.(conversation.id));
    const cgUnread = social?.getUnreadForConversation?.(conversation.id) || 0;
    const cgName = conversation.name || "群聊";
    return {
      kind: "group",
      active: conversation.id === activeConversationId,
      pinned: cgPinned,
      muted: cgMuted,
      name: cgName,
      typeLabel: memberCount ? `群聊 · ${memberCount}人` : "群聊",
      preview: conversation.lastMessagePreview || "暂无消息",
      time: formatConversationTime(row.updatedAt),
      unread: cgUnread,
      members: tiles,
      customAvatar: conversation.decorations?.avatar || null,
      onClick: () => {
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
          openInfo: () => window.miaGroupInfoDialog?.open(conversation.id),
          rename: async () => {
            const next = window.prompt("编辑群组名称", cgName);
            if (!next || next.trim() === cgName) return;
            const res = await social.renameConversation(conversation.id, next.trim());
            if (!res?.ok) alert(`重命名失败：${res?.error || "未知错误"}`);
          },
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

// Paint #activeChatAvatar / #activeChatName / #activeChatMeta for the
// currently-active cloud conversation (type ∈ {dm, group, fellow}). Mirrors the
// local-group branch — both paths route through miaGroupAvatar for
// any conversation that has more than one member, so the sidebar and the
// chat header always agree.
function paintActiveCloudConversationHeader(conversation, { personas, social }) {
  const avatarEl = els.activeChatAvatar;
  const nameEl = els.activeChatName;
  const metaEl = els.activeChatMeta;
  const avatarHelper = window.miaAvatar;
  const groupAvatarHelper = window.miaGroupAvatar;
  const identityFellows = allOwnedFellowsForIdentity(personas || []);
  // id-prefix fallback for pre-v7 cloud deployments that don't yet return
  // conversation.type. social.renderSidebarRows already normalizes this; mirror it
  // here so a conversation loaded outside the sidebar pipeline (active conversation loaded
  // from cache, etc.) still routes correctly.
  const conversationType = conversation.type
    || (conversation.id?.startsWith("dm:") ? "dm"
      : conversation.id?.startsWith("fellow:") ? "fellow"
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
    setText(nameEl, conversation.name || "群聊");
    if (metaEl) metaEl.textContent = tiles.length ? `群聊 · ${tiles.length} 人` : "群聊";
    return;
  }

  if (conversationType === "fellow") {
    const fellowKey = sessionHistory.fellowKey(conversation);
    const fellow = identityFellows.find((p) => (p.id || p.key) === fellowKey);
    const fellowRecord = fellow || {
      key: fellowKey,
      id: fellowKey,
      name: conversation.name,
      globalId: fellowGlobalIdFromConversation(conversation, fellowKey)
    };
    if (avatarEl) {
      avatarEl.removeAttribute("data-count");
      avatarEl.className = "profile-avatar";
      avatarHelper.applyFellowAvatar(avatarEl, fellowRecord);
    }
    setText(nameEl, sessionHistory.fellowDisplayTitle(conversation, identityFellows, "对话"));
    if (metaEl) metaEl.textContent = "私聊";
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
    avatarCrop: otherUser.avatarCrop || null
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
  setText(nameEl, displayName);
  if (metaEl) metaEl.textContent = "私聊";
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
  if (!src || !src.startsWith("data:image/")) return `<span>${window.miaMarkdown.escapeHtml(window.miaFormat.attachmentGlyph(attachment))}</span>`;
  return `<img class="${window.miaMarkdown.escapeHtml(className)}" src="${window.miaMarkdown.escapeHtml(src)}" alt="">`;
}

function renderAttachmentChip(attachment = {}) {
  const image = (attachment.kind || window.miaFormat.attachmentKind(attachment)) === "image" && (attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || attachment.dataUrl || attachment.url);
  const href = String(attachment.dataUrl || "").startsWith("data:") ? String(attachment.dataUrl) : "";
  const tag = href ? "a" : "span";
  const download = href ? ` href="${window.miaMarkdown.escapeHtml(href)}" download="${window.miaMarkdown.escapeHtml(attachment.name || "attachment")}"` : "";
  if (image) {
    return `
      <button class="message-attachment image" type="button" title="${window.miaMarkdown.escapeHtml(attachment.path || attachment.name || "")}" aria-label="预览图片">
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
    <img src="${window.miaMarkdown.escapeHtml(imageSrc)}" alt="${window.miaMarkdown.escapeHtml(title || "图片预览")}">
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
  const kind = String(attachment.kind || window.miaFormat.attachmentKind(attachment));
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
      return String(attachment.kind || window.miaFormat.attachmentKind(attachment)) === "image";
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


async function trackStartupTask(label, task) {
  const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const start = performance.now();
  state.startupTasks.push({ id, label });
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


function render() {
  const runtime = state.runtime;
  if (!runtime) {
    if (window.miaSetupGuide?.shouldShowSetupGuide?.({ messages: [] })) {
      document.body.classList.toggle("onboarding-window", true);
      els.chat.innerHTML = window.miaSetupGuide.renderSetupGuide();
      window.miaLottieIcons?.init?.(els.chat);
      return;
    }
    document.body.classList.toggle("onboarding-window", false);
    if (els.chat) els.chat.innerHTML = "";
    return;
  }
  const cloudSignedIn = Boolean(runtime?.cloud?.enabled);
  els.appShell?.setAttribute("data-auth-state", cloudSignedIn ? "signed-in" : "signed-out");
  renderSendButton();
  window.miaMessageHelpers.renderComposerReply();
  // Re-evaluate composer skill chips every render so switching conversations drops
  // chips that belonged to the previous conversation (self-heal in composer).
  window.miaComposer?.renderComposerSkills?.();
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
  window.miaSettingsAppearance.applyAppearance(appearance);
  if (!editingAppearance) {
    els.appearanceTheme.value = appearance.theme || "light";
    const savedFontPreset = appearance.fontPreset || "system";
    els.appearanceFontPreset.value = fontPresets[savedFontPreset] ? savedFontPreset : "system";
    if (els.appearanceListStyle) els.appearanceListStyle.value = window.miaSettingsAppearance.normalizeListStyle(appearance.listStyle);
    if (els.appearanceSelectionStyle) els.appearanceSelectionStyle.value = window.miaSettingsAppearance.normalizeSelectionStyle(appearance.selectionStyle);
    window.miaSettingsAppearance.syncAppearanceControls(appearance);
  }
  const user = runtimeUserIdentity(runtime);
  window.miaAvatar.applyUserAvatar(els.userAvatar, user);
  setText(els.userDisplayName, user.displayName || "");
  if (!editingProfile && els.profileForm) {
    els.profileDisplayName.value = user.displayName || "";
    window.miaFellowDialog.setProfileAvatarDraft(user.avatarImage || "", user.avatarCrop);
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
    const currentModelId = engine === "claude-code" || engine === "codex"
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
        ? `当前模型：${window.miaModelHelpers.modelDisplayName(runtime.model)}`
        : "未配置模型";
  }
  const activeIcon = engine === "claude-code"
    ? window.miaModelHelpers.modelIconSrc({ provider: "anthropic", model: "claude" })
    : engine === "codex"
      ? window.miaModelHelpers.modelIconSrc({ provider: "openai-codex", model: "codex" })
      : connectedEntries.length
        ? window.miaModelHelpers.modelIconSrc(runtime.model || {})
        : "";
  const modelAvatar = document.querySelector(".model-avatar");
  if (modelAvatar) {
    modelAvatar.textContent = activeIcon ? "" : "◇";
    modelAvatar.style.backgroundImage = activeIcon ? `url("${activeIcon}")` : "";
  }
  window.miaModelSettings.syncPermissionControl(runtime);
  syncConversationFellowRuntimeControls();

  const personas = runtime.fellows || runtime.personas || [];
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
  const syncedFellowKeys = new Set((social?.moduleState?.fellows || [])
    .map((fellow) => String(fellow?.key || fellow?.id || "").trim())
    .filter(Boolean));
  const contactKeys = new Set([
    ...personas.map((persona) => String(persona.key || persona.id || "")),
    ...syncedFellowKeys
  ].filter(Boolean));
  // The pinned "新的好友" entry uses a sentinel key that is intentionally not a
  // contact — leave it alone here, fellow-manager.renderContacts() owns its fallback.
  if (state.activeContactKey !== window.miaFellowManager?.FRIEND_REQUESTS_KEY
    && !contactKeys.has(state.activeContactKey) && contactKeys.size) {
    state.activeContactKey = personas.find((persona) => persona.key === state.activeKey)?.key
      || personas[0]?.key
      || [...syncedFellowKeys][0]
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
    const showPrivateAiControls = activeCloudConversationType === "fellow";
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
    window.miaAvatar.applyFellowAvatar(els.activeChatAvatar, active);
    setText(els.activeChatName, active.name || "Mia");
    if (els.activeChatMeta) {
      const startupLoading = state.startupTasks[0]?.label;
      els.activeChatMeta.innerHTML = startupLoading
        ? `正在${window.miaMarkdown.escapeHtml(startupLoading)}`
        : "在线";
    }
    if (groupInfoBtn) groupInfoBtn.classList.add("hidden");
    if (els.sessionMenuButton) els.sessionMenuButton.classList.remove("hidden");
    if (composerBottom) composerBottom.classList.remove("hidden");
  }
  // Cloud-only: the sidebar lists cloud conversations exclusively. Local fellow
  // personas are no longer a conversation source — a fellow surfaces as its
  // cloud fellow conversation once bootstrap completes.
  const cloudReady = !cloudSignedIn || !social || social.isBootstrapped?.();
  const socialRows = cloudReady ? (social?.renderSidebarRows?.() || []) : [];
  const messageRows = !cloudReady ? [] : window.miaFellowManager.sortMessageCardsForSidebar(socialRows);

  els.personaList.innerHTML = "";
  for (const row of messageRows) {
    const spec = conversationCardSpecFromRow(row, personas);
    if (!spec) continue;
    const card = spec.kind === ConversationKind.CloudGroup
      ? window.miaSidebarCards.createGroupCard(spec)
      : window.miaSidebarCards.createPrivateCard(spec);
    els.personaList.appendChild(card);
  }

  if (!messageRows.length) {
    const empty = document.createElement("div");
    empty.className = "persona-empty";
    if (!cloudSignedIn) {
      empty.innerHTML = `<span>登录后开始对话</span><button type="button" class="link" data-action="cloud-login">登录</button>`;
    } else {
      empty.textContent = cloudReady ? "没有匹配的消息" : "正在同步会话…";
    }
    els.personaList.appendChild(empty);
  }
  renderView();
  renderSessionMenu();
  if (!window.miaMessageMenu?.hasActiveMessageTextSelection()) renderChat();
}

function renderView() {
  if (state.activeSettingsTab === "profile") state.activeSettingsTab = "appearance";
  if (state.activeSettingsTab === "runtime") state.activeSettingsTab = "model";
  if (state.activeSettingsTab === "mobile") state.activeSettingsTab = "account";
  if (!document.querySelector(`[data-settings-tab="${state.activeSettingsTab}"]`)) {
    state.activeSettingsTab = "account";
  }
  const cloudSignedIn = Boolean(state.runtime?.cloud?.enabled);
  els.appShell?.setAttribute("data-auth-state", cloudSignedIn ? "signed-in" : "signed-out");
  if (!cloudSignedIn) {
    state.activeView = "chat";
    state.fellowMenuOpen = false;
    state.contactMenuOpen = false;
  }
  syncNarrowLayout();
  els.conversationSidebar?.classList.toggle("hidden", state.activeView !== "chat");
  els.contactsSidebar?.classList.toggle("hidden", state.activeView !== "contacts");
  els.chatView.classList.toggle("hidden", state.activeView !== "chat");
  els.contactsView?.classList.toggle("hidden", state.activeView !== "contacts");
  els.skillsView?.classList.toggle("hidden", state.activeView !== "skills");
  els.tasksView?.classList.toggle("hidden", state.activeView !== "tasks");
  els.appShell?.setAttribute("data-active-view", state.activeView);
  els.settingsView.classList.toggle("hidden", !state.settingsOpen);
  els.profileDialog?.classList.toggle("hidden", !state.profileDialogOpen);
  els.fellowCreateMenu?.classList.toggle("hidden", !state.fellowMenuOpen);
  els.contactCreateMenu?.classList.toggle("hidden", !state.contactMenuOpen);
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
  els.fellowDialog?.classList.toggle("hidden", !state.fellowDialogOpen);
  els.petGenerateDialog?.classList.toggle("hidden", !state.petGenerateOpen);
  els.avatarCropDialog?.classList.toggle("hidden", !state.avatarCropEditor.open);
  window.miaSkillLibrary.renderSkillPreview();
  window.miaFellowManager.renderFellowContextMenu();
  window.miaPetDialog?.renderPetGenerateDialog();
  window.miaPetDialog?.renderPetJobs();
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.activeView);
  });
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsTab === state.activeSettingsTab);
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.settingsPanel !== state.activeSettingsTab);
  });
  window.miaSkillLibrary.renderSkillLibrary();
  window.miaFellowManager.renderContacts();
  window.miaTasksPanel?.renderTaskView();
}


function syncTopbarClickCapture() {
  document.body.classList.toggle("topbar-click-capture", Boolean(state.skillContextMenu.open || state.sessionMenuOpen));
}

function formatRunTime(ms) {
  if (ms == null) return "—";
  const d = new Date(ms);
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}


async function openEditFellowDialog(fellowKey) {
  try {
    const ownedFellow = window.miaFellowManager?.fellowByKey?.(fellowKey);
    if (ownedFellow?.runtimeKind === "cloud-hermes") {
      window.miaFellowDialog.openFellowDialog(ownedFellow, ownedFellow.personaText || ownedFellow.bio || "");
      return;
    }
    const details = await window.mia.loadFellowDetails(fellowKey);
    window.miaFellowDialog.openFellowDialog(details.fellow, details.personaText || "");
  } catch (error) {
    appendTransientChat("assistant", `编辑 Fellow 失败: ${error.message}`);
  }
}

async function setFellowPinned(fellowKey, pinned) {
  try {
    state.runtime = await window.mia.setFellowPinned({ key: fellowKey, pinned });
    render();
  } catch (error) {
    appendTransientChat("assistant", `置顶失败: ${error.message}`);
    await refreshRuntime();
  }
}

async function setFellowMuted(fellowKey, muted) {
  try {
    state.runtime = await window.mia.setFellowMuted({ key: fellowKey, muted });
    render();
  } catch (error) {
    appendTransientChat("assistant", `免打扰设置失败: ${error.message}`);
    await refreshRuntime();
  }
}

async function deleteFellow(fellowKey) {
  const fellow = window.miaFellowManager.fellowByKey(fellowKey);
  if (!fellow) return;
  if (fellow.canDelete === false) return;
  const detail = "这会删除该 Fellow，并清理当前账号可管理的配置和会话。";
  const ok = window.confirm(`删除「${fellow.name || fellow.key}」？\n\n${detail}`);
  if (!ok) return;
  try {
    const result = await window.miaFellowCommands.deleteFellow({
      state,
      fellow,
      api: window.mia,
      social: window.miaSocial,
    });
    if (result.runtime) state.runtime = result.runtime;
    if (!result.deleted) return;
    const fellows = window.miaFellowManager?.allOwnedFellows?.() || state.runtime?.fellows || state.runtime?.personas || [];
    const next = fellows[0]?.key || "mia";
    if (!fellows.some((item) => item.key === state.activeKey)) state.activeKey = next;
    if (!fellows.some((item) => item.key === state.activeContactKey)) state.activeContactKey = state.activeKey;
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
      state.skillPreviewOpen = false;
    }
  } catch (error) {
    console.error("Failed to delete skill", error);
    window.alert(error.message || "删除 Skill 失败");
  }
  window.miaSkillLibrary.renderSkillLibrary();
  window.miaSkillLibrary.renderSkillPreview();
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
    role: message.sender_kind === SenderKind.Fellow
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

function detectedAgentLine(agent) {
  if (!agent) return "未检测到";
  if (agent.usableInMia) {
    const parts = [agent.path || "已接入 Mia", shortAgentVersion(agent)].filter(Boolean);
    return parts.join(" · ");
  }
  if (agent.installed && agent.detectionOnly) return "已检测到 · 暂未接入 Mia 聊天";
  if (agent.installed) return "已检测到 · 当前不可直接用于 Mia";
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
  if (hermes) return detectedAgentLine(hermes);
  const legacySource = String(runtime?.engineSource || "");
  const legacyUsable = Boolean(
    runtime?.engineInstalled
    || ["bundled", "managed", "local-source", "maintained-local-source", "system"].includes(legacySource)
  );
  return legacyUsable ? "已接入 Mia" : "未检测到";
}

function renderEngineDetection(runtime) {
  const engines = runtime?.agentEngines || {};
  const inventory = agentInventoryById(runtime);

  if (els.engineRowHermes) {
    els.engineRowHermes.textContent = hermesDetectionLine(runtime, inventory.hermes);
  }

  if (els.engineRowClaude) {
    els.engineRowClaude.textContent = detectedAgentLine(
      inventory["claude-code"] || legacyAgentStatus("claude-code", engines.claudeCode)
    );
  }

  if (els.engineRowCodex) {
    els.engineRowCodex.textContent = detectedAgentLine(inventory.codex || legacyAgentStatus("codex", engines.codex));
  }

  if (els.engineRowOpenClaw) {
    els.engineRowOpenClaw.textContent = detectedAgentLine(
      inventory.openclaw || legacyAgentStatus("openclaw", engines.openClaw)
    );
  }
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
    fellows: window.miaFellowManager?.allOwnedFellows?.() || [],
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
  window.miaSocial?.upsertFellowConversation?.(response.data?.conversation || response.conversation || { ...conversation, name: title.trim() });
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
  if (els.currentSessionTitle.textContent === next) return;
  els.currentSessionTitle.textContent = next;
  els.currentSessionTitle.classList.remove("title-updated");
  requestAnimationFrame(() => els.currentSessionTitle.classList.add("title-updated"));
}

// Once the fellow has actually replied, summarize the opening exchange into a
// title (reusing the same engine title generator the old local path used) and
// rename the conversation. Stable fellow conversations may initially be named
// after the fellow itself, so treat that the same as "新对话".
async function maybeGenerateCloudConversationTitle(conversationId) {
  const social = window.miaSocial;
  if (!conversationId || !social) return;
  const conversation = social.getConversationById?.(conversationId);
  if (!conversation || conversationTypeForComposer(conversation, conversationId) !== "fellow") return;
  if (!sessionHistory.isUntitledFellowConversation(conversation, {
    fellows: window.miaFellowManager?.allOwnedFellows?.() || [],
    defaultTitle: "新对话"
  })) return;
  if (state.generatingTitleIds.has(conversationId)) return;
  const cache = social.moduleState?.messageCache?.get(conversationId);
  const msgs = (cache?.messages || []).filter((message) => message.body_md && !message._localPending);
  const hasUser = msgs.some((message) => message.sender_kind === SenderKind.User);
  const hasFellow = msgs.some((message) => message.sender_kind === SenderKind.Fellow);
  if (!hasUser || !hasFellow) return;
  state.generatingTitleIds.add(conversationId);
  try {
    const titleMessages = msgs.slice(0, 4).map((message) => ({
      role: message.sender_kind === SenderKind.Fellow ? "assistant" : "user",
      content: message.body_md
    }));
    const result = await window.mia.generateConversationTitle({
      fellowKey: fellowKeyForConversation(conversation),
      conversationId,
      messages: titleMessages
    });
    const title = String(result?.title || "").trim();
    if (!title || title === "新对话") return;
    const res = await window.mia.social.updateConversation(conversationId, { name: title });
    if (res?.ok && (res.data?.conversation || res.conversation)) social.upsertFellowConversation?.(res.data?.conversation || res.conversation);
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
    avatarCrop: user.avatarCrop || null
  });
  const fellowAvatarSpec = window.miaAvatarResolve.resolveAvatarForContact({
    id: fellowAvatarIdentityId(persona?.key || persona?.id || "assistant", persona || {}),
    displayName: persona?.name || "Assistant",
    avatarImage: persona?.avatarImage || "",
    avatarCrop: persona?.avatarCrop || null
  });
  const activeAvatarSpec = message.role === "assistant" ? fellowAvatarSpec : userAvatarSpec;
  const traceHtml = message.role === "assistant"
    ? window.miaTraceBlocks.renderTraceBlocks({
      reasoning: message.reasoning,
      tools: message.tools,
      content: message.content,
      expanded: false,
      scopeKey: `msg:${message.createdAt || ""}`
    })
    : "";
  const timeHtml = renderMessageTime(message.createdAt);
  const bodyHtml = String(message.content || "").trim() ? window.miaMarkdown.renderMarkdown(message.content) : "";
  const commandResultHtml = message.role === "assistant" ? renderCommandResultHtml(message.commandResult) : "";
  const replyHtml = window.miaMessageHelpers.replyQuoteHtml(message.replyTo);
  const translation = window.miaMessageMenu?.translationHtml(message, messageIndex) || "";
  const attachmentHtml = renderAttachmentChips([...(message.attachments || []), ...generatedAttachmentsForMessage(message)].map(hydrateAttachmentPreview));
  const pinnedHtml = message.pinned ? `<span class="message-pin-badge">${ICON_PARK_PIN_SVG}置顶</span>` : "";
  const roleClass = message.role === "user" ? "user" : "assistant";
  // Tag the avatar so the same app.js handlers fire here as in cloud DM /
  // group bubbles: left-click → contact card, right-click → dropdown. In a
  // local fellow session the AI avatar opens its editable 模型/推理强度/权限
  // card; the user avatar opens the self card. (一视同仁 across all chats.)
  const senderKind = message.role === "assistant" ? "fellow" : "user";
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
  return `<article class="message ${roleClass}">
      ${avatarHtml}
      <div class="message-stack">${taskAffordanceHtml}${traceHtml}<div class="bubble${message.pinned ? " pinned" : ""}" data-message-index="${messageIndex}">${pinnedHtml}${replyHtml}${bodyHtml}${commandResultHtml}${attachmentHtml}${translation}</div>${timeHtml}</div>
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

function renderCloudLoginGuide() {
  return `
    <div class="cloud-login-guide">
      <h2>登录 Mia Cloud</h2>
      <p>Mia 的对话都在云端同步。登录后即可与你的 Fellow 聊天。</p>
      <button type="button" class="primary" data-action="cloud-login">登录 / 注册</button>
    </div>
  `;
}

function hasUsableLocalAgent(runtime = state.runtime) {
  const inventory = runtime?.agentInventory;
  if (inventory?.summary) return Boolean(inventory.summary.hasUsableAgent);
  const engines = runtime?.agentEngines || {};
  return Boolean(runtime?.engineInstalled || engines.claudeCode?.available || engines.codex?.available);
}

function renderNoAgentGuide() {
  return `
    <div class="cloud-login-guide no-agent-guide">
      <h2>本机 Agent 尚未连接</h2>
      <p>要开始本机聊天，请先配置可用的本机 Agent。你也可以登录 Mia Cloud，同步并使用云端对话。</p>
      <div class="setup-actions">
        <button type="button" class="secondary" data-setup-action="open-agent-settings">查看本机引擎</button>
        <button type="button" class="secondary" data-action="cloud-login">登录 Mia Cloud</button>
      </div>
    </div>
  `;
}

function renderChat() {
  const activeConversationId = window.miaSocial?.getActiveConversationId?.();
  let onboardingWindow = false;
  if (activeConversationId) {
    document.body.classList.toggle("onboarding-window", false);
    if (window.miaSocial && typeof window.miaSocial.renderConversationChat === "function") {
      window.miaSocial.renderConversationChat(els.chat);
    }
    return;
  }
  const messages = [];
  if (window.miaSetupGuide?.shouldShowSetupGuide?.({ messages })) {
    onboardingWindow = true;
    document.body.classList.toggle("onboarding-window", true);
    els.chat.innerHTML = window.miaSetupGuide.renderSetupGuide();
    window.miaLottieIcons?.init?.(els.chat);
    return;
  }
  document.body.classList.toggle("onboarding-window", onboardingWindow);
  if (state.agentSetupSkipped && !hasUsableLocalAgent()) {
    els.chat.innerHTML = renderNoAgentGuide();
    return;
  }
  if (state.runtime?.cloud?.enabled) {
    els.chat.innerHTML = "";
    return;
  }
  els.chat.innerHTML = renderCloudLoginGuide();
}

function conversationTypeForComposer(conversation, conversationId = "") {
  return sessionHistory.conversationType(conversation, conversationId);
}

function fellowKeyForConversation(conversation) {
  return sessionHistory.fellowKey(conversation);
}

function runtimeKindForFellowConversation(conversation) {
  return sessionHistory.runtimeKind(conversation, "desktop-local");
}

function activeConversationFellowContext() {
  const social = window.miaSocial;
  const conversationId = social?.getActiveConversationId?.();
  if (!conversationId) return null;
  const conversation = social?.getConversationById?.(conversationId) || { id: conversationId };
  if (conversationTypeForComposer(conversation, conversationId) !== "fellow") return null;
  const fellowKey = fellowKeyForConversation(conversation);
  if (!fellowKey) return null;
  return {
    conversation,
    conversationId,
    fellowKey,
    runtimeKind: runtimeKindForFellowConversation(conversation)
  };
}

// Composer "使用": attach the skill to the conversation the user is currently
// viewing in the messages page — no fellow picker. Returns false when there is
// no active fellow conversation so the caller can prompt the user to open one.
function useSkillInActiveConversation(skill) {
  if (!skill || !skill.id) return false;
  if (!activeConversationFellowContext()) return false;
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
let cloudAuthExpiredHandling = false;
async function handleCloudAuthExpired() {
  if (cloudAuthExpiredHandling) return;
  if (!state.runtime?.cloud?.enabled) return;
  cloudAuthExpiredHandling = true;
  try {
    state.runtime = await window.mia.cloudLogout();
  } catch (error) {
    console.warn("[cloud] auto-logout after auth failure failed:", error?.message || error);
  } finally {
    render();
    setTimeout(() => { cloudAuthExpiredHandling = false; }, 3000);
  }
}

function activeFellowRuntimeControlContext() {
  const conversationContext = activeConversationFellowContext();
  if (conversationContext) {
    const personas = state.runtime?.fellows || state.runtime?.personas || [];
    const fellow = personas.find((persona) => (persona.key || persona.id) === conversationContext.fellowKey) || {};
    return {
      ...conversationContext,
      fellow: {
        ...fellow,
        key: conversationContext.fellowKey,
        id: fellow.id || fellow.key || conversationContext.fellowKey,
        runtimeKind: conversationContext.runtimeKind
      }
    };
  }
  const fellow = activePersona();
  const fellowKey = String(fellow?.key || fellow?.id || "").trim();
  if (!fellowKey) return null;
  return {
    conversation: null,
    conversationId: "",
    fellowKey,
    runtimeKind: fellow.runtimeKind || fellow.runtime_kind || "desktop-local",
    fellow: { ...fellow, key: fellowKey }
  };
}

function fellowRuntimeCacheKey(fellowKey, runtimeKind = "cloud-hermes") {
  return window.miaFellowCommands.runtimeCacheKey(fellowKey, runtimeKind);
}

function normalizePlatformModelEntry(entry = {}) {
  const id = String(entry.id || entry.model_name || entry.model || "").trim();
  if (!id) return null;
  return {
    id,
    label: String(entry.label || entry.name || entry.displayName || id).trim(),
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
    ? platformModelCatalog.entries
    : [{ id: "mia-default", label: "Mia Default" }];
}

function platformHermesPermissionEntries() {
  return [
    { value: "ask", label: "Ask" },
    { value: "auto", label: "Auto" },
    { value: "readOnly", label: "Read" }
  ];
}

function syncLocalFellowRuntimeBindingsSoon() {
  if (typeof window.miaSocial?.syncLocalFellowRuntimeBindings !== "function") return;
  window.miaSocial.syncLocalFellowRuntimeBindings()
    .catch((error) => console.warn("[renderer] desktop-local runtime sync failed:", error?.message || error));
}

function setComposerSelectOptions(select, entries, selectedValue) {
  if (!select) return "";
  const normalized = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && (entry.id !== undefined || entry.value !== undefined))
    .map((entry) => ({
      value: String(entry.id ?? entry.value),
      label: String(entry.label || entry.id || entry.value)
    }));
  select.innerHTML = normalized.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = entry.label;
    return option.outerHTML;
  }).join("");
  const value = String(selectedValue || normalized[0]?.value || "");
  select.value = normalized.some((entry) => entry.value === value) ? value : normalized[0]?.value || "";
  return select.selectedOptions?.[0]?.textContent || "";
}

async function ensureFellowRuntimeBinding(fellowKey, runtimeKind = "cloud-hermes") {
  return window.miaFellowCommands.getFellowRuntimeBinding({
    api: window.mia,
    cache: fellowRuntimeControlCache,
    fellowKey,
    runtimeKind
  });
}

function normalizeAgentEngineForRuntime(value) {
  const normalizer = window.miaEngineContracts?.normalizeAgentEngine;
  if (typeof normalizer === "function") return normalizer(value);
  const raw = String(value || "hermes").trim().toLowerCase().replace(/_/g, "-");
  if (raw === "claude" || raw === "claude-code") return "claude-code";
  if (raw === "codex" || raw === "openai-codex") return "codex";
  return "hermes";
}

function agentEngineForRuntimeControl(context = activeFellowRuntimeControlContext()) {
  if (context?.runtimeKind === "cloud-hermes") return "hermes";
  return normalizeAgentEngineForRuntime(
    context?.fellow?.agentEngine
      || context?.fellow?.agent_engine
      || window.miaEngineOptions.activeAgentEngine()
  );
}

function modelEntriesForRuntimeControl(context = activeFellowRuntimeControlContext()) {
  const engine = agentEngineForRuntimeControl(context);
  if (context?.runtimeKind === "cloud-hermes") return platformHermesModelEntries();
  if (engine === "claude-code" || engine === "codex") return window.miaEngineOptions.externalModelEntries(engine);
  return window.miaModelSettings.connectedModelEntries(state.runtime);
}

function syncConversationFellowRuntimeControls() {
  const context = activeConversationFellowContext();
  if (!context || context.runtimeKind !== "cloud-hermes") return false;
  const binding = fellowRuntimeControlCache.get(fellowRuntimeCacheKey(context.fellowKey, context.runtimeKind));
  const config = binding?.config || {};
  const modelEntries = platformHermesModelEntries();
  const modelLabel = setComposerSelectOptions(els.quickModelSelect, modelEntries, config.model || modelEntries[0]?.id || "mia-default");
  setText(els.quickModelLabel, modelLabel || "Mia Default");
  const effortLabel = setComposerSelectOptions(
    els.effortSelect,
    window.miaEngineOptions.effortOptions("hermes"),
    config.effortLevel || "medium"
  );
  setText(els.effortLabel, effortLabel || "Medium");
  const permissionLabel = setComposerSelectOptions(els.permissionMode, platformHermesPermissionEntries(), config.permissionMode || "ask");
  setText(els.permissionLabel, permissionLabel || "Ask");
  const permissionSwitcher = els.permissionMode?.closest(".permission-switcher");
  permissionSwitcher?.classList.toggle("yolo", false);
  permissionSwitcher?.classList.toggle("claude-bypass", false);
  if (els.quickModelSelect) els.quickModelSelect.disabled = false;
  if (els.effortSelect) els.effortSelect.disabled = false;
  if (els.permissionMode) els.permissionMode.disabled = false;
  setText(els.modelSwitchStatus, "Hermes");
  if (!platformModelCatalog.loaded && !platformModelCatalog.loading) {
    loadPlatformModelCatalog().then(() => {
      const latest = activeConversationFellowContext();
      if (latest?.conversationId === context.conversationId) render();
    });
  }
  if (!binding) {
    ensureFellowRuntimeBinding(context.fellowKey, context.runtimeKind)
      .then(() => {
        const latest = activeConversationFellowContext();
        if (latest?.conversationId === context.conversationId) render();
      })
      .catch((error) => {
        setText(els.modelSwitchStatus, "云端配置读取失败");
        console.warn("[renderer] cloud fellow runtime load failed:", error?.message || error);
      });
  }
  return true;
}

function setRuntimeControlDisabled(disabled) {
  if (els.quickModelSelect) els.quickModelSelect.disabled = disabled;
  if (els.effortSelect) els.effortSelect.disabled = disabled;
  if (els.permissionMode) els.permissionMode.disabled = disabled;
}

async function saveActiveFellowRuntimeControl(field, value, pendingText, successText, errorPrefix, modelEntries = []) {
  const context = activeFellowRuntimeControlContext();
  if (!context) return false;
  setText(els.modelSwitchStatus, pendingText);
  setRuntimeControlDisabled(true);
  try {
    const result = await window.miaFellowCommands.saveFellowRuntimeControl({
      api: window.mia,
      cache: fellowRuntimeControlCache,
      fellow: context.fellow,
      runtimeKind: context.runtimeKind,
      field,
      value,
      modelEntries,
      engineContracts: window.miaEngineContracts
    });
    if (!result?.saved) return false;
    if (result.runtime) state.runtime = result.runtime;
    if (context.runtimeKind !== "cloud-hermes") syncLocalFellowRuntimeBindingsSoon();
    setText(els.modelSwitchStatus, successText);
    if (field === "model" && context.runtimeKind !== "cloud-hermes" && agentEngineForRuntimeControl(context) === "hermes") {
      const entry = modelEntries.find((item) => [item.id, item.value, item.model].some((candidate) => String(candidate || "") === String(value || "")));
      if (entry) {
        window.miaModelSettings.applyModelEntryToFields(entry);
        const auth = window.miaModelSettings.modelAuthCopy(entry, state.runtime);
        if (auth.state.includes("需要")) {
          state.settingsOpen = true;
          state.activeSettingsTab = "model";
        }
      }
    }
    render();
  } catch (error) {
    setText(els.modelSwitchStatus, "保存失败");
    appendTransientChat("assistant", `${errorPrefix}: ${error.message || error}`);
    if (context.runtimeKind === "cloud-hermes") {
      syncConversationFellowRuntimeControls();
    } else {
      await refreshRuntime();
    }
  } finally {
    setRuntimeControlDisabled(false);
  }
  return true;
}

function activeConversationFellowKey() {
  const social = window.miaSocial;
  const conversationId = social?.getActiveConversationId?.();
  if (!conversationId) return "";
  const conversation = social?.getConversationById?.(conversationId) || { id: conversationId };
  return conversationTypeForComposer(conversation, conversationId) === "fellow" ? fellowKeyForConversation(conversation) : "";
}

function activePersona() {
  const personas = state.runtime?.fellows || state.runtime?.personas || [];
  const conversationFellowKey = activeConversationFellowKey();
  if (conversationFellowKey) {
    const conversationPersona = personas.find((persona) => (persona.key || persona.id) === conversationFellowKey);
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
  if (cloudConversation && conversationTypeForComposer(cloudConversation, cloudConversation.id || "") === "fellow") {
    await createNewCloudSessionForActive(cloudConversation);
    return;
  }
  // Cloud-only: 新对话 only applies to an active fellow conversation (handled
  // above). With no active fellow conversation there is nothing to create.
}

async function createNewCloudSessionForActive(conversation) {
  const payload = sessionHistory.createFellowSessionPayload(conversation, cryptoRandomId(), {
    title: "新对话",
    runtimeKindFallback: "desktop-local"
  });
  const fellowKey = payload.fellowKey;
  const ownerUserId = String(state.runtime?.cloud?.user?.id || state.runtime?.cloud?.user?.userId || "").trim();
  if (!fellowKey || !ownerUserId || !window.mia?.social?.ensureFellowSessionConversation) return;

  // Optimistic create: the cloud conversation id is deterministic
  // (`fellow:<ownerUserId>:<sessionId>`), so build the conversation locally and
  // switch into it with zero wait, then ensure it on the cloud in the
  // background. ensureFellowSessionConversation is idempotent, so a slow or
  // failed call is safe — we keep the local session and the first sent message
  // re-ensures it.
  const now = new Date().toISOString();
  const optimisticConversation = {
    id: sessionHistory.fellowConversationId(ownerUserId, payload.sessionId),
    type: "fellow",
    name: payload.title,
    decorations: { fellowKey, sessionId: payload.sessionId, runtimeKind: payload.runtimeKind },
    created_at: now,
    updated_at: now
  };
  window.miaSocial?.upsertFellowConversation?.(optimisticConversation);
  await selectCloudSessionConversation(optimisticConversation, { skipMessageLoad: true });

  window.mia.social.ensureFellowSessionConversation(payload.sessionId, {
    fellowKey,
    title: payload.title,
    runtimeKind: payload.runtimeKind
  }).then((response) => {
    if (response?.ok) {
      const createdConversation = response.data?.conversation || response.conversation;
      if (createdConversation?.id) window.miaSocial?.upsertFellowConversation?.(createdConversation);
    } else {
      console.warn("[renderer] ensureFellowSessionConversation failed:", response?.error || "unknown");
      appendTransientChat("assistant", "会话云端同步失败，发消息时会自动重试。");
    }
  }).catch((error) => {
    console.warn("[renderer] ensureFellowSessionConversation error:", error?.message || error);
  });
}

function fellowByKey(fellowKey) {
  const key = String(fellowKey || "");
  // Canonical owned-fellow list (cloud + local) so cloud fellows resolve too.
  const fellows = window.miaFellowManager?.allOwnedFellows?.() || [];
  return fellows.find((item) => String(item?.key || item?.id || "") === key) || { key };
}

async function openFellowConversation(fellowKey) {
  const key = String(fellowKey || "").trim();
  if (!key) return;
  const fellow = fellowByKey(key);
  state.activeContactKey = key;
  state.activeView = "chat";
  state.sessionMenuOpen = false;
  state.replyDraft = null;
  showNarrowContent();

  if (state.runtime?.cloud?.enabled && window.miaSocial?.ensureFellowConversation) {
    const existingConversation = window.miaSocial?.fellowConversationForKey?.(key);
    if (existingConversation?.id) {
      state.activeKey = "";
      window.miaSocial.setActiveConversationId(existingConversation.id);
      state.forceScrollToBottom = true;
      render();
      requestAnimationFrame(() => els.chatInput?.focus());
      return;
    }
    const conversation = await window.miaSocial.ensureFellowConversation(fellow);
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

window.miaOpenFellowConversation = openFellowConversation;

async function refreshRuntime() {
  const previousDaemon = state.runtime?.daemon || {};
  const runtime = await window.mia.runtimeStatus();
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
  // NOTE: group init is intentionally LAST. Its initGroupModule(...) calls
  // deps.triggerRender() during init, which calls render(), which calls
  // applyAppearance() — that lives in window.miaSettingsAppearance and
  // needs fontPresets / state / els injected first. If group init runs before
  // settings-appearance init, fontPresets is undefined and render() throws
  // "Cannot read properties of undefined (reading 'pingfang')".
  if (window.miaSettingsRemote && window.miaSettingsRemote.initSettingsRemote) {
    window.miaSettingsRemote.initSettingsRemote({
      state,
      els,
      setText,
    });
  }
  if (window.miaSkillHelpers && window.miaSkillHelpers.initSkillHelpers) {
    window.miaSkillHelpers.initSkillHelpers({ escapeHtml: window.miaMarkdown.escapeHtml });
  }
  if (window.miaAvatar && window.miaAvatar.initAvatarHelpers) {
    window.miaAvatar.initAvatarHelpers({ escapeHtml: window.miaMarkdown.escapeHtml });
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
  if (window.miaFellowDialog && window.miaFellowDialog.initFellowDialog) {
    window.miaFellowDialog.initFellowDialog({ state, els, renderView, render });
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
    window.miaLoaders.initLoaders({ state, render, fallbackSlashCommands });
  }
  if (window.miaComposer && window.miaComposer.initComposer) {
    window.miaComposer.initComposer({
      state,
      els,
      mia: window.mia,
      fallbackSlashCommands,
      loadSkills: () => window.miaLoaders.loadSkills(),
      renderAttachmentThumb,
      renderSendButton,
      resizeChatInput: () => window.miaMessageHelpers.resizeChatInput(),
      appendTransientChat,
      cryptoRandomId,
    });
  }
  if (window.miaFellowManager && window.miaFellowManager.initFellowManager) {
    window.miaFellowManager.initFellowManager({
      state,
      els,
      setText,
      formatConversationTime,
      loadSkills: () => window.miaLoaders.loadSkills(),
      showNarrowContent,
      render,
      openEditFellowDialog,
      deleteFellow,
      setFellowPinned,
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
      fellowByKey: window.miaFellowManager.fellowByKey,
      cryptoRandomId,
      avatarBackgroundStyle: window.miaAvatar.avatarBackgroundStyle,
      escapeHtml: window.miaMarkdown.escapeHtml,
      setText,
      renderView,
      refreshRuntime,
      appendTransientChat,
    });
  }
  if (window.miaSettingsAppearance && window.miaSettingsAppearance.initSettingsAppearance) {
    window.miaSettingsAppearance.initSettingsAppearance({
      state,
      els,
      mia: window.mia,
      fontPresets,
      DEFAULT_ACCENT_COLOR,
      DEFAULT_USER_BUBBLE_COLOR,
      DEFAULT_LIST_STYLE,
      DEFAULT_SELECTION_STYLE,
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
      closeFellowContextMenu: window.miaFellowManager.closeFellowContextMenu,
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
      paintHeaderStatus,
    });
    // Bootstrap social data if signed in to cloud (token present).
    // (cloud.enabled, not cloud.loggedIn — the latter never existed, so
    // this used to never run; bootstrap only fired later via the WS
    // events_ready event, which is part of why the list arrived late.)
    if (state.runtime && state.runtime.cloud && state.runtime.cloud.enabled) {
      window.miaSocial.bootstrapAfterLogin().catch((err) => {
        console.warn("[social] boot bootstrap failed:", err);
      });
    }
  }
  render();
  if (state.runtime?.agentInventory?.summary?.scanning) {
    setTimeout(refreshRuntime, 120);
  }
  setTimeout(() => {
    Promise.allSettled([
      trackStartupTask("加载 Hermes 模型列表", () => window.miaLoaders.loadModelCatalog()),
      trackStartupTask("加载 Codex 模型列表", () => window.miaLoaders.loadCodexModels()),
      trackStartupTask("加载引擎能力", () => window.miaLoaders.loadEngineCapabilities()),
      trackStartupTask("加载命令列表", () => window.miaLoaders.loadSlashCommands()),
      trackStartupTask("扫描本地 Skill", () => window.miaLoaders.loadSkills())
    ]).then(() => render());
  }, 800);
  window.miaTasksPanel.loadTasksFromDaemon().then(() => {
    window.miaTasksPanel.subscribeTaskEvents();
    if (state.activeView === "tasks") {
      window.miaTasksPanel.renderTaskView();
    }
  });
}

document.getElementById("groupInfoButton")?.addEventListener("click", () => {
  const conversationId = window.miaSocial?.getActiveConversationId?.();
  if (conversationId) window.miaGroupInfoDialog?.open(conversationId);
});

els.openSettings.addEventListener("click", () => {
  state.settingsOpen = true;
  if (state.activeSettingsTab === "profile") state.activeSettingsTab = "appearance";
  renderView();
});
// Cloud-only: login guides (empty chat / empty sidebar) open Settings → account.
document.addEventListener("click", (event) => {
  if (!event.target?.closest?.("[data-action='cloud-login']")) return;
  state.settingsOpen = true;
  state.activeSettingsTab = "account";
  renderView();
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
  window.miaSkillLibrary.renderSkillPreview();
});
els.skillPreviewDialog?.addEventListener("click", (event) => {
  if (event.target === els.skillPreviewDialog) {
    state.skillPreviewOpen = false;
    window.miaSkillLibrary.renderSkillPreview();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeImagePreview();
  if (state.skillContextMenu.open) window.miaSkillLibrary.closeSkillContextMenu();
  if (state.fellowContextMenu.open) window.miaFellowManager.closeFellowContextMenu();
  if (state.messageContextMenu.open) window.miaMessageMenu?.closeMessageContextMenu();
  window.miaComposer.closeComposerAddMenu();
  if (state.skillPreviewOpen) {
    state.skillPreviewOpen = false;
    window.miaSkillLibrary.renderSkillPreview();
  }
});
els.sessionMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  state.sessionMenuOpen = !state.sessionMenuOpen;
  renderSessionMenu();
});
document.addEventListener("click", (event) => {
  if (state.skillContextMenu.open && !els.skillContextMenu?.contains(event.target)) window.miaSkillLibrary.closeSkillContextMenu();
});
document.addEventListener("click", (event) => {
  if (state.fellowContextMenu.open && !els.fellowContextMenu?.contains(event.target)) window.miaFellowManager.closeFellowContextMenu();
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
  // Cloud-conversation bubbles (cloud DM + cloud group) carry data-message-source +
  // data-message-id and live in social.moduleState.messageCache, not the
  // fellow session, so dispatch to the lightweight social message menu.
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
    window.miaSocialMessageMenu?.openSocialMessageMenu(message, event.clientX, event.clientY);
    return;
  }
  const selection = window.miaMessageMenu?.selectionInsideBubble(bubble);
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
  if (!state.fellowMenuOpen) return;
  if (els.fellowCreateMenu?.contains(event.target) || els.newPersona?.contains(event.target)) return;
  state.fellowMenuOpen = false;
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
els.personaSearch.addEventListener("input", () => {
  state.personaFilter = els.personaSearch.value;
  render();
});
els.contactSearch?.addEventListener("input", () => {
  state.contactFilter = els.contactSearch.value;
  window.miaFellowManager.renderContacts();
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
    state.activeView = button.dataset.view;
    showNarrowContent();
    if (button.dataset.view === "settings") state.settingsOpen = true;
    if (button.dataset.view === "skills" && !state.skillLibrary.skills.length && !state.skillsLoading) window.miaLoaders.loadSkills();
    renderView();
    if (state.activeView === "tasks") {
      window.miaTasksPanel?.loadTasksFromDaemon().then(() => {
        window.miaTasksPanel?.renderTaskView();
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
  window.miaScrollbarOverlay.showScrollingScrollbar(event.target);
}, { capture: true, passive: true });
document.addEventListener("pointermove", (event) => {
  window.miaScrollbarOverlay.updateScrollbarOverlayDrag(event);
  window.miaScrollbarOverlay.maybeShowScrollbarForPointer(event);
}, { capture: true });
document.addEventListener("pointerup", (event) => window.miaScrollbarOverlay.stopScrollbarOverlayDrag(event), { capture: true });
document.addEventListener("pointercancel", (event) => window.miaScrollbarOverlay.stopScrollbarOverlayDrag(event), { capture: true });
document.addEventListener("mouseover", (event) => {
  const target = event.target?.closest?.(".scrollbar-active");
  if (!target) return;
  window.miaScrollbarOverlay.cancelScrollbarHide(target);
  window.miaScrollbarOverlay.updateScrollbarOverlay(target);
  target.classList.add("scrollbar-visible");
}, { capture: true, passive: true });
document.addEventListener("mouseout", (event) => {
  const target = event.target?.closest?.(".scrollbar-active");
  if (!target || target.contains(event.relatedTarget)) return;
  window.miaScrollbarOverlay.scheduleScrollbarHide(target, 500);
}, { capture: true, passive: true });
window.addEventListener("resize", () => {
  const overlayTarget = window.miaScrollbarOverlay.getScrollbarOverlayTarget();
  if (overlayTarget) window.miaScrollbarOverlay.updateScrollbarOverlay(overlayTarget);
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
  });
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
    state.runtime = await window.mia.cloudLogin({ mode, username, password });
    if (els.cloudPassword) els.cloudPassword.value = "";
    window.miaSocial?.bootstrapAfterLogin?.();
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
    state.runtime = await window.mia.cloudSync();
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
    state.runtime = await window.mia.cloudLogout();
    render();
  } catch (error) {
    setText(els.cloudLoginHint, `退出失败：${error.message || error}`);
  } finally {
    els.cloudLogout.disabled = false;
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

if (window.mia.onEnginesChanged) {
  window.mia.onEnginesChanged(() => { refreshRuntime().catch(() => {}); });
}

if (window.mia.onCloudEvent) {
  let cloudEventRefreshTimer = 0;
  window.mia.onCloudEvent((envelope = {}) => {
    const runtimeBinding = envelope.type === "fellow.runtime_updated"
      ? envelope.binding
      : envelope.payload?.binding;
    if (runtimeBinding?.fellowId && runtimeBinding?.runtimeKind) {
      fellowRuntimeControlCache.set(
        fellowRuntimeCacheKey(runtimeBinding.fellowId, runtimeBinding.runtimeKind),
        runtimeBinding
      );
    }
    window.miaSocial?.handleCloudEvent?.(envelope);
    if (envelope.cloud && state.runtime) {
      state.runtime = {
        ...state.runtime,
        cloud: envelope.cloud
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

els.startEngine?.addEventListener("click", async () => {
  els.startEngine.disabled = true;
  els.startEngine.textContent = "Starting...";
  try {
    state.runtime = await window.mia.startEngine();
    render();
  } catch (error) {
    window.alert(`启动失败：${error.message}`);
    await refreshRuntime();
  } finally {
    els.startEngine.disabled = false;
    els.startEngine.textContent = "Start";
  }
});
els.stopEngine?.addEventListener("click", async () => {
  state.runtime = await window.mia.stopEngine();
  render();
});

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
  const context = activeFellowRuntimeControlContext();
  const modelEntries = modelEntriesForRuntimeControl(context);
  await saveActiveFellowRuntimeControl(
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
  await saveActiveFellowRuntimeControl(
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
  await saveActiveFellowRuntimeControl(
    "permissionMode",
    mode || "ask",
    "保存权限...",
    "权限已更新",
    "Permission mode failed"
  );
});

els.modelSelect?.addEventListener("change", () => {
  const entry = window.miaModelHelpers.selectedModelEntry();
  window.miaModelSettings.applyModelEntryToFields(entry);
  updateModelFieldVisibility();
});


els.newPersona.addEventListener("click", (event) => {
  event.stopPropagation();
  state.fellowMenuOpen = !state.fellowMenuOpen;
  renderView();
});

els.convMenuAddFriend?.addEventListener("click", () => {
  state.fellowMenuOpen = false;
  renderView();
  window.miaSocial?.openAddFriendDialog?.();
});
els.addFellow?.addEventListener("click", () => {
  state.fellowMenuOpen = false;
  renderView();
  window.miaFellowDialog.openFellowDialog();
});
els.convMenuNewGroup?.addEventListener("click", () => {
  state.fellowMenuOpen = false;
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
els.contactMenuAddFellow?.addEventListener("click", () => {
  state.contactMenuOpen = false;
  renderView();
  window.miaFellowDialog.openFellowDialog();
});
els.contactMenuNewGroup?.addEventListener("click", () => {
  state.contactMenuOpen = false;
  renderView();
  window.miaSocial?.openCreateGroupDialog?.();
});
els.userAvatar?.addEventListener("click", () => window.miaFellowDialog.openProfileDialog());
els.userAvatar?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  window.miaFellowDialog.openProfileDialog();
});
els.closeProfileDialog?.addEventListener("click", () => window.miaFellowDialog.closeProfileDialog());
els.cancelProfile?.addEventListener("click", () => window.miaFellowDialog.closeProfileDialog());
els.closeFellowDialog?.addEventListener("click", () => window.miaFellowDialog.closeFellowDialog());
els.cancelFellow?.addEventListener("click", () => window.miaFellowDialog.closeFellowDialog());
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
  const fellow = window.miaFellowManager.fellowByKey(state.petGenerateFellowKey);
  if (!fellow) return;
  const job = await window.mia.generateFellowPet({
    fellowKey: fellow.key,
    prompt: els.petPrompt?.value || "",
    stylePreset: els.petStylePreset?.value || "codex",
    referenceImages: state.petReferences.map((item) => item.src)
  });
  state.petJobs = [job, ...state.petJobs.filter((item) => item.id !== job.id)];
  state.petJobPanelOpen = true;
  window.miaPetDialog?.closePetGenerateDialog();
  window.miaPetDialog?.renderPetJobs();
});
els.chooseFellowAvatar?.addEventListener("click", () => els.fellowAvatarFile?.click());
els.fellowAvatarFile?.addEventListener("change", () => {
  window.miaFellowDialog.readFellowAvatarFile(els.fellowAvatarFile.files?.[0]);
  els.fellowAvatarFile.value = "";
});
els.fellowAvatarPreview?.addEventListener("click", () => {
  const draft = state.fellowAvatarDraft;
  if (!draft?.image) return;
  window.miaFellowDialog.openAvatarCropEditor(draft.image, draft.crop);
});
els.fellowAvatarPreview?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  const draft = state.fellowAvatarDraft;
  if (!draft?.image) return;
  window.miaFellowDialog.openAvatarCropEditor(draft.image, draft.crop);
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
  window.miaFellowDialog.readFellowAvatarFile(event.dataTransfer?.files?.[0]);
});
els.chooseProfileAvatar?.addEventListener("click", () => els.profileAvatarFile?.click());
els.profileAvatarFile?.addEventListener("change", () => {
  window.miaFellowDialog.readProfileAvatarFile(els.profileAvatarFile.files?.[0]);
  els.profileAvatarFile.value = "";
});
els.profileAvatarPreview?.addEventListener("click", () => {
  const draft = state.profileAvatarDraft;
  if (!draft?.image) {
    els.profileAvatarFile?.click();
    return;
  }
  window.miaFellowDialog.openAvatarCropEditor(draft.image, draft.crop, "profile");
});
els.profileAvatarPreview?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  const draft = state.profileAvatarDraft;
  if (!draft?.image) {
    els.profileAvatarFile?.click();
    return;
  }
  window.miaFellowDialog.openAvatarCropEditor(draft.image, draft.crop, "profile");
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
  window.miaFellowDialog.readProfileAvatarFile(event.dataTransfer?.files?.[0]);
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
  window.miaFellowDialog.updateAvatarCropEditor({
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
  window.miaFellowDialog.updateAvatarCropEditor({
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
  window.miaFellowDialog.updateAvatarCropEditor(trim);
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
  window.miaFellowDialog.updateAvatarTrimControls?.();
});
if (els.avatarTrimStart) els.avatarTrimStart.addEventListener("input", () => {
  const trim = window.miaAvatarMedia?.normalizeTrim?.({
    ...state.avatarCropEditor.crop,
    start: els.avatarTrimStart.value
  }) || { start: 0, duration: 3 };
  window.miaFellowDialog.updateAvatarCropEditor(trim);
});
if (els.avatarTrimDuration) els.avatarTrimDuration.addEventListener("input", () => {
  const trim = window.miaAvatarMedia?.normalizeTrim?.({
    ...state.avatarCropEditor.crop,
    duration: els.avatarTrimDuration.value
  }) || { start: 0, duration: 3 };
  window.miaFellowDialog.updateAvatarCropEditor(trim);
});
els.confirmAvatarCrop?.addEventListener("click", async () => {
  if (state.avatarCropEditor.target === "groupConversation") {
    const image = state.avatarCropEditor.image;
    const crop = state.avatarCropEditor.crop;
    window.miaFellowDialog.closeAvatarCropEditor();
    window.miaGroupInfoDialog?.applyAvatarFromCropEditor(image, crop);
    return;
  }
  if (state.avatarCropEditor.target === "profile") {
    window.miaFellowDialog.setProfileAvatarDraft(state.avatarCropEditor.image, state.avatarCropEditor.crop);
    // Auto-persist the avatar so closing the profile dialog without clicking
    // "保存资料" doesn't silently drop the new avatar. The display name field
    // is preserved by reading whatever is currently in the input.
    try {
      const displayName = (els.profileDisplayName?.value || "").trim()
        || runtimeUserIdentity().displayName
        || "";
      state.runtime = await window.mia.saveProfile({
        displayName,
        avatarText: displayName ? window.miaAvatar.initials(displayName) : "",
        avatarImage: state.profileAvatarDraft.image || els.profileAvatarImage?.value || "",
        avatarCrop: window.miaAvatar.normalizeCrop(state.profileAvatarDraft.crop),
      });
      render();
    } catch (err) {
      console.error("[profile] avatar auto-save failed:", err);
    }
  } else {
    window.miaFellowDialog.setFellowAvatarDraft(state.avatarCropEditor.image, state.avatarCropEditor.crop);
  }
  window.miaFellowDialog.closeAvatarCropEditor();
});
els.cancelAvatarCrop?.addEventListener("click", () => window.miaFellowDialog.closeAvatarCropEditor());
els.resetAvatarCrop?.addEventListener("click", () => {
  state.avatarCropEditor.crop = window.miaAvatar.normalizeCrop(window.miaAvatar.avatarDefaultCropForSrc(state.avatarCropEditor.image));
  window.miaFellowDialog.renderAvatarCropEditor();
});

els.profileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const displayName = els.profileDisplayName.value.trim();
  state.runtime = await window.mia.saveProfile({
    displayName,
    avatarText: displayName ? window.miaAvatar.initials(displayName) : "",
    avatarImage: state.profileAvatarDraft.image || els.profileAvatarImage.value,
    avatarCrop: window.miaAvatar.normalizeCrop(state.profileAvatarDraft.crop)
  });
  window.miaFellowDialog.closeProfileDialog();
  render();
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

els.appearanceListStyle?.addEventListener("change", () => {
  window.miaSettingsAppearance.scheduleAppearanceSave(0);
});

els.appearanceSelectionStyle?.addEventListener("change", () => {
  window.miaSettingsAppearance.scheduleAppearanceSave(0);
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

els.appearanceShowHoverBackground?.addEventListener("click", () => {
  window.miaSettingsAppearance.toggleSettingsSwitch(els.appearanceShowHoverBackground);
});

els.appearanceShowUserAvatar?.addEventListener("click", () => {
  window.miaSettingsAppearance.toggleSettingsSwitch(els.appearanceShowUserAvatar);
});

els.appearanceShowAssistantAvatar?.addEventListener("click", () => {
  window.miaSettingsAppearance.toggleSettingsSwitch(els.appearanceShowAssistantAvatar);
});

els.fellowForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const existingFellow = els.fellowKey?.value
    ? window.miaFellowManager?.fellowByKey?.(els.fellowKey.value)
    : null;
  const runtimeKind = existingFellow?.runtimeKind || String(els.fellowRuntimeLocation?.value || "desktop-local");
  const fellow = {
    key: els.fellowKey?.value || "",
    name: els.fellowName.value,
    agentEngine: els.fellowAgentEngine?.value || "hermes",
    avatarImage: state.fellowAvatarDraft.image || els.fellowAvatar.value,
    avatarCrop: window.miaAvatar.normalizeCrop(state.fellowAvatarDraft.crop),
    description: state.fellowDialogMode === "create" ? els.fellowSeed.value : "",
    personaText: els.fellowSeed.value
  };
  const saved = await window.miaFellowCommands.saveFellow({
    state,
    fellow,
    runtimeKind,
    isCreate: state.fellowDialogMode !== "edit",
    api: window.mia,
    social: window.miaSocial,
    cloudModelEntries: platformHermesModelEntries,
  });
  if (saved.runtime) state.runtime = saved.runtime;
  const savedKey = saved.key || "";
  const cloudConversation = saved.conversation || null;
  if (runtimeKind !== "cloud-hermes" && savedKey) state.activeKey = savedKey;
  state.fellowDialogOpen = false;
  // If this was the initial onboarding create-fellow step, mark onboarding done.
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
  } else if (savedKey) await openFellowConversation(savedKey);
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
  if (window.miaComposer.handleComposerSkillBackspace(event)) return;
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

els.chatInput.addEventListener("compositionstart", () => {
  els.chatInput.dataset.composing = "true";
});

els.chatInput.addEventListener("compositionend", () => {
  window.miaMessageHelpers.noteCompositionEnded();
  els.chatInput.dataset.composing = "false";
  window.miaMessageHelpers.resizeChatInput();
  window.miaComposer.updateSlashCommandState();
  window.miaComposer.updateMentionMenuState();
  renderSendButton();
});

els.chatInput.addEventListener("input", () => {
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
els.skillPickerBody?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-skill-picker-plugin]");
  if (!button) return;
  state.skillPickerPluginId = button.dataset.skillPickerPlugin || "";
  state.skillPickerFilter = "";
  if (els.skillPickerSearch) els.skillPickerSearch.value = "";
  window.miaComposer.renderSkillPicker();
});
els.skillPickerBody?.addEventListener("pointerover", (event) => {
  const button = event.target.closest("[data-skill-picker-plugin]");
  if (!button || button.dataset.skillPickerPlugin === state.skillPickerPluginId) return;
  state.skillPickerPluginId = button.dataset.skillPickerPlugin || "";
  state.skillPickerFilter = "";
  if (els.skillPickerSearch) els.skillPickerSearch.value = "";
  window.miaComposer.renderSkillPicker();
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
  if (!event.clipboardData?.files?.length) return;
  window.miaComposer.addComposerFiles(event.clipboardData.files);
});
els.sendChat.addEventListener("click", async (event) => {
  if (!isActiveRunRunning()) return;
  event.preventDefault();
  event.stopPropagation();
  await window.mia.stopChat?.();
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
    const fellow = activePersona() || { key: state.activeKey };
    resumeButton.disabled = true;
    resumeButton.classList.add("loading");
    try {
      const result = await window.mia.executeAgentCommand?.({
        engine,
        commandName: "/resume",
        args: [sessionIdToResume],
        context: {
          sessionId: window.miaSocial?.getActiveConversationId?.() || "",
          fellow
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
  const link = event.target.closest("a.message-link[data-external-link]");
  if (link && els.chat.contains(link)) {
    event.preventDefault();
    event.stopPropagation();
    window.mia?.openExternal?.(link.dataset.externalLink);
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
  const link = event.target.closest("a.message-link[data-external-link]");
  if (link && els.chat.contains(link)) {
    event.preventDefault();
    window.mia?.openExternal?.(link.dataset.externalLink);
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
  // Branch: a cloud conversation (dm / group / fellow) is active → send via social.
  if (window.miaSocial?.getActiveConversationId?.()) {
    const conversationId = window.miaSocial.getActiveConversationId();
    let conversationText = els.chatInput.value;
    if (!conversationText.trim()) return;
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
    window.miaMessageHelpers.resizeChatInput();
    // Composer skill chips ride along with the message — stored on it, shown in
    // the bubble, used by the fellow responder. Only send them for a fellow conversation
    // (they drive that fellow's AI) and only when they were attached in THIS conversation
    // (guards a programmatic conversation switch with no intervening render). Clear them
    // on send regardless: the chip belongs to this message, not the next one.
    const chips = (state.composerActiveSkills || []).filter((skill) => skill && skill.id);
    const chipsBelongHere = chips.length && state.composerSkillsConversationId === conversationId && Boolean(activeConversationFellowContext());
    const messageSkills = chipsBelongHere
      ? chips.map((skill) => ({ id: String(skill.id), name: skill.name || skill.id }))
      : null;
    if (chips.length) {
      state.composerActiveSkills = [];
      state.composerSkillSelected = false;
      window.miaComposer.renderComposerSkills();
    }
    await window.miaSocial.sendInActiveConversation(conversationText, messageSkills ? { skills: messageSkills } : {});
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
  if (action === "open-agent-settings") {
    state.settingsOpen = true;
    state.activeSettingsTab = "model";
    renderView();
    return true;
  }
  if (action === "continue-no-agent") {
    await completeAgentSetup("", { skipped: true });
    renderView();
    return true;
  }
  if (action === "finish-agent-scan") {
    await completeAgentSetup("", { skipped: !hasUsableLocalAgent() });
    renderView();
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

function openInitialFellowDialog() {
  const engine = state.onboardingPickedEngine || "hermes";
  const seed = {
    name: "Mia",
    agentEngine: engine,
    bio: "你是 Mia，一个轻松友好的桌面 AI 伙伴，回答简洁、口语化。"
  };
  // Reuse existing fellow create dialog with prefilled values.
  if (typeof window.miaFellowDialog?.openFellowDialog === "function") {
    window.miaFellowDialog.openFellowDialog(null, seed);
  } else {
    // Fallback: at least open settings
    state.settingsOpen = true;
    state.activeSettingsTab = "model";
    renderView();
  }
}

window.miaMessageHelpers.resizeChatInput();
function startAfterFirstPaint() {
  const start = () => {
    try { window.mia?.notifyFirstPaint?.(); } catch { /* main may not expose this in older builds */ }
    initializeRuntime().catch((error) => {
      console.error("Failed to initialize Mia runtime", error);
      const message = error?.message || String(error || "Unknown error");
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
  const spacer = document.getElementById("trafficSpacer");
  const api = window.mia?.window;
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
