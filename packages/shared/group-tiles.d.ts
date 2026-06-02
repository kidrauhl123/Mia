import type { AvatarDescriptor } from "./avatar";
import type { FellowRecord, FriendRecord, SelfRecord } from "./contact";

export interface MemberRow {
  member_kind?: string;
  member_ref?: string;
  owner_id?: string;
  owner_user_id?: string;
  fellow_name?: string;
  fellow_avatar_image?: string;
  fellow_avatar_crop?: Record<string, unknown> | null;
  identity?: {
    globalId?: string;
    global_id?: string;
    ownerUserId?: string;
    owner_id?: string;
    avatar?: { image?: string; crop?: Record<string, unknown> | null };
    displayName?: string;
  };
}

export interface GroupTileCtx {
  self?: SelfRecord;
  friends?: FriendRecord[];
  fellows?: FellowRecord[];
}

export function resolveGroupMemberTiles(members: MemberRow[], ctx?: GroupTileCtx): AvatarDescriptor[];
export function localGroupAsMembers(group: { members?: Array<{ fellowId?: string }> } | null | undefined, selfId?: string): MemberRow[];
