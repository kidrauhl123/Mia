// Behaviour tests for the shared avatar resolver. The "Mia has no avatar"
// regression is the canonical motivator: a fellow whose cloud-side
// avatar_image is empty must still render with a deterministic image
// everywhere, and the same id must always map to the same preset so
// desktop and web agree.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const avatarResolve = require("../src/shared/avatar-resolve");

test("avatarAssetForKey is deterministic for the same id", () => {
  const a = avatarResolve.avatarAssetForKey("mia");
  const b = avatarResolve.avatarAssetForKey("mia");
  assert.equal(a, b);
});

test("avatarAssetForKey spreads ids across the 16-preset table", () => {
  const samples = ["mia", "kongling", "zongye", "fellow_alice", "fellow_bob", "fellow_carol"];
  const indexes = new Set(samples.map((id) => avatarResolve.avatarAssetForKey(id)));
  assert.ok(indexes.size >= 4, `hash should pick varied presets; got ${indexes.size}`);
  for (const src of indexes) {
    assert.match(src, /\.\/assets\/avatars\/(0[1-9]|1[0-6])\.png/);
  }
});

test("avatarAssetForKey treats empty id as 'mia' so anonymous contacts get a stable preset", () => {
  assert.equal(avatarResolve.avatarAssetForKey(""), avatarResolve.avatarAssetForKey("mia"));
});

test("avatarPresetBySrc finds canonical preset entries (including legacy avatar-icons path)", () => {
  const direct = avatarResolve.avatarPresetBySrc("./assets/avatars/06.png");
  assert.ok(direct, "direct preset path must resolve");
  assert.equal(direct.name, "珊瑚");
  // Legacy "./assets/avatar-icons/" form must alias to "./assets/avatars/".
  const aliased = avatarResolve.avatarPresetBySrc("./assets/avatar-icons/06.png");
  assert.ok(aliased, "legacy avatar-icons alias must still resolve");
  assert.equal(aliased.src, "./assets/avatars/06.png");
});

test("avatarPresetBySrc returns null for paths that aren't preset entries", () => {
  assert.equal(avatarResolve.avatarPresetBySrc(""), null);
  assert.equal(avatarResolve.avatarPresetBySrc("data:image/png;base64,AAAA"), null);
  assert.equal(avatarResolve.avatarPresetBySrc("./assets/avatars/99.png"), null);
});

test("avatarDefaultCropForSrc returns preset crop for known presets, neutral for unknowns", () => {
  const preset = avatarResolve.avatarDefaultCropForSrc("./assets/avatars/06.png");
  assert.equal(typeof preset.x, "number");
  assert.notDeepStrictEqual(preset, avatarResolve.DEFAULT_AVATAR_CROP);
  const unknown = avatarResolve.avatarDefaultCropForSrc("./assets/avatars/99.png");
  assert.deepEqual(unknown, avatarResolve.DEFAULT_AVATAR_CROP);
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

test("avatarCropForImage: neutral crop on a known preset switches to that preset's crop", () => {
  const preset = avatarResolve.avatarCropForImage("./assets/avatars/06.png", { x: 50, y: 50, zoom: 1 });
  assert.notDeepStrictEqual(preset, { x: 50, y: 50, zoom: 1 });
  // Explicit non-neutral crop on a preset image is preserved verbatim.
  const explicit = avatarResolve.avatarCropForImage("./assets/avatars/06.png", { x: 25, y: 25, zoom: 1.5 });
  assert.deepEqual(explicit, { x: 25, y: 25, zoom: 1.5 });
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
  // Color is always identity-derived; the `color` field on input is ignored
  // so fellow / user members never split into separate color-resolution paths.
  assert.equal(result.color, memberColor.memberAccentColor("fellow_42"));
});

test("resolveAvatarForContact: empty avatarImage falls back to identity-hashed preset", () => {
  const mia = avatarResolve.resolveAvatarForContact({ id: "mia", avatarImage: "" });
  assert.ok(mia.image, "image must not be empty after fallback");
  assert.match(mia.image, /\.\/assets\/avatars\/\d{2}\.png/);
  assert.equal(mia.image, avatarResolve.avatarAssetForKey("mia"));
  // The crop must be the preset crop for that file, not the neutral crop.
  assert.deepEqual(mia.crop, avatarResolve.avatarDefaultCropForSrc(mia.image));
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

test("resolveAvatarForContact: a neutral explicit crop on a preset image switches to that preset's crop", () => {
  const r = avatarResolve.resolveAvatarForContact({
    id: "kongling",
    avatarImage: "./assets/avatars/12.png",
    avatarCrop: { x: 50, y: 50, zoom: 1 }
  });
  assert.notDeepStrictEqual(r.crop, { x: 50, y: 50, zoom: 1 });
  assert.deepEqual(r.crop, avatarResolve.avatarDefaultCropForSrc("./assets/avatars/12.png"));
});
