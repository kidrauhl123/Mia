// Mia Web — chat + settings only.
// Conversation list = cloud DM, group conversations, and cloud-mirrored bot conversations.

const STORAGE_KEY = "mia.web.session";
const API_BASE = "";
const { formatConversationTime, formatMessageTime } = window.miaTimeFormat;
const { computeUnreadForConversation, totalUnreadFromConversations, unreadBadgeHtml } = window.miaUnread;
const { prepareOutgoingMessage } = window.miaSendPipeline;
const { MemberKind, SenderKind } = window.miaConversationKinds;
const sessionHistory = window.miaSessionHistory || {};
const botRuntimeControl = window.miaBotRuntimeControl || {};
const assistantContentBlocks = window.miaAssistantContentBlocks || {};
const conversationTagsApi = window.miaConversationTags || {
  defaultConversationTags: () => ({ items: [], assignments: {} }),
  normalizeConversationTags: (value) => value && typeof value === "object" ? value : { items: [], assignments: {} },
  tagsForTarget: () => [],
  assignTagNames: (tags) => tags && typeof tags === "object" ? tags : { items: [], assignments: {} }
};
const engineContracts = window.miaEngineContracts || {};
const agentEnginePolicy = window.miaAgentEnginePolicy || {};
const normalizeAgentEngine = engineContracts.normalizeAgentEngine || ((value) => {
  const id = String(value || "hermes").trim().toLowerCase().replace(/_/g, "-");
  if (id === "claude" || id === "claude-code") return "claude-code";
  if (id === "codex" || id === "openai-codex") return "codex";
  if (id === "openclaw" || id === "open-claw") return "openclaw";
  return "hermes";
});
const engineLabel = engineContracts.engineLabel || ((value) => {
  const engine = normalizeAgentEngine(value);
  if (engine === "claude-code") return "Claude Code";
  if (engine === "codex") return "Codex";
  if (engine === "openclaw") return "OpenClaw";
  return "Hermes";
});
const CHAT_SCROLL_STICK_THRESHOLD_PX = 80;
const MESSAGE_TAIL_ENTER_ANIMATION_MS = 220;

function isExternalAgentEngine(value) {
  const engine = normalizeAgentEngine(value);
  if (typeof agentEnginePolicy.enginePermissionStoreTarget === "function") {
    return agentEnginePolicy.enginePermissionStoreTarget(engine) === "engine-map";
  }
  if (typeof engineContracts.isExternalEngine === "function") return engineContracts.isExternalEngine(engine);
  return engine !== "hermes";
}

function isDesktopExternalRuntime(engine, runtimeKind) {
  return runtimeKind === "desktop-local" && isExternalAgentEngine(engine);
}

function isValidPublicUid(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (window.miaIds && typeof window.miaIds.isPublicId === "function") {
    return window.miaIds.isPublicId(text);
  }
  return /^[1-9][0-9]{5,11}$/.test(text);
}

function externalModelEntries(value) {
  if (engineContracts.externalModelEntries) {
    return engineContracts.externalModelEntries(value, {
      engineCapabilities: state?.engineCapabilities,
      platformModels: state?.platformModels
    });
  }
  const engine = normalizeAgentEngine(value);
  if (engine === "claude-code") return [{ id: "default", provider: "claude-code", providerLabel: "Claude Code", model: "", label: "Claude Code 默认" }];
  if (engine === "codex") return [{ id: "default", provider: "codex", providerLabel: "Codex CLI", model: "", label: "Codex 默认" }];
  return [];
}

function effortOptions(value) {
  if (engineContracts.effortOptions) {
    return engineContracts.effortOptions(value, {
      engineCapabilities: state?.engineCapabilities,
      effortLabels: { off: "Off", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", adaptive: "Adaptive", max: "Max" }
    });
  }
  const engine = normalizeAgentEngine(value);
  if (isExternalAgentEngine(engine)) return [{ value: "medium", label: "Medium" }];
  return ["low", "medium", "high"].map((level) => ({ value: level, label: level[0].toUpperCase() + level.slice(1) }));
}

function externalPermissionOptions(value) {
  if (engineContracts.externalPermissionOptions) {
    return engineContracts.externalPermissionOptions(value, { engineCapabilities: state?.engineCapabilities });
  }
  const engine = normalizeAgentEngine(value);
  if (engine === "claude-code") return [{ value: "default", label: "Ask Permissions" }];
  if (engine === "codex" || engine === "openclaw") return [{ value: "default", label: "Ask" }];
  return [{ value: "ask", label: "Ask" }];
}

const els = {
  root: document.querySelector(".app-shell"),
  loginView: document.getElementById("loginView"),
  mainView: document.getElementById("mainView"),
  loginForm: document.getElementById("loginForm"),
  loginHint: document.getElementById("loginHint"),

  conversationSearch: document.getElementById("conversationSearch"),
  conversationList: document.getElementById("conversationList"),
  newConversation: document.getElementById("newConversation"),
  conversationCreateMenu: document.getElementById("conversationCreateMenu"),
  convMenuAddFriend: document.getElementById("convMenuAddFriend"),
  convMenuNewGroup: document.getElementById("convMenuNewGroup"),
  convMenuNewBot: document.getElementById("convMenuNewBot"),
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
  profileNameText: document.getElementById("profileNameText"),
  profileDisplayName: document.getElementById("profileDisplayName"),
  profileStatusBadge: document.getElementById("profileStatusBadge"),
  profileStatusBadgeDetails: document.getElementById("profileStatusBadgeDetails"),
  profileStatusBadgeTrigger: document.getElementById("profileStatusBadgeTrigger"),
  appearanceTheme: document.getElementById("appearanceTheme"),
  appearanceAccentColor: document.getElementById("appearanceAccentColor"),
  appearanceUserBubbleColor: document.getElementById("appearanceUserBubbleColor"),
  appearanceShowUserAvatar: document.getElementById("appearanceShowUserAvatar"),
  appearanceShowAssistantAvatar: document.getElementById("appearanceShowAssistantAvatar"),

  toast: document.getElementById("toast"),
};

const ANIMATED_TEXT_IDS = new Set([
  "activeMeta",
  "currentSessionTitle"
]);
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

function animatedTextOptions(el) {
  const id = el?.id || "";
  if (id === "currentSessionTitle") return { direction: "up", stagger: 18, duration: 240 };
  return { direction: "up", stagger: 14, duration: 220 };
}

function setAnimatedText(el, value, options = {}) {
  if (!el) return;
  const text = String(value ?? "");
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
    window.miaSlotText.set(el, text, { ...animatedTextOptions(el), ...options });
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
  el.textContent = String(value ?? "");
}

let state = {
  token: "",
  user: null,
  theme: "light",
  conversations: [],
  friends: [],
  // Cloud-mirrored bot identities. Populated from /api/me/bots on login and
  // kept in sync via bot.upserted / bot.deleted WS events.
  bots: [],
  // Cross-device user settings (Phase 3). Holds pins + read marks +
  // appearance + user-private conversation tags. Populated from /api/me/settings on bootstrap; updated
  // optimistically via pushSettings() + reconciled by
  // user_settings.updated WS events. Replaces the previous localStorage-
  // backed _pinnedConversations set.
  settings: defaultWebSettings(),
  incomingRequests: [],
  outgoingRequests: [],
  messageCache: new Map(),
  conversationMembersCache: new Map(),
  // (Phase 4 cutover: state.workspace removed. Every conversation now
  //  lives in state.conversations — bot chats are conversations-of-type-bot.)
  bridgeDevices: [],
  bridgeBusy: false,
  cloudAgentRuntime: null,
  cloudAgentRunsByConversation: new Map(),
  botRuntimeCache: new Map(),
  platformModels: [],
  activeConversationId: "",
  lastRenderedConversationId: "",
  lastRenderedConversationMessageIds: [],
  lastRenderedConversationMessageCount: 0,
  // Per-conversation unread counters. Incremented when a WS message arrives
  // for a non-active conversation, cleared when the user opens it. In-memory
  // only for v1 — survives until reload.
  unread: new Map(),
  settingsOpen: false,
  activeSettingsTab: "account",
  createMenuOpen: false,
  sessionMenuOpen: false,
  // Per-row open/closed memory for trace blocks (reasoning + tool cards) so
  // expansion state survives re-renders. Same shape as desktop state — see
  // src/shared/trace-blocks.js + renderer/app.js trace toggle handler.
  openTraceKeys: new Set(),
  animatedTraceKeys: new Set(),
};
const pendingConversationMemberFetches = new Set();

let eventsSocket = null;
let eventsReconnectTimer = 0;
let eventsReconnectAttempts = 0;
let cloudRunTextSmoother = null;
const chatScrollIntents = new WeakMap();

// ── helpers ────────────────────────────────────────────────────────────────

function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
}

function chatBottomGap(chatEl) {
  if (!chatEl) return 0;
  const scrollHeight = Number(chatEl.scrollHeight) || 0;
  const scrollTop = Number(chatEl.scrollTop) || 0;
  const clientHeight = Number(chatEl.clientHeight) || 0;
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

function isChatNearBottom(chatEl) {
  return chatBottomGap(chatEl) < CHAT_SCROLL_STICK_THRESHOLD_PX;
}

function installChatScrollIntentTracker(chatEl) {
  if (!chatEl) return null;
  let intent = chatScrollIntents.get(chatEl);
  if (!intent) {
    intent = {
      installed: false,
      lastScrollTop: Number(chatEl.scrollTop) || 0,
      userMovedAwayFromBottom: false
    };
    chatScrollIntents.set(chatEl, intent);
  }
  if (intent.installed || typeof chatEl.addEventListener !== "function") return intent;
  intent.installed = true;
  chatEl.addEventListener("scroll", () => {
    const currentTop = Number(chatEl.scrollTop) || 0;
    const previousTop = Number(intent.lastScrollTop) || 0;
    if (chatBottomGap(chatEl) <= 1) {
      intent.userMovedAwayFromBottom = false;
    } else if (currentTop < previousTop - 1) {
      intent.userMovedAwayFromBottom = true;
    }
    intent.lastScrollTop = currentTop;
  }, { passive: true });
  return intent;
}

function markChatProgrammaticBottom(chatEl) {
  const intent = installChatScrollIntentTracker(chatEl);
  if (!intent) return;
  intent.userMovedAwayFromBottom = false;
  intent.lastScrollTop = Number(chatEl.scrollTop) || 0;
}

function scrollChatToBottom(chatEl) {
  if (!chatEl) return;
  chatEl.scrollTop = chatEl.scrollHeight;
  markChatProgrammaticBottom(chatEl);
}

function isChatPinnedToBottom(chatEl) {
  if (!chatEl) return false;
  const intent = installChatScrollIntentTracker(chatEl);
  if (chatBottomGap(chatEl) <= 1) {
    if (intent) intent.userMovedAwayFromBottom = false;
    return true;
  }
  return !intent?.userMovedAwayFromBottom && isChatNearBottom(chatEl);
}

function messageStableId(message) {
  return String(message?.id || message?.seq || message?.created_at || message?.createdAt || "");
}

function messageStableIds(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map(messageStableId)
    .filter(Boolean);
}

function tailMessageIdsAddedToEnd(previousIds = [], nextIds = []) {
  if (!previousIds.length || nextIds.length <= previousIds.length) return [];
  for (let i = 0; i < previousIds.length; i += 1) {
    if (previousIds[i] !== nextIds[i]) return [];
  }
  return nextIds.slice(previousIds.length);
}

function addElementClass(el, className) {
  if (!el || !className) return;
  const classes = new Set(String(el.className || "").split(/\s+/).filter(Boolean));
  classes.add(className);
  el.className = Array.from(classes).join(" ");
  try { el.classList?.add?.(className); } catch {}
}

function removeElementClass(el, className) {
  if (!el || !className) return;
  el.className = String(el.className || "")
    .split(/\s+/)
    .filter((item) => item && item !== className)
    .join(" ");
  try { el.classList?.remove?.(className); } catch {}
}

function animateMessageTailEnter(article) {
  if (!article || prefersReducedMotion()) return false;
  addElementClass(article, "message-tail-enter");
  const cleanup = () => {
    removeElementClass(article, "message-tail-enter");
    article.removeEventListener?.("animationend", cleanup);
  };
  article.addEventListener?.("animationend", cleanup, { once: true });
  setTimeout(cleanup, MESSAGE_TAIL_ENTER_ANIMATION_MS + 80);
  return true;
}

function animateChatTailToBottom(chatEl, _startBottomGap = 0) {
  if (!chatEl) return;
  scrollChatToBottom(chatEl);
}

function animateRenderedTailMessages(chatEl, tailMessageIds = [], startBottomGap = 0) {
  if (!chatEl || !tailMessageIds.length) return;
  const ids = new Set(tailMessageIds.map(String));
  chatEl.querySelectorAll?.(".message[data-message-id]").forEach((article) => {
    if (ids.has(String(article.getAttribute("data-message-id") || ""))) animateMessageTailEnter(article);
  });
  animateChatTailToBottom(chatEl, startBottomGap);
}

function resetActiveChatRenderMemory() {
  state.lastRenderedConversationId = "";
  state.lastRenderedConversationMessageIds = [];
  state.lastRenderedConversationMessageCount = 0;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function defaultWebSettings() {
  return { pins: [], readMarks: {}, appearance: {}, tags: conversationTagsApi.defaultConversationTags(), version: 0, updatedAt: "" };
}

function normalizeWebSettings(settings, previous = {}) {
  const input = settings && typeof settings === "object" ? settings : {};
  const prior = previous && typeof previous === "object" ? previous : {};
  return {
    pins: Array.isArray(input.pins) ? input.pins : (Array.isArray(prior.pins) ? prior.pins : []),
    readMarks: input.readMarks && typeof input.readMarks === "object" ? input.readMarks : (prior.readMarks && typeof prior.readMarks === "object" ? prior.readMarks : {}),
    appearance: input.appearance && typeof input.appearance === "object" ? input.appearance : (prior.appearance && typeof prior.appearance === "object" ? prior.appearance : {}),
    tags: input.tags !== undefined
      ? conversationTagsApi.normalizeConversationTags(input.tags)
      : conversationTagsApi.normalizeConversationTags(prior.tags || conversationTagsApi.defaultConversationTags()),
    version: Number.isFinite(Number(input.version)) ? Number(input.version) : (Number(prior.version) || 0),
    updatedAt: input.updatedAt || input.updated_at || prior.updatedAt || ""
  };
}

function safeStatusBadgeAssetId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : "";
}

function normalizeStatusBadge(input) {
  if (!input || typeof input !== "object") return null;
  const kind = String(input.kind || "").trim();
  const label = String(input.label || "").trim();
  if (kind === "emoji") {
    const emoji = String(input.emoji || "").trim();
    return emoji ? { kind, emoji, label } : null;
  }
  if (kind === "lottie" || kind === "gift") {
    const assetId = String(input.assetId || input.asset_id || "").trim();
    if (!assetId) return null;
    if (kind === "lottie" && !safeStatusBadgeAssetId(assetId)) return null;
    const collectibleId = kind === "gift" ? String(input.collectibleId || input.collectible_id || "").trim() : "";
    return { kind, assetId, collectibleId, label };
  }
  return null;
}

function statusBadgeFrom(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    if (Object.prototype.hasOwnProperty.call(source, "statusBadge")) return source.statusBadge;
    if (Object.prototype.hasOwnProperty.call(source, "status_badge")) return source.status_badge;
  }
  return undefined;
}

function statusBadgeForPreset(value) {
  return window.miaStatusBadgeAssets?.statusBadgeForValue?.(value) || null;
}

function statusBadgePresetValue(badge) {
  return window.miaStatusBadgeAssets?.statusBadgeValue?.(badge) || "";
}

function statusBadgeAssetUrl(assetId) {
  const id = safeStatusBadgeAssetId(assetId);
  if (!id) return "";
  return window.miaStatusBadgeAssets?.statusBadgeAssetUrl?.(id, { baseUrl: API_BASE }) || `/api/status-badge-assets/${encodeURIComponent(id)}.json`;
}

function renderStatusBadgeHtml(statusBadge) {
  const badge = normalizeStatusBadge(statusBadge);
  if (!badge) return "";
  const className = `name-with-badge-badge name-with-badge-badge-${badge.kind}`;
  const title = badge.label ? ` title="${escapeHtml(badge.label)}"` : "";
  if (badge.kind === "emoji") {
    return `<span class="${className}"${title}>${escapeHtml(badge.emoji)}</span>`;
  }
  const assetAttr = ` data-asset-id="${escapeHtml(badge.assetId)}"`;
  if (badge.kind === "lottie") {
    const assetId = safeStatusBadgeAssetId(badge.assetId);
    const url = statusBadgeAssetUrl(assetId);
    return `<span class="${className}"${title}${assetAttr}${assetId ? ` data-lottie="${escapeHtml(assetId)}" data-lottie-path="${escapeHtml(url)}" data-lottie-trigger="loop"` : ""} aria-hidden="true"></span>`;
  }
  const collectibleAttr = badge.collectibleId ? ` data-collectible-id="${escapeHtml(badge.collectibleId)}"` : "";
  return `<span class="${className}"${title}${assetAttr}${collectibleAttr} aria-hidden="true"></span>`;
}

