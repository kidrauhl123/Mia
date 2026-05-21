const STORAGE_KEY = "aimashi.web.session";
const API_BASE = "";
const MAX_UPLOAD_BYTES = 18 * 1024 * 1024;
const ALLOWED_UPLOAD_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${value} B`;
}

const els = {
  root: document.querySelector(".app-shell"),
  mainView: document.getElementById("mainView"),
  loginForm: document.getElementById("loginForm"),
  usernameInput: document.getElementById("usernameInput"),
  passwordInput: document.getElementById("passwordInput"),
  registerButton: document.getElementById("registerButton"),
  loginHint: document.getElementById("loginHint"),
  conversationSearch: document.getElementById("conversationSearch"),
  conversationList: document.getElementById("conversationList"),
  newConversation: document.getElementById("newConversation"),
  activeAvatar: document.getElementById("activeAvatar"),
  activeTitle: document.getElementById("activeTitle"),
  activeMeta: document.getElementById("activeMeta"),
  chat: document.getElementById("chat"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  attachButton: document.getElementById("attachButton"),
  sendButton: document.getElementById("sendButton"),
  fileInput: document.getElementById("fileInput"),
  attachmentTray: document.getElementById("attachmentTray"),
  syncButton: document.getElementById("syncButton"),
  statusText: document.getElementById("statusText"),
  logoutButton: document.getElementById("logoutButton"),
  themeToggle: document.getElementById("themeToggle"),
  mobileBack: document.getElementById("mobileBack"),
  unreadCount: document.getElementById("unreadCount"),
  railButtons: Array.from(document.querySelectorAll(".rail-button[data-view]")),
  chatLayout: document.querySelector(".chat-layout"),
  utilityView: document.getElementById("utilityView"),
  toast: document.getElementById("toast")
};

const avatarA = "./assets/avatar-01.png";
const avatarB = "./assets/avatar-08.png";
const transparentPixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

let state = {
  token: "",
  user: null,
  theme: "light",
  activeView: "chat",
  activeConversationId: "",
  activeUtilityId: "",
  pendingAttachments: [],
  bridgeDevices: [],
  selectedBridgeDeviceId: "",
  isSending: false,
  activeBridgeRun: null,
  activeBridgeStreamText: "",
  workspace: {
    revision: 0,
    conversations: [],
    contacts: [],
    skills: [],
    workbench: []
  }
};

let bridgePollTimer = 0;
let eventsSocket = null;
let eventsReconnectTimer = 0;
const fileUrlCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function shortTime(value) {
  const date = value ? new Date(value) : new Date();
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function loadSession() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "");
    if (parsed?.token) {
      state.token = parsed.token;
      state.user = parsed.user || null;
      state.theme = parsed.theme || "light";
    }
  } catch {
    // Ignore corrupt session.
  }
}

function saveSession() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    token: state.token,
    user: state.user,
    theme: state.theme
  }));
}

function clearSession() {
  state.token = "";
  state.user = null;
  state.bridgeDevices = [];
  state.selectedBridgeDeviceId = "";
  clearFileUrlCache();
  stopCloudEvents();
  localStorage.removeItem(STORAGE_KEY);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function applyWorkspace(workspace) {
  state.workspace = {
    revision: Number(workspace?.revision || 0),
    conversations: Array.isArray(workspace?.conversations) ? workspace.conversations : [],
    contacts: Array.isArray(workspace?.contacts) ? workspace.contacts : [],
    skills: Array.isArray(workspace?.skills) ? workspace.skills : [],
    workbench: Array.isArray(workspace?.workbench) ? workspace.workbench : []
  };
  if (!state.activeConversationId || !state.workspace.conversations.some((item) => item.id === state.activeConversationId)) {
    state.activeConversationId = state.workspace.conversations[0]?.id || "";
  }
}

async function saveWorkspace() {
  if (!state.token) return;
  setSyncState("同步中", false);
  const { workspace } = await api("/api/workspace", {
    method: "PUT",
    body: { workspace: state.workspace }
  });
  applyWorkspace(workspace);
  setSyncState("已同步", true);
}

function setSyncState(text, ready) {
  els.syncButton.textContent = text;
  els.syncButton.classList.toggle("ready", Boolean(ready));
}

function activeConversation() {
  return state.workspace.conversations.find((item) => item.id === state.activeConversationId) || state.workspace.conversations[0];
}

function lastMessage(conversation) {
  return conversation?.messages?.[conversation.messages.length - 1] || null;
}

function setAuthView() {
  els.root.dataset.auth = state.token ? "signed-in" : "signed-out";
  els.mainView.dataset.view = state.activeView || "chat";
  if (!els.mainView.dataset.pane) els.mainView.dataset.pane = "list";
  document.documentElement.dataset.theme = state.theme || "light";
  els.railButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === (state.activeView || "chat"));
  });
}

function renderConversationList() {
  const query = String(els.conversationSearch.value || "").trim().toLowerCase();
  const items = [...state.workspace.conversations]
    .filter((conversation) => !query || conversation.title.toLowerCase().includes(query) || conversation.meta.toLowerCase().includes(query))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  els.conversationList.innerHTML = items.map((conversation) => {
    const latest = lastMessage(conversation);
    const preview = latest?.attachments?.length
      ? latest.attachments.some((attachment) => attachment.type === "image") ? "[图片]" : "[附件]"
      : latest?.text || "新对话";
    return `
      <button class="persona ${conversation.id === state.activeConversationId ? "active" : ""}" type="button" data-conversation-id="${escapeHtml(conversation.id)}">
        <span class="avatar" style="background-image:url('${escapeHtml(conversation.avatar || avatarA)}')"></span>
        <span class="persona-main">
          <strong class="persona-name">${escapeHtml(conversation.title)}</strong>
          <span class="persona-preview">${escapeHtml(preview)}</span>
        </span>
        <span class="persona-side">
          <span class="persona-time">${escapeHtml(shortTime(conversation.updatedAt))}</span>
          ${conversation.unread ? `<span class="persona-unread">${conversation.unread}</span>` : ""}
        </span>
      </button>
    `;
  }).join("");
  if (!items.length) {
    els.conversationList.innerHTML = `<p class="persona-empty">没有匹配的会话。</p>`;
  }
  const unread = state.workspace.conversations.reduce((sum, conversation) => sum + Number(conversation.unread || 0), 0);
  els.unreadCount.textContent = String(unread);
  els.unreadCount.hidden = unread <= 0;
}

function utilityItemsForView(view) {
  if (view === "contacts") return state.workspace.contacts || [];
  if (view === "skills") return state.workspace.skills || [];
  if (view === "workbench") return state.workspace.workbench || [];
  return [];
}

function utilityViewName(view) {
  if (view === "contacts") return "联系人";
  if (view === "skills") return "能力库";
  if (view === "workbench") return "工作台";
  return "消息";
}

function renderUtilityList() {
  const view = state.activeView || "chat";
  const query = String(els.conversationSearch.value || "").trim().toLowerCase();
  const items = utilityItemsForView(view).filter((item) => !query || item.title.toLowerCase().includes(query) || item.meta.toLowerCase().includes(query));
  if (!state.activeUtilityId && items[0]) state.activeUtilityId = items[0].id;
  els.conversationList.innerHTML = items.map((item) => `
    <button class="persona ${item.id === state.activeUtilityId ? "active" : ""}" type="button" data-utility-id="${escapeHtml(item.id)}">
      <span class="avatar utility-avatar">${escapeHtml(item.icon || "")}</span>
      <span class="persona-main">
        <strong class="persona-name">${escapeHtml(item.title)}</strong>
        <span class="persona-preview">${escapeHtml(item.meta)}</span>
      </span>
      <span class="persona-side"><span class="persona-time">${escapeHtml(item.status || "")}</span></span>
    </button>
  `).join("");
}

function bridgeStatusText() {
  const device = activeBridgeDevice();
  if (device) return `${device.deviceName} · ${device.engine} 在线`;
  return "本机 Agent Bridge 离线";
}

function activeBridgeDevice() {
  if (!state.bridgeDevices.length) return null;
  return state.bridgeDevices.find((device) => device.id === state.selectedBridgeDeviceId) || state.bridgeDevices[0];
}

function renderBridgeStatus() {
  if (!els.statusText) return;
  const device = activeBridgeDevice();
  els.statusText.textContent = device ? bridgeStatusText() : "本机 Agent Bridge 离线";
  els.statusText.classList.toggle("online", Boolean(device));
}

function bridgeDeviceListHtml() {
  if (!state.bridgeDevices.length) {
    return `<p class="bridge-panel-copy">暂无在线设备。在桌面端登录同一个 Aimashi Cloud 账号后会自动出现。</p>`;
  }
  return `
    <div class="bridge-device-list" role="list" aria-label="在线设备">
      ${state.bridgeDevices.map((device) => {
        const selected = device.id === activeBridgeDevice()?.id;
        const capabilities = device.capabilities && typeof device.capabilities === "object" ? device.capabilities : {};
        const detail = [
          device.engine || "agent",
          capabilities.generatedImages ? "图片" : "",
          capabilities.streaming ? "流式" : ""
        ].filter(Boolean).join(" · ");
        return `
          <button class="bridge-device${selected ? " selected" : ""}" type="button" role="listitem" data-bridge-device="${escapeHtml(device.id)}" aria-pressed="${selected ? "true" : "false"}">
            <strong>${escapeHtml(device.deviceName || "本机 Agent")}</strong>
            <span>${escapeHtml(detail || "在线")}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderSidebar() {
  const isChat = (state.activeView || "chat") === "chat";
  els.conversationSearch.placeholder = isChat ? "搜索" : `搜索${utilityViewName(state.activeView)}`;
  els.newConversation.textContent = isChat ? "＋" : "·";
  els.newConversation.title = isChat ? "新对话" : utilityViewName(state.activeView);
  els.newConversation.disabled = !isChat;
  if (isChat) renderConversationList();
  else renderUtilityList();
}

function renderAttachment(attachment) {
  const url = absoluteFileUrl(attachment.url || "");
  if (attachment.type === "image") {
    const authFile = authenticatedFilePath(url);
    const previewUrl = authFile ? fileUrlCache.get(authFile) || transparentPixel : url;
    return `
      <button class="message-attachment image" type="button" data-preview-src="${escapeHtml(previewUrl)}"${authFile ? ` data-auth-file-url="${escapeHtml(authFile)}"` : ""} aria-label="预览图片">
        <img class="message-attachment-thumb" src="${escapeHtml(previewUrl)}"${authFile ? ` data-auth-file-url="${escapeHtml(authFile)}"` : ""} alt="${escapeHtml(attachment.name || "图片")}">
      </button>
    `;
  }
  return `
    <a class="message-attachment" href="${escapeHtml(url || "#")}" target="_blank" rel="noreferrer">
      <span>FILE</span>
      <strong>${escapeHtml(attachment.name || "附件")}</strong>
    </a>
  `;
}

function absoluteFileUrl(url) {
  if (!url) return "";
  if (url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://") || url.startsWith("./")) return url;
  return `${API_BASE}${url}`;
}

function authenticatedFilePath(url) {
  if (!url || !state.token) return "";
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.origin !== window.location.origin) return "";
    return parsed.pathname.startsWith("/api/files/") ? `${parsed.pathname}${parsed.search}` : "";
  } catch {
    return url.startsWith("/api/files/") ? url : "";
  }
}

function clearFileUrlCache() {
  for (const blobUrl of fileUrlCache.values()) URL.revokeObjectURL(blobUrl);
  fileUrlCache.clear();
}

async function authenticatedBlobUrl(filePath) {
  if (!filePath) return "";
  const cached = fileUrlCache.get(filePath);
  if (cached) return cached;
  const response = await fetch(`${API_BASE}${filePath}`, {
    headers: { Authorization: `Bearer ${state.token}` }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blobUrl = URL.createObjectURL(await response.blob());
  fileUrlCache.set(filePath, blobUrl);
  return blobUrl;
}

function hydrateAuthenticatedAttachments(root = document) {
  root.querySelectorAll("[data-auth-file-url]").forEach((node) => {
    const filePath = node.dataset.authFileUrl || "";
    authenticatedBlobUrl(filePath)
      .then((blobUrl) => {
        if (node instanceof HTMLImageElement) node.src = blobUrl;
        else node.dataset.previewSrc = blobUrl;
      })
      .catch(() => {
        if (!(node instanceof HTMLImageElement)) node.dataset.previewSrc = "";
      });
  });
}

function renderMessage(message, conversation) {
  const avatar = message.role === "user" ? avatarB : conversation.avatar || avatarA;
  const attachmentHtml = message.attachments?.length
    ? `<div class="message-attachments">${message.attachments.map(renderAttachment).join("")}</div>`
    : "";
  const textHtml = message.text ? `<div class="bubble">${escapeHtml(message.text).replace(/\n/g, "<br>")}</div>` : "";
  return `
    <article class="message ${escapeHtml(message.role)}">
      <span class="avatar" style="background-image:url('${escapeHtml(avatar)}')"></span>
      <div class="message-stack">
        ${textHtml}
        ${attachmentHtml}
        <span class="message-time">${escapeHtml(shortTime(message.createdAt))}</span>
      </div>
    </article>
  `;
}

function renderChat() {
  const conversation = activeConversation();
  els.chatLayout.classList.remove("hidden");
  els.utilityView.classList.add("hidden");
  if (!conversation) {
    els.chat.innerHTML = `<p class="persona-empty">还没有会话，点击左上角 + 新建。</p>`;
    return;
  }
  conversation.unread = 0;
  els.activeAvatar.classList.remove("utility-avatar");
  els.activeAvatar.textContent = "";
  els.activeAvatar.style.backgroundImage = `url('${conversation.avatar || avatarA}')`;
  els.activeTitle.textContent = conversation.title;
  els.activeMeta.textContent = conversation.meta;
  els.chat.innerHTML = (conversation.messages || []).map((message) => renderMessage(message, conversation)).join("");
  hydrateAuthenticatedAttachments(els.chat);
  els.chat.scrollTop = els.chat.scrollHeight;
  setSyncState("已同步", true);
  renderSidebar();
}

function renderUtilityView() {
  const view = state.activeView || "chat";
  const items = utilityItemsForView(view);
  const selected = items.find((item) => item.id === state.activeUtilityId) || items[0];
  if (!selected) return;
  state.activeUtilityId = selected.id;
  els.chatLayout.classList.add("hidden");
  els.utilityView.classList.remove("hidden");
  els.activeAvatar.style.backgroundImage = "";
  els.activeAvatar.textContent = selected.icon || selected.title.slice(0, 1);
  els.activeAvatar.classList.add("utility-avatar");
  els.activeTitle.textContent = selected.title;
  els.activeMeta.textContent = `${utilityViewName(view)} · ${selected.status || "已同步"}`;
  els.utilityView.innerHTML = utilityPanelHtml(view, selected);
  renderSidebar();
}

function utilityPanelHtml(view, selected) {
  if (view === "contacts") {
    return `
      <div class="utility-shell">
        <section class="profile-panel">
          <span class="avatar profile-large" style="background-image:url('${escapeHtml(selected.avatar || avatarA)}')"></span>
          <div><h2>${escapeHtml(selected.title)}</h2><p>${escapeHtml(selected.note || selected.meta)}</p></div>
          <button class="utility-action" type="button" data-start-chat="${escapeHtml(selected.id)}">发起对话</button>
        </section>
        <section class="utility-grid">
          <article><strong>状态</strong><span>${escapeHtml(selected.status || "可用")}</span></article>
          <article><strong>同步</strong><span>跨 Web / Desktop / PWA</span></article>
          <article><strong>权限</strong><span>Ask</span></article>
        </section>
      </div>
    `;
  }
  if (view === "skills") {
    return `
      <div class="utility-shell">
        <section class="utility-hero"><h2>${escapeHtml(selected.title)}</h2><p>${escapeHtml(selected.meta)}</p><button class="utility-action" type="button" data-toast="能力配置入口会随 Agent 网关一起开放。">配置能力</button></section>
        <section class="utility-grid">${(state.workspace.skills || []).map((skill) => `<article><strong>${escapeHtml(skill.title)}</strong><span>${escapeHtml(skill.status)}</span></article>`).join("")}</section>
      </div>
    `;
  }
  return `
    <div class="utility-shell">
      <section class="utility-hero"><h2>${escapeHtml(selected.title)}</h2><p>${escapeHtml(selected.meta)}</p><button class="utility-action" type="button" data-toast="工作台会从聊天、任务和 Agent 运行记录中自动生成。">查看进度</button></section>
      <section class="bridge-panel">
        <div>
          <h2>本机 Agent Bridge</h2>
          <p>${escapeHtml(bridgeStatusText())}</p>
        </div>
        ${bridgeDeviceListHtml()}
        <p class="bridge-panel-copy">在桌面端登录同一个 Aimashi Cloud 账号后，这台电脑会自动上线。</p>
      </section>
      <section class="timeline-list">${(state.workspace.workbench || []).map((task) => `<article><span></span><div><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.meta)}</p></div><em>${escapeHtml(task.status)}</em></article>`).join("")}</section>
    </div>
  `;
}

function renderPendingAttachments() {
  if (!state.pendingAttachments.length) {
    els.attachmentTray.classList.add("hidden");
    els.attachmentTray.innerHTML = "";
    return;
  }
  els.attachmentTray.classList.remove("hidden");
  els.attachmentTray.innerHTML = state.pendingAttachments.map((attachment) => `
    <span class="composer-attachment" data-pending-id="${escapeHtml(attachment.id)}">
      <img src="${escapeHtml(attachment.localUrl)}" alt="">
      <span><strong>${escapeHtml(attachment.name)}</strong><em>${escapeHtml(attachment.status || formatBytes(attachment.size))}</em></span>
      <button type="button" aria-label="移除附件">×</button>
    </span>
  `).join("");
}

function render() {
  setAuthView();
  if (!state.token) return;
  if ((state.activeView || "chat") === "chat") renderChat();
  else renderUtilityView();
  renderPendingAttachments();
  renderBridgeStatus();
}

async function pushMessage(role, text, attachments = []) {
  let conversation = activeConversation();
  if (!conversation) {
    conversation = createConversation("Aimashi", "Aimashi Cloud · 已同步", avatarA);
    await saveWorkspace();
  }
  const data = await api("/api/messages", {
    method: "POST",
    body: {
      conversationId: conversation.id,
      role,
      text,
      attachments
    }
  });
  applyWorkspace(data.workspace);
  state.activeConversationId = data.workspace?.activeConversationId || conversation.id;
  renderChat();
}

function createConversation(title, meta, avatar) {
  const conversation = {
    id: id("conv"),
    title,
    meta,
    avatar,
    updatedAt: nowIso(),
    unread: 0,
    messages: []
  };
  state.workspace.conversations.unshift(conversation);
  return conversation;
}

function appendTyping() {
  const conversation = activeConversation();
  const label = state.activeBridgeRun?.status === "pending"
    ? `本机 Agent 运行中 · ${state.activeBridgeRun.deviceName || activeBridgeDevice()?.deviceName || ""}`
    : "正在思考";
  const node = document.createElement("article");
  node.className = "message assistant";
  node.dataset.typing = "true";
  node.innerHTML = `
    <span class="avatar" style="background-image:url('${escapeHtml(conversation?.avatar || avatarA)}')"></span>
    <div class="message-stack"><div class="bubble"><span class="typing-status">${escapeHtml(label.trim())}<span class="typing-dots"><i></i><i></i><i></i></span></span></div></div>
  `;
  els.chat.appendChild(node);
  els.chat.scrollTop = els.chat.scrollHeight;
}

function updateTypingStatus(text) {
  const node = els.chat.querySelector("[data-typing='true'] .typing-status");
  if (!node) return;
  node.innerHTML = `${escapeHtml(text)}<span class="typing-dots"><i></i><i></i><i></i></span>`;
}

function updateTypingContent(text) {
  const node = els.chat.querySelector("[data-typing='true'] .bubble");
  if (!node) return;
  const content = String(text || "").trim();
  if (!content) {
    updateTypingStatus("本机 Agent 运行中");
    return;
  }
  node.innerHTML = `
    <div class="streaming-text">${escapeHtml(content)}</div>
    <span class="typing-status">本机 Agent 继续生成中<span class="typing-dots"><i></i><i></i><i></i></span></span>
  `;
  els.chat.scrollTop = els.chat.scrollHeight;
}

async function refreshBridgeDevices({ silent = true } = {}) {
  if (!state.token) return;
  try {
    const data = await api("/api/bridge/devices");
    state.bridgeDevices = Array.isArray(data.devices) ? data.devices : [];
    if (!state.bridgeDevices.some((device) => device.id === state.selectedBridgeDeviceId)) {
      state.selectedBridgeDeviceId = state.bridgeDevices[0]?.id || "";
    }
    renderBridgeStatus();
    if (!silent) showToast(state.bridgeDevices.length ? "本机 Bridge 已在线。" : "未检测到在线 Bridge。");
  } catch (error) {
    state.bridgeDevices = [];
    renderBridgeStatus();
    if (!silent) showToast(error.message);
  }
}

function startBridgePolling() {
  window.clearInterval(bridgePollTimer);
  if (!state.token) return;
  refreshBridgeDevices({ silent: true });
  bridgePollTimer = window.setInterval(() => refreshBridgeDevices({ silent: true }), 15000);
}

function stopBridgePolling() {
  window.clearInterval(bridgePollTimer);
  bridgePollTimer = 0;
}

function eventsUrl() {
  const url = new URL(`${API_BASE || ""}/api/events`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function scheduleEventsReconnect() {
  window.clearTimeout(eventsReconnectTimer);
  if (!state.token) return;
  eventsReconnectTimer = window.setTimeout(() => startCloudEvents(), 2500);
}

function stopCloudEvents() {
  window.clearTimeout(eventsReconnectTimer);
  eventsReconnectTimer = 0;
  const socket = eventsSocket;
  eventsSocket = null;
  if (socket && socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED) socket.close();
}

function applyEventWorkspace(workspace) {
  if (!workspace) return;
  applyWorkspace(workspace);
  render();
}

function startCloudEvents() {
  if (!state.token || eventsSocket?.readyState === WebSocket.OPEN || eventsSocket?.readyState === WebSocket.CONNECTING) return;
  const socket = new WebSocket(eventsUrl(), [`aimashi-token.${state.token}`]);
  eventsSocket = socket;
  socket.addEventListener("open", () => setSyncState("实时同步", true));
  socket.addEventListener("message", (event) => {
    let message = null;
    try {
      message = JSON.parse(String(event.data || ""));
    } catch {
      return;
    }
    if (message.type === "events_ready") {
      setSyncState("实时同步", true);
      return;
    }
    if (message.type === "workspace_updated" || message.type === "message_created") {
      applyEventWorkspace(message.workspace);
      return;
    }
    if (message.type === "device_updated") {
      state.bridgeDevices = Array.isArray(message.devices) ? message.devices : [];
      if (!state.bridgeDevices.some((device) => device.id === state.selectedBridgeDeviceId)) {
        state.selectedBridgeDeviceId = state.bridgeDevices[0]?.id || "";
      }
      renderBridgeStatus();
      return;
    }
    if (message.type === "bridge_run_updated" && message.run) {
      state.activeBridgeRun = message.run;
      if (message.run.status === "pending" || message.run.status === "running") {
        updateTypingStatus(`本机 Agent 运行中 · ${activeBridgeDevice()?.deviceName || "Bridge"}`);
      } else if (message.run.status === "succeeded") {
        updateTypingStatus("本机 Agent 已完成");
        state.activeBridgeStreamText = "";
      } else if (message.run.status === "cancelled") {
        els.chat.querySelector("[data-typing='true']")?.remove();
        state.activeBridgeStreamText = "";
        showToast("本机 Agent 运行已取消。");
      } else if (message.run.status === "failed") {
        els.chat.querySelector("[data-typing='true']")?.remove();
        state.activeBridgeStreamText = "";
        showToast(message.run.error || "本机 Agent 执行失败。");
      } else if (message.run.status === "timed_out") {
        els.chat.querySelector("[data-typing='true']")?.remove();
        state.activeBridgeStreamText = "";
        showToast(message.run.error || "本机 Agent 响应超时。");
      }
    }
    if (message.type === "bridge_run_event" && message.runId === state.activeBridgeRun?.id && message.event) {
      const event = message.event;
      if (event.kind === "text_delta") {
        state.activeBridgeStreamText += String(event.text || "");
        updateTypingContent(state.activeBridgeStreamText);
      } else if (event.kind === "status" && event.text) {
        updateTypingStatus(event.text);
      } else if (event.kind === "tool_call_started") {
        updateTypingStatus(`本机 Agent 正在执行：${event.preview || event.name || "工具"}`);
      } else if (event.kind === "tool_call_completed") {
        updateTypingStatus("本机 Agent 工具执行完成，继续生成中");
      }
    }
  });
  socket.addEventListener("close", () => {
    if (eventsSocket === socket) eventsSocket = null;
    scheduleEventsReconnect();
  });
  socket.addEventListener("error", () => {
    if (eventsSocket === socket) eventsSocket = null;
    try {
      socket.close();
    } catch {
      scheduleEventsReconnect();
    }
  });
}

function setSending(isSending) {
  state.isSending = isSending;
  els.sendButton.disabled = false;
  els.sendButton.textContent = isSending ? "×" : "↗";
  els.sendButton.title = isSending ? "取消运行" : "发送";
  els.chatInput.disabled = isSending;
}

async function cancelActiveBridgeRun() {
  const runId = state.activeBridgeRun?.id || "";
  if (!runId) {
    showToast("正在等待本机 Agent 接收任务。");
    return;
  }
  await api(`/api/bridge/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    body: {}
  });
}

