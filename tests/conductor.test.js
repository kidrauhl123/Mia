const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createConductor } = require("../src/renderer/group/conductor.js");

function mockEngine(responses) {
  const calls = [];
  return {
    calls,
    call: async ({ kind, prompt }) => {
      calls.push({ kind, prompt });
      if (kind in responses) {
        if (responses[kind] instanceof Error) throw responses[kind];
        return responses[kind];
      }
      throw new Error("no mock for kind " + kind);
    },
  };
}

const fellows = [
  { id: "alice", name: "Alice" },
  { id: "bob", name: "Bob" },
];

const dispatchTpl = "members:{{members}} summary:{{summary}} user:{{userMessage}}";
const summarizeTpl = "old:{{oldSummary}} new:{{newMessages}}";

test("explicit @ skips dispatch LLM call", async () => {
  const engine = mockEngine({});
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const result = await conductor.decideDispatch({
    group: { id: "g1", members: ["alice", "bob"], hostFellowId: "alice", contextCard: null },
    members: fellows,
    fellowNamesById: { alice: "Alice", bob: "Bob" },
    userMessage: { content: "@alice 看下", mentions: ["alice"], turnId: "t1" },
    messages: [],
  });
  assert.deepEqual(result, { speak: ["alice"] });
  assert.equal(engine.calls.length, 0);
});

test("no @ calls dispatch LLM and parses JSON", async () => {
  const engine = mockEngine({ dispatch: '{"speak":["bob"]}' });
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const result = await conductor.decideDispatch({
    group: { id: "g1", members: ["alice", "bob"], hostFellowId: "alice", contextCard: null },
    members: fellows,
    fellowNamesById: { alice: "Alice", bob: "Bob" },
    userMessage: { content: "随便说", mentions: [], turnId: "t1" },
    messages: [],
  });
  assert.deepEqual(result, { speak: ["bob"] });
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].kind, "dispatch");
});

test("dispatch failure degrades to no speakers", async () => {
  const engine = mockEngine({ dispatch: new Error("engine down") });
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const result = await conductor.decideDispatch({
    group: { id: "g1", members: ["alice", "bob"], hostFellowId: "alice", contextCard: null },
    members: fellows,
    fellowNamesById: { alice: "Alice", bob: "Bob" },
    userMessage: { content: "啥", mentions: [], turnId: "t1" },
    messages: [],
  });
  assert.deepEqual(result, { speak: [], degraded: true });
});

test("dispatch returns non-JSON degrades", async () => {
  const engine = mockEngine({ dispatch: "the answer is alice" });
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const result = await conductor.decideDispatch({
    group: { id: "g1", members: ["alice", "bob"], hostFellowId: "alice", contextCard: null },
    members: fellows,
    fellowNamesById: { alice: "Alice", bob: "Bob" },
    userMessage: { content: "啥", mentions: [], turnId: "t1" },
    messages: [],
  });
  assert.deepEqual(result.speak, []);
  assert.equal(result.degraded, true);
});

test("dispatch filters unknown fellow ids", async () => {
  const engine = mockEngine({ dispatch: '{"speak":["alice","unknown"]}' });
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const result = await conductor.decideDispatch({
    group: { id: "g1", members: ["alice", "bob"], hostFellowId: "alice", contextCard: null },
    members: fellows,
    fellowNamesById: { alice: "Alice", bob: "Bob" },
    userMessage: { content: "啥", mentions: [], turnId: "t1" },
    messages: [],
  });
  assert.deepEqual(result.speak, ["alice"]);
});

test("summarize returns new card", async () => {
  const engine = mockEngine({ summarize: "  they decided on pasta  " });
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const msgs = [
    { id: "m1", role: "user", turnId: "t1", content: "lunch?" },
    { id: "m2", role: "fellow", senderFellowId: "alice", turnId: "t1", content: "pasta" },
  ];
  const card = await conductor.summarize({
    group: { id: "g1", contextCard: null },
    fellowNamesById: { alice: "Alice" },
    messages: msgs,
  });
  assert.equal(card.summary, "they decided on pasta");
  assert.equal(card.summaryUpToMsgId, "m2");
  assert.ok(card.updatedAt > 0);
});

test("summarize failure returns null (caller keeps old card)", async () => {
  const engine = mockEngine({ summarize: new Error("engine down") });
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const card = await conductor.summarize({
    group: { id: "g1", contextCard: null },
    fellowNamesById: {},
    messages: [{ id: "m1", role: "user", turnId: "t1", content: "x" }],
  });
  assert.equal(card, null);
});
