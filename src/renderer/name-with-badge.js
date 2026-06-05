(function (global) {
  "use strict";

  function clean(value) {
    return String(value || "").trim();
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const text = clean(value);
      if (text) return text;
    }
    return "";
  }

  function firstSafeDisplayName(...values) {
    for (const value of values) {
      const text = clean(value);
      if (!text) continue;
      if (/^(user|bot):/i.test(text)) continue;
      return text;
    }
    return "";
  }

  function displayNameFor(identity, fallbackName) {
    const source = identity && typeof identity === "object" ? identity : {};
    return firstSafeDisplayName(source.displayName, source.display_name, fallbackName) || "未知";
  }

  function normalizeBadge(input) {
    if (!input || typeof input !== "object") return null;
    const kind = clean(input.kind);
    const label = clean(input.label);
    if (kind === "emoji") {
      const emoji = clean(input.emoji);
      return emoji ? { kind, emoji, label } : null;
    }
    if (kind === "lottie" || kind === "gift") {
      const assetId = firstNonEmpty(input.assetId, input.asset_id);
      if (!assetId) return null;
      const collectibleId = kind === "gift" ? firstNonEmpty(input.collectibleId, input.collectible_id) : "";
      return { kind, assetId, collectibleId, label };
    }
    return null;
  }

  function badgeFor(identity, statusBadge) {
    if (typeof statusBadge !== "undefined") return normalizeBadge(statusBadge);
    const source = identity && typeof identity === "object" ? identity : {};
    return normalizeBadge(source.statusBadge || source.status_badge);
  }

  function renderBadge(badge) {
    const el = document.createElement("span");
    el.className = `name-with-badge-badge name-with-badge-badge-${badge.kind}`;
    if (badge.label) el.setAttribute("title", badge.label);
    if (badge.kind === "emoji") {
      el.textContent = badge.emoji;
      return el;
    }
    el.setAttribute("data-asset-id", badge.assetId);
    if (badge.kind === "gift" && badge.collectibleId) {
      el.setAttribute("data-collectible-id", badge.collectibleId);
    }
    return el;
  }

  function renderNameWithBadge({ identity, fallbackName, statusBadge } = {}) {
    const wrapper = document.createElement("span");
    wrapper.className = "name-with-badge";

    const text = document.createElement("span");
    text.className = "name-with-badge-text";
    text.textContent = displayNameFor(identity, fallbackName);
    wrapper.appendChild(text);

    const badge = badgeFor(identity, statusBadge);
    if (badge) wrapper.appendChild(renderBadge(badge));
    return wrapper;
  }

  global.miaNameWithBadge = { renderNameWithBadge };
})(typeof window !== "undefined" ? window : globalThis);
