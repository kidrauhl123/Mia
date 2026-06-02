export interface AvatarDescriptor {
  image: string;
  crop: Record<string, unknown> | null;
  color: string;
  text: string;
}

export interface AvatarContactInput {
  id?: string;
  displayName?: string;
  avatarImage?: string;
  avatarCrop?: Record<string, unknown> | null;
}

export interface AvatarTrim {
  start: number;
  duration: number;
}

export const AVATAR_MIN_ZOOM: number;
export const DEFAULT_AVATAR_CROP: { x: number; y: number; zoom: number };
export const DEFAULT_PRESET_AVATAR_CROP: { x: number; y: number; zoom: number };
export const DEFAULT_AVATAR_COLOR: string;
export const PALETTE: readonly string[];
export const MAX_TRIM_DURATION: number;
export const MIN_TRIM_DURATION: number;
export const DEFAULT_TRIM_DURATION: number;
export const avatarPresetGroupTabs: readonly unknown[];
export const avatarPresetGroups: { human: readonly unknown[]; pet: readonly unknown[] };
export const avatarPresets: readonly unknown[];

export function memberAccentColor(id: string): string;
export function mediaKind(value?: string): "" | "video" | "gif" | "image";
export function isVideo(value?: string): boolean;
export function isGif(value?: string): boolean;
export function normalizeTrim(trim?: Record<string, unknown> | null): AvatarTrim;
export function trimFromCrop(crop?: Record<string, unknown> | null): AvatarTrim;
export function cropWithTrim(crop?: Record<string, unknown> | null, trim?: Record<string, unknown> | null): Record<string, unknown> & AvatarTrim;
export function isLegacyPresetAvatarSrc(src: string): boolean;
export function normalizeAvatarImage(src: string): string;
export function hasAvatarIdentityFields(record: unknown): boolean;
export function identityDisplayText(displayName: string, fallback?: string): string;
export function canonicalAvatarSrc(src: string): string;
export function avatarPresetBySrc(src: string): null;
export function avatarPresetGroupForSrc(src: string): string;
export function avatarThumbForSrc(src: string): string;
export function avatarDefaultCropForSrc(src: string): Record<string, unknown>;
export function normalizeAvatarCrop(crop?: Record<string, unknown> | null): Record<string, unknown>;
export function isNeutralAvatarCrop(crop?: Record<string, unknown> | null): boolean;
export function avatarCropForImage(image: string, crop?: Record<string, unknown> | null): Record<string, unknown> | null;
export function resolveAvatarForContact(input?: AvatarContactInput): AvatarDescriptor;
export function isVideoAvatar(src: string): boolean;
export function avatarCropGeometry(size: number, crop?: Record<string, unknown> | null): { inner: number; left: number; top: number };
export function normalizeAvatarDescriptor(title: string, avatar?: Partial<AvatarDescriptor>): AvatarDescriptor;
export function resolveAvatar(id: string, displayName: string, image?: string, crop?: Record<string, unknown> | null): AvatarDescriptor;
