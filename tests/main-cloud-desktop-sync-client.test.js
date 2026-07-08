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

const CLOUD_AGENT_RUNTIME = {
  mode: "claude-code",
  runtimeKind: "cloud-claude-code",
  agentEngine: "claude-code",
  label: "Claude Code",
  available: true
};

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
      const nextResponse = responses.shift();
      if (nextResponse instanceof Error) throw nextResponse;
      return nextResponse || jsonResponse({ ok: true, user: { id: "u_1", username: "refreshed" } });
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
      jsonResponse({ status: "complete", token: "tok_new", user: { id: "u_new", username: "jung" } }),
      jsonResponse({ ok: true, cloudAgent: CLOUD_AGENT_RUNTIME })
    ]
  });

  const status = await client.login({ url: "https://new.example///" });

  assert.deepEqual(calls.writes[0], { url: "https://new.example", enabled: false, token: "", user: null, agentRuntime: null });
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
    user: { id: "u_new", username: "jung" },
    agentRuntime: null,
    lastMemorySyncAt: ""
  });
  assert.deepEqual(calls.writes[2], { agentRuntime: CLOUD_AGENT_RUNTIME });
  assert.equal(calls.startedEvents, 1);
  assert.equal(calls.startedBridge, 1);
  assert.deepEqual(status, { ok: true, includeToken: false, token: undefined });
  assert.equal(getSettings().token, "tok_new");
});

test("login without an explicit URL resets stale saved cloud URL to the default endpoint", async () => {
  const { client, calls } = setup({
    initialSettings: {
      enabled: false,
      token: "",
      url: "http://127.0.0.1:4175/",
      user: null
    },
    responses: [
      jsonResponse({
        mode: "wechat_mp_oauth_userinfo",
        authorizationUrl: "https://cloud.example/api/auth/wechat/mp/qr?state=wx_state",
        qrCodeUrl: `data:image/png;base64,${Buffer.from("qr-png").toString("base64")}`,
        state: "wx_state"
      })
    ]
  });

  const started = await client.login({ action: "start" });

  assert.equal(started.kind, "wechat-login-start");
  assert.deepEqual(calls.writes[0], {
    url: "https://cloud.example",
    enabled: false,
    token: "",
    user: null,
    agentRuntime: null
  });
  assert.equal(calls.fetch[0].url, "https://cloud.example/api/auth/wechat/start");
});

test("login reports fetch failures as user-facing Mia Cloud connection errors", async () => {
  const { client, calls } = setup({
    initialSettings: {
      enabled: false,
      token: "",
      url: "https://cloud.example/",
      user: null
    },
    responses: [
      new TypeError("fetch failed")
    ]
  });

  await assert.rejects(
    () => client.login({ action: "start" }),
    /连接 Mia Cloud 失败，请检查网络后重试。/
  );
  assert.equal(calls.logs.length, 1);
  assert.match(calls.logs[0], /Mia Cloud request network failed: POST https:\/\/cloud\.example\/api\/auth\/wechat\/start: fetch failed/);
});

test("syncWorkspace refreshes the cloud user and cloud agent runtime without syncing local manifest bots", async () => {
  const { client, calls } = setup({
    responses: [
      jsonResponse({ ok: true, user: { id: "u_1", username: "refreshed" } }),
      jsonResponse({ ok: true, cloudAgent: CLOUD_AGENT_RUNTIME })
    ]
  });

  await client.syncWorkspace();

  assert.deepEqual(calls.fetch.map((request) => [request.method, request.url]), [
    ["GET", "https://cloud.example/api/me"],
    ["GET", "https://cloud.example/api/health"]
  ]);
  assert.equal(calls.fetch[0].headers.Authorization, "Bearer tok_1");
  assert.equal(calls.fetch[0].body, null);
  assert.deepEqual(calls.writes, [
    { user: { id: "u_1", username: "refreshed" } },
    { agentRuntime: CLOUD_AGENT_RUNTIME }
  ]);
});