async function requestBridgeReply(text, attachments) {
  const device = activeBridgeDevice();
  if (!device) {
    showToast("本机 Agent Bridge 未连接。请在桌面端登录同一账号。");
    return;
  }
  state.activeBridgeRun = null;
  state.activeBridgeStreamText = "";
  appendTyping();
  try {
    const data = await api("/api/bridge/run", {
      method: "POST",
      body: {
        deviceId: device.id,
        conversationId: state.activeConversationId,
        text,
        attachments
      }
    });
    els.chat.querySelector("[data-typing='true']")?.remove();
    state.activeBridgeRun = null;
    state.activeBridgeStreamText = "";
    applyWorkspace(data.workspace);
    render();
  } catch (error) {
    els.chat.querySelector("[data-typing='true']")?.remove();
    state.activeBridgeRun = null;
    state.activeBridgeStreamText = "";
    showToast(error.message);
  }
}

let toastTimer = 0;

function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  toastTimer = window.setTimeout(() => els.toast.classList.add("hidden"), 2400);
}

function setLoginBusy(isBusy) {
  els.loginForm.querySelectorAll("button, input").forEach((node) => { node.disabled = isBusy; });
}

async function authenticate(mode) {
  const username = String(els.usernameInput.value || "").trim();
  const password = String(els.passwordInput.value || "");
  if (!username) {
    els.loginHint.textContent = "请输入用户名。";
    els.usernameInput.focus();
    return;
  }
  if (password.length < 6) {
    els.loginHint.textContent = "密码至少 6 位。";
    els.passwordInput.focus();
    return;
  }
  setLoginBusy(true);
  els.loginHint.textContent = mode === "register" ? "正在创建账号..." : "正在登录...";
  try {
    const data = await api(`/api/auth/${mode}`, { method: "POST", body: { username, password } });
    state.token = data.token;
    state.user = data.user;
    applyWorkspace(data.workspace);
    saveSession();
    els.mainView.dataset.pane = "list";
    render();
    startBridgePolling();
    startCloudEvents();
  } catch (error) {
    els.loginHint.textContent = error.message;
  } finally {
    setLoginBusy(false);
  }
}

