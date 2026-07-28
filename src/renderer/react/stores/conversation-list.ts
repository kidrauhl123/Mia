import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { measureReactCommit } from "../performance";

export type ConversationListEntry = Readonly<{
  active: boolean;
  key: string;
  signature: string;
  spec: Record<string, unknown>;
}>;

export type ConversationListPayload = Readonly<{
  activeTagFilterName: string;
  createCard: (spec: Record<string, unknown>) => HTMLElement;
  emptyText: string;
  entries: readonly ConversationListEntry[];
  grouped: boolean;
  renderGrouped?: (options: {
    root: HTMLElement;
    specs: readonly Record<string, unknown>[];
    createCard: (spec: Record<string, unknown>) => HTMLElement;
  }) => void;
}>;

type ConversationListSnapshot = ConversationListPayload & Readonly<{
  fingerprint: string;
  revision: number;
}>;

type Listener = () => void;

const listeners = new Set<Listener>();
const emptyCardFactory = () => document.createElement("div");
let snapshot: ConversationListSnapshot = Object.freeze({
  activeTagFilterName: "",
  createCard: emptyCardFactory,
  emptyText: "",
  entries: Object.freeze([]),
  fingerprint: "",
  grouped: false,
  revision: 0
});

function fingerprintFor(payload: ConversationListPayload): string {
  return JSON.stringify({
    activeTagFilterName: payload.activeTagFilterName,
    emptyText: payload.emptyText,
    grouped: payload.grouped,
    rows: payload.entries.map(({ active, key, signature }) => ({ active, key, signature }))
  });
}

function publish(payload: ConversationListPayload): void {
  const fingerprint = fingerprintFor(payload);
  if (fingerprint === snapshot.fingerprint) return;
  measureReactCommit("react.commit.conversations", () => flushSync(() => {
    snapshot = Object.freeze({
      ...payload,
      entries: Object.freeze([...payload.entries]),
      fingerprint,
      revision: snapshot.revision + 1
    });
    for (const listener of [...listeners]) listener();
  }));
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useConversationList(): ConversationListSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

declare global {
  interface Window {
    miaReactConversationList?: {
      publish(payload: ConversationListPayload): void;
    };
  }
}

window.miaReactConversationList = { publish };

export { useConversationList };
