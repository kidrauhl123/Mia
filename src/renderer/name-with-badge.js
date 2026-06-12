(function (global) {
  "use strict";

  function clean(value) {
    return String(value || "").trim();
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[ch]));
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

  function safeLottieAssetId(value) {
    const text = clean(value);
    const shared = global.miaStatusBadgeAssets;
    if (shared?.safeStatusBadgeAssetId) return shared.safeStatusBadgeAssetId(text);
    return /^[A-Za-z0-9_-]+$/.test(text) ? text : "";
  }

  let statusBadgeAssetBaseUrl = "";

  function setStatusBadgeAssetBaseUrl(value) {
    statusBadgeAssetBaseUrl = String(value || "").trim().replace(/\/+$/, "");
  }

  function isDesktopRenderer() {
    return Boolean(global.mia || global.location?.protocol === "file:");
  }

  function shouldUseLocalAsset(lottieName) {
    return Boolean(isDesktopRenderer() && global.miaStatusBadgeAssets?.findStatusBadgeAsset?.(lottieName)?.relativePath);
  }

  function statusBadgeAssetUrl(assetId) {
    const lottieName = safeLottieAssetId(assetId);
    if (!lottieName) return "";
    const shared = global.miaStatusBadgeAssets;
    if (shared?.statusBadgeAssetUrl) {
      return shared.statusBadgeAssetUrl(lottieName, {
        baseUrl: statusBadgeAssetBaseUrl,
        preferLocal: !statusBadgeAssetBaseUrl || shouldUseLocalAsset(lottieName),
        localPrefix: "./"
      });
    }
    if (!statusBadgeAssetBaseUrl) return `/api/status-badge-assets/${encodeURIComponent(lottieName)}.json`;
    return `${statusBadgeAssetBaseUrl}/api/status-badge-assets/${encodeURIComponent(lottieName)}.json`;
  }

  function statusBadgeAssetFormat(assetId) {
    const lottieName = safeLottieAssetId(assetId);
    if (!lottieName) return "";
    const shared = global.miaStatusBadgeAssets;
    if (shared?.statusBadgeAssetFormat) {
      return shared.statusBadgeAssetFormat(lottieName, {
        preferLocal: !statusBadgeAssetBaseUrl || shouldUseLocalAsset(lottieName)
      });
    }
    return "json";
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
      if (kind === "lottie" && !safeLottieAssetId(assetId)) return null;
      const collectibleId = kind === "gift" ? firstNonEmpty(input.collectibleId, input.collectible_id) : "";
      const loop = kind === "lottie" ? firstNonEmpty(input.loop) : "";
      return { kind, assetId, collectibleId, label, loop };
    }
    return null;
  }

  function badgeFor(identity, statusBadge) {
    if (typeof statusBadge !== "undefined") return normalizeBadge(statusBadge);
    const source = identity && typeof identity === "object" ? identity : {};
    if (Object.prototype.hasOwnProperty.call(source, "statusBadge")) return normalizeBadge(source.statusBadge);
    if (Object.prototype.hasOwnProperty.call(source, "status_badge")) return normalizeBadge(source.status_badge);
    return null;
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
    el.setAttribute("aria-hidden", "true");
    if (badge.kind === "lottie") {
      const lottieName = safeLottieAssetId(badge.assetId);
      if (lottieName) {
        el.setAttribute("data-lottie", lottieName);
        el.setAttribute("data-lottie-trigger", "loop");
        const format = statusBadgeAssetFormat(lottieName);
        if (format === "tgs") {
          el.setAttribute("data-lottie-format", "tgs");
          el.setAttribute("data-lottie-local", "status-badge");
        }
        const remotePath = statusBadgeAssetUrl(lottieName);
        if (remotePath) el.setAttribute("data-lottie-path", remotePath);
      }
    }
    if (badge.kind === "gift" && badge.collectibleId) {
      el.setAttribute("data-collectible-id", badge.collectibleId);
    }
    return el;
  }

  function badgeRenderKey(badge) {
    if (!badge) return "";
    if (badge.kind === "emoji") return ["emoji", badge.emoji || "", badge.label || ""].join("\u001f");
    if (badge.kind === "gift") return ["gift", badge.assetId || "", badge.collectibleId || "", badge.label || ""].join("\u001f");
    if (badge.kind === "lottie") {
      const assetId = safeLottieAssetId(badge.assetId);
      return [
        "lottie",
        assetId,
        badge.label || "",
        statusBadgeAssetFormat(assetId),
        statusBadgeAssetUrl(assetId)
      ].join("\u001f");
    }
    return "";
  }

  function renderKeyFor({ identity, fallbackName, statusBadge } = {}) {
    const name = displayNameFor(identity, fallbackName);
    const badge = badgeFor(identity, statusBadge);
    return [name, badgeRenderKey(badge)].join("\u001e");
  }

  function initLottieBadges(root) {
    const init = global.miaLottieIcons && global.miaLottieIcons.init;
    if (!root || typeof init !== "function") return;
    const run = () => {
      if (root.isConnected === false) return;
      try { init(root); } catch { /* optional badge animation must not break names */ }
    };
    if (root.isConnected === false) {
      const defer = typeof global.requestAnimationFrame === "function"
        ? global.requestAnimationFrame
        : global.setTimeout;
      if (typeof defer === "function") defer(run, 0);
      return;
    }
    run();
  }

  function renderNameWithBadge({ identity, fallbackName, statusBadge } = {}) {
    const key = renderKeyFor({ identity, fallbackName, statusBadge });
    const wrapper = document.createElement("span");
    wrapper.className = "name-with-badge";
    wrapper.setAttribute("data-name-with-badge-key", key);

    const text = document.createElement("span");
    text.className = "name-with-badge-text";
    text.textContent = displayNameFor(identity, fallbackName);
    wrapper.appendChild(text);

    const badge = badgeFor(identity, statusBadge);
    if (badge) {
      wrapper.appendChild(renderBadge(badge));
      if (badge.kind === "lottie") initLottieBadges(wrapper);
    }
    return wrapper;
  }

  function setNameWithBadge(target, { identity, fallbackName, statusBadge } = {}) {
    if (!target) return null;
    const key = renderKeyFor({ identity, fallbackName, statusBadge });
    const currentKey = target.dataset?.nameWithBadgeKey || target.getAttribute?.("data-name-with-badge-key") || "";
    const existing = target.firstElementChild || target.children?.[0] || null;
    if (currentKey === key && existing?.className === "name-with-badge") {
      initLottieBadges(target);
      return existing;
    }
    const node = renderNameWithBadge({ identity, fallbackName, statusBadge });
    if (typeof target.replaceChildren === "function") {
      target.replaceChildren(node);
    } else {
      target.textContent = "";
      target.appendChild(node);
    }
    if (target.dataset) target.dataset.nameWithBadgeKey = key;
    else target.setAttribute?.("data-name-with-badge-key", key);
    return node;
  }

  function renderBadgeHtml(badge) {
    const titleAttr = badge.label ? ` title="${escapeHtml(badge.label)}"` : "";
    const className = `name-with-badge-badge name-with-badge-badge-${badge.kind}`;
    if (badge.kind === "emoji") {
      return `<span class="${className}"${titleAttr}>${escapeHtml(badge.emoji)}</span>`;
    }
    const assetAttr = ` data-asset-id="${escapeHtml(badge.assetId)}"`;
    const lottieName = badge.kind === "lottie" ? safeLottieAssetId(badge.assetId) : "";
    const lottiePath = lottieName ? statusBadgeAssetUrl(lottieName) : "";
    const lottieFormat = lottieName ? statusBadgeAssetFormat(lottieName) : "";
    const lottieAttr = lottieName
      ? ` data-lottie="${escapeHtml(lottieName)}" data-lottie-trigger="loop"${lottieFormat === "tgs" ? " data-lottie-format=\"tgs\" data-lottie-local=\"status-badge\"" : ""}${lottiePath ? ` data-lottie-path="${escapeHtml(lottiePath)}"` : ""} aria-hidden="true"`
      : " aria-hidden=\"true\"";
    const collectibleAttr = badge.kind === "gift" && badge.collectibleId
      ? ` data-collectible-id="${escapeHtml(badge.collectibleId)}"`
      : "";
    return `<span class="${className}"${titleAttr}${assetAttr}${lottieAttr}${collectibleAttr}></span>`;
  }

  function renderNameWithBadgeHtml({ identity, fallbackName, statusBadge } = {}) {
    const text = `<span class="name-with-badge-text">${escapeHtml(displayNameFor(identity, fallbackName))}</span>`;
    const badge = badgeFor(identity, statusBadge);
    return `<span class="name-with-badge">${text}${badge ? renderBadgeHtml(badge) : ""}</span>`;
  }

  global.miaNameWithBadge = {
    renderNameWithBadge,
    renderNameWithBadgeHtml,
    setNameWithBadge,
    initLottieBadges,
    setStatusBadgeAssetBaseUrl,
    statusBadgeAssetUrl,
    statusBadgeAssetFormat
  };
})(typeof window !== "undefined" ? window : globalThis);
