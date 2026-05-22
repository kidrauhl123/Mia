// Aimashi Web — chat + settings only.
// Conversation list = cloud DM + group rooms. No fellows on web (those live on
// the owner's desktop; future remote-fellow work will surface them here).

const STORAGE_KEY = "aimashi.web.session";
const API_BASE = "";

const els = {
  root: document.querySelector(".app-shell"),
  loginView: document.getElementById("loginView"),
  mainView: document.getElementById("mainView"),
  loginForm: document.getElementById("loginForm"),
  usernameInput: document.getElementById("usernameInput"),
  passwordInput: document.getElementById("passwordInput"),
  registerButton: document.getElementById("registerButton"),
  loginHint: document.getElementById("loginHint"),

  conversationSearch: document.getElementById("conversationSearch"),
  conversationList: document.getElementById("conversationList"),
  newConversation: document.getElementById("newConversation"),
  conversationCreateMenu: document.getElementById("conversationCreateMenu"),
  convMenuAddFriend: document.getElementById("convMenuAddFriend"),
  convMenuNewGroup: document.getElementById("convMenuNewGroup"),
  unreadCount: document.getElementById("unreadCount"),
  mobileBack: document.getElementById("mobileBack"),

  activeAvatar: document.getElementById("activeAvatar"),
  activeTitle: document.getElementById("activeTitle"),
  activeMeta: document.getElementById("activeMeta"),
  statusText: document.getElementById("statusText"),
  chat: document.getElementById("chat"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  sendButton: document.getElementById("sendButton"),

  settingsView: document.getElementById("settingsView"),
  openSettings: document.getElementById("openSettings"),
  closeSettings: document.getElementById("closeSettings"),
  cloudAccountUsername: document.getElementById("cloudAccountUsername"),
  cloudLogoutFromSettings: document.getElementById("cloudLogoutFromSettings"),
  appearanceTheme: document.getElementById("appearanceTheme"),

  toast: document.getElementById("toast"),
};

let state = {
  token: "",
  user: null,
  theme: "light",
  rooms: [],
  friends: [],
  incomingRequests: [],
  outgoingRequests: [],
  messageCache: new Map(),
  roomMembersCache: new Map(),
  // Cloud workspace mirror (populated from /api/workspace). Holds the
  // desktop-synced fellow conversations + their messages. Cloud rooms and
  // desktop conversations are merged into a single sidebar list.
  workspace: { revision: 0, conversations: [] },
  bridgeDevices: [],
  bridgeBusy: false,
  activeConversationId: "",
  settingsOpen: false,
  activeSettingsTab: "account",
  createMenuOpen: false,
};

let eventsSocket = null;
let eventsReconnectTimer = 0;

// ── helpers ────────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function shortTime(value) {
  const date = value ? new Date(value) : new Date();
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
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
  state.rooms = [];
  state.friends = [];
  state.incomingRequests = [];
  state.outgoingRequests = [];
  state.messageCache.clear();
  state.roomMembersCache.clear();
  state.workspace = { revision: 0, conversations: [] };
  state.bridgeDevices = [];
  state.bridgeBusy = false;
  state.activeConversationId = "";
  stopCloudEvents();
  localStorage.removeItem(STORAGE_KEY);
}

