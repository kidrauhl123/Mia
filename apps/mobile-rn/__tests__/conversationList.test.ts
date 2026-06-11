import { buildConversationListItems } from "../src/logic/conversationList";
import { memberAccentColor } from "../src/logic/avatar";

test("按最后活动倒序 + 未读 + 末句", () => {
  const items = buildConversationListItems({
    conversations: [
      { id: "dm:a", name: "Alice", last_message_text: "hi", last_activity_at: "2026-06-01T10:00:00Z" },
      { id: "botc_user_bob", type: "bot", bot_id: "bot_bob", name: "Bob", last_message_text: "done", last_activity_at: "2026-06-01T12:00:00Z" },
    ],
    unreadByConversation: { "dm:a": 3 },
  });
  expect(items[0].id).toBe("botc_user_bob");
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
  expect(items[0].title).toBe("私聊");
  expect(items[0].subtitle).toBe("暂无对话");
  expect(items[0].unread).toBe(0);
  expect(items[0].tiles[0].image).toBe("");
  expect(items[0].tiles[0].text).toBe("dm");
});

test("dm 标题取对方好友名,不暴露 dm 内部 id", () => {
  const items = buildConversationListItems({
    conversations: [{ id: "dm:u1:u2", type: "dm" }],
    self: { id: "u1", username: "我" },
    friends: [{ id: "u2", username: "棕野" }],
    membersByConv: {
      "dm:u1:u2": [
        { member_kind: "user", member_ref: "u1" } as any,
        { member_kind: "user", member_ref: "u2" } as any,
      ],
    },
  });
  expect(items[0].title).toBe("棕野");
});

test("列表预览和时间优先取消息缓存最后一条", () => {
  const items = buildConversationListItems({
    conversations: [
      { id: "dm:u1:u2", type: "dm", last_message_text: "old", updated_at: "2026-06-01T09:00:00Z" },
      { id: "g_team", type: "group", name: "团队", updated_at: "2026-06-01T10:00:00Z" },
    ],
    self: { id: "u1", username: "我" },
    friends: [{ id: "u2", username: "棕野" }],
    messagesByConv: {
      "dm:u1:u2": [
        { messageId: "m1", role: "user", bodyMd: "new", isOwn: false, isPending: false, createdAt: "2026-06-01T12:34:00Z" },
      ],
      g_team: [
        { messageId: "m2", role: "user", bodyMd: "", attachments: [{ name: "a.png", type: "image" }], isOwn: false, isPending: false, createdAt: "2026-06-01T12:35:00Z" },
      ],
    },
  } as any);
  expect(items.map((item) => item.id)).toEqual(["g_team", "dm:u1:u2"]);
  expect(items[1].subtitle).toBe("new");
  expect((items[1] as any).sortTime).toBe(Date.parse("2026-06-01T12:34:00Z"));
  expect(items[0].subtitle).toBe("[附件]");
});

test("置顶会话排在普通会话前", () => {
  const items = buildConversationListItems({
    conversations: [
      { id: "new", last_activity_at: "2026-06-01T12:00:00Z" },
      { id: "old-pinned", last_activity_at: "2026-06-01T10:00:00Z" },
    ],
    pinnedIds: ["old-pinned"],
  });
  expect(items.map((item) => item.id)).toEqual(["old-pinned", "new"]);
});

test("群头像取成员拼贴 mosaic", () => {
  const items = buildConversationListItems({
    conversations: [{ id: "g_team", type: "group", name: "团队" }],
    self: { id: "u1", username: "我" },
    friends: [{ id: "u2", username: "Bob" }],
    bots: [{ id: "claude", name: "Claude" }],
    membersByConv: {
      g_team: [
        { member_kind: "user", member_ref: "u1" } as any,
        { member_kind: "user", member_ref: "u2" } as any,
        { member_kind: "bot", member_ref: "claude" } as any,
      ],
    },
  });
  expect(items[0].tiles.length).toBe(3); // 三个成员拼贴
  expect(items[0].tiles.map((t) => t.text)).toEqual(["我", "Bo", "Cl"]);
});

test("bot 会话头像按全局 bot identity 着色", () => {
  const badge = { kind: "lottie" as const, assetId: "rainbow", label: "Active" };
  const items = buildConversationListItems({
    conversations: [{ id: "botc_user_me_mia", type: "bot", name: "Mia", decorations: { botId: "mia" } } as any],
    bots: [{ id: "mia", key: "mia", name: "Mia", ownerUserId: "user_me", statusBadge: badge } as any],
  });
  expect(items[0].tiles[0].image).toBe("");
  expect(items[0].tiles[0].color).toBe(memberAccentColor("mia"));
  expect(items[0].tiles[0].text).toBe("Mi");
  expect(items[0].statusBadge).toEqual(badge);
});

test("bot 会话缺 bot 记录时从稳定 conversation id 取头像身份", () => {
  const items = buildConversationListItems({
    conversations: [{ id: "botc_user_me_mia", type: "bot", bot_id: "mia", name: "Mia" } as any],
  });
  expect(items[0].tiles[0].image).toBe("");
  expect(items[0].tiles[0].color).toBe(memberAccentColor("botc_user_me_mia"));
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
