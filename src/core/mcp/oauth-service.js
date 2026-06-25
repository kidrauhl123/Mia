"use strict";

const crypto = require("node:crypto");

function base64Url(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pkcePair() {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

function serverUrlFrom(input = {}) {
  return String(input.serverUrl || input.url || input.transport?.url || "").trim();
}

function expiresAtFrom(now, body = {}) {
  const expiresIn = Number(body.expires_in);
  return Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : null;
}

function createCoreMcpOAuthService(deps = {}) {
  const tokenStore = deps.tokenStore;
  if (!tokenStore) throw new Error("tokenStore dependency is required.");
  const fetchImpl = deps.fetch || globalThis.fetch;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const openExternal = typeof deps.openExternal === "function" ? deps.openExternal : async () => {};

  async function refreshToken(serverUrl, token) {
    if (!token?.refreshToken || !token?.tokenEndpoint || typeof fetchImpl !== "function") return token;
    const response = await fetchImpl(token.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refreshToken
      })
    });
    if (!response?.ok) return token;
    const body = await response.json();
    return tokenStore.saveToken(serverUrl, {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || token.refreshToken,
      expiresAt: expiresAtFrom(now, body),
      tokenType: body.token_type || token.tokenType || "Bearer",
      tokenEndpoint: token.tokenEndpoint
    });
  }

  async function authorizationHeadersForServer(record = {}) {
    const serverUrl = serverUrlFrom(record);
    if (!serverUrl) return {};
    let token = await tokenStore.getToken(serverUrl);
    if (!token) return {};
    if (token.expiresAt && token.expiresAt <= now() + 60000) {
      token = await refreshToken(serverUrl, token);
    }
    if (!token?.accessToken) return {};
    return { Authorization: `${token.tokenType || "Bearer"} ${token.accessToken}` };
  }

  async function checkStatus(input = {}) {
    return tokenStore.publicStatus(serverUrlFrom(input));
  }

  async function logout(input = {}) {
    await tokenStore.deleteToken(serverUrlFrom(input));
    return { authenticated: false };
  }

  async function login(input = {}) {
    const serverUrl = serverUrlFrom(input);
    if (!serverUrl) throw new Error("serverUrl is required for MCP OAuth login.");
    const authorizationEndpoint = input.authorizationEndpoint || input.authorizationUrl;
    const tokenEndpoint = String(input.tokenEndpoint || "").trim();
    if (!authorizationEndpoint || !tokenEndpoint) {
      throw new Error("OAuth authorizationEndpoint and tokenEndpoint are required until discovery is wired.");
    }

    const pkce = pkcePair();
    const redirectUri = String(input.redirectUri || "http://127.0.0.1/callback");
    const state = base64Url(crypto.randomBytes(16));
    const loginUrl = new URL(authorizationEndpoint);
    loginUrl.searchParams.set("response_type", "code");
    loginUrl.searchParams.set("client_id", input.clientId || "mia");
    loginUrl.searchParams.set("redirect_uri", redirectUri);
    loginUrl.searchParams.set("code_challenge", pkce.challenge);
    loginUrl.searchParams.set("code_challenge_method", pkce.method);
    loginUrl.searchParams.set("state", state);

    await openExternal(loginUrl.toString());
    return {
      loginUrl: loginUrl.toString(),
      state,
      tokenEndpoint,
      verifier: pkce.verifier
    };
  }

  return {
    authorizationHeadersForServer,
    checkStatus,
    login,
    logout,
    refreshToken
  };
}

module.exports = {
  createCoreMcpOAuthService,
  pkcePair
};
