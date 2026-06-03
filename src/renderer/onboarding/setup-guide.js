// Setup guide / onboarding module
// Extracted from app.js. Renders the "no fellow yet" / "pick an engine" /
// "create first fellow" guide that takes over the chat panel during onboarding.
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
        installable: false,
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
        installable: false,
        path: engines.codex?.path || "",
        version: engines.codex?.version || "",
        source: engines.codex?.available ? "system" : "missing",
        health: engines.codex?.available ? "ready" : "missing"
      },
      {
        id: "openclaw",
        label: "OpenClaw",
        installed: Boolean(engines.openClaw?.installed || engines.openClaw?.available),
        usableInMia: false,
        installable: false,
        detectionOnly: true,
        path: engines.openClaw?.path || "",
        version: engines.openClaw?.version || "",
        source: engines.openClaw?.installed ? "system" : "missing",
        health: engines.openClaw?.installed ? "detected" : "missing"
      }
    ];
  }

  function detectedLocalAgentLabels(runtime = state?.runtime) {
    return inventoryAgents(runtime)
      .filter((agent) => agent.usableInMia)
      .map((agent) => agent.label);
  }

  function shouldShowSetupGuide({ messages }) {
    if (!state || !state.runtime) return false;
    const fellows = state.runtime.fellows || state.runtime.personas || [];
    if (fellows.length === 0) return !state.agentSetupSkipped;
    if (state.setupGuideDismissed) return false;
    if (messages.length > 0) return false;
    return false;
  }

  function versionLabel(agent) {
    const version = String(agent.version || "").trim();
    if (!version) return "";
    return version.split(/\s+/).slice(0, 2).join(" ");
  }

  function agentStatusText(agent) {
    if (agent.id === "hermes" && agent.usableInMia) {
      if (agent.source === "mia-bundled") return "随 Mia 安装包内置，可用于本机聊天";
      if (agent.source === "mia-managed") return "Mia 独立副本已安装，可用于本机聊天";
      return "Hermes 可用于本机聊天";
    }
    if (agent.usableInMia) {
      const parts = [agent.path || "已检测到", versionLabel(agent)].filter(Boolean);
      return parts.join(" · ");
    }
    if (agent.installed && agent.detectionOnly) return "已检测到，暂未接入 Mia 聊天";
    if (agent.id === "hermes" && agent.installed) return "已检测到系统 Hermes，当前 Mia 仍需要独立副本";
    if (agent.id === "hermes") return "未安装，可安装到 Mia 私有目录";
    if (agent.id === "claude-code") return "未检测到，需要先安装 Claude Code";
    if (agent.id === "codex") return "未检测到，需要先安装 Codex CLI";
    return "未检测到";
  }

  function agentAction(agent) {
    if (agent.usableInMia && ["hermes", "claude-code", "codex"].includes(agent.id)) {
      return { action: "use-engine", label: `使用 ${agent.label}` };
    }
    if (agent.id === "hermes" && agent.installAction === "install-hermes") {
      return { action: "install-hermes", label: "安装 Hermes" };
    }
    return null;
  }

  function engineChoiceRow(agent) {
    const available = Boolean(agent.usableInMia);
    const stateClass = available ? "" : " unavailable";
    const action = agentAction(agent);
    const actionAttr = action ? `data-setup-action="${action.action}" data-engine="${agent.id}"` : "";
    const button = action
      ? `<button class="setup-engine-action${available ? " primary" : ""}" type="button" ${actionAttr}>${escapeHtml(action.label)}</button>`
      : "";
    return `
      <div class="setup-engine-row${stateClass}" data-engine-id="${escapeHtml(agent.id)}">
        <span class="setup-engine-dot ${escapeHtml(agent.id)}"></span>
        <div class="setup-engine-body">
          <strong>${escapeHtml(agent.label)}</strong>
          <small>${escapeHtml(agentStatusText(agent))}</small>
        </div>
        ${button}
      </div>
    `;
  }

  function renderSetupGuide() {
    if (!state) return "";
    const runtime = state.runtime || {};
    const fellows = runtime.fellows || runtime.personas || [];

    // If no fellow exists, force flow into onboarding regardless of prior dismiss.
    if (fellows.length === 0 && state.onboardingStep === "done") {
      state.onboardingStep = "engine";
    }

    if (state.onboardingStep === "create-fellow") {
      return renderSetupGuideCreateFellowStep();
    }

    const agents = inventoryAgents(runtime);
    const hasUsableAgent = agents.some((agent) => agent.usableInMia);
    const kicker = hasUsableAgent ? "第 1 步 / 共 2 步" : "本机 Agent";
    const title = hasUsableAgent ? "选个 Agent 引擎" : "这台电脑还没有可用 Agent";
    const body = hasUsableAgent
      ? "这是你的第一个伙伴默认会用的引擎，以后任意时候都能换。"
      : "可以先安装 Hermes，也可以跳过安装进入 Mia。";

    return `
      <article class="setup-guide">
        <div class="setup-guide-main">
          <span class="setup-kicker">${escapeHtml(kicker)}</span>
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(body)}</p>
        </div>
        <div class="setup-engine-list">
          ${agents.map(engineChoiceRow).join("")}
        </div>
        ${hasUsableAgent ? "" : `
          <div class="setup-actions" style="justify-content: flex-start;">
            <button class="setup-action secondary" type="button" data-setup-action="continue-no-agent">暂不安装，继续进入 Mia</button>
          </div>
        `}
      </article>
    `;
  }

  function renderSetupGuideCreateFellowStep() {
    if (!state) return "";
    const engine = state.onboardingPickedEngine || "hermes";
    const label = engine === "hermes" ? "Hermes" : engine === "claude-code" ? "Claude Code" : "Codex";
    return `
      <article class="setup-guide">
        <div class="setup-guide-main">
          <span class="setup-kicker">第 2 步 / 共 2 步</span>
          <strong>创建你的第一个伙伴</strong>
          <p>名字、头像、人设都已经预填好，点 "开始创建" 后可以随便改。引擎已选：<b>${escapeHtml(label)}</b>。</p>
        </div>
        <div class="setup-actions" style="justify-content: flex-start;">
          <button class="setup-action primary" type="button" data-setup-action="create-first-fellow">开始创建</button>
        </div>
      </article>
    `;
  }

  window.miaSetupGuide = {
    initSetupGuide,
    detectedLocalAgentLabels,
    shouldShowSetupGuide,
    engineChoiceRow,
    renderSetupGuide,
    renderSetupGuideCreateFellowStep,
  };
})();
