// Settings - Cross-device tab module
// Extracted from app.js (formerly lines 2120-2278). Handles the Mobile (LAN
// daemon) / Relay / Cloud pairing UI: QR codes, link reveal, status text,
// and daemon host toggle.
//
// All exposed functions have defensive `if (!state)` / `if (!els)` guards
// so they're safe to call before init runs (lesson from B1 init-order bug
// and the b1 settings-appearance pingfang regression).
(function () {
  "use strict";

  let state, els;
  let setText, renderQr;

  function initSettingsRemote(deps) {
    state = deps.state;
    els = deps.els;
    setText = deps.setText;
    renderQr = deps.renderQr;
  }

  async function refreshDaemonPairing() {
    if (!state || !els) return null;
    try {
      let pairing = await window.aimashi.daemonPairing();
      if (!pairing?.running && window.aimashi.startDaemon) {
        await window.aimashi.startDaemon();
        pairing = await window.aimashi.daemonPairing();
      }
      state.runtime = {
        ...(state.runtime || {}),
        daemon: {
          ...(state.runtime?.daemon || {}),
          ...pairing,
          token: undefined
        }
      };
      renderMobilePairing(pairing);
      return pairing;
    } catch (error) {
      setText(els.mobileDaemonStatus, `Error: ${error.message}`);
      throw error;
    }
  }

  function renderMobilePairing(daemon = state?.runtime?.daemon || {}) {
    if (!state || !els || !els.mobileLanToggle) return;
    const settings = daemon.settings || {};
    const running = Boolean(daemon.running);
    const host = settings.host || daemon.host || "127.0.0.1";
    const lanEnabled = host === "0.0.0.0" || host === "::";
    const links = Array.isArray(daemon.links) && daemon.links.length
      ? daemon.links
      : Array.isArray(daemon.connectUrls)
        ? daemon.connectUrls.map((url) => `${url}/mobile/`)
        : [];
    const link = links[0] || "";
    setText(els.mobileDaemonStatus, running ? "Aimashi 后台已运行" : daemon.starting ? "Aimashi 后台启动中" : "Aimashi 后台未运行");
    setText(els.mobileDaemonUrl, lanEnabled
      ? "同一局域网内扫描二维码连接；公司、校园或公共 Wi-Fi 可能会禁止设备互访。"
      : "关闭时只允许本机访问，不生成手机配对入口。");
    els.mobileLanToggle.classList.toggle("active", lanEnabled);
    els.mobileLanToggle.setAttribute("aria-checked", String(lanEnabled));
    els.mobileLanToggle.disabled = Boolean(daemon.starting);
    if (els.mobilePairingBox) els.mobilePairingBox.classList.toggle("hidden", !lanEnabled || !link);
    renderQr(els.mobilePairingQr, lanEnabled ? link : "");
    if (els.mobilePairingReveal) {
      els.mobilePairingReveal.classList.toggle("hidden", !lanEnabled || !link);
      setText(els.mobilePairingReveal, state.mobileLanLinkExpanded ? "隐藏链接" : "显示链接");
    }
    if (els.mobilePairingLink) {
      const showLink = lanEnabled && Boolean(link) && state.mobileLanLinkExpanded;
      els.mobilePairingLink.classList.toggle("hidden", !showLink);
      els.mobilePairingLink.dataset.link = link;
      setText(els.mobilePairingLink, link);
    }
    if (els.mobilePairingHint) {
      els.mobilePairingHint.textContent = lanEnabled
        ? "扫描二维码即可连接；展开链接后点一下会复制。"
        : "打开局域网访问后才会生成配对二维码。";
    }
  }

  async function refreshRelayPairing() {
    if (!state || !els) return null;
    if (!window.aimashi?.relayStatus) return null;
    try {
      const relay = await window.aimashi.relayStatus();
      state.runtime = {
        ...(state.runtime || {}),
        relay: {
          ...(state.runtime?.relay || {}),
          ...relay,
          secret: undefined
        }
      };
      renderRelayPairing(relay);
      return relay;
    } catch (error) {
      setText(els.mobileRelayHint, `Error: ${error.message}`);
      throw error;
    }
  }

  function renderRelayPairing(relay = state?.runtime?.relay || {}) {
    if (!state || !els || !els.mobileRelayToggle) return;
    const enabled = Boolean(relay.enabled);
    const connected = Boolean(relay.connected);
    const peers = Number(relay.mobilePeers || 0);
    const link = String(relay.pairingLink || "");
    if (els.mobileRelayToggle) {
      els.mobileRelayToggle.classList.toggle("active", enabled);
      els.mobileRelayToggle.setAttribute("aria-checked", String(enabled));
    }
    if (els.mobileRelayBox) els.mobileRelayBox.classList.toggle("hidden", !enabled);
    if (els.mobileRelayUrl && document.activeElement !== els.mobileRelayUrl) {
      els.mobileRelayUrl.value = String(relay.url || "");
    }
    renderQr(els.mobileRelayQr, enabled ? link : "");
    if (els.mobileRelayReveal) {
      els.mobileRelayReveal.classList.toggle("hidden", !enabled || !link);
      setText(els.mobileRelayReveal, state.mobileRelayLinkExpanded ? "隐藏链接" : "显示链接");
    }
    if (els.mobileRelayLink) {
      const showLink = enabled && Boolean(link) && state.mobileRelayLinkExpanded;
      els.mobileRelayLink.classList.toggle("hidden", !showLink);
      els.mobileRelayLink.dataset.link = link;
      setText(els.mobileRelayLink, link);
    }
    if (els.mobileRelayHint) {
      els.mobileRelayHint.textContent = enabled
        ? connected
          ? peers ? `已连接，${peers} 台手机在线。` : "已连接。扫描二维码即可远程连接。"
          : `等待 relay：${relay.lastError || relay.url || "未连接"}`
        : "通过 Aimashi Relay 中继连接，不要求手机和电脑在同一网络。";
    }
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
        ? `${username || "当前账号"} 已登录，本机 Agent 在线。${syncText}`
        : connecting
          ? `${username || "当前账号"} 已登录，正在连接 Aimashi Cloud。${syncText}`
          : `${username || "当前账号"} 已登录，等待 Aimashi Cloud：${cloud.lastError || "未连接"}。${syncText}`;
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

  async function applyDaemonHost(host) {
    if (!state || !els) return null;
    if (!window.aimashi?.saveDaemonSettings) return null;
    setText(els.mobilePairingHint, "正在切换手机访问范围...");
    await window.aimashi.saveDaemonSettings({ host });
    await window.aimashi.stopDaemon?.();
    await window.aimashi.startDaemon?.();
    return refreshDaemonPairing();
  }

  function currentMobilePairingLink() {
    if (!els) return "";
    return String(els.mobilePairingLink?.dataset?.link || els.mobilePairingLink?.value || els.mobilePairingLink?.textContent || "").trim();
  }

  function currentRelayPairingLink() {
    if (!els) return "";
    return String(els.mobileRelayLink?.dataset?.link || els.mobileRelayLink?.textContent || "").trim();
  }

  window.aimashiSettingsRemote = {
    initSettingsRemote,
    refreshDaemonPairing,
    renderMobilePairing,
    refreshRelayPairing,
    renderRelayPairing,
    renderCloudAccount,
    applyDaemonHost,
    currentMobilePairingLink,
    currentRelayPairingLink,
  };
})();
