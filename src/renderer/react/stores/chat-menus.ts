import { useSyncExternalStore } from "react";
import type { AvatarView, StatusBadgeView } from "./contacts";

export type ChatConversationMenuRow = Readonly<{
  active: boolean;
  avatar: AvatarView | null;
  badge: StatusBadgeView | null;
  customAvatar: AvatarView | null;
  id: string;
  kind: "group" | "private";
  members: readonly Readonly<Record<string, unknown>>[];
  muted: boolean;
  name: string;
  open: () => void;
  openContextMenu: (x: number, y: number) => void;
  pinned: boolean;
  time: string;
  typeLabel: string;
  unread: number;
}>;

export type SessionMenuRow = Readonly<{
  active: boolean;
  cancelRename: () => void;
  draft: string;
  edit: () => void;
  error: string;
  id: string;
  rename: boolean;
  save: () => Promise<void>;
  saving: boolean;
  select: () => Promise<void>;
  setDraft: (value: string) => void;
  time: string;
  title: string;
  unread: number;
}>;

export type ChatMenusSnapshot = Readonly<{
  conversationRows: readonly ChatConversationMenuRow[];
  revision: number;
  sessionRows: readonly SessionMenuRow[];
}>;

type ChatMenusPatch = Partial<Omit<ChatMenusSnapshot, "revision">>;
type Listener = () => void;

let snapshot: ChatMenusSnapshot = Object.freeze({
  conversationRows: [],
  revision: 0,
  sessionRows: []
});
const listeners = new Set<Listener>();

function publish(patch: ChatMenusPatch): void {
  snapshot = Object.freeze({
    ...snapshot,
    ...patch,
    revision: snapshot.revision + 1
  });
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChatMenus(): ChatMenusSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

declare global {
  interface Window {
    miaReactChatMenus?: {
      publish(patch: ChatMenusPatch): void;
    };
  }
}

window.miaReactChatMenus = { publish };
