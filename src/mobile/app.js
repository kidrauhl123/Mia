const storageKeys = {
  token: "aimashi.mobile.token",
  baseUrl: "aimashi.mobile.baseUrl",
  mode: "aimashi.mobile.mode",
  relayUrl: "aimashi.mobile.relayUrl",
  deviceId: "aimashi.mobile.deviceId",
  secret: "aimashi.mobile.secret"
};

const DEFAULT_AVATAR_VERSION = "white-circle-1";
const fallbackSlashCommands = [
  { command: "/new", description: "Start a new session (fresh session ID + history)" },
  { command: "/topic", description: "Enable or inspect Telegram DM topic sessions" },
  { command: "/retry", description: "Retry the last message (resend to agent)" },
  { command: "/undo", description: "Remove the last user/assistant exchange" },
  { command: "/title", description: "Set a title for the current session" },
  { command: "/branch", description: "Branch the current session (explore a different path)" },
  { command: "/compress", description: "Manually compress conversation context" },
  { command: "/rollback", description: "List or restore filesystem checkpoints" },
  { command: "/commands", description: "Browse all commands and skills" },
  { command: "/help", description: "Show available commands" }
];

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
  sessionSelect: document.getElementById("sessionSelect"),
  modelSelect: document.getElementById("modelSelect"),
  effortSelect: document.getElementById("effortSelect"),
  permissionSelect: document.getElementById("permissionSelect"),
  messageList: document.getElementById("messageList"),
  attachmentInput: document.getElementById("attachmentInput"),
  attachmentTray: document.getElementById("attachmentTray"),
  attachButton: document.getElementById("attachButton"),
  slashCommandMenu: document.getElementById("slashCommandMenu"),
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
  runtime: null,
  modelCatalog: [],
  codexModels: [],
  engineCapabilities: { approvalModes: ["ask", "yolo", "deny"], effortLevels: ["low", "medium", "high"] },
  slashCommands: fallbackSlashCommands,
  agentSlashCommands: { "claude-code": [], codex: [] },
  fellows: [],
  defaultFellow: "",
  sessions: { schema_version: 1, readAt: {}, sessions: {} },
  activeTab: "messages",
  activeFellowKey: "",
  activeSessionId: "",
  pendingBySession: new Map(),
  pendingAttachments: [],
  generatedFiles: new Map(),
  slashMenuOpen: false,
  slashSelectedIndex: 0,
  slashFilter: "",
  sending: false,
  uploadingAttachments: 0,
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

function renderInlineMarkdown(value) {
  const codes = [];
  const protectedText = String(value || "").replace(/`([^`\n]+)`/g, (_match, code) => {
    const index = codes.push(code) - 1;
    return `@@AIMASHI_INLINE_CODE_${index}@@`;
  });
  let html = escapeHtml(protectedText);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\n/g, "<br>");
  for (let index = 0; index < codes.length; index++) {
    html = html.replace(
      `@@AIMASHI_INLINE_CODE_${index}@@`,
      `<code class="inline-code" tabindex="0" title="点击复制">${escapeHtml(codes[index])}</code>`
    );
  }
  return html;
}

function codeLanguageId(language = "") {
  const raw = String(language || "").trim().toLowerCase();
  const aliases = {
    javascript: "js",
    typescript: "ts",
    shell: "bash",
    sh: "bash",
    zsh: "bash",
    yml: "yaml"
  };
  return aliases[raw] || raw || "text";
}

function codeLanguageLabel(language = "") {
  const id = codeLanguageId(language);
  const labels = {
    js: "JavaScript",
    jsx: "JSX",
    ts: "TypeScript",
    tsx: "TSX",
    json: "JSON",
    bash: "Shell",
    yaml: "YAML",
    html: "HTML",
    css: "CSS",
    py: "Python",
    text: "Text"
  };
  return labels[id] || id.toUpperCase();
}

function highlightPlainSegment(segment, language) {
  const id = codeLanguageId(language);
  const keywords = id === "bash"
    ? new Set(["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "in", "function", "return", "export", "local", "set"])
    : new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "class", "extends", "new", "try", "catch", "finally", "throw", "async", "await", "import", "from", "export", "default", "typeof", "instanceof", "in", "of", "this", "super"]);
  const source = String(segment || "");
  const tokenPattern = /--?[A-Za-z0-9][\w-]*|\b[A-Za-z_$][\w$-]*\b|\b\d+(?:\.\d+)?\b|[=!<>|&+\-*/%?:.,;()[\]{}]+/g;
  let cursor = 0;
  let html = "";
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    const offset = match.index ?? 0;
    if (offset > cursor) html += escapeHtml(source.slice(cursor, offset));
    const escaped = escapeHtml(token);
    if (/^\d/.test(token)) html += `<span class="syntax-number">${escaped}</span>`;
    else if (id === "bash" && token.startsWith("-")) html += `<span class="syntax-parameter">${escaped}</span>`;
    else if (/^[=!<>|&+\-*/%?:]+$/.test(token)) html += `<span class="syntax-operator">${escaped}</span>`;
    else if (/^[.,;()[\]{}]+$/.test(token)) html += `<span class="syntax-punctuation">${escaped}</span>`;
    else if (keywords.has(token)) html += `<span class="syntax-keyword">${escaped}</span>`;
    else if (["true", "false", "null", "undefined"].includes(token)) html += `<span class="syntax-literal">${escaped}</span>`;
    else {
      const before = source.slice(0, offset).replace(/\s+$/g, "");
      const after = source.slice(offset + token.length).replace(/^\s+/g, "");
      if (before.endsWith(".")) html += `<span class="syntax-property">${escaped}</span>`;
      else if (after.startsWith("(")) html += `<span class="syntax-function">${escaped}</span>`;
      else if (/^[A-Z][A-Za-z0-9_$]*$/.test(token)) html += `<span class="syntax-class">${escaped}</span>`;
      else html += `<span class="syntax-variable">${escaped}</span>`;
    }
    cursor = offset + token.length;
  }
  if (cursor < source.length) html += escapeHtml(source.slice(cursor));
  return html;
}

function highlightCode(code, language = "") {
  const id = codeLanguageId(language);
  if (!["js", "jsx", "ts", "tsx", "json", "bash"].includes(id)) return escapeHtml(code);
  const source = String(code || "");
  const parts = [];
  const pattern = id === "json"
    ? /("(?:\\.|[^"\\])*")|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|\b(true|false|null)\b|([{}[\]:,])/gi
    : /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|(\$[A-Za-z_][\w]*|\$\{[^}]+\})/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(highlightPlainSegment(source.slice(cursor, index), id));
    const token = match[0];
    if (id === "json") {
      const after = source.slice(index + token.length).replace(/^\s+/g, "");
      if (match[1] && after.startsWith(":")) parts.push(`<span class="syntax-property">${escapeHtml(token)}</span>`);
      else if (match[1]) parts.push(`<span class="syntax-string">${escapeHtml(token)}</span>`);
      else if (match[2]) parts.push(`<span class="syntax-number">${escapeHtml(token)}</span>`);
      else if (match[3]) parts.push(`<span class="syntax-literal">${escapeHtml(token)}</span>`);
      else parts.push(`<span class="syntax-punctuation">${escapeHtml(token)}</span>`);
    } else if (match[1]) {
      parts.push(`<span class="syntax-string">${escapeHtml(token)}</span>`);
    } else if (match[2]) {
      parts.push(`<span class="syntax-comment">${escapeHtml(token)}</span>`);
    } else if (match[3]) {
      parts.push(`<span class="syntax-variable">${escapeHtml(token)}</span>`);
    }
    cursor = index + token.length;
  }
  if (cursor < source.length) parts.push(highlightPlainSegment(source.slice(cursor), id));
  return parts.join("");
}

function renderCodeBlock(code, language = "") {
  const lang = codeLanguageId(language).replace(/[^A-Za-z0-9_+.-]/g, "").slice(0, 24);
  return `
    <figure class="message-code-block" data-language="${escapeHtml(lang)}">
      <figcaption>
        <span>${escapeHtml(codeLanguageLabel(lang))}</span>
        <button type="button" data-copy-code aria-label="复制代码" title="复制代码">⧉</button>
      </figcaption>
      <pre><code class="syntax-code language-${escapeHtml(lang)}">${highlightCode(String(code || "").replace(/\n$/, ""), lang)}</code></pre>
    </figure>
  `;
}

function renderMarkdown(value) {
  const lines = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let fence = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join("\n"))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  const flushTextBlocks = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^```([A-Za-z0-9_+.-]*)\s*$/);
    if (fence) {
      if (fenceMatch) {
        html.push(renderCodeBlock(fence.lines.join("\n"), fence.language));
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      flushTextBlocks();
      fence = { language: fenceMatch[1] || "", lines: [] };
      continue;
    }
    if (!line.trim()) {
      flushTextBlocks();
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      flushTextBlocks();
      html.push('<hr class="message-divider">');
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushTextBlocks();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(unordered[1]);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }
    paragraph.push(line);
  }
  flushTextBlocks();
  if (fence) html.push(renderCodeBlock(fence.lines.join("\n"), fence.language));
  return html.join("");
}

