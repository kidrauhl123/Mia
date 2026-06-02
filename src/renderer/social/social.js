// Renderer-side social module: friends, DM conversations, add-friend dialog.
// Loaded by <script src="./social/social.js"> from index.html, BEFORE app.js.
// Pattern: IIFE + window.miaSocial public API; deps are injected via initSocialModule().

(function (global) {
  // Decision: cap initial-message fetch to 30 conversations to keep bootstrap fast.
  const INITIAL_CONVERSATIONS_CAP = 30;
  // Fetch a small recent overlap so older local SQLite rows can be upgraded when
  // the server adds fields like trace_json after the row was first cached.
  const MESSAGE_BACKFILL_OVERLAP = 50;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  // Device-local memory of the last conversation the user had open, so relaunch
  // lands back on it instead of an empty chat pane. Same renderer-prefs convention
  // as mia.sidebarWidth; not synced across devices on purpose.
  const LAST_CONVERSATION_KEY = "mia.lastActiveConversationId";
  const LAST_FELLOW_CONVERSATION_KEY = "mia.lastFellowConversationByKey";

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

  function readLastFellowConversationByKey() {
    try {
      const raw = rendererLocalStorage()?.getItem(LAST_FELLOW_CONVERSATION_KEY) || "";
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed)
        .map(([key, value]) => [String(key || "").trim(), String(value || "").trim()])
        .filter(([key, value]) => key && value));
    } catch {
      return {};
    }
  }

  function writeLastFellowConversationByKey(value) {
    try {
      const storage = rendererLocalStorage();
      if (!storage) return;
      storage.setItem(LAST_FELLOW_CONVERSATION_KEY, JSON.stringify(value || {}));
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
      MemberKind: { Fellow: "fellow", User: "user" },
      SenderKind: { Fellow: "fellow", User: "user", System: "system" }
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
        if (id.startsWith("fellow:")) return "fellow";
        if (id.startsWith("g_") || id.startsWith("g-")) return "group";
        return "";
      },
      fellowKey: (conversation) => {
        const decorated = conversation?.decorations?.fellowKey || conversation?.fellowKey || conversation?.fellow_id || "";
        if (decorated) return String(decorated);
        const id = String(conversation?.id || "");
        return id.startsWith("fellow:") ? id.split(":").slice(2).join(":") : "";
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

  // Distance (px) from the bottom within which we treat the user as "pinned" and
  // keep following new content. Mirrors the fellow-chat threshold in app.js.
  const SCROLL_STICK_THRESHOLD_PX = 80;
  // Which conversation renderConversationChat last painted — a change means the user switched
  // conversations, so we land at the bottom instead of preserving the old offset.
  let _lastRenderedConversationId = null;

  const moduleState = {
    conversations: [],
    friends: [],
    fellows: [],
    incomingRequests: [],
    outgoingRequests: [],
    messageCache: new Map(),
    activeConversationId: null,
    myUsername: "",
    myUserId: "",
    cloudAgentRunsByConversation: new Map(),
    pendingPermissionsById: new Map(),
    lastFellowConversationByKey: readLastFellowConversationByKey(),
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
    if (!message || message.sender_kind !== SenderKind.Fellow) return message;
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
      fellowKey: String(event.fellowKey || "").trim(),
      fellowName: String(event.fellowName || event.fellow_name || "").trim(),
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
    const fellowName = permissionFellowName(request);
    if (!title || title === "需要权限审批") return fellowName ? `${fellowName}请求执行权限` : "请求执行权限";
    const actionMatch = title.match(/^([^\s想\n]{1,32})\s+(想.+)$/);
    if (actionMatch) return `${fellowName || actionMatch[1]}${actionMatch[2]}`;
    const requestMatch = title.match(/^([^\s请\n]{1,32})\s+(请求.+)$/);
    if (requestMatch) return `${fellowName || requestMatch[1]}${requestMatch[2]}`;
    return title;
  }

  function permissionFellowName(request = {}) {
    const explicit = String(request.fellowName || "").trim();
    if (explicit) return explicit;
    const key = String(request.fellowKey || "").trim();
    if (!key) return "";
    const fellow = moduleState.fellows.find((item) => {
      const candidates = [item?.key, item?.id, item?.fellowId, item?.fellow_id].map((value) => String(value || "").trim());
      return candidates.includes(key);
    });
    return String(fellow?.name || fellow?.displayName || fellow?.title || "").trim();
  }

  function isChatNearBottom(chatEl) {
    if (!chatEl) return false;
    return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < SCROLL_STICK_THRESHOLD_PX;
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

  function fellowConversationRef(conversationId) {
    const parts = String(conversationId || "").split(":");
    if (parts.length < 3 || parts[0] !== "fellow") return "";
    return parts.slice(2).join(":");
  }

  function isLegacyFellowSessionConversation(conversation) {
    if (!conversation || conversation.type !== "fellow") return false;
    return UUID_RE.test(fellowConversationRef(conversation.id));
  }

  function visibleSocialConversations(conversations, options = {}) {
    if (!Array.isArray(conversations)) return [];
    const keepLegacyIds = new Set([
      String(options.activeConversationId || "").trim(),
      ...Object.values(options.preferredConversationIdByFellowKey || {}).map((id) => String(id || "").trim())
    ].filter(Boolean));
    return conversations.filter((conversation) =>
      !isLegacyFellowSessionConversation(conversation)
      || keepLegacyIds.has(String(conversation?.id || ""))
    );
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

  function upsertFellowConversation(conversation) {
    return upsertConversation(conversation);
  }

  function fellowConversationForKey(fellowKey) {
    const key = String(fellowKey || "").trim();
    if (!key) return null;
    const matches = moduleState.conversations.filter((conversation) => {
      const conversationId = String(conversation?.id || "");
      const decorated = String(conversation?.decorations?.fellowKey || conversation?.fellowKey || "").trim();
      return (conversation?.type === "fellow" || conversationId.startsWith("fellow:"))
        && (decorated === key || conversationId.split(":").slice(2).join(":") === key);
    });
    const preferredId = String(moduleState.lastFellowConversationByKey?.[key] || "").trim();
    const preferred = preferredId
      ? matches.find((conversation) => conversation.id === preferredId)
      : null;
    if (preferred) return preferred;
    return matches.find((conversation) => !isLegacyFellowSessionConversation(conversation)) || matches[0] || null;
  }

  function currentState() {
    return (deps && typeof deps.getState === "function" && deps.getState()) || {};
  }

  function localRuntimeFellows() {
    const state = currentState();
    const runtime = state.runtime || {};
    const candidates = [
      ...(Array.isArray(runtime.fellows) ? runtime.fellows : []),
      ...(Array.isArray(runtime.personas) ? runtime.personas : []),
      ...(Array.isArray(state.personas) ? state.personas : [])
    ];
    const seen = new Set();
    const fellows = [];
    for (const item of candidates) {
      if (!item || typeof item !== "object") continue;
      const key = String(item.key || item.id || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      fellows.push({ ...item, key });
    }
    return fellows;
  }

  async function syncLocalFellowRuntimeBinding(api, fellow) {
    const fellowKey = String(fellow?.key || fellow?.id || "").trim();
    if (!fellowKey || !window.miaFellowCommands?.syncDesktopLocalFellowRuntimeBinding) return;
    try {
      await window.miaFellowCommands.syncDesktopLocalFellowRuntimeBinding({
        api,
        state: currentState(),
        fellow,
        engineContracts: window.miaEngineContracts,
        modelSettings: window.miaModelSettings,
        engineOptions: window.miaEngineOptions
      });
    } catch (error) {
      console.warn("[social] sync fellow runtime failed", fellowKey, error);
    }
  }

  async function syncLocalFellowRuntimeBindings() {
    const api = window.mia?.social;
    if (!api || !window.miaFellowCommands?.syncDesktopLocalFellowRuntimeBinding) return;
    for (const fellow of localRuntimeFellows()) {
      await syncLocalFellowRuntimeBinding(api, fellow);
    }
  }

  async function ensureLocalFellowConversations(api) {
    if (!api || !window.miaFellowCommands?.ensureDesktopLocalFellowConversation) return;
    for (const fellow of localRuntimeFellows()) {
      try {
        await window.miaFellowCommands.ensureDesktopLocalFellowConversation({
          api,
          state: currentState(),
          fellow,
          engineContracts: window.miaEngineContracts,
          modelSettings: window.miaModelSettings,
          engineOptions: window.miaEngineOptions
        });
      } catch (error) {
        console.warn("[social] ensure fellow conversation failed", fellow.key, error);
      }
    }
  }

  async function ensureFellowConversation(fellow) {
    const fellowKey = String(fellow?.key || fellow?.id || "").trim();
    if (!fellowKey || !window.miaFellowCommands?.ensureDesktopLocalFellowConversation) return null;
    try {
      const result = await window.miaFellowCommands.ensureDesktopLocalFellowConversation({
        api: window.mia?.social,
        state: currentState(),
        fellow: { ...fellow, key: fellowKey },
        engineContracts: window.miaEngineContracts,
        modelSettings: window.miaModelSettings,
        engineOptions: window.miaEngineOptions,
        onConversation: upsertConversation
      });
      const conversation = result.conversation || null;
      return conversation;
    } catch (error) {
      console.warn("[social] ensure fellow conversation failed", fellowKey, error);
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
        name: m.name || m.fellow_name || m.username || m.displayName || ""
      }));
  }

  function cloudMentionForConversation(conversationType, mention) {
    if (conversationType !== "group") return mention;
    if (!mention || mention.kind !== conversationKinds().MemberKind.Fellow || !mention.ref) return null;
    return { kind: "fellow", fellowId: mention.ref };
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
    const { resolveContact, ContactKind } = helper;
    const contact = resolveContact(
      { kind: ContactKind.User, ref: msg && msg.sender_ref },
      adapterCtx()
    );
    return contact && contact.kind === ContactKind.Self;
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
    const cloudFellows = Array.isArray(moduleState.fellows) ? moduleState.fellows : [];
    const localFellows = [
      ...(Array.isArray(runtime.fellows) ? runtime.fellows : []),
      ...(Array.isArray(runtime.personas) ? runtime.personas : [])
    ];
    const fellows = window.miaFellowDirectory
      ? window.miaFellowDirectory.listOwnedFellows({ cloudFellows, localFellows, runtime })
      : [...cloudFellows, ...localFellows];
    return {
      self: {
        id: moduleState.myUserId || cloudUser.id || localUser.id || "",
        displayName: localUser.displayName || cloudUser.displayName || "",
        avatarText: localUser.avatarText || "",
        username: localUser.displayName || moduleState.myUsername || cloudUser.username || cloudUser.account || localUser.account || "",
        account: cloudUser.account || localUser.account || "",
        avatarImage: localUser.avatarImage || cloudUser.avatarImage || "",
        avatarCrop: localUser.avatarCrop || cloudUser.avatarCrop || null,
        avatarColor: localUser.avatarColor || cloudUser.avatarColor || "#5e5ce6"
      },
      fellows,
      friends: moduleState.friends || []
      // The text fallback lives inside shared/avatar-resolve.js now;
      // consumers no longer need any local fallback table.
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
    moduleState.fellows = Array.isArray(snapshot.fellows) ? snapshot.fellows : [];
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

  // ── bootstrapAfterLogin ───────────────────────────────────────────────────

  async function bootstrapAfterLogin() {
    if (!window.mia || !window.mia.social) {
      console.warn("[social] window.mia.social not available — skip bootstrap");
      return;
    }
    const api = window.mia.social;
    try {
      await hydrateCachedSocialBootstrap(api);
      const [meRes, friendsRes, incomingRes, outgoingRes, fellowsRes] = await Promise.all([
        api.myUsername(),
        api.listFriends(),
        api.listFriendRequests("incoming"),
        api.listFriendRequests("outgoing"),
        typeof api.listFellows === "function" ? api.listFellows() : Promise.resolve({ ok: true, data: { fellows: [] } }),
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
      if (fellowsRes.ok) moduleState.fellows = fellowsRes.data?.fellows || [];
      if (incomingRes.ok) moduleState.incomingRequests = incomingRes.data?.requests || [];
      if (outgoingRes.ok) moduleState.outgoingRequests = outgoingRes.data?.requests || [];

      await ensureLocalFellowConversations(api);

      const conversationsRes = await api.listConversations();
      if (conversationsRes.ok) moduleState.conversations = conversationsRes.data?.conversations || [];

      // Phase 3: cross-device user settings (pin / read marks / appearance).
      await bootstrapCloudSettings();

      // Fetch initial messages for up to INITIAL_CONVERSATIONS_CAP conversations.
      const conversationsToFetch = visibleSocialConversations(moduleState.conversations).slice(0, INITIAL_CONVERSATIONS_CAP);
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

      // Prefetch members for every group conversation so the sidebar mosaic
      // shows real avatars on first paint instead of an empty circle.
      // Bounded by INITIAL_CONVERSATIONS_CAP just like the message fetch above.
      const groupConversationsToFetch = conversationsToFetch.filter((r) => {
        const t = r.type
          || (r.id?.startsWith("dm:") ? "dm"
            : r.id?.startsWith("fellow:") ? "fellow"
            : (r.id?.startsWith("g_") || r.id?.startsWith("g-")) ? "group"
            : null);
        return t === "group";
      });
      await Promise.all(groupConversationsToFetch.map((r) => _fetchAndCacheConversationMembers(r.id)));
    } catch (err) {
      console.error("[social] bootstrapAfterLogin failed:", err);
    }
    restoreLastActiveConversation();
    // Flip the bootstrap flag AFTER everything is in the cache so the
    // first render that includes cloud rows also has fellow personas —
    // the sidebar shows both data sources in one paint instead of
    // "personas now, conversations later" (the visible "割裂" the user reported).
    moduleState.bootstrapped = true;
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

    if (type === "fellow.upserted") {
      const fellow = payload?.fellow;
      const key = String(fellow?.key || fellow?.id || "").trim();
      if (!key) return;
      moduleState.fellows = [
        { ...fellow, key },
        ...moduleState.fellows.filter((item) => String(item?.key || item?.id || "") !== key)
      ];
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "fellow.deleted") {
      const fellowId = String(payload?.fellowId || payload?.id || "").trim();
      if (!fellowId) return;
      moduleState.fellows = moduleState.fellows.filter((item) => String(item?.key || item?.id || "") !== fellowId);
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
      run.fellowId = payload.fellowId || run.fellowId || "";
      run.status = "running";
      scheduleCloudRunRender(conversationId);
      return;
    }

    if (type === "cloud_agent_run_event") {
      const conversationId = payload?.conversationId;
      const hermesEvent = payload?.event || {};
      if (!conversationId) return;
      const run = cloudRunFor(conversationId, payload.runId || "");
      run.fellowId = payload.fellowId || run.fellowId || "";
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
      if (cachedMessage.sender_kind === SenderKind.Fellow) {
        clearRunPermissions(moduleState.cloudAgentRunsByConversation.get(conversationId));
        moduleState.cloudAgentRunsByConversation.delete(conversationId);
        renderAgentPermissionBanner();
        // First fellow reply in an untitled conversation → auto-title it.
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
        _appendMessageToActiveChat(message, { stick: isMine });
      }
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "social.conversation_invited") {
      const { conversation } = payload || {};
      if (!conversation) return;
      upsertConversation(conversation);
      // H2: Invalidate member cache so next mention parse refetches newly-added fellows
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
      const entry = moduleState.messageCache.get(conversationId);
      if (entry) {
        entry.messages = entry.messages.filter((m) => m.id !== messageId);
      }
      if (conversationId === moduleState.activeConversationId) _removeMessageFromActiveChat(messageId);
      if (deps && typeof deps.render === "function") deps.render();
      return;
    }

    if (type === "conversation.fellow_invocation_requested") {
      // Main process owns local fellow execution so the same path works in the
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
      preferredConversationIdByFellowKey: moduleState.lastFellowConversationByKey
    }), {
      activeConversationId: moduleState.activeConversationId,
      messageCache: moduleState.messageCache,
      preferredConversationIdByFellowKey: moduleState.lastFellowConversationByKey
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

      // Route on conversations.type (schema truth). Two card shapes only:
      // private-conversation (dm / fellow) and group-conversation. id-prefix fallback
      // keeps the sidebar correct against older cloud deployments that
      // haven't shipped the v7 type column yet — once every server is
      // on schema ≥ v7 the fallback can be removed.
      const conversationType = conversation.type
        || (conversation.id?.startsWith("dm:") ? "dm"
          : conversation.id?.startsWith("fellow:") ? "fellow"
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
          conversation: { ...conversation, type: "group", lastMessagePreview, memberCount }
        };
      }

      const otherUser = conversationType === "dm" ? otherUserForConversation(conversation) : null;
      return {
        type: "private-conversation",
        key: conversation.id,
        pinned,
        pinnedAt,
        updatedAt,
        conversation: { ...conversation, type: conversationType || "dm", otherUser, lastMessagePreview }
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

    // Decide BEFORE rebuilding whether to keep the view pinned to the bottom.
    // Stick when entering a different conversation (show its latest) or when the user is
    // already near the bottom; otherwise restore their prior offset so a
    // background re-render never yanks them out of the history they scrolled to.
    const isConversationSwitch = conversationId !== _lastRenderedConversationId;
    const prevScrollTop = containerEl.scrollTop;
    const stickToBottom = isConversationSwitch
      || (containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight < SCROLL_STICK_THRESHOLD_PX);
    _lastRenderedConversationId = conversationId;
    const applyScroll = () => {
      containerEl.scrollTop = stickToBottom ? containerEl.scrollHeight : prevScrollTop;
    };

    containerEl.innerHTML = "";

    // Header (avatar / name / meta) is painted by app.js render() — this
    // module only owns the message list so the chat header stays in lockstep
    // with the sidebar's group-avatar mosaic for every conversation type.

    const conversationType = conversationTypeFor(conversation, conversationId);
    if (conversation && conversationType === "group") {
      const members = _conversationMembersCache.get(conversationId) || [];
      for (const msg of entry.messages) {
        const article = _buildGroupMessageArticle(msg, color, members);
        if (article) containerEl.appendChild(article);
      }
      const streaming = _buildCloudAgentStreamingArticle(conversationId, color, members);
      if (streaming) containerEl.appendChild(streaming);
      window.miaAvatar?.hydrateAvatarVideos?.(containerEl);
      markRenderedTraceBlocks(containerEl);
      applyScroll();
      if (!_conversationMembersCache.has(conversationId)) {
        _fetchAndCacheConversationMembers(conversationId);
      }
      return;
    }

    // DM and fellow conversations share the 1-on-1 message bubble path.
    for (const msg of entry.messages) {
      const article = _buildMessageArticle(msg, color);
      if (article) containerEl.appendChild(article);
    }
    const streaming = _buildCloudAgentStreamingArticle(conversationId, color);
    if (streaming) containerEl.appendChild(streaming);
    window.miaAvatar?.hydrateAvatarVideos?.(containerEl);
    markRenderedTraceBlocks(containerEl);
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
  // bubble context menu (reply chip + copy). Passes group members so fellow /
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

  // DM bubble mirrors fellow chat's renderMessageHtml shape EXACTLY so the
  // CSS targeting .message > .message-stack > .bubble paints it as a real
  // bubble. The bubble carries data-message-source="cloud-conversation" + a
  // data-message-id so the chat-level contextmenu dispatcher in app.js
  // routes to openSocialMessageMenu instead of the fellow message menu.
  function _buildMessageArticle(msg, accentColor) {
    const spec = _specForMessage(msg);
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
    const bubbleHtml = `<div class="bubble" data-message-index="${messageIndex}" data-message-source="cloud-conversation" data-message-id="${escapeHtml(msg.id || "")}">${skillsHtml}${bodyHtml}</div>`;
    const attachmentHtml = renderAttachmentChips(spec?.attachments || msg.attachments || []);
    const createdAt = msg.created_at || msg.createdAt || "";
    const timeHtml = createdAt
      ? `<time class="message-time" datetime="${escapeHtml(createdAt)}">${escapeHtml(window.miaTimeFormat.formatMessageTime(createdAt))}</time>`
      : "";

    const article = document.createElement("article");
    article.className = `message ${roleClass}`;
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

  function _buildCloudAgentStreamingArticle(conversationId, accentColor, members = []) {
    const run = moduleState.cloudAgentRunsByConversation.get(conversationId);
    // Typing-only state ("running" with no text/reasoning/tools yet) shows in the
    // conversation header instead of a placeholder bubble — see paintHeaderStatus.
    if (!run || (!run.text && !run.reasoning && !run.tools.length)) return null;
    const conversation = moduleState.conversations.find((r) => r.id === conversationId) || { id: conversationId };
    const fellowKey = run.fellowId || sessionHistoryShared().fellowKey(conversation) || "mia";
    const synthetic = {
      id: `cloud-agent-stream-${run.runId || conversationId}`,
      sender_kind: "fellow",
      sender_ref: fellowKey,
      body_md: run.text || "",
      created_at: run.createdAt || new Date().toISOString()
    };
    const spec = _specForMessage(synthetic, members);
    const authorName = spec ? spec.authorName : fellowKey;
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
        attrs: `data-sender-kind="fellow" data-sender-ref="${escapeHtml(fellowKey)}" title="${escapeHtml(authorName || "")}"`
      })
      : `<div class="avatar message-avatar" data-sender-kind="fellow" data-sender-ref="${escapeHtml(fellowKey)}" style="${escapeHtml(avatarFallbackStyle(avatarHelpers, avatar.image, avatar.crop, avatarColor))}" title="${escapeHtml(authorName || "")}">${escapeHtml(avatarLetter)}</div>`;
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
    article.className = "message assistant streaming";
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
  // markup/CSS from fellow chat (chat/message-menu.js translationHtml) so the
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

  function _reRenderActiveChat() {
    const chatEl = document.getElementById("chat");
    if (chatEl && moduleState.activeConversationId) renderConversationChat(chatEl);
    renderAgentPermissionBanner();
  }

  // Remove a single message's bubble from the open chat without a full repaint.
  function _removeMessageFromActiveChat(messageId) {
    const chatEl = document.getElementById("chat");
    if (!chatEl) return;
    const bubble = chatEl.querySelector(`.bubble[data-message-id="${(window.CSS && window.CSS.escape) ? window.CSS.escape(messageId) : messageId}"]`);
    bubble?.closest(".message")?.remove();
  }

  // Translate a cloud-conversation message in place. Mirrors message-menu.translateMessage
  // but stores the result on the cached message and re-renders the conversation.
  async function translateConversationMessage(conversationId, messageId) {
    const entry = moduleState.messageCache.get(conversationId);
    const msg = entry && entry.messages.find((m) => m.id === messageId);
    if (!msg) return;
    const text = String(msg.body_md || msg.bodyMd || "").trim();
    if (!text) return;
    // sendChat needs a fellow to run the utility model on: prefer a fellow
    // member of this conversation, else fall back to the first available persona.
    const runtime = (deps && typeof deps.getState === "function" && deps.getState()?.runtime) || {};
    const fellows = runtime.fellows || runtime.personas || [];
    const { MemberKind } = conversationKinds();
    const conversationFellow = (_conversationMembersCache.get(conversationId) || []).find((m) => m.member_kind === MemberKind.Fellow);
    const fellowKey = (conversationFellow && conversationFellow.member_ref) || (fellows[0] && (fellows[0].key || fellows[0].id)) || "";
    if (!fellowKey) {
      msg.translation = { status: "error", text: "", error: "没有可用于翻译的 fellow。" };
      if (conversationId === moduleState.activeConversationId) _reRenderActiveChat();
      return;
    }
    msg.translation = { status: "loading", text: "", error: "" };
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
        fellowKey,
        sessionId: `utility:translate:${cryptoRandomId()}`,
        utility: true,
        messages: [{ role: "user", content: prompt }]
      });
      const translated = String(response?.choices?.[0]?.message?.content || "").trim();
      msg.translation = translated
        ? { status: "done", text: translated, error: "" }
        : { status: "error", text: "", error: "模型没有返回译文。" };
    } catch (error) {
      msg.translation = { status: "error", text: "", error: `翻译失败: ${error?.message || error}` };
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
    if (entry) entry.messages = entry.messages.filter((m) => m.id !== messageId);
    if (conversationId === moduleState.activeConversationId) _removeMessageFromActiveChat(messageId);
    if (deps && typeof deps.render === "function") deps.render();
    let ok = false;
    try {
      const res = await window.mia.social.deleteConversationMessage(conversationId, messageId);
      ok = Boolean(res && res.ok !== false);
      if (!ok) console.warn("[social] deleteConversationMessage failed:", res?.error || "unknown");
    } catch (err) {
      console.warn("[social] deleteConversationMessage error:", err?.message || err);
    }
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
    const article = conversationType === "group"
      ? _buildGroupMessageArticle(msg, color, _conversationMembersCache.get(moduleState.activeConversationId) || [])
      : _buildMessageArticle(msg, color);
    if (article) {
      chatEl.appendChild(article);
      window.miaAvatar?.hydrateAvatarVideos?.(article);
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

  // Lightweight re-fetch of friend-request state (username + incoming +
  // outgoing) for the add-friend dialog. We call this on every dialog open
  // so users always see the latest server state even when the WS lost
  // events or bootstrapAfterLogin never ran (e.g., cloud login happened in
  // a previous app lifetime and the renderer never got a "loggedIn" tick).
  async function refreshFriendRequestState() {
    if (!window.mia || !window.mia.social) return false;
    const api = window.mia.social;
    try {
      const [meRes, incomingRes, outgoingRes] = await Promise.all([
        api.myUsername(),
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
    card.className = "skill-preview-card";
    card.style.cssText = "width:min(440px,calc(100vw - 68px)); height:auto; max-height:80vh; overflow-y:auto;";

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

    // My username row
    const meSection = document.createElement("section");
    meSection.className = "group-create-section";
    const myUsernameDisplay = escapeHtml(moduleState.myUsername || "—");
    meSection.innerHTML = `
      <div class="group-create-section-header">
        <span class="group-create-section-title">我的用户名</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px; padding:6px 0;">
        <span id="socialMyUsernameLabel" style="font-weight:600;">${myUsernameDisplay}</span>
        <button type="button" class="button-soft" id="socialCopyUsername" style="font-size:12px; padding:3px 8px;">复制</button>
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
      <div style="display:flex; gap:8px; margin-top:6px;">
        <input id="socialAddUsernameInput" class="group-create-input" type="text" placeholder="对方的用户名" style="flex:1;">
        <button type="button" class="button-primary" id="socialSendRequestBtn">发送</button>
      </div>
      <p id="socialSendError" style="color:#ff3b30; font-size:13px; margin-top:4px; min-height:18px;"></p>
    `;
    body.appendChild(sendSection);

    // Incoming requests
    const incomingSection = document.createElement("section");
    incomingSection.className = "group-create-section";
    incomingSection.innerHTML = `<div class="group-create-section-header"><span class="group-create-section-title">收到的好友请求</span></div>`;
    const incomingList = document.createElement("div");
    incomingList.id = "socialIncomingList";
    _renderRequestList(incomingList, moduleState.incomingRequests, "incoming", modal);
    incomingSection.appendChild(incomingList);
    body.appendChild(incomingSection);

    // Outgoing requests
    const outgoingSection = document.createElement("section");
    outgoingSection.className = "group-create-section";
    outgoingSection.innerHTML = `<div class="group-create-section-header"><span class="group-create-section-title">我发出的请求</span></div>`;
    const outgoingList = document.createElement("div");
    outgoingList.id = "socialOutgoingList";
    _renderRequestList(outgoingList, moduleState.outgoingRequests, "outgoing", modal);
    outgoingSection.appendChild(outgoingList);
    body.appendChild(outgoingSection);

    card.appendChild(body);
    modal.appendChild(card);

    // Wire copy button
    card.querySelector("#socialCopyUsername")?.addEventListener("click", () => {
      try { navigator.clipboard.writeText(moduleState.myUsername || ""); } catch { /* ignore */ }
      const btn = card.querySelector("#socialCopyUsername");
      if (btn) { btn.textContent = "已复制"; setTimeout(() => { btn.textContent = "复制"; }, 1500); }
    });

    // Wire send button
    const sendBtn = card.querySelector("#socialSendRequestBtn");
    const usernameInput = card.querySelector("#socialAddUsernameInput");
    const errorEl = card.querySelector("#socialSendError");
    sendBtn?.addEventListener("click", async () => {
      const username = (usernameInput?.value || "").trim();
      if (!username) { if (errorEl) errorEl.textContent = "请输入用户名"; return; }
      if (errorEl) errorEl.textContent = "";
      sendBtn.disabled = true;
      try {
        const res = await window.mia.social.sendFriendRequest(username);
        if (!res.ok) {
          if (errorEl) errorEl.textContent = res.error || "发送失败";
          return;
        }
        if (usernameInput) usernameInput.value = "";
        // Refresh outgoing list
        const outRes = await window.mia.social.listFriendRequests("outgoing");
        if (outRes.ok) moduleState.outgoingRequests = outRes.data?.requests || [];
        // Re-render modal sections
        const oList = card.querySelector("#socialOutgoingList");
        if (oList) _renderRequestList(oList, moduleState.outgoingRequests, "outgoing", modal);
      } catch (err) {
        if (errorEl) errorEl.textContent = String(err && err.message ? err.message : err);
      } finally {
        sendBtn.disabled = false;
      }
    });
  }

  function _renderRequestList(container, requests, direction, modal) {
    container.innerHTML = "";
    if (!requests.length) {
      const empty = document.createElement("p");
      empty.style.cssText = "color:var(--fg-muted,#888); font-size:13px; margin:6px 0;";
      empty.textContent = direction === "incoming" ? "暂无收到的请求" : "暂无发出的请求";
      container.appendChild(empty);
      return;
    }
    for (const req of requests) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border,rgba(0,0,0,.08));";

      // Cloud REST hydrates the request with `other` (the user on the
      // opposite end). Live WS events use `from` instead — accept either.
      const otherUser = req.other || req.from || {};
      const fallbackId = direction === "incoming" ? req.from_user : req.to_user;
      const displayName = escapeHtml(
        otherUser.username || otherUser.account || fallbackId || "—"
      );

      const avatar = document.createElement("span");
      avatar.className = "avatar request-avatar";
      window.miaAvatar.applyAvatarMedia(
        avatar,
        otherUser.avatarImage,
        otherUser.avatarCrop,
        otherUser.avatarColor || window.miaMemberColor.memberAccentColor(otherUser.id || fallbackId || displayName),
        (otherUser.username || otherUser.account || fallbackId || "?").slice(0, 1).toUpperCase()
      );
      row.appendChild(avatar);

      const nameSpan = document.createElement("span");
      nameSpan.style.cssText = "flex:1; font-weight:500;";
      nameSpan.innerHTML = displayName;
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

  // ── Cloud-conversation send: DM, fellow conversations, and groups share one path. ─────────

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
        const res = await api.listConversationMessages(conversationId, sinceSeq, 100);
        if (res?.ok) {
          const fresh = (res.data?.messages || []).map((m) => messageWithFallbackRunTrace(conversationId, m));
          if (fresh.length) {
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

  function setActiveConversationId(id) {
    const next = id || null;
    // Re-selecting the already-active conversation has no observable effect but
    // would otherwise re-write localStorage, re-POST a read mark, and re-trigger
    // _ensureConversationMessages. Drop those redundant side effects up front.
    if (next === moduleState.activeConversationId) return;
    // Any actual navigation (switching conversations, or leaving to a local fellow chat
    // that reuses #chat) invalidates the last-painted marker, so the next
    // renderConversationChat treats re-entry as a switch and lands at the latest message
    // instead of restoring a stale offset.
    _lastRenderedConversationId = null;
    moduleState.activeConversationId = next;
    if (id) {
      writeLastActiveConversationId(id);
      rememberFellowConversation(id);
      markConversationRead(id);
      // Fire-and-forget: keep the click snappy; cache paint + delta sync re-render async.
      _ensureConversationMessages(id);
    }
    renderAgentPermissionBanner();
  }

  function rememberFellowConversation(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) return;
    const conversation = moduleState.conversations.find((row) => row.id === id) || { id };
    if (sessionHistoryShared().conversationType(conversation, id) !== "fellow") return;
    const key = sessionHistoryShared().fellowKey(conversation);
    if (!key) return;
    moduleState.lastFellowConversationByKey = {
      ...(moduleState.lastFellowConversationByKey || {}),
      [key]: id
    };
    writeLastFellowConversationByKey(moduleState.lastFellowConversationByKey);
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

  function markConversationRead(conversationId) {
    if (!conversationId) return;
    moduleState.unreadByConversation.delete(conversationId);
    const cache = moduleState.messageCache.get(conversationId);
    const lastSeq = cache && Number.isFinite(Number(cache.maxSeq)) ? Number(cache.maxSeq) : 0;
    const s = _ensureCloudSettings();
    const nextReadMarks = { ...(s.readMarks || {}), [conversationId]: lastSeq };
    // Clear any manual "标为未读" override so the badge actually goes away.
    const nextOverrides = { ...(s.unreadOverrides || {}) };
    delete nextOverrides[conversationId];
    moduleState.cloudSettings = { ...s, readMarks: nextReadMarks, unreadOverrides: nextOverrides };
    window.mia?.social?.settingsPut?.({
      pins: s.pins,
      readMarks: nextReadMarks,
      appearance: s.appearance,
      mutedConversations: s.mutedConversations || [],
      unreadOverrides: nextOverrides,
      expectedVersion: s.version || 0
    }).catch((err) => console.warn("[social] mark-read settingsPut failed:", err?.message || err));
  }

  // Phase 3: pin state lives in cloud user_settings (server-canonical).
  // Renderer holds a cached copy in moduleState.cloudSettings; it's
  // populated by bootstrapCloudSettings() at login and refreshed on each
  // user_settings.updated WS event. Mutations PUT via IPC and the
  // broadcast confirms / replaces the optimistic update.
  function normalizeCloudSettings(settings, previous = {}) {
    const input = settings && typeof settings === "object" ? settings : {};
    const prior = previous && typeof previous === "object" ? previous : {};
    return {
      ...input,
      pins: Array.isArray(input.pins) ? input.pins : [],
      readMarks: input.readMarks && typeof input.readMarks === "object" ? input.readMarks : {},
      appearance: input.appearance && typeof input.appearance === "object" ? input.appearance : {},
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
  async function _patchCloudSettings({ pinned, muted, manualUnread, conversationId, _retried }) {
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
      appearance: s.appearance || {}
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
        expectedVersion: s.version || 0
      });
      if (updated && typeof updated === "object") moduleState.cloudSettings = normalizeCloudSettings(updated, moduleState.cloudSettings || s);
    } catch (err) {
      if (!_retried && /409|version conflict/i.test(String(err?.message || ""))) {
        await bootstrapCloudSettings();
        return _patchCloudSettings({ pinned, muted, manualUnread, conversationId, _retried: true });
      }
      console.warn("[social] settingsPut failed:", err?.message || err);
      moduleState.cloudSettings = s;
      if (deps && typeof deps.render === "function") deps.render();
    }
  }

  async function bootstrapCloudSettings() {
    try {
      const settings = await window.mia.social.settingsGet();
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
  // avatar for cloud group conversations via the same path as local fellow groups.
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
    syncLocalFellowRuntimeBindings,
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
    fellowConversationForKey,
    setActiveConversationId,
    markConversationRead,
    isConversationPinned,
    setConversationPinned,
    isConversationMuted,
    setConversationMuted,
    isConversationManuallyUnread,
    setConversationManuallyUnread,
    applyCloudSettings,
    ensureFellowConversation,
    upsertFellowConversation,
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
