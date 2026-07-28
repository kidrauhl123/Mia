(function (global) {
  "use strict";

  const POLL_MS = 700;
  let state;
  let mia;
  let renderCloudAccount;
  let refreshTimer = 0;
  let pendingTimer = 0;

  function init(deps = {}) {
    state = deps.state;
    mia = deps.mia || global.mia;
    renderCloudAccount = deps.renderCloudAccount || (() => {});
  }

  function clear() {
    if (refreshTimer) {
      global.clearTimeout(refreshTimer);
      refreshTimer = 0;
    }
    if (pendingTimer) {
      global.clearTimeout(pendingTimer);
      pendingTimer = 0;
    }
  }

  function closeApproval() {
    if (global.miaReactDialogs?.current?.()?.dialog?.kind === "cloud-login-approval") {
      global.miaReactDialogs.publish({ dialog: { kind: "closed" } });
    }
    if (state) delete state.pendingCloudLoginRequest;
  }

  function openApproval(request = {}) {
    if (!state) return;
    state.pendingCloudLoginRequest = request;
    const deviceLabel = String(request.deviceLabel || "").trim();
    global.miaReactDialogs?.publish?.({
      dialog: {
        close: closeApproval,
        copy: deviceLabel
          ? `允许 ${deviceLabel} 登录当前账号？`
          : "允许这台设备登录当前账号？",
        decide: respond,
        kind: "cloud-login-approval"
      }
    });
  }

  function errorCopy(error) {
    let message = String(error?.message || error || "").trim();
    if (/Mia Core 未运行|Mia 暂不可用/i.test(message)) return "需要先启动 Mia Core";
    if (/Error invoking remote method 'cloud:login'/i.test(message)) {
      let normalized = message.replace(/^Error invoking remote method 'cloud:login':\s*/i, "").trim();
      normalized = normalized.replace(/^Error:\s*/i, "").trim();
      if (/Mia Core 未运行|Mia 暂不可用/i.test(normalized)) return "需要先启动 Mia Core";
      if (/fetch failed|failed to fetch/i.test(normalized)) return "连接 Mia Cloud 失败，请检查网络后重试。";
      return normalized || "二维码生成失败";
    }
    message = message.replace(/^Error:\s*/i, "").trim();
    if (/fetch failed|failed to fetch/i.test(message)) return "连接 Mia Cloud 失败，请检查网络后重试。";
    return message || "二维码生成失败";
  }

  function scheduleRefresh(expiresAt = "") {
    if (refreshTimer) global.clearTimeout(refreshTimer);
    const expireMs = Date.parse(String(expiresAt || ""));
    if (!Number.isFinite(expireMs)) return;
    const delay = Math.max(1000, expireMs - Date.now() + 250);
    refreshTimer = global.setTimeout(() => {
      refreshTimer = 0;
      refresh(true).catch(() => {});
    }, delay);
  }

  async function refresh(force = false) {
    const cloud = state?.runtime?.cloud || {};
    if (!cloud.enabled) {
      clear();
      closeApproval();
      return;
    }
    const current = cloud.mobileScan || {};
    const expiresAtMs = Date.parse(String(current.expiresAt || ""));
    const stillValid = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() + 1000;
    if (!force && current.qrCodeUrl && stillValid) {
      scheduleRefresh(current.expiresAt);
      return;
    }
    try {
      const started = await mia.cloudLogin({ action: "mobile-scan-start" });
      state.runtime = {
        ...state.runtime,
        cloud: { ...cloud, mobileScan: started }
      };
      renderCloudAccount();
      scheduleRefresh(started.expiresAt);
    } catch (error) {
      state.runtime = {
        ...state.runtime,
        cloud: {
          ...cloud,
          mobileScan: { ...current, error: errorCopy(error) }
        }
      };
      renderCloudAccount();
    }
  }

  async function poll() {
    const cloud = state?.runtime?.cloud || {};
    if (!cloud.enabled) {
      clear();
      closeApproval();
      return;
    }
    try {
      const pending = await mia.cloudLogin({ action: "mobile-scan-pending" });
      if (pending?.requestId) openApproval(pending);
      else closeApproval();
    } catch {
      closeApproval();
    } finally {
      if (state?.runtime?.cloud?.enabled) {
        pendingTimer = global.setTimeout(() => {
          pendingTimer = 0;
          poll().catch(() => {});
        }, POLL_MS);
      }
    }
  }

  function ensurePolling() {
    if (!pendingTimer) poll().catch(() => {});
  }

  async function respond(decision) {
    const pending = state?.pendingCloudLoginRequest || null;
    if (!pending?.requestId) return "登录请求已失效";
    try {
      await mia.cloudLogin({
        action: "mobile-scan-decision",
        requestId: pending.requestId,
        decision
      });
      closeApproval();
      if (decision === "approve") await refresh(true);
      return "";
    } catch (error) {
      return String(error?.message || error);
    }
  }

  global.miaCloudMobileLogin = {
    clear,
    closeApproval,
    ensurePolling,
    init,
    openApproval,
    poll,
    refresh,
    respond
  };
})(typeof window !== "undefined" ? window : globalThis);
