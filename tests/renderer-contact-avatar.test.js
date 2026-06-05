const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHelper() {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "contact-avatar.js"), "utf8");
  const paintCalls = [];
  const mockEl = () => {
    const el = {
      tagName: "SPAN",
      className: "",
      attrs: {},
      style: { cssText: "" },
      _text: "",
      setAttribute(k, v) { this.attrs[k] = v; },
      get textContent() { return this._text; },
      set textContent(v) { this._text = v; }
    };
    return el;
  };
  const avatarThumbBackgroundStyle = (img, crop, color) => `background-image:url(${img});background-color:${color};`;
  const window = {
    miaAvatar: {
      avatarThumbBackgroundStyle,
      // renderAvatar now delegates image/video painting to the shared entry
      // point; the real one mounts an <img>/<video>, here we just reflect it
      // into cssText so the test can assert the delegation happened.
      paintAvatar: (el, avatar) => {
        paintCalls.push({ el, avatar });
        el.style.cssText = avatarThumbBackgroundStyle(avatar.image, avatar.crop, avatar.color);
      }
    }
  };
  const ctx = vm.createContext({ window, globalThis: window, document: { createElement: () => mockEl() }, console });
  vm.runInContext(src, ctx);
  return { helper: window.miaContactAvatar, paintCalls };
}

test("renderAvatar with image returns styled element", () => {
  const { helper, paintCalls } = loadHelper();
  const el = helper.renderAvatar({ kind: "fellow", id: "x", displayName: "Codex", avatar: { image: "data:x", crop: null, color: "#5e5ce6" } });
  assert.match(el.style.cssText, /background-image:url\(data:x\)/);
  assert.equal(paintCalls.length, 1);
});

test("renderAvatar without image still delegates to shared avatar painter", () => {
  const { helper, paintCalls } = loadHelper();
  const el = helper.renderAvatar({ kind: "user", id: "u", displayName: "Alice", avatar: { image: "", crop: null, color: "#34c759", text: "AL" } });
  assert.equal(el.textContent, "");
  assert.equal(paintCalls.length, 1);
  assert.equal(paintCalls[0].avatar.image, "");
  assert.equal(paintCalls[0].avatar.crop, null);
  assert.equal(paintCalls[0].avatar.color, "#34c759");
  assert.equal(paintCalls[0].avatar.text, "AL");
  assert.match(el.style.cssText, /background-color:#34c759/);
});

test("renderAvatar empty contact uses ? letter", () => {
  const { helper, paintCalls } = loadHelper();
  const el = helper.renderAvatar({ kind: "", id: "", displayName: "", avatar: { image: "", color: "" } });
  assert.equal(el.textContent, "");
  assert.equal(paintCalls[0].avatar.text, "?");
});
