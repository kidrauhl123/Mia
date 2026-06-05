// Tests for the pure state-machine functions of social.js.
// Loads the IIFE into a vm sandbox to avoid Electron/DOM deps for logic tests.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sessionHistory = require("../src/shared/session-history");

function loadSocial(options = {}) {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "social", "social.js"), "utf8");
  const mockEl = () => ({
    classList: { add() {}, remove() {}, toggle() {} },
    children: [],
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    querySelector() { return mockEl(); },
    querySelectorAll() { return []; },
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html || ""; },
    set textContent(v) {},
    get textContent() { return ""; },
    setAttribute() {},
    getAttribute() { return ""; },
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    cloneNode() { return mockEl(); },
  });
  const mockWindow = {
    requestAnimationFrame: options.requestAnimationFrame,
    mia: {},
    miaBotCommands: require("../src/renderer/bot/bot-commands.js"),
    miaSelfIdentity: require("../packages/shared/self-identity.js"),
    miaSendPipeline: require("../src/shared/send-pipeline.js"),
    miaMarkdown: {
      escapeHtml: (v) => String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;"),
      renderMarkdown: (v) => String(v || ""),
    },
    miaTimeFormat: { formatMessageTime: () => "now" },
  };
  const context = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    localStorage: options.localStorage,
    document: {
      createElement: () => mockEl(),
      getElementById: (id) => options.elementsById?.[id] || mockEl(),
      querySelector: () => mockEl(),
      body: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    navigator: { clipboard: { writeText: async () => {} } },
    Map,
    Set,
    Date,
    JSON,
    setTimeout: () => 0,
    clearTimeout: () => {},
    Promise,
    console,
    String,
    Array,
    Object,
    Boolean,
    parseInt,
    Math,
  });
  vm.runInContext(src, context);
  mockWindow.miaSocial.__mockWindow = mockWindow;
  return mockWindow.miaSocial;
}

function installCloudConversationSource(mockWindow) {
  const root = path.join(__dirname, "..");
  const sharedSpec = fs.readFileSync(path.join(root, "src", "shared", "message-spec.js"), "utf8");
  const sharedAvatarResolve = fs.readFileSync(path.join(root, "packages", "shared", "avatar.js"), "utf8");
  const sharedContact = fs.readFileSync(path.join(root, "packages", "shared", "contact.js"), "utf8");
  const sharedKinds = fs.readFileSync(path.join(root, "src", "shared", "conversation-kinds.js"), "utf8");
  const source = fs.readFileSync(path.join(root, "src", "renderer", "message-sources", "cloud-conversation-source.js"), "utf8");
  const context = vm.createContext({ window: mockWindow, globalThis: mockWindow, console });
  vm.runInContext("globalThis.miaMessageSpec = (function(){ const module = { exports: {} }; " + sharedSpec + "; return module.exports; })();", context);
  vm.runInContext(sharedAvatarResolve, context);
  vm.runInContext("globalThis.miaContact = (function(){ const module = { exports: {} }; " + sharedContact + "; return module.exports; })();", context);
  vm.runInContext(sharedKinds, context);
  vm.runInContext(source, context);
}

function installNameWithBadge(mockWindow) {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "name-with-badge.js"), "utf8");
  const context = vm.createContext({ window: mockWindow, globalThis: mockWindow, document: { createElement: () => ({}) }, console });
  vm.runInContext(source, context);
}

function installSocialGroups(mockWindow) {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "social", "social-groups.js"), "utf8");
  const context = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    document: {
      createElement: () => ({
        className: "",
        set innerHTML(value) { this._html = String(value || ""); },
        get innerHTML() { return this._html || ""; }
      })
    },
    console
  });
  vm.runInContext(source, context);
  mockWindow.miaSocialGroups.attach(mockWindow.miaSocial._internalCtx);
}

async function withMutedConsoleWarn(fn) {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("bootstrapAfterLogin ensures local fellow conversations before listing conversations", async () => {
  const s = loadSocial();
  const calls = [];
  s.initSocialModule({
    getState: () => ({
      runtime: {
        model: { provider: "deepseek", model: "deepseek-chat" },
        effort: { level: "high" },
        permissions: { mode: "yolo" },
        bots: [{ key: "alice", name: "爱丽丝" }]
      }
    }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  s.__mockWindow.mia.social = {
    myUsername: async () => ({ ok: true, data: { id: "u_1", username: "jung" } }),
    listFriends: async () => ({ ok: true, data: { friends: [] } }),
    listFriendRequests: async () => ({ ok: true, data: { requests: [] } }),
    settingsGet: async () => ({}),
    ensureBotSessionConversation: async (botId, body) => {
      calls.push({ kind: "ensure", botId, body });
      return { ok: true, data: { conversation: { id: "botc_u_1_alice", type: "bot" } } };
    },
    saveBotRuntime: async (botId, body) => {
      calls.push({ kind: "runtime", botId, body });
      return { ok: true, data: { binding: { botId, ...body } } };
    },
    listConversations: async () => {
      calls.push({ kind: "listConversations" });
      return { ok: true, data: { conversations: [{ id: "botc_u_1_alice", type: "bot", name: "爱丽丝" }] } };
    },
    listConversationMessages: async () => ({ ok: true, data: { messages: [] } })
  };

  await s.bootstrapAfterLogin();

  assert.deepEqual(calls.map((call) => call.kind), ["ensure", "runtime", "listConversations"]);
  assert.equal(calls[0].botId, "alice");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)), { botId: "alice", title: "爱丽丝", runtimeKind: "desktop-local" });
  assert.equal(calls[1].botId, "alice");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body)), {
    runtimeKind: "desktop-local",
    enabled: true,
    config: {
      agentEngine: "hermes",
      model: "deepseek-chat",
      effortLevel: "high",
      permissionMode: "yolo",
      modelEntries: []
    }
  });
});

test("bootstrapAfterLogin asks untitled loaded conversations to generate titles", async () => {
  const s = loadSocial();
  const titleCandidates = [];
  s.initSocialModule({
    getState: () => ({ runtime: {} }),
    render: () => {},
    els: {},
    appendTransientChat: () => {},
    maybeGenerateConversationTitle: (conversationId) => {
      titleCandidates.push(conversationId);
    }
  });
  s.__mockWindow.mia.social = {
    myUsername: async () => ({ ok: true, data: { id: "u_1", username: "jung" } }),
    listFriends: async () => ({ ok: true, data: { friends: [] } }),
    listFriendRequests: async () => ({ ok: true, data: { requests: [] } }),
    listBots: async () => ({ ok: true, data: { bots: [] } }),
    settingsGet: async () => ({}),
    listConversations: async () => ({ ok: true, data: { conversations: [{ id: "botc_u_1_kongling", type: "bot", name: "空铃" }] } }),
    listConversationMessages: async () => ({ ok: true, data: { messages: [
      { id: "m1", seq: 1, sender_kind: "user", body_md: "你好" },
      { id: "m2", seq: 2, sender_kind: "bot", body_md: "你好，有什么可以帮你的吗？" }
    ] } })
  };

  await s.bootstrapAfterLogin();

  assert.deepEqual(titleCandidates, ["botc_u_1_kongling"]);
});

test("bootstrapAfterLogin paints cached SQLite social data before slow cloud conversations return", async () => {
  const s = loadSocial();
  let renderCount = 0;
  let releaseCloudConversations;
  s.initSocialModule({
    getState: () => ({ runtime: { cloud: { user: { id: "u_1" } } } }),
    render: () => { renderCount += 1; },
    els: {},
    appendTransientChat: () => {},
  });
  s.__mockWindow.mia.social = {
    getCachedSocialBootstrap: async (userId) => ({
      ok: true,
      data: {
        userId,
        conversations: [{ id: "botc_u_1_mia", type: "bot", name: "Mia" }],
        friends: [],
        bots: [{ id: "mia", key: "mia", name: "Mia" }],
        members: {}
      }
    }),
    getCachedConversationMessages: async () => ({
      ok: true,
      data: { messages: [{ id: "m1", seq: 1, sender_kind: "bot", sender_ref: "mia", body_md: "cached hello" }] }
    }),
    myUsername: async () => ({ ok: true, data: { id: "u_1", username: "jung" } }),
    listFriends: async () => ({ ok: true, data: { friends: [] } }),
    listFriendRequests: async () => ({ ok: true, data: { requests: [] } }),
    listBots: async () => ({ ok: true, data: { bots: [] } }),
    settingsGet: async () => ({}),
    listConversations: async () => new Promise((resolve) => {
      releaseCloudConversations = () => resolve({ ok: true, data: { conversations: [{ id: "botc_u_1_mia", type: "bot", name: "Mia" }] } });
    }),
    listConversationMessages: async () => ({ ok: true, data: { messages: [] } }),
  };

  const boot = s.bootstrapAfterLogin();
  await flushMicrotasks();

  assert.equal(s.moduleState.bootstrapped, true);
  assert.deepEqual(s.moduleState.conversations.map((item) => item.id), ["botc_u_1_mia"]);
  assert.equal(s.moduleState.messageCache.get("botc_u_1_mia").messages[0].body_md, "cached hello");
  assert.equal(renderCount, 1);

  releaseCloudConversations();
  await boot;
});

