import type { AvatarDescriptor } from "./avatar";

export const IdentityKind: {
  readonly User: "user";
  readonly Bot: "bot";
};

export type IdentityKindT = (typeof IdentityKind)[keyof typeof IdentityKind];

export interface SelfRecord {
  id?: string;
  username?: string;
  account?: string;
  displayName?: string;
  avatarText?: string;
  avatarImage?: string;
  avatar_image?: string;
  avatarCrop?: Record<string, unknown> | null;
  avatar_crop?: Record<string, unknown> | null;
  avatarColor?: string;
  avatar_color?: string;
  color?: string;
}

export interface BotRecord {
  id?: string;
  key?: string;
  botId?: string;
  bot_id?: string;
  member_ref?: string;
  ownerUserId?: string;
  owner_user_id?: string;
  ownerId?: string;
  owner_id?: string;
  name?: string;
  displayName?: string;
  display_name?: string;
  username?: string;
  avatarImage?: string;
  avatar_image?: string;
  avatarCrop?: Record<string, unknown> | null;
  avatar_crop?: Record<string, unknown> | null;
  avatarColor?: string;
  avatar_color?: string;
  color?: string;
}

export interface FriendRecord {
  id?: string;
  username?: string;
  account?: string;
  displayName?: string;
  avatarImage?: string;
  avatar_image?: string;
  avatarCrop?: Record<string, unknown> | null;
  avatar_crop?: Record<string, unknown> | null;
  avatarColor?: string;
  avatar_color?: string;
  color?: string;
}

export interface ResolveCtx {
  self?: SelfRecord;
  bots?: BotRecord[];
  friends?: FriendRecord[];
}

export interface ResolvedContact {
  kind: string;
  id: string;
  ownerUserId?: string;
  displayName: string;
  avatar: AvatarDescriptor;
}

export function resolveContact(query: { kind: IdentityKindT | "self"; ref?: string }, ctx?: ResolveCtx): ResolvedContact;
export function avatarForRecord(id: string, record?: Record<string, unknown>, displayName?: string): AvatarDescriptor;
export function avatarForBotRecord(id: string, record?: Record<string, unknown>, displayName?: string): AvatarDescriptor;
export function botAvatarIdentityId(id?: string, record?: Record<string, unknown>): string;
