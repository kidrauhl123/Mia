import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { createEventsClient } from "../api/events";
import { createApprovalQueue, type ApprovalItem } from "../logic/approvalQueue";
import {
  createMobileCloudRunProjector,
  type MobileCloudRun,
} from "../logic/mobileCloudRun";
import { normalizeServerRow, mergeMessage } from "../logic/normalizeMessage";
import { mergeConversationUpdate, patchConversationListSummary, prependConversation } from "../logic/conversationCache";
import {
  activeConversationIdQueryKey,
  clearUnreadCount,
  hasCachedMessage,
  incrementUnreadCount,
  reconcileUnreadCountsWithReadMarks,
  shouldIncrementUnreadForMessage,
  unreadCountsQueryKey,
  type UnreadCounts,
} from "../logic/unreadState";
import { shouldReconcileUnreadFromQueryCacheEvent } from "../logic/queryCacheEvent";
import { useAuth } from "./auth";
import type { Bot, BotRuntimeBinding, ChatMessage, Conversation, MessageRow, UserSettings } from "../api/types";
import {
  deleteCachedConversation,
  deleteCachedMessage,
  loadCachedValue,
  saveCachedValue,
  sqliteCacheKeys,
  upsertCachedConversation,
  upsertCachedMessage,
} from "../storage/sqliteCache";

interface EventsCtx {
  connStatus: string;
  activeApproval: ApprovalItem | null;
  pendingApprovalCount: number;
  resolveApproval: (runId: string) => void;
  runsByConversation: Record<string, MobileCloudRun>;
}

const Ctx = createContext<EventsCtx>({
  connStatus: "open",
  activeApproval: null,
  pendingApprovalCount: 0,
  resolveApproval: () => {},
  runsByConversation: {},
});

// 从 Hermes 内层事件里取审批预览文本(命令/原因等),镜像 web 的 approvalPreview。
function approvalPreview(event: any = {}): string {
  const pick = (o: any) => {
    for (const k of ["command", "cmd", "preview", "reason", "detail", "description", "message"]) {
      if (o && typeof o[k] === "string" && o[k].trim()) return o[k].trim();
    }
    return "";
  };
  return (
    pick(event) ||
    pick(event.data) ||
    String(event.tool || event.tool_name || event.name || "请求执行操作")
  );
}

function eventSeq(value: unknown): number {
  const seq = Number(value);
  return Number.isFinite(seq) && seq > 0 ? seq : 0;
}

