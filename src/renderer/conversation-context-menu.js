// Unified sidebar conversation context menu.
//
// Two openers — `openPrivateConversationMenu` and `openGroupConversationMenu`
// — paint the SAME menu items regardless of whether the conversation lives
// in a local fellow record, a local group store, a cloud DM, or a cloud
// group. UI does not branch on storage backend. The caller injects an
// `actions` object whose method implementations dispatch to the right
// backend (setFellowPinned vs setGroupPinned vs setCloudRoomPinned, etc).
//
// Missing capabilities (e.g., cloud rename has no backend yet) are signaled
// by omitting the corresponding action method — the menu hides that item
// or falls back to a "暂未支持" toast. UI shape stays identical across
// kinds; only available actions vary.

(function (global) {
  "use strict";

  const menuItemHtml = (icon, label, attrs, danger) => {
    const md = global.miaMarkdown;
    if (md && typeof md.menuItemHtml === "function") {
      return md.menuItemHtml({ icon, label, attrs, className: danger ? "danger" : "" });
    }
    return `<button type="button" ${attrs}${danger ? ' class="danger"' : ""}>${label}</button>`;
  };

  function ensureMenuEl() {
    let el = document.getElementById("conversationContextMenu");
    if (!el) {
      el = document.createElement("div");
      el.id = "conversationContextMenu";
      el.className = "skill-context-menu hidden";
      document.body.appendChild(el);
    }
    return el;
  }

  let outsideHandler = null;
  let keyHandler = null;

  function closeMenu() {
    const el = document.getElementById("conversationContextMenu");
    if (el) { el.classList.add("hidden"); el.innerHTML = ""; }
    if (outsideHandler) { document.removeEventListener("click", outsideHandler, true); outsideHandler = null; }
    if (keyHandler) { document.removeEventListener("keydown", keyHandler); keyHandler = null; }
  }

  function position(menu, x, y) {
    const rect = menu.getBoundingClientRect();
    const width = rect.width || 160;
    const height = rect.height || 200;
    menu.style.position = "fixed";
    menu.style.zIndex = "1000";
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  }

  function wireOutsideClose(menu) {
    setTimeout(() => {
      outsideHandler = (event) => { if (!menu.contains(event.target)) closeMenu(); };
      keyHandler = (event) => { if (event.key === "Escape") closeMenu(); };
      document.addEventListener("click", outsideHandler, true);
      document.addEventListener("keydown", keyHandler);
    }, 0);
  }

  // conversation: { id, name, pinned, unread, muted, ... }
  // actions: {
  //   togglePinned?: () => Promise<void>,
  //   rename?: () => void,
  //   toggleRead?: (nextUnreadState: boolean) => void,   // label flips on
  //                                                       conversation.unread
  //   toggleMuted?: (nextMutedState: boolean) => void,
  //   remove?: () => Promise<void>,
  //   notSupported?: { rename?: string, remove?: string }
  // }
  function pushReadItem(items, conversation, actions) {
    if (!actions.toggleRead) return;
    items.push({
      icon: "message",
      label: conversation.unread > 0 ? "标为已读" : "标为未读",
      key: "toggle-read"
    });
  }
  function pushMutedItem(items, conversation, actions) {
    if (!actions.toggleMuted) return;
    items.push({
      icon: "bellOff",
      label: conversation.muted ? "取消免打扰" : "免打扰",
      key: "toggle-muted"
    });
  }

  function openPrivateConversationMenu(conversation, actions, x, y) {
    const menu = ensureMenuEl();
    const items = [];
    if (actions.togglePinned) {
      items.push({ icon: "pin", label: conversation.pinned ? "取消置顶" : "置顶", key: "pin" });
    }
    if (actions.rename || actions.notSupported?.rename) {
      items.push({ icon: "edit", label: "编辑", key: "rename" });
    }
    pushReadItem(items, conversation, actions);
    pushMutedItem(items, conversation, actions);
    if (actions.remove || actions.notSupported?.remove) {
      items.push({ separator: true });
      items.push({ icon: "delete", label: "删除", key: "remove", danger: true });
    }
    render(menu, items, async (key) => {
      closeMenu();
      if (key === "pin") return actions.togglePinned?.();
      if (key === "rename") {
        if (actions.rename) return actions.rename();
        return alert(actions.notSupported?.rename || "暂未支持");
      }
      if (key === "toggle-read") return actions.toggleRead?.(conversation.unread <= 0);
      if (key === "toggle-muted") return actions.toggleMuted?.(!conversation.muted);
      if (key === "remove") {
        if (actions.remove) return actions.remove();
        return alert(actions.notSupported?.remove || "暂未支持");
      }
    });
    position(menu, x, y);
    wireOutsideClose(menu);
  }

  function openGroupConversationMenu(conversation, actions, x, y) {
    const menu = ensureMenuEl();
    const items = [];
    if (actions.togglePinned) {
      items.push({ icon: "pin", label: conversation.pinned ? "取消置顶" : "置顶", key: "pin" });
    }
    if (actions.openInfo) {
      items.push({ icon: "edit", label: "群信息", key: "info" });
    }
    if (actions.rename || actions.notSupported?.rename) {
      items.push({ icon: "edit", label: "重命名", key: "rename" });
    }
    pushReadItem(items, conversation, actions);
    pushMutedItem(items, conversation, actions);
    if (actions.remove || actions.notSupported?.remove) {
      items.push({ separator: true });
      items.push({ icon: "delete", label: "删除群组", key: "remove", danger: true });
    }
    render(menu, items, async (key) => {
      closeMenu();
      if (key === "pin") return actions.togglePinned?.();
      if (key === "info") return actions.openInfo?.();
      if (key === "rename") {
        if (actions.rename) return actions.rename();
        return alert(actions.notSupported?.rename || "暂未支持");
      }
      if (key === "toggle-read") return actions.toggleRead?.(conversation.unread <= 0);
      if (key === "toggle-muted") return actions.toggleMuted?.(!conversation.muted);
      if (key === "remove") {
        if (actions.remove) return actions.remove();
        return alert(actions.notSupported?.remove || "暂未支持");
      }
    });
    position(menu, x, y);
    wireOutsideClose(menu);
  }

  function render(menu, items, dispatch) {
    menu.classList.remove("hidden");
    menu.innerHTML = items.map((it) => {
      if (it.separator) return '<div class="skill-context-menu-separator" role="separator"></div>';
      const attrs = `data-conv-action="${it.key}"${it.disabled ? " disabled" : ""}`;
      return menuItemHtml(it.icon, it.label, attrs, it.danger);
    }).join("");
    menu.querySelectorAll("[data-conv-action]").forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener("click", () => dispatch(btn.dataset.convAction));
    });
  }

  global.miaConversationContextMenu = {
    openPrivateConversationMenu,
    openGroupConversationMenu,
    closeConversationContextMenu: closeMenu
  };
})(typeof window !== "undefined" ? window : globalThis);
