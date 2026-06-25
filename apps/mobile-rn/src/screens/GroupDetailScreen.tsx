import { FlatList, StyleSheet, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import Avatar from "../components/Avatar";
import { resolveAvatar } from "../logic/conversationList";
import { useConversationMembers } from "../state/queries";
import StateBlock from "../ui/StateBlock";
import { BodyStrong, Label, Sub } from "../ui/Text";
import { useTypography } from "../ui/TypographyProvider";
import { color, space, hairlineWidth } from "../theme";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "GroupDetail">;

function memberTitle(member: any): string {
  return member.identity?.displayName || member.bot_name || member.member_ref || "成员";
}

export default function GroupDetailScreen({ route }: Props) {
  const typography = useTypography();
  const members = useConversationMembers(route.params.conversationId);

  if (members.isLoading) return <StateBlock title="加载群聊…" />;
  if (members.error) return <StateBlock title="群聊加载失败" detail={String((members.error as Error).message || members.error)} />;
  if (!members.data?.length) return <StateBlock title="暂无成员" detail={route.params.title} />;

  return (
    <FlatList
      style={styles.root}
      data={members.data}
      keyExtractor={(item, index) => `${item.member_kind || "member"}:${item.member_ref || index}`}
      ListHeaderComponent={
        <View style={styles.header}>
          <BodyStrong style={typography.type.listTitle}>{route.params.title}</BodyStrong>
          <Sub style={typography.type.settingDetail}>{route.params.conversationId}</Sub>
        </View>
      }
      renderItem={({ item }) => {
        const title = memberTitle(item);
        const avatar = resolveAvatar(item.member_ref || title, title, item.identity?.avatar?.image || item.bot_avatar_image || "", item.identity?.avatar?.crop || item.bot_avatar_crop || null);
        return (
          <View style={styles.row}>
            <Avatar title={title} avatar={avatar} />
            <View style={styles.text}>
              <BodyStrong numberOfLines={1} style={typography.type.settingTitle}>{title}</BodyStrong>
              <Label style={typography.type.settingDetail}>{item.member_kind || "member"}</Label>
            </View>
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  header: { padding: space.lg, gap: 4, borderBottomWidth: hairlineWidth, borderBottomColor: color.line },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.line,
  },
  text: { flex: 1, minWidth: 0, gap: 3 },
});
