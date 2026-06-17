import type { Conversation, FriendRequest, UserSettings } from "../api/types";
import { unreadCountsFromConversations } from "./conversationList";

export interface MobileTabBadgeDeps {
  conversations?: Conversation[];
  settings?: UserSettings;
  incomingRequests?: FriendRequest[];
}

export function mobileTabBadges({ conversations = [], settings, incomingRequests = [] }: MobileTabBadgeDeps) {
  const unreadByConversation = unreadCountsFromConversations(
    conversations,
    settings?.readMarks || {},
    settings?.unreadOverrides || {}
  );
  const muted = new Set(settings?.mutedConversations || []);
  const messages = Object.entries(unreadByConversation).reduce((sum, [conversationId, count]) => {
    if (muted.has(conversationId)) return sum;
    return sum + Math.max(0, Number(count) || 0);
  }, 0);
  return {
    Messages: messages,
    Contacts: incomingRequests.length,
  };
}
