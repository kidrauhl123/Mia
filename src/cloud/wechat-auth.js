"use strict";

const crypto = require("node:crypto");

const WECHAT_AUTHORIZE_URL = "https://open.weixin.qq.com/connect/qrconnect";
const WECHAT_ACCESS_TOKEN_URL = "https://api.weixin.qq.com/sns/oauth2/access_token";
const WECHAT_USERINFO_URL = "https://api.weixin.qq.com/sns/userinfo";
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

  function recordFor(state) {
    purge();
    const record = states.get(trim(state));
    if (!record) throw new Error("微信登录请求已过期，请重新发起。");
    return record;
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

  return { start, callback, complete, purge };
}

module.exports = {
  WECHAT_ACCESS_TOKEN_URL,
  WECHAT_AUTHORIZE_URL,
  WECHAT_USERINFO_URL,
  buildWechatAuthorizeUrl,
  createWechatAuthFlow,
  exchangeWechatCode,
  fetchWechatUserInfo,
  isWechatConfigured,
  normalizeWechatProfile,
  randomState,
  wechatConfig
};
