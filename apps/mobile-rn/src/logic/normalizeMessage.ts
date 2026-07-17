import type { ChatMessage, MessageRow } from "../api/types";
import { normalizeCloudMessageFields } from "@mia/shared/cloud-message-row";
import { contentBlocksWithFinalText } from "./assistantContentBlocks";
import { normalizeAttachments } from "./attachments";

// 原始服务端行 → 渲染用 ChatMessage(role / isOwn / trace)。
export function normalizeServerRow(m: MessageRow, selfId: string | undefined, index = 0): ChatMessage {
  const fields = normalizeCloudMessageFields(m as unknown as Record<string, unknown>);
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
    attachments: normalizeAttachments(fields.attachments),
    mentions: fields.mentions,
    skills: fields.skills,
    contentBlocks: fields.contentBlocks.length
      ? contentBlocksWithFinalText(fields.contentBlocks, m.body_md || "") as ChatMessage["contentBlocks"]
      : [],
    trace: fields.trace,
    isOwn,
    isPending: false,
    createdAt: m.created_at || "",
  };
}

function messageLane(msg: ChatMessage): string {
  const kind = String(msg.senderKind || (msg.role === "assistant" ? "bot" : msg.role) || "");
  if (kind === "user" && msg.isOwn) return "user:self";
  const ref = String(msg.senderRef || (msg.isOwn ? "self" : ""));
  return `${kind}:${ref}`;
}

function sameTraceLane(a: ChatMessage, b: ChatMessage): boolean {
  if (!a.clientTraceId || a.clientTraceId !== b.clientTraceId) return false;
  const aKind = String(a.senderKind || (a.role === "assistant" ? "bot" : a.role) || "");
  const bKind = String(b.senderKind || (b.role === "assistant" ? "bot" : b.role) || "");
  if (aKind !== bKind) return false;
  if (aKind === "user" && a.isOwn && b.isOwn) return true;
  return messageLane(a) === messageLane(b);
}

function sortMessages(list: ChatMessage[]): ChatMessage[] {
  return list.slice().sort((a, b) => {
    const aSeq = Number(a.seq);
    const bSeq = Number(b.seq);
    const aConfirmed = Number.isFinite(aSeq) && aSeq > 0;
    const bConfirmed = Number.isFinite(bSeq) && bSeq > 0;
    if (aConfirmed && bConfirmed && aSeq !== bSeq) return aSeq - bSeq;
    if (aConfirmed !== bConfirmed) return aConfirmed ? -1 : 1;
    const time = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    if (time) return time;
    return String(a.messageId || "").localeCompare(String(b.messageId || ""));
  });
}

// 把一条归一化消息并入列表:命中 clientTraceId(替换 pending)或 messageId(去重)则替换,否则追加。
export function mergeMessage(list: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const next = Array.isArray(list) ? list.slice() : [];
  const idIdx = incoming.messageId ? next.findIndex((m) => m.messageId === incoming.messageId) : -1;
  const traceIdx = incoming.clientTraceId ? next.findIndex((m) => sameTraceLane(m, incoming)) : -1;
  if (idIdx >= 0 && traceIdx >= 0 && idIdx !== traceIdx) {
    next[idIdx] = { ...next[traceIdx], ...next[idIdx], ...incoming };
    next.splice(traceIdx, 1);
    return sortMessages(dedupeMessages(next));
  }
  let idx = idIdx >= 0 ? idIdx : traceIdx;
  if (idx < 0 && incoming.isOwn) {
    const matches = next.map((m, index) => ({ m, index })).filter(({ m }) =>
      m.isOwn &&
      (m.isPending || m.messageId?.startsWith("pending:")) &&
      m.bodyMd === incoming.bodyMd
    );
    if (matches.length === 1) idx = matches[0].index;
  }
  if (idx >= 0) next[idx] = { ...next[idx], ...incoming };
  else next.push(incoming);
  return sortMessages(dedupeMessages(next));
}

function dedupeMessages(list: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const byServerId = new Map<string, number>();
  const byTraceLane = new Map<string, number>();

  for (const msg of list) {
    const serverId = msg.messageId && !msg.messageId.startsWith("pending:") ? msg.messageId : "";
    const traceLane = msg.clientTraceId ? `${messageLane(msg)}:${msg.clientTraceId}` : "";
    let existing = serverId ? byServerId.get(serverId) : undefined;
    if (existing === undefined && traceLane) existing = byTraceLane.get(traceLane);
    if (existing !== undefined) {
      out[existing] = { ...out[existing], ...msg, isPending: Boolean(out[existing].isPending && msg.isPending) };
      if (serverId) byServerId.set(serverId, existing);
      if (traceLane) byTraceLane.set(traceLane, existing);
      continue;
    }
    const index = out.push(msg) - 1;
    if (serverId) byServerId.set(serverId, index);
    if (traceLane) byTraceLane.set(traceLane, index);
  }

  return out;
}

// React Query refetches should take the server list as truth, but must not
// erase confirmed websocket/cache rows outside the fetched window or a local
// outgoing bubble that has not been echoed by the server yet.
export function mergeFetchedMessages(previous: ChatMessage[] = [], fetched: ChatMessage[] = []): ChatMessage[] {
  const serverPage = Array.isArray(fetched) ? fetched : [];
  const pageIds = new Set(serverPage.map((message) => String(message.messageId || "")).filter(Boolean));
  const pageBounds = serverPage.reduce((bounds, message) => {
    const seq = Number(message.seq);
    if (!Number.isFinite(seq) || seq <= 0) return bounds;
    return {
      min: bounds.min ? Math.min(bounds.min, seq) : seq,
      max: Math.max(bounds.max, seq),
    };
  }, { min: 0, max: 0 });
  const kept = (Array.isArray(previous) ? previous : []).filter((message) => {
    if (!pageBounds.min || !pageBounds.max) return true;
    if (message.isPending || message.failed || String(message.messageId || "").startsWith("pending:")) return true;
    const seq = Number(message.seq);
    if (!Number.isFinite(seq) || seq < pageBounds.min || seq > pageBounds.max) return true;
    return pageIds.has(String(message.messageId || ""));
  });
  let next = sortMessages(dedupeMessages(kept));
  for (const msg of serverPage) next = mergeMessage(next, msg);
  return next;
}
