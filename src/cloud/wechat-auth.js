"use strict";

const crypto = require("node:crypto");

const WECHAT_AUTHORIZE_URL = "https://open.weixin.qq.com/connect/qrconnect";
const WECHAT_ACCESS_TOKEN_URL = "https://api.weixin.qq.com/sns/oauth2/access_token";
const WECHAT_USERINFO_URL = "https://api.weixin.qq.com/sns/userinfo";
const WECHAT_MP_ACCESS_TOKEN_URL = "https://api.weixin.qq.com/cgi-bin/token";
const WECHAT_MP_QRCODE_CREATE_URL = "https://api.weixin.qq.com/cgi-bin/qrcode/create";
const WECHAT_MP_QRCODE_SHOW_URL = "https://mp.weixin.qq.com/cgi-bin/showqrcode";
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

function publicOriginFromRequest(req) {
  const host = trim(req?.headers?.host);
  if (!host) return "";
  const proto = trim(req?.headers?.["x-forwarded-proto"]).split(",")[0] || "https";
  return `${proto}://${host}`;
}

function wechatConfig(context = {}, req = null) {
  const appId = trim(context.wechatAppId || process.env.MIA_WECHAT_APP_ID);
  const appSecret = trim(context.wechatAppSecret || process.env.MIA_WECHAT_APP_SECRET);
  const explicitRedirect = trim(context.wechatRedirectUri || process.env.MIA_WECHAT_REDIRECT_URI);
  const origin = trim(context.publicUrl || process.env.MIA_CLOUD_PUBLIC_URL || process.env.MIA_PUBLIC_URL)
    || publicOriginFromRequest(req);
  const redirectUri = explicitRedirect || (origin ? `${origin.replace(/\/+$/, "")}/api/auth/wechat/callback` : "");
  return { appId, appSecret, redirectUri };
}

