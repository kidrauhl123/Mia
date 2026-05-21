const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  makeFellowMember,
  isFellowMember,
  memberKey,
  normalizeMember,
  normalizeMembersList,
  membersIncludeKey,
} = require("../src/main/group/member-model.js");

test("makeFellowMember builds canonical Member", () => {
  const m = makeFellowMember("aimashi");
  assert.deepEqual(m, { kind: "fellow", fellowId: "aimashi", ownerId: null });
});

test("makeFellowMember rejects empty fellowId", () => {
  assert.throws(() => makeFellowMember(""), /fellowId/);
  assert.throws(() => makeFellowMember(null), /fellowId/);
});

test("makeFellowMember preserves ownerId when provided", () => {
  const m = makeFellowMember("codex", { ownerId: "u-123" });
  assert.equal(m.ownerId, "u-123");
});

test("isFellowMember discriminates kind", () => {
  assert.equal(isFellowMember({ kind: "fellow", fellowId: "x", ownerId: null }), true);
  assert.equal(isFellowMember({ kind: "user", userId: "u" }), false);
  assert.equal(isFellowMember(null), false);
  assert.equal(isFellowMember({ fellowId: "x" }), false);
});

test("memberKey returns kind-prefixed unique key", () => {
  assert.equal(memberKey({ kind: "fellow", fellowId: "aimashi", ownerId: null }), "fellow:aimashi");
});

test("normalizeMember upgrades legacy string to fellow Member", () => {
  assert.deepEqual(
    normalizeMember("aimashi"),
    { kind: "fellow", fellowId: "aimashi", ownerId: null }
  );
});

test("normalizeMember passes through already-normalized Member", () => {
  const m = { kind: "fellow", fellowId: "codex", ownerId: null };
  assert.deepEqual(normalizeMember(m), m);
});

test("normalizeMember rejects malformed input", () => {
  assert.throws(() => normalizeMember(null), /member/);
  assert.throws(() => normalizeMember({ kind: "fellow" }), /fellowId/);
  assert.throws(() => normalizeMember({ kind: "user" }), /kind/); // R phase rejects user kind
});

test("normalizeMembersList accepts mixed legacy + new", () => {
  const list = normalizeMembersList([
    "aimashi",
    { kind: "fellow", fellowId: "codex", ownerId: null },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].fellowId, "aimashi");
  assert.equal(list[1].fellowId, "codex");
});

test("membersIncludeKey matches by canonical key", () => {
  const list = [makeFellowMember("aimashi"), makeFellowMember("codex")];
  assert.equal(membersIncludeKey(list, "fellow:aimashi"), true);
  assert.equal(membersIncludeKey(list, "fellow:nope"), false);
});
