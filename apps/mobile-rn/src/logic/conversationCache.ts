import type { Conversation, MessageRow } from "../api/types";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((out, key) => {
      const next = (value as Record<string, unknown>)[key];
      if (next !== undefined) out[key] = stableValue(next);
      return out;
    }, {});
}

function stableKey(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function sameConversation(a: Conversation | undefined, b: Conversation | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return stableKey(a) === stableKey(b);
}

export function mergeConversationSummaries(previous: Conversation[] = [], fetched: Conversation[] = []): Conversation[] {
  const oldList = Array.isArray(previous) ? previous : [];
  const newList = Array.isArray(fetched) ? fetched : [];
  if (!oldList.length) return newList;

  const oldById = new Map(oldList.map((conversation) => [conversation.id, conversation]));
  let changed = oldList.length !== newList.length;
  const next = newList.map((incoming, index) => {
    const existing = oldById.get(incoming.id);
    if (existing && sameConversation(existing, incoming)) {
      if (oldList[index] !== existing) changed = true;
      return existing;
    }
    changed = true;
    return incoming;
  });

  return changed ? next : oldList;
}

export function prependConversation(previous: Conversation[] | undefined, conversation: Conversation | undefined): Conversation[] | undefined {
  if (!conversation?.id) return previous;
  const oldList = previous || [];
  const existing = oldList.find((item) => item.id === conversation.id);
  const nextConversation = existing ? { ...existing, ...conversation } : conversation;
  if (oldList[0]?.id === conversation.id && sameConversation(oldList[0], nextConversation)) return oldList;
  return [nextConversation, ...oldList.filter((item) => item.id !== conversation.id)];
}

export function mergeConversationUpdate(previous: Conversation[] | undefined, conversation: Conversation | undefined): Conversation[] | undefined {
  if (!conversation?.id) return previous;
  const oldList = previous || [];
  let found = false;
  let changed = false;
  const next = oldList.map((item) => {
    if (item.id !== conversation.id) return item;
    found = true;
    const merged = { ...item, ...conversation };
    if (sameConversation(item, merged)) return item;
    changed = true;
    return merged;
  });
  if (!found) return [conversation, ...oldList];
  return changed ? next : oldList;
}

function messageHasAttachments(row: MessageRow): boolean {
  if (Array.isArray(row.attachments)) return row.attachments.length > 0;
  const raw = (row as any).attachments_json;
  if (!raw) return false;
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

export function patchConversationSummary(conversation: Conversation, row: MessageRow): Conversation {
  const createdAt = row.created_at || conversation.lastMessageCreatedAt || conversation.last_message_created_at || "";
  const seq = Number(row.seq);
  const lastSeq = Number.isFinite(seq) && seq > 0 ? seq : Number(conversation.lastMessageSeq ?? conversation.last_message_seq ?? 0) || 0;
  const body = String(row.body_md || "");
  const hasAttachments = messageHasAttachments(row);
  return {
    ...conversation,
    lastMessageText: body,
    last_message_text: body,
    lastMessageSeq: lastSeq,
    last_message_seq: lastSeq,
    lastMessageSenderKind: row.sender_kind || "",
    last_message_sender_kind: row.sender_kind || "",
    lastMessageSenderRef: row.sender_ref || "",
    last_message_sender_ref: row.sender_ref || "",
    lastMessageCreatedAt: createdAt,
    last_message_created_at: createdAt,
    lastActivityAt: createdAt || conversation.lastActivityAt || conversation.last_activity_at,
    last_activity_at: createdAt || conversation.last_activity_at || conversation.lastActivityAt,
    lastMessageHasAttachments: hasAttachments,
    last_message_has_attachments: hasAttachments,
  };
}

export function patchConversationListSummary(
  previous: Conversation[] | undefined,
  conversationId: string | undefined,
  row: MessageRow
): Conversation[] | undefined {
  if (!previous?.length || !conversationId) return previous;
  let changed = false;
  const next = previous.map((conversation) => {
    if (conversation.id !== conversationId) return conversation;
    const patched = patchConversationSummary(conversation, { ...row, conversation_id: row.conversation_id || conversationId });
    if (sameConversation(conversation, patched)) return conversation;
    changed = true;
    return patched;
  });
  return changed ? next : previous;
}
