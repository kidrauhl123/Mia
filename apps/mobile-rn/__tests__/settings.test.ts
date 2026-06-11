import { lastSeenSeq, mergeUserSettings, togglePinnedConversation } from "../src/logic/settings";

test("mergeUserSettings preserves existing bags and adds expectedVersion", () => {
  expect(mergeUserSettings(
    { version: 3, pins: ["a"], readMarks: { a: 1 }, appearance: { theme: "light" } },
    { readMarks: { b: 2 } }
  )).toEqual({
    pins: ["a"],
    readMarks: { a: 1, b: 2 },
    appearance: { theme: "light" },
    expectedVersion: 3,
  });
});

test("togglePinnedConversation appends and removes pins", () => {
  expect(togglePinnedConversation({ pins: ["a"] }, "b")).toEqual(["a", "b"]);
  expect(togglePinnedConversation({ pins: ["a", "b"] }, "a")).toEqual(["b"]);
});

test("lastSeenSeq returns the highest persisted message seq", () => {
  expect(lastSeenSeq([{ seq: 1 }, {}, { seq: 7 }, { seq: 3 }])).toBe(7);
});