test("bootstrapAfterLogin keeps legacy UUID bot sessions for history but hides them from sidebar", async () => {
  const s = loadSocial();
  const legacy = {
    id: "botc_u_1_9b7c6d5e-1111-4222-8333-123456789abc",
    type: "bot",
    name: "old session",
    decorations: { botId: "mia", sessionId: "9b7c6d5e-1111-4222-8333-123456789abc" }
  };
  const stable = {
    id: "botc_u_1_mia",
    type: "bot",
    name: "Mia",
    decorations: { botId: "mia", sessionId: "mia" }
  };
  s.initSocialModule({
    getState: () => ({ runtime: { cloud: { user: { id: "u_1" } } } }),
    render: () => {},
    els: {},
    appendTransientChat: () => {},
  });
  s.__mockWindow.mia.social = {
    getCachedSocialBootstrap: async (userId) => ({
      ok: true,
      data: { userId, conversations: [legacy, stable], friends: [], bots: [{ id: "mia", name: "Mia" }], members: {} }
    }),
    getCachedConversationMessages: async () => ({ ok: true, data: { messages: [] } }),
    myUsername: async () => ({ ok: true, data: { id: "u_1", username: "jung" } }),
    listFriends: async () => ({ ok: true, data: { friends: [] } }),
    listFriendRequests: async () => ({ ok: true, data: { requests: [] } }),
    listBots: async () => ({ ok: true, data: { bots: [{ id: "mia", name: "Mia" }] } }),
    settingsGet: async () => ({}),
    listConversations: async () => ({ ok: true, data: { conversations: [legacy, stable] } }),
    listConversationMessages: async () => ({ ok: true, data: { messages: [] } }),
  };

  await s.bootstrapAfterLogin();

  assert.deepEqual(s.moduleState.conversations.map((item) => item.id), [
    "botc_u_1_9b7c6d5e-1111-4222-8333-123456789abc",
    "botc_u_1_mia"
  ]);
  assert.equal(s.botConversationForKey("mia").id, "botc_u_1_mia");
  assert.deepEqual(
    sessionHistory
      .sessionConversationsForConversation(stable, s.moduleState.conversations, { messageCache: s.moduleState.messageCache })
      .map((item) => item.id)
      .sort(),
    [
      "botc_u_1_9b7c6d5e-1111-4222-8333-123456789abc",
      "botc_u_1_mia"
    ].sort()
  );
  assert.deepEqual(s.renderSidebarRows().map((row) => row.conversation.id), [
    "botc_u_1_9b7c6d5e-1111-4222-8333-123456789abc",
    "botc_u_1_mia"
  ]);
});

test("renderSidebarRows keeps the active legacy bot session as the sidebar representative", () => {
  const s = loadSocial();
  s.__mockWindow.miaSessionHistory = sessionHistory;
  const legacy = {
    id: "botc_u_1_9b7c6d5e-1111-4222-8333-123456789abc",
    type: "bot",
    name: "提醒工具不可用",
    decorations: { botId: "haha", sessionId: "9b7c6d5e-1111-4222-8333-123456789abc" }
  };
  const stable = {
    id: "botc_u_1_haha",
    type: "bot",
    name: "哈哈哈",
    decorations: { botId: "haha", sessionId: "haha" }
  };
  s.moduleState.conversations = [legacy, stable];
  s.moduleState.activeConversationId = legacy.id;
  s.moduleState.messageCache.set(legacy.id, {
    messages: [{ created_at: "2026-06-02T11:31:00.000Z", body_md: "当前对话里我没有可用的 schedule_* 工具" }],
    maxSeq: 1
  });
  s.moduleState.messageCache.set(stable.id, {
    messages: [{ created_at: "2026-06-02T09:44:00.000Z", body_md: "可以，我已经帮你设置好了。" }],
    maxSeq: 1
  });

  const rows = s.renderSidebarRows();

  assert.equal(rows[0].conversation.id, legacy.id);
  assert.match(rows[0].conversation.lastMessagePreview, /schedule_\*/);
});

test("bootstrapAfterLogin syncs external bot runtime config for web controls", async () => {
  const s = loadSocial();
  const calls = [];
  s.__mockWindow.miaEngineContracts = require("../src/shared/engine-contracts.js");
  s.__mockWindow.miaEngineOptions = {
    externalModelEntries: () => [
      { id: "default", model: "", label: "Codex 默认", provider: "codex" },
      { id: "gpt-5.3-codex", model: "gpt-5.3-codex", label: "GPT-5.3 Codex", provider: "codex" }
    ]
  };
  s.initSocialModule({
    getState: () => ({
      runtime: {
        bots: [{
          key: "codex",
          name: "Codex",
          agentEngine: "codex",
          engineConfig: { model: "gpt-5.3-codex", effortLevel: "xhigh", permissionMode: "readOnly" }
        }]
      }
    }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  s.__mockWindow.mia.social = {
    myUsername: async () => ({ ok: true, data: { id: "u_1", username: "jung" } }),
    listFriends: async () => ({ ok: true, data: { friends: [] } }),
    listFriendRequests: async () => ({ ok: true, data: { requests: [] } }),
    settingsGet: async () => ({}),
    ensureBotSessionConversation: async (botId, body) => {
      calls.push({ kind: "ensure", botId, body });
      return { ok: true, data: { conversation: { id: "botc_u_1_codex", type: "bot" } } };
    },
    saveBotRuntime: async (botId, body) => {
      calls.push({ kind: "runtime", botId, body });
      return { ok: true, data: { binding: { botId, ...body } } };
    },
    listConversations: async () => ({ ok: true, data: { conversations: [] } }),
    listConversationMessages: async () => ({ ok: true, data: { messages: [] } })
  };

  await s.bootstrapAfterLogin();

  assert.equal(calls[1].kind, "runtime");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body.config)), {
    agentEngine: "codex",
    model: "gpt-5.3-codex",
    effortLevel: "xhigh",
    permissionMode: "readOnly",
    modelEntries: [
      { value: "default", label: "Codex 默认", model: "", provider: "codex", providerLabel: "" },
      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", model: "gpt-5.3-codex", provider: "codex", providerLabel: "" }
    ]
  });
});

test("ensureBotConversation upserts the ensured conversation into the sidebar cache", async () => {
  const s = loadSocial();
  const calls = [];
  s.__mockWindow.mia.social = {
    ensureBotSessionConversation: async (botId, body) => {
      calls.push({ botId, body });
      return { ok: true, data: { ok: true, conversation: { id: "botc_u_1_alice", type: "bot", name: "爱丽丝" } } };
    }
  };

  const conversation = await s.ensureBotConversation({ key: "alice", name: "爱丽丝" });

  assert.equal(conversation.id, "botc_u_1_alice");
  assert.equal(s.moduleState.conversations.some((item) => item.id === "botc_u_1_alice"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    botId: "alice",
    body: { botId: "alice", title: "爱丽丝", runtimeKind: "desktop-local" }
  });
});

test("upsertBotConversation caches a cloud-hermes bot conversation", async () => {
  const s = loadSocial();
  const conversation = {
    id: "botc_u_1_alice",
    type: "bot",
    name: "Alice",
    decorations: { botId: "alice", runtimeKind: "cloud-hermes" }
  };
  const saved = s.upsertBotConversation(conversation);
  assert.equal(saved.id, conversation.id);
  assert.equal(s.getConversationById(conversation.id).decorations.runtimeKind, "cloud-hermes");
});

test("botConversationForKey returns an existing cloud-hermes bot conversation", async () => {
  const s = loadSocial();
  s.upsertBotConversation({
    id: "botc_u_1_alice",
    type: "bot",
    name: "Alice",
    decorations: { botId: "alice", runtimeKind: "cloud-hermes" }
  });
  const conversation = s.botConversationForKey("alice");
  assert.equal(conversation.id, "botc_u_1_alice");
  assert.equal(conversation.decorations.runtimeKind, "cloud-hermes");
});

