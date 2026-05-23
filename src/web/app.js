// Aimashi Web — chat + settings only.
// Conversation list = cloud DM + group rooms. No fellows on web (those live on
// the owner's desktop; future remote-fellow work will surface them here).

const STORAGE_KEY = "aimashi.web.session";
const API_BASE = "";
const { formatConversationTime, formatMessageTime } = window.aimashiTimeFormat;
const { computeUnreadForConversation, totalUnreadFromConversations, unreadBadgeHtml } = window.aimashiUnread;
const { prepareOutgoingMessage } = window.aimashiSendPipeline;

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
  appearanceListStyle: document.getElementById("appearanceListStyle"),
  appearanceSelectionStyle: document.getElementById("appearanceSelectionStyle"),
  appearanceHoverBackground: document.getElementById("appearanceHoverBackground"),
  appearanceAccentColor: document.getElementById("appearanceAccentColor"),
  appearanceUserBubbleColor: document.getElementById("appearanceUserBubbleColor"),
  appearanceShowUserAvatar: document.getElementById("appearanceShowUserAvatar"),
  appearanceShowAssistantAvatar: document.getElementById("appearanceShowAssistantAvatar"),

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
  // Per-conversation unread counters. Incremented when a WS message arrives
  // for a non-active conversation, cleared when the user opens it. In-memory
  // only for v1 — survives until reload.
  unread: new Map(),
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

// Avatar preset crop table — mirrors src/renderer/helpers/avatar-helpers.js
// so web renders fellow avatars the same as desktop. Pet avatars are square
// (default crop); human avatars have face-centered crops that need explicit
// background-size + background-position.
const AVATAR_PRESETS = {
  "./assets/avatars/01.png": { x: 50.0687, y: 14.5495, zoom: 2.04 },
  "./assets/avatars/02.png": { x: 57.2536, y: 8.1635, zoom: 1.56 },
  "./assets/avatars/03.png": { x: 50, y: 14, zoom: 1.48 },
  "./assets/avatars/04.png": { x: 49.0079, y: 23.5736, zoom: 1.72 },
  "./assets/avatars/05.png": { x: 47.6785, y: 11.3611, zoom: 1.88 },
  "./assets/avatars/06.png": { x: 46.8749, y: 10.4285, zoom: 1.64 },
  "./assets/avatars/07.png": { x: 51.6741, y: 8.0209, zoom: 1.72 },
  "./assets/avatars/08.png": { x: 50.974, y: 12.8636, zoom: 1.88 },
  "./assets/avatars/09.png": { x: 47.4999, y: 12.2142, zoom: 1.8 },
  "./assets/avatars/10.png": { x: 50, y: 14, zoom: 1.8 },
  "./assets/avatars/11.png": { x: 55.8037, y: 7.9731, zoom: 1.64 },
  "./assets/avatars/12.png": { x: 47.3214, y: 16.9763, zoom: 1.8 },
  "./assets/avatars/13.png": { x: 50, y: 14, zoom: 1.8 },
  "./assets/avatars/14.png": { x: 50, y: 14, zoom: 1.72 },
  "./assets/avatars/15.png": { x: 45.1848, y: 5.1022, zoom: 1.56 },
  "./assets/avatars/16.png": { x: 51.0913, y: 15.7858, zoom: 1.72 }
};

