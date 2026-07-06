(function attachCloudRuntime(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaCloudRuntime = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildCloudRuntime() {
  const CLOUD_RUNTIME_KIND = "cloud-claude-code";

  function normalizeRuntimeKind(value = "") {
    const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
    if (raw === CLOUD_RUNTIME_KIND || raw === "mia-cloud" || raw === "miacloud") return CLOUD_RUNTIME_KIND;
    return "";
  }

  function normalizeAgentEngineStrict(value = "") {
    const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
    if (raw === "claude" || raw === "claude-code" || raw === "anthropic") return "claude-code";
    if (raw === "codex" || raw === "openai-codex") return "codex";
    if (raw === "openclaw" || raw === "open-claw") return "openclaw";
    if (raw === "hermes") return "hermes";
    return "";
  }

  function engineLabel(engine = "") {
    if (engine === "claude-code") return "Claude Code";
    if (engine === "codex") return "Codex";
    if (engine === "openclaw") return "OpenClaw";
    if (engine === "hermes") return "Hermes";
    return "";
  }

  function normalizeCloudAgentRuntime(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const runtimeKind = normalizeRuntimeKind(source.runtimeKind || source.runtime_kind || source.kind);
    const agentEngine = normalizeAgentEngineStrict(
      source.agentEngine
        || source.agent_engine
        || source.engine
        || source.defaultAgentEngine
        || source.default_agent_engine
    );
    const available = source.available === false
      ? false
      : Boolean(runtimeKind && agentEngine);
    return {
      runtimeKind,
      runtime_kind: runtimeKind,
      agentEngine,
      agent_engine: agentEngine,
      label: engineLabel(agentEngine),
      available,
      mode: String(source.mode || "").trim(),
      source: String(source.source || "").trim(),
      updatedAt: String(source.updatedAt || source.updated_at || "").trim()
    };
  }

  function cloudAgentRuntimeFromCloud(cloud = {}) {
    const source = cloud?.agentRuntime
      || cloud?.agent_runtime
      || cloud?.cloudAgent
      || cloud?.cloud_agent
      || cloud?.agent
      || {};
    return normalizeCloudAgentRuntime(source);
  }

  function cloudAgentRuntimeFromState(stateOrRuntime = {}) {
    const runtime = stateOrRuntime?.runtime || stateOrRuntime || {};
    return cloudAgentRuntimeFromCloud(runtime.cloud || runtime);
  }

  function hasCloudAgentRuntime(stateOrRuntime = {}) {
    return cloudAgentRuntimeFromState(stateOrRuntime).available;
  }

  function requireCloudAgentRuntime(stateOrRuntime = {}) {
    const runtime = cloudAgentRuntimeFromState(stateOrRuntime);
    if (!runtime.available) {
      throw new Error("Mia Cloud 运行内核未同步，请刷新运行状态后重试。");
    }
    return runtime;
  }

  return {
    CLOUD_RUNTIME_KIND,
    normalizeRuntimeKind,
    normalizeAgentEngineStrict,
    engineLabel,
    normalizeCloudAgentRuntime,
    cloudAgentRuntimeFromCloud,
    cloudAgentRuntimeFromState,
    hasCloudAgentRuntime,
    requireCloudAgentRuntime
  };
});
