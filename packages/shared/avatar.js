(function attachAvatar(root, factory) {
  const api = factory();
  const memberColorApi = { PALETTE: api.PALETTE, memberAccentColor: api.memberAccentColor };
  const mediaApi = {
    MAX_TRIM_DURATION: api.MAX_TRIM_DURATION,
    MIN_TRIM_DURATION: api.MIN_TRIM_DURATION,
    DEFAULT_TRIM_DURATION: api.DEFAULT_TRIM_DURATION,
    mediaKind: api.mediaKind,
    isVideo: api.isVideo,
    isGif: api.isGif,
    normalizeTrim: api.normalizeTrim,
    trimFromCrop: api.trimFromCrop,
    cropWithTrim: api.cropWithTrim
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.miaAvatarResolve = api;
    root.miaMemberColor = memberColorApi;
    root.miaAvatarMedia = mediaApi;
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildAvatar() {
  "use strict";

  const AVATAR_MIN_ZOOM = 1;
  const DEFAULT_AVATAR_CROP = Object.freeze({ x: 50, y: 50, zoom: 1 });
  const DEFAULT_AVATAR_COLOR = "#5e5ce6";
  const DEFAULT_PRESET_AVATAR_CROP = DEFAULT_AVATAR_CROP;
  const avatarPresetGroupTabs = Object.freeze([]);
  const avatarPresetGroups = Object.freeze({ human: Object.freeze([]), pet: Object.freeze([]) });
  const avatarPresets = Object.freeze([]);

  const PALETTE = Object.freeze([
    "#e17076",
    "#f0a574",
    "#b08fd8",
    "#7bc862",
    "#65aadd",
    "#ee7aae",
    "#6ec9cb"
  ]);

  const MAX_TRIM_DURATION = 5;
  const MIN_TRIM_DURATION = 1;
  const DEFAULT_TRIM_DURATION = 3;
  const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|ogv|ogg)(?:[?#].*)?$/i;
  const GIF_EXT_RE = /\.gif(?:[?#].*)?$/i;
  const IMAGE_EXT_RE = /\.(png|jpe?g|webp|avif|svg)(?:[?#].*)?$/i;

  function hashCode(value) {
    const str = String(value || "");
    let hash = 0;
    for (let i = 0; i < str.length; i += 1) {
      hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  function memberAccentColor(id) {
    const key = String(id || "").trim();
    if (!key) return PALETTE[0];
    return PALETTE[hashCode(key) % PALETTE.length];
  }

  function mediaKind(value = "") {
    const src = String(value || "").trim();
    if (!src) return "";
    if (/^data:video\//i.test(src) || VIDEO_EXT_RE.test(src)) return "video";
    if (/^data:image\/gif/i.test(src) || GIF_EXT_RE.test(src)) return "gif";
    if (/^data:image\//i.test(src) || IMAGE_EXT_RE.test(src)) return "image";
    return "";
  }

  function isVideo(value) {
    return mediaKind(value) === "video";
  }

  function isGif(value) {
    return mediaKind(value) === "gif";
  }

  function normalizeTrim(trim = {}) {
    const num = (value, fallback, min, max) => {
      const next = Number(value);
      if (!Number.isFinite(next)) return fallback;
      return Math.max(min, Math.min(max, next));
    };
    return {
      start: Math.round(num(trim.start ?? trim.trimStart, 0, 0, 3600) * 100) / 100,
      duration: Math.round(num(trim.duration ?? trim.trimDuration, DEFAULT_TRIM_DURATION, MIN_TRIM_DURATION, MAX_TRIM_DURATION) * 100) / 100
    };
  }

  function trimFromCrop(crop = {}) {
    return normalizeTrim({
      start: crop.start ?? crop.trimStart,
      duration: crop.duration ?? crop.trimDuration
    });
  }

  function cropWithTrim(crop = {}, trim = {}) {
    const normalized = normalizeTrim(trim);
    return {
      ...(crop || {}),
      start: normalized.start,
      duration: normalized.duration
    };
  }

  function normalizedPathForLegacyMatch(src) {
    let value = String(src || "").trim();
    if (!value) return "";
    value = value.replace(/\\/g, "/");
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        value = new URL(value).pathname || value;
      }
    } catch {
      // Keep the raw value for the prefix checks below.
    }
    value = value.replace(/^file:\/+/i, "/");
    value = value.replace(/^app:\/+/i, "/");
    value = value.replace(/^(\.\/)+/, "");
    value = value.replace(/^\/+/, "");
    return value;
  }

  function isLegacyPresetAvatarSrc(src) {
    const value = normalizedPathForLegacyMatch(src);
    return /(^|\/)assets\/(avatars|avatars-pet|avatar-thumbs|avatar-thumbs-pet|avatar-icons)\/\d{2}\.png$/i.test(value);
  }

  function normalizeAvatarImage(src) {
    const value = String(src || "").trim();
    if (!value) return "";
    return isLegacyPresetAvatarSrc(value) ? "" : value;
  }

  function hasOwn(obj, key) {
    return Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
  }

  function hasAvatarIdentityFields(record) {
    return Boolean(record && typeof record === "object" && (
      hasOwn(record, "avatarImage")
        || hasOwn(record, "avatarCrop")
        || hasOwn(record, "avatar_image")
        || hasOwn(record, "avatar_crop")
    ));
  }

  function canonicalAvatarSrc(src) {
    return normalizeAvatarImage(src);
  }

  function avatarPresetBySrc(src) {
    void src;
    return null;
  }

  function avatarPresetGroupForSrc(src) {
    void src;
    return "";
  }

  function avatarThumbForSrc(src) {
    void src;
    return "";
  }

  function avatarDefaultCropForSrc(src) {
    void src;
    return { ...DEFAULT_AVATAR_CROP };
  }

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
    const carriesTrim = hasOwn(source, "start")
      || hasOwn(source, "duration")
      || hasOwn(source, "trimStart")
      || hasOwn(source, "trimDuration");
    if (carriesTrim) Object.assign(normalized, normalizeTrim(source));
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
    if (!normalizeAvatarImage(image)) return null;
    return crop || { ...DEFAULT_AVATAR_CROP };
  }

  function identityDisplayText(displayName, fallback) {
    const value = String(displayName || fallback || "").trim();
    return Array.from(value).slice(0, 2).join("") || "?";
  }

  function resolveAvatarForContact(input = {}) {
    const id = String(input.id || "");
    const rawImage = normalizeAvatarImage(input.avatarImage);
    const color = id ? memberAccentColor(id) : DEFAULT_AVATAR_COLOR;
    if (rawImage) {
      return {
        image: rawImage,
        crop: avatarCropForImage(rawImage, input.avatarCrop),
        color,
        text: identityDisplayText(input.displayName, id)
      };
    }
    return {
      image: "",
      crop: null,
      color,
      text: identityDisplayText(input.displayName, id)
    };
  }

  function isVideoAvatar(src) {
    return isVideo(src);
  }

  function avatarCropGeometry(size, crop = null) {
    const c = normalizeAvatarCrop(crop || {});
    const inner = Math.round(size * c.zoom);
    return {
      inner,
      left: (size - inner) * (c.x / 100),
      top: (size - inner) * (c.y / 100)
    };
  }

  function normalizeAvatarDescriptor(title, avatar = {}) {
    const image = normalizeAvatarImage(avatar.image || "");
    return {
      image,
      crop: avatarCropForImage(image, avatar.crop || null),
      color: avatar.color || DEFAULT_AVATAR_COLOR,
      text: avatar.text || identityDisplayText(title, "?")
    };
  }

  function resolveAvatar(id, displayName, image = "", crop = null) {
    return resolveAvatarForContact({
      id,
      displayName,
      avatarImage: image,
      avatarCrop: crop
    });
  }

  return {
    AVATAR_MIN_ZOOM,
    DEFAULT_AVATAR_CROP,
    DEFAULT_PRESET_AVATAR_CROP,
    DEFAULT_AVATAR_COLOR,
    avatarPresetGroupTabs,
    avatarPresetGroups,
    avatarPresets,
    PALETTE,
    MAX_TRIM_DURATION,
    MIN_TRIM_DURATION,
    DEFAULT_TRIM_DURATION,
    memberAccentColor,
    mediaKind,
    isVideo,
    isGif,
    normalizeTrim,
    trimFromCrop,
    cropWithTrim,
    isLegacyPresetAvatarSrc,
    normalizeAvatarImage,
    hasAvatarIdentityFields,
    identityDisplayText,
    canonicalAvatarSrc,
    avatarPresetBySrc,
    avatarPresetGroupForSrc,
    avatarThumbForSrc,
    avatarDefaultCropForSrc,
    normalizeAvatarCrop,
    isNeutralAvatarCrop,
    avatarCropForImage,
    resolveAvatarForContact,
    isVideoAvatar,
    avatarCropGeometry,
    normalizeAvatarDescriptor,
    resolveAvatar
  };
});
