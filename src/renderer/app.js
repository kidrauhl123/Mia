const fallbackSlashCommands = window.aimashiAppState.fallbackSlashCommands;
const SETUP_GUIDE_DISMISSED_KEY = window.aimashiAppState.SETUP_GUIDE_DISMISSED_KEY;
const { ConversationKind, MemberKind } = (typeof window !== "undefined" && window.aimashiConversationKinds) || require("../shared/conversation-kinds");
const { prepareOutgoingMessage } = (typeof window !== "undefined" && window.aimashiSendPipeline) || require("../shared/send-pipeline");
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 380;
const SIDEBAR_WIDTH_DEFAULT = 280;
let skillPickerHoverCloseTimer = 0;
const qrSvgCache = new Map();
const ICON_PARK_PIN_SVG = '<svg class="icon-park-pin" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="M10.6963 17.5042C13.3347 14.8657 16.4701 14.9387 19.8781 16.8076L32.62 9.74509L31.8989 4.78683L43.2126 16.1005L38.2656 15.3907L31.1918 28.1214C32.9752 31.7589 33.1337 34.6647 30.4953 37.3032C30.4953 37.3032 26.235 33.0429 22.7171 29.525L6.44305 41.5564L18.4382 25.2461C14.9202 21.7281 10.6963 17.5042 10.6963 17.5042Z"/></svg>';

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

const state = window.aimashiAppState.createInitialState({
  localStorage,
  sidebarWidth: savedSidebarWidth(),
  windowWidth: window.innerWidth
});

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
  convMenuAddFriend: document.getElementById("convMenuAddFriend"),
  convMenuNewGroup: document.getElementById("convMenuNewGroup"),
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
  contactsUnreadBadge: document.getElementById("contactsUnreadBadge"),
  chatUnreadBadge: document.getElementById("chatUnreadBadge"),
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

// Resolve a cloud-room member record into an avatar tile. The kinds
// recognized here ("user" / "fellow") mirror cloud-room-source.js's
// authorForMessage dispatch — same data shape, same resolution rules,
// so member tiles in the rail and sender avatars in the message stream
// stay in lockstep. Destructured access keeps the offending operator pattern
// out of app.js (Stage 5.2 will swap these literals for the
// shared MemberKind enum).
// Context passed to the shared resolveGroupMemberTiles for every group
// rendered in the renderer (sidebar + active-chat header). One builder so
// the cloud and local paths can't drift.
function groupTilesCtx(personas) {
  const social = window.aimashiSocial;
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
    fellows: personas || [],
    avatarAssetForKey: window.aimashiAvatar?.avatarAssetForKey
  };
}

