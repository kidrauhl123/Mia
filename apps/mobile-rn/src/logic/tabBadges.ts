import type { Conversation, FriendRequest, UserSettings } from "../api/types";
import { unreadCountsFromConversations } from "./conversationList";
import { sidebarConversations } from "./sessionHistory";

export interface MobileTabBadgeDeps {
  conversations?: Conversation[];
  settings?: UserSettings;
  incomingRequests?: FriendRequest[];
  selfId?: string;
}

export function mobileTabBadges({ conversations = [], settings, incomingRequests = [], selfId }: MobileTabBadgeDeps) {
  const visibleConversations = sidebarConversations(conversations);
  const unreadByConversation = unreadCountsFromConversations(
    visibleConversations,
    settings?.readMarks || {},
    settings?.unreadOverrides || {},
    selfId
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
