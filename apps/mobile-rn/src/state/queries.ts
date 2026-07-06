import { useEffect } from "react";
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
import { mergeConversationSummaries, prependConversation } from "../logic/conversationCache";
import type { GroupCreatePayload } from "../logic/groupCreate";
import { mergeUserSettings, type UserSettingsPatch } from "../logic/settings";
import {
  loadCachedConversations,
  loadCachedMessages,
  loadCachedValue,
  replaceCachedConversations,
  replaceCachedMessages,
  saveCachedValue,
  sqliteCacheKeys,
  upsertCachedConversation,
} from "../storage/sqliteCache";

const LIVE_CACHE_QUERY = {
  staleTime: 60_000,
  gcTime: 30 * 60_000,
  refetchOnMount: true,
  refetchOnWindowFocus: false,
  refetchOnReconnect: true,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasId(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === "string" && value.id.trim().length > 0;
}

function validRecordArray<T>(value: T): boolean {
  return Array.isArray(value) && value.every((item) => isRecord(item));
}

function validConversationArray<T>(value: T): boolean {
  return Array.isArray(value) && value.every((item) => hasId(item));
}

function useCachedQueryHydration<T>(
  queryKey: readonly unknown[],
  enabled: boolean,
  deps: unknown[],
  load: () => Promise<T | undefined>,
  accept: (value: T) => boolean = (value) => value !== undefined
) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || qc.getQueryData(queryKey) !== undefined) return undefined;
    let cancelled = false;
    load().then((value) => {
      if (cancelled || value === undefined || !accept(value)) return;
      if (qc.getQueryData(queryKey) === undefined) qc.setQueryData(queryKey, value);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [qc, enabled, ...deps]);
}

export function useConversations() {
  const api = useApi();
  const { session } = useAuth();
  const cacheScope = session?.user?.id;
  useCachedQueryHydration<Conversation[]>(
    ["conversations"],
    Boolean(cacheScope),
    [cacheScope],
    () => loadCachedConversations(cacheScope),
    (value) => validConversationArray(value) && value.length > 0
  );
  return useQuery<Conversation[]>({
    queryKey: ["conversations"],
    ...LIVE_CACHE_QUERY,
    queryFn: async () => {
      const conversations = await api.api(conversationsPath({ includeMembers: true })).then((d) => d.conversations || []);
      void replaceCachedConversations(cacheScope, conversations);
      return conversations;
    },
    structuralSharing: (oldData: unknown, newData: unknown) =>
      mergeConversationSummaries(
        Array.isArray(oldData) ? oldData as Conversation[] : [],
        Array.isArray(newData) ? newData as Conversation[] : []
      ),
  });
}

export function useCreateGroupConversation() {
  const api = useApi();
  const qc = useQueryClient();
  const { session } = useAuth();
  const cacheScope = session?.user?.id;
  return useMutation({
    mutationFn: (payload: GroupCreatePayload) => api.api(conversationsPath(), { method: "POST", body: payload }),
    onSuccess: (data) => {
      const conversation = data?.conversation || data?.data?.conversation;
      const members = data?.members || data?.data?.members;
      if (conversation?.id) {
        qc.setQueryData<Conversation[]>(["conversations"], (old) => prependConversation(old, conversation));
        void upsertCachedConversation(cacheScope, conversation);
        if (Array.isArray(members)) qc.setQueryData<Member[]>(["members", conversation.id], members);
      }
    },
  });
}

export function useConversationMessages(conversationId: string) {
  const api = useApi();
  const { session } = useAuth();
  const selfId = session?.user?.id;
  const cacheScope = session?.user?.id;
  useCachedQueryHydration<ChatMessage[]>(
    ["messages", conversationId],
    Boolean(cacheScope && conversationId),
    [cacheScope, conversationId],
    () => loadCachedMessages(cacheScope, conversationId)
  );
  return useQuery<ChatMessage[]>({
    queryKey: ["messages", conversationId],
    enabled: !!conversationId,
    ...LIVE_CACHE_QUERY,
    queryFn: async () => {
      const messages = await api
        .api(`/api/conversations/${conversationId}/messages?limit=200`)
        .then((d) => (d.messages || []).map((r: MessageRow, i: number) => normalizeServerRow(r, selfId, i)));
      void replaceCachedMessages(cacheScope, conversationId, messages);
      return messages;
    },
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
    ...LIVE_CACHE_QUERY,
    queryFn: () =>
      api.api(`/api/conversations/${conversationId}`).then((d) => d.members || []),
  });
}

