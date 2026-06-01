// Shared avatar resolution — ONE source of truth for "what does this
// contact's avatar look like" across desktop renderer, web, and mobile.
// Empty avatarImage stays empty and renders as a stable color + two-character
// label. Bundled preset avatars are legacy data now: if old records still
// point at those files, normalize them to the same empty-avatar fallback.

(function attachAvatarResolve(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaAvatarResolve = api;
})(typeof window !== "undefined" ? window : globalThis, function buildAvatarResolve() {
  "use strict";

  const AVATAR_MIN_ZOOM = 1;
  const DEFAULT_AVATAR_CROP = { x: 50, y: 50, zoom: 1 };
  const DEFAULT_AVATAR_COLOR = "#5e5ce6";

  const DEFAULT_PRESET_AVATAR_CROP = DEFAULT_AVATAR_CROP;
  const avatarPresetGroupTabs = [];
  const avatarPresetGroups = { human: [], pet: [] };

  const avatarPresets = Object.values(avatarPresetGroups).flat();

  // Compatibility export for old call sites while they are being migrated.
  // It intentionally returns an empty image: no code should synthesize a
  // bundled preset for a missing avatar anymore.
  function avatarAssetForKey() {
    return "";
  }

  function defaultAvatarAssets() {
    return [];
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
    if (!normalizeAvatarImage(image)) return null;
    return crop || { ...DEFAULT_AVATAR_CROP };
  }

  function identityDisplayText(displayName, fallback) {
    const value = String(displayName || fallback || "").trim();
    return Array.from(value).slice(0, 2).join("") || "?";
  }

  // The unifying entry point. Pass any contact-shaped record (fellow / user
  // / friend / cloud member row) and get back a renderable avatar — never
  // empty. Callers no longer branch on "do I own this fellow / is the
  // member row enriched / did I forget to set a default."
  //
  //   id           — identity key used for stable fallback color.
  //   displayName  — used for the two-character empty-avatar label.
  //   avatarImage  — explicit avatar value (URL, path, data URL).
  //   avatarCrop   — explicit crop for real uploaded/remote media.
  //
  // Result: { image, crop, color, text }. `image` is empty unless real
  // media exists; legacy bundled preset paths are treated as missing media.
  function resolveAvatarForContact(input = {}) {
    const id = String(input.id || "");
    const rawImage = normalizeAvatarImage(input.avatarImage);
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
    isLegacyPresetAvatarSrc,
    normalizeAvatarImage,
    identityDisplayText,
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