test("selecting a bot session stores it as the sidebar representative for that bot", () => {
  const store = {};
  const s = loadSocial();
  s.__mockWindow.miaSessionHistory = sessionHistory;
  s.__mockWindow.localStorage = {
    getItem: (key) => store[key] || "",
    setItem: (key, value) => { store[key] = String(value); }
  };
  s.initSocialModule({
    getState: () => ({ runtime: {} }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.conversations = [
    {
      id: "botc_u_1_first",
      type: "bot",
      decorations: { botId: "nhnh" },
      updatedAt: "2026-01-03T00:00:00.000Z"
    },
    {
      id: "botc_u_1_last-selected",
      type: "bot",
      decorations: { botId: "nhnh" },
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  ];
  s.moduleState.messageCache.set("botc_u_1_first", {
    messages: [{ created_at: "2026-01-03T00:00:00.000Z", body_md: "newer" }],
    maxSeq: 1
  });
  s.moduleState.messageCache.set("botc_u_1_last-selected", {
    messages: [{ created_at: "2026-01-01T00:00:00.000Z", body_md: "selected" }],
    maxSeq: 1
  });

  s.setActiveConversationId("botc_u_1_last-selected");

  assert.equal(s.botConversationForKey("nhnh").id, "botc_u_1_last-selected");
  assert.equal(s.renderSidebarRows()[0].conversation.id, "botc_u_1_last-selected");
  assert.equal(JSON.parse(store["mia.lastBotConversationByKey"]).nhnh, "botc_u_1_last-selected");
});

test("bootstrapAfterLogin warns when bot conversation ensure returns ok false", async () => {
  const s = loadSocial();
  const calls = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    s.initSocialModule({
      getState: () => ({ runtime: { bots: [{ key: "alice", name: "爱丽丝" }] } }),
      render: () => {},
      els: {},
      appendTransientChat: () => {}
    });
    s.__mockWindow.mia.social = {
      myUsername: async () => ({ ok: true, data: { id: "u_1", username: "jung" } }),
      listFriends: async () => ({ ok: true, data: { friends: [] } }),
      listFriendRequests: async () => ({ ok: true, data: { requests: [] } }),
      settingsGet: async () => ({}),
      ensureBotSessionConversation: async (botId) => {
        calls.push({ kind: "ensure", botId });
        return { ok: false, error: "boom" };
      },
      listConversations: async () => {
        calls.push({ kind: "listConversations" });
        return { ok: true, data: { conversations: [] } };
      },
      listConversationMessages: async () => ({ ok: true, data: { messages: [] } })
    };

    await s.bootstrapAfterLogin();
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(calls.map((call) => call.kind), ["ensure", "listConversations"]);
  assert.equal(warnings.some((args) => args.some((part) => String(part).includes("alice") || String(part).includes("boom"))), true);
});

test("renderSidebarRows: dm conversation → private-conversation with otherUser resolved", () => {
  const s = loadSocial();
  s.moduleState.myUserId = "u_alice";
  s.moduleState.friends = [{ id: "u_bob", username: "bob", account: "bob" }];
  s.moduleState.conversations = [{ id: "dm:u_alice:u_bob", type: "dm", name: null, updatedAt: "2026-05-21T20:00:00.000Z" }];
  s.moduleState.messageCache.set("dm:u_alice:u_bob", {
    messages: [{ id: "m1", seq: 1, body_md: "hi", created_at: "2026-05-21T20:01:00.000Z" }],
    maxSeq: 1,
  });
  const rows = s.renderSidebarRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "private-conversation");
  assert.equal(rows[0].conversation.otherUser.username, "bob");
  assert.equal(rows[0].conversation.lastMessagePreview, "hi");
});

test("renderSidebarRows carries cloud pin state for sidebar sorting", () => {
  const s = loadSocial();
  s.moduleState.myUserId = "u_alice";
  s.moduleState.friends = [{ id: "u_bob", username: "bob", account: "bob" }];
  s.moduleState.cloudSettings = {
    pins: ["dm:u_alice:u_bob"],
    readMarks: {},
    appearance: {},
    updatedAt: "2026-05-21T20:02:00.000Z"
  };
  s.moduleState.conversations = [{ id: "dm:u_alice:u_bob", type: "dm", name: null, updatedAt: "2026-05-21T20:00:00.000Z" }];

  const rows = s.renderSidebarRows();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].pinned, true);
  assert.equal(rows[0].pinnedAt, "2026-05-21T20:02:00.000Z");
});

test("renderSidebarRows uses the last rendered message time instead of metadata-only updates", () => {
  const s = loadSocial();
  s.moduleState.myUserId = "u_alice";
  s.moduleState.friends = [{ id: "u_bob", username: "bob", account: "bob" }];
  s.moduleState.conversations = [{ id: "dm:u_alice:u_bob", type: "dm", name: null, updatedAt: "2026-05-21T20:23:00.000Z" }];
  s.moduleState.messageCache.set("dm:u_alice:u_bob", {
    messages: [{ id: "m1", seq: 1, body_md: "visible", created_at: "2026-05-21T20:01:00.000Z" }],
    maxSeq: 1,
  });

  const rows = s.renderSidebarRows();

  assert.equal(rows[0].conversation.lastMessagePreview, "visible");
  assert.equal(rows[0].updatedAt, new Date("2026-05-21T20:01:00.000Z").getTime());
});

test("manual unread survives settings responses that omit local override bags", async () => {
  const s = loadSocial();
  const writes = [];
  s.__mockWindow.miaUnread = require("../src/shared/unread");
  s.__mockWindow.mia.social = {
    settingsPut: async (body) => {
      writes.push(body);
      return {
        pins: body.pins,
        readMarks: body.readMarks,
        appearance: body.appearance,
        version: writes.length,
        updatedAt: "2026-05-21T20:02:00.000Z"
      };
    }
  };
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });

  await s.setConversationManuallyUnread("dm:u_a:u_b", true);

  assert.equal(s.getUnreadForConversation("dm:u_a:u_b"), 1);
  assert.equal(writes[0].unreadOverrides["dm:u_a:u_b"], true);
  s.applyCloudSettings({ pins: [], readMarks: {}, appearance: {}, version: 2, updatedAt: "2026-05-21T20:03:00.000Z" });
  assert.equal(s.getUnreadForConversation("dm:u_a:u_b"), 1);

  await s.setConversationManuallyUnread("dm:u_a:u_b", false);
  s.applyCloudSettings({ pins: [], readMarks: {}, appearance: {}, version: 3, updatedAt: "2026-05-21T20:04:00.000Z" });

  assert.equal(s.getUnreadForConversation("dm:u_a:u_b"), 0);
  assert.equal(Boolean(s.moduleState.cloudSettings.unreadOverrides["dm:u_a:u_b"]), false);
});

test("opening a manually unread conversation clears the unread override", async () => {
  const s = loadSocial();
  const writes = [];
  s.__mockWindow.miaUnread = require("../src/shared/unread");
  s.__mockWindow.mia.social = {
    settingsPut: async (body) => {
      writes.push(body);
      return {
        pins: body.pins,
        readMarks: body.readMarks,
        appearance: body.appearance,
        version: writes.length
      };
    }
  };
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.messageCache.set("dm:u_a:u_b", {
    messages: [{ id: "m1", seq: 4, body_md: "hello" }],
    maxSeq: 4
  });
  await s.setConversationManuallyUnread("dm:u_a:u_b", true);
  assert.equal(s.getUnreadForConversation("dm:u_a:u_b"), 1);

  s.setActiveConversationId("dm:u_a:u_b");

  assert.equal(s.getUnreadForConversation("dm:u_a:u_b"), 0);
  assert.equal(s.moduleState.cloudSettings.readMarks["dm:u_a:u_b"], 4);
  assert.equal(Boolean(s.moduleState.cloudSettings.unreadOverrides["dm:u_a:u_b"]), false);
  assert.equal(Boolean(writes.at(-1).unreadOverrides["dm:u_a:u_b"]), false);
});

test("handleCloudEvent social.friend_request_received appends incoming", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.handleCloudEvent({
    type: "social.friend_request_received",
    payload: {
      request: {
        id: "fr_1",
        from_user: "u_x",
        to_user: "u_me",
        status: "pending",
        from: { id: "u_x", username: "x" },
      },
    },
  });
  assert.equal(s.moduleState.incomingRequests.length, 1);
  assert.equal(s.moduleState.incomingRequests[0].from.username, "x");
});

test("handleCloudEvent social.friend_added adds conversation + friend, removes from outgoing", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.outgoingRequests = [{ id: "fr_2", to_user: "u_b", status: "pending" }];
  s.handleCloudEvent({
    type: "social.friend_added",
    payload: {
      friend: { id: "u_b", username: "b" },
      conversation: { id: "dm:u_a:u_b", updatedAt: "2026-05-21T20:00:00.000Z" },
    },
  });
  assert.equal(s.moduleState.friends.find((f) => f.id === "u_b").username, "b");
  assert.equal(s.moduleState.conversations.find((r) => r.id === "dm:u_a:u_b").id, "dm:u_a:u_b");
  assert.equal(s.moduleState.outgoingRequests.length, 0);
  assert.ok(s.moduleState.messageCache.has("dm:u_a:u_b"));
});

test("handleCloudEvent social.conversation_invited adds the conversation to conversations list", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.handleCloudEvent({
    type: "social.conversation_invited",
    payload: { conversation: { id: "g_xxx", name: "Squad", updatedAt: "2026-05-21T20:00:00.000Z" }, invitedBy: { id: "u_a", username: "alice" } }
  });
  assert.ok(s.moduleState.conversations.find((r) => r.id === "g_xxx"));
});

test("handleCloudEvent conversation.updated upserts unknown conversations", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });

  s.handleCloudEvent({
    type: "conversation.updated",
    payload: { conversation: { id: "botc_u_1_alice", type: "bot", name: "爱丽丝" } }
  });

  assert.equal(s.moduleState.conversations.some((conversation) => conversation.id === "botc_u_1_alice"), true);
  assert.equal(s.moduleState.messageCache.has("botc_u_1_alice"), true);
});

