import type { AvatarDescriptor } from "../api/types";
import { normalizeAvatarDescriptor } from "../logic/avatar";
import AvatarMedia from "./AvatarMedia";

// 单联系人头像(圆形 + 裁剪 + 身份色 + 首字母)。
export default function Avatar({ title, avatar, size = 44 }: { title: string; avatar?: AvatarDescriptor; size?: number }) {
  const resolved = normalizeAvatarDescriptor(title, avatar);
  return <AvatarMedia tile={resolved} size={size} />;
}
