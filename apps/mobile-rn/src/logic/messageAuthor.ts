import type { AvatarDescriptor, ChatMessage, Identity, Member, StatusBadge } from "../api/types";
import { identityDisplayText, resolveAvatarForContact, memberAccentColor } from "./avatar";
import { botAvatarIdentityId } from "./contact";

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
  avatar: AvatarDescriptor;
  color: string;
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
  const identityAvatar = identity.avatar || {};
  const explicitColor = firstNonEmpty(
    identityAvatar.color,
    member?.bot_color,
    member?.avatarColor,
    member?.avatar_color
  );
  const color = explicitColor || memberAccentColor(senderRef || name);
  const avatar = (identityAvatar.image || identityAvatar.color || identityAvatar.text)
    ? {
        image: identityAvatar.image || "",
        crop: identityAvatar.crop || null,
        color: identityAvatar.color || color,
        text: identityAvatar.text || identityDisplayText(name, senderRef || "?"),
      }
    : resolveAvatarForContact({
        id: senderKind === "bot" ? botAvatarIdentityId(senderRef, { ...member, id: identity.id || senderRef, member_ref: senderRef }) : identity.id || senderRef,
        displayName: name,
        avatarImage: member?.bot_avatar_image || "",
        avatarCrop: member?.bot_avatar_crop || null,
        color,
      });
  return {
    name,
    identity: member?.identity || null,
    statusBadge: statusBadgeFrom(msg, identity, member) || null,
    avatar,
    color: avatar.color || color,
  };
}
