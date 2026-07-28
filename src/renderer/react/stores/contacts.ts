import { useSyncExternalStore } from "react";

export type AvatarView = Readonly<{
  color: string;
  crop: Readonly<Record<string, unknown>> | null;
  image: string;
  text: string;
}>;

export type StatusBadgeView = Readonly<{
  assetId?: string;
  collectibleId?: string;
  emoji?: string;
  kind: "emoji" | "gift" | "lottie";
  label?: string;
}>;

export type ContactRowView = Readonly<{
  active: boolean;
  avatar: AvatarView;
  badge: StatusBadgeView | null;
  deviceLabel: string;
  key: string;
  name: string;
  open: () => void;
  select: () => void;
}>;

export type ContactGroupView = Readonly<{
  collapsed: boolean;
  key: string;
  label: string;
  rows: readonly ContactRowView[];
  toggle: () => void;
}>;

export type FriendRequestView = Readonly<{
  accept: () => Promise<void>;
  avatar: AvatarView;
  badge: StatusBadgeView | null;
  id: string;
  name: string;
  reject: () => Promise<void>;
}>;

export type RuntimeTargetOptionView = Readonly<{
  disabled: boolean;
  engineKind: string;
  label: string;
  selected: boolean;
  select: () => void;
  title: string;
}>;

export type RuntimeTargetGroupView = Readonly<{
  key: string;
  label: string;
  options: readonly RuntimeTargetOptionView[];
  statusLabel: string;
}>;

export type CapabilityOptionView = Readonly<{
  checked: boolean;
  id: string;
  label: string;
  originLabel: string;
  setChecked: (checked: boolean) => void;
}>;

export type MemoryEntryView = Readonly<{
  draft: string;
  editing: boolean;
  error: string;
  index: number;
  saving: boolean;
  text: string;
}>;

export type MemoryPanelView = Readonly<{
  cancelEdit: () => void;
  edit: (index: number) => void;
  entries: readonly MemoryEntryView[];
  mode: "mia" | "native";
  open: boolean;
  saveEdit: () => void;
  stateText: string;
  summary: string;
  toggle: (open: boolean) => void;
  updateDraft: (value: string) => void;
}>;

export type ContactBotDetailView = Readonly<{
  avatar: AvatarView;
  badge: StatusBadgeView | null;
  canDelete: boolean;
  canEdit: boolean;
  capabilities: Readonly<{
    addable: readonly CapabilityOptionView[];
    enabled: readonly CapabilityOptionView[];
    open: boolean;
    summary: string;
    toggle: (open: boolean) => void;
  }> | null;
  deleteContact: () => void;
  deviceLabel: string;
  editContact: () => void;
  engineKind: string;
  engineLabel: string;
  key: string;
  memory: MemoryPanelView | null;
  message: () => void;
  name: string;
  persona: Readonly<{
    open: boolean;
    summary: string;
    text: string;
    toggle: (open: boolean) => void;
  }>;
  runtime: Readonly<{
    groups: readonly RuntimeTargetGroupView[];
    open: boolean;
    summary: string;
    toggle: (open: boolean) => void;
  }>;
  uid: string;
}>;

export type ContactDetailView =
  | Readonly<{ kind: "empty"; text: string }>
  | Readonly<{ kind: "requests"; requests: readonly FriendRequestView[] }>
  | Readonly<{ bot: ContactBotDetailView; kind: "bot" }>;

export type ContactsSnapshot = Readonly<{
  detail: ContactDetailView;
  emptyText: string;
  groups: readonly ContactGroupView[];
  requestCount: number;
  requestsActive: boolean;
  revision: number;
  selectRequests: () => void;
}>;

type ContactsPatch = Partial<Omit<ContactsSnapshot, "revision">>;
type Listener = () => void;
const noop = () => {};

const initialSnapshot: ContactsSnapshot = {
  detail: { kind: "empty", text: "添加一个伙伴后会显示在这里" },
  emptyText: "",
  groups: [],
  requestCount: 0,
  requestsActive: false,
  revision: 0,
  selectRequests: noop
};
let snapshot: ContactsSnapshot = Object.freeze(initialSnapshot);
const listeners = new Set<Listener>();

function publish(patch: ContactsPatch): void {
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

export function useContacts(): ContactsSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

declare global {
  interface Window {
    miaReactContacts?: {
      publish(patch: ContactsPatch): void;
    };
  }
}

window.miaReactContacts = { publish };