test("syncMemories pushes local scoped changes, applies cloud conflicts, and advances cursor", async () => {
  const applied = [];
  const { client, calls } = setup({
    initialSettings: {
      enabled: true,
      token: "tok_1",
      url: "https://cloud.example/",
      user: { id: "u_1", username: "jung" },
      lastMemorySyncAt: "2026-01-01T00:00:00.000Z"
    },
    memoryService: {
      listSyncMemories: (input) => {
        assert.deepEqual(input, {
          since: "2026-01-01T00:00:00.000Z",
          includeDeleted: true,
          limit: 1000
        });
        return [{
          id: "mem_local_deleted",
          botId: "mei",
          scope: "bot",
          text: "",
          status: "archived",
          updatedAt: "2026-01-02T00:00:00.000Z",
          deletedAt: "2026-01-02T00:00:00.000Z",
          revision: 2
        }];
      },
      applySyncedMemories: (entries, options = {}) => {
        applied.push({ entries, options });
        return { applied: entries, conflicts: [], errors: [] };
      }
    },
    responses: [
      jsonResponse({
        memories: [],
        conflicts: [{
          id: "mem_conflict",
          botId: "mei",
          scope: "bot",
          text: "Cloud has the newer memory",
          updatedAt: "2026-01-03T00:00:00.000Z",
          revision: 4
        }],
        errors: [],
        serverTime: "2026-01-04T00:00:00.000Z"
      }),
      jsonResponse({
        memories: [{
          id: "mem_remote",
          botId: "mei",
          scope: "bot",
          text: "Remote memory pulled down",
          updatedAt: "2026-01-04T00:00:00.000Z",
          revision: 1
        }],
        serverTime: "2026-01-05T00:00:00.000Z"
      })
    ]
  });

  const result = await client.syncMemories();

  assert.deepEqual(calls.fetch.map((request) => [request.method, request.url]), [
    ["POST", "https://cloud.example/api/me/memory/push"],
    ["GET", "https://cloud.example/api/me/memory?since=2026-01-01T00%3A00%3A00.000Z"]
  ]);
  assert.equal(calls.fetch[0].body.entries[0].id, "mem_local_deleted");
  assert.equal(calls.fetch[0].body.entries[0].deletedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(applied.length, 2);
  assert.equal(applied[0].entries[0].id, "mem_conflict");
  assert.deepEqual(applied[0].options, { force: true });
  assert.equal(applied[1].entries[0].id, "mem_remote");
  assert.deepEqual(calls.writes.at(-1), { lastMemorySyncAt: "2026-01-05T00:00:00.000Z" });
  assert.deepEqual(result, {
    ok: true,
    pushed: 0,
    pulled: 2,
    conflicts: 1,
    errors: 0,
    serverTime: "2026-01-05T00:00:00.000Z"
  });
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

test("saveAppearanceSettings writes local appearance without syncing the cloud user settings bag", async () => {
  const { client, calls } = setup({
    writeAppearanceSettings: (settings) => ({
      theme: settings.theme || "light",
      fontPreset: settings.fontPreset || "system",
      accentColor: settings.accentColor || "#318ad3",
      workspaceBackgroundColor: settings.workspaceBackgroundColor || "",
      workspaceBackgroundImage: ""
    }),
  });

  const status = await client.saveAppearanceSettings({
    theme: "dark",
    fontPreset: "serif",
    accentColor: "#112233",
    workspaceBackgroundColor: "#2CA1FF",
    workspaceBackgroundImage: "data:image/png;base64,abc123"
  });

  assert.deepEqual(calls.fetch, []);
  assert.deepEqual(status, { ok: true, includeToken: false, token: undefined });
});

test("saveAppearanceSettings is local-only even when cloud is disabled", async () => {
  const writes = [];
  const { client, calls } = setup({
    initialSettings: { enabled: false, token: "", url: "https://cloud.example/", user: null },
    writeAppearanceSettings: (settings) => {
      writes.push(settings);
      return { theme: settings.theme || "light" };
    }
  });

  await client.saveAppearanceSettings({ theme: "dark" });

  assert.deepEqual(writes, [{ theme: "dark" }]);
  assert.deepEqual(calls.fetch, []);
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

test("getMarketSkill fetches a skill detail without installing", async () => {
  const { client, calls } = setup({
    responses: [jsonResponse({
      skill: { id: "pdf", name: "pdf", latestVersion: "1.0.0" },
      download: { url: "/api/skills/pdf/versions/1.0.0/package", checksum: "abc" }
    })]
  });

  const detail = await client.getMarketSkill("pdf");

  assert.deepEqual(detail, {
    skill: { id: "pdf", name: "pdf", latestVersion: "1.0.0" },
    download: { url: "/api/skills/pdf/versions/1.0.0/package", checksum: "abc" }
  });
  assert.deepEqual(calls.fetch.map((request) => [request.method, request.url]), [
    ["GET", "https://cloud.example/api/skills/pdf"]
  ]);
});

test("logout clears local cloud auth even when remote logout fails and stops sockets", async () => {
  const { client, calls, getSettings } = setup({
    responses: [jsonResponse({ error: "gone" }, false, 500)]
  });

  await client.logout();

  assert.equal(calls.fetch[0].url, "https://cloud.example/api/auth/logout");
  assert.deepEqual(calls.writes.at(-1), { enabled: false, token: "", user: null, agentRuntime: null });
  assert.equal(calls.stoppedEvents, 1);
  assert.equal(calls.stoppedBridge, 1);
  assert.equal(getSettings().token, "");
});

test("login supports desktop mobile-scan start, pending lookup, and approval decisions", async () => {
  const { client, calls } = setup({
    responses: [
      jsonResponse({
        ok: true,
        grant: "ms_1",
        qrUrl: "https://cloud.example/mobile-scan?grant=ms_1",
        expiresAt: "2026-07-03T00:05:00.000Z"
      }),
      jsonResponse({
        requestId: "msr_1",
        deviceLabel: "iPhone",
        platform: "ios",
        status: "pending",
        expiresAt: "2026-07-03T00:01:30.000Z"
      }),
      jsonResponse({ ok: true, status: "approved" })
    ]
  });

  const started = await client.login({ action: "mobile-scan-start" });
  const pending = await client.login({ action: "mobile-scan-pending" });
  const approved = await client.login({ action: "mobile-scan-decision", requestId: "msr_1", decision: "approve" });

  assert.equal(started.grant, "ms_1");
  assert.equal(started.qrUrl, "https://cloud.example/mobile-scan?grant=ms_1");
  assert.equal(pending.requestId, "msr_1");
  assert.equal(pending.deviceLabel, "iPhone");
  assert.equal(approved.status, "approved");
  assert.deepEqual(calls.fetch.map((request) => [request.method, request.url, request.body]), [
    ["POST", "https://cloud.example/api/auth/mobile-scan/start", {}],
    ["GET", "https://cloud.example/api/auth/mobile-scan/pending", null],
    ["POST", "https://cloud.example/api/auth/mobile-scan/decision", { requestId: "msr_1", decision: "approve" }]
  ]);
});
