import { useQuery } from "@tanstack/react-query";
import { useApi } from "./clientProvider";
import { useAuth } from "./auth";
import { normalizeServerRow } from "../logic/normalizeMessage";
import type { Conversation, Fellow, Friend, MessageRow, Member, ChatMessage } from "../api/types";

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
        .api(`/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=200`)
        .then((d) => (d.messages || []).map((r: MessageRow, i: number) => normalizeServerRow(r, selfId, i))),
  });
}

export function useConversationMembers(conversationId: string) {
  const api = useApi();
  return useQuery<Member[]>({
    queryKey: ["members", conversationId],
    enabled: !!conversationId,
    queryFn: () =>
      api.api(`/api/conversations/${encodeURIComponent(conversationId)}`).then((d) => d.members || []),
  });
}

export function useFellows() {
  const api = useApi();
  return useQuery<Fellow[]>({
    queryKey: ["fellows"],
    queryFn: () => api.api("/api/me/fellows?compact=1").then((d) => d.fellows || []),
  });
}

export function useFriends() {
  const api = useApi();
  return useQuery<Friend[]>({
    queryKey: ["friends"],
    queryFn: () => api.api("/api/social/friends").then((d) => d.friends || []),
  });
}
