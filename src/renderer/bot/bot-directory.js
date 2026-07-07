(function (global) {
  "use strict";

  const avatarResolve = (typeof globalThis !== "undefined" && globalThis.miaAvatarResolve)
    || (typeof require === "function" ? require("../../shared/avatar-resolve.js") : { normalizeAvatarImage: (v) => String(v || "") });
  const botIdentity = (typeof globalThis !== "undefined" && globalThis.miaBotIdentity)
    || (typeof require === "function" ? require("../../shared/bot-identity.js") : {
      normalizeBotColor: (v) => {
        const value = String(v || "").trim().toLowerCase();
        return /^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/.test(value) ? value : "";
      }
    });

  function firstNonEmpty(...values) {
    for (const value of values) {
      const next = String(value || "").trim();
      if (next) return next;
    }
    return "";
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

  function botKey(input = {}) {
    return String(input.key || input.id || input.botKey || input.bot_id || "").trim();
  }

  function sourceKinds(input = {}) {
    const raw = Array.isArray(input.sourceKinds)
      ? input.sourceKinds
      : (input.sourceKind || input.source_kind ? [input.sourceKind || input.source_kind] : []);
    return [...new Set(raw.map((item) => String(item || "").trim()).filter(Boolean))];
  }

  function hasSourceKind(input = {}, kind = "") {
    const wanted = String(kind || "").trim();
    return Boolean(wanted && sourceKinds(input).includes(wanted));
  }

  function isCloudIdentityBot(input = {}) {
    return hasSourceKind(input, "cloud")
      || String(input.runtimeKind || input.runtime_kind || "").trim() === "cloud-claude-code";
  }

  function isCloudRuntimeKind(value = "") {
    return String(value || "").trim() === "cloud-claude-code";
  }

  function normalizeRuntimeKind(value, fallback = "desktop-local") {
    const raw = String(value || "").trim();
    if (raw === "cloud-claude-code") return "cloud-claude-code";
    if (raw === "desktop-local") return "desktop-local";
    return fallback === "cloud-claude-code" ? "cloud-claude-code" : "desktop-local";
  }

  function strictAgentEngine(value = "") {
    const strict = global.miaCloudRuntime?.normalizeAgentEngineStrict?.(value);
    if (strict) return strict;
    const id = String(value || "").trim().toLowerCase().replace(/_/g, "-");
    if (id === "claude" || id === "claude-code") return "claude-code";
    if (id === "codex" || id === "openai-codex") return "codex";
    if (id === "hermes") return "hermes";
    return "";
  }

  function cloudAgentEngine(runtime = {}) {
    return global.miaCloudRuntime?.cloudAgentRuntimeFromCloud?.(runtime.cloud || runtime)?.agentEngine || "";
  }

  function normalizeAgentEngine(value, runtimeKind = "desktop-local", runtime = {}) {
    if (runtimeKind === "cloud-claude-code") return strictAgentEngine(value) || cloudAgentEngine(runtime);
    const id = String(value || "hermes").trim().toLowerCase().replace(/_/g, "-");
    const normalizer = global.miaEngineContracts?.normalizeAgentEngine;
    if (typeof normalizer === "function") return normalizer(value);
    if (id === "claude" || id === "claude-code") return "claude-code";
    if (id === "codex" || id === "openai-codex") return "codex";
    return "hermes";
  }

  function isDefaultSourceBio(value) {
    const text = String(value || "").trim();
    return text === "云端 Agent" || text === "云端伙伴" || text === "本地伙伴";
  }

  function normalizedBio(input = {}) {
    const raw = firstNonEmpty(input.bio, input.description);
    return isDefaultSourceBio(raw) ? "" : raw;
  }

  function runtimeDeviceById(runtime = {}, deviceId = "") {
    const wanted = String(deviceId || "").trim();
    if (!wanted) return null;
    const devices = [
      ...(Array.isArray(runtime.cloud?.devices) ? runtime.cloud.devices : []),
      ...(Array.isArray(runtime.cloud?.bridgeDevices) ? runtime.cloud.bridgeDevices : [])
    ];
    return devices.find((device) => (
      String(device?.id || "") === wanted
        || String(device?.deviceId || "") === wanted
    )) || null;
  }

  function isCurrentRuntimeDevice(runtime = {}, deviceId = "") {
    const wanted = String(deviceId || "").trim();
    if (!wanted) return false;
    return [
      runtime.localDevice?.id,
      runtime.cloud?.deviceId
    ].some((id) => String(id || "").trim() === wanted);
  }

  function deviceStatusText(device = {}) {
    const status = String(device.status || "").trim();
    if (status === "online") return "在线";
    if (status === "offline") return "离线";
    if (status === "local") return "本机";
    return status || "";
  }

  function runtimeLabelFor(bot = {}, runtime = {}) {
    const runtimeConfig = bot.runtimeConfig || bot.runtime_config || bot.config || {};
    const runtimeKind = normalizeRuntimeKind(
      bot.runtimeKind || bot.runtime_kind || bot.runtime?.kind || runtimeConfig.runtimeKind || runtimeConfig.runtime_kind,
      bot.sourceKind === "cloud" ? "cloud-claude-code" : "desktop-local"
    );
    if (runtimeKind === "cloud-claude-code") return "Mia Cloud";
    const targetDeviceId = firstNonEmpty(
      bot.targetDeviceId,
      bot.target_device_id,
      bot.deviceId,
      bot.device_id,
      runtimeConfig.deviceId,
      runtimeConfig.device_id
    );
    if (!targetDeviceId) return "运行设备未配置";
    if (isCurrentRuntimeDevice(runtime, targetDeviceId)) return "本机运行";
    const matchedDevice = runtimeDeviceById(runtime, targetDeviceId);
    if (matchedDevice) {
      const name = compactDeviceName(firstNonEmpty(
        matchedDevice.deviceName,
        matchedDevice.device_name,
        matchedDevice.name,
        bot.targetDeviceName,
        bot.target_device_name,
        bot.deviceName,
        bot.device_name,
        runtimeConfig.deviceName,
        runtimeConfig.device_name,
        targetDeviceId
      )) || "远程设备";
      const status = deviceStatusText(matchedDevice);
      return status ? `${name} · ${status}` : name;
    }
    if (bot.runtimeStatus === "stale_device" || bot.runtime_status === "stale_device") return "运行设备已失效";
    return compactDeviceName(firstNonEmpty(
      bot.runtimeLabel,
      bot.runtime_label,
      bot.deviceName,
      bot.device_name,
      runtimeConfig.deviceName,
      runtimeConfig.device_name,
      bot.sourceDeviceName,
      bot.source_device_name,
      bot.hostname,
      runtime.localDevice?.name,
      runtime.cloud?.deviceName,
      runtime.relay?.deviceName,
      "当前设备"
    )) || "当前设备";
  }

  function normalizeOwnedBot(input = {}, options = {}) {
    if (!input || typeof input !== "object") return null;
    const key = botKey(input);
    if (!key) return null;
    const sourceKind = options.sourceKind || input.sourceKind || input.source_kind || "desktop";
    const fallbackRuntimeKind = sourceKind === "cloud" ? "cloud-claude-code" : "desktop-local";
    const runtimeConfig = input.runtimeConfig || input.runtime_config || input.config || {};
    const runtimeKind = normalizeRuntimeKind(
      input.runtimeKind || input.runtime_kind || input.runtime?.kind || runtimeConfig.runtimeKind || runtimeConfig.runtime_kind || options.runtimeKind,
      fallbackRuntimeKind
    );
    const runtime = options.runtime || {};
    const agentEngine = normalizeAgentEngine(
      input.agentEngine || input.agent_engine || input.engine || runtimeConfig.agentEngine || runtimeConfig.agent_engine,
      runtimeKind,
      runtime
    );
    // Leave color empty when the user has not set one; shared avatar
    // resolution hashes the bot uid consistently across surfaces.
    const color = botIdentity.normalizeBotColor(input.color || input.avatarColor || input.avatar_color);
    // Keep owner as metadata for edit/sync decisions. It is not part of the
    // default avatar color identity.
    const ownerUserId = firstNonEmpty(
      input.ownerUserId, input.owner_user_id, input.ownerId, input.owner_id,
      runtime.cloud?.user?.id, runtime.cloud?.user?.userId, runtime.cloud?.user?.user_id
    );
    const normalizedSourceKinds = [...new Set([...sourceKinds(input), sourceKind].filter(Boolean))];
    return {
      ...input,
      key,
      id: input.id || key,
      ownerUserId: ownerUserId || input.ownerUserId || undefined,
      name: firstNonEmpty(input.name, input.displayName, input.username, key),
      bio: normalizedBio(input),
      color,
      avatarImage: avatarResolve.normalizeAvatarImage(input.avatarImage || input.avatar_image || ""),
      avatarCrop: input.avatarCrop || input.avatar_crop || null,
      personaText: input.personaText || input.persona_text || "",
      agentEngine,
      runtimeKind,
      runtimeConfig,
      targetDeviceId: firstNonEmpty(input.targetDeviceId, input.target_device_id, runtimeConfig.deviceId, runtimeConfig.device_id),
      targetDeviceName: firstNonEmpty(input.targetDeviceName, input.target_device_name, runtimeConfig.deviceName, runtimeConfig.device_name),
      deviceId: firstNonEmpty(input.deviceId, input.device_id, runtimeConfig.deviceId, runtimeConfig.device_id),
      deviceName: firstNonEmpty(input.deviceName, input.device_name, runtimeConfig.deviceName, runtimeConfig.device_name),
      runtimeLabel: runtimeLabelFor({ ...input, key, runtimeKind }, runtime),
      sourceKinds: normalizedSourceKinds,
      canEditIdentity: input.canEditIdentity !== false,
      canConfigureCapabilities: input.canConfigureCapabilities !== false,
      canDelete: input.canDelete !== false
    };
  }

  function mergeOwnedBot(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    const sourceKinds = [...new Set([...(existing.sourceKinds || []), ...(incoming.sourceKinds || [])])];
    const merged = {
      ...existing,
      ...incoming,
      sourceKinds,
      canEditIdentity: existing.canEditIdentity !== false && incoming.canEditIdentity !== false,
      canConfigureCapabilities: existing.canConfigureCapabilities !== false && incoming.canConfigureCapabilities !== false,
      canDelete: incoming.canDelete !== false
    };
    const existingHasCloud = (existing.sourceKinds || []).includes("cloud");
    const incomingIsDesktopOnly = (incoming.sourceKinds || []).includes("desktop")
      && !(incoming.sourceKinds || []).includes("cloud");
    if (existingHasCloud && incomingIsDesktopOnly) {
      merged.avatarImage = existing.avatarImage || "";
      merged.avatarCrop = existing.avatarCrop || null;
      merged.runtimeKind = existing.runtimeKind || merged.runtimeKind;
      merged.runtimeLabel = existing.runtimeLabel || merged.runtimeLabel;
      merged.runtimeConfig = existing.runtimeConfig || existing.runtime_config || merged.runtimeConfig;
      merged.targetDeviceId = existing.targetDeviceId || existing.target_device_id || merged.targetDeviceId;
      merged.deviceId = existing.deviceId || existing.device_id || merged.deviceId;
      merged.deviceName = existing.deviceName || existing.device_name || merged.deviceName;
      merged.agentEngine = existing.agentEngine || merged.agentEngine;
    } else if (existing.avatarImage && !incoming.avatarImage) {
      merged.avatarImage = existing.avatarImage;
      merged.avatarCrop = existing.avatarCrop || null;
    }
    return merged;
  }

  function listOwnedBots({ cloudBots = [], runtime = {} } = {}) {
    const byKey = new Map();
    for (const bot of Array.isArray(cloudBots) ? cloudBots : []) {
      const normalized = normalizeOwnedBot(bot, { sourceKind: "cloud", runtimeKind: "cloud-claude-code", runtime });
      if (normalized) byKey.set(normalized.key, mergeOwnedBot(byKey.get(normalized.key), normalized));
    }
    return [...byKey.values()];
  }

  const api = {
    firstNonEmpty,
    botKey,
    sourceKinds,
    hasSourceKind,
    isCloudIdentityBot,
    isCloudRuntimeKind,
    normalizeRuntimeKind,
    normalizeAgentEngine,
    runtimeLabelFor,
    normalizeOwnedBot,
    listOwnedBots
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  global.miaBotDirectory = api;
})(typeof window !== "undefined" ? window : globalThis);
