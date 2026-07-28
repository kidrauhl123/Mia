(function (global) {
  "use strict";

  let state;
  let els;

  function init(deps = {}) {
    state = deps.state;
    els = deps.els;
  }

  function inventoryById(runtime) {
    return Object.fromEntries((runtime?.agentInventory?.agents || []).map((agent) => [agent.id, agent]));
  }

  function shortVersion(agent) {
    const version = String(agent?.version || "").trim();
    return version ? version.split(/\s+/).slice(0, 2).join(" ") : "";
  }

  function installMessage(engineId) {
    const id = String(engineId || "").trim();
    if (!state || !id) return "";
    if (state.agentSetupInstallInFlight && state.agentSetupInstallEngine === id) {
      return state.agentSetupInstallMessage || "Installing...";
    }
    const error = state.agentSetupInstallErrors?.[id];
    if (error) return String(error);
    return id === "hermes" && state.hermesInstallError ? state.hermesInstallError : "";
  }

  function progress(engineId) {
    if (!state?.agentSetupInstallInFlight || state.agentSetupInstallEngine !== engineId) return null;
    const value = Number(state.agentSetupInstallPercent);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
  }

  function detectedLine(agent, engineId = agent?.id) {
    const installing = installMessage(engineId);
    if (installing) return installing;
    if (!agent) return "未检测到";
    const readiness = agent.readiness || {};
    const readinessText = String(readiness.summary || readiness.detail || "").trim();
    if ((agent.health === "blocked" || readiness.status === "blocked") && readinessText) return readinessText;
    if (readiness.status === "repairable" && readinessText) return readinessText;
    if (agent.usableInMia) {
      return [agent.source === "mia-managed" ? "Mia 稳定版" : "本机版本", shortVersion(agent)].filter(Boolean).join(" · ");
    }
    if (agent.installed && agent.detectionOnly) return "已就绪";
    if (agent.installed) return "已检测到 · 当前不可直接用于 Mia";
    if (agent.installable) return "未检测到本机版本 · 可启用 Mia 稳定版";
    return "未检测到";
  }

  function legacyStatus(id, legacy) {
    if (!legacy) return null;
    const installed = Boolean(legacy.installed ?? legacy.available);
    const detectionOnly = Boolean(legacy.detectionOnly);
    const usableInMia = legacy.usableInMia === undefined
      ? Boolean(legacy.available && !detectionOnly)
      : Boolean(legacy.usableInMia);
    return { id, ...legacy, installed, detectionOnly, usableInMia };
  }

  function hermesLine(runtime, hermes) {
    const installing = installMessage("hermes");
    if (installing) return installing;
    if (hermes) {
      if (hermes.usableInMia || hermes.installed) return detectedLine(hermes);
      return "未检测到本机版本 · 可启用 Mia 稳定版";
    }
    const source = String(runtime?.engineSource || "");
    return runtime?.engineInstalled
      || ["bundled", "managed", "mia-managed", "local-source", "maintained-local-source", "system"].includes(source)
      ? "已接入 Mia"
      : "未检测到本机版本 · 可启用 Mia 稳定版";
  }

  function renderHermesInstallState(runtime = state?.runtime) {
    const installing = installMessage("hermes");
    if (installing) return installing;
    const hermes = runtime?.agentInventory?.agents?.find((agent) => agent.id === "hermes");
    if (state?.hermesInstallError) return state.hermesInstallError;
    if (!hermes) return "";
    if (hermes.health === "blocked" || hermes.readiness?.status === "blocked") {
      return String(hermes.readiness?.summary || hermes.readiness?.detail || "Hermes 不可用").trim();
    }
    if (hermes.health === "broken") return "官方 Hermes 状态异常，可修复。";
    if (hermes.source === "system" && !hermes.usableInMia) return "检测到 Hermes，但当前安装方式暂不能用于 Mia。";
    return "";
  }

  function hermesSetupAction(runtime = state?.runtime) {
    const hermes = runtime?.agentInventory?.agents?.find((agent) => agent.id === "hermes");
    if (hermes?.health === "broken") return { action: "repair-hermes", label: "启用 Mia 稳定版" };
    if (state?.hermesInstallError) return { action: "retry-install-hermes", label: "重试启用稳定版" };
    if (hermes?.usableInMia || hermes?.installed || hermes?.health === "blocked" || hermes?.readiness?.status === "blocked") {
      return null;
    }
    return { action: "install-hermes", label: "启用 Mia 稳定版" };
  }

  function installAction(agent) {
    if (!agent) return null;
    if (agent.id === "hermes" && agent.health === "broken") {
      return { action: "repair-hermes", label: "启用 Mia 稳定版", engineId: "hermes" };
    }
    if (agent.usableInMia || agent.health === "blocked" || agent.readiness?.status === "blocked") return null;
    if (agent.id === "hermes" && agent.installAction === "repair-hermes") {
      return { action: "repair-hermes", label: "启用 Mia 稳定版", engineId: "hermes" };
    }
    if (agent.installed && agent.installAction) {
      return { action: agent.installAction, label: "启用 Mia 稳定版", engineId: agent.id };
    }
    if (agent.installed) return null;
    if (agent.id === "hermes" && (agent.installable || agent.installAction)) {
      return {
        action: agent.health === "broken" || agent.installAction === "repair-hermes" ? "repair-hermes" : "install-hermes",
        label: "启用 Mia 稳定版",
        engineId: "hermes"
      };
    }
    return agent.installable && agent.installAction
      ? { action: agent.installAction, label: "启用 Mia 稳定版", engineId: agent.id }
      : null;
  }

  function actionView(engineId, action) {
    if (!action) return null;
    const installing = Boolean(state?.agentSetupInstallInFlight);
    const current = installing && state.agentSetupInstallEngine === engineId;
    const percent = progress(engineId);
    return {
      action: action.action,
      disabled: installing,
      engineId: action.engineId,
      label: current ? `安装中${percent === null ? "..." : ` ${percent}%`}` : action.label,
      progress: current ? percent : null
    };
  }

  function canConfigureHermes(runtime, hermes = runtime?.agentInventory?.agents?.find((agent) => agent.id === "hermes")) {
    if (hermes) return Boolean(hermes.usableInMia);
    const source = String(runtime?.engineSource || "");
    return Boolean(
      runtime?.engineInstalled
      || ["bundled", "managed", "mia-managed", "local-source", "maintained-local-source", "system"].includes(source)
    );
  }

  function setStatus(element, text) {
    if (!element) return;
    element.textContent = String(text || "");
    element.title = String(text || "");
  }

  function renderDetection(runtime) {
    const engines = runtime?.agentEngines || {};
    const inventory = inventoryById(runtime);
    setStatus(els?.engineRowHermes, hermesLine(runtime, inventory.hermes));
    const canConfigure = canConfigureHermes(runtime, inventory.hermes);
    els?.engineRowHermesButton?.classList?.toggle("config-disabled", !canConfigure);
    els?.engineRowHermesButton?.setAttribute?.("aria-disabled", canConfigure ? "false" : "true");
    if (els?.engineRowHermesButton && "tabIndex" in els.engineRowHermesButton) {
      els.engineRowHermesButton.tabIndex = canConfigure ? 0 : -1;
    }
    if (!canConfigure && els?.modelForm) {
      els.engineRowHermesButton?.setAttribute?.("aria-expanded", "false");
      if (global.miaAccordion?.setElementOpen) global.miaAccordion.setElementOpen(els.modelForm, false);
      else els.modelForm.classList.toggle("hidden", true);
    }
    setStatus(
      els?.engineRowClaude,
      detectedLine(inventory["claude-code"] || legacyStatus("claude-code", engines.claudeCode), "claude-code")
    );
    setStatus(els?.engineRowCodex, detectedLine(inventory.codex || legacyStatus("codex", engines.codex), "codex"));
    const actions = {};
    for (const id of ["hermes", "claude-code", "codex"]) actions[id] = actionView(id, installAction(inventory[id]));
    global.miaReactSettingsCompat?.publish?.({ engineActions: actions });
    els?.engineInstallActions?.classList?.add?.("hidden");
    els?.engineInstallActions?.replaceChildren?.();
  }

  global.miaEngineDetectionController = {
    canConfigureHermes,
    hermesSetupAction,
    init,
    renderDetection,
    renderHermesInstallState
  };
})(typeof window !== "undefined" ? window : globalThis);
