import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createEventsClient } from "../api/events";
import { createApprovalQueue, type ApprovalItem } from "../logic/approvalQueue";
import { normalizeServerRow, mergeMessage } from "../logic/normalizeMessage";
import { useAuth } from "./auth";
import type { Bot, BotRuntimeBinding, ChatMessage, Conversation, MessageRow } from "../api/types";

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

function messageHasAttachments(row: MessageRow): boolean {
  if (Array.isArray(row.attachments)) return row.attachments.length > 0;
  const raw = (row as any).attachments_json;
  if (!raw) return false;
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function patchConversationSummary(conversation: Conversation, row: MessageRow): Conversation {
  const createdAt = row.created_at || "";
  const seq = Number(row.seq) || 0;
  const body = String(row.body_md || "");
  const hasAttachments = messageHasAttachments(row);
  return {
    ...conversation,
    lastMessageText: body,
    last_message_text: body,
    lastMessageSeq: seq,
    last_message_seq: seq,
    lastMessageSenderKind: row.sender_kind || "",
    last_message_sender_kind: row.sender_kind || "",
    lastMessageSenderRef: row.sender_ref || "",
    last_message_sender_ref: row.sender_ref || "",
    lastMessageCreatedAt: createdAt,
    last_message_created_at: createdAt,
    lastActivityAt: createdAt || conversation.lastActivityAt || conversation.last_activity_at,
    last_activity_at: createdAt || conversation.last_activity_at || conversation.lastActivityAt,
    lastMessageHasAttachments: hasAttachments,
    last_message_has_attachments: hasAttachments,
  };
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
            qc.setQueryData<Conversation[]>(["conversations"], (old) => {
              if (!old?.length) return old;
              let changed = false;
              const next = old.map((conversation) => {
                if (conversation.id !== cid) return conversation;
                changed = true;
                return patchConversationSummary(conversation, row);
              });
              return changed ? next : old;
            });
          }
        } else if (t === "conversation.message_deleted") {
          // 本设备或其它设备的微信式本地隐藏:从对应会话列表里移除。
          const cid = env.conversationId || env.conversation_id;
          const mid = env.messageId || env.message_id;
          if (cid && mid) {
            qc.setQueryData<ChatMessage[]>(["messages", cid], (old) => (old || []).filter((m) => m.messageId !== mid));
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
            qc.setQueryData<Conversation[]>(["conversations"], (old) => [env.conversation, ...(old || []).filter((item) => item.id !== env.conversation.id)]);
          }
          qc.invalidateQueries({ queryKey: ["conversations"] });
        } else if (t === "conversation.updated") {
          if (env.conversation?.id) {
            qc.setQueryData<Conversation[]>(["conversations"], (old) =>
              (old || []).some((item) => item.id === env.conversation.id)
                ? (old || []).map((item) => (item.id === env.conversation.id ? { ...item, ...env.conversation } : item))
                : [env.conversation, ...(old || [])]
            );
          }
        } else if (t === "conversation.deleted") {
          const cid = env.conversationId || env.conversation_id;
          if (cid) {
            qc.setQueryData<Conversation[]>(["conversations"], (old) => (old || []).filter((item) => item.id !== cid));
            qc.removeQueries({ queryKey: ["messages", cid] });
            qc.removeQueries({ queryKey: ["members", cid] });
          }
        } else if (t === "bot.upserted") {
          const bot: Bot | undefined = env.bot;
          const id = String(bot?.id || bot?.key || "");
          if (bot && id) {
            qc.setQueryData<Bot[]>(["bots"], (old) => [bot, ...(old || []).filter((item) => String(item.id || item.key || "") !== id)]);
            qc.setQueryData(["bot-detail", id], bot);
          }
        } else if (t === "bot.deleted") {
          const id = String(env.botId || env.bot_id || "");
          if (id) {
            qc.setQueryData<Bot[]>(["bots"], (old) => (old || []).filter((item) => String(item.id || item.key || "") !== id));
            qc.removeQueries({ queryKey: ["bot-detail", id] });
            qc.removeQueries({ queryKey: ["bot-runtime", id] });
          }
        } else if (t === "bot.runtime_updated") {
          const binding: BotRuntimeBinding | undefined = env.binding;
          if (binding?.botId && binding?.runtimeKind) {
            qc.setQueryData(["bot-runtime", binding.botId, binding.runtimeKind], binding);
          }
        } else if (t === "user_settings.updated") {
          if (env.settings) qc.setQueryData(["settings"], env.settings);
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
  }, [apiBase, session?.token]);

  return <Ctx.Provider value={{ connStatus, activeApproval, pendingApprovalCount, resolveApproval }}>{children}</Ctx.Provider>;
}

export const useEvents = () => useContext(Ctx);
