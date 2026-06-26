import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { createEventsClient } from "../api/events";
import { createApprovalQueue, type ApprovalItem } from "../logic/approvalQueue";
import { normalizeServerRow, mergeMessage } from "../logic/normalizeMessage";
import { mergeConversationUpdate, patchConversationListSummary, prependConversation } from "../logic/conversationCache";
import { useAuth } from "./auth";
import type { Bot, BotRuntimeBinding, ChatMessage, Conversation, MessageRow } from "../api/types";
import {
  deleteCachedConversation,
  deleteCachedMessage,
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
}

const Ctx = createContext<EventsCtx>({
  connStatus: "open",
  activeApproval: null,
  pendingApprovalCount: 0,
  resolveApproval: () => {},
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

export function EventsProvider({ children }: { children: React.ReactNode }) {
  const { apiBase, session } = useAuth();
  const qc = useQueryClient();
  const queue = useRef(createApprovalQueue()).current;
  const lastSeq = useRef(0);
  const [connStatus, setConn] = useState("open");
  const [activeApproval, setActive] = useState<ApprovalItem | null>(null);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);

  const syncActive = () => {
    setActive(queue.active());
    setPendingApprovalCount(queue.size());
  };

  const resolveApproval = (runId: string) => {
    queue.resolve(runId);
    syncActive();
  };

  useEffect(() => {
    if (!session?.token) return undefined;
    const refreshCrossDeviceReadState = () => {
      qc.invalidateQueries({ queryKey: ["settings"], refetchType: "active" });
      qc.invalidateQueries({ queryKey: ["conversations"], refetchType: "active" });
    };
    refreshCrossDeviceReadState();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshCrossDeviceReadState();
    });
    return () => subscription.remove();
  }, [qc, session?.token, session?.user?.id]);

  useEffect(() => {
    if (!session?.token) return;
    const c = createEventsClient({ apiBase, getToken: () => session.token });
    c.connect({
      sinceSeq: () => lastSeq.current,
      onStatus: setConn,
      onEvent: (env) => {
        if (typeof env.seq === "number" && env.seq > lastSeq.current) lastSeq.current = env.seq;
        const t = env.type || "";
        if (t === "conversation.message_appended") {
          const row: MessageRow = env.message || {};
          const cid = row.conversation_id || env.conversationId || env.conversation_id;
          if (cid) {
            const incoming = normalizeServerRow(row, session.user?.id);
            qc.setQueryData<ChatMessage[]>(["messages", cid], (old) => mergeMessage(old || [], incoming));
            void upsertCachedMessage(session.user?.id, cid, incoming);
            qc.setQueryData<Conversation[]>(["conversations"], (old) => patchConversationListSummary(old, cid, row));
            const conversation = qc.getQueryData<Conversation[]>(["conversations"])?.find((item) => item.id === cid);
            if (conversation) void upsertCachedConversation(session.user?.id, conversation);
          }
        } else if (t === "conversation.message_deleted") {
          // 本设备或其它设备的微信式本地隐藏:从对应会话列表里移除。
          const cid = env.conversationId || env.conversation_id;
          const mid = env.messageId || env.message_id;
          if (cid && mid) {
            qc.setQueryData<ChatMessage[]>(["messages", cid], (old) => (old || []).filter((m) => m.messageId !== mid));
            void deleteCachedMessage(session.user?.id, cid, mid);
          }
        } else if (t === "social.friend_request_received") {
          qc.invalidateQueries({ queryKey: ["friend-requests", "incoming"] });
        } else if (t === "social.friend_added") {
          qc.invalidateQueries({ queryKey: ["friends"] });
          qc.invalidateQueries({ queryKey: ["conversations"] });
          qc.invalidateQueries({ queryKey: ["friend-requests", "incoming"] });
          qc.invalidateQueries({ queryKey: ["friend-requests", "outgoing"] });
        } else if (t === "social.conversation_invited") {
          if (env.conversation?.id) {
            qc.setQueryData<Conversation[]>(["conversations"], (old) => prependConversation(old, env.conversation));
            void upsertCachedConversation(session.user?.id, env.conversation);
          }
        } else if (t === "conversation.updated") {
          if (env.conversation?.id) {
            qc.setQueryData<Conversation[]>(["conversations"], (old) => mergeConversationUpdate(old, env.conversation));
            const conversation = qc.getQueryData<Conversation[]>(["conversations"])?.find((item) => item.id === env.conversation.id);
            if (conversation) void upsertCachedConversation(session.user?.id, conversation);
          }
        } else if (t === "conversation.deleted") {
          const cid = env.conversationId || env.conversation_id;
          if (cid) {
            qc.setQueryData<Conversation[]>(["conversations"], (old) => (old || []).filter((item) => item.id !== cid));
            qc.removeQueries({ queryKey: ["messages", cid] });
            qc.removeQueries({ queryKey: ["members", cid] });
            void deleteCachedConversation(session.user?.id, cid);
          }
        } else if (t === "bot.upserted") {
          const bot: Bot | undefined = env.bot;
          const id = String(bot?.id || bot?.key || "");
          if (bot && id) {
            qc.setQueryData<Bot[]>(["bots"], (old) => [bot, ...(old || []).filter((item) => String(item.id || item.key || "") !== id)]);
            qc.setQueryData(["bot-detail", id], bot);
            void saveCachedValue(session.user?.id, sqliteCacheKeys.bots, qc.getQueryData<Bot[]>(["bots"]) || []);
          }
        } else if (t === "bot.deleted") {
          const id = String(env.botId || env.bot_id || "");
          if (id) {
            qc.setQueryData<Bot[]>(["bots"], (old) => (old || []).filter((item) => String(item.id || item.key || "") !== id));
            qc.removeQueries({ queryKey: ["bot-detail", id] });
            qc.removeQueries({ queryKey: ["bot-runtime", id] });
            void saveCachedValue(session.user?.id, sqliteCacheKeys.bots, qc.getQueryData<Bot[]>(["bots"]) || []);
          }
        } else if (t === "bot.runtime_updated") {
          const binding: BotRuntimeBinding | undefined = env.binding;
          if (binding?.botId && binding?.runtimeKind) {
            qc.setQueryData(["bot-runtime", binding.botId, binding.runtimeKind], binding);
          }
        } else if (t === "user_settings.updated") {
          if (env.settings) {
            qc.setQueryData(["settings"], env.settings);
            void saveCachedValue(session.user?.id, sqliteCacheKeys.settings, env.settings);
          }
        } else if (t === "cloud_agent_run_event") {
          // 审批等交互事件包在 cloud_agent_run_event.event 里(与桌面/web 一致)。
          const inner = env.event || {};
          const name = String(inner.type || inner.event || "");
          const runId = env.runId || env.run_id || "";
          if (name === "approval.request") {
            queue.onRequest({
              conversationId: env.conversationId || env.conversation_id,
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
      },
    });
    return () => c.stop();
  }, [apiBase, session?.token, session?.user?.id]);

  return <Ctx.Provider value={{ connStatus, activeApproval, pendingApprovalCount, resolveApproval }}>{children}</Ctx.Provider>;
}

export const useEvents = () => useContext(Ctx);
