// Shared group-avatar mosaic renderer. ONE source of truth for every place
// in the renderer that paints a group's stacked-tile avatar (sidebar cards,
// active-chat header, anywhere else a group is shown).
//
// Inputs are pre-resolved tile descriptors `{image, crop, color}` — this
// helper does not know about conversations, members, fellows, friends. The caller
// decides member order (convention: boss first).
//
// CSS in src/renderer/styles/groups.css drives the 1-/2-/3-/4-/5-/6-tile
// layouts; this helper only sets data-count and the per-tile background.
(function (global) {
  "use strict";

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
      global.miaAvatar.paintAvatar(span, tile);
      el.appendChild(span);
    }
  }

  global.miaGroupAvatar = { applyGroupAvatar };
})(typeof window !== "undefined" ? window : globalThis);
