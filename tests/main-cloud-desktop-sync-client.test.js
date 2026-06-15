const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createCloudDesktopSyncClient } = require("../src/main/cloud/desktop-sync-client.js");

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body
  };
}

function binaryResponse(body = "qr-png", contentType = "image/png", ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: (name) => String(name || "").toLowerCase() === "content-type" ? contentType : null },
    arrayBuffer: async () => Buffer.from(body)
  };
}

function setup(overrides = {}) {
  let settings = overrides.initialSettings || {
    enabled: true,
    token: "tok_1",
    url: "https://cloud.example/",
    user: { id: "u_1", username: "jung" }
  };
  const calls = {
    fetch: [],
    profileWrites: [],
    writes: [],
    logs: [],
    startedEvents: 0,
    startedBridge: 0,
    stoppedEvents: 0,
    stoppedBridge: 0,
    openedUrls: [],
    waits: []
  };
  const responses = overrides.responses || [];
  const client = createCloudDesktopSyncClient({
    getCloudSettings: () => settings,
    writeCloudSettings: (patch) => {
      calls.writes.push(patch);
      settings = { ...settings, ...patch };
    },
    normalizeCloudUrl: (url) => String(url || "https://cloud.example").replace(/\/+$/, ""),
    cloudStatus: (includeToken = false) => ({ ok: true, includeToken, token: includeToken ? settings.token : undefined }),
    appendLog: (line) => calls.logs.push(String(line || "")),
    fetchImpl: async (url, options) => {
      calls.fetch.push({
        url,
        method: options.method,
        headers: options.headers,
        body: options.body ? JSON.parse(options.body) : null,
        signal: options.signal
      });
      return responses.shift() || jsonResponse({ ok: true, user: { id: "u_1", username: "refreshed" } });
    },
    timeoutSignal: () => "timeout-signal",
    runtimePaths: () => ({ userProfile: "/profile.json" }),
    readJson: (filePath) => filePath === "/profile.json"
      ? { avatarImage: "data:image/png;base64,user", avatarCrop: { y: 2 }, avatarColor: "#ffcc00" }
      : null,
    writeUserProfile: (profile) => {
      calls.profileWrites.push(profile);
      return profile;
    },
    writeAppearanceSettings: (settings) => settings,
    startCloudEvents: () => { calls.startedEvents += 1; },
    startCloudBridge: () => { calls.startedBridge += 1; },
    stopCloudEvents: () => { calls.stoppedEvents += 1; },
    stopCloudBridge: () => { calls.stoppedBridge += 1; },
    waitMs: async (ms) => { calls.waits.push(ms); },
    now: () => 123456,
    ...overrides
  });
  return { client, calls, getSettings: () => settings };
}

test("login normalizes the cloud URL, starts WeChat auth, then starts sockets with the returned token", async () => {
  const { client, calls, getSettings } = setup({
    responses: [
      jsonResponse({
        mode: "wechat_mp_oauth_userinfo",
        authorizationUrl: "https://new.example/api/auth/wechat/mp/qr?state=wx_state",
        qrCodeUrl: `data:image/png;base64,${Buffer.from("qr-png").toString("base64")}`,
        state: "wx_state"
      }),
      jsonResponse({ status: "complete", token: "tok_new", user: { id: "u_new", username: "jung" } })
    ]
  });

  const status = await client.login({ url: "https://new.example///" });

  assert.deepEqual(calls.writes[0], { url: "https://new.example", enabled: false, token: "", user: null });
  assert.deepEqual(calls.fetch[0], {
    url: "https://new.example/api/auth/wechat/start",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { client: "desktop" },
    signal: "timeout-signal"
  });
  assert.deepEqual(calls.fetch[1], {
    url: "https://new.example/api/auth/wechat/complete",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { state: "wx_state" },
    signal: "timeout-signal"
  });
  assert.deepEqual(calls.openedUrls, []);
  assert.deepEqual(calls.waits, [1500]);
  assert.deepEqual(calls.writes[1], {
    url: "https://new.example",
    enabled: true,
    token: "tok_new",
    user: { id: "u_new", username: "jung" }
  });
  assert.equal(calls.startedEvents, 1);
  assert.equal(calls.startedBridge, 1);
  assert.deepEqual(status, { ok: true, includeToken: false, token: undefined });
  assert.equal(getSettings().token, "tok_new");
});

