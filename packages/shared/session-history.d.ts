export type ConversationType = "fellow" | "dm" | "group" | string;

export interface ConversationLike {
  id?: string;
  type?: string;
  name?: string;
  title?: string;
  fellowKey?: string;
  fellow_id?: string;
  last_activity_at?: string;
  lastActivityAt?: string;
  updated_at?: string;
  updatedAt?: string;
  created_at?: string;
  createdAt?: string;
  decorations?: {
    fellowKey?: string;
    fellowName?: string;
    runtimeKind?: string;
  };
}

export interface FellowLike {
  id?: string;
  key?: string;
  name?: string;
}

export interface SessionHistoryOptions {
  activeConversationId?: string;
  defaultTitle?: string;
  groupTitle?: string;
  dmTitle?: string | ((conversation: ConversationLike) => string);
  dmTitleFallback?: string;
  runtimeKindFallback?: string;
  fellows?: FellowLike[];
  messageCache?: { get?: (id?: string) => { messages?: Array<Record<string, unknown>> } | undefined };
  title?: string;
}

export function conversationType<T extends ConversationLike>(conversation?: T, conversationId?: string): ConversationType;
export function fellowKey<T extends ConversationLike>(conversation?: T): string;
export function fellowConversationId(ownerUserId: unknown, fellowKey: unknown): string;
export function runtimeKind<T extends ConversationLike>(conversation?: T, fallback?: string): string;
export function conversationSortTime<T extends ConversationLike>(conversation?: T, messageCache?: SessionHistoryOptions["messageCache"]): number;
export function sessionTitle<T extends ConversationLike>(conversation?: T, options?: SessionHistoryOptions): string;
export function sessionConversationsForConversation<T extends ConversationLike>(conversation?: T, conversations?: T[], options?: SessionHistoryOptions): T[];
export function sidebarConversations<T extends ConversationLike>(conversations?: T[], options?: SessionHistoryOptions): T[];
export function fellowDisplayTitle<T extends ConversationLike>(conversation?: T, fellows?: FellowLike[], fallback?: string): string;
export function conversationListTitle<T extends ConversationLike>(conversation?: T, fellows?: FellowLike[], fallback?: string): string;
export function isUntitledFellowConversation<T extends ConversationLike>(conversation?: T, options?: SessionHistoryOptions): boolean;
export function canCreateSession<T extends ConversationLike>(conversation?: T): boolean;
export function createFellowSessionPayload<T extends ConversationLike>(conversation: T, sessionId: string, options?: SessionHistoryOptions): {
  fellowKey: string;
  title: string;
  runtimeKind: string;
  sessionId: string;
};
