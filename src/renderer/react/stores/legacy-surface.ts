import { flushSync } from "react-dom";
import { useSyncExternalStore } from "react";
import { measureReactCommit } from "../performance";

export type LegacyHtmlEntry = Readonly<{
  key: string;
  signature: string;
  source: Element;
  tagName: string;
}>;

type LegacySurfaceSnapshot = Readonly<{
  entries: readonly LegacyHtmlEntry[];
  fingerprint: string;
  mode: "empty" | "html" | "nodes";
  nodes: readonly Node[];
  revision: number;
}>;

type Listener = () => void;
type SurfaceTarget = string | HTMLElement;

const listenersById = new Map<string, Set<Listener>>();
const snapshotsById = new Map<string, LegacySurfaceSnapshot>();

function emptySnapshot(): LegacySurfaceSnapshot {
  return Object.freeze({
    entries: Object.freeze([]),
    fingerprint: "",
    mode: "empty",
    nodes: Object.freeze([]),
    revision: 0
  });
}

function ensureSnapshot(id: string): LegacySurfaceSnapshot {
  let snapshot = snapshotsById.get(id);
  if (!snapshot) {
    snapshot = emptySnapshot();
    snapshotsById.set(id, snapshot);
  }
  return snapshot;
}

function surfaceId(target: SurfaceTarget): string {
  if (typeof target === "string") return target;
  return String(target?.id || "");
}

function notify(id: string): void {
  for (const listener of [...(listenersById.get(id) || [])]) listener();
}

function publish(id: string, next: Omit<LegacySurfaceSnapshot, "revision">): boolean {
  if (!id) return false;
  const previous = ensureSnapshot(id);
  if (previous.fingerprint === next.fingerprint && previous.mode === next.mode) return false;
  const commit = () => {
    snapshotsById.set(id, Object.freeze({
      ...next,
      entries: Object.freeze([...next.entries]),
      nodes: Object.freeze([...next.nodes]),
      revision: previous.revision + 1
    }));
    notify(id);
  };
  measureReactCommit("react.commit.surface", () => flushSync(commit));
  return true;
}

function entryKey(source: Element, index: number, fingerprint: string): string {
  const element = source as HTMLElement;
  const identity = [
    source.id,
    element.dataset?.taskId,
    element.dataset?.skillId,
    element.dataset?.botId,
    element.dataset?.mode,
    element.dataset?.historyFilter,
    element.dataset?.category
  ].find(Boolean);
  // Include the surface fingerprint so legacy event bindings are never
  // retained across a legacy rebind pass.
  return `${fingerprint}:${identity || source.tagName.toLowerCase()}:${index}`;
}

function htmlEntries(html: string, fingerprint: string): LegacyHtmlEntry[] {
  const template = document.createElement("template");
  template.innerHTML = html;
  const entries: LegacyHtmlEntry[] = [];
  let elementIndex = 0;
  for (const child of Array.from(template.content.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && !String(child.textContent || "").trim()) continue;
    let source: Element;
    if (child.nodeType === Node.ELEMENT_NODE) {
      source = child as Element;
    } else {
      const span = document.createElement("span");
      span.textContent = child.textContent || "";
      source = span;
    }
    entries.push(Object.freeze({
      key: entryKey(source, elementIndex, fingerprint),
      signature: source.outerHTML,
      source,
      tagName: source.tagName.toLowerCase()
    }));
    elementIndex += 1;
  }
  return entries;
}

function renderHtml(target: SurfaceTarget, htmlValue: unknown, signature?: unknown): boolean {
  const id = surfaceId(target);
  const html = String(htmlValue || "");
  const fingerprint = `html:${String(signature ?? html)}`;
  if (ensureSnapshot(id).fingerprint === fingerprint) return false;
  return publish(id, {
    entries: htmlEntries(html, fingerprint),
    fingerprint,
    mode: html ? "html" : "empty",
    nodes: Object.freeze([])
  });
}

function renderNodes(target: SurfaceTarget, nodeValues: Iterable<Node>, signature: unknown): boolean {
  const id = surfaceId(target);
  const fingerprint = `nodes:${String(signature ?? "")}`;
  if (ensureSnapshot(id).fingerprint === fingerprint) return false;
  const nodes = Array.from(nodeValues || []).filter((node): node is Node => node instanceof Node);
  return publish(id, {
    entries: Object.freeze([]),
    fingerprint,
    mode: nodes.length ? "nodes" : "empty",
    nodes
  });
}

function clear(target: SurfaceTarget, signature = "clear"): boolean {
  const id = surfaceId(target);
  return publish(id, {
    entries: Object.freeze([]),
    fingerprint: `empty:${String(signature)}`,
    mode: "empty",
    nodes: Object.freeze([])
  });
}

function subscribe(id: string, listener: Listener): () => void {
  let listeners = listenersById.get(id);
  if (!listeners) {
    listeners = new Set();
    listenersById.set(id, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (!listeners?.size) listenersById.delete(id);
  };
}

function useLegacySurface(id: string): LegacySurfaceSnapshot {
  return useSyncExternalStore(
    (listener) => subscribe(id, listener),
    () => ensureSnapshot(id),
    () => ensureSnapshot(id)
  );
}

export type MiaReactSurface = {
  clear(target: SurfaceTarget, signature?: unknown): boolean;
  renderHtml(target: SurfaceTarget, html: unknown, signature?: unknown): boolean;
  renderNodes(target: SurfaceTarget, nodes: Iterable<Node>, signature: unknown): boolean;
};

declare global {
  interface Window {
    miaReactSurface?: MiaReactSurface;
  }
}

window.miaReactSurface = { clear, renderHtml, renderNodes };

export { useLegacySurface };
