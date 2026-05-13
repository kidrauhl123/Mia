const storageKeys = {
  token: "aimashi.mobile.token",
  baseUrl: "aimashi.mobile.baseUrl",
  mode: "aimashi.mobile.mode",
  relayUrl: "aimashi.mobile.relayUrl",
  deviceId: "aimashi.mobile.deviceId",
  secret: "aimashi.mobile.secret"
};

const DEFAULT_AVATAR_VERSION = "white-circle-1";

const els = {
  setupView: document.getElementById("setupView"),
  mainView: document.getElementById("mainView"),
  setupError: document.getElementById("setupError"),
  baseUrlInput: document.getElementById("baseUrlInput"),
  tokenInput: document.getElementById("tokenInput"),
  savePairing: document.getElementById("savePairing"),
  pageTitle: document.getElementById("pageTitle"),
  connectionMeta: document.getElementById("connectionMeta"),
  fellowMeta: document.getElementById("fellowMeta"),
  refreshButton: document.getElementById("refreshButton"),
  conversationList: document.getElementById("conversationList"),
  fellowList: document.getElementById("fellowList"),
  listView: document.getElementById("listView"),
  fellowsView: document.getElementById("fellowsView"),
  settingsPane: document.getElementById("settingsPane"),
  settingsBaseUrl: document.getElementById("settingsBaseUrl"),
  settingsToken: document.getElementById("settingsToken"),
  saveSettings: document.getElementById("saveSettings"),
  clearPairing: document.getElementById("clearPairing"),
  chatView: document.getElementById("chatView"),
  backButton: document.getElementById("backButton"),
  chatAvatar: document.getElementById("chatAvatar"),
  chatTitle: document.getElementById("chatTitle"),
  chatMeta: document.getElementById("chatMeta"),
  newSessionButton: document.getElementById("newSessionButton"),
  messageList: document.getElementById("messageList"),
  composer: document.getElementById("composer"),
  chatInput: document.getElementById("chatInput"),
  sendButton: document.getElementById("sendButton"),
  bottomNav: document.getElementById("bottomNav")
};

const state = {
  mode: "direct",
  token: "",
  baseUrl: location.origin,
  relayUrl: "",
  deviceId: "",
  secret: "",
  relaySocket: null,
  relayReady: false,
  relayRequests: new Map(),
  health: null,
  fellows: [],
  defaultFellow: "",
  sessions: { schema_version: 1, readAt: {}, sessions: {} },
  activeTab: "messages",
  activeFellowKey: "",
  activeSessionId: "",
  pendingBySession: new Map(),
  sending: false,
  status: ""
};

function setText(el, value) {
  if (el) el.textContent = value;
}

function randomId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeBaseUrl(value) {
  try {
    return new URL(String(value || location.origin).trim()).origin;
  } catch {
    return location.origin;
  }
}

