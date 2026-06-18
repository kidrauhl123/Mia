import type { AvatarDescriptor, Bot, ChatMessage, Conversation, Friend, Member, StatusBadge } from "../api/types";
import { sidebarConversations, conversationListTitle, conversationType, botId } from "./sessionHistory";
import { conversationAvatarTiles, type AvatarResolveCtx } from "./conversationAvatar";
import { resolveContact, ContactKind } from "./contact";
import type { SelfRecord } from "./contact";

export interface ConversationListItem {
  id: string;
  title: string;
  subtitle: string;
  timeText: string;
  sortTime: number;
  unread: number;
  pinned: boolean;
  muted: boolean;
  manualUnread: boolean;
  tiles: AvatarDescriptor[]; // 1 = 单头像;>1 = 群拼贴
  statusBadge?: StatusBadge | null;
  raw: Conversation;
}

export { identityDisplayText, memberAccentColor, resolveAvatar } from "./avatar";

function activityTime(c: Conversation, messages?: ChatMessage[]): number {
  const last = lastRenderableMessage(messages);
  const t = last?.createdAt || c.lastActivityAt || c.last_activity_at || c.updatedAt || c.updated_at || c.createdAt || c.created_at || "";
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : 0;
}

function lastRenderableMessage(messages?: ChatMessage[]): ChatMessage | null {
  const list = Array.isArray(messages) ? messages : [];
  return list.length ? list[list.length - 1] : null;
}

function dmPeerIdFromConversationId(c: Conversation, selfId?: string): string {
  const parts = String(c.id || "").split(":");
  if (parts.length < 3 || parts[0] !== "dm") return "";
  const [, a, b] = parts;
  if (selfId && a === selfId) return b || "";
  if (selfId && b === selfId) return a || "";
  return b || a || "";
}

function memberDisplayName(member: Member | undefined, ctx: AvatarResolveCtx): string {
  const m: any = member || {};
  const identity = m.identity || {};
  const user = m.user || {};
  const direct = m.displayName || m.display_name || m.username || user.displayName || user.display_name || user.username || identity.displayName || identity.display_name;
  if (direct) return String(direct);
  if (m.member_kind === "user" && m.member_ref) {
    return resolveContact({ kind: ContactKind.User, ref: m.member_ref }, ctx).displayName;
  }
  return "";
}

function dmTitle(c: Conversation, ctx: AvatarResolveCtx): string {
  const members = ctx.membersByConv?.[c.id] || [];
  const peer = members.find((m: any) => m.member_kind === "user" && m.member_ref !== ctx.self?.id);
  const fromMember = memberDisplayName(peer, ctx);
  if (fromMember && fromMember !== peer?.member_ref) return fromMember;
  const peerId = peer?.member_ref || dmPeerIdFromConversationId(c, ctx.self?.id);
  if (peerId) {
    const resolved = resolveContact({ kind: ContactKind.User, ref: peerId }, ctx).displayName;
    if (resolved && resolved !== peerId) return resolved;
  }
  return c.name || c.title || "私聊";
}

function titleForConversation(c: Conversation, bots: Bot[], ctx: AvatarResolveCtx): string {
  const type = conversationType(c);
  if (type === "dm") return dmTitle(c, ctx);
  if (type === "group") return c.name || c.title || "群聊";
  return conversationListTitle(c, bots);
}

function statusBadgeFrom(...sources: any[]): StatusBadge | null | undefined {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    if (Object.prototype.hasOwnProperty.call(source, "statusBadge")) return source.statusBadge;
    if (Object.prototype.hasOwnProperty.call(source, "status_badge")) return source.status_badge;
  }
  return undefined;
}

function statusBadgeForConversation(c: Conversation, bots: Bot[], ctx: AvatarResolveCtx): StatusBadge | null | undefined {
  const type = conversationType(c);
  if (type === "group") return statusBadgeFrom(c.identity, c);
  if (type === "bot") {
    const key = botId(c);
    const bot: any = bots.find((item: any) => (item.id || item.botId || item.bot_id || item.key) === key);
    const members = ctx.membersByConv?.[c.id] || [];
    const member: any = members.find((item: any) => item.member_kind === "bot" && item.member_ref === key);
    return statusBadgeFrom(bot, member?.identity, member, c.identity, c);
  }
  if (type === "dm") {
    const members = ctx.membersByConv?.[c.id] || [];
    const peer: any = members.find((m: any) => m.member_kind === "user" && m.member_ref !== ctx.self?.id);
    const friend: any = (ctx.friends || []).find((item: any) => item.id === peer?.member_ref);
    return statusBadgeFrom(peer?.identity, peer, friend?.identity, friend);
  }
  return statusBadgeFrom(c.identity, c);
}

