// Tests for the pure state-machine functions of social.js.
// Loads the IIFE into a vm sandbox to avoid Electron/DOM deps for logic tests.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSocial() {
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
    mia: {},
    miaFellowCommands: require("../src/renderer/fellow/fellow-commands.js"),
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
    document: {
      createElement: () => mockEl(),
      getElementById: () => mockEl(),
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
  const sharedContact = fs.readFileSync(path.join(root, "src", "shared", "contact.js"), "utf8");
  const sharedKinds = fs.readFileSync(path.join(root, "src", "shared", "conversation-kinds.js"), "utf8");
  const source = fs.readFileSync(path.join(root, "src", "renderer", "message-sources", "cloud-conversation-source.js"), "utf8");
  const context = vm.createContext({ window: mockWindow, globalThis: mockWindow, console });
  vm.runInContext("globalThis.miaMessageSpec = (function(){ const module = { exports: {} }; " + sharedSpec + "; return module.exports; })();", context);
  vm.runInContext("globalThis.miaContact = (function(){ const module = { exports: {} }; " + sharedContact + "; return module.exports; })();", context);
  vm.runInContext(sharedKinds, context);
  vm.runInContext(source, context);
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
        fellows: [{ key: "alice", name: "爱丽丝" }]
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
    ensureFellowConversation: async (fellowId, body) => {
      calls.push({ kind: "ensure", fellowId, body });
      return { ok: true, data: { conversation: { id: "fellow:u_1:alice", type: "fellow" } } };
    },
    saveFellowRuntime: async (fellowId, body) => {
      calls.push({ kind: "runtime", fellowId, body });
      return { ok: true, data: { binding: { fellowId, ...body } } };
    },
    listConversations: async () => {
      calls.push({ kind: "listConversations" });
      return { ok: true, data: { conversations: [{ id: "fellow:u_1:alice", type: "fellow", name: "爱丽丝" }] } };
    },
    listConversationMessages: async () => ({ ok: true, data: { messages: [] } })
  };

  await s.bootstrapAfterLogin();

  assert.deepEqual(calls.map((call) => call.kind), ["ensure", "runtime", "listConversations"]);
  assert.equal(calls[0].fellowId, "alice");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)), { title: "爱丽丝", runtimeKind: "desktop-local" });
  assert.equal(calls[1].fellowId, "alice");
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

