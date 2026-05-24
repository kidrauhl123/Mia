// Manual "标为未读" override for local fellow chats.
//
// unreadCountForPersona normally compares the latest assistant message time to
// the read mark. markPersonaUnread lets the user flag a persona as unread even
// when nothing is genuinely newer (a single-pip badge), and markPersonaRead
// clears it. The flag is persisted via saveChatReadState alongside readAt.
//
// Loaded in a vm sandbox with the shared unread module injected so the module's
// unreadShared() resolves without a real window/require chain.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const unreadShared = require("../src/shared/unread");

function load() {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "sessions", "session-read-state.js"), "utf8");
  const saved = [];
  const win = {
    aimashiUnread: unreadShared,
    aimashi: { saveChatReadState: async (payload) => { saved.push(payload); } },
  };
  const ctx = vm.createContext({ window: win, globalThis: win, console, Date, String, Object, Array, Number, JSON });
  vm.runInContext(src, ctx);
  return { srs: win.aimashiSessionReadState, saved };
}

// One persona "codex" with a single assistant message already marked read.
function freshState() {
  return {
    chatStore: {
      schema_version: 1,
      readAt: { codex: "2026-01-01T00:00:05.000Z" }, // after the message → computed unread 0
      manualUnread: {},
      sessions: {
        codex: [{ messages: [{ role: "assistant", content: "hi", createdAt: "2026-01-01T00:00:00.000Z" }] }],
      },
    },
  };
}

test("markPersonaUnread surfaces a single-pip unread even when nothing is genuinely newer", () => {
  const { srs } = load();
  const state = freshState();
  srs.initSessionReadState({ state, nowIso: () => "2026-01-01T00:00:10.000Z" });
  assert.equal(srs.unreadCountForPersona("codex"), 0);
  srs.markPersonaUnread("codex", false);
  assert.equal(srs.unreadCountForPersona("codex"), 1);
});

test("markPersonaRead clears the manual unread override", () => {
  const { srs } = load();
  const state = freshState();
  srs.initSessionReadState({ state, nowIso: () => "2026-01-01T00:00:10.000Z" });
  srs.markPersonaUnread("codex", false);
  srs.markPersonaRead("codex", false);
  assert.equal(srs.unreadCountForPersona("codex"), 0);
  assert.equal(state.chatStore.manualUnread.codex, undefined);
});

test("a passive render-time read mark (clearManual:false) does not wipe a manual unread flag", () => {
  const { srs } = load();
  const state = freshState();
  srs.initSessionReadState({ state, nowIso: () => "2026-01-01T00:00:10.000Z" });
  srs.markPersonaUnread("codex", false);
  // The active-row auto-read that runs on every render must not clear it,
  // otherwise marking the currently-open fellow unread is an instant no-op.
  srs.markPersonaRead("codex", false, { clearManual: false });
  assert.equal(srs.unreadCountForPersona("codex"), 1);
  // An explicit read (open / 标为已读) still clears it.
  srs.markPersonaRead("codex", false);
  assert.equal(srs.unreadCountForPersona("codex"), 0);
});

test("manual unread is reflected in totalUnreadCount and persisted with the read state", async () => {
  const { srs, saved } = load();
  const state = freshState();
  srs.initSessionReadState({ state, nowIso: () => "2026-01-01T00:00:10.000Z" });
  srs.markPersonaUnread("codex", true); // persist
  assert.equal(srs.totalUnreadCount([{ key: "codex" }]), 1);
  // saveChatReadState received the manualUnread map (not just readAt).
  const last = saved[saved.length - 1];
  assert.ok(last && last.manualUnread && last.manualUnread.codex === true);
});
