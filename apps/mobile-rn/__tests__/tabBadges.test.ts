import { mobileTabBadges } from "../src/logic/tabBadges";

test("messages badge sums unread and excludes muted conversations", () => {
  expect(mobileTabBadges({
    conversations: [
      { id: "loud", last_message_seq: 8 },
      { id: "muted", last_message_seq: 5 },
      { id: "manual", last_message_seq: 2 },
    ] as any,
    settings: {
      readMarks: { loud: 6, muted: 1, manual: 2 },
      mutedConversations: ["muted"],
      unreadOverrides: { manual: true },
    },
    incomingRequests: [{ id: "r1" } as any, { id: "r2" } as any],
  })).toEqual({
    Messages: 3,
    Contacts: 2,
  });
});

test("messages badge ignores unread from folded bot sessions that are not visible in the sidebar", () => {
  expect(mobileTabBadges({
    conversations: [
      {
        id: "botc_latest",
        type: "bot",
        decorations: { botId: "mia", sessionId: "latest" },
        last_activity_at: "2026-06-18T12:00:00Z",
        last_message_seq: 10,
      },
      {
        id: "botc_hidden",
        type: "bot",
        decorations: { botId: "mia", sessionId: "hidden" },
        last_activity_at: "2026-06-18T10:00:00Z",
        last_message_seq: 8,
      },
    ] as any,
    settings: {
      readMarks: { botc_latest: 10, botc_hidden: 4 },
    },
  })).toEqual({
    Messages: 0,
    Contacts: 0,
  });
});

test("messages badge does not count the user's own last message as unread", () => {
  expect(mobileTabBadges({
    conversations: [
      {
        id: "own-last",
        last_message_seq: 8,
        last_message_sender_kind: "user",
        last_message_sender_ref: "u1",
      },
      {
        id: "other-last",
        last_message_seq: 5,
        last_message_sender_kind: "user",
        last_message_sender_ref: "u2",
      },
    ] as any,
    settings: {
      readMarks: { "own-last": 7, "other-last": 2 },
    },
    selfId: "u1",
  })).toEqual({
    Messages: 3,
    Contacts: 0,
  });
});
