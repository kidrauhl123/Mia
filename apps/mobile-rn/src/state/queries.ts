import { useQuery } from "@tanstack/react-query";
import { useApi } from "./clientProvider";
import { useAuth } from "./auth";
import { normalizeServerRow } from "../logic/normalizeMessage";
import type { Bot, Conversation, Friend, MessageRow, Member, ChatMessage } from "../api/types";

export function useConversations() {
  const api = useApi();
  return useQuery<Conversation[]>({
    queryKey: ["conversations"],
    queryFn: () => api.api("/api/conversations").then((d) => d.conversations || []),
  });
}

export function useConversationMessages(conversationId: string) {
  const api = useApi();
  const { session } = useAuth();
  const selfId = session?.user?.id;
  return useQuery<ChatMessage[]>({
    queryKey: ["messages", conversationId],
    enabled: !!conversationId,
    queryFn: () =>
      api
        .api(`/api/conversations/${conversationId}/messages?limit=200`)
        .then((d) => (d.messages || []).map((r: MessageRow, i: number) => normalizeServerRow(r, selfId, i))),
  });
}

export function useConversationMembers(conversationId: string) {
  const api = useApi();
  return useQuery<Member[]>({
    queryKey: ["members", conversationId],
    enabled: !!conversationId,
    queryFn: () =>
      api.api(`/api/conversations/${conversationId}`).then((d) => d.members || []),
  });
}

export function useBots() {
  const api = useApi();
  // 非 compact:带 avatarImage,列表/联系人头像才能和桌面一致显示真实头像。
  return useQuery<Bot[]>({
    queryKey: ["bots"],
    queryFn: () => api.api("/api/me/bots").then((d) => d.bots || []),
  });
}

export function useFriends() {
  const api = useApi();
  return useQuery<Friend[]>({
    queryKey: ["friends"],
    queryFn: () => api.api("/api/social/friends").then((d) => d.friends || []),
  });
}

// 完整自己资料(非 compact),带 avatarImage + avatarCrop —— 自己头像与群拼贴里的"自己"用。
export function useMe() {
  const api = useApi();
  return useQuery<any>({
    queryKey: ["me-full"],
    queryFn: () => api.api("/api/me").then((d) => d.user || d),
  });
}