function conversationPreview(c: Conversation, messages?: ChatMessage[]): string {
  const last = lastRenderableMessage(messages);
  if (last) {
    const body = String(last.bodyMd || "").trim();
    if (body) return body.slice(0, 80);
    if (last.attachments?.length) return "[附件]";
  }
  const fallback = String(c.lastMessageText || c.last_message_text || "").trim();
  if (!fallback && (c.lastMessageHasAttachments || c.last_message_has_attachments)) return "[附件]";
  return fallback || "暂无对话";
}

function conversationLastSeq(c: Conversation): number {
  const value = Number(c.lastMessageSeq ?? c.last_message_seq ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isLastMessageFromSelf(c: Conversation, selfId?: string): boolean {
  if (!selfId) return false;
  const kind = String(c.lastMessageSenderKind || c.last_message_sender_kind || "");
  const ref = String(c.lastMessageSenderRef || c.last_message_sender_ref || "");
  return kind === "user" && ref === selfId;
}

export function formatConversationTime(value: string | number | Date | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function unreadCountsFromMessages(
  messagesByConv: Record<string, ChatMessage[]> = {},
  readMarks: Record<string, number> = {}
): Record<string, number> {
  const unread: Record<string, number> = {};
  Object.entries(messagesByConv).forEach(([conversationId, messages]) => {
    const readSeq = Number(readMarks[conversationId]) || 0;
    const maxSeq = (messages || []).reduce((max, msg) => Math.max(max, Number(msg.seq) || 0), 0);
    if (maxSeq > readSeq) unread[conversationId] = maxSeq - readSeq;
  });
  return unread;
}

export function unreadCountsFromConversations(
  conversations: Conversation[] = [],
  readMarks: Record<string, number> = {},
  unreadOverrides: Record<string, boolean> = {},
  selfId?: string
): Record<string, number> {
  const unread: Record<string, number> = {};
  conversations.forEach((conversation) => {
    const readSeq = Number(readMarks[conversation.id]) || 0;
    const lastSeq = conversationLastSeq(conversation);
    const count = !isLastMessageFromSelf(conversation, selfId) && lastSeq > readSeq ? lastSeq - readSeq : 0;
    if (count > 0 || unreadOverrides[conversation.id] === true) {
      unread[conversation.id] = Math.max(count, 1);
    }
  });
  return unread;
}

export function filterConversationListItems(items: ConversationListItem[], query: string): ConversationListItem[] {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => {
    const haystack = `${item.title}\n${item.subtitle}\n${item.id}`.toLowerCase();
    return haystack.includes(needle);
  });
}

// 按主体聚合 + 按类型解析头像(bot / dm 用户 / group 拼贴),对齐桌面/web。
export function buildConversationListItems(deps: {
  conversations: Conversation[];
  bots?: Bot[];
  friends?: Friend[];
  self?: SelfRecord;
  membersByConv?: Record<string, Member[]>;
  messagesByConv?: Record<string, ChatMessage[]>;
  unreadByConversation?: Record<string, number>;
  activeConversationId?: string;
  pinnedIds?: string[];
  mutedIds?: string[];
  unreadOverrides?: Record<string, boolean>;
  query?: string;
}): ConversationListItem[] {
  const bots = deps.bots || [];
  const unread = deps.unreadByConversation || {};
  const pinned = new Set(deps.pinnedIds || []);
  const muted = new Set(deps.mutedIds || []);
  const manualUnread = deps.unreadOverrides || {};
  const ctx: AvatarResolveCtx = {
    self: deps.self,
    bots,
    friends: deps.friends || [],
    membersByConv: deps.membersByConv || {},
  };
  const aggregated = sidebarConversations(deps.conversations || [], { activeConversationId: deps.activeConversationId });
  aggregated.sort((a, b) => {
    const pinDelta = Number(pinned.has(b.id)) - Number(pinned.has(a.id));
    return pinDelta || activityTime(b, deps.messagesByConv?.[b.id]) - activityTime(a, deps.messagesByConv?.[a.id]);
  });
  const items = aggregated.map((c) => {
    const sortTime = activityTime(c, deps.messagesByConv?.[c.id]);
    return {
      id: c.id,
      title: titleForConversation(c, bots, ctx),
      subtitle: conversationPreview(c, deps.messagesByConv?.[c.id]),
      timeText: formatConversationTime(sortTime),
      sortTime,
      unread: Number(unread[c.id]) || 0,
      pinned: pinned.has(c.id),
      muted: muted.has(c.id),
      manualUnread: manualUnread[c.id] === true,
      tiles: conversationAvatarTiles(c, ctx),
      statusBadge: statusBadgeForConversation(c, bots, ctx) || null,
      raw: c,
    };
  });
  return filterConversationListItems(items, deps.query || "");
}

export { conversationType };
