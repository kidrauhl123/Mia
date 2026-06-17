import type { Conversation, UserSettings } from "../api/types";

export interface UserSettingsPatch {
  pins?: string[];
  readMarks?: Record<string, number>;
  mutedConversations?: string[];
  unreadOverrides?: Record<string, boolean>;
  appearance?: Record<string, unknown>;
}

function uniqueStrings(value: string[] | undefined): string[] {
  return [...new Set((value || []).map(String).filter(Boolean))];
}

function normalizedUnreadOverrides(value: Record<string, boolean> | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  Object.entries(value || {}).forEach(([key, enabled]) => {
    if (key && enabled === true) out[key] = true;
  });
  return out;
}

export function mergeUserSettings(base: UserSettings | undefined, patch: UserSettingsPatch) {
  const current = base || {};
  return {
    pins: patch.pins !== undefined ? uniqueStrings(patch.pins) : uniqueStrings(current.pins),
    readMarks: patch.readMarks !== undefined ? { ...(current.readMarks || {}), ...patch.readMarks } : current.readMarks || {},
    mutedConversations: patch.mutedConversations !== undefined
      ? uniqueStrings(patch.mutedConversations)
      : uniqueStrings(current.mutedConversations),
    unreadOverrides: patch.unreadOverrides !== undefined
      ? normalizedUnreadOverrides(patch.unreadOverrides)
      : normalizedUnreadOverrides(current.unreadOverrides),
    appearance: patch.appearance !== undefined ? { ...(current.appearance || {}), ...patch.appearance } : current.appearance || {},
    expectedVersion: current.version || 0,
  };
}

export function togglePinnedConversation(settings: UserSettings | undefined, conversationId: string): string[] {
  const current = uniqueStrings(settings?.pins);
  if (current.includes(conversationId)) return current.filter((id) => id !== conversationId);
  return [...current, conversationId];
}

export function toggleMutedConversation(settings: UserSettings | undefined, conversationId: string): string[] {
  const current = uniqueStrings(settings?.mutedConversations);
  if (current.includes(conversationId)) return current.filter((id) => id !== conversationId);
  return [...current, conversationId];
}

export function setConversationManualUnread(
  settings: UserSettings | undefined,
  conversationId: string,
  unread: boolean
): Record<string, boolean> {
  const next = normalizedUnreadOverrides(settings?.unreadOverrides);
  if (unread) next[conversationId] = true;
  else delete next[conversationId];
  return next;
}

export function conversationLastSeq(conversation: Conversation | undefined): number {
  const value = Number(conversation?.lastMessageSeq ?? conversation?.last_message_seq ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function markConversationReadPatch(settings: UserSettings | undefined, conversation: Conversation): UserSettingsPatch {
  return {
    readMarks: { [conversation.id]: conversationLastSeq(conversation) },
    unreadOverrides: setConversationManualUnread(settings, conversation.id, false),
  };
}

export function markConversationUnreadPatch(settings: UserSettings | undefined, conversationId: string): UserSettingsPatch {
  return { unreadOverrides: setConversationManualUnread(settings, conversationId, true) };
}

export function lastSeenSeq(messages: Array<{ seq?: number }>): number {
  return messages.reduce((max, message) => {
    const seq = Number(message.seq);
    return Number.isFinite(seq) && seq > max ? seq : max;
  }, 0);
}
