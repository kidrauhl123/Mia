(function (global) {
  "use strict";

  const THUMBNAIL_SIZE = 256;
  const MAX_CACHE_ENTRIES = 64;
  const cache = new Map();

  function clamp(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function normalizeCrop(crop = {}) {
    return {
      x: clamp(crop?.x, 50, 0, 100),
      y: clamp(crop?.y, 50, 0, 100),
      zoom: clamp(crop?.zoom, 1, 1, 2.4)
    };
  }

  function thumbnailSourceRect(imageWidth, imageHeight, crop = {}) {
    const width = Math.max(1, Number(imageWidth) || 1);
    const height = Math.max(1, Number(imageHeight) || 1);
    const normalized = normalizeCrop(crop);
    const visibleSize = Math.min(width, height) / normalized.zoom;
    return {
      x: (width - visibleSize) * (normalized.x / 100),
      y: (height - visibleSize) * (normalized.y / 100),
      width: visibleSize,
      height: visibleSize
    };
  }

  function supportsThumbnail(src) {
    const value = String(src || "").trim();
    if (!value || /^emoji:/i.test(value)) return false;
    if (/^data:image\/(?:gif|svg\+xml)(?:[;,]|$)/i.test(value)) return false;
    if (/\.(?:gif|svg|mp4|m4v|mov|webm|ogv|ogg)(?:[?#].*)?$/i.test(value)) return false;
    if (/^data:/i.test(value)) return /^data:image\//i.test(value);
    return /^(?:https?:|file:)/i.test(value) || /\.(?:png|jpe?g|webp|avif|bmp)(?:[?#].*)?$/i.test(value);
  }

  function thumbnailKey(src, crop = {}) {
    const normalized = normalizeCrop(crop);
    return [
      String(src || "").trim(),
      normalized.x.toFixed(3),
      normalized.y.toFixed(3),
      normalized.zoom.toFixed(3)
    ].join("\u001f");
  }

  function remember(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > MAX_CACHE_ENTRIES) {
      cache.delete(cache.keys().next().value);
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const ImageConstructor = global.Image || (typeof Image === "function" ? Image : null);
      if (!ImageConstructor) {
        reject(new Error("Image is unavailable"));
        return;
      }
      const image = new ImageConstructor();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Avatar image failed to load"));
      image.src = src;
    });
  }

  function rasterize(image, crop) {
    const width = Number(image?.naturalWidth || image?.width) || 0;
    const height = Number(image?.naturalHeight || image?.height) || 0;
    if (!width || !height) return "";
    const canvas = document.createElement("canvas");
    canvas.width = THUMBNAIL_SIZE;
    canvas.height = THUMBNAIL_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return "";
    const source = thumbnailSourceRect(width, height, crop);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.clearRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    context.drawImage(
      image,
      source.x,
      source.y,
      source.width,
      source.height,
      0,
      0,
      THUMBNAIL_SIZE,
      THUMBNAIL_SIZE
    );
    try {
      return canvas.toDataURL("image/png");
    } catch {
      return "";
    }
  }

  function cachedThumbnail(src, crop = {}) {
    if (!supportsThumbnail(src)) return "";
    return cache.get(thumbnailKey(src, crop))?.value || "";
  }

  function renderThumbnail(src, crop = {}) {
    const value = String(src || "").trim();
    if (!supportsThumbnail(value)) return Promise.resolve("");
    const key = thumbnailKey(value, crop);
    const existing = cache.get(key);
    if (existing) {
      remember(key, existing);
      return existing.promise;
    }
    const entry = { value: "", promise: null };
    entry.promise = loadImage(value)
      .then((image) => rasterize(image, crop))
      .catch(() => "")
      .then((thumbnail) => {
        if (thumbnail) entry.value = thumbnail;
        return thumbnail;
      });
    remember(key, entry);
    return entry.promise;
  }

  global.miaAvatarThumbnails = {
    THUMBNAIL_SIZE,
    thumbnailSourceRect,
    supportsThumbnail,
    thumbnailKey,
    cachedThumbnail,
    renderThumbnail
  };
})(typeof window !== "undefined" ? window : globalThis);
