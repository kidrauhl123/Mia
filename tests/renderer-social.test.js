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

test("bootstrapAfterLogin ensures local fellow rooms before listing rooms", async () => {
  const s = loadSocial();
  const calls = [];
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
    ensureFellowRoom: async (fellowId, body) => {
      calls.push({ kind: "ensure", fellowId, body });
      return { ok: true, data: { room: { id: "fellow:u_1:alice", type: "fellow" } } };
    },
    listRooms: async () => {
      calls.push({ kind: "listRooms" });
      return { ok: true, data: { rooms: [{ id: "fellow:u_1:alice", type: "fellow", name: "爱丽丝" }] } };
    },
    listRoomMessages: async () => ({ ok: true, data: { messages: [] } })
  };

  await s.bootstrapAfterLogin();

  assert.deepEqual(calls.map((call) => call.kind), ["ensure", "listRooms"]);
  assert.equal(calls[0].fellowId, "alice");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)), { title: "爱丽丝", runtimeKind: "desktop-local" });
});

test("bootstrapAfterLogin warns when fellow room ensure returns ok false", async () => {
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
      ensureFellowRoom: async (fellowId) => {
        calls.push({ kind: "ensure", fellowId });
        return { ok: false, error: "boom" };
      },
      listRooms: async () => {
        calls.push({ kind: "listRooms" });
        return { ok: true, data: { rooms: [] } };
      },
      listRoomMessages: async () => ({ ok: true, data: { messages: [] } })
    };

    await s.bootstrapAfterLogin();
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(calls.map((call) => call.kind), ["ensure", "listRooms"]);
  assert.equal(warnings.some((args) => args.some((part) => String(part).includes("alice") || String(part).includes("boom"))), true);
});

test("renderSidebarRows: dm room → private-room with otherUser resolved", () => {
  const s = loadSocial();
  s.moduleState.myUserId = "u_alice";
  s.moduleState.friends = [{ id: "u_bob", username: "bob", account: "bob" }];
  s.moduleState.rooms = [{ id: "dm:u_alice:u_bob", type: "dm", name: null, updatedAt: "2026-05-21T20:00:00.000Z" }];
  s.moduleState.messageCache.set("dm:u_alice:u_bob", {
    messages: [{ id: "m1", seq: 1, body_md: "hi", created_at: "2026-05-21T20:01:00.000Z" }],
    maxSeq: 1,
  });
  const rows = s.renderSidebarRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "private-room");
  assert.equal(rows[0].room.otherUser.username, "bob");
  assert.equal(rows[0].room.lastMessagePreview, "hi");
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

test("handleCloudEvent social.friend_added adds room + friend, removes from outgoing", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.outgoingRequests = [{ id: "fr_2", to_user: "u_b", status: "pending" }];
  s.handleCloudEvent({
    type: "social.friend_added",
    payload: {
      friend: { id: "u_b", username: "b" },
      room: { id: "dm:u_a:u_b", updatedAt: "2026-05-21T20:00:00.000Z" },
    },
  });
  assert.equal(s.moduleState.friends.find((f) => f.id === "u_b").username, "b");
  assert.equal(s.moduleState.rooms.find((r) => r.id === "dm:u_a:u_b").id, "dm:u_a:u_b");
  assert.equal(s.moduleState.outgoingRequests.length, 0);
  assert.ok(s.moduleState.messageCache.has("dm:u_a:u_b"));
});

test("handleCloudEvent social.room_invited adds the room to rooms list", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.handleCloudEvent({
    type: "social.room_invited",
    payload: { room: { id: "g_xxx", name: "Squad", updatedAt: "2026-05-21T20:00:00.000Z" }, invitedBy: { id: "u_a", username: "alice" } }
  });
  assert.ok(s.moduleState.rooms.find((r) => r.id === "g_xxx"));
});

test("handleCloudEvent room.updated upserts unknown rooms", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });

  s.handleCloudEvent({
    type: "room.updated",
    payload: { room: { id: "fellow:u_1:alice", type: "fellow", name: "爱丽丝" } }
  });

  assert.equal(s.moduleState.rooms.some((room) => room.id === "fellow:u_1:alice"), true);
  assert.equal(s.moduleState.messageCache.has("fellow:u_1:alice"), true);
});

