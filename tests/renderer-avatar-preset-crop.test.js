const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeImg() {
  return {
    className: "",
    _attrs: {},
    _events: {},
    draggable: true,
    parentElement: null,
    isConnected: false,
    getAttribute(k) { return this._attrs[k]; },
    setAttribute(k, v) { this._attrs[k] = v; },
    addEventListener(type, handler) { this._events[type] = handler; },
    dispatch(type) { if (typeof this._events[type] === "function") this._events[type](); },
    remove() { this.parentElement && this.parentElement._remove(this); }
  };
}

function makeEl() {
  return {
    _children: [],
    style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    get childNodes() { return this._children; },
    get firstElementChild() { return this._children[0] || null; },
    setAttribute() {},
    getAttribute() { return undefined; },
    querySelectorAll(sel) {
      const cls = sel.includes("avatar-video") ? "avatar-video" : sel.includes("avatar-image") ? "avatar-image" : "";
      return this._children.filter((c) => c.className === cls);
    },
    prepend(node) { this._remove(node); node.parentElement = this; node.isConnected = true; this._children.unshift(node); },
    _remove(node) { const i = this._children.indexOf(node); if (i >= 0) { this._children.splice(i, 1); node.parentElement = null; node.isConnected = false; } }
  };
}

function loadAvatar({ thumbnails = null } = {}) {
  const resolveSrc = fs.readFileSync(
    path.join(__dirname, "..", "packages", "shared", "avatar.js"),
    "utf8"
  );
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "renderer", "helpers", "avatar-helpers.js"),
    "utf8"
  );
  const window = thumbnails ? { miaAvatarThumbnails: thumbnails } : {};
  const document = { createElement: (tag) => (tag === "img" ? makeImg() : makeEl()) };
  const ctx = vm.createContext({ window, globalThis: window, document, console });
  vm.runInContext(resolveSrc, ctx);
  vm.runInContext(src, ctx);
  return window.miaAvatar;
}

function thumbnailApi(result = "data:image/png;base64,thumbnail") {
  return {
    supportsThumbnail: () => true,
    thumbnailKey: (src, crop) => `${src}:${crop?.x}:${crop?.y}:${crop?.zoom}`,
    cachedThumbnail: () => "",
    renderThumbnail: () => Promise.resolve(result)
  };
}

test("former preset image path renders as a generated fallback, not the preset image", () => {
  const avatar = loadAvatar();
  const el = makeEl();
  avatar.applyAvatarMedia(el, "./assets/avatars/01.png", {}, "#65aadd", "旧用");
  const img = el._children[0];
  assert.ok(img, "renders a generated avatar image");
  const src = img.getAttribute("src");
  assert.match(src, /^data:image\/svg\+xml,/);  // deterministic generated fallback
  assert.doesNotMatch(src, /assets\/avatars/);  // never the removed preset image
  assert.match(decodeURIComponent(src), /旧用/);  // initials baked into the SVG
});

test("non-preset image with a neutral crop stays neutral", () => {
  const avatar = loadAvatar();
  const el = makeEl();
  avatar.applyAvatarMedia(el, "file:///uploaded.png", {});
  const img = el._children[0];
  assert.match(img.getAttribute("style"), /scale\(1\)/);
});

test("uploaded still avatars switch to the shared baked thumbnail", async () => {
  const avatar = loadAvatar({ thumbnails: thumbnailApi() });
  const el = makeEl();
  avatar.applyAvatarMedia(el, "data:image/jpeg;base64,photo", { x: 60, y: 40, zoom: 1.4 });
  const img = el._children[0];
  assert.equal(img.getAttribute("src"), "data:image/jpeg;base64,photo");
  assert.match(img.getAttribute("style"), /scale\(1\.4\)/);

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(img.getAttribute("src"), "data:image/png;base64,thumbnail");
  assert.match(img.getAttribute("style"), /object-position:50% 50%;transform:scale\(1\)/);
});

test("avatar crop editor keeps the original image instead of the display thumbnail", async () => {
  const avatar = loadAvatar({ thumbnails: thumbnailApi() });
  const el = makeEl();
  avatar.applyAvatarMedia(
    el,
    "data:image/jpeg;base64,photo",
    { x: 60, y: 40, zoom: 1.4 },
    "#eef0ff",
    "",
    { preserveChildren: true }
  );
  const img = el._children[0];

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(img.getAttribute("src"), "data:image/jpeg;base64,photo");
  assert.match(img.getAttribute("style"), /scale\(1\.4\)/);
});

test("remote avatar image keeps a generated fallback while the media loads", () => {
  const avatar = loadAvatar();
  const el = makeEl();
  avatar.applyAvatarMedia(el, "https://example.test/avatar.png", {}, "#65aadd", "棕野");
  const img = el._children[0];
  assert.equal(img.getAttribute("src"), "https://example.test/avatar.png");
  assert.equal(el.style.backgroundImage.startsWith('url("data:image/svg+xml,'), true);
  assert.match(decodeURIComponent(el.style.backgroundImage), /棕野/);
});

test("loaded avatar image clears the generated fallback background", () => {
  const avatar = loadAvatar();
  const el = makeEl();
  avatar.applyAvatarMedia(el, "./assets/mia-logo.png", {}, "#16a34a", "Mi");
  const img = el._children[0];
  assert.equal(img.getAttribute("src"), "./assets/mia-logo.png");
  assert.equal(el.style.backgroundImage.startsWith('url("data:image/svg+xml,'), true);

  img.dispatch("load");

  assert.equal(el.style.backgroundColor, "transparent");
  assert.equal(el.style.backgroundImage, "");
  assert.equal(el.style.backgroundSize, "");
  assert.equal(el.style.backgroundPosition, "");
  assert.equal(el.style.backgroundRepeat, "");
});

test("former preset image with an explicit user crop still renders as the generated fallback", () => {
  const avatar = loadAvatar();
  const el = makeEl();
  avatar.applyAvatarMedia(el, "./assets/avatars/01.png", { x: 30, y: 70, zoom: 1.3 }, "#65aadd", "旧用");
  const img = el._children[0];
  assert.ok(img, "renders a generated avatar image");
  assert.match(img.getAttribute("src"), /^data:image\/svg\+xml,/);
  assert.doesNotMatch(img.getAttribute("src"), /assets\/avatars/);
  // The crop that belonged to the removed preset image is dropped — the
  // generated fallback shows neutral (scale 1), not the stale user crop.
  assert.match(img.getAttribute("style"), /scale\(1\)/);
});
