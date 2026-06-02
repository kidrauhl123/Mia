// Settings - account/cloud connection module.
(function () {
  "use strict";

  let state, els;

  function initSettingsRemote(deps) {
    state = deps.state;
    els = deps.els;
  }

  function renderCloudAccount(cloud = state?.runtime?.cloud || {}) {
    if (!state || !els || !els.cloudAccountHint) return;
    const connected = Boolean(cloud.connected);
    const connecting = Boolean(cloud.connecting);
    const enabled = Boolean(cloud.enabled);
    const username = cloud.user?.username || cloud.user?.email || "";
    if (enabled) {
      const syncText = cloud.workspaceRevision
        ? `Cloud revision ${cloud.workspaceRevision} · ${cloud.conversationCount || 0} 个会话`
        : "Cloud workspace 待同步";
      els.cloudAccountHint.textContent = connected
        ? `${username || "当前账号"} 已登录，自动同步中。${syncText}`
        : connecting
          ? `${username || "当前账号"} 已登录，正在连接 Mia Cloud。${syncText}`
          : `${username || "当前账号"} 已登录，等待 Mia Cloud：${cloud.lastError || "未连接"}。${syncText}`;
    } else {
      els.cloudAccountHint.textContent = "登录后，这台电脑会自动作为本机 Agent 出现在 Web 和手机端。";
    }
    els.cloudLoginBox?.classList.toggle("hidden", enabled);
    els.cloudSync?.classList.toggle("hidden", !enabled);
    els.cloudLogout?.classList.toggle("hidden", !enabled);
    if (els.cloudLoginHint) {
      els.cloudLoginHint.textContent = enabled
        ? "Web 和手机端登录同一账号后会看到这台电脑在线。"
        : "使用和 Web 端相同的用户名、密码。";
    }
  }

  window.miaSettingsRemote = {
    initSettingsRemote,
    renderCloudAccount
  };
})();