async function uploadPendingAttachments() {
  const uploads = [];
  for (const attachment of state.pendingAttachments) {
    if (!attachment.dataUrl) continue;
    attachment.status = "上传中";
    renderPendingAttachments();
    const { file } = await api("/api/files", {
      method: "POST",
      body: { name: attachment.name, dataUrl: attachment.dataUrl }
    });
    attachment.status = "已上传";
    renderPendingAttachments();
    uploads.push(file);
  }
  return uploads;
}

async function fileToAttachment(file) {
  if (!ALLOWED_UPLOAD_IMAGE_TYPES.has(file.type)) {
    throw new Error(`暂时只支持 PNG、JPEG、WebP 或 GIF 图片：${file.name}`);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`图片「${file.name}」超过 ${formatBytes(MAX_UPLOAD_BYTES)}，请压缩后再上传。`);
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error || new Error("Failed to read file.")));
    reader.readAsDataURL(file);
  });
  return { id: id("pending"), type: "image", name: file.name, mimeType: file.type, size: file.size, dataUrl, localUrl: dataUrl };
}

els.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  authenticate(event.submitter?.id === "registerButton" ? "register" : "login");
});

els.logoutButton.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: {} });
  } catch {
    // Local logout should still proceed.
  }
  clearSession();
  stopBridgePolling();
  stopCloudEvents();
  render();
});

