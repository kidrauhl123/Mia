import {
  lastSeenSeq,
  markConversationReadPatch,
  markConversationUnreadPatch,
  mergeUserSettings,
  setConversationManualUnread,
  toggleMutedConversation,
  togglePinnedConversation,
} from "../src/logic/settings";

test("mergeUserSettings preserves existing bags and adds expectedVersion", () => {
  expect(mergeUserSettings(
    {
      version: 3,
      pins: ["a"],
      readMarks: { a: 1 },
      mutedConversations: ["c"],
      unreadOverrides: { d: true },
      appearance: { theme: "light" },
    },
    { readMarks: { b: 2 }, appearance: { mobileFontSize: 18 } } as any
  )).toEqual({
    pins: ["a"],
    readMarks: { a: 1, b: 2 },
    mutedConversations: ["c"],
    unreadOverrides: { d: true },
    expectedVersion: 3,
  });
});

test("togglePinnedConversation appends and removes pins", () => {
  expect(togglePinnedConversation({ pins: ["a"] }, "b")).toEqual(["a", "b"]);
  expect(togglePinnedConversation({ pins: ["a", "b"] }, "a")).toEqual(["b"]);
});

test("mute and manual unread helpers add and remove settings entries", () => {
  expect(toggleMutedConversation({ mutedConversations: ["a"] }, "b")).toEqual(["a", "b"]);
  expect(toggleMutedConversation({ mutedConversations: ["a", "b"] }, "a")).toEqual(["b"]);
  expect(setConversationManualUnread({ unreadOverrides: { a: true } }, "b", true)).toEqual({ a: true, b: true });
  expect(setConversationManualUnread({ unreadOverrides: { a: true, b: true } }, "a", false)).toEqual({ b: true });
});

test("mark read clears manual unread and writes conversation last seq", () => {
  expect(markConversationReadPatch(
    { readMarks: { old: 1 }, unreadOverrides: { c1: true, old: true } },
    { id: "c1", last_message_seq: 7 } as any
  )).toEqual({
    readMarks: { c1: 7 },
    unreadOverrides: { old: true },
  });
  expect(markConversationUnreadPatch({ unreadOverrides: { old: true } }, "c1")).toEqual({
    unreadOverrides: { old: true, c1: true },
  });
});

test("lastSeenSeq returns the highest persisted message seq", () => {
  expect(lastSeenSeq([{ seq: 1 }, {}, { seq: 7 }, { seq: 3 }])).toBe(7);
});
