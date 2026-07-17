import { buildPendingMessage, reconcilePending } from "../src/logic/optimisticSend";
import type { ChatMessage } from "../src/api/types";

test("buildPendingMessage 生成 pending 气泡", () => {
  const p = buildPendingMessage({ text: "hello" }, { selfId: "u1" });
  expect(p.bodyMd).toBe("hello");
  expect(p.isOwn).toBe(true);
  expect(p.isPending).toBe(true);
  expect(p.clientTraceId).toBeTruthy();
  expect(p.clientOpId).toBe(`op_${p.clientTraceId}`);
  expect(p.senderKind).toBe("user");
  expect(p.senderRef).toBe("u1");
});

test("空文本抛错", () => {
  expect(() => buildPendingMessage({ text: "  " }, { selfId: "u1" })).toThrow(/empty/i);
});

test("reconcile 按 clientTraceId 替换 pending", () => {
  const list: ChatMessage[] = [
    { messageId: "p1", clientTraceId: "t1", role: "user", bodyMd: "x", isOwn: true, isPending: true, createdAt: "" },
  ];
  const next = reconcilePending(list, { id: "s1", client_trace_id: "t1", body_md: "hi" });
  expect(next.length).toBe(1);
  expect(next[0].messageId).toBe("s1");
  expect(next[0].isPending).toBe(false);
});

test("reconcile 无匹配则追加", () => {
  const list: ChatMessage[] = [
    { messageId: "p1", clientTraceId: "t1", role: "user", bodyMd: "x", isOwn: true, isPending: true, createdAt: "" },
  ];
  const next = reconcilePending(list, { id: "s2", client_trace_id: "tX", body_md: "yo" });
  expect(next.length).toBe(2);
  expect(next[1].messageId).toBe("s2");
});