els.conversationSearch.addEventListener("input", renderSidebar);

els.railButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.activeView = button.dataset.view || "chat";
    state.activeUtilityId = "";
    els.mainView.dataset.pane = "list";
    render();
  });
});

els.conversationList.addEventListener("click", (event) => {
  const conversationButton = event.target.closest("[data-conversation-id]");
  if (conversationButton) {
    state.activeConversationId = conversationButton.dataset.conversationId;
    els.mainView.dataset.pane = "chat";
    renderChat();
    return;
  }
  const utilityButton = event.target.closest("[data-utility-id]");
  if (!utilityButton) return;
  state.activeUtilityId = utilityButton.dataset.utilityId;
  els.mainView.dataset.pane = "chat";
  renderUtilityView();
});

els.newConversation.addEventListener("click", () => {
  if ((state.activeView || "chat") !== "chat") return;
  const conversation = createConversation("新对话", "Aimashi Cloud · 已同步", avatarA);
  conversation.messages.push({ id: id("msg"), role: "assistant", text: "新对话已创建。", createdAt: nowIso(), attachments: [] });
  state.activeConversationId = conversation.id;
  els.mainView.dataset.pane = "chat";
  render();
  saveWorkspace().catch((error) => showToast(error.message));
});

els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.isSending) {
    try {
      await cancelActiveBridgeRun();
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  const text = String(els.chatInput.value || "").trim();
  if (!text && !state.pendingAttachments.length) return;
  els.chatInput.value = "";
  setSending(true);
  try {
    const attachments = await uploadPendingAttachments();
    state.pendingAttachments = [];
    renderPendingAttachments();
    await pushMessage("user", text, attachments);
    await requestBridgeReply(text, attachments);
  } catch (error) {
    showToast(error.message);
  } finally {
    setSending(false);
  }
});

