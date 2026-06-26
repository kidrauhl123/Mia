import {
  clearUnreadCount,
  hasCachedMessage,
  incrementUnreadCount,
  reconcileUnreadCountsWithReadMarks,
  shouldIncrementUnreadForMessage,
} from "../src/logic/unreadState";

test("未读计数只做本地事件增量和清零", () => {
  expect(incrementUnreadCount(undefined, "c1")).toEqual({ c1: 1 });
  expect(incrementUnreadCount({ c1: 1 }, "c1")).toEqual({ c1: 2 });
  expect(clearUnreadCount({ c1: 2, c2: 1 }, "c1")).toEqual({ c2: 1 });
});

test("桌面同步过来的 readMarks 覆盖会话摘要时清掉本地未读", () => {
  const conversations = [
    { id: "read", last_message_seq: 9 },
    { id: "still-unread", last_message_seq: 12 },
  ];
  expect(reconcileUnreadCountsWithReadMarks(
    { read: 3, "still-unread": 2, missing: 1 },
    { read: 9, "still-unread": 10, missing: 1 },
    conversations as any
  )).toEqual({ "still-unread": 2 });
});

test("消息事件按桌面规则决定是否递增未读", () => {
  const base = {
    conversationId: "c1",
    message: { id: "m1", seq: 8, sender_kind: "user", sender_ref: "u2" },
    selfId: "u1",
    readMarks: { c1: 5 },
  } as const;

  expect(shouldIncrementUnreadForMessage(base)).toBe(true);
  expect(shouldIncrementUnreadForMessage({ ...base, activeConversationId: "c1" })).toBe(false);
  expect(shouldIncrementUnreadForMessage({ ...base, message: { ...base.message, sender_ref: "u1" } })).toBe(false);
  expect(shouldIncrementUnreadForMessage({ ...base, readMarks: { c1: 8 } })).toBe(false);
});

test("事件重放时先按 messageId/clientTraceId 去重", () => {
  const cached = [
    { messageId: "m1", clientTraceId: "t1", role: "user", bodyMd: "a", isOwn: false, isPending: false, createdAt: "" },
  ];
  expect(hasCachedMessage(cached as any, { messageId: "m1" } as any)).toBe(true);
  expect(hasCachedMessage(cached as any, { messageId: "m2", clientTraceId: "t1" } as any)).toBe(true);
  expect(hasCachedMessage(cached as any, { messageId: "m3", clientTraceId: "t3" } as any)).toBe(false);
});
