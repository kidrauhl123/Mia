// Renderer for sidebar conversation cards. ONE shape for 1-on-1 chats
// (fellow private or cloud DM) and ONE shape for group chats (local fellow
// group or cloud room with friends + fellows). The caller normalizes its
// row into a spec; the actual avatar / time / pin / unread / context-menu
// behavior is the same regardless of where the conversation lives.
//
// Spec shapes:
//   private: {
//     active, pinned, name, typeLabel, preview, time, unread,
//     avatar: { image, crop, color },  // a single member's display
//     onClick(), onContextMenu(x, y),
//     dataAttrs?: { ... }              // optional name → value
//   }
//   group: {
//     active, pinned, name, typeLabel, preview, time, unread,
//     members: [{ image, crop, color }, ...],
//     onClick(), onContextMenu(x, y),
//     dataAttrs?: { ... }
//   }
(function (global) {
  "use strict";

  function unreadShared() {
    if (global.aimashiUnread) return global.aimashiUnread;
    if (typeof require !== "undefined") return require("../shared/unread");
    throw new Error("aimashiUnread is not loaded");
  }

  function escapeHtml(value) {
    if (typeof global !== "undefined" && global.aimashiMarkdown && typeof global.aimashiMarkdown.escapeHtml === "function") {
      return global.aimashiMarkdown.escapeHtml(value);
    }
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
  }

  function pinSvg() {
    return global.aimashiIconParkPin || global.ICON_PARK_PIN_SVG || "";
  }

  function applyAvatarStyle(el, image, crop, color) {
    const helper = global.aimashiAvatar?.avatarThumbBackgroundStyle;
    let style = "";
    if (typeof helper === "function" && image) {
      style = helper(image, crop, color || "#5e5ce6");
    }
    if (!style || !style.trim()) style = `background-color:${color || "#5e5ce6"};`;
    el.style.cssText = style;
  }

  function buildSideHtml({ time, pinned, unread }) {
    const badge = unreadShared().unreadBadgeHtml(unread);
    const unreadHtml = badge
      ? badge.replace('class="unread-badge"', 'class="persona-unread"')
      : `<span class="persona-unread hidden"></span>`;
    return `
      <span class="persona-side">
        <span class="persona-time">${escapeHtml(time || "")}</span>
        <span class="persona-pin${pinned ? "" : " hidden"}" aria-label="置顶">${pinSvg()}</span>
        ${unreadHtml}
      </span>
    `;
  }

  function attachHandlers(btn, spec) {
    btn.addEventListener("click", () => { try { spec.onClick?.(); } catch (err) { console.warn("[card] onClick error:", err); } });
    btn.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      try { spec.onContextMenu?.(event.clientX, event.clientY); } catch (err) { console.warn("[card] onContextMenu error:", err); }
    });
    if (spec.dataAttrs && typeof spec.dataAttrs === "object") {
      for (const [k, v] of Object.entries(spec.dataAttrs)) btn.dataset[k] = String(v);
    }
  }

  function createPrivateCard(spec) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `persona message-card private-message-card${spec.active ? " active" : ""}${spec.pinned ? " pinned" : ""}`;
    btn.innerHTML = `
      <span class="avatar fellow-photo"></span>
      <span class="persona-main">
        <span class="persona-name-row">
          <span class="persona-name">${escapeHtml(spec.name || "")}</span>
          <span class="persona-type">${escapeHtml(spec.typeLabel || "私聊")}</span>
        </span>
        <span class="persona-key">${escapeHtml(spec.preview || "暂无对话")}</span>
      </span>
      ${buildSideHtml(spec)}
    `;
    const avatarEl = btn.querySelector(".avatar.fellow-photo");
    applyAvatarStyle(avatarEl, spec.avatar?.image, spec.avatar?.crop, spec.avatar?.color);
    attachHandlers(btn, spec);
    return btn;
  }

  function createGroupCard(spec) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `persona message-card group-persona${spec.active ? " active" : ""}${spec.pinned ? " pinned" : ""}`;
    btn.innerHTML = `
      <span class="avatar group-avatar"></span>
      <span class="persona-main">
        <span class="persona-name-row">
          <span class="persona-name">${escapeHtml(spec.name || "未命名群聊")}</span>
          <span class="persona-type group">${escapeHtml(spec.typeLabel || "群聊")}</span>
        </span>
        <span class="persona-key">${escapeHtml(spec.preview || "")}</span>
      </span>
      ${buildSideHtml(spec)}
    `;
    const avatarEl = btn.querySelector(".avatar.group-avatar");
    const members = Array.isArray(spec.members) ? spec.members : [];
    for (const member of members) {
      const tile = document.createElement("span");
      tile.className = "group-avatar-tile";
      applyAvatarStyle(tile, member.image, member.crop, member.color);
      avatarEl.appendChild(tile);
    }
    avatarEl.setAttribute("data-count", String(members.length));
    attachHandlers(btn, spec);
    return btn;
  }

  global.aimashiSidebarCards = { createPrivateCard, createGroupCard };
})(typeof window !== "undefined" ? window : globalThis);
