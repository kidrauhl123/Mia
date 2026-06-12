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
    if (engine === "claude-code") return "Claude Code";
    if (engine === "codex") return "Codex";
    if (engine === "openclaw") return "OpenClaw";
    return "Hermes";
  }

  function compactDeviceName(value = "") {
    return String(value || "")
      .trim()
      .replace(/\s*(?:·|-)?\s*Mia\s+(?:Desktop|Bridge)(?=\s*(?:·|-|$))/gi, "")
      .replace(/\.local(?=\s|$)/gi, "")
      .replace(/\s*(?:·|-)\s*(?:本机|在线|离线)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function runtimeDeviceDisplayName(device = {}) {
    if (device.isLocal || device.status === "local") return "本机";
    return compactDeviceName(device.deviceName || device.device_name || device.name || "") || String(device.id || "").trim() || "设备";
  }

  function runtimeDeviceGroupLabel(device = {}) {
    const name = runtimeDeviceDisplayName(device);
    const status = deviceStatusLabel(device);
    return status && status !== name ? `${name} · ${status}` : name;
  }

  function normalizedDevice(input = {}) {
    const id = String(input.id || input.deviceId || "").trim();
    if (!id) return null;
    const aliases = Array.isArray(input.aliases)
      ? input.aliases.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    return {
      ...input,
      id,
      deviceName: String(input.deviceName || input.device_name || input.name || id).trim(),
      status: String(input.status || "").trim(),
      isLocal: Boolean(input.isLocal),
      aliases: [...new Set([id, ...aliases])],
      capabilities: input.capabilities && typeof input.capabilities === "object" ? input.capabilities : {}
    };
  }

  function normalizedDeviceName(device = {}) {
    return String(device.deviceName || device.device_name || device.name || "").trim().toLowerCase();
  }

  function isSameLocalDevice(device, local) {
    if (!device || !local) return false;
    if (device.id === local.id) return true;
    const deviceName = normalizedDeviceName(device);
    const localName = normalizedDeviceName(local);
    return Boolean(deviceName && localName && deviceName === localName);
  }

  function mergeDeviceEngines(left = {}, right = {}) {
    const out = [];
    for (const source of [left, right]) {
      const engines = Array.isArray(source.capabilities?.engines) ? source.capabilities.engines : [];
      for (const engine of engines) {
        const id = String(engine || "").trim();
        if (id && !out.includes(id)) out.push(id);
      }
    }
    return out;
  }

  function mergeDevices(existing, incoming, options = {}) {
    if (!existing) return incoming;
    const local = options.local || null;
    const keepLocalIdentity = Boolean(local && (isSameLocalDevice(existing, local) || isSameLocalDevice(incoming, local)));
    const aliases = [...new Set([...(existing.aliases || []), existing.id, ...(incoming.aliases || []), incoming.id].filter(Boolean))];
    const engines = mergeDeviceEngines(existing, incoming);
    const status = keepLocalIdentity
      ? "local"
      : ([existing.status, incoming.status].includes("online") ? "online" : (incoming.status || existing.status || ""));
    return {
      ...existing,
      ...incoming,
      id: keepLocalIdentity ? local.id : (existing.id || incoming.id),
      deviceName: keepLocalIdentity ? local.deviceName : (incoming.deviceName || existing.deviceName),
      status,
      isLocal: keepLocalIdentity || Boolean(existing.isLocal || incoming.isLocal),
      aliases,
      capabilities: {
        ...(existing.capabilities || {}),
        ...(incoming.capabilities || {}),
        ...(engines.length ? { engines } : {})
      }
    };
  }

  function localDeviceOption(runtime = state?.runtime || {}) {
    return normalizedDevice({
      id: runtime.localDevice?.id || runtime.cloud?.deviceId || "",
      deviceName: runtime.localDevice?.name || runtime.cloud?.deviceName || "当前设备",
      status: "local",
      isLocal: true,
      capabilities: {
        engines: Object.entries({
          hermes: runtime.agentEngines?.hermes?.available || runtime.agentEngines?.hermes?.installed,
          "claude-code": runtime.agentEngines?.claudeCode?.available,
          codex: runtime.agentEngines?.codex?.available,
          openclaw: runtime.agentEngines?.openClaw?.available || runtime.agentEngines?.openClaw?.installed
        }).filter(([, ok]) => ok).map(([id]) => id)
      }
    });
  }

  function bridgeDeviceOptions() {
    const runtime = state?.runtime || {};
    const byId = new Map();
    const local = localDeviceOption(runtime);
    const add = (device) => {
      const normalized = normalizedDevice(device);
      if (!normalized) return;
      const key = isSameLocalDevice(normalized, local) ? local.id : normalized.id;
      byId.set(key, mergeDevices(byId.get(key), normalized, { local }));
    };
    for (const device of runtime.cloud?.devices || runtime.cloud?.bridgeDevices || []) add(device);
    add(local);
    return [...byId.values()];
  }

  function deviceStatusLabel(device = {}) {
    if (device.isLocal || device.status === "local") return "本机";
    if (device.status === "online") return "在线";
    if (device.status === "offline") return "离线";
    if (device.status) return device.status;
    return "本机";
  }

  function deviceEngineIds(device = {}) {
    const advertised = Array.isArray(device.capabilities?.engines)
      ? device.capabilities.engines.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    const supported = advertised.filter((id) => ["hermes", "claude-code", "codex", "openclaw"].includes(id));
    if (supported.length) return supported;
    const engine = String(device.engine || "").trim();
    return ["hermes", "claude-code", "codex", "openclaw"].includes(engine) ? [engine] : [];
  }

  function encodeRuntimeTarget(target = {}) {
    return JSON.stringify({
      runtimeKind: target.runtimeKind === "cloud-hermes" ? "cloud-hermes" : "desktop-local",
      deviceId: String(target.deviceId || "").trim(),
      deviceName: String(target.deviceName || "").trim(),
      agentEngine: String(target.agentEngine || "hermes").trim()
    });
  }

  function parseRuntimeTargetValue(value = "") {
    try {
      const parsed = JSON.parse(String(value || ""));
      const runtimeKind = parsed.runtimeKind === "cloud-hermes" ? "cloud-hermes" : "desktop-local";
      return {
        runtimeKind,
        targetDeviceId: runtimeKind === "cloud-hermes" ? "" : String(parsed.deviceId || "").trim(),
        targetDeviceName: runtimeKind === "cloud-hermes" ? "Mia Cloud" : String(parsed.deviceName || "").trim(),
        agentEngine: runtimeKind === "cloud-hermes" ? "hermes" : String(parsed.agentEngine || "hermes").trim()
      };
    } catch {
      return { runtimeKind: "desktop-local", targetDeviceId: "", targetDeviceName: "", agentEngine: "hermes" };
    }
  }

  function readSelectedRuntimeTarget() {
    const selected = parseRuntimeTargetValue(els?.botRuntimeTarget?.value || "");
    if (selected.runtimeKind === "cloud-hermes") return selected;
    const device = bridgeDeviceOptions().find((item) => item.id === selected.targetDeviceId || (item.aliases || []).includes(selected.targetDeviceId));
    return {
      ...selected,
      targetDeviceName: selected.targetDeviceName || (device ? runtimeDeviceDisplayName(device) : "") || compactDeviceName(state?.runtime?.localDevice?.name) || "当前设备"
    };
  }

  function runtimeTargetGroups(current = {}) {
    const groups = [];
    const cloudEnabled = Boolean(state?.runtime?.cloud?.enabled);
    if (cloudEnabled) {
      groups.push({
        label: "Mia Cloud · 在线",
        options: [{
          runtimeKind: "cloud-hermes",
          deviceId: "",
          deviceName: "Mia Cloud",
          agentEngine: "hermes",
          label: "Hermes"
        }]
      });
    }

    const devices = bridgeDeviceOptions();
    const wantedDeviceId = String(current.deviceId || "").trim();
    if (wantedDeviceId && !devices.some((device) => device.id === wantedDeviceId || (device.aliases || []).includes(wantedDeviceId))) {
      devices.push(normalizedDevice({
        id: wantedDeviceId,
        deviceName: current.deviceName || wantedDeviceId,
        status: "offline",
        capabilities: { engines: [current.agentEngine || "hermes"] }
      }));
    }

    for (const device of devices.filter(Boolean)) {
      const deviceName = runtimeDeviceDisplayName(device);
      const options = deviceEngineIds(device).map((engine) => ({
        runtimeKind: "desktop-local",
        deviceId: device.id,
        deviceName,
        agentEngine: engine,
        label: engineLabel(engine)
      }));
      if (!options.length) continue;
      groups.push({
        label: runtimeDeviceGroupLabel(device),
        options
      });
    }
    return groups;
  }

  function renderBotRuntimeTargetSelect(current = {}, options = {}) {
    if (!els?.botRuntimeTarget) return;
    const select = els.botRuntimeTarget;
    const previous = select.value;
    const currentDeviceId = String(current.deviceId || "").trim();
    const canonicalDevice = currentDeviceId
      ? bridgeDeviceOptions().find((device) => device.id === currentDeviceId || (device.aliases || []).includes(currentDeviceId))
      : null;
    const wanted = encodeRuntimeTarget(current.runtimeKind === "cloud-hermes"
      ? { runtimeKind: "cloud-hermes", agentEngine: "hermes" }
      : {
        runtimeKind: "desktop-local",
        deviceId: canonicalDevice?.id || current.deviceId || state?.runtime?.localDevice?.id || state?.runtime?.cloud?.deviceId || "",
        deviceName: canonicalDevice?.deviceName || current.deviceName || state?.runtime?.localDevice?.name || "当前设备",
        agentEngine: current.agentEngine || state?.preferredAgentEngine || "hermes"
      });
    const groups = runtimeTargetGroups(current);
    select.innerHTML = "";
    for (const group of groups) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      for (const option of group.options) {
        const node = document.createElement("option");
        node.value = encodeRuntimeTarget(option);
        node.textContent = option.label;
        optgroup.appendChild(node);
      }
      select.appendChild(optgroup);
    }
    const values = Array.from(select.options).map((option) => option.value);
    if (options.preservePrevious && previous && values.includes(previous)) select.value = previous;
    else if (values.includes(wanted)) select.value = wanted;
    else select.value = values[0] || "";
  }

  function detectedAgentEngineOptions() {
    return deviceEngineIds(bridgeDeviceOptions()[0] || {}).map((id) => ({ id, label: engineLabel(id) }));
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

  function openBotDialog(bot = null, personaText = "") {
    if (!state || !els) return;
    if (bot && bot.currentTarget) bot = null;
    // Allow a seed object in place of `bot` to prefill create mode (used by
    // initial-onboarding flow). Detected by absence of a real key.
    const seed = bot && !bot.key && (bot.name || bot.agentEngine || bot.bio) ? bot : null;
    const actualBot = seed ? null : bot;
    state.botMenuOpen = false;
    state.botDialogMode = actualBot ? "edit" : "create";
    state.botDialogOpen = true;
    const titleName = String(actualBot?.name || "").trim();
    if (els.botDialogTitle) els.botDialogTitle.textContent = actualBot
      ? `编辑「${titleName || "伙伴"}」`
      : (seed ? "创建你的第一个伙伴" : "添加伙伴");
    if (els.botKey) els.botKey.value = actualBot?.key || "";
    els.botName.value = actualBot?.name || seed?.name || "";
    if (els.botStatusBadge) els.botStatusBadge.value = window.miaStatusBadgeControls?.statusBadgePresetValue?.(actualBot?.statusBadge || actualBot?.status_badge) || "";
    const runtimeKind = window.miaBotDirectory?.normalizeRuntimeKind?.(
      actualBot?.runtimeKind || actualBot?.runtime_kind || seed?.runtimeKind,
      window.miaBotDirectory?.isCloudIdentityBot?.(actualBot) ? "cloud-hermes" : "desktop-local"
    ) || "desktop-local";
    renderBotRuntimeTargetSelect({
      runtimeKind,
      deviceId: actualBot?.targetDeviceId
        || actualBot?.target_device_id
        || actualBot?.deviceId
        || actualBot?.device_id
        || actualBot?.runtimeConfig?.deviceId
        || actualBot?.runtime_config?.deviceId
        || "",
      deviceName: actualBot?.targetDeviceName
        || actualBot?.target_device_name
        || actualBot?.deviceName
        || actualBot?.device_name
        || actualBot?.runtimeConfig?.deviceName
        || actualBot?.runtime_config?.deviceName
        || "",
      agentEngine: actualBot?.agentEngine || actualBot?.agent_engine || seed?.agentEngine || state.preferredAgentEngine || "hermes"
    });
    refreshBridgeDevicesForDialog();
    const avatarImage = actualBot?.avatarImage || "";
    setBotAvatarDraft(avatarImage, window.miaAvatar.avatarCropForImage(avatarImage, actualBot?.avatarCrop));
    // Canonical avatar identity of the bot being edited, so the preview's
    // background matches the hashed accent color shown everywhere else (create
    // mode has no id yet → the preview follows the name field).
    if (state.botAvatarDraft) {
      state.botAvatarDraft.identityId = actualBot
        ? (window.miaContact?.botAvatarIdentityId?.(actualBot.key || actualBot.id, actualBot) || actualBot.key || actualBot.id || "")
        : "";
      state.botAvatarDraft.color = actualBot?.color || actualBot?.avatarColor || "";
    }
    renderBotAvatarDraft();
    els.botSeed.value = actualBot ? personaText : (seed?.bio || "");
    if (els.botPersonaDetails) els.botPersonaDetails.open = Boolean(seed);
    renderView();
    window.miaStatusBadgeControls?.syncIdentityNameText?.("bot");
    window.miaStatusBadgeControls?.syncStatusBadgeControl?.("bot");
    if (!actualBot) {
      window.miaStatusBadgeControls?.beginIdentityNameEdit?.("bot");
    } else {
      window.miaStatusBadgeControls?.endIdentityNameEdit?.("bot");
    }
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
    state.botDialogOpen = false;
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
    detectedAgentEngineOptions,
    readSelectedRuntimeTarget,
    renderBotRuntimeTargetSelect,
    renderBotRuntimeLocationSelect,
    renderBotAgentEngineSelect,
    openBotDialog,
    closeBotDialog,
  };
})();
