// Shared group-avatar mosaic renderer. ONE source of truth for every place
// in the renderer that paints a group's stacked-tile avatar (sidebar cards,
// active-chat header, anywhere else a group is shown).
//
// Inputs are pre-resolved tile descriptors `{image, crop, color}` — this
// helper does not know about rooms, members, fellows, friends. The caller
// decides member order (convention: boss first).
//
// CSS in src/renderer/styles/groups.css drives the 1-/2-/3-/4-/5-/6-tile
// layouts; this helper only sets data-count and the per-tile background.
(function (global) {
  "use strict";

  function tileStyle(image, crop, color) {
    const helper = global.aimashiAvatar?.avatarThumbBackgroundStyle;
    const fallback = `background-color:${color || "#5e5ce6"};`;
    if (typeof helper !== "function" || !image) return fallback;
    const style = helper(image, crop, color || "#5e5ce6");
    return style && style.trim() ? style : fallback;
  }

  function applyGroupAvatar(el, tiles) {
    if (!el) return;
    el.textContent = "";
    el.innerHTML = "";
    el.removeAttribute("style");
    const list = Array.isArray(tiles) ? tiles.filter(Boolean) : [];
    el.setAttribute("data-count", String(list.length));
    for (const tile of list) {
      const span = document.createElement("span");
      span.className = "group-avatar-tile";
      span.style.cssText = tileStyle(tile.image, tile.crop, tile.color);
      el.appendChild(span);
    }
  }

  global.aimashiGroupAvatar = { applyGroupAvatar, tileStyle };
})(typeof window !== "undefined" ? window : globalThis);
