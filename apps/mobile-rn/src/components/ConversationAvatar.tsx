import { View, StyleSheet } from "react-native";
import type { AvatarDescriptor } from "../api/types";
import AvatarMedia from "./AvatarMedia";

// 会话头像:1 个 = 单圆;2~4 个 = 圆形容器内成员拼贴(对齐桌面 group-avatar mosaic)。
export default function ConversationAvatar({ tiles, size = 44 }: { tiles: AvatarDescriptor[]; size?: number }) {
  const list = (tiles && tiles.length ? tiles : [{ image: "", crop: null, color: "#5e5ce6", text: "?" }]).slice(0, 4);

  if (list.length === 1) {
    return <AvatarMedia tile={list[0]} size={size} />;
  }

  const half = size / 2;
  return (
    <View style={[styles.mosaic, { width: size, height: size, borderRadius: size / 2 }]}>
      {list.length === 2 ? (
        <>
          <AvatarMedia tile={list[0]} size={half} radius={0} />
          <AvatarMedia tile={list[1]} size={half} radius={0} />
        </>
      ) : list.length === 3 ? (
        <>
          <AvatarMedia tile={list[0]} size={half} radius={0} />
          <View>
            <AvatarMedia tile={list[1]} size={half} radius={0} />
            <AvatarMedia tile={list[2]} size={half} radius={0} />
          </View>
        </>
      ) : (
        <View>
          <View style={styles.gridRow}>
            <AvatarMedia tile={list[0]} size={half} radius={0} />
            <AvatarMedia tile={list[1]} size={half} radius={0} />
          </View>
          <View style={styles.gridRow}>
            <AvatarMedia tile={list[2]} size={half} radius={0} />
            <AvatarMedia tile={list[3]} size={half} radius={0} />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  mosaic: { flexDirection: "row", overflow: "hidden", backgroundColor: "#fff" },
  gridRow: { flexDirection: "row" },
});
