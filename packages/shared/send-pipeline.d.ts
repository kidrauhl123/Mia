export const MemberKind: {
  readonly Bot: "bot";
  readonly User: "user";
};

export const DEFAULT_MAX_LENGTH: number;

export interface Mention {
  kind: string;
  ref: string;
}

export interface OutgoingInput {
  text?: string;
  attachments?: unknown[];
  replyTo?: unknown;
}

export interface OutgoingCtx {
  members?: unknown[];
  maxLength?: number;
}

export interface PreparedMessage {
  bodyMd: string;
  mentions: Mention[];
  attachments: unknown[];
  clientTraceId: string;
  clientOpId: string;
  replyTo?: unknown;
}

export function generateClientTraceId(): string;
export function clientOpIdForTraceId(traceId: string): string;
export function parseMentions(text: string, members?: unknown[] | null): Mention[];
export function prepareOutgoingMessage(rawInput: OutgoingInput, ctx?: OutgoingCtx): PreparedMessage;