test("renderSidebarRows includes group conversations with type group-conversation", () => {
  const s = loadSocial();
  s.moduleState.myUserId = "u_me";
  s.moduleState.conversations = [
    { id: "dm:u_me:u_a", type: "dm", updatedAt: "2026-05-21T20:00:00.000Z", name: null },
    { id: "g_squad", type: "group", updatedAt: "2026-05-21T21:00:00.000Z", name: "Squad" },
    { id: "botc_u_me_mia", type: "bot", updatedAt: "2026-05-21T22:00:00.000Z", name: "Mia" }
  ];
  s.moduleState.friends = [{ id: "u_a", username: "alice" }];
  const rows = s.renderSidebarRows();
  assert.equal(rows.length, 3);
  const groupRow = rows.find((r) => r.type === "group-conversation");
  assert.equal(groupRow.conversation.name, "Squad");
  const fellowRow = rows.find((item) => item.conversation?.id === "botc_u_me_mia");
  assert.equal(fellowRow.type, "private-conversation");
});

test("renderSidebarRows fetches missing group members so sidebar avatars can hydrate", () => {
  const s = loadSocial();
  const fetched = [];
  s.__mockWindow.miaSocialGroups = {
    fetchAndCacheConversationMembers(conversationId) {
      fetched.push(conversationId);
    }
  };
  s.moduleState.myUserId = "u_me";
  s.moduleState.conversations = [
    { id: "g_missing", type: "group", updatedAt: "2026-05-21T21:00:00.000Z", name: "Squad" },
    { id: "g_cached", type: "group", updatedAt: "2026-05-21T20:00:00.000Z", name: "Cached" }
  ];
  s._internalCtx.conversationMembersCache.set("g_cached", [
    { member_kind: "user", member_ref: "u_me", identity: { displayName: "我", avatar: { image: "", crop: null } } }
  ]);

  const rows = s.renderSidebarRows();

  assert.deepEqual(rows.map((row) => row.type), ["group-conversation", "group-conversation"]);
  assert.deepEqual(fetched, ["g_missing"]);
});

test("sendInActiveGroupConversation uses the unified cloud-conversation send path", async () => {
  const s = loadSocial();
  const posted = [];
  s.__mockWindow.mia.social = {
    postConversationMessage: async (conversationId, body) => {
      posted.push({ conversationId, body });
      return { ok: true, data: { message: { id: "m1", seq: 1, body_md: body.bodyMd } } };
    }
  };
  s.moduleState.activeConversationId = "g_missing_module";
  s.moduleState.conversations = [{ id: "g_missing_module", type: "group", name: "Squad" }];
  s.moduleState.messageCache.set("g_missing_module", { messages: [], maxSeq: 0 });

  await withMutedConsoleWarn(() => s.sendInActiveGroupConversation("  hello group  "));

  assert.equal(posted.length, 1);
  assert.equal(posted[0].conversationId, "g_missing_module");
  assert.equal(posted[0].body.bodyMd, "hello group");
  assert.equal(s.moduleState.messageCache.get("g_missing_module").messages.length, 1);
});

test("sendInActiveGroupConversation delegates to the unified cloud-conversation send path", async () => {
  const s = loadSocial();
  const posted = [];
  let attached = null;
  s.__mockWindow.mia.social = {
    postConversationMessage: async (conversationId, body) => {
      posted.push({ conversationId, body });
      return { ok: true, data: { message: { id: "m1", seq: 1, body_md: body.bodyMd } } };
    }
  };
  s.__mockWindow.miaSocialGroups = {
    attach(ctx) { attached = ctx; },
    sendInActiveGroupConversation() { throw new Error("groups module not attached"); }
  };
  s.moduleState.activeConversationId = "g_bad_module";
  s.moduleState.conversations = [{ id: "g_bad_module", type: "group", name: "Squad" }];
  s.moduleState.messageCache.set("g_bad_module", { messages: [], maxSeq: 0 });

  await withMutedConsoleWarn(() => s.sendInActiveGroupConversation("hello after fallback"));

  assert.equal(attached, null);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].conversationId, "g_bad_module");
  assert.equal(posted[0].body.bodyMd, "hello after fallback");
  assert.equal(s.moduleState.messageCache.get("g_bad_module").messages.length, 1);
});

test("sendInActiveConversation shows outgoing cloud messages before the network reply resolves", async () => {
  const s = loadSocial();
  const post = deferred();
  const posted = [];
  s.moduleState.myUserId = "u_me";
  s.__mockWindow.mia.social = {
    postConversationMessage: async (conversationId, body) => {
      posted.push({ conversationId, body });
      return post.promise;
    }
  };
  s.moduleState.activeConversationId = "g_fast";
  s.moduleState.conversations = [{ id: "g_fast", type: "group", name: "Fast" }];
  s.moduleState.messageCache.set("g_fast", { messages: [], maxSeq: 0 });
  s._internalCtx.conversationMembersCache.set("g_fast", [
    { member_kind: "bot", member_ref: "codex", bot_name: "Codex" }
  ]);

  const sendPromise = s.sendInActiveConversation("hello immediately");
  const entry = s.moduleState.messageCache.get("g_fast");

  assert.equal(posted.length, 1);
  assert.equal(entry.messages.length, 1);
  assert.match(entry.messages[0].id, /^local_/);
  assert.equal(entry.messages[0].status, "sending");
  assert.equal(entry.messages[0].body_md, "hello immediately");
  assert.equal(s.moduleState.cloudAgentRunsByConversation.has("g_fast"), false);

  post.resolve({
    ok: true,
    data: { message: { id: "m_server", seq: 1, sender_kind: "user", sender_ref: "u_me", body_md: "hello immediately" } }
  });
  await sendPromise;

  assert.deepEqual(entry.messages.map((m) => m.id), ["m_server"]);
  assert.equal(entry.maxSeq, 1);
});

test("sendInActiveConversation reconciles the websocket echo before the POST reply resolves", async () => {
  const s = loadSocial();
  const post = deferred();
  const posted = [];
  s.moduleState.myUserId = "u_me";
  s.__mockWindow.mia.social = {
    postConversationMessage: async (conversationId, body) => {
      posted.push({ conversationId, body });
      return post.promise;
    }
  };
  s.moduleState.activeConversationId = "g_echo";
  s.moduleState.conversations = [{ id: "g_echo", type: "group", name: "Echo" }];
  s.moduleState.messageCache.set("g_echo", { messages: [], maxSeq: 0 });

  const sendPromise = s.sendInActiveConversation("hello once");
  const entry = s.moduleState.messageCache.get("g_echo");
  const localTurnId = entry.messages[0]?.turn_id || "server_echo_turn";

  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "g_echo",
      message: {
        id: "m_server_echo",
        seq: 1,
        turn_id: localTurnId,
        sender_kind: "user",
        sender_ref: "u_me",
        body_md: "hello once"
      }
    }
  });

  assert.deepEqual(entry.messages.map((m) => m.id), ["m_server_echo"]);
  assert.equal(entry.messages[0]._localPending, undefined);
  assert.equal(entry.maxSeq, 1);

  post.resolve({
    ok: true,
    data: {
      message: {
        id: "m_server_echo",
        seq: 1,
        turn_id: localTurnId,
        sender_kind: "user",
        sender_ref: "u_me",
        body_md: "hello once"
      }
    }
  });
  await sendPromise;

  assert.deepEqual(entry.messages.map((m) => m.id), ["m_server_echo"]);
  assert.equal(posted[0].body.turnId, localTurnId);
});

test("sendInActiveConversation reconciles a self websocket echo even when turn_id is absent", async () => {
  const s = loadSocial();
  const post = deferred();
  s.moduleState.myUserId = "u_me";
  s.__mockWindow.mia.social = {
    postConversationMessage: async () => post.promise
  };
  s.moduleState.activeConversationId = "g_echo_missing_turn";
  s.moduleState.conversations = [{ id: "g_echo_missing_turn", type: "group", name: "Echo" }];
  s.moduleState.messageCache.set("g_echo_missing_turn", { messages: [], maxSeq: 0 });

  const sendPromise = s.sendInActiveConversation("hello once");
  const entry = s.moduleState.messageCache.get("g_echo_missing_turn");

  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "g_echo_missing_turn",
      message: {
        id: "m_server_echo_no_turn",
        seq: 1,
        sender_kind: "user",
        sender_ref: "u_me",
        body_md: "hello once"
      }
    }
  });

  assert.deepEqual(entry.messages.map((m) => m.id), ["m_server_echo_no_turn"]);
  assert.equal(entry.messages[0]._localPending, undefined);
  assert.equal(entry.maxSeq, 1);

  post.resolve({
    ok: true,
    data: {
      message: {
        id: "m_server_echo_no_turn",
        seq: 1,
        sender_kind: "user",
        sender_ref: "u_me",
        body_md: "hello once"
      }
    }
  });
  await sendPromise;

  assert.deepEqual(entry.messages.map((m) => m.id), ["m_server_echo_no_turn"]);
});

