import type { ChatMessage, Identity, Member, StatusBadge } from "../api/types";

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function statusBadgeFrom(...sources: any[]): StatusBadge | null | undefined {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    if (Object.prototype.hasOwnProperty.call(source, "statusBadge")) return source.statusBadge;
    if (Object.prototype.hasOwnProperty.call(source, "status_badge")) return source.status_badge;
  }
  return undefined;
}

export interface MessageAuthor {
  name: string;
  identity?: Identity | null;
  statusBadge?: StatusBadge | null;
}

export function resolveMessageAuthor(msg: ChatMessage, members: Member[] = []): MessageAuthor {
  const senderKind = String(msg.senderKind || "");
  const senderRef = String(msg.senderRef || "");
  const member: any = members.find((item: any) => String(item.member_kind || "") === senderKind && String(item.member_ref || "") === senderRef) || null;
  const identity: any = member?.identity || {};
  const name = firstNonEmpty(
    msg.authorName,
    identity.displayName,
    identity.display_name,
    member?.displayName,
    member?.display_name,
    member?.bot_name,
    member?.username,
    senderRef
  );
  return {
    name,
    identity: member?.identity || null,
    statusBadge: statusBadgeFrom(msg, identity, member) || null
  };
}