els.chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    els.chatForm.requestSubmit();
  }
});

els.chatInput.addEventListener("input", () => {
  els.chatInput.style.height = "41px";
  els.chatInput.style.height = `${Math.min(156, Math.max(41, els.chatInput.scrollHeight))}px`;
});

els.attachButton.addEventListener("click", () => els.fileInput.click());

els.fileInput.addEventListener("change", async () => {
  const files = Array.from(els.fileInput.files || []);
  const results = await Promise.allSettled(files.map(fileToAttachment));
  const attachments = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) showToast(rejected.reason?.message || "附件读取失败。");
  state.pendingAttachments.push(...attachments);
  els.fileInput.value = "";
  renderPendingAttachments();
});

els.attachmentTray.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  const item = event.target.closest("[data-pending-id]");
  if (!button || !item) return;
  state.pendingAttachments = state.pendingAttachments.filter((attachment) => attachment.id !== item.dataset.pendingId);
  renderPendingAttachments();
});

els.chat.addEventListener("click", (event) => {
  const preview = event.target.closest("[data-preview-src]");
  if (!preview) return;
  openImagePreview(preview.dataset.previewSrc);
});

els.themeToggle.addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  saveSession();
  render();
});

els.mobileBack.addEventListener("click", () => {
  els.mainView.dataset.pane = "list";
});

