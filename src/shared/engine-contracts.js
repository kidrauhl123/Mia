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

  function isExternalEngine(value) {
    const engine = normalizeAgentEngine(value);
    return engine === EngineId.ClaudeCode || engine === EngineId.Codex;
  }

  function externalModelEntries(value, options = {}) {
    const engine = normalizeAgentEngine(value);
    if (engine === EngineId.ClaudeCode) return cloneEntries(CLAUDE_MODEL_ENTRIES);
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
          label: model.displayName || model.slug
        });
      }
      return entries;
    }
    return [...entries, ...cloneEntries(CODEX_FALLBACK_MODEL_ENTRIES)];
  }

  function externalPermissionOptions(value) {
    const engine = normalizeAgentEngine(value);
    if (engine === EngineId.ClaudeCode) return cloneEntries(CLAUDE_PERMISSION_OPTIONS);
    if (engine === EngineId.Codex) return cloneEntries(CODEX_PERMISSION_OPTIONS);
    return [];
  }

  function effortOptions(value, options = {}) {
    const engine = normalizeAgentEngine(value);
    const labels = options.effortLabels || DEFAULT_EFFORT_LABELS;
    let levels = [];
    if (engine === EngineId.ClaudeCode) levels = ["low", "medium", "high", "xhigh", "max"];
    else if (engine === EngineId.Codex) levels = ["minimal", "low", "medium", "high", "xhigh"];
    else {
      levels = (Array.isArray(options.effortLevels) && options.effortLevels.length)
        ? options.effortLevels
        : ["low", "medium", "high"];
    }
    return levels.map((level) => ({ value: level, label: labels[level] || level }));
  }

  return Object.freeze({
    EngineId,
    CHAT_ENGINE_ADAPTERS,
    normalizeAgentEngine,
    adapterForEngine,
    engineLabel,
    isExternalEngine,
    externalModelEntries,
    externalPermissionOptions,
    effortOptions
  });
});