test("sendInActiveConversation keeps a failed outgoing cloud message visible", async () => {
  const s = loadSocial();
  const posted = [];
  s.moduleState.myUserId = "u_me";
  s.__mockWindow.mia.social = {
    postConversationMessage: async (conversationId, body) => {
      posted.push({ conversationId, body });
      return { ok: false, error: "network down" };
    }
  };
  s.moduleState.activeConversationId = "g_failed";
  s.moduleState.conversations = [{ id: "g_failed", type: "group", name: "Failed" }];
  s.moduleState.messageCache.set("g_failed", { messages: [], maxSeq: 0 });

  await withMutedConsoleWarn(() => s.sendInActiveConversation("爱丽丝你帮我找下AI领域最新新闻"));

  const entry = s.moduleState.messageCache.get("g_failed");
  assert.equal(posted.length, 1);
  assert.equal(entry.messages.length, 1);
  assert.equal(entry.messages[0].body_md, "爱丽丝你帮我找下AI领域最新新闻");
  assert.equal(entry.messages[0].status, "error");
  assert.equal(entry.messages[0].error, "network down");
});

test("renderConversationChat marks failed outgoing cloud messages", async () => {
  const s = loadSocial();
  s.moduleState.myUserId = "u_me";
  s.__mockWindow.mia.social = {
    postConversationMessage: async () => ({ ok: false, error: "network down" })
  };
  s.moduleState.activeConversationId = "botc_u_me_mia";
  s.moduleState.conversations = [{ id: "botc_u_me_mia", type: "bot", name: "Mia" }];
  s.moduleState.messageCache.set("botc_u_me_mia", { messages: [], maxSeq: 0 });

  await withMutedConsoleWarn(() => s.sendInActiveConversation("hello failed"));

  const chat = {
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
  s.renderConversationChat(chat);

  assert.equal(chat.children.length, 1);
  assert.match(chat.children[0].innerHTML, /message-send-status is-error/);
  assert.match(chat.children[0].innerHTML, /发送失败/);
  assert.match(chat.children[0].innerHTML, /title="network down"/);
});

test("renderConversationChat resolves self and fellow avatars from one contact context", () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  s.__mockWindow.miaAvatar = {
    avatarThumbBackgroundStyle: (image, _crop, color) => image
      ? `background-color:transparent;background-image:url('${image}');`
      : `background-color:${color || "#5e5ce6"};`
  };
  s.initSocialModule({
    getState: () => ({
      runtime: {
        cloud: {
          user: {
            id: "u_me",
            username: "boss_cloud",
            avatarImage: "data:cloud-avatar",
            avatarColor: "#ff0000"
          }
        },
        user: {
          displayName: "Boss",
          avatarImage: "data:self-avatar",
          avatarCrop: { x: 50, y: 50, zoom: 1 },
          avatarColor: "#111827"
        },
        bots: [{
          key: "mia",
          name: "Mia",
          avatarImage: "data:mia-avatar",
          avatarCrop: { x: 57, y: 8, zoom: 1.5 },
          color: "#5e5ce6"
        }]
      }
    }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.myUserId = "u_me";
  s.moduleState.myUsername = "boss";
  s.moduleState.activeConversationId = "botc_u_me_mia";
  s.moduleState.conversations = [{ id: "botc_u_me_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } }];
  s.moduleState.messageCache.set("botc_u_me_mia", {
    maxSeq: 2,
    messages: [
      { id: "m_user", seq: 1, sender_kind: "user", sender_ref: "u_me", body_md: "hi", created_at: "" },
      { id: "m_fellow", seq: 2, sender_kind: "bot", sender_ref: "mia", body_md: "hello", created_at: "" }
    ]
  });
  const chat = {
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };

  s.renderConversationChat(chat);

  assert.equal(chat.children.length, 2);
  assert.match(chat.children[0].innerHTML, /data:self-avatar/);
  assert.match(chat.children[1].innerHTML, /data:mia-avatar/);
  assert.doesNotMatch(chat.children[0].innerHTML, /data:cloud-avatar/);
});

test("renderConversationChat uses cloud fellow avatar when no local fellow exists", () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  s.__mockWindow.miaAvatar = {
    avatarThumbBackgroundStyle: (image, _crop, color) => image
      ? `background-color:transparent;background-image:url('${image}');`
      : `background-color:${color || "#5e5ce6"};`
  };
  s.initSocialModule({
    getState: () => ({ runtime: { user: { avatarImage: "data:self-avatar" } } }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.myUserId = "u_me";
  s.moduleState.myUsername = "boss";
  s.moduleState.bots = [{ id: "mia", name: "Mia", avatarImage: "data:cloud-mia-avatar", color: "#2563eb" }];
  s.moduleState.activeConversationId = "botc_u_me_mia";
  s.moduleState.conversations = [{ id: "botc_u_me_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } }];
  s.moduleState.messageCache.set("botc_u_me_mia", {
    maxSeq: 1,
    messages: [{ id: "m_fellow", seq: 1, sender_kind: "bot", sender_ref: "mia", body_md: "hello", created_at: "" }]
  });
  const chat = {
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };

  s.renderConversationChat(chat);

  assert.equal(chat.children.length, 1);
  assert.match(chat.children[0].innerHTML, /data:cloud-mia-avatar/);
  assert.doesNotMatch(chat.children[0].innerHTML, /asset:mia/);
});

test("renderConversationChat renders private cloud sender status badge", () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  installNameWithBadge(s.__mockWindow);
  s.__mockWindow.miaAvatar = {
    avatarThumbBackgroundStyle: (image, _crop, color) => image
      ? `background-color:transparent;background-image:url('${image}');`
      : `background-color:${color || "#5e5ce6"};`
  };
  s.initSocialModule({ getState: () => ({ runtime: {} }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.bots = [{
    id: "mia",
    name: "Mia",
    statusBadge: { kind: "emoji", emoji: "⭐", label: "Premium" }
  }];
  s.moduleState.activeConversationId = "botc_u_me_mia";
  s.moduleState.conversations = [{ id: "botc_u_me_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } }];
  s.moduleState.messageCache.set("botc_u_me_mia", {
    maxSeq: 1,
    messages: [{ id: "m_badge", seq: 1, sender_kind: "bot", sender_ref: "mia", body_md: "hello", created_at: "" }]
  });
  const chat = {
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };

  s.renderConversationChat(chat);

  assert.equal(chat.children.length, 1);
  assert.match(chat.children[0].innerHTML, /name-with-badge/);
  assert.match(chat.children[0].innerHTML, /name-with-badge-badge-emoji/);
  assert.match(chat.children[0].innerHTML, /⭐/);
});

test("renderConversationChat renders group sender status badge", () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  installNameWithBadge(s.__mockWindow);
  installSocialGroups(s.__mockWindow);
  s.__mockWindow.miaMemberColor = { memberAccentColor: () => "#2563eb" };
  s.__mockWindow.miaAvatar = {
    avatarThumbBackgroundStyle: (image, _crop, color) => image
      ? `background-color:transparent;background-image:url('${image}');`
      : `background-color:${color || "#5e5ce6"};`
  };
  s.initSocialModule({ getState: () => ({ runtime: {} }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.activeConversationId = "g_badge";
  s.moduleState.conversations = [{ id: "g_badge", type: "group", name: "Squad" }];
  s._internalCtx.conversationMembersCache.set("g_badge", [{
    member_kind: "bot",
    member_ref: "mia",
    identity: {
      kind: "bot",
      id: "mia",
      displayName: "Mia",
      avatar: { image: "", crop: null, color: "#5e5ce6", text: "Mi" },
      statusBadge: { kind: "emoji", emoji: "⭐", label: "Premium" }
    }
  }]);
  s.moduleState.messageCache.set("g_badge", {
    maxSeq: 1,
    messages: [{ id: "m_group_badge", seq: 1, sender_kind: "bot", sender_ref: "mia", body_md: "hello", created_at: "" }]
  });
  const chat = {
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };

  s.renderConversationChat(chat);

  assert.equal(chat.children.length, 1);
  assert.match(chat.children[0].innerHTML, /name-with-badge/);
  assert.match(chat.children[0].innerHTML, /name-with-badge-badge-emoji/);
  assert.match(chat.children[0].innerHTML, /⭐/);
});

test("renderConversationChat self identity uses the cloud account, not a stale local profile name", () => {
  // The local profile (mia-user.json) is one global file shared across every
  // account; the signed-in cloud account is canonical. A leftover local "Boss"
  // must not shadow the current account. Real bug: account "755439" (cloud
  // username, no display_name) showed the previous account's local "Boss".
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  s.__mockWindow.miaAvatar = {
    avatarThumbBackgroundStyle: (image, _crop, color) => image
      ? `background-color:transparent;background-image:url('${image}');`
      : `background-color:${color || "#5e5ce6"};`
  };
  s.initSocialModule({
    getState: () => ({
      runtime: {
        cloud: { user: { id: "u_me", username: "755439" } },
        user: { displayName: "Boss", avatarText: "B", avatarColor: "#111827", avatarImage: "" }
      }
    }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.myUserId = "u_me";
  s.moduleState.myUsername = "755439";
  s.moduleState.activeConversationId = "botc_u_me_mia";
  s.moduleState.conversations = [{ id: "botc_u_me_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } }];
  s.moduleState.messageCache.set("botc_u_me_mia", {
    maxSeq: 1,
    messages: [{ id: "m_user", seq: 1, sender_kind: "user", sender_ref: "u_me", body_md: "hi", created_at: "" }]
  });
  const chat = {
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };

  s.renderConversationChat(chat);

  assert.equal(chat.children.length, 1);
  assert.match(chat.children[0].innerHTML, /title="755439"/);
  assert.match(chat.children[0].innerHTML, />75<\/div>/);
  assert.doesNotMatch(chat.children[0].innerHTML, /assets\/avatars/);
  assert.doesNotMatch(chat.children[0].innerHTML, /title="Boss"/);
  assert.doesNotMatch(chat.children[0].innerHTML, />Bo<\/div>/);
});

test("sendInActiveConversation posts group mentions in cloud fellow format", async () => {
  const s = loadSocial();
  const posted = [];
  s.moduleState.myUserId = "u_me";
  s.__mockWindow.mia.social = {
    postConversationMessage: async (conversationId, body) => {
      posted.push({ conversationId, body });
      return { ok: true, data: { message: { id: "m1", seq: 1, sender_kind: "user", sender_ref: "u_me", body_md: body.bodyMd } } };
    }
  };
  s.moduleState.activeConversationId = "g_mentions";
  s.moduleState.conversations = [{ id: "g_mentions", type: "group", name: "Mentions" }];
  s.moduleState.messageCache.set("g_mentions", { messages: [], maxSeq: 0 });
  s._internalCtx.conversationMembersCache.set("g_mentions", [
    { member_kind: "bot", member_ref: "codex", bot_name: "Codex" }
  ]);

  await s.sendInActiveConversation("hi @Codex");

  assert.equal(posted.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(posted[0].body.mentions)), [
    { kind: "bot", botId: "codex" }
  ]);
});

test("handleCloudEvent conversation.message_appended appends and tracks maxSeq", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: { conversationId: "dm:u_a:u_b", message: { id: "m1", seq: 1, body_md: "hi", created_at: "2026-05-21T20:01:00.000Z" } },
  });
  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: { conversationId: "dm:u_a:u_b", message: { id: "m2", seq: 2, body_md: "yo", created_at: "2026-05-21T20:02:00.000Z" } },
  });
  // duplicate (same id) shouldn't double-append
  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: { conversationId: "dm:u_a:u_b", message: { id: "m2", seq: 2, body_md: "yo", created_at: "2026-05-21T20:02:00.000Z" } },
  });
  const entry = s.moduleState.messageCache.get("dm:u_a:u_b");
  assert.equal(entry.messages.length, 2);
  assert.equal(entry.maxSeq, 2);
});

test("handleCloudEvent cloud_agent_run events track transient conversation streaming state", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", hermesRunId: "hr_1", botId: "mia" },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "message.delta", delta: "hello " } },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "tool.started", tool: "shell" } },
  });
  const run = s.moduleState.cloudAgentRunsByConversation.get("botc_u_a_mia");
  assert.equal(run.hermesRunId, "hr_1");
  assert.equal(run.text, "hello ");
  assert.equal(run.tools.map((tool) => tool.name).join(","), "shell");
});

test("handleCloudEvent tracks pending agent permission requests on the active run", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "botc_u_a_mia", runId: "car_perm", botId: "mia" },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: {
      conversationId: "botc_u_a_mia",
      runId: "car_perm",
      event: {
        type: "permission_request",
        requestId: "perm_1",
        engine: "codex",
        toolName: "shell",
        title: "Codex 想执行命令",
        preview: "npm test"
      }
    },
  });

  const run = s.moduleState.cloudAgentRunsByConversation.get("botc_u_a_mia");
  assert.equal(run.pendingPermissions.length, 1);
  assert.equal(run.pendingPermissions[0].requestId, "perm_1");
  assert.equal(s.moduleState.pendingPermissionsById.get("perm_1").preview, "npm test");

  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: {
      conversationId: "botc_u_a_mia",
      runId: "car_perm",
      event: { type: "permission_resolved", requestId: "perm_1" }
    },
  });
  assert.equal(run.pendingPermissions.length, 0);
  assert.equal(s.moduleState.pendingPermissionsById.has("perm_1"), false);
});

test("permission banner title omits repeated actor names", () => {
  const s = loadSocial();
  const compact = s._internalCtx.compactPermissionTitle;
  s.moduleState.bots = [{ key: "codex", name: "空铃" }];

  assert.equal(compact({ title: "Codex 想执行命令", botId: "codex" }), "空铃想执行命令");
  assert.equal(compact({ title: "Codex 想执行命令" }), "Codex想执行命令");
  assert.equal(compact({ title: "空铃 想使用 Bash" }), "空铃想使用 Bash");
  assert.equal(compact({ title: "请求扩展权限" }), "请求扩展权限");
  assert.equal(compact({ title: "需要权限审批" }), "请求执行权限");
});

test("successful permission decision removes the pending banner after one click", async () => {
  const disabled = [];
  const banner = {
    dataset: { requestId: "perm_1" },
    addEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    set innerHTML(value) { this._html = value; },
    get innerHTML() { return this._html || ""; },
    querySelectorAll(selector) {
      assert.equal(selector, "button[data-permission-decision]");
      return disabled;
    }
  };
  const s = loadSocial({ elementsById: { agentPermissionBanner: banner } });
  disabled.push({ disabled: false }, { disabled: false });
  const respondCalls = [];
  s.__mockWindow.mia.respondChatPermission = async (payload) => {
    respondCalls.push(payload);
    return { ok: true };
  };
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.activeConversationId = "botc_u_a_mia";
  const run = s._internalCtx.cloudRunFor("botc_u_a_mia", "car_perm");
  s._internalCtx.addRunPermission(run, { requestId: "perm_1", title: "Codex 想执行命令" });
  s._internalCtx.renderAgentPermissionBanner();

  await s._internalCtx.submitPermissionDecision({ dataset: { permissionDecision: "allow_once" } });

  assert.deepEqual(JSON.parse(JSON.stringify(respondCalls)), [{ requestId: "perm_1", decision: "allow_once" }]);
  assert.equal(run.pendingPermissions.length, 0);
  assert.equal(s.moduleState.pendingPermissionsById.has("perm_1"), false);
  assert.deepEqual(disabled.map((button) => button.disabled), [true, true]);
});

test("permission decision handles primary pointerdown before click fallback", async () => {
  const listeners = {};
  const disabled = [];
  const button = {
    dataset: { permissionDecision: "deny" },
    disabled: false,
    closest(selector) {
      return selector === "button[data-permission-decision]" ? this : null;
    }
  };
  const banner = {
    dataset: { requestId: "perm_1" },
    addEventListener(type, handler, options) {
      listeners[type] = { handler, options };
    },
    classList: { add() {}, remove() {}, contains() { return false; } },
    set innerHTML(value) { this._html = value; },
    get innerHTML() { return this._html || ""; },
    querySelectorAll(selector) {
      assert.equal(selector, "button[data-permission-decision]");
      return disabled;
    }
  };
  const s = loadSocial({ elementsById: { agentPermissionBanner: banner } });
  disabled.push(button);
  const respondCalls = [];
  s.__mockWindow.mia.respondChatPermission = async (payload) => {
    respondCalls.push(payload);
    return { ok: true };
  };
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.activeConversationId = "botc_u_a_mia";
  const run = s._internalCtx.cloudRunFor("botc_u_a_mia", "car_perm");
  s._internalCtx.addRunPermission(run, { requestId: "perm_1", title: "Codex 想执行命令" });
  s._internalCtx.renderAgentPermissionBanner();

  assert.equal(typeof listeners.pointerdown?.handler, "function");
  assert.equal(listeners.pointerdown.options, true);
  const eventCalls = [];
  await listeners.pointerdown.handler({
    type: "pointerdown",
    button: 0,
    target: button,
    preventDefault() { eventCalls.push("prevent"); },
    stopPropagation() { eventCalls.push("stop"); }
  });

  assert.deepEqual(eventCalls, ["prevent", "stop"]);
  assert.deepEqual(JSON.parse(JSON.stringify(respondCalls)), [{ requestId: "perm_1", decision: "deny" }]);
});

test("permission banner preserves bottom stickiness when it changes composer height", () => {
  const scheduled = [];
  const banner = {
    dataset: {},
    addEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    set innerHTML(value) { this._html = value; },
    get innerHTML() { return this._html || ""; }
  };
  const chat = { scrollTop: 730, scrollHeight: 1000, clientHeight: 220 };
  const s = loadSocial({
    elementsById: { agentPermissionBanner: banner, chat },
    requestAnimationFrame: (fn) => { scheduled.push(fn); return scheduled.length; }
  });
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.activeConversationId = "botc_u_a_mia";
  const run = s._internalCtx.cloudRunFor("botc_u_a_mia", "car_perm");
  s._internalCtx.addRunPermission(run, { requestId: "perm_1", preview: "vm_stat" });

  s._internalCtx.renderAgentPermissionBanner();
  scheduled.forEach((fn) => fn());

  assert.equal(chat.scrollTop, 1000);
});

test("handleCloudEvent does not infer group typing state from conductor-mode user messages", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.conversations = [{ id: "g_typing", type: "group" }];
  s._internalCtx.conversationMembersCache.set("g_typing", [
    { member_kind: "user", member_ref: "u_me" },
    { member_kind: "bot", member_ref: "codex", bot_name: "小栗" }
  ]);

  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "g_typing",
      message: { id: "m1", seq: 1, sender_kind: "user", sender_ref: "u_me", body_md: "有人吗" },
    },
  });

  assert.equal(s.moduleState.cloudAgentRunsByConversation.has("g_typing"), false);
});

