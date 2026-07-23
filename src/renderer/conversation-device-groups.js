// Device sections inside the desktop "其他设备" conversation folder.
// The folder chooses the scope; this module adds the same runtime-device
// hierarchy used by Mia Web without taking ownership of conversation cards.
(function (global) {
  "use strict";

  const COLLAPSED_GROUPS_KEY = "mia.conversationDeviceGroupsCollapsed.v1";

  function readCollapsedGroups() {
    try {
      const raw = global.localStorage?.getItem(COLLAPSED_GROUPS_KEY) || "";
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      return new Set();
    }
  }

  function writeCollapsedGroups(groups) {
    try {
      global.localStorage?.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...groups]));
    } catch {
      // Device-group collapse is a best-effort local preference.
    }
  }

  function isOtherDeviceFilter(activeFilter, otherDeviceFilter) {
    const active = String(activeFilter || "").trim().toLowerCase();
    const expected = String(otherDeviceFilter || "").trim().toLowerCase();
    return Boolean(active && expected && active === expected);
  }

  function fallbackDescriptor() {
    return {
      key: "device:unassigned",
      label: "未分配设备",
      meta: "未配置",
      status: "unassigned",
      order: 800
    };
  }

  function deviceStatusPriority(status = "") {
    return { online: 3, offline: 2, unassigned: 1 }[String(status)] || 0;
  }

  function groupConversationSpecs(specs = []) {
    const groups = new Map();
    for (const spec of Array.isArray(specs) ? specs : []) {
      const descriptor = spec?.deviceGroup || fallbackDescriptor();
      const key = String(descriptor.key || "device:unassigned");
      if (!groups.has(key)) {
        groups.set(key, {
          ...fallbackDescriptor(),
          ...descriptor,
          key,
          specs: []
        });
      } else {
        const group = groups.get(key);
        const currentOrder = Number(group.order) || 0;
        const nextOrder = Number(descriptor.order) || 0;
        if (nextOrder && (!currentOrder || nextOrder < currentOrder)) {
          group.order = nextOrder;
          if (descriptor.label) group.label = descriptor.label;
        }
        if (!group.platform && descriptor.platform) group.platform = descriptor.platform;
        if (deviceStatusPriority(descriptor.status) > deviceStatusPriority(group.status)) {
          group.status = descriptor.status;
          group.meta = descriptor.meta;
        }
      }
      groups.get(key).specs.push(spec);
    }
    return [...groups.values()].sort((a, b) => (
      (Number(a.order) || 0) - (Number(b.order) || 0)
        || String(a.label || "").localeCompare(String(b.label || ""), "zh-Hans-CN")
    ));
  }

  function orderedConversationSpecs(specs = []) {
    return groupConversationSpecs(specs).flatMap((group) => group.specs);
  }

  function devicePlatformIcon(platform = "") {
    const normalized = String(platform || "").trim().toLowerCase();
    if (normalized !== "macos" && normalized !== "windows") return "";
    return `<span class="conversation-device-platform-icon platform-${normalized}" aria-hidden="true"></span>`;
  }

  function createGroupHeader(group, collapsed, onToggle) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-device-group-header";
    button.dataset.conversationDeviceGroupToggle = group.key;
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    button.innerHTML = `
      <span class="conversation-device-group-heading">
        <span class="conversation-device-group-dot" aria-hidden="true"></span>
        ${devicePlatformIcon(group.platform)}
        <strong></strong>
        <small></small>
      </span>
      <span class="conversation-device-group-count"></span>
      <span class="conversation-device-group-chevron" aria-hidden="true">
        <svg viewBox="0 0 16 16"><path d="m5.5 3.5 4.5 4.5-4.5 4.5"/></svg>
      </span>
    `;
    button.querySelector("strong").textContent = group.label || "设备";
    button.querySelector("small").textContent = group.meta || "";
    button.querySelector(".conversation-device-group-count").textContent = String(group.specs.length);
    button.addEventListener("click", onToggle);
    return button;
  }

  function appendGroupedConversationCards({ root, specs, createCard }) {
    if (!root || typeof createCard !== "function") return;
    const collapsedGroups = readCollapsedGroups();
    for (const group of groupConversationSpecs(specs)) {
      const section = document.createElement("section");
      const collapsed = collapsedGroups.has(group.key);
      section.className = `conversation-device-group${collapsed ? " collapsed" : ""}`;
      section.dataset.conversationDeviceGroup = group.key;
      section.dataset.deviceStatus = group.status || "unassigned";

      const items = document.createElement("div");
      items.className = "conversation-device-group-items";
      items.inert = collapsed;
      items.setAttribute("aria-hidden", collapsed ? "true" : "false");
      const itemsClip = document.createElement("div");
      itemsClip.className = "conversation-device-group-items-clip";
      for (const spec of group.specs) itemsClip.appendChild(createCard(spec));
      items.appendChild(itemsClip);

      const header = createGroupHeader(group, collapsed, () => {
        const nextCollapsed = !section.classList.contains("collapsed");
        section.classList.toggle("collapsed", nextCollapsed);
        header.setAttribute("aria-expanded", nextCollapsed ? "false" : "true");
        items.inert = nextCollapsed;
        items.setAttribute("aria-hidden", nextCollapsed ? "true" : "false");
        if (nextCollapsed) collapsedGroups.add(group.key);
        else collapsedGroups.delete(group.key);
        writeCollapsedGroups(collapsedGroups);
      });

      section.append(header, items);
      root.appendChild(section);
    }
  }

  const api = {
    COLLAPSED_GROUPS_KEY,
    isOtherDeviceFilter,
    groupConversationSpecs,
    orderedConversationSpecs,
    devicePlatformIcon,
    appendGroupedConversationCards
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  global.miaConversationDeviceGroups = api;
})(typeof window !== "undefined" ? window : globalThis);
