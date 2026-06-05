import type { AvatarDescriptor } from "./avatar";
import type { BotRecord, FriendRecord, SelfRecord } from "./contact";

export interface MemberRow {
  member_kind?: string;
  member_ref?: string;
  owner_id?: string;
  owner_user_id?: string;
  bot_name?: string;
  bot_avatar_image?: string;
  bot_avatar_crop?: Record<string, unknown> | null;
  identity?: {
    botId?: string;
    bot_id?: string;
    ownerUserId?: string;
    owner_id?: string;
    avatar?: { image?: string; crop?: Record<string, unknown> | null };
    displayName?: string;
  };
}

export interface GroupTileCtx {
  self?: SelfRecord;
  friends?: FriendRecord[];
  bots?: BotRecord[];
}

export function resolveGroupMemberTiles(members: MemberRow[], ctx?: GroupTileCtx): AvatarDescriptor[];
export function localGroupAsMembers(group: { members?: Array<{ botId?: string }> } | null | undefined, selfId?: string): MemberRow[];
