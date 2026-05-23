const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  computeUnreadForConversation,
  totalUnreadFromConversations,
  unreadBadgeHtml,
} = require("../src/shared/unread");

// ── unreadBadgeHtml: boundaries ──────────────────────────────────────────
test("unreadBadgeHtml: 0 → empty string", () => {
  assert.equal(unreadBadgeHtml(0), "");
});

test("unreadBadgeHtml: negative / NaN / undefined → empty string", () => {
  assert.equal(unreadBadgeHtml(-1), "");
  assert.equal(unreadBadgeHtml(NaN), "");
  assert.equal(unreadBadgeHtml(undefined), "");
  assert.equal(unreadBadgeHtml(null), "");
});

test("unreadBadgeHtml: 1 → '1'", () => {
  assert.equal(unreadBadgeHtml(1), '<span class="unread-badge">1</span>');
});

test("unreadBadgeHtml: 99 → '99' (boundary, no truncation)", () => {
  assert.equal(unreadBadgeHtml(99), '<span class="unread-badge">99</span>');
});

test("unreadBadgeHtml: 100 → '99+' (truncation kicks in)", () => {
  assert.equal(unreadBadgeHtml(100), '<span class="unread-badge">99+</span>');
});

test("unreadBadgeHtml: 999 → '99+'", () => {
  assert.equal(unreadBadgeHtml(999), '<span class="unread-badge">99+</span>');
});

test("unreadBadgeHtml: custom maxDisplay=9 → '9+' at 10", () => {
  assert.equal(unreadBadgeHtml(10, { maxDisplay: 9 }), '<span class="unread-badge">9+</span>');
  assert.equal(unreadBadgeHtml(9, { maxDisplay: 9 }), '<span class="unread-badge">9</span>');
});

// ── computeUnreadForConversation: Map readState (social / web shape) ────
test("computeUnreadForConversation: Map readState returns mapped count", () => {
  const map = new Map([["room-1", 3], ["room-2", 0]]);
  assert.equal(computeUnreadForConversation({ id: "room-1" }, map), 3);
  assert.equal(computeUnreadForConversation({ id: "room-2" }, map), 0);
  assert.equal(computeUnreadForConversation({ id: "room-missing" }, map), 0);
});

test("computeUnreadForConversation: Map with roomId field works too", () => {
  const map = new Map([["r1", 7]]);
  assert.equal(computeUnreadForConversation({ roomId: "r1" }, map), 7);
});

// ── computeUnreadForConversation: readAt readState (session shape) ──────
test("computeUnreadForConversation: readAt readState counts assistant messages after cutoff", () => {
  const conv = {
    key: "codex",
    sessions: [
      {
        messages: [
          { role: "assistant", content: "before", createdAt: "2026-01-01T00:00:00Z" },
          { role: "assistant", content: "after", createdAt: "2026-01-03T00:00:00Z" },
          { role: "user", content: "ignored", createdAt: "2026-01-04T00:00:00Z" },
        ],
      },
    ],
  };
  const readState = { readAt: { codex: "2026-01-02T00:00:00Z" } };
  assert.equal(computeUnreadForConversation(conv, readState), 1);
});

test("computeUnreadForConversation: transient/empty assistant messages skipped", () => {
  const conv = {
    id: "p",
    messages: [
      { role: "assistant", content: "", createdAt: "2026-01-03T00:00:00Z" },
      { role: "assistant", content: "real", transient: true, createdAt: "2026-01-03T00:00:00Z" },
      { role: "assistant", content: "real", createdAt: "2026-01-03T00:00:00Z" },
    ],
  };
  assert.equal(computeUnreadForConversation(conv, { readAt: { p: "2026-01-02T00:00:00Z" } }), 1);
});

test("computeUnreadForConversation: no readAt for key → all qualifying messages count", () => {
  const conv = {
    id: "p",
    messages: [
      { role: "assistant", content: "a", createdAt: "2026-01-01T00:00:00Z" },
      { role: "assistant", content: "b", createdAt: "2026-01-02T00:00:00Z" },
    ],
  };
  assert.equal(computeUnreadForConversation(conv, { readAt: {} }), 2);
});

// ── computeUnreadForConversation: pre-computed unreadCount fallback ─────
test("computeUnreadForConversation: falls back to conversation.unreadCount", () => {
  assert.equal(computeUnreadForConversation({ id: "x", unreadCount: 4 }), 4);
  assert.equal(computeUnreadForConversation({ id: "x", unreadCount: 0 }), 0);
});

test("computeUnreadForConversation: null conversation → 0", () => {
  assert.equal(computeUnreadForConversation(null, new Map()), 0);
});

// ── totalUnreadFromConversations ────────────────────────────────────────
test("totalUnreadFromConversations: empty list → 0", () => {
  assert.equal(totalUnreadFromConversations([], new Map()), 0);
  assert.equal(totalUnreadFromConversations([], { readAt: {} }), 0);
  assert.equal(totalUnreadFromConversations(null, { readAt: {} }), 0);
});

test("totalUnreadFromConversations: Map alone (no list) sums values", () => {
  const map = new Map([["a", 2], ["b", 5], ["c", 0]]);
  assert.equal(totalUnreadFromConversations(null, map), 7);
  assert.equal(totalUnreadFromConversations(undefined, map), 7);
});

test("totalUnreadFromConversations: Map readState + conversations sums per id", () => {
  const map = new Map([["a", 2], ["b", 5], ["c", 0]]);
  const convs = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(totalUnreadFromConversations(convs, map), 7);
});

test("totalUnreadFromConversations: readAt + personas (session shape)", () => {
  const personas = [
    {
      key: "p1",
      sessions: [
        {
          messages: [
            { role: "assistant", content: "x", createdAt: "2026-01-03T00:00:00Z" },
            { role: "assistant", content: "y", createdAt: "2026-01-04T00:00:00Z" },
          ],
        },
      ],
    },
    {
      key: "p2",
      sessions: [
        {
          messages: [
            { role: "assistant", content: "z", createdAt: "2026-01-04T00:00:00Z" },
          ],
        },
      ],
    },
  ];
  const readState = { readAt: { p1: "2026-01-03T00:00:00Z", p2: "2026-01-05T00:00:00Z" } };
  // p1: 1 message after cutoff; p2: 0
  assert.equal(totalUnreadFromConversations(personas, readState), 1);
});

test("totalUnreadFromConversations: mix of read/unread items → correct count", () => {
  const map = new Map([["a", 0], ["b", 3], ["c", 0], ["d", 1]]);
  const convs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.equal(totalUnreadFromConversations(convs, map), 4);
});

// ── browser-global attach ───────────────────────────────────────────────
test("module attaches itself to a window-like global", () => {
  const fakeWindow = {};
  const prevWindow = global.window;
  global.window = fakeWindow;
  try {
    delete require.cache[require.resolve("../src/shared/unread")];
    require("../src/shared/unread");
    assert.equal(typeof fakeWindow.aimashiUnread, "object");
    assert.equal(typeof fakeWindow.aimashiUnread.unreadBadgeHtml, "function");
    assert.equal(typeof fakeWindow.aimashiUnread.computeUnreadForConversation, "function");
    assert.equal(typeof fakeWindow.aimashiUnread.totalUnreadFromConversations, "function");
  } finally {
    if (prevWindow === undefined) delete global.window;
    else global.window = prevWindow;
  }
});