function avatarBackgroundStyle(image, customCrop, fallbackColor) {
  if (!image) return `background-color:${fallbackColor};color:#fff;display:inline-flex;align-items:center;justify-content:center;`;
  const preset = AVATAR_PRESETS[image] || null;
  // Treat (50, 50, 1) as "no crop set" so we fall back to the preset crop
  // for human avatars even when the synced conversation didn't carry one.
  const isNeutral = !customCrop || (
    Math.abs(Number(customCrop.x) - 50) < 0.01 &&
    Math.abs(Number(customCrop.y) - 50) < 0.01 &&
    Math.abs(Number(customCrop.zoom || 1) - 1) < 0.001
  );
  const crop = (!isNeutral && customCrop) || preset || { x: 50, y: 50, zoom: 1 };
  const x = Number.isFinite(Number(crop.x)) ? Number(crop.x) : 50;
  const y = Number.isFinite(Number(crop.y)) ? Number(crop.y) : 50;
  const zoom = Number.isFinite(Number(crop.zoom)) ? Number(crop.zoom) : 1;
  const size = Math.round(zoom * 100);
  return `background-color:transparent;background-image:url('${image}');background-size:${size}%;background-position:${x}% ${y}%;background-repeat:no-repeat;`;
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

// Conversation kind helpers — rooms are cloud-native DM/group rooms.
// Workspace conversations come from the synced cloud workspace: desktop-
// originated ones use `desktop:<sessionId>` ids, but historic ones created
// by the old web client use `conv_xxx`. Both live in workspace.conversations
// and both route their sends through the desktop bridge in Phase B (since
// fellow runtime is local to the owner's desktop regardless of id prefix).
function isRoomId(id) {
  return typeof id === "string" && (id.startsWith("dm:") || id.startsWith("g_"));
}
function isWorkspaceConversationId(id) {
  if (!id || typeof id !== "string") return false;
  return state.workspace.conversations.some((c) => c.id === id);
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
  if ((method === "POST" || method === "PATCH" || method === "DELETE") && body && typeof body === "object" && !body.clientOpId) {
    body = { ...body, clientOpId: `op_${(crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`)}` };
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    body: body && typeof body !== "string" ? JSON.stringify(body) : body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

// ── auth view ──────────────────────────────────────────────────────────────

function setAuthView() {
  els.root.dataset.auth = state.token ? "signed-in" : "signed-out";
  // Theme now lives in window.aimashiAppearance (see web/appearance.js).
  // It applies on script load so the page doesn't flash; don't override here.
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

function activeWorkspaceConversation() {
  if (!isWorkspaceConversationId(state.activeConversationId)) return null;
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

// Resume cursor for replay (Phase 1.C). Per-account so logging out of A
// and into B doesn't replay A's events to B's session.
function lastEventSeqKey() { return `aimashi.web.lastEventSeq.${state.user?.id || "anon"}`; }
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
    // Track resume cursor (Phase 1.C). Persisted events carry `seq`;
    // events_ready may carry `serverSeq` (no replay needed case).
    if (Number.isFinite(Number(envelope.seq))) {
      if (Number(envelope.seq) > loadLastEventSeq()) saveLastEventSeq(envelope.seq);
    } else if (envelope.type === "events_ready" && Number.isFinite(Number(envelope.serverSeq))) {
      if (Number(envelope.serverSeq) > loadLastEventSeq()) saveLastEventSeq(envelope.serverSeq);
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
  eventsReconnectTimer = setTimeout(() => { eventsReconnectTimer = 0; startCloudEvents(); }, 3000);
}

function handleCloudEvent(envelope) {
  const type = envelope?.type || "";
  if (type === "room.message_appended") {
    const msg = envelope.message;
    const roomId = msg?.room_id || envelope.room_id;
    if (!roomId) return;
    const entry = state.messageCache.get(roomId) || { messages: [], maxSeq: 0 };
    const fresh = !entry.messages.some((m) => m.id === msg.id);
    if (fresh) {
      entry.messages.push(msg);
      entry.maxSeq = Math.max(entry.maxSeq, Number(msg.seq || 0));
      state.messageCache.set(roomId, entry);
      // Bump unread if the message isn't mine and the room isn't currently open.
      // Self-id check goes through shared/contact: resolveContact returns kind="self"
      // only when ref matches ctx.self.id (works for any sender kind).
      const author = window.aimashiContact.resolveContact(
        { kind: "user", ref: msg.sender_ref },
        { self: state.user, friends: state.friends }
      );
      const isMine = author.kind === "self";
      if (!isMine && roomId !== state.activeConversationId) {
        state.unread.set(roomId, (state.unread.get(roomId) || 0) + 1);
      }
    }
    if (roomId === state.activeConversationId) {
      state.unread.delete(roomId);
      renderActiveChat();
    }
    renderConversationList();
    renderRailUnreadBadge();
  } else if (type === "workspace_updated" || type === "message_created") {
    // Compare incoming workspace's per-conversation message counts to the
    // current cache so we can bump unread for desktop:* conversations that
    // got new assistant/echo messages while inactive.
    const prevById = new Map(state.workspace.conversations.map((c) => [c.id, (c.messages || []).length]));
    applyWorkspace(envelope.workspace);
    for (const c of state.workspace.conversations) {
      const prev = prevById.get(c.id) || 0;
      const next = (c.messages || []).length;
      if (next > prev && c.id !== state.activeConversationId) {
        // Only count messages that aren't mine (best-effort: workspace messages
        // carry role, "user" === me; "assistant" === bridge response).
        const newMessages = (c.messages || []).slice(prev);
        const fromOthers = newMessages.filter((m) => m.role !== "user").length;
        if (fromOthers > 0) state.unread.set(c.id, (state.unread.get(c.id) || 0) + fromOthers);
      }
    }
    if (state.activeConversationId) state.unread.delete(state.activeConversationId);
    renderConversationList();
    if (isWorkspaceConversationId(state.activeConversationId)) renderActiveChat();
    renderRailUnreadBadge();
  } else if (type === "device_updated") {
    if (Array.isArray(envelope.devices)) state.bridgeDevices = envelope.devices;
    renderActiveChat();
  } else if (type === "bridge_run_updated") {
    const status = envelope.run?.status;
    if (status === "pending" || status === "running") state.bridgeBusy = true;
    else state.bridgeBusy = false;
    if (isWorkspaceConversationId(state.activeConversationId)) renderActiveChat();
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
  } else if (type === "room.updated") {
    // PATCH /api/rooms/:id from any device — merge the patched room.
    if (envelope.room) {
      state.rooms = state.rooms.map((r) => (r.id === envelope.room.id ? { ...r, ...envelope.room } : r));
      renderConversationList();
      if (state.activeConversationId === envelope.room.id) renderActiveChat();
    }
  } else if (type === "room.deleted") {
    // DELETE /api/rooms/:id from any device — purge local state.
    const roomId = envelope.roomId;
    if (roomId) {
      state.rooms = state.rooms.filter((r) => r.id !== roomId);
      state.unread.delete(roomId);
      state.roomMembersCache.delete(roomId);
      if (state.activeConversationId === roomId) state.activeConversationId = "";
      renderConversationList();
      renderActiveChat();
    }
  }
}

// ── conversation list (rooms + desktop-synced fellow chats merged) ────────

function friendById(userId) {
  if (userId === state.user?.id) return state.user;
  return state.friends.find((f) => f.id === userId) || null;
}

function friendUsernameById(userId) {
  return friendById(userId)?.username || userId;
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
// Pinned items sort to the top regardless of recency, mirroring the
// ChatGPT-style pin behavior the user asked for.
function combinedConversationItems() {
  const room = state.rooms.map((r) => {
    const isDM = r.id?.startsWith("dm:");
    let avatar = "";
    let avatarCrop = null;
    let color = "";
    if (isDM) {
      const parts = r.id.split(":");
      const otherId = parts[1] === state.user?.id ? parts[2] : parts[1];
      const friend = friendById(otherId);
      if (friend) {
        avatar = friend.avatarImage || "";
        avatarCrop = friend.avatarCrop || null;
        color = friend.avatarColor || "";
      }
    }
    return {
      kind: "room",
      id: r.id,
      title: roomDisplayTitle(r),
      preview: roomLastMessageText(r),
      sortKey: roomSortKey(r),
      isDM,
      avatar,
      avatarCrop,
      color,
      pinned: isRoomPinned(r.id)
    };
  });
  const desktop = state.workspace.conversations.map((c) => ({
    kind: "desktop",
    id: c.id,
    title: c.title || "本地对话",
    preview: desktopConvLastMessageText(c),
    sortKey: desktopConvSortKey(c),
    avatar: c.avatar,
    avatarCrop: c.avatarCrop || null,
    color: c.color || "",
    pinned: Boolean(c.pinned)
  }));
  return [...room, ...desktop].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.sortKey - a.sortKey;
  });
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
    if (it.kind === "room") color = it.color || (it.isDM ? "#5e5ce6" : "#34c759");
    if (it.kind === "desktop") color = it.color || "#ff9f0a";
    // Accept absolute URLs, data URLs, and relative ./assets/... paths
    // (the cloud release bundles preset avatars under web/assets/ so
    // ./assets/avatars-pet/05.png resolves against the web origin).
    const useAvatar = it.avatar && (/^(https?:|data:|\.?\/assets\/)/i.test(it.avatar));
    const avatarStyle = useAvatar
      ? avatarBackgroundStyle(it.avatar, it.avatarCrop, color)
      : `background-color:${color}; color:#fff; display:inline-flex; align-items:center; justify-content:center;`;
    const avatarText = useAvatar ? "" : escapeHtml(avatarLabel);
    // ⋯ menu: workspace conversations + cloud rooms (PATCH/DELETE /api/rooms
    // shipped — see commit 90671e4). Pin uses local storage; rename + delete
    // hit the cloud.
    const hasMenu = it.kind === "desktop" || it.kind === "room";
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
          <span class="avatar" style="${avatarStyle}">${avatarText}</span>
          <span class="persona-main">
            <strong class="persona-name">${it.pinned ? "📌 " : ""}${escapeHtml(it.title)}</strong>
            <span class="persona-preview">${escapeHtml(it.preview)}</span>
          </span>
          ${sideHtml}
        </button>
        ${hasMenu ? `<button class="persona-more" type="button" data-conv-more="${escapeHtml(it.id)}" aria-label="更多操作" title="更多操作">⋯</button>` : ""}
      </div>
    `;
  }).join("");
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

// Local-only pinning for cloud rooms (mirrors desktop's social.isRoomPinned).
// Server has no decorations.pinned wiring yet, so pin survives reload via
// localStorage but doesn't sync across devices. Full sync is a follow-up.
const ROOM_PINNED_KEY = "aimashi.web.pinnedRooms.v1";
function _loadPinnedRooms() {
  try {
    const raw = localStorage.getItem(ROOM_PINNED_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}
let _pinnedRooms = null;
function isRoomPinned(roomId) {
  if (!_pinnedRooms) _pinnedRooms = _loadPinnedRooms();
  return _pinnedRooms.has(roomId);
}
function setRoomPinned(roomId, pinned) {
  if (!_pinnedRooms) _pinnedRooms = _loadPinnedRooms();
  if (pinned) _pinnedRooms.add(roomId); else _pinnedRooms.delete(roomId);
  try { localStorage.setItem(ROOM_PINNED_KEY, JSON.stringify(Array.from(_pinnedRooms))); } catch { /* silent */ }
}

function openConvMenu(convId, anchorButton) {
  const el = ensureConvMenuEl();
  _convMenuTargetId = convId;
  // Resolve across both sources so the menu shape is identical regardless of
  // whether the entry is a workspace conversation (desktop session) or a
  // cloud room (DM / group). Kind-dispatch happens in handleConvAction.
  const wsConv = state.workspace.conversations.find((c) => c.id === convId);
  const room = state.rooms.find((r) => r.id === convId);
  if (!wsConv && !room) return;
  const isRoom = Boolean(room);
  const isDM = isRoom && convId.startsWith("dm:");
  const pinned = isRoom ? isRoomPinned(convId) : Boolean(wsConv.pinned);
  // Cloud DM rename is hidden — display name comes from the peer's profile,
  // not the room record. Server rejects it.
  const showRename = !isDM;
  el.innerHTML = `
    <button type="button" data-conv-action="pin">${pinned ? "取消置顶" : "置顶"}</button>
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

// Concurrency-safe write path: send ONLY the touched conversation (and
// optional remove list) to /api/workspace/sync. Server merges by id so a
// stale local snapshot from this tab can't clobber updates another device
// pushed in between.
async function syncWorkspaceChange({ upsert = [], remove = [] }) {
  // Optimistic local update so the UI reacts immediately.
  const removeSet = new Set(remove);
  const byId = new Map(upsert.map((c) => [c.id, c]));
  const optimistic = state.workspace.conversations
    .filter((c) => !removeSet.has(c.id))
    .map((c) => byId.has(c.id) ? { ...c, ...byId.get(c.id) } : c);
  for (const c of byId.values()) {
    if (!optimistic.some((x) => x.id === c.id)) optimistic.unshift(c);
  }
  applyWorkspace({ ...state.workspace, conversations: optimistic });
  if (state.activeConversationId && removeSet.has(state.activeConversationId)) {
    state.activeConversationId = "";
  }
  renderConversationList();
  renderActiveChat();
  try {
    const res = await api("/api/workspace/sync", {
      method: "POST",
      body: { conversations: upsert, removeConversationIds: remove }
    });
    if (res?.workspace) applyWorkspace(res.workspace);
    renderConversationList();
    if (state.activeConversationId) renderActiveChat();
  } catch (err) {
    showToast(err.message);
  }
}

async function handleConvAction(action, convId) {
  // Dispatch by storage backend: workspace conversation vs cloud room.
  const room = state.rooms.find((r) => r.id === convId);
  if (room) return handleRoomAction(action, room);
  const conv = state.workspace.conversations.find((c) => c.id === convId);
  if (!conv) return;
  // Metadata-only patches: send just the fields that change + id. Stripping
  // `messages` is critical — including a stale local copy would trigger
  // server-side merge against the latest cloud history.
  if (action === "pin") {
    await syncWorkspaceChange({ upsert: [{ id: conv.id, pinned: !conv.pinned }] });
    return;
  }
  if (action === "rename") {
    const title = window.prompt("新会话名称：", conv.title || "");
    if (title === null) return;
    const trimmed = String(title).trim();
    if (!trimmed) return;
    await syncWorkspaceChange({ upsert: [{ id: conv.id, title: trimmed }] });
    return;
  }
  if (action === "delete") {
    if (!window.confirm(`确认删除"${conv.title || "本地对话"}"？此操作会从云端永久移除该会话历史。`)) return;
    await syncWorkspaceChange({ remove: [convId] });
    return;
  }
}

// Cloud rooms (DM + group). Hits PATCH/DELETE /api/rooms (commit 90671e4).
async function handleRoomAction(action, room) {
  const title = roomDisplayTitle(room);
  if (action === "pin") {
    setRoomPinned(room.id, !isRoomPinned(room.id));
    renderConversationList();
    return;
  }
  if (action === "rename") {
    if (room.id.startsWith("dm:")) return; // Hidden in menu; defensive.
    const next = window.prompt("编辑群组名称：", room.name || "");
    if (next === null) return;
    const trimmed = String(next).trim();
    if (!trimmed) return;
    try {
      const res = await api(`/api/rooms/${room.id}`, { method: "PATCH", body: { name: trimmed } });
      if (res?.room) {
        state.rooms = state.rooms.map((r) => (r.id === room.id ? { ...r, ...res.room } : r));
        renderConversationList();
      }
    } catch (err) {
      showToast(err.message || "重命名失败");
    }
    return;
  }
  if (action === "delete") {
    if (!window.confirm(`确认删除"${title}"？此操作不可撤销，所有成员都将无法访问。`)) return;
    try {
      await api(`/api/rooms/${room.id}`, { method: "DELETE" });
      state.rooms = state.rooms.filter((r) => r.id !== room.id);
      state.unread.delete(room.id);
      state.roomMembersCache.delete(room.id);
      if (state.activeConversationId === room.id) state.activeConversationId = "";
      renderConversationList();
      renderActiveChat();
    } catch (err) {
      showToast(err.message || "删除失败");
    }
    return;
  }
}

// ── active chat view ───────────────────────────────────────────────────────

function buildRoomMessageArticle(msg, room) {
  // Sender resolution routes through the canonical adapter (cloud-room-source).
  // Web reads only MessageSpec fields — no schema branching here.
  const members = state.roomMembersCache.get(room.id) || [];
  const ctx = { self: state.user, friends: state.friends, fellows: [] };
  const source = window.aimashiCloudRoomSource.createCloudRoomSource({
    room, messages: [msg], members, ctx
  });
  const spec = source.listMessages()[0];
  const isOwn = spec.isOwn;
  const senderLabel = spec.authorName;
  const senderAvatar = spec.avatar?.image || "";
  const senderCrop = spec.avatar?.crop || null;
  const senderColor = spec.avatar?.color || "";
  const cls = isOwn ? "message user" : "message assistant";
  const initial = isOwn
    ? (state.user?.username?.[0] || "M").toUpperCase()
    : (senderLabel?.[0] || "?").toUpperCase();
  const fallbackColor = isOwn ? "#0162db" : (senderColor || "#5e5ce6");
  const useAvatar = senderAvatar && (/^(https?:|data:|\.?\/assets\/)/i.test(senderAvatar));
  const avatarStyle = useAvatar
    ? avatarBackgroundStyle(senderAvatar, senderCrop, fallbackColor)
    : `background-color:${fallbackColor}; color:#fff; display:inline-flex; align-items:center; justify-content:center;`;
  const avatarText = useAvatar ? "" : escapeHtml(initial);
  const body = (spec.bodyMd || "").replace(/\n/g, "<br>");
  return `
    <article class="${cls}">
      <span class="avatar" style="${avatarStyle}">${avatarText}</span>
      <div class="message-stack">
        ${senderLabel && !isOwn ? `<span class="message-sender">${escapeHtml(senderLabel)}</span>` : ""}
        <div class="bubble">${escapeHtml(body).replace(/&lt;br&gt;/g, "<br>")}</div>
        <span class="message-time">${escapeHtml(formatMessageTime(spec.createdAt))}</span>
      </div>
    </article>
  `;
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

function buildDesktopMessageArticle(msg, conv) {
  const isOwn = msg.role === "user";
  const cls = isOwn ? "message user" : "message assistant";
  // Pick avatar source per side: assistant uses the conversation's fellow
  // image+crop; user uses the signed-in user's own profile avatar (synced
  // from desktop via PATCH /api/me/profile).
  const me = state.user;
  const senderImage = isOwn ? (me?.avatarImage || "") : (conv.avatar || "");
  const senderCrop = isOwn ? (me?.avatarCrop || null) : (conv.avatarCrop || null);
  const senderColor = isOwn ? (me?.avatarColor || "") : (conv.color || "");
  const initial = isOwn ? (me?.username?.[0] || "M").toUpperCase() : (conv.title?.[0] || "A").toUpperCase();
  const fallbackColor = isOwn ? (senderColor || "#0162db") : (senderColor || "#ff9f0a");
  const useAvatar = senderImage && (/^(https?:|data:|\.?\/assets\/)/i.test(senderImage));
  const avatarStyle = useAvatar
    ? avatarBackgroundStyle(senderImage, senderCrop, fallbackColor)
    : `background-color:${fallbackColor}; color:#fff; display:inline-flex; align-items:center; justify-content:center;`;
  const avatarText = useAvatar ? "" : escapeHtml(initial);
  const body = (msg.text || "").replace(/\n/g, "<br>");
  const commandResultHtml = !isOwn ? renderCommandResultHtml(msg.commandResult) : "";
  return `
    <article class="${cls}">
      <span class="avatar" style="${avatarStyle}">${avatarText}</span>
      <div class="message-stack">
        <div class="bubble">${escapeHtml(body).replace(/&lt;br&gt;/g, "<br>")}${commandResultHtml}</div>
        <span class="message-time">${escapeHtml(formatMessageTime(msg.createdAt))}</span>
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
    let friendAvatar = "";
    let friendCrop = null;
    let friendColor = "";
    if (isDM) {
      const parts = room.id.split(":");
      const otherId = parts[1] === state.user?.id ? parts[2] : parts[1];
      const friend = friendById(otherId);
      friendAvatar = friend?.avatarImage || "";
      friendCrop = friend?.avatarCrop || null;
      friendColor = friend?.avatarColor || "";
    }
    const useAvatar = friendAvatar && (/^(https?:|data:|\.?\/assets\/)/i.test(friendAvatar));
    if (useAvatar) {
      const styleStr = avatarBackgroundStyle(friendAvatar, friendCrop, friendColor || "#5e5ce6");
      els.activeAvatar.style.cssText = styleStr;
      els.activeAvatar.textContent = "";
    } else {
      els.activeAvatar.style.cssText = "";
      els.activeAvatar.style.backgroundImage = "";
      els.activeAvatar.style.backgroundColor = friendColor || (isDM ? "#5e5ce6" : "#34c759");
      els.activeAvatar.style.color = "#fff";
      els.activeAvatar.style.display = "inline-flex";
      els.activeAvatar.style.alignItems = "center";
      els.activeAvatar.style.justifyContent = "center";
      els.activeAvatar.textContent = (title[0] || "?").toUpperCase();
    }
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

  if (isWorkspaceConversationId(id)) {
    const conv = activeWorkspaceConversation();
    if (!conv) { setComposerEnabled(false, "对话不存在"); return; }
    els.activeAvatar.textContent = "";
    const useAvatar = conv.avatar && (/^(https?:|data:|\.?\/assets\/)/i.test(conv.avatar));
    if (useAvatar) {
      const preset = AVATAR_PRESETS[conv.avatar];
      const cropToUse = conv.avatarCrop && !(
        Math.abs(Number(conv.avatarCrop.x) - 50) < 0.01 &&
        Math.abs(Number(conv.avatarCrop.y) - 50) < 0.01 &&
        Math.abs(Number(conv.avatarCrop.zoom || 1) - 1) < 0.001
      ) ? conv.avatarCrop : preset || { x: 50, y: 50, zoom: 1 };
      const zoom = Number(cropToUse.zoom) || 1;
      els.activeAvatar.style.backgroundImage = `url('${conv.avatar}')`;
      els.activeAvatar.style.backgroundSize = `${Math.round(zoom * 100)}%`;
      els.activeAvatar.style.backgroundPosition = `${Number(cropToUse.x) || 50}% ${Number(cropToUse.y) || 50}%`;
      els.activeAvatar.style.backgroundRepeat = "no-repeat";
      els.activeAvatar.style.backgroundColor = "transparent";
    } else {
      els.activeAvatar.style.backgroundImage = "";
      els.activeAvatar.style.backgroundColor = conv.color || "#ff9f0a";
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
  state.unread.delete(id);
  if (isRoomId(id)) {
    await ensureRoomMessages(id);
    await ensureRoomMembers(id);
  }
  renderConversationList();
  renderActiveChat();
  renderRailUnreadBadge();
}

async function sendInActive() {
  const id = state.activeConversationId;
  if (!id) return;
  const rawText = els.chatInput.value || "";
  const members = isRoomId(id) ? (state.roomMembersCache.get(id) || []) : [];
  let prepared;
  try {
    prepared = prepareOutgoingMessage({ text: rawText }, { members });
  } catch (err) {
    if (err && err.code === "EMPTY_MESSAGE") return;
    showToast(err.message);
    return;
  }
  const text = prepared.bodyMd;

  if (isRoomId(id)) {
    els.chatInput.value = "";
    try {
      const res = await api(`/api/rooms/${id}/messages`, {
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

  if (isWorkspaceConversationId(id)) {
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
  // Reflect current appearance state into the inputs every time the dialog
  // opens so it survives external mutations (multiple tabs, reset action).
  const ap = window.aimashiAppearance?.get?.() || {};
  if (els.appearanceTheme) els.appearanceTheme.value = ap.theme || "light";
  if (els.appearanceListStyle) els.appearanceListStyle.value = ap.listStyle || "card";
  if (els.appearanceSelectionStyle) els.appearanceSelectionStyle.value = ap.selectionStyle || "soft";
  if (els.appearanceHoverBackground) els.appearanceHoverBackground.checked = ap.hoverBackground !== false;
  if (els.appearanceAccentColor) els.appearanceAccentColor.value = ap.accentColor || "#5e5ce6";
  if (els.appearanceUserBubbleColor) els.appearanceUserBubbleColor.value = ap.userBubbleColor || "#0162db";
  if (els.appearanceShowUserAvatar) els.appearanceShowUserAvatar.checked = ap.showUserAvatar !== false;
  if (els.appearanceShowAssistantAvatar) els.appearanceShowAssistantAvatar.checked = ap.showAssistantAvatar !== false;
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
function bindAppearanceInput(el, key, getValue) {
  if (!el) return;
  el.addEventListener("change", () => {
    window.aimashiAppearance?.update({ [key]: getValue(el) });
  });
  // Color pickers also fire "input" — capture so the page reacts live.
  if (el.type === "color") {
    el.addEventListener("input", () => {
      window.aimashiAppearance?.update({ [key]: getValue(el) });
    });
  }
}
bindAppearanceInput(els.appearanceTheme, "theme", (e) => e.value);
bindAppearanceInput(els.appearanceListStyle, "listStyle", (e) => e.value);
bindAppearanceInput(els.appearanceSelectionStyle, "selectionStyle", (e) => e.value);
bindAppearanceInput(els.appearanceHoverBackground, "hoverBackground", (e) => e.checked);
bindAppearanceInput(els.appearanceAccentColor, "accentColor", (e) => e.value);
bindAppearanceInput(els.appearanceUserBubbleColor, "userBubbleColor", (e) => e.value);
bindAppearanceInput(els.appearanceShowUserAvatar, "showUserAvatar", (e) => e.checked);
bindAppearanceInput(els.appearanceShowAssistantAvatar, "showAssistantAvatar", (e) => e.checked);

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
