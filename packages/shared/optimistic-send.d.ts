export interface PendingMessage {
  messageId: string;
  clientTraceId: string;
  clientOpId: string;
  bodyMd: string;
  attachments: unknown[];
  mentions: unknown[];
  role: "user";
  senderKind: "user";
  senderRef: string;
  isOwn: true;
  isPending: true;
  createdAt: string;
}

export interface OptimisticMessage {
  messageId: string;
  clientTraceId?: string;
  clientOpId?: string;
  bodyMd?: string;
  role?: "user" | "assistant" | "system";
  isOwn?: boolean;
  isPending?: boolean;
  createdAt?: string;
}

export interface ServerMessageRow {
  id?: string;
  client_trace_id?: string;
  clientTraceId?: string;
  body_md?: string;
  bodyMd?: string;
  created_at?: string;
}

export function buildPendingMessage(input: {
  text?: string;
  attachments?: unknown[];
  replyTo?: unknown;
}, ctx?: {
  selfId?: string;
  members?: unknown[];
}): PendingMessage;

export function reconcilePending<T extends OptimisticMessage>(list: T[], serverRow: ServerMessageRow): Array<T | OptimisticMessage>;
