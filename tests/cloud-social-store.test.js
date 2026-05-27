const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createSocialStore } = require("../src/cloud/social-store.js");

function makeStores() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-social-test-"));
  const cloudStore = createCloudStore({ dataDir: tmpDir });
  const db = cloudStore.getDb();
  const social = createSocialStore(db);
  const alice = cloudStore.registerUser({ username: "alice", password: "Pa55word!" }).user;
  const bob = cloudStore.registerUser({ username: "bob", password: "Pa55word!" }).user;
  return { cloudStore, social, alice, bob, tmpDir };
}

function cleanup(ctx) {
  ctx.cloudStore.close();
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
}

test("addFriendship normalizes order and is idempotent", () => {
  const ctx = makeStores();
  try {
    ctx.social.addFriendship(ctx.alice.id, ctx.bob.id);
    ctx.social.addFriendship(ctx.bob.id, ctx.alice.id);
    const friends = ctx.social.listFriends(ctx.alice.id);
    assert.equal(friends.length, 1);
    assert.equal(friends[0], ctx.bob.id);
  } finally { cleanup(ctx); }
});

test("areFriends returns true after addFriendship, false after remove", () => {
  const ctx = makeStores();
  try {
    assert.equal(ctx.social.areFriends(ctx.alice.id, ctx.bob.id), false);
    ctx.social.addFriendship(ctx.alice.id, ctx.bob.id);
    assert.equal(ctx.social.areFriends(ctx.alice.id, ctx.bob.id), true);
    assert.equal(ctx.social.areFriends(ctx.bob.id, ctx.alice.id), true);
    ctx.social.removeFriendship(ctx.alice.id, ctx.bob.id);
    assert.equal(ctx.social.areFriends(ctx.alice.id, ctx.bob.id), false);
  } finally { cleanup(ctx); }
});

test("createFriendRequestByUsername happy path returns pending row", () => {
  const ctx = makeStores();
  try {
    const req = ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: ctx.bob.id });
    assert.ok(req.id);
    assert.equal(req.status, "pending");
    assert.equal(req.from_user, ctx.alice.id);
    assert.equal(req.to_user, ctx.bob.id);
    assert.equal(req.code, null);
  } finally { cleanup(ctx); }
});

test("createFriendRequestByUsername rejects self-request", () => {
  const ctx = makeStores();
  try {
    assert.throws(
      () => ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: ctx.alice.id }),
      /yourself/i
    );
  } finally { cleanup(ctx); }
});

test("createFriendRequestByUsername rejects already-friends", () => {
  const ctx = makeStores();
  try {
    ctx.social.addFriendship(ctx.alice.id, ctx.bob.id);
    assert.throws(
      () => ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: ctx.bob.id }),
      /already friends/i
    );
  } finally { cleanup(ctx); }
});

test("createFriendRequestByUsername rejects duplicate pending", () => {
  const ctx = makeStores();
  try {
    ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: ctx.bob.id });
    assert.throws(
      () => ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: ctx.bob.id }),
      /already pending/i
    );
  } finally { cleanup(ctx); }
});

test("getFriendRequestById returns row or null", () => {
  const ctx = makeStores();
  try {
    const req = ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: ctx.bob.id });
    const fetched = ctx.social.getFriendRequestById(req.id);
    assert.equal(fetched.id, req.id);
    assert.equal(fetched.status, "pending");
    assert.equal(ctx.social.getFriendRequestById("nonexistent_id"), null);
  } finally { cleanup(ctx); }
});

test("listOutgoingPending returns sender's pending requests", () => {
  const ctx = makeStores();
  try {
    const charlie = ctx.cloudStore.registerUser({ username: "charlie", password: "Pa55word!" }).user;
    ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: ctx.bob.id });
    ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: charlie.id });
    const outgoing = ctx.social.listOutgoingPending(ctx.alice.id);
    assert.equal(outgoing.length, 2);
    const bobOutgoing = ctx.social.listOutgoingPending(ctx.bob.id);
    assert.equal(bobOutgoing.length, 0);
  } finally { cleanup(ctx); }
});

test("listIncomingPending returns recipient's pending requests", () => {
  const ctx = makeStores();
  try {
    const charlie = ctx.cloudStore.registerUser({ username: "charlie", password: "Pa55word!" }).user;
    ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: ctx.bob.id });
    ctx.social.createFriendRequestByUsername({ fromUserId: charlie.id, toUserId: ctx.bob.id });
    const incoming = ctx.social.listIncomingPending(ctx.bob.id);
    assert.equal(incoming.length, 2);
    const aliceIncoming = ctx.social.listIncomingPending(ctx.alice.id);
    assert.equal(aliceIncoming.length, 0);
  } finally { cleanup(ctx); }
});

test("respondToFriendRequest accept creates friendship atomically", () => {
  const ctx = makeStores();
  try {
    const req = ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: ctx.bob.id });
    const updated = ctx.social.respondToFriendRequest(req.id, ctx.bob.id, "accept");
    assert.equal(updated.status, "accepted");
    assert.ok(updated.resolved_at);
    assert.equal(ctx.social.areFriends(ctx.alice.id, ctx.bob.id), true);
  } finally { cleanup(ctx); }
});