function defaultRelayUrl() {
  const url = new URL(location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/relay";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function readPairingFromHash() {
  const query = new URLSearchParams(location.search);
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const params = new URLSearchParams(hash);
  const deviceId = query.get("device") || "";
  const relayMode = query.get("mode") === "relay" || Boolean(deviceId);
  const secret = params.get("secret") || "";
  if (relayMode && deviceId && secret) {
    state.mode = "relay";
    state.deviceId = deviceId;
    state.secret = secret;
    state.relayUrl = query.get("relay") || defaultRelayUrl();
    localStorage.setItem(storageKeys.mode, "relay");
    localStorage.setItem(storageKeys.deviceId, state.deviceId);
    localStorage.setItem(storageKeys.secret, state.secret);
    localStorage.setItem(storageKeys.relayUrl, state.relayUrl);
    history.replaceState(null, document.title, `${location.pathname}${query.toString() ? `?${query.toString()}` : ""}`);
    return;
  }
  const token = params.get("token") || "";
  if (!token) return;
  state.mode = "direct";
  state.token = token;
  state.baseUrl = location.origin;
  localStorage.setItem(storageKeys.mode, "direct");
  localStorage.setItem(storageKeys.token, token);
  localStorage.setItem(storageKeys.baseUrl, state.baseUrl);
  history.replaceState(null, document.title, `${location.pathname}${location.search}`);
}

function loadStoredPairing() {
  readPairingFromHash();
  state.mode = state.mode || localStorage.getItem(storageKeys.mode) || "direct";
  if (localStorage.getItem(storageKeys.mode) === "relay") {
    state.mode = "relay";
    state.relayUrl = localStorage.getItem(storageKeys.relayUrl) || defaultRelayUrl();
    state.deviceId = localStorage.getItem(storageKeys.deviceId) || "";
    state.secret = localStorage.getItem(storageKeys.secret) || "";
  }
  state.token = state.token || localStorage.getItem(storageKeys.token) || "";
  state.baseUrl = normalizeBaseUrl(localStorage.getItem(storageKeys.baseUrl) || location.origin);
}

function savePairing(baseUrl, token) {
  state.mode = "direct";
  state.baseUrl = normalizeBaseUrl(baseUrl || location.origin);
  state.token = String(token || "").trim();
  localStorage.setItem(storageKeys.mode, "direct");
  localStorage.setItem(storageKeys.baseUrl, state.baseUrl);
  localStorage.setItem(storageKeys.token, state.token);
}

function apiUrl(path) {
  return new URL(path, state.baseUrl).toString();
}

function relaySend(payload) {
  if (!state.relaySocket || state.relaySocket.readyState !== WebSocket.OPEN) return false;
  state.relaySocket.send(JSON.stringify(payload));
  return true;
}

function handleRelayMessage(raw) {
  let message = null;
  try {
    message = JSON.parse(String(raw.data || raw || ""));
  } catch {
    return;
  }
  if (message.type === "ready") {
    state.relayReady = true;
    state.status = `已通过 Relay 连接 ${message.device?.name || "Aimashi"}`;
    render();
    return;
  }
  if (message.type === "device_offline") {
    state.status = "桌面端已离线";
    render();
    return;
  }
  if (message.type === "rpc_stream") {
    const pending = state.relayRequests.get(message.id);
    if (pending?.onStream) pending.onStream(message);
    return;
  }
  if (message.type === "rpc_result") {
    const pending = state.relayRequests.get(message.id);
    if (!pending) return;
    state.relayRequests.delete(message.id);
    if (message.ok) pending.resolve(message.data || {});
    else pending.reject(new Error(message.error || "Relay request failed."));
    return;
  }
  if (message.type === "error") {
    state.status = `Relay 错误：${message.error || "连接失败"}`;
    render();
  }
}

function ensureRelayConnected() {
  if (state.relaySocket?.readyState === WebSocket.OPEN && state.relayReady) {
    return Promise.resolve();
  }
  if (state.relaySocket?.readyState === WebSocket.CONNECTING) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (state.relaySocket?.readyState === WebSocket.OPEN && state.relayReady) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - startedAt > 8000) {
          clearInterval(timer);
          reject(new Error("Relay connection timed out."));
        }
      }, 100);
    });
  }
  return new Promise((resolve, reject) => {
    if (!state.deviceId || !state.secret) {
      reject(new Error("缺少远程配对信息。"));
      return;
    }
    state.relayReady = false;
    state.relaySocket = new WebSocket(state.relayUrl || defaultRelayUrl());
    const timeout = setTimeout(() => {
      reject(new Error("Relay connection timed out."));
    }, 8000);
    state.relaySocket.addEventListener("open", () => {
      relaySend({
        type: "hello",
        role: "mobile",
        deviceId: state.deviceId,
        secret: state.secret
      });
    });
    state.relaySocket.addEventListener("message", (event) => {
      handleRelayMessage(event);
      if (state.relayReady) {
        clearTimeout(timeout);
        resolve();
      }
    });
    state.relaySocket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Relay connection failed."));
    }, { once: true });
    state.relaySocket.addEventListener("close", () => {
      state.relayReady = false;
      if (state.mode === "relay") {
        state.status = "Relay 已断开";
        render();
      }
    });
  });
}

