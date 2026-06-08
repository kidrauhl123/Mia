import { FlatList, Pressable, StyleSheet, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useBots, useFriends } from "../state/queries";
import Avatar from "../components/Avatar";
import type { AvatarDescriptor } from "../api/types";
import { resolveAvatar } from "../logic/conversationList";
import { BodyStrong, Label } from "../ui/Text";
import { color, space } from "../theme";
import type { ContactsStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<ContactsStackParamList, "ContactsHome">;

interface Row {
  key: string;
  kind: "friend" | "bot";
  id: string;
  title: string;
  sub: string;
  avatar: AvatarDescriptor;
}

export default function ContactsScreen({ navigation }: Props) {
  const { data: bots = [] } = useBots();
  const { data: friends = [] } = useFriends();
  const rows: Row[] = [
    ...friends.map((f, i) => {
      const title = f.username || f.account || String(f.id);
      const id = String(f.id || title || i);
      return { key: `fr:${id}`, kind: "friend" as const, id, title, sub: "好友", avatar: resolveAvatar(id, title, f.avatarImage || "", f.avatarCrop || null) };
    }),
    ...bots.map((bot, i) => {
      const id = String(bot.id || bot.botId || bot.bot_id || bot.key || i);
      const title = bot.displayName || bot.display_name || bot.name || String(id);
      return { key: `bot:${id}`, kind: "bot" as const, id, title, sub: "智能体", avatar: resolveAvatar(id, title, bot.avatarImage || bot.avatar_image || "", bot.avatarCrop || bot.avatar_crop || null) };
    }),
  ];
  return (
    <FlatList
      style={styles.root}
      data={rows}
      keyExtractor={(r) => r.key}
      ListEmptyComponent={<Label style={styles.empty}>暂无联系人</Label>}
      renderItem={({ item }) => (
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          onPress={() => {
            if (item.kind === "bot") navigation.navigate("BotDetail", { botId: item.id, title: item.title });
          }}
        >
          <Avatar title={item.title} avatar={item.avatar} />
          <View style={styles.col}>
            <BodyStrong>{item.title}</BodyStrong>
            <Label style={styles.sub}>{item.sub}</Label>
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  empty: { textAlign: "center", marginTop: 48 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  pressed: { backgroundColor: color.surfaceMuted },
  col: { flex: 1, gap: 3 },
  sub: {},
});
