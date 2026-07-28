export type RendererView = "chat" | "contacts" | "bot-store" | "skills" | "tasks" | "settings";
export type PrimaryNavigation = "chat" | "explore" | "tasks" | "me";
export type SettingsTab = "account" | "appearance" | "memory" | "model";
export type TaskMode = "active" | "history";

export type RendererShellSnapshot = Readonly<{
  activeView: RendererView;
  activeSettingsTab: SettingsTab;
  chatUnread: number;
  contactsUnread: number;
  taskMode: TaskMode;
  tasksUnread: number;
  profileDialogOpen: boolean;
  revision: number;
}>;

type RendererShellSnapshotPatch = Partial<Omit<RendererShellSnapshot, "revision">>;
type RendererShellListener = () => void;

type RendererShellActions = {
  composerBlur: (event: FocusEvent) => void;
  composerClick: (event: MouseEvent) => void;
  composerCompositionEnd: (event: CompositionEvent) => void;
  composerCompositionStart: (event: CompositionEvent) => void;
  composerContextMenu: (event: MouseEvent) => void;
  composerInput: (event: InputEvent) => void;
  composerKeyDown: (event: KeyboardEvent) => void;
  composerPaste: (event: ClipboardEvent) => void;
  navigateView: (view: RendererView) => void;
  selectExploreView: (view: Extract<RendererView, "contacts" | "bot-store" | "skills">) => void;
  selectSettingsTab: (tab: SettingsTab) => void;
  selectTaskMode: (mode: TaskMode) => void;
  showPrimaryNavigation: (navigation: PrimaryNavigation) => void;
  openSettings: () => void;
};

export type MiaReactBridge = {
  getSnapshot: () => RendererShellSnapshot;
  invoke<K extends keyof RendererShellActions>(
    action: K,
    ...args: Parameters<RendererShellActions[K]>
  ): void;
  publish: (patch: RendererShellSnapshotPatch) => void;
  registerActions: (actions: Partial<RendererShellActions>) => void;
  subscribe: (listener: RendererShellListener) => () => void;
};

declare global {
  interface Window {
    miaReactBridge?: MiaReactBridge;
    miaReactRenderer?: {
      destroy(): void;
    };
  }
}

const listeners = new Set<RendererShellListener>();
let actions: Partial<RendererShellActions> = {};
let snapshot: RendererShellSnapshot = Object.freeze({
  activeView: "chat",
  activeSettingsTab: "account",
  chatUnread: 0,
  contactsUnread: 0,
  taskMode: "active",
  tasksUnread: 0,
  profileDialogOpen: false,
  revision: 0
});

function boundedCount(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.floor(number));
}

function normalizePatch(patch: RendererShellSnapshotPatch): RendererShellSnapshotPatch {
  return {
    ...patch,
    ...(patch.chatUnread === undefined ? {} : { chatUnread: boundedCount(patch.chatUnread) }),
    ...(patch.contactsUnread === undefined ? {} : { contactsUnread: boundedCount(patch.contactsUnread) }),
    ...(patch.tasksUnread === undefined ? {} : { tasksUnread: boundedCount(patch.tasksUnread) })
  };
}

function publish(patch: RendererShellSnapshotPatch): void {
  const normalized = normalizePatch(patch);
  const changed = Object.entries(normalized).some(
    ([key, value]) => snapshot[key as keyof RendererShellSnapshot] !== value
  );
  if (!changed) return;
  snapshot = Object.freeze({
    ...snapshot,
    ...normalized,
    revision: snapshot.revision + 1
  });
  for (const listener of [...listeners]) listener();
}

const bridge: MiaReactBridge = {
  getSnapshot: () => snapshot,
  invoke(action, ...args) {
    const handler = actions[action];
    if (typeof handler !== "function") return;
    (handler as (...values: unknown[]) => void)(...args);
  },
  publish,
  registerActions(nextActions) {
    actions = { ...actions, ...nextActions };
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
};

window.miaReactBridge = bridge;

export { bridge };
