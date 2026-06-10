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

  function normalizeRuntimeKind(value, fallback = "desktop-local") {
    const raw = String(value || "").trim();
    if (raw === "cloud-hermes") return "cloud-hermes";
    if (raw === "desktop-local") return "desktop-local";
    return fallback === "cloud-hermes" ? "cloud-hermes" : "desktop-local";
  }

  function normalizeAgentEngine(value, runtimeKind = "desktop-local") {
    if (runtimeKind === "cloud-hermes") return "hermes";
    const id = String(value || "hermes").trim().toLowerCase().replace(/_/g, "-");
    if (id === "openclaw" || id === "open-claw") return "openclaw";
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

  function runtimeLabelFor(bot = {}, runtime = {}) {
    const runtimeConfig = bot.runtimeConfig || bot.runtime_config || bot.config || {};
    const runtimeKind = normalizeRuntimeKind(
      bot.runtimeKind || bot.runtime_kind || bot.runtime?.kind || runtimeConfig.runtimeKind || runtimeConfig.runtime_kind,
      bot.sourceKind === "cloud" ? "cloud-hermes" : "desktop-local"
    );
    if (runtimeKind === "cloud-hermes") return "Mia Cloud";
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
    const fallbackRuntimeKind = sourceKind === "cloud" ? "cloud-hermes" : "desktop-local";
    const runtimeConfig = input.runtimeConfig || input.runtime_config || input.config || {};
    const runtimeKind = normalizeRuntimeKind(
      input.runtimeKind || input.runtime_kind || input.runtime?.kind || runtimeConfig.runtimeKind || runtimeConfig.runtime_kind || options.runtimeKind,
      fallbackRuntimeKind
    );
    const runtime = options.runtime || {};
    const agentEngine = normalizeAgentEngine(
      input.agentEngine || input.agent_engine || input.engine || runtimeConfig.agentEngine || runtimeConfig.agent_engine,
      runtimeKind
    );
    // Leave color empty when the user has not set one — resolveAvatarForContact
    // then hashes the canonical (global) id. Baking memberAccentColor(key) here
    // made record-based surfaces (the sidebar list) honor a key-only hash that
    // disagreed with the global-id hash the chat header / bubbles use, so the
    // same bot showed two different background colors.
    const color = botIdentity.normalizeBotColor(input.color || input.avatarColor || input.avatar_color);
    // Owned bots belong to the signed-in user, so stamp the owner id when the
    // record lacks it; botAvatarIdentityId then yields bot:<owner>:<key>
    // (matching the conversation id) instead of falling back to the bare key.
    const ownerUserId = firstNonEmpty(
      input.ownerUserId, input.owner_user_id, input.ownerId, input.owner_id,
      runtime.cloud?.user?.id, runtime.cloud?.user?.userId, runtime.cloud?.user?.user_id
    );
    const sourceKinds = Array.isArray(input.sourceKinds)
      ? input.sourceKinds.map((item) => String(item || "").trim()).filter(Boolean)
      : [sourceKind];
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
      sourceKinds: [...new Set(sourceKinds)],
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

  function listOwnedBots({ cloudBots = [], localBots = [], runtime = {} } = {}) {
    const byKey = new Map();
    for (const bot of Array.isArray(cloudBots) ? cloudBots : []) {
      const normalized = normalizeOwnedBot(bot, { sourceKind: "cloud", runtimeKind: "cloud-hermes", runtime });
      if (normalized) byKey.set(normalized.key, mergeOwnedBot(byKey.get(normalized.key), normalized));
    }
    for (const bot of Array.isArray(localBots) ? localBots : []) {
      const normalized = normalizeOwnedBot(bot, { sourceKind: "desktop", runtimeKind: "desktop-local", runtime });
      if (normalized) byKey.set(normalized.key, mergeOwnedBot(byKey.get(normalized.key), normalized));
    }
    return [...byKey.values()];
  }

  const api = {
    firstNonEmpty,
    botKey,
    normalizeRuntimeKind,
    normalizeAgentEngine,
    runtimeLabelFor,
    normalizeOwnedBot,
    listOwnedBots
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  global.miaBotDirectory = api;
})(typeof window !== "undefined" ? window : globalThis);
