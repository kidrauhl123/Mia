import { useSyncExternalStore } from "react";

export type ConnectedProviderView = Readonly<{
  id: string;
  label: string;
  logoSrc: string;
}>;

export type EngineActionView = Readonly<{
  action: string;
  disabled: boolean;
  engineId: string;
  label: string;
  progress: number | null;
}>;

export type MobileQrView = Readonly<{
  imageUrl: string;
  loginUrl: string;
  status: string;
}>;

export type SettingsCompatSnapshot = Readonly<{
  engineActions: Readonly<Record<string, EngineActionView | null>>;
  mobileQr: MobileQrView;
  providers: readonly ConnectedProviderView[];
  revision: number;
}>;

type SettingsCompatPatch = Partial<Omit<SettingsCompatSnapshot, "revision">>;
type Listener = () => void;

let snapshot: SettingsCompatSnapshot = Object.freeze({
  engineActions: {},
  mobileQr: { imageUrl: "", loginUrl: "", status: "" },
  providers: [],
  revision: 0
});
const listeners = new Set<Listener>();

function publish(patch: SettingsCompatPatch): void {
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

export function useSettingsCompat(): SettingsCompatSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

declare global {
  interface Window {
    miaReactSettingsCompat?: {
      publish(patch: SettingsCompatPatch): void;
    };
  }
}

window.miaReactSettingsCompat = { publish };
