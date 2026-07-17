import { mergeFetchedMessages, normalizeServerRow, mergeMessage } from "../src/logic/normalizeMessage";
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

test("real cloud *_json fields survive normalization", () => {
  const m = normalizeServerRow({
    id: "m-json",
    sender_kind: "bot",
    sender_ref: "bot_mia",
    body_md: "完成。",
    attachments_json: JSON.stringify([{ id: "f1", name: "report.pdf", mime: "application/pdf", url: "/api/files/f1" }]),
    mentions_json: JSON.stringify([{ kind: "user", ref: "u1" }]),
    skills_json: JSON.stringify([{ id: "research" }]),
    trace_json: JSON.stringify({ reasoning: "checked" }),
    content_blocks_json: JSON.stringify([
      { type: "thinking", id: "think_1", text: "检查", status: "completed" },
      { type: "tool", id: "tool_1", name: "search", preview: "mia", status: "completed" },
    ]),
  }, "u1");

  expect(m.attachments).toEqual([{ id: "f1", type: "file", name: "report.pdf", mimeType: "application/pdf", url: "/api/files/f1" }]);
  expect(m.mentions).toEqual([{ kind: "user", ref: "u1" }]);
  expect(m.skills).toEqual([{ id: "research" }]);
  expect(m.trace).toEqual({ reasoning: "checked" });
  expect(m.contentBlocks?.map((block) => block.type)).toEqual(["thinking", "tool", "text"]);
  expect(m.contentBlocks?.[2].text).toBe("完成。");
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

test("same turn keeps the user request and bot reply as two lanes", () => {
  const user = normalizeServerRow({
    id: "u-turn",
    seq: 10,
    sender_kind: "user",
    sender_ref: "u1",
    turn_id: "turn-1",
    body_md: "帮我看下",
  }, "u1");
  const bot = normalizeServerRow({
    id: "b-turn",
    seq: 11,
    sender_kind: "bot",
    sender_ref: "bot_mia",
    turn_id: "turn-1",
    body_md: "看完了",
  }, "u1");

  const next = mergeMessage(mergeMessage([], user), bot);
  expect(next.map((message) => message.messageId)).toEqual(["u-turn", "b-turn"]);
  expect(next.map((message) => message.role)).toEqual(["user", "assistant"]);
});

test("mergeFetchedMessages preserves local pending messages during stale refetch", () => {
  const oldList: ChatMessage[] = [
    normalizeServerRow({ id: "s1", seq: 1, sender_kind: "bot", body_md: "old" }, "u1"),
    { messageId: "pending:t1", clientTraceId: "t1", role: "user", bodyMd: "new", isOwn: true, isPending: true, createdAt: "" },
  ];
  const fetched = [
    normalizeServerRow({ id: "s1", seq: 1, sender_kind: "bot", body_md: "old" }, "u1"),
  ];

  const next = mergeFetchedMessages(oldList, fetched);

  expect(next.map((m) => m.messageId)).toEqual(["s1", "pending:t1"]);
});

test("mergeFetchedMessages drops pending message after server echo appears", () => {
  const oldList: ChatMessage[] = [
    { messageId: "pending:t1", clientTraceId: "t1", role: "user", bodyMd: "new", isOwn: true, isPending: true, createdAt: "" },
  ];
  const fetched = [
    normalizeServerRow({ id: "s2", seq: 2, sender_kind: "user", sender_ref: "u1", turn_id: "t1", body_md: "new" } as any, "u1"),
  ];

  const next = mergeFetchedMessages(oldList, fetched);

  expect(next).toHaveLength(1);
  expect(next[0].messageId).toBe("s2");
  expect(next[0].isPending).toBe(false);
});

test("partial history fetch does not erase newer websocket-confirmed messages", () => {
  const previous = [
    normalizeServerRow({ id: "m201", seq: 201, sender_kind: "bot", sender_ref: "bot_mia", body_md: "newest" }, "u1"),
  ];
  const fetched = Array.from({ length: 200 }, (_, index) => normalizeServerRow({
    id: `m${index + 1}`,
    seq: index + 1,
    sender_kind: "user",
    sender_ref: "u2",
    body_md: `old ${index + 1}`,
  }, "u1"));

  const next = mergeFetchedMessages(previous, fetched);
  expect(next).toHaveLength(201);
  expect(next[0].messageId).toBe("m1");
  expect(next[200].messageId).toBe("m201");
});

test("authoritative page removes a hidden message inside its sequence window", () => {
  const previous = [1, 2, 3].map((seq) => normalizeServerRow({
    id: `m${seq}`,
    seq,
    sender_kind: "user",
    sender_ref: "u2",
    body_md: `m${seq}`,
  }, "u1"));
  const fetched = [previous[0], previous[2]];

  expect(mergeFetchedMessages(previous, fetched).map((message) => message.messageId)).toEqual(["m1", "m3"]);
});
