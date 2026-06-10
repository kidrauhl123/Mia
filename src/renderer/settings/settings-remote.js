// Settings - account/cloud connection module.
(function () {
  "use strict";

  let state, els;

  function initSettingsRemote(deps) {
    state = deps.state;
    els = deps.els;
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const text = String(value || "").trim();
      if (text) return text;
    }
    return "";
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
    if (els.cloudAccountName) els.cloudAccountName.textContent = enabled ? name : "";
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

  function renderCloudAccount(cloud = state?.runtime?.cloud || {}) {
    if (!state || !els || !els.cloudAccountHint) return;
    const connected = Boolean(cloud.connected);
    const connecting = Boolean(cloud.connecting);
    const enabled = Boolean(cloud.enabled);
    const username = cloud.user?.username || cloud.user?.email || "";
    renderCloudAccountProfile(cloud, enabled);
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
