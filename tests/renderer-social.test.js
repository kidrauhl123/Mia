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
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    querySelector() { return mockEl(); },
    querySelectorAll() { return []; },
    set innerHTML(v) {},
    get innerHTML() { return ""; },
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
    aimashi: {},
    aimashiMarkdown: {
      escapeHtml: (v) => String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;"),
      renderMarkdown: (v) => String(v || ""),
    },
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
  mockWindow.aimashiSocial.__mockWindow = mockWindow;
  return mockWindow.aimashiSocial;
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
  s.__mockWindow.aimashi.social = {
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
    { id: "fellow:u_me:aimashi", type: "fellow", updatedAt: "2026-05-21T22:00:00.000Z", name: "Aimashi" }
  ];
  s.moduleState.friends = [{ id: "u_a", username: "alice" }];
  const rows = s.renderSidebarRows();
  assert.equal(rows.length, 3);
  const groupRow = rows.find((r) => r.type === "group-room");
  assert.equal(groupRow.room.name, "Squad");
  const fellowRow = rows.find((item) => item.room?.id === "fellow:u_me:aimashi");
  assert.equal(fellowRow.type, "private-room");
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
    payload: { roomId: "fellow:u_a:aimashi", runId: "car_1", hermesRunId: "hr_1", fellowId: "aimashi" },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { roomId: "fellow:u_a:aimashi", runId: "car_1", event: { type: "message.delta", delta: "hello " } },
  });
  s.handleCloudEvent({
    type: "cloud_agent_run_event",
    payload: { roomId: "fellow:u_a:aimashi", runId: "car_1", event: { type: "tool.started", tool: "shell" } },
  });
  const run = s.moduleState.cloudAgentRunsByRoom.get("fellow:u_a:aimashi");
  assert.equal(run.hermesRunId, "hr_1");
  assert.equal(run.text, "hello ");
  assert.equal(run.tools.map((tool) => tool.name).join(","), "shell");
});

test("handleCloudEvent fellow reply clears transient cloud agent stream", () => {
  const s = loadSocial();
  s.initSocialModule({ getState: () => ({}), render: () => {}, els: {}, appendTransientChat: () => {} });
  s.handleCloudEvent({
    type: "cloud_agent_run_started",
    payload: { roomId: "fellow:u_a:aimashi", runId: "car_1" },
  });
  assert.ok(s.moduleState.cloudAgentRunsByRoom.has("fellow:u_a:aimashi"));
  s.handleCloudEvent({
    type: "room.message_appended",
    payload: {
      roomId: "fellow:u_a:aimashi",
      message: { id: "m1", seq: 1, sender_kind: "fellow", sender_ref: "aimashi", body_md: "done" },
    },
  });
  assert.equal(s.moduleState.cloudAgentRunsByRoom.has("fellow:u_a:aimashi"), false);
});
