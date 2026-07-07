(function attachAgentEnginePolicy(root, factory) {
  const contracts = root?.miaEngineContracts || (typeof require === "function" ? require("./engine-contracts") : {});
  const pathModule = typeof require === "function" ? require("node:path") : null;
  const api = factory(contracts, pathModule);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaAgentEnginePolicy = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildAgentEnginePolicy(contracts = {}, pathModule = null) {
  const EngineId = Object.freeze({
    Hermes: "hermes",
    ClaudeCode: "claude-code",
    Codex: "codex",
    OpenClaw: "openclaw"
  });
  const hasOwn = Object.prototype.hasOwnProperty;
  const NATIVE_SKILL_DIR_KEYS = Object.freeze(["nativeSkillsDirs", "native_skills_dirs"]);
  const NATIVE_SKILL_DIR_CONTAINER_KEYS = Object.freeze([
    "agentMetadata",
    "agent_metadata",
    "engineMetadata",
    "engine_metadata",
    "engineConfig",
    "engine_config"
  ]);

  function normalizeAgentEngine(value) {
    if (typeof contracts.normalizeAgentEngine === "function") return contracts.normalizeAgentEngine(value);
    const id = String(value || EngineId.Hermes).trim().toLowerCase().replace(/_/g, "-");
    if (id === "claude" || id === EngineId.ClaudeCode) return EngineId.ClaudeCode;
    if (id === EngineId.Codex || id === "openai-codex") return EngineId.Codex;
    if (id === EngineId.OpenClaw || id === "open-claw") return EngineId.OpenClaw;
    return EngineId.Hermes;
  }

  function normalizeHermesPermissionMode(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (["manual", "ask", "default"].includes(raw)) return "ask";
    if (["off", "yolo", "allow"].includes(raw)) return "yolo";
    if (["deny", "denied"].includes(raw)) return "deny";
    if (["smart", "auto"].includes(raw)) return "smart";
    return "ask";
  }

  const ENGINE_RUNTIME_POLICIES = Object.freeze({
    [EngineId.Hermes]: Object.freeze({
      id: EngineId.Hermes,
      homeStrategy: "native-user-home",
      nativeHomeSubdir: ".hermes",
      nativeSkillsDirs: Object.freeze([]),
      permissionScope: "engine",
      permissionStore: "root-mode",
      permissionCodec: "hermes-approvals-mode",
      modelScope: "partner",
      effortScope: "partner",
      configApply: "hermes-runtime-config"
    }),
    [EngineId.ClaudeCode]: Object.freeze({
      id: EngineId.ClaudeCode,
      homeStrategy: "native-engine-default",
      nativeHomeSubdir: "",
      nativeSkillsDirs: Object.freeze([".claude/skills"]),
      permissionScope: "engine",
      permissionStore: "engine-map",
      permissionCodec: "claude-code-permission-mode",
      modelScope: "partner",
      effortScope: "partner",
      configApply: "adapter-options"
    }),
    [EngineId.Codex]: Object.freeze({
      id: EngineId.Codex,
      homeStrategy: "native-user-home",
      nativeHomeSubdir: ".codex",
      nativeSkillsDirs: Object.freeze([".codex/skills"]),
      permissionScope: "engine",
      permissionStore: "engine-map",
      permissionCodec: "codex-permission-profile",
      modelScope: "partner",
      effortScope: "partner",
      configApply: "codex-permission-on-change"
    }),
    [EngineId.OpenClaw]: Object.freeze({
      id: EngineId.OpenClaw,
      homeStrategy: "native-engine-default",
      nativeHomeSubdir: "",
      nativeSkillsDirs: null,
      permissionScope: "engine",
      permissionStore: "engine-map",
      permissionCodec: "openclaw-acp-permission-mode",
      modelScope: "partner",
      effortScope: "partner",
      configApply: "adapter-options"
    })
  });

  function agentEnginePolicy(engine = EngineId.Hermes) {
    const normalized = normalizeAgentEngine(engine);
    return ENGINE_RUNTIME_POLICIES[normalized] || ENGINE_RUNTIME_POLICIES[EngineId.Hermes];
  }

  function isPlainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function normalizeNativeSkillsDirsValue(value) {
    if (value == null) return null;
    let raw = value;
    if (typeof raw === "string") {
      const text = raw.trim();
      if (!text) return [];
      try {
        raw = JSON.parse(text);
      } catch {
        raw = [text];
      }
    }
    if (raw == null) return null;
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const entry of raw) {
      const normalized = String(entry || "").trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }

  function findNativeSkillsDirsOverride(source) {
    if (!isPlainObject(source)) return { found: false, value: null };
    for (const key of NATIVE_SKILL_DIR_KEYS) {
      if (hasOwn.call(source, key)) {
        return {
          found: true,
          value: normalizeNativeSkillsDirsValue(source[key])
        };
      }
    }
    for (const key of NATIVE_SKILL_DIR_CONTAINER_KEYS) {
      if (!hasOwn.call(source, key)) continue;
      const nested = findNativeSkillsDirsOverride(source[key]);
      if (nested.found) return nested;
    }
    return { found: false, value: null };
  }

  function resolveNativeSkillsDirs(engine = EngineId.Hermes, options = {}) {
    const runtimeOverride = findNativeSkillsDirsOverride(options?.runtimeConfig);
    if (runtimeOverride.found) return runtimeOverride.value;
    const botOverride = findNativeSkillsDirsOverride(options?.bot);
    if (botOverride.found) return botOverride.value;
    const fallback = agentEnginePolicy(engine).nativeSkillsDirs;
    return Array.isArray(fallback) ? fallback.slice() : null;
  }

  function enginePermissionStoreTarget(engine = EngineId.Hermes) {
    return agentEnginePolicy(engine).permissionStore;
  }

  function normalizeEnginePermissionMode(engine = EngineId.Hermes, value = "") {
    const policy = agentEnginePolicy(engine);
    const raw = String(value || "").trim();
    if (policy.permissionCodec === "hermes-approvals-mode") return normalizeHermesPermissionMode(raw);
    return raw || "default";
  }

  function shouldApplyNativePermissionConfig(engine = EngineId.Hermes) {
    return agentEnginePolicy(engine).configApply === "codex-permission-on-change";
  }

  function nativeHomePathForEngine(engine = EngineId.Hermes, userHome = "") {
    const policy = agentEnginePolicy(engine);
    if (policy.homeStrategy !== "native-user-home" || !policy.nativeHomeSubdir) return "";
    const base = String(userHome || "").trim();
    if (!base) return "";
    if (pathModule && typeof pathModule.join === "function") return pathModule.join(base, policy.nativeHomeSubdir);
    return `${base.replace(/[\\/]+$/, "")}/${policy.nativeHomeSubdir}`;
  }

  return Object.freeze({
    ENGINE_RUNTIME_POLICIES,
    agentEnginePolicy,
    enginePermissionStoreTarget,
    nativeHomePathForEngine,
    normalizeAgentEngine,
    normalizeEnginePermissionMode,
    resolveNativeSkillsDirs,
    shouldApplyNativePermissionConfig
  });
});