test("renderSidebarRows includes group rooms with type group-room", () => {
  const s = loadSocial();
  s.moduleState.myUserId = "u_me";
  s.moduleState.rooms = [
    { id: "dm:u_me:u_a", type: "dm", updatedAt: "2026-05-21T20:00:00.000Z", name: null },
    { id: "g_squad", type: "group", updatedAt: "2026-05-21T21:00:00.000Z", name: "Squad" },
    { id: "fellow:u_me:mia", type: "fellow", updatedAt: "2026-05-21T22:00:00.000Z", name: "Mia" }
  ];
  s.moduleState.friends = [{ id: "u_a", username: "alice" }];
  const rows = s.renderSidebarRows();
  assert.equal(rows.length, 3);
  const groupRow = rows.find((r) => r.type === "group-room");
  assert.equal(groupRow.room.name, "Squad");
  const fellowRow = rows.find((item) => item.room?.id === "fellow:u_me:mia");
  assert.equal(fellowRow.type, "private-room");
});

test("sendInActiveGroupRoom uses the unified cloud-room send path", async () => {
  const s = loadSocial();
  const posted = [];
  s.__mockWindow.mia.social = {
    postRoomMessage: async (roomId, body) => {
      posted.push({ roomId, body });
      return { ok: true, data: { message: { id: "m1", seq: 1, body_md: body.bodyMd } } };
    }
  };
  s.moduleState.activeRoomId = "g_missing_module";
  s.moduleState.rooms = [{ id: "g_missing_module", type: "group", name: "Squad" }];
  s.moduleState.messageCache.set("g_missing_module", { messages: [], maxSeq: 0 });

  await withMutedConsoleWarn(() => s.sendInActiveGroupRoom("  hello group  "));

  assert.equal(posted.length, 1);
  assert.equal(posted[0].roomId, "g_missing_module");
  assert.equal(posted[0].body.bodyMd, "hello group");
  assert.equal(s.moduleState.messageCache.get("g_missing_module").messages.length, 1);
});

test("sendInActiveGroupRoom delegates to the unified cloud-room send path", async () => {
  const s = loadSocial();
  const posted = [];
  let attached = null;
  s.__mockWindow.mia.social = {
    postRoomMessage: async (roomId, body) => {
      posted.push({ roomId, body });
      return { ok: true, data: { message: { id: "m1", seq: 1, body_md: body.bodyMd } } };
    }
  };
  s.__mockWindow.miaSocialGroups = {
    attach(ctx) { attached = ctx; },
    sendInActiveGroupRoom() { throw new Error("groups module not attached"); }
  };
  s.moduleState.activeRoomId = "g_bad_module";
  s.moduleState.rooms = [{ id: "g_bad_module", type: "group", name: "Squad" }];
  s.moduleState.messageCache.set("g_bad_module", { messages: [], maxSeq: 0 });

  await withMutedConsoleWarn(() => s.sendInActiveGroupRoom("hello after fallback"));

  assert.equal(attached, null);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].roomId, "g_bad_module");
  assert.equal(posted[0].body.bodyMd, "hello after fallback");
  assert.equal(s.moduleState.messageCache.get("g_bad_module").messages.length, 1);
});

test("sendInActiveRoom shows outgoing cloud messages before the network reply resolves", async () => {
  const s = loadSocial();
  const post = deferred();
  const posted = [];
  s.moduleState.myUserId = "u_me";
  s.__mockWindow.mia.social = {
    postRoomMessage: async (roomId, body) => {
      posted.push({ roomId, body });
      return post.promise;
    }
  };
  s.moduleState.activeRoomId = "g_fast";
  s.moduleState.rooms = [{ id: "g_fast", type: "group", name: "Fast" }];
  s.moduleState.messageCache.set("g_fast", { messages: [], maxSeq: 0 });
  s._internalCtx.roomMembersCache.set("g_fast", [
    { member_kind: "fellow", member_ref: "codex", fellow_name: "Codex" }
  ]);

  const sendPromise = s.sendInActiveRoom("hello immediately");
  const entry = s.moduleState.messageCache.get("g_fast");

  assert.equal(posted.length, 1);
  assert.equal(entry.messages.length, 1);
  assert.match(entry.messages[0].id, /^local_/);
  assert.equal(entry.messages[0].status, "sending");
  assert.equal(entry.messages[0].body_md, "hello immediately");
  assert.equal(s.moduleState.cloudAgentRunsByRoom.has("g_fast"), false);

  post.resolve({
    ok: true,
    data: { message: { id: "m_server", seq: 1, sender_kind: "user", sender_ref: "u_me", body_md: "hello immediately" } }
  });
  await sendPromise;

  assert.deepEqual(entry.messages.map((m) => m.id), ["m_server"]);
  assert.equal(entry.maxSeq, 1);
});

