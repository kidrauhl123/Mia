// 每个会话按类型解析头像 tile,对齐桌面/web:
//   bot    → bot 档案单头像
//   dm     → 对方用户头像
//   group  → 成员拼贴 mosaic(或群存储头像图)
import type { AvatarDescriptor, Conversation, Member } from "../api/types";
import { botDisplayTitle, botId, conversationType } from "./sessionHistory";
import { resolveAvatarForContact } from "./avatar";
import { resolveContact, ContactKind, botAvatarIdentityId, type ResolveCtx } from "./contact";
import { resolveGroupMemberTiles } from "./groupTiles";

export interface AvatarResolveCtx extends ResolveCtx {
  membersByConv?: Record<string, Member[]>;
}

function botGlobalIdFromConversation(c: Conversation, key: string): string {
  const id = String(c.id || "");
  if (!id.startsWith("botc_") || !key) return "";
  return id;
}

export function conversationAvatarTiles(c: Conversation, ctx: AvatarResolveCtx = {}): AvatarDescriptor[] {
  const type = conversationType(c);
  const members = ctx.membersByConv?.[c.id] || [];

  if (type === "bot") {
    const key = botId(c);
    const bot: any = (ctx.bots || []).find((item: any) => (item.id || item.botId || item.bot_id || item.key) === key);
    const botRecord = bot || {
      id: key,
      key,
      name: c.name || key,
      globalId: botGlobalIdFromConversation(c, key),
    };
    // 用与列表标题一致的 displayName(含 c.name 回退),色按 bot 身份哈希
    return [
      resolveAvatarForContact({
        id: botAvatarIdentityId(botRecord.globalId || botRecord.global_id || botRecord.key || botRecord.id || key, botRecord),
        displayName: botDisplayTitle(c, ctx.bots || []),
        avatarImage: botRecord.avatarImage || botRecord.avatar_image || "",
        avatarCrop: botRecord.avatarCrop || botRecord.avatar_crop || null,
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
