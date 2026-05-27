const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function mockEl() {
  return {
    _html: "",
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    querySelector() { return mockEl(); },
    set innerHTML(value) { this._html = String(value || ""); },
    get innerHTML() { return this._html; },
    type: "",
    className: ""
  };
}

function loadSidebarCards() {
  const mockWindow = {
    miaUnread: require("../src/shared/unread"),
    miaAvatar: { paintAvatar() {} },
    miaGroupAvatar: { applyGroupAvatar() {} }
  };
  const context = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    document: { createElement: () => mockEl() },
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
