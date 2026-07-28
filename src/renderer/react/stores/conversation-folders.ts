import { flushSync } from "react-dom";
import { useSyncExternalStore } from "react";
import { measureReactCommit } from "../performance";

export type ConversationFolderItem = Readonly<{
  active: boolean;
  color: string;
  count: number;
  filterValue: string;
  key: string;
  name: string;
  title: string;
  type: "all" | "tag";
}>;

export type ConversationFolderPayload = Readonly<{
  items: readonly ConversationFolderItem[];
  reorder: (keys: readonly string[]) => void;
  select: (filterValue: string, direction: number) => void;
  visible: boolean;
}>;

type ConversationFolderSnapshot = ConversationFolderPayload & Readonly<{
  fingerprint: string;
  revision: number;
}>;

type Listener = () => void;

const listeners = new Set<Listener>();
const noop = () => {};
let snapshot: ConversationFolderSnapshot = Object.freeze({
  fingerprint: "",
  items: Object.freeze([]),
  reorder: noop,
  revision: 0,
  select: noop,
  visible: false
});

function fingerprintFor(payload: ConversationFolderPayload): string {
  return JSON.stringify({
    visible: payload.visible,
    items: payload.items.map((item) => ({
      active: item.active,
      color: item.color,
      count: item.count,
      filterValue: item.filterValue,
      key: item.key,
      name: item.name,
      title: item.title,
      type: item.type
    }))
  });
}

function publish(payload: ConversationFolderPayload): void {
  const fingerprint = fingerprintFor(payload);
  if (fingerprint === snapshot.fingerprint) return;
  measureReactCommit("react.commit.conversationFolders", () => flushSync(() => {
    snapshot = Object.freeze({
      ...payload,
      fingerprint,
      items: Object.freeze([...payload.items]),
      revision: snapshot.revision + 1
    });
    for (const listener of [...listeners]) listener();
  }));
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useConversationFolders(): ConversationFolderSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

declare global {
  interface Window {
    miaReactConversationFolders?: {
      publish(payload: ConversationFolderPayload): void;
    };
  }
}

window.miaReactConversationFolders = { publish };

export { useConversationFolders };
