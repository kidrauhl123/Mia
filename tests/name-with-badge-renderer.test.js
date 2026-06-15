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
      replaceChildren(...children) {
        this.children = children;
        this._text = "";
      },
      get firstElementChild() {
        return this.children[0] || null;
      },
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

function loadRenderer(options = {}) {
  const shared = fs.readFileSync(path.join(__dirname, "..", "packages", "shared", "status-badge-assets.js"), "utf8");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "name-with-badge.js"), "utf8");
  const window = { ...(options.window || {}) };
  const context = vm.createContext({ window, globalThis: window, document: createMockDocument(), console });
  vm.runInContext(shared, context, { filename: "packages/shared/status-badge-assets.js" });
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
  assert.equal(lottie.children[1].dataset.lottie, "sparkle");
  assert.equal(lottie.children[1].dataset.lottieTrigger, "loop");
  assert.equal(lottie.children[1].getAttribute("aria-hidden"), "true");
  assert.equal(lottie.children[1].getAttribute("title"), "Active");
  assert.equal(gift.children[1].textContent, "");
  assert.equal(gift.children[1].dataset.assetId, "rose");
  assert.equal(gift.children[1].dataset.collectibleId, "nft_1");
  assert.equal(gift.children[1].getAttribute("aria-hidden"), "true");
  assert.equal(gift.children[1].hasAttribute("title"), false);
});

test("renderNameWithBadge initializes lottie badges when the lottie renderer is available", () => {
  const calls = [];
  const renderer = loadRenderer({
    window: {
      miaLottieIcons: {
        init(root) { calls.push(root); }
      }
    }
  });

  const el = renderer.renderNameWithBadge({
    identity: { displayName: "Runner" },
    statusBadge: { kind: "lottie", assetId: "sparkle" }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0], el);
});

test("setNameWithBadge reuses an existing lottie badge node for identical content", () => {
  const calls = [];
  const renderer = loadRenderer({
    window: {
      miaLottieIcons: {
        init(root) { calls.push(root); }
      }
    }
  });
  const target = createMockDocument().createElement("strong");

  const first = renderer.setNameWithBadge(target, {
    identity: { displayName: "Runner" },
    statusBadge: { kind: "lottie", assetId: "sparkle" }
  });
  const second = renderer.setNameWithBadge(target, {
    identity: { displayName: "Runner" },
    statusBadge: { kind: "lottie", assetId: "sparkle" }
  });

  assert.equal(target.children.length, 1);
  assert.equal(first, second);
  assert.equal(calls.length, 2);
});

test("renderNameWithBadgeHtml emits lottie attributes and rejects unsafe asset paths", () => {
  const renderer = loadRenderer();
  const html = renderer.renderNameWithBadgeHtml({
    identity: { displayName: "Runner" },
    statusBadge: { kind: "lottie", assetId: "sparkle", label: "Active" }
  });
  const unsafe = renderer.renderNameWithBadgeHtml({
    identity: { displayName: "Runner" },
    statusBadge: { kind: "lottie", assetId: "../sparkle" }
  });

  assert.match(html, /data-asset-id="sparkle"/);
  assert.match(html, /data-lottie="sparkle"/);
  assert.match(html, /data-lottie-trigger="loop"/);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(unsafe, /data-lottie=/);
  assert.doesNotMatch(unsafe, /data-asset-id=/);
});

test("renderNameWithBadge uses cloud status badge asset paths when configured", () => {
  const renderer = loadRenderer();
  renderer.setStatusBadgeAssetBaseUrl("https://mia.example.com/");
  const el = renderer.renderNameWithBadge({
    identity: { displayName: "Runner" },
    statusBadge: { kind: "lottie", assetId: "rainbow" }
  });
  const html = renderer.renderNameWithBadgeHtml({
    identity: { displayName: "Runner" },
    statusBadge: { kind: "lottie", assetId: "rainbow" }
  });

  assert.equal(el.children[1].dataset.lottiePath, "https://mia.example.com/api/status-badge-assets/rainbow.json");
  assert.match(html, /data-lottie-path="https:\/\/mia\.example\.com\/api\/status-badge-assets\/rainbow\.json"/);
});

