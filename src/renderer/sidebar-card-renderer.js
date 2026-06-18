// Renderer for sidebar conversation cards. ONE shape for 1-on-1 chats
// (bot private or cloud DM) and ONE shape for group chats (local bot
// group or cloud conversation with friends + bots). The caller normalizes its
// row into a spec; the actual avatar / time / pin / unread / context-menu
// behavior is the same regardless of where the conversation lives.
//
// Spec shapes:
//   private: {
//     active, pinned, name, typeLabel, preview, time, unread,
//     avatar: { image, crop, color, text },  // a single member's display
//     onClick(), onContextMenu(x, y),
//     dataAttrs?: { ... }              // optional name → value
//   }
//   group: {
//     active, pinned, name, typeLabel, preview, time, unread,
//     members: [{ image, crop, color, text }, ...],
//     onClick(), onContextMenu(x, y),
//     dataAttrs?: { ... }
//   }
(function (global) {
  "use strict";

  function unreadShared() {
    if (global.miaUnread) return global.miaUnread;
    if (typeof require !== "undefined") return require("../shared/unread");
    throw new Error("miaUnread is not loaded");
  }

  function escapeHtml(value) {
    if (typeof global !== "undefined" && global.miaMarkdown && typeof global.miaMarkdown.escapeHtml === "function") {
      return global.miaMarkdown.escapeHtml(value);
    }
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
  }

  function previewHtml(value, fallback = "") {
    const text = value || fallback;
    const renderer = global.miaMarkdown?.renderPreviewMarkdown;
    if (typeof renderer === "function") {
      try { return renderer(text); } catch { /* fall through */ }
    }
    return escapeHtml(text);
  }

  function tagItems(tags) {
    return Array.isArray(tags)
      ? tags.filter((tag) => String(tag?.name || "").trim()).slice(0, 3)
      : [];
  }

  function tagChipHtml(tag, options = {}) {
    const color = /^#[0-9a-f]{6}$/i.test(String(tag.color || "")) ? tag.color : "#64748b";
    const name = String(tag.name || "").trim();
    const filtered = String(options.filterName || "").trim().toLowerCase() === name.toLowerCase();
    const removing = String(options.removingName || "").trim().toLowerCase() === name.toLowerCase();
    const cls = `persona-tag-chip${filtered ? " filtered" : ""}${removing ? " removing" : ""}`;
    return `
      <button class="${cls}" type="button" data-tag-control data-tag-menu data-tag-name="${escapeHtml(name)}" style="--tag-color:${escapeHtml(color)}" aria-label="标签 ${escapeHtml(name)}">
        <span class="persona-tag-name">${escapeHtml(name)}</span>
      </button>
    `;
  }

  function tagChipsHtml(tags, editor = null) {
    const items = tagItems(tags);
    if (!items.length) return "";
    return `<span class="persona-tags">${items.map((tag) => tagChipHtml(tag, {
      filterName: editor?.filterName,
      removingName: editor?.removingName
    })).join("")}</span>`;
  }

  function hasTagItems(tags) {
    return tagItems(tags).length > 0;
  }

  function tagInputMetaAttrs(editor) {
    const mode = String(editor?.mode || (editor?.adding ? "add" : "") || "").trim();
    const targetName = String(editor?.targetName || "").trim();
    return `data-tag-mode="${escapeHtml(mode)}" data-tag-target-name="${escapeHtml(targetName)}"`;
  }

  function tagSuggestionsHtml(editor, currentTags) {
    const target = String(editor?.targetName || "").trim().toLowerCase();
    const selected = new Set(tagItems(currentTags)
      .map((tag) => String(tag.name || "").trim().toLowerCase())
      .filter((name) => name && name !== target));
    const candidates = (Array.isArray(editor?.allTags) ? editor.allTags : [])
      .filter((tag) => {
        const name = String(tag?.name || "").trim();
        return name && !selected.has(name.toLowerCase());
      })
      .slice(0, 12);
    if (!candidates.length) return "";
    return `<span class="persona-tag-suggestions" data-tag-suggestions>${candidates.map((tag) => {
      const color = /^#[0-9a-f]{6}$/i.test(String(tag.color || "")) ? tag.color : "#64748b";
      const name = String(tag.name || "").trim();
      return `<button class="persona-tag-suggestion" type="button" data-tag-control data-tag-pick data-tag-name="${escapeHtml(name)}" data-tag-search="${escapeHtml(name.toLowerCase())}" ${tagInputMetaAttrs(editor)} style="--tag-color:${escapeHtml(color)}">${escapeHtml(name)}</button>`;
    }).join("")}</span>`;
  }

  function tagInputHtml(editor, placeholder = "标签", color = "") {
    const value = escapeHtml(editor?.draft || "");
    const safeColor = /^#[0-9a-f]{6}$/i.test(String(color || "")) ? color : "#64748b";
    return `
      <span class="persona-tag-input-wrap" data-tag-control style="--tag-color:${escapeHtml(safeColor)}">
        <input class="persona-tag-input" data-tag-control data-tag-input ${tagInputMetaAttrs(editor)} autocomplete="off" placeholder="${escapeHtml(placeholder)}" value="${value}">
      </span>
    `;
  }

  function tagRowHtml(spec) {
    if (spec.searchResult) return "";
    const editor = spec.tagEditor || null;
    const editing = Boolean(editor?.active);
    const tags = tagItems(editing ? (editor.tags || spec.tags) : spec.tags);
    if (!editing) return tagChipsHtml(tags, editor);
    const maxTags = Number(editor.maxTags) || 3;
    const canAdd = tags.length < maxTags;
    const mode = editor.mode || (editor.adding ? "add" : "");
    const target = String(editor.targetName || "").trim().toLowerCase();
    const chips = tags.map((tag) => {
      const name = String(tag.name || "").trim();
      if (mode === "rename" && target && name.toLowerCase() === target) {
        return tagInputHtml(editor, "重命名", tag.color);
      }
      return tagChipHtml(tag, {
        filterName: editor.filterName,
        removingName: editor.removingName
      });
    }).join("");
    return `
      <span class="persona-tags editing" data-tag-control>
        ${chips}
        ${mode === "add" && canAdd ? tagInputHtml(editor) : ""}
      </span>
      ${(mode === "add" && canAdd) || mode === "rename" ? tagSuggestionsHtml(editor, tags) : ""}
    `;
  }

  function previewRowsHtml(spec, fallback = "") {
    const tagsHtml = tagRowHtml(spec);
    if (!tagsHtml) {
      return `
        <span class="persona-preview-row">
          <span class="persona-key">${previewHtml(spec.preview, fallback)}</span>
          ${buildStatusHtml(spec)}
        </span>
      `;
    }
    return `
      <span class="persona-preview-row">
        <span class="persona-key">${previewHtml(spec.preview, fallback)}</span>
        ${buildStatusHtml(spec)}
      </span>
      <span class="persona-tag-row${spec.tagEditor?.active ? " editing" : ""}${spec.tagEditor?.adding ? " adding" : ""}${spec.tagEditor?.mode ? ` mode-${spec.tagEditor.mode}` : ""}">${tagsHtml}</span>
    `;
  }

  function nameWithBadgeRenderer() {
    const renderer = global.miaNameWithBadge;
    if (typeof renderer?.setNameWithBadge === "function") return renderer.setNameWithBadge;
    if (typeof renderer?.renderNameWithBadge === "function") return renderer.renderNameWithBadge;
    return null;
  }

  function attachNameWithBadge(root, spec, fallbackName) {
    const renderName = nameWithBadgeRenderer();
    if (!renderName || (!spec.identity && typeof spec.statusBadge === "undefined")) return;
    const target = root.querySelector?.(".persona-name");
    if (!target) return;
    let nameEl = null;
    try {
      const payload = {
        identity: spec.identity,
        fallbackName,
        statusBadge: spec.statusBadge
      };
      if (renderName === global.miaNameWithBadge?.setNameWithBadge) {
        renderName(target, payload);
        return;
      }
      nameEl = renderName(payload);
    } catch {
      return;
    }
    if (!nameEl) return;
    if (typeof target.replaceChildren === "function") target.replaceChildren(nameEl);
    else {
      target.textContent = "";
      target.appendChild(nameEl);
    }
  }

  function pinSvg() {
    return global.miaIconParkPin || global.ICON_PARK_PIN_SVG || '<svg class="icon-park-pin" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="M10.6963 17.5042C13.3347 14.8657 16.4701 14.9387 19.8781 16.8076L32.62 9.74509L31.8989 4.78683L43.2126 16.1005L38.2656 15.3907L31.1918 28.1214C32.9752 31.7589 33.1337 34.6647 30.4953 37.3032C30.4953 37.3032 26.235 33.0429 22.7171 29.525L6.44305 41.5564L18.4382 25.2461C14.9202 21.7281 10.6963 17.5042 10.6963 17.5042Z"/></svg>';
  }

  function mutedIconHtml(muted) {
    if (!muted || typeof global.miaMarkdown?.iconParkIcon !== "function") return "";
    return global.miaMarkdown.iconParkIcon("bellOff", "persona-muted-icon");
  }

  function applyAvatarStyle(el, image, crop, color, text) {
    global.miaAvatar.paintAvatar(el, { image, crop, color, text });
  }

  function buildStatusHtml({ searchResult, pinned, unread, muted }) {
    if (searchResult) return '<span class="persona-side empty"></span>';
    const badge = unreadShared().unreadBadgeHtml(unread);
    const cls = muted ? "persona-unread muted" : "persona-unread";
    const unreadHtml = badge
      ? badge.replace('class="unread-badge"', `class="${cls}"`)
      : `<span class="${cls} hidden"></span>`;
    const empty = !pinned && !badge;
    return `
      <span class="persona-side${empty ? " empty" : ""}">
        <span class="persona-pin${pinned ? "" : " hidden"}" aria-label="置顶">${pinSvg()}</span>
        ${unreadHtml}
      </span>
    `;
  }

  function attachHandlers(btn, spec) {
    btn.addEventListener("click", (event) => {
      const tagControl = event.target?.closest?.("[data-tag-control]");
      if (tagControl) {
        event.preventDefault();
        event.stopPropagation();
        handleTagControlClick(btn, spec, event);
        return;
      }
      try { spec.onClick?.(); } catch (err) { console.warn("[card] onClick error:", err); }
    });
    btn.addEventListener("input", (event) => {
      if (!event.target?.matches?.("[data-tag-input]")) return;
      try { spec.tagEditor?.onDraft?.(event.target.value || ""); } catch { /* best effort */ }
      filterTagSuggestions(btn, event.target.value);
    });
    btn.addEventListener("focusout", (event) => {
      if (!event.target?.matches?.("[data-tag-input]")) return;
      handleTagInputFocusout(btn, spec);
    });
    btn.addEventListener("keydown", (event) => {
      if (event.target?.matches?.("[data-tag-input]")) {
        handleTagInputKeydown(btn, spec, event);
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      try { spec.onClick?.(); } catch (err) { console.warn("[card] onClick error:", err); }
    });
    btn.addEventListener("contextmenu", (event) => {
      const tagMenu = event.target?.closest?.("[data-tag-menu]");
      if (tagMenu) {
        event.preventDefault();
        event.stopPropagation();
        openTagMenu(spec, tagMenu.dataset.tagName || "", event.clientX, event.clientY);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      try { spec.onContextMenu?.(event.clientX, event.clientY); } catch (err) { console.warn("[card] onContextMenu error:", err); }
    });
    if (spec.dataAttrs && typeof spec.dataAttrs === "object") {
      for (const [k, v] of Object.entries(spec.dataAttrs)) btn.dataset[k] = String(v);
    }
  }

  function commitTagInput(btn, spec, input) {
    const name = String(input?.value || "").trim();
    if (!name) return false;
    const details = tagCommitDetails(input);
    try {
      if (typeof spec.tagEditor?.onCommit === "function") spec.tagEditor.onCommit(name, details);
      else spec.tagEditor?.onAdd?.(name);
    } catch (err) {
      console.warn("[card] tag commit error:", err);
    }
    if (input) input.value = "";
    return true;
  }

  function tagCommitDetails(el) {
    return {
      mode: String(el?.dataset?.tagMode || ""),
      targetName: String(el?.dataset?.tagTargetName || "")
    };
  }

  function handleTagControlClick(btn, spec, event) {
    const pick = event.target?.closest?.("[data-tag-pick]");
    if (pick) {
      try {
        if (typeof spec.tagEditor?.onCommit === "function") spec.tagEditor.onCommit(pick.dataset.tagName || "", tagCommitDetails(pick));
        else spec.tagEditor?.onAdd?.(pick.dataset.tagName || "");
      } catch (err) { console.warn("[card] tag pick error:", err); }
      return;
    }
    const tagMenu = event.target?.closest?.("[data-tag-menu]");
    if (tagMenu) {
      openTagMenu(spec, tagMenu.dataset.tagName || "", event.clientX, event.clientY);
    }
  }

  function openTagMenu(spec, name, x, y) {
    try { spec.tagEditor?.onOpenMenu?.(name, x, y); } catch (err) { console.warn("[card] tag menu error:", err); }
  }

  function handleTagInputKeydown(btn, spec, event) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      commitTagInput(btn, spec, event.target);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (event.target.value) {
        event.target.value = "";
        try { spec.tagEditor?.onDraft?.(""); } catch { /* best effort */ }
        filterTagSuggestions(btn, "");
        return;
      }
      spec.tagEditor?.onCancel?.();
    }
  }

  function handleTagInputFocusout(btn, spec) {
    setTimeout(() => {
      const active = document.activeElement;
      if (active && btn.contains(active) && active.closest?.("[data-tag-control]")) return;
      const input = btn.querySelector("[data-tag-input]");
      if (!input) return;
      if (String(input.value || "").trim()) commitTagInput(btn, spec, input);
    }, 0);
  }

  function filterTagSuggestions(btn, value) {
    const query = String(value || "").trim().toLowerCase();
    const suggestions = btn.querySelector("[data-tag-suggestions]");
    if (!suggestions) return;
    for (const item of suggestions.querySelectorAll("[data-tag-pick]")) {
      const text = String(item.dataset.tagSearch || item.dataset.tagName || "").toLowerCase();
      item.hidden = Boolean(query && !text.includes(query));
    }
  }

  function createPrivateCard(spec) {
    const btn = document.createElement("div");
    const searchResult = Boolean(spec.searchResult);
    const tagged = !searchResult && (hasTagItems(spec.tags) || Boolean(spec.tagEditor?.active));
    btn.setAttribute("role", "button");
    btn.tabIndex = 0;
    btn.className = `persona message-card private-message-card${searchResult ? " search-result" : ""}${tagged ? " has-tags" : ""}${!searchResult && spec.tagEditor?.active ? " tag-editing" : ""}${spec.active ? " active" : ""}${spec.pinned ? " pinned" : ""}`;
    btn.innerHTML = `
      <span class="avatar bot-photo"></span>
      <span class="persona-main">
        <span class="persona-name-row">
          <span class="persona-name">${escapeHtml(spec.name || "")}</span>
          ${mutedIconHtml(spec.muted)}
          <span class="persona-type">${escapeHtml(spec.typeLabel || "私聊")}</span>
          <span class="persona-time">${escapeHtml(spec.time || "")}</span>
        </span>
        ${previewRowsHtml(spec, "暂无对话")}
      </span>
    `;
    const avatarEl = btn.querySelector(".avatar.bot-photo");
    applyAvatarStyle(avatarEl, spec.avatar?.image, spec.avatar?.crop, spec.avatar?.color, spec.avatar?.text);
    attachNameWithBadge(btn, spec, spec.name || "");
    attachHandlers(btn, spec);
    return btn;
  }

  function createGroupCard(spec) {
    const btn = document.createElement("div");
    const searchResult = Boolean(spec.searchResult);
    const tagged = !searchResult && (hasTagItems(spec.tags) || Boolean(spec.tagEditor?.active));
    btn.setAttribute("role", "button");
    btn.tabIndex = 0;
    btn.className = `persona message-card group-persona${searchResult ? " search-result" : ""}${tagged ? " has-tags" : ""}${!searchResult && spec.tagEditor?.active ? " tag-editing" : ""}${spec.active ? " active" : ""}${spec.pinned ? " pinned" : ""}`;
    btn.innerHTML = `
      <span class="avatar group-avatar"></span>
      <span class="persona-main">
        <span class="persona-name-row">
          <span class="persona-name">${escapeHtml(spec.name || "未命名群聊")}</span>
          ${mutedIconHtml(spec.muted)}
          <span class="persona-type group">${escapeHtml(spec.typeLabel || "群聊")}</span>
          <span class="persona-time">${escapeHtml(spec.time || "")}</span>
        </span>
        ${previewRowsHtml(spec)}
      </span>
    `;
    const avatarEl = btn.querySelector(".avatar.group-avatar");
    attachNameWithBadge(btn, spec, spec.name || "未命名群聊");
    // Custom override: user uploaded a single image for this group. Bypass
    // the member mosaic and paint that image directly.
    if (spec.customAvatar && spec.customAvatar.image) {
      avatarEl.classList.remove("group-avatar");
      avatarEl.classList.add("avatar");
      avatarEl.innerHTML = "";
      avatarEl.removeAttribute("data-count");
      applyAvatarStyle(avatarEl, spec.customAvatar.image, spec.customAvatar.crop, "#5e5ce6", spec.customAvatar.text);
    } else {
      const members = Array.isArray(spec.members) ? spec.members : [];
      global.miaGroupAvatar.applyGroupAvatar(avatarEl, members);
      avatarEl.classList.add("group-avatar");
    }
    attachHandlers(btn, spec);
    return btn;
  }

  global.miaSidebarCards = { createPrivateCard, createGroupCard };
})(typeof window !== "undefined" ? window : globalThis);
