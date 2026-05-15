const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseMentions,
  filterRecentTurnsForFellow,
} = require("../src/renderer/group-prompts.js");

const fellows = [
  { id: "alice", name: "Alice" },
  { id: "bob", name: "Bob" },
  { id: "coder", name: "Coder" },
];

test("parseMentions extracts @name and resolves to fellow ids", () => {
  assert.deepEqual(parseMentions("hey @alice 看下", fellows), ["alice"]);
  assert.deepEqual(parseMentions("@alice @bob 一起", fellows), ["alice", "bob"]);
  assert.deepEqual(parseMentions("没人", fellows), []);
});

test("parseMentions ignores unknown @names", () => {
  assert.deepEqual(parseMentions("@nobody 在吗", fellows), []);
});

test("parseMentions dedupes", () => {
  assert.deepEqual(parseMentions("@alice @alice 重复", fellows), ["alice"]);
});

test("parseMentions skips escaped \\@name", () => {
  assert.deepEqual(parseMentions("看下 \\@alice 转义", fellows), []);
});

test("filterRecentTurnsForFellow returns last K turns mentioning the fellow", () => {
  const messages = [
    { id: "m1", role: "user", turnId: "t1", mentions: ["alice"], content: "@alice" },
    { id: "m2", role: "fellow", senderFellowId: "alice", turnId: "t1", content: "hi" },
    { id: "m3", role: "user", turnId: "t2", mentions: ["bob"], content: "@bob" },
    { id: "m4", role: "fellow", senderFellowId: "bob", turnId: "t2", content: "yo" },
    { id: "m5", role: "user", turnId: "t3", mentions: ["alice"], content: "@alice 2" },
    { id: "m6", role: "fellow", senderFellowId: "alice", turnId: "t3", content: "hi 2" },
  ];
  const filtered = filterRecentTurnsForFellow(messages, "alice", 3);
  assert.equal(filtered.length, 4);
  assert.deepEqual(filtered.map((m) => m.id), ["m1", "m2", "m5", "m6"]);
});

test("filterRecentTurnsForFellow caps at K most recent matching turns", () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    id: "m" + i,
    role: i % 2 === 0 ? "user" : "fellow",
    turnId: "t" + Math.floor(i / 2),
    senderFellowId: i % 2 === 0 ? null : "alice",
    mentions: i % 2 === 0 ? ["alice"] : [],
    content: "msg " + i,
  }));
  const filtered = filterRecentTurnsForFellow(messages, "alice", 2);
  const turnIds = [...new Set(filtered.map((m) => m.turnId))];
  assert.deepEqual(turnIds, ["t3", "t4"]);
});

const {
  buildDispatchPrompt,
  buildSummarizePrompt,
  buildFellowGroupContext,
  shouldSummarize,
} = require("../src/renderer/group-prompts.js");

const dispatchTemplate = `members: {{members}}\nsummary: {{summary}}\nrecent: {{recent}}\nuser: {{userMessage}}`;

test("buildDispatchPrompt fills template", () => {
  const out = buildDispatchPrompt(dispatchTemplate, {
    members: [{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }],
    summary: "talking about lunch",
    recentMessages: [
      { role: "user", content: "hi" },
      { role: "fellow", senderFellowId: "a", content: "yo" },
    ],
    fellowNamesById: { a: "Alice", b: "Bob" },
    userMessage: "where to eat",
  });
  assert.match(out, /Alice/);
  assert.match(out, /Bob/);
  assert.match(out, /talking about lunch/);
  assert.match(out, /where to eat/);
});

test("buildSummarizePrompt fills template", () => {
  const tmpl = `old: {{oldSummary}}\nnew: {{newMessages}}`;
  const out = buildSummarizePrompt(tmpl, {
    oldSummary: "they were arguing",
    newMessages: [
      { role: "user", content: "ok fine" },
    ],
    fellowNamesById: { a: "Alice" },
  });
  assert.match(out, /they were arguing/);
  assert.match(out, /ok fine/);
});

test("buildFellowGroupContext returns block ready for engine prefix", () => {
  const block = buildFellowGroupContext({
    groupName: "lunch crew",
    summary: "discussing lunch",
    recentForFellow: [
      { role: "user", content: "@alice", mentions: ["alice"] },
      { role: "fellow", senderFellowId: "alice", content: "yes?" },
    ],
    fellowNamesById: { alice: "Alice" },
  });
  assert.match(block, /lunch crew/);
  assert.match(block, /discussing lunch/);
  assert.match(block, /Alice/);
});

test("shouldSummarize triggers every 4 user turns", () => {
  const card = null;
  const messages = [
    { role: "user", turnId: "t1" },
    { role: "user", turnId: "t2" },
    { role: "user", turnId: "t3" },
  ];
  assert.equal(shouldSummarize({ contextCard: card }, messages), false);

  const four = [...messages, { role: "user", turnId: "t4" }];
  assert.equal(shouldSummarize({ contextCard: card }, four), true);
});

test("shouldSummarize respects last covered message", () => {
  const cardCovering3 = {
    summary: "x",
    summaryUpToMsgId: "m3",
    updatedAt: 0,
  };
  const msgs = [
    { id: "m1", role: "user", turnId: "t1" },
    { id: "m2", role: "user", turnId: "t2" },
    { id: "m3", role: "user", turnId: "t3" },
    { id: "m4", role: "user", turnId: "t4" },
    { id: "m5", role: "user", turnId: "t5" },
    { id: "m6", role: "user", turnId: "t6" },
    { id: "m7", role: "user", turnId: "t7" },
  ];
  assert.equal(shouldSummarize({ contextCard: cardCovering3 }, msgs), true);

  const cardCovering7 = {
    summary: "x",
    summaryUpToMsgId: "m7",
    updatedAt: 0,
  };
  assert.equal(shouldSummarize({ contextCard: cardCovering7 }, msgs), false);
});
