const test = require("node:test");
const assert = require("node:assert");
const { createApprovalQueue } = require("../src/mobile/lib/approval-queue");

test("request 入队,active 为最早一条", () => {
  const q = createApprovalQueue();
  q.onRequest({ conversationId: "c1", runId: "r1", preview: "rm -rf" });
  q.onRequest({ conversationId: "c1", runId: "r2", preview: "ls" });
  assert.equal(q.active().runId, "r1");
  assert.equal(q.size(), 2);
});

test("resolve 当前条后 active 前进", () => {
  const q = createApprovalQueue();
  q.onRequest({ conversationId: "c1", runId: "r1" });
  q.onRequest({ conversationId: "c1", runId: "r2" });
  q.resolve("r1");
  assert.equal(q.active().runId, "r2");
});

test("responded 事件等价于移除该条", () => {
  const q = createApprovalQueue();
  q.onRequest({ conversationId: "c1", runId: "r1" });
  q.onResponded("r1");
  assert.equal(q.active(), null);
  assert.equal(q.size(), 0);
});

test("重复 request 同 runId 不重复入队", () => {
  const q = createApprovalQueue();
  q.onRequest({ conversationId: "c1", runId: "r1", preview: "a" });
  q.onRequest({ conversationId: "c1", runId: "r1", preview: "a" });
  assert.equal(q.size(), 1);
});
