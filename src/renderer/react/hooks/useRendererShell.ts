import { useSyncExternalStore } from "react";
import { bridge, type RendererShellSnapshot } from "../bridge";

export function useRendererShell(): RendererShellSnapshot {
  return useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);
}