test("syncWorkspace refreshes the cloud user without syncing local manifest bots", async () => {
  const { client, calls } = setup();

  await client.syncWorkspace();

  assert.deepEqual(calls.fetch.map((request) => [request.method, request.url]), [
    ["GET", "https://cloud.example/api/me"]
  ]);
  assert.equal(calls.fetch[0].headers.Authorization, "Bearer tok_1");
  assert.equal(calls.fetch[0].body, null);
  assert.deepEqual(calls.writes.at(-1), { user: { id: "u_1", username: "refreshed" } });
});

test("saveUserProfile writes the local profile and immediately syncs it to Mia Cloud", async () => {
  let savedProfile = null;
  const { client, calls } = setup({
    readJson: () => savedProfile,
    writeUserProfile: (profile) => {
      savedProfile = {
        displayName: String(profile.displayName || "").trim(),
        avatarImage: String(profile.avatarImage || "").trim(),
        avatarCrop: profile.avatarCrop || null,
        avatarColor: String(profile.avatarColor || "").trim(),
        statusBadge: profile.statusBadge || null
      };
      calls.profileWrites.push(savedProfile);
      return savedProfile;
    },
    responses: [jsonResponse({
      user: {
        id: "u_1",
        username: "jung",
        displayName: "Jung",
        avatarImage: "/api/avatar-assets/u_1.png",
        avatarCrop: { x: 45, y: 55, zoom: 1.2 },
        avatarColor: "#112233"
      }
    })]
  });

  const status = await client.saveUserProfile({
    displayName: " Jung ",
    avatarImage: "data:image/png;base64,new",
    avatarCrop: { x: 45, y: 55, zoom: 1.2 },
    avatarColor: "#112233",
    statusBadge: { kind: "lottie", assetId: "rainbow", label: "彩虹动画", loop: "always" }
  });

  assert.deepEqual(calls.profileWrites, [{
    displayName: "Jung",
    avatarImage: "data:image/png;base64,new",
    avatarCrop: { x: 45, y: 55, zoom: 1.2 },
    avatarColor: "#112233",
    statusBadge: { kind: "lottie", assetId: "rainbow", label: "彩虹动画", loop: "always" }
  }]);
  assert.deepEqual(calls.fetch.map((request) => [request.method, request.url]), [
    ["PATCH", "https://cloud.example/api/me/profile"]
  ]);
  assert.deepEqual(calls.fetch[0].body, {
    displayName: "Jung",
    avatarImage: "data:image/png;base64,new",
    avatarCrop: { x: 45, y: 55, zoom: 1.2 },
    avatarColor: "#112233",
    statusBadge: { kind: "lottie", assetId: "rainbow", label: "彩虹动画", loop: "always" }
  });
  assert.deepEqual(calls.writes.at(-1), {
    user: {
      id: "u_1",
      username: "jung",
      displayName: "Jung",
      avatarImage: "/api/avatar-assets/u_1.png",
      avatarCrop: { x: 45, y: 55, zoom: 1.2 },
      avatarColor: "#112233"
    }
  });
  assert.deepEqual(status, { ok: true, includeToken: false, token: undefined });
});

