import type { ChatMessage } from "../api/types";
import { clientOpIdForTraceId } from "./sendPipeline";

export interface MessageSendPayload {
  bodyMd: string;
  clientTraceId: string;
  clientOpId?: string;
  mentions?: unknown[];
  attachments?: unknown[];
}

export function messagePostBody(payload: MessageSendPayload) {
  return {
    bodyMd: payload.bodyMd,
    turnId: payload.clientTraceId,
    clientOpId: payload.clientOpId || clientOpIdForTraceId(payload.clientTraceId),
    mentions: payload.mentions,
    attachments: payload.attachments,
  };
}

export function retryPayloadFromMessage(message: ChatMessage): MessageSendPayload {
  return {
    bodyMd: message.bodyMd,
    clientTraceId: message.clientTraceId,
    clientOpId: message.clientOpId || clientOpIdForTraceId(message.clientTraceId),
    mentions: message.mentions,
    attachments: message.attachments,
  };
}
