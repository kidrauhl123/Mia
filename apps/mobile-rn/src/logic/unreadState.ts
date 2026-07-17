import type { ChatMessage, Conversation, MessageRow, UserSettings } from "../api/types";

export type UnreadCounts = Record<string, number>;

export const unreadCountsQueryKey = ["unread-counts"] as const;
export const activeConversationIdQueryKey = ["active-conversation-id"] as const;

function safeCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function safeSeq(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function normalizeUnreadCounts(current: UnreadCounts | undefined | null): UnreadCounts {
  const out: UnreadCounts = {};
  Object.entries(current || {}).forEach(([id, value]) => {
    const count = safeCount(value);
    if (id && count > 0) out[id] = count;
  });
  return out;
}

export function incrementUnreadCount(current: UnreadCounts | undefined | null, conversationId: string | undefined): UnreadCounts {
  const id = String(conversationId || "").trim();
  const next = normalizeUnreadCounts(current);
  if (!id) return next;
  next[id] = (next[id] || 0) + 1;
  return next;
}

export function clearUnreadCount(current: UnreadCounts | undefined | null, conversationId: string | undefined): UnreadCounts {
  const id = String(conversationId || "").trim();
  const next = normalizeUnreadCounts(current);
  if (id) delete next[id];
  return next;
}

export function conversationSummarySeq(conversation: Conversation | undefined): number {
  return safeSeq(conversation?.lastMessageSeq ?? conversation?.last_message_seq);
}

export function reconcileUnreadCountsWithReadMarks(
  current: UnreadCounts | undefined | null,
  readMarks: UserSettings["readMarks"] = {},
  conversations: Conversation[] = []
): UnreadCounts {
  const next = normalizeUnreadCounts(current);
  const byId = new Map((conversations || []).filter((item) => item?.id).map((item) => [item.id, item]));
  Object.entries(readMarks || {}).forEach(([id, mark]) => {
    const readSeq = safeSeq(mark);
    if (!id || readSeq <= 0) return;
    const maxSeq = conversationSummarySeq(byId.get(id));
    if (readSeq >= maxSeq) delete next[id];
  });
  return next;
}

function messageSeq(message: MessageRow | ChatMessage | undefined): number {
  return safeSeq((message as MessageRow | undefined)?.seq);
}

function messageSenderKind(message: MessageRow | ChatMessage | undefined): string {
  return String((message as MessageRow | undefined)?.sender_kind || (message as ChatMessage | undefined)?.senderKind || "");
}

function messageSenderRef(message: MessageRow | ChatMessage | undefined): string {
  return String((message as MessageRow | undefined)?.sender_ref || (message as ChatMessage | undefined)?.senderRef || "");
}

export function isMessageFromSelf(message: MessageRow | ChatMessage | undefined, selfId: string | undefined): boolean {
  const id = String(selfId || "");
  return Boolean(id && messageSenderKind(message) === "user" && messageSenderRef(message) === id);
}

export function shouldIncrementUnreadForMessage(args: {
  conversationId: string | undefined;
  message: MessageRow | ChatMessage | undefined;
  selfId?: string;
  activeConversationId?: string;
  readMarks?: UserSettings["readMarks"];
}): boolean {
  const conversationId = String(args.conversationId || "").trim();
  if (!conversationId || args.activeConversationId === conversationId) return false;
  if (isMessageFromSelf(args.message, args.selfId)) return false;
  const seq = messageSeq(args.message);
  const readSeq = safeSeq(args.readMarks?.[conversationId]);
  return seq > readSeq;
}

export function hasCachedMessage(messages: ChatMessage[] | undefined, incoming: ChatMessage | undefined): boolean {
  if (!incoming) return false;
  const id = String(incoming.messageId || "");
  const trace = String(incoming.clientTraceId || "");
  const incomingKind = String(incoming.senderKind || (incoming.role === "assistant" ? "bot" : incoming.role) || "");
  const incomingRef = String(incomingKind === "user" && incoming.isOwn ? "self" : incoming.senderRef || "");
  return (messages || []).some((message) => {
    if (id && message.messageId === id) return true;
    if (!trace || message.clientTraceId !== trace) return false;
    const kind = String(message.senderKind || (message.role === "assistant" ? "bot" : message.role) || "");
    if (kind && incomingKind && kind !== incomingKind) return false;
    const ref = String(kind === "user" && message.isOwn ? "self" : message.senderRef || "");
    if (ref && incomingRef) return ref === incomingRef;
    // Old cached rows may predate sender metadata. In that case the trace is
    // still the best available replay key; modern rows take the scoped path.
    return true;
  });
}