test("login can return an inline WeChat OAuth QR and complete it without opening a browser", async () => {
  const { client, calls, getSettings } = setup({
    responses: [
      jsonResponse({
        mode: "wechat_mp_oauth_userinfo",
        authorizationUrl: "https://new.example/api/auth/wechat/mp/qr?state=wx_state",
        qrCodeUrl: `data:image/png;base64,${Buffer.from("qr-png").toString("base64")}`,
        state: "wx_state",
        expiresAt: "2026-06-11T13:00:00.000Z"
      }),
      jsonResponse({ status: "pending", expiresAt: "2026-06-11T13:00:00.000Z" }),
      jsonResponse({ status: "complete", token: "tok_new", user: { id: "u_new", username: "jung" } })
    ]
  });

  const started = await client.login({ action: "start", url: "https://new.example///" });
  assert.deepEqual(started, {
    kind: "wechat-login-start",
    mode: "wechat_mp_oauth_userinfo",
    state: "wx_state",
    qrCodeUrl: `data:image/png;base64,${Buffer.from("qr-png").toString("base64")}`,
    authorizationUrl: "https://new.example/api/auth/wechat/mp/qr?state=wx_state",
    expiresAt: "2026-06-11T13:00:00.000Z"
  });
  assert.deepEqual(calls.openedUrls, []);

  const pending = await client.login({ action: "complete", state: "wx_state" });
  assert.deepEqual(pending, {
    kind: "wechat-login-pending",
    status: "pending",
    expiresAt: "2026-06-11T13:00:00.000Z"
  });

  const completed = await client.login({ action: "complete", state: "wx_state" });
  assert.deepEqual(completed, { kind: "wechat-login-complete", status: "complete" });
  assert.equal(getSettings().enabled, true);
  assert.equal(getSettings().token, "tok_new");
  assert.equal(calls.startedEvents, 1);
  assert.equal(calls.startedBridge, 1);
});

test("saveAppearanceSettings writes local appearance and syncs the cloud user settings bag", async () => {
  const { client, calls } = setup({
    writeAppearanceSettings: (settings) => ({
      theme: settings.theme || "light",
      fontPreset: settings.fontPreset || "system",
      accentColor: settings.accentColor || "#0162db"
    }),
    responses: [
      jsonResponse({ settings: { pins: ["conv_1"], readMarks: { conv_1: 7 }, appearance: { theme: "light" }, version: 4 } }),
      jsonResponse({ settings: { pins: ["conv_1"], readMarks: { conv_1: 7 }, appearance: { theme: "dark", fontPreset: "serif", accentColor: "#112233" }, version: 5 } })
    ]
  });

  const status = await client.saveAppearanceSettings({
    theme: "dark",
    fontPreset: "serif",
    accentColor: "#112233"
  });

  assert.deepEqual(calls.fetch.map((request) => [request.method, request.url]), [
    ["GET", "https://cloud.example/api/me/settings"],
    ["PUT", "https://cloud.example/api/me/settings"]
  ]);
  assert.deepEqual(calls.fetch[1].body, {
    pins: ["conv_1"],
    readMarks: { conv_1: 7 },
    appearance: {
      theme: "dark",
      fontPreset: "serif",
      accentColor: "#112233"
    },
    expectedVersion: 4
  });
  assert.deepEqual(status, { ok: true, includeToken: false, token: undefined });
});

test("saveAppearanceSettings preserves remote conversation tags when the server supports them", async () => {
  const tags = {
    items: [{ id: "tag_work", name: "工作", color: "#16a34a" }],
    assignments: { "dm:u_1:u_2": ["tag_work"] }
  };
  const { client, calls } = setup({
    writeAppearanceSettings: (settings) => ({ theme: settings.theme || "light" }),
    responses: [
      jsonResponse({ settings: { pins: [], readMarks: {}, appearance: {}, tags, version: 8 } }),
      jsonResponse({ settings: { pins: [], readMarks: {}, appearance: { theme: "dark" }, tags, version: 9 } })
    ]
  });

  await client.saveAppearanceSettings({ theme: "dark" });

  assert.deepEqual(calls.fetch[1].body.tags, tags);
  assert.equal(calls.fetch[1].body.expectedVersion, 8);
});

