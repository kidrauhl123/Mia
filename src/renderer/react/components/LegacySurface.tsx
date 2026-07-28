import {
  createElement,
  memo,
  useLayoutEffect,
  useRef
} from "react";
import {
  type LegacyHtmlEntry,
  useLegacySurface
} from "../stores/legacy-surface";

function adoptElement(target: Element, source: Element): void {
  for (const attribute of Array.from(target.attributes)) {
    target.removeAttribute(attribute.name);
  }
  for (const attribute of Array.from(source.attributes)) {
    target.setAttribute(attribute.name, attribute.value);
  }
  target.replaceChildren(...Array.from(source.childNodes));
}

const LegacyHtmlNode = memo(function LegacyHtmlNode({ entry }: { entry: LegacyHtmlEntry }) {
  const hostRef = useRef<Element | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    adoptElement(host, entry.source);
  }, [entry.signature, entry.source]);

  return createElement(entry.tagName, {
    ref: (element: Element | null) => {
      hostRef.current = element;
    }
  });
});

function LegacyNodeHost({ nodes }: { nodes: readonly Node[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    hostRef.current?.replaceChildren(...nodes);
  }, [nodes]);
  return <div className="react-legacy-node-host" ref={hostRef} />;
}

export function LegacySurface({ id }: { id: string }) {
  const snapshot = useLegacySurface(id);
  if (snapshot.mode === "nodes") return <LegacyNodeHost nodes={snapshot.nodes} />;
  if (snapshot.mode !== "html") return null;
  return (
    <>
      {snapshot.entries.map((entry) => (
        <LegacyHtmlNode key={entry.key} entry={entry} />
      ))}
    </>
  );
}