test("sendInActiveRoom keeps a failed outgoing cloud message visible", async () => {
  const s = loadSocial();
  const posted = [];
  s.moduleState.myUserId = "u_me";
  s.__mockWindow.mia.social = {
    postRoomMessage: async (roomId, body) => {
      posted.push({ roomId, body });
      return { ok: false, error: "network down" };
    }
  };
  s.moduleState.activeRoomId = "g_failed";
  s.moduleState.rooms = [{ id: "g_failed", type: "group", name: "Failed" }];
  s.moduleState.messageCache.set("g_failed", { messages: [], maxSeq: 0 });

  await withMutedConsoleWarn(() => s.sendInActiveRoom("爱丽丝你帮我找下AI领域最新新闻"));

  const entry = s.moduleState.messageCache.get("g_failed");
  assert.equal(posted.length, 1);
  assert.equal(entry.messages.length, 1);
  assert.equal(entry.messages[0].body_md, "爱丽丝你帮我找下AI领域最新新闻");
  assert.equal(entry.messages[0].status, "error");
  assert.equal(entry.messages[0].error, "network down");
});

test("renderRoomChat marks failed outgoing cloud messages", async () => {
  const s = loadSocial();
  s.moduleState.myUserId = "u_me";
  s.__mockWindow.mia.social = {
    postRoomMessage: async () => ({ ok: false, error: "network down" })
  };
  s.moduleState.activeRoomId = "fellow:u_me:mia";
  s.moduleState.rooms = [{ id: "fellow:u_me:mia", type: "fellow", name: "Mia" }];
  s.moduleState.messageCache.set("fellow:u_me:mia", { messages: [], maxSeq: 0 });

  await withMutedConsoleWarn(() => s.sendInActiveRoom("hello failed"));

  const chat = {
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ""; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
  s.renderRoomChat(chat);

  assert.equal(chat.children.length, 1);
  assert.match(chat.children[0].innerHTML, /message-send-status is-error/);
  assert.match(chat.children[0].innerHTML, /发送失败/);
  assert.match(chat.children[0].innerHTML, /title="network down"/);
});

test("sendInActiveRoom posts group mentions in cloud fellow format", async () => {
  const s = loadSocial();
  const posted = [];
  s.moduleState.myUserId = "u_me";
  s.__mockWindow.mia.social = {
    postRoomMessage: async (roomId, body) => {
      posted.push({ roomId, body });
      return { ok: true, data: { message: { id: "m1", seq: 1, sender_kind: "user", sender_ref: "u_me", body_md: body.bodyMd } } };
    }
  };
  s.moduleState.activeRoomId = "g_mentions";
  s.moduleState.rooms = [{ id: "g_mentions", type: "group", name: "Mentions" }];
  s.moduleState.messageCache.set("g_mentions", { messages: [], maxSeq: 0 });
  s._internalCtx.roomMembersCache.set("g_mentions", [
    { member_kind: "fellow", member_ref: "codex", fellow_name: "Codex" }
  ]);

  await s.sendInActiveRoom("hi @Codex");

  assert.equal(posted.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(posted[0].body.mentions)), [
    { kind: "fellow", fellowId: "codex" }
  ]);
});

