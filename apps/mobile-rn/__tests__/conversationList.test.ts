import { buildConversationListItems } from "../src/logic/conversationList";
import { memberAccentColor } from "../src/logic/avatar";

test("按最后活动倒序 + 未读 + 末句", () => {
  const items = buildConversationListItems({
    conversations: [
      { id: "dm:a", name: "Alice", last_message_text: "hi", last_activity_at: "2026-06-01T10:00:00Z" },
      { id: "fellow::bob", name: "Bob", last_message_text: "done", last_activity_at: "2026-06-01T12:00:00Z" },
    ],
    unreadByConversation: { "dm:a": 3 },
  });
  expect(items[0].id).toBe("fellow::bob");
  expect(items[0].unread).toBe(0);
  expect(items[0].tiles[0].image).toBe("");
  expect(items[0].tiles[0].text).toBe("Bo");
  expect(items[1].id).toBe("dm:a");
  expect(items[1].unread).toBe(3);
  expect(items[1].subtitle).toBe("hi");
  expect(items[1].tiles[0].text).toBe("Al");
});

test("缺字段降级", () => {
  const items = buildConversationListItems({ conversations: [{ id: "dm:x" }] });
  expect(items[0].title).toBe("dm:x");
  expect(items[0].subtitle).toBe("");
  expect(items[0].unread).toBe(0);
  expect(items[0].tiles[0].image).toBe("");
  expect(items[0].tiles[0].text).toBe("dm");
});

test("群头像取成员拼贴 mosaic", () => {
  const items = buildConversationListItems({
    conversations: [{ id: "g_team", type: "group", name: "团队" }],
    self: { id: "u1", username: "我" },
    friends: [{ id: "u2", username: "Bob" }],
    fellows: [{ id: "claude", name: "Claude" }],
    membersByConv: {
      g_team: [
        { member_kind: "user", member_ref: "u1" } as any,
        { member_kind: "user", member_ref: "u2" } as any,
        { member_kind: "fellow", member_ref: "claude" } as any,
      ],
    },
  });
  expect(items[0].tiles.length).toBe(3); // 三个成员拼贴
  expect(items[0].tiles.map((t) => t.text)).toEqual(["我", "Bo", "Cl"]);
});

test("fellow 会话头像按全局 fellow identity 着色", () => {
  const items = buildConversationListItems({
    conversations: [{ id: "fellow:user_me:mia", type: "fellow", name: "Mia", decorations: { fellowKey: "mia" } } as any],
    fellows: [{ id: "mia", key: "mia", name: "Mia", ownerUserId: "user_me" } as any],
  });
  expect(items[0].tiles[0].image).toBe("");
  expect(items[0].tiles[0].color).toBe(memberAccentColor("fellow:user_me:mia"));
  expect(items[0].tiles[0].text).toBe("Mi");
});

test("fellow 会话缺 fellow 记录时从稳定 conversation id 取头像身份", () => {
  const items = buildConversationListItems({
    conversations: [{ id: "fellow:user_me:mia", type: "fellow", name: "Mia" } as any],
  });
  expect(items[0].tiles[0].image).toBe("");
  expect(items[0].tiles[0].color).toBe(memberAccentColor("fellow:user_me:mia"));
  expect(items[0].tiles[0].text).toBe("Mi");
});

test("dm 头像取对方用户(非自己)", () => {
  const items = buildConversationListItems({
    conversations: [{ id: "dm:u2", type: "dm" }],
    self: { id: "u1", username: "我" },
    friends: [{ id: "u2", username: "Bob" }],
    membersByConv: {
      "dm:u2": [
        { member_kind: "user", member_ref: "u1" } as any,
        { member_kind: "user", member_ref: "u2" } as any,
      ],
    },
  });
  expect(items[0].tiles.length).toBe(1);
  expect(items[0].tiles[0].text).toBe("Bo"); // 对方 Bob,不是自己
});
