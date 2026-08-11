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
  let wechatBotPickerChannelId = "";
  let clawbotStatuses = {};
  const clawbotQrDataUrls = new Map();
  const clawbotStatusTimers = new Map();
  const busyActions = new Set();

  const fallbackProviders = [
    { id: "feishu", label: "飞书", availability: "available" },
    { id: "wechat_clawbot", label: "微信", availability: "available", transport: "runtime-owned" }
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
    wechatBotPickerChannelId = "";
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

  function botId(bot) {
    return String(bot?.id || bot?.key || "").trim();
  }

  function botRuntimeKind(bot) {
    return String(
      bot?.runtimeKind
      || bot?.runtime_kind
      || bot?.runtimeConfig?.runtimeKind
      || bot?.runtimeConfig?.runtime_kind
      || ""
    ).trim();
  }

  function isCloudBot(bot) {
    const kind = botRuntimeKind(bot);
    if (window.miaCloudRuntime?.normalizeRuntimeKind?.(kind) === "cloud-claude-code") return true;
    return kind === "cloud-claude-code" || String(bot?.runtimeStatus || bot?.runtime_status || "") === "cloud";
  }

  function isCloudWechatChannel(channel) {
    if (!isWechatClawbot(channel?.provider)) return false;
    const transport = String(channel?.transport || channel?.settings?.transport || "").trim();
    return transport === "cloud" || isCloudBot(botForId(channel?.botId));
  }

  function clawbotStatusData(result) {
    const data = resultData(result);
    return data?.status && typeof data.status === "object" ? data.status : data;
  }

  function cloudBots() {
    return bots.filter(isCloudBot);
  }

  function defaultBot() {
    return cloudBots()[0] || bots[0] || null;
  }

  function botForId(id) {
    const wanted = String(id || "");
    return bots.find((bot) => botId(bot) === wanted) || null;
  }

  function defaultDraft(provider = "feishu") {
    const selectedProvider = supportedProviderIds.has(String(provider)) ? String(provider) : "feishu";
    return {
      id: "",
      provider: selectedProvider,
      botId: botId(defaultBot()),
      name: "",
      enabled: true,
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
    const channel = channels.find((item) => String(item?.id || "") === String(channelId || ""));
    if (!channel) return null;
    const cloudManaged = isCloudWechatChannel(channel);
    const getter = cloudManaged
      ? window.mia?.social?.getCloudWechatClawbotStatus
      : window.mia?.social?.getWechatClawbotStatus;
    if (!getter) return null;
    const result = await displayableClawbotStatus(
      clawbotStatusData(await getter(channelId))
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

  function botName(bot, fallback = "Bot") {
    return String(bot?.displayName || bot?.display_name || bot?.name || fallback || "Bot");
  }

  function botAvatar(bot, fallback = "Bot") {
    const name = botName(bot, fallback);
    const avatar = bot?.avatar && typeof bot.avatar === "object" ? bot.avatar : {};
    const input = {
      id: botId(bot) || fallback,
      displayName: name,
      avatarImage: bot?.avatarImage || bot?.avatar_image || avatar.image || "",
      avatarCrop: bot?.avatarCrop || bot?.avatar_crop || avatar.crop || null,
      color: bot?.color || bot?.avatarColor || bot?.avatar_color || avatar.color || ""
    };
    return window.miaAvatarResolve?.resolveAvatarForContact?.(input) || {
      image: input.avatarImage,
      crop: input.avatarCrop,
      color: input.color || "#5e5ce6",
      text: name
    };
  }

  function botAvatarMarkup(bot, fallback = "Bot") {
    const name = botName(bot, fallback);
    const avatar = botAvatar(bot, fallback);
    if (window.miaAvatar?.avatarHtml) {
      return window.miaAvatar.avatarHtml({
        tag: "span",
        className: "avatar im-channel-bot-avatar",
        image: avatar.image,
        crop: avatar.crop,
        color: avatar.color,
        text: avatar.text || name,
        attrs: 'aria-hidden="true"'
      });
    }
    return `<span class="avatar im-channel-bot-avatar" aria-hidden="true" style="background-color:${escapeHtml(avatar.color || "#5e5ce6")};">${escapeHtml(Array.from(name).slice(0, 2).join(""))}</span>`;
  }

  function wechatChannel() {
    const candidates = channels.filter((channel) => isWechatClawbot(channel?.provider));
    const cloud = candidates.find((channel) => isCloudWechatChannel(channel));
    if (cloud) return cloud;
    const localDeviceId = localRelayDeviceId();
    if (localDeviceId) {
      const local = candidates.find((channel) => String(
        channel?.settings?.relayDeviceId || channel?.settings?.relay_device_id || ""
      ) === localDeviceId);
      if (local) return local;
    }
    return candidates[0] || null;
  }

  function selectableWechatBots(channel = null) {
    const selected = channel ? botForId(channel.botId) : null;
    const preferred = cloudBots();
    const source = preferred.length ? preferred : bots;
    const list = selected && !source.some((bot) => botId(bot) === botId(selected))
      ? [selected, ...source]
      : source;
    return list.filter((bot, index) => botId(bot) && list.findIndex((item) => botId(item) === botId(bot)) === index);
  }

  function channelStatus(channel) {
    const error = String(channel?.lastError || "");
    if (error) return { label: "需要处理", warning: true };
    if (isWechatClawbot(channel?.provider)) {
      const relay = clawbotStatuses[channel.id] || {};
      if (String(relay.state || "") === "reauth_required") {
        return { label: "需要重新连接", warning: true };
      }
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
    if (!status || status.linked) return "";
    const statusName = String(status.state || "");
    const message = String(status.message || "");
    const qrUrl = safeQrImageUrl(status.qrUrl || status.qr_url);
    return `
      <div class="im-channel-clawbot-status" data-clawbot-state="${escapeHtml(statusName)}">
        ${qrUrl ? `<img class="im-channel-clawbot-qr" src="${escapeHtml(qrUrl)}" alt="二维码">` : (message ? `<p>${escapeHtml(message)}</p>` : "")}
        ${statusName === "pairing_code_required" ? `
          <form class="im-channel-pairing" data-im-pairing-form data-channel-id="${escapeHtml(channel.id)}">
            <input name="pairingCode" inputmode="numeric" autocomplete="one-time-code" maxlength="32" placeholder="配对码">
            <button class="settings-secondary-button" type="submit">确认</button>
          </form>` : ""}
      </div>`;
  }

  function channelConnection(channel) {
    const status = channelStatus(channel);
    const busy = busyActions.has(channel.id);
    const error = String(channel.lastError || "");
    const bot = botForId(channel?.botId);
    return `
      <div class="im-channel-connection">
        <div class="im-channel-connection-head">
          <strong>${escapeHtml(botName(bot, channel?.botId || "Bot"))}</strong>
          <span class="im-channel-status${status.warning ? " warning" : ""}">${escapeHtml(status.label)}</span>
        </div>
        ${callbackMarkup(channel.callbackUrl)}
        ${error ? `<p class="im-channel-error">${escapeHtml(error)}</p>` : ""}
        <div class="im-channel-actions">
          <button class="settings-secondary-button" type="button" data-im-action="test" data-channel-id="${escapeHtml(channel.id)}" ${busy ? "disabled" : ""}>检查</button>
          <button class="settings-secondary-button" type="button" data-im-action="edit" data-channel-id="${escapeHtml(channel.id)}" ${busy ? "disabled" : ""}>管理</button>
        </div>
      </div>`;
  }

  function wechatBotRow(channel) {
    const selected = botForId(channel.botId) || { id: channel.botId, displayName: channel.botId || "Bot" };
    const canChange = selectableWechatBots(channel).length > 1;
    return `
      <div class="im-channel-bot-row">
        ${botAvatarMarkup(selected, channel.botId || "Bot")}
        <span class="im-channel-bot-name">${escapeHtml(botName(selected, channel.botId || "Bot"))}</span>
        ${canChange ? `<button class="im-channel-bot-change" type="button" data-im-action="wechat-pick-bot" data-channel-id="${escapeHtml(channel.id)}">更换</button>` : ""}
      </div>`;
  }

  function wechatProviderCard(provider) {
    const channel = wechatChannel();
    const relay = channel ? (clawbotStatuses[channel.id] || {}) : {};
    const status = channel ? channelStatus(channel) : { label: "未连接" };
    const busy = busyActions.has(channel?.id || "wechat-connect");
    const error = String(channel?.lastError || "");
    return `
      <article class="im-channel-provider-card im-channel-wechat-card">
        <div class="im-channel-card-head">
          <div class="im-channel-provider-title">
            ${providerIconMarkup(provider.id)}
            <span class="im-channel-provider-name">${escapeHtml(provider.label)}</span>
          </div>
          <span class="im-channel-status${status.warning ? " warning" : ""}">${escapeHtml(status.label)}</span>
        </div>
        ${channel ? `
          <div class="im-channel-wechat-body">
            ${wechatBotRow(channel)}
            ${clawbotStatusMarkup(channel)}
            ${error ? `<p class="im-channel-error">${escapeHtml(error)}</p>` : ""}
          </div>` : ""}
        <div class="im-channel-actions im-channel-provider-actions">
          <button class="${channel ? "settings-secondary-button" : "primary"}" type="button" data-im-action="wechat-connect" ${channel ? `data-channel-id="${escapeHtml(channel.id)}"` : ""} ${busy ? "disabled" : ""}>${channel && relay.linked ? "重新连接" : "连接"}</button>
        </div>
      </article>`;
  }

  function providerIconMarkup(providerId) {
    const assetPath = providerId === "wechat_clawbot"
      ? "./assets/brands/wechat.png"
      : "./assets/brands/feishu.png";
    return `<img class="im-channel-provider-icon" src="${assetPath}" alt="">`;
  }

  function providerCard(provider) {
    if (isWechatClawbot(provider.id)) return wechatProviderCard(provider);
    const providerChannels = channels.filter((channel) => channel.provider === provider.id);
    const status = providerStatus(provider, providerChannels);
    const actionLabel = providerChannels.length ? `添加${provider.label}` : `连接${provider.label}`;
    return `
      <article class="im-channel-provider-card">
        <div class="im-channel-card-head">
          <div class="im-channel-provider-title">
            ${providerIconMarkup(provider.id)}
            <span class="im-channel-provider-name">${escapeHtml(provider.label)}</span>
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
    const botOptions = bots.map((bot) => {
      const id = botId(bot);
      const name = botName(bot, id);
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
            <label class="wide"><span>Bot</span><select name="botId" ${bots.length ? "" : "disabled"}>${botOptions}</select></label>
          </div>
          ${credentialFields(current)}
          ${current.callbackUrl ? `<label class="im-channel-callback-field"><span>回调地址</span>${callbackMarkup(current.callbackUrl)}</label>` : ""}
          ${accessFields(current)}
          <div class="im-channel-editor-actions">
            ${current.id ? `<button class="settings-secondary-button danger" type="button" data-im-action="delete" data-channel-id="${escapeHtml(current.id)}">删除</button>` : ""}
            <span class="im-channel-editor-actions-spacer"></span>
            <button class="settings-secondary-button" type="button" data-im-action="cancel">取消</button>
            <button class="primary" type="submit" ${saveDisabled ? "disabled" : ""}>${isNew ? "保存" : "保存更改"}</button>
          </div>
        </form>
      </section>`;
  }

  function wechatBotPicker() {
    const channel = channels.find((item) => item.id === wechatBotPickerChannelId && isWechatClawbot(item.provider));
    if (!channel) return "";
    const selectedBotId = String(channel.botId || "");
    const choices = selectableWechatBots(channel);
    return `
      <section class="im-channel-bot-picker">
        <div class="im-channel-editor-head">
          <span>选择 Bot</span>
          <button class="icon-button" type="button" data-im-action="cancel" aria-label="关闭 Bot 选择">×</button>
        </div>
        <div class="im-channel-bot-choices">
          ${choices.map((bot) => {
            const id = botId(bot);
            const selected = id === selectedBotId;
            const busy = busyActions.has(channel.id);
            return `
              <button class="im-channel-bot-choice${selected ? " selected" : ""}" type="button" data-im-action="wechat-select-bot" data-channel-id="${escapeHtml(channel.id)}" data-bot-id="${escapeHtml(id)}" ${selected ? "aria-pressed=\"true\"" : ""} ${busy ? "disabled" : ""}>
                ${botAvatarMarkup(bot, id)}
                <span>${escapeHtml(botName(bot, id))}</span>
                ${selected ? '<span class="im-channel-bot-check" aria-hidden="true">✓</span>' : ""}
              </button>`;
          }).join("")}
        </div>
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
        ${draft || wechatBotPickerChannelId ? "" : '<button class="settings-secondary-button" type="button" data-im-action="refresh">刷新</button>'}
      </div>
      ${errorText ? `<p class="im-channel-error">${escapeHtml(errorText)}</p>` : ""}
      ${wechatBotPickerChannelId ? wechatBotPicker() : (draft ? editor() : content)}`;
  }

  function renderImChannelSettings() {
    if (!els?.imChannelSettings) return;
    resetForChangedCloudAccount();
    els.imChannelSettings.innerHTML = markup();
    window.miaAvatar?.hydrateAvatarMedia?.(els.imChannelSettings);
    if (isCloudSignedIn() && !loaded && !loading) loadChannels();
  }

  function restoreDraftFromForm(form) {
    if (!draft || !form) return;
    const fields = new FormData(form);
    draft = {
      ...draft,
      botId: String(fields.get("botId") || ""),
      enabled: true,
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
    const selectedBot = botForId(current.botId);
    const cloudWechat = isWechatClawbot(current.provider) && isCloudBot(selectedBot);
    return {
      provider: current.provider,
      botId: current.botId,
      name: current.name,
      enabled: true,
      settings: {
        allowedSenderIds: isWechatClawbot(current.provider)
          ? []
          : current.allowedSenderIds.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
        allowAllSenders: isWechatClawbot(current.provider) ? false : current.allowAllSenders,
        allowGroupMessages: isWechatClawbot(current.provider) ? false : current.allowGroupMessages,
        ...((isWechatClawbot(current.provider) && !cloudWechat)
          ? { relayDeviceId: current.relayDeviceId || localRelayDeviceId() }
          : {})
      },
      ...(Object.keys(credentials).length ? { credentials } : {})
    };
  }

  async function startWechatLink(channel, payload) {
    const cloudManaged = isCloudWechatChannel(channel);
    if (cloudManaged) {
      if (window.mia?.social?.disconnectWechatClawbot) {
        await window.mia.social.disconnectWechatClawbot(channel.id).catch(() => null);
      }
      if (!window.mia?.social?.startCloudWechatClawbotLink) {
        throw new Error("当前 Mia 版本缺少云端微信连接能力。");
      }
      const status = await displayableClawbotStatus(
        clawbotStatusData(await window.mia.social.startCloudWechatClawbotLink(channel.id))
      );
      clawbotStatuses = { ...clawbotStatuses, [channel.id]: status };
      scheduleClawbotStatusPolling(channel.id);
      return;
    }
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

  async function connectWechat(channelId = "") {
    const existing = channels.find((channel) => channel.id === channelId && isWechatClawbot(channel.provider));
    if (existing) {
      await runAction("clawbot-connect", existing.id);
      return;
    }
    const bot = defaultBot();
    if (!bot) {
      errorText = "请先创建 Bot。";
      renderImChannelSettings();
      return;
    }
    const key = "wechat-connect";
    setBusy(key, true);
    errorText = "";
    renderImChannelSettings();
    const payload = {
      provider: "wechat_clawbot",
      botId: botId(bot),
      enabled: true,
      settings: isCloudBot(bot) ? {} : { relayDeviceId: localRelayDeviceId() }
    };
    try {
      const data = resultData(await window.mia?.social?.createImChannel?.(payload));
      const channel = data.channel;
      if (!channel) throw new Error("微信连接保存失败。");
      channels = [channel, ...channels];
      loaded = true;
      await startWechatLink(channel, payload);
    } catch (error) {
      errorText = error?.message || "微信连接失败。";
      reportError?.(`微信连接失败：${errorText}`);
    } finally {
      setBusy(key, false);
      renderImChannelSettings();
    }
  }

  async function selectWechatBot(channelId, nextBotId) {
    const channel = channels.find((item) => item.id === channelId && isWechatClawbot(item.provider));
    const choices = selectableWechatBots(channel);
    const next = choices.find((bot) => botId(bot) === String(nextBotId || ""));
    if (!channel || !next) return;
    if (channel.botId === botId(next)) {
      wechatBotPickerChannelId = "";
      renderImChannelSettings();
      return;
    }
    setBusy(channelId, true);
    errorText = "";
    renderImChannelSettings();
    try {
      const data = resultData(await window.mia.social.updateImChannel(channelId, { botId: botId(next) }));
      if (data.channel) channels = channels.map((item) => item.id === data.channel.id ? data.channel : item);
      wechatBotPickerChannelId = "";
    } catch (error) {
      errorText = error?.message || "Bot 更换失败。";
      reportError?.(`Bot 更换失败：${errorText}`);
    } finally {
      setBusy(channelId, false);
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
        if (isWechatClawbot(channel.provider)) {
          const disconnect = isCloudWechatChannel(channel)
            ? window.mia.social.disconnectCloudWechatClawbot
            : window.mia.social.disconnectWechatClawbot;
          if (disconnect) await disconnect(channelId).catch(() => null);
        }
        resultData(await window.mia.social.deleteImChannel(channelId));
        stopClawbotStatusPolling(channelId);
        channels = channels.filter((item) => item.id !== channelId);
        const { [channelId]: _removed, ...remainingStatuses } = clawbotStatuses;
        clawbotStatuses = remainingStatuses;
        if (draft?.id === channelId) draft = null;
        if (wechatBotPickerChannelId === channelId) wechatBotPickerChannelId = "";
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
    const channel = channels.find((item) => String(item?.id || "") === channelId);
    if (!channelId || !code) return;
    setBusy(channelId, true);
    errorText = "";
    renderImChannelSettings();
    try {
      const result = isCloudWechatChannel(channel)
        ? await window.mia.social.submitCloudWechatClawbotPairingCode(channelId, { code })
        : await window.mia.social.submitWechatClawbotPairingCode(channelId, { code });
      const status = await displayableClawbotStatus(
        clawbotStatusData(result)
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
        wechatBotPickerChannelId = "";
        renderImChannelSettings();
      } else if (action === "cancel") {
        draft = null;
        wechatBotPickerChannelId = "";
        errorText = "";
        renderImChannelSettings();
      } else if (action === "refresh") {
        loadChannels({ force: true });
      } else if (action === "copy") {
        copyCallback(button.dataset.callback || "");
      } else if (action === "wechat-connect") {
        connectWechat(button.dataset.channelId || "");
      } else if (action === "wechat-pick-bot") {
        wechatBotPickerChannelId = String(button.dataset.channelId || "");
        draft = null;
        renderImChannelSettings();
      } else if (action === "wechat-select-bot") {
        selectWechatBot(button.dataset.channelId || "", button.dataset.botId || "");
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
