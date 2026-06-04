// Fellow / profile / avatar-crop dialog module
// Extracted from app.js. Contains all the modal-dialog logic for editing a
// Fellow (name + persona + engine + avatar) and for editing the current
// user's profile (display name + avatar), plus the shared avatar crop editor.
//
// Defensive `if (!state || !els)` guards on every entry.
(function () {
  "use strict";

  let state, els;
  let renderView, render;
  let avatarTrimFrameToken = 0;

  function initFellowDialog(deps) {
    state = deps.state;
    els = deps.els;
    renderView = deps.renderView;
    render = deps.render;
    els.fellowRuntimeLocation?.addEventListener("change", () => {
      renderFellowAgentEngineSelect(els.fellowAgentEngine?.value || "hermes");
    });
  }

  function setFellowAvatarDraft(image, crop = null) {
    if (!state) return;
    const src = window.miaAvatar.canonicalAvatarSrc(image);
    state.fellowAvatarDraft = {
      image: src,
      crop: src ? window.miaAvatar.normalizeCrop(crop || window.miaAvatar.avatarDefaultCropForSrc(src)) : null
    };
    if (els.fellowAvatar) els.fellowAvatar.value = state.fellowAvatarDraft.image;
    renderFellowAvatarDraft();
  }

  function setProfileAvatarDraft(image, crop = null) {
    if (!state) return;
    const src = window.miaAvatar.canonicalAvatarSrc(image);
    state.profileAvatarDraft = {
      image: src,
      crop: src ? window.miaAvatar.normalizeCrop(crop || window.miaAvatar.avatarDefaultCropForSrc(src)) : null
    };
    if (els.profileAvatarImage) els.profileAvatarImage.value = state.profileAvatarDraft.image;
    renderProfileAvatarDraft();
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const text = String(value || "").trim();
      if (text) return text;
    }
    return "";
  }

  function currentProfileUser() {
    const cloudUser = state?.runtime?.cloud?.enabled ? state.runtime?.cloud?.user : null;
    const localUser = state?.runtime?.user || {};
    const displayName = firstNonEmpty(
      cloudUser?.displayName,
      cloudUser?.display_name,
      cloudUser?.name,
      cloudUser?.username,
      cloudUser?.email,
      localUser.displayName,
      localUser.name,
      localUser.username,
      localUser.account
    );
    return {
      ...localUser,
      ...(cloudUser || {}),
      displayName,
      avatarImage: firstNonEmpty(cloudUser?.avatarImage, cloudUser?.avatar_image, localUser.avatarImage),
      avatarCrop: cloudUser?.avatarCrop || cloudUser?.avatar_crop || localUser.avatarCrop || window.miaAvatar.DEFAULT_AVATAR_CROP,
      avatarColor: firstNonEmpty(cloudUser?.avatarColor, cloudUser?.avatar_color, localUser.avatarColor, "#111827")
    };
  }

  function renderProfileAvatarDraft() {
    if (!state || !els || !els.profileAvatarPreview) return;
    const draft = state.profileAvatarDraft;
    const user = currentProfileUser();
    // Resolve the preview the same way every other surface does: a custom
    // uploaded image is kept; otherwise the color (hashed from the user id) and
    // initials follow the name field live, so changing the name updates the
    // avatar instead of freezing the previous name's letters.
    const avatar = window.miaAvatarResolve.resolveAvatarForContact({
      id: user.id || "",
      displayName: els.profileDisplayName?.value || user.displayName || "",
      avatarImage: draft.image || "",
      avatarCrop: draft.crop || null
    });
    window.miaAvatar.applyAvatarMedia(els.profileAvatarPreview, avatar.image, avatar.crop, avatar.color, avatar.text);
    els.profileAvatarPreview.title = draft.image ? "点击调整头像裁剪" : "选择头像";
    els.profileAvatarPreview.setAttribute("role", "button");
    els.profileAvatarPreview.setAttribute("tabindex", "0");
    els.profileAvatarPreview.setAttribute("aria-label", "调整头像裁剪");
    renderProfileAvatarDefaults();
  }

  function openProfileDialog() {
    if (!state || !els) return;
    const user = currentProfileUser();
    state.profileDialogOpen = true;
    if (els.profileDisplayName) els.profileDisplayName.value = user.displayName || "";
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
    if (els?.fellowAvatarDefaults) els.fellowAvatarDefaults.innerHTML = "";
    if (els?.fellowAvatarDefaultTabs) els.fellowAvatarDefaultTabs.innerHTML = "";
  }

  function renderProfileAvatarDefaults() {
    if (els?.profileAvatarDefaults) els.profileAvatarDefaults.innerHTML = "";
    if (els?.profileAvatarDefaultTabs) els.profileAvatarDefaultTabs.innerHTML = "";
  }

  function renderFellowAvatarDraft() {
    if (!state || !els) return;
    const draft = state.fellowAvatarDraft;
    const crop = window.miaAvatar.normalizeCrop(draft.crop);
    if (els.fellowAvatarPreview) {
      const label = window.miaAvatarResolve?.identityDisplayText?.(els.fellowName?.value || "Fellow", "Fellow") || "Fe";
      window.miaAvatar.applyAvatarMedia(els.fellowAvatarPreview, draft.image, crop, "#eef0ff", label);
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
    const crop = window.miaAvatar.normalizeCrop(editor.crop);
    window.miaAvatar.applyAvatarMedia(els.avatarCropStage, editor.image, crop, "#eef0ff", "", { preserveChildren: true });
    updateAvatarTrimControls();
  }

  function clearAvatarTrimFrames() {
    avatarTrimFrameToken += 1;
    if (els?.avatarTrimFrames) {
      els.avatarTrimFrames.innerHTML = "";
      els.avatarTrimFrames.dataset.src = "";
      els.avatarTrimFrames.dataset.status = "";
    }
    if (els?.avatarTrimPreview) {
      els.avatarTrimPreview.removeAttribute("src");
      els.avatarTrimPreview.load?.();
    }
  }

  function avatarTrimFrameCount() {
    const width = Number(els?.avatarTrimTimeline?.clientWidth) || 320;
    return Math.max(5, Math.min(12, Math.round(width / 42)));
  }

  function setAvatarTrimFramePlaceholders(count = avatarTrimFrameCount()) {
    if (!els?.avatarTrimFrames) return;
    const frameCount = Math.max(5, Math.min(12, Number(count) || 8));
    els.avatarTrimFrames.dataset.status = "loading";
    els.avatarTrimFrames.innerHTML = Array.from({ length: frameCount }, () => (
      '<span class="avatar-trim-frame placeholder"></span>'
    )).join("");
  }

  function waitForVideoEvent(video, eventName) {
    if (eventName === "loadedmetadata" && video.readyState >= 1) return Promise.resolve();
    if (eventName === "loadeddata" && video.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener(eventName, done);
        video.removeEventListener("error", fail);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error("video frame load failed"));
      };
      video.addEventListener(eventName, done, { once: true });
      video.addEventListener("error", fail, { once: true });
    });
  }

  function waitForDecodedVideoFrame(video) {
    return new Promise((resolve) => {
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(() => resolve());
        return;
      }
      requestAnimationFrame(() => resolve());
    });
  }

  function seekAvatarTrimFrame(video, time) {
    return new Promise((resolve, reject) => {
      let timer = 0;
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener("seeked", done);
        video.removeEventListener("error", fail);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error("video frame seek failed"));
      };
      timer = setTimeout(done, 900);
      video.addEventListener("seeked", done, { once: true });
      video.addEventListener("error", fail, { once: true });
      try {
        video.currentTime = Math.max(0, time);
      } catch (err) {
        fail();
      }
    });
  }

  function drawAvatarTrimFrame(video, width = 84, height = 54) {
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext("2d");
    const sourceWidth = video.videoWidth || width;
    const sourceHeight = video.videoHeight || height;
    const scale = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    ctx.drawImage(video, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight);
    return canvas.toDataURL("image/jpeg", 0.76);
  }

  async function renderAvatarTrimFrames(src) {
    const frameBox = els?.avatarTrimFrames;
    if (!frameBox || !src) return;
    if (frameBox.dataset.src === src && ["loading", "ready", "error"].includes(frameBox.dataset.status)) return;
    const token = ++avatarTrimFrameToken;
    const frameCount = avatarTrimFrameCount();
    frameBox.dataset.src = src;
    setAvatarTrimFramePlaceholders(frameCount);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = src;
    video.load?.();
    try {
      await waitForVideoEvent(video, "loadedmetadata");
      const rawDuration = Number(video.duration);
      const duration = Number.isFinite(rawDuration) && rawDuration > 0
        ? rawDuration
        : (window.miaAvatarMedia?.MAX_TRIM_DURATION || 5);
      const frameWidth = Math.max(44, Math.round((els.avatarTrimTimeline?.clientWidth || 320) / frameCount));
      for (let i = 0; i < frameCount; i += 1) {
        if (token !== avatarTrimFrameToken || frameBox.dataset.src !== src) return;
        const time = Math.min(duration - 0.05, Math.max(0, ((i + 0.5) / frameCount) * duration));
        await seekAvatarTrimFrame(video, time).catch(() => {});
        await waitForDecodedVideoFrame(video);
        if (token !== avatarTrimFrameToken || frameBox.dataset.src !== src) return;
        const img = document.createElement("img");
        img.className = "avatar-trim-frame";
        img.alt = "";
        img.decoding = "async";
        img.src = drawAvatarTrimFrame(video, frameWidth, 54);
        frameBox.children[i]?.replaceWith(img);
      }
      if (token === avatarTrimFrameToken && frameBox.dataset.src === src) {
        frameBox.dataset.status = "ready";
      }
    } catch (err) {
      if (token === avatarTrimFrameToken && frameBox.dataset.src === src) {
        frameBox.dataset.status = "error";
      }
    } finally {
      video.removeAttribute("src");
      video.load?.();
    }
  }

  function updateAvatarTrimControls() {
    if (!state || !els?.avatarTrimControls) return;
    const editor = state.avatarCropEditor || {};
    const isVideo = window.miaAvatarMedia?.isVideo?.(editor.image);
    els.avatarTrimControls.classList.toggle("hidden", !isVideo);
    if (!isVideo) {
      clearAvatarTrimFrames();
      return;
    }
    const trim = window.miaAvatarMedia.normalizeTrim(editor.crop || {});
    const previewSrc = window.miaAvatar.avatarImageSrc(editor.image) || editor.image || "";
    if (els.avatarTrimPreview && els.avatarTrimPreview.getAttribute("src") !== previewSrc) {
      els.avatarTrimPreview.setAttribute("src", previewSrc);
      els.avatarTrimPreview.load?.();
    }
    renderAvatarTrimFrames(previewSrc);
    const total = Math.max(
      Number(els.avatarTrimPreview?.duration) || 0,
      trim.start + trim.duration,
      window.miaAvatarMedia.MAX_TRIM_DURATION || 5
    );
    const startPct = total ? Math.max(0, Math.min(100, (trim.start / total) * 100)) : 0;
    const endPct = total ? Math.max(startPct, Math.min(100, ((trim.start + trim.duration) / total) * 100)) : 100;
    els.avatarTrimTimeline?.style.setProperty("--trim-start", `${startPct}%`);
    els.avatarTrimTimeline?.style.setProperty("--trim-end", `${endPct}%`);
    if (els.avatarTrimLabel) {
      els.avatarTrimLabel.textContent = `${trim.start.toFixed(1)}s - ${(trim.start + trim.duration).toFixed(1)}s`;
    }
    if (els.avatarTrimStart && document.activeElement !== els.avatarTrimStart) {
      els.avatarTrimStart.value = String(trim.start);
    }
    if (els.avatarTrimDuration && document.activeElement !== els.avatarTrimDuration) {
      els.avatarTrimDuration.value = String(trim.duration);
    }
  }

  function openAvatarCropEditor(image, crop = null, target = "fellow") {
    if (!state) return;
    const src = window.miaAvatar.canonicalAvatarSrc(image);
    state.avatarCropEditor = {
      open: true,
      target,
      image: src,
      crop: window.miaAvatar.normalizeCrop(crop || window.miaAvatar.avatarDefaultCropForSrc(src)),
      dragging: false,
      lastX: 0,
      lastY: 0
    };
    renderView();
    renderAvatarCropEditor();
  }

  function closeAvatarCropEditor() {
    if (!state) return;
    clearAvatarTrimFrames();
    state.avatarCropEditor.open = false;
    state.avatarCropEditor.dragging = false;
    renderView();
  }

  function updateAvatarCropEditor(crop) {
    if (!state) return;
    state.avatarCropEditor.crop = window.miaAvatar.normalizeCrop({
      ...state.avatarCropEditor.crop,
      ...crop
    });
    renderAvatarCropEditor();
  }

  function readFellowAvatarFile(file) {
    readAvatarFile(file, "fellow");
  }

  function readProfileAvatarFile(file) {
    readAvatarFile(file, "profile");
  }

  function readAvatarFile(file, target) {
    if (!file) return;
    const isImage = file.type?.startsWith("image/");
    const isVideo = file.type?.startsWith("video/");
    if (!isImage && !isVideo) return;
    if (isVideo && file.size > 8 * 1024 * 1024) {
      window.alert?.("视频头像请控制在 8MB 以内。");
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      openAvatarCropEditor(String(reader.result || ""), isVideo
        ? { x: 50, y: 50, zoom: 1, start: 0, duration: 3 }
        : { x: 50, y: 50, zoom: 1.12 }, target);
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

  function fellowRuntimeLocationOptions() {
    const cloudEnabled = Boolean(state && state.runtime?.cloud?.enabled);
    return [
      { id: "desktop-local", label: "当前设备", disabled: false },
      { id: "cloud-hermes", label: cloudEnabled ? "Mia Cloud" : "Mia Cloud（需先登录）", disabled: !cloudEnabled }
    ];
  }

  function selectedRuntimeLocation() {
    const value = String(els?.fellowRuntimeLocation?.value || "desktop-local").trim();
    return value === "cloud-hermes" ? "cloud-hermes" : "desktop-local";
  }

  function renderFellowRuntimeLocationSelect(current = "desktop-local") {
    if (!els?.fellowRuntimeLocation) return;
    const options = fellowRuntimeLocationOptions();
    els.fellowRuntimeLocation.innerHTML = "";
    for (const option of options) {
      const node = document.createElement("option");
      node.value = option.id;
      node.textContent = option.label;
      node.disabled = Boolean(option.disabled);
      els.fellowRuntimeLocation.appendChild(node);
    }
    const allowed = options.some((option) => option.id === current && !option.disabled);
    els.fellowRuntimeLocation.value = allowed ? current : "desktop-local";
  }

  function renderFellowAgentEngineSelect(current = "hermes") {
    if (!els) return;
    const runtimeKind = selectedRuntimeLocation();
    const options = detectedAgentEngineOptions();
    const showField = options.length > 1;
    els.fellowAgentEngineField?.classList.toggle("hidden", runtimeKind === "cloud-hermes" || !showField);
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
    const runtimeKind = window.miaFellowDirectory?.normalizeRuntimeKind?.(
      actualFellow?.runtimeKind || actualFellow?.runtime_kind || seed?.runtimeKind,
      actualFellow?.sourceKinds?.includes?.("cloud") ? "cloud-hermes" : "desktop-local"
    ) || "desktop-local";
    renderFellowRuntimeLocationSelect(runtimeKind);
    if (els.fellowRuntimeLocation) els.fellowRuntimeLocation.disabled = Boolean(actualFellow);
    renderFellowAgentEngineSelect(actualFellow?.agentEngine || actualFellow?.agent_engine || seed?.agentEngine || state.preferredAgentEngine || "hermes");
    const avatarImage = actualFellow?.avatarImage || "";
    setFellowAvatarDraft(avatarImage, window.miaAvatar.avatarCropForImage(avatarImage, actualFellow?.avatarCrop));
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

  window.miaFellowDialog = {
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
    updateAvatarTrimControls,
    readFellowAvatarFile,
    readProfileAvatarFile,
    detectedAgentEngineOptions,
    renderFellowRuntimeLocationSelect,
    renderFellowAgentEngineSelect,
    openFellowDialog,
    closeFellowDialog,
  };
})();
