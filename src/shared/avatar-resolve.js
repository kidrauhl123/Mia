// Shared avatar resolution — ONE source of truth for "what does this
// contact's avatar look like" across desktop renderer, web, and any future
// surface. Pure data + pure functions: no DOM, no URL prefixing (each
// platform keeps its own URL-transform layer because web vs Electron resolve
// the same "./assets/..." string differently).
//
// The pieces that used to live in src/renderer/helpers/avatar-helpers.js
// (presets table, crop math, identity hash) and a partial mirror in
// src/web/app.js (AVATAR_PRESETS + helpers) now live here so both consumers
// share exactly the same constants. The renderer module keeps the DOM glue;
// the web app loads this file via a <script> tag and reads off
// window.miaAvatarResolve.
//
// Why the identity hash: contacts whose avatarImage is the empty string
// (e.g. the seeded cloud default "Mia") still need to render with SOMETHING,
// and that something must be deterministic so the same fellow looks the
// same on every device. avatarAssetForKey(id) picks one of the 16 bundled
// human presets by hashing the id. Cloud DB stays clean — empty stays empty,
// "no avatar uploaded" is a valid state — and clients derive a stable
// default at render time.

(function attachAvatarResolve(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaAvatarResolve = api;
})(typeof window !== "undefined" ? window : globalThis, function buildAvatarResolve() {
  "use strict";

  const AVATAR_MIN_ZOOM = 1;
  const DEFAULT_AVATAR_CROP = { x: 50, y: 50, zoom: 1 };
  const DEFAULT_PRESET_AVATAR_CROP = { x: 50, y: 13.5, zoom: 1.72 };
  const DEFAULT_AVATAR_COLOR = "#5e5ce6";

  const avatarPresetGroupTabs = [
    { key: "human", label: "人形" },
    { key: "pet", label: "宠物" }
  ];

  const avatarPresetGroups = {
    human: [
      { name: "青羽", src: "./assets/avatars/01.png", crop: { x: 50.0687, y: 14.5495, zoom: 2.04 } },
      { name: "桃奈", src: "./assets/avatars/02.png", crop: { x: 57.2536, y: 8.1635, zoom: 1.56 } },
      { name: "紫音", src: "./assets/avatars/03.png", crop: { x: 50, y: 14, zoom: 1.48 } },
      { name: "小栗", src: "./assets/avatars/04.png", crop: { x: 49.0079, y: 23.5736, zoom: 1.72 } },
      { name: "墨川", src: "./assets/avatars/05.png", crop: { x: 47.6785, y: 11.3611, zoom: 1.88 } },
      { name: "珊瑚", src: "./assets/avatars/06.png", crop: { x: 46.8749, y: 10.4285, zoom: 1.64 } },
      { name: "雪璃", src: "./assets/avatars/07.png", crop: { x: 51.6741, y: 8.0209, zoom: 1.72 } },
      { name: "赤焰", src: "./assets/avatars/08.png", crop: { x: 50.974, y: 12.8636, zoom: 1.88 } },
      { name: "蓝汐", src: "./assets/avatars/09.png", crop: { x: 47.4999, y: 12.2142, zoom: 1.8 } },
      { name: "棕野", src: "./assets/avatars/10.png", crop: { x: 50, y: 14, zoom: 1.8 } },
      { name: "夜莓", src: "./assets/avatars/11.png", crop: { x: 55.8037, y: 7.9731, zoom: 1.64 } },
      { name: "空铃", src: "./assets/avatars/12.png", crop: { x: 47.3214, y: 16.9763, zoom: 1.8 } },
      { name: "茉茶", src: "./assets/avatars/13.png", crop: { x: 50, y: 14, zoom: 1.8 } },
      { name: "星柚", src: "./assets/avatars/14.png", crop: { x: 50, y: 14, zoom: 1.72 } },
      { name: "爱丽丝", src: "./assets/avatars/15.png", crop: { x: 45.1848, y: 5.1022, zoom: 1.56 } },
      { name: "岚", src: "./assets/avatars/16.png", crop: { x: 51.0913, y: 15.7858, zoom: 1.72 } }
    ],
    pet: Array.from({ length: 16 }, (_item, index) => {
      const id = String(index + 1).padStart(2, "0");
      return {
        name: `宠物 ${id}`,
        src: `./assets/avatars-pet/${id}.png`,
        thumb: `./assets/avatar-thumbs-pet/${id}.png`,
        crop: { x: 50, y: 50, zoom: 1 }
      };
    })
  };

  const avatarPresets = Object.values(avatarPresetGroups).flat();

  // Identity-deterministic preset picker. Same id always maps to the same
  // bundled asset, so a contact whose owner never uploaded a custom avatar
  // still gets a stable image on every device. Default key "mia" keeps
  // bare/falsy ids from collapsing to a single preset.
  function avatarAssetForKey(key = "") {
    let hash = 0;
    for (const char of String(key || "mia")) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    const index = (hash % 16) + 1;
    return `./assets/avatars/${String(index).padStart(2, "0")}.png`;
  }

  function defaultAvatarAssets() {
    return avatarPresetGroups.human.map((preset) => preset.src);
  }

  // Legacy preset paths used "./assets/avatar-icons/" before the rename;
  // canonicalize so old configs still hit the preset table.
  function canonicalAvatarSrc(src) {
    return String(src || "").trim().replace("./assets/avatar-icons/", "./assets/avatars/");
  }

  function avatarPresetBySrc(src) {
    const canonical = canonicalAvatarSrc(src);
    if (!canonical) return null;
    return avatarPresets.find((preset) => preset.src === canonical) || null;
  }

  function avatarPresetGroupForSrc(src) {
    const canonical = canonicalAvatarSrc(src);
    return avatarPresetGroupTabs.find(({ key }) =>
      avatarPresetGroups[key]?.some((preset) => preset.src === canonical)
    )?.key || "";
  }

  function avatarThumbForSrc(src) {
    const preset = avatarPresetBySrc(src);
    if (!preset) return "";
    if (preset.thumb) return preset.thumb;
    return canonicalAvatarSrc(preset.src).replace("./assets/avatars/", "./assets/avatar-thumbs/");
  }

  function avatarDefaultCropForSrc(src) {
    const preset = avatarPresetBySrc(src);
    if (!preset) return { ...DEFAULT_AVATAR_CROP };
    return { ...DEFAULT_PRESET_AVATAR_CROP, ...(preset.crop || {}) };
  }

  // Clamp x/y to [0..100] (background-position percentages) and zoom to
  // [AVATAR_MIN_ZOOM..2.4] (the crop slider's range). Trim fields, if
  // present, are passed through to shared/avatar-media.js when available;
  // otherwise we preserve them so the caller can decide what to do.
  function normalizeAvatarCrop(crop = {}) {
    const source = crop && typeof crop === "object" ? crop : {};
    const num = (value, fallback, min, max) => {
      const next = Number(value);
      if (!Number.isFinite(next)) return fallback;
      return Math.max(min, Math.min(max, next));
    };
    const normalized = {
      x: num(source.x, 50, 0, 100),
      y: num(source.y, 50, 0, 100),
      zoom: num(source.zoom, 1, AVATAR_MIN_ZOOM, 2.4)
    };
    const carriesTrim = Object.prototype.hasOwnProperty.call(source, "start")
      || Object.prototype.hasOwnProperty.call(source, "duration")
      || Object.prototype.hasOwnProperty.call(source, "trimStart")
      || Object.prototype.hasOwnProperty.call(source, "trimDuration");
    if (carriesTrim) {
      const media = (typeof window !== "undefined" && window.miaAvatarMedia)
        || (typeof require === "function" ? (function () { try { return require("./avatar-media.js"); } catch { return null; } })() : null);
      if (media && typeof media.normalizeTrim === "function") {
        Object.assign(normalized, media.normalizeTrim(source));
      } else {
        if (source.start != null) normalized.start = Number(source.start) || 0;
        if (source.duration != null) normalized.duration = Number(source.duration) || 3;
      }
    }
    return normalized;
  }

  function isNeutralAvatarCrop(crop) {
    if (!crop || typeof crop !== "object") return true;
    const x = Number(crop.x);
    const y = Number(crop.y);
    const zoom = Number(crop.zoom);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return true;
    return Math.abs(x - 50) < 0.01 && Math.abs(y - 50) < 0.01 && Math.abs(zoom - 1) < 0.001;
  }

  function avatarCropForImage(image, crop) {
    if (avatarPresetBySrc(image) && isNeutralAvatarCrop(crop)) {
      return avatarDefaultCropForSrc(image);
    }
    return crop || { ...DEFAULT_AVATAR_CROP };
  }

  // The unifying entry point. Pass any contact-shaped record (fellow / user
  // / friend / cloud member row) and get back a renderable avatar — never
  // empty. Callers no longer branch on "do I own this fellow / is the
  // member row enriched / did I forget to set a default."
  //
  //   id           — used for the identity-hash fallback when avatarImage
  //                  is empty. Pass fellow.id / user.id / member.member_ref.
  //   avatarImage  — explicit avatar value (URL, path, data URL).
  //   avatarCrop   — explicit crop; falls back to the preset crop when the
  //                  image happens to match a known preset, otherwise the
  //                  neutral crop.
  //   color        — accent / fallback color; defaults to DEFAULT_AVATAR_COLOR.
  //
  // Result: { image, crop, color }. `image` is always a non-empty path
  // (either the caller's value or a preset hashed from `id`).
  function resolveAvatarForContact(input = {}) {
    const id = String(input.id || "");
    const rawImage = String(input.avatarImage || "").trim();
    // Color is identity-derived: every conversation participant (fellow or
    // user) gets the same hashed palette color so the avatar tile, bubble
    // name title, and any other per-member chip stay in sync without any
    // per-member color preference stored anywhere.
    const memberColor = (typeof globalThis !== "undefined" && globalThis.miaMemberColor)
      || (typeof require === "function" ? require("./member-color.js") : null);
    const color = memberColor && id ? memberColor.memberAccentColor(id) : DEFAULT_AVATAR_COLOR;
    if (rawImage) {
      return {
        image: rawImage,
        crop: avatarCropForImage(rawImage, input.avatarCrop),
        color
      };
    }
    const presetSrc = avatarAssetForKey(id);
    return {
      image: presetSrc,
      crop: avatarDefaultCropForSrc(presetSrc),
      color
    };
  }

  return {
    AVATAR_MIN_ZOOM,
    DEFAULT_AVATAR_CROP,
    DEFAULT_PRESET_AVATAR_CROP,
    DEFAULT_AVATAR_COLOR,
    avatarPresetGroupTabs,
    avatarPresetGroups,
    avatarPresets,
    avatarAssetForKey,
    defaultAvatarAssets,
    canonicalAvatarSrc,
    avatarPresetBySrc,
    avatarPresetGroupForSrc,
    avatarThumbForSrc,
    avatarDefaultCropForSrc,
    normalizeAvatarCrop,
    isNeutralAvatarCrop,
    avatarCropForImage,
    resolveAvatarForContact
  };
});
