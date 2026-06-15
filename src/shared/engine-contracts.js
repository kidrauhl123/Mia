(function attachEngineContracts(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaEngineContracts = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildEngineContracts() {
  const EngineId = Object.freeze({
    Hermes: "hermes",
    ClaudeCode: "claude-code",
    Codex: "codex",
    OpenClaw: "openclaw"
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
      transport: "codex-sdk",
      cliCommand: "codex",
      usesRuntime: false,
      usesSdkPromptPrefix: true
    }),
    [EngineId.OpenClaw]: Object.freeze({
      id: EngineId.OpenClaw,
      label: "OpenClaw",
      responseModel: "openclaw-acp",
      transport: "acp-backend",
      agentType: "acp",
      backend: "openclaw",
      cliCommand: "openclaw",
      usesRuntime: true,
      usesSdkPromptPrefix: false
    })
  });

  const CLAUDE_MODEL_ENTRIES = Object.freeze([
    { id: "default", provider: EngineId.ClaudeCode, providerLabel: "Claude Code", model: "", label: "Claude Code 默认" },
    { id: "claude-opus-4-7", provider: EngineId.ClaudeCode, providerLabel: "Claude Code", model: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { id: "claude-sonnet-4-6", provider: EngineId.ClaudeCode, providerLabel: "Claude Code", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "opus", provider: EngineId.ClaudeCode, providerLabel: "Claude Code", model: "opus", label: "Opus alias" },
    { id: "sonnet", provider: EngineId.ClaudeCode, providerLabel: "Claude Code", model: "sonnet", label: "Sonnet alias" }
  ]);

  const CODEX_FALLBACK_MODEL_ENTRIES = Object.freeze([
    { id: "gpt-5.3-codex-spark", provider: EngineId.Codex, providerLabel: "Codex CLI", model: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
    { id: "gpt-5.3-codex", provider: EngineId.Codex, providerLabel: "Codex CLI", model: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "gpt-5.2", provider: EngineId.Codex, providerLabel: "Codex CLI", model: "gpt-5.2", label: "GPT-5.2" }
  ]);

  const OPENCLAW_MODEL_ENTRIES = Object.freeze([
    { id: "default", provider: EngineId.OpenClaw, providerLabel: "OpenClaw", model: "", label: "OpenClaw 默认" }
  ]);

  const CLAUDE_PERMISSION_OPTIONS = Object.freeze([
    { value: "default", label: "Ask Permissions", title: "Claude Code 默认权限，危险操作会询问。" },
    { value: "acceptEdits", label: "Accept Edits", title: "Claude Code 自动接受文件编辑，其他危险操作仍按规则处理。" },
    { value: "plan", label: "Plan Mode", title: "Claude Code 计划模式，只读规划。" },
    { value: "auto", label: "Auto Mode", title: "Claude Code 自动判断低风险操作，高风险操作仍会询问。" },
    { value: "bypassPermissions", label: "Bypass Permissions", title: "Claude Code Bypass Permissions，只在完全信任时使用。" }
  ]);

  const CODEX_PERMISSION_OPTIONS = Object.freeze([
    { value: "default", label: "Ask", title: "Codex 默认 workspace-write + untrusted。" },
    { value: "acceptEdits", label: "Edits", title: "Codex workspace-write + on-request。" },
    { value: "readOnly", label: "Read", title: "Codex 只读模式。" },
    { value: "bypassPermissions", label: "YOLO", title: "Codex danger-full-access + never。" }
  ]);

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

  const OPENCLAW_PERMISSION_OPTIONS = Object.freeze([
    { value: "default", label: "Ask", title: "OpenClaw 默认 workspace-write + untrusted。" },
    { value: "acceptEdits", label: "Edits", title: "OpenClaw workspace-write + on-request。" },
    { value: "readOnly", label: "Read", title: "OpenClaw 只读模式。" },
    { value: "bypassPermissions", label: "YOLO", title: "OpenClaw danger-full-access + never。" }
  ]);

  const DEFAULT_EFFORT_LABELS = Object.freeze({
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max"
  });

  function normalizeAgentEngine(value) {
    const id = String(value || EngineId.Hermes).trim().toLowerCase().replace(/_/g, "-");
    if (id === "claude" || id === EngineId.ClaudeCode) return EngineId.ClaudeCode;
    if (id === EngineId.Codex || id === "openai-codex") return EngineId.Codex;
    if (id === EngineId.OpenClaw || id === "open-claw") return EngineId.OpenClaw;
    return EngineId.Hermes;
  }

  function adapterForEngine(value) {
    return CHAT_ENGINE_ADAPTERS[normalizeAgentEngine(value)] || CHAT_ENGINE_ADAPTERS[EngineId.Hermes];
  }

  function engineLabel(value) {
    return adapterForEngine(value).label;
  }

  function cloneEntries(entries) {
    return entries.map((entry) => ({ ...entry }));
  }

  function titleCaseWords(value = "") {
    return String(value || "")
      .replace(/^:+/, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase())
      .trim();
  }

  function isExternalEngine(value) {
    const engine = normalizeAgentEngine(value);
    return engine === EngineId.ClaudeCode || engine === EngineId.Codex || engine === EngineId.OpenClaw;
  }

  function normalizePlatformModelEntry(entry = {}) {
    const id = String(entry.id || entry.value || entry.model_name || entry.model || "").trim();
    if (!id) return null;
    return {
      id,
      provider: MiaProviderId,
      providerLabel: "Mia",
      model: id,
      label: String(entry.label || entry.name || entry.displayName || id).trim() || id,
      authType: "mia_account",
      modelProfileId: `mia:${id}`,
      upstreamModel: String(entry.upstreamModel || entry.upstream_model || "").trim()
    };
  }

  function miaModelEntries(options = {}) {
    const platformModels = Array.isArray(options.platformModels) ? options.platformModels : [];
    const entries = platformModels.map(normalizePlatformModelEntry).filter(Boolean);
    return entries.length
      ? entries
      : [{
        id: "mia-default",
        provider: MiaProviderId,
        providerLabel: "Mia",
        model: "mia-default",
        label: "Mia Default",
        authType: "mia_account",
        modelProfileId: "mia:mia-default",
        upstreamModel: ""
      }];
  }

  function externalModelEntries(value, options = {}) {
    const engine = normalizeAgentEngine(value);
    const miaEntries = miaModelEntries(options);
    if (engine === EngineId.ClaudeCode) return [...cloneEntries(CLAUDE_MODEL_ENTRIES), ...miaEntries];
    if (engine === EngineId.OpenClaw) return cloneEntries(OPENCLAW_MODEL_ENTRIES);
    if (engine !== EngineId.Codex) return [];

    const entries = [{ id: "default", provider: EngineId.Codex, providerLabel: "Codex CLI", model: "", label: "Codex 默认" }];
    const dynamic = Array.isArray(options.codexModels) ? options.codexModels : [];
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
      return [...entries, ...miaEntries];
    }
    return [...entries, ...cloneEntries(CODEX_FALLBACK_MODEL_ENTRIES), ...miaEntries];
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
    if (!rows.length) return cloneEntries(CODEX_PERMISSION_OPTIONS);

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

  function externalPermissionOptions(value, options = {}) {
    const engine = normalizeAgentEngine(value);
    if (engine === EngineId.ClaudeCode) return cloneEntries(CLAUDE_PERMISSION_OPTIONS);
    if (engine === EngineId.Codex) return codexPermissionOptionsFromProfiles(options.codexPermissionProfiles);
    if (engine === EngineId.OpenClaw) return cloneEntries(OPENCLAW_PERMISSION_OPTIONS);
    return [];
  }

  function effortOptions(value, options = {}) {
    const engine = normalizeAgentEngine(value);
    const labels = options.effortLabels || DEFAULT_EFFORT_LABELS;
    let levels = [];
    if (engine === EngineId.ClaudeCode) levels = ["low", "medium", "high", "xhigh", "max"];
    else if (engine === EngineId.Codex) {
      const dynamic = [];
      const seen = new Set();
      const models = Array.isArray(options.codexModels) ? options.codexModels : [];
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
      levels = ["minimal", "low", "medium", "high", "xhigh"];
    }
    else if (engine === EngineId.OpenClaw) levels = ["minimal", "low", "medium", "high", "xhigh"];
    else {
      levels = (Array.isArray(options.effortLevels) && options.effortLevels.length)
        ? options.effortLevels
        : ["low", "medium", "high"];
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
    miaModelEntries,
    externalModelEntries,
    externalPermissionOptions,
    effortOptions
  });
});