test("bootstrapAfterLogin syncs external fellow runtime config for web controls", async () => {
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
        fellows: [{
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
    ensureFellowConversation: async (fellowId, body) => {
      calls.push({ kind: "ensure", fellowId, body });
      return { ok: true, data: { conversation: { id: "fellow:u_1:codex", type: "fellow" } } };
    },
    saveFellowRuntime: async (fellowId, body) => {
      calls.push({ kind: "runtime", fellowId, body });
      return { ok: true, data: { binding: { fellowId, ...body } } };
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

test("ensureFellowConversation upserts the ensured conversation into the sidebar cache", async () => {
  const s = loadSocial();
  const calls = [];
  s.__mockWindow.mia.social = {
    ensureFellowConversation: async (fellowId, body) => {
      calls.push({ fellowId, body });
      return { ok: true, data: { ok: true, conversation: { id: "fellow:u_1:alice", type: "fellow", name: "爱丽丝" } } };
    }
  };

  const conversation = await s.ensureFellowConversation({ key: "alice", name: "爱丽丝" });

  assert.equal(conversation.id, "fellow:u_1:alice");
  assert.equal(s.moduleState.conversations.some((item) => item.id === "fellow:u_1:alice"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    fellowId: "alice",
    body: { title: "爱丽丝", runtimeKind: "desktop-local" }
  });
});

test("upsertFellowConversation caches a cloud-hermes fellow conversation", async () => {
  const s = loadSocial();
  const conversation = {
    id: "fellow:u_1:alice",
    type: "fellow",
    name: "Alice",
    decorations: { fellowKey: "alice", runtimeKind: "cloud-hermes" }
  };
  const saved = s.upsertFellowConversation(conversation);
  assert.equal(saved.id, conversation.id);
  assert.equal(s.getConversationById(conversation.id).decorations.runtimeKind, "cloud-hermes");
});

test("fellowConversationForKey returns an existing cloud-hermes fellow conversation", async () => {
  const s = loadSocial();
  s.upsertFellowConversation({
    id: "fellow:u_1:alice",
    type: "fellow",
    name: "Alice",
    decorations: { fellowKey: "alice", runtimeKind: "cloud-hermes" }
  });
  const conversation = s.fellowConversationForKey("alice");
  assert.equal(conversation.id, "fellow:u_1:alice");
  assert.equal(conversation.decorations.runtimeKind, "cloud-hermes");
});

test("bootstrapAfterLogin warns when fellow conversation ensure returns ok false", async () => {
  const s = loadSocial();
  const calls = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    s.initSocialModule({
      getState: () => ({ runtime: { fellows: [{ key: "alice", name: "爱丽丝" }] } }),
      render: () => {},
      els: {},
      appendTransientChat: () => {}
    });
    s.__mockWindow.mia.social = {
      myUsername: async () => ({ ok: true, data: { id: "u_1", username: "jung" } }),
      listFriends: async () => ({ ok: true, data: { friends: [] } }),
      listFriendRequests: async () => ({ ok: true, data: { requests: [] } }),
      settingsGet: async () => ({}),
      ensureFellowConversation: async (fellowId) => {
        calls.push({ kind: "ensure", fellowId });
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
    payload: { conversation: { id: "fellow:u_1:alice", type: "fellow", name: "爱丽丝" } }
  });

  assert.equal(s.moduleState.conversations.some((conversation) => conversation.id === "fellow:u_1:alice"), true);
  assert.equal(s.moduleState.messageCache.has("fellow:u_1:alice"), true);
});

test("renderSidebarRows includes group conversations with type group-conversation", () => {
  const s = loadSocial();
  s.moduleState.myUserId = "u_me";
  s.moduleState.conversations = [
    { id: "dm:u_me:u_a", type: "dm", updatedAt: "2026-05-21T20:00:00.000Z", name: null },
    { id: "g_squad", type: "group", updatedAt: "2026-05-21T21:00:00.000Z", name: "Squad" },
    { id: "fellow:u_me:mia", type: "fellow", updatedAt: "2026-05-21T22:00:00.000Z", name: "Mia" }
  ];
  s.moduleState.friends = [{ id: "u_a", username: "alice" }];
  const rows = s.renderSidebarRows();
  assert.equal(rows.length, 3);
  const groupRow = rows.find((r) => r.type === "group-conversation");
  assert.equal(groupRow.conversation.name, "Squad");
  const fellowRow = rows.find((item) => item.conversation?.id === "fellow:u_me:mia");
  assert.equal(fellowRow.type, "private-conversation");
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
    { member_kind: "fellow", member_ref: "codex", fellow_name: "Codex" }
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
  s.moduleState.activeConversationId = "fellow:u_me:mia";
  s.moduleState.conversations = [{ id: "fellow:u_me:mia", type: "fellow", name: "Mia" }];
  s.moduleState.messageCache.set("fellow:u_me:mia", { messages: [], maxSeq: 0 });

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
        fellows: [{
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
  s.moduleState.activeConversationId = "fellow:u_me:mia";
  s.moduleState.conversations = [{ id: "fellow:u_me:mia", type: "fellow", name: "Mia", decorations: { fellowKey: "mia" } }];
  s.moduleState.messageCache.set("fellow:u_me:mia", {
    maxSeq: 2,
    messages: [
      { id: "m_user", seq: 1, sender_kind: "user", sender_ref: "u_me", body_md: "hi", created_at: "" },
      { id: "m_fellow", seq: 2, sender_kind: "fellow", sender_ref: "mia", body_md: "hello", created_at: "" }
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
      : `background-color:${color || "#5e5ce6"};`,
    avatarAssetForKey: (key) => `asset:${key}`
  };
  s.initSocialModule({
    getState: () => ({ runtime: { user: { avatarImage: "data:self-avatar" } } }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.myUserId = "u_me";
  s.moduleState.myUsername = "boss";
  s.moduleState.fellows = [{ id: "mia", name: "Mia", avatarImage: "data:cloud-mia-avatar", color: "#2563eb" }];
  s.moduleState.activeConversationId = "fellow:u_me:mia";
  s.moduleState.conversations = [{ id: "fellow:u_me:mia", type: "fellow", name: "Mia", decorations: { fellowKey: "mia" } }];
  s.moduleState.messageCache.set("fellow:u_me:mia", {
    maxSeq: 1,
    messages: [{ id: "m_fellow", seq: 1, sender_kind: "fellow", sender_ref: "mia", body_md: "hello", created_at: "" }]
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

test("renderConversationChat self letter falls back to local profile, not cloud username", () => {
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
        cloud: { user: { id: "u_me", username: "7" } },
        user: { displayName: "Boss", avatarText: "B", avatarColor: "#111827", avatarImage: "" }
      }
    }),
    render: () => {},
    els: {},
    appendTransientChat: () => {}
  });
  s.moduleState.myUserId = "u_me";
  s.moduleState.myUsername = "7";
  s.moduleState.activeConversationId = "fellow:u_me:mia";
  s.moduleState.conversations = [{ id: "fellow:u_me:mia", type: "fellow", name: "Mia", decorations: { fellowKey: "mia" } }];
  s.moduleState.messageCache.set("fellow:u_me:mia", {
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
  assert.match(chat.children[0].innerHTML, />B<\/div>/);
  assert.doesNotMatch(chat.children[0].innerHTML, />7<\/div>/);
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
    { member_kind: "fellow", member_ref: "codex", fellow_name: "Codex" }
  ]);

  await s.sendInActiveConversation("hi @Codex");

  assert.equal(posted.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(posted[0].body.mentions)), [
    { kind: "fellow", fellowId: "codex" }
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
    payload: { conversationId: "fellow:u_a:mia", runId: "car_1", hermesRunId: "hr_1", fellowId: "mia" },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "fellow:u_a:mia", runId: "car_1", event: { type: "message.delta", delta: "hello " } },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "fellow:u_a:mia", runId: "car_1", event: { type: "tool.started", tool: "shell" } },
  });
  const run = s.moduleState.cloudAgentRunsByConversation.get("fellow:u_a:mia");
  assert.equal(run.hermesRunId, "hr_1");
  assert.equal(run.text, "hello ");
  assert.equal(run.tools.map((tool) => tool.name).join(","), "shell");
});

test("handleCloudEvent does not infer group typing state from conductor-mode user messages", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.conversations = [{ id: "g_typing", type: "group", decorations: { responseMode: "conductor" } }];
  s._internalCtx.conversationMembersCache.set("g_typing", [
    { member_kind: "user", member_ref: "u_me" },
    { member_kind: "fellow", member_ref: "codex", fellow_name: "小栗" }
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

test("renderConversationChat shows typing as soon as an agent run starts", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.activeConversationId = "fellow:u_a:mia";
  s.moduleState.conversations = [{ id: "fellow:u_a:mia", type: "fellow", decorations: { fellowKey: "mia" } }];
  s.moduleState.messageCache.set("fellow:u_a:mia", { messages: [], maxSeq: 0 });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "fellow:u_a:mia", runId: "car_1", fellowId: "mia" },
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
  assert.match(chat.children[0].innerHTML, /typing-status/);
  assert.match(chat.children[0].innerHTML, /正在输入/);
});

test("renderConversationChat does not label tool-only agent activity as typing", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.activeConversationId = "fellow:u_a:mia";
  s.moduleState.conversations = [{ id: "fellow:u_a:mia", type: "fellow", decorations: { fellowKey: "mia" } }];
  s.moduleState.messageCache.set("fellow:u_a:mia", { messages: [], maxSeq: 0 });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "fellow:u_a:mia", runId: "car_1", fellowId: "mia" },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { conversationId: "fellow:u_a:mia", runId: "car_1", event: { type: "tool.started", tool: "search" } },
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

test("handleCloudEvent fellow reply clears transient cloud agent stream", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { conversationId: "fellow:u_a:mia", runId: "car_1" },
  });
  assert.ok(s.moduleState.cloudAgentRunsByConversation.has("fellow:u_a:mia"));
  s.handleCloudEvent({
    type: "conversation.message_appended",
    payload: {
      conversationId: "fellow:u_a:mia",
      message: { id: "m1", seq: 1, sender_kind: "fellow", sender_ref: "mia", body_md: "done" },
    },
  });
  assert.equal(s.moduleState.cloudAgentRunsByConversation.has("fellow:u_a:mia"), false);
});
