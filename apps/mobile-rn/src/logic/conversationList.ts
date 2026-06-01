import type { AvatarDescriptor, Conversation, Fellow } from "../api/types";
import { normalizeAvatarDescriptor, resolveAvatar } from "./avatar";
import { sidebarConversations, conversationListTitle, conversationType, fellowKey } from "./sessionHistory";

export interface ConversationListItem {
  id: string;
  title: string;
  subtitle: string;
  unread: number;
  avatar: AvatarDescriptor;
  raw: Conversation;
}

export { identityDisplayText, memberAccentColor, resolveAvatar } from "./avatar";

function activityTime(c: Conversation): number {
  const t = c.last_activity_at || c.updated_at || c.created_at || "";
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : 0;
}

// 桌面/web 一致:fellow 会话按主体折叠成一张卡(每个 fellow 一个代表 session),
// DM/群各自一张;fellow 卡标题取 fellow 名、头像按 fellowKey 稳定取色。
export function buildConversationListItems(deps: {
  conversations: Conversation[];
  fellows?: Fellow[];
  unreadByConversation?: Record<string, number>;
  activeConversationId?: string;
}): ConversationListItem[] {
  const fellows = deps.fellows || [];
  const unread = deps.unreadByConversation || {};
  const aggregated = sidebarConversations(deps.conversations || [], {
    activeConversationId: deps.activeConversationId,
  });
  aggregated.sort((a, b) => activityTime(b) - activityTime(a));
  return aggregated.map((c) => {
    const title = conversationListTitle(c, fellows);
    // 头像稳定 id:fellow 用 fellowKey(跨 session 不变),其余用会话 id。
    const avatarId = conversationType(c) === "fellow" ? fellowKey(c) || c.id : c.id;
    const identityAvatar = c.identity?.avatar ? normalizeAvatarDescriptor(title, c.identity.avatar) : null;
    return {
      id: c.id,
      title,
      subtitle: String(c.last_message_text || ""),
      unread: Number(unread[c.id]) || 0,
      avatar: identityAvatar || resolveAvatar(avatarId, title),
      raw: c,
    };
  });
}