// Conversation kind helpers — rooms are cloud-native DM/group rooms, desktop
// conversations come from the synced workspace and route through a desktop
// bridge to run the owner's local fellow.
function isDesktopConversationId(id) {
  return typeof id === "string" && id.startsWith("desktop:");
}
function isRoomId(id) {
  return typeof id === "string" && (id.startsWith("dm:") || id.startsWith("g_"));
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

// ── auth view ──────────────────────────────────────────────────────────────

function setAuthView() {
  els.root.dataset.auth = state.token ? "signed-in" : "signed-out";
  document.documentElement.dataset.theme = state.theme || "light";
}

async function handleLogin(register) {
  const username = els.usernameInput.value.trim();
  const password = els.passwordInput.value;
  if (!username || !password) return;
  try {
    const path = register ? "/api/auth/register" : "/api/auth/login";
    const data = await api(path, { method: "POST", body: { username, password } });
    state.token = data.token;
    state.user = data.user || { username };
    saveSession();
    setAuthView();
    await bootstrap();
    startCloudEvents();
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
    const me = await api("/api/me");
    state.user = me.user || me;
    saveSession();
  } catch (err) {
    // token bad → log out
    clearSession();
    setAuthView();
    return;
  }
  await Promise.all([
    api("/api/rooms").then((d) => { state.rooms = Array.isArray(d.rooms) ? d.rooms : []; }).catch(() => {}),
    api("/api/social/friends").then((d) => { state.friends = Array.isArray(d.friends) ? d.friends : []; }).catch(() => {}),
    api("/api/social/friend-requests?direction=incoming").then((d) => { state.incomingRequests = Array.isArray(d.requests) ? d.requests : []; }).catch(() => {}),
    api("/api/social/friend-requests?direction=outgoing").then((d) => { state.outgoingRequests = Array.isArray(d.requests) ? d.requests : []; }).catch(() => {}),
    // Workspace: holds the desktop-synced fellow conversations (Phase A).
    api("/api/workspace").then((d) => { applyWorkspace(d.workspace); }).catch(() => {}),
    // Bridge devices: lets Phase B decide whether the owner's desktop is
    // online and we can route the message through it. Empty array if none.
    api("/api/bridge/devices").then((d) => { state.bridgeDevices = Array.isArray(d.devices) ? d.devices : []; }).catch(() => {}),
  ]);
  if (!state.activeConversationId) {
    // Prefer the most recently active conversation across both rooms and
    // desktop fellow chats (sorted by recency).
    const first = combinedConversationItems()[0];
    if (first) state.activeConversationId = first.id;
  }
  if (state.activeConversationId && isRoomId(state.activeConversationId)) {
    await ensureRoomMessages(state.activeConversationId);
    await ensureRoomMembers(state.activeConversationId);
  }
  renderConversationList();
  renderActiveChat();
  renderSettings();
}

function applyWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object") {
    state.workspace = { revision: 0, conversations: [] };
    return;
  }
  state.workspace = {
    revision: Number(workspace.revision || 0),
    conversations: Array.isArray(workspace.conversations) ? workspace.conversations : []
  };
}

function activeDesktopConversation() {
  if (!isDesktopConversationId(state.activeConversationId)) return null;
  return state.workspace.conversations.find((c) => c.id === state.activeConversationId) || null;
}

function bridgeIsOnline() {
  return state.bridgeDevices.length > 0;
}

// Room ids are `dm:<a>:<b>` or `g_<hex>` — both fit the server route regex
// /api/rooms/([A-Za-z0-9_:-]+) literally. encodeURIComponent would turn `:`
// into `%3A` and 404 the route, so paths use room.id verbatim.

async function ensureRoomMessages(roomId) {
  if (!roomId) return;
  const cached = state.messageCache.get(roomId);
  const sinceSeq = cached?.maxSeq || 0;
  try {
    const data = await api(`/api/rooms/${roomId}/messages?since_seq=${sinceSeq}&limit=200`);
    const incoming = Array.isArray(data.messages) ? data.messages : [];
    const messages = cached ? [...cached.messages] : [];
    const seen = new Set(messages.map((m) => m.id));
    for (const m of incoming) {
      if (!seen.has(m.id)) { messages.push(m); seen.add(m.id); }
    }
    const maxSeq = messages.reduce((acc, m) => Math.max(acc, Number(m.seq || 0)), sinceSeq);
    state.messageCache.set(roomId, { messages, maxSeq });
  } catch (err) {
    console.warn("[web] ensureRoomMessages failed:", err);
  }
}

async function ensureRoomMembers(roomId) {
  if (!roomId || state.roomMembersCache.has(roomId)) return;
  try {
    const data = await api(`/api/rooms/${roomId}`);
    if (Array.isArray(data.members)) state.roomMembersCache.set(roomId, data.members);
  } catch (err) {
    console.warn("[web] ensureRoomMembers failed:", err);
  }
}