export function EventsProvider({ children }: { children: React.ReactNode }) {
  const { apiBase, session } = useAuth();
  const qc = useQueryClient();
  const queue = useRef(createApprovalQueue()).current;
  const lastSeq = useRef(0);
  const userId = session?.user?.id || "";
  const [cursorScope, setCursorScope] = useState("");
  const [connStatus, setConn] = useState("open");
  const [activeApproval, setActive] = useState<ApprovalItem | null>(null);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [runsByConversation, setRunsByConversation] = useState<Record<string, MobileCloudRun>>({});
  const runsByConversationRef = useRef<Record<string, MobileCloudRun>>({});
  const runProjector = useRef(createMobileCloudRunProjector()).current;

  const publishRun = useCallback((run: MobileCloudRun) => {
    const next = { ...runsByConversationRef.current, [run.conversationId]: run };
    runsByConversationRef.current = next;
    setRunsByConversation(next);
  }, []);

  const clearConversationRun = useCallback((conversationId: string) => {
    const id = String(conversationId || "");
    if (!id) return;
    const current = runsByConversationRef.current;
    if (current[id]) {
      const next = { ...current };
      delete next[id];
      runsByConversationRef.current = next;
      setRunsByConversation(next);
    }
    runProjector.clearConversation(id);
  }, [runProjector]);

  const reconcileUnreadFromCachedReadMarks = useCallback(() => {
    const settings = qc.getQueryData<UserSettings>(["settings"]);
    const conversations = qc.getQueryData<Conversation[]>(["conversations"]) || [];
    qc.setQueryData<UnreadCounts>(unreadCountsQueryKey, (old) =>
      reconcileUnreadCountsWithReadMarks(old, settings?.readMarks || {}, conversations)
    );
  }, [qc]);

  const refreshCrossDeviceReadState = useCallback(() => {
    reconcileUnreadFromCachedReadMarks();
    qc.invalidateQueries({ queryKey: ["settings"], refetchType: "active" });
    qc.invalidateQueries({ queryKey: ["conversations"], refetchType: "active" });
  }, [qc, reconcileUnreadFromCachedReadMarks]);

  const saveLastSeq = useCallback((seq: number) => {
    const next = eventSeq(seq);
    lastSeq.current = next;
    void saveCachedValue(userId, sqliteCacheKeys.lastEventSeq, next);
  }, [userId]);

  const advanceLastSeq = useCallback((seq: unknown) => {
    const next = eventSeq(seq);
    if (next > lastSeq.current) saveLastSeq(next);
  }, [saveLastSeq]);

  const syncActive = () => {
    setActive(queue.active());
    setPendingApprovalCount(queue.size());
  };

  const resolveApproval = (runId: string) => {
    queue.resolve(runId);
    syncActive();
  };

  useEffect(() => {
    if (!session?.token || !userId) {
      lastSeq.current = 0;
      setCursorScope("");
      runsByConversationRef.current = {};
      setRunsByConversation({});
      runProjector.clear();
      return undefined;
    }
    let cancelled = false;
    setCursorScope("");
    loadCachedValue<number>(userId, sqliteCacheKeys.lastEventSeq)
      .then((seq) => {
        if (cancelled) return;
        lastSeq.current = eventSeq(seq);
        setCursorScope(userId);
      })
      .catch(() => {
        if (cancelled) return;
        lastSeq.current = 0;
        setCursorScope(userId);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.token, userId]);

  useEffect(() => {
    if (!session?.token) return undefined;
    refreshCrossDeviceReadState();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshCrossDeviceReadState();
    });
    return () => subscription.remove();
  }, [refreshCrossDeviceReadState, session?.token, userId]);

  useEffect(() => {
    if (!session?.token) return undefined;
    reconcileUnreadFromCachedReadMarks();
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      if (shouldReconcileUnreadFromQueryCacheEvent(event)) {
        reconcileUnreadFromCachedReadMarks();
      }
    });
    return unsubscribe;
  }, [qc, reconcileUnreadFromCachedReadMarks, session?.token, userId]);

  useEffect(() => {
    if (!session?.token || !userId || cursorScope !== userId) return;
    const c = createEventsClient({ apiBase, getToken: () => session.token });
    c.connect({
      sinceSeq: () => lastSeq.current,
      onStatus: setConn,
      onEvent: (env) => {
        try {
        const payload = env?.payload && typeof env.payload === "object" ? env.payload : env;
        const t = String(payload?.type || env?.type || "");
        if (t === "events_ready") {
          if (payload?.resetTo != null) saveLastSeq(Number(payload.resetTo));
          refreshCrossDeviceReadState();
          return;
        }
        if (t === "conversation.message_appended") {
          const row: MessageRow = payload.message || {};
          const cid = row.conversation_id || payload.conversationId || payload.conversation_id;
          if (cid) {
            const incoming = normalizeServerRow({ ...row, conversation_id: row.conversation_id || cid }, userId);
            if (row.sender_kind === "bot") clearConversationRun(cid);
            const cachedMessages = qc.getQueryData<ChatMessage[]>(["messages", cid]) || [];
            const fresh = !hasCachedMessage(cachedMessages, incoming);
            qc.setQueryData<ChatMessage[]>(["messages", cid], (old) => mergeMessage(old || [], incoming));
            void upsertCachedMessage(userId, cid, incoming);
            qc.setQueryData<Conversation[]>(["conversations"], (old) => patchConversationListSummary(old, cid, row));
            const conversation = qc.getQueryData<Conversation[]>(["conversations"])?.find((item) => item.id === cid);
            if (conversation) void upsertCachedConversation(userId, conversation);
            const activeConversationId = qc.getQueryData<string>(activeConversationIdQueryKey) || "";
            if (activeConversationId === cid) {
              qc.setQueryData<UnreadCounts>(unreadCountsQueryKey, (old) => clearUnreadCount(old, cid));
            } else if (fresh) {
              const settings = qc.getQueryData<UserSettings>(["settings"]);
              if (shouldIncrementUnreadForMessage({
                conversationId: cid,
                message: row,
                selfId: userId,
                activeConversationId,
                readMarks: settings?.readMarks || {},
              })) {
                qc.setQueryData<UnreadCounts>(unreadCountsQueryKey, (old) => incrementUnreadCount(old, cid));
              }
            }
          }
        } else if (t === "cloud_agent_run_started") {
          const cid = String(payload.conversationId || payload.conversation_id || "");
          if (cid) {
            const run = runProjector.start(payload, runsByConversationRef.current[cid]);
            if (run) publishRun(run);
          }
        } else if (t === "conversation.message_deleted") {
          // 本设备或其它设备的微信式本地隐藏:从对应会话列表里移除。
          const cid = payload.conversationId || payload.conversation_id;
          const mid = payload.messageId || payload.message_id;
          if (cid && mid) {
            qc.setQueryData<ChatMessage[]>(["messages", cid], (old) => (old || []).filter((m) => m.messageId !== mid));
            void deleteCachedMessage(userId, cid, mid);
          }
        } else if (t === "social.friend_request_received") {
          qc.invalidateQueries({ queryKey: ["friend-requests", "incoming"] });
        } else if (t === "social.friend_added") {
          qc.invalidateQueries({ queryKey: ["friends"] });
          qc.invalidateQueries({ queryKey: ["conversations"] });
          qc.invalidateQueries({ queryKey: ["friend-requests", "incoming"] });
          qc.invalidateQueries({ queryKey: ["friend-requests", "outgoing"] });
        } else if (t === "social.conversation_invited") {
          if (payload.conversation?.id) {
            qc.setQueryData<Conversation[]>(["conversations"], (old) => prependConversation(old, payload.conversation));
            void upsertCachedConversation(userId, payload.conversation);
          }
        } else if (t === "conversation.updated") {
          if (payload.conversation?.id) {
            qc.setQueryData<Conversation[]>(["conversations"], (old) => mergeConversationUpdate(old, payload.conversation));
            const conversation = qc.getQueryData<Conversation[]>(["conversations"])?.find((item) => item.id === payload.conversation.id);
            if (conversation) void upsertCachedConversation(userId, conversation);
            reconcileUnreadFromCachedReadMarks();
          }
        } else if (t === "conversation.deleted") {
          const cid = payload.conversationId || payload.conversation_id;
          if (cid) {
            qc.setQueryData<Conversation[]>(["conversations"], (old) => (old || []).filter((item) => item.id !== cid));
            qc.setQueryData<UnreadCounts>(unreadCountsQueryKey, (old) => clearUnreadCount(old, cid));
            qc.removeQueries({ queryKey: ["messages", cid] });
            qc.removeQueries({ queryKey: ["members", cid] });
            void deleteCachedConversation(userId, cid);
          }
        } else if (t === "bot.upserted") {
          const bot: Bot | undefined = payload.bot;
          const id = String(bot?.id || bot?.key || "");
          if (bot && id) {
            qc.setQueryData<Bot[]>(["bots"], (old) => [bot, ...(old || []).filter((item) => String(item.id || item.key || "") !== id)]);
            qc.setQueryData(["bot-detail", id], bot);
            void saveCachedValue(userId, sqliteCacheKeys.bots, qc.getQueryData<Bot[]>(["bots"]) || []);
          }
        } else if (t === "bot.deleted") {
          const id = String(payload.botId || payload.bot_id || "");
          if (id) {
            qc.setQueryData<Bot[]>(["bots"], (old) => (old || []).filter((item) => String(item.id || item.key || "") !== id));
            qc.removeQueries({ queryKey: ["bot-detail", id] });
            qc.removeQueries({ queryKey: ["bot-runtime", id] });
            void saveCachedValue(userId, sqliteCacheKeys.bots, qc.getQueryData<Bot[]>(["bots"]) || []);
          }
        } else if (t === "bot.runtime_updated") {
          const binding: BotRuntimeBinding | undefined = payload.binding;
          if (binding?.botId && binding?.runtimeKind) {
            qc.setQueryData(["bot-runtime", binding.botId, binding.runtimeKind], binding);
          }
        } else if (t === "user_settings.updated") {
          if (payload.settings) {
            qc.setQueryData(["settings"], payload.settings);
            void saveCachedValue(userId, sqliteCacheKeys.settings, payload.settings);
            qc.setQueryData<UnreadCounts>(unreadCountsQueryKey, (old) =>
              reconcileUnreadCountsWithReadMarks(
                old,
                payload.settings.readMarks || {},
                qc.getQueryData<Conversation[]>(["conversations"]) || []
              )
            );
          }
        } else if (t === "cloud_agent_run_event") {
          // 审批等交互事件包在 cloud_agent_run_event.event 里(与桌面/web 一致)。
          const inner = payload.event || {};
          const name = String(inner.type || inner.event || "");
          const runId = payload.runId || payload.run_id || "";
          const cid = String(payload.conversationId || payload.conversation_id || "");
          if (cid) {
            const run = runProjector.apply(payload, runsByConversationRef.current[cid]);
            if (run) publishRun(run);
          }
          if (name === "approval.request") {
            queue.onRequest({
              conversationId: payload.conversationId || payload.conversation_id,
              runId,
              preview: approvalPreview(inner),
            });
            syncActive();
          } else if (
            name === "approval.responded" ||
            name === "approval.resolved" ||
            name === "run.completed" ||
            name === "run.failed" ||
            name === "run.cancelled"
          ) {
            if (runId) queue.onResponded(runId);
            syncActive();
          }
        }
        advanceLastSeq(env?.seq);
        } catch (err) {
          console.warn("[mia] ignored malformed event", err instanceof Error ? err.message : String(err));
        }
      },
    });
    return () => c.stop();
  }, [
    advanceLastSeq,
    apiBase,
    clearConversationRun,
    cursorScope,
    publishRun,
    qc,
    reconcileUnreadFromCachedReadMarks,
    refreshCrossDeviceReadState,
    runProjector,
    saveLastSeq,
    session?.token,
    userId,
  ]);

  return <Ctx.Provider value={{ connStatus, activeApproval, pendingApprovalCount, resolveApproval, runsByConversation }}>{children}</Ctx.Provider>;
}

export const useEvents = () => useContext(Ctx);