async function relayRequest(path, options = {}, onStream = null) {
  await ensureRelayConnected();
  const id = randomId();
  let body = null;
  if (options.body) {
    body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
  }
  return new Promise((resolve, reject) => {
    state.relayRequests.set(id, { resolve, reject, onStream });
    relaySend({
      type: "rpc",
      id,
      method: String(options.method || "GET").toUpperCase(),
      path,
      body
    });
    setTimeout(() => {
      if (!state.relayRequests.has(id)) return;
      state.relayRequests.delete(id);
      reject(new Error("Relay request timed out."));
    }, path === "/api/chat/stream" ? 10 * 60 * 1000 : 30000);
  });
}

async function request(path, options = {}) {
  if (state.mode === "relay") {
    return relayRequest(path, options);
  }
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(apiUrl(path), {
    ...options,
    headers
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
  }
  if (!response.ok) {
    const error = new Error(data?.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return data || {};
}

async function loadHealth() {
  try {
    if (state.mode === "relay") {
      await ensureRelayConnected();
      state.health = { status: "ok", service: "aimashi-relay" };
      state.status = "已通过 Relay 连接";
      return;
    }
    state.health = await request("/health", { headers: new Headers() });
    state.status = `已连接 ${state.baseUrl}`;
  } catch (error) {
    state.health = null;
    state.status = `连接失败：${error.message}`;
  }
}

async function loadData() {
  if (state.mode === "direct" && !state.token) {
    renderSetup();
    return;
  }
  if (state.mode === "relay" && (!state.deviceId || !state.secret)) {
    renderSetup();
    return;
  }
  await loadHealth();
  try {
    const [fellows, sessions] = await Promise.all([
      request("/api/fellows"),
      request("/api/chat/sessions")
    ]);
    state.fellows = Array.isArray(fellows.fellows) ? fellows.fellows : [];
    state.defaultFellow = fellows.defaultFellow || state.fellows[0]?.key || "";
    state.sessions = {
      schema_version: sessions.schema_version || 1,
      readAt: sessions.readAt || {},
      sessions: sessions.sessions || {}
    };
    render();
  } catch (error) {
    if (state.mode === "direct" && error.status === 401) {
      state.token = "";
      localStorage.removeItem(storageKeys.token);
      setText(els.setupError, "配对已失效，请从桌面端重新复制链接。");
      renderSetup();
      return;
    }
    state.status = `读取失败：${error.message}`;
    render();
  }
}

function sortedFellows() {
  return [...state.fellows].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return String(a.name || a.key).localeCompare(String(b.name || b.key), "zh-Hans-CN");
  });
}

function sessionsFor(fellowKey) {
  const sessions = Array.isArray(state.sessions.sessions?.[fellowKey])
    ? state.sessions.sessions[fellowKey]
    : [];
  return [...sessions].sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
}

function activeFellow() {
  if (!state.activeFellowKey) return null;
  return state.fellows.find((fellow) => fellow.key === state.activeFellowKey) || null;
}

function activeSession() {
  const sessions = sessionsFor(state.activeFellowKey);
  return sessions.find((session) => session.id === state.activeSessionId) || sessions[0] || null;
}

function upsertSession(fellowKey, session) {
  if (!session?.id) return;
  const current = Array.isArray(state.sessions.sessions[fellowKey])
    ? state.sessions.sessions[fellowKey]
    : [];
  state.sessions.sessions[fellowKey] = [
    session,
    ...current.filter((item) => item.id !== session.id)
  ];
}

function pendingKey(fellowKey, sessionId) {
  return `${fellowKey || ""}:${sessionId || "new"}`;
}

function messagesForActiveSession() {
  const session = activeSession();
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const key = pendingKey(state.activeFellowKey, session?.id || state.activeSessionId || "new");
  return [...messages, ...(state.pendingBySession.get(key) || [])];
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function messagePreview(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const last = [...messages].reverse().find((message) => String(message.content || "").trim());
  return last ? String(last.content || "").replace(/\s+/g, " ").trim() : "还没有消息";
}

function initials(name) {
  const text = String(name || "?").trim();
  return text.slice(0, 2).toUpperCase();
}

function avatarAssetForKey(key = "") {
  let hash = 0;
  for (const char of String(key || "aimashi")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const index = (hash % 16) + 1;
  return `./assets/avatars/${String(index).padStart(2, "0")}.png`;
}

function avatarUrl(value, preferThumb = true) {
  const raw = String(value || "").trim().replace("/assets/avatar-icons/", "/assets/avatars/").replace("./assets/avatar-icons/", "./assets/avatars/");
  if (!raw) return "";
  if (/^(data:|https?:)/i.test(raw)) return raw;
  if (raw.startsWith("./assets/")) {
    const asset = preferThumb && raw.includes("/avatars/")
      ? raw.replace("/avatars/", "/avatar-thumbs/")
      : raw;
    const path = `/${asset.slice(2)}`;
    return /^\/assets\/avatar(?:s|-thumbs)\//.test(path) ? `${path}?v=${DEFAULT_AVATAR_VERSION}` : path;
  }
  if (raw.startsWith("/assets/")) {
    const asset = preferThumb && raw.includes("/avatars/")
      ? raw.replace("/avatars/", "/avatar-thumbs/")
      : raw;
    return /^\/assets\/avatar(?:s|-thumbs)\//.test(asset) ? `${asset}?v=${DEFAULT_AVATAR_VERSION}` : asset;
  }
  return "";
}

function avatarImg(fellow, preferThumb = true) {
  const image = fellow?.avatarImage || avatarAssetForKey(fellow?.key);
  const src = avatarUrl(image, preferThumb);
  return src ? `<img src="${escapeHtml(src)}" alt="">` : escapeHtml(initials(fellow?.name || fellow?.key));
}

function renderAvatar(fellow) {
  return `<span class="avatar">${avatarImg(fellow)}</span>`;
}

function renderSetup() {
  els.setupView.classList.remove("hidden");
  els.mainView.classList.add("hidden");
  els.baseUrlInput.value = state.baseUrl || location.origin;
  els.tokenInput.value = state.token || "";
}

function renderShell() {
  els.setupView.classList.add("hidden");
  els.mainView.classList.remove("hidden");
  setText(els.connectionMeta, state.status || (state.mode === "relay" ? "Relay 连接" : `已连接 ${state.baseUrl}`));
  setText(els.fellowMeta, `${state.fellows.length} 个伙伴`);
  els.settingsBaseUrl.value = state.mode === "relay" ? state.relayUrl : state.baseUrl;
  els.settingsToken.value = state.mode === "relay" ? state.deviceId : state.token;
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === state.activeTab);
  });
  els.listView.classList.toggle("hidden", state.activeTab !== "messages");
  els.fellowsView.classList.toggle("hidden", state.activeTab !== "fellows");
  els.settingsPane.classList.toggle("hidden", state.activeTab !== "settings");
}