function renderNameWithBadgeHtml({ name, identity, statusBadge } = {}) {
  const badge = typeof statusBadge !== "undefined" ? statusBadge : statusBadgeFrom(identity);
  return `<span class="name-with-badge"><span class="name-with-badge-text">${escapeHtml(name || identity?.displayName || identity?.display_name || "未知")}</span>${renderStatusBadgeHtml(badge)}</span>`;
}

const statusBadgeLottieRegistry = new Map();

function sweepStatusBadgeLotties() {
  for (const [container, anim] of statusBadgeLottieRegistry) {
    if (!container.isConnected) {
      try { anim.destroy(); } catch { /* best effort */ }
      statusBadgeLottieRegistry.delete(container);
    }
  }
}

function initStatusBadgeLotties(root = document) {
  if (!window.lottie) return;
  sweepStatusBadgeLotties();
  root.querySelectorAll?.(".name-with-badge-badge-lottie[data-lottie]").forEach((container) => {
    if (statusBadgeLottieRegistry.has(container)) return;
    const path = container.dataset.lottiePath || statusBadgeAssetUrl(container.dataset.lottie);
    if (!path) return;
    const anim = window.lottie.loadAnimation({
      container,
      renderer: "svg",
      loop: true,
      autoplay: true,
      path
    });
    statusBadgeLottieRegistry.set(container, anim);
  });
}

function emojiAvatarHtml(image = "") {
  const glyph = avatarResolve.emojiAvatarGlyph?.(image) || "";
  return glyph ? `<span class="avatar-emoji" aria-hidden="true">${escapeHtml(glyph)}</span>` : "";
}

function syncProfileNameText() {
  if (!els.profileNameText || !els.profileDisplayName) return;
  els.profileNameText.textContent = els.profileDisplayName.value.trim() || state.user?.displayName || state.user?.username || "Mia";
}

function renderStatusBadgeGlyph(target, badge) {
  if (!target) return;
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
    const assetId = safeStatusBadgeAssetId(badge.assetId);
    if (!assetId) {
      target.classList.add("empty");
      renderEmptyStatusBadgeGlyph(target);
      return;
    }
    target.innerHTML = `<span class="name-with-badge-badge name-with-badge-badge-lottie" data-asset-id="${escapeHtml(assetId)}" data-lottie="${escapeHtml(assetId)}" data-lottie-path="${escapeHtml(statusBadgeAssetUrl(assetId))}" data-lottie-trigger="loop" aria-hidden="true"></span>`;
    initStatusBadgeLotties(target);
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

function renderStatusBadgeChoiceContent(choice) {
  if (!choice?.badge) return `<span class="identity-badge-choice-empty">无</span>`;
  const badge = choice.badge;
  if (badge.kind === "emoji") return `<span class="identity-badge-choice-emoji">${escapeHtml(badge.emoji || "")}</span>`;
  return renderStatusBadgeHtml(badge);
}

function statusBadgeChoiceButtonsHtml(attributeName, target = "") {
  return statusBadgeChoices().map((choice) => {
    const targetAttr = target ? ` data-status-badge-target="${escapeHtml(target)}"` : "";
    const label = choice.value ? `${choice.label || choice.value}徽章` : "无徽章";
    return `<button type="button" ${attributeName}="${escapeHtml(choice.value || "")}"${targetAttr} aria-label="${escapeHtml(label)}">${renderStatusBadgeChoiceContent(choice)}</button>`;
  }).join("");
}

function renderProfileStatusBadgeChoices() {
  const select = els.profileStatusBadge;
  const panel = els.profileStatusBadgeDetails?.querySelector?.(".identity-badge-choices");
  const key = statusBadgeChoices().map((choice) => `${choice.value}:${choice.kind}:${choice.label}`).join("|");
  if (select && select.dataset.statusBadgeCatalogKey !== key) {
    const value = select.value || "";
    select.innerHTML = statusBadgeChoices().map((choice) => `<option value="${escapeHtml(choice.value || "")}">${escapeHtml(choice.label || "无")}</option>`).join("");
    select.value = statusBadgeChoices().some((choice) => choice.value === value) ? value : "";
    select.dataset.statusBadgeCatalogKey = key;
  }
  if (panel && panel.dataset.statusBadgeCatalogKey !== key) {
    panel.innerHTML = statusBadgeChoiceButtonsHtml("data-status-badge-choice", "profile");
    panel.dataset.statusBadgeCatalogKey = key;
    initStatusBadgeLotties(panel);
  }
}

function syncProfileStatusBadgeControl() {
  if (!els.profileStatusBadge || !els.profileStatusBadgeTrigger) return;
  renderProfileStatusBadgeChoices();
  renderStatusBadgeGlyph(els.profileStatusBadgeTrigger, statusBadgeForPreset(els.profileStatusBadge.value));
  document.querySelectorAll("[data-status-badge-choice]").forEach((button) => {
    button.classList.toggle("active", button.dataset.statusBadgeChoice === els.profileStatusBadge.value);
  });
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
    initStatusBadgeLotties(details);
  });
}

document.querySelectorAll(".identity-badge-details").forEach(bindStatusBadgeDetailsDismissal);

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
  const normalized = window.miaAvatarResolve?.normalizeAvatarImage
    ? window.miaAvatarResolve.normalizeAvatarImage(value)
    : String(value || "").trim();
  return /^(https?:|data:|\.?\/assets\/|\/api\/files\/)/i.test(String(normalized || ""));
}

