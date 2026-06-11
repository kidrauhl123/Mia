const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createSocialStore } = require("../src/cloud/social-store.js");
const { dmConversationId, ensureDmConversation } = require("../src/cloud/dm-conversation.js");
const { createCloudUser } = require("./helpers/cloud-auth.js");

test("dmConversationId is sorted and deterministic regardless of arg order", () => {
  assert.equal(dmConversationId("u_b", "u_a"), "dm:u_a:u_b");
  assert.equal(dmConversationId("u_a", "u_b"), "dm:u_a:u_b");
  assert.equal(dmConversationId("u_xyz", "u_abc"), "dm:u_abc:u_xyz");
});

test("dmConversationId throws on identical user ids", () => {
  assert.throws(() => dmConversationId("u_a", "u_a"), /same user/i);
});

test("ensureDmConversation creates conversation and adds two members on first call", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-dm-test-"));
  const cloudStore = createCloudStore({ dataDir: tmpDir });
  try {
    const social = createSocialStore(cloudStore.getDb());
    const alice = createCloudUser(cloudStore, "alice");
    const bob = createCloudUser(cloudStore, "bob");
    social.addFriendship(alice.id, bob.id);
    const conversation = ensureDmConversation(social, alice.id, bob.id);
    assert.equal(conversation.id, dmConversationId(alice.id, bob.id));
    const members = social.listConversationMembers(conversation.id);
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

test("ensureDmConversation returns existing conversation on second call (idempotent)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-dm-test2-"));
  const cloudStore = createCloudStore({ dataDir: tmpDir });
  try {
    const social = createSocialStore(cloudStore.getDb());
    const alice = createCloudUser(cloudStore, "alice");
    const bob = createCloudUser(cloudStore, "bob");
    social.addFriendship(alice.id, bob.id);
    const first = ensureDmConversation(social, alice.id, bob.id);
    const second = ensureDmConversation(social, alice.id, bob.id);
    assert.equal(first.id, second.id);
    assert.equal(social.listConversationMembers(first.id).length, 2);
  } finally {
    cloudStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureDmConversation rejects non-friends", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-dm-test3-"));
  const cloudStore = createCloudStore({ dataDir: tmpDir });
  try {
    const social = createSocialStore(cloudStore.getDb());
    const alice = createCloudUser(cloudStore, "alice");
    const stranger = createCloudUser(cloudStore, "stranger");
    assert.throws(() => ensureDmConversation(social, alice.id, stranger.id), /not friends/i);
  } finally {
    cloudStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
