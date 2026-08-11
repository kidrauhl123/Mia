"use strict";

const crypto = require("node:crypto");

const WECHAT_API_BASE = "https://ilinkai.weixin.qq.com";
const WECHAT_APP_ID = "bot";
const WECHAT_CLIENT_VERSION = "132102";
const QR_LOGIN_TTL_MS = 5 * 60 * 1000;
const QR_POLL_TIMEOUT_MS = 45 * 1000;
const GET_UPDATES_TIMEOUT_MS = 50 * 1000;
const SEND_TIMEOUT_MS = 20 * 1000;
const NOTIFY_TIMEOUT_MS = 8 * 1000;
const SHUTDOWN_TIMEOUT_MS = 3 * 1000;
const MAX_CONVERSATION_SESSIONS = 50;
const MAX_COMMAND_RECEIPTS = 128;

function serviceError(message, status = 400, code = "MIA_WECHAT_CLAWBOT_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function trim(value) {
  return String(value || "").trim();
}

function safeText(value, max = 12000) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function normalizedUserId(value) {
  const userId = trim(value);
  return userId && userId.length <= 512 && !/[\u0000-\u001f\u007f]/.test(userId) ? userId : "";
}

function validBaseUrl(value) {
  try {
    const url = new URL(trim(value));
    return url.protocol === "https:" && /(^|\.)weixin\.qq\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function apiUrl(baseUrl, route) {
  if (!validBaseUrl(baseUrl)) throw serviceError("微信连接地址无效。", 502, "MIA_WECHAT_CLAWBOT_BASE_URL_INVALID");
  return new URL(String(route || "").replace(/^\/+/, ""), `${trim(baseUrl).replace(/\/+$/, "")}/`);
}

function safeRedirectHost(value) {
  const host = trim(value).toLowerCase();
  return /^[a-z0-9.-]+$/.test(host) && /(^|\.)weixin\.qq\.com$/.test(host) ? host : "";
}

function valueString(value, key) {
  const raw = value && typeof value === "object" ? value[key] : "";
  return typeof raw === "string" ? trim(raw) : "";
}

function valueNumber(value, key) {
  const raw = value && typeof value === "object" ? value[key] : undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function eventId(message = {}) {
  for (const key of ["message_id", "client_id", "seq"]) {
    const raw = message?.[key];
    if (typeof raw === "string" || Number.isFinite(raw)) {
      return `wx_${crypto.createHash("sha256").update(String(raw)).digest("hex")}`;
    }
  }
  return `wx_${crypto.createHash("sha256").update(JSON.stringify(message || {})).digest("hex")}`;
}

function textItem(message = {}) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  for (const item of items) {
    if (Number(item?.type) !== 1) continue;
    const text = safeText(item?.text_item?.text);
    if (text) return text;
  }
  return "";
}

function randomWechatUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64");
}

function wechatHeaders(token = "") {
  const headers = {
    "Content-Type": "application/json",
    authorizationtype: "ilink_bot_token",
    "ilink-app-id": WECHAT_APP_ID,
    "ilink-app-clientversion": WECHAT_CLIENT_VERSION,
    "x-wechat-uin": randomWechatUin()
  };
  if (trim(token)) headers.Authorization = `Bearer ${trim(token)}`;
  return headers;
}

function wechatBaseInfo() {
  return { channel_version: "mia-cloud", bot_agent: "Mia/0.1" };
}

function sessionIsUsable(session = {}, channelId = "") {
  return Number(session.version) === 1
    && trim(session.channelId) === trim(channelId)
    && trim(session.accountId)
    && normalizedUserId(session.ownerUserId)
    && trim(session.token)
    && validBaseUrl(session.baseUrl);
}

function cloneJson(value, fallback = {}) {
  try {
    return JSON.parse(JSON.stringify(value == null ? fallback : value));
  } catch {
    return fallback;
  }
}

function commandForText(text) {
  const source = trim(text);
  if (source.toLowerCase() === "/new") return { type: "new" };
  if (source.toLowerCase() === "/sessions") return { type: "list" };
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts[0]?.toLowerCase() !== "/resume") return null;
  if (parts.length === 1) return { type: "list" };
  if (parts.length !== 2 || !/^\d+$/.test(parts[1]) || Number(parts[1]) <= 0) return { type: "invalid" };
  return { type: "resume", number: Number(parts[1]) };
}

