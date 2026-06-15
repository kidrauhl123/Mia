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

  function platformMiaModelEntries() {
    const platformModels = Array.isArray(state?.platformModels) ? state.platformModels : [];
    const entries = platformModels.map((entry) => {
      const id = String(entry.id || entry.value || entry.model_name || entry.model || "").trim();
      if (!id) return null;
      return {
        id,
        provider: "mia",
        providerLabel: "Mia",
        model: id,
        label: String(entry.label || entry.name || entry.displayName || id).trim() || id,
        authType: "mia_account",
        modelProfileId: `mia:${id}`,
        upstreamModel: String(entry.upstreamModel || entry.upstream_model || "").trim()
      };
    }).filter(Boolean);
    return entries.length
      ? entries
      : [{ id: "mia-default", provider: "mia", providerLabel: "Mia", model: "mia-default", label: "Mia Default", authType: "mia_account", modelProfileId: "mia:mia-default", upstreamModel: "" }];
  }

  function externalModelEntries(engine) {
    if (engineContracts.externalModelEntries) {
      return engineContracts.externalModelEntries(engine, {
        codexModels: state?.codexModels,
        platformModels: state?.platformModels
      });
    }
    if (engine === "claude-code") {
      return [
        { id: "default", provider: "claude-code", providerLabel: "Claude Code", model: "", label: "Claude Code 默认" },
        { id: "claude-opus-4-7", provider: "claude-code", providerLabel: "Claude Code", model: "claude-opus-4-7", label: "Claude Opus 4.7" },
        { id: "claude-sonnet-4-6", provider: "claude-code", providerLabel: "Claude Code", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
        { id: "opus", provider: "claude-code", providerLabel: "Claude Code", model: "opus", label: "Opus alias" },
        { id: "sonnet", provider: "claude-code", providerLabel: "Claude Code", model: "sonnet", label: "Sonnet alias" },
        ...platformMiaModelEntries()
      ];
    }
    if (engine === "codex") {
      const entries = [{ id: "default", provider: "codex", providerLabel: "Codex CLI", model: "", label: "Codex 默认" }];
      const dynamic = Array.isArray(state?.codexModels) ? state.codexModels : [];
      if (dynamic.length) {
        for (const m of dynamic) {
          if (!m?.slug) continue;
          entries.push({
            id: m.slug,
            provider: "codex",
            providerLabel: "Codex CLI",
            model: m.slug,
            label: m.displayName || m.slug
          });
        }
        return [...entries, ...platformMiaModelEntries()];
      }
      // Fallback if ~/.codex/models_cache.json is missing (fresh install pre-login).
      return [
        ...entries,
        { id: "gpt-5.3-codex-spark", provider: "codex", providerLabel: "Codex CLI", model: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
        { id: "gpt-5.3-codex", provider: "codex", providerLabel: "Codex CLI", model: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
        { id: "gpt-5.2", provider: "codex", providerLabel: "Codex CLI", model: "gpt-5.2", label: "GPT-5.2" },
        ...platformMiaModelEntries()
      ];
    }
    if (engine === "openclaw") {
      return [
        { id: "default", provider: "openclaw", providerLabel: "OpenClaw", model: "", label: "OpenClaw 默认" }
      ];
    }
    return [];
  }

  function externalPermissionOptions(engine) {
    if (engineContracts.externalPermissionOptions && engineContracts.isExternalEngine?.(engine)) {
      return engineContracts.externalPermissionOptions(engine, {
        codexPermissionProfiles: state?.engineCapabilities?.engines?.codex?.permissionProfiles
      });
    }
    if (engine === "claude-code") {
      return [
        { value: "default", label: "Ask Permissions", title: "Claude Code 默认权限，危险操作会询问。" },
        { value: "acceptEdits", label: "Accept Edits", title: "Claude Code 自动接受文件编辑，其他危险操作仍按规则处理。" },
        { value: "plan", label: "Plan Mode", title: "Claude Code 计划模式，只读规划。" },
        { value: "auto", label: "Auto Mode", title: "Claude Code 自动判断低风险操作，高风险操作仍会询问。" },
        { value: "bypassPermissions", label: "Bypass Permissions", title: "Claude Code Bypass Permissions，只在完全信任时使用。" }
      ];
    }
    if (engine === "codex" || engine === "openclaw") {
      const label = engine === "openclaw" ? "OpenClaw" : "Codex";
      return [
        { value: "default", label: "Ask", title: `${label} 默认 workspace-write + untrusted。` },
        { value: "acceptEdits", label: "Edits", title: `${label} workspace-write + on-request。` },
        { value: "readOnly", label: "Read", title: `${label} 只读模式。` },
        { value: "bypassPermissions", label: "YOLO", title: `${label} danger-full-access + never。` }
      ];
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
        codexModels: state?.engineCapabilities?.engines?.codex?.models || state?.codexModels,
        effortLevels: state?.engineCapabilities?.effortLevels,
        effortLabels: EFFORT_LABELS
      });
    }
    if (engine === "claude-code") {
      return [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra high" },
        { value: "max", label: "Max" }
      ];
    }
    if (engine === "codex" || engine === "openclaw") {
      return [
        { value: "minimal", label: "Minimal" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra high" }
      ];
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