// Avatar URLs stored on cloud sometimes use a desktop-bundle-relative form.
// Current bundled avatar presets are legacy and normalize to empty; real
// non-avatar assets still get rewritten to root-served "/assets/..." paths.
// data: URLs, http(s):// and root-relative paths are passed through untouched.
function normalizeAvatarUrl(value) {
  const src = window.miaAvatarResolve?.normalizeAvatarImage
    ? window.miaAvatarResolve.normalizeAvatarImage(value)
    : String(value || "").trim();
  if (!src) return "";
  if (/^(https?:\/\/|data:|\/\/)/i.test(src)) return src;
  if (src.startsWith("/")) return src;
  if (src.startsWith("./")) return src.slice(1); // "./assets/x" → "/assets/x"
  if (src.startsWith("assets/")) return `/${src}`;
  return src;
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

function attachmentExtension(attachment = {}) {
  const value = String(attachment.name || attachment.filename || attachment.path || attachment.url || "").trim().toLowerCase();
  const match = value.match(/\.([a-z0-9]+)(?:[?#].*)?$/);
  return match ? match[1] : "";
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
  const mime = String(attachment.mimeType || attachment.mime || attachment.type || "").toLowerCase();
  const ext = attachmentExtension(attachment);
  const kind = attachment.kind || attachmentKind(attachment);
  if (kind === "image") return "IMG";
  if (kind === "video") return "VID";
  if (kind === "audio") return "AUD";
  if (kind === "pdf" || mime.includes("pdf") || ext === "pdf") return "PDF";
  if (mime.includes("spreadsheet") || mime === "application/vnd.ms-excel" || ["xls", "xlsx", "xlsm"].includes(ext)) return "XLS";
  if (mime.includes("wordprocessingml") || mime === "application/msword" || ["doc", "docx"].includes(ext)) return "DOC";
  if (mime.includes("presentationml") || mime === "application/vnd.ms-powerpoint" || ["ppt", "pptx"].includes(ext)) return "PPT";
  if (mime.includes("zip") || ext === "zip") return "ZIP";
  if (mime.includes("json") || ext === "json") return "JSON";
  if (ext === "csv") return "CSV";
  if (ext === "tsv") return "TSV";
  if (["md", "markdown"].includes(ext)) return "MD";
  if (["html", "css", "js", "jsx", "ts", "tsx", "py"].includes(ext)) return "CODE";
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

// Avatar crop/media helpers: shared module so web and desktop never drift
// apart on "what avatar does this member have." Missing avatars stay empty
// and render as color + two-character text.
const avatarResolve = window.miaAvatarResolve;
const webNormalizeAvatarCrop = avatarResolve.normalizeAvatarCrop;

// Web-side wrapper: shared/avatar-resolve.js doesn't branch on "is this a
// video?" (video trim handling is platform-specific), so we keep the video
// branch local and delegate the still-image case to the shared resolver.
function webAvatarDefaultCropForSrc(src) {
  if (avatarMedia.isVideo?.(src)) {
    return { x: 50, y: 50, zoom: 1, start: 0, duration: avatarMedia.DEFAULT_TRIM_DURATION || 3 };
  }
  return avatarResolve.avatarDefaultCropForSrc(src);
}

function avatarBackgroundStyle(image, customCrop, fallbackColor) {
  if (!image) return `background-color:${fallbackColor};color:#fff;display:inline-flex;align-items:center;justify-content:center;`;
  if (avatarMedia.isVideo?.(image)) return "background-color:transparent;";
  // Normalize legacy bundled-preset paths to empty before producing the
  // actual background-image declaration.
  const src = normalizeAvatarUrl(image);
  const crop = avatarResolve.avatarCropForImage(image, customCrop);
  const x = Number.isFinite(Number(crop.x)) ? Number(crop.x) : 50;
  const y = Number.isFinite(Number(crop.y)) ? Number(crop.y) : 50;
  const zoom = Number.isFinite(Number(crop.zoom)) ? Number(crop.zoom) : 1;
  const size = Math.round(zoom * 100);
  return `background-color:transparent;background-image:url('${src}');background-size:${size}%;background-position:${x}% ${y}%;background-repeat:no-repeat;`;
}

function avatarVideoStyle(crop = {}) {
  const x = Number.isFinite(Number(crop?.x)) ? Number(crop.x) : 50;
  const y = Number.isFinite(Number(crop?.y)) ? Number(crop.y) : 50;
  const zoom = Number.isFinite(Number(crop?.zoom)) ? Number(crop.zoom) : 1;
  return `object-position:${x}% ${y}%;transform:scale(${zoom});transform-origin:${x}% ${y}%;`;
}

function avatarVideoHtml(image, crop = {}) {
  const trim = avatarMedia.trimFromCrop?.(crop) || { start: 0, duration: 3 };
  const src = normalizeAvatarUrl(image);
  return `<video class="avatar-video" src="${escapeHtml(src)}" muted loop autoplay playsinline aria-hidden="true" data-avatar-start="${escapeHtml(trim.start)}" data-avatar-duration="${escapeHtml(trim.duration)}" style="${avatarVideoStyle(crop)}"></video>`;
}

function removeAvatarVideos(el) {
  el.querySelectorAll?.(".avatar-video")?.forEach((node) => node.remove());
}

function removeAvatarEmojis(el) {
  el.querySelectorAll?.(".avatar-emoji")?.forEach((node) => node.remove());
}

function generatedAvatarStyle(color = "#5e5ce6", text = "") {
  const image = avatarResolve.generatedAvatarDataUri?.(color || "#5e5ce6", text || "");
  if (!image) return `background-color:${color};color:#fff;display:inline-flex;align-items:center;justify-content:center;`;
  return `background-color:transparent;background-image:url('${escapeHtml(image)}');background-size:cover;background-position:center;background-repeat:no-repeat;`;
}

function emojiAvatarStyle(color = "#5e5ce6") {
  return `background-color:${escapeHtml(color || "#5e5ce6")};`;
}

function avatarHtml({ className = "avatar", image = "", crop = null, color = "#5e5ce6", text = "", attrs = "" } = {}) {
  if (avatarResolve.isEmojiAvatar?.(image)) {
    return `<span class="${escapeHtml(className)}" ${attrs} style="${emojiAvatarStyle(color)}">${emojiAvatarHtml(image)}</span>`;
  }
  const useAvatar = image && isPublicImageSrc(image);
  if (useAvatar && avatarMedia.isVideo?.(image)) {
    return `<span class="${escapeHtml(className)}" ${attrs} style="background-color:transparent;">${avatarVideoHtml(image, crop || {})}</span>`;
  }
  const style = useAvatar
    ? avatarBackgroundStyle(image, crop, color)
    : generatedAvatarStyle(color, text);
  return `<span class="${escapeHtml(className)}" ${attrs} style="${style}"></span>`;
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
  removeAvatarVideos(el);
  removeAvatarEmojis(el);
  if (avatarResolve.isEmojiAvatar?.(image)) {
    el.style.cssText = emojiAvatarStyle(color);
    el.textContent = "";
    el.insertAdjacentHTML("afterbegin", emojiAvatarHtml(image));
    return;
  }
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
  el.style.cssText = generatedAvatarStyle(color, text);
  el.textContent = "";
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
  const displayName = user.displayName || user.username || user.email || "Mia";
  const avatar = avatarResolve.resolveAvatarForContact({
    id: user.id || user.username || user.email || "self",
    displayName,
    avatarImage: user.avatarImage || "",
    avatarCrop: user.avatarCrop || null,
    color: user.avatarColor || user.avatar_color || user.color || ""
  });
  applyAvatarMedia(els.userAvatar, avatar.image, avatar.crop, avatar.color, avatar.text);
  els.userAvatar.title = user.username ? `账号与同步：${user.username}` : "账号与同步";
}

function providerIconSrc(provider = "") {
  const id = String(provider || "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  if (!id || id === "custom") return "";
  if (id === "mia") return "./assets/mia-logo.png";
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
    [/mia-auto|mia-default|mia /, "../mia-logo.png"],
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

function setModelAvatar(engine, entry = {}, config = {}) {
  if (!els.quickModelAvatar) return;
  const rawIcon = engine === "claude-code"
    ? modelIconSrc({ provider: "anthropic", model: entry.model || config.model || "claude" })
    : engine === "codex"
      ? modelIconSrc({ provider: "openai-codex", model: entry.model || config.model || "codex" })
      : modelIconSrc({
        provider: entry.provider || config.provider || (engine === "hermes" ? "nous" : engine),
        model: entry.model || config.model || entry.value || ""
      });
  // modelIconSrc / providerIconSrc still return desktop-bundle-relative
  // "./assets/..." paths so the lookup table can be shared verbatim with
  // the renderer. Web loads from "/app/", so we normalize at the render
  // boundary the same way avatar paths do (see normalizeAvatarUrl).
  const icon = normalizeAvatarUrl(rawIcon);
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
  state.conversations = [];
  state.friends = [];
  state.bots = [];
  state.settings = defaultWebSettings();
  state.messageCache.clear?.();
  state.conversationMembersCache.clear?.();
  pendingConversationMemberFetches.clear();
  state.incomingRequests = [];
  state.outgoingRequests = [];
  state.messageCache.clear();
  state.conversationMembersCache.clear();
  state.bridgeDevices = [];
  state.bridgeBusy = false;
  state.cloudAgentRuntime = null;
  state.cloudAgentRunsByConversation.clear?.();
  state.botRuntimeCache.clear?.();
  state.activeConversationId = "";
  stopCloudEvents();
  localStorage.removeItem(STORAGE_KEY);
}

// All conversations are conversations after Phase 4 cutover.
// Type is encoded in the id prefix (dm:, g_, botc_) and also lives in
// conversation.type. Old workspace-conversation helper is gone.
function isConversationId(id) {
  return typeof id === "string" && (id.startsWith("dm:") || id.startsWith("g_") || id.startsWith("botc_"));
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
  // Bound every request so a hung/stalled connection surfaces as a clear error
  // instead of a forever-spinning UI. Callers managing their own AbortSignal
  // (e.g. cancel-on-navigation) keep full control and opt out of the timeout.
  const timeoutMs = Number(options.timeoutMs) || 30000;
  const controller = options.signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      body: body && typeof body !== "string" ? JSON.stringify(body) : body,
      signal: options.signal || controller.signal
    });
  } catch (err) {
    if (err && err.name === "AbortError" && controller) throw new Error("请求超时，请重试。");
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
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

async function handleLogin() {
  try {
    const started = await api("/api/auth/wechat/start", { method: "POST", body: { client: "web" } });
    if (!started.authorizationUrl) throw new Error("微信登录启动失败");
    location.href = started.authorizationUrl;
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
    const me = await api("/api/me?compact=1");
    state.user = me.user || me;
    saveSession();
  } catch (err) {
    // token bad → log out
    clearSession();
    setAuthView();
    return;
  }
  await Promise.all([
    api("/api/conversations").then((d) => { state.conversations = Array.isArray(d.conversations) ? d.conversations : []; }).catch(() => {}),
    api("/api/social/friends").then((d) => { state.friends = Array.isArray(d.friends) ? d.friends : []; }).catch(() => {}),
    api("/api/social/friend-requests?direction=incoming").then((d) => { state.incomingRequests = Array.isArray(d.requests) ? d.requests : []; }).catch(() => {}),
    api("/api/social/friend-requests?direction=outgoing").then((d) => { state.outgoingRequests = Array.isArray(d.requests) ? d.requests : []; }).catch(() => {}),
    // Bot identities (name + avatar + persona) so bot conversation messages
    // render with proper attribution rather than bare ids.
    api("/api/me/bots?compact=1").then((d) => { state.bots = Array.isArray(d.bots) ? d.bots : []; }).catch(() => {}),
    // Phase 3: cross-device user settings (pin / read marks / appearance / tags).
    api("/api/me/settings").then((d) => { if (d.settings) state.settings = normalizeWebSettings(d.settings, state.settings); }).catch(() => {}),
    // Bridge devices: lets Phase B decide whether the owner's desktop is
    // online and we can route the message through it. Empty array if none.
    api("/api/bridge/devices").then((d) => { state.bridgeDevices = Array.isArray(d.devices) ? d.devices : []; }).catch(() => {}),
    loadCloudAgentRuntime(),
    loadPlatformModels(),
  ]);
  if (!state.activeConversationId) {
    const first = combinedConversationItems()[0];
    if (first) state.activeConversationId = first.id;
  }
  if (state.activeConversationId && isConversationId(state.activeConversationId)) {
    await ensureConversationMessages(state.activeConversationId);
    await ensureConversationMembers(state.activeConversationId);
  }
  // Prefetch members for every group conversation and every bot chat so
  // avatar resolution can use the server public identity path everywhere.
  await Promise.all(
    state.conversations
      .filter((r) => {
        const isGroup = r.type === "group" || (!r.id?.startsWith("dm:") && !r.id?.startsWith("botc_") && (r.id?.startsWith("g_") || r.id?.startsWith("g-")));
        if (isGroup) return true;
        return r.type === "bot" || r.id?.startsWith("botc_");
      })
      .map((r) => ensureConversationMembers(r.id))
  );
  renderConversationList();
  renderActiveChat();
  renderSettings();
  hydrateFullIdentities().catch(() => {});
}

function normalizeWebCloudAgentRuntime(input = {}) {
  if (window.miaCloudRuntime?.normalizeCloudAgentRuntime) {
    return window.miaCloudRuntime.normalizeCloudAgentRuntime(input);
  }
  const rawEngine = String(input.agentEngine || input.agent_engine || input.engine || "").trim().toLowerCase().replace(/_/g, "-");
  const agentEngine = rawEngine === "claude" || rawEngine === "claude-code" || rawEngine === "anthropic"
    ? "claude-code"
    : (rawEngine === "codex" || rawEngine === "openai-codex"
      ? "codex"
      : (rawEngine === "openclaw" || rawEngine === "open-claw"
        ? "openclaw"
        : (rawEngine === "hermes" ? "hermes" : "")));
  const runtimeKind = String(input.runtimeKind || input.runtime_kind || "").trim();
  return {
    runtimeKind,
    agentEngine,
    label: agentEngine ? engineLabel(agentEngine) : "",
    available: Boolean(runtimeKind && agentEngine)
  };
}

function webCloudAgentRuntime() {
  return normalizeWebCloudAgentRuntime(state.cloudAgentRuntime || {});
}

function webRequireCloudAgentRuntime() {
  const runtime = webCloudAgentRuntime();
  if (!runtime.available) throw new Error("Mia Cloud 运行内核未同步，请刷新后重试。");
  return runtime;
}

async function loadCloudAgentRuntime() {
  try {
    const health = await api("/api/health");
    state.cloudAgentRuntime = health?.cloudAgent && typeof health.cloudAgent === "object" ? health.cloudAgent : null;
  } catch {
    state.cloudAgentRuntime = null;
  }
}

async function hydrateFullIdentities() {
  if (!state.token) return;
  const [meResult, botsResult] = await Promise.allSettled([
    api("/api/me"),
    api("/api/me/bots")
  ]);
  let changed = false;
  if (meResult.status === "fulfilled") {
    state.user = meResult.value.user || meResult.value || state.user;
    changed = true;
  }
  if (botsResult.status === "fulfilled") {
    state.bots = Array.isArray(botsResult.value.bots) ? botsResult.value.bots : state.bots;
    changed = true;
  }
  if (!changed) return;
  renderUserAvatar();
  renderConversationList();
  renderActiveChat();
  renderSettings();
}

// (applyWorkspace + activeWorkspaceConversation removed in Phase 4 cutover.)

function bridgeIsOnline() {
  return state.bridgeDevices.length > 0;
}

// Conversation ids are `dm:<a>:<b>` or `g_<hex>` — both fit the server route regex
// /api/conversations/([A-Za-z0-9_:-]+) literally. encodeURIComponent would turn `:`
// into `%3A` and 404 the route, so paths use conversation.id verbatim.

async function ensureConversationMessages(conversationId) {
  if (!conversationId) return;
  const cached = state.messageCache.get(conversationId);
  const sinceSeq = cached?.maxSeq || 0;
  try {
    const data = await api(`/api/conversations/${conversationId}/messages?since_seq=${sinceSeq}&limit=200`);
    const incoming = Array.isArray(data.messages) ? data.messages : [];
    const messages = cached ? [...cached.messages] : [];
    const seen = new Set(messages.map((m) => m.id));
    for (const m of incoming) {
      if (!seen.has(m.id)) { messages.push(m); seen.add(m.id); }
    }
    const maxSeq = messages.reduce((acc, m) => Math.max(acc, Number(m.seq || 0)), sinceSeq);
    state.messageCache.set(conversationId, { messages, maxSeq });
  } catch (err) {
    console.warn("[web] ensureConversationMessages failed:", err);
  }
}

async function ensureConversationMembers(conversationId, options = {}) {
  if (!conversationId) return null;
  if (state.conversationMembersCache.has(conversationId)) return state.conversationMembersCache.get(conversationId);
  if (pendingConversationMemberFetches.has(conversationId)) return null;
  pendingConversationMemberFetches.add(conversationId);
  try {
    const data = await api(`/api/conversations/${conversationId}`);
    if (Array.isArray(data.members)) {
      state.conversationMembersCache.set(conversationId, data.members);
      if (options.renderOnHydrate) {
        renderConversationList();
        if (state.activeConversationId === conversationId) renderActiveChat();
      }
      return data.members;
    }
  } catch (err) {
    console.warn("[web] ensureConversationMembers failed:", err);
  } finally {
    pendingConversationMemberFetches.delete(conversationId);
  }
  return null;
}

function lastSeenSeqForConversation(conversationId) {
  const cached = state.messageCache.get(conversationId);
  const maxSeq = Number(cached?.maxSeq || 0);
  return Number.isFinite(maxSeq) && maxSeq > 0 ? maxSeq : 0;
}

// Another device pushed new readMarks. For each conversation whose readMark
// has caught up to (or past) the highest seq we've cached locally, clear
// the local unread counter so the badge clears in real time. Uncached
// conversations report maxSeq=0, so readSeq >= maxSeq trivially holds and
// we trust the peer's mark — they're authoritative for "the user has seen
// it." Messages arriving after this with seq > readMark will still bump
// unread normally via message_appended with a fresh seq.
function reconcileUnreadFromReadMarks(readMarks) {
  if (!readMarks || typeof readMarks !== "object") return;
  for (const [id, mark] of Object.entries(readMarks)) {
    const readSeq = Number(mark) || 0;
    if (readSeq <= 0) continue;
    if (readSeq >= lastSeenSeqForConversation(id)) {
      state.unread.delete(id);
    }
  }
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
  socket.addEventListener("open", () => {
    if (eventsSocket === socket) eventsReconnectAttempts = 0;
  });
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
  // Exponential backoff capped at 30s so a long server outage doesn't spam a
  // reconnect every 3s; the delay resets once a connection succeeds (see the
  // socket "open" handler).
  const delay = Math.min(30000, 3000 * 2 ** eventsReconnectAttempts);
  eventsReconnectAttempts += 1;
  eventsReconnectTimer = setTimeout(() => { eventsReconnectTimer = 0; startCloudEvents(); }, delay);
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

function cloudRunFor(conversationId, runId = "") {
  const existing = state.cloudAgentRunsByConversation.get(conversationId);
  if (existing) return existing;
  const run = {
    conversationId,
    runId,
    text: "",
    reasoning: "",
    status: "running",
    createdAt: new Date().toISOString(),
    tools: [],
    contentBlocks: [],
    contentBlockCollector: null,
    toolsById: new Map(),
    toolsByName: new Map(),
  };
  state.cloudAgentRunsByConversation.set(conversationId, run);
  return run;
}

function streamingTextSmoother() {
  if (!cloudRunTextSmoother && assistantContentBlocks && typeof assistantContentBlocks.createStreamingTextSmoother === "function") {
    cloudRunTextSmoother = assistantContentBlocks.createStreamingTextSmoother({
      charsPerFrame: 3,
      schedule: (fn) => {
        const schedule = typeof window.requestAnimationFrame === "function"
          ? window.requestAnimationFrame.bind(window)
          : window.setTimeout.bind(window);
        return schedule(fn, 16);
      },
      cancel: (handle) => {
        if (!handle) return;
        if (typeof window.cancelAnimationFrame === "function") {
          try { window.cancelAnimationFrame(handle); return; } catch {}
        }
        window.clearTimeout(handle);
      },
      onUpdate: (run) => {
        if (run?.conversationId === state.activeConversationId) renderActiveChat();
      }
    });
  }
  return cloudRunTextSmoother;
}

function syncRunDisplayText(run) {
  if (!run) return;
  if (prefersReducedMotion()) {
    flushRunDisplayText(run);
    return;
  }
  const smoother = streamingTextSmoother();
  if (smoother && typeof smoother.enqueue === "function") {
    smoother.enqueue(run, run.text || "");
  } else {
    run.displayText = String(run.text || "");
  }
}

function flushRunDisplayText(run) {
  if (!run) return;
  const smoother = streamingTextSmoother();
  if (smoother && typeof smoother.enqueue === "function") smoother.enqueue(run, run.text || "");
  if (smoother && typeof smoother.flush === "function") smoother.flush(run);
  run.displayText = String(run.text || "");
}

function runDisplayText(run) {
  if (!run) return "";
  if (typeof run.displayText === "string") return run.displayText;
  return String(run.text || "");
}

// Pull a human-readable line out of a Hermes approval.request event. The payload
// shape varies by guard (command / reason / tool), so probe the common fields and
// fall back to a compact JSON dump.
function approvalPreview(event = {}) {
  for (const key of ["command", "cmd", "preview", "reason", "detail", "description", "message"]) {
    if (typeof event[key] === "string" && event[key].trim()) return event[key].trim();
  }
  const data = event.data && typeof event.data === "object" ? event.data : null;
  if (data) {
    for (const key of ["command", "cmd", "preview", "reason", "detail", "description", "message"]) {
      if (typeof data[key] === "string" && data[key].trim()) return data[key].trim();
    }
  }
  try {
    const { event: _e, run_id: _r, timestamp: _t, choices: _c, ...rest } = event;
    const json = JSON.stringify(rest);
    return json && json !== "{}" ? json.slice(0, 400) : "";
  } catch {
    return "";
  }
}

function normalizeToolStatus(status) {
  const value = String(status || "").trim();
  if (value === "complete" || value === "completed") return "completed";
  if (value === "error" || value === "failed") return "error";
  return "running";
}

function ensureRunTraceMaps(run) {
  if (!run.toolsById) run.toolsById = new Map();
  if (!run.toolsByName) run.toolsByName = new Map();
  if (!Array.isArray(run.tools)) run.tools = [];
}

function findRunTool(run, event = {}) {
  ensureRunTraceMaps(run);
  const id = String(event.id || "");
  const name = String(event.tool || event.name || event.data?.tool || "");
  let tool = id ? run.toolsById.get(id) : null;
  if (!tool && name) {
    const queue = run.toolsByName.get(name);
    tool = queue && queue.find((item) => item.status === "running");
  }
  if (!tool && !id && !name) {
    tool = [...run.tools].reverse().find((item) => item.status === "running");
  }
  return tool || null;
}

function addRunTool(run, event = {}) {
  ensureRunTraceMaps(run);
  const tool = {
    id: String(event.id || `tool_${run.tools.length}`),
    name: String(event.tool || event.name || event.data?.tool || "工具"),
    preview: String(event.preview || event.input || ""),
    status: "running",
    duration: null,
    error: false,
  };
  run.tools.push(tool);
  run.toolsById.set(tool.id, tool);
  const queue = run.toolsByName.get(tool.name) || [];
  queue.push(tool);
  run.toolsByName.set(tool.name, queue);
}

function parseTraceJson(value) {
  if (!value) return null;
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const reasoning = String(parsed.reasoning || "").trim();
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools.map((tool, idx) => {
      if (!tool || typeof tool !== "object") return null;
      const name = String(tool.name || "").trim();
      if (!name) return null;
      return {
        id: String(tool.id || `tool_${idx}`),
        name,
        preview: String(tool.preview || ""),
        status: normalizeToolStatus(tool.status),
        duration: typeof tool.duration === "number" ? tool.duration : null,
        error: Boolean(tool.error),
      };
    }).filter(Boolean)
    : [];
  if (!reasoning && !tools.length) return null;
  return { reasoning, tools };
}

function parseContentBlocksJson(value) {
  if (!value) return [];
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  if (assistantContentBlocks && typeof assistantContentBlocks.normalizeContentBlocks === "function") {
    return assistantContentBlocks.normalizeContentBlocks(parsed);
  }
  return Array.isArray(parsed) ? parsed.filter((block) => block && typeof block === "object") : [];
}

function contentBlocksFromMessage(msg) {
  const blocks = parseContentBlocksJson(msg?.content_blocks_json || msg?.contentBlocks || msg?.content_blocks);
  if (!blocks.length) return [];
  return assistantContentBlocks && typeof assistantContentBlocks.contentBlocksWithFinalText === "function"
    ? assistantContentBlocks.contentBlocksWithFinalText(blocks, msg?.body_md || msg?.bodyMd || "")
    : blocks;
}

function collectRunContentBlock(run, event = {}) {
  if (!run || !event || typeof event !== "object") return;
  if (!assistantContentBlocks || typeof assistantContentBlocks.createAssistantContentBlockCollector !== "function") return;
  if (!run.contentBlockCollector) run.contentBlockCollector = assistantContentBlocks.createAssistantContentBlockCollector();
  run.contentBlockCollector.collect(event);
  run.contentBlocks = run.contentBlockCollector.payload();
}

function contentBlocksPayloadFromRun(run, finalText = "") {
  const blocks = Array.isArray(run?.contentBlocks) ? run.contentBlocks : [];
  if (!blocks.length) return null;
  if (finalText && typeof assistantContentBlocks.contentBlocksWithFinalText === "function") {
    return assistantContentBlocks.contentBlocksWithFinalText(blocks, finalText);
  }
  return blocks;
}

function displayedContentBlocksPayloadFromRun(run, finalText = "") {
  const blocks = contentBlocksPayloadFromRun(run, finalText);
  if (!blocks || finalText) return blocks;
  return assistantContentBlocks && typeof assistantContentBlocks.contentBlocksWithDisplayText === "function"
    ? assistantContentBlocks.contentBlocksWithDisplayText(blocks, runDisplayText(run))
    : blocks;
}

function messageWithFallbackRunContentBlocks(conversationId, msg) {
  if (!msg || msg.sender_kind !== SenderKind.Bot) return msg;
  if (contentBlocksFromMessage(msg).length) return msg;
  const blocks = contentBlocksPayloadFromRun(
    state.cloudAgentRunsByConversation.get(conversationId),
    msg.body_md || msg.bodyMd || ""
  );
  return blocks ? { ...msg, contentBlocks: blocks } : msg;
}

function handleCloudEvent(envelope) {
  const type = envelope?.type || "";
  if (type === "conversation.message_appended") {
    const msg = envelope.message;
    const conversationId = msg?.conversation_id || envelope.conversation_id;
    if (!conversationId || !msg) return;
    const cachedMsg = messageWithFallbackRunContentBlocks(conversationId, msg);
    const entry = state.messageCache.get(conversationId) || { messages: [], maxSeq: 0 };
    const fresh = !entry.messages.some((m) => m.id === cachedMsg.id);
    if (fresh) {
      entry.messages.push(cachedMsg);
      entry.maxSeq = Math.max(entry.maxSeq, Number(cachedMsg.seq || 0));
      state.messageCache.set(conversationId, entry);
      if (cachedMsg.sender_kind === SenderKind.Bot || msg.sender_kind === SenderKind.Bot) state.cloudAgentRunsByConversation.delete(conversationId);
      // Bump unread if the message isn't mine and the conversation isn't currently open.
      // Self-id check goes through shared/contact: resolveContact returns kind="self"
      // only when ref matches ctx.self.id (works for any sender kind).
      const author = window.miaContact.resolveContact(
        { kind: "user", ref: cachedMsg.sender_ref },
        { self: state.user, friends: state.friends }
      );
      const isMine = author.kind === "self";
      if (!isMine && conversationId !== state.activeConversationId) {
        // Skip the bump if another device has already marked this seq read
        // (covers WS replay on reconnect: server replays old message_appended
        // rows from since_seq forward, and we'd otherwise re-light the badge
        // for conversations the user read on desktop).
        const readMark = Number(state.settings?.readMarks?.[conversationId]) || 0;
        const msgSeq = Number(cachedMsg.seq) || 0;
        if (msgSeq > readMark) {
          state.unread.set(conversationId, (state.unread.get(conversationId) || 0) + 1);
        }
      }
    }
    if (conversationId === state.activeConversationId) {
      state.unread.delete(conversationId);
      renderActiveChat();
    }
    renderConversationList();
    renderSessionMenu();
    renderRailUnreadBadge();
  } else if (type === "cloud_agent_run_started") {
    const conversationId = envelope.conversationId;
    if (!conversationId) return;
    const run = cloudRunFor(conversationId, envelope.runId || "");
    run.runId = envelope.runId || run.runId;
    run.hermesRunId = envelope.hermesRunId || run.hermesRunId || "";
    run.botId = envelope.botId || run.botId || "";
    run.status = "running";
    if (conversationId === state.activeConversationId) renderActiveChat();
  } else if (type === "cloud_agent_run_event") {
    const conversationId = envelope.conversationId;
    const event = envelope.event || {};
    if (!conversationId) return;
    const run = cloudRunFor(conversationId, envelope.runId || "");
    run.botId = envelope.botId || run.botId || "";
    const name = hermesEventType(event);
    collectRunContentBlock(run, event);
    if (name === "message.delta" || name === "text_delta") {
      run.text += hermesEventText(event);
      syncRunDisplayText(run);
    } else if (name === "message.complete" || name === "message.completed") {
      run.text = hermesEventText(event) || run.text;
      flushRunDisplayText(run);
    } else if (name === "run.completed") {
      run.text = hermesEventText(event) || run.text;
      run.status = "complete";
      run.permission = null;
      flushRunDisplayText(run);
    } else if (name === "run.failed") {
      run.status = "error";
      run.permission = null;
      flushRunDisplayText(run);
    } else if (name === "run.cancelling") {
      run.status = "cancelling";
      run.permission = null;
    } else if (name === "status") {
      run.statusText = hermesEventText(event) || run.statusText || "";
    } else if (name === "run.cancelled") {
      run.status = "cancelled";
      run.permission = null;
      flushRunDisplayText(run);
    } else if (name === "approval.request") {
      // Interactive tool approval: the run paused waiting for the owner. Show a
      // banner; the decision is POSTed back so the cloud can resume the run.
      run.permission = {
        runId: envelope.runId || run.runId || "",
        preview: approvalPreview(event),
        toolName: String(event.tool || event.tool_name || event.name || "").trim(),
        createdAt: new Date().toISOString(),
      };
      run.status = "running";
    } else if (name === "approval.responded") {
      run.permission = null;
    } else if (name === "reasoning.available" || name === "reasoning_delta") {
      run.reasoning = `${run.reasoning || ""}${hermesEventText(event)}`;
      if (run.reasoning && !run.reasoning.endsWith("\n")) run.reasoning += "\n";
    } else if (name === "tool.started" || name === "tool_call_started") {
      addRunTool(run, event);
    } else if (name === "tool.delta" || name === "tool_call_delta") {
      const tool = findRunTool(run, event);
      if (tool) tool.preview = String(event.preview || event.delta || tool.preview || "");
    } else if (name === "tool.completed" || name === "tool_call_completed") {
      const tool = findRunTool(run, event);
      if (tool) {
        tool.status = event.error || event.data?.error ? "error" : normalizeToolStatus(event.status || "completed");
        tool.duration = typeof event.duration === "number" ? event.duration : null;
        tool.error = Boolean(event.error || event.data?.error);
        if (event.preview) tool.preview = String(event.preview);
      }
    }
    if (conversationId === state.activeConversationId) renderActiveChat();
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
    if (envelope.conversation) {
      state.conversations = [envelope.conversation, ...state.conversations.filter((r) => r.id !== envelope.conversation.id)];
    }
    state.incomingRequests = state.incomingRequests.filter((r) => r.from_user !== envelope.friend?.id && r.to_user !== envelope.friend?.id);
    state.outgoingRequests = state.outgoingRequests.filter((r) => r.to_user !== envelope.friend?.id);
    renderConversationList();
  } else if (type === "social.conversation_invited") {
    if (envelope.conversation) {
      state.conversations = [envelope.conversation, ...state.conversations.filter((r) => r.id !== envelope.conversation.id)];
      state.conversationMembersCache.delete(envelope.conversation.id);
    }
    renderConversationList();
  } else if (type === "conversation.updated") {
    // PATCH /api/conversations/:id from any device — merge the patched conversation.
    if (envelope.conversation) {
      state.conversations = state.conversations.map((r) => (r.id === envelope.conversation.id ? { ...r, ...envelope.conversation } : r));
      renderConversationList();
      if (state.activeConversationId === envelope.conversation.id) renderActiveChat();
      renderSessionMenu();
    }
  } else if (type === "conversation.deleted") {
    // DELETE /api/conversations/:id from any device — purge local state.
    const conversationId = envelope.conversationId;
    if (conversationId) {
      state.conversations = state.conversations.filter((r) => r.id !== conversationId);
      state.unread.delete(conversationId);
      state.conversationMembersCache.delete(conversationId);
      if (state.activeConversationId === conversationId) state.activeConversationId = "";
      renderConversationList();
      renderActiveChat();
    }
  } else if (type === "user.profile_updated") {
    if (envelope.user) {
      state.user = envelope.user;
      renderSettings();
      renderConversationList();
      renderActiveChat();
    }
  } else if (type === "bot.upserted") {
    // Phase 2: another device created/edited a bot — replace by id so
    // names/avatars stay current across this browser too.
    const bot = envelope.bot;
    if (bot && bot.id) {
      state.bots = [bot, ...state.bots.filter((f) => f.id !== bot.id)];
      renderConversationList();
      renderActiveChat();
      renderSessionMenu();
    }
  } else if (type === "bot.runtime_updated") {
    const binding = envelope.binding;
    if (binding?.botId && binding?.runtimeKind) {
      state.botRuntimeCache.set(runtimeCacheKey(binding.botId, binding.runtimeKind), binding);
      renderActiveChat();
    }
  } else if (type === "bot.deleted") {
    const botId = envelope.botId;
    if (botId) {
      state.bots = state.bots.filter((f) => f.id !== botId);
      renderConversationList();
      renderActiveChat();
    }
  } else if (type === "user_settings.updated") {
    // Phase 3: another device wrote settings — replace local copy. Last
    // write wins because the server stamps updatedAt and we don't try
    // to merge field-by-field (settings bags are small and replaced as
    // a whole).
    if (envelope.settings) {
      state.settings = normalizeWebSettings(envelope.settings, state.settings);
      reconcileUnreadFromReadMarks(state.settings.readMarks);
      renderConversationList();
      renderRailUnreadBadge();
    }
  }
}

// ── conversation list (conversations + desktop-synced bot chats merged) ───────────

function friendById(userId) {
  if (userId === state.user?.id) return state.user;
  return state.friends.find((f) => f.id === userId) || null;
}

function friendUsernameById(userId) {
  return friendById(userId)?.username || userId;
}

function conversationDisplayTitle(conversation) {
  if (conversation.id?.startsWith("dm:")) {
    const parts = conversation.id.split(":");
    const otherId = parts[1] === state.user?.id ? parts[2] : parts[1];
    return friendUsernameById(otherId);
  }
  if (conversation.type === "bot" || conversation.id?.startsWith("botc_")) {
    return sessionHistory.botDisplayTitle(conversation, state.bots, "对话");
  }
  return conversation.name || "未命名群聊";
}

function conversationTypeForControls(conversation) {
  return sessionHistory.conversationType(conversation, conversation?.id || "");
}

function botKeyForConversation(conversation) {
  return sessionHistory.botId(conversation);
}

function botByKey(key) {
  const wanted = String(key || "");
  return state.bots.find((bot) => String(bot.id || bot.key || "") === wanted) || null;
}

function botAvatarIdentityId(botKey, bot = {}, member = null) {
  const identity = member?.identity || {};
  const sharedIdentityId = window.miaContact?.botAvatarIdentityId;
  return sharedIdentityId?.(botKey, {
    ...(bot || {}),
    id: bot?.id || bot?.key || identity.id || botKey,
    botId: botKey,
    member_ref: botKey
  }) || identity.id || bot?.id || bot?.key || botKey;
}

function hasAvatarIdentityFields(record) {
  if (typeof avatarResolve.hasAvatarIdentityFields === "function") {
    return avatarResolve.hasAvatarIdentityFields(record);
  }
  return Boolean(record && typeof record === "object" && (
    Object.prototype.hasOwnProperty.call(record, "avatarImage")
      || Object.prototype.hasOwnProperty.call(record, "avatarCrop")
      || Object.prototype.hasOwnProperty.call(record, "avatar_image")
      || Object.prototype.hasOwnProperty.call(record, "avatar_crop")
  ));
}

function userAvatarForContact(user, id, displayName) {
  return avatarResolve.resolveAvatarForContact({
    id: id || user?.id || user?.account || displayName || "",
    displayName: displayName || user?.displayName || user?.username || user?.account || user?.id || "",
    avatarImage: user?.avatarImage || "",
    avatarCrop: user?.avatarCrop || null,
    color: user?.avatarColor || user?.avatar_color || user?.color || ""
  });
}

// Locate the most authoritative metadata for a bot shown in this
// conversation, then hand it to shared/avatar-resolve.js so the result is a
// unified {image, crop, color, text}. Resolution order:
//   1. state.bots — bots the viewer owns (freshest copy).
//   2. member.identity.avatar — server-canonical cross-owner identity.
//   3. bot member fields — compact server-enriched identity.
//   4. empty avatar — stable color + two-character text fallback.
function botAvatarFor(conversation, botKey) {
  const wanted = String(botKey || "");
  if (!wanted) return null;
  const owned = botByKey(wanted);
  const members = state.conversationMembersCache.get(conversation?.id) || [];
  const member = members.find((m) => m.member_kind === MemberKind.Bot && m.member_ref === wanted);
  const ownedHasAvatarFields = hasAvatarIdentityFields(owned);
  const fallbackBot = {
    key: wanted,
    id: wanted,
    name: conversation?.name || wanted
  };
  const avatarId = botAvatarIdentityId(wanted, owned || fallbackBot, member || null);
  if (owned && ownedHasAvatarFields) {
    return avatarResolve.resolveAvatarForContact({
      id: avatarId,
      displayName: owned.name || owned.displayName || wanted,
      avatarImage: owned.avatarImage,
      avatarCrop: owned.avatarCrop,
      color: owned.color || owned.avatarColor || owned.avatar_color || ""
    });
  }
  if (member) {
    const identityAvatar = member.identity?.avatar || {};
    if (!ownedHasAvatarFields && member.identity?.avatar && (identityAvatar.image || identityAvatar.color || identityAvatar.text)) {
      return identityAvatar;
    }
    return avatarResolve.resolveAvatarForContact({
      id: avatarId,
      displayName: owned?.name || owned?.displayName || member.identity?.displayName || member.bot_name || wanted,
      avatarImage: identityAvatar.image || member.bot_avatar_image,
      avatarCrop: identityAvatar.crop || member.bot_avatar_crop,
      color: identityAvatar.color || member.bot_color || member.avatarColor || member.avatar_color || ""
    });
  }
  if (owned) {
    return avatarResolve.resolveAvatarForContact({
      id: avatarId,
      displayName: owned.name || owned.displayName || wanted,
      avatarImage: "",
      avatarCrop: null,
      color: owned.color || owned.avatarColor || owned.avatar_color || ""
    });
  }
  return avatarResolve.resolveAvatarForContact({ id: avatarId, displayName: fallbackBot.name });
}

function runtimeKindForBotConversation(conversation, bot) {
  void bot;
  return sessionHistory.runtimeKind(conversation, "desktop-local");
}

function engineForRuntimeKind(runtimeKind) {
  const kind = String(runtimeKind || "").trim();
  if (kind === "cloud-claude-code") return webCloudAgentRuntime().agentEngine;
  if (kind === "desktop-local") return "hermes";
  return normalizeAgentEngine(kind);
}

function engineForRuntimeBinding(runtimeKind, binding) {
  const config = binding?.config || {};
  if (runtimeKind === "cloud-claude-code" && config.agentEngine) {
    return normalizeWebCloudAgentRuntime({ runtimeKind, agentEngine: config.agentEngine }).agentEngine;
  }
  if (runtimeKind === "desktop-local" && config.agentEngine) return normalizeAgentEngine(config.agentEngine);
  return engineForRuntimeKind(runtimeKind);
}

function runtimeCacheKey(botKey, runtimeKind) {
  if (typeof botRuntimeControl.runtimeCacheKey === "function") {
    return botRuntimeControl.runtimeCacheKey(botKey, runtimeKind || "cloud-claude-code");
  }
  return `${botKey}:${runtimeKind || "cloud-claude-code"}`;
}

function runtimeBindingFor(botKey, runtimeKind) {
  return state.botRuntimeCache.get(runtimeCacheKey(botKey, runtimeKind)) || null;
}

function normalizePlatformModel(model = {}) {
  const id = String(model.id || model.model_name || model.model || "").trim();
  if (!id) return null;
  const displayLabel = typeof engineContracts.platformModelDisplayLabel === "function"
    ? engineContracts.platformModelDisplayLabel(model, id)
    : (id.toLowerCase() === "mia-auto"
      ? "Auto"
      : String(model.label || model.name || id).trim());
  return {
    value: id,
    label: displayLabel,
    provider: "mia",
    providerLabel: "Mia",
    model: id,
    authType: "mia_account",
    modelProfileId: `mia:${id}`,
    upstreamModel: String(model.upstreamModel || model.upstream_model || model.model || "").trim()
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

async function ensureBotRuntime(botKey, runtimeKind = "cloud-claude-code") {
  if (!botKey) return null;
  const key = runtimeCacheKey(botKey, runtimeKind);
  if (state.botRuntimeCache.has(key)) return state.botRuntimeCache.get(key);
  if (typeof botRuntimeControl.getBotRuntimeBinding !== "function") {
    state.botRuntimeCache.set(key, null);
    return null;
  }
  try {
    return await botRuntimeControl.getBotRuntimeBinding({
      api,
      cache: state.botRuntimeCache,
      botId: botKey,
      runtimeKind
    });
  } catch (err) {
    console.warn("[web] bot runtime GET failed:", err);
    state.botRuntimeCache.set(key, null);
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
      providerLabel: String(entry.providerLabel || entry.provider_label || ""),
      authType: String(entry.authType || entry.auth_type || ""),
      modelProfileId: String(entry.modelProfileId || entry.model_profile_id || entry.profileId || entry.profile_id || ""),
      apiKeyEnv: String(entry.apiKeyEnv || entry.api_key_env || ""),
      baseUrl: String(entry.baseUrl || entry.base_url || ""),
      apiMode: String(entry.apiMode || entry.api_mode || "")
    })).filter((entry) => entry.value || entry.model);
  }
  if (isDesktopExternalRuntime(engine, runtimeKind)) {
    return externalModelEntries(engine).map((entry) => ({
      value: entry.model || entry.id,
      model: entry.model,
      label: entry.label || entry.model || entry.id,
      provider: entry.provider || (engine === "codex" ? "openai-codex" : engine === "claude-code" ? "anthropic" : "openclaw"),
      providerLabel: entry.providerLabel || entry.provider_label || "",
      authType: entry.authType || entry.auth_type || "",
      modelProfileId: entry.modelProfileId || entry.model_profile_id || "",
      apiKeyEnv: entry.apiKeyEnv || entry.api_key_env || "",
      baseUrl: entry.baseUrl || entry.base_url || "",
      apiMode: entry.apiMode || entry.api_mode || ""
    }));
  }
  if (runtimeKind === "desktop-local" && config.model) {
    return [{ value: config.model, label: config.model, model: config.model, provider: config.provider || "" }];
  }
  if (runtimeKind === "cloud-claude-code" || engine === "hermes") {
    return state.platformModels.length
      ? state.platformModels
      : [{ value: "mia-auto", label: "Auto", provider: "mia", providerLabel: "Mia", model: "mia-auto", authType: "mia_account", modelProfileId: "mia:mia-auto" }];
  }
  return externalModelEntries(engine).map((entry) => ({
    value: entry.id,
    model: entry.model,
    label: entry.label || entry.model || entry.id,
    provider: entry.provider || (engine === "codex" ? "openai-codex" : "anthropic")
  }));
}

function selectEntriesForPermission(engine, runtimeKind) {
  if (isDesktopExternalRuntime(engine, runtimeKind)) {
    return externalPermissionOptions(engine);
  }
  if (runtimeKind === "desktop-local") {
    return [
      { value: "ask", label: "Ask" },
      { value: "yolo", label: "YOLO" },
      { value: "deny", label: "Deny" }
    ];
  }
  if (runtimeKind === "cloud-claude-code") {
    return [
      { value: "bypassPermissions", label: "Sandbox" }
    ];
  }
  if (engine === "hermes") {
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

function renderComposerControls(conversation = null) {
  const show = conversationTypeForControls(conversation) === "bot";
  els.composerBottom?.classList.toggle("hidden", !show);
  if (!show) return;

  const botKey = botKeyForConversation(conversation);
  const bot = botByKey(botKey);
  const runtimeKind = runtimeKindForBotConversation(conversation, bot);
  const binding = runtimeBindingFor(botKey, runtimeKind);
  const config = binding?.config || {};
  const engine = engineForRuntimeBinding(runtimeKind, binding);
  const editable = Boolean(botKey);

  const cloudModelEntries = selectEntriesForModel(engine, runtimeKind, config);
  const isDesktopExternal = isDesktopExternalRuntime(engine, runtimeKind);
  const modelValue = config.provider === "mia" && config.model
    ? (cloudModelEntries.find((entry) => entry.provider === "mia" && entry.model === config.model)?.value || config.model)
    : (config.model || (isDesktopExternal ? "default" : cloudModelEntries[0]?.value || "mia-auto"));
  const modelLabel = setSelectOptions(els.quickModelSelect, cloudModelEntries, modelValue, config.model || "Default");
  const selectedModelEntry = cloudModelEntries.find((entry) => String(entry.value) === String(els.quickModelSelect?.value || modelValue))
    || cloudModelEntries.find((entry) => String(entry.model) === String(config.model || ""))
    || {};
  setModelAvatar(engine, selectedModelEntry, config);
  setText(els.quickModelLabel, modelLabel || "Default");

  const effortEntries = effortOptions(engine);
  const defaultEffort = effortEntries.find((entry) => entry.value === "medium")?.value || effortEntries[0]?.value || "medium";
  const effort = config.effortLevel || defaultEffort;
  const effortLabel = setSelectOptions(els.effortSelect, effortEntries, effort, "Medium");
  setText(els.effortLabel, effortLabel || "Medium");

  const permission = isDesktopExternal ? "default" : (config.permissionMode || "ask");
  const permissionLabel = setSelectOptions(els.permissionMode, selectEntriesForPermission(engine, runtimeKind), permission, "Ask");
  setText(els.permissionLabel, permissionLabel || "Ask");
  const permissionWrap = els.permissionMode?.closest?.(".permission-switcher");
  permissionWrap?.classList.toggle("yolo", permission === "bypassPermissions");
  permissionWrap?.classList.toggle("claude-bypass", engine === "claude-code" && permission === "bypassPermissions");

  if (els.quickModelSelect) els.quickModelSelect.disabled = !editable;
  if (els.effortSelect) els.effortSelect.disabled = !editable;
  if (els.permissionMode) els.permissionMode.disabled = !editable || isDesktopExternal;
  setModelSwitchStatus(engineLabel(engine), editable);

  if (editable && !state.botRuntimeCache.has(runtimeCacheKey(botKey, runtimeKind))) {
    ensureBotRuntime(botKey, runtimeKind).then(() => {
      if (state.activeConversationId === conversation.id) renderActiveChat();
    });
  }
}

async function saveWebAiControl(kind, value) {
  const conversation = state.conversations.find((r) => r.id === state.activeConversationId);
  if (conversationTypeForControls(conversation) !== "bot") return;
  const botKey = botKeyForConversation(conversation);
  const runtimeKind = runtimeKindForBotConversation(conversation, botByKey(botKey));
  if (!botKey) {
    showToast("当前对话没有可配置的智能体。");
    renderComposerControls(conversation);
    return;
  }
  const key = runtimeCacheKey(botKey, runtimeKind);
  const current = runtimeBindingFor(botKey, runtimeKind) || await ensureBotRuntime(botKey, runtimeKind) || {
    botId: botKey,
    runtimeKind,
    enabled: true,
    config: {}
  };
  const config = { ...(current.config || {}) };
  const engine = engineForRuntimeBinding(runtimeKind, current);
  if (kind === "permission" && isDesktopExternalRuntime(engine, runtimeKind)) {
    showToast("请在桌面端调整本机引擎权限。");
    renderComposerControls(conversation);
    return;
  }
  const modelEntries = kind === "model" ? selectEntriesForModel(engine, runtimeKind, config) : [];
  setModelSwitchStatus("保存中...", true);
  try {
    if (typeof botRuntimeControl.saveBotRuntimeControl !== "function") {
      throw new Error("Bot runtime control is unavailable.");
    }
    const result = await botRuntimeControl.saveBotRuntimeControl({
      api,
      cache: state.botRuntimeCache,
      bot: { key: botKey, id: botKey, runtimeKind },
      botKey,
      botId: botKey,
      runtimeKind,
      field: kind,
      value,
      modelEntries
    });
    if (result?.binding) state.botRuntimeCache.set(key, result.binding);
    renderComposerControls(conversation);
    setModelSwitchStatus("已更新", true);
  } catch (err) {
    showToast(err.message || "设置保存失败");
    setModelSwitchStatus("保存失败", false);
    renderComposerControls(conversation);
  }
}

function conversationLastMessageText(conversation) {
  const cached = state.messageCache.get(conversation.id);
  const last = cached?.messages?.[cached.messages.length - 1];
  if (!last) return "暂无对话";
  return last.body_md || (last.attachments ? "[附件]" : "");
}

function conversationSortKey(conversation) {
  return sessionHistory.conversationSortTime(conversation, state.messageCache);
}

function cryptoRandomId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `session_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function activeSessionConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeConversationId) || null;
}

function sessionTitleForConversation(conversation) {
  return sessionHistory.sessionTitle(conversation, {
    bots: state.bots,
    defaultTitle: "新对话",
    groupTitle: "群聊",
    dmTitle: conversationDisplayTitle,
    dmTitleFallback: "私聊"
  });
}

function sessionConversationsForConversation(conversation) {
  return sessionHistory.sessionConversationsForConversation(conversation, state.conversations, {
    messageCache: state.messageCache,
    activeConversationId: state.activeConversationId
  });
}

function updateCurrentSessionTitle(title) {
  if (!els.currentSessionTitle) return;
  const next = title || "新对话";
  if ((els.currentSessionTitle.dataset?.slotTextValue || els.currentSessionTitle.textContent) === next) return;
  setAnimatedText(els.currentSessionTitle, next, { direction: "up", stagger: 18, duration: 240 });
  els.currentSessionTitle.classList.remove("title-updated");
  requestAnimationFrame(() => els.currentSessionTitle?.classList.add("title-updated"));
}

async function renameSessionConversation(conversation) {
  if (!conversation || conversationTypeForControls(conversation) === "dm") return;
  const title = window.prompt("重命名这个会话", sessionTitleForConversation(conversation));
  if (title === null) return;
  const trimmed = String(title || "").trim();
  if (!trimmed) return;
  try {
    const res = await api(`/api/conversations/${conversation.id}`, { method: "PATCH", body: { name: trimmed } });
    const updated = res?.conversation || { ...conversation, name: trimmed };
    state.conversations = state.conversations.map((candidate) => (candidate.id === conversation.id ? { ...candidate, ...updated } : candidate));
    renderConversationList();
    renderActiveChat();
    renderSessionMenu();
  } catch (err) {
    showToast(err.message || "重命名失败");
  }
}

function selectSessionConversation(conversation) {
  if (!conversation?.id) return;
  state.sessionMenuOpen = false;
  setActiveConversation(conversation.id);
}

async function createNewSessionForActive() {
  const conversation = activeSessionConversation();
  if (!sessionHistory.canCreateSession(conversation)) return;
  const payload = sessionHistory.createBotSessionPayload(conversation, cryptoRandomId(), {
    title: "新对话",
    runtimeKindFallback: "desktop-local"
  });
  const botId = payload.botId;
  if (!botId) return;
  try {
    const res = await api(`/api/me/bot-conversations/${encodeURIComponent(payload.sessionId)}`, {
      method: "PUT",
      body: {
        botId,
        title: payload.title,
        runtimeKind: payload.runtimeKind
      }
    });
    const created = res?.conversation;
    if (!created?.id) return;
    state.conversations = [created, ...state.conversations.filter((candidate) => candidate.id !== created.id)];
    if (Array.isArray(res.members)) state.conversationMembersCache.set(created.id, res.members);
    state.messageCache.set(created.id, { messages: [], maxSeq: 0 });
    state.sessionMenuOpen = false;
    setActiveConversation(created.id);
  } catch (err) {
    showToast(err.message || "新建会话失败");
  }
}

function renderSessionMenu() {
  if (!els.sessionMenu || !els.sessionList) return;
  const conversation = activeSessionConversation();
  const hasConversation = Boolean(conversation);
  els.sessionMenuButton?.classList.toggle("hidden", !hasConversation);
  els.sessionMenu.classList.toggle("hidden", !hasConversation || !state.sessionMenuOpen);
  if (!hasConversation) {
    els.sessionList.innerHTML = "";
    updateCurrentSessionTitle("新对话");
    return;
  }

  const conversations = sessionConversationsForConversation(conversation);
  const canCreate = sessionHistory.canCreateSession(conversation);
  els.newSession?.classList.toggle("hidden", !canCreate);
  updateCurrentSessionTitle(sessionTitleForConversation(conversation));
  els.sessionList.innerHTML = "";
  for (const item of conversations) {
    const editable = conversationTypeForControls(item) !== "dm";
    const row = document.createElement("button");
    row.type = "button";
    row.className = `session-row${item.id === conversation.id ? " active" : ""}`;
    row.innerHTML = `
      <span>
        <strong>${escapeHtml(sessionTitleForConversation(item))}</strong>
        <small>${escapeHtml(new Date(conversationSortKey(item) || Date.now()).toLocaleString())}</small>
      </span>
      ${editable ? `<em title="重命名" data-session-edit="${escapeHtml(item.id)}">✎</em>` : "<i></i>"}
    `;
    row.addEventListener("click", (event) => {
      if (event.target.closest("[data-session-edit]")) {
        event.stopPropagation();
        renameSessionConversation(item);
        return;
      }
      selectSessionConversation(item);
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
    bots: state.bots || []
  };
}

// Unified item shape so the renderer doesn't have to branch every time.
// Pinned items sort to the top regardless of recency, mirroring the
// ChatGPT-style pin behavior the user asked for.
function combinedConversationItems() {
  const sidebarConversations = sessionHistory.sidebarConversations(state.conversations, {
    activeConversationId: state.activeConversationId,
    messageCache: state.messageCache
  });
  const conversation = sidebarConversations.map((r) => {
    // id-prefix fallback for cloud deployments that haven't shipped the v7
    // type column yet. Remove once every server is on schema ≥ v7.
    const isDM = r.type === "dm" || r.id?.startsWith("dm:");
    const isBot = r.type === "bot" || r.id?.startsWith("botc_");
    const isGroup = r.type === "group" || (!isDM && !isBot && (r.id?.startsWith("g_") || r.id?.startsWith("g-")));
    let avatar = "";
    let avatarCrop = null;
    let color = "";
    let avatarText = "";
    let memberTiles = null;
    let identity = null;
    let statusBadge = undefined;
    if (isGroup) {
      if (!state.conversationMembersCache.has(r.id)) {
        ensureConversationMembers(r.id, { renderOnHydrate: true });
      }
      const records = state.conversationMembersCache.get(r.id) || [];
      memberTiles = window.miaGroupTiles.resolveGroupMemberTiles(records, groupTilesCtx());
    } else if (isDM) {
      const parts = r.id.split(":");
      const otherId = parts[1] === state.user?.id ? parts[2] : parts[1];
      const friend = friendById(otherId);
      const displayName = friend?.displayName || friend?.username || friend?.account || otherId || "好友";
      const resolved = userAvatarForContact(friend, otherId, displayName);
      avatar = resolved.image;
      avatarCrop = resolved.crop;
      color = resolved.color;
      avatarText = resolved.text;
      identity = friend?.identity || friend || null;
      statusBadge = statusBadgeFrom(identity, friend);
    } else if (isBot) {
      const botKey = sessionHistory.botId(r);
      const fa = botAvatarFor(r, botKey);
      if (fa) {
        avatar = fa.image;
        avatarCrop = fa.crop;
        color = fa.color;
        avatarText = fa.text;
      }
      const bot = botByKey(botKey);
      const members = state.conversationMembersCache.get(r.id) || [];
      const member = members.find((m) => m.member_kind === MemberKind.Bot && m.member_ref === botKey);
      identity = bot || member?.identity || null;
      statusBadge = statusBadgeFrom(identity, bot, member?.identity, member);
    }
    return {
      kind: "conversation",
      id: r.id,
      title: conversationDisplayTitle(r),
      preview: conversationLastMessageText(r),
      sortKey: conversationSortKey(r),
      isDM,
      isBot,
      isGroup,
      avatar,
      avatarCrop,
      color,
      avatarText,
      identity,
      statusBadge,
      memberTiles,
      tags: conversationTagsFor(r.id),
      pinned: isConversationPinned(r.id)
    };
  });
  // (Phase 4 cutover: workspace conversations gone — every conversation
  //  is a conversation.)
  return conversation.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.sortKey - a.sortKey;
  });
}

function renderConversationList() {
  const query = String(els.conversationSearch.value || "").trim().toLowerCase();
  const all = combinedConversationItems();
  const items = query
    ? all.filter((it) => (
        it.title.toLowerCase().includes(query)
        || (Array.isArray(it.tags) && it.tags.some((tag) => String(tag.name || "").toLowerCase().includes(query)))
      ))
    : all;

  if (!items.length) {
    const empty = state.user
      ? "没有会话。点击右上 + 添加好友或发起群聊；或在桌面端登录同账号并点同步。"
      : "请先登录。";
    els.conversationList.innerHTML = `<p class="persona-empty">${empty}</p>`;
    return;
  }

  els.conversationList.innerHTML = items.map((it) => {
    const avatarLabel = it.avatarText || avatarResolve.identityDisplayText(it.title, "?");
    let color = "#5e5ce6";
    if (it.kind === "conversation") color = it.color || (it.isDM ? "#5e5ce6" : "#34c759");
    if (it.kind === "desktop") color = it.color || "#ff9f0a";
    // Group conversations: paint a mosaic from real member avatars. The tile
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
          color: fallback,
          text: tile.text
        });
      }).join("");
      avatarMarkup = `<span class="avatar group-avatar" data-count="${tiles.length}">${tileSpans}</span>`;
    } else {
      avatarMarkup = avatarHtmlForConversation(it, color, avatarLabel);
    }
    // ⋯ menu: workspace conversations + cloud conversations (PATCH/DELETE /api/conversations
    // shipped — see commit 90671e4). Pin uses local storage; rename + delete
    // hit the cloud.
    const hasMenu = it.kind === "desktop" || it.kind === "conversation";
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
            <strong class="persona-name">${it.pinned ? "📌 " : ""}${renderNameWithBadgeHtml({ name: it.title, identity: it.identity, statusBadge: it.statusBadge })}</strong>
            <span class="persona-preview">${tagChipsHtml(it.tags)}${escapeHtml(it.preview)}</span>
          </span>
          ${sideHtml}
        </button>
        ${hasMenu ? `<button class="persona-more" type="button" data-conv-more="${escapeHtml(it.id)}" aria-label="更多操作" title="更多操作">⋯</button>` : ""}
      </div>
    `;
  }).join("");
  hydrateAvatarVideos(els.conversationList);
  initStatusBadgeLotties(els.conversationList);
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
function safeTagColor(color) {
  const text = String(color || "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : "#64748b";
}

function conversationTagsFor(conversationId) {
  if (!conversationId) return [];
  return conversationTagsApi.tagsForTarget(normalizeWebSettings(state.settings, state.settings).tags, conversationId);
}

function tagChipsHtml(tags) {
  const items = Array.isArray(tags) ? tags.slice(0, 2) : [];
  if (!items.length) return "";
  return `<span class="persona-tags">${items.map((tag) => {
    const name = String(tag?.name || "").trim();
    if (!name) return "";
    return `<span class="persona-tag-chip" style="--tag-color:${safeTagColor(tag?.color)}">${escapeHtml(name)}</span>`;
  }).join("")}</span>`;
}

async function setConversationTagNames(conversationId, names) {
  if (!conversationId) return;
  const base = normalizeWebSettings(state.settings, state.settings);
  const tags = conversationTagsApi.assignTagNames(base.tags, conversationId, names);
  await pushSettings({ tags });
}

async function editConversationTags(conversation) {
  if (!conversation || !conversation.id || typeof window.prompt !== "function") return;
  const current = conversationTagsFor(conversation.id).map((tag) => tag.name).join(", ");
  const title = conversationDisplayTitle(conversation);
  const input = window.prompt(`给「${title}」设置标签（逗号分隔）`, current);
  if (input === null) return;
  const names = String(input || "").split(/[,，]/).map((part) => part.trim()).filter(Boolean);
  await setConversationTagNames(conversation.id, names);
  renderConversationList();
}

function isConversationPinned(conversationId) {
  if (!conversationId) return false;
  return Array.isArray(state.settings?.pins) && state.settings.pins.includes(conversationId);
}
async function setConversationPinned(conversationId, pinned) {
  if (!conversationId) return;
  const current = Array.isArray(state.settings?.pins) ? state.settings.pins : [];
  const nextPins = pinned ? [...new Set([...current, conversationId])] : current.filter((id) => id !== conversationId);
  await pushSettings({ pins: nextPins });
}

// Optimistic settings update with CAS retry. Stages the patch locally,
// PUTs with expectedVersion; on 409 conflict re-reads server state,
// merges our delta on top (last-writer-wins per field), retries once.
async function pushSettings(patch, _retried = false) {
  const base = normalizeWebSettings(state.settings, state.settings);
  const next = {
    pins: patch.pins !== undefined ? patch.pins : base.pins,
    readMarks: patch.readMarks !== undefined ? { ...(base.readMarks || {}), ...patch.readMarks } : base.readMarks,
    appearance: patch.appearance !== undefined ? { ...(base.appearance || {}), ...patch.appearance } : base.appearance,
    tags: patch.tags !== undefined ? conversationTagsApi.normalizeConversationTags(patch.tags) : base.tags,
    expectedVersion: base.version || 0
  };
  state.settings = normalizeWebSettings({ ...next, version: base.version, updatedAt: base.updatedAt }, base);
  renderConversationList();
  try {
    const res = await api("/api/me/settings", { method: "PUT", body: next });
    if (res?.settings) state.settings = normalizeWebSettings(res.settings, state.settings);
  } catch (err) {
    // /HTTP 409/ → conflict: server state moved on; refresh + retry once
    // with patch reapplied so our delta isn't lost.
    if (!_retried && /409|version conflict/i.test(String(err?.message || ""))) {
      try {
        const fresh = await api("/api/me/settings", { method: "GET" });
        if (fresh?.settings) state.settings = normalizeWebSettings(fresh.settings, state.settings);
        return pushSettings(patch, true);
      } catch { /* fall through */ }
    }
    console.warn("[web] settings PUT failed:", err);
  }
}

function openConvMenu(convId, anchorButton) {
  const el = ensureConvMenuEl();
  _convMenuTargetId = convId;
  const conversation = state.conversations.find((r) => r.id === convId);
  if (!conversation) return;
  const isBot = conversation.type === "bot" || convId.startsWith("botc_");
  const pinned = isConversationPinned(convId);
  const showRename = isBot;
  el.innerHTML = `
    <button type="button" data-conv-action="pin">${pinned ? "取消置顶" : "置顶"}</button>
    <button type="button" data-conv-action="tags">标签...</button>
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
//  routes through handleConversationAction now.)

async function handleConvAction(action, convId) {
  const conversation = state.conversations.find((r) => r.id === convId);
  if (conversation) return handleConversationAction(action, conversation);
}

async function handleConversationAction(action, conversation) {
  const title = conversationDisplayTitle(conversation);
  if (action === "pin") {
    await setConversationPinned(conversation.id, !isConversationPinned(conversation.id));
    return;
  }
  if (action === "tags") {
    await editConversationTags(conversation);
    return;
  }
  if (action === "rename") {
    const isBot = conversation.type === "bot" || conversation.id.startsWith("botc_");
    if (!isBot) return;
    const botId = sessionHistory.botId(conversation);
    if (!botId) return;
    const existing = state.bots.find((bot) => String(bot.id || bot.key || "") === botId) || {};
    const currentName = existing.displayName || existing.display_name || existing.name || conversationDisplayTitle(conversation);
    const next = window.prompt("编辑智能体名称：", currentName || "");
    if (next === null) return;
    const trimmed = String(next).trim();
    if (!trimmed) return;
    try {
      const body = {
        name: trimmed,
        color: existing.color || "",
        avatarImage: existing.avatarImage || existing.avatar_image || "",
        avatarCrop: existing.avatarCrop || existing.avatar_crop || null,
        statusBadge: existing.statusBadge || existing.status_badge || null,
        bio: existing.bio || existing.description || "",
        personaText: existing.personaText || existing.persona_text || existing.bio || existing.description || "",
        capabilities: existing.capabilities || { legacyCapabilities: ["chat", "files", "terminal", "code"] }
      };
      const res = await api(`/api/me/bots/${encodeURIComponent(botId)}`, { method: "PUT", body });
      const savedBot = res.bot || { ...existing, id: botId, key: botId, name: trimmed };
      state.bots = [savedBot, ...state.bots.filter((bot) => String(bot.id || bot.key || "") !== botId)];
      state.conversations = state.conversations.map((r) => (r.id === conversation.id ? { ...r, name: trimmed, title: trimmed } : r));
      renderConversationList();
      renderActiveChat();
    } catch (err) {
      showToast(err.message || "编辑失败");
    }
    return;
  }
  if (action === "delete") {
    if (!window.confirm(`确认删除"${title}"？此操作不可撤销，所有成员都将无法访问。`)) return;
    try {
      await api(`/api/conversations/${conversation.id}`, { method: "DELETE" });
      state.conversations = state.conversations.filter((r) => r.id !== conversation.id);
      state.unread.delete(conversation.id);
      state.conversationMembersCache.delete(conversation.id);
      if (state.activeConversationId === conversation.id) state.activeConversationId = "";
      renderConversationList();
      renderActiveChat();
    } catch (err) {
      showToast(err.message || "删除失败");
    }
    return;
  }
}

// ── active chat view ───────────────────────────────────────────────────────

function buildConversationMessageArticle(msg, conversation) {
  // Sender resolution routes through the canonical adapter (cloud-conversation-source).
  // Web reads only MessageSpec fields — no schema branching here.
  const members = state.conversationMembersCache.get(conversation.id) || [];
  const ctx = { self: state.user, friends: state.friends, bots: state.bots };
  const source = window.miaCloudConversationSource.createCloudConversationSource({
    conversation, messages: [msg], members, ctx
  });
  const spec = source.listMessages()[0];
  const isOwn = spec.isOwn;
  const senderLabel = spec.authorName;
  const senderAvatar = spec.avatar?.image || "";
  const senderCrop = spec.avatar?.crop || null;
  const senderColor = spec.avatar?.color || window.miaMemberColor.memberAccentColor(msg.sender_ref || senderLabel);
  const isGroup = conversation.type === "group"
    || (!conversation.id?.startsWith("dm:") && !conversation.id?.startsWith("botc_") && (conversation.id?.startsWith("g_") || conversation.id?.startsWith("g-")));
  const cls = `${isOwn ? "message user" : "message assistant"}${isGroup ? " group-message" : ""}`;
  const fallbackText = spec.avatar?.text || avatarResolve.identityDisplayText(isOwn ? state.user?.username : senderLabel, "?");
  const avatarColor = senderColor;
  const avatarMarkup = avatarHtml({
    className: "avatar",
    image: senderAvatar,
    crop: senderCrop,
    color: avatarColor,
    text: fallbackText
  });
  const senderTitleHtml = senderLabel && !isOwn
    ? `<span class="bubble-sender" style="color:${escapeHtml(senderColor)};">${renderNameWithBadgeHtml({
        name: senderLabel,
        identity: spec.authorIdentity,
        statusBadge: spec.statusBadge
      })}</span>`
    : "";
  const renderedBody = spec.bodyMd ? renderMarkdown(spec.bodyMd) : "";
  const highlightedBody = renderedBody && window.miaMentionRender
    ? window.miaMentionRender.highlightMentions(renderedBody, members || [])
    : renderedBody;
  const contentBlocks = !isOwn ? contentBlocksFromMessage(msg) : [];
  let renderedFirstTextBlock = false;
  const orderedBlocksHtml = contentBlocks.length && window.miaTraceBlocks?.renderAssistantContentBlocks
    ? window.miaTraceBlocks.renderAssistantContentBlocks({
      blocks: contentBlocks,
      expanded: false,
      scopeKey: `web-msg:${msg.id || msg.seq || ""}`,
      renderTextBlock(block) {
        const prefixHtml = renderedFirstTextBlock ? "" : senderTitleHtml;
        renderedFirstTextBlock = true;
        const renderedBlock = block.text ? renderMarkdown(block.text) : "";
        const highlightedBlock = renderedBlock && window.miaMentionRender
          ? window.miaMentionRender.highlightMentions(renderedBlock, members || [])
          : renderedBlock;
        return highlightedBlock ? `<div class="bubble">${prefixHtml}${highlightedBlock}</div>` : "";
      }
    })
    : "";
  const bodyHtml = spec.bodyMd ? `<div class="bubble">${senderTitleHtml}${highlightedBody}</div>` : "";
  const attachmentHtml = renderAttachmentChips(spec.attachments || msg.attachments || []);
  const trace = !isOwn ? (orderedBlocksHtml ? "" : parseTraceJson(msg.trace_json || msg.trace)) : null;
  const traceHtml = trace
    ? window.miaTraceBlocks.renderTraceBlocks({
      reasoning: trace.reasoning,
      tools: trace.tools,
      content: spec.bodyMd || "",
      expanded: false,
      scopeKey: `web-msg:${msg.id || msg.seq || ""}`,
    })
    : "";
  return `
    <article class="${cls}" data-message-id="${escapeHtml(messageStableId(msg))}">
      ${avatarMarkup}
      <div class="message-stack">
        ${traceHtml}
        ${orderedBlocksHtml || bodyHtml}
        ${attachmentHtml}
        <span class="message-time">${escapeHtml(formatMessageTime(spec.createdAt))}</span>
      </div>
    </article>
  `;
}

function buildCloudAgentStreamingArticle(conversation, run) {
  if (!conversation || !run) return "";
  // Typing-only state ("running" with no body yet) renders as header dots,
  // not a placeholder bubble in the message stream. See renderActiveChat.
  if (!run.text && !run.tools.length && !run.reasoning && !(Array.isArray(run.contentBlocks) && run.contentBlocks.length)) return "";
  const botKey = run.botId || sessionHistory.botId(conversation) || "mia";
  const msg = {
    id: `cloud-agent-stream-${run.runId || conversation.id}`,
    sender_kind: "bot",
    sender_ref: botKey,
    body_md: runDisplayText(run),
    created_at: run.createdAt || new Date().toISOString(),
    seq: 0,
  };
  const members = state.conversationMembersCache.get(conversation.id) || [];
  const ctx = { self: state.user, friends: state.friends, bots: state.bots };
  const source = window.miaCloudConversationSource.createCloudConversationSource({ conversation, messages: [msg], members, ctx });
  const spec = source.listMessages()[0];
  const avatar = spec.avatar || {};
  const avatarMarkup = avatarHtml({
    className: "avatar",
    image: avatar.image,
    crop: avatar.crop,
    color: avatar.color || "#5e5ce6",
    text: avatar.text || avatarResolve.identityDisplayText(spec.authorName, "?")
  });
  const displayText = runDisplayText(run);
  const textHtml = displayText ? `<div class="bubble">${renderMarkdown(displayText)}</div>` : "";
  const displayBlocks = displayedContentBlocksPayloadFromRun(run) || [];
  const orderedBlocksHtml = displayBlocks.length && window.miaTraceBlocks?.renderAssistantContentBlocks
    ? window.miaTraceBlocks.renderAssistantContentBlocks({
      blocks: displayBlocks,
      expanded: true,
      scopeKey: `web-run:${run.runId || conversation.id}`,
      renderTextBlock(block) {
        return block.text ? `<div class="bubble">${renderMarkdown(block.text)}</div>` : "";
      }
    })
    : "";
  const traceHtml = orderedBlocksHtml
    ? ""
    : window.miaTraceBlocks.renderTraceBlocks({
      reasoning: run.reasoning,
      tools: run.tools,
      content: displayText,
      expanded: true,
      scopeKey: `web-run:${run.runId || conversation.id}`,
    });
  const permissionHtml = permissionBannerHtml(run.permission);
  const isGroup = conversation.type === "group"
    || (!conversation.id?.startsWith("dm:") && !conversation.id?.startsWith("botc_") && (conversation.id?.startsWith("g_") || conversation.id?.startsWith("g-")));
  return `
    <article class="message assistant streaming${isGroup ? " group-message" : ""}">
      ${avatarMarkup}
      <div class="message-stack">${orderedBlocksHtml || `${traceHtml}${textHtml}`}${permissionHtml}</div>
    </article>
  `;
}

// Banner shown while a run is paused waiting for the owner to approve a tool.
// Buttons carry a decision in the shared allow_once / allow_always / deny
// vocabulary; the click handler POSTs it back to resume the run.
function permissionBannerHtml(permission) {
  if (!permission || !permission.runId) return "";
  const { PermissionDecision } = window.miaAgentPermissions || {};
  const allowOnce = PermissionDecision?.AllowOnce || "allow_once";
  const allowAlways = PermissionDecision?.AllowAlways || "allow_always";
  const deny = PermissionDecision?.Deny || "deny";
  const runId = escapeHtml(permission.runId);
  const tool = permission.toolName ? `<strong>${escapeHtml(permission.toolName)}</strong>` : "工具";
  const preview = permission.preview
    ? `<pre class="permission-preview">${escapeHtml(permission.preview)}</pre>`
    : "";
  return `
    <div class="permission-banner" data-permission-run="${runId}">
      <div class="permission-head">${tool} 请求执行，需要你批准</div>
      ${preview}
      <div class="permission-actions">
        <button type="button" class="permission-deny" data-permission-decision="${deny}">拒绝</button>
        <button type="button" class="permission-allow" data-permission-decision="${allowOnce}">允许</button>
        <button type="button" class="permission-always" data-permission-decision="${allowAlways}">始终允许</button>
      </div>
    </div>
  `;
}

// Send the owner's allow/deny decision back to the cloud, which resumes the run's
// Hermes worker. Clear the banner optimistically so the buttons can't double-fire.
async function respondToPermission(runId, decision) {
  if (!runId || !decision) return;
  const conversationId = state.activeConversationId;
  const run = state.cloudAgentRunsByConversation.get(conversationId);
  const prior = run && run.permission && run.permission.runId === runId ? run.permission : null;
  if (prior) {
    run.permission = null;
    renderActiveChat();
  }
  try {
    await api(`/api/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/approval`, {
      method: "POST",
      body: { decision }
    });
  } catch (error) {
    console.warn("[web] permission response failed:", error?.message || error);
    // The run is still paused on the worker — restore the banner so the owner
    // can retry instead of being stuck until Hermes' approval timeout fires.
    if (prior && run && !run.permission) {
      run.permission = prior;
      if (conversationId === state.activeConversationId) renderActiveChat();
    }
  }
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

// (buildDesktopMessageArticle removed in Phase 4 cutover — bot chats
//  render through buildConversationMessageArticle now.)

function setComposerEnabled(enabled, placeholder) {
  els.chatInput.disabled = !enabled;
  els.sendButton.disabled = !enabled;
  if (placeholder) els.chatInput.placeholder = placeholder;
  updateSendButtonState();
}

function activeConversationRun() {
  const conversationId = state.activeConversationId;
  if (!conversationId) return null;
  return state.cloudAgentRunsByConversation.get(conversationId) || null;
}

function updateSendButtonState() {
  if (!els.sendButton) return;
  const activeRun = activeConversationRun();
  const running = activeRun?.status === "running";
  const cancelling = activeRun?.status === "cancelling";
  const busy = running || cancelling;
  const title = cancelling ? "正在停止" : (running ? "停止生成" : "发送");
  els.sendButton.classList.toggle("stop", busy);
  els.sendButton.classList.toggle("stopping", cancelling);
  els.sendButton.title = title;
  els.sendButton.setAttribute("aria-label", title);
  els.sendButton.disabled = cancelling || (!running && els.chatInput.disabled);
}

async function stopActiveCloudRun() {
  const conversationId = state.activeConversationId;
  const activeRun = activeConversationRun();
  if (!conversationId || !activeRun?.runId || activeRun.status !== "running") return;
  activeRun.status = "cancelling";
  activeRun.permission = null;
  renderActiveChat();
  try {
    await api(`/api/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(activeRun.runId)}/cancel`, {
      method: "POST"
    });
  } catch (error) {
    activeRun.status = "running";
    showToast(error?.message || "停止失败");
    if (conversationId === state.activeConversationId) renderActiveChat();
  }
}

async function submitActiveComposer() {
  const activeRun = activeConversationRun();
  if (activeRun?.status === "running") {
    await stopActiveCloudRun();
    return;
  }
  if (activeRun?.status === "cancelling") return;
  await sendInActive();
}

function renderActiveChat() {
  const id = state.activeConversationId;
  if (!id) {
    els.activeAvatar.style.backgroundImage = "";
    els.activeAvatar.style.backgroundColor = "transparent";
    els.activeAvatar.textContent = "";
    els.activeTitle.textContent = "Mia";
    setText(els.activeMeta, "选择一个会话开始聊天");
    els.chat.innerHTML = `<p class="persona-empty">还没有选中的会话。</p>`;
    setComposerEnabled(false, "选择一个会话开始聊天");
    renderComposerControls(null);
    state.sessionMenuOpen = false;
    renderSessionMenu();
    resetActiveChatRenderMemory();
    return;
  }

  if (isConversationId(id)) {
    const conversation = state.conversations.find((r) => r.id === id);
    if (!conversation) {
      setComposerEnabled(false, "会话不存在");
      renderComposerControls(null);
      state.sessionMenuOpen = false;
      renderSessionMenu();
      resetActiveChatRenderMemory();
      return;
    }
    const title = conversationDisplayTitle(conversation);
    const conversationType = conversationTypeForControls(conversation);
    const isDM = conversationType === "dm";
    const isBot = conversationType === "bot";
    const isGroup = !isDM && !isBot;
    if (isGroup) {
      // Group conversations need the same stacked-tile mosaic the sidebar
      // paints (combinedConversationItems uses miaGroupTiles for this), so
      // the chat-header avatar matches the row the user just clicked.
      // applyAvatarMedia only knows the single-image case; we paint tiles
      // directly into els.activeAvatar instead.
      if (!state.conversationMembersCache.has(conversation.id)) {
        ensureConversationMembers(conversation.id, { renderOnHydrate: true });
      }
      const records = state.conversationMembersCache.get(conversation.id) || [];
      const tiles = window.miaGroupTiles.resolveGroupMemberTiles(records, groupTilesCtx());
      const tileSpans = tiles.map((tile) => avatarHtml({
        className: "group-avatar-tile",
        image: tile.image,
        crop: tile.crop,
        color: tile.color || "#5e5ce6",
        text: tile.text
      })).join("");
      els.activeAvatar.className = "avatar group-avatar";
      els.activeAvatar.setAttribute("data-count", String(tiles.length));
      els.activeAvatar.removeAttribute("style");
      els.activeAvatar.textContent = "";
      els.activeAvatar.innerHTML = tileSpans;
      hydrateAvatarVideos(els.activeAvatar);
    } else {
      let peerAvatar = "";
      let peerCrop = null;
      let peerColor = "";
      let peerText = "";
      if (isDM) {
        const parts = conversation.id.split(":");
        const otherId = parts[1] === state.user?.id ? parts[2] : parts[1];
        const friend = friendById(otherId);
        const resolved = userAvatarForContact(friend, otherId, friend?.displayName || friend?.username || friend?.account || title);
        peerAvatar = resolved.image;
        peerCrop = resolved.crop;
        peerColor = resolved.color;
        peerText = resolved.text;
      } else {
        const fa = botAvatarFor(conversation, botKeyForConversation(conversation));
        peerAvatar = fa?.image || "";
        peerCrop = fa?.crop || null;
        peerColor = fa?.color || "";
        peerText = fa?.text || avatarResolve.identityDisplayText(title, "?");
      }
      // Reset any leftover group state from a previous render.
      els.activeAvatar.className = "avatar";
      els.activeAvatar.removeAttribute("data-count");
      els.activeAvatar.innerHTML = "";
      applyAvatarMedia(
        els.activeAvatar,
        peerAvatar,
        peerCrop,
        peerColor || (isDM ? "#5e5ce6" : "#ff9f0a"),
        peerText
      );
    }
    els.activeTitle.textContent = title;
    const activeRun = state.cloudAgentRunsByConversation.get(conversation.id);
    if (activeRun?.status === "running" || activeRun?.status === "cancelling") {
      const statusText = activeRun.status === "cancelling" ? "正在停止" : "正在输入";
      els.activeMeta.innerHTML = `<span class="typing-status">${statusText}<span class="typing-dots"><i></i><i></i><i></i></span></span>`;
    } else {
      setText(els.activeMeta, isDM ? "私聊" : isBot ? "AI 私聊" : "群聊");
    }
    renderSessionMenu();
    renderComposerControls(conversation);
    const cached = state.messageCache.get(conversation.id);
    const messages = cached?.messages || [];
    const streaming = buildCloudAgentStreamingArticle(conversation, state.cloudAgentRunsByConversation.get(conversation.id));
    const isConversationSwitch = state.lastRenderedConversationId !== conversation.id;
    const isFirstMessageHydration = !isConversationSwitch
      && state.lastRenderedConversationMessageCount === 0
      && messages.length > 0;
    const previousRenderedMessageIds = isConversationSwitch ? [] : state.lastRenderedConversationMessageIds;
    const currentMessageIds = messageStableIds(messages);
    const prevScrollTop = els.chat.scrollTop;
    const startBottomGap = chatBottomGap(els.chat);
    const nearBottom = isChatPinnedToBottom(els.chat);
    const stickToBottom = isConversationSwitch || isFirstMessageHydration || nearBottom;
    const shouldAnimateTail = !isConversationSwitch
      && !isFirstMessageHydration
      && nearBottom
      && !prefersReducedMotion();
    const tailMessageIds = shouldAnimateTail
      ? tailMessageIdsAddedToEnd(previousRenderedMessageIds, currentMessageIds)
      : [];
    els.chat.innerHTML = messages.length
      ? `${messages.map((m) => buildConversationMessageArticle(m, conversation)).join("")}${streaming}`
      : `<p class="persona-empty">还没有消息。</p>`;
    if (!messages.length && streaming) els.chat.innerHTML = streaming;
    hydrateAvatarVideos(els.chat);
    initStatusBadgeLotties(els.chat);
    if (window.miaTraceBlocks?.markRenderedTraceBlocks) window.miaTraceBlocks.markRenderedTraceBlocks(els.chat);
    state.lastRenderedConversationId = conversation.id;
    state.lastRenderedConversationMessageIds = currentMessageIds;
    state.lastRenderedConversationMessageCount = messages.length;
    if (messages.length || streaming) {
      if (shouldAnimateTail && tailMessageIds.length) {
        animateRenderedTailMessages(els.chat, tailMessageIds, startBottomGap);
      } else if (stickToBottom) {
        scrollChatToBottom(els.chat);
      } else {
        els.chat.scrollTop = prevScrollTop;
      }
    }
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
  resetActiveChatRenderMemory();
}

async function hydrateActiveConversation(id) {
  if (!id || !isConversationId(id)) return;
  await ensureConversationMessages(id);
  await ensureConversationMembers(id);
  const conversation = state.conversations.find((item) => item.id === id);
  if (conversationTypeForControls(conversation) === "bot") {
    await ensureBotRuntime(botKeyForConversation(conversation), runtimeKindForBotConversation(conversation, botByKey(botKeyForConversation(conversation))));
  }
  if (state.activeConversationId !== id) return;
  // Phase 3: persist the read mark to cloud so other devices clear their badge.
  // readMarks are message seq cursors, so compute after ensureConversationMessages().
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
  const activeRun = activeConversationRun();
  if (activeRun?.status === "running") return stopActiveCloudRun();
  if (activeRun?.status === "cancelling") return;
  const rawText = els.chatInput.value || "";
  const members = isConversationId(id) ? (state.conversationMembersCache.get(id) || []) : [];
  let prepared;
  try {
    prepared = prepareOutgoingMessage({ text: rawText }, { members });
  } catch (err) {
    if (err && err.code === "EMPTY_MESSAGE") return;
    showToast(err.message);
    return;
  }
  const text = prepared.bodyMd;

  if (isConversationId(id)) {
    els.chatInput.value = "";
    try {
      const res = await api(`/api/conversations/${id}/messages`, {
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

  // (workspace conversation send removed — bot chats are conversations and
  //  go through the isConversationId branch above. If we ever want web-triggered
  //  agent execution for a bot conversation, dispatch a bridge run AFTER the
  //  /api/conversations/:id/messages POST above; the bridge handler now writes
  //  the assistant reply into the same conversation via messagesStore.)
}

// ── create cloud bot dialog ────────────────────────────────────────────────

let _createBotModal = null;
let _avatarCropModal = null;

function generateUntypedBotId(existingKeys = []) {
  const used = new Set(existingKeys.map((key) => String(key || "").trim()).filter(Boolean));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = String(window.miaIds?.generatePrincipalId?.() || "").trim();
    if (id && !used.has(id)) return id;
  }
  throw new Error("无法生成智能体账号 ID。");
}

function webBotDefaultDraft() {
  const cloudRuntime = webCloudAgentRuntime();
  return {
    name: "",
    personaText: "",
    avatarImage: "",
    avatarCrop: null,
    statusBadgeValue: "",
    runtimeTargetValue: webRuntimeTargetValue({ runtimeKind: "cloud-claude-code", agentEngine: cloudRuntime.agentEngine }),
    saving: false
  };
}

function setWebBotAvatarDraft(draft, image, crop = null) {
  const src = avatarResolve.normalizeAvatarImage(image);
  draft.avatarImage = src;
  draft.avatarCrop = src ? webNormalizeAvatarCrop(crop || webAvatarDefaultCropForSrc(src)) : null;
}

function renderWebBotAvatarPreview(root, draft) {
  const preview = root?.querySelector?.("#webBotAvatarPreview");
  if (!preview) return;
  applyAvatarMedia(preview, draft.avatarImage, draft.avatarCrop, "#eef0ff", avatarResolve.identityDisplayText(draft.name, "智能体"));
  preview.title = "点击调整头像";
}

function renderWebBotAvatarDefaults(root, draft) {
  void root;
  void draft;
}

function renderWebBotNameAndBadge(root, draft) {
  const nameText = root?.querySelector?.("#webBotNameText");
  const nameInput = root?.querySelector?.("#webBotName");
  const badgeTrigger = root?.querySelector?.("#webBotStatusBadgeTrigger");
  if (nameText) nameText.textContent = String(draft.name || "").trim() || "未命名智能体";
  if (nameInput) nameInput.value = draft.name || "";
  renderStatusBadgeGlyph(badgeTrigger, statusBadgeForPreset(draft.statusBadgeValue));
  root?.querySelectorAll?.("[data-web-bot-status-badge-choice]").forEach((button) => {
    button.classList.toggle("active", button.dataset.webBotStatusBadgeChoice === draft.statusBadgeValue);
  });
  initStatusBadgeLotties(root);
}

function readWebBotAvatarFile(file, draft, root) {
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
      setWebBotAvatarDraft(draft, editor.image, editor.crop);
      renderWebBotAvatarPreview(root, draft);
      renderWebBotAvatarDefaults(root, draft);
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

function webRuntimeTargetValue(target = {}) {
  const isCloud = ["cloud-claude-code", "cloud-hermes"].includes(String(target.runtimeKind || "").trim());
  return JSON.stringify({
    runtimeKind: target.runtimeKind === "desktop-local" && !isCloud ? "desktop-local" : "cloud-claude-code",
    deviceId: String(target.deviceId || target.targetDeviceId || "").trim(),
    deviceName: String(target.deviceName || target.targetDeviceName || "").trim(),
    agentEngine: target.runtimeKind === "desktop-local" && !isCloud
      ? normalizeAgentEngine(target.agentEngine || "hermes")
      : normalizeWebCloudAgentRuntime({ runtimeKind: "cloud-claude-code", agentEngine: target.agentEngine }).agentEngine
  });
}

function parseWebRuntimeTarget(value = "") {
  try {
    const parsed = JSON.parse(String(value || ""));
    const runtimeKind = parsed.runtimeKind === "desktop-local" ? "desktop-local" : "cloud-claude-code";
    return {
      runtimeKind,
      deviceId: runtimeKind === "desktop-local" ? String(parsed.deviceId || "").trim() : "",
      deviceName: runtimeKind === "desktop-local" ? String(parsed.deviceName || "").trim() : "Mia Cloud",
      agentEngine: runtimeKind === "desktop-local"
        ? normalizeAgentEngine(parsed.agentEngine || "hermes")
        : normalizeWebCloudAgentRuntime({ runtimeKind: "cloud-claude-code", agentEngine: parsed.agentEngine }).agentEngine
    };
  } catch {
    return { runtimeKind: "cloud-claude-code", deviceId: "", deviceName: "Mia Cloud", agentEngine: "" };
  }
}

function webDeviceEngineIds(device = {}) {
  const advertised = Array.isArray(device.capabilities?.engines)
    ? device.capabilities.engines.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const supported = advertised.map(normalizeAgentEngine)
    .filter((id) => ["hermes", "claude-code", "codex", "openclaw"].includes(id));
  if (supported.length) return [...new Set(supported)];
  const engine = String(device.engine || "").trim();
  return ["hermes", "claude-code", "codex", "openclaw"].includes(engine) ? [engine] : [];
}

function webDeviceStatusLabel(device = {}) {
  if (device.status === "online") return "在线";
  if (device.status === "offline") return "离线";
  return "在线";
}

function webCompactDeviceName(value = "") {
  return String(value || "")
    .trim()
    .replace(/\s*(?:·|-)?\s*Mia\s+(?:Desktop|Bridge)(?=\s*(?:·|-|$))/gi, "")
    .replace(/\.local(?=\s|$)/gi, "")
    .replace(/\s*(?:·|-)\s*(?:本机|在线|离线)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function webRuntimeDeviceDisplayName(device = {}) {
  return webCompactDeviceName(device.deviceName || device.device_name || device.name || "") || String(device.id || "").trim() || "设备";
}

function webRuntimeDeviceGroupLabel(device = {}) {
  const name = webRuntimeDeviceDisplayName(device);
  const status = webDeviceStatusLabel(device);
  return status && status !== name ? `${name} · ${status}` : name;
}

function webRuntimeTargetGroups() {
  const cloudRuntime = webCloudAgentRuntime();
  const groups = [{
    label: "Mia Cloud",
    options: [{
      runtimeKind: "cloud-claude-code",
      deviceId: "",
      deviceName: "Mia Cloud",
      agentEngine: cloudRuntime.agentEngine,
      label: cloudRuntime.label || "云端内核未同步",
      disabled: !cloudRuntime.available
    }]
  }];
  for (const device of state.bridgeDevices || []) {
    const deviceName = webRuntimeDeviceDisplayName(device);
    const options = webDeviceEngineIds(device).map((engine) => ({
      runtimeKind: "desktop-local",
      deviceId: String(device.id || "").trim(),
      deviceName,
      agentEngine: engine,
      label: engineLabel(engine)
    }));
    if (!options.length) continue;
    groups.push({ label: webRuntimeDeviceGroupLabel(device), options });
  }
  return groups;
}

function webRuntimeTargetOptionsHtml(selectedValue = "") {
  return webRuntimeTargetGroups().map((group) => `
    <optgroup label="${escapeHtml(group.label)}">
      ${group.options.map((option) => {
        const value = webRuntimeTargetValue(option);
        return `<option value="${escapeHtml(value)}"${value === selectedValue ? " selected" : ""}${option.disabled ? " disabled" : ""}>${escapeHtml(option.label)}</option>`;
      }).join("")}
    </optgroup>
  `).join("");
}

function webRuntimeConfigForTarget(target = {}) {
  if (target.runtimeKind === "cloud-claude-code") {
    const cloudRuntime = webRequireCloudAgentRuntime();
    return {
      agentEngine: cloudRuntime.agentEngine,
      model: state.platformModels[0]?.value || "mia-auto",
      effortLevel: "medium",
      permissionMode: "bypassPermissions"
    };
  }
  const engine = normalizeAgentEngine(target.agentEngine || "hermes");
  const effortEntries = effortOptions(engine);
  const defaultEffort = effortEntries.find((entry) => entry.value === "medium")?.value || effortEntries[0]?.value || "medium";
  const config = {
    agentEngine: engine,
    deviceId: String(target.deviceId || "").trim(),
    deviceName: webCompactDeviceName(target.deviceName || ""),
    model: "",
    effortLevel: defaultEffort
  };
  if (!isExternalAgentEngine(engine)) config.permissionMode = "ask";
  return config;
}

function webRuntimeLabelForTarget(target = {}) {
  return target.runtimeKind === "cloud-claude-code" ? "Mia Cloud" : (webCompactDeviceName(target.deviceName || "") || "桌面设备");
}

async function saveBotFromWeb(draft) {
  const name = String(draft.name || "").trim();
  if (!name) throw new Error("请输入智能体名称。");
  const target = parseWebRuntimeTarget(draft.runtimeTargetValue);
  const runtimeKind = target.runtimeKind;
  const runtimeConfig = webRuntimeConfigForTarget(target);
  const key = generateUntypedBotId(state.bots.map((bot) => bot.id || bot.key));
  const identity = {
    name,
    color: "#2563eb",
    avatarImage: draft.avatarImage || "",
    avatarCrop: draft.avatarCrop,
    statusBadge: statusBadgeForPreset(draft.statusBadgeValue),
    bio: draft.personaText || "",
    personaText: draft.personaText || "",
    capabilities: { legacyCapabilities: ["chat", "files", "terminal", "code"] }
  };
  const saved = await api(`/api/me/bots/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: identity
  });
  const runtime = await api(`/api/me/bots/${encodeURIComponent(key)}/runtime`, {
    method: "PUT",
    body: {
      runtimeKind,
      enabled: true,
      activate: true,
      config: runtimeConfig
    }
  });
  const ensured = await api(`/api/me/bot-conversations/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: {
      botId: key,
      title: name,
      runtimeKind
    }
  });
  const binding = runtime.binding || { botId: key, runtimeKind, enabled: true, config: runtimeConfig };
  const bindingConfig = binding.config || runtimeConfig;
  const bot = {
    ...(saved.bot || identity),
    key,
    id: key,
    runtimeKind: binding.runtimeKind || runtimeKind,
    runtimeConfig: bindingConfig,
    agentEngine: (binding.runtimeKind || runtimeKind) === "cloud-claude-code" ? (bindingConfig.agentEngine || target.agentEngine) : (bindingConfig.agentEngine || target.agentEngine),
    targetDeviceId: bindingConfig.deviceId || "",
    targetDeviceName: bindingConfig.deviceName || "",
    runtimeLabel: webRuntimeLabelForTarget(target)
  };
  state.bots = [bot, ...state.bots.filter((item) => String(item.id || item.key || "") !== key)];
  if (runtime.binding) state.botRuntimeCache.set(runtimeCacheKey(key, bot.runtimeKind), runtime.binding);
  if (ensured.conversation) {
    state.conversations = [ensured.conversation, ...state.conversations.filter((conversation) => conversation.id !== ensured.conversation.id)];
    if (Array.isArray(ensured.members)) state.conversationMembersCache.set(ensured.conversation.id, ensured.members);
  }
  return { key, bot, conversation: ensured.conversation || null };
}

function openCreateBotDialog() {
  if (!_createBotModal) {
    _createBotModal = document.createElement("section");
    _createBotModal.className = "settings-modal web-bot-dialog";
    document.body.appendChild(_createBotModal);
  }
  state.createMenuOpen = false;
  renderCreateMenu();
  const draft = webBotDefaultDraft();
  _createBotModal.classList.remove("hidden");

  function close() {
    _createBotModal.classList.add("hidden");
    document.removeEventListener("keydown", onEsc);
    _createBotModal.removeEventListener("click", onBackdrop);
  }
  function onEsc(event) {
    if (event.key === "Escape") close();
  }
  function onBackdrop(event) {
    if (event.target === _createBotModal) close();
  }

  function render() {
    _createBotModal.innerHTML = `
      <form id="webCreateBotForm" class="bot-form">
        <header class="bot-dialog-head">
          <div>
            <h2>创建智能体</h2>
          </div>
          <button class="icon-button" type="button" data-action="close" title="关闭" aria-label="关闭">×</button>
        </header>
        <section class="identity-name-field">
          <span class="identity-name-label">姓名</span>
          <div class="identity-name-line">
            <button id="webBotNameText" class="identity-name-text" type="button">${escapeHtml(draft.name || "未命名智能体")}</button>
            <input id="webBotName" class="identity-name-input hidden" autocomplete="off" value="${escapeHtml(draft.name)}">
            <details id="webBotStatusBadgeDetails" class="identity-badge-details accordion-details">
              <summary id="webBotStatusBadgeTrigger" class="identity-badge-trigger" title="徽章" aria-label="徽章"></summary>
              <div class="accordion-body identity-badge-panel">
                <div class="identity-badge-choices">
                  ${statusBadgeChoiceButtonsHtml("data-web-bot-status-badge-choice", "web-bot")}
                </div>
              </div>
            </details>
          </div>
        </section>
        <label>
          运行位置和 Agent 内核
          <select id="webBotRuntimeTarget" class="web-bot-runtime-select">
            ${webRuntimeTargetOptionsHtml(draft.runtimeTargetValue)}
          </select>
        </label>
        <section class="avatar-picker">
          <div id="webBotAvatarPreview" class="avatar-crop-preview" role="button" tabindex="0" aria-label="调整头像"></div>
          <div id="webBotAvatarDrop" class="avatar-drop">
            <input id="webBotAvatarFile" type="file" accept="image/*,video/*" class="hidden">
            <button id="webChooseBotAvatar" class="secondary avatar-file-button" type="button" title="选择图片" aria-label="选择图片">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12"/></svg>
              选择图片
            </button>
            <span>也可以把图片拖到这里</span>
          </div>
        </section>
        <details class="persona-details">
          <summary>人设</summary>
          <label>
            <span>会保存在 Mia Cloud，并作为该智能体的系统人设注入。</span>
            <textarea id="webBotSeed" placeholder="可留空，后续在对话中慢慢形成">${escapeHtml(draft.personaText)}</textarea>
          </label>
        </details>
        <footer class="bot-dialog-actions">
          <button class="secondary" type="button" data-action="close">取消</button>
          <button class="primary" type="submit" ${draft.saving ? "disabled" : ""}>${draft.saving ? "保存中..." : "保存智能体"}</button>
        </footer>
      </form>
    `;
    renderWebBotAvatarPreview(_createBotModal, draft);
    renderWebBotAvatarDefaults(_createBotModal, draft);
    renderWebBotNameAndBadge(_createBotModal, draft);
    const nameInput = _createBotModal.querySelector("#webBotName");
    const nameText = _createBotModal.querySelector("#webBotNameText");
    const seedInput = _createBotModal.querySelector("#webBotSeed");
    const runtimeSelect = _createBotModal.querySelector("#webBotRuntimeTarget");
    const fileInput = _createBotModal.querySelector("#webBotAvatarFile");
    const drop = _createBotModal.querySelector("#webBotAvatarDrop");
    nameText?.addEventListener("click", () => {
      nameText.classList.add("hidden");
      nameInput?.classList.remove("hidden");
      nameInput?.focus();
      nameInput?.select?.();
    });
    nameInput?.addEventListener("input", () => {
      draft.name = nameInput.value;
      renderWebBotNameAndBadge(_createBotModal, draft);
    });
    nameInput?.addEventListener("blur", () => {
      nameInput.classList.add("hidden");
      nameText?.classList.remove("hidden");
      renderWebBotNameAndBadge(_createBotModal, draft);
    });
    nameInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        nameInput.blur();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        nameInput.blur();
      }
    });
    _createBotModal.querySelectorAll("[data-web-bot-status-badge-choice]").forEach((button) => {
      button.addEventListener("click", () => {
        draft.statusBadgeValue = button.dataset.webBotStatusBadgeChoice || "";
        const details = _createBotModal.querySelector("#webBotStatusBadgeDetails");
        if (details) details.open = false;
        renderWebBotNameAndBadge(_createBotModal, draft);
      });
    });
    seedInput?.addEventListener("input", () => { draft.personaText = seedInput.value; });
    runtimeSelect?.addEventListener("change", () => { draft.runtimeTargetValue = runtimeSelect.value; });
    _createBotModal.querySelector('[data-action="close"]')?.addEventListener("click", close);
    _createBotModal.querySelector("#webChooseBotAvatar")?.addEventListener("click", () => fileInput?.click());
    _createBotModal.querySelector("#webBotAvatarPreview")?.addEventListener("click", () => {
      openWebAvatarCropEditor({ draft, root: _createBotModal, image: draft.avatarImage, crop: draft.avatarCrop });
    });
    _createBotModal.querySelector("#webBotAvatarPreview")?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openWebAvatarCropEditor({ draft, root: _createBotModal, image: draft.avatarImage, crop: draft.avatarCrop });
    });
    fileInput?.addEventListener("change", () => {
      readWebBotAvatarFile(fileInput.files?.[0], draft, _createBotModal);
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
      readWebBotAvatarFile(event.dataTransfer?.files?.[0], draft, _createBotModal);
    });
    _createBotModal.querySelector("#webCreateBotForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      draft.name = nameInput?.value || draft.name;
      draft.personaText = seedInput?.value || draft.personaText;
      draft.saving = true;
      render();
      try {
        const saved = await saveBotFromWeb(draft);
        close();
        renderConversationList();
        if (saved.conversation?.id) setActiveConversation(saved.conversation.id);
      } catch (err) {
        draft.saving = false;
        render();
        showToast(err.message || "创建智能体失败");
      }
    });
  }

  document.addEventListener("keydown", onEsc);
  _createBotModal.addEventListener("click", onBackdrop);
  render();
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
  const myUserId = state.user?.id || "—";
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
                    <strong>我的 UID</strong>
                    <p>把这个发给朋友，让对方添加你。</p>
                  </div>
                </div>
                <section class="connection-details">
                  <p class="pairing-hint" style="font-family:monospace;">${escapeHtml(myUserId)}</p>
                </section>
              </section>
              <section class="connection-row">
                <div class="connection-row-head">
                  <div>
                    <strong>添加好友</strong>
                    <p>输入对方的 UID 发送请求。</p>
                  </div>
                </div>
                <section class="connection-details">
                  <div class="add-friend-send-row">
                    <input id="addFriendInput" placeholder="UID" inputmode="numeric" autocomplete="off">
                    <button class="add-friend-icon-button" type="button" data-action="send" title="发送好友请求" aria-label="发送好友请求">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M7 17 17 7"></path>
                        <path d="M9 7h8v8"></path>
                      </svg>
                    </button>
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
                        <span style="flex:1;">${escapeHtml(r.other?.displayName || r.other?.id || r.from_user)}</span>
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
                        <span style="flex:1;">${escapeHtml(r.other?.displayName || r.other?.id || r.to_user)}</span>
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
    const toUserId = String(input?.value || "").trim();
    if (!toUserId) { statusEl.textContent = "请输入 UID"; return; }
    if (!isValidPublicUid(toUserId)) { statusEl.textContent = "请输入有效 UID"; return; }
    try {
      const res = await api("/api/social/friend-requests", { method: "POST", body: { toUserId } });
      if (res.request) {
        state.outgoingRequests = [{ ...res.request, other: { id: toUserId } }, ...state.outgoingRequests];
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
        if (action === "accept" && res.friend && res.conversation) {
          state.friends = [res.friend, ...state.friends.filter((f) => f.id !== res.friend.id)];
          state.conversations = [res.conversation, ...state.conversations.filter((r) => r.id !== res.conversation.id)];
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
                        <label style="display:flex; align-items:center; gap:8px; padding:6px 0; cursor: default;">
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
      const res = await api("/api/conversations", { method: "POST", body: { name, memberFriendUserIds: ids, memberBots: [] } });
      const conversation = res.conversation || res.data?.conversation;
      if (conversation) {
        state.conversations = [conversation, ...state.conversations.filter((r) => r.id !== conversation.id)];
        if (Array.isArray(res.members)) state.conversationMembersCache.set(conversation.id, res.members);
        renderConversationList();
        setActiveConversation(conversation.id);
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
  els.newConversation?.setAttribute("aria-expanded", state.createMenuOpen ? "true" : "false");
  els.newConversation?.classList.toggle("active", state.createMenuOpen);
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
  if (els.profileDisplayName) {
    els.profileDisplayName.value = state.user?.displayName || state.user?.username || "";
    syncProfileNameText();
  }
  if (els.profileStatusBadge) {
    els.profileStatusBadge.value = statusBadgePresetValue(state.user?.statusBadge);
    syncProfileStatusBadgeControl();
  }
  // Reflect current appearance state into the inputs every time the dialog
  // opens so it survives external mutations (multiple tabs, reset action).
  const ap = window.miaAppearance?.get?.() || {};
  if (els.appearanceTheme) els.appearanceTheme.value = ap.theme || "light";
  if (els.appearanceAccentColor) els.appearanceAccentColor.value = ap.accentColor || "#5e5ce6";
  if (els.appearanceUserBubbleColor) els.appearanceUserBubbleColor.value = ap.userBubbleColor || "#eeffde";
  if (els.appearanceShowUserAvatar) els.appearanceShowUserAvatar.checked = ap.showUserAvatar === true;
  if (els.appearanceShowAssistantAvatar) els.appearanceShowAssistantAvatar.checked = ap.showAssistantAvatar === true;
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
  handleLogin();
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
els.convMenuNewBot?.addEventListener("click", () => openCreateBotDialog());
document.addEventListener("click", (event) => {
  if (!state.createMenuOpen) return;
  if (els.conversationCreateMenu?.contains(event.target) || els.newConversation?.contains(event.target)) return;
  state.createMenuOpen = false;
  renderCreateMenu();
});

els.sessionMenuButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!activeSessionConversation()) return;
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
  const permissionButton = event.target.closest("[data-permission-decision]");
  if (permissionButton && els.chat.contains(permissionButton)) {
    event.preventDefault();
    await respondToPermission(
      permissionButton.closest("[data-permission-run]")?.dataset.permissionRun || "",
      permissionButton.dataset.permissionDecision
    );
    return;
  }

  const copyButton = event.target.closest("[data-copy-code]");
  if (copyButton && els.chat.contains(copyButton)) {
    const code = copyButton.closest(".message-code-block")?.querySelector("code");
    if (!code) return;
    if (await copyTextToClipboard(code.textContent)) {
      const restingText = copyButton.dataset.slotCopyLabel || copyButton.dataset.slotTextValue || copyButton.textContent || "复制";
      copyButton.dataset.slotCopyLabel = restingText;
      copyButton.classList.add("copied");
      copyButton.disabled = true;
      flashAnimatedText(copyButton, "已复制", { restingText, revertAfter: 900 });
      setTimeout(() => {
        copyButton.classList.remove("copied");
        copyButton.disabled = false;
      }, 900);
    }
    return;
  }

  const link = event.target.closest("a.message-link[data-external-link]");
  if (link && els.chat.contains(link)) {
    if (link.dataset.traceLink === "true" && !isTraceLinkModifierPressed(event)) return;
    event.preventDefault();
    event.stopPropagation();
    window.open(link.dataset.externalLink, "_blank", "noopener,noreferrer");
    return;
  }

  const code = event.target.closest(".bubble code.inline-code");
  if (!code || !els.chat.contains(code)) return;
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

els.chat.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const link = event.target.closest("a.message-link[data-external-link]");
  if (link && els.chat.contains(link)) {
    if (link.dataset.traceLink === "true" && !isTraceLinkModifierPressed(event)) return;
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
  submitActiveComposer();
});
els.chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitActiveComposer();
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
async function saveProfilePatch(patch, errorText = "资料保存失败") {
  try {
    const result = await api("/api/me/profile", { method: "PATCH", body: patch });
    state.user = result.user || state.user;
    saveSession();
    renderUserAvatar();
    renderConversationList();
    renderActiveChat();
    renderSettings();
  } catch (err) {
    showToast(err.message || errorText);
  }
}
els.profileNameText?.addEventListener("click", () => {
  syncProfileNameText();
  els.profileNameText.classList.add("hidden");
  els.profileDisplayName.classList.remove("hidden");
  els.profileDisplayName.focus();
  els.profileDisplayName.select?.();
});
els.profileDisplayName?.addEventListener("input", syncProfileNameText);
els.profileDisplayName?.addEventListener("blur", async () => {
  const displayName = els.profileDisplayName.value.trim();
  els.profileDisplayName.classList.add("hidden");
  els.profileNameText.classList.remove("hidden");
  syncProfileNameText();
  if (!displayName || displayName === (state.user?.displayName || state.user?.username || "")) return;
  await saveProfilePatch({ displayName }, "名字保存失败");
});
els.profileDisplayName?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    els.profileDisplayName.blur();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    els.profileDisplayName.value = state.user?.displayName || state.user?.username || "";
    els.profileDisplayName.blur();
  }
});
els.profileStatusBadge?.addEventListener("change", async () => {
  const statusBadge = statusBadgeForPreset(els.profileStatusBadge.value);
  syncProfileStatusBadgeControl();
  await saveProfilePatch({ statusBadge }, "徽章保存失败");
});
document.addEventListener("click", (event) => {
  const button = event.target?.closest?.("[data-status-badge-choice]");
  if (!button || !els.profileStatusBadge) return;
  els.profileStatusBadge.value = button.dataset.statusBadgeChoice || "";
  syncProfileStatusBadgeControl();
  if (els.profileStatusBadgeDetails) els.profileStatusBadgeDetails.open = false;
  els.profileStatusBadge.dispatchEvent(new Event("change", { bubbles: true }));
});
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
bindAppearanceInput(els.appearanceAccentColor, "accentColor", (e) => e.value);
bindAppearanceInput(els.appearanceUserBubbleColor, "userBubbleColor", (e) => e.value);
bindAppearanceInput(els.appearanceShowUserAvatar, "showUserAvatar", (e) => e.checked);
bindAppearanceInput(els.appearanceShowAssistantAvatar, "showAssistantAvatar", (e) => e.checked);

// rail rail-rail button → chat is the only view; already active by default

// ── init ───────────────────────────────────────────────────────────────────

if (window.miaTraceBlocks && typeof window.miaTraceBlocks.initTraceBlocks === "function") {
  window.miaTraceBlocks.initTraceBlocks({ state });
}

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
