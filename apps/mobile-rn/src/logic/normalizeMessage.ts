import type { ChatMessage, MessageRow } from "../api/types";
import { normalizeAttachments } from "./attachments";

function safeParse(s?: string): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// 原始服务端行 → 渲染用 ChatMessage(role / isOwn / trace)。
export function normalizeServerRow(m: MessageRow, selfId: string | undefined, index = 0): ChatMessage {
  const isOwn = m.sender_kind === "user" && !!selfId && m.sender_ref === selfId;
  const role: ChatMessage["role"] =
    m.sender_kind === "bot" ? "assistant" : m.sender_kind === "system" ? "system" : "user";
  const clientTraceId = m.client_trace_id || m.turn_id || "";
  return {
    messageId: m.id || `${m.conversation_id || ""}#${m.seq ?? index}`,
    seq: typeof m.seq === "number" ? m.seq : undefined,
    clientTraceId,
    role,
    senderKind: m.sender_kind || "",
    senderRef: m.sender_ref || "",
    statusBadge: (m as any).statusBadge ?? (m as any).status_badge ?? null,
    bodyMd: String(m.body_md || ""),
    attachments: normalizeAttachments(m.attachments),
    trace: m.trace_json ? safeParse(m.trace_json) : null,
    isOwn,
    isPending: false,
    createdAt: m.created_at || "",
  };
}

// 把一条归一化消息并入列表:命中 clientTraceId(替换 pending)或 messageId(去重)则替换,否则追加。
export function mergeMessage(list: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const next = Array.isArray(list) ? list.slice() : [];
  let idx = -1;
  if (incoming.clientTraceId) idx = next.findIndex((m) => m.clientTraceId && m.clientTraceId === incoming.clientTraceId);
  if (idx < 0 && incoming.messageId) idx = next.findIndex((m) => m.messageId === incoming.messageId);
  if (idx < 0 && incoming.isOwn) {
    idx = next.findIndex((m) =>
      m.isOwn &&
      (m.isPending || m.messageId?.startsWith("pending:")) &&
      m.bodyMd === incoming.bodyMd
    );
  }
  if (idx >= 0) next[idx] = { ...next[idx], ...incoming };
  else next.push(incoming);
  return dedupeMessages(next);
}

function dedupeMessages(list: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const byServerId = new Map<string, number>();
  const byTrace = new Map<string, number>();

  for (const msg of list) {
    const serverId = msg.messageId && !msg.messageId.startsWith("pending:") ? msg.messageId : "";
    const trace = msg.clientTraceId || "";
    const existing = serverId ? byServerId.get(serverId) : trace ? byTrace.get(trace) : undefined;
    if (existing !== undefined) {
      out[existing] = { ...out[existing], ...msg, isPending: out[existing].isPending && !msg.isPending };
      continue;
    }
    const index = out.push(msg) - 1;
    if (serverId) byServerId.set(serverId, index);
    if (trace) byTrace.set(trace, index);
  }

  return out;
}
