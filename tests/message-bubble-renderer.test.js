const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function mockEl(tagName = "span") {
  const el = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    attrs: {},
    children: [],
    style: { cssText: "", color: "" },
    _text: "",
    _html: "",
    _listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    insertAdjacentHTML(position, html) {
      if (position === "beforeend") this._html += String(html || "");
      else this._html = String(html || "") + this._html;
    },
    addEventListener(name, fn) { this._listeners[name] = fn; },
    setAttribute(k, v) { this.attrs[k] = v; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; }
  };
  return el;
}

function findByClass(el, className) {
  if (!el) return null;
  const classes = String(el.className || "").split(/\s+/);
  if (classes.includes(className)) return el;
  for (const child of el.children || []) {
    const hit = findByClass(child, className);
    if (hit) return hit;
  }
  return null;
}

function loadRenderer(options = {}) {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "message-bubble-renderer.js"), "utf8");
  const window = {
    miaMarkdown: { escapeHtml: (v) => String(v || ""), renderMarkdown: (v) => String(v || "") },
    miaContactAvatar: { renderAvatar: (c) => mockEl() },
    miaTimeFormat: require("../src/shared/time-format"),
    ...(options.window || {})
  };
  const ctx = vm.createContext({ window, globalThis: window, document: { createElement: (tag) => mockEl(tag) }, console });
  vm.runInContext(src, ctx);
  return window.miaMessageBubble;
}

test("createMessageBubble user message gets .message.user class", () => {
  const r = loadRenderer();
  const article = r.createMessageBubble({
    source: "fellow-session", conversationId: "c", messageId: "m",
    role: "user", authorName: "me", bodyMd: "hi", isOwn: true,
    avatar: { image: "", color: "#0162db" }, capabilities: { reply: true, copy: true, pin: true, delete: true }
  });
  assert.match(article.className, /message user/);
});

test("createMessageBubble assistant message gets .message.assistant class", () => {
  const r = loadRenderer();
  const article = r.createMessageBubble({
    source: "cloud-conversation", conversationId: "dm", messageId: "m",
    role: "assistant", authorName: "Codex", bodyMd: "ok",
    avatar: { image: "data:codex" }, capabilities: { reply: true, copy: true, pin: false, delete: false }
  });
  assert.match(article.className, /message assistant/);
});

test("createMessageBubble emits contextmenu listener on the article", () => {
  const r = loadRenderer();
  const calls = [];
  const article = r.createMessageBubble({
    source: "cloud-conversation", conversationId: "x", messageId: "y",
    role: "user", authorName: "a", bodyMd: "x", isOwn: false,
    avatar: { color: "#5e5ce6" }, capabilities: { reply: true, copy: true, pin: false, delete: false }
  }, {
    onContextMenu: (spec, x, y) => calls.push({ spec, x, y })
  });
  article._listeners.contextmenu({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 20 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].spec.messageId, "y");
});

test("createMessageBubble renders sender names through miaNameWithBadge when available", () => {
  const calls = [];
  const r = loadRenderer({
    window: {
      miaNameWithBadge: {
        renderNameWithBadge(args) {
          calls.push(args);
          const el = mockEl("span");
          el.className = "name-with-badge";
          return el;
        }
      }
    }
  });
  const identity = { kind: "bot", id: "bot_mia", displayName: "Mia" };
  const badge = { kind: "emoji", emoji: "⭐", label: "Premium" };

  const article = r.createMessageBubble({
    source: "cloud-conversation",
    conversationId: "dm",
    messageId: "m",
    role: "assistant",
    authorIdentity: identity,
    authorName: "Mia",
    statusBadge: badge,
    bodyMd: "ok",
    avatar: {},
    capabilities: { reply: true, copy: true, pin: false, delete: false }
  });

  const sender = findByClass(article, "bubble-sender");
  assert.ok(sender, "sender label exists");
  assert.ok(findByClass(sender, "name-with-badge"), "sender label contains name-with-badge");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { identity, fallbackName: "Mia", statusBadge: badge });
});
