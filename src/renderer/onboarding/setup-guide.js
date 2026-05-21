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

  function detectedLocalAgentLabels(runtime = state?.runtime) {
    const engines = runtime?.agentEngines || {};
    const labels = [];
    if (engines.claudeCode?.available) labels.push("Claude Code");
    if (engines.codex?.available) labels.push("Codex");
    return labels;
  }

  function shouldShowSetupGuide({ messages }) {
    if (!state || !state.runtime) return false;
    // Onboarding takes over the chat panel until the user has at least one fellow.
    const fellows = state.runtime.fellows || state.runtime.personas || [];
    if (fellows.length === 0) return true;
    if (state.setupGuideDismissed) return false;
    if (messages.length > 0) return false;
    return true;
  }

  function engineChoiceRow({ id, label, status, available, action, actionLabel }) {
    const stateClass = available ? "" : " unavailable";
    const actionAttr = action ? `data-setup-action="${action}" data-engine="${id}"` : "";
    const button = action
      ? `<button class="setup-engine-action${available ? " primary" : ""}" type="button" ${actionAttr}>${escapeHtml(actionLabel)}</button>`
      : "";
    return `
      <div class="setup-engine-row${stateClass}" data-engine-id="${id}">
        <span class="setup-engine-dot ${id}"></span>
        <div class="setup-engine-body">
          <strong>${escapeHtml(label)}</strong>
          <small>${escapeHtml(status)}</small>
        </div>
        ${button}
      </div>
    `;
  }

  function renderSetupGuide() {
    if (!state) return "";
    const runtime = state.runtime || {};
    const engines = runtime.agentEngines || {};
    const source = runtime.engineSource;
    const fellows = runtime.fellows || runtime.personas || [];

    // If no fellow exists, force flow into onboarding regardless of prior dismiss.
    if (fellows.length === 0 && state.onboardingStep === "done") {
      state.onboardingStep = "engine";
    }

    if (state.onboardingStep === "create-fellow") {
      return renderSetupGuideCreateFellowStep();
    }

    // Default: "engine" step
    let hermesStatus;
    let hermesAvailable;
    let hermesAction;
    let hermesActionLabel;
    if (source === "bundled") {
      hermesStatus = "随 Aimashi 安装包内置，无需额外安装";
      hermesAvailable = true;
      hermesAction = "use-engine";
      hermesActionLabel = "使用 Hermes";
    } else if (source === "managed") {
      hermesStatus = "Aimashi 独立 Hermes 副本已安装";
      hermesAvailable = true;
      hermesAction = "use-engine";
      hermesActionLabel = "使用 Hermes";
    } else {
      hermesStatus = "未安装 · 点击会装一份独立副本到 Aimashi 私有目录（不影响你自己的 hermes）";
      hermesAvailable = false;
      hermesAction = "install-hermes";
      hermesActionLabel = "安装 Hermes";
    }

    const cc = engines.claudeCode || {};
    const claudeStatus = cc.available
      ? `${cc.path || "已检测到"}${cc.version ? ` · ${cc.version.split(" ")[0]}` : ""}`
      : "未检测到 · 需先用 npm 装 @anthropic-ai/claude-code";
    const codex = engines.codex || {};
    const codexStatus = codex.available
      ? `${codex.path || "已检测到"}${codex.version ? ` · ${codex.version.split(" ")[0]}` : ""}`
      : "未检测到 · 需先安装 OpenAI Codex CLI";

    return `
      <article class="setup-guide">
        <div class="setup-guide-main">
          <span class="setup-kicker">第 1 步 / 共 2 步</span>
          <strong>选个 Agent 引擎</strong>
          <p>这是你的第一个伙伴默认会用的引擎，以后任意时候都能换。</p>
        </div>
        <div class="setup-engine-list">
          ${engineChoiceRow({
            id: "hermes",
            label: "Hermes",
            status: hermesStatus,
            available: hermesAvailable,
            action: hermesAction,
            actionLabel: hermesActionLabel
          })}
          ${engineChoiceRow({
            id: "claude-code",
            label: "Claude Code",
            status: claudeStatus,
            available: cc.available,
            action: cc.available ? "use-engine" : "",
            actionLabel: "使用 Claude Code"
          })}
          ${engineChoiceRow({
            id: "codex",
            label: "Codex",
            status: codexStatus,
            available: codex.available,
            action: codex.available ? "use-engine" : "",
            actionLabel: "使用 Codex"
          })}
        </div>
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

  window.aimashiSetupGuide = {
    initSetupGuide,
    detectedLocalAgentLabels,
    shouldShowSetupGuide,
    engineChoiceRow,
    renderSetupGuide,
    renderSetupGuideCreateFellowStep,
  };
})();
