import type { StatusBadge } from "../api/types";

type AnyRecord = Record<string, any> | null | undefined;

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function statusBadgeFrom(source: AnyRecord): StatusBadge | null {
  if (!source || typeof source !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(source, "statusBadge")) return source.statusBadge || null;
  if (Object.prototype.hasOwnProperty.call(source, "status_badge")) return source.status_badge || null;
  return null;
}

export function resolveMeProfile(user: AnyRecord, sessionUser: AnyRecord) {
  const uid = firstText(user?.id, user?.userId, user?.user_id, sessionUser?.id, sessionUser?.userId, sessionUser?.user_id);
  const displayName = firstText(
    user?.displayName,
    user?.display_name,
    user?.name,
    user?.nickname,
    user?.username,
    sessionUser?.displayName,
    sessionUser?.display_name,
    sessionUser?.name,
    sessionUser?.username,
    "未登录"
  );
  return {
    uid,
    displayName,
    username: firstText(user?.username, sessionUser?.username),
    avatarImage: firstText(user?.avatarImage, user?.avatar_image, sessionUser?.avatarImage, sessionUser?.avatar_image),
    avatarCrop: user?.avatarCrop ?? user?.avatar_crop ?? sessionUser?.avatarCrop ?? sessionUser?.avatar_crop ?? null,
    statusBadge: statusBadgeFrom(user) || statusBadgeFrom(sessionUser),
  };
}
