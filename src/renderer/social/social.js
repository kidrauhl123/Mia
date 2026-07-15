// Renderer-side social module: friends, DM conversations, add-friend dialog.
// Loaded by <script src="./social/social.js"> from index.html, BEFORE app.js.
// Pattern: IIFE + window.miaSocial public API; deps are injected via initSocialModule().

(function (global) {
  // Decision: cap initial-message fetch to 30 conversations to keep bootstrap fast.
  const INITIAL_CONVERSATIONS_CAP = 30;
  // Fetch a small recent overlap so older local SQLite rows can be upgraded when
  // the server adds fields like trace_json after the row was first cached.
  const MESSAGE_BACKFILL_OVERLAP = 50;
  const MESSAGE_REMOVE_ANIMATION_MS = 180;
  const MESSAGE_TAIL_ENTER_ANIMATION_MS = 220;
  const MESSAGE_LAYOUT_SHIFT_ANIMATION_MS = 190;
  const LOCAL_TIMELINE_SEQ_STEP = 0.000001;
  const LOCAL_TIMELINE_SEQ_SENTINEL = 1000000000000;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  // Device-local memory of the last conversation the user had open, so relaunch
  // lands back on it instead of an empty chat pane. Same renderer-prefs convention
  // as mia.sidebarWidth; not synced across devices on purpose.
  const LAST_CONVERSATION_KEY = "mia.lastActiveConversationId";
  const LAST_BOT_CONVERSATION_KEY = "mia.lastBotConversationByKey";
  const OTHER_DEVICE_CONVERSATION_FILTER = "__mia_other_devices__";
  const OTHER_DEVICE_CONVERSATION_LABEL = "其他设备";
  const CLOUD_AGENT_RUN_STALE_MS = 30 * 60 * 1000;
  const BOT_REPLY_BACKFILL_ATTEMPTS = 90;

  function isValidPublicUid(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    if (global.miaIds && typeof global.miaIds.isPublicId === "function") {
      return global.miaIds.isPublicId(text);
    }
    return /^[1-9][0-9]{5,11}$/.test(text);
  }

  function rendererLocalStorage() {
    try {
      if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
    } catch {
      // localStorage may be unavailable in restricted renderer contexts.
    }
    return null;
  }

  function readLastActiveConversationId() {
    try {
      return rendererLocalStorage()?.getItem(LAST_CONVERSATION_KEY) || "";
    } catch {
      return "";
    }
  }

  function writeLastActiveConversationId(id) {
    try {
      const storage = rendererLocalStorage();
      if (storage && id) storage.setItem(LAST_CONVERSATION_KEY, id);
    } catch {
      // localStorage may be unavailable in restricted renderer contexts.
    }
  }

  function clearLastActiveConversationId(expectedId = "") {
    try {
      const storage = rendererLocalStorage();
      if (!storage) return;
      if (expectedId && (storage.getItem(LAST_CONVERSATION_KEY) || "") !== expectedId) return;
      if (typeof storage.removeItem === "function") {
        storage.removeItem(LAST_CONVERSATION_KEY);
      } else if (typeof storage.setItem === "function") {
        storage.setItem(LAST_CONVERSATION_KEY, "");
      }
    } catch {
      // localStorage may be unavailable in restricted renderer contexts.
    }
  }

  function readLastBotConversationByKey() {
    try {
      const raw = rendererLocalStorage()?.getItem(LAST_BOT_CONVERSATION_KEY) || "";
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed)
        .map(([key, value]) => [String(key || "").trim(), String(value || "").trim()])
        .filter(([key, value]) => key && value));
    } catch {
      return {};
    }
  }

  function writeLastBotConversationByKey(value) {
    try {
      const storage = rendererLocalStorage();
      if (!storage) return;
      storage.setItem(LAST_BOT_CONVERSATION_KEY, JSON.stringify(value || {}));
    } catch {
      // Best-effort device-local preference.
    }
  }

  function firstText(...values) {
    for (const value of values) {
      const text = String(value || "").trim();
      if (text) return text;
    }
    return "";
  }

  // Lazy shared-dep accessor (mirrors unreadShared / sendPipelineShared) so the
  // module still loads in test VMs where neither the global nor require exists.
  function conversationKinds() {
    if (global.miaConversationKinds) return global.miaConversationKinds;
    if (typeof require !== "undefined") return require("../../shared/conversation-kinds");
    return {
      MemberKind: { Bot: "bot", User: "user" },
      SenderKind: { Bot: "bot", User: "user", System: "system" }
    };
  }

  function unreadShared() {
    if (global.miaUnread) return global.miaUnread;
    if (typeof require !== "undefined") return require("../../shared/unread");
    throw new Error("miaUnread is not loaded");
  }

  function sendPipelineShared() {
    if (global.miaSendPipeline) return global.miaSendPipeline;
    if (typeof require !== "undefined") return require("../../shared/send-pipeline");
    throw new Error("miaSendPipeline is not loaded");
  }

  function sessionHistoryShared() {
    if (global.miaSessionHistory) return global.miaSessionHistory;
    if (typeof require !== "undefined") return require("../../shared/session-history");
    return {
      conversationType: (conversation, conversationId = "") => {
        const id = conversation?.id || conversationId || "";
        if (conversation?.type) return conversation.type;
        if (id.startsWith("dm:")) return "dm";
        if (id.startsWith("botc_")) return "bot";
        if (id.startsWith("g_") || id.startsWith("g-")) return "group";
        return "";
      },
      botId: (conversation) => {
        const decorated = conversation?.decorations?.botId || conversation?.botId || conversation?.bot_id || "";
        if (decorated) return String(decorated);
        return "";
      },
      sidebarConversations: (conversations) => conversations
    };
  }

  // Decision: singleton modal — create once, re-populate on open.
  // Avoids leaking DOM nodes on repeated opens.
  let _addFriendModal = null;
  let _createGroupModal = null;

  // Cache of conversation members per conversation id (fetched on first open, updated via WS events).
  const _conversationMembersCache = new Map();
  const _hydratingBotIdentities = new Set();
  let _tagEditOutsideHandler = null;
  let _tagEditOutsideGeneration = 0;

  // Distance (px) from the bottom within which we treat the user as "pinned" and
  // keep following new content. Mirrors the bot-chat threshold in app.js.
  const SCROLL_STICK_THRESHOLD_PX = 80;
  const SCROLL_LAYOUT_SETTLE_FRAMES = 14;
  const SCROLL_LAYOUT_OBSERVER_TIMEOUT_MS = 2200;
  const MESSAGE_FOCUS_PENDING_TTL_MS = 10000;
  const MESSAGE_FOCUS_HIGHLIGHT_MS = 2200;
  const PHASE_ORB_CYCLE_MS = 1700;
  const PHASE_ORB_BASE_OPACITY = 0.08;
  const PHASE_ORB_OPACITY = 0.96;
  const PHASE_ORB_NEAR_OPACITY = 0.34;
  // Which conversation renderConversationChat last painted — a change means the user switched
  // conversations, so we land at the bottom instead of preserving the old offset.
  let _lastRenderedConversationId = null;
  let _lastRenderedConversationMessageCount = 0;
  let _lastRenderedConversationMessageIds = [];
  let _pendingMessageFocus = null;
  let _suppressPendingMessageFocus = false;
  const _chatBottomStickSessions = new WeakMap();
  const _chatScrollIntents = new WeakMap();

  function jsonSignature(value) {
    try {
      return JSON.stringify(value ?? null);
    } catch {
      return String(value ?? "");
    }
  }

  function badgeSignature(badge) {
    if (!badge || typeof badge !== "object") return "";
    return jsonSignature({
      kind: badge.kind || "",
      emoji: badge.emoji || "",
      assetId: badge.assetId || badge.asset_id || "",
      collectibleId: badge.collectibleId || badge.collectible_id || "",
      label: badge.label || ""
    });
  }

  function conversationSignature(conversation) {
    if (!conversation) return "";
    return jsonSignature({
      id: conversation.id || "",
      type: conversation.type || "",
      name: conversation.name || "",
      updatedAt: conversation.updatedAt || conversation.updated_at || "",
      badge: badgeSignature(statusBadgeFrom(conversation.identity, conversation)),
      otherBadge: badgeSignature(statusBadgeFrom(conversation.otherUser?.identity, conversation.otherUser))
    });
  }

  function memberSignature(member) {
    if (!member) return "";
    const identity = member.identity || {};
    return jsonSignature({
      kind: member.member_kind || identity.kind || "",
      ref: member.member_ref || identity.id || "",
      name: identity.displayName || identity.display_name || member.displayName || member.display_name || member.name || "",
      badge: badgeSignature(statusBadgeFrom(identity, member))
    });
  }

  function messageSignature(msg) {
    if (!msg) return "";
    return jsonSignature({
      id: msg.id || "",
      seq: msg.seq || "",
      senderKind: msg.sender_kind || msg.senderKind || "",
      senderRef: msg.sender_ref || msg.senderRef || "",
      body: msg.body_md || msg.bodyMd || "",
      createdAt: msg.created_at || msg.createdAt || "",
      status: msg.status || "",
      error: msg.error || "",
      trace: msg.trace_json || msg.trace || "",
      contentBlocks: msg.content_blocks_json || msg.contentBlocks || msg.content_blocks || "",
      skills: msg.skills_json || "",
      attachments: msg.attachments || [],
      translation: msg.translation || null,
      localRunId: msg._localRunId || "",
      localRunStatus: msg._localRunStatus || "",
      localRunStatusText: msg._localRunStatusText || "",
      localRunElapsedMs: msg._localRunElapsedMs || 0
    });
  }

  function streamSignature(run) {
    // A run with no visible content must not make the chat remount. The user
    // bubble can still be in its entrance animation when the run is created.
    if (!streamingRunHasRenderableOutput(run)) return "";
    return jsonSignature({
      runId: run.runId || "",
      botId: run.botId || "",
      status: run.status || "",
      hasTypingActivity: Boolean(run.hasTypingActivity),
      text: runDisplayText(run),
      reasoning: run.reasoning || "",
      tools: run.tools || [],
      goal: run.goal || null,
      pendingPermissions: run.pendingPermissions || [],
      createdAt: run.createdAt || ""
    });
  }

  function chatRenderSignatureFor(conversationId) {
    const entry = moduleState.messageCache.get(conversationId) || { messages: [], maxSeq: 0 };
    const messages = Array.isArray(entry.messages) ? entry.messages : [];
    const conversation = moduleState.conversations.find((r) => r.id === conversationId);
    const type = conversationTypeFor(conversation, conversationId);
    const members = (type === "group" || type === "bot") ? (_conversationMembersCache.get(conversationId) || []) : [];
    return jsonSignature({
      conversationId,
      maxSeq: entry.maxSeq || 0,
      conversation: conversationSignature(conversation),
      members: members.map(memberSignature),
      messages: messages.map(messageSignature),
      stream: streamSignature(moduleState.cloudAgentRunsByConversation.get(conversationId))
    });
  }

  function markChatRenderFresh(containerEl, conversationId = moduleState.activeConversationId) {
    if (!containerEl?.dataset || !conversationId) return;
    containerEl.dataset.conversationRenderSignature = chatRenderSignatureFor(conversationId);
  }

  function cssEscapeValue(value) {
    const text = String(value || "");
    if (typeof window !== "undefined" && window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(text);
    }
    return text.replace(/["\\]/g, "\\$&");
  }

  function pendingFocusFor(conversationId) {
    if (!_pendingMessageFocus) return null;
    if (_pendingMessageFocus.conversationId !== conversationId) return null;
    const now = Date.now();
    const highlightUntil = Number(_pendingMessageFocus.highlightUntil || 0);
    if (highlightUntil > 0) {
      if (now <= highlightUntil) return _pendingMessageFocus;
      _pendingMessageFocus = null;
      return null;
    }
    if (now - Number(_pendingMessageFocus.startedAt || 0) > MESSAGE_FOCUS_PENDING_TTL_MS) {
      _pendingMessageFocus = null;
      return null;
    }
    return _pendingMessageFocus;
  }

  function elementTopWithin(containerEl, targetEl) {
    let top = 0;
    let node = targetEl;
    while (node && node !== containerEl) {
      top += Number(node.offsetTop) || 0;
      node = node.offsetParent;
    }
    if (node === containerEl) return top;
    try {
      const containerRect = containerEl.getBoundingClientRect?.();
      const targetRect = targetEl.getBoundingClientRect?.();
      if (containerRect && targetRect) {
        return (Number(targetRect.top) || 0) - (Number(containerRect.top) || 0) + (Number(containerEl.scrollTop) || 0);
      }
    } catch {
      // Fall through to current scroll position.
    }
    return Number(containerEl.scrollTop) || 0;
  }

  function centerMessageTarget(containerEl, targetEl) {
    if (!containerEl || !targetEl) return { ready: false, scrollTop: 0 };
    const targetTop = elementTopWithin(containerEl, targetEl);
    const targetHeight = Number(targetEl.offsetHeight) || Number(targetEl.getBoundingClientRect?.().height) || 0;
    const viewportHeight = Number(containerEl.clientHeight) || 0;
    const scrollHeight = Number(containerEl.scrollHeight) || 0;
    const maxScroll = Math.max(0, scrollHeight - viewportHeight);
    const nextTop = Math.max(0, Math.min(maxScroll, Math.round(targetTop - (viewportHeight - targetHeight) / 2)));
    containerEl.scrollTop = nextTop;
    const targetBottom = targetTop + targetHeight;
    const targetAlreadyVisible = viewportHeight > 0 && targetTop >= 0 && targetBottom <= viewportHeight;
    return {
      ready: maxScroll > 0 || targetAlreadyVisible,
      scrollTop: nextTop
    };
  }

  function focusPendingMessage(containerEl = document.getElementById("chat")) {
    const pending = pendingFocusFor(moduleState.activeConversationId);
    if (!pending || !containerEl || !pending.messageId) return false;
    const escapedId = cssEscapeValue(pending.messageId);
    const bubble = containerEl.querySelector(`.bubble[data-message-id="${escapedId}"]`);
    const target = bubble?.closest?.(".message")
      || containerEl.querySelector(`.message[data-message-id="${escapedId}"]`)
      || bubble;
    if (!target) return false;
    if (pending.focusedAt) return true;
    const focusResult = centerMessageTarget(containerEl, target);
    if (!focusResult.ready) return false;
    const now = Date.now();
    pending.focusedAt = now;
    pending.highlightUntil = Math.max(Number(pending.highlightUntil || 0), now + MESSAGE_FOCUS_HIGHLIGHT_MS);
    target.classList.remove("search-focus");
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
          ? window.requestAnimationFrame.bind(window)
          : (fn) => setTimeout(fn, 0));
    const focusState = pending;
    raf(() => {
      target.classList.add("search-focus");
      setTimeout(() => {
        target.classList.remove("search-focus");
        if (_pendingMessageFocus === focusState && Date.now() >= Number(focusState.highlightUntil || 0)) {
          _pendingMessageFocus = null;
        }
      }, MESSAGE_FOCUS_HIGHLIGHT_MS);
    });
    return true;
  }

  function nextAnimationFrame() {
    return new Promise((resolve) => {
      const raf = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
            ? window.requestAnimationFrame.bind(window)
            : (fn) => setTimeout(fn, 0));
      raf(() => resolve());
    });
  }

  async function waitForPendingMessageFocus(attempts = 6) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!pendingFocusFor(moduleState.activeConversationId)) return true;
      if (focusPendingMessage(document.getElementById("chat"))) return true;
      await nextAnimationFrame();
    }
    return !pendingFocusFor(moduleState.activeConversationId);
  }

  function schedulePendingMessageFocus(attempts = 5) {
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
          ? window.requestAnimationFrame.bind(window)
          : (fn) => setTimeout(fn, 0));
    raf(() => {
      if (!pendingFocusFor(moduleState.activeConversationId)) return;
      if (focusPendingMessage(document.getElementById("chat"))) return;
      if (attempts > 1) setTimeout(() => schedulePendingMessageFocus(attempts - 1), 80);
    });
  }

  const moduleState = {
    conversations: [],
    friends: [],
    bots: [],
    botsLoaded: false,
    incomingRequests: [],
    outgoingRequests: [],
    messageCache: new Map(),
    activeConversationId: null,
    myUsername: "",
    myUserId: "",
    cloudAgentRunsByConversation: new Map(),
    attachmentPreviewCache: new Map(),
    pendingPermissionsById: new Map(),
    lastBotConversationByKey: readLastBotConversationByKey(),
    tagEditingConversationId: "",
    tagEditingAdding: false,
    tagEditingMode: "",
    tagEditingTargetName: "",
    tagEditingDraft: "",
    tagFilterName: "",
    tagRemovingConversationId: "",
    tagRemovingName: "",
    // unreadByConversation: conversationId → count. Bumped by WS conversation.message_appended when
    // the message is from someone else and the conversation isn't currently open.
    // Cleared by setActiveConversationId (and on bootstrap — incomingRequests path
    // doesn't update this, only message activity does).
    unreadByConversation: new Map()
  };

  let deps = null;
  let _cloudRunRenderFrame = 0;
  let _cloudRunStatusTimer = 0;
  let _phaseOrbAnimationFrame = 0;
  let _permissionBannerWired = false;
  let _streamingTextSmoother = null;
  const _permissionDecisionInFlight = new Set();
  const _localDeletingMessageKeys = new Set();

  // ── helpers ───────────────────────────────────────────────────────────────

  function escapeHtml(value) {
    if (typeof window !== "undefined" && window.miaMarkdown && typeof window.miaMarkdown.escapeHtml === "function") {
      return window.miaMarkdown.escapeHtml(value);
    }
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderNameWithBadgeHtml({ identity, fallbackName, statusBadge } = {}) {
    const renderer = global.miaNameWithBadge;
    if (renderer && typeof renderer.renderNameWithBadgeHtml === "function") {
      try {
        return renderer.renderNameWithBadgeHtml({ identity, fallbackName, statusBadge });
      } catch {
        // Keep cloud message rendering resilient to optional badge payloads.
      }
    }
    return escapeHtml(fallbackName || identity?.displayName || "");
  }

  function statusBadgeFrom(...sources) {
    for (const source of sources) {
      if (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, "statusBadge")) return source.statusBadge;
      if (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, "status_badge")) return source.status_badge;
    }
    return undefined;
  }

  function initNameBadgeLotties(root) {
    try { global.miaNameWithBadge?.initLottieBadges?.(root); } catch { /* optional badge animation */ }
  }

  function unreadBadgeText(count) {
    return window.miaUnread?.unreadBadgeText?.(count) || String(count || 0);
  }

  function senderTitleHtml(spec, color = "") {
    if (!spec || spec.isOwn || !spec.authorName) return "";
    const style = color ? ` style="color:${escapeHtml(color)};"` : "";
    const name = renderNameWithBadgeHtml({
      identity: spec.authorIdentity,
      fallbackName: spec.authorName,
      statusBadge: spec.statusBadge
    });
    return `<span class="bubble-sender"${style}>${name}</span>`;
  }

  function shouldRenderSenderTitle(conversation) {
    return sessionHistoryShared().conversationType(conversation, conversation?.id || "") === "group";
  }

  function avatarColor(key) {
    // Derive a stable hex color from the conversation id using a simple hash.
    let hash = 0;
    const s = String(key || "dm");
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    const PALETTE = ["#5e5ce6", "#30b0c7", "#34c759", "#ff9f0a", "#ff3b30", "#af52de", "#007aff"];
    return PALETTE[hash % PALETTE.length];
  }

  function avatarFallbackStyle(avatarHelpers, image, crop, color) {
    if (!image) return `background-color:${color};`;
    try {
      if (typeof avatarHelpers?.avatarThumbBackgroundStyle === "function") {
        return avatarHelpers.avatarThumbBackgroundStyle(image, crop, color);
      }
      if (typeof avatarHelpers?.avatarBackgroundStyle === "function") {
        return avatarHelpers.avatarBackgroundStyle(image, crop, color);
      }
    } catch {
      // Fall back to a plain image background if the injected avatar helper is
      // unavailable or throws in a lightweight test/browser context.
    }
    return `background-color:transparent;background-image:url('${image}');background-size:cover;background-position:center;background-repeat:no-repeat;`;
  }

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

  function attachmentGlyph(attachment = {}) {
    const mime = String(attachment.mimeType || attachment.mime || attachment.type || "").toLowerCase();
    const ext = attachmentExtension(attachment);
    const kindHint = String(attachment.kind || "").toLowerCase();
    const kind = kindHint && kindHint !== "file" ? kindHint : attachmentKind(attachment);
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

  function attachmentVisualType(attachment = {}) {
    const mime = String(attachment.mimeType || attachment.mime || attachment.type || "").toLowerCase();
    const ext = attachmentExtension(attachment);
    const kindHint = String(attachment.kind || "").toLowerCase();
    const kind = kindHint && kindHint !== "file" ? kindHint : attachmentKind(attachment);
    if (kind === "image") return "image";
    if (kind === "video") return "video";
    if (kind === "audio") return "audio";
    if (kind === "pdf" || mime.includes("pdf") || ext === "pdf") return "pdf";
    if (mime.includes("spreadsheet") || mime === "application/vnd.ms-excel" || ["xls", "xlsx", "xlsm", "csv", "tsv"].includes(ext)) return "xls";
    if (mime.includes("wordprocessingml") || mime === "application/msword" || ["doc", "docx", "rtf"].includes(ext)) return "doc";
    if (mime.includes("presentationml") || mime === "application/vnd.ms-powerpoint" || ["ppt", "pptx", "key"].includes(ext)) return "ppt";
    if (mime.includes("zip") || ["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "zip";
    if (mime.includes("json") || ext === "json") return "json";
    if (["md", "markdown"].includes(ext)) return "md";
    if (["html", "css", "js", "jsx", "ts", "tsx", "py", "java", "c", "cc", "cpp", "go", "rs", "rb", "php", "swift", "kt", "sh"].includes(ext)) return "code";
    if (kind === "text") return "txt";
    return "file";
  }

  function attachmentIconName(attachment = {}) {
    const visualType = attachmentVisualType(attachment);
    if (visualType === "doc") return "doc";
    if (visualType === "xls") return "xls";
    if (visualType === "ppt") return "ppt";
    if (visualType === "pdf") return "pdf";
    if (visualType === "zip") return "zip";
    if (visualType === "json") return "json";
    if (visualType === "code") return "code";
    if (visualType === "txt" || visualType === "md") return "txt";
    return "file";
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function renderAttachmentThumb(attachment = {}, className = "message-attachment-thumb") {
    const src = String(attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || attachment.dataUrl || "").trim();
    if (!src || !src.startsWith("data:image/")) return `<span>${escapeHtml(attachmentGlyph(attachment))}</span>`;
    return `<img class="${escapeHtml(className)}" src="${escapeHtml(src)}" alt="">`;
  }

  function renderAttachmentFileIcon(attachment = {}, assetRoot = "./assets/file-type-icons") {
    return `
      <span class="message-attachment-icon" aria-hidden="true">
        <img class="message-attachment-icon-image" src="${escapeHtml(assetRoot)}/${escapeHtml(attachmentIconName(attachment))}.png" alt="">
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
    const image = attachmentVisualType(attachment) === "image"
      && (attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || attachment.dataUrl || attachment.url);
    const imageSrc = String(attachment.dataUrl || attachment.previewDataUrl || attachment.thumbnailDataUrl || attachment.thumbnail || "").trim();
    const imageSrcAttr = imageSrc.startsWith("data:image/") ? ` data-image-src="${escapeHtml(imageSrc)}"` : "";
    const href = String(attachment.dataUrl || attachment.url || "").trim();
    const safeHref = /^data:[^"'<>]+$/i.test(href) ? href : "";
    const localFilePathAttr = ` data-local-file-path="${escapeHtml(attachment.path || "")}"`;
    const attachmentUrlAttr = attachment.url ? ` data-attachment-url="${escapeHtml(attachment.url)}"` : "";
    const downloadHrefAttr = safeHref ? ` data-download-href="${escapeHtml(safeHref)}" data-download-name="${escapeHtml(attachment.name || "attachment")}"` : "";
    const tag = safeHref ? "a" : "span";
    const download = safeHref ? ` href="${escapeHtml(safeHref)}" download="${escapeHtml(attachment.name || "attachment")}"` : "";
    const detail = formatBytes(attachment.size) || attachmentGlyph(attachment);
    if (image) {
      return `
        <${tag} class="message-attachment image"${localFilePathAttr}${attachmentUrlAttr}${downloadHrefAttr}${download}${imageSrcAttr} title="${escapeHtml(attachment.name || "")}" aria-label="预览图片">
          ${renderAttachmentThumb(attachment)}
        </${tag}>
      `;
    }
    return `
      <${tag} class="message-attachment file-card type-${escapeHtml(attachmentVisualType(attachment))}"${localFilePathAttr}${attachmentUrlAttr}${downloadHrefAttr}${download} title="${escapeHtml(attachment.path || attachment.name || "")}">
        ${renderAttachmentFileIcon(attachment)}
        <span class="message-attachment-meta">
          <strong>${escapeHtml(attachment.name || "附件")}</strong>
          <em>${escapeHtml(detail)}</em>
        </span>
      </${tag}>
    `;
  }

  function isInlinePathRefAttachment(attachment = {}) {
    return Boolean(
      attachment.inlinePathRef
      || attachment.inline_path_ref
      || attachment.pathRefToken
      || attachment.path_ref_token
    );
  }

  function renderAttachmentChips(attachments = []) {
    const visible = (Array.isArray(attachments) ? attachments : [])
      .filter((attachment) => !isInlinePathRefAttachment(attachment));
    if (!visible.length) return "";
    return `<div class="message-attachments">${visible.map(hydrateAttachmentPreview).map(renderAttachmentChip).join("")}</div>`;
  }

  function isCloudFileUrl(value = "") {
    return /^\/api\/files\/[A-Za-z0-9_-]+$/.test(String(value || "").trim());
  }

  function outgoingAttachmentName(attachment = {}) {
    return String(attachment.name || attachment.filename || attachment.file_name || attachment.path || "附件")
      .split(/[\\/]/)
      .pop()
      || "附件";
  }

  function stripLocalPathForTransfer(attachment = {}) {
    const next = { ...attachment };
    const localPath = String(next.path || next.filePath || next.file_path || "").trim();
    if (localPath && !isCloudFileUrl(localPath) && (next.dataUrl || next.url)) {
      delete next.path;
      delete next.filePath;
      delete next.file_path;
    }
    return next;
  }

  function mergeFetchedOutgoingAttachment(original = {}, fetched = {}) {
    const next = {
      ...original,
      ...fetched,
      name: fetched.name || original.name || outgoingAttachmentName(original),
      mime: fetched.mime || fetched.mimeType || original.mime || original.mimeType || "",
      mimeType: fetched.mimeType || fetched.mime || original.mimeType || original.mime || "",
      kind: fetched.kind || original.kind || "",
      size: fetched.size || original.size || 0
    };
    return stripLocalPathForTransfer(next);
  }

  function outgoingAttachmentNeedsMaterialization(attachment = {}) {
    if (!attachment || typeof attachment !== "object") return false;
    if (attachment.dataUrl || attachment.url) return false;
    return Boolean(String(attachment.path || attachment.filePath || attachment.file_path || "").trim());
  }

  function transferReadyOutgoingAttachments(attachments = []) {
    return (Array.isArray(attachments) ? attachments.filter(Boolean).slice(0, 20) : [])
      .map((attachment) => {
        if (!attachment || typeof attachment !== "object") return attachment;
        const localPath = String(attachment.path || attachment.filePath || attachment.file_path || "").trim();
        if (localPath && !isCloudFileUrl(localPath) && (attachment.dataUrl || attachment.url)) {
          return stripLocalPathForTransfer(attachment);
        }
        return attachment;
      });
  }

  async function materializeOutgoingAttachments(attachments = []) {
    const out = [];
    const incoming = Array.isArray(attachments) ? attachments.filter(Boolean).slice(0, 20) : [];
    for (const item of incoming) {
      if (!item || typeof item !== "object") continue;
      const attachment = { ...item };
      if (attachment.dataUrl || attachment.url) {
        out.push(stripLocalPathForTransfer(attachment));
        continue;
      }
      const filePath = String(attachment.path || attachment.filePath || attachment.file_path || "").trim();
      if (!filePath) {
        out.push(attachment);
        continue;
      }
      if (typeof window.mia?.fetchFileAttachment !== "function") {
        throw new Error(`附件「${outgoingAttachmentName(attachment)}」无法读取。`);
      }
      const request = isCloudFileUrl(filePath) ? { url: filePath } : { path: filePath };
      const fetched = await window.mia.fetchFileAttachment(request);
      if (!fetched || fetched.error) {
        throw new Error(`附件「${outgoingAttachmentName(attachment)}」读取失败: ${fetched?.message || "文件不可用"}`);
      }
      out.push(mergeFetchedOutgoingAttachment(attachment, fetched));
    }
    return out;
  }

  function prepareOutgoingAttachmentsForTransfer(attachments = []) {
    const incoming = Array.isArray(attachments) ? attachments.filter(Boolean).slice(0, 20) : [];
    if (!incoming.some(outgoingAttachmentNeedsMaterialization)) {
      return transferReadyOutgoingAttachments(incoming);
    }
    return materializeOutgoingAttachments(incoming);
  }

  function attachmentHasInlinePreview(attachment = {}) {
    return Boolean(attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || attachment.dataUrl);
  }

  function attachmentPreviewKey(attachment = {}) {
    return String(attachment.url || attachment.path || "").trim();
  }

  function fetchAttachmentPreviewRequest(attachment = {}, key) {
    const request = /^(\/api\/files\/|https?:\/\/)/i.test(key) ? { url: key } : { path: key };
    for (const field of ["id", "name", "mime", "mimeType", "kind", "size"]) {
      if (attachment[field] !== undefined && attachment[field] !== null && attachment[field] !== "") request[field] = attachment[field];
    }
    return request;
  }

  function mergeHydratedAttachment(original = {}, preview = {}) {
    const merged = { ...original, ...preview };
    if (original.name) merged.name = original.name;
    if (original.id) merged.id = original.id;
    return merged;
  }

  function hydrateAttachmentPreview(attachment = {}) {
    if (!attachment || typeof attachment !== "object" || attachmentHasInlinePreview(attachment)) return attachment;
    const key = attachmentPreviewKey(attachment);
    if (!key || typeof window.mia?.fetchFileAttachment !== "function") return attachment;
    const cached = moduleState.attachmentPreviewCache.get(key);
    if (cached?.status === "ready" && cached.attachment) {
      return mergeHydratedAttachment(attachment, cached.attachment);
    }
    if (cached?.status) return attachment;
    moduleState.attachmentPreviewCache.set(key, { status: "loading" });
    window.mia.fetchFileAttachment(fetchAttachmentPreviewRequest(attachment, key))
      .then((preview) => {
        if (preview?.error) throw new Error(preview.message || "File not found.");
        moduleState.attachmentPreviewCache.set(key, { status: "ready", attachment: preview });
        _reRenderActiveChat({ force: true });
      })
      .catch(() => {
        moduleState.attachmentPreviewCache.set(key, { status: "error" });
      });
    return attachment;
  }

  function eventType(event = {}) {
    return String(event.type || event.event || "");
  }

  function cloudEventEnvelopeType(envelope = {}) {
    return String(envelope?.type || envelope?.name || "").trim();
  }

  function cloudEventEnvelopePayload(envelope = {}) {
    if (envelope?.payload && typeof envelope.payload === "object") return envelope.payload;
    if (envelope?.data && typeof envelope.data === "object") return envelope.data;
    return envelope && typeof envelope === "object" ? envelope : {};
  }

  function eventText(event = {}) {
    for (const key of ["reasoning", "delta", "content_delta", "text_delta", "text", "content", "final_response"]) {
      if (typeof event[key] === "string") return event[key];
    }
    const data = event.data && typeof event.data === "object" ? event.data : null;
    if (data) return eventText(data);
    return "";
  }

  function eventIndicatesRunActivity(event = {}) {
    return Boolean(eventType(event));
  }

  function eventUpdatesDisplayedRunText(name) {
    return [
      "message.delta",
      "text_delta",
      "reasoning.available",
      "reasoning_delta",
      "reasoning.delta",
      "thinking_delta",
      "thinking.delta",
      "recap",
      "recap.delta",
      "recap_delta",
      "summary",
      "summary.delta",
      "summary_delta",
      "turn.recap",
      "turn_recap",
      "tool.started",
      "tool_call_started",
      "tool.delta",
      "tool_call_delta",
      "tool.completed",
      "tool_call_completed",
      "file_edit",
      "file.edit",
      "file_edit.completed"
    ].includes(String(name || ""));
  }

  function approvalPreview(event = {}) {
    for (const key of ["command", "cmd", "preview", "reason", "detail", "description", "message"]) {
      if (typeof event[key] === "string" && event[key].trim()) return event[key].trim();
    }
    const data = event.data && typeof event.data === "object" ? event.data : null;
    if (data) return approvalPreview(data);
    try {
      const { event: _event, type: _type, run_id: _runId, timestamp: _timestamp, choices: _choices, ...rest } = event;
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

  function toolFromRun(run, event = {}) {
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
      error: false
    };
    run.tools.push(tool);
    run.toolsById.set(tool.id, tool);
    const queue = run.toolsByName.get(tool.name) || [];
    queue.push(tool);
    run.toolsByName.set(tool.name, queue);
  }

  function appendRunReasoning(run, event = {}) {
    run.reasoning = `${run.reasoning || ""}${eventText(event)}`;
    if (run.reasoning && !run.reasoning.endsWith("\n")) run.reasoning += "\n";
  }

  function streamingTextSmoother() {
    const api = global.miaAssistantContentBlocks;
    if (!_streamingTextSmoother && api && typeof api.createStreamingTextSmoother === "function") {
      _streamingTextSmoother = api.createStreamingTextSmoother({
        charsPerFrame: 3,
        schedule: (fn) => {
          const schedule = typeof global.requestAnimationFrame === "function"
            ? global.requestAnimationFrame.bind(global)
            : (typeof global.setTimeout === "function" ? global.setTimeout.bind(global) : setTimeout);
          return schedule(fn, 16);
        },
        cancel: (handle) => {
          if (!handle) return;
          if (typeof global.cancelAnimationFrame === "function") {
            try { global.cancelAnimationFrame(handle); return; } catch {}
          }
          if (typeof global.clearTimeout === "function") global.clearTimeout(handle);
        },
        onUpdate: (run) => {
          if (!run?.conversationId) return;
          if (!updateActiveCloudRunStreamingArticle(run.conversationId)) {
            scheduleCloudRunRender(run.conversationId);
          }
        }
      });
    }
    return _streamingTextSmoother;
  }

  function syncRunDisplayText(run) {
    if (!run) return;
    if (prefersReducedMotion()) {
      flushRunDisplayText(run);
      return;
    }
    const target = runDisplayTextTarget(run);
    const smoother = streamingTextSmoother();
    if (smoother && typeof smoother.enqueue === "function") {
      smoother.enqueue(run, target);
    } else {
      run.displayText = target;
    }
  }

  function flushRunDisplayText(run) {
    if (!run) return;
    const target = runDisplayTextTarget(run);
    const smoother = streamingTextSmoother();
    if (smoother && typeof smoother.enqueue === "function") smoother.enqueue(run, target);
    if (smoother && typeof smoother.flush === "function") smoother.flush(run);
    run.displayText = target;
  }

  function runDisplayText(run) {
    if (!run) return "";
    if (typeof run.displayText === "string") return run.displayText;
    return runDisplayTextTarget(run);
  }

  function displayedContentBlocksPayloadFromRun(run, finalText = "") {
    const blocks = contentBlocksPayloadFromRun(run, finalText);
    if (!blocks || finalText) return blocks;
    const api = global.miaAssistantContentBlocks;
    return api && typeof api.contentBlocksWithDisplayText === "function"
      ? api.contentBlocksWithDisplayText(blocks, runDisplayText(run))
      : blocks;
  }

  function applyCloudAgentRunEvent(run, event = {}) {
    const name = eventType(event);
    if (eventIndicatesRunActivity(event)) run.hasTypingActivity = true;
    collectRunContentBlock(run, event);
    applyRunGoalEvent(run, event);
    let shouldSyncDisplay = eventUpdatesDisplayedRunText(name);
    if (name === "message.delta" || name === "text_delta") {
      run.text += eventText(event);
    } else if (name === "message.complete" || name === "message.completed") {
      run.text = eventText(event) || run.text;
      flushRunDisplayText(run);
      shouldSyncDisplay = false;
    } else if (name === "run.completed" || name === "complete") {
      run.text = eventText(event) || run.text;
      run.status = "complete";
      clearRunPermissions(run);
      flushRunDisplayText(run);
      shouldSyncDisplay = false;
    } else if (name === "run.failed" || name === "error") {
      run.status = "error";
      clearRunPermissions(run);
      flushRunDisplayText(run);
      shouldSyncDisplay = false;
    } else if (name === "status") {
      const text = eventText(event);
      if (text && !isGenericLocalEngineStartupStatus(text)) run.statusText = text;
    } else if (name === "run.cancelling") {
      run.status = "cancelling";
      clearRunPermissions(run);
    } else if (name === "run.cancelled") {
      run.status = "cancelled";
      clearRunPermissions(run);
      flushRunDisplayText(run);
      shouldSyncDisplay = false;
    } else if (name === "reasoning.available" || name === "reasoning_delta") {
      appendRunReasoning(run, event);
    } else if (name === "tool.started" || name === "tool_call_started") {
      addRunTool(run, event);
    } else if (name === "tool.delta" || name === "tool_call_delta") {
      const tool = toolFromRun(run, event);
      if (tool) tool.preview = String(event.preview || event.delta || tool.preview || "");
    } else if (name === "tool.completed" || name === "tool_call_completed") {
      const tool = toolFromRun(run, event);
      if (tool) {
        tool.status = event.error || event.data?.error ? "error" : normalizeToolStatus(event.status || "completed");
        tool.duration = typeof event.duration === "number" ? event.duration : null;
        tool.error = Boolean(event.error || event.data?.error);
        if (event.preview) tool.preview = String(event.preview);
      }
    } else if (name === "permission_request") {
      addRunPermission(run, event);
    } else if (name === "permission_resolved") {
      removeRunPermission(run, event);
    } else if (name === "approval.request") {
      addCloudRunApprovalPermission(run, event);
    } else if (name === "approval.responded") {
      removeCloudRunApprovalPermission(run);
    }
    if (shouldSyncDisplay) syncRunDisplayText(run);
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
          error: Boolean(tool.error)
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
    const normalizer = global.miaAssistantContentBlocks;
    if (normalizer && typeof normalizer.normalizeContentBlocks === "function") {
      return normalizer.normalizeContentBlocks(parsed);
    }
    return Array.isArray(parsed) ? parsed.filter((block) => block && typeof block === "object") : [];
  }

  function contentBlocksFromMessage(message) {
    const blocks = parseContentBlocksJson(message?.content_blocks_json || message?.contentBlocks || message?.content_blocks);
    if (!blocks.length) return [];
    const normalizer = global.miaAssistantContentBlocks;
    return normalizer && typeof normalizer.contentBlocksWithFinalText === "function"
      ? normalizer.contentBlocksWithFinalText(blocks, message?.body_md || message?.bodyMd || "")
      : blocks;
  }

  function contentBlocksHaveProcess(blocks) {
    return Array.isArray(blocks) && blocks.some((block) => block && block.type && block.type !== "text");
  }

  function tracePayloadFromRun(run) {
    if (!run || typeof run !== "object") return null;
    const reasoning = String(run.reasoning || "").trim();
    const tools = Array.isArray(run.tools)
      ? run.tools.map((tool, idx) => {
        if (!tool || typeof tool !== "object") return null;
        const name = String(tool.name || "").trim();
        if (!name) return null;
        return {
          id: String(tool.id || `tool_${idx}`),
          name,
          preview: String(tool.preview || ""),
          status: normalizeToolStatus(tool.status),
          duration: typeof tool.duration === "number" ? tool.duration : null,
          error: Boolean(tool.error)
        };
      }).filter(Boolean)
      : [];
    if (!reasoning && !tools.length) return null;
    return {
      ...(reasoning ? { reasoning } : {}),
      ...(tools.length ? { tools } : {})
    };
  }

  function collectRunContentBlock(run, event = {}) {
    if (!run || !event || typeof event !== "object") return;
    const api = global.miaAssistantContentBlocks;
    if (!api || typeof api.createAssistantContentBlockCollector !== "function") return;
    if (!run.contentBlockCollector) {
      run.contentBlockCollector = api.createAssistantContentBlockCollector();
      if (run.text) {
        run.contentBlockCollector.collect({ type: "text_delta", id: "text_seed_0", text: run.text });
      }
    }
    run.contentBlockCollector.collect(event);
    run.contentBlocks = run.contentBlockCollector.payload();
  }

  function contentBlocksPayloadFromRun(run, finalText = "") {
    const blocks = Array.isArray(run?.contentBlocks) ? run.contentBlocks : [];
    if (!blocks.length) return null;
    const api = global.miaAssistantContentBlocks;
    if (finalText && api && typeof api.contentBlocksWithFinalText === "function") {
      return api.contentBlocksWithFinalText(blocks, finalText);
    }
    return blocks;
  }

  function runDisplayTextTarget(run) {
    if (!run) return "";
    const blocks = contentBlocksPayloadFromRun(run);
    const api = global.miaAssistantContentBlocks;
    if (blocks?.length && api && typeof api.displayTextFromContentBlocks === "function") {
      return api.displayTextFromContentBlocks(blocks);
    }
    return String(run.text || "");
  }

  function safeMessageSeq(value) {
    const seq = Number(value);
    return Number.isFinite(seq) ? seq : 0;
  }

  function nextLocalTimelineSeq(entry) {
    const messages = Array.isArray(entry?.messages) ? entry.messages : [];
    let maxSeq = safeMessageSeq(entry?.maxSeq);
    for (const message of messages) {
      const seq = safeMessageSeq(message?.seq);
      if (seq > maxSeq && seq < LOCAL_TIMELINE_SEQ_SENTINEL) maxSeq = seq;
    }
    return maxSeq + LOCAL_TIMELINE_SEQ_STEP;
  }

  function sortMessagesByTimelineSeq(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.sort((a, b) => safeMessageSeq(a?.seq) - safeMessageSeq(b?.seq));
  }

  function runStartedMs(run) {
    const startedAt = run?.createdAt || run?.startedAt || run?._localRunStartedAt || "";
    const parsed = Date.parse(startedAt);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function runElapsedMs(run) {
    const fixed = Number(run?._localRunElapsedMs);
    if (Number.isFinite(fixed) && fixed > 0) return fixed;
    return Math.max(0, Date.now() - runStartedMs(run));
  }

  function formatRunElapsed(ms) {
    const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  }

  function latestRunToolForStatus(run) {
    const tools = Array.isArray(run?.tools) ? run.tools : [];
    for (let i = tools.length - 1; i >= 0; i -= 1) {
      if (String(tools[i]?.status || "") === "running") return tools[i];
    }
    return tools.length ? tools[tools.length - 1] : null;
  }

  const RUN_STATUS_PHRASE_INTERVAL_MS = 9000;
  const RUN_STATUS_PHRASE_STICKY_MS = 9000;
  const agentRunStatusPhrasePools = {
    general: [
      "咕嘟咕嘟",
      "还在打转",
      "慢慢来，火候要到",
      "喝前摇匀中",
      "还在搅拌",
      "有点眉目了",
      "正在翻炒",
      "继续转一圈",
      "还在发酵",
      "正在把混乱揉成团",
      "正在捋顺耳机线",
      "小火慢炖",
      "还在找感觉",
      "先把线团抖开",
      "正在抽丝剥茧",
      "还在和问题对视",
      "正在醒面",
      "继续等东风",
      "正在驯服混乱",
      "快了，锅里有动静"
    ],
    tool: [
      "命令还在跑",
      "终端：“咕噜咕噜”",
      "shell 正在冒烟",
      "还在等它开口",
      "正在听终端说话",
      "命令出去转了一圈",
      "还在追输出",
      "终端慢条斯理",
      "主教练正在热身",
      "正在捞关键输出",
      "命令还没回家",
      "还在等它尘埃落定",
      "工具在吭哧吭哧",
      "正在大浪淘沙",
      "shell 说稍等",
      "命令跑得不紧不慢",
      "输出正在路上",
      "工具还在翻口袋",
      "终端正在挤牙膏",
      "快生了，它刚踢了一下"
    ],
    context: [
      "正在翻箱倒柜",
      "还在找线头",
      "代码堆里探个头",
      "正在按图索骥",
      "继续顺藤摸瓜",
      "真相只有一个",
      "正在翻旧账",
      "让上下文排排坐",
      "还在找藏起来的入口",
      "正在给调用链梳头",
      "继续撅一铲",
      "依旧雾里看花",
      "正在把线索串起来",
      "文件里有点东西",
      "还在翻抽屉",
      "正在问代码你是谁",
      "继续循着蛛丝马迹找",
      "还在抓重点",
      "正在把现场拼回去",
      "眉目渐清"
    ],
    thinking: [
      "正在转动脑内小齿轮",
      "还在脑内绕圈",
      "正在摆弄可能性",
      "先让想法翻个面",
      "还在和麻烦掰手腕",
      "正在另辟蹊径",
      "三思而后行",
      "还在斟酌火候",
      "正在踟蹰",
      "思路正在蓄势待发",
      "还在把问题捏扁",
      "正在悄悄权衡",
      "继续换个姿势想",
      "还在给方案称重",
      "正在拆小零件",
      "翻个身",
      "还在给判断找地板",
      "正在把弯路折起来",
      "继续等灵光一现",
      "差不多有谱了"
    ],
    writing: [
      "正在把话捋顺",
      "还在字斟句酌",
      "正在挤掉废话",
      "打扫干净屋子",
      "斟酌语气",
      "正在装盘",
      "句子还在排队",
      "正在给表达收边",
      "还在推敲措辞",
      "正在把重点摆正",
      "正在熟悉人类的语言",
      "还在删繁就简",
      "AI正在攻击你的代码",
      "字句正在各就各位",
      "还在让段落坐稳",
      "正在把毛边剪掉",
      "继续抹平皱褶",
      "答案快出炉",
      "正在最后调味",
      "马上端出来"
    ],
    verify: [
      "敲敲看结不结实",
      "还在查漏补缺",
      "正在数羊，别少一只",
      "继续晃一晃看稳不稳",
      "正在数羊",
      "大火收汁",
      "先确认没踩空",
      "还在看它会不会歪",
      "正在收拾残局",
      "继续检查边角",
      "还在把尾巴塞好",
      "正在验最后一下",
      "还在擦指纹",
      "正在把门关上",
      "继续确认能站住",
      "还在收拾工具",
      "最后一哆嗦",
      "快端平了",
      "最后再抖一抖",
      "可以准备落地"
    ]
  };

  function stableStatusHash(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
  }

  function runStatusKey(run) {
    return firstText(run?.runId, run?.hermesRunId, run?.conversationId, run?._localRunId, run?.id, run?.createdAt, "run");
  }

  function runToolText(tool) {
    return `${tool?.name || ""} ${tool?.preview || ""}`.toLowerCase();
  }

  function runToolPhrasePoolName(tool) {
    const text = runToolText(tool);
    if (/\b(npm|pnpm|yarn|node --test|test|vitest|jest|pytest|lint|tsc|build|check|verify)\b|git diff --check/.test(text)) {
      return "verify";
    }
    if (/\b(rg|grep|find|sed|cat|ls|tree|read|search|glob|open|view|head|tail|nl|wc)\b/.test(text)) {
      return "context";
    }
    return "tool";
  }

  function runActivityPhrasePoolName(run, tool) {
    if (tool && String(tool.status || "") === "running") return runToolPhrasePoolName(tool);
    if (run?.text) return "writing";
    if (run?.reasoning) return "thinking";
    if (tool) return runToolPhrasePoolName(tool);
    return "general";
  }

  function runActivityPhrase(run, poolName, options = {}) {
    const pool = agentRunStatusPhrasePools[poolName] || agentRunStatusPhrasePools.general;
    const elapsedMs = Number.isFinite(Number(options.elapsedMs)) ? Number(options.elapsedMs) : runElapsedMs(run);
    const runKey = runStatusKey(run);
    const previous = run && typeof run === "object" ? run._agentRunStatusPhrase : null;
    if (
      previous
      && previous.key === runKey
      && previous.label
      && elapsedMs >= previous.elapsedMs
      && elapsedMs - previous.elapsedMs < RUN_STATUS_PHRASE_STICKY_MS
    ) {
      return previous.label;
    }
    const bucket = Math.floor(Math.max(0, elapsedMs) / RUN_STATUS_PHRASE_INTERVAL_MS);
    const offset = stableStatusHash(`${runKey}:${poolName}`);
    const label = pool[(offset + bucket) % pool.length] || "正在处理";
    if (run && typeof run === "object") {
      run._agentRunStatusPhrase = { key: runKey, label, elapsedMs, poolName };
    }
    return label;
  }

  function isGenericLocalEngineStartupStatus(text = "") {
    const value = String(text || "").replace(/\s+/g, "").trim();
    return /^本机[^。.!！]+?已(?:经)?开始运行[。.!！]?$/i.test(value);
  }

  function normalizeRunGoal(goal) {
    if (!goal || typeof goal !== "object") return null;
    const objective = firstText(goal.objective, goal.title, goal.name, goal.display, goal.text);
    if (!objective) return null;
    const usage = goal.usage && typeof goal.usage === "object" ? goal.usage : {};
    return {
      objective,
      status: String(goal.status || ""),
      tokenBudget: Number(goal.tokenBudget ?? goal.token_budget ?? usage.tokenBudget ?? usage.token_budget) || 0,
      tokensUsed: Number(goal.tokensUsed ?? goal.tokens_used ?? usage.tokensUsed ?? usage.tokens_used) || 0
    };
  }

  function applyRunGoalEvent(run, event = {}) {
    const goal = normalizeRunGoal(event.goal || event.currentGoal || event.data?.goal || event.data?.currentGoal);
    if (goal) run.goal = goal;
  }

  function runGoalStatusText(run) {
    const goal = normalizeRunGoal(run?.goal);
    if (!goal) return "";
    const usage = goal.tokenBudget > 0
      ? ` ${goal.tokensUsed}/${goal.tokenBudget}`
      : (goal.tokensUsed > 0 ? ` ${goal.tokensUsed}` : "");
    return `目标：${goal.objective}${usage}`;
  }

  function runActivityLabel(run, options = {}) {
    const status = String(run?._localRunStatus || run?.status || "").trim();
    if (status === "cancelled") return firstText(run?._localRunStatusText, "已中断");
    if (status === "cancelling") return "正在中断";
    if (status === "error") return "运行失败";
    if (Array.isArray(run?.pendingPermissions) && run.pendingPermissions.length) {
      return "等待授权";
    }
    if (run?.statusText && !isGenericLocalEngineStartupStatus(run.statusText)) return String(run.statusText);
    const tool = latestRunToolForStatus(run);
    return runActivityPhrase(run, runActivityPhrasePoolName(run, tool), options);
  }

  function runStatusLineModel(run, options = {}) {
    if (!run) return null;
    const status = String(run._localRunStatus || run.status || (options.cancelled ? "cancelled" : "running"));
    const elapsedMs = options.elapsedMs ?? runElapsedMs(run);
    const label = firstText(options.label, runActivityLabel(run, { elapsedMs }));
    const elapsed = formatRunElapsed(elapsedMs);
    const goalText = runGoalStatusText(run);
    const isLoading = status === "running" || status === "cancelling";
    const statusClass = status === "cancelled"
      ? " is-interrupted"
      : (status === "error" ? " is-error" : ` is-running${status === "cancelling" ? " is-cancelling" : ""} is-loading`);
    return {
      status,
      elapsedMs,
      label,
      elapsed,
      goalText,
      isLoading,
      statusClass,
      runKey: runStatusKey(run)
    };
  }

  function isWithinPhaseOrbMask(row, col) {
    const x = col - 2;
    const y = row - 2;
    return Math.sqrt((x * x) + (y * y)) <= 2.24;
  }

  function phaseOrbOpacityForCell(row, col, phase, options = {}) {
    if (!isWithinPhaseOrbMask(row, col)) return null;
    const x = col - 2;
    const y = row - 2;
    const t = options.reducedMotion || options.idle ? 0 : (phase * Math.PI * 2);
    const angle = Math.atan2(y, x);
    const ring = Math.sqrt((x * x) + (y * y));

    const angularPhase = ((angle - (t * 0.95) + (Math.PI * 4)) % (Math.PI * 2)) / ((Math.PI * 2) / 3);
    const sectorPos = angularPhase - Math.floor(angularPhase);
    const sectorPulse = Math.max(0, 1 - (Math.abs(sectorPos - 0.5) * 2));
    const ringPhase = 0.5 + (0.5 * Math.cos((ring * 3.2) + (t * 1.7)));
    const score = (0.74 * sectorPulse) + (0.26 * ringPhase);

    let opacity = PHASE_ORB_BASE_OPACITY;
    if (score > 0.84) {
      opacity = PHASE_ORB_OPACITY;
    } else if (score > 0.63) {
      opacity = 0.62;
    } else if (score > 0.44) {
      opacity = PHASE_ORB_NEAR_OPACITY;
    }

    if (x === 0 && y === 0) {
      return Math.max(opacity, PHASE_ORB_NEAR_OPACITY);
    }
    return opacity;
  }

  function phaseOrbCellAttrs(row, col, isLoading) {
    const x = col - 2;
    const y = row - 2;
    const ring = Math.sqrt((x * x) + (y * y));
    const angle = Math.atan2(y, x);
    const opacity = isLoading ? phaseOrbOpacityForCell(row, col, 0) : null;
    const opacityStyle = opacity == null ? "" : ` style="opacity:${opacity}"`;
    return `data-orb-row="${row}" data-orb-col="${col}" data-orb-x="${x}" data-orb-y="${y}" data-orb-ring="${Number(ring.toFixed(3))}" data-orb-angle="${Number(angle.toFixed(3))}"${opacityStyle}`;
  }

  function runStatusPhaseOrbHtml(isLoading) {
    const cells = [];
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const x = col - 2;
        const y = row - 2;
        const active = isWithinPhaseOrbMask(row, col);
        const core = x === 0 && y === 0;
        const classes = `agent-run-status-orb-dot${core ? " is-core" : ""}${active ? "" : " is-inactive"}`;
        cells.push(`<span class="${classes}" ${phaseOrbCellAttrs(row, col, isLoading)}></span>`);
      }
    }
    return cells.join("");
  }

  function renderRunStatusLine(run, options = {}) {
    const model = runStatusLineModel(run, options);
    if (!model) return "";
    const loadingDots = model.isLoading
      ? `<span class="agent-run-status-loading-dots" aria-hidden="true"><span></span><span></span><span></span></span>`
      : "";
    const animationAge = `${Math.max(0, Math.floor(model.elapsedMs))}ms`;
    return `
      <div class="agent-run-status${model.statusClass}" data-run-status="${escapeHtml(model.status)}" data-run-key="${escapeHtml(model.runKey)}" style="--agent-run-animation-age:${escapeHtml(animationAge)}">
        <span class="agent-run-status-loader" aria-hidden="true">${runStatusPhaseOrbHtml(model.isLoading)}</span>
        <span class="agent-run-status-text">
          <span class="agent-run-status-label">${escapeHtml(model.label)}</span>${loadingDots}
        </span>
        ${model.goalText ? `<span class="agent-run-status-goal">${escapeHtml(model.goalText)}</span>` : ""}
        <span class="agent-run-status-elapsed">${escapeHtml(model.elapsed)}</span>
      </div>
    `;
  }

  function prefersReducedMotion() {
    try {
      return Boolean(global.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    } catch {
      return false;
    }
  }

  function phaseOrbStatusElements(root) {
    if (!root) return [];
    const items = [];
    const className = String(root.className || "");
    if (className.split(/\s+/).includes("agent-run-status")) items.push(root);
    if (typeof root.querySelectorAll === "function") {
      items.push(...Array.from(root.querySelectorAll(".agent-run-status")));
    }
    return items;
  }

  function updatePhaseOrbStatusElement(statusEl, now = Date.now()) {
    if (!statusEl) return false;
    const className = String(statusEl.className || "");
    const isLoading = className.split(/\s+/).includes("is-loading");
    const dots = typeof statusEl.querySelectorAll === "function"
      ? Array.from(statusEl.querySelectorAll(".agent-run-status-orb-dot"))
      : [];
    if (!dots.length) return isLoading;

    if (!isLoading) {
      dots.forEach((dot) => {
        if (dot?.style && typeof dot.style.removeProperty === "function") dot.style.removeProperty("opacity");
      });
      return false;
    }

    const reducedMotion = prefersReducedMotion();
    const phase = reducedMotion ? 0 : ((Number(now) || Date.now()) % PHASE_ORB_CYCLE_MS) / PHASE_ORB_CYCLE_MS;
    dots.forEach((dot) => {
      if (!dot || String(dot.className || "").split(/\s+/).includes("is-inactive")) return;
      const row = Number(dot.dataset?.orbRow);
      const col = Number(dot.dataset?.orbCol);
      const opacity = phaseOrbOpacityForCell(row, col, phase, { reducedMotion });
      if (opacity == null || !dot.style) return;
      dot.style.opacity = String(opacity);
    });
    return true;
  }

  function updatePhaseOrbStatusElements(root, now = Date.now()) {
    let hasLoading = false;
    for (const statusEl of phaseOrbStatusElements(root)) {
      hasLoading = updatePhaseOrbStatusElement(statusEl, now) || hasLoading;
    }
    return hasLoading;
  }

  function requestPhaseOrbFrame(callback) {
    const raf = typeof global.requestAnimationFrame === "function"
      ? global.requestAnimationFrame.bind(global)
      : null;
    if (!raf) {
      return typeof global.setTimeout === "function" ? global.setTimeout(() => callback(Date.now()), 16) : 0;
    }
    let sync = true;
    const frame = raf((timestamp) => {
      if (sync && typeof global.setTimeout === "function") {
        global.setTimeout(() => callback(timestamp || Date.now()), 16);
        return;
      }
      callback(timestamp || Date.now());
    });
    sync = false;
    return frame;
  }

  function schedulePhaseOrbAnimation(root = document) {
    if (_phaseOrbAnimationFrame) return;
    _phaseOrbAnimationFrame = requestPhaseOrbFrame((timestamp) => {
      _phaseOrbAnimationFrame = 0;
      if (updatePhaseOrbStatusElements(root || document, timestamp)) {
        schedulePhaseOrbAnimation(root);
      }
    });
  }

  function startPhaseOrbAnimation(root = document) {
    if (updatePhaseOrbStatusElements(root, Date.now())) {
      schedulePhaseOrbAnimation(document);
    }
  }

  function setTextIfChanged(element, text) {
    if (!element) return false;
    const next = String(text || "");
    if (element.textContent === next) return true;
    element.textContent = next;
    return true;
  }

  function syncRunStatusLineElement(statusEl, run, options = {}) {
    if (!statusEl || !run) return false;
    const model = runStatusLineModel(run, options);
    if (!model) return false;
    const previousRunKey = statusEl.dataset?.runKey || statusEl.getAttribute?.("data-run-key") || "";
    statusEl.className = `agent-run-status${model.statusClass}`;
    if (statusEl.dataset) {
      statusEl.dataset.runStatus = model.status;
      statusEl.dataset.runKey = model.runKey;
    } else if (typeof statusEl.setAttribute === "function") {
      statusEl.setAttribute("data-run-status", model.status);
      statusEl.setAttribute("data-run-key", model.runKey);
    }
    if (previousRunKey !== model.runKey && statusEl.style?.setProperty) {
      statusEl.style.setProperty("--agent-run-animation-age", `${Math.max(0, Math.floor(model.elapsedMs))}ms`);
    }
    const labelEl = statusEl.querySelector?.(".agent-run-status-label");
    const elapsedEl = statusEl.querySelector?.(".agent-run-status-elapsed");
    if (!labelEl || !elapsedEl) return false;
    setTextIfChanged(labelEl, model.label);
    setTextIfChanged(elapsedEl, model.elapsed);
    const goalEl = statusEl.querySelector?.(".agent-run-status-goal");
    if (goalEl) setTextIfChanged(goalEl, model.goalText);
    startPhaseOrbAnimation(statusEl);
    return true;
  }

  function localRunMessageId(run, conversationId) {
    const key = String(run?.runId || run?.hermesRunId || conversationId || Date.now()).trim();
    const safe = key.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "run";
    return `local_run_cancelled_${safe}`;
  }

  function materializeCancelledCloudRun(conversationId, run) {
    if (!conversationId || !run) return null;
    if (!moduleState.messageCache.has(conversationId)) {
      moduleState.messageCache.set(conversationId, { messages: [], maxSeq: 0 });
    }
    const entry = moduleState.messageCache.get(conversationId);
    const runKey = String(run.runId || run.hermesRunId || conversationId || "").trim();
    const id = localRunMessageId(run, conversationId);
    const existing = entry.messages.find((message) => (
      message?.id === id
      || (runKey && message?._localRunStatus === "cancelled" && message?._localRunId === runKey)
    ));
    if (existing) return existing;

    const conversation = moduleState.conversations.find((item) => item.id === conversationId) || { id: conversationId };
    const trace = tracePayloadFromRun(run);
    const contentBlocks = contentBlocksPayloadFromRun(run, run.text || "");
    const message = {
      id,
      seq: nextLocalTimelineSeq(entry),
      sender_kind: conversationKinds().SenderKind.Bot,
      sender_ref: run.botId || sessionHistoryShared().botId(conversation) || "mia",
      body_md: run.text || "",
      created_at: new Date().toISOString(),
      _localRunId: runKey,
      _localRunStatus: "cancelled",
      _localRunStatusText: "已中断",
      _localRunStartedAt: run.createdAt || "",
      _localRunElapsedMs: runElapsedMs(run)
    };
    if (trace) message.trace = trace;
    if (contentBlocks) message.contentBlocks = contentBlocks;
    if (run.goal) message.goal = run.goal;
    entry.messages.push(message);
    sortMessagesByTimelineSeq(entry.messages);
    return message;
  }

  function messageWithFallbackRunTrace(conversationId, message) {
    const { SenderKind } = conversationKinds();
    if (!message || message.sender_kind !== SenderKind.Bot) return message;
    const run = moduleState.cloudAgentRunsByConversation.get(conversationId);
    const existingBlocks = contentBlocksFromMessage(message);
    const existingTrace = parseTraceJson(message.trace_json || message.trace);
    const blocks = contentBlocksPayloadFromRun(run, message.body_md || message.bodyMd || "");
    const trace = tracePayloadFromRun(run);
    let merged = message;
    if (blocks && (
      !existingBlocks.length
      || (!contentBlocksHaveProcess(existingBlocks) && contentBlocksHaveProcess(blocks))
    )) {
      merged = {
        ...merged,
        contentBlocks: blocks,
        content_blocks_json: JSON.stringify(blocks)
      };
    }
    if (!existingTrace && trace) merged = { ...merged, trace };
    return merged;
  }

  function renderTraceFor({ reasoning, tools, content, expanded, scopeKey }) {
    const renderer = global.miaTraceBlocks;
    if (!renderer || typeof renderer.renderTraceBlocks !== "function") return "";
    return renderer.renderTraceBlocks({
      reasoning,
      tools,
      content,
      expanded,
      scopeKey
    });
  }

  function renderOrderedAssistantBlocks({ blocks, expanded, scopeKey, renderTextBlock }) {
    const renderer = global.miaTraceBlocks;
    if (!renderer || typeof renderer.renderAssistantContentBlocks !== "function") return "";
    return renderer.renderAssistantContentBlocks({
      blocks,
      expanded,
      scopeKey,
      renderTextBlock
    });
  }

  function markRenderedTraceBlocks(containerEl) {
    const renderer = global.miaTraceBlocks;
    if (renderer && typeof renderer.markRenderedTraceBlocks === "function") {
      renderer.markRenderedTraceBlocks(containerEl);
    }
  }

  function cloudRunFor(conversationId, runId = "") {
    const existing = moduleState.cloudAgentRunsByConversation.get(conversationId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const run = {
      conversationId,
      runId,
      text: "",
      reasoning: "",
      status: "running",
      createdAt: now,
      updatedAt: now,
      tools: [],
      contentBlocks: [],
      contentBlockCollector: null,
      pendingPermissions: [],
      hasTypingActivity: false,
      toolsById: new Map(),
      toolsByName: new Map()
    };
    moduleState.cloudAgentRunsByConversation.set(conversationId, run);
    return run;
  }

  function markCloudRunActivity(run) {
    if (!run) return;
    const now = new Date().toISOString();
    if (!run.createdAt) run.createdAt = now;
    run.updatedAt = now;
  }

  function runActivityTimestamp(run) {
    const raw = String(run?.updatedAt || run?.createdAt || "").trim();
    const parsed = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function clearStaleCloudAgentRuns(now = Date.now()) {
    return clearBusyCloudAgentRuns((run) => (
      Number(now) - runActivityTimestamp(run) > CLOUD_AGENT_RUN_STALE_MS
    ));
  }

  function clearBusyCloudAgentRuns(shouldClear = () => true) {
    let changed = false;
    let activeCleared = false;
    for (const [conversationId, run] of moduleState.cloudAgentRunsByConversation.entries()) {
      if (!isConversationRunBusy(run)) continue;
      if (!shouldClear(run, conversationId)) continue;
      clearRunPermissions(run);
      moduleState.cloudAgentRunsByConversation.delete(conversationId);
      changed = true;
      if (conversationId === moduleState.activeConversationId) activeCleared = true;
    }
    if (!changed) return false;
    renderAgentPermissionBanner();
    if (deps && typeof deps.render === "function") deps.render();
    if (deps && typeof deps.paintHeaderStatus === "function") deps.paintHeaderStatus();
    if (activeCleared) scheduleCloudRunRender(moduleState.activeConversationId);
    return true;
  }

  function normalizePermissionRequest(event = {}) {
    const requestId = String(event.requestId || event.id || "").trim();
    if (!requestId) return null;
    return {
      requestId,
      kind: String(event.kind || "local-agent-permission").trim() || "local-agent-permission",
      conversationId: String(event.conversationId || event.conversation_id || "").trim(),
      runId: String(event.runId || event.run_id || "").trim(),
      engine: String(event.engine || "").trim(),
      botId: String(event.botId || event.bot_id || "").trim(),
      botKey: String(event.botKey || "").trim(),
      botName: String(event.botName || event.bot_name || "").trim(),
      sessionId: String(event.sessionId || "").trim(),
      toolName: String(event.toolName || event.tool || "tool").trim() || "tool",
      title: String(event.title || "需要权限审批").trim(),
      description: String(event.description || "").trim(),
      preview: String(event.preview || "").trim(),
      rule: event.rule && typeof event.rule === "object" ? event.rule : null,
      createdAt: String(event.createdAt || new Date().toISOString())
    };
  }

  function addRunPermission(run, event = {}) {
    if (!run) return;
    const request = normalizePermissionRequest(event);
    if (!request) return;
    moduleState.pendingPermissionsById.set(request.requestId, request);
    run.pendingPermissions = (run.pendingPermissions || []).filter((item) => item.requestId !== request.requestId);
    run.pendingPermissions.push(request);
  }

  function cloudRunApprovalRequestId(run) {
    const conversationId = String(run?.conversationId || "").trim();
    const runId = String(run?.runId || "").trim();
    return conversationId && runId ? `cloud:${conversationId}:${runId}` : "";
  }

  function addCloudRunApprovalPermission(run, event = {}) {
    if (!run) return;
    const requestId = cloudRunApprovalRequestId(run);
    if (!requestId) return;
    addRunPermission(run, {
      requestId,
      kind: "cloud-run-approval",
      conversationId: run.conversationId,
      runId: run.runId,
      engine: "hermes",
      botId: run.botId || "",
      toolName: event.tool || event.tool_name || event.name || event.data?.tool || "工具",
      title: event.title || "需要权限审批",
      description: event.description || event.reason || event.data?.description || "",
      preview: approvalPreview(event),
      createdAt: new Date().toISOString()
    });
  }

  function removeCloudRunApprovalPermission(run) {
    const requestId = cloudRunApprovalRequestId(run);
    if (requestId) removeRunPermission(run, { requestId });
    else clearRunPermissions(run);
  }

  function removeRunPermission(run, event = {}) {
    const requestId = String(event.requestId || event.id || "").trim();
    if (!requestId) return;
    moduleState.pendingPermissionsById.delete(requestId);
    if (run && Array.isArray(run.pendingPermissions)) {
      run.pendingPermissions = run.pendingPermissions.filter((item) => item.requestId !== requestId);
    }
  }

  function removePermissionRequestById(requestId) {
    const id = String(requestId || "").trim();
    if (!id) return;
    moduleState.pendingPermissionsById.delete(id);
    for (const run of moduleState.cloudAgentRunsByConversation.values()) {
      if (!run || !Array.isArray(run.pendingPermissions)) continue;
      run.pendingPermissions = run.pendingPermissions.filter((item) => item.requestId !== id);
    }
  }

  function clearRunPermissions(run) {
    if (!run || !Array.isArray(run.pendingPermissions)) return;
    for (const request of run.pendingPermissions) {
      moduleState.pendingPermissionsById.delete(request.requestId);
    }
    run.pendingPermissions = [];
  }

  function activePermissionRequest() {
    const conversationId = moduleState.activeConversationId;
    if (!conversationId) return null;
    const run = moduleState.cloudAgentRunsByConversation.get(conversationId);
    const pending = Array.isArray(run?.pendingPermissions) ? run.pendingPermissions : [];
    return pending[0] || null;
  }

    function permissionEngineLabel(engine) {
      const label = window.miaEngineContracts?.engineLabel?.(engine);
      if (label) return label;
      return engine || "Agent";
    }

  function compactPermissionPreview(preview) {
    const text = String(preview || "").trim();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const preferred = parsed.command || parsed.path || parsed.filePath || parsed.file || parsed.description;
        if (preferred) return String(preferred).trim();
      }
    } catch (_) {
      // Plain text previews are expected for Codex and some tool adapters.
    }
    return text.replace(/\s+/g, " ");
  }

  function compactPermissionTitle(request = {}) {
    const title = String(request.title || "").trim();
    const botName = permissionBotName(request);
    if (!title || title === "需要权限审批") return botName ? `${botName}请求执行权限` : "请求执行权限";
    const actionMatch = title.match(/^([^\s想\n]{1,32})\s+(想.+)$/);
    if (actionMatch) return `${botName || actionMatch[1]}${actionMatch[2]}`;
    const requestMatch = title.match(/^([^\s请\n]{1,32})\s+(请求.+)$/);
    if (requestMatch) return `${botName || requestMatch[1]}${requestMatch[2]}`;
    return title;
  }

  function permissionBotName(request = {}) {
    const explicit = String(request.botName || "").trim();
    if (explicit) return explicit;
    const key = String(request.botId || request.botKey || "").trim();
    if (!key) return "";
    const bot = moduleState.bots.find((item) => {
      const candidates = [item?.key, item?.id, item?.botId, item?.bot_id].map((value) => String(value || "").trim());
      return candidates.includes(key);
    });
    return String(bot?.name || bot?.displayName || bot?.title || "").trim();
  }

  function isChatNearBottom(chatEl) {
    if (!chatEl) return false;
    return chatBottomGap(chatEl) < SCROLL_STICK_THRESHOLD_PX;
  }

  function chatBottomGap(chatEl) {
    if (!chatEl) return 0;
    const scrollHeight = Number(chatEl.scrollHeight) || 0;
    const scrollTop = Number(chatEl.scrollTop) || 0;
    const clientHeight = Number(chatEl.clientHeight) || 0;
    return Math.max(0, scrollHeight - scrollTop - clientHeight);
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

  function messageIdListsEqual(a = [], b = []) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function rememberRenderedConversationMessages(conversationId, messages = []) {
    _lastRenderedConversationId = conversationId;
    _lastRenderedConversationMessageCount = Array.isArray(messages) ? messages.length : 0;
    _lastRenderedConversationMessageIds = messageStableIds(messages);
  }

  function addElementClass(el, className) {
    if (!el || !className) return;
    const classes = new Set(String(el.className || "").split(/\s+/).filter(Boolean));
    classes.add(className);
    el.className = Array.from(classes).join(" ");
    try { el.classList?.add?.(className); } catch (_) {}
  }

  function removeElementClass(el, className) {
    if (!el || !className) return;
    const next = String(el.className || "")
      .split(/\s+/)
      .filter((item) => item && item !== className)
      .join(" ");
    el.className = next;
    try { el.classList?.remove?.(className); } catch (_) {}
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

  function hasElementClass(el, className) {
    if (!el || !className) return false;
    return String(el.className || "").split(/\s+/).includes(className);
  }

  function messageLayoutKey(article) {
    if (!article) return "";
    const dataset = article.dataset || {};
    const explicit = dataset.messageLayoutKey
      || (typeof article.getAttribute === "function" ? article.getAttribute("data-message-layout-key") : "");
    const messageId = dataset.messageId
      || (typeof article.getAttribute === "function" ? article.getAttribute("data-message-id") : "");
    return String(explicit || messageId || "").trim();
  }

  function captureMessageLayout(containerEl) {
    const snapshot = new Map();
    if (!containerEl || typeof containerEl.querySelectorAll !== "function") return snapshot;
    const rows = containerEl.querySelectorAll("article.message");
    Array.prototype.forEach.call(rows, (article) => {
      if (hasElementClass(article, "message-remove-ghost") || hasElementClass(article, "streaming")) return;
      const key = messageLayoutKey(article);
      if (!key) return;
      const rect = typeof article.getBoundingClientRect === "function" ? article.getBoundingClientRect() : null;
      const top = Number(rect?.top);
      if (!Number.isFinite(top)) return;
      snapshot.set(key, { top });
    });
    return snapshot;
  }

  function animateMessageLayoutShift(containerEl, previousLayout) {
    if (!containerEl || !previousLayout || !previousLayout.size || prefersReducedMotion()) return false;
    if (typeof containerEl.querySelectorAll !== "function") return false;
    let animated = false;
    const rows = containerEl.querySelectorAll("article.message");
    Array.prototype.forEach.call(rows, (article) => {
      if (!article || hasElementClass(article, "message-tail-enter") || hasElementClass(article, "message-remove-ghost") || hasElementClass(article, "streaming")) return;
      const key = messageLayoutKey(article);
      const previous = key ? previousLayout.get(key) : null;
      if (!previous) return;
      const rect = typeof article.getBoundingClientRect === "function" ? article.getBoundingClientRect() : null;
      const top = Number(rect?.top);
      if (!Number.isFinite(top)) return;
      const deltaY = Math.round((Number(previous.top) || 0) - top);
      if (Math.abs(deltaY) < 1 || typeof article.animate !== "function") return;
      addElementClass(article, "message-layout-shift");
      const cleanup = () => {
        removeElementClass(article, "message-layout-shift");
      };
      try {
        const animation = article.animate(
          [
            { transform: `translateY(${deltaY}px)` },
            { transform: "translateY(0)" }
          ],
          {
            duration: MESSAGE_LAYOUT_SHIFT_ANIMATION_MS,
            easing: "cubic-bezier(0.2, 0.7, 0.2, 1)"
          }
        );
        if (animation) {
          animation.onfinish = cleanup;
          animation.oncancel = cleanup;
        }
        setTimeout(cleanup, MESSAGE_LAYOUT_SHIFT_ANIMATION_MS + 80);
        animated = true;
      } catch (_) {
        cleanup();
      }
    });
    return animated;
  }

  function appendMessageRemoveGhost(target) {
    if (!target || typeof target.cloneNode !== "function") return null;
    const rect = typeof target.getBoundingClientRect === "function" ? target.getBoundingClientRect() : null;
    const top = Number(rect?.top);
    const left = Number(rect?.left);
    const width = Number(rect?.width);
    const height = Number(rect?.height);
    if (![top, left, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    let ghost = null;
    try {
      ghost = target.cloneNode(true);
    } catch (_) {
      return null;
    }
    if (!ghost) return null;
    addElementClass(ghost, "message-remove-ghost");
    try { ghost.setAttribute?.("aria-hidden", "true"); } catch (_) {}
    const style = ghost.style || {};
    style.position = "fixed";
    style.top = `${top}px`;
    style.left = `${left}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;
    style.margin = "0";
    style.zIndex = "30";
    style.pointerEvents = "none";
    style.boxSizing = "border-box";
    try {
      const parent = (typeof document !== "undefined" && document.body) || target.parentElement;
      parent?.appendChild?.(ghost);
    } catch (_) {
      return null;
    }
    return ghost;
  }

  function scheduleMessageRemoveGhostCleanup(ghost) {
    if (!ghost) return;
    const cleanup = () => {
      ghost.removeEventListener?.("animationend", cleanup);
      try { ghost.remove?.(); } catch (_) {}
    };
    ghost.addEventListener?.("animationend", cleanup, { once: true });
    setTimeout(cleanup, MESSAGE_REMOVE_ANIMATION_MS + 80);
  }

  function installChatScrollIntentTracker(chatEl) {
    if (!chatEl) return null;
    let intent = _chatScrollIntents.get(chatEl);
    if (!intent) {
      intent = {
        installed: false,
        lastScrollTop: Number(chatEl.scrollTop) || 0,
        userMovedAwayFromBottom: false
      };
      _chatScrollIntents.set(chatEl, intent);
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

  function animateChatTailToBottom(chatEl, _startBottomGap = 0) {
    if (!chatEl) return;
    stopChatBottomStickSession(chatEl);
    scrollChatToBottom(chatEl);
    scheduleChatBottomStick(chatEl, chatEl.scrollTop, 1, false);
  }

  function scheduleFrame(fn) {
    const schedule = typeof global.requestAnimationFrame === "function"
      ? global.requestAnimationFrame.bind(global)
      : (fn) => setTimeout(fn, 16);
    return schedule(fn);
  }

  function bottomStickUserMovedAway(chatEl, expectedScrollTop) {
    const currentTop = Number(chatEl?.scrollTop) || 0;
    const expectedTop = Number(expectedScrollTop) || 0;
    return currentTop < expectedTop - 1;
  }

  function stopChatBottomStickSession(chatEl, session = _chatBottomStickSessions.get(chatEl)) {
    if (!chatEl || !session) return;
    session.active = false;
    try { session.resizeObserver?.disconnect?.(); } catch (_) {}
    try { session.mutationObserver?.disconnect?.(); } catch (_) {}
    if (session.scrollHandler && typeof chatEl.removeEventListener === "function") {
      chatEl.removeEventListener("scroll", session.scrollHandler);
    }
    const clearTimer = typeof global.clearTimeout === "function"
      ? global.clearTimeout.bind(global)
      : (typeof clearTimeout === "function" ? clearTimeout : null);
    if (clearTimer && session.timeoutId) clearTimer(session.timeoutId);
    _chatBottomStickSessions.delete(chatEl);
  }

  function observeChatBottomStickChildren(chatEl, session) {
    if (!session?.resizeObserver || !chatEl?.children) return;
    for (const child of Array.from(chatEl.children)) {
      if (!child || session.observedChildren.has(child)) continue;
      session.observedChildren.add(child);
      try { session.resizeObserver.observe(child); } catch (_) {}
    }
  }

  function installChatBottomStickObservers(chatEl, session) {
    if (!chatEl || !session || session.observersInstalled) return;
    session.observersInstalled = true;
    const resync = () => {
      observeChatBottomStickChildren(chatEl, session);
      scheduleChatBottomStickStep(chatEl, session);
    };
    if (typeof global.ResizeObserver === "function") {
      session.observedChildren = new Set();
      session.resizeObserver = new global.ResizeObserver(resync);
      observeChatBottomStickChildren(chatEl, session);
    }
    if (typeof global.MutationObserver === "function") {
      session.mutationObserver = new global.MutationObserver(resync);
      try { session.mutationObserver.observe(chatEl, { childList: true, subtree: true }); } catch (_) {}
    }
    if (typeof chatEl.addEventListener === "function") {
      session.scrollHandler = () => {
        if (bottomStickUserMovedAway(chatEl, session.expectedScrollTop)) {
          stopChatBottomStickSession(chatEl, session);
        }
      };
      chatEl.addEventListener("scroll", session.scrollHandler, { passive: true });
    }
    const setTimer = typeof global.setTimeout === "function"
      ? global.setTimeout.bind(global)
      : (typeof setTimeout === "function" ? setTimeout : null);
    if (setTimer) {
      session.timeoutId = setTimer(() => stopChatBottomStickSession(chatEl, session), SCROLL_LAYOUT_OBSERVER_TIMEOUT_MS);
    }
  }

  function scheduleChatBottomStickStep(chatEl, session) {
    if (!chatEl || !session?.active || session.framePending) return;
    session.framePending = true;
    scheduleFrame(() => {
      session.framePending = false;
      if (!session.active || !chatEl) return;
      if (bottomStickUserMovedAway(chatEl, session.expectedScrollTop)) {
        stopChatBottomStickSession(chatEl, session);
        return;
      }
      scrollChatToBottom(chatEl);
      session.expectedScrollTop = Number(chatEl.scrollTop) || 0;
      if (session.remainingFrames > 0) {
        session.remainingFrames -= 1;
        scheduleChatBottomStickStep(chatEl, session);
      } else if (!session.observeLayout) {
        stopChatBottomStickSession(chatEl, session);
      }
    });
  }

  function scheduleChatBottomStick(chatEl, expectedScrollTop, remainingFrames = 1, observeLayout = false) {
    if (!chatEl || remainingFrames <= 0) return;
    let session = _chatBottomStickSessions.get(chatEl);
    if (!session?.active) {
      session = {
        active: true,
        expectedScrollTop: Number(expectedScrollTop) || 0,
        remainingFrames: 0,
        observeLayout: false,
        observedChildren: new Set(),
        framePending: false,
        observersInstalled: false,
        resizeObserver: null,
        mutationObserver: null,
        scrollHandler: null,
        timeoutId: 0
      };
      _chatBottomStickSessions.set(chatEl, session);
    }
    session.expectedScrollTop = Number(expectedScrollTop) || 0;
    session.remainingFrames = Math.max(session.remainingFrames || 0, remainingFrames);
    session.observeLayout = Boolean(session.observeLayout || observeLayout);
    if (session.observeLayout) installChatBottomStickObservers(chatEl, session);
    scheduleChatBottomStickStep(chatEl, session);
  }

  function stickChatToBottomAfterPermissionLayout(chatEl, shouldStick) {
    if (!chatEl || !shouldStick) return;
    const schedule = typeof global.requestAnimationFrame === "function"
      ? global.requestAnimationFrame.bind(global)
      : (fn) => setTimeout(fn, 16);
    schedule(() => {
      scrollChatToBottom(chatEl);
    });
  }

  function renderAgentPermissionBanner() {
    const banner = document.getElementById("agentPermissionBanner");
    if (!banner) return;
    const chatEl = document.getElementById("chat");
    const shouldStickChat = isChatPinnedToBottom(chatEl);
    const request = activePermissionRequest();
    if (!request) {
      banner.classList.add("hidden");
      banner.innerHTML = "";
      if (banner.dataset) delete banner.dataset.requestId;
      stickChatToBottomAfterPermissionLayout(chatEl, shouldStickChat);
      return;
    }
    const preview = compactPermissionPreview(request.preview);
    const previewHtml = preview
      ? `<code class="agent-permission-preview">${escapeHtml(preview)}</code>`
      : "";
    const isDecisionInFlight = _permissionDecisionInFlight.has(request.requestId);
    const disabledAttr = isDecisionInFlight ? " disabled" : "";
    banner.classList.remove("hidden");
    banner.dataset.requestId = request.requestId;
    banner.innerHTML = `
      <div class="agent-permission-heading">
        <div class="agent-permission-source">
          <span class="agent-permission-kicker">${escapeHtml(permissionEngineLabel(request.engine))} · ${escapeHtml(request.toolName)}</span>
        </div>
        <strong>${escapeHtml(compactPermissionTitle(request))}</strong>
      </div>
      ${request.description ? `<p class="agent-permission-description">${escapeHtml(request.description)}</p>` : ""}
      ${previewHtml}
      <div class="agent-permission-actions">
        <button type="button" class="agent-permission-button ghost agent-permission-deny" data-permission-decision="deny"${disabledAttr}>
          <span class="agent-permission-button-label">拒绝</span>
          <span class="agent-permission-key">esc</span>
        </button>
        <div class="agent-permission-allow-actions">
          <button type="button" class="agent-permission-button" data-permission-decision="allow_always"${disabledAttr}>
            <span class="agent-permission-button-label">始终允许</span>
          </button>
          <button type="button" class="agent-permission-button primary" data-permission-decision="allow_once" aria-label="允许本次"${disabledAttr}>
            <span class="agent-permission-button-label">允许</span>
            <span class="agent-permission-key">↵</span>
          </button>
        </div>
      </div>
    `;
    stickChatToBottomAfterPermissionLayout(chatEl, shouldStickChat);
  }

  async function submitPermissionDecision(button) {
    const banner = document.getElementById("agentPermissionBanner");
    const requestId = banner?.dataset?.requestId || "";
    const decision = button?.dataset?.permissionDecision || "";
    if (!requestId || !decision) return;
    const request = moduleState.pendingPermissionsById.get(requestId) || null;
    const isCloudRunApproval = request?.kind === "cloud-run-approval";
    const canRespond = isCloudRunApproval
      ? typeof window.mia?.social?.respondRunApproval === "function"
      : typeof window.mia?.respondChatPermission === "function";
    if (!canRespond) return;
    if (_permissionDecisionInFlight.has(requestId)) return;
    _permissionDecisionInFlight.add(requestId);
    const buttons = banner.querySelectorAll("button[data-permission-decision]");
    buttons.forEach((item) => { item.disabled = true; });
    try {
      const result = isCloudRunApproval
        ? await window.mia.social.respondRunApproval(request.conversationId, request.runId, decision)
        : await window.mia.respondChatPermission({ requestId, decision });
      if (!result || result.ok === false) throw new Error(result?.error || "权限审批失败");
      removePermissionRequestById(requestId);
      renderAgentPermissionBanner();
    } catch (error) {
      const message = String(error?.message || error || "");
      if (/permission request not found|权限申请未找到/i.test(message)) {
        removePermissionRequestById(requestId);
        renderAgentPermissionBanner();
        return;
      }
      buttons.forEach((item) => { item.disabled = false; });
      deps?.appendTransientChat?.("assistant", message || "权限审批失败");
    } finally {
      _permissionDecisionInFlight.delete(requestId);
    }
  }

  function isTextEntryTarget(target) {
    const tagName = String(target?.tagName || "").toLowerCase();
    return tagName === "input" || tagName === "textarea" || target?.isContentEditable === true;
  }

  function permissionDecisionButton(decision) {
    const banner = document.getElementById("agentPermissionBanner");
    if (!banner || banner.classList.contains("hidden")) return null;
    return banner.querySelector(`button[data-permission-decision="${decision}"]:not(:disabled)`);
  }

  function isPrimaryPointerActivation(event) {
    if (event?.type !== "pointerdown" && event?.type !== "mousedown") return true;
    return event.button == null || event.button === 0;
  }

  function closestPermissionDecisionButton(target) {
    const element = target?.closest ? target : target?.parentElement;
    return element?.closest?.("button[data-permission-decision]") || null;
  }

  function handlePermissionDecisionEvent(event) {
    if (!isPrimaryPointerActivation(event)) return null;
    const button = closestPermissionDecisionButton(event.target);
    if (!button || button.disabled) return null;
    event.preventDefault();
    event.stopPropagation();
    return submitPermissionDecision(button);
  }

  function wirePermissionBanner() {
    if (_permissionBannerWired) return;
    _permissionBannerWired = true;
    const banner = document.getElementById("agentPermissionBanner");
    banner?.addEventListener("pointerdown", handlePermissionDecisionEvent, true);
    banner?.addEventListener("click", handlePermissionDecisionEvent);
    document.addEventListener("keydown", (event) => {
      if (!activePermissionRequest() || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        const button = permissionDecisionButton("deny");
        if (!button) return;
        event.preventDefault();
        submitPermissionDecision(button);
      } else if (event.key === "Enter" && !event.shiftKey && !isTextEntryTarget(event.target)) {
        const button = permissionDecisionButton("allow_once");
        if (!button) return;
        event.preventDefault();
        submitPermissionDecision(button);
      }
    });
  }

  function scheduleCloudRunRender(conversationId) {
    if (conversationId !== moduleState.activeConversationId) return;
    if (_cloudRunRenderFrame) return;
    const schedule = typeof global.requestAnimationFrame === "function"
      ? global.requestAnimationFrame.bind(global)
      : (fn) => setTimeout(fn, 16);
    _cloudRunRenderFrame = schedule(() => {
      _cloudRunRenderFrame = 0;
      if (!updateActiveCloudRunStreamingArticle(conversationId)) {
        _reRenderActiveChat();
      }
      renderAgentPermissionBanner();
      // Header typing dots (replaces the old in-bubble "正在输入" status) — host
      // app owns the header DOM, so it provides the repaint callback via deps.
      if (deps && typeof deps.paintHeaderStatus === "function") deps.paintHeaderStatus();
    });
  }

  function findActiveStreamingArticle(chatEl) {
    if (!chatEl) return null;
    const direct = typeof chatEl.querySelector === "function"
      ? chatEl.querySelector(".message.streaming")
      : null;
    if (direct) return direct;
    const children = Array.isArray(chatEl.children) ? chatEl.children : Array.from(chatEl.children || []);
    return children.find((child) => hasElementClass(child, "message") && hasElementClass(child, "streaming")) || null;
  }

  function streamingRunHasRenderableOutput(run) {
    if (!run) return false;
    const blocks = displayedContentBlocksPayloadFromRun(run) || [];
    return Boolean(
      run.text
      || run.reasoning
      || (Array.isArray(run.tools) && run.tools.length)
      || blocks.length
      || (run.hasTypingActivity && isConversationRunBusy(run))
    );
  }

  function copyStreamingArticleIdentity(target, source) {
    if (!target || !source) return;
    target.className = source.className || target.className || "";
    const key = source.dataset?.messageLayoutKey
      || (typeof source.getAttribute === "function" ? source.getAttribute("data-message-layout-key") : "");
    if (!key) return;
    try { target.setAttribute?.("data-message-layout-key", key); } catch (_) {}
    try {
      if (target.dataset) target.dataset.messageLayoutKey = key;
    } catch (_) {}
  }

  function settleChatAfterStreamingUpdate(chatEl, wasNearBottom) {
    if (!chatEl || !wasNearBottom) return;
    scrollChatToBottom(chatEl);
    scheduleChatBottomStick(chatEl, chatEl.scrollTop, 1, false);
  }

  function updateActiveCloudRunStreamingArticle(conversationId) {
    if (!conversationId || conversationId !== moduleState.activeConversationId) return false;
    const chatEl = document.getElementById("chat");
    if (!chatEl) return false;
    const run = moduleState.cloudAgentRunsByConversation.get(conversationId);
    const existing = findActiveStreamingArticle(chatEl);
    if (!streamingRunHasRenderableOutput(run)) {
      if (existing && typeof existing.remove === "function") {
        existing.remove();
        markChatRenderFresh(chatEl, conversationId);
        settleChatAfterStreamingUpdate(chatEl, isChatPinnedToBottom(chatEl));
      }
      return true;
    }
    const conversation = moduleState.conversations.find((r) => r.id === conversationId);
    const color = avatarColor(conversationId);
    const conversationType = conversationTypeFor(conversation, conversationId);
    const members = (conversationType === "group" || conversationType === "bot")
      ? (_conversationMembersCache.get(conversationId) || [])
      : [];
    const nextArticle = _buildCloudAgentStreamingArticle(
      conversationId,
      color,
      members,
      { groupMessage: conversationType === "group" }
    );
    if (!nextArticle) return false;
    const wasNearBottom = isChatPinnedToBottom(chatEl);
    if (!existing) {
      chatEl.appendChild?.(nextArticle);
      window.miaAvatar?.hydrateAvatarVideos?.(nextArticle);
      markRenderedTraceBlocks(nextArticle);
      startPhaseOrbAnimation(nextArticle);
      initNameBadgeLotties(nextArticle);
      markChatRenderFresh(chatEl, conversationId);
      settleChatAfterStreamingUpdate(chatEl, wasNearBottom);
      return true;
    }
    copyStreamingArticleIdentity(existing, nextArticle);
    const nextHtml = String(nextArticle.innerHTML || "");
    if (String(existing.innerHTML || "") !== nextHtml) {
      existing.innerHTML = nextHtml;
    }
    window.miaAvatar?.hydrateAvatarVideos?.(existing);
    markRenderedTraceBlocks(existing);
    startPhaseOrbAnimation(existing);
    initNameBadgeLotties(existing);
    markChatRenderFresh(chatEl, conversationId);
    settleChatAfterStreamingUpdate(chatEl, wasNearBottom);
    return true;
  }

  function updateActiveCloudRunStatusLine(conversationId = moduleState.activeConversationId) {
    if (!conversationId || conversationId !== moduleState.activeConversationId) return false;
    const run = moduleState.cloudAgentRunsByConversation.get(conversationId);
    if (!run) return false;
    const chatEl = document.getElementById("chat");
    if (!chatEl || typeof chatEl.querySelector !== "function") return false;
    const statusEl = chatEl.querySelector(".message.streaming .agent-run-status")
      || chatEl.querySelector(".agent-run-status");
    return syncRunStatusLineElement(statusEl, run);
  }

  function refreshCloudRunStatusTimer() {
    clearStaleCloudAgentRuns();
    const hasRunningRun = Array.from(moduleState.cloudAgentRunsByConversation.values())
      .some((run) => isConversationRunBusy(run));
    if (!hasRunningRun) {
      if (_cloudRunStatusTimer && typeof global.clearInterval === "function") {
        global.clearInterval(_cloudRunStatusTimer);
      }
      _cloudRunStatusTimer = 0;
      return;
    }
    if (_cloudRunStatusTimer || typeof global.setInterval !== "function") return;
    _cloudRunStatusTimer = global.setInterval(() => {
      if (clearStaleCloudAgentRuns()) {
        refreshCloudRunStatusTimer();
        return;
      }
      const activeRun = activeConversationRun();
      if (!activeRun || !isConversationRunBusy(activeRun)) {
        refreshCloudRunStatusTimer();
        return;
      }
      if (!updateActiveCloudRunStatusLine()) {
        scheduleCloudRunRender(moduleState.activeConversationId);
      }
      if (deps && typeof deps.paintHeaderStatus === "function") deps.paintHeaderStatus();
    }, 1000);
  }

  function activeConversationRun() {
    const conversationId = moduleState.activeConversationId;
    if (!conversationId) return null;
    return moduleState.cloudAgentRunsByConversation.get(conversationId) || null;
  }

  function conversationRun(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) return null;
    return moduleState.cloudAgentRunsByConversation.get(id) || null;
  }

  function isConversationRunBusy(run) {
    const status = String(run?.status || "").trim();
    return status === "running" || status === "cancelling";
  }

  function isConversationRunTyping(run) {
    return String(run?.status || "").trim() === "running" && Boolean(run?.hasTypingActivity);
  }

  function conversationRunIsRunning(conversationId) {
    return conversationRun(conversationId)?.status === "running";
  }

  function conversationRunIsBusy(conversationId) {
    return isConversationRunBusy(conversationRun(conversationId));
  }

  function conversationRunIsTyping(conversationId) {
    return isConversationRunTyping(conversationRun(conversationId));
  }

  function activeConversationRunIsTyping() {
    return isConversationRunTyping(activeConversationRun());
  }

  function activeConversationCanSend() {
    const conversationId = moduleState.activeConversationId;
    return Boolean(conversationId) && !conversationRunIsBusy(conversationId);
  }

  // Parse dm:<a>:<b> and return the user-id that is NOT myUserId.
  function otherUserId(conversationId) {
    if (!conversationId || !conversationId.startsWith("dm:")) return null;
    const parts = conversationId.split(":");
    // format: dm:<uid_a>:<uid_b>
    const a = parts[1];
    const b = parts.slice(2).join(":");
    if (!a || !b) return null;
    return a === moduleState.myUserId ? b : a;
  }

  // Look up a friend object by userId.
  function friendById(userId) {
    return moduleState.friends.find((f) => f.id === userId) || null;
  }

  // Compute otherUser display info for a DM conversation.
  function otherUserForConversation(conversation) {
    const uid = otherUserId(conversation.id);
    if (!uid) return { id: "", username: conversation.name || conversation.id };
    const friend = friendById(uid);
    if (friend) return friend;
    return { id: uid, username: uid, account: uid };
  }

  // De-dup array of objects by id field.
  function dedup(arr, getId = (x) => x.id) {
    const seen = new Set();
    return arr.filter((item) => {
      const id = getId(item);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function ensureConversationMessageCache(conversationId) {
    if (!conversationId || moduleState.messageCache.has(conversationId)) return;
    moduleState.messageCache.set(conversationId, { messages: [], maxSeq: 0 });
  }

  function isLegacyBotSessionConversation(conversation) {
    void conversation;
    return false;
  }

  function isOtherDeviceConversationFilter(value) {
    return String(value || "").trim().toLowerCase() === OTHER_DEVICE_CONVERSATION_FILTER;
  }

  function starterBotKeyFromSessionId(sessionId = "") {
    const key = String(sessionId || "").trim();
    return /^starter_[^_]+_.+$/.test(key) ? key : "";
  }

  function cloudStarterBotKeyFromSessionId(sessionId = "") {
    const key = String(sessionId || "").trim();
    return /^starter_[^_]+_mia$/.test(key) ? key : "";
  }

  function isCanonicalBotConversationId(conversationId = "") {
    return String(conversationId || "").trim().startsWith("botc_");
  }

  function botKeyForConversation(conversation = {}, conversationId = "") {
    const decorated = sessionHistoryShared().botId(conversation);
    if (decorated) return decorated;
    return starterBotKeyFromSessionId(botSessionIdForConversation(conversation, conversationId || conversation?.id || ""));
  }

  function botRecordForConversation(conversation = {}) {
    if (sessionHistoryShared().conversationType(conversation, conversation?.id || "") !== "bot") return null;
    const botId = botKeyForConversation(conversation, conversation?.id || "");
    if (!botId) return null;
    return moduleState.bots.find((item) => botKeyFromRecord(item) === botId) || null;
  }

  function conversationRunsOnOtherDevice(conversation = {}) {
    const bot = botRecordForConversation(conversation);
    return Boolean(bot && global.miaBotManager?.botRunsOnOtherDevice?.(bot));
  }

  function botDirectoryAvailable() {
    // An empty bot list is not authoritative enough to hide cloud conversations.
    return Array.isArray(moduleState.bots) && moduleState.bots.length > 0;
  }

  function botConversationHasKnownIdentity(conversation = {}) {
    if (conversationTypeFor(conversation, conversation?.id || "") !== "bot") return true;
    if (!botDirectoryAvailable()) return true;
    const botId = botKeyForConversation(conversation, conversation?.id || "");
    if (!botId) return true;
    return (Array.isArray(moduleState.bots) ? moduleState.bots : [])
      .some((bot) => botKeyFromRecord(bot) === botId);
  }

  function isCoreMirrorConversation(conversation = {}) {
    const id = String(conversation?.id || "").trim();
    return id.startsWith("conv_") || id.startsWith("cloud_bridge_");
  }

  function visibleSocialConversations(conversations, options = {}) {
    if (!Array.isArray(conversations)) return [];
    const keepLegacyIds = new Set([
      String(options.activeConversationId || "").trim(),
      ...Object.values(options.preferredConversationIdByBotKey || {}).map((id) => String(id || "").trim())
    ].filter(Boolean));
    const filterName = options.ignoreTagFilter ? "" : String(moduleState.tagFilterName || "").trim().toLowerCase();
    const otherDeviceOnly = isOtherDeviceConversationFilter(filterName);
    const filteredTag = otherDeviceOnly ? "" : filterName;
    return conversations.filter((conversation) =>
      !isCoreMirrorConversation(conversation)
    ).filter((conversation) =>
      starterConversationBelongsToCurrentUser(conversation)
    ).filter((conversation) =>
      !isLegacyBotSessionConversation(conversation)
      || keepLegacyIds.has(String(conversation?.id || ""))
    ).filter((conversation) =>
      botConversationHasKnownIdentity(conversation)
    ).filter((conversation) => {
      const otherDevice = conversationRunsOnOtherDevice(conversation);
      if (otherDeviceOnly) return otherDevice;
      if (otherDevice && options.includeOtherDevice !== true) return false;
      if (!filteredTag) return true;
      return conversationTagsFor(conversation?.id).some((tag) =>
        String(tag?.name || "").trim().toLowerCase() === filteredTag);
    });
  }

  function upsertConversation(conversation) {
    if (!conversation || !conversation.id) return null;
    const idx = moduleState.conversations.findIndex((r) => r.id === conversation.id);
    if (idx >= 0) {
      moduleState.conversations[idx] = { ...moduleState.conversations[idx], ...conversation };
    } else {
      moduleState.conversations.push(conversation);
    }
    ensureConversationMessageCache(conversation.id);
    return moduleState.conversations.find((r) => r.id === conversation.id) || conversation;
  }

  function upsertBotConversation(conversation) {
    return upsertConversation(conversation);
  }

  function botConversationForKey(botKey) {
    const key = String(botKey || "").trim();
    if (!key) return null;
    const matches = moduleState.conversations.filter((conversation) => {
      const conversationId = String(conversation?.id || "");
      const decorated = String(conversation?.decorations?.botId || conversation?.botId || conversation?.bot_id || "").trim();
      return (conversation?.type === "bot" || conversationId.startsWith("botc_"))
        && decorated === key;
    });
    const preferredId = String(moduleState.lastBotConversationByKey?.[key] || "").trim();
    const preferred = preferredId && isCanonicalBotConversationId(preferredId)
      ? matches.find((conversation) => conversation.id === preferredId)
      : null;
    if (preferred) return preferred;
    const stable = matches.find((conversation) => String(conversation?.decorations?.sessionId || "") === key);
    if (stable) return stable;
    return matches.find((conversation) => !isLegacyBotSessionConversation(conversation)) || matches[0] || null;
  }

  function starterConversationParts(conversationId) {
    const match = /^botc_starter_([^_]+)_(.+)$/.exec(String(conversationId || "").trim());
    if (!match) return null;
    return { userId: match[1], suffix: match[2] };
  }

  function currentConversationOwnerUserId() {
    return String(moduleState.myUserId || currentCloudUserId() || "").trim();
  }

  function starterConversationBelongsToCurrentUser(conversation = {}) {
    const id = String(conversation?.id || conversation || "").trim();
    const parts = starterConversationParts(id);
    if (!parts) return true;
    const userId = currentConversationOwnerUserId();
    return !userId || parts.userId === userId;
  }

  function conversationById(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) return null;
    return moduleState.conversations.find((conversation) => conversation.id === id) || null;
  }

  function starterConversationReplacementId(conversationId) {
    const parts = starterConversationParts(conversationId);
    const userId = currentConversationOwnerUserId();
    if (!parts || !userId || parts.userId === userId) return "";
    const candidateId = `botc_starter_${userId}_${parts.suffix}`;
    const candidate = conversationById(candidateId);
    return candidate && starterConversationBelongsToCurrentUser(candidate) ? candidateId : "";
  }

  function availableConversationIdFor(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) return "";
    const existing = conversationById(id);
    if (existing && starterConversationBelongsToCurrentUser(existing)) return id;
    return starterConversationReplacementId(id);
  }

  function reconcileActiveConversationAgainstAvailableConversations() {
    const activeId = String(moduleState.activeConversationId || "").trim();
    if (!activeId) return false;
    const availableId = availableConversationIdFor(activeId);
    if (availableId === activeId) return false;
    setActiveConversationId(null);
    if (availableId) {
      setActiveConversationId(availableId);
    } else {
      clearLastActiveConversationId(activeId);
    }
    return true;
  }

  function currentState() {
    return (deps && typeof deps.getState === "function" && deps.getState()) || {};
  }

  async function ensureBotConversation(bot) {
    const botKey = String(bot?.key || bot?.id || "").trim();
    if (!botKey || !window.miaBotCommands?.ensureDesktopLocalBotConversation) return null;
    try {
      const result = await window.miaBotCommands.ensureDesktopLocalBotConversation({
        api: window.mia?.social,
        state: currentState(),
        ["bot"]: { ...bot, key: botKey },
        engineContracts: window.miaEngineContracts,
        onConversation: upsertConversation
      });
      const conversation = result.conversation || null;
      return conversation;
    } catch (error) {
      console.warn("[social] ensure bot conversation failed", botKey, error);
      return null;
    }
  }

  function botSessionIdForConversation(conversation = {}, conversationId = "") {
    const decorations = conversation?.decorations || {};
    return firstText(
      decorations.sessionId,
      decorations.session_id,
      String(conversationId || "").startsWith("botc_") ? String(conversationId).slice(5) : ""
    );
  }

  function runtimeKindForBotConversation(conversation = {}) {
    const bot = botRecordForConversation(conversation);
    const botRuntimeKind = firstText(bot?.runtimeKind, bot?.runtime_kind);
    if (botRuntimeKind) return botRuntimeKind;
    const history = sessionHistoryShared();
    if (typeof history.runtimeKind === "function") {
      const runtimeKind = history.runtimeKind(conversation, "");
      if (runtimeKind) return runtimeKind;
    }
    const decorations = conversation?.decorations || {};
    const decoratedRuntimeKind = firstText(decorations.runtimeKind, decorations.runtime_kind);
    if (decoratedRuntimeKind) return decoratedRuntimeKind;
    const sessionId = botSessionIdForConversation(conversation, conversation?.id || "");
    if (cloudStarterBotKeyFromSessionId(sessionId)) return "cloud-claude-code";
    return "desktop-local";
  }

  function agentEngineForBotConversation(conversation = {}) {
    const bot = botRecordForConversation(conversation);
    const decorations = conversation?.decorations || {};
    const metadata = conversation?.metadata || {};
    const candidate = firstText(
      bot?.agentEngine,
      bot?.agent_engine,
      decorations.agentEngine,
      decorations.agent_engine,
      decorations.starterEngineId,
      decorations.starter_engine_id,
      metadata.starterEngineId,
      metadata.starter_engine_id,
      sessionHistoryShared().botId(conversation)
    );
    const normalized = candidate.toLowerCase().replace(/_/g, "-");
    if (normalized.includes("claude")) return "claude-code";
    if (normalized.includes("hermes")) return "hermes";
    if (normalized.includes("codex")) return "codex";
    return candidate;
  }

  function botPostContextForConversation(conversation = {}, conversationId = "") {
    if (conversationTypeFor(conversation, conversationId) !== "bot") return null;
    const sessionId = botSessionIdForConversation(conversation, conversationId);
    const botId = botKeyForConversation(conversation, conversationId);
    const runtimeKind = runtimeKindForBotConversation(conversation);
    if (!runtimeKind) return null;
    const context = { runtimeKind };
    if (botId) context.botId = botId;
    if (sessionId) context.sessionId = sessionId;
    if (runtimeKind === "desktop-local") {
      const agentEngine = agentEngineForBotConversation(conversation);
      if (agentEngine) context.agentEngine = agentEngine;
      if (conversation?.name || conversation?.title) context.botName = conversation.name || conversation.title;
    }
    return context;
  }

  function botRuntimeControlPostOverrides(options = {}) {
    const input = options?.botRuntimeControl && typeof options.botRuntimeControl === "object"
      ? options.botRuntimeControl
      : {};
    const context = {};
    for (const [target, sources] of [
      ["providerConnectionId", ["providerConnectionId", "provider_connection_id", "provider"]],
      ["modelProfileId", ["modelProfileId", "model_profile_id", "profileId", "profile_id"]],
      ["model", ["model"]],
      ["effortLevel", ["effortLevel", "effort_level"]],
      ["permissionMode", ["permissionMode", "permission_mode"]]
    ]) {
      const value = firstText(...sources.map((source) => input[source]));
      if (value) context[target] = value;
    }
    return context;
  }

  function ensuredConversationFromResult(result) {
    return result?.data?.conversation || result?.conversation || null;
  }

  function ensuredMembersFromResult(result) {
    const members = result?.data?.members || result?.members || null;
    return Array.isArray(members) ? members : null;
  }

  async function ensurePostableConversation(conversationId, conversation) {
    const id = String(conversationId || "").trim();
    const current = conversation || moduleState.conversations.find((item) => item.id === id) || { id };
    if (conversationTypeFor(current, id) !== "bot") return { conversationId: id, conversation: current };
    const runtimeKind = runtimeKindForBotConversation(current);
    const isDesktopLocal = runtimeKind === "desktop-local";
    const botId = botKeyForConversation(current, id);
    const sessionId = botSessionIdForConversation(current, id);
    const api = window.mia?.social;
    if (!botId || !sessionId || typeof api?.ensureBotSessionConversation !== "function") {
      return { conversationId: id, conversation: current };
    }
    const result = await api.ensureBotSessionConversation(sessionId, {
      botId,
      title: current.name || "新对话",
      runtimeKind: runtimeKindForBotConversation(current)
    });
    if (result && result.ok === false) {
      if (isDesktopLocal) {
        console.warn("[social] desktop-local conversation sync failed; continuing locally", result.error || result.message || result.data?.error || "unknown");
        return { conversationId: id, conversation: current };
      }
      throw new Error(result.error || result.message || result.data?.error || "创建 Bot 会话失败");
    }
    const ensured = ensuredConversationFromResult(result);
    if (!ensured?.id) return { conversationId: id, conversation: current };
    if (runtimeKind !== "desktop-local" && isCoreMirrorConversation(ensured)) {
      return { conversationId: id, conversation: current };
    }
    const saved = upsertConversation(ensured);
    const members = ensuredMembersFromResult(result);
    if (members) _conversationMembersCache.set(ensured.id, members);
    if (isDesktopLocal && ensured.id !== id) {
      return { conversationId: id, conversation: current };
    }
    return { conversationId: ensured.id, conversation: saved || ensured };
  }

  function conversationTypeFor(conversation, conversationId = "") {
    return sessionHistoryShared().conversationType(conversation, conversationId) || null;
  }

  function sendPipelineMembersForConversation(conversationType, members) {
    if (conversationType !== "group") return Array.isArray(members) ? members : [];
    return (Array.isArray(members) ? members : [])
      .filter(Boolean)
      .map((m) => ({
        ...m,
        kind: m.member_kind || m.kind,
        ref: m.member_ref || m.ref,
        name: m.name || m.bot_name || m.username || m.displayName || ""
      }));
  }

  function cloudMentionForConversation(conversationType, mention) {
    if (conversationType !== "group") return mention;
    if (!mention || mention.kind !== "bot" || !mention.ref) return null;
    return { kind: "bot", botId: mention.ref };
  }

  function postMentionsForConversation(conversationType, mentions) {
    return (Array.isArray(mentions) ? mentions : [])
      .map((mention) => cloudMentionForConversation(conversationType, mention))
      .filter(Boolean);
  }

  // Resolve "is this message from me?" through shared/contact (resolveContact
  // returns kind="self" only when ref matches ctx.self.id). Falls back to
  // false when the helper isn't loaded (test sandbox or pre-bootstrap).
  function _isMessageFromSelf(msg) {
    const helper = (typeof window !== "undefined" && window.miaContact) || null;
    if (!helper || typeof helper.resolveContact !== "function") return false;
    const { resolveContact, IdentityKind } = helper;
    const ctx = adapterCtx();
    const contact = resolveContact(
      { kind: IdentityKind?.User || "user", ref: msg && msg.sender_ref },
      ctx
    );
    return Boolean(contact && contact.id && contact.id === ctx.self?.id);
  }

  function currentSelfUserId() {
    return String(moduleState.myUserId || window.__miaCoreUserId || "").trim();
  }

  function memberNameForSender(conversationId, senderKind, senderRef) {
    const members = _conversationMembersCache.get(conversationId) || [];
    const member = members.find((item) => {
      const kind = String(item?.member_kind || item?.kind || item?.identity?.kind || "").trim();
      const ref = String(item?.member_ref || item?.ref || item?.identity?.id || "").trim();
      return ref === senderRef && (!senderKind || kind === senderKind);
    });
    if (!member) return "";
    const identity = member.identity || {};
    return firstText(
      identity.displayName,
      identity.display_name,
      member.displayName,
      member.display_name,
      member.name,
      member.username,
      member.account,
      member.bot_name
    );
  }

  function senderNameForMessage(conversationId, message = {}) {
    const { SenderKind } = conversationKinds();
    const senderKind = String(message.sender_kind || message.senderKind || SenderKind.User).trim();
    const senderRef = String(message.sender_ref || message.senderRef || "").trim();
    const helper = (typeof window !== "undefined" && window.miaContact) || null;
    if (helper && typeof helper.resolveContact === "function") {
      const identityKind = helper.IdentityKind || {};
      const kind = senderKind === SenderKind.Bot ? identityKind.Bot || "bot" : identityKind.User || "user";
      const contact = helper.resolveContact({ kind, ref: senderRef }, adapterCtx());
      const name = firstText(contact?.displayName, contact?.account, contact?.id);
      if (name) return name;
    }
    return firstText(memberNameForSender(conversationId, senderKind, senderRef), senderRef);
  }

  function conversationNameForNotification(conversationId, conversation, senderName) {
    const type = conversationTypeFor(conversation, conversationId);
    if (type === "dm") {
      const otherUser = conversation ? otherUserForConversation(conversation) : null;
      return firstText(otherUser?.displayName, otherUser?.username, otherUser?.account, conversation?.name, senderName, "Mia");
    }
    return firstText(conversation?.name, senderName, "Mia");
  }

  function notificationBodyForMessage(message = {}) {
    const body = String(message.body_md || message.bodyMd || "").replace(/\s+/g, " ").trim();
    if (body) return body;
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    return attachments.length ? "[附件]" : "新消息";
  }

  function desktopMessageNotificationPayload(conversationId, message = {}) {
    const conversation = moduleState.conversations.find((item) => item.id === conversationId) || null;
    const senderName = senderNameForMessage(conversationId, message);
    const conversationName = conversationNameForNotification(conversationId, conversation, senderName);
    const type = conversationTypeFor(conversation, conversationId);
    const title = type === "group" && senderName && conversationName && senderName !== conversationName
      ? `${senderName} @ ${conversationName}`
      : firstText(senderName, conversationName, "Mia");
    return {
      title,
      body: notificationBodyForMessage(message),
      conversationId,
      messageId: String(message.id || "").trim()
    };
  }

  function desktopNotificationsEnabled() {
    const runtime = currentState().runtime || {};
    return runtime.appearance?.showDesktopNotifications !== false;
  }

  function maybeNotifyDesktopMessage(conversationId, message, { fresh, isMine } = {}) {
    if (!fresh || isMine || !conversationId) return;
    if (!desktopNotificationsEnabled()) return;
    if (isConversationMuted(conversationId)) return;
    const windowFocused = typeof deps?.isWindowFocused === "function" ? deps.isWindowFocused() !== false : true;
    if (windowFocused && conversationId === moduleState.activeConversationId) return;
    if (typeof deps?.showDesktopMessageNotification !== "function") return;
    const payload = desktopMessageNotificationPayload(conversationId, message);
    try {
      const task = deps.showDesktopMessageNotification(payload);
      if (task && typeof task.catch === "function") {
        task.catch((error) => console.warn("[social] desktop notification failed:", error?.message || error));
      }
    } catch (error) {
      console.warn("[social] desktop notification failed:", error?.message || error);
    }
  }

  // Resolve "is this a user-role message?" by routing through the canonical
  // cloud-conversation-source adapter and reading spec.role. Falls back to false when
  // the adapter isn't loaded (test sandbox or pre-bootstrap).
  function _isUserRoleMessage(msg) {
    const factory = (typeof window !== "undefined" && window.miaCloudConversationSource) || null;
    if (!factory || typeof factory.createCloudConversationSource !== "function") return false;
    const conversation = moduleState.conversations.find((r) => r.id === moduleState.activeConversationId) || { id: moduleState.activeConversationId || "" };
    const source = factory.createCloudConversationSource({ conversation, messages: [msg], members: [], ctx: adapterCtx() });
    const spec = source.listMessages()[0];
    return !!spec && spec.role === "user";
  }

  function adapterCtx() {
    const runtimeState = deps && typeof deps.getState === "function" ? deps.getState() : {};
    const runtime = runtimeState.runtime || {};
    const cloudUser = runtime.cloud?.user || {};
    const localUser = runtime.user || {};
    const identityBots = Array.isArray(moduleState.bots) ? moduleState.bots : [];
    const bots = window.miaBotDirectory
      ? window.miaBotDirectory.listOwnedBots({ identityBots, runtime })
      : identityBots;
    const self = window.miaSelfIdentity.resolveSelfIdentity({
      cloudUser,
      localUser,
      myUserId: currentSelfUserId(),
      myUsername: moduleState.myUsername
    });
    return {
      self: {
        id: self.id,
        displayName: self.displayName,
        avatarText: self.avatarText,
        username: self.username,
        account: self.account,
        avatarImage: self.avatarImage,
        avatarCrop: self.avatarCrop,
        avatarColor: self.avatarColor || "",
        statusBadge: self.statusBadge || null
      },
      bots,
      friends: moduleState.friends || []
      // Self identity precedence lives in shared/self-identity.js so the rail
      // account button and these chat avatars can never drift apart again.
    };
  }

  // ── initSocialModule ──────────────────────────────────────────────────────

  function initSocialModule(d) {
    deps = d;
    wirePermissionBanner();
    renderAgentPermissionBanner();
  }

  function currentCloudUserId() {
    const runtime = currentState().runtime || {};
    const cloudUser = runtime.cloud?.user || {};
    return String(cloudUser.id || cloudUser.userId || moduleState.myUserId || "").trim();
  }

  async function warmMessagesFromLocalCache(api, conversations) {
    if (!api || typeof api.getCachedConversationMessages !== "function") return;
    await Promise.all((conversations || []).slice(0, INITIAL_CONVERSATIONS_CAP).map(async (conversation) => {
      if (!conversation?.id) return;
      if (!moduleState.messageCache.has(conversation.id)) {
        moduleState.messageCache.set(conversation.id, { messages: [], maxSeq: 0 });
      }
      try {
        const cachedRes = await api.getCachedConversationMessages(conversation.id, 50);
        const cached = cachedRes?.ok ? (cachedRes.data?.messages || []) : [];
        if (cached.length) _mergeMessagesIntoCache(conversation.id, cached);
      } catch (err) {
        console.warn("[social] cached bootstrap messages failed for", conversation.id, err?.message || err);
      }
    }));
  }

  async function hydrateCachedSocialBootstrap(api) {
    const userId = currentCloudUserId();
    if (!userId || !api || typeof api.getCachedSocialBootstrap !== "function") return false;
    let snapshot = null;
    try {
      const res = await api.getCachedSocialBootstrap(userId);
      snapshot = res?.ok ? res.data : null;
    } catch (err) {
      console.warn("[social] getCachedSocialBootstrap failed:", err?.message || err);
      return false;
    }
    if (!snapshot || snapshot.userId !== userId || !Array.isArray(snapshot.conversations) || !snapshot.conversations.length) return false;
    moduleState.myUserId = userId;
    moduleState.conversations = snapshot.conversations;
    moduleState.friends = Array.isArray(snapshot.friends) ? snapshot.friends : [];
    moduleState.bots = Array.isArray(snapshot.bots) ? snapshot.bots : [];
    moduleState.botsLoaded = Array.isArray(snapshot.bots);
    _conversationMembersCache.clear();
    for (const [conversationId, list] of Object.entries(snapshot.members || {})) {
      if (Array.isArray(list)) _conversationMembersCache.set(conversationId, list);
    }
    await warmMessagesFromLocalCache(api, visibleSocialConversations(moduleState.conversations));
    restoreLastActiveConversation();
    moduleState.bootstrapped = true;
    if (deps && typeof deps.render === "function") deps.render();
    return true;
  }

  function botKeyFromRecord(bot = {}) {
    return String(bot?.key || bot?.id || bot?.botId || bot?.bot_id || "").trim();
  }

  function mergeBotIdentity(existing = null, incoming = {}) {
    const key = botKeyFromRecord(incoming) || botKeyFromRecord(existing);
    const runtimeFields = {};
    for (const field of [
      "runtimeKind",
      "agentEngine",
      "targetDeviceId",
      "targetDeviceName",
      "deviceId",
      "deviceName",
      "runtimeLabel"
    ]) {
      if (existing && existing[field] !== undefined) {
        runtimeFields[field] = existing[field];
      }
    }
    const sourceKinds = [...new Set([
      ...((Array.isArray(existing?.sourceKinds) ? existing.sourceKinds : []).filter(Boolean)),
      ...((Array.isArray(incoming?.sourceKinds) ? incoming.sourceKinds : ["cloud"]).filter(Boolean))
    ])];
    return {
      ...(existing || {}),
      ...incoming,
      ...runtimeFields,
      key,
      ...(sourceKinds.length ? { sourceKinds } : {})
    };
  }

  function upsertBotIdentity(bot) {
    const key = botKeyFromRecord(bot);
    if (!key) return false;
    const existing = moduleState.bots.find((item) => botKeyFromRecord(item) === key) || null;
    moduleState.bots = [
      mergeBotIdentity(existing, bot),
      ...moduleState.bots.filter((item) => botKeyFromRecord(item) !== key)
    ];
    return true;
  }

  function applyBotRuntimeBinding(binding = {}) {
    const key = String(binding.botId || binding.bot_id || "").trim();
    if (!key || binding.enabled === false) return false;
    const existing = moduleState.bots.find((item) => botKeyFromRecord(item) === key) || null;
    if (!existing) return false;
    const config = binding.config && typeof binding.config === "object" ? binding.config : {};
    const runtimeKind = String(binding.runtimeKind || binding.runtime_kind || existing.runtimeKind || "desktop-local").trim();
    const agentEngine = String(config.agentEngine || config.agent_engine || "").trim();
    const deviceId = runtimeKind === "cloud-claude-code"
      ? ""
      : String(config.deviceId || config.device_id || config.targetDeviceId || "").trim();
    const deviceName = runtimeKind === "cloud-claude-code"
      ? "Mia Cloud"
      : String(config.deviceName || config.device_name || "").trim();
    const updated = {
      ...existing,
      runtimeKind,
      runtimeConfig: config,
      agentEngine,
      targetDeviceId: deviceId,
      targetDeviceName: deviceName,
      deviceId,
      deviceName,
      runtimeLabel: runtimeKind === "cloud-claude-code" ? "Mia Cloud" : (deviceName || "当前设备")
    };
    moduleState.bots = [
      updated,
      ...moduleState.bots.filter((item) => botKeyFromRecord(item) !== key)
    ];
    return true;
  }

  function hydrateVisibleBotIdentities(api, conversations = []) {
    if (!api || typeof api.getBotIdentity !== "function") return;
    const ids = [...new Set((Array.isArray(conversations) ? conversations : [])
      .map((conversation) => sessionHistoryShared().botId(conversation))
      .map((id) => String(id || "").trim())
      .filter(Boolean))];
    for (const botId of ids) {
      if (_hydratingBotIdentities.has(botId)) continue;
      const existing = moduleState.bots.find((item) => botKeyFromRecord(item) === botId);
      if (existing && (existing.avatarImage || existing.avatar_image)) continue;
      _hydratingBotIdentities.add(botId);
      Promise.resolve(api.getBotIdentity(botId))
        .then((res) => {
          const bot = res?.ok ? res.data?.bot : res?.bot;
          if (bot && upsertBotIdentity(bot) && deps && typeof deps.render === "function") deps.render();
        })
        .catch((err) => console.warn("[social] getBotIdentity failed for", botId, err?.message || err))
        .finally(() => _hydratingBotIdentities.delete(botId));
    }
  }

  // ── bootstrapAfterLogin ───────────────────────────────────────────────────

  async function bootstrapAfterLogin() {
    if (!window.mia || !window.mia.social) {
      console.warn("[social] window.mia.social not available — skip bootstrap");
      return;
    }
    const api = window.mia.social;
    let bootstrapCompleted = false;
    try {
      await hydrateCachedSocialBootstrap(api);
      const [meRes, friendsRes, incomingRes, outgoingRes, botsRes] = await Promise.all([
        api.myIdentity(),
        api.listFriends(),
        api.listFriendRequests("incoming"),
        api.listFriendRequests("outgoing"),
        typeof api.listBots === "function" ? api.listBots() : Promise.resolve({ ok: true, data: { bots: [] } }),
      ]);
      // Dead/expired token: every call comes back 401. cloud.enabled is still
      // true (token present), so without this the app sits "logged in" but empty.
      // Hand off to the auth-expired handler (logout + login guide) and stop.
      if (!meRes.ok && meRes.status === 401) {
        if (deps && typeof deps.onCloudAuthExpired === "function") deps.onCloudAuthExpired();
        return;
      }
      if (meRes.ok) {
        const freshUserId = meRes.data.id || "";
        // Account switch since the cached social bootstrap was written → drop the
        // stale render cache so we don't briefly show another user's conversations.
        if (moduleState.myUserId && freshUserId && moduleState.myUserId !== freshUserId) {
          setActiveConversationId(null);
          moduleState.conversations = [];
          moduleState.messageCache.clear();
          _conversationMembersCache.clear();
          moduleState.unreadByConversation.clear();
        }
        moduleState.myUsername = meRes.data.username || "";
        moduleState.myUserId = freshUserId;
      }
      if (friendsRes.ok) moduleState.friends = friendsRes.data?.friends || [];
      if (botsRes.ok) {
        moduleState.bots = botsRes.data?.bots || [];
        moduleState.botsLoaded = true;
      }
      if (incomingRes.ok) moduleState.incomingRequests = incomingRes.data?.requests || [];
      if (outgoingRes.ok) moduleState.outgoingRequests = outgoingRes.data?.requests || [];

      const conversationsRes = await api.listConversations();
      if (conversationsRes.ok) {
        moduleState.conversations = conversationsRes.data?.conversations || [];
        reconcileActiveConversationAgainstAvailableConversations();
        bootstrapCompleted = true;
      }
      hydrateVisibleBotIdentities(api, visibleSocialConversations(moduleState.conversations).slice(0, INITIAL_CONVERSATIONS_CAP));

      // Phase 3: cross-device user settings (pin / read marks / appearance).
      await bootstrapCloudSettings();

      // Fetch initial messages for up to INITIAL_CONVERSATIONS_CAP conversations.
      const conversationsToFetch = visibleSocialConversations(moduleState.conversations).slice(0, INITIAL_CONVERSATIONS_CAP);
      // Prefetch members for group mosaics and bot private chats. Bot chats need
      // the member public identity so sidebar/header/bubbles hash the same
      // public bot identity and can show cross-device avatars.
      const memberConversationsToFetch = visibleSocialConversations(moduleState.conversations).filter((r) => {
        const t = r.type
          || (r.id?.startsWith("dm:") ? "dm"
            : r.id?.startsWith("botc_") ? "bot"
            : (r.id?.startsWith("g_") || r.id?.startsWith("g-")) ? "group"
            : null);
        return t === "group" || t === "bot";
      });
      await Promise.all(memberConversationsToFetch.map((r) => _fetchAndCacheConversationMembers(r.id)));
      await Promise.all(conversationsToFetch.map(async (conversation) => {
        if (!moduleState.messageCache.has(conversation.id)) {
          moduleState.messageCache.set(conversation.id, { messages: [], maxSeq: 0 });
        }
        // Warm from the SQLite cache first (instant, offline-ok), then fetch a
        // bounded overlap from cloud so cached rows can pick up newer fields.
        // The delta cursor comes from the persisted cache, not any stale renderer
        // memory left from the current session.
        let cachedMaxSeq = 0;
        if (typeof api.getCachedConversationMessages === "function") {
          try {
            const cachedRes = await api.getCachedConversationMessages(conversation.id, 50);
            const cached = cachedRes?.ok ? (cachedRes.data?.messages || []) : [];
            if (cached.length) {
              _mergeMessagesIntoCache(conversation.id, cached);
              cachedMaxSeq = cached.reduce((m, x) => Math.max(m, Number(x.seq) || 0), 0);
            }
          } catch (err) {
            console.warn("[social] getCachedConversationMessages failed for", conversation.id, err);
          }
        }
        try {
          const sinceSeq = Math.max(0, cachedMaxSeq - MESSAGE_BACKFILL_OVERLAP);
          const msgRes = await api.listConversationMessages(conversation.id, sinceSeq, 100);
          if (msgRes.ok) {
            const fresh = (msgRes.data?.messages || []).map((m) => messageWithFallbackRunTrace(conversation.id, m));
            _mergeMessagesIntoCache(conversation.id, fresh);
          }
        } catch (err) {
          console.warn("[social] listConversationMessages failed for", conversation.id, err);
        }
        if (deps && typeof deps.maybeGenerateConversationTitle === "function") {
          Promise.resolve(deps.maybeGenerateConversationTitle(conversation.id)).catch(() => {});
        }
      }));

    } catch (err) {
      console.error("[social] bootstrapAfterLogin failed:", err);
    }
    restoreLastActiveConversation();
    // Flip the bootstrap flag AFTER everything is in the cache so the
    // first render that includes cloud rows also has bot personas —
    // the sidebar shows both data sources in one paint instead of
    // "personas now, conversations later" (the visible "割裂" the user reported).
    if (bootstrapCompleted) moduleState.bootstrapped = true;
    if (deps && typeof deps.render === "function") deps.render();
  }

  function isBootstrapped() {
    return Boolean(moduleState.bootstrapped);
  }

  // ── toast helper (used for new friend-request notifications) ────────────

  let _toastTimer = 0;
  function showFriendRequestToast(fromName) {
    const el = document.getElementById("appToast");
    if (!el) return;
    el.innerHTML = `
      <strong>新好友申请</strong>
      <span>${String(fromName || "").replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[ch]))} 想加你为好友</span>
      <button type="button" class="app-toast-action">查看</button>
    `;
    el.classList.remove("hidden");
    el.querySelector(".app-toast-action")?.addEventListener("click", () => {
      el.classList.add("hidden");
      openAddFriendDialog();
    }, { once: true });
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.add("hidden"), 6000);
  }

  // ── handleCloudEvent ──────────────────────────────────────────────────────

  function handleCloudEvent(event) {
    if (!event) return;
    const type = cloudEventEnvelopeType(event);
    if (!type) return;
    const payload = cloudEventEnvelopePayload(event);

    // Every time the WS reconnects (events_ready), re-pull authoritative
    // state from the cloud. Otherwise any social events that were
    // broadcast while we were disconnected stay invisible until restart.
    if (type === "events_ready") {
      bootstrapAfterLogin().catch((err) => console.warn("[social] rebootstrap on events_ready failed:", err));
      return;
    }

    if (type === "daemon.local_events_status") {
      if (payload?.connected === false) {
        if (clearBusyCloudAgentRuns()) refreshCloudRunStatusTimer();
      }
      return;
    }

    // Phase 3: another device wrote account-scoped settings — replace local
    // cache so pins / read marks / tags match across devices in real time.
    // payload is the full envelope { type, settings, seq, ... }.
    if (type === "user_settings.updated") {
      const settings = payload && payload.settings ? payload.settings : null;
      if (settings) applyCloudSettings(settings);
      return;
    }

    if (type === "bot.upserted") {
      const bot = payload?.bot;
      const key = String(bot?.key || bot?.id || "").trim();
      if (!key) return;
      upsertBotIdentity(bot);
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "bot.runtime_updated") {
      if (applyBotRuntimeBinding(payload?.binding) && deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "bot.deleted") {
      const botId = String(payload?.botId || payload?.id || "").trim();
      if (!botId) return;
      moduleState.bots = moduleState.bots.filter((item) => String(item?.key || item?.id || "") !== botId);
      const removedConversationIds = [];
      moduleState.conversations = moduleState.conversations.filter((conversation) => {
        const remove = sessionHistoryShared().botId(conversation) === botId;
        if (remove && conversation?.id) removedConversationIds.push(String(conversation.id));
        return !remove;
      });
      for (const conversationId of removedConversationIds) {
        moduleState.messageCache.delete(conversationId);
        moduleState.unreadByConversation.delete(conversationId);
        _conversationMembersCache.delete(conversationId);
      }
      if (removedConversationIds.includes(String(moduleState.activeConversationId || ""))) {
        moduleState.activeConversationId = null;
      }
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "social.friend_request_received") {
      const req = payload && payload.request;
      if (!req) return;
      // De-dup
      const seen = moduleState.incomingRequests.find((r) => r.id === req.id);
      if (!seen) {
        moduleState.incomingRequests.push(req);
        const fromName = req.from?.username || req.from?.account || req.from_user || "陌生人";
        showFriendRequestToast(fromName);
      }
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "social.friend_added") {
      const { friend, conversation } = payload || {};
      if (friend) {
        moduleState.friends = dedup([...moduleState.friends, friend]);
      }
      if (conversation) {
        upsertConversation(conversation);
      }
      // Remove matching pending requests from both lists
      if (friend) {
        moduleState.outgoingRequests = moduleState.outgoingRequests.filter(
          (r) => r.to_user !== friend.id && r.to_user !== friend.username && r.to_user !== friend.account
        );
        moduleState.incomingRequests = moduleState.incomingRequests.filter(
          (r) => r.from_user !== friend.id && r.from_user !== friend.username && r.from_user !== friend.account
        );
      }
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "cloud_agent_run_started") {
      const conversationId = payload?.conversationId;
      if (!conversationId) return;
      const previousRun = moduleState.cloudAgentRunsByConversation.get(conversationId);
      const wasBusy = isConversationRunBusy(previousRun);
      const run = cloudRunFor(conversationId, payload.runId || "");
      run.runId = payload.runId || run.runId;
      run.turnId = payload.turnId || payload.turn_id || run.turnId || "";
      run.hermesRunId = payload.hermesRunId || run.hermesRunId || "";
      run.botId = payload.botId || run.botId || "";
      run.status = "running";
      markCloudRunActivity(run);
      if (!wasBusy && deps && typeof deps.render === "function") deps.render();
      scheduleCloudRunRender(conversationId);
      refreshCloudRunStatusTimer();
      return;
    }

    if (type === "cloud_agent_run_event") {
      const conversationId = payload?.conversationId;
      const hermesEvent = payload?.event || {};
      if (!conversationId) return;
      const previousRun = moduleState.cloudAgentRunsByConversation.get(conversationId);
      const previousStatus = previousRun?.status || "";
      const wasBusy = isConversationRunBusy(previousRun);
      const run = cloudRunFor(conversationId, payload.runId || "");
      run.runId = payload.runId || run.runId;
      run.hermesRunId = payload.hermesRunId || run.hermesRunId || "";
      run.botId = payload.botId || run.botId || "";
      const hermesEventType = eventType(hermesEvent);
      markCloudRunActivity(run);
      applyCloudAgentRunEvent(run, hermesEvent);
      if (hermesEventType === "approval.request" || hermesEventType === "approval.responded") {
        renderAgentPermissionBanner();
      }
      if (run.status === "cancelled") {
        materializeCancelledCloudRun(conversationId, run);
        clearRunPermissions(run);
        moduleState.cloudAgentRunsByConversation.delete(conversationId);
        renderAgentPermissionBanner();
        refreshCloudRunStatusTimer();
        if (deps && typeof deps.render === "function") deps.render();
        if (conversationId === moduleState.activeConversationId) _reRenderActiveChat({ force: true });
        return;
      }
      const isBusy = isConversationRunBusy(run);
      if ((!previousRun && isBusy) || wasBusy !== isBusy || previousStatus !== run.status) {
        if (deps && typeof deps.render === "function") deps.render();
      }
      const isTextDelta = hermesEventType === "message.delta" || hermesEventType === "text_delta";
      const hasStreamingArticle = conversationId === moduleState.activeConversationId
        && findActiveStreamingArticle(document.getElementById("chat"));
      if (!isTextDelta || !hasStreamingArticle) {
        scheduleCloudRunRender(conversationId);
      }
      refreshCloudRunStatusTimer();
      return;
    }

    if (type === "conversation.message_appended") {
      const { conversationId, message } = payload || {};
      if (!conversationId || !message) return;
      const cachedMessage = messageWithFallbackRunTrace(conversationId, message);
      if (!moduleState.messageCache.has(conversationId)) {
        moduleState.messageCache.set(conversationId, { messages: [], maxSeq: 0 });
      }
      const entry = moduleState.messageCache.get(conversationId);
      if (_reconcileEchoedConversationMessage(conversationId, cachedMessage)) return;
      if (_reconcileCloudBridgeBotMirror(conversationId, cachedMessage)) return;
      // De-dup by id
      const fresh = !entry.messages.find((m) => m.id === cachedMessage.id);
      if (fresh) {
        entry.messages.push(cachedMessage);
        entry.messages.sort((a, b) => a.seq - b.seq);
      }
      if (cachedMessage.seq > entry.maxSeq) entry.maxSeq = cachedMessage.seq;
      const { SenderKind } = conversationKinds();
      const isBotMessage = cachedMessage.sender_kind === SenderKind.Bot;
      const hadStreamingRun = isBotMessage && moduleState.cloudAgentRunsByConversation.has(conversationId);
      if (isBotMessage) {
        clearRunPermissions(moduleState.cloudAgentRunsByConversation.get(conversationId));
        moduleState.cloudAgentRunsByConversation.delete(conversationId);
        refreshCloudRunStatusTimer();
        renderAgentPermissionBanner();
        if (conversationId === moduleState.activeConversationId && deps && typeof deps.paintHeaderStatus === "function") {
          deps.paintHeaderStatus();
        }
        // First bot reply in an untitled conversation → auto-title it.
        if (deps && typeof deps.maybeGenerateConversationTitle === "function") {
          Promise.resolve(deps.maybeGenerateConversationTitle(conversationId)).catch(() => {});
        }
      }

      // Unread bookkeeping: count messages that aren't mine and didn't land
      // in the currently open conversation.
      const isMine = _isMessageFromSelf(message);
      maybeNotifyDesktopMessage(conversationId, cachedMessage, { fresh, isMine });
      if (fresh && !isMine && conversationId !== moduleState.activeConversationId) {
        // Skip the bump if another device already marked this seq read
        // (covers WS replay on reconnect: server replays old message_appended
        // rows from since_seq forward, and we'd otherwise re-light the
        // badge for conversations the user already read on web).
        const readMark = Number(moduleState.cloudSettings?.readMarks?.[conversationId]) || 0;
        const msgSeq = Number(cachedMessage.seq) || 0;
        if (msgSeq > readMark) {
          moduleState.unreadByConversation.set(conversationId, (moduleState.unreadByConversation.get(conversationId) || 0) + 1);
        }
      }

      // If this is the active conversation, append to DOM directly for snappy UX. Only
      // stick to the bottom for my own messages; someone else's message must not
      // pull me away from history I've scrolled up to read.
      if (conversationId === moduleState.activeConversationId) {
        if (hadStreamingRun) {
          _reRenderActiveChat();
        } else if (fresh) {
          _appendMessageToActiveChat(cachedMessage, { stick: isMine });
        }
      }
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "social.conversation_invited") {
      const { conversation } = payload || {};
      if (!conversation) return;
      upsertConversation(conversation);
      // H2: Invalidate member cache so next mention parse refetches newly-added bots
      _conversationMembersCache.delete(conversation.id);
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    // PATCH /api/conversations/:id from any device. Merge the patched conversation back in
    // by id; broadcast originator includes ourselves so this also handles
    // multi-tab consistency.
    if (type === "conversation.updated") {
      const { conversation } = payload || {};
      if (!conversation || !conversation.id) return;
      upsertConversation(conversation);
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    // DELETE /api/conversations/:id from any device.
    if (type === "conversation.deleted") {
      const { conversationId } = payload || {};
      if (!conversationId) return;
      moduleState.conversations = moduleState.conversations.filter((r) => r.id !== conversationId);
      moduleState.messageCache.delete(conversationId);
      moduleState.unreadByConversation.delete(conversationId);
      _conversationMembersCache.delete(conversationId);
      if (conversationId === moduleState.activeConversationId) moduleState.activeConversationId = null;
      // Pin state is on cloud (Phase 3); the server side cascades on
      // conversation delete and pushes user_settings.updated, so no client-side
      // cleanup is needed here. Leftover pin entries (orphaned by a
      // conversation delete the server didn't broadcast for some reason) age
      // out at the next settings PUT or are tolerated harmlessly.
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    // DELETE /api/conversations/:id/messages/:msgId from any device — drop the
    // message from the cache and re-render. Mirrors conversation.message_appended.
    if (type === "conversation.message_deleted") {
      const { conversationId, messageId } = payload || {};
      if (!conversationId || !messageId) return;
      const localDeleteKey = `${conversationId}:${messageId}`;
      const locallyDeleting = _localDeletingMessageKeys.has(localDeleteKey);
      const entry = moduleState.messageCache.get(conversationId);
      if (entry) {
        entry.messages = entry.messages.filter((m) => m.id !== messageId);
      }
      if (locallyDeleting) return;
      if (conversationId === moduleState.activeConversationId) {
        rememberRenderedConversationMessages(conversationId, entry?.messages || []);
        _animateRemoveMessageFromActiveChat(messageId).then(() => {
          if (deps && typeof deps.render === "function") deps.render();
        });
        return;
      }
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "conversation.bot_invocation_requested") {
      // Main process owns local bot execution so the same path works in the
      // foreground app and the headless daemon. Renderer only observes events.
      return;
    }
  }

  // ── renderSidebarRows ─────────────────────────────────────────────────────

  function lastSidebarMessage(entry) {
    const messages = Array.isArray(entry?.messages) ? entry.messages : [];
    return messages.length ? messages[messages.length - 1] : null;
  }

  function conversationActivityAt(conversation) {
    return firstText(
      conversation?.last_activity_at,
      conversation?.lastActivityAt,
      conversation?.last_message_created_at,
      conversation?.lastMessageCreatedAt
    );
  }

  function renderSidebarRows() {
    const sidebarConversations = sessionHistoryShared().sidebarConversations(visibleSocialConversations(moduleState.conversations, {
      activeConversationId: moduleState.activeConversationId,
      preferredConversationIdByBotKey: moduleState.lastBotConversationByKey
    }), {
      activeConversationId: moduleState.activeConversationId,
      messageCache: moduleState.messageCache,
      preferredConversationIdByBotId: moduleState.lastBotConversationByKey
    });
    return sidebarConversations.map((conversation) => {
      const cacheEntry = moduleState.messageCache.get(conversation.id);
      const lastMsg = lastSidebarMessage(cacheEntry);
      const lastMessagePreview = lastMsg
        ? String(lastMsg.body_md || "")
        : firstText(conversation.last_message_text, conversation.lastMessageText);

      // Cloud/Core last_activity_at is the stable sidebar authority. Local cache
      // hydration while switching conversations must not move rows; cached
      // message time is only a fallback for legacy rows without activity data.
      const updatedAt = new Date(
        conversationActivityAt(conversation)
        || (lastMsg ? firstText(lastMsg.created_at, lastMsg.createdAt) : "")
        || firstText(conversation.updatedAt, conversation.updated_at)
        || 0
      ).getTime() || 0;
      const pinned = isConversationPinned(conversation.id);
      const pinnedAt = pinned ? (_ensureCloudSettings().updatedAt || conversation.updatedAt || updatedAt || "") : "";
      const tags = conversationTagsFor(conversation.id);

      // Route on conversations.type (schema truth). Two card shapes only:
      // private-conversation (dm / bot) and group-conversation.
      const conversationType = conversation.type
        || (conversation.id?.startsWith("dm:") ? "dm"
          : conversation.id?.startsWith("botc_") ? "bot"
          : conversation.id?.startsWith("g_") || conversation.id?.startsWith("g-") ? "group"
          : null);
      if (conversationType === "group") {
        const cachedMembers = _conversationMembersCache.get(conversation.id);
        if (!_conversationMembersCache.has(conversation.id)) {
          _fetchAndCacheConversationMembers(conversation.id);
        }
        const memberCount = (cachedMembers || []).length;
        return {
          type: "group-conversation",
          key: conversation.id,
          pinned,
          pinnedAt,
          updatedAt,
          conversation: { ...conversation, type: "group", lastMessagePreview, memberCount, tags }
        };
      }

      if (conversationType === "bot" && !_conversationMembersCache.has(conversation.id)) {
        _fetchAndCacheConversationMembers(conversation.id);
      }
      const otherUser = conversationType === "dm" ? otherUserForConversation(conversation) : null;
      return {
        type: "private-conversation",
        key: conversation.id,
        pinned,
        pinnedAt,
        updatedAt,
        conversation: { ...conversation, type: conversationType || "dm", otherUser, lastMessagePreview, tags }
      };
    });
  }

  // ── renderConversationChat ─────────────────────────────────────────────────────────

  function renderConversationChat(containerEl) {
    if (!containerEl) return;
    const conversationId = moduleState.activeConversationId;
    if (!conversationId) return;
    renderAgentPermissionBanner();

    const entry = moduleState.messageCache.get(conversationId) || { messages: [], maxSeq: 0 };
    const messages = Array.isArray(entry.messages) ? entry.messages : [];
    const conversation = moduleState.conversations.find((r) => r.id === conversationId);
    const color = avatarColor(conversationId);
    const conversationType = conversationTypeFor(conversation, conversationId);
    const renderSignature = chatRenderSignatureFor(conversationId);

    // Decide BEFORE rebuilding whether to keep the view pinned to the bottom.
    // Stick when entering a different conversation, when the first non-empty
    // message cache arrives after an empty relaunch paint, or when the user is
    // already near the bottom. Otherwise restore their prior offset so a
    // background re-render never yanks them out of the history they scrolled to.
    const isConversationSwitch = conversationId !== _lastRenderedConversationId;
    const isFirstMessageHydration = !isConversationSwitch
      && _lastRenderedConversationMessageCount === 0
      && messages.length > 0;
    const previousRenderedMessageIds = isConversationSwitch ? [] : _lastRenderedConversationMessageIds;
    const currentMessageIds = messageStableIds(messages);
    const messageIdsUnchanged = messageIdListsEqual(previousRenderedMessageIds, currentMessageIds);
    const prevScrollTop = containerEl.scrollTop;
    const startBottomGap = chatBottomGap(containerEl);
    const wasNearBottom = isChatPinnedToBottom(containerEl);
    const hasPendingFocus = Boolean(pendingFocusFor(conversationId));
    const isStreamingOnlyPaint = !isConversationSwitch
      && !isFirstMessageHydration
      && messageIdsUnchanged
      && moduleState.cloudAgentRunsByConversation.has(conversationId);
    const stickToBottom = !hasPendingFocus && (
      isConversationSwitch
      || isFirstMessageHydration
      || wasNearBottom
    );
    const shouldAnimateTail = !isConversationSwitch
      && !isFirstMessageHydration
      && !hasPendingFocus
      && !isStreamingOnlyPaint
      && wasNearBottom
      && !prefersReducedMotion();
    const shouldAnimateLayoutShift = !isConversationSwitch
      && !isFirstMessageHydration
      && !hasPendingFocus
      && !isStreamingOnlyPaint
      && !prefersReducedMotion();
    const previousMessageLayout = shouldAnimateLayoutShift ? captureMessageLayout(containerEl) : null;
    const tailMessageIds = shouldAnimateTail
      ? tailMessageIdsAddedToEnd(previousRenderedMessageIds, currentMessageIds)
      : [];
    const tailMessageIdSet = new Set(tailMessageIds);
    const shouldAnimateMessage = (msg) => tailMessageIdSet.has(messageStableId(msg));
    rememberRenderedConversationMessages(conversationId, messages);
    const applyScroll = () => {
      if (!_suppressPendingMessageFocus && focusPendingMessage(containerEl)) return;
      if (stickToBottom) {
        if (tailMessageIds.length) {
          animateChatTailToBottom(containerEl, startBottomGap);
        } else {
          scrollChatToBottom(containerEl);
          scheduleChatBottomStick(
            containerEl,
            containerEl.scrollTop,
            (isConversationSwitch || isFirstMessageHydration) ? SCROLL_LAYOUT_SETTLE_FRAMES : 1,
            isConversationSwitch || isFirstMessageHydration
          );
        }
      } else {
        containerEl.scrollTop = prevScrollTop;
      }
    };

    if (!isConversationSwitch && containerEl.dataset?.conversationRenderSignature === renderSignature) {
      initNameBadgeLotties(containerEl);
      startPhaseOrbAnimation(containerEl);
      applyScroll();
      if (conversation && conversationType === "group" && !_conversationMembersCache.has(conversationId)) {
        _fetchAndCacheConversationMembers(conversationId);
      }
      return;
    }
    if (containerEl.dataset) containerEl.dataset.conversationRenderSignature = renderSignature;
    containerEl.innerHTML = "";

    // Header (avatar / name / meta) is painted by app.js render() — this
    // module only owns the message list so the chat header stays in lockstep
    // with the sidebar's group-avatar mosaic for every conversation type.

    if (conversation && conversationType === "group") {
      const members = _conversationMembersCache.get(conversationId) || [];
      for (const msg of messages) {
        const article = _buildGroupMessageArticle(msg, color, members);
        if (article) {
          containerEl.appendChild(article);
          if (shouldAnimateMessage(msg)) animateMessageTailEnter(article);
        }
      }
      const streaming = _buildCloudAgentStreamingArticle(conversationId, color, members, { groupMessage: true });
      if (streaming) containerEl.appendChild(streaming);
      window.miaAvatar?.hydrateAvatarVideos?.(containerEl);
      markRenderedTraceBlocks(containerEl);
      startPhaseOrbAnimation(containerEl);
      initNameBadgeLotties(containerEl);
      applyScroll();
      animateMessageLayoutShift(containerEl, previousMessageLayout);
      if (!_conversationMembersCache.has(conversationId)) {
        _fetchAndCacheConversationMembers(conversationId);
      }
      return;
    }

    // DM and bot conversations share the 1-on-1 message bubble path.
    const members = conversationType === "bot" ? (_conversationMembersCache.get(conversationId) || []) : [];
    if (conversationType === "bot" && !_conversationMembersCache.has(conversationId)) {
      _fetchAndCacheConversationMembers(conversationId);
    }
    for (const msg of messages) {
      const article = _buildMessageArticle(msg, color, members);
      if (article) {
        containerEl.appendChild(article);
        if (shouldAnimateMessage(msg)) animateMessageTailEnter(article);
      }
    }
    const streaming = _buildCloudAgentStreamingArticle(conversationId, color, members);
    if (streaming) containerEl.appendChild(streaming);
    window.miaAvatar?.hydrateAvatarVideos?.(containerEl);
    markRenderedTraceBlocks(containerEl);
    startPhaseOrbAnimation(containerEl);
    initNameBadgeLotties(containerEl);
    applyScroll();
    animateMessageLayoutShift(containerEl, previousMessageLayout);
  }

  function _specForMessage(msg, members = []) {
    const factory = (typeof window !== "undefined" && window.miaCloudConversationSource) || null;
    if (!factory || typeof factory.createCloudConversationSource !== "function") return null;
    const conversation = moduleState.conversations.find((r) => r.id === moduleState.activeConversationId) || { id: moduleState.activeConversationId || "" };
    const source = factory.createCloudConversationSource({ conversation, messages: [msg], members, ctx: adapterCtx() });
    return source.listMessages()[0] || null;
  }

  // Resolve author name / ownership / body for a cached message — used by the
  // bubble context menu (reply chip + copy). Passes group members so bot /
  // friend names resolve correctly in groups, matching the rendered bubble.
  function describeMessageForMenu(msg) {
    if (!msg) return { authorName: "", isOwn: false, bodyMd: "" };
    const members = _conversationMembersCache.get(moduleState.activeConversationId) || [];
    const spec = _specForMessage(msg, members);
    return {
      authorName: spec ? spec.authorName : "",
      isOwn: Boolean(spec && spec.isOwn),
      bodyMd: (spec ? spec.bodyMd : msg.body_md) || msg.body_md || ""
    };
  }

  // DM bubble mirrors bot chat's renderMessageHtml shape EXACTLY so the
  // CSS targeting .message > .message-stack > .bubble paints it as a real
  // bubble. The bubble carries data-message-source="cloud-conversation" + a
  // data-message-id so the chat-level contextmenu dispatcher in app.js
  // routes to openSocialMessageMenu instead of the bot message menu.
  function _buildMessageArticle(msg, accentColor, members = []) {
    const spec = _specForMessage(msg, members);
    const conversation = moduleState.conversations.find((r) => r.id === moduleState.activeConversationId);
    const isUser = Boolean(spec && spec.isOwn);
    const roleClass = isUser ? "user" : "assistant";
    const authorName = spec ? spec.authorName : "";
    const avatar = (spec && spec.avatar) || { image: "", crop: null, color: "" };
    const avatarColor = avatar.color || accentColor || "#5e5ce6";
    const avatarHelpers = window.miaAvatar;
    const avatarLetter = avatar.image ? "" : (avatar.text || ((authorName || "?").trim().slice(0, 2) || "?"));
    const avatarHtml = avatarHelpers?.avatarHtml
      ? avatarHelpers.avatarHtml({
        className: "avatar message-avatar",
        image: avatar.image,
        crop: avatar.crop,
        color: avatarColor,
        text: avatarLetter,
        attrs: `data-sender-kind="${escapeHtml(msg.sender_kind || "")}" data-sender-ref="${escapeHtml(msg.sender_ref || "")}" title="${escapeHtml(authorName || "")}"`
      })
      : `<div class="avatar message-avatar" data-sender-kind="${escapeHtml(msg.sender_kind || "")}" data-sender-ref="${escapeHtml(msg.sender_ref || "")}" style="${escapeHtml(avatarFallbackStyle(avatarHelpers, avatar.image, avatar.crop, avatarColor))}" title="${escapeHtml(authorName || "")}">${escapeHtml(avatarLetter)}</div>`;
    const cache = moduleState.messageCache.get(moduleState.activeConversationId);
    const messageIndex = cache ? cache.messages.findIndex((m) => m.id === msg.id) : -1;
    const bodyMd = (spec ? spec.bodyMd : msg.body_md) || "";
    const skillsHtml = _renderMsgSkills(msg);
    const senderHtml = shouldRenderSenderTitle(conversation) ? senderTitleHtml(spec, avatarColor) : "";
    const attachmentHtml = renderAttachmentChips(spec?.attachments || msg.attachments || []);
    const attachmentBeforeBodyHtml = isUser ? attachmentHtml : "";
    const attachmentAfterBodyHtml = isUser
      ? ""
      : renderStandaloneAttachmentBlock(
          attachmentHtml,
          `data-message-index="${messageIndex}" data-message-source="cloud-conversation" data-message-id="${escapeHtml(msg.id || "")}"`
        );
    const contentBlocks = !isUser ? contentBlocksFromMessage(msg) : [];
    const orderedBlocksHaveProcess = contentBlocksHaveProcess(contentBlocks);
    let renderedFirstTextBlock = false;
    const orderedBlocksHtml = contentBlocks.length
      ? renderOrderedAssistantBlocks({
        blocks: contentBlocks,
        expanded: false,
        scopeKey: `cloud-msg:${msg.id || ""}`,
        renderTextBlock(block) {
          const prefixHtml = renderedFirstTextBlock ? "" : `${attachmentBeforeBodyHtml}${senderHtml}${skillsHtml}`;
          renderedFirstTextBlock = true;
          return `<div class="bubble" data-message-index="${messageIndex}" data-message-source="cloud-conversation" data-message-id="${escapeHtml(msg.id || "")}">${prefixHtml}${_renderMsgBody(block.text || "")}</div>`;
        }
      })
      : "";
    const bodyHtml = _renderMsgBody(bodyMd);
    const trace = !isUser && (!orderedBlocksHtml || !orderedBlocksHaveProcess)
      ? parseTraceJson(msg.trace_json || msg.trace)
      : null;
    const traceHtml = trace
      ? renderTraceFor({
        reasoning: trace.reasoning,
        tools: trace.tools,
        content: bodyMd,
        expanded: false,
        scopeKey: `cloud-msg:${msg.id || ""}`
      })
      : "";
    const bubbleBodyHtml = `${attachmentBeforeBodyHtml}${senderHtml}${skillsHtml}${bodyHtml}`;
    const bubbleHtml = bubbleBodyHtml
      ? `<div class="bubble" data-message-index="${messageIndex}" data-message-source="cloud-conversation" data-message-id="${escapeHtml(msg.id || "")}">${bubbleBodyHtml}</div>`
      : "";
    const orderedBlocksLeadingBubbleHtml = orderedBlocksHtml && !renderedFirstTextBlock && (attachmentBeforeBodyHtml || senderHtml || skillsHtml)
      ? `<div class="bubble" data-message-index="${messageIndex}" data-message-source="cloud-conversation" data-message-id="${escapeHtml(msg.id || "")}">${attachmentBeforeBodyHtml}${senderHtml}${skillsHtml}</div>`
      : "";
    const orderedBlocksWithAttachments = orderedBlocksHtml
      ? `${orderedBlocksLeadingBubbleHtml}${orderedBlocksHtml}${attachmentAfterBodyHtml}`
      : "";
    const runStatusHtml = !isUser && msg._localRunStatus ? renderRunStatusLine(msg) : "";
    const createdAt = msg.created_at || msg.createdAt || "";
    const timeHtml = createdAt
      ? `<time class="message-time" datetime="${escapeHtml(createdAt)}">${escapeHtml(window.miaTimeFormat.formatMessageTime(createdAt))}</time>`
      : "";

    const article = document.createElement("article");
    article.className = `message ${roleClass}`;
    if (typeof article.setAttribute === "function") {
      article.setAttribute("data-message-id", msg.id || "");
    } else {
      article.dataset = { ...(article.dataset || {}), messageId: msg.id || "" };
    }
    // Tag the avatar like the group builder so the same app.js handlers fire:
    // left-click → contact card, right-click → dropdown. Private chat and
    // group chat share one avatar-interaction path (一视同仁).
    article.innerHTML = `
      ${avatarHtml}
      <div class="message-stack">
        ${traceHtml}
        ${orderedBlocksWithAttachments || `${bubbleHtml}${attachmentAfterBodyHtml}`}
        ${_renderMsgTranslation(msg)}
        ${runStatusHtml}
        ${timeHtml}
        ${renderSendStatus(msg)}
      </div>
    `;
    return article;
  }

  function _buildCloudAgentStreamingArticle(conversationId, accentColor, members = [], options = {}) {
    const run = moduleState.cloudAgentRunsByConversation.get(conversationId);
    const runBlocks = displayedContentBlocksPayloadFromRun(run) || [];
    if (!streamingRunHasRenderableOutput(run)) return null;
    let conversation = moduleState.conversations.find((r) => r.id === conversationId) || { id: conversationId };
    const botKey = run.botId || sessionHistoryShared().botId(conversation) || "mia";
    const synthetic = {
      id: `cloud-agent-stream-${run.runId || conversationId}`,
      sender_kind: "bot",
      sender_ref: botKey,
      body_md: runDisplayText(run),
      created_at: run.createdAt || new Date().toISOString()
    };
    const spec = _specForMessage(synthetic, members);
    const authorName = spec ? spec.authorName : botKey;
    const avatar = (spec && spec.avatar) || { image: "", crop: null, color: "" };
    const avatarColor = avatar.color || accentColor || "#5e5ce6";
    const avatarHelpers = window.miaAvatar;
    const avatarLetter = avatar.image ? "" : (avatar.text || ((authorName || "?").trim().slice(0, 2) || "?"));
    const avatarHtml = avatarHelpers?.avatarHtml
      ? avatarHelpers.avatarHtml({
        className: "avatar message-avatar",
        image: avatar.image,
        crop: avatar.crop,
        color: avatarColor,
        text: avatarLetter,
        attrs: `data-sender-kind="bot" data-sender-ref="${escapeHtml(botKey)}" title="${escapeHtml(authorName || "")}"`
      })
      : `<div class="avatar message-avatar" data-sender-kind="bot" data-sender-ref="${escapeHtml(botKey)}" style="${escapeHtml(avatarFallbackStyle(avatarHelpers, avatar.image, avatar.crop, avatarColor))}" title="${escapeHtml(authorName || "")}">${escapeHtml(avatarLetter)}</div>`;
    const displayText = runDisplayText(run);
    const bodyHtml = displayText ? _renderMsgBody(displayText) : "";
    const orderedBlocksHtml = runBlocks.length
      ? renderOrderedAssistantBlocks({
        blocks: runBlocks,
        expanded: true,
        scopeKey: `cloud-run:${run.runId || conversationId}`,
        renderTextBlock(block) {
          return `<div class="bubble">${_renderMsgBody(block.text || "")}</div>`;
        }
      })
      : "";
    const traceHtml = orderedBlocksHtml
      ? ""
      : renderTraceFor({
        reasoning: run.reasoning,
        tools: run.tools,
        content: displayText,
        expanded: true,
        scopeKey: `cloud-run:${run.runId || conversationId}`
      });
    const toolsHtml = !orderedBlocksHtml && !traceHtml && run.tools.length
      ? `<div class="message-attachments">${run.tools.slice(-3).map((tool) => `<span class="message-attachment"><span>TOOL</span><strong>${escapeHtml(tool.name || "工具")}</strong><em>${escapeHtml(tool.status || "")}</em></span>`).join("")}</div>`
      : "";
    const statusHtml = renderRunStatusLine(run);
    const article = document.createElement("article");
    article.className = `message assistant streaming${options.groupMessage ? " group-message" : ""}`;
    if (article.dataset) article.dataset.messageLayoutKey = synthetic.id;
    article.setAttribute?.("data-message-layout-key", synthetic.id);
    article.innerHTML = `
      ${avatarHtml}
      <div class="message-stack">
        ${orderedBlocksHtml || `${traceHtml}${bodyHtml ? `<div class="bubble">${bodyHtml}</div>` : ""}`}
        ${toolsHtml}
        ${statusHtml}
      </div>
    `;
    return article;
  }

  // Translation block for a cloud-conversation bubble. Reuses the exact .message-translation
  // markup/CSS from bot chat (chat/message-menu.js translationHtml) so the
  // in-place translate result looks identical. The translation lives on the
  // cached message object (transient — never pushed to cloud).
  function _renderMsgTranslation(msg) {
    const t = msg && msg.translation;
    if (!t) return "";
    const status = t.status || (t.text ? "done" : "");
    if (status === "loading") {
      return `<div class="message-translation"><div class="message-translation-head"><span>译文</span></div><p class="message-translation-muted">正在翻译...</p></div>`;
    }
    if (status === "error") {
      return `<div class="message-translation"><div class="message-translation-head"><span>译文</span></div><p class="message-translation-error">${escapeHtml(t.error || "翻译失败")}</p></div>`;
    }
    return `<div class="message-translation"><div class="message-translation-head"><span>译文</span></div><div class="message-translation-body">${_renderMsgBody(t.text || "")}</div></div>`;
  }

  function renderSendStatus(msg) {
    const status = msg && msg.status;
    if (status !== "error") return "";
    const errorText = String(msg.error || "发送失败");
    return `<span class="message-send-status is-error" title="${escapeHtml(errorText)}">发送失败</span>`;
  }

  function _reRenderActiveChat(options = {}) {
    const chatEl = document.getElementById("chat");
    if (options.force && chatEl?.dataset) {
      delete chatEl.dataset.conversationRenderSignature;
    }
    if (chatEl && moduleState.activeConversationId) renderConversationChat(chatEl);
    renderAgentPermissionBanner();
  }

  function renderForMessageFocus() {
    if (deps && typeof deps.render === "function") {
      const previousSuppress = _suppressPendingMessageFocus;
      _suppressPendingMessageFocus = true;
      try {
        deps.render();
      } finally {
        _suppressPendingMessageFocus = previousSuppress;
      }
    }
    _reRenderActiveChat({ force: true });
  }

  function _activeChatMessageTarget(messageId) {
    const chatEl = document.getElementById("chat");
    if (!chatEl) return { chatEl: null, target: null };
    const escapedId = cssEscapeValue(messageId);
    const bubble = chatEl.querySelector(`.bubble[data-message-id="${escapedId}"]`);
    const target = bubble?.closest?.(".message")
      || chatEl.querySelector(`.message[data-message-id="${escapedId}"]`)
      || bubble;
    return { chatEl, target };
  }

  // Remove a single message's bubble from the open chat without a full repaint.
  function _removeMessageFromActiveChat(messageId) {
    const { chatEl, target } = _activeChatMessageTarget(messageId);
    if (!chatEl) return;
    if (target && typeof target.remove === "function") target.remove();
    markChatRenderFresh(chatEl);
  }

  function prefersReducedMotion() {
    try {
      return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    } catch {
      return false;
    }
  }

  async function _animateRemoveMessageFromActiveChat(messageId) {
    const { chatEl, target } = _activeChatMessageTarget(messageId);
    if (!chatEl || !target || typeof target.remove !== "function") {
      _removeMessageFromActiveChat(messageId);
      return false;
    }
    if (prefersReducedMotion() || hasElementClass(target, "message-removing")) {
      target.remove();
      markChatRenderFresh(chatEl);
      return false;
    }
    const previousMessageLayout = captureMessageLayout(chatEl);
    const wasNearBottom = isChatPinnedToBottom(chatEl);
    const ghost = appendMessageRemoveGhost(target);
    target.remove();
    markChatRenderFresh(chatEl);
    if (wasNearBottom) {
      scrollChatToBottom(chatEl);
      scheduleChatBottomStick(chatEl, chatEl.scrollTop, 1, false);
    }
    animateMessageLayoutShift(chatEl, previousMessageLayout);
    scheduleMessageRemoveGhostCleanup(ghost);
    return true;
  }

  // Translate a cloud-conversation message in place. Mirrors message-menu.translateMessage
  // but stores the result on the cached message and re-renders the conversation.
  async function translateConversationMessage(conversationId, messageId, selectionText = "") {
    const entry = moduleState.messageCache.get(conversationId);
    const msg = entry && entry.messages.find((m) => m.id === messageId);
    if (!msg) return;
    const selected = String(selectionText || "").trim();
    const text = selected || String(msg.body_md || msg.bodyMd || "").trim();
    if (!text) return;
    // sendChat needs a bot to run the utility model on: prefer a bot
    // member of this conversation, else fall back to the first available persona.
    const bots = Array.isArray(moduleState.bots) ? moduleState.bots : [];
    const { MemberKind } = conversationKinds();
    const conversationBot = (_conversationMembersCache.get(conversationId) || []).find((m) => m.member_kind === MemberKind.Bot);
    const botKey = (conversationBot && conversationBot.member_ref) || (bots[0] && (bots[0].key || bots[0].id)) || "";
    if (!botKey) {
      msg.translation = { status: "error", text: "", error: "没有可用于翻译的 bot。", sourceText: selected };
      if (conversationId === moduleState.activeConversationId) _reRenderActiveChat();
      return;
    }
    msg.translation = { status: "loading", text: "", error: "", sourceText: selected };
    if (conversationId === moduleState.activeConversationId) _reRenderActiveChat();
    try {
      const prompt = [
        "请把下面这条聊天消息翻译成简体中文。",
        "要求：只输出译文；保持原意、语气和代码/命令/链接；不要添加解释。",
        "",
        text
      ].join("\n");
      const response = await window.mia.sendChatStateless({
        botKey,
        systemPrompt: "",
        userPrompt: prompt
      });
      const translated = String(response?.content || "").trim();
      msg.translation = translated
        ? { status: "done", text: translated, error: "", sourceText: selected }
        : { status: "error", text: "", error: "模型没有返回译文。", sourceText: selected };
    } catch (error) {
      msg.translation = { status: "error", text: "", error: `翻译失败: ${error?.message || error}`, sourceText: selected };
    }
    if (conversationId === moduleState.activeConversationId) _reRenderActiveChat();
  }

  // Delete a cloud-conversation message: optimistically drop it locally, then DELETE on
  // the server. The conversation.message_deleted broadcast keeps other devices in sync;
  // for this device we apply immediately so the bubble vanishes with no lag.
  async function deleteConversationMessage(conversationId, messageId) {
    const entry = moduleState.messageCache.get(conversationId);
    // Capture the message so we can roll the optimistic removal back if the
    // server rejects — otherwise the bubble vanishes locally while the message
    // still exists on the server (divergence until the next bootstrap).
    const removed = entry ? entry.messages.find((m) => m.id === messageId) : null;
    const localDeleteKey = `${conversationId}:${messageId}`;
    _localDeletingMessageKeys.add(localDeleteKey);
    const request = (async () => {
      try {
        return await window.mia.social.deleteConversationMessage(conversationId, messageId);
      } catch (err) {
        return { ok: false, error: err };
      }
    })();
    let activeChatDomRemoved = false;
    if (conversationId === moduleState.activeConversationId) {
      activeChatDomRemoved = await _animateRemoveMessageFromActiveChat(messageId);
    }
    if (entry) entry.messages = entry.messages.filter((m) => m.id !== messageId);
    if (activeChatDomRemoved && conversationId === moduleState.activeConversationId) {
      rememberRenderedConversationMessages(conversationId, entry?.messages || []);
      markChatRenderFresh(document.getElementById("chat"), conversationId);
    }
    if (deps && typeof deps.render === "function") deps.render();
    let ok = false;
    const res = await request;
    _localDeletingMessageKeys.delete(localDeleteKey);
    ok = Boolean(res && res.ok !== false);
    if (!ok) console.warn("[social] deleteConversationMessage failed:", res?.error?.message || res?.error || "unknown");
    if (!ok && removed && entry && !entry.messages.find((m) => m.id === messageId)) {
      // Restore the message and re-render so the user doesn't silently lose it.
      entry.messages.push(removed);
      entry.messages.sort((a, b) => a.seq - b.seq);
      if (conversationId === moduleState.activeConversationId) _reRenderActiveChat();
      if (deps && typeof deps.render === "function") deps.render();
    }
  }

  function _renderMsgBody(md) {
    if (typeof window !== "undefined" && window.miaMarkdown && typeof window.miaMarkdown.renderMarkdown === "function") {
      try { return window.miaMarkdown.renderMarkdown(md); } catch { /* fall through */ }
    }
    return escapeHtml(md);
  }

  // Skill chips the user attached to this message (composer 「使用」). Stored on
  // the message (skills_json) so they persist and render in the bubble.
  function _renderMsgSkills(msg) {
    const raw = msg && msg.skills_json;
    if (!raw) return "";
    let skills;
    try { skills = JSON.parse(raw); } catch { return ""; }
    if (!Array.isArray(skills) || !skills.length) return "";
    const chips = skills
      .map((skill) => String((skill && (skill.name || skill.id)) || "").trim())
      .filter(Boolean)
      .map((label) => `<span class="message-skill-chip">${escapeHtml(label)}</span>`)
      .join("");
    return chips ? `<div class="message-skills">${chips}</div>` : "";
  }

  // stick=true (default, and for your own outgoing messages) always jumps to the
  // bottom. For messages arriving from others, pass stick=false so a reader who
  // has scrolled up to read history isn't yanked down — they only follow along
  // when already near the bottom.
  function _appendMessageToActiveChat(msg, { stick = true } = {}) {
    const chatEl = document.getElementById("chat");
    if (!chatEl) return;
    const startBottomGap = chatBottomGap(chatEl);
    const nearBottom = isChatPinnedToBottom(chatEl);
    const previousMessageLayout = prefersReducedMotion() ? null : captureMessageLayout(chatEl);
    const conversation = moduleState.conversations.find((r) => r.id === moduleState.activeConversationId);
    const color = conversation ? avatarColor(conversation.id) : "#5e5ce6";
    const conversationType = conversationTypeFor(conversation, moduleState.activeConversationId);
    const members = _conversationMembersCache.get(moduleState.activeConversationId) || [];
    const shouldFollow = stick || nearBottom;
    const shouldAnimateTail = nearBottom && !prefersReducedMotion();
    const article = conversationType === "group"
      ? _buildGroupMessageArticle(msg, color, _conversationMembersCache.get(moduleState.activeConversationId) || [])
      : _buildMessageArticle(msg, color, conversationType === "bot" ? members : []);
    if (article) {
      chatEl.appendChild(article);
      if (shouldAnimateTail) animateMessageTailEnter(article);
      window.miaAvatar?.hydrateAvatarVideos?.(article);
      initNameBadgeLotties(article);
      markChatRenderFresh(chatEl);
      if (shouldFollow) {
        if (shouldAnimateTail) {
          animateChatTailToBottom(chatEl, startBottomGap);
        } else {
          scrollChatToBottom(chatEl);
          scheduleChatBottomStick(chatEl, chatEl.scrollTop, 1, false);
        }
      }
      animateMessageLayoutShift(chatEl, previousMessageLayout);
      const entry = moduleState.messageCache.get(moduleState.activeConversationId);
      rememberRenderedConversationMessages(moduleState.activeConversationId, entry?.messages || []);
    }
  }

  function _appendLocalOutgoingConversationMessage(conversationId, prepared, skills = null) {
    const attachments = Array.isArray(prepared?.attachments) ? prepared.attachments : [];
    if (!conversationId || !prepared || (!prepared.bodyMd && !attachments.length)) return null;
    if (!moduleState.messageCache.has(conversationId)) {
      moduleState.messageCache.set(conversationId, { messages: [], maxSeq: 0 });
    }
    const entry = moduleState.messageCache.get(conversationId);
    const msg = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      seq: nextLocalTimelineSeq(entry),
      sender_kind: conversationKinds().SenderKind.User,
      sender_ref: currentSelfUserId(),
      body_md: prepared.bodyMd,
      attachments,
      mentions: prepared.mentions || [],
      // Mirror the server's skills_json so the bubble renders chips immediately,
      // before the echoed message comes back.
      skills_json: skills && skills.length ? JSON.stringify(skills) : null,
      turn_id: prepared.clientTraceId || null,
      status: "sending",
      created_at: new Date().toISOString(),
      _localPending: true
    };
    entry.messages.push(msg);
    sortMessagesByTimelineSeq(entry.messages);
    if (conversationId === moduleState.activeConversationId) _appendMessageToActiveChat(msg);
    if (deps && typeof deps.render === "function") deps.render();
    return msg;
  }

  function _markLocalOutgoingConversationMessageFailed(conversationId, localId, error) {
    const entry = moduleState.messageCache.get(conversationId);
    if (!entry || !localId) return false;
    const msg = entry.messages.find((m) => m.id === localId);
    if (!msg) return false;
    msg.status = "error";
    msg.error = String(error || "发送失败");
    msg._localPending = false;
    if (conversationId === moduleState.activeConversationId) _reRenderActiveChat();
    if (deps && typeof deps.render === "function") deps.render();
    return true;
  }

  function _moveLocalOutgoingConversationMessage(fromConversationId, toConversationId, localId) {
    const fromId = String(fromConversationId || "").trim();
    const toId = String(toConversationId || "").trim();
    if (!fromId || !toId || fromId === toId || !localId) return null;
    const fromEntry = moduleState.messageCache.get(fromId);
    if (!fromEntry || !Array.isArray(fromEntry.messages)) return null;
    const localIdx = fromEntry.messages.findIndex((message) => message && message.id === localId);
    if (localIdx < 0) return null;
    const [message] = fromEntry.messages.splice(localIdx, 1);
    ensureConversationMessageCache(toId);
    const toEntry = moduleState.messageCache.get(toId);
    message.seq = nextLocalTimelineSeq(toEntry);
    toEntry.messages.push(message);
    sortMessagesByTimelineSeq(fromEntry.messages);
    sortMessagesByTimelineSeq(toEntry.messages);
    if (moduleState.activeConversationId === fromId) {
      moduleState.activeConversationId = toId;
      rememberBotConversation(toId);
    }
    if (deps && typeof deps.render === "function") deps.render();
    return message;
  }

  function _messageAttachmentsFingerprint(message) {
    const raw = Array.isArray(message?.attachments)
      ? message.attachments
      : (() => {
        try { return JSON.parse(message?.attachments_json || "[]"); } catch { return []; }
      })();
    if (!Array.isArray(raw) || !raw.length) return "[]";
    return JSON.stringify(raw.map((item) => ({
      id: item?.id || "",
      url: item?.url || "",
      name: item?.name || "",
      path: item?.path || "",
      size: item?.size || 0
    })));
  }

  function _messageVisualFingerprint(message) {
    return jsonSignature({
      body: message?.body_md || message?.bodyMd || "",
      attachments: _messageAttachmentsFingerprint(message),
      skills: message?.skills_json || "",
      failed: message?.status === "error" || message?.failed ? String(message?.error || "发送失败") : ""
    });
  }

  function _messageLooksFromSelf(message) {
    const senderRef = String(message?.sender_ref || "").trim();
    return Boolean(senderRef && moduleState.myUserId && senderRef === moduleState.myUserId) || _isMessageFromSelf(message);
  }

  function _isCloudBridgeBotMirror(message) {
    const { SenderKind } = conversationKinds();
    if (!message || message.sender_kind !== SenderKind.Bot) return false;
    return Boolean(
      message._cloudBridgeRunId
      || message._localCoreConversationId
      || String(message.local_conversation_id || "").startsWith("cloud_bridge_")
    );
  }

  function _mergeCloudBridgeMirrorFields(localMsg, sentMsg) {
    const merged = { ...sentMsg };
    if (!merged.trace && !merged.trace_json && localMsg?.trace) merged.trace = localMsg.trace;
    if (!merged.trace_json && localMsg?.trace_json) merged.trace_json = localMsg.trace_json;
    if (!merged.contentBlocks && !merged.content_blocks_json && localMsg?.contentBlocks) {
      merged.contentBlocks = localMsg.contentBlocks;
    }
    if (!merged.content_blocks_json && localMsg?.content_blocks_json) {
      merged.content_blocks_json = localMsg.content_blocks_json;
    }
    return merged;
  }

  function _reconcileCloudBridgeBotMirror(conversationId, sentMsg) {
    if (!conversationId || !sentMsg || !sentMsg.id) return false;
    const { SenderKind } = conversationKinds();
    if (sentMsg.sender_kind !== SenderKind.Bot || _isCloudBridgeBotMirror(sentMsg)) return false;
    const entry = moduleState.messageCache.get(conversationId);
    if (!entry) return false;
    const fingerprint = _messageVisualFingerprint(sentMsg);
    const localIdx = entry.messages.findIndex((message) => (
      message
      && message.id !== sentMsg.id
      && _isCloudBridgeBotMirror(message)
      && String(message.sender_ref || "") === String(sentMsg.sender_ref || "")
      && _messageVisualFingerprint(message) === fingerprint
    ));
    if (localIdx < 0) return false;
    const localMsg = entry.messages[localIdx];
    const previousId = localMsg?.id || sentMsg.id;
    const serverIdx = entry.messages.findIndex((message) => message && message.id === sentMsg.id);
    const mergedMsg = _mergeCloudBridgeMirrorFields(localMsg, sentMsg);
    if (serverIdx >= 0) {
      entry.messages[serverIdx] = _mergeCloudBridgeMirrorFields(localMsg, entry.messages[serverIdx]);
      entry.messages.splice(localIdx, 1);
    } else {
      entry.messages[localIdx] = mergedMsg;
    }
    sortMessagesByTimelineSeq(entry.messages);
    if (sentMsg.seq > entry.maxSeq) entry.maxSeq = sentMsg.seq;
    if (conversationId === moduleState.activeConversationId) {
      const didSilentReconcile = syncActiveChatAfterSilentMessageReconcile(conversationId, previousId, mergedMsg, entry);
      if (!didSilentReconcile) _reRenderActiveChat();
    }
    if (deps && typeof deps.render === "function") deps.render();
    return true;
  }

  function _resequencePendingMessagesAfterServerSeq(entry, serverSeq) {
    if (!entry || !Array.isArray(entry.messages)) return;
    let cursor = Math.max(safeMessageSeq(serverSeq), safeMessageSeq(entry.maxSeq));
    if (cursor <= 0) return;
    const pending = entry.messages
      .filter((message) => message?._localPending && safeMessageSeq(message.seq) <= cursor)
      .sort((a, b) => safeMessageSeq(a.seq) - safeMessageSeq(b.seq));
    for (const message of pending) {
      cursor += LOCAL_TIMELINE_SEQ_STEP;
      message.seq = cursor;
    }
  }

  function _localPendingEchoIndexWithoutTurnId(entry, sentMsg) {
    if (sentMsg.turn_id || sentMsg.sender_kind !== conversationKinds().SenderKind.User) return -1;
    const senderRef = String(sentMsg.sender_ref || sentMsg.senderRef || "").trim();
    if (senderRef && !_messageLooksFromSelf(sentMsg)) return -1;
    const sentBody = String(sentMsg.body_md || "");
    const sentAttachments = _messageAttachmentsFingerprint(sentMsg);
    const matches = [];
    for (let i = 0; i < entry.messages.length; i++) {
      const message = entry.messages[i];
      if (!message?._localPending) continue;
      if (message.sender_kind !== conversationKinds().SenderKind.User) continue;
      if (String(message.body_md || "") !== sentBody) continue;
      if (_messageAttachmentsFingerprint(message) !== sentAttachments) continue;
      matches.push(i);
    }
    return matches.length === 1 ? matches[0] : -1;
  }

  function _localPendingEchoIndexForServerMessage(entry, sentMsg) {
    if (!entry || !Array.isArray(entry.messages)) return -1;
    if (!sentMsg || sentMsg.sender_kind !== conversationKinds().SenderKind.User) return -1;
    const senderRef = String(sentMsg.sender_ref || sentMsg.senderRef || "").trim();
    if (senderRef && !_messageLooksFromSelf(sentMsg)) return -1;
    const turnId = String(sentMsg.turn_id || sentMsg.turnId || "").trim();
    if (turnId) {
      return entry.messages.findIndex((message) => (
        message
        && message._localPending
        && message.sender_kind === conversationKinds().SenderKind.User
        && String(message.turn_id || message.turnId || "").trim() === turnId
      ));
    }
    return _localPendingEchoIndexWithoutTurnId(entry, sentMsg);
  }

  function _serverConfirmedLocalMessage(localMsg, incoming) {
    const merged = mergeFetchedMessage(localMsg, incoming);
    delete merged._localPending;
    delete merged._localBackfillPending;
    if (merged.status === "sending") delete merged.status;
    if (!merged.status) delete merged.error;
    return merged;
  }

  function _serverEchoConfirmedLocalMessage(localMsg, incoming) {
    const merged = _serverConfirmedLocalMessage(localMsg, incoming);
    merged._localBackfillPending = true;
    return merged;
  }

  function setMessageElementDataId(el, messageId) {
    if (!el || !messageId) return;
    try { el.setAttribute?.("data-message-id", messageId); } catch (_) {}
    try {
      if (el.dataset) el.dataset.messageId = messageId;
    } catch (_) {}
  }

  function updateActiveChatMessageDomId(conversationId, previousId, nextId) {
    if (!conversationId || conversationId !== moduleState.activeConversationId) return false;
    const oldId = String(previousId || "");
    const newId = String(nextId || "");
    if (!oldId || !newId) return false;
    const chatEl = document.getElementById("chat");
    if (!chatEl) return false;
    if (oldId === newId) return true;
    const escapedOldId = cssEscapeValue(oldId);
    const bubble = chatEl.querySelector?.(`.bubble[data-message-id="${escapedOldId}"]`) || null;
    const target = bubble?.closest?.(".message")
      || chatEl.querySelector?.(`.message[data-message-id="${escapedOldId}"]`)
      || null;
    if (!target) return false;
    setMessageElementDataId(target, newId);
    if (bubble) setMessageElementDataId(bubble, newId);
    const descendants = typeof target.querySelectorAll === "function"
      ? target.querySelectorAll("[data-message-id]")
      : [];
    Array.prototype.forEach.call(descendants, (el) => {
      const current = el?.dataset?.messageId
        || (typeof el?.getAttribute === "function" ? el.getAttribute("data-message-id") : "");
      if (String(current || "") === oldId) setMessageElementDataId(el, newId);
    });
    return true;
  }

  function syncActiveChatAfterSilentMessageReconcile(conversationId, previousId, sentMsg, entry) {
    if (!conversationId || conversationId !== moduleState.activeConversationId) return false;
    if (!updateActiveChatMessageDomId(conversationId, previousId, sentMsg?.id)) return false;
    rememberRenderedConversationMessages(conversationId, entry?.messages || []);
    markChatRenderFresh(document.getElementById("chat"), conversationId);
    return true;
  }

  function _reconcileEchoedConversationMessage(conversationId, sentMsg) {
    if (!conversationId || !sentMsg || !sentMsg.id) return false;
    if (sentMsg.sender_kind !== conversationKinds().SenderKind.User) return false;
    const senderRef = String(sentMsg.sender_ref || sentMsg.senderRef || "").trim();
    if (senderRef && !_messageLooksFromSelf(sentMsg)) return false;
    sentMsg._localBackfillPending = true;
    const entry = moduleState.messageCache.get(conversationId);
    if (!entry) return false;
    const localIdx = sentMsg.turn_id
      ? entry.messages.findIndex((m) => m && m._localPending && m.turn_id === sentMsg.turn_id)
      : _localPendingEchoIndexWithoutTurnId(entry, sentMsg);
    if (localIdx < 0) return false;
    const localMsg = entry.messages[localIdx];
    const localId = localMsg?.id || "";
    const canSilentReconcile = _messageVisualFingerprint(localMsg) === _messageVisualFingerprint(sentMsg);
    entry.messages[localIdx] = _serverEchoConfirmedLocalMessage(localMsg, sentMsg);
    _resequencePendingMessagesAfterServerSeq(entry, sentMsg.seq);
    sortMessagesByTimelineSeq(entry.messages);
    if (sentMsg.seq > entry.maxSeq) entry.maxSeq = sentMsg.seq;
    const nextIdx = entry.messages.findIndex((m) => m && m.id === sentMsg.id);
    const didSilentReconcile = canSilentReconcile
      && nextIdx === localIdx
      && syncActiveChatAfterSilentMessageReconcile(conversationId, localId, sentMsg, entry);
    if (conversationId === moduleState.activeConversationId && !didSilentReconcile) _reRenderActiveChat();
    if (deps && typeof deps.render === "function") deps.render();
    return true;
  }

  function _reconcileSentConversationMessage(conversationId, localId, sentMsg) {
    if (!conversationId || !sentMsg || !sentMsg.id) return false;
    if (!moduleState.messageCache.has(conversationId)) {
      moduleState.messageCache.set(conversationId, { messages: [], maxSeq: 0 });
    }
    const entry = moduleState.messageCache.get(conversationId);
    const serverIdx = entry.messages.findIndex((m) => m.id === sentMsg.id);
    const localIdx = entry.messages.findIndex((m) => m.id === localId);
    const localMsg = localIdx >= 0 ? entry.messages[localIdx] : null;
    const existingServerMsg = serverIdx >= 0 ? entry.messages[serverIdx] : null;
    // Desktop-local Core accepts a turn before its cloud-visible timeline
    // sequence is known. Its acknowledgement therefore carries seq=0. Keep
    // the optimistic sequence until a later authoritative backfill arrives;
    // otherwise sorting moves the entering bubble to the top of the chat.
    if (localMsg && safeMessageSeq(sentMsg.seq) <= 0) {
      sentMsg.seq = localMsg.seq;
    }
    if (
      localMsg
      && sentMsg.sender_kind === conversationKinds().SenderKind.User
      && !String(sentMsg.sender_ref || sentMsg.senderRef || "").trim()
    ) {
      const knownSelfRef = String(localMsg.sender_ref || currentSelfUserId() || "").trim();
      if (knownSelfRef) sentMsg.sender_ref = knownSelfRef;
    }
    const shouldProtectUntilBackfill = Boolean(
      (
        localMsg
        && localMsg._localPending
        && sentMsg.sender_kind === conversationKinds().SenderKind.User
      )
      || (
        sentMsg.sender_kind === conversationKinds().SenderKind.User
        && _messageLooksFromSelf(sentMsg)
      )
    );
    if (shouldProtectUntilBackfill) sentMsg._localBackfillPending = true;
    const previousId = localMsg?.id || existingServerMsg?.id || sentMsg.id;
    const previousIdx = localIdx >= 0 ? localIdx : serverIdx;
    let canSilentReconcile = Boolean(localMsg || existingServerMsg)
      && _messageVisualFingerprint(localMsg || existingServerMsg) === _messageVisualFingerprint(sentMsg);
    if (serverIdx >= 0) {
      if (shouldProtectUntilBackfill && existingServerMsg) existingServerMsg._localBackfillPending = true;
      if (localIdx >= 0 && localIdx !== serverIdx) entry.messages.splice(localIdx, 1);
    } else if (localIdx >= 0) {
      entry.messages[localIdx] = sentMsg;
    } else {
      entry.messages.push(sentMsg);
      canSilentReconcile = false;
    }
    _resequencePendingMessagesAfterServerSeq(entry, sentMsg.seq);
    sortMessagesByTimelineSeq(entry.messages);
    if (sentMsg.seq > entry.maxSeq) entry.maxSeq = sentMsg.seq;
    const nextIdx = entry.messages.findIndex((m) => m && m.id === sentMsg.id);
    const didSilentReconcile = canSilentReconcile
      && previousIdx >= 0
      && nextIdx === previousIdx
      && syncActiveChatAfterSilentMessageReconcile(conversationId, previousId, sentMsg, entry);
    if (conversationId === moduleState.activeConversationId && !didSilentReconcile) _reRenderActiveChat();
    if (deps && typeof deps.render === "function") deps.render();
    return true;
  }

  function _appendReturnedConversationBotMessage(conversationId, botMessage) {
    if (!conversationId || !botMessage || !botMessage.id) return false;
    if (botMessage.sender_kind !== conversationKinds().SenderKind.Bot) return false;
    if (!moduleState.messageCache.has(conversationId)) {
      moduleState.messageCache.set(conversationId, { messages: [], maxSeq: 0 });
    }
    const entry = moduleState.messageCache.get(conversationId);
    const incoming = { ...botMessage };
    if (!Number.isFinite(Number(incoming.seq)) || Number(incoming.seq) <= 0) {
      incoming.seq = nextLocalTimelineSeq(entry);
    }
    const existingIdx = entry.messages.findIndex((message) => message && message.id === incoming.id);
    if (existingIdx < 0 && _isCloudBridgeBotMirror(incoming)) {
      const fingerprint = _messageVisualFingerprint(incoming);
      const incomingTurnId = String(incoming.turn_id || incoming.turnId || "").trim();
      const matchingCoreIdx = entry.messages.findIndex((message) => {
        if (!message || message.id === incoming.id || message.sender_kind !== conversationKinds().SenderKind.Bot) return false;
        if (_isCloudBridgeBotMirror(message)) return false;
        if (String(message.sender_ref || "") !== String(incoming.sender_ref || "")) return false;
        if (_messageVisualFingerprint(message) !== fingerprint) return false;
        const existingTurnId = String(message.turn_id || message.turnId || "").trim();
        return Boolean(incomingTurnId && existingTurnId && incomingTurnId === existingTurnId);
      });
      if (matchingCoreIdx >= 0) {
        entry.messages[matchingCoreIdx] = _mergeCloudBridgeMirrorFields(incoming, entry.messages[matchingCoreIdx]);
        sortMessagesByTimelineSeq(entry.messages);
        const seq = Number(incoming.seq) || 0;
        if (seq > entry.maxSeq) entry.maxSeq = seq;
        if (conversationId === moduleState.activeConversationId) _reRenderActiveChat();
        if (deps && typeof deps.render === "function") deps.render();
        return true;
      }
    }
    if (existingIdx >= 0) {
      entry.messages[existingIdx] = mergeFetchedMessage(entry.messages[existingIdx], incoming);
    } else {
      entry.messages.push(incoming);
    }
    sortMessagesByTimelineSeq(entry.messages);
    const seq = Number(incoming.seq) || 0;
    if (seq > entry.maxSeq) entry.maxSeq = seq;
    if (conversationId === moduleState.activeConversationId) {
      if (existingIdx >= 0) {
        _reRenderActiveChat();
      } else {
        _appendMessageToActiveChat(incoming, { stick: true });
      }
    }
    if (deps && typeof deps.render === "function") deps.render();
    return true;
  }

  function apiCanBackfillConversationMessages() {
    return Boolean(window.mia?.social && typeof window.mia.social.listConversationMessages === "function");
  }

  function startOutgoingBotRunFallback(conversationId, conversation, localMsg) {
    if (!conversationId || !apiCanBackfillConversationMessages()) return false;
    if (conversationTypeFor(conversation, conversationId) !== "bot") return false;
    const runId = String(localMsg?.turn_id || `pending_${Date.now()}`).trim();
    const run = cloudRunFor(conversationId, runId);
    run.runId = run.runId || runId;
    run.turnId = String(localMsg?.turn_id || run.turnId || "");
    run.triggerMessageId = String(localMsg?.id || run.triggerMessageId || "");
    run.botId = botKeyForConversation(conversation, conversationId) || run.botId || "";
    run.status = "running";
    markCloudRunActivity(run);
    scheduleCloudRunRender(conversationId);
    refreshCloudRunStatusTimer();
    if (deps && typeof deps.paintHeaderStatus === "function") deps.paintHeaderStatus();
    if (deps && typeof deps.render === "function") deps.render();
    return true;
  }

  function rememberOutgoingBotRunTrigger(conversationId, message) {
    const run = moduleState.cloudAgentRunsByConversation.get(conversationId);
    if (!run || !message || message.sender_kind !== conversationKinds().SenderKind.User) return false;
    run.triggerMessageId = String(message.id || run.triggerMessageId || "");
    const seq = Number(message.seq) || 0;
    if (seq > 0) run.triggerMessageSeq = seq;
    const turnId = String(message.turn_id || message.turnId || run.turnId || "").trim();
    if (turnId) run.turnId = turnId;
    markCloudRunActivity(run);
    return true;
  }

  function clearConversationRunAfterBackfill(conversationId) {
    const run = moduleState.cloudAgentRunsByConversation.get(conversationId);
    if (!run) return false;
    clearRunPermissions(run);
    moduleState.cloudAgentRunsByConversation.delete(conversationId);
    refreshCloudRunStatusTimer();
    renderAgentPermissionBanner();
    if (conversationId === moduleState.activeConversationId && deps && typeof deps.paintHeaderStatus === "function") {
      deps.paintHeaderStatus();
    }
    if (conversationId === moduleState.activeConversationId) _reRenderActiveChat();
    if (deps && typeof deps.render === "function") deps.render();
    return true;
  }

  function messageCompletesActiveBotRun(conversationId, message) {
    const run = moduleState.cloudAgentRunsByConversation.get(conversationId);
    if (!run || !message || message.sender_kind !== conversationKinds().SenderKind.Bot) return false;
    const messageSeq = Number(message.seq) || 0;
    const triggerSeq = Number(run.triggerMessageSeq) || 0;
    if (triggerSeq > 0 && messageSeq > triggerSeq) return true;
    const runTurnId = String(run.turnId || "").trim();
    const messageTurnId = String(message.turn_id || message.turnId || "").trim();
    if (runTurnId && messageTurnId && runTurnId === messageTurnId) return true;

    const entry = moduleState.messageCache.get(conversationId);
    if (!entry || !Array.isArray(entry.messages)) return false;
    const triggerMessageId = String(run.triggerMessageId || "").trim();
    const trigger = triggerMessageId
      ? entry.messages.find((item) => String(item?.id || "") === triggerMessageId)
      : entry.messages.find((item) => (
        item
        && item.sender_kind === conversationKinds().SenderKind.User
        && runTurnId
        && String(item.turn_id || item.turnId || "") === runTurnId
      ));
    const fallbackSeq = Number(trigger?.seq) || 0;
    return fallbackSeq > 0 && messageSeq > fallbackSeq;
  }

  function clearConversationRunIfFinalBotReplyPresent(conversationId) {
    const entry = moduleState.messageCache.get(conversationId);
    if (!entry || !Array.isArray(entry.messages)) return false;
    if (!entry.messages.some((message) => messageCompletesActiveBotRun(conversationId, message))) return false;
    return clearConversationRunAfterBackfill(conversationId);
  }

  function hasBotReplyAfterMessage(conversationId, sentMsg) {
    const entry = moduleState.messageCache.get(conversationId);
    if (!entry || !Array.isArray(entry.messages)) return false;
    const triggerSeq = Number(sentMsg?.seq) || 0;
    const { SenderKind } = conversationKinds();
    return entry.messages.some((message) => {
      if (!message || message.sender_kind !== SenderKind.Bot) return false;
      const seq = Number(message.seq) || 0;
      return triggerSeq > 0 ? seq > triggerSeq : String(message.id || "") !== String(sentMsg?.id || "");
    });
  }

  async function waitForBackfillAttempt(attempt) {
    const delayMs = Math.min(1500, 250 * Math.max(0, Number(attempt) || 0));
    if (delayMs <= 0) {
      await Promise.resolve();
      return;
    }
    await new Promise((resolve) => {
      const timer = global.setTimeout;
      if (typeof timer !== "function" || timer.length === 0) {
        resolve();
        return;
      }
      timer(resolve, delayMs);
    });
  }

  async function backfillBotReplyAfterSend(conversationId, sentMsg) {
    if (!conversationId || !sentMsg?.id || !apiCanBackfillConversationMessages()) return false;
    for (let attempt = 0; attempt < BOT_REPLY_BACKFILL_ATTEMPTS; attempt += 1) {
      await waitForBackfillAttempt(attempt);
      await _ensureConversationMessages(conversationId);
      if (hasBotReplyAfterMessage(conversationId, sentMsg)) {
        clearConversationRunAfterBackfill(conversationId);
        return true;
      }
      if (!moduleState.cloudAgentRunsByConversation.has(conversationId)) return false;
    }
    return false;
  }

  // ── group feature stubs — implementations in social-groups.js ───────────
  // social-groups.js is loaded after social.js and attaches itself via
  // window.miaSocialGroups.attach(ctx) where ctx is the shared internal
  // context exported below.

  function _buildGroupMessageArticle(msg, accentColor, members) {
    const build = window.miaSocialGroups?.buildGroupMessageArticle;
    return typeof build === "function" ? build(msg, accentColor, members) : null;
  }

  function _fetchAndCacheConversationMembers(conversationId) {
    return window.miaSocialGroups?.fetchAndCacheConversationMembers(conversationId);
  }

  async function sendInActiveGroupConversation(text) {
    return sendInActiveConversation(text);
  }

  function openCreateGroupDialog() {
    return window.miaSocialGroups?.openCreateGroupDialog();
  }

  // ── openAddFriendDialog ───────────────────────────────────────────────────

  // Lightweight re-fetch of friend-request state (self identity + incoming +
  // outgoing) for the add-friend dialog. We call this on every dialog open
  // so users always see the latest server state even when the WS lost
  // events or bootstrapAfterLogin never ran (e.g., cloud login happened in
  // a previous app lifetime and the renderer never got a "loggedIn" tick).
  async function refreshFriendRequestState() {
    if (!window.mia || !window.mia.social) return false;
    const api = window.mia.social;
    try {
      const [meRes, incomingRes, outgoingRes] = await Promise.all([
        api.myIdentity(),
        api.listFriendRequests("incoming"),
        api.listFriendRequests("outgoing"),
      ]);
      if (meRes.ok && meRes.data) {
        moduleState.myUsername = meRes.data.username || "";
        moduleState.myUserId = meRes.data.id || "";
      }
      if (incomingRes.ok) moduleState.incomingRequests = incomingRes.data?.requests || [];
      if (outgoingRes.ok) moduleState.outgoingRequests = outgoingRes.data?.requests || [];
      if (deps && typeof deps.render === "function") deps.render();
      return true;
    } catch (err) {
      console.warn("[social] refreshFriendRequestState failed:", err);
      return false;
    }
  }

  function openAddFriendDialog() {
    if (!document.body) return;
    if (!_addFriendModal) {
      _addFriendModal = document.createElement("section");
      _addFriendModal.className = "skill-preview-dialog hidden";
      _addFriendModal.setAttribute("role", "dialog");
      _addFriendModal.setAttribute("aria-modal", "true");
      document.body.appendChild(_addFriendModal);
    }

    // Define close() first so the close button rendered by _renderAddFriendModal
    // references this open's own teardown, not a stale handler from a prior open.
    function onEsc(e) {
      if (e.key === "Escape") { close(); }
    }
    function onBackdrop(e) {
      if (e.target === _addFriendModal) close();
    }
    function close() {
      _addFriendModal.classList.add("hidden");
      document.removeEventListener("keydown", onEsc);
      _addFriendModal.removeEventListener("click", onBackdrop);
    }
    // Assign before rendering so _renderAddFriendModal picks up the fresh closure.
    _addFriendModal._closeModal = close;

    // Render once immediately with whatever cached state we have so the
    // dialog feels responsive…
    _renderAddFriendModal(_addFriendModal);
    _addFriendModal.classList.remove("hidden");
    document.addEventListener("keydown", onEsc);
    _addFriendModal.addEventListener("click", onBackdrop);
    // …then re-fetch from the cloud and re-render. This is the safety net
    // for stale moduleState (WS dropped, bootstrap never fired, etc.).
    refreshFriendRequestState().then((ok) => {
      if (ok && !_addFriendModal.classList.contains("hidden")) {
        _renderAddFriendModal(_addFriendModal);
      }
    });
  }

  function _renderAddFriendModal(modal) {
    const closeModal = modal._closeModal || (() => modal.classList.add("hidden"));
    modal.innerHTML = "";

    const card = document.createElement("div");
    card.className = "skill-preview-card group-create-card add-friend-card";

    // Header
    const toolbar = document.createElement("div");
    toolbar.className = "skill-preview-toolbar";
    toolbar.innerHTML = `
      <div class="skill-preview-title"><h2>添加好友</h2></div>
    `;
    const closeBtn = document.createElement("button");
    closeBtn.className = "icon-button";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <path d="M6 6l12 12M18 6L6 18"/>
      </svg>
    `;
    closeBtn.addEventListener("click", closeModal);
    toolbar.appendChild(closeBtn);
    card.appendChild(toolbar);

    const body = document.createElement("div");
    body.className = "group-create-body";

    // My UID row
    const meSection = document.createElement("section");
    meSection.className = "group-create-section";
    const myUserIdDisplay = escapeHtml(moduleState.myUserId || "—");
    meSection.innerHTML = `
      <div class="group-create-section-header">
        <span class="group-create-section-title">我的 UID</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px; padding:6px 0;">
        <span id="socialMyUserIdLabel" style="font-weight:500; font-variant-numeric:tabular-nums;">${myUserIdDisplay}</span>
        <button type="button" class="button-soft" id="socialCopyUserId" style="font-size:12px; padding:3px 8px;">复制</button>
      </div>
    `;
    body.appendChild(meSection);

    // Send request section
    const sendSection = document.createElement("section");
    sendSection.className = "group-create-section";
    sendSection.innerHTML = `
      <div class="group-create-section-header">
        <span class="group-create-section-title">发送好友请求</span>
      </div>
      <div class="add-friend-send-row">
        <input id="socialAddUserIdInput" class="group-create-input" type="text" placeholder="对方的 UID" inputmode="numeric" style="flex:1;">
        <button type="button" class="add-friend-icon-button" id="socialSendRequestBtn" title="发送好友请求" aria-label="发送好友请求">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 17 17 7"></path>
            <path d="M9 7h8v8"></path>
          </svg>
        </button>
      </div>
      <p id="socialSendError" style="color:#ff3b30; font-size:13px; margin-top:4px; min-height:18px;"></p>
    `;
    body.appendChild(sendSection);

    if (moduleState.incomingRequests.length) {
      const incomingSection = document.createElement("section");
      incomingSection.className = "group-create-section";
      incomingSection.innerHTML = `<div class="group-create-section-header"><span class="group-create-section-title">收到的好友请求</span></div>`;
      const incomingList = document.createElement("div");
      incomingList.id = "socialIncomingList";
      _renderRequestList(incomingList, moduleState.incomingRequests, "incoming", modal);
      incomingSection.appendChild(incomingList);
      body.appendChild(incomingSection);
    }

    if (moduleState.outgoingRequests.length) {
      const outgoingSection = document.createElement("section");
      outgoingSection.className = "group-create-section";
      outgoingSection.innerHTML = `<div class="group-create-section-header"><span class="group-create-section-title">我发出的请求</span></div>`;
      const outgoingList = document.createElement("div");
      outgoingList.id = "socialOutgoingList";
      _renderRequestList(outgoingList, moduleState.outgoingRequests, "outgoing", modal);
      outgoingSection.appendChild(outgoingList);
      body.appendChild(outgoingSection);
    }

    card.appendChild(body);
    modal.appendChild(card);

    // Wire copy button
    card.querySelector("#socialCopyUserId")?.addEventListener("click", () => {
      try { navigator.clipboard.writeText(moduleState.myUserId || ""); } catch { /* ignore */ }
      const btn = card.querySelector("#socialCopyUserId");
      if (btn) {
        window.miaSlotText?.flash?.(btn, "已复制", { restingText: "复制", revertAfter: 1200 });
        if (!window.miaSlotText?.flash) {
          btn.textContent = "已复制";
          setTimeout(() => { btn.textContent = "复制"; }, 1200);
        }
      }
    });

    // Wire send button
    const sendBtn = card.querySelector("#socialSendRequestBtn");
    const userIdInput = card.querySelector("#socialAddUserIdInput");
    const errorEl = card.querySelector("#socialSendError");
    sendBtn?.addEventListener("click", async () => {
      const toUserId = (userIdInput?.value || "").trim();
      if (!toUserId) { if (errorEl) errorEl.textContent = "请输入 UID"; return; }
      if (!isValidPublicUid(toUserId)) { if (errorEl) errorEl.textContent = "请输入有效 UID"; return; }
      if (errorEl) errorEl.textContent = "";
      sendBtn.disabled = true;
      try {
        const res = await window.mia.social.sendFriendRequest(toUserId);
        if (!res.ok) {
          if (errorEl) errorEl.textContent = res.error || "发送失败";
          return;
        }
        if (userIdInput) userIdInput.value = "";
        // Refresh outgoing list
        const outRes = await window.mia.social.listFriendRequests("outgoing");
        if (outRes.ok) moduleState.outgoingRequests = outRes.data?.requests || [];
        _renderAddFriendModal(modal);
      } catch (err) {
        if (errorEl) errorEl.textContent = String(err && err.message ? err.message : err);
      } finally {
        sendBtn.disabled = false;
      }
    });
    userIdInput?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      sendBtn?.click();
    });
  }

  function requestOtherUser(req, direction) {
    const fallbackId = direction === "incoming" ? req?.from_user : req?.to_user;
    const otherUser = req?.other || (direction === "incoming" ? req?.from : req?.to) || {};
    const displayName = otherUser.displayName || otherUser.username || otherUser.account || otherUser.id || fallbackId || "用户";
    return { otherUser, fallbackId, displayName };
  }

  function requestAvatarText(displayName) {
    const text = window.miaAvatar?.initials?.(displayName);
    if (text) return text;
    return (Array.from(String(displayName || "?"))[0] || "?").toUpperCase();
  }

  function paintRequestAvatar(avatar, otherUser, fallbackId, displayName) {
    const color = otherUser.avatarColor
      || otherUser.avatar_color
      || window.miaMemberColor?.memberAccentColor?.(otherUser.id || fallbackId || displayName)
      || "#5e5ce6";
    const text = requestAvatarText(displayName);
    if (typeof window.miaAvatar?.applyAvatarMedia === "function") {
      try {
        window.miaAvatar.applyAvatarMedia(
          avatar,
          otherUser.avatarImage || otherUser.avatar_image || "",
          otherUser.avatarCrop || otherUser.avatar_crop || null,
          color,
          text
        );
        return;
      } catch {
        // Keep friend-request rows visible even if optional avatar media fails.
      }
    }
    avatar.style.backgroundColor = color;
    avatar.textContent = text;
  }

  function absorbAcceptedFriendResponse(res) {
    const data = res?.data || {};
    if (data.friend) moduleState.friends = dedup([...moduleState.friends, data.friend]);
    if (data.conversation) upsertConversation(data.conversation);
  }

  function _renderRequestList(container, requests, direction, modal) {
    if (!container) return;
    container.innerHTML = "";
    const list = Array.isArray(requests) ? requests : [];
    if (!list.length) {
      container.innerHTML = `<p class="contact-request-empty">暂无新的好友请求</p>`;
      return;
    }
    for (const req of list) {
      const row = document.createElement("div");
      row.className = `contact-request-row ${direction}`;

      // Cloud REST hydrates the request with `other` (the user on the
      // opposite end). Live WS events use `from` instead — accept either.
      const { otherUser, fallbackId, displayName } = requestOtherUser(req, direction);

      const avatar = document.createElement("span");
      avatar.className = "avatar request-avatar";
      paintRequestAvatar(avatar, otherUser, fallbackId, displayName);
      row.appendChild(avatar);

      const nameSpan = document.createElement("span");
      nameSpan.className = "contact-request-main";
      nameSpan.innerHTML = renderNameWithBadgeHtml({
        identity: { kind: "user", id: otherUser.id || fallbackId || "", displayName, statusBadge: statusBadgeFrom(otherUser) },
        fallbackName: displayName,
        statusBadge: statusBadgeFrom(otherUser)
      });
      row.appendChild(nameSpan);

      if (direction === "incoming") {
        const acceptBtn = document.createElement("button");
        acceptBtn.type = "button";
        acceptBtn.className = "button-primary contact-request-action";
        acceptBtn.textContent = "同意";
        acceptBtn.addEventListener("click", async () => {
          acceptBtn.disabled = true;
          try {
            const res = await window.mia.social.respondFriendRequest(req.id, "accept");
            if (!res.ok) { acceptBtn.disabled = false; return; }
            moduleState.incomingRequests = moduleState.incomingRequests.filter((r) => r.id !== req.id);
            absorbAcceptedFriendResponse(res);
            // Re-render
            if (modal) _renderAddFriendModal(modal);
            if (deps && typeof deps.render === "function") deps.render();
          } catch { acceptBtn.disabled = false; }
        });

        const rejectBtn = document.createElement("button");
        rejectBtn.type = "button";
        rejectBtn.className = "button-soft contact-request-action";
        rejectBtn.textContent = "拒绝";
        rejectBtn.addEventListener("click", async () => {
          rejectBtn.disabled = true;
          try {
            const res = await window.mia.social.respondFriendRequest(req.id, "reject");
            if (!res.ok) { rejectBtn.disabled = false; return; }
            moduleState.incomingRequests = moduleState.incomingRequests.filter((r) => r.id !== req.id);
            if (modal) _renderAddFriendModal(modal);
            if (deps && typeof deps.render === "function") deps.render();
          } catch { rejectBtn.disabled = false; }
        });

        row.appendChild(acceptBtn);
        row.appendChild(rejectBtn);
      } else {
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "button-soft contact-request-action";
        cancelBtn.textContent = "撤回";
        cancelBtn.addEventListener("click", async () => {
          cancelBtn.disabled = true;
          try {
            const res = await window.mia.social.cancelFriendRequest(req.id);
            if (!res.ok) { cancelBtn.disabled = false; return; }
            moduleState.outgoingRequests = moduleState.outgoingRequests.filter((r) => r.id !== req.id);
            if (modal) _renderAddFriendModal(modal);
            if (deps && typeof deps.render === "function") deps.render();
          } catch { cancelBtn.disabled = false; }
        });
        row.appendChild(cancelBtn);
      }

      container.appendChild(row);
    }
    initNameBadgeLotties(container);
  }

  function pendingRequestCount() {
    return moduleState.incomingRequests.length;
  }

  // Paint the incoming friend-request list into an arbitrary container (the
  // contacts right pane). Reuses _renderRequestList with no modal, so accept /
  // reject fall back to the global render() and repaint the pane in place.
  function renderRequestsInto(container) {
    if (!container) return;
    const count = moduleState.incomingRequests.length;
    container.innerHTML = `
      <article class="contact-profile contact-requests">
        <section class="contact-note contact-requests-card">
          <header class="contact-requests-head">
            <strong>收到的好友请求</strong>
            ${count ? `<span class="contact-requests-count">${unreadBadgeText(count)}</span>` : ""}
          </header>
          <div id="socialContactRequestPane" class="contact-request-list"></div>
        </section>
      </article>
    `;
    _renderRequestList(container.querySelector("#socialContactRequestPane"), moduleState.incomingRequests, "incoming", null);
  }

  // ── Cloud-conversation send: DM, bot conversations, and groups share one path. ─────────

  async function sendInActiveConversation(text, options = {}) {
    const hadActiveConversation = Boolean(moduleState.activeConversationId);
    reconcileActiveConversationAgainstAvailableConversations();
    const conversationId = moduleState.activeConversationId;
    if (!conversationId) {
      return hadActiveConversation ? { ok: false, error: "当前会话不可用" } : undefined;
    }
    let conversation = conversationById(conversationId);
    if (!conversation) {
      clearLastActiveConversationId(conversationId);
      setActiveConversationId(null);
      return { ok: false, error: "当前会话不可用" };
    }
    const conversationType = conversationTypeFor(conversation, conversationId);
    const members = _conversationMembersCache.get(conversationId) || [];
    // Composer skill chips selected for this message (the user's 「使用」).
    const skills = Array.isArray(options.skills) && options.skills.length
      ? options.skills.map((s) => ({ id: String(s.id || ""), name: String(s.name || s.id || "") })).filter((s) => s.id)
      : null;
    let prepared;
    try {
      const maybeAttachments = prepareOutgoingAttachmentsForTransfer(options.attachments);
      const attachments = maybeAttachments && typeof maybeAttachments.then === "function"
        ? await maybeAttachments
        : maybeAttachments;
      prepared = sendPipelineShared().prepareOutgoingMessage(
        { text, attachments },
        { members: sendPipelineMembersForConversation(conversationType, members) }
      );
    } catch (err) {
      if (err && err.code === "EMPTY_MESSAGE") return;
      deps?.appendTransientChat?.("assistant", err?.message || "附件读取失败。");
      console.warn("[social] sendInActiveConversation prepare failed:", err?.message || err);
      return { ok: false, error: err?.message || String(err || "send failed") };
    }
    const localMsg = _appendLocalOutgoingConversationMessage(conversationId, prepared, skills);
    const mentions = postMentionsForConversation(conversationType, prepared.mentions);
    let postConversationId = conversationId;
    try {
      if (conversationType === "bot") {
        const ensured = await ensurePostableConversation(conversationId, conversation);
        postConversationId = ensured.conversationId || conversationId;
        conversation = ensured.conversation || conversation;
        if (postConversationId !== conversationId && localMsg) {
          _moveLocalOutgoingConversationMessage(conversationId, postConversationId, localMsg.id);
        }
        startOutgoingBotRunFallback(postConversationId, conversation, localMsg);
      }
      const botPostContext = botPostContextForConversation(conversation, postConversationId);
      const botRuntimeOverrides = botPostContext ? botRuntimeControlPostOverrides(options) : {};
      const res = await window.mia.social.postConversationMessage(postConversationId, {
        bodyMd: prepared.bodyMd,
        turnId: prepared.clientTraceId,
        ...(prepared.attachments.length ? { attachments: prepared.attachments } : {}),
        ...(mentions.length ? { mentions } : {}),
        ...(skills ? { skills } : {}),
        ...(botPostContext || {}),
        ...botRuntimeOverrides
      });
      if (!res.ok) {
        console.warn("[social] postConversationMessage failed:", res.error);
        if (conversationTypeFor(conversation, postConversationId) === "bot") {
          clearConversationRunAfterBackfill(postConversationId);
        }
        if (localMsg) _markLocalOutgoingConversationMessageFailed(postConversationId, localMsg.id, res.error);
        if (res.status === 401 && deps && typeof deps.onCloudAuthExpired === "function") deps.onCloudAuthExpired();
        return;
      }
      const sentMsg = res.data?.message;
      if (!sentMsg || !sentMsg.id) {
        if (conversationTypeFor(conversation, postConversationId) === "bot") {
          clearConversationRunAfterBackfill(postConversationId);
        }
        return; // server didn't return a message somehow — skip optimistic
      }
      _reconcileSentConversationMessage(postConversationId, localMsg?.id, sentMsg);
      if (conversationTypeFor(conversation, postConversationId) === "bot") {
        rememberOutgoingBotRunTrigger(postConversationId, sentMsg);
      }
      _appendReturnedConversationBotMessage(
        postConversationId,
        res.data?.botMessage || res.data?.assistantMessage || res.botMessage || null
      );
      if (conversationTypeFor(conversation, postConversationId) === "bot") {
        Promise.resolve(backfillBotReplyAfterSend(postConversationId, sentMsg)).catch((error) => {
          console.warn("[social] bot reply backfill failed:", error?.message || error);
        });
      }
    } catch (err) {
      if (conversationTypeFor(conversation, postConversationId) === "bot") {
        clearConversationRunAfterBackfill(postConversationId);
      }
      if (localMsg) _markLocalOutgoingConversationMessageFailed(postConversationId, localMsg.id, err?.message || err);
      console.warn("[social] sendInActiveConversation error:", err);
    }
  }

  // ── getters / setters ─────────────────────────────────────────────────────

  function getActiveConversationId() { return moduleState.activeConversationId; }
  function getConversationById(conversationId) { return moduleState.conversations.find((r) => r.id === conversationId) || null; }

  function mergeFetchedMessage(existing, incoming) {
    if (!existing) return incoming;
    const merged = { ...existing, ...incoming };
    const incomingSenderKind = incoming.sender_kind || incoming.senderKind || existing.sender_kind || existing.senderKind;
    if (
      incomingSenderKind === conversationKinds().SenderKind.User
      && String(existing.sender_ref || "").trim()
      && !String(incoming.sender_ref || incoming.senderRef || "").trim()
    ) {
      merged.sender_ref = existing.sender_ref;
    }
    if (existing.translation && incoming.translation == null) merged.translation = existing.translation;
    if (existing.trace_json && incoming.trace_json == null) merged.trace_json = existing.trace_json;
    if (existing.trace && incoming.trace == null) merged.trace = existing.trace;
    if (existing.content_blocks_json && incoming.content_blocks_json == null) merged.content_blocks_json = existing.content_blocks_json;
    if (existing.contentBlocks && incoming.contentBlocks == null) merged.contentBlocks = existing.contentBlocks;
    return merged;
  }

  function mergedBotReplyCompletesActiveRun(conversationId, incoming = []) {
    const run = moduleState.cloudAgentRunsByConversation.get(conversationId);
    const runTurnId = String(run?.turnId || "").trim();
    if (!run || !runTurnId) return false;
    const { SenderKind } = conversationKinds();
    return (Array.isArray(incoming) ? incoming : []).some((message) => (
      message
      && message.sender_kind === SenderKind.Bot
      && String(message.turn_id || message.turnId || "").trim() === runTurnId
    ));
  }

  // Merge a batch of fetched/cached messages into a conversation's cache entry,
  // de-duping by id and keeping seq order. Fetched server rows may be richer than
  // the cold-start preview row, so collisions are merged instead of skipped.
  function _mergeMessagesIntoCache(conversationId, incoming) {
    if (!moduleState.messageCache.has(conversationId)) {
      moduleState.messageCache.set(conversationId, { messages: [], maxSeq: 0 });
    }
    const entry = moduleState.messageCache.get(conversationId);
    if (!Array.isArray(incoming) || incoming.length === 0) return entry;
    const byId = new Map(entry.messages.map((m) => [m.id, m]));
    let changed = false;
    for (const msg of incoming) {
      if (!msg || !msg.id) continue;
      const existing = byId.get(msg.id);
      if (!existing) {
        const localIdx = _localPendingEchoIndexForServerMessage(entry, msg);
        if (localIdx >= 0) {
          const localMsg = entry.messages[localIdx];
          byId.delete(localMsg.id);
          byId.set(msg.id, _serverConfirmedLocalMessage(localMsg, msg));
          changed = true;
          const seq = Number(msg.seq) || 0;
          if (seq > entry.maxSeq) entry.maxSeq = seq;
          continue;
        }
      }
      byId.set(msg.id, existing ? mergeFetchedMessage(existing, msg) : msg);
      changed = true;
      const seq = Number(msg.seq) || 0;
      if (seq > entry.maxSeq) entry.maxSeq = seq;
    }
    if (changed) {
      entry.messages = [...byId.values()].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
    }
    if (mergedBotReplyCompletesActiveRun(conversationId, incoming)) {
      clearRunPermissions(moduleState.cloudAgentRunsByConversation.get(conversationId));
      moduleState.cloudAgentRunsByConversation.delete(conversationId);
      refreshCloudRunStatusTimer();
      renderAgentPermissionBanner();
      if (conversationId === moduleState.activeConversationId && deps && typeof deps.paintHeaderStatus === "function") {
        deps.paintHeaderStatus();
      }
      if (deps && typeof deps.render === "function") deps.render();
    }
    return entry;
  }

  function _reconcileFetchedMessageWindow(conversationId, _sinceSeq, incoming, _limit = 100) {
    const entry = moduleState.messageCache.get(conversationId);
    if (!entry || !Array.isArray(entry.messages)) return false;
    const fresh = Array.isArray(incoming) ? incoming.filter((msg) => msg?.id) : [];
    const visibleIds = new Set(fresh.map((msg) => String(msg.id)));
    let changed = false;
    for (const msg of entry.messages) {
      if (msg?._localBackfillPending && visibleIds.has(String(msg.id || ""))) {
        delete msg._localBackfillPending;
        changed = true;
      }
    }
    return changed;
  }

  function isTransientLocalConversationMessage(msg) {
    if (!msg || typeof msg !== "object") return false;
    const id = String(msg.id || "");
    const status = String(msg.status || "");
    const seq = Number(msg.seq);
    return Boolean(
      msg._localPending
      || msg._localRunId
      || msg._cloudBridgeRunId
      || msg._localCoreConversationId
      || msg._localBackfillPending
      || id.startsWith("local_")
      || status === "sending"
      || (Number.isFinite(seq) && seq >= LOCAL_TIMELINE_SEQ_SENTINEL)
    );
  }

  function cachedMessageById(conversationId, messageId) {
    const entry = moduleState.messageCache.get(conversationId);
    if (!entry || !Array.isArray(entry.messages)) return null;
    const id = String(messageId || "");
    return entry.messages.find((msg) => String(msg?.id || "") === id) || null;
  }

  const _ensuringConversations = new Set();

  // TG-style local-first open: paint the locally-cached recent history instantly
  // (no network), then fetch only messages newer than what we have (delta keyed
  // on seq). The cloud write-through (main-side) keeps the local cache fresh, so
  // from the second launch onward an opened conversation shows its history
  // immediately instead of flashing a single preview message.
  async function _ensureConversationMessages(conversationId) {
    const api = window.mia && window.mia.social;
    if (!conversationId || !api || _ensuringConversations.has(conversationId)) return;
    _ensuringConversations.add(conversationId);
    try {
      // 1. SQLite cache → instant paint. Its max seq is the delta cursor because
      //    it holds a contiguous recent tail. Stale renderer memory is deliberately
      //    ignored for cursoring so it cannot skip the server backfill.
      let cachedMaxSeq = 0;
      if (typeof api.getCachedConversationMessages === "function") {
        try {
          const cachedRes = await api.getCachedConversationMessages(conversationId, 50);
          const cached = cachedRes?.ok ? (cachedRes.data?.messages || []) : [];
          if (cached.length) {
            _mergeMessagesIntoCache(conversationId, cached);
            cachedMaxSeq = cached.reduce((m, x) => Math.max(m, Number(x.seq) || 0), 0);
            clearConversationRunIfFinalBotReplyPresent(conversationId);
            if (conversationId === moduleState.activeConversationId) _reRenderActiveChat();
          }
        } catch (err) {
          console.warn("[social] getCachedConversationMessages failed for", conversationId, err);
        }
      }
      // 2. Fetch from cloud: a full backfill when nothing is persisted yet
      //    (cachedMaxSeq === 0 → since_seq 0), otherwise a small overlap newer
      //    than cachedMaxSeq - MESSAGE_BACKFILL_OVERLAP so cached rows can pick
      //    up newly-added fields like trace_json.
      try {
        const sinceSeq = Math.max(0, cachedMaxSeq - MESSAGE_BACKFILL_OVERLAP);
        const limit = 100;
        const res = await api.listConversationMessages(conversationId, sinceSeq, limit);
        if (res?.ok) {
          const fresh = (res.data?.messages || []).map((m) => messageWithFallbackRunTrace(conversationId, m));
          const reconciled = _reconcileFetchedMessageWindow(conversationId, sinceSeq, fresh, limit);
          if (fresh.length || reconciled) {
            _mergeMessagesIntoCache(conversationId, fresh);
            clearConversationRunIfFinalBotReplyPresent(conversationId);
            if (conversationId === moduleState.activeConversationId) {
              _reRenderActiveChat();
              // Messages that arrived while offline are now on-screen — advance the
              // read mark past them (the initial open marked read at the stale seq).
              markConversationRead(conversationId);
            }
          }
        }
      } catch (err) {
        console.warn("[social] delta listConversationMessages failed for", conversationId, err);
      }
    } finally {
      _ensuringConversations.delete(conversationId);
    }
  }

  async function focusConversationMessage(conversationId, target = {}) {
    const id = String(conversationId || "").trim();
    const message = target?.message && typeof target.message === "object" ? target.message : null;
    const messageId = String(target?.messageId || target?.id || message?.id || "").trim();
    if (!id || !messageId) return { ok: false, error: "missing message target" };
    const focusMessage = message
      ? messageWithFallbackRunTrace(id, { ...message, conversation_id: message.conversation_id || id })
      : null;

    _pendingMessageFocus = {
      conversationId: id,
      messageId,
      startedAt: Date.now(),
      smooth: false
    };

    if (focusMessage) {
      _mergeMessagesIntoCache(id, [focusMessage]);
    }

    const seq = Number(target?.seq ?? message?.seq ?? 0) || 0;
    setActiveConversationId(id);
    renderForMessageFocus();
    schedulePendingMessageFocus();
    const immediateFound = await waitForPendingMessageFocus(seq > 0 ? 3 : 8);
    if (immediateFound && seq <= 0) return { ok: true, found: true };

    const api = window.mia && window.mia.social;
    try {
      if (api && typeof api.listConversationMessages === "function") {
        const sinceSeq = seq > 0 ? Math.max(0, seq - 120) : 0;
        const limit = seq > 0 ? 260 : 500;
        const res = await api.listConversationMessages(id, sinceSeq, limit);
        const messages = (res?.ok ? res.data?.messages : res?.messages) || [];
        if (Array.isArray(messages) && messages.length) {
          _mergeMessagesIntoCache(id, messages.map((m) => messageWithFallbackRunTrace(id, m)));
        }
      }
    } catch (err) {
      console.warn("[social] focusConversationMessage backfill failed:", err?.message || err);
    }

    if (focusMessage && !cachedMessageById(id, messageId)) {
      _mergeMessagesIntoCache(id, [focusMessage]);
    }

    _pendingMessageFocus = {
      conversationId: id,
      messageId,
      startedAt: Date.now(),
      smooth: true
    };
    if (moduleState.activeConversationId === id) {
      renderForMessageFocus();
    }
    schedulePendingMessageFocus(8);
    const found = await waitForPendingMessageFocus(10);
    const cached = Boolean(cachedMessageById(id, messageId));
    if (!found && !cached) console.warn("[social] focusConversationMessage target not found:", messageId);
    return { ok: true, found: found || cached };
  }

  function setActiveConversationId(id) {
    const next = id || null;
    const previous = moduleState.activeConversationId || null;
    // Re-selecting the already-active conversation has no observable effect but
    // would otherwise re-write localStorage, re-POST a read mark, and re-trigger
    // _ensureConversationMessages. Drop those redundant side effects up front.
    if (next === previous) return;
    // Any actual navigation (switching conversations, or leaving to a local bot chat
    // that reuses #chat) invalidates the last-painted marker, so the next
    // renderConversationChat treats re-entry as a switch and lands at the latest message
    // instead of restoring a stale offset.
    _lastRenderedConversationId = null;
    _lastRenderedConversationMessageCount = 0;
    _lastRenderedConversationMessageIds = [];
    moduleState.activeConversationId = next;
    if (typeof deps?.onActiveConversationChanged === "function") {
      try {
        deps.onActiveConversationChanged(previous, next);
      } catch (error) {
        console.warn("[social] active conversation change hook failed:", error?.message || error);
      }
    }
    if (id) {
      writeLastActiveConversationId(id);
      rememberBotConversation(id);
      markConversationRead(id);
      // Fire-and-forget: keep the click snappy; cache paint + delta sync re-render async.
      _ensureConversationMessages(id);
    }
    renderAgentPermissionBanner();
  }

  function rememberBotConversation(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) return;
    if (!isCanonicalBotConversationId(id)) return;
    const conversation = moduleState.conversations.find((row) => row.id === id) || { id };
    if (sessionHistoryShared().conversationType(conversation, id) !== "bot") return;
    const key = botKeyForConversation(conversation, id);
    if (!key) return;
    moduleState.lastBotConversationByKey = {
      ...(moduleState.lastBotConversationByKey || {}),
      [key]: id
    };
    writeLastBotConversationByKey(moduleState.lastBotConversationByKey);
  }
  // Relaunch restore: land on the conversation the user last had open. Skipped if
  // the user already navigated during bootstrap, or if the saved conversation no
  // longer exists (deleted, or belongs to a different signed-in account).
  function restoreLastActiveConversation() {
    if (moduleState.activeConversationId) return;
    const savedId = readLastActiveConversationId();
    if (!savedId) return;
    const availableId = availableConversationIdFor(savedId);
    if (!availableId) {
      clearLastActiveConversationId(savedId);
      return;
    }
    setActiveConversationId(availableId);
  }

  async function markConversationRead(conversationId, _retried = false) {
    if (!conversationId) return;
    moduleState.unreadByConversation.delete(conversationId);
    const cache = moduleState.messageCache.get(conversationId);
    const lastSeq = cache && Number.isFinite(Number(cache.maxSeq)) ? Number(cache.maxSeq) : 0;
    let s = _ensureCloudSettings();
    if (!_retried && !Number.isFinite(Number(s.version))) {
      await bootstrapCloudSettings();
      s = _ensureCloudSettings();
    }
    const existingReadMark = Number(s.readMarks?.[conversationId]) || 0;
    const hasUnreadOverride = Boolean(s.unreadOverrides && s.unreadOverrides[conversationId]);
    if (existingReadMark >= lastSeq && !hasUnreadOverride) return;
    const nextReadMarks = { ...(s.readMarks || {}), [conversationId]: lastSeq };
    // Clear any manual "标为未读" override so the badge actually goes away.
    const nextOverrides = { ...(s.unreadOverrides || {}) };
    delete nextOverrides[conversationId];
    moduleState.cloudSettings = { ...s, readMarks: nextReadMarks, unreadOverrides: nextOverrides };
    try {
      const updated = await window.mia?.social?.settingsPut?.({
        pins: s.pins,
        readMarks: nextReadMarks,
        appearance: s.appearance,
        tags: s.tags,
        starterEngineBots: s.starterEngineBots || {},
        mutedConversations: s.mutedConversations || [],
        unreadOverrides: nextOverrides,
        expectedVersion: s.version || 0
      });
      // Capture the server's new version; without this the local version stays
      // stale (or 0 before the first bootstrap) and every later write 409s.
      const updatedSettings = unwrapCloudSettingsResponse(updated);
      if (updatedSettings && typeof updatedSettings === "object") moduleState.cloudSettings = normalizeCloudSettings(updatedSettings, moduleState.cloudSettings || s);
    } catch (err) {
      // 409: our version is stale (common during startup, when a restored
      // conversation marks read before bootstrapCloudSettings lands). Re-pull the
      // authoritative version and retry once, re-applying the mark on top.
      if (!_retried && /409|version conflict/i.test(String(err?.message || ""))) {
        await bootstrapCloudSettings();
        return markConversationRead(conversationId, true);
      }
      console.warn("[social] mark-read settingsPut failed:", err?.message || err);
    }
  }

  // Phase 3: pin state lives in cloud user_settings (server-canonical).
  // Renderer holds a cached copy in moduleState.cloudSettings; it's
  // populated by bootstrapCloudSettings() at login and refreshed on each
  // user_settings.updated WS event. Mutations PUT via IPC and the
  // broadcast confirms / replaces the optimistic update.
  function conversationTagsShared() {
    if (typeof window !== "undefined" && window.miaConversationTags) return window.miaConversationTags;
    if (typeof require === "function") return require("../../shared/conversation-tags.js");
    return {
      defaultConversationTags: () => ({ items: [], assignments: {} }),
      normalizeConversationTags: (value) => value && typeof value === "object" ? value : { items: [], assignments: {} },
      pruneUnusedTagItems: (value) => value && typeof value === "object" ? value : { items: [], assignments: {} },
      tagsForTarget: () => [],
      assignTagNames: (tags) => tags && typeof tags === "object" ? tags : { items: [], assignments: {} }
    };
  }

  function normalizeCloudSettings(settings, previous = {}) {
    const input = settings && typeof settings === "object" ? settings : {};
    const prior = previous && typeof previous === "object" ? previous : {};
    const tagApi = conversationTagsShared();
    const rawTags = input.tags !== undefined ? input.tags : (prior.tags || tagApi.defaultConversationTags());
    const tags = typeof tagApi.pruneUnusedTagItems === "function"
      ? tagApi.pruneUnusedTagItems(rawTags)
      : tagApi.normalizeConversationTags(rawTags);
    return {
      ...input,
      pins: Array.isArray(input.pins) ? input.pins : [],
      readMarks: input.readMarks && typeof input.readMarks === "object" ? input.readMarks : {},
      appearance: input.appearance && typeof input.appearance === "object" ? input.appearance : {},
      tags,
      starterEngineBots: input.starterEngineBots && typeof input.starterEngineBots === "object" && !Array.isArray(input.starterEngineBots)
        ? input.starterEngineBots
        : (prior.starterEngineBots && typeof prior.starterEngineBots === "object" ? prior.starterEngineBots : {}),
      // Older cloud settings responses only echo pins/readMarks/appearance.
      // Appearance is ignored by consumers; keep the bag only for response compatibility.
      // Preserve these local bags so optimistic menu toggles don't flash away.
      mutedConversations: Array.isArray(input.mutedConversations)
        ? input.mutedConversations
        : (Array.isArray(prior.mutedConversations) ? prior.mutedConversations : []),
      unreadOverrides: input.unreadOverrides && typeof input.unreadOverrides === "object"
        ? input.unreadOverrides
        : (prior.unreadOverrides && typeof prior.unreadOverrides === "object" ? prior.unreadOverrides : {})
    };
  }

  function unwrapCloudSettingsResponse(response) {
    if (response?.settings && typeof response.settings === "object") return response.settings;
    if (response?.data?.settings && typeof response.data.settings === "object") return response.data.settings;
    if (response?.data && typeof response.data === "object" && !Array.isArray(response.data)) return response.data;
    return response;
  }

  function stableCloudJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableCloudJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableCloudJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function cloudSettingsRenderSignature(settings = {}) {
    return stableCloudJson({
      pins: settings.pins || [],
      mutedConversations: settings.mutedConversations || [],
      unreadOverrides: settings.unreadOverrides || {},
      readMarks: settings.readMarks || {},
      tags: settings.tags || conversationTagsShared().defaultConversationTags(),
      starterEngineBots: settings.starterEngineBots || {}
    });
  }

  function _ensureCloudSettings() {
    moduleState.cloudSettings = normalizeCloudSettings(moduleState.cloudSettings || {}, moduleState.cloudSettings || {});
    return moduleState.cloudSettings;
  }
  function isConversationPinned(conversationId) {
    if (!conversationId) return false;
    const s = _ensureCloudSettings();
    return Array.isArray(s.pins) && s.pins.includes(conversationId);
  }
  function isConversationMuted(conversationId) {
    if (!conversationId) return false;
    const s = _ensureCloudSettings();
    return Array.isArray(s.mutedConversations) && s.mutedConversations.includes(conversationId);
  }
  function isConversationManuallyUnread(conversationId) {
    if (!conversationId) return false;
    const s = _ensureCloudSettings();
    return Boolean(s.unreadOverrides && s.unreadOverrides[conversationId]);
  }
  async function setConversationPinned(conversationId, pinned, _retried = false) {
    return _patchCloudSettings({ pinned, conversationId, _retried });
  }
  async function setConversationMuted(conversationId, muted, _retried = false) {
    return _patchCloudSettings({ muted, conversationId, _retried });
  }
  // Manual unread / read override. Telegram-style: forces the badge state
  // until either (a) opening the conversation (markConversationRead) or (b) the user
  // toggles it back from the menu.
  async function setConversationManuallyUnread(conversationId, unread, _retried = false) {
    return _patchCloudSettings({ manualUnread: unread, conversationId, _retried });
  }
  function conversationTagsFor(conversationId) {
    if (!conversationId) return [];
    return conversationTagsShared().tagsForTarget(_ensureCloudSettings().tags, conversationId);
  }
  function allConversationTags() {
    const tags = _ensureCloudSettings().tags;
    const used = new Set(Object.values(tags?.assignments || {}).flatMap((ids) =>
      Array.isArray(ids) ? ids : []));
    return Array.isArray(tags?.items) ? tags.items.filter((item) => used.has(item.id)) : [];
  }
  function conversationTagFilters() {
    const tags = _ensureCloudSettings().tags;
    const active = String(moduleState.tagFilterName || "").trim().toLowerCase();
    const otherDeviceActive = isOtherDeviceConversationFilter(active);
    const visibleIds = new Set(visibleSocialConversations(moduleState.conversations, {
      activeConversationId: moduleState.activeConversationId,
      preferredConversationIdByBotKey: moduleState.lastBotConversationByKey,
      ignoreTagFilter: true
    }).map((conversation) => String(conversation?.id || "")).filter(Boolean));
    const otherDeviceCount = sessionHistoryShared().sidebarConversations(visibleSocialConversations(moduleState.conversations, {
      activeConversationId: moduleState.activeConversationId,
      preferredConversationIdByBotKey: moduleState.lastBotConversationByKey,
      ignoreTagFilter: true,
      includeOtherDevice: true
    }), {
      activeConversationId: moduleState.activeConversationId,
      messageCache: moduleState.messageCache,
      preferredConversationIdByBotId: moduleState.lastBotConversationByKey
    }).filter(conversationRunsOnOtherDevice).length;
    const counts = new Map();
    for (const [conversationId, ids] of Object.entries(tags?.assignments || {})) {
      if (!visibleIds.has(String(conversationId || ""))) continue;
      for (const tagId of new Set(Array.isArray(ids) ? ids : [])) {
        counts.set(tagId, (counts.get(tagId) || 0) + 1);
      }
    }
    const tagFilters = (Array.isArray(tags?.items) ? tags.items : [])
      .map((item) => {
        const name = String(item?.name || "").trim();
        const count = counts.get(item?.id) || 0;
        if (!name || count <= 0) return null;
        return {
          id: item.id,
          name,
          color: item.color,
          count,
          filterActive: Boolean(active && name.toLowerCase() === active)
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.name.localeCompare(b.name, "zh-Hans-CN");
      });
    if (otherDeviceCount > 0) {
      tagFilters.push({
        id: OTHER_DEVICE_CONVERSATION_FILTER,
        name: OTHER_DEVICE_CONVERSATION_LABEL,
        color: "#64748b",
        count: otherDeviceCount,
        filterValue: OTHER_DEVICE_CONVERSATION_FILTER,
        storageKey: "other-devices",
        special: true,
        filterActive: otherDeviceActive
      });
    }
    return tagFilters;
  }
  function getConversationTagFilter() {
    return String(moduleState.tagFilterName || "").trim();
  }
  function focusConversationTagInput(conversationId, target = "add") {
    if (typeof document === "undefined") return;
    setTimeout(() => {
      const id = String(conversationId || "");
      const cards = document.querySelectorAll?.("[data-conversation-id]") || [];
      for (const card of cards) {
        if (card?.dataset?.conversationId !== id) continue;
        card.querySelector?.("[data-tag-input]")?.focus?.();
        break;
      }
    }, 0);
  }
  function unwireTagEditOutsideClose() {
    _tagEditOutsideGeneration += 1;
    if (_tagEditOutsideHandler && typeof document !== "undefined") {
      document.removeEventListener("pointerdown", _tagEditOutsideHandler, true);
    }
    _tagEditOutsideHandler = null;
  }
  function wireTagEditOutsideClose(conversationId) {
    unwireTagEditOutsideClose();
    if (typeof document === "undefined") return;
    const generation = _tagEditOutsideGeneration;
    setTimeout(() => {
      if (generation !== _tagEditOutsideGeneration) return;
      if (String(moduleState.tagEditingConversationId || "") !== String(conversationId || "")) return;
      _tagEditOutsideHandler = (event) => {
        const activeId = String(moduleState.tagEditingConversationId || "");
        if (!activeId || activeId !== String(conversationId || "")) return;
        const card = event.target?.closest?.("[data-conversation-id]");
        if (card?.dataset?.conversationId === activeId) return;
        endConversationTagEdit(activeId);
      };
      document.addEventListener("pointerdown", _tagEditOutsideHandler, true);
    }, 0);
  }
  function beginConversationTagEdit(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) return false;
    moduleState.tagEditingConversationId = id;
    moduleState.tagEditingAdding = true;
    moduleState.tagEditingMode = "add";
    moduleState.tagEditingTargetName = "";
    moduleState.tagEditingDraft = "";
    if (deps && typeof deps.render === "function") deps.render();
    wireTagEditOutsideClose(id);
    focusConversationTagInput(id, "input");
    return true;
  }
  function startConversationTagAdd(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) return false;
    moduleState.tagEditingConversationId = id;
    moduleState.tagEditingAdding = true;
    moduleState.tagEditingMode = "add";
    moduleState.tagEditingTargetName = "";
    moduleState.tagEditingDraft = "";
    if (deps && typeof deps.render === "function") deps.render();
    wireTagEditOutsideClose(id);
    focusConversationTagInput(id, "input");
    return true;
  }
  function startConversationTagRename(conversationId, name) {
    const id = String(conversationId || "").trim();
    const clean = String(name || "").trim();
    if (!id || !clean) return false;
    moduleState.tagEditingConversationId = id;
    moduleState.tagEditingAdding = false;
    moduleState.tagEditingMode = "rename";
    moduleState.tagEditingTargetName = clean;
    moduleState.tagEditingDraft = clean;
    if (deps && typeof deps.render === "function") deps.render();
    wireTagEditOutsideClose(id);
    focusConversationTagInput(id, "input");
    return true;
  }
  function setConversationTagDraft(conversationId, value) {
    const id = String(conversationId || "").trim();
    if (!id || moduleState.tagEditingConversationId !== id) return false;
    moduleState.tagEditingDraft = String(value || "");
    return true;
  }
  function endConversationTagEdit(conversationId = "") {
    const id = String(conversationId || "").trim();
    if (id && moduleState.tagEditingConversationId !== id) return false;
    moduleState.tagEditingConversationId = "";
    moduleState.tagEditingAdding = false;
    moduleState.tagEditingMode = "";
    moduleState.tagEditingTargetName = "";
    moduleState.tagEditingDraft = "";
    unwireTagEditOutsideClose();
    if (deps && typeof deps.render === "function") deps.render();
    return true;
  }
  function conversationTagEditorFor(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) return null;
    const active = moduleState.tagEditingConversationId === id;
    return {
      active,
      maxTags: 3,
      tags: conversationTagsFor(id),
      allTags: allConversationTags(),
      adding: active && moduleState.tagEditingAdding,
      mode: active ? moduleState.tagEditingMode : "",
      targetName: active ? moduleState.tagEditingTargetName : "",
      draft: active ? moduleState.tagEditingDraft : "",
      filterName: moduleState.tagFilterName || "",
      removingName: moduleState.tagRemovingConversationId === id ? moduleState.tagRemovingName : "",
      onStartAdd: () => startConversationTagAdd(id),
      onDraft: (value) => setConversationTagDraft(id, value),
      onCommit: (name, details = null) => commitConversationTagInput(id, name, details),
      onAdd: (name) => addConversationTagName(id, name),
      onRemove: (name) => removeConversationTagName(id, name),
      onOpenMenu: (name, x, y) => openConversationTagMenu(id, name, x, y),
      onCancel: () => endConversationTagEdit(id)
    };
  }
  async function commitConversationTagInput(conversationId, name, details = null) {
    const id = String(conversationId || "").trim();
    const clean = String(name || "").trim();
    if (!id || !clean) return endConversationTagEdit(id);
    const explicitMode = String(details?.mode || "").trim();
    const explicitTarget = String(details?.targetName || "").trim();
    const isRename = explicitMode === "rename"
      || (moduleState.tagEditingConversationId === id && moduleState.tagEditingMode === "rename");
    if (isRename) {
      const target = explicitTarget || String(moduleState.tagEditingTargetName || "").trim();
      return renameConversationTagName(id, target, clean);
    }
    return addConversationTagName(id, clean);
  }
  async function setConversationTagNames(conversationId, names, _retried = false) {
    if (!conversationId) return;
    const s = _ensureCloudSettings();
    const tags = conversationTagsShared().assignTagNames(s.tags, conversationId, names);
    return _patchCloudSettings({ tags, conversationId, _retried });
  }
  async function addConversationTagName(conversationId, name) {
    const id = String(conversationId || "").trim();
    const clean = String(name || "").trim();
    if (!id || !clean) return;
    const names = conversationTagsFor(id).map((tag) => tag.name);
    if (!names.some((item) => item.toLowerCase() === clean.toLowerCase())) {
      if (names.length >= 3) return endConversationTagEdit(id);
      names.push(clean);
    }
    moduleState.tagEditingConversationId = "";
    moduleState.tagEditingAdding = false;
    moduleState.tagEditingMode = "";
    moduleState.tagEditingTargetName = "";
    moduleState.tagEditingDraft = "";
    return setConversationTagNames(id, names);
  }
  async function removeConversationTagName(conversationId, name) {
    const id = String(conversationId || "").trim();
    const clean = String(name || "").trim().toLowerCase();
    if (!id || !clean) return;
    const names = conversationTagsFor(id)
      .map((tag) => tag.name)
      .filter((item) => item.toLowerCase() !== clean);
    moduleState.tagEditingConversationId = "";
    moduleState.tagEditingAdding = false;
    moduleState.tagEditingMode = "";
    moduleState.tagEditingTargetName = "";
    moduleState.tagEditingDraft = "";
    return setConversationTagNames(id, names);
  }
  async function removeConversationTagNameAnimated(conversationId, name) {
    const id = String(conversationId || "").trim();
    const clean = String(name || "").trim();
    if (!id || !clean) return;
    moduleState.tagRemovingConversationId = id;
    moduleState.tagRemovingName = clean;
    if (deps && typeof deps.render === "function") deps.render();
    setTimeout(() => {
      if (moduleState.tagRemovingConversationId === id
        && moduleState.tagRemovingName.toLowerCase() === clean.toLowerCase()) {
        moduleState.tagRemovingConversationId = "";
        moduleState.tagRemovingName = "";
        removeConversationTagName(id, clean);
      }
    }, 140);
  }
  async function renameConversationTagName(conversationId, oldName, newName) {
    const id = String(conversationId || "").trim();
    const source = String(oldName || "").trim();
    const target = String(newName || "").trim();
    if (!id || !source || !target) return endConversationTagEdit(id);
    const api = conversationTagsShared();
    const current = api.normalizeConversationTags(_ensureCloudSettings().tags);
    const sourceItem = current.items.find((item) => item.name.toLowerCase() === source.toLowerCase());
    if (!sourceItem) return endConversationTagEdit(id);
    const existing = current.items.find((item) =>
      item.id !== sourceItem.id && item.name.toLowerCase() === target.toLowerCase());
    let nextItems = [];
    let nextAssignments = {};
    if (existing) {
      nextItems = current.items.filter((item) => item.id !== sourceItem.id);
      for (const [targetId, ids] of Object.entries(current.assignments || {})) {
        const merged = [...new Set((Array.isArray(ids) ? ids : []).map((tagId) =>
          tagId === sourceItem.id ? existing.id : tagId))].slice(0, 3);
        if (merged.length) nextAssignments[targetId] = merged;
      }
    } else {
      nextItems = current.items.map((item) =>
        item.id === sourceItem.id ? { ...item, name: target } : item);
      nextAssignments = { ...current.assignments };
    }
    moduleState.tagEditingConversationId = "";
    moduleState.tagEditingAdding = false;
    moduleState.tagEditingMode = "";
    moduleState.tagEditingTargetName = "";
    moduleState.tagEditingDraft = "";
    const tags = typeof api.pruneUnusedTagItems === "function"
      ? api.pruneUnusedTagItems({ items: nextItems, assignments: nextAssignments })
      : api.normalizeConversationTags({ items: nextItems, assignments: nextAssignments });
    return _patchCloudSettings({
      tags,
      conversationId: id
    });
  }
  function setConversationTagFilter(name) {
    const clean = String(name || "").trim();
    const current = String(moduleState.tagFilterName || "").trim();
    moduleState.tagFilterName = current && current.toLowerCase() === clean.toLowerCase() ? "" : clean;
    if (deps && typeof deps.render === "function") deps.render();
  }
  function openConversationTagMenu(conversationId, name, x, y) {
    const id = String(conversationId || "").trim();
    const clean = String(name || "").trim();
    if (!id || !clean || typeof window === "undefined") return;
    window.miaConversationContextMenu?.openConversationTagMenu?.(
      {
        conversationId: id,
        name: clean,
        filterActive: String(moduleState.tagFilterName || "").trim().toLowerCase() === clean.toLowerCase()
      },
      {
        filter: () => setConversationTagFilter(clean),
        rename: () => startConversationTagRename(id, clean),
        remove: () => removeConversationTagNameAnimated(id, clean)
      },
      x,
      y
    );
  }
  async function editConversationTags(conversationId, title = "", onSaved = null, options = {}) {
    if (!conversationId || typeof window === "undefined") return;
    const result = beginConversationTagEdit(conversationId);
    if (typeof onSaved === "function") onSaved();
    return result;
  }
  async function _patchCloudSettings({ pinned, muted, manualUnread, tags, conversationId, _retried }) {
    if (!conversationId) return;
    const s = _ensureCloudSettings();
    const pins = Array.isArray(s.pins) ? s.pins : [];
    const mutedConversations = Array.isArray(s.mutedConversations) ? s.mutedConversations : [];
    const unreadOverrides = s.unreadOverrides && typeof s.unreadOverrides === "object" ? { ...s.unreadOverrides } : {};
    const next = {
      pins: pinned === true ? [...new Set([...pins, conversationId])]
        : pinned === false ? pins.filter((id) => id !== conversationId)
        : pins,
      mutedConversations: muted === true ? [...new Set([...mutedConversations, conversationId])]
        : muted === false ? mutedConversations.filter((id) => id !== conversationId)
        : mutedConversations,
      unreadOverrides,
      readMarks: s.readMarks || {},
      appearance: s.appearance || {},
      starterEngineBots: s.starterEngineBots || {},
      tags: tags !== undefined ? conversationTagsShared().normalizeConversationTags(tags) : s.tags
    };
    if (manualUnread === true) {
      next.unreadOverrides[conversationId] = true;
    } else if (manualUnread === false) {
      delete next.unreadOverrides[conversationId];
      // Clear actual unread count too — "mark read" should leave 0.
      moduleState.unreadByConversation.delete(conversationId);
    }
    moduleState.cloudSettings = { ...s, ...next };
    if (deps && typeof deps.render === "function") deps.render();
    try {
      const updated = await window.mia.social.settingsPut({
        pins: next.pins,
        mutedConversations: next.mutedConversations,
        unreadOverrides: next.unreadOverrides,
        readMarks: next.readMarks,
        appearance: next.appearance,
        starterEngineBots: next.starterEngineBots,
        tags: next.tags,
        expectedVersion: s.version || 0
      });
      const updatedSettings = unwrapCloudSettingsResponse(updated);
      if (updatedSettings && typeof updatedSettings === "object") moduleState.cloudSettings = normalizeCloudSettings(updatedSettings, moduleState.cloudSettings || s);
    } catch (err) {
      if (!_retried && /409|version conflict/i.test(String(err?.message || ""))) {
        await bootstrapCloudSettings();
        return _patchCloudSettings({ pinned, muted, manualUnread, tags, conversationId, _retried: true });
      }
      console.warn("[social] settingsPut failed:", err?.message || err);
      moduleState.cloudSettings = s;
      if (deps && typeof deps.render === "function") deps.render();
    }
  }

  async function bootstrapCloudSettings() {
    try {
      const settings = unwrapCloudSettingsResponse(await window.mia.social.settingsGet());
      if (settings && typeof settings === "object") {
        moduleState.cloudSettings = normalizeCloudSettings(settings, moduleState.cloudSettings || {});
        reconcileUnreadFromReadMarks(moduleState.cloudSettings.readMarks);
        if (deps && typeof deps.render === "function") deps.render();
      }
    } catch (err) {
      console.warn("[social] settingsGet failed:", err?.message || err);
    }
  }

  function applyCloudSettings(settings) {
    if (!settings || typeof settings !== "object") return;
    const previous = normalizeCloudSettings(moduleState.cloudSettings || {}, moduleState.cloudSettings || {});
    const previousSignature = cloudSettingsRenderSignature(previous);
    const next = normalizeCloudSettings(settings, previous);
    const nextSignature = cloudSettingsRenderSignature(next);
    moduleState.cloudSettings = next;
    const unreadChanged = reconcileUnreadFromReadMarks(next.readMarks);
    if ((previousSignature !== nextSignature || unreadChanged) && deps && typeof deps.render === "function") deps.render();
  }

  // Another device pushed new readMarks. For each conversation whose readMark
  // has caught up to (or past) the highest seq we've cached locally, clear
  // moduleState.unreadByConversation so the badge clears in real time.
  // Uncached conversations report maxSeq=0, so readSeq >= maxSeq trivially
  // holds and we trust the peer's mark. Manual "标为未读" overrides live in
  // cloudSettings.unreadOverrides and are unaffected; auto-counted unread
  // is what this resets.
  function reconcileUnreadFromReadMarks(readMarks) {
    if (!readMarks || typeof readMarks !== "object") return false;
    let changed = false;
    for (const [id, mark] of Object.entries(readMarks)) {
      const readSeq = Number(mark) || 0;
      if (readSeq <= 0) continue;
      const maxSeq = Number(moduleState.messageCache.get(id)?.maxSeq) || 0;
      if (readSeq >= maxSeq) {
        if (moduleState.unreadByConversation.delete(id)) changed = true;
      }
    }
    return changed;
  }

  // PATCH /api/conversations/:id — rename the cloud conversation (groups only; DM rename
  // is rejected server-side because DM display name is derived from the
  // peer's profile). Optimistically updates local conversations list; the
  // conversation.updated WS event will reconcile from canonical state.
  async function renameConversation(conversationId, name) {
    if (!conversationId || !name) return { ok: false, error: "missing arg" };
    const res = await window.mia.social.updateConversation(conversationId, { name });
    if (res?.ok && res.data?.conversation) {
      const conversation = res.data.conversation;
      moduleState.conversations = moduleState.conversations.map((r) => (r.id === conversation.id ? { ...r, ...conversation } : r));
      if (deps && typeof deps.render === "function") deps.render();
    }
    return res;
  }

  // DELETE /api/conversations/:id — remove the cloud conversation. Server cascades members
  // + messages. WS conversation.deleted will sync other tabs; this also cleans up
  // local state immediately.
  async function deleteCloudConversation(conversationId) {
    if (!conversationId) return { ok: false, error: "missing arg" };
    const res = await window.mia.social.deleteConversation(conversationId);
    if (res?.ok) {
      moduleState.conversations = moduleState.conversations.filter((r) => r.id !== conversationId);
      moduleState.messageCache.delete(conversationId);
      moduleState.unreadByConversation.delete(conversationId);
      _conversationMembersCache.delete(conversationId);
      if (conversationId === moduleState.activeConversationId) moduleState.activeConversationId = null;
      // Pin state is server-canonical now; cleanup happens via
      // user_settings.updated broadcast.
      if (deps && typeof deps.render === "function") deps.render();
    }
    return res;
  }
  function getUnreadForConversation(conversationId) {
    const actual = unreadShared().computeUnreadForConversation({ id: conversationId }, moduleState.unreadByConversation);
    if (actual > 0) return actual;
    // Manual "标为未读" override surfaces as a single-pip badge.
    return isConversationManuallyUnread(conversationId) ? 1 : 0;
  }
  function getUnreadForBot(botId) {
    const key = String(botId || "").trim();
    if (!key) return 0;
    let total = 0;
    for (const conversation of moduleState.conversations) {
      if (!conversation?.id) continue;
      if (sessionHistoryShared().conversationType(conversation, conversation.id) !== "bot") continue;
      if (botKeyForConversation(conversation, conversation.id) !== key) continue;
      total += getUnreadForConversation(conversation.id);
    }
    return total;
  }
  // Aggregate unread badge total. Muted conversations ("免打扰") are excluded so they
  // don't drive the app/dock badge — the per-row grey pip still renders via
  // getUnreadForConversation in renderSidebarRows, but a muted conversation never "notifies"
  // at the aggregate level. Uses getUnreadForConversation so manual "标为未读"
  // overrides count consistently.
  function getTotalConversationUnread() {
    let total = 0;
    for (const conversation of moduleState.conversations) {
      if (!conversation || !conversation.id) continue;
      if (isConversationMuted(conversation.id)) continue;
      total += getUnreadForConversation(conversation.id);
    }
    return total;
  }
  // Expose the cached conversation member list so app.js can build a composite
  // avatar for cloud group conversations via the same path as local bot groups.
  function getConversationMembers(conversationId) { return _conversationMembersCache.get(conversationId) || null; }

  // ── exports ───────────────────────────────────────────────────────────────

  // Shared context exposed for social-groups.js to consume.
  const _internalCtx = {
    get moduleState() { return moduleState; },
    get deps() { return deps; },
    conversationMembersCache: _conversationMembersCache,
    escapeHtml,
    avatarColor,
    dedup,
    friendById,
    renderMsgBody: _renderMsgBody,
    renderAttachmentChips,
    renderSendStatus,
    compactPermissionTitle,
    cloudRunFor,
    addRunPermission,
    agentRunStatusPhrasePools,
    runActivityLabel,
    phaseOrbOpacityForCell,
    renderAgentPermissionBanner,
    submitPermissionDecision,
    appendMessageToActiveChat: _appendMessageToActiveChat,
    animateRemoveMessageFromActiveChat: _animateRemoveMessageFromActiveChat,
    messageLayoutKey,
    captureMessageLayout,
    animateMessageLayoutShift,
    adapterCtx
  };

  global.miaSocial = {
    moduleState,
    OTHER_DEVICE_CONVERSATION_FILTER,
    OTHER_DEVICE_CONVERSATION_LABEL,
    initSocialModule,
    bootstrapAfterLogin,
    isBootstrapped,
    handleCloudEvent,
    renderSidebarRows,
    renderConversationChat,
    pendingRequestCount,
    renderRequestsInto,
    openAddFriendDialog,
    openCreateGroupDialog,
    sendInActiveConversation,
    sendInActiveGroupConversation,
    translateConversationMessage,
    deleteConversationMessage,
    describeMessageForMenu,
    getActiveConversationId,
    activeConversationRun,
    conversationRun,
    conversationRunIsRunning,
    conversationRunIsBusy,
    conversationRunIsTyping,
    activeConversationRunIsTyping,
    activeConversationCanSend,
    getConversationById,
    botConversationForKey,
    setActiveConversationId,
    focusConversationMessage,
    markConversationRead,
    isConversationPinned,
    setConversationPinned,
    isConversationMuted,
    setConversationMuted,
    isConversationManuallyUnread,
    setConversationManuallyUnread,
    conversationTagsFor,
    conversationRunsOnOtherDevice,
    conversationTagFilters,
    getConversationTagFilter,
    conversationTagEditorFor,
    setConversationTagNames,
    beginConversationTagEdit,
    startConversationTagAdd,
    startConversationTagRename,
    setConversationTagDraft,
    endConversationTagEdit,
    addConversationTagName,
    removeConversationTagName,
    renameConversationTagName,
    setConversationTagFilter,
    editConversationTags,
    applyCloudSettings,
    ensureBotConversation,
    upsertBotConversation,
    renameConversation,
    deleteCloudConversation,
    getUnreadForConversation,
    getUnreadForBot,
    getTotalConversationUnread,
    getConversationMembers,
    otherUserForConversation,
    friendById,
    _internalCtx
  };
  if (global.miaSocialGroups && typeof global.miaSocialGroups.attach === "function") {
    global.miaSocialGroups.attach(_internalCtx);
  }

})(typeof window !== "undefined" ? window : globalThis);
