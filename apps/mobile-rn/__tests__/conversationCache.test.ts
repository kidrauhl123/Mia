import {
  mergeConversationSummaries,
  patchConversationListSummary,
  prependConversation,
} from "../src/logic/conversationCache";
import type { Conversation } from "../src/api/types";

test("mergeConversationSummaries preserves array and item references when server data is unchanged", () => {
  const oldList: Conversation[] = [
    { id: "c1", last_message_text: "hi", last_activity_at: "2026-06-01T10:00:00Z" },
    { id: "c2", last_message_text: "yo", last_activity_at: "2026-06-01T09:00:00Z" },
  ];
  const fetched: Conversation[] = [
    { id: "c1", last_message_text: "hi", last_activity_at: "2026-06-01T10:00:00Z" },
    { id: "c2", last_message_text: "yo", last_activity_at: "2026-06-01T09:00:00Z" },
  ];

  const next = mergeConversationSummaries(oldList, fetched);

  expect(next).toBe(oldList);
  expect(next[0]).toBe(oldList[0]);
});

test("mergeConversationSummaries keeps stable items while preserving server order changes", () => {
  const oldList: Conversation[] = [
    { id: "c1", last_message_text: "hi" },
    { id: "c2", last_message_text: "yo" },
  ];
  const fetched: Conversation[] = [
    { id: "c2", last_message_text: "yo" },
    { id: "c1", last_message_text: "hi" },
  ];

  const next = mergeConversationSummaries(oldList, fetched);

  expect(next).not.toBe(oldList);
  expect(next.map((item) => item.id)).toEqual(["c2", "c1"]);
  expect(next[0]).toBe(oldList[1]);
  expect(next[1]).toBe(oldList[0]);
});

test("patchConversationListSummary updates only the target conversation summary", () => {
  const oldList: Conversation[] = [
    { id: "c1", last_message_text: "old", last_message_seq: 1 },
    { id: "c2", last_message_text: "stay", last_message_seq: 1 },
  ];

  const next = patchConversationListSummary(oldList, "c1", {
    id: "m2",
    conversation_id: "c1",
    seq: 2,
    sender_kind: "user",
    sender_ref: "u2",
    body_md: "new",
    created_at: "2026-06-01T11:00:00Z",
  });

  expect(next).not.toBe(oldList);
  expect(next?.[0]).toMatchObject({
    id: "c1",
    last_message_text: "new",
    last_message_seq: 2,
    last_message_sender_ref: "u2",
  });
  expect(next?.[1]).toBe(oldList[1]);
});

test("prependConversation merges with existing row instead of duplicating it", () => {
  const oldList: Conversation[] = [
    { id: "c1", name: "old", last_message_text: "hi" },
    { id: "c2", name: "stay" },
  ];

  const next = prependConversation(oldList, { id: "c2", name: "new" });

  expect(next?.map((item) => item.id)).toEqual(["c2", "c1"]);
  expect(next?.[0]).toMatchObject({ id: "c2", name: "new" });
  expect(next?.[1]).toBe(oldList[0]);
});
