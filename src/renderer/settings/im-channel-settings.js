// Settings - publish a Mia Bot to an official IM callback without exposing
// cloud credentials to the renderer after they have been saved.
(function () {
  "use strict";

  let state;
  let els;
  let reportError;
  let requestRender;
  let wired = false;
  let loaded = false;
  let loading = false;
  let loadedAccountKey = "";
  let errorText = "";
  let channels = [];
  let bots = [];
  let providers = [];
  let draft = null;
  const busyActions = new Set();

  const fallbackProviders = [
    { id: "feishu", label: "飞书", availability: "available" },
    { id: "wechat_official_account", label: "微信公众号", availability: "available" },
    { id: "wechat_clawbot", label: "微信 ClawBot", availability: "bridge-preview" }
  ];

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function resultData(result) {
    if (result?.ok === false) throw new Error(result.error || result.message || "操作失败。");
    return result?.data && typeof result.data === "object" ? result.data : (result || {});
  }

  function isCloudSignedIn() {
    return Boolean(state?.runtime?.cloud?.enabled);
  }

  function resetForChangedCloudAccount() {
    const cloud = state?.runtime?.cloud || {};
    const user = cloud.user || {};
    const accountKey = isCloudSignedIn()
      ? `${cloud.url || ""}:${user.id || user.userId || user.user_id || ""}`
      : "";
    if (accountKey === loadedAccountKey) return;
    loadedAccountKey = accountKey;
    loaded = false;
    loading = false;
    errorText = "";
    channels = [];
    bots = [];
    providers = [];
    draft = null;
    busyActions.clear();
  }

  function getAvailableProviders() {
    const remote = Array.isArray(providers) && providers.length ? providers : fallbackProviders;
    return remote.filter((provider) => provider?.availability === "available");
  }

  function providerFor(id) {
    return [...providers, ...fallbackProviders].find((provider) => provider?.id === id)
      || fallbackProviders[0];
  }

  function defaultDraft() {
    return {
      id: "",
      provider: "feishu",
      botId: String(bots[0]?.id || bots[0]?.key || ""),
      name: "",
      enabled: false,
      allowedSenderIds: "",
      allowAllSenders: false,
      allowGroupMessages: false,
      credentials: {},
      hasCredentials: false
    };
  }

  function draftForChannel(channel) {
    const settings = channel?.settings || {};
    return {
      id: String(channel?.id || ""),
      provider: String(channel?.provider || "feishu"),
      botId: String(channel?.botId || channel?.bot_id || ""),
      name: String(channel?.name || ""),
      enabled: channel?.enabled === true,
      allowedSenderIds: Array.isArray(settings.allowedSenderIds || settings.allowed_sender_ids)
        ? (settings.allowedSenderIds || settings.allowed_sender_ids).join("\n")
        : "",
      allowAllSenders: settings.allowAllSenders === true || settings.allow_all_senders === true,
      allowGroupMessages: settings.allowGroupMessages === true || settings.allow_group_messages === true,
      credentials: {},
      hasCredentials: channel?.hasCredentials === true
    };
  }

  function setBusy(key, value) {
    if (value) busyActions.add(key);
    else busyActions.delete(key);
  }

  async function loadChannels({ force = false } = {}) {
    if (loading || (!force && loaded)) return;
    if (!window.mia?.social?.listImChannels || !window.mia?.social?.listBots) {
      errorText = "当前版本缺少 IM 接入所需的 Cloud 能力，请重启 Mia。";
      requestRender?.();
      return;
    }
    loading = true;
    errorText = "";
    requestRender?.();
    try {
      const [channelResult, botResult] = await Promise.all([
        window.mia.social.listImChannels(),
        window.mia.social.listBots()
      ]);
      const channelPayload = resultData(channelResult);
      const botPayload = resultData(botResult);
      channels = Array.isArray(channelPayload.channels) ? channelPayload.channels : [];
      providers = Array.isArray(channelPayload.providers) ? channelPayload.providers : fallbackProviders;
      bots = Array.isArray(botPayload.bots) ? botPayload.bots : [];
      loaded = true;
    } catch (error) {
      errorText = error?.message || "IM 通道读取失败。";
    } finally {
      loading = false;
      requestRender?.();
    }
  }

  function renderSignedOut() {
    return `
      <div class="settings-section-label">IM 接入</div>
      <section class="im-channel-empty settings-row settings-group-start settings-group-end">
        <div>
          <strong>登录 Mia Cloud 后连接 IM</strong>
          <p>登录后可把已有 Bot 发布到飞书或微信公众号。</p>
        </div>
      </section>`;
  }

  function statusLabel(channel) {
    if (!channel.enabled) return "未启用";
    if (channel.lastError) return "需要处理";
    return "已启用";
  }

  function channelItem(channel) {
    const provider = providerFor(channel.provider);
    const busy = busyActions.has(channel.id);
    const callback = String(channel.callbackUrl || "");
    const error = String(channel.lastError || "");
    const bot = bots.find((item) => String(item?.id || item?.key || "") === String(channel.botId || ""));
    const botName = bot?.displayName || bot?.name || channel.botId || "Bot";
    return `
      <article class="im-channel-card${channel.enabled ? "" : " im-channel-card-disabled"}">
        <div class="im-channel-card-head">
          <div>
            <strong>${escapeHtml(channel.name || provider.label)}</strong>
            <p>${escapeHtml(provider.label)} · ${escapeHtml(botName)}</p>
          </div>
          <span class="im-channel-status${error ? " warning" : ""}">${statusLabel(channel)}</span>
        </div>
        ${callback ? `<div class="im-channel-callback"><code>${escapeHtml(callback)}</code><button class="settings-secondary-button" type="button" data-im-action="copy" data-callback="${escapeHtml(callback)}">复制</button></div>` : ""}
        ${error ? `<p class="im-channel-error">${escapeHtml(error)}</p>` : ""}
        <div class="im-channel-actions">
          <button class="settings-secondary-button" type="button" data-im-action="test" data-channel-id="${escapeHtml(channel.id)}" ${busy ? "disabled" : ""}>验证凭据</button>
          <button class="settings-secondary-button" type="button" data-im-action="edit" data-channel-id="${escapeHtml(channel.id)}" ${busy ? "disabled" : ""}>编辑</button>
          <button class="settings-secondary-button danger" type="button" data-im-action="delete" data-channel-id="${escapeHtml(channel.id)}" ${busy ? "disabled" : ""}>删除</button>
        </div>
      </article>`;
  }

  function credentialFields(current) {
    const isFeishu = current.provider === "feishu";
    const tokenLabel = isFeishu ? "Verification Token" : "服务器 Token";
    const tokenName = isFeishu ? "verificationToken" : "token";
    return `
      <div class="im-channel-form-grid">
        <label><span>App ID</span><input name="appId" autocomplete="off" value="${escapeHtml(current.credentials.appId || "")}" placeholder="${isFeishu ? "cli_..." : "wx..."}"></label>
        <label><span>App Secret</span><input name="appSecret" type="password" autocomplete="new-password" value="" placeholder="${current.hasCredentials ? "留空则保留已保存的密钥" : "应用密钥"}"></label>
        <label class="wide"><span>${tokenLabel}</span><input name="${tokenName}" type="password" autocomplete="new-password" value="" placeholder="${current.hasCredentials ? "留空则保留已保存的 Token" : "回调验证 Token"}"></label>
      </div>`;
  }

  function editor() {
    const current = draft || defaultDraft();
    const isNew = !current.id;
    const providersHtml = getAvailableProviders().map((provider) => (
      `<option value="${escapeHtml(provider.id)}"${provider.id === current.provider ? " selected" : ""}>${escapeHtml(provider.label)}</option>`
    )).join("");
    const botOptions = bots.map((bot) => {
      const id = String(bot?.id || bot?.key || "");
      const name = String(bot?.displayName || bot?.name || id);
      return `<option value="${escapeHtml(id)}"${id === current.botId ? " selected" : ""}>${escapeHtml(name)}</option>`;
    }).join("");
    const provider = providerFor(current.provider);
    const saveDisabled = !bots.length || busyActions.has("save");
    return `
      <section class="im-channel-editor">
        <div class="im-channel-editor-head">
          <strong>${isNew ? "新建 IM 通道" : `编辑 ${escapeHtml(current.name || provider.label)}`}</strong>
          <button class="icon-button" type="button" data-im-action="cancel" aria-label="关闭 IM 通道编辑">×</button>
        </div>
        ${bots.length ? "" : '<p class="im-channel-error">请先创建一个 Bot，再连接 IM。</p>'}
        <form data-im-form>
          <div class="im-channel-form-grid">
            <label><span>通道名称</span><input name="name" maxlength="80" value="${escapeHtml(current.name)}" placeholder="例如：团队飞书助手"></label>
            <label><span>平台</span><select name="provider">${providersHtml}</select></label>
            <label class="wide"><span>绑定 Bot</span><select name="botId" ${bots.length ? "" : "disabled"}><option value="">选择 Bot</option>${botOptions}</select></label>
          </div>
          ${credentialFields(current)}
          <label class="im-channel-toggle"><input name="enabled" type="checkbox"${current.enabled ? " checked" : ""}><span>启用通道</span></label>
          <label class="im-channel-toggle"><input name="allowAllSenders" type="checkbox"${current.allowAllSenders ? " checked" : ""}><span>允许所有发送者</span></label>
          <label class="im-channel-senders"><span>可信发送者</span><textarea name="allowedSenderIds" rows="3" placeholder="每行一个飞书 open_id 或微信 openid">${escapeHtml(current.allowedSenderIds)}</textarea><small>默认拒绝未列出的发送者。若开启“允许所有发送者”，请确认这个 Bot 对外开放是安全的。</small></label>
          <label class="im-channel-toggle"><input name="allowGroupMessages" type="checkbox"${current.allowGroupMessages ? " checked" : ""}><span>允许群消息</span></label>
          <div class="im-channel-editor-actions">
            <button class="settings-secondary-button" type="button" data-im-action="cancel">取消</button>
            <button class="primary" type="submit" ${saveDisabled ? "disabled" : ""}>${isNew ? "创建通道" : "保存通道"}</button>
          </div>
        </form>
      </section>`;
  }

  function setupGuide() {
    return `
      <details class="im-channel-guide">
        <summary>飞书配置</summary>
        <p>创建企业自建应用并启用机器人能力，订阅 <code>im.message.receive_v1</code>，把上方回调地址和 Verification Token 填入事件订阅。当前使用未加密回调。</p>
      </details>
      <details class="im-channel-guide">
        <summary>微信公众号配置</summary>
        <p>在「服务器配置」填写回调地址和 Token，选择明文模式。Mia 用客服消息 API 回投回复，需满足微信的 48 小时互动窗口。</p>
      </details>
      <section class="im-channel-bridge-note">
        <strong>微信 ClawBot</strong>
        <p>个人微信没有稳定的公开机器人 API。Mia 预留了受控桥接位置；当前不做个人号扫码或逆向登录。</p>
      </section>`;
  }

  function markup() {
    if (!isCloudSignedIn()) return renderSignedOut();
    const channelList = loading
      ? '<p class="im-channel-loading">正在读取 IM 通道…</p>'
      : channels.length
        ? `<div class="im-channel-list">${channels.map(channelItem).join("")}</div>`
        : '<section class="im-channel-empty settings-row settings-group-start settings-group-end"><div><strong>还没有 IM 通道</strong><p>把一个已有 Bot 接到飞书或微信公众号。</p></div></section>';
    return `
      <div class="settings-section-label">IM 接入</div>
      <section class="im-channel-safety">
        <strong>仅连接受信任的会话</strong>
        <p>外部消息会触发绑定 Bot 的 Agent。默认仅接受允许名单中的发送者。</p>
      </section>
      ${errorText ? `<p class="im-channel-error">${escapeHtml(errorText)}</p>` : ""}
      ${draft ? editor() : `<div class="im-channel-toolbar"><button class="primary" type="button" data-im-action="create">连接 IM</button><button class="settings-secondary-button" type="button" data-im-action="refresh">刷新</button></div>`}
      ${channelList}
      ${setupGuide()}`;
  }

  function renderImChannelSettings() {
    if (!els?.imChannelSettings) return;
    resetForChangedCloudAccount();
    els.imChannelSettings.innerHTML = markup();
    if (isCloudSignedIn() && !loaded && !loading) loadChannels();
  }

  function restoreDraftFromForm(form) {
    if (!draft || !form) return;
    const fields = new FormData(form);
    draft = {
      ...draft,
      name: String(fields.get("name") || ""),
      provider: String(fields.get("provider") || draft.provider),
      botId: String(fields.get("botId") || ""),
      enabled: fields.get("enabled") === "on",
      allowAllSenders: fields.get("allowAllSenders") === "on",
      allowGroupMessages: fields.get("allowGroupMessages") === "on",
      allowedSenderIds: String(fields.get("allowedSenderIds") || ""),
      credentials: {
        appId: String(fields.get("appId") || ""),
        appSecret: String(fields.get("appSecret") || ""),
        verificationToken: String(fields.get("verificationToken") || ""),
        token: String(fields.get("token") || "")
      }
    };
  }

  function payloadFromForm(form) {
    restoreDraftFromForm(form);
    const current = draft || defaultDraft();
    const credentials = {};
    if (current.credentials.appId) credentials.appId = current.credentials.appId;
    if (current.credentials.appSecret) credentials.appSecret = current.credentials.appSecret;
    if (current.provider === "feishu" && current.credentials.verificationToken) {
      credentials.verificationToken = current.credentials.verificationToken;
    }
    if (current.provider === "wechat_official_account" && current.credentials.token) credentials.token = current.credentials.token;
    return {
      provider: current.provider,
      botId: current.botId,
      name: current.name,
      enabled: current.enabled,
      settings: {
        allowedSenderIds: current.allowedSenderIds.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
        allowAllSenders: current.allowAllSenders,
        allowGroupMessages: current.allowGroupMessages
      },
      ...(Object.keys(credentials).length ? { credentials } : {})
    };
  }

  async function saveDraft(form) {
    if (!window.mia?.social) return;
    const currentId = draft?.id || "";
    const payload = payloadFromForm(form);
    setBusy("save", true);
    errorText = "";
    renderImChannelSettings();
    try {
      const result = currentId
        ? await window.mia.social.updateImChannel(currentId, payload)
        : await window.mia.social.createImChannel(payload);
      const data = resultData(result);
      const channel = data.channel;
      if (channel) {
        channels = currentId
          ? channels.map((item) => item.id === channel.id ? channel : item)
          : [channel, ...channels];
      }
      draft = null;
      loaded = true;
    } catch (error) {
      errorText = error?.message || "IM 通道保存失败。";
      reportError?.(`IM 通道保存失败：${errorText}`);
    } finally {
      setBusy("save", false);
      renderImChannelSettings();
    }
  }

  async function runAction(action, channelId) {
    const channel = channels.find((item) => item.id === channelId);
    if (!channel || !window.mia?.social) return;
    if (action === "edit") {
      draft = draftForChannel(channel);
      renderImChannelSettings();
      return;
    }
    if (action === "delete" && !window.confirm(`删除“${channel.name || "这个 IM 通道"}”？`)) return;
    setBusy(channelId, true);
    errorText = "";
    renderImChannelSettings();
    try {
      if (action === "test") {
        const result = resultData(await window.mia.social.testImChannel(channelId));
        const updated = result.channel;
        if (updated) channels = channels.map((item) => item.id === updated.id ? updated : item);
      } else if (action === "delete") {
        resultData(await window.mia.social.deleteImChannel(channelId));
        channels = channels.filter((item) => item.id !== channelId);
        if (draft?.id === channelId) draft = null;
      }
    } catch (error) {
      errorText = error?.message || "IM 通道操作失败。";
      reportError?.(`IM 通道操作失败：${errorText}`);
    } finally {
      setBusy(channelId, false);
      renderImChannelSettings();
    }
  }

  async function copyCallback(value) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(String(value || ""));
    } catch {
      errorText = "无法复制回调地址，请手动复制。";
      renderImChannelSettings();
    }
  }

  function wireEvents() {
    if (wired || !els?.imChannelSettings) return;
    wired = true;
    els.imChannelSettings.addEventListener("click", (event) => {
      const button = event.target.closest("[data-im-action]");
      if (!button) return;
      const action = button.dataset.imAction;
      if (action === "create") {
        draft = defaultDraft();
        renderImChannelSettings();
      } else if (action === "cancel") {
        draft = null;
        errorText = "";
        renderImChannelSettings();
      } else if (action === "refresh") {
        loadChannels({ force: true });
      } else if (action === "copy") {
        copyCallback(button.dataset.callback || "");
      } else if (["edit", "delete", "test"].includes(action)) {
        runAction(action, button.dataset.channelId || "");
      }
    });
    els.imChannelSettings.addEventListener("change", (event) => {
      if (event.target?.name !== "provider") return;
      const form = event.target.closest("form");
      restoreDraftFromForm(form);
      draft.credentials = { appId: draft.credentials.appId || "" };
      draft.hasCredentials = false;
      renderImChannelSettings();
    });
    els.imChannelSettings.addEventListener("submit", (event) => {
      if (!event.target.matches("[data-im-form]")) return;
      event.preventDefault();
      saveDraft(event.target);
    });
  }

  function initImChannelSettings(deps = {}) {
    state = deps.state;
    els = deps.els;
    reportError = deps.reportError;
    requestRender = deps.render;
    wireEvents();
    renderImChannelSettings();
  }

  window.miaImChannelSettings = {
    initImChannelSettings,
    renderImChannelSettings,
    refresh: () => loadChannels({ force: true })
  };
})();
