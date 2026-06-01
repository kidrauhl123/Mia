import {
  conversationType,
  fellowKey,
  sidebarConversations,
  fellowDisplayTitle,
  sessionConversationsForConversation,
} from "../src/logic/sessionHistory";
import type { Conversation } from "../src/api/types";

test("conversationType / fellowKey 按 id 前缀识别", () => {
  expect(conversationType({ id: "fellow:owner:claude" })).toBe("fellow");
  expect(conversationType({ id: "dm:u2" })).toBe("dm");
  expect(conversationType({ id: "g_abc" })).toBe("group");
  expect(fellowKey({ id: "fellow:owner:claude" })).toBe("claude");
  expect(fellowKey({ id: "fellow:x", decorations: { fellowKey: "kkey" } })).toBe("kkey");
});

test("sidebarConversations 把同一 fellow 的多 session 折叠成一张(留最新)", () => {
  const convs: Conversation[] = [
    { id: "fellow:o:claude#s1", type: "fellow", decorations: { fellowKey: "claude" }, last_activity_at: "2026-06-01T10:00:00Z" },
    { id: "fellow:o:claude#s2", type: "fellow", decorations: { fellowKey: "claude" }, last_activity_at: "2026-06-01T12:00:00Z" },
    { id: "dm:bob", type: "dm", name: "Bob", last_activity_at: "2026-06-01T09:00:00Z" },
  ];
  const out = sidebarConversations(convs);
  const fellowCards = out.filter((c) => c.id.startsWith("fellow:"));
  expect(fellowCards.length).toBe(1); // 折叠成一张
  expect(fellowCards[0].id).toBe("fellow:o:claude#s2"); // 留最新 session 作代表
  expect(out.some((c) => c.id === "dm:bob")).toBe(true); // DM 保留
});

test("fellowDisplayTitle 用 fellow 名,不用 session 名", () => {
  const c: Conversation = { id: "fellow:o:claude#s1", type: "fellow", name: "随便起的会话名", decorations: { fellowKey: "claude" } };
  expect(fellowDisplayTitle(c, [{ key: "claude", name: "Claude 助手" }])).toBe("Claude 助手");
});

test("sessionConversationsForConversation 列出该 fellow 全部会话,按活动倒序", () => {
  const convs: Conversation[] = [
    { id: "fellow:o:claude#s1", type: "fellow", decorations: { fellowKey: "claude" }, last_activity_at: "2026-06-01T10:00:00Z" },
    { id: "fellow:o:claude#s2", type: "fellow", decorations: { fellowKey: "claude" }, last_activity_at: "2026-06-01T12:00:00Z" },
    { id: "fellow:o:other#s1", type: "fellow", decorations: { fellowKey: "other" } },
  ];
  const sessions = sessionConversationsForConversation(convs[0], convs);
  expect(sessions.map((c) => c.id)).toEqual(["fellow:o:claude#s2", "fellow:o:claude#s1"]);
});
