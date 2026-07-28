import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { measureReactCommit } from "../performance";

export type MessageListEntry = Readonly<{
  build: () => HTMLElement | null;
  key: string;
  mounted?: (element: HTMLElement) => void;
  signature: string;
  tag: "article" | "div";
}>;

type MessageListSnapshot = Readonly<{
  conversationId: string;
  entries: readonly MessageListEntry[];
  fingerprint: string;
  html: string;
  mode: "empty" | "html" | "messages";
  revision: number;
}>;

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: MessageListSnapshot = Object.freeze({
  conversationId: "",
  entries: Object.freeze([]),
  fingerprint: "empty",
  html: "",
  mode: "empty",
  revision: 0
});

function commit(next: Omit<MessageListSnapshot, "revision">): void {
  if (next.fingerprint === snapshot.fingerprint) return;
  snapshot = Object.freeze({
    ...next,
    entries: Object.freeze([...next.entries]),
    revision: snapshot.revision + 1
  });
  for (const listener of [...listeners]) listener();
}

function renderMessages(payload: { conversationId: string; entries: readonly MessageListEntry[] }): void {
  const fingerprint = JSON.stringify({
    conversationId: payload.conversationId,
    rows: payload.entries.map(({ key, signature, tag }) => ({ key, signature, tag }))
  });
  measureReactCommit("react.commit.messages", () => flushSync(() => {
    commit({
      conversationId: payload.conversationId,
      entries: payload.entries,
      fingerprint: `messages:${fingerprint}`,
      html: "",
      mode: "messages"
    });
  }));
}

function renderHtml(html = ""): void {
  const value = String(html || "");
  measureReactCommit("react.commit.messageHtml", () => flushSync(() => {
    commit({
      conversationId: "",
      entries: [],
      fingerprint: value ? `html:${value}` : "empty",
      html: value,
      mode: value ? "html" : "empty"
    });
  }));
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useMessageList(): MessageListSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

declare global {
  interface Window {
    miaReactMessageList?: {
      render(payload: { conversationId: string; entries: readonly MessageListEntry[] }): void;
      renderHtml(html?: string): void;
    };
  }
}

window.miaReactMessageList = {
  render: renderMessages,
  renderHtml
};

export { useMessageList };
