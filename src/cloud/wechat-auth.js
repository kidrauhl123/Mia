"use strict";

const crypto = require("node:crypto");

const WECHAT_MP_ACCESS_TOKEN_URL = "https://api.weixin.qq.com/cgi-bin/token";
const WECHAT_MP_QRCODE_CREATE_URL = "https://api.weixin.qq.com/cgi-bin/qrcode/create";
const WECHAT_MP_QRCODE_SHOW_URL = "https://mp.weixin.qq.com/cgi-bin/showqrcode";
const WECHAT_MP_USER_INFO_URL = "https://api.weixin.qq.com/cgi-bin/user/info";
const DEFAULT_TTL_MS = 1000 * 60 * 5;

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function randomState(randomBytes = crypto.randomBytes) {
  return `wx_${base64url(randomBytes(24))}`;
}

function trim(value) {
  return String(value || "").trim();
}

function wechatMpConfig(context = {}) {
  return {
    appId: trim(context.wechatMpAppId || process.env.MIA_WECHAT_MP_APP_ID),
    appSecret: trim(context.wechatMpAppSecret || process.env.MIA_WECHAT_MP_APP_SECRET),
    token: trim(context.wechatMpToken || process.env.MIA_WECHAT_MP_TOKEN)
  };
}

function isWechatMpLoginConfigured(config = {}) {
  return Boolean(trim(config.appId) && trim(config.appSecret) && trim(config.token));
}

function wechatMpSignature({ token, timestamp, nonce } = {}) {
  return crypto
    .createHash("sha1")
    .update([trim(token), trim(timestamp), trim(nonce)].sort().join(""))
    .digest("hex");
}

function verifyWechatMpSignature(input = {}) {
  const token = trim(input.token);
  const signature = trim(input.signature);
  const timestamp = trim(input.timestamp);
  const nonce = trim(input.nonce);
  if (!token || !signature || !timestamp || !nonce) return false;
  return wechatMpSignature({ token, timestamp, nonce }) === signature;
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { method: "GET" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.errmsg || data.error || `WeChat HTTP ${response.status}`);
  if (data && data.errcode) throw new Error(data.errmsg || `WeChat error ${data.errcode}`);
  return data;
}

async function postJson(fetchImpl, url, body = {}) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.errmsg || data.error || `WeChat HTTP ${response.status}`);
  if (data && data.errcode) throw new Error(data.errmsg || `WeChat error ${data.errcode}`);
  return data;
}

async function fetchWechatMpUserInfo({ fetchImpl = fetch, accessToken, openid } = {}) {
  const url = new URL(WECHAT_MP_USER_INFO_URL);
  url.searchParams.set("access_token", trim(accessToken));
  url.searchParams.set("openid", trim(openid));
  url.searchParams.set("lang", "zh_CN");
  return fetchJson(fetchImpl, url);
}

function normalizeWechatMpProfile(event = {}, userInfo = {}) {
  const openid = trim(userInfo.openid || event.FromUserName || event.openid);
  if (!openid) throw new Error("微信关注事件缺少 openid。");
  return {
    openid,
    unionid: trim(userInfo.unionid),
    nickname: trim(userInfo.nickname) || "微信用户",
    avatarUrl: trim(userInfo.headimgurl),
    city: trim(userInfo.city),
    province: trim(userInfo.province),
    country: trim(userInfo.country),
    raw: { mpEvent: event, mpUser: userInfo || {} }
  };
}