// ── cloud events (WS) ──────────────────────────────────────────────────────

function startCloudEvents() {
  if (!state.token) return;
  stopCloudEvents();
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/api/events`;
  let socket;
  try {
    socket = new WebSocket(url, ["aimashi-token." + state.token]);
  } catch (err) {
    console.warn("[web] WS connect failed:", err);
    scheduleReconnect();
    return;
  }
  eventsSocket = socket;
  // Bind the local `socket` ref so a stale close/error from a previous instance
  // can't clobber a newer healthy connection.
  socket.addEventListener("message", (event) => {
    if (eventsSocket !== socket) return;
    let envelope;
    try { envelope = JSON.parse(event.data); } catch { return; }
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
  eventsReconnectTimer = setTimeout(() => { eventsReconnectTimer = 0; startCloudEvents(); }, 3000);
}

function handleCloudEvent(envelope) {
  const type = envelope?.type || "";
  if (type === "room.message_appended") {
    const msg = envelope.message;
    const roomId = msg?.room_id || envelope.room_id;
    if (!roomId) return;
    const entry = state.messageCache.get(roomId) || { messages: [], maxSeq: 0 };
    if (!entry.messages.some((m) => m.id === msg.id)) {
      entry.messages.push(msg);
      entry.maxSeq = Math.max(entry.maxSeq, Number(msg.seq || 0));
      state.messageCache.set(roomId, entry);
    }
    if (roomId === state.activeConversationId) renderActiveChat();
    renderConversationList();
  } else if (type === "workspace_updated" || type === "message_created") {
    applyWorkspace(envelope.workspace);
    renderConversationList();
    if (isDesktopConversationId(state.activeConversationId)) renderActiveChat();
  } else if (type === "device_updated") {
    if (Array.isArray(envelope.devices)) state.bridgeDevices = envelope.devices;
    renderActiveChat();
  } else if (type === "bridge_run_updated") {
    const status = envelope.run?.status;
    if (status === "pending" || status === "running") state.bridgeBusy = true;
    else state.bridgeBusy = false;
    if (isDesktopConversationId(state.activeConversationId)) renderActiveChat();
  } else if (type === "social.friend_request_received") {
    if (envelope.request) state.incomingRequests = [envelope.request, ...state.incomingRequests];
    showToast(`收到 ${envelope.request?.from?.username || "好友"} 的好友请求`);
  } else if (type === "social.friend_added") {
    if (envelope.friend) {
      state.friends = [envelope.friend, ...state.friends.filter((f) => f.id !== envelope.friend.id)];
    }
    if (envelope.room) {
      state.rooms = [envelope.room, ...state.rooms.filter((r) => r.id !== envelope.room.id)];
    }
    state.incomingRequests = state.incomingRequests.filter((r) => r.from_user !== envelope.friend?.id && r.to_user !== envelope.friend?.id);
    state.outgoingRequests = state.outgoingRequests.filter((r) => r.to_user !== envelope.friend?.id);
    renderConversationList();
  } else if (type === "social.room_invited") {
    if (envelope.room) {
      state.rooms = [envelope.room, ...state.rooms.filter((r) => r.id !== envelope.room.id)];
      state.roomMembersCache.delete(envelope.room.id);
    }
    renderConversationList();
  }
}

// ── conversation list (rooms + desktop-synced fellow chats merged) ────────

function friendUsernameById(userId) {
  return state.friends.find((f) => f.id === userId)?.username || userId;
}

function roomDisplayTitle(room) {
  if (room.id?.startsWith("dm:")) {
    const parts = room.id.split(":");
    const otherId = parts[1] === state.user?.id ? parts[2] : parts[1];
    return friendUsernameById(otherId);
  }
  return room.name || "未命名群聊";
}

function roomLastMessageText(room) {
  const cached = state.messageCache.get(room.id);
  const last = cached?.messages?.[cached.messages.length - 1];
  if (!last) return "暂无对话";
  return last.body_md || (last.attachments ? "[附件]" : "");
}

function roomSortKey(room) {
  const cached = state.messageCache.get(room.id);
  const last = cached?.messages?.[cached.messages.length - 1];
  return new Date(last?.created_at || room.updated_at || room.created_at || 0).getTime();
}

function desktopConvLastMessageText(conv) {
  const last = conv.messages?.[conv.messages.length - 1];
  if (!last) return conv.meta || "Aimashi Desktop · 已同步";
  return last.text || (last.attachments?.length ? "[附件]" : "");
}

function desktopConvSortKey(conv) {
  const last = conv.messages?.[conv.messages.length - 1];
  return new Date(last?.createdAt || conv.updatedAt || 0).getTime();
}

// Unified item shape so the renderer doesn't have to branch every time.
function combinedConversationItems() {
  const room = state.rooms.map((r) => ({
    kind: "room",
    id: r.id,
    title: roomDisplayTitle(r),
    preview: roomLastMessageText(r),
    sortKey: roomSortKey(r),
    isDM: r.id?.startsWith("dm:")
  }));
  const desktop = state.workspace.conversations.map((c) => ({
    kind: "desktop",
    id: c.id,
    title: c.title || "本地对话",
    preview: desktopConvLastMessageText(c),
    sortKey: desktopConvSortKey(c),
    avatar: c.avatar
  }));
  return [...room, ...desktop].sort((a, b) => b.sortKey - a.sortKey);
}

function renderConversationList() {
  const query = String(els.conversationSearch.value || "").trim().toLowerCase();
  const all = combinedConversationItems();
  const items = query ? all.filter((it) => it.title.toLowerCase().includes(query)) : all;

  if (!items.length) {
    const empty = state.user
      ? "没有会话。点击右上 + 添加好友或发起群聊；或在桌面端登录同账号并点同步。"
      : "请先登录。";
    els.conversationList.innerHTML = `<p class="persona-empty">${empty}</p>`;
    return;
  }

  els.conversationList.innerHTML = items.map((it) => {
    const avatarLabel = (it.title[0] || "?").toUpperCase();
    let color = "#5e5ce6";
    if (it.kind === "room") color = it.isDM ? "#5e5ce6" : "#34c759";
    if (it.kind === "desktop") color = "#ff9f0a"; // desktop fellow = orange tint
    // Only use the avatar URL if it's absolute or a data URL — desktop syncs
    // store relative paths like ./assets/avatar-08.png that don't exist on
    // the cloud-served web origin, so fall back to the colored letter circle.
    const useAvatar = it.avatar && (/^(https?:|data:)/i.test(it.avatar));
    const avatarStyle = useAvatar
      ? `background-image:url('${escapeHtml(it.avatar)}'); background-size:cover; background-position:center;`
      : `background-color:${color}; color:#fff; display:inline-flex; align-items:center; justify-content:center;`;
    const avatarText = useAvatar ? "" : escapeHtml(avatarLabel);
    return `
      <button class="persona ${it.id === state.activeConversationId ? "active" : ""}" type="button" data-conv-id="${escapeHtml(it.id)}" data-conv-kind="${it.kind}">
        <span class="avatar" style="${avatarStyle}">${avatarText}</span>
        <span class="persona-main">
          <strong class="persona-name">${escapeHtml(it.title)}</strong>
          <span class="persona-preview">${escapeHtml(it.preview)}</span>
        </span>
      </button>
    `;
  }).join("");
}