els.utilityView.addEventListener("click", (event) => {
  const bridgeDevice = event.target.closest("[data-bridge-device]");
  if (bridgeDevice) {
    state.selectedBridgeDeviceId = bridgeDevice.dataset.bridgeDevice || "";
    renderUtilityView();
    renderBridgeStatus();
    return;
  }
  const chatButton = event.target.closest("[data-start-chat]");
  if (chatButton) {
    const contact = (state.workspace.contacts || []).find((item) => item.id === chatButton.dataset.startChat);
    if (!contact) return;
    let conversation = state.workspace.conversations.find((item) => item.title === contact.title);
    if (!conversation) conversation = createConversation(contact.title, contact.meta, contact.avatar || avatarA);
    state.activeView = "chat";
    state.activeConversationId = conversation.id;
    els.mainView.dataset.pane = "chat";
    render();
    saveWorkspace().catch((error) => showToast(error.message));
    return;
  }
  const toast = event.target.closest("[data-toast]");
  if (toast) showToast(toast.dataset.toast);
});

function closeImagePreview() {
  document.querySelector(".image-preview-overlay")?.remove();
}

function openImagePreview(src) {
  if (!src) return;
  closeImagePreview();
  const overlay = document.createElement("div");
  overlay.className = "image-preview-overlay";
  overlay.innerHTML = `<button class="image-preview-close" type="button" aria-label="关闭">×</button><img src="${escapeHtml(src)}" alt="图片预览">`;
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.closest(".image-preview-close")) closeImagePreview();
  });
  document.body.appendChild(overlay);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeImagePreview();
});

async function boot() {
  loadSession();
  setAuthView();
  if (!state.token) return;
  try {
    setSyncState("同步中", false);
    const data = await api("/api/me");
    state.user = data.user;
    applyWorkspace(data.workspace);
    saveSession();
    setSyncState("已同步", true);
    startBridgePolling();
    startCloudEvents();
  } catch (error) {
    clearSession();
    stopBridgePolling();
    els.loginHint.textContent = error.message;
  }
  render();
}

boot();
