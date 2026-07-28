import { useSyncExternalStore } from "react";

export type SkillModeTab = Readonly<{
  active: boolean;
  id: "skills" | "mcp";
  label: string;
  select: () => void;
}>;

export type SkillChip = Readonly<{
  active: boolean;
  ariaLabel?: string;
  id: string;
  label: string;
  select: () => void;
}>;

export type SkillSourceLogo = Readonly<{
  key: string;
  label: string;
  mask: boolean;
  src: string;
}>;

export type SkillCardAction = Readonly<{
  className: string;
  disabled: boolean;
  id: string;
  label: string;
  run: () => void | Promise<void>;
}>;

export type SkillCardView = Readonly<{
  actions: readonly SkillCardAction[];
  className: string;
  description: string;
  id: string;
  open: () => void;
  openContextMenu?: (x: number, y: number) => void;
  sourceLogo: SkillSourceLogo | null;
  sourceText: string;
  statusClass: string;
  statusLabel: string;
  title: string;
}>;

export type SkillsSnapshot = Readonly<{
  cards: readonly SkillCardView[];
  chips: readonly SkillChip[];
  emptyText: string;
  mode: "skills" | "mcp";
  modeTabs: readonly SkillModeTab[];
  pageDirection: number;
  revision: number;
}>;

type SkillsPatch = Partial<Omit<SkillsSnapshot, "revision">>;
type Listener = () => void;

let snapshot: SkillsSnapshot = Object.freeze({
  cards: [],
  chips: [],
  emptyText: "",
  mode: "skills",
  modeTabs: [],
  pageDirection: 0,
  revision: 0
});
const listeners = new Set<Listener>();

function publish(patch: SkillsPatch): void {
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

export function useSkills(): SkillsSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

declare global {
  interface Window {
    miaReactSkills?: {
      publish(patch: SkillsPatch): void;
    };
  }
}

window.miaReactSkills = { publish };
