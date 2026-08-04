// Typed controller adapters for the profile, Bot, and avatar-crop dialogs.
// React owns every dialog subtree; this module owns draft state and mutations.
(function () {
  "use strict";

  let state;
  let renderView;
  let render;
  let saveBotDialog;
  let openModelSettings;
  let botDraft = null;
  let profileDraft = null;
  let returnDialog = null;
  let botRuntimeHydrateToken = 0;
  let botDialogOpenToken = 0;
  let botRuntimeTargetOptionsToken = 0;
  let profileSaveTimer = 0;
  let profileSaveInFlight = false;
  let profileSaveRequested = false;
  let profileLastSaveSignature = "";

  function initBotDialog(deps) {
    state = deps.state;
    renderView = deps.renderView;
    render = deps.render;
    saveBotDialog = deps.saveBotDialog;
    openModelSettings = deps.openModelSettings;
  }

  function publish(dialog) {
    window.miaReactDialogs?.publish?.({ dialog });
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const text = String(value || "").trim();
      if (text) return text;
    }
    return "";
  }

  function palette() {
    return Array.isArray(window.miaMemberColor?.PALETTE)
      ? window.miaMemberColor.PALETTE
      : ["#5e5ce6", "#30b0c7", "#34c759", "#ff9f0a", "#ff3b30", "#af52de", "#007aff"];
  }

  function badgeChoices() {
    return (window.miaStatusBadgeAssets?.statusBadgeChoices?.({ includeEmpty: true }) || [
      { value: "", label: "无", badge: null }
    ]).map((choice) => ({
      badge: choice.badge || null,
      label: choice.label || "无",
      value: choice.value || ""
    }));
  }

  function statusBadgeValue(badge) {
    return window.miaStatusBadgeAssets?.statusBadgeValue?.(badge) || "";
  }

  function statusBadgeForValue(value) {
    return window.miaStatusBadgeAssets?.statusBadgeForValue?.(value) || null;
  }

  function avatarForDraft(draft, identityId, displayName) {
    return window.miaAvatarResolve.resolveAvatarForContact({
      id: identityId || displayName || "",
      displayName: displayName || "",
      avatarImage: draft?.image || "",
      avatarCrop: draft?.crop || null,
      color: draft?.color || ""
    });
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

  function profilePayload() {
    const name = String(profileDraft?.name || "").trim();
    return {
      displayName: name,
      avatarText: name ? window.miaAvatar.initials(name) : "",
      avatarImage: profileDraft?.avatar?.image || "",
      avatarCrop: window.miaAvatar.normalizeCrop(profileDraft?.avatar?.crop),
      avatarColor: profileDraft?.avatar?.color || "",
      statusBadge: statusBadgeForValue(profileDraft?.badgeValue || "")
    };
  }

  async function saveProfileNow() {
    if (profileSaveTimer) {
      window.clearTimeout(profileSaveTimer);
      profileSaveTimer = 0;
    }
    profileSaveRequested = true;
    if (profileSaveInFlight) return;
    profileSaveInFlight = true;
    try {
      while (profileSaveRequested) {
        profileSaveRequested = false;
        const payload = profilePayload();
        const signature = JSON.stringify(payload);
        if (signature === profileLastSaveSignature) continue;
        profileLastSaveSignature = signature;
        try {
          state.runtime = await window.mia.saveProfile(payload);
          render?.();
        } catch (error) {
          profileLastSaveSignature = "";
          console.error("[profile] save failed:", error);
        }
      }
    } finally {
      profileSaveInFlight = false;
    }
  }

  function scheduleProfileSave(delay = 520) {
    if (profileSaveTimer) window.clearTimeout(profileSaveTimer);
    profileSaveTimer = window.setTimeout(() => {
      profileSaveTimer = 0;
      saveProfileNow();
    }, delay);
  }

  function setProfileAvatarDraft(image, crop = null) {
    if (!state) return;
    const src = window.miaAvatar.canonicalAvatarSrc(image);
    const current = profileDraft?.avatar || state.profileAvatarDraft || {};
    const avatar = {
      image: src,
      crop: src ? window.miaAvatar.normalizeCrop(crop || window.miaAvatar.avatarDefaultCropForSrc(src)) : null,
      color: current.color || ""
    };
    state.profileAvatarDraft = avatar;
    if (profileDraft) profileDraft.avatar = avatar;
    if (state.profileDialogOpen && !state.avatarCropEditor?.open) publishProfileDialog();
  }

  function publishProfileDialog() {
    if (!profileDraft || !state?.profileDialogOpen) return;
    const avatar = avatarForDraft(profileDraft.avatar, profileDraft.uid, profileDraft.name);
    publish({
      avatar,
      badgeChoices: badgeChoices(),
      badgeValue: profileDraft.badgeValue,
      chooseAvatar: readProfileAvatarFile,
      close: closeProfileDialog,
      color: profileDraft.avatar.color || "",
      colors: palette(),
      kind: "profile",
      name: profileDraft.name,
      openAvatarEditor: () => {
        if (profileDraft.avatar.image) {
          openAvatarCropEditor(profileDraft.avatar.image, profileDraft.avatar.crop, "profile");
        }
      },
      setBadge: (value) => {
        profileDraft.badgeValue = value;
        publishProfileDialog();
        saveProfileNow();
      },
      setColor: (value) => {
        profileDraft.avatar.color = value;
        state.profileAvatarDraft = { ...profileDraft.avatar };
        publishProfileDialog();
        saveProfileNow();
      },
      setName: (value) => {
        profileDraft.name = value;
        publishProfileDialog();
        scheduleProfileSave();
      },
      uid: profileDraft.uid || "未登录"
    });
  }

  function openProfileDialog() {
    if (!state) return;
    const user = currentProfileUser();
    state.profileDialogOpen = true;
    state.botDialogOpen = false;
    profileDraft = {
      avatar: {
        color: user.avatarColor || "",
        crop: user.avatarCrop || null,
        image: window.miaAvatar.canonicalAvatarSrc(user.avatarImage || "")
      },
      badgeValue: statusBadgeValue(user.statusBadge),
      name: user.displayName || "",
      uid: user.id || ""
    };
    state.profileAvatarDraft = { ...profileDraft.avatar };
    profileLastSaveSignature = JSON.stringify(profilePayload());
    publishProfileDialog();
    renderView?.();
  }

  function closeProfileDialog() {
    if (!state) return;
    state.profileDialogOpen = false;
    if (profileSaveTimer) {
      window.clearTimeout(profileSaveTimer);
      profileSaveTimer = 0;
      saveProfileNow();
    }
    publish({ kind: "closed" });
    renderView?.();
  }

  function renderProfileAvatarDraft() {
    if (state?.profileDialogOpen && !state.avatarCropEditor?.open) publishProfileDialog();
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
      agentEngine: isCloud ? strictAgentEngine(target.agentEngine) : String(target.agentEngine || "").trim()
    });
  }

  function parseRuntimeTargetValue(value = "") {
    try {
      const parsed = JSON.parse(String(value || ""));
      const runtimeKind = String(parsed.runtimeKind || "").trim() === "cloud-claude-code"
        ? "cloud-claude-code"
        : "desktop-local";
      return {
        runtimeKind,
        targetDeviceId: runtimeKind === "cloud-claude-code" ? "" : String(parsed.deviceId || "").trim(),
        targetDeviceName: runtimeKind === "cloud-claude-code" ? "Mia Cloud" : String(parsed.deviceName || "").trim(),
        agentEngine: runtimeKind === "cloud-claude-code"
          ? strictAgentEngine(parsed.agentEngine)
          : String(parsed.agentEngine || "").trim()
      };
    } catch {
      return { runtimeKind: "desktop-local", targetDeviceId: "", targetDeviceName: "", agentEngine: "" };
    }
  }

  function readSelectedRuntimeTarget() {
    return parseRuntimeTargetValue(botDraft?.runtimeValue || "");
  }

  function runtimeTargetFromBinding(binding = {}) {
    const config = binding.config && typeof binding.config === "object" ? binding.config : {};
    const runtimeKind = window.miaBotDirectory?.normalizeRuntimeKind?.(
      binding.runtimeKind || binding.runtime_kind,
      "cloud-claude-code"
    ) || "cloud-claude-code";
    if (runtimeKind === "cloud-claude-code") {
      return {
        runtimeKind: "cloud-claude-code",
        deviceId: "",
        deviceName: "Mia Cloud",
        agentEngine: strictAgentEngine(binding.agentEngine || binding.agent_engine || config.agentEngine || config.agent_engine)
          || cloudAgentRuntime().agentEngine
      };
    }
    return {
      runtimeKind: "desktop-local",
      deviceId: String(binding.targetDeviceId || binding.target_device_id || config.deviceId || config.device_id || config.targetDeviceId || "").trim(),
      deviceName: String(binding.targetDeviceName || binding.target_device_name || config.deviceName || config.device_name || "").trim(),
      agentEngine: window.miaBotDirectory?.normalizeAgentEngine?.(
        binding.agentEngine || binding.agent_engine || config.agentEngine || config.agent_engine || "hermes",
        "desktop-local"
      ) || "hermes"
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
    if (botDraft && state?.botDialogOpen) {
      botDraft.runtimeOptionsLoaded = false;
      botDraft.runtimeLoading = true;
      botDraft.runtimeLoadError = "";
    }
  }

  function runtimeTargetBotSnapshot(current = {}) {
    const runtimeKind = String(current.runtimeKind || "").trim() === "cloud-claude-code"
      ? "cloud-claude-code"
      : "desktop-local";
    const deviceId = runtimeKind === "cloud-claude-code"
      ? ""
      : String(current.deviceId || current.targetDeviceId || "").trim();
    const deviceName = runtimeKind === "cloud-claude-code"
      ? "Mia Cloud"
      : String(current.deviceName || current.targetDeviceName || "").trim();
    const agentEngine = runtimeKind === "cloud-claude-code"
      ? strictAgentEngine(current.agentEngine || cloudAgentRuntime().agentEngine)
      : String(current.agentEngine || state?.preferredAgentEngine || "hermes").trim();
    const key = String(botDraft?.key || "").trim();
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
    const runtimeKind = String(option.runtimeKind || option.runtime_kind || "").trim() === "cloud-claude-code"
      ? "cloud-claude-code"
      : "desktop-local";
    const agentEngine = runtimeKind === "cloud-claude-code"
      ? strictAgentEngine(option.agentEngine || option.agent_engine || cloudAgentRuntime().agentEngine)
      : String(option.agentEngine || option.agent_engine || "").trim();
    const deviceId = runtimeKind === "cloud-claude-code" ? "" : String(option.deviceId || option.device_id || "").trim();
    const localDevice = state?.runtime?.localDevice || {};
    const isCurrentDevice = runtimeKind === "desktop-local"
      && deviceId
      && deviceId === String(localDevice.id || "").trim();
    const deviceName = runtimeKind === "cloud-claude-code"
      ? "Mia Cloud"
      : (isCurrentDevice
        ? String(localDevice.name || localDevice.deviceName || localDevice.device_name || option.deviceName || option.device_name || "").trim()
        : String(option.deviceName || option.device_name || "").trim());
    return {
      runtimeKind,
      deviceId,
      deviceName,
      agentEngine,
      label: String(option.label || option.engineLabel || option.engine_label || engineLabel(agentEngine) || "Agent").trim(),
      selected: Boolean(option.selected),
      disabled: Boolean(option.disabled),
      disabledReason: String(option.disabledReason || option.disabled_reason || "").trim()
    };
  }

  function normalizeCoreRuntimeGroup(group = {}) {
    const options = Array.isArray(group.options) ? group.options.map(normalizeCoreRuntimeOption) : [];
    const localDevice = state?.runtime?.localDevice || {};
    const localDeviceId = String(localDevice.id || "").trim();
    const localOption = options.find((option) => option.runtimeKind === "desktop-local" && option.deviceId === localDeviceId);
    const label = String(localOption?.deviceName || group.label || "运行目标").trim();
    const status = String(group.statusLabel || group.status_label || "").trim();
    return {
      label: status && status !== label ? `${label} · ${status}` : label,
      options
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
    const socialState = window.miaSocial?.moduleState;
    if (!nextBot || !socialState || !Array.isArray(socialState.bots)) return;
    socialState.bots = [
      nextBot,
      ...socialState.bots.filter((item) => String(item?.key || item?.id || "") !== nextBot.key)
    ];
  }

  async function hydrateActiveRuntimeTargetForDialog(bot = {}) {
    const key = String(bot?.key || bot?.id || "").trim();
    if (!key || typeof window.miaBotCommands?.getBotRuntimeBinding !== "function") return;
    const token = ++botRuntimeHydrateToken;
    try {
      const binding = await window.miaBotCommands.getBotRuntimeBinding({
        api: window.mia,
        botKey: key,
        runtimeKind: "active"
      });
      if (!binding || binding.enabled === false || token !== botRuntimeHydrateToken) return;
      if (!state?.botDialogOpen || botDraft?.key !== key) return;
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
        agentEngine: "",
        label: "同步运行目标...",
        disabled: true,
        disabledReason: ""
      }]
    }];
  }

  function deferBotDialogWork(callback) {
    const timer = typeof window?.setTimeout === "function" ? window.setTimeout.bind(window) : setTimeout;
    timer(callback, 0);
  }

  function markRuntimeTargetLoadFailed(current = {}) {
    if (!botDraft || !state?.botDialogOpen) return;
    botDraft.runtimeOptionsLoaded = true;
    botDraft.runtimeLoading = false;
    botDraft.runtimeLoadError = "无法读取本机 Agent 状态，请稍后重试。";
    botDraft.localAgentSetupRequired = false;
    botDraft.runtimeSetupRequired = true;
    botDraft.runtimeGroups = [{
      label: "运行目标",
      options: [{ disabled: true, label: "暂时无法读取 Agent 状态", title: "", value: "" }]
    }];
    botDraft.runtimeValue = "";
    publishBotDialog();
  }

  function retryRuntimeTargetOptions() {
    if (!botDraft || !state?.botDialogOpen) return;
    botRuntimeTargetOptionsToken += 1;
    state?.botDialogRuntimeTargetOptionsLoading?.clear?.();
    botDraft.runtimeOptionsLoaded = false;
    botDraft.runtimeLoading = true;
    botDraft.runtimeLoadError = "";
    botDraft.runtimeGroups = [];
    botDraft.runtimeSetupRequired = false;
    publishBotDialog();
    loadRuntimeTargetOptionsForDialog(botDraft.runtimeTargetCurrent || {}, { retry: true });
  }

  function loadRuntimeTargetOptionsForDialog(current = {}, config = {}) {
    if (config.skipCoreLoad) return;
    const api = window.mia?.social?.getBotRuntimeTargetOptions;
    if (typeof api !== "function") {
      markRuntimeTargetLoadFailed(current);
      return;
    }
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
          if (!Array.isArray(data.groups)) {
            throw new Error("invalid runtime target options");
          }
          cache.set(key, data);
          if (!state?.botDialogOpen || token !== botRuntimeTargetOptionsToken) return;
          botDraft.runtimeOptionsLoaded = true;
          botDraft.runtimeLoadError = "";
          renderBotRuntimeTargetSelect(current, { preservePrevious: true, skipCoreLoad: true });
        })
        .catch((error) => {
          if (state?.botDialogOpen && token === botRuntimeTargetOptionsToken && botDraft) {
            markRuntimeTargetLoadFailed(current);
          }
          console.warn("[bot-dialog] runtime target options load failed:", error?.message || error);
        })
        .finally(() => loading.delete(key));
    });
  }

  function renderBotRuntimeTargetSelect(current = {}, config = {}) {
    if (!botDraft) return;
    botDraft.runtimeTargetCurrent = { ...current };
    if (!config.skipCoreLoad
      && !dialogRuntimeTargetOptionsCache().has(runtimeTargetOptionsKey(current))) {
      botDraft.runtimeOptionsLoaded = false;
    }
    const previous = botDraft.runtimeValue;
    const cloudRuntime = cloudAgentRuntime();
    const groups = runtimeTargetGroups(current);
    const coreOptions = groups.flatMap((group) => group.options || []);
    const currentRuntimeKind = current.runtimeKind === "cloud-claude-code" ? "cloud-claude-code" : "desktop-local";
    const currentDeviceId = currentRuntimeKind === "cloud-claude-code"
      ? ""
      : String(current.deviceId || current.targetDeviceId || "").trim();
    const currentAgentEngine = currentRuntimeKind === "cloud-claude-code"
      ? strictAgentEngine(current.agentEngine || cloudRuntime.agentEngine)
      : String(current.agentEngine || state?.preferredAgentEngine || "hermes").trim();
    const targetsCurrentBinding = (option) => (
      option.runtimeKind === currentRuntimeKind
      && (currentRuntimeKind === "cloud-claude-code" || !currentDeviceId || option.deviceId === currentDeviceId)
    );
    const matching = coreOptions.find((option) => (
      targetsCurrentBinding(option) && (!currentAgentEngine || option.agentEngine === currentAgentEngine)
    ));
    const selected = coreOptions.find((option) => option.selected && targetsCurrentBinding(option));
    const wanted = encodeRuntimeTarget(matching || selected || (
      currentRuntimeKind === "cloud-claude-code"
        ? { runtimeKind: "cloud-claude-code", agentEngine: currentAgentEngine || cloudRuntime.agentEngine }
        : {
            runtimeKind: "desktop-local",
            deviceId: currentDeviceId || "current-device",
            deviceName: current.deviceName || current.targetDeviceName || "当前设备",
            agentEngine: currentAgentEngine
          }
    ));
    const runtimeGroups = groups.map((group) => ({
      label: group.label,
      options: group.options.map((option) => ({
        disabled: Boolean(option.disabled),
        label: option.label,
        title: option.disabledReason || "",
        value: encodeRuntimeTarget(option)
      }))
    })).filter((group) => group.options.length);
    let runtimeOptions = runtimeGroups.flatMap((group) => group.options);
    let values = runtimeOptions.map((option) => option.value);
    const currentEngineAvailable = coreOptions.some((option) => (
      !option.disabled && option.agentEngine === currentAgentEngine
    ));
    if (wanted && !values.includes(wanted) && currentEngineAvailable) {
      runtimeGroups.push({
        label: currentRuntimeKind === "cloud-claude-code"
          ? "Mia Cloud · 当前绑定"
          : `${String(current.deviceName || current.targetDeviceName || currentDeviceId || "设备").trim()} · 当前绑定`,
        options: [{
          disabled: false,
          label: engineLabel(currentAgentEngine) || "当前绑定",
          title: "",
          value: wanted
        }]
      });
      runtimeOptions = runtimeGroups.flatMap((group) => group.options);
      values = runtimeOptions.map((option) => option.value);
    }
    const enabledValues = runtimeOptions.filter((option) => !option.disabled).map((option) => option.value);
    const localAgentAvailable = coreOptions.some((option) => (
      option.runtimeKind === "desktop-local" && !option.disabled
    ));
    const inventoryScanning = Boolean(state?.runtime?.agentInventory?.summary?.scanning);
    botDraft.runtimeGroups = runtimeGroups;
    botDraft.runtimeLoading = !botDraft.runtimeOptionsLoaded || (inventoryScanning && !localAgentAvailable);
    botDraft.localAgentSetupRequired = botDraft.runtimeOptionsLoaded
      && !inventoryScanning
      && !localAgentAvailable;
    botDraft.runtimeSetupRequired = botDraft.runtimeOptionsLoaded
      && !inventoryScanning
      && enabledValues.length === 0;
    botDraft.runtimeValue = !botDraft.runtimeOptionsLoaded
      ? wanted
      : (config.preservePrevious && previous && enabledValues.includes(previous)
        ? previous
        : (enabledValues.includes(wanted) ? wanted : (enabledValues[0] || "")));
    publishBotDialog();
    loadRuntimeTargetOptionsForDialog(current, config);
  }

  function renderBotRuntimeLocationSelect(current = "desktop-local") {
    renderBotRuntimeTargetSelect({ runtimeKind: current });
  }

  function renderBotRuntimeDeviceSelect(current = "") {
    renderBotRuntimeTargetSelect({ runtimeKind: "desktop-local", deviceId: current });
  }

  function renderBotAgentEngineSelect(current = "hermes") {
    const parsed = readSelectedRuntimeTarget();
    renderBotRuntimeTargetSelect({
      runtimeKind: parsed.runtimeKind,
      deviceId: parsed.targetDeviceId,
      deviceName: parsed.targetDeviceName,
      agentEngine: current
    });
  }

  function setBotAvatarDraft(image, crop = null) {
    if (!state) return;
    const src = window.miaAvatar.canonicalAvatarSrc(image);
    const current = botDraft?.avatar || state.botAvatarDraft || {};
    const avatar = {
      image: src,
      crop: src ? window.miaAvatar.normalizeCrop(crop || window.miaAvatar.avatarDefaultCropForSrc(src)) : null,
      color: current.color || "",
      identityId: current.identityId || ""
    };
    state.botAvatarDraft = avatar;
    if (botDraft) botDraft.avatar = avatar;
    if (state.botDialogOpen && !state.avatarCropEditor?.open) publishBotDialog();
  }

  async function submitBotDraft() {
    if (!botDraft || typeof saveBotDialog !== "function") return "伙伴保存器未初始化";
    if (botDraft.runtimeLoading) return "正在检测本机 Agent，请稍后再试。";
    if (botDraft.runtimeSetupRequired || !botDraft.runtimeValue) {
      return "请先前往“设置 → 模型”启用并选择可用的 Agent。";
    }
    try {
      const error = await saveBotDialog({
        avatar: { ...botDraft.avatar },
        badgeValue: botDraft.badgeValue,
        key: botDraft.key,
        mode: botDraft.mode,
        name: botDraft.name,
        persona: botDraft.persona,
        runtime: readSelectedRuntimeTarget()
      });
      if (error) return String(error);
      closeBotDialog();
      return "";
    } catch (error) {
      console.error("Failed to save bot", error);
      return `保存伙伴失败：${error?.message || error}`;
    }
  }

  function publishBotDialog() {
    if (!botDraft || !state?.botDialogOpen) return;
    publish({
      avatar: avatarForDraft(botDraft.avatar, botDraft.avatar.identityId || botDraft.key, botDraft.name || "Bot"),
      badgeChoices: badgeChoices(),
      badgeValue: botDraft.badgeValue,
      chooseAvatar: readBotAvatarFile,
      close: closeBotDialog,
      color: botDraft.avatar.color || "",
      colors: palette(),
      key: botDraft.key,
      kind: "bot",
      mode: botDraft.mode,
      name: botDraft.name,
      openAvatarEditor: () => {
        if (botDraft.avatar.image) openAvatarCropEditor(botDraft.avatar.image, botDraft.avatar.crop, "bot");
      },
      persona: botDraft.persona,
      personaOpen: botDraft.personaOpen,
      localAgentSetupRequired: botDraft.localAgentSetupRequired,
      openModelSettings: () => {
        closeBotDialog();
        openModelSettings?.();
      },
      retryRuntime: retryRuntimeTargetOptions,
      runtimeGroups: botDraft.runtimeGroups,
      runtimeLoadError: botDraft.runtimeLoadError,
      runtimeLoading: botDraft.runtimeLoading,
      runtimeSetupRequired: botDraft.runtimeSetupRequired,
      runtimeValue: botDraft.runtimeValue,
      setBadge: (value) => {
        botDraft.badgeValue = value;
        publishBotDialog();
      },
      setColor: (value) => {
        botDraft.avatar.color = value;
        state.botAvatarDraft = { ...botDraft.avatar };
        publishBotDialog();
      },
      setName: (value) => {
        botDraft.name = value;
        publishBotDialog();
      },
      setPersona: (value) => {
        botDraft.persona = value;
        publishBotDialog();
      },
      setPersonaOpen: (open) => {
        if (botDraft.personaOpen === open) return;
        botDraft.personaOpen = open;
        publishBotDialog();
      },
      setRuntime: (value) => {
        botDraft.runtimeValue = value;
        publishBotDialog();
      },
      submit: submitBotDraft,
      title: botDraft.title
    });
  }

  function openBotDialog(bot = null, personaText = "") {
    if (!state) return;
    if (bot && bot.currentTarget) bot = null;
    const botKey = firstNonEmpty(bot?.key, bot?.id);
    const seed = bot && !botKey && (bot.name || bot.agentEngine || bot.bio || bot.personaText || bot.persona_text)
      ? bot
      : null;
    const actualBot = seed ? null : (botKey ? bot : null);
    state.botMenuOpen = false;
    state.contactMenuOpen = false;
    state.profileDialogOpen = false;
    state.botDialogMode = actualBot ? "edit" : "create";
    state.botDialogOpen = true;
    clearDialogRuntimeTargetOptions();
    const avatarSrc = window.miaAvatar.canonicalAvatarSrc(actualBot?.avatarImage || "");
    const avatar = {
      image: avatarSrc,
      crop: avatarSrc
        ? window.miaAvatar.normalizeCrop(window.miaAvatar.avatarCropForImage(avatarSrc, actualBot?.avatarCrop))
        : null,
      color: actualBot?.color || actualBot?.avatarColor || "",
      identityId: actualBot
        ? (window.miaContact?.botAvatarIdentityId?.(botKey, actualBot) || botKey)
        : ""
    };
    state.botAvatarDraft = { ...avatar };
    botDraft = {
      avatar,
      badgeValue: statusBadgeValue(actualBot?.statusBadge || actualBot?.status_badge),
      key: firstNonEmpty(actualBot?.key, actualBot?.id),
      mode: actualBot ? "edit" : "create",
      name: actualBot?.name || seed?.name || "",
      persona: actualBot ? personaText : (seed?.personaText || seed?.persona_text || seed?.bio || ""),
      personaOpen: Boolean(seed),
      localAgentSetupRequired: false,
      runtimeGroups: [],
      runtimeLoadError: "",
      runtimeLoading: true,
      runtimeOptionsLoaded: false,
      runtimeSetupRequired: false,
      runtimeTargetCurrent: null,
      runtimeValue: "",
      title: actualBot
        ? `编辑「${String(actualBot.name || "").trim() || "伙伴"}」`
        : (seed ? "创建你的第一个伙伴" : "添加伙伴")
    };
    const runtimeKind = window.miaBotDirectory?.normalizeRuntimeKind?.(
      actualBot?.runtimeKind || actualBot?.runtime_kind || seed?.runtimeKind,
      actualBot && window.miaBotDirectory?.isCloudIdentityBot?.(actualBot) ? "cloud-claude-code" : "desktop-local"
    ) || "desktop-local";
    const initialRuntimeTarget = {
      runtimeKind,
      deviceId: actualBot?.targetDeviceId || actualBot?.target_device_id || actualBot?.deviceId || actualBot?.device_id || "",
      deviceName: actualBot?.targetDeviceName || actualBot?.target_device_name || actualBot?.deviceName || actualBot?.device_name || "",
      agentEngine: actualBot?.agentEngine || actualBot?.agent_engine || seed?.agentEngine || state.preferredAgentEngine || "hermes"
    };
    botDraft.runtimeTargetCurrent = { ...initialRuntimeTarget };
    botDraft.runtimeValue = encodeRuntimeTarget(initialRuntimeTarget);
    const openToken = ++botDialogOpenToken;
    const openedKey = botDraft.key;
    const openedMode = botDraft.mode;
    publishBotDialog();
    renderView?.();
    deferBotDialogWork(() => {
      if (openToken !== botDialogOpenToken || !state?.botDialogOpen) return;
      if (botDraft?.key !== openedKey || botDraft?.mode !== openedMode) return;
      try {
        renderBotRuntimeTargetSelect(initialRuntimeTarget);
      } catch (error) {
        markRuntimeTargetLoadFailed(initialRuntimeTarget);
        console.warn("[bot-dialog] runtime target setup failed:", error?.message || error);
      }
      refreshBridgeDevicesForDialog();
      if (actualBot) hydrateActiveRuntimeTargetForDialog(actualBot);
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
          cloud: { ...(state.runtime?.cloud || {}), devices }
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
    botDraft = null;
    state.botAvatarDraft = { image: "", crop: null, color: "", identityId: "" };
    publish({ kind: "closed" });
    renderView?.();
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
      openAvatarCropEditor(
        String(reader.result || ""),
        isVideo ? { x: 50, y: 50, zoom: 1, start: 0, duration: 3 } : { x: 50, y: 50, zoom: 1.12 },
        target
      );
    });
    reader.readAsDataURL(file);
  }

  function readBotAvatarFile(file) {
    readAvatarFile(file, "bot");
  }

  function readProfileAvatarFile(file) {
    readAvatarFile(file, "profile");
  }

  function publishAvatarCropDialog() {
    const editor = state?.avatarCropEditor;
    if (!editor?.open) return;
    publish({
      close: closeAvatarCropEditor,
      confirm: confirmAvatarCropEditor,
      crop: editor.crop,
      image: window.miaAvatar.avatarImageSrc(editor.image) || editor.image || "",
      isVideo: Boolean(window.miaAvatarMedia?.isVideo?.(editor.image)),
      kind: "avatar-crop",
      reset: () => {
        editor.crop = window.miaAvatar.normalizeCrop(window.miaAvatar.avatarDefaultCropForSrc(editor.image));
        publishAvatarCropDialog();
      },
      update: updateAvatarCropEditor
    });
  }

  function openAvatarCropEditor(image, crop = null, target = "bot") {
    if (!state) return;
    const src = window.miaAvatar.canonicalAvatarSrc(image);
    const currentDialog = window.miaReactDialogs?.current?.()?.dialog;
    if (currentDialog?.kind && currentDialog.kind !== "avatar-crop" && currentDialog.kind !== "closed") {
      returnDialog = currentDialog;
    }
    state.avatarCropEditor = {
      open: true,
      target,
      image: src,
      crop: window.miaAvatar.normalizeCrop(crop || window.miaAvatar.avatarDefaultCropForSrc(src)),
      dragging: false,
      lastX: 0,
      lastY: 0
    };
    publishAvatarCropDialog();
    renderView?.();
  }

  function restoreDialogAfterCrop(target) {
    if (target === "profile" && state.profileDialogOpen) publishProfileDialog();
    else if (target === "bot" && state.botDialogOpen) publishBotDialog();
    else if (returnDialog) publish(returnDialog);
    else publish({ kind: "closed" });
    returnDialog = null;
  }

  function closeAvatarCropEditor() {
    if (!state?.avatarCropEditor) return;
    const target = state.avatarCropEditor.target;
    state.avatarCropEditor.open = false;
    state.avatarCropEditor.dragging = false;
    restoreDialogAfterCrop(target);
    renderView?.();
  }

  function updateAvatarCropEditor(crop) {
    if (!state?.avatarCropEditor) return;
    state.avatarCropEditor.crop = window.miaAvatar.normalizeCrop({
      ...state.avatarCropEditor.crop,
      ...crop
    });
    publishAvatarCropDialog();
  }

  async function confirmAvatarCropEditor() {
    const editor = state?.avatarCropEditor;
    if (!editor?.open) return;
    const { target, image, crop } = editor;
    if (target === "groupConversation") {
      closeAvatarCropEditor();
      await window.miaGroupInfoDialog?.applyAvatarFromCropEditor?.(image, crop);
      return;
    }
    if (target === "profile") {
      setProfileAvatarDraft(image, crop);
      await saveProfileNow();
    } else {
      setBotAvatarDraft(image, crop);
    }
    closeAvatarCropEditor();
  }

  function renderBotAvatarDraft() {
    if (state?.botDialogOpen && !state.avatarCropEditor?.open) publishBotDialog();
  }

  function renderAvatarCropEditor() {
    publishAvatarCropDialog();
  }

  window.miaBotDialog = {
    closeAvatarCropEditor,
    closeBotDialog,
    closeProfileDialog,
    initBotDialog,
    openAvatarCropEditor,
    openBotDialog,
    openProfileDialog,
    readBotAvatarFile,
    readProfileAvatarFile,
    readSelectedRuntimeTarget,
    renderAvatarCropEditor,
    renderBotAgentEngineSelect,
    renderBotAvatarDefaults() {},
    renderBotAvatarDraft,
    renderBotRuntimeDeviceSelect,
    renderBotRuntimeLocationSelect,
    renderBotRuntimeTargetSelect,
    renderProfileAvatarDefaults() {},
    renderProfileAvatarDraft,
    setBotAvatarDraft,
    setProfileAvatarDraft,
    updateAvatarCropEditor,
    updateAvatarTrimControls: publishAvatarCropDialog
  };
})();
