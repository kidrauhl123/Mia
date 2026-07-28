import { memo, useLayoutEffect, useRef } from "react";
import {
  type ConversationListEntry,
  useConversationList
} from "../stores/conversation-list";

const LegacyConversationCard = memo(function LegacyConversationCard({
  createCard,
  entry
}: {
  createCard: (spec: Record<string, unknown>) => HTMLElement;
  entry: ConversationListEntry;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const card = createCard(entry.spec);
    host.replaceChildren(card);
  }, [createCard, entry.signature]);

  useLayoutEffect(() => {
    hostRef.current?.querySelector(".persona.message-card")?.classList.toggle("active", entry.active);
  }, [entry.active]);

  return <div className="react-conversation-card-host" ref={hostRef} />;
}, (previous, next) => (
  previous.createCard === next.createCard
    && previous.entry.active === next.entry.active
    && previous.entry.signature === next.entry.signature
));

function GroupedConversationList() {
  const snapshot = useConversationList();
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    snapshot.renderGrouped?.({
      root: host,
      specs: snapshot.entries.map((entry) => entry.spec),
      createCard: snapshot.createCard
    });
  }, [snapshot]);

  return <div className="react-conversation-group-host" ref={hostRef} />;
}

export function ConversationList() {
  const snapshot = useConversationList();
  if (snapshot.grouped) return <GroupedConversationList />;
  if (!snapshot.entries.length && snapshot.emptyText) {
    return <div className="persona-empty">{snapshot.emptyText}</div>;
  }
  return (
    <>
      {snapshot.entries.map((entry) => (
        <LegacyConversationCard
          key={entry.key}
          createCard={snapshot.createCard}
          entry={entry}
        />
      ))}
    </>
  );
}