function renderConversationList() {
  if (!state.fellows.length) {
    els.conversationList.innerHTML = `<div class="empty">还没有伙伴</div>`;
    return;
  }
  els.conversationList.innerHTML = sortedFellows().map((fellow) => {
    const session = sessionsFor(fellow.key)[0];
    return `
      <button class="conversation-row" type="button" data-open-chat="${escapeHtml(fellow.key)}">
        ${renderAvatar(fellow)}
        <span class="row-main">
          <span class="row-title">
            <strong>${escapeHtml(fellow.name || fellow.key)}</strong>
            <time>${escapeHtml(formatTime(session?.updatedAt || session?.createdAt))}</time>
          </span>
          <p>${escapeHtml(messagePreview(session))}</p>
        </span>
      </button>
    `;
  }).join("");
  els.conversationList.querySelectorAll("[data-open-chat]").forEach((button) => {
    button.addEventListener("click", () => openChat(button.dataset.openChat));
  });
}

function renderFellowList() {
  if (!state.fellows.length) {
    els.fellowList.innerHTML = `<div class="empty">还没有伙伴</div>`;
    return;
  }
  els.fellowList.innerHTML = sortedFellows().map((fellow) => `
    <button class="fellow-row" type="button" data-open-fellow="${escapeHtml(fellow.key)}">
      ${renderAvatar(fellow)}
      <span class="row-main">
        <span class="row-title">
          <strong>${escapeHtml(fellow.name || fellow.key)}</strong>
          <time>${escapeHtml((fellow.agentEngine || "hermes").toUpperCase())}</time>
        </span>
        <p>${escapeHtml(fellow.bio || "Aimashi 伙伴")}</p>
      </span>
    </button>
  `).join("");
  els.fellowList.querySelectorAll("[data-open-fellow]").forEach((button) => {
    button.addEventListener("click", () => openChat(button.dataset.openFellow));
  });
}

