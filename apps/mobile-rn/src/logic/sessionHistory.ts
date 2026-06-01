// 移植自 src/shared/session-history.js —— 桌面/web 的"按主体聚合"会话列表规则。
// 关键:fellow 类会话按 fellowKey 折叠成一张卡(每个 fellow 一个代表 session),
// DM/群各自保留;fellow 卡标题用 fellow 名字。RN 侧用会话行自带的活动时间排序
// (不依赖 web 的 messageCache)。
import type { Conversation, Fellow } from "../api/types";

export type ConvType = "fellow" | "dm" | "group" | "";

export function conversationType(c?: Conversation): ConvType {
  const id = String(c?.id || "");
  if (c?.type === "fellow" || c?.type === "dm" || c?.type === "group") return c.type;
  if (id.startsWith("dm:")) return "dm";
  if (id.startsWith("fellow:")) return "fellow";
  if (id.startsWith("g_") || id.startsWith("g-")) return "group";
  return "";
}

export function fellowKey(c?: Conversation): string {
  const decorated = c?.decorations?.fellowKey || c?.fellowKey || c?.fellow_id || "";
  if (decorated) return String(decorated);
  const id = String(c?.id || "");
  return id.startsWith("fellow:") ? id.split(":").slice(2).join(":") : "";
}

function activityTime(c?: Conversation): number {
  const t = c?.last_activity_at || c?.updated_at || c?.created_at || "";
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : 0;
}

// 越"新"越靠前;返回 <0 表示 a 更优先。
function compareActivity(a: Conversation, b: Conversation): number {
  return activityTime(b) - activityTime(a);
}

function findFellow(key: string, fellows: Fellow[] = []): Fellow | null {
  const wanted = String(key || "");
  return fellows.find((f) => String(f.key || f.id || "") === wanted) || null;
}

function preferredFellowConversation(
  current: Conversation | undefined,
  candidate: Conversation,
  activeConversationId?: string
): Conversation {
  if (!current) return candidate;
  const active = String(activeConversationId || "");
  if (candidate.id && candidate.id === active) return candidate;
  if (current.id && current.id === active) return current;
  return compareActivity(candidate, current) < 0 ? candidate : current;
}

// 原始 conversations → 按主体聚合后的列表(每个 fellow 一张卡)。
export function sidebarConversations(
  conversations: Conversation[] = [],
  options: { activeConversationId?: string } = {}
): Conversation[] {
  const regular: Conversation[] = [];
  const byFellow = new Map<string, Conversation>();
  for (const c of Array.isArray(conversations) ? conversations : []) {
    if (conversationType(c) !== "fellow") {
      regular.push(c);
      continue;
    }
    const key = fellowKey(c) || String(c?.id || "");
    if (!key) continue;
    byFellow.set(key, preferredFellowConversation(byFellow.get(key), c, options.activeConversationId));
  }
  return [...regular, ...byFellow.values()];
}

export function fellowDisplayTitle(c: Conversation, fellows: Fellow[] = [], fallback = "对话"): string {
  const key = fellowKey(c);
  const fellow = findFellow(key, fellows);
  return fellow?.name || c?.decorations?.fellowName || c?.name || key || fallback;
}

// 列表标题:fellow → fellow 名;dm/群 → 会话名。
export function conversationListTitle(c: Conversation, fellows: Fellow[] = []): string {
  if (conversationType(c) === "fellow") return fellowDisplayTitle(c, fellows);
  return c.name || c.title || c.id;
}

// 某个 fellow 的全部会话记录(供 fellow 内部选择),按活动时间倒序。
export function sessionConversationsForConversation(
  conversation: Conversation,
  conversations: Conversation[] = []
): Conversation[] {
  if (!conversation) return [];
  if (conversationType(conversation) !== "fellow") return [conversation];
  const key = fellowKey(conversation);
  if (!key) return [conversation];
  return (Array.isArray(conversations) ? conversations : [])
    .filter((c) => conversationType(c) === "fellow" && fellowKey(c) === key)
    .sort(compareActivity);
}
