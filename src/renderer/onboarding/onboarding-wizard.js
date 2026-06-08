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

  // The wizard owns the whole signed-out state (Mia is cloud-login-required), so
  // a signed-out user — first run OR a returning/dirty install — always gets the
  // compact wizard login instead of the old full-width cloud-login screen. Once
  // signed in, the wizard only stays up while onboarding is mid-flight.
  function isActive() {
    if (!state) return false;
    if (!signedIn()) return true;
    if (state.agentSetupSkipped || state.setupGuideDismissed) return false;
    if (state.onboardingStep === "done") return false;
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

  function loginStepHtml() {
    const hint = state?.onboardingLoginHint || "";
    return `
      <header class="setup-hero">
        <img class="setup-logo-img" src="./assets/mia-logo.png" alt="Mia" draggable="false">
        <h1 class="setup-title">欢迎使用 Mia</h1>
        <p class="setup-tagline">一个聊天界面，指挥你所有的 AI Agent。先登录，把对话同步到云端。</p>
      </header>
      <form class="onb-login" data-onb-login>
        <input class="onb-input" type="text" name="username" autocomplete="username" placeholder="用户名" data-onb-login-username>
        <input class="onb-input" type="password" name="password" autocomplete="current-password" placeholder="密码（至少 6 位）" data-onb-login-password>
        <p class="onb-login-hint" data-onb-login-hint>${escapeHtml(hint)}</p>
      </form>
      <footer class="setup-footer onb-login-actions">
        <button class="setup-cta" type="button" data-onb-action="login">登录</button>
        <button class="onb-register-link" type="button" data-onb-action="register">没有账号？注册一个</button>
      </footer>
    `;
  }

  function scanRowStatus(agent) {
    if (!agent) return { text: "检测中…", cls: "checking" };
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
        <button class="setup-cta" type="button" data-onb-action="finish">进入 Mia</button>
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
      ? "login"
      : scan.status === "done"
        ? "prepare::done::" + (deps.renderEngineList?.() || "")
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

  // mode is "login" or "register" — the backend login does NOT auto-create
  // accounts, so first-run users must be able to explicitly register.
  async function submitLogin(container, mode = "login") {
    const username = container.querySelector("[data-onb-login-username]")?.value?.trim() || "";
    const password = container.querySelector("[data-onb-login-password]")?.value || "";
    const setHint = (text) => {
      const el = container.querySelector("[data-onb-login-hint]");
      if (el) el.textContent = text;
      state.onboardingLoginHint = text;
    };
    if (!username) return setHint("请输入用户名。");
    if (password.length < 6) return setHint("密码至少 6 位。");
    setHint(mode === "register" ? "正在注册并连接…" : "正在登录并连接…");
    try {
      const runtime = await deps.cloudLogin?.({ mode, username, password });
      if (runtime) state.runtime = runtime;
      if (signedIn()) {
        state.onboardingLoginHint = "";
        // A returning user who already finished onboarding just lands in the app;
        // a fresh user continues to the prepare (detect Agents) step.
        const onboarded = state.onboardingStep === "done" || state.agentSetupSkipped || state.setupGuideDismissed;
        if (onboarded) deps.rerender?.();
        else goToStep("prepare");
      } else {
        setHint(mode === "register" ? "注册未成功，请重试。" : "登录未成功，请检查或点下方注册。");
      }
    } catch (error) {
      setHint(`连接失败：${error?.message || error}`);
    }
  }

  function bind(container, step) {
    const wizard = container.querySelector(".onb-wizard");
    if (!wizard) return;
    deps.initLottie?.(container);
    if (step === "login") {
      container.querySelector("[data-onb-login]")?.addEventListener("submit", (event) => {
        event.preventDefault();
        submitLogin(container, "login");
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
      if (action === "login") return void submitLogin(container, "login");
      if (action === "register") return void submitLogin(container, "register");
      if (action === "finish") return void deps.finish?.();
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
