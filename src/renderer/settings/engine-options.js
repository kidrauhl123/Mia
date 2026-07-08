// Engine config / effort / permission options module
// Extracted from app.js. Read-only data layer for the multi-engine select UI:
//
//   - Which engine the active persona is using (hermes / claude-code / codex)
//   - The persona's per-engine config snapshot for Core requests
//   - Display labels, local runtime status text, and icon routing
//
// Defensive guards keep early calls safe.
(function () {
  "use strict";

  const engineContracts = window.miaEngineContracts || {};
  let activePersona;

  function initEngineOptions(deps) {
    activePersona = deps.activePersona;
  }

  function activeAgentEngine() {
    if (!activePersona) return "hermes";
    const persona = activePersona();
    const engine = persona?.agentEngine || persona?.agent_engine || "hermes";
    return engineContracts.normalizeAgentEngine ? engineContracts.normalizeAgentEngine(engine) : engine;
  }

  function normalizeAgentEngine(engine) {
    if (engineContracts.normalizeAgentEngine) return engineContracts.normalizeAgentEngine(engine);
    const raw = String(engine || "hermes").trim().toLowerCase().replace(/_/g, "-");
    if (raw === "claude" || raw === "claude-code") return "claude-code";
    if (raw === "codex" || raw === "openai-codex") return "codex";
    return "hermes";
  }

  function isExternalAgentEngine(engine) {
    return Boolean(engineContracts.isExternalEngine?.(normalizeAgentEngine(engine)));
  }

  function engineLabel(engine) {
    return engineContracts.engineLabel?.(engine) || normalizeAgentEngine(engine);
  }

  function runtimeAgentEngineInfo(runtime, engine) {
    const normalized = normalizeAgentEngine(engine);
    const info = runtime?.agentEngines || {};
    if (normalized === "claude-code") return info.claudeCode || {};
    if (normalized === "codex") return info.codex || {};
    return {};
  }

  function localEngineStatusText(runtime, engine) {
    const label = engineLabel(engine);
    const info = runtimeAgentEngineInfo(runtime, engine);
    return info.available ? `${label} 本地` : `未检测到 ${label}`;
  }

  function engineIconProvider(engine) {
    const normalized = normalizeAgentEngine(engine);
    if (normalized === "claude-code") return "anthropic";
    if (normalized === "codex") return "openai-codex";
    return normalized;
  }

  function engineIconModel(engine) {
    const normalized = normalizeAgentEngine(engine);
    if (normalized === "claude-code") return "claude";
    if (normalized === "codex") return "codex";
    return normalized;
  }

  function engineConfigForPersona(persona = activePersona?.()) {
    return persona?.engineConfig || persona?.engine_config || {};
  }

  window.miaEngineOptions = {
    initEngineOptions,
    activeAgentEngine,
    normalizeAgentEngine,
    isExternalAgentEngine,
    engineLabel,
    runtimeAgentEngineInfo,
    localEngineStatusText,
    engineIconProvider,
    engineIconModel,
    engineConfigForPersona,
  };
})();
