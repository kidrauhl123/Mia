// Setup guide / onboarding module
// Extracted from app.js. Renders the "no bot yet" / "pick an engine" /
// "create first bot" guide that takes over the chat panel during onboarding.
//
// Defensive `if (!state)` guards keep early calls safe.
(function () {
  "use strict";

  let state;
  let escapeHtml;

  function initSetupGuide(deps) {
    state = deps.state;
    escapeHtml = deps.escapeHtml;
  }

  function inventoryAgents(runtime = state?.runtime) {
    const agents = runtime?.agentInventory?.agents;
    if (Array.isArray(agents) && agents.length) return agents;
    const engines = runtime?.agentEngines || {};
    return [
      {
        id: "hermes",
        label: "Hermes",
        installed: Boolean(runtime?.engineInstalled),
        usableInMia: Boolean(runtime?.engineInstalled),
        installable: true,
        installAction: runtime?.engineInstalled ? "" : "install-hermes",
        source: runtime?.engineSource || "missing",
        health: runtime?.engineInstalled ? "ready" : "missing"
      },
      {
        id: "claude-code",
        label: "Claude Code",
        installed: Boolean(engines.claudeCode?.installed || engines.claudeCode?.available),
        usableInMia: Boolean(engines.claudeCode?.available),
        installable: true,
        installAction: engines.claudeCode?.available ? "" : "install-claude-code",
        path: engines.claudeCode?.path || "",
        version: engines.claudeCode?.version || "",
        source: engines.claudeCode?.available ? "system" : "missing",
        health: engines.claudeCode?.available ? "ready" : "missing"
      },
      {
        id: "codex",
        label: "Codex",
        installed: Boolean(engines.codex?.installed || engines.codex?.available),
        usableInMia: Boolean(engines.codex?.available),
        installable: true,
        installAction: engines.codex?.available ? "" : "install-codex",
        path: engines.codex?.path || "",
        version: engines.codex?.version || "",
        source: engines.codex?.available ? "system" : "missing",
        health: engines.codex?.available ? "ready" : "missing"
      }
    ];
  }

  function detectedLocalAgentLabels(runtime = state?.runtime) {
    return inventoryAgents(runtime)
      .filter((agent) => agent.usableInMia)
      .map((agent) => agent.label);
  }

  function isSetupInstallInFlight() {
    return Boolean(state?.agentSetupInstallInFlight);
  }

  function shouldShowSetupGuide({ messages }) {
    if (!state) return false;
    if (state.agentSetupSkipped) return false;
    if (state.setupGuideDismissed) return false;
    if (state.onboardingStep !== "engine") return false;
    if (messages.length > 0) return false;
    return true;
  }

  function versionLabel(agent) {
    const version = String(agent.version || "").trim();
    if (!version) return "";
    return version.split(/\s+/).slice(0, 2).join(" ");
  }

  function readinessSummary(agent) {
    const readiness = agent && agent.readiness;
    if (!readiness || readiness.checked === false) return "";
    return String(readiness.summary || readiness.detail || "").trim();
  }

  const AGENT_ICON_PATHS = {
    hermes: "./assets/engine-icons/hermesagent.svg",
    "claude-code": "./assets/engine-icons/claudecode.svg",
    codex: "./assets/engine-icons/codex-color.svg"
  };

  function agentIcon(agent) {
    const src = AGENT_ICON_PATHS[agent.id];
    if (src) {
      return `
        <span class="setup-engine-icon ${escapeHtml(agent.id)}" aria-hidden="true">
          <img src="${escapeHtml(src)}" alt="">
        </span>
      `;
    }
    const label = String(agent.label || agent.id || "?").trim();
    return `<span class="setup-engine-icon monogram" aria-hidden="true">${escapeHtml(label.slice(0, 2).toUpperCase())}</span>`;
  }

  function agentStatusText(agent) {
    if (state?.agentSetupInstallInFlight && state?.agentSetupInstallEngine === agent.id) {
      return state?.agentSetupInstallMessage || "Installing...";
    }
    if (agent.health === "checking" || agent.source === "checking") return "正在检查";
    if (agent.health === "blocked") return readinessSummary(agent) || "自检失败";
    if (agent.readiness?.status === "repairable") return readinessSummary(agent) || "状态异常，可修复";
    if (agent.usableInMia) {
      const parts = [agent.path || "已接入 Mia", versionLabel(agent)].filter(Boolean);
      return parts.join(" · ");
    }
    if (agent.installed && agent.detectionOnly) return "已就绪";
    if (agent.id === "hermes" && agent.health === "broken") return "官方 Hermes 状态异常，可修复";
    if (agent.id === "hermes" && state?.hermesInstallError) return "上次安装官方 Hermes 失败，可重试";
    if (agent.id === "hermes" && agent.installed) return "已检测到 Hermes，但当前安装方式暂不能用于 Mia";
    if (agent.id === "hermes") return "未检测到，可安装官方 Hermes";
    if (agent.id === "claude-code") return "未检测到，可一键安装 Claude Code";
    if (agent.id === "codex") return "未检测到，可一键安装 Codex";
    return "未检测到";
  }

  // All installable engines are treated alike: offer an install button whenever
  // one is missing (not gated on whether some other engine is usable). Hermes
  // additionally has repair / retry states.
  function agentAction(agent) {
    if (agent.health === "blocked" || agent.readiness?.status === "blocked") return null;
    if (agent.id === "hermes") {
      if (agent.health === "broken" || agent.installAction === "repair-hermes") {
        return { action: "repair-hermes", label: "修复官方 Hermes" };
      }
      if (!agent.usableInMia && !agent.installed) {
        if (state?.hermesInstallError) return { action: "retry-install-hermes", label: "重试安装官方 Hermes" };
        return { action: "install-hermes", label: "安装官方 Hermes" };
      }
      return null;
    }
    if (agent.installable && agent.installAction && !agent.usableInMia) {
      return { action: agent.installAction, label: `${agent.installed ? "修复" : "安装"} ${agent.label}` };
    }
    return null;
  }

  // Right-hand cell of a row: an action button when there's something to do
  // (install / repair / retry Hermes), otherwise a status badge so readiness is
  // scannable at a glance.
  function engineRight(agent) {
    const action = agentAction(agent);
    if (action) {
      const installingThis = state?.agentSetupInstallInFlight && state?.agentSetupInstallEngine === agent.id;
      const percent = Number(state?.agentSetupInstallPercent);
      const installLabel = installingThis && Number.isFinite(percent)
        ? `安装中 ${Math.max(0, Math.min(100, Math.round(percent)))}%`
        : action.label;
      return `<button class="setup-engine-action primary" type="button" data-setup-action="${action.action}" data-engine="${escapeHtml(agent.id)}"${isSetupInstallInFlight() ? " disabled" : ""}>${escapeHtml(installLabel)}</button>`;
    }
    if (agent.usableInMia) return `<span class="setup-engine-badge ok">已就绪</span>`;
    if (agent.installed && agent.detectionOnly) return `<span class="setup-engine-badge ok">已就绪</span>`;
    if (agent.health === "blocked" || agent.readiness?.status === "repairable") return `<span class="setup-engine-badge muted">需处理</span>`;
    return `<span class="setup-engine-badge muted">未检测到</span>`;
  }

  function engineChoiceRow(agent) {
    const stateClass = agent.usableInMia ? " ready" : " unavailable";
    return `
      <div class="setup-engine-row${stateClass}" data-engine-id="${escapeHtml(agent.id)}">
        ${agentIcon(agent)}
        <div class="setup-engine-body">
          <strong>${escapeHtml(agent.label)}</strong>
          <small>${escapeHtml(agentStatusText(agent))}</small>
        </div>
        ${engineRight(agent)}
      </div>
    `;
  }

  function renderSetupGuide() {
    if (!state) return "";
    if (!state.runtime || state.runtime?.agentInventory?.summary?.scanning) {
      return `
        <article class="setup-guide scanning">
          <div class="setup-scan-lottie" data-lottie="chemistry" data-lottie-trigger="loop" aria-hidden="true"></div>
          <div class="setup-guide-main">
            <span class="setup-kicker">Agent 内核设置</span>
            <strong>正在扫描本机 Agent</strong>
            <p>正在检查 Hermes、Claude Code 和 Codex 的本机安装状态。</p>
          </div>
        </article>
      `;
    }
    const runtime = state.runtime || {};

    const agents = inventoryAgents(runtime);

    return `
      <article class="setup-guide ready">
        <header class="setup-hero">
          <span class="setup-logo" aria-hidden="true">M</span>
          <h1 class="setup-title">欢迎使用 Mia</h1>
          <p class="setup-tagline">一个聊天界面，指挥你所有的 AI Agent。</p>
        </header>
        <section class="setup-section">
          <span class="setup-section-label">本机 Agent</span>
          <div class="setup-engine-list">
            ${agents.map(engineChoiceRow).join("")}
          </div>
        </section>
        <footer class="setup-footer">
          <button class="setup-cta" type="button" data-setup-action="finish-agent-scan"${isSetupInstallInFlight() ? " disabled" : ""}>进入 Mia</button>
        </footer>
      </article>
    `;
  }

  // Engine rows only, for reuse inside the onboarding wizard's "detect" step
  // (the wizard owns the surrounding shell + step navigation).
  function renderEngineList() {
    if (!state) return "";
    return inventoryAgents(state.runtime).map(engineChoiceRow).join("");
  }

  window.miaSetupGuide = {
    initSetupGuide,
    detectedLocalAgentLabels,
    shouldShowSetupGuide,
    engineChoiceRow,
    isSetupInstallInFlight,
    renderEngineList,
    renderSetupGuide,
  };
})();
