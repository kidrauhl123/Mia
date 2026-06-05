const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createMockDocument() {
  function mockEl(tagName = "span") {
    const el = {
      tagName: String(tagName).toUpperCase(),
      className: "",
      attrs: {},
      dataset: {},
      children: [],
      _text: "",
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, value) {
        this.attrs[name] = String(value);
        if (name.startsWith("data-")) {
          const key = name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
          this.dataset[key] = String(value);
        }
      },
      getAttribute(name) { return this.attrs[name]; },
      hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); },
      get textContent() {
        return this._text + this.children.map((child) => child.textContent || "").join("");
      },
      set textContent(value) { this._text = String(value ?? ""); }
    };
    return el;
  }
  return { createElement: mockEl };
}

function loadRenderer() {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "name-with-badge.js"), "utf8");
  const window = {};
  const context = vm.createContext({ window, globalThis: window, document: createMockDocument(), console });
  vm.runInContext(src, context, { filename: "src/renderer/name-with-badge.js" });
  return window.miaNameWithBadge;
}

test("renderNameWithBadge renders emoji badge text with title", () => {
  const renderer = loadRenderer();
  const el = renderer.renderNameWithBadge({
    identity: { displayName: "Mia" },
    statusBadge: { kind: "emoji", emoji: "⭐", label: "Premium" }
  });

  assert.equal(el.className, "name-with-badge");
  assert.equal(el.children[0].className, "name-with-badge-text");
  assert.equal(el.children[0].textContent, "Mia");
  assert.equal(el.children[1].textContent, "⭐");
  assert.equal(el.children[1].getAttribute("title"), "Premium");
});

test("renderNameWithBadge omits invalid badges without changing the name", () => {
  const renderer = loadRenderer();
  const el = renderer.renderNameWithBadge({
    identity: { displayName: "Codex" },
    statusBadge: { kind: "emoji", label: "missing emoji" }
  });

  assert.equal(el.children.length, 1);
  assert.equal(el.textContent, "Codex");
});

test("renderNameWithBadge renders lottie and gift badges as asset spans", () => {
  const renderer = loadRenderer();
  const lottie = renderer.renderNameWithBadge({
    identity: { displayName: "Runner" },
    statusBadge: { kind: "lottie", assetId: "sparkle", label: "Active" }
  });
  const gift = renderer.renderNameWithBadge({
    identity: { displayName: "Collector" },
    statusBadge: { kind: "gift", assetId: "rose", collectibleId: "nft_1" }
  });

  assert.equal(lottie.children[1].textContent, "");
  assert.equal(lottie.children[1].dataset.assetId, "sparkle");
  assert.equal(lottie.children[1].getAttribute("title"), "Active");
  assert.equal(gift.children[1].textContent, "");
  assert.equal(gift.children[1].dataset.assetId, "rose");
  assert.equal(gift.children[1].dataset.collectibleId, "nft_1");
  assert.equal(gift.children[1].hasAttribute("title"), false);
});

test("renderNameWithBadge uses fallbackName without exposing identity keys", () => {
  const renderer = loadRenderer();
  const fallback = renderer.renderNameWithBadge({
    identity: { kind: "bot", id: "bot_codex", identityKey: "bot:bot_codex" },
    fallbackName: "Codex"
  });
  const internalKey = renderer.renderNameWithBadge({
    fallbackName: "user:u_1"
  });

  assert.equal(fallback.textContent, "Codex");
  assert.equal(internalKey.textContent, "未知");
});

test("renderNameWithBadge explicit null statusBadge suppresses identity badge", () => {
  const renderer = loadRenderer();
  const el = renderer.renderNameWithBadge({
    identity: {
      displayName: "Mia",
      statusBadge: { kind: "emoji", emoji: "⭐", label: "Premium" }
    },
    statusBadge: null
  });

  assert.equal(el.children.length, 1);
  assert.equal(el.textContent, "Mia");
});
