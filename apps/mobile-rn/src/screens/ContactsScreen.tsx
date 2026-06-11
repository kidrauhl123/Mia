import { useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  useBots,
  useCancelFriendRequest,
  useFriendRequests,
  useFriends,
  useMe,
  useRespondFriendRequest,
  useSendFriendRequest,
} from "../state/queries";
import Avatar from "../components/Avatar";
import CreateBotPanel from "../components/CreateBotPanel";
import CreateGroupPanel from "../components/CreateGroupPanel";
import type { AvatarDescriptor } from "../api/types";
import { resolveAvatar } from "../logic/conversationList";
import { friendName, friendRequestPeerName } from "../logic/friendRequests";
import Button from "../ui/Button";
import Input from "../ui/Input";
import { BodyStrong, Label, Sub, Title } from "../ui/Text";
import { color, radius, space } from "../theme";
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
  const [username, setUsername] = useState("");
  const [status, setStatus] = useState("");
  const { data: me } = useMe();
  const { data: bots = [] } = useBots();
  const { data: friends = [] } = useFriends();
  const { data: incoming = [] } = useFriendRequests("incoming");
  const { data: outgoing = [] } = useFriendRequests("outgoing");
  const sendFriendRequest = useSendFriendRequest();
  const respondFriendRequest = useRespondFriendRequest();
  const cancelFriendRequest = useCancelFriendRequest();

  async function send() {
    const toUsername = username.trim();
    if (!toUsername) {
      setStatus("请输入用户名");
      return;
    }
    setStatus("");
    try {
      await sendFriendRequest.mutateAsync({ toUsername });
      setUsername("");
      setStatus("已发送请求");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "发送失败");
    }
  }

  async function respond(requestId: string, action: "accept" | "reject") {
    setStatus("");
    try {
      await respondFriendRequest.mutateAsync({ requestId, action });
      setStatus(action === "accept" ? "已同意好友请求" : "已拒绝好友请求");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "处理失败");
    }
  }

  async function cancel(requestId: string) {
    setStatus("");
    try {
      await cancelFriendRequest.mutateAsync({ requestId });
      setStatus("已撤回请求");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "撤回失败");
    }
  }

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
      contentContainerStyle={styles.content}
      data={rows}
      keyExtractor={(r) => r.key}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.identityPanel}>
            <Label>我的用户名</Label>
            <BodyStrong selectable>{friendName(me, "未登录")}</BodyStrong>
          </View>

          <View style={styles.addPanel}>
            <View style={styles.sectionHead}>
              <Title>添加好友</Title>
              <Sub>输入对方用户名发送请求</Sub>
            </View>
            <View style={styles.addRow}>
              <Input
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="用户名"
                returnKeyType="send"
                onSubmitEditing={send}
                style={styles.addInput}
              />
              <Button label="发送" onPress={send} busy={sendFriendRequest.isPending} disabled={!username.trim()} style={styles.sendButton} />
            </View>
            {status ? <Sub style={styles.status}>{status}</Sub> : null}
          </View>

          <CreateBotPanel bots={bots} />

          <CreateGroupPanel friends={friends} bots={bots} />

          {incoming.length ? (
            <View style={styles.requestsPanel}>
              <View style={styles.sectionHead}>
                <Title>收到的请求</Title>
                <Sub>同意后会自动创建私聊</Sub>
              </View>
              {incoming.map((request) => (
                <View key={request.id} style={styles.requestRow}>
                  <View style={styles.requestText}>
                    <BodyStrong numberOfLines={1}>{friendRequestPeerName(request, "incoming")}</BodyStrong>
                    <Sub numberOfLines={1}>请求添加你为好友</Sub>
                  </View>
                  <View style={styles.requestActions}>
                    <Button
                      label="同意"
                      onPress={() => respond(request.id, "accept")}
                      busy={respondFriendRequest.isPending}
                      style={styles.smallButton}
                    />
                    <Button
                      label="拒绝"
                      variant="outline"
                      onPress={() => respond(request.id, "reject")}
                      disabled={respondFriendRequest.isPending}
                      style={styles.smallButton}
                    />
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          {outgoing.length ? (
            <View style={styles.requestsPanel}>
              <View style={styles.sectionHead}>
                <Title>已发送的请求</Title>
                <Sub>等待对方处理</Sub>
              </View>
              {outgoing.map((request) => (
                <View key={request.id} style={styles.requestRow}>
                  <View style={styles.requestText}>
                    <BodyStrong numberOfLines={1}>{friendRequestPeerName(request, "outgoing")}</BodyStrong>
                    <Sub numberOfLines={1}>待验证</Sub>
                  </View>
                  <Button
                    label="撤回"
                    variant="outline"
                    onPress={() => cancel(request.id)}
                    busy={cancelFriendRequest.isPending}
                    style={styles.smallButton}
                  />
                </View>
              ))}
            </View>
          ) : null}

          <View style={styles.sectionTitleRow}>
            <Title>联系人</Title>
            <Sub>{rows.length ? `${friends.length} 位好友 · ${bots.length} 个智能体` : "好友和智能体会显示在这里"}</Sub>
          </View>
        </View>
      }
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
  content: { paddingBottom: space.xl },
  header: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.md },
  identityPanel: {
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surfaceMuted,
    borderRadius: radius.md,
    padding: space.md,
    gap: 4,
  },
  addPanel: {
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.md,
  },
  sectionHead: { gap: 2 },
  addRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  addInput: { flex: 1, minWidth: 0 },
  sendButton: { width: 82, paddingHorizontal: 0 },
  status: { color: color.inkMuted },
  requestsPanel: {
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  requestRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: color.line,
  },
  requestText: { flex: 1, minWidth: 0, gap: 2 },
  requestActions: { flexDirection: "row", alignItems: "center", gap: space.sm },
  smallButton: { height: 36, minWidth: 64, paddingHorizontal: space.sm },
  sectionTitleRow: { marginTop: space.sm, gap: 2 },
  empty: { textAlign: "center", marginTop: 28 },
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
