const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const avatarMedia = require("../src/shared/avatar-media");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadBrowserGlobal() {
  const source = fs.readFileSync(path.join(root, "packages/shared/avatar.js"), "utf8");
  const context = { window: {} };
  context.globalThis = context.window;
  vm.runInNewContext(source, context, { filename: "packages/shared/avatar.js" });
  return context.window.miaAvatarMedia;
}

test("avatar-media detects image gif and video avatar sources", () => {
  assert.equal(avatarMedia.mediaKind("data:image/png;base64,abc"), "image");
  assert.equal(avatarMedia.mediaKind("data:image/gif;base64,abc"), "gif");
  assert.equal(avatarMedia.mediaKind("data:video/mp4;base64,abc"), "video");
  assert.equal(avatarMedia.mediaKind("/avatars/me.webm"), "video");
  assert.equal(avatarMedia.mediaKind("emoji:books"), "emoji");
  assert.equal(avatarMedia.isEmojiAvatar("emoji:books"), true);
  assert.equal(avatarMedia.emojiAvatarGlyph("emoji:books"), "📚");
  assert.equal(avatarMedia.isEmojiAvatar("emoji:satellite"), true);
  assert.equal(avatarMedia.emojiAvatarGlyph("emoji:satellite"), "🛰️");
  assert.equal(avatarMedia.isEmojiAvatar("emoji:dice"), true);
  assert.equal(avatarMedia.emojiAvatarGlyph("emoji:dice"), "🎲");
  assert.equal(avatarMedia.emojiAvatarToken("emoji:../../bad"), "");
  assert.equal(avatarMedia.isEmojiAvatar("emoji:unknown"), false);
});

test("avatar-media normalizes video trim to a short loop", () => {
  assert.deepEqual(avatarMedia.normalizeTrim({ start: -4, duration: 99 }), {
    start: 0,
    duration: 5
  });
  assert.deepEqual(avatarMedia.normalizeTrim({ start: 1.234, duration: 0.1 }), {
    start: 1.23,
    duration: 1
  });
});

test("avatar-media contract is available in browser contexts", () => {
  const browserContract = loadBrowserGlobal();
  assert.equal(browserContract.isVideo("data:video/webm;base64,abc"), true);
  assert.equal(browserContract.isVideo("data:image/gif;base64,abc"), false);
  assert.equal(browserContract.isEmojiAvatar("emoji:check"), true);
  assert.equal(browserContract.emojiAvatarGlyph("emoji:check"), "✅");
  assert.equal(browserContract.isEmojiAvatar("emoji:dice"), true);
  assert.equal(browserContract.emojiAvatarGlyph("emoji:dice"), "🎲");
  assert.deepEqual(plain(browserContract.normalizeTrim({ start: 2, duration: 3 })), { start: 2, duration: 3 });
});
