// Behaviour tests for the shared avatar resolver. Missing avatars render as
// stable color + two-character text. Bundled preset avatar paths are legacy
// data and must normalize to the same empty-avatar fallback.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const avatarResolve = require("../src/shared/avatar-resolve");

test("avatar preset catalog exports are empty", () => {
  assert.deepEqual(avatarResolve.avatarPresets, []);
  assert.deepEqual(avatarResolve.avatarPresetGroupTabs, []);
  assert.deepEqual(avatarResolve.avatarPresetGroups.human, []);
  assert.deepEqual(avatarResolve.avatarPresetGroups.pet, []);
});

test("avatarPresetBySrc treats former bundled preset paths as legacy, not selectable presets", () => {
  assert.equal(avatarResolve.avatarPresetBySrc("./assets/avatars/06.png"), null);
  assert.equal(avatarResolve.avatarPresetBySrc("./assets/avatar-icons/06.png"), null);
  assert.equal(avatarResolve.avatarPresetGroupForSrc("./assets/avatars-pet/06.png"), "");
  assert.equal(avatarResolve.avatarThumbForSrc("./assets/avatars/06.png"), "");
});

test("avatarPresetBySrc returns null for paths that aren't preset entries", () => {
  assert.equal(avatarResolve.avatarPresetBySrc(""), null);
  assert.equal(avatarResolve.avatarPresetBySrc("data:image/png;base64,AAAA"), null);
  assert.equal(avatarResolve.avatarPresetBySrc("./assets/avatars/99.png"), null);
});

test("avatarDefaultCropForSrc returns neutral crop now that bundled presets are removed", () => {
  assert.deepEqual(avatarResolve.avatarDefaultCropForSrc("./assets/avatars/06.png"), avatarResolve.DEFAULT_AVATAR_CROP);
  assert.deepEqual(avatarResolve.avatarDefaultCropForSrc("./assets/avatars/99.png"), avatarResolve.DEFAULT_AVATAR_CROP);
});

test("normalizeAvatarCrop clamps x/y to [0,100] and zoom to [1,2.4]", () => {
  const clamped = avatarResolve.normalizeAvatarCrop({ x: 200, y: -10, zoom: 5 });
  assert.equal(clamped.x, 100);
  assert.equal(clamped.y, 0);
  assert.equal(clamped.zoom, 2.4);
  const passthrough = avatarResolve.normalizeAvatarCrop({ x: 50, y: 14, zoom: 1.5 });
  assert.deepEqual(passthrough, { x: 50, y: 14, zoom: 1.5 });
});

test("normalizeAvatarCrop preserves trim fields when carried by the input", () => {
  const trimmed = avatarResolve.normalizeAvatarCrop({ x: 50, y: 50, zoom: 1, start: 1.5, duration: 3 });
  assert.equal(trimmed.start, 1.5);
  assert.equal(trimmed.duration, 3);
});

test("isNeutralAvatarCrop matches the (50, 50, 1) default and flags real crops as non-neutral", () => {
  assert.equal(avatarResolve.isNeutralAvatarCrop(null), true);
  assert.equal(avatarResolve.isNeutralAvatarCrop({}), true);
  assert.equal(avatarResolve.isNeutralAvatarCrop({ x: 50, y: 50, zoom: 1 }), true);
  assert.equal(avatarResolve.isNeutralAvatarCrop({ x: 50, y: 14, zoom: 1.72 }), false);
});

test("avatarCropForImage returns null for former bundled preset paths", () => {
  assert.equal(avatarResolve.avatarCropForImage("./assets/avatars/06.png", { x: 50, y: 50, zoom: 1 }), null);
  assert.equal(avatarResolve.avatarCropForImage("./assets/avatars/06.png", { x: 25, y: 25, zoom: 1.5 }), null);
});

test("resolveAvatarForContact: explicit avatarImage wins and carries its crop", () => {
  const memberColor = require("../src/shared/member-color.js");
  const result = avatarResolve.resolveAvatarForContact({
    id: "fellow_42",
    avatarImage: "data:image/png;base64,AAAA",
    avatarCrop: { x: 60, y: 20, zoom: 1.4 },
    color: "#ff9f0a"
  });
  assert.equal(result.image, "data:image/png;base64,AAAA");
  assert.deepEqual(result.crop, { x: 60, y: 20, zoom: 1.4 });
  // A user-set accent color wins (this is what the color picker stores); only
  // members with no color fall back to the id hash.
  assert.equal(result.color, "#ff9f0a");
  assert.equal(
    avatarResolve.resolveAvatarForContact({ id: "fellow_42" }).color,
    memberColor.memberAccentColor("fellow_42")
  );
});

