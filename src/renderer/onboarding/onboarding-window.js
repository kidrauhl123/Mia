// Standalone onboarding window controller. Self-contained (no app.js / app
// modules) so the window stays lightweight and opens instantly. Talks to main
// only through the preload bridge (window.mia).
//
// Flow: login/register (required) -> async agent scan (progress) -> review/enter.
// On finish it asks main to swap this window over to the full app.
(function () {
  "use strict";

  const root = document.getElementById("onb-root");
  const mia = window.mia || {};
  const rendererPlatform = String(mia.platform || "unknown");
  document.body.classList.toggle("platform-win32", rendererPlatform === "win32");
  document.body.classList.toggle("platform-darwin", rendererPlatform === "darwin");
  document.body.classList.toggle("platform-linux", rendererPlatform === "linux");
  const AGENTS = [
    { id: "hermes", label: "Hermes" },
    { id: "claude-code", label: "Claude Code" },
    { id: "codex", label: "Codex" },
  ];
  const AGENT_ICONS = {
    hermes: "../assets/engine-icons/hermesagent.svg",
    "claude-code": "../assets/engine-icons/claudecode.svg",
    codex: "../assets/engine-icons/codex-color.svg"
  };
  const INSTALL_MESSAGE_MAX = 72;

  let step = "login"; // login | scan | done
  let hint = "";
  let loginFlow = null;
  let loginAttempt = 0;
  let scan = { done: 0, total: 3, byId: {} };
  let inventory = null;
  let renderTimer = 0;
  let nativeControlsVisible = null;
  const installStates = {};

  function hasActiveInstall() {
    return Object.values(installStates).some((install) => install?.status === "installing");
  }

  function isAgentReady(id) {
    const agent = ((inventory && inventory.agents) || []).find((item) => item.id === id);
    return Boolean(agent && (agent.usableInMia || (agent.installed && agent.detectionOnly)));
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]
    ));
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

  function backIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M15.8 5.2 9 12l6.8 6.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  function dotsHtml(active) {
    const order = ["login", "prepare"];
    const pos = active === "login" ? 0 : 1;
    return `<div class="onb-dots">${order.map((_n, i) => `<span class="onb-dot ${i < pos ? "done" : i === pos ? "active" : ""}"></span>`).join("")}</div>`;
  }

  function loginHtml() {
    if (loginFlow?.qrCodeUrl) {
      const qrHint = hint && !/二维码已生成|等待微信扫码/.test(hint)
        ? `<p class="onb-hint onb-qr-hint" data-hint>${esc(hint)}</p>`
        : "";
      return `
        <section class="onb-wechat-login" data-login>
          <button class="onb-back" type="button" data-action="back" aria-label="返回" title="返回">${backIconSvg()}</button>
          <header class="onb-wechat-head">
            <div class="onb-wechat-title">${wechatIconSvg()}<h1>微信登录</h1></div>
            <p>请使用微信扫描二维码登录</p>
          </header>
          <div class="onb-qr-card">
            <img class="onb-qr-img" src="${esc(loginFlow.qrCodeUrl)}" alt="微信登录二维码" draggable="false">
          </div>
          <p class="onb-qr-note">使用微信扫一扫登录</p>
          ${qrHint}
        </section>
      `;
    }
    return `
      <p class="onb-step">第 1 / 2 步 · 登录</p>
      ${dotsHtml("login")}
      <div class="onb-hero">
        <img class="onb-logo" src="../assets/mia-logo.png" alt="Mia" draggable="false">
        <h1 class="onb-title">欢迎使用 Mia</h1>
        <p class="onb-tagline">一个聊天界面，指挥你所有的 AI Agent。先用微信登录，把对话同步到云端。</p>
      </div>
      <section class="onb-form" data-login>
        <p class="onb-hint" data-hint>${esc(hint)}</p>
      </section>
      <div class="onb-spacer"></div>
      <div class="onb-footer">
        <button class="onb-cta wechat-login-cta" type="button" data-action="login">${wechatIconSvg()}<span>微信登录</span></button>
      </div>
    `;
  }

  function rowStatus(agent) {
    if (!agent) return { text: "检测中…", cls: "checking" };
    const readiness = agent.readiness || {};
    const readinessText = String(readiness.summary || readiness.detail || "").trim();
    if (agent.health === "blocked" || readiness.status === "blocked") {
      return { text: readinessText || "需修复", cls: "error" };
    }
    if (agent.health === "broken" || readiness.status === "repairable") {
      return { text: readinessText || "可修复", cls: "error" };
    }
    if (agent.usableInMia) return { text: "已就绪", cls: "ok" };
    if (agent.installed) return { text: "已检测到", cls: "" };
    return { text: "未检测到", cls: "missing" };
  }

  function agentIcon(def) {
    const src = AGENT_ICONS[def.id];
    const fallback = String(def.label || def.id || "?").slice(0, 2).toUpperCase();
    if (!src) return `<span class="onb-row-icon monogram" aria-hidden="true">${esc(fallback)}</span>`;
    return `<span class="onb-row-icon ${esc(def.id)}" aria-hidden="true"><img src="${esc(src)}" alt=""></span>`;
  }

  function shortMessage(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > INSTALL_MESSAGE_MAX ? `${text.slice(0, INSTALL_MESSAGE_MAX - 1)}…` : text;
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = 0;
      render();
    }, 120);
  }

  function scanRowsHtml() {
    return AGENTS.map((a) => {
      const { text, cls } = rowStatus(scan.byId[a.id]);
      return `<div class="onb-row ${cls}" data-row="${a.id}">
        ${agentIcon(a)}
        <span class="onb-row-main"><span class="onb-row-name">${esc(a.label)}</span></span>
        <span class="onb-row-status">${esc(text)}</span>
      </div>`;
    }).join("");
  }

  function scanHtml() {
    const pct = Math.round((scan.done / scan.total) * 100);
    return `
      <p class="onb-step">第 2 / 2 步 · 准备</p>
      ${dotsHtml("prepare")}
      <div class="onb-hero">
        <img class="onb-logo" src="../assets/mia-logo.png" alt="Mia" draggable="false">
        <h1 class="onb-title">正在准备 Mia</h1>
        <p class="onb-tagline">正在检测本机已安装的 Agent…</p>
      </div>
      <div class="onb-bar"><div class="onb-bar-fill" data-fill style="width:${pct}%"></div></div>
      <div class="onb-list">${scanRowsHtml()}</div>
      <div class="onb-spacer"></div>
    `;
  }

  function doneRowsHtml() {
    const agents = (inventory && inventory.agents) || [];
    return AGENTS.map((def) => {
      const agent = agents.find((x) => x.id === def.id) || scan.byId[def.id];
      const install = installStates[def.id];
      const installing = install && install.status === "installing";
      const failed = install && install.status === "error";
      const { text, cls } = rowStatus(agent);
      const canInstall = !installing && agent && agent.installable && !agent.usableInMia && agent.installAction;
      const installPercent = Number(install?.percent);
      const percent = Number.isFinite(installPercent) ? Math.max(0, Math.min(100, Math.round(installPercent))) : null;
      const detail = install?.message
        ? `<small class="onb-row-detail ${failed ? "error" : ""}" title="${esc(install.message)}">${esc(shortMessage(install.message))}</small>`
        : "";
      const progress = installing ? `<span class="onb-row-progress" aria-hidden="true"><span style="width:${percent === null ? 18 : Math.max(4, percent)}%"></span></span>` : "";
      const right = installing
        ? `<button class="onb-row-btn" type="button" disabled>${percent === null ? "启用中" : `启用中 ${percent}%`}</button>`
        : canInstall
        ? `<button class="onb-row-btn" type="button" data-install="${def.id}">启用稳定版</button>`
        : `<span class="onb-row-status">${esc(text)}</span>`;
      return `<div class="onb-row ${cls} ${installing ? "installing" : ""} ${failed ? "error" : ""}" data-row="${def.id}">
        ${agentIcon(def)}
        <span class="onb-row-main"><span class="onb-row-name">${esc(def.label)}</span>${detail}${progress}</span>${right}
      </div>`;
    }).join("");
  }

  function doneHtml() {
    return `
      <p class="onb-step">第 2 / 2 步 · 准备</p>
      ${dotsHtml("prepare")}
      <div class="onb-hero">
        <h1 class="onb-title">本机 Agent</h1>
        <p class="onb-tagline">优先复用本机 Agent；缺失时可启用 Mia 自带的固定稳定版，不改动系统安装。</p>
      </div>
      <div class="onb-list">${doneRowsHtml()}</div>
      <div class="onb-spacer"></div>
      <div class="onb-footer">
        <button class="onb-cta" type="button" data-action="finish"${hasActiveInstall() ? " disabled" : ""}>进入 Mia</button>
      </div>
    `;
  }

  function render() {
    if (!root) return;
    root.dataset.step = step;
    root.innerHTML = step === "login" ? loginHtml() : step === "scan" ? scanHtml() : doneHtml();
    syncNativeControls();
    bind();
  }

  function syncNativeControls() {
    const shouldShow = !(step === "login" && loginFlow?.qrCodeUrl);
    if (nativeControlsVisible === shouldShow) return;
    nativeControlsVisible = shouldShow;
    mia.window?.setNativeControlsVisible?.(shouldShow);
  }

  function wireWindowControls() {
    const controls = document.getElementById("onbWindowControls");
    const api = mia.window;
    if (!controls || !api) return;
    const maximizeButton = controls.querySelector('[data-window-action="maximize"]');
    const applyMaximized = (maximized) => {
      document.body.classList.toggle("window-maximized", Boolean(maximized));
      if (!maximizeButton) return;
      const label = maximized ? "还原" : "最大化";
      maximizeButton.setAttribute("aria-label", label);
      maximizeButton.title = label;
    };
    const applyFocus = (focused) => {
      document.body.classList.toggle("window-blurred", !focused);
    };
    controls.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-window-action]");
      if (!btn) return;
      event.preventDefault();
      event.stopPropagation();
      const action = btn.dataset.windowAction;
      if (action === "close") api.close?.();
      else if (action === "minimize") api.minimize?.();
      else if (action === "maximize") {
        Promise.resolve(api.maximize?.() || api.green?.()).then((state) => {
          if (state && Object.prototype.hasOwnProperty.call(state, "maximized")) applyMaximized(state.maximized);
        }).catch(() => {});
      }
    });
    controls.addEventListener("pointerdown", (event) => {
      if (!event.target.closest("[data-window-action]")) return;
      event.stopPropagation();
    });
    api.onFocusState?.(applyFocus);
    api.onMaximized?.(applyMaximized);
    api.state?.().then((state) => {
      if (!state) return;
      applyFocus(state.focused);
      applyMaximized(state.maximized);
    }).catch(() => {});
  }

  function setHint(text) {
    hint = text;
    const el = root.querySelector("[data-hint]");
    if (el) el.textContent = text;
  }

  function cloudLoginErrorCopy(error) {
    let message = String(error?.message || error || "").trim();
    message = message.replace(/^Error invoking remote method 'cloud:login':\s*/i, "").trim();
    message = message.replace(/^Error:\s*/i, "").trim();
    if (/fetch failed|failed to fetch/i.test(message)) {
      return "连接 Mia Cloud 失败，请检查网络后重试。";
    }
    return message || "连接 Mia Cloud 失败，请检查网络后重试。";
  }

  async function submitLogin() {
    const attempt = loginAttempt + 1;
    loginAttempt = attempt;
    loginFlow = null;
    setHint("正在生成微信登录二维码…");
    render();
    try {
      const started = await mia.cloudLogin?.({ mode: "wechat", action: "start" });
      if (!started?.state || !started?.qrCodeUrl) throw new Error("微信登录二维码生成失败。");
      if (attempt !== loginAttempt) return;
      loginFlow = started;
      hint = "等待微信扫码授权…";
      render();
      pollLogin(attempt);
    } catch (error) {
      if (attempt !== loginAttempt) return;
      loginFlow = null;
      setHint(`连接失败：${cloudLoginErrorCopy(error)}`);
      render();
    }
  }

  async function pollLogin(attempt) {
    if (!loginFlow?.state || attempt !== loginAttempt) return;
    try {
      const result = await mia.cloudLogin?.({ mode: "wechat", action: "complete", state: loginFlow.state });
      if (attempt !== loginAttempt) return;
      if (result?.status === "pending") {
        setHint("二维码已生成，等待微信扫码授权…");
        setTimeout(() => pollLogin(attempt), 1500);
        return;
      }
      if (result?.cloud?.enabled) {
        loginFlow = null;
        hint = "";
        step = "scan";
        render();
        startScan();
        return;
      }
      setHint("微信登录未成功，请重试。");
      loginFlow = null;
      render();
    } catch (error) {
      if (attempt !== loginAttempt) return;
      loginFlow = null;
      setHint(`连接失败：${cloudLoginErrorCopy(error)}`);
      render();
    }
  }

  function updateScanDom() {
    const fill = root.querySelector("[data-fill]");
    if (fill) fill.style.width = Math.round((scan.done / scan.total) * 100) + "%";
    for (const def of AGENTS) {
      const agent = scan.byId[def.id];
      if (!agent) continue;
      const row = root.querySelector(`[data-row="${def.id}"]`);
      if (!row) continue;
      const { text, cls } = rowStatus(agent);
      row.className = `onb-row ${cls}`;
      const status = row.querySelector(".onb-row-status");
      if (status) status.textContent = text;
    }
  }

  async function startScan() {
    scan = { done: 0, total: AGENTS.length, byId: {} };
    const unsubscribe = mia.onAgentScanProgress?.((payload) => {
      if (!payload || !payload.agent) return;
      scan.byId[payload.agent.id] = payload.agent;
      if (typeof payload.done === "number") scan.done = payload.done;
      updateScanDom();
    });
    try {
      const result = await mia.scanAgents?.();
      if (result && result.inventory) inventory = result.inventory;
    } catch { /* fall through to done */ }
    if (typeof unsubscribe === "function") unsubscribe();
    step = "done";
    render();
  }

  async function installAgent(id, button) {
    if (!mia.installEngine) return;
    installStates[id] = { status: "installing", message: "正在准备 Mia 稳定版...", percent: 0 };
    render();
    try {
      await mia.installEngine(id);
      installStates[id] = { status: "installing", message: "稳定版已启用，正在重新检测...", percent: 100 };
      const result = await mia.scanAgents?.();
      if (result && result.inventory) inventory = result.inventory;
      if (isAgentReady(id)) delete installStates[id];
      else installStates[id] = { status: "error", message: "稳定版已启用，但 Mia 自检未通过。请重新下载该引擎后重试。" };
    } catch (error) {
      const percent = installStates[id]?.percent;
      const message = `启用失败：${error?.message || error}`;
      try {
        const result = await mia.scanAgents?.();
        if (result && result.inventory) inventory = result.inventory;
      } catch { /* keep the original install error */ }
      if (isAgentReady(id)) delete installStates[id];
      else installStates[id] = { status: "error", message, percent };
    }
    render();
  }

  mia.onEngineInstallProgress?.((payload) => {
    const id = String(payload?.engineId || "").trim();
    if (!id) return;
    const percentValue = Number(payload.percent);
    const percent = Number.isFinite(percentValue) ? Math.max(0, Math.min(100, Math.round(percentValue))) : installStates[id]?.percent;
    if (payload.status === "error") {
      installStates[id] = { status: "error", message: `启用失败：${payload.message || "未知错误"}`, percent };
    } else if (payload.status === "success") {
      installStates[id] = { status: "installing", message: payload.message || "稳定版已启用，正在重新检测...", percent: 100 };
    } else {
      installStates[id] = { status: "installing", message: payload.message || "正在启用...", percent };
    }
    if (step === "done") scheduleRender();
  });

  function bind() {
    if (step === "login") {
      root.querySelector("[data-login]")?.addEventListener("submit", (e) => { e.preventDefault(); submitLogin(); });
    }
    root.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", () => {
        const action = el.dataset.action;
        if (action === "login") submitLogin();
        else if (action === "back") {
          loginAttempt += 1;
          loginFlow = null;
          hint = "";
          render();
        }
        else if (action === "finish") {
          if (hasActiveInstall()) return;
          mia.onboardingComplete?.();
        }
      });
    });
    root.querySelectorAll("[data-install]").forEach((el) => {
      el.addEventListener("click", () => installAgent(el.dataset.install, el));
    });
  }

  wireWindowControls();
  render();
})();
