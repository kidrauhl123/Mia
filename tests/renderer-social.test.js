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
    set textContent(v) { this._text = String(v || ""); },
    get textContent() { return this._text || ""; },
    setAttribute() {},
    getAttribute() { return ""; },
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    cloneNode() { return mockEl(); },
  });
  const mockWindow = {
    requestAnimationFrame: options.requestAnimationFrame,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
    mia: {},
    miaBotCommands: require("../src/renderer/bot/bot-commands.js"),
    miaSelfIdentity: require("../packages/shared/self-identity.js"),
    miaSendPipeline: require("../src/shared/send-pipeline.js"),
    miaConversationTags: require("../src/shared/conversation-tags.js"),
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

async function flushPromises(turns = 3) {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

function makeTestEl() {
  return {
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    style: {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    querySelector() { return makeTestEl(); },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return ""; },
    set innerHTML(value) { this._html = String(value || ""); this.children = []; },
    get innerHTML() { return this._html || ""; },
    set textContent(value) { this._text = String(value || ""); },
    get textContent() { return this._text || ""; },
  };
}

test("bootstrapAfterLogin does not import local runtime bots as cloud identities", async () => {
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
    myIdentity: async () => ({ ok: true, data: { id: "u_1", username: "jung" } }),
    listFriends: async () => ({ ok: true, data: { friends: [] } }),
    listFriendRequests: async () => ({ ok: true, data: { requests: [] } }),
    settingsGet: async () => ({}),
    ensureBotSessionConversation: async () => {
      throw new Error("bootstrap should not import runtime.bots");
    },
    saveBotRuntime: async () => {
      throw new Error("bootstrap should not save runtime bindings for runtime.bots");
    },
    listConversations: async () => {
      calls.push({ kind: "listConversations" });
      return { ok: true, data: { conversations: [{ id: "botc_u_1_alice", type: "bot", name: "爱丽丝" }] } };
    },
    listConversationMessages: async () => ({ ok: true, data: { messages: [] } })
  };

  await s.bootstrapAfterLogin();
  await flushPromises();

  assert.deepEqual(calls.map((call) => call.kind), ["listConversations"]);
  assert.equal(s.moduleState.conversations.length, 1);
  assert.equal(s.moduleState.conversations[0].id, "botc_u_1_alice");
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
    myIdentity: async () => ({ ok: true, data: { id: "u_1", username: "jung" } }),
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

test("focusConversationMessage backfills around the hit seq then scrolls to it", async () => {
  let renderCalls = 0;
  let listCall = null;
  let backfilled = false;
  const article = {
    offsetTop: 620,
    offsetHeight: 80,
    offsetParent: null,
    classList: { add() {}, remove() {} },
  };
  const bubble = { closest: () => article };
  const chat = {
    dataset: {},
    scrollTop: 0,
    scrollHeight: 1400,
    clientHeight: 500,
    appendChild() {},
    querySelector(selector) {
      return backfilled && selector.includes("m_hit") ? bubble : null;
    }
  };
  article.offsetParent = chat;
  const s = loadSocial({ requestAnimationFrame: (fn) => fn(), elementsById: { chat } });
  s.initSocialModule({
    getState: () => ({ runtime: {} }),
    render: () => { renderCalls += 1; },
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.activeConversationId = "botc_sess_1";
  s.moduleState.conversations = [{ id: "botc_sess_1", type: "bot", name: "论文搭子" }];
  s.moduleState.messageCache.set("botc_sess_1", { messages: [], maxSeq: 0 });
  s.__mockWindow.mia.social = {
    listConversationMessages: async (conversationId, sinceSeq, limit) => {
      listCall = { conversationId, sinceSeq, limit };
      backfilled = true;
      return { ok: true, data: { messages: [{ id: "m_hit", seq: 120, conversation_id: conversationId, body_md: "命中消息" }] } };
    },
    settingsPut: async () => ({}),
  };

  const result = await s.focusConversationMessage("botc_sess_1", { messageId: "m_hit", seq: 120 });

  assert.equal(result.found, true);
  assert.deepEqual(listCall, { conversationId: "botc_sess_1", sinceSeq: 0, limit: 260 });
  assert.equal(s.moduleState.messageCache.get("botc_sess_1").messages[0].id, "m_hit");
  assert.ok(renderCalls >= 2);
  assert.equal(chat.scrollTop, 410);
});

test("focusConversationMessage loads around the hit seq even when the preview hit is already rendered", async () => {
  let renderCalls = 0;
  let listCall = null;
  const focusClasses = [];
  const article = {
    offsetTop: 500,
    offsetHeight: 80,
    offsetParent: null,
    classList: {
      add(name) { focusClasses.push(["add", name]); },
      remove(name) { focusClasses.push(["remove", name]); }
    },
  };
  const bubble = { closest: () => article };
  const chat = {
    dataset: {},
    scrollTop: 0,
    scrollHeight: 1200,
    clientHeight: 400,
    appendChild() {},
    querySelector(selector) {
      return selector.includes("m_hit") ? bubble : null;
    }
  };
  article.offsetParent = chat;
  const s = loadSocial({ requestAnimationFrame: (fn) => fn(), elementsById: { chat } });
  s.initSocialModule({
    getState: () => ({ runtime: {} }),
    render: () => { renderCalls += 1; },
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.activeConversationId = "botc_sess_1";
  s.moduleState.conversations = [{ id: "botc_sess_1", type: "bot", name: "论文搭子" }];
  s.moduleState.messageCache.set("botc_sess_1", { messages: [], maxSeq: 0 });
  s.__mockWindow.mia.social = {
    listConversationMessages: async (conversationId, sinceSeq, limit) => {
      listCall = { conversationId, sinceSeq, limit };
      return { ok: true, data: { messages: [{ id: "m_hit", seq: 120, conversation_id: conversationId, body_md: "命中消息" }] } };
    },
    settingsPut: async () => ({}),
  };

  const result = await s.focusConversationMessage("botc_sess_1", {
    messageId: "m_hit",
    seq: 120,
    message: { id: "m_hit", seq: 120, conversation_id: "botc_sess_1", body_md: "搜索预览" }
  });

  assert.equal(result.found, true);
  assert.deepEqual(listCall, { conversationId: "botc_sess_1", sinceSeq: 0, limit: 260 });
  assert.equal(chat.scrollTop, 340);
  assert.ok(renderCalls >= 2);
  assert.ok(focusClasses.some(([action, name]) => action === "add" && name === "search-focus"));
});

test("focusConversationMessage consumes the first focus on the forced chat render", async () => {
  let renderCalls = 0;
  const article = {
    offsetTop: 500,
    offsetHeight: 80,
    offsetParent: null,
    classList: { add() {}, remove() {} },
  };
  const bubble = { closest: () => article };
  const chat = {
    dataset: {},
    scrollTop: 0,
    scrollHeight: 1200,
    clientHeight: 400,
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    querySelector(selector) {
      return selector.includes("m_hit") ? bubble : null;
    },
    set innerHTML(value) {
      this._html = value;
      this.children = [];
      this.scrollTop = 0;
    },
    get innerHTML() {
      return this._html || "";
    }
  };
  article.offsetParent = chat;
  const s = loadSocial({ requestAnimationFrame: (fn) => fn(), elementsById: { chat } });
  s.initSocialModule({
    getState: () => ({ runtime: {} }),
    render: () => {
      renderCalls += 1;
      s.renderConversationChat(chat);
    },
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.activeConversationId = "botc_sess_1";
  s.moduleState.conversations = [{ id: "botc_sess_1", type: "bot", name: "论文搭子" }];
  s.moduleState.messageCache.set("botc_sess_1", {
    messages: [{ id: "m_hit", seq: 120, sender_kind: "user", body_md: "命中消息" }],
    maxSeq: 120
  });
  s.__mockWindow.mia.social = {
    listConversationMessages: async () => ({ ok: true, data: { messages: [] } }),
    settingsPut: async () => ({}),
  };

  const result = await s.focusConversationMessage("botc_sess_1", { messageId: "m_hit" });

  assert.equal(result.found, true);
  assert.ok(renderCalls >= 1);
  assert.equal(chat.scrollTop, 340);
});

test("focusConversationMessage waits for measurable layout before consuming offscreen focus", async () => {
  const article = {
    offsetTop: 500,
    offsetHeight: 80,
    offsetParent: null,
    classList: { add() {}, remove() {} },
  };
  const bubble = { closest: () => article };
  const chat = {
    dataset: {},
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 400,
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    querySelector(selector) {
      return selector.includes("m_hit") ? bubble : null;
    },
    set innerHTML(value) {
      this._html = value;
      this.children = [];
    },
    get innerHTML() {
      return this._html || "";
    }
  };
  article.offsetParent = chat;
  const s = loadSocial({ requestAnimationFrame: (fn) => fn(), elementsById: { chat } });
  s.initSocialModule({
    getState: () => ({ runtime: {} }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.activeConversationId = "botc_sess_1";
  s.moduleState.conversations = [{ id: "botc_sess_1", type: "bot", name: "论文搭子" }];
  s.moduleState.messageCache.set("botc_sess_1", {
    messages: [{ id: "m_hit", seq: 120, sender_kind: "user", body_md: "命中消息" }],
    maxSeq: 120
  });
  s.__mockWindow.mia.social = {
    listConversationMessages: async () => ({ ok: true, data: { messages: [] } }),
    settingsPut: async () => ({}),
  };

  const result = await s.focusConversationMessage("botc_sess_1", { messageId: "m_hit" });

  assert.equal(result.found, true);
  assert.equal(chat.scrollTop, 0, "unmeasured layout cannot scroll yet");

  chat.scrollHeight = 1200;
  s.renderConversationChat(chat);

  assert.equal(chat.scrollTop, 340);
});

test("focusConversationMessage does not re-center after the user scrolls away", async () => {
  const article = {
    offsetTop: 500,
    offsetHeight: 80,
    offsetParent: null,
    classList: { add() {}, remove() {} },
  };
  const bubble = { closest: () => article };
  const chat = {
    dataset: {},
    scrollTop: 0,
    scrollHeight: 1200,
    clientHeight: 400,
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    querySelector(selector) {
      return selector.includes("m_hit") ? bubble : null;
    },
    set innerHTML(value) {
      this._html = value;
      this.children = [];
    },
    get innerHTML() {
      return this._html || "";
    }
  };
  article.offsetParent = chat;
  const s = loadSocial({ requestAnimationFrame: (fn) => fn(), elementsById: { chat } });
  s.initSocialModule({
    getState: () => ({ runtime: {} }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.activeConversationId = "botc_sess_1";
  s.moduleState.conversations = [{ id: "botc_sess_1", type: "bot", name: "论文搭子" }];
  s.moduleState.messageCache.set("botc_sess_1", {
    messages: [{ id: "m_hit", seq: 120, sender_kind: "user", body_md: "命中消息" }],
    maxSeq: 120
  });
  s.__mockWindow.mia.social = {
    listConversationMessages: async () => ({ ok: true, data: { messages: [] } }),
    settingsPut: async () => ({}),
  };

  const result = await s.focusConversationMessage("botc_sess_1", { messageId: "m_hit" });

  assert.equal(result.found, true);
  assert.equal(chat.scrollTop, 340);

  chat.scrollTop = 25;
  s.renderConversationChat(chat);

  assert.equal(chat.scrollTop, 25, "manual scroll position should win after initial focus is consumed");
});

test("bootstrapAfterLogin prefetches group members beyond the initial message cap", async () => {
  const s = loadSocial();
  const fetched = [];
  s.__mockWindow.miaSocialGroups = {
    fetchAndCacheConversationMembers: async (conversationId) => {
      fetched.push(conversationId);
    }
  };
  s.initSocialModule({
    getState: () => ({
      runtime: {
        permissions: {
          engines: {
            codex: ":workspace"
          }
        }
      }
    }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  const conversations = [
    ...Array.from({ length: 30 }, (_value, idx) => ({
      id: `botc_u_1_bot_${idx}`,
      type: "bot",
      name: `Bot ${idx}`
    })),
    { id: "g_late", type: "group", name: "Late Group" }
  ];
  s.__mockWindow.mia.social = {
    myIdentity: async () => ({ ok: true, data: { id: "u_1", username: "jung" } }),
    listFriends: async () => ({ ok: true, data: { friends: [] } }),
    listFriendRequests: async () => ({ ok: true, data: { requests: [] } }),
    listBots: async () => ({ ok: true, data: { bots: [] } }),
    settingsGet: async () => ({}),
    listConversations: async () => ({ ok: true, data: { conversations } }),
    listConversationMessages: async () => ({ ok: true, data: { messages: [] } })
  };

  await s.bootstrapAfterLogin();

  assert.ok(fetched.includes("g_late"), "group conversations beyond the initial message cap should still prefetch members");
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
    myIdentity: async () => ({ ok: true, data: { id: "u_1", username: "jung" } }),
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
    myIdentity: async () => ({ ok: true, data: { id: "u_1", username: "jung" } }),
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

test("renderSidebarRows collapses clean bot session history by bot id", () => {
  const s = loadSocial();
  s.__mockWindow.miaSessionHistory = sessionHistory;
  s.moduleState.bots = [
    { id: "bot_aaa", name: "匠妹", avatarImage: "https://example.test/jm.png" },
    { id: "bot_bbb", name: "棕野" }
  ];
  s.moduleState.conversations = [
    {
      id: "botc_session_old",
      type: "bot",
      name: "旧历史",
      updatedAt: "2026-06-01T08:00:00.000Z",
      decorations: { botId: "bot_aaa", sessionId: "session_old" }
    },
    {
      id: "botc_session_new",
      type: "bot",
      name: "新历史",
      updatedAt: "2026-06-03T08:00:00.000Z",
      decorations: { botId: "bot_aaa", sessionId: "session_new" }
    },
    {
      id: "botc_other",
      type: "bot",
      name: "另一个 bot",
      updatedAt: "2026-06-02T08:00:00.000Z",
      decorations: { botId: "bot_bbb", sessionId: "other" }
    }
  ];
  s.moduleState.messageCache.set("botc_session_old", {
    messages: [{ created_at: "2026-06-01T08:30:00.000Z", body_md: "old" }],
    maxSeq: 1
  });
  s.moduleState.messageCache.set("botc_session_new", {
    messages: [{ created_at: "2026-06-03T08:30:00.000Z", body_md: "new" }],
    maxSeq: 1
  });
  s.moduleState.messageCache.set("botc_other", {
    messages: [{ created_at: "2026-06-02T08:30:00.000Z", body_md: "other" }],
    maxSeq: 1
  });

  const rows = s.renderSidebarRows();

  assert.deepEqual(rows.map((row) => row.conversation.id), ["botc_session_new", "botc_other"]);
  assert.deepEqual(rows.map((row) => row.conversation.type), ["bot", "bot"]);
  assert.deepEqual(rows.map((row) => row.conversation.otherUser), [null, null]);

  s.moduleState.lastBotConversationByKey = { bot_aaa: "botc_session_old" };
  assert.deepEqual(
    s.renderSidebarRows().map((row) => row.conversation.id),
    ["botc_session_old", "botc_other"]
  );
});

test("ensureBotConversation syncs external bot runtime config for web controls", async () => {
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
        permissions: {
          engines: {
            codex: ":workspace"
          }
        }
      }
    }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  s.__mockWindow.mia.social = {
    ensureBotSessionConversation: async (botId, body) => {
      calls.push({ kind: "ensure", botId, body });
      return { ok: true, data: { conversation: { id: "botc_u_1_codex", type: "bot" } } };
    },
    saveBotRuntime: async (botId, body) => {
      calls.push({ kind: "runtime", botId, body });
      return { ok: true, data: { binding: { botId, ...body } } };
    }
  };

  await s.ensureBotConversation({
    key: "codex",
    name: "Codex",
    agentEngine: "codex",
    engineConfig: { model: "gpt-5.3-codex", effortLevel: "xhigh", permissionMode: "readOnly" }
  });

  assert.equal(calls[1].kind, "runtime");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body.config)), {
    agentEngine: "codex",
    model: "gpt-5.3-codex",
    providerConnectionId: "codex",
    modelProfileId: "codex:gpt-5.3-codex",
    effortLevel: "xhigh",
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

test("ensureBotConversation warns when bot conversation ensure returns ok false", async () => {
  const s = loadSocial();
  const calls = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    s.initSocialModule({
      getState: () => ({ runtime: {} }),
      render: () => {},
      els: {},
      appendTransientChat: () => {}
    });
    s.__mockWindow.mia.social = {
      ensureBotSessionConversation: async (botId) => {
        calls.push({ kind: "ensure", botId });
        return { ok: false, error: "boom" };
      }
    };

    await s.ensureBotConversation({ key: "alice", name: "爱丽丝" });
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(calls.map((call) => call.kind), ["ensure"]);
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

test("renderSidebarRows preserves complete markdown links for rich sidebar previews", () => {
  const s = loadSocial();
  const longLocalLink = "已改成：[mia-diff-demo.txt](/Users/jung/Library/Application%20Support/Mia/runtime/engine-home/workspace/mia-diff-demo.txt)";
  s.moduleState.myUserId = "u_alice";
  s.moduleState.friends = [{ id: "u_bob", username: "bob", account: "bob" }];
  s.moduleState.conversations = [{ id: "dm:u_alice:u_bob", type: "dm", updatedAt: "2026-05-21T20:00:00.000Z" }];
  s.moduleState.messageCache.set("dm:u_alice:u_bob", {
    messages: [{ id: "m1", seq: 1, body_md: longLocalLink, created_at: "2026-05-21T20:01:00.000Z" }],
    maxSeq: 1,
  });

  const rows = s.renderSidebarRows();

  assert.equal(rows[0].conversation.lastMessagePreview, longLocalLink);
  assert.match(rows[0].conversation.lastMessagePreview, /\)$/);
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

test("renderSidebarRows carries user-private conversation tags", () => {
  const s = loadSocial();
  s.moduleState.myUserId = "u_alice";
  s.moduleState.friends = [{ id: "u_bob", username: "bob", account: "bob" }];
  s.moduleState.cloudSettings = {
    pins: [],
    readMarks: {},
    appearance: {},
    tags: {
      items: [{ id: "work", name: "工作", color: "#16a34a" }],
      assignments: { "dm:u_alice:u_bob": ["work"] }
    }
  };
  s.moduleState.conversations = [{ id: "dm:u_alice:u_bob", type: "dm", name: null, updatedAt: "2026-05-21T20:00:00.000Z" }];

  const rows = s.renderSidebarRows();

  assert.deepEqual(rows[0].conversation.tags.map((tag) => tag.name), ["工作"]);
  assert.equal(rows[0].conversation.tags[0].color, "#16a34a");
});

test("setConversationTagNames persists normalized tags through settingsPut", async () => {
  const s = loadSocial();
  const writes = [];
  s.__mockWindow.mia.social = {
    settingsPut: async (body) => {
      writes.push(body);
      return { settings: { ...body, version: 6, updatedAt: "2026-06-15T10:00:00.000Z" } };
    }
  };
  s.moduleState.cloudSettings = {
    pins: [],
    readMarks: {},
    appearance: {},
    tags: { items: [], assignments: {} },
    version: 5
  };

  await s.setConversationTagNames("dm:u_a:u_b", ["工作", "客户"]);

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].tags.items.map((item) => item.name), ["工作", "客户"]);
  assert.deepEqual(
    writes[0].tags.assignments["dm:u_a:u_b"],
    writes[0].tags.items.map((item) => item.id)
  );
  assert.equal(writes[0].expectedVersion, 5);
  assert.deepEqual(s.conversationTagsFor("dm:u_a:u_b").map((tag) => tag.name), ["工作", "客户"]);
});

test("editConversationTags switches the matching sidebar card into inline edit mode", async () => {
  const s = loadSocial();
  let saved = 0;
  s.__mockWindow.mia.social = {
    settingsPut: async (body) => ({ settings: { ...body, version: 2, updatedAt: "2026-06-15T10:00:00.000Z" } })
  };
  s.moduleState.cloudSettings = {
    pins: [],
    readMarks: {},
    appearance: {},
    tags: {
      items: [
        { id: "tag_old", name: "旧标签", color: "#2563eb" },
        { id: "tag_unused", name: "未引用标签", color: "#dc2626" }
      ],
      assignments: { "dm:u_a:u_b": ["tag_old"] }
    },
    version: 1
  };

  await s.editConversationTags("dm:u_a:u_b", "Bob", () => { saved += 1; });

  const editor = s.conversationTagEditorFor("dm:u_a:u_b");
  assert.equal(editor.active, true);
  assert.equal(editor.adding, true);
  assert.equal(editor.mode, "add");
  assert.equal(editor.maxTags, 3);
  assert.deepEqual(editor.tags.map((tag) => tag.name), ["旧标签"]);
  assert.deepEqual(editor.allTags.map((tag) => tag.name), ["旧标签"]);
  assert.equal(saved, 1);
});

test("inline conversation tag draft survives render and cancel leaves no empty assignment", async () => {
  const s = loadSocial();
  let renders = 0;
  s.initSocialModule({ getState: () => ({}), render: () => { renders += 1; }, els: {}, appendTransientChat: () => {} });
  s.moduleState.cloudSettings = {
    pins: [],
    readMarks: {},
    appearance: {},
    tags: { items: [], assignments: {} },
    version: 1
  };

  await s.editConversationTags("dm:u_a:u_b", "Bob");
  s.startConversationTagAdd("dm:u_a:u_b");
  s.setConversationTagDraft("dm:u_a:u_b", "sa");

  let editor = s.conversationTagEditorFor("dm:u_a:u_b");
  assert.equal(editor.active, true);
  assert.equal(editor.adding, true);
  assert.equal(editor.draft, "sa");
  assert.deepEqual(s.conversationTagsFor("dm:u_a:u_b"), []);

  s.endConversationTagEdit("dm:u_a:u_b");
  editor = s.conversationTagEditorFor("dm:u_a:u_b");
  assert.equal(editor.active, false);
  assert.equal(editor.adding, false);
  assert.equal(editor.draft, "");
  assert.deepEqual(s.moduleState.cloudSettings.tags.assignments, {});
  assert.ok(renders >= 3);
});

test("inline conversation tag editor adds and removes tags through settings", async () => {
  const s = loadSocial();
  const writes = [];
  s.__mockWindow.mia.social = {
    settingsPut: async (body) => {
      writes.push(body);
      return { settings: { ...body, version: writes.length + 1, updatedAt: "2026-06-15T10:00:00.000Z" } };
    }
  };
  s.moduleState.cloudSettings = {
    pins: [],
    readMarks: {},
    appearance: {},
    tags: {
      items: [{ id: "tag_old", name: "旧标签", color: "#2563eb" }],
      assignments: { "dm:u_a:u_b": ["tag_old"] }
    },
    version: 1
  };

  await s.addConversationTagName("dm:u_a:u_b", "工作");
  assert.deepEqual(s.conversationTagsFor("dm:u_a:u_b").map((tag) => tag.name), ["旧标签", "工作"]);
  await s.removeConversationTagName("dm:u_a:u_b", "旧标签");
  assert.deepEqual(s.conversationTagsFor("dm:u_a:u_b").map((tag) => tag.name), ["工作"]);
  assert.deepEqual(writes.at(-1).tags.assignments["dm:u_a:u_b"], [writes.at(-1).tags.items.find((tag) => tag.name === "工作").id]);
  assert.deepEqual(writes.at(-1).tags.items.map((tag) => tag.name), ["工作"]);
});

test("conversation tag menu actions can rename and filter tagged sidebar rows", async () => {
  const s = loadSocial();
  const writes = [];
  s.__mockWindow.mia.social = {
    settingsPut: async (body) => {
      writes.push(body);
      return { settings: { ...body, version: writes.length + 1, updatedAt: "2026-06-15T10:00:00.000Z" } };
    }
  };
  s.moduleState.myUserId = "u_a";
  s.moduleState.friends = [
    { id: "u_b", username: "bob", account: "bob" },
    { id: "u_c", username: "cora", account: "cora" }
  ];
  s.moduleState.cloudSettings = {
    pins: [],
    readMarks: {},
    appearance: {},
    tags: {
      items: [
        { id: "tag_old", name: "旧标签", color: "#2563eb" },
        { id: "tag_work", name: "工作", color: "#16a34a" }
      ],
      assignments: {
        "dm:u_a:u_b": ["tag_old"],
        "dm:u_a:u_c": ["tag_work"]
      }
    },
    version: 1
  };
  s.moduleState.conversations = [
    { id: "dm:u_a:u_b", type: "dm", updatedAt: "2026-05-21T20:00:00.000Z" },
    { id: "dm:u_a:u_c", type: "dm", updatedAt: "2026-05-21T20:01:00.000Z" }
  ];

  await s.renameConversationTagName("dm:u_a:u_b", "旧标签", "客户");
  assert.deepEqual(s.conversationTagsFor("dm:u_a:u_b").map((tag) => tag.name), ["客户"]);

  s.setConversationTagFilter("客户");
  assert.deepEqual(s.renderSidebarRows().map((row) => row.key), ["dm:u_a:u_b"]);
  s.setConversationTagFilter("客户");
  assert.equal(s.renderSidebarRows().length, 2);
});

test("conversationTagFilters returns in-use tag counts without moving the selected tag", () => {
  const s = loadSocial();
  s.moduleState.myUserId = "u_a";
  s.moduleState.friends = [
    { id: "u_b", username: "bob", account: "bob" },
    { id: "u_c", username: "cora", account: "cora" },
    { id: "u_d", username: "dora", account: "dora" }
  ];
  s.moduleState.cloudSettings = {
    pins: [],
    readMarks: {},
    appearance: {},
    tags: {
      items: [
        { id: "tag_work", name: "工作", color: "#16a34a" },
        { id: "tag_client", name: "客户", color: "#2563eb" },
        { id: "tag_unused", name: "未引用", color: "#dc2626" }
      ],
      assignments: {
        "dm:u_a:u_b": ["tag_work", "tag_client"],
        "dm:u_a:u_c": ["tag_work"],
        "dm:u_a:u_missing": ["tag_unused"]
      }
    },
    version: 1
  };
  s.moduleState.conversations = [
    { id: "dm:u_a:u_b", type: "dm", updatedAt: "2026-05-21T20:00:00.000Z" },
    { id: "dm:u_a:u_c", type: "dm", updatedAt: "2026-05-21T20:01:00.000Z" },
    { id: "dm:u_a:u_d", type: "dm", updatedAt: "2026-05-21T20:02:00.000Z" }
  ];

  assert.deepEqual(
    s.conversationTagFilters().map((tag) => [tag.name, tag.count, tag.filterActive]),
    [["工作", 2, false], ["客户", 1, false]]
  );

  s.setConversationTagFilter("客户");
  assert.deepEqual(
    s.conversationTagFilters().map((tag) => [tag.name, tag.count, tag.filterActive]),
    [["工作", 2, false], ["客户", 1, true]]
  );
  assert.equal(s.getConversationTagFilter(), "客户");
});

test("conversation tag inline commit renames the target instead of adding a second tag", async () => {
  const s = loadSocial();
  const writes = [];
  s.__mockWindow.mia.social = {
    settingsPut: async (body) => {
      writes.push(body);
      return { settings: { ...body, version: writes.length + 1, updatedAt: "2026-06-15T10:00:00.000Z" } };
    }
  };
  s.moduleState.cloudSettings = {
    pins: [],
    readMarks: {},
    appearance: {},
    tags: {
      items: [{ id: "tag_old", name: "旧标签", color: "#2563eb" }],
      assignments: { "dm:u_a:u_b": ["tag_old"] }
    },
    version: 1
  };

  s.startConversationTagRename("dm:u_a:u_b", "旧标签");
  const editor = s.conversationTagEditorFor("dm:u_a:u_b");
  s.moduleState.tagEditingMode = "add";
  await editor.onCommit("客户", { mode: "rename", targetName: "旧标签" });

  assert.deepEqual(s.conversationTagsFor("dm:u_a:u_b").map((tag) => tag.name), ["客户"]);
  assert.deepEqual(writes.at(-1).tags.items.map((tag) => tag.name), ["客户"]);
  assert.deepEqual(writes.at(-1).tags.assignments["dm:u_a:u_b"], [writes.at(-1).tags.items[0].id]);
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

test("renderRequestsInto paints actionable incoming requests in contact detail", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.incomingRequests = [
    {
      id: "fr_1",
      from_user: "u_x",
      to_user: "u_me",
      status: "pending",
      other: { id: "u_x", displayName: "Alice" },
    },
  ];
  const pane = makeTestEl();
  const container = makeTestEl();
  container.querySelector = (selector) => (selector === "#socialContactRequestPane" ? pane : null);

  assert.doesNotThrow(() => s.renderRequestsInto(container));
  assert.match(container.innerHTML, /收到的好友请求/);
  assert.equal(pane.children.length, 1);

  const rowText = pane.children[0].children.map((child) => `${child.textContent || ""} ${child.innerHTML || ""}`).join("\n");
  assert.match(rowText, /Alice/);
  assert.match(rowText, /同意/);
  assert.match(rowText, /拒绝/);
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

test("handleCloudEvent bot.upserted preserves active runtime binding fields", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.bots = [{
    id: "nono",
    key: "nono",
    name: "nono",
    runtimeKind: "desktop-local",
    runtimeConfig: { agentEngine: "claude-code", deviceId: "mac-1", deviceName: "Office Mac" },
    agentEngine: "claude-code",
    targetDeviceId: "mac-1",
    deviceId: "mac-1",
    deviceName: "Office Mac",
    runtimeLabel: "Office Mac",
    sourceKinds: ["cloud"]
  }];

  s.handleCloudEvent({
    type: "bot.upserted",
    payload: { bot: { id: "nono", key: "nono", name: "nono", avatarImage: "data:image/png;base64,avatar" } }
  });

  assert.equal(s.moduleState.bots.length, 1);
  assert.equal(s.moduleState.bots[0].runtimeKind, "desktop-local");
  assert.equal(s.moduleState.bots[0].agentEngine, "claude-code");
  assert.equal(s.moduleState.bots[0].targetDeviceId, "mac-1");
  assert.equal(s.moduleState.bots[0].runtimeLabel, "Office Mac");
  assert.equal(s.moduleState.bots[0].avatarImage, "data:image/png;base64,avatar");
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

test("renderSendStatus hides sending state and only shows failed sends", () => {
  const s = loadSocial();

  assert.equal(s._internalCtx.renderSendStatus({ status: "sending" }), "");
  assert.equal(s._internalCtx.renderSendStatus({ status: "sent" }), "");
  assert.match(
    s._internalCtx.renderSendStatus({ status: "error", error: "network down" }),
    /message-send-status is-error[\s\S]*发送失败/
  );
});

test("sendInActiveConversation keeps later pending messages after an earlier server echo", async () => {
  const s = loadSocial();
  const posts = [];
  s.moduleState.myUserId = "u_me";
  s.__mockWindow.mia.social = {
    postConversationMessage: async (conversationId, body) => {
      const pending = deferred();
      posts.push({ conversationId, body, pending });
      return pending.promise;
    }
  };
  s.moduleState.activeConversationId = "g_order";
  s.moduleState.conversations = [{ id: "g_order", type: "group", name: "Order" }];
  s.moduleState.messageCache.set("g_order", { messages: [], maxSeq: 0 });

  const firstSend = s.sendInActiveConversation("first");
  const secondSend = s.sendInActiveConversation("second");
  const entry = s.moduleState.messageCache.get("g_order");

  assert.deepEqual(entry.messages.map((m) => m.body_md), ["first", "second"]);

  posts[0].pending.resolve({
    ok: true,
    data: { message: { id: "m_first", seq: 1, sender_kind: "user", sender_ref: "u_me", body_md: "first" } }
  });
  await firstSend;

  assert.deepEqual(entry.messages.map((m) => m.body_md), ["first", "second"]);

  posts[1].pending.resolve({
    ok: true,
    data: { message: { id: "m_second", seq: 2, sender_kind: "user", sender_ref: "u_me", body_md: "second" } }
  });
  await secondSend;

  assert.deepEqual(entry.messages.map((m) => m.body_md), ["first", "second"]);
});

test("sendInActiveConversation blocks a second user message while the active bot run is running", async () => {
  const s = loadSocial();
  const posted = [];
  s.moduleState.myUserId = "u_me";
  s.__mockWindow.mia.social = {
    postConversationMessage: async (conversationId, body) => {
      posted.push({ conversationId, body });
      return { ok: true, data: { message: { id: "m_server", seq: 1, body_md: body.bodyMd } } };
    }
  };
  s.moduleState.activeConversationId = "g_busy";
  s.moduleState.conversations = [{ id: "g_busy", type: "group", name: "Busy" }];
  s.moduleState.messageCache.set("g_busy", { messages: [], maxSeq: 0 });
  s.moduleState.cloudAgentRunsByConversation.set("g_busy", {
    runId: "car_busy",
    conversationId: "g_busy",
    botId: "codex",
    status: "running"
  });

  const result = await s.sendInActiveConversation("too soon");

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    status: 409,
    error: "CONVERSATION_RUN_IN_PROGRESS"
  });
  assert.equal(posted.length, 0);
  assert.equal(s.moduleState.messageCache.get("g_busy").messages.length, 0);
});

test("sendInActiveConversation blocks user messages while the active bot run is cancelling", async () => {
  const s = loadSocial();
  const posted = [];
  s.moduleState.myUserId = "u_me";
  s.__mockWindow.mia.social = {
    postConversationMessage: async (conversationId, body) => {
      posted.push({ conversationId, body });
      return { ok: true, data: { message: { id: "m_server", seq: 1, body_md: body.bodyMd } } };
    }
  };
  s.moduleState.activeConversationId = "g_cancelling";
  s.moduleState.conversations = [{ id: "g_cancelling", type: "group", name: "Cancelling" }];
  s.moduleState.messageCache.set("g_cancelling", { messages: [], maxSeq: 0 });
  s.moduleState.cloudAgentRunsByConversation.set("g_cancelling", {
    runId: "car_cancelling",
    conversationId: "g_cancelling",
    botId: "codex",
    status: "cancelling"
  });

  const result = await s.sendInActiveConversation("too soon");

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    status: 409,
    error: "CONVERSATION_RUN_IN_PROGRESS"
  });
  assert.equal(posted.length, 0);
  assert.equal(s.moduleState.messageCache.get("g_cancelling").messages.length, 0);
});

test("sendInActiveConversation posts and previews attachment-only messages", async () => {
  const s = loadSocial();
  const posted = [];
  s.moduleState.myUserId = "u_me";
  s.__mockWindow.mia.social = {
    postConversationMessage: async (conversationId, body) => {
      posted.push({ conversationId, body });
      return {
        ok: true,
        data: {
          message: {
            id: "m_attachment",
            seq: 1,
            sender_kind: "user",
            sender_ref: "u_me",
            body_md: "",
            attachments: body.attachments
          }
        }
      };
    }
  };
  s.moduleState.activeConversationId = "g_attachment";
  s.moduleState.conversations = [{ id: "g_attachment", type: "group", name: "Attach" }];
  s.moduleState.messageCache.set("g_attachment", { messages: [], maxSeq: 0 });
  const attachment = {
    id: "a_img",
    name: "image.png",
    kind: "image",
    mime: "image/png",
    size: 18,
    dataUrl: "data:image/png;base64,cG5n",
    thumbnailDataUrl: "data:image/png;base64,cG5n"
  };

  await s.sendInActiveConversation("", { attachments: [attachment] });

  const entry = s.moduleState.messageCache.get("g_attachment");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].conversationId, "g_attachment");
  assert.equal(posted[0].body.bodyMd, "");
  assert.deepEqual(posted[0].body.attachments, [attachment]);
  assert.equal(entry.messages.length, 1);
  assert.deepEqual(entry.messages[0].attachments, [attachment]);
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

test("self websocket echo confirms the active pending bubble without repainting it", () => {
  let cleared = false;
  const bubble = {
    dataset: { messageId: "local_1" },
    setAttribute(name, value) {
      if (name === "data-message-id") this.dataset.messageId = value;
    },
    getAttribute(name) {
      if (name === "data-message-id") return this.dataset.messageId || "";
      return "";
    },
    closest: () => target
  };
  const target = {
    className: "message user",
    dataset: { messageId: "local_1" },
    style: {},
    classList: { add() {}, remove() {} },
    setAttribute(name, value) {
      if (name === "data-message-id") this.dataset.messageId = value;
    },
    getAttribute(name) {
      if (name === "data-message-id") return this.dataset.messageId || "";
      return "";
    },
    querySelectorAll(selector) {
      return selector === "[data-message-id]" ? [bubble] : [];
    },
    addEventListener() {},
    removeEventListener() {}
  };
  const chat = {
    children: [target],
    dataset: {},
    scrollTop: 860,
    scrollHeight: 1000,
    clientHeight: 140,
    appendChild(child) { this.children.push(child); return child; },
    querySelector(selector) {
      if (selector.includes("local_1") && bubble.dataset.messageId === "local_1") return bubble;
      if (selector.includes("m_server_echo") && bubble.dataset.messageId === "m_server_echo") return bubble;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "article.message") return this.children;
      return [];
    },
    set innerHTML(value) {
      cleared = true;
      this._html = value;
      this.children = [];
    },
    get innerHTML() {
      return this._html || "";
    }
  };
  const s = loadSocial({ elementsById: { chat } });
  let renders = 0;
  s.initSocialModule({
    getState: () => ({ runtime: {} }),
    render: () => {
      renders += 1;
      s.renderConversationChat(chat);
    },
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.myUserId = "u_me";
  s.moduleState.activeConversationId = "g_echo";
  s.moduleState.conversations = [{ id: "g_echo", type: "group", name: "Echo" }];
  s.moduleState.messageCache.set("g_echo", {
    messages: [{
      id: "local_1",
      seq: 0.000001,
      turn_id: "turn_1",
      sender_kind: "user",
      sender_ref: "u_me",
      body_md: "hello once",
      status: "sending",
      _localPending: true
    }],
    maxSeq: 0
  });

  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "g_echo",
      message: {
        id: "m_server_echo",
        seq: 1,
        turn_id: "turn_1",
        sender_kind: "user",
        sender_ref: "u_me",
        body_md: "hello once"
      }
    }
  });

  const entry = s.moduleState.messageCache.get("g_echo");
  assert.equal(renders, 1);
  assert.equal(cleared, false, "self echo should not rebuild the just-sent bubble");
  assert.deepEqual(entry.messages.map((m) => m.id), ["m_server_echo"]);
  assert.equal(target.dataset.messageId, "m_server_echo");
  assert.equal(bubble.dataset.messageId, "m_server_echo");
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

test("handleCloudEvent keeps bot replies separate from pending user echoes with the same turn_id", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.activeConversationId = "botc_private";
  s.moduleState.conversations = [{ id: "botc_private", type: "bot", name: "Claude Code", decorations: { botId: "claude" } }];
  s.moduleState.messageCache.set("botc_private", {
    maxSeq: 0,
    messages: [{
      id: "local_1",
      seq: Number.MAX_SAFE_INTEGER,
      turn_id: "turn_1",
      sender_kind: "user",
      sender_ref: "u_me",
      body_md: "你好",
      status: "sending",
      _localPending: true
    }]
  });

  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "botc_private",
      message: {
        id: "m_bot_1",
        seq: 2,
        turn_id: "turn_1",
        sender_kind: "bot",
        sender_ref: "claude",
        body_md: "我在"
      }
    }
  });

  const entry = s.moduleState.messageCache.get("botc_private");
  assert.deepEqual(entry.messages.map((m) => m.id), ["m_bot_1", "local_1"]);
  assert.equal(entry.messages.find((m) => m.id === "local_1")._localPending, true);
  assert.equal(entry.messages.find((m) => m.id === "m_bot_1").sender_kind, "bot");
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

test("appendMessageToActiveChat animates new tail messages only when the chat is near bottom", () => {
  const chat = {
    children: [],
    dataset: {},
    scrollTop: 850,
    scrollHeight: 1000,
    clientHeight: 140,
    appendChild(child) {
      this.children.push(child);
      this.scrollHeight = 1090;
      return child;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const s = loadSocial({ elementsById: { chat } });
  installCloudConversationSource(s.__mockWindow);
  s.initSocialModule({ getState: () => ({ runtime: {} }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.activeConversationId = "dm:u_me:u_friend";
  s.moduleState.conversations = [{ id: "dm:u_me:u_friend", type: "dm", name: "Friend" }];

  const msg = {
    id: "m_tail",
    seq: 3,
    conversation_id: "dm:u_me:u_friend",
    sender_kind: "user",
    sender_ref: "u_friend",
    body_md: "new tail",
    created_at: "2026-06-22T10:00:00.000Z"
  };
  s.moduleState.messageCache.set("dm:u_me:u_friend", { messages: [msg], maxSeq: 3 });

  s._internalCtx.appendMessageToActiveChat(msg, { stick: false });

  assert.equal(chat.children.length, 1);
  assert.match(chat.children[0].className, /\bmessage-tail-enter\b/);
  assert.equal(chat.scrollTop, chat.scrollHeight);
});

test("appendMessageToActiveChat leaves history readers in place without tail animation", () => {
  const chat = {
    children: [],
    dataset: {},
    scrollTop: 420,
    scrollHeight: 1000,
    clientHeight: 140,
    appendChild(child) {
      this.children.push(child);
      this.scrollHeight = 1090;
      return child;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const s = loadSocial({ elementsById: { chat } });
  installCloudConversationSource(s.__mockWindow);
  s.initSocialModule({ getState: () => ({ runtime: {} }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.activeConversationId = "dm:u_me:u_friend";
  s.moduleState.conversations = [{ id: "dm:u_me:u_friend", type: "dm", name: "Friend" }];

  const msg = {
    id: "m_history",
    seq: 4,
    conversation_id: "dm:u_me:u_friend",
    sender_kind: "user",
    sender_ref: "u_friend",
    body_md: "do not pull",
    created_at: "2026-06-22T10:01:00.000Z"
  };
  s.moduleState.messageCache.set("dm:u_me:u_friend", { messages: [msg], maxSeq: 4 });

  s._internalCtx.appendMessageToActiveChat(msg, { stick: false });

  assert.equal(chat.children.length, 1);
  assert.doesNotMatch(chat.children[0].className, /\bmessage-tail-enter\b/);
  assert.equal(chat.scrollTop, 420);
});

test("appendMessageToActiveChat FLIPs existing rows when bottom follow changes scroll", () => {
  const animations = [];
  let chat;
  const existing = {
    className: "message assistant",
    dataset: { messageId: "m_old" },
    style: {},
    classList: { add() {}, remove() {} },
    getAttribute(name) {
      if (name === "data-message-id") return this.dataset.messageId || "";
      return "";
    },
    getBoundingClientRect() {
      return { top: 1050 - chat.scrollTop, height: 42 };
    },
    animate(keyframes, options) {
      animations.push({ keyframes, options });
      return {};
    },
    addEventListener() {},
    removeEventListener() {}
  };
  chat = {
    children: [existing],
    dataset: {},
    scrollTop: 850,
    scrollHeight: 1000,
    clientHeight: 140,
    appendChild(child) {
      this.children.push(child);
      this.scrollHeight = 1090;
      return child;
    },
    querySelector() { return null; },
    querySelectorAll(selector) {
      assert.equal(selector, "article.message");
      return [existing];
    }
  };
  const s = loadSocial({ elementsById: { chat } });
  installCloudConversationSource(s.__mockWindow);
  s.initSocialModule({ getState: () => ({ runtime: {} }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.activeConversationId = "dm:u_me:u_friend";
  s.moduleState.conversations = [{ id: "dm:u_me:u_friend", type: "dm", name: "Friend" }];

  const msg = {
    id: "m_tail_shift",
    seq: 5,
    conversation_id: "dm:u_me:u_friend",
    sender_kind: "user",
    sender_ref: "u_friend",
    body_md: "new tail shift",
    created_at: "2026-06-22T10:02:00.000Z"
  };
  s.moduleState.messageCache.set("dm:u_me:u_friend", { messages: [msg], maxSeq: 5 });

  s._internalCtx.appendMessageToActiveChat(msg, { stick: false });

  assert.equal(animations.length, 1);
  assert.equal(JSON.stringify(animations[0].keyframes), JSON.stringify([
    { transform: "translateY(240px)" },
    { transform: "translateY(0)" }
  ]));
  assert.equal(animations[0].options.duration, 190);
});

test("renderConversationChat layout shifts animate existing message rows after rerender", () => {
  const s = loadSocial();
  const animations = [];
  const makeArticle = (attrs = {}) => ({
    className: attrs.className || "message assistant",
    dataset: attrs.dataset || { messageId: attrs.messageId || "" },
    style: {},
    classList: { add() {}, remove() {} },
    getAttribute(name) {
      if (name === "data-message-id") return this.dataset.messageId || "";
      if (name === "data-message-layout-key") return this.dataset.messageLayoutKey || "";
      return "";
    },
    getBoundingClientRect: () => ({ top: attrs.top || 0, height: 40 }),
    animate(keyframes, options) {
      animations.push({ keyframes, options });
      return {};
    },
    addEventListener() {},
    removeEventListener() {}
  });
  const beforeArticle = makeArticle({ messageId: "m_shift", top: 160 });
  const afterArticle = makeArticle({ messageId: "m_shift", top: 112 });
  const before = s._internalCtx.captureMessageLayout({
    querySelectorAll(selector) {
      assert.equal(selector, "article.message");
      return [beforeArticle];
    }
  });

  const animated = s._internalCtx.animateMessageLayoutShift({
    querySelectorAll(selector) {
      assert.equal(selector, "article.message");
      return [afterArticle];
    }
  }, before);

  assert.equal(animated, true);
  assert.equal(animations.length, 1);
  assert.equal(JSON.stringify(animations[0].keyframes), JSON.stringify([
    { transform: "translateY(48px)" },
    { transform: "translateY(0)" }
  ]));
  assert.equal(animations[0].options.duration, 190);
  assert.equal(
    s._internalCtx.messageLayoutKey(makeArticle({
      className: "message assistant streaming",
      dataset: { messageLayoutKey: "cloud-agent-stream-car_1" }
    })),
    "cloud-agent-stream-car_1"
  );
});

test("animateRemoveMessageFromActiveChat FLIPs remaining rows into the deleted gap", async () => {
  const animations = [];
  let removed = false;
  const makeArticle = (attrs = {}) => ({
    className: attrs.className || "message assistant",
    dataset: { messageId: attrs.messageId || "" },
    style: {},
    classList: { add() {}, remove() {} },
    getAttribute(name) {
      if (name === "data-message-id") return this.dataset.messageId || "";
      return "";
    },
    getBoundingClientRect: () => ({
      top: typeof attrs.top === "function" ? attrs.top() : attrs.top,
      left: 24,
      width: 320,
      height: attrs.height || 48
    }),
    cloneNode() {
      return {
        className: this.className,
        dataset: { ...this.dataset },
        style: {},
        classList: { add() {}, remove() {} },
        setAttribute() {},
        addEventListener() {},
        removeEventListener() {},
        remove() {}
      };
    },
    remove() {
      removed = true;
    },
    animate(keyframes, options) {
      animations.push({ keyframes, options });
      return {};
    },
    addEventListener() {},
    removeEventListener() {}
  });
  const target = makeArticle({ messageId: "m_remove", top: 120, height: 52 });
  const below = makeArticle({ messageId: "m_below", top: () => (removed ? 126 : 182), height: 44 });
  const bubble = { closest: () => target };
  const chat = {
    dataset: {},
    scrollTop: 200,
    scrollHeight: 1000,
    clientHeight: 400,
    querySelector(selector) {
      if (selector.includes("m_remove")) return bubble;
      return null;
    },
    querySelectorAll(selector) {
      assert.equal(selector, "article.message");
      return removed ? [below] : [target, below];
    }
  };
  const s = loadSocial({ elementsById: { chat } });

  const animated = await s._internalCtx.animateRemoveMessageFromActiveChat("m_remove");

  assert.equal(animated, true);
  assert.equal(removed, true);
  assert.equal(animations.length, 1);
  assert.equal(JSON.stringify(animations[0].keyframes), JSON.stringify([
    { transform: "translateY(56px)" },
    { transform: "translateY(0)" }
  ]));
  assert.equal(animations[0].options.duration, 190);
});

test("renderConversationChat renders image attachments inside the bubble before message text", () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  s.moduleState.myUserId = "u_me";
  s.moduleState.activeConversationId = "dm_u_me_u_them";
  s.moduleState.conversations = [{ id: "dm_u_me_u_them", type: "dm", name: "DM" }];
  s.moduleState.messageCache.set("dm_u_me_u_them", {
    messages: [{
      id: "msg_img_1",
      sender_kind: "user",
      sender_ref: "u_me",
      body_md: "hello with image",
      created_at: "2026-06-18T10:00:00.000Z",
      attachments: [{
        id: "att_1",
        kind: "image",
        name: "image.png",
        thumbnailDataUrl: "data:image/png;base64,cG5n"
      }]
    }],
    maxSeq: 1
  });

  const chat = {
    children: [],
    dataset: {},
    appendChild(child) { this.children.push(child); return child; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
  s.renderConversationChat(chat);

  assert.equal(chat.children.length, 1);
  const html = chat.children[0].innerHTML;
  const bubbleStart = html.indexOf('<div class="bubble"');
  const bodyIndex = html.indexOf("hello with image");
  const attachmentIndex = html.indexOf("message-attachments");
  const bubbleEnd = html.indexOf("</div>", bodyIndex);
  assert.ok(bubbleStart >= 0, "bubble rendered");
  assert.ok(attachmentIndex > bubbleStart, "attachment block is inside bubble");
  assert.ok(attachmentIndex < bodyIndex, "attachment block appears before message text");
  assert.ok(attachmentIndex < bubbleEnd, "attachment block closes inside bubble");
});

test("renderConversationChat hydrates cloud image URL previews before rendering thumbnails", async () => {
  const chat = {
    children: [],
    dataset: {},
    appendChild(child) { this.children.push(child); return child; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
  const s = loadSocial({ elementsById: { chat } });
  installCloudConversationSource(s.__mockWindow);
  const fetched = [];
  s.__mockWindow.mia.fetchFileAttachment = async (request) => {
    fetched.push(request);
    return {
      id: "att_2",
      kind: "image",
      name: "cloud.png",
      url: request.url,
      thumbnailDataUrl: "data:image/png;base64,cG5n"
    };
  };
  s.moduleState.myUserId = "u_me";
  s.moduleState.activeConversationId = "dm_u_me_u_them";
  s.moduleState.conversations = [{ id: "dm_u_me_u_them", type: "dm", name: "DM" }];
  s.moduleState.messageCache.set("dm_u_me_u_them", {
    messages: [{
      id: "msg_img_2",
      sender_kind: "user",
      sender_ref: "u_them",
      body_md: "remote image",
      created_at: "2026-06-18T10:01:00.000Z",
      attachments: [{
        id: "att_2",
        kind: "image",
        name: "cloud.png",
        url: "/api/files/file_att_2"
      }]
    }],
    maxSeq: 1
  });

  s.renderConversationChat(chat);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0]?.url, "/api/files/file_att_2");
  await flushPromises();

  const html = chat.children[0]?.innerHTML || "";
  assert.match(html, /class="message-attachment image"/);
  assert.match(html, /<img class="message-attachment-thumb" src="data:image\/png;base64,cG5n"/);
  assert.ok(html.indexOf("message-attachments") < html.indexOf("remote image"));
});

test("renderConversationChat resolves self and bot avatars from one contact context", () => {
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
        }
      }
    }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.myUserId = "u_me";
  s.moduleState.myUsername = "boss";
  s.moduleState.bots = [{
    key: "mia",
    name: "Mia",
    avatarImage: "data:mia-avatar",
    avatarCrop: { x: 57, y: 8, zoom: 1.5 },
    color: "#5e5ce6"
  }];
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
  assert.match(chat.children[0].innerHTML, /data:cloud-avatar/);
  assert.match(chat.children[1].innerHTML, /data:mia-avatar/);
  assert.doesNotMatch(chat.children[0].innerHTML, /data:self-avatar/);
});

test("renderConversationChat uses cloud bot avatar when no local bot exists", () => {
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

test("renderConversationChat preserves an owned bot's explicit avatar color", () => {
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
        cloud: { user: { id: "u_me", username: "boss" } }
      }
    }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.myUserId = "u_me";
  s.moduleState.myUsername = "boss";
  s.moduleState.bots = [{ key: "ha", name: "哈哈哈", avatarImage: "", color: "#aa88dd" }];
  s.moduleState.activeConversationId = "botc_u_me_ha";
  s.moduleState.conversations = [{ id: "botc_u_me_ha", type: "bot", name: "哈哈哈", decorations: { botId: "ha" } }];
  s.moduleState.messageCache.set("botc_u_me_ha", {
    maxSeq: 1,
    messages: [{ id: "m_bot", seq: 1, sender_kind: "bot", sender_ref: "ha", body_md: "hello", created_at: "" }]
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
  assert.match(chat.children[0].innerHTML, /background-color:#aa88dd/);
});

test("renderConversationChat hides sender title in private bot conversations", () => {
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
  assert.doesNotMatch(chat.children[0].innerHTML, /bubble-sender/);
  assert.doesNotMatch(chat.children[0].innerHTML, /name-with-badge/);
  assert.doesNotMatch(chat.children[0].innerHTML, /⭐/);
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
  assert.match(chat.children[0].className, /\bgroup-message\b/);
  assert.match(chat.children[0].innerHTML, /name-with-badge/);
  assert.match(chat.children[0].innerHTML, /name-with-badge-badge-emoji/);
  assert.match(chat.children[0].innerHTML, /⭐/);
});

test("renderConversationChat renders group bot ordered content blocks before trace fallback", () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  installSocialGroups(s.__mockWindow);
  s.__mockWindow.miaMemberColor = { memberAccentColor: () => "#2563eb" };
  s.__mockWindow.miaTraceBlocks = {
    renderAssistantContentBlocks({ blocks, renderTextBlock }) {
      return blocks.map((block) => {
        if (block.type === "text") return renderTextBlock(block);
        if (block.type === "thinking") return `<div class="ordered-thinking">${block.text}</div>`;
        if (block.type === "tool") return `<div class="ordered-tool">${block.name}</div>`;
        return "";
      }).join("");
    },
    renderTraceBlocks() {
      return '<div class="legacy-trace">legacy</div>';
    }
  };
  s.initSocialModule({ getState: () => ({ runtime: {} }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.activeConversationId = "g_blocks";
  s.moduleState.conversations = [{ id: "g_blocks", type: "group", name: "Squad" }];
  s._internalCtx.conversationMembersCache.set("g_blocks", [{
    member_kind: "bot",
    member_ref: "mia",
    identity: {
      kind: "bot",
      id: "mia",
      displayName: "Mia",
      avatar: { image: "", crop: null, color: "#5e5ce6", text: "Mi" }
    }
  }]);
  s.moduleState.messageCache.set("g_blocks", {
    maxSeq: 1,
    messages: [{
      id: "m_group_blocks",
      seq: 1,
      sender_kind: "bot",
      sender_ref: "mia",
      body_md: "我先看目录。\n\n结论是已确认。",
      created_at: "",
      trace_json: JSON.stringify({ reasoning: "legacy", tools: [{ name: "legacy-tool", status: "completed" }] }),
      content_blocks_json: JSON.stringify([
        { type: "thinking", id: "think_1", text: "检查上下文", status: "completed" },
        { type: "text", id: "text_1", text: "我先看目录。" },
        { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed" },
        { type: "text", id: "text_2", text: "结论是已确认。" }
      ])
    }]
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

  const html = chat.children[0].innerHTML;
  assert.ok(html.indexOf("检查上下文") < html.indexOf("我先看目录。"));
  assert.ok(html.indexOf("我先看目录。") < html.indexOf("shell"));
  assert.ok(html.indexOf("shell") < html.indexOf("结论是已确认。"));
  assert.doesNotMatch(html, /legacy-trace/);
  assert.doesNotMatch(html, /legacy-tool/);
});

test("renderConversationChat initializes group sender lottie status badges", () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  installNameWithBadge(s.__mockWindow);
  installSocialGroups(s.__mockWindow);
  const initCalls = [];
  s.__mockWindow.miaLottieIcons = { init(root) { initCalls.push(root); } };
  s.__mockWindow.miaMemberColor = { memberAccentColor: () => "#2563eb" };
  s.__mockWindow.miaAvatar = {
    avatarThumbBackgroundStyle: (image, _crop, color) => image
      ? `background-color:transparent;background-image:url('${image}');`
      : `background-color:${color || "#5e5ce6"};`
  };
  s.initSocialModule({ getState: () => ({ runtime: {} }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.activeConversationId = "g_lottie_badge";
  s.moduleState.conversations = [{ id: "g_lottie_badge", type: "group", name: "Squad" }];
  s._internalCtx.conversationMembersCache.set("g_lottie_badge", [{
    member_kind: "bot",
    member_ref: "mia",
    identity: {
      kind: "bot",
      id: "mia",
      displayName: "Mia",
      avatar: { image: "", crop: null, color: "#5e5ce6", text: "Mi" },
      statusBadge: { kind: "lottie", assetId: "rainbow", label: "Active" }
    }
  }]);
  s.moduleState.messageCache.set("g_lottie_badge", {
    maxSeq: 1,
    messages: [{ id: "m_group_lottie_badge", seq: 1, sender_kind: "bot", sender_ref: "mia", body_md: "hello", created_at: "" }]
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
  assert.match(chat.children[0].innerHTML, /name-with-badge-badge-lottie/);
  assert.match(chat.children[0].innerHTML, /data-lottie="rainbow"/);
  assert.ok(initCalls.length >= 1, "lottie status badge renderer should be initialized after chat render");
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

test("renderConversationChat hashes empty self avatar color by cloud user id", () => {
  const { memberAccentColor } = require("../packages/shared/avatar.js");
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
        cloud: { user: { id: "user_me", username: "755439", avatarImage: "", avatarColor: "" } },
        user: { displayName: "755439", avatarText: "75", avatarImage: "", avatarColor: "" }
      }
    }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.myUserId = "user_me";
  s.moduleState.myUsername = "755439";
  s.moduleState.activeConversationId = "botc_user_me_ha";
  s.moduleState.conversations = [{ id: "botc_user_me_ha", type: "bot", name: "哈哈哈", decorations: { botId: "ha" } }];
  s.moduleState.messageCache.set("botc_user_me_ha", {
    maxSeq: 1,
    messages: [{ id: "m_user", seq: 1, sender_kind: "user", sender_ref: "user_me", body_md: "?", created_at: "" }]
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
  assert.match(chat.children[0].innerHTML, new RegExp(`background-color:${memberAccentColor("user_me")}`));
  assert.doesNotMatch(chat.children[0].innerHTML, /background-color:#5e5ce6/);
});

test("sendInActiveConversation posts group mentions in cloud bot format", async () => {
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

test("handleCloudEvent conversation.message_deleted removes the cached message", () => {
  const s = loadSocial();
  let renders = 0;
  s.initSocialModule({ getState: () => ({}), render: () => { renders += 1; }, els: {}, appendTransientChat: () => {} });
  s.moduleState.activeConversationId = "dm:other";
  s.moduleState.messageCache.set("dm:u_a:u_b", {
    maxSeq: 2,
    messages: [
      { id: "m1", seq: 1, body_md: "keep" },
      { id: "m2", seq: 2, body_md: "delete me" }
    ]
  });

  s.handleCloudEvent({
    type: "conversation.message_deleted",
    payload: { conversationId: "dm:u_a:u_b", messageId: "m2" }
  });

  const entry = s.moduleState.messageCache.get("dm:u_a:u_b");
  assert.deepEqual(entry.messages.map((message) => message.id), ["m1"]);
  assert.equal(entry.maxSeq, 2);
  assert.equal(renders, 1);
});

test("deleteConversationMessage keeps the active DOM transaction fresh through the follow-up render", async () => {
  const animations = [];
  let removed = false;
  let cleared = false;
  let chat;
  const makeArticle = (attrs = {}) => ({
    className: "message assistant",
    dataset: { messageId: attrs.messageId || "" },
    style: {},
    classList: { add() {}, remove() {} },
    getAttribute(name) {
      if (name === "data-message-id") return this.dataset.messageId || "";
      return "";
    },
    getBoundingClientRect: () => ({
      top: typeof attrs.top === "function" ? attrs.top() : attrs.top,
      left: 24,
      width: 320,
      height: attrs.height || 48
    }),
    cloneNode() {
      return {
        className: this.className,
        dataset: { ...this.dataset },
        style: {},
        classList: { add() {}, remove() {} },
        setAttribute() {},
        addEventListener() {},
        removeEventListener() {},
        remove() {}
      };
    },
    remove() {
      removed = true;
      chat.children = chat.children.filter((child) => child !== this);
    },
    animate(keyframes, options) {
      animations.push({ keyframes, options });
      return {};
    },
    addEventListener() {},
    removeEventListener() {}
  });
  const target = makeArticle({ messageId: "m2", top: 120, height: 52 });
  const below = makeArticle({ messageId: "m3", top: () => (removed ? 126 : 182), height: 44 });
  const bubble = { closest: () => target };
  chat = {
    children: [target, below],
    dataset: {},
    scrollTop: 200,
    scrollHeight: 1000,
    clientHeight: 400,
    querySelector(selector) {
      if (!removed && selector.includes("m2")) return bubble;
      return null;
    },
    querySelectorAll(selector) {
      if (selector !== "article.message") return [];
      return this.children;
    },
    set innerHTML(value) {
      cleared = true;
      this._html = value;
      this.children = [];
    },
    get innerHTML() {
      return this._html || "";
    }
  };
  const s = loadSocial({ elementsById: { chat } });
  let renders = 0;
  s.initSocialModule({
    getState: () => ({ runtime: {} }),
    render: () => {
      renders += 1;
      s.renderConversationChat(chat);
    },
    els: {},
    appendTransientChat: () => {}
  });
  s.__mockWindow.mia.social = {
    deleteConversationMessage: async () => ({ ok: true })
  };
  s.moduleState.activeConversationId = "dm:u_a:u_b";
  s.moduleState.conversations = [{ id: "dm:u_a:u_b", type: "dm", name: "Friend" }];
  s.moduleState.messageCache.set("dm:u_a:u_b", {
    maxSeq: 3,
    messages: [
      { id: "m1", seq: 1, body_md: "keep 1" },
      { id: "m2", seq: 2, body_md: "delete me" },
      { id: "m3", seq: 3, body_md: "keep 2" }
    ]
  });

  await s.deleteConversationMessage("dm:u_a:u_b", "m2");

  assert.equal(renders, 1);
  assert.equal(removed, true);
  assert.equal(cleared, false, "follow-up render should not rebuild over the in-flight removal animation");
  assert.deepEqual(chat.children.map((child) => child.dataset.messageId), ["m3"]);
  assert.deepEqual(s.moduleState.messageCache.get("dm:u_a:u_b").messages.map((message) => message.id), ["m1", "m3"]);
  assert.equal(animations.length, 1);
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

test("cloud run streaming keeps canonical text while smoothing displayed text", () => {
  const frames = [];
  const s = loadSocial({
    requestAnimationFrame: (fn) => {
      frames.push(fn);
      return frames.length;
    }
  });
  s.__mockWindow.miaAssistantContentBlocks = require("../src/shared/assistant-content-blocks.js");
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.conversations = [{ id: "botc_u_a_mia", type: "bot", decorations: { botId: "mia" } }];

  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "botc_u_a_mia", runId: "car_smooth", botId: "mia" },
  });
  s.moduleState.activeConversationId = "botc_u_a_mia";
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_smooth", event: { type: "text_delta", text: "abcdef" } },
  });

  const run = s.moduleState.cloudAgentRunsByConversation.get("botc_u_a_mia");
  assert.equal(run.text, "abcdef");
  assert.equal(run.displayText, "");

  while (frames.length && run.displayText !== "abc") frames.shift()();
  assert.equal(run.displayText, "abc");

  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_smooth", event: { type: "run.completed" } },
  });
  assert.equal(run.displayText, "abcdef");
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

test("stale permission decision clears the banner instead of posting an error", async () => {
  const disabled = [];
  const banner = {
    dataset: { requestId: "perm_stale" },
    addEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    set innerHTML(value) { this._html = value; },
    get innerHTML() { return this._html || ""; },
    querySelectorAll(selector) {
      assert.equal(selector, "button[data-permission-decision]");
      return disabled;
    }
  };
  let transient = "";
  const s = loadSocial({ elementsById: { agentPermissionBanner: banner } });
  disabled.push({ disabled: false }, { disabled: false });
  s.__mockWindow.mia.respondChatPermission = async () => ({ ok: false, error: "permission request not found" });
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: (_role, text) => { transient = text; } });
  s.moduleState.activeConversationId = "botc_u_a_mia";
  const run = s._internalCtx.cloudRunFor("botc_u_a_mia", "car_perm");
  s._internalCtx.addRunPermission(run, { requestId: "perm_stale", title: "Codex 想执行命令" });
  s._internalCtx.renderAgentPermissionBanner();

  await s._internalCtx.submitPermissionDecision({ dataset: { permissionDecision: "allow_once" } });

  assert.equal(run.pendingPermissions.length, 0);
  assert.equal(s.moduleState.pendingPermissionsById.has("perm_stale"), false);
  assert.equal(transient, "");
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
  let renders = 0;
  const s = loadSocial({
    requestAnimationFrame: (fn) => {
      scheduled.push(fn);
      return scheduled.length;
    }
  });
  s.initSocialModule({
    getState: () => ({}),
    render: () => { renders += 1; },
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
  assert.equal(renders, 1);
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

test("cloud agent run cancelling keeps the conversation busy until the terminal event", () => {
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
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "message.delta", delta: "我先停一下。" } },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "run.cancelling" } },
  });

  assert.equal(s.activeConversationRun().status, "cancelling");
  assert.equal(s.conversationRunIsRunning("botc_u_a_mia"), false);
  assert.equal(s.conversationRunIsBusy("botc_u_a_mia"), true);
  assert.equal(s.activeConversationCanSend(), false);

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
  assert.match(chat.children.at(-1).innerHTML, /正在中断/);
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

test("renderConversationChat renders active cloud run status at the bottom of the stream", () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
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
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "tool_call_started", id: "tool_1", name: "shell", preview: "pwd" } },
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
  assert.match(chat.children[0].innerHTML, /agent-run-status/);
  assert.match(chat.children[0].innerHTML, /agent-run-status-loader/);
  assert.equal((chat.children[0].innerHTML.match(/agent-run-status-orb-dot/g) || []).length, 25);
  assert.match(chat.children[0].innerHTML, /agent-run-status-orb-dot is-core/);
  assert.match(chat.children[0].innerHTML, /data-orb-row="2" data-orb-col="2"/);
  assert.match(chat.children[0].innerHTML, /data-orb-ring="0"/);
  assert.match(chat.children[0].innerHTML, /data-orb-angle="0"/);
  assert.match(chat.children[0].innerHTML, /agent-run-status-loading-dots/);
  assert.match(chat.children[0].innerHTML, /--agent-run-animation-age:\d+ms/);
  assert.doesNotMatch(chat.children[0].innerHTML, /正在执行 shell/);
  assert.match(chat.children[0].innerHTML, /0s/);
});

test("cloud run streaming updates the active row in place without rebuilding chat", () => {
  const frames = [];
  const chat = {
    dataset: {},
    children: [],
    clearCount: 0,
    appendChild(child) { this.children.push(child); return child; },
    querySelector(selector) {
      if (selector === ".message.streaming") {
        return this.children.find((child) => String(child.className || "").includes("streaming")) || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "article.message") return this.children;
      return [];
    },
    set innerHTML(value) {
      this.clearCount += 1;
      this.children = [];
      this._html = String(value || "");
    },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 400,
  };
  const s = loadSocial({
    elementsById: { chat },
    requestAnimationFrame: (fn) => {
      frames.push(fn);
      return frames.length;
    }
  });
  s.__mockWindow.miaAssistantContentBlocks = require("../src/shared/assistant-content-blocks.js");
  installCloudConversationSource(s.__mockWindow);
  s.initSocialModule({ getState: () => ({ user: { id: "u_a" }, bots: [{ key: "mia", name: "Mia" }] }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_a";
  s.moduleState.activeConversationId = "botc_u_a_mia";
  s.moduleState.conversations = [{ id: "botc_u_a_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } }];
  s.moduleState.messageCache.set("botc_u_a_mia", { messages: [], maxSeq: 0 });
  const run = s._internalCtx.cloudRunFor("botc_u_a_mia", "car_1");
  run.botId = "mia";
  run.status = "running";
  run.text = "hello";
  run.displayText = "hello";
  run.createdAt = "2026-06-22T10:00:00.000Z";

  s.renderConversationChat(chat);
  const initialClearCount = chat.clearCount;
  const initialArticle = chat.children[0];
  assert.match(initialArticle.innerHTML, /hello/);
  frames.length = 0;

  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "text_delta", text: " world" } },
  });
  assert.equal(frames.length, 1);
  frames.shift()(16);

  assert.equal(chat.clearCount, initialClearCount);
  assert.strictEqual(chat.children[0], initialArticle);
  assert.match(chat.children[0].innerHTML, /hello wo/);
  assert.doesNotMatch(chat.children[0].innerHTML, /hello world/);

  assert.equal(frames.length, 1);
  frames.shift()(32);

  assert.equal(chat.clearCount, initialClearCount);
  assert.strictEqual(chat.children[0], initialArticle);
  assert.match(chat.children[0].innerHTML, /hello world/);
});

test("phase orb opacity follows the DotmCircular6 resolver thresholds", () => {
  const s = loadSocial();
  const opacityForCell = s._internalCtx.phaseOrbOpacityForCell;
  assert.equal(typeof opacityForCell, "function");

  assert.equal(opacityForCell(0, 0, 0), null);
  assert.equal(opacityForCell(2, 2, 0), 0.34);
  assert.equal(opacityForCell(0, 3, 0), 0.96);
  assert.equal(opacityForCell(3, 2, 0), 0.08);
  assert.equal(opacityForCell(3, 2, 0.5), 0.34);
});

test("cloud run status timer updates the status line without rebuilding animation nodes", () => {
  let intervalCallback = null;
  const statusLabel = { textContent: "" };
  const statusElapsed = { textContent: "" };
  const statusEl = {
    className: "agent-run-status is-running is-loading",
    dataset: { runStatus: "running" },
    querySelector(selector) {
      if (selector === ".agent-run-status-label") return statusLabel;
      if (selector === ".agent-run-status-elapsed") return statusElapsed;
      return null;
    },
  };
  const chat = {
    dataset: {},
    children: [],
    clearCount: 0,
    appendChild(child) { this.children.push(child); return child; },
    querySelector(selector) {
      if (selector === ".message.streaming .agent-run-status") return statusEl;
      return null;
    },
    set innerHTML(value) {
      this.clearCount += 1;
      this.children = [];
      this._html = String(value || "");
    },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
  const s = loadSocial({
    elementsById: { chat },
    setInterval: (fn) => {
      intervalCallback = fn;
      return 1;
    },
    clearInterval: () => {},
  });
  installCloudConversationSource(s.__mockWindow);
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
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "tool_call_started", id: "tool_1", name: "shell", preview: "pwd" } },
  });
  s.renderConversationChat(chat);

  const initialClearCount = chat.clearCount;
  const initialArticle = chat.children[0];
  assert.equal(typeof intervalCallback, "function");

  intervalCallback();

  assert.equal(chat.clearCount, initialClearCount);
  assert.strictEqual(chat.children[0], initialArticle);
  assert.match(statusLabel.textContent, /\S/);
  assert.match(statusElapsed.textContent, /\d+s/);
});

test("run status labels use stable rotating Chinese phrase pools", () => {
  const s = loadSocial();
  const pools = s._internalCtx.agentRunStatusPhrasePools;
  const total = Object.values(pools).reduce((sum, items) => sum + items.length, 0);
  assert.equal(total, 120);
  assert.equal(pools.tool.length, 20);

  const run = {
    runId: "car_shell_rotate",
    status: "running",
    tools: [{ id: "tool_1", name: "shell", status: "running", preview: "pwd" }]
  };
  const first = s._internalCtx.runActivityLabel(run, { elapsedMs: 0 });
  const firstAgain = s._internalCtx.runActivityLabel(run, { elapsedMs: 8000 });
  const second = s._internalCtx.runActivityLabel(run, { elapsedMs: 9000 });

  assert.notEqual(first, "正在执行 shell");
  assert.equal(first, firstAgain);
  assert.notEqual(first, second);
  assert.ok(pools.tool.includes(first));
  assert.ok(pools.tool.includes(second));
});

test("run status labels ignore generic local engine startup status", () => {
  const s = loadSocial();
  const pools = s._internalCtx.agentRunStatusPhrasePools;
  const run = {
    runId: "car_generic_start_status",
    status: "running",
    statusText: "本机 Codex 已开始运行。",
    tools: []
  };

  const label = s._internalCtx.runActivityLabel(run, { elapsedMs: 0 });

  assert.notEqual(label, "本机 Codex 已开始运行。");
  assert.ok(pools.general.includes(label));

  run.statusText = "本机codex已经开始运行";
  const compactLabel = s._internalCtx.runActivityLabel(run, { elapsedMs: 9000 });
  assert.notEqual(compactLabel, "本机codex已经开始运行");
  assert.ok(pools.general.includes(compactLabel));
});

test("run status labels stay sticky when the run phase changes briefly", () => {
  const s = loadSocial();
  const pools = s._internalCtx.agentRunStatusPhrasePools;
  const run = {
    runId: "car_phase_sticky",
    status: "running",
    tools: [{ id: "tool_1", name: "shell", status: "running", preview: "pwd" }]
  };

  const first = s._internalCtx.runActivityLabel(run, { elapsedMs: 0 });
  run.tools[0].status = "completed";
  run.text = "final text";

  const sticky = s._internalCtx.runActivityLabel(run, { elapsedMs: 4500 });
  const later = s._internalCtx.runActivityLabel(run, { elapsedMs: 9000 });

  assert.equal(sticky, first);
  assert.notEqual(later, first);
  assert.ok(pools.writing.includes(later));
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

test("renderConversationChat streams ordered blocks without duplicate tool chips", () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  s.__mockWindow.miaAssistantContentBlocks = require("../src/shared/assistant-content-blocks.js");
  s.__mockWindow.miaTraceBlocks = {
    renderAssistantContentBlocks({ blocks, renderTextBlock }) {
      return blocks.map((block) => {
        if (block.type === "text") return renderTextBlock(block);
        if (block.type === "tool") return `<div class="ordered-tool">${block.name}</div>`;
        if (block.type === "thinking") return `<div class="ordered-thinking">${block.text}</div>`;
        return "";
      }).join("");
    },
    renderTraceBlocks() {
      return '<div class="legacy-trace">legacy</div>';
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
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "text_delta", id: "text_1", text: "我先看目录。" } },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "tool_call_started", id: "tool_1", name: "shell", preview: "pwd" } },
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

  const html = chat.children[0].innerHTML;
  assert.match(html, /ordered-tool/);
  assert.doesNotMatch(html, /<span>TOOL<\/span>/);
  assert.doesNotMatch(html, /legacy-trace/);
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

test("renderConversationChat renders persisted trace_json on bot messages", () => {
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

test("renderConversationChat prefers ordered content blocks over top-level trace_json", () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  s.__mockWindow.miaTraceBlocks = {
    renderAssistantContentBlocks({ blocks, renderTextBlock }) {
      return blocks.map((block) => {
        if (block.type === "text") return renderTextBlock(block);
        if (block.type === "thinking") return `<div class="ordered-thinking">${block.text}</div>`;
        if (block.type === "tool") return `<div class="ordered-tool">${block.name}</div>`;
        return "";
      }).join("");
    },
    renderTraceBlocks() {
      return '<div class="legacy-trace">legacy</div>';
    }
  };
  s.initSocialModule({ getState: () => ({ user: { id: "u_a" }, bots: [{ key: "mia", name: "Mia" }] }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_a";
  s.moduleState.activeConversationId = "botc_u_a_mia";
  s.moduleState.conversations = [{ id: "botc_u_a_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } }];
  s.moduleState.messageCache.set("botc_u_a_mia", {
    messages: [{
      id: "m_blocks",
      seq: 1,
      sender_kind: "bot",
      sender_ref: "mia",
      body_md: "我先看目录。\n\n结论是已确认。",
      created_at: "",
      trace_json: JSON.stringify({ reasoning: "legacy", tools: [{ name: "legacy-tool", status: "completed" }] }),
      content_blocks_json: JSON.stringify([
        { type: "thinking", id: "think_1", text: "检查上下文", status: "completed" },
        { type: "text", id: "text_1", text: "我先看目录。" },
        { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed" },
        { type: "text", id: "text_2", text: "结论是已确认。" }
      ])
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

  const html = chat.children[0].innerHTML;
  assert.ok(html.indexOf("检查上下文") < html.indexOf("我先看目录。"));
  assert.ok(html.indexOf("我先看目录。") < html.indexOf("shell"));
  assert.ok(html.indexOf("shell") < html.indexOf("结论是已确认。"));
  assert.doesNotMatch(html, /legacy-trace/);
  assert.doesNotMatch(html, /legacy-tool/);
});

test("renderConversationChat keeps process text and appends final body for legacy ordered blocks", () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  s.__mockWindow.miaAssistantContentBlocks = require("../src/shared/assistant-content-blocks.js");
  s.__mockWindow.miaTraceBlocks = {
    renderAssistantContentBlocks({ blocks, renderTextBlock }) {
      return blocks.map((block) => {
        if (block.type === "text") return renderTextBlock(block);
        if (block.type === "tool") return `<div class="ordered-tool">${block.name}</div>`;
        return "";
      }).join("");
    },
    renderTraceBlocks() {
      return '<div class="legacy-trace">legacy</div>';
    }
  };
  s.initSocialModule({ getState: () => ({ user: { id: "u_a" }, bots: [{ key: "mia", name: "Mia" }] }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_a";
  s.moduleState.activeConversationId = "botc_u_a_mia";
  s.moduleState.conversations = [{ id: "botc_u_a_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } }];
  s.moduleState.messageCache.set("botc_u_a_mia", {
    messages: [{
      id: "m_blocks_legacy",
      seq: 1,
      sender_kind: "bot",
      sender_ref: "mia",
      body_md: "最终结论。",
      created_at: "",
      content_blocks_json: JSON.stringify([
        { type: "text", id: "text_1", text: "我先检查。" },
        { type: "tool", id: "tool_1", name: "shell", preview: "pwd", status: "completed" }
      ])
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

  const html = chat.children[0].innerHTML;
  assert.ok(html.indexOf("我先检查。") < html.indexOf("shell"));
  assert.ok(html.indexOf("shell") < html.indexOf("最终结论。"));
  assert.doesNotMatch(html, /legacy-trace/);
});

test("handleCloudEvent bot reply clears transient cloud agent stream", () => {
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

test("handleCloudEvent bot reply repaints the active header after clearing typing state", () => {
  const scheduled = [];
  let headerPaints = 0;
  const s = loadSocial({
    requestAnimationFrame: (fn) => {
      scheduled.push(fn);
      return scheduled.length;
    }
  });
  installCloudConversationSource(s.__mockWindow);
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
  scheduled.splice(0).forEach((fn) => fn());
  assert.equal(headerPaints, 1);

  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "botc_u_a_mia",
      message: { id: "m1", seq: 1, sender_kind: "bot", sender_ref: "mia", body_md: "done" },
    },
  });

  assert.equal(s.moduleState.cloudAgentRunsByConversation.has("botc_u_a_mia"), false);
  assert.equal(headerPaints, 2);
});

test("handleCloudEvent materializes a cancelled cloud run before the next outgoing message", async () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  const post = deferred();
  s.__mockWindow.mia.social = {
    postConversationMessage: async () => post.promise
  };
  s.initSocialModule({ getState: () => ({ user: { id: "u_a" }, bots: [{ key: "mia", name: "Mia" }] }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_a";
  s.moduleState.activeConversationId = "botc_u_a_mia";
  s.moduleState.conversations = [{ id: "botc_u_a_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } }];
  s.moduleState.messageCache.set("botc_u_a_mia", {
    messages: [{ id: "m_prev", seq: 1, sender_kind: "user", sender_ref: "u_a", body_md: "上一个问题" }],
    maxSeq: 1
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "botc_u_a_mia", runId: "car_cancel", botId: "mia" },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_cancel", event: { type: "message.delta", delta: "我先检查。" } },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_cancel", event: { type: "tool_call_started", id: "tool_1", name: "shell", preview: "pwd" } },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_cancel", event: { type: "run.cancelled" } },
  });

  const entry = s.moduleState.messageCache.get("botc_u_a_mia");
  assert.equal(s.moduleState.cloudAgentRunsByConversation.has("botc_u_a_mia"), false);
  assert.equal(entry.messages.length, 2);
  assert.equal(entry.messages[1].sender_kind, "bot");
  assert.equal(entry.messages[1]._localRunStatus, "cancelled");
  assert.match(entry.messages[1].body_md, /我先检查/);

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
  assert.match(chat.children[1].innerHTML, /agent-run-status is-interrupted/);
  assert.doesNotMatch(chat.children[1].innerHTML, /style="opacity:/);

  const sendPromise = s.sendInActiveConversation("新的问题");
  assert.deepEqual(entry.messages.map((msg) => msg.body_md), ["上一个问题", "我先检查。", "新的问题"]);

  post.resolve({
    ok: true,
    data: { message: { id: "m_next", seq: 2, sender_kind: "user", sender_ref: "u_a", body_md: "新的问题" } }
  });
  await sendPromise;

  assert.deepEqual(entry.messages.map((msg) => msg.body_md), ["上一个问题", "我先检查。", "新的问题"]);
  assert.equal(entry.messages[1]._localRunStatus, "cancelled");
});

test("handleCloudEvent bot reply replaces the active streaming bubble", () => {
  const chat = {
    dataset: {},
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    querySelector() { return null; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
  const s = loadSocial({ elementsById: { chat } });
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.activeConversationId = "botc_u_a_mia";
  s.moduleState.conversations = [{ id: "botc_u_a_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } }];
  s.moduleState.messageCache.set("botc_u_a_mia", { messages: [], maxSeq: 0 });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", botId: "mia" },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", event: { type: "message.delta", delta: "done" } },
  });
  s.renderConversationChat(chat);

  assert.equal(chat.children.length, 1);
  assert.match(chat.children[0].className, /streaming/);

  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "botc_u_a_mia",
      message: { id: "m1", seq: 1, sender_kind: "bot", sender_ref: "mia", body_md: "done" },
    },
  });

  assert.equal(s.moduleState.cloudAgentRunsByConversation.has("botc_u_a_mia"), false);
  assert.equal(chat.children.length, 1);
  assert.doesNotMatch(chat.children[0].className, /streaming/);
  assert.match(chat.children[0].innerHTML, /done/);
});

test("handleCloudEvent preserves transient run trace when final bot message lacks trace_json", () => {
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

test("handleCloudEvent preserves transient ordered file edits when final bot message has trace_json", () => {
  const s = loadSocial();
  s.__mockWindow.miaAssistantContentBlocks = require("../src/shared/assistant-content-blocks.js");
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "botc_u_a_mia", runId: "car_1", botId: "mia" },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: {
      conversationId: "botc_u_a_mia",
      runId: "car_1",
      event: {
        type: "file_edit",
        id: "edit_1",
        path: "mia-diff-demo.txt",
        action: "update",
        diff: "@@\n-hello mia\n+good jung",
        additions: 1,
        deletions: 1,
        status: "completed"
      }
    },
  });

  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "botc_u_a_mia",
      message: {
        id: "m1",
        seq: 1,
        sender_kind: "bot",
        sender_ref: "mia",
        body_md: "done",
        trace_json: JSON.stringify({ tools: [{ id: "tool_1", name: "shell", status: "completed", preview: "cat > mia-diff-demo.txt" }] })
      },
    },
  });

  const cached = s.moduleState.messageCache.get("botc_u_a_mia").messages[0];
  assert.equal(cached.contentBlocks.length, 2);
  assert.equal(cached.contentBlocks[0].type, "file_edit");
  assert.equal(cached.contentBlocks[0].path, "mia-diff-demo.txt");
  assert.match(cached.contentBlocks[0].diff, /-hello mia/);
  assert.equal(cached.contentBlocks[1].type, "text");
  assert.equal(cached.contentBlocks[1].text, "done");
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
    myIdentity: async () => ({ ok: true, data: { id: "u_me", username: "me" } }),
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
    listConversationMessages: async (_id, sinceSeq) => {
      listCalls.push(sinceSeq);
      return { ok: true, data: { messages: makeMessages(sinceSeq + 1, 80) } };
    },
    settingsPut: async () => ({})
  };

  await withMutedConsoleWarn(async () => {
    s.setActiveConversationId("dm:u_a:u_b");
    await flushMicrotasks();
  });

  assert.deepEqual(listCalls, [30], "warm cache → recent overlap since maxSeq - 50, not a full refetch");
  assert.equal(s.moduleState.messageCache.get("dm:u_a:u_b").messages.length, 80, "cached history merged for instant paint");
});

test("opening a conversation removes cached messages missing from the cloud overlap", async () => {
  const s = loadSocial();
  installCloudConversationSource(s.__mockWindow);
  s.__mockWindow.miaAvatar = { avatarThumbBackgroundStyle: () => "" };
  s.initSocialModule({ getState: () => ({ runtime: {} }), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.cloudSettings = { version: 1, readMarks: {}, unreadOverrides: {} };
  s.moduleState.conversations = [{ id: "dm:u_a:u_b", type: "dm" }];

  s.__mockWindow.mia.social = {
    getCachedConversationMessages: async () => ({ ok: true, data: { messages: makeMessages(1, 3) } }),
    listConversationMessages: async () => ({ ok: true, data: { messages: [makeMessages(1, 1)[0], makeMessages(3, 3)[0]] } }),
    settingsPut: async () => ({})
  };

  await withMutedConsoleWarn(async () => {
    s.setActiveConversationId("dm:u_a:u_b");
    await flushMicrotasks();
  });

  const cached = s.moduleState.messageCache.get("dm:u_a:u_b");
  assert.equal(cached.messages.map((message) => message.id).join(","), "m1,m3");
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

test("applyCloudSettings applies appearance updates from another device", () => {
  const s = loadSocial();
  const applied = [];
  s.initSocialModule({
    getState: () => ({}),
    render: () => {},
    els: {},
    appendTransientChat: () => {},
    applyCloudAppearance: (appearance) => applied.push(appearance)
  });

  s.applyCloudSettings({
    pins: [],
    readMarks: {},
    appearance: { theme: "dark", accentColor: "#112233" },
    version: 2,
    updatedAt: "2026-05-28T00:00:00.000Z"
  });

  assert.deepEqual(applied, [{ theme: "dark", accentColor: "#112233" }]);
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

test("message_appended shows a desktop notification for a fresh background message", () => {
  const s = loadSocial();
  const notifications = [];
  s.__mockWindow.miaContact = require("../packages/shared/contact.js");
  s.moduleState.conversations = [{ id: "dm:u_me:u_peer", type: "dm", name: "小明" }];
  s.moduleState.friends = [{ id: "u_peer", username: "小明" }];
  s.moduleState.activeConversationId = "dm:u_me:u_peer";
  s.initSocialModule({
    getState: () => ({ runtime: { cloud: { user: { id: "u_me", username: "me" } }, appearance: { showDesktopNotifications: true } } }),
    render: () => {},
    els: {},
    appendTransientChat: () => {},
    isWindowFocused: () => false,
    showDesktopMessageNotification: (payload) => {
      notifications.push(payload);
      return Promise.resolve({ ok: true });
    }
  });

  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "dm:u_me:u_peer",
      message: { id: "m_notify", seq: 7, body_md: "在吗", sender_kind: "user", sender_ref: "u_peer", created_at: "2026-05-28T00:04:00.000Z" }
    }
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "小明");
  assert.equal(notifications[0].body, "在吗");
  assert.equal(notifications[0].conversationId, "dm:u_me:u_peer");
  assert.equal(notifications[0].messageId, "m_notify");
});

test("message_appended skips desktop notification for the focused active conversation", () => {
  const s = loadSocial();
  const notifications = [];
  s.__mockWindow.miaContact = require("../packages/shared/contact.js");
  s.moduleState.conversations = [{ id: "dm:u_me:u_peer", type: "dm", name: "小明" }];
  s.moduleState.activeConversationId = "dm:u_me:u_peer";
  s.initSocialModule({
    getState: () => ({ runtime: { cloud: { user: { id: "u_me" } }, appearance: { showDesktopNotifications: true } } }),
    render: () => {},
    els: {},
    appendTransientChat: () => {},
    isWindowFocused: () => true,
    showDesktopMessageNotification: (payload) => { notifications.push(payload); }
  });

  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "dm:u_me:u_peer",
      message: { id: "m_focused", seq: 8, body_md: "hello", sender_kind: "user", sender_ref: "u_peer", created_at: "2026-05-28T00:05:00.000Z" }
    }
  });

  assert.equal(notifications.length, 0);
});

test("message_appended skips desktop notification when disabled or muted", () => {
  const s = loadSocial();
  const notifications = [];
  s.__mockWindow.miaContact = require("../packages/shared/contact.js");
  s.moduleState.conversations = [
    { id: "dm:u_me:u_peer", type: "dm", name: "小明" },
    { id: "dm:u_me:u_muted", type: "dm", name: "静音" }
  ];
  s.moduleState.cloudSettings = { mutedConversations: ["dm:u_me:u_muted"], readMarks: {}, unreadOverrides: {} };
  s.moduleState.activeConversationId = "dm:other";
  let enabled = false;
  s.initSocialModule({
    getState: () => ({ runtime: { cloud: { user: { id: "u_me" } }, appearance: { showDesktopNotifications: enabled } } }),
    render: () => {},
    els: {},
    appendTransientChat: () => {},
    isWindowFocused: () => false,
    showDesktopMessageNotification: (payload) => { notifications.push(payload); }
  });

  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "dm:u_me:u_peer",
      message: { id: "m_disabled", seq: 9, body_md: "disabled", sender_kind: "user", sender_ref: "u_peer", created_at: "2026-05-28T00:06:00.000Z" }
    }
  });
  enabled = true;
  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "dm:u_me:u_muted",
      message: { id: "m_muted", seq: 10, body_md: "muted", sender_kind: "user", sender_ref: "u_muted", created_at: "2026-05-28T00:07:00.000Z" }
    }
  });

  assert.equal(notifications.length, 0);
});