export function useBots() {
  const api = useApi();
  const { session } = useAuth();
  const cacheScope = session?.user?.id;
  useCachedQueryHydration<Bot[]>(
    ["bots"],
    Boolean(cacheScope),
    [cacheScope],
    () => loadCachedValue<Bot[]>(cacheScope, sqliteCacheKeys.bots),
    validRecordArray
  );
  // 非 compact:带 avatarImage,列表/联系人头像才能和桌面一致显示真实头像。
  return useQuery<Bot[]>({
    queryKey: ["bots"],
    ...LIVE_CACHE_QUERY,
    queryFn: async () => {
      const bots = await api.api("/api/me/bots").then((d) => d.bots || []);
      void saveCachedValue(cacheScope, sqliteCacheKeys.bots, bots);
      return bots;
    },
  });
}

export function useFriends() {
  const api = useApi();
  const { session } = useAuth();
  const cacheScope = session?.user?.id;
  useCachedQueryHydration<Friend[]>(
    ["friends"],
    Boolean(cacheScope),
    [cacheScope],
    () => loadCachedValue<Friend[]>(cacheScope, sqliteCacheKeys.friends),
    validRecordArray
  );
  return useQuery<Friend[]>({
    queryKey: ["friends"],
    ...LIVE_CACHE_QUERY,
    queryFn: async () => {
      const friends = await api.api("/api/social/friends").then((d) => d.friends || []);
      void saveCachedValue(cacheScope, sqliteCacheKeys.friends, friends);
      return friends;
    },
  });
}

// 完整自己资料(非 compact),带 avatarImage + avatarCrop —— 自己头像与群拼贴里的"自己"用。
export function useMe() {
  const api = useApi();
  const { session } = useAuth();
  const cacheScope = session?.user?.id;
  useCachedQueryHydration<any>(
    ["me-full"],
    Boolean(cacheScope),
    [cacheScope],
    () => loadCachedValue<any>(cacheScope, sqliteCacheKeys.me),
    isRecord
  );
  return useQuery<any>({
    queryKey: ["me-full"],
    ...LIVE_CACHE_QUERY,
    queryFn: async () => {
      const me = await api.api("/api/me").then((d) => d.user || d);
      void saveCachedValue(cacheScope, sqliteCacheKeys.me, me);
      return me;
    },
  });
}

export function useUserSettings(options: { enabled?: boolean } = {}) {
  const api = useApi();
  const { session } = useAuth();
  const cacheScope = session?.user?.id;
  const enabled = options.enabled ?? true;
  useCachedQueryHydration<UserSettings>(
    ["settings"],
    Boolean(cacheScope && enabled),
    [cacheScope, enabled],
    () => loadCachedValue<UserSettings>(cacheScope, sqliteCacheKeys.settings),
    isRecord
  );
  return useQuery<UserSettings>({
    queryKey: ["settings"],
    enabled,
    ...LIVE_CACHE_QUERY,
    queryFn: async () => {
      const settings = await api.api(settingsPath()).then((d) => d.settings || {});
      void saveCachedValue(cacheScope, sqliteCacheKeys.settings, settings);
      return settings;
    },
  });
}

export function useSaveProfile() {
  const api = useApi();
  const qc = useQueryClient();
  const { session } = useAuth();
  const cacheScope = session?.user?.id;
  return useMutation({
    mutationFn: (patch: { displayName?: string; statusBadge?: StatusBadge | null }) =>
      api.api(profilePath(), { method: "PATCH", body: patch }).then((d) => d.user || d),
    onSuccess: (user) => {
      qc.setQueryData(["me-full"], user);
      void saveCachedValue(cacheScope, sqliteCacheKeys.me, user);
    },
  });
}

export function useSaveUserSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const { session } = useAuth();
  const cacheScope = session?.user?.id;
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
      void saveCachedValue(cacheScope, sqliteCacheKeys.settings, settings);
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

