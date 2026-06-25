const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createCoreMcpOAuthTokenStore, tokenKey } = require("../src/core/mcp/oauth-token-store.js");
const { createCoreMcpOAuthService, pkcePair } = require("../src/core/mcp/oauth-service.js");

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-mcp-oauth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    store: createCoreMcpOAuthTokenStore({
      runtimePaths: () => ({ runtime: dir, home: dir, mcpServers: path.join(dir, "mia-mcp-servers.json") }),
      fs,
      now: () => 1710000000000
    })
  };
}

test("token store writes outside public registry and redacts token material", async (t) => {
  const { dir, store } = tempStore(t);
  await store.saveToken("https://example.com/mcp", {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 1710003600000,
    tokenType: "Bearer"
  });

  const loaded = await store.getToken("https://example.com/mcp");
  const view = await store.publicStatus("https://example.com/mcp");
  const registryPath = path.join(dir, "mia-mcp-servers.json");

  assert.equal(tokenKey("https://example.com/mcp").length, 64);
  assert.equal(loaded.accessToken, "access");
  assert.equal(loaded.refreshToken, "refresh");
  assert.equal(view.authenticated, true);
  assert.equal(view.accessToken, undefined);
  assert.equal(view.refreshToken, undefined);
  assert.equal(fs.existsSync(registryPath), false);
});

test("authorizationHeadersForServer returns bearer header and refreshes expired token", async (t) => {
  const { store } = tempStore(t);
  await store.saveToken("https://example.com/mcp", {
    accessToken: "old",
    refreshToken: "refresh",
    expiresAt: 1709999999000,
    tokenType: "Bearer",
    tokenEndpoint: "https://auth.example/token"
  });
  const fetchCalls = [];
  const service = createCoreMcpOAuthService({
    tokenStore: store,
    now: () => 1710000000000,
    fetch: async (url, options) => {
      fetchCalls.push({ url: String(url), body: String(options.body) });
      return {
        ok: true,
        json: async () => ({
          access_token: "new",
          refresh_token: "refresh2",
          expires_in: 3600,
          token_type: "Bearer"
        })
      };
    }
  });

  const headers = await service.authorizationHeadersForServer({
    transport: { type: "http", url: "https://example.com/mcp" }
  });
  const refreshed = await store.getToken("https://example.com/mcp");

  assert.deepEqual(headers, { Authorization: "Bearer new" });
  assert.deepEqual(fetchCalls, [{
    url: "https://auth.example/token",
    body: "grant_type=refresh_token&refresh_token=refresh"
  }]);
  assert.equal(refreshed.accessToken, "new");
  assert.equal(refreshed.refreshToken, "refresh2");
});

test("authorizationHeadersForServer returns current bearer token when not expired", async (t) => {
  const { store } = tempStore(t);
  await store.saveToken("https://example.com/mcp", {
    accessToken: "access",
    expiresAt: 1710003600000,
    tokenType: "Bearer"
  });
  const service = createCoreMcpOAuthService({ tokenStore: store, now: () => 1710000000000 });

  assert.deepEqual(await service.authorizationHeadersForServer({ serverUrl: "https://example.com/mcp" }), {
    Authorization: "Bearer access"
  });
});

test("authorizationHeadersForServer returns empty headers for expired token without refresh data", async (t) => {
  const { store } = tempStore(t);
  await store.saveToken("https://example.com/mcp", {
    accessToken: "old",
    expiresAt: 1709999999000,
    tokenType: "Bearer"
  });
  const service = createCoreMcpOAuthService({ tokenStore: store, now: () => 1710000000000 });

  assert.deepEqual(await service.authorizationHeadersForServer({ serverUrl: "https://example.com/mcp" }), {});
});

test("authorizationHeadersForServer returns empty headers when expired token refresh fails", async (t) => {
  const { store } = tempStore(t);
  await store.saveToken("https://example.com/mcp", {
    accessToken: "old",
    refreshToken: "refresh",
    expiresAt: 1709999999000,
    tokenType: "Bearer",
    tokenEndpoint: "https://auth.example/token"
  });
  const service = createCoreMcpOAuthService({
    tokenStore: store,
    now: () => 1710000000000,
    fetch: async () => ({ ok: false, json: async () => ({}) })
  });

  assert.deepEqual(await service.authorizationHeadersForServer({ serverUrl: "https://example.com/mcp" }), {});
});

test("logout deletes token and checkStatus reports unauthenticated", async (t) => {
  const { store } = tempStore(t);
  await store.saveToken("https://example.com/mcp", {
    accessToken: "access",
    expiresAt: 1710003600000,
    tokenType: "Bearer"
  });
  const service = createCoreMcpOAuthService({ tokenStore: store, now: () => 1710000000000 });

  assert.equal((await service.checkStatus({ serverUrl: "https://example.com/mcp" })).authenticated, true);
  await service.logout({ serverUrl: "https://example.com/mcp" });
  assert.equal((await service.checkStatus({ serverUrl: "https://example.com/mcp" })).authenticated, false);
});

test("login builds explicit endpoint PKCE authorization URL", async (t) => {
  const { store } = tempStore(t);
  const opened = [];
  const service = createCoreMcpOAuthService({
    tokenStore: store,
    now: () => 1710000000000,
    openExternal: async (url) => opened.push(url)
  });

  const result = await service.login({
    serverUrl: "https://example.com/mcp",
    authorizationEndpoint: "https://auth.example/authorize",
    tokenEndpoint: "https://auth.example/token",
    clientId: "mia-test",
    redirectUri: "http://127.0.0.1:1234/callback"
  });
  const loginUrl = new URL(result.loginUrl);

  assert.equal(opened.length, 1);
  assert.equal(opened[0], result.loginUrl);
  assert.equal(loginUrl.origin + loginUrl.pathname, "https://auth.example/authorize");
  assert.equal(loginUrl.searchParams.get("response_type"), "code");
  assert.equal(loginUrl.searchParams.get("client_id"), "mia-test");
  assert.equal(loginUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(result.tokenEndpoint, "https://auth.example/token");
  assert.equal(typeof result.verifier, "string");
  assert.equal(result.verifier.length > 20, true);
});

test("pkcePair returns a verifier and S256 challenge", () => {
  const pair = pkcePair();

  assert.equal(pair.method, "S256");
  assert.equal(typeof pair.verifier, "string");
  assert.equal(typeof pair.challenge, "string");
  assert.notEqual(pair.verifier, pair.challenge);
});
