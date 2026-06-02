const test = require("node:test");
const assert = require("node:assert");
const { buildPendingMessage, reconcilePending } = require("../packages/shared/optimistic-send");

test("buildPendingMessage 生成 pending 气泡(含 clientTraceId)", () => {
  const pending = buildPendingMessage({ text: "hello" }, { selfId: "u1" });
  assert.equal(pending.bodyMd, "hello");
  assert.equal(pending.isOwn, true);
  assert.equal(pending.isPending, true);
  assert.ok(pending.clientTraceId);
});

test("空文本抛 EMPTY_MESSAGE", () => {
  assert.throws(() => buildPendingMessage({ text: "  " }, { selfId: "u1" }), /EMPTY_MESSAGE|empty/);
});

test("reconcilePending: 按 clientTraceId 把 pending 换成服务端消息", () => {
  const list = [{ messageId: "p1", clientTraceId: "t1", isPending: true }];
  const server = { id: "s1", client_trace_id: "t1", body_md: "hi" };
  const next = reconcilePending(list, server);
  assert.equal(next.length, 1);
  assert.equal(next[0].messageId, "s1");
  assert.equal(next[0].isPending, false);
});

test("reconcilePending: 无匹配 trace 时追加新消息", () => {
  const list = [{ messageId: "p1", clientTraceId: "t1", isPending: true }];
  const server = { id: "s2", client_trace_id: "tX", body_md: "yo" };
  const next = reconcilePending(list, server);
  assert.equal(next.length, 2);
  assert.equal(next[1].messageId, "s2");
});