test("cloud agent run start exposes typing state to the conversation header", () => {
  const scheduled = [];
  let headerPaints = 0;
  const s = loadSocial({
    requestAnimationFrame: (fn) => {
      scheduled.push(fn);
      return scheduled.length;
    }
  });
  s.initSocialModule({
    getState: () => ({}),
    render: () => {},
    els: {},
    appendTransientChat: () => {},
    paintHeaderStatus: () => { headerPaints += 1; }
  });
  s.moduleState.activeConversationId = "botc_u_a_mia";
  s.moduleState.conversations = [{ id: "botc_u_a_mia", type: "bot", decorations: { botId: "mia" } }];
  s.moduleState.messageCache.set("botc_u_a_mia", { messages: [], maxSeq: 0 });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", botId: "mia" },
  });

  assert.equal(s.activeConversationRun().status, "running");
  assert.equal(s.activeConversationRun().botId, "mia");
  scheduled.forEach((fn) => fn());
  assert.equal(headerPaints, 1);

  const chat = {
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
  s.renderConversationChat(chat);

  assert.equal(chat.children.length, 0);
});

test("renderConversationChat does not label tool-only agent activity as typing", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.activeConversationId = "botc_u_a_mia";
  s.moduleState.conversations = [{ id: "botc_u_a_mia", type: "bot", decorations: { botId: "mia" } }];
  s.moduleState.messageCache.set("botc_u_a_mia", { messages: [], maxSeq: 0 });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", botId: "mia" },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "tool.started", tool: "search" } },
  });

  const chat = {
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
  s.renderConversationChat(chat);

  assert.equal(chat.children.length, 1);
  assert.match(chat.children[0].innerHTML, /TOOL/);
  assert.doesNotMatch(chat.children[0].innerHTML, /typing-status/);
});

