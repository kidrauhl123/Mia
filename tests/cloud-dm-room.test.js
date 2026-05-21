const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createSocialStore } = require("../src/cloud/social-store.js");
const { dmRoomId, ensureDmRoom } = require("../src/cloud/dm-room.js");

test("dmRoomId is sorted and deterministic regardless of arg order", () => {
  assert.equal(dmRoomId("u_b", "u_a"), "dm:u_a:u_b");
  assert.equal(dmRoomId("u_a", "u_b"), "dm:u_a:u_b");
  assert.equal(dmRoomId("u_xyz", "u_abc"), "dm:u_abc:u_xyz");
});

test("dmRoomId throws on identical user ids", () => {
  assert.throws(() => dmRoomId("u_a", "u_a"), /same user/i);
});

test("ensureDmRoom creates room and adds two members on first call", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-dm-test-"));
  const cloudStore = createCloudStore({ dataDir: tmpDir });
  try {
    const social = createSocialStore(cloudStore.getDb());
    const alice = cloudStore.registerUser({ username: "alice", password: "Pa55word!" }).user;
    const bob = cloudStore.registerUser({ username: "bob", password: "Pa55word!" }).user;
    social.addFriendship(alice.id, bob.id);
    const room = ensureDmRoom(social, alice.id, bob.id);
    assert.equal(room.id, dmRoomId(alice.id, bob.id));
    const members = social.listRoomMembers(room.id);
    const refs = members.map((m) => m.member_ref).sort();
    assert.deepEqual(refs, [alice.id, bob.id].sort());
    for (const m of members) {
      assert.equal(m.member_kind, "user");
    }
  } finally {
    cloudStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureDmRoom returns existing room on second call (idempotent)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-dm-test2-"));
  const cloudStore = createCloudStore({ dataDir: tmpDir });
  try {
    const social = createSocialStore(cloudStore.getDb());
    const alice = cloudStore.registerUser({ username: "alice", password: "Pa55word!" }).user;
    const bob = cloudStore.registerUser({ username: "bob", password: "Pa55word!" }).user;
    social.addFriendship(alice.id, bob.id);
    const first = ensureDmRoom(social, alice.id, bob.id);
    const second = ensureDmRoom(social, alice.id, bob.id);
    assert.equal(first.id, second.id);
    assert.equal(social.listRoomMembers(first.id).length, 2);
  } finally {
    cloudStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureDmRoom rejects non-friends", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-dm-test3-"));
  const cloudStore = createCloudStore({ dataDir: tmpDir });
  try {
    const social = createSocialStore(cloudStore.getDb());
    const alice = cloudStore.registerUser({ username: "alice", password: "Pa55word!" }).user;
    const stranger = cloudStore.registerUser({ username: "stranger", password: "Pa55word!" }).user;
    assert.throws(() => ensureDmRoom(social, alice.id, stranger.id), /not friends/i);
  } finally {
    cloudStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
