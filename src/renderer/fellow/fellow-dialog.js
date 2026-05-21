// Fellow / profile / avatar-crop dialog module
// Extracted from app.js. Contains all the modal-dialog logic for editing a
// Fellow (name + persona + engine + avatar) and for editing the current
// user's profile (display name + avatar), plus the shared avatar crop editor
// and the avatar preset picker tabs (human / pet).
//
// Defensive `if (!state || !els)` guards on every entry.
(function () {
  "use strict";

  let state, els;
  let renderView, render;

  function initFellowDialog(deps) {
    state = deps.state;
    els = deps.els;
    renderView = deps.renderView;
    render = deps.render;
  }

  function setFellowAvatarDraft(image, crop = null) {
    if (!state) return;
    const src = window.aimashiAvatar.canonicalAvatarSrc(image);
    state.fellowAvatarDraft = {
      image: src,
      crop: window.aimashiAvatar.normalizeCrop(crop || window.aimashiAvatar.avatarDefaultCropForSrc(src))
    };
    if (els.fellowAvatar) els.fellowAvatar.value = state.fellowAvatarDraft.image;
    renderFellowAvatarDraft();
  }

  function setProfileAvatarDraft(image, crop = null) {
    if (!state) return;
    const src = window.aimashiAvatar.canonicalAvatarSrc(image);
    state.profileAvatarDraft = {
      image: src,
      crop: window.aimashiAvatar.normalizeCrop(crop || window.aimashiAvatar.avatarDefaultCropForSrc(src))
    };
    if (els.profileAvatarImage) els.profileAvatarImage.value = state.profileAvatarDraft.image;
    renderProfileAvatarDraft();
  }

  function renderProfileAvatarDraft() {
    if (!state || !els || !els.profileAvatarPreview) return;
    const draft = state.profileAvatarDraft;
    const user = state.runtime?.user || {};
    const crop = window.aimashiAvatar.normalizeCrop(draft.crop);
    els.profileAvatarPreview.setAttribute("style", window.aimashiAvatar.avatarBackgroundStyle(draft.image, crop, user.avatarColor || "#111827"));
    els.profileAvatarPreview.title = draft.image ? "点击调整头像裁剪" : "选择头像";
    els.profileAvatarPreview.setAttribute("role", "button");
    els.profileAvatarPreview.setAttribute("tabindex", "0");
    els.profileAvatarPreview.setAttribute("aria-label", "调整头像裁剪");
    renderProfileAvatarDefaults();
  }

  function openProfileDialog() {
    if (!state || !els) return;
    const user = state.runtime?.user || { displayName: "Boss", avatarImage: "", avatarCrop: window.aimashiAvatar.DEFAULT_AVATAR_CROP };
    state.profileDialogOpen = true;
    state.profileAvatarPresetGroup = window.aimashiAvatar.avatarPresetGroupForSrc(user.avatarImage || "") || "human";
    if (els.profileDisplayName) els.profileDisplayName.value = user.displayName || "Boss";
    setProfileAvatarDraft(user.avatarImage || "", user.avatarCrop);
    renderView();
    setTimeout(() => els.profileDisplayName?.focus(), 0);
  }

  function closeProfileDialog() {
    if (!state) return;
    state.profileDialogOpen = false;
    renderView();
  }

  function renderFellowAvatarDefaults() {
    if (!state || !els || !els.fellowAvatarDefaults) return;
    const activeGroup = window.aimashiAvatar.avatarPresetGroups[state.fellowAvatarPresetGroup]
      ? state.fellowAvatarPresetGroup
      : "human";
    state.fellowAvatarPresetGroup = activeGroup;
    if (els.fellowAvatarDefaultTabs) {
      els.fellowAvatarDefaultTabs.innerHTML = window.aimashiAvatar.avatarPresetGroupTabs.map((group) => `
        <button type="button" class="${activeGroup === group.key ? "active" : ""}" data-avatar-group="${window.aimashiMarkdown.escapeHtml(group.key)}" role="tab" aria-selected="${activeGroup === group.key ? "true" : "false"}">${window.aimashiMarkdown.escapeHtml(group.label)}</button>
      `).join("");
      els.fellowAvatarDefaultTabs.querySelectorAll("[data-avatar-group]").forEach((button) => {
        button.addEventListener("click", () => {
          const group = button.dataset.avatarGroup || "human";
          if (!window.aimashiAvatar.avatarPresetGroups[group] || state.fellowAvatarPresetGroup === group) return;
          state.fellowAvatarPresetGroup = group;
          renderFellowAvatarDefaults();
        });
      });
    }
    const selected = state.fellowAvatarDraft.image;
    const presets = window.aimashiAvatar.avatarPresetGroups[activeGroup] || window.aimashiAvatar.avatarPresetGroups.human;
    els.fellowAvatarDefaults.innerHTML = presets.map((preset) => `
      <button type="button" class="avatar-default${selected === preset.src ? " active" : ""}" data-avatar="${window.aimashiMarkdown.escapeHtml(preset.src)}" data-avatar-name="${window.aimashiMarkdown.escapeHtml(preset.name)}" title="${window.aimashiMarkdown.escapeHtml(preset.name)}" aria-label="${window.aimashiMarkdown.escapeHtml(preset.name)}" style="${window.aimashiAvatar.avatarThumbBackgroundStyle(preset.src, window.aimashiAvatar.avatarDefaultCropForSrc(preset.src), "#eef0ff")}"></button>
    `).join("");
    els.fellowAvatarDefaults.querySelectorAll("[data-avatar]").forEach((button) => {
      button.addEventListener("click", () => {
        setFellowAvatarDraft(button.dataset.avatar, window.aimashiAvatar.avatarDefaultCropForSrc(button.dataset.avatar));
        if (els.fellowName) els.fellowName.value = button.dataset.avatarName || window.aimashiAvatar.avatarPresetBySrc(button.dataset.avatar)?.name || "";
      });
    });
  }

  function renderProfileAvatarDefaults() {
    if (!state || !els || !els.profileAvatarDefaults) return;
    const activeGroup = window.aimashiAvatar.avatarPresetGroups[state.profileAvatarPresetGroup]
      ? state.profileAvatarPresetGroup
      : "human";
    state.profileAvatarPresetGroup = activeGroup;
    if (els.profileAvatarDefaultTabs) {
      els.profileAvatarDefaultTabs.innerHTML = window.aimashiAvatar.avatarPresetGroupTabs.map((group) => `
        <button type="button" class="${activeGroup === group.key ? "active" : ""}" data-avatar-group="${window.aimashiMarkdown.escapeHtml(group.key)}" role="tab" aria-selected="${activeGroup === group.key ? "true" : "false"}">${window.aimashiMarkdown.escapeHtml(group.label)}</button>
      `).join("");
      els.profileAvatarDefaultTabs.querySelectorAll("[data-avatar-group]").forEach((button) => {
        button.addEventListener("click", () => {
          const group = button.dataset.avatarGroup || "human";
          if (!window.aimashiAvatar.avatarPresetGroups[group] || state.profileAvatarPresetGroup === group) return;
          state.profileAvatarPresetGroup = group;
          renderProfileAvatarDefaults();
        });
      });
    }
    const selected = state.profileAvatarDraft.image;
    const presets = window.aimashiAvatar.avatarPresetGroups[activeGroup] || window.aimashiAvatar.avatarPresetGroups.human;
    els.profileAvatarDefaults.innerHTML = presets.map((preset) => `
      <button type="button" class="avatar-default${selected === preset.src ? " active" : ""}" data-avatar="${window.aimashiMarkdown.escapeHtml(preset.src)}" data-avatar-name="${window.aimashiMarkdown.escapeHtml(preset.name)}" title="${window.aimashiMarkdown.escapeHtml(preset.name)}" aria-label="${window.aimashiMarkdown.escapeHtml(preset.name)}" style="${window.aimashiAvatar.avatarThumbBackgroundStyle(preset.src, window.aimashiAvatar.avatarDefaultCropForSrc(preset.src), "#eef0ff")}"></button>
    `).join("");
    els.profileAvatarDefaults.querySelectorAll("[data-avatar]").forEach((button) => {
      button.addEventListener("click", async () => {
        const src = button.dataset.avatar;
        setProfileAvatarDraft(src, window.aimashiAvatar.avatarDefaultCropForSrc(src));
        // Auto-save: clicking a preset is a decisive choice. Pull the current
        // displayName from the input so we don't drop user's in-progress edit.
        try {
          const displayName = (els.profileDisplayName?.value || "").trim()
            || state.runtime?.user?.displayName
            || "Boss";
          state.runtime = await window.aimashi.saveProfile({
            displayName,
            avatarText: window.aimashiAvatar.initials(displayName),
            avatarImage: state.profileAvatarDraft.image || src,
            avatarCrop: window.aimashiAvatar.normalizeCrop(state.profileAvatarDraft.crop),
          });
          render();
        } catch (err) {
          console.error("[profile] preset avatar auto-save failed:", err);
        }
      });
    });
  }

  function renderFellowAvatarDraft() {
    if (!state || !els) return;
    const draft = state.fellowAvatarDraft;
    const crop = window.aimashiAvatar.normalizeCrop(draft.crop);
    if (els.fellowAvatarPreview) {
      els.fellowAvatarPreview.setAttribute("style", window.aimashiAvatar.avatarBackgroundStyle(draft.image, crop, "#eef0ff"));
      els.fellowAvatarPreview.title = "点击调整头像裁剪";
      els.fellowAvatarPreview.setAttribute("role", "button");
      els.fellowAvatarPreview.setAttribute("tabindex", "0");
      els.fellowAvatarPreview.setAttribute("aria-label", "调整头像裁剪");
    }
    renderFellowAvatarDefaults();
  }

  function renderAvatarCropEditor() {
    if (!state || !els || !els.avatarCropStage) return;
    const editor = state.avatarCropEditor;
    const crop = window.aimashiAvatar.normalizeCrop(editor.crop);
    els.avatarCropStage.setAttribute("style", window.aimashiAvatar.avatarBackgroundStyle(editor.image, crop, "#eef0ff"));
  }

  function openAvatarCropEditor(image, crop = null, target = "fellow") {
    if (!state) return;
    const src = window.aimashiAvatar.canonicalAvatarSrc(image);
    state.avatarCropEditor = {
      open: true,
      target,
      image: src,
      crop: window.aimashiAvatar.normalizeCrop(crop || window.aimashiAvatar.avatarDefaultCropForSrc(src)),
      dragging: false,
      lastX: 0,
      lastY: 0
    };
    renderView();
    renderAvatarCropEditor();
  }

  function closeAvatarCropEditor() {
    if (!state) return;
    state.avatarCropEditor.open = false;
    state.avatarCropEditor.dragging = false;
    renderView();
  }

  function updateAvatarCropEditor(crop) {
    if (!state) return;
    state.avatarCropEditor.crop = window.aimashiAvatar.normalizeCrop({
      ...state.avatarCropEditor.crop,
      ...crop
    });
    renderAvatarCropEditor();
  }

  function readFellowAvatarFile(file) {
    if (!file || !file.type?.startsWith("image/")) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      openAvatarCropEditor(String(reader.result || ""), { x: 50, y: 50, zoom: 1.12 }, "fellow");
    });
    reader.readAsDataURL(file);
  }

  function readProfileAvatarFile(file) {
    if (!file || !file.type?.startsWith("image/")) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      openAvatarCropEditor(String(reader.result || ""), { x: 50, y: 50, zoom: 1.12 }, "profile");
    });
    reader.readAsDataURL(file);
  }

  function detectedAgentEngineOptions() {
    const engines = state?.runtime?.agentEngines || {};
    const options = [{ id: "hermes", label: "默认" }];
    if (engines.claudeCode?.available) options.push({ id: "claude-code", label: "Claude Code" });
    if (engines.codex?.available) options.push({ id: "codex", label: "Codex" });
    return options;
  }

  function renderFellowAgentEngineSelect(current = "hermes") {
    if (!els) return;
    const options = detectedAgentEngineOptions();
    const showField = options.length > 1;
    els.fellowAgentEngineField?.classList.toggle("hidden", !showField);
    if (!els.fellowAgentEngine) return;
    els.fellowAgentEngine.innerHTML = "";
    for (const option of options) {
      const node = document.createElement("option");
      node.value = option.id;
      node.textContent = option.label;
      els.fellowAgentEngine.appendChild(node);
    }
    els.fellowAgentEngine.value = options.some((option) => option.id === current) ? current : "hermes";
  }

  function openFellowDialog(fellow = null, personaText = "") {
    if (!state || !els) return;
    if (fellow && fellow.currentTarget) fellow = null;
    // Allow a seed object in place of `fellow` to prefill create mode (used by
    // initial-onboarding flow). Detected by absence of a real key.
    const seed = fellow && !fellow.key && (fellow.name || fellow.agentEngine || fellow.bio) ? fellow : null;
    const actualFellow = seed ? null : fellow;
    state.fellowMenuOpen = false;
    state.fellowDialogMode = actualFellow ? "edit" : "create";
    state.fellowDialogOpen = true;
    const titleName = String(actualFellow?.name || "").trim();
    if (els.fellowDialogTitle) els.fellowDialogTitle.textContent = actualFellow
      ? `编辑「${titleName || "伙伴"}」`
      : (seed ? "创建你的第一个伙伴" : "添加伙伴");
    if (els.fellowKey) els.fellowKey.value = actualFellow?.key || "";
    els.fellowName.value = actualFellow?.name || seed?.name || "";
    renderFellowAgentEngineSelect(actualFellow?.agentEngine || actualFellow?.agent_engine || seed?.agentEngine || "hermes");
    const avatarImage = actualFellow?.avatarImage || window.aimashiAvatar.defaultAvatarAssets()[0];
    state.fellowAvatarPresetGroup = window.aimashiAvatar.avatarPresetGroupForSrc(avatarImage) || "human";
    setFellowAvatarDraft(avatarImage, window.aimashiAvatar.avatarCropForImage(avatarImage, actualFellow?.avatarCrop));
    els.fellowSeed.value = actualFellow ? personaText : (seed?.bio || "");
    if (els.fellowPersonaDetails) els.fellowPersonaDetails.open = Boolean(seed);
    renderView();
    setTimeout(() => els.fellowName?.focus(), 0);
  }

  function closeFellowDialog() {
    if (!state) return;
    state.fellowDialogOpen = false;
    renderView();
  }

  window.aimashiFellowDialog = {
    initFellowDialog,
    setFellowAvatarDraft,
    setProfileAvatarDraft,
    renderProfileAvatarDraft,
    openProfileDialog,
    closeProfileDialog,
    renderFellowAvatarDefaults,
    renderProfileAvatarDefaults,
    renderFellowAvatarDraft,
    renderAvatarCropEditor,
    openAvatarCropEditor,
    closeAvatarCropEditor,
    updateAvatarCropEditor,
    readFellowAvatarFile,
    readProfileAvatarFile,
    detectedAgentEngineOptions,
    renderFellowAgentEngineSelect,
    openFellowDialog,
    closeFellowDialog,
  };
})();
