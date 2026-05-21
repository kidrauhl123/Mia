const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createGroupStore } = require("../src/main/group-store.js");
const { makeFellowMember } = require("../src/main/group/member-model.js");

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-group-test-"));
}

test("create group writes group.json with Member-shaped fields", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "Test Group",
    members: [makeFellowMember("alice"), makeFellowMember("bob")],
    hostMember: makeFellowMember("alice"),
  });
  assert.ok(group.id);
  assert.equal(group.name, "Test Group");
  assert.equal(group.members.length, 2);
  assert.equal(group.members[0].kind, "fellow");
  assert.equal(group.members[0].fellowId, "alice");
  assert.equal(group.hostMember.kind, "fellow");
  assert.equal(group.hostMember.fellowId, "alice");

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(root, group.id, "group.json"), "utf8")
  );
  assert.equal(onDisk.hostMember.fellowId, "alice");
  assert.equal(onDisk.members.length, 2);
});

test("create group accepts legacy string inputs and normalizes to Member", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "Legacy",
    members: ["alice", "bob"],
    hostFellowId: "alice",
  });
  assert.equal(group.hostMember.fellowId, "alice");
  assert.equal(group.members[1].fellowId, "bob");
  // legacy field should NOT appear in result
  assert.equal(group.hostFellowId, undefined);
});

test("create group throws when hostMember is not in members", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  assert.throws(
    () => store.create({
      name: "Bad",
      members: [makeFellowMember("a"), makeFellowMember("b")],
      hostMember: makeFellowMember("c"),
    }),
    /hostMember must be one of members/
  );
});

test("list returns all groups", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  store.create({ name: "A", members: [makeFellowMember("x"), makeFellowMember("y")], hostMember: makeFellowMember("x") });
  store.create({ name: "B", members: [makeFellowMember("y"), makeFellowMember("z")], hostMember: makeFellowMember("y") });
  const groups = store.list();
  assert.equal(groups.length, 2);
});

test("appendMessage and listMessages roundtrip", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "G", members: [makeFellowMember("a"), makeFellowMember("b")], hostMember: makeFellowMember("a"),
  });
  const touched = store.appendMessage(group.id, {
    id: "m1", role: "user", content: "hi", mentions: [], turnId: "t1", createdAt: group.updatedAt + 10,
  });
  assert.equal(touched.updatedAt, group.updatedAt + 10);
  store.appendMessage(group.id, {
    id: "m2", role: "fellow", senderFellowId: "a", content: "hello",
    mentions: [], turnId: "t1", createdAt: group.updatedAt + 20,
  });
  const msgs = store.listMessages(group.id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].content, "hi");
  assert.equal(msgs[1].senderFellowId, "a");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.groups[0].updatedAt, group.updatedAt + 20);
});

test("updateGroup persists host switch", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "G", members: [makeFellowMember("a"), makeFellowMember("b")], hostMember: makeFellowMember("a"),
  });
  store.updateGroup(group.id, { hostFellowId: "b" });
  const fresh = store.get(group.id);
  assert.equal(fresh.hostFellowId, "b");
});

test("deleteGroup removes manifest entry and group files", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "G", members: [makeFellowMember("a"), makeFellowMember("b")], hostMember: makeFellowMember("a"),
  });
  store.appendMessage(group.id, {
    id: "m1", role: "user", content: "hi", mentions: [], turnId: "t1",
  });

  assert.equal(store.deleteGroup(group.id), true);
  assert.equal(store.get(group.id), null);
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(path.join(root, group.id)), false);
});

test("saveContextCard atomic write", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "G", members: [makeFellowMember("a"), makeFellowMember("b")], hostMember: makeFellowMember("a"),
  });
  store.saveContextCard(group.id, {
    summary: "they're talking about X",
    summaryUpToMsgId: "m5",
    updatedAt: Date.now(),
  });
  const card = JSON.parse(
    fs.readFileSync(path.join(root, group.id, "context-card.json"), "utf8")
  );
  assert.equal(card.summary, "they're talking about X");
});
