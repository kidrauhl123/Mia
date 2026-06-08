import { Image, Linking, Pressable, StyleSheet, View } from "react-native";
import { isImageAttachment, resolveAttachmentUrl } from "../logic/attachments";
import { BodyStrong, Label } from "../ui/Text";
import { color, radius, space, hairlineWidth } from "../theme";
import type { MessageAttachment } from "../api/types";

export default function AttachmentList({ attachments, apiBase, own }: { attachments?: MessageAttachment[]; apiBase: string; own?: boolean }) {
  const items = attachments || [];
  if (!items.length) return null;
  return (
    <View style={styles.wrap}>
      {items.map((item, index) => {
        const uri = resolveAttachmentUrl(item.url || item.path, apiBase);
        const image = uri && isImageAttachment(item);
        return (
          <Pressable
            key={`${item.id || item.url || item.name || "att"}:${index}`}
            style={[styles.item, own ? styles.itemOwn : styles.itemOther]}
            disabled={!uri}
            onPress={() => uri && Linking.openURL(uri).catch(() => {})}
          >
            {image ? <Image source={{ uri }} style={styles.image} resizeMode="cover" /> : null}
            <View style={styles.meta}>
              <BodyStrong numberOfLines={1} style={own ? styles.ownText : undefined}>{item.name || "附件"}</BodyStrong>
              <Label numberOfLines={1} style={own ? styles.ownSub : undefined}>{item.mimeType || item.type || "file"}</Label>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm, marginTop: space.sm },
  item: { overflow: "hidden", borderRadius: radius.md, borderWidth: hairlineWidth },
  itemOwn: { borderColor: "rgba(255,255,255,0.26)", backgroundColor: "rgba(255,255,255,0.10)" },
  itemOther: { borderColor: color.line, backgroundColor: color.surface },
  image: { width: 188, height: 124, backgroundColor: color.surfaceMuted },
  meta: { paddingHorizontal: space.sm, paddingVertical: space.sm, gap: 2 },
  ownText: { color: color.userBubbleText },
  ownSub: { color: "rgba(255,255,255,0.76)" },
});
