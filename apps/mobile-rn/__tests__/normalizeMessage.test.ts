import { normalizeServerRow, mergeMessage } from "../src/logic/normalizeMessage";
import type { ChatMessage } from "../src/api/types";

test("bot 消息 → assistant,不 own", () => {
  const m = normalizeServerRow({ id: "m1", sender_kind: "bot", sender_ref: "claude", body_md: "hi" }, "u1");
  expect(m.role).toBe("assistant");
  expect(m.isOwn).toBe(false);
});

test("自己的 user 消息 → own", () => {
  const m = normalizeServerRow({ id: "m2", seq: 7, sender_kind: "user", sender_ref: "u1", body_md: "yo" }, "u1");
  expect(m.role).toBe("user");
  expect(m.isOwn).toBe(true);
  expect(m.seq).toBe(7);
});

test("trace_json 解析", () => {
  const m = normalizeServerRow(
    { id: "m3", sender_kind: "bot", trace_json: JSON.stringify({ reasoning: "think" }) },
    "u1"
  );
  expect(m.trace?.reasoning).toBe("think");
});

test("attachments are normalized onto ChatMessage", () => {
  const m = normalizeServerRow({
    id: "m4",
    sender_kind: "bot",
    attachments: [{ id: "f1", name: "shot.png", mimeType: "image/png", url: "/api/files/f1" }],
  }, "u1");
  expect(m.attachments).toEqual([{ id: "f1", type: "image", name: "shot.png", mimeType: "image/png", url: "/api/files/f1" }]);
});

test("mergeMessage: clientTraceId 替换 pending", () => {
  const list: ChatMessage[] = [
    { messageId: "pending:t1", clientTraceId: "t1", role: "user", bodyMd: "x", isOwn: true, isPending: true, createdAt: "" },
  ];
  const incoming = normalizeServerRow({ id: "s1", sender_kind: "user", sender_ref: "u1", client_trace_id: "t1", body_md: "x" }, "u1");
  const next = mergeMessage(list, incoming);
  expect(next.length).toBe(1);
  expect(next[0].messageId).toBe("s1");
  expect(next[0].isPending).toBe(false);
});

test("normalizeServerRow uses server turn_id as clientTraceId", () => {
  const m = normalizeServerRow({ id: "m-turn", sender_kind: "user", sender_ref: "u1", turn_id: "t1", body_md: "x" } as any, "u1");
  expect(m.clientTraceId).toBe("t1");
});

test("normalizeServerRow preserves sender and status badge metadata", () => {
  const badge = { kind: "lottie" as const, assetId: "rainbow", label: "Active" };
  const m = normalizeServerRow({ id: "m-badge", sender_kind: "bot", sender_ref: "mia", body_md: "x", statusBadge: badge }, "u1");
  expect(m.senderKind).toBe("bot");
  expect(m.senderRef).toBe("mia");
  expect(m.statusBadge).toEqual(badge);
});

test("mergeMessage: removes websocket duplicate after turn_id reconciliation", () => {
  const pending: ChatMessage = { messageId: "pending:t1", clientTraceId: "t1", role: "user", bodyMd: "x", isOwn: true, isPending: true, createdAt: "" };
  const echoedWithoutTrace = normalizeServerRow({ id: "s1", sender_kind: "user", sender_ref: "u1", body_md: "x" }, "u1");
  const responseWithTrace = normalizeServerRow({ id: "s1", sender_kind: "user", sender_ref: "u1", turn_id: "t1", body_md: "x" } as any, "u1");
  const next = mergeMessage([pending, echoedWithoutTrace], responseWithTrace);
  expect(next).toHaveLength(1);
  expect(next[0].messageId).toBe("s1");
  expect(next[0].isPending).toBe(false);
});

test("mergeMessage: messageId 去重不重复追加", () => {
  const a = normalizeServerRow({ id: "s9", sender_kind: "bot", body_md: "a" }, "u1");
  let list = mergeMessage([], a);
  list = mergeMessage(list, a);
  expect(list.length).toBe(1);
});
