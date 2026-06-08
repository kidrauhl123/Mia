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
  const AGENTS = [
    { id: "hermes", label: "Hermes" },
    { id: "claude-code", label: "Claude Code" },
    { id: "codex", label: "Codex" },
    { id: "openclaw", label: "OpenClaw" },
  ];

  let step = "login"; // login | scan | done
  let hint = "";
  let scan = { done: 0, total: 4, byId: {} };
  let inventory = null;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]
    ));
  }

  function dotsHtml(active) {
    const order = ["login", "prepare"];
    const pos = active === "login" ? 0 : 1;
    return `<div class="onb-dots">${order.map((_n, i) => `<span class="onb-dot ${i < pos ? "done" : i === pos ? "active" : ""}"></span>`).join("")}</div>`;
  }

  function loginHtml() {
    return `
      <p class="onb-step">第 1 / 2 步 · 登录</p>
      ${dotsHtml("login")}
      <div class="onb-hero">
        <img class="onb-logo" src="../assets/mia-logo.png" alt="Mia" draggable="false">
        <h1 class="onb-title">欢迎使用 Mia</h1>
        <p class="onb-tagline">一个聊天界面，指挥你所有的 AI Agent。先登录，把对话同步到云端。</p>
      </div>
      <form class="onb-form" data-login>
        <input class="onb-input" type="text" autocomplete="username" placeholder="用户名" data-username>
        <input class="onb-input" type="password" autocomplete="current-password" placeholder="密码（至少 6 位）" data-password>
        <p class="onb-hint" data-hint>${esc(hint)}</p>
      </form>
      <div class="onb-spacer"></div>
      <div class="onb-footer">
        <button class="onb-cta" type="button" data-action="login">登录</button>
        <button class="onb-link" type="button" data-action="register">没有账号？注册一个</button>
      </div>
    `;
  }

  function rowStatus(agent) {
    if (!agent) return { text: "检测中…", cls: "checking" };
    if (agent.usableInMia) return { text: "已就绪", cls: "ok" };
    if (agent.installed) return { text: "已检测到", cls: "" };
    return { text: "未检测到", cls: "missing" };
  }

  function scanRowsHtml() {
    return AGENTS.map((a) => {
      const { text, cls } = rowStatus(scan.byId[a.id]);
      return `<div class="onb-row ${cls}" data-row="${a.id}"><span class="onb-row-name">${esc(a.label)}</span><span class="onb-row-status">${esc(text)}</span></div>`;
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
      const { text, cls } = rowStatus(agent);
      const canInstall = agent && agent.installable && !agent.usableInMia && !agent.installed && agent.installAction;
      const right = canInstall
        ? `<button class="onb-row-btn" type="button" data-install="${def.id}">安装</button>`
        : `<span class="onb-row-status">${esc(text)}</span>`;
      return `<div class="onb-row ${cls}" data-row="${def.id}"><span class="onb-row-name">${esc(def.label)}</span>${right}</div>`;
    }).join("");
  }

  function doneHtml() {
    return `
      <p class="onb-step">第 2 / 2 步 · 准备</p>
      ${dotsHtml("prepare")}
      <div class="onb-hero">
        <h1 class="onb-title">本机 Agent</h1>
        <p class="onb-tagline">Mia 复用你已装好的 Agent，用自己的配置和记忆。没装的可以在这里装。</p>
      </div>
      <div class="onb-list">${doneRowsHtml()}</div>
      <div class="onb-spacer"></div>
      <div class="onb-footer">
        <button class="onb-cta" type="button" data-action="finish">进入 Mia</button>
      </div>
    `;
  }

  function render() {
    if (!root) return;
    root.innerHTML = step === "login" ? loginHtml() : step === "scan" ? scanHtml() : doneHtml();
    bind();
  }

  function setHint(text) {
    hint = text;
    const el = root.querySelector("[data-hint]");
    if (el) el.textContent = text;
  }

  async function submitLogin(mode) {
    const username = root.querySelector("[data-username]")?.value?.trim() || "";
    const password = root.querySelector("[data-password]")?.value || "";
    if (!username) return setHint("请输入用户名。");
    if (password.length < 6) return setHint("密码至少 6 位。");
    setHint(mode === "register" ? "正在注册并连接…" : "正在登录并连接…");
    try {
      const runtime = await mia.cloudLogin?.({ mode, username, password });
      if (runtime && runtime.cloud && runtime.cloud.enabled) {
        hint = "";
        step = "scan";
        render();
        startScan();
      } else {
        setHint(mode === "register" ? "注册未成功，请重试。" : "登录未成功，请检查或点下方注册。");
      }
    } catch (error) {
      setHint(`连接失败：${error?.message || error}`);
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
    scan = { done: 0, total: 4, byId: {} };
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
    button.disabled = true;
    const label = button.textContent;
    button.textContent = "安装中…";
    try {
      await mia.installEngine(id);
      const result = await mia.scanAgents?.();
      if (result && result.inventory) inventory = result.inventory;
    } catch { /* ignore; row stays */ }
    render();
    void label;
  }

  function bind() {
    if (step === "login") {
      root.querySelector("[data-login]")?.addEventListener("submit", (e) => { e.preventDefault(); submitLogin("login"); });
    }
    root.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", () => {
        const action = el.dataset.action;
        if (action === "login") submitLogin("login");
        else if (action === "register") submitLogin("register");
        else if (action === "finish") mia.onboardingComplete?.();
      });
    });
    root.querySelectorAll("[data-install]").forEach((el) => {
      el.addEventListener("click", () => installAgent(el.dataset.install, el));
    });
  }

  render();
})();
