import type { AvatarDescriptor } from "../api/types";

export const DEFAULT_AVATAR_CROP = { x: 50, y: 50, zoom: 1 };
export const DEFAULT_AVATAR_COLOR = "#5e5ce6";
export const PALETTE = Object.freeze([
  "#e17076",
  "#f0a574",
  "#b08fd8",
  "#7bc862",
  "#65aadd",
  "#ee7aae",
  "#6ec9cb",
]);

function hashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function memberAccentColor(id: string): string {
  const key = String(id || "").trim();
  if (!key) return PALETTE[0];
  return PALETTE[hashCode(key) % PALETTE.length];
}

function normalizedPathForLegacyMatch(src: string): string {
  let value = String(src || "").trim();
  if (!value) return "";
  value = value.replace(/\\/g, "/");
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      value = new URL(value).pathname || value;
    }
  } catch {
    // Keep the raw value for prefix checks below.
  }
  value = value.replace(/^file:\/+/i, "/");
  value = value.replace(/^app:\/+/i, "/");
  value = value.replace(/^(\.\/)+/, "");
  value = value.replace(/^\/+/, "");
  return value;
}

export function isLegacyPresetAvatarSrc(src: string): boolean {
  const value = normalizedPathForLegacyMatch(src);
  return /(^|\/)assets\/(avatars|avatars-pet|avatar-thumbs|avatar-thumbs-pet|avatar-icons)\/\d{2}\.png$/i.test(value);
}

export function normalizeAvatarImage(src: string): string {
  const value = String(src || "").trim();
  if (!value) return "";
  return isLegacyPresetAvatarSrc(value) ? "" : value;
}

export function identityDisplayText(displayName: string, fallback = "?"): string {
  return Array.from(String(displayName || fallback || "").trim()).slice(0, 2).join("") || "?";
}

// 与 shared/avatar-media.js 一致:按扩展名 / data:video 判定动态头像(视频)。
const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|ogv|ogg)(?:[?#].*)?$/i;
export function isVideoAvatar(src: string): boolean {
  const s = String(src || "").trim();
  if (!s) return false;
  return /^data:video\//i.test(s) || VIDEO_EXT_RE.test(s);
}

// 裁剪几何(对齐桌面 background-size:zoom*100% + background-position:x% y%):
// 在 size×size 圆形容器内,内层图尺寸 = size*zoom,按 x/y% 定位。
export function avatarCropGeometry(size: number, crop?: Record<string, unknown> | null) {
  const c = (crop || {}) as { x?: number; y?: number; zoom?: number };
  const x = Number.isFinite(Number(c.x)) ? Number(c.x) : 50;
  const y = Number.isFinite(Number(c.y)) ? Number(c.y) : 50;
  const zoom = Number.isFinite(Number(c.zoom)) ? Number(c.zoom) : 1;
  const inner = Math.round(size * zoom);
  return { inner, left: (size - inner) * (x / 100), top: (size - inner) * (y / 100) };
}

export function avatarCropForImage(image: string, crop: Record<string, unknown> | null = null): Record<string, unknown> | null {
  return normalizeAvatarImage(image) ? (crop || { ...DEFAULT_AVATAR_CROP }) : null;
}

export function resolveAvatarForContact(input: {
  id?: string;
  displayName?: string;
  avatarImage?: string;
  avatarCrop?: Record<string, unknown> | null;
} = {}): AvatarDescriptor {
  const id = String(input.id || "");
  const image = normalizeAvatarImage(input.avatarImage || "");
  return {
    image,
    crop: avatarCropForImage(image, input.avatarCrop || null),
    color: id ? memberAccentColor(id) : DEFAULT_AVATAR_COLOR,
    text: identityDisplayText(input.displayName || "", id),
  };
}

export function normalizeAvatarDescriptor(title: string, avatar?: Partial<AvatarDescriptor>): AvatarDescriptor {
  const image = normalizeAvatarImage(avatar?.image || "");
  return {
    image,
    crop: avatarCropForImage(image, avatar?.crop || null),
    color: avatar?.color || DEFAULT_AVATAR_COLOR,
    text: avatar?.text || identityDisplayText(title, "?"),
  };
}

export function resolveAvatar(id: string, displayName: string, image = "", crop: Record<string, unknown> | null = null): AvatarDescriptor {
  return resolveAvatarForContact({ id, displayName, avatarImage: image, avatarCrop: crop });
}