// ── active chat view ───────────────────────────────────────────────────────

function buildRoomMessageArticle(msg, room) {
  const isOwn = msg.sender_kind === "user" && msg.sender_ref === state.user?.id;
  let senderLabel = "";
  if (msg.sender_kind === "user") {
    const friend = state.friends.find((f) => f.id === msg.sender_ref);
    senderLabel = friend?.username || msg.sender_ref || "";
  } else if (msg.sender_kind === "fellow") {
    const members = state.roomMembersCache.get(room.id) || [];
    const m = members.find((mem) => mem.member_kind === "fellow" && mem.member_ref === msg.sender_ref);
    const owner = m?.owner?.username || m?.owner?.account || m?.owner_id || "";
    senderLabel = msg.sender_ref + (owner ? ` (${owner})` : "");
  }
  const cls = isOwn ? "message user" : "message assistant";
  const initial = isOwn ? (state.user?.username?.[0] || "M").toUpperCase() : (msg.sender_ref?.[0] || "?").toUpperCase();
  const color = isOwn ? "#0162db" : "#5e5ce6";
  const body = (msg.body_md || "").replace(/\n/g, "<br>");
  return `
    <article class="${cls}">
      <span class="avatar" style="background-color:${color}; color:#fff; display:inline-flex; align-items:center; justify-content:center;">${escapeHtml(initial)}</span>
      <div class="message-stack">
        ${senderLabel && !isOwn ? `<span class="message-sender">${escapeHtml(senderLabel)}</span>` : ""}
        <div class="bubble">${escapeHtml(body).replace(/&lt;br&gt;/g, "<br>")}</div>
        <span class="message-time">${escapeHtml(shortTime(msg.created_at))}</span>
      </div>
    </article>
  `;
}

