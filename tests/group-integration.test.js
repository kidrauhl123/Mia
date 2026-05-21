const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createGroupStore } = require("../src/main/group-store.js");
const { createConductor } = require("../src/renderer/group/conductor.js");
const {
  parseMentions,
  filterRecentTurnsForFellow,
  buildFellowGroupContext,
  shouldSummarize,
} = require("../src/renderer/group/group-prompts.js");

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-it-"));
}

const fellows = [
  { id: "alice", name: "Alice" },
  { id: "bob", name: "Bob" },
  { id: "coder", name: "Coder" },
];
const fellowNamesById = Object.fromEntries(fellows.map((f) => [f.id, f.name]));

const dispatchTpl = "members:{{members}} summary:{{summary}} recent:{{recent}} user:{{userMessage}}";
const summarizeTpl = "old:{{oldSummary}} new:{{newMessages}}";

test("3-fellow group: user @ alice → only alice speaks", async () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "T",
    members: ["alice", "bob", "coder"],
    hostFellowId: "alice",
  });

  const engine = {
    call: async ({ kind, prompt }) => {
      if (kind === "dispatch") return '{"speak":["coder"]}';
      if (kind === "summarize") return "current summary";
      if (kind === "fellow-reply") return "fellow says hi";
      throw new Error("unexpected kind " + kind);
    },
  };

  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });

  const userMsg = {
    id: "m1",
    role: "user",
    turnId: "t1",
    content: "@Alice 你看下",
    mentions: parseMentions("@Alice 你看下", fellows),
  };
  store.appendMessage(group.id, userMsg);

  const dispatch = await conductor.decideDispatch({
    group: store.get(group.id),
    members: fellows.filter((f) => group.members.includes(f.id)),
    fellowNamesById,
    userMessage: userMsg,
    messages: store.listMessages(group.id),
  });

  assert.deepEqual(dispatch.speak, ["alice"]);
});

test("3-fellow group: no @ triggers dispatch LLM", async () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "T",
    members: ["alice", "bob", "coder"],
    hostFellowId: "alice",
  });

  let dispatchCalls = 0;
  const engine = {
    call: async ({ kind }) => {
      if (kind === "dispatch") {
        dispatchCalls++;
        return '{"speak":["bob","coder"]}';
      }
      throw new Error("unexpected kind");
    },
  };
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });

  const userMsg = {
    id: "m1",
    role: "user",
    turnId: "t1",
    content: "随便说",
    mentions: [],
  };
  const result = await conductor.decideDispatch({
    group: store.get(group.id),
    members: fellows,
    fellowNamesById,
    userMessage: userMsg,
    messages: [userMsg],
  });
  assert.equal(dispatchCalls, 1);
  assert.deepEqual(result.speak, ["bob", "coder"]);
});

test("summary triggers after 4 user turns and persists", async () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "T",
    members: ["alice", "bob"],
    hostFellowId: "alice",
  });

  let summarizeCalls = 0;
  const engine = {
    call: async ({ kind }) => {
      if (kind === "summarize") {
        summarizeCalls++;
        return "they're chatting about X";
      }
      throw new Error("unexpected");
    },
  };
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });

  const msgs = [];
  for (let i = 1; i <= 4; i++) {
    msgs.push({
      id: "m" + i, role: "user", turnId: "t" + i, content: "x" + i, mentions: [],
    });
    store.appendMessage(group.id, msgs[msgs.length - 1]);
  }

  assert.equal(shouldSummarize(store.get(group.id), msgs), true);
  const card = await conductor.summarize({
    group: store.get(group.id),
    fellowNamesById,
    messages: msgs,
  });
  store.saveContextCard(group.id, card);
  assert.equal(summarizeCalls, 1);
  const fresh = store.get(group.id);
  assert.equal(fresh.contextCard.summary, "they're chatting about X");
  assert.equal(fresh.contextCard.summaryUpToMsgId, "m4");
});

test("dispatch failure does not crash flow, no fellow speaks", async () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "T",
    members: ["alice", "bob"],
    hostFellowId: "alice",
  });
  const engine = {
    call: async ({ kind }) => {
      if (kind === "dispatch") throw new Error("offline");
      throw new Error("unexpected");
    },
  };
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const result = await conductor.decideDispatch({
    group: store.get(group.id),
    members: fellows,
    fellowNamesById,
    userMessage: { content: "hi", mentions: [], turnId: "t1" },
    messages: [],
  });
  assert.deepEqual(result, { speak: [], degraded: true });
});

test("host switch persists across reload", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "T",
    members: ["alice", "bob"],
    hostFellowId: "alice",
  });
  store.updateGroup(group.id, { hostFellowId: "bob" });

  const store2 = createGroupStore(root);
  const fresh = store2.get(group.id);
  assert.equal(fresh.hostFellowId, "bob");
});
