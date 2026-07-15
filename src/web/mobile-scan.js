(function () {
  "use strict";

  const SESSION_KEY = "mia.web.session";
  const POLL_INTERVAL_MS = 900;
  const title = document.getElementById("scanTitle");
  const detail = document.getElementById("scanDetail");
  const spinner = document.getElementById("scanSpinner");
  const retry = document.getElementById("scanRetry");

  function setStatus(nextTitle, nextDetail, { busy = false, retryable = false } = {}) {
    title.textContent = nextTitle;
    detail.textContent = nextDetail;
    spinner.hidden = !busy;
    retry.hidden = !retryable;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function postJson(pathname, body) {
    const response = await fetch(pathname, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function clientProfile() {
    const ua = navigator.userAgent || "";
    const wechat = /MicroMessenger/i.test(ua);
    let platform = "web";
    let deviceLabel = "浏览器";
    if (/iPad/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
      platform = "ios";
      deviceLabel = "iPad";
    } else if (/iPhone|iPod/i.test(ua)) {
      platform = "ios";
      deviceLabel = "iPhone";
    } else if (/Android/i.test(ua)) {
      platform = "android";
      deviceLabel = "Android";
    }
    return {
      clientKind: wechat ? "wechat-web" : "browser-web",
      deviceLabel,
      platform
    };
  }

  function terminalStatus(status) {
    if (status === "denied") return ["登录已取消", "电脑端拒绝了本次登录"];
    if (status === "used") return ["二维码已使用", "请在电脑上刷新二维码后重新扫码"];
    return ["二维码已过期", "请在电脑上刷新二维码后重新扫码"];
  }

  function storeSession(payload) {
    let theme = "light";
    try {
      const existing = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (existing?.theme === "dark" || existing?.theme === "light") theme = existing.theme;
    } catch {
      // Ignore stale local state and replace it with the approved session.
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      token: payload.token,
      user: payload.user || null,
      theme
    }));
  }

  async function pollUntilComplete(request) {
    const expiresAtMs = Date.parse(String(request.expiresAt || ""));
    while (!Number.isFinite(expiresAtMs) || Date.now() < expiresAtMs) {
      const result = await postJson("/api/auth/mobile-scan/complete", {
        requestId: request.requestId
      });
      if (result.status === "approved" && result.token) {
        storeSession(result);
        setStatus("登录成功", "正在打开 Mia Web", { busy: true });
        history.replaceState({}, document.title, "/mobile-scan");
        location.replace("/app/");
        return;
      }
      if (result.status !== "pending") {
        const [nextTitle, nextDetail] = terminalStatus(result.status);
        setStatus(nextTitle, nextDetail);
        return;
      }
      await wait(POLL_INTERVAL_MS);
    }
    setStatus("二维码已过期", "请在电脑上刷新二维码后重新扫码");
  }

  async function start() {
    const grant = String(new URL(location.href).searchParams.get("grant") || "").trim();
    if (!grant) {
      setStatus("二维码无效", "请在电脑上刷新二维码后重新扫码");
      return;
    }

    setStatus("正在验证二维码", "请稍候", { busy: true });
    try {
      const requested = await postJson("/api/auth/mobile-scan/request", {
        grant,
        ...clientProfile()
      });
      if (requested.ok === false || !requested.requestId) {
        const [nextTitle, nextDetail] = terminalStatus(requested.status);
        setStatus(nextTitle, nextDetail);
        return;
      }
      setStatus("请在电脑上确认登录", "确认后将在此设备打开 Mia Web", { busy: true });
      await pollUntilComplete(requested);
    } catch {
      setStatus("暂时无法连接 Mia", "请检查网络后重试", { retryable: true });
    }
  }

  retry.addEventListener("click", () => location.reload());
  start();
})();
