export interface ReadState {
  readAt?: Record<string, string>;
}

export interface ConversationLike {
  id?: string;
  key?: string;
  conversationId?: string;
  unreadCount?: number;
  messages?: unknown[];
  sessions?: Array<{ messages?: unknown[] }>;
}

export function computeUnreadForConversation(conversation?: ConversationLike | null, readState?: ReadState | Map<string, number> | null): number;
export function totalUnreadFromConversations(conversations?: ConversationLike[] | null, readState?: ReadState | Map<string, number> | null): number;
export function unreadBadgeText(count?: unknown, options?: { maxDisplay?: number }): string;
export function unreadBadgeHtml(count?: unknown, options?: { maxDisplay?: number }): string;
