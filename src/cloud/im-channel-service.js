"use strict";

const crypto = require("node:crypto");
const {
  getImChannelProvider,
  isSupportedImChannelProvider,
  listImChannelProviders,
  normalizeImChannelProvider
} = require("../shared/im-channel-contracts.js");
const { parseWechatMpEventXml, verifyWechatMpSignature } = require("./wechat-auth.js");

const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/";
const FEISHU_REPLY_URL = "https://open.feishu.cn/open-apis/im/v1/messages/";
const WECHAT_TOKEN_URL = "https://api.weixin.qq.com/cgi-bin/token";
const WECHAT_CUSTOM_MESSAGE_URL = "https://api.weixin.qq.com/cgi-bin/message/custom/send";
const MAX_ALLOWED_SENDERS = 100;
const MAX_TEXT_LENGTH = 12000;
const MAX_OUTBOUND_TEXT_LENGTH = 1900;

function serviceError(message, status = 400, code = "MIA_IM_CHANNEL_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function trim(value) {
  return String(value || "").trim();
}

function own(object, key) {
  return Boolean(object && typeof object === "object" && Object.prototype.hasOwnProperty.call(object, key));
}

function safeText(value, max = MAX_TEXT_LENGTH) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function bool(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function normalizeIdList(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]/)
      : [];
  return [...new Set(raw
    .map((item) => trim(item))
    .filter((item) => item && item.length <= 160))]
    .slice(0, MAX_ALLOWED_SENDERS);
}

function normalizeSettings(value = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    allowedSenderIds: normalizeIdList(raw.allowedSenderIds || raw.allowed_sender_ids),
    allowAllSenders: bool(raw.allowAllSenders ?? raw.allow_all_senders),
    allowGroupMessages: bool(raw.allowGroupMessages ?? raw.allow_group_messages)
  };
}

function normalizeCredentials(provider, value = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (provider === "feishu") {
    return {
      appId: trim(raw.appId || raw.app_id),
      appSecret: trim(raw.appSecret || raw.app_secret),
      verificationToken: trim(raw.verificationToken || raw.verification_token || raw.token)
    };
  }
  if (provider === "wechat_official_account") {
    return {
      appId: trim(raw.appId || raw.app_id),
      appSecret: trim(raw.appSecret || raw.app_secret),
      token: trim(raw.token || raw.verificationToken || raw.verification_token)
    };
  }
  return {};
}

function requiredCredentialKeys(provider) {
  if (provider === "feishu") return ["appId", "appSecret", "verificationToken"];
  if (provider === "wechat_official_account") return ["appId", "appSecret", "token"];
  return [];
}

function hasCompleteCredentials(provider, credentials = {}) {
  return requiredCredentialKeys(provider).every((key) => trim(credentials[key]));
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(trim(left));
  const b = Buffer.from(trim(right));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function eventDigest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 32);
}

function externalConversationId(channelId, externalChatId) {
  return `botc_im_${eventDigest(`${channelId}\u0000${externalChatId}`)}`;
}

