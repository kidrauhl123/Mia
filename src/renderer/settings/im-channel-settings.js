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
  let clawbotStatuses = {};
  const clawbotQrDataUrls = new Map();
  const clawbotStatusTimers = new Map();
  const busyActions = new Set();

  const fallbackProviders = [
    { id: "feishu", label: "飞书", availability: "available" },
    { id: "wechat_clawbot", label: "微信", availability: "available", transport: "device-relay" }
  ];
  const supportedProviderIds = new Set(fallbackProviders.map((provider) => provider.id));

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function resultData(result) {
    if (result?.ok === false) {
      const error = new Error(result.error || result.message || "操作失败。");
      error.status = Number(result.status) || 0;
      throw error;
    }
    return result?.data && typeof result.data === "object" ? result.data : (result || {});
  }

  function isCloudSignedIn() {
    return Boolean(state?.runtime?.cloud?.enabled);
  }

  function imReadErrorMessage(error) {
    const message = String(error?.message || "").trim();
    if (Number(error?.status) === 404 || /\b404\b/.test(message)) {
      return "当前 Mia Cloud 尚未提供 IM 接入服务，请升级云端后重试。";
    }
    return message || "IM 通道读取失败。";
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
    clawbotStatuses = {};
    clawbotQrDataUrls.clear();
    clearClawbotStatusPolling();
    busyActions.clear();
  }

  function getAvailableProviders() {
    const remote = Array.isArray(providers) && providers.length ? providers : fallbackProviders;
    const available = remote.filter((provider) => (
      supportedProviderIds.has(String(provider?.id || "")) && provider?.availability === "available"
    ));
    return available.length ? available : fallbackProviders;
  }

  function providerFor(id) {
    const providerId = String(id || "");
    return getAvailableProviders().find((provider) => provider.id === providerId)
      || fallbackProviders.find((provider) => provider.id === providerId)
      || fallbackProviders[0];
  }

  function isWechatClawbot(provider) {
    return String(provider || "") === "wechat_clawbot";
  }

  function localRelayDeviceId() {
    return String(
      state?.runtime?.cloud?.deviceId
      || state?.runtime?.cloud?.device_id
      || state?.runtime?.localDevice?.id
      || state?.runtime?.localDevice?.deviceId
      || ""
    ).trim();
  }

  function defaultDraft(provider = "feishu") {
    const selectedProvider = supportedProviderIds.has(String(provider)) ? String(provider) : "feishu";
    return {
      id: "",
      provider: selectedProvider,
      botId: String(bots[0]?.id || bots[0]?.key || ""),
      name: "",
      enabled: isWechatClawbot(selectedProvider),
      allowedSenderIds: "",
      allowAllSenders: false,
      allowGroupMessages: false,
      relayDeviceId: localRelayDeviceId(),
      callbackUrl: "",
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
      relayDeviceId: String(settings.relayDeviceId || settings.relay_device_id || localRelayDeviceId()),
      callbackUrl: String(channel?.callbackUrl || ""),
      credentials: {},
      hasCredentials: channel?.hasCredentials === true
    };
  }

  function setBusy(key, value) {
    if (value) busyActions.add(key);
    else busyActions.delete(key);
  }

  async function displayableClawbotStatus(status) {
    const qrContent = String(status?.qrUrl || status?.qr_url || "").trim();
    if (!qrContent || /^data:image\//i.test(qrContent)) return status;
    const cached = clawbotQrDataUrls.get(qrContent);
    if (cached) return { ...status, qrUrl: cached, qr_url: cached };
    if (!window.mia?.social?.encodeWechatClawbotQr) {
      return { ...status, qrUrl: "", qr_url: "", message: "微信二维码暂时无法显示，请重新连接。" };
    }
    try {
      const encoded = resultData(await window.mia.social.encodeWechatClawbotQr(qrContent));
      const dataUrl = String(encoded?.dataUrl || encoded?.data_url || "").trim();
      if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(dataUrl)) throw new Error("invalid QR image");
      clawbotQrDataUrls.set(qrContent, dataUrl);
      return { ...status, qrUrl: dataUrl, qr_url: dataUrl };
    } catch {
      return { ...status, qrUrl: "", qr_url: "", message: "微信二维码生成失败，请重新连接。" };
    }
  }

  async function refreshClawbotStatus(channelId) {
    if (!window.mia?.social?.getWechatClawbotStatus) return null;
    const result = await displayableClawbotStatus(
      resultData(await window.mia.social.getWechatClawbotStatus(channelId))
    );
    clawbotStatuses = { ...clawbotStatuses, [channelId]: result };
    return result;
  }

  function stopClawbotStatusPolling(channelId) {
    const timer = clawbotStatusTimers.get(channelId);
    if (timer) window.clearTimeout(timer);
    clawbotStatusTimers.delete(channelId);
  }

  function clearClawbotStatusPolling() {
    for (const channelId of clawbotStatusTimers.keys()) stopClawbotStatusPolling(channelId);
  }

  function clawbotStatusNeedsPolling(status) {
    return ["waiting_for_scan", "scanned", "pairing_code_required", "verifying"].includes(
      String(status?.state || "")
    );
  }

  function scheduleClawbotStatusPolling(channelId) {
    stopClawbotStatusPolling(channelId);
    if (!clawbotStatusNeedsPolling(clawbotStatuses[channelId])) return;
    const timer = window.setTimeout(async () => {
      clawbotStatusTimers.delete(channelId);
      try {
        await refreshClawbotStatus(channelId);
      } catch {}
      requestRender?.();
      scheduleClawbotStatusPolling(channelId);
    }, 1500);
    clawbotStatusTimers.set(channelId, timer);
  }

  async function refreshClawbotStatuses() {
    const ids = channels
      .filter((channel) => isWechatClawbot(channel?.provider))
      .map((channel) => String(channel.id || ""))
      .filter(Boolean);
    await Promise.all(ids.map((id) => refreshClawbotStatus(id).catch(() => null)));
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
      channels = (Array.isArray(channelPayload.channels) ? channelPayload.channels : []).filter((channel) => (
        supportedProviderIds.has(String(channel?.provider || ""))
      ));
      providers = (Array.isArray(channelPayload.providers) ? channelPayload.providers : []).filter((provider) => (
        supportedProviderIds.has(String(provider?.id || ""))
      ));
      bots = Array.isArray(botPayload.bots) ? botPayload.bots : [];
      clawbotStatuses = {};
      await refreshClawbotStatuses();
      channels.filter((channel) => isWechatClawbot(channel?.provider))
        .forEach((channel) => scheduleClawbotStatusPolling(String(channel.id || "")));
      loaded = true;
    } catch (error) {
      loaded = true;
      errorText = imReadErrorMessage(error);
    } finally {
      loading = false;
      requestRender?.();
    }
  }

  function renderSignedOut() {
    return `
      <div class="settings-section-label">IM 接入</div>
      <section class="im-channel-empty settings-row settings-group-start settings-group-end">
        <div><strong>登录 Mia Cloud 后连接飞书或微信</strong></div>
      </section>`;
  }

  function botName(channel) {
    const bot = bots.find((item) => String(item?.id || item?.key || "") === String(channel?.botId || ""));
    return String(bot?.displayName || bot?.name || channel?.botId || "Bot");
  }

  function channelStatus(channel) {
    const error = String(channel?.lastError || "");
    if (error) return { label: "需要处理", warning: true };
    if (isWechatClawbot(channel?.provider)) {
      const relay = clawbotStatuses[channel.id] || {};
      if (relay.linked) return { label: "已连接" };
      if (clawbotStatusNeedsPolling(relay)) return { label: "等待扫码" };
      return { label: channel.enabled ? "未连接" : "已暂停" };
    }
    return { label: channel.enabled ? "已启用" : "已暂停" };
  }

  function providerStatus(provider, providerChannels) {
    if (!providerChannels.length) return { label: "未连接" };
    if (providerChannels.some((channel) => channelStatus(channel).warning)) return { label: "需要处理", warning: true };
    if (isWechatClawbot(provider.id) && providerChannels.some((channel) => !clawbotStatuses[channel.id]?.linked)) {
      return { label: "待连接" };
    }
    return { label: "已连接" };
  }

  function safeQrImageUrl(value) {
    const url = String(value || "").trim();
    if (/^https:\/\//i.test(url)) return url;
    if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(url)) return url;
    return "";
  }

  function callbackMarkup(callback) {
    const value = String(callback || "");
    if (!value) return "";
    return `
      <div class="im-channel-callback">
        <code title="${escapeHtml(value)}">${escapeHtml(value)}</code>
        <button class="settings-secondary-button" type="button" data-im-action="copy" data-callback="${escapeHtml(value)}">复制</button>
      </div>`;
  }

  function clawbotStatusMarkup(channel) {
    const status = clawbotStatuses[channel.id];
    if (!status) return "";
    const statusName = String(status.state || "");
    const message = String(status.message || "");
    const qrUrl = safeQrImageUrl(status.qrUrl || status.qr_url);
    return `
      <div class="im-channel-clawbot-status" data-clawbot-state="${escapeHtml(statusName)}">
        ${message ? `<p>${escapeHtml(message)}</p>` : ""}
        ${qrUrl ? `<img class="im-channel-clawbot-qr" src="${escapeHtml(qrUrl)}" alt="微信二维码">` : ""}
        ${statusName === "pairing_code_required" ? `
          <form class="im-channel-pairing" data-im-pairing-form data-channel-id="${escapeHtml(channel.id)}">
            <input name="pairingCode" inputmode="numeric" autocomplete="one-time-code" maxlength="32" placeholder="配对码">
            <button class="settings-secondary-button" type="submit">确认</button>
          </form>` : ""}
      </div>`;
  }

  function channelConnection(channel) {
    const isWechat = isWechatClawbot(channel.provider);
    const relay = clawbotStatuses[channel.id] || {};
    const status = channelStatus(channel);
    const busy = busyActions.has(channel.id);
    const error = String(channel.lastError || "");
    return `
      <div class="im-channel-connection">
        <div class="im-channel-connection-head">
          <strong>${escapeHtml(botName(channel))}</strong>
          <span class="im-channel-status${status.warning ? " warning" : ""}">${escapeHtml(status.label)}</span>
        </div>
        ${!isWechat ? callbackMarkup(channel.callbackUrl) : ""}
        ${isWechat ? clawbotStatusMarkup(channel) : ""}
        ${error ? `<p class="im-channel-error">${escapeHtml(error)}</p>` : ""}
        <div class="im-channel-actions">
          ${isWechat
            ? `<button class="primary" type="button" data-im-action="clawbot-connect" data-channel-id="${escapeHtml(channel.id)}" ${busy ? "disabled" : ""}>${relay.linked ? "重新连接微信" : "连接微信"}</button>`
            : `<button class="settings-secondary-button" type="button" data-im-action="test" data-channel-id="${escapeHtml(channel.id)}" ${busy ? "disabled" : ""}>检查</button>`}
          <button class="settings-secondary-button" type="button" data-im-action="edit" data-channel-id="${escapeHtml(channel.id)}" ${busy ? "disabled" : ""}>管理</button>
        </div>
      </div>`;
  }

  function providerDescription(providerId) {
    return providerId === "feishu" ? "通过飞书应用收发消息" : "扫码连接当前设备的微信";
  }

  function providerCard(provider) {
    const providerChannels = channels.filter((channel) => channel.provider === provider.id);
    const status = providerStatus(provider, providerChannels);
    const actionLabel = providerChannels.length ? `添加${provider.label}` : `连接${provider.label}`;
    return `
      <article class="im-channel-provider-card">
        <div class="im-channel-card-head">
          <div>
            <strong>${escapeHtml(provider.label)}</strong>
            <p>${escapeHtml(providerDescription(provider.id))}</p>
          </div>
          <span class="im-channel-status${status.warning ? " warning" : ""}">${escapeHtml(status.label)}</span>
        </div>
        ${providerChannels.length ? `<div class="im-channel-connections">${providerChannels.map(channelConnection).join("")}</div>` : ""}
        <div class="im-channel-actions im-channel-provider-actions">
          <button class="${providerChannels.length ? "settings-secondary-button" : "primary"}" type="button" data-im-action="create" data-provider-id="${escapeHtml(provider.id)}">${escapeHtml(actionLabel)}</button>
        </div>
      </article>`;
  }

  function credentialFields(current) {
    if (isWechatClawbot(current.provider)) {
      return `<input name="relayDeviceId" type="hidden" value="${escapeHtml(current.relayDeviceId || localRelayDeviceId())}">`;
    }
    return `
      <div class="im-channel-form-grid">
        <label><span>App ID</span><input name="appId" autocomplete="off" value="${escapeHtml(current.credentials.appId || "")}" placeholder="cli_..."></label>
        <label><span>App Secret</span><input name="appSecret" type="password" autocomplete="new-password" value="" placeholder="${current.hasCredentials ? "留空则不修改" : "应用密钥"}"></label>
        <label class="wide"><span>Verification Token</span><input name="verificationToken" type="password" autocomplete="new-password" value="" placeholder="${current.hasCredentials ? "留空则不修改" : "回调验证 Token"}"></label>
      </div>`;
  }

  function accessFields(current) {
    if (isWechatClawbot(current.provider)) return "";
    const open = current.enabled && !current.allowAllSenders && !current.allowedSenderIds ? " open" : "";
    return `
      <details class="im-channel-access"${open}>
        <summary>访问范围</summary>
        <label class="im-channel-toggle"><input name="allowAllSenders" type="checkbox"${current.allowAllSenders ? " checked" : ""}><span>允许所有发送者</span></label>
        <label class="im-channel-senders"><span>允许的飞书 open_id</span><textarea name="allowedSenderIds" rows="3" placeholder="每行一个 open_id">${escapeHtml(current.allowedSenderIds)}</textarea></label>
        <label class="im-channel-toggle"><input name="allowGroupMessages" type="checkbox"${current.allowGroupMessages ? " checked" : ""}><span>接收群消息</span></label>
      </details>`;
  }

  function editor() {
    const current = draft || defaultDraft();
    const isNew = !current.id;
    const provider = providerFor(current.provider);
    const isWechat = isWechatClawbot(current.provider);
    const botOptions = bots.map((bot) => {
      const id = String(bot?.id || bot?.key || "");
      const name = String(bot?.displayName || bot?.name || id);
      return `<option value="${escapeHtml(id)}"${id === current.botId ? " selected" : ""}>${escapeHtml(name)}</option>`;
    }).join("");
    const saveDisabled = !bots.length || busyActions.has("save");
    return `
      <section class="im-channel-editor">
        <div class="im-channel-editor-head">
          <strong>${isNew ? `连接${escapeHtml(provider.label)}` : `${escapeHtml(provider.label)}设置`}</strong>
          <button class="icon-button" type="button" data-im-action="cancel" aria-label="关闭 IM 通道编辑">×</button>
        </div>
        ${bots.length ? "" : '<p class="im-channel-error">请先创建一个 Bot。</p>'}
        <form data-im-form>
          <div class="im-channel-form-grid">
            <label class="wide"><span>绑定 Bot</span><select name="botId" ${bots.length ? "" : "disabled"}><option value="">选择 Bot</option>${botOptions}</select></label>
          </div>
          ${credentialFields(current)}
          ${current.callbackUrl ? `<label class="im-channel-callback-field"><span>回调地址</span>${callbackMarkup(current.callbackUrl)}</label>` : ""}
          ${isWechat ? '<p class="im-channel-field-note">保存后扫码连接微信。</p>' : ""}
          <label class="im-channel-toggle"><input name="enabled" type="checkbox"${current.enabled ? " checked" : ""}><span>启用通道</span></label>
          ${accessFields(current)}
          <div class="im-channel-editor-actions">
            ${current.id ? `<button class="settings-secondary-button danger" type="button" data-im-action="delete" data-channel-id="${escapeHtml(current.id)}">删除</button>` : ""}
            <span class="im-channel-editor-actions-spacer"></span>
            <button class="settings-secondary-button" type="button" data-im-action="cancel">取消</button>
            <button class="primary" type="submit" ${saveDisabled ? "disabled" : ""}>${isNew && isWechat ? "保存并连接" : (isNew ? "保存" : "保存更改")}</button>
          </div>
        </form>
      </section>`;
  }

  function markup() {
    if (!isCloudSignedIn()) return renderSignedOut();
    const content = loading
      ? '<p class="im-channel-loading">正在读取 IM 接入…</p>'
      : `<div class="im-channel-list">${getAvailableProviders().map(providerCard).join("")}</div>`;
    return `
      <div class="im-channel-settings-head">
        <div class="settings-section-label">IM 接入</div>
        ${draft ? "" : '<button class="settings-secondary-button" type="button" data-im-action="refresh">刷新</button>'}
      </div>
      ${errorText ? `<p class="im-channel-error">${escapeHtml(errorText)}</p>` : ""}
      ${draft ? editor() : content}`;
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
      botId: String(fields.get("botId") || ""),
      enabled: fields.get("enabled") === "on",
      allowAllSenders: fields.get("allowAllSenders") === "on",
      allowGroupMessages: fields.get("allowGroupMessages") === "on",
      allowedSenderIds: String(fields.get("allowedSenderIds") || ""),
      relayDeviceId: String(fields.get("relayDeviceId") || localRelayDeviceId()),
      credentials: {
        appId: String(fields.get("appId") || ""),
        appSecret: String(fields.get("appSecret") || ""),
        verificationToken: String(fields.get("verificationToken") || "")
      }
    };
  }

  function payloadFromForm(form) {
    restoreDraftFromForm(form);
    const current = draft || defaultDraft();
    const credentials = {};
    if (current.provider === "feishu") {
      if (current.credentials.appId) credentials.appId = current.credentials.appId;
      if (current.credentials.appSecret) credentials.appSecret = current.credentials.appSecret;
      if (current.credentials.verificationToken) credentials.verificationToken = current.credentials.verificationToken;
    }
    return {
      provider: current.provider,
      botId: current.botId,
      name: current.name,
      enabled: current.enabled,
      settings: {
        allowedSenderIds: isWechatClawbot(current.provider)
          ? []
          : current.allowedSenderIds.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
        allowAllSenders: isWechatClawbot(current.provider) ? false : current.allowAllSenders,
        allowGroupMessages: isWechatClawbot(current.provider) ? false : current.allowGroupMessages,
        ...(isWechatClawbot(current.provider) ? { relayDeviceId: current.relayDeviceId || localRelayDeviceId() } : {})
      },
      ...(Object.keys(credentials).length ? { credentials } : {})
    };
  }

  async function startWechatLink(channel, payload) {
    const deviceId = String(payload?.settings?.relayDeviceId || localRelayDeviceId()).trim();
    if (!deviceId || !window.mia?.social?.startWechatClawbotLink) return;
    const status = await displayableClawbotStatus(
      resultData(await window.mia.social.startWechatClawbotLink(channel.id, { deviceId }))
    );
    clawbotStatuses = { ...clawbotStatuses, [channel.id]: status };
    scheduleClawbotStatusPolling(channel.id);
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
        if (!currentId && isWechatClawbot(channel.provider)) {
          try {
            await startWechatLink(channel, payload);
          } catch (error) {
            errorText = error?.message || "微信已保存，但暂时无法启动扫码。";
          }
        }
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
    if (action === "delete" && !window.confirm(`删除“${channel.name || "这个 IM 接入"}”？`)) return;
    setBusy(channelId, true);
    errorText = "";
    renderImChannelSettings();
    try {
      if (action === "clawbot-connect") {
        await startWechatLink(channel, { settings: channel.settings || {} });
      } else if (action === "test") {
        const result = resultData(await window.mia.social.testImChannel(channelId));
        if (result.channel) channels = channels.map((item) => item.id === result.channel.id ? result.channel : item);
      } else if (action === "delete") {
        if (isWechatClawbot(channel.provider) && window.mia.social.disconnectWechatClawbot) {
          await window.mia.social.disconnectWechatClawbot(channelId).catch(() => null);
        }
        resultData(await window.mia.social.deleteImChannel(channelId));
        stopClawbotStatusPolling(channelId);
        channels = channels.filter((item) => item.id !== channelId);
        const { [channelId]: _removed, ...remainingStatuses } = clawbotStatuses;
        clawbotStatuses = remainingStatuses;
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

  async function submitClawbotPairingCode(form) {
    const channelId = String(form?.dataset?.channelId || "").trim();
    const code = String(new FormData(form).get("pairingCode") || "").trim();
    if (!channelId || !code) return;
    setBusy(channelId, true);
    errorText = "";
    renderImChannelSettings();
    try {
      const status = await displayableClawbotStatus(
        resultData(await window.mia.social.submitWechatClawbotPairingCode(channelId, { code }))
      );
      clawbotStatuses = { ...clawbotStatuses, [channelId]: status };
      scheduleClawbotStatusPolling(channelId);
    } catch (error) {
      errorText = error?.message || "微信配对码提交失败。";
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
        draft = defaultDraft(button.dataset.providerId || "feishu");
        renderImChannelSettings();
      } else if (action === "cancel") {
        draft = null;
        errorText = "";
        renderImChannelSettings();
      } else if (action === "refresh") {
        loadChannels({ force: true });
      } else if (action === "copy") {
        copyCallback(button.dataset.callback || "");
      } else if (["edit", "delete", "test", "clawbot-connect"].includes(action)) {
        runAction(action, button.dataset.channelId || "");
      }
    });
    els.imChannelSettings.addEventListener("submit", (event) => {
      if (!event.target.matches("[data-im-form]")) return;
      event.preventDefault();
      saveDraft(event.target);
    });
    els.imChannelSettings.addEventListener("submit", (event) => {
      if (!event.target.matches("[data-im-pairing-form]")) return;
      event.preventDefault();
      submitClawbotPairingCode(event.target);
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