function wechatMpConfig(context = {}) {
  return {
    appId: trim(context.wechatMpAppId || process.env.MIA_WECHAT_MP_APP_ID),
    appSecret: trim(context.wechatMpAppSecret || process.env.MIA_WECHAT_MP_APP_SECRET),
    token: trim(context.wechatMpToken || process.env.MIA_WECHAT_MP_TOKEN),
    encodingAesKey: trim(context.wechatMpEncodingAesKey || process.env.MIA_WECHAT_MP_ENCODING_AES_KEY)
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

function isWechatConfigured(config = {}) {
  return Boolean(trim(config.appId) && trim(config.appSecret) && trim(config.redirectUri));
}

function buildWechatAuthorizeUrl({ appId, redirectUri, state } = {}) {
  const params = new URLSearchParams({
    appid: trim(appId),
    redirect_uri: trim(redirectUri),
    response_type: "code",
    scope: "snsapi_login",
    state: trim(state)
  });
  return `${WECHAT_AUTHORIZE_URL}?${params.toString()}#wechat_redirect`;
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

async function exchangeWechatCode({ fetchImpl = fetch, appId, appSecret, code } = {}) {
  const url = new URL(WECHAT_ACCESS_TOKEN_URL);
  url.searchParams.set("appid", trim(appId));
  url.searchParams.set("secret", trim(appSecret));
  url.searchParams.set("code", trim(code));
  url.searchParams.set("grant_type", "authorization_code");
  return fetchJson(fetchImpl, url);
}

async function fetchWechatUserInfo({ fetchImpl = fetch, accessToken, openid } = {}) {
  const url = new URL(WECHAT_USERINFO_URL);
  url.searchParams.set("access_token", trim(accessToken));
  url.searchParams.set("openid", trim(openid));
  url.searchParams.set("lang", "zh_CN");
  return fetchJson(fetchImpl, url);
}

function normalizeWechatProfile(tokenData = {}, userInfo = {}) {
  const openid = trim(userInfo.openid || tokenData.openid);
  const unionid = trim(userInfo.unionid || tokenData.unionid);
  if (!openid && !unionid) throw new Error("微信授权结果缺少 openid。");
  return {
    openid,
    unionid,
    nickname: trim(userInfo.nickname) || "微信用户",
    avatarUrl: trim(userInfo.headimgurl),
    city: trim(userInfo.city),
    province: trim(userInfo.province),
    country: trim(userInfo.country),
    raw: { token: tokenData, user: userInfo }
  };
}

function normalizeWechatMpProfile(event = {}) {
  const openid = trim(event.FromUserName || event.openid);
  if (!openid) throw new Error("微信关注事件缺少 openid。");
  return {
    openid,
    unionid: "",
    nickname: "微信用户",
    avatarUrl: "",
    raw: { mpEvent: event }
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
      mode: record.mode || "oauth"
    };
  }

  function start(config = {}) {
    purge();
    if (!isWechatConfigured(config)) throw new Error("微信登录未配置。");
    const state = randomState(randomBytes);
    const expiresAt = now() + ttlMs;
    states.set(state, { state, status: "pending", expiresAt, createdAt: now() });
    return {
      state,
      expiresAt: new Date(expiresAt).toISOString(),
      authorizationUrl: buildWechatAuthorizeUrl({ appId: config.appId, redirectUri: config.redirectUri, state })
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
    const token = await mpApiAccessToken(config);
    const qr = await postJson(fetchImpl, `${WECHAT_MP_QRCODE_CREATE_URL}?access_token=${encodeURIComponent(token)}`, {
      expire_seconds: Math.max(60, Math.ceil(ttlMs / 1000)),
      action_name: "QR_STR_SCENE",
      action_info: { scene: { scene_str: state } }
    });
    const ticket = trim(qr.ticket);
    if (!ticket) throw new Error("微信未返回公众号二维码 ticket。");
    const qrCodeUrl = `${WECHAT_MP_QRCODE_SHOW_URL}?ticket=${encodeURIComponent(ticket)}`;
    const publicUrl = trim(options.publicUrl).replace(/\/+$/, "");
    const client = trim(options.client);
    const authorizationUrl = client === "web" && publicUrl
      ? `${publicUrl}/api/auth/wechat/mp/qr?state=${encodeURIComponent(state)}`
      : qrCodeUrl;
    states.set(state, {
      state,
      status: "pending",
      mode: "mp",
      expiresAt,
      createdAt: now(),
      qrCodeUrl,
      ticket,
      client
    });
    return {
      state,
      expiresAt: new Date(expiresAt).toISOString(),
      authorizationUrl,
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

  async function callback({ state, code, config } = {}) {
    const record = recordFor(state);
    if (!trim(code)) {
      record.status = "failed";
      record.error = "微信未返回授权 code。";
      throw new Error(record.error);
    }
    try {
      const tokenData = await exchangeWechatCode({
        fetchImpl,
        appId: config.appId,
        appSecret: config.appSecret,
        code
      });
      const userInfo = await fetchWechatUserInfo({
        fetchImpl,
        accessToken: tokenData.access_token,
        openid: tokenData.openid
      });
      const profile = normalizeWechatProfile(tokenData, userInfo);
      const account = cloudStore.loginWithWechat(profile);
      record.status = "complete";
      record.account = account;
      record.profile = profile;
      onLogin(account);
      return { account, profile };
    } catch (error) {
      record.status = "failed";
      record.error = error?.message || String(error);
      throw error;
    }
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

  function handleMpEventXml(xml = "") {
    purge();
    const event = parseWechatMpEventXml(xml);
    if (event.MsgType !== "event") return { status: "ignored", reason: "not_event" };
    const scene = sceneFromWechatMpEvent(event);
    if (!scene) return { status: "ignored", reason: "not_login_scene" };
    const record = states.get(scene);
    if (!record) return { status: "ignored", reason: "unknown_scene" };
    if (record.status !== "pending") return { status: record.status };
    try {
      const profile = normalizeWechatMpProfile(event);
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

  return { start, startMp, callback, complete, handleMpEventXml, peek, purge };
}

module.exports = {
  WECHAT_ACCESS_TOKEN_URL,
  WECHAT_AUTHORIZE_URL,
  WECHAT_MP_ACCESS_TOKEN_URL,
  WECHAT_MP_QRCODE_CREATE_URL,
  WECHAT_MP_QRCODE_SHOW_URL,
  WECHAT_USERINFO_URL,
  buildWechatAuthorizeUrl,
  createWechatAuthFlow,
  exchangeWechatCode,
  fetchWechatUserInfo,
  isWechatMpLoginConfigured,
  isWechatConfigured,
  normalizeWechatProfile,
  parseWechatMpEventXml,
  randomState,
  sceneFromWechatMpEvent,
  verifyWechatMpSignature,
  wechatMpConfig,
  wechatMpSignature,
  wechatConfig
};