function outboundText(value) {
  const flattened = String(value || "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```(?:[\w+-]+)?\n?/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (flattened.length <= MAX_OUTBOUND_TEXT_LENGTH) return flattened || "（Mia 未生成可发送的文本回复。）";
  return `${flattened.slice(0, MAX_OUTBOUND_TEXT_LENGTH - 1)}…`;
}

function genericProviderError() {
  return "IM 回复投递失败，请在 Mia 的 IM 接入中检查凭据和通道状态。";
}

function providerLabel(provider) {
  return getImChannelProvider(provider)?.label || "IM";
}

function responseError(data, fallback) {
  if (data && typeof data === "object") {
    return trim(data.msg || data.message || data.errmsg || data.error || data.code_description) || fallback;
  }
  return fallback;
}

function createImChannelService({
  store,
  socialStore,
  messagesStore,
  botsStore,
  secretBox,
  fetchImpl = fetch,
  publicOrigin = () => "",
  broadcast = () => {},
  dispatchMessage = () => null,
  log = () => {}
} = {}) {
  if (!store || !socialStore || !messagesStore || !botsStore || !secretBox) {
    throw new Error("createImChannelService requires stores and a secret box");
  }

  const pending = new Set();
  const providerTokens = new Map();

  function clearProviderTokens(channelId) {
    const id = trim(channelId);
    providerTokens.delete(`feishu:${id}`);
    providerTokens.delete(`wechat:${id}`);
  }

  function callbackUrl(channel) {
    const provider = getImChannelProvider(channel?.provider);
    const origin = trim(typeof publicOrigin === "function" ? publicOrigin() : publicOrigin).replace(/\/+$/, "");
    if (!origin || !provider?.callbackPath || !channel?.id) return "";
    return `${origin}/api/im/${provider.callbackPath}/${encodeURIComponent(channel.id)}/events`;
  }

  function publicChannel(channel) {
    if (!channel) return null;
    const { secretsCiphertext: _secretsCiphertext, ...safe } = channel;
    return {
      ...safe,
      providerLabel: providerLabel(channel.provider),
      callbackUrl: callbackUrl(channel)
    };
  }

  function listProviders() {
    return listImChannelProviders().map((provider) => ({ ...provider }));
  }

  function validateProvider(value) {
    const provider = normalizeImChannelProvider(value);
    if (!isSupportedImChannelProvider(provider)) {
      throw serviceError("当前版本尚不支持这个 IM 通道。", 400, "MIA_IM_CHANNEL_PROVIDER_UNSUPPORTED");
    }
    return provider;
  }

  function ownedBot(userId, botId) {
    const id = trim(botId);
    const bot = botsStore.getBot(id);
    if (!bot) throw serviceError("绑定的 Bot 不存在。", 404, "MIA_IM_CHANNEL_BOT_NOT_FOUND");
    if (String(bot.ownerUserId || "") !== String(userId || "")) {
      throw serviceError("只能绑定自己的 Bot。", 403, "MIA_IM_CHANNEL_BOT_FORBIDDEN");
    }
    return bot;
  }

  function decodedCredentials(channel) {
    const ciphertext = trim(channel?.secretsCiphertext);
    if (!ciphertext) return {};
    return secretBox.decryptJson(ciphertext);
  }

  function validateEnabledChannel({ provider, enabled, settings, credentials, hasCredentials }) {
    if (!enabled) return;
    if (!settings.allowAllSenders && !settings.allowedSenderIds.length) {
      throw serviceError("启用 IM 通道前，请至少填写一个可信发送者，或明确允许所有发送者。", 400, "MIA_IM_CHANNEL_SENDER_REQUIRED");
    }
    if (!hasCredentials && !hasCompleteCredentials(provider, credentials)) {
      throw serviceError("启用 IM 通道前，请完整填写应用凭据。", 400, "MIA_IM_CHANNEL_CREDENTIALS_REQUIRED");
    }
  }

  function incomingCredentials(raw, provider) {
    if (!raw || typeof raw !== "object") return {};
    return normalizeCredentials(provider, raw.credentials || raw.secrets || raw);
  }

  function credentialsWereProvided(raw, provider) {
    const incoming = incomingCredentials(raw, provider);
    return Object.values(incoming).some(Boolean);
  }

  function encryptedCredentials(provider, credentials) {
    if (!hasCompleteCredentials(provider, credentials)) return "";
    return secretBox.encryptJson(credentials);
  }

  function channelName(rawName, provider, fallbackBot) {
    const name = safeText(rawName, 80);
    return name || `${providerLabel(provider)} · ${fallbackBot?.displayName || "Bot"}`;
  }

  function createChannel(userId, input = {}) {
    const provider = validateProvider(input.provider);
    const bot = ownedBot(userId, input.botId);
    const settings = normalizeSettings(input.settings || input);
    const credentials = incomingCredentials(input, provider);
    const credentialsPresent = credentialsWereProvided(input, provider);
    const enabled = bool(input.enabled);
    if (credentialsPresent && !hasCompleteCredentials(provider, credentials)) {
      throw serviceError("应用凭据需要完整填写。", 400, "MIA_IM_CHANNEL_CREDENTIALS_INCOMPLETE");
    }
    validateEnabledChannel({
      provider,
      enabled,
      settings,
      credentials,
      hasCredentials: false
    });
    const channel = store.createChannel({
      userId,
      provider,
      botId: bot.id,
      name: channelName(input.name, provider, bot),
      enabled,
      settings,
      secretsCiphertext: credentialsPresent ? encryptedCredentials(provider, credentials) : ""
    });
    clearProviderTokens(channel.id);
    broadcast(userId, { type: "im_channel.updated", channel: publicChannel(channel) });
    return publicChannel(channel);
  }

  function updateChannel(userId, channelId, input = {}) {
    const existing = store.getChannelForUser(userId, channelId, { includeSecrets: true });
    if (!existing) throw serviceError("IM 通道不存在。", 404, "MIA_IM_CHANNEL_NOT_FOUND");
    const provider = own(input, "provider") ? validateProvider(input.provider) : existing.provider;
    const botId = own(input, "botId") || own(input, "bot_id")
      ? trim(input.botId || input.bot_id)
      : existing.botId;
    const bot = ownedBot(userId, botId);
    const settings = own(input, "settings")
      ? normalizeSettings(input.settings)
      : normalizeSettings({ ...existing.settings, ...input });
    const enabled = own(input, "enabled") ? bool(input.enabled) : existing.enabled;
    const changingProvider = provider !== existing.provider;
    const suppliedCredentials = incomingCredentials(input, provider);
    const suppliedCredentialsPresent = credentialsWereProvided(input, provider);
    let nextCiphertext = existing.secretsCiphertext || "";
    let hasCredentials = Boolean(nextCiphertext) && !changingProvider;
    let completeCredentials = {};
    if (suppliedCredentialsPresent) {
      const prior = !changingProvider && nextCiphertext ? decodedCredentials(existing) : {};
      completeCredentials = { ...normalizeCredentials(provider, prior), ...suppliedCredentials };
      if (!hasCompleteCredentials(provider, completeCredentials)) {
        throw serviceError("应用凭据需要完整填写。", 400, "MIA_IM_CHANNEL_CREDENTIALS_INCOMPLETE");
      }
      nextCiphertext = encryptedCredentials(provider, completeCredentials);
      hasCredentials = true;
    } else if (changingProvider) {
      nextCiphertext = "";
      hasCredentials = false;
    }
    validateEnabledChannel({
      provider,
      enabled,
      settings,
      credentials: completeCredentials,
      hasCredentials
    });
    const channel = store.updateChannel(userId, channelId, {
      provider,
      botId: bot.id,
      name: own(input, "name") ? channelName(input.name, provider, bot) : existing.name,
      enabled,
      settings,
      secretsCiphertext: nextCiphertext,
      lastError: ""
    });
    clearProviderTokens(channel.id);
    broadcast(userId, { type: "im_channel.updated", channel: publicChannel(channel) });
    return publicChannel(channel);
  }

  function deleteChannel(userId, channelId) {
    const existing = store.getChannelForUser(userId, channelId);
    if (!existing) throw serviceError("IM 通道不存在。", 404, "MIA_IM_CHANNEL_NOT_FOUND");
    store.deleteChannel(userId, channelId);
    clearProviderTokens(existing.id);
    broadcast(userId, { type: "im_channel.deleted", channelId: existing.id });
    return { ok: true, channelId: existing.id };
  }

  function webhookChannel(channelId, provider) {
    const channel = store.getChannel(channelId, { includeSecrets: true });
    if (!channel || channel.provider !== provider) {
      throw serviceError("IM 通道不存在。", 404, "MIA_IM_CHANNEL_NOT_FOUND");
    }
    return channel;
  }

  function inboundPolicy(channel, senderId, chatType = "p2p") {
    const settings = normalizeSettings(channel.settings);
    if (!channel.enabled) return { ok: false, reason: "disabled" };
    if (chatType !== "p2p" && !settings.allowGroupMessages) return { ok: false, reason: "group_disabled" };
    if (!settings.allowAllSenders && !settings.allowedSenderIds.includes(trim(senderId))) {
      return { ok: false, reason: "sender_not_allowed" };
    }
    return { ok: true };
  }

  function ensureInboundConversation(channel, { externalChatId, senderId, senderLabel = "" } = {}) {
    const conversationId = externalConversationId(channel.id, externalChatId || senderId);
    let conversation = socialStore.getConversation(conversationId);
    let created = false;
    if (!conversation) {
      const bot = ownedBot(channel.userId, channel.botId);
      const display = safeText(senderLabel || senderId, 60) || "外部会话";
      socialStore.createConversation({
        id: conversationId,
        type: "bot",
        name: `${providerLabel(channel.provider)} · ${display}`,
        decorations: {
          botId: bot.id,
          source: "im-channel",
          imChannelId: channel.id,
          imProvider: channel.provider
        }
      });
      socialStore.addConversationMember({ conversationId, memberKind: "user", memberRef: channel.userId });
      socialStore.addConversationMember({ conversationId, memberKind: "bot", memberRef: bot.id, ownerId: channel.userId });
      conversation = socialStore.getConversation(conversationId);
      created = true;
      broadcast(channel.userId, {
        type: "social.conversation_invited",
        conversation,
        invitedBy: { id: channel.userId, displayName: providerLabel(channel.provider) }
      });
    }
    return { conversation, conversationId, created };
  }

  function schedule(task) {
    const promise = Promise.resolve().then(task).catch((error) => {
      // Never log callback payloads or provider credentials. The per-channel status
      // contains a user-actionable, redacted error instead.
      log("[im-channel] background delivery failed", error);
      return null;
    });
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  }

  function acceptInbound(channel, incoming = {}) {
    const senderId = trim(incoming.senderId);
    const text = safeText(incoming.text);
    const eventId = trim(incoming.eventId) || eventDigest(`${channel.id}\u0000${senderId}\u0000${text}`);
    const policy = inboundPolicy(channel, senderId, incoming.chatType);
    store.recordChannelStatus(channel.id, { lastEventAt: new Date().toISOString() });
    if (!policy.ok) return { accepted: false, ignored: policy.reason };
    if (!senderId || !text) return { accepted: false, ignored: "empty_message" };
    if (!store.claimInboundEvent(channel.id, eventId)) return { accepted: true, duplicate: true };
    try {
      const { conversation, conversationId } = ensureInboundConversation(channel, incoming);
      const message = messagesStore.appendMessage({
        conversationId,
        senderKind: "user",
        senderRef: channel.userId,
        bodyMd: text,
        status: "complete"
      });
      if (!message._alreadyExisted) {
        broadcast(channel.userId, { type: "conversation.message_appended", conversationId, message });
      }
      store.createDelivery({
        channelId: channel.id,
        conversationId,
        triggerMessageId: message.id,
        replyRef: trim(incoming.replyRef),
        recipient: incoming.recipient && typeof incoming.recipient === "object" ? incoming.recipient : {}
      });
      store.markInboundEvent(channel.id, eventId, "accepted");
      schedule(async () => {
        try {
          const reply = await dispatchMessage({ userId: channel.userId, conversationId, message, conversation });
          if (reply) await deliverBotReply({ conversationId, message: reply });
        } catch (_error) {
          store.recordChannelStatus(channel.id, { lastError: "Bot 执行失败，请检查运行时是否在线。" });
        }
      });
      return { accepted: true, conversationId, messageId: message.id };
    } catch (error) {
      store.markInboundEvent(channel.id, eventId, "failed");
      throw error;
    }
  }

  async function receiveFeishuCallback(channelId, payload = {}) {
    const channel = webhookChannel(channelId, "feishu");
    const credentials = normalizeCredentials("feishu", decodedCredentials(channel));
    const callbackToken = trim(payload?.token || payload?.header?.token);
    if (!constantTimeEqual(credentials.verificationToken, callbackToken)) {
      throw serviceError("Invalid Feishu verification token.", 403, "MIA_IM_CHANNEL_FEISHU_TOKEN_INVALID");
    }
    if (payload?.type === "url_verification") {
      return { kind: "challenge", challenge: String(payload.challenge || "") };
    }
    if (payload?.encrypt) {
      throw serviceError("飞书加密回调尚未启用；请将 Encrypt Key 留空并使用验证 Token。", 400, "MIA_IM_CHANNEL_FEISHU_ENCRYPTED_CALLBACK");
    }
    if (trim(payload?.header?.event_type) !== "im.message.receive_v1") {
      return { accepted: false, ignored: "event_type" };
    }
    const event = payload.event || {};
    const message = event.message || {};
    if (trim(message.message_type) !== "text") return { accepted: false, ignored: "message_type" };
    let content = {};
    try { content = JSON.parse(String(message.content || "{}")); } catch { content = {}; }
    const senderId = trim(event?.sender?.sender_id?.open_id || event?.sender?.sender_id?.user_id);
    return acceptInbound(channel, {
      eventId: trim(payload?.header?.event_id || message.message_id),
      senderId,
      senderLabel: senderId,
      externalChatId: trim(message.chat_id || senderId),
      chatType: trim(message.chat_type || "p2p"),
      text: content?.text,
      replyRef: trim(message.message_id),
      recipient: { chatId: trim(message.chat_id), senderId }
    });
  }

  async function receiveWechatCallback(channelId, { signature, timestamp, nonce, method = "POST", echostr = "", body = "" } = {}) {
    const channel = webhookChannel(channelId, "wechat_official_account");
    const credentials = normalizeCredentials("wechat_official_account", decodedCredentials(channel));
    if (!verifyWechatMpSignature({ token: credentials.token, signature, timestamp, nonce })) {
      throw serviceError("Invalid WeChat signature.", 403, "MIA_IM_CHANNEL_WECHAT_SIGNATURE_INVALID");
    }
    if (String(method).toUpperCase() === "GET") return { kind: "verification", echostr: String(echostr || "") };
    if (String(method).toUpperCase() !== "POST") {
      throw serviceError("Method not allowed.", 405, "MIA_IM_CHANNEL_METHOD_NOT_ALLOWED");
    }
    const event = parseWechatMpEventXml(body);
    if (trim(event.MsgType) !== "text") return { accepted: false, ignored: "message_type" };
    const senderId = trim(event.FromUserName);
    return acceptInbound(channel, {
      eventId: trim(event.MsgId) || eventDigest(body),
      senderId,
      senderLabel: senderId,
      externalChatId: senderId,
      chatType: "p2p",
      text: event.Content,
      replyRef: senderId,
      recipient: { openId: senderId }
    });
  }

  async function fetchJson(url, options = {}) {
    const response = await fetchImpl(url, options);
    let data = {};
    try { data = await response.json(); } catch { /* provider may return an empty body */ }
    if (!response?.ok) {
      throw serviceError(responseError(data, `Provider HTTP ${response?.status || 502}`), 502, "MIA_IM_CHANNEL_PROVIDER_HTTP");
    }
    return data || {};
  }

  async function feishuToken(channel, credentials) {
    const key = `feishu:${channel.id}`;
    const cached = providerTokens.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const data = await fetchJson(FEISHU_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret })
    });
    if (Number(data.code || 0) !== 0 || !trim(data.tenant_access_token)) {
      throw serviceError(responseError(data, "飞书 Tenant Access Token 获取失败。"), 502, "MIA_IM_CHANNEL_FEISHU_TOKEN_FAILED");
    }
    const expiresIn = Math.max(60, Number(data.expire || data.expires_in || 7200) - 90);
    const token = trim(data.tenant_access_token);
    providerTokens.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
    return token;
  }

  async function wechatToken(channel, credentials) {
    const key = `wechat:${channel.id}`;
    const cached = providerTokens.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const url = new URL(WECHAT_TOKEN_URL);
    url.searchParams.set("grant_type", "client_credential");
    url.searchParams.set("appid", credentials.appId);
    url.searchParams.set("secret", credentials.appSecret);
    const data = await fetchJson(url, { method: "GET" });
    if (data.errcode || !trim(data.access_token)) {
      throw serviceError(responseError(data, "微信公众号 Access Token 获取失败。"), 502, "MIA_IM_CHANNEL_WECHAT_TOKEN_FAILED");
    }
    const expiresIn = Math.max(60, Number(data.expires_in || 7200) - 90);
    const token = trim(data.access_token);
    providerTokens.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
    return token;
  }

  async function verifyChannelCredentials(channel) {
    const credentials = normalizeCredentials(channel.provider, decodedCredentials(channel));
    if (!hasCompleteCredentials(channel.provider, credentials)) {
      throw serviceError("通道缺少完整应用凭据。", 400, "MIA_IM_CHANNEL_CREDENTIALS_REQUIRED");
    }
    if (channel.provider === "feishu") await feishuToken(channel, credentials);
    else if (channel.provider === "wechat_official_account") await wechatToken(channel, credentials);
    else throw serviceError("当前版本尚不支持这个 IM 通道。", 400, "MIA_IM_CHANNEL_PROVIDER_UNSUPPORTED");
  }

  async function sendProviderReply(channel, delivery, message) {
    const credentials = normalizeCredentials(channel.provider, decodedCredentials(channel));
    const text = outboundText(message?.body_md || message?.bodyMd);
    if (channel.provider === "feishu") {
      const token = await feishuToken(channel, credentials);
      const replyRef = trim(delivery.replyRef);
      if (!replyRef) throw serviceError("飞书消息缺少 reply_ref。", 400, "MIA_IM_CHANNEL_REPLY_REF_MISSING");
      const data = await fetchJson(`${FEISHU_REPLY_URL}${encodeURIComponent(replyRef)}/reply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          msg_type: "text",
          content: JSON.stringify({ text }),
          uuid: delivery.id
        })
      });
      if (Number(data.code || 0) !== 0) {
        throw serviceError(responseError(data, "飞书回复发送失败。"), 502, "MIA_IM_CHANNEL_FEISHU_SEND_FAILED");
      }
      return;
    }
    if (channel.provider === "wechat_official_account") {
      const token = await wechatToken(channel, credentials);
      const openId = trim(delivery.recipient?.openId || delivery.replyRef);
      if (!openId) throw serviceError("微信公众号消息缺少 openid。", 400, "MIA_IM_CHANNEL_REPLY_REF_MISSING");
      const url = new URL(WECHAT_CUSTOM_MESSAGE_URL);
      url.searchParams.set("access_token", token);
      const data = await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ touser: openId, msgtype: "text", text: { content: text } })
      });
      if (data.errcode) {
        throw serviceError(responseError(data, "微信公众号回复发送失败。"), 502, "MIA_IM_CHANNEL_WECHAT_SEND_FAILED");
      }
      return;
    }
    throw serviceError("当前版本尚不支持这个 IM 通道。", 400, "MIA_IM_CHANNEL_PROVIDER_UNSUPPORTED");
  }

  async function deliverBotReply({ conversationId, message } = {}) {
    const triggerMessageId = trim(message?.trigger_message_id || message?.triggerMessageId);
    if (!trim(conversationId) || !triggerMessageId) return { delivered: false, ignored: "no_trigger" };
    const delivery = store.findPendingDelivery(conversationId, triggerMessageId);
    if (!delivery) return { delivered: false, ignored: "not_im_message" };
    const channel = store.getChannel(delivery.channelId, { includeSecrets: true });
    if (!channel || !channel.enabled) return { delivered: false, ignored: "channel_disabled" };
    try {
      await sendProviderReply(channel, delivery, message);
      store.markDeliveryDelivered(delivery.id);
      store.recordChannelStatus(channel.id, { lastError: "" });
      return { delivered: true, deliveryId: delivery.id };
    } catch (_error) {
      store.markDeliveryFailed(delivery.id, genericProviderError());
      store.recordChannelStatus(channel.id, { lastError: genericProviderError() });
      return { delivered: false, deliveryId: delivery.id, error: genericProviderError() };
    }
  }

  async function testChannel(userId, channelId) {
    const channel = store.getChannelForUser(userId, channelId, { includeSecrets: true });
    if (!channel) throw serviceError("IM 通道不存在。", 404, "MIA_IM_CHANNEL_NOT_FOUND");
    try {
      await verifyChannelCredentials(channel);
      store.recordChannelStatus(channel.id, { lastError: "" });
      return { ok: true, message: "凭据验证成功。", channel: publicChannel(store.getChannel(channel.id)) };
    } catch (_error) {
      store.recordChannelStatus(channel.id, { lastError: "凭据验证失败，请检查应用 ID、密钥和服务端网络。" });
      throw serviceError("凭据验证失败，请检查应用 ID、密钥和服务端网络。", 502, "MIA_IM_CHANNEL_TEST_FAILED");
    }
  }

  async function idle() {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  return {
    listProviders,
    listChannels: (userId, limit) => store.listChannelsForUser(userId, limit).map(publicChannel),
    createChannel,
    updateChannel,
    deleteChannel,
    testChannel,
    receiveFeishuCallback,
    receiveWechatCallback,
    deliverBotReply,
    idle,
    publicChannel
  };
}

module.exports = { createImChannelService };
