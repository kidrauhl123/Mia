(function attachEngineContracts(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaEngineContracts = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildEngineContracts() {
  const EngineId = Object.freeze({
    Hermes: "hermes",
    ClaudeCode: "claude-code",
    Codex: "codex"
  });
  const MiaProviderId = "mia";

  const CHAT_ENGINE_ADAPTERS = Object.freeze({
    [EngineId.Hermes]: Object.freeze({
      id: EngineId.Hermes,
      label: "Hermes",
      responseModel: "hermes-agent",
      transport: "runs",
      usesRuntime: true,
      usesSdkPromptPrefix: false
    }),
    [EngineId.ClaudeCode]: Object.freeze({
      id: EngineId.ClaudeCode,
      label: "Claude Code",
      responseModel: "claude-code",
      transport: "claude-agent-sdk",
      cliCommand: "claude",
      usesRuntime: false,
      usesSdkPromptPrefix: true
    }),
    [EngineId.Codex]: Object.freeze({
      id: EngineId.Codex,
      label: "Codex",
      responseModel: "codex-cli",
      transport: "codex-app-server",
      cliCommand: "codex",
      usesRuntime: false,
      usesSdkPromptPrefix: true
    })
  });

  const CODEX_PERMISSION_PROFILE_LABELS = Object.freeze({
    ":workspace": "Workspace",
    ":read-only": "Read Only",
    ":danger-full-access": "Full Access"
  });

  const CODEX_PERMISSION_PROFILE_ALIASES = Object.freeze({
    ":workspace": ["default", "acceptEdits", "workspace"],
    ":read-only": ["readOnly", "read-only"],
    ":danger-full-access": ["bypassPermissions", "yolo", "off", "never", "danger-full-access"]
  });

  const EXTERNAL_PERMISSION_LABELS = Object.freeze({
    "agent-full-access": "Full Access",
    default: "Ask",
    acceptEdits: "Accept Edits",
    auto: "Auto",
    bypassPermissions: "Bypass Permissions",
    dontAsk: "Don't Ask",
    plan: "Plan Mode",
    readOnly: "Read",
    yolo: "YOLO"
  });

  const FULL_ACCESS_PERMISSION_MODES = new Set([
    ":danger-full-access",
    "agent-full-access",
    "bypassPermissions",
    "danger-full-access",
    "never",
    "off",
    "yolo"
  ]);

  const DEFAULT_EFFORT_LABELS = Object.freeze({
    off: "Off",
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    adaptive: "Adaptive",
    max: "Max"
  });

  function normalizeAgentEngine(value) {
    const id = String(value || EngineId.Hermes).trim().toLowerCase().replace(/_/g, "-");
    if (id === "claude" || id === EngineId.ClaudeCode) return EngineId.ClaudeCode;
    if (id === EngineId.Codex || id === "openai-codex") return EngineId.Codex;
    return EngineId.Hermes;
  }

  function adapterForEngine(value) {
    return CHAT_ENGINE_ADAPTERS[normalizeAgentEngine(value)] || CHAT_ENGINE_ADAPTERS[EngineId.Hermes];
  }

  function engineLabel(value) {
    return adapterForEngine(value).label;
  }

  function titleCaseWords(value = "") {
    return String(value || "")
      .replace(/^:+/, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase())
      .trim();
  }

  function permissionLabel(value = "") {
    const mode = String(value || "").trim();
    return CODEX_PERMISSION_PROFILE_LABELS[mode]
      || EXTERNAL_PERMISSION_LABELS[mode]
      || titleCaseWords(mode)
      || mode;
  }

  function isFullAccessPermissionMode(value = "") {
    return FULL_ACCESS_PERMISSION_MODES.has(String(value || "").trim());
  }

  function isExternalEngine(value) {
    const engine = normalizeAgentEngine(value);
    return engine === EngineId.ClaudeCode || engine === EngineId.Codex;
  }

  function capabilitiesForEngine(engine, options = {}) {
    return options.engineCapability
      || options.externalCapabilities?.[engine]
      || options.engineCapabilities?.engines?.[engine]
      || options.engines?.[engine]
      || {};
  }

  function normalizeExternalModelEntry(engine, entry = {}, index = 0) {
    if (!entry || typeof entry !== "object") return null;
    const id = String(entry.id || entry.key || entry.value || entry.model || entry.name || "").trim();
    const model = String(entry.model || entry.key || entry.id || entry.value || entry.name || "").trim();
    if (!id && !model) return null;
    const label = String(entry.label || entry.displayName || entry.display_name || entry.name || model || id).trim();
    return {
      id: id || model || `${engine}-${index}`,
      provider: String(entry.provider || engine).trim(),
      providerLabel: String(entry.providerLabel || entry.provider_label || engineLabel(engine)).trim(),
      model,
      label: label || model || id,
      authType: entry.authType || entry.auth_type || "",
      modelProfileId: entry.modelProfileId || entry.model_profile_id || "",
      description: String(entry.description || "").trim(),
      defaultReasoningLevel: String(entry.defaultReasoningLevel || entry.default_reasoning_level || "").trim(),
      supportedReasoningLevels: Array.isArray(entry.supportedReasoningLevels)
        ? entry.supportedReasoningLevels.map((item) => ({ ...item }))
        : [],
      source: String(entry.source || "").trim(),
      available: entry.available,
      contextWindow: entry.contextWindow,
      tags: Array.isArray(entry.tags) ? entry.tags.slice() : []
    };
  }

  function dedupeModelEntries(entries = []) {
    const seen = new Set();
    const result = [];
    for (const entry of entries) {
      if (!entry) continue;
      const key = `${entry.provider || ""}:${entry.id || entry.model || ""}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(entry);
    }
    return result;
  }

  function normalizePlatformModelEntry(entry = {}) {
    const id = String(entry.id || entry.value || entry.model_name || entry.model || "").trim();
    if (!id) return null;
    return {
      id,
      provider: MiaProviderId,
      providerLabel: "Mia",
      model: id,
      label: platformModelDisplayLabel(entry, id),
      authType: "mia_account",
      modelProfileId: `mia:${id}`,
      upstreamModel: String(entry.upstreamModel || entry.upstream_model || "").trim()
    };
  }

  function platformModelDisplayLabel(entry = {}, fallbackId = "") {
    const id = String(fallbackId || entry.id || entry.value || entry.model_name || entry.model || "").trim();
    const idLower = id.toLowerCase();
    if (idLower === "mia-auto") return "Auto";
    if (idLower === "mia-default") return "Auto";
    const raw = String(entry.label || entry.name || entry.displayName || entry.display_name || id).trim() || id;
    return raw.replace(/^Mia\s+/i, "").trim() || raw || id;
  }

  function miaModelEntries(options = {}) {
    const platformModels = Array.isArray(options.platformModels) ? options.platformModels : [];
    return platformModels.map(normalizePlatformModelEntry).filter(Boolean);
  }

  function externalModelEntries(value, options = {}) {
    const engine = normalizeAgentEngine(value);
    const miaEntries = miaModelEntries(options);
    const capability = capabilitiesForEngine(engine, options);
    if (engine === EngineId.ClaudeCode) {
      const dynamic = Array.isArray(capability.models) ? capability.models : [];
      return [
        ...dedupeModelEntries([
          ...dynamic.map((entry, index) => normalizeExternalModelEntry(engine, entry, index)).filter(Boolean)
        ]),
        ...miaEntries
      ];
    }
    if (engine !== EngineId.Codex) return [];

    const entries = [];
    const dynamic = Array.isArray(capability.models) ? capability.models : [];
    if (dynamic.length) {
      for (const model of dynamic) {
        if (!model?.slug) continue;
        entries.push({
          id: model.slug,
          provider: EngineId.Codex,
          providerLabel: "Codex CLI",
          model: model.slug,
          label: model.displayName || model.slug,
          description: model.description || "",
          defaultReasoningLevel: model.defaultReasoningLevel || "",
          supportedReasoningLevels: Array.isArray(model.supportedReasoningLevels)
            ? model.supportedReasoningLevels.map((item) => ({ ...item }))
            : []
        });
      }
    }
    return [...dedupeModelEntries(entries), ...miaEntries];
  }

  function codexPermissionOptionsFromProfiles(profiles = []) {
    const rows = Array.isArray(profiles)
      ? profiles
        .map((profile) => ({
          id: String(profile?.id || profile?.value || "").trim(),
          description: profile?.description == null ? "" : String(profile.description)
        }))
        .filter((profile) => profile.id)
      : [];
    if (!rows.length) return [];

    const rank = {
      ":workspace": 0,
      ":read-only": 1,
      ":danger-full-access": 2
    };
    return rows
      .slice()
      .sort((a, b) => (rank[a.id] ?? 50) - (rank[b.id] ?? 50) || a.id.localeCompare(b.id))
      .map((profile) => ({
        value: profile.id,
        label: CODEX_PERMISSION_PROFILE_LABELS[profile.id] || titleCaseWords(profile.id) || profile.id,
        title: profile.description || `Codex permission profile ${profile.id}`,
        profileId: profile.id,
        aliases: CODEX_PERMISSION_PROFILE_ALIASES[profile.id] || []
      }));
  }

  function normalizePermissionOption(engine, item = {}) {
    const value = String(item.value || item.id || "").trim();
    if (!value) return null;
    return {
      value,
      label: String(item.label || EXTERNAL_PERMISSION_LABELS[value] || titleCaseWords(value) || value),
      title: String(item.title || item.description || ""),
      profileId: item.profileId || item.profile_id || "",
      aliases: Array.isArray(item.aliases) ? item.aliases.map((alias) => String(alias)).filter(Boolean) : []
    };
  }

  function externalPermissionOptions(value, options = {}) {
    const engine = normalizeAgentEngine(value);
    const capability = capabilitiesForEngine(engine, options);
    const dynamicOptions = Array.isArray(capability.permissionOptions) ? capability.permissionOptions : [];
    if (dynamicOptions.length) {
      return dynamicOptions.map((item) => normalizePermissionOption(engine, item)).filter(Boolean);
    }
    const dynamicModes = Array.isArray(capability.permissionModes) ? capability.permissionModes : [];
    if (dynamicModes.length) {
      return dynamicModes.map((mode) => normalizePermissionOption(engine, { value: mode })).filter(Boolean);
    }
    if (engine === EngineId.Codex) {
      const profiles = Array.isArray(capability.permissionProfiles) && capability.permissionProfiles.length
        ? capability.permissionProfiles
        : options.codexPermissionProfiles;
      return codexPermissionOptionsFromProfiles(profiles);
    }
    return [];
  }

  function effortOptions(value, options = {}) {
    const engine = normalizeAgentEngine(value);
    const labels = options.effortLabels || DEFAULT_EFFORT_LABELS;
    const capability = capabilitiesForEngine(engine, options);
    const dynamicOptions = Array.isArray(capability.effortOptions) ? capability.effortOptions : [];
    if (dynamicOptions.length) {
      return dynamicOptions
        .map((item) => {
          const level = String(item?.value || item?.effort || item || "").trim();
          if (!level) return null;
          return {
            value: level,
            label: item?.label || labels[level] || level,
            title: item?.title || item?.description || ""
          };
        })
        .filter(Boolean);
    }
    const dynamicLevels = Array.isArray(capability.effortLevels) ? capability.effortLevels : [];
    if (dynamicLevels.length) {
      return dynamicLevels
        .map((level) => String(level || "").trim())
        .filter(Boolean)
        .map((level) => ({ value: level, label: labels[level] || level }));
    }
    let levels = [];
    if (engine === EngineId.Codex) {
      const dynamic = [];
      const seen = new Set();
      const models = Array.isArray(capability.models) ? capability.models : [];
      for (const model of models) {
        const supported = Array.isArray(model?.supportedReasoningLevels) ? model.supportedReasoningLevels : [];
        for (const item of supported) {
          const level = String(item?.effort || item?.value || "").trim();
          if (!level || seen.has(level)) continue;
          seen.add(level);
          dynamic.push({ value: level, label: labels[level] || item.label || level, title: item.description || "" });
        }
      }
      if (dynamic.length) return dynamic;
    }
    if (!isExternalEngine(engine)) {
      levels = (Array.isArray(options.effortLevels) && options.effortLevels.length)
        ? options.effortLevels
        : [];
    }
    return levels.map((level) => ({ value: level, label: labels[level] || level }));
  }

  return Object.freeze({
    EngineId,
    MiaProviderId,
    CHAT_ENGINE_ADAPTERS,
    normalizeAgentEngine,
    adapterForEngine,
    engineLabel,
    isExternalEngine,
    permissionLabel,
    isFullAccessPermissionMode,
    platformModelDisplayLabel,
    miaModelEntries,
    externalModelEntries,
    externalPermissionOptions,
    effortOptions
  });
});
