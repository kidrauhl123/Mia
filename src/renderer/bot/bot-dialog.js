// Bot / profile / avatar-crop dialog module
// Extracted from app.js. Contains all the modal-dialog logic for editing a
// Bot (name + persona + engine + avatar) and for editing the current
// user's profile (display name + avatar), plus the shared avatar crop editor.
//
// Defensive `if (!state || !els)` guards on every entry.
(function () {
  "use strict";

  let state, els;
  let renderView, render;
  let avatarTrimFrameToken = 0;
  let botRuntimeHydrateToken = 0;
  let botDialogOpenToken = 0;
  let botRuntimeTargetOptionsToken = 0;

  function initBotDialog(deps) {
    state = deps.state;
    els = deps.els;
    renderView = deps.renderView;
    render = deps.render;
  }

  function setBotAvatarDraft(image, crop = null) {
    if (!state) return;
    const src = window.miaAvatar.canonicalAvatarSrc(image);
    state.botAvatarDraft = {
      image: src,
      crop: src ? window.miaAvatar.normalizeCrop(crop || window.miaAvatar.avatarDefaultCropForSrc(src)) : null,
      color: state.botAvatarDraft?.color || ""
    };
    if (els.botAvatar) els.botAvatar.value = state.botAvatarDraft.image;
    renderBotAvatarDraft();
  }

  function setProfileAvatarDraft(image, crop = null) {
    if (!state) return;
    const src = window.miaAvatar.canonicalAvatarSrc(image);
    state.profileAvatarDraft = {
      image: src,
      crop: src ? window.miaAvatar.normalizeCrop(crop || window.miaAvatar.avatarDefaultCropForSrc(src)) : null,
      color: state.profileAvatarDraft?.color || ""
    };
    if (els.profileAvatarImage) els.profileAvatarImage.value = state.profileAvatarDraft.image;
    renderProfileAvatarDraft();
  }

  // Renders the "头像颜色" swatch row: the shared palette + a rainbow chip that
  // opens the native color picker for a fully custom hex. No "auto" chip — a
  // member with no chosen color simply falls back to the id hash by default, so
  // most people never have to think about it.
  //
  // The row is built once (and the rainbow's looping Lottie mounted once) so
  // typing in the name field — which re-renders the preview every keystroke —
  // doesn't tear down and reload the animation; later calls only update which
  // chip looks selected. teardownColorSwatches() frees the Lottie on close.
  function renderColorSwatches(container, currentColor, onPick) {
    if (!container) return;
    const palette = (window.miaMemberColor && window.miaMemberColor.PALETTE) || [];
    const current = String(currentColor || "").toLowerCase();
    const isPreset = palette.some((c) => String(c).toLowerCase() === current);
    if (container.dataset.built !== "1") {
      const chips = palette.map((c) =>
        `<button type="button" class="avatar-color-chip" data-color="${c}" style="background:${c};" title="${c}" aria-label="${c}"></button>`
      );
      // Rainbow chip → system color picker (same native <input type=color> the
      // settings page uses). The looping Lottie fills the circle behind it.
      chips.push(
        `<label class="avatar-color-chip avatar-color-custom" title="自定义颜色">` +
        `<span class="avatar-color-lottie" data-lottie="rainbow" data-lottie-trigger="loop" aria-hidden="true"></span>` +
        `<input type="color" aria-label="自定义颜色"></label>`
      );
      container.innerHTML = chips.join("");
      container.dataset.built = "1";
      container.querySelectorAll("button.avatar-color-chip").forEach((btn) => {
        btn.addEventListener("click", () => onPick(btn.dataset.color || ""));
      });
      const customInput = container.querySelector(".avatar-color-custom input[type=color]");
      if (customInput) customInput.addEventListener("change", () => onPick(customInput.value));
      window.miaLottieIcons?.init?.(container);
    }
    container.querySelectorAll(".avatar-color-chip").forEach((el) => {
      const isCustom = el.classList.contains("avatar-color-custom");
      const sel = isCustom ? Boolean(current && !isPreset) : (String(el.dataset.color || "").toLowerCase() === current);
      el.classList.toggle("is-selected", sel);
    });
    const customInput = container.querySelector(".avatar-color-custom input[type=color]");
    if (customInput && /^#[0-9a-f]{6}$/.test(current)) customInput.value = current;
  }

  function teardownColorSwatches(container) {
    if (!container) return;
    window.miaLottieIcons?.destroy?.(container);
    container.innerHTML = "";
    delete container.dataset.built;
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
      avatarColor: firstNonEmpty(cloudUser?.avatarColor, cloudUser?.avatar_color, localUser.avatarColor)
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
      avatarCrop: draft.crop || null,
      color: draft.color || ""
    });
    window.miaAvatar.applyAvatarMedia(els.profileAvatarPreview, avatar.image, avatar.crop, avatar.color, avatar.text);
    els.profileAvatarPreview.title = draft.image ? "点击调整头像裁剪" : "选择头像";
    els.profileAvatarPreview.setAttribute("role", "button");
    els.profileAvatarPreview.setAttribute("tabindex", "0");
    els.profileAvatarPreview.setAttribute("aria-label", "调整头像裁剪");
    renderColorSwatches(document.getElementById("profileAvatarColors"), draft.color || "", (color) => {
      if (state.profileAvatarDraft) state.profileAvatarDraft.color = color;
      renderProfileAvatarDraft();
      window.miaProfileControls?.saveDraft?.();
    });
  }

  function openProfileDialog() {
    if (!state || !els) return;
    const user = currentProfileUser();
    state.profileDialogOpen = true;
    if (els.profileDisplayName) els.profileDisplayName.value = user.displayName || "";
    if (els.profileUidValue) els.profileUidValue.textContent = user.id || "未登录";
    if (els.profileStatusBadge) els.profileStatusBadge.value = window.miaStatusBadgeControls?.statusBadgePresetValue?.(user.statusBadge) || "";
    setProfileAvatarDraft(user.avatarImage || "", user.avatarCrop);
    if (state.profileAvatarDraft) state.profileAvatarDraft.color = user.avatarColor || "";
    renderProfileAvatarDraft();
    renderView();
    window.miaStatusBadgeControls?.syncIdentityNameText?.("profile");
    window.miaStatusBadgeControls?.syncStatusBadgeControl?.("profile");
  }

  function closeProfileDialog() {
    if (!state) return;
    state.profileDialogOpen = false;
    teardownColorSwatches(document.getElementById("profileAvatarColors"));
    renderView();
  }

  function renderBotAvatarDefaults() {
    if (els?.botAvatarDefaults) els.botAvatarDefaults.innerHTML = "";
    if (els?.botAvatarDefaultTabs) els.botAvatarDefaultTabs.innerHTML = "";
  }

  function renderProfileAvatarDefaults() {
    if (els?.profileAvatarDefaults) els.profileAvatarDefaults.innerHTML = "";
    if (els?.profileAvatarDefaultTabs) els.profileAvatarDefaultTabs.innerHTML = "";
  }

  function renderBotAvatarDraft() {
    if (!state || !els) return;
    const draft = state.botAvatarDraft;
    if (els.botAvatarPreview) {
      // Same canonical resolution as every other surface: a custom image is
      // kept, otherwise the accent color + initials follow the bot identity /
      // name — no more hardcoded lavender that mismatched the real avatar.
      const name = els.botName?.value || "Bot";
      const avatar = window.miaAvatarResolve.resolveAvatarForContact({
        id: draft.identityId || name,
        displayName: name,
        avatarImage: draft.image || "",
        avatarCrop: draft.crop || null,
        color: draft.color || ""
      });
      window.miaAvatar.applyAvatarMedia(els.botAvatarPreview, avatar.image, avatar.crop, avatar.color, avatar.text);
      els.botAvatarPreview.title = "点击调整头像裁剪";
      els.botAvatarPreview.setAttribute("role", "button");
      els.botAvatarPreview.setAttribute("tabindex", "0");
      els.botAvatarPreview.setAttribute("aria-label", "调整头像裁剪");
    }
    renderColorSwatches(document.getElementById("botAvatarColors"), state.botAvatarDraft?.color || "", (color) => {
      if (state.botAvatarDraft) state.botAvatarDraft.color = color;
      renderBotAvatarDraft();
    });
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

  function openAvatarCropEditor(image, crop = null, target = "bot") {
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

  function readBotAvatarFile(file) {
    readAvatarFile(file, "bot");
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

  function engineLabel(engine = "hermes") {
    if (!engine) return "";
    return window.miaEngineContracts?.engineLabel?.(engine) || "Hermes";
  }

  function strictAgentEngine(value = "") {
    const strict = window.miaCloudRuntime?.normalizeAgentEngineStrict?.(value);
    if (strict) return strict;
    const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
    if (raw === "claude" || raw === "claude-code") return "claude-code";
    if (raw === "codex" || raw === "openai-codex") return "codex";
    if (raw === "hermes") return "hermes";
    return "";
  }

  function cloudAgentRuntime() {
    return window.miaCloudRuntime?.cloudAgentRuntimeFromState?.(state) || {
      runtimeKind: "",
      agentEngine: "",
      label: "",
      available: false
    };
  }

  function encodeRuntimeTarget(target = {}) {
    const isCloud = String(target.runtimeKind || "").trim() === "cloud-claude-code";
    return JSON.stringify({
      runtimeKind: isCloud ? "cloud-claude-code" : "desktop-local",
      deviceId: String(target.deviceId || "").trim(),
      deviceName: String(target.deviceName || "").trim(),
      agentEngine: isCloud ? strictAgentEngine(target.agentEngine) : String(target.agentEngine || "hermes").trim()
    });
  }

  function parseRuntimeTargetValue(value = "") {
    try {
      const parsed = JSON.parse(String(value || ""));
      const runtimeKind = String(parsed.runtimeKind || "").trim() === "cloud-claude-code" ? "cloud-claude-code" : "desktop-local";
      return {
        runtimeKind,
        targetDeviceId: runtimeKind === "cloud-claude-code" ? "" : String(parsed.deviceId || "").trim(),
        targetDeviceName: runtimeKind === "cloud-claude-code" ? "Mia Cloud" : String(parsed.deviceName || "").trim(),
        agentEngine: runtimeKind === "cloud-claude-code" ? strictAgentEngine(parsed.agentEngine) : String(parsed.agentEngine || "hermes").trim()
      };
    } catch {
      return { runtimeKind: "desktop-local", targetDeviceId: "", targetDeviceName: "", agentEngine: "hermes" };
    }
  }

  function readSelectedRuntimeTarget() {
    return parseRuntimeTargetValue(els?.botRuntimeTarget?.value || "");
  }

  function runtimeTargetFromBinding(binding = {}) {
    const runtimeKind = window.miaBotDirectory?.normalizeRuntimeKind?.(
      binding.runtimeKind || binding.runtime_kind,
      "cloud-claude-code"
    ) || "cloud-claude-code";
    if (runtimeKind === "cloud-claude-code") {
      return {
        runtimeKind: "cloud-claude-code",
        deviceId: "",
        deviceName: "Mia Cloud",
        agentEngine: strictAgentEngine(binding.agentEngine || binding.agent_engine) || cloudAgentRuntime().agentEngine
      };
    }
    return {
      runtimeKind: "desktop-local",
      deviceId: String(binding.targetDeviceId || binding.target_device_id || "").trim(),
      deviceName: String(binding.targetDeviceName || binding.target_device_name || "").trim(),
      agentEngine: window.miaBotDirectory?.normalizeAgentEngine?.(binding.agentEngine || binding.agent_engine || "hermes", "desktop-local")
        || "hermes"
    };
  }

  function dialogRuntimeTargetOptionsCache() {
    if (!state.botDialogRuntimeTargetOptions || typeof state.botDialogRuntimeTargetOptions.get !== "function") {
      state.botDialogRuntimeTargetOptions = new Map();
    }
    return state.botDialogRuntimeTargetOptions;
  }

  function dialogRuntimeTargetOptionsLoadingKeys() {
    if (!state.botDialogRuntimeTargetOptionsLoading || typeof state.botDialogRuntimeTargetOptionsLoading.has !== "function") {
      state.botDialogRuntimeTargetOptionsLoading = new Set();
    }
    return state.botDialogRuntimeTargetOptionsLoading;
  }

  function clearDialogRuntimeTargetOptions() {
    state?.botDialogRuntimeTargetOptions?.clear?.();
    state?.botDialogRuntimeTargetOptionsLoading?.clear?.();
  }

  function runtimeTargetBotSnapshot(current = {}) {
    const runtimeKind = String(current.runtimeKind || "").trim() === "cloud-claude-code" ? "cloud-claude-code" : "desktop-local";
    const deviceId = runtimeKind === "cloud-claude-code" ? "" : String(current.deviceId || current.targetDeviceId || "").trim();
    const deviceName = runtimeKind === "cloud-claude-code" ? "Mia Cloud" : String(current.deviceName || current.targetDeviceName || "").trim();
    const agentEngine = runtimeKind === "cloud-claude-code"
      ? strictAgentEngine(current.agentEngine || cloudAgentRuntime().agentEngine)
      : String(current.agentEngine || state?.preferredAgentEngine || "hermes").trim();
    const key = String(els?.botKey?.value || "").trim();
    const targetIntent = { deviceId, deviceName, agentEngine };
    return {
      ...(key ? { key, id: key } : {}),
      runtimeKind,
      targetIntent,
      targetDeviceId: deviceId,
      targetDeviceName: deviceName
    };
  }

  function runtimeTargetOptionsRequest(current = {}) {
    const bot = runtimeTargetBotSnapshot(current);
    return {
      bot,
      runtime: state?.runtime || {},
      engineCapabilities: state?.engineCapabilities || {},
      preferredAgentEngine: bot.targetIntent?.agentEngine || state?.preferredAgentEngine || ""
    };
  }

  function runtimeTargetOptionsKey(current = {}) {
    return JSON.stringify({
      mode: state?.botDialogMode || "",
      request: runtimeTargetOptionsRequest(current)
    });
  }

  function normalizeCoreRuntimeOption(option = {}) {
    const runtimeKind = String(option.runtimeKind || option.runtime_kind || "").trim() === "cloud-claude-code" ? "cloud-claude-code" : "desktop-local";
    const agentEngine = runtimeKind === "cloud-claude-code"
      ? strictAgentEngine(option.agentEngine || option.agent_engine || cloudAgentRuntime().agentEngine)
      : String(option.agentEngine || option.agent_engine || "hermes").trim();
    return {
      runtimeKind,
      deviceId: runtimeKind === "cloud-claude-code" ? "" : String(option.deviceId || option.device_id || "").trim(),
      deviceName: runtimeKind === "cloud-claude-code" ? "Mia Cloud" : String(option.deviceName || option.device_name || "").trim(),
      agentEngine,
      label: String(option.label || option.engineLabel || option.engine_label || engineLabel(agentEngine) || "Agent").trim(),
      selected: Boolean(option.selected),
      disabled: Boolean(option.disabled),
      disabledReason: String(option.disabledReason || option.disabled_reason || "").trim()
    };
  }

  function normalizeCoreRuntimeGroup(group = {}) {
    const label = String(group.label || "运行目标").trim();
    const status = String(group.statusLabel || group.status_label || "").trim();
    const groupLabel = status && status !== label ? `${label} · ${status}` : label;
    return {
      label: groupLabel,
      options: Array.isArray(group.options) ? group.options.map(normalizeCoreRuntimeOption) : []
    };
  }

  function mergeRuntimeBindingIntoBotSnapshot(bot = {}, binding = {}) {
    const key = String(bot.key || bot.id || binding.botId || binding.bot_id || "").trim();
    if (!key) return null;
    const target = runtimeTargetFromBinding(binding);
    return {
      ...bot,
      key,
      id: bot.id || key,
      runtimeKind: target.runtimeKind,
      agentEngine: target.agentEngine,
      targetDeviceId: target.deviceId,
      targetDeviceName: target.deviceName,
      deviceId: target.deviceId,
      deviceName: target.deviceName,
      runtimeLabel: target.runtimeKind === "cloud-claude-code" ? "Mia Cloud" : (target.deviceName || "当前设备")
    };
  }

  function updateOwnedBotRuntimeSnapshot(bot = {}, binding = {}) {
    const nextBot = mergeRuntimeBindingIntoBotSnapshot(bot, binding);
    if (!nextBot) return;
    const socialState = window.miaSocial?.moduleState;
    if (!socialState || !Array.isArray(socialState.bots)) return;
    socialState.bots = [
      nextBot,
      ...socialState.bots.filter((item) => String(item?.key || item?.id || "") !== nextBot.key)
    ];
  }

  async function hydrateActiveRuntimeTargetForDialog(bot = {}, initialSelectValue = "") {
    const key = String(bot?.key || bot?.id || "").trim();
    if (!key || typeof window.miaBotCommands?.getBotRuntimeBinding !== "function") return;
    const token = ++botRuntimeHydrateToken;
    try {
      const binding = await window.miaBotCommands.getBotRuntimeBinding({
        api: window.mia,
        botKey: key,
        runtimeKind: "active"
      });
      if (!binding || binding.enabled === false) return;
      if (token !== botRuntimeHydrateToken) return;
      if (!state?.botDialogOpen || String(els?.botKey?.value || "") !== key) return;
      const target = runtimeTargetFromBinding(binding);
      updateOwnedBotRuntimeSnapshot(bot, binding);
      clearDialogRuntimeTargetOptions();
      renderBotRuntimeTargetSelect(target);
    } catch (error) {
      console.warn("[bot-dialog] active bot runtime load failed:", error?.message || error);
    }
  }

  function runtimeTargetGroups(current = {}) {
    const cached = dialogRuntimeTargetOptionsCache().get(runtimeTargetOptionsKey(current));
    if (Array.isArray(cached?.groups) && cached.groups.length) {
      return cached.groups.map(normalizeCoreRuntimeGroup).filter((group) => group.options.length);
    }
    const pending = runtimeTargetBotSnapshot(current);
    return [{
      label: "运行目标",
      options: [{
        runtimeKind: pending.runtimeKind,
        deviceId: pending.targetIntent?.deviceId || "",
        deviceName: pending.targetIntent?.deviceName || (pending.runtimeKind === "cloud-claude-code" ? "Mia Cloud" : "当前设备"),
        agentEngine: pending.targetIntent?.agentEngine || "hermes",
        label: "同步运行目标...",
        disabled: true
      }]
    }];
  }

  function loadRuntimeTargetOptionsForDialog(current = {}, options = {}) {
    if (options.skipCoreLoad) return;
    const api = window.mia?.social?.getBotRuntimeTargetOptions;
    if (typeof api !== "function") return;
    const key = runtimeTargetOptionsKey(current);
    const cache = dialogRuntimeTargetOptionsCache();
    if (cache.has(key)) return;
    const loading = dialogRuntimeTargetOptionsLoadingKeys();
    if (loading.has(key)) return;
    loading.add(key);
    const token = ++botRuntimeTargetOptionsToken;
    const request = runtimeTargetOptionsRequest(current);
    deferBotDialogWork(() => {
      if (!state?.botDialogOpen || token !== botRuntimeTargetOptionsToken) {
        loading.delete(key);
        return;
      }
      Promise.resolve(api(request))
        .then((result) => {
          const data = result?.data || result || {};
          if (!Array.isArray(data.groups)) return;
          cache.set(key, data);
          if (!state?.botDialogOpen || token !== botRuntimeTargetOptionsToken) return;
          renderBotRuntimeTargetSelect(current, { preservePrevious: true, skipCoreLoad: true });
        })
        .catch((error) => console.warn("[bot-dialog] runtime target options load failed:", error?.message || error))
        .finally(() => {
          loading.delete(key);
        });
    });
  }

  function renderBotRuntimeTargetSelect(current = {}, options = {}) {
    if (!els?.botRuntimeTarget) return;
    const select = els.botRuntimeTarget;
    const previous = select.value;
    const cloudRuntime = cloudAgentRuntime();
    const groups = runtimeTargetGroups(current);
    const selectedCoreOption = groups.flatMap((group) => group.options || []).find((option) => option.selected);
    const wanted = encodeRuntimeTarget(current.runtimeKind === "cloud-claude-code"
      ? (selectedCoreOption || { runtimeKind: "cloud-claude-code", agentEngine: current.agentEngine || cloudRuntime.agentEngine })
      : {
        runtimeKind: "desktop-local",
        deviceId: selectedCoreOption?.deviceId || current.deviceId || "current-device",
        deviceName: selectedCoreOption?.deviceName || current.deviceName || "当前设备",
        agentEngine: current.agentEngine || state?.preferredAgentEngine || "hermes"
      });
    select.innerHTML = "";
    for (const group of groups) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      for (const option of group.options) {
        const node = document.createElement("option");
        node.value = encodeRuntimeTarget(option);
        node.textContent = option.label;
        node.disabled = Boolean(option.disabled);
        if (option.disabledReason) node.title = option.disabledReason;
        optgroup.appendChild(node);
      }
      select.appendChild(optgroup);
    }
    const values = Array.from(select.options).map((option) => option.value);
    if (options.preservePrevious && previous && values.includes(previous)) select.value = previous;
    else if (values.includes(wanted)) select.value = wanted;
    else select.value = values[0] || "";
    loadRuntimeTargetOptionsForDialog(current, options);
  }

  function renderBotRuntimeLocationSelect(current = "desktop-local") {
    renderBotRuntimeTargetSelect({ runtimeKind: current });
  }

  function renderBotRuntimeDeviceSelect(current = "") {
    renderBotRuntimeTargetSelect({ runtimeKind: "desktop-local", deviceId: current });
  }

  function renderBotAgentEngineSelect(current = "hermes") {
    if (!els?.botRuntimeTarget) return;
    const parsed = readSelectedRuntimeTarget();
    renderBotRuntimeTargetSelect({
      runtimeKind: parsed.runtimeKind,
      deviceId: parsed.targetDeviceId,
      deviceName: parsed.targetDeviceName,
      agentEngine: current
    });
  }

  function deferBotDialogWork(callback) {
    const timer = typeof window !== "undefined" && typeof window.setTimeout === "function"
      ? window.setTimeout.bind(window)
      : (typeof setTimeout === "function" ? setTimeout : null);
    if (timer) timer(callback, 0);
    else callback();
  }

  function resetBotDialogFields() {
    if (!state || !els) return;
    els.botForm?.reset?.();
    if (els.botKey) els.botKey.value = "";
    if (els.botName) els.botName.value = "";
    if (els.botNameText) els.botNameText.textContent = "";
    if (els.botStatusBadge) els.botStatusBadge.value = "";
    if (els.botSeed) els.botSeed.value = "";
    if (els.botPersonaDetails) els.botPersonaDetails.open = false;
    if (els.botAvatar) els.botAvatar.value = "";
    state.botAvatarDraft = { image: "", crop: null, color: "", identityId: "" };
  }

  function openBotDialog(bot = null, personaText = "") {
    if (!state || !els) return;
    if (bot && bot.currentTarget) bot = null;
    resetBotDialogFields();
    const botKey = firstNonEmpty(bot?.key, bot?.id);
    // Allow a seed object in place of `bot` to prefill create mode (used by
    // initial-onboarding flow). Existing cloud identities may have only `id`.
    const seed = bot && !botKey && (bot.name || bot.agentEngine || bot.bio || bot.personaText || bot.persona_text) ? bot : null;
    const actualBot = seed ? null : (botKey ? bot : null);
    state.botMenuOpen = false;
    state.botDialogMode = actualBot ? "edit" : "create";
    state.botDialogOpen = true;
    clearDialogRuntimeTargetOptions();
    const titleName = String(actualBot?.name || "").trim();
    if (els.botDialogTitle) els.botDialogTitle.textContent = actualBot
      ? `编辑「${titleName || "伙伴"}」`
      : (seed ? "创建你的第一个伙伴" : "添加伙伴");
    if (els.botKey) els.botKey.value = firstNonEmpty(actualBot?.key, actualBot?.id);
    els.botName.value = actualBot?.name || seed?.name || "";
    if (els.botStatusBadge) els.botStatusBadge.value = window.miaStatusBadgeControls?.statusBadgePresetValue?.(actualBot?.statusBadge || actualBot?.status_badge) || "";
    const runtimeKind = window.miaBotDirectory?.normalizeRuntimeKind?.(
      actualBot?.runtimeKind || actualBot?.runtime_kind || seed?.runtimeKind,
      window.miaBotDirectory?.isCloudIdentityBot?.(actualBot) ? "cloud-claude-code" : "desktop-local"
    ) || "desktop-local";
    renderBotRuntimeTargetSelect({
      runtimeKind,
      deviceId: actualBot?.targetDeviceId
        || actualBot?.target_device_id
        || actualBot?.deviceId
        || actualBot?.device_id
        || "",
      deviceName: actualBot?.targetDeviceName
        || actualBot?.target_device_name
        || actualBot?.deviceName
        || actualBot?.device_name
        || "",
      agentEngine: actualBot?.agentEngine || actualBot?.agent_engine || seed?.agentEngine || state.preferredAgentEngine || "hermes"
    });
    const initialRuntimeSelectValue = els.botRuntimeTarget?.value || "";
    const avatarImage = actualBot?.avatarImage || "";
    const avatarSrc = window.miaAvatar.canonicalAvatarSrc(avatarImage);
    state.botAvatarDraft = {
      image: avatarSrc,
      crop: avatarSrc ? window.miaAvatar.normalizeCrop(window.miaAvatar.avatarCropForImage(avatarSrc, actualBot?.avatarCrop)) : null,
      color: state.botAvatarDraft?.color || ""
    };
    if (els.botAvatar) els.botAvatar.value = state.botAvatarDraft.image;
    // Canonical avatar identity of the bot being edited, so the preview's
    // background matches the hashed accent color shown everywhere else (create
    // mode has no id yet → the preview follows the name field).
    if (state.botAvatarDraft) {
      state.botAvatarDraft.identityId = actualBot
        ? (window.miaContact?.botAvatarIdentityId?.(botKey, actualBot) || botKey)
        : "";
      state.botAvatarDraft.color = actualBot?.color || actualBot?.avatarColor || "";
    }
    els.botSeed.value = actualBot ? personaText : (seed?.personaText || seed?.persona_text || seed?.bio || "");
    if (els.botPersonaDetails) els.botPersonaDetails.open = Boolean(seed);
    const openToken = ++botDialogOpenToken;
    const openedKey = String(firstNonEmpty(actualBot?.key, actualBot?.id));
    const openedMode = state.botDialogMode;
    renderView();
    deferBotDialogWork(() => {
      if (openToken !== botDialogOpenToken) return;
      if (!state?.botDialogOpen || state.botDialogMode !== openedMode) return;
      if (String(els?.botKey?.value || "") !== openedKey) return;
      renderBotAvatarDraft();
      refreshBridgeDevicesForDialog();
      window.miaStatusBadgeControls?.syncIdentityNameText?.("bot");
      window.miaStatusBadgeControls?.syncStatusBadgeControl?.("bot");
      if (!actualBot) {
        window.miaStatusBadgeControls?.beginIdentityNameEdit?.("bot");
      } else {
        window.miaStatusBadgeControls?.endIdentityNameEdit?.("bot");
        hydrateActiveRuntimeTargetForDialog(actualBot, initialRuntimeSelectValue);
      }
    });
  }

  function refreshBridgeDevicesForDialog() {
    if (!state?.runtime?.cloud?.enabled || typeof window.mia?.social?.listBridgeDevices !== "function") return;
    window.mia.social.listBridgeDevices({ includeOffline: true })
      .then((result) => {
        const devices = result?.data?.devices || result?.devices || [];
        if (!Array.isArray(devices)) return;
        state.runtime = {
          ...(state.runtime || {}),
          cloud: {
            ...(state.runtime?.cloud || {}),
            devices
          }
        };
        if (state.botDialogOpen) {
          clearDialogRuntimeTargetOptions();
          const selected = readSelectedRuntimeTarget();
          renderBotRuntimeTargetSelect({
            runtimeKind: selected.runtimeKind,
            deviceId: selected.targetDeviceId,
            deviceName: selected.targetDeviceName,
            agentEngine: selected.agentEngine
          }, { preservePrevious: true });
        }
      })
      .catch((error) => console.warn("[bot-dialog] bridge devices load failed:", error?.message || error));
  }

  function closeBotDialog() {
    if (!state) return;
    botDialogOpenToken += 1;
    botRuntimeHydrateToken += 1;
    botRuntimeTargetOptionsToken += 1;
    clearDialogRuntimeTargetOptions();
    state.botDialogOpen = false;
    resetBotDialogFields();
    teardownColorSwatches(document.getElementById("botAvatarColors"));
    renderView();
  }

  window.miaBotDialog = {
    initBotDialog,
    setBotAvatarDraft,
    setProfileAvatarDraft,
    renderProfileAvatarDraft,
    openProfileDialog,
    closeProfileDialog,
    renderBotAvatarDefaults,
    renderProfileAvatarDefaults,
    renderBotAvatarDraft,
    renderAvatarCropEditor,
    openAvatarCropEditor,
    closeAvatarCropEditor,
    updateAvatarCropEditor,
    updateAvatarTrimControls,
    readBotAvatarFile,
    readProfileAvatarFile,
    readSelectedRuntimeTarget,
    renderBotRuntimeTargetSelect,
    renderBotRuntimeLocationSelect,
    renderBotAgentEngineSelect,
    openBotDialog,
    closeBotDialog,
  };
})();