export function useBotRuntime(botId: string | undefined, kind = "cloud-claude-code") {
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
  const { session } = useAuth();
  const cacheScope = session?.user?.id;
  return useMutation({
    mutationFn: ({ botId, body }: { botId: string; body: Record<string, unknown> }) =>
      api.api(botDetailPath(botId), { method: "PUT", body }).then((d) => d.bot || null),
    onSuccess: (bot, vars) => {
      if (!bot) return;
      qc.setQueryData(["bot-detail", vars.botId], bot);
      qc.setQueryData<Bot[]>(["bots"], (old) => [bot, ...(old || []).filter((item) => String(item.id || item.key || "") !== vars.botId)]);
      void saveCachedValue(cacheScope, sqliteCacheKeys.bots, qc.getQueryData<Bot[]>(["bots"]) || []);
    },
  });
}

export function useCreateCloudBot() {
  const api = useApi();
  const qc = useQueryClient();
  const { session } = useAuth();
  const cacheScope = session?.user?.id;
  return useMutation({
    mutationFn: async ({ botId, draft, defaultModel }: { botId: string; draft: BotDraft; defaultModel?: string }) => {
      const identity = botIdentityBody(draft);
      const saved = await api.api(botDetailPath(botId), { method: "PUT", body: identity });
      const runtime = await api.api(botRuntimeSavePath(botId), {
        method: "PUT",
        body: {
          runtimeKind: "cloud-claude-code",
          enabled: true,
          config: botRuntimeDefaultConfig(defaultModel),
        },
      });
      const ensured = await api.api(botConversationPath(botId), {
        method: "PUT",
        body: {
          botId,
          title: identity.name,
          runtimeKind: "cloud-claude-code",
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
      void saveCachedValue(cacheScope, sqliteCacheKeys.bots, qc.getQueryData<Bot[]>(["bots"]) || []);
      qc.setQueryData(["bot-detail", vars.botId], bot);
      if (data.binding) qc.setQueryData(["bot-runtime", vars.botId, "cloud-claude-code"], data.binding);
      if (data.conversation?.id) {
        qc.setQueryData<Conversation[]>(["conversations"], (old) => prependConversation(old, data.conversation));
        void upsertCachedConversation(cacheScope, data.conversation);
        if (Array.isArray(data.members)) qc.setQueryData<Member[]>(["members", data.conversation.id], data.members);
      }
      qc.invalidateQueries({ queryKey: ["bots"] });
    },
  });
}

export function useCreateBotSessionConversation() {
  const api = useApi();
  const qc = useQueryClient();
  const { session } = useAuth();
  const cacheScope = session?.user?.id;
  return useMutation({
    mutationFn: ({ sessionId, botId, title, runtimeKind }: { sessionId: string; botId: string; title: string; runtimeKind: string }) =>
      api.api(botConversationPath(sessionId), { method: "PUT", body: { botId, title, runtimeKind } }),
    onSuccess: (data) => {
      const conversation = data?.conversation || null;
      const members = data?.members || null;
      if (conversation?.id) {
        qc.setQueryData<Conversation[]>(["conversations"], (old) => prependConversation(old, conversation));
        void upsertCachedConversation(cacheScope, conversation);
        if (Array.isArray(members)) qc.setQueryData<Member[]>(["members", conversation.id], members);
        qc.setQueryData<ChatMessage[]>(["messages", conversation.id], []);
      }
    },
  });
}

export function useDeleteBot() {
  const api = useApi();
  const qc = useQueryClient();
  const { session } = useAuth();
  const cacheScope = session?.user?.id;
  return useMutation({
    mutationFn: ({ botId }: { botId: string }) => api.api(botDetailPath(botId), { method: "DELETE" }),
    onSuccess: (_data, vars) => {
      qc.removeQueries({ queryKey: ["bot-detail", vars.botId] });
      qc.removeQueries({ queryKey: ["bot-runtime", vars.botId] });
      qc.setQueryData<Bot[]>(["bots"], (old) => (old || []).filter((item) => String(item.id || item.key || "") !== vars.botId));
      void saveCachedValue(cacheScope, sqliteCacheKeys.bots, qc.getQueryData<Bot[]>(["bots"]) || []);
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