function conversationTitle(text) {
  return safeText(text, 36).replace(/\s+/g, " ");
}

function sessionListText(session = {}) {
  const conversations = Array.isArray(session.conversationSessions) ? [...session.conversationSessions] : [];
  if (!conversations.length) return "暂无可恢复的会话。发送 /new 新建对话。";
  conversations.sort((left, right) => (
    Number(right.lastActiveAt || 0) - Number(left.lastActiveAt || 0)
      || Number(right.number || 0) - Number(left.number || 0)
  ));
  const lines = ["最近会话："];
  for (const conversation of conversations.slice(0, 10)) {
    const current = conversation.id === session.activeConversationSessionId ? "（当前）" : "";
    lines.push(`#${conversation.number}${current} · ${trim(conversation.title) || "未命名"}`);
  }
  lines.push("发送 /resume 编号 切换；/new 新建。");
  return lines.join("\n");
}

function createConversationSession(session, now) {
  const conversations = Array.isArray(session.conversationSessions) ? session.conversationSessions : [];
  const number = conversations.reduce((max, item) => Math.max(max, Number(item?.number) || 0), 0) + 1;
  const conversation = {
    id: `session_${crypto.randomUUID().replace(/-/g, "")}`,
    number,
    externalChatId: `wx_session_${crypto.randomUUID().replace(/-/g, "")}`,
    conversationId: "",
    title: "",
    replyContext: null,
    createdAt: now,
    lastActiveAt: now
  };
  conversations.push(conversation);
  session.conversationSessions = conversations;
  session.activeConversationSessionId = conversation.id;
  trimConversationSessions(session);
  return conversation;
}

function trimConversationSessions(session) {
  const conversations = Array.isArray(session.conversationSessions) ? session.conversationSessions : [];
  while (conversations.length > MAX_CONVERSATION_SESSIONS) {
    let target = -1;
    for (let index = 0; index < conversations.length; index += 1) {
      if (conversations[index].id === session.activeConversationSessionId) continue;
      if (target < 0 || Number(conversations[index].lastActiveAt || 0) < Number(conversations[target].lastActiveAt || 0)) {
        target = index;
      }
    }
    if (target < 0) break;
    conversations.splice(target, 1);
  }
}

function activeConversationSession(session, now) {
  const conversations = Array.isArray(session.conversationSessions) ? session.conversationSessions : [];
  let conversation = conversations.find((item) => item?.id === session.activeConversationSessionId) || null;
  if (!conversation) {
    conversation = conversations
      .filter((item) => trim(item?.externalChatId))
      .sort((left, right) => Number(right.lastActiveAt || 0) - Number(left.lastActiveAt || 0))[0] || null;
  }
  if (!conversation) conversation = createConversationSession(session, now);
  session.activeConversationSessionId = conversation.id;
  conversation.lastActiveAt = now;
  return conversation;
}

function rememberCommandReceipt(session, receipt) {
  const receipts = Array.isArray(session.commandReceipts) ? session.commandReceipts : [];
  receipts.push(receipt);
  if (receipts.length > MAX_COMMAND_RECEIPTS) receipts.splice(0, receipts.length - MAX_COMMAND_RECEIPTS);
  session.commandReceipts = receipts;
}

function commandReceipt(session, incomingEventId) {
  const receipts = Array.isArray(session.commandReceipts) ? session.commandReceipts : [];
  return receipts.find((item) => item?.eventId === incomingEventId) || null;
}

