const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createGroupStore } = require("../src/main/group-store.js");

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-group-test-"));
}

test("create group writes group.json and manifest entry", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "Test Group",
    members: ["alice", "bob"],
    hostFellowId: "alice",
  });
  assert.ok(group.id);
  assert.equal(group.name, "Test Group");
  assert.deepEqual(group.members, ["alice", "bob"]);

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(root, group.id, "group.json"), "utf8")
  );
  assert.equal(onDisk.id, group.id);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8")
  );
  assert.equal(manifest.groups.length, 1);
});

test("list returns all groups", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  store.create({ name: "A", members: ["x", "y"], hostFellowId: "x" });
  store.create({ name: "B", members: ["y", "z"], hostFellowId: "y" });
  const groups = store.list();
  assert.equal(groups.length, 2);
});

test("appendMessage and listMessages roundtrip", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "G", members: ["a", "b"], hostFellowId: "a",
  });
  store.appendMessage(group.id, {
    id: "m1", role: "user", content: "hi", mentions: [], turnId: "t1",
  });
  store.appendMessage(group.id, {
    id: "m2", role: "fellow", senderFellowId: "a", content: "hello",
    mentions: [], turnId: "t1",
  });
  const msgs = store.listMessages(group.id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].content, "hi");
  assert.equal(msgs[1].senderFellowId, "a");
});

test("updateGroup persists host switch", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "G", members: ["a", "b"], hostFellowId: "a",
  });
  store.updateGroup(group.id, { hostFellowId: "b" });
  const fresh = store.get(group.id);
  assert.equal(fresh.hostFellowId, "b");
});

test("saveContextCard atomic write", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "G", members: ["a", "b"], hostFellowId: "a",
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
