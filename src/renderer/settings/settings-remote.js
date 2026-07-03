// Settings - account/cloud connection module.
(function () {
  "use strict";

  let state, els;
  let fetchModelBalance = null;
  let balanceState = {
    accountKey: "",
    fetchedAt: 0,
    inFlight: null,
    payload: null,
    error: ""
  };
  const BALANCE_TTL_MS = 30000;
  const BALANCE_ERROR_TTL_MS = 30000;

  function initSettingsRemote(deps) {
    state = deps.state;
    els = deps.els;
    fetchModelBalance = deps.fetchModelBalance || window.miaCloud?.fetchModelBalance || window.mia?.cloudModelBalance || null;
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const text = String(value || "").trim();
      if (text) return text;
    }
    return "";
  }

  function formatUsdFromMicro(value) {
    const usd = Number(value || 0) / 1_000_000;
    if (!usd) return "$0";
    return `$${usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  }

  function cloudAccountKey(cloud = {}) {
    const user = cloud.user || {};
    return [
      cloud.url || "",
      user.id || user.userId || user.user_id || "",
      user.username || ""
    ].join("|");
  }

  function setModelBalanceVisible(visible) {
    els?.cloudModelBalanceRow?.classList.toggle("hidden", !visible);
  }

  function renderModelBalanceSignedOut() {
    setModelBalanceVisible(false);
    if (els?.cloudModelBalanceAmount) els.cloudModelBalanceAmount.textContent = "";
    if (els?.cloudModelBalanceMeta) els.cloudModelBalanceMeta.textContent = "登录后可查看 Mia 模型额度。";
  }

  function renderMobileScanSignedOut() {
    els?.cloudMobileScanCard?.classList.toggle("hidden", true);
    if (els?.cloudMobileScanMeta) {
      els.cloudMobileScanMeta.textContent = "登录后可用手机扫码登录。";
    }
    if (els?.cloudMobileScanQr) {
      els.cloudMobileScanQr.textContent = "";
      if (els.cloudMobileScanQr.dataset) delete els.cloudMobileScanQr.dataset.qrUrl;
    }
  }

  function renderMobileScan(cloud = {}, enabled = false) {
    if (!els?.cloudMobileScanCard) return;
    if (!enabled) {
      renderMobileScanSignedOut();
      return;
    }
    const mobileScan = cloud.mobileScan || {};
    const qrUrl = String(mobileScan.qrUrl || "").trim();
    const qrCodeUrl = String(mobileScan.qrCodeUrl || "").trim();
    const error = String(mobileScan.error || "").trim();
    els.cloudMobileScanCard.classList.toggle("hidden", false);
    if (els?.cloudMobileScanMeta) {
      els.cloudMobileScanMeta.textContent = error
        ? `二维码生成失败：${error}`
        : qrUrl
        ? "手机扫一扫，电脑上点一次允许。"
        : "正在生成二维码。";
    }
    if (els?.cloudMobileScanQr) {
      if (qrCodeUrl) {
        els.cloudMobileScanQr.innerHTML = `<img src="${qrCodeUrl.replaceAll('"', "&quot;")}" alt="手机扫码登录 Mia">`;
      } else {
        els.cloudMobileScanQr.textContent = error ? "二维码生成失败" : qrUrl ? "二维码已就绪" : "二维码准备中…";
      }
      if (els.cloudMobileScanQr.dataset) {
        if (qrUrl) els.cloudMobileScanQr.dataset.qrUrl = qrUrl;
        else delete els.cloudMobileScanQr.dataset.qrUrl;
      }
    }
  }

  function renderModelBalancePayload(payload) {
    const balance = payload?.balance || {};
    const usage = Array.isArray(payload?.recentUsage) ? payload.recentUsage[0] : null;
    const amount = Number(balance.balanceMicrousd || 0);
    const charge = Number(usage?.chargeMicrousd || 0);
    setModelBalanceVisible(true);
    if (els?.cloudModelBalanceAmount) els.cloudModelBalanceAmount.textContent = formatUsdFromMicro(amount);
    if (els?.cloudModelBalanceMeta) {
      els.cloudModelBalanceMeta.textContent = charge > 0
        ? `最近扣费 ${formatUsdFromMicro(charge)}`
        : "暂无模型调用扣费记录。";
    }
  }

  function renderModelBalanceLoading() {
    setModelBalanceVisible(true);
    if (els?.cloudModelBalanceAmount) els.cloudModelBalanceAmount.textContent = "读取中…";
    if (els?.cloudModelBalanceMeta) els.cloudModelBalanceMeta.textContent = "正在读取 Mia 模型额度。";
  }

  function modelBalanceErrorCopy(error) {
    const message = error?.message || String(error || "");
    if (/No handler registered|cloud:model-balance|remote method/i.test(message)) {
      return {
        amount: "暂不可用",
        meta: "重启 Mia 后可读取模型额度。"
      };
    }
    return {
      amount: "读取失败",
      meta: message || "额度读取失败。"
    };
  }

  function renderModelBalanceError(error) {
    const copy = modelBalanceErrorCopy(error);
    setModelBalanceVisible(true);
    if (els?.cloudModelBalanceAmount) els.cloudModelBalanceAmount.textContent = copy.amount;
    if (els?.cloudModelBalanceMeta) els.cloudModelBalanceMeta.textContent = copy.meta;
  }

  async function refreshModelBalance(cloud = {}) {
    if (!els?.cloudModelBalanceRow) return null;
    if (!cloud.enabled) {
      renderModelBalanceSignedOut();
      balanceState = { accountKey: "", fetchedAt: 0, inFlight: null, payload: null, error: "" };
      return null;
    }
    const key = cloudAccountKey(cloud);
    if (balanceState.accountKey !== key) {
      balanceState = { accountKey: key, fetchedAt: 0, inFlight: null, payload: null, error: "" };
    }
    if (balanceState.payload && Date.now() - balanceState.fetchedAt < BALANCE_TTL_MS) {
      renderModelBalancePayload(balanceState.payload);
      return balanceState.payload;
    }
    if (balanceState.error && Date.now() - balanceState.fetchedAt < BALANCE_ERROR_TTL_MS) {
      renderModelBalanceError(balanceState.error);
      return null;
    }
    if (balanceState.inFlight) return balanceState.inFlight;
    if (typeof fetchModelBalance !== "function") {
      renderModelBalanceError(new Error("当前版本暂不能读取模型额度。"));
      return null;
    }
    renderModelBalanceLoading();
    balanceState.inFlight = Promise.resolve()
      .then(() => fetchModelBalance())
      .then((payload) => {
        balanceState.payload = payload || {};
        balanceState.fetchedAt = Date.now();
        balanceState.error = "";
        renderModelBalancePayload(balanceState.payload);
        return balanceState.payload;
      })
      .catch((error) => {
        balanceState.error = error || new Error("额度读取失败。");
        balanceState.fetchedAt = Date.now();
        renderModelBalanceError(error);
        return null;
      })
      .finally(() => {
        balanceState.inFlight = null;
      });
    return balanceState.inFlight;
  }

  function renderCloudAccountProfile(cloud, enabled) {
    if (!els?.cloudAccountProfile) return;
    const user = cloud?.user || {};
    const uid = firstNonEmpty(user.id, user.userId, user.user_id);
    const name = firstNonEmpty(
      user.displayName,
      user.display_name,
      user.name,
      user.username,
      user.email,
      uid
    );
    els.cloudAccountProfile.classList.toggle("hidden", !enabled);
    if (els.cloudAccountName) {
      if (!enabled) {
        els.cloudAccountName.textContent = "";
      } else {
        const renderer = window.miaNameWithBadge;
        try {
          if (renderer && (typeof renderer.setNameWithBadge === "function" || typeof renderer.renderNameWithBadge === "function")) {
            const payload = {
              identity: { kind: "user", id: uid, displayName: name, statusBadge: user.statusBadge || user.status_badge || null },
              fallbackName: name,
              statusBadge: user.statusBadge || user.status_badge || null
            };
            if (typeof renderer.setNameWithBadge === "function") {
              renderer.setNameWithBadge(els.cloudAccountName, payload);
            } else {
              els.cloudAccountName.replaceChildren(renderer.renderNameWithBadge(payload));
            }
          } else {
            els.cloudAccountName.textContent = name;
          }
        } catch {
          els.cloudAccountName.textContent = name;
        }
      }
    }
    if (els.cloudAccountUid) els.cloudAccountUid.textContent = enabled && uid ? `UID ${uid}` : "";
    if (!enabled || !els.cloudAccountAvatar) return;
    const avatar = window.miaAvatarResolve?.resolveAvatarForContact?.({
      id: uid || name,
      displayName: name,
      avatarImage: user.avatarImage || user.avatar_image || "",
      avatarCrop: user.avatarCrop || user.avatar_crop || null,
      color: user.avatarColor || user.avatar_color || user.color || ""
    }) || {
      image: user.avatarImage || user.avatar_image || "",
      crop: user.avatarCrop || user.avatar_crop || null,
      color: user.avatarColor || user.avatar_color || "#65c2c8",
      text: name.slice(0, 2)
    };
    if (typeof window.miaAvatar?.paintAvatar === "function") {
      window.miaAvatar.paintAvatar(els.cloudAccountAvatar, avatar);
    } else {
      window.miaAvatar?.applyAvatarMedia?.(els.cloudAccountAvatar, avatar.image, avatar.crop, avatar.color, avatar.text);
    }
  }

  async function renderCloudAccount(cloud = state?.runtime?.cloud || {}) {
    if (!state || !els || !els.cloudAccountHint) return;
    const connected = Boolean(cloud.connected);
    const connecting = Boolean(cloud.connecting);
    const enabled = Boolean(cloud.enabled);
    const username = cloud.user?.username || cloud.user?.email || "";
    renderCloudAccountProfile(cloud, enabled);
    if (enabled) {
      els.cloudAccountHint.textContent = connected
        ? `${username || "当前账号"} 已登录，账号数据会自动同步。`
        : connecting
          ? `${username || "当前账号"} 已登录，正在连接云端同步。`
          : `${username || "当前账号"} 已登录，云同步暂未连接。`;
    } else {
      els.cloudAccountHint.textContent = "登录后，这台电脑会自动作为本机 Agent 出现在 Web 和手机端。";
    }
    els.cloudLogout?.classList.toggle("hidden", !enabled);
    renderMobileScan(cloud, enabled);
    await refreshModelBalance({ ...cloud, enabled });
  }

  window.miaSettingsRemote = {
    initSettingsRemote,
    renderCloudAccount
  };
})();
