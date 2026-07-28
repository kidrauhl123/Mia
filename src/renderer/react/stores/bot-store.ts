import { useSyncExternalStore } from "react";

export type BotStoreCard = Readonly<{
  category: string;
  description: string;
  emoji: string;
  key: string;
  name: string;
  primaryColor: string;
  surfaceColor: string;
}>;

export type BotStoreSkill = Readonly<{
  id: string;
  label: string;
}>;

export type BotStoreSheet = Readonly<{
  adding: boolean;
  category: string;
  description: string;
  emoji: string;
  engineAccent: string;
  engineSummary: string;
  key: string;
  mode: "closed" | "detail" | "enroll";
  name: string;
  plannedKey: string;
  primaryColor: string;
  skills: readonly BotStoreSkill[];
  stamped: boolean;
  status: string;
  surfaceColor: string;
}>;

export type BotStoreSnapshot = Readonly<{
  activeCategory: string;
  cards: readonly BotStoreCard[];
  categories: readonly string[];
  emptyText: string;
  pageDirection: number;
  revision: number;
  sheet: BotStoreSheet;
  addAssistant: (key: string) => void;
  closeSheet: () => void;
  confirmAssistant: () => void;
  openAssistant: (key: string) => void;
  returnToDetail: () => void;
  selectCategory: (category: string) => void;
}>;

type BotStorePatch = Partial<Omit<BotStoreSnapshot, "revision">>;
type Listener = () => void;

const noop = () => {};
const emptySheet: BotStoreSheet = Object.freeze({
  adding: false,
  category: "",
  description: "",
  emoji: "",
  engineAccent: "",
  engineSummary: "",
  key: "",
  mode: "closed",
  name: "",
  plannedKey: "",
  primaryColor: "#5e5ce6",
  skills: [],
  stamped: false,
  status: "",
  surfaceColor: "#ecebfc"
});

let snapshot: BotStoreSnapshot = Object.freeze({
  activeCategory: "全部",
  cards: [],
  categories: [],
  emptyText: "",
  pageDirection: 0,
  revision: 0,
  sheet: emptySheet,
  addAssistant: noop,
  closeSheet: noop,
  confirmAssistant: noop,
  openAssistant: noop,
  returnToDetail: noop,
  selectCategory: noop
});

const listeners = new Set<Listener>();

function publish(patch: BotStorePatch): void {
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

export function useBotStore(): BotStoreSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

declare global {
  interface Window {
    miaReactBotStore?: {
      publish(patch: BotStorePatch): void;
    };
  }
}

window.miaReactBotStore = { publish };

