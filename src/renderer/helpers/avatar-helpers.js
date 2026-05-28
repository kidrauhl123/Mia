// Avatar helpers module
// Extracted from app.js. All Fellow / user avatar logic — preset library,
// crop normalization, image rendering, and DOM apply functions.
//
// Pure data and DOM helpers; no state.* references.  escapeHtml is the only
// external function dependency (injected via initAvatarHelpers).
//
// Constants live in the module and are also exposed on window.miaAvatar
// so the avatar dialog code in app.js can still read avatarPresetGroups /
// avatarPresetGroupTabs / DEFAULT_AVATAR_CROP without a separate import.
(function () {
  "use strict";

  let escapeHtml = (value) => String(value);

  function avatarMedia() {
    if (window.miaAvatarMedia) return window.miaAvatarMedia;
    return {
      isVideo: () => false,
      normalizeTrim: () => ({ start: 0, duration: 3 }),
      trimFromCrop: () => ({ start: 0, duration: 3 })
    };
  }

  function initAvatarHelpers(deps) {
    if (deps && typeof deps.escapeHtml === "function") {
      escapeHtml = deps.escapeHtml;
    }
  }

  function initials(name) {
    return (name || "?").trim().slice(0, 2).toUpperCase();
  }

  // Presets, identity hash, and crop math now live in shared/avatar-resolve.js
  // so web and renderer stay aligned. Local aliases preserve the existing
  // call-site names without forcing every caller to spell out the namespace.
  function avatarResolve() {
    if (typeof window !== "undefined" && window.miaAvatarResolve) return window.miaAvatarResolve;
    throw new Error("avatar-helpers: shared/avatar-resolve.js must load before this module");
  }

  const AVATAR_MIN_ZOOM = avatarResolve().AVATAR_MIN_ZOOM;
  const DEFAULT_AVATAR_CROP = avatarResolve().DEFAULT_AVATAR_CROP;
  const DEFAULT_PRESET_AVATAR_CROP = avatarResolve().DEFAULT_PRESET_AVATAR_CROP;
  const avatarPresetGroupTabs = avatarResolve().avatarPresetGroupTabs;
  const avatarPresetGroups = avatarResolve().avatarPresetGroups;
  const avatarPresets = avatarResolve().avatarPresets;

  const avatarAssetForKey = avatarResolve().avatarAssetForKey;
  const defaultAvatarAssets = avatarResolve().defaultAvatarAssets;
  const canonicalAvatarSrc = avatarResolve().canonicalAvatarSrc;
  const avatarPresetBySrc = avatarResolve().avatarPresetBySrc;
  const avatarPresetGroupForSrc = avatarResolve().avatarPresetGroupForSrc;
  const avatarThumbForSrc = avatarResolve().avatarThumbForSrc;
  const isNeutralAvatarCrop = avatarResolve().isNeutralAvatarCrop;
  const avatarCropForImage = avatarResolve().avatarCropForImage;

  // Renderer-specific wrapper: shared/avatar-resolve.js doesn't branch on
  // "is this a video?" because trim handling is platform-specific. Keep
  // that branch local and delegate the still-image case to the shared
  // resolver so the preset table stays single-sourced.
  function avatarDefaultCropForSrc(src) {
    if (avatarMedia().isVideo(src)) {
      return { ...DEFAULT_AVATAR_CROP, start: 0, duration: avatarMedia().DEFAULT_TRIM_DURATION || 3 };
    }
    return avatarResolve().avatarDefaultCropForSrc(src);
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

  const normalizeCrop = avatarResolve().normalizeAvatarCrop;

  function avatarBackgroundStyle(image, crop = {}, color = "#5e5ce6") {
    const src = avatarImageSrc(image) || image || "";
    if (avatarMedia().isVideo(src)) return "background-color:transparent;";
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

  function removeAvatarVideos(el) {
    el?.querySelectorAll?.(":scope > .avatar-video")?.forEach((node) => node.remove());
  }

  function removeAvatarImages(el) {
    el?.querySelectorAll?.(":scope > .avatar-image")?.forEach((node) => node.remove());
  }

  function removeAvatarChildrenExcept(el, keepNode) {
    Array.from(el?.childNodes || []).forEach((node) => {
      if (node !== keepNode) node.remove();
    });
  }

  function videoObjectStyle(crop = {}) {
    const c = normalizeCrop(crop);
    return `object-position:${c.x}% ${c.y}%;transform:scale(${c.zoom});transform-origin:${c.x}% ${c.y}%;`;
  }

  function avatarTrimForVideo(video) {
    return avatarMedia().normalizeTrim({
      start: video?.dataset?.avatarStart,
      duration: video?.dataset?.avatarDuration
    });
  }

  function avatarTrimKey(trim = {}) {
    const normalized = avatarMedia().normalizeTrim(trim);
    return `${normalized.start.toFixed(2)}:${normalized.duration.toFixed(2)}`;
  }

  function seekAvatarVideoToStart(video) {
    const trim = avatarTrimForVideo(video);
    if (!Number.isFinite(video.duration) || video.duration <= 0) return false;
    const safeStart = Math.min(trim.start, Math.max(video.duration - 0.1, 0));
    if (Math.abs(video.currentTime - safeStart) <= 0.25) return false;
    try {
      video.currentTime = safeStart;
    } catch {
      return false;
    }
    return true;
  }

  function syncAvatarVideoLoop(video) {
    if (!video || video.dataset.avatarLoopReady === "true") return;
    video.dataset.avatarLoopReady = "true";
    const seekStart = () => seekAvatarVideoToStart(video);
    video.addEventListener("loadedmetadata", seekStart);
    video.addEventListener("timeupdate", () => {
      const trim = avatarTrimForVideo(video);
      const end = trim.start + trim.duration;
      if (video.currentTime >= end) seekStart();
    });
    video.addEventListener("canplay", () => video.play?.().catch?.(() => {}));
    if (video.readyState >= 1) seekStart();
  }

  function updateAvatarVideoElement(video, image, crop = {}) {
    const src = avatarImageSrc(image) || image || "";
    const c = normalizeCrop(crop);
    const trim = avatarMedia().trimFromCrop(c);
    const trimKey = avatarTrimKey(trim);
    const sourceChanged = video.getAttribute("src") !== src;
    const trimChanged = video.dataset.avatarTrimKey !== trimKey;
    if (sourceChanged) {
      video.setAttribute("src", src);
    }
    video.loop = true;
    video.preload = "auto";
    video.setAttribute("loop", "");
    video.setAttribute("preload", "auto");
    video.setAttribute("style", videoObjectStyle(c));
    video.dataset.avatarStart = String(trim.start);
    video.dataset.avatarDuration = String(trim.duration);
    video.dataset.avatarTrimKey = trimKey;
    syncAvatarVideoLoop(video);
    if (trimChanged && !sourceChanged && video.readyState >= 1) {
      seekAvatarVideoToStart(video);
    }
    video.play?.().catch?.(() => {});
  }

  function createAvatarVideoElement(image, crop = {}) {
    const src = avatarImageSrc(image) || image || "";
    const video = document.createElement("video");
    video.className = "avatar-video";
    video.setAttribute("src", src);
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("muted", "");
    video.setAttribute("loop", "");
    video.setAttribute("autoplay", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("preload", "auto");
    video.setAttribute("aria-hidden", "true");
    updateAvatarVideoElement(video, src, crop);
    return video;
  }

  // Lists and panels (sidebar cards, contact list/detail, chat bubbles, group
  // tiles) rebuild their containers wholesale (innerHTML = "") on every render.
  // A fresh <video> reloads its source, flashes a blank frame, and restarts the
  // trim loop — so frequent renders (the 2s runtime poll, every new message)
  // make video avatars flicker and never play their set duration. Persistent
  // single-slot avatars (chat top bar, user avatar, edit preview) never showed
  // this because applyAvatarMedia reuses their own child <video> in place.
  //
  // To make every call site behave the same, park each avatar <video> here by
  // src. A wholesale rebuild detaches the old node but this Map keeps it alive,
  // so the next applyAvatarMedia for that src adopts the live element — same
  // decoded frames and playback position — instead of mounting a fresh one.
  // We only ever hand back a currently-detached node, so a src shown in several
  // slots at once is never stolen from a visible slot.
  const parkedAvatarVideos = new Map();

  function registerAvatarVideo(src, video) {
    if (!src || !video) return;
    let bucket = parkedAvatarVideos.get(src);
    if (!bucket) {
      bucket = new Set();
      parkedAvatarVideos.set(src, bucket);
    }
    bucket.add(video);
    // Bound growth: keep every attached node plus a couple of detached spares.
    const detached = [...bucket].filter((node) => node.isConnected === false);
    for (const stale of detached.slice(0, Math.max(0, detached.length - 2))) bucket.delete(stale);
  }

  function adoptParkedAvatarVideo(src) {
    const bucket = src && parkedAvatarVideos.get(src);
    if (!bucket) return null;
    for (const video of bucket) {
      if (video.isConnected === false) return video;
    }
    return null;
  }

  function updateAvatarImageElement(imageEl, image, crop = {}) {
    const src = avatarImageSrc(image) || image || "";
    if (imageEl.getAttribute("src") !== src) {
      imageEl.setAttribute("src", src);
    }
    imageEl.setAttribute("alt", "");
    imageEl.setAttribute("aria-hidden", "true");
    imageEl.draggable = false;
    // Resolve the crop the same way the CSS-background path does: a known preset
    // image with a neutral crop gets the preset's tuned face crop. Without this
    // an uncropped preset (e.g. the seeded Mia fellow's fallback avatar) renders
    // full-frame here while thumbnails render it face-cropped — the same image
    // framed two ways. avatarCropForImage is a no-op for non-preset images.
    imageEl.setAttribute("style", videoObjectStyle(normalizeCrop(avatarCropForImage(image, crop))));
  }

  function createAvatarImageElement(image, crop = {}) {
    const imageEl = document.createElement("img");
    imageEl.className = "avatar-image";
    updateAvatarImageElement(imageEl, image, crop);
    return imageEl;
  }

  function applyAvatarMedia(el, image, crop = {}, color = "#5e5ce6", fallbackText = "", options = {}) {
    if (!el) return;
    const src = avatarImageSrc(image) || image || "";
    el.style.background = "";
    el.style.backgroundImage = "";
    el.style.backgroundSize = "";
    el.style.backgroundPosition = "";
    el.style.backgroundRepeat = "";
    if (avatarMedia().isVideo(src)) {
      el.classList.add("media-avatar");
      el.classList.add("video-avatar");
      el.style.backgroundColor = "transparent";
      removeAvatarImages(el);
      const videos = Array.from(el.querySelectorAll?.(":scope > .avatar-video") || []);
      const video = videos[0] || adoptParkedAvatarVideo(src) || createAvatarVideoElement(src, crop);
      registerAvatarVideo(src, video);
      videos.slice(1).forEach((node) => node.remove());
      if (!options.preserveChildren) removeAvatarChildrenExcept(el, video);
      updateAvatarVideoElement(video, src, crop);
      if (video.parentElement !== el || video !== el.firstElementChild) el.prepend(video);
      return;
    }
    if (src) {
      el.classList.add("media-avatar");
      el.classList.remove("video-avatar");
      el.style.backgroundColor = "transparent";
      removeAvatarVideos(el);
      const images = Array.from(el.querySelectorAll?.(":scope > .avatar-image") || []);
      const imageEl = images[0] || createAvatarImageElement(src, crop);
      images.slice(1).forEach((node) => node.remove());
      if (!options.preserveChildren) removeAvatarChildrenExcept(el, imageEl);
      updateAvatarImageElement(imageEl, src, crop);
      if (imageEl.parentElement !== el || imageEl !== el.firstElementChild) el.prepend(imageEl);
      return;
    }
    el.classList.remove("media-avatar");
    el.classList.remove("video-avatar");
    el.style.backgroundColor = color || "#5e5ce6";
    removeAvatarVideos(el);
    removeAvatarImages(el);
    if (!options.preserveChildren) el.textContent = fallbackText || "";
    el.setAttribute("style", avatarThumbBackgroundStyle(image, crop, color));
  }

  // Single entry point for painting a resolved avatar descriptor
  // ({ image, crop, color }) into an existing element. Every list / card / tile
  // funnels through here instead of each repeating an "applyAvatarMedia, else
  // fall back to a background-style string" block. applyAvatarMedia already
  // covers all three cases (video, image, empty → solid color + optional
  // letter), so this also routes them through the shared video-reuse pool.
  function paintAvatar(el, avatar = {}, options = {}) {
    if (!el) return;
    applyAvatarMedia(el, avatar.image || "", avatar.crop, avatar.color || "#5e5ce6", options.fallbackText || "", options);
  }

  function avatarMediaAttrs(image = "", crop = {}, color = "#5e5ce6", text = "") {
    const normalizedCrop = normalizeCrop(crop || {});
    return [
      'data-avatar-media="1"',
      `data-avatar-image="${escapeHtml(image || "")}"`,
      `data-avatar-crop="${escapeHtml(JSON.stringify(normalizedCrop))}"`,
      `data-avatar-color="${escapeHtml(color || "#5e5ce6")}"`,
      `data-avatar-text="${escapeHtml(text || "")}"`
    ].join(" ");
  }

  function avatarHtml({ tag = "div", className = "avatar", image = "", crop = {}, color = "#5e5ce6", text = "", attrs = "" } = {}) {
    const src = avatarImageSrc(image) || image || "";
    const hasImage = Boolean(src);
    const style = hasImage
      ? "background-color:transparent;"
      : avatarThumbBackgroundStyle(image, crop, color);
    return `<${tag} class="${escapeHtml(className)}" ${attrs} ${avatarMediaAttrs(image || "", crop, color, text)} style="${style}">${hasImage ? "" : escapeHtml(text || "")}</${tag}>`;
  }

  function parseAvatarCrop(value) {
    try {
      const parsed = JSON.parse(String(value || "{}"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function hydrateAvatarMedia(root = document) {
    const targets = [];
    if (root.matches?.("[data-avatar-media]")) targets.push(root);
    root.querySelectorAll?.("[data-avatar-media]")?.forEach((el) => targets.push(el));
    targets.forEach((el) => {
      const signature = [
        el.dataset.avatarImage || "",
        el.dataset.avatarCrop || "",
        el.dataset.avatarColor || "",
        el.dataset.avatarText || ""
      ].join("\u001f");
      if (el.dataset.avatarRenderedSignature === signature) return;
      applyAvatarMedia(
        el,
        el.dataset.avatarImage || "",
        parseAvatarCrop(el.dataset.avatarCrop),
        el.dataset.avatarColor || "#5e5ce6",
        el.dataset.avatarText || ""
      );
      el.dataset.avatarRenderedSignature = signature;
    });
  }

  function hydrateAvatarVideos(root = document) {
    hydrateAvatarMedia(root);
    root.querySelectorAll?.("video.avatar-video")?.forEach((video) => {
      if (video.dataset.avatarHydrated === "true") return;
      video.dataset.avatarHydrated = "true";
      syncAvatarVideoLoop(video);
      video.play?.().catch?.(() => {});
    });
  }

  function applyFellowAvatar(el, fellow) {
    if (!el) return;
    const image = fellow?.avatarImage || avatarAssetForKey(fellow?.key);
    const id = fellow?.id || fellow?.key || "";
    const color = (typeof window !== "undefined" && window.miaMemberColor)
      ? window.miaMemberColor.memberAccentColor(id)
      : "#5e5ce6";
    applyAvatarMedia(el, image, fellow?.avatarCrop, color);
  }

  function applyAvatar(el, text, color, image) {
    if (!el) return;
    removeAvatarVideos(el);
    removeAvatarImages(el);
    el.classList?.remove("media-avatar");
    el.classList?.remove("video-avatar");
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
      applyAvatarMedia(el, image, user.avatarCrop, user.avatarColor || "#111827");
      return;
    }
    applyAvatar(el, text, user.avatarColor || "#111827", "");
  }

  window.miaAvatar = {
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
    createAvatarVideoElement,
    updateAvatarVideoElement,
    applyAvatarMedia,
    paintAvatar,
    avatarHtml,
    hydrateAvatarMedia,
    hydrateAvatarVideos,
    applyFellowAvatar,
    applyAvatar,
    applyUserAvatar,
  };
})();
