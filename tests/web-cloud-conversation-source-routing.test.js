// Task 2.1 routing test: web's bubble render must read MessageSpec fields only,
// which it gets by calling window.miaCloudConversationSource.createCloudConversationSource
// (the canonical adapter). This test simulates a browser-ish environment:
//   - loads packages/shared/contact.js + src/shared/message-spec.js + the adapter
//     via vm with a `window` global (no `require`/no `module` in scope)
//   - asserts the adapter is reachable through window.miaCloudConversationSource
//   - asserts a sample DM message resolves through it to a MessageSpec the web
//     bubble can render without any sender_kind/member_kind branching.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadInBrowserLikeContext() {
  // No `module` defined in the context — mirrors what a browser sees.
  const window = {};
  const ctx = vm.createContext({ window, globalThis: window, console });
  const files = [
    "src/shared/message-spec.js",
    "packages/shared/avatar.js",
    "packages/shared/contact.js",
    "src/shared/conversation-kinds.js",
    "src/renderer/message-sources/cloud-conversation-source.js"
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    vm.runInContext(src, ctx);
  }
  return window;
}

test("web loads shared modules into window without throwing (no `module` in scope)", () => {
  const win = loadInBrowserLikeContext();
  assert.ok(win.miaMessageSpec, "miaMessageSpec must attach to window");
  assert.ok(win.miaContact, "miaContact must attach to window");
  assert.ok(win.miaCloudConversationSource, "miaCloudConversationSource must attach to window");
  assert.equal(typeof win.miaCloudConversationSource.createCloudConversationSource, "function");
});

test("web buildConversationMessageArticle path: own user message → MessageSpec with isOwn=true and authorName=self", () => {
  const win = loadInBrowserLikeContext();
  const conversation = { id: "dm:user_me:user_friend" };
  const msg = { id: "m1", sender_kind: "user", sender_ref: "user_me", body_md: "hi", created_at: "", seq: 1 };
  const ctx = { self: { id: "user_me", username: "me" }, friends: [], bots: [] };
  const source = win.miaCloudConversationSource.createCloudConversationSource({ conversation, messages: [msg], members: [], ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.isOwn, true);
  assert.equal(spec.authorName, "me");
  assert.equal(spec.role, "user");
  // Web reads only these spec fields — no sender_kind branching needed.
  assert.equal(typeof spec.bodyMd, "string");
  assert.ok(spec.avatar && typeof spec.avatar === "object");
});

test("web buildConversationMessageArticle path: friend message → MessageSpec carries friend username + avatar", () => {
  const win = loadInBrowserLikeContext();
  const conversation = { id: "dm:user_me:user_friend" };
  const msg = { id: "m2", sender_kind: "user", sender_ref: "user_friend", body_md: "yo", created_at: "", seq: 2 };
  const ctx = {
    self: { id: "user_me", username: "me" },
    friends: [{ id: "user_friend", username: "alice", avatarImage: "data:alice" }],
    bots: []
  };
  const source = win.miaCloudConversationSource.createCloudConversationSource({ conversation, messages: [msg], members: [], ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.isOwn, false);
  assert.equal(spec.authorName, "alice");
  assert.equal(spec.avatar.image, "data:alice");
});

test("web buildConversationMessageArticle path: bot message in cloud conversation -> spec has bot display + role=assistant", () => {
  const win = loadInBrowserLikeContext();
  const conversation = { id: "g_conversation1" };
  const msg = { id: "m3", sender_kind: "bot", sender_ref: "codex", body_md: "ok", created_at: "", seq: 3 };
  const members = [{ member_kind: "bot", member_ref: "codex", owner_id: "user_friend" }];
  const ctx = {
    self: { id: "user_me", username: "me" },
    friends: [{ id: "user_friend", username: "alice" }],
    bots: []
  };
  const source = win.miaCloudConversationSource.createCloudConversationSource({ conversation, messages: [msg], members, ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.role, "assistant");
  assert.equal(spec.isOwn, false);
  // Bot attribution intentionally omits the owner suffix — see
  // cloud-conversation-source.js authorForMessage. Without enrichment from the
  // server (member.bot_name) the display falls back to the raw
  // sender_ref.
  assert.equal(spec.authorName, "codex");
});

test("web source marks only self.id user messages as own", () => {
  const win = loadInBrowserLikeContext();
  const self = { id: "user_me", username: "me" };
  const friends = [{ id: "user_friend", username: "alice" }];
  const conversation = { id: "g_conversation1" };
  const messages = [
    { id: "own", sender_kind: "user", sender_ref: "user_me", body_md: "mine", created_at: "", seq: 1 },
    { id: "friend", sender_kind: "user", sender_ref: "user_friend", body_md: "theirs", created_at: "", seq: 2 },
    { id: "bot", sender_kind: "bot", sender_ref: "codex", body_md: "bot", created_at: "", seq: 3 }
  ];
  const source = win.miaCloudConversationSource.createCloudConversationSource({
    conversation,
    messages,
    members: [],
    ctx: { self, friends, bots: [{ id: "codex", name: "Codex" }] }
  });
  const specs = source.listMessages();
  assert.equal(specs.find((spec) => spec.messageId === "own").isOwn, true);
  assert.equal(specs.find((spec) => spec.messageId === "friend").isOwn, false);
  assert.equal(specs.find((spec) => spec.messageId === "bot").isOwn, false);
});
