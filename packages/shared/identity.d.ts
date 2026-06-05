import type { AvatarDescriptor } from "./avatar";

export const IdentityKind: {
  readonly User: "user";
  readonly Bot: "bot";
};

export type IdentityKindT = (typeof IdentityKind)[keyof typeof IdentityKind];

export type StatusBadge =
  | { kind: "emoji"; emoji: string; label?: string }
  | { kind: "lottie"; assetId: string; label?: string; loop?: "limited" | "always" | string }
  | { kind: "gift"; assetId: string; label?: string; collectibleId?: string };

export type Identity = {
  kind: IdentityKindT;
  id: string;
  displayName: string;
  avatar?: AvatarDescriptor;
  statusBadge?: StatusBadge | null;
  ownerUserId?: string;
};

export function normalizeStatusBadge(input: unknown): StatusBadge | null;
export function normalizeIdentity(input?: unknown): Identity | null;
export function identityKey(identity?: unknown): string;
