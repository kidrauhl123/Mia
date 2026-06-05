export type ConversationType = "bot" | "dm" | "group" | string;

export interface ConversationLike {
  id?: string;
  type?: string;
  name?: string;
  title?: string;
  botId?: string;
  bot_id?: string;
  last_activity_at?: string;
  lastActivityAt?: string;
  updated_at?: string;
  updatedAt?: string;
  created_at?: string;
  createdAt?: string;
  decorations?: {
    botId?: string;
    botName?: string;
    runtimeKind?: string;
  };
}

export interface BotLike {
  id?: string;
  botId?: string;
  bot_id?: string;
  name?: string;
  displayName?: string;
  display_name?: string;
}

export interface SessionHistoryOptions {
  activeConversationId?: string;
  defaultTitle?: string;
  groupTitle?: string;
  dmTitle?: string | ((conversation: ConversationLike) => string);
  dmTitleFallback?: string;
  runtimeKindFallback?: string;
  bots?: BotLike[];
  messageCache?: { get?: (id?: string) => { messages?: Array<Record<string, unknown>> } | undefined };
  title?: string;
  preferredConversationIdByBotId?: Record<string, string> | { get?: (id: string) => string | undefined };
}

export function conversationType<T extends ConversationLike>(conversation?: T, conversationId?: string): ConversationType;
export function botId<T extends ConversationLike>(conversation?: T): string;
export function runtimeKind<T extends ConversationLike>(conversation?: T, fallback?: string): string;
export function conversationSortTime<T extends ConversationLike>(conversation?: T, messageCache?: SessionHistoryOptions["messageCache"]): number;
export function sessionTitle<T extends ConversationLike>(conversation?: T, options?: SessionHistoryOptions): string;
export function sessionConversationsForConversation<T extends ConversationLike>(conversation?: T, conversations?: T[], options?: SessionHistoryOptions): T[];
export function sidebarConversations<T extends ConversationLike>(conversations?: T[], options?: SessionHistoryOptions): T[];
export function botDisplayTitle<T extends ConversationLike>(conversation?: T, bots?: BotLike[], fallback?: string): string;
export function conversationListTitle<T extends ConversationLike>(conversation?: T, bots?: BotLike[], fallback?: string): string;
export function isUntitledBotConversation<T extends ConversationLike>(conversation?: T, options?: SessionHistoryOptions): boolean;
export function canCreateSession<T extends ConversationLike>(conversation?: T): boolean;
export function createBotSessionPayload<T extends ConversationLike>(conversation: T, sessionId: string, options?: SessionHistoryOptions): {
  botId: string;
  title: string;
  runtimeKind: string;
  sessionId: string;
};
