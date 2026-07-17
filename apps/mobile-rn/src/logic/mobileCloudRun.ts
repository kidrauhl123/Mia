import {
  createAssistantContentBlockCollector,
  type AssistantContentBlockCollector,
} from "./assistantContentBlocks";
import type { AssistantContentBlock } from "../api/types";

export interface MobileCloudRun {
  conversationId: string;
  runId: string;
  botId: string;
  status: "running" | "cancelling" | "complete" | "error" | "cancelled";
  hasActivity: boolean;
  contentBlocks: AssistantContentBlock[];
}

function stringField(payload: any, camel: string, snake: string): string {
  return String(payload?.[camel] || payload?.[snake] || "");
}

function runStatus(eventName: string): MobileCloudRun["status"] {
  if (eventName === "run.failed" || eventName === "error") return "error";
  if (eventName === "run.cancelled") return "cancelled";
  if (eventName === "run.cancelling") return "cancelling";
  if (eventName === "run.completed" || eventName === "complete") return "complete";
  return "running";
}

function finalEventText(event: any): string {
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  for (const value of [event?.final_response, event?.text, event?.content, data.final_response, data.text, data.content]) {
    if (typeof value === "string") return value;
  }
  return "";
}

export function createMobileCloudRunProjector() {
  const collectors = new Map<string, AssistantContentBlockCollector>();

  function clearConversation(conversationId: string) {
    const prefix = `${String(conversationId || "")}:`;
    for (const key of collectors.keys()) {
      if (key.startsWith(prefix)) collectors.delete(key);
    }
  }

  function clear() {
    collectors.clear();
  }

  function start(payload: any, previous?: MobileCloudRun | null): MobileCloudRun | null {
    const conversationId = stringField(payload, "conversationId", "conversation_id");
    if (!conversationId) return null;
    const runId = stringField(payload, "runId", "run_id") || `run:${conversationId}`;
    if (previous?.runId && previous.runId !== runId) clearConversation(conversationId);
    const key = `${conversationId}:${runId}`;
    if (!collectors.has(key)) collectors.set(key, createAssistantContentBlockCollector());
    return {
      conversationId,
      runId,
      botId: stringField(payload, "botId", "bot_id") || previous?.botId || "",
      status: "running",
      hasActivity: previous?.runId === runId ? Boolean(previous.hasActivity) : false,
      contentBlocks: previous?.runId === runId ? previous.contentBlocks : [],
    };
  }

  function apply(payload: any, previous?: MobileCloudRun | null): MobileCloudRun | null {
    const conversationId = stringField(payload, "conversationId", "conversation_id");
    if (!conversationId) return null;
    const runId = stringField(payload, "runId", "run_id") || previous?.runId || `run:${conversationId}`;
    const key = `${conversationId}:${runId}`;
    let collector = collectors.get(key);
    if (!collector) {
      collector = createAssistantContentBlockCollector();
      collectors.set(key, collector);
    }
    const event = payload?.event && typeof payload.event === "object" ? payload.event : {};
    const eventName = String(event.type || event.event || "");
    const runCompleted = eventName === "run.completed" || eventName === "complete";
    // Some engines only include their final text on run.completed. Treat it as
    // message.complete for the ordered-block projection; the persisted row will
    // still replace this transient bubble authoritatively.
    collector.collect(runCompleted ? { ...event, type: "message.complete" } : event);
    const finalText = runCompleted ? finalEventText(event) : "";
    return {
      conversationId,
      runId,
      botId: stringField(payload, "botId", "bot_id") || previous?.botId || "",
      status: runStatus(eventName),
      hasActivity: Boolean(eventName) || Boolean(previous?.hasActivity),
      contentBlocks: collector.payload(finalText) as AssistantContentBlock[],
    };
  }

  return { start, apply, clearConversation, clear };
}
