// Engine config / effort / permission options module
// Extracted from app.js. Read-only data layer for the multi-engine select UI:
//
//   - Which engine the active persona is using (hermes / claude-code / codex)
//   - The persona's per-engine config (model name, permissionMode, effortLevel)
//   - The list of model entries for external engines
//   - The list of permission modes and effort levels for the current engine,
//     pulled from real engine capabilities when present and falling back to
//     a sane default otherwise.
//
// Defensive `if (!state)` / `if (!els)` guards keep early calls safe.
(function () {
  "use strict";

  const engineContracts = window.miaEngineContracts || {};
  let state, els;
  let activePersona;
  let APPROVAL_LABELS = {};
  let APPROVAL_TITLES = {};
  let EFFORT_LABELS = {};

  function initEngineOptions(deps) {
    state = deps.state;
    els = deps.els;
    activePersona = deps.activePersona;
    if (deps.APPROVAL_LABELS) APPROVAL_LABELS = deps.APPROVAL_LABELS;
    if (deps.APPROVAL_TITLES) APPROVAL_TITLES = deps.APPROVAL_TITLES;
    if (deps.EFFORT_LABELS) EFFORT_LABELS = deps.EFFORT_LABELS;
  }

  function activeAgentEngine() {
    if (!activePersona) return "hermes";
    const persona = activePersona();
    const engine = persona?.agentEngine || persona?.agent_engine || "hermes";
    return engineContracts.normalizeAgentEngine ? engineContracts.normalizeAgentEngine(engine) : engine;
  }

  function engineConfigForPersona(persona = activePersona?.()) {
    return persona?.engineConfig || persona?.engine_config || {};
  }

  function externalModelEntries(engine) {
    if (engineContracts.externalModelEntries) {
      return engineContracts.externalModelEntries(engine, {
        engineCapabilities: state?.engineCapabilities,
        codexModels: state?.codexModels,
        platformModels: state?.platformModels
      });
    }
    return [];
  }

  function externalPermissionOptions(engine) {
    if (engineContracts.externalPermissionOptions && engineContracts.isExternalEngine?.(engine)) {
      return engineContracts.externalPermissionOptions(engine, {
        engineCapabilities: state?.engineCapabilities,
        codexPermissionProfiles: state?.engineCapabilities?.engines?.codex?.permissionProfiles
      });
    }
    const normalized = engineContracts.normalizeAgentEngine ? engineContracts.normalizeAgentEngine(engine) : engine;
    if (normalized === "claude-code" || normalized === "codex" || normalized === "openclaw") {
      return [{ value: "default", label: normalized === "claude-code" ? "Ask Permissions" : "Ask", title: "" }];
    }
    // Hermes — pull from real engine capabilities (probed via SETTINGS_SCHEMA).
    // Defaults to the upstream ask/yolo/deny set if the probe hasn't completed.
    const modes = (state?.engineCapabilities && Array.isArray(state.engineCapabilities.approvalModes) && state.engineCapabilities.approvalModes.length)
      ? state.engineCapabilities.approvalModes
      : ["ask", "yolo", "deny"];
    return modes.map((value) => ({
      value,
      label: APPROVAL_LABELS[value] || value,
      title: APPROVAL_TITLES[value] || ""
    }));
  }

  function effortOptions(engine) {
    if (engineContracts.effortOptions) {
      return engineContracts.effortOptions(engine, {
        engineCapabilities: state?.engineCapabilities,
        codexModels: state?.engineCapabilities?.engines?.codex?.models || state?.codexModels,
        effortLevels: state?.engineCapabilities?.effortLevels,
        effortLabels: EFFORT_LABELS
      });
    }
    const normalized = engineContracts.normalizeAgentEngine ? engineContracts.normalizeAgentEngine(engine) : engine;
    if (normalized === "claude-code" || normalized === "codex" || normalized === "openclaw") {
      return [{ value: "medium", label: EFFORT_LABELS.medium || "Medium" }];
    }
    // Hermes — pull from real engine capabilities (probed via SETTINGS_SCHEMA at
    // startup). Defaults to low/medium/high if the probe hasn't completed yet.
    const levels = (state?.engineCapabilities && Array.isArray(state.engineCapabilities.effortLevels) && state.engineCapabilities.effortLevels.length)
      ? state.engineCapabilities.effortLevels
      : ["low", "medium", "high"];
    return levels.map((value) => ({ value, label: EFFORT_LABELS[value] || value }));
  }

  function effortLabelForLevel(level = "") {
    if (!els) return "Medium";
    const selected = els.effortSelect?.selectedOptions?.[0];
    if (selected?.textContent) return selected.textContent;
    return effortOptions(activeAgentEngine()).find((item) => item.value === level)?.label || "Medium";
  }

  window.miaEngineOptions = {
    initEngineOptions,
    activeAgentEngine,
    engineConfigForPersona,
    externalModelEntries,
    externalPermissionOptions,
    effortOptions,
    effortLabelForLevel,
  };
})();