test("renderConversationChat renders normalized cloud run trace blocks", () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  s.__mockWindow.miaTraceBlocks = {
    renderTraceBlocks({ reasoning, tools }) {
      return `<div class="trace"><span class="reasoning">${String(reasoning || "")}</span>${(tools || []).map((tool) => `<span class="tool">${tool.name}:${tool.status}</span>`).join("")}</div>`;
    }
  };
  s.initSocialModule({ getState: () => ({ user: { id: "u_a" }, bots: [{ key: "mia", name: "Mia" }] }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_a";
  s.moduleState.activeConversationId = "botc_u_a_mia";
  s.moduleState.conversations = [{ id: "botc_u_a_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } }];
  s.moduleState.messageCache.set("botc_u_a_mia", { messages: [], maxSeq: 0 });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", botId: "mia" },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "reasoning_delta", text: "检查上下文" } },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "tool_call_started", id: "tool_1", name: "shell", preview: "ls" } },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "tool_call_completed", id: "tool_1", name: "shell", duration: 1.25 } },
  });

  const chat = {
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
  s.renderConversationChat(chat);

  assert.equal(chat.children.length, 1);
  assert.match(chat.children[0].innerHTML, /trace/);
  assert.match(chat.children[0].innerHTML, /检查上下文/);
  assert.match(chat.children[0].innerHTML, /shell:completed/);
});

test("renderConversationChat marks rendered trace rows after painting", () => {
  const s = loadSocial();
  let markedRoot = null;
  s.__mockWindow.miaTraceBlocks = {
    renderTraceBlocks() {
      return '<div class="trace"><details class="trace-row trace-anim-enter" data-trace-key="cloud-run:car_1::tool::tool_1"></details></div>';
    },
    markRenderedTraceBlocks(root) {
      markedRoot = root;
    }
  };
  s.initSocialModule({ getState: () => ({ user: { id: "u_a" } }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_a";
  s.moduleState.activeConversationId = "botc_u_a_mia";
  s.moduleState.conversations = [{ id: "botc_u_a_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } }];
  s.moduleState.messageCache.set("botc_u_a_mia", { messages: [], maxSeq: 0 });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", botId: "mia" },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "tool_call_started", id: "tool_1", name: "shell" } },
  });

  const chat = {
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
  s.renderConversationChat(chat);

  assert.equal(markedRoot, chat);
});

test("renderConversationChat renders persisted trace_json on fellow messages", () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  s.__mockWindow.miaTraceBlocks = {
    renderTraceBlocks({ reasoning, tools }) {
      return `<div class="trace"><span>${String(reasoning || "")}</span>${(tools || []).map((tool) => `<span>${tool.name}</span>`).join("")}</div>`;
    }
  };
  s.initSocialModule({ getState: () => ({ user: { id: "u_a" }, bots: [{ key: "mia", name: "Mia" }] }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_a";
  s.moduleState.activeConversationId = "botc_u_a_mia";
  s.moduleState.conversations = [{ id: "botc_u_a_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } }];
  s.moduleState.messageCache.set("botc_u_a_mia", {
    messages: [{
      id: "m_trace",
      seq: 1,
      sender_kind: "bot",
      sender_ref: "mia",
      body_md: "done",
      created_at: "",
      trace_json: JSON.stringify({ reasoning: "做了计划", tools: [{ name: "search", status: "completed" }] })
    }],
    maxSeq: 1
  });

  const chat = {
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
  s.renderConversationChat(chat);

  assert.equal(chat.children.length, 1);
  assert.match(chat.children[0].innerHTML, /做了计划/);
  assert.match(chat.children[0].innerHTML, /search/);
});

test("handleCloudEvent fellow reply clears transient cloud agent stream", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1" },
  });
  assert.ok(s.moduleState.cloudAgentRunsByConversation.has("botc_u_a_mia"));
  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "botc_u_a_mia",
      message: { id: "m1", seq: 1, sender_kind: "bot", sender_ref: "mia", body_md: "done" },
    },
  });
  assert.equal(s.moduleState.cloudAgentRunsByConversation.has("botc_u_a_mia"), false);
});

test("handleCloudEvent preserves transient run trace when final fellow message lacks trace_json", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", botId: "mia" },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "reasoning_delta", text: "检查文件" } },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "tool_call_started", id: "tool_1", name: "shell", preview: "wc -l package.json" } },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "tool_call_completed", id: "tool_1", name: "shell" } },
  });

  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "botc_u_a_mia",
      message: { id: "m1", seq: 1, sender_kind: "bot", sender_ref: "mia", body_md: "done" },
    },
  });

  const cached = s.moduleState.messageCache.get("botc_u_a_mia").messages[0];
  assert.equal(cached.trace.reasoning, "检查文件");
  assert.equal(cached.trace.tools[0].name, "shell");
  assert.equal(cached.trace.tools[0].status, "completed");
  assert.equal(s.moduleState.cloudAgentRunsByConversation.has("botc_u_a_mia"), false);
});

test("social module does not read the legacy localStorage snapshot on load", () => {
  const touched = [];
  loadSocial({
    localStorage: {
      getItem: (key) => { touched.push(`get:${key}`); return null; },
      setItem: (key) => { touched.push(`set:${key}`); }
    }
  });

  assert.deepEqual(touched, []);
});

