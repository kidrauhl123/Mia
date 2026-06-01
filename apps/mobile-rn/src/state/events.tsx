import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createEventsClient } from "../api/events";
import { createApprovalQueue, type ApprovalItem } from "../logic/approvalQueue";
import { normalizeServerRow, mergeMessage } from "../logic/normalizeMessage";
import { useAuth } from "./auth";
import type { ChatMessage, MessageRow } from "../api/types";

interface EventsCtx {
  connStatus: string;
  activeApproval: ApprovalItem | null;
  resolveApproval: (runId: string) => void;
}

const Ctx = createContext<EventsCtx>({
  connStatus: "open",
  activeApproval: null,
  resolveApproval: () => {},
});

export function EventsProvider({ children }: { children: React.ReactNode }) {
  const { apiBase, session } = useAuth();
  const qc = useQueryClient();
  const queue = useRef(createApprovalQueue()).current;
  const lastSeq = useRef(0);
  const [connStatus, setConn] = useState("open");
  const [activeApproval, setActive] = useState<ApprovalItem | null>(null);

  const syncActive = () => setActive(queue.active());

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
        if (t === "message" || t === "message.created") {
          const row: MessageRow = env.message || env.data || {};
          const cid = row.conversation_id || env.conversation_id;
          if (cid) {
            const incoming = normalizeServerRow(row, session.user?.id);
            qc.setQueryData<ChatMessage[]>(["messages", cid], (old) => mergeMessage(old || [], incoming));
          }
        } else if (t === "approval.request") {
          queue.onRequest({
            conversationId: env.conversation_id,
            runId: env.run_id || env.runId,
            preview: env.preview || env.tool_name || (env.payload && env.payload.title) || "请求执行操作",
          });
          syncActive();
        } else if (t === "approval.responded") {
          queue.onResponded(env.run_id || env.runId);
          syncActive();
        }
      },
    });
    return () => c.stop();
  }, [apiBase, session?.token]);

  return <Ctx.Provider value={{ connStatus, activeApproval, resolveApproval }}>{children}</Ctx.Provider>;
}

export const useEvents = () => useContext(Ctx);
