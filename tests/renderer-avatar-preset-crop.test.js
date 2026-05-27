const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeImg() {
  return {
    className: "",
    _attrs: {},
    draggable: true,
    parentElement: null,
    isConnected: false,
    getAttribute(k) { return this._attrs[k]; },
    setAttribute(k, v) { this._attrs[k] = v; },
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

function loadAvatar() {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "renderer", "helpers", "avatar-helpers.js"),
    "utf8"
  );
  const window = {};
  const document = { createElement: (tag) => (tag === "img" ? makeImg() : makeEl()) };
  const ctx = vm.createContext({ window, globalThis: window, document, console });
  vm.runInContext(src, ctx);
  return window.miaAvatar;
}

// A built-in preset shown with a neutral crop must adopt the preset's tuned
// face crop in the <img> element path — the same resolution thumbnails use —
// so an uncropped preset avatar (e.g. seeded Mia) is framed like every other.
test("preset image with a neutral crop renders with the preset's tuned crop", () => {
  const avatar = loadAvatar();
  const el = makeEl();
  avatar.applyAvatarMedia(el, "./assets/avatars/01.png", {});
  const img = el._children[0];
  const expected = avatar.avatarDefaultCropForSrc("./assets/avatars/01.png");

  assert.equal(img.className, "avatar-image");
  assert.match(img.getAttribute("style"), new RegExp(`scale\\(${expected.zoom}\\)`));
  assert.match(img.getAttribute("style"), new RegExp(`object-position:${expected.x}% ${expected.y}%`));
  assert.ok(!/scale\(1\)/.test(img.getAttribute("style")), "should not be the neutral zoom");
});

test("non-preset image with a neutral crop stays neutral", () => {
  const avatar = loadAvatar();
  const el = makeEl();
  avatar.applyAvatarMedia(el, "file:///uploaded.png", {});
  const img = el._children[0];
  assert.match(img.getAttribute("style"), /scale\(1\)/);
});

test("preset image with an explicit user crop is left untouched", () => {
  const avatar = loadAvatar();
  const el = makeEl();
  avatar.applyAvatarMedia(el, "./assets/avatars/01.png", { x: 30, y: 70, zoom: 1.3 });
  const img = el._children[0];
  assert.match(img.getAttribute("style"), /scale\(1\.3\)/);
  assert.match(img.getAttribute("style"), /object-position:30% 70%/);
});
