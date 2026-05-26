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

  function avatarAssetForKey(key = "") {
    let hash = 0;
    for (const char of String(key || "mia")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const index = (hash % 16) + 1;
    return `./assets/avatars/${String(index).padStart(2, "0")}.png`;
  }

  const AVATAR_MIN_ZOOM = 1;
  const DEFAULT_AVATAR_CROP = { x: 50, y: 50, zoom: 1 };
  const DEFAULT_PRESET_AVATAR_CROP = { x: 50, y: 13.5, zoom: 1.72 };
  const avatarVideoLoopEpochs = new Map();

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
    if (avatarMedia().isVideo(src)) return { ...DEFAULT_AVATAR_CROP, start: 0, duration: avatarMedia().DEFAULT_TRIM_DURATION || 3 };
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
    if (
      Object.prototype.hasOwnProperty.call(source, "start")
      || Object.prototype.hasOwnProperty.call(source, "duration")
      || Object.prototype.hasOwnProperty.call(source, "trimStart")
      || Object.prototype.hasOwnProperty.call(source, "trimDuration")
    ) {
      Object.assign(normalized, avatarMedia().normalizeTrim(source));
    }
    return normalized;
  }

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

  function avatarClockNow() {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
    return Date.now();
  }

  function avatarLoopHash(value) {
    let hash = 0;
    const text = String(value || "");
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
  }

  function avatarVideoLoopKey(image, crop = {}) {
    const src = avatarImageSrc(image) || image || "";
    const c = normalizeCrop(crop);
    const trim = avatarMedia().trimFromCrop(c);
    return [
      avatarLoopHash(src),
      c.x.toFixed(2),
      c.y.toFixed(2),
      c.zoom.toFixed(3),
      trim.start.toFixed(2),
      trim.duration.toFixed(2)
    ].join("\u001f");
  }

  function avatarVideoLoopEpoch(key) {
    const normalizedKey = String(key || "");
    if (!avatarVideoLoopEpochs.has(normalizedKey)) {
      avatarVideoLoopEpochs.set(normalizedKey, avatarClockNow());
    }
    return avatarVideoLoopEpochs.get(normalizedKey);
  }

  function avatarVideoTargetTime(video) {
    const trim = avatarTrimForVideo(video);
    const duration = Math.max(Number(trim.duration) || avatarMedia().DEFAULT_TRIM_DURATION || 3, 0.1);
    const epoch = Number(video?.dataset?.avatarLoopEpoch);
    const startedAt = Number.isFinite(epoch) ? epoch : avatarClockNow();
    const elapsed = Math.max(0, (avatarClockNow() - startedAt) / 1000);
    return trim.start + (elapsed % duration);
  }

  function showAvatarVideo(video) {
    if (!video) return;
    const schedule = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 0);
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => schedule(() => video.classList.add("ready")));
      return;
    }
    schedule(() => video.classList.add("ready"));
  }

  function syncAvatarVideoLoop(video) {
    if (!video || video.dataset.avatarLoopReady === "true") return;
    video.dataset.avatarLoopReady = "true";
    const seekStart = () => {
      const trim = avatarTrimForVideo(video);
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      const target = avatarVideoTargetTime(video);
      const safeTarget = Math.min(target, Math.max(video.duration - 0.1, 0));
      if (Math.abs(video.currentTime - safeTarget) > 0.08) {
        video.addEventListener("seeked", () => showAvatarVideo(video), { once: true });
        try {
          video.currentTime = safeTarget;
        } catch {
          showAvatarVideo(video);
        }
        return;
      }
      showAvatarVideo(video);
    };
    video.addEventListener("loadedmetadata", seekStart);
    video.addEventListener("timeupdate", () => {
      const trim = avatarTrimForVideo(video);
      const end = trim.start + trim.duration;
      const target = avatarVideoTargetTime(video);
      const drift = Math.abs(video.currentTime - target);
      if (video.currentTime < trim.start - 0.15 || video.currentTime >= end || drift > 0.45) seekStart();
    });
    video.addEventListener("ended", () => {
      seekStart();
      video.play?.().catch?.(() => {});
    });
    video.addEventListener("canplay", () => {
      video.play?.().catch?.(() => {});
    });
    if (video.readyState >= 1) seekStart();
  }

  function updateAvatarVideoElement(video, image, crop = {}) {
    const src = avatarImageSrc(image) || image || "";
    const c = normalizeCrop(crop);
    const trim = avatarMedia().trimFromCrop(c);
    const loopKey = avatarVideoLoopKey(src, c);
    const changed = video.getAttribute("src") !== src || video.dataset.avatarLoopKey !== loopKey;
    if (changed) {
      video.classList.remove("ready");
      video.setAttribute("src", src);
    }
    video.loop = false;
    video.removeAttribute("loop");
    video.preload = "auto";
    video.setAttribute("preload", "auto");
    video.setAttribute("style", videoObjectStyle(c));
    video.dataset.avatarStart = String(trim.start);
    video.dataset.avatarDuration = String(trim.duration);
    video.dataset.avatarLoopKey = loopKey;
    video.dataset.avatarLoopEpoch = String(avatarVideoLoopEpoch(loopKey));
    syncAvatarVideoLoop(video);
    if (video.readyState >= 1) {
      video.classList.remove("ready");
      const trimTarget = Math.min(avatarVideoTargetTime(video), Math.max(video.duration - 0.1, 0));
      try {
        if (Number.isFinite(trimTarget) && Math.abs(video.currentTime - trimTarget) > 0.08) {
          video.currentTime = trimTarget;
        }
      } catch {
        // Ignore browser seek failures; the loop synchronizer will retry.
      }
      showAvatarVideo(video);
    }
    video.play?.().catch?.(() => {});
  }

  function createAvatarVideoElement(image, crop = {}) {
    const src = avatarImageSrc(image) || image || "";
    const video = document.createElement("video");
    video.className = "avatar-video";
    video.setAttribute("src", src);
    video.muted = true;
    video.loop = false;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("muted", "");
    video.setAttribute("autoplay", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("preload", "auto");
    video.setAttribute("aria-hidden", "true");
    updateAvatarVideoElement(video, src, crop);
    return video;
  }

  function updateAvatarImageElement(imageEl, image, crop = {}) {
    const src = avatarImageSrc(image) || image || "";
    if (imageEl.getAttribute("src") !== src) {
      imageEl.setAttribute("src", src);
    }
    imageEl.setAttribute("alt", "");
    imageEl.setAttribute("aria-hidden", "true");
    imageEl.draggable = false;
    imageEl.setAttribute("style", videoObjectStyle(normalizeCrop(crop)));
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
      const video = videos[0] || createAvatarVideoElement(src, crop);
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
    applyAvatarMedia(el, image, fellow?.avatarCrop, fellow?.color || "#5e5ce6");
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
    avatarHtml,
    hydrateAvatarMedia,
    hydrateAvatarVideos,
    applyFellowAvatar,
    applyAvatar,
    applyUserAvatar,
  };
})();
