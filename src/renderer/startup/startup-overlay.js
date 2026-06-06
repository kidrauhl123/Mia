(function () {
  "use strict";

  const FINISH_TRANSITION_MS = 260;
  let overlayEl = null;
  let statusEl = null;
  let blocking = false;
  let finished = false;
  let finishTimer = 0;

  function resolveElements() {
    if (overlayEl && statusEl) return true;
    overlayEl = document.getElementById("startupOverlay");
    statusEl = document.getElementById("startupOverlayStatus");
    return Boolean(overlayEl && statusEl);
  }

  function setStatus(text = "") {
    if (!resolveElements()) return;
    statusEl.textContent = text;
  }

  function init(options = {}) {
    if (!resolveElements()) return false;
    blocking = Boolean(options.firstRun);
    finished = false;
    clearTimeout(finishTimer);

    if (!blocking) {
      overlayEl.classList.add("hidden");
      return false;
    }

    overlayEl.classList.remove("hidden", "is-finishing", "is-error", "is-welcome");
    overlayEl.setAttribute("aria-busy", "true");
    document.body.classList.add("startup-loading");
    setStatus("正在准备 Mia");
    return true;
  }

  function setWelcome() {
    if (!resolveElements()) return;
    overlayEl.classList.remove("is-error");
    overlayEl.classList.add("is-welcome");
    setStatus("欢迎使用 Mia");
    window.miaLottieIcons?.init?.(overlayEl);
  }

  function fail(message) {
    if (!resolveElements()) return;
    blocking = false;
    overlayEl.classList.remove("is-welcome");
    overlayEl.classList.add("is-error");
    overlayEl.setAttribute("aria-busy", "false");
    setStatus(message || "Mia 初始化失败");
  }

  function finish() {
    if (!resolveElements() || finished) return Promise.resolve();
    blocking = false;
    finished = true;
    overlayEl.setAttribute("aria-busy", "false");
    overlayEl.classList.add("is-finishing");
    document.body.classList.remove("startup-loading");
    return new Promise((resolve) => {
      finishTimer = setTimeout(() => {
        window.miaLottieIcons?.destroy?.(overlayEl);
        overlayEl.classList.add("hidden");
        overlayEl.classList.remove("is-finishing", "is-welcome", "is-error");
        setStatus("");
        resolve();
      }, FINISH_TRANSITION_MS);
    });
  }

  function isBlocking() {
    return blocking && !finished;
  }

  window.miaStartupOverlay = {
    init,
    setStatus,
    setWelcome,
    fail,
    finish,
    isBlocking,
  };
})();
