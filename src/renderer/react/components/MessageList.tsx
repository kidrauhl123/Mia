import {
  createElement,
  memo,
  useLayoutEffect,
  useRef
} from "react";
import {
  type MessageListEntry,
  useMessageList
} from "../stores/message-list";

function adoptLegacyElement(host: HTMLElement, source: HTMLElement): void {
  for (const attribute of [...host.attributes]) host.removeAttribute(attribute.name);
  for (const attribute of [...source.attributes]) host.setAttribute(attribute.name, attribute.value);
  host.replaceChildren(...source.childNodes);
}

const MessageNode = memo(function MessageNode({ entry }: { entry: MessageListEntry }) {
  const hostRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const source = entry.build();
    if (!source) {
      host.replaceChildren();
      host.hidden = true;
      return;
    }
    adoptLegacyElement(host, source);
    host.dataset.reactMessageKey = entry.key;
    entry.mounted?.(host);
  }, [entry.signature]);

  return createElement(entry.tag, {
    "data-react-message-key": entry.key,
    ref: hostRef
  });
}, (previous, next) => (
  previous.entry.key === next.entry.key
    && previous.entry.signature === next.entry.signature
    && previous.entry.tag === next.entry.tag
));

export function MessageList() {
  const snapshot = useMessageList();
  if (snapshot.mode === "html") {
    return (
      <div
        className="react-chat-html-host"
        dangerouslySetInnerHTML={{ __html: snapshot.html }}
      />
    );
  }
  if (snapshot.mode !== "messages") return null;
  return (
    <>
      {snapshot.entries.map((entry) => <MessageNode key={entry.key} entry={entry} />)}
    </>
  );
}
