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
