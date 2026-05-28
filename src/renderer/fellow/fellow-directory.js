(function (global) {
  "use strict";

  const memberColor = (typeof globalThis !== "undefined" && globalThis.miaMemberColor)
    || (typeof require === "function" ? require("../../shared/member-color.js") : { memberAccentColor: () => "#5e5ce6" });

  function firstNonEmpty(...values) {
    for (const value of values) {
      const next = String(value || "").trim();
      if (next) return next;
    }
    return "";
  }

  function fellowKey(input = {}) {
    return String(input.key || input.id || input.fellowKey || input.fellow_id || "").trim();
  }

  function normalizeRuntimeKind(value, fallback = "desktop-local") {
    const raw = String(value || "").trim();
    if (raw === "cloud-hermes") return "cloud-hermes";
    if (raw === "desktop-local") return "desktop-local";
    return fallback === "cloud-hermes" ? "cloud-hermes" : "desktop-local";
  }

  function normalizeAgentEngine(value, runtimeKind = "desktop-local") {
    if (runtimeKind === "cloud-hermes") return "hermes";
    const normalizer = global.miaEngineContracts?.normalizeAgentEngine;
    if (typeof normalizer === "function") return normalizer(value);
    const id = String(value || "hermes").trim().toLowerCase().replace(/_/g, "-");
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

  function runtimeLabelFor(fellow = {}, runtime = {}) {
    const runtimeKind = normalizeRuntimeKind(
      fellow.runtimeKind || fellow.runtime_kind || fellow.runtime?.kind,
      fellow.sourceKind === "cloud" ? "cloud-hermes" : "desktop-local"
    );
    if (runtimeKind === "cloud-hermes") return "Mia Cloud";
    return firstNonEmpty(
      fellow.runtimeLabel,
      fellow.runtime_label,
      fellow.deviceName,
      fellow.device_name,
      fellow.sourceDeviceName,
      fellow.source_device_name,
      fellow.hostname,
      runtime.localDevice?.name,
      runtime.cloud?.deviceName,
      runtime.relay?.deviceName,
      "当前设备"
    );
  }

  function normalizeOwnedFellow(input = {}, options = {}) {
    if (!input || typeof input !== "object") return null;
    const key = fellowKey(input);
    if (!key) return null;
    const sourceKind = options.sourceKind || input.sourceKind || input.source_kind || "desktop";
    const fallbackRuntimeKind = sourceKind === "cloud" ? "cloud-hermes" : "desktop-local";
    const runtimeKind = normalizeRuntimeKind(
      input.runtimeKind || input.runtime_kind || input.runtime?.kind || options.runtimeKind,
      fallbackRuntimeKind
    );
    const runtime = options.runtime || {};
    const agentEngine = normalizeAgentEngine(input.agentEngine || input.agent_engine || input.engine, runtimeKind);
    const sourceKinds = Array.isArray(input.sourceKinds)
      ? input.sourceKinds.map((item) => String(item || "").trim()).filter(Boolean)
      : [sourceKind];
    return {
      ...input,
      key,
      id: input.id || key,
      name: firstNonEmpty(input.name, input.displayName, input.username, key),
      bio: normalizedBio(input),
      color: memberColor.memberAccentColor(key),
      avatarImage: input.avatarImage || input.avatar_image || "",
      avatarCrop: input.avatarCrop || input.avatar_crop || null,
      personaText: input.personaText || input.persona_text || "",
      agentEngine,
      runtimeKind,
      runtimeLabel: runtimeLabelFor({ ...input, key, runtimeKind }, runtime),
      sourceKinds: [...new Set(sourceKinds)],
      canEditIdentity: input.canEditIdentity !== false,
      canConfigureCapabilities: input.canConfigureCapabilities !== false,
      canDelete: input.canDelete !== false && (runtimeKind === "cloud-hermes" || key !== "mia")
    };
  }

  function mergeOwnedFellow(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    const sourceKinds = [...new Set([...(existing.sourceKinds || []), ...(incoming.sourceKinds || [])])];
    return {
      ...existing,
      ...incoming,
      sourceKinds,
      canEditIdentity: existing.canEditIdentity !== false && incoming.canEditIdentity !== false,
      canConfigureCapabilities: existing.canConfigureCapabilities !== false && incoming.canConfigureCapabilities !== false,
      canDelete: incoming.canDelete !== false
    };
  }

  function listOwnedFellows({ cloudFellows = [], localFellows = [], runtime = {} } = {}) {
    const byKey = new Map();
    for (const fellow of Array.isArray(cloudFellows) ? cloudFellows : []) {
      const normalized = normalizeOwnedFellow(fellow, { sourceKind: "cloud", runtimeKind: "cloud-hermes", runtime });
      if (normalized) byKey.set(normalized.key, mergeOwnedFellow(byKey.get(normalized.key), normalized));
    }
    for (const fellow of Array.isArray(localFellows) ? localFellows : []) {
      const normalized = normalizeOwnedFellow(fellow, { sourceKind: "desktop", runtimeKind: "desktop-local", runtime });
      if (normalized) byKey.set(normalized.key, mergeOwnedFellow(byKey.get(normalized.key), normalized));
    }
    return [...byKey.values()];
  }

  const api = {
    firstNonEmpty,
    fellowKey,
    normalizeRuntimeKind,
    normalizeAgentEngine,
    runtimeLabelFor,
    normalizeOwnedFellow,
    listOwnedFellows
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  global.miaFellowDirectory = api;
})(typeof window !== "undefined" ? window : globalThis);
