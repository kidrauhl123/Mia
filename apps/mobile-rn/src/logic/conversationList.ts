import type { AvatarDescriptor, Bot, Conversation, Friend, Member } from "../api/types";
import { sidebarConversations, conversationListTitle, conversationType } from "./sessionHistory";
import { conversationAvatarTiles, type AvatarResolveCtx } from "./conversationAvatar";
import type { SelfRecord } from "./contact";

export interface ConversationListItem {
  id: string;
  title: string;
  subtitle: string;
  unread: number;
  tiles: AvatarDescriptor[]; // 1 = 单头像;>1 = 群拼贴
  raw: Conversation;
}

export { identityDisplayText, memberAccentColor, resolveAvatar } from "./avatar";

function activityTime(c: Conversation): number {
  const t = c.last_activity_at || c.updated_at || c.created_at || "";
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : 0;
}

// 按主体聚合 + 按类型解析头像(bot / dm 用户 / group 拼贴),对齐桌面/web。
export function buildConversationListItems(deps: {
  conversations: Conversation[];
  bots?: Bot[];
  friends?: Friend[];
  self?: SelfRecord;
  membersByConv?: Record<string, Member[]>;
  unreadByConversation?: Record<string, number>;
  activeConversationId?: string;
  pinnedIds?: string[];
}): ConversationListItem[] {
  const bots = deps.bots || [];
  const unread = deps.unreadByConversation || {};
  const pinned = new Set(deps.pinnedIds || []);
  const ctx: AvatarResolveCtx = {
    self: deps.self,
    bots,
    friends: deps.friends || [],
    membersByConv: deps.membersByConv || {},
  };
  const aggregated = sidebarConversations(deps.conversations || [], { activeConversationId: deps.activeConversationId });
  aggregated.sort((a, b) => {
    const pinDelta = Number(pinned.has(b.id)) - Number(pinned.has(a.id));
    return pinDelta || activityTime(b) - activityTime(a);
  });
  return aggregated.map((c) => ({
    id: c.id,
    title: conversationListTitle(c, bots),
    subtitle: String(c.last_message_text || ""),
    unread: Number(unread[c.id]) || 0,
    tiles: conversationAvatarTiles(c, ctx),
    raw: c,
  }));
}

export { conversationType };
