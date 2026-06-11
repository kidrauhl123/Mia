// First-run onboarding wizard.
//
// Turns the previously-scattered first-run screens (cloud login + local-agent
// detection) into one step-by-step flow that stays in the compact onboarding
// window. The wizard owns the shell (progress + step body); it reuses cloud
// login (window.mia.cloudLogin) and the engine list from setup-guide, and asks
// the app to advance/finish via injected callbacks.
//
// Steps (state.onboardingStep): "login" -> "prepare" -> "done".
//  - login   : required cloud sign-in (the flow can't pass until signed in).
//  - prepare : detect the local Agents (install button per missing one) and let
//              the user enter once they've reviewed it. This is also where the
//              first-run background config surfaces, instead of a silent stall.
//
// File access is intentionally NOT a step: agents default to a Mia-owned
// workspace (see main agentWorkspaceDir), and the working directory is a normal
// setting — no scary upfront permission prompts.
(function () {
  "use strict";

  const STEPS = ["login", "prepare"];
  const STEP_TITLES = { login: "登录", prepare: "准备 Mia" };

  let state = null;
  let escapeHtml = (value) => String(value == null ? "" : value);
  let deps = {};
  // Signature of the last DOM we rendered. A background runtime poll re-renders
  // the chat area every ~2s; without this guard the wizard would rebuild its
  // innerHTML each time — replaying the entry animation (logo/button flicker)
  // and wiping whatever the user has typed into the login form.
  let lastSig = null;
  // Prepare-step async scan state. status: idle → scanning → done. Per-agent
  // results land in scan[agentId] as they resolve.
  let scan = { status: "idle", done: 0, total: 4 };
  let loginFlow = null;
  let loginAttempt = 0;
  const SCAN_AGENTS = [
    { id: "hermes", label: "Hermes" },
    { id: "claude-code", label: "Claude Code" },
    { id: "codex", label: "Codex" },
    { id: "openclaw", label: "OpenClaw" },
  ];

  function initOnboardingWizard(injected) {
    state = injected.state;
    if (typeof injected.escapeHtml === "function") escapeHtml = injected.escapeHtml;
    deps = injected;
  }

  function signedIn() {
    return Boolean(state?.runtime?.cloud?.enabled);
  }

  function hasCompletedOnboarding() {
    return Boolean(state?.onboardingStep === "done" || state?.agentSetupSkipped || state?.setupGuideDismissed);
  }

  // The wizard owns first-run signed-out state, but not returning users who
  // already finished onboarding. If their token expires or they log out, keep
  // them in the normal app shell and show the regular cloud login guide.
  function isActive() {
    if (!state) return false;
    if (hasCompletedOnboarding()) return false;
    if (!signedIn()) return true;
    return STEPS.includes(state.onboardingStep);
  }

  // Step to actually show: not signed in → login; signed in → the prepare step
  // (login is satisfied, so never show it again).
  function currentStep() {
    if (!signedIn()) return "login";
    let step = STEPS.includes(state?.onboardingStep) ? state.onboardingStep : "prepare";
    if (step === "login") step = "prepare";
    return step;
  }

  function goToStep(step) {
    deps.setStep?.(step);
  }

  function isSetupInstallInFlight() {
    return Boolean(state?.agentSetupInstallInFlight);
  }

  function progressHtml(step) {
    const position = STEPS.indexOf(step);
    const dots = STEPS.map((_name, index) => {
      const cls = index < position ? "done" : index === position ? "active" : "";
      return `<span class="onb-progress-dot ${cls}" aria-hidden="true"></span>`;
    }).join("");
    return `
      <div class="onb-progress" role="presentation">
        <span class="onb-progress-step">第 ${position + 1} / ${STEPS.length} 步 · ${escapeHtml(STEP_TITLES[step])}</span>
        <div class="onb-progress-dots">${dots}</div>
      </div>
    `;
  }

  function wechatIconSvg() {
    return `<svg class="wechat-login-icon" viewBox="0 0 32 28" aria-hidden="true" focusable="false">
      <path class="wechat-bubble" d="M13.2 2.5C6.7 2.5 1.5 6.7 1.5 12c0 3.1 1.8 5.8 4.6 7.5l-.9 3.1 3.7-1.8c1.3.4 2.7.7 4.3.7.6 0 1.2 0 1.8-.1-.5-1-.8-2.1-.8-3.3 0-4.6 4.5-8.3 10.1-8.3h.4C23.5 5.6 18.8 2.5 13.2 2.5Z"/>
      <path class="wechat-bubble" d="M30.5 18.1c0-4.1-4.1-7.4-9.1-7.4s-9.1 3.3-9.1 7.4 4.1 7.4 9.1 7.4c1.2 0 2.3-.2 3.3-.6l3 1.5-.7-2.5c2.1-1.3 3.5-3.4 3.5-5.8Z"/>
      <circle class="wechat-eye" cx="9.6" cy="10.3" r="1.05"/>
      <circle class="wechat-eye" cx="16.6" cy="10.3" r="1.05"/>
      <circle class="wechat-eye" cx="18.4" cy="17" r=".9"/>
      <circle class="wechat-eye" cx="24.1" cy="17" r=".9"/>
    </svg>`;
  }

  function loginStepHtml() {
    const hint = state?.onboardingLoginHint || "";
    const qr = loginFlow?.qrCodeUrl
      ? `<div class="onb-login-qr-card">
          <img class="onb-login-qr-img" src="${escapeHtml(loginFlow.qrCodeUrl)}" alt="微信登录二维码" draggable="false">
        </div>
        <p class="onb-login-qr-note">用微信扫码关注公众号，Mia 会自动完成登录。</p>`
      : "";
    return `
      <header class="setup-hero${loginFlow?.qrCodeUrl ? " compact" : ""}">
        <img class="setup-logo-img" src="./assets/mia-logo.png" alt="Mia" draggable="false">
        <h1 class="setup-title">欢迎使用 Mia</h1>
        <p class="setup-tagline">一个聊天界面，指挥你所有的 AI Agent。先用微信登录，把对话同步到云端。</p>
      </header>
      <section class="onb-login" data-onb-login>
        ${qr}
        <p class="onb-login-hint" data-onb-login-hint>${escapeHtml(hint)}</p>
      </section>
      <footer class="setup-footer onb-login-actions">
        <button class="setup-cta wechat-login-cta" type="button" data-onb-action="login"${loginFlow?.qrCodeUrl ? " disabled" : ""}>${wechatIconSvg()}<span>${loginFlow?.qrCodeUrl ? "等待扫码" : "微信登录"}</span></button>
      </footer>
    `;
  }

  function scanRowStatus(agent) {
    if (!agent) return { text: "检测中…", cls: "checking" };
    if (agent.id === "openclaw" && agent.installed) return { text: "已就绪", cls: "ok" };
    if (agent.usableInMia) return { text: "已就绪", cls: "ok" };
    if (agent.installed) return { text: "已检测到", cls: "" };
    return { text: "未检测到", cls: "missing" };
  }

  function scanRowHtml(entry) {
    const { text, cls } = scanRowStatus(scan[entry.id]);
    return `
      <div class="onb-scan-row ${cls}" data-scan-id="${entry.id}">
        <span class="onb-scan-name">${escapeHtml(entry.label)}</span>
        <span class="onb-scan-status">${escapeHtml(text)}</span>
      </div>
    `;
  }

  // Loading view: a progress bar + per-agent rows that fill in as the async scan
  // reports each agent, so the user sees what Mia is doing instead of a frozen
  // window.
  function scanningStepHtml() {
    const pct = Math.round((scan.done / scan.total) * 100);
    return `
      <header class="setup-hero compact">
        <img class="setup-logo-img" src="./assets/mia-logo.png" alt="Mia" draggable="false">
        <h1 class="setup-title">正在准备 Mia</h1>
        <p class="setup-tagline">正在检测本机已安装的 Agent…</p>
      </header>
      <section class="setup-section">
        <div class="onb-progress-bar"><div class="onb-progress-fill" data-onb-progress-fill style="width:${pct}%"></div></div>
        <div class="setup-engine-list">${SCAN_AGENTS.map(scanRowHtml).join("")}</div>
      </section>
    `;
  }

  function preparedStepHtml() {
    const list = deps.renderEngineList?.() || "";
    return `
      <header class="setup-hero compact">
        <h1 class="setup-title">本机 Agent</h1>
        <p class="setup-tagline">Mia 复用你已装好的 Agent，用自己的配置和记忆，不改它们的数据。没装的可以在这里装。</p>
      </header>
      <section class="setup-section">
        <div class="setup-engine-list">${list}</div>
      </section>
      <footer class="setup-footer">
        <button class="setup-cta" type="button" data-onb-action="finish"${isSetupInstallInFlight() ? " disabled" : ""}>进入 Mia</button>
      </footer>
    `;
  }

  function prepareStepHtml() {
    return scan.status === "done" ? preparedStepHtml() : scanningStepHtml();
  }

  function stepBodyHtml(step) {
    return step === "login" ? loginStepHtml() : prepareStepHtml();
  }

  // Update the scanning view in place (no re-render) as progress arrives, so the
  // bar animates and rows flip without replaying the entry animation.
  function updateScanDom() {
    const root = document.querySelector(".onb-wizard");
    if (!root) return;
    const fill = root.querySelector("[data-onb-progress-fill]");
    if (fill) fill.style.width = Math.round((scan.done / scan.total) * 100) + "%";
    for (const entry of SCAN_AGENTS) {
      const agent = scan[entry.id];
      if (!agent) continue;
      const row = root.querySelector(`[data-scan-id="${entry.id}"]`);
      if (!row) continue;
      const { text, cls } = scanRowStatus(agent);
      row.className = `onb-scan-row ${cls}`;
      const status = row.querySelector(".onb-scan-status");
      if (status) status.textContent = text;
    }
  }

  async function startScan() {
    if (scan.status !== "idle") return;
    scan = { status: "scanning", done: 0, total: 4 };
    const unsubscribe = deps.onScanProgress?.((payload) => {
      if (!payload || !payload.agent) return;
      scan[payload.agent.id] = payload.agent;
      if (typeof payload.done === "number") scan.done = payload.done;
      updateScanDom();
    });
    try {
      const result = await deps.scanAgents?.();
      if (result && result.inventory) {
        state.runtime = state.runtime || {};
        state.runtime.agentInventory = result.inventory;
        if (result.agentEngines) state.runtime.agentEngines = result.agentEngines;
      }
    } catch { /* fall through to done */ }
    if (typeof unsubscribe === "function") unsubscribe();
    scan.status = "done";
    deps.rerender?.();
  }

  function render(container) {
    if (!container || !state) return;
    const step = currentStep();
    // Only the prepare step's content changes with runtime polls (engine list);
    // the login step is static, so its signature stays constant and a background
    // re-render is a no-op — keeping the form contents and avoiding flicker. The
    // hint updates in place via setHint, so it stays out of the signature.
    // login: static. prepare/scanning: constant sig (progress updates happen in
    // place via updateScanDom, never a full re-render). prepare/done: keyed on
    // the engine list so an install result refreshes it.
    const sig = step === "login"
      ? "login::" + (loginFlow?.state || "")
      : scan.status === "done"
        ? "prepare::done::" + (deps.renderEngineList?.() || "") + "::installing::" + (isSetupInstallInFlight() ? "1" : "0")
        : "prepare::scanning";
    if (lastSig === sig && container.querySelector(".onb-wizard")) return;
    lastSig = sig;
    container.innerHTML = `
      <article class="setup-guide ready onb-wizard" data-onb-step="${escapeHtml(step)}">
        ${progressHtml(step)}
        ${stepBodyHtml(step)}
      </article>
    `;
    bind(container, step);
  }

  async function submitLogin(container) {
    const setHint = (text) => {
      const el = container.querySelector("[data-onb-login-hint]");
      if (el) el.textContent = text;
      state.onboardingLoginHint = text;
    };
    const attempt = loginAttempt + 1;
    loginAttempt = attempt;
    loginFlow = null;
    setHint("正在生成微信登录二维码…");
    deps.rerender?.();
    try {
      const started = await deps.cloudLogin?.({ mode: "wechat", action: "start" });
      if (!started?.state || !started?.qrCodeUrl) throw new Error("微信登录二维码生成失败。");
      if (attempt !== loginAttempt) return;
      loginFlow = started;
      state.onboardingLoginHint = "等待微信扫码关注…";
      deps.rerender?.();
      pollLogin(container, attempt);
    } catch (error) {
      loginFlow = null;
      setHint(`连接失败：${error?.message || error}`);
      deps.rerender?.();
    }
  }

  async function pollLogin(container, attempt) {
    if (!loginFlow?.state || attempt !== loginAttempt) return;
    const setHint = (text) => {
      const el = container.querySelector("[data-onb-login-hint]");
      if (el) el.textContent = text;
      state.onboardingLoginHint = text;
    };
    try {
      const runtime = await deps.cloudLogin?.({ mode: "wechat", action: "complete", state: loginFlow.state });
      if (attempt !== loginAttempt) return;
      if (runtime?.status === "pending") {
        setHint("二维码已生成，等待微信扫码关注…");
        setTimeout(() => pollLogin(container, attempt), 1500);
        return;
      }
      if (runtime) state.runtime = runtime;
      if (signedIn()) {
        loginFlow = null;
        state.onboardingLoginHint = "";
        const onboarded = hasCompletedOnboarding();
        if (onboarded) deps.rerender?.();
        else goToStep("prepare");
      } else {
        loginFlow = null;
        setHint("微信登录未成功，请重试。");
        deps.rerender?.();
      }
    } catch (error) {
      if (attempt !== loginAttempt) return;
      loginFlow = null;
      setHint(`连接失败：${error?.message || error}`);
      deps.rerender?.();
    }
  }

  function bind(container, step) {
    const wizard = container.querySelector(".onb-wizard");
    if (!wizard) return;
    deps.initLottie?.(container);
    if (step === "login") {
      container.querySelector("[data-onb-login]")?.addEventListener("submit", (event) => {
        event.preventDefault();
        submitLogin(container);
      });
    }
    // Kick off the async agent scan the first time the prepare step shows.
    if (step === "prepare" && scan.status === "idle") startScan();
    // data-onb-action is the wizard's own nav. Engine install/repair buttons use
    // data-setup-action and are handled by the app's existing delegated handler.
    wizard.addEventListener("click", (event) => {
      const target = event.target.closest("[data-onb-action]");
      if (!target) return;
      const action = target.dataset.onbAction;
      if (action === "login") return void submitLogin(container);
      if (action === "finish") {
        if (isSetupInstallInFlight()) return;
        return void deps.finish?.();
      }
    });
  }

  window.miaOnboardingWizard = {
    initOnboardingWizard,
    isActive,
    currentStep,
    render,
    STEPS,
  };
})();
