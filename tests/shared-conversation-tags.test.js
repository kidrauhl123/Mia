const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  defaultConversationTags,
  normalizeConversationTags,
  pruneUnusedTagItems,
  tagsForTarget,
  assignTagNames,
} = require("../src/shared/conversation-tags.js");

test("defaultConversationTags returns the empty settings shape", () => {
  assert.deepEqual(defaultConversationTags(), { items: [], assignments: {} });
});

test("assignTagNames creates reusable named tags and assigns them to a conversation", () => {
  const first = assignTagNames(defaultConversationTags(), "dm:u_a:u_b", ["工作", "客户"]);
  assert.deepEqual(first.items.map((item) => item.name), ["工作", "客户"]);
  assert.equal(first.assignments["dm:u_a:u_b"].length, 2);

  const second = assignTagNames(first, "g_team", ["客户"]);
  assert.equal(second.items.length, 2, "existing tag names should be reused");
  assert.deepEqual(tagsForTarget(second, "g_team").map((tag) => tag.name), ["客户"]);
});

test("assignTagNames clears a conversation assignment when given no names", () => {
  const tagged = assignTagNames(defaultConversationTags(), "dm:u_a:u_b", ["工作"]);
  const cleared = assignTagNames(tagged, "dm:u_a:u_b", []);

  assert.deepEqual(tagsForTarget(cleared, "dm:u_a:u_b"), []);
  assert.deepEqual(cleared.assignments, {});
  assert.deepEqual(cleared.items, []);
});

test("assignTagNames only keeps tags that are still assigned somewhere", () => {
  const tagged = assignTagNames(defaultConversationTags(), "dm:u_a:u_b", ["工作"]);
  const reused = assignTagNames(tagged, "dm:u_a:u_c", ["工作"]);
  const clearedOne = assignTagNames(reused, "dm:u_a:u_b", []);

  assert.deepEqual(clearedOne.items.map((item) => item.name), ["工作"]);
  assert.deepEqual(tagsForTarget(clearedOne, "dm:u_a:u_c").map((tag) => tag.name), ["工作"]);

  const clearedAll = assignTagNames(clearedOne, "dm:u_a:u_c", []);
  assert.deepEqual(clearedAll.items, []);
  assert.deepEqual(clearedAll.assignments, {});
});

test("pruneUnusedTagItems removes unassigned tag items instead of keeping deleted state", () => {
  const pruned = pruneUnusedTagItems({
    items: [
      { id: "tag_used", name: "工作", color: "#2563eb" },
      { id: "tag_unused", name: "未引用", color: "#dc2626" }
    ],
    assignments: { "dm:u_a:u_b": ["tag_used"] }
  });

  assert.deepEqual(pruned.items.map((item) => item.name), ["工作"]);
  assert.deepEqual(pruned.assignments, { "dm:u_a:u_b": ["tag_used"] });
});

test("assignTagNames caps each conversation at three tags", () => {
  const tagged = assignTagNames(defaultConversationTags(), "dm:u_a:u_b", ["一", "二", "三", "四"]);

  assert.deepEqual(tagsForTarget(tagged, "dm:u_a:u_b").map((tag) => tag.name), ["一", "二", "三"]);
});

test("normalizeConversationTags drops invalid assignments and colors defensively", () => {
  const normalized = normalizeConversationTags({
    items: [
      { id: "client", name: "客户", color: "not-css" },
      { id: "client", name: "重复", color: "#ff0000" },
      { id: "", name: "" },
    ],
    assignments: {
      "dm:u_a:u_b": ["client", "missing", "client"],
      "": ["client"],
    },
  });

  assert.deepEqual(normalized.items.map((item) => item.name), ["客户", "重复"]);
  assert.match(normalized.items[0].id, /^tag_client/);
  assert.equal(normalized.items[0].color, "#2563eb");
  assert.deepEqual(normalized.assignments["dm:u_a:u_b"], [normalized.items[0].id]);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized.assignments, ""), false);
});
