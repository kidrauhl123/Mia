const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createSocialStore } = require("../src/cloud/social-store.js");

function makeStores() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-social-test-"));
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

test("createFriendRequest stores pending with code", () => {
  const ctx = makeStores();
  try {
    const req = ctx.social.createFriendRequest({ fromUser: ctx.alice.id, code: "ABC12345" });
    assert.ok(req.id);
    assert.equal(req.status, "pending");
    assert.equal(req.code, "ABC12345");
    const fetched = ctx.social.getFriendRequestByCode("ABC12345");
    assert.equal(fetched.id, req.id);
  } finally { cleanup(ctx); }
});

test("acceptFriendRequest creates friendship and marks accepted atomically", () => {
  const ctx = makeStores();
  try {
    ctx.social.createFriendRequest({ fromUser: ctx.alice.id, code: "CODE1" });
    const resolved = ctx.social.acceptFriendRequest("CODE1", ctx.bob.id);
    assert.equal(resolved.status, "accepted");
    assert.ok(resolved.resolved_at);
    assert.equal(ctx.social.areFriends(ctx.alice.id, ctx.bob.id), true);
  } finally { cleanup(ctx); }
});

test("acceptFriendRequest rejects already-consumed code", () => {
  const ctx = makeStores();
  try {
    ctx.social.createFriendRequest({ fromUser: ctx.alice.id, code: "ONCE" });
    ctx.social.acceptFriendRequest("ONCE", ctx.bob.id);
    const charlie = ctx.cloudStore.registerUser({ username: "charlie", password: "Pa55word!" }).user;
    assert.throws(() => ctx.social.acceptFriendRequest("ONCE", charlie.id), /not pending|already/i);
  } finally { cleanup(ctx); }
});

test("acceptFriendRequest rejects self-accept", () => {
  const ctx = makeStores();
  try {
    ctx.social.createFriendRequest({ fromUser: ctx.alice.id, code: "SELF" });
    assert.throws(() => ctx.social.acceptFriendRequest("SELF", ctx.alice.id), /self/i);
  } finally { cleanup(ctx); }
});

test("revokeFriendRequest marks expired only by owner", () => {
  const ctx = makeStores();
  try {
    ctx.social.createFriendRequest({ fromUser: ctx.alice.id, code: "REV" });
    assert.throws(() => ctx.social.revokeFriendRequest("REV", ctx.bob.id), /not owner|forbidden/i);
    ctx.social.revokeFriendRequest("REV", ctx.alice.id);
    const row = ctx.social.getFriendRequestByCode("REV");
    assert.equal(row.status, "expired");
  } finally { cleanup(ctx); }
});

test("expireOldRequests transitions pending older than maxAgeMs to expired", async () => {
  const ctx = makeStores();
  try {
    ctx.social.createFriendRequest({ fromUser: ctx.alice.id, code: "OLD" });
    await new Promise((r) => setTimeout(r, 50));
    const n = ctx.social.expireOldRequests(25);
    assert.ok(n >= 1);
    const row = ctx.social.getFriendRequestByCode("OLD");
    assert.equal(row.status, "expired");
  } finally { cleanup(ctx); }
});

test("createRoom + getRoom roundtrip stores JSON fields", () => {
  const ctx = makeStores();
  try {
    const created = ctx.social.createRoom({
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
    const fetched = ctx.social.getRoom("r-1");
    assert.deepEqual(fetched.decorations, { pinnedGoal: null, todos: [] });
  } finally { cleanup(ctx); }
});

test("addRoomMember + listRoomMembers", () => {
  const ctx = makeStores();
  try {
    ctx.social.createRoom({ id: "r-2", name: "Pair", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addRoomMember({ roomId: "r-2", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    ctx.social.addRoomMember({ roomId: "r-2", memberKind: "user", memberRef: ctx.bob.id, ownerId: null });
    const members = ctx.social.listRoomMembers("r-2");
    assert.equal(members.length, 2);
    const refs = members.map((m) => m.member_ref).sort();
    assert.deepEqual(refs, [ctx.alice.id, ctx.bob.id].sort());
  } finally { cleanup(ctx); }
});

test("listRoomsForUser returns rooms where user is a member", () => {
  const ctx = makeStores();
  try {
    ctx.social.createRoom({ id: "r-3", name: "R3", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addRoomMember({ roomId: "r-3", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    ctx.social.addRoomMember({ roomId: "r-3", memberKind: "user", memberRef: ctx.bob.id, ownerId: null });
    ctx.social.createRoom({ id: "r-4", name: "R4", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addRoomMember({ roomId: "r-4", memberKind: "user", memberRef: ctx.bob.id, ownerId: null });
    const aliceRooms = ctx.social.listRoomsForUser(ctx.alice.id).map((r) => r.id).sort();
    assert.deepEqual(aliceRooms, ["r-3"]);
    const bobRooms = ctx.social.listRoomsForUser(ctx.bob.id).map((r) => r.id).sort();
    assert.deepEqual(bobRooms, ["r-3", "r-4"]);
  } finally { cleanup(ctx); }
});

test("deleteRoom cascade-removes room_members", () => {
  const ctx = makeStores();
  try {
    ctx.social.createRoom({ id: "r-5", name: "X", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addRoomMember({ roomId: "r-5", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    ctx.social.deleteRoom("r-5");
    assert.equal(ctx.social.getRoom("r-5"), null);
    assert.deepEqual(ctx.social.listRoomMembers("r-5"), []);
  } finally { cleanup(ctx); }
});

test("removeRoomMember", () => {
  const ctx = makeStores();
  try {
    ctx.social.createRoom({ id: "r-6", name: "Y", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addRoomMember({ roomId: "r-6", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    ctx.social.addRoomMember({ roomId: "r-6", memberKind: "user", memberRef: ctx.bob.id, ownerId: null });
    ctx.social.removeRoomMember("r-6", "user", ctx.bob.id);
    const refs = ctx.social.listRoomMembers("r-6").map((m) => m.member_ref);
    assert.deepEqual(refs, [ctx.alice.id]);
  } finally { cleanup(ctx); }
});
