import type { AvatarDescriptor } from "./avatar";

export const ContactKind: {
  readonly Self: "self";
  readonly Fellow: "fellow";
  readonly User: "user";
};

export type ContactKindT = (typeof ContactKind)[keyof typeof ContactKind];

export interface SelfRecord {
  id?: string;
  username?: string;
  account?: string;
  displayName?: string;
  avatarText?: string;
  avatarImage?: string;
  avatarCrop?: Record<string, unknown> | null;
}

export interface FellowRecord {
  id?: string;
  key?: string;
  fellowId?: string;
  fellow_id?: string;
  member_ref?: string;
  globalId?: string;
  global_id?: string;
  fellowGlobalId?: string;
  fellow_global_id?: string;
  ownerUserId?: string;
  owner_user_id?: string;
  ownerId?: string;
  owner_id?: string;
  name?: string;
  displayName?: string;
  avatarImage?: string;
  avatarCrop?: Record<string, unknown> | null;
}

export interface FriendRecord {
  id?: string;
  username?: string;
  account?: string;
  displayName?: string;
  avatarImage?: string;
  avatarCrop?: Record<string, unknown> | null;
}

export interface ResolveCtx {
  self?: SelfRecord;
  fellows?: FellowRecord[];
  friends?: FriendRecord[];
}

export interface ResolvedContact {
  kind: string;
  id: string;
  displayName: string;
  avatar: AvatarDescriptor;
}

export function resolveContact(query: { kind: ContactKindT; ref?: string }, ctx?: ResolveCtx): ResolvedContact;
export function avatarForRecord(id: string, record?: Record<string, unknown>, displayName?: string): AvatarDescriptor;
export function avatarForFellowRecord(id: string, record?: Record<string, unknown>, displayName?: string): AvatarDescriptor;
export function fellowAvatarIdentityId(id?: string, record?: Record<string, unknown>): string;