function renderChat() {
  const fellow = activeFellow();
  const session = activeSession();
  els.chatView.classList.toggle("hidden", !fellow);
  els.bottomNav.classList.toggle("hidden", Boolean(fellow));
  if (!fellow) return;
  els.chatAvatar.removeAttribute("style");
  els.chatAvatar.innerHTML = avatarImg(fellow);
  setText(els.chatTitle, fellow.name || fellow.key);
  setText(els.chatMeta, state.sending ? "正在回复" : (session?.title || "在线"));
  const messages = messagesForActiveSession();
  els.messageList.innerHTML = messages.length ? messages.map((message) => `
    <article class="message ${message.role === "user" ? "user" : "assistant"}">
      <div class="bubble">${escapeHtml(message.content || (message.streaming ? "..." : ""))}</div>
      <time>${escapeHtml(formatTime(message.createdAt))}</time>
    </article>
  `).join("") : `<div class="empty">开始和 ${escapeHtml(fellow.name || fellow.key)} 聊天</div>`;
  els.sendButton.disabled = state.sending || !els.chatInput.value.trim();
  setTimeout(() => {
    els.messageList.scrollTop = els.messageList.scrollHeight;
  }, 0);
}

function render() {
  if (state.mode === "direct" && !state.token) {
    renderSetup();
    return;
  }
  if (state.mode === "relay" && (!state.deviceId || !state.secret)) {
    renderSetup();
    return;
  }
  renderShell();
  renderConversationList();
  renderFellowList();
  renderChat();
}

function openChat(fellowKey) {
  state.activeFellowKey = fellowKey;
  state.activeSessionId = sessionsFor(fellowKey)[0]?.id || "";
  render();
}

function closeChat() {
  state.activeFellowKey = "";
  state.activeSessionId = "";
  render();
}

async function createNewSession() {
  const fellow = activeFellow();
  if (!fellow) return;
  const store = await request("/api/chat/session", {
    method: "POST",
    body: JSON.stringify({ personaKey: fellow.key })
  });
  state.sessions = {
    schema_version: store.schema_version || 1,
    readAt: store.readAt || {},
    sessions: store.sessions || {}
  };
  state.activeSessionId = sessionsFor(fellow.key)[0]?.id || "";
  render();
}

function parseSseFrame(frame) {
  const lines = String(frame || "").split(/\r?\n/);
  let event = "message";
  const data = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join("\n") };
}

function updatePendingAssistant(key, text) {
  const pending = state.pendingBySession.get(key) || [];
  const assistant = pending.find((message) => message.role === "assistant");
  if (assistant) assistant.content += text;
  renderChat();
}

async function relayStreamMessage({ fellowKey, sessionId, text, pendingKeyValue }) {
  let finalResult = null;
  const result = await relayRequest("/api/chat/stream", {
    method: "POST",
    body: JSON.stringify({ fellowKey, sessionId, text })
  }, (message) => {
    if (message.event === "chat") {
      const envelope = message.data || {};
      if (envelope.kind === "text_delta") {
        updatePendingAssistant(pendingKeyValue, String(envelope.data?.text || ""));
      }
      if (envelope.kind === "status") {
        setText(els.chatMeta, String(envelope.data?.text || "正在回复"));
      }
      return;
    }
    if (message.event === "result") {
      finalResult = message.data || null;
      return;
    }
    if (message.event === "error") {
      setText(els.chatMeta, message.data?.error || "生成失败");
    }
  });
  return finalResult || result;
}