function buildDesktopMessageArticle(msg, conv) {
  const isOwn = msg.role === "user";
  const cls = isOwn ? "message user" : "message assistant";
  const initial = isOwn ? (state.user?.username?.[0] || "M").toUpperCase() : (conv.title?.[0] || "A").toUpperCase();
  const color = isOwn ? "#0162db" : "#ff9f0a";
  const body = (msg.text || "").replace(/\n/g, "<br>");
  return `
    <article class="${cls}">
      <span class="avatar" style="background-color:${color}; color:#fff; display:inline-flex; align-items:center; justify-content:center;">${escapeHtml(initial)}</span>
      <div class="message-stack">
        <div class="bubble">${escapeHtml(body).replace(/&lt;br&gt;/g, "<br>")}</div>
        <span class="message-time">${escapeHtml(shortTime(msg.createdAt))}</span>
      </div>
    </article>
  `;
}

function setComposerEnabled(enabled, placeholder) {
  els.chatInput.disabled = !enabled;
  els.sendButton.disabled = !enabled;
  if (placeholder) els.chatInput.placeholder = placeholder;
}

function renderActiveChat() {
  const id = state.activeConversationId;
  if (!id) {
    els.activeAvatar.style.backgroundImage = "";
    els.activeAvatar.style.backgroundColor = "transparent";
    els.activeAvatar.textContent = "";
    els.activeTitle.textContent = "Aimashi";
    els.activeMeta.textContent = state.user ? "选择一个会话开始聊天" : "Aimashi Cloud";
    els.chat.innerHTML = `<p class="persona-empty">还没有选中的会话。</p>`;
    setComposerEnabled(false, "选择一个会话开始聊天");
    return;
  }

  if (isRoomId(id)) {
    const room = state.rooms.find((r) => r.id === id);
    if (!room) { setComposerEnabled(false, "会话不存在"); return; }
    const title = roomDisplayTitle(room);
    const isDM = room.id?.startsWith("dm:");
    els.activeAvatar.style.backgroundImage = "";
    els.activeAvatar.style.backgroundColor = isDM ? "#5e5ce6" : "#34c759";
    els.activeAvatar.style.color = "#fff";
    els.activeAvatar.style.display = "inline-flex";
    els.activeAvatar.style.alignItems = "center";
    els.activeAvatar.style.justifyContent = "center";
    els.activeAvatar.textContent = (title[0] || "?").toUpperCase();
    els.activeTitle.textContent = title;
    els.activeMeta.textContent = isDM ? "私聊" : "群聊";
    const cached = state.messageCache.get(room.id);
    const messages = cached?.messages || [];
    els.chat.innerHTML = messages.length
      ? messages.map((m) => buildRoomMessageArticle(m, room)).join("")
      : `<p class="persona-empty">还没有消息。</p>`;
    if (messages.length) els.chat.scrollTop = els.chat.scrollHeight;
    setComposerEnabled(true, "输入消息，Enter 发送，Shift+Enter 换行");
    return;
  }

  if (isDesktopConversationId(id)) {
    const conv = activeDesktopConversation();
    if (!conv) { setComposerEnabled(false, "对话不存在"); return; }
    els.activeAvatar.textContent = "";
    const useAvatar = conv.avatar && (/^(https?:|data:)/i.test(conv.avatar));
    if (useAvatar) {
      els.activeAvatar.style.backgroundImage = `url('${conv.avatar}')`;
      els.activeAvatar.style.backgroundSize = "cover";
      els.activeAvatar.style.backgroundPosition = "center";
      els.activeAvatar.style.backgroundColor = "transparent";
    } else {
      els.activeAvatar.style.backgroundImage = "";
      els.activeAvatar.style.backgroundColor = "#ff9f0a";
      els.activeAvatar.style.color = "#fff";
      els.activeAvatar.style.display = "inline-flex";
      els.activeAvatar.style.alignItems = "center";
      els.activeAvatar.style.justifyContent = "center";
      els.activeAvatar.textContent = (conv.title?.[0] || "A").toUpperCase();
    }
    els.activeTitle.textContent = conv.title || "本地对话";
    const online = bridgeIsOnline();
    els.activeMeta.textContent = online
      ? (state.bridgeBusy ? "本机 Agent 运行中…" : "本机 Agent · 在线")
      : "本机 Agent · 离线（请确认桌面端登录同账号并保持在线）";
    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    els.chat.innerHTML = messages.length
      ? messages.map((m) => buildDesktopMessageArticle(m, conv)).join("")
      : `<p class="persona-empty">还没有消息。</p>`;
    if (messages.length) els.chat.scrollTop = els.chat.scrollHeight;
    // Phase B: composer is enabled only when bridge is online and not busy
    // (Phase A read-only fallback kicks in automatically when offline).
    if (!online) {
      setComposerEnabled(false, "本机 Agent 离线，无法发送（消息历史只读）");
    } else if (state.bridgeBusy) {
      setComposerEnabled(false, "本机 Agent 运行中…");
    } else {
      setComposerEnabled(true, "输入消息，Enter 发送（由本机 Agent 处理）");
    }
    return;
  }

  // Unknown conversation kind — defensively disable.
  setComposerEnabled(false, "不支持的会话类型");
  els.chat.innerHTML = `<p class="persona-empty">不支持的会话类型。</p>`;
}

