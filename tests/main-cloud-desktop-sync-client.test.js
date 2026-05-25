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

function setup(overrides = {}) {
  let settings = overrides.initialSettings || {
    enabled: true,
    token: "tok_1",
    url: "https://cloud.example/",
    user: { id: "u_1", username: "jung" }
  };
  const calls = {
    fetch: [],
    writes: [],
    logs: [],
    startedEvents: 0,
    startedBridge: 0,
    stoppedEvents: 0,
    stoppedBridge: 0
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
    loadFellowManifest: () => ({
      fellows: [{
        key: "codex",
        name: "Codex",
        color: "#123456",
        avatarImage: "data:image/png;base64,abc",
        avatarCrop: { x: 1 },
        bio: "assistant",
        capabilities: { chat: true, image: false }
      }]
    }),
    fellowPersonaPath: (key) => `/personas/${key}.md`,
    fileExists: (filePath) => filePath === "/personas/codex.md",
    readFellowPersona: () => "persona text",
    runtimePaths: () => ({ userProfile: "/profile.json" }),
    readJson: (filePath) => filePath === "/profile.json"
      ? { avatarImage: "data:image/png;base64,user", avatarCrop: { y: 2 }, avatarColor: "#ffcc00" }
      : null,
    loadChatStore: () => ({
      sessions: {
        codex: [{
          id: "s_1",
          title: "Codex chat",
          messages: [
            { id: "m_1", content: "hello", attachments: [{ name: "a.txt" }] },
            { id: "m_empty", content: "   " },
            { createdAt: "2026-05-25T00:00:00.000Z", text: "fallback text" }
          ]
        }]
      }
    }),
    startCloudEvents: () => { calls.startedEvents += 1; },
    startCloudBridge: () => { calls.startedBridge += 1; },
    stopCloudEvents: () => { calls.stoppedEvents += 1; },
    stopCloudBridge: () => { calls.stoppedBridge += 1; },
    now: () => 123456,
    ...overrides
  });
  return { client, calls, getSettings: () => settings };
}

test("login normalizes the cloud URL, resets local auth, then starts sockets with the returned token", async () => {
  const { client, calls, getSettings } = setup({
    responses: [jsonResponse({ token: "tok_new", user: { id: "u_new", username: "jung" } })]
  });

  const status = await client.login({ username: " jung ", password: "pw", mode: "register", url: "https://new.example///" });

  assert.deepEqual(calls.writes[0], { url: "https://new.example", enabled: false, token: "", user: null });
  assert.deepEqual(calls.fetch[0], {
    url: "https://new.example/api/auth/register",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { username: "jung", password: "pw" },
    signal: "timeout-signal"
  });
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

test("syncWorkspace syncs fellow identity and stable rooms without reading local sessions", async () => {
  const { client, calls } = setup({
    loadChatStore: () => {
      throw new Error("local session store must not be read during login sync");
    }
  });

  await client.syncWorkspace();

  assert.deepEqual(calls.fetch.map((request) => [request.method, request.url]), [
    ["PATCH", "https://cloud.example/api/me/profile"],
    ["PUT", "https://cloud.example/api/me/fellows/codex"],
    ["PUT", "https://cloud.example/api/me/fellows/codex/room"],
    ["GET", "https://cloud.example/api/me"]
  ]);
  assert.equal(calls.fetch[0].headers.Authorization, "Bearer tok_1");
  assert.deepEqual(calls.fetch[1].body, {
    name: "Codex",
    color: "#123456",
    avatarImage: "data:image/png;base64,abc",
    avatarCrop: { x: 1 },
    bio: "assistant",
    capabilities: ["chat"],
    personaText: "persona text"
  });
  assert.deepEqual(calls.fetch[2].body, {
    title: "Codex",
    runtimeKind: "desktop-local"
  });
  assert.deepEqual(calls.writes.at(-1), { user: { id: "u_1", username: "refreshed" } });
});

test("pushDesktopMessage keeps legacy local-mode fellow room message mirroring", async () => {
  const { client, calls } = setup();

  await client.pushDesktopMessage({
    fellowKey: "codex",
    session: { id: "s_2", title: "One-off" },
    message: { id: "m_2", text: "single message", attachments: [] }
  });

  assert.deepEqual(calls.fetch.map((request) => [request.method, request.url]), [
    ["PUT", "https://cloud.example/api/me/fellow-rooms/s_2"],
    ["POST", "https://cloud.example/api/rooms/fellow%3Au_1%3As_2/messages"]
  ]);
  assert.deepEqual(calls.fetch[1].body, {
    bodyMd: "single message",
    attachments: [],
    clientOpId: "op_fellow_msg_s_2_m_2"
  });
});

test("pushAllFellows ensures a stable cloud room for each local fellow", async () => {
  const { client, calls } = setup();

  await client.pushAllFellows();

  assert.deepEqual(calls.fetch.map((request) => [request.method, request.url]), [
    ["PUT", "https://cloud.example/api/me/fellows/codex"],
    ["PUT", "https://cloud.example/api/me/fellows/codex/room"]
  ]);
  assert.deepEqual(calls.fetch[1].body, {
    title: "Codex",
    runtimeKind: "desktop-local"
  });
});

test("pushAllFellows ensures rooms even when local user metadata is missing", async () => {
  const { client, calls } = setup({
    initialSettings: {
      enabled: true,
      token: "tok_1",
      url: "https://cloud.example/",
      user: null
    }
  });

  await client.pushAllFellows();

  assert.deepEqual(calls.fetch.map((request) => [request.method, request.url]), [
    ["PUT", "https://cloud.example/api/me/fellows/codex"],
    ["PUT", "https://cloud.example/api/me/fellows/codex/room"]
  ]);
  assert.deepEqual(calls.fetch[1].body, {
    title: "Codex",
    runtimeKind: "desktop-local"
  });
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