test("respondToFriendRequest reject does NOT create friendship", () => {
  const ctx = makeStores();
  try {
    const req = ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: ctx.bob.id });
    const updated = ctx.social.respondToFriendRequest(req.id, ctx.bob.id, "reject");
    assert.equal(updated.status, "rejected");
    assert.ok(updated.resolved_at);
    assert.equal(ctx.social.areFriends(ctx.alice.id, ctx.bob.id), false);
  } finally { cleanup(ctx); }
});

test("respondToFriendRequest rejects when non-recipient tries to respond", () => {
  const ctx = makeStores();
  try {
    const req = ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: ctx.bob.id });
    assert.throws(
      () => ctx.social.respondToFriendRequest(req.id, ctx.alice.id, "accept"),
      /not the recipient/i
    );
  } finally { cleanup(ctx); }
});

test("respondToFriendRequest rejects invalid action", () => {
  const ctx = makeStores();
  try {
    const req = ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: ctx.bob.id });
    assert.throws(
      () => ctx.social.respondToFriendRequest(req.id, ctx.bob.id, "maybe"),
      /action must be/i
    );
  } finally { cleanup(ctx); }
});

test("cancelFriendRequest only sender can cancel", () => {
  const ctx = makeStores();
  try {
    const req = ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: ctx.bob.id });
    assert.throws(
      () => ctx.social.cancelFriendRequest(req.id, ctx.bob.id),
      /not the sender/i
    );
    const cancelled = ctx.social.cancelFriendRequest(req.id, ctx.alice.id);
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.resolved_at);
  } finally { cleanup(ctx); }
});

test("cancelFriendRequest is idempotent if already cancelled", () => {
  const ctx = makeStores();
  try {
    const req = ctx.social.createFriendRequestByUsername({ fromUserId: ctx.alice.id, toUserId: ctx.bob.id });
    ctx.social.cancelFriendRequest(req.id, ctx.alice.id);
    // second cancel should be a no-op returning the existing row
    const again = ctx.social.cancelFriendRequest(req.id, ctx.alice.id);
    assert.equal(again.status, "cancelled");
  } finally { cleanup(ctx); }
});

test("createConversation + getConversation roundtrip stores JSON fields", () => {
  const ctx = makeStores();
  try {
    const created = ctx.social.createConversation({
      id: "r-1",
      name: "Test",
      avatar: null,
      hostMember: null,
      decorations: { pinnedGoal: null, todos: [] },
      contextCard: null,
    });
    assert.equal(created.id, "r-1");
    assert.equal(created.name, "Test");
    assert.deepEqual(created.decorations, { pinnedGoal: null, todos: [] });
    assert.equal(created.hostMember, null);
    const fetched = ctx.social.getConversation("r-1");
    assert.deepEqual(fetched.decorations, { pinnedGoal: null, todos: [] });
  } finally { cleanup(ctx); }
});

test("addConversationMember + listConversationMembers", () => {
  const ctx = makeStores();
  try {
    ctx.social.createConversation({ id: "r-2", name: "Pair", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addConversationMember({ conversationId: "r-2", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    ctx.social.addConversationMember({ conversationId: "r-2", memberKind: "user", memberRef: ctx.bob.id, ownerId: null });
    const members = ctx.social.listConversationMembers("r-2");
    assert.equal(members.length, 2);
    const refs = members.map((m) => m.member_ref).sort();
    assert.deepEqual(refs, [ctx.alice.id, ctx.bob.id].sort());
  } finally { cleanup(ctx); }
});

test("listConversationsForUser returns conversations where user is a member", () => {
  const ctx = makeStores();
  try {
    ctx.social.createConversation({ id: "r-3", name: "R3", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addConversationMember({ conversationId: "r-3", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    ctx.social.addConversationMember({ conversationId: "r-3", memberKind: "user", memberRef: ctx.bob.id, ownerId: null });
    ctx.social.createConversation({ id: "r-4", name: "R4", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addConversationMember({ conversationId: "r-4", memberKind: "user", memberRef: ctx.bob.id, ownerId: null });
    const aliceConversations = ctx.social.listConversationsForUser(ctx.alice.id).map((r) => r.id).sort();
    assert.deepEqual(aliceConversations, ["r-3"]);
    const bobConversations = ctx.social.listConversationsForUser(ctx.bob.id).map((r) => r.id).sort();
    assert.deepEqual(bobConversations, ["r-3", "r-4"]);
  } finally { cleanup(ctx); }
});

test("deleteConversation cascade-removes conversation_members", () => {
  const ctx = makeStores();
  try {
    ctx.social.createConversation({ id: "r-5", name: "X", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addConversationMember({ conversationId: "r-5", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    ctx.social.deleteConversation("r-5");
    assert.equal(ctx.social.getConversation("r-5"), null);
    assert.deepEqual(ctx.social.listConversationMembers("r-5"), []);
  } finally { cleanup(ctx); }
});

test("removeConversationMember", () => {
  const ctx = makeStores();
  try {
    ctx.social.createConversation({ id: "r-6", name: "Y", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addConversationMember({ conversationId: "r-6", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    ctx.social.addConversationMember({ conversationId: "r-6", memberKind: "user", memberRef: ctx.bob.id, ownerId: null });
    ctx.social.removeConversationMember("r-6", "user", ctx.bob.id);
    const refs = ctx.social.listConversationMembers("r-6").map((m) => m.member_ref);
    assert.deepEqual(refs, [ctx.alice.id]);
  } finally { cleanup(ctx); }
});