function normalizeTraceText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[\s\u3000`*_~#>()[\]{}.,，。!?！？:：;；"'“”‘’、|/\\-]+/g, "");
}

function isDuplicateTraceReasoning(reasoning, content) {
  const reasoningText = normalizeTraceText(reasoning);
  const contentText = normalizeTraceText(content);
  if (!reasoningText || !contentText) return false;
  if (reasoningText === contentText) return true;
  const shorter = reasoningText.length <= contentText.length ? reasoningText : contentText;
  const longer = reasoningText.length > contentText.length ? reasoningText : contentText;
  return shorter.length >= 16 && longer.includes(shorter);
}

function traceReasoningForDisplay(reasoning, tools, content = "") {
  const text = String(reasoning || "").trim();
  if (!text) return "";
  const toolList = Array.isArray(tools) ? tools : [];
  if (isDuplicateTraceReasoning(text, content)) return "";
  if (!toolList.length) return "";
  return text;
}

function renderTraceBlocks({ reasoning, tools, content, expanded }) {
  const toolList = Array.isArray(tools) ? tools : [];
  const displayReasoning = traceReasoningForDisplay(reasoning, toolList, content);
  if (!displayReasoning && !toolList.length) return "";
  const rows = [];
  if (displayReasoning) {
    const preview = displayReasoning.slice(0, 80).replace(/\s+/g, " ");
    rows.push(`
      <details class="trace-row reasoning"${expanded ? " open" : ""}>
        <summary><span class="trace-chevron">▸</span><span class="trace-cmd">thinking</span><span class="trace-arg">${escapeHtml(preview)}</span></summary>
        <pre class="trace-body">${escapeHtml(displayReasoning)}</pre>
      </details>
    `);
  }
  for (const [idx, tool] of toolList.entries()) {
    const status = tool.status === "completed" ? "ok" : tool.status === "error" ? "err" : "run";
    const glyph = status === "ok" ? "✓" : status === "err" ? "✗" : "●";
    const meta = status === "run" ? "…" : (tool.duration != null ? `${Number(tool.duration).toFixed(2)}s` : "");
    const name = String(tool.name || "tool");
    const preview = String(tool.preview || "");
    const previewInline = preview.replace(/\s+/g, " ").slice(0, 100);
    rows.push(`
      <details class="trace-row tool" data-status="${status}"${expanded && idx === toolList.length - 1 ? " open" : ""}>
        <summary>
          <span class="trace-chevron">▸</span>
          <span class="trace-glyph">${glyph}</span>
          <span class="trace-cmd">${escapeHtml(name)}</span>
          ${previewInline ? `<span class="trace-arg">${escapeHtml(previewInline)}</span>` : ""}
          ${meta ? `<span class="trace-meta">${escapeHtml(meta)}</span>` : ""}
        </summary>
        ${preview ? `<pre class="trace-body">${escapeHtml(preview)}</pre>` : ""}
      </details>
    `);
  }
  return `<div class="trace">${rows.join("")}</div>`;
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
    // Use the textarea fallback below.
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

function flashCopiedCode(button) {
  button.classList.add("copied");
  clearTimeout(button._copiedTimer);
  button._copiedTimer = setTimeout(() => {
    button.classList.remove("copied");
  }, 900);
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

async function loadSlashCommands() {
  try {
    const result = await request("/api/commands/slash");
    const rows = Array.isArray(result?.rows) ? result.rows : (Array.isArray(result) ? result : []);
    state.slashCommands = rows.length ? rows : fallbackSlashCommands;
  } catch {
    state.slashCommands = fallbackSlashCommands;
  }
  await Promise.allSettled(["claude-code", "codex"].map(async (engine) => {
    try {
      const registry = await request(`/api/commands/agent-list?engine=${encodeURIComponent(engine)}`);
      const rows = Array.isArray(registry?.rows) ? registry.rows : (Array.isArray(registry) ? registry : []);
      state.agentSlashCommands[engine] = rows
        .filter((item) => item?.command || item?.name)
        .map((item) => ({
          ...item,
          command: String(item.command || item.name || "").startsWith("/")
            ? String(item.command || item.name || "")
            : `/${item.command || item.name}`,
          description: String(item.description || "")
        }));
    } catch {
      state.agentSlashCommands[engine] = [];
    }
  }));
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
    const [fellowsResult, sessionsResult, runtimeResult, catalogResult, capsResult, commandsResult, codexModelsResult] = await Promise.allSettled([
      request("/api/fellows"),
      request("/api/chat/sessions"),
      request("/api/runtime/status"),
      request("/api/model/catalog"),
      request("/api/engine/capabilities"),
      loadSlashCommands(),
      request("/api/codex/models")
    ]);
    if (fellowsResult.status === "rejected") throw fellowsResult.reason;
    if (sessionsResult.status === "rejected") throw sessionsResult.reason;
    const fellows = fellowsResult.value || {};
    const sessions = sessionsResult.value || {};
    state.fellows = Array.isArray(fellows.fellows) ? fellows.fellows : [];
    state.defaultFellow = fellows.defaultFellow || state.fellows[0]?.key || "";
    state.sessions = {
      schema_version: sessions.schema_version || 1,
      readAt: sessions.readAt || {},
      sessions: sessions.sessions || {}
    };
    if (runtimeResult.status === "fulfilled") applyRuntimeStatus(runtimeResult.value);
    if (catalogResult.status === "fulfilled") {
      const rows = Array.isArray(catalogResult.value?.models) ? catalogResult.value.models : catalogResult.value;
      state.modelCatalog = Array.isArray(rows) ? rows : [];
    }
    if (codexModelsResult.status === "fulfilled") {
      const rows = Array.isArray(codexModelsResult.value?.models) ? codexModelsResult.value.models : [];
      state.codexModels = rows;
    }
    if (capsResult.status === "fulfilled" && capsResult.value) {
      state.engineCapabilities = {
        approvalModes: Array.isArray(capsResult.value.approvalModes) && capsResult.value.approvalModes.length
          ? capsResult.value.approvalModes
          : state.engineCapabilities.approvalModes,
        effortLevels: Array.isArray(capsResult.value.effortLevels) && capsResult.value.effortLevels.length
          ? capsResult.value.effortLevels
          : state.engineCapabilities.effortLevels
      };
    }
    if (commandsResult.status === "rejected") {
      state.slashCommands = fallbackSlashCommands;
      state.agentSlashCommands = { "claude-code": [], codex: [] };
    }
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

function applyRuntimeStatus(runtime = {}) {
  state.runtime = runtime && typeof runtime === "object" ? runtime : state.runtime;
  if (Array.isArray(runtime?.fellows)) {
    state.fellows = runtime.fellows;
  }
}

function modelKey(model = {}) {
  return `${String(model.provider || "").trim()}::${String(model.model || "").trim()}`;
}

function providerLabel(provider = "") {
  const labels = {
    nous: "Nous Portal",
    xai: "xAI",
    anthropic: "Anthropic",
    openrouter: "OpenRouter",
    "openai-codex": "OpenAI Codex",
    deepseek: "DeepSeek",
    gemini: "Google",
    lmstudio: "LM Studio"
  };
  return labels[provider] || provider || "Provider";
}

function catalogEntries() {
  const current = state.runtime?.model || {};
  const currentId = modelKey(current);
  const base = Array.isArray(state.modelCatalog) ? state.modelCatalog : [];
  if (!current.provider || base.some((entry) => entry.id === currentId)) return base;
  return [
    {
      id: currentId,
      provider: current.provider,
      providerLabel: providerLabel(current.provider),
      model: current.model || "",
      label: current.model || "Custom Model",
      authType: current.provider === "openai-codex" ? "oauth_external" : "api_key",
      apiKeyEnv: current.apiKeyEnv || "",
      baseUrl: current.baseUrl || "",
      apiMode: current.apiMode || "chat_completions"
    },
    ...base
  ];
}

function catalogEntryForModel(model = {}) {
  const key = modelKey(model);
  return catalogEntries().find((entry) => entry.id === key)
    || catalogEntries().find((entry) => entry.provider === model.provider && entry.model === model.model)
    || null;
}

function modelsForProvider(provider) {
  return catalogEntries().filter((entry) => entry.provider === provider);
}

function providerIsConnected(provider) {
  return Boolean((state.runtime?.connectedProviders || []).some((entry) => entry.provider === provider && entry.hasApiKey));
}

function connectedModelEntries() {
  const providers = (state.runtime?.connectedProviders || [])
    .filter((entry) => entry.hasApiKey)
    .map((entry) => entry.provider);
  const entries = providers.flatMap((provider) => modelsForProvider(provider));
  const current = catalogEntryForModel(state.runtime?.model || {});
  if (current && providerIsConnected(current.provider) && !entries.some((entry) => entry.id === current.id)) {
    return [current, ...entries];
  }
  return entries;
}

function activeAgentEngine(fellow = activeFellow()) {
  const engine = String(fellow?.agentEngine || fellow?.agent_engine || "hermes").trim().toLowerCase();
  if (engine === "claude" || engine === "claude-code") return "claude-code";
  if (engine === "codex" || engine === "openai-codex") return "codex";
  return "hermes";
}

function engineConfigForFellow(fellow = activeFellow()) {
  return fellow?.engineConfig || fellow?.engine_config || {};
}

function engineLabel(engine = activeAgentEngine()) {
  if (engine === "claude-code") return "Claude Code";
  if (engine === "codex") return "Codex";
  return "Hermes";
}

function externalModelEntries(engine) {
  if (engine === "claude-code") {
    return [
      { id: "default", provider: "claude-code", model: "", label: "Claude Code 默认" },
      { id: "claude-opus-4-7", provider: "claude-code", model: "claude-opus-4-7", label: "Claude Opus 4.7" },
      { id: "claude-sonnet-4-6", provider: "claude-code", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "opus", provider: "claude-code", model: "opus", label: "Opus alias" },
      { id: "sonnet", provider: "claude-code", model: "sonnet", label: "Sonnet alias" }
    ];
  }
  if (engine === "codex") {
    const entries = [{ id: "default", provider: "codex", model: "", label: "Codex 默认" }];
    const dynamic = Array.isArray(state.codexModels) ? state.codexModels : [];
    if (dynamic.length) {
      for (const m of dynamic) {
        if (!m?.slug) continue;
        entries.push({ id: m.slug, provider: "codex", model: m.slug, label: m.displayName || m.slug });
      }
      return entries;
    }
    return [
      ...entries,
      { id: "gpt-5.3-codex-spark", provider: "codex", model: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
      { id: "gpt-5.3-codex", provider: "codex", model: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { id: "gpt-5.2", provider: "codex", model: "gpt-5.2", label: "GPT-5.2" }
    ];
  }
  return [];
}

const EFFORT_LABELS = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const APPROVAL_LABELS = { ask: "Ask", yolo: "YOLO", deny: "Deny", manual: "Ask", smart: "Smart", off: "YOLO" };

function effortOptions(engine) {
  if (engine === "claude-code") {
    return ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: EFFORT_LABELS[value] }));
  }
  if (engine === "codex") {
    return ["minimal", "low", "medium", "high", "xhigh"].map((value) => ({ value, label: EFFORT_LABELS[value] }));
  }
  return (state.engineCapabilities.effortLevels || ["low", "medium", "high"]).map((value) => ({
    value,
    label: EFFORT_LABELS[value] || value
  }));
}

function permissionOptions(engine) {
  if (engine === "claude-code") {
    return [
      { value: "default", label: "Ask Permissions" },
      { value: "acceptEdits", label: "Accept Edits" },
      { value: "plan", label: "Plan Mode" },
      { value: "auto", label: "Auto Mode" },
      { value: "bypassPermissions", label: "Bypass Permissions" }
    ];
  }
  if (engine === "codex") {
    return [
      { value: "default", label: "Ask" },
      { value: "acceptEdits", label: "Edits" },
      { value: "readOnly", label: "Read" },
      { value: "bypassPermissions", label: "YOLO" }
    ];
  }
  return (state.engineCapabilities.approvalModes || ["ask", "yolo", "deny"]).map((value) => ({
    value,
    label: APPROVAL_LABELS[value] || value
  }));
}

function optionHtml(item, selectedValue) {
  const selected = item.value === selectedValue ? " selected" : "";
  return `<option value="${escapeHtml(item.value)}"${selected}>${escapeHtml(item.label || item.value)}</option>`;
}

function setSelectOptions(select, entries, selectedValue, emptyLabel) {
  if (!select) return;
  const ids = new Set(entries.map((entry) => entry.value));
  const value = ids.has(selectedValue) ? selectedValue : entries[0]?.value || "";
  if (!entries.length) {
    select.innerHTML = `<option value="">${escapeHtml(emptyLabel || "暂无可选项")}</option>`;
    select.value = "";
    select.disabled = true;
    return;
  }
  select.innerHTML = entries.map((entry) => optionHtml(entry, value)).join("");
  select.value = value;
  select.disabled = false;
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
  if (last) return String(last.content || "").replace(/\s+/g, " ").trim();
  const attachmentMessage = [...messages].reverse().find((message) => Array.isArray(message.attachments) && message.attachments.length);
  return attachmentMessage ? `[${attachmentMessage.attachments.length} 个附件]` : "还没有消息";
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function attachmentKind(file = {}) {
  const type = String(file.mime || file.type || "").toLowerCase();
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

function renderAttachmentChips(attachments = []) {
  if (!Array.isArray(attachments) || !attachments.length) return "";
  return `
    <div class="message-attachments">
      ${attachments.map(renderAttachmentChip).join("")}
    </div>
  `;
}

function attachmentThumb(attachment = {}, className = "attachment-thumb") {
  const src = String(attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl || "").trim();
  if (!src || !src.startsWith("data:image/")) return `<span>${escapeHtml(attachmentGlyph(attachment))}</span>`;
  return `<img class="${escapeHtml(className)}" src="${escapeHtml(src)}" alt="">`;
}

function renderAttachmentChip(attachment = {}) {
  const image = (attachment.kind || attachmentKind(attachment)) === "image" && (attachment.thumbnailDataUrl || attachment.thumbnail || attachment.previewDataUrl);
  const href = String(attachment.dataUrl || "").startsWith("data:") ? String(attachment.dataUrl) : "";
  const tag = href ? "a" : "span";
  const download = href ? ` href="${escapeHtml(href)}" download="${escapeHtml(attachment.name || "attachment")}"` : "";
  return `
    <${tag} class="message-attachment${image ? " image" : ""}"${download} title="${escapeHtml(attachment.name || "")}">
      ${attachmentThumb(attachment, "message-attachment-thumb")}
      <strong>${escapeHtml(attachment.name || "附件")}</strong>
      <em>${escapeHtml(formatBytes(attachment.size))}</em>
    </${tag}>
  `;
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
    return {
      id: `generated:${filePath}`,
      name: filePath.split(/[\\/]/).pop() || "文件",
      path: filePath,
      kind: "file",
      size: 0
    };
  });
}

function queueGeneratedFileFetches(messages = []) {
  const paths = [...new Set(messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => extractLocalFilePaths(message.content)))];
  for (const filePath of paths) {
    if (state.generatedFiles.has(filePath)) continue;
    state.generatedFiles.set(filePath, { status: "loading" });
    request("/api/file/fetch", {
      method: "POST",
      body: JSON.stringify({ path: filePath })
    }).then((attachment) => {
      state.generatedFiles.set(filePath, { status: "ready", attachment });
      renderChat();
    }).catch(() => {
      state.generatedFiles.set(filePath, { status: "error" });
      renderChat();
    });
  }
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

function renderChatControls(fellow, session) {
  const sessions = sessionsFor(fellow.key);
  setSelectOptions(
    els.sessionSelect,
    sessions.map((item, index) => ({
      value: item.id,
      label: item.title || messagePreview(item) || `对话 ${index + 1}`
    })),
    session?.id || "",
    "还没有历史"
  );

  const engine = activeAgentEngine(fellow);
  const external = engine === "claude-code" || engine === "codex";
  const config = engineConfigForFellow(fellow);
  if (external) {
    const entries = externalModelEntries(engine).map((entry) => ({
      ...entry,
      value: entry.id,
      label: entry.label
    }));
    const selected = config.model || "default";
    setSelectOptions(els.modelSelect, entries, selected, "默认模型");
  } else {
    const entries = connectedModelEntries().map((entry) => ({
      ...entry,
      value: entry.id,
      label: entry.label || entry.model || providerLabel(entry.provider)
    }));
    const selected = catalogEntryForModel(state.runtime?.model || {})?.id || modelKey(state.runtime?.model || {});
    setSelectOptions(els.modelSelect, entries, selected, "先在桌面端连接模型");
  }

  const effort = external ? (config.effortLevel || "medium") : (state.runtime?.effort?.level || "medium");
  setSelectOptions(els.effortSelect, effortOptions(engine), effort, "Medium");

  const permission = external ? (config.permissionMode || "default") : (state.runtime?.permissions?.mode || "ask");
  setSelectOptions(els.permissionSelect, permissionOptions(engine), permission, "Ask");
}

function renderChat() {
  const fellow = activeFellow();
  const session = activeSession();
  els.chatView.classList.toggle("hidden", !fellow);
  els.bottomNav.classList.toggle("hidden", Boolean(fellow));
  if (!fellow) {
    state.slashMenuOpen = false;
    renderSlashCommandMenu();
    return;
  }
  els.chatAvatar.removeAttribute("style");
  els.chatAvatar.innerHTML = avatarImg(fellow);
  setText(els.chatTitle, fellow.name || fellow.key);
  setText(els.chatMeta, state.sending ? "正在回复" : `${engineLabel(activeAgentEngine(fellow))} · ${session?.title || "在线"}`);
  renderChatControls(fellow, session);
  const messages = messagesForActiveSession();
  queueGeneratedFileFetches(messages);
  els.messageList.innerHTML = messages.length ? messages.map((message) => {
    const attachments = [...(message.attachments || []), ...generatedAttachmentsForMessage(message)];
    const attachmentHtml = renderAttachmentChips(attachments);
    const content = String(message.content || "").trim();
    const traceHtml = message.role === "assistant"
      ? renderTraceBlocks({
        reasoning: message.reasoning,
        tools: message.tools,
        content: message.content,
        expanded: Boolean(message.streaming)
      })
      : "";
    const bodyHtml = content ? renderMarkdown(message.content) : (message.streaming && !traceHtml ? "..." : "");
    const bubbleHtml = bodyHtml || attachmentHtml
      ? `<div class="bubble">${bodyHtml}${attachmentHtml}</div>`
      : "";
    return `
      <article class="message ${message.role === "user" ? "user" : "assistant"}">
        ${traceHtml}
        ${bubbleHtml}
        <time>${escapeHtml(formatTime(message.createdAt))}</time>
      </article>
    `;
  }).join("") : `<div class="empty">开始和 ${escapeHtml(fellow.name || fellow.key)} 聊天</div>`;
  renderAttachmentTray();
  renderSendButton();
  setTimeout(() => {
    els.messageList.scrollTop = els.messageList.scrollHeight;
  }, 0);
}

function renderSendButton() {
  const hasContent = Boolean(els.chatInput.value.trim()) || state.pendingAttachments.length > 0;
  els.sendButton.disabled = state.sending || state.uploadingAttachments > 0 || !hasContent;
  els.attachButton.disabled = state.sending || state.uploadingAttachments > 0 || state.pendingAttachments.length >= 20;
}

function renderAttachmentTray() {
  if (!els.attachmentTray) return;
  els.attachmentTray.classList.toggle("hidden", state.pendingAttachments.length === 0 && state.uploadingAttachments === 0);
  const uploading = state.uploadingAttachments
    ? `<div class="attachment-chip uploading"><span>...</span><strong>正在上传 ${state.uploadingAttachments}</strong></div>`
    : "";
  els.attachmentTray.innerHTML = [
    ...state.pendingAttachments.map((attachment) => `
      <div class="attachment-chip${attachment.thumbnailDataUrl ? " image" : ""}" title="${escapeHtml(attachment.name || "")}">
        ${attachmentThumb(attachment, "attachment-chip-thumb")}
        <strong>${escapeHtml(attachment.name || "附件")}</strong>
        <em>${escapeHtml(formatBytes(attachment.size))}</em>
        <button type="button" data-remove-attachment="${escapeHtml(attachment.id)}" aria-label="移除附件">×</button>
      </div>
    `),
    uploading
  ].join("");
}

function filteredSlashCommands() {
  const filter = state.slashFilter.replace(/^\//, "").trim().toLowerCase();
  const engine = activeAgentEngine();
  const commands = engine === "claude-code" || engine === "codex"
    ? (state.agentSlashCommands[engine] || [])
    : (state.slashCommands || fallbackSlashCommands);
  if (!filter) return commands;
  return commands.filter((item) => `${item.command} ${item.description}`.toLowerCase().includes(filter));
}

function externalSlashInvocation(text) {
  const input = String(text || "").trim();
  const command = input.split(/\s+/)[0]?.toLowerCase() || "";
  if (!command.startsWith("/")) return null;
  const argsText = input.slice(command.length).trim();
  const args = argsText ? argsText.split(/\s+/).filter(Boolean) : [];
  const engine = activeAgentEngine();
  if (engine !== "claude-code" && engine !== "codex") return null;
  const found = (state.agentSlashCommands[engine] || []).find((item) => String(item.command || "").toLowerCase() === command);
  return found ? { engine, command, args, item: found } : null;
}

async function outgoingMessageForSubmit(text) {
  const invocation = externalSlashInvocation(text);
  if (!invocation || invocation.item.type !== "custom") return text;
  const result = await request("/api/commands/agent-execute", {
    method: "POST",
    body: JSON.stringify({
      engine: invocation.engine,
      commandName: invocation.command,
      commandPath: invocation.item.path,
      args: invocation.args,
      context: { sessionId: activeSession()?.id || "" }
    })
  });
  if (result?.type !== "custom" || !String(result.content || "").trim()) return text;
  return String(result.content || "").trim();
}

function updateSlashCommandState() {
  const value = els.chatInput.value || "";
  const cursor = els.chatInput.selectionStart || 0;
  const before = value.slice(0, cursor);
  const line = before.split(/\n/).pop() || "";
  const shouldOpen = /^\/[A-Za-z0-9_/-]*$/.test(line);
  state.slashMenuOpen = shouldOpen;
  state.slashFilter = shouldOpen ? line : "";
  if (shouldOpen && state.slashFilter.length <= 1) state.slashSelectedIndex = 0;
  const commands = filteredSlashCommands();
  if (state.slashSelectedIndex >= commands.length) state.slashSelectedIndex = Math.max(0, commands.length - 1);
  renderSlashCommandMenu();
}

function renderSlashCommandMenu() {
  if (!els.slashCommandMenu) return;
  const commands = filteredSlashCommands();
  els.slashCommandMenu.classList.toggle("hidden", !state.slashMenuOpen);
  if (!state.slashMenuOpen) {
    els.slashCommandMenu.innerHTML = "";
    return;
  }
  if (!commands.length) {
    els.slashCommandMenu.innerHTML = `<div class="slash-command-empty">没有匹配的命令</div>`;
    return;
  }
  els.slashCommandMenu.innerHTML = commands.slice(0, 24).map((item, index) => `
    <button type="button" class="slash-command-item${index === state.slashSelectedIndex ? " active" : ""}" data-command="${escapeHtml(item.command)}">
      <span class="slash-command-token">${escapeHtml(item.command)}</span>
      <span class="slash-command-description">${escapeHtml(item.description || "")}</span>
    </button>
  `).join("");
}

function fillSlashCommand(command) {
  const value = els.chatInput.value || "";
  const cursor = els.chatInput.selectionStart || 0;
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  const lineStart = before.lastIndexOf("\n") + 1;
  els.chatInput.value = `${value.slice(0, lineStart)}${command.command} ${after}`;
  const next = lineStart + command.command.length + 1;
  els.chatInput.setSelectionRange(next, next);
  state.slashMenuOpen = false;
  renderSlashCommandMenu();
  autosizeComposer();
  els.chatInput.focus();
}

function sendSlashCommand(command) {
  const text = String(command?.command || "").trim();
  if (!text) return;
  els.chatInput.value = text;
  state.slashMenuOpen = false;
  renderSlashCommandMenu();
  autosizeComposer();
  sendMessage();
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
  state.slashMenuOpen = false;
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

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error || new Error("读取附件失败")));
    reader.readAsDataURL(file);
  });
}

function thumbnailDataUrlForFile(file) {
  if (!file || !String(file.type || "").startsWith("image/")) return Promise.resolve("");
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const max = 180;
        const scale = Math.min(1, max / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
        const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
        const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      } catch {
        resolve("");
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve("");
    };
    image.src = url;
  });
}

async function saveAttachmentFile(file, thumbnailDataUrl = "") {
  const dataUrl = await readFileAsDataUrl(file);
  return request("/api/chat/attachment", {
    method: "POST",
    body: JSON.stringify({
      name: file.name || "attachment",
      mime: file.type || "",
      dataUrl,
      thumbnailDataUrl
    })
  });
}

async function addAttachmentFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;
  const remaining = Math.max(0, 20 - state.pendingAttachments.length);
  const selected = files.slice(0, remaining);
  if (!selected.length) return;
  state.uploadingAttachments += selected.length;
  renderAttachmentTray();
  renderSendButton();
  const existing = new Set(state.pendingAttachments.map((item) => `${item.name}:${item.size}`));
  const added = [];
  for (const file of selected) {
    try {
      if (file.size > 25 * 1024 * 1024) {
        throw new Error("超过 25MB");
      }
      const thumbnailDataUrl = await thumbnailDataUrlForFile(file);
      const saved = await saveAttachmentFile(file, thumbnailDataUrl);
      const key = `${saved.name || file.name}:${saved.size || file.size}`;
      if (existing.has(key)) continue;
      existing.add(key);
      added.push({
        id: String(saved.id || randomId()),
        name: String(saved.name || file.name || "附件"),
        path: String(saved.path || ""),
        mime: String(saved.mime || file.type || ""),
        size: Number(saved.size || file.size) || 0,
        kind: String(saved.kind || attachmentKind(file)),
        thumbnailDataUrl: String(saved.thumbnailDataUrl || thumbnailDataUrl || "")
      });
    } catch (error) {
      setText(els.chatMeta, `附件上传失败：${file.name || "未命名"} · ${error.message}`);
    } finally {
      state.uploadingAttachments = Math.max(0, state.uploadingAttachments - 1);
      renderAttachmentTray();
      renderSendButton();
    }
  }
  if (added.length) {
    state.pendingAttachments = [...state.pendingAttachments, ...added].slice(0, 20);
  }
  renderAttachmentTray();
  renderSendButton();
  els.chatInput.focus();
}

async function saveExternalControl(kind, value) {
  const fellow = activeFellow();
  if (!fellow) return;
  const engine = activeAgentEngine(fellow);
  const current = engineConfigForFellow(fellow);
  const patch = { ...current };
  if (kind === "model") {
    const entry = externalModelEntries(engine).find((item) => item.id === value);
    patch.model = entry?.model || "";
  } else if (kind === "effort") {
    patch.effortLevel = value;
  } else if (kind === "permission") {
    patch.permissionMode = value;
  }
  const runtime = await request("/api/fellow/engine", {
    method: "POST",
    body: JSON.stringify({
      key: fellow.key,
      agentEngine: engine,
      engineConfig: patch
    })
  });
  applyRuntimeStatus(runtime);
}

async function saveModelSelection() {
  const fellow = activeFellow();
  if (!fellow) return;
  const engine = activeAgentEngine(fellow);
  const value = els.modelSelect.value;
  if (engine === "claude-code" || engine === "codex") {
    await saveExternalControl("model", value);
    render();
    return;
  }
  const entry = connectedModelEntries().find((item) => item.id === value);
  if (!entry) return;
  const runtime = await request("/api/model/save", {
    method: "POST",
    body: JSON.stringify({
      provider: entry.provider,
      model: entry.model,
      apiKeyEnv: entry.apiKeyEnv,
      baseUrl: entry.baseUrl,
      apiMode: entry.apiMode,
      providerLabel: entry.providerLabel,
      authType: entry.authType
    })
  });
  applyRuntimeStatus(runtime);
  render();
}

async function saveEffortSelection() {
  const fellow = activeFellow();
  if (!fellow) return;
  const engine = activeAgentEngine(fellow);
  const value = els.effortSelect.value;
  if (engine === "claude-code" || engine === "codex") {
    await saveExternalControl("effort", value);
    render();
    return;
  }
  const runtime = await request("/api/effort/save", {
    method: "POST",
    body: JSON.stringify({ level: value })
  });
  applyRuntimeStatus(runtime);
  render();
}

async function savePermissionSelection() {
  const fellow = activeFellow();
  if (!fellow) return;
  const engine = activeAgentEngine(fellow);
  const value = els.permissionSelect.value;
  if (engine === "claude-code" || engine === "codex") {
    await saveExternalControl("permission", value);
    render();
    return;
  }
  const runtime = await request("/api/permissions/save", {
    method: "POST",
    body: JSON.stringify({ mode: value })
  });
  applyRuntimeStatus(runtime);
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

function pendingAssistantFor(key) {
  const pending = state.pendingBySession.get(key) || [];
  return pending.find((message) => message.role === "assistant");
}

function toolFromPendingMessage(message, data = {}) {
  if (!message) return null;
  if (!message.toolsById) message.toolsById = new Map();
  if (!message.toolsByName) message.toolsByName = new Map();
  const id = String(data?.id || "");
  const name = String(data?.name || "");
  let tool = id ? message.toolsById.get(id) : null;
  if (!tool && name) {
    const queue = message.toolsByName.get(name);
    tool = queue && queue.find((item) => item.status === "running");
  }
  return tool || null;
}

function handlePendingChatEnvelope(key, envelope = {}) {
  const assistant = pendingAssistantFor(key);
  if (!assistant || !envelope || typeof envelope !== "object") return;
  const { kind, data } = envelope;
  switch (kind) {
    case "text_delta":
      assistant.content += String(data?.text || "");
      break;
    case "reasoning_delta":
      assistant.reasoning = `${assistant.reasoning || ""}${String(data?.text || "")}`;
      if (assistant.reasoning && !assistant.reasoning.endsWith("\n")) assistant.reasoning += "\n";
      break;
    case "tool_call_started": {
      if (!Array.isArray(assistant.tools)) assistant.tools = [];
      if (!assistant.toolsById) assistant.toolsById = new Map();
      if (!assistant.toolsByName) assistant.toolsByName = new Map();
      const tool = {
        id: String(data?.id || `tool_${assistant.tools.length}`),
        name: String(data?.name || "工具"),
        preview: String(data?.preview || ""),
        status: "running",
        duration: null,
        error: false
      };
      assistant.tools.push(tool);
      assistant.toolsById.set(tool.id, tool);
      const queue = assistant.toolsByName.get(tool.name) || [];
      queue.push(tool);
      assistant.toolsByName.set(tool.name, queue);
      break;
    }
    case "tool_call_delta": {
      const tool = toolFromPendingMessage(assistant, data);
      if (tool) tool.preview = String(data?.preview || tool.preview || "");
      break;
    }
    case "tool_call_completed": {
      const tool = toolFromPendingMessage(assistant, data);
      if (tool) {
        tool.status = data?.error ? "error" : "completed";
        tool.duration = typeof data?.duration === "number" ? data.duration : null;
        tool.error = Boolean(data?.error);
        if (data?.preview) tool.preview = String(data.preview);
      }
      break;
    }
    case "status":
      setText(els.chatMeta, String(data?.text || "正在回复"));
      break;
    default:
      break;
  }
  renderChat();
}

async function relayStreamMessage({ fellowKey, sessionId, text, displayText, attachments, pendingKeyValue }) {
  let finalResult = null;
  const result = await relayRequest("/api/chat/stream", {
    method: "POST",
    body: JSON.stringify({ fellowKey, sessionId, text, displayText, attachments })
  }, (message) => {
    if (message.event === "chat") {
      const envelope = message.data || {};
      handlePendingChatEnvelope(pendingKeyValue, envelope);
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

async function streamMessage({ fellowKey, sessionId, text, displayText, attachments, pendingKeyValue }) {
  if (state.mode === "relay") {
    return relayStreamMessage({ fellowKey, sessionId, text, displayText, attachments, pendingKeyValue });
  }
  const response = await fetch(apiUrl("/api/chat/stream"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.token}`
    },
    body: JSON.stringify({ fellowKey, sessionId, text, displayText, attachments })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  if (!response.body?.getReader) {
    const result = await request("/api/chat/send", {
      method: "POST",
      body: JSON.stringify({ fellowKey, sessionId, text, displayText, attachments })
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
        handlePendingChatEnvelope(pendingKeyValue, envelope);
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
    if (parsed.event === "chat") {
      handlePendingChatEnvelope(pendingKeyValue, JSON.parse(parsed.data || "{}"));
    } else if (parsed.event === "result") {
      finalResult = JSON.parse(parsed.data || "{}");
    } else if (parsed.event === "error") {
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
  const attachments = state.pendingAttachments.map((attachment) => ({ ...attachment }));
  if (!text && !attachments.length) return;
  const session = activeSession();
  const key = pendingKey(fellow.key, session?.id || state.activeSessionId || "new");
  const userText = text || "请查看附件。";
  state.pendingBySession.set(key, [
    { role: "user", content: userText, attachments, createdAt: new Date().toISOString() },
    {
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      streaming: true,
      reasoning: "",
      tools: [],
      toolsById: new Map(),
      toolsByName: new Map()
    }
  ]);
  els.chatInput.value = "";
  state.pendingAttachments = [];
  renderAttachmentTray();
  autosizeComposer();
  state.sending = true;
  renderChat();
  try {
    const outgoingText = await outgoingMessageForSubmit(text);
    const result = await streamMessage({
      fellowKey: fellow.key,
      sessionId: session?.id || "",
      text: outgoingText || userText,
      displayText: userText,
      attachments,
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
  renderSendButton();
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
els.attachButton?.addEventListener("click", () => {
  if (state.sending || state.uploadingAttachments > 0) return;
  els.attachmentInput?.click();
});
els.attachmentInput?.addEventListener("change", () => {
  addAttachmentFiles(els.attachmentInput.files);
  els.attachmentInput.value = "";
});
els.attachmentTray?.addEventListener("click", (event) => {
  const id = event.target.closest("[data-remove-attachment]")?.dataset.removeAttachment;
  if (!id) return;
  state.pendingAttachments = state.pendingAttachments.filter((attachment) => attachment.id !== id);
  renderAttachmentTray();
  renderSendButton();
  els.chatInput.focus();
});
els.slashCommandMenu?.addEventListener("pointerdown", (event) => {
  const button = event.target.closest("[data-command]");
  if (!button) return;
  event.preventDefault();
  const command = filteredSlashCommands().find((item) => item.command === button.dataset.command);
  if (command) sendSlashCommand(command);
});
els.messageList?.addEventListener("click", async (event) => {
  const copyButton = event.target.closest("[data-copy-code]");
  if (copyButton) {
    const code = copyButton.closest(".message-code-block")?.querySelector("code");
    const ok = await copyTextToClipboard(code?.innerText || "");
    if (ok) flashCopiedCode(copyButton);
    return;
  }
  const inlineCode = event.target.closest("code.inline-code");
  if (!inlineCode) return;
  await copyTextToClipboard(inlineCode.innerText || "");
});
els.messageList?.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const inlineCode = event.target.closest("code.inline-code");
  if (!inlineCode) return;
  event.preventDefault();
  await copyTextToClipboard(inlineCode.innerText || "");
});
els.sessionSelect?.addEventListener("change", () => {
  state.activeSessionId = els.sessionSelect.value || "";
  renderChat();
});
els.modelSelect?.addEventListener("change", () => {
  els.modelSelect.disabled = true;
  saveModelSelection().catch((error) => {
    setText(els.chatMeta, `模型切换失败：${error.message}`);
    renderChat();
  }).finally(() => {
    els.modelSelect.disabled = false;
  });
});
els.effortSelect?.addEventListener("change", () => {
  els.effortSelect.disabled = true;
  saveEffortSelection().catch((error) => {
    setText(els.chatMeta, `强度切换失败：${error.message}`);
    renderChat();
  }).finally(() => {
    els.effortSelect.disabled = false;
  });
});
els.permissionSelect?.addEventListener("change", () => {
  els.permissionSelect.disabled = true;
  savePermissionSelection().catch((error) => {
    setText(els.chatMeta, `权限切换失败：${error.message}`);
    renderChat();
  }).finally(() => {
    els.permissionSelect.disabled = false;
  });
});
els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});
els.chatInput.addEventListener("input", () => {
  autosizeComposer();
  updateSlashCommandState();
});
els.chatInput.addEventListener("click", updateSlashCommandState);
els.chatInput.addEventListener("paste", (event) => {
  if (!event.clipboardData?.files?.length) return;
  addAttachmentFiles(event.clipboardData.files);
});
els.chatInput.addEventListener("keydown", (event) => {
  if (state.slashMenuOpen) {
    const commands = filteredSlashCommands();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.slashSelectedIndex = commands.length ? (state.slashSelectedIndex + 1) % commands.length : 0;
      renderSlashCommandMenu();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.slashSelectedIndex = commands.length ? (state.slashSelectedIndex - 1 + commands.length) % commands.length : 0;
      renderSlashCommandMenu();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const command = commands[state.slashSelectedIndex];
      if (command) fillSlashCommand(command);
      return;
    }
    if (event.key === "Escape") {
      state.slashMenuOpen = false;
      renderSlashCommandMenu();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      const command = commands[state.slashSelectedIndex];
      if (command) sendSlashCommand(command);
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
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