test("bootstrapAfterLogin does not write the legacy localStorage snapshot", async () => {
  const touched = [];
  const s = loadSocial({
    localStorage: {
      getItem: (key) => { touched.push(`get:${key}`); return null; },
      setItem: (key) => { touched.push(`set:${key}`); }
    }
  });
  s.initSocialModule({ getState: () => ({ runtime: {} }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.__mockWindow.mia.social = {
    myUsername: async () => ({ ok: true, data: { id: "u_me", username: "me" } }),
    listFriends: async () => ({ ok: true, data: { friends: [] } }),
    listFriendRequests: async () => ({ ok: true, data: { requests: [] } }),
    listBots: async () => ({ ok: true, data: { bots: [] } }),
    listConversations: async () => ({ ok: true, data: { conversations: [] } }),
    settingsGet: async () => ({ ok: true, data: { settings: { version: 1, readMarks: {}, unreadOverrides: {} } } })
  };

  await s.bootstrapAfterLogin();

  assert.deepEqual(touched, []);
});

async function flushMicrotasks(times = 15) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function makeMessages(from, to) {
  const out = [];
  for (let seq = from; seq <= to; seq++) {
    out.push({ id: `m${seq}`, seq, sender_kind: "user", sender_ref: "u_a", body_md: `b${seq}` });
  }
  return out;
}

// Regression: the local-first delta cursor must come from the persisted SQLite
// cache, not a stale in-memory row from the current renderer session. Using that
// stale row as the cursor can skip the real server backfill.
test("opening a conversation with an EMPTY local cache backfills from seq 0, not stale memory seq", async () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  s.__mockWindow.miaAvatar = { avatarThumbBackgroundStyle: () => "" };
  s.initSocialModule({ getState: () => ({ runtime: {} }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.cloudSettings = { version: 1, readMarks: {}, unreadOverrides: {} };
  s.moduleState.conversations = [{ id: "dm:u_a:u_b", type: "dm" }];
  // Simulate a stale row already in renderer memory while SQLite has no durable history.
  s.moduleState.messageCache.set("dm:u_a:u_b", { maxSeq: 9, messages: makeMessages(9, 9) });

  const listCalls = [];
  s.__mockWindow.mia.social = {
    getCachedConversationMessages: async () => ({ ok: true, data: { messages: [] } }), // empty SQLite cache
    listConversationMessages: async (_id, sinceSeq) => {
      listCalls.push(sinceSeq);
      return { ok: true, data: { messages: makeMessages(1, 9) } };
    },
    settingsPut: async () => ({})
  };

  await withMutedConsoleWarn(async () => {
    s.setActiveConversationId("dm:u_a:u_b");
    await flushMicrotasks();
  });

  assert.deepEqual(listCalls, [0], "empty cache → full backfill (since_seq 0), not the stale memory seq 9");
  assert.equal(s.moduleState.messageCache.get("dm:u_a:u_b").messages.length, 9, "full history merged in, not stuck on one stale row");
});

test("backfill upgrades stale in-memory messages with persisted trace_json", async () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  s.__mockWindow.miaAvatar = { avatarThumbBackgroundStyle: () => "" };
  s.initSocialModule({ getState: () => ({ runtime: {} }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.cloudSettings = { version: 1, readMarks: {}, unreadOverrides: {} };
  s.moduleState.conversations = [{ id: "botc_u_me_mia", type: "bot", decorations: { botId: "mia" } }];
  // A stale row may exist in renderer memory before the server returns richer fields.
  s.moduleState.messageCache.set("botc_u_me_mia", {
    maxSeq: 3,
    messages: [{ id: "m3", seq: 3, sender_kind: "bot", sender_ref: "mia", body_md: "done" }]
  });

  const tracedMessage = {
    id: "m3",
    seq: 3,
    sender_kind: "bot",
    sender_ref: "mia",
    body_md: "done",
    trace_json: JSON.stringify({ reasoning: "检查文件", tools: [{ id: "tool_1", name: "shell", status: "completed" }] })
  };
  s.__mockWindow.mia.social = {
    getCachedConversationMessages: async () => ({ ok: true, data: { messages: [] } }),
    listConversationMessages: async () => ({ ok: true, data: { messages: [tracedMessage] } }),
    settingsPut: async () => ({})
  };

  await withMutedConsoleWarn(async () => {
    s.setActiveConversationId("botc_u_me_mia");
    await flushMicrotasks();
  });

  const cached = s.moduleState.messageCache.get("botc_u_me_mia").messages[0];
  assert.equal(cached.trace_json, tracedMessage.trace_json);
});

test("warm cache backfill overlaps recent messages to repair missing trace_json", async () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  s.__mockWindow.miaAvatar = { avatarThumbBackgroundStyle: () => "" };
  s.initSocialModule({ getState: () => ({ runtime: {} }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.cloudSettings = { version: 1, readMarks: {}, unreadOverrides: {} };
  s.moduleState.conversations = [{ id: "botc_u_me_mia", type: "bot", decorations: { botId: "mia" } }];

  const staleCached = { id: "m3", seq: 3, sender_kind: "bot", sender_ref: "mia", body_md: "done" };
  const tracedMessage = {
    ...staleCached,
    trace_json: JSON.stringify({ reasoning: "检查文件", tools: [{ id: "tool_1", name: "shell", status: "completed" }] })
  };
  const listCalls = [];
  s.__mockWindow.mia.social = {
    getCachedConversationMessages: async () => ({ ok: true, data: { messages: [staleCached] } }),
    listConversationMessages: async (_id, sinceSeq) => {
      listCalls.push(sinceSeq);
      return { ok: true, data: { messages: sinceSeq < 3 ? [tracedMessage] : [] } };
    },
    settingsPut: async () => ({})
  };

  await withMutedConsoleWarn(async () => {
    s.setActiveConversationId("botc_u_me_mia");
    await flushMicrotasks();
  });

  const cached = s.moduleState.messageCache.get("botc_u_me_mia").messages[0];
  assert.deepEqual(listCalls, [0]);
  assert.equal(cached.trace_json, tracedMessage.trace_json);
});

test("opening a conversation with a WARM local cache fetches a bounded recent overlap", async () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  s.__mockWindow.miaAvatar = { avatarThumbBackgroundStyle: () => "" };
  s.initSocialModule({ getState: () => ({ runtime: {} }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.cloudSettings = { version: 1, readMarks: {}, unreadOverrides: {} };
  s.moduleState.conversations = [{ id: "dm:u_a:u_b", type: "dm" }];
  s.moduleState.messageCache.set("dm:u_a:u_b", { maxSeq: 80, messages: makeMessages(80, 80) });

  const listCalls = [];
  s.__mockWindow.mia.social = {
    getCachedConversationMessages: async () => ({ ok: true, data: { messages: makeMessages(1, 80) } }), // warm SQLite cache, max seq 80
    listConversationMessages: async (_id, sinceSeq) => { listCalls.push(sinceSeq); return { ok: true, data: { messages: [] } }; },
    settingsPut: async () => ({})
  };

  await withMutedConsoleWarn(async () => {
    s.setActiveConversationId("dm:u_a:u_b");
    await flushMicrotasks();
  });

  assert.deepEqual(listCalls, [30], "warm cache → recent overlap since maxSeq - 50, not a full refetch");
  assert.equal(s.moduleState.messageCache.get("dm:u_a:u_b").messages.length, 80, "cached history merged for instant paint");
});

test("applyCloudSettings clears auto-counted unread when peer device's readMark catches up", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  // Local state: a conversation we've cached up to seq=4 with 2 auto-counted unread.
  s.moduleState.messageCache.set("dm:u_a:u_b", { messages: [], maxSeq: 4 });
  s.moduleState.unreadByConversation.set("dm:u_a:u_b", 2);
  // Another device pushes readMarks { "dm:u_a:u_b": 4 } via user_settings.updated.
  s.applyCloudSettings({
    pins: [],
    readMarks: { "dm:u_a:u_b": 4 },
    appearance: {},
    version: 2,
    updatedAt: "2026-05-28T00:00:00.000Z"
  });
  assert.equal(s.moduleState.unreadByConversation.has("dm:u_a:u_b"), false,
    "readMark caught up to local maxSeq → unread badge must clear");
});

test("applyCloudSettings leaves unread alone when local has fresher messages than peer's readMark", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  // Local saw seq=6 (2 messages newer than peer's mark) and counted both.
  s.moduleState.messageCache.set("dm:u_a:u_b", { messages: [], maxSeq: 6 });
  s.moduleState.unreadByConversation.set("dm:u_a:u_b", 2);
  s.applyCloudSettings({
    pins: [],
    readMarks: { "dm:u_a:u_b": 4 },
    appearance: {},
    version: 3,
    updatedAt: "2026-05-28T00:01:00.000Z"
  });
  assert.equal(s.moduleState.unreadByConversation.get("dm:u_a:u_b"), 2,
    "peer's readMark < local maxSeq → newer messages are still genuinely unread");
});

test("message_appended skips unread bump when readMark already covers the replayed seq", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  // Peer has already read up to seq=5. Active conversation is something else
  // so the "active conversation auto-clear" branch doesn't muddy the test.
  s.moduleState.cloudSettings = { pins: [], readMarks: { "dm:u_a:u_b": 5 }, appearance: {}, version: 1, unreadOverrides: {} };
  s.moduleState.activeConversationId = "dm:other";
  // WS replays an old message_appended with seq=3 — already read on web.
  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "dm:u_a:u_b",
      message: { id: "m3", seq: 3, body_md: "old", sender_ref: "u_other", created_at: "2026-05-28T00:02:00.000Z" }
    }
  });
  assert.equal(s.moduleState.unreadByConversation.has("dm:u_a:u_b"), false,
    "replayed message at seq=3 with readMark=5 must not light the badge");
  // A genuinely newer message at seq=6 should still bump.
  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "dm:u_a:u_b",
      message: { id: "m6", seq: 6, body_md: "new", sender_ref: "u_other", created_at: "2026-05-28T00:03:00.000Z" }
    }
  });
  assert.equal(s.moduleState.unreadByConversation.get("dm:u_a:u_b"), 1,
    "fresh message at seq=6 with readMark=5 must bump unread");
});
