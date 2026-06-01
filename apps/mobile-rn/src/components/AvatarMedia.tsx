import { Image, View, Text, StyleSheet } from "react-native";
import type { AvatarDescriptor } from "../api/types";
import { isVideoAvatar, avatarCropGeometry } from "../logic/avatar";

// 单个头像渲染:套用裁剪参数(zoom/x/y)。圆形容器内裁剪定位,对齐桌面。
// - 无图 → 纯色 + 首字母
// - 图片 → 按 crop 缩放定位
// - 视频(动态头像)→ 暂回退为纯色 + 首字母(真实视频播放需带 expo-video 的原生构建)
export default function AvatarMedia({
  tile,
  size = 44,
  radius,
}: {
  tile: AvatarDescriptor;
  size?: number;
  radius?: number;
}) {
  const r = radius ?? size / 2;
  const image = String(tile.image || "").trim();
  const showImage = image && !isVideoAvatar(image);

  if (!showImage) {
    return (
      <View style={[styles.box, { width: size, height: size, borderRadius: r, backgroundColor: tile.color || "#5e5ce6" }]}>
        <Text style={[styles.letter, { fontSize: size * 0.4 }]}>{tile.text || "?"}</Text>
      </View>
    );
  }

  const g = avatarCropGeometry(size, tile.crop);
  return (
    <View style={[styles.box, { width: size, height: size, borderRadius: r, backgroundColor: tile.color || "#5e5ce6" }]}>
      <Image
        source={{ uri: image }}
        style={{ position: "absolute", width: g.inner, height: g.inner, left: g.left, top: g.top }}
        resizeMode="cover"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  letter: { color: "#fff", fontWeight: "600" },
});