function applyCommand(session, command, now) {
  if (command.type === "new") {
    const conversation = createConversationSession(session, now);
    return `已新建会话 #${conversation.number}。发送下一条消息开始新对话。`;
  }
  if (command.type === "list") return sessionListText(session);
  if (command.type === "resume") {
    const conversation = (session.conversationSessions || []).find((item) => Number(item?.number) === command.number);
    if (!conversation) return `未找到会话 #${command.number}。\n${sessionListText(session)}`;
    conversation.lastActiveAt = now;
    session.activeConversationSessionId = conversation.id;
    return `已切换到会话 #${command.number}。`;
  }
  return "用法：/resume 查看会话，或 /resume 编号 切换会话。";
}

function timeoutError() {
  const error = new Error("WeChat request timed out");
  error.code = "MIA_WECHAT_CLAWBOT_TIMEOUT";
  return error;
}

async function requestJson(fetchImpl, url, { method = "GET", body, token = "", timeoutMs, signal } = {}) {
  const controller = new AbortController();
  let timer = null;
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  if (timeoutMs > 0) timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: wechatHeaders(token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });
    if (!response?.ok) throw serviceError("微信服务暂时不可用。", 502, "MIA_WECHAT_CLAWBOT_PROVIDER_HTTP");
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") {
      throw serviceError("微信服务返回了无效数据。", 502, "MIA_WECHAT_CLAWBOT_PROVIDER_INVALID");
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw timeoutError();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", done);
      resolve();
    }
    signal?.addEventListener?.("abort", done, { once: true });
  });
}

