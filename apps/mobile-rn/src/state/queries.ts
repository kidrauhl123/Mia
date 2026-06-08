import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "./clientProvider";
import { useAuth } from "./auth";
import { normalizeServerRow } from "../logic/normalizeMessage";
import {
  botDetailPath,
  botRuntimeSavePath,
  botRuntimePath,
  bridgeDevicesPath,
  bridgeRunsPath,
  friendRequestsPath,
  modelCatalogPath,
  settingsPath,
  skillsPath,
} from "../api/endpoints";
import type {
  Bot,
  BotRuntimeConfig,
  BotRuntimeBinding,
  BridgeDevice,
  BridgeRun,
  ChatMessage,
  Conversation,
  Friend,
  FriendRequest,
  MessageRow,
  Member,
  PlatformModelRow,
  SkillCategory,
  SkillSummary,
  UserSettings,
} from "../api/types";

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

export function useUserSettings() {
  const api = useApi();
  return useQuery<UserSettings>({
    queryKey: ["settings"],
    queryFn: () => api.api(settingsPath()).then((d) => d.settings || {}),
  });
}

export function useBridgeDevices() {
  const api = useApi();
  return useQuery<BridgeDevice[]>({
    queryKey: ["bridge-devices"],
    queryFn: () => api.api(bridgeDevicesPath()).then((d) => d.devices || []),
  });
}

export function useBridgeRuns() {
  const api = useApi();
  return useQuery<BridgeRun[]>({
    queryKey: ["bridge-runs"],
    queryFn: () => api.api(bridgeRunsPath()).then((d) => d.runs || []),
  });
}

export function useFriendRequests(direction: "incoming" | "outgoing" = "incoming") {
  const api = useApi();
  return useQuery<FriendRequest[]>({
    queryKey: ["friend-requests", direction],
    queryFn: () => api.api(friendRequestsPath(direction)).then((d) => d.requests || []),
  });
}

export function useBotDetail(botId: string | undefined) {
  const api = useApi();
  return useQuery<Bot | null>({
    queryKey: ["bot-detail", botId],
    enabled: !!botId,
    queryFn: () => api.api(botDetailPath(botId || "")).then((d) => d.bot || null),
  });
}

export function useBotRuntime(botId: string | undefined, kind = "cloud-hermes") {
  const api = useApi();
  return useQuery<BotRuntimeBinding | null>({
    queryKey: ["bot-runtime", botId, kind],
    enabled: !!botId,
    queryFn: () => api.api(botRuntimePath(botId || "", kind)).then((d) => d.binding || null),
  });
}

export function useModelCatalog() {
  const api = useApi();
  return useQuery<PlatformModelRow[]>({
    queryKey: ["model-catalog"],
    queryFn: () => api.api(modelCatalogPath()).then((d) => d.models || []),
  });
}

export function useSaveBotRuntimeConfig() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, runtimeKind, config }: { botId: string; runtimeKind: string; config: BotRuntimeConfig }) =>
      api.api(botRuntimeSavePath(botId), { method: "PUT", body: { runtimeKind, enabled: true, config } }).then((d) => d.binding || null),
    onSuccess: (binding, vars) => {
      qc.setQueryData(["bot-runtime", vars.botId, vars.runtimeKind], binding);
    },
  });
}

export function useSkills(filters: { q?: string; category?: string; limit?: number } = {}) {
  const api = useApi();
  const q = filters.q || "";
  const category = filters.category || "";
  const limit = filters.limit || 80;
  return useQuery<{ skills: SkillSummary[]; categories: SkillCategory[] }>({
    queryKey: ["skills", q, category, limit],
    queryFn: () =>
      api.api(skillsPath({ q, category, limit })).then((d) => ({
        skills: d.skills || [],
        categories: d.categories || [],
      })),
  });
}