async function streamMessage({ fellowKey, sessionId, text, pendingKeyValue }) {
  if (state.mode === "relay") {
    return relayStreamMessage({ fellowKey, sessionId, text, pendingKeyValue });
  }
  const response = await fetch(apiUrl("/api/chat/stream"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.token}`
    },
    body: JSON.stringify({ fellowKey, sessionId, text })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  if (!response.body?.getReader) {
    const result = await request("/api/chat/send", {
      method: "POST",
      body: JSON.stringify({ fellowKey, sessionId, text })
    });
    return result;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const parsed = parseSseFrame(frame);
      if (parsed.event === "chat") {
        const envelope = JSON.parse(parsed.data || "{}");
        if (envelope.kind === "text_delta") {
          updatePendingAssistant(pendingKeyValue, String(envelope.data?.text || ""));
        }
        if (envelope.kind === "status") {
          setText(els.chatMeta, String(envelope.data?.text || "正在回复"));
        }
      } else if (parsed.event === "result") {
        finalResult = JSON.parse(parsed.data || "{}");
      } else if (parsed.event === "error") {
        const payload = JSON.parse(parsed.data || "{}");
        throw new Error(payload.error || "生成失败");
      }
      index = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) {
    const parsed = parseSseFrame(buffer);
    if (parsed.event === "result") finalResult = JSON.parse(parsed.data || "{}");
    if (parsed.event === "error") {
      const payload = JSON.parse(parsed.data || "{}");
      throw new Error(payload.error || "生成失败");
    }
  }
  return finalResult;
}

async function sendMessage() {
  const fellow = activeFellow();
  if (!fellow || state.sending) return;
  const text = els.chatInput.value.trim();
  if (!text) return;
  const session = activeSession();
  const key = pendingKey(fellow.key, session?.id || state.activeSessionId || "new");
  state.pendingBySession.set(key, [
    { role: "user", content: text, createdAt: new Date().toISOString() },
    { role: "assistant", content: "", createdAt: new Date().toISOString(), streaming: true }
  ]);
  els.chatInput.value = "";
  autosizeComposer();
  state.sending = true;
  renderChat();
  try {
    const result = await streamMessage({
      fellowKey: fellow.key,
      sessionId: session?.id || "",
      text,
      pendingKeyValue: key
    });
    if (result?.session) {
      upsertSession(fellow.key, result.session);
      state.activeSessionId = result.session.id;
    }
    state.pendingBySession.delete(key);
    await loadData();
  } catch (error) {
    const pending = state.pendingBySession.get(key) || [];
    const assistant = pending.find((message) => message.role === "assistant");
    if (assistant) assistant.content = `发送失败：${error.message}`;
  } finally {
    state.sending = false;
    renderChat();
  }
}

function autosizeComposer() {
  const input = els.chatInput;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
  els.sendButton.disabled = state.sending || !input.value.trim();
}

els.savePairing.addEventListener("click", async () => {
  savePairing(els.baseUrlInput.value, els.tokenInput.value);
  setText(els.setupError, "");
  await loadData();
});

els.refreshButton.addEventListener("click", loadData);
els.backButton.addEventListener("click", closeChat);
els.newSessionButton.addEventListener("click", () => {
  createNewSession().catch((error) => {
    setText(els.chatMeta, `新对话失败：${error.message}`);
  });
});
els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});
els.chatInput.addEventListener("input", autosizeComposer);
els.chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

document.querySelectorAll("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    state.activeTab = button.dataset.tab || "messages";
    closeChat();
    render();
  });
});

els.saveSettings.addEventListener("click", async () => {
  savePairing(els.settingsBaseUrl.value, els.settingsToken.value);
  await loadData();
});

els.clearPairing.addEventListener("click", () => {
  localStorage.removeItem(storageKeys.baseUrl);
  localStorage.removeItem(storageKeys.token);
  localStorage.removeItem(storageKeys.mode);
  localStorage.removeItem(storageKeys.relayUrl);
  localStorage.removeItem(storageKeys.deviceId);
  localStorage.removeItem(storageKeys.secret);
  state.relaySocket?.close?.();
  state.mode = "direct";
  state.token = "";
  state.baseUrl = location.origin;
  state.deviceId = "";
  state.secret = "";
  state.relayUrl = "";
  renderSetup();
});

loadStoredPairing();
render();
loadData();
