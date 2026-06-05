import {
  botDisplayTitle,
  botId,
  conversationType,
  sidebarConversations,
  sessionConversationsForConversation,
} from "../src/logic/sessionHistory";
import type { Conversation } from "../src/api/types";

test("conversationType / botId 按 canonical 字段识别", () => {
  expect(conversationType({ id: "botc_owner_claude" })).toBe("bot");
  expect(conversationType({ id: "dm:u2" })).toBe("dm");
  expect(conversationType({ id: "g_abc" })).toBe("group");
  expect(botId({ id: "botc_owner_claude", bot_id: "claude" })).toBe("claude");
  expect(botId({ id: "botc_x", decorations: { botId: "kkey" } })).toBe("kkey");
});

test("sidebarConversations 把同一 bot 的多 session 折叠成一张(留最新)", () => {
  const convs: Conversation[] = [
    { id: "botc_o_claude_s1", type: "bot", decorations: { botId: "claude" }, last_activity_at: "2026-06-01T10:00:00Z" },
    { id: "botc_o_claude_s2", type: "bot", decorations: { botId: "claude" }, last_activity_at: "2026-06-01T12:00:00Z" },
    { id: "dm:bob", type: "dm", name: "Bob", last_activity_at: "2026-06-01T09:00:00Z" },
  ];
  const out = sidebarConversations(convs);
  const botCards = out.filter((c) => c.id.startsWith("botc_"));
  expect(botCards.length).toBe(1); // 折叠成一张
  expect(botCards[0].id).toBe("botc_o_claude_s2"); // 留最新 session 作代表
  expect(out.some((c) => c.id === "dm:bob")).toBe(true); // DM 保留
});

test("botDisplayTitle 用 bot 名,不用 session 名", () => {
  const c: Conversation = { id: "botc_o_claude_s1", type: "bot", name: "随便起的会话名", decorations: { botId: "claude" } };
  expect(botDisplayTitle(c, [{ id: "claude", name: "Claude 助手" }])).toBe("Claude 助手");
});

test("sessionConversationsForConversation 列出该 bot 全部会话,按活动倒序", () => {
  const convs: Conversation[] = [
    { id: "botc_o_claude_s1", type: "bot", decorations: { botId: "claude" }, last_activity_at: "2026-06-01T10:00:00Z" },
    { id: "botc_o_claude_s2", type: "bot", decorations: { botId: "claude" }, last_activity_at: "2026-06-01T12:00:00Z" },
    { id: "botc_o_other_s1", type: "bot", decorations: { botId: "other" } },
  ];
  const sessions = sessionConversationsForConversation(convs[0], convs);
  expect(sessions.map((c) => c.id)).toEqual(["botc_o_claude_s2", "botc_o_claude_s1"]);
});
