// 每个会话按类型解析头像 tile,对齐桌面/web:
//   fellow → fellow 档案单头像
//   dm     → 对方用户头像
//   group  → 成员拼贴 mosaic(或群存储头像图)
import type { AvatarDescriptor, Conversation, Member } from "../api/types";
import { conversationType, fellowKey, fellowDisplayTitle } from "./sessionHistory";
import { resolveAvatarForContact } from "./avatar";
import { resolveContact, ContactKind, fellowAvatarIdentityId, type ResolveCtx } from "./contact";
import { resolveGroupMemberTiles } from "./groupTiles";

export interface AvatarResolveCtx extends ResolveCtx {
  membersByConv?: Record<string, Member[]>;
}

function fellowGlobalIdFromConversation(c: Conversation, key: string): string {
  const id = String(c.id || "");
  if (!id.startsWith("fellow:") || !key) return "";
  return id.split(":").slice(2).join(":") === key ? id : "";
}

export function conversationAvatarTiles(c: Conversation, ctx: AvatarResolveCtx = {}): AvatarDescriptor[] {
  const type = conversationType(c);
  const members = ctx.membersByConv?.[c.id] || [];

  if (type === "fellow") {
    const key = fellowKey(c);
    const fellow: any = (ctx.fellows || []).find((f) => (f.id || f.key) === key);
    const fellowRecord = fellow || {
      id: key,
      key,
      name: c.name || key,
      globalId: fellowGlobalIdFromConversation(c, key),
    };
    // 用与列表标题一致的 displayName(含 c.name 回退),色按 fellow 身份哈希
    return [
      resolveAvatarForContact({
        id: fellowAvatarIdentityId(fellowRecord.key || fellowRecord.id || key, fellowRecord),
        displayName: fellowDisplayTitle(c, ctx.fellows || []),
        avatarImage: fellowRecord.avatarImage || "",
        avatarCrop: fellowRecord.avatarCrop || null,
      }),
    ];
  }

  if (type === "dm") {
    const peer = members.find((m: any) => m.member_kind === "user" && m.member_ref !== ctx.self?.id);
    if (peer) return [resolveContact({ kind: ContactKind.User, ref: (peer as any).member_ref }, ctx).avatar];
    return [resolveAvatarForContact({ id: c.id, displayName: c.name || c.id, avatarImage: c.avatar || "" })];
  }

  if (type === "group") {
    if (c.avatar) return [resolveAvatarForContact({ id: c.id, displayName: c.name || c.id, avatarImage: c.avatar })];
    const tiles = resolveGroupMemberTiles(members as any, ctx);
    if (tiles.length) return tiles.slice(0, 4);
    return [resolveAvatarForContact({ id: c.id, displayName: c.name || c.id })];
  }

  return [resolveAvatarForContact({ id: c.id, displayName: c.name || c.id, avatarImage: c.avatar || "" })];
}