// Normalize any sidebar row kind into a unified ConversationCard spec the
// sidebar-card-renderer can paint. Fellow private + cloud DM both become
// {kind:"private"} with one member; local fellow group + cloud room both
// become {kind:"group"} with stacked tiles. Single render path; "real
// human friend" is just another member kind, not a different conversation
// species.
function conversationCardSpecFromRow(row, personas) {
  if (!row) return null;
  const social = window.aimashiSocial;
  const avatarHelper = window.aimashiAvatar;
  const userProfile = state.runtime?.user || {};

  // ── fellow private chat (existing) ───────────────────────────────────────
  if (row.type === "fellow") {
    const persona = row.persona;
    const preview = conversationPreview(persona);
    const unread = window.aimashiSessionReadState.unreadCountForPersona(persona.key);
    return {
      kind: "private",
      active: persona.key === state.activeKey,
      pinned: Boolean(persona.pinned),
      name: persona.name,
      typeLabel: "私聊",
      preview: preview.text || "暂无对话",
      time: preview.time,
      unread,
      avatar: {
        image: persona.avatarImage || avatarHelper?.avatarAssetForKey(persona.key),
        crop: persona.avatarCrop,
        color: persona.color || "#5e5ce6"
      },
      dataAttrs: { fellowAvatar: persona.key },
      onClick: () => {
        state.activeKey = persona.key;
        if (window.aimashiSocial) window.aimashiSocial.setActiveRoomId(null);
        const latest = sessionsForPersona(persona.key)[0];
        state.activeSessionIdByPersona[persona.key] = latest?.id;
        state.replyDraft = null;
        window.aimashiSessionReadState.markPersonaRead(persona.key);
        state.sessionMenuOpen = false;
        showNarrowContent();
        render();
      },
      onContextMenu: (x, y) => window.aimashiConversationContextMenu.openPrivateConversationMenu(
        { id: persona.key, name: persona.name, pinned: Boolean(persona.pinned), unread },
        {
          togglePinned: () => setFellowPinned(persona.key, !persona.pinned),
          rename: () => openEditFellowDialog(persona.key),
          markRead: () => { window.aimashiSessionReadState.markPersonaRead(persona.key); render(); },
          remove: persona.key === "aimashi" ? null : () => deleteFellow(persona.key)
        },
        x, y
      )
    };
  }

  // ── cloud fellow room (1-on-1 with a fellow, mirrored from a desktop
  //     session) — same row shape as fellow private chat. Title +
  //     avatar come from the fellow definition resolved by id.
  // ── cloud private room (DM with a friend OR fellow session) ─────────────
  //     Same card shape; the only branch is "who's the other party" — a
  //     friend (dm room) or a fellow (fellow room) — and that flows
  //     through one resolver into a single spec.
  //
  //     fellow-type rooms are server mirrors of desktop fellow sessions;
  //     the desktop already shows the persona-level "fellow" card, so
  //     hiding the mirror here avoids duplicating one fellow conversation
  //     into N session rows. (Cleanup target: when fellow chat moves
  //     fully to cloud rooms, delete the "fellow" branch and stop hiding
  //     these.)
  if (row.type === "private-room") {
    const room = row.room;
    const activeRoomId = social?.getActiveRoomId?.();
    const isFellow = room.type === "fellow";
    if (isFellow) return null;
    let name, avatar;
    if (isFellow) {
      const fellowKey = room.decorations?.fellowKey || (room.id?.split(":")[2] || "");
      const fellow = personas.find((p) => (p.id || p.key) === fellowKey);
      name = room.name || fellow?.name || "对话";
      avatar = {
        image: fellow?.avatarImage || avatarHelper?.avatarAssetForKey(fellowKey),
        crop: fellow?.avatarCrop,
        color: fellow?.color || "#5e5ce6"
      };
    } else {
      const other = room.otherUser || {};
      name = other.username || other.account || "好友";
      avatar = {
        image: other.avatarImage,
        crop: other.avatarCrop,
        color: other.avatarColor || "#5e5ce6"
      };
    }
    const pinned = Boolean(social?.isRoomPinned?.(room.id));
    const muted = Boolean(social?.isRoomMuted?.(room.id));
    const unread = social?.getUnreadForRoom?.(room.id) || 0;
    return {
      kind: "private",
      active: room.id === activeRoomId,
      pinned,
      muted,
      name,
      typeLabel: "私聊",
      preview: room.lastMessagePreview || "暂无对话",
      time: formatConversationTime(row.updatedAt),
      unread,
      avatar,
      onClick: () => {
        state.activeKey = "";
        window.aimashiSocial.setActiveRoomId(room.id);
        showNarrowContent();
        render();
      },
      onContextMenu: (x, y) => window.aimashiConversationContextMenu.openPrivateConversationMenu(
        { id: room.id, name, pinned, unread, muted },
        {
          togglePinned: () => { social.setRoomPinned(room.id, !pinned); render(); },
          toggleRead: (next) => {
            if (next) social.setRoomManuallyUnread(room.id, true);
            else { social.setRoomManuallyUnread(room.id, false); social.markRoomRead(room.id); }
            render();
          },
          toggleMuted: (next) => { social.setRoomMuted(room.id, next); render(); },
          remove: async () => {
            if (!confirm(`确定删除与「${name}」的对话？此操作不可撤销。`)) return;
            const res = await social.deleteCloudRoom(room.id);
            if (!res?.ok) alert(`删除失败：${res?.error || "未知错误"}`);
          },
          // DM display name follows the peer's username, so server rejects
          // PATCH name on dm:* rooms — surface that to the menu.
          ...(isFellow ? {} : { notSupported: { rename: "私聊对方名称由对方用户名决定，无法在此重命名" } })
        },
        x, y
      )
    };
  }

  // ── cloud group (friends + fellows mixed) — same shape as local group ────
  if (row.type === "group-room") {
    const room = row.room;
    const activeRoomId = social?.getActiveRoomId?.();
    const memberRecords = social?.getRoomMembers?.(room.id) || [];
    const tiles = window.aimashiGroupTiles.resolveGroupMemberTiles(memberRecords, groupTilesCtx(personas));
    const memberCount = memberRecords.length || room.memberCount || 0;
    const cgPinned = Boolean(social?.isRoomPinned?.(room.id));
    const cgMuted = Boolean(social?.isRoomMuted?.(room.id));
    const cgUnread = social?.getUnreadForRoom?.(room.id) || 0;
    const cgName = room.name || "群聊";
    return {
      kind: "group",
      active: room.id === activeRoomId,
      pinned: cgPinned,
      muted: cgMuted,
      name: cgName,
      typeLabel: memberCount ? `群聊 · ${memberCount}人` : "群聊",
      preview: room.lastMessagePreview || "暂无消息",
      time: formatConversationTime(row.updatedAt),
      unread: cgUnread,
      members: tiles,
      customAvatar: room.decorations?.avatar || null,
      onClick: () => {
        state.activeKey = "";
        window.aimashiSocial.setActiveRoomId(room.id);
        showNarrowContent();
        render();
      },
      onContextMenu: (x, y) => window.aimashiConversationContextMenu.openGroupConversationMenu(
        { id: room.id, name: cgName, pinned: cgPinned, unread: cgUnread, muted: cgMuted },
        {
          togglePinned: () => { social.setRoomPinned(room.id, !cgPinned); render(); },
          toggleRead: (next) => {
            if (next) social.setRoomManuallyUnread(room.id, true);
            else { social.setRoomManuallyUnread(room.id, false); social.markRoomRead(room.id); }
            render();
          },
          toggleMuted: (next) => { social.setRoomMuted(room.id, next); render(); },
          openInfo: () => window.aimashiGroupInfoDialog?.open(room.id),
          rename: async () => {
            const next = window.prompt("编辑群组名称", cgName);
            if (!next || next.trim() === cgName) return;
            const res = await social.renameRoom(room.id, next.trim());
            if (!res?.ok) alert(`重命名失败：${res?.error || "未知错误"}`);
          },
          remove: async () => {
            if (!confirm(`确定删除群组「${cgName}」？此操作不可撤销，所有成员都将无法访问。`)) return;
            const res = await social.deleteCloudRoom(room.id);
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
// currently-active cloud room (type ∈ {dm, group, fellow}). Mirrors the
// local-group branch — both paths route through aimashiGroupAvatar for
// any conversation that has more than one member, so the sidebar and the
// chat header always agree.
function paintActiveCloudRoomHeader(room, { personas, social }) {
  const avatarEl = els.activeChatAvatar;
  const nameEl = els.activeChatName;
  const metaEl = els.activeChatMeta;
  const userProfile = state.runtime?.user || {};
  const avatarHelper = window.aimashiAvatar;
  const groupAvatarHelper = window.aimashiGroupAvatar;
  // id-prefix fallback for pre-v7 cloud deployments that don't yet return
  // room.type. social.renderSidebarRows already normalizes this; mirror it
  // here so a room loaded outside the sidebar pipeline (active room loaded
  // from cache, etc.) still routes correctly.
  const roomType = room.type
    || (room.id?.startsWith("dm:") ? "dm"
      : room.id?.startsWith("fellow:") ? "fellow"
      : (room.id?.startsWith("g_") || room.id?.startsWith("g-")) ? "group"
      : "dm");

  if (roomType === "group") {
    const members = social?.getRoomMembers?.(room.id) || [];
    const tiles = window.aimashiGroupTiles.resolveGroupMemberTiles(members, groupTilesCtx(personas));
    const customAvatar = room.decorations?.avatar;
    if (avatarEl) {
      if (customAvatar && customAvatar.image) {
        avatarEl.className = "profile-avatar";
        avatarEl.innerHTML = "";
        avatarEl.removeAttribute("data-count");
        const style = avatarHelper.avatarThumbBackgroundStyle(customAvatar.image, customAvatar.crop, "#5e5ce6");
        avatarEl.setAttribute("style", style);
      } else {
        avatarEl.className = "profile-avatar group-avatar";
        groupAvatarHelper.applyGroupAvatar(avatarEl, tiles);
      }
    }
    setText(nameEl, room.name || "群聊");
    if (metaEl) metaEl.textContent = tiles.length ? `群聊 · ${tiles.length} 人` : "群聊";
    return;
  }

  if (roomType === "fellow") {
    const fellowKey = room.decorations?.fellowKey || (room.id?.split(":")[2] || "");
    const fellow = (personas || []).find((p) => (p.id || p.key) === fellowKey);
    if (avatarEl) {
      avatarEl.innerHTML = "";
      avatarEl.removeAttribute("data-count");
      avatarEl.className = "profile-avatar";
      avatarHelper.applyFellowAvatar(avatarEl, fellow || { key: fellowKey, name: room.name });
    }
    setText(nameEl, room.name || fellow?.name || "对话");
    if (metaEl) metaEl.textContent = "私聊";
    return;
  }

  // DM
  const otherId = (() => {
    const parts = String(room.id || "").split(":");
    if (parts[0] !== "dm") return "";
    return parts[1] === userProfile.id ? parts[2] : parts[1];
  })();
  const friend = social?.friendById?.(otherId);
  const displayName = friend?.username || friend?.account || otherId || "好友";
  if (avatarEl) {
    avatarEl.innerHTML = "";
    avatarEl.removeAttribute("data-count");
    avatarEl.className = "profile-avatar";
    if (friend) {
      avatarHelper.applyFellowAvatar(avatarEl, {
        key: friend.id,
        avatarImage: friend.avatarImage,
        avatarCrop: friend.avatarCrop,
        color: friend.avatarColor
      });
    } else {
      const letter = (displayName[0] || "?").toUpperCase();
      avatarEl.textContent = letter;
      avatarEl.style.cssText = "background-color:#5e5ce6; color:#fff;";
    }
  }
  setText(nameEl, displayName);
  if (metaEl) metaEl.textContent = "私聊";
}

// (openRoomContextMenu removed — sidebar now uses the unified
// openPrivateConversationMenu / openGroupConversationMenu from
// src/renderer/conversation-context-menu.js so cloud and local
// conversations share one menu shape.)

const { formatConversationTime, formatMessageTime } = (typeof window !== "undefined" && window.aimashiTimeFormat) || require("../shared/time-format");

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
  window.aimashiMessageHelpers.renderComposerReply();
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
    window.aimashiFellowDialog.setProfileAvatarDraft(user.avatarImage || "", user.avatarCrop);
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
  if (!personas.some((persona) => persona.key === state.activeKey) && personas.length && !window.aimashiSocial?.getActiveRoomId?.()) {
    state.activeKey = personas[0].key;
  }
  if (!personas.some((persona) => persona.key === state.activeContactKey) && personas.length) {
    state.activeContactKey = personas.find((persona) => persona.key === state.activeKey)?.key || personas[0].key;
  }
  window.aimashiSessionReadState.initializeReadStateForPersonas(personas);
  window.aimashiSessionReadState.markPersonaRead(state.activeKey, false);
  const unreadTotal = window.aimashiSessionReadState.totalUnreadCount(personas);
  els.personaCount.textContent = window.aimashiUnread.unreadBadgeText(unreadTotal);
  els.personaCount.classList.toggle("hidden", unreadTotal <= 0);
  const active = personas.find((persona) => persona.key === state.activeKey) || personas[0];
  const activeCloudRoomId = window.aimashiSocial?.getActiveRoomId?.();
  const activeCloudRoom = activeCloudRoomId
    ? window.aimashiSocial?.getRoomById?.(activeCloudRoomId)
    : null;
  const groupInfoBtn = document.getElementById("groupInfoButton");
  const composerBottom = document.querySelector(".composer-bottom");
  if (activeCloudRoom) {
    paintActiveCloudRoomHeader(activeCloudRoom, { personas, social: window.aimashiSocial });
    const activeIsGroup = (activeCloudRoom.type
      || (activeCloudRoom.id?.startsWith("dm:") ? "dm"
        : activeCloudRoom.id?.startsWith("fellow:") ? "fellow"
        : (activeCloudRoom.id?.startsWith("g_") || activeCloudRoom.id?.startsWith("g-")) ? "group"
        : "")) === "group";
    if (groupInfoBtn) groupInfoBtn.classList.toggle("hidden", !activeIsGroup);
    if (els.sessionMenuButton) els.sessionMenuButton.classList.add("hidden");
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
    if (composerBottom) composerBottom.classList.remove("hidden");
  }
  const filter = state.personaFilter.trim().toLowerCase();
  const visiblePersonas = filter
    ? personas.filter((persona) => `${persona.name || ""} ${persona.key || ""}`.toLowerCase().includes(filter))
    : personas;
  const socialRows = window.aimashiSocial?.renderSidebarRows?.() || [];
  const messageRows = window.aimashiFellowManager.sortMessageCardsForSidebar([
    ...visiblePersonas.map((persona) => ({
      type: "fellow",
      key: persona.key,
      pinned: Boolean(persona.pinned),
      pinnedAt: persona.pinnedAt || "",
      updatedAt: conversationUpdatedAt(persona),
      persona
    })),
    ...socialRows
  ]);

  els.personaList.innerHTML = "";
  for (const row of messageRows) {
    const spec = conversationCardSpecFromRow(row, personas);
    if (!spec) continue;
    const card = spec.kind === ConversationKind.CloudGroup
      ? window.aimashiSidebarCards.createGroupCard(spec)
      : window.aimashiSidebarCards.createPrivateCard(spec);
    els.personaList.appendChild(card);
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
  if (state.activeSettingsTab === "mobile") state.activeSettingsTab = "account";
  if (!document.querySelector(`[data-settings-tab="${state.activeSettingsTab}"]`)) {
    state.activeSettingsTab = "account";
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
  els.contactCreateMenu?.classList.toggle("hidden", !state.contactMenuOpen);
  // Contacts unread = number of pending incoming friend requests.
  const incomingCount = window.aimashiSocial?.moduleState?.incomingRequests?.length || 0;
  if (els.contactsUnreadBadge) {
    if (incomingCount > 0) {
      els.contactsUnreadBadge.classList.remove("hidden");
      els.contactsUnreadBadge.textContent = window.aimashiUnread.unreadBadgeText(incomingCount);
    } else {
      els.contactsUnreadBadge.classList.add("hidden");
    }
  }
  // Chat unread = total unread DM/group room messages.
  const roomUnread = window.aimashiSocial?.getTotalRoomUnread?.() || 0;
  if (els.chatUnreadBadge) {
    if (roomUnread > 0) {
      els.chatUnreadBadge.classList.remove("hidden");
      els.chatUnreadBadge.textContent = window.aimashiUnread.unreadBadgeText(roomUnread);
    } else {
      els.chatUnreadBadge.classList.add("hidden");
    }
  }
  els.fellowDialog?.classList.toggle("hidden", !state.fellowDialogOpen);
  els.petGenerateDialog?.classList.toggle("hidden", !state.petGenerateOpen);
  els.avatarCropDialog?.classList.toggle("hidden", !state.avatarCropEditor.open);
  window.aimashiSkillLibrary.renderSkillPreview();
  window.aimashiFellowManager.renderFellowContextMenu();
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
  document.body.classList.toggle("topbar-click-capture", Boolean(state.skillContextMenu.open || state.sessionMenuOpen));
}

function formatRunTime(ms) {
  if (ms == null) return "—";
  const d = new Date(ms);
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}


async function openEditFellowDialog(fellowKey) {
  try {
    const details = await window.aimashi.loadFellowDetails(fellowKey);
    window.aimashiFellowDialog.openFellowDialog(details.fellow, details.personaText || "");
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
    window.aimashiComposer.renderSkillPicker();
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
    ? window.aimashiTraceBlocks.renderTraceBlocks({
      reasoning: message.reasoning,
      tools: message.tools,
      content: message.content,
      expanded: false,
      scopeKey: `msg:${message.createdAt || ""}`
    })
    : "";
  const timeHtml = renderMessageTime(message.createdAt);
  const bodyHtml = String(message.content || "").trim() ? window.aimashiMarkdown.renderMarkdown(message.content) : "";
  const commandResultHtml = message.role === "assistant" ? renderCommandResultHtml(message.commandResult) : "";
  const replyHtml = window.aimashiMessageHelpers.replyQuoteHtml(message.replyTo);
  const translation = window.aimashiMessageMenu?.translationHtml(message, messageIndex) || "";
  const attachmentHtml = renderAttachmentChips([...(message.attachments || []), ...generatedAttachmentsForMessage(message)].map(hydrateAttachmentPreview));
  const pinnedHtml = message.pinned ? `<span class="message-pin-badge">${ICON_PARK_PIN_SVG}置顶</span>` : "";
  const roleClass = message.role === "user" ? "user" : "assistant";
  return `<article class="message ${roleClass}">
      <div class="avatar" style="background-color:${window.aimashiMarkdown.escapeHtml(avatarBackgroundColor)};${imageStyle}">${message.role === "user" && !userAvatar ? window.aimashiMarkdown.escapeHtml(label) : ""}</div>
      <div class="message-stack">${taskAffordanceHtml}${traceHtml}<div class="bubble${message.pinned ? " pinned" : ""}" data-message-index="${messageIndex}">${pinnedHtml}${replyHtml}${bodyHtml}${commandResultHtml}${attachmentHtml}${translation}</div>${timeHtml}</div>
    </article>`;
}

function renderCommandResultHtml(commandResult) {
  if (!commandResult || commandResult.type !== "session-list" || !Array.isArray(commandResult.rows)) return "";
  const engine = String(commandResult.engine || "");
  const sourceDeviceId = String(commandResult.sourceDeviceId || "");
  const currentDeviceId = String(state.runtime?.relay?.deviceId || "");
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
      <button class="command-session-row" type="button" data-command-resume-engine="${window.aimashiMarkdown.escapeHtml(engine)}" data-command-resume-id="${window.aimashiMarkdown.escapeHtml(row.id || "")}" data-command-source-device-id="${window.aimashiMarkdown.escapeHtml(sourceDeviceId)}"${isForeignDeviceList ? " disabled title=\"这条列表来自另一台设备，请在当前设备重新发送 /resume\"" : ""}>
        <span class="command-session-main">
          <strong>${window.aimashiMarkdown.escapeHtml(title)}</strong>
          <small>${window.aimashiMarkdown.escapeHtml(previewText)}</small>
        </span>
        <span class="command-session-side">${window.aimashiMarkdown.escapeHtml(time)}</span>
      </button>
    `;
  }).join("");
  return `<div class="command-result session-list">${rows}</div>`;
}

function renderChat() {
  // Branch: a cloud room (DM / group / fellow) is active → social paints
  // the message list. Header is painted by render() above.
  const activeRoomId = window.aimashiSocial?.getActiveRoomId?.();
  if (activeRoomId && !state.activeKey) {
    if (window.aimashiSocial && typeof window.aimashiSocial.renderRoomChat === "function") {
      window.aimashiSocial.renderRoomChat(els.chat);
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
    window.aimashiTraceBlocks.traceReasoningForDisplay(s.reasoning, s.tools, s.text)
  );
  if (s && s.sessionId === session.id && hasStreamingContent) {
    const article = document.createElement("article");
    article.className = "message assistant streaming";
    const personaForStream = active;
    const fellowAvatarImage = personaForStream?.avatarImage || window.aimashiAvatar.avatarAssetForKey(personaForStream?.key);
    const fellowAvatar = window.aimashiAvatar.avatarImageSrc(fellowAvatarImage);
    const avatarBackgroundColor = fellowAvatar ? "transparent" : (personaForStream?.color || "#23444d");
    const imageStyle = window.aimashiAvatar.avatarThumbBackgroundStyle(fellowAvatarImage, personaForStream?.avatarCrop, personaForStream?.color);
    const traceHtml = window.aimashiTraceBlocks.renderTraceBlocks({
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
  if (options.commandResult && typeof options.commandResult === "object") {
    message.commandResult = {
      ...options.commandResult,
      rows: Array.isArray(options.commandResult.rows)
        ? options.commandResult.rows.map((row) => ({
          id: String(row.id || ""),
          title: String(row.title || ""),
          preview: String(row.preview || ""),
          project: String(row.project || ""),
          updatedAt: Number(row.updatedAt) || 0
        }))
        : []
    };
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
  const reasoning = window.aimashiTraceBlocks.traceReasoningForDisplay(options.reasoning, message.tools, content);
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
  if (window.aimashiFellowDialog && window.aimashiFellowDialog.initFellowDialog) {
    window.aimashiFellowDialog.initFellowDialog({ state, els, renderView, render });
  }
  if (window.aimashiTraceBlocks && window.aimashiTraceBlocks.initTraceBlocks) {
    window.aimashiTraceBlocks.initTraceBlocks({ state });
  }
  if (window.aimashiMessageHelpers && window.aimashiMessageHelpers.initMessageHelpers) {
    window.aimashiMessageHelpers.initMessageHelpers({
      state,
      els,
      activePersona,
      messagesForActive,
      renderSendButton,
    });
  }
  if (window.aimashiLoaders && window.aimashiLoaders.initLoaders) {
    window.aimashiLoaders.initLoaders({ state, render, fallbackSlashCommands });
  }
  if (window.aimashiComposer && window.aimashiComposer.initComposer) {
    window.aimashiComposer.initComposer({
      state,
      els,
      aimashi: window.aimashi,
      fallbackSlashCommands,
      loadSkills: () => window.aimashiLoaders.loadSkills(),
      renderAttachmentThumb,
      renderSendButton,
      resizeChatInput: () => window.aimashiMessageHelpers.resizeChatInput(),
      appendTransientChat,
      cryptoRandomId,
      activeSession,
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
      loadSkills: () => window.aimashiLoaders.loadSkills(),
      showNarrowContent,
      render,
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
      messageAtIndex: window.aimashiMessageHelpers.messageAtIndex,
      messageReferenceForIndex: window.aimashiMessageHelpers.messageReferenceForIndex,
      messageContextText: window.aimashiMessageHelpers.messageContextText,
      menuItemHtml: window.aimashiMarkdown.menuItemHtml,
      activeSession,
      persistSessionQuietly,
      replacePersistedSessionQuietly,
      renderChat,
      renderSessionMenu,
      renderComposerReply: window.aimashiMessageHelpers.renderComposerReply,
      escapeHtml: window.aimashiMarkdown.escapeHtml,
      renderMarkdown: window.aimashiMarkdown.renderMarkdown,
      copyTextToClipboard,
      nowIso,
      cryptoRandomId,
      closeSkillContextMenu: window.aimashiSkillLibrary.closeSkillContextMenu,
      closeFellowContextMenu: window.aimashiFellowManager.closeFellowContextMenu,
    });
  }
  if (window.aimashiSocial && window.aimashiSocial.initSocialModule) {
    window.aimashiSocial.initSocialModule({
      getState: () => state,
      render,
      els,
      appendTransientChat,
    });
    // Bootstrap social data if already logged in to cloud
    if (state.runtime && state.runtime.cloud && state.runtime.cloud.loggedIn) {
      window.aimashiSocial.bootstrapAfterLogin().catch((err) => {
        console.warn("[social] boot bootstrap failed:", err);
      });
    }
  }
  await trackStartupTask("加载会话", loadChatSessions);
  render();
  setTimeout(() => {
    Promise.allSettled([
      trackStartupTask("加载 Hermes 模型列表", () => window.aimashiLoaders.loadModelCatalog()),
      trackStartupTask("加载 Codex 模型列表", () => window.aimashiLoaders.loadCodexModels()),
      trackStartupTask("加载引擎能力", () => window.aimashiLoaders.loadEngineCapabilities()),
      trackStartupTask("加载命令列表", () => window.aimashiLoaders.loadSlashCommands()),
      trackStartupTask("扫描本地 Skill", () => window.aimashiLoaders.loadSkills())
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

document.getElementById("groupInfoButton")?.addEventListener("click", () => {
  const roomId = window.aimashiSocial?.getActiveRoomId?.();
  if (roomId) window.aimashiGroupInfoDialog?.open(roomId);
});

els.openSettings.addEventListener("click", () => {
  state.settingsOpen = true;
  if (state.activeSettingsTab === "profile") state.activeSettingsTab = "appearance";
  renderView();
  if (state.activeSettingsTab === "account") {
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
  if (state.messageContextMenu.open) window.aimashiMessageMenu?.closeMessageContextMenu();
  window.aimashiComposer.closeComposerAddMenu();
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
  if (state.messageContextMenu.open && !els.messageContextMenu?.contains(event.target)) window.aimashiMessageMenu?.closeMessageContextMenu();
});
// Left/right click on cloud-room avatars → contact card / quick menu.
els.chat?.addEventListener("click", (event) => {
  const avatarEl = event.target.closest(".message-avatar[data-sender-kind][data-sender-ref]");
  if (!avatarEl || !els.chat.contains(avatarEl)) return;
  const kind = avatarEl.dataset.senderKind;
  const ref = avatarEl.dataset.senderRef;
  if (!kind || !ref) return;
  const roomId = window.aimashiSocial?.getActiveRoomId?.();
  event.stopPropagation();
  window.aimashiContactCard?.openCard({ kind, ref, roomId, anchor: avatarEl });
});
els.chat?.addEventListener("contextmenu", (event) => {
  const avatarEl = event.target.closest(".message-avatar[data-sender-kind][data-sender-ref]");
  if (avatarEl && els.chat.contains(avatarEl)) {
    const kind = avatarEl.dataset.senderKind;
    const ref = avatarEl.dataset.senderRef;
    if (!kind || !ref) return;
    const roomId = window.aimashiSocial?.getActiveRoomId?.();
    event.preventDefault();
    event.stopPropagation();
    window.aimashiContactCard?.openContextMenu({ kind, ref, roomId, anchor: avatarEl, x: event.clientX, y: event.clientY });
    return;
  }
  const bubble = event.target.closest(".bubble[data-message-index]");
  if (!bubble || !els.chat.contains(bubble)) return;
  // Cloud-room bubbles (cloud DM + cloud group) carry data-message-source +
  // data-message-id and live in social.moduleState.messageCache, not the
  // fellow session, so dispatch to the lightweight social message menu.
  if (bubble.dataset.messageSource === "cloud-room") {
    const social = window.aimashiSocial;
    const messageId = bubble.dataset.messageId;
    if (!social || !messageId) return;
    const roomId = social.getActiveRoomId?.();
    const cache = roomId ? social.moduleState?.messageCache?.get?.(roomId) : null;
    const message = cache?.messages?.find?.((m) => m.id === messageId);
    if (!message) return;
    event.preventDefault();
    event.stopPropagation();
    window.aimashiSocialMessageMenu?.openSocialMessageMenu(message, event.clientX, event.clientY);
    return;
  }
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
  if (!state.contactMenuOpen) return;
  if (els.contactCreateMenu?.contains(event.target) || els.newContact?.contains(event.target)) return;
  state.contactMenuOpen = false;
  renderView();
});
document.addEventListener("click", (event) => {
  if (!state.composerAddMenuOpen) return;
  if (els.composerAddMenu?.contains(event.target) || els.skillPicker?.contains(event.target) || els.composerAdd?.contains(event.target)) return;
  window.aimashiComposer.closeComposerAddMenu();
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
    if (button.dataset.view === "skills" && !state.skillLibrary.skills.length && !state.skillsLoading) window.aimashiLoaders.loadSkills();
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
    if (state.activeSettingsTab === "account") {
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
    window.aimashiSocial?.bootstrapAfterLogin?.();
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
    window.aimashiSocial?.handleCloudEvent?.(envelope);
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
    await window.aimashiLoaders.loadModelCatalog();
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


els.newPersona.addEventListener("click", (event) => {
  event.stopPropagation();
  state.fellowMenuOpen = !state.fellowMenuOpen;
  renderView();
});

els.convMenuAddFriend?.addEventListener("click", () => {
  state.fellowMenuOpen = false;
  renderView();
  window.aimashiSocial?.openAddFriendDialog?.();
});
els.addFellow?.addEventListener("click", () => {
  state.fellowMenuOpen = false;
  renderView();
  window.aimashiFellowDialog.openFellowDialog();
});
els.convMenuNewGroup?.addEventListener("click", () => {
  state.fellowMenuOpen = false;
  renderView();
  window.aimashiSocial?.openCreateGroupDialog?.();
});
els.newContact?.addEventListener("click", (event) => {
  event.stopPropagation();
  state.contactMenuOpen = !state.contactMenuOpen;
  renderView();
});
els.contactMenuAddFriend?.addEventListener("click", () => {
  state.contactMenuOpen = false;
  renderView();
  window.aimashiSocial?.openAddFriendDialog?.();
});
els.contactMenuAddFellow?.addEventListener("click", () => {
  state.contactMenuOpen = false;
  renderView();
  window.aimashiFellowDialog.openFellowDialog();
});
els.contactMenuNewGroup?.addEventListener("click", () => {
  state.contactMenuOpen = false;
  renderView();
  window.aimashiSocial?.openCreateGroupDialog?.();
});
els.userAvatar?.addEventListener("click", () => window.aimashiFellowDialog.openProfileDialog());
els.userAvatar?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  window.aimashiFellowDialog.openProfileDialog();
});
els.closeProfileDialog?.addEventListener("click", () => window.aimashiFellowDialog.closeProfileDialog());
els.cancelProfile?.addEventListener("click", () => window.aimashiFellowDialog.closeProfileDialog());
els.closeFellowDialog?.addEventListener("click", () => window.aimashiFellowDialog.closeFellowDialog());
els.cancelFellow?.addEventListener("click", () => window.aimashiFellowDialog.closeFellowDialog());
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
  window.aimashiFellowDialog.readFellowAvatarFile(els.fellowAvatarFile.files?.[0]);
  els.fellowAvatarFile.value = "";
});
els.fellowAvatarPreview?.addEventListener("click", () => {
  const draft = state.fellowAvatarDraft;
  if (!draft?.image) return;
  window.aimashiFellowDialog.openAvatarCropEditor(draft.image, draft.crop);
});
els.fellowAvatarPreview?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  const draft = state.fellowAvatarDraft;
  if (!draft?.image) return;
  window.aimashiFellowDialog.openAvatarCropEditor(draft.image, draft.crop);
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
  window.aimashiFellowDialog.readFellowAvatarFile(event.dataTransfer?.files?.[0]);
});
els.chooseProfileAvatar?.addEventListener("click", () => els.profileAvatarFile?.click());
els.profileAvatarFile?.addEventListener("change", () => {
  window.aimashiFellowDialog.readProfileAvatarFile(els.profileAvatarFile.files?.[0]);
  els.profileAvatarFile.value = "";
});
els.profileAvatarPreview?.addEventListener("click", () => {
  const draft = state.profileAvatarDraft;
  if (!draft?.image) {
    els.profileAvatarFile?.click();
    return;
  }
  window.aimashiFellowDialog.openAvatarCropEditor(draft.image, draft.crop, "profile");
});
els.profileAvatarPreview?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  const draft = state.profileAvatarDraft;
  if (!draft?.image) {
    els.profileAvatarFile?.click();
    return;
  }
  window.aimashiFellowDialog.openAvatarCropEditor(draft.image, draft.crop, "profile");
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
  window.aimashiFellowDialog.readProfileAvatarFile(event.dataTransfer?.files?.[0]);
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
  window.aimashiFellowDialog.updateAvatarCropEditor({
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
  window.aimashiFellowDialog.updateAvatarCropEditor({
    zoom: state.avatarCropEditor.crop.zoom + direction * 0.03
  });
});
els.confirmAvatarCrop?.addEventListener("click", async () => {
  if (state.avatarCropEditor.target === "groupRoom") {
    const image = state.avatarCropEditor.image;
    const crop = state.avatarCropEditor.crop;
    window.aimashiFellowDialog.closeAvatarCropEditor();
    window.aimashiGroupInfoDialog?.applyAvatarFromCropEditor(image, crop);
    return;
  }
  if (state.avatarCropEditor.target === "profile") {
    window.aimashiFellowDialog.setProfileAvatarDraft(state.avatarCropEditor.image, state.avatarCropEditor.crop);
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
    window.aimashiFellowDialog.setFellowAvatarDraft(state.avatarCropEditor.image, state.avatarCropEditor.crop);
  }
  window.aimashiFellowDialog.closeAvatarCropEditor();
});
els.cancelAvatarCrop?.addEventListener("click", () => window.aimashiFellowDialog.closeAvatarCropEditor());
els.resetAvatarCrop?.addEventListener("click", () => {
  state.avatarCropEditor.crop = window.aimashiAvatar.normalizeCrop(window.aimashiAvatar.avatarDefaultCropForSrc(state.avatarCropEditor.image));
  window.aimashiFellowDialog.renderAvatarCropEditor();
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
  window.aimashiFellowDialog.closeProfileDialog();
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
  if (window.aimashiMessageHelpers.isComposerComposing(event)) return;
  if (state.slashMenuOpen) {
    const commands = window.aimashiComposer.filteredSlashCommands();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.slashSelectedIndex = commands.length ? (state.slashSelectedIndex + 1) % commands.length : 0;
      window.aimashiComposer.renderSlashCommandMenu();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.slashSelectedIndex = commands.length ? (state.slashSelectedIndex - 1 + commands.length) % commands.length : 0;
      window.aimashiComposer.renderSlashCommandMenu();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const command = commands[state.slashSelectedIndex];
      if (command) {
        window.aimashiComposer.fillSlashCommand(command);
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const command = commands[state.slashSelectedIndex];
      if (command) window.aimashiComposer.sendSlashCommand(command);
      return;
    }
    if (event.key === "Escape") {
      state.slashMenuOpen = false;
      window.aimashiComposer.renderSlashCommandMenu();
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
  window.aimashiMessageHelpers.noteCompositionEnded();
  els.chatInput.dataset.composing = "false";
  window.aimashiMessageHelpers.resizeChatInput();
  window.aimashiComposer.updateSlashCommandState();
  renderSendButton();
});

els.chatInput.addEventListener("input", () => {
  window.aimashiMessageHelpers.resizeChatInput();
  window.aimashiComposer.updateSlashCommandState();
  renderSendButton();
});
els.chatInput.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  event.stopPropagation();
  window.aimashiComposer.closeComposerAddMenu();
  window.aimashiComposer.closeSkillPicker();
  els.chatInput.focus();
  window.aimashi?.showEditContextMenu?.({ x: event.clientX, y: event.clientY });
});
els.chatInput.addEventListener("click", () => window.aimashiComposer.updateSlashCommandState());
els.composerAdd?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  state.composerAddMenuOpen = !state.composerAddMenuOpen;
  state.slashMenuOpen = false;
  if (state.composerAddMenuOpen) window.aimashiComposer.closeSkillPicker();
  window.aimashiComposer.renderSlashCommandMenu();
  window.aimashiComposer.renderComposerAddMenu();
});
els.composerAddMenu?.addEventListener("click", (event) => {
  const action = event.target.closest("[data-composer-add]")?.dataset.composerAdd;
  if (!action) return;
  event.preventDefault();
  if (action === "attachment") {
    window.aimashiComposer.closeComposerAddMenu();
    els.composerAttachmentInput?.click();
    return;
  }
  if (action === "skill") {
    window.aimashiComposer.openSkillPicker();
    return;
  }
  els.chatInput?.focus();
});
els.composerAddMenu?.addEventListener("pointerover", (event) => {
  const action = event.target.closest("[data-composer-add]")?.dataset.composerAdd;
  if (action === "skill") {
    window.aimashiComposer.openSkillPicker();
    return;
  }
  if (action) window.aimashiComposer.scheduleSkillPickerHoverClose();
});
els.composerAddMenu?.addEventListener("pointerout", (event) => {
  const item = event.target.closest('[data-composer-add="skill"]');
  if (!item) return;
  if (window.aimashiComposer.targetIsSkillPickerZone(event.relatedTarget)) return;
  window.aimashiComposer.scheduleSkillPickerHoverClose();
});
els.skillPicker?.addEventListener("pointerenter", () => window.aimashiComposer.cancelSkillPickerHoverClose());
els.skillPicker?.addEventListener("pointerleave", (event) => {
  if (window.aimashiComposer.targetIsSkillPickerZone(event.relatedTarget)) return;
  window.aimashiComposer.scheduleSkillPickerHoverClose();
});

els.skillPickerSearch?.addEventListener("input", () => {
  state.skillPickerFilter = els.skillPickerSearch.value || "";
  window.aimashiComposer.renderSkillPicker();
});
els.closeSkillPicker?.addEventListener("click", () => window.aimashiComposer.closeSkillPicker());
els.skillPickerBody?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-skill-pick]");
  if (!button) return;
  window.aimashiComposer.insertSkillIntoComposer(button.dataset.skillPick);
  window.aimashiComposer.closeComposerAddMenu();
  window.aimashiComposer.closeSkillPicker();
});
els.skillPickerBody?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-skill-picker-plugin]");
  if (!button) return;
  state.skillPickerPluginId = button.dataset.skillPickerPlugin || "";
  state.skillPickerFilter = "";
  if (els.skillPickerSearch) els.skillPickerSearch.value = "";
  window.aimashiComposer.renderSkillPicker();
});
els.skillPickerBody?.addEventListener("pointerover", (event) => {
  const button = event.target.closest("[data-skill-picker-plugin]");
  if (!button || button.dataset.skillPickerPlugin === state.skillPickerPluginId) return;
  state.skillPickerPluginId = button.dataset.skillPickerPlugin || "";
  state.skillPickerFilter = "";
  if (els.skillPickerSearch) els.skillPickerSearch.value = "";
  window.aimashiComposer.renderSkillPicker();
});
els.skillPickerSearch?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.aimashiComposer.closeSkillPicker();
  if (event.key === "Enter") {
    event.preventDefault();
    const first = els.skillPickerBody?.querySelector("[data-skill-pick]");
    if (first) {
      window.aimashiComposer.insertSkillIntoComposer(first.dataset.skillPick);
      window.aimashiComposer.closeComposerAddMenu();
      window.aimashiComposer.closeSkillPicker();
    }
  }
});
document.addEventListener("click", (event) => {
  if (!state.skillPickerOpen) return;
  if (els.skillPicker?.contains(event.target)) return;
  if (els.composerAddMenu?.contains(event.target)) return;
  if (els.composerAdd?.contains(event.target)) return;
  window.aimashiComposer.closeSkillPicker();
});
els.composerAttachmentInput?.addEventListener("change", () => {
  window.aimashiComposer.addComposerFiles(els.composerAttachmentInput.files);
  els.composerAttachmentInput.value = "";
});
els.composerAttachments?.addEventListener("click", (event) => {
  if (event.target.closest("[data-attachment-remove]")) return;
  els.chatInput?.focus();
});
els.composerReply?.addEventListener("click", (event) => {
  if (!event.target.closest("[data-clear-reply]")) return;
  state.replyDraft = null;
  window.aimashiMessageHelpers.renderComposerReply();
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
  window.aimashiComposer.addComposerFiles(event.dataTransfer.files);
});
els.chatInput?.addEventListener("paste", (event) => {
  if (!event.clipboardData?.files?.length) return;
  window.aimashiComposer.addComposerFiles(event.clipboardData.files);
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
  const resumeButton = event.target.closest?.("[data-command-resume-id]");
  if (resumeButton && els.chat.contains(resumeButton)) {
    event.preventDefault();
    event.stopPropagation();
    const sessionIdToResume = String(resumeButton.dataset.commandResumeId || "").trim();
    if (!sessionIdToResume || resumeButton.disabled) return;
    const sourceDeviceId = String(resumeButton.dataset.commandSourceDeviceId || "").trim();
    const currentDeviceId = String(state.runtime?.relay?.deviceId || "").trim();
    if (sourceDeviceId && currentDeviceId && sourceDeviceId !== currentDeviceId) {
      appendTransientChat("assistant", "这条 /resume 列表来自另一台设备。请在当前设备重新发送 /resume，生成本机可恢复的 session 列表。");
      return;
    }
    const engine = resumeButton.dataset.commandResumeEngine || window.aimashiEngineOptions.activeAgentEngine();
    const fellow = activePersona() || { key: state.activeKey };
    resumeButton.disabled = true;
    resumeButton.classList.add("loading");
    try {
      const result = await window.aimashi.executeAgentCommand?.({
        engine,
        commandName: "/resume",
        args: [sessionIdToResume],
        context: {
          sessionId: activeSession()?.id || "",
          fellow
        }
      });
      const content = result?.content && typeof result.content === "object"
        ? result.content.content
        : result?.content;
      appendChat("assistant", String(content || "已切换外部会话。"), { persist: true });
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
  const message = window.aimashiMessageHelpers.messageAtIndex(Number(button.dataset.copyTranslation));
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
  if (window.aimashiMessageHelpers.isComposerComposing()) return;
  // Branch: a cloud room (dm / group / fellow) is active → send via social.
  if (window.aimashiSocial?.getActiveRoomId?.() && !state.activeKey) {
    const roomId = window.aimashiSocial.getActiveRoomId();
    const roomText = els.chatInput.value;
    if (!roomText.trim()) return;
    els.chatInput.value = "";
    window.aimashiMessageHelpers.resizeChatInput();
    const activeRoomRecord = window.aimashiSocial.getRoomById?.(roomId);
    const recordType = activeRoomRecord?.type
      || (roomId.startsWith("dm:") ? "dm"
        : roomId.startsWith("fellow:") ? "fellow"
        : (roomId.startsWith("g_") || roomId.startsWith("g-")) ? "group"
        : null);
    const isGroupRoom = recordType === "group";
    if (isGroupRoom && typeof window.aimashiSocial.sendInActiveGroupRoom === "function") {
      await window.aimashiSocial.sendInActiveGroupRoom(roomText);
    } else {
      await window.aimashiSocial.sendInActiveRoom(roomText);
    }
    return;
  }
  if (state.isGenerating) {
    await window.aimashi.stopChat?.();
    return;
  }
  const replyTo = state.replyDraft ? { ...state.replyDraft } : null;
  const fellows = state.runtime?.fellows || state.runtime?.personas || [];
  const activeFellow = fellows.find((p) => p.key === state.activeKey) || null;
  let prepared;
  try {
    prepared = prepareOutgoingMessage(
      {
        text: els.chatInput.value,
        attachments: state.pendingAttachments,
        replyTo
      },
      {
        members: activeFellow
          ? [{ kind: MemberKind.Fellow, ref: activeFellow.key, name: activeFellow.name || activeFellow.key }]
          : []
      }
    );
  } catch (err) {
    if (err && err.code === "EMPTY_MESSAGE") return;
    throw err;
  }
  const text = prepared.bodyMd;
  const attachments = prepared.attachments;
  const session = activeSession();
  const shouldGenerateTitle = !session.titleGenerated && !hasSuccessfulExchange(session);
  els.chatInput.value = "";
  state.pendingAttachments = [];
  state.replyDraft = null;
  window.aimashiMessageHelpers.renderComposerReply();
  window.aimashiComposer.renderComposerAttachments();
  window.aimashiMessageHelpers.resizeChatInput();
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
    const outgoingBase = await window.aimashiComposer.outgoingMessageForSubmit(text);
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
    const responseCommandResult = responseMessage.commandResult || response.aimashi?.commandResult || null;
    const answer = responseMessage.content || (responseAttachments.length ? "" : "(No response)");
    const traceSnapshot = state.streaming
      ? { reasoning: state.streaming.reasoning || "", tools: state.streaming.tools.slice() }
      : { reasoning: "", tools: [] };
    state.streaming = null;
    appendChat("assistant", answer, { reasoning: traceSnapshot.reasoning, tools: traceSnapshot.tools, attachments: responseAttachments, commandResult: responseCommandResult });
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
      await window.aimashiLoaders.loadModelCatalog();
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
  if (typeof window.aimashiFellowDialog?.openFellowDialog === "function") {
    window.aimashiFellowDialog.openFellowDialog(null, seed);
  } else {
    // Fallback: at least open settings
    state.settingsOpen = true;
    state.activeSettingsTab = "model";
    renderView();
  }
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

window.aimashiMessageHelpers.resizeChatInput();
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
