// Avatar helpers module
// Extracted from app.js. All Fellow / user avatar logic — preset library,
// crop normalization, image rendering, and DOM apply functions.
//
// Pure data and DOM helpers; no state.* references.  escapeHtml is the only
// external function dependency (injected via initAvatarHelpers).
//
// Constants live in the module and are also exposed on window.aimashiAvatar
// so the avatar dialog code in app.js can still read avatarPresetGroups /
// avatarPresetGroupTabs / DEFAULT_AVATAR_CROP without a separate import.
(function () {
  "use strict";

  let escapeHtml = (value) => String(value);

  function initAvatarHelpers(deps) {
    if (deps && typeof deps.escapeHtml === "function") {
      escapeHtml = deps.escapeHtml;
    }
  }

  function initials(name) {
    return (name || "?").trim().slice(0, 2).toUpperCase();
  }

  function avatarAssetForKey(key = "") {
    let hash = 0;
    for (const char of String(key || "aimashi")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const index = (hash % 16) + 1;
    return `./assets/avatars/${String(index).padStart(2, "0")}.png`;
  }

  const AVATAR_MIN_ZOOM = 1;
  const DEFAULT_AVATAR_CROP = { x: 50, y: 50, zoom: 1 };
  const DEFAULT_PRESET_AVATAR_CROP = { x: 50, y: 13.5, zoom: 1.72 };

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

  function defaultAvatarAssets() {
    return avatarPresetGroups.human.map((preset) => preset.src);
  }

  function canonicalAvatarSrc(src) {
    return String(src || "").trim().replace("./assets/avatar-icons/", "./assets/avatars/");
  }

  function avatarPresetBySrc(src) {
    const canonical = canonicalAvatarSrc(src);
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

  function isNeutralAvatarCrop(crop) {
    if (!crop) return true;
    const c = normalizeCrop(crop);
    return c.x === 50 && c.y === 50 && Math.abs(c.zoom - 1) < 0.001;
  }

  function avatarCropForImage(image, crop) {
    if (avatarPresetBySrc(image) && isNeutralAvatarCrop(crop)) {
      return avatarDefaultCropForSrc(image);
    }
    return crop || DEFAULT_AVATAR_CROP;
  }

  function cropsClose(a = {}, b = {}) {
    const left = normalizeCrop(a);
    const right = normalizeCrop(b);
    return Math.abs(left.x - right.x) < 0.01
      && Math.abs(left.y - right.y) < 0.01
      && Math.abs(left.zoom - right.zoom) < 0.001;
  }

  function avatarImageSrc(value) {
    const raw = canonicalAvatarSrc(value);
    if (!raw) return "";
    if (/^(https?:|file:|data:)/i.test(raw)) return raw;
    if (raw.startsWith("./") || raw.startsWith("../")) return raw;
    return `file://${raw}`;
  }

  function normalizeCrop(crop = {}) {
    const num = (value, fallback, min, max) => {
      const next = Number(value);
      if (!Number.isFinite(next)) return fallback;
      return Math.max(min, Math.min(max, next));
    };
    return {
      x: num(crop.x, 50, 0, 100),
      y: num(crop.y, 50, 0, 100),
      zoom: num(crop.zoom, 1, AVATAR_MIN_ZOOM, 2.4)
    };
  }

  function avatarBackgroundStyle(image, crop = {}, color = "#5e5ce6") {
    const src = avatarImageSrc(image) || image || "";
    const effectiveCrop = avatarCropForImage(image, crop);
    const c = normalizeCrop(effectiveCrop);
    const imagePart = src ? `background-image:url('${escapeHtml(src)}');` : "";
    const backgroundColor = src ? "transparent" : escapeHtml(color);
    const position = `${c.x}% ${c.y}%`;
    return `background-color:${backgroundColor};${imagePart}background-size:${Math.round(c.zoom * 100)}%;background-position:${position};background-repeat:no-repeat;`;
  }

  function avatarThumbBackgroundStyle(image, crop = {}, color = "#5e5ce6") {
    const thumb = avatarThumbForSrc(image);
    const effectiveCrop = avatarCropForImage(image, crop);
    if (thumb && cropsClose(effectiveCrop, avatarDefaultCropForSrc(image))) {
      const src = avatarImageSrc(thumb);
      return `background-color:transparent;background-image:url('${escapeHtml(src)}');background-size:cover;background-position:center;background-repeat:no-repeat;`;
    }
    return avatarBackgroundStyle(image, crop, color);
  }

  function applyFellowAvatar(el, fellow) {
    if (!el) return;
    el.textContent = "";
    const image = fellow?.avatarImage || avatarAssetForKey(fellow?.key);
    el.setAttribute("style", avatarThumbBackgroundStyle(image, fellow?.avatarCrop, fellow?.color || "#5e5ce6"));
  }

  function applyAvatar(el, text, color, image) {
    if (!el) return;
    el.textContent = text || "?";
    el.style.background = color || "#111827";
    el.style.backgroundImage = "";
    el.style.backgroundSize = "";
    el.style.backgroundPosition = "";
    const src = avatarImageSrc(image);
    if (src) {
      el.textContent = "";
      el.style.backgroundImage = `url("${src.replaceAll('"', "%22")}")`;
      el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center";
    }
  }

  function applyUserAvatar(el, user = {}) {
    if (!el) return;
    const image = user.avatarImage || "";
    const text = user.avatarText || initials(user.displayName || "Boss");
    if (image) {
      el.textContent = "";
      el.setAttribute("style", avatarThumbBackgroundStyle(image, user.avatarCrop, user.avatarColor || "#111827"));
      return;
    }
    applyAvatar(el, text, user.avatarColor || "#111827", "");
  }

  window.aimashiAvatar = {
    initAvatarHelpers,
    DEFAULT_AVATAR_CROP,
    DEFAULT_PRESET_AVATAR_CROP,
    AVATAR_MIN_ZOOM,
    avatarPresetGroupTabs,
    avatarPresetGroups,
    avatarPresets,
    initials,
    avatarAssetForKey,
    defaultAvatarAssets,
    canonicalAvatarSrc,
    avatarPresetBySrc,
    avatarPresetGroupForSrc,
    avatarThumbForSrc,
    avatarDefaultCropForSrc,
    isNeutralAvatarCrop,
    avatarCropForImage,
    cropsClose,
    avatarImageSrc,
    normalizeCrop,
    avatarBackgroundStyle,
    avatarThumbBackgroundStyle,
    applyFellowAvatar,
    applyAvatar,
    applyUserAvatar,
  };
})();
