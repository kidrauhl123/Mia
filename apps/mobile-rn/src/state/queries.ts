import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "./clientProvider";
import { useAuth } from "./auth";
import { mergeFetchedMessages, normalizeServerRow } from "../logic/normalizeMessage";
import {
  botConversationPath,
  botDetailPath,
  botRuntimeSavePath,
  botRuntimePath,
  bridgeDevicesPath,
  bridgeRunsPath,
  conversationsPath,
  friendRequestCancelPath,
  friendRequestCreatePath,
  friendRequestRespondPath,
  friendRequestsPath,
  modelCatalogPath,
  profilePath,
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
  StatusBadge,
  UserSettings,
} from "../api/types";
import { botIdentityBody, botRuntimeDefaultConfig, type BotDraft } from "../logic/botDraft";
import type { GroupCreatePayload } from "../logic/groupCreate";
import { mergeUserSettings, type UserSettingsPatch } from "../logic/settings";

export function useConversations() {
  const api = useApi();
  return useQuery<Conversation[]>({
    queryKey: ["conversations"],
    queryFn: () => api.api(conversationsPath({ includeMembers: true })).then((d) => d.conversations || []),
  });
}

export function useCreateGroupConversation() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: GroupCreatePayload) => api.api(conversationsPath(), { method: "POST", body: payload }),
    onSuccess: (data) => {
      const conversation = data?.conversation || data?.data?.conversation;
      const members = data?.members || data?.data?.members;
      if (conversation?.id) {
        qc.setQueryData<Conversation[]>(["conversations"], (old) => [conversation, ...(old || []).filter((item) => item.id !== conversation.id)]);
        if (Array.isArray(members)) qc.setQueryData<Member[]>(["members", conversation.id], members);
      }
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
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
    structuralSharing: (oldData: unknown, newData: unknown) =>
      mergeFetchedMessages(
        Array.isArray(oldData) ? oldData as ChatMessage[] : [],
        Array.isArray(newData) ? newData as ChatMessage[] : []
      ),
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

export function useUserSettings(options: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery<UserSettings>({
    queryKey: ["settings"],
    enabled: options.enabled ?? true,
    queryFn: () => api.api(settingsPath()).then((d) => d.settings || {}),
  });
}

export function useSaveProfile() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { displayName?: string; statusBadge?: StatusBadge | null }) =>
      api.api(profilePath(), { method: "PATCH", body: patch }).then((d) => d.user || d),
    onSuccess: (user) => {
      qc.setQueryData(["me-full"], user);
    },
  });
}

export function useSaveUserSettings() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: UserSettingsPatch) => {
      const write = async (base: UserSettings | undefined) =>
        api.api(settingsPath(), { method: "PUT", body: mergeUserSettings(base, patch) }).then((d) => d.settings || {});
      const current = qc.getQueryData<UserSettings>(["settings"]) || await api.api(settingsPath()).then((d) => d.settings || {});
      try {
        return await write(current);
      } catch (err) {
        if (!/version conflict/i.test(String((err as Error).message || ""))) throw err;
        const fresh = await api.api(settingsPath()).then((d) => d.settings || {});
        return write(fresh);
      }
    },
    onSuccess: (settings) => {
      qc.setQueryData(["settings"], settings);
    },
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

export function useSendFriendRequest() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ toUserId }: { toUserId: string }) =>
      api.api(friendRequestCreatePath(), { method: "POST", body: { toUserId } }).then((d) => d.request || null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["friend-requests", "outgoing"] });
    },
  });
}

export function useRespondFriendRequest() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, action }: { requestId: string; action: "accept" | "reject" }) =>
      api.api(friendRequestRespondPath(requestId), { method: "POST", body: { action } }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["friend-requests", "incoming"] });
      if (vars.action === "accept") {
        qc.invalidateQueries({ queryKey: ["friends"] });
        qc.invalidateQueries({ queryKey: ["conversations"] });
      }
    },
  });
}

