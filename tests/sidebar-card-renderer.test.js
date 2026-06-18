const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function mockEl(tagName = "span") {
  return {
    tagName: String(tagName).toUpperCase(),
    _html: "",
    dataset: {},
    children: [],
    _queries: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    setAttribute(name, value) { this[name] = String(value || ""); },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; this._html = ""; },
    querySelector(selector) {
      if (!this._queries[selector]) this._queries[selector] = mockEl();
      return this._queries[selector];
    },
    set innerHTML(value) { this._html = String(value || ""); },
    get innerHTML() { return this._html; },
    get textContent() { return this._text || ""; },
    set textContent(value) { this._text = String(value || ""); },
    type: "",
    className: ""
  };
}

function loadSidebarCards(options = {}) {
  const mockWindow = {
    miaUnread: require("../src/shared/unread"),
    miaAvatar: { paintAvatar() {} },
    miaGroupAvatar: { applyGroupAvatar() {} },
    ...(options.window || {})
  };
  const context = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    document: { createElement: (tag) => mockEl(tag) },
    console
  });
  vm.runInContext(fs.readFileSync(path.join(root, "src/renderer/helpers/markdown-helpers.js"), "utf8"), context, {
    filename: "src/renderer/helpers/markdown-helpers.js"
  });
  vm.runInContext(fs.readFileSync(path.join(root, "src/renderer/sidebar-card-renderer.js"), "utf8"), context, {
    filename: "src/renderer/sidebar-card-renderer.js"
  });
  return mockWindow.miaSidebarCards;
}

test("sidebar conversation preview renders safe inline markdown", () => {
  const cards = loadSidebarCards();
  const card = cards.createPrivateCard({
    name: "mia",
    preview: "**重点** `npm test` [文档](https://example.com) <script>",
    avatar: {},
    unread: 0
  });

  assert.match(card.innerHTML, /<strong>重点<\/strong>/);
  assert.match(card.innerHTML, /<code class="sidebar-inline-code">npm test<\/code>/);
  assert.match(card.innerHTML, /<span class="sidebar-preview-link" title="https:\/\/example\.com">文档<\/span>/);
  assert.match(card.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(card.innerHTML, /<a\b/);
  assert.doesNotMatch(card.innerHTML, /tabindex/);
});

test("sidebar private card propagates identity status badge to name renderer", () => {
  const calls = [];
  const cards = loadSidebarCards({
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
  const card = cards.createPrivateCard({
    name: "Mia",
    identity,
    statusBadge: badge,
    preview: "hello",
    avatar: {},
    unread: 0
  });

  const nameEl = card.querySelector(".persona-name");
  assert.ok(nameEl.children.some((child) => child.className === "name-with-badge"));
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { identity, fallbackName: "Mia", statusBadge: badge });
});

test("sidebar muted conversation cards show a bell-off icon and muted unread badge", () => {
  const cards = loadSidebarCards();
  const privateCard = cards.createPrivateCard({
    name: "复习搭子",
    muted: true,
    preview: "马上设置",
    avatar: {},
    unread: 31
  });
  const groupCard = cards.createGroupCard({
    name: "技术交流群",
    muted: true,
    preview: "欢迎",
    members: [],
    unread: 120
  });

  for (const card of [privateCard, groupCard]) {
    assert.match(card.innerHTML, /class="persona-muted-icon"/);
    assert.match(card.innerHTML, /<svg viewBox="0 0 48 48"/);
    assert.match(card.innerHTML, /class="persona-unread muted"/);
  }
});

test("sidebar search result cards are compact hits without tag rows", () => {
  const cards = loadSidebarCards();
  const card = cards.createPrivateCard({
    searchResult: true,
    active: true,
    name: "我耳塞呢",
    preview: "TD5E5y7VfPtwdW2zPxYn9aP9fVZsn7ATus",
    time: "9/2/25",
    avatar: {},
    tags: [{ name: "收款用的", color: "#2386d9" }],
    unread: 8,
    dataAttrs: { conversationId: "botc_sess_1", searchMessageId: "m_42", searchMessageSeq: 42 }
  });

  assert.match(card.className, /\bsearch-result\b/);
  assert.match(card.className, /\bactive\b/);
  assert.doesNotMatch(card.className, /\bhas-tags\b/);
  assert.doesNotMatch(card.innerHTML, /persona-tag-row/);
  assert.doesNotMatch(card.innerHTML, /persona-tag-chip/);
  assert.doesNotMatch(card.innerHTML, /unread-badge/);
  assert.match(card.innerHTML, /TD5E5y7VfPtwdW2zPxYn9aP9fVZsn7ATus/);
  assert.equal(card.dataset.conversationId, "botc_sess_1");
  assert.equal(card.dataset.searchMessageId, "m_42");
  assert.equal(card.dataset.searchMessageSeq, "42");
});