test("resolveAvatarForContact: bundled emoji avatars are explicit media without crop", () => {
  const result = avatarResolve.resolveAvatarForContact({
    id: "course-tutor",
    displayName: "课程助教",
    avatarImage: "emoji:books",
    avatarCrop: { x: 60, y: 20, zoom: 1.4 },
    color: "#5e5ce6"
  });

  assert.equal(avatarResolve.isEmojiAvatar(result.image), true);
  assert.equal(avatarResolve.emojiAvatarToken(result.image), "books");
  assert.equal(avatarResolve.emojiAvatarGlyph(result.image), "📚");
  assert.equal(result.image, "emoji:books");
  assert.equal(result.crop, null);
  assert.equal(result.color, "#5e5ce6");
  assert.equal(result.text, "课程");
});

test("resolveAvatarForContact: empty avatarImage returns color and text fallback", () => {
  const mia = avatarResolve.resolveAvatarForContact({ id: "mia", avatarImage: "" });
  assert.equal(mia.image, "");
  assert.equal(mia.crop, null);
  assert.equal(mia.text, "mi");
});

test("resolveAvatarForContact: same id always yields the same fallback (deterministic across calls)", () => {
  const first = avatarResolve.resolveAvatarForContact({ id: "kongling" });
  const second = avatarResolve.resolveAvatarForContact({ id: "kongling" });
  assert.deepEqual(first, second);
});

test("resolveAvatarForContact: color comes from the shared id-hashed palette", () => {
  const memberColor = require("../src/shared/member-color.js");
  const r = avatarResolve.resolveAvatarForContact({ id: "anon" });
  assert.equal(r.color, memberColor.memberAccentColor("anon"));
});

test("resolveAvatarForContact: empty avatarImage returns text fallback instead of a preset image", () => {
  const memberColor = require("../src/shared/member-color.js");
  const r = avatarResolve.resolveAvatarForContact({
    id: "fellow:kongling",
    displayName: "空铃"
  });
  assert.equal(r.image, "");
  assert.equal(r.crop, null);
  assert.equal(r.text, "空铃");
  assert.equal(r.color, memberColor.memberAccentColor("fellow:kongling"));
});

test("generatedAvatarDataUri is safe inside a single-quoted CSS url", () => {
  const uri = avatarResolve.generatedAvatarDataUri("#65aadd", "空铃");
  assert.match(uri, /^data:image\/svg\+xml,/);
  assert.equal(uri.includes("'"), false);
  assert.match(decodeURIComponent(uri), /'PingFang SC'/);
  assert.match(decodeURIComponent(uri), />空铃<\/text>/);
});

test("resolveAvatarForContact: legacy bundled preset paths are treated as missing avatars", () => {
  const cases = [
    "./assets/avatars/12.png",
    "/assets/avatars/12.png",
    "assets/avatars-pet/03.png",
    "app://bundle/assets/avatar-thumbs/01.png",
    "./assets/avatar-icons/06.png"
  ];
  for (const avatarImage of cases) {
    const r = avatarResolve.resolveAvatarForContact({
      id: "user_legacy",
      displayName: "旧用户",
      avatarImage,
      avatarCrop: { x: 10, y: 20, zoom: 2 }
    });
    assert.equal(r.image, "", avatarImage);
    assert.equal(r.crop, null, avatarImage);
    assert.equal(r.text, "旧用", avatarImage);
  }
});

test("resolveAvatarForContact: a former preset image is normalized to text fallback", () => {
  const r = avatarResolve.resolveAvatarForContact({
    id: "kongling",
    displayName: "空铃",
    avatarImage: "./assets/avatars/12.png",
    avatarCrop: { x: 50, y: 50, zoom: 1 }
  });
  assert.equal(r.image, "");
  assert.equal(r.crop, null);
  assert.equal(r.text, "空铃");
});

test("hasAvatarIdentityFields distinguishes compact payloads from explicit empty avatars", () => {
  assert.equal(avatarResolve.hasAvatarIdentityFields({ id: "u1", username: "alice" }), false);
  assert.equal(avatarResolve.hasAvatarIdentityFields({ id: "u1", avatarImage: "" }), true);
  assert.equal(avatarResolve.hasAvatarIdentityFields({ id: "u1", avatarCrop: null }), true);
  assert.equal(avatarResolve.hasAvatarIdentityFields({ id: "u1", avatar_image: "" }), true);
  assert.equal(avatarResolve.hasAvatarIdentityFields(null), false);
});