test("renderNameWithBadge keeps bundled desktop badge assets local even when cloud is configured", () => {
  const renderer = loadRenderer({ window: { mia: {} } });
  renderer.setStatusBadgeAssetBaseUrl("https://mia.example.com/");
  const cat = renderer.renderNameWithBadge({
    identity: { displayName: "Cat" },
    statusBadge: { kind: "lottie", assetId: "surprised-cat", label: "惊讶猫" }
  });
  const rainbow = renderer.renderNameWithBadge({
    identity: { displayName: "Rainbow" },
    statusBadge: { kind: "lottie", assetId: "rainbow" }
  });
  const squint = renderer.renderNameWithBadge({
    identity: { displayName: "Square" },
    statusBadge: { kind: "lottie", assetId: "squint-bounce", label: "眯眼小方块弹跳" }
  });
  const blueFire = renderer.renderNameWithBadge({
    identity: { displayName: "Fire" },
    statusBadge: { kind: "lottie", assetId: "blue-fire", label: "蓝色火焰" }
  });

  assert.equal(cat.children[1].dataset.lottieFormat, "tgs");
  assert.equal(cat.children[1].dataset.lottieLocal, "status-badge");
  assert.equal(cat.children[1].dataset.lottiePath, "./assets/status-badges/surprised-cat.tgs");
  assert.equal(squint.children[1].dataset.lottieFormat, "tgs");
  assert.equal(squint.children[1].dataset.lottieLocal, "status-badge");
  assert.equal(squint.children[1].dataset.lottiePath, "./assets/status-badges/squint-bounce.tgs");
  assert.equal(blueFire.children[1].dataset.lottieFormat, "tgs");
  assert.equal(blueFire.children[1].dataset.lottieLocal, "status-badge");
  assert.equal(blueFire.children[1].dataset.lottiePath, "./assets/status-badges/blue-fire.tgs");
  assert.equal(rainbow.children[1].dataset.lottiePath, "./assets/lottie/rainbow.json");
});

test("renderNameWithBadge marks local TGS badge assets for desktop playback", () => {
  const renderer = loadRenderer();
  const el = renderer.renderNameWithBadge({
    identity: { displayName: "Cat" },
    statusBadge: { kind: "lottie", assetId: "surprised-cat", label: "惊讶猫" }
  });
  const html = renderer.renderNameWithBadgeHtml({
    identity: { displayName: "Cat" },
    statusBadge: { kind: "lottie", assetId: "surprised-cat", label: "惊讶猫" }
  });

  assert.equal(el.children[1].dataset.lottieFormat, "tgs");
  assert.equal(el.children[1].dataset.lottieLocal, "status-badge");
  assert.equal(el.children[1].dataset.lottieFallback, undefined);
  assert.equal(el.children[1].dataset.lottiePath, "./assets/status-badges/surprised-cat.tgs");
  assert.match(html, /data-lottie-format="tgs"/);
  assert.match(html, /data-lottie-local="status-badge"/);
  assert.doesNotMatch(html, /data-lottie-fallback/);
  assert.match(html, /data-lottie-path="\.\/assets\/status-badges\/surprised-cat\.tgs"/);
});

test("renderNameWithBadge marks squint bounce TGS badge for desktop playback", () => {
  const renderer = loadRenderer();
  const el = renderer.renderNameWithBadge({
    identity: { displayName: "Square" },
    statusBadge: { kind: "lottie", assetId: "squint-bounce", label: "眯眼小方块弹跳" }
  });
  const html = renderer.renderNameWithBadgeHtml({
    identity: { displayName: "Square" },
    statusBadge: { kind: "lottie", assetId: "squint-bounce", label: "眯眼小方块弹跳" }
  });

  assert.equal(el.children[1].dataset.lottieFormat, "tgs");
  assert.equal(el.children[1].dataset.lottieLocal, "status-badge");
  assert.equal(el.children[1].dataset.lottiePath, "./assets/status-badges/squint-bounce.tgs");
  assert.match(html, /data-lottie="squint-bounce"/);
  assert.match(html, /data-lottie-path="\.\/assets\/status-badges\/squint-bounce\.tgs"/);
});

test("renderNameWithBadge marks blue fire TGS badge for desktop playback", () => {
  const renderer = loadRenderer();
  const el = renderer.renderNameWithBadge({
    identity: { displayName: "Fire" },
    statusBadge: { kind: "lottie", assetId: "blue-fire", label: "蓝色火焰" }
  });
  const html = renderer.renderNameWithBadgeHtml({
    identity: { displayName: "Fire" },
    statusBadge: { kind: "lottie", assetId: "blue-fire", label: "蓝色火焰" }
  });

  assert.equal(el.children[1].dataset.lottieFormat, "tgs");
  assert.equal(el.children[1].dataset.lottieLocal, "status-badge");
  assert.equal(el.children[1].dataset.lottiePath, "./assets/status-badges/blue-fire.tgs");
  assert.match(html, /data-lottie="blue-fire"/);
  assert.match(html, /data-lottie-path="\.\/assets\/status-badges\/blue-fire\.tgs"/);
});

test("renderNameWithBadge accepts snake_case gift badges from identity", () => {
  const renderer = loadRenderer();
  const el = renderer.renderNameWithBadge({
    identity: {
      display_name: "Collector",
      status_badge: { kind: "gift", asset_id: "rose", collectible_id: "nft_rose_1" }
    }
  });

  assert.equal(el.children[0].textContent, "Collector");
  assert.equal(el.children[1].dataset.assetId, "rose");
  assert.equal(el.children[1].dataset.collectibleId, "nft_rose_1");
});

test("renderNameWithBadge honors identity statusBadge null over snake_case badge", () => {
  const renderer = loadRenderer();
  const el = renderer.renderNameWithBadge({
    identity: {
      displayName: "Collector",
      statusBadge: null,
      status_badge: { kind: "gift", asset_id: "rose", collectible_id: "nft_rose_1" }
    }
  });

  assert.equal(el.children.length, 1);
  assert.equal(el.textContent, "Collector");
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