test("handleCloudEvent room.message_appended appends and tracks maxSeq", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.handleCloudEvent({
    type: "room.message_appended",
    payload: { roomId: "dm:u_a:u_b", message: { id: "m1", seq: 1, body_md: "hi", created_at: "2026-05-21T20:01:00.000Z" } },
  });
  s.handleCloudEvent({
    type: "room.message_appended",
    payload: { roomId: "dm:u_a:u_b", message: { id: "m2", seq: 2, body_md: "yo", created_at: "2026-05-21T20:02:00.000Z" } },
  });
  // duplicate (same id) shouldn't double-append
  s.handleCloudEvent({
    type: "room.message_appended",
    payload: { roomId: "dm:u_a:u_b", message: { id: "m2", seq: 2, body_md: "yo", created_at: "2026-05-21T20:02:00.000Z" } },
  });
  const entry = s.moduleState.messageCache.get("dm:u_a:u_b");
  assert.equal(entry.messages.length, 2);
  assert.equal(entry.maxSeq, 2);
});

test("handleCloudEvent cloud_agent_run events track transient room streaming state", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { roomId: "fellow:u_a:mia", runId: "car_1", hermesRunId: "hr_1", fellowId: "mia" },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { roomId: "fellow:u_a:mia", runId: "car_1", event: { type: "message.delta", delta: "hello " } },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { roomId: "fellow:u_a:mia", runId: "car_1", event: { type: "tool.started", tool: "shell" } },
  });
  const run = s.moduleState.cloudAgentRunsByRoom.get("fellow:u_a:mia");
  assert.equal(run.hermesRunId, "hr_1");
  assert.equal(run.text, "hello ");
  assert.equal(run.tools.map((tool) => tool.name).join(","), "shell");
});

test("handleCloudEvent does not infer group typing state from conductor-mode user messages", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.myUserId = "u_me";
  s.moduleState.rooms = [{ id: "g_typing", type: "group", decorations: { responseMode: "conductor" } }];
  s._internalCtx.roomMembersCache.set("g_typing", [
    { member_kind: "user", member_ref: "u_me" },
    { member_kind: "fellow", member_ref: "codex", fellow_name: "小栗" }
  ]);

  s.handleCloudEvent({
    type: "room.message_appended",
    payload: {
      roomId: "g_typing",
      message: { id: "m1", seq: 1, sender_kind: "user", sender_ref: "u_me", body_md: "有人吗" },
    },
  });

  assert.equal(s.moduleState.cloudAgentRunsByRoom.has("g_typing"), false);
});

test("renderRoomChat hides typing until an agent stream emits text", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.activeRoomId = "fellow:u_a:mia";
  s.moduleState.rooms = [{ id: "fellow:u_a:mia", type: "fellow", decorations: { fellowKey: "mia" } }];
  s.moduleState.messageCache.set("fellow:u_a:mia", { messages: [], maxSeq: 0 });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { roomId: "fellow:u_a:mia", runId: "car_1", fellowId: "mia" },
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
  s.renderRoomChat(chat);

  assert.equal(chat.children.length, 0);
});

test("renderRoomChat does not label tool-only agent activity as typing", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.moduleState.activeRoomId = "fellow:u_a:mia";
  s.moduleState.rooms = [{ id: "fellow:u_a:mia", type: "fellow", decorations: { fellowKey: "mia" } }];
  s.moduleState.messageCache.set("fellow:u_a:mia", { messages: [], maxSeq: 0 });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { roomId: "fellow:u_a:mia", runId: "car_1", fellowId: "mia" },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { roomId: "fellow:u_a:mia", runId: "car_1", event: { type: "tool.started", tool: "search" } },
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
  s.renderRoomChat(chat);

  assert.equal(chat.children.length, 1);
  assert.match(chat.children[0].innerHTML, /TOOL/);
  assert.doesNotMatch(chat.children[0].innerHTML, /typing-status/);
});

test("handleCloudEvent fellow reply clears transient cloud agent stream", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { roomId: "fellow:u_a:mia", runId: "car_1" },
  });
  assert.ok(s.moduleState.cloudAgentRunsByRoom.has("fellow:u_a:mia"));
  s.handleCloudEvent({
    type: "room.message_appended",
    payload: {
      roomId: "fellow:u_a:mia",
      message: { id: "m1", seq: 1, sender_kind: "fellow", sender_ref: "mia", body_md: "done" },
    },
  });
  assert.equal(s.moduleState.cloudAgentRunsByRoom.has("fellow:u_a:mia"), false);
});
