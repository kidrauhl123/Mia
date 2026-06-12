"use strict";

const crypto = require("node:crypto");
const QRCode = require("qrcode");

const WECHAT_MP_OAUTH_AUTHORIZE_URL = "https://open.weixin.qq.com/connect/oauth2/authorize";
const WECHAT_MP_OAUTH_TOKEN_URL = "https://api.weixin.qq.com/sns/oauth2/access_token";
const WECHAT_MP_OAUTH_USER_INFO_URL = "https://api.weixin.qq.com/sns/userinfo";
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
  return Boolean(trim(config.appId) && trim(config.appSecret));
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

async function fetchWechatMpOAuthAccessToken({ fetchImpl = fetch, config = {}, code = "" } = {}) {
  if (!isWechatMpLoginConfigured(config)) throw new Error("微信公众号登录未配置。");
  const url = new URL(WECHAT_MP_OAUTH_TOKEN_URL);
  url.searchParams.set("appid", trim(config.appId));
  url.searchParams.set("secret", trim(config.appSecret));
  url.searchParams.set("code", trim(code));
  url.searchParams.set("grant_type", "authorization_code");
  const data = await fetchJson(fetchImpl, url);
  const accessToken = trim(data.access_token);
  const openid = trim(data.openid);
  if (!accessToken || !openid) throw new Error("微信网页授权未返回 access_token 或 openid。");
  return { ...data, access_token: accessToken, openid };
}

async function fetchWechatMpOAuthUserInfo({ fetchImpl = fetch, accessToken, openid } = {}) {
  const url = new URL(WECHAT_MP_OAUTH_USER_INFO_URL);
  url.searchParams.set("access_token", trim(accessToken));
  url.searchParams.set("openid", trim(openid));
  url.searchParams.set("lang", "zh_CN");
  return fetchJson(fetchImpl, url);
}

function normalizeWechatOAuthProfile(userInfo = {}, tokenData = {}) {
  const openid = trim(userInfo.openid || tokenData.openid);
  if (!openid) throw new Error("微信网页授权结果缺少 openid。");
  if (Number(tokenData.is_snapshotuser || 0) === 1) {
    throw new Error("微信返回了快照页匿名用户，未提供真实昵称和头像。请从 Mia 二维码打开的说明页继续授权后重试。");
  }
  const nickname = trim(userInfo.nickname);
  const avatarUrl = trim(userInfo.headimgurl);
  if (!nickname || !avatarUrl) throw new Error("微信网页授权没有返回昵称和头像，请确认服务号已认证并启用网页授权获取用户基本信息。");
  const { access_token: _accessToken, refresh_token: _refreshToken, ...safeTokenData } = tokenData || {};
  return {
    openid,
    unionid: trim(userInfo.unionid || tokenData.unionid),
    nickname,
    avatarUrl,
    city: trim(userInfo.city),
    province: trim(userInfo.province),
    country: trim(userInfo.country),
    raw: { mpOAuthToken: safeTokenData, mpOAuthUser: userInfo || {} }
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

function createWechatAuthFlow({
  ttlMs = DEFAULT_TTL_MS,
  randomBytes = crypto.randomBytes,
  now = () => Date.now(),
  fetchImpl = fetch,
  cloudStore,
  onLogin = () => {}
} = {}) {
  const states = new Map();

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
      authorizationTarget: record.authorizationTarget || "",
      mode: record.mode || "mp_oauth_userinfo"
    };
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
    const callbackUrl = `${publicUrl}/api/auth/wechat/mp/oauth-callback`;
    const oauthUrl = new URL(WECHAT_MP_OAUTH_AUTHORIZE_URL);
    oauthUrl.searchParams.set("appid", trim(config.appId));
    oauthUrl.searchParams.set("redirect_uri", callbackUrl);
    oauthUrl.searchParams.set("response_type", "code");
    oauthUrl.searchParams.set("scope", "snsapi_userinfo");
    oauthUrl.searchParams.set("state", state);
    oauthUrl.searchParams.set("connect_redirect", "1");
    const authorizationTarget = `${oauthUrl.toString()}#wechat_redirect`;
    const qrCodeUrl = await QRCode.toDataURL(qrPageUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320
    });
    states.set(state, {
      state,
      status: "pending",
      mode: "mp_oauth_userinfo",
      expiresAt,
      createdAt: now(),
      authorizationTarget,
      qrCodeUrl,
      client
    });
    return {
      mode: "wechat_mp_oauth_userinfo",
      state,
      expiresAt: new Date(expiresAt).toISOString(),
      authorizationUrl: qrPageUrl,
      qrCodeUrl
    };
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

  async function completeMpOAuth({ state = "", code = "", config = {} } = {}) {
    const record = recordFor(state);
    if (record.status !== "pending") return { status: record.status };
    try {
      const tokenData = await fetchWechatMpOAuthAccessToken({ fetchImpl, config, code });
      const userInfo = await fetchWechatMpOAuthUserInfo({
        fetchImpl,
        accessToken: tokenData.access_token,
        openid: tokenData.openid
      });
      const profile = normalizeWechatOAuthProfile(userInfo, tokenData);
      const account = cloudStore.loginWithWechat(profile);
      record.status = "complete";
      record.account = account;
      record.profile = profile;
      onLogin(account);
      return { status: "complete", account };
    } catch (error) {
      record.status = "failed";
      record.error = error?.message || String(error);
      return { status: "failed", error: record.error };
    }
  }

  async function handleMpEventXml(xml = "") {
    purge();
    const event = parseWechatMpEventXml(xml);
    if (event.MsgType !== "event") return { status: "ignored", reason: "not_event", event };
    const scene = sceneFromWechatMpEvent(event);
    if (!scene) {
      return event.Event === "subscribe"
        ? { status: "not_login_scene", event }
        : { status: "ignored", reason: "not_login_scene", event };
    }
    const record = states.get(scene);
    if (!record) return { status: "unknown_scene", event };
    return { status: "not_login_scene", event };
  }

  return { startMp, complete, completeMpOAuth, handleMpEventXml, peek, purge };
}

module.exports = {
  WECHAT_MP_OAUTH_AUTHORIZE_URL,
  WECHAT_MP_OAUTH_TOKEN_URL,
  WECHAT_MP_OAUTH_USER_INFO_URL,
  createWechatAuthFlow,
  fetchWechatMpOAuthAccessToken,
  fetchWechatMpOAuthUserInfo,
  isWechatMpLoginConfigured,
  normalizeWechatOAuthProfile,
  parseWechatMpEventXml,
  randomState,
  sceneFromWechatMpEvent,
  verifyWechatMpSignature,
  wechatMpConfig,
  wechatMpSignature
};
