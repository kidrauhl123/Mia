(function attachStatusBadgeAssets(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaStatusBadgeAssets = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildStatusBadgeAssets() {
  "use strict";

  const DEFAULT_ASSETS = Object.freeze([
    Object.freeze({
      id: "star",
      kind: "emoji",
      emoji: "⭐",
      label: "星标"
    }),
    Object.freeze({
      id: "fire",
      kind: "emoji",
      emoji: "🔥",
      label: "活跃"
    }),
    Object.freeze({
      id: "rainbow",
      kind: "lottie",
      assetId: "rainbow",
      label: "彩虹动画",
      format: "json",
      relativePath: "assets/lottie/rainbow.json",
      loop: "always",
      bundled: true
    }),
    Object.freeze({
      id: "surprised-cat",
      kind: "lottie",
      assetId: "surprised-cat",
      label: "惊讶猫",
      format: "tgs",
      relativePath: "assets/status-badges/surprised-cat.tgs",
      loop: "always",
      bundled: true
    }),
    Object.freeze({
      id: "squint-bounce",
      kind: "lottie",
      assetId: "squint-bounce",
      label: "眯眼小方块弹跳",
      format: "tgs",
      relativePath: "assets/status-badges/squint-bounce.tgs",
      loop: "always",
      bundled: true
    }),
    Object.freeze({
      id: "blue-fire",
      kind: "lottie",
      assetId: "blue-fire",
      label: "蓝色火焰",
      format: "tgs",
      relativePath: "assets/status-badges/blue-fire.tgs",
      loop: "always",
      bundled: true
    })
  ]);

  function clean(value) {
    return String(value || "").trim();
  }

  function safeStatusBadgeAssetId(value) {
    const text = clean(value);
    return /^[A-Za-z0-9_-]+$/.test(text) ? text : "";
  }

  function cloneAsset(asset) {
    return asset && typeof asset === "object" ? { ...asset } : null;
  }

  function statusBadgeCatalog() {
    return DEFAULT_ASSETS.map(cloneAsset);
  }

  function findStatusBadgeAsset(value) {
    const id = clean(value);
    if (!id) return null;
    return cloneAsset(DEFAULT_ASSETS.find((asset) => asset.id === id || asset.assetId === id) || null);
  }

  function normalizeStatusBadge(input) {
    if (!input || typeof input !== "object") return null;
    const kind = clean(input.kind);
    const label = clean(input.label);
    if (kind === "emoji") {
      const emoji = clean(input.emoji);
      return emoji ? { kind, emoji, ...(label ? { label } : {}) } : null;
    }
    if (kind === "lottie") {
      const assetId = safeStatusBadgeAssetId(input.assetId || input.asset_id);
      const loop = clean(input.loop);
      return assetId ? { kind, assetId, ...(label ? { label } : {}), ...(loop ? { loop } : {}) } : null;
    }
    if (kind === "gift") {
      const assetId = clean(input.assetId || input.asset_id);
      const collectibleId = clean(input.collectibleId || input.collectible_id);
      return assetId ? { kind, assetId, ...(label ? { label } : {}), ...(collectibleId ? { collectibleId } : {}) } : null;
    }
    return null;
  }

  function statusBadgeForValue(value) {
    const asset = findStatusBadgeAsset(value);
    if (!asset) return null;
    if (asset.kind === "emoji") {
      return asset.emoji ? { kind: "emoji", emoji: asset.emoji, label: asset.label || "" } : null;
    }
    if (asset.kind === "lottie") {
      const assetId = safeStatusBadgeAssetId(asset.assetId || asset.id);
      return assetId ? { kind: "lottie", assetId, label: asset.label || "", loop: asset.loop || "always" } : null;
    }
    if (asset.kind === "gift") {
      const assetId = clean(asset.assetId || asset.id);
      return assetId ? { kind: "gift", assetId, collectibleId: clean(asset.collectibleId), label: asset.label || "" } : null;
    }
    return null;
  }

  function statusBadgeValue(badge) {
    const normalized = normalizeStatusBadge(badge);
    if (!normalized) return "";
    if (normalized.kind === "emoji") {
      const asset = DEFAULT_ASSETS.find((item) => item.kind === "emoji" && item.emoji === normalized.emoji);
      return asset?.id || "";
    }
    if (normalized.kind === "lottie" || normalized.kind === "gift") {
      const assetId = clean(normalized.assetId);
      const asset = DEFAULT_ASSETS.find((item) => item.id === assetId || item.assetId === assetId);
      return asset?.id || "";
    }
    return "";
  }

  function statusBadgeChoices({ includeEmpty = false } = {}) {
    const choices = DEFAULT_ASSETS.map((asset) => ({
      id: asset.id,
      value: asset.id,
      label: asset.label || asset.id,
      kind: asset.kind,
      emoji: asset.emoji || "",
      assetId: asset.assetId || asset.id,
      badge: statusBadgeForValue(asset.id)
    }));
    return includeEmpty
      ? [{ id: "", value: "", label: "无", kind: "none", badge: null }, ...choices]
      : choices;
  }

  function statusBadgeAssetDefinitions() {
    return DEFAULT_ASSETS
      .filter((asset) => asset.kind === "lottie" && safeStatusBadgeAssetId(asset.assetId || asset.id) && asset.relativePath)
      .map((asset) => ({
        id: asset.assetId || asset.id,
        assetId: asset.assetId || asset.id,
        label: asset.label || asset.id,
        kind: asset.kind,
        format: asset.format || "json",
        relativePath: asset.relativePath
      }));
  }

  function statusBadgeAssetUrl(assetId, options = {}) {
    const id = safeStatusBadgeAssetId(assetId);
    if (!id) return "";
    const asset = findStatusBadgeAsset(id);
    const preferLocal = Boolean(options.preferLocal);
    const localPrefix = clean(options.localPrefix) || "./";
    if (preferLocal && asset?.bundled !== false && asset?.relativePath) {
      return `${localPrefix}${String(asset.relativePath).replace(/^\/+/, "")}`;
    }
    const baseUrl = clean(options.baseUrl).replace(/\/+$/, "");
    const apiPath = clean(options.apiPath) || "/api/status-badge-assets";
    const path = `${apiPath.replace(/\/+$/, "")}/${encodeURIComponent(id)}.json`;
    return baseUrl ? `${baseUrl}${path}` : path;
  }

  function statusBadgeAssetFormat(assetId, options = {}) {
    const id = safeStatusBadgeAssetId(assetId);
    if (!id) return "";
    const asset = findStatusBadgeAsset(id);
    if (options.preferLocal && asset?.format) return asset.format;
    return "json";
  }

  return {
    safeStatusBadgeAssetId,
    normalizeStatusBadge,
    statusBadgeCatalog,
    statusBadgeChoices,
    statusBadgeForValue,
    statusBadgeValue,
    findStatusBadgeAsset,
    statusBadgeAssetDefinitions,
    statusBadgeAssetUrl,
    statusBadgeAssetFormat
  };
});
