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
    shouldApplyNativePermissionConfig
  });
});