async function setActiveConversation(id) {
  state.activeConversationId = id;
  if (isRoomId(id)) {
    await ensureRoomMessages(id);
    await ensureRoomMembers(id);
  }
  renderConversationList();
  renderActiveChat();
}

async function sendInActive() {
  const id = state.activeConversationId;
  const text = (els.chatInput.value || "").trim();
  if (!text || !id) return;

  if (isRoomId(id)) {
    els.chatInput.value = "";
    try {
      const res = await api(`/api/rooms/${id}/messages`, {
        method: "POST",
        body: { bodyMd: text }
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

  if (isDesktopConversationId(id)) {
    if (!bridgeIsOnline()) {
      showToast("本机 Agent 离线，无法发送。");
      return;
    }
    if (state.bridgeBusy) {
      showToast("本机 Agent 正在运行，请稍后…");
      return;
    }
    const device = state.bridgeDevices[0];
    els.chatInput.value = "";
    state.bridgeBusy = true;
    renderActiveChat();
    const clientCreatedAt = new Date().toISOString();
    try {
      // 1. Persist the user message. The cloud broadcasts message_created so
      //    the workspace echoes back via WS — but use the POST response as a
      //    fallback so the bubble shows immediately even if WS is lagged.
      const userRes = await api("/api/messages", {
        method: "POST",
        body: { conversationId: id, role: "user", text, createdAt: clientCreatedAt }
      });
      if (userRes?.workspace) applyWorkspace(userRes.workspace);
      if (id === state.activeConversationId) renderActiveChat();
      // 2. Dispatch the bridge run on the chosen desktop device. Cloud appends
      //    the assistant reply automatically. Same WS-fallback pattern.
      const runRes = await api("/api/bridge/run", {
        method: "POST",
        body: { deviceId: device.id, conversationId: id, text }
      });
      if (runRes?.workspace) applyWorkspace(runRes.workspace);
    } catch (err) {
      showToast(err.message);
      els.chatInput.value = text;
    } finally {
      state.bridgeBusy = false;
      if (id === state.activeConversationId) renderActiveChat();
      renderConversationList();
    }
  }
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
  const myName = state.user?.username || "—";
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
                    <strong>我的用户名</strong>
                    <p>把这个发给朋友，让对方添加你。</p>
                  </div>
                </div>
                <section class="connection-details">
                  <p class="pairing-hint" style="font-family:monospace;">${escapeHtml(myName)}</p>
                </section>
              </section>
              <section class="connection-row">
                <div class="connection-row-head">
                  <div>
                    <strong>添加好友</strong>
                    <p>输入对方的用户名发送请求。</p>
                  </div>
                </div>
                <section class="connection-details">
                  <div class="cloud-login-grid" style="grid-template-columns:1fr auto;">
                    <input id="addFriendInput" placeholder="用户名" autocomplete="off">
                    <button class="primary" type="button" data-action="send">发送</button>
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
                        <span style="flex:1;">${escapeHtml(r.other?.username || r.from_user)}</span>
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
                        <span style="flex:1;">${escapeHtml(r.other?.username || r.to_user)}</span>
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
    const username = String(input?.value || "").trim();
    if (!username) { statusEl.textContent = "请输入用户名"; return; }
    try {
      const res = await api("/api/social/friend-requests", { method: "POST", body: { toUsername: username } });
      if (res.request) {
        state.outgoingRequests = [{ ...res.request, other: { username } }, ...state.outgoingRequests];
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
        if (action === "accept" && res.friend && res.room) {
          state.friends = [res.friend, ...state.friends.filter((f) => f.id !== res.friend.id)];
          state.rooms = [res.room, ...state.rooms.filter((r) => r.id !== res.room.id)];
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
                        <label style="display:flex; align-items:center; gap:8px; padding:6px 0; cursor:pointer;">
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
      const res = await api("/api/rooms", { method: "POST", body: { name, memberFriendUserIds: ids, memberFellows: [] } });
      const room = res.room || res.data?.room;
      if (room) {
        state.rooms = [room, ...state.rooms.filter((r) => r.id !== room.id)];
        if (Array.isArray(res.members)) state.roomMembersCache.set(room.id, res.members);
        renderConversationList();
        setActiveConversation(room.id);
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
  if (els.appearanceTheme) {
    els.appearanceTheme.value = state.theme || "light";
  }
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
  const isRegister = event.submitter === els.registerButton;
  handleLogin(isRegister);
});

els.conversationSearch.addEventListener("input", renderConversationList);

els.conversationList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-conv-id]");
  if (!button) return;
  setActiveConversation(button.dataset.convId);
  setPane("chat");
});

els.newConversation.addEventListener("click", (event) => {
  event.stopPropagation();
  state.createMenuOpen = !state.createMenuOpen;
  renderCreateMenu();
});
els.convMenuAddFriend?.addEventListener("click", () => openAddFriendDialog());
els.convMenuNewGroup?.addEventListener("click", () => openCreateGroupDialog());
document.addEventListener("click", (event) => {
  if (!state.createMenuOpen) return;
  if (els.conversationCreateMenu?.contains(event.target) || els.newConversation?.contains(event.target)) return;
  state.createMenuOpen = false;
  renderCreateMenu();
});

els.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendInActive();
});
els.chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendInActive();
  }
});

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
els.appearanceTheme?.addEventListener("change", () => {
  state.theme = els.appearanceTheme.value;
  document.documentElement.dataset.theme = state.theme;
  saveSession();
});

// rail rail-rail button → chat is the only view; already active by default

// ── init ───────────────────────────────────────────────────────────────────

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
