const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { memberAccentColor } = require("../src/shared/member-color");

function loadSource() {
  const sharedSpec = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "message-spec.js"), "utf8");
  const sharedAvatarResolve = fs.readFileSync(path.join(__dirname, "..", "packages", "shared", "avatar.js"), "utf8");
  const sharedContact = fs.readFileSync(path.join(__dirname, "..", "packages", "shared", "contact.js"), "utf8");
  const sharedKinds = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "conversation-kinds.js"), "utf8");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "message-sources", "cloud-conversation-source.js"), "utf8");
  const window = {};
  const ctx = vm.createContext({ window, globalThis: window, console });
  vm.runInContext("globalThis.miaMessageSpec = (function(){ const module = { exports: {} }; " + sharedSpec + "; return module.exports; })();", ctx);
  vm.runInContext(sharedAvatarResolve, ctx);
  vm.runInContext("globalThis.miaContact = (function(){ const module = { exports: {} }; " + sharedContact + "; return module.exports; })();", ctx);
  vm.runInContext(sharedKinds, ctx);
  vm.runInContext(src, ctx);
  return window.miaCloudConversationSource;
}

test("CloudConversationSource DM friend message uses friend avatar", () => {
  const src = loadSource();
  const conversation = { id: "dm:user_me:user_friend", name: null };
  const messages = [
    { id: "msg1", sender_kind: "user", sender_ref: "user_friend", body_md: "hi", created_at: "2026-05-22T01:00:00.000Z", seq: 1 }
  ];
  const ctx = {
    self: { id: "user_me", username: "me" },
    bots: [],
    friends: [{ id: "user_friend", username: "alice", avatarImage: "data:alice" }]
  };
  const source = src.createCloudConversationSource({ conversation, messages, members: [], ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.source, "cloud-conversation");
  assert.equal(spec.role, "user");
  assert.equal(spec.authorName, "alice");
  assert.equal(spec.avatar.image, "data:alice");
  assert.equal(spec.isOwn, false);
});

test("CloudConversationSource own message marks isOwn=true", () => {
  const src = loadSource();
  const conversation = { id: "dm:user_me:user_friend" };
  const messages = [{ id: "msg2", sender_kind: "user", sender_ref: "user_me", body_md: "ok", created_at: "", seq: 2 }];
  const ctx = { self: { id: "user_me", username: "me" }, bots: [], friends: [] };
  const source = src.createCloudConversationSource({ conversation, messages, members: [], ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.isOwn, true);
  assert.equal(spec.authorName, "me");
});

test("CloudConversationSource group bot message resolves bot contact via members", () => {
  const src = loadSource();
  const conversation = { id: "g_conversation1", name: "Mixed" };
  const messages = [{ id: "msg3", sender_kind: "bot", sender_ref: "codex", body_md: "yo", created_at: "", seq: 3 }];
  const members = [
    { member_kind: "bot", member_ref: "codex", owner_id: "user_friend" },
    { member_kind: "user", member_ref: "user_friend" }
  ];
  const ctx = {
    self: { id: "user_me", username: "me" },
    bots: [],
    friends: [{ id: "user_friend", username: "alice" }]
  };
  const source = src.createCloudConversationSource({ conversation, messages, members, ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.role, "assistant");
  // Owner suffix dropped per UX — display the AI's name only.
  assert.equal(spec.authorName, "codex");
});

test("CloudConversationSource hydrates own bot avatar from ctx.bots", () => {
  const src = loadSource();
  const conversation = { id: "g_conversation2" };
  const messages = [{ id: "msg4", sender_kind: "bot", sender_ref: "codex", body_md: "yo", created_at: "", seq: 1 }];
  const members = [{ member_kind: "bot", member_ref: "codex", owner_id: "user_me" }];
  const ctx = {
    self: { id: "user_me", username: "me" },
    bots: [{ key: "codex", name: "Codex", avatarImage: "data:codex-pic", color: "#5e5ce6" }],
    friends: []
  };
  const source = src.createCloudConversationSource({ conversation, messages, members, ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.avatar.image, "data:codex-pic");
});

test("CloudConversationSource uses member identity avatar when owned bot context is compact", () => {
  const src = loadSource();
  const conversation = { id: "g_conversation_compact" };
  const messages = [{ id: "msg_compact", sender_kind: "bot", sender_ref: "craft", body_md: "yo", created_at: "", seq: 1 }];
  const members = [{
    member_kind: "bot",
    member_ref: "craft",
    owner_id: "user_me",
    identity: {
      displayName: "匠妹",
      avatar: { image: "data:video/mp4;base64,real", crop: { start: 0, duration: 3 } }
    },
    bot_avatar_image: "legacy-copy.png"
  }];
  const ctx = {
    self: { id: "user_me", username: "me" },
    bots: [{ key: "craft", name: "匠妹" }],
    friends: []
  };
  const source = src.createCloudConversationSource({ conversation, messages, members, ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.authorName, "匠妹");
  assert.equal(spec.avatar.image, "data:video/mp4;base64,real");
  assert.deepEqual(spec.avatar.crop, { start: 0, duration: 3 });
});

test("CloudConversationSource preserves member identity status badge", () => {
  const src = loadSource();
  const conversation = { id: "g_badge" };
  const messages = [{ id: "msg_badge", sender_kind: "bot", sender_ref: "mia", body_md: "yo", created_at: "", seq: 1 }];
  const members = [{
    member_kind: "bot",
    member_ref: "mia",
    owner_id: "user_me",
    identity: {
      kind: "bot",
      id: "mia",
      displayName: "Mia",
      avatar: { image: "", crop: null, color: "#5e5ce6", text: "Mi" },
      statusBadge: { kind: "emoji", emoji: "⭐", label: "Premium" }
    }
  }];
  const ctx = {
    self: { id: "user_me", username: "me" },
    bots: [],
    friends: []
  };
  const source = src.createCloudConversationSource({ conversation, messages, members, ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.authorIdentity.kind, "bot");
  assert.equal(spec.authorIdentity.id, "mia");
  assert.equal(spec.authorIdentity.displayName, "Mia");
  assert.deepEqual(JSON.parse(JSON.stringify(spec.statusBadge)), { kind: "emoji", emoji: "⭐", label: "Premium" });
});

test("CloudConversationSource hashes owned empty bot avatar by global identity", () => {
  const src = loadSource();
  const conversation = { id: "botc_user_me_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } };
  const messages = [{ id: "msg_owned_empty", sender_kind: "bot", sender_ref: "mia", body_md: "yo", created_at: "", seq: 1 }];
  const members = [{ member_kind: "bot", member_ref: "mia", owner_id: "user_me" }];
  const ctx = {
    self: { id: "user_me", username: "me" },
    bots: [{ key: "mia", id: "mia", ownerUserId: "user_me", name: "Mia", avatarImage: "" }],
    friends: []
  };
  const source = src.createCloudConversationSource({ conversation, messages, members, ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.avatar.image, "");
  assert.equal(spec.avatar.crop, null);
  assert.equal(spec.avatar.color, memberAccentColor("mia"));
  assert.equal(spec.avatar.text, "Mi");
});

test("CloudConversationSource preserves an owned bot's explicit avatar color", () => {
  const src = loadSource();
  const conversation = { id: "botc_user_me_ha", type: "bot", name: "哈哈哈", decorations: { botId: "ha" } };
  const messages = [{ id: "msg_owned_color", sender_kind: "bot", sender_ref: "ha", body_md: "yo", created_at: "", seq: 1 }];
  const members = [{ member_kind: "bot", member_ref: "ha", owner_id: "user_me" }];
  const ctx = {
    self: { id: "user_me", username: "me" },
    bots: [{ key: "ha", id: "ha", ownerUserId: "user_me", name: "哈哈哈", avatarImage: "", color: "#aa88dd" }],
    friends: []
  };
  const source = src.createCloudConversationSource({ conversation, messages, members, ctx });
  const spec = source.listMessages()[0];

  assert.equal(spec.avatar.image, "");
  assert.equal(spec.avatar.color, "#aa88dd");
  assert.equal(spec.avatar.text, "哈哈");
});

test("CloudConversationSource falls back to stable bot text avatar", () => {
  const src = loadSource();
  const conversation = { id: "botc_user_me_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } };
  const messages = [{ id: "msg5", sender_kind: "bot", sender_ref: "mia", body_md: "yo", created_at: "", seq: 1 }];
  const ctx = {
    self: { id: "user_me", username: "me" },
    bots: [],
    friends: []
  };
  const source = src.createCloudConversationSource({ conversation, messages, members: [], ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.authorName, "Mia");
  assert.equal(spec.avatar.image, "");
  assert.equal(spec.avatar.crop, null);
  assert.equal(spec.avatar.text, "Mi");
});

test("CloudConversationSource system message gets role=system", () => {
  const src = loadSource();
  const conversation = { id: "g_conversation3" };
  const messages = [{ id: "sys1", sender_kind: "system", sender_ref: "sys", body_md: "user joined", created_at: "", seq: 1 }];
  const source = src.createCloudConversationSource({ conversation, messages, members: [], ctx: { self: {}, bots: [], friends: [] } });
  const spec = source.listMessages()[0];
  assert.equal(spec.role, "system");
  assert.equal(spec.authorName, "系统");
});

test("CloudConversationSource capabilities: copy + reply + delete true, pin false", () => {
  const src = loadSource();
  const conversation = { id: "dm:a:b" };
  const messages = [{ id: "m", sender_kind: "user", sender_ref: "a", body_md: "x", created_at: "", seq: 1 }];
  const source = src.createCloudConversationSource({ conversation, messages, members: [], ctx: { self: {}, bots: [], friends: [] } });
  const cap = source.listMessages()[0].capabilities;
  assert.equal(cap.copy, true);
  assert.equal(cap.reply, true);
  assert.equal(cap.pin, false);
  // Delete is WeChat-style local-hide, available on every cloud-conversation message
  // (DELETE /api/conversations/:id/messages/:msgId hides it for the requesting user).
  assert.equal(cap.delete, true);
});