function xmlDecode(value = "") {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlTag(xml = "", tag = "") {
  const safeTag = String(tag || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(xml || "").match(new RegExp(`<${safeTag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${safeTag}>`, "i"));
  if (!match) return "";
  return trim(xmlDecode(match[1] !== undefined ? match[1] : match[2]));
}

function parseWechatMpEventXml(xml = "") {
  return {
    ToUserName: xmlTag(xml, "ToUserName"),
    FromUserName: xmlTag(xml, "FromUserName"),
    CreateTime: xmlTag(xml, "CreateTime"),
    MsgType: xmlTag(xml, "MsgType"),
    Event: xmlTag(xml, "Event"),
    EventKey: xmlTag(xml, "EventKey"),
    Ticket: xmlTag(xml, "Ticket")
  };
}

function sceneFromWechatMpEvent(event = {}) {
  const eventName = trim(event.Event);
  const eventKey = trim(event.EventKey);
  if (eventName === "subscribe" && eventKey.startsWith("qrscene_")) return eventKey.slice("qrscene_".length);
  if (eventName === "SCAN") return eventKey;
  return "";
}

function isWechatApiUnauthorized(error) {
  return /\b48001\b|api unauthorized/i.test(String(error?.message || error || ""));
}

function wechatMpSceneQrUnavailableError(cause = "") {
  const error = new Error(
    `微信公众号没有生成带参数二维码接口权限，不能实现扫码关注即登录。请在微信公众平台「接口管理」启用「生成带参数二维码」后重试。${cause ? ` 微信返回：${cause}` : ""}`
  );
  error.code = "MIA_WECHAT_MP_SCENE_QR_UNAVAILABLE";
  error.status = 503;
  return error;
}

function createWechatAuthFlow({
  ttlMs = DEFAULT_TTL_MS,
  randomBytes = crypto.randomBytes,
  now = () => Date.now(),
  fetchImpl = fetch,
  cloudStore,
  onLogin = () => {}
} = {}) {
  const states = new Map();
  let mpAccessToken = null;

  function purge() {
    const time = now();
    for (const [state, record] of states.entries()) {
      if (record.expiresAt <= time) states.delete(state);
    }
  }

  function publicRecord(record = null) {
    if (!record) return null;
    return {
      state: record.state,
      status: record.status,
      expiresAt: new Date(record.expiresAt).toISOString(),
      qrCodeUrl: record.qrCodeUrl || "",
      mode: record.mode || "mp_scene"
    };
  }

  async function mpApiAccessToken(config = {}) {
    const nowMs = now();
    const appId = trim(config.appId);
    if (mpAccessToken?.token && mpAccessToken.appId === appId && mpAccessToken.expiresAt > nowMs + 60_000) {
      return mpAccessToken.token;
    }
    if (!isWechatMpLoginConfigured(config)) throw new Error("微信公众号登录未配置。");
    const url = new URL(WECHAT_MP_ACCESS_TOKEN_URL);
    url.searchParams.set("grant_type", "client_credential");
    url.searchParams.set("appid", appId);
    url.searchParams.set("secret", trim(config.appSecret));
    const data = await fetchJson(fetchImpl, url);
    const token = trim(data.access_token);
    if (!token) throw new Error("微信未返回公众号 access_token。");
    const expiresIn = Math.max(60, Number(data.expires_in || 7200));
    mpAccessToken = { appId, token, expiresAt: nowMs + (expiresIn * 1000) };
    return token;
  }

  async function startMp(config = {}, options = {}) {
    purge();
    if (!isWechatMpLoginConfigured(config)) throw new Error("微信公众号登录未配置。");
    const state = randomState(randomBytes);
    const expiresAt = now() + ttlMs;
    const publicUrl = trim(options.publicUrl).replace(/\/+$/, "");
    const client = trim(options.client);
    const qrPageUrl = publicUrl ? `${publicUrl}/api/auth/wechat/mp/qr?state=${encodeURIComponent(state)}` : "";
    if (!publicUrl) throw new Error("微信公众号登录需要配置 MIA_CLOUD_PUBLIC_URL。");

    try {
      const token = await mpApiAccessToken(config);
      const qr = await postJson(fetchImpl, `${WECHAT_MP_QRCODE_CREATE_URL}?access_token=${encodeURIComponent(token)}`, {
        expire_seconds: Math.max(60, Math.ceil(ttlMs / 1000)),
        action_name: "QR_STR_SCENE",
        action_info: { scene: { scene_str: state } }
      });
      const ticket = trim(qr.ticket);
      if (!ticket) throw new Error("微信未返回公众号二维码 ticket。");
      const qrCodeUrl = `${WECHAT_MP_QRCODE_SHOW_URL}?ticket=${encodeURIComponent(ticket)}`;
      const authorizationUrl = qrPageUrl || qrCodeUrl;
      states.set(state, {
        state,
        status: "pending",
        mode: "mp_scene",
        expiresAt,
        createdAt: now(),
        qrCodeUrl,
        ticket,
        client
      });
      return {
        mode: "wechat_mp_scene",
        state,
        expiresAt: new Date(expiresAt).toISOString(),
        authorizationUrl,
        qrCodeUrl
      };
    } catch (error) {
      if (isWechatApiUnauthorized(error)) throw wechatMpSceneQrUnavailableError(error.message || String(error));
      throw error;
    }
  }

  function recordFor(state) {
    purge();
    const record = states.get(trim(state));
    if (!record) throw new Error("微信登录请求已过期，请重新发起。");
    return record;
  }

  function peek(state) {
    purge();
    return publicRecord(states.get(trim(state)) || null);
  }

  function complete(state) {
    const record = recordFor(state);
    if (record.status === "complete") {
      states.delete(record.state);
      return { status: "complete", ...record.account };
    }
    if (record.status === "failed") {
      states.delete(record.state);
      return { status: "failed", error: record.error || "微信登录失败。" };
    }
    return { status: "pending", expiresAt: new Date(record.expiresAt).toISOString() };
  }

  async function mpUserInfoForEvent(event = {}, config = {}) {
    if (!isWechatMpLoginConfigured(config)) return {};
    try {
      const token = await mpApiAccessToken(config);
      return await fetchWechatMpUserInfo({ fetchImpl, accessToken: token, openid: event.FromUserName });
    } catch {
      return {};
    }
  }

  async function completeMpRecord(record, event = {}, config = {}) {
    if (!record) return { status: "ignored", reason: "unknown_login" };
    if (record.status !== "pending") return { status: record.status };
    try {
      const userInfo = await mpUserInfoForEvent(event, config);
      const profile = normalizeWechatMpProfile(event, userInfo);
      const account = cloudStore.loginWithWechat(profile);
      record.status = "complete";
      record.account = account;
      record.profile = profile;
      onLogin(account);
      return { status: "complete", account, event };
    } catch (error) {
      record.status = "failed";
      record.error = error?.message || String(error);
      return { status: "failed", error: record.error, event };
    }
  }

  async function handleMpEventXml(xml = "", options = {}) {
    purge();
    const event = parseWechatMpEventXml(xml);
    const config = options.config || {};
    if (event.MsgType !== "event") return { status: "ignored", reason: "not_event", event };
    const scene = sceneFromWechatMpEvent(event);
    if (!scene) {
      return event.Event === "subscribe"
        ? { status: "not_login_scene", event }
        : { status: "ignored", reason: "not_login_scene", event };
    }
    const record = states.get(scene);
    if (!record) return { status: "unknown_scene", event };
    return completeMpRecord(record, event, config);
  }

  return { startMp, complete, handleMpEventXml, peek, purge };
}

module.exports = {
  WECHAT_MP_ACCESS_TOKEN_URL,
  WECHAT_MP_QRCODE_CREATE_URL,
  WECHAT_MP_QRCODE_SHOW_URL,
  WECHAT_MP_USER_INFO_URL,
  createWechatAuthFlow,
  fetchWechatMpUserInfo,
  isWechatMpLoginConfigured,
  normalizeWechatMpProfile,
  parseWechatMpEventXml,
  randomState,
  sceneFromWechatMpEvent,
  verifyWechatMpSignature,
  wechatMpConfig,
  wechatMpSignature
};
