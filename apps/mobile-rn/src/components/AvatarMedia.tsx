import { Image, View, Text, StyleSheet } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import type { AvatarDescriptor } from "../api/types";
import { isEmojiAvatar, isVideoAvatar, emojiAvatarGlyph, avatarCropGeometry } from "../logic/avatar";
import { withAndroidTextFace } from "../ui/androidTextFace";
import { useTypography } from "../ui/TypographyProvider";

// 动态头像(视频):静音循环播放,套用同样的裁剪几何。
function VideoAvatar({ uri, size, radius, crop, color }: { uri: string; size: number; radius: number; crop: any; color: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  const g = avatarCropGeometry(size, crop);
  return (
    <View style={[styles.box, { width: size, height: size, borderRadius: radius, backgroundColor: color }]}>
      <VideoView
        player={player}
        contentFit="cover"
        nativeControls={false}
        style={{ position: "absolute", width: g.inner, height: g.inner, left: g.left, top: g.top }}
      />
    </View>
  );
}

// 单个头像渲染,套用裁剪参数(zoom/x/y)。无图→纯色+首字母;图→裁剪;视频→播放。
export default function AvatarMedia({ tile, size = 44, radius }: { tile: AvatarDescriptor; size?: number; radius?: number }) {
  const typography = useTypography();
  const r = radius ?? size / 2;
  const image = String(tile.image || "").trim();
  const color = tile.color || "#5e5ce6";

  if (image && isVideoAvatar(image)) {
    return <VideoAvatar uri={image} size={size} radius={r} crop={tile.crop} color={color} />;
  }

  if (image && isEmojiAvatar(image)) {
    return (
      <View style={[styles.box, { width: size, height: size, borderRadius: r, backgroundColor: color }]}>
        <Text allowFontScaling={false} style={[styles.emoji, { fontSize: Math.round(size * 0.62), lineHeight: size }]}>
          {emojiAvatarGlyph(image)}
        </Text>
      </View>
    );
  }

  if (!image) {
    return (
      <View style={[styles.box, { width: size, height: size, borderRadius: r, backgroundColor: color }]}>
        <Text allowFontScaling={false} style={withAndroidTextFace([styles.letter, typography.type.avatarInitial, { lineHeight: size }], tile.text || "?")}>{tile.text || "?"}</Text>
      </View>
    );
  }

  const g = avatarCropGeometry(size, tile.crop);
  return (
    <View style={[styles.box, { width: size, height: size, borderRadius: r, backgroundColor: color }]}>
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
  emoji: { textAlign: "center" },
  letter: { color: "#fff" },
});
