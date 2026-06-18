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
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  // Device-local memory of the last conversation the user had open, so relaunch
  // lands back on it instead of an empty chat pane. Same renderer-prefs convention
  // as mia.sidebarWidth; not synced across devices on purpose.
  const LAST_CONVERSATION_KEY = "mia.lastActiveConversationId";
  const LAST_BOT_CONVERSATION_KEY = "mia.lastBotConversationByKey";

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
  const MESSAGE_FOCUS_PENDING_TTL_MS = 10000;
  const MESSAGE_FOCUS_HIGHLIGHT_MS = 2200;
  // Which conversation renderConversationChat last painted — a change means the user switched
  // conversations, so we land at the bottom instead of preserving the old offset.
  let _lastRenderedConversationId = null;
  let _pendingMessageFocus = null;

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
      skills: msg.skills_json || "",
      attachments: msg.attachments || [],
      translation: msg.translation || null
    });
  }

  function streamSignature(run) {
    if (!run) return "";
    return jsonSignature({
      runId: run.runId || "",
      botId: run.botId || "",
      text: run.text || "",
      reasoning: run.reasoning || "",
      tools: run.tools || [],
      createdAt: run.createdAt || ""
    });
  }

  function chatRenderSignatureFor(conversationId) {
    const entry = moduleState.messageCache.get(conversationId) || { messages: [], maxSeq: 0 };
    const conversation = moduleState.conversations.find((r) => r.id === conversationId);
    const type = conversationTypeFor(conversation, conversationId);
    const members = (type === "group" || type === "bot") ? (_conversationMembersCache.get(conversationId) || []) : [];
    return jsonSignature({
      conversationId,
      maxSeq: entry.maxSeq || 0,
      conversation: conversationSignature(conversation),
      members: members.map(memberSignature),
      messages: (entry.messages || []).map(messageSignature),
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
    if (!containerEl || !targetEl) return;
    const targetTop = elementTopWithin(containerEl, targetEl);
    const targetHeight = Number(targetEl.offsetHeight) || Number(targetEl.getBoundingClientRect?.().height) || 0;
    const viewportHeight = Number(containerEl.clientHeight) || 0;
    const maxScroll = Math.max(0, (Number(containerEl.scrollHeight) || 0) - viewportHeight);
    const nextTop = Math.max(0, Math.min(maxScroll, Math.round(targetTop - (viewportHeight - targetHeight) / 2)));
    containerEl.scrollTop = nextTop;
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
    centerMessageTarget(containerEl, target);
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
    incomingRequests: [],
    outgoingRequests: [],
    messageCache: new Map(),
    activeConversationId: null,
    myUsername: "",
    myUserId: "",
    cloudAgentRunsByConversation: new Map(),
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
  let _permissionBannerWired = false;
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

  function attachmentGlyph(attachment = {}) {
    const kind = attachment.kind || attachmentKind(attachment);
    if (kind === "image") return "IMG";
    if (kind === "video") return "VID";
    if (kind === "audio") return "AUD";
    if (kind === "pdf") return "PDF";
    if (kind === "text") return "TXT";
    return "FILE";
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
          ${renderAttachmentThumb(attachment)}
        </${tag}>
      `;
    }
    return `
      <${tag} class="message-attachment"${download} title="${escapeHtml(attachment.path || attachment.name || "")}">
        ${renderAttachmentThumb(attachment)}
        <strong>${escapeHtml(attachment.name || "附件")}</strong>
        <em>${escapeHtml(formatBytes(attachment.size))}</em>
      </${tag}>
    `;
  }

  function renderAttachmentChips(attachments = []) {
    if (!Array.isArray(attachments) || !attachments.length) return "";
    return `<div class="message-attachments">${attachments.map(renderAttachmentChip).join("")}</div>`;
  }

  function eventType(event = {}) {
    return String(event.type || event.event || "");
  }

  function eventText(event = {}) {
    for (const key of ["reasoning", "delta", "content_delta", "text_delta", "text", "content", "final_response"]) {
      if (typeof event[key] === "string") return event[key];
    }
    const data = event.data && typeof event.data === "object" ? event.data : null;
    if (data) return eventText(data);
    return "";
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

  function applyCloudAgentRunEvent(run, event = {}) {
    const name = eventType(event);
    if (name === "message.delta" || name === "text_delta") {
      run.text += eventText(event);
    } else if (name === "message.complete" || name === "message.completed") {
      run.text = eventText(event) || run.text;
    } else if (name === "run.completed" || name === "complete") {
      run.text = eventText(event) || run.text;
      run.status = "complete";
      clearRunPermissions(run);
    } else if (name === "run.failed" || name === "error") {
      run.status = "error";
      clearRunPermissions(run);
    } else if (name === "run.cancelled") {
      run.status = "cancelled";
      clearRunPermissions(run);
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
    }
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

  function messageWithFallbackRunTrace(conversationId, message) {
    const { SenderKind } = conversationKinds();
    if (!message || message.sender_kind !== SenderKind.Bot) return message;
    if (parseTraceJson(message.trace_json || message.trace)) return message;
    const trace = tracePayloadFromRun(moduleState.cloudAgentRunsByConversation.get(conversationId));
    return trace ? { ...message, trace } : message;
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

  function markRenderedTraceBlocks(containerEl) {
    const renderer = global.miaTraceBlocks;
    if (renderer && typeof renderer.markRenderedTraceBlocks === "function") {
      renderer.markRenderedTraceBlocks(containerEl);
    }
  }

  function cloudRunFor(conversationId, runId = "") {
    const existing = moduleState.cloudAgentRunsByConversation.get(conversationId);
    if (existing) return existing;
    const run = {
      conversationId,
      runId,
      text: "",
      reasoning: "",
      status: "running",
      createdAt: new Date().toISOString(),
      tools: [],
      pendingPermissions: [],
      toolsById: new Map(),
      toolsByName: new Map()
    };
    moduleState.cloudAgentRunsByConversation.set(conversationId, run);
    return run;
  }

  function normalizePermissionRequest(event = {}) {
    const requestId = String(event.requestId || event.id || "").trim();
    if (!requestId) return null;
    return {
      requestId,
      engine: String(event.engine || "").trim(),
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
      if (engine === "claude-code") return "Claude Code";
      if (engine === "codex") return "Codex";
      if (engine === "openclaw") return "OpenClaw";
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
    return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < SCROLL_STICK_THRESHOLD_PX;
  }

  function scheduleChatBottomStick(chatEl, expectedScrollTop) {
    if (!chatEl) return;
    const schedule = typeof global.requestAnimationFrame === "function"
      ? global.requestAnimationFrame.bind(global)
      : (fn) => setTimeout(fn, 16);
    schedule(() => {
      if (!chatEl) return;
      const currentTop = Number(chatEl.scrollTop) || 0;
      const expectedTop = Number(expectedScrollTop) || 0;
      if (Math.abs(currentTop - expectedTop) > 1 && !isChatNearBottom(chatEl)) return;
      chatEl.scrollTop = chatEl.scrollHeight;
    });
  }

  function stickChatToBottomAfterPermissionLayout(chatEl, shouldStick) {
    if (!chatEl || !shouldStick) return;
    const schedule = typeof global.requestAnimationFrame === "function"
      ? global.requestAnimationFrame.bind(global)
      : (fn) => setTimeout(fn, 16);
    schedule(() => {
      chatEl.scrollTop = chatEl.scrollHeight;
    });
  }

  function renderAgentPermissionBanner() {
    const banner = document.getElementById("agentPermissionBanner");
    if (!banner) return;
    const chatEl = document.getElementById("chat");
    const shouldStickChat = isChatNearBottom(chatEl);
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
    if (!requestId || !decision || !window.mia?.respondChatPermission) return;
    if (_permissionDecisionInFlight.has(requestId)) return;
    _permissionDecisionInFlight.add(requestId);
    const buttons = banner.querySelectorAll("button[data-permission-decision]");
    buttons.forEach((item) => { item.disabled = true; });
    try {
      const result = await window.mia.respondChatPermission({ requestId, decision });
      if (!result || result.ok === false) throw new Error(result?.error || "权限审批失败");
      removePermissionRequestById(requestId);
      renderAgentPermissionBanner();
    } catch (error) {
      buttons.forEach((item) => { item.disabled = false; });
      deps?.appendTransientChat?.("assistant", error?.message || String(error || "权限审批失败"));
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
      _reRenderActiveChat();
      renderAgentPermissionBanner();
      // Header typing dots (replaces the old in-bubble "正在输入" status) — host
      // app owns the header DOM, so it provides the repaint callback via deps.
      if (deps && typeof deps.paintHeaderStatus === "function") deps.paintHeaderStatus();
    });
  }

  function activeConversationRun() {
    const conversationId = moduleState.activeConversationId;
    if (!conversationId) return null;
    return moduleState.cloudAgentRunsByConversation.get(conversationId) || null;
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

  function visibleSocialConversations(conversations, options = {}) {
    if (!Array.isArray(conversations)) return [];
    const keepLegacyIds = new Set([
      String(options.activeConversationId || "").trim(),
      ...Object.values(options.preferredConversationIdByBotKey || {}).map((id) => String(id || "").trim())
    ].filter(Boolean));
    const filteredTag = options.ignoreTagFilter ? "" : String(moduleState.tagFilterName || "").trim().toLowerCase();
    return conversations.filter((conversation) =>
      !isLegacyBotSessionConversation(conversation)
      || keepLegacyIds.has(String(conversation?.id || ""))
    ).filter((conversation) => {
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
    const preferred = preferredId
      ? matches.find((conversation) => conversation.id === preferredId)
      : null;
    if (preferred) return preferred;
    const stable = matches.find((conversation) => String(conversation?.decorations?.sessionId || "") === key);
    if (stable) return stable;
    return matches.find((conversation) => !isLegacyBotSessionConversation(conversation)) || matches[0] || null;
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
        modelSettings: window.miaModelSettings,
        engineOptions: window.miaEngineOptions,
        onConversation: upsertConversation
      });
      const conversation = result.conversation || null;
      return conversation;
    } catch (error) {
      console.warn("[social] ensure bot conversation failed", botKey, error);
      return null;
    }
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
    const cloudBots = Array.isArray(moduleState.bots) ? moduleState.bots : [];
    const bots = window.miaBotDirectory
      ? window.miaBotDirectory.listOwnedBots({ cloudBots, runtime })
      : cloudBots;
    const self = window.miaSelfIdentity.resolveSelfIdentity({
      cloudUser,
      localUser,
      myUserId: moduleState.myUserId,
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

  function mergeCloudBotIdentity(existing = null, incoming = {}) {
    const key = botKeyFromRecord(incoming) || botKeyFromRecord(existing);
    const runtimeFields = {};
    for (const field of [
      "runtimeKind",
      "runtimeConfig",
      "agentEngine",
      "targetDeviceId",
      "targetDeviceName",
      "deviceId",
      "deviceName",
      "runtimeLabel"
    ]) {
      if (existing && existing[field] !== undefined && incoming[field] === undefined) {
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

  function upsertCloudBotIdentity(bot) {
    const key = botKeyFromRecord(bot);
    if (!key) return false;
    const existing = moduleState.bots.find((item) => botKeyFromRecord(item) === key) || null;
    moduleState.bots = [
      mergeCloudBotIdentity(existing, bot),
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
          if (bot && upsertCloudBotIdentity(bot) && deps && typeof deps.render === "function") deps.render();
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
          moduleState.conversations = [];
          moduleState.messageCache.clear();
          _conversationMembersCache.clear();
          moduleState.unreadByConversation.clear();
        }
        moduleState.myUsername = meRes.data.username || "";
        moduleState.myUserId = freshUserId;
      }
      if (friendsRes.ok) moduleState.friends = friendsRes.data?.friends || [];
      if (botsRes.ok) moduleState.bots = botsRes.data?.bots || [];
      if (incomingRes.ok) moduleState.incomingRequests = incomingRes.data?.requests || [];
      if (outgoingRes.ok) moduleState.outgoingRequests = outgoingRes.data?.requests || [];

      const conversationsRes = await api.listConversations();
      if (conversationsRes.ok) {
        moduleState.conversations = conversationsRes.data?.conversations || [];
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
    if (!event || !event.type) return;
    const { type, payload } = event;

    // Every time the WS reconnects (events_ready), re-pull authoritative
    // state from the cloud. Otherwise any social events that were
    // broadcast while we were disconnected stay invisible until restart.
    if (type === "events_ready") {
      bootstrapAfterLogin().catch((err) => console.warn("[social] rebootstrap on events_ready failed:", err));
      return;
    }

    // Phase 3: another device wrote settings — replace local cache so
    // pins / read marks / appearance match across devices in real time.
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
      upsertCloudBotIdentity(bot);
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "bot.deleted") {
      const botId = String(payload?.botId || payload?.id || "").trim();
      if (!botId) return;
      moduleState.bots = moduleState.bots.filter((item) => String(item?.key || item?.id || "") !== botId);
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
      const run = cloudRunFor(conversationId, payload.runId || "");
      run.runId = payload.runId || run.runId;
      run.hermesRunId = payload.hermesRunId || run.hermesRunId || "";
      run.botId = payload.botId || run.botId || "";
      run.status = "running";
      scheduleCloudRunRender(conversationId);
      return;
    }

    if (type === "cloud_agent_run_event") {
      const conversationId = payload?.conversationId;
      const hermesEvent = payload?.event || {};
      if (!conversationId) return;
      const run = cloudRunFor(conversationId, payload.runId || "");
      run.botId = payload.botId || run.botId || "";
      applyCloudAgentRunEvent(run, hermesEvent);
      scheduleCloudRunRender(conversationId);
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
        renderAgentPermissionBanner();
        // First bot reply in an untitled conversation → auto-title it.
        if (deps && typeof deps.maybeGenerateConversationTitle === "function") {
          Promise.resolve(deps.maybeGenerateConversationTitle(conversationId)).catch(() => {});
        }
      }

      // Unread bookkeeping: count messages that aren't mine and didn't land
      // in the currently open conversation.
      const isMine = _isMessageFromSelf(message);
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
      if (fresh && conversationId === moduleState.activeConversationId) {
        if (hadStreamingRun) {
          _reRenderActiveChat();
        } else {
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
      const lastMessagePreview = lastMsg ? String(lastMsg.body_md || "").slice(0, 80) : "";

      // Sidebar activity follows the last message the chat can actually render.
      // Metadata-only conversation.updated events (title/runtime/member refresh)
      // should not reorder a row or change its displayed time.
      const updatedAt = lastMsg
        ? (new Date(lastMsg.created_at || lastMsg.createdAt || 0).getTime() || 0)
        : (new Date(conversation.updatedAt || conversation.updated_at || 0).getTime() || 0);
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
    const conversation = moduleState.conversations.find((r) => r.id === conversationId);
    const color = avatarColor(conversationId);
    const conversationType = conversationTypeFor(conversation, conversationId);
    const renderSignature = chatRenderSignatureFor(conversationId);

    // Decide BEFORE rebuilding whether to keep the view pinned to the bottom.
    // Stick when entering a different conversation (show its latest) or when the user is
    // already near the bottom; otherwise restore their prior offset so a
    // background re-render never yanks them out of the history they scrolled to.
    const isConversationSwitch = conversationId !== _lastRenderedConversationId;
    const prevScrollTop = containerEl.scrollTop;
    const hasPendingFocus = Boolean(pendingFocusFor(conversationId));
    const stickToBottom = !hasPendingFocus && (
      isConversationSwitch
      || (containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight < SCROLL_STICK_THRESHOLD_PX)
    );
    _lastRenderedConversationId = conversationId;
    const applyScroll = () => {
      if (focusPendingMessage(containerEl)) return;
      if (stickToBottom) {
        containerEl.scrollTop = containerEl.scrollHeight;
        scheduleChatBottomStick(containerEl, containerEl.scrollTop);
      } else {
        containerEl.scrollTop = prevScrollTop;
      }
    };

    if (!isConversationSwitch && containerEl.dataset?.conversationRenderSignature === renderSignature) {
      initNameBadgeLotties(containerEl);
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
      for (const msg of entry.messages) {
        const article = _buildGroupMessageArticle(msg, color, members);
        if (article) containerEl.appendChild(article);
      }
      const streaming = _buildCloudAgentStreamingArticle(conversationId, color, members, { groupMessage: true });
      if (streaming) containerEl.appendChild(streaming);
      window.miaAvatar?.hydrateAvatarVideos?.(containerEl);
      markRenderedTraceBlocks(containerEl);
      initNameBadgeLotties(containerEl);
      applyScroll();
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
    for (const msg of entry.messages) {
      const article = _buildMessageArticle(msg, color, members);
      if (article) containerEl.appendChild(article);
    }
    const streaming = _buildCloudAgentStreamingArticle(conversationId, color, members);
    if (streaming) containerEl.appendChild(streaming);
    window.miaAvatar?.hydrateAvatarVideos?.(containerEl);
    markRenderedTraceBlocks(containerEl);
    initNameBadgeLotties(containerEl);
    applyScroll();
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
    const bodyHtml = _renderMsgBody((spec ? spec.bodyMd : msg.body_md) || "");
    const skillsHtml = _renderMsgSkills(msg);
    const trace = !isUser ? parseTraceJson(msg.trace_json || msg.trace) : null;
    const traceHtml = trace
      ? renderTraceFor({
        reasoning: trace.reasoning,
        tools: trace.tools,
        content: (spec ? spec.bodyMd : msg.body_md) || "",
        expanded: false,
        scopeKey: `cloud-msg:${msg.id || ""}`
      })
      : "";
    // Render the bubble unconditionally (matching the group builder) so even an
    // attachment-only / empty-body message keeps a right-clickable carrier with
    // the data attributes the app.js contextmenu dispatcher looks for. Skill
    // chips the user selected for this message render at the top of the bubble.
    const senderHtml = shouldRenderSenderTitle(conversation) ? senderTitleHtml(spec, avatarColor) : "";
    const bubbleHtml = `<div class="bubble" data-message-index="${messageIndex}" data-message-source="cloud-conversation" data-message-id="${escapeHtml(msg.id || "")}">${senderHtml}${skillsHtml}${bodyHtml}</div>`;
    const attachmentHtml = renderAttachmentChips(spec?.attachments || msg.attachments || []);
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
        ${bubbleHtml}
        ${attachmentHtml}
        ${_renderMsgTranslation(msg)}
        ${timeHtml}
        ${renderSendStatus(msg)}
      </div>
    `;
    return article;
  }

  function _buildCloudAgentStreamingArticle(conversationId, accentColor, members = [], options = {}) {
    const run = moduleState.cloudAgentRunsByConversation.get(conversationId);
    // Typing-only state ("running" with no text/reasoning/tools yet) shows in the
    // conversation header instead of a placeholder bubble — see paintHeaderStatus.
    if (!run || (!run.text && !run.reasoning && !run.tools.length)) return null;
    const conversation = moduleState.conversations.find((r) => r.id === conversationId) || { id: conversationId };
    const botKey = run.botId || sessionHistoryShared().botId(conversation) || "mia";
    const synthetic = {
      id: `cloud-agent-stream-${run.runId || conversationId}`,
      sender_kind: "bot",
      sender_ref: botKey,
      body_md: run.text || "",
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
    const bodyHtml = run.text ? _renderMsgBody(run.text) : "";
    const traceHtml = renderTraceFor({
      reasoning: run.reasoning,
      tools: run.tools,
      content: run.text,
      expanded: true,
      scopeKey: `cloud-run:${run.runId || conversationId}`
    });
    const toolsHtml = !traceHtml && run.tools.length
      ? `<div class="message-attachments">${run.tools.slice(-3).map((tool) => `<span class="message-attachment"><span>TOOL</span><strong>${escapeHtml(tool.name || "工具")}</strong><em>${escapeHtml(tool.status || "")}</em></span>`).join("")}</div>`
      : "";
    const article = document.createElement("article");
    article.className = `message assistant streaming${options.groupMessage ? " group-message" : ""}`;
    article.innerHTML = `
      ${avatarHtml}
      <div class="message-stack">
        ${traceHtml}
        ${bodyHtml ? `<div class="bubble">${bodyHtml}</div>` : ""}
        ${toolsHtml}
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
    if (status !== "sending" && status !== "error") return "";
    if (status === "sending") {
      return `<span class="message-send-status is-sending">发送中...</span>`;
    }
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
    if (deps && typeof deps.render === "function") deps.render();
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
    if (prefersReducedMotion() || target.classList?.contains?.("message-removing")) {
      target.remove();
      markChatRenderFresh(chatEl);
      return false;
    }
    const rect = typeof target.getBoundingClientRect === "function" ? target.getBoundingClientRect() : null;
    const height = Math.max(1, Number(rect?.height) || Number(target.offsetHeight) || 1);
    target.style.height = `${height}px`;
    target.style.maxHeight = `${height}px`;
    // Force a layout read so the browser transitions from the measured height.
    void target.offsetHeight;
    target.classList.add("message-removing");
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        target.removeEventListener?.("transitionend", finish);
        resolve();
      };
      target.addEventListener?.("transitionend", finish, { once: true });
      setTimeout(finish, MESSAGE_REMOVE_ANIMATION_MS + 80);
    });
    target.remove();
    markChatRenderFresh(chatEl);
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
      const cryptoRandomId = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
      const response = await window.mia.sendChat({
        botKey,
        sessionId: `utility:translate:${cryptoRandomId()}`,
        utility: true,
        messages: [{ role: "user", content: prompt }]
      });
      const translated = String(response?.choices?.[0]?.message?.content || "").trim();
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
    if (conversationId === moduleState.activeConversationId) {
      await _animateRemoveMessageFromActiveChat(messageId);
    }
    if (entry) entry.messages = entry.messages.filter((m) => m.id !== messageId);
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
    const nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < SCROLL_STICK_THRESHOLD_PX;
    const conversation = moduleState.conversations.find((r) => r.id === moduleState.activeConversationId);
    const color = conversation ? avatarColor(conversation.id) : "#5e5ce6";
    const conversationType = conversationTypeFor(conversation, moduleState.activeConversationId);
    const members = _conversationMembersCache.get(moduleState.activeConversationId) || [];
    const article = conversationType === "group"
      ? _buildGroupMessageArticle(msg, color, _conversationMembersCache.get(moduleState.activeConversationId) || [])
      : _buildMessageArticle(msg, color, conversationType === "bot" ? members : []);
    if (article) {
      chatEl.appendChild(article);
      window.miaAvatar?.hydrateAvatarVideos?.(article);
      initNameBadgeLotties(article);
      markChatRenderFresh(chatEl);
      if (stick || nearBottom) chatEl.scrollTop = chatEl.scrollHeight;
    }
  }

  function _appendLocalOutgoingConversationMessage(conversationId, prepared, skills = null) {
    if (!conversationId || !prepared || !prepared.bodyMd) return null;
    if (!moduleState.messageCache.has(conversationId)) {
      moduleState.messageCache.set(conversationId, { messages: [], maxSeq: 0 });
    }
    const msg = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      seq: Number.MAX_SAFE_INTEGER,
      sender_kind: conversationKinds().SenderKind.User,
      sender_ref: moduleState.myUserId || "",
      body_md: prepared.bodyMd,
      attachments: prepared.attachments || [],
      mentions: prepared.mentions || [],
      // Mirror the server's skills_json so the bubble renders chips immediately,
      // before the echoed message comes back.
      skills_json: skills && skills.length ? JSON.stringify(skills) : null,
      turn_id: prepared.clientTraceId || null,
      status: "sending",
      created_at: new Date().toISOString(),
      _localPending: true
    };
    const entry = moduleState.messageCache.get(conversationId);
    entry.messages.push(msg);
    entry.messages.sort((a, b) => a.seq - b.seq);
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

  function _messageLooksFromSelf(message) {
    const senderRef = String(message?.sender_ref || "").trim();
    return Boolean(senderRef && moduleState.myUserId && senderRef === moduleState.myUserId) || _isMessageFromSelf(message);
  }

  function _localPendingEchoIndexWithoutTurnId(entry, sentMsg) {
    if (sentMsg.turn_id || sentMsg.sender_kind !== conversationKinds().SenderKind.User || !_messageLooksFromSelf(sentMsg)) return -1;
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

  function _reconcileEchoedConversationMessage(conversationId, sentMsg) {
    if (!conversationId || !sentMsg || !sentMsg.id) return false;
    if (sentMsg.sender_kind !== conversationKinds().SenderKind.User || !_messageLooksFromSelf(sentMsg)) return false;
    const entry = moduleState.messageCache.get(conversationId);
    if (!entry) return false;
    const localIdx = sentMsg.turn_id
      ? entry.messages.findIndex((m) => m && m._localPending && m.turn_id === sentMsg.turn_id)
      : _localPendingEchoIndexWithoutTurnId(entry, sentMsg);
    if (localIdx < 0) return false;
    entry.messages[localIdx] = sentMsg;
    entry.messages.sort((a, b) => a.seq - b.seq);
    if (sentMsg.seq > entry.maxSeq) entry.maxSeq = sentMsg.seq;
    if (conversationId === moduleState.activeConversationId) _reRenderActiveChat();
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
    if (serverIdx >= 0) {
      if (localIdx >= 0 && localIdx !== serverIdx) entry.messages.splice(localIdx, 1);
    } else if (localIdx >= 0) {
      entry.messages[localIdx] = sentMsg;
    } else {
      entry.messages.push(sentMsg);
    }
    entry.messages.sort((a, b) => a.seq - b.seq);
    if (sentMsg.seq > entry.maxSeq) entry.maxSeq = sentMsg.seq;
    if (conversationId === moduleState.activeConversationId) _reRenderActiveChat();
    if (deps && typeof deps.render === "function") deps.render();
    return true;
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
    closeBtn.textContent = "×";
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
        <span id="socialMyUserIdLabel" style="font-weight:600; font-variant-numeric:tabular-nums;">${myUserIdDisplay}</span>
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
      if (btn) { btn.textContent = "已复制"; setTimeout(() => { btn.textContent = "复制"; }, 1500); }
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

  function _renderRequestList(container, requests, direction, modal) {
    container.innerHTML = "";
    if (!requests.length) {
      return;
    }
    for (const req of requests) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border,rgba(0,0,0,.08));";

      // Cloud REST hydrates the request with `other` (the user on the
      // opposite end). Live WS events use `from` instead — accept either.
      const otherUser = req.other || req.from || {};
      const fallbackId = direction === "incoming" ? req.from_user : req.to_user;
      const displayName = otherUser.displayName || otherUser.account || otherUser.id || fallbackId || "—";

      const avatar = document.createElement("span");
      avatar.className = "avatar request-avatar";
      window.miaAvatar.applyAvatarMedia(
        avatar,
        otherUser.avatarImage,
        otherUser.avatarCrop,
        otherUser.avatarColor || window.miaMemberColor.memberAccentColor(otherUser.id || fallbackId || displayName),
        (displayName || "?").slice(0, 1).toUpperCase()
      );
      row.appendChild(avatar);

      const nameSpan = document.createElement("span");
      nameSpan.style.cssText = "flex:1; font-weight:500;";
      nameSpan.innerHTML = renderNameWithBadgeHtml({
        identity: { kind: "user", id: otherUser.id || fallbackId || "", displayName, statusBadge: statusBadgeFrom(otherUser) },
        fallbackName: displayName,
        statusBadge: statusBadgeFrom(otherUser)
      });
      row.appendChild(nameSpan);

      if (direction === "incoming") {
        const acceptBtn = document.createElement("button");
        acceptBtn.type = "button";
        acceptBtn.className = "button-primary";
        acceptBtn.style.cssText = "font-size:12px; padding:3px 10px;";
        acceptBtn.textContent = "同意";
        acceptBtn.addEventListener("click", async () => {
          acceptBtn.disabled = true;
          try {
            const res = await window.mia.social.respondFriendRequest(req.id, "accept");
            if (!res.ok) { acceptBtn.disabled = false; return; }
            moduleState.incomingRequests = moduleState.incomingRequests.filter((r) => r.id !== req.id);
            // Re-render
            if (modal) _renderAddFriendModal(modal);
            if (deps && typeof deps.render === "function") deps.render();
          } catch { acceptBtn.disabled = false; }
        });

        const rejectBtn = document.createElement("button");
        rejectBtn.type = "button";
        rejectBtn.className = "button-soft";
        rejectBtn.style.cssText = "font-size:12px; padding:3px 10px;";
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
        cancelBtn.className = "button-soft";
        cancelBtn.style.cssText = "font-size:12px; padding:3px 10px;";
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
    container.innerHTML = `
      <article class="contact-profile contact-requests">
        <section class="contact-note"><div id="socialContactRequestPane"></div></section>
      </article>
    `;
    _renderRequestList(container.querySelector("#socialContactRequestPane"), moduleState.incomingRequests, "incoming", null);
  }

  // ── Cloud-conversation send: DM, bot conversations, and groups share one path. ─────────

  async function sendInActiveConversation(text, options = {}) {
    const conversationId = moduleState.activeConversationId;
    if (!conversationId) return;
    const conversation = moduleState.conversations.find((r) => r.id === conversationId) || { id: conversationId };
    const conversationType = conversationTypeFor(conversation, conversationId);
    const members = _conversationMembersCache.get(conversationId) || [];
    // Composer skill chips selected for this message (the user's 「使用」).
    const skills = Array.isArray(options.skills) && options.skills.length
      ? options.skills.map((s) => ({ id: String(s.id || ""), name: String(s.name || s.id || "") })).filter((s) => s.id)
      : null;
    let prepared;
    try {
      prepared = sendPipelineShared().prepareOutgoingMessage(
        { text },
        { members: sendPipelineMembersForConversation(conversationType, members) }
      );
    } catch (err) {
      if (err && err.code === "EMPTY_MESSAGE") return;
      console.warn("[social] sendInActiveConversation prepare failed:", err?.message || err);
      return;
    }
    const localMsg = _appendLocalOutgoingConversationMessage(conversationId, prepared, skills);
    const mentions = postMentionsForConversation(conversationType, prepared.mentions);
    try {
      const res = await window.mia.social.postConversationMessage(conversationId, {
        bodyMd: prepared.bodyMd,
        turnId: prepared.clientTraceId,
        ...(mentions.length ? { mentions } : {}),
        ...(skills ? { skills } : {})
      });
      if (!res.ok) {
        console.warn("[social] postConversationMessage failed:", res.error);
        if (localMsg) _markLocalOutgoingConversationMessageFailed(conversationId, localMsg.id, res.error);
        if (res.status === 401 && deps && typeof deps.onCloudAuthExpired === "function") deps.onCloudAuthExpired();
        return;
      }
      const sentMsg = res.data?.message;
      if (!sentMsg || !sentMsg.id) return; // server didn't return a message somehow — skip optimistic
      _reconcileSentConversationMessage(conversationId, localMsg?.id, sentMsg);
    } catch (err) {
      if (localMsg) _markLocalOutgoingConversationMessageFailed(conversationId, localMsg.id, err?.message || err);
      console.warn("[social] sendInActiveConversation error:", err);
    }
  }

  // ── getters / setters ─────────────────────────────────────────────────────

  function getActiveConversationId() { return moduleState.activeConversationId; }
  function getConversationById(conversationId) { return moduleState.conversations.find((r) => r.id === conversationId) || null; }

  function mergeFetchedMessage(existing, incoming) {
    if (!existing) return incoming;
    const merged = { ...existing, ...incoming };
    if (existing.translation && incoming.translation == null) merged.translation = existing.translation;
    if (existing.trace_json && incoming.trace_json == null) merged.trace_json = existing.trace_json;
    if (existing.trace && incoming.trace == null) merged.trace = existing.trace;
    return merged;
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
      byId.set(msg.id, mergeFetchedMessage(existing, msg));
      changed = true;
      const seq = Number(msg.seq) || 0;
      if (seq > entry.maxSeq) entry.maxSeq = seq;
    }
    if (changed) {
      entry.messages = [...byId.values()].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
    }
    return entry;
  }

  function _reconcileFetchedMessageWindow(conversationId, sinceSeq, incoming, limit = 100) {
    const entry = moduleState.messageCache.get(conversationId);
    if (!entry || !Array.isArray(entry.messages)) return false;
    const fresh = Array.isArray(incoming) ? incoming.filter((msg) => msg?.id) : [];
    const visibleIds = new Set(fresh.map((msg) => String(msg.id)));
    const seqs = fresh.map((msg) => Number(msg.seq)).filter(Number.isFinite);
    const cap = Math.max(1, Number(limit) || 100);
    const lowerSeq = Number(sinceSeq) || 0;
    const completeWindow = fresh.length < cap;
    const upperSeq = completeWindow ? Infinity : Math.max(...seqs, lowerSeq);
    const before = entry.messages.length;
    entry.messages = entry.messages.filter((msg) => {
      const seq = Number(msg?.seq);
      if (!Number.isFinite(seq) || seq <= lowerSeq) return true;
      if (upperSeq !== Infinity && seq > upperSeq) return true;
      return visibleIds.has(String(msg.id || ""));
    });
    return entry.messages.length !== before;
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
    // Re-selecting the already-active conversation has no observable effect but
    // would otherwise re-write localStorage, re-POST a read mark, and re-trigger
    // _ensureConversationMessages. Drop those redundant side effects up front.
    if (next === moduleState.activeConversationId) return;
    // Any actual navigation (switching conversations, or leaving to a local bot chat
    // that reuses #chat) invalidates the last-painted marker, so the next
    // renderConversationChat treats re-entry as a switch and lands at the latest message
    // instead of restoring a stale offset.
    _lastRenderedConversationId = null;
    moduleState.activeConversationId = next;
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
    const conversation = moduleState.conversations.find((row) => row.id === id) || { id };
    if (sessionHistoryShared().conversationType(conversation, id) !== "bot") return;
    const key = sessionHistoryShared().botId(conversation);
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
    if (!moduleState.conversations.some((conversation) => conversation.id === savedId)) return;
    setActiveConversationId(savedId);
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
      // Older cloud settings responses only echo pins/readMarks/appearance.
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
    const visibleIds = new Set(visibleSocialConversations(moduleState.conversations, {
      activeConversationId: moduleState.activeConversationId,
      preferredConversationIdByBotKey: moduleState.lastBotConversationByKey,
      ignoreTagFilter: true
    }).map((conversation) => String(conversation?.id || "")).filter(Boolean));
    const counts = new Map();
    for (const [conversationId, ids] of Object.entries(tags?.assignments || {})) {
      if (!visibleIds.has(String(conversationId || ""))) continue;
      for (const tagId of new Set(Array.isArray(ids) ? ids : [])) {
        counts.set(tagId, (counts.get(tagId) || 0) + 1);
      }
    }
    return (Array.isArray(tags?.items) ? tags.items : [])
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
        if (deps && typeof deps.render === "function") deps.render();
      }
    } catch (err) {
      console.warn("[social] settingsGet failed:", err?.message || err);
    }
  }

  function applyCloudSettings(settings) {
    if (!settings || typeof settings !== "object") return;
    moduleState.cloudSettings = normalizeCloudSettings(settings, moduleState.cloudSettings || {});
    if (moduleState.cloudSettings.appearance && typeof deps?.applyCloudAppearance === "function") {
      deps.applyCloudAppearance(moduleState.cloudSettings.appearance);
    }
    reconcileUnreadFromReadMarks(moduleState.cloudSettings.readMarks);
    if (deps && typeof deps.render === "function") deps.render();
  }

  // Another device pushed new readMarks. For each conversation whose readMark
  // has caught up to (or past) the highest seq we've cached locally, clear
  // moduleState.unreadByConversation so the badge clears in real time.
  // Uncached conversations report maxSeq=0, so readSeq >= maxSeq trivially
  // holds and we trust the peer's mark. Manual "标为未读" overrides live in
  // cloudSettings.unreadOverrides and are unaffected; auto-counted unread
  // is what this resets.
  function reconcileUnreadFromReadMarks(readMarks) {
    if (!readMarks || typeof readMarks !== "object") return;
    for (const [id, mark] of Object.entries(readMarks)) {
      const readSeq = Number(mark) || 0;
      if (readSeq <= 0) continue;
      const maxSeq = Number(moduleState.messageCache.get(id)?.maxSeq) || 0;
      if (readSeq >= maxSeq) {
        moduleState.unreadByConversation.delete(id);
      }
    }
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
    renderAgentPermissionBanner,
    submitPermissionDecision,
    appendMessageToActiveChat: _appendMessageToActiveChat,
    adapterCtx
  };

  global.miaSocial = {
    moduleState,
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
