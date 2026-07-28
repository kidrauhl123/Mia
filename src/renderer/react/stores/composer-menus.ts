import { flushSync } from "react-dom";
import { useSyncExternalStore } from "react";
import { measureReactCommit } from "../performance";

export type SlashCommandMenuItem = Readonly<{
  command: string;
  description: string;
}>;

export type SlashCommandMenuPayload = Readonly<{
  choose: (command: string) => void;
  highlight: (index: number) => void;
  items: readonly SlashCommandMenuItem[];
  open: boolean;
  selectedIndex: number;
}>;

export type MentionMenuItem = Readonly<{
  color: string;
  index: number;
  key: string;
  kind: string;
  name: string;
}>;

export type MentionMenuPayload = Readonly<{
  choose: (index: number) => void;
  highlight: (index: number) => void;
  items: readonly MentionMenuItem[];
  open: boolean;
  selectedIndex: number;
}>;

type MenuSnapshot<T> = T & Readonly<{
  fingerprint: string;
  revision: number;
}>;

type Listener = () => void;

const noop = () => {};
const slashListeners = new Set<Listener>();
const mentionListeners = new Set<Listener>();

let slashSnapshot: MenuSnapshot<SlashCommandMenuPayload> = Object.freeze({
  choose: noop,
  fingerprint: "",
  highlight: noop,
  items: Object.freeze([]),
  open: false,
  revision: 0,
  selectedIndex: 0
});

let mentionSnapshot: MenuSnapshot<MentionMenuPayload> = Object.freeze({
  choose: noop,
  fingerprint: "",
  highlight: noop,
  items: Object.freeze([]),
  open: false,
  revision: 0,
  selectedIndex: 0
});

function menuFingerprint(payload: SlashCommandMenuPayload | MentionMenuPayload): string {
  return JSON.stringify({
    items: payload.items,
    open: payload.open,
    selectedIndex: payload.selectedIndex
  });
}

function publishSlash(payload: SlashCommandMenuPayload): void {
  const fingerprint = menuFingerprint(payload);
  if (fingerprint === slashSnapshot.fingerprint) {
    slashSnapshot = Object.freeze({ ...slashSnapshot, choose: payload.choose, highlight: payload.highlight });
    return;
  }
  measureReactCommit("react.commit.slashCommandMenu", () => flushSync(() => {
    slashSnapshot = Object.freeze({
      ...payload,
      fingerprint,
      items: Object.freeze([...payload.items]),
      revision: slashSnapshot.revision + 1
    });
    for (const listener of [...slashListeners]) listener();
  }));
}

function publishMention(payload: MentionMenuPayload): void {
  const fingerprint = menuFingerprint(payload);
  if (fingerprint === mentionSnapshot.fingerprint) {
    mentionSnapshot = Object.freeze({ ...mentionSnapshot, choose: payload.choose, highlight: payload.highlight });
    return;
  }
  measureReactCommit("react.commit.mentionMenu", () => flushSync(() => {
    mentionSnapshot = Object.freeze({
      ...payload,
      fingerprint,
      items: Object.freeze([...payload.items]),
      revision: mentionSnapshot.revision + 1
    });
    for (const listener of [...mentionListeners]) listener();
  }));
}

function subscribe(listeners: Set<Listener>, listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useSlashCommandMenu(): MenuSnapshot<SlashCommandMenuPayload> {
  return useSyncExternalStore(
    (listener) => subscribe(slashListeners, listener),
    () => slashSnapshot,
    () => slashSnapshot
  );
}

function useMentionMenu(): MenuSnapshot<MentionMenuPayload> {
  return useSyncExternalStore(
    (listener) => subscribe(mentionListeners, listener),
    () => mentionSnapshot,
    () => mentionSnapshot
  );
}

export type MiaReactComposerMenus = {
  publishMention(payload: MentionMenuPayload): void;
  publishSlash(payload: SlashCommandMenuPayload): void;
};

declare global {
  interface Window {
    miaReactComposerMenus?: MiaReactComposerMenus;
  }
}

window.miaReactComposerMenus = {
  publishMention,
  publishSlash
};

export { useMentionMenu, useSlashCommandMenu };