test("local bot manifest sync methods are not exposed by the cloud desktop sync client", () => {
  const { client } = setup();

  assert.equal(Object.hasOwn(client, "pushAllBots"), false);
  assert.equal(Object.hasOwn(client, "pushBot"), false);
  assert.equal(Object.hasOwn(client, "deleteBot"), false);
});

test("listMarketSkills serves a fresh local cache without hitting the cloud", async () => {
  const cacheCalls = [];
  const skillMarketCache = {
    getMarketPage: (userId, params, options) => {
      cacheCalls.push(["get", userId, params, options]);
      return {
        skills: [{ id: "cached", name: "cached" }],
        categories: [{ category: "office", count: 1 }],
        fresh: true,
        stale: false,
        updatedAt: "2026-05-28T00:00:00.000Z",
        updatedAtMs: 1000
      };
    },
    upsertMarketPage: (...args) => cacheCalls.push(["upsert", ...args])
  };
  const { client, calls } = setup({ skillMarketCache, skillMarketCacheTtlMs: 300000 });

  const page = await client.listMarketSkills({ category: " office ", q: " ppt ", limit: "120" });

  assert.deepEqual(page, {
    skills: [{ id: "cached", name: "cached" }],
    categories: [{ category: "office", count: 1 }],
    cached: true,
    stale: false,
    updatedAt: "2026-05-28T00:00:00.000Z"
  });
  assert.equal(calls.fetch.length, 0);
  assert.deepEqual(cacheCalls, [[
    "get",
    "u_1",
    { category: "office", q: "ppt", limit: 120 },
    { nowMs: 123456, ttlMs: 300000 }
  ]]);
});

test("listMarketSkills returns stale cache first and forceRefresh updates the cache", async () => {
  const cacheCalls = [];
  const skillMarketCache = {
    getMarketPage: (userId, params, options) => {
      cacheCalls.push(["get", userId, params, options]);
      return {
        skills: [{ id: "old", name: "old" }],
        categories: [{ category: "old", count: 1 }],
        fresh: false,
        stale: true,
        updatedAt: "2026-05-28T00:00:00.000Z",
        updatedAtMs: 1000
      };
    },
    upsertMarketPage: (...args) => cacheCalls.push(["upsert", ...args])
  };
  const { client, calls } = setup({
    skillMarketCache,
    skillMarketCacheTtlMs: 300000,
    responses: [jsonResponse({
      skills: [{ id: "fresh", name: "fresh" }],
      categories: [{ category: "fresh", count: 1 }]
    })]
  });

  const stale = await client.listMarketSkills({ limit: 120 });
  assert.deepEqual(stale.skills.map((skill) => skill.name), ["old"]);
  assert.equal(stale.cached, true);
  assert.equal(stale.stale, true);
  assert.equal(calls.fetch.length, 0);

  const fresh = await client.listMarketSkills({ limit: 120, forceRefresh: true });
  assert.deepEqual(fresh.skills.map((skill) => skill.name), ["fresh"]);
  assert.equal(fresh.cached, false);
  assert.equal(fresh.stale, false);
  assert.equal(calls.fetch[0].url, "https://cloud.example/api/skills?limit=120");
  assert.deepEqual(cacheCalls.at(-1), [
    "upsert",
    "u_1",
    { category: "", q: "", limit: 120 },
    {
      skills: [{ id: "fresh", name: "fresh" }],
      categories: [{ category: "fresh", count: 1 }]
    },
    123456
  ]);
});

test("logout clears local cloud auth even when remote logout fails and stops sockets", async () => {
  const { client, calls, getSettings } = setup({
    responses: [jsonResponse({ error: "gone" }, false, 500)]
  });

  await client.logout();

  assert.equal(calls.fetch[0].url, "https://cloud.example/api/auth/logout");
  assert.deepEqual(calls.writes.at(-1), { enabled: false, token: "", user: null });
  assert.equal(calls.stoppedEvents, 1);
  assert.equal(calls.stoppedBridge, 1);
  assert.equal(getSettings().token, "");
});
