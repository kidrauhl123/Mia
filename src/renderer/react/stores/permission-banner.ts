import { flushSync } from "react-dom";
import { useSyncExternalStore } from "react";
import { measureReactCommit } from "../performance";

export type PermissionDecision = "allow_always" | "allow_once" | "deny";

export type PermissionBannerPayload = Readonly<{
  decide: (decision: PermissionDecision) => void;
  description: string;
  kicker: string;
  pending: boolean;
  preview: string;
  requestId: string;
  title: string;
  visible: boolean;
}>;

type PermissionBannerSnapshot = PermissionBannerPayload & Readonly<{
  fingerprint: string;
  revision: number;
}>;

type Listener = () => void;

const listeners = new Set<Listener>();
const noop = () => {};
let snapshot: PermissionBannerSnapshot = Object.freeze({
  decide: noop,
  description: "",
  fingerprint: "",
  kicker: "",
  pending: false,
  preview: "",
  requestId: "",
  revision: 0,
  title: "",
  visible: false
});

function publish(payload: PermissionBannerPayload): void {
  const fingerprint = JSON.stringify({
    description: payload.description,
    kicker: payload.kicker,
    pending: payload.pending,
    preview: payload.preview,
    requestId: payload.requestId,
    title: payload.title,
    visible: payload.visible
  });
  if (fingerprint === snapshot.fingerprint) {
    snapshot = Object.freeze({ ...snapshot, decide: payload.decide });
    return;
  }
  measureReactCommit("react.commit.permissionBanner", () => flushSync(() => {
    snapshot = Object.freeze({
      ...payload,
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

function usePermissionBanner(): PermissionBannerSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

declare global {
  interface Window {
    miaReactPermissionBanner?: {
      publish(payload: PermissionBannerPayload): void;
    };
  }
}

window.miaReactPermissionBanner = { publish };

export { usePermissionBanner };