export function useCancelFriendRequest() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId }: { requestId: string }) =>
      api.api(friendRequestCancelPath(requestId), { method: "DELETE" }).then((d) => d.request || null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["friend-requests", "outgoing"] });
    },
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

export function useSaveBotIdentity() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, body }: { botId: string; body: Record<string, unknown> }) =>
      api.api(botDetailPath(botId), { method: "PUT", body }).then((d) => d.bot || null),
    onSuccess: (bot, vars) => {
      if (!bot) return;
      qc.setQueryData(["bot-detail", vars.botId], bot);
      qc.setQueryData<Bot[]>(["bots"], (old) => [bot, ...(old || []).filter((item) => String(item.id || item.key || "") !== vars.botId)]);
    },
  });
}

export function useCreateCloudBot() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ botId, draft, defaultModel }: { botId: string; draft: BotDraft; defaultModel?: string }) => {
      const identity = botIdentityBody(draft);
      const saved = await api.api(botDetailPath(botId), { method: "PUT", body: identity });
      const runtime = await api.api(botRuntimeSavePath(botId), {
        method: "PUT",
        body: {
          runtimeKind: "cloud-hermes",
          enabled: true,
          config: botRuntimeDefaultConfig(defaultModel),
        },
      });
      const ensured = await api.api(botConversationPath(botId), {
        method: "PUT",
        body: {
          botId,
          title: identity.name,
          runtimeKind: "cloud-hermes",
        },
      });
      return {
        bot: saved.bot || { ...identity, id: botId, key: botId },
        binding: runtime.binding || null,
        conversation: ensured.conversation || null,
        members: ensured.members || null,
      };
    },
    onSuccess: (data, vars) => {
      const bot = { ...(data.bot || {}), id: data.bot?.id || vars.botId, key: data.bot?.key || vars.botId };
      qc.setQueryData<Bot[]>(["bots"], (old) => [bot, ...(old || []).filter((item) => String(item.id || item.key || "") !== vars.botId)]);
      qc.setQueryData(["bot-detail", vars.botId], bot);
      if (data.binding) qc.setQueryData(["bot-runtime", vars.botId, "cloud-hermes"], data.binding);
      if (data.conversation?.id) {
        qc.setQueryData<Conversation[]>(["conversations"], (old) => [data.conversation, ...(old || []).filter((item) => item.id !== data.conversation.id)]);
        if (Array.isArray(data.members)) qc.setQueryData<Member[]>(["members", data.conversation.id], data.members);
      }
      qc.invalidateQueries({ queryKey: ["bots"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useCreateBotSessionConversation() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, botId, title, runtimeKind }: { sessionId: string; botId: string; title: string; runtimeKind: string }) =>
      api.api(botConversationPath(sessionId), { method: "PUT", body: { botId, title, runtimeKind } }),
    onSuccess: (data) => {
      const conversation = data?.conversation || null;
      const members = data?.members || null;
      if (conversation?.id) {
        qc.setQueryData<Conversation[]>(["conversations"], (old) => [conversation, ...(old || []).filter((item) => item.id !== conversation.id)]);
        if (Array.isArray(members)) qc.setQueryData<Member[]>(["members", conversation.id], members);
        qc.setQueryData<ChatMessage[]>(["messages", conversation.id], []);
      }
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useDeleteBot() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId }: { botId: string }) => api.api(botDetailPath(botId), { method: "DELETE" }),
    onSuccess: (_data, vars) => {
      qc.removeQueries({ queryKey: ["bot-detail", vars.botId] });
      qc.removeQueries({ queryKey: ["bot-runtime", vars.botId] });
      qc.setQueryData<Bot[]>(["bots"], (old) => (old || []).filter((item) => String(item.id || item.key || "") !== vars.botId));
      qc.invalidateQueries({ queryKey: ["bots"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
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
