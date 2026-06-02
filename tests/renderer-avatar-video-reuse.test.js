const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Minimal DOM doubles for applyAvatarMedia's video branch. Tracks parent /
// connected state so detach (a container wipe) and re-attach behave like the
// real DOM, which is what the reuse pool keys off of.
function makeVideoEl() {
  return {
    className: "avatar-video",
    _attrs: {},
    dataset: {},
    parentElement: null,
    isConnected: false,
    readyState: 0,
    addEventListener() {},
    play() { this._played = true; return { catch() {} }; },
    getAttribute(k) { return this._attrs[k]; },
    setAttribute(k, v) { this._attrs[k] = v; },
    remove() { this.parentElement && this.parentElement._remove(this); }
  };
}

function makeEl() {
  const el = {
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
    prepend(node) {
      this._remove(node);
      node.parentElement = this;
      node.isConnected = true;
      this._children.unshift(node);
    },
    _remove(node) {
      const i = this._children.indexOf(node);
      if (i >= 0) { this._children.splice(i, 1); node.parentElement = null; node.isConnected = false; }
    }
  };
  return el;
}

function loadAvatar() {
  const resolveSrc = fs.readFileSync(
    path.join(__dirname, "..", "packages", "shared", "avatar.js"),
    "utf8"
  );
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "renderer", "helpers", "avatar-helpers.js"),
    "utf8"
  );
  const window = {};
  const document = { createElement: (tag) => (tag === "video" ? makeVideoEl() : makeEl()) };
  const ctx = vm.createContext({ window, globalThis: window, document, console });
  vm.runInContext(resolveSrc, ctx);
  vm.runInContext(src, ctx);
  // Treat any .mp4 as a video; trim helpers are pass-through for the test.
  window.miaAvatarMedia = {
    DEFAULT_TRIM_DURATION: 3,
    isVideo: (v) => /\.mp4(\?|#|$)/i.test(String(v || "")),
    normalizeTrim: (t = {}) => ({ start: Number(t.start) || 0, duration: Number(t.duration) || 3 }),
    trimFromCrop: (c = {}) => ({ start: Number(c.start) || 0, duration: Number(c.duration) || 3 })
  };
  return window.miaAvatar;
}

test("adopts the detached video of the same src after a container wipe", () => {
  const avatar = loadAvatar();
  const el1 = makeEl();
  avatar.applyAvatarMedia(el1, "file:///a.mp4", { start: 0, duration: 3 });
  const v1 = el1._children[0];
  assert.equal(v1.className, "avatar-video");

  // Simulate the wholesale rebuild: the old card is wiped, detaching its video.
  el1._remove(v1);
  assert.equal(v1.isConnected, false);

  // A brand-new element (new card / new contact span) for the same avatar.
  const el2 = makeEl();
  avatar.applyAvatarMedia(el2, "file:///a.mp4", { start: 0, duration: 3 });
  const v2 = el2._children[0];

  assert.equal(v2, v1, "should reuse the live video element, not mount a fresh one");
  assert.equal(v2.isConnected, true);
  assert.equal(v2._played, true);
});

test("does not steal a video that is still visible in another slot", () => {
  const avatar = loadAvatar();
  const elA = makeEl();
  const elB = makeEl();
  avatar.applyAvatarMedia(elA, "file:///same.mp4", { start: 0, duration: 3 });
  avatar.applyAvatarMedia(elB, "file:///same.mp4", { start: 0, duration: 3 });
  const vA = elA._children[0];
  const vB = elB._children[0];

  assert.notEqual(vA, vB, "two simultaneous slots get distinct elements");
  assert.equal(vA.isConnected, true);
  assert.equal(vB.isConnected, true);

  // Rebuild only slot A. Slot B stays mounted and must not be reused.
  elA._remove(vA);
  const elA2 = makeEl();
  avatar.applyAvatarMedia(elA2, "file:///same.mp4", { start: 0, duration: 3 });
  assert.equal(elA2._children[0], vA, "reuses A's detached node");
  assert.equal(elB._children[0], vB, "B's still-visible node is untouched");
});

test("mounts a fresh video when no detached match exists", () => {
  const avatar = loadAvatar();
  const el1 = makeEl();
  avatar.applyAvatarMedia(el1, "file:///old.mp4", { start: 0, duration: 3 });
  el1._remove(el1._children[0]);

  const el2 = makeEl();
  avatar.applyAvatarMedia(el2, "file:///new.mp4", { start: 0, duration: 3 });
  assert.equal(el2._children[0].getAttribute("src"), "file:///new.mp4");
});