function createWechatClawbotCloudService({
  store,
  secretBox,
  fetchImpl = fetch,
  isCloudChannel = () => false,
  receiveInbound = () => ({ accepted: false }),
  now = () => Date.now(),
  pollIntervalMs = 1000,
  retryDelayMs = 2000,
  retrySlowDelayMs = 20000
} = {}) {
  if (!store || !secretBox) throw new Error("createWechatClawbotCloudService requires an IM store and secret box");

  const runtimes = new Map();
  let stopped = false;
  let shutdownPromise = null;

  function runtimeFor(channelId) {
    const id = trim(channelId);
    let runtime = runtimes.get(id);
    if (!runtime) {
      runtime = {
        state: "disconnected",
        message: "",
        linked: false,
        qrUrl: "",
        activeLogin: null,
        monitorAbort: null,
        monitorPromise: null,
        loginAbort: null,
        loginPromise: null
      };
      runtimes.set(id, runtime);
    }
    return runtime;
  }

  function assertCloudChannel(channel) {
    if (!channel || channel.provider !== "wechat_clawbot") {
      throw serviceError("微信通道不存在。", 404, "MIA_WECHAT_CLAWBOT_CHANNEL_NOT_FOUND");
    }
    if (!isCloudChannel(channel)) {
      throw serviceError("这个 Bot 使用本机运行时，请在已连接的设备上管理微信。", 409, "MIA_WECHAT_CLAWBOT_LOCAL_RUNTIME");
    }
    return channel;
  }

  function sessionFromChannel(channel) {
    if (channel?.provider !== "wechat_clawbot") return null;
    const ciphertext = trim(channel?.secretsCiphertext);
    if (!ciphertext) return null;
    try {
      const data = secretBox.decryptJson(ciphertext);
      const session = data?.provider === "wechat_clawbot" ? data.session : null;
      return sessionIsUsable(session, channel.id) ? cloneJson(session) : null;
    } catch {
      return null;
    }
  }

  function saveSession(channel, session) {
    if (!sessionIsUsable(session, channel.id)) {
      throw serviceError("微信授权数据无效。", 502, "MIA_WECHAT_CLAWBOT_SESSION_INVALID");
    }
    const ciphertext = secretBox.encryptJson({ provider: "wechat_clawbot", version: 1, session });
    const stored = store.updateChannelSecrets(channel.id, ciphertext);
    if (!stored) throw serviceError("微信授权无法保存。", 503, "MIA_WECHAT_CLAWBOT_SESSION_SAVE_FAILED");
    return stored;
  }

  function clearSession(channelId) {
    store.updateChannelSecrets(channelId, "");
  }

  function setRuntime(channel, next = {}) {
    const runtime = runtimeFor(channel.id);
    Object.assign(runtime, next);
    return runtime;
  }

  function publicStatus(channel, runtime = null) {
    const current = runtime || runtimes.get(channel.id);
    if (current) {
      return {
        channelId: channel.id,
        state: current.state || "disconnected",
        message: current.message || "",
        linked: current.linked === true,
        qrUrl: current.qrUrl || ""
      };
    }
    const session = sessionFromChannel(channel);
    if (session) {
      return {
        channelId: channel.id,
        state: "linked",
        message: "",
        linked: true,
        qrUrl: ""
      };
    }
    return {
      channelId: channel.id,
      state: "disconnected",
      message: "",
      linked: false,
      qrUrl: ""
    };
  }

  function currentChannel(channelId) {
    return store.getChannel(channelId, { includeSecrets: true });
  }

  async function notify(session, route, signal) {
    const value = await requestJson(fetchImpl, apiUrl(session.baseUrl, route), {
      method: "POST",
      body: { base_info: wechatBaseInfo() },
      token: session.token,
      timeoutMs: NOTIFY_TIMEOUT_MS,
      signal
    });
    if (valueNumber(value, "ret") !== 0) {
      throw serviceError("微信连接状态同步失败。", 502, "MIA_WECHAT_CLAWBOT_NOTIFY_FAILED");
    }
  }

  async function requestQr(channel) {
    const session = sessionFromChannel(channel);
    const value = await requestJson(fetchImpl, apiUrl(WECHAT_API_BASE, "ilink/bot/get_bot_qrcode?bot_type=3"), {
      method: "POST",
      body: { local_token_list: session?.token ? [session.token] : [] },
      timeoutMs: SEND_TIMEOUT_MS
    });
    const qrcode = valueString(value, "qrcode");
    const qrUrl = valueString(value, "qrcode_img_content");
    if (!qrcode || !qrUrl) {
      throw serviceError("微信二维码暂时不可用。", 502, "MIA_WECHAT_CLAWBOT_QR_UNAVAILABLE");
    }
    return { qrcode, qrUrl };
  }

  function startLoginPolling(channel, runtime) {
    if (runtime.loginPromise || !runtime.activeLogin) return;
    const controller = new AbortController();
    runtime.loginAbort = controller;
    runtime.loginPromise = pollLogin(channel.id, runtime, controller.signal)
      .catch(() => {})
      .finally(() => {
        if (runtime.loginAbort === controller) runtime.loginAbort = null;
        runtime.loginPromise = null;
      });
  }

  async function refreshQr(channel, runtime) {
    const qr = await requestQr(channel);
    runtime.activeLogin = {
      qrcode: qr.qrcode,
      apiBaseUrl: WECHAT_API_BASE,
      startedAt: now(),
      pairingCode: ""
    };
    setRuntime(channel, {
      state: "waiting_for_scan",
      message: "",
      linked: false,
      qrUrl: qr.qrUrl,
      activeLogin: runtime.activeLogin
    });
    return runtime.activeLogin;
  }

  async function pollLogin(channelId, runtime, signal) {
    while (!signal.aborted && !stopped) {
      const channel = currentChannel(channelId);
      if (!channel || !channel.enabled || !isCloudChannel(channel)) return;
      const login = runtime.activeLogin;
      if (!login) return;
      if (now() - Number(login.startedAt || 0) > QR_LOGIN_TTL_MS) {
        try {
          await refreshQr(channel, runtime);
        } catch {
          setRuntime(channel, { state: "disconnected", message: "", linked: false, qrUrl: "", activeLogin: null });
          return;
        }
        continue;
      }
      try {
        const url = apiUrl(login.apiBaseUrl, "ilink/bot/get_qrcode_status");
        url.searchParams.set("qrcode", login.qrcode);
        if (trim(login.pairingCode)) url.searchParams.set("verify_code", login.pairingCode);
        const value = await requestJson(fetchImpl, url, { timeoutMs: QR_POLL_TIMEOUT_MS, signal });
        const status = valueString(value, "status") || "wait";
        if (status === "wait") {
          await wait(pollIntervalMs, signal);
          continue;
        }
        if (status === "scaned") {
          setRuntime(channel, { state: "scanned", message: "", linked: false, qrUrl: runtime.qrUrl });
        } else if (status === "need_verifycode") {
          setRuntime(channel, { state: "pairing_code_required", message: "", linked: false, qrUrl: runtime.qrUrl });
        } else if (status === "scaned_but_redirect") {
          const host = safeRedirectHost(valueString(value, "redirect_host"));
          if (host) runtime.activeLogin = { ...login, apiBaseUrl: `https://${host}` };
        } else if (status === "expired" || status === "verify_code_blocked") {
          await refreshQr(channel, runtime);
        } else if (status === "binded_redirect") {
          const session = sessionFromChannel(channel);
          if (!session) {
            setRuntime(channel, { state: "reauth_required", message: "", linked: false, qrUrl: "", activeLogin: null });
            return;
          }
          setRuntime(channel, { state: "linked", message: "", linked: true, qrUrl: "", activeLogin: null });
          ensureMonitor(channel, session);
          return;
        } else if (status === "confirmed") {
          const token = valueString(value, "bot_token");
          const accountId = valueString(value, "ilink_bot_id");
          const ownerUserId = normalizedUserId(valueString(value, "ilink_user_id"));
          const baseUrl = validBaseUrl(valueString(value, "baseurl")) ? valueString(value, "baseurl") : WECHAT_API_BASE;
          if (!token || !accountId || !ownerUserId) {
            setRuntime(channel, { state: "reauth_required", message: "", linked: false, qrUrl: "", activeLogin: null });
            return;
          }
          const session = {
            version: 1,
            channelId: channel.id,
            accountId,
            ownerUserId,
            baseUrl,
            token,
            syncCursor: "",
            conversationSessions: [],
            activeConversationSessionId: "",
            commandReceipts: []
          };
          saveSession(channel, session);
          setRuntime(channel, { state: "linked", message: "", linked: true, qrUrl: "", activeLogin: null });
          ensureMonitor(channel, session);
          return;
        } else {
          setRuntime(channel, { state: "reauth_required", message: "", linked: false, qrUrl: "", activeLogin: null });
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
      }
      await wait(pollIntervalMs, signal);
    }
  }

  function ensureMonitor(channel, session) {
    const runtime = runtimeFor(channel.id);
    if (runtime.monitorPromise || !sessionIsUsable(session, channel.id) || stopped) return;
    const controller = new AbortController();
    runtime.monitorAbort = controller;
    setRuntime(channel, { state: "linked", message: "", linked: true, qrUrl: "", activeLogin: null });
    runtime.monitorPromise = monitorChannel(channel.id, runtime, controller.signal)
      .catch(() => {})
      .finally(() => {
        if (runtime.monitorAbort !== controller) return;
        runtime.monitorAbort = null;
        runtime.monitorPromise = null;
        const latest = currentChannel(channel.id);
        const latestSession = sessionFromChannel(latest);
        if (!stopped && latest?.enabled && isCloudChannel(latest) && latestSession) {
          ensureMonitor(latest, latestSession);
        }
      });
  }

  function markReauthRequired(channel, runtime) {
    clearSession(channel.id);
    setRuntime(channel, { state: "reauth_required", message: "", linked: false, qrUrl: "", activeLogin: null });
    store.recordChannelStatus(channel.id, { lastError: "需要重新连接微信。" });
  }

  function encryptedRecipient(channel, context) {
    return {
      transport: "cloud-wechat-clawbot",
      ciphertext: secretBox.encryptJson({
        channelId: channel.id,
        toUserId: context.toUserId,
        contextToken: context.contextToken
      })
    };
  }

  function recipientForConversation(channel, conversationId) {
    const session = sessionFromChannel(channel);
    const conversation = (session?.conversationSessions || []).find((item) => (
      trim(item?.conversationId) === trim(conversationId)
        && trim(item?.replyContext?.toUserId)
        && trim(item?.replyContext?.contextToken)
    ));
    return conversation ? encryptedRecipient(channel, conversation.replyContext) : null;
  }

  async function sendText(channel, session, recipient, text, clientId) {
    const value = await requestJson(fetchImpl, apiUrl(session.baseUrl, "ilink/bot/sendmessage"), {
      method: "POST",
      token: session.token,
      timeoutMs: SEND_TIMEOUT_MS,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: recipient.toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          context_token: recipient.contextToken
        },
        base_info: wechatBaseInfo()
      }
    });
    if (valueNumber(value, "ret") !== 0) {
      throw serviceError("微信回复投递失败。", 502, "MIA_WECHAT_CLAWBOT_SEND_FAILED");
    }
  }

  async function receiveMessage(channel, session, message) {
    if (Number(message?.message_type || 1) !== 1 || trim(message?.group_id)) return true;
    const senderId = normalizedUserId(valueString(message, "from_user_id"));
    const contextToken = trim(valueString(message, "context_token"));
    const text = textItem(message);
    if (!senderId || !contextToken || !text || senderId !== session.ownerUserId) return true;
    const incomingEventId = eventId(message);
    const context = { toUserId: senderId, contextToken };
    const command = commandForText(text);
    if (command) {
      let receipt = commandReceipt(session, incomingEventId);
      if (!receipt) {
        receipt = {
          eventId: incomingEventId,
          replyId: `mcmd_${crypto.randomUUID().replace(/-/g, "")}`,
          replyText: applyCommand(session, command, now())
        };
        rememberCommandReceipt(session, receipt);
        saveSession(channel, session);
      }
      await sendText(channel, session, context, receipt.replyText, receipt.replyId);
      return true;
    }
    const conversation = activeConversationSession(session, now());
    conversation.replyContext = context;
    if (!trim(conversation.title)) conversation.title = conversationTitle(text);
    const result = receiveInbound(channel, {
      eventId: incomingEventId,
      senderId,
      senderLabel: senderId,
      externalChatId: conversation.externalChatId,
      chatType: "p2p",
      text,
      recipient: encryptedRecipient(channel, context)
    });
    if (result?.conversationId) conversation.conversationId = result.conversationId;
    saveSession(channel, session);
    return result?.accepted !== false;
  }

  async function monitorChannel(channelId, runtime, signal) {
    let failures = 0;
    let didNotifyStart = false;
    while (!signal.aborted && !stopped) {
      const channel = currentChannel(channelId);
      if (!channel || !channel.enabled || !isCloudChannel(channel)) return;
      const session = sessionFromChannel(channel);
      if (!session) {
        setRuntime(channel, { state: "reauth_required", message: "", linked: false, qrUrl: "" });
        return;
      }
      if (!didNotifyStart) {
        didNotifyStart = true;
        await notify(session, "ilink/bot/msg/notifystart", signal).catch(() => {});
      }
      let value;
      try {
        value = await requestJson(fetchImpl, apiUrl(session.baseUrl, "ilink/bot/getupdates"), {
          method: "POST",
          token: session.token,
          timeoutMs: GET_UPDATES_TIMEOUT_MS,
          signal,
          body: { get_updates_buf: session.syncCursor || "", base_info: wechatBaseInfo() }
        });
      } catch {
        if (signal.aborted) return;
        failures += 1;
        setRuntime(channel, { state: "reconnecting", message: "", linked: true, qrUrl: "" });
        await wait(failures >= 3 ? retrySlowDelayMs : retryDelayMs, signal);
        if (failures >= 3) failures = 0;
        continue;
      }
      const ret = valueNumber(value, "ret");
      const errcode = valueNumber(value, "errcode");
      if (ret === -14 || errcode === -14) {
        markReauthRequired(channel, runtime);
        return;
      }
      if (ret !== 0 || errcode !== 0) {
        failures += 1;
        setRuntime(channel, { state: "reconnecting", message: "", linked: true, qrUrl: "" });
        await wait(failures >= 3 ? retrySlowDelayMs : retryDelayMs, signal);
        if (failures >= 3) failures = 0;
        continue;
      }
      failures = 0;
      let accepted = true;
      for (const message of Array.isArray(value.msgs) ? value.msgs : []) {
        try {
          if (!await receiveMessage(channel, session, message)) accepted = false;
        } catch {
          accepted = false;
        }
        if (!accepted) break;
      }
      if (!accepted) {
        await wait(retryDelayMs, signal);
        continue;
      }
      const cursor = valueString(value, "get_updates_buf");
      if (cursor && cursor !== session.syncCursor) {
        session.syncCursor = cursor;
        saveSession(channel, session);
      }
      store.recordChannelStatus(channel.id, { lastError: "", lastEventAt: new Date(now()).toISOString() });
      setRuntime(channel, { state: "linked", message: "", linked: true, qrUrl: "" });
    }
  }

  function channelForUser(userId, channelId) {
    const channel = store.getChannelForUser(userId, channelId, { includeSecrets: true });
    return assertCloudChannel(channel);
  }

  function status(userId, channelId) {
    const channel = channelForUser(userId, channelId);
    const session = sessionFromChannel(channel);
    if (session) ensureMonitor(channel, session);
    return publicStatus(channel);
  }

  async function startLink(userId, channelId) {
    const channel = channelForUser(userId, channelId);
    if (!channel.enabled) throw serviceError("请先启用微信通道。", 400, "MIA_WECHAT_CLAWBOT_DISABLED");
    if (!secretBox.available) throw serviceError("云端尚未配置微信授权加密，暂时不能连接。", 503, "MIA_WECHAT_CLAWBOT_ENCRYPTION_REQUIRED");
    const existing = sessionFromChannel(channel);
    if (existing) {
      ensureMonitor(channel, existing);
      return publicStatus(channel);
    }
    const runtime = runtimeFor(channel.id);
    if (!runtime.activeLogin) await refreshQr(channel, runtime);
    startLoginPolling(channel, runtime);
    return publicStatus(channel, runtime);
  }

  function submitPairingCode(userId, channelId, input = {}) {
    const channel = channelForUser(userId, channelId);
    const code = trim(input?.code);
    if (!/^\d{1,32}$/.test(code)) throw serviceError("配对码无效。", 400, "MIA_WECHAT_CLAWBOT_PAIRING_CODE_INVALID");
    const runtime = runtimeFor(channel.id);
    if (!runtime.activeLogin) throw serviceError("当前没有进行中的微信连接。", 409, "MIA_WECHAT_CLAWBOT_LOGIN_MISSING");
    runtime.activeLogin = { ...runtime.activeLogin, pairingCode: code };
    setRuntime(channel, { state: "verifying", message: "", linked: false, qrUrl: runtime.qrUrl, activeLogin: runtime.activeLogin });
    return publicStatus(channel, runtime);
  }

  async function stopRuntime(channel, { notifyStop = false, clear = false } = {}) {
    const runtime = runtimes.get(channel.id);
    runtime?.loginAbort?.abort();
    runtime?.monitorAbort?.abort();
    const session = sessionFromChannel(channel);
    if (clear) clearSession(channel.id);
    if (runtime) {
      setRuntime(channel, {
        state: clear ? "disconnected" : "paused",
        message: "",
        linked: false,
        qrUrl: "",
        activeLogin: null
      });
    }
    if (notifyStop && session) {
      await Promise.race([
        notify(session, "ilink/bot/msg/notifystop").catch(() => {}),
        wait(SHUTDOWN_TIMEOUT_MS)
      ]);
    }
  }

  async function disconnect(userId, channelId) {
    const channel = channelForUser(userId, channelId);
    await stopRuntime(channel, { notifyStop: true, clear: true });
    store.recordChannelStatus(channel.id, { lastError: "" });
    return publicStatus(channel, runtimeFor(channel.id));
  }

  async function sendReply(channel, delivery, text) {
    assertCloudChannel(channel);
    const session = sessionFromChannel(channel);
    if (!session) throw serviceError("微信尚未连接。", 409, "MIA_WECHAT_CLAWBOT_NOT_LINKED");
    const ciphertext = trim(delivery?.recipient?.ciphertext);
    if (!ciphertext) throw serviceError("微信回复上下文不可用。", 409, "MIA_WECHAT_CLAWBOT_CONTEXT_MISSING");
    let recipient = null;
    try { recipient = secretBox.decryptJson(ciphertext); } catch {}
    if (
      !recipient
      || trim(recipient.channelId) !== channel.id
      || !normalizedUserId(recipient.toUserId)
      || !trim(recipient.contextToken)
    ) {
      throw serviceError("微信回复上下文不可用。", 409, "MIA_WECHAT_CLAWBOT_CONTEXT_INVALID");
    }
    await sendText(channel, session, recipient, safeText(text, 1900) || "（Mia 未生成可发送的文本回复。）", trim(delivery.id));
    store.recordChannelStatus(channel.id, { lastError: "", lastEventAt: new Date(now()).toISOString() });
  }

  function conversationReplyRecipient(channel, conversationId) {
    assertCloudChannel(channel);
    return recipientForConversation(channel, conversationId);
  }

  function onChannelChanged(channel) {
    if (!channel || channel.provider !== "wechat_clawbot") return;
    const raw = currentChannel(channel.id) || channel;
    if (!raw.enabled || !isCloudChannel(raw)) {
      void stopRuntime(raw, { notifyStop: true });
      return;
    }
    const session = sessionFromChannel(raw);
    if (session) ensureMonitor(raw, session);
  }

  function onChannelDeleted(channel) {
    if (!channel || channel.provider !== "wechat_clawbot") return;
    void stopRuntime(channel, { notifyStop: true, clear: true });
  }

  function reconcile({ userId = "", botId = "" } = {}) {
    const ownerId = trim(userId);
    const targetBotId = trim(botId);
    const channels = store.listEnabledChannelsByProvider("wechat_clawbot", 500, { includeSecrets: true });
    for (const channel of channels) {
      if (ownerId && trim(channel.userId) !== ownerId) continue;
      if (targetBotId && trim(channel.botId) !== targetBotId) continue;
      if (!isCloudChannel(channel)) {
        if (runtimes.has(channel.id)) void stopRuntime(channel, { notifyStop: true });
        continue;
      }
      const session = sessionFromChannel(channel);
      if (session) ensureMonitor(channel, session);
    }
  }

  async function start() {
    stopped = false;
    reconcile();
  }

  function onRuntimeChanged(userId, botId) {
    reconcile({ userId, botId });
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopped = true;
    const channels = [...runtimes.keys()]
      .map((channelId) => currentChannel(channelId))
      .filter(Boolean);
    shutdownPromise = Promise.allSettled(
      channels.map((channel) => stopRuntime(channel, { notifyStop: true }))
    ).then(() => undefined);
    return shutdownPromise;
  }

  return {
    status,
    startLink,
    submitPairingCode,
    disconnect,
    sendReply,
    conversationReplyRecipient,
    onChannelChanged,
    onChannelDeleted,
    onRuntimeChanged,
    start,
    shutdown
  };
}

module.exports = { createWechatClawbotCloudService };
