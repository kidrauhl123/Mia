import type { ChatMessage, MessageRow } from "../api/types";

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
    m.sender_kind === "fellow" ? "assistant" : m.sender_kind === "system" ? "system" : "user";
  return {
    messageId: m.id || `${m.conversation_id || ""}#${m.seq ?? index}`,
    clientTraceId: m.client_trace_id || "",
    role,
    bodyMd: String(m.body_md || ""),
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
  if (idx >= 0) next[idx] = { ...next[idx], ...incoming };
  else next.push(incoming);
  return next;
}
