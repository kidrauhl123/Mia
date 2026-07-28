import { useSyncExternalStore } from "react";
import type { AvatarView } from "./contacts";

export type TaskModeTab = Readonly<{
  active: boolean;
  count: number;
  id: "active" | "history";
  label: string;
  select: () => void;
  unread: number;
}>;

export type TaskFilterChip = Readonly<{
  active: boolean;
  count: number;
  id: string;
  label: string;
  select: () => void;
}>;

export type TaskCardView = Readonly<{
  botLabel: string;
  dotClass: string;
  historyIcon: string;
  historyStatus: string;
  id: string;
  meta: string;
  open: () => void;
  statusText: string;
  title: string;
  type: "active" | "history";
  unread: number;
}>;

export type TaskPreviewRun = Readonly<{
  avatar: AvatarView;
  avatarLabel: string;
  jump: (() => void) | null;
  outputClass: string;
  outputHtml: string;
  outputText: string;
  pending: boolean;
  statusText: string;
  timeText: string;
}>;

export type TaskPreviewView = Readonly<{
  canPause: boolean;
  deleteTask: () => Promise<void>;
  pauseLabel: string;
  pauseTask: () => Promise<void>;
  runs: readonly TaskPreviewRun[];
  title: string;
}>;

export type TasksSnapshot = Readonly<{
  cards: readonly TaskCardView[];
  chips: readonly TaskFilterChip[];
  emptyKind: "" | "active" | "history";
  modeTabs: readonly TaskModeTab[];
  newTask: () => void;
  pageDirection: number;
  preview: TaskPreviewView | null;
  revision: number;
}>;

type TasksPatch = Partial<Omit<TasksSnapshot, "revision">>;
type Listener = () => void;
const noop = () => {};

let snapshot: TasksSnapshot = Object.freeze({
  cards: [],
  chips: [],
  emptyKind: "",
  modeTabs: [],
  newTask: noop,
  pageDirection: 0,
  preview: null,
  revision: 0
});
const listeners = new Set<Listener>();

function publish(patch: TasksPatch): void {
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

export function useTasks(): TasksSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

declare global {
  interface Window {
    miaReactTasks?: {
      publish(patch: TasksPatch): void;
    };
  }
}

window.miaReactTasks = { publish };
